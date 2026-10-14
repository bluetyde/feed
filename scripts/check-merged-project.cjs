// The importer check of TODO line 104: FEED's importer on a project that SEED has merged OpenMC Studio's entries into.
// The pipeline is the one of SEED's tests/material-merge-studio.test.ts, run here with SEED's own compiled planner and project store (built into a scratch folder, SEED's tree untouched):
// Studio's fixture project -> Studio's `import` -> a person edits (the fuel gets denser, a steel is added) -> Studio's `export` -> SEED's merge (planMaterialMerge + saveProject) -> FEED's importer.
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const assert = require("assert");

const SEED_BUILD = process.argv[2];
const STUDIO = process.argv[3];
const FEED = process.argv[4];
const OUT = process.argv[5];
const seedRequire = (p) => require(path.join(SEED_BUILD, p));
const { createProject, openProject, saveProject } = seedRequire("core/projectStore.js");
const { planMaterialMerge } = seedRequire("core/materialMerge.js");
const { canonicalJson } = seedRequire("core/canonical.js");
const feed = require(path.join(FEED, "dist/core/projectImport.js"));

const studioFixture = path.join(STUDIO, "test/fixtures/seed/seed.project.json");
const studio = (args) => {
  const r = cp.spawnSync("python", ["-m", "openmc_studio.seed_materials", ...args], { encoding: "utf8", cwd: path.join(STUDIO, "studio"), env: { ...process.env, PYTHONPATH: path.join(STUDIO, "studio") }, timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
};
const report = { steps: [] };
const say = (s, ok = true) => { report.steps.push({ s, ok }); console.log((ok ? "ok   " : "FAIL ") + s); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "feed-merged-"));
const projectDir = path.join(root, "project");
assert.ok(createProject(projectDir, { name: "merged project check", seedVersion: "0.1.0" }).ok);
fs.copyFileSync(studioFixture, path.join(projectDir, "seed.project.json"));
const opened = openProject(projectDir);
assert.ok(opened.ok, JSON.stringify(opened));
const original = JSON.parse(fs.readFileSync(studioFixture, "utf8"));
const byId = (m, id) => m.materials.find((x) => x.id === id);

// Studio reads, a person edits, Studio exports
const imported = studio(["import", path.join(projectDir, "seed.project.json")]);
const edited = imported.materials.map((m) => (m.id === "mat-fuel" ? { ...m, density: 10.6 } : m));
edited.push({ id: "mat-steel", name: "Steel", density: 7.8, frac: "wo", comps: "Fe56:1", sab: "", ref: "assumed value" });
const studioFile = path.join(root, "studio.json");
fs.writeFileSync(studioFile, JSON.stringify({ materials: edited }));
const exported = studio(["export", studioFile, "--project", path.join(projectDir, "seed.project.json")]);
const entries = Array.isArray(exported) ? exported : exported.entries;
assert.deepStrictEqual(entries.map((e) => [e.id, e.revision]), [["mat-fuel", 4], ["mat-water", 1], ["mat-steel", 1]]);

// SEED merges (its planner and its store: the same two calls the admin verb makes)
const before = openProject(projectDir).value;
const plan = planMaterialMerge(before.manifest, entries, ["openmc.composition"]);
assert.ok(plan.ok, JSON.stringify(plan));
const saved = saveProject(projectDir, plan.manifest, before.revision, { waitMs: 5000 });
assert.ok(saved.ok, JSON.stringify(saved));
const mergedPath = path.join(projectDir, "seed.project.json");
const merged = JSON.parse(fs.readFileSync(mergedPath, "utf8"));
say("SEED merged Studio's entries: " + plan.changes.map((c) => c.id + " " + c.action).join(", "));

// ---- FEED's importer on the merged project
(async () => {
  const read = await feed.readProjectAsync(projectDir);
  assert.ok(read.ok, JSON.stringify(read));
  say("FEED reads the merged project (a folder path): schema " + read.manifest.schema + ", " + read.manifest.materials.length + " materials");
  const readFile = await feed.readProjectAsync(mergedPath);
  assert.ok(readFile.ok);
  say("FEED reads it by the path of seed.project.json too");

  const list = feed.listMaterials(read.manifest);
  const info = Object.fromEntries(list.map((m) => [m.id, m]));
  report.list = list;
  assert.deepStrictEqual(list.map((m) => m.id), ["mat-fuel", "mat-water", "mat-thermal-only", "mat-old-schema", "mat-other-writer", "mat-steel"]);
  assert.strictEqual(info["mat-fuel"].revision, 4);
  assert.strictEqual(info["mat-fuel"].thermal["thermal.conductivity"], "ready");
  assert.strictEqual(info["mat-fuel"].thermal["thermal.volumetricHeatCapacity"], "missing");
  assert.strictEqual(info["mat-steel"].revision, 1);
  assert.strictEqual(info["mat-steel"].thermal["thermal.conductivity"], "missing");
  assert.strictEqual(info["mat-thermal-only"].thermal["thermal.conductivity"], "ready");
  say("listMaterials: mat-fuel is revision 4 with a ready conductivity, the new steel is revision 1 with none, the thermal-only material is ready; " + list.length + " materials, none lost");

  // the fuel: FEED's thermal set is read exactly as before the merge; Studio's set and the vendor set are kept untouched
  const fuelBefore = feed.importMaterial({ ...original, materials: original.materials }, { id: "mat-fuel", region: "fuel" });
  const fuelAfter = feed.importMaterial(read.manifest, { id: "mat-fuel", region: "fuel" });
  assert.ok(fuelBefore.ok && fuelAfter.ok, JSON.stringify([fuelBefore, fuelAfter]));
  assert.strictEqual(fuelBefore.material.revision, 3);
  assert.strictEqual(fuelAfter.material.revision, 4);
  assert.strictEqual(canonicalJson(fuelAfter.material.sets["thermal.conductivity"]), canonicalJson(fuelBefore.material.sets["thermal.conductivity"]));
  say("the fuel's thermal.conductivity as FEED imports it is byte for byte what it was before the merge (revision 3 -> 4, set unchanged)");
  assert.strictEqual(canonicalJson(fuelAfter.material.sets["vendor.notes"]), canonicalJson(original.materials[0].sets["vendor.notes"]));
  assert.deepStrictEqual(Object.keys(fuelAfter.material.sets["vendor.notes"]), Object.keys(original.materials[0].sets["vendor.notes"]));
  assert.ok(Object.prototype.hasOwnProperty.call(fuelAfter.material.sets["vendor.notes"], "__proto__"), "the __proto__ key is an own key of the kept set");
  assert.strictEqual(Object.getPrototypeOf(fuelAfter.material.sets["vendor.notes"]), Object.prototype);
  say("the vendor's set, with its __proto__ and constructor keys, is kept exactly and as data (an own key, the prototype untouched)");
  assert.strictEqual(fuelAfter.material.sets["openmc.composition"].density, 10.6);
  assert.strictEqual(canonicalJson(fuelAfter.material.sets["openmc.composition"]), canonicalJson(byId(merged, "mat-fuel").sets["openmc.composition"]));
  say("Studio's set (the new density 10.6, its enrichment and conditions) is carried through unread and unchanged");
  assert.ok(fuelAfter.notes.some((n) => /openmc\.composition: another app's set, kept exactly/.test(n)));
  assert.strictEqual(fuelAfter.missing.map((m) => m.set).join(","), "thermal.volumetricHeatCapacity");
  assert.strictEqual(fuelAfter.material.origin.revision, 4);
  assert.strictEqual(fuelAfter.material.origin.projectId, merged.projectId);
  say("the origin records the project and revision 4; the missing heat capacity is named: " + fuelAfter.missing.map((m) => m.set + " (" + m.neededFor + ")").join(", "));
  report.fuel = { before: fuelBefore.material.revision, after: fuelAfter.material.revision, problems: fuelAfter.problems.length, notes: fuelAfter.notes };

  // the water: the entry for it was unchanged, so the project holds it byte for byte; it has no FEED set
  const water = feed.importMaterial(read.manifest, { id: "mat-water", region: "cladding" });
  assert.ok(water.ok);
  assert.strictEqual(water.missing.length, 2);
  assert.ok(water.problems.length >= 1, "a material without a conductivity is imported and the case names what it lacks");
  say("a material with no thermal set (the water) is imported with both sets named as missing, and the case's own rule says it cannot run yet");

  // the new steel: FEED can import it (nothing thermal) and says what it lacks
  const steel = feed.importMaterial(read.manifest, { id: "mat-steel", region: "cladding" });
  assert.ok(steel.ok, JSON.stringify(steel));
  assert.strictEqual(steel.material.revision, 1);
  assert.deepStrictEqual(Object.keys(steel.material.sets), ["openmc.composition"]);
  say("the steel Studio added is importable (revision 1, only Studio's set, both thermal sets missing)");

  // the skipped materials are untouched by the merge and FEED reads them as before
  for (const id of ["mat-thermal-only", "mat-old-schema", "mat-other-writer"]) assert.strictEqual(canonicalJson(byId(merged, id)), canonicalJson(byId(original, id)));
  const th = feed.importMaterial(read.manifest, { id: "mat-thermal-only", region: "fuel" });
  const thBefore = feed.importMaterial(original, { id: "mat-thermal-only", region: "fuel" });
  assert.strictEqual(canonicalJson(th), canonicalJson(thBefore));
  say("the materials Studio skipped are untouched by the merge, and FEED's import of the thermal-only one is identical before and after");

  // a stale revision: importing with the OLD revision (3) from the merged project is refused (a revision is immutable)
  const stale = feed.importMaterial(read.manifest, { id: "mat-fuel", region: "fuel", revision: 3 });
  assert.ok(!stale.ok && stale.errors[0].code === "E_IMPORT_REVISION");
  say("asking for the old revision 3 of the fuel from the merged project is refused (E_IMPORT_REVISION): the project now holds 4");

  // the round trip back: FEED's own material -> the project form (toProjectMaterial) keeps the vendor and Studio sets, and the thermal set returns in SEED's form
  const back = feed.toProjectMaterial(fuelAfter.material, "UO2 fuel 3.1 %", "sourced");
  assert.strictEqual(canonicalJson(back.sets["thermal.conductivity"]), canonicalJson(byId(merged, "mat-fuel").sets["thermal.conductivity"]));
  assert.strictEqual(canonicalJson(back.sets["vendor.notes"]), canonicalJson(byId(merged, "mat-fuel").sets["vendor.notes"]));
  assert.strictEqual(canonicalJson(back.sets["openmc.composition"]), canonicalJson(byId(merged, "mat-fuel").sets["openmc.composition"]));
  say("FEED's export of the imported fuel (toProjectMaterial) reproduces the merged project's three sets exactly: the round trip is lossless");

  // the manifest the project holds is not changed by reading it
  assert.strictEqual(fs.readFileSync(mergedPath, "utf8"), JSON.stringify(JSON.parse(fs.readFileSync(mergedPath, "utf8")), null, 2) + "\n");
  fs.writeFileSync(OUT, JSON.stringify({ ...report, project: projectDir }, null, 2));
  console.log("all checks passed; project kept at " + projectDir);
})().catch((e) => {
  console.log("FAIL: " + (e && e.stack ? e.stack : e));
  report.error = String(e && e.message);
  fs.writeFileSync(OUT, JSON.stringify({ ...report, project: projectDir }, null, 2));
  process.exit(1);
});
