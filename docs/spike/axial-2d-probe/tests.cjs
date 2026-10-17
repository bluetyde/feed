"use strict";
// Plan 15, B0: the plan's cheap tests, run on the probe solver: the reduction, conservation, and the exact cos(pi z / H) plate solution (steady and in time).
//   node docs/spike/axial-2d-probe/tests.cjs
const path = require("path");
const D = path.join(__dirname, "..", "..", "..", "dist", "core");
const fv = require(D + "/transientFv");
const { sliceCase } = require(D + "/axial");
const TR = require(D + "/transientResults");
const { solve2D, modelOfCase, propsOf } = require("./axial2d.cjs");
const G = require("./golden.cjs");

const maxdiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const withLaws = (c) => ({
  ...c,
  fuelConductivity: { kind: "linear", a: 4.0, b: -0.0012, range: [300, 3000] },
  claddingConductivity: { kind: "linear", a: 12, b: 0.004, range: [300, 3000] },
  fuelHeatCapacity: { kind: "linear", a: 2.5e6, b: 500, range: [300, 3000] },
  claddingHeatCapacity: { kind: "linear", a: 2.2e6, b: 300, range: [300, 3000] },
});
const results = [];
const note = (name, value, limit, extra = "") => { const ok = value <= limit; results.push(ok); console.log((ok ? "PASS " : "FAIL ") + name + ": " + value.toExponential(3) + " (limit " + limit + ")" + (extra ? " " + extra : "")); };

// ---------------------------------------------------------------- 1. reduction: identical layers, flat shape, uniform coolant = N copies of the 1D solution
console.log("== 1. reduction (identical layers, flat shape): coupled solution against N copies of the one-dimensional one");
for (const [label, dir, laws] of [["pin, constant k", "offbeat-stack/cosine", false], ["plate, constant k", "offbeat-plate-stack/cosine", false], ["pin, k(T)", "offbeat-stack/cosine", true], ["plate, k(T)", "offbeat-plate-stack/cosine", true]]) {
  let c = G.readCase(dir);
  c = { ...c, axial: { ...c.axial, shape: { kind: "flat" } } };
  if (laws) c = withLaws(c);
  const m = modelOfCase(c);
  const n = c.mesh.fuelCells + c.mesh.claddingCells;
  const coupled = solve2D(m, { steady: true, radial: "feed", axial: true, tol: 2e-11 }).states[0];
  const one = solve2D({ ...m, N: 1, H: m.H / m.N, q: () => m.q(0, 0), bnd: () => m.bnd(0, 0) }, { steady: true, radial: "feed", axial: true, tol: 2e-11 }).states[0];
  let worst = 0;
  for (let k = 0; k < m.N; k++) for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(coupled.T[k * n + i] - one.T[i]));
  note("steady " + label + " (N=" + m.N + ")", worst, 1e-10);
}
{
  let c = G.readCase("offbeat-stack-transient/coastdown");
  c = withLaws({ ...c, axial: { ...c.axial, shape: { kind: "flat" } } });
  const m = modelOfCase(c);
  const n = c.mesh.fuelCells + c.mesh.claddingCells;
  const tr = c.transient;
  const T0 = TR.initialState(sliceCase(c, m.loads[0])).T;
  const init = new Float64Array(m.N * n);
  for (let k = 0; k < m.N; k++) init.set(T0, k * n);
  const o = { dt: tr.timeStep, steps: 400, outputEvery: 100, initial: init, radial: "feed", tol: 2e-11 };
  const coupled = solve2D(m, { ...o, axial: true });
  const one = solve2D({ ...m, N: 1, H: m.H / m.N, q: (k, t) => m.q(0, t), bnd: (k, t) => m.bnd(0, t) }, { ...o, initial: Float64Array.from(T0), axial: true });
  let worst = 0;
  coupled.states.forEach((s, j) => { for (let k = 0; k < m.N; k++) for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(s.T[k * n + i] - one.states[j].T[i])); });
  note("transient pin coastdown, k(T) and c(T), flat shape, 400 steps (Picard in both)", worst, 1e-10);
}

// ---------------------------------------------------------------- 2. conservation
console.log("== 2. conservation: heat made = heat out + stored");
for (const [label, dir, laws] of [["pin cosine", "offbeat-stack/cosine", false], ["pin short", "offbeat-stack/short", false], ["plate steep", "offbeat-plate-stack/steep", false], ["pin short k(T)", "offbeat-stack/short", true], ["plate steep k(T)", "offbeat-plate-stack/steep", true]]) {
  let c = G.readCase(dir);
  if (laws) c = withLaws(c);
  const m = modelOfCase(c);
  const s = solve2D(m, { steady: true, radial: "feed" }).states[0];
  note("steady " + label, Math.abs(s.rejected - s.deposited) / s.deposited, 1e-9);
}
for (const [label, dir, laws] of [["pin coastdown", "offbeat-stack-transient/coastdown", false], ["pin short pulse", "offbeat-stack-transient/short", false], ["pin coastdown k(T), c(T)", "offbeat-stack-transient/coastdown", true], ["plate loss of cooling k(T), c(T)", "offbeat-plate-stack/transient-lossofcooling-short", true], ["plate pulse k(T), c(T)", "offbeat-plate-stack/transient-short", true]]) {
  let c = G.readCase(dir);
  if (laws) c = withLaws(c);
  const m = modelOfCase(c);
  const n = c.mesh.fuelCells + c.mesh.claddingCells;
  const tr = c.transient;
  const init = new Float64Array(m.N * n);
  m.loads.forEach((l, k) => init.set(TR.initialState(sliceCase(c, l)).T, k * n));
  const r = solve2D(m, { dt: tr.timeStep, steps: tr.steps, outputEvery: tr.steps / 10, initial: init, radial: "feed" });
  let worst = 0;
  for (const s of r.states.slice(1)) worst = Math.max(worst, Math.abs(s.deposited - s.stored - s.rejected) / Math.max(Math.abs(s.deposited), Math.abs(s.stored), Math.abs(s.rejected)));
  note("transient " + label, worst, 1e-9);
}

// ---------------------------------------------------------------- 3. the exact solution
// A single material slab (a plate), x from the insulated mid-plane (0) to the wall (X), z from 0 to H with insulated ends, a source q0 cos(pi z / H) in every cell, the wall at Tw.
// T = Tw + (q0 / (k lam^2)) cos(lam z) (1 - cosh(lam x) / cosh(lam X)), lam = pi / H.
console.log("== 3. exact solution: q0 cos(pi z / H) in a plate with a fixed wall");
const k0 = 3, Tw = 500, q0 = 2e8, H = 0.02, half = 0.004; // W/m/K, K, W/m3, m, m: lam X = 0.63
const lam = Math.PI / H, X = 2 * half;
const slabModel = (nx, N, extra = {}) => ({
  slab: true, fuelInner: 0, fuelR: half, cladInner: half, cladOuter: X, nf: nx, nc: nx, N, H,
  props: propsOf({ fuelConductivity: { kind: "constant", k: k0, referenceTemperature: 1000 }, claddingConductivity: { kind: "constant", k: k0, referenceTemperature: 1000 }, fuelHeatCapacity: { kind: "constant", c: 3e6, referenceTemperature: 300 }, claddingHeatCapacity: { kind: "constant", c: 3e6, referenceTemperature: 300 } }),
  gap: 1e13, // no resistance: the interface is a plain cell face
  q: (k, t) => (extra.q ? extra.q(k, t) : q0 * X * Math.cos((Math.PI * (k + 0.5)) / N)),
  bnd: () => ({ kind: "surface-temperature", surfaceTemperature: Tw }),
});
const exactSteady = (x, z) => Tw + (q0 / (k0 * lam * lam)) * Math.cos(lam * z) * (1 - Math.cosh(lam * x) / Math.cosh(lam * X));
const errs = [];
let rise = 0;
for (const [nx, N] of [[2, 4], [4, 8], [8, 16], [16, 32], [32, 64]]) {
  const m = slabModel(nx, N);
  const s = solve2D(m, { steady: true, radial: "feed", axial: true, sourceAll: true });
  const s1 = solve2D(m, { steady: true, radial: "feed", axial: false, sourceAll: true });
  const n = 2 * nx;
  let e2 = 0, e1 = 0;
  const hx = X / n;
  for (let k = 0; k < N; k++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * hx, z = ((k + 0.5) * H) / N;
    e2 = Math.max(e2, Math.abs(s.states[0].T[k * n + i] - exactSteady(x, z)));
    e1 = Math.max(e1, Math.abs(s1.states[0].T[k * n + i] - exactSteady(x, z)));
  }
  errs.push({ nx, N, e2, e1, bal: Math.abs(s.states[0].rejected - s.states[0].deposited) / Math.max(Math.abs(s.states[0].deposited), 1) });
}
errs.forEach((e, j) => console.log(`  cells ${2 * e.nx} x ${e.N} layers: max error of the (r,z) solution ${e.e2.toExponential(3)} K${j ? " (ratio to coarser " + (errs[j - 1].e2 / e.e2).toFixed(2) + ")" : ""}, of N one-dimensional solutions ${e.e1.toExponential(3)} K`));
{
  const r1 = errs[errs.length - 2].e2 / errs[errs.length - 1].e2;
  const r0 = errs[errs.length - 3].e2 / errs[errs.length - 2].e2;
  note("steady exact-solution order: |ratio - 4| on the two finest halvings", Math.max(Math.abs(r1 - 4), Math.abs(r0 - 4)), 0.3, "(second order = 4.00)");
  rise = (q0 / (k0 * lam * lam)) * (1 - 1 / Math.cosh(lam * X));
  console.log("  (the largest rise of the solution is " + rise.toFixed(0) + " K; the finest-mesh error is " + (errs[errs.length - 1].e2 / rise).toExponential(2) + " of it. The first absolute limit I wrote for this error, 1e-3 K, was a slip in scale; the criterion is the order, as the plan says: 'the error falls at second order')");
  note("one-dimensional misses the exact solution by (K) on the finest mesh, i.e. the 2D solution is at least 100 times better", errs[errs.length - 1].e2 * 100, errs[errs.length - 1].e1);
}
// in time: the same source switched on at t = 0 from the wall temperature. Theta(x, t) series: cos(mu_n x), mu_n = (n + 1/2) pi / X, s_n = a (mu_n^2 + lam^2), a = k / (rho c)
const rc = 3e6, a = k0 / rc;
const exactTime = (x, z, t) => {
  let th = 0;
  for (let n = 0; n < 4000; n++) {
    const mu = ((n + 0.5) * Math.PI) / X;
    const s = a * (mu * mu + lam * lam);
    const bn = (2 * (n % 2 ? -1 : 1)) / (mu * X); // the expansion of 1 in cos(mu x)
    th += bn * Math.cos(mu * x) * (1 - Math.exp(-s * t)) / s;
  }
  return Tw + (q0 / rc) * Math.cos(lam * z) * th;
};
console.log("-- in time (implicit Euler, 32 x 64 cells, t = 10 s; the time scale 1/s_0 =", (1 / (a * ((Math.PI / (2 * X)) ** 2 + lam * lam))).toFixed(3), "s)");
{
  const nx = 32, N = 64, tEnd = 10, n = 2 * nx, hx = X / n;
  const m = slabModel(nx, N);
  const ex = [];
  for (let k = 0; k < N; k++) for (let i = 0; i < n; i++) ex.push(exactTime((i + 0.5) * hx, ((k + 0.5) * H) / N, tEnd));
  const out = [];
  for (const steps of [5, 10, 20, 40, 80, 160]) {
    const init = new Float64Array(N * n).fill(Tw);
    const r = solve2D(m, { dt: tEnd / steps, steps, outputEvery: steps, initial: init, radial: "feed", axial: true, sourceAll: true });
    const T = r.states[r.states.length - 1].T;
    out.push({ steps, e: maxdiff(T, ex), bal: Math.abs(r.states[r.states.length - 1].deposited - r.states[r.states.length - 1].stored - r.states[r.states.length - 1].rejected) / (q0 * X * H / N * (2 / Math.PI) * N / 2 * tEnd) });
  }
  out.forEach((e, j) => console.log(`  ${e.steps} steps: max error ${e.e.toExponential(3)} K${j ? " (ratio " + (out[j - 1].e / e.e).toFixed(2) + ")" : ""}, balance ${e.bal.toExponential(1)}`));
  // the time error halves with the step (first order); the space error (about 1e-3 K above) is the floor: use the coarser steps only
  const r = out[0].e / out[1].e;
  note("time exact-solution order: |ratio - 2| on 5 -> 10 steps", Math.abs(r - 2), 0.3, "(first order = 2.00)");
  console.log("  time error at 160 steps: " + (out[out.length - 1].e / rise).toExponential(2) + " of the rise (first order in the step, as implicit Euler is)");
  const init = new Float64Array(N * n).fill(Tw);
  const r1 = solve2D(m, { dt: tEnd / 160, steps: 160, outputEvery: 160, initial: init, radial: "feed", axial: false, sourceAll: true });
  const T1 = r1.states[r1.states.length - 1].T;
  console.log("  N one-dimensional solutions at 160 steps: max error", maxdiff(T1, ex).toExponential(3), "K against", out[out.length - 1].e.toExponential(3), "K for the (r,z) solution");
}
console.log(results.every(Boolean) ? "ALL PASS (" + results.length + ")" : "SOME FAILED");
process.exit(results.every(Boolean) ? 0 : 1);
