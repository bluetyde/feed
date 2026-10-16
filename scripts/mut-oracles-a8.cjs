// Mutation run for plan 12, milestone A8 (the SEED oracle entries of the axial stack and the plate): the generator's cosine and table shapes, the slice order, the plate's thickness, the
// allowance factor and the other terms of the tolerances, the lumped transient solution, the refusal codes.
// usage: node scripts/mut-oracles-a8.cjs [comma separated mutant numbers]      (commit first and keep a green baseline)
// Each mutant is [file, from, to, name]: `from` is a unique single-line anchor in `file`. For a mutant of the generator the mutated generator is RUN (it rewrites oracles/seed), then the
// focus tests are run against what it wrote (so the references worked out by hand in the tests, the saved real-solver output and the hashes of the 101 earlier files all see the mutated
// entries, not only the determinism test); the generator and oracles/seed are restored from copies read before (never from git, so uncommitted work is safe). A mutant is KILLED when
// the generator refuses it (its own guard) or the focus run exits non-zero AND prints a "Tests N ..." summary; it SURVIVES when the run exits 0; a run with no summary line is BROKEN.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const G = "scripts/gen-seed-oracles.cjs";
const FOCUS = ["tests/seedOracleStack.test.ts", "tests/seedOracleEntries.test.ts", "tests/seedOracleBoundaryHistory.test.ts", "tests/seedOracleMechanics.test.ts"];
const AX = "const AX = { factor: 3, cosineTable: 1e-3, exchangeFactor: 2 };";

const mutants = [
  [G, "(_, k) => (Math.PI / 2) * Math.cos(Math.PI * ((k + 0.5) / N - 0.5)));", "(_, k) => (2 / Math.PI) * Math.cos(Math.PI * ((k + 0.5) / N - 0.5)));", "cosine: normalised by 2/pi instead of pi/2"],
  [G, "Math.cos(Math.PI * ((k + 0.5) / N - 0.5)));", "Math.cos(Math.PI * (k / N - 0.5)));", "cosine: sampled at the slice bottoms, not the centres"],
  [G, "return Array.from({ length: N }, (_, k) => at((k + 0.5) / N) / integral);", "return Array.from({ length: N }, (_, k) => at(1 - (k + 0.5) / N) / integral);", "table shape read from the top"],
  [G, "integral += 0.5 * (points[i][1] + points[i - 1][1]) * (points[i][0] - points[i - 1][0]);", "integral += (points[i][1] + points[i - 1][1]) * (points[i][0] - points[i - 1][0]);", "table shape: integral doubled"],
  [G, "    const z = ((k + 0.5) * L) / N;\n    const sdoc", "    const z = ((N - k - 0.5) * L) / N;\n    const sdoc", "slice heights counted from the top"],
  [G, "Tb = linear(zs, b.map((p) => si(p.bulkTemperature)), z);", "Tb = linear(zs, b.map((p) => si(p.bulkTemperature)), L - z);", "coolant temperature read from the top"],
  [G, "sdoc.power.linearHeatRate = qty(avg * f, \"W/m\");", "sdoc.power.linearHeatRate = qty(avg * f * f, \"W/m\");", "slice heat rate with the factor squared"],
  [G, "doc.power.linearHeatRate = qty(o.avgKW, \"kW/m\");", "doc.power.linearHeatRate = qty(o.avgKW * 1.1, \"kW/m\");", "average heat rate 10 % high"],
  [G, "doc.axial = { length: qty(o.length, \"m\"), slices: o.slices, powerShape: o.shape };", "doc.axial = { length: qty(o.length, \"m\"), slices: o.slices + 1, powerShape: o.shape };", "one slice too many in the case"],
  [G, "coolant: [[0, 573, 30000], [0.381, 873, 30000]],", "coolant: [[0, 573, 30000], [0.381, 773, 30000]],", "coolant warming 200 K instead of 300 K"],
  // the plate
  [G, "const centre = hotSideK(fk, fuelSurface, (q * L) / 2);", "const centre = hotSideK(fk, fuelSurface, q * L);", "plate: the full thickness for the half-thickness"],
  [G, "const cladInner = hotSideK(ck, wall, q * t);", "const cladInner = hotSideK(ck, wall, q * 2 * t);", "plate: cladding thickness doubled"],
  [G, "const fuelSurface = cladInner + q / si(doc.gap.conductance);", "const fuelSurface = cladInner + q / (2 * si(doc.gap.conductance));", "plate: gap drop halved"],
  [G, "const wall = doc.boundary.surfaceTemperature ? si(doc.boundary.surfaceTemperature) : si(doc.boundary.bulkTemperature) + q / si(doc.boundary.heatTransferCoefficient);", "const wall = doc.boundary.surfaceTemperature ? si(doc.boundary.surfaceTemperature) : si(doc.boundary.bulkTemperature) + q / (2 * si(doc.boundary.heatTransferCoefficient));", "plate: film drop halved"],
  // the choice of slices
  [G, "const hot = st.slices.reduce((m, s) => (s.centre > m.centre ? s : m));", "const hot = st.slices.reduce((m, s) => (s.centre < m.centre ? s : m));", "the hottest slice taken as the coolest"],
  [G, "const coldI = st.slices.reduce((m, s, i) => (s.centre < st.slices[m].centre ? i : m), 0);", "const coldI = st.slices.reduce((m, s, i) => (s.centre > st.slices[m].centre ? i : m), 0);", "the coolest slice taken as the hottest"],
  [G, "add(\"axial_hottest_slice\", hotI,", "add(\"axial_hottest_slice\", hotI + 1,", "index counted from 1"],
  [G, "round(st.slices[coldI].centre, 4), \"K\", { abs: tolCold.total, rel: 0 }", "round(st.slices[coldI].centre, 4), \"K\", { abs: tolHot.total, rel: 0 }", "coolest slice given the hottest slice's tolerance"],
  // the tolerance terms
  [G, AX, "const AX = { factor: 2, cosineTable: 1e-3, exchangeFactor: 2 };", "allowance factor 2 instead of 3"],
  [G, AX, "const AX = { factor: 3, cosineTable: 5e-4, exchangeFactor: 2 };", "cosine table term halved"],
  [G, AX, "const AX = { factor: 3, cosineTable: 1e-3, exchangeFactor: 1 };", "exchange factor 1 instead of 2"],
  [G, "const allow = AX.factor * est.fraction * peakRise;", "const allow = AX.factor * est.fraction * (peakRise / 2);", "allowance on half the rise"],
  [G, "const peakRise = Math.max(...st.slices.map((x) => x.rise));\n  const mesh", "const peakRise = Math.min(...st.slices.map((x) => x.rise));\n  const mesh", "allowance on the smallest rise"],
  [G, "const mesh = (5 * s.fuelRise) / (MESH.fuelCells * MESH.fuelCells);", "const mesh = (5 * s.fuelRise) / MESH.fuelCells;", "mesh term: N not squared"],
  [G, "const table = cosine ? AX.cosineTable * s.rise : 0;", "const table = 0;", "no table term for a cosine"],
  [G, "const ceil005 = (x) => Number(Math.max(0.05, Math.ceil(x / 0.05 - 1e-9) * 0.05).toFixed(2));", "const ceil005 = (x) => Number(Math.max(0.05, Math.floor(x / 0.05 - 1e-9) * 0.05).toFixed(2));", "tolerance rounded down, not up"],
  [G, "const U = hot.q / hot.rise;", "const U = hot.q / (2 * hot.rise);", "estimate: conductance to the coolant halved"],
  [G, "const kA = constantK(doc.materials.fuel.sets) * Af + constantK(doc.materials.cladding.sets) * Ac;", "const kA = constantK(doc.materials.fuel.sets) * Af;", "estimate: cladding left out of kA"],
  [G, "const h = st.L / st.N;\n  let curvature", "const h = st.L;\n  let curvature", "estimate: slice height taken as the whole length"],
  [G, "curvature = Math.max(curvature, Math.abs(v[i + 1] - 2 * v[i] + v[i - 1]) / (h * h) / top);", "curvature = Math.max(curvature, Math.abs(v[i + 1] - 2 * v[i] + v[i - 1]) / h / top);", "estimate: curvature with the slice height not squared"],
  // the lumped transient stacks
  [G, "      T += (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);", "      T += (dt / 6) * (k1 + 2 * k2 + 2 * k3);", "lumped RK4 without the last stage"],
  [G, "C = STACK_T.c * (si(doc.geometry.fuelHalfThickness) + si(doc.geometry.claddingThickness));", "C = STACK_T.c * si(doc.geometry.fuelHalfThickness);", "lumped plate: heat capacity without the cladding"],
  [G, "let T = H[0].Tb + q / (H[0].h * A);", "let T = H[0].Tb + q / (2 * H[0].h * A);", "lumped start at half the steady film drop"],
  [G, "const rate = kA / (C * (L / N) ** 2);", "const rate = kA / (C * (L / N));", "exchange rate: slice height not squared"],
  [G, "const t1 = 0.01 * rise;", "const t1 = 0.02 * rise;", "transient tolerance: 2 % of the rise"],
  [G, "const t2 = AX.exchangeFactor * lump.bounds[hotI];", "const t2 = AX.exchangeFactor * lump.bounds[0];", "exchange bound of the end slice"],
  [G, "? qPeak * (si(doc.geometry.fuelHalfThickness) / (2 * STACK_T.k) + 1 / 1e6 + si(doc.geometry.claddingThickness) / STACK_T.k)", "? qPeak * (si(doc.geometry.fuelHalfThickness) / (2 * STACK_T.k) + si(doc.geometry.claddingThickness) / STACK_T.k)", "internal rise without the gap"],
  [G, "const tol = ceil005(t1 + t2 + internal);", "const tol = ceil005(t1 + t2);", "transient tolerance without the internal rise"],
  // the guards of the generator (expected to be equivalent: no case trips them)
  [G, "if (!(gap > 2 * tolMax)) throw", "if (false) throw", "guard on the hottest slice's lead removed"],
  [G, "if (!(exchangeNumber <= 1)) throw", "if (false) throw", "guard on the exchange number removed"],
  [G, "{ file: \"plate-with-a-hole\", code: \"E_GEOMETRY\"", "{ file: \"plate-with-a-hole\", code: \"E_UNSUPPORTED\"", "a refusal entry with the wrong code"],
];

function run(cmd, args, timeout) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function runFocus() {
  const r = run(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...FOCUS], 600000);
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(r.out) || /Tests\s+(\d+) failed/.exec(r.out);
  return { code: r.code, summary: m ? m[0] : null, out: r.out };
}

const seed = path.join(root, "oracles", "seed");
const backup = path.join(root, "oracles", ".seed-backup-mut");
fs.rmSync(backup, { recursive: true, force: true });
fs.cpSync(seed, backup, { recursive: true });
const only = process.argv[2] ? new Set(process.argv[2].split(",").map(Number)) : undefined;
const base = runFocus();
console.log("baseline: exit " + base.code + ", " + base.summary);
if (base.code !== 0 || !base.summary) {
  console.log("ABORT: the baseline is not green");
  fs.rmSync(backup, { recursive: true, force: true });
  process.exit(2);
}
const rows = [];
mutants.forEach(([file, from, to, name], i) => {
  if (only && !only.has(i)) return;
  const p = path.join(root, file);
  const original = fs.readFileSync(p, "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) {
    rows.push([name, "ANCHOR " + count, ""]);
    console.log("ANCHOR " + count + "  #" + i + " " + name);
    return;
  }
  try {
    fs.writeFileSync(p, original.replace(from, () => to), "utf8");
    const gen = run(process.execPath, [p], 120000);
    let verdict;
    let summary = "";
    if (gen.code !== 0) {
      verdict = "killed";
      summary = "the generator refused: " + (/Error: (.*)/.exec(gen.out) || [, gen.out.slice(0, 120)])[1].slice(0, 110);
    } else {
      const r = runFocus();
      verdict = !r.summary ? "BROKEN" : r.code === 0 ? "SURVIVED" : "killed";
      summary = r.summary || "no summary";
    }
    rows.push([name, verdict, summary]);
    console.log(verdict.padEnd(9) + "#" + i + " " + name + "   [" + summary + "]");
  } finally {
    fs.writeFileSync(p, original, "utf8");
    fs.rmSync(seed, { recursive: true, force: true });
    fs.cpSync(backup, seed, { recursive: true });
  }
});
fs.rmSync(backup, { recursive: true, force: true });
const n = (v) => rows.filter((r) => r[1] === v).length;
console.log("\nmutants " + rows.length + ": killed " + n("killed") + ", survived " + n("SURVIVED") + ", broken " + n("BROKEN") + ", bad anchor " + rows.filter((r) => r[1].startsWith("ANCHOR")).length);
for (const r of rows.filter((x) => x[1] !== "killed")) console.log("  " + r[1] + ": " + r[0]);
