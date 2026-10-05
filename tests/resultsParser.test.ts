import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildResults, parsePatchValue, parseScalarField, parseVectorField, ResultsError } from "../src/core/resultsParser";
import { validateCase } from "../src/core/validate";
import { scalarFieldText, vectorFieldText } from "./helpers/foamText";

const root = join(__dirname, "..");
const golden = (f: string) => readFileSync(join(root, "tests/golden/offbeat-syn", f), "utf8");
const T = golden("T");
const C = golden("C");
const pin = (mutate?: (d: any) => void) => {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  mutate?.(d);
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};
const build = (t = T, c = C, n = pin()) => buildResults(n, { T: t, C: c, time: 5e7 });

/** Replace the value at 0-based list position i of a scalar field's list. */
const withValue = (text: string, i: number, v: string) => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "(");
  lines[start + 1 + i] = v;
  return lines.join("\n");
};

describe("results parser on real OFFBEAT output", () => {
  const res = build();

  it("reads the saved field files", () => {
    expect(parseScalarField(T, "T").length).toBe(26);
    expect(parseVectorField(C, "C").length).toBe(26);
    expect(parsePatchValue(T, "cladOuter")).toBeCloseTo(595.33756, 5);
  });

  it("builds a results record with fuel then cladding in radial order", () => {
    expect(res.schema).toBe("feed.results/0.1");
    expect(res.radial.length).toBe(26);
    expect(res.radial.filter((p) => p.region === "fuel").length).toBe(20);
    for (let i = 1; i < 20; i++) expect(res.radial[i]!.r).toBeGreaterThan(res.radial[i - 1]!.r);
    expect(res.summary.centreCellT).toBeCloseTo(1307.2076, 3);
    expect(res.summary.claddingOuterWallT).toBeCloseTo(595.33756, 5);
    expect(res.summary.maxT).toBe(res.summary.centreCellT);
    expect(res.thermalOnly).toMatch(/Thermal-only/);
  });

  it("passes the closed-form and wall checks and reports an energy balance", () => {
    const by = Object.fromEntries(res.checks.map((c) => [c.id, c]));
    expect(by.closedFormFuel!.verdict).toBe("pass");
    expect(by.closedFormCladding!.verdict).toBe("pass");
    expect(by.wallTemperature!.verdict).toBe("pass");
    expect(by.energyBalance!.verdict).toBe("pass");
    expect(Math.abs(by.energyBalance!.value!)).toBeLessThan(0.01);
  });

  describe("tests of the verifier: a wrong result fails its checks", () => {
    it("fuel conductivity 10% off -> closed-form fuel check fails", () => {
      const r = build(T, C, pin((d) => (d.materials.fuel.sets["thermal.conductivity"].value = { value: 3.3, unit: "W/m/K" })));
      expect(r.checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("fail");
    });
    it("input power 5% off -> energy balance fails", () => {
      const r = build(T, C, pin((d) => (d.power.linearHeatRate = { value: 21, unit: "kW/m" })));
      expect(r.checks.find((c) => c.id === "energyBalance")!.verdict).toBe("fail");
    });
    it("wrong gap conductance in the case -> closed-form fuel check fails", () => {
      const r = build(T, C, pin((d) => (d.gap.conductance = { value: 2000, unit: "W/m2/K" })));
      expect(r.checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("fail");
    });
    it("wrong coolant temperature in the case -> wall check fails", () => {
      const r = build(T, C, pin((d) => (d.boundary.bulkTemperature = { value: 600, unit: "K" })));
      expect(r.checks.find((c) => c.id === "wallTemperature")!.verdict).toBe("fail");
    });
  });

  describe("incomplete or broken output is refused", () => {
    const refuses = (fn: () => unknown, re: RegExp) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(ResultsError);
        expect((e as ResultsError).code).toBe("E_OUTPUT_INCOMPLETE");
        expect((e as Error).message).toMatch(re);
        return;
      }
      throw new Error("expected a refusal");
    };
    it("truncated file", () => refuses(() => build(T.slice(0, T.indexOf("1101.0777")), C), /not closed|truncated/));
    it("a non-finite value", () => refuses(() => build(withValue(T, 5, "nan"), C), /not finite/));
    it("an infinite value", () => refuses(() => build(withValue(T, 5, "inf"), C), /not finite/));
    it("header count does not match the list", () => refuses(() => build(T.replace(/\n26\n\(/, "\n27\n("), C), /header says 27/));
    it("uniform field", () => refuses(() => build("internalField uniform 300;\n", C), /uniform/));
    it("no internalField", () => refuses(() => build("nothing here", C), /no internalField/));
    it("cell count differs from the case mesh", () => refuses(() => build(T, C, pin((d) => (d.mesh.fuelCells = 30))), /expected 36 cells/));
    it("temperature not above zero", () => refuses(() => build(withValue(T, 3, "-5"), C), /not above 0 K/));
    it("cell centre outside the pin", () => refuses(() => build(T, C.replace("(0.00013666629 0 0.5)", "(0.5 0 0.5)")), /outside the pin/));
    it("C and T disagree in length", () => refuses(() => build(T, C.replace(/\n26\n\(/, "\n25\n(")), /header says 25/));
    it("bad final time", () => refuses(() => buildResults(pin(), { T, C, time: Number.NaN }), /final time/));
  });
});

describe("results parser on real OFFBEAT output with k(T) in the fuel", () => {
  const gT = readFileSync(join(root, "tests/golden/offbeat-kT/T"), "utf8");
  const gC = readFileSync(join(root, "tests/golden/offbeat-kT/C"), "utf8");
  const kcase = (mutate?: (d: any) => void) => {
    const d = JSON.parse(readFileSync(join(root, "schema/vectors/good/linear-conductivity.json"), "utf8"));
    mutate?.(d);
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    return v.normalized!;
  };
  const by = (r: ReturnType<typeof buildResults>) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

  it("passes every check, including the property range", () => {
    const r = buildResults(kcase(), { T: gT, C: gC, time: 5e7 });
    for (const c of r.checks) expect(c.verdict, c.id).toBe("pass");
    expect(by(r).propertyRange).toBeDefined();
    expect(r.domain.verdict).toBe("in-domain");
    expect(r.summary.centreCellT).toBeCloseTo(1245.964, 3);
  });

  it("flags an out-of-domain result when the stated range is narrower than the temperatures produced", () => {
    const n = kcase((d) => (d.materials.fuel.sets["thermal.conductivity"].validRange.max = { value: 1000, unit: "K" }));
    const r = buildResults(n, { T: gT, C: gC, time: 5e7 });
    expect(r.domain.verdict).toBe("out-of-domain");
    expect(r.domain.findings[0]).toMatchObject({ region: "fuel", validRange: [500, 1000] });
    expect(by(r).propertyRange!.verdict).toBe("fail");
    expect(by(r).propertyRange!.note).toMatch(/out-of-domain/);
  });

  it("the same output read against a constant-k case fails the closed-form check (the law matters)", () => {
    const r = buildResults(kcase((d) => (d.materials.fuel.sets["thermal.conductivity"] = { model: "constant", value: { value: 3.3, unit: "W/m/K" }, referenceTemperature: { value: 1000, unit: "K" }, source: "test" })), { T: gT, C: gC, time: 5e7 });
    expect(by(r).closedFormFuel!.verdict).toBe("fail");
  });

  it("a wrong slope b in the case fails the closed-form fuel check", () => {
    const r = buildResults(kcase((d) => (d.materials.fuel.sets["thermal.conductivity"].b = { value: -0.0012, unit: "W/m/K2" })), { T: gT, C: gC, time: 5e7 });
    expect(by(r).closedFormFuel!.verdict).toBe("fail");
  });

  it("a constant-k case has no property-range check and keeps domain in-domain", () => {
    const r = build();
    expect(by(r).propertyRange).toBeUndefined();
    expect(r.domain.verdict).toBe("in-domain");
  });
});

describe("results parser: Codex review findings", () => {
  const refuses = (fn: () => unknown, re: RegExp) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ResultsError);
      expect((e as Error).message).toMatch(re);
      return;
    }
    throw new Error("expected a refusal");
  };

  it("#5 a field file cut after the cell list but before boundaryField is refused (no silently dropped wall check)", () => {
    const cut = T.slice(0, T.indexOf("boundaryField"));
    refuses(() => build(cut, C), /boundaryField|outer wall|cladOuter/);
  });

  it("#5 a boundaryField without the cladOuter value is refused", () => {
    refuses(() => build(T.replace(/value\s+uniform\s+595\.33756;/, ""), C), /cladOuter/);
  });

  const centreLines = (text: string) => text.split("\n").map((l, i) => [l, i] as const).filter(([l]) => /^\([^()]+\)$/.test(l));
  const swapCentre = (i: number, replacement: string) => {
    const lines = C.split("\n");
    lines[centreLines(C)[i]![1]] = replacement;
    return lines.join("\n");
  };

  it("#8 two cells with the same centre are refused", () => {
    const dup = centreLines(C)[20]![0];
    refuses(() => build(T, swapCentre(21, dup)), /distinct|increasing|same/);
  });

  it("#8 a cladding cell centre inside the gap is refused", () => {
    refuses(() => build(T, swapCentre(20, "(0.004100005 0 0.5)")), /gap|inside/);
  });

  it("#8 a fuel cell centre beyond the fuel radius is refused", () => {
    refuses(() => build(T, swapCentre(19, "(0.0042 0 0.5)")), /fuel|gap|outside/);
  });

  it("#8 results never contain a non-finite number", () => {
    const r = build();
    expect(JSON.stringify(r)).not.toMatch(/null.*energyBalance/);
    for (const c of r.checks) if (c.value !== null) expect(Number.isFinite(c.value), c.id).toBe(true);
  });
});

describe("results parser: re-review findings", () => {
  const refuses = (fn: () => unknown, re: RegExp) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(ResultsError);
      expect((e as Error).message).toMatch(re);
      return;
    }
    throw new Error("expected a refusal");
  };

  it("S4 T cut right after the cladOuter block is refused (no footer, braces unbalanced)", () => {
    const cut = T.slice(0, T.indexOf("}", T.indexOf("cladOuter")) + 1);
    refuses(() => build(cut, C), /cut short|whole|unbalanced|footer/);
  });

  it("S4 C cut before its end is refused", () => {
    refuses(() => build(T, C.slice(0, C.length - 60)), /cut short|whole|unbalanced|footer|not closed/);
  });

  it("S4 a wall list that declares two values but holds one is refused", () => {
    refuses(() => build(T.replace(/value\s+uniform\s+595\.33756;/, "value nonuniform List<scalar> 2 (595.33756);"), C), /declares 2|cladOuter/);
  });

  it("S4 a field with a stray extra closing brace is refused", () => {
    refuses(() => build(T.replace("// ****", "}\n// ****"), C), /unbalanced|whole/);
  });

  it("S4 the real golden files are accepted (whole, balanced, with footer)", () => {
    expect(() => build()).not.toThrow();
  });

  it("S3 guard: the writer's wedge-corrected cell centres at the largest allowed meshes are still classified correctly", () => {
    // cell centres exactly as the case writer's geometry puts them: nominal mid-radius times sqrt(sin(a)/a)
    const a = ((0.25 / 180) * Math.PI) / 2;
    const corr = Math.sqrt(Math.sin(a) / a);
    for (const doc of [(d: any) => d, (d: any) => ((d.geometry.claddingInnerRadius = d.geometry.fuelRadius), d)]) {
      const d = doc(JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8")));
      d.mesh = { fuelCells: 20000, claddingCells: 10000 };
      const v = validateCase(d);
      expect(v.errors).toEqual([]);
      const n = v.normalized!;
      const centres: number[] = [];
      for (let i = 0; i < 20000; i++) centres.push(((i + 0.5) * n.fuelRadius) / 20000 * corr);
      for (let i = 0; i < 10000; i++) centres.push((n.claddingInnerRadius + ((i + 0.5) * (n.claddingOuterRadius - n.claddingInnerRadius)) / 10000) * corr);
      const Tt = scalarFieldText(centres.map((_, i) => 600 + i * 1e-3), 595);
      const r = buildResults(n, { T: Tt, C: vectorFieldText(centres), time: 5e7 });
      expect(r.radial.filter((p) => p.region === "fuel").length).toBe(20000);
      expect(r.radial.filter((p) => p.region === "cladding").length).toBe(10000);
    }
  });
});
