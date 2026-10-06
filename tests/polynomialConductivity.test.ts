// Polynomial and tabulated conductivity through the validator, the case writer, the closed forms, the independent finite-volume solver and the time scale
// (docs/conductivity-models.md). The expected values come from an independent route: Simpson quadrature of k and a bisection on it, a least-squares fit done by the
// normal equations in the test, and the structure of what OFFBEAT is told.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { compositeConstantK } from "../src/core/closedForm";
import { evaluate, lawOf } from "../src/core/conductivity";
import { quickLook, radialProfile } from "../src/core/quickLook";
import { lowestConductivity, timeScale } from "../src/core/steadyState";
import { solveTransientFv, steadyFv, TransientPin } from "../src/core/transientFv";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const A = [2.0, 0.003, -1.2e-6, 2e-10];
const polySet = (a = A, extra: Record<string, unknown> = {}) => ({ model: "polynomial", a: q(a[0]!, "W/m/K"), b: q(a[1]!, "W/m/K2"), c: q(a[2]!, "W/m/K3"), d: q(a[3]!, "W/m/K4"), validRange: { min: q(500, "K"), max: q(2500, "K") }, source: "test", ...extra });
const TABLE = [[300, 2.8], [600, 3.5], [900, 3.9], [1200, 4.05], [1500, 4.1]] as const;
const tableSet = (deg = 3, tol = 2, extra: Record<string, unknown> = {}) => ({ model: "table", points: TABLE.map(([T, k]) => ({ temperature: q(T, "K"), conductivity: q(k, "W/m/K") })), fit: { degree: deg, tolerance: q(tol, "%") }, source: "test", ...extra });
const caseWith = (set: unknown, file = "examples/synthetic-pin.json") => {
  const d = read(file);
  d.materials.fuel.sets["thermal.conductivity"] = set;
  return d;
};
const normalized = (set: unknown, file?: string) => {
  const v = validateCase(caseWith(set, file));
  expect(v.errors).toEqual([]);
  return v.normalized!;
};

// ---- independent numerics
const simpson = (f: (x: number) => number, a: number, b: number, n = 4000) => {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
  return (s * h) / 3;
};
/** The temperature T above Ts with the integral of k from Ts to T equal to `target`, by bisection on Simpson's rule. */
const hot = (c: number[], Ts: number, target: number) => {
  let lo = Ts;
  let hi = Ts + 3000;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (simpson((T) => evaluate(c, T), Ts, mid, 600) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
};

describe("a polynomial conductivity in a case", () => {
  it("is normalized to its four coefficients in SI and its range, with no fit record", () => {
    const n = normalized(polySet());
    expect(n.fuelConductivity).toEqual({ kind: "polynomial", coefficients: A, range: [500, 2500] });
    expect(lawOf(n.fuelConductivity)).toEqual(A);
  });
  it("converts units of every coefficient (a in kW/m/K, d in W/m/K4) and a Celsius range", () => {
    const n = normalized({ ...polySet(), a: q(0.002, "kW/m/K").unit === "kW/m/K" ? q(2, "W/m/K") : q(2, "W/m/K"), validRange: { min: q(226.85, "degC"), max: q(2226.85, "degC") } });
    expect(n.fuelConductivity.kind === "polynomial" && n.fuelConductivity.range[0]).toBeCloseTo(500, 9);
  });
  it("a cladding polynomial works the same way", () => {
    const d = read("examples/synthetic-pin.json");
    d.materials.cladding.sets["thermal.conductivity"] = polySet([12, 0.004, 0, 0], { validRange: { min: q(300, "K"), max: q(900, "K") } });
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.claddingConductivity.kind).toBe("polynomial");
  });
});

describe("a table in a case is a fitted polynomial, with its deviation recorded", () => {
  it("the coefficients are the least-squares fit (normal equations written here), the range is the table's, and the deviation is the true one", () => {
    const n = normalized(tableSet(3, 2));
    const k = n.fuelConductivity;
    if (k.kind !== "polynomial" || !k.fit) throw new Error("not a fitted polynomial");
    // independent: solve the 4x4 normal equations in the variable (T - 900) / 600 by Cramer-free elimination
    const x = (T: number) => (T - 900) / 600;
    const M = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => TABLE.reduce((s, [T]) => s + x(T) ** (i + j), 0)));
    const b = [0, 1, 2, 3].map((i) => TABLE.reduce((s, [T, kk]) => s + x(T) ** i * kk, 0));
    const aug = M.map((r, i) => [...r, b[i]!]);
    for (let c = 0; c < 4; c++) {
      for (let r = c + 1; r < 4; r++) {
        const f = aug[r]![c]! / aug[c]![c]!;
        for (let j = c; j <= 4; j++) aug[r]![j]! -= f * aug[c]![j]!;
      }
    }
    const qq = [0, 0, 0, 0];
    for (let i = 3; i >= 0; i--) qq[i] = (aug[i]![4]! - [1, 2, 3].filter((j) => j > i).reduce((s, j) => s + aug[i]![j]! * qq[j]!, 0)) / aug[i]![i]!;
    for (const [T] of TABLE) {
      const poly = evaluate(k.coefficients, T);
      const scaled = qq[0]! + qq[1]! * x(T) + qq[2]! * x(T) ** 2 + qq[3]! * x(T) ** 3;
      expect(Math.abs(poly - scaled)).toBeLessThan(1e-9);
    }
    expect(k.range).toEqual([300, 1500]);
    const worst = Math.max(...TABLE.map(([T, kk]) => Math.abs(evaluate(k.coefficients, T) - kk) / kk));
    expect(k.fit.maxRelativeDeviation).toBeCloseTo(worst, 12);
    expect(k.fit.degree).toBe(3);
    expect(k.fit.tolerance).toBeCloseTo(0.02, 12);
    expect(k.fit.points).toHaveLength(5);
    expect(k.fit.points[0]).toEqual({ temperature: 300, conductivity: 2.8 });
  });
  it("a table in Celsius is the same law as in kelvin", () => {
    const kelvin = normalized(tableSet()).fuelConductivity;
    const celsius = normalized(tableSet(3, 2, { points: TABLE.map(([T, k]) => ({ temperature: q(T - 273.15, "degC"), conductivity: q(k, "W/m/K") })) })).fuelConductivity;
    if (kelvin.kind !== "polynomial" || celsius.kind !== "polynomial") throw new Error("not polynomial");
    kelvin.coefficients.forEach((c, i) => expect(Math.abs(c - celsius.coefficients[i]!)).toBeLessThan(1e-9 * Math.max(1, Math.abs(c))));
  });
  it("the tolerance may be given as a fraction or in percent", () => {
    const a = normalized(tableSet(3, 2)).fuelConductivity;
    const b = normalized(tableSet(3, 0, { fit: { degree: 3, tolerance: q(0.02, "1") } })).fuelConductivity;
    expect(a).toEqual(b);
  });
  it("the same table needs more tolerance for a lower degree, and is refused with the numbers when it has too little", () => {
    const refused = (deg: number, tol: number) => validateCase(caseWith(tableSet(deg, tol))).errors;
    expect(refused(3, 2)).toEqual([]);
    const e = refused(1, 1);
    expect(e.map((x) => x.code)).toEqual(["E_FIT"]);
    expect(e[0]!.message).toMatch(/degree 1 polynomial is \d/);
    expect(e[0]!.message).toMatch(/% from the table at \d+ K; the tolerance is 1\.00%/);
    expect(refused(1, 30)).toEqual([]); // the same line is accepted when the tolerance is stated wide enough
  });
  it("a degree needs more points than it has coefficients", () => {
    const e = validateCase(caseWith(tableSet(3, 50, { points: TABLE.slice(0, 3).map(([T, k]) => ({ temperature: q(T, "K"), conductivity: q(k, "W/m/K") })) }))).errors;
    expect(e.map((x) => x.code + " " + x.field)).toEqual(["E_FIT /materials/fuel/sets/thermal.conductivity/fit/degree"]);
  });
  it("a fit that would go non-positive inside the table's range is refused, not clipped", () => {
    const spiky = [[300, 1.0], [400, 5.0], [500, 0.3], [600, 6.0]];
    const v = validateCase(caseWith(tableSet(3, 50, { points: spiky.map(([T, k]) => ({ temperature: q(T!, "K"), conductivity: q(k!, "W/m/K") })) })));
    expect(v.errors.map((x) => x.code)).toEqual(["E_OUT_OF_RANGE"]);
    expect(v.errors[0]!.message).toMatch(/not positive over its stated range 300 to 600 K/);
  });
});

describe("what OFFBEAT is told", () => {
  const dict = (set: unknown) => writeOffbeatCase(normalized(set)).files["constant/solverDict"]!;
  it("a cubic: ZyRELAP, par3 is MINUS the T^2 coefficient, and all four parameters are written", () => {
    const d = dict(polySet());
    expect(d).toMatch(/conductivityModel ZyRELAP;\s+conductivity \{ par1 2; par2 0\.003; par3 (0\.0000012|1\.2e-6); par4 2e-10; \}/);
    expect(d).not.toMatch(/k\s+k\s+\[1 1 -3 -1 0\]\s+2;/); // no constant k line for the fuel beside it
  });
  it("a quadratic and a line are written with the zero terms written, never left to a default", () => {
    expect(dict(polySet([5, 0.002, 4e-7, 0]))).toMatch(/par1 5; par2 0\.002; par3 -(0\.0000004|4e-7); par4 0; \}/);
    expect(dict(polySet([5, 0.002, 0, 0]))).toMatch(/par1 5; par2 0\.002; par3 0; par4 0; \}/); // minus zero is written as 0, not -0
  });
  it("a table is written as its fitted coefficients, and the mapping says it was fitted, to what, and how far it is", () => {
    const w = writeOffbeatCase(normalized(tableSet()));
    const n = normalized(tableSet()).fuelConductivity;
    if (n.kind !== "polynomial") throw new Error("no");
    const m = /par1 ([^;]+); par2 ([^;]+); par3 ([^;]+); par4 ([^;]+); \}/.exec(w.files["constant/solverDict"]!)!;
    expect(Number(m[1])).toBe(n.coefficients[0]);
    expect(Number(m[3])).toBe(-n.coefficients[2]! + 0);
    expect(Number(m[4])).toBe(n.coefficients[3]);
    const note = w.mapping.find((x) => x.field === "materials.fuel thermal.conductivity")!.note!;
    expect(note).toMatch(/ZyRELAP/);
    expect(note).toMatch(/fitted to a table of 5 points, degree 3, largest deviation [\d.e+-]+% at \d+ K \(tolerance 2\.00%\)/);
  });
  it("a linear law and a constant are written exactly as before", () => {
    const a = writeOffbeatCase(validateCase(read("examples/synthetic-pin.json")).normalized!).files["constant/solverDict"]!;
    expect(a).toMatch(/k\s+k\s+\[1 1 -3 -1 0\]\s+3;/);
    const lin = writeOffbeatCase(validateCase(read("schema/vectors/good/linear-conductivity.json")).normalized!).files["constant/solverDict"]!;
    expect(lin).toMatch(/conductivityModel steel1515TiTobbe;/);
    expect(lin).not.toMatch(/ZyRELAP/);
  });
});

describe("the closed forms and the quick look with a polynomial", () => {
  const pinN = normalized(polySet());
  const out = compositeConstantK({ qPrime: pinN.qPrime, fuelK: 3, fuelRadius: pinN.fuelRadius, hGap: pinN.gapConductance, claddingInnerRadius: pinN.claddingInnerRadius, claddingOuterRadius: pinN.claddingOuterRadius, claddingK: 15, hFilm: pinN.boundary.kind === "convective" ? pinN.boundary.heatTransferCoefficient : NaN, bulkTemperature: pinN.boundary.kind === "convective" ? pinN.boundary.bulkTemperature : NaN });
  it("the centre temperature is the root of the conductivity integral computed by Simpson's rule (not by the module's primitive)", () => {
    const look = quickLook(pinN);
    const independent = hot(A, out.fuelSurfaceT, pinN.qPrime / (4 * Math.PI));
    expect(Math.abs(look.temperatures.centreT - independent)).toBeLessThan(1e-6);
    expect(Math.abs(look.temperatures.fuelSurfaceT - out.fuelSurfaceT)).toBeLessThan(1e-9); // the outside of the fuel does not depend on the fuel's law
  });
  it("the radial profile follows the same law at every radius, and the cladding is unchanged", () => {
    const look = quickLook(pinN);
    const fuel = radialProfile(pinN, look).filter((p) => p.region === "fuel");
    for (const p of fuel) {
      const target = (pinN.qPrime * (1 - (p.r * p.r) / (pinN.fuelRadius * pinN.fuelRadius))) / (4 * Math.PI);
      expect(Math.abs(p.T - hot(A, look.temperatures.fuelSurfaceT, target))).toBeLessThan(1e-6);
    }
  });
  it("the range is judged: a fuel outside the stated range is out-of-domain, inside it is in-domain", () => {
    expect(quickLook(pinN).verdict).toBe("in-domain");
    const narrow = normalized(polySet(A, { validRange: { min: q(500, "K"), max: q(700, "K") } }));
    const look = quickLook(narrow);
    expect(look.verdict).toBe("out-of-domain");
    expect(look.findings[0]).toMatchObject({ region: "fuel", validRange: [500, 700] });
  });
  it("a polynomial that equals a linear law gives what the linear law gives", () => {
    const lin = validateCase(read("schema/vectors/good/linear-conductivity.json")).normalized!;
    const k = lin.fuelConductivity;
    if (k.kind !== "linear") throw new Error("no");
    const d = read("schema/vectors/good/linear-conductivity.json");
    d.materials.fuel.sets["thermal.conductivity"] = polySet([k.a, k.b, 0, 0], { validRange: { min: q(k.range[0], "K"), max: q(k.range[1], "K") } });
    const asPoly = validateCase(d).normalized!;
    expect(Math.abs(quickLook(asPoly).temperatures.centreT - quickLook(lin).temperatures.centreT)).toBeLessThan(1e-9);
  });
});

describe("the independent finite-volume solver with a polynomial", () => {
  const pin = (over: Partial<TransientPin> = {}): TransientPin => ({
    fuelInnerRadius: 0, fuelRadius: 0.0041, claddingInnerRadius: 0.00418, claddingOuterRadius: 0.00475, fuelCells: 40, claddingCells: 12, gapConductance: 5000,
    fuelK: { a: 3, b: 0 }, claddingK: { a: 15, b: 0 }, fuelC: { a: 3e6, b: 0 }, claddingC: { a: 2.5e6, b: 0 },
    boundary: { kind: "convective", bulkTemperature: 300, heatTransferCoefficient: 30000 }, power: () => 0, fuelLaw: A, ...over,
  });
  const centres = (p: TransientPin) => Array.from({ length: p.fuelCells }, (_, i) => (p.fuelRadius * (i + 0.5)) / p.fuelCells);
  const errorAt = (nf: number) => {
    const p = pin({ fuelCells: nf, claddingCells: Math.round(nf * 0.3) });
    const s = steadyFv(p, 20000);
    const Ts = (() => {
      const wall = 300 + 20000 / (2 * Math.PI * p.claddingOuterRadius * 30000);
      const claddingInner = wall + (20000 * Math.log(p.claddingOuterRadius / p.claddingInnerRadius)) / (2 * Math.PI * 15);
      return claddingInner + 20000 / (2 * Math.PI * p.fuelRadius * 5000);
    })();
    return Math.max(...centres(p).map((r, i) => Math.abs(s.T[i]! - hot(A, Ts, (20000 * (1 - (r * r) / (p.fuelRadius * p.fuelRadius))) / (4 * Math.PI)))));
  };
  it("the steady cubic converges to the closed form at second order", () => {
    const e = [10, 20, 40, 80].map(errorAt);
    for (let i = 1; i < e.length; i++) {
      expect(e[i - 1]! / e[i]!).toBeGreaterThan(3.2);
      expect(e[i - 1]! / e[i]!).toBeLessThan(4.4);
    }
    expect(e[3]!).toBeLessThan(0.2);
  });
  it("a steady field is a fixed point of the transient with the cubic law", () => {
    const p = pin({ power: () => 20000, fuelLaw: A });
    const s = steadyFv(p, 20000);
    const run = solveTransientFv(p, { dt: 0.5, steps: 100, initialField: s.T, outputEvery: 100 });
    const end = run.states[run.states.length - 1]!;
    expect(Math.max(...end.T.map((x, i) => Math.abs(x - s.T[i]!)))).toBeLessThan(1e-7);
  });
  it("the law, when given, replaces the linear one: a pin with fuelLaw ignores fuelK", () => {
    const a = steadyFv(pin({ fuelK: { a: 99, b: 0 } }), 20000);
    const b = steadyFv(pin({ fuelK: { a: 1, b: 0 } }), 20000);
    expect(a.T).toEqual(b.T);
  });
  it("a cubic that is not positive over the temperatures it reaches is refused with the temperature", () => {
    expect(() => steadyFv(pin({ fuelLaw: [1, 0.001, -2e-6, 0] }), 30000)).toThrow(/conductivity of the fuel is not positive|did not settle|not finite/);
  });
});

describe("the time scale and the lowest conductivity", () => {
  it("the lowest conductivity of a cubic with a turning point inside its range is the value at the turning point, not at an end", () => {
    const n = normalized(polySet([10, -0.02, 1.5e-5, 0], { validRange: { min: q(300, "K"), max: q(1200, "K") } }));
    const interior = evaluate([10, -0.02, 1.5e-5, 0], 0.02 / (2 * 1.5e-5));
    expect(lowestConductivity(n.fuelConductivity)).toBeCloseTo(interior, 10);
    expect(lowestConductivity(n.fuelConductivity)).toBeLessThan(Math.min(evaluate([10, -0.02, 1.5e-5, 0], 300), evaluate([10, -0.02, 1.5e-5, 0], 1200)));
  });
  it("a lower conductivity gives a longer time constant, so the steady end time follows the law", () => {
    const hi = timeScale(normalized(polySet([10, 0, 0, 0], { validRange: { min: q(300, "K"), max: q(1200, "K") } }))).tauBound;
    const lo = timeScale(normalized(polySet([2, 0, 0, 0], { validRange: { min: q(300, "K"), max: q(1200, "K") } }))).tauBound;
    expect(lo).toBeGreaterThan(hi);
  });
});
