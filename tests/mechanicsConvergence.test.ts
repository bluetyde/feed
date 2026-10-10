// The displacement convergence criterion (src/core/convergence.ts, docs/plans/09-mechanics.md M2): OFFBEAT's mechanicsSubSolver::converged, read from the log of a real elastic run
// (tests/golden/offbeat-mechanics/log.tail: the last three time steps) and from the fvSolution the writer makes. OFFBEAT accepts a step that did not converge, silently; a result
// of FEED's must not.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { judgeMechanicsConvergence, mechanicsConverged, parseMechanicsSteps, readMechanicsCriterion } from "../src/core/convergence";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const log = readFileSync(join(root, "tests/golden/offbeat-mechanics/log.tail"), "utf8");
const q = (value: number, unit: string) => ({ value, unit });
const fvSolution = (() => {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  const sets = { "mechanical.elasticity": { model: "constant", youngModulus: q(200, "GPa"), poissonRatio: q(0.3, "1"), source: "a test" }, "mechanical.thermalExpansion": { linearExpansion: q(10, "ppm/K"), source: "a test" } };
  Object.assign(d.materials.fuel.sets, sets);
  Object.assign(d.materials.cladding.sets, sets);
  d.assumptions.thermalOnly = false;
  d.mechanics = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0, "Pa") };
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return writeOffbeatCase(v.normalized!).files["system/fvSolution"]!;
})();
const criterion = () => {
  const c = readMechanicsCriterion(fvSolution);
  if (!c.ok) throw new Error(c.message);
  return c.criterion;
};
const step = (res: [number, number, number], rel: number, abs: number) => ({ residual: res, relResidual: rel, absErr: abs });

describe("the criterion the writer's fvSolution gives", () => {
  it("D (1e-5 1 1e-5), relD 1e-6, absErrD 0 and the relative criterion on", () => {
    expect(criterion()).toEqual({ D: [1e-5, 1, 1e-5], relD: 1e-6, absErrD: 0, useRelResD: true });
  });
  it("defaults when the file leaves them out: D 1e-6 each, absErrD 0, useRelResD on (relD is then required)", () => {
    expect(readMechanicsCriterion("stressAnalysis { maxOuterIter 5; relD 1e-3; }")).toEqual({ ok: true, criterion: { D: [1e-6, 1e-6, 1e-6], relD: 1e-3, absErrD: 0, useRelResD: true } });
    expect(readMechanicsCriterion("stressAnalysis { maxOuterIter 5; }")).toMatchObject({ ok: false, message: expect.stringMatching(/relD/) });
    expect(readMechanicsCriterion("stressAnalysis { useRelResD off; }")).toMatchObject({ ok: true });
  });
  it("refusals: no dictionary, not closed, a boolean that is not one, a tolerance that is not a number", () => {
    expect(readMechanicsCriterion("solvers { }")).toMatchObject({ ok: false, message: expect.stringMatching(/no stressAnalysis/) });
    expect(readMechanicsCriterion("stressAnalysis { relD 1e-6;")).toMatchObject({ ok: false, message: expect.stringMatching(/not closed/) });
    expect(readMechanicsCriterion("stressAnalysis { useRelResD maybe; relD 1e-6; }")).toMatchObject({ ok: false, message: expect.stringMatching(/not a boolean/) });
    expect(readMechanicsCriterion("stressAnalysis { relD 1e-6; absErrD abc; }")).toMatchObject({ ok: false, message: expect.stringMatching(/not a number/) });
  });
});

describe("OFFBEAT's displacement criterion", () => {
  const c = () => criterion();
  it("converged when the residual is below the tolerance and the relative one below relD", () => {
    expect(mechanicsConverged(step([9e-6, 0, 9e-6], 9e-7, 1e-9), c())).toBe(true);
  });
  it("converged when the residual is ten times below its tolerance, whatever the relative one", () => {
    expect(mechanicsConverged(step([9e-7, 0, 0], 0.5, 1e-9), c())).toBe(true);
    expect(mechanicsConverged(step([1.1e-6, 0, 0], 0.5, 1e-9), c())).toBe(false);
  });
  it("converged when the relative residual is ten times below relD, whatever the residual", () => {
    expect(mechanicsConverged(step([1, 0, 1], 9e-8, 1e-9), c())).toBe(true);
    expect(mechanicsConverged(step([1, 0, 1], 1.1e-7, 1e-9), c())).toBe(false);
  });
  it("not converged when the residual is below the tolerance but the relative one is not (and neither is ten times below)", () => {
    expect(mechanicsConverged(step([5e-6, 0, 0], 0.5, 1e-9), c())).toBe(false);
  });
  it("every component is compared with its own tolerance, the middle one (y) with 1 (and a tenth of it for the ten-times rule); the axial one with 1e-5", () => {
    expect(mechanicsConverged(step([9e-7, 0.05, 9e-7], 0.5, 1e-9), c())).toBe(true);
    expect(mechanicsConverged(step([9e-7, 0.5, 9e-7], 0.5, 1e-9), c())).toBe(false);
    expect(mechanicsConverged(step([9e-7, 0, 2e-5], 0.5, 1e-9), c())).toBe(false);
  });
  it("converged when the absolute error is not above its tolerance", () => {
    expect(mechanicsConverged(step([1, 1, 1], 1, 0), c())).toBe(true);
    expect(mechanicsConverged(step([1, 1, 1], 1, 1e-9), { ...c(), absErrD: 1e-8 })).toBe(true);
    expect(mechanicsConverged(step([1, 1, 1], 1, 1e-7), { ...c(), absErrD: 1e-8 })).toBe(false);
  });
  it("with useRelResD off only the residual counts", () => {
    const off = { ...c(), useRelResD: false };
    expect(mechanicsConverged(step([9e-6, 0, 0], 100, 1e-9), off)).toBe(true);
    expect(mechanicsConverged(step([2e-5, 0, 0], 1e-12, 1e-9), off)).toBe(false);
  });
  it("a value that is not a finite number is never converged", () => {
    expect(mechanicsConverged(step([NaN, 0, 0], 0, 1e-9), c())).toBe(false);
    expect(mechanicsConverged(step([1e-9, 0, 0], NaN, 1e-9), c())).toBe(false);
    expect(mechanicsConverged(step([1e-9, 0, 0], 0, Infinity), c())).toBe(false);
  });
});

describe("the log of a real elastic run", () => {
  it("has three steps, the last with two outer iterations, and the residuals of the last iteration are the ones OFFBEAT printed", () => {
    const steps = parseMechanicsSteps(log);
    expect(steps).toHaveLength(3);
    const last = steps[2]!;
    expect(last.iterations).toBe(2);
    expect(last.last).toEqual({ residual: [3.1878929e-7, 0, 0], relResidual: 0.49823524, absErr: 2.1319853e-12 });
  });
  it("is judged converged", () => {
    expect(judgeMechanicsConvergence(log, criterion())).toEqual({ ok: true, stepsChecked: 1, iterationsInLastStep: 2 });
  });
  it("is judged not converged when the residual of the last iteration is put above the tolerance", () => {
    const damaged = log.replace("Initial residual = 3.1878929e-07", "Initial residual = 3.1878929e-04");
    const v = judgeMechanicsConvergence(damaged, criterion());
    expect(v).toMatchObject({ ok: false, code: "E_NOT_CONVERGED" });
    expect((v as { message: string }).message).toMatch(/displacement did not converge at t = 50000000/);
    expect((v as { message: string }).message).toMatch(/accepts and writes such a step without a warning/);
  });
  it("only the final step counts: a bad first iteration of the last step does not matter if the last iteration is good, and a bad earlier step is not looked at", () => {
    const iterBad = log.replace("Initial residual = 3.2104381e-07", "Initial residual = 1.0");
    expect(judgeMechanicsConvergence(iterBad, criterion()).ok).toBe(true);
    const firstStepBad = log.replace(/Initial residual = [\d.e+-]+, Final residual = [\d.e+-]+, No Iterations \d+\nrelResidualD/, "Initial residual = 5, Final residual = 1, No Iterations 9\nrelResidualD");
    expect(judgeMechanicsConvergence(firstStepBad, criterion()).ok).toBe(true);
  });
  it("a final step without its relResidualD or absErrD line, or without a displacement solve, cannot be judged", () => {
    const noRel = log.replace(/relResidualD is 0\.49823524\n/, "");
    expect(judgeMechanicsConvergence(noRel, criterion())).toMatchObject({ ok: false, code: "E_OUTPUT_INCOMPLETE" });
    const noAbs = log.replace(/absErrD is 2\.1319853e-12\n/, "");
    expect(judgeMechanicsConvergence(noAbs, criterion())).toMatchObject({ ok: false, code: "E_OUTPUT_INCOMPLETE" });
    const noSolve = log.replace(/FDICPCG:\s+Solving for Dx, Initial residual = 3\.1878929e-07[^\n]*\n/, "");
    expect(judgeMechanicsConvergence(noSolve, criterion())).toMatchObject({ ok: false, code: "E_OUTPUT_INCOMPLETE" });
  });
  it("a log with no steps cannot be judged", () => {
    expect(judgeMechanicsConvergence("nothing here\n", criterion())).toMatchObject({ ok: false, code: "E_OUTPUT_INCOMPLETE" });
    expect(judgeMechanicsConvergence("Time = 5 seconds\n\n", criterion())).toMatchObject({ ok: false, code: "E_OUTPUT_INCOMPLETE" });
  });
  it("the components of D are read separately: a Dz solve in the same iteration gives the axial residual, and the first solve of each component is the one kept", () => {
    const text = [
      "Time = 1 seconds", "", "OuterIteration n. 0",
      "FDICPCG:  Solving for Dx, Initial residual = 2e-06, Final residual = 1e-20, No Iterations 1",
      "FDICPCG:  Solving for Dx, Initial residual = 9, Final residual = 1e-20, No Iterations 1",
      "FDICPCG:  Solving for Dz, Initial residual = 3e-06, Final residual = 1e-20, No Iterations 1",
      "relResidualD is 0.1", "absErrD is 1e-9", "",
    ].join("\n");
    const s = parseMechanicsSteps(text);
    expect(s[0]!.last).toEqual({ residual: [2e-6, 0, 3e-6], relResidual: 0.1, absErr: 1e-9 });
  });
});
