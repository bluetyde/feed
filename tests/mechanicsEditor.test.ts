// What the editor's Mechanics panel gets from the server (docs/plans/09-mechanics.md M5): the sourced strength tables in the library, the suggested contact penalty factor for the
// stiffness ratio of the case (from M3's sweep), the gas pressure FEED works out, and the banner words; a case without mechanics gets none of it. The page itself was driven in the
// browser pane (see the plan record).
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { penaltyAdvice } from "../src/core/penaltyAdvice";
import { MECHANICS_TEXT } from "../src/core/mechanicsResults";
import { check, library } from "../src/server/server";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const sets = (E: number) => ({
  "mechanical.elasticity": { model: "constant", youngModulus: q(E, "GPa"), poissonRatio: q(0.3, "1"), source: "a test" },
  "mechanical.thermalExpansion": { linearExpansion: q(10, "ppm/K"), source: "a test" },
});
function mechCase(Ef: number, Ec: number, internalPressure?: unknown) {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.assumptions.thermalOnly = false;
  Object.assign(d.materials.fuel.sets, sets(Ef));
  Object.assign(d.materials.cladding.sets, sets(Ec));
  d.mechanics = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0, "Pa") };
  if (internalPressure) d.mechanics.internalPressure = internalPressure;
  return d;
}

describe("penaltyAdvice", () => {
  it("0.3 for a fuel as stiff as the cladding or stiffer (the sweep ran 1 and 2 times), 0.7 for a soft one (0.25 times)", () => {
    expect(penaltyAdvice(200e9, 200e9)).toMatchObject({ factor: 0.3, tested: true });
    expect(penaltyAdvice(400e9, 200e9)).toMatchObject({ factor: 0.3, tested: true });
    expect(penaltyAdvice(50e9, 200e9)).toMatchObject({ factor: 0.7, tested: true });
    expect(penaltyAdvice(50e9, 200e9).note).toMatch(/known limit/);
  });
  it("says so when the ratio is outside what was run", () => {
    expect(penaltyAdvice(1000e9, 200e9).tested).toBe(false);
    expect(penaltyAdvice(1000e9, 200e9).note).toMatch(/outside the 0\.25 to 2 the sweep ran/);
    expect(penaltyAdvice(5e9, 200e9).tested).toBe(false);
    expect(penaltyAdvice(100e9, 200e9).note).not.toMatch(/outside/);
  });
  it("the ratio is the fuel's modulus over the cladding's", () => {
    expect(penaltyAdvice(62.7e9, 190e9).ratio).toBeCloseTo(0.33, 2);
  });
});

describe("the editor's check response for a mechanics case", () => {
  it("carries the advice, the banner words and the gas pressure the case works out", () => {
    const r: any = check(mechCase(200, 200, { model: "constant", pressure: q(5, "MPa"), source: "a test" }));
    expect(r.ok).toBe(true);
    expect(r.mechanicsNote).toBe(MECHANICS_TEXT);
    expect(r.mechanicsAdvice.penalty.factor).toBe(0.3);
    expect(r.mechanicsAdvice.internalPressure).toBe(5e6);
    expect(r.mechanicsAdvice.internalPressureNote).toMatch(/a stated pressure/);
    expect((check(mechCase(50, 200)) as any).mechanicsAdvice.penalty.factor).toBe(0.7);
  });
  it("a thermal case has none of it, and a refused case has none either", () => {
    const thermal: any = check(JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8")));
    expect(thermal.ok).toBe(true);
    expect(thermal.mechanicsAdvice).toBeUndefined();
    expect(thermal.mechanicsNote).toBeUndefined();
    const bad: any = check(mechCase(200, 200, { model: "constant", pressure: q(0, "MPa"), source: "x" }));
    expect(bad.ok).toBe(false);
    expect(bad.mechanicsAdvice).toBeUndefined();
  });
});

describe("the library the editor loads", () => {
  it("includes the sourced strength tables", () => {
    const l: any = library();
    expect(l.strengths.map((s: any) => s.id)).toEqual(["ss304-ut-sar-ultimate", "ss304-ut-sar-yield", "ss304-sandia-fig-ultimate", "ss304-sandia-fig-yield", "ss304l-inl-plate-ultimate", "ss304l-inl-plate-yield"]);
    for (const s of l.strengths) {
      expect(s.table.length).toBeGreaterThan(2);
      expect(s.citation).toMatch(/Safety Analysis Report|SAND2009-7374C|INL\/CON-06-11962/);
    }
  });
});

describe("the page", () => {
  const html = readFileSync(join(root, "src/web/index.html"), "utf8");
  it("has the Mechanics item under Checks, the two result plots, and a banner that follows the case", () => {
    expect(html).toMatch(/\["mechanics", "Mechanics", "Checks", \["\/mechanics"\]\]/);
    expect(html).toMatch(/id="rmech"/);
    expect(html).toMatch(/id="rdisp"/);
    expect(html).toMatch(/id="caseBanner"/);
    expect(html).toMatch(/function mechanicsPanel/);
  });
});
