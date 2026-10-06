// The user's own materials: save, revisions, refusals, the damaged file, the HTTP route and the merged library listing (docs/user-library.md).
import { AddressInfo } from "net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_ENTRIES, USER_LIBRARY_SCHEMA, latestEntries, readUserEntries, saveUserMaterial, userLibraryFile } from "../src/core/userLibrary";
import { MATERIAL_ID, validateCase, validateMaterial } from "../src/core/validate";
import { library, server } from "../src/server/server";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const SOURCED = new Set<string>(read("library/materials.json").map((m: any) => m.material.materialId));

const dir = mkdtempSync(join(tmpdir(), "feed-userlib-"));
let n = 0;
beforeEach(() => {
  process.env.FEED_USER_LIBRARY = join(dir, "case" + ++n, "materials.json"); // each test its own file (the folder is made on the first save)
});
afterAll(() => {
  delete process.env.FEED_USER_LIBRARY;
});

const fuelMaterial = (over: Record<string, unknown> = {}) => ({
  materialId: "my-uo2-a",
  revision: 1,
  sets: {
    "thermal.conductivity": { model: "linear", a: q(5.5, "W/m/K"), b: q(-0.0015, "W/m/K2"), validRange: { min: q(500, "K"), max: q(2000, "K") }, source: "my measurement, sheet 3" },
    "thermal.volumetricHeatCapacity": { model: "constant", value: q(2.8, "MJ/m3/K"), referenceTemperature: q(300, "K"), source: "my measurement, sheet 4" },
    "openmc.composition": { nuclides: [{ name: "U235", fraction: 0.045 }], density: q(10.4, "g/cm3") },
    ...over,
  },
});
/** The material with a set left out (a key set to undefined is not the same as no key). */
const without = (key: string) => {
  const m = fuelMaterial();
  delete (m.sets as Record<string, unknown>)[key];
  return m;
};
const save = (over: Record<string, unknown> = {}) => saveUserMaterial({ region: "fuel", name: "My UO2", description: "mine", citation: "lab notebook", material: fuelMaterial(), ...over }, SOURCED, new Date("2026-10-06T12:00:00Z"));

describe("the material check", () => {
  it("a good material passes, and a foreign set is only required to be an object", () => {
    expect(validateMaterial("fuel", fuelMaterial()).errors).toEqual([]);
    expect(validateMaterial("fuel", fuelMaterial({ "openmc.composition": 3 })).errors.map((e) => e.code)).toEqual(["E_SCHEMA_INVALID"]);
  });
  it("applies the rules a case applies to a conductivity and a heat capacity", () => {
    const codes = (sets: Record<string, unknown>) => validateMaterial("fuel", fuelMaterial(sets)).errors.map((e) => e.code + " " + e.field);
    expect(validateMaterial("fuel", without("thermal.conductivity")).errors.map((e) => e.code + " " + e.field)).toEqual(["E_PROP_MISSING /materials/fuel/sets/thermal.conductivity"]);
    expect(codes({ "thermal.conductivity": { model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K") } })).toEqual(["E_PROP_MISSING /materials/fuel/sets/thermal.conductivity/source"]);
    expect(codes({ "thermal.conductivity": { model: "linear", a: q(5, "W/m/K"), b: q(-0.001, "W/m/K2"), source: "x" } })).toContain("E_PROP_MISSING /materials/fuel/sets/thermal.conductivity/validRange");
    expect(codes({ "thermal.conductivity": { model: "constant", value: q(-3, "W/m/K"), referenceTemperature: q(300, "K"), source: "x" } })[0]).toMatch(/^E_OUT_OF_RANGE/);
    expect(codes({ "thermal.conductivity": { model: "constant", value: q(3, "K"), referenceTemperature: q(300, "K"), source: "x" } })[0]).toMatch(/^E_UNITS/);
    expect(codes({ "thermal.volumetricHeatCapacity": { model: "constant", value: q(2.8, "MJ/m3/K"), referenceTemperature: q(300, "K") } })).toEqual(["E_PROP_MISSING /materials/fuel/sets/thermal.volumetricHeatCapacity/source"]);
  });
  it("the revision is a whole number from 1", () => {
    const rev = (revision: unknown) => validateMaterial("fuel", { ...fuelMaterial(), revision }).errors.map((e) => e.code + " " + e.field);
    expect(rev(1)).toEqual([]);
    expect(rev(12)).toEqual([]);
    for (const bad of [0, -1, 1.5, "1", null, NaN]) expect(rev(bad), String(bad)).toEqual(["E_SCHEMA_INVALID /materials/fuel/revision"]);
  });
  it("the id pattern", () => {
    for (const ok of ["abc", "my-uo2-a", "u-zrh-2", "a1b"]) expect(MATERIAL_ID.test(ok), ok).toBe(true);
    for (const bad of ["ab", "-abc", "abc-", "My-Fuel", "a b c", "../x", "a/b", "a_b", "x".repeat(65), ""]) expect(MATERIAL_ID.test(bad), bad).toBe(false);
  });
});

describe("saving", () => {
  it("a new material is revision 1 whatever revision it carried, with every set kept exactly, in the user's file", () => {
    const r = save({ material: { ...fuelMaterial(), revision: 7 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("saved");
    expect(r.entry.material.revision).toBe(1);
    expect(r.entry).toMatchObject({ region: "fuel", name: "My UO2", label: "custom", savedAt: "2026-10-06T12:00:00.000Z" });
    const file = JSON.parse(readFileSync(userLibraryFile(), "utf8"));
    expect(file.schema).toBe(USER_LIBRARY_SCHEMA);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0].material.sets["openmc.composition"]).toEqual(fuelMaterial().sets["openmc.composition"]); // a set that belongs to another app, unchanged
    expect(readdirSync(join(userLibraryFile(), ".."))).toEqual(["materials.json"]); // no temporary file left
  });

  it("the saved entry is its own copy: editing the object that was passed in afterwards changes neither the returned entry nor the file", () => {
    const m = fuelMaterial();
    const r = save({ material: m });
    if (!r.ok) throw new Error("refused");
    const text = readFileSync(userLibraryFile(), "utf8");
    (m.sets["thermal.conductivity"] as any).a.value = 99;
    (m.sets["openmc.composition"] as any).density.value = 1;
    expect((r.entry.material.sets["thermal.conductivity"] as any).a.value).toBe(5.5);
    expect((r.entry.material.sets["openmc.composition"] as any).density.value).toBe(10.4);
    expect(readFileSync(userLibraryFile(), "utf8")).toBe(text);
  });

  it("the same again is unchanged and writes nothing", () => {
    save();
    const before = statSync(userLibraryFile()).mtimeMs;
    const text = readFileSync(userLibraryFile(), "utf8");
    const r = save();
    expect(r).toMatchObject({ ok: true, status: "unchanged" });
    expect(readFileSync(userLibraryFile(), "utf8")).toBe(text);
    expect(statSync(userLibraryFile()).mtimeMs).toBe(before);
  });

  it("a changed property is revision 2, and revision 1 is still there, as it was", () => {
    save();
    const v2 = fuelMaterial({ "thermal.conductivity": { model: "constant", value: q(4.1, "W/m/K"), referenceTemperature: q(1000, "K"), source: "my measurement, sheet 5" } });
    const r = save({ material: v2 });
    expect(r).toMatchObject({ ok: true, status: "saved" });
    if (!r.ok) return;
    expect(r.entry.material.revision).toBe(2);
    const all = readUserEntries().entries;
    expect(all.map((e) => e.material.revision)).toEqual([1, 2]);
    expect((all[0]!.material.sets["thermal.conductivity"] as any).model).toBe("linear");
    expect(latestEntries(all)).toHaveLength(1);
    expect(latestEntries(all)[0]!.material.revision).toBe(2);
  });

  it("a changed name or citation alone is also a new revision (nothing is edited in place)", () => {
    save();
    expect(save({ name: "My UO2 (renamed)" })).toMatchObject({ ok: true, status: "saved", entry: { material: { revision: 2 } } });
    expect(save({ name: "My UO2 (renamed)", citation: "other" })).toMatchObject({ ok: true, status: "saved", entry: { material: { revision: 3 } } });
  });

  it("two materials side by side, each with its own revisions, in the order they were first saved", () => {
    save();
    saveUserMaterial({ region: "cladding", name: "My clad", material: { materialId: "my-clad", revision: 1, sets: { "thermal.conductivity": { model: "constant", value: q(15, "W/m/K"), referenceTemperature: q(600, "K"), source: "x" } } } }, SOURCED);
    save({ name: "My UO2 v2" });
    expect(latestEntries(readUserEntries().entries).map((e) => e.material.materialId + "@" + e.material.revision)).toEqual(["my-uo2-a@2", "my-clad@1"]);
  });

  it("a saved material is one a case accepts, in a steady and in a pulse case", () => {
    save();
    const m = latestEntries(readUserEntries().entries)[0]!.material;
    for (const file of ["examples/synthetic-pin.json", "examples/synthetic-pulse.json"]) {
      const doc = read(file);
      doc.materials.fuel = m;
      expect(validateCase(doc).errors, file).toEqual([]);
    }
  });
});

describe("refusals", () => {
  const refused = (r: ReturnType<typeof save>) => {
    if (r.ok) throw new Error("accepted");
    return r;
  };
  it("each says what is wrong and writes nothing", () => {
    const cases: [string, ReturnType<typeof save>, string][] = [
      ["a region that is neither", save({ region: "coolant" }), "E_SCHEMA_INVALID"],
      ["no name", save({ name: "  " }), "E_SCHEMA_INVALID"],
      ["a name of 121 characters", save({ name: "x".repeat(121) }), "E_SCHEMA_INVALID"],
      ["a name with a control character", save({ name: "a\u0007b" }), "E_SCHEMA_INVALID"],
      ["a description that is not text", save({ description: 5 }), "E_SCHEMA_INVALID"],
      ["a description of 1001 characters", save({ description: "x".repeat(1001) }), "E_SCHEMA_INVALID"],
      ["a citation of 2001 characters", save({ citation: "x".repeat(2001) }), "E_SCHEMA_INVALID"],
      ["no material", save({ material: undefined }), "E_SCHEMA_INVALID"],
      ["an id with capitals", save({ material: { ...fuelMaterial(), materialId: "My-Fuel" } }), "E_SCHEMA_INVALID"],
      ["an id that is a path", save({ material: { ...fuelMaterial(), materialId: "../../x" } }), "E_SCHEMA_INVALID"],
      ["a conductivity without a source", save({ material: fuelMaterial({ "thermal.conductivity": { model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K") } }) }), "E_PROP_MISSING"],
      ["no conductivity at all", save({ material: without("thermal.conductivity") }), "E_PROP_MISSING"],
      ["a material over 100 kB", save({ material: fuelMaterial({ "notes.big": { text: "x".repeat(100_001) } }) }), "E_OUT_OF_RANGE"],
    ];
    for (const [name, r, code] of cases) {
      const f = refused(r);
      expect(f.status, name).toBe(400);
      expect(f.errors[0]!.code, name).toBe(code);
      expect(f.errors[0]!.message.length, name).toBeGreaterThan(10);
    }
    expect(existsSync(userLibraryFile())).toBe(false);
  });

  it("an id of a sourced library material is taken (409): it cannot be replaced from here", () => {
    for (const id of SOURCED) {
      const r = refused(save({ material: { ...fuelMaterial(), materialId: id } }));
      expect(r.status).toBe(409);
      expect(r.errors[0]!.code).toBe("E_MATERIAL_ID_TAKEN");
    }
    expect(SOURCED.has("triga-uzrh-h16")).toBe(true);
  });

  it("an id belongs to one region", () => {
    save();
    const r = refused(save({ region: "cladding" }));
    expect(r.status).toBe(409);
    expect(r.errors[0]!.message).toMatch(/already a fuel material of yours/);
  });

  it("a library that holds the most it takes refuses another", () => {
    const e = (i: number) => ({ region: "fuel", name: "m" + i, label: "custom", description: "", citation: "", savedAt: "2026-01-01T00:00:00Z", material: { ...fuelMaterial(), materialId: "mat-" + String(i).padStart(5, "0") } });
    mkdirSync(join(userLibraryFile(), ".."), { recursive: true });
    writeFileSync(userLibraryFile(), JSON.stringify({ schema: USER_LIBRARY_SCHEMA, entries: Array.from({ length: MAX_ENTRIES }, (_, i) => e(i)) }));
    const r = refused(save({ material: { ...fuelMaterial(), materialId: "one-more" } }));
    expect(r.errors[0]!.message).toMatch(new RegExp(String(MAX_ENTRIES)));
  });
});

describe("a file that cannot be read is reported and left alone", () => {
  const put = (text: string) => {
    mkdirSync(join(userLibraryFile(), ".."), { recursive: true });
    writeFileSync(userLibraryFile(), text);
  };
  for (const [name, text, pattern] of [
    ["not JSON", "{nope", /cannot be read/],
    ["another schema", JSON.stringify({ schema: "something-else", entries: [] }), /not a feed\.user-materials\/0\.1 file/],
    ["an entry that is not a material", JSON.stringify({ schema: USER_LIBRARY_SCHEMA, entries: [{ region: "fuel", name: "x", material: { materialId: "x" } }] }), /not a valid material/],
  ] as [string, string, RegExp][]) {
    it(name, () => {
      put(text);
      expect(readUserEntries().problem).toMatch(pattern);
      const r = save();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(500);
        expect(r.errors[0]!.code).toBe("E_LIBRARY_UNREADABLE");
      }
      expect(readFileSync(userLibraryFile(), "utf8")).toBe(text); // never overwritten
    });
  }
});

describe("over HTTP and in the library listing", () => {
  let base = "";
  const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json", "x-feed-client": "1" }) => fetch(base + "/api/library/material", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const input = () => ({ region: "fuel", name: "My UO2", description: "mine", citation: "notebook", material: fuelMaterial() });

  it("saves (201), reports unchanged (200), adds a revision (201), and the listing shows the latest with its revision count after the sourced ones", async () => {
    const a = await post(input());
    expect(a.status).toBe(201);
    expect(((await a.json()) as any).entry.material.revision).toBe(1);
    expect((await post(input())).status).toBe(200);
    const changed = input();
    changed.material.sets["thermal.volumetricHeatCapacity"] = { model: "constant", value: q(3.1, "MJ/m3/K"), referenceTemperature: q(300, "K"), source: "sheet 9" };
    const c = await post(changed);
    expect(c.status).toBe(201);
    const lib: any = await (await fetch(base + "/api/library")).json();
    const mine = lib.materials.filter((m: any) => m.label === "custom");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "My UO2", region: "fuel", revisions: 2, material: { materialId: "my-uo2-a", revision: 2 } });
    expect(lib.materials.slice(0, lib.materials.length - 1).every((m: any) => m.label !== "custom")).toBe(true);
    expect(lib.userLibrary).toEqual({ entries: 2 });
  });

  it("the sourced library is untouched by a save, byte for byte", async () => {
    const before = readFileSync(join(root, "library", "materials.json"), "utf8");
    await post(input());
    expect(readFileSync(join(root, "library", "materials.json"), "utf8")).toBe(before);
  });

  it("refuses what the module refuses, with the right status and codes", async () => {
    const bad = input();
    delete (bad.material.sets as any)["thermal.conductivity"];
    const a = await post(bad);
    expect(a.status).toBe(400);
    expect(((await a.json()) as any).errors[0].code).toBe("E_PROP_MISSING");
    const b = await post({ ...input(), material: { ...input().material, materialId: "triga-uzrh-h16" } });
    expect(b.status).toBe(409);
    expect(((await b.json()) as any).errors[0].code).toBe("E_MATERIAL_ID_TAKEN");
  });

  it("is a state-changing request like the others: it needs the client header and JSON", async () => {
    expect((await post(input(), { "content-type": "application/json" })).status).toBe(403);
    expect((await post("name=x", { "content-type": "text/plain", "x-feed-client": "1" })).status).toBe(415);
    expect((await post("{broken", { "content-type": "application/json", "x-feed-client": "1" })).status).toBe(400);
    expect(existsSync(userLibraryFile())).toBe(false);
  });

  it("a damaged user file shows in the listing and does not break it", async () => {
    mkdirSync(join(userLibraryFile(), ".."), { recursive: true });
    writeFileSync(userLibraryFile(), "{nope");
    const lib: any = await (await fetch(base + "/api/library")).json();
    expect(lib.userLibrary.problem).toMatch(/cannot be read/);
    expect(lib.materials.length).toBe(library().materials.length);
    expect(lib.materials.every((m: any) => m.label !== "custom")).toBe(true);
  });
});
