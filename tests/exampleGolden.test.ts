// Plan 12 A9 and plan 13 T7, ungated: the real OFFBEAT output of the four new example cases (tests/golden/examples/<id>/, made by tests/exampleRuns.test.ts with FEED_SOLVER=1 and
// FEED_SAVE_GOLDEN=1) is read again without the solver and judged by the same code the run manager uses. EVERY check must pass. Each case's saved normalised form must equal the one the
// validator makes from the example file as it is now, so editing an example without re-running the solver fails here. The checks are shown to bite: the same output judged against a
// case that was not the one run fails.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildStackResults } from "../src/core/stackResults";
import { buildStackTransientResults, computeIndependentStack } from "../src/core/stackTransientResults";
import { buildTrisoResults } from "../src/core/trisoResults";
import { buildTrisoTransientResults, computeTrisoIndependent } from "../src/core/trisoTransientResults";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const IDS = ["ksu-triga-cosine-stack", "synthetic-plate-loss-of-cooling", "synthetic-triso-compact-steady", "synthetic-triso-compact-pulse"];

interface Check { id: string; verdict: string; value: number | null; note: string }
const g = (id: string) => {
  const d = join("tests", "golden", "examples", id);
  const n = JSON.parse(read(d, "normalized.json"));
  const times = n.transient ? readdirSync(join(root, d, "times")).sort((a, b) => Number(a) - Number(b)) : [];
  return {
    id, n, C: read(d, "C"), cellZones: read(d, "cellZones"),
    T: n.transient ? "" : read(d, "T"),
    rate: n.transient ? { relativeRate: 0, time: 0 } : (JSON.parse(read(d, "rate.json")) as { relativeRate: number; time: number }),
    fields: times.map((t) => ({ time: Number(t), T: read(d, "times", t, "T") })),
    saved: JSON.parse(read(d, "results.json")) as { checks: Check[]; summary: any; axial?: any },
  };
};
type G = ReturnType<typeof g>;
/** The results of a saved run, judged by the run manager's code; `mutate` changes the case first (to show a check fails for a case that was not run). */
function judge(x: G, mutate?: (n: any) => void): { checks: Check[]; summary: any; axial?: any } {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  if (x.id === "ksu-triga-cosine-stack") return buildStackResults(n, { T: x.T, C: x.C, time: x.rate.time, drift: { relativeRate: x.rate.relativeRate } }) as any;
  if (x.id === "synthetic-plate-loss-of-cooling") return buildStackTransientResults(n, { C: x.C, fields: x.fields }, computeIndependentStack(n)) as any;
  if (x.id === "synthetic-triso-compact-steady") return buildTrisoResults(n, { T: x.T, C: x.C, cellZones: x.cellZones, time: x.rate.time, drift: { relativeRate: x.rate.relativeRate } }) as any;
  return buildTrisoTransientResults(n, { C: x.C, cellZones: x.cellZones, fields: x.fields }, computeTrisoIndependent(n)) as any;
}
const notPassing = (r: { checks: Check[] }) => r.checks.filter((c) => c.verdict !== "pass" && c.verdict !== "na").map((c) => c.id + " " + c.verdict);
const check = (r: { checks: Check[] }, id: string) => r.checks.find((c) => c.id === id)!;
const ids = (r: { checks: Check[] }) => r.checks.map((c) => c.id);

describe("the example cases of plan 12 A9 and plan 13 T7, with the output the real solver made", () => {
  for (const id of IDS) {
    describe(id, () => {
      const x = g(id);
      it("the saved case is the example file as it is now (an edited example must be re-run)", () => {
        const v = validateCase(JSON.parse(read("examples", id + ".json")));
        expect(v.errors).toEqual([]);
        expect(JSON.parse(JSON.stringify(v.normalized ?? { kind: "triso", ...v.triso }))).toEqual(x.n);
      });
      it("every check passes, and the verdicts are the ones the solver run saved", () => {
        const r = judge(x);
        expect(notPassing(r)).toEqual([]);
        expect(r.checks.filter((c) => c.verdict === "pass").length).toBeGreaterThanOrEqual(4);
        expect(r.checks.map((c) => [c.id, c.verdict])).toEqual(x.saved.checks.map((c) => [c.id, c.verdict]));
        expect(notPassing(x.saved)).toEqual([]);
      });
    });
  }

  it("ksu-triga-cosine-stack: ten slices, the hottest the sixth (the warming pool moves it above the middle), 776.8 K, inside both SAR fuel limits in every slice", () => {
    const x = g("ksu-triga-cosine-stack");
    const r = judge(x);
    expect(ids(r)).toEqual(expect.arrayContaining(["energyBalance", "closedFormFuel", "closedFormCladding", "wallTemperature", "temperatureLimit1", "temperatureLimit2", "steadyState", "energyBalanceTotal", "axialConduction"]));
    expect(r.axial.slices).toHaveLength(10);
    expect(r.axial.hottest).toBe(5);
    expect(r.summary.centreCellT).toBeCloseTo(776.80655, 4);
    // the slice below the hottest is 0.5 K cooler although it makes the same heat: the coolant there is 0.5 K colder (5 K over the 0.381 m, a slice 38.1 mm tall)
    expect(r.axial.slices[5].centreCellT - r.axial.slices[4].centreCellT).toBeGreaterThan(0.4);
    expect(r.axial.slices[5].centreCellT - r.axial.slices[4].centreCellT).toBeLessThan(0.6);
    // the average heat rate 39.48 kW/m given, the cosine sampled at the slice centres: 39.663 kW/m, and the faces carry it away to 3e-6
    expect(Math.abs(check(r, "energyBalanceTotal").value!)).toBeLessThan(1e-5);
    // the limit with the cladding at most 500 C is the one that applies (the cladding stays near 305 to 320 K at the wall); the other has no slice to judge
    expect(check(r, "temperatureLimit1").value!).toBeGreaterThan(600);
    expect(check(r, "temperatureLimit2").value).toBeNull();
    // the hottest fuel 776.8 K against 1423.15 K (1150 C): the margin is that difference
    expect(check(r, "temperatureLimit1").value!).toBeCloseTo(1423.15 - 776.80655, 2);
  });

  it("synthetic-plate-loss-of-cooling: the middle of the plate warms 477 K in the 60 s, the end slices 81 K, and the heat the slices exchange is counted (number 0.06)", () => {
    const x = g("synthetic-plate-loss-of-cooling");
    const r = judge(x);
    expect(ids(r)).toEqual(expect.arrayContaining(["energyBalance", "crossCheckFv", "timeStep", "energyBalanceTotal", "axialConduction"]));
    expect(r.axial.slices).toHaveLength(10);
    const mid = r.axial.slices[5].peakT as number[];
    const end = r.axial.slices[0].peakT as number[];
    expect(mid[0]).toBeCloseTo(448.2, 0);
    expect(mid[mid.length - 1]).toBeCloseTo(924.9, 0);
    expect(mid[mid.length - 1] - mid[0]).toBeGreaterThan(470);
    expect(end[end.length - 1] - end[0]).toBeGreaterThan(75);
    expect(end[end.length - 1] - end[0]).toBeLessThan(90);
    // still warming at the end: the last interval of 2 s adds about 17 K to the middle (8.7 K/s between 12 s and 60 s)
    expect(mid[mid.length - 1] - mid[mid.length - 2]).toBeGreaterThan(10);
    expect((mid[mid.length - 1] - mid[6]) / (60 - 12)).toBeGreaterThan(8);
    expect((mid[mid.length - 1] - mid[6]) / (60 - 12)).toBeLessThan(9.5);
    expect(r.axial.allowance.exchangeCounted).toBe(true);
    expect(r.axial.allowance.exchangeNumber).toBeGreaterThan(0.05);
    expect(r.axial.allowance.exchangeNumber).toBeLessThan(0.07);
    expect(check(r, "energyBalanceTotal").verdict).toBe("pass");
  });

  it("synthetic-triso-compact-steady: 11.65 mW a particle, the kernel 5.1 K above the matrix, the buffer drop (2.1 K) the largest of the layers, every closed form within its bound", () => {
    const x = g("synthetic-triso-compact-steady");
    const r = judge(x);
    expect(ids(r)).toEqual(expect.arrayContaining(["closedFormKernel", "closedFormBuffer", "closedFormIpyc", "closedFormSic", "closedFormOpyc", "crossCheckFv", "energyBalance", "gapDrop", "wallTemperature", "steadyState"]));
    // the compact's 10 W/cm3 at 35 %: each particle makes 10e6 W/m3 x (4/3 pi (460e-6)^3) / 0.35 = 11.649 mW, by hand
    expect(x.n.power.particlePower).toBeCloseTo((10e6 * (4 / 3) * Math.PI * Math.pow(460e-6, 3)) / 0.35, 9);
    expect(x.n.power.kernelPowerDensity).toBeCloseTo(178e6, -6);
    // the kernel's centre above the matrix: film P / (4 pi R^2 h) + the layers + the gap + the kernel's own parabola q R^2 / (6 k), worked by hand
    const P = x.n.power.particlePower;
    const rk = 250e-6, rb = 350e-6, ri = 390e-6, rs = 425e-6, ro = 460e-6;
    const shell = (k: number, a: number, b: number) => (P / (4 * Math.PI * k)) * (1 / a - 1 / b);
    const byHand = 900 + P / (4 * Math.PI * ro * ro * 2000) + shell(4, rs, ro) + shell(13.9, ri, rs) + shell(4, rb, ri) + P / (4 * Math.PI * rb * rb * 150000) + shell(0.5, rk, rb) + (x.n.power.kernelPowerDensity * rk * rk) / (6 * 3);
    // buffer 250-350, inner PyC 350-390, SiC 390-425, outer PyC 425-460 um; the gap (150000 W/m2/K) is at the buffer's outer radius
    const full = byHand;
    expect(Math.abs(r.summary.kernelCentreT - full), "kernel centre against the hand sum").toBeLessThan(0.02);
    expect(Math.abs(check(r, "energyBalance").value!)).toBeLessThan(0.005);
  });

  it("synthetic-triso-compact-pulse: the kernel peaks at 929.5 K at 20 ms (24 K above where it started), settles back, and all five limits hold with their margins", () => {
    const x = g("synthetic-triso-compact-pulse");
    const r = judge(x);
    expect(ids(r)).toEqual(expect.arrayContaining(["energyBalance", "crossCheckFv", "timeStep", "temperatureLimit1", "temperatureLimit2", "temperatureLimit3", "temperatureLimit4", "temperatureLimit5"]));
    expect(r.summary.maxT).toBeCloseTo(929.526, 2);
    expect(r.summary.timeOfMaxT).toBeCloseTo(0.02, 6);
    expect(r.summary.finalPeakT).toBeLessThan(907);
    expect(r.summary.finalPeakT).toBeGreaterThan(905);
    // the margin of a limit is the limit minus the hottest cell of the region: the kernel's is the smallest, the outer PyC's the largest
    const m = [1, 2, 3, 4, 5].map((i) => check(r, "temperatureLimit" + i).value!);
    // the check takes the worse of the outputs (929.526 K at 20 ms) and every step of the independent solution (930.331 K, between outputs), so it is 69.67 K
    expect(m[0]).toBeCloseTo(1000 - 930.331, 1);
    expect(m[0]).toBeLessThan(1000 - 929.526);
    for (let i = 1; i < 5; i++) expect(m[i]!).toBeGreaterThan(m[i - 1]!);
    expect(m.every((v) => v > 0)).toBe(true);
    // the steady start is the compact's power: the first output is the steady state, the kernel 5.1 K above the matrix
    expect(x.n.transient.initial).toEqual({ kind: "steady", particlePower: 0.01165 });
  });

  it("the checks bite: the same output judged against a case that was not the one run fails", () => {
    const stack = g("ksu-triga-cosine-stack");
    expect(notPassing(judge(stack, (n) => (n.qPrime *= 1.1))).length).toBeGreaterThan(0);
    expect(notPassing(judge(stack, (n) => (n.axial.boundary.bulkTemperature = [...n.axial.boundary.bulkTemperature].reverse()))).length).toBeGreaterThan(0);
    const plate = g("synthetic-plate-loss-of-cooling");
    expect(notPassing(judge(plate, (n) => (n.transient.linearHeatRate = n.transient.linearHeatRate.map((v: number) => v * 1.2)))).length).toBeGreaterThan(0);
    const steady = g("synthetic-triso-compact-steady");
    expect(notPassing(judge(steady, (n) => (n.boundary.heatTransferCoefficient *= 0.5))).length).toBeGreaterThan(0);
    expect(notPassing(judge(steady, (n) => (n.gapConductance *= 2))).length).toBeGreaterThan(0);
    const pulse = g("synthetic-triso-compact-pulse");
    expect(notPassing(judge(pulse, (n) => (n.transient.particlePower = n.transient.particlePower.map((v: number) => v * 1.2)))).length).toBeGreaterThan(0);
  });
});
