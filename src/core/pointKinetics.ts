// A power history from point kinetics (plan 08, docs/point-kinetics.md): the pulse a reactivity insertion makes, with the prompt
// negative feedback of the fuel temperature. It is an INPUT GENERATOR: it produces the `transient.powerHistory` the thermal run then
// uses, and nothing else about the pin feeds back into it except through the lumped temperature described below.
//
//   dP/dt   = ((rho - beta) / Lambda) P + sum_i lambda_i C_i          P: total reactor power (W)
//   dC_i/dt = (beta_i / Lambda) P - lambda_i C_i                      C_i: precursor power of group i (W)
//   dE/dt   = P                                                       E: energy deposited (J)
//   rho     = rho_inserted(t) + integral from T0 to Tbar of alpha(T) dT
//
// Tbar is the fuel's volume-average temperature if the pulse's heat stayed where it was made (adiabatic): the energy per unit fuel volume
// is E (peaking / (pins length)) / A_fuel, and the fuel's own heat capacity c(T) = a + b T turns it into a temperature. Not modelled:
// heat leaving the fuel during the pulse (the results CHECK it against the pin's real average), the coolant, void, control action,
// delayed-neutron or generation-time changes with temperature, space-dependent kinetics.
//
// Integration: Dormand-Prince 5(4) with error control, steps capped at endTime/5000. The solution is then thinned to a polyline of at
// most MAX_POINTS points whose energy matches the integrated energy to ENERGY_TOLERANCE.

import { degree, solveHot } from "./conductivity";

export interface DelayedGroup {
  /** Delayed fraction beta_i (dimensionless). */
  beta: number;
  /** Decay constant lambda_i (1/s). */
  lambda: number;
}

export type Feedback = { kind: "constant"; alpha: number } | { kind: "linear"; a: number; b: number; range: [number, number] };

export interface KineticsSpec {
  /** Inserted reactivity, delta-k over k (from dk/k, pcm, or dollars times the case's total delayed fraction). */
  reactivity: number;
  /** Time over which the insertion ramps linearly from 0; 0 is a step. */
  insertionTime: number;
  /** Prompt neutron generation time Lambda, s. */
  generationTime: number;
  groups: DelayedGroup[];
  /** Differential coefficient d rho / d T in delta-k/k per K; negative. */
  feedback: Feedback;
  /** Total reactor power before the insertion, W (precursors in equilibrium with it). */
  initialPower: number;
  pins: number;
  /** Active length of a pin, m. */
  activeLength: number;
  /** Power of the modelled slice relative to the average pin power. */
  peakingFactor: number;
  endTime: number;
}

/** What the pin supplies: the fuel's cross-section, its heat capacity law and its average starting temperature. */
export interface KineticsContext {
  fuelArea: number;
  fuelC: { a: number; b: number };
  /** The heat capacity as coefficients c0 + c1 T + c2 T^2 (src/core/heatCapacity.ts); when it has a quadratic term it is used instead of fuelC. */
  fuelLaw?: readonly number[];
  startTemperature: number;
}

export interface KineticsTrace {
  time: number[];
  power: number[];
  reactivity: number[];
  fuelTemperature: number[];
  energy: number[];
}

export interface GeneratedPulse {
  /** The thinned history: time (s) and linear heat rate (W/m) of the modelled slice. */
  times: number[];
  linearHeatRate: number[];
  summary: {
    peakPower: number;
    timeOfPeak: number;
    peakLinearHeatRate: number;
    /** Full width at half maximum of the main peak, s (null if the power does not fall below half the peak within the window). */
    fwhm: number | null;
    totalEnergy: number;
    /** Energy deposited per unit length of the modelled slice, J/m. */
    energyPerLength: number;
    peakFuelRise: number;
    finalFuelTemperature: number;
    finalPower: number;
    /** Largest net reactivity reached, and the inserted reactivity in dollars (null without delayed groups). */
    maxReactivity: number;
    insertedDollars: number | null;
    points: number;
    steps: number;
    /** Relative difference between the thinned history's energy and the integrated energy. */
    energyError: number;
    /** Feedback temperature range, to check against a linear coefficient's valid range. */
    temperatureRange: [number, number];
  };
  trace: KineticsTrace;
}

export const MAX_POINTS = 1000;
export const ENERGY_TOLERANCE = 1e-3;
export const MAX_STEPS = 2_000_000;
const RTOL = 1e-9;

export class KineticsError extends Error {}

/** Temperature rise from an energy per unit volume, for c(T) = a + b T starting at T0: solves a dT + b/2 ((T0+dT)^2 - T0^2) = e. */
export function temperatureRise(c: { a: number; b: number }, T0: number, e: number): number {
  const c0 = c.a + c.b * T0;
  if (!(c0 > 0)) throw new KineticsError("the fuel heat capacity is not positive at the starting temperature");
  const disc = c0 * c0 + 2 * c.b * e;
  if (!(disc >= 0)) throw new KineticsError("the fuel heat capacity law has no temperature for this much energy (it would have to turn negative)");
  return (2 * e) / (c0 + Math.sqrt(disc));
}

/** The same for any law of degree 2 or 3: the temperature above T0 at which the enthalpy has risen by e (a bracketed solve; the law must stay positive on the way). */
export function temperatureRiseLaw(law: readonly number[], T0: number, e: number): number {
  try {
    return solveHot(law, T0, e) - T0;
  } catch (err) {
    if (err instanceof RangeError) throw new KineticsError("the fuel heat capacity law cannot take this much energy: " + err.message);
    throw err;
  }
}

/** Reactivity the temperature change from T0 to T brings: the integral of the differential coefficient. */
export function feedbackReactivity(f: Feedback, T0: number, T: number): number {
  return f.kind === "constant" ? f.alpha * (T - T0) : f.a * (T - T0) + 0.5 * f.b * (T * T - T0 * T0);
}

const A = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const E_COEF = [71 / 57600, 0, -71 / 16695, 71 / 1920, -17253 / 339200, 22 / 525, -1 / 40];

/** Run the equations and return every accepted step. Throws KineticsError with the reason when it cannot. */
export function integrate(spec: KineticsSpec, ctx: KineticsContext): KineticsTrace & { steps: number } {
  const m = spec.groups.length;
  const n = m + 2; // P, C_1..C_m, E
  const betaTotal = spec.groups.reduce((s, g) => s + g.beta, 0);
  const scale = (spec.peakingFactor / (spec.pins * spec.activeLength)) / ctx.fuelArea; // J/m3 of fuel per J of total energy
  const inserted = (t: number) => (spec.insertionTime > 0 ? spec.reactivity * Math.min(1, t / spec.insertionTime) : spec.reactivity);
  const curved = ctx.fuelLaw !== undefined && degree(ctx.fuelLaw) > 1;
  const fuelTemperature = (E: number) => ctx.startTemperature + (curved ? temperatureRiseLaw(ctx.fuelLaw!, ctx.startTemperature, Math.max(0, E) * scale) : temperatureRise(ctx.fuelC, ctx.startTemperature, Math.max(0, E) * scale));
  const reactivityAt = (t: number, E: number) => inserted(t) + feedbackReactivity(spec.feedback, ctx.startTemperature, fuelTemperature(E));

  const rhs = (t: number, y: number[], out: number[]) => {
    const rho = reactivityAt(t, y[n - 1]!);
    const P = y[0]!;
    let dP = ((rho - betaTotal) / spec.generationTime) * P;
    for (let i = 0; i < m; i++) {
      dP += spec.groups[i]!.lambda * y[1 + i]!;
      out[1 + i] = (spec.groups[i]!.beta / spec.generationTime) * P - spec.groups[i]!.lambda * y[1 + i]!;
    }
    out[0] = dP;
    out[n - 1] = P;
  };

  const y: number[] = new Array<number>(n).fill(0);
  y[0] = spec.initialPower;
  for (let i = 0; i < m; i++) y[1 + i] = (spec.groups[i]!.beta * spec.initialPower) / (spec.groups[i]!.lambda * spec.generationTime);
  const atol = y.map((_, i) => (i === n - 1 ? 1e-14 * spec.initialPower * Math.max(1e-3, spec.endTime) : 1e-12 * spec.initialPower));
  const hMax = spec.endTime / 5000;

  const trace: KineticsTrace & { steps: number } = { time: [0], power: [y[0]!], reactivity: [reactivityAt(0, 0)], fuelTemperature: [ctx.startTemperature], energy: [0], steps: 0 };
  let t = 0;
  const k: number[][] = Array.from({ length: 7 }, () => new Array<number>(n).fill(0));
  rhs(0, y, k[0]!);
  // first step from the fastest rate in the equations, then the controller takes over
  let h = Math.min(hMax, spec.generationTime / 10, spec.endTime / 1000);
  let rejected = 0;
  while (t < spec.endTime * (1 - 1e-14)) {
    if (trace.steps > MAX_STEPS) throw new KineticsError(`the integration needs more than ${MAX_STEPS} steps (a very fast pulse over a long window); shorten the end time or lengthen the generation time`);
    h = Math.min(h, hMax, spec.endTime - t);
    const ytmp = new Array<number>(n).fill(0);
    for (let s = 1; s < 7; s++) {
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let j = 0; j < s; j++) acc += A[s]![j]! * k[j]![i]!;
        ytmp[i] = y[i]! + h * acc;
      }
      rhs(t + C[s]! * h, ytmp, k[s]!);
    }
    // ytmp now holds the fifth-order solution (the last stage row of A is the b vector); k[6] is its derivative (FSAL)
    let err = 0;
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let j = 0; j < 7; j++) e += E_COEF[j]! * k[j]![i]!;
      const sc = atol[i]! + RTOL * Math.max(Math.abs(y[i]!), Math.abs(ytmp[i]!));
      err = Math.max(err, Math.abs(h * e) / sc);
    }
    if (!Number.isFinite(err)) throw new KineticsError("the integration produced a value that is not a finite number");
    if (err <= 1) {
      t += h;
      for (let i = 0; i < n; i++) y[i] = ytmp[i]!;
      if (y.some((v, i) => !Number.isFinite(v) || (i < n - 1 && v < -1e-9 * spec.initialPower))) throw new KineticsError("the power or a precursor group became negative or not finite");
      for (let i = 0; i < n; i++) k[0]![i] = k[6]![i]!;
      trace.steps++;
      trace.time.push(t);
      trace.power.push(Math.max(0, y[0]!));
      trace.energy.push(y[n - 1]!);
      trace.fuelTemperature.push(fuelTemperature(y[n - 1]!));
      trace.reactivity.push(reactivityAt(t, y[n - 1]!));
      rejected = 0;
    } else if (++rejected > 60) throw new KineticsError("the step size shrank without converging");
    h *= Math.min(5, Math.max(0.2, 0.9 * Math.pow(Math.max(err, 1e-10), -0.2)));
  }
  return trace;
}

/** Douglas-Peucker on (t, P): the fewest points, in order, within `tol` (W) of the curve; the index `must` (the peak) is always kept. Iterative. */
function simplify(t: number[], p: number[], tol: number, must: number): number[] {
  const keep = new Uint8Array(t.length);
  keep[0] = 1;
  keep[t.length - 1] = 1;
  keep[must] = 1;
  const stack: [number, number][] = must > 0 && must < t.length - 1 ? [[0, must], [must, t.length - 1]] : [[0, t.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const f = (t[i]! - t[a]!) / (t[b]! - t[a]!);
      const d = Math.abs(p[i]! - (p[a]! + f * (p[b]! - p[a]!)));
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < t.length; i++) if (keep[i]) idx.push(i);
  return idx;
}

const polylineEnergy = (t: number[], p: number[], idx: number[]) => {
  let e = 0;
  for (let j = 1; j < idx.length; j++) e += 0.5 * (p[idx[j - 1]!]! + p[idx[j]!]!) * (t[idx[j]!]! - t[idx[j - 1]!]!);
  return e;
};

/** Generate the pulse: integrate, find the peak, thin to a history, and summarise. Throws KineticsError with the reason. */
export function generatePulse(spec: KineticsSpec, ctx: KineticsContext, options: { maxPoints?: number } = {}): GeneratedPulse {
  const maxPoints = options.maxPoints ?? MAX_POINTS;
  const tr = integrate(spec, ctx);
  const n = tr.time.length;
  let ip = 0;
  for (let i = 1; i < n; i++) if (tr.power[i]! > tr.power[ip]!) ip = i;
  const peak = tr.power[ip]!;
  if (ip >= n - 2) throw new KineticsError("the power is still rising at the end time: the pulse has not happened inside the window. Lengthen the end time or raise the initial power");
  const total = tr.energy[n - 1]!;

  // thin to a history within the point budget whose energy matches the integrated energy
  let tol = 1e-3 * peak;
  let idx = simplify(tr.time, tr.power, tol, ip);
  let err = Math.abs(polylineEnergy(tr.time, tr.power, idx) - total) / total;
  for (let round = 0; round < 40 && (err > ENERGY_TOLERANCE || idx.length > maxPoints); round++) {
    if (idx.length > maxPoints && err <= ENERGY_TOLERANCE) tol *= 1.5;
    else tol *= 0.5;
    idx = simplify(tr.time, tr.power, tol, ip);
    err = Math.abs(polylineEnergy(tr.time, tr.power, idx) - total) / total;
  }
  if (idx.length > maxPoints || err > ENERGY_TOLERANCE) throw new KineticsError(`the pulse cannot be written as a history of at most ${maxPoints} points within ${ENERGY_TOLERANCE * 100}% of its energy (it needs ${idx.length}, error ${(err * 100).toFixed(3)}%)`);

  const share = spec.peakingFactor / (spec.pins * spec.activeLength);
  const times = idx.map((i) => tr.time[i]!);
  const linearHeatRate = idx.map((i) => tr.power[i]! * share);

  // full width at half maximum around the peak, linear between samples
  const half = peak / 2;
  const crossing = (from: number, dir: 1 | -1): number | null => {
    for (let i = from; i > 0 && i < n; i += dir) {
      const j = i + dir;
      if (j < 0 || j >= n) return null;
      if (tr.power[j]! <= half) {
        const f = (tr.power[i]! - half) / (tr.power[i]! - tr.power[j]!);
        return tr.time[i]! + f * (tr.time[j]! - tr.time[i]!);
      }
    }
    return null;
  };
  const up = (() => {
    for (let i = ip; i > 0; i--) if (tr.power[i - 1]! <= half) return tr.time[i - 1]! + ((half - tr.power[i - 1]!) / (tr.power[i]! - tr.power[i - 1]!)) * (tr.time[i]! - tr.time[i - 1]!);
    return null;
  })();
  const down = crossing(ip, 1);
  const betaTotal = spec.groups.reduce((s, g) => s + g.beta, 0);
  const Tmin = Math.min(...tr.fuelTemperature);
  let Tmax = -Infinity;
  for (const x of tr.fuelTemperature) if (x > Tmax) Tmax = x;
  let rmax = -Infinity;
  for (const x of tr.reactivity) if (x > rmax) rmax = x;
  return {
    times,
    linearHeatRate,
    summary: {
      peakPower: peak,
      timeOfPeak: tr.time[ip]!,
      peakLinearHeatRate: peak * share,
      fwhm: up !== null && down !== null ? down - up : null,
      totalEnergy: total,
      energyPerLength: total * share,
      peakFuelRise: Tmax - ctx.startTemperature,
      finalFuelTemperature: tr.fuelTemperature[n - 1]!,
      finalPower: tr.power[n - 1]!,
      maxReactivity: rmax,
      insertedDollars: betaTotal > 0 ? spec.reactivity / betaTotal : null,
      points: idx.length,
      steps: tr.steps,
      energyError: err,
      temperatureRange: [Tmin, Tmax],
    },
    trace: { time: tr.time, power: tr.power, reactivity: tr.reactivity, fuelTemperature: tr.fuelTemperature, energy: tr.energy },
  };
}
