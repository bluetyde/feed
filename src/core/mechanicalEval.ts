// The constant mechanical properties OFFBEAT is given for each solid (docs/plans/09-mechanics.md M2).
//
// OFFBEAT's `constant` material takes one Young's modulus, one Poisson's ratio and one expansion coefficient per solid; it has no model that is linear in temperature (its
// other models are for UO2, Zircaloy and a few other materials). A case that states a modulus or a coefficient as a law of temperature is therefore reduced to constants, on
// the closed-form temperature profile of the case (one-way coupling: the temperatures do not depend on the mechanics, which the M0 probe confirmed to 1e-5 K):
//   - the modulus E at the area-weighted mean temperature of the solid;
//   - the expansion coefficient that gives the same MEAN thermal strain: alpha_eff = (area-weighted mean of the strain from the reference temperature) / (mean temperature - reference),
//     the same rule the hot dimensions use for the radii, so a pin with hot dimensions and a pin with mechanics expand alike.
// This is an approximation of the stress (the strain profile is the constant coefficient's, not the law's) and the results say so. A solid that runs outside the range its law
// is stated for is reported, not refused (the same as the hot dimensions).
import { alphaAt, profileStats, thermalStrain } from "./hotDimensions";
import { hydrogenPressure } from "./hydrogenPressure";
import type { Elasticity, MechanicalProps, NormalizedCase } from "./validate";

export interface EffectiveSolid {
  /** Young's modulus (Pa), Poisson's ratio and the shear modulus E / (2 (1 + nu)) (Pa) OFFBEAT is given. */
  E: number;
  nu: number;
  G: number;
  /** The constant expansion coefficient (1/K) that reproduces the mean thermal strain from the reference temperature. */
  alpha: number;
  /** The mean temperature (K) the modulus was taken at, and the lowest and highest temperature of the solid. */
  meanTemperature: number;
  temperatureRange: [number, number];
  /** True when the solid's temperatures, or the reference temperature, leave the range a law is stated for. */
  elasticityOutOfRange: boolean;
  expansionOutOfRange: boolean;
}

export interface EffectiveMechanics {
  referenceTemperature: number;
  /** The gas pressure in the gap, Pa (0 for none), and for the hydrogen model the fuel temperature (K) and the H/Zr ratio it was taken at. */
  internalPressure: number;
  internalPressureNote?: string;
  fuel: EffectiveSolid;
  cladding: EffectiveSolid;
}

export const elasticityAt = (e: Elasticity, T: number): number => (e.kind === "constant" ? e.E : e.a + e.b * T);

function effective(p: MechanicalProps, mean: { meanT: number; mean: number; min: number; max: number }, Tref: number): EffectiveSolid {
  const E = elasticityAt(p.elasticity, mean.meanT);
  const nu = p.elasticity.nu;
  const dT = mean.meanT - Tref;
  // a solid at the reference temperature has no thermal strain: the coefficient there is the instantaneous one
  const alpha = Math.abs(dT) < 1e-9 ? alphaAt(p.expansion, mean.meanT) : mean.mean / dT;
  const outside = (range: [number, number] | undefined, lo: number, hi: number) => range !== undefined && (lo < range[0] || hi > range[1]);
  const eRange = p.elasticity.range;
  const xRange = p.expansion.kind === "linear" ? p.expansion.range : undefined;
  return {
    E,
    nu,
    G: E / (2 * (1 + nu)),
    alpha,
    meanTemperature: mean.meanT,
    temperatureRange: [mean.min, mean.max],
    elasticityOutOfRange: outside(eRange, mean.min, mean.max),
    // the coefficient's law is integrated from the reference temperature, so the reference counts too
    expansionOutOfRange: outside(xRange, Math.min(mean.min, Tref), Math.max(mean.max, Tref)),
  };
}

/** The constants for a case that asks for mechanics (c.mechanics and c.mechanical present), or undefined. */
export function effectiveMechanics(c: NormalizedCase): EffectiveMechanics | undefined {
  if (!c.mechanics || !c.mechanical) return undefined;
  // a transient has no one set of constants: its law reduction and gas pressure belong to each output time (plan 17 M3)
  if (c.transient) return undefined;
  const Tref = c.mechanics.referenceTemperature;
  const stats = profileStats(c, (T) => thermalStrain(c.mechanical!.fuel.expansion, T, Tref), (T) => thermalStrain(c.mechanical!.cladding.expansion, T, Tref));
  const ip = c.mechanics.internalPressure;
  let internalPressure = 0;
  let internalPressureNote: string | undefined;
  if (ip?.kind === "constant") {
    internalPressure = ip.pressure;
    internalPressureNote = "a stated pressure of " + ip.pressure + " Pa (" + ip.source + ")";
  } else if (ip?.kind === "hydrogen-zrh") {
    const T = ip.basis === "peak" ? stats.fuel.max : stats.fuel.meanT;
    internalPressure = hydrogenPressure(ip.hZrRatio, T);
    internalPressureNote = "the hydrogen dissociation pressure of H/Zr " + ip.hZrRatio + " at the fuel's " + (ip.basis === "peak" ? "peak" : "area-mean") + " temperature " + T.toFixed(1) + " K, " + internalPressure.toPrecision(5) + " Pa (" + ip.source + ")";
  }
  return { referenceTemperature: Tref, internalPressure, ...(internalPressureNote ? { internalPressureNote } : {}), fuel: effective(c.mechanical.fuel, stats.fuel, Tref), cladding: effective(c.mechanical.cladding, stats.cladding, Tref) };
}
