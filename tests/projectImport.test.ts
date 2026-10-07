// Importing a material from a SEED project (src/core/projectImport.ts, docs/seed-material-import.md): reading the manifest, listing, importing by id and revision,
// keeping other apps' sets exactly, naming what is missing, the new-revision rule when a thermal set is added, and the routes.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importMaterial, listMaterials, MAX_MANIFEST_BYTES, readProject, setsHash, THERMAL_SET_SCHEMA, toProjectMaterial } from "../src/core/projectImport";
import { saveUserMaterial } from "../src/core/userLibrary";
import { validateCase } from "../src/core/validate";
import { server } from "../src/server/server";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const COMPOSITION = { schema: "openmc.composition/0.1", units: "g/cm3", enrichment: 0.045, nuclides: [{ name: "U235", fraction: 0.045 }], extra: { __proto__x: 1, deep: [1, { a: 2 }] } };
const thermalK = () => ({ schema: THERMAL_SET_SCHEMA, model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K"), source: { kind: "sourced", text: "a datasheet" } });
const thermalC = () => ({ schema: THERMAL_SET_SCHEMA, model: "constant", value: q(3, "MJ/m3/K"), referenceTemperature: q(300, "K"), source: { kind: "assumed", text: "a guess" } });

const manifest = (materials: unknown[]) => ({ schema: "seed.project/0.1", projectId: "proj-1", name: "Test project", created: "2026-10-06T10:00:00Z", updated: "2026-10-06T10:00:00Z", seedVersion: "0.1.0", folders: { models: "models", runs: "runs", studies: "studies", oracles: "oracles" }, artifacts: [], materials });
const mat = (id: string, revision: number, sets: Record<string, unknown>, name = "A material") => ({ id, revision, name, sets });
const project = (materials: unknown[]) => {
  const dir = mkdtempSync(join(tmpdir(), "feed-project-"));
  writeFileSync(join(dir, "seed.project.json"), JSON.stringify(manifest(materials), null, 2));
  return dir;
};
const get = (dir: string) => {
  const r = readProject(dir);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.manifest;
};
const FUEL = mat("mat-fuel", 3, { "openmc.composition": COMPOSITION, "thermal.conductivity": thermalK(), "thermal.volumetric_heat_capacity": thermalC() }, "UO2 4.5%");
const BARE = mat("mat-bare", 1, { "openmc.composition": COMPOSITION }, "Composition only");

describe("reading a project", () => {
  it("takes the folder or the manifest file, and reads the manifest", () => {
    const dir = project([FUEL]);
    const a = readProject(dir);
    const b = readProject(join(dir, "seed.project.json"));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) expect(a.manifest.projectId).toBe("proj-1");
  });

  it("refuses what is not a project, each with its code and its reason", () => {
    const bad = (path: unknown) => {
      const r = readProject(path);
      expect(r.ok).toBe(false);
      return r.ok ? [] : r.errors;
    };
    expect(bad(undefined)[0]!.code).toBe("E_IMPORT_PROJECT");
    expect(bad("")[0]!.code).toBe("E_IMPORT_PROJECT");
    expect(bad("C:\\no\\such\\place")[0]!.message).toMatch(/seed\.project\.json/);
    expect(bad("x".repeat(1001))[0]!.code).toBe("E_IMPORT_PROJECT");
    const dir = mkdtempSync(join(tmpdir(), "feed-project-"));
    expect(bad(dir)[0]!.message).toMatch(/no seed\.project\.json at/);
    writeFileSync(join(dir, "other.json"), "{}");
    expect(bad(join(dir, "other.json"))[0]!.message).toMatch(/reads only a file named seed\.project\.json/);
    writeFileSync(join(dir, "seed.project.json"), "{broken");
    expect(bad(dir)[0]!.message).toMatch(/not valid JSON/);
    writeFileSync(join(dir, "seed.project.json"), JSON.stringify({ schema: "seed.project/9.9", projectId: "p", materials: [] }));
    expect(bad(dir)[0]!.message).toMatch(/not a seed\.project\/0\.1 project/);
    writeFileSync(join(dir, "seed.project.json"), JSON.stringify({ schema: "seed.project/0.1", materials: [] }));
    expect(bad(dir)[0]!.message).toMatch(/no projectId/);
    writeFileSync(join(dir, "seed.project.json"), "[]");
    expect(bad(dir)[0]!.message).toMatch(/missing/);
    writeFileSync(join(dir, "seed.project.json"), " ".repeat(MAX_MANIFEST_BYTES + 1));
    expect(bad(dir)[0]!.message).toMatch(/larger than/);
    // a folder named seed.project.json is a folder, not a file to read
    const odd = mkdtempSync(join(tmpdir(), "feed-project-"));
    mkdirSync(join(odd, "seed.project.json"));
    expect(bad(odd)[0]!.code).toBe("E_IMPORT_PROJECT");
  });
});

describe("listing", () => {
  it("lists each material with its sets and what each thermal set is", () => {
    const foreign = mat("mat-foreign", 2, { "thermal.conductivity": { schema: "other.thing/1", k: 1 } });
    const list = listMaterials(get(project([FUEL, BARE, foreign, { notAMaterial: true }])));
    expect(list.map((m) => m.id)).toEqual(["mat-fuel", "mat-bare", "mat-foreign"]);
    expect(list[0]).toMatchObject({ revision: 3, name: "UO2 4.5%", sets: ["openmc.composition", "thermal.conductivity", "thermal.volumetric_heat_capacity"], thermal: { "thermal.conductivity": "ready", "thermal.volumetricHeatCapacity": "ready" } });
    expect(list[1]!.thermal).toEqual({ "thermal.conductivity": "missing", "thermal.volumetricHeatCapacity": "missing" });
    expect(list[2]!.thermal["thermal.conductivity"]).toBe("foreign");
  });
});

describe("importing", () => {
  const m = () => get(project([FUEL, BARE]));

  it("a material with FEED's thermal sets is imported whole: the source text, the project's record of it, the other app's set exactly, an origin", () => {
    const r = importMaterial(m(), { id: "mat-fuel", region: "fuel" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.material.materialId).toBe("mat-fuel");
    expect(r.material.revision).toBe(3);
    const k = r.material.sets["thermal.conductivity"] as Record<string, unknown>;
    expect(k.source).toBe("a datasheet");
    expect(k.sourceRecord).toEqual({ kind: "sourced", text: "a datasheet" });
    expect(k.value).toEqual(q(3, "W/m/K"));
    expect(r.material.sets["openmc.composition"]).toEqual(COMPOSITION); // kept exactly, including what FEED does not understand
    expect(r.missing).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.material.origin).toEqual({ kind: "seed-project", projectId: "proj-1", materialId: "mat-fuel", revision: 3, name: "UO2 4.5%", setsSha256: setsHash(r.material.sets) });
    expect(r.notes.some((n) => /openmc\.composition: another app's set, kept exactly/.test(n))).toBe(true);
    expect(r.notes.some((n) => /thermal\.volumetric_heat_capacity: the project marks its source "assumed"/.test(n))).toBe(true);
    expect(r.notes.some((n) => /thermal\.conductivity: the project marks/.test(n))).toBe(false); // sourced needs no note
  });

  it("the project is not changed, and the copy shares nothing with it", () => {
    const man = m();
    const before = JSON.stringify(man);
    const r = importMaterial(man, { id: "mat-fuel", region: "fuel" });
    if (!r.ok) throw new Error("refused");
    (r.material.sets["openmc.composition"] as { enrichment: number }).enrichment = 0.9;
    ((r.material.sets["thermal.conductivity"] as { value: { value: number } }).value).value = 99;
    expect(JSON.stringify(man)).toBe(before);
  });

  it("a material with no thermal set is imported and the missing ones are named, with what each is for; the case's own rules say the same", () => {
    const r = importMaterial(m(), { id: "mat-bare", region: "cladding" });
    if (!r.ok) throw new Error("refused");
    expect(r.missing).toEqual([{ set: "thermal.conductivity", neededFor: "every run" }, { set: "thermal.volumetricHeatCapacity", neededFor: "a transient (a pulse)" }]);
    expect(r.problems.map((p) => p.code + " " + p.field)).toEqual(["E_PROP_MISSING /materials/cladding/sets/thermal.conductivity"]);
    expect(r.material.sets["openmc.composition"]).toEqual(COMPOSITION);
  });

  it("only the heat capacity missing: named, and the material still works for a steady case", () => {
    const man = get(project([mat("mat-k-only", 1, { "thermal.conductivity": thermalK() })]));
    const r = importMaterial(man, { id: "mat-k-only", region: "fuel" });
    if (!r.ok) throw new Error("refused");
    expect(r.missing).toEqual([{ set: "thermal.volumetricHeatCapacity", neededFor: "a transient (a pulse)" }]);
    expect(r.problems).toEqual([]);
  });

  it("a revision, if given, must be the project's; an unknown id and an id FEED cannot carry are refused with their codes", () => {
    const man = m();
    expect(importMaterial(man, { id: "mat-fuel", region: "fuel", revision: 3 }).ok).toBe(true);
    const wrong = importMaterial(man, { id: "mat-fuel", region: "fuel", revision: 2 });
    expect(wrong.ok ? "" : wrong.errors[0]!.code).toBe("E_IMPORT_REVISION");
    expect(wrong.ok ? "" : wrong.errors[0]!.message).toMatch(/revision 3, not 2/);
    const none = importMaterial(man, { id: "mat-nope", region: "fuel" });
    expect(none.ok ? "" : none.errors[0]!.code).toBe("E_IMPORT_NOT_FOUND");
    const byName = importMaterial(man, { id: "UO2 4.5%", region: "fuel" });
    expect(byName.ok ? "" : byName.errors[0]!.message).toMatch(/a name is not an id/);
    const odd = get(project([mat("Mat_Fuel", 1, { "thermal.conductivity": thermalK() })]));
    const r = importMaterial(odd, { id: "Mat_Fuel", region: "fuel" });
    expect(r.ok ? "" : r.errors[0]!.code).toBe("E_IMPORT_ID");
    expect(importMaterial(man, { id: "mat-fuel", region: "plenum" }).ok).toBe(false);
    expect(importMaterial(man, { id: "", region: "fuel" }).ok).toBe(false);
    expect(importMaterial(man, { region: "fuel" }).ok).toBe(false);
  });

  it("a thermal-named set of another schema is another app's: refused, not guessed at", () => {
    const man = get(project([mat("mat-other", 1, { "thermal.conductivity": { schema: "otherapp.k/2", table: [[300, 3]] } })]));
    const r = importMaterial(man, { id: "mat-other", region: "fuel" });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors[0]!.code).toBe("E_IMPORT_FOREIGN_SET");
    const noSchema = get(project([mat("mat-other", 1, { "thermal.conductivity": { model: "constant" } })]));
    expect(importMaterial(noSchema, { id: "mat-other", region: "fuel" }).ok).toBe(false);
  });

  it("a thermal set without a usable source is refused", () => {
    const bad = (source: unknown) => {
      const k: Record<string, unknown> = { ...thermalK(), source };
      if (source === undefined) delete k.source;
      const man = get(project([mat("mat-src", 1, { "thermal.conductivity": k })]));
      const r = importMaterial(man, { id: "mat-src", region: "fuel" });
      return r.ok ? "ok" : r.errors[0]!.code + " " + r.errors[0]!.field;
    };
    expect(bad(undefined)).toBe("E_IMPORT_SET /sets/thermal.conductivity/source");
    expect(bad({ kind: "guessed", text: "x" })).toBe("E_IMPORT_SET /sets/thermal.conductivity/source");
    expect(bad({ kind: "sourced", text: "  " })).toBe("E_IMPORT_SET /sets/thermal.conductivity/source");
    expect(bad({ kind: "sourced" })).toBe("E_IMPORT_SET /sets/thermal.conductivity/source");
    expect(bad("a plain string")).toBe("ok"); // FEED's own form is accepted too
  });

  it("a bad set name, a set that is not an object, a material with no sets or no valid revision is refused", () => {
    const one = (material: unknown) => {
      const r = importMaterial(get(project([material])), { id: "mat-x1", region: "fuel" });
      return r.ok ? "ok" : r.errors[0]!.code;
    };
    expect(one(mat("mat-x1", 1, { "Bad Name": {} }))).toBe("E_IMPORT_SET");
    expect(one(mat("mat-x1", 1, { "openmc.composition": 5 }))).toBe("E_IMPORT_SET");
    expect(one({ id: "mat-x1", revision: 1, name: "n" })).toBe("E_IMPORT_PROJECT");
    expect(one(mat("mat-x1", 0, {}))).toBe("E_IMPORT_PROJECT");
    expect(one(mat("mat-x1", 1.5, {}))).toBe("E_IMPORT_PROJECT");
  });

  it("the imported material is a material a case accepts, and a case with it validates and runs the same checks", () => {
    const r = importMaterial(m(), { id: "mat-fuel", region: "fuel" });
    if (!r.ok) throw new Error("refused");
    const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pulse.json"), "utf8"));
    d.materials.fuel = r.material;
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.fuelConductivity).toEqual({ kind: "constant", k: 3, referenceTemperature: 300 });
    expect(v.normalized!.fuelHeatCapacity).toMatchObject({ kind: "constant", c: 3e6 });
  });
});

describe("saving an imported material: the new-revision rule", () => {
  const withLibrary = <T>(f: () => T): T => {
    const saved = process.env.FEED_USER_LIBRARY;
    process.env.FEED_USER_LIBRARY = join(mkdtempSync(join(tmpdir(), "feed-lib-")), "materials.json");
    try {
      return f();
    } finally {
      if (saved === undefined) delete process.env.FEED_USER_LIBRARY;
      else process.env.FEED_USER_LIBRARY = saved;
    }
  };
  const imported = () => {
    const r = importMaterial(get(project([FUEL])), { id: "mat-fuel", region: "fuel" });
    if (!r.ok) throw new Error("refused");
    return r.material;
  };
  const save = (material: unknown) => saveUserMaterial({ region: "fuel", name: "Imported fuel", material }, new Set());

  it("sets as imported keep the project's revision; a changed set is the next revision; the other app's set stays as it was", () => {
    withLibrary(() => {
      const a = save(imported());
      expect(a.ok && a.status).toBe("saved");
      expect(a.ok && a.entry.material.revision).toBe(3);
      expect(a.ok && a.entry.material.origin?.projectId).toBe("proj-1");
    });
    withLibrary(() => {
      const m = imported();
      (m.sets["thermal.conductivity"] as { value: { value: number } }).value.value = 3.5; // a thermal set changed
      const b = save(m);
      expect(b.ok && b.entry.material.revision).toBe(4);
      expect(b.ok && b.entry.material.sets["openmc.composition"]).toEqual(COMPOSITION); // composition untouched
      // a later save is the latest plus one, and never below
      const m2 = JSON.parse(JSON.stringify(m));
      m2.sets["thermal.conductivity"].value.value = 3.6;
      const c = save(m2);
      expect(c.ok && c.entry.material.revision).toBe(5);
      // saving the same again is unchanged
      const d = save(m2);
      expect(d.ok && d.status).toBe("unchanged");
    });
  });

  it("a newer project revision imported later is not saved below the library's latest", () => {
    withLibrary(() => {
      const m = imported();
      m.sets["thermal.conductivity"] = { ...(m.sets["thermal.conductivity"] as object), value: q(3.5, "W/m/K") };
      expect(save(m).ok).toBe(true); // revision 4
      const again = imported(); // as imported: project revision 3 again, sets differ from the library's latest
      const r = save(again);
      expect(r.ok && r.entry.material.revision).toBe(5); // max(latest + 1, 3)
    });
  });

  it("a malformed origin is refused", () => {
    withLibrary(() => {
      const bad = (patch: Record<string, unknown>) => {
        const m = imported();
        m.origin = { ...m.origin, ...patch } as typeof m.origin;
        const r = save(m);
        return r.ok ? "ok" : r.errors[0]!.code + " " + r.errors[0]!.field;
      };
      expect(bad({})).toBe("ok");
    });
    const bad = (patch: Record<string, unknown>) =>
      withLibrary(() => {
        const m = imported();
        m.origin = { ...m.origin, ...patch } as typeof m.origin;
        const r = save(m);
        return r.ok ? "ok" : r.errors[0]!.code + " " + r.errors[0]!.field;
      });
    for (const patch of [{ kind: "elsewhere" }, { projectId: "" }, { materialId: "other-id" }, { revision: 0 }, { revision: 1.5 }, { name: "x".repeat(121) }, { setsSha256: "abc" }, { projectId: "p".repeat(201) }]) {
      expect(bad(patch), JSON.stringify(patch)).toBe("E_SCHEMA_INVALID /material/origin");
    }
  });

  it("a material that is not imported keeps the old rule: revision 1 for a new id, whatever it carried", () => {
    withLibrary(() => {
      const m = imported();
      delete (m as { origin?: unknown }).origin;
      m.revision = 7;
      const r = save(m);
      expect(r.ok && r.entry.material.revision).toBe(1);
    });
  });
});

describe("exporting a material in the project's form", () => {
  it("thermal sets get the schema and SEED's source record, other sets are carried as they are, and an import of it gives the same material", () => {
    const man = get(project([FUEL]));
    const first = importMaterial(man, { id: "mat-fuel", region: "fuel" });
    if (!first.ok) throw new Error("refused");
    const out = toProjectMaterial(first.material, "UO2 4.5%");
    expect(out.id).toBe("mat-fuel");
    expect(out.revision).toBe(3);
    expect(out.sets["openmc.composition"]).toEqual(COMPOSITION);
    const k = out.sets["thermal.conductivity"] as Record<string, unknown>;
    expect(k.schema).toBe(THERMAL_SET_SCHEMA);
    expect(k.source).toEqual({ kind: "sourced", text: "a datasheet" }); // the project's own record, restored
    expect("sourceRecord" in k).toBe(false);
    expect((out.sets["thermal.volumetric_heat_capacity"] as { source: unknown }).source).toEqual({ kind: "assumed", text: "a guess" });
    // back in: the same material
    const second = importMaterial(get(project([out])), { id: "mat-fuel", region: "fuel" });
    if (!second.ok) throw new Error("refused");
    expect(second.material.sets).toEqual(first.material.sets);
    expect(second.material.origin.setsSha256).toBe(first.material.origin.setsSha256);
  });

  it("a FEED-made material (a plain source string) is labelled assumed unless told otherwise, never sourced on FEED's own account", () => {
    const own = { materialId: "my-fuel", revision: 2, sets: { "thermal.conductivity": { model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K"), source: "my own note" } } };
    const out = toProjectMaterial(own, "My fuel");
    expect((out.sets["thermal.conductivity"] as { source: unknown }).source).toEqual({ kind: "assumed", text: "my own note" });
    expect((toProjectMaterial(own, "My fuel", "synthetic").sets["thermal.conductivity"] as { source: unknown }).source).toEqual({ kind: "synthetic", text: "my own note" });
    const again = importMaterial(get(project([out])), { id: "my-fuel", region: "fuel" });
    expect(again.ok).toBe(true);
  });
});

describe("the routes", () => {
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const post = (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json", "x-feed-client": "1" }) => fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("lists a project's materials, and imports one", async () => {
    const dir = project([FUEL, BARE]);
    const a = await post("/api/import/project", { path: dir });
    expect(a.status).toBe(200);
    const j: any = await a.json();
    expect(j.projectId).toBe("proj-1");
    expect(j.materials.map((x: any) => x.id)).toEqual(["mat-fuel", "mat-bare"]);
    const b = await post("/api/import/material", { path: dir, id: "mat-fuel", region: "fuel", revision: 3 });
    expect(b.status).toBe(200);
    const k: any = await b.json();
    expect(k.ok).toBe(true);
    expect(k.material.sets["openmc.composition"]).toEqual(COMPOSITION);
    const c = await post("/api/import/material", { path: dir, id: "mat-fuel", region: "fuel", revision: 9 });
    expect(c.status).toBe(400);
    expect(((await c.json()) as any).errors[0].code).toBe("E_IMPORT_REVISION");
  });

  it("refuses a bad path with the reason, and needs the client header and JSON like every state-changing request", async () => {
    const r = await post("/api/import/project", { path: "C:\\no\\such\\place" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).errors[0].code).toBe("E_IMPORT_PROJECT");
    expect((await post("/api/import/project", { path: "x" }, { "content-type": "application/json" })).status).toBe(403);
    expect((await post("/api/import/project", "x", { "content-type": "text/plain", "x-feed-client": "1" })).status).toBe(415);
    expect((await post("/api/import/material", "{broken", { "content-type": "application/json", "x-feed-client": "1" })).status).toBe(400);
    expect((await post("/api/import/material", {})).status).toBe(400);
  });
});
