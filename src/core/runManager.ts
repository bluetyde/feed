// Run manager: one isolated directory per run, one run at a time, timeout, cancel, and classification BY OUTPUT.
// States: queued, running, completed, failed, cancelled, interrupted (docs/ARCHITECTURE.md, run flow).
// A solver that stops without a complete, finite, consistent output is `failed` with its native message kept; it is never a result.
// OFFBEAT exits 139 after a complete run (docs/spike/F0-note.md), so the exit code alone never decides success (decision 0002).

import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { writeOffbeatCase } from "./caseWriter";
import { buildTrisoResults, TrisoResultsRecord } from "./trisoResults";
import { buildTrisoMechanicsResults, TrisoMechanicsResultsRecord } from "./trisoMechanicsResults";
import { buildTrisoTransientResults, computeTrisoIndependent, TrisoTransientResultsRecord } from "./trisoTransientResults";
import { writeTrisoParticleCase } from "./trisoMechanicsWriter";
import { buildPebbleResults, PebbleResultsRecord } from "./pebbleResults";
import { writePebbleCase } from "./pebbleWriter";
import { judgeConvergence, judgeMechanicsConvergence, readCriterion, readMechanicsCriterion } from "./convergence";
import { lastRelativeRate } from "./steadyState";
import { buildResults, ResultsError, ResultsRecord } from "./resultsParser";
import { buildStackResults } from "./stackResults";
import { buildStackTransientResults } from "./stackTransientResults";
import { IndependentHandle, IndependentRunner } from "./independentRunner";
import { IndependentSet, buildTransientResults, TransientResultsRecord } from "./transientResults";
import { Issue, unrunnableErrors, validateCase } from "./validate";

export type RunState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RunFailure {
  /** SEED error code vocabulary (schema/error-codes.json of SEED). */
  code: "E_APP_FAILED" | "E_TIMEOUT" | "E_CANCELLED" | "E_OUTPUT_INCOMPLETE" | "E_NOT_CONVERGED" | "E_VERIFY_INCOMPLETE" | "E_SCHEMA_INVALID";
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
  /** Steady: the centre cell and the outer wall. Transient (transient: true): the hottest cell over the whole run and the final outer wall. */
  headline?: { centreCellT: number; claddingOuterWallT: number | null; transient?: true };
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
  /** Where a transient's independent finite-volume runs are done (in a worker thread, with a deadline). Default: a runner with `independentDeadlineMs`. */
  independent?: IndependentRunner;
  /** Deadline of those runs, ms. Default 120000. A run whose independent checks cannot finish in it fails (E_VERIFY_INCOMPLETE): without them the result is not verified. */
  independentDeadlineMs?: number;
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
  private independent: IndependentRunner;
  /** The independent-run job of a run that is being verified (after its solver has finished); cancel stops it. */
  private postJobs = new Map<string, IndependentHandle>();
  private timedOut = new Set<string>();
  private timeoutMs: number;
  private now: () => Date;

  constructor(private opts: ManagerOptions) {
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.independent = opts.independent ?? new IndependentRunner({ deadlineMs: opts.independentDeadlineMs ?? 120_000 });
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
    if (!v.normalized && !v.triso && !v.pebble) return { ok: false, errors: unrunnableErrors(v) };
    // a coated particle (plan 13) has its own normalised form; it is saved with kind "triso" so that the run is read back as one. A pebble (T4) likewise with kind "pebble".
    const normalized: any = v.normalized ?? (v.triso ? { kind: "triso", ...v.triso } : { kind: "pebble", ...v.pebble });
    let written;
    try {
      written = v.normalized ? writeOffbeatCase(v.normalized) : v.triso ? writeTrisoParticleCase(v.triso) : writePebbleCase(v.pebble!);
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
    const caseHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    atomicWrite(join(dir, "inputs", "case.json"), JSON.stringify(doc, null, 2) + "\n");
    atomicWrite(join(dir, "feed-manifest.json"), JSON.stringify({ caseId: normalized.caseId, caseHash, solver: SOLVER_TEXT, mapping: written.mapping, placeholders: written.placeholders, choices: written.choices, files: hashes, warnings: v.warnings }, null, 2) + "\n");
    atomicWrite(join(dir, "normalized.json"), JSON.stringify(normalized) + "\n");
    const caseName = typeof (doc as any)?.name === "string" ? (doc as any).name : normalized.caseId;
    const rec: RunRecord = { id, caseId: normalized.caseId, caseName, caseHash, state: "queued", createdAt: this.now().toISOString(), solver: SOLVER_TEXT, notes: [] };
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
  results(id: string): ResultsRecord | TransientResultsRecord | TrisoResultsRecord | TrisoTransientResultsRecord | TrisoMechanicsResultsRecord | PebbleResultsRecord | undefined {
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
      this.postJobs.get(id)?.cancel();
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
      await this.classify(r, dir, nativeDir, outcome, infra);
    } catch (e) {
      r.state = "failed";
      r.failure = { code: "E_APP_FAILED", message: "The run could not be classified: " + String((e as Error).message) };
    }
    this.finish(r);
  }

  private async classify(r: RunRecord, dir: string, nativeDir: string, outcome: BackendOutcome | undefined, infra: string | undefined) {
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
    // a transient's last write time is the sum of many steps, so it can sit a few ulps below the intended end (1e-9 relative)
    const normalizedHead = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
    const isTransient = !!normalizedHead.transient;
    const hasMechanics = !!normalizedHead.mechanics;
    if (exit.finalTime < (isTransient ? expectedEnd * (1 - 1e-9) : expectedEnd)) return fail({ code: "E_OUTPUT_INCOMPLETE", message: `The solver stopped at ${exit.finalTime} s, before the intended ${expectedEnd} s (exit ${exit.offbeatExit}). The partial output is not a result.`, native });

    // Only exit 0 and the demonstrated shutdown crash (139, SIGSEGV after the last write; docs/spike/F0-note.md) are accepted. Any
    // other nonzero exit after a complete write is a different failure, and a FOAM FATAL in the log is a failure whatever the code.
    if (exit.offbeatExit !== 0 && exit.offbeatExit !== 139) {
      const sig = SIGNALS[exit.offbeatExit];
      return fail({ code: "E_APP_FAILED", message: `The solver exited with code ${exit.offbeatExit}${sig ? " (" + sig + ")" : ""} after writing output. Only exit 0 and the known shutdown crash (139, SIGSEGV after the last write) are accepted; this output is not a result.`, native });
    }
    if (log.includes("FOAM FATAL")) return fail({ code: "E_APP_FAILED", message: `The solver log contains a FOAM FATAL error (exit ${exit.offbeatExit}), so the output is not accepted as a result.`, native });

    // Convergence. OFFBEAT ends a time step at maxOuterIter without converging and accepts it silently (same output, same exit code),
    // so the log is the only evidence: the last outer iteration of the final step (steady), of every step (transient), must meet
    // OFFBEAT's own thermal criterion with the tolerances this run was given (src/core/convergence.ts).
    const fvSolution = read(join(dir, "inputs", "system", "fvSolution"));
    // a particle's mechanics run is given the temperatures (thermalSolver constant): there is no thermal solve to judge, only the displacement's
    const temperaturesGiven = normalizedHead.kind === "triso" && hasMechanics;
    const criterion = fvSolution === undefined ? ({ ok: false, message: "the run's system/fvSolution is missing" } as const) : readCriterion(fvSolution);
    if (!criterion.ok) return fail({ code: "E_OUTPUT_INCOMPLETE", message: "Convergence cannot be judged: " + criterion.message + ". The run is not accepted as a result.", native });
    const convergence = temperaturesGiven ? ({ ok: true, stepsChecked: 0, iterationsInLastStep: 0 } as const) : judgeConvergence(log, criterion.criterion, isTransient ? "every-step" : "final-step", exit.finalTime);
    if (!convergence.ok) {
      const evidence = log.split(/\r?\n/).filter((l) => /^(Time = |OuterIteration|relResidualT|absErrT)|Solving for T/.test(l)).slice(-16).join("\n");
      return fail({ code: convergence.code, message: convergence.message, native: evidence || native });
    }

    // A mechanics run must also have converged in its displacement (the same silent acceptance at maxOuterIter), by OFFBEAT's own displacement criterion.
    if (hasMechanics) {
      const mc = readMechanicsCriterion(fvSolution!);
      if (!mc.ok) return fail({ code: "E_OUTPUT_INCOMPLETE", message: "Convergence of the displacement cannot be judged: " + mc.message + ". The run is not accepted as a result.", native });
      const mv = judgeMechanicsConvergence(log, mc.criterion, exit.finalTime);
      if (!mv.ok) {
        const evidence = log.split(/\r?\n/).filter((l) => /^(Time = |OuterIteration|relResidualD|absErrD)|Solving for D/.test(l)).slice(-16).join("\n");
        return fail({ code: mv.code, message: mv.message, native: evidence || native });
      }
    }

    try {
      const normalized = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
      if (normalized.kind === "triso" && normalized.transient) {
        // a coated particle's transient: every write time after 0 from native/times/<time>/T, the cells put into their regions by the cell zones. The independent finite-volume runs
        // (the cross-check and the time-step error) are cheap for a particle and the validator bounds their work (cells x steps), so they are done here, not in a worker.
        const cellZones = read(join(nativeDir, "final", "cellZones"));
        if (cellZones === undefined) return fail({ code: "E_OUTPUT_INCOMPLETE", message: "The solver output is not a complete result: the mesh's cell zones (constant/polyMesh/cellZones) were not collected, so the cells cannot be put into the kernel and the layers.", native });
        const tdir = join(nativeDir, "times");
        const names = existsSync(tdir) ? readdirSync(tdir).filter((d) => /^[0-9.eE+-]+$/.test(d) && Number.isFinite(Number(d))).sort((a, b) => Number(a) - Number(b)) : [];
        const fields = names.map((d) => ({ time: Number(d), T: read(join(tdir, d, "T")) ?? "" }));
        const t0 = Date.now();
        const ind = computeTrisoIndependent(normalized);
        r.notes.push(`The independent finite-volume runs took ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
        const tr = buildTrisoTransientResults(normalized, { C, cellZones, fields }, ind);
        atomicWrite(join(dir, "results.json"), JSON.stringify(tr, null, 2) + "\n");
        r.headline = { centreCellT: tr.summary.maxT, claddingOuterWallT: tr.series.wallT[tr.series.wallT.length - 1]!, transient: true };
        r.state = "completed";
        if (exit.offbeatExit !== 0) r.notes.push(`The solver exited with code ${exit.offbeatExit}${SIGNALS[exit.offbeatExit] ? " (" + SIGNALS[exit.offbeatExit] + ")" : ""} after writing a complete output. This is a known OFFBEAT shutdown crash; the result was accepted because the output is complete and finite.`);
        return;
      }
      if (normalized.transient) {
        // every write time after 0, in time order, from native/times/<time>/T
        const tdir = join(nativeDir, "times");
        const names = existsSync(tdir) ? readdirSync(tdir).filter((d) => /^[0-9.eE+-]+$/.test(d) && Number.isFinite(Number(d))).sort((a, b) => Number(a) - Number(b)) : [];
        const fields = names.map((d) => ({ time: Number(d), T: read(join(tdir, d, "T")) ?? "" }));
        // The independent finite-volume runs (the cross-check and the time-step error) are done in a worker thread with a deadline, so the server stays
        // responsive, and a cancel reaches them. Without them the result is not verified, so a run whose checks cannot be completed is not a result.
        const job = this.independent.start(normalized, { what: "full" });
        this.postJobs.set(r.id, job);
        const ind = await job.done.finally(() => this.postJobs.delete(r.id));
        if (this.cancelRequested.has(r.id) || (!ind.ok && ind.reason === "cancelled")) {
          r.state = "cancelled";
          r.failure = { code: "E_CANCELLED", message: "Cancelled by the user while the result was being checked. No result was collected." };
          return;
        }
        if (!ind.ok) return fail({ code: "E_VERIFY_INCOMPLETE", message: "The solver finished, but its result could not be verified: " + ind.message + ". Without the independent cross-check and time-step error the result is not accepted. Use a coarser mesh or a longer time step, or raise the deadline; the solver's own output is in the run folder.", native });
        r.notes.push(`The independent finite-volume runs took ${(ind.ms / 1000).toFixed(1)} s in ${ind.mode === "worker" ? "a worker thread" : "the server's own thread (no compiled worker was found, so no deadline applied)"}.`);
        const tr = normalized.axial ? buildStackTransientResults(normalized, { C, fields }, ind.set as IndependentSet[]) : buildTransientResults(normalized, { C, fields }, ind.set as IndependentSet);
        atomicWrite(join(dir, "results.json"), JSON.stringify(tr, null, 2) + "\n");
        r.headline = { centreCellT: tr.summary.maxT, claddingOuterWallT: tr.series.claddingOuterWallT[tr.series.claddingOuterWallT.length - 1]!, transient: true };
        r.state = "completed";
        if (exit.offbeatExit !== 0) r.notes.push(`The solver exited with code ${exit.offbeatExit}${SIGNALS[exit.offbeatExit] ? " (" + SIGNALS[exit.offbeatExit] + ")" : ""} after writing a complete output. This is a known OFFBEAT shutdown crash; the result was accepted because the output is complete and finite.`);
        return;
      }
      if (normalized.kind === "pebble") {
        // a pebble: the cells, the cell zones (which cell is in the fuelled zone or the shell) and the outside's patch value of the final T
        const cellZones = read(join(nativeDir, "final", "cellZones"));
        if (cellZones === undefined) return fail({ code: "E_OUTPUT_INCOMPLETE", message: "The solver output is not a complete result: the mesh's cell zones (constant/polyMesh/cellZones) were not collected, so the cells cannot be put into the fuelled zone and the shell.", native });
        const pr = buildPebbleResults(normalized, { T, C, cellZones, time: exit.finalTime, drift: { relativeRate: lastRelativeRate(log) } });
        atomicWrite(join(dir, "results.json"), JSON.stringify(pr, null, 2) + "\n");
        r.headline = { centreCellT: pr.summary.centreCellT, claddingOuterWallT: pr.summary.wallT };
        r.state = "completed";
        if (exit.offbeatExit !== 0) r.notes.push(`The solver exited with code ${exit.offbeatExit}${SIGNALS[exit.offbeatExit] ? " (" + SIGNALS[exit.offbeatExit] + ")" : ""} after writing a complete output. This is a known OFFBEAT shutdown crash; the result was accepted because the output is complete and finite.`);
        return;
      }
      if (normalized.kind === "triso" && normalized.mechanics) {
        // a coated particle's mechanics: the temperatures, the cell centres and zones, the displacement, the stress and the swelling strain OFFBEAT applied
        const cellZones = read(join(nativeDir, "final", "cellZones"));
        if (cellZones === undefined) return fail({ code: "E_OUTPUT_INCOMPLETE", message: "The solver output is not a complete result: the mesh's cell zones (constant/polyMesh/cellZones) were not collected, so the cells cannot be put into the layers.", native });
        const Dtext = read(join(nativeDir, "final", "D"));
        const sigma = read(join(nativeDir, "final", "sigma"));
        if (Dtext === undefined || sigma === undefined) return fail({ code: "E_OUTPUT_INCOMPLETE", message: "The solver output is not a complete result: the displacement (D) or the stress (sigma) was not collected.", native });
        const tm = buildTrisoMechanicsResults(normalized, { T, C, D: Dtext, sigma, ...(read(join(nativeDir, "final", "epsilonSwelling")) !== undefined ? { epsilonSwelling: read(join(nativeDir, "final", "epsilonSwelling"))! } : {}), cellZones, time: exit.finalTime });
        atomicWrite(join(dir, "results.json"), JSON.stringify(tm, null, 2) + "\n");
        r.headline = { centreCellT: tm.cells[0]!.T, claddingOuterWallT: tm.cells[tm.cells.length - 1]!.T };
        r.state = "completed";
        if (exit.offbeatExit !== 0) r.notes.push(`The solver exited with code ${exit.offbeatExit}${SIGNALS[exit.offbeatExit] ? " (" + SIGNALS[exit.offbeatExit] + ")" : ""} after writing a complete output. This is a known OFFBEAT shutdown crash; the result was accepted because the output is complete and finite.`);
        return;
      }
      if (normalized.kind === "triso") {
        // a coated particle: the cells, the cell zones (which cell is in which region) and the patch values of the final T
        const cellZones = read(join(nativeDir, "final", "cellZones"));
        if (cellZones === undefined) return fail({ code: "E_OUTPUT_INCOMPLETE", message: "The solver output is not a complete result: the mesh's cell zones (constant/polyMesh/cellZones) were not collected, so the cells cannot be put into the kernel and the layers.", native });
        const tr = buildTrisoResults(normalized, { T, C, cellZones, time: exit.finalTime, drift: { relativeRate: lastRelativeRate(log) } });
        atomicWrite(join(dir, "results.json"), JSON.stringify(tr, null, 2) + "\n");
        r.headline = { centreCellT: tr.summary.kernelCentreCellT, claddingOuterWallT: tr.summary.wallT };
        r.state = "completed";
        if (exit.offbeatExit !== 0) r.notes.push(`The solver exited with code ${exit.offbeatExit}${SIGNALS[exit.offbeatExit] ? " (" + SIGNALS[exit.offbeatExit] + ")" : ""} after writing a complete output. This is a known OFFBEAT shutdown crash; the result was accepted because the output is complete and finite.`);
        return;
      }
      // a burnup case is checked against OFFBEAT's own conductivity and burnup fields, which the run script copies out beside T and C
      const extra = normalized.burnup ? { k: read(join(nativeDir, "final", "k")), Bu: read(join(nativeDir, "final", "Bu")) } : {};
      // a mechanics case is read back from OFFBEAT's displacement and stress fields, which the run script copies out beside T and C
      const mechanics = normalized.mechanics
        ? { mechanics: { D: read(join(nativeDir, "final", "D")), sigma: read(join(nativeDir, "final", "sigma")), sigmaCyl: read(join(nativeDir, "final", "sigmaCyl")), gapWidth: read(join(nativeDir, "final", "gapWidth")), interfaceP: read(join(nativeDir, "final", "interfaceP")) } }
        : {};
      const results = (normalized.axial ? buildStackResults : buildResults)(normalized, { T, C, ...extra, ...mechanics, time: exit.finalTime, drift: { relativeRate: lastRelativeRate(log) } });
      const unread = results.checks.find((c) => c.id === "mechanicsFields" && c.verdict !== "pass");
      if (unread) return fail({ code: "E_OUTPUT_INCOMPLETE", message: "The solver output is not a complete result: " + unread.note, native });
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
