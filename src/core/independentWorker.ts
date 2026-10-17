// The worker thread's entry (src/core/independentRunner.ts starts it). It runs the independent finite-volume solution of one transient case
// off the server's thread and posts the answer once. Nothing else lives here: the numerics are in transientResults.ts and transientFv.ts.

import { parentPort, workerData } from "worker_threads";
import { hottestLoad, sliceCase } from "./axial";
import { solveStackTransientReference } from "./stackReference";
import { computeIndependentStack } from "./stackTransientResults";
import { computeIndependent, independentSolution } from "./transientResults";
import { NormalizedCase } from "./validate";

interface Job {
  c: NormalizedCase;
  /** "full": the three runs the results need. "single": the one run the editor's preview needs. "stackReference": the two-dimensional reference of a transient stack (plan 15, B4); the runner's timer is its deadline, so the solver has none of its own here. */
  what: "full" | "single" | "stackReference";
  deadlineMs?: number;
}

const job = workerData as Job;
const t0 = Date.now();
try {
  const set = job.what === "stackReference" ? solveStackTransientReference(job.c, { deadlineMs: Infinity }) : job.what === "full" ? (job.c.axial ? computeIndependentStack(job.c) : computeIndependent(job.c)) : { fv: independentSolution(job.c.axial ? sliceCase(job.c, hottestLoad(job.c)) : job.c) };
  parentPort!.postMessage({ ok: true, set, ms: Date.now() - t0 });
} catch (e) {
  parentPort!.postMessage({ ok: false, message: String((e as Error).message), ms: Date.now() - t0 });
}
