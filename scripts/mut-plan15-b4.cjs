// Mutation run for plan 15, B4 and B5 (the transient reference in a worker with a deadline and its caps, the steady field the check offers, and the page's option for the heat flow
// along the height): src/core/stackReference.ts, independentRunner.ts, independentWorker.ts, runManager.ts, src/server/server.ts and src/web/index.html.
// usage: node scripts/mut-plan15-b4.cjs [comma list of mutant numbers]      (commit first and keep a green baseline; never run two mutation runs at once on this machine)
// Each mutant is [file, from, to, name]: `from` is a unique anchor in `file`. The file is changed, dist/ is built again (the worker tests run the COMPILED worker, so a mutant must be in
// it), the fast tests are run, and when they pass the slow tests too; the file is restored from the copy read before (never from git) and dist/ built again at the end. A mutant is
// KILLED when a run exits non-zero AND prints a "Tests N ..." summary; it SURVIVES when both runs exit 0; a run with no summary line is BROKEN. Judge by the printed table.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const FAST = ["tests/stackReferenceWorker.test.ts", "tests/stackViewFlow.test.ts", "tests/oracleMeasure2d.test.ts"];
const SLOW = ["tests/independentRunner.test.ts", "tests/independentRunManager.test.ts", "tests/stackView.test.ts", "tests/plateStackTransientReference.test.ts", "tests/plateStackReference.test.ts", "tests/axialFv.test.ts"];
const SRF = "src/core/stackReference.ts";
const IR = "src/core/independentRunner.ts";
const IW = "src/core/independentWorker.ts";
const RM = "src/core/runManager.ts";
const SV = "src/server/server.ts";
const HT = "src/web/index.html";

const mutants = [
  // ---- the caps and the size of a case
  [SRF, "  if (w.work > STACK_TRANSIENT_WORK_MAX) return", "  if (w.work < STACK_TRANSIENT_WORK_MAX) return", "the unknown-steps cap inverted"],
  [SRF, "  if (w.work > STACK_TRANSIENT_WORK_MAX) return", "  if (false) return", "no unknown-steps cap"],
  [SRF, "  if (w.bandWork > STACK_TRANSIENT_BAND_WORK_MAX) return", "  if (w.bandWork < STACK_TRANSIENT_BAND_WORK_MAX) return", "the band-work cap inverted"],
  [SRF, "  if (w.bandWork > STACK_TRANSIENT_BAND_WORK_MAX) return", "  if (false) return", "no band-work cap"],
  [SRF, "export const STACK_TRANSIENT_BAND_WORK_MAX = 4e8;", "export const STACK_TRANSIENT_BAND_WORK_MAX = 8e8;", "the band-work cap doubled"],
  [SRF, "export const STACK_TRANSIENT_WORK_MAX = 3e6;", "export const STACK_TRANSIENT_WORK_MAX = 6e6;", "the unknown-steps cap doubled"],
  [SRF, "export const STACK_TRANSIENT_DEADLINE_MS = 60000;", "export const STACK_TRANSIENT_DEADLINE_MS = 6000;", "the default deadline a tenth"],
  [SRF, "  return { unknowns, steps: t.steps, work: unknowns * t.steps, bandWork: unknowns * n * t.steps };", "  return { unknowns, steps: t.steps, work: unknowns * t.steps, bandWork: unknowns * t.steps };", "the band work without the cells per layer"],
  [SRF, "  return { unknowns, steps: t.steps, work: unknowns * t.steps, bandWork: unknowns * n * t.steps };", "  return { unknowns, steps: t.steps, work: n * t.steps, bandWork: unknowns * n * t.steps };", "the unknown-steps without the slices"],
  [SRF, "  const unknowns = a.slices * n;", "  const unknowns = n;", "the unknowns without the slices"],
  [SRF, "  if (!a || !t) return undefined;\n  const n = c.mesh.fuelCells", "  if (!a) return undefined;\n  const n = c.mesh.fuelCells", "a steady case has a transient work"],
  [SRF, "deadlineMs: o.deadlineMs ?? STACK_TRANSIENT_DEADLINE_MS });", "deadlineMs: o.deadlineMs ?? 1 });", "the default deadline 1 ms"],
  [SRF, "  if (t.initial.kind === \"steady\") {\n    try {\n      const coupled", "  if (false) {\n    try {\n      const coupled", "the start distance never worked out"],
  [SRF, "  return \"solved\" in r ? { reference: stackTransientReferenceFrom(c, r.solved) } : r;", "  return \"solved\" in r ? { reference: stackTransientReferenceFrom(c, { ...r.solved, startDistance: null }) } : r;", "the composed reference loses the start distance"],
  // ---- the steady field the check offers
  [SRF, "  if (!c.axial || c.transient) return undefined;\n  if (!c.plate)", "  if (!c.axial) return undefined;\n  if (!c.plate)", "a transient stack is offered a steady field"],
  [SRF, "  if (!c.axial || c.transient) return undefined;\n  if (!c.plate)", "  if (c.transient) return undefined;\n  if (!c.plate)", "a case with no stack is offered a field"],
  [SRF, "  if (!c.plate) return { available: false, reason: FIELD_2D_PIN_REASON };", "  if (false) return { available: false, reason: FIELD_2D_PIN_REASON };", "a pin is offered the field"],
  [SRF, "  const off = stackReference(c, { axialConduction: false });", "  const off = stackReference(c, { axialConduction: true });", "the effect taken against the coupled solution itself"],
  [SRF, "    ref.reference.solution.T.forEach((x, i) => (effect = Math.max(effect, Math.abs(x - (off.reference.solution.T[i] as number)))));", "    ref.reference.solution.T.forEach((x, i) => (effect = Math.max(effect, x - (off.reference.solution.T[i] as number))));", "the effect without the absolute value"],
  [SRF, "    ref.reference.solution.T.forEach((x, i) => (effect = Math.max(effect, Math.abs(x - (off.reference.solution.T[i] as number)))));", "    ref.reference.solution.T.forEach((x, i) => (effect = Math.abs(x - (off.reference.solution.T[i] as number))));", "the effect is the last cell's"],
  [SRF, "      return { index: l.index, height: l.height, points: cells.map((T, i) => ({ r: r[i]!, T, region: i < nf ? \"fuel\" : \"cladding\" }) as ProfilePoint) };", "      return { index: l.index, height: l.height, points: cells.map((T, i) => ({ r: r[i]!, T, region: i < nf ? \"cladding\" : \"fuel\" }) as ProfilePoint) };", "the regions swapped"],
  [SRF, "      return { index: l.index, height: l.height, points: cells.map((T, i) => ({ r: r[i]!, T, region: i < nf ? \"fuel\" : \"cladding\" }) as ProfilePoint) };", "      return { index: l.index, height: l.height, points: cells.map((T, i) => ({ r: r[0]!, T, region: i < nf ? \"fuel\" : \"cladding\" }) as ProfilePoint) };", "every point at the first radius"],
  [SRF, "      return { index: l.index, height: l.height, points: cells.map((T, i) => ({ r: r[i]!, T, region: i < nf ? \"fuel\" : \"cladding\" }) as ProfilePoint) };", "      return { index: l.index, height: 0, points: cells.map((T, i) => ({ r: r[i]!, T, region: i < nf ? \"fuel\" : \"cladding\" }) as ProfilePoint) };", "the height of a slice zero"],
  [SRF, "      const cells = [...s.fuel, ...s.clad];", "      const cells = [...s.clad, ...s.fuel];", "the cells in the wrong order"],
  [SRF, "      const s = ref.reference.slice(k);\n      const cells", "      const s = ref.reference.slice(0);\n      const cells", "every slice is the first slice's field"],
  [SRF, "    note: FIELD_2D_NOTE,", "    note: \"\",", "the note left out"],
  // ---- the runner and the worker
  [IR, "const set = j.what === \"stackReference\" ? solveStackTransientReference(j.c, { deadlineMs: j.deadlineMs }) :", "const set = j.what === \"stackReference\" ? solveStackTransientReference(j.c, {}) :", "in-process: the job's deadline not given to the solver"],
  [IR, "`the ${j.what === \"stackReference\" ? \"two-dimensional reference\" : \"independent solution\"} did not finish within", "`the ${j.what === \"stackReference\" ? \"independent solution\" : \"independent solution\"} did not finish within", "the deadline message does not name the reference"],
  [IR, "`the ${j.what === \"stackReference\" ? \"two-dimensional reference\" : \"independent solution\"} failed: `", "`the ${j.what === \"stackReference\" ? \"independent solution\" : \"independent solution\"} failed: `", "the failure message does not name the reference"],
  [IR, "const set = j.what === \"stackReference\" ? solveStackTransientReference(j.c, { deadlineMs: j.deadlineMs }) : j.what === \"full\" ?", "const set = j.what === \"stackReference\" ? computeIndependentStack(j.c) : j.what === \"full\" ?", "in-process: the reference job runs the one-dimensional runs"],
  [IW, "  const set = job.what === \"stackReference\" ? solveStackTransientReference(job.c, { deadlineMs: Infinity }) : job.what === \"full\" ?", "  const set = job.what === \"full\" ?", "worker: the reference job runs the preview"],
  [IW, "  const set = job.what === \"stackReference\" ? solveStackTransientReference(job.c, { deadlineMs: Infinity })", "  const set = job.what === \"stackReference\" ? solveStackTransientReference(job.c, { deadlineMs: 1 })", "worker: the solver's own deadline 1 ms"],
  [IW, "  const set = job.what === \"stackReference\" ? solveStackTransientReference(job.c, { deadlineMs: Infinity })", "  const set = job.what === \"stackReference\" ? solveStackTransientReference(job.c, {})", "worker: the solver keeps its default deadline"],
  // ---- the run manager
  [RM, "const refJob = normalized.axial && normalized.plate ? this.independent.start(", "const refJob = normalized.axial ? this.independent.start(", "a pin stack starts a reference job"],
  [RM, "const refJob = normalized.axial && normalized.plate ? this.independent.start(", "const refJob = false ? this.independent.start(", "no reference job"],
  [RM, "deadlineMs: this.opts.referenceDeadlineMs ?? STACK_TRANSIENT_DEADLINE_MS })", "deadlineMs: this.opts.referenceDeadlineMs ?? 1 })", "the reference's default deadline 1 ms"],
  [RM, "deadlineMs: this.opts.referenceDeadlineMs ?? STACK_TRANSIENT_DEADLINE_MS })", "deadlineMs: 1 })", "the reference's deadline option ignored"],
  [RM, "{ done: job.done, cancel: () => (job.cancel(), refJob.cancel()) }", "{ done: job.done, cancel: () => job.cancel() }", "a cancel does not stop the reference job"],
  [RM, "{ done: job.done, cancel: () => (job.cancel(), refJob.cancel()) }", "{ done: job.done, cancel: () => refJob.cancel() }", "a cancel does not stop the one-dimensional job"],
  [RM, "refOut = refJob ? (ind.ok ? await refJob.done : (refJob.cancel(), undefined)) : undefined;", "refOut = refJob ? await refJob.done : undefined;", "a failed one-dimensional job leaves the reference running"],
  [RM, "refOut = refJob ? (ind.ok ? await refJob.done : (refJob.cancel(), undefined)) : undefined;", "refOut = undefined;", "the reference's answer never awaited"],
  [RM, " || (refOut && !refOut.ok && refOut.reason === \"cancelled\")) {", ") {", "a cancelled reference does not cancel the run"],
  [RM, "if (refOut.ok && refOut.what === \"stackReference\" && \"solved\" in refOut.set) {", "if (refOut.ok && refOut.what === \"stackReference\") {", "a fallback answer treated as a solution"],
  [RM, "if (refOut.ok && refOut.what === \"stackReference\" && \"solved\" in refOut.set) {", "if (false) {", "the reference's solution never used"],
  [RM, "const why = refOut.ok ? (refOut.set as { fallback: string }).fallback : refOut.message;", "const why = refOut.ok ? \"\" : refOut.message;", "the solver's fallback reason dropped"],
  [RM, "const why = refOut.ok ? (refOut.set as { fallback: string }).fallback : refOut.message;", "const why = refOut.ok ? (refOut.set as { fallback: string }).fallback : \"\";", "the failure's reason dropped"],
  [RM, "refOut.mode === \"worker\" ? \"a worker thread\" : \"the server's own thread (no compiled worker was found; its own deadline applied)\"", "refOut.mode === \"worker\" ? \"the server's own thread (no compiled worker was found; its own deadline applied)\" : \"a worker thread\"", "the notes say the wrong thread"],
  [RM, "the checks keep the allowance for the heat flow along the height.`);", "the checks use the reference.`);", "the notes say the wrong thing about the checks"],
  [RM, "const tr = normalized.axial ? buildStackTransientResults(normalized, { C, fields }, ind.set as IndependentSet[], reference)", "const tr = normalized.axial ? buildStackTransientResults(normalized, { C, fields }, ind.set as IndependentSet[])", "the reference never given to the checks"],
  // ---- the server
  [SV, "axialProfiles: axialProfiles(n), axialField2d: axialField2d(n) }", "axialProfiles: axialProfiles(n) }", "the check does not offer the field"],
  // ---- the page
  [HT, "  return { shown: on && wanted === \"2d\" ? \"2d\" : \"closed\",", "  return { shown: on ? \"2d\" : \"closed\",", "the field shown whenever it is offered"],
  [HT, "  return { shown: on && wanted === \"2d\" ? \"2d\" : \"closed\",", "  return { shown: wanted === \"2d\" ? \"2d\" : \"closed\",", "the field shown whenever it is asked for"],
  [HT, "enabled: on, reason:", "enabled: true, reason:", "the option always enabled"],
  [HT, "const on = !!(field && field.available);", "const on = !!field;", "an unavailable field counted as offered"],
  [HT, "reason: field && !field.available ? String(field.reason || \"\") : on ? \"\" :", "reason: on ? \"\" :", "the pin's reason dropped"],
  [HT, "const stackViewCaption = (d) => (d && d.run ? stackViewRunLabel(d.conduction) : d && d.flow === \"2d\" ? stackViewFlowLabel(d.effect) : STACK_VIEW_LABEL);", "const stackViewCaption = (d) => (d && d.flow === \"2d\" ? stackViewFlowLabel(d.effect) : d && d.run ? stackViewRunLabel(d.conduction) : STACK_VIEW_LABEL);", "a run's caption overridden by the flow state"],
  [HT, "const stackViewCaption = (d) => (d && d.run ? stackViewRunLabel(d.conduction) : d && d.flow === \"2d\" ? stackViewFlowLabel(d.effect) : STACK_VIEW_LABEL);", "const stackViewCaption = (d) => (d && d.run ? stackViewRunLabel(d.conduction) : STACK_VIEW_LABEL);", "no caption for the two-dimensional state"],
  [HT, "d && d.flow === \"2d\" ? \"2D: FEED's reference field, heat flow along the height included\"", "d && d.flow === \"2d\" ? \"1.5D: one radial solution per slice\"", "the canvas label of the two-dimensional state is the closed form's"],
  [HT, "(typeof effect === \"number\" && Number.isFinite(effect) ? \": it changes them by up to \" + effect.toPrecision(2)", "(typeof effect === \"number\" ? \": it changes them by up to \" + effect.toPrecision(2)", "a caption that prints NaN"],
  [HT, "effect.toPrecision(2) + \" K against the same solution without it\"", "effect.toPrecision(4) + \" K against the same solution without it\"", "the effect printed to four digits"],
  [HT, "IS in the temperatures drawn", "is not in the temperatures drawn", "the caption says the flow is not in the picture"],
  [HT, "not OFFBEAT's result and not a measurement. Nothing varies across the width.", "OFFBEAT's result. Nothing varies across the width.", "the caption calls the field OFFBEAT's result"],
  [HT, "flow: \"2d\", effect: field.effect };", "effect: field.effect };", "the two-dimensional data does not say it is the field"],
  [HT, "flow: \"2d\", effect: field.effect };", "flow: \"2d\" };", "the two-dimensional data carries no effect"],
  [HT, "return { ...stackViewData(field.slices.map((s) => ({ index: s.index, z: s.height, samples: s.points })), g)", "return { ...stackViewData(field.slices.map((s) => ({ index: s.index, z: s.index, samples: s.points })), g)", "the slices' heights replaced by their indexes"],
  [HT, "let case3dFlow = \"closed\";", "let case3dFlow = \"2d\";", "the page starts in the two-dimensional state"],
  [HT, "if (stackFlowChoice(result.axialField2d, case3dFlow).shown === \"2d\") return stackDataTwoD(", "if (stackFlowChoice(result.axialField2d, case3dFlow).shown === \"closed\") return stackDataTwoD(", "the data function picks the wrong state"],
  [HT, "get: () => stackFlowChoice(result && result.axialField2d, case3dFlow),", "get: () => stackFlowChoice(null, case3dFlow),", "the option never offered by the panel"],
  [HT, "b.addEventListener(\"click\", () => { flow.set(key); redraw(); });", "b.addEventListener(\"click\", () => { redraw(); });", "the option's buttons set nothing"],
  [HT, "fb[\"2d\"].disabled = !c.enabled;", "fb[\"2d\"].disabled = false;", "the two-dimensional button never disabled"],
  [HT, "for (const key of [\"closed\", \"2d\"]) fb[key].setAttribute(\"aria-pressed\", String(c.shown === key));", "for (const key of [\"closed\", \"2d\"]) fb[key].setAttribute(\"aria-pressed\", \"false\");", "the pressed state never shown"],
  [HT, "cap.textContent = stackViewCaption(d); fillTable(); if (flow) syncFlow(); };", "fillTable(); if (flow) syncFlow(); };", "the caption not set on a redraw"],
];

function run(files) {
  const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...files], { cwd: root, encoding: "utf8", timeout: 900000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out) || /Tests\s+(\d+) failed/.exec(out);
  return { code: r.status, summary: m ? m[0] : null, out };
}
function build() {
  const r = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: root, encoding: "utf8", timeout: 300000 });
  return r.status;
}

const only = process.argv[2] ? new Set(process.argv[2].split(",").map(Number)) : undefined;
if (process.env.ANCHORS_ONLY) {
  mutants.forEach(([file, from], i) => {
    const count = fs.readFileSync(path.join(root, file), "utf8").split(from).length - 1;
    if (count !== 1) console.log("ANCHOR " + count + "  #" + i + " " + mutants[i][3]);
  });
  console.log("checked " + mutants.length + " anchors");
  process.exit(0);
}
build();
const base1 = run(FAST);
const base2 = run(SLOW);
console.log("baseline: fast exit " + base1.code + ", " + base1.summary + "; slow exit " + base2.code + ", " + base2.summary);
if (base1.code !== 0 || !base1.summary || base2.code !== 0 || !base2.summary) {
  console.log("ABORT: the baseline is not green");
  process.exit(2);
}
const rows = [];
try {
  mutants.forEach(([file, from, to, name], i) => {
    if (only && !only.has(i)) return;
    const p = path.join(root, file);
    const original = fs.readFileSync(p, "utf8");
    const count = original.split(from).length - 1;
    if (count !== 1) {
      rows.push([i, name, "ANCHOR " + count, ""]);
      console.log("ANCHOR " + count + "  #" + i + " " + name);
      return;
    }
    try {
      fs.writeFileSync(p, original.replace(from, () => to), "utf8");
      if (file.endsWith(".ts")) build();
      let r = run(FAST);
      let tier = "fast";
      if (r.summary && r.code === 0) {
        r = run(SLOW);
        tier = "slow";
      }
      const verdict = !r.summary ? "BROKEN" : r.code === 0 ? "SURVIVED" : "killed";
      rows.push([i, name, verdict, r.summary || ""]);
      console.log(verdict.padEnd(9) + "#" + i + " " + name + "   [" + tier + ": " + (r.summary || "no summary") + "]");
    } finally {
      fs.writeFileSync(p, original, "utf8");
    }
  });
} finally {
  build();
}
const n = (v) => rows.filter((r) => r[2] === v).length;
console.log("\nkilled " + n("killed") + ", survived " + n("SURVIVED") + ", broken " + n("BROKEN") + ", anchor problems " + rows.filter((r) => String(r[2]).startsWith("ANCHOR")).length + " of " + rows.length);
for (const r of rows) if (r[2] !== "killed") console.log("  " + r[2] + " #" + r[0] + " " + r[1] + " " + r[3]);
