"use strict";
// Plan 15, B0: the pin at the other two lengths of the A0 probe (0.19 and 0.762 m) is not saved in tests/golden (only 0.381 m and the short 0.06 m pin are). The A0 note
// (docs/spike/axial-plate-probe.md) recorded the fuel-centre change of the end layer and of the peak layer against separate one-layer OFFBEAT runs: +4.23 / -1.39 K, +1.06 / -0.35 K,
// +0.27 / -0.087 K. The probe's (r, z) solution gives the same quantity (coupled minus decoupled, same kernel) with no solver run.
const { solve2D, modelOfCase } = require("./axial2d.cjs");
const G = require("./golden.cjs");
const a0 = { 0.19: [4.23, -1.39], 0.381: [1.06, -0.35], 0.762: [0.27, -0.087] };
for (const L of [0.19, 0.381, 0.762]) {
  const c0 = G.readCase("offbeat-stack/cosine");
  const c = { ...c0, axial: { ...c0.axial, length: L } };
  const m = modelOfCase(c);
  const n = 26;
  for (const [label, v] of [["FEED kernel", { radial: "feed" }], ["OFFBEAT kernel", { radial: "offbeat", faceK: "arith", gapArea: "fuel" }]]) {
    const c2 = solve2D(m, { steady: true, ...v }).states[0].T;
    const c1 = solve2D(m, { steady: true, ...v, axial: false }).states[0].T;
    let peak = 0;
    for (let k = 0; k < 10; k++) if (c1[k * n] > c1[peak * n]) peak = k;
    console.log(`L = ${L} m, ${label}: end layer ${(c2[0] - c1[0]).toFixed(3)} K, peak layer (${peak + 1}) ${(c2[peak * n] - c1[peak * n]).toFixed(3)} K; A0 measured on the real solver ${a0[L][0]} / ${a0[L][1]}`);
  }
}
