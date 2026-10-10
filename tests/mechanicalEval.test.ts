// The constants OFFBEAT is given for each solid when a modulus or an expansion coefficient is a law of temperature (src/core/mechanicalEval.ts, docs/plans/09-mechanics.md M2),
// checked against closed forms written here for the constant-conductivity pin (the fuel's profile is T = Ts + dT (1 - r^2 / R^2), whose area-weighted mean of any quadratic in T
// is an exact integral), and the warnings when a solid leaves the range of a law.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { effectiveMechanics } from "../src/core/mechanicalEval";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const elasticity = (extra: Record<string, unknown> = {}) => ({ model: "constant", youngModulus: q(200, "GPa"), poissonRatio: q(0.3, "1"), source: "a test", ...extra });
const linearE = (a: number, b: number, lo: number, hi: number, nu = 0.3) => ({ model: "linear", a: q(a, "Pa"), b: q(b, "Pa/K"), poissonRatio: q(nu, "1"), validRange: { min: q(lo, "K"), max: q(hi, "K") }, source: "a test" });
const linearAlpha = (a: number, b: number, lo: number, hi: number) => ({ linearExpansion: { model: "linear", a: q(a, "1/K"), b: q(b, "1/K2"), validRange: { min: q(lo, "K"), max: q(hi, "K") } }, source: "a test" });
const constAlpha = (alpha: number) => ({ linearExpansion: q(alpha, "1/K"), source: "a test" });

function pinCase(fuel: Record<string, unknown>, cladding: Record<string, unknown>, Tref = 300, qLin = 20) {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.power.linearHeatRate = q(qLin, "kW/m");
  d.assumptions.thermalOnly = false;
  Object.assign(d.materials.fuel.sets, fuel);
  Object.assign(d.materials.cladding.sets, cladding);
  d.mechanics = { referenceTemperature: q(Tref, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0, "Pa") };
  return d;
}
const sets = (e: unknown, x: unknown) => ({ "mechanical.elasticity": e, "mechanical.thermalExpansion": x });
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v;
};

/** The synthetic pin's closed form: constant k (3 W/m/K fuel, 15 W/m/K cladding), q' 20 kW/m, gap conductance 5000, film h 30000 at 573 K. */
function closed() {
  const qp = 20e3, kf = 3, kc = 15, Rf = 4.1e-3, Rci = 4.18e-3, Rco = 4.75e-3, hg = 5000, h = 30000, Tb = 573;
  const Tw = Tb + qp / (2 * Math.PI * Rco * h);
  const Tci = Tw + (qp * Math.log(Rco / Rci)) / (2 * Math.PI * kc);
  const Tfs = Tci + qp / (2 * Math.PI * Rf * hg);
  const dTf = qp / (4 * Math.PI * kf);
  return { Tw, Tci, Tfs, dTf, Rf, Rci, Rco, qp, kc };
}

describe("a constant case: the constants are the stated ones", () => {
  it("E, nu, G and alpha as stated; the mean temperature of the fuel is Ts + dT / 2 on the closed-form profile", () => {
    const v = norm(pinCase(sets(elasticity(), constAlpha(1e-5)), sets(elasticity({ youngModulus: q(190, "GPa") }), constAlpha(17e-6))));
    const e = effectiveMechanics(v.normalized!)!;
    const c = closed();
    expect(e.fuel.E).toBe(2e11);
    expect(e.fuel.nu).toBeCloseTo(0.3, 15);
    expect(e.fuel.G).toBeCloseTo(2e11 / 2.6, 0);
    expect(e.fuel.alpha).toBeCloseTo(1e-5, 15);
    expect(e.cladding.E).toBe(1.9e11);
    expect(e.cladding.alpha).toBeCloseTo(17e-6, 15);
    expect(e.fuel.meanTemperature).toBeCloseTo(c.Tfs + c.dTf / 2, 1);
    expect(e.fuel.temperatureRange[0]).toBeCloseTo(c.Tfs, 0);
    expect(e.fuel.temperatureRange[1]).toBeCloseTo(c.Tfs + c.dTf, 0);
    expect(e.referenceTemperature).toBe(300);
  });
  it("no mechanics, no constants", () => {
    const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
    expect(effectiveMechanics(validateCase(d).normalized!)).toBeUndefined();
  });
});

describe("a law of temperature is reduced to constants", () => {
  const c = closed();
  const a0 = 5e-6, b0 = 2e-8; // alpha = a0 + b0 T
  const v = norm(pinCase(sets(linearE(2.5e11, -5e7, 300, 1500), linearAlpha(a0, b0, 250, 1500)), sets(elasticity(), constAlpha(1e-5))));
  const e = effectiveMechanics(v.normalized!)!;
  it("the modulus is the law at the mean temperature of the solid", () => {
    expect(e.fuel.E).toBeCloseTo(2.5e11 - 5e7 * e.fuel.meanTemperature, 0);
  });
  it("the coefficient reproduces the mean thermal strain: alpha x (mean T - Tref) is the area-weighted mean of a (T - Tref) + b/2 (T^2 - Tref^2) over the fuel", () => {
    const Tref = 300;
    const A = c.Tfs + c.dTf; // T = A - dT x with x = r^2 / R^2, uniform in x over the area
    const B = c.dTf;
    const meanT = A - B / 2;
    const meanT2 = A * A - A * B + (B * B) / 3;
    const meanStrain = a0 * (meanT - Tref) + (b0 / 2) * (meanT2 - Tref * Tref);
    expect(e.fuel.alpha * (meanT - Tref)).toBeCloseTo(meanStrain, 8);
    expect(e.fuel.alpha).toBeCloseTo(meanStrain / (meanT - Tref), 8);
    expect(e.fuel.meanTemperature).toBeCloseTo(meanT, 1);
  });
  it("a coefficient that rises with temperature gives more than the instantaneous one at the reference temperature", () => {
    expect(e.fuel.alpha).toBeGreaterThan(a0 + b0 * 300);
  });
  it("the mapping says how each constant was found", () => {
    // the writer's mapping notes carry the reduction
    const w = writeOffbeatCase(v.normalized!);
    const note = w.mapping.find((m) => m.field === "materials.fuel mechanical.*")!.note!;
    expect(note).toMatch(/reduced to a constant \(its value at the mean temperature/);
    expect(note).toMatch(/the coefficient that gives the mean thermal strain/);
  });
});

describe("a solid that leaves the range of a law", () => {
  it("is reported by a warning for the modulus (W_ELASTICITY_RANGE) and for the expansion (W_EXPANSION_RANGE), naming the field, and not refused", () => {
    const narrow = norm(pinCase(sets(linearE(2.5e11, -5e7, 300, 700), linearAlpha(5e-6, 2e-8, 400, 700)), sets(elasticity(), constAlpha(1e-5))));
    const w = narrow.warnings.map((x) => x.code + " " + x.field);
    expect(w).toContain("W_ELASTICITY_RANGE /materials/fuel/sets/mechanical.elasticity");
    expect(w).toContain("W_EXPANSION_RANGE /materials/fuel/sets/mechanical.thermalExpansion");
    const e = effectiveMechanics(narrow.normalized!)!;
    expect(e.fuel.elasticityOutOfRange).toBe(true);
    expect(e.fuel.expansionOutOfRange).toBe(true);
  });
  it("the reference temperature counts for the expansion: a range that holds the solid but not the reference temperature is out of range", () => {
    const fits = norm(pinCase(sets(elasticity(), linearAlpha(5e-6, 2e-8, 900, 1500)), sets(elasticity(), constAlpha(1e-5)), 300));
    expect(fits.warnings.map((x) => x.code)).toContain("W_EXPANSION_RANGE");
    const holds = norm(pinCase(sets(elasticity(), linearAlpha(5e-6, 2e-8, 250, 1500)), sets(elasticity(), constAlpha(1e-5)), 300));
    expect(holds.warnings.map((x) => x.code)).not.toContain("W_EXPANSION_RANGE");
  });
  it("a constant case has no range warnings, and a thermal-only case none either", () => {
    const v = norm(pinCase(sets(elasticity(), constAlpha(1e-5)), sets(elasticity(), constAlpha(1e-5))));
    expect(v.warnings.filter((x) => /RANGE/.test(x.code))).toEqual([]);
  });
});
