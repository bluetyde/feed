// A pebble (plan 13, T4; docs/compact-pebble.md): a sphere with a fuelled zone (the homogenised mix of coated particles in a matrix, src/core/compact.ts) that makes the heat
// uniformly, an unfuelled graphite shell around it, and an outside film and bulk temperature (or a wall temperature). Steady, thermal only.
//
// The solutions here are the independent side: the closed form of the two-region sphere, its finite-volume solution (the particle's, src/core/trisoSolve.ts, which is generic in
// the number of regions and has no gap here), the time scale a steady run needs, and the wedge sphere OFFBEAT solves. The fuelled zone is the particle writer's "kernel with a power"
// (the zone that carries the heat source), the shell is a layer with no gap between them.

import { evaluate, Law, lawOf, rangeOf, solveHot } from "./conductivity";
import { SPHERE } from "./geometry";
import type { HomogenisedSpec } from "./compact";
import { MAX_STEADY_END_TIME, MIN_STEADY_END_TIME, STEADY_PSEUDO_HEAT_CAPACITY, STEADY_TOLERANCE, SteadyHorizon, TAU_SAFETY, lowestConductivity } from "./steadyState";
import type { NormalizedTriso } from "./triso";
import { faceRadii, roundUp2, TrisoModel } from "./trisoSolve";
import { TRISO_WEDGE_SCALE } from "./trisoWedge";
import type { Conductivity } from "./validate";

export const PEBBLE_REGIONS = ["fuelled", "shell"] as const;
export type PebbleRegion = (typeof PEBBLE_REGIONS)[number];
export const PEBBLE_MESH_MINIMUM = { fuelledCells: 4, shellCells: 2 } as const;
export const PEBBLE_MESH_MAXIMUM = { fuelledCells: 20000, shellCells: 10000 } as const;

export interface NormalizedPebble {
  caseId: string;
  fuelledRadius: number;
  outerRadius: number;
  /** The conductivity of the fuelled zone: the table of the mixture, carried by its fitted polynomial. */
  fuelledConductivity: Conductivity;
  shellConductivity: Conductivity;
  boundary: NormalizedTriso["boundary"];
  power: { powerDensity: number; fuelledPower: number; fuelledVolume: number; pebbleVolume: number };
  /** Cells in the fuelled zone and in the shell. */
  cells: [number, number];
  /** What the fuelled zone is made of: the particle, the matrix, the packing fraction and the law. */
  compact: HomogenisedSpec;
}

export interface PebbleClosedForm {
  filmDeltaT: number;
  wallT: number;
  /** The fuelled zone's surface (the shell's inner face) and its centre. */
  interfaceT: number;
  centreT: number;
  temperatureAt(r: number): number;
}

/**
 * The steady temperatures. The heat made in the fuelled zone, P, crosses every sphere outside it, so in the shell the conductivity integral from the outer face to r is
 * P (1/r - 1/Ro) / (4 pi); inside the fuelled zone the heat that crosses r is q''' 4/3 pi r^3, so the integral from r to its surface is q''' (R^2 - r^2) / 6. The film drops P / (4 pi Ro^2 h).
 */
export function pebbleClosedForm(p: NormalizedPebble): PebbleClosedForm {
  const P = p.power.fuelledPower;
  const q = p.power.powerDensity;
  const filmDeltaT = p.boundary.kind === "convective" ? P / (SPHERE.area(p.outerRadius) * p.boundary.heatTransferCoefficient) : 0;
  const wallT = p.boundary.kind === "convective" ? p.boundary.bulkTemperature + filmDeltaT : p.boundary.surfaceTemperature;
  const kShell = lawOf(p.shellConductivity);
  const kFuel = lawOf(p.fuelledConductivity);
  const interfaceT = solveHot(kShell, wallT, (P / (4 * Math.PI)) * (1 / p.fuelledRadius - 1 / p.outerRadius));
  const fuelAt = (r: number) => solveHot(kFuel, interfaceT, (q * (p.fuelledRadius ** 2 - r * r)) / 6);
  const temperatureAt = (r: number): number => {
    if (!(r >= 0 && r <= p.outerRadius)) throw new RangeError("the radius " + r + " m is outside the pebble (0 to " + p.outerRadius + " m)");
    if (r <= p.fuelledRadius) return fuelAt(r);
    return solveHot(kShell, wallT, (P / (4 * Math.PI)) * (1 / r - 1 / p.outerRadius));
  };
  return { filmDeltaT, wallT, interfaceT, centreT: fuelAt(0), temperatureAt };
}

/** The finite-volume model of the pebble: the particle's, with two regions and no gap (the gap conductance is never read because no face is the gap's). */
export function pebbleModel(p: NormalizedPebble): TrisoModel {
  return {
    kernelRadius: p.fuelledRadius,
    layerOuterRadii: [p.outerRadius],
    cells: [...p.cells],
    laws: [lawOf(p.fuelledConductivity), lawOf(p.shellConductivity)],
    gapConductance: Infinity,
    boundary: p.boundary,
    power: () => p.power.fuelledPower,
  };
}

/** The pebble the wedge solves: every radius times the wedge scale, the power density unchanged (so the power is that of the smaller fuelled zone). */
export function pebbleWedgeEquivalent(p: NormalizedPebble, scale = TRISO_WEDGE_SCALE): NormalizedPebble {
  const fuelledRadius = p.fuelledRadius * scale;
  const fuelledVolume = SPHERE.volume(0, fuelledRadius);
  return { ...p, fuelledRadius, outerRadius: p.outerRadius * scale, power: { ...p.power, fuelledVolume, fuelledPower: p.power.powerDensity * fuelledVolume, pebbleVolume: SPHERE.volume(0, p.outerRadius * scale) } };
}

/** The Elmore bound of a pebble on the writer's mesh (equal cells in each region), with the placeholder heat capacity and the lowest conductivity each material allows. */
export function pebbleTimeScale(p: NormalizedPebble): { tauBound: number; capacityRatio: number; cells: number } {
  const ks = [p.fuelledConductivity, p.shellConductivity].map((k: Conductivity) => lowestConductivity(k));
  const bounds = [0, p.fuelledRadius, p.outerRadius];
  const rFilm = p.boundary.kind === "convective" ? 1 / (SPHERE.area(p.outerRadius) * p.boundary.heatTransferCoefficient) : 0;
  const outwards = (ri: number, rc: number): number => {
    let res = SPHERE.resist(rc, bounds[ri + 1]!, ks[ri]!);
    for (let j = ri + 1; j < ks.length; j++) res += SPHERE.resist(bounds[j]!, bounds[j + 1]!, ks[j]!);
    return res + rFilm;
  };
  let sum = 0;
  let total = 0;
  let min = Infinity;
  for (let ri = 0; ri < 2; ri++) {
    const f = faceRadii(bounds[ri]!, bounds[ri + 1]!, p.cells[ri]!);
    for (let j = 0; j < p.cells[ri]!; j++) {
      const c = STEADY_PSEUDO_HEAT_CAPACITY * SPHERE.volume(f[j]!, f[j + 1]!);
      sum += c * outwards(ri, SPHERE.centroid(f[j]!, f[j + 1]!));
      total += c;
      if (c < min) min = c;
    }
  }
  return { tauBound: TAU_SAFETY * sum, capacityRatio: Math.sqrt(total / min), cells: p.cells[0] + p.cells[1] };
}

/** The end time of a steady run of the pebble: the particle's rule with the pebble's time scale. */
export function pebbleSteadyEndTime(p: NormalizedPebble): SteadyHorizon {
  const ts = pebbleTimeScale(p);
  const t0 = p.boundary.kind === "convective" ? p.boundary.bulkTemperature : p.boundary.surfaceTemperature;
  const dT0 = Math.max(Math.abs(pebbleClosedForm(p).centreT - t0), 1);
  const needed = ts.tauBound * Math.log(Math.max((ts.capacityRatio * dT0) / STEADY_TOLERANCE, Math.E));
  if (!Number.isFinite(needed) || !Number.isFinite(ts.tauBound)) return { ok: false, needed, tauBound: ts.tauBound, message: "the pebble's time scale is not a finite number: a non-finite value in the case reached it" };
  const endTime = Math.max(MIN_STEADY_END_TIME, roundUp2(needed));
  if (!(endTime <= MAX_STEADY_END_TIME)) return { ok: false, needed, tauBound: ts.tauBound, message: `the pebble's slowest thermal time constant is at most ${ts.tauBound.toExponential(2)} s (placeholder heat capacity), so a steady state within ${STEADY_TOLERANCE} K needs about ${needed.toExponential(2)} s, more than the ${MAX_STEADY_END_TIME.toExponential(0)} s FEED allows` };
  return { ok: true, endTime, tauBound: ts.tauBound, capacityRatio: ts.capacityRatio };
}

/** The conductivity laws of the pebble's two regions, fuelled zone first. */
export const pebbleLaws = (p: NormalizedPebble): Law[] => [lawOf(p.fuelledConductivity), lawOf(p.shellConductivity)];

/** The conductivity ranges the pebble's regions are stated for (undefined for a constant). */
export const pebbleRanges = (p: NormalizedPebble): ([number, number] | undefined)[] => [rangeOf(p.fuelledConductivity), rangeOf(p.shellConductivity)];

/**
 * How far OFFBEAT's temperatures at the fuelled zone's face may sit from the exact two-region solution on this mesh. OFFBEAT interpolates the conductivity linearly to a cell face,
 * where the exact scheme (and FEED's finite-volume solution) puts the two half-cells' resistances in series; across a jump in conductivity the two differ by a term proportional to the
 * cell width (measured: 0.488 K on a 40 + 10 cell mesh, 0.122 K on 160 + 40, tests/golden/offbeat-pebble). This is the estimate of that term at the face: the heat flux there times
 * the difference of the two resistances, with the conductivities at the face's temperature.
 */
export function pebbleInterfaceBias(p: NormalizedPebble): { bias: number; rise: number } {
  const cf = pebbleClosedForm(p);
  const q = p.power.fuelledPower / SPHERE.area(p.fuelledRadius);
  const d1 = p.fuelledRadius / p.cells[0] / 2;
  const d2 = (p.outerRadius - p.fuelledRadius) / p.cells[1] / 2;
  const k1 = evaluate(lawOf(p.fuelledConductivity), cf.interfaceT);
  const k2 = evaluate(lawOf(p.shellConductivity), cf.interfaceT);
  const kFace = (d2 * k1 + d1 * k2) / (d1 + d2);
  const bias = Math.abs(q * ((d1 + d2) / kFace - d1 / k1 - d2 / k2));
  return { bias, rise: Math.max(cf.centreT - cf.wallT, 0) };
}
