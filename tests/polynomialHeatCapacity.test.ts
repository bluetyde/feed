// Quadratic and tabulated heat capacity (src/core/heatCapacity.ts and what uses it). The expected values come from routes the code under test does not use:
// Simpson quadrature of c(T) and a bisection on it, an hand-computed writer line, the table's own points.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { evaluate } from "../src/core/conductivity";
import { heatCapacityLaw, heatCapacityRange } from "../src/core/heatCapacity";
import { fitChecks } from "../src/core/resultsParser";
import { generatePulse, KineticsError, KineticsSpec, temperatureRiseLaw } from "../src/core/pointKinetics";
import { solveTransientFv, storedEnergy, TransientPin } from "../src/core/transientFv";
import { transientPreview } from "../src/core/transientPreview";
import { buildTransientResults, pinOf } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });

/** The integral of c from lo to hi by composite Simpson, and the temperature where it reaches e by bisection: no code of the module. */
const simpson = (f: (x: number) => number, lo: number, hi: number, m = 2000) => {
  const h = (hi - lo) / m;
  let s = f(lo) + f(hi);
  for (let i = 1; i < m; i++) s += (i % 2 ? 4 : 2) * f(lo + i * h);
  return (s * h) / 3;
};
const reach = (c: number[], T0: number, e: number) => {
  let lo = T0;
  let hi = T0 + 5000;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (simpson((T) => c[0]! + c[1]! * T + c[2]! * T * T, T0, mid, 400) < e) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
};

const CP = [0.9e6, 4170, -1.0]; // J/m3/K, J/m3/K2, J/m3/K3: c(1500 K) = 4.9 MJ/m3/K
const cpSet = (c = CP, range: [number, number] = [250, 1500]) => ({ model: "polynomial", a: q(c[0]!, "J/m3/K"), b: q(c[1]!, "J/m3/K2"), c: q(c[2]!, "J/m3/K3"), validRange: { min: q(range[0], "K"), max: q(range[1], "K") }, source: "test" });
const TABLE = [[250, 1.9e6], [500, 2.9e6], [800, 4.0e6], [1200, 5.0e6], [1500, 5.4e6]] as const;
const tableSet = (degree = 2, tol = 5) => ({ model: "table", points: TABLE.map(([T, c]) => ({ temperature: q(T, "K"), heatCapacity: q(c, "J/m3/K") })), fit: { degree, tolerance: q(tol, "%") }, source: "test" });
const pulseWith = (fuelCp: unknown) => {
  const d = read("examples/synthetic-pulse.json");
  d.materials.fuel.sets["thermal.volumetricHeatCapacity"] = fuelCp;
  return d;
};
const normalized = (doc: unknown) => {
  const v = validateCase(doc);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};

describe("the heat capacity as a law", () => {
  it("a constant is [c], a linear law [a, b], a polynomial its three coefficients; only a constant has no range", () => {
    expect(heatCapacityLaw({ kind: "constant", c: 3e6, referenceTemperature: 300 })).toEqual([3e6]);
    expect(heatCapacityLaw({ kind: "linear", a: 1, b: 2, range: [1, 2] })).toEqual([1, 2]);
    expect(heatCapacityLaw({ kind: "polynomial", coefficients: [1, 2, 3], range: [5, 6] })).toEqual([1, 2, 3]);
    expect(heatCapacityRange({ kind: "constant", c: 3e6, referenceTemperature: 300 })).toBeUndefined();
    expect(heatCapacityRange({ kind: "linear", a: 1, b: 2, range: [1, 2] })).toEqual([1, 2]);
    expect(heatCapacityRange({ kind: "polynomial", coefficients: [1, 2, 3], range: [5, 6] })).toEqual([5, 6]);
  });
});

describe("a quadratic heat capacity in the validator and the writer", () => {
  it("is accepted, normalizes to its three coefficients and its range, and is written through SiCSnead with all four parameters", () => {
    const n = normalized(pulseWith(cpSet()));
    expect(n.fuelHeatCapacity).toEqual({ kind: "polynomial", coefficients: CP, range: [250, 1500] });
    const f = writeOffbeatCase(n).files["constant/solverDict"]!;
    expect(f).toMatch(/heatCapacityModel SiCSnead;/);
    expect(f).toMatch(/heatCapacity \{ par1 90; par2 0\.417; par3 -0\.0001; par4 0; \}/); // over rho = 10000 kg/m3
  });

  it("a table is carried by its fitted polynomial, with the fit recorded; the range is the table's own", () => {
    const n = normalized(pulseWith(tableSet()));
    const cp = n.fuelHeatCapacity!;
    if (cp.kind !== "polynomial" || !cp.fit) throw new Error("not a fitted polynomial");
    expect(cp.range).toEqual([250, 1500]);
    expect(cp.coefficients.length).toBe(3);
    expect(cp.fit.degree).toBe(2);
    expect(cp.fit.points.length).toBe(5);
    // the recorded deviation is the one at the table's points of the coefficients that were written
    const worst = Math.max(...TABLE.map(([T, c]) => Math.abs(evaluate(cp.coefficients, T) - c) / c));
    expect(cp.fit.maxRelativeDeviation).toBeCloseTo(worst, 12);
    expect(cp.fit.maxRelativeDeviation).toBeLessThan(0.05);
  });

  it("a table's fit is a result check for the region that has one, heat capacity named as such, and for no other", () => {
    const checks = fitChecks(normalized(pulseWith(tableSet())));
    expect(checks.map((c) => c.id)).toEqual(["heatCapacityFitFuel"]);
    expect(checks[0]!.verdict).toBe("pass");
    expect(checks[0]!.note).toMatch(/OFFBEAT has no tabulated heat capacity/);
    expect(checks[0]!.label).toMatch(/fuel's tabulated heat capacity/);
    expect(fitChecks(normalized(pulseWith(cpSet()))).map((c) => c.id)).toEqual([]);
    const clad = read("examples/synthetic-pulse.json");
    clad.materials.cladding.sets["thermal.volumetricHeatCapacity"] = tableSet();
    expect(fitChecks(normalized(clad)).map((c) => c.id)).toEqual(["heatCapacityFitCladding"]);
  });

  it("a table has at most degree 2 for heat capacity (and 3 for conductivity)", () => {
    const v = validateCase(pulseWith(tableSet(3)));
    expect(v.errors.map((e) => e.code + " " + e.field)).toEqual(["E_OUT_OF_RANGE /materials/fuel/sets/thermal.volumetricHeatCapacity/fit/degree"]);
    expect(v.errors[0]!.message).toMatch(/the fit degree is 1 or 2/);
  });

  it("a heat capacity outside 1e3 to 1e8 J/m3/K anywhere in its range is refused (the units check), by the extremes and not by samples", () => {
    const hump = cpSet([0, 2e5, -100], [300, 1500]); // c = 2e5 T - 100 T^2: 1e8 at its vertex, 1000 K, and 5.1e7 at 300 K
    expect(validateCase(pulseWith(hump)).errors).toEqual([]);
    const higher = cpSet([1e6, 2e5, -100], [300, 1500]); // 1.01e8 at the vertex
    const v = validateCase(pulseWith(higher));
    expect(v.errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
  });

  it("a quadratic that falls below the lower bound inside the range, with both ends above it, is refused", () => {
    // c = 1.2e6 - ... minimum at the vertex: c = 2e6 - 4000 (T - 700) + ... build as a (T - 700)^2 term: 1500 + 10 (T-700)^2 = 1500 + 10 T^2 - 14000 T + 4.9e6 -> tiny at 700
    const dip = cpSet([4.9e6 + 1500, -14000, 10], [300, 1100]); // 1500 at 700 K; at 300 K: 1500 + 1.6e6, positive and inside bounds
    expect(validateCase(pulseWith(dip)).errors).toEqual([]);
    const lower = cpSet([4.9e6 + 500, -14000, 10], [300, 1100]); // 500 at 700 K: below 1e3
    expect(validateCase(pulseWith(lower)).errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
  });
});

describe("a quadratic heat capacity in the independent finite-volume solver", () => {
  const pinWith = (law: number[], qOf: (t: number) => number): TransientPin => ({
    fuelInnerRadius: 0,
    fuelRadius: 0.0041,
    claddingInnerRadius: 0.00418,
    claddingOuterRadius: 0.00475,
    fuelCells: 20,
    claddingCells: 6,
    gapConductance: 5000,
    fuelK: { a: 3, b: 0 },
    claddingK: { a: 15, b: 0 },
    fuelC: { a: 1, b: 0 }, // not used: the law is
    claddingC: { a: 2.5e6, b: 0 },
    fuelCLaw: law,
    boundary: { kind: "convective", bulkTemperature: 300, heatTransferCoefficient: 1e-9 },
    power: qOf,
  });
  const area = Math.PI * 0.0041 ** 2;
  const triangle = (peak: number, width: number) => (t: number) => (t < 0 ? 0 : t < width / 2 ? (peak * 2 * t) / width : t < width ? (peak * 2 * (width - t)) / width : 0);

  it("adiabatic heating reaches the temperature where the integral of c(T) is the deposited energy per volume (Simpson and bisection, independent)", () => {
    const peak = 1e7;
    const width = 0.01;
    const e3 = (0.5 * peak * width) / area;
    const exact = reach(CP, 300, e3);
    const T = solveTransientFv(pinWith(CP, triangle(peak, width)), { dt: width / 200, steps: 200, initialTemperature: 300, outputEvery: 200, source: "average" }).states[1]!.T;
    expect(Math.max(...T.slice(0, 10))).toBeCloseTo(exact, 3);
    expect(Math.min(...T.slice(0, 10))).toBeCloseTo(exact, 3);
    // the quadratic term matters: dropping it would be badly wrong
    expect(Math.abs(reach([CP[0]!, CP[1]!, 0], 300, e3) - exact)).toBeGreaterThan(15);
  });

  it("the stored energy is the deposited energy when no heat leaves (the enthalpy is the primitive of the law)", () => {
    const peak = 1e7;
    const width = 0.01;
    const p = pinWith(CP, triangle(peak, width));
    const out = solveTransientFv(p, { dt: width / 400, steps: 400, initialTemperature: 300, outputEvery: 400, source: "average" }).states[1]!.T;
    const deposited = 0.5 * peak * width;
    expect(Math.abs(storedEnergy(p, out, 300) - deposited) / deposited).toBeLessThan(1e-3);
  });

  it("the case's pin carries the law of each solid, and a constant is a law of one coefficient", () => {
    const pin = pinOf(normalized(pulseWith(cpSet())));
    expect(pin.fuelCLaw).toEqual(CP);
    expect(pin.claddingCLaw).toEqual([2.5e6]);
  });
});

describe("a quadratic heat capacity in the pulse generator and the preview", () => {
  const spec: KineticsSpec = {
    reactivity: 0.01,
    insertionTime: 0,
    generationTime: 1e-4,
    groups: [],
    feedback: { kind: "constant", alpha: -1e-4 },
    initialPower: 1,
    pins: 1,
    activeLength: 1,
    peakingFactor: 1,
    endTime: 0.3,
  };
  const area = 1e-4;

  it("temperatureRiseLaw is the root of the integral of the law (Simpson and bisection)", () => {
    for (const e of [1e6, 1e8, 3e8]) near(300 + temperatureRiseLaw(CP, 300, e), reach(CP, 300, e), 1e-9);
  });

  it("refuses an energy the law cannot take (it would have to turn negative), as a kinetics error", () => {
    const law = [1e6, 0, -1]; // zero at 1000 K; the integral from 300 K to 1000 K is 7e8 - (1e9 - 2.7e7) / 3
    const limit = 7e8 - (1e9 - 2.7e7) / 3;
    expect(() => temperatureRiseLaw(law, 300, limit * 1.01)).toThrow(KineticsError);
    expect(() => temperatureRiseLaw(law, 300, limit * 1.01)).toThrow(/cannot take this much energy/);
    expect(300 + temperatureRiseLaw(law, 300, limit * 0.5)).toBeLessThan(1000);
  });

  it("the generated pulse's final fuel temperature is where the integral of the quadratic equals the energy it deposited per unit volume", () => {
    const pulse = generatePulse(spec, { fuelArea: area, fuelC: { a: CP[0]!, b: CP[1]! }, fuelLaw: CP, startTemperature: 300 });
    const e3 = pulse.summary.totalEnergy / area;
    expect(pulse.summary.finalFuelTemperature).toBeCloseTo(reach(CP, 300, e3), 4);
    // with the quadratic term left out the pulse would be another one
    const flat = generatePulse(spec, { fuelArea: area, fuelC: { a: CP[0]!, b: CP[1]! }, startTemperature: 300 });
    expect(Math.abs(flat.summary.totalEnergy - pulse.summary.totalEnergy) / pulse.summary.totalEnergy).toBeGreaterThan(0.01);
  });

  it("through the case: a generated pulse on a pin with a quadratic heat capacity validates and uses the law", () => {
    const d = read("examples/synthetic-pulse-kinetics.json");
    d.materials.fuel.sets["thermal.volumetricHeatCapacity"] = cpSet(CP, [250, 2500]);
    const v = validateCase(d);
    expect(v.errors.filter((e) => e.severity === "error")).toEqual([]);
    const base = validateCase(read("examples/synthetic-pulse-kinetics.json")).normalized!;
    expect(v.normalized!.transient!.linearHeatRate.length).toBeGreaterThan(3);
    expect(v.normalized!.transient!.linearHeatRate).not.toEqual(base.transient!.linearHeatRate);
  });

  it("the preview's adiabatic ceiling uses the law", () => {
    const n = normalized(pulseWith(cpSet(CP, [250, 2500])));
    const energy = n.transient!.linearHeatRate.reduce((s, v, i, a) => (i === 0 ? 0 : s + 0.5 * (v + a[i - 1]!) * (n.transient!.times[i]! - n.transient!.times[i - 1]!)), 0);
    const perVolume = energy / (Math.PI * (n.fuelRadius ** 2 - n.fuelInnerRadius ** 2));
    const prev = transientPreview(n, { fv: null, skipped: "not needed" });
    expect(prev.adiabaticPeak).toBeCloseTo(reach(CP, 300, perVolume), 2);
  });
});

function near(a: number, b: number, rel: number) {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(Math.abs(a), Math.abs(b)));
}

describe("edges the mutation run found (heat capacity)", () => {
  const golden = join(root, "tests/golden/offbeat-pulse");
  const goldenInput = () => ({
    C: readFileSync(join(golden, "C"), "utf8"),
    fields: readdirSync(join(golden, "times")).sort((a, b) => Number(a) - Number(b)).map((d) => ({ time: Number(d), T: readFileSync(join(golden, "times", d, "T"), "utf8") })),
  });

  it("a heat capacity of exactly 1e3 or 1e8 J/m3/K at the edge of the range is accepted, one beyond is refused", () => {
    const flat = (c: number) => cpSet([c, 0, 0], [250, 1500]);
    expect(validateCase(pulseWith(flat(1e3))).errors).toEqual([]);
    expect(validateCase(pulseWith(flat(1e8))).errors).toEqual([]);
    expect(validateCase(pulseWith(flat(999))).errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
    expect(validateCase(pulseWith(flat(1e8 + 1))).errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
  });

  it("the refusals of a heat capacity speak in J/m3/K, not in W/m/K", () => {
    const negative = validateCase(pulseWith(cpSet([4.9e6 + 1500, -14000, 10], [300, 1100])));
    expect(negative.errors).toEqual([]);
    const v = validateCase(pulseWith(cpSet([-1e6, 0, 0], [300, 1100])));
    expect(v.errors[0]!.message).toMatch(/heat capacity is not positive over its stated range 300 to 1100 K \(its lowest value there is -1\.000e\+6 J\/m3\/K\)/);
    expect(v.errors[0]!.unit).toBe("J/m3/K");
    const big = validateCase(pulseWith(cpSet([2e8, 0, 0], [300, 1100])));
    expect(big.errors[0]!.message).toMatch(/outside 1000 to 100000000 J\/m3\/K/);
  });

  it("a steady operating start that puts a solid outside the stated range of its heat capacity polynomial is refused", () => {
    const d = pulseWith(cpSet(CP, [250, 400]));
    delete d.transient.initialTemperature;
    d.transient.initialSteadyLinearHeatRate = q(10, "kW/m");
    const v = validateCase(d);
    expect(v.errors.map((e) => e.code + " " + e.field)).toEqual(["E_OUT_OF_RANGE /transient/initialSteadyLinearHeatRate"]);
    expect(v.errors[0]!.message).toMatch(/outside the stated range of its heat capacity law \(250 to 400 K\)/);
  });

  it("a quadratic with a zero quadratic term is the linear law: the same generated pulse as the linear model", () => {
    const lin = read("examples/synthetic-pulse-kinetics.json");
    lin.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: q(0.9e6, "J/m3/K"), b: q(4170, "J/m3/K2"), validRange: { min: q(250, "K"), max: q(2500, "K") }, source: "test" };
    const poly = read("examples/synthetic-pulse-kinetics.json");
    poly.materials.fuel.sets["thermal.volumetricHeatCapacity"] = cpSet([0.9e6, 4170, 0], [250, 2500]);
    const a = normalized(lin).transient!;
    const b = normalized(poly).transient!;
    expect(b.linearHeatRate).toEqual(a.linearHeatRate);
    expect(b.times).toEqual(a.times);
  });

  it("the pulse a case generates is the pulse of the generator given the law (not the line through the first two coefficients)", () => {
    const d = read("examples/synthetic-pulse-kinetics.json");
    d.materials.fuel.sets["thermal.volumetricHeatCapacity"] = cpSet(CP, [250, 3000]);
    const n = normalized(d);
    const direct = generatePulse(n.transient!.kinetics!, { fuelArea: Math.PI * (n.fuelRadius ** 2 - n.fuelInnerRadius ** 2), fuelC: { a: CP[0]!, b: CP[1]! }, fuelLaw: CP, startTemperature: n.transient!.initial.kind === "uniform" ? n.transient!.initial.temperature : NaN });
    expect(n.transient!.linearHeatRate).toEqual(direct.linearHeatRate);
  });

  it("the property-range check is in the results of a pin whose only temperature-dependent law is a heat capacity polynomial, and fails when the pulse leaves its range", () => {
    const wide = buildTransientResults(normalized(pulseWith(cpSet([3e6, 0, 0], [250, 2500]))), goldenInput());
    expect(wide.checks.find((c) => c.id === "propertyRange")!.verdict).toBe("pass");
    expect(wide.domain.verdict).toBe("in-domain");
    const narrow = buildTransientResults(normalized(pulseWith(cpSet([3e6, 0, 0], [250, 400]))), goldenInput());
    expect(narrow.checks.find((c) => c.id === "propertyRange")!.verdict).toBe("fail");
    expect(narrow.domain.verdict).toBe("out-of-domain");
    expect(narrow.domain.findings[0]).toMatchObject({ region: "fuel", validRange: [250, 400] });
  });

  it("the cladding's table check is the cladding's: id, label and region agree", () => {
    const d = read("examples/synthetic-pulse.json");
    d.materials.cladding.sets["thermal.volumetricHeatCapacity"] = tableSet();
    const c = fitChecks(normalized(d))[0]!;
    expect(c.id).toBe("heatCapacityFitCladding");
    expect(c.label).toMatch(/^The cladding's tabulated heat capacity/);
    const f = fitChecks(normalized(pulseWith(tableSet())))[0]!;
    expect(f.label).toMatch(/^The fuel's tabulated heat capacity/);
  });
});
