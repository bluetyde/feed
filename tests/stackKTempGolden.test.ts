// Ungated: the real OFFBEAT output of stacks with temperature-dependent conductivities (tests/golden/offbeat-stack-ktemp, made by tests/stackKTempSolver.test.ts with FEED_SAVE_GOLDEN=1)
// read back and judged. The point of these runs: every earlier saved stack run had constant conductivities, so the face between two layers (OFFBEAT interpolates the conductivity
// linearly to it; the first two-dimensional reference used two half cells in series, the harmonic mean) was untested. Against this output the harmonic form leaves 0.2086 K at the end
// slice of a loss of cooling (4 of 10 slices fail the cross-check, bound 0.041 K) and the arithmetic mean 0.00017 K; a single plate with the same laws and history has no such
// deviation (the cross-check of the one-plate run is 2e-5), so it is the heat that crosses between layers.
//
// Tolerances, fixed before this file's first run: a deviation of OFFBEAT's cells from the two-dimensional reference of at most 0.01 K (the harmonic form is 20 times that).
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildStackResults } from "../src/core/stackResults";
import { buildStackTransientResults, computeIndependentStack } from "../src/core/stackTransientResults";

const root = join(__dirname, "..", "tests", "golden", "offbeat-stack-ktemp");
const DEVIATION = 0.01;
const g = (name: string) => {
  const d = join(root, name);
  const f = (x: string) => readFileSync(join(d, x), "utf8");
  const normalized = JSON.parse(f("normalized.json"));
  const transient = !!normalized.transient;
  const fields = transient ? readdirSync(join(d, "times")).sort((a, b) => Number(a) - Number(b)).map((n) => ({ time: Number(n), T: f(join("times", n, "T")) })) : [];
  return { normalized, C: f("C"), T: transient ? "" : f("T"), fields, time: JSON.parse(f("time.json")).time as number };
};
const failing = (r: { checks: { id: string; verdict: string; value: number | null; note: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 160));
const reference = (r: any) => r.axial.reference as { kind: string; deviation: number; oneDimensionalDeviation: number };

describe("real OFFBEAT output of stacks with temperature-dependent conductivities", () => {
  it("a cosine plate stack (fuel k = 2000 / T + 0.5, cladding k = 12 + 0.006 T): every check passes and the cells agree with the two-dimensional reference", () => {
    const x = g("plate-steady");
    expect(x.normalized.fuelConductivity.kind).toBe("reciprocal");
    expect(x.normalized.claddingConductivity.kind).toBe("linear");
    const r = buildStackResults(x.normalized, { T: x.T, C: x.C, time: x.time });
    expect(failing(r)).toEqual([]);
    expect(reference(r).kind).toBe("two-dimensional");
    expect(reference(r).deviation).toBeLessThan(DEVIATION);
    // the one-dimensional closed forms miss by much more (the heat along the height), so the agreement is the reference's
    expect(reference(r).deviation).toBeLessThan(0.1 * (reference(r).oneDimensionalDeviation ?? 1));
  });

  it("a cosine pin stack with the same laws: every check passes (a pin is judged with the allowance, not the reference)", () => {
    const x = g("pin-steady");
    const r = buildStackResults(x.normalized, { T: x.T, C: x.C, time: x.time });
    expect(failing(r)).toEqual([]);
    expect(r.axial.reference).toBeUndefined();
    expect(r.axial.slices).toHaveLength(10);
  });

  it("a loss of cooling on a 0.2 m plate stack: every check passes with the reference and the cells agree with it to 0.01 K; the one-dimensional solutions are 24 K away", () => {
    const x = g("plate-lossofcooling");
    const r = buildStackTransientResults(x.normalized, { C: x.C, fields: x.fields });
    expect(failing(r)).toEqual([]);
    expect(reference(r).kind).toBe("two-dimensional");
    expect(reference(r).deviation).toBeLessThan(DEVIATION);
    expect(reference(r).oneDimensionalDeviation).toBeGreaterThan(20);
    // the fallback regime (reference left out) passes this output only through its exchange bound, a bound 100 times what the reference needs
    const oneD = buildStackTransientResults(x.normalized, { C: x.C, fields: x.fields }, computeIndependentStack(x.normalized), null);
    const bound = (res: { checks: { id: string; note: string }[] }) => Number(/bound ([0-9.]+) K/.exec(res.checks.find((c) => c.id === "crossCheckFv")!.note)![1]);
    expect(bound(oneD)).toBeGreaterThan(10 * bound(r));
  });
});
