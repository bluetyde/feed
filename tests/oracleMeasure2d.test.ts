// Plan 15, B6: what the tolerances of the SEED oracle entries for stacks of PLATES would be with the two-dimensional reference (scripts/measure-oracle-2d.cjs; read-only: no entry, generator
// or golden file is written, and the hashes in tests/seedOracleStack.test.ts keep it so). The numbers of the table in docs/plans/15-axial-2d.md are asserted here; limits fixed before the
// first run, with their reasons:
//   SAME CELLS   the saved OFFBEAT cells against the reference, steady: 1e-4 K (B2 saw 5e-6; the quantities are read from 8-digit output at 600 to 900 K);
//   TRANSIENT    the same for the loss of cooling: 1e-3 K (B3 saw up to 0.0094 K over every cell at every output, 0.0002 K at the peak of the run);
//   MESH BOUND   5 x the slice's centre-to-surface rise / N^2 (N = 100 cells), the generator's own first term: 0.1074 K for the hottest slice and 0.0186 K for an end slice, to 1e-3;
//   MISSED       the one-dimensional closed form misses an end slice by the axial effect (0.538 K at 200 kW/m, plan 12 A5 + B0: 0.54 to 0.61), and the lumped transient by 0.756 K: to 0.01 K.
// Run `npm run build` first (the script reads dist/).
import { execFileSync } from "child_process";
import { join } from "path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const table = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "measure-oracle-2d.cjs")], { cwd: root, encoding: "utf8", maxBuffer: 1 << 24 }));
const row = (id: string) => [...table.steady, ...table.transient, ...table.plate].find((r: any) => r.entry === id);

describe("the entries for stacks of plates with the two-dimensional reference (measured, nothing changed)", () => {
  it("the cosine plate's peak: the reference's 872.8681 K is the solver's to 1e-4 K; the entry's closed form is 0.049 K from the solver and the mesh bound is 0.1074 K, against a tolerance of 1.65 K", () => {
    const r = row("feed-stack-cosine-plate-temperature-peak");
    expect(r.reference2d).toBeCloseTo(872.8681, 3);
    expect(Math.abs(r.solverMinus2d)).toBeLessThan(1e-4);
    expect(r.solverMinusExpected).toBeCloseTo(-0.0493, 3);
    expect(r.meshBound).toBeCloseTo(0.1074, 3);
    expect(r.currentTolerance).toBe(1.65);
  });
  it("the cosine plate's coolest slice: the reference's 625.6177 K is the solver's to 1e-4 K; the closed form misses it by 0.538 K (the axial effect at an end slice) and the mesh bound is 0.0186 K, against 1.3 K", () => {
    const r = row("feed-stack-cosine-plate-temperature-peak-slice-min");
    expect(r.reference2d).toBeCloseTo(625.6177, 3);
    expect(Math.abs(r.solverMinus2d)).toBeLessThan(1e-4);
    expect(Math.abs(r.solverMinusExpected - 0.538)).toBeLessThan(0.01);
    expect(r.meshBound).toBeCloseTo(0.0186, 3);
    expect(r.currentTolerance).toBe(1.3);
    // the closed-form expected value could not be kept with the mesh bound alone: it is farther from the solver than that bound
    expect(Math.abs(r.solverMinusExpected)).toBeGreaterThan(r.meshBound * 10);
  });
  it("the hottest slice is the fifth (index 4) in the closed form, in the reference and in the solver", () => {
    const r = row("feed-stack-cosine-plate-axial-hottest-slice");
    expect([r.expected, r.reference2d, r.expected + r.solverMinusExpected]).toEqual([4, 4, 4]);
    expect(table.steadyDetail.hottest2d).toBe(4);
    expect(table.steadyDetail.hottestSolver).toBe(4);
  });
  it("every slice of the cosine plate: the reference's peaks are the solver's to 1e-4 K", () => {
    table.steadyDetail.peaks2d.forEach((x: number, k: number) => expect(Math.abs(x - table.steadyDetail.solverPeaks[k]), "slice " + k).toBeLessThan(1e-4));
  });
  it("the lumped loss of cooling: the reference's 801.1632 K is the solver's to 1e-3 K; the lumped value is 0.756 K from the solver; the reference's own cross-check bound is 0.021 K, against 5.3 K", () => {
    const r = row("feed-stack-lumped-plate-loss-of-cooling-temperature-peak-max");
    expect(r.reference2d).toBeCloseTo(801.1632, 3);
    expect(Math.abs(r.solverMinus2d)).toBeLessThan(1e-3);
    expect(Math.abs(r.solverMinusExpected + 0.756)).toBeLessThan(0.01);
    expect(r.currentTolerance).toBe(5.3);
    expect(r.crossCheckBoundOf2d).toMatch(/bound 0\.021 K/);
    expect(r.failing).toEqual([]);
  });
  it("the plate alone has no stack and no axial conduction: nothing for the reference to replace (the solver is inside the tolerances by 3e-5 K)", () => {
    for (const id of ["feed-plate-steady-temperature-peak", "feed-plate-steady-temperature-surface"]) expect(Math.abs(row(id).solverMinusExpected)).toBeLessThan(1e-4);
  });
});
