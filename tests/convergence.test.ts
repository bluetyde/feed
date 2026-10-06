// The convergence predicate (src/core/convergence.ts) on REAL OFFBEAT logs from the non-convergence probe
// (tests/golden/offbeat-convergence/*, produced in the feed-solver distro; see docs/spike/F0-note.md), and on edited copies of them.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ConvergenceCriterion, judgeConvergence, parseSteps, readCriterion, thermalConverged } from "../src/core/convergence";

const dir = join(__dirname, "golden", "offbeat-convergence");
const log = (n: string) => readFileSync(join(dir, n + ".log.txt"), "utf8");
const fv = (n: string) => `solvers {}\n${readFileSync(join(dir, n + ".stressAnalysis.txt"), "utf8")}\nrelaxationFactors {}\n`;
const crit = (n: string): ConvergenceCriterion => {
  const r = readCriterion(fv(n));
  if (!r.ok) throw new Error(r.message);
  return r.criterion;
};
const base: ConvergenceCriterion = { maxOuterIter: 1000, T: 1e-5, relT: 1e-6, absErrT: 0, useRelResT: true };

describe("reading the criterion from system/fvSolution", () => {
  it("reads maxOuterIter, T, relT from the stressAnalysis dictionary, with absErrT 0 and useRelResT on by default", () => {
    expect(crit("converged-1s")).toEqual(base);
    expect(crit("capped-unconverged").maxOuterIter).toBe(2);
  });
  it("is not fooled by a nested dictionary with the same key names", () => {
    const text = "stressAnalysis { nCorrectors { T 99; relT 99; maxOuterIter 99; } maxOuterIter 7; T 1e-4; relT 1e-3; }";
    expect(readCriterion(text)).toEqual({ ok: true, criterion: { maxOuterIter: 7, T: 1e-4, relT: 1e-3, absErrT: 0, useRelResT: true } });
  });
  it("reads absErrT and useRelResT when given; without the relative residual only the initial residual counts and relT is not needed", () => {
    const r = readCriterion("stressAnalysis { maxOuterIter 5; T 1e-5; absErrT 1e-3; useRelResT off; }");
    expect(r).toEqual({ ok: true, criterion: { maxOuterIter: 5, T: 1e-5, relT: NaN, absErrT: 1e-3, useRelResT: false } });
  });
  it.each([
    ["no stressAnalysis dictionary", "solvers { }"],
    ["an unclosed dictionary", "stressAnalysis { maxOuterIter 5; relT 1e-6;"],
    ["no maxOuterIter", "stressAnalysis { T 1e-5; relT 1e-6; }"],
    ["a maxOuterIter that is not a whole number", "stressAnalysis { maxOuterIter 2.5; relT 1e-6; }"],
    ["a maxOuterIter of zero", "stressAnalysis { maxOuterIter 0; relT 1e-6; }"],
    ["no relT while the relative residual is used", "stressAnalysis { maxOuterIter 5; T 1e-5; }"],
    ["a tolerance that is not a number", "stressAnalysis { maxOuterIter 5; T abc; relT 1e-6; }"],
    ["a useRelResT that is not a boolean", "stressAnalysis { maxOuterIter 5; relT 1e-6; useRelResT maybe; }"],
  ])("refuses %s", (_n, text) => expect(readCriterion(text).ok).toBe(false));
});

describe("OFFBEAT's thermal criterion", () => {
  const r = (initialResidual: number, relResidual: number, absErr: number) => ({ initialResidual, relResidual, absErr });
  it("absErrT at or below its tolerance (default 0) counts as converged, whatever the residuals", () => {
    expect(thermalConverged(r(1, 1, 0), base)).toBe(true);
    expect(thermalConverged(r(1, 1, 1e-4), { ...base, absErrT: 1e-3 })).toBe(true);
  });
  it("otherwise both residuals under their thresholds, or either one a factor of 10 under", () => {
    expect(thermalConverged(r(9e-6, 9e-7, 1), base)).toBe(true);
    expect(thermalConverged(r(2e-5, 9e-7, 1), base)).toBe(false); // initial residual too large
    expect(thermalConverged(r(9e-6, 2e-6, 1), base)).toBe(false); // relative residual too large
    expect(thermalConverged(r(9e-7, 1, 1), base)).toBe(true); // initial residual below T/10
    expect(thermalConverged(r(1, 9e-8, 1), base)).toBe(true); // relative residual below relT/10
    expect(thermalConverged(r(1e-5, 1e-6, 1), base)).toBe(false); // exactly at the thresholds is not under them
  });
  it("without the relative residual only the initial residual counts", () => {
    const c = { ...base, useRelResT: false, relT: NaN };
    expect(thermalConverged(r(9e-6, 1, 1), c)).toBe(true);
    expect(thermalConverged(r(2e-5, 1e-12, 1), c)).toBe(false);
  });
  it("a value that is not finite is never converged, even though OFFBEAT's own comparison would call NaN converged", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(thermalConverged(r(bad, 0, 0), base)).toBe(false);
      expect(thermalConverged(r(0, bad, 0), base)).toBe(false);
      expect(thermalConverged(r(0, 0, bad), base)).toBe(false);
    }
    expect(NaN > 0).toBe(false); // OFFBEAT's `absErr > tolerance` with NaN: false, so it would take the "converged" branch
  });
});

describe("parsing real OFFBEAT logs", () => {
  it("a converged 1 s step: 6 outer iterations ending at the tiny residuals OFFBEAT printed", () => {
    const s = parseSteps(log("converged-1s"));
    expect(s).toHaveLength(1);
    expect(s[0]!.time).toBe(1);
    expect(s[0]!.iterations).toBe(6);
    expect(s[0]!.last).toEqual({ initialResidual: 5.2826e-10, relResidual: 2.94549e-10, absErr: 8.45091e-8 });
  });
  it("the capped step: 2 iterations, ending at absErrT 11.1641 K and relResidualT 0.039029", () => {
    const s = parseSteps(log("capped-unconverged"));
    expect(s).toHaveLength(1);
    expect(s[0]!.iterations).toBe(2);
    expect(s[0]!.last).toEqual({ initialResidual: 0.0463355, relResidual: 0.039029, absErr: 11.1641 });
  });
  it("a whole run: one record per time step, each with its own iteration count (84 steps, 168 iterations at a cap of 1)", () => {
    const s = parseSteps(log("capped-1-full-run"));
    expect(s).toHaveLength(84);
    expect(s.reduce((n, x) => n + x.iterations, 0)).toBe(168);
    expect(s.every((x) => x.iterations === 2 && x.last !== undefined)).toBe(true);
  });
  it("'Execution Time =' lines are not time steps", () => {
    expect(parseSteps("Execution Time = 0.05 s  Clock Time = 0 s\nTime = 3 s\nOuterIteration n. 0\nFDICPCG:  Solving for T, Initial residual = 1e-3, Final residual = 1e-6, No Iterations 2\nrelResidualT is 1\nabsErrT is 2\n")).toEqual([
      { time: 3, iterations: 1, last: { initialResidual: 1e-3, relResidual: 1, absErr: 2 } },
    ]);
  });
  it("with several T solves in one outer iteration the first initial residual and the last relative and absolute numbers are used (as OFFBEAT keeps them)", () => {
    const text = [
      "Time = 1 s",
      "OuterIteration n. 0",
      "Solving for T, Initial residual = 0.5, Final residual = 0.1, No Iterations 2",
      "relResidualT is 0.9",
      "absErrT is 9",
      "Solving for T, Initial residual = 1e-9, Final residual = 1e-12, No Iterations 1",
      "relResidualT is 1e-9",
      "absErrT is 1e-9",
    ].join("\n");
    expect(parseSteps(text)[0]!.last).toEqual({ initialResidual: 0.5, relResidual: 1e-9, absErr: 1e-9 });
  });
});

describe("judging a run", () => {
  it("the converged reference passes, steady or transient", () => {
    expect(judgeConvergence(log("converged-1s"), crit("converged-1s"), "final-step")).toEqual({ ok: true, stepsChecked: 1, iterationsInLastStep: 6 });
    expect(judgeConvergence(log("converged-1s"), crit("converged-1s"), "every-step").ok).toBe(true);
  });

  it("THE PROBE CASE: a step that hit the cap unconverged is refused, with the numbers in the message", () => {
    const v = judgeConvergence(log("capped-unconverged"), crit("capped-unconverged"), "final-step");
    expect(v).toMatchObject({ ok: false, code: "E_NOT_CONVERGED" });
    const m = (v as { message: string }).message;
    expect(m).toMatch(/t = 1/);
    expect(m).toMatch(/2 outer iterations \(limit 2\)/);
    expect(m).toMatch(/absErrT 11\.1641/);
    expect(m).toMatch(/relResidualT 0\.039029/);
    expect(m).toMatch(/without a warning/);
  });

  it("a steady run is judged on its FINAL step: early unconverged steps that later converge are fine; a transient run needs every step", () => {
    const l = log("capped-1-full-run");
    const c = crit("capped-1-full-run");
    expect(judgeConvergence(l, c, "final-step")).toMatchObject({ ok: true, iterationsInLastStep: 2 });
    const every = judgeConvergence(l, c, "every-step");
    expect(every).toMatchObject({ ok: false, code: "E_NOT_CONVERGED" });
  });

  it("the tolerances come from the case, not from the code: the same converged log fails a far stricter criterion and passes a looser absErrT", () => {
    const l = log("converged-1s"); // last iteration: initial residual 5.3e-10, relResidualT 2.9e-10, absErrT 8.5e-8
    expect(judgeConvergence(l, { ...base, T: 1e-30, relT: 1e-30 }, "final-step")).toMatchObject({ ok: false, code: "E_NOT_CONVERGED" });
    expect(judgeConvergence(l, { ...base, T: 1e-30, relT: 1e-30, absErrT: 1e-6 }, "final-step").ok).toBe(true); // 8.5e-8 <= 1e-6
  });

  it("a log with no outer-iteration records, or a last iteration missing a number, cannot be judged and is refused", () => {
    expect(judgeConvergence("", base, "final-step")).toMatchObject({ ok: false, code: "E_OUTPUT_INCOMPLETE" });
    expect(judgeConvergence("Time = 1 s\n", base, "final-step")).toMatchObject({ ok: false, code: "E_OUTPUT_INCOMPLETE" });
    const cut = log("converged-1s").split("\n").filter((l) => !l.startsWith("absErrT is")).join("\n");
    expect(judgeConvergence(cut, base, "final-step")).toMatchObject({ ok: false, code: "E_OUTPUT_INCOMPLETE" });
  });

  it("a final step whose last iteration printed a NaN is refused", () => {
    const nan = log("converged-1s").replace(/absErrT is 8\.45091e-08/, "absErrT is nan");
    expect(nan).not.toBe(log("converged-1s"));
    expect(judgeConvergence(nan, base, "final-step")).toMatchObject({ ok: false, code: "E_NOT_CONVERGED" });
  });

  it("a run killed in the middle of a step (a Time line after the last complete iteration, no numbers yet) is refused as incomplete", () => {
    const text = log("converged-1s") + "\nTime = 2 s\n\nOuterIteration n. 0\n";
    expect(judgeConvergence(text, base, "final-step")).toMatchObject({ ok: false, code: "E_OUTPUT_INCOMPLETE" });
  });
});
