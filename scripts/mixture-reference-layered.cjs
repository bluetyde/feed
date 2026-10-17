// Layered spheres in a simple cubic array, resolved by the same 3D finite-volume cell as scripts/mixture-reference.cjs: the test of the equivalent-sphere step of
// src/core/mixture.ts. Conductivities are in units of the matrix's. Writes tests/golden/mixture/layered.json.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const { solveCell, lattice, radiusFor } = require("./mixture-reference.cjs");

// radii as fractions of the outer radius, conductivities relative to the matrix
const DESIGNS = {
  twoLayer: { frac: [0.6, 1], k: [3, 0.4] },
  triso: { frac: [250 / 460, 350 / 460, 390 / 460, 425 / 460, 1], k: [0.3, 0.05, 0.4, 1.4, 0.4] },
};
const grids = [32, 64, 128];
if (process.argv[2] === "--job") {
  const j = JSON.parse(process.argv[3]);
  const R = radiusFor(j.phi, 1);
  const d = DESIGNS[j.design];
  const layers = d.frac.map((f, i) => ({ r: f * R, k: d.k[i] }));
  const keff = {};
  for (const N of grids) keff[N] = solveCell(lattice("SC"), layers, N).keff;
  process.send({ ...j, frac: d.frac, k: d.k, keff });
  process.exit(0);
} else {
  const jobs = [];
  for (const design of Object.keys(DESIGNS)) for (const phi of [0.1, 0.2, 0.3, 0.4]) jobs.push({ design, phi });
  const results = [];
  let left = jobs.length;
  for (const j of jobs) {
    const c = fork(__filename, ["--job", JSON.stringify(j)]);
    c.on("message", (m) => results.push(m));
    c.on("exit", () => {
      if (--left === 0) {
        results.sort((a, b) => a.design.localeCompare(b.design) || a.phi - b.phi);
        const dir = path.join(__dirname, "..", "tests", "golden", "mixture");
        fs.writeFileSync(path.join(dir, "layered.json"), JSON.stringify({ note: "Layered spheres, SC array, 3D finite volume (scripts/mixture-reference-layered.cjs); radii as fractions of the particle radius, conductivities in units of the matrix's.", grids, cases: results }) + String.fromCharCode(10));
        console.log("written", results.length);
      }
    });
  }
}
