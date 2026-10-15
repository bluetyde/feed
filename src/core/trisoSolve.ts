// The independent solutions of a coated particle (plan 13, T2): a second method, written without any reference to OFFBEAT, for the sphere of docs/triso.md. Four things:
//
//   1. `trisoClosedForm`: the steady temperatures of the particle in closed form (the conductivity integral of each shell, the kernel's parabola, the gap's and the film's drops).
//   2. `solveTrisoFv` and `steadyTrisoFv`: a cell-centred finite-volume solution, steady or time-dependent, for any number of regions, with a temperature-dependent conductivity and
//      heat capacity, a gap of one conductance between the buffer and the next layer, and a convective or fixed outside. The same scheme as the pin's (transientFv.ts): implicit
//      Euler or Crank-Nicolson, Picard iteration, heat capacity through the enthalpy so that stored energy is conserved exactly.
//   3. `trisoTimeScale` and `trisoSteadyEndTime`: the Elmore bound on the slowest time constant and the end time a steady run needs (the same argument as steadyState.ts).
//   4. `trisoQuickLook`: what the editor shows beside the case (the closed form, the layer by layer drops, the power per particle) and the out-of-domain check on it.
//
// Every quantity is for the whole sphere: W, J, m3 (src/core/geometry.ts, SPHERE).

import { Law, evaluate, lawOf, primitive, rangeOf, solveHot } from "./conductivity";
import { SPHERE } from "./geometry";
import { MAX_STEADY_END_TIME, MIN_STEADY_END_TIME, STEADY_PSEUDO_HEAT_CAPACITY, STEADY_TOLERANCE, SteadyHorizon, TAU_SAFETY, lowestConductivity } from "./steadyState";
import type { NormalizedTriso, TrisoLayerName } from "./triso";
import type { Conductivity } from "./validate";

const FOUR_PI = 4 * Math.PI;

export type TrisoRegionName = "kernel" | TrisoLayerName;

// ---- 1. the closed form

export interface TrisoRegionTemperatures {
  name: TrisoRegionName;
  innerRadius: number;
  outerRadius: number;
  /** The temperature at the region's inner and outer face (the kernel's inner face is its centre). */
  innerT: number;
  outerT: number;
}

export interface TrisoClosedForm {
  /** The film's drop (0 for a prescribed wall) and the wall's temperature, the outer face of the last layer. */
  filmDeltaT: number;
  wallT: number;
  /** The drop across the gap between the buffer and the next layer, at the buffer's outer radius. */
  gapDeltaT: number;
  /** The kernel's surface and centre temperatures. */
  kernelSurfaceT: number;
  centreT: number;
  /** Kernel first, then the layers outward. */
  regions: TrisoRegionTemperatures[];
  /** The temperature at radius r inside the particle (0 to the outer radius); at the gap's radius it is the buffer's side. */
  temperatureAt(r: number): number;
}

/**
 * The steady temperatures of the particle. The heat made in the kernel, P, crosses a sphere of radius r whatever r is (outside the kernel), so in a shell of conductivity k(T)
 * the conductivity integral from the shell's outer face to r is P (1/r - 1/b) / (4 pi); inside the kernel the heat that crosses r is q''' 4/3 pi r^3, so the integral from r to
 * the kernel's surface is q''' (R^2 - r^2) / 6. The gap drops P / (4 pi R_g^2 h) at the buffer's outer radius, the film P / (4 pi R_o^2 h_film).
 */
export function trisoClosedForm(n: NormalizedTriso): TrisoClosedForm {
  const P = n.power.particlePower;
  const qv = n.power.kernelPowerDensity;
  const Ro = n.outerRadius;
  const filmDeltaT = n.boundary.kind === "convective" ? P / (SPHERE.area(Ro) * n.boundary.heatTransferCoefficient) : 0;
  const wallT = n.boundary.kind === "convective" ? n.boundary.bulkTemperature + filmDeltaT : n.boundary.surfaceTemperature;
  const gapRadius = n.layers[0]!.outerRadius;
  const gapDeltaT = P / (SPHERE.area(gapRadius) * n.gapConductance);
  const faces: { outerT: number; innerT: number }[] = new Array(n.layers.length);
  let t = wallT;
  for (let i = n.layers.length - 1; i >= 0; i--) {
    const l = n.layers[i]!;
    if (i === 0) t += gapDeltaT; // the gap lies between the buffer (layer 0) and the layer after it: crossing it inward, the buffer's side is hotter
    const inner = solveHot(lawOf(l.conductivity), t, (P / FOUR_PI) * (1 / l.innerRadius - 1 / l.outerRadius));
    faces[i] = { outerT: t, innerT: inner };
    t = inner;
  }
  const kernelSurfaceT = t;
  const kLaw = lawOf(n.kernelConductivity);
  const kernelAt = (r: number) => solveHot(kLaw, kernelSurfaceT, (qv * (n.kernelRadius ** 2 - r * r)) / 6);
  const centreT = kernelAt(0);
  const regions: TrisoRegionTemperatures[] = [{ name: "kernel", innerRadius: 0, outerRadius: n.kernelRadius, innerT: centreT, outerT: kernelSurfaceT }];
  n.layers.forEach((l, i) => regions.push({ name: l.name, innerRadius: l.innerRadius, outerRadius: l.outerRadius, innerT: faces[i]!.innerT, outerT: faces[i]!.outerT }));
  const temperatureAt = (r: number): number => {
    if (!(r >= 0 && r <= Ro)) throw new RangeError("the radius " + r + " m is outside the particle (0 to " + Ro + " m)");
    if (r <= n.kernelRadius) return kernelAt(r);
    const i = n.layers.findIndex((l) => r <= l.outerRadius);
    const l = n.layers[i]!;
    return solveHot(lawOf(l.conductivity), faces[i]!.outerT, (P / FOUR_PI) * (1 / r - 1 / l.outerRadius));
  };
  return { filmDeltaT, wallT, gapDeltaT, kernelSurfaceT, centreT, regions, temperatureAt };
}

// ---- 2. the finite-volume solution

/** What the finite-volume solution needs of a particle: the regions (kernel first), a conductivity law and a volumetric heat capacity law (c0 + c1 T + c2 T^2) for each, the cells. */
export interface TrisoModel {
  kernelRadius: number;
  /** The outer radius of each layer, from the buffer outward. */
  layerOuterRadii: number[];
  /** Cells in the kernel, then in each layer. */
  cells: number[];
  /** A law per region, kernel first. */
  laws: Law[];
  /** A heat capacity law per region, kernel first; absent: the placeholder every steady run uses (src/core/steadyState.ts). */
  capacities?: (readonly number[])[];
  /** W/m2/K at the buffer's outer radius; Infinity is no gap resistance. */
  gapConductance: number;
  boundary: NormalizedTriso["boundary"];
  /** Heat made in the kernel at time t, W. */
  power: (t: number) => number;
}

export function trisoModelOf(n: NormalizedTriso, extra: { capacities?: (readonly number[])[]; power?: (t: number) => number } = {}): TrisoModel {
  return {
    kernelRadius: n.kernelRadius,
    layerOuterRadii: n.layers.map((l) => l.outerRadius),
    cells: n.cells,
    laws: [lawOf(n.kernelConductivity), ...n.layers.map((l) => lawOf(l.conductivity))],
    ...(extra.capacities ? { capacities: extra.capacities } : {}),
    gapConductance: n.gapConductance,
    boundary: n.boundary,
    power: extra.power ?? (() => n.power.particlePower),
  };
}

export interface TrisoFvOptions {
  dt: number;
  steps: number;
  /** Exactly one: a uniform temperature, or the temperature of every cell (kernel inner to outer, then each layer). */
  initialTemperature?: number;
  initialField?: number[];
  outputEvery: number;
  scheme?: "implicit-euler" | "crank-nicolson";
}

export interface TrisoFvState {
  time: number;
  T: number[];
  /** Heat made by the source so far, J, and heat that left through the outside so far, J. */
  deposited: number;
  rejected: number;
  /** The temperature at the outer face of the last layer. */
  wall: number;
}

export interface TrisoFv {
  /** Cell-centre radii (m), kernel first. */
  r: number[];
  /** Cell volumes (m3). */
  volume: number[];
  /** The region (0 = kernel, 1 = buffer, ...) of each cell. */
  region: number[];
  states: TrisoFvState[];
}

/** The cell faces of a region of n equal cells between a and b. */
const faceRadii = (a: number, b: number, n: number): number[] => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

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

export function solveTrisoFv(m: TrisoModel, o: TrisoFvOptions): TrisoFv {
  const nRegions = m.cells.length;
  if (m.laws.length !== nRegions || m.layerOuterRadii.length !== nRegions - 1) throw new Error("the model needs one law per region and one outer radius per layer");
  const caps = m.capacities ?? m.laws.map(() => [STEADY_PSEUDO_HEAT_CAPACITY]);
  const scheme = o.scheme ?? "implicit-euler";
  const bounds = [0, m.kernelRadius, ...m.layerOuterRadii];
  const faces: number[][] = m.cells.map((c, i) => faceRadii(bounds[i]!, bounds[i + 1]!, c));
  const r: number[] = [];
  const vol: number[] = [];
  const region: number[] = [];
  /** The outer face of each cell. */
  const outerFace: number[] = [];
  faces.forEach((f, ri) => {
    for (let i = 0; i < m.cells[ri]!; i++) {
      // the node sits at the cell's volume centroid, where OFFBEAT reports the cell (src/core/geometry.ts)
      r.push(SPHERE.centroid(f[i]!, f[i + 1]!));
      outerFace.push(f[i + 1]!);
      vol.push(SPHERE.volume(f[i]!, f[i + 1]!));
      region.push(ri);
    }
  });
  const n = r.length;
  const kernelVolume = SPHERE.volume(0, m.kernelRadius);
  const share = vol.map((v, i) => (region[i] === 0 ? v / kernelVolume : 0));
  /** The face between cell i and i+1: the outer face of cell i (inside a region, or the boundary between two regions). */
  const faceOf = (i: number) => outerFace[i]!;
  // only the face the gap sits on needs a name: the buffer's outer face, between region 1 and region 2
  const isGap = (i: number) => region[i] === 1 && region[i + 1] === 2;
  const kOf = (i: number, T: number) => evaluate(m.laws[region[i]!]!, T);
  const outerT = m.boundary.kind === "convective" ? m.boundary.bulkTemperature : m.boundary.surfaceTemperature;
  const Ro = bounds[bounds.length - 1]!;
  const rFilm = m.boundary.kind === "convective" ? 1 / (SPHERE.area(Ro) * m.boundary.heatTransferCoefficient) : 0;
  const conductances = (T: number[]) => {
    const g: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const f = faceOf(i);
      // two half cells in series, each with its own conductivity, and the gap's resistance if the face is the gap
      let res = SPHERE.resist(r[i]!, f, kOf(i, T[i]!)) + SPHERE.resist(f, r[i + 1]!, kOf(i + 1, T[i + 1]!));
      if (isGap(i)) res += 1 / (SPHERE.area(f) * m.gapConductance);
      g.push(1 / res);
    }
    const gOut = 1 / (SPHERE.resist(r[n - 1]!, Ro, kOf(n - 1, T[n - 1]!)) + rFilm);
    return { g, gOut };
  };
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
  const wallOf = (T: number[]) => {
    if (m.boundary.kind !== "convective") return outerT;
    const gHalf = SPHERE.conductance(r[n - 1]!, Ro, kOf(n - 1, T[n - 1]!));
    const gFilm = 1 / rFilm;
    return (gHalf * T[n - 1]! + gFilm * outerT) / (gHalf + gFilm);
  };
  if ((o.initialTemperature === undefined) === (o.initialField === undefined)) throw new Error("give exactly one of initialTemperature and initialField");
  if (o.initialField !== undefined && (o.initialField.length !== n || !o.initialField.every((x) => Number.isFinite(x) && x > 0))) throw new Error("initialField needs " + n + " positive finite temperatures");
  let T = o.initialField !== undefined ? o.initialField.slice() : new Array<number>(n).fill(o.initialTemperature!);
  const states: TrisoFvState[] = [{ time: 0, T: T.slice(), deposited: 0, rejected: 0, wall: wallOf(T) }];
  let deposited = 0;
  let rejected = 0;
  const theta = scheme === "crank-nicolson" ? 0.5 : 1;
  for (let step = 1; step <= o.steps; step++) {
    const t0 = (step - 1) * o.dt;
    const t1 = step * o.dt;
    const q0 = m.power(t0);
    const q1 = m.power(t1);
    const Told = T;
    const old = scheme === "crank-nicolson" ? conduction(Told, Told) : null;
    let Tn = Told.slice();
    for (let iter = 0; iter < 100; iter++) {
      const { g, gOut } = conductances(Tn);
      const lower = new Array<number>(n).fill(0);
      const diag = new Array<number>(n).fill(0);
      const upper = new Array<number>(n).fill(0);
      const rhs = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        const cLaw = caps[region[i]!]!;
        const Cdt = (vol[i]! * evaluate(cLaw, Tn[i]!)) / o.dt;
        diag[i] = Cdt;
        rhs[i] = Cdt * Tn[i]! - (vol[i]! * (primitive(cLaw, Tn[i]!) - primitive(cLaw, Told[i]!))) / o.dt;
        rhs[i]! += theta * share[i]! * q1 + (scheme === "crank-nicolson" ? 0.5 * share[i]! * q0 + 0.5 * old!.f[i]! : 0);
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
    const outNew = conduction(Tn, Tn).gOut * (Tn[n - 1]! - outerT);
    const outOld = conduction(Told, Told).gOut * (Told[n - 1]! - outerT);
    rejected += o.dt * (scheme === "crank-nicolson" ? 0.5 * (outNew + outOld) : outNew);
    deposited += o.dt * (scheme === "crank-nicolson" ? 0.5 * (q0 + q1) : q1);
    T = Tn;
    if (step % o.outputEvery === 0) states.push({ time: t1, T: T.slice(), deposited, rejected, wall: wallOf(T) });
  }
  return { r, volume: vol, region, states };
}

/** The energy stored in the particle relative to a starting field (or a uniform temperature), J: the enthalpy change of every cell. */
export function trisoStoredEnergy(m: TrisoModel, fv: TrisoFv, T: number[], initial: number | number[]): number {
  const caps = m.capacities ?? m.laws.map(() => [STEADY_PSEUDO_HEAT_CAPACITY]);
  let e = 0;
  T.forEach((t, i) => {
    const c = caps[fv.region[i]!]!;
    e += fv.volume[i]! * (primitive(c, t) - primitive(c, typeof initial === "number" ? initial : initial[i]!));
  });
  return e;
}

/**
 * The steady field of the particle at its power: one implicit step of effectively infinite length, iterated for a temperature-dependent conductivity, then checked as a fixed point
 * (another step of the same problem must not move it). Refuses, with the reason, a field it cannot trust, as `steadyFv` does for a pin.
 */
export function steadyTrisoFv(m: TrisoModel, power: number): { T: number[]; wall: number; r: number[]; region: number[] } {
  if (!(power >= 0) || !Number.isFinite(power)) throw new RangeError("the steady power must be a finite number, zero or more");
  const outer = m.boundary.kind === "convective" ? m.boundary.bulkTemperature : m.boundary.surfaceTemperature;
  const stat: TrisoModel = { ...m, power: () => power };
  const run = solveTrisoFv(stat, { dt: 1e30, steps: 1, initialTemperature: outer, outputEvery: 1 });
  const s = run.states[1]!;
  if (!s.T.every((x) => Number.isFinite(x) && x > 0)) throw new RangeError("the iteration for the steady state ended with a temperature that is not finite and above 0 K; a conductivity law that falls too far at this power is the usual cause");
  s.T.forEach((x, i) => {
    if (!(evaluate(m.laws[run.region[i]!]!, x) > 0)) throw new RangeError("the conductivity of region " + run.region[i] + " is not positive at " + x.toFixed(0) + " K, so there is no steady state at this power");
  });
  const again = solveTrisoFv(stat, { dt: 1e30, steps: 1, initialField: s.T, outputEvery: 1 }).states[1]!;
  const moved = Math.max(...again.T.map((x, i) => Math.abs(x - s.T[i]!)));
  if (!(moved <= 1e-6)) throw new RangeError("the steady state did not settle: another iteration still moves it by " + moved.toPrecision(3) + " K");
  return { T: s.T, wall: s.wall, r: run.r, region: run.region };
}

// ---- 3. the time scale

export interface TrisoTimeScale {
  /** The Elmore sum with the safety factor: an upper bound on the slowest time constant, s. */
  tauBound: number;
  capacityRatio: number;
  cells: number;
}

/** The Elmore bound of a particle on the writer's mesh (equal cells in each region), with the placeholder heat capacity and the lowest conductivity each material allows. */
export function trisoTimeScale(n: NormalizedTriso): TrisoTimeScale {
  const ks = [n.kernelConductivity, ...n.layers.map((l) => l.conductivity)].map((k: Conductivity) => lowestConductivity(k));
  const bounds = [0, n.kernelRadius, ...n.layers.map((l) => l.outerRadius)];
  const Ro = n.outerRadius;
  const rFilm = n.boundary.kind === "convective" ? 1 / (SPHERE.area(Ro) * n.boundary.heatTransferCoefficient) : 0;
  const rGap = 1 / (SPHERE.area(bounds[2]!) * n.gapConductance);
  // the resistance from a point at radius rc in region ri out to the coolant: the rest of its own region, every region outside it, the gap if it is inside it, the film
  const outwards = (ri: number, rc: number): number => {
    let res = SPHERE.resist(rc, bounds[ri + 1]!, ks[ri]!);
    for (let j = ri + 1; j < ks.length; j++) res += SPHERE.resist(bounds[j]!, bounds[j + 1]!, ks[j]!);
    if (ri <= 1) res += rGap;
    return res + rFilm;
  };
  let sum = 0;
  let total = 0;
  let min = Infinity;
  for (let ri = 0; ri < ks.length; ri++) {
    const f = faceRadii(bounds[ri]!, bounds[ri + 1]!, n.cells[ri]!);
    for (let j = 0; j < n.cells[ri]!; j++) {
      const c = STEADY_PSEUDO_HEAT_CAPACITY * SPHERE.volume(f[j]!, f[j + 1]!);
      sum += c * outwards(ri, SPHERE.centroid(f[j]!, f[j + 1]!));
      total += c;
      if (c < min) min = c;
    }
  }
  return { tauBound: TAU_SAFETY * sum, capacityRatio: Math.sqrt(total / min), cells: n.cells.reduce((a, b) => a + b, 0) };
}

/** From the coolant (or the wall) to the closed-form centre: the farthest any cell can start from its steady value, K. */
export function trisoInitialDeviationBound(n: NormalizedTriso): number {
  const t0 = n.boundary.kind === "convective" ? n.boundary.bulkTemperature : n.boundary.surfaceTemperature;
  return Math.max(Math.abs(trisoClosedForm(n).centreT - t0), 1);
}

const roundUp2 = (x: number): number => {
  const e = Math.floor(Math.log10(x)) - 1;
  const m = 10 ** e;
  return Math.ceil(x / m - 1e-9) * m;
};

/** The end time of a steady run of the particle: the pin's rule (steadyState.ts) with the sphere's time scale. */
export function trisoSteadyEndTime(n: NormalizedTriso): SteadyHorizon {
  const ts = trisoTimeScale(n);
  const dT0 = trisoInitialDeviationBound(n);
  const needed = ts.tauBound * Math.log(Math.max((ts.capacityRatio * dT0) / STEADY_TOLERANCE, Math.E));
  if (!Number.isFinite(needed) || !Number.isFinite(ts.tauBound)) {
    return { ok: false, needed, tauBound: ts.tauBound, message: "the particle's time scale is not a finite number: a non-finite value in the case reached it" };
  }
  const endTime = Math.max(MIN_STEADY_END_TIME, roundUp2(needed));
  if (!(endTime <= MAX_STEADY_END_TIME)) {
    return { ok: false, needed, tauBound: ts.tauBound, message: `the particle's slowest thermal time constant is at most ${ts.tauBound.toExponential(2)} s (placeholder heat capacity), so a steady state within ${STEADY_TOLERANCE} K needs about ${needed.toExponential(2)} s, more than the ${MAX_STEADY_END_TIME.toExponential(0)} s FEED allows` };
  }
  return { ok: true, endTime, tauBound: ts.tauBound, capacityRatio: ts.capacityRatio };
}

// ---- 4. the quick look

export interface TrisoDomainFinding {
  region: TrisoRegionName;
  temperatureRange: [number, number];
  validRange: [number, number];
}

export interface TrisoQuickLook {
  closed: Omit<TrisoClosedForm, "temperatureAt">;
  /** 'out-of-domain' when a region's temperatures leave its conductivity's stated range: never silently extrapolated. */
  verdict: "in-domain" | "out-of-domain";
  findings: TrisoDomainFinding[];
}

export function trisoQuickLook(n: NormalizedTriso): TrisoQuickLook {
  const { temperatureAt: _t, ...closed } = trisoClosedForm(n);
  const findings: TrisoDomainFinding[] = [];
  const ks: Conductivity[] = [n.kernelConductivity, ...n.layers.map((l) => l.conductivity)];
  closed.regions.forEach((reg, i) => {
    const range = rangeOf(ks[i]!);
    const lo = Math.min(reg.innerT, reg.outerT);
    const hi = Math.max(reg.innerT, reg.outerT);
    if (range && (lo < range[0] || hi > range[1])) findings.push({ region: reg.name, temperatureRange: [lo, hi], validRange: range });
  });
  return { closed, verdict: findings.length === 0 ? "in-domain" : "out-of-domain", findings };
}

/** The numbers the editor shows beside a particle case: the heat, the volumes, the packing arithmetic, the layer drops and the time scale. */
export function trisoDerived(n: NormalizedTriso) {
  const look = trisoQuickLook(n);
  const ts = trisoTimeScale(n);
  return {
    particlePower: n.power.particlePower,
    kernelPowerDensity: n.power.kernelPowerDensity,
    kernelVolume: n.power.kernelVolume,
    particleVolume: n.power.particleVolume,
    outerRadius: n.outerRadius,
    /** The heat flux through the outer surface, W/m2. */
    outerSurfaceHeatFlux: n.power.particlePower / SPHERE.area(n.outerRadius),
    ...(n.power.compact ? { compactPowerDensity: n.power.compact.powerDensity, packingFraction: n.power.compact.packingFraction, particlesPerCubicMetre: n.power.compact.packingFraction / n.power.particleVolume } : {}),
    centreT: look.closed.centreT,
    wallT: look.closed.wallT,
    /** The rise of each region from its outer to its inner face, K, and the gap's drop. */
    regionDrops: look.closed.regions.map((r) => ({ name: r.name, deltaT: r.innerT - r.outerT })),
    gapDeltaT: look.closed.gapDeltaT,
    timeScale: ts.tauBound,
  };
}
