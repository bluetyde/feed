// A population of coated particles (plan 13, T6): N particles drawn from distributions the case states (kernel radius, each layer's thickness, a local power factor, the matrix
// temperature), each one run through the independent closed form of the sphere (trisoSolve.ts), and the spread of the kernel's peak temperature and of every drop reported.
//
// What this is and is not: a SAMPLE of a stated population, not a prediction for a real core. The distributions are the case's, nothing here says how a real fuel varies; the
// spread is the spread of the N particles drawn; the model is thermal only, so nothing here says whether a particle fails.
//
// The generator is written here (no Math.random, no library): xoshiro128** on 32-bit integers seeded through splitmix32, and a Box-Muller normal. The integer generator gives the same
// numbers on every platform and every engine; the normal draw uses Math.log, Math.sqrt and Math.cos, which are the same code on every platform of one engine (V8 ports fdlibm) and may
// differ in the last bits on another engine. tests/trisoPopulation.test.ts holds the generator against a second implementation in BigInt arithmetic.
//
// One particle is drawn in a fixed order: kernelRadius, buffer, ipyc, sic, opyc, powerFactor, matrixTemperature. A variable the case does not give a distribution is the case's own
// value and draws nothing. A draw that is not a particle (a thickness or radius outside the lengths the validator allows, a power factor or a temperature outside its range, a
// closed form that does not exist) is REJECTED AS A WHOLE and counted, and the particle is drawn again; the sample is therefore the stated distributions conditioned on being valid
// particles, and the counts say how much that matters.
//
// The power: the case's kernel power density times the power factor, in W per m3 of kernel, so a bigger kernel makes more heat in the same neutron field. A population of constants
// is the case's own particle (the power per particle is then the case's, to rounding).

import type { NormalizedTriso, TrisoLayerName } from "./triso";
import { TRISO_LAYER_NAMES, particleVolumes } from "./triso";
import { TrisoRegionName, trisoClosedForm } from "./trisoSolve";
import type { TrisoLimitRule } from "./trisoLimits";

// ---- the generator

/** splitmix32 (a 32-bit mixing step): the next state and an output, used to fill the four words of the generator's state from one seed. */
function splitmix32(state: number): [number, number] {
  const a = (state + 0x9e3779b9) | 0;
  let t = a ^ (a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return [a, t >>> 0];
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /** `seed` is a whole number from 0 to 2^32 - 1. */
  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("the seed must be a whole number from 0 to 4294967295");
    let st = seed | 0;
    const w: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [next, out] = splitmix32(st);
      st = next;
      w.push(out | 0);
    }
    [this.s0, this.s1, this.s2, this.s3] = w as [number, number, number, number];
  }

  /** The next 32-bit word, 0 to 2^32 - 1 (xoshiro128**). */
  next32(): number {
    const r = Math.imul(this.s1, 5);
    const result = Math.imul((r << 7) | (r >>> 25), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = (this.s3 << 11) | (this.s3 >>> 21);
    return result;
  }

  /** A number in the open interval (0, 1) with 53 random bits: never exactly 0 (a logarithm follows) and never 1. */
  uniform(): number {
    const hi = this.next32() >>> 5; // 27 bits
    const lo = this.next32() >>> 6; // 26 bits
    return (hi * 67108864 + lo + 0.5) / 9007199254740992;
  }

  /** A standard normal draw by Box-Muller: sqrt(-2 ln u1) cos(2 pi u2). One draw uses two uniforms; the sine partner is thrown away, so a draw never depends on the one before. */
  normal(): number {
    const u1 = this.uniform();
    const u2 = this.uniform();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

// ---- the normal distribution's CDF (for the acceptance probability of a truncation; Numerical Recipes' erfc, relative error under 1.2e-7)

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
/** The standard normal CDF. */
export const normalCdf = (x: number): number => 0.5 * erfc(-x / Math.SQRT2);

// ---- the distributions

export type PopulationVariable = "kernelRadius" | TrisoLayerName | "powerFactor" | "matrixTemperature";
/** The order a particle is drawn in. */
export const POPULATION_VARIABLES: readonly PopulationVariable[] = ["kernelRadius", ...TRISO_LAYER_NAMES, "powerFactor", "matrixTemperature"];

export interface Truncation {
  min?: number;
  max?: number;
}
export type Distribution =
  | { kind: "constant"; value: number }
  | { kind: "normal"; mean: number; stdDev: number; truncate?: Truncation }
  | { kind: "lognormal"; median: number; sigmaLog: number; truncate?: Truncation }
  | { kind: "uniform"; min: number; max: number };

export interface NormalizedPopulation {
  size: number;
  seed: number;
  /** Only the variables the case gave a distribution for. */
  distributions: Partial<Record<PopulationVariable, Distribution>>;
}

/** The most particles in a population (the batch runs in one worker with a deadline). */
export const POPULATION_MAX_SIZE = 100000;
/** A distribution (after its truncation and the range that makes a valid particle) that keeps less than this fraction of its draws is refused: it cannot be sampled. */
export const POPULATION_MIN_ACCEPTANCE = 0.01;
/** A distribution that loses more than this fraction of its draws to the valid range is warned about (the sample is then conditioned on being valid). */
export const POPULATION_WARN_LOSS = 0.01;
/** Tries a truncated draw makes before it gives up (the acceptance is at least POPULATION_MIN_ACCEPTANCE, so the chance of giving up is under 1e-40). */
export const POPULATION_MAX_TRIES = 10000;
/** A population may reject this many draws for each particle it keeps, plus 100, before the run stops: a case whose draws mostly fail is not a population. */
export const POPULATION_REJECTION_FACTOR = 10;
/** The valid values of each kind of variable (the validator's own bounds: RADIUS_MIN and RADIUS_MAX, HISTORY_TEMPERATURE_MAX; a test holds them equal). */
export const POPULATION_LENGTH_RANGE: [number, number] = [1e-9, 1e3];
export const POPULATION_TEMPERATURE_RANGE: [number, number] = [0, 1e4];
export const POPULATION_FACTOR_RANGE: [number, number] = [0, 100];

/** The open range of valid values of a variable (the ends are excluded where the validator excludes them: a length or a temperature of 0, a factor of 0). */
export function validRange(v: PopulationVariable): [number, number] {
  return v === "powerFactor" ? POPULATION_FACTOR_RANGE : v === "matrixTemperature" ? POPULATION_TEMPERATURE_RANGE : POPULATION_LENGTH_RANGE;
}

/** One draw from a distribution. A truncated distribution is sampled by rejection inside the range; `tries` bounds it. */
export function drawFrom(d: Distribution, rng: Rng): number {
  switch (d.kind) {
    case "constant":
      return d.value;
    case "uniform":
      return d.min + (d.max - d.min) * rng.uniform();
    case "normal":
    case "lognormal": {
      const lo = d.truncate?.min ?? -Infinity;
      const hi = d.truncate?.max ?? Infinity;
      for (let i = 0; i < POPULATION_MAX_TRIES; i++) {
        const z = rng.normal();
        const x = d.kind === "normal" ? d.mean + d.stdDev * z : Math.exp(Math.log(d.median) + d.sigmaLog * z);
        if (x >= lo && x <= hi) return x;
      }
      throw new RangeError("a truncated draw found no value inside its range in " + POPULATION_MAX_TRIES + " tries");
    }
  }
}

/** The probability that a draw from the distribution (before any truncation) lies in [lo, hi]. */
export function probabilityIn(d: Distribution, lo: number, hi: number): number {
  switch (d.kind) {
    case "constant":
      return d.value >= lo && d.value <= hi ? 1 : 0;
    case "uniform": {
      const a = Math.max(lo, d.min);
      const b = Math.min(hi, d.max);
      return b > a ? (b - a) / (d.max - d.min) : 0;
    }
    case "normal":
      return hi <= lo ? 0 : normalCdf((hi - d.mean) / d.stdDev) - normalCdf((lo - d.mean) / d.stdDev);
    case "lognormal": {
      if (hi <= lo || !(hi > 0)) return 0;
      const cdf = (x: number) => (x <= 0 ? 0 : normalCdf((Math.log(x) - Math.log(d.median)) / d.sigmaLog));
      return cdf(hi) - cdf(lo);
    }
  }
}

/** The fraction of draws a distribution keeps: those inside its truncation, and of those the ones inside the valid range of its variable. */
export function keptFractions(d: Distribution, v: PopulationVariable): { inTruncation: number; valid: number; lossToRange: number } {
  const t = d.kind === "normal" || d.kind === "lognormal" ? d.truncate : undefined;
  const tl = t?.min ?? -Infinity;
  const th = t?.max ?? Infinity;
  const [rl, rh] = validRange(v);
  const inTruncation = probabilityIn(d, tl, th);
  // the valid range is open at its lower end for every variable (a length, a factor and a temperature of exactly 0 are not particles): a continuous distribution loses nothing there
  const valid = probabilityIn(d, Math.max(tl, rl), Math.min(th, rh));
  return { inTruncation, valid, lossToRange: inTruncation > 0 ? 1 - valid / inTruncation : 1 };
}

// ---- the particles

/** What one drawn particle is: the values of every variable. */
export interface Draw {
  kernelRadius: number;
  /** The thickness of each layer the particle has, in order from the buffer. */
  thicknesses: number[];
  powerFactor: number;
  matrixTemperature: number;
}

/** The nominal value of each variable: the case's own particle. */
export function nominalDraw(n: NormalizedTriso): Draw {
  return {
    kernelRadius: n.kernelRadius,
    thicknesses: n.layers.map((l) => l.outerRadius - l.innerRadius),
    powerFactor: 1,
    matrixTemperature: n.boundary.kind === "convective" ? n.boundary.bulkTemperature : n.boundary.surfaceTemperature,
  };
}

/** The particle a draw describes: the case's normalised particle with the drawn radii, power and matrix temperature. The conductivities, the gap's conductance and the film are the case's. */
export function particleOf(n: NormalizedTriso, d: Draw): NormalizedTriso {
  let r = d.kernelRadius;
  const layers = n.layers.map((l, i) => {
    const inner = r;
    r += d.thicknesses[i]!;
    return { ...l, innerRadius: inner, outerRadius: r };
  });
  const { kernelVolume, particleVolume } = particleVolumes(d.kernelRadius, r);
  const kernelPowerDensity = n.power.kernelPowerDensity * d.powerFactor;
  const particlePower = kernelPowerDensity * kernelVolume;
  const { compact: _compact, ...power } = n.power;
  return {
    ...n,
    kernelRadius: d.kernelRadius,
    layers,
    outerRadius: r,
    boundary: n.boundary.kind === "convective" ? { ...n.boundary, bulkTemperature: d.matrixTemperature } : { kind: "surface-temperature", surfaceTemperature: d.matrixTemperature },
    power: { ...power, form: "kernel-density", particlePower, kernelPowerDensity, kernelVolume, particleVolume },
  };
}

/** Why a draw was thrown away. */
export type RejectionReason = "geometry" | "powerFactor" | "matrixTemperature" | "noClosedForm";
export const REJECTION_REASONS: readonly RejectionReason[] = ["geometry", "powerFactor", "matrixTemperature", "noClosedForm"];

/** Inside a variable's valid range: a length may equal its lower bound (the validator's RADIUS_MIN), a factor or a temperature may not equal 0. */
const inRange = (x: number, [lo, hi]: [number, number]) => (lo > 0 ? x >= lo : x > lo) && x <= hi && Number.isFinite(x);

/** The first reason a draw is not a valid particle, if any. */
export function rejectionOf(d: Draw): RejectionReason | undefined {
  if (!inRange(d.kernelRadius, POPULATION_LENGTH_RANGE) || d.thicknesses.some((t) => !inRange(t, POPULATION_LENGTH_RANGE))) return "geometry";
  if (!inRange(d.powerFactor, POPULATION_FACTOR_RANGE)) return "powerFactor";
  if (!inRange(d.matrixTemperature, POPULATION_TEMPERATURE_RANGE)) return "matrixTemperature";
  return undefined;
}

/** Draw one particle's values in the fixed order. */
export function drawParticle(n: NormalizedTriso, pop: NormalizedPopulation, rng: Rng): Draw {
  const d = nominalDraw(n);
  const dist = pop.distributions;
  if (dist.kernelRadius) d.kernelRadius = drawFrom(dist.kernelRadius, rng);
  TRISO_LAYER_NAMES.forEach((name) => {
    const i = n.layers.findIndex((l) => l.name === name);
    const g = dist[name];
    if (g && i >= 0) d.thicknesses[i] = drawFrom(g, rng);
  });
  if (dist.powerFactor) d.powerFactor = drawFrom(dist.powerFactor, rng);
  if (dist.matrixTemperature) d.matrixTemperature = drawFrom(dist.matrixTemperature, rng);
  return d;
}

// ---- the statistics

export interface Stat {
  mean: number;
  /** The sample standard deviation (n - 1 in the denominator; 0 for one particle). */
  stdDev: number;
  min: number;
  max: number;
  p5: number;
  p50: number;
  p95: number;
  p99: number;
}

/** The p-th percentile (0 to 1) of an ascending list by linear interpolation between the order statistics: the value at position (n - 1) p (the default of NumPy and of R's type 7). */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) throw new RangeError("no values");
  const h = (n - 1) * p;
  const i = Math.floor(h);
  const j = Math.min(i + 1, n - 1);
  return sorted[i]! + (h - i) * (sorted[j]! - sorted[i]!);
}

export function statOf(values: ArrayLike<number>): Stat {
  const n = values.length;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i]!;
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (values[i]! - mean) ** 2;
  return { mean, stdDev: n > 1 ? Math.sqrt(ss / (n - 1)) : 0, min: sorted[0]!, max: sorted[n - 1]!, p5: percentile(sorted, 0.05), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) };
}

export interface Histogram {
  /** bins + 1 ascending edges, K; the last bin includes its upper edge. One bin when every value is the same. */
  edges: number[];
  counts: number[];
}
export const POPULATION_BINS = 20;
export function histogramOf(values: ArrayLike<number>, bins = POPULATION_BINS): Histogram {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i]! < lo) lo = values[i]!;
    if (values[i]! > hi) hi = values[i]!;
  }
  if (!(hi > lo)) return { edges: [lo, hi], counts: [values.length] };
  const counts = new Array<number>(bins).fill(0);
  for (let i = 0; i < values.length; i++) counts[Math.min(bins - 1, Math.floor(((values[i]! - lo) / (hi - lo)) * bins))]!++;
  return { edges: Array.from({ length: bins + 1 }, (_, k) => lo + ((hi - lo) * k) / bins), counts };
}

// ---- the batch

/** The quantities reported for each particle, in this order: the kernel's peak, the whole rise above the matrix, and the drop of each region and of the gap and the film. */
export interface QuantityStat {
  id: string;
  label: string;
  stat: Stat;
}

export interface PopulationParticle {
  /** The position in the accepted sample, from 0. */
  index: number;
  kernelPeakT: number;
  draw: Draw;
  /** W */
  particlePower: number;
}
export type RepresentativeRole = "hottest" | "median" | "coldest" | "thickestBuffer" | "thinnestSic";
export interface Representative extends PopulationParticle {
  role: RepresentativeRole;
}

export interface LimitFraction {
  name: string;
  region: string;
  maxTemperature: number;
  /** The particles whose region reached more than the limit (the region's hottest point, the closed form's face), and the fraction of the sample. */
  above: number;
  fraction: number;
}

export interface PopulationResult {
  kind: "triso-population";
  caseId: string;
  size: number;
  seed: number;
  /** Draws thrown away, in all and by reason; the sample is conditioned on these not happening. */
  rejected: { total: number; byReason: Record<RejectionReason, number> };
  /** The distributions as the case gave them (SI units). */
  distributions: NormalizedPopulation["distributions"];
  /** The case's own particle (every variable at its nominal value), for comparison with the mean. */
  nominal: { kernelPeakT: number; drops: Record<string, number> };
  quantities: QuantityStat[];
  histogram: Histogram;
  maximum: Representative;
  representatives: Representative[];
  limits: LimitFraction[];
  /** The kernel peak of every particle in draw order; only with the option `keepSamples`. */
  samples?: number[];
  text: string;
}

export const POPULATION_TEXT = "A sample of a stated population: the particles are drawn by a seeded generator from the distributions this case states, and every one is run through the independent closed form of the sphere. It is not a prediction for a real core: the distributions are the case's, the spread is the spread of this sample, and the draws that were not valid particles are counted and thrown away. Thermal only: no stress, no swelling or creep, no gas pressure and no failure fraction.";

const regionOrder = (n: NormalizedTriso): TrisoRegionName[] => ["kernel", ...n.layers.map((l) => l.name)];

export interface PopulationOptions {
  keepSamples?: boolean;
}

/** The quantities of one closed form, in the reported order: id, label, value. */
function reportOf(n: NormalizedTriso, cf: ReturnType<typeof trisoClosedForm>, matrixT: number): [string, string, number][] {
  const rows: [string, string, number][] = [
    ["kernelPeakT", "kernel peak temperature (K)", cf.centreT],
    ["rise", "kernel peak above the matrix (K)", cf.centreT - matrixT],
  ];
  for (const r of cf.regions) rows.push(["drop:" + r.name, "drop across the " + r.name + " (K)", r.innerT - r.outerT]);
  rows.push(["drop:gap", "drop across the gap (K)", cf.gapDeltaT]);
  if (n.boundary.kind === "convective") rows.push(["drop:film", "drop across the film (K)", cf.filmDeltaT]);
  return rows;
}

/**
 * Draw the population and run every particle through the closed form. Refuses (RangeError with the reason) a population whose draws mostly fail. Pure and deterministic: the same case
 * gives the same result.
 */
export function runPopulation(n: NormalizedTriso, o: PopulationOptions = {}): PopulationResult {
  const pop = n.population;
  if (!pop) throw new RangeError("the case has no population section");
  const rng = new Rng(pop.seed);
  const size = pop.size;
  const byReason: Record<RejectionReason, number> = { geometry: 0, powerFactor: 0, matrixTemperature: 0, noClosedForm: 0 };
  let rejected = 0;
  const cap = POPULATION_REJECTION_FACTOR * size + 100;
  const nominal = trisoClosedForm(n);
  const nominalRows = reportOf(n, nominal, nominalDraw(n).matrixTemperature);
  const ids = nominalRows.map((r) => r[0]);
  const columns = ids.map(() => new Float64Array(size));
  const powers = new Float64Array(size);
  const bufferT = new Float64Array(size);
  const sicT = new Float64Array(size);
  const draws: Draw[] = [];
  const regionPeaks = regionOrder(n).map(() => new Float64Array(size));
  const bufferI = n.layers.findIndex((l) => l.name === "buffer");
  const sicI = n.layers.findIndex((l) => l.name === "sic");
  let kept = 0;
  while (kept < size) {
    const d = drawParticle(n, pop, rng);
    const why = rejectionOf(d);
    let cf: ReturnType<typeof trisoClosedForm> | undefined;
    let p: NormalizedTriso | undefined;
    let reason: RejectionReason | undefined = why;
    if (!reason) {
      p = particleOf(n, d);
      try {
        cf = trisoClosedForm(p);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        reason = "noClosedForm";
      }
    }
    if (reason || !cf || !p) {
      byReason[reason!]++;
      rejected++;
      if (rejected > cap) throw new RangeError("the distributions give too many particles that are not valid: " + rejected + " draws rejected for " + kept + " kept (" + REJECTION_REASONS.map((r) => r + " " + byReason[r]).join(", ") + "); the limit is " + cap + ". Change the distributions");
      continue;
    }
    const rows = reportOf(p, cf, d.matrixTemperature);
    rows.forEach((r, c) => (columns[c]![kept] = r[2]));
    cf.regions.forEach((r, c) => (regionPeaks[c]![kept] = r.innerT));
    powers[kept] = p.power.particlePower;
    bufferT[kept] = bufferI >= 0 ? d.thicknesses[bufferI]! : 0;
    sicT[kept] = sicI >= 0 ? d.thicknesses[sicI]! : 0;
    draws.push(d);
    kept++;
  }
  const peaks = columns[0]!;
  const particleAt = (i: number): PopulationParticle => ({ index: i, kernelPeakT: peaks[i]!, draw: draws[i]!, particlePower: powers[i]! });
  const argBest = (values: ArrayLike<number>, better: (a: number, b: number) => boolean) => {
    let best = 0;
    for (let i = 1; i < values.length; i++) if (better(values[i]!, values[best]!)) best = i;
    return best;
  };
  const stats = columns.map((c) => statOf(c));
  const median = stats[0]!.p50;
  const reps: Representative[] = [];
  const add = (role: RepresentativeRole, i: number) => reps.push({ role, ...particleAt(i) });
  add("hottest", argBest(peaks, (a, b) => a > b));
  add("median", argBest(Array.from(peaks, (x) => -Math.abs(x - median)), (a, b) => a > b));
  add("coldest", argBest(peaks, (a, b) => a < b));
  if (bufferI >= 0) add("thickestBuffer", argBest(bufferT, (a, b) => a > b));
  if (sicI >= 0) add("thinnestSic", argBest(sicT, (a, b) => a < b));
  const regions = regionOrder(n);
  const limits: LimitFraction[] = (n.limits ?? []).map((rule: TrisoLimitRule) => {
    const col = regionPeaks[regions.indexOf(rule.region)]!;
    let above = 0;
    for (let i = 0; i < size; i++) if (col[i]! > rule.maxTemperature) above++;
    return { name: rule.name, region: rule.region, maxTemperature: rule.maxTemperature, above, fraction: above / size };
  });
  const drops: Record<string, number> = {};
  nominalRows.slice(2).forEach((r) => (drops[r[0].slice(5)] = r[2]));
  return {
    kind: "triso-population",
    caseId: n.caseId,
    size,
    seed: pop.seed,
    rejected: { total: rejected, byReason },
    distributions: pop.distributions,
    nominal: { kernelPeakT: nominalRows[0]![2], drops },
    quantities: ids.map((id, c) => ({ id, label: nominalRows[c]![1], stat: stats[c]! })),
    histogram: histogramOf(peaks),
    maximum: reps[0]!,
    representatives: reps,
    limits,
    ...(o.keepSamples ? { samples: Array.from(peaks) } : {}),
    text: POPULATION_TEXT,
  };
}

/**
 * The case document of one drawn particle: the case with its geometry, kernel power density and matrix temperature set to the draw's values (constants, in SI units) and the population
 * section taken out, so the run manager can run it through OFFBEAT. The coating names, materials, mesh, gap and the rest are the case's own.
 */
export function particleDocument(doc: Record<string, any>, n: NormalizedTriso, d: Draw): Record<string, any> {
  const out = JSON.parse(JSON.stringify(doc)) as Record<string, any>;
  delete out.population;
  out.geometry.kernelRadius = { value: d.kernelRadius, unit: "m" };
  out.geometry.layers = n.layers.map((l, i) => ({ name: l.name, thickness: { value: d.thicknesses[i]!, unit: "m" } }));
  out.power = { kernelPowerDensity: { value: n.power.kernelPowerDensity * d.powerFactor, unit: "W/m3" } };
  if (n.boundary.kind === "convective") out.boundary.bulkTemperature = { value: d.matrixTemperature, unit: "K" };
  else out.boundary = { surfaceTemperature: { value: d.matrixTemperature, unit: "K" } };
  return out;
}
