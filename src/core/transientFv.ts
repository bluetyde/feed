// An independent time-dependent finite-volume solution of the pin (plan 08). Not OFFBEAT: a second method, written without any
// reference to the solver, used to (1) check OFFBEAT's transient result at run time, and (2) estimate the time-stepping error by
// running the same case at half the step. It is validated against exact solutions in tests/transientFv.test.ts.
//
// Cell-centred, one dimension (radius), per unit length. Fuel (solid or annular with an insulated hole), a gap that is one
// conductance at the fuel radius, cladding, and an outer boundary that is convective or a fixed temperature. Implicit Euler
// (the scheme OFFBEAT uses) or Crank-Nicolson, Picard iteration for temperature-dependent conductivity and heat capacity.
// Heat capacity c(T) = a + b T is handled through the enthalpy H(T) = a T + b T^2 / 2, so stored energy is conserved exactly.

import type { BoundaryValue } from "./boundaryHistory";
import { Law, evaluate, primitive } from "./conductivity";
import { geometryOf } from "./geometry";

const TWO_PI = 2 * Math.PI;

export interface Linear {
  a: number;
  b: number;
}

export interface TransientPin {
  /** A plate (a slab through its thickness, per unit height and width) instead of a pin: the coordinates below are then distances from the insulated mid-plane (src/core/geometry.ts). */
  slab?: boolean;
  fuelInnerRadius: number;
  fuelRadius: number;
  claddingInnerRadius: number;
  claddingOuterRadius: number;
  fuelCells: number;
  claddingCells: number;
  /** W/m2/K at the fuel radius. */
  gapConductance: number;
  /** k = a + b T, c = a + b T (volumetric, J/m3/K), T in K. */
  fuelK: Linear;
  claddingK: Linear;
  /** When given, the conductivity law of each solid as coefficients of k(T) = a0 + a1 T + a2 T^2 + a3 T^3 (src/core/conductivity.ts), and fuelK / claddingK are not used. */
  fuelLaw?: Law;
  claddingLaw?: Law;
  fuelC: Linear;
  claddingC: Linear;
  /** When given, the volumetric heat capacity of each solid as coefficients c0 + c1 T + c2 T^2 (src/core/heatCapacity.ts), and fuelC / claddingC are not used. */
  fuelCLaw?: readonly number[];
  claddingCLaw?: readonly number[];
  boundary: { kind: "convective"; bulkTemperature: number; heatTransferCoefficient: number } | { kind: "surface-temperature"; surfaceTemperature: number };
  /** When given, the coolant side at time t (s) instead of the constant `boundary`: the value of the END of a step is the one an implicit step uses, as OFFBEAT does (plan 11 B0). */
  boundaryAt?: (t: number) => BoundaryValue;
  /** Linear heat rate in W/m at time t (s). */
  power: (t: number) => number;
}

export interface FvOptions {
  /** Step in seconds and number of steps. */
  dt: number;
  steps: number;
  /** Exactly one of these: a uniform starting temperature, or the temperature of every cell (fuel inner to outer, then cladding inner to outer). */
  initialTemperature?: number;
  initialField?: number[];
  /** Record the state after every `outputEvery` steps (and at step 0). */
  outputEvery: number;
  /** Also record, at every step, the hottest cell and the temperature extrema of each solid (cheap; independent of the outputs). */
  trace?: boolean;
  scheme?: "implicit-euler" | "crank-nicolson";
  /** How the source of a step is taken: the new time (as OFFBEAT does) or the average of old and new (trapezoid). */
  source?: "new" | "average";
}

export interface FvState {
  time: number;
  /** Fuel cells (inner to outer) then cladding cells (inner to outer). */
  T: number[];
  /** Energy deposited by the source so far, J/m, and heat that left through the outer boundary so far, J/m. */
  deposited: number;
  rejected: number;
  /** Outer cladding wall temperature (the boundary value, between the last cell and the coolant). */
  wall: number;
}

export interface FvTrace {
  /** Hottest cell at step 0, 1, ..., steps. */
  peakByStep: number[];
  /** Hottest fuel cell and hottest cladding cell at each step, the same indices (for limits that depend on both). */
  fuelByStep: number[];
  claddingByStep: number[];
  fuelMin: number;
  fuelMax: number;
  claddingMin: number;
  claddingMax: number;
}

export interface FvTransient {
  trace?: FvTrace;
  /** Cell-centre radii (m): fuel then cladding. */
  r: number[];
  states: FvState[];
}

function thomas(lower: number[], diag: number[], upper: number[], rhs: number[]): number[] {
  const n = diag.length;
  const c = new Array<number>(n).fill(0);
  const d = new Array<number>(n).fill(0);
  c[0] = (upper[0] ?? 0) / diag[0]!;
  d[0] = rhs[0]! / diag[0]!;
  for (let i = 1; i < n; i++) {
    const m = diag[i]! - lower[i]! * c[i - 1]!;
    c[i] = (upper[i] ?? 0) / m;
    d[i] = (rhs[i]! - lower[i]! * d[i - 1]!) / m;
  }
  const x = new Array<number>(n).fill(0);
  x[n - 1] = d[n - 1]!;
  for (let i = n - 2; i >= 0; i--) x[i] = d[i]! - c[i]! * x[i + 1]!;
  return x;
}

/** Extremes without argument spreading: a list of a few hundred thousand values would overflow the call stack. */
export function maxOf(a: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
  return m;
}
export function minOf(a: ArrayLike<number>): number {
  let m = Infinity;
  for (let i = 0; i < a.length; i++) if (a[i]! < m) m = a[i]!;
  return m;
}

/** The conductivity of the fuel or the cladding at T: the law if the pin has one, else the linear a + b T. */
export function conductivityOf(p: TransientPin, fuel: boolean, T: number): number {
  const law = fuel ? p.fuelLaw : p.claddingLaw;
  if (law) return evaluate(law, T);
  const l = fuel ? p.fuelK : p.claddingK;
  return l.a + l.b * T;
}

export const enthalpy = (c: Linear, T: number) => c.a * T + 0.5 * c.b * T * T;

/** The volumetric heat capacity of the fuel or the cladding at T: the law if the pin has one, else the linear a + b T. */
export function capacityOf(p: TransientPin, fuel: boolean, T: number): number {
  const law = fuel ? p.fuelCLaw : p.claddingCLaw;
  if (law) return evaluate(law, T);
  const l = fuel ? p.fuelC : p.claddingC;
  return l.a + l.b * T;
}

/** The enthalpy per unit volume (the integral of c from 0 to T), for the same law. */
export function enthalpyOf(p: TransientPin, fuel: boolean, T: number): number {
  const law = fuel ? p.fuelCLaw : p.claddingCLaw;
  return law ? primitive(law, T) : enthalpy(fuel ? p.fuelC : p.claddingC, T);
}

export function solveTransientFv(p: TransientPin, o: FvOptions): FvTransient {
  const nf = p.fuelCells;
  const nc = p.claddingCells;
  const n = nf + nc;
  const scheme = o.scheme ?? "implicit-euler";
  const sourceMode = o.source ?? "new";
  const faces: number[] = [];
  for (let i = 0; i <= nf; i++) faces.push(p.fuelInnerRadius + ((p.fuelRadius - p.fuelInnerRadius) * i) / nf);
  const cfaces: number[] = [];
  for (let i = 0; i <= nc; i++) cfaces.push(p.claddingInnerRadius + ((p.claddingOuterRadius - p.claddingInnerRadius) * i) / nc);
  const r: number[] = [];
  for (let i = 0; i < nf; i++) r.push(0.5 * (faces[i]! + faces[i + 1]!));
  for (let i = 0; i < nc; i++) r.push(0.5 * (cfaces[i]! + cfaces[i + 1]!));
  // cell volume per unit length of the full cylinder, pi (r_out^2 - r_in^2), or per unit height and width of the slab, x_out - x_in
  const geo = geometryOf(p.slab);
  const vol: number[] = [];
  for (let i = 0; i < nf; i++) vol.push(geo.volume(faces[i]!, faces[i + 1]!));
  for (let i = 0; i < nc; i++) vol.push(geo.volume(cfaces[i]!, cfaces[i + 1]!));
  const fuelArea = geo.volume(p.fuelInnerRadius, p.fuelRadius);
  const share: number[] = vol.map((v, i) => (i < nf ? v / fuelArea : 0));
  const kOf = (i: number, T: number) => conductivityOf(p, i < nf, T);

  /** Conductances (W/K per unit length) between cell i and i+1 and to the outside, at temperatures T. */
  const boundaryOf = (t: number): BoundaryValue => (p.boundaryAt ? p.boundaryAt(t) : p.boundary);
  const conductances = (T: number[], b: BoundaryValue) => {
    const g: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      if (i !== nf - 1) {
        const k = 0.5 * (kOf(i, T[i]!) + kOf(i + 1, T[i + 1]!));
        g.push(geo.conductance(r[i]!, r[i + 1]!, k));
      } else {
        const rF = geo.resist(r[i]!, p.fuelRadius, kOf(i, T[i]!));
        const rGap = 1 / (geo.area(p.fuelRadius) * p.gapConductance);
        const rC = geo.resist(p.claddingInnerRadius, r[i + 1]!, kOf(i + 1, T[i + 1]!));
        g.push(1 / (rF + rGap + rC));
      }
    }
    const rHalf = geo.resist(r[n - 1]!, p.claddingOuterRadius, kOf(n - 1, T[n - 1]!));
    const gOut = b.kind === "convective" ? 1 / (rHalf + 1 / (geo.area(p.claddingOuterRadius) * b.heatTransferCoefficient)) : 1 / rHalf;
    return { g, gOut };
  };
  const outerOf = (b: BoundaryValue) => (b.kind === "convective" ? b.bulkTemperature : b.surfaceTemperature);

  /** Net heat flowing into each cell from conduction at temperatures T (W per unit length), with conductances taken at `Tk`. */
  const conduction = (T: number[], Tk: number[], b: BoundaryValue) => {
    const { g, gOut } = conductances(Tk, b);
    const f = new Array<number>(n).fill(0);
    for (let i = 0; i < n - 1; i++) {
      const q = g[i]! * (T[i + 1]! - T[i]!);
      f[i]! += q;
      f[i + 1]! -= q;
    }
    f[n - 1]! += gOut * (outerOf(b) - T[n - 1]!);
    return { f, gOut };
  };

  /** Temperature of the outer boundary of the cladding, between the last cell and the coolant. */
  const wallOf = (Tc: number[], b: BoundaryValue) => {
    if (b.kind !== "convective") return outerOf(b);
    const gHalf = geo.conductance(r[n - 1]!, p.claddingOuterRadius, kOf(n - 1, Tc[n - 1]!));
    const gFilm = geo.area(p.claddingOuterRadius) * b.heatTransferCoefficient;
    return (gHalf * Tc[n - 1]! + gFilm * b.bulkTemperature) / (gHalf + gFilm);
  };
  if ((o.initialTemperature === undefined) === (o.initialField === undefined)) throw new Error("give exactly one of initialTemperature and initialField");
  if (o.initialField !== undefined && (o.initialField.length !== n || !o.initialField.every((x) => Number.isFinite(x) && x > 0))) throw new Error("initialField needs " + n + " positive finite temperatures");
  let T = o.initialField !== undefined ? o.initialField.slice() : new Array<number>(n).fill(o.initialTemperature!);
  const states: FvState[] = [{ time: 0, T: T.slice(), deposited: 0, rejected: 0, wall: wallOf(T, boundaryOf(0)) }];
  const trace: FvTrace | undefined = o.trace ? { peakByStep: [maxOf(T)], fuelByStep: [maxOf(T.slice(0, nf))], claddingByStep: [maxOf(T.slice(nf))], fuelMin: minOf(T.slice(0, nf)), fuelMax: maxOf(T.slice(0, nf)), claddingMin: minOf(T.slice(nf)), claddingMax: maxOf(T.slice(nf)) } : undefined;
  let deposited = 0;
  let rejected = 0;
  for (let step = 1; step <= o.steps; step++) {
    const t0 = (step - 1) * o.dt;
    const t1 = step * o.dt;
    const b1 = boundaryOf(t1);
    const b0 = boundaryOf(t0);
    const outerT = outerOf(b1);
    const q1 = p.power(t1);
    const q0 = p.power(t0);
    const qs = scheme === "implicit-euler" && sourceMode === "average" ? 0.5 * (q0 + q1) : q1;
    const Told = T;
    // explicit part for Crank-Nicolson: half of the old conduction and old source
    const old = scheme === "crank-nicolson" ? conduction(Told, Told, b0) : null;
    const theta = scheme === "crank-nicolson" ? 0.5 : 1;
    let Tn = Told.slice();
    for (let iter = 0; iter < 100; iter++) {
      const { g, gOut } = conductances(Tn, b1);
      const lower = new Array<number>(n).fill(0);
      const diag = new Array<number>(n).fill(0);
      const upper = new Array<number>(n).fill(0);
      const rhs = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        // enthalpy change over the step, linearised about the iterate: dH = H(Tn) - H(Told) + c(Tn) (Tnew - Tn)
        const isFuel = i < nf;
        const cTn = capacityOf(p, isFuel, Tn[i]!);
        const Cdt = (vol[i]! * cTn) / o.dt;
        diag[i] = Cdt;
        rhs[i] = Cdt * Tn[i]! - (vol[i]! * (enthalpyOf(p, isFuel, Tn[i]!) - enthalpyOf(p, isFuel, Told[i]!))) / o.dt;
        const srcNow = share[i]! * qs;
        rhs[i]! += theta * srcNow + (scheme === "crank-nicolson" ? 0.5 * share[i]! * q0 + 0.5 * old!.f[i]! : 0);
      }
      for (let i = 0; i < n - 1; i++) {
        const gi = theta * g[i]!;
        diag[i]! += gi;
        diag[i + 1]! += gi;
        upper[i] = -gi;
        lower[i + 1] = -gi;
      }
      diag[n - 1]! += theta * gOut;
      rhs[n - 1]! += theta * gOut * outerT;
      const Tnew = thomas(lower, diag, upper, rhs);
      let delta = 0;
      for (let i = 0; i < n; i++) delta = Math.max(delta, Math.abs(Tnew[i]! - Tn[i]!));
      Tn = Tnew;
      if (delta < 1e-10) break;
    }
    // bookkeeping for the energy balance (trapezoid in time of the outer-boundary heat, rectangle-consistent for the source)
    const post = conduction(Tn, Tn, b1);
    const outNew = post.gOut * (Tn[n - 1]! - outerT);
    const outOld = conduction(Told, Told, b0).gOut * (Told[n - 1]! - outerOf(b0));
    rejected += o.dt * (scheme === "crank-nicolson" ? 0.5 * (outNew + outOld) : outNew);
    deposited += o.dt * (scheme === "crank-nicolson" ? 0.5 * (q0 + q1) : qs);
    T = Tn;
    if (trace) {
      let peak = -Infinity;
      let fuelHot = -Infinity;
      let cladHot = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = T[i]!;
        if (x > peak) peak = x;
        if (i < nf) {
          if (x < trace.fuelMin) trace.fuelMin = x;
          if (x > trace.fuelMax) trace.fuelMax = x;
          if (x > fuelHot) fuelHot = x;
        } else {
          if (x < trace.claddingMin) trace.claddingMin = x;
          if (x > trace.claddingMax) trace.claddingMax = x;
          if (x > cladHot) cladHot = x;
        }
      }
      trace.peakByStep.push(peak);
      trace.fuelByStep.push(fuelHot);
      trace.claddingByStep.push(cladHot);
    }
    if (step % o.outputEvery === 0) states.push({ time: t1, T: T.slice(), deposited, rejected, wall: wallOf(T, b1) });
  }
  return { r, states, ...(trace ? { trace } : {}) };
}

/** Energy stored in the solids relative to the initial state (a uniform temperature, or the initial temperature of every cell), J per unit length. */
export function storedEnergy(p: TransientPin, T: number[], initial: number | number[]): number {
  const T0 = (i: number) => (typeof initial === "number" ? initial : initial[i]!);
  const nf = p.fuelCells;
  const nc = p.claddingCells;
  const faces: number[] = [];
  for (let i = 0; i <= nf; i++) faces.push(p.fuelInnerRadius + ((p.fuelRadius - p.fuelInnerRadius) * i) / nf);
  const cfaces: number[] = [];
  for (let i = 0; i <= nc; i++) cfaces.push(p.claddingInnerRadius + ((p.claddingOuterRadius - p.claddingInnerRadius) * i) / nc);
  const geo = geometryOf(p.slab);
  let e = 0;
  for (let i = 0; i < nf; i++) e += geo.volume(faces[i]!, faces[i + 1]!) * (enthalpyOf(p, true, T[i]!) - enthalpyOf(p, true, T0(i)));
  for (let i = 0; i < nc; i++) e += geo.volume(cfaces[i]!, cfaces[i + 1]!) * (enthalpyOf(p, false, T[nf + i]!) - enthalpyOf(p, false, T0(nf + i)));
  return e;
}

/**
 * The steady temperature field of the pin at a constant linear heat rate: the cell values (fuel inner to outer, then cladding inner to
 * outer) and the outer wall, from the same discretisation as the transient solution, which therefore holds it exactly. It is one
 * implicit step of effectively infinite length (the heat capacity term vanishes), iterated for a temperature-dependent conductivity.
 * Refuses, with the reason, a field it cannot trust: the iteration not settled, a conductivity not positive at the result, or the
 * field that another iteration still moves.
 */
export function steadyFv(p: TransientPin, qPrime: number): { T: number[]; wall: number } {
  if (!(qPrime >= 0) || !Number.isFinite(qPrime)) throw new RangeError("the steady linear heat rate must be a finite number, zero or more");
  const outer = p.boundary.kind === "convective" ? p.boundary.bulkTemperature : p.boundary.surfaceTemperature;
  const dt = 1e30;
  const stat = { ...p, boundaryAt: undefined, power: () => qPrime };
  const run = solveTransientFv(stat, { dt, steps: 1, initialTemperature: outer, outputEvery: 1 });
  const s = run.states[1]!;
  if (!s.T.every((x) => Number.isFinite(x) && x > 0)) throw new RangeError("the iteration for the steady state ended with a temperature that is not finite and above 0 K; a conductivity law that falls too far at this heat rate is the usual cause");
  const nf = p.fuelCells;
  s.T.forEach((x, i) => {
    const k = conductivityOf(p, i < nf, x);
    if (!(k > 0)) throw new RangeError("the conductivity of the " + (i < nf ? "fuel" : "cladding") + " is not positive at " + x.toFixed(0) + " K, so there is no steady state at this heat rate");
  });
  // Every linear solve conserves energy whether or not the conductivity iteration has settled, so the heat balance proves nothing here. A settled field is a fixed
  // point: one more step of the same problem from it must not move it.
  const again = solveTransientFv(stat, { dt, steps: 1, initialField: s.T, outputEvery: 1 }).states[1]!;
  const moved = Math.max(...again.T.map((x, i) => Math.abs(x - s.T[i]!)));
  if (!(moved <= 1e-6)) throw new RangeError("the steady state did not settle: another iteration still moves it by " + moved.toPrecision(3) + " K");
  return { T: s.T, wall: s.wall };
}
