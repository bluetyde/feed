// FEED headless runner: the entry point other programs (the SEED adapter) use. One JSON object on stdout, nothing else.
//
//   node dist/cli/headless.js describe
//   node dist/cli/headless.js validate <case.json>
//   node dist/cli/headless.js run <case.json> --out <absDir> [--run-id feed] [--timeout-seconds 300]
//   node dist/cli/headless.js cancel --out <absDir>
//
// Exit codes: 0 a reply was produced (a run that ended failed is exit 0 with status "failed" and a reason), 2 the case was
// refused (ok:false with typed errors), 1 the runner itself failed (ok:false). `run` writes <out>/<run-id>/ with
// case.json, results.json, derived.json, run.json, feed-manifest.json and manifest.json (sha256 of each), and keeps the
// solver's own run folder under <out>/work/. Thermal-only: nothing here says anything about stress, failure or integrity.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { isAbsolute, join } from "path";
import { RunManager } from "../core/runManager";
import { Issue, validateCase } from "../core/validate";
import { solverAvailable, WslBackend } from "../core/wslBackend";

export const HEADLESS_VERSION = "0.1.0";
const SOLVER = "OpenFOAM Foundation 9 + OFFBEAT 80e84450 (WSL distro feed-solver)";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** Thrown by out() so that nothing after a reply runs; main() turns it into the exit code once stdout is flushed. */
class Reply extends Error {
  constructor(public code: number) {
    super("reply written");
  }
}
const out = (obj: unknown, code: number): never => {
  process.stdout.write(JSON.stringify(obj) + "\n");
  throw new Reply(code);
};
const typed = (i: Issue) => ({ code: i.code, field: i.field, message: i.message, ...(i.unit ? { unit: i.unit } : {}), ...(i.range ? { range: i.range } : {}) });
const fail = (code: string, message: string, field = "", exit = 1) => out({ ok: false, errors: [{ code, field, message }] }, exit);

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readCase(path: string | undefined): { doc: unknown; bytes: Buffer } {
  if (!path) return fail("E_SCHEMA_INVALID", "give the case file path", "", 2);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return fail("E_NOT_FOUND", "the case file cannot be read", "", 2);
  }
  try {
    return { doc: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    return fail("E_SCHEMA_INVALID", "the case file is not valid JSON", "", 2);
  }
}

async function describe() {
  out(
    {
      ok: true,
      engine: { name: "feed-headless", version: HEADLESS_VERSION, capability: "steady-thermal-1d-radial-pin" },
      caseFormat: { format: "feed.case", version: "0.1" },
      solver: { text: SOLVER, available: await solverAvailable() },
      thermalOnly: "Thermal calculation only. Not a stress, failure or integrity assessment.",
    },
    0,
  );
}

function validate(args: string[]) {
  const { doc } = readCase(args[0]);
  const v = validateCase(doc);
  if (!v.ok) return out({ ok: false, errors: v.errors.map(typed), warnings: v.warnings.map(typed) }, 2);
  out({ ok: true, warnings: v.warnings.map(typed) }, 0);
}

async function run(args: string[]) {
  const { doc, bytes } = readCase(args[0]);
  const outDir = option(args, "--out");
  if (!outDir || !isAbsolute(outDir)) return fail("E_PATH_INVALID", "--out must be an absolute folder");
  const runId = option(args, "--run-id") ?? "feed";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) return fail("E_PATH_INVALID", "--run-id is not a plain id");
  const timeoutSeconds = Number(option(args, "--timeout-seconds") ?? "300");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 86400) return fail("E_BOUNDS_EXCEEDED", "--timeout-seconds must be 10 to 86400");
  const v = validateCase(doc);
  if (!v.ok) return out({ ok: false, errors: v.errors.map(typed), warnings: v.warnings.map(typed) }, 2);
  if (!(await solverAvailable())) return fail("E_SETUP_REQUIRED", "the FEED solver (WSL distro feed-solver) was not found; see solver/PINS.md");

  const finalDir = join(outDir, runId);
  if (existsSync(finalDir)) return fail("E_EXISTS", "the output folder already exists");
  mkdirSync(outDir, { recursive: true });
  const mgr = new RunManager({ runsRoot: join(outDir, "work"), backend: new WslBackend(), timeoutMs: timeoutSeconds * 1000, maxRuns: 1000 });
  const started = mgr.start(doc);
  if (!started.ok) return out({ ok: false, errors: started.errors.map(typed).concat(started.message ? [{ code: "E_UNSUPPORTED", field: "", message: started.message }] : []) }, 2);
  // a separate process (cancel) finds the solver run through this file
  writeFileSync(join(outDir, "active-run.json"), JSON.stringify({ feedRunId: started.id, nativeDir: join(outDir, "work", started.id, "native") }, null, 2) + "\n");
  const rec = await mgr.done(started.id);
  if (rec.state !== "completed") {
    return out({ ok: true, status: rec.state, reason: rec.failure ? `${rec.failure.code}: ${rec.failure.message}` : `the run ended ${rec.state}`, ...(rec.failure?.native ? { native: rec.failure.native.slice(0, 1500) } : {}) }, 0);
  }
  const detail = mgr.detail(started.id)!;
  const res = detail.results!;
  const n = detail.normalized!;
  mkdirSync(finalDir, { recursive: true });
  const files: Record<string, string | Buffer> = {
    "case.json": bytes,
    "results.json": JSON.stringify(res, null, 2) + "\n",
    "derived.json": JSON.stringify({ linearHeatRate: n.qPrime, heatFluxOuter: n.qPrime / (2 * Math.PI * n.claddingOuterRadius), fuelRadius: n.fuelRadius, claddingInnerRadius: n.claddingInnerRadius, claddingOuterRadius: n.claddingOuterRadius, fuelCells: n.mesh.fuelCells, claddingCells: n.mesh.claddingCells, warnings: detail.manifest?.warnings ?? [] }, null, 2) + "\n",
    "run.json": JSON.stringify(detail.record, null, 2) + "\n",
    "feed-manifest.json": readFileSync(join(outDir, "work", started.id, "feed-manifest.json")),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(finalDir, name), content);
  const manifest = {
    format: "feed-headless-run",
    version: 1,
    status: "completed",
    feedRunId: started.id,
    solver: detail.record.solver,
    caseSha256: sha256(bytes),
    files: Object.keys(files).map((p) => ({ path: p, sha256: sha256(readFileSync(join(finalDir, p))) })),
  };
  writeFileSync(join(finalDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  out({ ok: true, status: "completed", runId, feedRunId: started.id, solverExit: detail.record.exitCode ?? null }, 0);
}

async function cancel(args: string[]) {
  const outDir = option(args, "--out");
  if (!outDir || !isAbsolute(outDir)) return fail("E_PATH_INVALID", "--out must be an absolute folder");
  let active: { feedRunId?: string; nativeDir?: string };
  try {
    active = JSON.parse(readFileSync(join(outDir, "active-run.json"), "utf8"));
  } catch {
    return out({ ok: true, cancelled: false, detail: "no active solver run is recorded in this folder" }, 0);
  }
  if (typeof active.feedRunId !== "string" || !/^[0-9a-f]{12}$/.test(active.feedRunId) || typeof active.nativeDir !== "string" || active.nativeDir !== join(outDir, "work", active.feedRunId, "native")) {
    return fail("E_NOT_OWNED", "active-run.json does not describe a run of this folder");
  }
  try {
    await new WslBackend().cancelAt(active.feedRunId, active.nativeDir);
  } catch (e) {
    return out({ ok: false, errors: [{ code: "E_APP_FAILED", field: "", message: "the solver stop could not be confirmed: " + String((e as Error).message).slice(0, 300) }] }, 1);
  }
  out({ ok: true, cancelled: true }, 0);
}

async function main() {
  const [verb, ...args] = process.argv.slice(2);
  let code = 0;
  try {
    if (verb === "describe") await describe();
    else if (verb === "validate") validate(args);
    else if (verb === "run") await run(args);
    else if (verb === "cancel") await cancel(args);
    else fail("E_VERB_UNKNOWN", "usage: describe | validate <case.json> | run <case.json> --out <dir> | cancel --out <dir>");
  } catch (e) {
    if (e instanceof Reply) code = e.code;
    else {
      code = 1;
      process.stdout.write(JSON.stringify({ ok: false, errors: [{ code: "E_INTERNAL", field: "", message: "headless runner failure: " + String((e as Error).message).slice(0, 300) }] }) + "\n");
    }
  }
  // exactly one JSON object has been written; exit once it is flushed
  process.stdout.write("", () => process.exit(code));
}

void main();
