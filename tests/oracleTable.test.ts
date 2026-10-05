import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ClosedFormImpl, closedForm } from "../src/core/closedForm";
import { OracleTable, runTable } from "../src/core/oracleTable";
import { quickLook } from "../src/core/quickLook";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const table: OracleTable = read("oracles/closed-form-table.json");

describe("closed-form oracle table", () => {
  it("is matched by the implementation", () => {
    expect(runTable(closedForm, table)).toEqual([]);
  });

  it("has a tolerance and a method on every computed entry", () => {
    for (const e of table.entries.filter((x) => x.quantity)) {
      expect(e.tolerance, e.id).toBeDefined();
      expect(e.method.length, e.id).toBeGreaterThan(0);
    }
  });

  // Tests of the verifier: a deliberately wrong implementation must fail the table.
  const mutants: Record<string, ClosedFormImpl> = {
    "fuel 4 pi -> 2 pi": { ...closedForm, fuelDeltaT: (q, k) => q / (2 * Math.PI * k) },
    "fuel profile depends on radius": { ...closedForm, fuelProfile: (q, k, R, r, Ts) => Ts + (q * (1 - (r * r) / (R * R))) / (4 * Math.PI * k * R * 250) },
    "gap uses cladding inner radius": { ...closedForm, gapDeltaT: (q, _Rf, h) => q / (2 * Math.PI * 0.00418 * h) },
    "gap dropped": { ...closedForm, gapDeltaT: () => 0 },
    "cladding log10": { ...closedForm, claddingDeltaT: (q, Ri, Ro, kc) => (q * Math.log10(Ro / Ri)) / (2 * Math.PI * kc) },
    "cladding planar wall": { ...closedForm, claddingDeltaT: (q, Ri, Ro, kc) => (q * (Ro - Ri)) / (2 * Math.PI * Ri * kc) },
    "film uses inner radius": { ...closedForm, filmDeltaT: (q, _Ro, h) => q / (2 * Math.PI * 0.00418 * h) },
    "power scaled": { ...closedForm, fuelDeltaT: (q, k) => (1.01 * q) / (4 * Math.PI * k) },
    "fuel integral wrong": { ...closedForm, fuelConductivityIntegral: (q) => q / (2 * Math.PI) },
    "cladding integral without log": { ...closedForm, claddingConductivityIntegral: (q) => q / (2 * Math.PI) },
    "linear-k root sign flipped": {
      ...closedForm,
      solveLinearK: (a, b, tCold, integral) => {
        const kCold = a + b * tCold;
        return tCold + (2 * integral) / (kCold - Math.sqrt(kCold * kCold + 2 * b * integral));
      },
    },
    "linear-k ignores b": { ...closedForm, solveLinearK: (a, _b, tCold, integral) => tCold + integral / a },
  };
  for (const [name, impl] of Object.entries(mutants)) {
    it("fails on mutant: " + name, () => {
      expect(runTable(impl, table).length).toBeGreaterThan(0);
    });
  }

  it("fails when an expected value is shifted past its tolerance", () => {
    const shifted: OracleTable = JSON.parse(JSON.stringify(table));
    shifted.entries[0]!.expected!.value += 0.01;
    expect(runTable(closedForm, shifted).map((f) => f.id)).toEqual(["fuel-solid-const"]);
  });
});

describe("refusal and limit entries", () => {
  for (const e of table.entries.filter((x) => x.tag !== "good" && x.refusalCode)) {
    it(e.id + " refuses with " + e.refusalCode, () => {
      const r = validateCase(read(e.fixture!));
      expect(r.ok).toBe(false);
      expect(r.errors.map((i) => i.code)).toContain(e.refusalCode);
    });
  }

  it("out-of-range: a solution outside the conductivity range is flagged out-of-domain, not plain success", () => {
    const doc = read("schema/vectors/good/linear-conductivity.json");
    const inDomain = validateCase(doc);
    expect(inDomain.ok).toBe(true);
    expect(quickLook(inDomain.normalized!).verdict).toBe("in-domain");

    doc.materials.fuel.sets["thermal.conductivity"].validRange.max = { value: 1000, unit: "K" };
    const narrowed = validateCase(doc);
    expect(narrowed.ok).toBe(true);
    const look = quickLook(narrowed.normalized!);
    expect(look.verdict).toBe("out-of-domain");
    expect(look.findings[0]?.region).toBe("fuel");
  });
});
