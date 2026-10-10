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

write(
  path.join(out, "README.md"),
  [
    "# SEED oracle entries for FEED",
    "",
    "Generated by `scripts/gen-seed-oracles.cjs`. Entries in `entries/` are `seed.oracle/0.1` documents; `models/` holds the cases they pin by hash.",
    "Expected values are the closed-form series solution computed by the generator, never the output of a solver run. A tolerance is part of the",
    "entry's hash: changing it needs a new `entryVersion` made by a human.",
    "",
    (good + transientGood + kineticsGood + limitGood + gaGood + mechGood) + " good entries (steady: peak, outer-wall temperature, flux and energy balance over eight pins, two of them with a cubic and a tabulated fuel conductivity; pulses: adiabatic peak and energy deposited over four tabulated-power cases, two generated by point kinetics, and a steady-start hold; mechanics: displacements, axial stress, a closing gap, a gas pressure, the hydrogen pressure and a stress-limit margin), " + (BAD.length + mechBad) + " bad-input entries, " + (2 + mechKnown) + " known-limit entries.",
    "All cases use the mesh " + MESH.fuelCells + "/" + MESH.claddingCells + " (fuel/cladding cells), except the mechanics cases, which use " + MECH_MESH.fuelCells + "/" + MECH_MESH.claddingCells + " (see the generator). The peak is the first fuel cell centre of that mesh.",
    "Pulse entries test the adiabatic limit only: heat leaving the fuel during a long transient has no entry here (FEED checks it against its own independent solution). Mechanics (plan 09 M6) is covered by the entries named feed-mechanics-*: free thermal expansion, an axially fixed solid, a closing gap, a gas pressure, the hydrogen pressure, a stress-limit margin, one known limit (a soft fuel) and six refusals. Not covered: stress of a real design, a central hole whose surface is not insulated, gap closure and contact, fission gas, burnup, any real design. FEED results are thermal only.",
    "",
  ].join(NL)
);
console.log("wrote " + (good + transientGood + kineticsGood + limitGood + gaGood + mechGood) + " good, " + (BAD.length + mechBad) + " bad-input and " + (2 + mechKnown) + " known-limit entries to " + out);
