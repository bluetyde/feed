// The mechanical property sets of plan 09 M1 (docs/plans/09-mechanics.md, docs/spike/mechanics-data.md): `mechanical.elasticity` and `mechanical.thermalExpansion` of each solid, their
// units, bounds and refusals, the refusal that names a missing set when a case asks for mechanics, and the sourced library entries. The expected numbers of the library are the SARs'
// own (psi) written here, not read from the library.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { validateCase, validateMaterial } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const elasticity = (extra: Record<string, unknown> = {}) => ({ model: "constant", youngModulus: q(100, "GPa"), poissonRatio: q(0.3, "1"), source: "a test", ...extra });
const expansion = (extra: Record<string, unknown> = {}) => ({ linearExpansion: q(10, "ppm/K"), source: "a test", ...extra });
const both = { "mechanical.elasticity": elasticity(), "mechanical.thermalExpansion": expansion() };
/** The synthetic pin with property sets added to the fuel and to the cladding (the cladding gets valid ones unless told otherwise). */
const pin = (fuel: Record<string, unknown> | null, cladding: Record<string, unknown> | null = both, thermalOnly = true) => {
  const d = read("examples/synthetic-pin.json");
  if (fuel) Object.assign(d.materials.fuel.sets, fuel);
  if (cladding) Object.assign(d.materials.cladding.sets, cladding);
  d.assumptions.thermalOnly = thermalOnly;
  return d;
};
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);

describe("a case that asks for mechanics needs both sets of both solids, and says which is missing", () => {
  it("none: each of the four sets is named, besides the refusal that mechanics is not solved yet", () => {
    const c = codes(pin(null, null, false));
    expect(c).toContain("E_UNSUPPORTED /assumptions/thermalOnly");
    for (const r of ["fuel", "cladding"]) for (const s of ["mechanical.elasticity", "mechanical.thermalExpansion"]) expect(c, r + " " + s).toContain(`E_PROP_MISSING /materials/${r}/sets/${s}`);
    expect(c.filter((x) => x.startsWith("E_PROP_MISSING"))).toHaveLength(4);
  });
  it("the message names the material, the set and what it is for, and says there is no default", () => {
    const e = validateCase(pin(null, null, false)).errors.find((x) => x.field === "/materials/fuel/sets/mechanical.elasticity")!;
    expect(e.message).toMatch(/fuel material 'synthetic-fuel' has no mechanical\.elasticity set/);
    expect(e.message).toMatch(/does not default one/);
  });
  it("only the cladding's expansion missing: that one set is named", () => {
    const d = pin(both, { "mechanical.elasticity": elasticity() }, false);
    expect(codes(d).filter((x) => x.startsWith("E_PROP_MISSING"))).toEqual(["E_PROP_MISSING /materials/cladding/sets/mechanical.thermalExpansion"]);
  });
  it("all four present: only the refusal that mechanics is not solved yet is left", () => {
    expect(codes(pin(both, both, false))).toEqual(["E_UNSUPPORTED /assumptions/thermalOnly"]);
  });
  it("a thermal-only case needs none of them and is unchanged", () => {
    const v = validateCase(pin(null, null, true));
    expect(v.errors).toEqual([]);
    expect(v.normalized!.mechanical).toBeUndefined();
  });
});

describe("the sets are checked whenever a material carries them", () => {
  it("both valid on both solids: the case is valid and carries the properties in SI", () => {
    const v = validateCase(pin({ "mechanical.elasticity": elasticity({ youngModulus: q(9.1e6, "psi") }), "mechanical.thermalExpansion": expansion() }, both));
    expect(v.errors).toEqual([]);
    const m = v.normalized!.mechanical!;
    expect(m.fuel.elasticity).toEqual({ kind: "constant", E: 9.1e6 * 6894.757293168, nu: 0.3 });
    expect(m.fuel.expansion.kind).toBe("constant");
    expect((m.fuel.expansion as { alpha: number }).alpha).toBeCloseTo(1e-5, 15);
    expect(m.cladding.elasticity).toEqual({ kind: "constant", E: 1e11, nu: 0.3 });
  });
  it("pressure units: Pa, kPa, MPa, GPa, psi and ksi", () => {
    const E = (v: number, u: string) => (validateCase(pin({ ...both, "mechanical.elasticity": elasticity({ youngModulus: q(v, u) }) })).normalized!.mechanical!.fuel.elasticity as { E: number }).E;
    expect(E(2e11, "Pa")).toBe(2e11);
    expect(E(2e8, "kPa")).toBe(2e11);
    expect(E(2e5, "MPa")).toBe(2e11);
    expect(E(200, "GPa")).toBe(2e11);
    expect(E(1e6, "psi")).toBeCloseTo(6894757293.168, 3);
    expect(E(1e3, "ksi")).toBeCloseTo(6894757293.168, 3);
  });
  it("a linear modulus E = a + b T over a stated range", () => {
    const e = elasticity({ model: "linear", youngModulus: undefined, a: q(100, "GPa"), b: q(-0.01, "GPa/K"), poissonRatio: q(0.27, "1"), validRange: { min: q(300, "K"), max: q(900, "K") } });
    delete (e as any).youngModulus;
    const v = validateCase(pin({ ...both, "mechanical.elasticity": e }));
    expect(v.errors).toEqual([]);
    expect(v.normalized!.mechanical!.fuel.elasticity).toEqual({ kind: "linear", a: 1e11, b: -1e7, nu: 0.27, range: [300, 900] });
  });
  it("a linear modulus that turns too small inside its range is refused", () => {
    const e: any = elasticity({ model: "linear", a: q(100, "GPa"), b: q(-0.2, "GPa/K"), validRange: { min: q(300, "K"), max: q(900, "K") } });
    delete e.youngModulus;
    expect(codes(pin({ ...both, "mechanical.elasticity": e }))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/mechanical.elasticity"]);
  });
  it("refusals: no source, no Poisson's ratio, a ratio of 0.5 or below 0, a modulus out of bounds or in the wrong unit, an unknown key or model, a linear modulus without a range", () => {
    const f = (e: Record<string, unknown>) => codes(pin({ ...both, "mechanical.elasticity": e }));
    expect(f(elasticity({ source: "  " }))).toEqual(["E_PROP_MISSING /materials/fuel/sets/mechanical.elasticity/source"]);
    expect(f(elasticity({ poissonRatio: undefined }))).toEqual(["E_PROP_MISSING /materials/fuel/sets/mechanical.elasticity/poissonRatio"]);
    expect(f(elasticity({ poissonRatio: q(0.5, "1") }))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/mechanical.elasticity/poissonRatio"]);
    expect(f(elasticity({ poissonRatio: q(-0.1, "1") }))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/mechanical.elasticity/poissonRatio"]);
    expect(f(elasticity({ youngModulus: q(1e13, "Pa") }))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/mechanical.elasticity/youngModulus"]);
    expect(f(elasticity({ youngModulus: q(100, "K") }))).toEqual(["E_UNITS /materials/fuel/sets/mechanical.elasticity/youngModulus"]);
    expect(f(elasticity({ youngModulus: undefined }))).toEqual(["E_PROP_MISSING /materials/fuel/sets/mechanical.elasticity/youngModulus"]);
    expect(f(elasticity({ bulkModulus: q(1, "GPa") }))).toEqual(["E_SCHEMA_INVALID /materials/fuel/sets/mechanical.elasticity/bulkModulus"]);
    expect(f(elasticity({ model: "table" }))).toEqual(["E_UNSUPPORTED /materials/fuel/sets/mechanical.elasticity/model"]);
    expect(f(elasticity({ model: undefined }))).toEqual(["E_PROP_MISSING /materials/fuel/sets/mechanical.elasticity/model"]);
    expect(f({ model: "linear", a: q(100, "GPa"), b: q(-0.01, "GPa/K"), poissonRatio: q(0.3, "1"), source: "a test" })).toEqual(["E_PROP_MISSING /materials/fuel/sets/mechanical.elasticity/validRange"]);
  });
  it("Poisson's ratio 0 is allowed", () => {
    expect(codes(pin({ ...both, "mechanical.elasticity": elasticity({ poissonRatio: q(0, "1") }) }))).toEqual([]);
  });
  it("the expansion set: a constant or a linear law with the hot-dimension rules, a source, no other key", () => {
    const f = (x: Record<string, unknown>) => codes(pin({ ...both, "mechanical.thermalExpansion": x }));
    expect(f(expansion({ source: "" }))).toEqual(["E_PROP_MISSING /materials/fuel/sets/mechanical.thermalExpansion/source"]);
    expect(f(expansion({ linearExpansion: undefined }))).toEqual(["E_PROP_MISSING /materials/fuel/sets/mechanical.thermalExpansion/linearExpansion"]);
    expect(f(expansion({ linearExpansion: q(-10, "ppm/K") }))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/mechanical.thermalExpansion/linearExpansion"]);
    expect(f(expansion({ extra: 1 }))).toEqual(["E_SCHEMA_INVALID /materials/fuel/sets/mechanical.thermalExpansion/extra"]);
    const lin = { model: "linear", a: q(5, "ppm/K"), b: q(20, "1e-9/K2"), validRange: { min: q(293, "K"), max: q(900, "K") } };
    expect(f(expansion({ linearExpansion: lin }))).toEqual([]);
    expect(f(expansion({ linearExpansion: { ...lin, validRange: undefined } }))).toEqual(["E_PROP_MISSING /materials/fuel/sets/mechanical.thermalExpansion/linearExpansion/validRange"]);
  });
  it("a set that is not an object", () => {
    expect(codes(pin({ ...both, "mechanical.elasticity": 3 }))).toContain("E_SCHEMA_INVALID /materials/fuel/sets/mechanical.elasticity");
  });
});

describe("the library materials carry the sourced sets (revision 3 of the TRIGA fuel, the stainless-steel claddings)", () => {
  const lib: any[] = read("library/materials.json");
  const byId = (id: string) => lib.find((e) => e.material.materialId === id)!.material;
  const SAR_PSI = 6894.757293168;

  it("the fuel's modulus is the SARs' 9.1e6 psi at 20 C and 6.0e6 psi at 650 C, linear between, and agrees with Simnad's measurement on ZrH1.6 (63,000 and about 41,000 MPa) to 1 %", () => {
    const e = byId("triga-uzrh-h16").sets["mechanical.elasticity"];
    const at = (T: number) => e.a.value + e.b.value * T;
    expect(at(293.15) / (9.1e6 * SAR_PSI) - 1).toBeCloseTo(0, 8);
    expect(at(923.15) / (6.0e6 * SAR_PSI) - 1).toBeCloseTo(0, 8);
    expect(Math.abs(at(293.15) / 63e9 - 1)).toBeLessThan(0.01);
    expect(Math.abs(at(923.15) / 41e9 - 1)).toBeLessThan(0.01);
    expect(e.poissonRatio).toEqual({ value: 0.32, unit: "1" });
    expect(e.validRange).toEqual({ min: { value: 293.15, unit: "K" }, max: { value: 923.15, unit: "K" } });
    expect(e.source).toMatch(/Sandia SAND2009-7374C/);
    expect(e.source).toMatch(/E-117-833/);
  });
  it("the claddings' modulus and ratio are Sandia's 1.9e11 Pa and 0.3, and say they are a single value", () => {
    for (const id of ["ss304-k166", "ss304-ktemp", "ss304-ktable"]) {
      const e = byId(id).sets["mechanical.elasticity"];
      expect(e.youngModulus).toEqual({ value: 190, unit: "GPa" });
      expect(e.poissonRatio).toEqual({ value: 0.3, unit: "1" });
      expect(e.source).toMatch(/SAND2009-7374C/);
    }
  });
  it("the expansion sets are the laws of library/expansion.json, which the hot dimensions use", () => {
    const exp: any[] = read("library/expansion.json");
    const fuel = exp.find((x) => x.id === "triga-uzrh-simnad-expansion");
    const clad = exp.find((x) => x.id === "triga-ss304-jsi-expansion");
    expect(byId("triga-uzrh-h16").sets["mechanical.thermalExpansion"].linearExpansion).toEqual(fuel.linearExpansion);
    for (const id of ["ss304-k166", "ss304-ktemp", "ss304-ktable"]) expect(byId(id).sets["mechanical.thermalExpansion"].linearExpansion).toEqual(clad.linearExpansion);
  });
  it("each entry is a valid material, and a pin made of them has the properties", () => {
    for (const [id, region] of [["triga-uzrh-h16", "fuel"], ["ss304-k166", "cladding"], ["ss304-ktemp", "cladding"], ["ss304-ktable", "cladding"]] as const) {
      const r = validateMaterial(region, byId(id));
      expect(r.errors, id).toEqual([]);
    }
    const d = read("examples/ksu-triga-hot-element.json");
    d.materials.fuel = byId("triga-uzrh-h16");
    d.materials.cladding = byId("ss304-k166");
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.mechanical!.fuel.elasticity.kind).toBe("linear");
    expect((v.normalized!.mechanical!.cladding.expansion as { alpha: number }).alpha).toBeCloseTo(17.2e-6, 15);
  });
  it("a library material with a bad mechanical set is refused as a material, with the field named as in a case", () => {
    const m = JSON.parse(JSON.stringify(byId("triga-uzrh-h16")));
    m.sets["mechanical.elasticity"].poissonRatio = { value: 0.7, unit: "1" };
    delete m.sets["mechanical.thermalExpansion"].source;
    const r = validateMaterial("fuel", m);
    expect(r.errors.map((e) => e.code + " " + e.field)).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/mechanical.elasticity/poissonRatio", "E_PROP_MISSING /materials/fuel/sets/mechanical.thermalExpansion/source"]);
  });
  it("the revisions went up with the sets: the thermal sets are as they were", () => {
    expect(byId("triga-uzrh-h16").revision).toBe(3);
    expect(byId("ss304-k166").revision).toBe(3);
    expect(byId("ss304-ktemp").revision).toBe(3);
    expect(byId("ss304-ktable").revision).toBe(2);
    expect(byId("triga-uzrh-h16").sets["thermal.conductivity"].value).toEqual({ value: 18, unit: "W/m/K" });
    expect(byId("ss304-k166").sets["thermal.conductivity"].value).toEqual({ value: 16.6, unit: "W/m/K" });
  });
});
