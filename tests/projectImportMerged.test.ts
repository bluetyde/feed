// FEED's importer on a project that SEED has merged OpenMC Studio's entries into (TODO "Material round trip with real OpenMC": the part only FEED can check, asked for by the SEED
// agent on 2026-10-14). The two fixtures are real: `before` is OpenMC Studio's own fixture project (test/fixtures/seed/seed.project.json of the Studio checkout), `after` is what
// SEED's own planner and project store (src/core/materialMerge.ts, projectStore.ts) made of it when Studio's own command line exported a denser fuel (10.4 to 10.6 g/cm3) and a new
// steel: made by scripts/check-merged-project.cjs, which runs that pipeline and then these same checks. This test needs neither SEED nor Studio: the merged project is the evidence.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, importMaterial, listMaterials, readProjectAsync, toProjectMaterial } from "../src/core/projectImport";

const dir = join(__dirname, "fixtures", "merged-project");
const before = JSON.parse(readFileSync(join(dir, "before.seed.project.json"), "utf8"));
const afterText = readFileSync(join(dir, "after.seed.project.json"), "utf8");
const after = JSON.parse(afterText);
const byId = (m: any, id: string) => m.materials.find((x: any) => x.id === id);
const tmp = mkdtempSync(join(tmpdir(), "feed-merged-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
writeFileSync(join(tmp, "seed.project.json"), afterText);

describe("the fixtures are what they say", () => {
  it("the merge changed the fuel to revision 4 with the new density, added a steel, and left everything else byte for byte", () => {
    expect(byId(before, "mat-fuel").revision).toBe(3);
    expect(byId(after, "mat-fuel").revision).toBe(4);
    expect(byId(before, "mat-fuel").sets["openmc.composition"].density).toBe(10.4);
    expect(byId(after, "mat-fuel").sets["openmc.composition"].density).toBe(10.6);
    expect(byId(after, "mat-steel")).toMatchObject({ revision: 1, name: "Steel" });
    for (const id of ["mat-water", "mat-thermal-only", "mat-old-schema", "mat-other-writer"]) expect(canonicalJson(byId(after, id)), id).toBe(canonicalJson(byId(before, id)));
    for (const k of ["thermal.conductivity", "vendor.notes"]) expect(canonicalJson(byId(after, "mat-fuel").sets[k]), k).toBe(canonicalJson(byId(before, "mat-fuel").sets[k]));
  });
});

describe("FEED reads the merged project", () => {
  it("by the folder and by the file, whole: six materials, none lost", async () => {
    for (const p of [tmp, join(tmp, "seed.project.json")]) {
      const r = await readProjectAsync(p);
      expect(r.ok, p).toBe(true);
      if (r.ok) expect(r.manifest.materials).toHaveLength(6);
    }
  });
  it("lists what each material offers FEED: the fuel (revision 4) has a conductivity and no heat capacity, the new steel has neither, the thermal-only material has a conductivity", async () => {
    const r = await readProjectAsync(tmp);
    if (!r.ok) throw new Error("read failed");
    const list = Object.fromEntries(listMaterials(r.manifest).map((m) => [m.id, m]));
    expect(Object.keys(list)).toEqual(["mat-fuel", "mat-water", "mat-thermal-only", "mat-old-schema", "mat-other-writer", "mat-steel"]);
    expect(list["mat-fuel"]).toMatchObject({ revision: 4, thermal: { "thermal.conductivity": "ready", "thermal.volumetricHeatCapacity": "missing" } });
    expect(list["mat-steel"]).toMatchObject({ revision: 1, thermal: { "thermal.conductivity": "missing", "thermal.volumetricHeatCapacity": "missing" } });
    expect(list["mat-thermal-only"]!.thermal["thermal.conductivity"]).toBe("ready");
  });
});

describe("FEED imports from the merged project", () => {
  const fuelBefore = importMaterial(before, { id: "mat-fuel", region: "fuel" });
  const fuelAfter = importMaterial(after, { id: "mat-fuel", region: "fuel" });
  it("the fuel's thermal conductivity, as FEED imports it, is exactly what it was before the merge, at the new revision", () => {
    expect(fuelBefore.ok && fuelAfter.ok).toBe(true);
    if (!fuelBefore.ok || !fuelAfter.ok) return;
    expect(fuelBefore.material.revision).toBe(3);
    expect(fuelAfter.material.revision).toBe(4);
    expect(canonicalJson(fuelAfter.material.sets["thermal.conductivity"])).toBe(canonicalJson(fuelBefore.material.sets["thermal.conductivity"]));
    expect(fuelAfter.material.origin).toMatchObject({ kind: "seed-project", materialId: "mat-fuel", revision: 4, projectId: after.projectId });
    expect(fuelAfter.missing.map((m) => m.set)).toEqual(["thermal.volumetricHeatCapacity"]);
  });
  it("Studio's composition set (the new density, the enrichment, the conditions) and the vendor's set are carried unread and unchanged; the vendor's __proto__ and constructor keys are data", () => {
    if (!fuelAfter.ok) throw new Error("import failed");
    const sets = fuelAfter.material.sets;
    expect(canonicalJson(sets["openmc.composition"])).toBe(canonicalJson(byId(after, "mat-fuel").sets["openmc.composition"]));
    expect((sets["openmc.composition"] as any).density).toBe(10.6);
    const vendor = sets["vendor.notes"] as Record<string, unknown>;
    expect(canonicalJson(vendor)).toBe(canonicalJson(byId(before, "mat-fuel").sets["vendor.notes"]));
    expect(Object.keys(vendor)).toEqual(Object.keys(byId(before, "mat-fuel").sets["vendor.notes"]));
    expect(Object.prototype.hasOwnProperty.call(vendor, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(vendor)).toBe(Object.prototype);
    expect(vendor.constructor).toBe("kept");
    // nothing leaked onto the prototype of an ordinary object
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(fuelAfter.notes.some((n) => /openmc\.composition: another app's set, kept exactly/.test(n))).toBe(true);
    expect(fuelAfter.notes.some((n) => /vendor\.notes: another app's set, kept exactly/.test(n))).toBe(true);
  });
  it("a material with no thermal set (the water, the new steel) is imported with both sets named as missing and the case's own rule saying it cannot run yet", () => {
    for (const [id, region] of [["mat-water", "cladding"], ["mat-steel", "cladding"]] as const) {
      const r = importMaterial(after, { id, region });
      expect(r.ok, id).toBe(true);
      if (!r.ok) continue;
      expect(r.missing.map((m) => m.set)).toEqual(["thermal.conductivity", "thermal.volumetricHeatCapacity"]);
      expect(r.problems.length, id).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys((importMaterial(after, { id: "mat-steel", region: "cladding" }) as any).material.sets)).toEqual(["openmc.composition"]);
  });
  it("the materials Studio skipped import exactly as before the merge", () => {
    for (const id of ["mat-thermal-only", "mat-old-schema", "mat-other-writer"]) {
      const a = importMaterial(before, { id, region: "fuel" });
      const b = importMaterial(after, { id, region: "fuel" });
      expect(canonicalJson(b), id).toBe(canonicalJson(a));
    }
  });
  it("the revision is the project's: asking for the old revision 3 of the fuel from the merged project is refused, asking for 4 is not", () => {
    const old = importMaterial(after, { id: "mat-fuel", region: "fuel", revision: 3 });
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.errors[0]!.code).toBe("E_IMPORT_REVISION");
    expect(importMaterial(after, { id: "mat-fuel", region: "fuel", revision: 4 }).ok).toBe(true);
  });
  it("the round trip back is lossless: FEED's export of the imported fuel reproduces the merged project's three sets exactly", () => {
    if (!fuelAfter.ok) throw new Error("import failed");
    const back = toProjectMaterial(fuelAfter.material, byId(after, "mat-fuel").name, "sourced");
    for (const k of ["thermal.conductivity", "vendor.notes", "openmc.composition"]) expect(canonicalJson(back.sets[k]), k).toBe(canonicalJson(byId(after, "mat-fuel").sets[k]));
    expect(Object.keys(back.sets).sort()).toEqual(Object.keys(byId(after, "mat-fuel").sets).sort());
  });
  it("reading does not change the project: the file is the same bytes after every call above", async () => {
    await readProjectAsync(tmp);
    expect(readFileSync(join(tmp, "seed.project.json"), "utf8")).toBe(afterText);
  });
});
