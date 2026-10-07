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
const SCALE = { m: 1, mm: 1e-3, cm: 1e-2, "W/m": 1, "kW/m": 1e3, "W/m/K": 1, "W/m/K2": 1, "W/m/K3": 1, "W/m/K4": 1, "W/m2/K": 1, K: 1 };
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
/** Exact interpolation through points (Gaussian elimination on the Vandermonde system); the table must have degree + 1 points, so the fit is exact. */
function interpolate(points, degree) {
  if (points.length !== degree + 1) throw new Error("an exact table has degree + 1 points");
  const n = points.length;
  const M = points.map(([T, k]) => [...Array.from({ length: n }, (_, j) => T ** j), k]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const x = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= x * M[c][j];
    }
  }
  const co = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = M[r][n];
    for (let j = r + 1; j < n; j++) v -= M[r][j] * co[j];
    co[r] = v / M[r][r];
  }
  return co;
}
/** The hot side for a law of any degree: bisection on the primitive (plain arithmetic, no code of src/core). */
function hotSideLaw(co, Tc, I) {
  const prim = (T) => co.reduceRight((acc, c, j) => acc * T + c / (j + 1), 0) * T;
  let lo = Tc;
  let hi = Tc + 1;
  while (prim(hi) - prim(Tc) < I) hi = Tc + 2 * (hi - Tc);
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (prim(mid) - prim(Tc) < I) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
const hotSideK = (k, Tc, I) => (k.coef ? hotSideLaw(k.coef, Tc, I) : hotSide(k.a, k.b, Tc, I));
function conductivity(set) {
  const m = set["thermal.conductivity"];
  if (m.model === "constant") return { a: si(m.value), b: 0 };
  if (m.model === "linear") return { a: si(m.a), b: si(m.b) };
  if (m.model === "polynomial") return { coef: [si(m.a), si(m.b), si(m.c), si(m.d)] };
  if (m.model === "table") return { coef: interpolate(m.points.map((p) => [si(p.temperature), si(p.conductivity)]), m.fit.degree) };
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
  const cladInner = hotSideK(ck, wall, (q * Math.log(Rco / Rci)) / (2 * Math.PI));
  const fuelSurface = cladInner + q / (2 * Math.PI * Rf * hGap);
  // Central hole with an insulated surface: the rise to the hole surface is the solid rise times 1 - 2 a^2 ln(1/a) / (1 - a^2).
  const ri = doc.geometry.fuelInnerRadius ? si(doc.geometry.fuelInnerRadius) : 0;
  const a2 = (ri / Rf) ** 2;
  const holeFactor = ri === 0 ? 1 : 1 - (2 * a2 * Math.log(Rf / ri)) / (1 - a2);
  const centre = hotSideK(fk, fuelSurface, (q / (4 * Math.PI)) * holeFactor);
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
  { name: "annular-synthetic-pin", from: "examples/annular-synthetic-pin.json", domain: "synthetic pin with a 1 mm central hole whose surface is insulated, constant conductivities, convective boundary", refCentre: 1213.5607 },
  { name: "synthetic-const", from: "examples/synthetic-pin.json", domain: "synthetic pin, constant conductivities, convective boundary", flux: true, balance: true },
  { name: "synthetic-linear-k", from: "schema/vectors/good/linear-conductivity.json", domain: "synthetic pin, fuel k = 4 - 0.0006 T on 500-2500 K, convective boundary" },
  { name: "synthetic-cubic-k", from: "schema/vectors/good/cubic-conductivity.json", domain: "synthetic pin, fuel k = 2 + 0.003 T - 1.2e-6 T^2 + 2e-10 T^3 on 500-2500 K (carried by OFFBEAT's ZyRELAP, T^2 sign turned round), convective boundary" },
  {
    name: "synthetic-table-k",
    from: "schema/vectors/good/table-conductivity.json",
    edit: (d) => {
      // three points of k = 3.2 + 0.0004 T - 3e-7 T^2: a degree 2 polynomial through them is exact, so the table is the quadratic
      const k = (T) => Number((3.2 + 0.0004 * T - 3e-7 * T * T).toFixed(6));
      d.materials.fuel.sets["thermal.conductivity"] = { model: "table", points: [300, 1000, 1800].map((T) => ({ temperature: { value: T, unit: "K" }, conductivity: { value: k(T), unit: "W/m/K" } })), fit: { degree: 2, tolerance: { value: 1, unit: "%" } }, source: "synthetic: three points of a quadratic, chosen so that the fitted polynomial is exact" };
    },
    domain: "synthetic pin, fuel conductivity as a table of three points (300-1800 K) carried by its exact degree 2 polynomial, convective boundary",
  },
  { name: "synthetic-prescribed-wall", from: "schema/vectors/good/surface-temperature.json", domain: "synthetic pin, constant conductivities, prescribed outer-surface temperature" },
  { name: "synthetic-closed-gap", from: "schema/vectors/good/closed-gap-effective-conductance.json", domain: "synthetic pin, no physical gap (equal radii), effective gap conductance" },
  { name: "ksu-triga-1p25mw-film", from: "examples/ksu-triga-1p25mw-film.json", domain: "K-State TRIGA hottest element at 1.25 MW with the SAR film coefficient (eq. 7), pool 20 C (illustrative, not a safety case)", sarEq9: true },
  { name: "ksu-triga-hot-element", from: "examples/ksu-triga-hot-element.json", domain: "K-State TRIGA hot element, sourced properties, prescribed surface temperature (illustrative, not a safety case)" },
];

let good = 0;
for (const g of GOOD) {
  const doc = withMesh(load(g.from));
  if (g.edit) g.edit(doc);
  const rel = writeCase(g.name, doc);
  const a = analytic(doc);
  if (g.refCentre !== undefined) {
    // Independent second method: numerical integration in oracles/annulus-reference.py (not the closed form used here).
    if (Math.abs(a.centre - g.refCentre) > 0.001) throw new Error("closed form and numerical reference disagree: " + a.centre + " vs " + g.refCentre);
  }
  if (g.sarEq9) {
    // Independent second method: the SAR's own eq. 9 (P = 1.25 MW; h from eq. 7 with P in watts), not our series code.
    const P = 1.25e6;
    const h = 0.0326 * P + 16985;
    const eq9 = 293.15 + 0.423 * P * (1 / h + 3.103e-5 + 3.6196e-4 + 5.1858e-4);
    if (Math.abs(a.centre - eq9) > 0.1) throw new Error("series solution and SAR eq. 9 disagree: " + a.centre + " vs " + eq9);
  }
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
  { id: "feed-bad-hole-too-large", file: "geometry-hole-too-large", code: "E_GEOMETRY", what: "a central hole as large as the fuel radius" },
  { id: "feed-bad-time-step-not-dividing", file: "time-step-not-dividing", code: "E_TIME", what: "a time step that does not divide the end time" },
  { id: "feed-bad-heat-capacity-missing", file: "transient-no-heat-capacity", code: "E_PROP_MISSING", what: "a pulse with no fuel heat capacity" },
  { id: "feed-bad-table-fit-too-far", file: "table-fit-too-far", code: "E_FIT", what: "a conductivity table that the polynomial asked for cannot follow within the stated tolerance" },
  { id: "feed-bad-heat-capacity-table-fit-too-far", file: "cp-table-fit-too-far", code: "E_FIT", what: "a heat capacity table that the polynomial asked for cannot follow within the stated tolerance" },
  { id: "feed-bad-initial-both", file: "transient-initial-both", code: "E_TRANSIENT_INCOMPLETE", what: "a start given both as a uniform temperature and as a steady operating state" },
  { id: "feed-bad-kinetics-pulse-not-in-window", file: "kinetics-pulse-not-in-window", code: "E_KINETICS", what: "a generated pulse that does not happen inside the run's window" },
  { id: "feed-bad-transient-no-section", file: "transient-missing-section", code: "E_TRANSIENT_INCOMPLETE", what: "a transient case (steadyState false) without its transient section" },
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

// ---- transients (plan 08). Expected values: the adiabatic limit. Over a short pulse the interior of the fuel loses and gains no heat,
// so its temperature is the root of the integral of c dT = E''' with E''' the energy deposited per volume (exact for any uniform
// source). The energy is the integral of the tabulated power history. Computed here with plain formulas and checked against
// oracles/transient-case-reference.py (decimal arithmetic) through refPeak. The observed quantity is the hottest cell-centre value
// over the run, which for a pulse followed by a hold is the interior at the end of the pulse.
const TIME_S = { s: 1, ms: 1e-3, us: 1e-6 };
const POWER_W = { "W/m": 1, "kW/m": 1e3, "MW/m": 1e6 };
const CV = { "J/m3/K": 1, "J/cm3/K": 1e6, "MJ/m3/K": 1e6 };
const CVB = { "J/m3/K2": 1, "J/cm3/K2": 1e6, "MJ/m3/K2": 1e6 };
const CVC = { "J/m3/K3": 1, "J/cm3/K3": 1e6, "MJ/m3/K3": 1e6 };
function adiabatic(doc) {
  const t = doc.transient;
  const end = t.endTime.value * TIME_S[t.endTime.unit];
  const pts = t.powerHistory.map((p) => [p.time.value * TIME_S[p.time.unit], p.linearHeatRate.value * POWER_W[p.linearHeatRate.unit]]);
  let e = 0;
  for (let i = 1; i < pts.length; i++) {
    let [t0, q0] = pts[i - 1];
    let [t1, q1] = pts[i];
    if (t0 >= end) break;
    if (t1 > end) {
      q1 = q0 + ((q1 - q0) * (end - t0)) / (t1 - t0);
      t1 = end;
    }
    e += 0.5 * (q0 + q1) * (t1 - t0);
  }
  const R = si(doc.geometry.fuelRadius);
  const ri = doc.geometry.fuelInnerRadius ? si(doc.geometry.fuelInnerRadius) : 0;
  const e3 = e / (Math.PI * (R * R - ri * ri));
  const T0 = si(t.initialTemperature);
  const s = doc.materials.fuel.sets["thermal.volumetricHeatCapacity"];
  let peak;
  if (s.model === "constant") peak = T0 + e3 / (s.value.value * CV[s.value.unit]);
  else if (s.model === "polynomial") {
    const co = [s.a.value * CV[s.a.unit], s.b.value * CVB[s.b.unit], s.c.value * CVC[s.c.unit]];
    peak = hotSideLaw(co, T0, e3);
  } else {
    const a = s.a.value * CV[s.a.unit];
    const b = s.b.value * CVB[s.b.unit];
    const kc = a + b * T0;
    peak = T0 + (2 * e3) / (kc + Math.sqrt(kc * kc + 2 * b * e3));
  }
  return { energy: e, peak, rise: peak - T0 };
}

const TRANSIENT_GOOD = [
  { name: "synthetic-pulse", from: "examples/synthetic-pulse.json", refPeak: 615.595763, relTol: 5e-4, domain: "synthetic pin, 10 ms triangular pulse of 50 kJ/m on a cold pin, constant heat capacity, convective boundary" },
  {
    name: "synthetic-pulse-linear-c",
    from: "schema/vectors/good/pulse-linear-heat-capacity.json",
    refPeak: 632.802419,
    relTol: 5e-3,
    edit: (d) => ((d.transient.timeStep = { value: 0.025, unit: "ms" }), (d.transient.outputs = 20)),
    domain: "synthetic pin, the same pulse with a fuel heat capacity linear in temperature (carried by OFFBEAT's steel1515TiBanerjee model), step 0.025 ms",
  },
  {
    name: "synthetic-pulse-quadratic-c",
    from: "schema/vectors/good/pulse-quadratic-heat-capacity.json",
    refPeak: 656.588538,
    relTol: 5e-3,
    edit: (d) => ((d.transient.timeStep = { value: 0.025, unit: "ms" }), (d.transient.outputs = 20)),
    domain: "synthetic pin, the same pulse with a fuel heat capacity quadratic in temperature (carried by OFFBEAT's SiCSnead with its T^-2 term set to zero), step 0.025 ms",
  },
  { name: "ut-triga-pulse-4p40", from: "examples/ut-triga-pulse-4p40.json", refPeak: 1097.469086, relTol: 2e-3, domain: "TRIGA hot channel, sech^2 pulse built from UT-Austin SAR numbers (illustrative), annular fuel, U-ZrH heat capacity 2.04 + 0.00417 T[C] J/cm3/K, 824 C adiabatic peak" },
];
let transientGood = 0;
for (const c of TRANSIENT_GOOD) {
  const doc = load(c.from);
  if (c.edit) c.edit(doc);
  const rel = writeCase(c.name, doc);
  const a = adiabatic(doc);
  if (Math.abs(a.peak - c.refPeak) > 1e-4) throw new Error(c.name + ": generator " + a.peak + " vs independent Python " + c.refPeak);
  const check = "Second method: oracles/transient-case-reference.py (decimal arithmetic, reads the case file) gives " + c.refPeak + " K; FEED's independent finite-volume solution (src/core/transientFv.ts, validated against exact cylinder solutions) agrees at the pulse end.";
  const tol = Number((c.relTol * a.rise).toFixed(2));
  entry({
    id: "feed-" + c.name + "-temperature-peak-max",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_peak_max", value: round(a.peak, 4), unit: "K" },
    tolerance: { abs: tol, rel: 0 },
    source: { kind: "analytic", text: "Adiabatic limit: the fuel interior keeps all the energy deposited by the pulse (" + round(a.energy, 3) + " J/m), so its temperature is the root of the integral of c dT = E'''. The tolerance is " + c.relTol * 100 + "% of the rise, set before any run from the first-order error of the time step (about 1/N of the energy over a ramp of N steps, cancelling over a symmetric pulse).", check },
    coverage: { quantities: ["temperature_peak_max"], domain: c.domain },
  });
  entry({
    id: "feed-" + c.name + "-energy-deposited",
    tag: "good",
    casePath: rel,
    expected: { quantity: "energy_deposited", value: round(a.energy, 3), unit: "J/m" },
    tolerance: { abs: 0, rel: 1e-6 },
    source: { kind: "analytic", text: "The integral of the tabulated power history up to the end time (trapezoid, exact for the solver's linear interpolation).", check: "oracles/transient-case-reference.py integrates the same table in decimal arithmetic." },
    coverage: { quantities: ["energy_deposited"], domain: c.domain },
  });
  transientGood += 2;
}

// ---- a pulse that starts from the steady operating state, and a pulse generated by point kinetics.
// Steady-start HOLD: the pin runs at its operating heat rate, starts from its steady state and the power stays where it is. Nothing may move, so the
// hottest cell stays at the closed-form steady temperature of the pin (the series solution used for the steady entries) and the energy deposited is q' t.
// The tolerance is the steady entries' (5 x rise / N^2, fixed before any run): FEED starts from its own discrete steady state on the same mesh and OFFBEAT
// settles to its own, which differ by a fraction of that.
let kineticsGood = 0;
{
  const doc = load("examples/synthetic-pulse.json");
  doc.mesh = { ...MESH };
  const Q = { value: 20, unit: "kW/m" };
  delete doc.transient.initialTemperature;
  doc.transient.initialSteadyLinearHeatRate = Q;
  doc.transient.powerHistory = [
    { time: { value: 0, unit: "ms" }, linearHeatRate: Q },
    { time: { value: 100, unit: "ms" }, linearHeatRate: Q },
  ];
  doc.name = "Synthetic pin held at its operating power from its steady state (illustrative numbers)";
  doc.caseId = "synthetic-steady-hold";
  const rel = writeCase("synthetic-steady-hold", doc);
  const a = analytic({ ...doc, power: { linearHeatRate: Q } });
  const domain = "synthetic pin, constant properties, convective boundary, started from its steady operating state at 20 kW/m and held there for 100 ms (mesh " + MESH.fuelCells + "/" + MESH.claddingCells + ")";
  const check = "Second method: the same series solved in Python for oracles/closed-form-table.json, and FEED's own steady start (an independent finite-volume solution on the mesh, src/core/transientFv.ts) reproduces it within the mesh bound; FEED's steady-start tests in tests/steadyInitialState.test.ts.";
  entry({
    id: "feed-synthetic-steady-hold-temperature-peak-max",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_peak_max", value: round(a.centre, 4), unit: "K" },
    tolerance: { abs: peakTolerance(a), rel: 0 },
    source: { kind: "analytic", text: "A pin started from its steady state at a power that then stays constant does not change: the hottest cell is the closed-form steady centre temperature (film, cladding wall, gap, fuel), mesh " + MESH.fuelCells + "/" + MESH.claddingCells + ".", check },
    coverage: { quantities: ["temperature_peak_max"], domain },
  });
  entry({
    id: "feed-synthetic-steady-hold-energy-deposited",
    tag: "good",
    casePath: rel,
    expected: { quantity: "energy_deposited", value: round(a.q * 0.1, 3), unit: "J/m" },
    tolerance: { abs: 0, rel: 1e-6 },
    source: { kind: "analytic", text: "The constant heat rate over the run: q' x t = 20 kW/m x 0.1 s.", check: "Trivial product; oracles/transient-case-reference.py integrates the tabulated history to the same number." },
    coverage: { quantities: ["energy_deposited"], domain },
  });
  kineticsGood += 2;
}

// Point-kinetics pulse, prompt neutrons only, constant feedback and constant heat capacity: the Nordheim-Fuchs solution, exact.
//   rho(E) = rho0 - gamma E,  gamma = |alpha| s / c,  s = peaking / (pins L A)   (J/m3 of fuel per J of reactor energy)
//   P(t) = Pmax sech^2(rho0 (t - tp) / (2 Lambda)),  Pmax = rho0^2 / (2 gamma Lambda),  tp = (2 Lambda / rho0) acosh(sqrt(Pmax / P0))
//   E(t) = (rho0 / gamma) (1 + tanh(rho0 (t - tp) / (2 Lambda)))      the energy deposited by t
// The case file carries the inputs, not the pulse: FEED generates the history, and these formulas never touch its code.
{
  const rho0 = 0.015, Lambda = 4e-5, alpha = 1e-4, P0 = 1e5, pins = 100, L = 0.5, peaking = 1, endT = 0.06, c = 3e6, T0 = 300;
  const doc = load("examples/synthetic-pulse-kinetics.json");
  doc.caseId = "synthetic-pulse-nordheim-fuchs";
  doc.name = "Synthetic pulse from point kinetics, prompt neutrons only: the Nordheim-Fuchs case on the synthetic pin (illustrative numbers)";
  const pk = doc.transient.pointKinetics;
  pk.reactivityInsertion = { value: rho0, unit: "dk/k" };
  pk.promptGenerationTime = { value: Lambda * 1e6, unit: "us" };
  pk.delayedGroups = [];
  delete pk.delayedSource;
  pk.feedback = { model: "constant", coefficient: { value: -alpha, unit: "dk/k/K" }, source: pk.feedback.source };
  pk.initialPower = { value: P0, unit: "W" };
  doc.transient.initialTemperature = { value: T0, unit: "K" };
  doc.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "constant", value: { value: c, unit: "J/m3/K" }, referenceTemperature: { value: T0, unit: "K" }, source: "synthetic: chosen for the Nordheim-Fuchs oracle" };
  const R = si(doc.geometry.fuelRadius);
  const A = Math.PI * R * R;
  const sc = peaking / (pins * L * A);
  const gamma = (alpha * sc) / c;
  const Pmax = (rho0 * rho0) / (2 * gamma * Lambda);
  const tp = ((2 * Lambda) / rho0) * Math.acosh(Math.sqrt(Pmax / P0));
  if (!(tp > 0.01 && tp < endT - 0.02)) throw new Error("the Nordheim-Fuchs pulse is not well inside the window: tp = " + tp);
  const Eend = (rho0 / gamma) * (1 + Math.tanh((rho0 * (endT - tp)) / (2 * Lambda)));
  const perLength = (Eend * peaking) / (pins * L);
  const peak = T0 + (Eend * sc) / c;
  const rise = peak - T0;
  const rel = writeCase("synthetic-pulse-nordheim-fuchs", doc);
  const domain = "synthetic pin, generated pulse from point kinetics (a 1.5 % dk/k step, prompt neutrons only, constant feedback -1e-4 dk/k/K), constant heat capacity, 60 ms window";
  const check = "Second method: oracles/point-kinetics-reference.py (RK4 with bisection and quadrature, run in the feed-solver distro) agrees with the same formulas on the Nordheim-Fuchs case (oracles/point-kinetics-reference.json); FEED's generator tests (tests/pointKinetics.test.ts) check the same closed forms; through the solver, tests/pointKineticsSolver.test.ts.";
  entry({
    id: "feed-synthetic-pulse-nordheim-fuchs-energy-deposited",
    tag: "good",
    casePath: rel,
    expected: { quantity: "energy_deposited", value: round(perLength, 3), unit: "J/m" },
    tolerance: { abs: 0, rel: 3e-3 },
    source: { kind: "analytic", text: "Nordheim-Fuchs: E(t) = (rho0 / gamma)(1 + tanh(rho0 (t - tp) / (2 Lambda))) at the end of the window (" + round(Eend, 1) + " J of reactor energy, peak power " + round(Pmax, 0) + " W at " + round(tp * 1e3, 3) + " ms), times peaking / (pins x length) for the slice. The tolerance covers the thinning of the generated history (energy within 1e-3) and its integration.", check },
    coverage: { quantities: ["energy_deposited"], domain },
  });
  entry({
    id: "feed-synthetic-pulse-nordheim-fuchs-temperature-peak-max",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_peak_max", value: round(peak, 4), unit: "K" },
    tolerance: { abs: Number((3e-3 * rise).toFixed(2)), rel: 0 },
    source: { kind: "analytic", text: "The fuel interior keeps the energy the pulse deposits (adiabatic, the window is 60 ms against a 17 s diffusion time over the radius): T = T0 + E s / c = " + round(peak, 3) + " K.", check },
    coverage: { quantities: ["temperature_peak_max"], domain },
  });
  kineticsGood += 2;
}

// The example pulse with delayed neutron groups (a 3 dollar step): no closed form, so the independent Python integration of oracles/point-kinetics-reference.py
// (a different integrator, its own bisection and quadrature, agreeing with FEED's generator to 1e-5) gives the energy and the final fuel temperature.
{
  const ref = JSON.parse(fs.readFileSync(path.join(root, "oracles", "point-kinetics-reference.json"), "utf8")).find((x) => x.name.startsWith("synthetic-pulse-kinetics example"));
  const doc = load("examples/synthetic-pulse-kinetics.json");
  const rel = writeCase("synthetic-pulse-kinetics", doc);
  const perLength = (ref.reference.totalEnergy * ref.spec.peakingFactor) / (ref.spec.pins * ref.spec.activeLength);
  const rise = ref.reference.peakFuelRise;
  const domain = "synthetic pin, generated pulse from point kinetics (a 3 dollar step, six delayed groups, constant feedback), constant heat capacity, 60 ms window";
  const check = "Independent integration: oracles/point-kinetics-reference.py (RK4, not the generator's Dormand-Prince) in the feed-solver distro; the reference file records its inputs; FEED's generator agrees to 1e-5 (tests/pointKinetics.test.ts, reference cases).";
  entry({
    id: "feed-synthetic-pulse-kinetics-energy-deposited",
    tag: "good",
    casePath: rel,
    expected: { quantity: "energy_deposited", value: round(perLength, 3), unit: "J/m" },
    tolerance: { abs: 0, rel: 3e-3 },
    source: { kind: "analytic", text: "The energy the reactor deposits over the 60 ms window by the independent integration of the point-kinetics equations (" + round(ref.reference.totalEnergy, 1) + " J), for the modelled slice (peaking 1, " + ref.spec.pins + " pins of " + ref.spec.activeLength + " m).", check },
    coverage: { quantities: ["energy_deposited"], domain },
  });
  entry({
    id: "feed-synthetic-pulse-kinetics-temperature-peak-max",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_peak_max", value: round(ref.reference.finalFuelTemperature, 4), unit: "K" },
    tolerance: { abs: Number((3e-3 * rise).toFixed(2)), rel: 0 },
    source: { kind: "analytic", text: "The fuel interior keeps the energy deposited (adiabatic over 60 ms): the independent integration's final lumped fuel temperature, " + round(ref.reference.finalFuelTemperature, 3) + " K.", check },
    coverage: { quantities: ["temperature_peak_max"], domain },
  });
  kineticsGood += 2;
}

// Known limit for a transient: the fuel's heat capacity law stated valid only up to a temperature the pulse exceeds.
{
  const doc = load("schema/vectors/good/pulse-linear-heat-capacity.json");
  doc.transient.timeStep = { value: 0.1, unit: "ms" };
  doc.materials.fuel.sets["thermal.volumetricHeatCapacity"].validRange = { min: { value: 250, unit: "K" }, max: { value: 450, unit: "K" } };
  const a = adiabatic(doc);
  if (a.peak <= 450) throw new Error("the narrowed range no longer excludes the pulse");
  const rel = writeCase("limit-pulse-c-out-of-range", doc);
  entry({
    id: "feed-limit-pulse-c-out-of-range",
    tag: "known-limit",
    casePath: rel,
    expected: { refusalCode: "E_OUT_OF_DOMAIN" },
    source: { kind: "hand", text: "The fuel heat capacity c = a + b T is stated valid on 250-450 K only, while the pulse takes the fuel to " + round(a.peak, 0) + " K. The result must be refused as out of domain.", check: "FEED's transient results mark this as domain.verdict out-of-domain (tests/transient.test.ts)." },
    coverage: { quantities: ["temperature_peak_max"], domain: "heat capacity law used outside its stated temperature range" },
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
    (good + transientGood + kineticsGood) + " good entries (steady: peak, outer-wall temperature, flux and energy balance over eight pins, two of them with a cubic and a tabulated fuel conductivity; pulses: adiabatic peak and energy deposited over four tabulated-power cases, two generated by point kinetics, and a steady-start hold), " + BAD.length + " bad-input entries, 2 known-limit entries.",
    "All cases use the mesh " + MESH.fuelCells + "/" + MESH.claddingCells + " (fuel/cladding cells). The peak is the first fuel cell centre of that mesh.",
    "Pulse entries test the adiabatic limit only: heat leaving the fuel during a long transient has no entry here (FEED checks it against its own independent solution). Not covered: mechanics, a central hole whose surface is not insulated, gap closure and contact, fission gas, burnup, any real design. FEED results are thermal only.",
    "",
  ].join(NL)
);
console.log("wrote " + (good + transientGood + kineticsGood) + " good, " + BAD.length + " bad-input and 2 known-limit entries to " + out);
