"use strict";
// Plan 15, B0: the plan's negative tests on the probe: perturb the (r, z) reference and see whether the comparison with the saved OFFBEAT field (gate ratio =
// max over layers of max |difference| / the existing mesh bound 5 dT / N^2 of the fuel and of the cladding) would catch it (ratio above 1).
const path = require("path");
const D = path.join(__dirname, "..", "..", "..", "dist", "core");
const { sliceCase } = require(D + "/axial");
const { quickLook } = require(D + "/quickLook");
const { solve2D, modelOfCase } = require("./axial2d.cjs");
const G = require("./golden.cjs");

function ratio(c, T, st) {
  const N = c.axial.slices, nf = c.mesh.fuelCells, nc = c.mesh.claddingCells, n = nf + nc;
  const m0 = modelOfCase(c);
  let g = 0, absMax = 0;
  for (let k = 0; k < N; k++) {
    const t = quickLook(sliceCase(c, m0.loads[k])).temperatures;
    const bf = (5 * (t.centreT - t.fuelSurfaceT)) / (nf * nf), bc = (5 * (t.claddingInnerT - t.claddingOuterT)) / (nc * nc);
    let fm = 0, cm = 0;
    for (let i = 0; i < n; i++) { const d = Math.abs(st.T[k * n + i] - T[k][i]); if (i < nf) fm = Math.max(fm, d); else cm = Math.max(cm, d); }
    g = Math.max(g, fm / bf, cm / bc);
    absMax = Math.max(absMax, fm, cm);
  }
  return { g, absMax };
}
const cases = [["pin cosine 0.381", "offbeat-stack/cosine"], ["pin short 0.06", "offbeat-stack/short"], ["pin rise", "offbeat-stack/rise"], ["plate cosine 0.381", "offbeat-plate-stack/cosine"], ["plate short 0.06", "offbeat-plate-stack/short"], ["plate steep", "offbeat-plate-stack/steep"], ["plate rise", "offbeat-plate-stack/rise"], ["plate negative", "offbeat-plate-stack/negative"]];
console.log("run | reference as planned | axial term removed | shape shifted one layer | coolant read from the top   (each: max |diff| K / gate ratio; the planned reference must stay below 1, the others should exceed 1)");
for (const [name, dir] of cases) {
  const { c, T } = G.readSteady(dir);
  const N = c.axial.slices;
  const m = modelOfCase(c);
  const run = (mm, o = {}) => ratio(c, T, solve2D(mm, { steady: true, radial: "feed", ...o }).states[0]);
  const fmt = (r) => `${r.absMax.toFixed(2)} K / ${r.g.toFixed(2)}`;
  const shifted = { ...m, q: (k, t) => m.q((k + 1) % N, t) };
  const flipped = { ...m, bnd: (k, t) => m.bnd(N - 1 - k, t) };
  console.log([name, fmt(run(m)), fmt(run(m, { axial: false })), fmt(run(shifted)), fmt(run(flipped))].join(" | "));
}
