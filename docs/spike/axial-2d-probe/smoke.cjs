"use strict";
// quick look: the decoupled kernel equals steadyFv (the existing 1D reference), and the coupled solution against one saved run
const path = require("path");
const D = path.join(__dirname, "..", "..", "..", "dist", "core");
const fv = require(D + "/transientFv");
const { sliceCase } = require(D + "/axial");
const { solve2D, modelOfCase, propsOf } = require("./axial2d.cjs");
const G = require("./golden.cjs");

const dir = process.argv[2] || "offbeat-stack/cosine";
const { c, T, walls } = G.readSteady(dir);
const m = modelOfCase(c);
const N = c.axial.slices, nf = c.mesh.fuelCells, nc = c.mesh.claddingCells, n = nf + nc;
const pin1 = (sc) => ({ slab: !!sc.plate, fuelInnerRadius: sc.fuelInnerRadius, fuelRadius: sc.fuelRadius, claddingInnerRadius: sc.claddingInnerRadius, claddingOuterRadius: sc.claddingOuterRadius, fuelCells: nf, claddingCells: nc, gapConductance: sc.gapConductance, fuelK: { a: 3, b: 0 }, claddingK: { a: 15, b: 0 }, ...propsOf(sc), fuelC: { a: 1, b: 0 }, claddingC: { a: 1, b: 0 }, boundary: sc.boundary, power: () => 0 });
const dec = solve2D(m, { steady: true, axial: false }).states[0];
let worst = 0;
m.loads.forEach((l, k) => {
  const sc = sliceCase(c, l);
  const s = fv.steadyFv(pin1(sc), l.linearHeatRate);
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(s.T[i] - dec.T[k * n + i]));
});
console.log("decoupled kernel vs steadyFv per slice: max |diff| =", worst);
for (const variant of [{ radial: "feed" }, { radial: "offbeat", faceK: "arith", gapArea: "fuel" }, { radial: "offbeat", faceK: "arith", gapArea: "clad" }]) {
  const st = solve2D(m, { steady: true, ...variant }).states[0];
  let mx = 0, ss = 0, cnt = 0, mxw = 0;
  for (let k = 0; k < N; k++) {
    for (let i = 0; i < n; i++) { const d = st.T[k * n + i] - T[k][i]; mx = Math.max(mx, Math.abs(d)); ss += d * d; cnt++; }
    mxw = Math.max(mxw, Math.abs(st.wall[k] - walls[k]));
  }
  console.log(JSON.stringify(variant), "2D vs OFFBEAT: max", mx.toFixed(5), "rms", Math.sqrt(ss / cnt).toFixed(5), "wall max", mxw.toFixed(5), "centre layer0", st.T[0].toFixed(3), T[0][0].toFixed(3), "heat bal", ((st.rejected - st.deposited) / st.deposited).toExponential(2));
}
