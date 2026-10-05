// Local server for the editor: static page plus a JSON check endpoint over the case core.
// Binds to 127.0.0.1 only. POST bodies must be application/json (blocks cross-site form posts) and are size-limited.
// No solver yet: /api/check returns the validation and the closed-form quick look only.

import { createServer, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { quickLook, radialProfile } from "../core/quickLook";
import { projectRoot, validateCase } from "../core/validate";
import { RunManager } from "../core/runManager";
import { compareResults, diffCases, profileDifference } from "../core/compare";
import { resultsToCsv } from "../core/exportResults";
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
  manager = solverUp ? new RunManager({ runsRoot: join(root, "runs"), backend: new WslBackend(), timeoutMs: 300_000 }) : null;
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

/** Pin presets are the example cases; materials come from library/materials.json. Ids are file base names, never paths. */
export function library() {
  const dir = join(root, "examples");
  const pins = readdirSync(dir).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
    return { id: f.slice(0, -5), name: c.name, label: c.label, description: c.description ?? "", citation: c.citation ?? "" };
  });
  const materials = JSON.parse(readFileSync(join(root, "library", "materials.json"), "utf8"));
  return { pins, materials };
}

/** Largest finest-level cell counts a study may request (the finest level is 4x the case's mesh). */
export const STUDY_MAX_FUEL_CELLS = 4000;
export const STUDY_MAX_CLADDING_CELLS = 2000;

/** Start the three runs of a refinement study. The case must be valid and its finest mesh within the cap. */
export function startStudy(doc: any) {
  if (!manager) return { status: 503, body: { error: "No solver is installed (the feed-solver distro was not found)." } };
  const v = validateCase(doc);
  if (!v.normalized) return { status: 400, body: { errors: v.errors } };
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
  const inputDiff = diffCases(a.case, b.case);
  return {
    a: { id: ida, caseName: a.record.caseName, caseHash: a.record.caseHash },
    b: { id: idb, caseName: b.record.caseName, caseHash: b.record.caseHash },
    identicalInputs: a.record.caseHash === b.record.caseHash,
    inputDiff,
    ...compareResults(a.results, b.results),
    profile: profileDifference(a.normalized, b.normalized, a.results, b.results),
    thermalOnly: a.results.thermalOnly,
  };
}

export function check(doc: unknown) {
  const v = validateCase(doc);
  if (!v.normalized) return { ok: false, errors: v.errors, warnings: v.warnings };
  const n = v.normalized;
  const look = quickLook(n);
  return {
    ok: true,
    errors: v.errors,
    warnings: v.warnings,
    normalized: n,
    quick: look,
    profile: radialProfile(n, look),
    derived: {
      volumetricPower: n.qPrime / (Math.PI * n.fuelRadius ** 2),
      gapThickness: n.claddingInnerRadius - n.fuelRadius,
      outerSurfaceHeatFlux: n.qPrime / (2 * Math.PI * n.claddingOuterRadius),
    },
  };
}

export const server = createServer(async (req, res) => {
  try {
    const refusal = allowedRequest(req);
    if (refusal) return json(res, 403, { error: refusal });
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && url === "/") return send(res, 200, "text/html; charset=utf-8", readFileSync(join(root, "src", "web", "index.html"), "utf8"));
    if (req.method === "GET" && url === "/api/ping") return json(res, 200, { ok: true, app: "fuel-performance-studio", solver: solverUp ? "OpenFOAM Foundation 9 + OFFBEAT (feed-solver)" : null });
    if (req.method === "GET" && url === "/api/library") return json(res, 200, library());
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
        return void res.end(resultsToCsv(d.results, { runId: id, caseName: rec.caseName ?? rec.caseId, solver: rec.solver, caseHash: rec.caseHash }));
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
      return json(res, 200, check(doc));
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
