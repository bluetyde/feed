// Mutation run for plan 12, milestone A5 (a stack of plates: the validator's acceptance, the axial conduction estimate for a slab, the writer's plate paths, the result texts and the
// bound on the heat the slices of a transient stack exchange along the height).
// usage: node scripts/mut-plate-stack-a5.cjs      (commit first and keep a green baseline)
// Each mutant is [file, from, to, name]: `from` is a unique anchor (it may span lines) in `file`. The file is changed, the focus tests are run, and the file is restored from the copy read
// before (never from git, so uncommitted work is safe). A mutant is KILLED when the run exits non-zero AND prints a "Tests N ... " summary; it SURVIVES when the run exits 0; a run with
// no summary line is BROKEN (a crashed run must not count as a kill). Judge the result by the printed table.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const FOCUS = [
  "tests/plateStackCase.test.ts",
  "tests/plateStackResults.test.ts",
  "tests/plateStackTransientResults.test.ts",
  "tests/axialCase.test.ts",
  "tests/stackResults.test.ts",
  "tests/stackTransientResults.test.ts",
  "tests/plate.test.ts",
  "tests/plateResults.test.ts",
  "tests/validate.test.ts",
];
const A = "src/core/axial.ts";
const V = "src/core/validate.ts";
const SR = "src/core/stackResults.ts";
const ST = "src/core/stackTransientResults.ts";
const W = "src/core/caseWriter.ts";

const mutants = [
  // the estimate takes a slab's cross-sections from the geometry kernel
  [A, "  const Af = g.volume(c.fuelInnerRadius, c.fuelRadius);\n  const Ac = g.volume(c.claddingInnerRadius, c.claddingOuterRadius);\n  const span", "  const Af = Math.PI * (c.fuelRadius ** 2 - c.fuelInnerRadius ** 2);\n  const Ac = g.volume(c.claddingInnerRadius, c.claddingOuterRadius);\n  const span", "estimate: the meat's area as a pin's"],
  [A, "  const Af = g.volume(c.fuelInnerRadius, c.fuelRadius);\n  const Ac = g.volume(c.claddingInnerRadius, c.claddingOuterRadius);\n  const span", "  const Af = g.volume(c.fuelInnerRadius, c.fuelRadius);\n  const Ac = Math.PI * (c.claddingOuterRadius ** 2 - c.claddingInnerRadius ** 2);\n  const span", "estimate: the cladding's area as a pin's"],
  [A, "  const g = geometryOf(c.plate);\n  const Af = g.volume(c.fuelInnerRadius, c.fuelRadius);\n  const Ac = g.volume(c.claddingInnerRadius, c.claddingOuterRadius);\n  const span", "  const g = geometryOf(undefined);\n  const Af = g.volume(c.fuelInnerRadius, c.fuelRadius);\n  const Ac = g.volume(c.claddingInnerRadius, c.claddingOuterRadius);\n  const span", "estimate: the kernel's geometry is always the cylinder"],
  [A, "  const U = hottest.linearHeatRate / hottest.centreRise;", "  const U = hottest.linearHeatRate / (2 * hottest.centreRise);", "estimate: conductance to the coolant halved"],
  [A, "  return { fraction: lambdaSquared * curvature, lambdaSquared, curvature };", "  return { fraction: 0.5 * lambdaSquared * curvature, lambdaSquared, curvature };", "estimate: fraction halved"],
  // the exchange rate
  [A, "  return { rate: kA / (heatCapacity * h * h), kA, heatCapacity };", "  return { rate: kA / (heatCapacity * h), kA, heatCapacity };", "exchange: slice height not squared"],
  [A, "  const h = a.length / a.slices;\n  return { rate", "  const h = a.length;\n  return { rate", "exchange: the whole length for the slice height"],
  [A, "  const kA = maxConductivity(c.fuelConductivity, fuel[0], fuel[1]) * Af + maxConductivity(c.claddingConductivity, cladding[0], cladding[1]) * Ac;", "  const kA = maxConductivity(c.fuelConductivity, fuel[0], fuel[1]) * Ac + maxConductivity(c.claddingConductivity, cladding[0], cladding[1]) * Ac;", "exchange: the meat's conductance with the cladding's area"],
  [A, "  const kA = maxConductivity(c.fuelConductivity, fuel[0], fuel[1]) * Af + maxConductivity(c.claddingConductivity, cladding[0], cladding[1]) * Ac;", "  const kA = maxConductivity(c.fuelConductivity, cladding[0], cladding[1]) * Af + maxConductivity(c.claddingConductivity, cladding[0], cladding[1]) * Ac;", "exchange: the meat's conductivity over the cladding's range"],
  [A, "  const heatCapacity = minimum(heatCapacityLaw(c.fuelHeatCapacity), fuel[0], fuel[1]) * Af + minimum(heatCapacityLaw(c.claddingHeatCapacity), cladding[0], cladding[1]) * Ac;", "  const heatCapacity = minimum(heatCapacityLaw(c.fuelHeatCapacity), fuel[0], fuel[1]) * Ac + minimum(heatCapacityLaw(c.claddingHeatCapacity), cladding[0], cladding[1]) * Ac;", "exchange: the meat's heat capacity with the cladding's area"],
  [A, "  const heatCapacity = minimum(heatCapacityLaw(c.fuelHeatCapacity), fuel[0], fuel[1]) * Af + minimum(heatCapacityLaw(c.claddingHeatCapacity), cladding[0], cladding[1]) * Ac;", "  const heatCapacity = minimum(heatCapacityLaw(c.fuelHeatCapacity), fuel[1], fuel[1]) * Af + minimum(heatCapacityLaw(c.claddingHeatCapacity), cladding[0], cladding[1]) * Ac;", "exchange: the heat capacity looked for only at the hot end"],
  [A, "  for (let i = 0; i <= 8; i++) m = Math.max(m, evaluate(law, lo + ((hi - lo) * i) / 8));", "  for (let i = 0; i <= 8; i++) m = Math.max(m, evaluate(law, lo + ((hi - lo) * i) / 16));", "conductivity: only the cool half of the range looked at"],
  [A, "  for (let i = 0; i <= 8; i++) m = Math.max(m, evaluate(law, lo + ((hi - lo) * i) / 8));", "  for (let i = 1; i <= 8; i++) m = Math.max(m, evaluate(law, lo + ((hi - lo) * i) / 8));", "conductivity: the cool end of the range skipped"],
  [A, "  if (!a || !c.fuelHeatCapacity || !c.claddingHeatCapacity) return undefined;", "  if (!a) return undefined;", "exchange: no refusal without heat capacities"],
  // the validator
  [V, "if (peak > POWER_SANITY_MAX && !normalized.transient && !normalized.plate) {", "if (peak > POWER_SANITY_MAX && !normalized.transient) {", "a plate's stack judged against a pin's heat-rate range"],
  [V, "heat flow along the height could change the temperatures", "heat flow along the pin could change the temperatures", "warning text names the pin"],
  [V, "if (isTransient && axialSpec?.boundary !== undefined && c.transient?.boundaryHistory !== undefined)", "if (false && isTransient && axialSpec?.boundary !== undefined && c.transient?.boundaryHistory !== undefined)", "coolant table with a boundary history accepted"],
  [V, "      ...(isPlate ? { plate: true as const } : {}),", "      ...(isPlate && !axialSpec ? { plate: true as const } : {}),", "a plate stack not marked as a plate"],
  [V, "    if (c.transient?.pointKinetics !== undefined) err(\"E_UNSUPPORTED\", \"/transient/pointKinetics\", \"a generated pulse is for pins", "    if (false) err(\"E_UNSUPPORTED\", \"/transient/pointKinetics\", \"a generated pulse is for pins", "point kinetics accepted on a plate"],
  // the slice keeps its geometry
  [A, "  return { ...rest, qPrime: load.linearHeatRate, boundary: load.boundary, ...(transient ? { transient } : {}) };", "  return { ...rest, plate: undefined, qPrime: load.linearHeatRate, boundary: load.boundary, ...(transient ? { transient } : {}) };", "the slice of a plate stack is a pin"],
  // the texts of the results
  [SR, "export const stackText = (c: NormalizedCase): string => (c.plate ? STACK_TEXT_PLATE : STACK_TEXT);", "export const stackText = (c: NormalizedCase): string => (c.plate ? STACK_TEXT : STACK_TEXT);", "a plate stack's banner says radial"],
  [SR, "    thermalOnly: THERMAL_ONLY_TEXT + \" \" + stackText(c),", "    thermalOnly: THERMAL_ONLY_TEXT,", "steady stack banner without the statement"],
  [ST, "    thermalOnly: THERMAL_ONLY_TEXT + \" \" + stackText(c),", "    thermalOnly: THERMAL_ONLY_TEXT,", "transient stack banner without the statement"],
  [SR, "      if (!(z >= k * height - eps && z <= (k + 1) * height + eps)) bad(", "      if (false) bad(", "layer heights not checked"],
  // the writer's plate paths
  [W, "  const halfWidth = (PLATE_WIDTH_M * 1000) / 2;", "  const halfWidth = (PLATE_WIDTH_M * 1000) / 4;", "plate width halved"],
  [W, "  const sides = c.plate ? \"empty\" : \"wedge\";", "  const sides = c.plate ? \"wedge\" : \"wedge\";", "plate side faces as wedges"],
  [W, "${c.plate ? \"    angularFraction         1;\\n\" : \"\"}    reactorType", "    reactorType", "no angularFraction for a plate"],
  [W, "const heightMm = (c: NormalizedCase): number => (c.axial ? Number((c.axial.length * 1000).toPrecision(12)) : SLICE_HEIGHT_MM);", "const heightMm = (c: NormalizedCase): number => SLICE_HEIGHT_MM;", "mesh height always the one-cell slice"],
  [W, "const layers = (c: NormalizedCase): number => c.axial?.slices ?? 1;", "const layers = (c: NormalizedCase): number => 1;", "one layer whatever the stack"],
  [W, "        type            ${c.plate ? \"empty\" : \"wedge\"};\n        value           ${copy(mean)};", "        type            wedge;\n        value           ${copy(mean)};", "temperature field's side faces as wedges"],
  // the bound on the heat exchanged along the height
  [ST, "export const AXIAL_EXCHANGE_FACTOR = 2;", "export const AXIAL_EXCHANGE_FACTOR = 0.5;", "exchange factor quartered"],
  [ST, "export const AXIAL_EXCHANGE_NUMBER_LIMIT = 1;", "export const AXIAL_EXCHANGE_NUMBER_LIMIT = 100;", "exchange always counted"],
  [ST, "exchange !== undefined && exchange.number <= AXIAL_EXCHANGE_NUMBER_LIMIT ? exchange : undefined;", "exchange !== undefined && exchange.number >= AXIAL_EXCHANGE_NUMBER_LIMIT ? exchange : undefined;", "exchange counted only above its limit"],
  [ST, "    const below = traces[k > 0 ? k - 1 : k]!.peakByStep;", "    const below = traces[k]!.peakByStep;", "no neighbour below"],
  [ST, "    const above = traces[k < a.slices - 1 ? k + 1 : k]!.peakByStep;", "    const above = traces[k]!.peakByStep;", "no neighbour above"],
  [ST, "Math.abs(below[j]! - 2 * p[j]! + above[j]!) * dt;", "(below[j]! - 2 * p[j]! + above[j]!) * dt;", "second difference not in absolute value"],
  [ST, "Math.abs(below[j]! - 2 * p[j]! + above[j]!) * dt;", "Math.abs(below[j]! - 2 * p[j]! + above[j]!);", "integral without the time step"],
  [ST, "    for (let j = 0; j < p.length; j++) integral += (j === 0 || j === p.length - 1 ? 0.5 : 1)", "    for (let j = 0; j < p.length; j++) integral += (j === 0 ? 0.5 : 1)", "trapezoid without the last half step"],
  [ST, "    given *= loads[k]!.factor;", "    given *= 1;", "energy given without the slice's factor"],
  [ST, "(AXIAL_EXCHANGE_FACTOR * ex.kA * integral) / (a.length / a.slices) ** 2 / given : 0);", "(AXIAL_EXCHANGE_FACTOR * ex.kA * integral) / (a.length / a.slices) / given : 0);", "energy bound with the slice height not squared"],
  [ST, "    field.push(AXIAL_EXCHANGE_FACTOR * ex.rate * integral);", "    field.push(ex.rate * integral);", "field bound without the factor"],
  [ST, "  const dt = t.timeStep;\n  const field: number[] = [];", "  const dt = 1;\n  const field: number[] = [];", "time step taken as 1 s"],
  [ST, "    const allow: TransientAllowance = { field: Math.max(field, counted?.field[k] ?? 0),", "    const allow: TransientAllowance = { field: Math.max(field, 0),", "exchange not added to the cross-check allowance"],
  [ST, "energy: Math.max(steadyEnergy, counted?.energy[k] ?? 0) };", "energy: Math.max(steadyEnergy, 0) };", "exchange not added to the energy allowance"],
  [ST, "  return { field, energy, number: ex.rate * t.endTime };", "  return { field, energy, number: ex.rate };", "exchange number without the run time"],
  [ST, "  const fuel: [number, number] = [Math.min(...traces.map((x) => x!.fuelMin)), Math.max(...traces.map((x) => x!.fuelMax))];", "  const fuel: [number, number] = [Math.max(...traces.map((x) => x!.fuelMin)), Math.max(...traces.map((x) => x!.fuelMax))];", "fuel range from the warmest slice's minimum"],
];

function runFocus() {
  const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...FOCUS], { cwd: root, encoding: "utf8", timeout: 600000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out) || /Tests\s+(\d+) failed/.exec(out);
  return { code: r.status, summary: m ? m[0] : null, out };
}

const only = process.argv[2] ? new Set(process.argv[2].split(",").map(Number)) : undefined;
const base = runFocus();
console.log("baseline: exit " + base.code + ", " + base.summary);
if (base.code !== 0 || !base.summary) {
  console.log("ABORT: the baseline is not green");
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
    const r = runFocus();
    const verdict = !r.summary ? "BROKEN" : r.code === 0 ? "SURVIVED" : "killed";
    rows.push([name, verdict, r.summary || ""]);
    console.log(verdict.padEnd(9) + "#" + i + " " + name + "   [" + (r.summary || "no summary") + "]");
  } finally {
    fs.writeFileSync(p, original, "utf8");
  }
});
const n = (v) => rows.filter((r) => r[1] === v).length;
console.log("\nmutants " + rows.length + ": killed " + n("killed") + ", survived " + n("SURVIVED") + ", broken " + n("BROKEN") + ", bad anchor " + rows.filter((r) => r[1].startsWith("ANCHOR")).length);
for (const r of rows.filter((x) => x[1] !== "killed")) console.log("  " + r[1] + ": " + r[0]);
