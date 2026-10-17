"use strict";
// Plan 15, B0, an option for B1/B2 found in the probe: a pin's finite-volume kernel (nodes at the cell middle, log conductance) is 3.4 K away from OFFBEAT in the fuel centre, a
// mesh effect that hides the 1.1 K axial effect at TRIGA length. The exact closed form of the slice evaluated AT OFFBEAT's reported cell centres (the volume centroids) is
// within about 0.01 K of the solver, apart from the axial effect. So the reference can be the exact closed form of each slice PLUS the finite-volume axial effect
// (the (r, z) solution minus the decoupled solution, both in the same kernel, which cancels the kernel's own mesh error):
//     T_ref(k, i) = T_closed_form(slice k, r_centroid(i)) + (T_2D(k, i) - T_1D(k, i))
//   node docs/spike/axial-2d-probe/hybrid.cjs
const path = require("path");
const D = path.join(__dirname, "..", "..", "..", "dist", "core");
const { sliceCase } = require(D + "/axial");
const { quickLook } = require(D + "/quickLook");
const CF = require(D + "/closedForm");
const { lawOf, solveHot } = require(D + "/conductivity");
const { geometryOf } = require(D + "/geometry");
const { solve2D, modelOfCase } = require("./axial2d.cjs");
const G = require("./golden.cjs");

function closedFormCells(c, sc) {
  // the same construction as finishResults (src/core/resultsParser.ts): cladding from the wall inwards, the gap, then the fuel law, at the cell centroids
  const geo = geometryOf(c.plate);
  const slab = !!c.plate;
  const kf = lawOf(c.fuelConductivity), kc = lawOf(c.claddingConductivity);
  const q = sc.qPrime;
  const nf = c.mesh.fuelCells, nc = c.mesh.claddingCells;
  const filmDrop = sc.boundary.kind === "convective" ? (slab ? q / sc.boundary.heatTransferCoefficient : CF.closedForm.filmDeltaT(q, c.claddingOuterRadius, sc.boundary.heatTransferCoefficient)) : 0;
  const tOuter = sc.boundary.kind === "convective" ? sc.boundary.bulkTemperature + filmDrop : sc.boundary.surfaceTemperature;
  const claddingAt = (r) => solveHot(kc, tOuter, slab ? q * (c.claddingOuterRadius - r) : (q * Math.log(c.claddingOuterRadius / r)) / (2 * Math.PI));
  const tCladInner = claddingAt(c.claddingInnerRadius);
  const tFuelSurface = tCladInner + (slab ? q / c.gapConductance : CF.closedForm.gapDeltaT(q, c.fuelRadius, c.gapConductance));
  const out = [];
  for (let i = 0; i < nf; i++) {
    const a = c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * i) / nf, b = c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * (i + 1)) / nf;
    out.push(CF.fuelTemperatureLaw(kf, q, c.fuelRadius, geo.centroid(a, b), tFuelSurface, c.fuelInnerRadius, slab));
  }
  for (let i = 0; i < nc; i++) {
    const a = c.claddingInnerRadius + ((c.claddingOuterRadius - c.claddingInnerRadius) * i) / nc, b = c.claddingInnerRadius + ((c.claddingOuterRadius - c.claddingInnerRadius) * (i + 1)) / nc;
    out.push(claddingAt(geo.centroid(a, b)));
  }
  return out;
}

console.log("run | max|OF - closed form| (the existing check) | max|OF - (2D FV)| | max|OF - hybrid| | gate ratio of the hybrid | gate ratio of the existing closed-form check with no allowance | where the hybrid's residual is largest");
for (const [name, dir] of G.STEADY) {
  const { c, T } = G.readSteady(dir);
  const N = c.axial.slices, nf = c.mesh.fuelCells, nc = c.mesh.claddingCells, n = nf + nc;
  const m = modelOfCase(c);
  const F2 = solve2D(m, { steady: true, radial: "feed" }).states[0].T;
  const F1 = solve2D(m, { steady: true, radial: "feed", axial: false }).states[0].T;
  let cfMax = 0, f2Max = 0, hyMax = 0, g = 0, gCF = 0, at = "";
  for (let k = 0; k < N; k++) {
    const sc = sliceCase(c, m.loads[k]);
    const cf = closedFormCells(c, sc);
    const t = quickLook(sc).temperatures;
    const bf = (5 * (t.centreT - t.fuelSurfaceT)) / (nf * nf), bc = (5 * (t.claddingInnerT - t.claddingOuterT)) / (nc * nc);
    for (let i = 0; i < n; i++) {
      const id = k * n + i;
      const dh = Math.abs(cf[i] + (F2[id] - F1[id]) - T[k][i]);
      cfMax = Math.max(cfMax, Math.abs(cf[i] - T[k][i]));
      f2Max = Math.max(f2Max, Math.abs(F2[id] - T[k][i]));
      if (dh > hyMax) { hyMax = dh; at = "layer " + (k + 1) + " cell " + i; }
      g = Math.max(g, dh / (i < nf ? bf : bc));
      gCF = Math.max(gCF, Math.abs(cf[i] - T[k][i]) / (i < nf ? bf : bc));
    }
  }
  console.log(`${name} | ${cfMax.toFixed(3)} | ${f2Max.toFixed(3)} | ${hyMax.toFixed(4)} | ${g.toFixed(4)} | ${gCF.toFixed(4)} | ${at}`);
}
