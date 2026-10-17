"use strict";
// Plan 15, B0: the transient (r, z) probe solution against every saved transient stack run, cell by cell at every write time.
//   node docs/spike/axial-2d-probe/run-transient.cjs [json-out] [name-filter]
// The start is the one the run had: every slice at its own one-dimensional steady state (initialState of the slice), because that is the field the writer gave OFFBEAT.
const fs = require("fs");
const path = require("path");
const D = path.join(__dirname, "..", "..", "..", "dist", "core");
const { sliceCase } = require(D + "/axial");
const TR = require(D + "/transientResults");
const { solve2D, modelOfCase } = require("./axial2d.cjs");
const G = require("./golden.cjs");

const FOOTER = "// ************************************************************************* //";
const foamScalar = (values, wall) => `FoamFile\n{\n    class volScalarField;\n    object T;\n}\ninternalField   nonuniform List<scalar>\n${values.length}\n(\n${values.map(String).join("\n")}\n)\n;\n\nboundaryField\n{\n    cladOuter\n    {\n        type            fixedValue;\n        value           uniform ${wall};\n    }\n}\n\n${FOOTER}\n`;
const foamVector = (values) => `FoamFile\n{\n    class volVectorField;\n    object C;\n}\ninternalField   nonuniform List<vector>\n${values.length}\n(\n${values.map((v) => `(${v.join(" ")})`).join("\n")}\n)\n;\n\n${FOOTER}\n`;

const out = [];
const only = process.argv[3];
for (const [name, dir] of G.TRANSIENT) {
  if (only && !name.includes(only)) continue;
  const t0 = Date.now();
  const { c, C, fields, layers } = G.readTransient(dir);
  const N = c.axial.slices, nf = c.mesh.fuelCells, nc = c.mesh.claddingCells, n = nf + nc;
  const tr = c.transient;
  const m = modelOfCase(c);
  const init = new Float64Array(N * n);
  m.loads.forEach((l, k) => init.set(TR.initialState(sliceCase(c, l)).T, k * n));
  const o = { dt: tr.timeStep, steps: tr.steps, outputEvery: tr.steps / tr.outputs, initial: init };
  const solve = (variant) => solve2D(m, { ...o, ...variant });
  const tS = Date.now();
  const F2 = solve({ radial: "feed", axial: true });
  const tF2 = Date.now() - tS;
  const F1 = solve({ radial: "feed", axial: false });
  const O2 = solve({ radial: "offbeat", axial: true, faceK: "arith", gapArea: "fuel" });
  const O1 = solve({ radial: "offbeat", axial: false, faceK: "arith", gapArea: "fuel" });
  if (F2.states.length !== layers.length + 1) throw new Error("outputs " + F2.states.length + " vs " + (layers.length + 1));
  // the existing check, per slice, with no allowance: OFFBEAT against the one-dimensional independent solution (value and bound)
  const sets = m.loads.map((l) => TR.computeIndependent(sliceCase(c, l)));
  const Cvec = require(D + "/resultsParser").parseVectorField(C, "C");
  const fi = (k) => Array.from({ length: nf }, (_, i) => k * nf + i);
  const ci = (k) => Array.from({ length: nc }, (_, i) => N * nf + k * nc + i);
  const existing = m.loads.map((l, k) => {
    const sc = sliceCase(c, l);
    const fl = fields.map((f, j) => {
      const Tt = require(D + "/resultsParser").parseScalarField(f.text, "T");
      const walls = require(D + "/resultsParser").parsePatchValues(f.text, "cladOuter");
      return { time: f.time, T: foamScalar([...fi(k), ...ci(k)].map((i) => Tt[i]), walls.length === N ? walls[k] : walls[0]) };
    });
    const rec = TR.buildTransientResults(sc, { C: foamVector([...fi(k), ...ci(k)].map((i) => Cvec[i])), fields: fl }, sets[k], { field: 0, energy: 0 });
    const ck = rec.checks.find((x) => x.id === "crossCheckFv");
    return { value: ck.value, bound: parseFloat(/bound ([0-9.]+) K/.exec(ck.note)[1]) };
  });
  const perLayer = [];
  const all = { f2: [], f1: [], o2: [], effOF: [], effF: [], resid: [] };
  let gate = 0, gateAt = "";
  const stats = (d) => { let mx = 0, ss = 0; for (const x of d) { mx = Math.max(mx, Math.abs(x)); ss += x * x; } return { max: mx, rms: Math.sqrt(ss / Math.max(d.length, 1)) }; };
  for (let k = 0; k < N; k++) {
    const dF2 = [], dF1 = [], dO2 = [], effOF = [], effF = [], resid = [];
    for (let j = 1; j < F2.states.length; j++) {
      const of = layers[j - 1].T[k];
      for (let i = 0; i < n; i++) {
        const id = k * n + i;
        dF2.push(F2.states[j].T[id] - of[i]);
        dF1.push(F1.states[j].T[id] - of[i]);
        dO2.push(O2.states[j].T[id] - of[i]);
        const eo = of[i] - O1.states[j].T[id];
        const ef = F2.states[j].T[id] - F1.states[j].T[id];
        effOF.push(eo); effF.push(ef); resid.push(ef - eo);
      }
      // the outer wall counts as a cell, as in the existing cross-check
      dF2.push(F2.states[j].wall[k] - layers[j - 1].walls[k]);
      dF1.push(F1.states[j].wall[k] - layers[j - 1].walls[k]);
      dO2.push(O2.states[j].wall[k] - layers[j - 1].walls[k]);
    }
    const s2 = stats(dF2);
    const ratio = s2.max / existing[k].bound;
    if (ratio > gate) { gate = ratio; gateAt = "slice " + (k + 1); }
    perLayer.push({ layer: k + 1, f2: s2, f1: stats(dF1), o2: stats(dO2), eff: stats(effOF), effF: stats(effF), resid: stats(resid), existing: existing[k] });
    for (const [key, d] of [["f2", dF2], ["f1", dF1], ["o2", dO2], ["effOF", effOF], ["effF", effF], ["resid", resid]]) all[key].push(...d);
  }
  const s = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, stats(v)]));
  const last = F2.states[F2.states.length - 1];
  // conservation of the (r, z) probe solution over the whole run: deposited = stored + rejected
  const bal = (last.deposited - last.stored - last.rejected) / Math.max(Math.abs(last.deposited), Math.abs(last.stored), Math.abs(last.rejected));
  out.push({ name, N, L: c.axial.length, steps: tr.steps, dt: tr.timeStep, endTime: tr.endTime, s, gate, gateAt, balance: bal, exFvMax: Math.max(...existing.map((e) => e.value)), gate1D: Math.max(...existing.map((e) => e.value / e.bound)), exBoundMin: Math.min(...existing.map((e) => e.bound)), exBoundMax: Math.max(...existing.map((e) => e.bound)), msF2: tF2, wall: Date.now() - t0, perLayer });
  console.error(name, "done in", Date.now() - t0, "ms");
}
const f = (x, d = 3) => x.toFixed(d);
console.log("run | N L steps dt | max|OF-2D| rms | max|OF-1D| rms | existing 1D check: worst value / bound range | existing 1D check without allowance: max over slices of value / bound | gate = max over slices of (max|OF-2D| / that slice's no-allowance bound) | O-kernel 2D max | axial effect OF max / FEED-2D max / resid max | 2D balance | 2D solve ms");
for (const r of out) console.log(`${r.name} | ${r.N} ${r.L} ${r.steps} ${r.dt} | ${f(r.s.f2.max)} ${f(r.s.f2.rms)} | ${f(r.s.f1.max)} ${f(r.s.f1.rms)} | ${f(r.exFvMax)} / ${f(r.exBoundMin)}-${f(r.exBoundMax)} | ${f(r.gate1D, 3)} | ${f(r.gate, 3)} ${r.gateAt} | ${f(r.s.o2.max, 4)} | ${f(r.s.effOF.max)} / ${f(r.s.effF.max)} / ${f(r.s.resid.max)} | ${r.balance.toExponential(1)} | ${r.msF2}`);
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ out }, null, 1));
