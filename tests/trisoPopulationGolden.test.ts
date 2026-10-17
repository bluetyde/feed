// Plan 13 T6, ungated: the real OFFBEAT output of five sampled particles (tests/golden/offbeat-triso-pop/<role>/, made by tests/trisoPopulationSolver.test.ts with FEED_SAVE_GOLDEN=1) read
// back without the solver. Each is a particle of the example population (examples/synthetic-triso-population.json): the sampler is run again and must give the very particles that were
// run; the saved output is judged again by FEED's results reader (every check passes); the kernel centre is compared with the closed form of the sampled particle (the number the
// population reported) and every region's drop with the closed form of the wedge's sphere, with the tolerances of the gated test (fixed before its first run, see there); and the same
// output read against another sampled particle fails.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { TrisoInput, buildTrisoResults } from "../src/core/trisoResults";
import { RepresentativeRole, particleOf, runPopulation } from "../src/core/trisoPopulation";
import { trisoClosedForm } from "../src/core/trisoSolve";
import { wedgeEquivalent } from "../src/core/trisoWriter";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const ROLES: RepresentativeRole[] = ["hottest", "median", "coldest", "thickestBuffer", "thinnestSic"];
const CENTRE_FRACTION = 0.006;
const FACE_TOLERANCE = 0.2;
const SPREAD_FRACTION = 0.01;
const g = (role: string) => {
  const d = join(root, "tests", "golden", "offbeat-triso-pop", role);
  const f = (x: string) => readFileSync(join(d, x), "utf8");
  return { n: JSON.parse(f("normalized.json")), T: f("T"), C: f("C"), cellZones: f("cellZones"), rate: JSON.parse(f("rate.json")) as { relativeRate: number; time: number }, saved: JSON.parse(f("results.json")), meta: JSON.parse(f("meta.json")) };
};
const read = (x: ReturnType<typeof g>, n: any = x.n, over: Partial<TrisoInput> = {}) => buildTrisoResults(JSON.parse(JSON.stringify(n)), { T: x.T, C: x.C, cellZones: x.cellZones, time: x.rate.time, drift: { relativeRate: x.rate.relativeRate }, ...over });
const failed = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);

const doc = JSON.parse(readFileSync(join(root, "examples", "synthetic-triso-population.json"), "utf8"));
const n0 = validateCase(doc).triso!;
const pop = runPopulation(n0);

describe("the sampled particles that were run through OFFBEAT", () => {
  it("are the particles the sampler draws now: the same index, the same values, the same closed-form peak", () => {
    for (const role of ROLES) {
      const m = g(role).meta;
      const rep = pop.representatives.find((r) => r.role === role)!;
      expect(rep.index, role).toBe(m.index);
      expect(Math.abs(rep.kernelPeakT - m.kernelPeakT)).toBeLessThan(1e-9);
      expect(Math.abs(rep.draw.kernelRadius / m.draw.kernelRadius - 1)).toBeLessThan(1e-12);
      rep.draw.thicknesses.forEach((t, i) => expect(Math.abs(t / m.draw.thicknesses[i] - 1)).toBeLessThan(1e-12));
      expect(Math.abs(rep.draw.powerFactor / m.draw.powerFactor - 1)).toBeLessThan(1e-12);
    }
  });
  it("span the spread: the hottest is the sample's maximum, the coldest its minimum, the median its 50th percentile particle, and the peaks differ by tens of kelvin", () => {
    const peak = (r: string) => g(r).meta.kernelPeakT as number;
    expect(peak("hottest")).toBe(pop.quantities[0]!.stat.max);
    expect(peak("coldest")).toBe(pop.quantities[0]!.stat.min);
    expect(Math.abs(peak("median") - pop.quantities[0]!.stat.p50)).toBeLessThan(0.5);
    expect(peak("hottest") - peak("coldest")).toBeGreaterThan(100);
    const buf = (r: string) => g(r).meta.draw.thicknesses[0] as number;
    expect(buf("thickestBuffer")).toBeGreaterThan(buf("hottest"));
    const sic = (r: string) => g(r).meta.draw.thicknesses[2] as number;
    expect(sic("thinnestSic")).toBeLessThan(sic("median"));
  });
  for (const role of ROLES) {
    it(role + ": the saved output passes every check of FEED's reader, and is the record the run saved", () => {
      const x = g(role);
      const r = read(x);
      expect(failed(r)).toEqual([]);
      expect(r.checks.map((c) => [c.id, c.verdict])).toEqual(x.saved.checks.map((c: { id: string; verdict: string }) => [c.id, c.verdict]));
      expect(r.summary.kernelCentreT).toBeCloseTo(x.saved.summary.kernelCentreT, 9);
      expect(r.cells).toHaveLength(240);
    });
    it(role + ": the real solver's kernel centre is the sampled particle's closed form to 0.6 % of its rise, and every region's drop is the wedge's closed form to 0.2 K", () => {
      const x = g(role);
      const r = read(x);
      const rise = x.meta.kernelPeakT - x.meta.draw.matrixTemperature;
      expect(Math.abs(r.summary.kernelCentreT - x.meta.kernelPeakT)).toBeLessThan(CENTRE_FRACTION * rise);
      const cf = trisoClosedForm(wedgeEquivalent(x.n));
      cf.regions.forEach((c, i) => expect(Math.abs(r.regions[i]!.drop - (c.innerT - c.outerT)), c.name).toBeLessThan(FACE_TOLERANCE));
      // the case that was run is the sampled particle
      const sampled = particleOf(n0, pop.representatives.find((q) => q.role === role)!.draw);
      expect(x.n.kernelRadius).toBeCloseTo(sampled.kernelRadius, 12);
      expect(x.n.outerRadius).toBeCloseTo(sampled.outerRadius, 12);
      expect(x.n.power.particlePower).toBeCloseTo(sampled.power.particlePower, 12);
    });
  }
  it("the real solver sees the spread: the same ordering from the hottest to the coldest, and the same width to 1 %", () => {
    const c = (r: string) => read(g(r)).summary.kernelCentreT;
    expect(c("hottest")).toBeGreaterThan(c("median"));
    expect(c("median")).toBeGreaterThan(c("coldest"));
    const span = g("hottest").meta.kernelPeakT - g("coldest").meta.kernelPeakT;
    expect(Math.abs(c("hottest") - c("coldest") - span)).toBeLessThan(SPREAD_FRACTION * span);
  });
  it("the same output read as another sampled particle fails: the hottest's output against the coldest's case is refused or fails a closed-form check", () => {
    const hot = g("hottest");
    const cold = g("coldest");
    let verdict: string[] = [];
    try {
      verdict = failed(read(hot, cold.n));
    } catch (e) {
      verdict = ["refused: " + String((e as Error).message).slice(0, 60)];
    }
    expect(verdict.length).toBeGreaterThan(0);
  });
});