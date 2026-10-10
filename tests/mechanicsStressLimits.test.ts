// Stress limits (docs/plans/09-mechanics.md M4): the case input and its refusals, the strength table's interpolation, and the check on the REAL OFFBEAT fields of the golden case
// (tests/golden/offbeat-mechanics). FEED has no strength of its own; a limit that cannot be judged does not pass.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { strengthAt, stressLimitChecks } from "../src/core/mechanicsChecks";
import { buildResults } from "../src/core/resultsParser";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const g = (f: string) => readFileSync(join(root, "tests/golden/offbeat-mechanics", f), "utf8");
const q = (value: number, unit: string) => ({ value, unit });
const sets = {
  "mechanical.elasticity": { model: "constant", youngModulus: q(200, "GPa"), poissonRatio: q(0.3, "1"), source: "a test" },
  "mechanical.thermalExpansion": { linearExpansion: q(10, "ppm/K"), source: "a test" },
};
const pt = (T: number, MPa: number) => ({ temperature: q(T, "K"), strength: q(MPa, "MPa") });
const limit = (over: Record<string, unknown> = {}) => ({ name: "clad-flat", region: "cladding", table: [pt(300, 500), pt(1500, 500)], source: "a test table", ...over });
function caseWith(stressLimits?: unknown) {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.power.linearHeatRate = q(20, "kW/m");
  d.assumptions.thermalOnly = false;
  Object.assign(d.materials.fuel.sets, sets);
  Object.assign(d.materials.cladding.sets, sets);
  d.mechanics = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0, "Pa") };
  if (stressLimits !== undefined) d.mechanics.stressLimits = stressLimits;
  return d;
}
const errors = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);
const results = (stressLimits: unknown) => {
  const n = validateCase(caseWith(stressLimits)).normalized!;
  const r = buildResults(n, { T: g("T"), C: g("C"), time: 5e7, mechanics: { D: g("D"), sigma: g("sigma"), sigmaCyl: g("sigmaCyl"), gapWidth: g("gapWidth"), interfaceP: g("interfaceP") } });
  return Object.fromEntries(r.checks.filter((c) => c.id.startsWith("stressLimit:")).map((c) => [c.id, c]));
};

describe("the stressLimits input", () => {
  it("is accepted with units, and a case without it has none", () => {
    expect(errors(caseWith([limit()]))).toEqual([]);
    expect(errors(caseWith([limit({ table: [{ temperature: q(25, "degC"), strength: q(30000, "psi") }, { temperature: q(600, "degC"), strength: q(10000, "psi") }] })]))).toEqual([]);
    expect(validateCase(caseWith()).normalized!.mechanics!.stressLimits).toBeUndefined();
    const t = validateCase(caseWith([limit({ table: [{ temperature: q(25, "degC"), strength: q(30000, "psi") }, { temperature: q(600, "degC"), strength: q(10000, "psi") }] })])).normalized!.mechanics!.stressLimits![0]!.table;
    expect(t[0]!.temperature).toBeCloseTo(298.15, 9);
    expect(t[0]!.strength).toBeCloseTo(30000 * 6894.757293168, 3);
  });
  it("is refused without a source, name or region, with a table that is too short, unordered or not positive, with two equal names, an unknown key, or the wrong shape", () => {
    expect(errors(caseWith([limit({ source: undefined })]))).toContain("E_PROP_MISSING /mechanics/stressLimits/0/source");
    expect(errors(caseWith([limit({ source: " " })]))).toContain("E_PROP_MISSING /mechanics/stressLimits/0/source");
    expect(errors(caseWith([limit({ name: "" })]))).toContain("E_PROP_MISSING /mechanics/stressLimits/0/name");
    expect(errors(caseWith([limit({ region: "gap" })]))).toContain("E_SCHEMA_INVALID /mechanics/stressLimits/0/region");
    expect(errors(caseWith([limit({ table: [pt(300, 500)] })]))).toContain("E_SCHEMA_INVALID /mechanics/stressLimits/0/table");
    expect(errors(caseWith([limit({ table: [pt(600, 500), pt(300, 500)] })]))).toContain("E_OUT_OF_RANGE /mechanics/stressLimits/0/table/1/temperature");
    expect(errors(caseWith([limit({ table: [pt(300, 500), pt(300, 400)] })]))).toContain("E_OUT_OF_RANGE /mechanics/stressLimits/0/table/1/temperature");
    expect(errors(caseWith([limit({ table: [pt(300, 0), pt(600, 400)] })]))).toContain("E_OUT_OF_RANGE /mechanics/stressLimits/0/table/0/strength");
    expect(errors(caseWith([limit({ table: [{ temperature: q(300, "K") }, pt(600, 400)] })]))).toContain("E_PROP_MISSING /mechanics/stressLimits/0/table/0");
    expect(errors(caseWith([limit(), limit()]))).toContain("E_SCHEMA_INVALID /mechanics/stressLimits/1/name");
    expect(errors(caseWith([limit({ factor: 1 })]))).toContain("E_SCHEMA_INVALID /mechanics/stressLimits/0/factor");
    expect(errors(caseWith([]))).toContain("E_SCHEMA_INVALID /mechanics/stressLimits");
    expect(errors(caseWith("500 MPa"))).toContain("E_SCHEMA_INVALID /mechanics/stressLimits");
  });
});

describe("the strength table", () => {
  const table = [{ temperature: 400, strength: 400e6 }, { temperature: 600, strength: 300e6 }, { temperature: 1000, strength: 100e6 }];
  it("is linear between points and exact at them", () => {
    expect(strengthAt(table, 400)).toBe(400e6);
    expect(strengthAt(table, 500)).toBeCloseTo(350e6, 3);
    expect(strengthAt(table, 600)).toBeCloseTo(300e6, 3);
    expect(strengthAt(table, 800)).toBeCloseTo(200e6, 3);
    expect(strengthAt(table, 1000)).toBe(100e6);
  });
  it("is not defined outside: nothing is extrapolated", () => {
    expect(strengthAt(table, 399.9)).toBeNull();
    expect(strengthAt(table, 1000.1)).toBeNull();
    expect(strengthAt(table, NaN)).toBeNull();
  });
});

describe("the check on the golden OFFBEAT result", () => {
  it("a strength above the stress passes with the smallest margin and where it is", () => {
    const c = results([limit()])["stressLimit:clad-flat"]!;
    expect(c.verdict, c.note).toBe("pass");
    expect(c.unit).toBe("Pa");
    expect(c.value!).toBeGreaterThan(0);
    expect(c.value!).toBeLessThan(500e6);
    expect(c.note).toMatch(/smallest margin at cell \d+ at \d+\.\d K: von Mises [\d.]+ MPa against 500\.00 MPa/);
    expect(c.note).toMatch(/Source: a test table/);
    expect(c.note).toMatch(/not an integrity assessment/);
  });
  it("a strength below the hottest stress fails with a negative margin", () => {
    const c = results([limit({ name: "fuel-low", region: "fuel", table: [pt(300, 100), pt(1800, 100)] })])["stressLimit:fuel-low"]!;
    expect(c.verdict).toBe("fail");
    expect(c.value!).toBeLessThan(0);
  });
  it("the margin is strength minus stress: the same stress against a strength 100 MPa higher has a margin 100 MPa larger", () => {
    const a = results([limit({ table: [pt(300, 500), pt(1500, 500)] })])["stressLimit:clad-flat"]!.value!;
    const b = results([limit({ table: [pt(300, 600), pt(1500, 600)] })])["stressLimit:clad-flat"]!.value!;
    expect(b - a).toBeCloseTo(100e6, -2);
  });
  it("cells outside the table cannot be judged and the limit fails, saying so, whatever the cells inside show", () => {
    const c = results([limit({ table: [pt(2000, 900), pt(2500, 900)] })])["stressLimit:clad-flat"]!;
    expect(c.verdict).toBe("fail");
    expect(c.value).toBeNull();
    expect(c.note).toMatch(/outside the table \(2000 to 2500 K\)/);
    // a table that ends in the middle of the cladding's temperatures
    const n = validateCase(caseWith()).normalized!;
    const clad = buildResults(n, { T: g("T"), C: g("C"), time: 5e7, mechanics: { D: g("D"), sigma: g("sigma"), sigmaCyl: g("sigmaCyl"), gapWidth: g("gapWidth"), interfaceP: g("interfaceP") } }).radial.filter((p) => p.region === "cladding").map((p) => p.T);
    const mid = (Math.min(...clad) + Math.max(...clad)) / 2;
    const partial = results([limit({ name: "partial", table: [pt(300, 900), pt(mid, 900)] })])["stressLimit:partial"]!;
    expect(partial.verdict).toBe("fail");
    expect(partial.note).toMatch(/Smallest margin of the \d+ cells inside/);
  });
  it("each limit is its own check, and a case without limits has none", () => {
    const r = results([limit(), limit({ name: "fuel", region: "fuel", table: [pt(300, 1000), pt(1800, 1000)] })]);
    expect(Object.keys(r).sort()).toEqual(["stressLimit:clad-flat", "stressLimit:fuel"]);
    expect(results(undefined)).toEqual({});
  });
});

describe("the check by itself", () => {
  const lim = [{ name: "L", region: "cladding" as const, table: [{ temperature: 300, strength: 400e6 }, { temperature: 900, strength: 100e6 }], source: "s" }];
  const rec = (eq: number[]) => ({ points: eq.map((e) => ({ ur: 0, uz: 0, sigmaR: 0, sigmaTheta: 0, sigmaZ: 0, sigmaEq: e })) }) as any;
  it("the smallest margin of the solid's cells, not the largest, and only the limit's own region", () => {
    const cells = [{ region: "fuel" as const, T: 300 }, { region: "cladding" as const, T: 300 }, { region: "cladding" as const, T: 600 }, { region: "cladding" as const, T: 900 }];
    // strengths 400, 250, 100 MPa against stresses 100, 200, 50 MPa: margins 300, 50, 50 (the fuel cell's 1e9 is ignored)
    const c = stressLimitChecks(lim, rec([1e9, 100e6, 200e6, 50e6]), cells)[0]!;
    expect(c.value).toBeCloseTo(50e6, 0);
    const d = stressLimitChecks(lim, rec([1e9, 100e6, 150e6, 50e6]), cells)[0]!;
    expect(d.value).toBeCloseTo(50e6, 0);
    expect(stressLimitChecks(lim, rec([1e9, 390e6, 10e6, 10e6]), cells)[0]!.value).toBeCloseTo(10e6, 0);
  });
  it("a stress that is not a number fails the limit, and so does a temperature that is not", () => {
    const cells = [{ region: "cladding" as const, T: 300 }, { region: "cladding" as const, T: 500 }];
    const a = stressLimitChecks(lim, rec([NaN, 1e6]), cells)[0]!;
    expect(a.verdict).toBe("fail");
    expect(a.note).toMatch(/not a finite number/);
    expect(stressLimitChecks(lim, rec([1e6, 1e6]), [cells[0]!, { region: "cladding", T: NaN }])[0]!.verdict).toBe("fail");
  });
  it("a margin of exactly zero passes and a negative one fails", () => {
    const cells = [{ region: "cladding" as const, T: 300 }];
    expect(stressLimitChecks(lim, rec([400e6]), cells)[0]!.verdict).toBe("pass");
    expect(stressLimitChecks(lim, rec([400e6 + 1]), cells)[0]!.verdict).toBe("fail");
  });
});
