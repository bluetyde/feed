// Hot dimensions: the radii of a steady case at operating temperature, from free linear thermal expansion (docs/hot-dimensions.md).
// A case states cold radii; with a hotDimensions section the temperature solution is computed on the radii each solid has at its own mean temperature.
// The radii are not known before the temperatures and the temperatures depend on the radii, so the two are iterated from the cold radii. No stress,
// no contact and no constraint is modelled: a solid that would touch its neighbour is refused, because that needs the mechanics of docs/plans/09-mechanics.md.
import { quickLook, radialProfile } from "./quickLook";
import type { NormalizedCase } from "./validate";

export const MAX_EXPANSION_COEFFICIENT = 1e-3; // 1/K; real solids are about 1e-5
export const MAX_REFERENCE_TEMPERATURE = 10000; // K
/** The relative change of every radius below which the iteration has converged. */
export const HOT_TOLERANCE = 1e-13;
export const HOT_MAX_ITERATIONS = 100;
/** Intervals of the radial profile averaged over each solid (even, for Simpson's rule). */
const MEAN_POINTS = 200;

export interface HotSolid {
  /** Linear expansion coefficient, 1/K, constant. */
  alpha: number;
  /** Where the coefficient comes from (required: FEED has no expansion data of its own). */
  source: string;
}

export interface HotSpec {
  /** The temperature at which the case's radii are stated (the cold radii), K. */
  referenceTemperature: number;
  fuel: HotSolid;
  cladding: HotSolid;
}

export interface Radii {
  fuelRadius: number;
  fuelInnerRadius: number;
  claddingInnerRadius: number;
  claddingOuterRadius: number;
}

/** What the normalized case keeps about the correction: enough to show the cold and hot dimensions and to repeat the calculation. */
export interface HotRecord {
  referenceTemperature: number;
  fuel: HotSolid & { meanTemperature: number; factor: number };
  cladding: HotSolid & { meanTemperature: number; factor: number };
  cold: Radii;
  iterations: number;
  /** The hot gap (claddingInnerRadius - fuelRadius), m, and the cold one. */
  hotGap: number;
  coldGap: number;
}

export type HotResult = { ok: true; radii: Radii; record: HotRecord } | { ok: false; reason: string };

/** The area-weighted mean temperature of each solid on the closed-form profile of the case as it stands. */
export function meanTemperatures(c: NormalizedCase): { fuel: number; cladding: number } {
  const look = quickLook(c);
  const pts = radialProfile(c, look, MEAN_POINTS);
  // Simpson's rule on the uniform radial grid of radialProfile (an even number of intervals): the integral of 2 r T dr over the solid, divided by its area over pi.
  const mean = (region: "fuel" | "cladding") => {
    const p = pts.filter((q) => q.region === region);
    const n = p.length - 1;
    const h = (p[n]!.r - p[0]!.r) / n;
    let sum = 0;
    for (let i = 0; i <= n; i++) sum += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * 2 * p[i]!.r * p[i]!.T;
    return ((h / 3) * sum) / (p[n]!.r * p[n]!.r - p[0]!.r * p[0]!.r);
  };
  return { fuel: mean("fuel"), cladding: mean("cladding") };
}

/** The hot radii of a steady case whose radii are cold, or the reason there are none. */
export function hotGeometry(cold: NormalizedCase, spec: HotSpec): HotResult {
  const base: Radii = { fuelRadius: cold.fuelRadius, fuelInnerRadius: cold.fuelInnerRadius, claddingInnerRadius: cold.claddingInnerRadius, claddingOuterRadius: cold.claddingOuterRadius };
  let radii = base;
  let fuelMean = spec.referenceTemperature;
  let claddingMean = spec.referenceTemperature;
  let fuelFactor = 1;
  let claddingFactor = 1;
  for (let it = 1; it <= HOT_MAX_ITERATIONS; it++) {
    let m: { fuel: number; cladding: number };
    try {
      m = meanTemperatures({ ...cold, ...radii });
    } catch (e) {
      return { ok: false, reason: "the temperatures could not be found on the expanded radii (" + (e instanceof Error ? e.message : String(e)) + ")" };
    }
    fuelMean = m.fuel;
    claddingMean = m.cladding;
    fuelFactor = 1 + spec.fuel.alpha * (fuelMean - spec.referenceTemperature);
    claddingFactor = 1 + spec.cladding.alpha * (claddingMean - spec.referenceTemperature);
    if (!(fuelFactor > 0) || !(claddingFactor > 0)) return { ok: false, reason: "the expansion factor is not positive (the mean temperature is far below the reference temperature for this coefficient)" };
    const next: Radii = {
      fuelRadius: base.fuelRadius * fuelFactor,
      fuelInnerRadius: base.fuelInnerRadius * fuelFactor,
      claddingInnerRadius: base.claddingInnerRadius * claddingFactor,
      claddingOuterRadius: base.claddingOuterRadius * claddingFactor,
    };
    if (!(next.claddingInnerRadius > next.fuelRadius)) {
      return {
        ok: false,
        reason:
          "free expansion closes the gap: the fuel radius would be " + (next.fuelRadius * 1e3).toPrecision(6) + " mm and the cladding inner radius " + (next.claddingInnerRadius * 1e3).toPrecision(6) +
          " mm. The solids would press on each other, which needs the mechanics (contact, stress) that FEED does not have yet; use the cold radii, or enlarge the gap",
      };
    }
    const change = Math.max(...(Object.keys(next) as (keyof Radii)[]).map((k) => Math.abs(next[k] - radii[k]) / (radii[k] || 1)));
    radii = next;
    if (change < HOT_TOLERANCE) {
      return {
        ok: true,
        radii,
        record: {
          referenceTemperature: spec.referenceTemperature,
          fuel: { ...spec.fuel, meanTemperature: fuelMean, factor: fuelFactor },
          cladding: { ...spec.cladding, meanTemperature: claddingMean, factor: claddingFactor },
          cold: base,
          iterations: it,
          hotGap: radii.claddingInnerRadius - radii.fuelRadius,
          coldGap: base.claddingInnerRadius - base.fuelRadius,
        },
      };
    }
  }
  return { ok: false, reason: "the hot radii did not settle in " + HOT_MAX_ITERATIONS + " iterations" };
}
