// A two-dimensional finite-volume solution of an axial stack (plan 15, B1): the radial cells of transientFv.ts (the same cells, the same node positions, the same conductances
// through the geometry kernel of geometry.ts) in each of N layers, joined along the height by the conduction between layers of the same solid. Not OFFBEAT: a second method,
// written without reference to the solver, used as the reference that the stack's checks compare the solver's fields with (plan 15), so that the heat that flows along the
// height is in the reference instead of in an allowance. Steady, and transient (implicit Euler, the scheme OFFBEAT uses).
//
// Unknowns: the temperature of cell i of layer k, at id = k n + i (n cells per layer, fuel then cladding, inner to outer). Per layer: the radial conduction and the gap and the
// coolant side of transientFv; between layer k and k+1, for each cell, two half cells in series, k_a k_b / (k_a + k_b) * 2 A / h, the end layers' outer faces insulated, A the
// cell's cross-section (geo.volume: an annulus, or a strip of one metre width), h the layer height. The source of a layer is uniform in it, at the value the case gives at the
// layer's centre, and so is its coolant. The matrix is banded (half bandwidth n) and solved directly, without pivoting: it is an M-matrix (diagonally dominant with
// non-positive off-diagonals). Picard iteration for conductivity and heat capacity that depend on temperature, in the enthalpy form of transientFv so that the stored energy is exact.
//
// Used for plates (plan 15, owner's decision after B0). Nothing here is specific to a plate: the geometry comes from `pin.slab`, so a pin would go through the same code.

import type { BoundaryValue } from "./boundaryHistory";
import { degree } from "./conductivity";
import { geometryOf } from "./geometry";
import { FvTrace, TransientPin, capacityOf, conductivityOf, enthalpyOf } from "./transientFv";

export interface StackModel {
  /** The radial cells, the gap, the properties and the geometry of every layer (its own `boundary`, `boundaryAt` and `power` are not used: they are per layer here). */
  pin: TransientPin;
  layers: number;
  /** The heated height (m): the layers divide it equally. */
  height: number;
  /** The heat rate of a layer at time t (W per metre of pin, or per metre of height and width of a plate): constant over the layer. */
  power: (layer: number, t: number) => number;
  /** The coolant side of a layer at time t; the value of the END of a step is the one an implicit step uses. */
  boundary: (layer: number, t: number) => BoundaryValue;
  /** Conduction between layers. False gives N separate one-dimensional solutions (the reference the plan replaces); true by default. */
  axialConduction?: boolean;
  /** The source fills every cell, not only the fuel (for the exact solution of a single material; not used by a case). */
  heatAllCells?: boolean;
}

export interface StackSteady {
  /** Cells per layer, and the node radii (m) of one layer: fuel then cladding, inner to outer. */
  n: number;
  r: number[];
  /** Temperature of cell i of layer k at k n + i. */
  T: Float64Array;
  /** Outer wall temperature of each layer (between the last cell and the coolant). */
  wall: Float64Array;
  /** Heat leaving each layer through its coolant side (W, per metre of width for a plate), and the heat made in it. */
  out: Float64Array;
  made: Float64Array;
  /** Heat flowing from layer k to layer k+1 through the solids, summed over the cells (W): N - 1 values, zero when the conduction is off. */
  axial: Float64Array;
  deposited: number;
  rejected: number;
}

export interface StackState {
  time: number;
  T: Float64Array;
  wall: Float64Array;
  /** Energy deposited, rejected through the coolant sides, and stored in the solids since the start (J, per metre of width for a plate), summed over the layers. */
  deposited: number;
  rejected: number;
  stored: number;
  /** The same, layer by layer, and the heat each layer has received from its neighbours along the height since the start (J; the sum over the layers is zero): per layer, deposited + axialIn = stored + rejected. */
  layerDeposited: Float64Array;
  layerRejected: Float64Array;
  layerStored: Float64Array;
  layerAxialIn: Float64Array;
}

export interface StackTransientOptions {
  dt: number;
  steps: number;
  outputEvery: number;
  /** The temperature of every cell at t = 0, layer by layer. */
  initial: ArrayLike<number>;
  /** Also record, at every step, each layer's hottest cell and the extremes of each solid, as transientFv does for a slice. */
  trace?: boolean;
  /** Stop with a RangeError after this many milliseconds of wall-clock time (a caller with its own fallback sets it). */
  deadlineMs?: number;
}

export interface StackTransient {
  n: number;
  r: number[];
  states: StackState[];
  /** One per layer when `trace` was asked for. */
  traces?: FvTrace[];
}

/** The most unknowns a stack reference solves (layers x cells per layer), and the most of layers x cells x cells (the work of one banded solve): a stack beyond either is not solved. */
export const STACK_UNKNOWNS_MAX = 20000;
export const STACK_BAND_WORK_MAX = 5e7;
/** The largest change of any cell between two Picard iterations that counts as settled (K), and the iterations allowed. */
export const PICARD_TOLERANCE = 1e-10;
export const PICARD_ITERATIONS = 200;

/** Banded solve without pivoting, in place: `a` holds row i at i w + (j - i + m) for w = 2 m + 1, `b` is overwritten. */
function solveBanded(a: Float64Array, b: Float64Array, n: number, m: number): Float64Array {
  const w = 2 * m + 1;
  for (let p = 0; p < n; p++) {
    const piv = a[p * w + m]!;
    if (!(piv > 0)) throw new RangeError("the stack's matrix has a pivot that is not positive; a conductivity or a heat capacity is not positive");
    const rEnd = Math.min(n - 1, p + m);
    for (let r = p + 1; r <= rEnd; r++) {
      const f = a[r * w + (p - r + m)]! / piv;
      if (f === 0) continue;
      for (let c = p; c <= rEnd; c++) a[r * w + (c - r + m)]! -= f * a[p * w + (c - p + m)]!;
      b[r]! -= f * b[p]!;
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    const cEnd = Math.min(n - 1, i + m);
    for (let j = i + 1; j <= cEnd; j++) s -= a[i * w + (j - i + m)]! * x[j]!;
    x[i] = s / a[i * w + m]!;
  }
  return x;
}

const coolantOf = (b: BoundaryValue): number => (b.kind === "convective" ? b.bulkTemperature : b.surfaceTemperature);

/** True when a property of the pin does not depend on temperature, so one linear solve is the answer. */
function propertiesConstant(p: TransientPin, transient: boolean): boolean {
  const k = (law: TransientPin["fuelLaw"], lin: { b: number }) => (law ? Array.isArray(law) && degree(law) === 0 : lin.b === 0);
  const c = (law: TransientPin["fuelCLaw"], lin: { b: number }) => (law ? degree(law) === 0 : lin.b === 0);
  return k(p.fuelLaw, p.fuelK) && k(p.claddingLaw, p.claddingK) && (!transient || (c(p.fuelCLaw, p.fuelC) && c(p.claddingCLaw, p.claddingC)));
}

function system(m: StackModel, transient: boolean) {
  const p = m.pin;
  const N = m.layers;
  if (!Number.isInteger(N) || N < 1) throw new RangeError("a stack has a whole number of layers, at least 1");
  if (!(m.height > 0) || !Number.isFinite(m.height)) throw new RangeError("the heated height must be a positive finite number");
  const nf = p.fuelCells;
  const nc = p.claddingCells;
  const n = nf + nc;
  const rows = N * n;
  if (rows > STACK_UNKNOWNS_MAX || N * n * n > STACK_BAND_WORK_MAX) throw new RangeError(`the stack has ${rows} unknowns (${N} layers x ${n} cells); the two-dimensional solution is limited to ${STACK_UNKNOWNS_MAX} unknowns`);
  const h = m.height / N;
  const geo = geometryOf(p.slab);
  const coupled = m.axialConduction !== false;
  // the cells of one layer, as transientFv lays them out: equal in radius within a solid, nodes in the middle of the cell
  const faces: number[] = [];
  for (let i = 0; i <= nf; i++) faces.push(p.fuelInnerRadius + ((p.fuelRadius - p.fuelInnerRadius) * i) / nf);
  const cfaces: number[] = [];
  for (let i = 0; i <= nc; i++) cfaces.push(p.claddingInnerRadius + ((p.claddingOuterRadius - p.claddingInnerRadius) * i) / nc);
  const r: number[] = [];
  for (let i = 0; i < nf; i++) r.push(0.5 * (faces[i]! + faces[i + 1]!));
  for (let i = 0; i < nc; i++) r.push(0.5 * (cfaces[i]! + cfaces[i + 1]!));
  const vol: number[] = [];
  for (let i = 0; i < nf; i++) vol.push(geo.volume(faces[i]!, faces[i + 1]!));
  for (let i = 0; i < nc; i++) vol.push(geo.volume(cfaces[i]!, cfaces[i + 1]!));
  const fuelVol = geo.volume(p.fuelInnerRadius, p.fuelRadius);
  const totalVol = vol.reduce((x, y) => x + y, 0);
  const share = vol.map((v, i) => (m.heatAllCells ? v / totalVol : i < nf ? v / fuelVol : 0));
  const kOf = (i: number, T: number) => conductivityOf(p, i < nf, T);
  const constant = propertiesConstant(p, transient);

  /** Radial conductances (W/K per unit height) of one layer at the conductivities kv, and the outer conductance to the coolant. */
  const radial = (kv: Float64Array, off: number, b: BoundaryValue) => {
    const g = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      if (i !== nf - 1) g[i] = geo.conductance(r[i]!, r[i + 1]!, 0.5 * (kv[off + i]! + kv[off + i + 1]!));
      else {
        const rF = geo.resist(r[i]!, p.fuelRadius, kv[off + i]!);
        const rGap = 1 / (geo.area(p.fuelRadius) * p.gapConductance);
        const rC = geo.resist(p.claddingInnerRadius, r[i + 1]!, kv[off + i + 1]!);
        g[i] = 1 / (rF + rGap + rC);
      }
    }
    const kl = kv[off + n - 1]!;
    const rHalf = geo.resist(r[n - 1]!, p.claddingOuterRadius, kl);
    if (b.kind === "convective") return { g, gOut: 1 / (rHalf + 1 / (geo.area(p.claddingOuterRadius) * b.heatTransferCoefficient)) };
    return { g, gOut: 1 / rHalf };
  };

  const w2 = 2 * n + 1;
  const at = (i: number, j: number) => i * w2 + (j - i + n);
  const A = new Float64Array(rows * w2);
  const rhs = new Float64Array(rows);
  const kv = new Float64Array(rows);

  interface Side {
    gOut: number;
    cool: number;
  }
  /** One linear solve about the iterate Tn (conductivities and capacities taken there); Told is the previous time level, dt the step (null: steady). */
  const step = (Tn: Float64Array, Told: Float64Array | null, dt: number | null, qs: number[], bs: BoundaryValue[]) => {
    A.fill(0);
    rhs.fill(0);
    for (let id = 0; id < rows; id++) kv[id] = kOf(id % n, Tn[id]!);
    const sides: Side[] = [];
    for (let k = 0; k < N; k++) {
      const b = bs[k]!;
      const off = k * n;
      const { g, gOut } = radial(kv, off, b);
      sides.push({ gOut, cool: coolantOf(b) });
      for (let i = 0; i < n; i++) {
        const id = off + i;
        if (dt !== null) {
          // enthalpy change over the step, linearised about the iterate: dH = H(Tn) - H(Told) + c(Tn) (Tnew - Tn)
          const fuel = i < nf;
          const Cdt = (h * vol[i]! * capacityOf(p, fuel, Tn[id]!)) / dt;
          A[at(id, id)]! += Cdt;
          rhs[id]! += Cdt * Tn[id]! - (h * vol[i]! * (enthalpyOf(p, fuel, Tn[id]!) - enthalpyOf(p, fuel, Told![id]!))) / dt;
        }
        rhs[id]! += h * share[i]! * qs[k]!;
        if (i < n - 1) {
          const gi = h * g[i]!;
          A[at(id, id)]! += gi;
          A[at(id + 1, id + 1)]! += gi;
          A[at(id, id + 1)]! -= gi;
          A[at(id + 1, id)]! -= gi;
        }
        if (coupled && k < N - 1) {
          // two half cells in series: the conductivity of each side over half the layer height
          const ka = kv[id]!;
          const kb = kv[id + n]!;
          const gz = ((2 * ka * kb) / (ka + kb)) * (vol[i]! / h);
          A[at(id, id)]! += gz;
          A[at(id + n, id + n)]! += gz;
          A[at(id, id + n)]! -= gz;
          A[at(id + n, id)]! -= gz;
        }
      }
      const last = off + n - 1;
      A[at(last, last)]! += h * gOut;
      rhs[last]! += h * gOut * coolantOf(b);
    }
    return { x: solveBanded(A, rhs, rows, n), sides };
  };

  /** Picard iteration to the field that satisfies the step's equations with the properties at itself. */
  const converge = (Tstart: Float64Array, Told: Float64Array | null, dt: number | null, qs: number[], bs: BoundaryValue[]) => {
    let Tn: Float64Array = Float64Array.from(Tstart);
    for (let iter = 0; iter < PICARD_ITERATIONS; iter++) {
      const res = step(Tn, Told, dt, qs, bs);
      let delta = 0;
      for (let id = 0; id < rows; id++) delta = Math.max(delta, Math.abs(res.x[id]! - Tn[id]!));
      Tn = res.x;
      if (constant || delta < PICARD_TOLERANCE) {
        if (!Tn.every((x) => Number.isFinite(x) && x > 0)) throw new RangeError("the stack's field has a temperature that is not finite and above 0 K; a conductivity law that falls too far at this heat rate is the usual cause");
        return { T: Tn, sides: res.sides };
      }
    }
    throw new RangeError(`the iteration for the stack's temperature-dependent properties did not settle in ${PICARD_ITERATIONS} iterations`);
  };

  /** The outer wall temperature of every layer, the conductivity of the last cell taken at the field. */
  const wallsOf = (T: Float64Array, bs: BoundaryValue[]) => {
    const w = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const b = bs[k]!;
      if (b.kind !== "convective") w[k] = b.surfaceTemperature;
      else {
        const Tl = T[k * n + n - 1]!;
        const gHalf = geo.conductance(r[n - 1]!, p.claddingOuterRadius, kOf(n - 1, Tl));
        const gFilm = geo.area(p.claddingOuterRadius) * b.heatTransferCoefficient;
        w[k] = (gHalf * Tl + gFilm * b.bulkTemperature) / (gHalf + gFilm);
      }
    }
    return w;
  };
  const outOf = (T: Float64Array, sides: Side[]) => Float64Array.from(sides, (s, k) => h * s.gOut * (T[k * n + n - 1]! - s.cool));
  const storedOf = (T: Float64Array, T0: ArrayLike<number>) => {
    let e = 0;
    for (let id = 0; id < rows; id++) e += h * vol[id % n]! * (enthalpyOf(p, id % n < nf, T[id]!) - enthalpyOf(p, id % n < nf, T0[id]!));
    return e;
  };
  /** The heat flowing from layer k to layer k + 1 through the solids (W), summed over the cells, at the conductivities of the field T; N - 1 values, zero with the conduction off. */
  const axialFlux = (T: Float64Array) => {
    const f = new Float64Array(Math.max(0, N - 1));
    if (coupled)
      for (let k = 0; k < N - 1; k++)
        for (let i = 0; i < n; i++) {
          const ka = kOf(i, T[k * n + i]!);
          const kb = kOf(i, T[(k + 1) * n + i]!);
          f[k]! += ((2 * ka * kb) / (ka + kb)) * (vol[i]! / h) * (T[k * n + i]! - T[(k + 1) * n + i]!);
        }
    return f;
  };
  const storedLayers = (T: Float64Array, T0: ArrayLike<number>) => {
    const e = new Float64Array(N);
    for (let id = 0; id < rows; id++) e[Math.floor(id / n)]! += h * vol[id % n]! * (enthalpyOf(p, id % n < nf, T[id]!) - enthalpyOf(p, id % n < nf, T0[id]!));
    return e;
  };
  return { n, nf, rows, h, N, r, vol, kOf, converge, wallsOf, outOf, storedOf, storedLayers, axialFlux, coupled };
}

/**
 * The steady field of the stack: the equations of the transient with the heat capacity term gone (one step of infinite length), at the powers and the coolants of t = 0, iterated
 * for properties that depend on temperature. Refuses, with the reason, a field it cannot trust (the iteration not settled, a temperature not finite and above 0 K).
 */
export function solveStackSteady(m: StackModel): StackSteady {
  const s = system(m, false);
  const qs = Array.from({ length: s.N }, (_, k) => m.power(k, 0));
  const bs = Array.from({ length: s.N }, (_, k) => m.boundary(k, 0));
  if (!qs.every((q) => Number.isFinite(q))) throw new RangeError("the layers' heat rates must be finite numbers");
  const start = new Float64Array(s.rows).fill(coolantOf(bs[0]!));
  const { T, sides } = s.converge(start, null, null, qs, bs);
  for (let id = 0; id < s.rows; id++) if (!(s.kOf(id % s.n, T[id]!) > 0)) throw new RangeError(`the conductivity of the ${id % s.n < s.nf ? "fuel" : "cladding"} is not positive at ${T[id]!.toFixed(0)} K, so there is no steady state at this heat rate`);
  const out = s.outOf(T, sides);
  const made = Float64Array.from(qs, (q) => s.h * q);
  const axial = s.axialFlux(T);
  return { n: s.n, r: s.r, T, wall: s.wallsOf(T, bs), out, made, axial, deposited: made.reduce((x, y) => x + y, 0), rejected: out.reduce((x, y) => x + y, 0) };
}

/** The transient of the stack from `initial`, implicit Euler with the powers and the coolants of the END of each step (as OFFBEAT and transientFv take them). */
export function solveStackTransient(m: StackModel, o: StackTransientOptions): StackTransient {
  const s = system(m, true);
  if (o.initial.length !== s.rows || !Array.from(o.initial).every((x) => Number.isFinite(x) && x > 0)) throw new Error(`initial needs ${s.rows} positive finite temperatures`);
  if (!(o.dt > 0) || !Number.isInteger(o.steps) || o.steps < 1 || !Number.isInteger(o.outputEvery) || o.outputEvery < 1) throw new RangeError("the transient needs a positive step, a whole number of steps and a whole number of steps between outputs");
  const T0 = Float64Array.from(o.initial);
  let T: Float64Array = Float64Array.from(T0);
  const N = s.N;
  const bs0 = Array.from({ length: N }, (_, k) => m.boundary(k, 0));
  const layerDeposited = new Float64Array(N);
  const layerRejected = new Float64Array(N);
  const layerAxialIn = new Float64Array(N);
  const zeros = () => new Float64Array(N);
  const states: StackState[] = [{ time: 0, T: Float64Array.from(T), wall: s.wallsOf(T, bs0), deposited: 0, rejected: 0, stored: 0, layerDeposited: zeros(), layerRejected: zeros(), layerStored: zeros(), layerAxialIn: zeros() }];
  const traces: FvTrace[] | undefined = o.trace ? Array.from({ length: N }, () => ({ peakByStep: [], fuelByStep: [], claddingByStep: [], fuelMin: Infinity, fuelMax: -Infinity, claddingMin: Infinity, claddingMax: -Infinity })) : undefined;
  const record = (field: Float64Array) => {
    if (!traces) return;
    for (let k = 0; k < N; k++) {
      const tr = traces[k]!;
      let fuelHot = -Infinity;
      let cladHot = -Infinity;
      for (let i = 0; i < s.n; i++) {
        const x = field[k * s.n + i]!;
        if (i < s.nf) {
          if (x < tr.fuelMin) tr.fuelMin = x;
          if (x > tr.fuelMax) tr.fuelMax = x;
          if (x > fuelHot) fuelHot = x;
        } else {
          if (x < tr.claddingMin) tr.claddingMin = x;
          if (x > tr.claddingMax) tr.claddingMax = x;
          if (x > cladHot) cladHot = x;
        }
      }
      tr.peakByStep.push(Math.max(fuelHot, cladHot));
      tr.fuelByStep.push(fuelHot);
      tr.claddingByStep.push(cladHot);
    }
  };
  record(T);
  const started = Date.now();
  let deposited = 0;
  let rejected = 0;
  for (let step = 1; step <= o.steps; step++) {
    if (o.deadlineMs !== undefined && Date.now() - started > o.deadlineMs) throw new RangeError(`the stack's transient did not finish in ${o.deadlineMs} ms (stopped at step ${step - 1} of ${o.steps})`);
    const t1 = step * o.dt;
    const qs = Array.from({ length: N }, (_, k) => m.power(k, t1));
    const bs = Array.from({ length: N }, (_, k) => m.boundary(k, t1));
    const res = s.converge(T, T, o.dt, qs, bs);
    const out = s.outOf(res.T, res.sides);
    const flux = s.axialFlux(res.T);
    for (let k = 0; k < N; k++) {
      layerDeposited[k]! += o.dt * s.h * qs[k]!;
      layerRejected[k]! += o.dt * out[k]!;
      layerAxialIn[k]! += o.dt * ((k > 0 ? flux[k - 1]! : 0) - (k < N - 1 ? flux[k]! : 0));
    }
    deposited += o.dt * s.h * qs.reduce((x, y) => x + y, 0);
    rejected += o.dt * out.reduce((x, y) => x + y, 0);
    T = res.T;
    record(T);
    if (step % o.outputEvery === 0) states.push({ time: t1, T: Float64Array.from(T), wall: s.wallsOf(T, bs), deposited, rejected, stored: s.storedOf(T, T0), layerDeposited: Float64Array.from(layerDeposited), layerRejected: Float64Array.from(layerRejected), layerStored: s.storedLayers(T, T0), layerAxialIn: Float64Array.from(layerAxialIn) });
  }
  return { n: s.n, r: s.r, states, ...(traces ? { traces } : {}) };
}
