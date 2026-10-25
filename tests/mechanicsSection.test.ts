// The `mechanics` case section (plan 09 M2): its keys, the temperature, plane, contact and coolant-pressure rules and their units, the cross-checks with
// thermalOnly, transient, hot dimensions and burnup, and the thermal-only case that must stay unchanged. Expectations are written from the spec, not from the validator.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const elasticity = () => ({ model: "constant", youngModulus: q(100, "GPa"), poissonRatio: q(0.3, "1"), source: "a test" });
const expansion = () => ({ linearExpansion: q(10, "ppm/K"), source: "a test" });
const both = { "mechanical.elasticity": elasticity(), "mechanical.thermalExpansion": expansion() };
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);

/** A valid mechanics section; a key given as undefined is removed, any other value replaces the default. */
const sec = (over: Record<string, unknown> = {}) => {
  const s: Record<string, unknown> = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0.1, "MPa") };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete s[k];
    else s[k] = v;
  }
  return s;
};
/** The synthetic pin with both property sets on both solids, thermalOnly false and the given section (null for no section). */
const mechCase = (section: unknown = sec()) => {
  const d = read("examples/synthetic-pin.json");
  Object.assign(d.materials.fuel.sets, both);
  Object.assign(d.materials.cladding.sets, both);
  d.assumptions.thermalOnly = false;
  if (section !== null) d.mechanics = section;
  return d;
};

describe("the good mechanics case", () => {
  it("has no errors and normalizes the section into kelvin, plain fraction and pascals", () => {
    const v = validateCase(mechCase());
    expect(v.errors).toEqual([]);
    const m = v.normalized!.mechanics!;
    expect(m.plane).toBe("free-axial");
    expect(m.referenceTemperature).toBeCloseTo(300, 9);
    expect(m.penaltyFactor).toBeCloseTo(0.3, 12);
    expect(m.coolantPressure).toBeCloseTo(1e5, 6);
  });
  it("a reference temperature in degC is stored in kelvin (27 degC -> 300.15 K)", () => {
    const v = validateCase(mechCase(sec({ referenceTemperature: q(27, "degC") })));
    expect(v.errors).toEqual([]);
    expect(v.normalized!.mechanics!.referenceTemperature).toBeCloseTo(300.15, 9);
  });
  it("the plane-strain plane is accepted", () => {
    const v = validateCase(mechCase(sec({ plane: "plane-strain" })));
    expect(v.errors).toEqual([]);
    expect(v.normalized!.mechanics!.plane).toBe("plane-strain");
  });
});

describe("contact penalty factor", () => {
  it.each([0.05, 1])("%s is accepted", (f) => {
    expect(codes(mechCase(sec({ contact: { penaltyFactor: q(f, "1") } })))).toEqual([]);
  });
  it.each([0.049, 1.01])("%s is refused as out of range", (f) => {
    expect(codes(mechCase(sec({ contact: { penaltyFactor: q(f, "1") } })))).toEqual(["E_OUT_OF_RANGE /mechanics/contact/penaltyFactor"]);
  });
  it("a unit that is not a fraction (K) is refused as E_UNITS", () => {
    expect(codes(mechCase(sec({ contact: { penaltyFactor: q(0.3, "K") } })))).toEqual(["E_UNITS /mechanics/contact/penaltyFactor"]);
  });
});

describe("coolant pressure", () => {
  it("zero is accepted", () => {
    const v = validateCase(mechCase(sec({ coolantPressure: q(0, "Pa") })));
    expect(v.errors).toEqual([]);
    expect(v.normalized!.mechanics!.coolantPressure).toBe(0);
  });
  it("kPa, MPa and psi are converted to pascals", () => {
    const kpa = validateCase(mechCase(sec({ coolantPressure: q(100, "kPa") })));
    const mpa = validateCase(mechCase(sec({ coolantPressure: q(0.1, "MPa") })));
    const psi = validateCase(mechCase(sec({ coolantPressure: q(10, "psi") })));
    expect(kpa.errors).toEqual([]);
    expect(mpa.errors).toEqual([]);
    expect(psi.errors).toEqual([]);
    expect(kpa.normalized!.mechanics!.coolantPressure as number).toBeCloseTo(1e5, 6);
    expect(mpa.normalized!.mechanics!.coolantPressure as number).toBeCloseTo(1e5, 6);
    expect(psi.normalized!.mechanics!.coolantPressure as number).toBeCloseTo(10 * 6894.757293168, 3);
  });
  it("a negative pressure is refused", () => {
    expect(codes(mechCase(sec({ coolantPressure: q(-1, "MPa") })))).toEqual(["E_OUT_OF_RANGE /mechanics/coolantPressure"]);
    expect(codes(mechCase(sec({ coolantPressure: q(-0.5, "Pa") })))).toEqual(["E_OUT_OF_RANGE /mechanics/coolantPressure"]); // a tiny negative one is refused too
  });
  it("2e9 Pa is refused", () => {
    expect(codes(mechCase(sec({ coolantPressure: q(2e9, "Pa") })))).toEqual(["E_OUT_OF_RANGE /mechanics/coolantPressure"]);
  });
});

describe("the section's own refusals", () => {
  it("the reference temperature is required, above 0 K and at most 10000 K", () => {
    expect(codes(mechCase(sec({ referenceTemperature: undefined })))).toEqual(["E_PROP_MISSING /mechanics/referenceTemperature"]);
    expect(codes(mechCase(sec({ referenceTemperature: q(0, "K") })))).toEqual(["E_OUT_OF_RANGE /mechanics/referenceTemperature"]);
    expect(codes(mechCase(sec({ referenceTemperature: q(10001, "K") })))).toEqual(["E_OUT_OF_RANGE /mechanics/referenceTemperature"]);
  });
  it("the plane is required, and only free-axial or plane-strain is allowed", () => {
    expect(codes(mechCase(sec({ plane: undefined })))).toEqual(["E_PROP_MISSING /mechanics/plane"]);
    expect(codes(mechCase(sec({ plane: "plane-stress" })))).toEqual(["E_UNSUPPORTED /mechanics/plane"]);
  });
  it("contact is required", () => {
    expect(codes(mechCase(sec({ contact: undefined })))).toEqual(["E_PROP_MISSING /mechanics/contact"]);
  });
  it("contact must be an object", () => {
    expect(codes(mechCase(sec({ contact: "0.3" })))).toEqual(["E_SCHEMA_INVALID /mechanics/contact"]);
  });
  it("contact takes only penaltyFactor", () => {
    expect(codes(mechCase(sec({ contact: { penaltyFactor: q(0.3, "1"), friction: q(0.1, "1") } })))).toEqual(["E_SCHEMA_INVALID /mechanics/contact/friction"]);
  });
  it("penaltyFactor is required", () => {
    expect(codes(mechCase(sec({ contact: {} })))).toEqual(["E_PROP_MISSING /mechanics/contact/penaltyFactor"]);
  });
  it("the coolant pressure is required", () => {
    expect(codes(mechCase(sec({ coolantPressure: undefined })))).toEqual(["E_PROP_MISSING /mechanics/coolantPressure"]);
  });
  it("an unknown key in the section is refused", () => {
    expect(codes(mechCase(sec({ creep: true })))).toEqual(["E_SCHEMA_INVALID /mechanics/creep"]);
  });
  it("mechanics that is not an object is refused", () => {
    expect(codes(mechCase("yes"))).toEqual(["E_SCHEMA_INVALID /mechanics"]);
  });
});

describe("cross-checks", () => {
  it("a mechanics section with thermalOnly true is refused at /assumptions/thermalOnly", () => {
    const d = mechCase();
    d.assumptions.thermalOnly = true;
    expect(codes(d)).toEqual(["E_SCHEMA_INVALID /assumptions/thermalOnly"]);
  });
  it("thermalOnly false without a section needs one", () => {
    const d = mechCase(null);
    expect(codes(d).filter((x) => x.endsWith(" /mechanics"))).toEqual(["E_PROP_MISSING /mechanics"]);
  });
  it("a transient case with the section is valid since plan 17 M2, with the warning that it cannot be solved yet", () => {
    const d = read("examples/synthetic-pulse.json");
    Object.assign(d.materials.fuel.sets, both);
    Object.assign(d.materials.cladding.sets, both);
    d.assumptions.thermalOnly = false;
    d.mechanics = sec();
    const r = validateCase(d);
    expect(r.errors).toEqual([]);
    expect(r.normalized?.mechanics).toBeDefined();
    expect(r.warnings.map((w) => w.code)).toEqual(["W_TRANSIENT_MECHANICS_NOT_SOLVABLE"]);
  });
  it("hot dimensions with the section are unsupported at /hotDimensions", () => {
    const d = mechCase();
    d.hotDimensions = JSON.parse(JSON.stringify(read("schema/vectors/good/hot-dimensions.json").hotDimensions));
    expect(codes(d)).toEqual(["E_UNSUPPORTED /hotDimensions"]);
  });
  it("burnup with the section is unsupported at /burnup", () => {
    const src = read("schema/vectors/good/uo2-nfi-burnup.json");
    const d = mechCase();
    d.materials.fuel.sets["thermal.conductivity"] = JSON.parse(JSON.stringify(src.materials.fuel.sets["thermal.conductivity"]));
    d.burnup = JSON.parse(JSON.stringify(src.burnup));
    expect(codes(d)).toEqual(["E_UNSUPPORTED /burnup"]);
  });
});

describe("a thermal-only case", () => {
  it("with no section and no property sets is valid and has no normalized mechanics", () => {
    const d = read("examples/synthetic-pin.json");
    d.assumptions.thermalOnly = true;
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.normalized).not.toHaveProperty("mechanics");
  });
});
