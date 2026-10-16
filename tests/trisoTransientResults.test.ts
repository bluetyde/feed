// Plan 13 T3 stage 3, ungated: real OFFBEAT output of a particle's transients (tests/golden/offbeat-triso-transient, made by tests/trisoTransientSolver.test.ts with FEED_SAVE_GOLDEN=1) read
// back and judged against FEED's finite-volume solution; the same output read with a wrong case fails a check; damaged output is refused.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ResultsError } from "../src/core/resultsParser";
import { TrisoTransientResultsRecord, buildTrisoTransientResults, computeTrisoIndependent } from "../src/core/trisoTransientResults";

const root = join(__dirname, "..");
const g = (name: string) => {
  const d = join(root, "tests", "golden", "offbeat-triso-transient", name);
  const f = (x: string) => readFileSync(join(d, x), "utf8");
  const fields = readdirSync(join(d, "times")).sort((a, b) => Number(a) - Number(b)).map((t) => ({ time: Number(t), T: readFileSync(join(d, "times", t, "T"), "utf8") }));
  return { n: JSON.parse(f("normalized.json")), C: f("C"), cellZones: f("cellZones"), fields, saved: JSON.parse(f("results.json")) as TrisoTransientResultsRecord };
};
type G = ReturnType<typeof g>;
const read = (x: G, mutate?: (n: any) => void, over: Partial<{ C: string; cellZones: string; fields: G["fields"] }> = {}) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildTrisoTransientResults(n, { C: over.C ?? x.C, cellZones: over.cellZones ?? x.cellZones, fields: over.fields ?? x.fields }, computeTrisoIndependent(n));
};
const failed = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const value = (r: { checks: { id: string; value: number | null }[] }, id: string) => r.checks.find((c) => c.id === id)!.value!;
const GOOD = ["pulse", "outside-ramp", "wall-quench", "laws"];

describe("real OFFBEAT output of a particle's transient", () => {
  for (const name of GOOD) {
    it(name + ": every check passes, and the verdicts are those the run saved", () => {
      const x = g(name);
      const r = read(x);
      expect(failed(r)).toEqual([]);
      expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["energyBalance", "crossCheckFv", "timeStep"]));
      expect(r.checks.map((c) => [c.id, c.verdict])).toEqual(x.saved.checks.map((c) => [c.id, c.verdict]));
      expect(r.times).toHaveLength(x.n.transient.outputs + 1);
      expect(r.profiles).toHaveLength(x.n.transient.outputs + 1);
      expect(r.profiles.every((p) => p.length === 64)).toBe(true);
      expect(r.summary.maxT).toBeCloseTo(x.saved.summary.maxT, 9);
    });
  }

  it("the pulse: the cells agree with the independent solution to 0.014 K of a 17 K rise; the energy balance closes to 1 %", () => {
    const r = read(g("pulse"));
    expect(value(r, "crossCheckFv")).toBeLessThan(0.02);
    expect(value(r, "energyBalance")).toBeLessThan(0.01);
    expect(value(r, "wallTemperature")).toBe(0);
    expect(value(r, "timeStep")).toBeLessThan(0.25);
  });

  it("the pulse: 4 mJ made, all of it gone by the end; the source the implicit step deposits is 5 % high on the way up and equal to the integral at the end", () => {
    const r = read(g("pulse"));
    const s = r.series;
    expect(s.deposited[s.deposited.length - 1]).toBeCloseTo(4e-3, 14);
    expect(s.deposited[1]).toBeCloseTo(2e-3, 14);
    // by hand: dt x sum of 0.4 i / 20 for i = 1 to 20 = 5e-4 x 0.4 x 10.5
    expect(s.depositedByScheme[1]).toBeCloseTo(5e-4 * 0.4 * 10.5, 14);
    expect(s.depositedByScheme[s.depositedByScheme.length - 1]).toBeCloseTo(4e-3, 12);
    expect(Math.abs(s.stored[s.stored.length - 1]!)).toBeLessThan(1e-6);
    expect(s.rejected[s.rejected.length - 1]! / 4e-3).toBeGreaterThan(0.99);
    expect(s.rejected[s.rejected.length - 1]! / 4e-3).toBeLessThan(1.01);
    // the energy stored at the end of the pulse is nearly all of it, the heat has hardly left
    expect(s.stored[2]! / s.deposited[2]!).toBeGreaterThan(0.9);
  });

  it("the pulse: the hottest cell is in the kernel at 20 ms, 16.6 K up; the independent solution's steps see a hotter point between the outputs, which a limit judges", () => {
    const x = g("pulse");
    const r = read(x);
    expect(r.summary.timeOfMaxT).toBeCloseTo(0.02, 9);
    expect(r.summary.maxRise).toBeCloseTo(16.61, 2);
    expect(r.series.regionMax.kernel![2]).toBe(r.summary.maxT);
    const lim = (max: number) => read(x, (n) => (n.limits = [{ name: "k", region: "kernel", maxTemperature: max, source: "s" }])).checks.find((c) => c.id === "temperatureLimit1")!;
    const c = lim(1100);
    expect(c.value!).toBeCloseTo(1100 - 1017.158, 2); // the independent solution's peak, 0.55 K above the outputs' (1016.609)
    expect(c.note).toContain("the independent solution (every step)");
    expect(lim(1017).verdict).toBe("fail");
    expect(lim(1017.2).verdict).toBe("pass");
    expect(lim(1016.7).verdict).toBe("fail"); // above the outputs' peak, below the steps': the steps decide
  });

  it("the series starts at the table's first value, so a steady start shows its power at time 0", () => {
    const r = read(g("outside-ramp"));
    expect(r.series.power[0]).toBe(0.2);
    expect(r.series.power[r.series.power.length - 1]).toBe(0.2);
    expect(r.series.depositedByScheme[1]).toBeCloseTo(0.2 * 0.01, 12);
    expect(read(g("pulse")).series.power[0]).toBe(0);
  });

  it("the energies are the nominal sphere's: the stored energy is the sum of capacity x nominal cell volume x rise, the rejected is the film's heat on the nominal outer area, each to 1e-5 of itself (the wedge holds 0.9991 of them)", () => {
    const x = g("outside-ramp");
    const r = read(x);
    const n = x.n;
    // stored, by hand: equal cells between the case's own radii (the wedge's cells hold lambda^3 of these volumes), c in J/m3/K
    const radii = [0, n.kernelRadius, ...n.layers.map((l: { outerRadius: number }) => l.outerRadius)];
    const caps = [3e6, 1.5e6, 2.5e6, 3.5e6, 2.5e6];
    const vols: number[] = [];
    const reg: number[] = [];
    n.cells.forEach((nc: number, ri: number) => {
      for (let i = 0; i < nc; i++) {
        const a = radii[ri] + ((radii[ri + 1] - radii[ri]) * i) / nc;
        const b = radii[ri] + ((radii[ri + 1] - radii[ri]) * (i + 1)) / nc;
        vols.push((4 / 3) * Math.PI * (b ** 3 - a ** 3));
        reg.push(ri);
      }
    });
    r.profiles.forEach((p, k) => {
      const stored = p.reduce((a, T, i) => a + caps[reg[i]!]! * vols[i]! * (T - r.profiles[0]![i]!), 0);
      if (k > 0) expect(Math.abs(r.series.stored[k]! / stored - 1), "stored at output " + k).toBeLessThan(1e-5);
    });
    // rejected, by hand: the film's h A (wall - bulk) on the case's own outer surface over the wedge's volume ratio... the wedge's film area is lambda^2 of it and its heat divided by lambda^3 is 1/lambda of it
    const L = Math.cos((1 * Math.PI) / 180) / Math.sqrt(1 + Math.sin((1 * Math.PI) / 180) ** 2);
    const A = 4 * Math.PI * n.outerRadius ** 2;
    const bulk = (t: number) => (t <= 0.05 ? 900 : t <= 0.25 ? 900 + (100 * (t - 0.05)) / 0.2 : 1000);
    let rej = 0;
    for (let k = 1; k < r.times.length; k++) {
      const t0 = r.times[k - 1]!;
      const t1 = r.times[k]!;
      const N = 4000;
      for (let s = 0; s < N; s++) {
        const a = t0 + ((t1 - t0) * s) / N;
        const b = t0 + ((t1 - t0) * (s + 1)) / N;
        const f = (t: number) => (2000 * A) / L * ((r.series.wallT[k - 1]! + ((r.series.wallT[k]! - r.series.wallT[k - 1]!) * (t - t0)) / (t1 - t0)) - bulk(t));
        rej += 0.5 * (f(a) + f(b)) * (b - a);
      }
      expect(Math.abs(r.series.rejected[k]! / rej - 1), "rejected at output " + k).toBeLessThan(2e-5);
    }
  });

  it("the loss of the outside's cooling and the quench: the wall follows the table; the particle ends up where the table takes it", () => {
    const ramp = read(g("outside-ramp"));
    expect(ramp.initialState.kind).toBe("steady");
    expect(ramp.summary.finalPeakT - ramp.initialTemperature).toBeGreaterThan(70);
    expect(ramp.series.wallT[0]).toBeGreaterThan(900);
    const q = read(g("wall-quench"));
    expect(value(q, "wallTemperature")).toBeLessThan(1e-9);
    expect(q.series.wallT[q.series.wallT.length - 1]).toBeCloseTo(900, 6);
    expect(q.summary.finalPeakT).toBeLessThan(q.initialTemperature - 50);
    expect(q.series.gapDeltaT[0]).toBeGreaterThan(0.8);
  });

  it("laws that depend on temperature are in range, and a range that the particle leaves makes the result out-of-domain", () => {
    const x = g("laws");
    expect(read(x).domain.verdict).toBe("in-domain");
    const r = read(x, (n) => (n.kernelConductivity.range = [600, 960]));
    expect(r.domain.verdict).toBe("out-of-domain");
    expect(failed(r)).toContain("propertyRange");
    expect(r.domain.findings[0]!.region).toBe("kernel");
    const c = read(x, (n) => (n.capacities[0].range = [600, 960]));
    expect(failed(c)).toContain("propertyRange");
  });

  it("a step of 5 ms does not resolve the pulse: the time-step check fails and the energy balance with it, the cells still agree with the solution of that step", () => {
    const r = read(g("coarse-step"));
    expect(failed(r).sort()).toEqual(["energyBalance", "timeStep"]);
    expect(value(r, "crossCheckFv")).toBeLessThan(0.05);
    expect(value(r, "timeStep")).toBeGreaterThan(1);
  });
});

describe("the same output judged as another particle fails, or is refused", () => {
  const x = g("pulse");
  it("heat capacities 1.5 times too large (the case is another particle): the cells do not agree with the independent solution", () => {
    const r = read(x, (n) => n.capacities.forEach((c: { c: number }) => (c.c *= 1.5)));
    expect(failed(r)).toEqual(expect.arrayContaining(["crossCheckFv", "energyBalance"]));
  });
  it("a power 10 % too high: the cells and the energy balance fail", () => {
    const r = read(x, (n) => n.transient.particlePower.forEach((_: number, i: number, a: number[]) => (a[i] *= 1.1)));
    expect(failed(r)).toEqual(expect.arrayContaining(["crossCheckFv", "energyBalance"]));
  });
  it("a conductivity 20 % off in the buffer fails the cross-check", () => {
    const r = read(x, (n) => (n.layers[0].conductivity.k *= 1.2));
    expect(failed(r)).toContain("crossCheckFv");
  });
  it("a step twice the one that was run (but the same outputs) disagrees with what OFFBEAT wrote", () => {
    const r = read(x, (n) => {
      n.transient.timeStep *= 2;
      n.transient.steps /= 2;
    });
    expect(failed(r).length).toBeGreaterThan(0);
  });
  it("a wall history other than the one that was run fails the wall check and the cross-check", () => {
    const q = g("wall-quench");
    const r = read(q, (n) => (n.transient.boundaryHistory.surfaceTemperature = [1000, 950, 950]));
    expect(failed(r)).toEqual(expect.arrayContaining(["wallTemperature", "crossCheckFv"]));
  });
  it("a different number of outputs, or a write time that is not on the grid, is refused", () => {
    expect(() => read(x, (n) => (n.transient.outputs = 25))).toThrow(/expected 25 write times after 0, found 50/);
    const moved = x.fields.map((f, i) => (i === 5 ? { ...f, time: f.time + 0.001 } : f));
    expect(() => read(x, undefined, { fields: moved })).toThrow(/write time 6 is/);
    expect(() => read(x, undefined, { fields: x.fields.slice(0, 49) })).toThrow(/found 49/);
  });
  it("zones with the buffer's and the inner carbon's names swapped are refused", () => {
    const swapped = x.cellZones.replace(/Buffer/g, "XX").replace(/IPyC/g, "Buffer").replace(/XX/g, "IPyC");
    expect(() => read(x, undefined, { cellZones: swapped })).toThrow(/do not belong together/);
    expect(() => read(x, undefined, { cellZones: x.cellZones.replace(/OPyC/g, "Shell") })).toThrow(/zone Shell is not a region/);
  });
  it("a case that is not a transient is refused", () => {
    const n = JSON.parse(JSON.stringify(x.n));
    delete n.capacities;
    expect(() => buildTrisoTransientResults(n, { C: x.C, cellZones: x.cellZones, fields: x.fields })).toThrow(/not a transient particle/);
    const m = JSON.parse(JSON.stringify(x.n));
    delete m.transient;
    expect(() => buildTrisoTransientResults(m, { C: x.C, cellZones: x.cellZones, fields: x.fields })).toThrow(ResultsError);
  });
});

describe("damaged output is refused", () => {
  const x = g("pulse");
  const withField = (i: number, f: (t: string) => string) => x.fields.map((v, k) => (k === i ? { ...v, T: f(v.T) } : v));
  it("a cut field, a field of the wrong size, a negative or missing temperature, a missing patch", () => {
    expect(() => read(x, undefined, { fields: withField(10, (t) => t.slice(0, t.length - 400)) })).toThrow(ResultsError);
    expect(() => read(x, undefined, { fields: withField(10, (t) => t.replace(/\n\d+\n\(/, "\n63\n(")) })).toThrow(ResultsError);
    expect(() => read(x, undefined, { fields: withField(10, (t) => t.replace(/\n\(\n[0-9.e+-]+\n/, "\n(\n-4\n")) })).toThrow(/not above 0 K/);
    expect(() => read(x, undefined, { fields: withField(10, (t) => t.replace(/bufferOuter/g, "elsewhere")) })).toThrow(/no value for the bufferOuter patch/);
    expect(() => read(x, undefined, { fields: withField(10, (t) => t.replace(/ipycInner/g, "elsewhere")) })).toThrow(/no value for the ipycInner patch/);
    expect(() => read(x, undefined, { fields: withField(10, (t) => t.replace("boundaryField", "boundaries")) })).toThrow(/no boundaryField/);
  });
  it("cell centres that are cut, or a cell-centre field of another length", () => {
    expect(() => read(x, undefined, { C: x.C.slice(0, x.C.length - 200) })).toThrow(ResultsError);
    const lines = x.C.split("\n");
    const i = lines.findIndex((l) => /^\(\d/.test(l));
    expect(() => read(x, undefined, { C: lines.slice(0, i).concat(lines.slice(i + 1)).join("\n") })).toThrow(ResultsError);
  });
});
