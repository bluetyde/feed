// What the non-convergence probe showed about OFFBEAT (F0 exit review, finding 2), kept as a test of the saved evidence
// (solver/results/nonconvergence-probe.json, from solver/probe-nonconvergence.sh run in the feed-solver distro). Runs without the solver.
//
// The facts a run classifier must not get wrong: when OFFBEAT's outer loop reaches its cap without meeting the thermal criterion, the
// step is still accepted and written, nothing in the log or the exit code says so, and the written field can be several kelvin off.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ev = JSON.parse(readFileSync(join(__dirname, "..", "solver", "results", "nonconvergence-probe.json"), "utf8"));
const tol = ev.tolerances as { T: number; relT: number; absErrT: number };

/** OFFBEAT's thermal criterion as read from offbeatLib/physicsSubSolvers/thermalSubSolver/thermalSubSolver.C (converged()). */
function offbeatSaysConverged(last: { initialResidualT: number; relResidualT: number; absErrT: number }): boolean {
  if (!(last.absErrT > tol.absErrT)) return true;
  return (last.initialResidualT < tol.T && last.relResidualT < tol.relT) || last.initialResidualT < tol.T / 10 || last.relResidualT < tol.relT / 10;
}

describe("the non-convergence probe (saved evidence)", () => {
  const u = ev.unconverged;
  const c = ev.converged;

  it("the capped run ended its time step unconverged by OFFBEAT's own criterion; the reference converged", () => {
    expect(u.outerIterations).toBe(2); // the loop's minimum, equal to the cap
    expect(offbeatSaysConverged(u.lastIteration)).toBe(false);
    expect(u.lastIteration.absErrT).toBeGreaterThan(10); // K: far from the criterion
    expect(u.lastIteration.relResidualT).toBeGreaterThan(1e4 * tol.relT);
    expect(offbeatSaysConverged(c.lastIteration)).toBe(true);
    expect(c.outerIterations).toBeLessThan(c.maxOuterIter);
  });

  it("OFFBEAT still wrote the field and exited exactly as it does for a converged run: nothing flags the step", () => {
    for (const run of [u, c]) {
      expect(run.exitCode).toBe(139); // the known shutdown crash, after the final write
      expect(run.timeDirs).toEqual(["0", "1"]);
      expect(run.fatalErrorInLog).toBe(false);
      expect(run.warningAboutIterationLimit).toBe(false);
      expect(run.endLinePrinted).toBe(false);
    }
    expect(u.exitCode).toBe(c.exitCode);
  });

  it("the unconverged field is wrong by kelvin, so 'the final time was written and the fields are finite' cannot mean 'a result'", () => {
    expect(u.result.time).toBe(c.result.time);
    expect(u.result.nCells).toBe(c.result.nCells);
    expect(u.result.T.every(Number.isFinite)).toBe(true);
    const diffs = u.result.T.map((t: number, i: number) => Math.abs(t - c.result.T[i]));
    expect(Math.max(...diffs)).toBeGreaterThan(6); // K (6.54 observed, at r = 3.9 mm)
    expect(Math.abs(u.result.cladOuterWallT - c.result.cladOuterWallT)).toBeGreaterThan(0.5); // K
  });

  it("the loop's rule, as recorded: at least two iterations, silent exit at the cap", () => {
    expect(ev.offbeatLoop.meaning).toMatch(/At least two outer iterations/);
    expect(ev.offbeatLoop.meaning).toMatch(/no warning, no failure/);
  });

  it("a tolerance of 0 cannot force non-convergence (absErrT of exactly 0 counts as converged), so the probe caps the iterations instead", () => {
    expect(offbeatSaysConverged({ initialResidualT: 0, relResidualT: 0, absErrT: 0 })).toBe(true);
    expect(ev.other["T and relT set to 0 with maxOuterIter 5"]).toMatch(/no effect/);
  });

  it("the case writer leaves OFFBEAT's cap at 1000 and sets no absErrT, so a step that fails to converge would run 1000 iterations and then be accepted", () => {
    const w = readFileSync(join(__dirname, "..", "src", "core", "caseWriter.ts"), "utf8");
    expect(w).toMatch(/maxOuterIter\s+1000;/);
    expect(w).not.toMatch(/absErrT/);
    expect(ev.tolerances.maxOuterIterDefault).toBe(1000);
  });
});
