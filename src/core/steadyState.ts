// The steady-state gate (F0 exit review, finding 3).
//
// FEED computes a steady pin by running OFFBEAT's time-dependent solver to a long end time with a placeholder heat capacity (the
// writer gives every material rho 10000 and Cp 300, so rho Cp = 3e6 J/m3/K) and taking the final field. "Long enough" used to be a
// fixed 5e7 s and "well beyond the slowest thermal time constant" had no number. This module makes it measurable, in two parts.
//
// 1. A bound on the slowest time constant of the pin, from the case alone. The pin is a series chain of thermal capacitances to the
//    coolant, so the sum of ALL its time constants is the Elmore sum  sum_i C_i R_i  (trace of K^-1 C; R_i = resistance from cell i to
//    the coolant). Every time constant is positive, so the largest is at most that sum. Resistances use the lowest conductivity the
//    case allows (so the bound only grows), and a safety factor covers OFFBEAT's own gap treatment.
//
// 2. After the run: with an implicit Euler step, the deviation left from the steady state is  e = -K^-1 C (dT/dt)  over that step,
//    so in the capacitance-weighted norm |e| <= tau_max |dT/dt|, and in the max norm
//        max |e| <= tau_bound * sqrt(C_total / C_min) * max |dT/dt|.   (loose: about 25 times the real deviation)
//    The sharper form: K^-1 has only non-negative entries, so the max-norm operator bound is exact,
//        max |e| <= max_i ( sum_j C_j R_common(i,j) ) * max |dT/dt|   (the worst Elmore delay),
//    where R_common(i,j) is the resistance to the coolant of whichever of i and j is nearer it. Resistance to the coolant only falls
//    from the centre outwards, so the worst node is the centre, whose delay is exactly the sum  sum_j C_j R_j  computed here (this is
//    also the trace bound above). That sum, times the safety factor, is `tauBound`, and the drift bound uses it WITHOUT the sqrt(C_total /
//    C_min) factor; that factor is kept for the horizon only.
//    OFFBEAT prints max |dT/dt| / T for every step ("relative temperature change of ... K/s", at its source
//    offbeatLib/physicsSubSolvers/thermalSubSolver/thermalSubSolver.C nextDeltaT, which is max(maxRate, -minRate)). The gate is that
//    this bound, for the last step, is below STEADY_TOLERANCE (0.01 K). The input power's balance against the wall flux is the
//    separate energyBalance check (1% of the input power).
//
// The horizon in 1 is a NECESSARY condition (continuous-time decay; implicit Euler with small steps decays more slowly, with large
// steps faster). The drift bound in 2 is the certificate.

import { geometryOf } from "./geometry";
import type { NormalizedCase, Conductivity } from "./validate";
import { compositeLaw } from "./closedForm";
import { lawOf, minimum } from "./conductivity";

/** rho Cp the writer gives every material of a steady case (rho 10000 kg/m3, Cp 300 J/kg/K); a numerical vehicle, not a property. */
export const STEADY_PSEUDO_HEAT_CAPACITY = 10000 * 300;
/** The shortest steady end time, s: the horizon verified in F0 for the oracle pins. */
export const MIN_STEADY_END_TIME = 5e7;
/** The longest steady end time FEED will run, s. A case that needs more is refused. */
export const MAX_STEADY_END_TIME = 1e12;
/** Largest temperature still to change at the end of a steady run, K. */
export const STEADY_TOLERANCE = 0.01;
/** Margin on the time-constant bound for what the bound does not model (OFFBEAT's gap treatment between the two meshes). */
export const TAU_SAFETY = 1.25;

const TWO_PI = 2 * Math.PI;

/** The lowest conductivity a law takes over the temperatures it is valid for. */
export function lowestConductivity(k: Conductivity): number {
  if (k.kind === "constant") return k.k;
  return minimum(lawOf(k), k.range[0], k.range[1]); // exact, including a turning point inside the range
}

export interface TimeScale {
  /** The Elmore sum, with the safety factor: an upper bound on the slowest thermal time constant AND the worst Elmore delay (the exact max-norm bound), s */
  tauBound: number;
  /** sqrt(C_total / C_min) over the cells: converts the capacitance-norm bound to a max-norm bound */
  capacityRatio: number;
  cells: number;
}

/** The Elmore bound for the pin of a case, on the writer's mesh (uniform radial cells in the fuel and in the cladding). */
export function timeScale(n: NormalizedCase): TimeScale {
  const kf = lowestConductivity(n.fuelConductivity);
  const kc = lowestConductivity(n.claddingConductivity);
  const Rf = n.fuelRadius;
  const ri = n.fuelInnerRadius;
  const Rci = n.claddingInnerRadius;
  const Rco = n.claddingOuterRadius;
  const geo = geometryOf(n.plate);
  const rGap = 1 / (geo.area(Rf) * n.gapConductance);
  const rClad = geo.resist(Rci, Rco, kc);
  const rFilm = n.boundary.kind === "convective" ? 1 / (geo.area(Rco) * n.boundary.heatTransferCoefficient) : 0;
  let sum = 0;
  let total = 0;
  let min = Infinity;
  const cell = (r0: number, r1: number, resistance: (rc: number) => number) => {
    const c = STEADY_PSEUDO_HEAT_CAPACITY * geo.volume(r0, r1); // per unit length (a plate: per unit height and width)
    const rc = geo.centroid(r0, r1); // where OFFBEAT reports the cell's centre (the wedge cell's volume centroid, or the middle of a slab cell)
    sum += c * resistance(rc);
    total += c;
    if (c < min) min = c;
  };
  const dF = (Rf - ri) / n.mesh.fuelCells;
  for (let j = 0; j < n.mesh.fuelCells; j++) cell(ri + j * dF, ri + (j + 1) * dF, (rc) => geo.resist(rc, Rf, kf) + rGap + rClad + rFilm);
  const dC = (Rco - Rci) / n.mesh.claddingCells;
  for (let j = 0; j < n.mesh.claddingCells; j++) cell(Rci + j * dC, Rci + (j + 1) * dC, (rc) => geo.resist(rc, Rco, kc) + rFilm);
  return { tauBound: TAU_SAFETY * sum, capacityRatio: Math.sqrt(total / min), cells: n.mesh.fuelCells + n.mesh.claddingCells };
}

/** Upper bound on how far any cell can start from its steady value, K: from the coolant temperature to the closed-form centre. */
export function initialDeviationBound(n: NormalizedCase): number {
  const t0 = n.boundary.kind === "convective" ? n.boundary.bulkTemperature : n.boundary.surfaceTemperature;
  const comp = compositeLaw({
    slab: n.plate,
    qPrime: n.qPrime,
    fuelK: lawOf(n.fuelConductivity),
    fuelRadius: n.fuelRadius,
    fuelInnerRadius: n.fuelInnerRadius,
    hGap: n.gapConductance,
    claddingInnerRadius: n.claddingInnerRadius,
    claddingOuterRadius: n.claddingOuterRadius,
    claddingK: lawOf(n.claddingConductivity),
    boundary: n.boundary.kind === "convective" ? { kind: "convective", bulkTemperature: n.boundary.bulkTemperature, hFilm: n.boundary.heatTransferCoefficient } : { kind: "surface-temperature", surfaceTemperature: n.boundary.surfaceTemperature },
  });
  return Math.max(Math.abs(comp.centreT - t0), 1);
}

export type SteadyHorizon = { ok: true; endTime: number; tauBound: number; capacityRatio: number } | { ok: false; needed: number; tauBound: number; message: string };

/** Round up to two significant digits, so the end time in a case file is a readable number. */
const roundUp2 = (x: number): number => {
  const e = Math.floor(Math.log10(x)) - 1;
  const m = 10 ** e;
  return Math.ceil(x / m - 1e-9) * m;
};

/**
 * The end time of a steady run: at least MIN_STEADY_END_TIME, and at least the time the continuous-time decay bound needs for the
 * deviation to fall below STEADY_TOLERANCE. A case that needs more than MAX_STEADY_END_TIME cannot be run as a steady case.
 */
export function steadyEndTime(n: NormalizedCase): SteadyHorizon {
  const ts = timeScale(n);
  const dT0 = initialDeviationBound(n);
  const needed = ts.tauBound * Math.log(Math.max(ts.capacityRatio * dT0 / STEADY_TOLERANCE, Math.E));
  if (!Number.isFinite(needed) || !Number.isFinite(ts.tauBound)) {
    return { ok: false, needed, tauBound: ts.tauBound, message: "the pin's time scale is not a finite number: a non-finite value in the case (heat rate, radius, conductivity or conductance) reached it" };
  }
  const endTime = Math.max(MIN_STEADY_END_TIME, roundUp2(needed));
  if (!(endTime <= MAX_STEADY_END_TIME)) {
    return {
      ok: false,
      needed,
      tauBound: ts.tauBound,
      message: `the pin's slowest thermal time constant is at most ${ts.tauBound.toExponential(2)} s (placeholder heat capacity), so a steady state within ${STEADY_TOLERANCE} K needs about ${needed.toExponential(2)} s, more than the ${MAX_STEADY_END_TIME.toExponential(0)} s FEED will run; check the gap conductance, the film coefficient and the conductivities`,
    };
  }
  return { ok: true, endTime, tauBound: ts.tauBound, capacityRatio: ts.capacityRatio };
}

/**
 * The bound, in K, on what is still to change after the last step, from the rate OFFBEAT printed for it (max |dT/dt| / T, 1/s) and
 * the hottest temperature of the final field.
 */
export function remainingChangeBound(n: NormalizedCase, relativeRate: number, maxT: number): number {
  return timeScale(n).tauBound * Math.abs(relativeRate) * maxT;
}

/** The last "relative temperature change of X K/s" OFFBEAT printed (its max |dT/dt| / T over the cells for the last step), or undefined. */
export function lastRelativeRate(log: string): number | undefined {
  let found: number | undefined;
  const re = /relative temperature change of ([-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?|[-+]?nan|[-+]?inf) K\/s/gi;
  for (const m of log.matchAll(re)) {
    const t = m[1]!.toLowerCase();
    found = t.includes("nan") ? NaN : t.includes("inf") ? Infinity : Number(m[1]);
  }
  return found;
}
