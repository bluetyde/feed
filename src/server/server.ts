// Local server for the editor: static page plus a JSON check endpoint over the case core.
// Binds to 127.0.0.1 only. POST bodies must be application/json (blocks cross-site form posts) and are size-limited.
// No solver yet: /api/check returns the validation and the closed-form quick look only.

import { effectiveMechanics } from "../core/mechanicalEval";
import { MECHANICS_TEXT } from "../core/mechanicsResults";
import { penaltyAdvice } from "../core/penaltyAdvice";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { axialProfiles, axialSummary, hottestLoad, sliceCase, sliceLoads } from "../core/axial";
import { STACK_TEXT } from "../core/stackResults";
import { quickLook, radialProfile } from "../core/quickLook";
import { trisoDerived, trisoQuickLook } from "../core/trisoSolve";
import { trisoProfile } from "../core/trisoProfile";
import { projectRoot, unrunnableErrors, validateCase } from "../core/validate";
import { RunManager } from "../core/runManager";
import { compareResults, diffCases, profileDifference } from "../core/compare";
import { pebbleResultsToCsv, resultsToCsv, transientResultsToCsv, trisoResultsToCsv, trisoTransientResultsToCsv } from "../core/exportResults";
import { pebbleClosedForm } from "../core/pebble";
import { twoScaleParticle } from "../core/compact";
import { burnupSweep } from "../core/burnupSweep";
import { burnupText } from "../core/resultsParser";
import { applyDesign, designOf } from "../core/design";
import { IndependentRunner } from "../core/independentRunner";
import { previewTooBig, transientPreview } from "../core/transientPreview";
import { FvTransient } from "../core/transientFv";
import { latestEntries, readUserEntries, saveUserMaterial } from "../core/userLibrary";
import { importMaterial, listMaterials, readProjectAsync } from "../core/projectImport";
import { NormalizedCase } from "../core/validate";
import { refinementStudy, studyCases } from "../core/refinement";
import { solverAvailable, WslBackend } from "../core/wslBackend";

const PORT = Number(process.env.FEED_PORT ?? 8771);
const MAX_BODY = 1_000_000;

/**
 * The server can start processes and serve case data, so it only answers requests that came from its own page:
 * - Host must be 127.0.0.1, localhost or [::1] at the port this server listens on (stops DNS rebinding, where a hostile site's
 *   name resolves to 127.0.0.1 and the browser sends that name as Host);
 * - any request that changes state (not GET/HEAD) must carry the custom header x-feed-client: 1, which a cross-site page cannot
 *   add without a CORS preflight this server never grants, and an Origin, if present, must be this server's own origin.
 */
export const CLIENT_HEADER = "x-feed-client";
function allowedRequest(req: IncomingMessage): string | null {
  const port = (server.address() as AddressInfo | null)?.port ?? PORT;
  const host = String(req.headers.host ?? "").toLowerCase();
  if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return "Host not allowed: this server answers only on 127.0.0.1, localhost and [::1] at its own port.";
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers[CLIENT_HEADER] !== "1") return "Missing " + CLIENT_HEADER + " header: state-changing requests must come from this server's own page.";
    const origin = req.headers.origin;
    if (origin !== undefined && String(origin).toLowerCase() !== `http://${host}`) return "Origin not allowed: " + String(origin);
  }
  return null;
}
const root = projectRoot();

/**
 * The independent finite-volume runs of a transient (the results' cross-check and time-step error, the editor's preview) are done in worker threads with
 * deadlines, so a big case cannot freeze the server (docs/independent-runs.md). A run whose checks cannot finish in RUN_DEADLINE_MS fails; a preview that
 * cannot finish in PREVIEW_DEADLINE_MS is skipped with the reason.
 */
export const RUN_DEADLINE_MS = 120_000;
export const PREVIEW_DEADLINE_MS = 20_000;
export const independent = new IndependentRunner({ deadlineMs: RUN_DEADLINE_MS });

/** The run manager exists only when the feed-solver distro does; runs live under runs/ (git-ignored). */
let manager: RunManager | null = null;
let solverUp = false;
/** Tests inject a manager with a scripted backend. */
export function useManager(m: RunManager | null) {
  manager = m;
  solverUp = m !== null;
}
export async function initSolver(): Promise<boolean> {
  solverUp = await solverAvailable();
  manager = solverUp ? new RunManager({ runsRoot: join(root, "runs"), backend: new WslBackend(), timeoutMs: 300_000, independent }) : null;
  return solverUp;
}

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}
const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, "application/json", JSON.stringify(value));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sourcedLimits(): any[] {
  return JSON.parse(readFileSync(join(root, "library", "limits.json"), "utf8"));
}

export function sourcedStrengths(): any[] {
  return JSON.parse(readFileSync(join(root, "library", "strengths.json"), "utf8"));
}

export function sourcedExpansion(): any[] {
  return JSON.parse(readFileSync(join(root, "library", "expansion.json"), "utf8"));
}

function sourcedMaterials(): any[] {
  return JSON.parse(readFileSync(join(root, "library", "materials.json"), "utf8"));
}

/** Pin presets are the example cases; materials come from library/materials.json (sourced, committed) and the user's own saved materials (library/custom, kept apart). Ids are file base names, never paths. */
export function library() {
  const dir = join(root, "examples");
  const pins = readdirSync(dir).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return { id: f.slice(0, -5), name: c.name, label: c.label, description: c.description ?? "", citation: c.citation ?? "" };
  });
  const sourced = sourcedMaterials();
  const user = readUserEntries();
  const custom = latestEntries(user.entries).map((e) => ({ region: e.region, name: e.name, label: e.label, description: e.description, citation: e.citation, savedAt: e.savedAt, revisions: user.entries.filter((x) => x.material.materialId === e.material.materialId).length, material: e.material }));
  return { pins, materials: [...sourced, ...custom], limits: sourcedLimits(), expansion: sourcedExpansion(), strengths: sourcedStrengths(), userLibrary: user.problem ? { problem: user.problem } : { entries: user.entries.length } };
}

/** Largest finest-level cell counts a study may request (the finest level is 4x the case's mesh). */
export const STUDY_MAX_FUEL_CELLS = 4000;
export const STUDY_MAX_CLADDING_CELLS = 2000;

/** Start the three runs of a refinement study. The case must be valid and its finest mesh within the cap. */
export function startStudy(doc: any) {
  if (!manager) return { status: 503, body: { error: "No solver is installed (the feed-solver distro was not found)." } };
  const v = validateCase(doc);
  if (!v.normalized) return { status: 400, body: { errors: v.errors } };
  if (v.normalized.transient) return { status: 400, body: { error: "A mesh refinement study is for steady cases. A transient reports its time-step and cross-check errors in its own checks." } };
  if (v.normalized.mesh.fuelCells * 4 > STUDY_MAX_FUEL_CELLS) return { status: 400, body: { error: `The finest mesh would have ${v.normalized.mesh.fuelCells * 4} fuel cells; a study is limited to ${STUDY_MAX_FUEL_CELLS}. Reduce the case's mesh first.` } };
  if (v.normalized.mesh.claddingCells * 4 > STUDY_MAX_CLADDING_CELLS) return { status: 400, body: { error: `The finest mesh would have ${v.normalized.mesh.claddingCells * 4} cladding cells; a study is limited to ${STUDY_MAX_CLADDING_CELLS}. Reduce the case's mesh first.` } };
  const ids: string[] = [];
  for (const d of studyCases(doc)) {
    const s = manager.start(d);
    if (!s.ok) return { status: 400, body: { errors: s.errors, message: s.message } };
    ids.push(s.id);
  }
  return { status: 202, body: { ids } };
}

/** Progress and, when all runs are completed, the study. */
export function studyStatus(ids: string[]) {
  const details = ids.map((id) => manager?.detail(id));
  if (details.some((d) => !d)) return { status: "error", error: "unknown run" };
  const states = details.map((d) => d!.record.state);
  if (states.some((s) => s === "queued" || s === "running")) return { status: "running", states };
  if (states.some((s) => s !== "completed")) return { status: "failed", states, failures: details.map((d) => d!.record.failure?.message ?? null) };
  const study = refinementStudy(details.map((d) => ({ id: d!.record.id, normalized: d!.normalized, results: d!.results! })));
  return "error" in study ? { status: "error", states, error: study.error } : { status: "done", states, study };
}

/** Compare two completed runs. A run that is not completed cannot be compared. */
export function compareRuns(ida: string, idb: string) {
  const a = manager?.detail(ida);
  const b = manager?.detail(idb);
  if (!a || !b) return { error: "unknown run" };
  if (!a.results || !b.results || !a.normalized || !b.normalized) return { error: "both runs must be completed to be compared (A is " + a.record.state + ", B is " + b.record.state + ")" };
  if (a.normalized.kind === "triso" || b.normalized.kind === "triso" || a.normalized.kind === "pebble" || b.normalized.kind === "pebble") return { error: "Compare supports pins and plates; a coated particle's or a pebble's result is read on the Results tab." };
  if (a.normalized.transient || b.normalized.transient) return { error: "Compare supports steady runs only; a transient run has a time series, not one profile. Use the Results tab." };
  const inputDiff = diffCases(a.case, b.case);
  return {
    a: { id: ida, caseName: a.record.caseName, caseHash: a.record.caseHash },
    b: { id: idb, caseName: b.record.caseName, caseHash: b.record.caseHash },
    identicalInputs: a.record.caseHash === b.record.caseHash,
    inputDiff,
    ...compareResults(a.results, b.results),
    profile: profileDifference(a.normalized, b.normalized, a.results, b.results),
    // each run's own statement: a burnup run adds the frozen-burnup sentence, and a comparison of a burnt pin with a fresh one must carry it
    thermalOnly: a.results.thermalOnly === b.results.thermalOnly ? a.results.thermalOnly : "Run A: " + a.results.thermalOnly + " Run B: " + b.results.thermalOnly,
  };
}

/** The normalized case for the editor: without the integrated curve of a generated pulse (thousands of numbers; the preview carries a downsampled one). */
function slim(n: NormalizedCase): NormalizedCase {
  if (!n.transient?.generated) return n;
  const { trace: _t, ...generated } = n.transient.generated;
  return { ...n, transient: { ...n.transient, generated: { ...generated, trace: { time: [], power: [], reactivity: [], fuelTemperature: [], energy: [] } } } };
}

/** The quick look, with a transient's preview run in this thread. The server's handler uses checkAsync, which runs it in a worker with a deadline. */
export function check(doc: unknown) {
  return checkWith(validateCase(doc));
}

/** The quick look with the transient's independent preview run in a worker thread, with a deadline; a newer request replaces one still waiting. */
export async function checkAsync(doc: unknown, previewDeadlineMs = PREVIEW_DEADLINE_MS) {
  const v = validateCase(doc);
  let external: { fv: FvTransient | null; skipped?: string } | undefined;
  if (v.normalized?.transient && !previewTooBig(v.normalized)) {
    // a stack's preview is the hottest slice's
    const o = await independent.start(v.normalized.axial ? sliceCase(v.normalized, hottestLoad(v.normalized)) : v.normalized, { what: "single", deadlineMs: previewDeadlineMs, supersede: true }).done;
    external = o.ok ? { fv: (o.set as { fv: FvTransient }).fv } : { fv: null, skipped: o.reason === "superseded" ? "a newer edit replaced this preview before it started" : "the preview was skipped: " + o.message };
  }
  return checkWith(v, external);
}

/** What the editor shows beside the case: the volumetric power, the gap, the heat flux at the outer surface and the pin's design numbers. A plate has the slab's (per unit height and width; the pin's design view does not apply). */
function derivedOf(n: NormalizedCase, q: number) {
  if (n.plate) return { volumetricPower: q / n.fuelRadius, gapThickness: n.claddingInnerRadius - n.fuelRadius, outerSurfaceHeatFlux: q, design: null };
  return { volumetricPower: q / (Math.PI * (n.fuelRadius ** 2 - n.fuelInnerRadius ** 2)), gapThickness: n.claddingInnerRadius - n.fuelRadius, outerSurfaceHeatFlux: q / (2 * Math.PI * n.claddingOuterRadius), design: designOf(n) };
}

function checkWith(v: ReturnType<typeof validateCase>, external?: { fv: FvTransient | null; skipped?: string }) {
  if (!v.normalized) {
    // a coated particle (plan 13) is valid and runs; the editor (T5) draws its closed-form profile (`profile`: every region over its own radii) and shows the derived numbers
    if (v.triso) return { ok: true, errors: v.errors, warnings: v.warnings, triso: { normalized: v.triso, quick: trisoQuickLook(v.triso), derived: trisoDerived(v.triso), profile: trisoProfile(v.triso) } };
    // a pebble (plan 13, T4): valid and runs; the editor has no panel for it yet (docs/compact-pebble.md), so the response carries its closed form and the hottest particle for a person or a script
    if (v.pebble) {
      const cf = pebbleClosedForm(v.pebble);
      return { ok: true, errors: v.errors, warnings: v.warnings, pebble: { normalized: v.pebble, closed: { centreT: cf.centreT, interfaceT: cf.interfaceT, wallT: cf.wallT, filmDeltaT: cf.filmDeltaT }, hottestParticle: twoScaleParticle(v.pebble.compact, cf.centreT), note: "closed-form pebble and the hottest particle (two-scale): see docs/compact-pebble.md" } };
    }
    return { ok: false, errors: unrunnableErrors(v), warnings: v.warnings };
  }
  const n = v.normalized;
  if (n.transient) {
    // A transient has no closed-form profile: the quick look is the independent finite-volume preview (not the solver).
    return {
      ok: true,
      errors: v.errors,
      warnings: v.warnings,
      normalized: slim(n),
      transient: transientPreview(n.axial ? sliceCase(n, hottestLoad(n)) : n, external),
      ...(n.axial ? { axial: axialSummary(n), axialNote: STACK_TEXT } : {}),
      derived: derivedOf(n, n.qPrime),
    };
  }
  const stack = axialSummary(n);
  // a stack: the quick look and the profile are those of the hottest slice (one-dimensional closed form, no axial conduction); the per-slice table is in `axial`
  const hot = stack ? sliceCase(n, sliceLoads(n)[stack.hottest]!) : n;
  const look = quickLook(hot);
  const eff = effectiveMechanics(n);
  return {
    ok: true,
    errors: v.errors,
    warnings: v.warnings,
    normalized: n,
    // the contact penalty factor that suits the stiffness ratio of this case (M3's sweep), and the gas pressure the case works out, for the Mechanics panel
    ...(n.mechanics ? { mechanicsNote: MECHANICS_TEXT } : {}),
    ...(eff ? { mechanicsAdvice: { penalty: penaltyAdvice(eff.fuel.E, eff.cladding.E), internalPressure: eff.internalPressure, internalPressureNote: eff.internalPressureNote ?? null } } : {}),
    // what a burnup result is and is not, for the banner while the case is edited (the same words as in every result)
    ...(n.burnup ? { burnupNote: burnupText(n.burnup.value) } : {}),
    quick: look,
    ...(n.compact ? { compact: { spec: n.compact, hottestParticle: twoScaleParticle(n.compact, look.temperatures.centreT) } } : {}),
    profile: radialProfile(hot, look),
    ...(stack ? { axial: stack, axialNote: STACK_TEXT, axialProfiles: axialProfiles(n) } : {}),
    derived: derivedOf(n, hot.qPrime),
  };
}

export const server = createServer(async (req, res) => {
  try {
    const refusal = allowedRequest(req);
    if (refusal) return json(res, 403, { error: refusal });
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && url === "/") {
      // the editor may not be framed by another page (a framed editor would carry its own authorised requests: Codex review 2026-10-11)
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" });
      return void res.end(readFileSync(join(root, "src", "web", "index.html"), "utf8"));
    }
    if (req.method === "GET" && url === "/api/ping") return json(res, 200, { ok: true, app: "fuel-performance-studio", solver: solverUp ? "OpenFOAM Foundation 9 + OFFBEAT (feed-solver)" : null });
    if (req.method === "GET" && url === "/api/library") return json(res, 200, library());
    if (req.method === "POST" && url === "/api/design") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send application/json" });
      let input: any;
      try {
        input = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "body is not valid JSON" });
      }
      const r = applyDesign(input?.geometry, { field: input?.field, value: input?.value });
      return json(res, r.ok ? 200 : 400, r);
    }
    if (req.method === "POST" && (url === "/api/import/project" || url === "/api/import/material")) {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send application/json" });
      let input: any;
      try {
        input = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "body is not valid JSON" });
      }
      const project = await readProjectAsync(input?.path);
      if (!project.ok) return json(res, 400, { ok: false, errors: project.errors });
      if (url === "/api/import/project") return json(res, 200, { ok: true, projectId: project.manifest.projectId, name: project.manifest.name ?? "", file: project.file, materials: listMaterials(project.manifest) });
      const r = importMaterial(project.manifest, { id: input?.id, region: input?.region, revision: input?.revision });
      return json(res, r.ok ? 200 : 400, r);
    }
    if (req.method === "POST" && url === "/api/library/material") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send application/json" });
      let input: any;
      try {
        input = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "body is not valid JSON" });
      }
      const r = saveUserMaterial(input ?? {}, new Set(sourcedMaterials().map((m) => m.material.materialId)));
      return r.ok ? json(res, r.status === "saved" ? 201 : 200, { ok: true, status: r.status, entry: r.entry }) : json(res, r.status, { ok: false, errors: r.errors });
    }
    if (req.method === "GET" && url.startsWith("/api/pin/")) {
      const id = decodeURIComponent(url.slice(9));
      if (!library().pins.some((p) => p.id === id)) return json(res, 404, { error: "no such pin" });
      return send(res, 200, "application/json", readFileSync(join(root, "examples", id + ".json"), "utf8"));
    }
    if (req.method === "GET" && url === "/api/example") return send(res, 200, "application/json", readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
    const runMatch = /^\/api\/run\/([0-9a-f]{12})(\/results|\/cancel|\/detail|\/results\.csv)?$/.exec(url);
    if (req.method === "GET" && url === "/api/compare" && manager) {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const ida = q.get("a") ?? "";
      const idb = q.get("b") ?? "";
      if (!/^[0-9a-f]{12}$/.test(ida) || !/^[0-9a-f]{12}$/.test(idb)) return json(res, 400, { error: "give run ids as ?a=<id>&b=<id>" });
      return json(res, 200, compareRuns(ida, idb));
    }
    if (req.method === "POST" && url === "/api/run") {
      if (!manager) return json(res, 503, { error: "No solver is installed (the feed-solver distro was not found). Use the quick look." });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send application/json" });
      let doc: unknown;
      try {
        doc = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "body is not valid JSON" });
      }
      const started = manager.start(doc);
      return started.ok ? json(res, 202, { id: started.id }) : json(res, 400, { errors: started.errors, message: started.message });
    }
    if (runMatch && manager) {
      const id = runMatch[1]!;
      const rec = manager.get(id);
      if (!rec) return json(res, 404, { error: "no such run" });
      if (req.method === "GET" && !runMatch[2]) return json(res, 200, rec);
      if (req.method === "GET" && runMatch[2] === "/results") {
        const r = manager.results(id);
        return r ? json(res, 200, r) : json(res, 404, { error: "no result for this run (state: " + rec.state + ")" });
      }
      if (req.method === "GET" && runMatch[2] === "/detail") return json(res, 200, manager.detail(id));
      if (req.method === "GET" && runMatch[2] === "/results.csv") {
        const d = manager.detail(id);
        if (!d?.results) return json(res, 404, { error: "no result for this run (state: " + rec.state + ")" });
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${rec.caseId}-${id}.csv"`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        const meta = { runId: id, caseName: rec.caseName ?? rec.caseId, solver: rec.solver, caseHash: rec.caseHash };
        if ("kind" in d.results && d.results.kind === "triso") return void res.end(trisoResultsToCsv(d.results, meta));
        if ("kind" in d.results && d.results.kind === "pebble") return void res.end(pebbleResultsToCsv(d.results, meta));
        if ("kind" in d.results && d.results.kind === "triso-transient") return void res.end(trisoTransientResultsToCsv(d.results, meta));
        return void res.end("kind" in d.results && d.results.kind === "transient" ? transientResultsToCsv(d.results, meta) : resultsToCsv(d.results as Parameters<typeof resultsToCsv>[0], meta));
      }
      if (req.method === "POST" && runMatch[2] === "/cancel") return json(res, 200, await manager.cancel(id));
    }
    if (url === "/api/study" && manager) {
      if (req.method === "POST") {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send application/json" });
        let doc: unknown;
        try {
          doc = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: "body is not valid JSON" });
        }
        const r = startStudy(doc);
        return json(res, r.status, r.body);
      }
      if (req.method === "GET") {
        const ids = (new URL(req.url ?? "/", "http://x").searchParams.get("ids") ?? "").split(",");
        if (ids.length < 3 || ids.length > 6 || ids.some((i) => !/^[0-9a-f]{12}$/.test(i))) return json(res, 400, { error: "give 3 to 6 run ids as ?ids=a,b,c" });
        return json(res, 200, studyStatus(ids));
      }
    }
    if (req.method === "GET" && url === "/api/runs") return json(res, 200, manager ? manager.list() : []);
    if (req.method === "POST" && url === "/api/check") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send application/json" });
      let doc: unknown;
      try {
        doc = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "body is not valid JSON" });
      }
      return json(res, 200, await checkAsync(doc));
    }
    if (req.method === "POST" && url === "/api/burnup-sweep") {
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send application/json" });
      let doc: unknown;
      try {
        doc = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "body is not valid JSON" });
      }
      const r = burnupSweep(doc);
      return json(res, r.ok ? 200 : 400, r.ok ? r.sweep : { error: r.reason });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: String((e as Error).message) });
  }
});

if (require.main === module) {
  void initSolver().then((up) => {
    server.listen(PORT, "127.0.0.1", () => console.log("Fuel Performance Studio on http://127.0.0.1:" + PORT + "/  (Ctrl+C to stop). Solver: " + (up ? "feed-solver found" : "not found, quick look only")));
  });
}
