// Plan 12 A4, ungated: real OFFBEAT output of plates (tests/golden/offbeat-plate, made by tests/plateSolver.test.ts with FEED_SAVE_GOLDEN=1) read back and checked against the slab's
// closed forms and the slab finite-volume solution; the same output read as a pin is refused or fails; damaged output is refused.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ResultsError, buildResults } from "../src/core/resultsParser";
import { buildTransientResults, computeIndependent } from "../src/core/transientResults";

const root = join(__dirname, "..");
const g = (name: string) => {
  const d = join(root, "tests", "golden", "offbeat-plate", name);
  const n = JSON.parse(readFileSync(join(d, "normalized.json"), "utf8"));
  const T = readFileSync(join(d, "T"), "utf8");
  const C = readFileSync(join(d, "C"), "utf8");
  let fields: { time: number; T: string }[] = [];
  try {
    fields = readdirSync(join(d, "times")).sort((a, b) => Number(a) - Number(b)).map((t) => ({ time: Number(t), T: readFileSync(join(d, "times", t, "T"), "utf8") }));
  } catch {
    fields = [];
  }
  return { n, T, C, fields };
};
const steady = (x: ReturnType<typeof g>, mutate?: (n: any) => void, T = x.T) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildResults(n, { T, C: x.C, time: 5e7, drift: { relativeRate: 1e-12 } });
};
const transient = (x: ReturnType<typeof g>, mutate?: (n: any) => void) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildTransientResults(n, { C: x.C, fields: x.fields }, computeIndependent(n));
};

describe("a steady plate", () => {
  for (const name of ["steady", "wall"]) {
    it(name + ": every check passes against the slab closed forms, to a hundredth of a kelvin", () => {
      const r = steady(g(name));
      expect(r.checks.filter((c) => c.verdict === "fail")).toEqual([]);
      expect(r.checks.find((c) => c.id === "closedFormFuel")!.value!).toBeLessThan(0.02);
      expect(r.checks.find((c) => c.id === "closedFormCladding")!.value!).toBeLessThan(0.001);
    });
  }
  it("the centre is the hand-worked 592.093 K, and the prescribed-wall plate's 618.427 K", () => {
    expect(steady(g("steady")).summary.centreCellT).toBeCloseTo(592.09333, 4);
    expect(steady(g("wall")).summary.centreCellT).toBeCloseTo(618.42667, 4);
  });
  it("read as a pin (the cylinder's closed forms and flux) the same output fails the checks: the geometry is what they test", () => {
    const r = steady(g("steady"), (n) => delete n.plate);
    const failed = r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["closedFormFuel", "closedFormCladding", "energyBalance"]));
  });
  it("a slab's heat rate that is wrong by 10 % fails the energy balance and the closed forms", () => {
    const r = steady(g("steady"), (n) => (n.qPrime *= 1.1));
    expect(r.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual(expect.arrayContaining(["energyBalance", "closedFormFuel"]));
  });
  it("a plate whose film coefficient is not the one that was run fails the wall check", () => {
    const r = steady(g("steady"), (n) => (n.boundary.heatTransferCoefficient *= 0.5));
    expect(r.checks.find((c) => c.id === "wallTemperature")!.verdict).toBe("fail");
  });
  it("damaged output is refused: a cut field, and a field with the wrong number of cells", () => {
    const x = g("steady");
    expect(() => steady(x, undefined, x.T.slice(0, x.T.length - 300))).toThrow(ResultsError);
    expect(() => steady(x, (n) => (n.mesh.fuelCells = 21))).toThrow(/expected 27 cells/);
  });
});

describe("a transient plate", () => {
  it("a pulse into a cold plate and the loss of cooling from a steady start: every check passes, cross-checked against the slab finite-volume solution", () => {
    for (const name of ["pulse", "lossofcooling"]) {
      const r = transient(g(name));
      expect(r.checks.filter((c) => c.verdict === "fail"), name).toEqual([]);
      expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["energyBalance", "crossCheckFv", "timeStep"]));
    }
  });
  it("the pulse reaches the adiabatic peak and the loss of cooling warms the plate by tens of kelvin", () => {
    const p = transient(g("pulse"));
    const E = p.series.deposited[p.series.deposited.length - 1]!;
    expect(Math.abs(p.summary.maxT - (300 + E / 4.1e-3 / 3e6))).toBeLessThan(0.02 * (E / 4.1e-3 / 3e6));
    const l = transient(g("lossofcooling"));
    expect(l.series.peakT[l.series.peakT.length - 1]! - l.series.peakT[2]!).toBeGreaterThan(50);
  });
  it("read as a pin the output is refused: the cylinder's mesh puts the cell centres elsewhere", () => {
    expect(() => transient(g("pulse"), (n) => delete n.plate)).toThrow(/this case's mesh puts it at/);
  });
  it("judged against a different power or a different film history the cross-check fails", () => {
    expect(transient(g("pulse"), (n) => (n.transient.linearHeatRate = n.transient.linearHeatRate.map((x: number) => x * 1.2))).checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("fail");
    const h = transient(g("lossofcooling"), (n) => (n.transient.boundaryHistory.heatTransferCoefficient = n.transient.boundaryHistory.heatTransferCoefficient.map((x: number) => x * 3)));
    expect(h.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("fail");
  });
});
