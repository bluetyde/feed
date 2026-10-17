// Plan 12 A5, ungated: the reading of real OFFBEAT output of a transient on a stack of plates, saved from the real solver (tests/golden/offbeat-plate-stack/transient-*, made by
// tests/plateStackSolver.test.ts with FEED_SAVE_GOLDEN=1), slice by slice with the slab finite-volume solution as the reference. The heat the slices can exchange along the height
// during a run (a loss of cooling leaves the axial path as the only one) is counted per slice from the independent solutions; the checks are shown to fail on a stack that is not the
// one that was run, and truncated, miscounted or reordered output is refused.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { sliceLoads } from "../src/core/axial";
import { ResultsError } from "../src/core/resultsParser";
import { AXIAL_EXCHANGE_FACTOR, AXIAL_EXCHANGE_NUMBER_LIMIT, buildStackTransientResults, computeIndependentStack, exchangeAllowances } from "../src/core/stackTransientResults";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const g = (name: string) => {
  const d = join("tests", "golden", "offbeat-plate-stack", "transient-" + name);
  const n = JSON.parse(read(d, "normalized.json"));
  const times = readdirSync(join(root, d, "times")).sort((a, b) => Number(a) - Number(b));
  return { n, C: read(d, "C"), fields: times.map((t) => ({ time: Number(t), T: read(d, "times", t, "T") })) };
};
const judge = (x: ReturnType<typeof g>, mutate?: (n: any) => void, over: Partial<ReturnType<typeof g>> = {}, reference?: null) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildStackTransientResults(n, { C: over.C ?? x.C, fields: over.fields ?? x.fields }, computeIndependentStack(n), reference);
};
/** Plan 15, B3: a stack of plates is now judged against the two-dimensional reference by default. The tests below that are about the one-dimensional solutions with the allowance and the exchange bound (the fallback) ask for that (reference null); the reference has its own tests in plateStackTransientReference.test.ts. */
const judge1d = (x: ReturnType<typeof g>, mutate?: (n: any) => void, over: Partial<ReturnType<typeof g>> = {}) => judge(x, mutate, over, null);
const failingIds = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const check = (r: { checks: { id: string }[] }, id: string) => r.checks.find((c) => c.id === id) as { id: string; value: number | null; verdict: string; note: string };

describe("real OFFBEAT output of a transient on a stack of plates, read slice by slice", () => {
  const pulse = g("pulse");
  const cool = g("lossofcooling");
  const asym = g("asym");
  it("a pulse on an operating plate stack, the loss of cooling and an asymmetric shape: every check passes, the record has one series per slice and the hottest slice's profiles", () => {
    for (const x of [pulse, cool, asym]) {
      const r = judge(x);
      expect(failingIds(r)).toEqual([]);
      expect(r.axial.slices).toHaveLength(10);
      expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["energyBalance", "crossCheckFv", "timeStep", "energyBalanceTotal", "axialConduction"]));
      expect(r.summary.maxT).toBe(Math.max(...r.axial.slices.map((s) => s.maxT)));
      expect(r.axial.slices[r.axial.hottest]!.maxT).toBe(r.summary.maxT);
      expect(r.thermalOnly).toMatch(/through-thickness solution per axial slice of the plate/);
    }
    expect([4, 5]).toContain(judge(pulse).axial.hottest);
    expect([4, 5]).toContain(judge(cool).axial.hottest);
    expect(judge(asym).axial.hottest).toBeGreaterThan(5);
  });
  it("the loss of cooling (the question of F17) on a cosine plate stack: the middle of the plate warms most, the end slices least, and the whole plate's energy balances", () => {
    const r = judge1d(cool);
    const rise = (k: number) => r.axial.slices[k]!.peakT[r.axial.slices[k]!.peakT.length - 1]! - r.axial.slices[k]!.peakT[0]!;
    expect(rise(5)).toBeGreaterThan(300);
    expect(rise(5)).toBeGreaterThan(3 * rise(0));
    expect(rise(0)).toBeGreaterThan(0);
    expect(check(r, "energyBalanceTotal").value!).toBeLessThan(0.03);
    // the slab finite-volume solution agrees with the solver to 6 K at the end slice (the one the neighbours warm), and to a degree or two elsewhere
    expect(check(r, "crossCheckFv").value!).toBeGreaterThan(3);
    expect(check(r, "crossCheckFv").value!).toBeLessThan(7);
  });
  it("the loss of cooling needs the heat the slices exchange to pass: the steady estimate's allowance alone (2.5 K) is below the 5.6 K the end slice differs by, and the exchange bound is above it", () => {
    const r = judge1d(cool);
    const a = r.axial.allowance;
    expect(a.field).toBeLessThan(check(r, "crossCheckFv").value!);
    expect(a.exchangeField!).toBeGreaterThan(check(r, "crossCheckFv").value!);
    expect(a.exchangeField!).toBeLessThan(5 * check(r, "crossCheckFv").value!);
    expect(a.exchangeNumber!).toBeLessThan(AXIAL_EXCHANGE_NUMBER_LIMIT);
    expect(check(r, "axialConduction").note).toMatch(/each slice's allowance is the larger of the two/);
    expect(check(r, "axialConduction").note).toMatch(/below 1/);
    // the energy balance of the end slice (7.3 %) likewise exceeds the steady allowance (1 % + 0.4 %) and passes with the exchange
    expect(check(r, "energyBalance").value!).toBeGreaterThan(0.05);
    expect(a.energy).toBeLessThan(0.01);
    expect(a.exchangeEnergy!).toBeGreaterThan(check(r, "energyBalance").value! - 0.01);
  });
  it("a pulse is over before heat can flow along the plate: the exchange bound is a thousandth of a kelvin and the steady allowance governs", () => {
    const r = judge(pulse);
    expect(r.axial.allowance.exchangeField!).toBeLessThan(0.01);
    expect(r.axial.allowance.field).toBeGreaterThan(0.1);
    expect(check(r, "crossCheckFv").value!).toBeLessThan(0.01);
  });
  it("a short plate (0.06 m, 12 slices) pulsed for 0.1 s: passes with the steady allowance, which is loose there (a stated limit)", () => {
    const r = judge(g("short"));
    expect(failingIds(r)).toEqual([]);
    expect(r.axial.conduction!.fraction).toBeGreaterThan(0.02);
    expect(check(r, "crossCheckFv").value!).toBeLessThan(0.1);
    expect(r.axial.allowance.field).toBeGreaterThan(50 * check(r, "crossCheckFv").value!);
  });
  it("the longer and the shorter loss of cooling pass with the exchange bound counted (exchange numbers 0.2 and 0.9), and the 1.5 case is the measured limit: it fails, and says so", () => {
    const long = judge1d(g("lossofcooling-long"));
    expect(failingIds(long)).toEqual([]);
    expect(long.axial.allowance.exchangeNumber!).toBeLessThan(0.5);
    expect(check(long, "crossCheckFv").value!).toBeGreaterThan(5 * long.axial.allowance.field);
    const short = judge1d(g("lossofcooling-short"));
    expect(failingIds(short)).toEqual([]);
    expect(short.axial.allowance.exchangeNumber!).toBeGreaterThan(0.5);
    expect(short.axial.allowance.exchangeNumber!).toBeLessThan(1);
    expect(check(short, "crossCheckFv").value!).toBeLessThan(short.axial.allowance.exchangeField!);
    // the measured ratios of the change to the factor-1 bound, which the factor 2 is a margin over: 0.78, 0.88, 0.60 (plate 0.381 m 60 s, 200 s, and 0.1 m 60 s)
    for (const [r, ratio] of [[judge1d(cool), 0.78], [long, 0.88], [short, 0.6]] as const) {
      const worst = check(r, "crossCheckFv").value!;
      expect(worst / (r.axial.allowance.exchangeField! / AXIAL_EXCHANGE_FACTOR)).toBeGreaterThan(0.9 * ratio);
      expect(worst / (r.axial.allowance.exchangeField! / AXIAL_EXCHANGE_FACTOR)).toBeLessThan(1.1 * ratio + 0.05);
    }
    const limit = judge1d(g("lossofcooling-limit"));
    expect(limit.axial.allowance.exchangeNumber!).toBeGreaterThan(AXIAL_EXCHANGE_NUMBER_LIMIT);
    expect(check(limit, "crossCheckFv").verdict).toBe("fail");
    expect(check(limit, "axialConduction").note).toMatch(/ABOVE 1.*no longer holds.*NOT counted/);
    expect(limit.axial.allowance.exchangeCounted).toBe(false);
    expect(judge1d(cool).axial.allowance.exchangeCounted).toBe(true);
    // the two checks that depend on what the neighbours give; the whole plate and the time step do not
    expect(failingIds(limit)).toEqual(["energyBalance", "crossCheckFv"]);
  });
  it("the exchange allowances: per slice, from the independent solutions; an end slice has one neighbour; zero for a flat stack; the factor and the energy as a fraction of the slice's own", () => {
    const n = cool.n;
    const sols = computeIndependentStack(n);
    const loads = sliceLoads(n);
    const e = exchangeAllowances(n, sols, loads)!;
    expect(e.field).toHaveLength(10);
    // symmetric shape: the two ends agree, and so do mirrored slices
    for (let k = 0; k < 5; k++) expect(e.field[k]! / e.field[9 - k]!).toBeCloseTo(1, 6);
    // the end slice has the most: its neighbour is the only one and the difference to it is the largest of the stack
    expect(Math.max(...e.field)).toBe(e.field[0]);
    // the factor scales it
    expect(AXIAL_EXCHANGE_FACTOR).toBe(2);
    expect(e.energy[0]!).toBeGreaterThan(e.energy[5]!);
    // by hand for the middle slices: rate x integral of |T6 - 2 T5 + T4| over the run, with the rate k A / (C h^2) = 0.0209 / (13725 x 1.45e-3) per second
    const p = (k: number) => sols[k]!.fv.trace!.peakByStep;
    const dt = n.transient.timeStep;
    let integral = 0;
    p(5).forEach((x, j, a) => (integral += (j === 0 || j === a.length - 1 ? 0.5 : 1) * Math.abs(p(4)[j]! - 2 * x + p(6)[j]!) * dt));
    const kA = 3 * 4.1e-3 + 15 * 0.57e-3;
    const C = 3e6 * 4.1e-3 + 2.5e6 * 0.57e-3;
    // (the trapezoid's half steps at both ends are in this to the ninth digit)
    expect(e.field[5]! / (AXIAL_EXCHANGE_FACTOR * (kA / (C * 0.0381 ** 2)) * integral)).toBeCloseTo(1, 9);
    // the temperature range the conductivity is taken over is the range the independent solutions reach, over ALL the slices: a fuel conductivity that falls with temperature has its
    // largest value at the lowest temperature of any slice (the end slice's coolest cell), worked by hand from the traces
    const falling = JSON.parse(JSON.stringify(n));
    falling.fuelConductivity = { kind: "linear", a: 4, b: -0.0006, range: [250, 2500] };
    const fs = computeIndependentStack(falling);
    const fe2 = exchangeAllowances(falling, fs, sliceLoads(falling))!;
    const lo = Math.min(...fs.map((x) => x.fv.trace!.fuelMin));
    const hi = Math.max(...fs.map((x) => x.fv.trace!.fuelMax));
    expect(lo).toBeLessThan(Math.max(...fs.map((x) => x.fv.trace!.fuelMin)) - 1);
    const kAf = (4 - 0.0006 * lo) * 4.1e-3 + 15 * 0.57e-3;
    const pf = (k: number) => fs[k]!.fv.trace!.peakByStep;
    let integralF = 0;
    pf(5).forEach((x, j, arr) => (integralF += (j === 0 || j === arr.length - 1 ? 0.5 : 1) * Math.abs(pf(4)[j]! - 2 * x + pf(6)[j]!) * dt));
    expect(hi).toBeGreaterThan(lo);
    expect(fe2.field[5]! / (AXIAL_EXCHANGE_FACTOR * (kAf / (C * 0.0381 ** 2)) * integralF)).toBeCloseTo(1, 9);
    // a flat stack with equal slices has no differences between them
    const flat = JSON.parse(JSON.stringify(n));
    flat.axial.shape = { kind: "flat" };
    flat.axial.boundary = undefined;
    const fe = exchangeAllowances(flat, computeIndependentStack(flat), sliceLoads(flat))!;
    expect(Math.max(...fe.field)).toBeLessThan(1e-9);
    expect(Math.max(...fe.energy)).toBeLessThan(1e-12);
  });
  it("judged against a stack that was not run, the checks fail: the shape read from the top, 20 % more power, half the film coefficient, the plate read as a pin", () => {
    const m = judge(asym, (n) => (n.axial.shape.relative = [...n.axial.shape.relative].reverse()));
    expect(check(m, "crossCheckFv").verdict).toBe("fail");
    expect(check(m, "energyBalance").verdict).toBe("fail");
    const p = judge(asym, (n) => (n.transient.linearHeatRate = n.transient.linearHeatRate.map((x: number) => x * 1.2)));
    expect(check(p, "crossCheckFv").verdict).toBe("fail");
    expect(check(p, "energyBalanceTotal").verdict, "20 % more power: the whole plate does not balance").toBe("fail");
    const h = judge(cool, (n) => (n.transient.boundaryHistory.heatTransferCoefficient = n.transient.boundaryHistory.heatTransferCoefficient.map((x: number) => x * 0.5)));
    expect(check(h, "crossCheckFv").verdict, "half the film coefficient").toBe("fail");
    let pin: ReturnType<typeof judge> | undefined;
    try {
      pin = judge(pulse, (n) => delete n.plate);
    } catch (e) {
      expect(e).toBeInstanceOf(ResultsError);
    }
    if (pin) expect(failingIds(pin).length).toBeGreaterThan(0);
  });
  it("output that is cut short, miscounted or in the wrong order is refused, never turned into a partial result", () => {
    const refuses = (f: () => unknown, re: RegExp, label: string) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(ResultsError);
        expect((e as Error).message, label).toMatch(re);
        return;
      }
      throw new Error("not refused: " + label);
    };
    const last = pulse.fields[pulse.fields.length - 1]!;
    refuses(() => judge(pulse, undefined, { fields: [...pulse.fields.slice(0, -1), { time: last.time, T: last.T.slice(0, last.T.length - 400) }] }), /footer|cut short|unbalanced|cladOuter/, "truncated");
    refuses(() => judge(pulse, (n) => (n.axial.slices = 9)), /C has 260 cells, expected 234/, "slice count");
    const rows = pulse.C.split("\n");
    const i0 = rows.findIndex((l) => /^\([-\d]/.test(l));
    const swapped = [...rows];
    [swapped[i0], swapped[i0 + 20]] = [rows[i0 + 20]!, rows[i0]!];
    refuses(() => judge(pulse, undefined, { C: swapped.join("\n") }), /outside the layer 1 of 10/, "shuffled");
    refuses(() => buildStackTransientResults(pulse.n, { C: pulse.C, fields: pulse.fields }, computeIndependentStack(pulse.n).slice(0, 9)), /independent solutions are for 9 slices/, "sets");
  });
});
