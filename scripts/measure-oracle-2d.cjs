// Plan 15 B6: what the tolerances of the SEED oracle entries for stacks of PLATES would be with the two-dimensional reference instead of 3 times the axial estimate. Read-only:
// it writes nothing (no entry, no generator file, no golden). Run `npm run build` first; prints a JSON table for the plan record (docs/plans/15-axial-2d.md, B6).
//   node scripts/measure-oracle-2d.cjs
const { readFileSync, readdirSync, existsSync } = require("fs");
const { join } = require("path");
const root = join(__dirname, "..");
const core = (m) => require(join(root, "dist", "core", m));
const { axialSummary } = core("axial");
const { stackReference, stackTransientReference } = core("stackReference");
const { buildStackResults } = core("stackResults");
const { buildStackTransientResults, computeIndependentStack } = core("stackTransientResults");
const { buildResults } = core("resultsParser");

const entry = (id) => JSON.parse(readFileSync(join(root, "oracles", "seed", "entries", id + ".json"), "utf8"));
const golden = (name) => {
  const d = join(root, "tests", "golden", "seed-oracles", name);
  const n = JSON.parse(readFileSync(join(d, "normalized.json"), "utf8"));
  const times = existsSync(join(d, "times")) ? readdirSync(join(d, "times")).sort((a, b) => Number(a) - Number(b)) : [];
  return { n, C: readFileSync(join(d, "C"), "utf8"), T: existsSync(join(d, "T")) ? readFileSync(join(d, "T"), "utf8") : "", fields: times.map((t) => ({ time: Number(t), T: readFileSync(join(d, "times", t, "T"), "utf8") })) };
};
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const out = { steady: [], transient: [], plate: [] };

// ---- the steady stack of plates
{
  const x = golden("stack-cosine-plate");
  const n = x.n;
  const N = n.mesh.fuelCells;
  const sum = axialSummary(n);
  const rise = (k) => sum.slices[k].centreT - sum.slices[k].fuelSurfaceT;
  const ref = stackReference(n);
  if (!("reference" in ref)) throw new Error("no reference");
  const slices = n.axial.slices;
  const peaks2d = Array.from({ length: slices }, (_, k) => Math.max(...ref.reference.slice(k).fuel, ...ref.reference.slice(k).clad));
  const solver = buildStackResults(x.n, { T: x.T, C: x.C, time: 5e7 });
  const solverPeaks = solver.axial.slices.map((s) => s.maxT);
  const hot = peaks2d.indexOf(Math.max(...peaks2d));
  const low = peaks2d.indexOf(Math.min(...peaks2d));
  const mk = (id, quantity, cur, ref2d, solverV, meshRise) => {
    const e = entry(id);
    return { entry: id, quantity, expected: e.expected.value, currentTolerance: e.tolerance.abs, meshBound: meshRise === null ? 0 : 5 * meshRise / (N * N), reference2d: ref2d, solverMinusExpected: solverV - e.expected.value, solverMinus2d: solverV - ref2d };
  };
  out.steady.push(mk("feed-stack-cosine-plate-temperature-peak", "temperature_peak", null, Math.max(...peaks2d), solver.summary.maxT, rise(hot)));
  out.steady.push(mk("feed-stack-cosine-plate-temperature-peak-slice-min", "temperature_peak_slice_min", null, Math.min(...peaks2d), Math.min(...solverPeaks), rise(low)));
  const eh = entry("feed-stack-cosine-plate-axial-hottest-slice");
  out.steady.push({ entry: eh.oracleId, quantity: "axial_hottest_slice", expected: eh.expected.value, currentTolerance: 0, meshBound: 0, reference2d: hot, solverMinusExpected: solver.axial.hottest - eh.expected.value, solverMinus2d: solver.axial.hottest - hot });
  out.steadyDetail = { slices, N, riseHot: rise(hot), riseLow: rise(low), peaks2d: peaks2d.map(r4), solverPeaks: solverPeaks.map(r4), closedCentres: sum.slices.map((s) => r4(s.centreT)), estimateFraction: sum.conduction && sum.conduction.fraction, hottest2d: hot, hottestSolver: solver.axial.hottest };
}

// ---- the transient stack of plates (the loss of cooling against a lumped solution)
{
  const x = golden("stack-lumped-plate-loss-of-cooling");
  const sets = computeIndependentStack(x.n);
  const ref = stackTransientReference(x.n);
  if (!("reference" in ref)) throw new Error("no transient reference: " + ref.fallback);
  const rec = buildStackTransientResults(x.n, { C: x.C, fields: x.fields }, sets, ref);
  const old = buildStackTransientResults(x.n, { C: x.C, fields: x.fields }, sets, null);
  const sol = ref.reference.solution;
  const peak2d = Math.max(...sol.states.map((s) => Math.max(...s.T)));
  const solverPeak = Math.max(...rec.axial.slices.map((s) => s.maxT));
  const e = entry("feed-stack-lumped-plate-loss-of-cooling-temperature-peak-max");
  const cc = rec.checks.find((c) => c.id === "crossCheckFv");
  const start = Math.max(...sol.states[0].T);
  out.transient.push({
    entry: e.oracleId, quantity: "temperature_peak_max", expected: e.expected.value, currentTolerance: e.tolerance.abs, reference2d: peak2d, solverMinusExpected: solverPeak - e.expected.value, solverMinus2d: solverPeak - peak2d,
    riseOfRun: peak2d - start, crossCheckBoundOf2d: cc && cc.note, crossCheckValue2d: cc && cc.value, crossCheckAllowanceRecord: old.checks.find((c) => c.id === "crossCheckFv").value,
    failing: rec.checks.filter((c) => c.verdict === "fail").map((c) => c.id), axialConductionNote: rec.checks.find((c) => c.id === "axialConduction").note.slice(0, 600),
  });
}

// ---- the plate alone: no stack, no axial conduction, so nothing for a 2D reference to replace
{
  const x = golden("plate-steady");
  const r = buildResults(x.n, { T: x.T, C: x.C, time: 5e7, drift: { relativeRate: 1e-12 } });
  for (const [id, got] of [["feed-plate-steady-temperature-peak", r.summary.maxT], ["feed-plate-steady-temperature-surface", r.summary.claddingOuterWallT]]) {
    const e = entry(id);
    out.plate.push({ entry: id, expected: e.expected.value, currentTolerance: e.tolerance.abs, solverMinusExpected: got - e.expected.value });
  }
}
console.log(JSON.stringify(out, null, 1));
