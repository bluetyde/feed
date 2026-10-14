// The coolant side of a transient as a function of time (plan 11): linear between the points of `transient.boundaryHistory`, the last value held beyond its last point (the writer
// appends exactly that flat point for OFFBEAT, whose table aborts at its last time). Used by the independent solution, the checks and the writer, so they read one definition.
import type { BoundaryHistory } from "./validate";

export type BoundaryValue = { kind: "convective"; bulkTemperature: number; heatTransferCoefficient: number } | { kind: "surface-temperature"; surfaceTemperature: number };

/** The linear interpolation of a table at t; the first value before the first point and the last value after the last. */
function lerp(times: number[], values: number[], t: number): number {
  if (t <= times[0]!) return values[0]!;
  const n = times.length;
  if (t >= times[n - 1]!) return values[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return values[lo]! + ((values[hi]! - values[lo]!) * (t - times[lo]!)) / (times[hi]! - times[lo]!);
}

export function boundaryAtTime(h: BoundaryHistory, t: number): BoundaryValue {
  return h.kind === "convective"
    ? { kind: "convective", bulkTemperature: lerp(h.times, h.bulkTemperature, t), heatTransferCoefficient: lerp(h.times, h.heatTransferCoefficient, t) }
    : { kind: "surface-temperature", surfaceTemperature: lerp(h.times, h.surfaceTemperature, t) };
}

/** The table as written for OFFBEAT: the points, and one flat point beyond the end time when the last point is not strictly after it (OFFBEAT aborts on a time equal to its last point). */
export function tableForSolver(h: BoundaryHistory, endTime: number, timeStep: number): { times: number[]; columns: number[][] } {
  const times = h.times.slice();
  const columns = (h.kind === "convective" ? [h.heatTransferCoefficient, h.bulkTemperature] : [h.surfaceTemperature]).map((c) => c.slice());
  if (!(times[times.length - 1]! > endTime * (1 + 1e-9))) {
    times.push(Number((Math.max(endTime, times[times.length - 1]!) + timeStep).toPrecision(12)));
    for (const c of columns) c.push(c[c.length - 1]!);
  }
  return { times, columns };
}
