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
// FEED_ORACLE_OUT (a folder whose name starts with feed-oracle-) writes the set there instead, so that a test can compare a fresh run with the committed files; the folder is emptied first.
const out = process.env.FEED_ORACLE_OUT ? path.resolve(process.env.FEED_ORACLE_OUT) : path.join(root, "oracles", "seed");
if (process.env.FEED_ORACLE_OUT && !path.basename(out).startsWith("feed-oracle-")) throw new Error("FEED_ORACLE_OUT must be a folder named feed-oracle-*");
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
/** Bisection on any integral F(Tc, T) of the conductivity (plain arithmetic): the T above Tc with F = I. */
function hotSideIntegral(F, Tc, I) {
  let lo = Tc;
  let hi = Tc + 1;
  while (F(Tc, hi) < I) hi = Tc + 2 * (hi - Tc);
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (F(Tc, mid) < I) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
/** Composite Simpson of f over [x0, x1] with about one panel per kelvin (an even count). */
function simpson(f, x0, x1, perUnit = 1) {
  const n = 2 * Math.max(8, Math.ceil(((x1 - x0) * perUnit) / 2));
  const h = (x1 - x0) / n;
  let sum = f(x0) + f(x1);
  for (let i = 1; i < n; i++) sum += f(x0 + i * h) * (i % 2 ? 4 : 2);
  return (sum * h) / 3;
}
/**
 * FRAPCON-3.4 modified NFI (NUREG/CR-7024 Eq. 2.3-10 and 2.3-11), typed here again from the report: T in K, Bu in GWd/tU (= MWd/kgHM), gad a weight fraction,
 * d the density fraction. The same equation as src/core/uo2Nfi.ts: what is independent is the integration and the solve (Simpson and bisection here).
 */
function nfiK(T, Bu, d, gad) {
  const h = 1 / (1 + 396 * Math.exp(-6380 / T));
  const k95 = 1 / (0.0452 + 1.1599 * gad + 0.000246 * T + 0.00187 * Bu + (1 - 0.9 * Math.exp(-0.04 * Bu)) * 0.038 * Bu ** 0.28 * h) + (3.5e9 / (T * T)) * Math.exp(-16361 / T);
  return (1.0789 * k95 * d) / (1 + 0.5 * (1 - d));
}
const hotSideK = (k, Tc, I) => {
  if (k.recip) {
    // k = a / T + b: the integral from Tc is a ln(T / Tc) + b (T - Tc)
    const [a, b] = k.recip;
    return hotSideIntegral((T0, T) => a * Math.log(T / T0) + b * (T - T0), Tc, I);
  }
  if (k.nfi) return hotSideIntegral((T0, T) => simpson((x) => nfiK(x, k.nfi.Bu, k.nfi.d, k.nfi.gad), T0, T), Tc, I);
  return k.coef ? hotSideLaw(k.coef, Tc, I) : hotSide(k.a, k.b, Tc, I);
};
function conductivity(set, doc) {
  const m = set["thermal.conductivity"];
  if (m.model === "reciprocal") return { recip: [si(m.a), si(m.b)] };
  if (m.model === "uo2-nfi") {
    const bu = doc.burnup.value;
    const Bu = bu.unit === "MWd/tHM" ? bu.value * 1e-3 : bu.value; // MWd/kgHM and GWd/tHM are the same number
    const d = m.densityFraction.unit === "%" ? m.densityFraction.value / 100 : m.densityFraction.value;
    return { nfi: { Bu, d, gad: m.gadolinia ? m.gadolinia.value : 0 } };
  }
  if (m.model === "constant") return { a: si(m.value), b: 0 };
  if (m.model === "linear") return { a: si(m.a), b: si(m.b) };
  if (m.model === "polynomial") return { coef: [si(m.a), si(m.b), si(m.c), si(m.d)] };
  if (m.model === "table") return { coef: interpolate(m.points.map((p) => [si(p.temperature), si(p.conductivity)]), m.fit.degree) };
  throw new Error("conductivity model not handled: " + m.model);
}

/** Series solution for one case document, per unit length, on the given radii (the cold ones of the case unless a hot set is passed). */
function series(doc, radii) {
  const q = si(doc.power.linearHeatRate);
  const { Rf, Rci, Rco, ri } = radii;
  const hGap = si(doc.gap.conductance);
  const fk = conductivity(doc.materials.fuel.sets, doc);
  const ck = conductivity(doc.materials.cladding.sets, doc);
  let wall;
  if (doc.boundary.surfaceTemperature) wall = si(doc.boundary.surfaceTemperature);
  else wall = si(doc.boundary.bulkTemperature) + q / (2 * Math.PI * Rco * si(doc.boundary.heatTransferCoefficient));
  const cladInner = hotSideK(ck, wall, (q * Math.log(Rco / Rci)) / (2 * Math.PI));
  const fuelSurface = cladInner + q / (2 * Math.PI * Rf * hGap);
  // Central hole with an insulated surface: the rise to the hole surface is the solid rise times 1 - 2 a^2 ln(1/a) / (1 - a^2).
  const a2 = (ri / Rf) ** 2;
  const holeFactor = ri === 0 ? 1 : 1 - (2 * a2 * Math.log(Rf / ri)) / (1 - a2);
  const centre = hotSideK(fk, fuelSurface, (q / (4 * Math.PI)) * holeFactor);
  return { q, Rco, wall, cladInner, fuelSurface, centre, fuelRise: centre - fuelSurface };
}

const ALPHA_UNIT = { "1/K": 1, "1e-6/K": 1e-6, "ppm/K": 1e-6 };
const ALPHA_B_UNIT = { "1/K2": 1, "1e-9/K2": 1e-9 };
/** Thermal strain at T (kelvin) from the reference temperature: alpha (T - Tref), or a (T - Tref) + b (T^2 - Tref^2) / 2 for alpha = a + b T. */
function strain(le, Tref, T) {
  if (le.model === "linear") {
    const a = le.a.value * ALPHA_UNIT[le.a.unit];
    const b = le.b.value * ALPHA_B_UNIT[le.b.unit];
    return a * (T - Tref) + (b * (T * T - Tref * Tref)) / 2;
  }
  return le.value * ALPHA_UNIT[le.unit] * (T - Tref);
}
/** The area-weighted mean over r in [r0, r1] of g(r) (Simpson on r dr). */
const areaMean = (g, r0, r1) => simpson((r) => g(r) * r, r0, r1, 4000 / (r1 - r0)) / ((r1 * r1 - r0 * r0) / 2);

/**
 * The radii at operating temperature (docs/hot-dimensions.md): each solid's radii times 1 + the area-weighted mean thermal strain on the closed-form profile,
 * iterated to a fixed point. Constant conductivities only (the profiles below are the constant-k ones), solid fuel. Plain arithmetic, no code of src/core.
 */
function hotRadii(doc) {
  const hd = doc.hotDimensions;
  const Tref = si(hd.referenceTemperature);
  const cold = { Rf: si(doc.geometry.fuelRadius), Rci: si(doc.geometry.claddingInnerRadius), Rco: si(doc.geometry.claddingOuterRadius), ri: doc.geometry.fuelInnerRadius ? si(doc.geometry.fuelInnerRadius) : 0 };
  if (cold.ri !== 0) throw new Error("the generator's hot-dimension profiles are for solid fuel");
  const kf = conductivity(doc.materials.fuel.sets, doc);
  const kc = conductivity(doc.materials.cladding.sets, doc);
  if (kf.b !== 0 || kc.b !== 0 || !("a" in kf) || !("a" in kc) || kf.coef || kc.coef) throw new Error("the generator's hot-dimension profiles are for constant conductivities");
  const q = si(doc.power.linearHeatRate);
  let r = { ...cold };
  for (let it = 0; it < 200; it++) {
    const t = series(doc, r);
    const fuelT = (x) => t.fuelSurface + (q / (4 * Math.PI * kf.a)) * (1 - (x * x) / (r.Rf * r.Rf));
    const cladT = (x) => t.wall + (q / (2 * Math.PI * kc.a)) * Math.log(r.Rco / x);
    const sf = areaMean((x) => strain(hd.fuel.linearExpansion, Tref, fuelT(x)), 0, r.Rf);
    const sc = areaMean((x) => strain(hd.cladding.linearExpansion, Tref, cladT(x)), r.Rci, r.Rco);
    const next = { Rf: cold.Rf * (1 + sf), Rci: cold.Rci * (1 + sc), Rco: cold.Rco * (1 + sc), ri: 0 };
    const moved = Math.max(Math.abs(next.Rf - r.Rf), Math.abs(next.Rci - r.Rci), Math.abs(next.Rco - r.Rco));
    r = next;
    if (moved < 1e-15) break;
  }
  if (!(r.Rci > r.Rf)) throw new Error("the hot gap is closed in the generator's case");
  return r;
}

function analytic(doc) {
  const cold = { Rf: si(doc.geometry.fuelRadius), Rci: si(doc.geometry.claddingInnerRadius), Rco: si(doc.geometry.claddingOuterRadius), ri: doc.geometry.fuelInnerRadius ? si(doc.geometry.fuelInnerRadius) : 0 };
  return series(doc, doc.hotDimensions ? hotRadii(doc) : cold);
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
  // ---- the reciprocal conductivity k = a / T + b, hot dimensions and burnup (plan 10 M5; the values are written with the tolerances before any run)
  {
    name: "synthetic-reciprocal-fuel-k",
    from: "examples/synthetic-pin.json",
    edit: (d) => {
      d.materials.fuel.sets["thermal.conductivity"] = { model: "reciprocal", a: { value: 2400, unit: "W/m" }, b: { value: 0.5, unit: "W/m/K" }, validRange: { min: { value: 400, unit: "K" }, max: { value: 2500, unit: "K" } }, source: "synthetic: chosen for the conductivity-integral oracle" };
    },
    domain: "synthetic pin, fuel k = 2400 / T + 0.5 on 400-2500 K (the shape of a phonon-limited ceramic, carried by OFFBEAT's SiCPARFUME), convective boundary",
  },
  {
    name: "synthetic-reciprocal-clad-k",
    from: "examples/synthetic-pin.json",
    edit: (d) => {
      d.materials.cladding.sets["thermal.conductivity"] = { model: "reciprocal", a: { value: 6000, unit: "W/m" }, b: { value: 3, unit: "W/m/K" }, validRange: { min: { value: 300, unit: "K" }, max: { value: 1000, unit: "K" } }, source: "synthetic: chosen for the conductivity-integral oracle" };
    },
    domain: "synthetic pin, cladding k = 6000 / T + 3 on 300-1000 K, convective boundary",
  },
  { name: "synthetic-hot-dimensions", from: "schema/vectors/good/hot-dimensions.json", hot: true, domain: "synthetic pin with hot dimensions: constant expansion 12 ppm/K (fuel) and 10 ppm/K (cladding) from 20 C, constant conductivities, convective boundary (radii at operating temperature, gap conductance as stated)" },
  {
    name: "synthetic-hot-dimensions-linear-alpha",
    from: "schema/vectors/good/hot-dimensions.json",
    hot: true,
    edit: (d) => {
      d.hotDimensions.fuel.linearExpansion = { model: "linear", a: { value: 5, unit: "ppm/K" }, b: { value: 12, unit: "1e-9/K2" }, validRange: { min: { value: 290, unit: "K" }, max: { value: 1600, unit: "K" } } };
    },
    domain: "synthetic pin with hot dimensions: fuel expansion alpha = 5e-6 + 12e-9 T (T in K, valid 290-1600 K), cladding 10 ppm/K, reference 20 C, constant conductivities, convective boundary",
  },
  { name: "lwr-uo2-burnup-0", from: "examples/lwr-uo2-burnup.json", edit: (d) => (d.burnup.value = { value: 0, unit: "MWd/kgHM" }), domain: "LWR UO2 pin at 20 kW/m, fuel conductivity by the modified NFI model (NUREG/CR-7024) at 0 MWd/kgHM (fresh), 95 % TD, Zircaloy cladding by MATPRO CTHCON, frozen-burnup snapshot" },
  { name: "lwr-uo2-burnup-40", from: "examples/lwr-uo2-burnup.json", domain: "LWR UO2 pin at 20 kW/m, fuel conductivity by the modified NFI model (NUREG/CR-7024) at 40 MWd/kgHM, 95 % TD, Zircaloy cladding by MATPRO CTHCON, frozen-burnup snapshot" },
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
  if (g.hot) {
    const cold = JSON.parse(JSON.stringify(doc));
    delete cold.hotDimensions;
    const shift = Math.abs(analytic(cold).centre - a.centre);
    if (shift < 1) throw new Error(g.name + ": the hot dimensions move the peak by only " + shift + " K; the entry would not test them");
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
  { id: "feed-bad-limits-no-source", file: "limits-no-source", code: "E_PROP_MISSING", what: "a temperature limit with no source (FEED has no limits of its own, so a limit must say where it comes from)" },
  { id: "feed-bad-limits-condition-never-holds", file: "limits-condition-never-holds", code: "E_OUT_OF_RANGE", what: "a fuel limit conditioned on a cladding band whose upper end is below its lower end, so it would never be in force" },
  { id: "feed-bad-limits-duplicate-name", file: "limits-duplicate-name", code: "E_SCHEMA_INVALID", what: "two temperature limits with the same name, so a result could not say which one it is about" },
  { id: "feed-bad-limits-maximum-wrong-unit", file: "limits-maximum-wrong-unit", code: "E_UNITS", what: "a temperature limit whose maximum is given in a unit that is not a temperature" },
  { id: "feed-bad-burnup-model-without-burnup", file: "burnup-model-without-burnup", code: "E_PROP_MISSING", what: "a fuel with the burnup conductivity model and no burnup stated (0 is stated, not assumed)" },
  { id: "feed-bad-burnup-without-model", file: "burnup-without-model", code: "E_UNSUPPORTED", what: "a burnup stated for a fuel whose conductivity does not depend on it (it would change nothing)" },
  { id: "feed-bad-burnup-oxide-basis", file: "burnup-oxide-basis", code: "E_UNSUPPORTED", what: "a burnup on an oxide basis (the record and the model are on heavy metal; a silent factor would be 12 % off)" },
  { id: "feed-bad-burnup-above-range", file: "burnup-above-range", code: "E_OUT_OF_RANGE", what: "a burnup of 63 MWd/kgHM, above the 62 the conductivity model is valid for" },
  { id: "feed-bad-hot-dimensions-closes-gap", file: "hot-dimensions-closes-gap", code: "E_GEOMETRY", what: "a fuel expansion so large that the hot fuel touches the hot cladding (contact needs mechanics, which FEED does not have)" },
  { id: "feed-bad-hot-dimensions-no-source", file: "hot-dimensions-no-source", code: "E_PROP_MISSING", what: "an expansion coefficient with no source" },
  { id: "feed-bad-hot-dimensions-transient", file: "hot-dimensions-transient", code: "E_UNSUPPORTED", what: "hot dimensions on a transient case (the temperatures, and so the radii, change with time)" },
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

// ---- temperature limit margins (SEED quantity temperature_limit_margin, K): the smallest margin over the rules in force, the limit minus the hottest cell.
// The TRIGA fuel limit is 1150 C while the cladding is at most 500 C and 950 C above that (K-State SAR 2004 and UT-Austin SAR); in both cases the cladding stays far
// below 500 C (checked below from the closed form), so only the 1150 C rule is in force and the margin is 1150 C minus the hottest fuel cell. Tolerances are the
// peak entries' (steady: 5 x rise / N^2; pulse: 2e-3 x rise), since the margin differs from the peak only by the limit, an exact number.
let limitGood = 0;
{
  const LIMIT_K = 1150 + 273.15;
  const CLAD_K = 500 + 273.15;
  const check = "Second method: the same peak entry's cross-checks (the SAR's own equation 9 for the steady case; oracles/transient-case-reference.py for the pulse); the margin is that peak subtracted from the limit, and FEED's limit check reports the same number through the real solver (docs/temperature-limits.md).";
  {
    const doc = withMesh(load("examples/ksu-triga-1p25mw-film-limits.json"));
    const rel = writeCase("ksu-triga-1p25mw-film-limits", doc);
    const a = analytic(doc);
    if (!(a.cladInner < CLAD_K - 100)) throw new Error("the K-State cladding is not clearly below 500 C; the 950 C rule might apply");
    entry({
      id: "feed-ksu-triga-1p25mw-film-limits-temperature-limit-margin",
      tag: "good",
      casePath: rel,
      expected: { quantity: "temperature_limit_margin", value: round(LIMIT_K - a.centre, 4), unit: "K" },
      tolerance: { abs: peakTolerance(a), rel: 0 },
      source: { kind: "analytic", text: "The limit minus the closed-form centre temperature: 1150 C = " + round(LIMIT_K, 2) + " K minus " + round(a.centre, 4) + " K. The cladding runs at " + round(a.cladInner, 1) + " K, below 500 C, so the 1150 C rule is the one in force and the 950 C rule has no margin. A margin is not an integrity assessment: FEED computes no stress.", check },
      coverage: { quantities: ["temperature_limit_margin"], domain: "K-State TRIGA hottest element at 1.25 MW with the SAR film coefficient and the SAR fuel temperature limits (illustrative, not a safety case)" },
    });
    limitGood++;
  }
  {
    const doc = load("examples/ut-triga-pulse-4p40-limits.json");
    const rel = writeCase("ut-triga-pulse-4p40-limits", doc);
    const a = adiabatic(doc);
    if (Math.abs(a.peak - 1097.469086) > 1e-4) throw new Error("the UT pulse peak is not the independent Python value");
    if (!(si(doc.transient.initialTemperature) < CLAD_K - 100)) throw new Error("the UT pulse starts too close to the cladding condition");
    entry({
      id: "feed-ut-triga-pulse-4p40-limits-temperature-limit-margin",
      tag: "good",
      casePath: rel,
      expected: { quantity: "temperature_limit_margin", value: round(LIMIT_K - a.peak, 4), unit: "K" },
      tolerance: { abs: Number((2e-3 * a.rise).toFixed(2)), rel: 0 },
      source: { kind: "analytic", text: "The limit minus the adiabatic peak: 1150 C = " + round(LIMIT_K, 2) + " K minus " + round(a.peak, 4) + " K. The pulse is a few milliseconds from 20 C, so the cladding stays far below 500 C and only the 1150 C rule is in force. A margin is not an integrity assessment: FEED computes no stress.", check },
      coverage: { quantities: ["temperature_limit_margin"], domain: "TRIGA hot channel, sech^2 pulse built from UT-Austin SAR numbers (illustrative), with the SAR fuel temperature limits" },
    });
    limitGood++;
  }
}

// ---- literature oracles: the General Atomic report GA-7882, "Kinetic Behavior of TRIGA Reactors" (1967), Table VII (page 31), the modified Fuchs-Nordheim model.
// A TRIGA core with a prompt lifetime of 4e-5 s, C0 = 8e4 W s/C (at 25 C) and C1 = 1.5e2 W s/C^2 per core, a prompt temperature coefficient of 1e-4 per C, and a prompt
// reactivity above prompt critical of 0.014 (a $3 pulse) or 0.028 (a $5 pulse). The EXPECTED VALUES ARE THE REPORT'S PRINTED NUMBERS (kind "published"), not ours; the exact
// derivation below (Simpson's rule on the energy balance) is only the cross-check that the report's rounded table and its approximate equation for the rise are within the
// tolerance. The core is described to FEED as 720 pins of 1 m of the synthetic pin's fuel (0.038 m3), so its heat capacity per cubic metre is the report's core value over that volume.
let gaGood = 0;
{
  const LIFE = 4e-5, C0 = 8e4, C1 = 1.5e2, ALPHA = 1e-4, T0K = 298.15, PINS = 720, LENGTH = 1;
  const base = load("examples/synthetic-pulse-kinetics.json");
  const area = Math.PI * si(base.geometry.fuelRadius) ** 2;
  const vol = PINS * LENGTH * area;
  const exact = (dk) => {
    const simpsonN = (f, a, b, n = 4000) => {
      const h = (b - a) / n;
      let t = f(a) + f(b);
      for (let i = 1; i < n; i++) t += f(a + i * h) * (i % 2 ? 4 : 2);
      return (t * h) / 3;
    };
    const energy = (th) => C0 * th + (C1 * th * th) / 2;
    const power = (th) => (dk * energy(th) - ALPHA * simpsonN((x) => (C0 + C1 * x) * x, 0, th)) / LIFE;
    let lo = dk / ALPHA, hi = 4 * dk / ALPHA;
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (power(mid) > 0) lo = mid;
      else hi = mid;
    }
    const rise = 0.5 * (lo + hi);
    return { pmax: power(dk / ALPHA), e: energy(rise), rise };
  };
  const ROWS = [
    { id: "ga7882-pulse-3-dollar", dk: 0.014, label: "$3", pmax: 2130, e: 26.1, rise: 262 },
    { id: "ga7882-pulse-5-dollar", dk: 0.028, label: "$5", pmax: 9210, e: 59.7, rise: 506 },
  ];
  for (const row of ROWS) {
    const doc = JSON.parse(JSON.stringify(base));
    doc.caseId = row.id;
    doc.name = "GA-7882 Table VII core, " + row.label + " pulse (modified Fuchs-Nordheim model); an illustrative pin, only the core parameters are the report's";
    const t = doc.transient;
    t.endTime = { value: 60, unit: "ms" };
    t.outputs = 3; // 20, 40 and 60 ms: divides the 1200 steps of 0.05 ms; an output before the pulse has deposited less than the six digits of the solver's fields can resolve, which the energy balance would judge
    t.initialTemperature = { value: T0K, unit: "K" };
    const pk = t.pointKinetics;
    pk.reactivityInsertion = { value: row.dk, unit: "dk/k" };
    pk.promptGenerationTime = { value: LIFE * 1e6, unit: "us" };
    pk.delayedGroups = [];
    delete pk.delayedSource;
    pk.feedback = { model: "constant", coefficient: { value: -ALPHA, unit: "dk/k/K" }, source: "General Atomic GA-7882, Table VII: prompt temperature coefficient 1e-4 per C" };
    pk.initialPower = { value: 100, unit: "kW" }; // the report neglects the initial power; 100 kW is 5e-5 of the peak and brings the pulse to about 32 ms
    pk.core = { pins: PINS, activeLength: { value: LENGTH, unit: "m" }, peakingFactor: { value: 1, unit: "1" } };
    // C(T) = C0 + C1 (T - 25 C) per core, per cubic metre of fuel and in kelvin: a = (C0 - C1 T0K) / V, b = C1 / V
    doc.materials.fuel.sets["thermal.volumetricHeatCapacity"] = {
      model: "linear",
      a: { value: Number(((C0 - C1 * T0K) / vol).toFixed(3)), unit: "J/m3/K" },
      b: { value: Number((C1 / vol).toFixed(5)), unit: "J/m3/K2" },
      validRange: { min: { value: 273.15, unit: "K" }, max: { value: 1273.15, unit: "K" } },
      source: "General Atomic GA-7882, Table VII: C = C0 + C1 T per core with C0 = 8e4 W s/C at 25 C and C1 = 1.5e2 W s/C^2, divided by the volume of the 720 pins of 1 m modelled here",
    };
    const ex = exact(row.dk);
    // the table is rounded and its equation 16 approximate: the exact derivation must be within the tolerances of the entries
    if (Math.abs(ex.e / 1e6 / row.e - 1) > 5e-3 || Math.abs(ex.pmax / 1e6 / row.pmax - 1) > 5e-3 || Math.abs(ex.rise - row.rise) > 1) throw new Error(row.id + ": the exact derivation leaves the published row");
    const rel = writeCase(row.id, doc);
    const domain = "TRIGA-like core of the report GA-7882 (Table VII): " + row.label + " pulse, prompt neutrons only (no delayed groups), constant prompt coefficient of -1e-4 per K, heat capacity C = C0 + C1 T, 60 ms window (the pulse is over in about 45 ms), initial power 100 kW (about 5e-5 of the peak: the report neglects it); the core is " + PINS + " pins of " + LENGTH + " m, the pin an illustrative synthetic one";
    const check = "Cross-check: " + "tests/gaKineticsTable.test.ts derives the same model exactly (Simpson's rule) and gets " + (ex.pmax / 1e6).toFixed(1) + " MW, " + (ex.e / 1e6).toFixed(2) + " MW s and a rise of " + ex.rise.toFixed(1) + " C; FEED's generator agrees with that to 1e-4. The report's numbers are rounded and its equation 16 for the rise is an approximation, so the tolerance is 0.5 %.";
    const text = "General Atomic report GA-7882, Kinetic Behavior of TRIGA Reactors (1967), Table VII, page 31, modified Fuchs-Nordheim model (C = C0 + C1 T), " + row.label + " pulse (delta k prompt " + row.dk + "): peak power " + row.pmax + " MW, burst energy " + row.e + " MW s, temperature rise of the burst " + row.rise + " C (parameters: lifetime 4e-5 s, C0 = 8e4 W s/C at 25 C, C1 = 1.5e2 W s/C^2, alpha = 1e-4 per C per core). ";
    entry({
      id: "feed-" + row.id + "-energy-deposited",
      tag: "good",
      casePath: rel,
      expected: { quantity: "energy_deposited", value: round((row.e * 1e6 * 1) / (PINS * LENGTH), 3), unit: "J/m" },
      tolerance: { abs: 0, rel: 5e-3 },
      source: { kind: "published", text: text + "The energy of the slice is the burst energy of the core over the " + PINS + " pins of " + LENGTH + " m.", check },
      coverage: { quantities: ["energy_deposited"], domain },
    });
    entry({
      id: "feed-" + row.id + "-temperature-peak-max",
      tag: "good",
      casePath: rel,
      expected: { quantity: "temperature_peak_max", value: round(T0K + row.rise, 4), unit: "K" },
      tolerance: { abs: Number((5e-3 * row.rise).toFixed(2)), rel: 0 },
      source: { kind: "published", text: text + "The hottest fuel is the start temperature of 25 C plus the published rise (the interior of a pulse of some 15 ms is adiabatic: the diffusion time over the radius is seconds).", check },
      coverage: { quantities: ["temperature_peak_max"], domain },
    });
    gaGood += 2;
  }
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


// ---- mechanics (docs/plans/09-mechanics.md M6). Closed forms written here with plain formulas, independently of src/core (the generator uses none of it) and never from a
// solver run; the tolerances are fixed HERE, before any run of these entries against the solver: 1 % for a displacement or an axial stress of a uniformly heated solid (the
// pin is within 0.3 K of its coolant, so the temperature varies by 0.1 % of the 300 K it is heated by), 1 % for the hoop stress of a thick tube under a gas pressure (the
// exact Lame value at the cell centre), 4 % for a contact pressure (the sweep of M3 gave 2 % low at the factor 0.3 and 1.1 % at 0.5 for equal moduli, so the tolerance is several times that),
// 3 MPa for the margin of a stress limit (0.75 % of its 400 MPa), 1e-4 for the hydrogen pressure FEED works out from the closed-form temperature.
// Observed quantities are cell-centre values, as everywhere in this set; but the mechanics cases use the uniform mesh 20/8, not 100/20: on the real solver the fine mesh did
// not converge the penalty contact (E_NOT_CONVERGED at the factor 0.3, equal moduli), and with mechanics on the temperature moves by about 0.13 % at 20 kW/m (0.7 K), which
// fails the thermal closed-form check's bound 5 dT / N^2 at 100 cells (0.27 K) and passes it at 20 (6.6 K). Found when these entries were first run (docs/mechanics.md).
const MECH_MESH = { fuelCells: 20, claddingCells: 8 };
let mechGood = 0;
let mechKnown = 0;
{
  const NU = 0.3, E = 2e11, TREF = 300;
  const q = (v, u) => ({ value: v, unit: u });
  const sets = (Eg, a) => ({
    "mechanical.elasticity": { model: "constant", youngModulus: q(Eg, "Pa"), poissonRatio: q(NU, "1"), source: "synthetic, chosen for the closed-form entries" },
    "mechanical.thermalExpansion": { linearExpansion: q(a, "1/K"), source: "synthetic, chosen for the closed-form entries" },
  });
  /** The synthetic pin at 10 W/m (within 0.3 K of the 600 K coolant) with mechanics: both solids E = 200 GPa, nu = 0.3 unless stated. */
  function mechDoc(o) {
    const d = { ...load("examples/synthetic-pin.json"), mesh: { ...MECH_MESH } };
    d.name = o.name;
    d.description = o.description;
    d.power.linearHeatRate = q(o.q ?? 10, o.q ? "kW/m" : "W/m");
    d.boundary = { bulkTemperature: q(600, "K"), heatTransferCoefficient: q(30000, "W/m2/K") };
    d.geometry.claddingInnerRadius = q(o.rci ?? 4.12, "mm");
    d.assumptions.thermalOnly = false;
    Object.assign(d.materials.fuel.sets, sets(o.Ef ?? E, o.af ?? 1e-5));
    Object.assign(d.materials.cladding.sets, sets(E, o.ac ?? 1e-5));
    d.mechanics = { referenceTemperature: q(TREF, "K"), plane: o.plane ?? "free-axial", contact: { penaltyFactor: q(o.penalty ?? 0.3, "1") }, coolantPressure: q(0, "Pa"), ...(o.extra ?? {}) };
    return d;
  }
  /** Closed-form temperatures of a mechanics case (constant conductivities): T(r) of the fuel and of the cladding, and their area-weighted means. */
  function profiles(doc) {
    const a = analytic(doc);
    const Rf = si(doc.geometry.fuelRadius), Rci = si(doc.geometry.claddingInnerRadius), Rco = si(doc.geometry.claddingOuterRadius);
    // the cladding's conductivity follows from the closed-form drop across it (constant k): q ln(Rco / Rci) / (2 pi (cladInner - wall))
    const kc = (a.q * Math.log(Rco / Rci)) / (2 * Math.PI * (a.cladInner - a.wall));
    const Tf = (r) => a.fuelSurface + a.fuelRise * (1 - (r * r) / (Rf * Rf));
    const Tc = (r) => a.wall + (a.q * Math.log(Rco / r)) / (2 * Math.PI * kc);
    return { a, Rf, Rci, Rco, kc, Tf, Tc, meanF: areaMean(Tf, 0, Rf), meanC: areaMean(Tc, Rci, Rco) };
  }
  const cells = (doc) => ({ fuelLast: (r) => r * (1 - 1 / (2 * MECH_MESH.fuelCells)), cladFirst: (Rci, Rco) => Rci + (Rco - Rci) / (2 * MECH_MESH.claddingCells), cladLast: (Rci, Rco) => Rco - (Rco - Rci) / (2 * MECH_MESH.claddingCells), fuelFirst: (r) => r / (2 * MECH_MESH.fuelCells) });
  const mechEntry = (o) => {
    entry({ id: "feed-" + o.file + "-" + o.quantity.replace(/_/g, "-"), tag: o.tag ?? "good", casePath: o.rel, expected: { quantity: o.quantity, value: o.value, unit: o.unit }, tolerance: o.tolerance, source: { kind: "analytic", text: o.text, check: o.check }, coverage: { quantities: [o.quantity], domain: o.domain } });
    if ((o.tag ?? "good") === "good") mechGood++;
    else mechKnown++;
  };
  const dom = (extra) => "synthetic pin at 10 W/m in a 600 K coolant, both solids linear elastic (E 200 GPa, nu 0.3) stress-free at 300 K, constant conductivities; thermo-elastic, small strain, no creep, plasticity or swelling" + (extra ? "; " + extra : "");

  // 1 and 2: free thermal expansion, free axially: u = alpha theta r at the cell centre (the solid is not constrained, so it is the same for any nu).
  {
    const doc = mechDoc({ name: "Mechanics: free thermal expansion", description: "A pin at its coolant temperature, expanding freely from 300 K (free axially): u = alpha (T - Tref) r in each solid.", af: 1e-5, ac: 1.7e-5 });
    const p = profiles(doc);
    const rel = writeCase("mechanics-free-expansion", doc);
    const c = cells(doc);
    const uF = 1e-5 * (p.meanF - TREF) * c.fuelLast(p.Rf);
    const uC = 1.7e-5 * (p.meanC - TREF) * c.cladLast(p.Rci, p.Rco);
    const check = "FEED's real-solver test (tests/mechanicsSolver.test.ts, free thermal expansion) reproduces u = alpha dT r to 0.2 % and its independent thermo-elastic solution (src/core/thermoElastic.ts, checked against Timoshenko and Lame) agrees with every result.";
    mechEntry({ file: "mechanics-free-expansion", rel, quantity: "displacement_radial_fuel_last_cell", value: Number(uF.toPrecision(6)), unit: "m", tolerance: { abs: 0, rel: 0.01 }, text: "A solid that is free to expand (no gap closure, free axially) grows by u = alpha (T - Tref) r: for a long free-ended cylinder the surface strain is alpha times the area-mean temperature rise, whatever Poisson's ratio. Fuel alpha 1e-5 per K, mean rise " + round(p.meanF - TREF, 3) + " K, last fuel cell centre at " + round(c.fuelLast(p.Rf) * 1e3, 4) + " mm.", check, domain: dom("fuel alpha 1e-5 per K, cladding alpha 17e-6 per K, free axially, the 20 micron gap stays open") });
    mechEntry({ file: "mechanics-free-expansion", rel, quantity: "displacement_radial_clad_last_cell", value: Number(uC.toPrecision(6)), unit: "m", tolerance: { abs: 0, rel: 0.01 }, text: "The same for the cladding (a hollow cylinder with free surfaces): u = alpha (T - Tref) r at its outermost cell centre, " + round(c.cladLast(p.Rci, p.Rco) * 1e3, 4) + " mm, cladding alpha 17e-6 per K, rise " + round(p.meanC - TREF, 3) + " K.", check, domain: dom("fuel alpha 1e-5 per K, cladding alpha 17e-6 per K, free axially, the 20 micron gap stays open") });
  }
  // 3 and 7: plane strain (axially fixed), uniform heating: sigma_z = -E alpha theta, sigma_r = sigma_theta = 0; and the margin of a fuel stress limit against its von Mises stress.
  {
    const doc = mechDoc({ name: "Mechanics: axially fixed", description: "A pin at its coolant temperature, axially fixed (plane strain): the axial stress is -E alpha (T - Tref).", af: 1e-5, plane: "plane-strain" });
    doc.mechanics.stressLimits = [{ name: "fuel-flat-1GPa", region: "fuel", table: [{ temperature: q(300, "K"), strength: q(1000, "MPa") }, { temperature: q(1500, "K"), strength: q(1000, "MPa") }], source: "synthetic: a flat strength of 1 GPa, chosen so that the margin is a closed form" }];
    const p = profiles(doc);
    const rel = writeCase("mechanics-axially-fixed", doc);
    const c = cells(doc);
    const thetaMax = p.Tf(c.fuelFirst(p.Rf)) - TREF;
    const sz = -E * 1e-5 * thetaMax;
    const check = "FEED's real-solver test (tests/mechanicsSolver.test.ts, plane strain) reproduces sigma_z = -E alpha dT to 0.5 %.";
    mechEntry({ file: "mechanics-axially-fixed", rel, quantity: "stress_axial_fuel_min", value: Number(sz.toPrecision(6)), unit: "Pa", tolerance: { abs: 0, rel: 0.01 }, text: "With the axial strain held at zero a uniformly heated solid has sigma_z = -E alpha (T - Tref) and no radial or hoop stress. The most compressive cell is the hottest, the first fuel cell centre (" + round(p.Tf(c.fuelFirst(p.Rf)), 3) + " K, rise " + round(thetaMax, 3) + " K), E 200 GPa, alpha 1e-5 per K.", check, domain: dom("axially fixed (plane strain)") });
    const margin = 1e9 - Math.abs(sz);
    mechEntry({ file: "mechanics-axially-fixed", rel, quantity: "stress_limit_margin", value: Number(margin.toPrecision(6)), unit: "Pa", tolerance: { abs: 3e6, rel: 0 }, text: "A stress limit the case states for the fuel (a flat strength of 1 GPa, a synthetic figure) against the largest von Mises stress, which for this state is |sigma_z| = E alpha (hottest cell rise): margin 1 GPa minus " + round(Math.abs(sz) / 1e6, 2) + " MPa. The check is the smallest margin over the fuel's cells.", check: check + " The margin is the check 'stressLimit:<name>' of FEED's result.", domain: dom("axially fixed, one fuel stress limit with a flat strength") });
  }
  // 4: the closing gap, plane strain: the interference pressure of two cylinders from their compliances.
  const contactClosed = (Ef, af, penalty, plane) => {
    const doc = mechDoc({ name: "Mechanics: gap closure", description: "A fuel that expands faster than its cladding closes the 20 micron gap (axially fixed): the interference pressure of two cylinders.", Ef, af, penalty, plane });
    const p = profiles(doc);
    const thF = p.meanF - TREF, thC = p.meanC - TREF;
    // plane strain: the fuel surface moves out (1 + nu) alpha theta R and in by (1 + nu)(1 - 2 nu) p R / E; the cladding bore moves out (1 + nu) alpha theta Rci and by (1 + nu) p Rci / E [(1 - nu)(Rci^2 + Rco^2) / (Rco^2 - Rci^2) + nu]
    const overlap = (1 + NU) * af * thF * p.Rf - (1 + NU) * 1e-5 * thC * p.Rci - (p.Rci - p.Rf);
    const cf = ((1 + NU) * (1 - 2 * NU) * p.Rf) / Ef;
    const cc = (((1 + NU) * p.Rci) / E) * (((1 - NU) * (p.Rci * p.Rci + p.Rco * p.Rco)) / (p.Rco * p.Rco - p.Rci * p.Rci) + NU);
    if (!(overlap > 0)) throw new Error("the gap does not close in the generator's contact case");
    return { doc, p, overlap, pressure: overlap / (cf + cc), thF, thC };
  };
  {
    // the first run of this entry at the factor 0.3 failed FEED's own displacement check by 4 % over its bound (the cladding's displacement 1.1 % off: the penalty contact leaves an
    // overlap that grows with the pressure, which is higher here, axially fixed, than in the sweep of M3); 0.5 is stable for equal moduli (the sweep) and leaves about half of it.
    const k = contactClosed(E, 3e-5, 0.5, "plane-strain");
    const rel = writeCase("mechanics-gap-closure", k.doc);
    mechEntry({ file: "mechanics-gap-closure", rel, quantity: "contact_pressure", value: Number(k.pressure.toPrecision(6)), unit: "Pa", tolerance: { abs: 0, rel: 0.04 }, text: "Fuel alpha 3e-5 per K (a synthetic figure) against 1e-5 for the cladding closes the 20 micron gap with a free overlap of " + round(k.overlap * 1e6, 3) + " micron; the contact pressure is that overlap over the sum of the compliances of the two cylinders (plane strain: the solid fuel's (1 + nu)(1 - 2 nu) R / E and the thick cladding tube's Lame bore compliance).", check: "FEED's independent solution (src/core/thermoElastic.ts) gives the same pressure to 1e-9 in tests/thermoElastic.test.ts (the interference test written from these compliances); the real-solver sweep of M3 finds the penalty contact 1.1 % low at the factor 0.5 for equal moduli (2 % at 0.3), which is why the tolerance is 4 %.", domain: dom("axially fixed, fuel alpha 3e-5 per K, cladding alpha 1e-5 per K, penalty factor 0.5, the 20 micron gap closes") });
  }
  // known limit: a fuel a quarter as stiff as its cladding needs the factor 0.7 for the penalty contact to converge and then its pressure is about 3 % low (FEED's sweep, docs/mechanics.md).
  {
    const k = contactClosed(5e10, 3e-5, 0.7, "plane-strain");
    const rel = writeCase("mechanics-gap-closure-soft-fuel", k.doc);
    mechEntry({ tag: "known-limit", file: "mechanics-gap-closure-soft-fuel", rel, quantity: "contact_pressure", value: Number(k.pressure.toPrecision(6)), unit: "Pa", tolerance: { abs: 0, rel: 0.02 }, text: "As the closing-gap entry with a fuel a quarter as stiff as its cladding (E 5e10 against 2e11, the TRIGA fuel against steel is 0.3) and the penalty factor 0.7, the one that converges for such a pair. The same two-cylinder compliance form gives the pressure; FEED's penalty contact is known to give it 2.7 to 3.1 % low there.", check: "FEED's sweep (docs/mechanics.md, 'What the contact sweep found'; the gated tests of tests/mechanicsSolver.test.ts assert the known limit). The tolerance of 2 % is below the known error on purpose: this entry records a limit and is expected to miss.", domain: dom("axially fixed, a soft fuel (E 5e10), penalty factor 0.7") });
  }
  // 5: an open gap with a gas pressure: the hoop stress of the cladding is a Lame tube loaded inside.
  {
    const gasP = 5e6;
    const doc = mechDoc({ name: "Mechanics: gas pressure in the gap", description: "A 5 MPa gas pressure in the open gap (axially fixed): the cladding is a thick tube loaded inside.", plane: "plane-strain", extra: { internalPressure: { model: "constant", pressure: q(5, "MPa"), source: "synthetic: a stated pressure chosen for the closed form" } } });
    const p = profiles(doc);
    const rel = writeCase("mechanics-gas-pressure", doc);
    const c = cells(doc);
    const r = c.cladFirst(p.Rci, p.Rco);
    const hoop = ((gasP * p.Rci * p.Rci) / (p.Rco * p.Rco - p.Rci * p.Rci)) * (1 + (p.Rco * p.Rco) / (r * r));
    mechEntry({ file: "mechanics-gas-pressure", rel, quantity: "stress_hoop_clad_first_cell", value: Number(hoop.toPrecision(6)), unit: "Pa", tolerance: { abs: 0, rel: 0.01 }, text: "Lame's thick tube under an inside pressure of 5 MPa and none outside: sigma_theta = p a^2 / (b^2 - a^2) (1 + b^2 / r^2), here at the first cladding cell centre r = " + round(r * 1e3, 4) + " mm (a = 4.12 mm, b = 4.75 mm). The cladding is uniformly heated, which adds no stress in a free tube.", check: "FEED's real-solver test (tests/mechanicsSolver.test.ts, a gas pressure) finds the inner hoop stress of the Lame value to 3 %, and its independent solution reproduces the Lame tube to 1e-9 (tests/mechanicsInternalPressure.test.ts).", domain: dom("axially fixed, a constant gas pressure of 5 MPa in the open gap, no coolant pressure") });
  }
  // 6: the hydrogen pressure of the fuel (Simnad's correlation), at the closed-form centre temperature.
  {
    const doc = mechDoc({ name: "Mechanics: hydrogen pressure", description: "The hydrogen dissociation pressure of U-ZrH (H/Zr 1.65) at the fuel's peak temperature, as the gas pressure in the gap.", q: 20, extra: { internalPressure: { model: "hydrogen-zrh", hZrRatio: q(1.65, "1"), fuelTemperature: "peak", source: "Simnad, General Atomic E-117-833, section 2.4 (dissociation pressures)" } } });
    const p = profiles(doc);
    const X = 1.65;
    const k1 = -3.8415 + 38.6433 * X - 34.2639 * X ** 2 + 9.2821 * X ** 3;
    const k2 = -31.2982 + 23.5741 * X - 6.028 * X ** 2;
    const P = 101325 * 10 ** (k1 + (k2 * 1e3) / p.a.centre);
    const rel = writeCase("mechanics-hydrogen-pressure", doc);
    mechEntry({ file: "mechanics-hydrogen-pressure", rel, quantity: "gas_pressure", value: Number(P.toPrecision(6)), unit: "Pa", tolerance: { abs: 0, rel: 1e-4 }, text: "General Atomic report E-117-833 (Simnad), section 2.4: log10 P(atm) = K1 + K2 x 1e3 / T with K1 = -3.8415 + 38.6433 X - 34.2639 X^2 + 9.2821 X^3 and K2 = -31.2982 + 23.5741 X - 6.0280 X^2, X = H/Zr = 1.65, at the closed-form peak fuel temperature " + round(p.a.centre, 3) + " K of this 20 kW/m pin: " + round(P / 1e6, 4) + " MPa. The value is the case's gas pressure as FEED works it out (the temperature is the closed form's, not the mesh's).", check: "FEED's tests/hydrogenPressure.test.ts evaluates the same correlation at four points against a separate script, and the UT-Austin SAR figure 4.3b is reproduced (1.56 MPa at 960 C for H/Zr 1.65).", domain: "synthetic pin at 20 kW/m, U-ZrH-like hydrogen pressure for H/Zr 1.65 taken at the peak fuel temperature; FEED computes no hydrogen inventory and the report gives no temperature range for the correlation" });
  }
}

// bad-input entries for the mechanics section: refused by the validator before any run, with the codes of FEED's vectors
const MECH_BAD = [
  { id: "feed-bad-mechanics-section-missing", file: "mechanics-section-missing", code: "E_PROP_MISSING", what: "assumptions.thermalOnly false (mechanics asked for) with no mechanics section: nothing says the stress-free temperature, the axial condition, the contact or the coolant pressure" },
  { id: "feed-bad-mechanics-penalty-too-high", file: "mechanics-penalty-too-high", code: "E_OUT_OF_RANGE", what: "a contact penalty factor of 10, which gave a pressure eleven times too large with nothing in OFFBEAT's log to say so" },
  { id: "feed-bad-mechanics-with-burnup", file: "mechanics-with-burnup", code: "E_UNSUPPORTED", what: "mechanics together with a burnup (swelling and densification are not modelled, so the combination would look more complete than it is)" },
  { id: "feed-bad-mechanics-internal-pressure-no-source", file: "mechanics-internal-pressure-no-source", code: "E_PROP_MISSING", what: "a gas pressure in the gap with no source (FEED has no gas inventory of its own, so the case says where the number comes from)" },
  { id: "feed-bad-mechanics-hydrogen-ratio-out-of-range", file: "mechanics-hydrogen-ratio-out-of-range", code: "E_OUT_OF_RANGE", what: "an H/Zr ratio of 2.1, outside the delta phase (1.5 to 1.8) that the hydrogen pressure correlation is for" },
  { id: "feed-bad-mechanics-stress-limit-unordered-table", file: "mechanics-stress-limit-unordered-table", code: "E_OUT_OF_RANGE", what: "a stress limit whose strength table does not have increasing temperatures, so the strength at a temperature would not be defined" },
];
let mechBad = 0;
for (const b of MECH_BAD) {
  const rel = writeCase(b.id.replace(/^feed-bad-/, "bad-"), load("schema/vectors/bad/" + b.file + ".json"));
  entry({
    id: b.id,
    tag: "bad-input",
    casePath: rel,
    expected: { refusalCode: b.code },
    source: { kind: "hand", text: "A case with one fault: " + b.what + ". FEED must refuse it before any run; SEED reports " + b.code + ".", check: "FEED's schema vectors (schema/vectors/bad/" + b.file + ".json) assert the same code in FEED's own test suite." },
    coverage: { quantities: ["case-validation"], domain: "FEED case validation" },
  });
  mechBad++;
}

// ---- a coolant side that changes with time (plan 11 B5). A pin with a conductivity of 400 W/m/K in both solids has a Biot number of about 0.001 for a film coefficient of 100 W/m2/K, so it is
// a lumped body to within a small fraction of a kelvin: C dT/dt = q' - h(t) A (T - T_b(t)), C the heat capacity per metre of fuel and cladding, A the outer surface per metre. The expected
// value is that ODE integrated here by classical RK4 (step 1 ms) through the history as written, with nothing from FEED's src/core. The hottest cell of the mesh is above the mean by
// q'/(4 pi k) (0.06 K at 300 W/m), far below the tolerance, which is 1 % of the rise, fixed before any run from the first-order error of the 0.05 s step against a time constant of at least 12 s
// (0.4 %) and the lumped approximation. Each case warms monotonically, so the largest peak over the run is the value at the end time (checked below).
let tvbGood = 0;
const TVB = { k: 400, c: 3e6, fuelCells: 10, claddingCells: 4, dt: 0.05, endT: 40 };
function tvbCase(name, title, q, history, start) {
  const doc = load("examples/synthetic-pulse.json");
  doc.caseId = name;
  doc.name = title;
  doc.boundary = { bulkTemperature: { ...history[0].bulkTemperature }, heatTransferCoefficient: { ...history[0].heatTransferCoefficient } };
  doc.gap.conductance = { value: 1e6, unit: "W/m2/K" };
  doc.mesh = { fuelCells: TVB.fuelCells, claddingCells: TVB.claddingCells };
  for (const m of ["fuel", "cladding"]) {
    doc.materials[m].sets["thermal.conductivity"].value = { value: TVB.k, unit: "W/m/K" };
    doc.materials[m].sets["thermal.volumetricHeatCapacity"].value = { value: TVB.c / 1e6, unit: "MJ/m3/K" };
  }
  doc.transient = { powerHistory: [{ time: { value: 0, unit: "s" }, linearHeatRate: { value: q, unit: "W/m" } }, { time: { value: TVB.endT, unit: "s" }, linearHeatRate: { value: q, unit: "W/m" } }], endTime: { value: TVB.endT, unit: "s" }, timeStep: { value: TVB.dt, unit: "s" }, outputs: 40, ...start, boundaryHistory: history };
  return doc;
}
function tvbLumped(doc, T0) {
  const R = (x) => si(x);
  const Rf = R(doc.geometry.fuelRadius), Rci = R(doc.geometry.claddingInnerRadius), Rco = R(doc.geometry.claddingOuterRadius);
  const C = TVB.c * (Math.PI * Rf * Rf + Math.PI * (Rco * Rco - Rci * Rci));
  const A = 2 * Math.PI * Rco;
  const q = si(doc.transient.powerHistory[0].linearHeatRate);
  const H = doc.transient.boundaryHistory.map((p) => ({ t: p.time.value, Tb: si(p.bulkTemperature), h: si(p.heatTransferCoefficient) }));
  const at = (t, key) => {
    if (t <= H[0].t) return H[0][key];
    for (let i = 1; i < H.length; i++) if (t <= H[i].t) return H[i - 1][key] + ((H[i][key] - H[i - 1][key]) * (t - H[i - 1].t)) / (H[i].t - H[i - 1].t);
    return H[H.length - 1][key];
  };
  const f = (t, T) => (q - at(t, "h") * A * (T - at(t, "Tb"))) / C;
  let T = T0, t = 0, Tmax = T0;
  const dt = 1e-3;
  while (t < TVB.endT - 1e-9) {
    const k1 = f(t, T), k2 = f(t + dt / 2, T + (dt / 2) * k1), k3 = f(t + dt / 2, T + (dt / 2) * k2), k4 = f(t + dt, T + dt * k3);
    T += (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    t += dt;
    Tmax = Math.max(Tmax, T);
  }
  if (Math.abs(Tmax - T) > 1e-9) throw new Error(doc.caseId + ": the lumped temperature is not monotone, the largest peak is not the final value");
  return { T, C, A, q, H0: H[0] };
}
const tvbPt = (t, Tb, h) => ({ time: { value: t, unit: "s" }, bulkTemperature: { value: Tb, unit: "K" }, heatTransferCoefficient: { value: h, unit: "W/m2/K" } });
const TVB_CASES = [
  {
    name: "synthetic-lumped-film-step",
    title: "Synthetic pin, 300 W/m, the film coefficient falls from 500 to 100 W/m2/K at 10 s (illustrative numbers)",
    q: 300,
    history: [tvbPt(0, 600, 500), tvbPt(10, 600, 500), tvbPt(10.05, 600, 100), tvbPt(40, 600, 100)],
    start: { initialTemperature: { value: 600, unit: "K" } },
    T0: () => 600,
    domain: "synthetic pin with a conductivity of 400 W/m/K and a heat capacity of 3 MJ/m3/K (Biot about 0.001), 300 W/m from a uniform 600 K start, coolant at 600 K, film coefficient 500 W/m2/K falling to 100 between 10 and 10.05 s",
    text: "A lumped body: C dT/dt = q' - h(t) A (T - T_b), integrated by RK4 through the film history as written (h linear between its points, the 0.05 s fall included).",
  },
  {
    name: "synthetic-lumped-bulk-ramp",
    title: "Synthetic pin, no power, the coolant warms from 600 to 900 K over 40 s (illustrative numbers)",
    q: 0,
    history: [tvbPt(0, 600, 500), tvbPt(40, 900, 500)],
    start: { initialTemperature: { value: 600, unit: "K" } },
    T0: () => 600,
    domain: "synthetic pin with a conductivity of 400 W/m/K and a heat capacity of 3 MJ/m3/K (Biot about 0.005), no power, uniform 600 K start, film coefficient 500 W/m2/K, coolant ramping linearly from 600 to 900 K over 40 s",
    text: "A lumped body following a ramp in the coolant temperature: C dT/dt = -h A (T - T_b(t)) with T_b linear; the answer lags the ramp by the time constant C / (h A) times its slope, and RK4 reproduces it.",
  },
  {
    name: "synthetic-lumped-coastdown",
    title: "Synthetic pin, 1 kW/m from its steady state, the film coefficient decays from 3000 to 300 W/m2/K between 5 and 15 s (illustrative numbers)",
    q: 1000,
    history: [tvbPt(0, 600, 3000), tvbPt(5, 600, 3000), tvbPt(15, 600, 300), tvbPt(40, 600, 300)],
    start: { initialSteadyLinearHeatRate: { value: 1, unit: "kW/m" } },
    T0: (L) => L.H0.Tb + L.q / (L.H0.h * L.A),
    domain: "synthetic pin with a conductivity of 400 W/m/K and a heat capacity of 3 MJ/m3/K (Biot about 0.01), 1 kW/m started from its own steady state at a film coefficient of 3000 W/m2/K, coolant 600 K, the film coefficient decaying linearly to 300 between 5 and 15 s",
    text: "A lumped body started at its steady state T_b + q'/(h A) and then cooled less and less well: the same ODE through a film history that falls in a straight line over ten seconds.",
  },
];
for (const c of TVB_CASES) {
  const doc = tvbCase(c.name, c.title, c.q, c.history, c.start);
  const probe = tvbLumped(doc, 600);
  const T0 = c.T0(probe);
  const L = tvbLumped(doc, T0);
  const rise = L.T - T0;
  if (!(Math.abs(rise) > 20)) throw new Error(c.name + ": the rise is too small to test anything: " + rise);
  const rel = writeCase(c.name, doc);
  const tol = Number((0.01 * Math.abs(rise)).toFixed(2));
  entry({
    id: "feed-" + c.name + "-temperature-peak-max",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_peak_max", value: round(L.T, 4), unit: "K" },
    tolerance: { abs: tol, rel: 0 },
    source: { kind: "analytic", text: c.text + " Heat capacity per metre " + round(L.C, 3) + " J/m/K, outer surface " + round(L.A * 1e3, 4) + " mm2/mm. The pin warms monotonically, so the largest peak is the value at 40 s: " + round(L.T, 4) + " K from " + round(T0, 4) + " K. The tolerance is 1 % of the rise, fixed before any run (first-order step error 0.4 % at most, the lumped approximation, the 0.05 s the solver applies the new film value late).", check: "Second method: FEED's independent finite-volume solution of the full pin with the history (src/core/transientFv.ts, tests/transientFvBoundary.test.ts, exact lumped solutions) and the real solver through tests/seedOracleBoundaryHistory.test.ts; the history is written to OFFBEAT as timeDependentAxialProfileHTC and judged by FEED's own cross-check in docs/boundary-history.md." },
    coverage: { quantities: ["temperature_peak_max"], domain: c.domain },
  });
  tvbGood++;
  if (c.name === "synthetic-lumped-film-step") {
    entry({
      id: "feed-" + c.name + "-energy-deposited",
      tag: "good",
      casePath: rel,
      expected: { quantity: "energy_deposited", value: round(c.q * TVB.endT, 3), unit: "J/m" },
      tolerance: { abs: 0, rel: 1e-6 },
      source: { kind: "analytic", text: "The constant heat rate over the run: q' x t = 300 W/m x 40 s. A boundary history must not change the power bookkeeping.", check: "Trivial product; oracles/transient-case-reference.py integrates the tabulated history to the same number." },
      coverage: { quantities: ["energy_deposited"], domain: c.domain },
    });
    tvbGood++;
  }
}

// the refusals of the history: FEED's vectors, each with the code the validator gives first
const TVB_BAD = [
  { file: "boundary-history-unordered", code: "E_TIME", what: "history times that do not increase strictly" },
  { file: "boundary-history-zero-h", code: "E_OUT_OF_RANGE", what: "a film coefficient of zero in the history (an adiabatic wall is not accepted; the least is 0.001 W/m2/K)" },
  { file: "boundary-history-form-differs-from-case", code: "E_BOUNDARY_INCOMPLETE", what: "a history in the surface-temperature form for a case whose boundary is convective" },
  { file: "boundary-history-steady-start-differs", code: "E_TRANSIENT_INCOMPLETE", what: "a run that starts from the steady state of its boundary whose history begins at a different boundary, so the start would not be steady" },
  { file: "boundary-history-stops-short", code: "E_TIME", what: "a history that ends before the end time of the run" },
];
let tvbBad = 0;
for (const b of TVB_BAD) {
  const rel = writeCase("bad-" + b.file, load("schema/vectors/bad/" + b.file + ".json"));
  entry({
    id: "feed-bad-" + b.file,
    tag: "bad-input",
    casePath: rel,
    expected: { refusalCode: b.code },
    source: { kind: "hand", text: "A case with one fault: " + b.what + ". FEED must refuse it before any run; SEED reports " + b.code + ".", check: "FEED's schema vectors (schema/vectors/bad/" + b.file + ".json) assert the same code in FEED's own test suite." },
    coverage: { quantities: ["case-validation"], domain: "FEED case validation" },
  });
  tvbBad++;
}

// ---- an axial stack and a plate (plan 12 A8). Closed forms written here with plain formulas, nothing from src/core and no solver output. A stack is N slices along the heated length;
// each slice is the radial problem (a pin) or the through-thickness problem (a plate) of its own heat rate and its own coolant, so the expected value of a slice is the series (pin)
// or slab (plate) solution of that slice. The solver's slices exchange a little heat along the height (docs/axial-stack.md), which the per-slice closed form does not contain, so
// the tolerance of a stack entry is the SUM of three terms, each fixed here before any run and each stated in the entry:
//   (1) the mesh bound of every steady entry: 5 x (the slice's centre-to-surface rise) / N^2, N = 100 fuel cells;
//   (2) the axial conduction allowance of FEED's checks: 3 x (the estimate as a fraction of the largest rise) x (the largest rise of any slice above its coolant). The estimate is
//       a fin model: lambda^2 = (k A of the two solids) / U, U the hottest slice's heat rate over its centre-to-coolant rise, times the largest second difference of the shape over
//       the interior slices relative to its largest value (docs/axial-stack.md, "The axial conduction"); the factor 3 is the margin the A1 and A2 calibration gave it;
//   (3) the representation of a cosine: the writer gives OFFBEAT a table of 41 points and FEED normalises it by the trapezoid rule, which differs from the exact cosine by at most
//       1e-3 of a slice's heat rate (interpolation error (1/40)^2 pi^2 / 8 = 7.7e-4, normalisation (1/40)^2 pi^2 / 12 = 5.1e-4, opposite signs), that is 1e-3 of the slice's rise
//       above its coolant. A table shape has no such term: its definition is the table.
// The sum is rounded up to 0.05 K. The expected values use the exact cosine and the exact table, never FEED's writer.
// Three quantities are new to SEED (docs/seed-stack-request.md): `axial_hottest_slice` (the index of the slice with the hottest fuel, 0 at the bottom, unit 1), and
// `temperature_peak_slice_min` (the lowest of the slices' hottest cell, K), which is a scalar summary of the new series quantity `temperature_peak_by_slice`; the oracle format
// holds one number, so the series itself cannot be pinned, only these.
const AX = { factor: 3, cosineTable: 1e-3, exchangeFactor: 2 };
const ceil005 = (x) => Number(Math.max(0.05, Math.ceil(x / 0.05 - 1e-9) * 0.05).toFixed(2));
const qty = (v, u) => ({ value: v, unit: u });
const cosineFactors = (N) => Array.from({ length: N }, (_, k) => (Math.PI / 2) * Math.cos(Math.PI * ((k + 0.5) / N - 0.5)));
/** Factors of a table shape [[fraction of the length, relative power], ...] at the slice centres, normalised to an average of 1 over the length (the trapezoid integral is exact for a piecewise linear shape). */
function tableFactors(points, N) {
  let integral = 0;
  for (let i = 1; i < points.length; i++) integral += 0.5 * (points[i][1] + points[i - 1][1]) * (points[i][0] - points[i - 1][0]);
  const at = (x) => {
    for (let i = 1; i < points.length; i++) if (x <= points[i][0]) return points[i - 1][1] + ((points[i][1] - points[i - 1][1]) * (x - points[i - 1][0])) / (points[i][0] - points[i - 1][0]);
    return points[points.length - 1][1];
  };
  return Array.from({ length: N }, (_, k) => at((k + 0.5) / N) / integral);
}
const linear = (xs, ys, x) => {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1]);
  return ys[ys.length - 1];
};

/** Through-thickness solution of a plate per metre of height and width: film q/h, cladding q t / k, gap q / h_gap, meat q L / (2 k) from the insulated plane to its face (plain slab results). */
function slabSeries(doc) {
  const q = si(doc.power.linearHeatRate);
  const L = si(doc.geometry.fuelHalfThickness);
  const t = si(doc.geometry.claddingThickness);
  const fk = conductivity(doc.materials.fuel.sets, doc);
  const ck = conductivity(doc.materials.cladding.sets, doc);
  const wall = doc.boundary.surfaceTemperature ? si(doc.boundary.surfaceTemperature) : si(doc.boundary.bulkTemperature) + q / si(doc.boundary.heatTransferCoefficient);
  const cladInner = hotSideK(ck, wall, q * t);
  const fuelSurface = cladInner + q / si(doc.gap.conductance);
  const centre = hotSideK(fk, fuelSurface, (q * L) / 2);
  return { q, wall, cladInner, fuelSurface, centre, fuelRise: centre - fuelSurface };
}
const isPlate = (doc) => doc.geometry.kind === "plate";
const constantK = (set) => {
  const k = conductivity(set, {});
  if (!("a" in k) || k.b !== 0) throw new Error("the stack generator's axial estimate is for constant conductivities");
  return k.a;
};

/** The slices of a steady stack: each with its factor, heat rate, coolant and closed-form temperatures. */
function stackSteady(doc) {
  const a = doc.axial;
  const N = a.slices;
  const L = si(a.length);
  const avg = si(doc.power.linearHeatRate);
  const factors = a.powerShape.kind === "cosine" ? cosineFactors(N) : tableFactors(a.powerShape.points.map((p) => [si(p.position) / L, p.relativePower.value]), N);
  const b = a.boundary;
  const slices = factors.map((f, k) => {
    const z = ((k + 0.5) * L) / N;
    const sdoc = JSON.parse(JSON.stringify(doc));
    delete sdoc.axial;
    sdoc.power.linearHeatRate = qty(avg * f, "W/m");
    let Tb = si(doc.boundary.bulkTemperature);
    let h = si(doc.boundary.heatTransferCoefficient);
    if (b) {
      const zs = b.map((p) => si(p.height));
      Tb = linear(zs, b.map((p) => si(p.bulkTemperature)), z);
      h = linear(zs, b.map((p) => si(p.heatTransferCoefficient)), z);
      sdoc.boundary = { bulkTemperature: qty(Tb, "K"), heatTransferCoefficient: qty(h, "W/m2/K") };
    }
    const s = isPlate(doc) ? slabSeries(sdoc) : analytic(sdoc);
    return { k, z, factor: f, q: avg * f, Tb, h, centre: s.centre, fuelRise: s.fuelRise, wall: s.wall, rise: s.centre - Tb };
  });
  return { N, L, avg, slices };
}
/** The cross-sections the heat flows along the height through, per metre of width for a plate: the meat and the cladding. */
function crossSections(doc) {
  if (isPlate(doc)) return { Af: si(doc.geometry.fuelHalfThickness), Ac: si(doc.geometry.claddingThickness) };
  const Rf = si(doc.geometry.fuelRadius), Rci = si(doc.geometry.claddingInnerRadius), Rco = si(doc.geometry.claddingOuterRadius);
  return { Af: Math.PI * Rf * Rf, Ac: Math.PI * (Rco * Rco - Rci * Rci) };
}
/** The fin-model estimate of docs/axial-stack.md, in plain arithmetic: lambda^2 x the largest interior second difference of the shape relative to its largest value. */
function axialEstimateOf(doc, st) {
  const hot = st.slices.reduce((m, s) => (s.centre > m.centre ? s : m));
  const { Af, Ac } = crossSections(doc);
  const kA = constantK(doc.materials.fuel.sets) * Af + constantK(doc.materials.cladding.sets) * Ac;
  const U = hot.q / hot.rise;
  const lambda2 = kA / U;
  const v = st.slices.map((s) => s.factor);
  const top = Math.max(...v);
  const h = st.L / st.N;
  let curvature = 0;
  for (let i = 1; i < v.length - 1; i++) curvature = Math.max(curvature, Math.abs(v[i + 1] - 2 * v[i] + v[i - 1]) / (h * h) / top);
  return { lambda2, curvature, fraction: lambda2 * curvature, hot };
}
/** The tolerance of one slice's hottest cell: the three terms above, rounded up to 0.05 K. */
function stackTolerance(est, st, s, cosine) {
  const peakRise = Math.max(...st.slices.map((x) => x.rise));
  const mesh = (5 * s.fuelRise) / (MESH.fuelCells * MESH.fuelCells);
  const allow = AX.factor * est.fraction * peakRise;
  const table = cosine ? AX.cosineTable * s.rise : 0;
  return { total: ceil005(mesh + allow + table), mesh, allow, table };
}

function stackCase(o) {
  const doc = load(o.from);
  doc.caseId = o.name;
  doc.name = o.title;
  delete doc.description;
  if (o.plate) {
    doc.assumptions.geometry = "1D-slab";
    doc.geometry = { kind: "plate", fuelHalfThickness: qty(4.1, "mm"), gapThickness: qty(0.08, "mm"), claddingThickness: qty(0.57, "mm") };
  }
  doc.power.linearHeatRate = qty(o.avgKW, "kW/m");
  doc.axial = { length: qty(o.length, "m"), slices: o.slices, powerShape: o.shape };
  if (o.coolant) doc.axial.boundary = o.coolant.map(([z, Tb, h]) => ({ height: qty(z, "m"), bulkTemperature: qty(Tb, "K"), heatTransferCoefficient: qty(h, "W/m2/K") }));
  return withMesh(doc);
}

let stackGood = 0;
const STACKS = [
  {
    name: "stack-cosine-pin",
    from: "examples/synthetic-pin.json",
    title: "Synthetic pin stack, cosine power over 0.381 m in 9 slices, 20 kW/m on average, flat coolant (illustrative numbers)",
    avgKW: 20, length: 0.381, slices: 9, shape: { kind: "cosine" },
    domain: "synthetic pin (constant conductivities, convective boundary 573 K and 30000 W/m2/K on every slice) as 9 radial slices over 0.381 m with a cosine power shape, 20 kW/m on average (31.4 kW/m at the peak)",
    shapeText: "a cosine, normalised to an average of 1 (the slice at the middle has (pi/2) cos(0) = 1.571 of the average)",
  },
  {
    name: "stack-warming-coolant-pin",
    from: "examples/synthetic-pin.json",
    title: "Synthetic pin stack, cosine power in 9 slices, 5 kW/m on average, the coolant warms from 573 K to 873 K up the pin (illustrative numbers)",
    avgKW: 5, length: 0.381, slices: 9, shape: { kind: "cosine" },
    coolant: [[0, 573, 30000], [0.381, 873, 30000]],
    domain: "synthetic pin as 9 radial slices over 0.381 m with a cosine power shape, 5 kW/m on average (7.9 kW/m at the peak), a coolant table that warms linearly from 573 K at the bottom to 873 K at the top (a sodium-like rise; film coefficient 30000 W/m2/K)",
    shapeText: "a cosine, normalised to an average of 1, with the coolant read from the table at each slice's centre (linear between the two points)",
  },
  {
    name: "stack-skewed-pin",
    from: "examples/synthetic-pin.json",
    title: "Synthetic pin stack, a power shape skewed towards the bottom, 10 slices, 20 kW/m on average, flat coolant (illustrative numbers)",
    avgKW: 20, length: 0.381, slices: 10,
    shape: { kind: "table", points: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((x) => ({ position: qty(Number((x * 0.381).toFixed(4)), "m"), relativePower: qty(Number((0.35 + 0.65 * Math.sin(Math.PI * x ** 0.62)).toFixed(4)), "1") })) },
    domain: "synthetic pin as 10 radial slices over 0.381 m with a table power shape that peaks near 0.33 of the height and falls to 0.35 of the peak at both ends (0.35 + 0.65 sin(pi x^0.62) at eleven points, linear between them), 20 kW/m on average, flat coolant",
    shapeText: "the table as written (relative power at eleven heights, linear between them), normalised so that its integral over the length is 1, read at each slice's centre; the shape is not symmetric, so a stack read from the top gives a different answer",
  },
  {
    name: "stack-cosine-plate",
    from: "schema/vectors/good/plate-steady.json",
    plate: true,
    title: "Synthetic plate stack, cosine power over 0.381 m in 9 slices, 200 kW/m of height and width on average, flat coolant (illustrative numbers)",
    avgKW: 200, length: 0.381, slices: 9, shape: { kind: "cosine" },
    domain: "synthetic plate (meat half-thickness 4.1 mm, gap 0.08 mm, cladding 0.57 mm, constant conductivities, one face cooled at 573 K and 30000 W/m2/K) as 9 through-thickness slices over 0.381 m with a cosine power shape, 200 kW per metre of height and width on average",
    shapeText: "a cosine, normalised to an average of 1 (the heat rate is per metre of height and per metre of width)",
  },
];
for (const c of STACKS) {
  const doc = stackCase(c);
  const st = stackSteady(doc);
  const est = axialEstimateOf(doc, st);
  const cosine = c.shape.kind === "cosine";
  const hotI = st.slices.findIndex((s) => s === est.hot);
  const coldI = st.slices.reduce((m, s, i) => (s.centre < st.slices[m].centre ? i : m), 0);
  const tolHot = stackTolerance(est, st, st.slices[hotI], cosine);
  const tolCold = stackTolerance(est, st, st.slices[coldI], cosine);
  const sorted = st.slices.map((s) => s.centre).sort((x, y) => y - x);
  const gap = sorted[0] - sorted[1];
  const tolMax = Math.max(...st.slices.map((s) => stackTolerance(est, st, s, cosine).total));
  if (process.env.GEN_DEBUG) console.log(c.name, "hot", hotI, st.slices[hotI].centre.toFixed(3), "cold", coldI, st.slices[coldI].centre.toFixed(3), "gap", gap.toFixed(2), "tol", tolHot, tolCold, "frac", est.fraction.toFixed(5), tolHot.mesh.toFixed(3), tolHot.allow.toFixed(3), tolHot.table.toFixed(3));
  if (!(gap > 2 * tolMax)) throw new Error(c.name + ": the hottest slice leads the next by " + gap + " K, not more than twice the largest tolerance " + tolMax + ": its index would not be a safe answer");
  if (!(est.fraction < 0.02)) throw new Error(c.name + ": the axial conduction estimate is above the validator's 2 % warning");
  const rel = writeCase(c.name, doc);
  const heightOf = (i) => round(st.slices[i].z, 4);
  const common = (which, t) =>
    "Slice " + which + " of " + st.N + " (centre at " + heightOf(which) + " m, heat rate " + round(st.slices[which].q / 1e3, 3) + " kW/m, coolant " + round(st.slices[which].Tb, 2) + " K): the closed-form " + (isPlate(doc) ? "slab" : "series") +
    " solution of that slice gives " + round(st.slices[which].centre, 4) + " K at the centre. The power shape is " + c.shapeText + ". The solver's slices exchange a little heat along the height, which this solution does not have, so the tolerance is the sum of: the mesh bound 5 x " + round(st.slices[which].fuelRise, 2) + " K / 100^2 = " +
    round(t.mesh, 3) + " K; the axial conduction allowance 3 x " + round(est.fraction, 5) + " (the estimate as a fraction of the largest rise) x " + round(Math.max(...st.slices.map((x) => x.rise)), 1) + " K (the largest rise of any slice above its coolant) = " + round(t.allow, 3) + " K" +
    (cosine ? "; the cosine's 41-point table, 1e-3 of the slice's rise of " + round(st.slices[which].rise, 1) + " K = " + round(t.table, 3) + " K" : "; no table term (the shape is the table)") + "; rounded up to 0.05 K (" + t.total + " K), fixed before any run.";
  const check = "Second method: FEED's own per-slice closed form (src/core/closedForm.ts through axialSummary, tests/seedOracleStack.test.ts, to 1e-3 K apart from the cosine's table term), and the real solver (FEED_SOLVER=1): every check of the run passes and the solver's slice peaks are inside the tolerances.";
  const add = (quantity, value, unit, tolerance, text, qs) => {
    entry({ id: "feed-" + c.name + "-" + quantity.replace(/_/g, "-"), tag: "good", casePath: rel, expected: { quantity, value, unit }, tolerance, source: { kind: "analytic", text, check }, coverage: { quantities: [quantity], domain: c.domain } });
    stackGood++;
  };
  add("temperature_peak", round(st.slices[hotI].centre, 4), "K", { abs: tolHot.total, rel: 0 }, "The hottest fuel of the stack, the hottest slice's. " + common(hotI, tolHot));
  add("axial_hottest_slice", hotI, "1", { abs: 0, rel: 0 }, "The index of the slice with the hottest fuel, counted from 0 at the bottom (its centre is at " + heightOf(hotI) + " m of " + st.L + " m). The next slice is cooler by " + round(gap, 2) + " K, more than twice the largest tolerance of any slice (" + tolMax + " K), so the solver's own choice cannot differ. An integer: no tolerance.");
  add("temperature_peak_slice_min", round(st.slices[coldI].centre, 4), "K", { abs: tolCold.total, rel: 0 }, "The lowest of the slices' hottest cells: the end slice (index " + coldI + "), which makes the least heat. " + common(coldI, tolCold));
  // the fuel temperature by slice, the return quantity of SEED's power-temperature loop (src/core/fuelTemperature.ts): the volume mean of each slice's fuel, in plain arithmetic. For a solid pin
  // T = Ts + rise (1 - r^2/R^2), whose mean over the cross-section is Ts + rise/2; for a plate T = Ts + rise (1 - x^2/L^2) through the half-thickness, whose mean is Ts + 2 rise/3. Ts is the slice's
  // closed-form fuel surface (the centre minus the rise). The three scalar quantities are the series' largest and smallest value and its length-weighted mean (every slice has the same length).
  const meanOf = (x) => (isPlate(doc) ? x.centre - x.fuelRise / 3 : x.centre - x.fuelRise / 2);
  const means = st.slices.map(meanOf);
  const meanText = "the volume-mean fuel temperature of a slice, " + (isPlate(doc) ? "the surface temperature plus 2/3 of the centre-to-surface rise (the slab's parabola)" : "the surface temperature plus 1/2 of the centre-to-surface rise (the solid cylinder's parabola)") + ", from the closed-form solution of each slice at its own heat rate and coolant. The power shape is " + c.shapeText + ". The tolerance is the sum of the three terms of the peak entries of this case, each fixed before any run (the mesh term 5 x rise / 100^2 is for a cell-centre value; a volume mean of the cells is less sensitive to the mesh, so it is conservative here), taken at its largest over the slices: " + tolMax + " K (including the axial conduction allowance of 3 x " + round(est.fraction, 5) + " x " + round(Math.max(...st.slices.map((x) => x.rise)), 1) + " K" + (cosine ? " and the cosine's 41-point table" : "") + "), rounded up to 0.05 K.";
  const meanCheck = "Second method: FEED's closed form of each slice integrated over the fuel cross-section (Simpson, tests/seedFuelTemperature.test.ts), the same means worked by hand in tests/seedOracleStack.test.ts, and the real solver (FEED_SOLVER=1): the solver's cell-weighted means are inside the tolerance.";
  const addMean = (quantity, value, text) => {
    entry({ id: "feed-" + c.name + "-" + quantity.replace(/_/g, "-"), tag: "good", casePath: rel, expected: { quantity, value: round(value, 4), unit: "K" }, tolerance: { abs: tolMax, rel: 0 }, source: { kind: "analytic", text, check: meanCheck }, coverage: { quantities: [quantity], domain: c.domain } });
    stackGood++;
  };
  addMean("temperature_fuel_mean_slice_max", Math.max(...means), "The largest volume-mean fuel temperature of any slice: " + meanText);
  addMean("temperature_fuel_mean_slice_min", Math.min(...means), "The smallest volume-mean fuel temperature of any slice (an end slice): " + meanText);
  addMean("temperature_fuel_mean", means.reduce((x, y) => x + y, 0) / means.length, "The volume-mean fuel temperature of the whole heated fuel, the mean of the " + st.N + " slices' means (equal lengths, equal fuel cross-section): " + meanText);
}

// ---- the return quantity on the path the loop takes: ONE slice whose heat rate a heating transfer set (the case's provenance names the slice and its z bounds); the quantity then has one slice
{
  const doc = withMesh(load("examples/synthetic-pin.json"));
  doc.caseId = "fuel-mean-transferred-pin";
  doc.name = "Synthetic pin whose heat rate came from a heating transfer (one axial slice, 0.25 to 0.5 m of the source frame), 20 kW/m (illustrative numbers)";
  delete doc.description;
  doc.provenance = { transfers: [{ kind: "heating", recipeId: "oracle-recipe", pin: "p1", sliceId: "slice-2", z: { min: 0.25, max: 0.5 }, frame: "pin-axis z up, m, origin at bottom of fuel" }] };
  const sres = analytic(doc);
  const rel = writeCase("fuel-mean-transferred-pin", doc);
  const mean = sres.centre - sres.fuelRise / 2;
  const tol = peakTolerance(sres);
  entry({
    id: "feed-fuel-mean-transferred-pin-temperature-fuel-mean",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_fuel_mean", value: round(mean, 4), unit: "K" },
    tolerance: { abs: tol, rel: 0 },
    source: {
      kind: "analytic",
      text: "The volume-mean fuel temperature of the one slice the case holds (slice-2, 0.25 to 0.5 m of the source's frame, set by a heating transfer): the closed-form fuel surface " + round(sres.centre - sres.fuelRise, 4) + " K plus half of the centre-to-surface rise " + round(sres.fuelRise, 4) + " K (the solid cylinder's parabola) = " + round(mean, 4) + " K. The tolerance is the mesh bound of the peak entries, 5 x rise / 100^2 rounded up to 0.05 K (" + tol + " K), fixed before any run.",
      check: "Second method: FEED's closed form integrated over the fuel cross-section (tests/seedFuelTemperature.test.ts) and the real solver (FEED_SOLVER=1, tests/seedOracleStack.test.ts): the solver's cell-weighted mean is inside the tolerance.",
    },
    coverage: { quantities: ["temperature_fuel_mean"], domain: "the synthetic pin (constant conductivities, convective boundary 573 K and 30000 W/m2/K) as ONE radial slice whose position comes from the case's heating provenance; steady; mesh 100/20" },
  });
  stackGood++;
}

// ---- a plate alone: the through-thickness closed form (docs/plate.md); the pin entries of the set have the series
{
  const doc = withMesh(load("schema/vectors/good/plate-steady.json"));
  doc.caseId = "plate-steady";
  doc.name = "Synthetic plate, 20 kW per metre of height and width, one face cooled (illustrative numbers)";
  const s = slabSeries(doc);
  const rel = writeCase("plate-steady", doc);
  const check = "Second method: FEED's slab closed form (compositeSlab, tests/plate.test.ts worked by hand to 592.093 K) and the real solver through tests/seedOracleStack.test.ts (FEED_SOLVER=1).";
  const domain = "synthetic plate (meat half-thickness 4.1 mm, gap 0.08 mm and conductance 5000 W/m2/K, cladding 0.57 mm, constant conductivities 3 and 15 W/m/K), 20 kW per metre of height and width, one face cooled at 573 K and 30000 W/m2/K, the other plane insulated";
  const tol = peakTolerance(s);
  entry({ id: "feed-plate-steady-temperature-peak", tag: "good", casePath: rel, expected: { quantity: "temperature_peak", value: round(s.centre, 4), unit: "K" }, tolerance: { abs: tol, rel: 0 }, source: { kind: "analytic", text: "Closed-form centre temperature of the slab: film q/h = " + round(s.q / 30000, 3) + " K, cladding q t / k = " + round(s.q * 0.00057 / 15, 3) + " K, gap q / h_gap = " + round(s.q / 5000, 3) + " K, meat q L / (2 k) = " + round(s.fuelRise, 3) + " K above 573 K. The observed value is the first fuel cell centre (x = L / 200 from the insulated plane); the tolerance is 5 x " + round(s.fuelRise, 3) + " K / 100^2 rounded up.", check }, coverage: { quantities: ["temperature_peak"], domain } });
  entry({ id: "feed-plate-steady-temperature-surface", tag: "good", casePath: rel, expected: { quantity: "temperature_surface", value: round(s.wall, 4), unit: "K" }, tolerance: { abs: 0.2, rel: 0 }, source: { kind: "analytic", text: "Outer face of the cladding: the bulk temperature plus the film drop q/h = 20000 / 30000 W/m2/K (the heat rate is per metre of height and width, so the flux through the face is 20 kW/m2).", check }, coverage: { quantities: ["temperature_surface"], domain } });
  stackGood += 2;
}

// ---- a stack in a transient, only where the lumped limit is a reference that is not the solver (plan 11's lumped pins): a body of high conductivity (400 W/m/K, Biot number about 0.001)
// is one temperature, so each slice obeys C dT/dt = q_k - h(t) A (T - T_b), integrated here by RK4 (step 1 ms) through the film history as written, from the slice's own steady start.
// What the lumped slice leaves out is paid for in the tolerance, each term fixed here before any run:
//   (1) 1 % of the slice's rise (the policy of the boundary-history entries: the first-order error of the 0.05 s step and the lumped approximation);
//   (2) twice FEED's bound on the heat the slices exchange along the height (docs/axial-stack.md, "The heat the slices exchange during a transient"): the rate k A / (C h^2) times the
//       integral of the absolute second difference of the slices' temperatures (here the lumped ones), the factor 2 being the margin the A5 measurements gave it; counted only where the
//       exchange number (the rate times the run time) is at most 1, and checked below;
//   (3) the hottest cell is above the mean the lumped model follows by at most the steady internal rise at the peak slice's heat rate (conduction in the meat, the gap and the cladding).
const STACK_T = { k: 400, c: 3e6, fuelCells: 10, claddingCells: 4, dt: 0.05, endT: 40 };
const histPt = (t, Tb, h) => ({ time: qty(t, "s"), bulkTemperature: qty(Tb, "K"), heatTransferCoefficient: qty(h, "W/m2/K") });
function lumpedStack(doc) {
  const plate = isPlate(doc);
  const a = doc.axial;
  const N = a.slices;
  const L = si(a.length);
  const avg = si(doc.transient.initialSteadyLinearHeatRate);
  const factors = cosineFactors(N);
  const H = doc.transient.boundaryHistory.map((p) => ({ t: p.time.value, Tb: si(p.bulkTemperature), h: si(p.heatTransferCoefficient) }));
  const at = (t, key) => {
    if (t <= H[0].t) return H[0][key];
    for (let i = 1; i < H.length; i++) if (t <= H[i].t) return H[i - 1][key] + ((H[i][key] - H[i - 1][key]) * (t - H[i - 1].t)) / (H[i].t - H[i - 1].t);
    return H[H.length - 1][key];
  };
  let C, A;
  if (plate) {
    C = STACK_T.c * (si(doc.geometry.fuelHalfThickness) + si(doc.geometry.claddingThickness));
    A = 1;
  } else {
    const Rf = si(doc.geometry.fuelRadius), Rci = si(doc.geometry.claddingInnerRadius), Rco = si(doc.geometry.claddingOuterRadius);
    C = STACK_T.c * (Math.PI * Rf * Rf + Math.PI * (Rco * Rco - Rci * Rci));
    A = 2 * Math.PI * Rco;
  }
  const dt = 1e-3;
  const every = 50;
  const traj = factors.map((f) => {
    const q = avg * f;
    let T = H[0].Tb + q / (H[0].h * A);
    const T0 = T;
    const fn = (t, x) => (q - at(t, "h") * A * (x - at(t, "Tb"))) / C;
    const samples = [T];
    let t = 0;
    let Tmax = T;
    for (let step = 1; t < STACK_T.endT - 1e-9; step++) {
      const k1 = fn(t, T), k2 = fn(t + dt / 2, T + (dt / 2) * k1), k3 = fn(t + dt / 2, T + (dt / 2) * k2), k4 = fn(t + dt, T + dt * k3);
      T += (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      t += dt;
      if (T < Tmax - 1e-9) throw new Error(doc.caseId + ": a slice cools, so the largest peak is not the value at the end");
      Tmax = Math.max(Tmax, T);
      if (step % every === 0) samples.push(T);
    }
    return { q, T0, T, samples };
  });
  // the exchange bound of each slice: rate x the integral (trapezoid on the samples, 0.05 s apart) of the absolute second difference to the neighbours (an end slice has one neighbour)
  const kA = constantK(doc.materials.fuel.sets) * crossSections(doc).Af + constantK(doc.materials.cladding.sets) * crossSections(doc).Ac;
  const rate = kA / (C * (L / N) ** 2);
  const bounds = traj.map((s, i) => {
    const lo = traj[i > 0 ? i - 1 : i], hi = traj[i < N - 1 ? i + 1 : i];
    const d = s.samples.map((_, j) => Math.abs(hi.samples[j] - 2 * s.samples[j] + lo.samples[j]));
    let integral = 0;
    for (let j = 1; j < d.length; j++) integral += 0.5 * (d[j] + d[j - 1]) * every * dt;
    return rate * integral;
  });
  return { traj, bounds, rate, C, A, N, L, avg };
}
const STACK_TRANSIENTS = [
  {
    name: "stack-lumped-plate-loss-of-cooling",
    base: "stack-cosine-plate",
    plate: true,
    title: "Synthetic plate stack, 50 kW/m on average from its steady states, the film coefficient falls from 3000 to 100 W/m2/K between 2 and 3 s (illustrative numbers)",
    avgKW: 50,
    domain: "synthetic plate with a conductivity of 400 W/m/K and a heat capacity of 3 MJ/m3/K (Biot number about 0.001) as 10 slices over 2 m with a cosine power shape, 50 kW per metre of height and width on average, each slice started from its own steady state at a film coefficient of 3000 W/m2/K, coolant 600 K, the film coefficient falling to 100 W/m2/K between 2 and 3 s (the loss of cooling of finding F17), 40 s",
    text: "A lumped plate per slice, started at its steady state T_b + q_k/h and then cooled less and less well.",
  },
  {
    name: "stack-lumped-pin-coastdown",
    base: "stack-cosine-pin",
    plate: false,
    title: "Synthetic pin stack, 1 kW/m on average from its steady states, the film coefficient decays from 3000 to 300 W/m2/K between 5 and 15 s (illustrative numbers)",
    avgKW: 1,
    domain: "synthetic pin with a conductivity of 400 W/m/K and a heat capacity of 3 MJ/m3/K (Biot number about 0.01) as 10 slices over 2 m with a cosine power shape, 1 kW/m on average, each slice started from its own steady state at a film coefficient of 3000 W/m2/K, coolant 600 K, the film coefficient decaying linearly to 300 W/m2/K between 5 and 15 s, 40 s",
    text: "A lumped pin per slice, started at its steady state T_b + q_k/(h A) and then cooled less and less well.",
    history: [histPt(0, 600, 3000), histPt(5, 600, 3000), histPt(15, 600, 300), histPt(40, 600, 300)],
  },
];
for (const c of STACK_TRANSIENTS) {
  const history = c.history || [histPt(0, 600, 3000), histPt(2, 600, 3000), histPt(3, 600, 100), histPt(40, 600, 100)];
  const doc = load(c.plate ? "schema/vectors/good/plate-steady.json" : "examples/synthetic-pulse.json");
  doc.caseId = c.name;
  doc.name = c.title;
  delete doc.description;
  doc.assumptions = { thermalOnly: true, steadyState: false, geometry: c.plate ? "1D-slab" : "1D-radial" };
  if (c.plate) doc.geometry = { kind: "plate", fuelHalfThickness: qty(4.1, "mm"), gapThickness: qty(0.08, "mm"), claddingThickness: qty(0.57, "mm") };
  delete doc.power;
  doc.boundary = { bulkTemperature: { ...history[0].bulkTemperature }, heatTransferCoefficient: { ...history[0].heatTransferCoefficient } };
  doc.gap = { model: "constant-conductance", conductance: qty(1e6, "W/m2/K"), source: "synthetic: chosen for the closed-form oracle" };
  doc.mesh = { fuelCells: STACK_T.fuelCells, claddingCells: STACK_T.claddingCells };
  const pulse = load("examples/synthetic-pulse.json");
  doc.materials = pulse.materials;
  for (const m of ["fuel", "cladding"]) {
    doc.materials[m].sets["thermal.conductivity"].value = qty(STACK_T.k, "W/m/K");
    doc.materials[m].sets["thermal.volumetricHeatCapacity"].value = qty(STACK_T.c / 1e6, "MJ/m3/K");
  }
  doc.axial = { length: qty(2, "m"), slices: 10, powerShape: { kind: "cosine" } };
  doc.transient = { powerHistory: [{ time: qty(0, "s"), linearHeatRate: qty(c.avgKW, "kW/m") }, { time: qty(STACK_T.endT, "s"), linearHeatRate: qty(c.avgKW, "kW/m") }], endTime: qty(STACK_T.endT, "s"), timeStep: qty(STACK_T.dt, "s"), outputs: 40, initialSteadyLinearHeatRate: qty(c.avgKW, "kW/m"), boundaryHistory: history };
  const lump = lumpedStack(doc);
  const hotI = lump.traj.reduce((m, s, i) => (s.T > lump.traj[m].T ? i : m), 0);
  const hot = lump.traj[hotI];
  const rise = hot.T - hot.T0;
  const exchangeNumber = lump.rate * STACK_T.endT;
  if (!(exchangeNumber <= 1)) throw new Error(c.name + ": the exchange number " + exchangeNumber + " is above 1; FEED does not count its bound there");
  if (!(rise > 20)) throw new Error(c.name + ": the rise is too small to test anything: " + rise);
  const qPeak = hot.q;
  const internal = c.plate
    ? qPeak * (si(doc.geometry.fuelHalfThickness) / (2 * STACK_T.k) + 1 / 1e6 + si(doc.geometry.claddingThickness) / STACK_T.k)
    : qPeak * (1 / (4 * Math.PI * STACK_T.k) + 1 / (2 * Math.PI * si(doc.geometry.fuelRadius) * 1e6) + Math.log(si(doc.geometry.claddingOuterRadius) / si(doc.geometry.claddingInnerRadius)) / (2 * Math.PI * STACK_T.k));
  const t1 = 0.01 * rise;
  const t2 = AX.exchangeFactor * lump.bounds[hotI];
  const tol = ceil005(t1 + t2 + internal);
  if (process.env.GEN_DEBUG) console.log(c.name, "hot", hotI, hot.T.toFixed(3), "from", hot.T0.toFixed(3), "rise", rise.toFixed(2), "rate", lump.rate, "exchange number", exchangeNumber.toFixed(3), "bound", lump.bounds[hotI].toFixed(3), "terms", t1.toFixed(3), t2.toFixed(3), internal.toFixed(3), "tol", tol);
  const rel = writeCase(c.name, doc);
  entry({
    id: "feed-" + c.name + "-temperature-peak-max",
    tag: "good",
    casePath: rel,
    expected: { quantity: "temperature_peak_max", value: round(hot.T, 4), unit: "K" },
    tolerance: { abs: tol, rel: 0 },
    source: {
      kind: "analytic",
      text: c.text + " Heat capacity per " + (c.plate ? "square metre" : "metre") + " " + round(lump.C, 3) + ", surface " + round(lump.A, 5) + ". Slice " + hotI + " of 10 (one of the two middle slices, equally hot, " + round(qPeak / 1e3, 3) + " kW/m) warms monotonically from " + round(hot.T0, 4) + " K to " + round(hot.T, 4) + " K at 40 s, which is the largest peak of the run. The tolerance " + tol +
      " K is the sum, rounded up to 0.05 K, of 1 % of the rise (" + round(t1, 3) + " K), twice the bound on the heat the slices exchange along the height (rate " + round(lump.rate, 6) + " /s, exchange number " + round(exchangeNumber, 3) + " over the run, bound " + round(lump.bounds[hotI], 3) + " K, twice " + round(t2, 3) + " K) and the internal rise of the hottest cell above the lumped mean (at most " + round(internal, 3) + " K); fixed before any run.",
      check: "Second method: FEED's independent finite-volume solution of every slice (tests/seedOracleStack.test.ts, the same bound added) and the real solver with FEED_SOLVER=1; FEED's own checks of the stack run (cross-check, energy balance, time step) all pass.",
    },
    coverage: { quantities: ["temperature_peak_max"], domain: c.domain },
  });
  stackGood++;
}

// the refusals: FEED's vectors, each with the code the validator gives first
const STACK_BAD = [
  { file: "axial-slices-too-few", code: "E_AXIAL", what: "a stack of fewer than 3 slices" },
  { file: "axial-shape-all-zero", code: "E_AXIAL", what: "a power shape that is zero everywhere" },
  { file: "axial-boundary-unordered", code: "E_AXIAL", what: "a coolant table whose heights do not increase strictly" },
  { file: "axial-with-mechanics", code: "E_UNSUPPORTED", what: "a stack together with the mechanics (stress and displacement are for one slice)" },
  { file: "axial-coolant-table-with-boundary-history", code: "E_UNSUPPORTED", what: "a coolant table along the height together with a boundary history (the coolant would depend on both)" },
  { file: "plate-with-a-hole", code: "E_GEOMETRY", what: "a plate with a central hole (a plate has none)" },
  { file: "plate-assumed-radial", code: "E_UNSUPPORTED", what: "a plate whose assumptions say the geometry is radial" },
  { file: "plate-thickness-wrong-unit", code: "E_UNITS", what: "a plate's half-thickness given in a unit that is not a length" },
];
let stackBad = 0;
for (const b of STACK_BAD) {
  const rel = writeCase("bad-" + b.file, load("schema/vectors/bad/" + b.file + ".json"));
  entry({
    id: "feed-bad-" + b.file,
    tag: "bad-input",
    casePath: rel,
    expected: { refusalCode: b.code },
    source: { kind: "hand", text: "A case with one fault: " + b.what + ". FEED must refuse it before any run; SEED reports " + b.code + ".", check: "FEED's schema vectors (schema/vectors/bad/" + b.file + ".json) assert the same code in FEED's own test suite." },
    coverage: { quantities: ["case-validation"], domain: "FEED case validation" },
  });
  stackBad++;
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
    (good + transientGood + kineticsGood + limitGood + gaGood + mechGood + tvbGood + stackGood) + " good entries (steady: peak, outer-wall temperature, flux and energy balance over eight pins, two of them with a cubic and a tabulated fuel conductivity; pulses: adiabatic peak and energy deposited over four tabulated-power cases, two generated by point kinetics, and a steady-start hold; mechanics: displacements, axial stress, a closing gap, a gas pressure, the hydrogen pressure and a stress-limit margin; a coolant side that changes with time: three lumped pins with a film step, a ramp in the coolant temperature and a decaying film, and the energy of the first; an axial stack and a plate: the hottest slice, its index and the coolest slice of a cosine, a warming-coolant and a skewed stack of pins and a cosine stack of plates, a plate alone, and two lumped stacks in a transient), " + (BAD.length + mechBad + tvbBad + stackBad) + " bad-input entries, " + (2 + mechKnown) + " known-limit entries.",
    "All cases use the mesh " + MESH.fuelCells + "/" + MESH.claddingCells + " (fuel/cladding cells), except the mechanics cases, which use " + MECH_MESH.fuelCells + "/" + MECH_MESH.claddingCells + " (see the generator). The peak is the first fuel cell centre of that mesh.",
    "Pulse entries test the adiabatic limit only: heat leaving the fuel during a long transient has no entry here (FEED checks it against its own independent solution). Mechanics (plan 09 M6) is covered by the entries named feed-mechanics-*: free thermal expansion, an axially fixed solid, a closing gap, a gas pressure, the hydrogen pressure, a stress-limit margin, one known limit (a soft fuel) and six refusals. A boundary history (plan 11) is covered by the entries named feed-synthetic-lumped-* (peak against an RK4 lumped solution, tolerance 1 % of the rise) and five refusals (feed-bad-boundary-history-*); a violent change between two saved outputs is not covered. An axial stack (plan 12) is covered by the entries named feed-stack-* (peak, the index of the hottest slice and the lowest slice peak against the per-slice closed form, tolerance = mesh bound + 3 x the axial conduction estimate + the cosine table), a plate by feed-plate-steady-* and feed-stack-cosine-plate-*, a stack in a transient by feed-stack-lumped-* (RK4 lumped slices, tolerance = 1 % of the rise + twice the bound on the heat the slices exchange + the internal rise) and eight refusals (feed-bad-axial-*, feed-bad-plate-*). The new quantities are axial_hottest_slice and temperature_peak_slice_min (docs/seed-stack-request.md). Not covered: stress of a real design, a central hole whose surface is not insulated, gap closure and contact, fission gas, burnup, any real design. FEED results are thermal only.",
    "",
  ].join(NL)
);
console.log("wrote " + (good + transientGood + kineticsGood + limitGood + gaGood + mechGood + tvbGood + stackGood) + " good, " + (BAD.length + mechBad + tvbBad + stackBad) + " bad-input and " + (2 + mechKnown) + " known-limit entries to " + out);
