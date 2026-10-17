"use strict";
// Writes the SEED oracle entries (seed.oracle/0.1) for sampled coated particles (plan 13, T6) to oracles/seed-triso/. Run from the FEED repo root:
//   node scripts/gen-seed-oracles-triso.cjs
//
// A sibling of scripts/gen-seed-oracles.cjs, in the same style, and a separate folder on purpose: the 125 entries of oracles/seed, their 173 files and the tests that hash them are not
// touched. Nothing here reads src/core or a solver's output. The generator carries its OWN copy of the sampler (xoshiro128** seeded by splitmix32, Box-Muller, the four distribution
// kinds with truncation by rejection) and of the closed form of the layered sphere with constant conductivities, in plain arithmetic: it draws the population of
// examples/synthetic-triso-population.json, picks the same five particles as src/core/trisoPopulation.ts (the hottest, the median, the coldest, the thickest buffer, the thinnest SiC),
// writes each as a case file of constants, and works out the expected values. tests/seedOracleTriso.test.ts holds the generator's sample against FEED's sampler.
//
// Tolerances are fixed here, BEFORE any run, and are part of each entry's hash. The real solver's mesh is a 2 degree wedge of the sphere (radii times lambda, docs/triso.md), cells N = 48
// in every region:
//   a kernel centre or a layer drop:  0.5 % of the particle's internal rise (the centre above the outer wall; FEED's own bound of a cell against the closed form)
//                                     + 5 x (the kernel's drop) / N^2 (the pin's discretisation bound)
//                                     + (1 - lambda^2) x |the expected value| (the wedge is a sphere with its radii lambda times smaller: its drops are lambda^2 times the sphere's),
//                                     rounded up to 0.05 K.
//   the gap's drop:                   1 % of the drop + 0.005 K (FEED's gapDrop check) + (1 - lambda) x the drop (the wedge's gap drop is lambda times the sphere's), rounded up to 0.005 K.
// Re-running rewrites identical files.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..");
const out = process.env.FEED_ORACLE_OUT ? path.resolve(process.env.FEED_ORACLE_OUT) : path.join(root, "oracles", "seed-triso");
if (process.env.FEED_ORACLE_OUT && !path.basename(out).startsWith("feed-oracle-")) throw new Error("FEED_ORACLE_OUT must be a folder named feed-oracle-*");
const NL = String.fromCharCode(10);

const sha = (d) => crypto.createHash("sha256").update(d).digest("hex");
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
const pretty = (v) => JSON.stringify(v, null, 2) + NL;
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const load = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const round = (x, d) => Number(x.toFixed(d));
const roundUp = (x, step) => Number((Math.ceil(x / step - 1e-9) * step).toFixed(6));

// ---- units used by the example (a unit not listed is a mistake in the generator, not a silent default)
const SCALE = { m: 1, um: 1e-6, K: 1, "W/m/K": 1, "W/m2/K": 1, "MW/m3": 1e6, "W/m3": 1, "1": 1 };
function si(q) {
  if (!(q.unit in SCALE)) throw new Error("unit not handled by the generator: " + q.unit);
  return q.value * SCALE[q.unit];
}

// ---- the sampler (a second implementation of src/core/trisoPopulation.ts)
function makeRng(seed) {
  let st = seed | 0;
  const w = [];
  for (let i = 0; i < 4; i++) {
    st = (st + 0x9e3779b9) | 0;
    let t = st ^ (st >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    w.push(t | 0);
  }
  let [s0, s1, s2, s3] = w;
  const next32 = () => {
    const r = Math.imul(s1, 5);
    const result = Math.imul((r << 7) | (r >>> 25), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    return result;
  };
  const uniform = () => {
    const hi = next32() >>> 5;
    const lo = next32() >>> 6;
    return (hi * 67108864 + lo + 0.5) / 9007199254740992;
  };
  const normal = () => {
    const u1 = uniform();
    const u2 = uniform();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  return { uniform, normal };
}
function drawFrom(d, rng) {
  if (d.kind === "constant") return si(d.value);
  if (d.kind === "uniform") return si(d.min) + (si(d.max) - si(d.min)) * rng.uniform();
  const lo = d.truncate && d.truncate.min ? si(d.truncate.min) : -Infinity;
  const hi = d.truncate && d.truncate.max ? si(d.truncate.max) : Infinity;
  for (let i = 0; i < 10000; i++) {
    const z = rng.normal();
    const x = d.kind === "normal" ? si(d.mean) + si(d.stdDev) * z : Math.exp(Math.log(si(d.median)) + si(d.sigmaLog) * z);
    if (x >= lo && x <= hi) return x;
  }
  throw new Error("a truncated draw found nothing");
}

// ---- the closed form of the layered sphere with constant conductivities (kernel parabola, shells, the gap at the buffer's outer radius, the film)
const kFor = (doc) => ["kernel", "buffer", "ipyc", "sic", "opyc"].map((r) => si(doc.materials[r].sets["thermal.conductivity"].value));
function closedForm(doc, k, d) {
  const q0 = si(doc.power.kernelPowerDensity) * d.f;
  const P = q0 * (4 / 3) * Math.PI * d.R ** 3;
  const r = [d.R];
  d.t.forEach((x, i) => r.push(r[i] + x));
  const Ro = r[r.length - 1];
  const hGap = si(doc.gap.conductance);
  const hFilm = si(doc.boundary.heatTransferCoefficient);
  const film = P / (4 * Math.PI * Ro * Ro * hFilm);
  const layer = [];
  for (let i = 0; i < 4; i++) layer.push((P / (4 * Math.PI * k[i + 1])) * (1 / r[i] - 1 / r[i + 1]));
  const gap = P / (4 * Math.PI * r[1] * r[1] * hGap);
  const kernel = (q0 * d.R * d.R) / (6 * k[0]);
  const wall = d.Tm + film;
  return { peak: wall + layer.reduce((a, b) => a + b, 0) + gap + kernel, wall, film, layer, gap, kernel, P };
}

// ---- the population of the example and its five representatives
const exampleRel = "examples/synthetic-triso-population.json";
const example = load(exampleRel);
const pop = example.population;
const K = kFor(example);
const nominal = { R: si(example.geometry.kernelRadius), t: example.geometry.layers.map((l) => si(l.thickness)), f: 1, Tm: si(example.boundary.bulkTemperature) };
const NAMES = ["buffer", "ipyc", "sic", "opyc"];
const rng = makeRng(pop.seed);
const draws = [];
for (let i = 0; i < pop.size; i++) {
  const d = { R: nominal.R, t: nominal.t.slice(), f: 1, Tm: nominal.Tm };
  const g = pop.distributions;
  if (g.kernelRadius) d.R = drawFrom(g.kernelRadius, rng);
  NAMES.forEach((n, j) => {
    if (g[n]) d.t[j] = drawFrom(g[n], rng);
  });
  if (g.powerFactor) d.f = drawFrom(g.powerFactor, rng);
  if (g.matrixTemperature) d.Tm = drawFrom(g.matrixTemperature, rng);
  if (!(d.R >= 1e-9 && d.t.every((x) => x >= 1e-9) && d.f > 0 && d.Tm > 0)) throw new Error("the example population has a draw that is not a particle: the generator does not handle rejection");
  draws.push(d);
}
const peaks = draws.map((d) => closedForm(example, K, d).peak);
const sorted = peaks.slice().sort((a, b) => a - b);
const h50 = (pop.size - 1) * 0.5;
const p50 = sorted[Math.floor(h50)] + (h50 - Math.floor(h50)) * (sorted[Math.min(Math.floor(h50) + 1, pop.size - 1)] - sorted[Math.floor(h50)]);
const argBest = (values, better) => values.reduce((b, x, i) => (better(x, values[b]) ? i : b), 0);
const PICKS = [
  { role: "hottest", index: argBest(peaks, (a, b) => a > b), what: "the hottest kernel of the 2000" },
  { role: "median", index: argBest(peaks.map((x) => -Math.abs(x - p50)), (a, b) => a > b), what: "the particle whose kernel peak is nearest the sample's median" },
  { role: "coldest", index: argBest(peaks, (a, b) => a < b), what: "the coldest kernel of the 2000" },
  { role: "thickest-buffer", index: argBest(draws.map((d) => d.t[0]), (a, b) => a > b), what: "the thickest buffer of the 2000" },
  { role: "thinnest-sic", index: argBest(draws.map((d) => d.t[2]), (a, b) => a < b), what: "the thinnest SiC layer of the 2000" },
];

// ---- the wedge of the real solver's mesh (src/core/trisoWriter.ts derives it; here: half-angle 1 degree)
const A = Math.PI / 180;
const LAMBDA = Math.cos(A) / Math.sqrt(1 + Math.sin(A) ** 2);
const CELLS = example.mesh.kernelCells;
const MESH_TEXT = `the 2 degree wedge of the sphere with its radii times lambda = ${LAMBDA.toFixed(6)}, ${CELLS} cells in every region`;

fs.rmSync(out, { recursive: true, force: true });

function entry(o) {
  const e = {
    schema: "seed.oracle/0.1",
    oracleId: o.id,
    entryVersion: 1,
    adapter: "feed",
    adapterVersions: ["*"],
    tag: o.tag,
    inputs: [{ path: o.casePath, sha256: sha(fs.readFileSync(path.join(out, o.casePath))) }],
    expected: o.expected,
    ...(o.tolerance ? { tolerance: o.tolerance } : {}),
    source: o.source,
    coverage: o.coverage,
  };
  e.toleranceHash = sha(canonical({ expected: e.expected, tolerance: e.tolerance === undefined ? null : e.tolerance }));
  write(path.join(out, "entries", o.id + ".json"), pretty(e));
}
function writeCase(name, doc) {
  const rel = "models/" + name + ".case.json";
  write(path.join(out, rel), pretty(doc));
  return rel;
}

/** The case of one drawn particle: the example with the drawn values as constants (metres, W/m3, K) and no population section. */
function particleCase(name, d) {
  const doc = JSON.parse(JSON.stringify(example));
  delete doc.population;
  doc.caseId = name;
  doc.name = "Sampled coated particle " + name + " (a draw of the population of synthetic-triso-population, illustrative numbers)";
  doc.description = "ILLUSTRATIVE and SYNTHETIC: one particle drawn from the population of examples/synthetic-triso-population.json (seed " + pop.seed + "), written out as constants. FEED's synthetic conductivities, an assumed gap conductance and an assumed convective matrix; not a real fuel design, thermal only.";
  doc.geometry.kernelRadius = { value: d.R, unit: "m" };
  doc.geometry.layers = NAMES.map((n, i) => ({ name: n, thickness: { value: d.t[i], unit: "m" } }));
  doc.power = { kernelPowerDensity: { value: si(example.power.kernelPowerDensity) * d.f, unit: "W/m3" } };
  doc.boundary.bulkTemperature = { value: d.Tm, unit: "K" };
  return doc;
}

const um = (x) => round(x * 1e6, 3);
let good = 0;
for (const pick of PICKS) {
  const d = draws[pick.index];
  const name = "triso-pop-" + pick.role;
  const rel = writeCase(name, particleCase(name, d));
  const c = closedForm(example, K, d);
  const rise = c.peak - c.wall;
  const bufferDrop = c.layer[0];
  const tolCentre = roundUp(0.005 * rise + (5 * c.kernel) / (CELLS * CELLS) + (1 - LAMBDA * LAMBDA) * (c.peak - c.wall), 0.05);
  const tolBuffer = roundUp(0.005 * rise + (5 * c.kernel) / (CELLS * CELLS) + (1 - LAMBDA * LAMBDA) * bufferDrop, 0.05);
  const tolGap = roundUp(0.01 * c.gap + 0.005 + (1 - LAMBDA) * c.gap, 0.005);
  const domain = "synthetic coated particle (kernel " + um(d.R) + " um, buffer " + um(d.t[0]) + ", inner PyC " + um(d.t[1]) + ", SiC " + um(d.t[2]) + ", outer PyC " + um(d.t[3]) + " um; constant conductivities 3 / 0.5 / 4 / 13.9 / 4 W/m/K; gap 1.5e5 W/m2/K; kernel power density " + round(si(example.power.kernelPowerDensity) * d.f / 1e6, 2) + " MW/m3; convective matrix " + round(d.Tm, 2) + " K, 2000 W/m2/K), mesh " + CELLS + " cells per region, steady";
  const which = "Particle " + pick.index + " of the 2000 drawn with the seed " + pop.seed + " from the population of examples/synthetic-triso-population.json: " + pick.what + " (" + (pick.role === "hottest" || pick.role === "coldest" || pick.role === "median" ? "kernel peak " + round(c.peak, 3) + " K" : pick.role === "thickest-buffer" ? "buffer " + um(d.t[0]) + " um" : "SiC " + um(d.t[2]) + " um") + "). ";
  const meshBound = "the mesh bound 5 x " + round(c.kernel, 3) + " K / " + CELLS + "^2 = " + round((5 * c.kernel) / (CELLS * CELLS), 4) + " K";
  const wedge = "the wedge of the solver's mesh (" + MESH_TEXT + "), which makes every drop lambda^2 = " + (LAMBDA * LAMBDA).toFixed(6) + " of the sphere's";
  const check = "Second method: FEED's own closed form (src/core/trisoSolve.ts, tests/seedOracleTriso.test.ts, to 1e-6 K) and FEED's finite-volume solution; the real solver (FEED_SOLVER=1, tests/seedOracleTriso.test.ts) with every check of the run passing, and its saved output (tests/golden/seed-oracles-triso/) inside the tolerance.";
  entry({
    id: "feed-" + name + "-temperature-kernel-centre",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_kernel_centre", value: round(c.peak, 4), unit: "K" },
    tolerance: { abs: tolCentre, rel: 0 },
    source: { kind: "analytic", text: which + "Closed form of the layered sphere with constant conductivities: matrix " + round(d.Tm, 3) + " K, film " + round(c.film, 3) + " K, outer PyC " + round(c.layer[3], 4) + " K, SiC " + round(c.layer[2], 4) + " K, inner PyC " + round(c.layer[1], 4) + " K, gap " + round(c.gap, 4) + " K, buffer " + round(c.layer[0], 3) + " K, kernel parabola q R^2 / (6 k) = " + round(c.kernel, 3) + " K: the kernel centre is " + round(c.peak, 4) + " K, " + round(rise, 3) + " K above the outer wall. The observed value is FEED's kernel centre, the first kernel cell plus the parabola's rise over the cell's radius. Tolerance " + tolCentre + " K = 0.5 % of the " + round(rise, 3) + " K internal rise + " + meshBound + " + " + wedge + ", rounded up to 0.05 K, fixed before any run.", check },
    coverage: { quantities: ["temperature_kernel_centre"], domain },
  });
  entry({
    id: "feed-" + name + "-temperature-drop-buffer",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_drop_buffer", value: round(bufferDrop, 4), unit: "K" },
    tolerance: { abs: tolBuffer, rel: 0 },
    source: { kind: "analytic", text: which + "The drop across the porous carbon buffer, from its inner face to its outer face: P / (4 pi k) x (1/r_in - 1/r_out) = " + round(bufferDrop, 4) + " K for P = " + round(c.P * 1e3, 4) + " mW. The observed value is the difference of FEED's two face temperatures of the buffer (the kernel's surface from the interface of two cells, the buffer's outer face from the gap's patch value). Tolerance " + tolBuffer + " K = 0.5 % of the " + round(rise, 3) + " K internal rise + " + meshBound + " + " + wedge + ", rounded up to 0.05 K, fixed before any run.", check },
    coverage: { quantities: ["temperature_drop_buffer"], domain },
  });
  entry({
    id: "feed-" + name + "-temperature-drop-gap",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_drop_gap", value: round(c.gap, 5), unit: "K" },
    tolerance: { abs: tolGap, rel: 0 },
    source: { kind: "analytic", text: which + "The drop across the buffer-to-inner-PyC gap: P / (4 pi R_buffer^2 h) = " + round(c.gap, 5) + " K for the gap conductance 1.5e5 W/m2/K at the buffer's outer radius " + um(d.R + d.t[0]) + " um. The observed value is the difference of the two patch values of the gap in the solver's output. Tolerance " + tolGap + " K = 1 % of the drop + 0.005 K (FEED's gapDrop check) + (1 - lambda) of the drop (the wedge's gap drop is lambda = " + LAMBDA.toFixed(6) + " times the sphere's), rounded up to 0.005 K, fixed before any run.", check },
    coverage: { quantities: ["temperature_drop_gap"], domain },
  });
  good += 3;
}

// the refusals: FEED's vectors, each with the code the validator gives
const BAD = [
  { file: "triso-population-size-zero", code: "E_OUT_OF_RANGE", what: "a population of 0 particles" },
  { file: "triso-population-truncation-cannot-be-sampled", code: "E_POPULATION_UNSAMPLABLE", what: "a kernel radius distribution truncated to a range that keeps under 1 % of its draws" },
  { file: "triso-population-layer-absent", code: "E_GEOMETRY", what: "a thickness distribution for a layer the particle does not have" },
  { file: "pin-with-population", code: "E_UNSUPPORTED", what: "a population section on a pin" },
];
let bad = 0;
for (const b of BAD) {
  const rel = writeCase("bad-" + b.file, load("schema/vectors/bad/" + b.file + ".json"));
  entry({
    id: "feed-bad-" + b.file,
    tag: "bad-input",
    casePath: rel,
    expected: { refusalCode: b.code },
    source: { kind: "hand", text: "A case with one fault: " + b.what + ". FEED must refuse it before any run; SEED reports " + b.code + ".", check: "FEED's schema vectors (schema/vectors/bad/" + b.file + ".json) assert the same code in FEED's own test suite." },
    coverage: { quantities: ["case-validation"], domain: "FEED case validation" },
  });
  bad++;
}

write(
  path.join(out, "README.md"),
  [
    "# SEED oracle entries for FEED: sampled coated particles",
    "",
    "Generated by `scripts/gen-seed-oracles-triso.cjs` (plan 13, T6). **Not sent to SEED** (docs/seed-triso-request.md). A separate folder from `oracles/seed`: the 125 entries there are untouched.",
    "Entries in `entries/` are `seed.oracle/0.1` documents; `models/` holds the cases they pin by hash. Expected values are the closed form of the layered sphere computed by the generator in plain arithmetic,",
    "never the output of a solver run. The five particles are drawn by the generator's own copy of the sampler from the population of `examples/synthetic-triso-population.json` (seed " + pop.seed + ", " + pop.size + " particles): the hottest, the median, the coldest, the thickest buffer and the thinnest SiC layer.",
    "A tolerance is part of the entry's hash: changing it needs a new `entryVersion` made by a human.",
    "",
    good + " good entries (per particle: the kernel centre, the drop across the buffer, the drop across the gap), " + bad + " bad-input entries.",
    "New quantities (SEED has to know them): `temperature_kernel_centre`, `temperature_drop_buffer`, `temperature_drop_gap` (K). FEED's result for a particle is `kind: \"triso\"` (cells, regions, summary); SEED's adapter reads pin results today.",
    "Not covered: the other layers' drops (below the solver's resolution at this power), a transient particle, a temperature-dependent conductivity, any real fuel. FEED results are thermal only.",
    "",
  ].join(NL)
);
console.log("wrote " + good + " good and " + bad + " bad-input entries to " + out);
