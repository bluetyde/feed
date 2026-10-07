// The fixes that came out of the F1 exit review (2026-10-07, specification-gap-auditor on the validator, silent-failure-hunter on the laws): each finding was
// reproduced first, and each test here fails on the code before the fix. Review record: docs/reviews/codex-2026-10-07-f1-exit.md.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { evaluate, minimum, solveHot } from "../src/core/conductivity";
import { evaluateLimit, limitChecks, LimitRule, LimitState } from "../src/core/limits";
import { validateCase, validateMaterial } from "../src/core/validate";

const read = (p: string) => JSON.parse(readFileSync(join(__dirname, "..", p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);
const recip = (a: number, b: number, lo: number, hi: number) => ({ model: "reciprocal", a: q(a, "W/m"), b: q(b, "W/m/K"), validRange: { min: q(lo, "K"), max: q(hi, "K") }, source: "x" });
const linear = (a: number, b: number, lo = 300, hi = 2000) => ({ model: "linear", a: q(a, "W/m/K"), b: q(b, "W/m/K2"), validRange: { min: q(lo, "K"), max: q(hi, "K") }, source: "x" });
const withFuelK = (set: unknown, file = "examples/synthetic-pin.json") => {
  const d = read(file);
  d.materials.fuel.sets["thermal.conductivity"] = set;
  return d;
};

describe("a uniform transient start needs a positive conductivity there", () => {
  it("a law that is negative at the start temperature (positive only over its own range) is refused at the start field", () => {
    const d = withFuelK(recip(-1000, 2, 600, 2000), "examples/synthetic-pulse.json"); // k(300) = -1.33; k(600) = 0.33
    expect(d.transient.initialTemperature).toEqual(q(300, "K"));
    const r = validateCase(d);
    expect(codes(d)).toEqual(["E_OUT_OF_RANGE /transient/initialTemperature"]);
    expect(r.errors[0]!.message).toMatch(/fuel conductivity at the initial temperature 300 K is -1\.333/);
    expect(r.normalized).toBeUndefined();
  });
  it("the same law with a start temperature inside its range is accepted, and so is a cladding law checked the same way", () => {
    const d = withFuelK(recip(-1000, 2, 600, 2000), "examples/synthetic-pulse.json");
    d.transient.initialTemperature = q(700, "K");
    expect(validateCase(d).errors).toEqual([]);
    const c = read("examples/synthetic-pulse.json");
    c.materials.cladding.sets["thermal.conductivity"] = recip(-1000, 2, 600, 2000);
    expect(codes(c)).toEqual(["E_OUT_OF_RANGE /transient/initialTemperature"]);
  });
});

describe("a conductivity is 0.001 to 100000 W/m/K: anything else is a units mistake, and cannot overflow the closed forms", () => {
  const bad = (set: unknown) => codes(withFuelK(set));
  it("a linear law whose values overflow is refused (it was accepted, and gave a zero fuel temperature rise)", () => {
    expect(bad(linear(1e308, 1e308))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.conductivity"]);
  });
  it("the bounds are exact for a constant: 0.001 and 100000 pass, either side is refused", () => {
    const k = (v: number) => ({ model: "constant", value: q(v, "W/m/K"), referenceTemperature: q(300, "K"), source: "x" });
    for (const v of [1e-3, 1e5]) expect(validateCase(withFuelK(k(v))).errors.map((e) => e.code), String(v)).not.toContain("E_OUT_OF_RANGE");
    for (const v of [0.0009, 100001]) expect(bad(k(v)), String(v)).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.conductivity/value"]);
  });
  it("a linear law is judged over its whole range, at both ends", () => {
    expect(bad(linear(3, 0.04, 300, 2000))).toEqual([]); // 15 to 83
    expect(bad(linear(3, 100, 300, 2000))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.conductivity"]); // up to 2e5
    expect(bad(linear(0.0005, 0, 300, 2000))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.conductivity"]); // below the minimum
  });
  it("a cubic and a reciprocal law have the same bounds", () => {
    const poly = (a: number) => ({ model: "polynomial", a: q(a, "W/m/K"), b: q(0, "W/m/K2"), c: q(0, "W/m/K3"), d: q(0, "W/m/K4"), validRange: { min: q(300, "K"), max: q(2000, "K") }, source: "x" });
    expect(bad(poly(2e5))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.conductivity"]);
    expect(bad(recip(1e9, 1, 300, 2000))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.conductivity"]);
  });
  it("the closed forms refuse an overflow instead of returning a finite wrong temperature", () => {
    expect(() => solveHot([0, 1e155], 300, 1e160)).toThrow(RangeError); // was 300 K
    expect(() => solveHot([0, 0, 1e300], 700, 1e308)).toThrow(RangeError); // was 813.98 K, the right answer being 863.1 K
  });
  it("the interior minimum of a huge cubic is still found (the discriminant overflowed to NaN and skipped it), and the scale does not change the answer", () => {
    const base = [500000, 498500, -1499, 1];
    for (const s of [1, 1e60, 1e160]) {
      const c = base.map((x) => x * s);
      let scan = Infinity;
      for (let T = 300; T <= 1500; T += 0.01) scan = Math.min(scan, evaluate(c, T));
      expect(Math.abs(minimum(c, 300, 1500) / scan - 1), String(s)).toBeLessThan(1e-6);
    }
    expect(minimum(base.map((x) => x * 1e160), 300, 1500)).toBeLessThan(0); // the law does go negative inside its range
  });
});

describe("radii: a size that underflows the cell areas, or is plainly a units mistake, is refused", () => {
  const geom = (f: number, ci: number, co: number, unit = "m") => {
    const d = read("examples/synthetic-pulse.json");
    d.geometry = { fuelRadius: q(f, unit), claddingInnerRadius: q(ci, unit), claddingOuterRadius: q(co, unit) };
    return d;
  };
  it("1e-200 m (it was accepted and gave non-finite temperatures) and 1e4 m are refused with E_GEOMETRY at the radius", () => {
    expect(codes(geom(1e-200, 2e-200, 3e-200))).toEqual(["E_GEOMETRY /geometry/fuelRadius", "E_GEOMETRY /geometry/claddingInnerRadius", "E_GEOMETRY /geometry/claddingOuterRadius"]);
    expect(codes(geom(1e4, 1.1e4, 1.2e4))).toEqual(["E_GEOMETRY /geometry/fuelRadius", "E_GEOMETRY /geometry/claddingInnerRadius", "E_GEOMETRY /geometry/claddingOuterRadius"]);
  });
  it("a pin in millimetres is untouched, and a central hole of 1e-12 m is refused as a hole, not as solid fuel", () => {
    expect(validateCase(geom(4.1, 4.18, 4.75, "mm")).errors).toEqual([]);
    const d = read("examples/synthetic-pin.json");
    d.geometry.fuelInnerRadius = q(1e-12, "m");
    expect(codes(d)).toEqual(["E_GEOMETRY /geometry/fuelInnerRadius"]);
  });
});

describe("reference temperatures and ranges start above 0 K, for every model", () => {
  it("a constant conductivity or heat capacity with a reference of -1 K, and a linear law over -100 to 2000 K, are refused", () => {
    const k = withFuelK({ model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(-1, "K"), source: "x" });
    expect(codes(k)).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.conductivity/referenceTemperature"]);
    expect(codes(withFuelK(linear(3, 0, -100, 2000)))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.conductivity/validRange/min"]);
    const cp = (set: unknown) => {
      const d = read("examples/synthetic-pulse.json");
      d.materials.fuel.sets["thermal.volumetricHeatCapacity"] = set;
      return d;
    };
    expect(codes(cp({ model: "constant", value: q(3e6, "J/m3/K"), referenceTemperature: q(-1, "K"), source: "x" }))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.volumetricHeatCapacity/referenceTemperature"]);
    expect(codes(cp({ model: "linear", a: q(3e6, "J/m3/K"), b: q(0, "J/m3/K2"), validRange: { min: q(-100, "K"), max: q(2000, "K") }, source: "x" }))).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.volumetricHeatCapacity/validRange/min"]);
  });
});

describe("a source of whitespace is no source", () => {
  it("a conductivity, a heat capacity and a gap conductance with a source of spaces are refused as missing", () => {
    const k = withFuelK({ model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K"), source: "   " });
    expect(codes(k)).toEqual(["E_PROP_MISSING /materials/fuel/sets/thermal.conductivity/source"]);
    const cp = read("examples/synthetic-pulse.json");
    cp.materials.fuel.sets["thermal.volumetricHeatCapacity"].source = "\t ";
    expect(codes(cp)).toEqual(["E_PROP_MISSING /materials/fuel/sets/thermal.volumetricHeatCapacity/source"]);
    const gap = read("examples/synthetic-pin.json");
    gap.gap.source = "  ";
    expect(codes(gap)).toEqual(["E_PROP_MISSING /gap/source"]);
  });
  it("a material saved to the library has the same rule", () => {
    const m = { materialId: "synthetic-fuel", revision: 1, sets: { "thermal.conductivity": { model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K"), source: " " } } };
    expect(validateMaterial("fuel", m).errors.map((e) => e.code)).toEqual(["E_PROP_MISSING"]);
  });
});

describe("hot dimensions: the code follows the cause, and the range covers the whole strain integral", () => {
  const hot = (extra: Record<string, unknown> = {}) => ({ referenceTemperature: q(293.15, "K"), fuel: { linearExpansion: q(1e-5, "1/K"), source: "x" }, cladding: { linearExpansion: q(1e-5, "1/K"), source: "x" }, ...extra });
  it("a conductivity that cannot be solved is E_OUT_OF_RANGE at /materials with or without the section (it was E_GEOMETRY at /hotDimensions with it)", () => {
    const set = recip(1000, -1, 300, 900); // zero at 1000 K, where the pin runs
    const without = withFuelK(set);
    const withH = withFuelK(set);
    withH.hotDimensions = hot();
    expect(codes(without)).toEqual(["E_OUT_OF_RANGE /materials"]);
    expect(codes(withH)).toEqual(["E_OUT_OF_RANGE /materials"]);
  });
  it("a gap that closes is still E_GEOMETRY at /hotDimensions", () => {
    const d = read("examples/synthetic-pin.json");
    d.hotDimensions = hot({ fuel: { linearExpansion: q(9e-4, "1/K"), source: "x" } });
    expect(codes(d)).toEqual(["E_GEOMETRY /hotDimensions"]);
  });
  it("a law whose range starts above the reference temperature warns, though the pin itself runs inside the range", () => {
    const law = (lo: number) => ({ model: "linear", a: q(5e-6, "1/K"), b: q(2e-8, "1/K2"), validRange: { min: q(lo, "K"), max: q(1500, "K") } });
    const d = read("examples/synthetic-pin.json");
    d.hotDimensions = hot({ referenceTemperature: q(300, "K"), fuel: { linearExpansion: law(700), source: "x" } }); // the fuel runs about 780 to 1310 K
    const r = validateCase(d);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.code + " " + w.field)).toEqual(["W_EXPANSION_RANGE /hotDimensions/fuel"]);
    expect(r.normalized!.hot!.fuel.outOfRange).toBe(true);
    d.hotDimensions = hot({ referenceTemperature: q(750, "K"), fuel: { linearExpansion: law(700), source: "x" } }); // reference and operating both inside
    expect(validateCase(d).warnings).toEqual([]);
    d.hotDimensions = hot({ referenceTemperature: q(1600, "K"), fuel: { linearExpansion: law(700), source: "x" } }); // reference above the range
    expect(validateCase(d).warnings.map((w) => w.code)).toContain("W_EXPANSION_RANGE");
  });
});

describe("temperature limits: a temperature that is not a number never passes", () => {
  const rule = (over: Partial<LimitRule> = {}): LimitRule => ({ name: "fuel", region: "fuel", maxTemperature: 1000, source: "test", ...over });
  const S = (time: number, fuelMax: number, claddingMax: number): LimitState => ({ time, fuelMax, claddingMax });
  it("a state with a NaN or infinite fuel temperature is counted as invalid and the check fails (it passed with a margin of 100 K)", () => {
    expect(evaluateLimit(rule(), [S(0, 900, 500), S(1, NaN, 500)])).toMatchObject({ applied: 1, margin: 100, invalid: 1 });
    const [c] = limitChecks([rule()], [S(0, 900, 500), S(1, NaN, 500)]);
    expect(c!.verdict).toBe("fail");
    expect(c!.value).toBeNull();
    expect(c!.note).toMatch(/1 moment\(s\) had a temperature that is not a finite number/);
    expect(limitChecks([rule()], [S(0, Infinity, 500)])[0]!.verdict).toBe("fail");
  });
  it("a NaN cladding temperature fails a rule that depends on the cladding, and one that does not (a cladding is part of every state)", () => {
    const cond = rule({ whileCladding: { atMost: 800 } });
    expect(limitChecks([cond], [S(0, 2000, NaN)])[0]!.verdict).toBe("fail"); // it said the condition never held
    expect(limitChecks([rule()], [S(0, 900, NaN)])[0]!.verdict).toBe("fail");
  });
  it("the independent solution's invalid moments count too, and finite states are judged as before", () => {
    expect(limitChecks([rule()], [S(0, 900, 500)], [S(0, 900, 500), S(1, NaN, 500)])[0]!.verdict).toBe("fail");
    const ok = limitChecks([rule()], [S(0, 900, 500)], [S(0, 950, 500)])[0]!;
    expect(ok.verdict).toBe("pass");
    expect(ok.value).toBe(50);
  });
});
