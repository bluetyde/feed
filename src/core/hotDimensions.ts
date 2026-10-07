// Hot dimensions: the radii of a steady case at operating temperature, from free linear thermal expansion (docs/hot-dimensions.md).
// A case states cold radii; with a hotDimensions section the temperature solution is computed on the radii each solid has at its own mean thermal strain.
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

/** The instantaneous linear expansion coefficient alpha(T): constant, or a + b T (T in K) over a stated range of temperature. */
export type ExpansionLaw = { kind: "constant"; alpha: number } | { kind: "linear"; a: number; b: number; range: [number, number] };

export interface HotSolid {
  expansion: ExpansionLaw;
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

export const alphaAt = (law: ExpansionLaw, T: number): number => (law.kind === "constant" ? law.alpha : law.a + law.b * T);

/** The thermal strain from the reference temperature to T: the integral of alpha dT. */
export const thermalStrain = (law: ExpansionLaw, T: number, Tref: number): number => (law.kind === "constant" ? law.alpha * (T - Tref) : law.a * (T - Tref) + 0.5 * law.b * (T * T - Tref * Tref));

/** What the normalized case keeps about the correction: enough to show the cold and hot dimensions and to repeat the calculation. */
export interface SolidRecord extends HotSolid {
  /** The area-weighted mean temperature of the solid, K. */
  meanTemperature: number;
  /** The coolest and hottest point of the solid on the closed-form profile, K. */
  temperatureRange: [number, number];
  /** The area-weighted mean thermal strain, and 1 + that: the factor every radius of the solid is multiplied by. */
  meanStrain: number;
  factor: number;
  /** True when the solid's temperatures leave the range the coefficient states (a warning, never an extrapolation made silently). */
  outOfRange: boolean;
}

export interface HotRecord {
  referenceTemperature: number;
  fuel: SolidRecord;
  cladding: SolidRecord;
  cold: Radii;
  iterations: number;
  /** The hot gap (claddingInnerRadius - fuelRadius), m, and the cold one. */
  hotGap: number;
  coldGap: number;
}

/** Why there are no hot radii: the geometry (the gap closes, nothing settles), the temperatures (a conductivity cannot be solved), or the expansion law (not positive where it is used). */
export type HotFailureKind = "geometry" | "temperatures" | "expansion";
export type HotResult = { ok: true; radii: Radii; record: HotRecord } | { ok: false; kind: HotFailureKind; reason: string };

interface Stats {
  meanT: number;
  mean: number;
  min: number;
  max: number;
}

/** The area-weighted mean temperature and the area-weighted mean of f(T) for each solid, on the closed-form profile of the case as it stands. */
export function profileStats(c: NormalizedCase, fFuel: (T: number) => number, fCladding: (T: number) => number): { fuel: Stats; cladding: Stats } {
  const look = quickLook(c);
  const pts = radialProfile(c, look, MEAN_POINTS);
  // Simpson's rule on the uniform radial grid of radialProfile (an even number of intervals): the integral of 2 r g(T) dr over the solid, divided by its area over pi.
  const stats = (region: "fuel" | "cladding", f: (T: number) => number): Stats => {
    const p = pts.filter((q) => q.region === region);
    const n = p.length - 1;
    const h = (p[n]!.r - p[0]!.r) / n;
    const area = p[n]!.r * p[n]!.r - p[0]!.r * p[0]!.r;
    let sT = 0;
    let sF = 0;
    for (let i = 0; i <= n; i++) {
      const w = (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * 2 * p[i]!.r;
      sT += w * p[i]!.T;
      sF += w * f(p[i]!.T);
    }
    return { meanT: ((h / 3) * sT) / area, mean: ((h / 3) * sF) / area, min: Math.min(...p.map((q) => q.T)), max: Math.max(...p.map((q) => q.T)) };
  };
  return { fuel: stats("fuel", fFuel), cladding: stats("cladding", fCladding) };
}

/** The area-weighted mean temperature of each solid (kept for the tests and the editor's summary). */
export function meanTemperatures(c: NormalizedCase): { fuel: number; cladding: number } {
  const s = profileStats(c, (T) => T, (T) => T);
  return { fuel: s.fuel.meanT, cladding: s.cladding.meanT };
}

/** The hot radii of a steady case whose radii are cold, or the reason there are none. */
export function hotGeometry(cold: NormalizedCase, spec: HotSpec): HotResult {
  const base: Radii = { fuelRadius: cold.fuelRadius, fuelInnerRadius: cold.fuelInnerRadius, claddingInnerRadius: cold.claddingInnerRadius, claddingOuterRadius: cold.claddingOuterRadius };
  const Tref = spec.referenceTemperature;
  let radii = base;
  let sf: Stats = { meanT: Tref, mean: 0, min: Tref, max: Tref };
  let sc: Stats = { meanT: Tref, mean: 0, min: Tref, max: Tref };
  for (let it = 1; it <= HOT_MAX_ITERATIONS; it++) {
    try {
      const s = profileStats({ ...cold, ...radii }, (T) => thermalStrain(spec.fuel.expansion, T, Tref), (T) => thermalStrain(spec.cladding.expansion, T, Tref));
      sf = s.fuel;
      sc = s.cladding;
    } catch (e) {
      return { ok: false, kind: "temperatures", reason: "the temperatures of this pin cannot be found on the expanded radii: " + (e instanceof Error ? e.message : String(e)) + ". A conductivity that is positive over its stated range can still reach zero outside it, where the pin runs" };
    }
    for (const [name, law, s] of [["fuel", spec.fuel.expansion, sf], ["cladding", spec.cladding.expansion, sc]] as const) {
      if (!(alphaAt(law, s.min) > 0) || !(alphaAt(law, s.max) > 0)) return { ok: false, kind: "expansion", reason: "the " + name + "'s expansion coefficient is not positive over its temperatures (" + s.min.toFixed(1) + " to " + s.max.toFixed(1) + " K)" };
    }
    const fuelFactor = 1 + sf.mean;
    const claddingFactor = 1 + sc.mean;
    if (!(fuelFactor > 0) || !(claddingFactor > 0)) return { ok: false, kind: "expansion", reason: "the expansion factor is not positive (the mean temperature is far below the reference temperature for this coefficient)" };
    const next: Radii = {
      fuelRadius: base.fuelRadius * fuelFactor,
      fuelInnerRadius: base.fuelInnerRadius * fuelFactor,
      claddingInnerRadius: base.claddingInnerRadius * claddingFactor,
      claddingOuterRadius: base.claddingOuterRadius * claddingFactor,
    };
    if (!(next.claddingInnerRadius > next.fuelRadius)) {
      return {
        ok: false,
        kind: "geometry" as const,
        reason:
          "free expansion closes the gap: the fuel radius would be " + (next.fuelRadius * 1e3).toPrecision(6) + " mm and the cladding inner radius " + (next.claddingInnerRadius * 1e3).toPrecision(6) +
          " mm. The solids would press on each other, which needs the mechanics (contact, stress) that FEED does not have yet; use the cold radii, or enlarge the gap",
      };
    }
    const change = Math.max(...(Object.keys(next) as (keyof Radii)[]).map((k) => Math.abs(next[k] - radii[k]) / (radii[k] || 1)));
    radii = next;
    if (change < HOT_TOLERANCE) {
      const solid = (hs: HotSolid, s: Stats): SolidRecord => ({
        ...hs,
        meanTemperature: s.meanT,
        temperatureRange: [s.min, s.max],
        meanStrain: s.mean,
        factor: 1 + s.mean,
        // the strain is the integral of alpha from the reference temperature to the solid's temperature, so the whole interval must lie in the range, not only the operating end
        outOfRange: hs.expansion.kind === "linear" && (Math.min(s.min, Tref) < hs.expansion.range[0] || Math.max(s.max, Tref) > hs.expansion.range[1]),
      });
      return {
        ok: true,
        radii,
        record: {
          referenceTemperature: Tref,
          fuel: solid(spec.fuel, sf),
          cladding: solid(spec.cladding, sc),
          cold: base,
          iterations: it,
          hotGap: radii.claddingInnerRadius - radii.fuelRadius,
          coldGap: base.claddingInnerRadius - base.fuelRadius,
        },
      };
    }
  }
  return { ok: false, kind: "geometry", reason: "the hot radii did not settle in " + HOT_MAX_ITERATIONS + " iterations" };
}
