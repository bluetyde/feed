// Plan 17 M2: a pin may ask for mechanics and a transient together. The validator accepts it, with a warning that the run is not built yet (M4); the writer refuses it rather than
// make a thermal-only run that looks complete. The gas pressure of a transient (a table against time, the hydrogen equilibrium pressure at each output time's temperature), the
// quasi-static check with its numbers (D2), and the refusals that stay (a plate, a stack, a burnup, hot dimensions). Expected values are worked by hand in the comments.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { validateCase } from "../src/core/validate";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { effectiveMechanics } from "../src/core/mechanicalEval";
import { fastestDoubling, lowestModulus, QUASI_STATIC_TRANSITS, waveTransitTime, WAVE_DENSITY_BOUND } from "../src/core/quasiStatic";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const both = {
  "mechanical.elasticity": { model: "constant", youngModulus: q(100, "GPa"), poissonRatio: q(0.3, "1"), source: "a test" },
  "mechanical.thermalExpansion": { linearExpansion: q(10, "ppm/K"), source: "a test" },
};
const sec = (extra: Record<string, unknown> = {}) => ({ referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0.1, "MPa"), ...extra });
/** The synthetic pulse (10 ms triangle, 100 ms run, 0.1 ms steps) with mechanics. */
const pulse = (extra: Record<string, unknown> = {}) => {
  const d = read("examples/synthetic-pulse.json");
  Object.assign(d.materials.fuel.sets, both);
  Object.assign(d.materials.cladding.sets, both);
  d.assumptions.thermalOnly = false;
  d.mechanics = sec(extra);
  return d;
};
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);
const warn = (d: unknown) => validateCase(d).warnings.map((w) => w.code);
const pt = (t: number, mw: number) => ({ time: q(t, "ms"), linearHeatRate: q(mw, "MW/m") });
const table = (rows: number[][]) => ({ model: "table", table: rows.map(([t, p]) => ({ time: q(t, "ms"), pressure: q(p, "MPa") })), source: "a test" });

describe("mechanics with a transient (plan 17 M2)", () => {
  it("a pin with both is valid, carries its mechanics and the warning that the run is not built yet", () => {
    const r = validateCase(pulse());
    expect(r.errors).toEqual([]);
    expect(r.normalized?.mechanics?.referenceTemperature).toBe(300);
    expect(r.normalized?.transient).toBeDefined();
    expect(r.warnings.map((w) => w.code)).toEqual(["W_TRANSIENT_MECHANICS_NOT_SOLVABLE"]);
  });
  it("the writer refuses it: no thermal-only run is made in its place", () => {
    const n = validateCase(pulse()).normalized!;
    expect(() => writeOffbeatCase(n)).toThrow(/E_UNSUPPORTED.*plan 17/);
    // the same case without the mechanics section still writes (a thermal transient), and a steady mechanics case still writes
    const thermal = read("examples/synthetic-pulse.json");
    expect(() => writeOffbeatCase(validateCase(thermal).normalized!)).not.toThrow();
    const steady = read("examples/synthetic-pin.json");
    Object.assign(steady.materials.fuel.sets, both);
    Object.assign(steady.materials.cladding.sets, both);
    steady.assumptions.thermalOnly = false;
    steady.mechanics = sec();
    expect(() => writeOffbeatCase(validateCase(steady).normalized!)).not.toThrow();
  });
  it("a transient has no one set of constants: the steady evaluator gives nothing for it, a steady case still gets its constants", () => {
    expect(effectiveMechanics(validateCase(pulse()).normalized!)).toBeUndefined();
    const steady = read("examples/synthetic-pin.json");
    Object.assign(steady.materials.fuel.sets, both);
    Object.assign(steady.materials.cladding.sets, both);
    steady.assumptions.thermalOnly = false;
    steady.mechanics = sec();
    expect(effectiveMechanics(validateCase(steady).normalized!)).toBeDefined();
  });
  it("the combinations that stay refused: burnup, hot dimensions, a stack, a plate", () => {
    const hot = pulse();
    hot.hotDimensions = {
      referenceTemperature: q(20, "degC"),
      fuel: { linearExpansion: q(12, "ppm/K"), source: "a test" },
      cladding: { linearExpansion: q(10, "ppm/K"), source: "a test" },
    };
    expect(codes(hot)).toContain("E_UNSUPPORTED /hotDimensions");
    const stack = pulse();
    stack.axial = { length: q(0.381, "m"), slices: 5, powerShape: { kind: "cosine" } };
    expect(codes(stack)).toContain("E_UNSUPPORTED /axial");
    const burn = pulse();
    burn.burnup = { value: q(10, "MWd/kgHM"), basis: "heavy-metal", source: "a test" };
    expect(codes(burn).some((c) => c.startsWith("E_UNSUPPORTED /burnup"))).toBe(true);
  });
});

describe("the gas pressure of a transient (plan 17 D4)", () => {
  it("a table against time is normalised as given (times in s, pressures in Pa)", () => {
    const ip = validateCase(pulse({ internalPressure: table([[0, 0.1], [10, 2], [100, 0.5]]) })).normalized!.mechanics!.internalPressure!;
    expect(ip).toEqual({ kind: "table", times: [0, 0.01, 0.1], pressures: [1e5, 2e6, 5e5], source: "a test" });
  });
  it("a table must start at 0, increase in time, hold non-negative pressures, have two points, and reach the end time", () => {
    expect(codes(pulse({ internalPressure: table([[1, 0.1], [100, 2]]) }))).toEqual(["E_OUT_OF_RANGE /mechanics/internalPressure/table/0/time"]);
    expect(codes(pulse({ internalPressure: table([[0, 0.1], [50, 2], [20, 1]]) }))).toEqual(["E_OUT_OF_RANGE /mechanics/internalPressure/table/2/time"]);
    expect(codes(pulse({ internalPressure: table([[0, 0.1], [100, -2]]) }))).toEqual(["E_OUT_OF_RANGE /mechanics/internalPressure/table/1/pressure"]);
    expect(codes(pulse({ internalPressure: table([[0, 0.1]]) }))).toEqual(["E_SCHEMA_INVALID /mechanics/internalPressure/table"]);
    expect(codes(pulse({ internalPressure: table([[0, 0.1], [50, 2]]) }))).toEqual(["E_TRANSIENT_INCOMPLETE /mechanics/internalPressure/table"]);
    // a table that reaches the end time (100 ms) is fine, and a pressure of 0 is a point like any other
    expect(codes(pulse({ internalPressure: table([[0, 0], [100, 0]]) }))).toEqual([]);
    const r = validateCase(pulse({ internalPressure: table([[0, 0.1], [50, 2]]) }));
    expect(r.ok).toBe(false);
    expect(r.normalized).toBeUndefined();
  });
  it("a point with an unknown key, no time or no pressure is refused", () => {
    const d = pulse({ internalPressure: { model: "table", table: [{ time: q(0, "ms"), pressure: q(1, "MPa"), phase: "x" }, { time: q(100, "ms") }], source: "a test" } });
    expect(codes(d)).toEqual(["E_SCHEMA_INVALID /mechanics/internalPressure/table/0/phase", "E_PROP_MISSING /mechanics/internalPressure/table/1/pressure"]);
  });
  it("a table is for a transient only", () => {
    const steady = read("examples/synthetic-pin.json");
    Object.assign(steady.materials.fuel.sets, both);
    Object.assign(steady.materials.cladding.sets, both);
    steady.assumptions.thermalOnly = false;
    steady.mechanics = sec({ internalPressure: table([[0, 0.1], [100, 2]]) });
    expect(codes(steady)).toEqual(["E_UNSUPPORTED /mechanics/internalPressure/model"]);
  });
  it("the hydrogen pressure takes the instantaneous peak or mean in a transient, the closed-form peak or mean in a steady case, never the other", () => {
    const h = (basis: string) => ({ model: "hydrogen-zrh", hZrRatio: q(1.65, "1"), fuelTemperature: basis, source: "a test" });
    expect(validateCase(pulse({ internalPressure: h("instantaneous-peak") })).normalized!.mechanics!.internalPressure).toMatchObject({ kind: "hydrogen-zrh", basis: "instantaneous-peak" });
    expect(validateCase(pulse({ internalPressure: h("instantaneous-mean") })).normalized!.mechanics!.internalPressure).toMatchObject({ basis: "instantaneous-mean" });
    expect(codes(pulse({ internalPressure: h("peak") }))).toEqual(["E_UNSUPPORTED /mechanics/internalPressure/fuelTemperature"]);
    const steady = read("examples/synthetic-pin.json");
    Object.assign(steady.materials.fuel.sets, both);
    Object.assign(steady.materials.cladding.sets, both);
    steady.assumptions.thermalOnly = false;
    steady.mechanics = sec({ internalPressure: h("instantaneous-peak") });
    expect(codes(steady)).toEqual(["E_UNSUPPORTED /mechanics/internalPressure/fuelTemperature"]);
    steady.mechanics = sec({ internalPressure: h("peak") });
    expect(codes(steady)).toEqual([]);
  });
});

describe("the quasi-static check (plan 17 D2)", () => {
  it("the wave transit time is radius / sqrt(E / rho): 4.1 mm in 100 GPa at 11000 kg/m3 is 4.1e-3 / 3015.1 = 1.3598 us", () => {
    expect(waveTransitTime(4.1e-3, 100e9)).toBeCloseTo(4.1e-3 / Math.sqrt(100e9 / WAVE_DENSITY_BOUND), 15);
    expect(waveTransitTime(4.1e-3, 100e9)).toBeCloseTo(1.3598e-6, 10);
    // the TRIGA fuel from the read data: 62.7 GPa, 5940 kg/m3, 18.161 mm: 18.161e-3 / sqrt(62.7e9 / 5940) = 5.59 us (the plan recorded 4.7 us from the radius to the hole)
    expect(waveTransitTime(18.161e-3, 62.7e9, 5940)).toBeCloseTo(18.161e-3 / Math.sqrt(62.7e9 / 5940), 12);
  });
  it("the lowest modulus is the constant, or the smaller end of the range of a linear law", () => {
    expect(lowestModulus({ kind: "constant", E: 190e9, nu: 0.3 })).toBe(190e9);
    expect(lowestModulus({ kind: "linear", a: 80e9, b: -0.03e9, nu: 0.3, range: [293, 923] })).toBeCloseTo(80e9 - 0.03e9 * 923, 0);
    expect(lowestModulus({ kind: "linear", a: 60e9, b: 0.01e9, nu: 0.3, range: [293, 923] })).toBeCloseTo(60e9 + 0.01e9 * 293, 0);
  });
  it("the fastest doubling: a segment from 1 to 2 MW/m in 0.05 ms doubles in 0.05 ms; a rise from zero and a fall to zero count for nothing; a constant history has none", () => {
    const f = fastestDoubling([0, 1, 1.05, 5], [0, 1, 2, 0])!;
    expect(f.time).toBeCloseTo(0.05, 12);
    expect(f.at).toBe(1);
    // a fall from 2 to 1 in 1 s halves in 1 s
    expect(fastestDoubling([0, 1], [2, 1])).toEqual({ time: 1, at: 0 });
    // from 1 to 1.5 in 1 s: the doubling at that rate takes 1 * 1 / 0.5 = 2 s
    expect(fastestDoubling([0, 1], [1, 1.5])!.time).toBeCloseTo(2, 12);
    expect(fastestDoubling([0, 1, 2], [3, 3, 3])).toBeUndefined();
  });
  it("a slow pulse gets no warning; a pulse that doubles in 50 us (37 transits) does, with the numbers", () => {
    expect(warn(pulse())).toEqual(["W_TRANSIENT_MECHANICS_NOT_SOLVABLE"]);
    const fast = pulse();
    fast.transient.powerHistory = [pt(0, 0), pt(1, 1), pt(1.05, 2), pt(5, 0), pt(100, 0)];
    fast.transient.timeStep = q(0.05, "ms");
    const r = validateCase(fast);
    expect(r.errors).toEqual([]);
    const w = r.warnings.find((x) => x.code === "W_QUASI_STATIC")!;
    expect(w).toBeDefined();
    // 0.05 ms / 1.3598 us = 36.8 transit times
    expect(w.message).toMatch(/5\.00e-5 s/);
    expect(w.message).toMatch(/37 transit times, below 100/);
    expect(w.field).toBe("/transient/powerHistory");
  });
  it("the threshold is 100 transit times of the fuel radius: a doubling at 1.5e-4 s (110 transits) passes, one at 1.2e-4 s (88) warns", () => {
    expect(QUASI_STATIC_TRANSITS).toBe(100);
    const history = (doubling: number) => {
      // 1 MW/m to 2 MW/m in `doubling` seconds
      const d = pulse();
      const t0 = 1;
      d.transient.powerHistory = [pt(0, 0), pt(t0, 1), pt(t0 + doubling * 1000, 2), pt(t0 + doubling * 1000 + 4, 0), pt(100, 0)];
      d.transient.timeStep = q(0.05, "ms");
      return d;
    };
    expect(warn(history(1.5e-4))).not.toContain("W_QUASI_STATIC");
    expect(warn(history(1.2e-4))).toContain("W_QUASI_STATIC");
  });
  it("a thermal-only transient and a steady mechanics case never get either new warning", () => {
    expect(warn(read("examples/synthetic-pulse.json"))).toEqual([]);
    const steady = read("examples/synthetic-pin.json");
    Object.assign(steady.materials.fuel.sets, both);
    Object.assign(steady.materials.cladding.sets, both);
    steady.assumptions.thermalOnly = false;
    steady.mechanics = sec();
    expect(warn(steady)).not.toContain("W_TRANSIENT_MECHANICS_NOT_SOLVABLE");
    expect(warn(steady)).not.toContain("W_QUASI_STATIC");
  });
});

describe("what a transient does not borrow from the steady case", () => {
  it("the range warnings of the steady profile are not given for a transient (a pulse has no one profile; the per-time ranges come with M3)", () => {
    const d = pulse();
    d.materials.fuel.sets["mechanical.elasticity"] = { model: "linear", a: q(250, "GPa"), b: q(-0.05, "GPa/K"), poissonRatio: q(0.3, "1"), validRange: { min: q(300, "K"), max: q(400, "K") }, source: "a test" };
    d.transient.initialTemperature = q(1200, "K");
    expect(warn(d)).toEqual(["W_TRANSIENT_MECHANICS_NOT_SOLVABLE"]);
  });
});
