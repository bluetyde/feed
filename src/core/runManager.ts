// Run manager: one isolated directory per run, one run at a time, timeout, cancel, and classification BY OUTPUT.
// States: queued, running, completed, failed, cancelled, interrupted (docs/ARCHITECTURE.md, run flow).
// A solver that stops without a complete, finite, consistent output is `failed` with its native message kept; it is never a result.
// OFFBEAT exits 139 after a complete run (docs/spike/F0-note.md), so the exit code alone never decides success (decision 0002).

import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { writeOffbeatCase } from "./caseWriter";
import { buildResults, ResultsError, ResultsRecord } from "./resultsParser";
import { Issue, validateCase } from "./validate";

export type RunState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RunFailure {
  /** SEED error code vocabulary (schema/error-codes.json of SEED). */
  code: "E_APP_FAILED" | "E_TIMEOUT" | "E_CANCELLED" | "E_OUTPUT_INCOMPLETE" | "E_SCHEMA_INVALID";
  message: string;
  /** The solver's own words, kept untouched when there are any. */
  native?: string;
}

export interface RunRecord {
  id: string;
  caseId: string;
  /** The case's display name when the run was started. */
  caseName?: string;
  /** Headline numbers of a completed run, for lists. */
  headline?: { centreCellT: number; claddingOuterWallT: number | null };
  caseHash: string;
  state: RunState;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  solver: string;
  /** Solver process exit code, when it ran. */
  exitCode?: number | null;
  notes: string[];
  failure?: RunFailure;
}

/** What a backend leaves in `nativeDir` and reports. The backend runs the solver; it does not judge the result. */
export interface BackendOutcome {
  /** The backend was cancelled or timed out from outside. */
  cancelled: boolean;
}

export interface RunBackend {
  /** Run the case in `inputsDir`; write native output (see solver/run-feed.sh) into `nativeDir`. */
  run(args: { id: string; inputsDir: string; nativeDir: string; timeoutMs: number }): Promise<BackendOutcome>;
  /** Stop that run's own processes only. */
  cancel(id: string): Promise<void>;
}

export interface ManagerOptions {
  runsRoot: string;
  backend: RunBackend;
  timeoutMs?: number;
  now?: () => Date;
  /** Keep at most this many run directories; the oldest finished ones are deleted first. Default 100. */
  maxRuns?: number;
}

const SOLVER_TEXT = "OpenFOAM Foundation 9 + OFFBEAT 80e84450";
const SIGNALS: Record<number, string> = { 134: "SIGABRT (aborted)", 136: "SIGFPE (floating-point exception)", 137: "SIGKILL (killed)", 139: "SIGSEGV (segmentation fault)", 143: "SIGTERM (terminated)" };

const RUN_STATES: RunState[] = ["queued", "running", "completed", "failed", "cancelled", "interrupted"];
function isRunRecord(r: any): r is RunRecord {
  return !!r && typeof r === "object" && ["id", "caseId", "caseHash", "solver", "createdAt"].every((k) => typeof r[k] === "string") && RUN_STATES.includes(r.state) && Array.isArray(r.notes);
}
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A process exit status: 0 to 255, or -1 for "did not run" (written by run-feed.sh when a phase never started). */
const isStatus = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && ((v >= 0 && v <= 255) || v === -1);

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** The first FOAM FATAL block (or the first 12 lines of one) from a solver log, kept verbatim. */
export function nativeMessage(log: string): string | undefined {
  const i = log.indexOf("FOAM FATAL");
  if (i < 0) return undefined;
  return log.slice(Math.max(0, log.lastIndexOf("\n", i)), i + 900).trim().split("\n").slice(0, 14).join("\n");
}

export class RunManager {
  private records = new Map<string, RunRecord>();
  private queue: string[] = [];
  private active: string | null = null;
  private waiters = new Map<string, ((r: RunRecord) => void)[]>();
  private cancelRequested = new Set<string>();
  private timedOut = new Set<string>();
  private timeoutMs: number;
  private now: () => Date;

  constructor(private opts: ManagerOptions) {
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(opts.runsRoot, { recursive: true });
    this.recover();
    this.prune();
  }

  /** Runs left `queued` or `running` by a previous process are `interrupted`: their solver is not owned by this process. */
  private recover() {
    for (const name of readdirSync(this.opts.runsRoot)) {
      if (!/^[0-9a-f]{12}$/.test(name)) continue; // only directories named as run ids are ours
      const f = join(this.opts.runsRoot, name, "run.json");
      if (!existsSync(f)) continue;
      try {
        const r = JSON.parse(readFileSync(f, "utf8")) as RunRecord;
        if (!isRunRecord(r) || r.id !== name) continue; // a record copied from elsewhere is not registered, so prune cannot touch another directory
        if (r.state === "queued" || r.state === "running") {
          const was = r.state === "running" ? "in progress" : "waiting";
          r.state = "interrupted";
          r.endedAt = this.now().toISOString();
          r.notes.push("The app stopped while this run was " + was + ". No result was collected.");
          atomicWrite(f, JSON.stringify(r, null, 2) + "\n");
        }
        this.records.set(r.id, r);
      } catch {
        /* unreadable run.json: leave the directory alone */
      }
    }
  }

  /**
   * Delete the oldest finished runs beyond `maxRuns`. Never touches a queued or running run, and only removes directories whose
   * name is a run id (12 hex characters) directly under the runs root.
   */
  prune(): string[] {
    const max = this.opts.maxRuns ?? 100;
    const all = [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let excess = all.length - max;
    const removed: string[] = [];
    for (const r of all) {
      if (excess <= 0) break;
      if (r.state === "queued" || r.state === "running" || !/^[0-9a-f]{12}$/.test(r.id)) continue;
      rmSync(this.dir(r.id), { recursive: true, force: true });
      this.records.delete(r.id);
      removed.push(r.id);
      excess--;
    }
    return removed;
  }

  private dir(id: string) {
    return join(this.opts.runsRoot, id);
  }
  private save(r: RunRecord) {
    this.records.set(r.id, r);
    atomicWrite(join(this.dir(r.id), "run.json"), JSON.stringify(r, null, 2) + "\n");
  }
  private finish(r: RunRecord) {
    r.endedAt = this.now().toISOString();
    try {
      this.save(r);
      this.prune();
    } catch (e) {
      r.notes.push("The final record could not be written to disk: " + String((e as Error).message));
    } finally {
      for (const w of this.waiters.get(r.id) ?? []) w({ ...r });
      this.waiters.delete(r.id);
    }
  }

  /** Validate the case, snapshot it with hashes, queue the run. Invalid cases are not queued. */
  start(doc: unknown): { ok: true; id: string } | { ok: false; errors: Issue[]; message?: string } {
    const v = validateCase(doc);
    if (!v.normalized) return { ok: false, errors: v.errors };
    let written;
    try {
      written = writeOffbeatCase(v.normalized);
    } catch (e) {
      return { ok: false, errors: [], message: String((e as Error).message) };
    }
    const id = randomBytes(6).toString("hex");
    const dir = this.dir(id);
    const hashes: Record<string, string> = {};
    for (const [rel, text] of Object.entries(written.files)) {
      atomicWrite(join(dir, "inputs", rel), text);
      hashes[rel] = createHash("sha256").update(text).digest("hex");
    }
    const caseHash = createHash("sha256").update(JSON.stringify(v.normalized)).digest("hex");
    atomicWrite(join(dir, "inputs", "case.json"), JSON.stringify(doc, null, 2) + "\n");
    atomicWrite(join(dir, "feed-manifest.json"), JSON.stringify({ caseId: v.normalized.caseId, caseHash, solver: SOLVER_TEXT, mapping: written.mapping, placeholders: written.placeholders, choices: written.choices, files: hashes, warnings: v.warnings }, null, 2) + "\n");
    atomicWrite(join(dir, "normalized.json"), JSON.stringify(v.normalized) + "\n");
    const caseName = typeof (doc as any)?.name === "string" ? (doc as any).name : v.normalized.caseId;
    const rec: RunRecord = { id, caseId: v.normalized.caseId, caseName, caseHash, state: "queued", createdAt: this.now().toISOString(), solver: SOLVER_TEXT, notes: [] };
    this.save(rec);
    this.queue.push(id);
    queueMicrotask(() => void this.pump().catch(() => undefined)); // pump settles every run itself; this guards the rest
    return { ok: true, id };
  }

  get(id: string): RunRecord | undefined {
    const r = this.records.get(id);
    return r ? { ...r, notes: [...r.notes] } : undefined;
  }
  list(): RunRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => ({ ...r }));
  }
  /** The results record, present only when the run is `completed`. */
  results(id: string): ResultsRecord | undefined {
    const r = this.records.get(id);
    const f = join(this.dir(id), "results.json");
    if (!r || r.state !== "completed" || !existsSync(f)) return undefined;
    return JSON.parse(readFileSync(f, "utf8"));
  }
  /** Everything the Results and Compare views need about one run: record, case, normalized case, manifest summary, results. */
  detail(id: string) {
    const r = this.records.get(id);
    if (!r) return undefined;
    const dir = this.dir(id);
    const readJson = (f: string) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : undefined);
    const manifest = readJson("feed-manifest.json");
    return {
      record: { ...r, notes: [...r.notes] },
      case: readJson("inputs/case.json"),
      normalized: readJson("normalized.json"),
      manifest: manifest && { caseHash: manifest.caseHash, solver: manifest.solver, choices: manifest.choices, placeholders: manifest.placeholders, warnings: manifest.warnings },
      results: r.state === "completed" ? readJson("results.json") : undefined,
    };
  }
  /** Resolves when the run reaches a final state. */
  done(id: string): Promise<RunRecord> {
    const r = this.records.get(id);
    if (!r) return Promise.reject(new Error("unknown run " + id));
    if (!["queued", "running"].includes(r.state)) return Promise.resolve({ ...r });
    return new Promise((res) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), res]));
  }

  async cancel(id: string): Promise<RunRecord | undefined> {
    const r = this.records.get(id);
    if (!r) return undefined;
    if (r.state === "queued") {
      this.queue = this.queue.filter((x) => x !== id);
      r.state = "cancelled";
      r.failure = { code: "E_CANCELLED", message: "Cancelled before it started." };
      this.finish(r);
    } else if (r.state === "running") {
      this.cancelRequested.add(id);
      try {
        await this.opts.backend.cancel(id);
      } catch (e) {
        r.notes.push("Cancel could not confirm that the solver stopped: " + String((e as Error).message));
        this.save(r);
      }
    }
    return this.get(id);
  }

  private async pump() {
    if (this.active || this.queue.length === 0) return;
    const id = this.queue.shift()!;
    this.active = id;
    try {
      await this.execute(id);
    } catch (e) {
      // execute() settles its own run; reaching here means something unexpected threw, so settle it here
      const r = this.records.get(id);
      if (r && (r.state === "queued" || r.state === "running")) {
        r.state = "failed";
        r.failure = { code: "E_APP_FAILED", message: "The run could not be completed: " + String((e as Error).message) };
        this.finish(r);
      }
    } finally {
      this.active = null;
      void this.pump().catch(() => undefined);
    }
  }

  private async execute(id: string) {
    const r = this.records.get(id)!;
    r.state = "running";
    r.startedAt = this.now().toISOString();
    this.save(r);
    const dir = this.dir(id);
    const nativeDir = join(dir, "native");
    mkdirSync(nativeDir, { recursive: true });
    let outcome: BackendOutcome | undefined;
    let infra: string | undefined;
    const timer = setTimeout(() => {
      this.timedOut.add(id);
      // Promise.resolve().then(...) also catches a backend whose cancel() throws before it returns a promise
      Promise.resolve()
        .then(() => this.opts.backend.cancel(id))
        .catch((e) => {
          const rec = this.records.get(id);
          if (rec) rec.notes.push("The time-limit stop could not be confirmed: " + String((e as Error).message));
        });
    }, this.timeoutMs);
    try {
      outcome = await this.opts.backend.run({ id, inputsDir: join(dir, "inputs"), nativeDir, timeoutMs: this.timeoutMs });
    } catch (e) {
      infra = String((e as Error).message);
    } finally {
      clearTimeout(timer);
    }
    try {
      this.classify(r, dir, nativeDir, outcome, infra);
    } catch (e) {
      r.state = "failed";
      r.failure = { code: "E_APP_FAILED", message: "The run could not be classified: " + String((e as Error).message) };
    }
    this.finish(r);
  }

  private classify(r: RunRecord, dir: string, nativeDir: string, outcome: BackendOutcome | undefined, infra: string | undefined) {
    const fail = (f: RunFailure) => {
      r.state = "failed";
      r.failure = f;
    };
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);
    const log = read(join(nativeDir, "log.offbeat")) ?? "";
    const native = nativeMessage(log) ?? nativeMessage(read(join(nativeDir, "log.blockMesh")) ?? "");

    if (this.timedOut.has(r.id)) return fail({ code: "E_TIMEOUT", message: `The run exceeded its time limit of ${Math.round(this.timeoutMs / 1000)} s and was stopped.`, native });
    if (this.cancelRequested.has(r.id) || outcome?.cancelled) {
      r.state = "cancelled";
      r.failure = { code: "E_CANCELLED", message: "Cancelled by the user. No result was collected." };
      return;
    }
    if (infra) return fail({ code: "E_APP_FAILED", message: "The solver environment could not run the case: " + infra });

    let exit: { blockMeshExit: number; offbeatExit: number; finalTime: number } | undefined;
    const rawExit = read(join(nativeDir, "exit.json"));
    if (rawExit === undefined) return fail({ code: "E_APP_FAILED", message: "The solver run left no exit record (exit.json).", native });
    try {
      exit = JSON.parse(rawExit);
    } catch {
      exit = undefined;
    }
    if (!exit || !isStatus(exit.blockMeshExit) || !isStatus(exit.offbeatExit) || !isNum(exit.finalTime)) return fail({ code: "E_APP_FAILED", message: "The solver run left an invalid exit record (exit.json): the exit statuses must be whole numbers from 0 to 255 (or -1 for a phase that did not run) and the final time a number.", native });
    r.exitCode = exit.offbeatExit;
    if (exit.blockMeshExit !== 0) return fail({ code: "E_APP_FAILED", message: `The mesh could not be built (blockMesh exit ${exit.blockMeshExit}).`, native });
    if (exit.offbeatExit === -1) return fail({ code: "E_APP_FAILED", message: "The solver never ran: the exit record says OFFBEAT did not start although the mesh was built.", native });

    const expectedEnd = JSON.parse(readFileSync(join(dir, "feed-manifest.json"), "utf8")).choices?.endTime;
    if (!isNum(expectedEnd) || !(expectedEnd > 0)) return fail({ code: "E_APP_FAILED", message: "The run manifest has no valid intended end time, so the run cannot be judged complete.", native });
    const T = read(join(nativeDir, "final", "T"));
    const C = read(join(nativeDir, "final", "C"));
    // Exit codes that mean the run did not finish on its own terms, whatever was left on disk.
    if (exit.offbeatExit === 124) return fail({ code: "E_TIMEOUT", message: `The solver hit its time limit (exit 124, the shell timeout). Output written before that is not accepted as a result.`, native });
    if (exit.offbeatExit === 137 || exit.offbeatExit === 143) return fail({ code: "E_APP_FAILED", message: `The solver was killed from outside (exit ${exit.offbeatExit}, ${SIGNALS[exit.offbeatExit]}). Output written before that is not accepted as a result.`, native });
    if (!(exit.finalTime > 0) || T === undefined || C === undefined) {
      const sig = SIGNALS[exit.offbeatExit];
      return fail({ code: "E_APP_FAILED", message: `The solver stopped before writing any result (exit ${exit.offbeatExit}${sig ? ", " + sig : ""}).`, native });
    }
    if (exit.finalTime < expectedEnd) return fail({ code: "E_OUTPUT_INCOMPLETE", message: `The solver stopped at ${exit.finalTime} s, before the intended ${expectedEnd} s (exit ${exit.offbeatExit}). The partial output is not a result.`, native });

    try {
      const normalized = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
      const results = buildResults(normalized, { T, C, time: exit.finalTime });
      atomicWrite(join(dir, "results.json"), JSON.stringify(results, null, 2) + "\n");
      r.headline = { centreCellT: results.summary.centreCellT, claddingOuterWallT: results.summary.claddingOuterWallT };
    } catch (e) {
      if (e instanceof ResultsError) return fail({ code: "E_OUTPUT_INCOMPLETE", message: "The solver output is not a complete result: " + e.message, native });
      return fail({ code: "E_APP_FAILED", message: "Reading the solver output failed: " + String((e as Error).message) });
    }
    r.state = "completed";
    if (exit.offbeatExit !== 0) r.notes.push(`The solver exited with code ${exit.offbeatExit}${SIGNALS[exit.offbeatExit] ? " (" + SIGNALS[exit.offbeatExit] + ")" : ""} after writing a complete output. This is a known OFFBEAT shutdown crash; the result was accepted because the output is complete and finite.`);
  }
}
