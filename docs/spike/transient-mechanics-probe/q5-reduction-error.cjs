// Throw-away (plan 17 M0, question 5): the size of the approximation of ONE pair of constants (E, alpha) reduced at the area-mean temperature of the fuel at a stated time,
// against the exact laws of the library (E(T) = a + b T, thermal strain = the integral of alpha(T) from the reference temperature) evaluated cell by cell, at several times of the
// pulse and of a cooldown, with FEED's independent finite-volume temperatures of that time. Both solutions are the probe-local finite-element version (vp.cjs), validated against
// src/core/thermoElastic.ts for constant properties. usage: node q5-reduction-error.cjs [--json out.json]
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "..");
const { solveSliceVP } = require("./vp.cjs");
const { solveTransientFv } = require(path.join(root, "dist/core/transientFv.js"));
const tr = require(path.join(root, "dist/core/transientResults.js"));
const { validateCase } = require(path.join(root, "dist/core/validate.js"));

const TREF = 293.15;
const ex = JSON.parse(fs.readFileSync(path.join(root, "examples/ut-triga-pulse-4p40-limits.json"), "utf8"));
delete ex.limits;
const lib = JSON.parse(fs.readFileSync(path.join(root, "library/materials.json"), "utf8"));
const fm = lib.find((e) => e.material && e.material.materialId === "triga-uzrh-h16").material.sets;
const Ea = fm["mechanical.elasticity"].a.value, Eb = fm["mechanical.elasticity"].b.value;
const aA = fm["mechanical.thermalExpansion"].linearExpansion.a.value, aB = fm["mechanical.thermalExpansion"].linearExpansion.b.value;
const strain = (T) => aA * (T - TREF) + 0.5 * aB * (T * T - TREF * TREF);
const clad = { E: 190e9, nu: 0.3, alpha: 17.2e-6 };
const nuF = 0.32;

function thetaFrom(rs, f) {
  return (x) => {
    let i = rs.findIndex((v) => v >= x);
    if (i <= 0) i = 1;
    if (i < 0) i = rs.length - 1;
    const a = i - 1;
    return f[a] + ((f[i] - f[a]) * (x - rs[a])) / (rs[i] - rs[a]);
  };
}

function fvStates(gapUm) {
  const e = JSON.parse(JSON.stringify(ex));
  e.geometry.claddingInnerRadius = { value: 18.161 + gapUm / 1000, unit: "mm" };
  const c = validateCase(e).normalized;
  const pin0 = tr.pinOf(c);
  const hist = e.transient.powerHistory.map((p) => [p.time.value / 1e3, p.linearHeatRate.value * (p.linearHeatRate.unit === "MW/m" ? 1e6 : 1)]);
  hist.push([0.1005, 0], [1e5, 0]);
  const power = (t) => {
    if (t <= hist[0][0]) return hist[0][1];
    for (let i = 1; i < hist.length; i++) if (t <= hist[i][0]) return hist[i - 1][1] + ((hist[i][1] - hist[i - 1][1]) * (t - hist[i - 1][0])) / (hist[i][0] - hist[i - 1][0]);
    return hist[hist.length - 1][1];
  };
  const pin = { ...pin0, power };
  const r1 = solveTransientFv(pin, { dt: 5e-5, steps: 2000, initialTemperature: TREF, outputEvery: 40 }); // every 2 ms
  const states = r1.states.map((s) => ({ t: s.time, T: s.T }));
  const last = r1.states[r1.states.length - 1];
  const r2 = solveTransientFv({ ...pin, power: (t) => power(t + 0.1) }, { dt: 0.05, steps: 600, initialField: last.T, outputEvery: 20 }); // every 1 s to 30 s
  states.push(...r2.states.slice(1).map((s) => ({ t: s.time + 0.1, T: s.T })));
  return { c, r: r1.r, states };
}

function reduceAt(c, T) {
  const nf = c.mesh.fuelCells;
  let w = 0, ts = 0, es = 0;
  for (let i = 0; i < nf; i++) {
    const r0 = c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * i) / nf, r1 = c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * (i + 1)) / nf;
    const a = r1 * r1 - r0 * r0;
    w += a; ts += a * T[i]; es += a * strain(T[i]);
  }
  const Tm = ts / w;
  return { meanT: Tm, E: Ea + Eb * Tm, alpha: es / w / (Tm - TREF) };
}

function slice(c, r, T, mode, k) {
  // mode "law": the fuel with E(T), strain(T) cell by cell; mode "const": constants k = {E, alpha}
  const nf = c.mesh.fuelCells;
  const Tf = thetaFrom(r.slice(0, nf), T.slice(0, nf));
  const Tc = thetaFrom(r.slice(nf), T.slice(nf));
  const fuel = mode === "law" ? { a: c.fuelInnerRadius, b: c.fuelRadius, nu: nuF, E: (x) => Ea + Eb * Tf(x), th: (x) => strain(Tf(x)) } : { a: c.fuelInnerRadius, b: c.fuelRadius, nu: nuF, E: () => k.E, th: (x) => k.alpha * (Tf(x) - TREF) };
  const cl = { a: c.claddingInnerRadius, b: c.claddingOuterRadius, nu: clad.nu, E: () => clad.E, th: (x) => clad.alpha * (Tc(x) - TREF) };
  return solveSliceVP(fuel, cl, 0, 240);
}

function diff(c, r, a, b) {
  const nf = c.mesh.fuelCells;
  let dSf = 0, sScale = 0, dSc = 0, sScaleC = 0, dU = 0;
  r.forEach((x, i) => {
    const fa = (i < nf ? a.fuel : a.cladding).at(x), fb = (i < nf ? b.fuel : b.cladding).at(x);
    const d = Math.max(Math.abs(fa.sigmaR - fb.sigmaR), Math.abs(fa.sigmaTheta - fb.sigmaTheta), Math.abs(fa.sigmaZ - fb.sigmaZ));
    const s = Math.max(Math.abs(fa.sigmaR), Math.abs(fa.sigmaTheta), Math.abs(fa.sigmaZ));
    if (i < nf) { dSf = Math.max(dSf, d); sScale = Math.max(sScale, s); } else { dSc = Math.max(dSc, d); sScaleC = Math.max(sScaleC, s); }
    dU = Math.max(dU, Math.abs(fa.ur - fb.ur));
  });
  return { dSigmaFuelMPa: dSf / 1e6, sigmaFuelScaleMPa: sScale / 1e6, dSigmaCladMPa: dSc / 1e6, sigmaCladScaleMPa: sScaleC / 1e6, dUum: dU * 1e6 };
}

const out = [];
const samples = [0.01, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1, 1, 3, 6, 10, 15, 20, 30];
for (const gapUm of [0, 20, 40]) {
  const { c, r, states } = fvStates(gapUm);
  const at = (t) => states.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const refs = { "30ms": reduceAt(c, at(0.03).T), "60ms": reduceAt(c, at(0.06).T) };
  for (const t of samples) {
    const st = at(t);
    const exact = slice(c, r, st.T, "law");
    const self = reduceAt(c, st.T);
    const row = { gapUm, t, TfuelMax: Math.max(...st.T.slice(0, c.mesh.fuelCells)), TfuelMean: self.meanT, contact: exact.contact, pExactMPa: exact.contactPressure / 1e6, freeGapUm: exact.freeGap * 1e6, byRef: {} };
    const sSelf = slice(c, r, st.T, "const", self);
    row.constAtSameTime = { ...diff(c, r, exact, sSelf), pMPa: sSelf.contactPressure / 1e6, contact: sSelf.contact };
    for (const [name, k] of Object.entries(refs)) {
      const s = slice(c, r, st.T, "const", k);
      row.byRef[name] = { ...diff(c, r, exact, s), pMPa: s.contactPressure / 1e6, contact: s.contact, E: k.E / 1e9, alpha: k.alpha };
    }
    out.push(row);
  }
}
const j = process.argv.indexOf("--json");
if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(out, null, 1) + "\n");
const f = (x, d = 2) => (x === undefined || x === null ? "-" : Number(x).toFixed(d));
console.log("gap_um t_s  Tmax  Tmean | exact: contact P_MPa freeGap_um sigmaFuelScale | const@same t: dSigmaF dU_um P | const@30ms: dSigmaF dSigmaC dU P | const@60ms: dSigmaF dSigmaC dU P");
for (const o of out) {
  const a = o.byRef["30ms"], b = o.byRef["60ms"], s = o.constAtSameTime;
  console.log(`${o.gapUm} ${o.t} ${f(o.TfuelMax, 0)} ${f(o.TfuelMean, 0)} | ${o.contact ? "C" : "o"} ${f(o.pExactMPa)} ${f(o.freeGapUm, 1)} ${f(s.sigmaFuelScaleMPa, 1)} | ${f(s.dSigmaFuelMPa)} ${f(s.dUum, 2)} ${f(s.pMPa)} | ${f(a.dSigmaFuelMPa)} ${f(a.dSigmaCladMPa)} ${f(a.dUum, 2)} ${f(a.pMPa)} | ${f(b.dSigmaFuelMPa)} ${f(b.dSigmaCladMPa)} ${f(b.dUum, 2)} ${f(b.pMPa)}`);
}
