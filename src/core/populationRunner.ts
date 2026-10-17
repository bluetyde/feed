// Runs a population of coated particles (plan 13, T6, trisoPopulation.ts) off the server's thread, with a deadline: the same arrangement as the independent runs of a transient
// (independentRunner.ts, docs/independent-runs.md). One worker thread per job; after the deadline the thread is terminated and the job fails with the reason; a cancel stops it.
// If the compiled worker file is not there (running from source without a build) the job runs in this thread and the outcome says so: the numbers are the same, only the deadline
// cannot be enforced.

import { existsSync } from "fs";
import { join } from "path";
import { Worker } from "worker_threads";
import type { NormalizedTriso } from "./triso";
import { PopulationResult, runPopulation } from "./trisoPopulation";

export type PopulationOutcome =
  | { ok: true; result: PopulationResult; mode: "worker" | "in-process"; ms: number }
  | { ok: false; reason: "deadline" | "cancelled" | "worker-failed" | "refused"; message: string; ms: number };

export interface PopulationHandle {
  done: Promise<PopulationOutcome>;
  cancel(): void;
}

/** A population of 100000 particles takes about 5 s; this leaves room for a slow machine. */
export const POPULATION_DEADLINE_MS = 60_000;

export function resolvePopulationWorker(): string | null {
  for (const f of [join(__dirname, "populationWorker.js"), join(__dirname, "..", "..", "dist", "core", "populationWorker.js")]) if (existsSync(f)) return f;
  return null;
}

export interface PopulationRunOptions {
  deadlineMs?: number;
  /** The compiled worker; undefined looks for it beside this file and in dist/, null forces in-process. */
  workerFile?: string | null;
}

export function startPopulation(n: NormalizedTriso, o: PopulationRunOptions = {}): PopulationHandle {
  const deadlineMs = o.deadlineMs ?? POPULATION_DEADLINE_MS;
  const file = o.workerFile === undefined ? resolvePopulationWorker() : o.workerFile;
  const started = Date.now();
  let settled = false;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: (out: PopulationOutcome) => void;
  const done = new Promise<PopulationOutcome>((resolve) => {
    finish = (out) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      void worker?.terminate();
      resolve(out);
    };
  });
  const fail = (reason: "deadline" | "cancelled" | "worker-failed" | "refused", message: string) => finish({ ok: false, reason, message, ms: Date.now() - started });
  if (file) {
    try {
      worker = new Worker(file, { workerData: { n } });
    } catch (e) {
      fail("worker-failed", "the worker could not be started: " + String((e as Error).message));
      return { done, cancel: () => {} };
    }
    timer = setTimeout(() => fail("deadline", `the population did not finish within ${(deadlineMs / 1000).toFixed(deadlineMs < 1000 ? 3 : 0)} s and was stopped`), deadlineMs);
    worker.once("message", (m: { ok: boolean; result?: PopulationResult; message?: string; refused?: boolean; ms: number }) => {
      if (m.ok) finish({ ok: true, result: m.result!, mode: "worker", ms: m.ms });
      else fail(m.refused ? "refused" : "worker-failed", String(m.message));
    });
    worker.once("error", (e) => fail("worker-failed", "the worker thread failed: " + String((e as Error).message)));
    worker.once("exit", (code) => fail("worker-failed", `the worker thread ended (code ${code}) without an answer`));
  } else {
    setImmediate(() => {
      if (settled) return;
      try {
        finish({ ok: true, result: runPopulation(n), mode: "in-process", ms: Date.now() - started });
      } catch (e) {
        fail(e instanceof RangeError ? "refused" : "worker-failed", String((e as Error).message));
      }
    });
  }
  return { done, cancel: () => fail("cancelled", "cancelled") };
}
