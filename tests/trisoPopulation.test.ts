// Plan 13, T6: a population of coated particles. Ungated. The generator against a second implementation in BigInt arithmetic and against the statistics of the normal law; the
// distributions against quadratures; the statistics and the histogram against lists worked by hand; the batch against closed forms and quadratures written in this file (no use of
// src/core/trisoSolve.ts for an expected value); the sampled mean against the mean particle plus the Jensen correction computed by quadrature; the percentile against a sorted list;
// a population of constants against the single particle; and a population section that changes nothing for a case without one. Negative controls: a swapped distribution and a read of
// the wrong layer fail the same checks.
//
// Tolerances, fixed here before the first run:
//   - the generator against the BigInt implementation: exact (integers).
//   - a statistic of N draws against its theory: 4 standard errors (a fixed seed makes the outcome deterministic; 4 standard errors is the width a random seed would pass 99.99 % of the time).
//   - the Kolmogorov-Smirnov distance of N normal draws from the normal CDF: 1.95 / sqrt(N) (the 0.1 % critical value).
//   - the normal CDF against the quadrature of its density: 5e-7 (the erfc approximation is good to 1.2e-7 relative).
//   - the batch's temperatures against the closed form written in this file: 1e-9 K (both are plain double arithmetic on the same formulas; the bound is for the order of the sums).
//   - the percentile and the statistics against the hand-worked lists: 1e-9 K.
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  POPULATION_BINS,
  POPULATION_FACTOR_RANGE,
  POPULATION_LENGTH_RANGE,
  POPULATION_MAX_SIZE,
  POPULATION_TEMPERATURE_RANGE,
  Rng,
  drawFrom,
  histogramOf,
  keptFractions,
  nominalDraw,
  normalCdf,
  particleDocument,
  particleOf,
  percentile,
  probabilityIn,
  runPopulation,
  statOf,
  type Distribution,
  type PopulationResult,
} from "../src/core/trisoPopulation";
import { trisoClosedForm } from "../src/core/trisoSolve";
import { writeTrisoCase } from "../src/core/trisoWriter";
import { HISTORY_TEMPERATURE_MAX, RADIUS_MAX, RADIUS_MIN, validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
const vec = (name: string) => read("schema/vectors/good/" + name + ".json");
const q = (value: number, unit: string) => ({ value, unit });
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.triso!;
};
/** The vector's particle (kernel 250 um, layers 100 / 40 / 35 / 35 um, k 3 / 0.5 / 4 / 13.9 / 4 W/m/K, gap 1.5e5 W/m2/K at the buffer's outer radius, 1000 K wall) with a power density and a population. */
function particle(pop: Record<string, unknown>, power = "600") {
  const c = vec("triso-steady");
  c.power = { kernelPowerDensity: q(Number(power), "MW/m3") };
  c.population = pop;
  return c;
}
const N = (m: number, s: number, u = "um") => ({ kind: "normal", mean: q(m, u), stdDev: q(s, u) });
const ok = (pop: Record<string, unknown>, power?: string) => norm(particle(pop, power));

// ---- the references written out here
const PI = Math.PI;
/** The kernel's peak temperature of the vector's particle by plain arithmetic: radii in m, a power density q0 in W/m3 times the factor f, a wall at Tm. */
function hand(R: number, t: number[], f: number, Tm: number, q0 = 600e6) {
  const k = [3, 0.5, 4, 13.9, 4];
  const P = f * q0 * (4 / 3) * PI * R ** 3;
  const r = [R];
  t.forEach((x, i) => r.push(r[i]! + x));
  const drops: number[] = [];
  for (let i = 0; i < 4; i++) drops.push((P / (4 * PI * k[i + 1]!)) * (1 / r[i]! - 1 / r[i + 1]!));
  const gap = P / (4 * PI * r[1]! ** 2 * 1.5e5);
  const kernel = (f * q0 * R * R) / (6 * k[0]!);
  return { peak: Tm + drops.reduce((a, b) => a + b, 0) + gap + kernel, drops, gap, kernel, P };
}
const T0 = [100e-6, 40e-6, 35e-6, 35e-6];
const R0 = 250e-6;
/** Composite Simpson over [a, b] with n intervals (n even). */
function simpson(f: (x: number) => number, a: number, b: number, n = 4000) {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}
const phi = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * PI);

// ---- a second implementation of the generator, in BigInt arithmetic (no Math.imul, no >>> )
const M32 = 0xffffffffn;
function refGenerator(seed: number) {
  const mix = (state: bigint): [bigint, bigint] => {
    const a = (state + 0x9e3779b9n) & M32;
    let t = a ^ (a >> 16n);
    t = (t * 0x21f0aaadn) & M32;
    t ^= t >> 15n;
    t = (t * 0x735a2d97n) & M32;
    t ^= t >> 15n;
    return [a, t];
  };
  let st = BigInt(seed);
  const w: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    const [n, out] = mix(st);
    st = n;
    w.push(out);
  }
  let [s0, s1, s2, s3] = w as [bigint, bigint, bigint, bigint];
  const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (32n - k))) & M32;
  return () => {
    const result = (rotl((s1 * 5n) & M32, 7n) * 9n) & M32;
    const t = (s1 << 9n) & M32;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11n);
    return Number(result);
  };
}

describe("the generator", () => {
  it("is xoshiro128** seeded through splitmix32: 1000 words agree exactly with a second implementation in BigInt arithmetic, for four seeds", () => {
    for (const seed of [0, 1, 12345, 0xffffffff]) {
      const a = new Rng(seed);
      const b = refGenerator(seed);
      for (let i = 0; i < 1000; i++) expect(a.next32()).toBe(b());
    }
  });
  it("gives the same numbers on every platform: the first words of seed 1 are pinned here", () => {
    const g = new Rng(1);
    const ref = refGenerator(1);
    const first = [g.next32(), g.next32(), g.next32(), g.next32(), g.next32()];
    expect(first).toEqual([ref(), ref(), ref(), ref(), ref()]);
    expect(first).toEqual(PINNED_SEED_1);
    // and the first normal draws: Box-Muller of words (0,1) and (2,3), worked here from the pinned words, are pinned to 1e-12
    const u = (hi: number, lo: number) => (Math.floor(hi / 32) * 67108864 + Math.floor(lo / 64) + 0.5) / 9007199254740992;
    const z1 = Math.sqrt(-2 * Math.log(u(first[0]!, first[1]!))) * Math.cos(2 * PI * u(first[2]!, first[3]!));
    expect(Math.abs(z1 - 1.6688860147893603)).toBeLessThan(1e-12);
    expect(Math.abs(new Rng(1).normal() - z1)).toBe(0);
    const g2 = new Rng(1);
    g2.normal();
    expect(Math.abs(g2.normal() - -0.026131030758525287)).toBeLessThan(1e-12);
  });
  it("makes a uniform of 53 bits from two words, always strictly between 0 and 1", () => {
    const g = new Rng(7);
    const ref = refGenerator(7);
    for (let i = 0; i < 200; i++) {
      const hi = Math.floor(ref() / 32);
      const lo = Math.floor(ref() / 64);
      const want = (hi * 67108864 + lo + 0.5) / 9007199254740992;
      expect(g.uniform()).toBe(want);
      expect(want).toBeGreaterThan(0);
      expect(want).toBeLessThan(1);
    }
  });
  it("gives the same stream twice for one seed and another stream for another seed", () => {
    const a = Array.from({ length: 50 }, ((g) => () => g.normal())(new Rng(42)));
    const b = Array.from({ length: 50 }, ((g) => () => g.normal())(new Rng(42)));
    const c = Array.from({ length: 50 }, ((g) => () => g.normal())(new Rng(43)));
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
    expect(c.filter((x, i) => x === a[i])).toHaveLength(0);
  });
  it("refuses a seed that is not a whole number from 0 to 2^32 - 1", () => {
    for (const bad of [-1, 1.5, 4294967296, NaN]) expect(() => new Rng(bad)).toThrow(RangeError);
  });
  it("draws a normal law: mean, variance, the share within one sigma and the distance from the normal CDF are what 200000 draws of N(0,1) should give", () => {
    const n = 200000;
    const g = new Rng(2026);
    const xs = Float64Array.from({ length: n }, () => g.normal());
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    expect(Math.abs(mean)).toBeLessThan(4 / Math.sqrt(n));
    expect(Math.abs(variance - 1)).toBeLessThan(4 * Math.sqrt(2 / n));
    const within = xs.filter((x) => Math.abs(x) < 1).length / n;
    expect(Math.abs(within - 0.6826894921)).toBeLessThan(4 * Math.sqrt((0.6827 * 0.3173) / n));
    const skew = xs.reduce((a, b) => a + ((b - mean) / Math.sqrt(variance)) ** 3, 0) / n;
    expect(Math.abs(skew)).toBeLessThan(4 * Math.sqrt(6 / n));
    const sorted = Float64Array.from(xs).sort();
    let ks = 0;
    for (let i = 0; i < n; i++) ks = Math.max(ks, Math.abs((i + 1) / n - normalCdf(sorted[i]!)), Math.abs(i / n - normalCdf(sorted[i]!)));
    expect(ks).toBeLessThan(1.95 / Math.sqrt(n));
  });
  it("uses two independent uniforms per normal draw, so the draws are not correlated with the one before (lag-1 correlation of 100000)", () => {
    const n = 100000;
    const g = new Rng(99);
    const xs = Array.from({ length: n }, () => g.normal());
    let c = 0;
    for (let i = 1; i < n; i++) c += xs[i]! * xs[i - 1]!;
    expect(Math.abs(c / n)).toBeLessThan(4 / Math.sqrt(n));
  });
});
// the first five words of seed 1, from the BigInt implementation above (written down here after the two agreed)
const PINNED_SEED_1 = [393288148, 2174103013, 3814759091, 2092745082, 1865176206];

describe("the normal CDF and the acceptance probabilities", () => {
  it("normalCdf is the integral of the normal density (Simpson over -9 to x) to 5e-7, and symmetric", () => {
    for (const x of [-3, -1.2, -0.3, 0, 0.5, 1, 2.2, 3.4]) {
      const integral = simpson(phi, -9, x, 4000);
      expect(Math.abs(normalCdf(x) - integral)).toBeLessThan(5e-7);
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 6);
    }
    expect(Math.abs(normalCdf(0) - 0.5)).toBeLessThan(5e-7);
  });
  it("probabilityIn of a normal, a lognormal and a uniform is the integral of the density over the interval", () => {
    const nrm: Distribution = { kind: "normal", mean: 10, stdDev: 2 };
    expect(probabilityIn(nrm, 9, 13)).toBeCloseTo(simpson((x) => phi((x - 10) / 2) / 2, 9, 13), 6);
    const lg: Distribution = { kind: "lognormal", median: 5, sigmaLog: 0.3 };
    expect(probabilityIn(lg, 4, 7)).toBeCloseTo(simpson((x) => phi((Math.log(x) - Math.log(5)) / 0.3) / (0.3 * x), 4, 7), 6);
    expect(probabilityIn(lg, -3, 0)).toBe(0);
    const un: Distribution = { kind: "uniform", min: 2, max: 6 };
    expect(probabilityIn(un, 3, 5)).toBe(0.5);
    expect(probabilityIn(un, 7, 8)).toBe(0);
    expect(probabilityIn({ kind: "constant", value: 4 }, 3, 5)).toBe(1);
    expect(probabilityIn({ kind: "constant", value: 4 }, 5, 6)).toBe(0);
  });
  it("keptFractions: a normal of mean 100 and sd 45 loses Phi(-100/45) of its draws below 1e-3 (a thickness of zero or less), by the CDF written out", () => {
    const k = keptFractions({ kind: "normal", mean: 100e-6, stdDev: 45e-6 }, "buffer");
    expect(Math.abs(k.lossToRange - simpson(phi, -9, (0.001 - 100) / 45, 4000))).toBeLessThan(5e-7); // the lower bound of a thickness is 1 nm, 0.001 um
    expect(k.inTruncation).toBeCloseTo(1, 12);
  });
  it("the valid ranges are the validator's own bounds", () => {
    expect(POPULATION_LENGTH_RANGE).toEqual([RADIUS_MIN, RADIUS_MAX]);
    expect(POPULATION_TEMPERATURE_RANGE[1]).toBe(HISTORY_TEMPERATURE_MAX);
    expect(POPULATION_FACTOR_RANGE[0]).toBe(0);
  });
});

describe("drawing from a distribution", () => {
  const n = 100000;
  const draw = (d: Distribution, seed = 5) => {
    const g = new Rng(seed);
    return Array.from({ length: n }, () => drawFrom(d, g));
  };
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = (a: number[]) => Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / (a.length - 1));
  it("a constant is that value and draws nothing from the generator", () => {
    const g = new Rng(5);
    expect(drawFrom({ kind: "constant", value: 3.5 }, g)).toBe(3.5);
    expect(g.next32()).toBe(new Rng(5).next32());
  });
  it("a uniform lies in [min, max] with mean (min + max) / 2 and sd (max - min) / sqrt(12)", () => {
    const xs = draw({ kind: "uniform", min: 2, max: 6 });
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...xs)).toBeLessThan(6);
    expect(Math.abs(mean(xs) - 4)).toBeLessThan((4 * (4 / Math.sqrt(12))) / Math.sqrt(n));
    expect(Math.abs(sd(xs) - 4 / Math.sqrt(12))).toBeLessThan(0.02);
  });
  it("a normal has its mean and sd", () => {
    const xs = draw({ kind: "normal", mean: 7, stdDev: 1.5 });
    expect(Math.abs(mean(xs) - 7)).toBeLessThan((4 * 1.5) / Math.sqrt(n));
    expect(Math.abs(sd(xs) - 1.5)).toBeLessThan(4 * 1.5 * Math.sqrt(0.5 / n));
  });
  it("a lognormal has the median and the sigma of ln x that were given", () => {
    const xs = draw({ kind: "lognormal", median: 5, sigmaLog: 0.2 });
    const l = xs.map(Math.log);
    expect(Math.abs(mean(l) - Math.log(5))).toBeLessThan((4 * 0.2) / Math.sqrt(n));
    expect(Math.abs(sd(l) - 0.2)).toBeLessThan(4 * 0.2 * Math.sqrt(0.5 / n));
    expect(xs.filter((x) => x < 5).length / n).toBeCloseTo(0.5, 2);
  });
  it("a truncated normal stays inside its range and has the mean of the truncated law, mu + sigma (phi(a) - phi(b)) / (Phi(b) - Phi(a))", () => {
    const xs = draw({ kind: "normal", mean: 10, stdDev: 2, truncate: { min: 9, max: 13 } });
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(9);
    expect(Math.max(...xs)).toBeLessThanOrEqual(13);
    const a = (9 - 10) / 2;
    const b = (13 - 10) / 2;
    const want = 10 + (2 * (phi(a) - phi(b))) / (normalCdf(b) - normalCdf(a));
    expect(Math.abs(mean(xs) - want)).toBeLessThan((4 * 1.2) / Math.sqrt(n));
    expect(Math.abs(mean(draw({ kind: "normal", mean: 10, stdDev: 2, truncate: { min: 12 } })) - (10 + (2 * phi(1)) / (1 - normalCdf(1))))).toBeLessThan(0.02);
  });
  it("a truncation that nothing can satisfy gives up with a RangeError after its tries", () => {
    expect(() => drawFrom({ kind: "normal", mean: 0, stdDev: 1, truncate: { min: 40 } }, new Rng(1))).toThrow(RangeError);
  });
});

describe("statistics", () => {
  it("percentile interpolates linearly between the order statistics at position (n - 1) p, worked by hand on [10, 20, 30, 40, 50]", () => {
    const a = [10, 20, 30, 40, 50];
    expect(percentile(a, 0)).toBe(10);
    expect(percentile(a, 0.05)).toBeCloseTo(12, 12); // position 0.2
    expect(percentile(a, 0.5)).toBe(30);
    expect(percentile(a, 0.95)).toBeCloseTo(48, 12); // position 3.8
    expect(percentile(a, 0.99)).toBeCloseTo(49.6, 12); // position 3.96
    expect(percentile(a, 1)).toBe(50);
    expect(percentile([7], 0.99)).toBe(7);
    expect(() => percentile([], 0.5)).toThrow(RangeError);
  });
  it("statOf is the mean, the sample sd (n - 1), the extremes and the percentiles of the sorted list, by hand on [4, 1, 3, 2, 10]", () => {
    const s = statOf([4, 1, 3, 2, 10]);
    expect(s.mean).toBe(4);
    expect(s.stdDev).toBeCloseTo(Math.sqrt((0 + 9 + 1 + 4 + 36) / 4), 12);
    expect([s.min, s.max, s.p50]).toEqual([1, 10, 3]);
    expect(s.p5).toBeCloseTo(1.2, 12); // sorted 1 2 3 4 10: position 0.2 between 1 and 2
    expect(s.p95).toBeCloseTo(4 + 0.8 * 6, 12);
    expect(s.p99).toBeCloseTo(4 + 0.96 * 6, 12);
    expect(statOf([5]).stdDev).toBe(0);
  });
  it("the histogram has equal bins over [min, max], the maximum in the last bin, and one bin for equal values", () => {
    const h = histogramOf([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(h.edges).toEqual([0, 2, 4, 6, 8, 10]);
    expect(h.counts).toEqual([2, 2, 2, 2, 3]); // 0,1 | 2,3 | 4,5 | 6,7 | 8,9,10
    expect(histogramOf([3, 3, 3]).counts).toEqual([3]);
    expect(histogramOf([1, 2, 3, 4]).counts).toHaveLength(POPULATION_BINS);
    expect(histogramOf([1, 2, 3, 4]).counts.reduce((a, b) => a + b, 0)).toBe(4);
  });
});

describe("a population through the closed form of the sphere", () => {
  it("a population of constants is the single particle: the peak and every drop are the closed form of the case's own particle", () => {
    const n = ok({ size: 3, seed: 1, distributions: { kernelRadius: { kind: "constant", value: q(250, "um") }, powerFactor: { kind: "constant", value: q(1, "1") } } });
    const r = runPopulation(n);
    const cf = trisoClosedForm({ ...n, population: undefined });
    for (const s of r.quantities) expect(s.stat.min).toBeCloseTo(s.stat.max, 9);
    expect(r.quantities[0]!.stat.mean).toBeCloseTo(cf.centreT, 9);
    expect(r.quantities.find((x) => x.id === "drop:buffer")!.stat.mean).toBeCloseTo(cf.regions[1]!.innerT - cf.regions[1]!.outerT, 9);
    expect(r.quantities.find((x) => x.id === "drop:gap")!.stat.mean).toBeCloseTo(cf.gapDeltaT, 9);
    expect(r.nominal.kernelPeakT).toBeCloseTo(cf.centreT, 12);
    expect(r.quantities.map((x) => x.stat.stdDev).every((s) => s < 1e-9)).toBe(true);
    // and the same by arithmetic written here
    expect(cf.centreT).toBeCloseTo(hand(R0, T0, 1, 1000).peak, 9);
    expect(r.rejected.total).toBe(0);
  });
  it("an empty set of distributions is the case's particle size times over, and the compact form of the power gives the same particle", () => {
    const c = vec("triso-compact");
    c.population = { size: 4, seed: 9, distributions: {} };
    const n = norm(c);
    const r = runPopulation(n);
    expect(r.quantities[0]!.stat.max - r.quantities[0]!.stat.min).toBeLessThan(1e-9);
    expect(r.quantities[0]!.stat.mean).toBeCloseTo(trisoClosedForm({ ...n, population: undefined }).centreT, 9);
  });
  it("every sampled particle's peak and drops are the closed form written out here at the drawn values (power factor, radius, thicknesses and wall all spread)", () => {
    const pop = { size: 300, seed: 31337, distributions: { kernelRadius: N(250, 8), buffer: N(100, 10), ipyc: N(40, 3), sic: N(35, 2), opyc: N(35, 3), powerFactor: { kind: "lognormal", median: q(1, "1"), sigmaLog: q(0.15, "1") }, matrixTemperature: N(1000, 20, "K") } };
    const n = ok(pop);
    const r = runPopulation(n, { keepSamples: true });
    // replay the draws with the generator (verified above) in the documented order: radius, buffer, ipyc, sic, opyc, factor, wall
    const g = new Rng(31337);
    const mine: number[] = [];
    const bufferDrops: number[] = [];
    for (let i = 0; i < 300; i++) {
      const R = 250e-6 + 8e-6 * g.normal();
      const t = [100e-6 + 10e-6 * g.normal(), 40e-6 + 3e-6 * g.normal(), 35e-6 + 2e-6 * g.normal(), 35e-6 + 3e-6 * g.normal()];
      const f = Math.exp(Math.log(1) + 0.15 * g.normal());
      const Tm = 1000 + 20 * g.normal();
      const h = hand(R, t, f, Tm);
      mine.push(h.peak);
      bufferDrops.push(h.drops[0]!);
    }
    expect(r.rejected.total).toBe(0);
    r.samples!.forEach((x, i) => expect(Math.abs(x - mine[i]!)).toBeLessThan(1e-9));
    expect(r.quantities.find((x) => x.id === "drop:buffer")!.stat.mean).toBeCloseTo(bufferDrops.reduce((a, b) => a + b, 0) / 300, 9);
  });
  it("the same case gives the same result twice, and another seed another sample", () => {
    const pop = (seed: number) => ({ size: 200, seed, distributions: { powerFactor: { kind: "uniform", min: q(0.8, "1"), max: q(1.2, "1") }, kernelRadius: N(250, 5) } });
    const a = runPopulation(ok(pop(11)), { keepSamples: true });
    const b = runPopulation(ok(pop(11)), { keepSamples: true });
    const c = runPopulation(ok(pop(12)), { keepSamples: true });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(c.samples).not.toEqual(a.samples);
    expect(c.quantities[0]!.stat.mean).not.toBe(a.quantities[0]!.stat.mean);
  });
  it("the sampled mean of the kernel temperature is the mean particle's value plus the Jensen correction (quadrature of the closed form over the normal law of the radius), not the mean particle's alone", () => {
    const sd = 30;
    const n = 100000;
    const r = runPopulation(ok({ size: n, seed: 424242, distributions: { kernelRadius: N(250, sd) } }, "3000"));
    expect(r.rejected.total).toBe(0);
    const s = sd * 1e-6;
    const f = (R: number) => hand(R, T0, 1, 1000, 3000e6).peak;
    const pdf = (R: number) => phi((R - R0) / s) / s;
    const lo = R0 - 6 * s;
    const hi = R0 + 6 * s;
    const E = simpson((R) => f(R) * pdf(R), lo, hi, 4000);
    const E2 = simpson((R) => f(R) ** 2 * pdf(R), lo, hi, 4000);
    const sdT = Math.sqrt(E2 - E * E);
    const se = sdT / Math.sqrt(n);
    const nominalValue = f(R0);
    const mean = r.quantities[0]!.stat.mean;
    expect(Math.abs(mean - E)).toBeLessThan(4 * se); // the sampled mean is the mean over the law
    expect(E - nominalValue).toBeGreaterThan(7 * se); // the correction is large next to the sampling error, so the test can tell it from the mean particle
    expect(Math.abs(mean - nominalValue)).toBeGreaterThan(4 * se); // the mean particle's value alone is rejected
    expect(Math.abs(r.quantities[0]!.stat.stdDev - sdT)).toBeLessThan(0.02 * sdT);
    expect(r.nominal.kernelPeakT).toBeCloseTo(nominalValue, 9);
  }, 60000);
  it("the percentiles are those of the sorted list worked by hand: 21 particles with the power factor uniform on [0.8, 1.2], replayed with the generator", () => {
    const r = runPopulation(ok({ size: 21, seed: 77, distributions: { powerFactor: { kind: "uniform", min: q(0.8, "1"), max: q(1.2, "1") } } }), { keepSamples: true });
    const g = new Rng(77);
    const vals = Array.from({ length: 21 }, () => hand(R0, T0, 0.8 + 0.4 * g.uniform(), 1000).peak).sort((a, b) => a - b);
    const s = r.quantities[0]!.stat;
    expect(s.p50).toBeCloseTo(vals[10]!, 9); // position 10 of 0..20
    expect(s.p5).toBeCloseTo(vals[1]!, 9); // position 1
    expect(s.p95).toBeCloseTo(vals[19]!, 9); // position 19
    expect(s.p99).toBeCloseTo(vals[19]! + 0.8 * (vals[20]! - vals[19]!), 9); // position 19.8
    expect([s.min, s.max]).toEqual([vals[0], vals[20]].map((x) => expect.closeTo(x!, 9)));
    expect(r.maximum.kernelPeakT).toBeCloseTo(vals[20]!, 9);
    expect(r.representatives.find((x) => x.role === "coldest")!.kernelPeakT).toBeCloseTo(vals[0]!, 9);
    expect(r.representatives.find((x) => x.role === "median")!.kernelPeakT).toBeCloseTo(vals[10]!, 9);
    // the histogram counts every particle once
    expect(r.histogram.counts.reduce((a, b) => a + b, 0)).toBe(21);
    expect(r.histogram.edges[0]).toBeCloseTo(vals[0]!, 9);
    expect(r.histogram.edges[POPULATION_BINS]).toBeCloseTo(vals[20]!, 9);
  });
  it("the maximum is the hottest sampled particle and carries its parameters: the radius, the thicknesses, the factor and the wall that reproduce its peak by hand", () => {
    const r = runPopulation(ok({ size: 400, seed: 5, distributions: { kernelRadius: N(250, 10), buffer: N(100, 12), powerFactor: { kind: "lognormal", median: q(1, "1"), sigmaLog: q(0.1, "1") } } }), { keepSamples: true });
    expect(r.maximum.role).toBe("hottest");
    expect(r.maximum.kernelPeakT).toBe(Math.max(...r.samples!));
    expect(r.samples![r.maximum.index]).toBe(r.maximum.kernelPeakT);
    const d = r.maximum.draw;
    expect(hand(d.kernelRadius, d.thicknesses, d.powerFactor, d.matrixTemperature).peak).toBeCloseTo(r.maximum.kernelPeakT, 9);
    expect(r.maximum.particlePower).toBeCloseTo(hand(d.kernelRadius, d.thicknesses, d.powerFactor, d.matrixTemperature).P, 12);
    // the thick-buffer and thin-SiC picks are the extremes of those thicknesses in the sample
    expect(r.representatives.map((x) => x.role)).toEqual(["hottest", "median", "coldest", "thickestBuffer", "thinnestSic"]);
  });
  it("counts the draws that are not valid particles and keeps drawing: a buffer of 100 +- 45 um loses Phi(-100/45) of its draws, and every kept buffer is positive", () => {
    const n = 20000;
    const r = runPopulation(ok({ size: n, seed: 8, distributions: { buffer: N(100, 45) } }), { keepSamples: true });
    const p = normalCdf((0.001 - 100) / 45); // a thickness below 1 nm (0.001 um) is not a layer
    const expected = (n * p) / (1 - p);
    expect(r.rejected.byReason.geometry).toBe(r.rejected.total);
    expect(Math.abs(r.rejected.total - expected)).toBeLessThan(4 * Math.sqrt(expected / (1 - p)));
    expect(r.rejected.total).toBeGreaterThan(100);
    expect(r.samples).toHaveLength(n);
    // the validator says so too
    expect(validateCase(particle({ size: n, seed: 8, distributions: { buffer: N(100, 45) } })).warnings.map((w) => w.code)).toEqual(["W_POPULATION_REJECTION"]);
  });
  it("stops with the reason when most draws fail: four layers each keeping 2 % of their draws are almost never a particle", () => {
    const thin = { kind: "normal", mean: q(-1.0, "um"), stdDev: q(0.5, "um") }; // valid (>= 1 nm) with probability Phi(-2)... = 2.3 %
    const n = ok({ size: 50, seed: 3, distributions: { buffer: thin, ipyc: thin, sic: thin, opyc: thin } });
    expect(() => runPopulation(n)).toThrow(/too many particles that are not valid/);
    try {
      runPopulation(n);
    } catch (e) {
      expect(e).toBeInstanceOf(RangeError);
      expect(String((e as Error).message)).toMatch(/geometry \d+/);
    }
  });
  it("a temperature below zero is a rejected draw of its own kind, and a power factor of zero or less too", () => {
    const r = runPopulation(ok({ size: 2000, seed: 4, distributions: { matrixTemperature: { kind: "normal", mean: q(30, "K"), stdDev: q(20, "K") }, powerFactor: { kind: "normal", mean: q(1, "1"), stdDev: q(0.6, "1") } } }));
    expect(r.rejected.byReason.matrixTemperature).toBeGreaterThan(0);
    expect(r.rejected.byReason.powerFactor).toBeGreaterThan(0);
    expect(r.rejected.byReason.geometry).toBe(0);
    expect(r.rejected.total).toBe(r.rejected.byReason.matrixTemperature + r.rejected.byReason.powerFactor + r.rejected.byReason.noClosedForm);
  });
  it("the fraction above a limit counts the particles whose region passes it: the kernel against the sorted samples, the SiC against the closed form of each drawn particle", () => {
    const pop = { size: 1000, seed: 21, distributions: { kernelRadius: N(250, 10), powerFactor: { kind: "lognormal", median: q(1, "1"), sigmaLog: q(0.1, "1") }, matrixTemperature: N(1000, 10, "K") } };
    const c = particle(pop);
    c.limits = [
      { name: "kernel", region: "kernel", maxTemperature: q(1011, "K"), source: "synthetic: a number chosen for this test" },
      { name: "sic", region: "sic", maxTemperature: q(1010, "K"), source: "synthetic: a number chosen for this test" },
    ];
    const n = norm(c);
    const r = runPopulation(n, { keepSamples: true });
    const above = r.samples!.filter((x) => x > 1011).length;
    expect(r.limits[0]).toMatchObject({ name: "kernel", region: "kernel", above, fraction: above / 1000 });
    expect(above).toBeGreaterThan(20);
    expect(above).toBeLessThan(980);
    const g = new Rng(21);
    let sicAbove = 0;
    for (let i = 0; i < 1000; i++) {
      const R = 250e-6 + 10e-6 * g.normal();
      const f = Math.exp(0.1 * g.normal());
      const Tm = 1000 + 10 * g.normal();
      const h = hand(R, T0, f, Tm);
      // the SiC's hottest point is its inner face: the wall plus the drop across the outer carbon plus the SiC's own
      if (Tm + h.drops[3]! + h.drops[2]! > 1010) sicAbove++;
    }
    expect(r.limits[1]).toMatchObject({ name: "sic", region: "sic", above: sicAbove });
    expect(sicAbove).toBeGreaterThan(20);
    expect(sicAbove).toBeLessThan(980);
    expect(runPopulation(norm(particle(pop))).limits).toEqual([]);
  });
  it("the particle of a draw has the drawn radii, the power density times the factor on the drawn kernel volume, and the drawn wall; the convective form keeps its film", () => {
    const n = ok({ size: 1, seed: 1, distributions: {} });
    const d = { ...nominalDraw(n), kernelRadius: 260e-6, thicknesses: [90e-6, 45e-6, 30e-6, 38e-6], powerFactor: 1.25, matrixTemperature: 1020 };
    const p = particleOf(n, d);
    expect(p.kernelRadius).toBe(260e-6);
    expect(p.layers.map((l) => [l.innerRadius, l.outerRadius])).toEqual([[260e-6, 350e-6], [350e-6, 395e-6], [395e-6, 425e-6], [425e-6, 463e-6]].map(([a, b]) => [expect.closeTo(a!, 12), expect.closeTo(b!, 12)]));
    expect(p.outerRadius).toBeCloseTo(463e-6, 12);
    expect(p.power.kernelPowerDensity).toBeCloseTo(750e6, 3);
    expect(p.power.particlePower).toBeCloseTo(750e6 * (4 / 3) * PI * 260e-6 ** 3, 12);
    expect(p.boundary).toEqual({ kind: "surface-temperature", surfaceTemperature: 1020 });
    const conv = norm({ ...vec("triso-convective-outside"), population: { size: 1, seed: 1, distributions: {} } });
    const pc = particleOf(conv, { ...nominalDraw(conv), matrixTemperature: 880 });
    expect(pc.boundary).toEqual({ kind: "convective", bulkTemperature: 880, heatTransferCoefficient: 2000 });
    // the film's drop is the power over the outer area times the coefficient, at the drawn outer radius
    expect(trisoClosedForm(pc).filmDeltaT).toBeCloseTo(pc.power.particlePower / (4 * PI * pc.outerRadius ** 2 * 2000), 12);
  });
  it("particleDocument writes the drawn particle as a case that validates to the same particle, with no population section", () => {
    const c = particle({ size: 5, seed: 2, distributions: { kernelRadius: N(250, 10), powerFactor: { kind: "uniform", min: q(0.9, "1"), max: q(1.1, "1") }, matrixTemperature: N(1000, 10, "K") } });
    const n = norm(c);
    const r = runPopulation(n);
    const d = r.maximum.draw;
    const doc = particleDocument(c, n, d);
    expect(doc.population).toBeUndefined();
    const back = norm(doc);
    const want = particleOf(n, d);
    expect(back.kernelRadius).toBeCloseTo(want.kernelRadius, 15);
    expect(back.outerRadius).toBeCloseTo(want.outerRadius, 12);
    expect(back.power.particlePower).toBeCloseTo(want.power.particlePower, 15);
    expect(trisoClosedForm(back).centreT).toBeCloseTo(r.maximum.kernelPeakT, 6);
    // the original document is not changed
    expect(c.population).toBeDefined();
    expect(c.geometry.kernelRadius).toEqual(q(250, "um"));
  });
});

describe("negative controls: a wrong population or a wrong reading fails the same checks", () => {
  const spec = { size: 20000, seed: 90, distributions: { buffer: N(100, 15), sic: N(35, 1) } };
  /** The check the tests above make, as a function: the mean of a drop against the quadrature of the closed form over the intended law. */
  function meanDropOf(result: PopulationResult, id: string) {
    return result.quantities.find((x) => x.id === id)!.stat.mean;
  }
  const intendedBufferDrop = () => {
    const s = 15e-6;
    return simpson((t) => hand(R0, [t, T0[1]!, T0[2]!, T0[3]!], 1, 1000).drops[0]! * (phi((t - 100e-6) / s) / s), 100e-6 - 6 * s, 100e-6 + 6 * s, 2000);
  };
  it("the intended population passes: the buffer drop's mean is the quadrature over the buffer's law, within 4 standard errors", () => {
    const r = runPopulation(ok(spec));
    const s = r.quantities.find((x) => x.id === "drop:buffer")!.stat;
    expect(Math.abs(s.mean - intendedBufferDrop())).toBeLessThan((4 * s.stdDev) / Math.sqrt(20000));
  });
  it("a swapped distribution (the buffer's law given to the SiC, the SiC's to the buffer) fails that check", () => {
    const r = runPopulation(ok({ ...spec, distributions: { buffer: spec.distributions.sic, sic: spec.distributions.buffer } }));
    const s = r.quantities.find((x) => x.id === "drop:buffer")!.stat;
    expect(Math.abs(s.mean - intendedBufferDrop())).toBeGreaterThan((4 * s.stdDev) / Math.sqrt(20000));
  });
  it("a read of the wrong layer (the inner carbon's drop where the buffer's was meant) fails that check", () => {
    const r = runPopulation(ok(spec));
    const s = r.quantities.find((x) => x.id === "drop:ipyc")!.stat;
    expect(Math.abs(meanDropOf(r, "drop:ipyc") - intendedBufferDrop())).toBeGreaterThan((4 * s.stdDev) / Math.sqrt(20000));
    expect(r.quantities.map((x) => x.id)).toContain("drop:buffer");
  });
  it("a kernel-only particle volume used for the power (the wrong volume) would move the peak by far more than the tolerance: the power in the batch is the kernel density times the DRAWN kernel volume", () => {
    const r = runPopulation(ok({ size: 50, seed: 6, distributions: { kernelRadius: N(250, 20) } }), { keepSamples: true });
    const g = new Rng(6);
    const wrong = Array.from({ length: 50 }, () => {
      const R = 250e-6 + 20e-6 * g.normal();
      return hand(250e-6, T0, (R / 250e-6) ** 3, 1000).peak; // the power of the drawn kernel, but every radius the nominal
    });
    const maxDiff = Math.max(...r.samples!.map((x, i) => Math.abs(x - wrong[i]!)));
    expect(maxDiff).toBeGreaterThan(0.1);
  });
});

describe("a case without a population, and a case with one", () => {
  const goods = ["triso-steady", "triso-particle-power", "triso-compact", "triso-convective-outside", "triso-two-layers", "triso-temperature-dependent", "triso-limits", "triso-pulse", "triso-pulse-limits"];
  it("the population section changes nothing else of the normalised particle: the case with and without it are the same particle to the last digit", () => {
    for (const name of goods.filter((g) => !g.includes("pulse"))) {
      const plain = vec(name);
      const withPop = { ...vec(name), population: { size: 10, seed: 3, distributions: { buffer: N(100, 5) } } };
      const a = norm(plain);
      const { population, ...b } = norm(withPop);
      expect(population).toBeDefined();
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect("population" in a).toBe(false);
    }
  });
  it("a case without the section normalises to the very particle the saved real runs were made with (tests/golden/offbeat-triso/*/normalized.json), byte for byte", () => {
    for (const [vector, golden, power] of [["triso-steady", "steady", undefined], ["triso-convective-outside", "film", 3000], ["triso-two-layers", "two-layers", 3000], ["triso-temperature-dependent", "temperature-dependent", undefined], ["triso-limits", "limits", undefined]] as const) {
      const d = vec(vector);
      if (power) d.power = { kernelPowerDensity: q(power, "MW/m3") };
      const saved = JSON.parse(readFileSync(join(root, "tests/golden/offbeat-triso", golden, "normalized.json"), "utf8"));
      delete saved.kind; // the run manager adds the kind to the file it saves
      expect(JSON.stringify(norm(d)), vector).toBe(JSON.stringify(saved));
    }
  });
  it("running a case with a population runs the nominal particle: the files written for OFFBEAT are the same with and without the section", () => {
    const plain = norm(vec("triso-steady"));
    const withPop = norm({ ...vec("triso-steady"), population: { size: 10, seed: 3, distributions: { buffer: N(100, 5), powerFactor: { kind: "uniform", min: q(0.8, "1"), max: q(1.2, "1") } } } });
    expect(JSON.stringify(writeTrisoCase(withPop))).toBe(JSON.stringify(writeTrisoCase(plain)));
  });
  it("every example and vector of the earlier milestones still validates to a particle with no population key", () => {
    for (const f of ["examples/synthetic-triso-compact-steady.json", "examples/synthetic-triso-compact-pulse.json"]) {
      const v = validateCase(read(f));
      expect(v.errors).toEqual([]);
      expect(v.triso && "population" in v.triso).toBe(false);
    }
  });
  it("the example population validates, runs, and its numbers are stable (hash of the sample)", () => {
    const n = norm(read("examples/synthetic-triso-population.json"));
    const r = runPopulation(n, { keepSamples: true });
    expect(r.size).toBe(2000);
    expect(r.rejected.total).toBe(0);
    const h = createHash("sha256").update(r.samples!.map((x) => x.toPrecision(12)).join(",")).digest("hex");
    expect(h).toBe(EXAMPLE_SAMPLE_HASH);
  });
});
const EXAMPLE_SAMPLE_HASH = "40617ad8e0e857a98b1ce60583071d7a642a4e4ff1d0b82c5138ed60800aed7d";

describe("the size cap and the worker", () => {
  it("a population is at most 100000 particles", () => {
    expect(POPULATION_MAX_SIZE).toBe(100000);
    expect(validateCase({ ...vec("triso-steady"), population: { size: 100000, seed: 1, distributions: {} } }).errors).toEqual([]);
  });
});
