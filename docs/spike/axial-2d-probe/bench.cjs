"use strict";
// Plan 15, B0: what does the probe solver cost on this machine? The largest case the work budget allows (cells x steps x slices <= 3e6, src/core/validate.ts MAX_TRANSIENT_WORK).
//   node docs/spike/axial-2d-probe/bench.cjs
const { solve2D, modelOfCase } = require("./axial2d.cjs");
const G = require("./golden.cjs");
const TR = require(require("path").join(__dirname, "..", "..", "..", "dist", "core") + "/transientResults");
const { sliceCase } = require(require("path").join(__dirname, "..", "..", "..", "dist", "core") + "/axial");

const withLaws = (c) => ({
  ...c,
  fuelConductivity: { kind: "linear", a: 4.0, b: -0.0012, range: [300, 3000] },
  claddingConductivity: { kind: "linear", a: 12, b: 0.004, range: [300, 3000] },
  fuelHeatCapacity: { kind: "linear", a: 2.5e6, b: 500, range: [300, 3000] },
  claddingHeatCapacity: { kind: "linear", a: 2.2e6, b: 300, range: [300, 3000] },
});
function bench(label, c, steps, dt, laws, cellFactor = 1, stepFactor = 1) {
  let cc = { ...G.readCase("offbeat-stack-transient/coastdown") };
  cc = { ...cc, axial: { ...cc.axial, slices: c.slices }, mesh: { fuelCells: 20 * cellFactor, claddingCells: 6 * cellFactor }, transient: { ...cc.transient, steps, timeStep: dt, endTime: steps * dt, outputs: 1 } };
  if (laws) cc = withLaws(cc);
  const m = modelOfCase(cc);
  const n = (20 + 6) * cellFactor;
  const init = new Float64Array(c.slices * n).fill(573);
  // a uniform start is enough for timing (the iteration count of the Picard loop is what laws change); the heat rate is the case's
  const t0 = process.hrtime.bigint();
  const c0 = process.cpuUsage();
  const r = solve2D(m, { dt: dt / stepFactor, steps: steps * stepFactor, outputEvery: steps * stepFactor, initial: init, radial: "feed" });
  const wall = Number(process.hrtime.bigint() - t0) / 1e9;
  const cu = process.cpuUsage(c0);
  const s = (cu.user + cu.system) / 1e6; // CPU seconds of this process: the machine is shared, wall time is contaminated
  const work = c.slices * n * steps * stepFactor;
  console.log(`${label}: ${c.slices} slices x ${n} cells = ${c.slices * n} unknowns, ${steps * stepFactor} steps: ${s.toFixed(2)} s CPU (${wall.toFixed(2)} s wall)  (${(1e6 * s / work).toFixed(2)} us per cell-step; cells x steps x slices = ${(work / 1e6).toFixed(2)}e6; final peak ${Math.max(...r.states[r.states.length - 1].T).toFixed(0)} K)`);
  return s;
}
console.log("-- the largest case under the budget, constant properties and k(T), c(T) (Picard)");
bench("typical stack        constant", { slices: 10 }, 1200, 0.05, false);
bench("typical stack        k(T),c(T)", { slices: 10 }, 1200, 0.05, true);
bench("largest, 50 slices   constant", { slices: 50 }, 2300, 0.05, false);
bench("largest, 50 slices   k(T),c(T)", { slices: 50 }, 2300, 0.05, true);
console.log("-- the independent runs FEED makes around the same-mesh run: doubled mesh (spatial error) and halved step (time error), 50 slices, k(T), c(T), 1/4 of the steps for time");
bench("doubled mesh, 50 slices, 575 steps (x4 for 2300)", { slices: 50 }, 575, 0.2, true, 2);
bench("half step, 50 slices, 1150 steps (x2 for 2300)", { slices: 50 }, 575, 0.2, true, 1, 2);
