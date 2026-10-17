// Mutation run for plan 13, milestone T6 (the population: the generator, the distributions, the batch and its statistics, the case's section).
// usage: node scripts/mut-triso-t6.cjs [name regex]   (MUT_RANGE=0-20 for a piece of the list; MUT_CHECK=1 only checks the anchors)
//            (commit first and keep a green baseline; check no other process has "mut-" in its command line)
// Each mutant is [file, from, to, name]: `from` is a unique single-line anchor in `file`. The file is changed, the focus tests are run, and the file is restored from the copy read before
// (never from git, so uncommitted work is safe). A mutant is KILLED when the run exits non-zero AND prints a "Tests N ... " summary; it SURVIVES when the run exits 0; a run with no summary
// line is BROKEN (a crashed run must not count as a kill). The worker tests (tests/populationWorker.test.ts) run the compiled dist/ and are left out of the focus on purpose.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const FOCUS = ["tests/trisoPopulation.test.ts", "tests/validate.test.ts"];
const T = "src/core/trisoPopulation.ts";
const C = "src/core/trisoPopulationCase.ts";
const V = "src/core/validate.ts";

const mutants = [
  // ---- the generator
  [T, "const a = (state + 0x9e3779b9) | 0;", "const a = (state + 0x9e3779b8) | 0;", "splitmix increment"],
  [T, "let t = a ^ (a >>> 16);\n  t = Math.imul(t, 0x21f0aaad);", "let t = a ^ (a >>> 15);\n  t = Math.imul(t, 0x21f0aaad);", "splitmix first shift"],
  [T, "t = Math.imul(t, 0x21f0aaad);", "t = Math.imul(t, 0x21f0aaac);", "splitmix first multiplier"],
  [T, "t = Math.imul(t, 0x735a2d97);", "t = Math.imul(t, 0x735a2d96);", "splitmix second multiplier"],
  [T, "for (let i = 0; i < 4; i++) {\n      const [next, out] = splitmix32(st);", "for (let i = 0; i < 3; i++) {\n      const [next, out] = splitmix32(st);", "three seed words"],
  [T, "let st = seed | 0;", "let st = (seed + 1) | 0;", "seed offset"],
  [T, "const r = Math.imul(this.s1, 5);", "const r = Math.imul(this.s1, 7);", "xoshiro multiplier 5"],
  [T, "const result = Math.imul((r << 7) | (r >>> 25), 9) >>> 0;", "const result = Math.imul((r << 8) | (r >>> 24), 9) >>> 0;", "xoshiro rotation 7"],
  [T, "const result = Math.imul((r << 7) | (r >>> 25), 9) >>> 0;", "const result = Math.imul((r << 7) | (r >>> 25), 8) >>> 0;", "xoshiro multiplier 9"],
  [T, "const t = this.s1 << 9;", "const t = this.s1 << 10;", "xoshiro shift 9"],
  [T, "this.s2 ^= this.s0;\n    this.s3 ^= this.s1;", "this.s3 ^= this.s1;", "xoshiro s2 update dropped"],
  [T, "this.s0 ^= this.s3;\n    this.s2 ^= t;", "this.s0 ^= this.s2;\n    this.s2 ^= t;", "xoshiro s0 update"],
  [T, "this.s3 = (this.s3 << 11) | (this.s3 >>> 21);", "this.s3 = (this.s3 << 12) | (this.s3 >>> 20);", "xoshiro rotation 11"],
  [T, "const hi = this.next32() >>> 5; // 27 bits", "const hi = this.next32() >>> 6; // 27 bits", "uniform high bits"],
  [T, "const lo = this.next32() >>> 6; // 26 bits", "const lo = this.next32() >>> 7; // 26 bits", "uniform low bits"],
  [T, "return (hi * 67108864 + lo + 0.5) / 9007199254740992;", "return (hi * 67108864 + lo) / 9007199254740992;", "uniform can be 0"],
  [T, "return (hi * 67108864 + lo + 0.5) / 9007199254740992;", "return (hi * 33554432 + lo + 0.5) / 9007199254740992;", "uniform weight of the high part"],
  [T, "return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);", "return Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);", "Box-Muller sine"],
  [T, "return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);", "return Math.sqrt(-Math.log(u1)) * Math.cos(2 * Math.PI * u2);", "Box-Muller radius"],
  [T, "if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw", "if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff) throw", "seed 0 refused"],
  [T, "if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw", "if (!Number.isInteger(seed) || seed < 0 || seed >= 0xffffffff) throw", "seed 2^32-1 refused"],
  // ---- the normal CDF
  [T, "export const normalCdf = (x: number): number => 0.5 * erfc(-x / Math.SQRT2);", "export const normalCdf = (x: number): number => 0.5 * erfc(x / Math.SQRT2);", "CDF mirrored"],
  [T, "return x >= 0 ? r : 2 - r;", "return r;", "erfc of a negative number"],
  [T, "const t = 1 / (1 + 0.5 * z);", "const t = 1 / (1 + 0.4 * z);", "erfc t"],
  [T, "z * z - 1.26551223 + t", "z * z - 1.2655 + t", "erfc constant"],
  [T, "t * (0.27886807 + t * (-1.13520398", "t * (0.27886807 + t * (-1.1352", "erfc coefficient"],
  // ---- the ranges and the distributions
  [T, "export const POPULATION_MAX_SIZE = 100000;", "export const POPULATION_MAX_SIZE = 10000;", "size cap"],
  [T, "export const POPULATION_MIN_ACCEPTANCE = 0.01;", "export const POPULATION_MIN_ACCEPTANCE = 0.001;", "acceptance threshold"],
  [T, "export const POPULATION_WARN_LOSS = 0.01;", "export const POPULATION_WARN_LOSS = 0.1;", "warning threshold"],
  [T, "export const POPULATION_REJECTION_FACTOR = 10;", "export const POPULATION_REJECTION_FACTOR = 1000;", "rejection allowance"],
  [T, "export const POPULATION_FACTOR_RANGE: [number, number] = [0, 100];", "export const POPULATION_FACTOR_RANGE: [number, number] = [0, 1000];", "power factor upper bound"],
  [T, "export const POPULATION_TEMPERATURE_RANGE: [number, number] = [0, 1e4];", "export const POPULATION_TEMPERATURE_RANGE: [number, number] = [0, 1e5];", "temperature upper bound"],
  [T, "return v === \"powerFactor\" ? POPULATION_FACTOR_RANGE : v === \"matrixTemperature\" ? POPULATION_TEMPERATURE_RANGE : POPULATION_LENGTH_RANGE;", "return v === \"powerFactor\" ? POPULATION_TEMPERATURE_RANGE : v === \"matrixTemperature\" ? POPULATION_FACTOR_RANGE : POPULATION_LENGTH_RANGE;", "valid ranges swapped"],
  [T, "return d.min + (d.max - d.min) * rng.uniform();", "return d.min + d.max * rng.uniform();", "uniform draw"],
  [T, "const x = d.kind === \"normal\" ? d.mean + d.stdDev * z : Math.exp(Math.log(d.median) + d.sigmaLog * z);", "const x = d.kind === \"normal\" ? d.mean + d.stdDev * z : Math.exp(Math.log(d.median) - d.sigmaLog * z);", "lognormal sign"],
  [T, "const x = d.kind === \"normal\" ? d.mean + d.stdDev * z : Math.exp(Math.log(d.median) + d.sigmaLog * z);", "const x = d.kind === \"normal\" ? d.mean - d.stdDev * z : Math.exp(Math.log(d.median) + d.sigmaLog * z);", "normal sign"],
  [T, "const x = d.kind === \"normal\" ? d.mean + d.stdDev * z : Math.exp(Math.log(d.median) + d.sigmaLog * z);", "const x = d.kind === \"normal\" ? d.mean + d.stdDev * z : Math.exp(d.median + d.sigmaLog * z);", "lognormal median not logged"],
  [T, "if (x >= lo && x <= hi) return x;", "if (x > lo && x < hi) return x;", "truncation bounds exclusive"],
  [T, "if (x >= lo && x <= hi) return x;", "if (x >= lo || x <= hi) return x;", "truncation either bound"],
  [T, "const lo = d.truncate?.min ?? -Infinity;\n      const hi = d.truncate?.max ?? Infinity;", "const lo = d.truncate?.min ?? 0;\n      const hi = d.truncate?.max ?? Infinity;", "no lower truncation means zero"],
  [T, "for (let i = 0; i < POPULATION_MAX_TRIES; i++) {", "for (let i = 0; i < 1; i++) {", "one try only"],
  [T, "return d.value >= lo && d.value <= hi ? 1 : 0;", "return 1;", "constant probability"],
  [T, "return b > a ? (b - a) / (d.max - d.min) : 0;", "return b > a ? (b - a) : 0;", "uniform probability not scaled"],
  [T, "return hi <= lo ? 0 : normalCdf((hi - d.mean) / d.stdDev) - normalCdf((lo - d.mean) / d.stdDev);", "return hi <= lo ? 0 : normalCdf((hi - d.mean) / d.stdDev) + normalCdf((lo - d.mean) / d.stdDev);", "normal probability sum"],
  [T, "return hi <= lo ? 0 : normalCdf((hi - d.mean) / d.stdDev) - normalCdf((lo - d.mean) / d.stdDev);", "return hi <= lo ? 0 : normalCdf((hi - d.mean) / d.stdDev) - normalCdf((lo - d.mean) / d.mean);", "normal probability scale"],
  [T, "if (hi <= lo || !(hi > 0)) return 0;", "if (hi <= lo) return 0;", "lognormal probability below zero"],
  [T, "const cdf = (x: number) => (x <= 0 ? 0 : normalCdf((Math.log(x) - Math.log(d.median)) / d.sigmaLog));", "const cdf = (x: number) => (x <= 0 ? 0 : normalCdf((Math.log(x) - Math.log(d.median)) * d.sigmaLog));", "lognormal probability scale"],
  [T, "return { inTruncation, valid, lossToRange: inTruncation > 0 ? 1 - valid / inTruncation : 1 };", "return { inTruncation, valid, lossToRange: inTruncation > 0 ? 1 - valid : 1 };", "loss not relative to the truncation"],
  [T, "const valid = probabilityIn(d, Math.max(tl, rl), Math.min(th, rh));", "const valid = probabilityIn(d, tl, th);", "valid range ignored"],
  // ---- the particles
  [T, "thicknesses: n.layers.map((l) => l.outerRadius - l.innerRadius),", "thicknesses: n.layers.map((l) => l.outerRadius),", "nominal thickness"],
  [T, "powerFactor: 1,\n    matrixTemperature:", "powerFactor: 2,\n    matrixTemperature:", "nominal power factor"],
  [T, "const kernelPowerDensity = n.power.kernelPowerDensity * d.powerFactor;", "const kernelPowerDensity = n.power.kernelPowerDensity / d.powerFactor;", "power factor divides"],
  [T, "const particlePower = kernelPowerDensity * kernelVolume;", "const particlePower = kernelPowerDensity * particleVolume;", "power on the whole particle's volume"],
  [T, "r += d.thicknesses[i]!;", "r = d.thicknesses[i]!;", "radii not accumulated"],
  [T, "const { kernelVolume, particleVolume } = particleVolumes(d.kernelRadius, r);", "const { kernelVolume, particleVolume } = particleVolumes(n.kernelRadius, r);", "kernel volume of the nominal kernel"],
  [T, "boundary: n.boundary.kind === \"convective\" ? { ...n.boundary, bulkTemperature: d.matrixTemperature } : { kind: \"surface-temperature\", surfaceTemperature: d.matrixTemperature },", "boundary: n.boundary,", "matrix temperature ignored"],
  [T, "{ ...n.boundary, bulkTemperature: d.matrixTemperature }", "{ ...n.boundary, heatTransferCoefficient: d.matrixTemperature }", "matrix temperature as the film coefficient"],
  [T, "power: { ...power, form: \"kernel-density\", particlePower, kernelPowerDensity, kernelVolume, particleVolume },", "power: { ...power, form: \"kernel-density\", particlePower, kernelPowerDensity, kernelVolume },", "particle volume dropped"],
  [T, "if (!inRange(d.kernelRadius, POPULATION_LENGTH_RANGE) || d.thicknesses.some((t) => !inRange(t, POPULATION_LENGTH_RANGE))) return \"geometry\";", "if (!inRange(d.kernelRadius, POPULATION_LENGTH_RANGE)) return \"geometry\";", "thickness not checked"],
  [T, "if (!inRange(d.kernelRadius, POPULATION_LENGTH_RANGE) || d.thicknesses.some((t) => !inRange(t, POPULATION_LENGTH_RANGE))) return \"geometry\";", "if (d.thicknesses.some((t) => !inRange(t, POPULATION_LENGTH_RANGE))) return \"geometry\";", "radius not checked"],
  [T, "if (!inRange(d.powerFactor, POPULATION_FACTOR_RANGE)) return \"powerFactor\";", "", "power factor not checked"],
  [T, "if (!inRange(d.matrixTemperature, POPULATION_TEMPERATURE_RANGE)) return \"matrixTemperature\";", "", "matrix temperature not checked"],
  [T, "const inRange = (x: number, [lo, hi]: [number, number]) => (lo > 0 ? x >= lo : x > lo) && x <= hi && Number.isFinite(x);", "const inRange = (x: number, [lo, hi]: [number, number]) => x >= lo && x <= hi && Number.isFinite(x);", "zero accepted"],
  [T, "const inRange = (x: number, [lo, hi]: [number, number]) => (lo > 0 ? x >= lo : x > lo) && x <= hi && Number.isFinite(x);", "const inRange = (x: number, [lo, hi]: [number, number]) => (lo > 0 ? x > lo : x > lo) && x <= hi && Number.isFinite(x);", "lower length bound exclusive"],
  [T, "if (dist.kernelRadius) d.kernelRadius = drawFrom(dist.kernelRadius, rng);", "", "kernel radius not drawn"],
  [T, "if (g && i >= 0) d.thicknesses[i] = drawFrom(g, rng);", "if (g && i >= 0) d.thicknesses[0] = drawFrom(g, rng);", "every thickness into the buffer"],
  [T, "if (dist.powerFactor) d.powerFactor = drawFrom(dist.powerFactor, rng);\n  if (dist.matrixTemperature) d.matrixTemperature = drawFrom(dist.matrixTemperature, rng);", "if (dist.matrixTemperature) d.matrixTemperature = drawFrom(dist.matrixTemperature, rng);\n  if (dist.powerFactor) d.powerFactor = drawFrom(dist.powerFactor, rng);", "drawing order of factor and wall"],
  // ---- the statistics
  [T, "const h = (n - 1) * p;", "const h = n * p;", "percentile position"],
  [T, "return sorted[i]! + (h - i) * (sorted[j]! - sorted[i]!);", "return sorted[i]!;", "percentile not interpolated"],
  [T, "const j = Math.min(i + 1, n - 1);", "const j = i + 1;", "percentile past the end"],
  [T, "return { mean, stdDev: n > 1 ? Math.sqrt(ss / (n - 1)) : 0,", "return { mean, stdDev: n > 1 ? Math.sqrt(ss / n) : 0,", "sd with n"],
  [T, "const sorted = Float64Array.from(values as ArrayLike<number>).sort();", "const sorted = Float64Array.from(values as ArrayLike<number>);", "values not sorted"],
  [T, "p5: percentile(sorted, 0.05), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) };", "p5: percentile(sorted, 0.05), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.95) };", "p99 is p95"],
  [T, "if (!(hi > lo)) return { edges: [lo, hi], counts: [values.length] };", "if (!(hi >= lo)) return { edges: [lo, hi], counts: [values.length] };", "histogram of equal values"],
  [T, "counts[Math.min(bins - 1, Math.floor(((values[i]! - lo) / (hi - lo)) * bins))]!++;", "counts[Math.floor(((values[i]! - lo) / (hi - lo)) * bins)]!++;", "maximum falls outside the last bin"],
  [T, "edges: Array.from({ length: bins + 1 }, (_, k) => lo + ((hi - lo) * k) / bins), counts };", "edges: Array.from({ length: bins + 1 }, (_, k) => lo + ((hi - lo) * k) / (bins + 1)), counts };", "histogram edges"],
  // ---- the batch
  [T, "[\"rise\", \"kernel peak above the matrix (K)\", cf.centreT - matrixT],", "[\"rise\", \"kernel peak above the matrix (K)\", cf.centreT - cf.wallT],", "rise above the wall"],
  [T, "for (const r of cf.regions) rows.push([\"drop:\" + r.name, \"drop across the \" + r.name + \" (K)\", r.innerT - r.outerT]);", "for (const r of cf.regions) rows.push([\"drop:\" + r.name, \"drop across the \" + r.name + \" (K)\", r.outerT - r.innerT]);", "drops with the wrong sign"],
  [T, "rows.push([\"drop:gap\", \"drop across the gap (K)\", cf.gapDeltaT]);", "rows.push([\"drop:gap\", \"drop across the gap (K)\", cf.filmDeltaT]);", "gap drop is the film's"],
  [T, "if (n.boundary.kind === \"convective\") rows.push([\"drop:film\"", "if (n.boundary.kind !== \"convective\") rows.push([\"drop:film\"", "film row for the wrong boundary"],
  [T, "const cap = POPULATION_REJECTION_FACTOR * size + 100;", "const cap = POPULATION_REJECTION_FACTOR * size;", "rejection allowance without the 100"],
  [T, "if (rejected > cap) throw", "if (rejected >= cap) throw", "rejection allowance off by one"],
  [T, "byReason[reason!]++;\n      rejected++;", "byReason[reason!]++;", "rejections not counted in total"],
  [T, "const rows = reportOf(p, cf, d.matrixTemperature);", "const rows = reportOf(p, cf, n.boundary.kind === \"convective\" ? n.boundary.bulkTemperature : n.boundary.surfaceTemperature);", "rise above the nominal matrix"],
  [T, "cf.regions.forEach((r, c) => (regionPeaks[c]![kept] = r.innerT));", "cf.regions.forEach((r, c) => (regionPeaks[c]![kept] = r.outerT));", "region peak at the outer face"],
  [T, "powers[kept] = p.power.particlePower;", "powers[kept] = n.power.particlePower;", "nominal power reported"],
  [T, "bufferT[kept] = bufferI >= 0 ? d.thicknesses[bufferI]! : 0;", "bufferT[kept] = bufferI >= 0 ? d.thicknesses[0]! + d.kernelRadius : 0;", "buffer thickness reported"],
  [T, "add(\"hottest\", argBest(peaks, (a, b) => a > b));", "add(\"hottest\", argBest(peaks, (a, b) => a < b));", "hottest is the coldest"],
  [T, "add(\"median\", argBest(Array.from(peaks, (x) => -Math.abs(x - median)), (a, b) => a > b));", "add(\"median\", argBest(Array.from(peaks, (x) => Math.abs(x - median)), (a, b) => a > b));", "median is the farthest"],
  [T, "add(\"coldest\", argBest(peaks, (a, b) => a < b));", "add(\"coldest\", argBest(peaks, (a, b) => a > b));", "coldest is the hottest"],
  [T, "if (bufferI >= 0) add(\"thickestBuffer\", argBest(bufferT, (a, b) => a > b));", "if (bufferI >= 0) add(\"thickestBuffer\", argBest(bufferT, (a, b) => a < b));", "thickest buffer is the thinnest"],
  [T, "if (sicI >= 0) add(\"thinnestSic\", argBest(sicT, (a, b) => a < b));", "if (sicI >= 0) add(\"thinnestSic\", argBest(sicT, (a, b) => a > b));", "thinnest SiC is the thickest"],
  [T, "for (let i = 0; i < size; i++) if (col[i]! > rule.maxTemperature) above++;", "for (let i = 0; i < size; i++) if (col[i]! >= rule.maxTemperature) above++;", "limit counted at equality"],
  [T, "return { name: rule.name, region: rule.region, maxTemperature: rule.maxTemperature, above, fraction: above / size };", "return { name: rule.name, region: rule.region, maxTemperature: rule.maxTemperature, above, fraction: above / (size + 1) };", "fraction of size + 1"],
  [T, "const col = regionPeaks[regions.indexOf(rule.region)]!;", "const col = regionPeaks[0]!;", "every limit on the kernel"],
  [T, "maximum: reps[0]!,", "maximum: reps[1]!,", "maximum is the median"],
  [T, "...(o.keepSamples ? { samples: Array.from(peaks) } : {}),", "", "samples never kept"],
  // ---- the case of one drawn particle
  [T, "out.geometry.layers = n.layers.map((l, i) => ({ name: l.name, thickness: { value: d.thicknesses[i]!, unit: \"m\" } }));", "out.geometry.layers = n.layers.map((l, i) => ({ name: l.name, thickness: { value: d.thicknesses[0]!, unit: \"m\" } }));", "document with one thickness"],
  [T, "out.power = { kernelPowerDensity: { value: n.power.kernelPowerDensity * d.powerFactor, unit: \"W/m3\" } };", "out.power = { kernelPowerDensity: { value: n.power.kernelPowerDensity, unit: \"W/m3\" } };", "document without the power factor"],
  [T, "if (n.boundary.kind === \"convective\") out.boundary.bulkTemperature = { value: d.matrixTemperature, unit: \"K\" };", "if (n.boundary.kind === \"convective\") out.boundary.bulkTemperature = { value: n.boundary.bulkTemperature, unit: \"K\" };", "document keeps the old bulk temperature"],
  [T, "delete out.population;", "", "document keeps the population"],
  // ---- the case's section
  [C, "else if (raw.size < 1 || raw.size > POPULATION_MAX_SIZE) bad(", "else if (raw.size < 2 || raw.size > POPULATION_MAX_SIZE) bad(", "size 1 refused"],
  [C, "else if (raw.size < 1 || raw.size > POPULATION_MAX_SIZE) bad(", "else if (raw.size < 1 || raw.size >= POPULATION_MAX_SIZE) bad(", "size at the cap refused"],
  [C, "else if (raw.seed < 0 || raw.seed > 0xffffffff) bad(", "else if (raw.seed < 1 || raw.seed > 0xffffffff) bad(", "seed 0 refused by the case"],
  [C, "else if (raw.seed < 0 || raw.seed > 0xffffffff) bad(", "else if (raw.seed < 0 || raw.seed >= 0xffffffff) bad(", "largest seed refused by the case"],
  [C, "if (layerNames.includes(name) && !layers.includes(name)) {", "if (false) {", "layer the particle lacks accepted"],
  [C, "if (!(POPULATION_VARIABLES as readonly string[]).includes(name)) {", "if (false) {", "unknown variable accepted"],
  [C, "if (typeof kind !== \"string\" || !(KINDS as readonly string[]).includes(kind)) {", "if (typeof kind !== \"string\") {", "unknown kind accepted"],
  [C, "if (b !== undefined && !(b > 0)) {\n        fail(\"E_OUT_OF_RANGE\", base + \"/stdDev\"", "if (b !== undefined && !(b >= 0)) {\n        fail(\"E_OUT_OF_RANGE\", base + \"/stdDev\"", "stdDev of 0 accepted"],
  [C, "if (a !== undefined && !(a > 0)) {\n        fail(\"E_OUT_OF_RANGE\", base + \"/median\"", "if (a !== undefined && !(a >= 0)) {\n        fail(\"E_OUT_OF_RANGE\", base + \"/median\"", "median of 0 accepted"],
  [C, "if (b !== undefined && !(b > 0)) {\n        fail(\"E_OUT_OF_RANGE\", base + \"/sigmaLog\"", "if (b !== undefined && !(b >= 0)) {\n        fail(\"E_OUT_OF_RANGE\", base + \"/sigmaLog\"", "sigmaLog of 0 accepted"],
  [C, "if (!(max > min)) fail(\"E_OUT_OF_RANGE\", base + \"/max\"", "if (!(max >= min)) fail(\"E_OUT_OF_RANGE\", base + \"/max\"", "uniform of one point accepted"],
  [C, "else if (tmin !== undefined && tmax !== undefined && !(tmax > tmin)) fail(", "else if (tmin !== undefined && tmax !== undefined && !(tmax >= tmin)) fail(", "truncation of one point accepted"],
  [C, "if (!isObj(t) || (t.min === undefined && t.max === undefined)) fail(", "if (!isObj(t)) fail(", "empty truncation accepted"],
  [C, "if (v === \"matrixTemperature\" && key === \"stdDev\" && isObj(spec[key]) && (spec[key] as Record<string, unknown>).unit === \"degC\") {", "if (false) {", "temperature spread in degC accepted"],
  [C, "if (dist.kind !== \"constant\" && kept.valid < POPULATION_MIN_ACCEPTANCE) {", "if (dist.kind !== \"constant\" && kept.valid < 0) {", "unsamplable accepted"],
  [C, "if (dist.kind !== \"constant\" && kept.valid < POPULATION_MIN_ACCEPTANCE) {", "if (dist.kind !== \"constant\" && kept.inTruncation < POPULATION_MIN_ACCEPTANCE) {", "valid range ignored by the acceptance check"],
  [C, "if (dist.kind !== \"constant\" && kept.lossToRange > POPULATION_WARN_LOSS) {", "if (dist.kind !== \"constant\" && kept.lossToRange > 2) {", "rejection warning never given"],
  [C, "if (!(lo > 0 ? value >= lo : value > lo) || value > hi) fail(", "if (!(lo > 0 ? value >= lo : value > lo) && value > hi) fail(", "constant out of range accepted"],
  [C, "return ok && size !== undefined && seed !== undefined ? { size, seed, distributions } : undefined;", "return size !== undefined && seed !== undefined ? { size, seed, distributions } : undefined;", "a population with errors is returned"],
  [C, "return v === \"powerFactor\" ? { dim: \"fraction\", unit: \"1\" } : v === \"matrixTemperature\" ? { dim: \"temperature\", unit: \"K\" } : { dim: \"length\", unit: \"m\" };", "return v === \"powerFactor\" ? { dim: \"length\", unit: \"1\" } : v === \"matrixTemperature\" ? { dim: \"temperature\", unit: \"K\" } : { dim: \"length\", unit: \"m\" };", "power factor read as a length"],
  [C, "b = need(\"sigmaLog\", \"the standard deviation of ln x, a plain number such as 0.05 for about 5 %\", \"fraction\");", "b = need(\"sigmaLog\", \"the standard deviation of ln x, a plain number such as 0.05 for about 5 %\", \"length\");", "sigmaLog read as a length"],
  // ---- the validator's hooks
  [V, "if (isTransient) err(\"E_UNSUPPORTED\", \"/population\",", "if (false) err(\"E_UNSUPPORTED\", \"/population\",", "population on a transient accepted"],
  [V, "if (c.population !== undefined) err(\"E_UNSUPPORTED\", \"/population\", \"a population is for a coated particle", "if (false) err(\"E_UNSUPPORTED\", \"/population\", \"a population is for a coated particle", "population on a pin accepted"],
  [V, "...(population ? { population } : {}) };", "};", "population dropped from the normalised particle"],
];

const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
let list = mutants.filter((m) => !only || only.test(m[3]));
if (process.env.MUT_RANGE) { const [a, b] = process.env.MUT_RANGE.split("-").map(Number); list = list.slice(a, b); } /* MUT_RANGE=0-20 runs the first twenty (a long run is done in pieces) */
if (process.env.MUT_CHECK) {
  for (const [file, from, , name] of list) {
    const count = fs.readFileSync(path.join(root, file), "utf8").split(from).length - 1;
    if (count !== 1) console.log("ANCHOR " + count + "  " + name);
  }
  console.log(list.length + " anchors checked");
  process.exit(0);
}
function runFocus() {
  const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...FOCUS], { cwd: root, encoding: "utf8", timeout: 400000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out) || /Tests\s+(\d+) failed/.exec(out);
  return { code: r.status, summary: m ? m[0] : null, out };
}
const base = runFocus();
console.log("baseline: exit " + base.code + ", " + base.summary);
if (base.code !== 0 || !base.summary) {
  console.log("ABORT: the baseline is not green");
  process.exit(2);
}
const rows = [];
for (const [file, from, to, name] of list) {
  const p = path.join(root, file);
  const original = fs.readFileSync(p, "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) {
    rows.push([name, "ANCHOR " + count, ""]);
    console.log("ANCHOR " + count + "  " + name);
    continue;
  }
  try {
    fs.writeFileSync(p, original.replace(from, () => to), "utf8");
    const r = runFocus();
    const verdict = !r.summary ? "BROKEN" : r.code === 0 ? "SURVIVED" : "killed";
    rows.push([name, verdict, r.summary || ""]);
    console.log(verdict.padEnd(9) + name + "   [" + (r.summary || "no summary") + "]");
  } finally {
    fs.writeFileSync(p, original, "utf8");
  }
}
const n = (v) => rows.filter((r) => r[1] === v).length;
console.log("\nmutants " + rows.length + ": killed " + n("killed") + ", survived " + n("SURVIVED") + ", broken " + n("BROKEN") + ", bad anchor " + rows.filter((r) => r[1].startsWith("ANCHOR")).length);
for (const r of rows.filter((x) => x[1] !== "killed")) console.log("  " + r[1] + ": " + r[0]);
