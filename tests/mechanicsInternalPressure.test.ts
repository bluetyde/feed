// The gas pressure in the gap (docs/plans/09-mechanics.md M4): the case input and its refusals, the pressure FEED works out for the hydrogen model, what the writer gives OFFBEAT
// (the tabulated gap gas model with a constant pressure, and nothing at all for a case without one), and the independent solution with the gas on both surfaces.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { hydrogenPressure } from "../src/core/hydrogenPressure";
import { effectiveMechanics } from "../src/core/mechanicalEval";
import { quickLook } from "../src/core/quickLook";
import { SolidSetup, independentSolution, solveSlice } from "../src/core/thermoElastic";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const sets = (E: number, nu: number, alpha: number) => ({
  "mechanical.elasticity": { model: "constant", youngModulus: q(E, "Pa"), poissonRatio: q(nu, "1"), source: "a test" },
  "mechanical.thermalExpansion": { linearExpansion: q(alpha, "1/K"), source: "a test" },
});
function pinCase(internalPressure?: unknown) {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.assumptions.thermalOnly = false;
  Object.assign(d.materials.fuel.sets, sets(2e11, 0.3, 1e-5));
  Object.assign(d.materials.cladding.sets, sets(1.9e11, 0.3, 17e-6));
  d.mechanics = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0.1, "MPa") };
  if (internalPressure !== undefined) d.mechanics.internalPressure = internalPressure;
  return d;
}
const constant = (p: number, unit = "MPa") => ({ model: "constant", pressure: q(p, unit), source: "a test" });
const hydrogen = (X: number, basis: string) => ({ model: "hydrogen-zrh", hZrRatio: q(X, "1"), fuelTemperature: basis, source: "Simnad GA E-117-833 section 2.4" });
const errors = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);

describe("the internalPressure input", () => {
  it("a constant pressure in any pressure unit and the hydrogen model are accepted", () => {
    expect(errors(pinCase(constant(5)))).toEqual([]);
    expect(errors(pinCase(constant(725, "psi")))).toEqual([]);
    expect(validateCase(pinCase(constant(725, "psi"))).normalized!.mechanics!.internalPressure).toMatchObject({ kind: "constant" });
    expect(errors(pinCase(hydrogen(1.65, "peak")))).toEqual([]);
    expect(validateCase(pinCase(hydrogen(1.6, "mean"))).normalized!.mechanics!.internalPressure).toEqual({ kind: "hydrogen-zrh", hZrRatio: 1.6, basis: "mean", source: "Simnad GA E-117-833 section 2.4" });
  });
  it("a case without it has none", () => {
    expect(validateCase(pinCase()).normalized!.mechanics!.internalPressure).toBeUndefined();
  });
  it("is refused when it has no source, a zero or too large pressure, an unknown model or key, a wrong ratio, or no temperature basis", () => {
    expect(errors(pinCase({ ...constant(5), source: undefined }))).toContain("E_PROP_MISSING /mechanics/internalPressure/source");
    expect(errors(pinCase({ ...constant(5), source: "  " }))).toContain("E_PROP_MISSING /mechanics/internalPressure/source");
    expect(errors(pinCase(constant(0)))).toContain("E_OUT_OF_RANGE /mechanics/internalPressure/pressure");
    expect(errors(pinCase(constant(2e9, "Pa")))).toContain("E_OUT_OF_RANGE /mechanics/internalPressure/pressure");
    expect(errors(pinCase({ model: "constant", source: "x" }))).toContain("E_PROP_MISSING /mechanics/internalPressure/pressure");
    expect(errors(pinCase({ model: "plenum", source: "x" }))).toContain("E_UNSUPPORTED /mechanics/internalPressure/model");
    expect(errors(pinCase({ ...constant(5), extra: 1 }))).toContain("E_SCHEMA_INVALID /mechanics/internalPressure/extra");
    expect(errors(pinCase({ ...hydrogen(1.65, "peak"), pressure: q(1, "MPa") }))).toContain("E_SCHEMA_INVALID /mechanics/internalPressure/pressure");
    expect(errors(pinCase(hydrogen(1.4, "peak")))).toContain("E_OUT_OF_RANGE /mechanics/internalPressure/hZrRatio");
    expect(errors(pinCase(hydrogen(1.9, "peak")))).toContain("E_OUT_OF_RANGE /mechanics/internalPressure/hZrRatio");
    expect(errors(pinCase({ ...hydrogen(1.65, "peak"), hZrRatio: undefined }))).toContain("E_PROP_MISSING /mechanics/internalPressure/hZrRatio");
    expect(errors(pinCase({ ...hydrogen(1.65, "peak"), fuelTemperature: undefined }))).toContain("E_PROP_MISSING /mechanics/internalPressure/fuelTemperature");
    expect(errors(pinCase(hydrogen(1.65, "centre")))).toContain("E_UNSUPPORTED /mechanics/internalPressure/fuelTemperature");
    expect(errors(pinCase("5 MPa"))).toContain("E_SCHEMA_INVALID /mechanics/internalPressure");
  });
  it("a refused pressure stops the whole mechanics section (no half-read case)", () => {
    expect(validateCase(pinCase(constant(0))).normalized).toBeUndefined();
  });
});

describe("the pressure FEED works out", () => {
  it("a constant pressure is the stated one in Pa", () => {
    const n = validateCase(pinCase(constant(725, "psi"))).normalized!;
    expect(effectiveMechanics(n)!.internalPressure).toBeCloseTo(725 * 6894.757293168, 3);
    expect(effectiveMechanics(n)!.internalPressureNote).toMatch(/a stated pressure/);
  });
  it("no internal pressure is 0", () => {
    expect(effectiveMechanics(validateCase(pinCase()).normalized!)!.internalPressure).toBe(0);
  });
  it("the hydrogen model at the peak is the correlation at the closed-form centre temperature, and the mean is lower", () => {
    const peak = validateCase(pinCase(hydrogen(1.65, "peak"))).normalized!;
    const mean = validateCase(pinCase(hydrogen(1.65, "mean"))).normalized!;
    const centre = quickLook(peak).temperatures.centreT;
    const ep = effectiveMechanics(peak)!;
    expect(Math.abs(ep.internalPressure / hydrogenPressure(1.65, centre) - 1)).toBeLessThan(1e-9);
    expect(ep.internalPressureNote).toMatch(/peak temperature/);
    expect(effectiveMechanics(mean)!.internalPressure).toBeLessThan(ep.internalPressure);
    expect(effectiveMechanics(mean)!.internalPressureNote).toMatch(/area-mean temperature/);
  });
});

describe("what the writer gives OFFBEAT", () => {
  it("a case with a pressure gets the tabulated gap gas with that constant pressure and the state file", () => {
    const w = writeOffbeatCase(validateCase(pinCase(constant(5))).normalized!);
    const dict = w.files["constant/solverDict"]!;
    expect(dict).toMatch(/gapGas\s+timeTabulated;/);
    expect(dict).toMatch(/gapPressures \(5000000 5000000\);/);
    expect(dict).toMatch(/He \(1 1\);/);
    expect(dict).toMatch(/timePoints \(0 1e12\);/);
    const f = w.files["0/uniform/gapGas"]!;
    expect(f).toMatch(/gasPressure 5000000;/);
    expect(f).toMatch(/He 1;/);
    for (const s of ["Ar", "Kr", "Ne", "Rn", "Xe"]) expect(f).toMatch(new RegExp(s + " 0;"));
    expect(w.mapping.find((m) => m.field === "mechanics.internalPressure")!.note).toMatch(/gapGas timeTabulated.*5000000 Pa/);
  });
  it("a case without one is written as it was: no gap gas, no state file", () => {
    const w = writeOffbeatCase(validateCase(pinCase()).normalized!);
    expect(w.files["constant/solverDict"]).toMatch(/gapGas\s+none;/);
    expect(w.files["constant/solverDict"]).not.toMatch(/gapGasOptions/);
    expect(Object.keys(w.files).filter((f) => /gapGas/.test(f))).toEqual([]);
    expect(w.mapping.map((m) => m.field)).not.toContain("mechanics.internalPressure");
  });
  it("the thermal files do not depend on the pressure", () => {
    const a = writeOffbeatCase(validateCase(pinCase()).normalized!);
    const b = writeOffbeatCase(validateCase(pinCase(constant(5))).normalized!);
    for (const f of ["system/blockMeshDict", "system/controlDict", "system/fvSchemes", "0/T", "0/D"]) expect(b.files[f], f).toBe(a.files[f]);
  });
});

describe("the independent solution with a gas in the gap", () => {
  const solid = (a: number, b: number, E: number, nu: number, alpha: number, t: number): SolidSetup => ({ a, b, E, nu, alpha, theta: () => t });
  const Rf = 4.1e-3;
  const Rci = 4.18e-3;
  const Rco = 4.75e-3;
  it("an open gap: the fuel is pressed on by the gas (sigma_r = sigma_theta = -p) and the cladding is a Lame tube loaded inside", () => {
    const p = 5e6;
    const s = solveSlice(solid(0, Rf, 2e11, 0.3, 1e-5, 0), solid(Rci, Rco, 1.9e11, 0.3, 1e-5, 0), "plane-strain", 0, p);
    expect(s.contact).toBe(false);
    for (const r of [1e-3, 3e-3, Rf]) {
      const x = s.fuel.at(r);
      expect(Math.abs(x.sigmaR + p)).toBeLessThan(1e-6 * p);
      expect(Math.abs(x.sigmaTheta + p)).toBeLessThan(1e-6 * p);
    }
    const hoop = (r: number) => ((p * Rci * Rci) / (Rco * Rco - Rci * Rci)) * (1 + (Rco * Rco) / (r * r));
    for (const r of [Rci, 4.4e-3, Rco]) expect(Math.abs(s.cladding.at(r).sigmaTheta / hoop(r) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(s.cladding.at(Rci).sigmaR + p)).toBeLessThan(1e-6 * p);
  });
  it("a gas that is not there leaves the answer as it was, and a gas widens this gap (the tube swells more than the fuel is compressed)", () => {
    const f = solid(0, Rf, 2e11, 0.3, 1e-5, 0);
    const c = solid(Rci, Rco, 1.9e11, 0.3, 1e-5, 0);
    expect(solveSlice(f, c, "free-axial", 0, 0).gap).toBeCloseTo(Rci - Rf, 15);
    expect(solveSlice(f, c, "free-axial", 0, 5e6).gap).toBeGreaterThan(Rci - Rf);
  });
  it("in contact the total pressure at the interface does not depend on the gas: the contact pressure is that total minus the gas", () => {
    const f = solid(0, Rf, 1.8e11, 0.32, 4e-5, 300);
    const c = solid(4.12e-3, Rco, 2e11, 0.3, 1e-5, 0);
    const a = solveSlice(f, c, "plane-strain", 0, 0);
    const b = solveSlice(f, c, "plane-strain", 0, 5e6);
    expect(a.contact && b.contact).toBe(true);
    expect(Math.abs(b.contactPressure + 5e6 - a.contactPressure) / a.contactPressure).toBeLessThan(1e-9);
    expect(Math.abs(b.fuel.at(Rf).sigmaR + (b.contactPressure + 5e6)) / a.contactPressure).toBeLessThan(1e-9);
  });
  it("free-axial with a gas: the cladding carries the closed-end load p a^2 / (b^2 - a^2) and the fuel +p (OFFBEAT's axial balance, found on the real solver)", () => {
    const p = 5e6;
    const s = solveSlice(solid(0, Rf, 2e11, 0.3, 1e-5, 0), solid(Rci, Rco, 1.9e11, 0.3, 1e-5, 0), "free-axial", 0, p);
    const closedEnd = (p * Rci * Rci) / (Rco * Rco - Rci * Rci);
    for (const r of [Rci, 4.4e-3, Rco]) expect(Math.abs(s.cladding.at(r).sigmaZ / closedEnd - 1)).toBeLessThan(1e-9);
    for (const r of [1e-3, 3e-3, Rf]) expect(Math.abs(s.fuel.at(r).sigmaZ / p - 1)).toBeLessThan(1e-9);
    // plane strain has no such condition, and the coolant has no end load
    const free = solveSlice(solid(0, Rf, 2e11, 0.3, 1e-5, 0), solid(Rci, Rco, 1.9e11, 0.3, 1e-5, 0), "free-axial", 20e6, 0);
    expect(Math.abs(free.cladding.at(4.4e-3).sigmaZ)).toBeLessThan(1);
  });
  it("the gas pressure of the case reaches the independent solution through the properties", () => {
    const n = validateCase(pinCase(constant(5))).normalized!;
    const props = effectiveMechanics(n)!;
    const a = independentSolution(n, props, n.mechanics!);
    const b = independentSolution(n, { ...props, internalPressure: 0 }, n.mechanics!);
    expect(Math.abs(a.fuel.at(2e-3).sigmaR - b.fuel.at(2e-3).sigmaR + 5e6)).toBeLessThan(1);
  });
});
