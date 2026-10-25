// The quasi-static assumption of a transient mechanics run (plan 17 D2).
//
// The mechanics is elastic and static: the inertia of the solids is not modelled. That holds while the load changes slowly against the time a stress wave needs to cross the fuel.
// The check is a warning with the numbers, not a refusal (the owner's decision D2): the time a wave needs to cross the fuel radius, and the shortest time in which the power
// history changes by a factor of two. FEED's cases carry no density, so the transit time uses a stated upper bound of the density of any fuel (a slow wave: the warning errs
// toward being given), and the lowest modulus the fuel's law states.

import type { Elasticity } from "./validate";

/**
 * A density no fuel of the library exceeds, kg/m3 (UO2 at its theoretical density is 10 960). It is a bound for a warning, not a property of any material: a wave in a lighter
 * fuel is faster, so the transit time here is the longest one possible and the warning is given early. For the TRIGA fuel the read densities are 5940 to 6000 kg/m3 and
 * the steel's 8000 (docs/spike/transient-mechanics-data.md).
 */
export const WAVE_DENSITY_BOUND = 11000;
/** The load must change in no less than this many transit times of the fuel radius for the static solution to stand (plan 17 D2). */
export const QUASI_STATIC_TRANSITS = 100;
/** Segments of the power history below this fraction of the peak are not a "change by a factor of two" of anything the pin feels (the rise from zero at the start of a history). */
const NEGLIGIBLE_POWER = 1e-3;

/** The lowest Young's modulus a law states (Pa): the constant, or the smaller end of the stated range of a linear law. */
export function lowestModulus(e: Elasticity): number {
  if (e.kind === "constant") return e.E;
  return Math.min(e.a + e.b * e.range[0], e.a + e.b * e.range[1]);
}

/** The time (s) a plane elastic wave needs to cross a radius (m): radius / sqrt(E / rho). */
export function waveTransitTime(radius: number, youngModulus: number, density: number = WAVE_DENSITY_BOUND): number {
  return radius / Math.sqrt(youngModulus / density);
}

/**
 * The shortest time (s) in which a piecewise linear power history changes by a factor of two, with the segment where it happens: min(q1, q2) (t2 - t1) / |q2 - q1| on every
 * segment (the time to change by its own value at that segment's rate). Segments whose smaller value is below a thousandth of the peak are skipped. Undefined for a constant history.
 */
export function fastestDoubling(times: number[], power: number[]): { time: number; at: number } | undefined {
  const peak = Math.max(...power);
  let best: { time: number; at: number } | undefined;
  for (let i = 1; i < times.length; i++) {
    const lo = Math.min(power[i - 1]!, power[i]!);
    const dq = Math.abs(power[i]! - power[i - 1]!);
    if (!(dq > 0) || !(lo > NEGLIGIBLE_POWER * peak)) continue;
    const t = (lo * (times[i]! - times[i - 1]!)) / dq;
    if (best === undefined || t < best.time) best = { time: t, at: times[i - 1]! };
  }
  return best;
}
