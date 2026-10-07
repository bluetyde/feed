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

describe("a temperature-dependent coefficient, alpha = a + b T", () => {
  const lin = (a: number, b: number, lo = 250, hi = 1500) => ({ model: "linear", a: { value: a, unit: "1/K" }, b: { value: b, unit: "1/K2" }, validRange: { min: { value: lo, unit: "K" }, max: { value: hi, unit: "K" } } });
  const linHot = (fuel: unknown, cladding: unknown = { value: 1e-5, unit: "1/K" }, ref = 300) =>
    withHot({ referenceTemperature: { value: ref, unit: "K" }, fuel: { linearExpansion: fuel, source: "test" }, cladding: { linearExpansion: cladding, source: "test" } });

  /** The same pin by hand: the mean thermal strain of each solid (fuel analytic in theta = 1 - r^2/a^2, cladding by a fine midpoint rule), fixed point by a plain loop. */
  function oracleLinear(af: number, bf: number, ac: number, bc: number, Tref: number, q = 20000) {
    const a0 = 4.1e-3, b0 = 4.18e-3, c0 = 4.75e-3, kf = 3, kc = 15, hf = 30000, hg = 5000, Tb = 573;
    const eps = (a: number, b: number, T: number) => a * (T - Tref) + 0.5 * b * (T * T - Tref * Tref);
    let a = a0, b = b0, c = c0, ef = 0, ec = 0;
    for (let i = 0; i < 200; i++) {
      const Tco = Tb + q / (2 * Math.PI * c * hf);
      const Tci = Tco + (q * Math.log(c / b)) / (2 * Math.PI * kc);
      const Ts = Tci + q / (2 * Math.PI * a * hg);
      const C = q / (4 * Math.PI * kf);
      const meanT = Ts + C / 2, meanT2 = Ts * Ts + Ts * C + (C * C) / 3; // means of T and T^2 over the disc (mean theta 1/2, mean theta^2 1/3)
      ef = a_(af, bf, meanT, meanT2, Tref);
      let sum = 0;
      const N = 20000;
      for (let j = 0; j < N; j++) {
        const r = b + ((j + 0.5) * (c - b)) / N;
        sum += eps(ac, bc, Tco + (q / (2 * Math.PI * kc)) * Math.log(c / r)) * 2 * r;
      }
      ec = (sum * (c - b)) / N / (c * c - b * b);
      a = a0 * (1 + ef);
      const fc = 1 + ec;
      b = b0 * fc;
      c = c0 * fc;
    }
    return { a, b, c, ef, ec };
  }
  const a_ = (a: number, b: number, meanT: number, meanT2: number, Tref: number) => a * (meanT - Tref) + 0.5 * b * (meanT2 - Tref * Tref);

  it("gives the radii of the fixed point of radii and mean thermal strains", () => {
    for (const [af, bf, ac, bc] of [[-7.381375e-7, 1.925e-8, 1.2e-5, 0], [2e-6, 2e-8, 1.4e-5, 4e-9]] as const) {
      const r = linHot(lin(af, bf), lin(ac, bc, 250, 1500), 293.15);
      expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
      const n = r.normalized!;
      const o = oracleLinear(af, bf, ac, bc, 293.15);
      expect(Math.abs(n.fuelRadius / o.a - 1)).toBeLessThan(1e-9);
      expect(Math.abs(n.claddingInnerRadius / o.b - 1)).toBeLessThan(1e-8);
      expect(Math.abs(n.claddingOuterRadius / o.c - 1)).toBeLessThan(1e-8);
      expect(Math.abs(n.hot!.fuel.meanStrain / o.ef - 1)).toBeLessThan(1e-8);
    }
  });

  it("with b = 0 it is the constant coefficient, to the last digits", () => {
    const c = linHot({ value: 1.2e-5, unit: "1/K" }).normalized!;
    const l = linHot(lin(1.2e-5, 0)).normalized!;
    expect(l.fuelRadius).toBeCloseTo(c.fuelRadius, 14);
    expect(l.claddingInnerRadius).toBeCloseTo(c.claddingInnerRadius, 14);
  });

  it("a rising coefficient gives more growth than its value at the reference temperature, and less than its value at the hottest point", () => {
    const n = linHot(lin(5e-6, 2e-8)).normalized!;
    const range = n.hot!.fuel.temperatureRange;
    const lo = 4.1e-3 * (1 + (5e-6 + 2e-8 * 300) * (n.hot!.fuel.meanTemperature - 300));
    const hi = 4.1e-3 * (1 + (5e-6 + 2e-8 * range[1]) * (n.hot!.fuel.meanTemperature - 300));
    expect(n.fuelRadius).toBeGreaterThan(lo);
    expect(n.fuelRadius).toBeLessThan(hi);
  });

  it("warns, and says where, when a solid leaves the stated range; says nothing when the range covers it", () => {
    const out = linHot(lin(5e-6, 2e-8, 293, 600));
    expect(out.ok).toBe(true);
    expect(out.warnings.map((w) => w.code + " " + w.field)).toEqual(["W_EXPANSION_RANGE /hotDimensions/fuel"]);
    expect(out.warnings[0]!.message).toMatch(/runs from .* to .* K, outside the 293 to 600 K/);
    expect(out.normalized!.hot!.fuel.outOfRange).toBe(true);
    expect(out.warnings[0]!.message).toMatch(/runs from 7\d\d\.\d to 1[23]\d\d\.\d K/); // the fuel's coolest then hottest point, in that order
    const [tlo, thi] = out.normalized!.hot!.fuel.temperatureRange;
    expect(tlo).toBeLessThan(thi);
    // below the range only: the fuel (about 780 to 1310 K) leaves a range that starts at 900 K from the cool side, not from the hot side
    const low = linHot(lin(5e-6, 2e-8, 900, 1500));
    expect(low.warnings.map((w) => w.field)).toEqual(["/hotDimensions/fuel"]);
    expect(low.normalized!.hot!.fuel.outOfRange).toBe(true);
    const ok = linHot(lin(5e-6, 2e-8, 250, 1500));
    expect(ok.warnings).toEqual([]);
    expect(ok.normalized!.hot!.fuel.outOfRange).toBe(false);
    expect(withHot(hot()).warnings).toEqual([]); // a constant has no range
  });

  it("a coefficient that is positive over its stated range but not over the temperatures the pin reaches is refused at run time, not applied", () => {
    // positive from 700 K up (6e-6) but negative at the cladding's 595 K
    const r = linHot({ value: 1.2e-5, unit: "1/K" }, lin(-5e-5, 8e-8, 700, 1500));
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code + " " + e.field)).toEqual(["E_OUT_OF_RANGE /hotDimensions"]); // the coefficient is the section's, not the geometry's
    expect(r.errors[0]!.message).toMatch(/cladding's expansion coefficient is not positive/);
  });

  it("refuses the malformed ones", () => {
    const codes = (f: unknown) => linHot(f).errors.map((e) => e.code + " " + e.field);
    expect(codes({ model: "linear", a: { value: 5e-6, unit: "1/K" }, b: { value: 2e-8, unit: "1/K2" } })).toEqual(["E_PROP_MISSING /hotDimensions/fuel/linearExpansion/validRange"]);
    expect(codes({ model: "quadratic" })).toEqual(["E_UNSUPPORTED /hotDimensions/fuel/linearExpansion/model"]);
    expect(codes({ model: "linear", b: { value: 2e-8, unit: "1/K2" }, validRange: lin(1, 1).validRange })).toEqual(["E_PROP_MISSING /hotDimensions/fuel/linearExpansion/a"]);
    expect(codes({ ...lin(5e-6, 2e-8), b: { value: 2e-8, unit: "1/K" } })).toEqual(["E_UNITS /hotDimensions/fuel/linearExpansion/b"]);
    expect(codes({ ...lin(5e-6, 2e-8), extra: 1 })).toEqual(["E_SCHEMA_INVALID /hotDimensions/fuel/linearExpansion/extra"]);
    expect(codes({ ...lin(5e-6, 2e-8), validRange: { min: { value: 900, unit: "K" }, max: { value: 400, unit: "K" } } })).toEqual(["E_OUT_OF_RANGE /hotDimensions/fuel/linearExpansion/validRange"]);
    expect(codes({ ...lin(5e-6, 2e-8), validRange: { min: { value: 300, unit: "K" } } })).toEqual(["E_SCHEMA_INVALID /hotDimensions/fuel/linearExpansion/validRange"]);
    expect(codes({ ...lin(5e-6, 2e-8), validRange: { min: { value: 0, unit: "K" }, max: { value: 600, unit: "K" } } })).toEqual(["E_OUT_OF_RANGE /hotDimensions/fuel/linearExpansion/validRange"]);
    // negative at the cold end of the range, and above the bound at the hot end
    expect(codes(lin(-7.381375e-7, 1.925e-8, 20, 1000))).toEqual(["E_OUT_OF_RANGE /hotDimensions/fuel/linearExpansion"]);
    expect(codes(lin(5e-6, 2e-6, 250, 1500))).toEqual(["E_OUT_OF_RANGE /hotDimensions/fuel/linearExpansion"]);
  });
});

describe("the sourced coefficients in library/expansion.json", () => {
  const sets: any[] = JSON.parse(readFileSync(join(__dirname, "..", "library", "expansion.json"), "utf8"));
  const bySolid = (s: "fuel" | "cladding") => sets.filter((x) => x.solid === s);
  const apply = (d: any, ref = { value: 20, unit: "degC" }) => {
    d.hotDimensions = { referenceTemperature: ref };
    for (const s of sets) d.hotDimensions[s.solid] = { linearExpansion: s.linearExpansion, source: s.source };
    return d;
  };

  it("has one set per solid, each labelled sourced with a citation, a description and the source text a case carries", () => {
    expect(bySolid("fuel").length).toBe(1);
    expect(bySolid("cladding").length).toBe(1);
    for (const s of sets) {
      expect(s.label).toBe("sourced");
      expect(/^[a-z0-9-]{8,}$/.test(s.id), s.id).toBe(true);
      for (const k of ["description", "citation", "source"]) expect(typeof s[k] === "string" && s[k].length > 40, s.id + " " + k).toBe(true);
    }
    expect(new Set(sets.map((s) => s.id)).size).toBe(sets.length);
  });

  it("the fuel law is Simnad's 4.52e-6 + 19.25e-9 T(C) per C rewritten in kelvin: its values at 20, 650 and 800 C", () => {
    const f = bySolid("fuel")[0].linearExpansion;
    const a = f.a.value, b = f.b.value;
    for (const C of [20, 650, 800]) expect(Math.abs((a + b * (C + 273.15)) / (4.52e-6 + 19.25e-9 * C) - 1), "at " + C + " C").toBeLessThan(1e-9);
    expect(f.validRange.min.value).toBeCloseTo(293.15, 10);
    expect(f.validRange.max.value).toBeCloseTo(1073.15, 10);
  });

  it("the cladding coefficient is the 17.2e-6 per K of the cited paper", () => {
    const c = bySolid("cladding")[0].linearExpansion;
    expect(c.unit).toBe("1e-6/K");
    expect(c.value).toBe(17.2);
  });

  it("both apply to a pin with a gap wide enough, and the hot gap closes a little", () => {
    const d = apply(base(), { value: 20, unit: "degC" });
    d.geometry.claddingInnerRadius = { value: 4.3, unit: "mm" };
    const r = validateCase(d);
    expect(r.errors).toEqual([]);
    expect(r.normalized!.hot!.hotGap).toBeLessThan(r.normalized!.hot!.coldGap);
  });

  it("FINDING: every TRIGA example has a zero cold gap with an effective conductance, so free expansion with these coefficients closes it and the case is refused", () => {
    for (const f of ["ksu-triga-hot-element", "ksu-triga-1p25mw-film", "ut-triga-hot-channel-annular", "ut-triga-hot-channel-trace"]) {
      const d = apply(JSON.parse(readFileSync(join(__dirname, "..", "examples", f + ".json"), "utf8")));
      const r = validateCase(d);
      expect(r.ok, f).toBe(false);
      expect(r.errors.map((e) => e.code + " " + e.field), f).toEqual(["E_GEOMETRY /hotDimensions"]);
      expect(r.errors[0]!.message, f).toMatch(/closes the gap/);
    }
  });
});
