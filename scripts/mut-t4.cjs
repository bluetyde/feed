// Mutation run for plan 13, milestone T4 (the mixture laws, the compact, the pebble and their dispatch).
// usage: node scripts/mut-t4.cjs [name regex]     (commit first and keep a green baseline)
// Each mutant is [file, from, to, name]: `from` is a unique single-line anchor in `file`. The file is changed, the focus tests are run, and the file is restored from the copy read
// before (never from git, so uncommitted work is safe). A mutant is KILLED when the run exits non-zero AND prints a "Tests N ... " summary; it SURVIVES when the run exits 0; a run with
// no summary line is BROKEN (a crashed run must not count as a kill). Judge the result by the printed table.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const FOCUS = ["tests/mixture.test.ts", "tests/compactPebble.test.ts", "tests/compactPebbleServer.test.ts", "tests/validate.test.ts"];
const MX = "src/core/mixture.ts";
const CP = "src/core/compact.ts";
const PB = "src/core/pebble.ts";
const PW = "src/core/pebbleWriter.ts";
const PR = "src/core/pebbleResults.ts";
const V = "src/core/validate.ts";
const M = "src/core/runManager.ts";
const S = "src/server/server.ts";

const mutants = [
  [MX, "return (km * (kp + 2 * km + 2 * phi * d)) / (kp + 2 * km - phi * d);", "return (km * (kp + 2 * km + 2 * phi * d)) / (kp + 2 * km + phi * d);", "Maxwell-Eucken denominator sign"],
  [MX, "const d = kp - km;", "const d = km - kp;", "Maxwell-Eucken contrast reversed"],
  [MX, "const b = -((3 * phi - 1) * kp + (2 - 3 * phi) * km);", "const b = -((3 * phi - 1) * km + (2 - 3 * phi) * kp);", "Bruggeman terms swapped"],
  [MX, "return (-b + Math.sqrt(b * b - 8 * c)) / 4;", "return (-b + Math.sqrt(b * b - 8 * c)) / 2;", "Bruggeman root scale"],
  [MX, "const f = (k: number) => ((kp - k) / (kp - km)) * Math.cbrt(km / k) - (1 - phi);", "const f = (k: number) => ((kp - k) / (kp - km)) * Math.cbrt(km / k) - phi;", "differential law right side"],
  [MX, "const f = (k: number) => ((kp - k) / (kp - km)) * Math.cbrt(km / k) - (1 - phi);", "const f = (k: number) => ((kp - k) / (kp - km)) * Math.cbrt(k / km) - (1 - phi);", "differential law cube root inverted"],
  [MX, "if (kp === km || phi === 0) return km;", "if (kp === km) return km;", "differential law at no spheres"],
  [MX, "const Tn = h === undefined ? T : T + q / h;", "const Tn = h === undefined ? T : T - q / h;", "gap jump sign"],
  [MX, "const Bn = ((Tn - (q * r) / kn) * r * r) / 3;", "const Bn = ((Tn - (q * r) / kn) * r * r) / 2;", "next region's dipole coefficient"],
  [MX, "const An = q / kn + (2 * Bn) / r ** 3;", "const An = q / kn + Bn / r ** 3;", "next region's uniform coefficient"],
  [MX, "return (k[k.length - 1]! * (A - (2 * B) / b ** 3)) / (A + B / b ** 3);", "return (k[k.length - 1]! * (A - (2 * B) / b ** 3)) / (A + (2 * B) / b ** 3);", "equivalent conductivity denominator"],
  [MX, "const T = A * r + B / (r * r);", "const T = A * r + B / r;", "temperature at the face"],
  [CP, "const gaps: (number | undefined)[] = radii.map((_, i) => (i === 1 ? p.gapConductance : undefined));", "const gaps: (number | undefined)[] = radii.map((_, i) => (i === 0 ? p.gapConductance : undefined));", "gap at the kernel's face"],
  [CP, "const k = [evaluate(lawOf(p.kernelConductivity), T), ...p.layers.map((l) => evaluate(lawOf(l.conductivity), T))];", "const k = [evaluate(lawOf(p.kernelConductivity), 300), ...p.layers.map((l) => evaluate(lawOf(l.conductivity), T))];", "kernel conductivity at a fixed temperature"],
  [CP, "return mixtureConductivity(s.law, particleEquivalentK(s.particle, T), evaluate(lawOf(s.matrixConductivity), T), s.packingFraction);", "return mixtureConductivity(s.law, particleEquivalentK(s.particle, T), evaluate(lawOf(s.matrixConductivity), T), 1 - s.packingFraction);", "packing fraction complemented"],
  [CP, "return mixtureConductivity(s.law, particleEquivalentK(s.particle, T), evaluate(lawOf(s.matrixConductivity), T), s.packingFraction);", "return mixtureConductivity(s.law, evaluate(lawOf(s.matrixConductivity), T), particleEquivalentK(s.particle, T), s.packingFraction);", "particle and matrix swapped"],
  [CP, "const T = lo + ((hi - lo) * i) / (n - 1);", "const T = lo + ((hi - lo) * i) / n;", "table does not reach the top of the range"],
  [CP, "return particleOuterRadius / Math.cbrt(packingFraction);", "return particleOuterRadius / packingFraction;", "cell radius without the cube root"],
  [CP, "const h = 1 / (shellResistance * SPHERE.area(p.outerRadius));", "const h = 1 / (shellResistance * SPHERE.area(b));", "film coefficient on the cell's area"],
  [CP, "const kMatrix = evaluate(lawOf(s.matrixConductivity), matrixT);", "const kMatrix = evaluate(lawOf(s.matrixConductivity), 300);", "matrix conductivity at a fixed temperature"],
  [CP, "const shellResistance = SPHERE.resist(p.outerRadius, b, kMatrix);", "const shellResistance = SPHERE.resist(p.outerRadius, b, kMatrix) * 2;", "shell resistance doubled"],
  [CP, "const particlePower = (pd * vols.particleVolume) / phi;", "const particlePower = (pd * vols.kernelVolume) / phi;", "packing arithmetic on the kernel's volume"],
  [CP, "particlePower, particlesPerM3: phi / vols.particleVolume,", "particlePower, particlesPerM3: phi / vols.kernelVolume,", "particles per cubic metre from the kernel's volume"],
  [CP, "} else if (phi > PACKING_RANDOM) {", "} else if (phi > 1) {", "random close packing not warned"],
  [CP, "} else if (phi > PACKING_MAX) {", "} else if (phi > 1) {", "denser than any packing accepted"],
  [CP, "if (s.packingFraction > D.packingMax) why.push(", "if (s.packingFraction > 0.9) why.push(", "domain's packing limit"],
  [CP, "else if (hi > D.contrastMax && s.packingFraction > D.packingMaxHighContrast) why.push(", "else if (hi > D.contrastMax || s.packingFraction > D.packingMaxHighContrast) why.push(", "high-contrast rule on either"],
  [CP, "if (lo < D.contrastMin) why.push(", "if (lo > D.contrastMin) why.push(", "low-contrast rule inverted"],
  [CP, "if (hi > D.contrastCap) why.push(", "if (hi > 1e9) why.push(", "contrast cap"],
  [CP, "const hot = cells.reduce((m, c) => (c.T > m.T ? c : m), cells[0]!);", "const hot = cells.reduce((m, c) => (c.T < m.T ? c : m), cells[0]!);", "coldest cell taken as the hottest"],
  [CP, "matrixTI = independentAt(radii.inner); // the hottest point", "matrixTI = independentAt(radii.outer); // the hottest point", "hottest point of the closed form at the surface"],
  [CP, "const meanSolver = cells.reduce((s, c, i) => s + c.T * area[i]!, 0) / totalArea;", "const meanSolver = cells.reduce((s, c) => s + c.T, 0) / cells.length;", "mean not weighted by area"],
  [CP, "const w = i === 0 || i === M ? 1 : i % 2 === 1 ? 4 : 2;", "const w = i === 0 || i === M ? 1 : i % 2 === 1 ? 2 : 4;", "Simpson weights"],
  [CP, "const bound = (COMPACT_MATRIX_DISCRETISATION * rise) / (N * N) + floor;", "const bound = (COMPACT_MATRIX_DISCRETISATION * rise * 1000) / (N * N) + floor;", "matrix temperature bound loosened"],
  [CP, "verdict: dMatrix <= bound ? (\"pass\" as const) : (\"fail\" as const),", "verdict: dMatrix >= bound ? (\"pass\" as const) : (\"fail\" as const),", "matrix temperature verdict inverted"],
  [CP, "else if (!(lo > 0) || !(hi > lo)) bad(", "else if (false) bad(", "range not checked"],
  [CP, "if (r && (r[0] > range![0] || r[1] < range![1])) {", "if (r && (r[0] > range![0])) {", "upper end of a law's range not compared"],
  [CP, "verdict: msg ? \"na\" : \"pass\",", "verdict: msg ? \"pass\" : \"na\",", "domain verdict inverted"],
  [CP, "if (raw !== DEFAULT_MIXTURE_LAW) warn(", "if (false) warn(", "other law not warned"],
  [CP, "tolerance: { value: s.fit.tolerance, unit: \"1\" } },", "tolerance: { value: 0.5, unit: \"1\" } },", "fit tolerance not passed on"],
  [CP, "fit: { degree: s.fit.degree,", "fit: { degree: 1,", "fit degree not passed on"],
  [PB, "const filmDeltaT = p.boundary.kind === \"convective\" ? P / (SPHERE.area(p.outerRadius) * p.boundary.heatTransferCoefficient) : 0;", "const filmDeltaT = p.boundary.kind === \"convective\" ? P / (SPHERE.area(p.fuelledRadius) * p.boundary.heatTransferCoefficient) : 0;", "film on the fuelled zone's area"],
  [PB, "const interfaceT = solveHot(kShell, wallT, (P / (4 * Math.PI)) * (1 / p.fuelledRadius - 1 / p.outerRadius));", "const interfaceT = solveHot(kShell, wallT, P * (1 / p.fuelledRadius - 1 / p.outerRadius));", "shell drop without 4 pi"],
  [PB, "const fuelAt = (r: number) => solveHot(kFuel, interfaceT, (q * (p.fuelledRadius ** 2 - r * r)) / 6);", "const fuelAt = (r: number) => solveHot(kFuel, interfaceT, (q * (p.fuelledRadius ** 2 - r * r)) / 4);", "fuelled zone's parabola"],
  [PB, "cells: [...p.cells],", "cells: [p.cells[1], p.cells[0]],", "cells swapped in the model"],
  [PB, "outerRadius: p.outerRadius * scale, power:", "outerRadius: p.outerRadius, power:", "wedge sphere's outer radius unscaled"],
  [PB, "const kFace = (d2 * k1 + d1 * k2) / (d1 + d2);", "const kFace = (d1 * k1 + d2 * k2) / (d1 + d2);", "face conductivity weights"],
  [PB, "const bias = Math.abs(q * ((d1 + d2) / kFace - d1 / k1 - d2 / k2));", "const bias = Math.abs(q * ((d1 + d2) / kFace));", "bias without the exact resistances"],
  [PB, "const d1 = p.fuelledRadius / p.cells[0] / 2;", "const d1 = p.fuelledRadius / p.cells[0];", "half cell of the fuelled zone"],
  [PW, "materials ( ${PEBBLE_ZONE.fuelled} );", "materials ( ${PEBBLE_ZONE.fuelled} ${PEBBLE_ZONE.shell} );", "heat in the shell too"],
  [PW, "vhgr        (${num(q)} ${num(q)});", "vhgr        (${num(q)} 0);", "heat falls to zero"],
  [PW, "timePoints  (0 ${num(2 * endTime)});", "timePoints  (0 ${num(endTime)});", "heat table ends at the end time"],
  [PW, "${patch(PEBBLE_PATCH.outer, \"patch\", face(4, 4, 5, 6, 7))}", "${patch(PEBBLE_PATCH.outer, \"patch\", face(4, 0, 1, 2, 3))}", "outside on the interface"],
  [PW, "const radii = [0, p.fuelledRadius, p.outerRadius];", "const radii = [0, p.fuelledRadius * 0.9, p.outerRadius];", "fuelled radius in the mesh"],
  [PW, "(1 1 ${p.cells[j]}) simpleGrading", "(1 1 ${p.cells[0]}) simpleGrading", "every block gets the fuelled zone's cells"],
  [PW, "\"system/controlDict\": controlDict(endTime),", "\"system/controlDict\": controlDict(endTime / 10),", "control dictionary ends early"],
  [PW, "T0 uniform ${num(p.boundary.bulkTemperature)};", "T0 uniform ${num(p.boundary.bulkTemperature + 1)};", "film's bulk temperature"],
  [PW, "h uniform ${num(p.boundary.heatTransferCoefficient)};", "h uniform ${num(p.boundary.bulkTemperature)};", "film coefficient is the temperature"],
  [PW, "mechanicsSolver         fromLatestTime;", "mechanicsSolver         smallStrain;", "mechanics on"],
  [PW, "const q = p.power.powerDensity;", "const q = p.power.fuelledPower;", "heat as watts, not watts per cubic metre"],
  [PR, "export const PEBBLE_CLOSED_FORM_RISE_FRACTION = 0.005;", "export const PEBBLE_CLOSED_FORM_RISE_FRACTION = 0.5;", "closed-form floor loosened"],
  [PR, "export const PEBBLE_FV_RISE_FRACTION = 0.003;", "export const PEBBLE_FV_RISE_FRACTION = 0.3;", "finite-volume tolerance loosened"],
  [PR, "export const PEBBLE_BALANCE_TOLERANCE = 0.005;", "export const PEBBLE_BALANCE_TOLERANCE = 0.5;", "balance tolerance loosened"],
  [PR, "export const PEBBLE_WALL_TOLERANCE = 0.05; // K", "export const PEBBLE_WALL_TOLERANCE = 50; // K", "wall tolerance loosened"],
  [PR, "export const PEBBLE_CLOSED_FORM_DISCRETISATION = 5;", "export const PEBBLE_CLOSED_FORM_DISCRETISATION = 5000;", "discretisation allowance loosened"],
  [PR, "const want = eq.power.fuelledPower;", "const want = p.power.fuelledPower;", "balance against the nominal power"],
  [PR, "const Q = (primitive(laws[1]!, a.T) - primitive(laws[1]!, b.T)) / SPHERE.resist(a.r, b.r, 1);", "const Q = (primitive(laws[0]!, a.T) - primitive(laws[0]!, b.T)) / SPHERE.resist(a.r, b.r, 1);", "balance with the fuelled zone's conductivity"],
  [PR, "const interfaceT = (gA * a.T + gB * b.T) / (gA + gB);", "const interfaceT = (a.T + b.T) / 2;", "interface temperature by the plain mean"],
  [PR, "const centre = solveHot(laws[0]!, first.T, (eq.power.powerDensity * first.r ** 2) / 6);", "const centre = solveHot(laws[0]!, first.T, (eq.power.powerDensity * first.r ** 2) / 3);", "centre parabola"],
  [PR, "(typeof x === \"number\" ? x * TRISO_WEDGE_SCALE : x)", "(typeof x === \"number\" ? x : x)", "radius not scaled to the wedge"],
  [PR, "if (fvCentre > PEBBLE_CENTRE_TOLERANCE) bad(", "if (false) bad(", "mesh mismatch not detected"],
  [PR, "if (!(r > bounds[ri]! * (1 - 1e-9) && r < bounds[ri + 1]! * (1 + 1e-9)))", "if (!(r > bounds[ri]! * (1 - 1e-9)))", "no upper bound for a cell's zone"],
  [PR, "if (lo < r[0] || hi > r[1]) findings.push({ region: nm,", "if (lo < r[0]) findings.push({ region: nm,", "upper end of a law's range not compared"],
  [PR, "const wallV = parsePatchValue(input.T, PEBBLE_PATCH.outer);", "const wallV = parsePatchValue(input.T, \"top\");", "wall read from another patch"],
  [PR, "if (!(radius[order[i]!]! - radius[order[i - 1]!]! > 1e-12))", "if (false)", "distinct centres not checked"],
  [PR, "const bound = pebbleTimeScale(p).tauBound * Math.abs(rate) * hottest;", "const bound = pebbleTimeScale(p).tauBound * Math.abs(rate);", "steady-state bound without the temperature"],
  [V, "const qPrime = Rf !== undefined && Ri !== undefined && Rf > Ri ? spec.powerDensity * Math.PI * (Rf * Rf - Ri * Ri) : 1;", "const qPrime = Rf !== undefined && Ri !== undefined && Rf > Ri ? spec.powerDensity * Math.PI * (Rf * Rf) : 1;", "hole's area not taken out"],
  [V, "if (c.materials?.fuel !== undefined) err(\"E_UNSUPPORTED\", \"/materials/fuel\"", "if (false) err(\"E_UNSUPPORTED\", \"/materials/fuel\"", "fuel material beside a compact accepted"],
  [V, "if (c.power !== undefined) err(\"E_UNSUPPORTED\", \"/power\", \"a compact's power", "if (false) err(\"E_UNSUPPORTED\", \"/power\", \"a compact's power", "power beside a compact accepted"],
  [V, "const mapField = (f: string) => (f.startsWith(\"/materials/fuel\") ? \"/compact/fit\"", "const mapField = (f: string) => (f.startsWith(\"/materials/fuelx\") ? \"/compact/fit\"", "fit errors not mapped to the compact block"],
  [V, "if (issues.some((i) => i.severity === \"error\")) return finish(issues);", "if (false) return finish(issues);", "refusals not returned at once"],
  [V, "if (c.gap?.model !== \"none\") err(\"E_UNSUPPORTED\", \"/gap/model\"", "if (false) err(\"E_UNSUPPORTED\", \"/gap/model\"", "a gap beside a pebble accepted"],
  [V, "if (Rf !== undefined && Ro !== undefined && !(Ro > Rf)) err(", "if (false) err(", "shell thickness not checked"],
  [V, "const fuelledVolume = (4 / 3) * Math.PI * Rf ** 3;", "const fuelledVolume = (4 / 3) * Math.PI * Ro ** 3;", "fuelled volume from the outer radius"],
  [V, "if (bias > 0.003 * rise && bias > 0.02) result.warnings.push(", "if (bias > 0.3 * rise && bias > 0.02) result.warnings.push(", "interface warning threshold"],
  [V, "[\"limits\", \"temperature limits for a pebble's regions are not offered in this release\"]", "[\"limitz\", \"temperature limits for a pebble's regions are not offered in this release\"]", "limits beside a pebble accepted"],
  [V, "for (const k of Object.keys(materials)) if (k !== \"shell\") err(", "for (const k of Object.keys(materials)) if (false) err(", "other materials beside a pebble accepted"],
  [V, "if (typeof p === \"number\" && Rf !== undefined && !(p >= 0 && p <= Rf)) err(", "if (false) err(", "two-scale radius outside the pebble accepted"],
  [V, "if (typeof p === \"number\" && Rf !== undefined && Ri !== undefined && !(p >= Ri && p <= Rf)) err(", "if (false) err(", "two-scale radius outside the compact accepted"],
  [M, "if (!v.normalized && !v.triso && !v.pebble) return { ok: false, errors: unrunnableErrors(v) };", "if (!v.normalized && !v.triso) return { ok: false, errors: unrunnableErrors(v) };", "pebble refused by the run manager"],
  [M, "{ kind: \"pebble\", ...v.pebble });", "{ ...v.pebble });", "run not marked as a pebble"],
  [M, "if (normalized.kind === \"pebble\") {", "if (normalized.kind === \"pebblex\") {", "pebble results not read"],
  [M, "r.headline = { centreCellT: pr.summary.centreCellT, claddingOuterWallT: pr.summary.wallT };", "r.headline = { centreCellT: pr.summary.centreT, claddingOuterWallT: pr.summary.wallT };", "headline from the extrapolated centre"],
  [S, "if (v.pebble) {", "if (false) {", "check does not answer for a pebble"],
  [S, "a.normalized.kind === \"pebble\" || b.normalized.kind === \"pebble\")", "a.normalized.kind === \"pebble\" && b.normalized.kind === \"pebble\")", "compare of a pebble with a pin allowed"],
  [S, "...(n.compact ? { compact: { spec: n.compact,", "...(false ? { compact: { spec: n.compact,", "check does not carry the compact"],
  [S, "if (\"kind\" in d.results && d.results.kind === \"pebble\") return void", "if (false) return void", "pebble CSV not routed"],
  ["src/core/exportResults.ts", "for (const e of res.compact.twoScale) lines.push(", "for (const e of res.compact.twoScale.slice(1)) lines.push(", "CSV drops a two-scale entry"],
  ["src/core/resultsParser.ts", "if (compactRecord) checks.push(...compactRecord.checks);", "if (compactRecord) checks.push();", "compact checks not added"],
  ["src/core/resultsParser.ts", "...(compactRecord ? { compact: compactRecord } : {}),", "...({}),", "compact record not returned"],
];

const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const todo = mutants.filter((m) => !only || only.test(m[3]));

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
for (const [file, from, to, name] of todo) {
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
