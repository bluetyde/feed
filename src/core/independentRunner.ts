// Runs the independent finite-volume solutions of a transient off the server's thread, with a deadline (plan 08, docs/independent-runs.md).
//
// The three runs the results need (same mesh and step, double mesh, half step) took 3.5 s of synchronous time in the server process at the
// largest case the validator allows (cells x steps = 3e6), more with temperature-dependent properties, and the editor's preview runs one of
// them on every edit. In the server's thread that froze status polling and cancel. Here each job gets a worker thread, a deadline after which the
// thread is terminated, a cancel, and a queue (at most `maxConcurrent` threads at once). A queued preview is superseded by a newer one.
//
// If the compiled worker file is not there (running from source without a build) the job runs in this thread and the outcome says so:
// the numbers are the same, only the deadline cannot be enforced.

import { existsSync } from "fs";
import { join } from "path";
import { Worker } from "worker_threads";
import { FvTransient } from "./transientFv";
import { hottestLoad, sliceCase } from "./axial";
import { computeIndependentStack } from "./stackTransientResults";
import { IndependentSet, computeIndependent } from "./transientResults";
import { independentSolution } from "./transientResults";
import { NormalizedCase } from "./validate";

export type IndependentWhat = "full" | "single";
export type IndependentOutcome =
  | { ok: true; what: "full"; set: IndependentSet | IndependentSet[]; mode: "worker" | "in-process"; ms: number }
  | { ok: true; what: "single"; set: { fv: FvTransient }; mode: "worker" | "in-process"; ms: number }
  | { ok: false; reason: "deadline" | "cancelled" | "superseded" | "worker-failed"; message: string; ms: number };

export interface IndependentHandle {
  done: Promise<IndependentOutcome>;
  /** Stop this job: a queued one never starts, a running one's thread is terminated. */
  cancel(): void;
}

export interface RunnerOptions {
  /** Default deadline of a job, ms. */
  deadlineMs: number;
  /** Threads at once; the rest wait their turn. */
  maxConcurrent?: number;
  /** The compiled worker; undefined looks for it beside this file and in dist/, null forces in-process. */
  workerFile?: string | null;
}

export function resolveWorkerFile(): string | null {
  for (const f of [join(__dirname, "independentWorker.js"), join(__dirname, "..", "..", "dist", "core", "independentWorker.js")]) if (existsSync(f)) return f;
  return null;
}

interface Pending {
  c: NormalizedCase;
  what: IndependentWhat;
  deadlineMs: number;
  supersede: boolean;
  resolve: (o: IndependentOutcome) => void;
  started?: number;
  worker?: Worker;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/** The case without what the worker does not need (a generated pulse's integrated curve can be large), so less is copied into the thread. */
export function forWorker(c: NormalizedCase): NormalizedCase {
  if (!c.transient?.generated) return c;
  const { generated: _g, ...transient } = c.transient;
  return { ...c, transient };
}

export class IndependentRunner {
  private queue: Pending[] = [];
  private running = new Set<Pending>();
  private workerFile: string | null;
  private maxConcurrent: number;
  private live = 0;
  private timers = 0;

  constructor(private opts: RunnerOptions) {
    this.workerFile = opts.workerFile === undefined ? resolveWorkerFile() : opts.workerFile;
    this.maxConcurrent = opts.maxConcurrent ?? 3;
  }

  /** Threads running now plus jobs waiting: zero when everything is settled. */
  activity(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.queue.length };
  }
  /** Worker threads that have started and not yet exited: zero when none is left running (a terminated thread is counted out when it has really gone). */
  liveThreads(): number {
    return this.live;
  }
  /** Deadline timers still pending: zero when every job has settled (a leftover one would hold the process open until its deadline). */
  timersPending(): number {
    return this.timers;
  }
  get mode(): "worker" | "in-process" {
    return this.workerFile ? "worker" : "in-process";
  }

  start(c: NormalizedCase, o: { what?: IndependentWhat; deadlineMs?: number; supersede?: boolean } = {}): IndependentHandle {
    let job!: Pending;
    const done = new Promise<IndependentOutcome>((resolve) => {
      job = { c, what: o.what ?? "full", deadlineMs: o.deadlineMs ?? this.opts.deadlineMs, supersede: o.supersede ?? false, resolve, settled: false };
    });
    if (job.supersede) {
      // a newer preview makes the ones still waiting pointless: the editor shows only the latest
      this.queue = this.queue.filter((q) => {
        if (!q.supersede || q.what !== job.what) return true;
        this.settle(q, { ok: false, reason: "superseded", message: "a newer request replaced this one before it started", ms: 0 });
        return false;
      });
    }
    this.queue.push(job);
    this.pump();
    return { done, cancel: () => this.cancel(job) };
  }

  private settle(j: Pending, o: IndependentOutcome) {
    if (j.settled) return;
    j.settled = true;
    if (j.timer) {
      clearTimeout(j.timer);
      j.timer = undefined;
      this.timers--;
    }
    this.running.delete(j);
    j.resolve(o);
  }

  private cancel(j: Pending) {
    if (j.settled) return;
    const ms = j.started === undefined ? 0 : Date.now() - j.started;
    this.queue = this.queue.filter((q) => q !== j);
    void j.worker?.terminate();
    this.settle(j, { ok: false, reason: "cancelled", message: "cancelled", ms });
    this.pump();
  }

  private pump() {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const j = this.queue.shift()!;
      this.running.add(j);
      j.started = Date.now();
      if (this.workerFile) this.launch(j, this.workerFile);
      else this.inProcess(j);
    }
  }

  private launch(j: Pending, file: string) {
    const fail = (reason: "worker-failed" | "deadline", message: string) => {
      void j.worker?.terminate();
      this.settle(j, { ok: false, reason, message, ms: Date.now() - j.started! });
      this.pump();
    };
    try {
      j.worker = new Worker(file, { workerData: { c: forWorker(j.c), what: j.what } });
    } catch (e) {
      return fail("worker-failed", "the worker could not be started: " + String((e as Error).message));
    }
    this.live++;
    this.timers++;
    j.worker.once("exit", () => this.live--);
    j.timer = setTimeout(() => fail("deadline", `the independent solution did not finish within ${(j.deadlineMs / 1000).toFixed(j.deadlineMs < 1000 ? 3 : 0)} s and was stopped`), j.deadlineMs);
    j.worker.once("message", (m: { ok: boolean; set?: any; message?: string; ms: number }) => {
      if (j.settled) return;
      if (m.ok) {
        this.settle(j, { ok: true, what: j.what, set: m.set, mode: "worker", ms: m.ms } as IndependentOutcome);
        this.pump();
      } else fail("worker-failed", "the independent solution failed: " + String(m.message));
    });
    j.worker.once("error", (e) => {
      if (!j.settled) fail("worker-failed", "the worker thread failed: " + String((e as Error).message));
    });
    j.worker.once("exit", (code) => {
      if (!j.settled) fail("worker-failed", `the worker thread ended (code ${code}) without an answer`);
    });
  }

  private inProcess(j: Pending) {
    setImmediate(() => {
      if (j.settled) return;
      try {
        const set = j.what === "full" ? (j.c.axial ? computeIndependentStack(j.c) : computeIndependent(j.c)) : { fv: independentSolution(j.c.axial ? sliceCase(j.c, hottestLoad(j.c)) : j.c) };
        this.settle(j, { ok: true, what: j.what, set, mode: "in-process", ms: Date.now() - j.started! } as IndependentOutcome);
      } catch (e) {
        this.settle(j, { ok: false, reason: "worker-failed", message: "the independent solution failed: " + String((e as Error).message), ms: Date.now() - j.started! });
      }
      this.pump();
    });
  }
}
