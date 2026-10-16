// Mutation run for plan 13, milestone T3 (the particle's writer, results reader and dispatch).
// usage: node scripts/mut-triso-t3.cjs [stage] [name regex]     (stage: 1 (default) or 2 or 3 or all; commit first and keep a green baseline)
// Each mutant is [file, from, to, name]: `from` is a unique single-line anchor in `file`. The file is changed, the focus tests are run, and the file is restored from the copy read
// before (never from git, so uncommitted work is safe). A mutant is KILLED when the run exits non-zero AND prints a "Tests N ... " summary; it SURVIVES when the run exits 0; a run with
// no summary line is BROKEN (a crashed run must not count as a kill). Judge the result by the printed table.
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const FOCUS = ["tests/trisoWriter.test.ts", "tests/trisoResults.test.ts", "tests/triso.test.ts", "tests/trisoServer.test.ts", "tests/trisoSolve.test.ts"];
const W = "src/core/trisoWriter.ts";
const R = "src/core/trisoResults.ts";
const M = "src/core/runManager.ts";
const S = "src/server/server.ts";

const stage1 = [
  [W, "const HALF = (TRISO_WEDGE_HALF_ANGLE_DEG / 180) * Math.PI;", "const HALF = (TRISO_WEDGE_HALF_ANGLE_DEG / 90) * Math.PI;", "wedge angle doubled"],
  [W, "export const TRISO_WEDGE_SCALE = Math.cos(HALF) / S;", "export const TRISO_WEDGE_SCALE = Math.cos(HALF);", "scale without the 1/s"],
  [W, "export const TRISO_WEDGE_AREA_FRACTION = Math.sin(HALF) ** 2 / (Math.PI * S * S);", "export const TRISO_WEDGE_AREA_FRACTION = Math.sin(HALF) ** 2 / (Math.PI * S);", "area fraction formula"],
  [W, "const y = (rUm * Math.sin(HALF)) / S;", "const y = rUm * Math.sin(HALF);", "vertex y not on the sphere"],
  [W, "const x = (rUm * Math.cos(HALF)) / S;", "const x = rUm * Math.cos(HALF);", "vertex x not on the sphere"],
  [W, "const particlePower = n.power.kernelPowerDensity * kernelVolume;", "const particlePower = n.power.particlePower;", "equivalent sphere keeps the nominal power"],
  [W, "outerRadius: n.outerRadius * scale,", "outerRadius: n.outerRadius,", "equivalent sphere outer radius unscaled"],
  [W, "const levelsR = [radii[0]!, radii[1]!, radii[2]!, radii[2]!, ...radii.slice(3)];", "const levelsR = [radii[0]!, radii[1]!, radii[2]!, radii[3]!, ...radii.slice(3)];", "no coincident level for the gap"],
  [W, "const lower = (j: number) => (j === 0 ? 0 : j === 1 ? 1 : j + 1);", "const lower = (j: number) => (j === 0 ? 0 : j === 1 ? 1 : j);", "block level index"],
  [W, "return `    hex ( ${idx.join(\" \")} ) ${nm} (1 1 ${n.cells[j]}) simpleGrading (1 1 1)`;", "return `    hex ( ${idx.join(\" \")} ) ${nm} (1 1 ${n.cells[0]}) simpleGrading (1 1 1)`;", "every block gets the kernel's cell count"],
  [W, "${patch(TRISO_PATCHES.outer, \"patch\", face(last, 4, 5, 6, 7))}", "${patch(TRISO_PATCHES.outer, \"patch\", face(last, 0, 1, 2, 3))}", "outer patch on the inner face"],
  [W, "coupled(TRISO_PATCHES.gapOuter, true))}", "coupled(TRISO_PATCHES.gapOuter, false))}", "both gap patches not owners"],
  [W, "${patch(\"top\", \"wedge\", sides(0, 1, 5, 4))}", "${patch(\"top\", \"patch\", sides(0, 1, 5, 4))}", "top plane not a wedge"],
  [W, "${patch(TRISO_PATCHES.gapOuter, \"regionCoupledOFFBEAT\", face(ipycBase, 0, 1, 2, 3), coupled(TRISO_PATCHES.gapInner, false))}", "${patch(TRISO_PATCHES.gapOuter, \"regionCoupledOFFBEAT\", face(ipycBase, 4, 5, 6, 7), coupled(TRISO_PATCHES.gapInner, false))}", "next layer's gap face on its outer side"],
  [W, "timePoints  (0 ${num(tEnd)});", "timePoints  (0 ${num(endTime)});", "heat table ends at the end time"],
  [W, "const tEnd = 2 * endTime;", "const tEnd = endTime + 1;", "heat table barely past the end time"],
  [W, "vhgr        (${num(q)} ${num(q)});", "vhgr        (${num(q)} 0);", "heat falls to zero"],
  [W, "materials ( Kernel );", "materials ( Kernel Buffer );", "heat in the buffer too"],
  [W, "mechanicsSolver         fromLatestTime;", "mechanicsSolver         smallStrain;", "mechanics on"],
  [W, "fgr                     none;", "fgr                     SCIANTIX;", "fission gas code on"],
  [W, "gapGas                  none;", "gapGas                  TRISO;", "gas model on"],
  [W, "alpha           uniform ${num(n.gapConductance)};", "alpha           uniform 1;", "gap conductance not written"],
  [W, "type            resistiveGap;", "type            zeroGradient;", "gap is not a resistive gap"],
  [W, "T0 uniform ${num(n.boundary.bulkTemperature)};", "T0 uniform ${num(n.boundary.bulkTemperature + 1)};", "film's bulk temperature"],
  [W, "h uniform ${num(n.boundary.heatTransferCoefficient)};", "h uniform ${num(n.boundary.bulkTemperature)};", "film coefficient is the temperature"],
  [W, "\"system/controlDict\": controlDict(endTime),", "\"system/controlDict\": controlDict(endTime / 10),", "control dictionary ends early"],
  [W, "ipyc: \"IPyC\"", "ipyc: \"Ipyc\"", "zone name"],
  [W, "if (!h.ok) throw new Error(\"cannot write a steady particle case: \" + h.message);", "if (!h.ok) { /* no refusal */ }", "unsettled particle written"],
  [R, "export const TRISO_CLOSED_FORM_RISE_FRACTION = 0.005;", "export const TRISO_CLOSED_FORM_RISE_FRACTION = 0.5;", "closed-form floor loosened"],
  [R, "export const TRISO_FV_RISE_FRACTION = 0.003;", "export const TRISO_FV_RISE_FRACTION = 0.3;", "finite-volume tolerance loosened"],
  [R, "export const TRISO_BALANCE_TOLERANCE = 0.005;", "export const TRISO_BALANCE_TOLERANCE = 0.5;", "balance tolerance loosened"],
  [R, "export const TRISO_GAP_FRACTION = 0.01;", "export const TRISO_GAP_FRACTION = 1;", "gap tolerance loosened"],
  [R, "export const TRISO_WALL_TOLERANCE = 0.05; // K", "export const TRISO_WALL_TOLERANCE = 50; // K", "wall tolerance loosened"],
  [R, "export const TRISO_CLOSED_FORM_DISCRETISATION = 5;", "export const TRISO_CLOSED_FORM_DISCRETISATION = 5000;", "discretisation allowance loosened"],
  [R, "const radius = C.map((p) => Math.hypot(p[0]!, p[1]!, p[2]!));", "const radius = C.map((p) => Math.hypot(p[1]!, p[2]!));", "radius from the wrong components"],
  [R, "if (!(c.r > lo * (1 - 1e-9) && c.r < hi * (1 + 1e-9)))", "if (!(c.r > lo * (1 - 1e-9)))", "no upper bound for a cell's zone"],
  [R, "if (!(cells[i]!.r - cells[i - 1]!.r > 1e-12))", "if (false)", "distinct centres not checked"],
  [R, "const wall = patch(TRISO_PATCHES.outer);", "const wall = patch(TRISO_PATCHES.gapInner);", "wall read from the gap patch"],
  [R, "const gapMeasured = gapIn - gapOut;", "const gapMeasured = gapOut - gapIn;", "gap drop sign"],
  [R, "fvWorst = Math.max(fvWorst, Math.abs(c.T - fv.T[i]!));", "fvWorst = Math.max(fvWorst, Math.abs(c.T - c.T));", "finite-volume comparison void"],
  [R, "worst = Math.max(worst, Math.abs(c.T - closed.temperatureAt(Math.min(c.r, eq.outerRadius))));", "worst = Math.max(worst, Math.abs(c.T - closed.wallT));", "closed form read at the wall"],
  [R, "/ SPHERE.resist(a.r, b.r, 1);", "/ SPHERE.resist(a.r, b.r, 2);", "flux with the wrong conductivity factor"],
  [R, "const want = eq.power.particlePower;", "const want = n.power.particlePower;", "balance against the nominal power"],
  [R, "const bound = trisoTimeScale(n).tauBound * Math.abs(rate) * hottest;", "const bound = trisoTimeScale(n).tauBound * Math.abs(rate);", "steady-state bound without the temperature"],
  [R, "const hottest = Math.max(...T);", "const hottest = Math.min(...T);", "steady-state bound at the coldest cell"],
  [R, "(eq.power.kernelPowerDensity * kernelFirst.r ** 2) / 6)", "(eq.power.kernelPowerDensity * kernelFirst.r ** 2) / 3)", "kernel centre parabola"],
  [R, "return (gA * TA + gB * TB) / (gA + gB);", "return (TA + TB) / 2;", "interface temperature by the plain mean"],
  [R, "const innerFaceT = ri === 0 ? kernelCentre : ri === 2 ? gapOut : interfaces[ri - 1]!;", "const innerFaceT = ri === 0 ? kernelCentre : ri === 2 ? gapIn : interfaces[ri - 1]!;", "next layer's inner face from the wrong patch"],
  [R, "const outerFaceT = ri === names.length - 1 ? wall : ri === 1 ? gapIn : interfaces[ri]!;", "const outerFaceT = ri === names.length - 1 ? wall : ri === 1 ? gapOut : interfaces[ri]!;", "buffer's outer face from the wrong patch"],
  [R, "drop: innerFaceT - outerFaceT }", "drop: outerFaceT - innerFaceT }", "drop sign"],
  [R, "if (a.region === b.region) {", "if (true) {", "balance without two cells in the layer"],
  [R, "if (fvCentre > TRISO_CENTRE_TOLERANCE) bad(", "if (false) bad(", "mesh mismatch not detected"],
  [M, "const normalized: any = v.normalized ?? { kind: \"triso\", ...v.triso };", "const normalized: any = v.normalized ?? { ...v.triso };", "run not marked as a particle"],
  [M, "if (!v.normalized && !v.triso) return { ok: false, errors: unrunnableErrors(v) };", "if (!v.normalized) return { ok: false, errors: unrunnableErrors(v) };", "particle refused by the run manager"],
  [M, "const cellZones = read(join(nativeDir, \"final\", \"cellZones\"));", "const cellZones = read(join(nativeDir, \"final\", \"zones\"));", "zones read from the wrong file"],
  [M, "const tr = buildTrisoResults(normalized, { T, C, cellZones, time: exit.finalTime, drift: { relativeRate: lastRelativeRate(log) } });", "const tr = buildTrisoResults(normalized, { T, C, cellZones, time: exit.finalTime });", "no steady-state rate given"],
  [M, "r.headline = { centreCellT: tr.summary.kernelCentreCellT, claddingOuterWallT: tr.summary.wallT };", "r.headline = { centreCellT: tr.summary.kernelCentreT, claddingOuterWallT: tr.summary.wallT };", "headline from the extrapolated centre"],
  [S, "if (v.triso) return { ok: true, errors: v.errors,", "if (v.triso) return { ok: false, errors: v.errors,", "check rejects a valid particle"],
  [S, "if (a.normalized.kind === \"triso\" || b.normalized.kind === \"triso\")", "if (a.normalized.kind === \"triso\" && b.normalized.kind === \"triso\")", "compare of a particle with a pin allowed"],
  [S, "if (\"kind\" in d.results && d.results.kind === \"triso\") return void res.end(trisoResultsToCsv(d.results, meta));", "if (false) return void res.end(trisoResultsToCsv(d.results as any, meta));", "particle CSV not routed"],
  ["src/core/exportResults.ts", "for (const p of res.cells) lines.push(", "for (const p of res.cells.slice(1)) lines.push(", "CSV drops a cell"],
  ["src/core/validate.ts", "if (v.errors.length > 0 || v.normalized || v.triso) return v.errors;", "if (v.errors.length > 0 || v.normalized) return v.errors;", "unrunnable answer for a valid particle"],
  ["solver/run-feed.sh", "  cp constant/polyMesh/cellZones \"$OUT/final/\" 2>/dev/null", "  true", "cell zones not collected"],
];

const stages = { 1: stage1 };
try {
  Object.assign(stages, require("./mut-triso-t3-later.cjs"));
} catch (_) {
  /* later stages are added in their own file */
}
const which = process.argv[2] ?? "1";
const only = process.argv[3] ? new RegExp(process.argv[3]) : null; // optional: run only the mutants whose name matches (to re-run survivors)
const mutants = (which === "all" ? Object.values(stages).flat() : stages[which] || []).filter((m) => !only || only.test(m[3]));
if (!mutants.length) throw new Error("no mutants for stage " + which);

function runFocus() {
  const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...FOCUS], { cwd: root, encoding: "utf8", timeout: 300000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out) || /Tests\s+(\d+) failed/.exec(out);
  return { code: r.status, summary: m ? m[0] : null, out };
}

const base = runFocus();
console.log("baseline: exit " + base.code + ", " + base.summary);
if (base.code !== 0 || !base.summary) {
  console.log("ABORT: the baseline is not green");
  process.exit(2);
}
const rows = [];
for (const [file, from, to, name] of mutants) {
  const p = path.join(root, file);
  const original = fs.readFileSync(p, "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) {
    rows.push([name, "ANCHOR " + count, ""]);
    console.log("ANCHOR " + count + "  " + name);
    continue;
  }
  try {
    fs.writeFileSync(p, original.replace(from, () => to), "utf8");
    const r = runFocus();
    const verdict = !r.summary ? "BROKEN" : r.code === 0 ? "SURVIVED" : "killed";
    rows.push([name, verdict, r.summary || ""]);
    console.log(verdict.padEnd(9) + name + "   [" + (r.summary || "no summary") + "]");
  } finally {
    fs.writeFileSync(p, original, "utf8");
  }
}
const n = (v) => rows.filter((r) => r[1] === v).length;
console.log("\nmutants " + rows.length + ": killed " + n("killed") + ", survived " + n("SURVIVED") + ", broken " + n("BROKEN") + ", bad anchor " + rows.filter((r) => r[1].startsWith("ANCHOR")).length);
for (const r of rows.filter((x) => x[1] !== "killed")) console.log("  " + r[1] + ": " + r[0]);
