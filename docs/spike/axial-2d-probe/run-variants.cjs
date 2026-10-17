"use strict";
// Plan 15, B0: which discretisation choices matter? Each variant of the probe solver against the saved OFFBEAT field (max |difference| over all cells and walls, K).
//   node docs/spike/axial-2d-probe/run-variants.cjs
const path = require("path");
const D = path.join(__dirname, "..", "..", "..", "dist", "core");
const { solve2D, modelOfCase } = require("./axial2d.cjs");
const G = require("./golden.cjs");

const variants = [
  ["OFFBEAT kernel (centroid nodes, linear conductance, gap on the fuel face), arithmetic face k, power at the layer centre", { radial: "offbeat", faceK: "arith", gapArea: "fuel" }, {}],
  ["  same, harmonic face k", { radial: "offbeat", faceK: "harmonic", gapArea: "fuel" }, {}],
  ["  same, gap conductance on the CLADDING face", { radial: "offbeat", faceK: "arith", gapArea: "clad" }, {}],
  ["  same, power = layer average of the shape instead of the centre value", { radial: "offbeat", faceK: "arith", gapArea: "fuel" }, { powerSample: "average" }],
  ["  same, axial term removed (N one-dimensional solutions)", { radial: "offbeat", faceK: "arith", gapArea: "fuel", axial: false }, {}],
  ["FEED kernel (the plan's), harmonic face k, power at the layer centre", { radial: "feed", faceK: "harmonic" }, {}],
  ["  same, arithmetic face k", { radial: "feed", faceK: "arith" }, {}],
  ["  same, axial term removed (the existing one-dimensional reference)", { radial: "feed", axial: false }, {}],
];
const cases = [["pin steady cosine", "offbeat-stack/cosine"], ["pin steady short", "offbeat-stack/short"], ["pin steady rise", "offbeat-stack/rise"], ["plate steady steep", "offbeat-plate-stack/steep"], ["plate steady negative", "offbeat-plate-stack/negative"], ["plate steady short", "offbeat-plate-stack/short"]];
const rows = cases.map(([name, dir]) => {
  const { c, T, walls } = G.readSteady(dir);
  const n = c.mesh.fuelCells + c.mesh.claddingCells;
  return [name, variants.map(([, v, mo]) => {
    const st = solve2D(modelOfCase(c, mo), { steady: true, ...v }).states[0];
    let mx = 0;
    for (let k = 0; k < c.axial.slices; k++) {
      for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(st.T[k * n + i] - T[k][i]));
      mx = Math.max(mx, Math.abs(st.wall[k] - walls[k]));
    }
    return mx;
  })];
});
console.log("max |2D variant - OFFBEAT| (K), all cells and walls");
console.log(["variant", ...cases.map((c) => c[0])].join(" | "));
variants.forEach(([label], j) => console.log([label, ...rows.map((r) => r[1][j].toFixed(4))].join(" | ")));

// the face-conductivity choice with a temperature-dependent conductivity: no saved OFFBEAT run has one, so only the two variants against each other
console.log("\nfaceK with k(T) (no OFFBEAT run exists): harmonic vs arithmetic, max difference over all cells (K), against the case's rise");
for (const [name, dir] of [["pin steady cosine", "offbeat-stack/cosine"], ["pin steady short", "offbeat-stack/short"], ["plate steady steep", "offbeat-plate-stack/steep"]]) {
  let { c } = G.readSteady(dir);
  c = { ...c, fuelConductivity: { kind: "linear", a: 4.0, b: -0.0012, range: [300, 3000] }, claddingConductivity: { kind: "linear", a: 12, b: 0.004, range: [300, 3000] } };
  const m = modelOfCase(c);
  for (const radial of ["feed", "offbeat"]) {
    const a = solve2D(m, { steady: true, radial, faceK: "harmonic" }).states[0].T;
    const b = solve2D(m, { steady: true, radial, faceK: "arith" }).states[0].T;
    let mx = 0, rise = 0;
    for (let i = 0; i < a.length; i++) { mx = Math.max(mx, Math.abs(a[i] - b[i])); rise = Math.max(rise, a[i] - 573); }
    console.log(`${name} (${radial} kernel): max |harmonic - arithmetic| = ${mx.toExponential(2)} K of a rise of ${rise.toFixed(0)} K`);
  }
}
