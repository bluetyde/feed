// The reciprocal conductivity k = a / T + b (a in W/m, b in W/m/K, T in K) through the validator, the case writer, the closed forms, the independent finite-volume
// solver and the time scale (docs/conductivity-models.md). The expected values come from an independent route: the analytic integral a ln(T/Ts) + b (T - Ts)
// solved by a bisection written here, and the structure of what OFFBEAT is told.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { evaluate, lawOf, minimum, primitive, solveHot } from "../src/core/conductivity";
import { quickLook, radialProfile } from "../src/core/quickLook";
import { lowestConductivity, timeScale } from "../src/core/steadyState";
import { solveTransientFv, steadyFv, TransientPin } from "../src/core/transientFv";
import { validateCase, validateMaterial } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const recip = (a: number, b: number, lo = 300, hi = 2000, extra: Record<string, unknown> = {}) => ({
  model: "reciprocal", a: q(a, "W/m"), b: q(b, "W/m/K"), validRange: { min: q(lo, "K"), max: q(hi, "K") }, source: "synthetic: chosen for the closed-form oracle", ...extra,
});
const caseWith = (set: unknown, region: "fuel" | "cladding" = "fuel", file = "examples/synthetic-pin.json") => {
  const d = read(file);
  d.materials[region].sets["thermal.conductivity"] = set;
  return d;
};
const normalized = (set: unknown, region: "fuel" | "cladding" = "fuel") => {
  const v = validateCase(caseWith(set, region));
  expect(v.errors).toEqual([]);
  return v.normalized!;
};

/** The temperature above Ts at which the integral of a / T + b from Ts is `target`: the analytic primitive a ln T + b T, bisected. */
const hotRecip = (a: number, b: number, Ts: number, target: number) => {
  let lo = Ts;
  let hi = Ts * 1e4;
  for (let i = 0; i < 300; i++) {
    const mid = 0.5 * (lo + hi);
    if (a * Math.log(mid / Ts) + b * (mid - Ts) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
};

const A = 17885; // the SiC value of OFFBEAT's model, W/m
const B = 2;

describe("the law itself (src/core/conductivity.ts)", () => {
  const law = { kind: "reciprocal", a: A, b: B } as const;
  it("evaluates a / T + b, and its primitive is a ln T + b T", () => {
    expect(evaluate(law, 500)).toBeCloseTo(A / 500 + B, 12);
    expect(primitive(law, 800) - primitive(law, 400)).toBeCloseTo(A * Math.log(2) + B * 400, 9);
  });
  it("its lowest value over a range is at an end: the hot end for a positive a, the cold end for a negative one", () => {
    expect(minimum(law, 300, 1500)).toBeCloseTo(A / 1500 + B, 12);
    expect(minimum({ kind: "reciprocal", a: -50, b: 10 }, 300, 1500)).toBeCloseTo(-50 / 300 + 10, 12);
  });
  it("solveHot gives the temperature whose conductivity integral is the given one, with and without b", () => {
    for (const [a, b, Ts, I] of [[A, B, 600, 5000], [A, 0, 600, 5000], [A, B, 900, 20000], [-3000, 8, 400, 1500]] as const) {
      const T = solveHot({ kind: "reciprocal", a, b }, Ts, I);
      expect(Math.abs(T / hotRecip(a, b, Ts, I) - 1), `${a} ${b} ${Ts}`).toBeLessThan(1e-12);
    }
    // with b = 0 the answer is Ts exp(I / a)
    expect(solveHot({ kind: "reciprocal", a: A, b: 0 }, 600, 5000)).toBeCloseTo(600 * Math.exp(5000 / A), 8);
  });
  it("refuses a conductivity that reaches zero before the integral does (negative b), and one that is not positive at the cold side", () => {
    expect(() => solveHot({ kind: "reciprocal", a: 1000, b: -2 }, 400, 1e9)).toThrow(RangeError);
    expect(() => solveHot({ kind: "reciprocal", a: 100, b: -2 }, 400, 1)).toThrow(RangeError);
  });
});

describe("a reciprocal conductivity in a case", () => {
  it("is normalized to a, b in SI and its range", () => {
    const n = normalized(recip(A, B));
    expect(n.fuelConductivity).toEqual({ kind: "reciprocal", a: A, b: B, range: [300, 2000] });
    expect(lawOf(n.fuelConductivity)).toEqual({ kind: "reciprocal", a: A, b: B });
  });
  it("converts units (a in kW/m, a Celsius range, b in W/m/K)", () => {
    const n = normalized({ ...recip(A, B), a: q(17.885, "kW/m"), validRange: { min: q(26.85, "degC"), max: q(1726.85, "degC") } });
    expect(n.fuelConductivity).toMatchObject({ kind: "reciprocal", range: [300, 2000] });
    expect((n.fuelConductivity as { a: number }).a).toBeCloseTo(A, 8);
  });
  it("a cladding reciprocal works the same way", () => {
    const n = normalized(recip(9000, 5, 300, 900), "cladding");
    expect(n.claddingConductivity).toMatchObject({ kind: "reciprocal", a: 9000, b: 5 });
  });
  it("refuses what is malformed, each with its code and field", () => {
    const codes = (set: unknown) => validateCase(caseWith(set)).errors.map((e) => e.code + " " + e.field);
    const base = "/materials/fuel/sets/thermal.conductivity";
    const { source: _s, ...noSource } = recip(A, B);
    expect(codes(noSource)).toEqual(["E_PROP_MISSING " + base + "/source"]);
    const { a: _a, ...noA } = recip(A, B);
    expect(codes(noA)).toEqual(["E_PROP_MISSING " + base + "/a"]);
    const { b: _b, ...noB } = recip(A, B);
    expect(codes(noB)).toEqual(["E_PROP_MISSING " + base + "/b"]);
    const { validRange: _v, ...noRange } = recip(A, B);
    expect(codes(noRange)).toEqual(["E_PROP_MISSING " + base + "/validRange"]);
    expect(codes(recip(A, B, 0, 2000))).toEqual(["E_OUT_OF_RANGE " + base + "/validRange/min"]);
    expect(codes(recip(A, B, 900, 400))).toEqual(["E_OUT_OF_RANGE " + base + "/validRange"]);
    expect(codes({ ...recip(A, B), a: q(A, "W/m/K") })).toEqual(["E_UNITS " + base + "/a"]);
    expect(codes({ ...recip(A, B), b: q(B, "W/m") })).toEqual(["E_UNITS " + base + "/b"]);
    expect(codes({ ...recip(A, B), a: A })).toEqual(["E_UNITS " + base + "/a"]);
  });
  it("is refused when it is not positive somewhere in its range, judged at the ends, and not when it only gets small", () => {
    const mat = (set: unknown) => validateMaterial("fuel", { materialId: "synthetic-sic", revision: 1, sets: { "thermal.conductivity": set } });
    // a/T + b with b negative reaches zero at T = a / -b = 1000 K
    expect(mat(recip(1000, -1, 300, 900)).ok).toBe(true); // 1000/900 - 1 = 0.11
    const r = mat(recip(1000, -1, 300, 1100));
    expect(r.errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
    expect(r.errors[0]!.message).toMatch(/not positive over its stated range/);
    // negative a with positive b: lowest at the cold end
    expect(mat(recip(-300, 5, 300, 900)).ok).toBe(true); // -1 + 5
    expect(mat(recip(-300, 0.5, 300, 900)).ok).toBe(false); // -1 + 0.5 < 0
  });
  it("a law that is positive over its range but reaches zero where the pin runs is refused with the reason, not thrown (the same for a linear law, which did throw)", () => {
    // the synthetic pin's fuel runs from about 780 to 1310 K; this law is 0.11 W/m/K at 900 K and zero at 1000 K
    for (const set of [recip(1000, -1, 300, 900), { model: "linear", a: q(3, "W/m/K"), b: q(-0.003, "W/m/K2"), validRange: { min: q(300, "K"), max: q(900, "K") }, source: "x" }]) {
      let r: ReturnType<typeof validateCase> | undefined;
      expect(() => (r = validateCase(caseWith(set)))).not.toThrow();
      expect(r!.ok).toBe(false);
      expect(r!.errors.map((e) => e.code + " " + e.field)).toEqual(["E_OUT_OF_RANGE /materials"]);
      expect(r!.errors[0]!.message).toMatch(/cannot be found/);
      expect(r!.normalized).toBeUndefined();
    }
  });
  it("a material of the library with the model validates the same way", () => {
    const m = { materialId: "synthetic-sic", revision: 1, sets: { "thermal.conductivity": recip(A, B) } };
    expect(validateMaterial("fuel", m).ok).toBe(true);
    expect(validateMaterial("fuel", { ...m, sets: { "thermal.conductivity": { ...recip(A, B), source: "" } } }).ok).toBe(false);
  });
});

describe("what OFFBEAT is told", () => {
  it("SiCPARFUME with par1 = a and par2 = b, both written, and the mapping says what the model is", () => {
    const w = writeOffbeatCase(normalized(recip(A, B)));
    const text = w.files["constant/solverDict"]!;
    expect(text).toMatch(/conductivityModel SiCPARFUME;\n\s+conductivity \{ par1 17885; par2 2; \}/);
    const note = w.mapping.find((m) => m.field === "materials.fuel thermal.conductivity")!.note!;
    expect(note).toMatch(/SiCPARFUME \(k = par1 \/ T \+ par2/);
    expect(note).toMatch(/both written/);
  });
  it("a zero b is written as a zero, never left to the model's default of 2", () => {
    const text = writeOffbeatCase(normalized(recip(A, 0))).files["constant/solverDict"]!;
    expect(text).toMatch(/par1 17885; par2 0;/);
  });
});

describe("the closed forms and the quick look with a reciprocal fuel", () => {
  const fuel = (a: number, b: number) => normalized(recip(a, b));
  it("the centre temperature is the root of the analytic integral (the constant-k pin around it is closed form too)", () => {
    for (const [a, b] of [[A, B], [A, 0], [6000, 3]] as const) {
      const n = fuel(a, b);
      const look = quickLook(n);
      const Tco = 573 + 20000 / (2 * Math.PI * 4.75e-3 * 30000);
      const Tci = Tco + (20000 * Math.log(4.75 / 4.18)) / (2 * Math.PI * 15);
      const Ts = Tci + 20000 / (2 * Math.PI * 4.1e-3 * 5000);
      expect(Math.abs(look.temperatures.fuelSurfaceT / Ts - 1)).toBeLessThan(1e-12);
      expect(Math.abs(look.temperatures.centreT / hotRecip(a, b, Ts, 20000 / (4 * Math.PI)) - 1), `${a} ${b}`).toBeLessThan(1e-12);
    }
  });
  it("the radial profile follows the law at every radius", () => {
    const n = fuel(A, B);
    const look = quickLook(n);
    const prof = radialProfile(n, look, 40).filter((p) => p.region === "fuel");
    for (const p of prof) {
      const T = hotRecip(A, B, look.temperatures.fuelSurfaceT, (20000 * (1 - (p.r * p.r) / (4.1e-3 * 4.1e-3))) / (4 * Math.PI));
      expect(Math.abs(p.T / T - 1)).toBeLessThan(1e-12);
    }
  });
  it("the range is judged: a fuel outside the stated range is out-of-domain, inside it is in-domain", () => {
    expect(quickLook(normalized(recip(A, B, 300, 1800))).verdict).toBe("in-domain");
    const narrow = quickLook(normalized(recip(A, B, 300, 700)));
    expect(narrow.verdict).toBe("out-of-domain");
    expect(narrow.findings.map((f) => f.region)).toEqual(["fuel"]);
  });
});

describe("the independent finite-volume solver with a reciprocal law", () => {
  const pin = (over: Partial<TransientPin> = {}): TransientPin => ({
    fuelInnerRadius: 0, fuelRadius: 0.0041, claddingInnerRadius: 0.00418, claddingOuterRadius: 0.00475, fuelCells: 40, claddingCells: 12, gapConductance: 5000,
    fuelK: { a: 3, b: 0 }, claddingK: { a: 15, b: 0 }, fuelC: { a: 3e6, b: 0 }, claddingC: { a: 2.5e6, b: 0 },
    boundary: { kind: "convective", bulkTemperature: 573, heatTransferCoefficient: 30000 }, power: () => 0, fuelLaw: { kind: "reciprocal", a: 6000, b: 3 }, ...over,
  });
  const errorAt = (nf: number) => {
    const p = pin({ fuelCells: nf, claddingCells: Math.round(nf * 0.3) });
    const s = steadyFv(p, 20000);
    const Ts = 573 + 20000 / (2 * Math.PI * p.claddingOuterRadius * 30000) + (20000 * Math.log(p.claddingOuterRadius / p.claddingInnerRadius)) / (2 * Math.PI * 15) + 20000 / (2 * Math.PI * p.fuelRadius * 5000);
    return Math.max(...Array.from({ length: nf }, (_, i) => {
      const r = (p.fuelRadius * (i + 0.5)) / nf;
      return Math.abs(s.T[i]! - hotRecip(6000, 3, Ts, (20000 * (1 - (r * r) / (p.fuelRadius * p.fuelRadius))) / (4 * Math.PI)));
    }));
  };
  it("the steady solution converges to the closed form at second order", () => {
    const e = [10, 20, 40, 80].map(errorAt);
    for (let i = 1; i < e.length; i++) {
      expect(e[i - 1]! / e[i]!).toBeGreaterThan(3.2);
      expect(e[i - 1]! / e[i]!).toBeLessThan(4.4);
    }
  });
  it("a steady field is a fixed point of the transient with the same law", () => {
    const p = pin({ power: () => 20000 });
    const s = steadyFv(p, 20000);
    const run = solveTransientFv(p, { dt: 0.5, steps: 100, initialField: s.T, outputEvery: 100 });
    const end = run.states[run.states.length - 1]!;
    expect(Math.max(...end.T.map((x, i) => Math.abs(x - s.T[i]!)))).toBeLessThan(1e-7);
  });
});

describe("the time scale and the lowest conductivity", () => {
  it("the lowest conductivity of a reciprocal law over its range is the hot end for a positive a", () => {
    const n = normalized(recip(A, B, 300, 1500));
    expect(lowestConductivity(n.fuelConductivity)).toBeCloseTo(A / 1500 + B, 10);
  });
  it("a steady case with a reciprocal fuel is accepted (the end time follows its lowest conductivity), and a lower conductivity gives a longer time constant", () => {
    const hi = timeScale(normalized(recip(A, B, 300, 1500))).tauBound;
    const lo = timeScale(normalized(recip(A / 10, B / 10, 300, 1500))).tauBound;
    expect(lo).toBeGreaterThan(hi);
  });
});
