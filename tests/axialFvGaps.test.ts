// Plan 15: tests added for the survivors of the mutation run on the two-dimensional solution and its checks (scripts/mut-plan15-b1.cjs). Each test names the mutant it kills.
// Tolerances, fixed before the first run: the reductions 1e-9 K as in axialFv.test.ts; the carried error estimates equal to 1e-12 K (they are sums and differences of the same numbers).
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { StackModel, solveStackSteady, solveStackTransient } from "../src/core/axialFv";
import { buildTransientResults, computeIndependent } from "../src/core/transientResults";
import { solveTransientFv, steadyFv, TransientPin } from "../src/core/transientFv";
import { computeIndependentStack } from "../src/core/stackTransientResults";
import { stackModelOf, solveStackTransientReference, stackTransientReferenceFrom, StackTransientSolved } from "../src/core/stackReference";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

const plate = (over: Partial<TransientPin> = {}): TransientPin => ({
  slab: true,
  fuelInnerRadius: 0,
  fuelRadius: 4.1e-3,
  claddingInnerRadius: 4.1e-3,
  claddingOuterRadius: 4.67e-3,
  fuelCells: 20,
  claddingCells: 6,
  gapConductance: 5000,
  fuelK: { a: 3, b: 0 },
  fuelLaw: [3],
  claddingK: { a: 15, b: 0 },
  claddingLaw: [15],
  fuelC: { a: 3e6, b: 0 },
  fuelCLaw: [3e6],
  claddingC: { a: 2.5e6, b: 0 },
  claddingCLaw: [2.5e6],
  boundary: { kind: "convective", bulkTemperature: 573, heatTransferCoefficient: 30000 },
  power: () => 0,
  ...over,
});
const uniform = (pin: TransientPin, layers: number, q: number, extra: Partial<StackModel> = {}): StackModel => ({ pin, layers, height: 0.4, power: () => q, boundary: () => pin.boundary, ...extra });
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};

describe("the solver's guards and the iteration, each killing a mutant", () => {
  it("a constant conductivity with a heat capacity that depends on temperature is iterated: the transient equals solveTransientFv after a large power step (kills: counted as constant)", () => {
    const pin = plate({ fuelCLaw: [3e6, 2000], fuelC: { a: 3e6, b: 2000 }, claddingCLaw: [2.5e6, 1500], claddingC: { a: 2.5e6, b: 1500 } });
    const power = () => 4e5;
    const one = solveTransientFv({ ...pin, power }, { dt: 5, steps: 3, initialTemperature: 573, outputEvery: 1 });
    const r = solveStackTransient({ ...uniform(pin, 4, 0), power: () => power() }, { dt: 5, steps: 3, outputEvery: 1, initial: new Array(4 * 26).fill(573) });
    for (let j = 0; j < 4; j++) expect(maxDiff(Array.from(r.states[j]!.T.subarray(0, 26)), one.states[j]!.T), `output ${j}`).toBeLessThan(1e-9);
  });
  it("a constant fuel with a cladding conductivity that depends on temperature is iterated (kills: the cladding's law not looked at)", () => {
    const pin = plate({ claddingLaw: [10, 0.01], claddingK: { a: 10, b: 0.01 } });
    const one = steadyFv(pin, 3.2e5);
    const r = solveStackSteady(uniform(pin, 5, 3.2e5));
    expect(maxDiff(Array.from(r.T.subarray(0, 26)), one.T)).toBeLessThan(1e-9);
  });
  it("a wall that is not above 0 K in the result is refused (kills: a field at or below 0 K accepted)", () => {
    const pin = plate({ boundary: { kind: "surface-temperature", surfaceTemperature: 500 } });
    const L = 8e-3;
    const m: StackModel = { pin: { ...pin, fuelRadius: L / 2, claddingInnerRadius: L / 2, claddingOuterRadius: L, fuelCells: 8, claddingCells: 8, gapConductance: 1e13, claddingK: { a: 3, b: 0 }, claddingLaw: [3] }, layers: 8, height: 0.02, power: (j) => 1e8 * L * Math.cos((Math.PI * (j + 0.5)) / 8), boundary: () => pin.boundary, heatAllCells: true };
    expect(() => solveStackSteady(m)).toThrow(/above 0 K/);
  });
  it("a prescribed wall is the wall of every layer, and with the conduction off nothing flows along the height (kills: the wall of a prescribed layer; heat along the height with the conduction off)", () => {
    const pin = plate({ boundary: { kind: "surface-temperature", surfaceTemperature: 640 } });
    const r = solveStackSteady(uniform(pin, 4, 1e5, { power: (k) => 1e5 * (k + 1), axialConduction: false }));
    expect(Array.from(r.wall)).toEqual([640, 640, 640, 640]);
    expect(Array.from(r.axial)).toEqual([0, 0, 0]);
    expect(Math.max(...Array.from(solveStackSteady(uniform(pin, 4, 1e5, { power: (k) => 1e5 * (k + 1) })).axial.map(Math.abs)))).toBeGreaterThan(1);
  });
  it("a negative conductivity gives a matrix with a pivot that is not positive, refused as such (kills: the pivot check removed)", () => {
    const pin = plate({ fuelLaw: [-3], fuelK: { a: -3, b: 0 } });
    expect(() => solveStackSteady(uniform(pin, 3, 1e5))).toThrow(/pivot/);
  });
  it("a heat rate that is not a number is refused as such (kills: the finite check removed)", () => {
    expect(() => solveStackSteady({ ...uniform(plate(), 3, 1e5), power: () => NaN })).toThrow(/heat rates must be finite/);
  });
  it("a fractional number of steps is refused (kills: the whole-number check)", () => {
    expect(() => solveStackTransient(uniform(plate(), 3, 1e5), { dt: 0.1, steps: 2.5, outputEvery: 1, initial: new Array(78).fill(600) })).toThrow(/whole number/);
  });
});

describe("the trace is the hottest cell, and the extremes are the extremes (kills: the fuel's or the cladding's only; a maximum never recorded)", () => {
  it("a cladding that is the hottest part (a hot coolant, no heat) has a trace of its own", () => {
    const pin = plate({ boundary: { kind: "convective", bulkTemperature: 900, heatTransferCoefficient: 30000 } });
    const r = solveStackTransient(uniform(pin, 3, 0), { dt: 0.01, steps: 30, outputEvery: 10, initial: new Array(78).fill(600), trace: true });
    r.traces!.forEach((tr, k) => {
      const f = (s: Float64Array) => Array.from(s.subarray(k * 26, (k + 1) * 26));
      for (let j = 1; j < r.states.length; j++) {
        const cells = f(r.states[j]!.T);
        expect(tr.peakByStep[10 * j]).toBe(Math.max(...cells));
        expect(tr.claddingByStep[10 * j]).toBe(Math.max(...cells.slice(20)));
        expect(tr.fuelByStep[10 * j]).toBe(Math.max(...cells.slice(0, 20)));
      }
      expect(tr.peakByStep[30]).toBe(tr.claddingByStep[30]); // the cladding is the hotter solid
      expect(tr.claddingMax).toBe(Math.max(...tr.claddingByStep));
      expect(tr.fuelMax).toBe(Math.max(...tr.fuelByStep));
      expect(tr.claddingMin).toBe(Math.min(...tr.claddingByStep.map((_, i) => tr.claddingByStep[i]!), 600));
    });
  });
});

describe("the power history of the stack model (kills: the power before the first point and after the last)", () => {
  it("is the first value before the first time, the last value after the last, linear between, times the layer's factor", () => {
    const x = JSON.parse(read("tests/golden/offbeat-plate-stack/transient-pulse/normalized.json"));
    const t = x.transient;
    const m = stackModelOf(x);
    const f = (k: number) => m.power(k, 1e9) / t.linearHeatRate[t.linearHeatRate.length - 1];
    expect(m.power(5, -1) / f(5)).toBeCloseTo(t.linearHeatRate[0], 6);
    expect(m.power(5, 1e9) / f(5)).toBeCloseTo(t.linearHeatRate[t.linearHeatRate.length - 1], 6);
    const mid = 0.5 * (t.times[1] + t.times[2]);
    expect(m.power(5, mid) / f(5)).toBeCloseTo(0.5 * (t.linearHeatRate[1] + t.linearHeatRate[2]), 3);
    expect(m.power(0, t.times[1]) / m.power(5, t.times[1])).toBeLessThan(0.5); // the end layer makes little heat
  });
});

describe("the slice of the transient reference is that slice's, with the error estimates carried over (kills: the first layer's trace; the estimates not carried)", () => {
  const dir = join("tests", "golden", "offbeat-plate-stack", "transient-lossofcooling");
  const n = JSON.parse(read(dir, "normalized.json"));
  // the older form of the reference, whose estimates are the slices' own one-dimensional runs carried over (a solution without the coupled half-step and doubled-mesh runs); the coupled form is tested in codexFixesOpen.test.ts
  const solved = solveStackTransientReference(n);
  const { half: _h, fine: _f, ...older } = (solved as { solved: StackTransientSolved }).solved;
  const ref = stackTransientReferenceFrom(n, older);
  const sets = computeIndependentStack(n);
  const nf = n.mesh.fuelCells;
  it("each slice's trace and states are its own layer's", () => {
    for (const k of [0, 4, 9]) {
      const set = ref.sliceIndependent(k, sets[k]!);
      set.fv.states.forEach((s, j) => {
        expect(s.T).toEqual(Array.from(ref.solution.states[j]!.T.subarray(k * ref.solution.n, (k + 1) * ref.solution.n)));
        expect(s.wall).toBe(ref.solution.states[j]!.wall[k]);
      });
      expect(set.fv.trace!.peakByStep[set.fv.trace!.peakByStep.length - 1]).toBe(Math.max(...set.fv.states[set.fv.states.length - 1]!.T));
    }
    const a = ref.sliceIndependent(0, sets[0]!).fv.trace!.peakByStep;
    const b = ref.sliceIndependent(5, sets[5]!).fv.trace!.peakByStep;
    expect(a[a.length - 1]).not.toBe(b[b.length - 1]);
  });
  it("the doubled mesh's and the half step's differences from the two-dimensional solution are the slice's own one-dimensional ones", () => {
    const k = 3;
    const own = sets[k]!;
    const set = ref.sliceIndependent(k, own);
    set.fv.states.forEach((s, j) => {
      const dT = s.T.map((x, i) => x - own.fv.states[j]!.T[i]!);
      set.fv2.states[j]!.T.forEach((x, i) => {
        const coarse = i < 2 * nf ? Math.floor(i / 2) : nf + Math.floor((i - 2 * nf) / 2);
        expect(x - own.fv2.states[j]!.T[i]!).toBeCloseTo(dT[coarse]!, 11);
      });
      set.fvh.states[j]!.T.forEach((x, i) => expect(x - own.fvh.states[j]!.T[i]!).toBeCloseTo(dT[i]!, 11));
      expect(set.fvh.states[j]!.wall - own.fvh.states[j]!.wall).toBeCloseTo(s.wall - own.fv.states[j]!.wall, 11);
    });
    const peak = set.fv.trace!.peakByStep;
    const peakOwn = own.fv.trace!.peakByStep;
    set.fvh.trace!.peakByStep.forEach((x, m) => {
      if (m % 2 === 0) expect(x - own.fvh.trace!.peakByStep[m]!).toBeCloseTo(peak[m / 2]! - peakOwn[m / 2]!, 11);
    });
  });
});

describe("the energy balance with heat received along the height, called directly on a single plate (kills: the received heat out of the throughput; a wrong length accepted)", () => {
  const d = join("tests", "golden", "offbeat-plate", "pulse");
  const n = JSON.parse(read(d, "normalized.json"));
  const C = read(d, "C");
  const fields = readdirSync(join(root, d, "times")).sort((a, b) => Number(a) - Number(b)).map((t) => ({ time: Number(t), T: read(d, "times", t, "T") }));
  const set = computeIndependent(n);
  const base = buildTransientResults(n, { C, fields }, set);
  const check = (r: typeof base) => r.checks.find((c) => c.id === "energyBalance")!;
  it("an exchange of nothing changes nothing, and an enormous one is judged against itself, not against the small energy of the pulse", () => {
    const zeros = new Array(fields.length + 1).fill(0);
    const same = buildTransientResults(n, { C, fields }, set, undefined, zeros);
    expect(check(same).verdict).toBe("pass");
    const huge = buildTransientResults(n, { C, fields }, set, undefined, zeros.map((_, j) => (j === 0 ? 0 : 1e12)));
    // the gap is the exchange itself: about 100 % of the largest energy, not 1e12 over the energy of the pulse
    expect(check(huge).value!).toBeGreaterThan(0.99);
    expect(check(huge).value!).toBeLessThan(1.01);
    expect(check(huge).verdict).toBe("fail");
  });
  it("heat received for the wrong number of outputs is refused", () => {
    expect(() => buildTransientResults(n, { C, fields }, set, undefined, [0, 1])).toThrow(/received from the neighbours/);
  });
});
