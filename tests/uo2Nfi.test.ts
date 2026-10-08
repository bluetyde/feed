// The burnup-dependent UO2 conductivity (src/core/uo2Nfi.ts, docs/plans/10-burnup.md M2) through the law itself, the validator, the case writer, the closed forms, the
// independent finite-volume solver and the time scale. The expected values come from an independent route written here: the equation re-typed from NUREG/CR-7024
// Eq. 2.3-10 and 2.3-11, Simpson's rule for its integral, bisections and scans; and OFFBEAT's own conductivity field from M0 (docs/spike/burnup-probe.md).
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { degree, evaluate, lawOf, minimum, primitive, solveHot } from "../src/core/conductivity";
import { quickLook, radialProfile } from "../src/core/quickLook";
import { lowestConductivity, timeScale } from "../src/core/steadyState";
import { pinOf } from "../src/core/transientResults";
import { solveTransientFv, steadyFv, TransientPin } from "../src/core/transientFv";
import { gaussLegendre, NFI_PARAMETERS, nfiConductivity, nfiIntegral, nfiMinimum } from "../src/core/uo2Nfi";
import { validateCase, validateMaterial } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const rel = (a: number, b: number) => Math.abs(a / b - 1);

/** Eq. 2.3-10 and 2.3-11 of NUREG/CR-7024, typed again here. T in K, B in GWd/tU, f the density fraction, gad the gadolinia weight fraction. */
const kHand = (T: number, B: number, f: number, gad = 0): number => {
  const h = 1 / (1 + 396 * Math.exp(-6380 / T));
  const phonon = 1 / (0.0452 + 1.1599 * gad + 0.000246 * T + 0.00187 * B + (1 - 0.9 * Math.exp(-0.04 * B)) * 0.038 * Math.pow(B, 0.28) * h);
  const electronic = (3.5e9 / (T * T)) * Math.exp(-16361 / T);
  return (1.0789 * (phonon + electronic) * f) / (1 + 0.5 * (1 - f));
};
const simpson = (g: (x: number) => number, a: number, b: number, n = 100000) => {
  const h = (b - a) / n;
  let s = g(a) + g(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * g(a + i * h);
  return (s * h) / 3;
};
/** The temperature above Ts at which the integral of k(T) from Ts is `target`, by bisection on Simpson's rule. */
const hotHand = (B: number, f: number, Ts: number, target: number, gad = 0) => {
  let lo = Ts;
  let hi = Ts + 3000;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (simpson((T) => kHand(T, B, f, gad), Ts, mid, 2000) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
};

const nfiSet = (extra: Record<string, unknown> = {}) => ({ model: "uo2-nfi", densityFraction: q(0.95, "1"), source: "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11 (modified NFI, FRAPCON-3.4)", ...extra });
const burnup = (v: number, unit = "MWd/kgHM", extra: Record<string, unknown> = {}) => ({ value: q(v, unit), basis: "heavy-metal", source: "chosen for the study", ...extra });
const caseWith = (set: unknown = nfiSet(), b: unknown = burnup(40) as unknown, file = "examples/synthetic-pin.json") => {
  const d = read(file);
  d.materials.fuel.sets["thermal.conductivity"] = set;
  if (b !== null) d.burnup = b; // null: no burnup section (undefined would take the default)
  if (d.power && d.power.linearHeatRate) d.power.linearHeatRate = q(20, "kW/m");
  return d;
};
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);
const normalized = (set?: unknown, b?: unknown) => {
  const v = validateCase(caseWith(set, b));
  expect(v.errors).toEqual([]);
  return v.normalized!;
};

describe("the law (src/core/uo2Nfi.ts)", () => {
  it("is the equation of the report, over its whole range of temperature, burnup, density and gadolinia", () => {
    for (const T of [300, 500, 800, 1000, 1200, 1700, 2200, 3000]) {
      for (const B of [0, 1, 20, 40, 62]) {
        for (const f of [0.92, 0.95, 0.97]) {
          for (const gad of [0, 0.05, 0.1]) expect(rel(nfiConductivity(T, { burnup: B, densityFraction: f, gadolinia: gad }), kHand(T, B, f, gad)), `${T} ${B} ${f} ${gad}`).toBeLessThan(1e-13);
        }
      }
    }
  });
  it("its 13 constants are the report's (par13 = 16361, not OFFBEAT's default 16360)", () => {
    expect(NFI_PARAMETERS).toEqual([0.0452, 0.000246, 0.00187, 1.1599, 0.9, 0.04, 0.038, 0.28, 396, 6380, 3.5e9, 2, 16361]);
  });
  it("agrees with OFFBEAT's own conductivity field (M0): k at the centre cell of the 20 kW/m pin, 100 cells, at 0 and 40 MWd/kgHM, 95 % density (OFFBEAT ran par13 = 16360, a difference far below the printed digits)", () => {
    expect(rel(nfiConductivity(1238.4, { burnup: 0, densityFraction: 0.95, gadolinia: 0 }), 2.8625)).toBeLessThan(2e-4); // the first cell of the fresh pin printed 2.862521 (at its own T)
    expect(rel(nfiConductivity(1469.58, { burnup: 40, densityFraction: 0.95, gadolinia: 0 }), 2.0409)).toBeLessThan(2e-4);
  });
  it("degrades with burnup, and is lower for a lower density and for gadolinia", () => {
    const k = (B: number, f = 0.95, gad = 0) => nfiConductivity(1000, { burnup: B, densityFraction: f, gadolinia: gad });
    expect(k(20)).toBeLessThan(k(0));
    expect(k(62)).toBeLessThan(k(20));
    expect(k(40, 0.92)).toBeLessThan(k(40, 0.97));
    expect(k(40, 0.95, 0.1)).toBeLessThan(k(40));
  });
  it("the quadrature nodes integrate polynomials exactly (degree 22 with 12 points) and the weights sum to 2", () => {
    const { x, w } = gaussLegendre;
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 13);
    for (const n of [0, 2, 10, 22]) expect(x.reduce((s, xi, i) => s + w[i]! * Math.pow(xi, n), 0)).toBeCloseTo(2 / (n + 1), 12);
    for (const n of [1, 3, 21]) expect(Math.abs(x.reduce((s, xi, i) => s + w[i]! * Math.pow(xi, n), 0))).toBeLessThan(1e-13);
  });
  it("the integral of k equals Simpson's rule on a hundred thousand intervals, either way round, and adds up", () => {
    const s = { burnup: 40, densityFraction: 0.95, gadolinia: 0 };
    for (const [lo, hi] of [[300, 3000], [777, 1469.6], [1000, 1050], [1500, 2600]] as const) {
      const ref = simpson((T) => kHand(T, 40, 0.95), lo, hi);
      expect(rel(nfiIntegral(lo, hi, s), ref), `${lo}-${hi}`).toBeLessThan(1e-11);
      expect(nfiIntegral(hi, lo, s)).toBeCloseTo(-nfiIntegral(lo, hi, s), 9);
    }
    expect(nfiIntegral(500, 2000, s)).toBeCloseTo(nfiIntegral(500, 1200, s) + nfiIntegral(1200, 2000, s), 8);
    expect(nfiIntegral(900, 900, s)).toBe(0);
  });
  it("the primitive handed to the closed forms differs only by a constant: its differences are the integrals", () => {
    const law = lawOf(normalized().fuelConductivity);
    expect(primitive(law, 1500) - primitive(law, 800)).toBeCloseTo(nfiIntegral(800, 1500, { burnup: 40, densityFraction: 0.95, gadolinia: 0 }), 9);
    expect(degree(law)).toBe(2);
  });
  it("the lowest value over a range is found: the law is not monotone (the electronic term rises), so the minimum is inside a wide range", () => {
    const s = { burnup: 0, densityFraction: 0.95, gadolinia: 0 };
    let scan = Infinity;
    let at = 0;
    for (let T = 300; T <= 3000; T += 0.05) {
      const k = kHand(T, 0, 0.95);
      if (k < scan) {
        scan = k;
        at = T;
      }
    }
    expect(at).toBeGreaterThan(1500);
    expect(at).toBeLessThan(3000);
    expect(rel(nfiMinimum(300, 3000, s), scan)).toBeLessThan(1e-9);
    expect(nfiMinimum(300, 3000, s)).toBeLessThan(Math.min(nfiConductivity(300, s), nfiConductivity(3000, s)));
    expect(minimum(lawOf(normalized().fuelConductivity), 300, 1500)).toBeCloseTo(nfiConductivity(1500, { burnup: 40, densityFraction: 0.95, gadolinia: 0 }), 9); // on a range that stops before the rise, the hot end
  });
  it("solveHot returns the temperature whose conductivity integral is the given one (checked by Simpson's rule), for fresh and burnt fuel", () => {
    for (const [B, f, Ts, I] of [[0, 0.95, 780, 1500], [40, 0.95, 777.7, 1591.5], [62, 0.92, 800, 3000], [20, 0.97, 600, 400]] as const) {
      const law = { kind: "uo2-nfi", burnup: B, densityFraction: f, gadolinia: 0 } as const;
      const T = solveHot(law, Ts, I);
      expect(Math.abs(simpson((x) => kHand(x, B, f), Ts, T, 20000) / I - 1), `${B} ${f}`).toBeLessThan(1e-9);
      expect(rel(T, hotHand(B, f, Ts, I))).toBeLessThan(1e-9);
    }
  });
});

describe("a case with the burnup-dependent fuel", () => {
  it("is normalized to the law and the burnup, with the density as written", () => {
    const n = normalized();
    expect(n.fuelConductivity).toEqual({ kind: "uo2-nfi", burnup: 40, densityFraction: 0.95, gadolinia: 0, range: [300, 3000] });
    expect(n.burnup).toEqual({ value: 40, source: "chosen for the study" });
  });
  it("takes a percentage for the density, a gadolinia content, a narrower range and the three units of burnup", () => {
    const n = normalized(nfiSet({ densityFraction: q(95, "%"), gadolinia: q(5, "%"), validRange: { min: q(500, "K"), max: q(2500, "K") } }));
    expect(n.fuelConductivity).toMatchObject({ densityFraction: 0.95, gadolinia: 0.05, range: [500, 2500] });
    for (const [v, unit] of [[40, "MWd/kgHM"], [40, "GWd/tHM"], [40000, "MWd/tHM"]] as const) expect(normalized(nfiSet(), burnup(v, unit)).burnup!.value, unit).toBeCloseTo(40, 12);
  });
  it("fresh fuel is stated as a burnup of 0, and the centre of the pin is hotter with burnup", () => {
    const fresh = quickLook(normalized(nfiSet(), burnup(0))).temperatures.centreT;
    const mid = quickLook(normalized(nfiSet(), burnup(40))).temperatures.centreT;
    const high = quickLook(normalized(nfiSet(), burnup(60))).temperatures.centreT;
    expect(mid).toBeGreaterThan(fresh);
    expect(high).toBeGreaterThan(mid);
  });
  it("refuses what is malformed, each with its code and field", () => {
    expect(codes(caseWith(nfiSet(), null))).toEqual(["E_PROP_MISSING /burnup"]);
    expect(codes(caseWith({ model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K"), source: "x" }, burnup(40)))).toEqual(["E_UNSUPPORTED /burnup"]);
    expect(codes(caseWith(nfiSet(), burnup(63)))).toEqual(["E_OUT_OF_RANGE /burnup/value"]);
    expect(codes(caseWith(nfiSet(), burnup(-1)))).toEqual(["E_OUT_OF_RANGE /burnup/value"]);
    expect(codes(caseWith(nfiSet(), { ...burnup(40), basis: "oxide" }))).toEqual(["E_UNSUPPORTED /burnup/basis"]);
    const { basis: _b, ...noBasis } = burnup(40);
    expect(codes(caseWith(nfiSet(), noBasis))).toEqual(["E_PROP_MISSING /burnup/basis"]);
    expect(codes(caseWith(nfiSet(), burnup(40, "MWd/kgHM", { source: "  " })))).toEqual(["E_PROP_MISSING /burnup/source"]);
    expect(codes(caseWith(nfiSet(), { ...burnup(40), value: q(40, "MWd/kgUO2") }))).toEqual(["E_UNITS /burnup/value"]);
    expect(codes(caseWith(nfiSet(), { ...burnup(40), value: 40 }))).toEqual(["E_UNITS /burnup/value"]);
    expect(codes(caseWith(nfiSet(), { ...burnup(40), extra: 1 }))).toEqual(["E_SCHEMA_INVALID /burnup/extra"]);
    expect(codes(caseWith(nfiSet(), "40"))).toEqual(["E_SCHEMA_INVALID /burnup"]);
    const { value: _v, ...noValue } = burnup(40);
    expect(codes(caseWith(nfiSet(), noValue))).toEqual(["E_PROP_MISSING /burnup/value"]);
  });
  it("refuses a material that is out of the report's range or malformed", () => {
    const base = "/materials/fuel/sets/thermal.conductivity";
    expect(codes(caseWith(nfiSet({ densityFraction: q(0.99, "1") })))).toEqual(["E_OUT_OF_RANGE " + base + "/densityFraction"]);
    expect(codes(caseWith(nfiSet({ densityFraction: q(0.9, "1") })))).toEqual(["E_OUT_OF_RANGE " + base + "/densityFraction"]);
    expect(codes(caseWith(nfiSet({ gadolinia: q(0.11, "1") })))).toEqual(["E_OUT_OF_RANGE " + base + "/gadolinia"]);
    expect(codes(caseWith(nfiSet({ validRange: { min: q(200, "K"), max: q(2000, "K") } })))).toEqual(["E_OUT_OF_RANGE " + base + "/validRange"]);
    expect(codes(caseWith(nfiSet({ validRange: { min: q(500, "K"), max: q(3500, "K") } })))).toEqual(["E_OUT_OF_RANGE " + base + "/validRange"]);
    expect(codes(caseWith(nfiSet({ validRange: { min: q(1500, "K"), max: q(1000, "K") } })))).toEqual(["E_OUT_OF_RANGE " + base + "/validRange"]);
    expect(codes(caseWith(nfiSet({ validRange: { min: q(500, "K") } })))).toEqual(["E_SCHEMA_INVALID " + base + "/validRange"]);
    const { densityFraction: _d, ...noDensity } = nfiSet();
    expect(codes(caseWith(noDensity))).toEqual(["E_PROP_MISSING " + base + "/densityFraction"]);
    expect(codes(caseWith(nfiSet({ par1: 0.05 })))).toEqual(["E_SCHEMA_INVALID " + base + "/par1"]); // the constants are the model's
    expect(codes(caseWith(nfiSet({ densityFraction: q(0.95, "mm") })))).toEqual(["E_UNITS " + base + "/densityFraction"]);
    const { source: _s, ...noSource } = nfiSet();
    expect(codes(caseWith(noSource))).toEqual(["E_PROP_MISSING " + base + "/source"]);
  });
  it("is a fuel model: the cladding cannot use it, and a transient is refused with a burnup", () => {
    const d = read("examples/synthetic-pin.json");
    d.materials.cladding.sets["thermal.conductivity"] = nfiSet();
    expect(codes(d)).toEqual(["E_UNSUPPORTED /materials/cladding/sets/thermal.conductivity/model"]);
    const t = caseWith(nfiSet(), burnup(40), "examples/synthetic-pulse.json");
    expect(codes(t)).toContain("E_UNSUPPORTED /burnup");
  });
  it("a material of the library with the model validates (burnup 0) and the cladding one does not", () => {
    const m = { materialId: "synthetic-uo2", revision: 1, sets: { "thermal.conductivity": nfiSet() } };
    expect(validateMaterial("fuel", m).errors).toEqual([]);
    expect(validateMaterial("cladding", m).errors.map((e) => e.code)).toEqual(["E_UNSUPPORTED"]);
  });
  it("works together with hot dimensions", () => {
    const d = caseWith();
    d.hotDimensions = { referenceTemperature: q(293.15, "K"), fuel: { linearExpansion: q(1e-5, "1/K"), source: "x" }, cladding: { linearExpansion: q(1e-5, "1/K"), source: "x" } };
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.hot).toBeDefined();
    expect(v.normalized!.burnup!.value).toBe(40);
  });
});

describe("what OFFBEAT is told", () => {
  it("UO2MATPRO with the density, the gadolinia and all 13 parameters written, burnup constant, and the Bu file in MWd/t of oxide", () => {
    const w = writeOffbeatCase(normalized());
    const text = w.files["constant/solverDict"]!;
    expect(text).toMatch(/burnup\s+constant;/);
    expect(text).toMatch(/conductivityModel UO2MATPRO;\n\s+densityFraction 0\.95;\n\s+GdContent 0;\n\s+conductivity \{ par1 0\.0452; par2 0\.000246; par3 0\.00187; par4 1\.1599; par5 0\.9; par6 0\.04; par7 0\.038; par8 0\.28; par9 396; par10 6380; par11 3500000000; par12 2; par13 16361; \}/);
    const bu = w.files["0/Bu"]!;
    const values = bu.split("\n").slice(bu.split("\n").findIndex((l) => l === "(") + 1).slice(0, 26);
    expect(values.slice(0, 20).every((v) => v === "35240")).toBe(true); // 40 x 1000 x 0.881
    expect(values.slice(20, 26).every((v) => v === "0")).toBe(true);
    expect(bu).toMatch(/internalField\s+nonuniform List<scalar>\n26\n\(/);
    for (const patch of ["fuelBottom", "fuelTop", "fuelOuter", "fuelFront", "fuelBack", "cladBottom", "cladTop", "cladInner", "cladOuter", "cladFront", "cladBack", "defaultFaces"]) expect(bu, patch).toContain("    " + patch + "\n");
    expect(bu).not.toContain("fuelInner");
    const row = w.mapping.find((m) => m.field === "burnup")!;
    expect(row.file).toBe("0/Bu");
    expect(row.note).toMatch(/40 MWd\/kgHM x 1000 x 0\.881 = 35240 MWd\/t of oxide/);
    expect(w.mapping.find((m) => m.field === "materials.fuel thermal.conductivity")!.note).toMatch(/modified NFI.*par13 = 16361/);
  });
  it("the burnup is written with the model's own 0.881 whatever the burnup unit was, and an annular fuel gets the hole's patch", () => {
    const w = writeOffbeatCase(normalized(nfiSet(), burnup(40000, "MWd/tHM")));
    expect(w.files["0/Bu"]).toContain("35240");
    const d = caseWith();
    d.geometry.fuelInnerRadius = q(1, "mm");
    const a = writeOffbeatCase(validateCase(d).normalized!);
    expect(a.files["0/Bu"]).toContain("    fuelInner\n");
  });
  it("a case without a burnup is written exactly as before: burnup none and no Bu file", () => {
    const w = writeOffbeatCase(validateCase(read("examples/synthetic-pin.json")).normalized!);
    expect(w.files["constant/solverDict"]).toMatch(/burnup\s+none;/);
    expect(w.files["0/Bu"]).toBeUndefined();
    expect(w.mapping.find((m) => m.field === "burnup")).toBeUndefined();
  });
});

describe("the closed forms, the independent solver and the time scale with the burnup law", () => {
  const Ts = (n: ReturnType<typeof normalized>) => quickLook(n).temperatures.fuelSurfaceT;
  it("the centre temperature is the root of the integral of k computed by Simpson's rule (fresh, mid and high burnup, a thin density and gadolinia)", () => {
    for (const [B, f, gad] of [[0, 0.95, 0], [40, 0.95, 0], [62, 0.92, 0], [30, 0.97, 0.08]] as const) {
      const n = normalized(nfiSet({ densityFraction: q(f, "1"), gadolinia: q(gad, "1") }), burnup(B));
      expect(rel(quickLook(n).temperatures.centreT, hotHand(B, f, Ts(n), 20000 / (4 * Math.PI), gad)), `${B} ${f} ${gad}`).toBeLessThan(1e-9);
    }
  });
  it("the radial profile follows the law at every radius", () => {
    const n = normalized();
    const look = quickLook(n);
    for (const p of radialProfile(n, look, 40).filter((x) => x.region === "fuel")) {
      expect(rel(p.T, hotHand(40, 0.95, look.temperatures.fuelSurfaceT, (20000 * (1 - (p.r * p.r) / (4.1e-3 * 4.1e-3))) / (4 * Math.PI)))).toBeLessThan(1e-9);
    }
  });
  it("the range is judged: a fuel that runs outside the stated temperature range is out-of-domain", () => {
    expect(quickLook(normalized()).verdict).toBe("in-domain");
    const narrow = quickLook(normalized(nfiSet({ validRange: { min: q(300, "K"), max: q(1000, "K") } })));
    expect(narrow.verdict).toBe("out-of-domain");
    expect(narrow.findings.map((f) => f.region)).toEqual(["fuel"]);
  });
  const pin = (over: Partial<TransientPin> = {}): TransientPin => ({
    fuelInnerRadius: 0, fuelRadius: 0.0041, claddingInnerRadius: 0.00418, claddingOuterRadius: 0.00475, fuelCells: 40, claddingCells: 12, gapConductance: 5000,
    fuelK: { a: 3, b: 0 }, claddingK: { a: 15, b: 0 }, fuelC: { a: 3e6, b: 0 }, claddingC: { a: 2.5e6, b: 0 },
    boundary: { kind: "convective", bulkTemperature: 573, heatTransferCoefficient: 30000 }, power: () => 0, fuelLaw: { kind: "uo2-nfi", burnup: 40, densityFraction: 0.95, gadolinia: 0 }, ...over,
  });
  it("the steady finite-volume solution converges to the closed form at second order", () => {
    const err = (nf: number) => {
      const p = pin({ fuelCells: nf, claddingCells: Math.round(nf * 0.3) });
      const s = steadyFv(p, 20000);
      const Tsurf = 573 + 20000 / (2 * Math.PI * p.claddingOuterRadius * 30000) + (20000 * Math.log(p.claddingOuterRadius / p.claddingInnerRadius)) / (2 * Math.PI * 15) + 20000 / (2 * Math.PI * p.fuelRadius * 5000);
      return Math.max(...Array.from({ length: nf }, (_, i) => {
        const r = (p.fuelRadius * (i + 0.5)) / nf;
        return Math.abs(s.T[i]! - hotHand(40, 0.95, Tsurf, (20000 * (1 - (r * r) / (p.fuelRadius * p.fuelRadius))) / (4 * Math.PI)));
      }));
    };
    const e = [10, 20, 40, 80].map(err);
    for (let i = 1; i < e.length; i++) {
      expect(e[i - 1]! / e[i]!).toBeGreaterThan(3.2);
      expect(e[i - 1]! / e[i]!).toBeLessThan(4.4);
    }
  });
  it("a steady field is a fixed point of the transient with the same law", () => {
    const p = pin({ power: () => 20000 });
    const s = steadyFv(p, 20000);
    const run = solveTransientFv(p, { dt: 0.5, steps: 100, initialField: s.T, outputEvery: 100 });
    expect(Math.max(...run.states[run.states.length - 1]!.T.map((x, i) => Math.abs(x - s.T[i]!)))).toBeLessThan(1e-6);
  });
  it("the lowest conductivity and the time scale follow the law: a lower conductivity gives a longer time constant", () => {
    const n = normalized(nfiSet({ validRange: { min: q(300, "K"), max: q(1500, "K") } }));
    expect(lowestConductivity(n.fuelConductivity)).toBeCloseTo(nfiConductivity(1500, { burnup: 40, densityFraction: 0.95, gadolinia: 0 }), 9);
    expect(timeScale(normalized(nfiSet(), burnup(62))).tauBound).toBeGreaterThan(timeScale(normalized(nfiSet(), burnup(0))).tauBound);
  });
  it("evaluate through the law union is the conductivity function", () => {
    const law = lawOf(normalized().fuelConductivity);
    expect(evaluate(law, 1234)).toBe(nfiConductivity(1234, { burnup: 40, densityFraction: 0.95, gadolinia: 0 }));
  });
});

describe("the independent transient model, should it ever be given the law", () => {
  it("carries the law itself, and its linear stand-in is the chord of the law over its range (a validated case cannot reach this: a burnup is refused in a transient)", () => {
    const pulse = validateCase(read("examples/synthetic-pulse.json")).normalized!;
    const n = { ...pulse, fuelConductivity: { kind: "uo2-nfi" as const, burnup: 40, densityFraction: 0.95, gadolinia: 0, range: [300, 3000] as [number, number] } };
    const pin = pinOf(n);
    expect(pin.fuelLaw).toEqual({ kind: "uo2-nfi", burnup: 40, densityFraction: 0.95, gadolinia: 0 });
    const chord = (T: number) => pin.fuelK.a + pin.fuelK.b * T;
    expect(chord(300)).toBeCloseTo(kHand(300, 40, 0.95), 9);
    expect(chord(3000)).toBeCloseTo(kHand(3000, 40, 0.95), 9);
  });
});
