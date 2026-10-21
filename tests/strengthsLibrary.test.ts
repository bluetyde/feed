// The strength tables of library/strengths.json (read from UT-Austin SAR figures 4.3a and 4.3b, supplied as an image by the user 2026-10-10): each is a valid stress limit for a
// case, falls with temperature, and the figures agree where they cross: the ZrH1.65 hoop stress of figure 4.3b is the hydrogen pressure of src/core/hydrogenPressure.ts times the
// SAR's thin-shell factor (36.7), and it meets the ultimate-strength curve at about 960 C and 9 ksi.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { hydrogenPressure } from "../src/core/hydrogenPressure";
import { strengthAt } from "../src/core/mechanicsChecks";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const lib: any[] = JSON.parse(readFileSync(join(root, "library/strengths.json"), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const sets = {
  "mechanical.elasticity": { model: "constant", youngModulus: q(190, "GPa"), poissonRatio: q(0.3, "1"), source: "a test" },
  "mechanical.thermalExpansion": { linearExpansion: q(17, "ppm/K"), source: "a test" },
};
const caseWith = (limits: unknown) => {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.assumptions.thermalOnly = false;
  Object.assign(d.materials.fuel.sets, sets);
  Object.assign(d.materials.cladding.sets, sets);
  d.mechanics = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0, "Pa"), stressLimits: limits };
  return d;
};
const asLimit = (e: any) => ({ name: e.id, region: e.region, table: e.table, source: e.citation });
const psi = 6894.757293168;

describe("library/strengths.json", () => {
  it("each entry is accepted as a stress limit by the validator, and names its source and uncertainty", () => {
    expect(lib.map((e) => e.id)).toEqual(["ss304-ut-sar-ultimate", "ss304-ut-sar-yield", "ss304-sandia-fig-ultimate", "ss304-sandia-fig-yield", "ss304l-inl-plate-ultimate", "ss304l-inl-plate-yield"]);
    for (const e of lib) {
      expect(validateCase(caseWith([asLimit(e)])).errors, e.id).toEqual([]);
      expect(e.citation).toMatch(/Safety Analysis Report|SAND2009-7374C|INL\/CON-06-11962/);
      expect(e.uncertainty).toMatch(/10 %|plate|PLATE/);
    }
    for (const e of lib.slice(0, 2)) {
      expect(e.citation).toMatch(/Safety Analysis Report/);
      expect(e.uncertainty).toMatch(/10 %/);
    }
    expect(validateCase(caseWith(lib.map(asLimit))).errors).toEqual([]);
  });
  it("the strength falls as the temperature rises, the yield is below the ultimate everywhere they are both stated, and the stated range is the table's", () => {
    const tabs = Object.fromEntries(lib.map((e) => [e.id, validateCase(caseWith([asLimit(e)])).normalized!.mechanics!.stressLimits![0]!.table])) as Record<string, { temperature: number; strength: number }[]>;
    for (const [id, t] of Object.entries(tabs)) {
      // the yield curve of the Sandia figure is flat (34.5 ksi) from room temperature to 500 C: it never rises
      for (let i = 1; i < t.length; i++) (id === "ss304-sandia-fig-yield" ? expect(t[i]!.strength).toBeLessThanOrEqual(t[i - 1]!.strength) : expect(t[i]!.strength).toBeLessThan(t[i - 1]!.strength));
    }
    for (const kind of ["sandia-fig", "inl-plate"]) {
      const y = tabs[lib.find((e) => e.id.includes(kind) && e.id.endsWith("yield")).id]!;
      const u = tabs[lib.find((e) => e.id.includes(kind) && e.id.endsWith("ultimate")).id]!;
      for (const row of y) if (row.temperature <= u[u.length - 1]!.temperature) expect(row.strength, kind).toBeLessThan(strengthAt(u, row.temperature)!);
    }
    for (const T of [400, 500, 600, 700, 800, 870]) {
      const K = T + 273.15;
      expect(strengthAt(tabs["ss304-ut-sar-yield"]!, K)!).toBeLessThan(strengthAt(tabs["ss304-ut-sar-ultimate"]!, K)!);
    }
    for (const e of lib) {
      const t = tabs[e.id]!;
      expect(t[0]!.temperature).toBeCloseTo(e.validRange.min.value + 273.15, 9);
      expect(t[t.length - 1]!.temperature).toBeCloseTo(e.validRange.max.value + 273.15, 9);
    }
  });
  it("figure 4.3b agrees: the ZrH1.65 hoop stress (hydrogen pressure x 36.7) meets the ultimate curve near 960 C and 9 ksi", () => {
    const t = validateCase(caseWith([asLimit(lib[0])])).normalized!.mechanics!.stressLimits![0]!.table;
    const gap = (C: number) => hydrogenPressure(1.65, C + 273.15) * 36.7 - strengthAt(t, C + 273.15)!;
    // the hoop stress is below the strength at 900 C and above it at 1000 C: they cross between, as the figure shows (about 960 C)
    expect(gap(900)).toBeLessThan(0);
    expect(gap(1000)).toBeGreaterThan(0);
    let lo = 900;
    let hi = 1000;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (gap(mid) < 0) lo = mid;
      else hi = mid;
    }
    expect(lo).toBeGreaterThan(940);
    expect(lo).toBeLessThan(985);
    const at = strengthAt(t, lo + 273.15)! / psi;
    expect(at).toBeGreaterThan(8000);
    expect(at).toBeLessThan(10000);
  });
});

describe("the cold-range strength tables agree with the numbers their sources state in words", () => {
  const tab = (id: string) => validateCase(caseWith([asLimit(lib.find((e) => e.id === id))])).normalized!.mechanics!.stressLimits![0]!.table;
  const ksi = (id: string, C: number) => strengthAt(tab(id), C + 273.15)! / psi / 1000;
  it("Sandia curve: Simnad's about 57 ksi ultimate at 500 C and the slide's 74 ksi ultimate at 154 C; the UT-Austin curve where they overlap", () => {
    expect(Math.abs(ksi("ss304-sandia-fig-ultimate", 500) - 57)).toBeLessThan(1);
    expect(Math.abs(ksi("ss304-sandia-fig-ultimate", 154) - 74) / 74).toBeLessThan(0.05);
    // the slide's own yield number at 154 C (29 ksi) is 16 % under the curve: stated in the entry, and checked here so a silent edit shows
    expect(ksi("ss304-sandia-fig-yield", 154)).toBeGreaterThan(34);
    for (const T of [400, 500, 600]) {
      expect(Math.abs(ksi("ss304-sandia-fig-ultimate", T) - ksi("ss304-ut-sar-ultimate", T))).toBeLessThan(1.5);
      expect(Math.abs(ksi("ss304-sandia-fig-yield", T) - ksi("ss304-ut-sar-yield", T))).toBeLessThan(2);
    }
  });
  it("INL plate: above the ASME room-temperature minimum of its own paper (25 ksi yield, 70 ksi ultimate), and the ultimate at 316 C is still above 60 ksi", () => {
    expect(ksi("ss304l-inl-plate-yield", 21)).toBeGreaterThan(25);
    expect(ksi("ss304l-inl-plate-ultimate", 21)).toBeGreaterThan(70);
    expect(ksi("ss304l-inl-plate-ultimate", 316)).toBeGreaterThan(60);
  });
});
