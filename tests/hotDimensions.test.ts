// Hot dimensions (src/core/hotDimensions.ts, docs/hot-dimensions.md): the radii of a steady case at operating temperature from free linear expansion.
// The oracle here is written in the test and shares no code with FEED: constant conductivities have closed forms for every temperature and for the mean
// temperature of each solid, and the fixed point of radii and temperatures is iterated by a plain loop.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { validateCase } from "../src/core/validate";

const base = () => JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-pin.json"), "utf8"));
const hot = (extra: Record<string, unknown> = {}) => ({
  referenceTemperature: { value: 300, unit: "K" },
  fuel: { linearExpansion: { value: 1.2e-5, unit: "1/K" }, source: "test value" },
  cladding: { linearExpansion: { value: 1e-5, unit: "1/K" }, source: "test value" },
  ...extra,
});
const withHot = (h: unknown, edit: (d: any) => void = () => {}) => {
  const d = base();
  d.hotDimensions = h;
  edit(d);
  return validateCase(d);
};

/** Constant-k pin by hand: the fixed point of the radii and the area-mean temperatures (q' = 20 kW/m, h film 30000, gap conductance 5000, k 3 and 15). */
function oracle(alphaF: number, alphaC: number, Tref: number, q = 20000) {
  const a0 = 4.1e-3, b0 = 4.18e-3, c0 = 4.75e-3, kf = 3, kc = 15, hf = 30000, hg = 5000, Tb = 573;
  let a = a0, b = b0, c = c0, Tf = 0, Tc = 0;
  for (let i = 0; i < 200; i++) {
    const Tco = Tb + q / (2 * Math.PI * c * hf);
    const Tci = Tco + (q * Math.log(c / b)) / (2 * Math.PI * kc);
    const Ts = Tci + q / (2 * Math.PI * a * hg);
    Tf = Ts + q / (8 * Math.PI * kf); // mean of Ts + q/(4 pi k) (1 - r^2/a^2) over the disc
    const meanLn = Math.log(c) - (2 / (c * c - b * b)) * ((c * c * Math.log(c)) / 2 - (c * c) / 4 - ((b * b * Math.log(b)) / 2 - (b * b) / 4)); // mean of ln(c/r) over the annulus
    Tc = Tco + (q / (2 * Math.PI * kc)) * meanLn;
    a = a0 * (1 + alphaF * (Tf - Tref));
    b = b0 * (1 + alphaC * (Tc - Tref));
    c = c0 * (1 + alphaC * (Tc - Tref));
  }
  return { a, b, c, Tf, Tc };
}

describe("hot dimensions from free linear expansion", () => {
  it("gives the radii of the fixed point of radii and mean temperatures, for two sets of coefficients and reference temperatures", () => {
    for (const [af, ac, ref] of [[1.2e-5, 1e-5, 300], [2.5e-5, 1.8e-5, 293.15]] as const) {
      const r = withHot(hot({ referenceTemperature: { value: ref, unit: "K" }, fuel: { linearExpansion: { value: af, unit: "1/K" }, source: "s" }, cladding: { linearExpansion: { value: ac, unit: "1/K" }, source: "s" } }));
      expect(r.errors).toEqual([]);
      const n = r.normalized!;
      const o = oracle(af, ac, ref);
      expect(Math.abs(n.fuelRadius / o.a - 1)).toBeLessThan(1e-9);
      expect(Math.abs(n.claddingInnerRadius / o.b - 1)).toBeLessThan(1e-9);
      expect(Math.abs(n.claddingOuterRadius / o.c - 1)).toBeLessThan(1e-9);
      expect(Math.abs(n.hot!.fuel.meanTemperature / o.Tf - 1)).toBeLessThan(1e-9);
      expect(Math.abs(n.hot!.cladding.meanTemperature / o.Tc - 1)).toBeLessThan(1e-9);
      // the cold radii are kept, and the hot gap is the difference of the hot radii
      expect(n.hot!.cold.fuelRadius).toBeCloseTo(4.1e-3, 15);
      expect(n.hot!.hotGap).toBeCloseTo(n.claddingInnerRadius - n.fuelRadius, 15);
      expect(n.hot!.coldGap).toBeCloseTo(0.08e-3, 15);
    }
  });

  it("the hot gap is smaller than the cold one when the fuel grows faster, and larger when the cladding does", () => {
    const f = withHot(hot()).normalized!.hot!;
    expect(f.hotGap).toBeLessThan(f.coldGap);
    const c = withHot(hot({ fuel: { linearExpansion: { value: 1e-6, unit: "1/K" }, source: "s" }, cladding: { linearExpansion: { value: 3e-5, unit: "1/K" }, source: "s" } })).normalized!.hot!;
    expect(c.hotGap).toBeGreaterThan(c.coldGap);
  });

  it("a pin that sits at its reference temperature does not change, and one at a uniform other temperature grows by exactly alpha dT", () => {
    const flat = (surface: number, ref: number) =>
      withHot(hot({ referenceTemperature: { value: ref, unit: "K" } }), (d) => {
        d.power.linearHeatRate = { value: 1e-6, unit: "W/m" };
        d.boundary = { surfaceTemperature: { value: surface, unit: "K" } };
      }).normalized!;
    const same = flat(600, 600);
    expect(same.fuelRadius).toBeCloseTo(4.1e-3, 12);
    expect(same.claddingOuterRadius).toBeCloseTo(4.75e-3, 12);
    const grown = flat(900, 300);
    expect(Math.abs(grown.fuelRadius / (4.1e-3 * (1 + 1.2e-5 * 600)) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(grown.claddingOuterRadius / (4.75e-3 * (1 + 1e-5 * 600)) - 1)).toBeLessThan(1e-9);
    // the central hole grows with the fuel
    const holed = withHot(hot(), (d) => {
      d.geometry.fuelInnerRadius = { value: 1, unit: "mm" };
      d.power.linearHeatRate = { value: 1e-6, unit: "W/m" };
      d.boundary = { surfaceTemperature: { value: 900, unit: "K" } };
    }).normalized!;
    expect(Math.abs(holed.fuelInnerRadius / (1e-3 * (1 + 1.2e-5 * 600)) - 1)).toBeLessThan(1e-9);
  });

  it("a reference temperature given in degrees C is the same as in kelvin", () => {
    const k = withHot(hot()).normalized!;
    const c = withHot(hot({ referenceTemperature: { value: 300 - 273.15, unit: "degC" } })).normalized!;
    expect(c.fuelRadius).toBeCloseTo(k.fuelRadius, 14);
  });

  it("the case without the section is unchanged and has no hot record", () => {
    const n = validateCase(base()).normalized!;
    expect(n.hot).toBeUndefined();
    expect(n.fuelRadius).toBeCloseTo(4.1e-3, 15);
  });

  it("the writer writes the hot radii, and says so in its mapping", () => {
    const cold = writeOffbeatCase(validateCase(base()).normalized!);
    const hotCase = writeOffbeatCase(withHot(hot()).normalized!);
    expect(hotCase.files["system/blockMeshDict"]).not.toEqual(cold.files["system/blockMeshDict"]);
    const row = hotCase.mapping.find((m) => m.field === "geometry.fuelRadius")!;
    expect(row.note).toMatch(/HOT value: the case's 4\.1000000 mm expanded by 1\.0/);
    expect(cold.mapping.find((m) => m.field === "geometry.fuelRadius")!.note).not.toMatch(/HOT/);
  });
});

describe("what the section refuses", () => {
  const codes = (r: ReturnType<typeof validateCase>) => r.errors.map((e) => e.code + " " + e.field);
  it("a gap that the expansion closes: the case is refused with the radii in the message", () => {
    const r = withHot(hot({ fuel: { linearExpansion: { value: 9e-4, unit: "1/K" }, source: "s" } }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["E_GEOMETRY /hotDimensions"]);
    expect(r.errors[0]!.message).toMatch(/closes the gap/);
    expect(r.normalized).toBeUndefined();
  });
  it("a transient case", () => {
    const d = base();
    d.hotDimensions = hot();
    d.assumptions.steadyState = false;
    expect(codes(validateCase(d))).toContain("E_UNSUPPORTED /hotDimensions");
  });
  it("a missing source, coefficient, solid or reference temperature", () => {
    expect(codes(withHot(hot({ fuel: { linearExpansion: { value: 1e-5, unit: "1/K" } } })))).toContain("E_PROP_MISSING /hotDimensions/fuel/source");
    expect(codes(withHot(hot({ fuel: { linearExpansion: { value: 1e-5, unit: "1/K" }, source: "  " } })))).toContain("E_PROP_MISSING /hotDimensions/fuel/source");
    expect(codes(withHot(hot({ cladding: { source: "s" } })))).toContain("E_PROP_MISSING /hotDimensions/cladding/linearExpansion");
    expect(codes(withHot({ referenceTemperature: { value: 300, unit: "K" }, fuel: hot().fuel }))).toContain("E_PROP_MISSING /hotDimensions/cladding");
    const noRef: Record<string, unknown> = hot();
    delete noRef.referenceTemperature;
    expect(codes(withHot(noRef))).toContain("E_PROP_MISSING /hotDimensions/referenceTemperature");
  });
  it("a bad unit, a bare number, a zero, negative or absurd coefficient, an absurd reference temperature, an unknown key", () => {
    expect(codes(withHot(hot({ fuel: { linearExpansion: { value: 1e-5, unit: "W/m/K" }, source: "s" } })))).toContain("E_UNITS /hotDimensions/fuel/linearExpansion");
    expect(codes(withHot(hot({ fuel: { linearExpansion: 1e-5, source: "s" } })))).toContain("E_UNITS /hotDimensions/fuel/linearExpansion");
    for (const v of [0, -1e-5, 2e-3]) expect(codes(withHot(hot({ fuel: { linearExpansion: { value: v, unit: "1/K" }, source: "s" } }))), String(v)).toContain("E_OUT_OF_RANGE /hotDimensions/fuel/linearExpansion");
    expect(codes(withHot(hot({ referenceTemperature: { value: 0, unit: "K" } })))).toContain("E_OUT_OF_RANGE /hotDimensions/referenceTemperature");
    expect(codes(withHot(hot({ referenceTemperature: { value: 300, unit: "mm" } })))).toContain("E_UNITS /hotDimensions/referenceTemperature");
    expect(codes(withHot(hot({ extra: 1 })))).toContain("E_SCHEMA_INVALID /hotDimensions/extra");
    expect(codes(withHot(hot({ fuel: { linearExpansion: { value: 1e-5, unit: "1/K" }, source: "s", alpha: 1 } })))).toContain("E_SCHEMA_INVALID /hotDimensions/fuel/alpha");
    expect(codes(withHot("hot"))).toContain("E_SCHEMA_INVALID /hotDimensions");
  });
  it("the units 1e-6/K and ppm/K are the same coefficient", () => {
    const a = withHot(hot({ fuel: { linearExpansion: { value: 12, unit: "ppm/K" }, source: "s" } })).normalized!;
    const b = withHot(hot({ fuel: { linearExpansion: { value: 1.2e-5, unit: "1/K" }, source: "s" } })).normalized!;
    const c = withHot(hot({ fuel: { linearExpansion: { value: 12, unit: "1e-6/K" }, source: "s" } })).normalized!;
    expect(a.fuelRadius).toBe(b.fuelRadius);
    expect(c.fuelRadius).toBe(b.fuelRadius);
  });
});
