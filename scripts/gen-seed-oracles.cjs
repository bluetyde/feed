"use strict";
// Writes SEED oracle entries (seed.oracle/0.1) for FEED to oracles/seed/. Run from the FEED repo root:
//   node scripts/gen-seed-oracles.cjs
//
// Expected values come from the closed-form series solution (docs/plans/04-verification.md), computed HERE with plain
// formulas, independently of src/core and never from a solver run. Tolerances are fixed here, from the mesh-refinement
// bound 5 * (fuel centre-to-surface rise) / N^2 (N = fuel cells) rounded up, BEFORE any run, and are part of each entry's
// hash: loosening one needs a new entryVersion made by a human.
//
// Observed quantities are CELL-CENTRE values of the solver mesh (the peak is the first fuel cell centre, not the axis);
// the tolerance covers that offset, which is q'/(4 pi k) / (2N)^2 or smaller.
//
// Re-running rewrites identical files.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..");
const out = path.join(root, "oracles", "seed");
const NL = String.fromCharCode(10);
const MESH = { fuelCells: 100, claddingCells: 20 };

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

// Units used by the cases in this set; a unit not listed here is a mistake in the generator, not a silent default.
const SCALE = { m: 1, mm: 1e-3, cm: 1e-2, "W/m": 1, "kW/m": 1e3, "W/m/K": 1, "W/m/K2": 1, "W/m2/K": 1, K: 1 };
function si(q) {
  if (q.unit === "degC") return q.value + 273.15;
  if (!(q.unit in SCALE)) throw new Error("unit not handled by the generator: " + q.unit);
  return q.value * SCALE[q.unit];
}

/** Solve a(T-Tc) + b/2 (T^2-Tc^2) = I for T above Tc (k = a + bT), the conductivity integral. */
function hotSide(a, b, Tc, I) {
  if (b === 0) return Tc + I / a;
  const k = a + b * Tc;
  return Tc + (2 * I) / (k + Math.sqrt(k * k + 2 * b * I));
}
function conductivity(set) {
  const m = set["thermal.conductivity"];
  if (m.model === "constant") return { a: si(m.value), b: 0 };
  if (m.model === "linear") return { a: si(m.a), b: si(m.b) };
  throw new Error("conductivity model not handled: " + m.model);
}

/** Series solution for one case document, per unit length. */
function analytic(doc) {
  const q = si(doc.power.linearHeatRate);
  const Rf = si(doc.geometry.fuelRadius);
  const Rci = si(doc.geometry.claddingInnerRadius);
  const Rco = si(doc.geometry.claddingOuterRadius);
  const hGap = si(doc.gap.conductance);
  const fk = conductivity(doc.materials.fuel.sets);
  const ck = conductivity(doc.materials.cladding.sets);
  let wall;
  if (doc.boundary.surfaceTemperature) wall = si(doc.boundary.surfaceTemperature);
  else wall = si(doc.boundary.bulkTemperature) + q / (2 * Math.PI * Rco * si(doc.boundary.heatTransferCoefficient));
  const cladInner = hotSide(ck.a, ck.b, wall, (q * Math.log(Rco / Rci)) / (2 * Math.PI));
  const fuelSurface = cladInner + q / (2 * Math.PI * Rf * hGap);
  const centre = hotSide(fk.a, fk.b, fuelSurface, q / (4 * Math.PI));
  return { q, Rco, wall, cladInner, fuelSurface, centre, fuelRise: centre - fuelSurface };
}

/** Peak tolerance: 5 * rise / N^2 rounded up to 0.05 K, at least 0.05 K. Fixed before any run. */
const peakTolerance = (a) => Number(Math.max(0.05, Math.ceil((5 * a.fuelRise) / (MESH.fuelCells * MESH.fuelCells) / 0.05) * 0.05).toFixed(2));
const round = (x, d) => Number(x.toFixed(d));

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

const withMesh = (doc) => ({ ...doc, mesh: { ...MESH } });
function writeCase(name, doc) {
  const rel = "models/" + name + ".case.json";
  write(path.join(out, rel), pretty(doc));
  return rel;
}

const GOOD = [
  { name: "synthetic-const", from: "examples/synthetic-pin.json", domain: "synthetic pin, constant conductivities, convective boundary", flux: true, balance: true },
  { name: "synthetic-linear-k", from: "schema/vectors/good/linear-conductivity.json", domain: "synthetic pin, fuel k = 4 - 0.0006 T on 500-2500 K, convective boundary" },
  { name: "synthetic-prescribed-wall", from: "schema/vectors/good/surface-temperature.json", domain: "synthetic pin, constant conductivities, prescribed outer-surface temperature" },
  { name: "synthetic-closed-gap", from: "schema/vectors/good/closed-gap-effective-conductance.json", domain: "synthetic pin, no physical gap (equal radii), effective gap conductance" },
  { name: "ksu-triga-hot-element", from: "examples/ksu-triga-hot-element.json", domain: "K-State TRIGA hot element, sourced properties, prescribed surface temperature (illustrative, not a safety case)" },
];

let good = 0;
for (const g of GOOD) {
  const doc = withMesh(load(g.from));
  const rel = writeCase(g.name, doc);
  const a = analytic(doc);
  const check = "Second method: the same series solved in Python for the table in oracles/closed-form-table.json, and the solver's own closedForm checks in FEED's test suite (tests/solverEndToEnd.test.ts) reproduce it within the refinement bound.";
  const base = (quantity, value, unit, tolerance, text) => {
    entry({
      id: "feed-" + g.name + "-" + quantity.replace(/_/g, "-"),
      tag: "good",
      casePath: rel,
      expected: { quantity, value, unit },
      tolerance,
      source: { kind: "analytic", text, check },
      coverage: { quantities: [quantity], domain: g.domain },
    });
    good++;
  };
  base("temperature_peak", round(a.centre, 4), "K", { abs: peakTolerance(a), rel: 0 }, "Closed-form centre temperature of the series solution (film, cladding wall, gap, fuel), mesh " + MESH.fuelCells + "/" + MESH.claddingCells + ". The observed value is the first fuel cell centre; the tolerance is 5 * rise / N^2 rounded up.");
  base("temperature_surface", round(a.wall, 4), "K", { abs: 0.2, rel: 0 }, "Closed-form outer cladding wall temperature: bulk temperature plus the film drop q'/(2 pi Rco h), or the prescribed surface temperature.");
  if (g.flux) base("heat_flux_outer", round(a.q / (2 * Math.PI * a.Rco), 3), "W/m2", { abs: 0, rel: 1e-9 }, "Outer-surface heat flux q'/(2 pi Rco), a direct consequence of the linear heat rate and the outer radius.");
  if (g.balance) base("energy_balance_residual", 0, "1", { abs: 1e-3, rel: 0 }, "Steady state without other sources: the heat leaving through the cladding wall equals the input, so the relative residual is zero.");
}

const BAD = [
  { id: "feed-bad-units-missing", file: "units-missing", code: "E_UNITS", what: "a quantity without a unit" },
  { id: "feed-bad-boundary-bulk-only", file: "boundary-bulk-only", code: "E_BOUNDARY_INCOMPLETE", what: "a bulk temperature without a heat transfer coefficient" },
  { id: "feed-bad-conductivity-missing", file: "prop-missing-conductivity", code: "E_PROP_MISSING", what: "no fuel conductivity" },
  { id: "feed-bad-mesh-too-fine", file: "mesh-fuel-high", code: "E_MESH", what: "more fuel cells than the supported maximum" },
  { id: "feed-bad-geometry-overlap", file: "geometry-overlap", code: "E_GEOMETRY", what: "a fuel radius larger than the cladding inner radius" },
  { id: "feed-bad-transient", file: "unsupported-transient", code: "E_UNSUPPORTED", what: "a transient analysis (FEED is steady state only)" },
];
for (const b of BAD) {
  const rel = writeCase(b.id.replace(/^feed-bad-/, "bad-"), load("schema/vectors/bad/" + b.file + ".json"));
  entry({
    id: b.id,
    tag: "bad-input",
    casePath: rel,
    expected: { refusalCode: b.code },
    source: { kind: "hand", text: "A case with one fault: " + b.what + ". FEED must refuse it before any run; SEED reports " + b.code + ".", check: "FEED's schema vectors (schema/vectors/bad/" + b.file + ".json) assert the same code in FEED's own test suite." },
    coverage: { quantities: ["case-validation"], domain: "FEED case validation" },
  });
}

// Known limit: the same linear-k pin with the fuel law's stated range narrowed below the temperatures the solution
// reaches. The solver completes, but FEED must report the result as out of its domain, not as a plain success.
{
  const doc = withMesh(load("schema/vectors/good/linear-conductivity.json"));
  doc.materials.fuel.sets["thermal.conductivity"].validRange = { min: { value: 500, unit: "K" }, max: { value: 800, unit: "K" } };
  const a = analytic(doc);
  if (a.centre <= 800) throw new Error("the narrowed range no longer excludes the solution; adjust the case");
  const rel = writeCase("limit-linear-k-out-of-range", doc);
  entry({
    id: "feed-limit-linear-k-out-of-range",
    tag: "known-limit",
    casePath: rel,
    expected: { refusalCode: "E_OUT_OF_DOMAIN" },
    source: { kind: "hand", text: "Fuel k(T) = 4 - 0.0006 T is stated valid on 500-800 K only, while the closed-form solution reaches " + round(a.centre, 0) + " K at the centre. The result must be refused as out of domain.", check: "FEED's results parser marks this as domain.verdict out-of-domain (tests/resultsParser.test.ts)." },
    coverage: { quantities: ["temperature_peak"], domain: "conductivity law used outside its stated temperature range" },
  });
}

write(
  path.join(out, "README.md"),
  [
    "# SEED oracle entries for FEED",
    "",
    "Generated by `scripts/gen-seed-oracles.cjs`. Entries in `entries/` are `seed.oracle/0.1` documents; `models/` holds the cases they pin by hash.",
    "Expected values are the closed-form series solution computed by the generator, never the output of a solver run. A tolerance is part of the",
    "entry's hash: changing it needs a new `entryVersion` made by a human.",
    "",
    good + " good entries (peak, outer-wall temperature, flux and energy balance, over five pins), " + BAD.length + " bad-input entries, 1 known-limit entry.",
    "All cases use the mesh " + MESH.fuelCells + "/" + MESH.claddingCells + " (fuel/cladding cells). The peak is the first fuel cell centre of that mesh.",
    "Not covered: transients, mechanics, gap closure and contact, fission gas, burnup, any real design. FEED results are thermal only.",
    "",
  ].join(NL)
);
console.log("wrote " + good + " good, " + BAD.length + " bad-input and 1 known-limit entries to " + out);
