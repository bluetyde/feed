// The steady operating state as a pulse's starting point (plan 08, decision 3): the independent solver's steady field, against the
// closed-form steady profiles, and as a fixed point of its own transient.
import { describe, expect, it } from "vitest";
import { annulusShape, fuelTemperatureLinearK, solveLinearK } from "../src/core/closedForm";
import { solveTransientFv, steadyFv, storedEnergy, TransientPin } from "../src/core/transientFv";

const pin = (over: Partial<TransientPin> = {}): TransientPin => ({
  fuelInnerRadius: 0,
  fuelRadius: 0.0041,
  claddingInnerRadius: 0.00418,
  claddingOuterRadius: 0.00475,
  fuelCells: 40,
  claddingCells: 12,
  gapConductance: 5000,
  fuelK: { a: 3, b: 0 },
  claddingK: { a: 15, b: 0 },
  fuelC: { a: 3e6, b: 0 },
  claddingC: { a: 2.5e6, b: 0 },
  boundary: { kind: "convective", bulkTemperature: 300, heatTransferCoefficient: 30000 },
  power: () => 0,
  ...over,
});

/** The closed-form temperature at radius r of a pin at linear heat rate q (the continuum solution; constant or linear k). */
function closedFormAt(p: TransientPin, q: number, r: number): number {
  const TWO_PI = 2 * Math.PI;
  const wall = p.boundary.kind === "convective" ? p.boundary.bulkTemperature + q / (TWO_PI * p.claddingOuterRadius * p.boundary.heatTransferCoefficient) : p.boundary.surfaceTemperature;
  if (r > p.claddingInnerRadius) return solveLinearK(p.claddingK.a, p.claddingK.b, wall, (q * Math.log(p.claddingOuterRadius / r)) / TWO_PI);
  const claddingInner = solveLinearK(p.claddingK.a, p.claddingK.b, wall, (q * Math.log(p.claddingOuterRadius / p.claddingInnerRadius)) / TWO_PI);
  const fuelSurface = claddingInner + q / (TWO_PI * p.fuelRadius * p.gapConductance);
  return fuelTemperatureLinearK(p.fuelK, q, p.fuelRadius, r, fuelSurface, p.fuelInnerRadius);
}

/** Cell-centre radii the independent solver uses (midpoints of the faces). */
function centres(p: TransientPin): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.fuelCells; i++) out.push(p.fuelInnerRadius + ((p.fuelRadius - p.fuelInnerRadius) * (i + 0.5)) / p.fuelCells);
  for (let i = 0; i < p.claddingCells; i++) out.push(p.claddingInnerRadius + ((p.claddingOuterRadius - p.claddingInnerRadius) * (i + 0.5)) / p.claddingCells);
  return out;
}

const worstDifference = (p: TransientPin, q: number) => {
  const s = steadyFv(p, q);
  const r = centres(p);
  return Math.max(...s.T.map((x, i) => Math.abs(x - closedFormAt(p, q, r[i]!))));
};

/** Errors against the closed form on meshes of 1x, 2x, 4x the cells, and the temperature range of the pin they are measured against. */
function convergence(over: Partial<TransientPin>, q: number): { errors: number[]; range: number } {
  const meshes = [[10, 4], [20, 8], [40, 16], [80, 32]];
  const errors = meshes.map(([nf, nc]) => worstDifference(pin({ ...over, fuelCells: nf!, claddingCells: nc! }), q));
  const fine = steadyFv(pin({ ...over, fuelCells: 80, claddingCells: 32 }), q);
  const outer = over.boundary && over.boundary.kind === "surface-temperature" ? over.boundary.surfaceTemperature : 300;
  return { errors, range: Math.max(...fine.T) - outer };
}

describe("steadyFv against the closed-form steady profile", () => {
  // Measured, not assumed: the difference from the continuum solution falls by 3.6 to 3.7 for every doubling of the cells (second order; the
  // largest difference is in the centre cell, whose value is a volume average, not the value at its midpoint radius).
  const secondOrder = (c: { errors: number[]; range: number }) => {
    for (let i = 1; i < c.errors.length; i++) {
      const ratio = c.errors[i - 1]! / c.errors[i]!;
      expect(ratio).toBeGreaterThan(3.2);
      expect(ratio).toBeLessThan(4.4);
    }
    expect(c.errors[c.errors.length - 1]! / c.range).toBeLessThan(3e-4);
  };

  it("constant conductivity, convective boundary: second-order convergence to the closed form", () => {
    secondOrder(convergence({}, 20000));
  });

  it("temperature-dependent conductivity in both solids", () => {
    secondOrder(convergence({ fuelK: { a: 5, b: -0.002 }, claddingK: { a: 12, b: 0.004 } }, 25000));
  });

  it("a prescribed surface temperature", () => {
    const over: Partial<TransientPin> = { boundary: { kind: "surface-temperature", surfaceTemperature: 560 } };
    secondOrder(convergence(over, 18000));
    expect(steadyFv(pin(over), 18000).wall).toBe(560);
  });

  it("annular fuel with an insulated hole", () => {
    const over: Partial<TransientPin> = { fuelInnerRadius: 0.0015 };
    secondOrder(convergence(over, 15000));
    // the hole's surface is the hottest point, as the closed form says
    const s = steadyFv(pin({ ...over, fuelCells: 40 }), 15000);
    expect(Math.max(...s.T)).toBeCloseTo(s.T[0]!, 9);
    expect(annulusShape(over.fuelInnerRadius!, 0.0041, over.fuelInnerRadius!)).toBeGreaterThan(0);
  });

  it("no power gives the coolant temperature everywhere", () => {
    const s = steadyFv(pin(), 0);
    for (const x of s.T) expect(x).toBeCloseTo(300, 9);
    expect(s.wall).toBeCloseTo(300, 9);
  });

  it("the temperature rises with the heat rate, and the outer wall follows the film law exactly", () => {
    const p = pin();
    const a = steadyFv(p, 10000);
    const b = steadyFv(p, 20000);
    expect(Math.max(...b.T)).toBeGreaterThan(Math.max(...a.T));
    // wall = bulk + q / (2 pi Ro h): a property of the discretisation (the film is a boundary resistance)
    expect(b.wall).toBeCloseTo(300 + 20000 / (2 * Math.PI * 0.00475 * 30000), 6);
  });
});
describe("the steady field is a fixed point of the transient", () => {
  it("held at the same heat rate, the field does not move (constant and linear properties)", () => {
    for (const over of [{}, { fuelK: { a: 5, b: -0.002 }, claddingK: { a: 12, b: 0.004 }, fuelC: { a: 2e6, b: 800 } }] as Partial<TransientPin>[]) {
      const p = pin(over);
      const q = 22000;
      const s = steadyFv({ ...p, power: () => q }, q);
      const run = solveTransientFv({ ...p, power: () => q }, { dt: 0.5, steps: 200, initialField: s.T, outputEvery: 200, trace: true });
      const end = run.states[run.states.length - 1]!;
      expect(Math.max(...end.T.map((x, i) => Math.abs(x - s.T[i]!)))).toBeLessThan(1e-7);
      expect(Math.abs(end.wall - s.wall)).toBeLessThan(1e-7);
      // and the heat leaving equals the heat made from the first step (the energy balance with a steady start)
      expect(Math.abs(end.rejected - end.deposited)).toBeLessThan(1e-6 * end.deposited);
      expect(Math.abs(storedEnergy({ ...p, power: () => q }, end.T, s.T))).toBeLessThan(1e-3);
    }
  });

  it("a power step from a steady state relaxes to the new steady state", () => {
    const p = pin();
    const s1 = steadyFv(p, 10000);
    const s2 = steadyFv(p, 30000);
    const run = solveTransientFv({ ...p, power: () => 30000 }, { dt: 0.2, steps: 400, initialField: s1.T, outputEvery: 400 });
    const end = run.states[run.states.length - 1]!.T;
    expect(Math.max(...end.map((x, i) => Math.abs(x - s2.T[i]!)))).toBeLessThan(0.01);
  });

  it("a scram from a steady state cools to the coolant and returns the stored heat", () => {
    const p = pin();
    const q = 20000;
    const s = steadyFv(p, q);
    const run = solveTransientFv({ ...p, power: () => 0 }, { dt: 0.2, steps: 800, initialField: s.T, outputEvery: 800 });
    const end = run.states[run.states.length - 1]!;
    expect(Math.max(...end.T)).toBeLessThan(300.01);
    // heat rejected = heat that was stored above the coolant temperature (nothing deposited)
    const stored = storedEnergy(p, s.T, 300) - 0;
    expect(Math.abs(end.rejected - stored)).toBeLessThan(2e-3 * stored);
  });

  it("exactly one of a uniform temperature and a field is required, and a bad field is refused", () => {
    const p = pin();
    expect(() => solveTransientFv(p, { dt: 1, steps: 1, outputEvery: 1 })).toThrow(/exactly one/);
    expect(() => solveTransientFv(p, { dt: 1, steps: 1, outputEvery: 1, initialTemperature: 300, initialField: new Array(52).fill(300) })).toThrow(/exactly one/);
    expect(() => solveTransientFv(p, { dt: 1, steps: 1, outputEvery: 1, initialField: [300, 300] })).toThrow(/positive finite/);
    expect(() => solveTransientFv(p, { dt: 1, steps: 1, outputEvery: 1, initialField: new Array(52).fill(NaN) })).toThrow(/positive finite/);
  });
});

describe("steadyFv refuses what it cannot trust", () => {
  it("a negative or non-finite heat rate", () => {
    expect(() => steadyFv(pin(), -1)).toThrow(/zero or more/);
    expect(() => steadyFv(pin(), Infinity)).toThrow(/zero or more/);
    expect(() => steadyFv(pin(), NaN)).toThrow(/zero or more/);
  });

  it("a conductivity that would turn non-positive on the way to a very hot centre", () => {
    const p = pin({ fuelK: { a: 4, b: -0.0035 } });
    expect(() => steadyFv(p, 60000)).toThrow(/conductivity|settle|finite/);
  });
});
