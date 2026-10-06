// The worker thread's entry (src/core/independentRunner.ts starts it). It runs the independent finite-volume solution of one transient case
// off the server's thread and posts the answer once. Nothing else lives here: the numerics are in transientResults.ts and transientFv.ts.

import { parentPort, workerData } from "worker_threads";
import { computeIndependent, independentSolution } from "./transientResults";
import { NormalizedCase } from "./validate";

interface Job {
  c: NormalizedCase;
  /** "full": the three runs the results need. "single": the one run the editor's preview needs. */
  what: "full" | "single";
}

const job = workerData as Job;
const t0 = Date.now();
try {
  const set = job.what === "full" ? computeIndependent(job.c) : { fv: independentSolution(job.c) };
  parentPort!.postMessage({ ok: true, set, ms: Date.now() - t0 });
} catch (e) {
  parentPort!.postMessage({ ok: false, message: String((e as Error).message), ms: Date.now() - t0 });
}
