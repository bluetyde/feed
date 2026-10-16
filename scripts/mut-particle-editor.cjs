// Mutation run for plan 13, milestone T5 (the particle editor: the page's pure helpers and wiring, the closed-form profile and the server's addition).
// usage: node scripts/mut-particle-editor.cjs [name regex]     (commit first and keep a green baseline; check no other process has "mut-" in its command line)
// Each mutant is [file, from, to, name]: `from` is a unique single-line anchor in `file`. The file is changed, the focus tests are run, and the file is restored from the copy read before
// (never from git, so uncommitted work is safe). A mutant is KILLED when the run exits non-zero AND prints a "Tests N ... " summary; it SURVIVES when the run exits 0; a run with no summary
// line is BROKEN (a crashed run must not count as a kill).
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const FOCUS = ["tests/particleEditor.test.ts", "tests/trisoServer.test.ts", "tests/pageStructure.test.ts"];
const H = "src/web/index.html";
const P = "src/core/trisoProfile.ts";
const S = "src/server/server.ts";

const mutants = [
  // the starting case and its defaults
  [H, 'geometry: { kind: "triso", kernelRadius: uq(250, "um"),', 'geometry: { kind: "triso", kernelRadius: uq(25, "um"),', "starting kernel radius"],
  [H, 'power: { kernelPowerDensity: uq(600, "MW/m3") },', 'power: { kernelPowerDensity: uq(60, "MW/m3") },', "starting power"],
  [H, 'if (withCapacity) sets["thermal.volumetricHeatCapacity"] = constantLaw(d.c, "MJ/m3/K", PARTICLE_CAPACITY_SOURCE);', 'if (!withCapacity) sets["thermal.volumetricHeatCapacity"] = constantLaw(d.c, "MJ/m3/K", PARTICLE_CAPACITY_SOURCE);', "capacity on the steady material"],
  [H, 'powerHistory: [pt(0, 0), pt(10, 0.4), pt(20, 0), pt(500, 0)],', 'powerHistory: [pt(0, 0), pt(10, 4), pt(20, 0), pt(500, 0)],', "default pulse peak"],
  [H, 'endTime: uq(500, "ms"), timeStep: uq(0.5, "ms"), outputs: 50,', 'endTime: uq(500, "ms"), timeStep: uq(5, "ms"), outputs: 50,', "default time step"],
  // layers
  [H, 'if (!Array.isArray(layers) || layers.length >= PARTICLE_LAYER_NAMES.length) return false;', 'if (!Array.isArray(layers) || layers.length > PARTICLE_LAYER_NAMES.length) return false;', "a fifth layer allowed"],
  [H, 'const name = PARTICLE_LAYER_NAMES[layers.length], d = PARTICLE_DEFAULTS[name];', 'const name = PARTICLE_LAYER_NAMES[layers.length - 1], d = PARTICLE_DEFAULTS[name];', "added layer is the wrong one"],
  [H, 'doc.materials[name] = particleMaterial(name, particleTransient());', 'doc.materials[name] = particleMaterial(name, false);', "added layer has no heat capacity in a transient"],
  [H, 'doc.mesh[name + "Cells"] = d.cells;', 'doc.mesh[name + "Cell"] = d.cells;', "added layer's mesh key"],
  [H, 'if (!Array.isArray(layers) || layers.length <= 2) return false;', 'if (!Array.isArray(layers) || layers.length <= 1) return false;', "one layer allowed"],
  [H, 'if (doc.materials) delete doc.materials[name];', 'if (doc.materials) doc.materials[name] = doc.materials[name];', "removed layer keeps its material"],
  [H, 'if (doc.mesh) delete doc.mesh[name + "Cells"];', 'if (doc.mesh) doc.mesh[name + "Cells"] = doc.mesh[name + "Cells"];', "removed layer keeps its mesh key"],
  [H, 'const keep = doc.limits.filter((l) => l && l.region !== name);', 'const keep = doc.limits.filter((l) => l && l.region === name);', "limits on the removed layer kept"],
  [H, 'if (keep.length) doc.limits = keep; else delete doc.limits;', 'if (keep.length) doc.limits = keep;', "empty limits list left behind"],
  [H, 'logText += "Removed the " + name + " layer" + (dropped ?', 'logText += "Removed a layer" + (dropped ?', "removal not logged by name"],
  // analysis and start
  [H, 'uq(t.value, t.unit) : uq(1000, "K");', 'uq(t.value, t.unit) : uq(300, "K");', "default outside temperature"],
  [H, '    delete doc.power;', '', "power kept in a transient"],
  [H, 'if (m && m.sets && !m.sets["thermal.volumetricHeatCapacity"]) m.sets', 'if (m && m.sets) m.sets', "existing heat capacity overwritten"],
  [H, 'doc.power = { kernelPowerDensity: uq(600, "MW/m3") };', 'doc.power = { kernelPowerDensity: uq(6, "MW/m3") };', "power back to steady"],
  [H, 't.initialSteadyParticlePower = first ? uq(first.value / 2, first.unit) : uq(0.2, "W");', 't.initialSteadyParticlePower = first ? uq(first.value, first.unit) : uq(0.2, "W");', "steady start at the full power"],
  [H, 't.initialSteadyParticlePower = first ? uq(first.value / 2, first.unit) : uq(0.2, "W");', 't.initialSteadyParticlePower = first ? uq(first.value / 2, first.unit) : uq(2, "W");', "steady start fallback power"],
  [H, 'delete t.initialTemperature;\n    t.initialSteadyParticlePower = first', 't.initialSteadyParticlePower = first', "both starts"],
  [H, 'delete t.initialSteadyParticlePower;\n    t.initialTemperature = particleOutsideTemperature();', 't.initialTemperature = particleOutsideTemperature();', "both starts (uniform)"],
  // power forms
  [H, 'old = doc.power || {}, packing = 0.35;', 'old = doc.power || {}, packing = 0.9;', "packing fraction above the limit"],
  [H, 'num(d ? (d.particlePower * packing) / d.particleVolume / 1e6 : 100)', 'num(d ? (d.particlePower * packing) / d.kernelVolume / 1e6 : 100)', "compact density from the kernel volume"],
  [H, 'num(d ? d.kernelPowerDensity / 1e6 : 600)', 'num(d ? d.kernelPowerDensity / 1e3 : 600)', "kernel density unit"],
  [H, 'if (old.radialShape !== undefined) power.radialShape = old.radialShape;', '', "radial shape dropped"],
  [H, 'p.particlePower !== undefined ? "particle" : p.compactPowerDensity !== undefined ? "compact" : "kernel-density"', 'p.particlePower !== undefined ? "particle" : p.compactPowerDensity !== undefined ? "kernel-density" : "compact"', "power forms swapped"],
  // radii, temperatures, rows
  [H, 'const LENGTH_M = { um: 1e-6, "µm": 1e-6, mm: 1e-3, cm: 1e-2, m: 1 };', 'const LENGTH_M = { um: 1e-6, "µm": 1e-6, mm: 1e-2, cm: 1e-2, m: 1 };', "mm in cm"],
  [H, 'layers.push({ name: String(l.name), inner: r, outer: r + t }); r += t; }', 'layers.push({ name: String(l.name), inner: r, outer: r + t }); }', "radii not accumulated"],
  [H, 'if (r <= pts[0].r) return pts[0].T;', 'if (r <= pts[0].r) return pts[pts.length - 1].T;', "temperature below the first point"],
  [H, 'return pts[i - 1].T + ((pts[i].T - pts[i - 1].T) * (r - pts[i - 1].r)) / (pts[i].r - pts[i - 1].r || 1);', 'return pts[i].T;', "no interpolation"],
  [H, '\n  return pts[pts.length - 1].T;', '\n  return pts[0].T;', "temperature beyond the last point"],
  [H, 'const nominal = [{ name: "kernel", inner: 0, outer: norm.kernelRadius }]', 'const nominal = [{ name: "kernel", inner: 0, outer: norm.outerRadius }]', "kernel row's outer radius"],
  [H, 'drop: g.drop, hottest: g.hottestCellT, coldest: g.coldestCellT }; });', 'drop: g.drop, hottest: g.coldestCellT, coldest: g.hottestCellT }; });', "hottest and coldest swapped"],
  [H, 'v.forEach((x, i) => { if (x > v[k]) k = i; }); return { name, peak: v[k], time: rec.times[k] }; });', 'v.forEach((x, i) => { if (x < v[k]) k = i; }); return { name, peak: v[k], time: rec.times[k] }; });', "coldest instead of hottest peak"],
  [H, 'return { name, peak: v[k], time: rec.times[k] }; });', 'return { name, peak: v[k], time: rec.times[0] }; });', "peak time taken at the start"],
  [H, 'const span = Math.max(hi - lo, 50), lines = [], off = [];', 'const span = Math.max(hi - lo, 5), lines = [], off = [];', "limit window too narrow"],
  [H, 'if (l.maxTemperature >= lo - span && l.maxTemperature <= hi + span) lines.push', 'if (l.maxTemperature <= hi + span) lines.push', "limits far below drawn"],
  [H, 'if (l.maxTemperature >= lo - span && l.maxTemperature <= hi + span) lines.push', 'if (l.maxTemperature >= lo - span) lines.push', "limits far above drawn"],
  [H, 'e += 0.5 * (power[i] + power[i - 1]) * (times[i] - times[i - 1]);', 'e += power[i] * (times[i] - times[i - 1]);', "energy by rectangles"],
  // the explorer
  [H, 'items.push([n, PARTICLE_LAYER_LABEL[n], "Materials", ["/materials/" + n]]);', 'items.push([n, PARTICLE_LAYER_LABEL[n], "Materials", ["/material/" + n]]);', "material items' prefix"],
  [H, '\n    ["power", "Power", "Operating conditions", ["/power", "/assumptions", "/transient"]],', '\n    ["power", "Power", "Operating conditions", ["/power", "/assumptions"]],', "transient errors not on the power item"],
  [H, 'function particleFallbackItem(field) { return field === "/materials" ? "kernel" : field.startsWith("/materials/") ? "geometry" : null; }', 'function particleFallbackItem(field) { return field === "/materials" ? "geometry" : field.startsWith("/materials/") ? "kernel" : null; }', "fallback items swapped"],
  [H, 'return ["kernel"].concat(ls.filter((l) => l && PARTICLE_LAYER_NAMES.includes(l.name)).map((l) => l.name));', 'return ["kernel"].concat(ls.map((l) => l.name));', "unknown layer names in the regions"],
  // the page's wiring
  [H, 'if (isParticle() && selected !== "boundary") { renderParticleProps(p); return; }', 'if (isParticle() && selected === "boundary") { renderParticleProps(p); return; }', "boundary item routed to the particle's panels"],
  [H, 'const items = () => (isParticle() ? particleItems() : ITEMS);', 'const items = () => (isParticle() ? ITEMS : ITEMS);', "particle's items not used"],
  [H, 'if (result.triso) { particleChecks(o, row); return; }', 'if (result.triso) { return; }', "particle's checks not shown"],
  [H, 'if (bs.length !== its.length) return;', 'if (false) return;', "stale tree not skipped"],
  [H, 'const ensureSelected = () => { if (doc && !items().some((i) => i[0] === selected)) selected = "power"; };', 'const ensureSelected = () => {};', "selected item not repaired"],
  [H, 'drawStackResults(null); particleResultsOff();', 'drawStackResults(null);', "particle's results elements not reset"],
  [H, 'doc = await (await fetch("/api/pin/" + encodeURIComponent(id))).json(); dropParticleRun();', 'doc = await (await fetch("/api/pin/" + encodeURIComponent(id))).json();', "pin load keeps a particle's run"],
  [H, 'doc = await (await fetch("/api/example")).json(); dropParticleRun();', 'doc = await (await fetch("/api/example")).json();', "example load keeps a particle's run"],
  [H, 'doc = JSON.parse(await f.text()); dropParticleRun();', 'doc = JSON.parse(await f.text());', "open keeps a particle's run"],
  [H, 'if (isParticle()) $("caseBanner").textContent = (doc.transient && doc.transient.boundaryHistory ?', 'if (false) $("caseBanner").textContent = (doc.transient && doc.transient.boundaryHistory ?', "particle banner not shown"],
  [H, '$("rBanner").textContent = PARTICLE_LABEL + ". " + $("rBanner").textContent;', '', "results banner without the label"],
  [H, 'if (part) { drawParticle(); drawParticleProfile(); drawBoundaryHistoryPlotParticle(); return; }', 'if (part) { drawParticle(); drawParticleProfile(); return; }', "coolant table plot not drawn for a particle"],
  [H, 'lengthUm: ["um", "mm", "cm", "m"],', 'lengthUm: ["mm", "cm", "m"],', "micrometres not offered"],
  // the closed-form profile and the server
  [P, 'const count = i === 0 ? TRISO_PROFILE_POINTS.kernel : TRISO_PROFILE_POINTS.layer;', 'const count = i === 0 ? TRISO_PROFILE_POINTS.layer : TRISO_PROFILE_POINTS.kernel;', "profile point counts swapped"],
  [P, 'const r = reg.innerRadius + ((reg.outerRadius - reg.innerRadius) * k) / (count - 1);', 'const r = reg.innerRadius + ((reg.outerRadius - reg.innerRadius) * k) / count;', "profile does not reach the outer face"],
  [P, 'const sample = k === 0 && i > 0 ? Math.min(reg.outerRadius, r * (1 + 1e-9)) : r;', 'const sample = r;', "gap jump lost (inner face read from the layer before)"],
  [P, 'out.push({ r, T: f.temperatureAt(sample), region: reg.name });', 'out.push({ r, T: f.temperatureAt(sample), region: "kernel" });', "every point in the kernel"],
  [S, 'derived: trisoDerived(v.triso), profile: trisoProfile(v.triso) } };', 'derived: trisoDerived(v.triso) } };', "profile not in the response"],
];

const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const list = mutants.filter((m) => !only || only.test(m[3]));
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
for (const [file, from, to, name] of list) {
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
