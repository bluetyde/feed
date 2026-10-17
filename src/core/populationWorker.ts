// The worker thread's entry (src/core/populationRunner.ts starts it): draws the population of coated particles and runs the closed form of each, off the server's thread. The
// numerics are in trisoPopulation.ts. A RangeError (a population whose draws mostly fail) is a refusal of the case, not a failure of the worker.

import { parentPort, workerData } from "worker_threads";
import type { NormalizedTriso } from "./triso";
import { runPopulation } from "./trisoPopulation";

const t0 = Date.now();
try {
  const result = runPopulation((workerData as { n: NormalizedTriso }).n);
  parentPort!.postMessage({ ok: true, result, ms: Date.now() - t0 });
} catch (e) {
  parentPort!.postMessage({ ok: false, refused: e instanceof RangeError, message: String((e as Error).message), ms: Date.now() - t0 });
}
