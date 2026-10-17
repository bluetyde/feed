// Plan 15, B1: the two-dimensional (x through the thickness or r, z along the height) finite-volume solution of a stack (src/core/axialFv.ts), against what must hold of it.
// The tolerances are fixed here, before the first run, with their reasons:
//   REDUCTION  1e-9 K absolute  identical layers, a flat shape and one coolant must equal N copies of the one-dimensional solution. The owner's decision after B0: the floor of
//                               an unpivoted double-precision banded solve at 1700 K is about 1e-10 K, so 1e-10 would test the arithmetic, not the model (docs/spike/axial-2d-probe.md, section 4).
//   CONSERVATION 1e-9 relative  the heat made equals the heat out through the coolant (steady) and the energy deposited equals stored plus rejected (transient); the Picard stop is 1e-10 K.
//   ORDER      successive error ratios between 3.7 and 4.3 when both cell sizes are halved (second order; the probe measured 3.78, 3.94, 3.99, 4.00), and for the exact solution's
//              neighbour layer sums 1e-9 relative.
//   ONE-DIMENSIONAL CONTRAST  the decoupled solution must follow the one-dimensional slab solution to 0.05 K (a mesh error only) and be at least 100 K from the exact two-dimensional one.
import { describe, expect, it } from "vitest";
import { STACK_UNKNOWNS_MAX, StackModel, solveStackSteady, solveStackTransient } from "../src/core/axialFv";
import { solveTransientFv, steadyFv, TransientPin } from "../src/core/transientFv";

const REDUCTION_K = 1e-9;
const CONSERVATION = 1e-9;

/** A plate of the golden stacks (half-thickness 4.1 mm, cladding 0.57 mm, constant conductivities 3 and 15, gap 5000), or a pin with a conductivity that depends on temperature. */
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
const pinKT = (): TransientPin => ({
  fuelInnerRadius: 0,
  fuelRadius: 4.1e-3,
  claddingInnerRadius: 4.18e-3,
  claddingOuterRadius: 4.75e-3,
  fuelCells: 20,
  claddingCells: 6,
  gapConductance: 5000,
  fuelK: { a: 5, b: -0.002 },
  fuelLaw: [5, -0.002],
  claddingK: { a: 10, b: 0.01 },
  claddingLaw: [10, 0.01],
  fuelC: { a: 3e6, b: 500 },
  fuelCLaw: [3e6, 500],
  claddingC: { a: 2.5e6, b: 300 },
  claddingCLaw: [2.5e6, 300],
  boundary: { kind: "convective", bulkTemperature: 573, heatTransferCoefficient: 30000 },
  power: () => 0,
});
const plateKT = (): TransientPin => plate({ fuelK: { a: 5, b: -0.002 }, fuelLaw: [5, -0.002], claddingK: { a: 10, b: 0.01 }, claddingLaw: [10, 0.01] });

const uniformModel = (pin: TransientPin, layers: number, q: number, extra: Partial<StackModel> = {}): StackModel => ({
  pin,
  layers,
  height: 0.4,
  power: () => q,
  boundary: () => pin.boundary,
  ...extra,
});
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};

describe("reduction: identical layers, a flat shape and one coolant are N copies of the one-dimensional solution", () => {
  const cases: [string, TransientPin, number][] = [
    ["plate, constant conductivity", plate(), 3.2e5],
    ["plate, conductivity that depends on temperature", plateKT(), 2.5e5],
    ["pin, conductivity that depends on temperature", pinKT(), 2.2e4],
  ];
  for (const [name, pin, q] of cases) {
    it(`steady ${name}: every layer equals steadyFv to ${REDUCTION_K} K (cells and wall)`, () => {
      const one = steadyFv(pin, q);
      const r = solveStackSteady(uniformModel(pin, 7, q));
      for (let k = 0; k < 7; k++) {
        expect(maxDiff(Array.from(r.T.subarray(k * r.n, (k + 1) * r.n)), one.T), `layer ${k}`).toBeLessThan(REDUCTION_K);
        expect(Math.abs(r.wall[k]! - one.wall), `wall ${k}`).toBeLessThan(REDUCTION_K);
      }
      // nothing flows along the height between identical layers
      expect(Math.max(...Array.from(r.axial).map(Math.abs))).toBeLessThan(1e-6);
    });
  }
  it("transient pin with k(T) and c(T), a power that changes in time: every layer equals solveTransientFv to the reduction limit, cells and wall at every output", () => {
    const pin = pinKT();
    const power = (t: number) => 2.2e4 * (1 + 0.5 * Math.sin(t / 3));
    const dt = 0.05;
    const steps = 120;
    const one = solveTransientFv({ ...pin, power }, { dt, steps, initialTemperature: 573, outputEvery: 20 });
    const r = solveStackTransient({ ...uniformModel(pin, 5, 0), power: (_k, t) => power(t) }, { dt, steps, outputEvery: 20, initial: new Array(5 * 26).fill(573) });
    expect(r.states).toHaveLength(one.states.length);
    r.states.forEach((s, j) => {
      for (let k = 0; k < 5; k++) {
        expect(maxDiff(Array.from(s.T.subarray(k * r.n, (k + 1) * r.n)), one.states[j]!.T), `output ${j} layer ${k}`).toBeLessThan(REDUCTION_K);
        expect(Math.abs(s.wall[k]! - one.states[j]!.wall)).toBeLessThan(REDUCTION_K);
      }
    });
  });
  it("with the conduction between layers switched off, layers that differ are N separate one-dimensional solutions, to the reduction limit", () => {
    const pin = plateKT();
    const q = [1e5, 2e5, 3.5e5, 3e5, 1.5e5];
    const model = uniformModel(pin, 5, 0, { power: (k) => q[k]!, axialConduction: false });
    const r = solveStackSteady(model);
    q.forEach((x, k) => expect(maxDiff(Array.from(r.T.subarray(k * r.n, (k + 1) * r.n)), steadyFv(pin, x).T), `layer ${k}`).toBeLessThan(REDUCTION_K));
    // and switched on the same layers differ: the conduction changes the end layers by more than the reduction limit
    const coupled = solveStackSteady({ ...model, axialConduction: true });
    expect(maxDiff(coupled.T, r.T)).toBeGreaterThan(0.1);
  });
});

describe("conservation: heat made is heat out, steady and transient, whatever the shape", () => {
  const shape = [0.2, 0.9, 1.5, 1.1, 0.3, 0.05];
  it("steady, a shape and a coolant that change along the height, k(T): the layers' heat out sums to the heat made, and each layer's balance includes the heat from its neighbours", () => {
    const pin = plateKT();
    const model: StackModel = { pin, layers: 6, height: 0.3, power: (k) => 2.4e5 * shape[k]!, boundary: (k) => ({ kind: "convective", bulkTemperature: 560 + 12 * k, heatTransferCoefficient: 25000 + 2000 * k }) };
    const r = solveStackSteady(model);
    expect(Math.abs(r.rejected - r.deposited) / r.deposited).toBeLessThan(CONSERVATION);
    for (let k = 0; k < 6; k++) {
      const inflow = (k > 0 ? r.axial[k - 1]! : 0) - (k < 5 ? r.axial[k]! : 0);
      expect(Math.abs(r.out[k]! - (r.made[k]! + inflow)) / r.made[k]!, `layer ${k}`).toBeLessThan(CONSERVATION);
    }
    // the conduction is real: the layer at the cold end gets heat from its neighbour
    expect(r.axial[0]!).toBeLessThan(0);
  });
  it("transient, a pin with k(T) and c(T), a power ramp and a coolant that changes in time: deposited = stored + rejected", () => {
    const pin = pinKT();
    const model: StackModel = {
      pin,
      layers: 6,
      height: 0.3,
      power: (k, t) => 2e4 * shape[k]! * (1 + t / 4),
      boundary: (k, t) => ({ kind: "convective", bulkTemperature: 573 + 3 * k + 2 * t, heatTransferCoefficient: 20000 + 1000 * k }),
    };
    const r = solveStackTransient(model, { dt: 0.1, steps: 60, outputEvery: 20, initial: new Array(6 * 26).fill(600) });
    for (const s of r.states.slice(1)) expect(Math.abs(s.deposited - s.stored - s.rejected) / s.deposited, `t = ${s.time}`).toBeLessThan(CONSERVATION);
  });
});

describe("an exact solution: a plate, a fixed wall, insulated ends, a source q0 cos(pi z / H)", () => {
  const L = 8e-3; // from the insulated mid-plane to the wall
  const H = 0.02;
  const k = 3;
  const q0 = 1e8; // W/m3
  const Tw = 1500;
  const lambda = Math.PI / H;
  const exact = (x: number, z: number) => Tw + (q0 / (k * lambda * lambda)) * Math.cos(lambda * z) * (1 - Math.cosh(lambda * x) / Math.cosh(lambda * L));
  /** Two equal materials with a gap so conductive that it is a plain face, M cells in each and M layers: both cell sizes halve with M. */
  const solve = (M: number, axialConduction = true) => {
    const pin: TransientPin = { slab: true, fuelInnerRadius: 0, fuelRadius: L / 2, claddingInnerRadius: L / 2, claddingOuterRadius: L, fuelCells: M, claddingCells: M, gapConductance: 1e13, fuelK: { a: k, b: 0 }, fuelLaw: [k], claddingK: { a: k, b: 0 }, claddingLaw: [k], fuelC: { a: 1, b: 0 }, claddingC: { a: 1, b: 0 }, boundary: { kind: "surface-temperature", surfaceTemperature: Tw }, power: () => 0 };
    // the layer's heat rate is the source at the layer's centre integrated over the thickness (what OFFBEAT samples)
    const model: StackModel = { pin, layers: M, height: H, power: (j) => q0 * L * Math.cos(lambda * ((j + 0.5) * H) / M), boundary: () => pin.boundary, heatAllCells: true, axialConduction };
    const r = solveStackSteady(model);
    let err = 0;
    let err1 = 0;
    let off1 = 0;
    for (let j = 0; j < M; j++) {
      const z = ((j + 0.5) * H) / M;
      for (let i = 0; i < 2 * M; i++) {
        const x = r.r[i]!;
        const T = r.T[j * r.n + i]!;
        err = Math.max(err, Math.abs(T - exact(x, z)));
        err1 = Math.max(err1, Math.abs(T - (Tw + (q0 * Math.cos(lambda * z) * (L * L - x * x)) / (2 * k))));
        off1 = Math.max(off1, Math.abs(Tw + (q0 * Math.cos(lambda * z) * (L * L - x * x)) / (2 * k) - exact(x, z)));
      }
    }
    return { err, err1, off1 };
  };
  const sizes = [4, 8, 16, 32, 64];
  const errors = sizes.map((M) => solve(M).err);
  it("the error falls at second order in both cell sizes (successive ratios between 3.7 and 4.3)", () => {
    for (let i = 1; i < errors.length; i++) {
      const ratio = errors[i - 1]! / errors[i]!;
      expect(ratio, `${sizes[i - 1]} to ${sizes[i]}: ${errors.join(", ")}`).toBeGreaterThan(3.7);
      expect(ratio).toBeLessThan(4.3);
    }
  });
  it("the one-dimensional solutions are far from the exact field (the cosine changes sign, so this is the amplitude), and the decoupled solver is exactly them; the coupled solver is not", () => {
    const M = 64; // (32 first: its mesh error, 0.065 K, was larger than my guess of the limit; the limit stays 0.05 K and the mesh is the finer)
    const dec = solve(M, false);
    expect(dec.err1).toBeLessThan(0.05);
    expect(dec.off1).toBeGreaterThan(100);
    expect(dec.err).toBeGreaterThan(100);
    expect(solve(M, true).err).toBeLessThan(0.01 * dec.err);
  });
});

describe("the limits", () => {
  it("a stack beyond the unknowns the reference solves is refused with the reason, never solved partly", () => {
    const pin = plate({ fuelCells: 200, claddingCells: 100 });
    expect(300 * 100).toBeGreaterThan(STACK_UNKNOWNS_MAX);
    expect(() => solveStackSteady(uniformModel(pin, 100, 1e5))).toThrow(/unknowns/);
  });
  it("a conductivity that makes the iteration diverge is refused, not returned", () => {
    const pin = plate({ fuelK: { a: 3, b: -0.01 }, fuelLaw: [3, -0.01] });
    expect(() => solveStackSteady(uniformModel(pin, 4, 8e5))).toThrow(/not positive|did not settle|not finite/);
  });
  it("bad layers, height, initial field or step are refused", () => {
    const pin = plate();
    expect(() => solveStackSteady(uniformModel(pin, 0, 1e5))).toThrow(/layers/);
    expect(() => solveStackSteady({ ...uniformModel(pin, 3, 1e5), height: 0 })).toThrow(/height/);
    expect(() => solveStackSteady({ ...uniformModel(pin, 3, 1e5), power: () => NaN })).toThrow(/finite/);
    expect(() => solveStackTransient({ ...uniformModel(pin, 3, 1e5) }, { dt: 0.1, steps: 2, outputEvery: 1, initial: [600] })).toThrow(/initial/);
    expect(() => solveStackTransient({ ...uniformModel(pin, 3, 1e5) }, { dt: 0, steps: 2, outputEvery: 1, initial: new Array(78).fill(600) })).toThrow(/step/);
  });
});

// ---- B3: the transient solver ------------------------------------------------------------------------------------------------------------------------------------------
// Tolerances fixed before the first run: per-layer energy balance 1e-9 relative (as CONSERVATION); the sum of the heat the layers receive from each other 1e-9 of the heat made;
// the time order of implicit Euler: successive error ratios between 1.8 and 2.2 when the step is halved (the probe measured 1.93 to 2.00); the cells of the trace are the cells.
describe("the transient solver: per-layer balance, the trace, and the exact solution in time", () => {
  it("each layer's energy balances with the heat from its neighbours: deposited + received = stored + rejected; what the layers receive sums to zero", () => {
    const pin = plateKT();
    const shape = [0.2, 0.9, 1.5, 1.1, 0.3, 0.05];
    const model: StackModel = { pin, layers: 6, height: 0.3, power: (k, t) => 2.4e5 * shape[k]! * (1 + t / 4), boundary: (k, t) => ({ kind: "convective", bulkTemperature: 560 + 12 * k + t, heatTransferCoefficient: 25000 + 2000 * k }) };
    const r = solveStackTransient(model, { dt: 0.1, steps: 60, outputEvery: 20, initial: new Array(6 * 26).fill(620) });
    for (const s of r.states.slice(1)) {
      for (let k = 0; k < 6; k++) {
        const gap = s.layerDeposited[k]! + s.layerAxialIn[k]! - s.layerStored[k]! - s.layerRejected[k]!;
        expect(Math.abs(gap) / s.layerDeposited[k]!, `layer ${k} at ${s.time}`).toBeLessThan(CONSERVATION);
      }
      expect(Math.abs(Array.from(s.layerAxialIn).reduce((x, y) => x + y, 0)) / s.deposited).toBeLessThan(CONSERVATION);
      expect(Math.abs(Array.from(s.layerStored).reduce((x, y) => x + y, 0) - s.stored) / Math.abs(s.stored)).toBeLessThan(CONSERVATION);
    }
    // the hot layers give heat to the cold end layers
    expect(r.states[3]!.layerAxialIn[0]!).toBeGreaterThan(0);
    expect(r.states[3]!.layerAxialIn[2]!).toBeLessThan(0);
  });
  it("the trace is the hottest cell of each layer at every step (step 0 included) and the extremes of each solid", () => {
    const pin = pinKT();
    const model = uniformModel(pin, 4, 2e4, { power: (k) => 2e4 * (k + 1) });
    const r = solveStackTransient(model, { dt: 0.2, steps: 25, outputEvery: 5, initial: new Array(4 * 26).fill(600), trace: true });
    expect(r.traces).toHaveLength(4);
    r.traces!.forEach((tr, k) => {
      expect(tr.peakByStep).toHaveLength(26);
      expect(tr.peakByStep[0]).toBe(600);
      expect(tr.fuelMin).toBeCloseTo(600, 9);
      expect(tr.claddingMin).toBeLessThan(600); // the coolant, 573 K, is below the start
      expect(tr.claddingMin).toBeGreaterThan(573);
      // the last peak is the hottest cell of that layer in the last output
      const last = r.states[r.states.length - 1]!.T;
      expect(tr.peakByStep[25]).toBe(Math.max(...Array.from(last.subarray(k * r.n, (k + 1) * r.n))));
      expect(tr.fuelMax).toBeGreaterThanOrEqual(tr.fuelByStep[25]!);
      expect(tr.peakByStep[25]).toBe(Math.max(tr.fuelByStep[25]!, tr.claddingByStep[25]!));
    });
    // a layer with more power is hotter; the traces differ between layers
    expect(r.traces![3]!.peakByStep[25]!).toBeGreaterThan(r.traces![0]!.peakByStep[25]!);
  });
  it("a deadline stops the run with the reason", () => {
    const model = uniformModel(plate(), 4, 1e5);
    expect(() => solveStackTransient(model, { dt: 0.1, steps: 50, outputEvery: 10, initial: new Array(4 * 26).fill(600), deadlineMs: -1 })).toThrow(/did not finish/);
  });
  describe("the exact solution in time: the same plate switched on at t = 0 from the wall temperature, a separable series", () => {
    const L = 8e-3;
    const H = 0.02;
    const k = 3;
    const rhoc = 3e6;
    const q0 = 1e8;
    const Tw = 1500;
    const lambda = Math.PI / H;
    const tEnd = 10;
    const exact = (x: number, z: number) => {
      let theta = (q0 / (k * lambda * lambda)) * (1 - Math.cosh(lambda * x) / Math.cosh(lambda * L));
      for (let m = 0; m < 4000; m++) {
        const mu = ((m + 0.5) * Math.PI) / L;
        const a = ((2 * q0) / (k * L)) * (m % 2 ? -1 : 1) / (mu * (lambda * lambda + mu * mu));
        theta -= a * Math.cos(mu * x) * Math.exp(-((k * (mu * mu + lambda * lambda)) / rhoc) * tEnd);
      }
      return Tw + Math.cos(lambda * z) * theta;
    };
    const run = (steps: number) => {
      const M = 32;
      const pin: TransientPin = { slab: true, fuelInnerRadius: 0, fuelRadius: L / 2, claddingInnerRadius: L / 2, claddingOuterRadius: L, fuelCells: M, claddingCells: M, gapConductance: 1e13, fuelK: { a: k, b: 0 }, fuelLaw: [k], claddingK: { a: k, b: 0 }, claddingLaw: [k], fuelC: { a: rhoc, b: 0 }, fuelCLaw: [rhoc], claddingC: { a: rhoc, b: 0 }, claddingCLaw: [rhoc], boundary: { kind: "surface-temperature", surfaceTemperature: Tw }, power: () => 0 };
      const model: StackModel = { pin, layers: M, height: H, power: (j) => q0 * L * Math.cos((lambda * (j + 0.5) * H) / M), boundary: () => pin.boundary, heatAllCells: true };
      const r = solveStackTransient(model, { dt: tEnd / steps, steps, outputEvery: steps, initial: new Array(M * 2 * M).fill(Tw) });
      const s = r.states[1]!;
      let err = 0;
      for (let j = 0; j < M; j++) for (let i = 0; i < 2 * M; i++) err = Math.max(err, Math.abs(s.T[j * r.n + i]! - exact(r.r[i]!, ((j + 0.5) * H) / M)));
      return { err, balance: Math.abs(s.deposited - s.stored - s.rejected) / s.deposited };
    };
    const steps = [5, 10, 20, 40, 80];
    const runs = steps.map(run);
    it("the error falls at first order in the step (successive ratios between 1.8 and 2.2), and the energy balance closes", () => {
      for (let i = 1; i < runs.length; i++) {
        const ratio = runs[i - 1]!.err / runs[i]!.err;
        expect(ratio, runs.map((x) => x.err.toPrecision(4)).join(", ")).toBeGreaterThan(1.8);
        expect(ratio).toBeLessThan(2.2);
      }
      runs.forEach((x) => expect(x.balance).toBeLessThan(CONSERVATION));
    });
  });
});
