// What the writer gives OFFBEAT for a mechanics case (docs/plans/09-mechanics.md M2): the solver, the rheology options, the constants of each material, the pressure on the
// cladding, the penalty factor and the relaxation; and that a case without mechanics is written exactly as it was (the thermal files are compared with those of the same case
// with the mechanics section taken out and thermalOnly true, which is the unchanged path).
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const sets = (E: number, nu: number, alpha: number) => ({
  "mechanical.elasticity": { model: "constant", youngModulus: q(E, "Pa"), poissonRatio: q(nu, "1"), source: "a test" },
  "mechanical.thermalExpansion": { linearExpansion: q(alpha, "1/K"), source: "a test" },
});
function mechCase(over: { plane?: string; penalty?: number; pressure?: [number, string]; Tref?: number; fuel?: [number, number, number]; cladding?: [number, number, number] } = {}) {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.assumptions.thermalOnly = false;
  Object.assign(d.materials.fuel.sets, sets(...(over.fuel ?? [2e11, 0.3, 1e-5])));
  Object.assign(d.materials.cladding.sets, sets(...(over.cladding ?? [1.9e11, 0.3, 17e-6])));
  d.mechanics = { referenceTemperature: q(over.Tref ?? 300, "K"), plane: over.plane ?? "free-axial", contact: { penaltyFactor: q(over.penalty ?? 0.5, "1") }, coolantPressure: q(...(over.pressure ?? [1e5, "Pa"])) };
  return d;
}
const written = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return writeOffbeatCase(v.normalized!);
};
/** The text of one material block of the solverDict. */
const block = (dict: string, name: string) => new RegExp(`    ${name}\\n    \\{[\\s\\S]*?\\n    \\}`).exec(dict)![0];
const value = (text: string, key: string) => Number(new RegExp(`${key}\\s+${key}\\s+\\[[^\\]]*\\]\\s+([^;]+);`).exec(text)![1]);

describe("the solver dictionary of a mechanics case", () => {
  const w = written(mechCase());
  const dict = w.files["constant/solverDict"]!;
  it("runs the small-strain solver with thermal expansion on and plane stress off", () => {
    expect(dict).toMatch(/mechanicsSolver\s+smallStrain;/);
    expect(dict).toMatch(/rheologyOptions\s*\{[\s\S]*thermalExpansion on;[\s\S]*planeStress off;[\s\S]*\}/);
    expect(dict).toMatch(/mechanicsSolverOptions\s*\{[\s\S]*cylindricalStress on;/);
  });
  it("free-axial is modifiedPlaneStrain on, plane-strain is off", () => {
    expect(dict).toMatch(/modifiedPlaneStrain on;/);
    expect(written(mechCase({ plane: "plane-strain" })).files["constant/solverDict"]).toMatch(/modifiedPlaneStrain off;/);
  });
  it("each material carries the case's own constants: E, nu, G = E / (2 (1 + nu)), alpha and the reference temperature", () => {
    const fuel = block(dict, "fuel");
    const clad = block(dict, "cladding");
    expect(value(fuel, "E")).toBe(2e11);
    expect(value(fuel, "nu")).toBeCloseTo(0.3, 15);
    expect(value(fuel, "G")).toBeCloseTo(2e11 / 2.6, 0);
    expect(value(fuel, "alpha")).toBeCloseTo(1e-5, 15);
    expect(value(fuel, "Tref")).toBe(300);
    expect(value(clad, "E")).toBe(1.9e11);
    expect(value(clad, "alpha")).toBeCloseTo(17e-6, 15);
    expect(value(clad, "G")).toBeCloseTo(1.9e11 / 2.6, 0);
  });
  it("the reference temperature is the case's (and a different one is written)", () => {
    const d = written(mechCase({ Tref: 350 })).files["constant/solverDict"]!;
    expect(value(block(d, "fuel"), "Tref")).toBe(350);
    expect(value(block(d, "cladding"), "Tref")).toBe(350);
  });
  it("the placeholders of a thermal case (E 2e11, Tref 300, ...) are not in a mechanics case's mapping, and the mapping names the mechanics fields", () => {
    expect(w.placeholders.map((p) => p.name).join(" ")).not.toMatch(/\bE\b/);
    const fields = w.mapping.map((m) => m.field);
    for (const f of ["mechanics", "mechanics.referenceTemperature", "materials.fuel mechanical.*", "materials.cladding mechanical.*", "mechanics.contact.penaltyFactor", "mechanics.coolantPressure"]) expect(fields).toContain(f);
  });
});

describe("the displacement field of a mechanics case", () => {
  it("the cladding's outside carries the coolant pressure and no traction, and the contact condition the penalty factor", () => {
    const d = written(mechCase({ penalty: 0.4, pressure: [2, "MPa"] })).files["0/D"]!;
    const clad = /cladOuter\s*\{([\s\S]*?)\n    \}/.exec(d)![1]!;
    expect(clad).toMatch(/type\s+tractionDisplacement;/);
    expect(clad).toMatch(/traction\s+uniform \(0 0 0\);/);
    expect(clad).toMatch(/pressure\s+uniform 2000000;/);
    expect(d).toMatch(/penaltyFactor\s+0\.4;/);
    expect(d).not.toMatch(/penaltyFactor\s+0\.1;/);
  });
  it("a pressure of 0 is written as 0", () => {
    expect(written(mechCase({ pressure: [0, "Pa"] })).files["0/D"]).toMatch(/pressure\s+uniform 0;/);
  });
});

describe("the solution settings", () => {
  it("the displacement is under-relaxed by 0.5 with mechanics and 0.8 without", () => {
    expect(written(mechCase()).files["system/fvSolution"]).toMatch(/fields \{ D 0\.5; \}/);
    const thermal = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
    expect(written(thermal).files["system/fvSolution"]).toMatch(/fields \{ D 0\.8; \}/);
  });
});

describe("a case without mechanics is written as it was", () => {
  const thermal = written(JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8")));
  it("the old solver setting, the old fixed outer displacement and the old penalty factor", () => {
    expect(thermal.files["constant/solverDict"]).toMatch(/mechanicsSolver\s+fromLatestTime;/);
    expect(thermal.files["constant/solverDict"]).not.toMatch(/rheologyOptions/);
    expect(thermal.files["0/D"]).toMatch(/cladOuter\s*\{\s*type\s+fixedValue;/);
    expect(thermal.files["0/D"]).toMatch(/penaltyFactor\s+0\.1;/);
    expect(thermal.mapping.map((m) => m.field)).not.toContain("mechanics");
  });
  it("the mechanical constants are the placeholders, listed as such", () => {
    expect(value(block(thermal.files["constant/solverDict"]!, "fuel"), "E")).toBe(2e11);
    expect(thermal.placeholders.map((p) => p.name).join(" ")).toMatch(/E, nu, G, alpha, Tref/);
  });
  it("the thermal files of a mechanics case differ from the thermal case's only where mechanics is asked for (blockMeshDict, controlDict, 0/T are identical)", () => {
    const m = written(mechCase());
    for (const f of ["system/blockMeshDict", "system/controlDict", "system/fvSchemes", "0/T"]) expect(m.files[f], f).toBe(thermal.files[f]);
  });
});
