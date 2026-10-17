"use strict";
// Plan 15, B0: the (r, z) probe solution against every saved steady stack run of tests/golden, cell by cell.
//   node docs/spike/axial-2d-probe/run-steady.cjs [json-out]
const fs = require("fs");
const path = require("path");
const D = path.join(__dirname, "..", "..", "..", "dist", "core");
const { sliceCase } = require(D + "/axial");
const { quickLook } = require(D + "/quickLook");
const SR = require(D + "/stackResults");
const { solve2D, modelOfCase } = require("./axial2d.cjs");
const G = require("./golden.cjs");

const stats = (d) => {
  let mx = 0, ss = 0;
  for (const x of d) { mx = Math.max(mx, Math.abs(x)); ss += x * x; }
  return { max: mx, rms: Math.sqrt(ss / d.length) };
};
const rows = [];
const detail = {};
const only = process.argv[3];
for (const [name, dir] of G.STEADY) {
  if (only && !name.includes(only)) continue;
  const { c, T, walls } = G.readSteady(dir);
  const N = c.axial.slices, nf = c.mesh.fuelCells, nc = c.mesh.claddingCells, n = nf + nc;
  const run = (variant, mopt) => {
    const m = modelOfCase(c, mopt);
    const st = solve2D(m, { steady: true, ...variant }).states[0];
    const L = [];
    for (let k = 0; k < N; k++) L.push(Array.from(st.T.subarray(k * n, (k + 1) * n)));
    return { L, wall: st.wall, bal: (st.rejected - st.deposited) / st.deposited };
  };
  const F2 = run({ radial: "feed", axial: true });
  const F1 = run({ radial: "feed", axial: false });
  const O2 = run({ radial: "offbeat", axial: true, faceK: "arith", gapArea: "fuel" });
  const O1 = run({ radial: "offbeat", axial: false, faceK: "arith", gapArea: "fuel" });
  const m0 = modelOfCase(c);
  // the mesh bound of the existing closed-form check, per slice: 5 dT / N^2 on the fuel and on the cladding (no axial allowance)
  const bound = m0.loads.map((l) => {
    const t = quickLook(sliceCase(c, l)).temperatures;
    return { fuel: (5 * (t.centreT - t.fuelSurfaceT)) / (nf * nf), clad: (5 * (t.claddingInnerT - t.claddingOuterT)) / (nc * nc) };
  });
  // the existing check as the suite runs it (with its 3 x estimate allowance), from the saved output
  let existing = {};
  {
    const foam = fs.readFileSync(path.join(__dirname, "..", "..", "..", "tests", "golden", dir, "T"), "utf8");
    const Cf = fs.readFileSync(path.join(__dirname, "..", "..", "..", "tests", "golden", dir, "C"), "utf8");
    const rec = SR.buildStackResults(c, { T: foam, C: Cf, time: 5e7, steadyRate: 0 });
    const f = rec.checks.find((x) => x.id === "closedFormFuel");
    const cl = rec.checks.find((x) => x.id === "closedFormCladding");
    existing = { fuelWorst: f.value, fuelBound: parseFloat(/= ([0-9.]+) K/.exec(f.note)[1]), cladWorst: cl.value, cladBound: parseFloat(/= ([0-9.]+) K/.exec(cl.note)[1]), allowK: rec.axial.allowance.field };
  }
  const perLayer = [];
  let gate = 0, gateAt = "";
  const all = { f2: [], f1: [], o2: [], effOF: [], effF: [], resid: [] };
  let worstWall2 = 0, worstWall1 = 0;
  for (let k = 0; k < N; k++) {
    const dF2 = [], dF1 = [], dO2 = [], effOF = [], effF = [], resid = [];
    for (let i = 0; i < n; i++) {
      dF2.push(F2.L[k][i] - T[k][i]);
      dF1.push(F1.L[k][i] - T[k][i]);
      dO2.push(O2.L[k][i] - T[k][i]);
      effOF.push(T[k][i] - O1.L[k][i]); // OFFBEAT stack minus the one-layer OFFBEAT discretisation (what A0 measured against separate one-layer runs)
      effF.push(F2.L[k][i] - F1.L[k][i]); // the same effect in FEED's own kernel
      resid.push(effF[i] - effOF[i]);
    }
    worstWall2 = Math.max(worstWall2, Math.abs(F2.wall[k] - walls[k]));
    worstWall1 = Math.max(worstWall1, Math.abs(F1.wall[k] - walls[k]));
    const fuelMax = Math.max(...dF2.slice(0, nf).map(Math.abs));
    const cladMax = Math.max(...dF2.slice(nf).map(Math.abs));
    const r1 = fuelMax / bound[k].fuel, r2 = cladMax / bound[k].clad;
    if (Math.max(r1, r2) > gate) { gate = Math.max(r1, r2); gateAt = "layer " + (k + 1); }
    perLayer.push({ layer: k + 1, f2: stats(dF2), f1: stats(dF1), o2: stats(dO2), eff: stats(effOF), effF: stats(effF), resid: stats(resid), centre: { of: T[k][0], f1: F1.L[k][0], f2: F2.L[k][0], effOF: effOF[0], effF: effF[0] }, boundFuel: bound[k].fuel, boundClad: bound[k].clad, fuelMax, cladMax });
    for (const [key, d] of [["f2", dF2], ["f1", dF1], ["o2", dO2], ["effOF", effOF], ["effF", effF], ["resid", resid]]) all[key].push(...d);
  }
  const s = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, stats(v)]));
  const peak = perLayer.reduce((b, x) => (x.centre.of > b.centre.of ? x : b), perLayer[0]);
  const end = perLayer[0];
  rows.push({ name, N, L: c.axial.length, s, gate, gateAt, existing, worstWall2, worstWall1, balance: F2.bal, end: end.centre, peak: { layer: peak.layer, ...peak.centre }, perLayer });
  detail[name] = perLayer;
}
const f = (x, d = 3) => x.toFixed(d);
console.log("run | N L | max|OF-2D| rms | max|OF-1D| rms | gate ratio(max |OF-2D| / mesh bound, worst layer) | O-kernel 2D max | axial effect OF max / FEED-2D max / resid max | wall 2D / 1D | existing check worst fuel(bound incl. allow) clad");
for (const r of rows) console.log(`${r.name} | ${r.N} ${r.L} | ${f(r.s.f2.max)} ${f(r.s.f2.rms)} | ${f(r.s.f1.max)} ${f(r.s.f1.rms)} | ${f(r.gate, 3)} ${r.gateAt} | ${f(r.s.o2.max, 4)} | ${f(r.s.effOF.max)} / ${f(r.s.effF.max)} / ${f(r.s.resid.max)} | ${f(r.worstWall2, 4)} / ${f(r.worstWall1, 4)} | ${f(r.existing.fuelWorst)} (${f(r.existing.fuelBound)}) ${f(r.existing.cladWorst)} (${f(r.existing.cladBound)}) allow ${f(r.existing.allowK)}`);
console.log("\nend / peak layer fuel-centre cell: OFFBEAT minus the one-layer OFFBEAT discretisation (effect, A0's measure), FEED 2D minus FEED 1D, and OFFBEAT minus FEED 2D");
for (const r of rows) {
  const e = r.end, p = r.peak;
  console.log(`${r.name} | end(1): effOF ${f(e.effOF)} effF ${f(e.effF)} | peak(${p.layer}): effOF ${f(p.effOF)} effF ${f(p.effF)}`);
}
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ rows }, null, 1));
