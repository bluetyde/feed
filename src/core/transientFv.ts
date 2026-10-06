// An independent time-dependent finite-volume solution of the pin (plan 08). Not OFFBEAT: a second method, written without any
// reference to the solver, used to (1) check OFFBEAT's transient result at run time, and (2) estimate the time-stepping error by
// running the same case at half the step. It is validated against exact solutions in tests/transientFv.test.ts.
//
// Cell-centred, one dimension (radius), per unit length. Fuel (solid or annular with an insulated hole), a gap that is one
// conductance at the fuel radius, cladding, and an outer boundary that is convective or a fixed temperature. Implicit Euler
// (the scheme OFFBEAT uses) or Crank-Nicolson, Picard iteration for temperature-dependent conductivity and heat capacity.
// Heat capacity c(T) = a + b T is handled through the enthalpy H(T) = a T + b T^2 / 2, so stored energy is conserved exactly.

const TWO_PI = 2 * Math.PI;

export interface Linear {
  a: number;
  b: number;
}

export interface TransientPin {
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
  fuelC: Linear;
  claddingC: Linear;
  boundary: { kind: "convective"; bulkTemperature: number; heatTransferCoefficient: number } | { kind: "surface-temperature"; surfaceTemperature: number };
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

export const enthalpy = (c: Linear, T: number) => c.a * T + 0.5 * c.b * T * T;

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
  // cell volume per unit length of the full cylinder: pi (r_out^2 - r_in^2)
  const vol: number[] = [];
  for (let i = 0; i < nf; i++) vol.push(Math.PI * (faces[i + 1]! ** 2 - faces[i]! ** 2));
  for (let i = 0; i < nc; i++) vol.push(Math.PI * (cfaces[i + 1]! ** 2 - cfaces[i]! ** 2));
  const fuelArea = Math.PI * (p.fuelRadius ** 2 - p.fuelInnerRadius ** 2);
  const share: number[] = vol.map((v, i) => (i < nf ? v / fuelArea : 0));
  const cap = (i: number): Linear => (i < nf ? p.fuelC : p.claddingC);
  const kOf = (i: number, T: number) => (i < nf ? p.fuelK.a + p.fuelK.b * T : p.claddingK.a + p.claddingK.b * T);

  /** Conductances (W/K per unit length) between cell i and i+1 and to the outside, at temperatures T. */
  const conductances = (T: number[]) => {
    const g: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      if (i !== nf - 1) {
        const k = 0.5 * (kOf(i, T[i]!) + kOf(i + 1, T[i + 1]!));
        g.push((TWO_PI * k) / Math.log(r[i + 1]! / r[i]!));
      } else {
        const rF = Math.log(p.fuelRadius / r[i]!) / (TWO_PI * kOf(i, T[i]!));
        const rGap = 1 / (TWO_PI * p.fuelRadius * p.gapConductance);
        const rC = Math.log(r[i + 1]! / p.claddingInnerRadius) / (TWO_PI * kOf(i + 1, T[i + 1]!));
        g.push(1 / (rF + rGap + rC));
      }
    }
    const rHalf = Math.log(p.claddingOuterRadius / r[n - 1]!) / (TWO_PI * kOf(n - 1, T[n - 1]!));
    const gOut = p.boundary.kind === "convective" ? 1 / (rHalf + 1 / (TWO_PI * p.claddingOuterRadius * p.boundary.heatTransferCoefficient)) : 1 / rHalf;
    return { g, gOut };
  };
  const outerT = p.boundary.kind === "convective" ? p.boundary.bulkTemperature : p.boundary.surfaceTemperature;

  /** Net heat flowing into each cell from conduction at temperatures T (W per unit length), with conductances taken at `Tk`. */
  const conduction = (T: number[], Tk: number[]) => {
    const { g, gOut } = conductances(Tk);
    const f = new Array<number>(n).fill(0);
    for (let i = 0; i < n - 1; i++) {
      const q = g[i]! * (T[i + 1]! - T[i]!);
      f[i]! += q;
      f[i + 1]! -= q;
    }
    f[n - 1]! += gOut * (outerT - T[n - 1]!);
    return { f, gOut };
  };

  /** Temperature of the outer boundary of the cladding, between the last cell and the coolant. */
  const wallOf = (Tc: number[]) => {
    if (p.boundary.kind !== "convective") return outerT;
    const gHalf = (TWO_PI * kOf(n - 1, Tc[n - 1]!)) / Math.log(p.claddingOuterRadius / r[n - 1]!);
    const gFilm = TWO_PI * p.claddingOuterRadius * p.boundary.heatTransferCoefficient;
    return (gHalf * Tc[n - 1]! + gFilm * p.boundary.bulkTemperature) / (gHalf + gFilm);
  };
  if ((o.initialTemperature === undefined) === (o.initialField === undefined)) throw new Error("give exactly one of initialTemperature and initialField");
  if (o.initialField !== undefined && (o.initialField.length !== n || !o.initialField.every((x) => Number.isFinite(x) && x > 0))) throw new Error("initialField needs " + n + " positive finite temperatures");
  let T = o.initialField !== undefined ? o.initialField.slice() : new Array<number>(n).fill(o.initialTemperature!);
  const states: FvState[] = [{ time: 0, T: T.slice(), deposited: 0, rejected: 0, wall: wallOf(T) }];
  const trace: FvTrace | undefined = o.trace ? { peakByStep: [maxOf(T)], fuelMin: minOf(T.slice(0, nf)), fuelMax: maxOf(T.slice(0, nf)), claddingMin: minOf(T.slice(nf)), claddingMax: maxOf(T.slice(nf)) } : undefined;
  let deposited = 0;
  let rejected = 0;
  for (let step = 1; step <= o.steps; step++) {
    const t0 = (step - 1) * o.dt;
    const t1 = step * o.dt;
    const q1 = p.power(t1);
    const q0 = p.power(t0);
    const qs = scheme === "implicit-euler" && sourceMode === "average" ? 0.5 * (q0 + q1) : q1;
    const Told = T;
    // explicit part for Crank-Nicolson: half of the old conduction and old source
    const old = scheme === "crank-nicolson" ? conduction(Told, Told) : null;
    const theta = scheme === "crank-nicolson" ? 0.5 : 1;
    let Tn = Told.slice();
    for (let iter = 0; iter < 100; iter++) {
      const { g, gOut } = conductances(Tn);
      const lower = new Array<number>(n).fill(0);
      const diag = new Array<number>(n).fill(0);
      const upper = new Array<number>(n).fill(0);
      const rhs = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        // enthalpy change over the step, linearised about the iterate: dH = H(Tn) - H(Told) + c(Tn) (Tnew - Tn)
        const cc = cap(i);
        const cTn = cc.a + cc.b * Tn[i]!;
        const Cdt = (vol[i]! * cTn) / o.dt;
        diag[i] = Cdt;
        rhs[i] = Cdt * Tn[i]! - (vol[i]! * (enthalpy(cc, Tn[i]!) - enthalpy(cc, Told[i]!))) / o.dt;
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
    const post = conduction(Tn, Tn);
    const outNew = post.gOut * (Tn[n - 1]! - outerT);
    const outOld = conduction(Told, Told).gOut * (Told[n - 1]! - outerT);
    rejected += o.dt * (scheme === "crank-nicolson" ? 0.5 * (outNew + outOld) : outNew);
    deposited += o.dt * (scheme === "crank-nicolson" ? 0.5 * (q0 + q1) : qs);
    T = Tn;
    if (trace) {
      let peak = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = T[i]!;
        if (x > peak) peak = x;
        if (i < nf) {
          if (x < trace.fuelMin) trace.fuelMin = x;
          if (x > trace.fuelMax) trace.fuelMax = x;
        } else {
          if (x < trace.claddingMin) trace.claddingMin = x;
          if (x > trace.claddingMax) trace.claddingMax = x;
        }
      }
      trace.peakByStep.push(peak);
    }
    if (step % o.outputEvery === 0) states.push({ time: t1, T: T.slice(), deposited, rejected, wall: wallOf(T) });
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
  let e = 0;
  for (let i = 0; i < nf; i++) e += Math.PI * (faces[i + 1]! ** 2 - faces[i]! ** 2) * (enthalpy(p.fuelC, T[i]!) - enthalpy(p.fuelC, T0(i)));
  for (let i = 0; i < nc; i++) e += Math.PI * (cfaces[i + 1]! ** 2 - cfaces[i]! ** 2) * (enthalpy(p.claddingC, T[nf + i]!) - enthalpy(p.claddingC, T0(nf + i)));
  return e;
}

/**
 * The steady temperature field of the pin at a constant linear heat rate: the cell values (fuel inner to outer, then cladding inner to
 * outer) and the outer wall, from the same discretisation as the transient solution, which therefore holds it exactly. It is one
 * implicit step of effectively infinite length (the heat capacity term vanishes), iterated for a temperature-dependent conductivity.
 * Refuses, with the reason, a field it cannot trust: the iteration not settled, a conductivity not positive at the result, or the
 * heat leaving not equal to the heat made.
 */
export function steadyFv(p: TransientPin, qPrime: number): { T: number[]; wall: number } {
  if (!(qPrime >= 0) || !Number.isFinite(qPrime)) throw new RangeError("the steady linear heat rate must be a finite number, zero or more");
  const outer = p.boundary.kind === "convective" ? p.boundary.bulkTemperature : p.boundary.surfaceTemperature;
  const dt = 1e30;
  const run = solveTransientFv({ ...p, power: () => qPrime }, { dt, steps: 1, initialTemperature: outer, outputEvery: 1 });
  const s = run.states[1]!;
  if (!s.T.every((x) => Number.isFinite(x) && x > 0)) throw new RangeError("the iteration for the steady state ended with a temperature that is not finite and above 0 K; a conductivity law that falls too far at this heat rate is the usual cause");
  const nf = p.fuelCells;
  s.T.forEach((x, i) => {
    const k = i < nf ? p.fuelK.a + p.fuelK.b * x : p.claddingK.a + p.claddingK.b * x;
    if (!(k > 0)) throw new RangeError("the conductivity of the " + (i < nf ? "fuel" : "cladding") + " is not positive at " + x.toFixed(0) + " K, so there is no steady state at this heat rate");
  });
  const out = s.rejected / dt;
  const made = s.deposited / dt;
  if (!(Math.abs(out - made) <= 1e-7 * Math.max(made, 1))) throw new RangeError("the steady state did not settle: " + out + " W/m leaves, " + made + " W/m is made");
  return { T: s.T, wall: s.wall };
}
