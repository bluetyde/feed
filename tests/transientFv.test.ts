// The independent transient finite-volume solver against exact solutions (plan 08), and the exact solutions against themselves.
import { describe, expect, it } from "vitest";
import { adiabaticTemperature, besselJ, cylinderCooling, cylinderHeating, j0Zero } from "../src/core/transientExact";
import { solveTransientFv, storedEnergy, TransientPin } from "../src/core/transientFv";

describe("Bessel functions and the series", () => {
  it("J0 and J1 at known values", () => {
    expect(besselJ(0, 0)).toBeCloseTo(1, 12);
    expect(besselJ(0, 1)).toBeCloseTo(0.7651976865579666, 12);
    expect(besselJ(1, 1)).toBeCloseTo(0.4400505857449335, 12);
    expect(besselJ(0, 10)).toBeCloseTo(-0.2459357644513483, 12);
  });

  it("zeros of J0", () => {
    expect(j0Zero(1)).toBeCloseTo(2.404825557695773, 10);
    expect(j0Zero(2)).toBeCloseTo(5.520078110286311, 10);
    expect(j0Zero(10)).toBeCloseTo(30.634606468431975, 8);
  });

  it("the cooling series starts as a uniform excess and decays to zero", () => {
    // early times converge slowly (the initial step is a discontinuity at the surface), so check with many terms and a loose bound
    expect(Math.abs(cylinderCooling(0.0, 1e-4, 1, 1, 100, 300) - 100)).toBeLessThan(2);
    expect(cylinderCooling(0.3, 5, 1, 1, 100)).toBeLessThan(1e-9);
    // the fundamental mode governs late times: ratio of excess at two late times is exp(-l1^2 alpha dt / R^2)
    const l1 = j0Zero(1);
    const r = cylinderCooling(0.0, 1.0, 1, 1, 100) / cylinderCooling(0.0, 0.9, 1, 1, 100);
    expect(r).toBeCloseTo(Math.exp(-l1 * l1 * 0.1), 6);
  });

  it("the heating series is zero at t = 0 and reaches the steady parabola", () => {
    expect(cylinderHeating(0.4, 0, 1, 2, 1, 10, 800)).toBeCloseTo(0, 3);
    expect(cylinderHeating(0.4, 20, 1, 2, 1, 10)).toBeCloseTo((10 / (4 * 2)) * (1 - 0.16), 10);
  });
});

/** A pin whose cladding and gap are electrically thin: the fuel surface sits at the fixed outer temperature. */
const fuelOnly = (over: Partial<TransientPin> = {}): TransientPin => ({
  fuelInnerRadius: 0,
  fuelRadius: 0.004,
  claddingInnerRadius: 0.004,
  claddingOuterRadius: 0.0041,
  fuelCells: 100,
  claddingCells: 2,
  gapConductance: 1e12,
  fuelK: { a: 3, b: 0 },
  claddingK: { a: 1e9, b: 0 },
  fuelC: { a: 3e6, b: 0 },
  claddingC: { a: 1, b: 0 },
  boundary: { kind: "surface-temperature", surfaceTemperature: 500 },
  power: () => 0,
  ...over,
});
const alpha = 3 / 3e6;
const tau = 0.004 ** 2 / alpha; // R^2 / alpha = 16 s

describe("finite-volume solver against the exact cylinder solutions", () => {
  it("cooling of a hot cylinder: the centre follows the Bessel series (Crank-Nicolson, small step)", () => {
    const p = fuelOnly();
    const steps = 400;
    const dt = (0.5 * tau) / steps;
    const out = solveTransientFv(p, { dt, steps, initialTemperature: 800, outputEvery: 100, scheme: "crank-nicolson" });
    for (const s of out.states.slice(1)) {
      const exact = 500 + cylinderCooling(out.r[0]!, s.time, 0.004, alpha, 300);
      expect(Math.abs(s.T[0]! - exact), "t=" + s.time).toBeLessThan(0.05); // 5 dT / N^2 = 0.15 K is the spatial bound at 100 cells
    }
  });

  it("heating from a step in power: the whole profile follows the series", () => {
    const q3 = 5e8; // W/m3
    const qPrime = q3 * Math.PI * 0.004 ** 2;
    const p = fuelOnly({ power: () => qPrime });
    const steps = 400;
    const dt = (0.5 * tau) / steps;
    const out = solveTransientFv(p, { dt, steps, initialTemperature: 500, outputEvery: 200, scheme: "crank-nicolson" });
    for (const s of out.states.slice(1)) {
      let worst = 0;
      for (let i = 0; i < 100; i += 7) worst = Math.max(worst, Math.abs(s.T[i]! - (500 + cylinderHeating(out.r[i]!, s.time, 0.004, 3, alpha, q3))));
      expect(worst, "t=" + s.time).toBeLessThan(0.1);
    }
  });

  it("implicit Euler is first order in the step; Crank-Nicolson is second order", () => {
    const p = fuelOnly();
    const centre = (scheme: "implicit-euler" | "crank-nicolson", steps: number) => {
      const dt = (0.25 * tau) / steps;
      return solveTransientFv(p, { dt, steps, initialTemperature: 800, outputEvery: steps, scheme }).states[1]!.T[0]!;
    };
    const exactCentre = 500 + cylinderCooling(solveTransientFv(p, { dt: 1, steps: 1, initialTemperature: 800, outputEvery: 1 }).r[0]!, 0.25 * tau, 0.004, alpha, 300);
    const err = (scheme: "implicit-euler" | "crank-nicolson", steps: number) => Math.abs(centre(scheme, steps) - exactCentre);
    // spatial error is common to both; compare each scheme against its own finest run to isolate the time error
    const ref = centre("crank-nicolson", 4000);
    const t = (scheme: "implicit-euler" | "crank-nicolson", steps: number) => Math.abs(centre(scheme, steps) - ref);
    const ie = [t("implicit-euler", 50) / t("implicit-euler", 100), t("implicit-euler", 100) / t("implicit-euler", 200)];
    const cn = [t("crank-nicolson", 25) / t("crank-nicolson", 50)];
    for (const r of ie) expect(r).toBeGreaterThan(1.8), expect(r).toBeLessThan(2.2);
    expect(cn[0]).toBeGreaterThan(3.5);
    expect(err("crank-nicolson", 400)).toBeLessThan(0.1);
  });
});

describe("adiabatic pulse", () => {
  // no heat leaves (h tiny); uniform source in the fuel, so the fuel stays uniform and heats by the deposited energy per volume
  const pinWith = (fuelC: { a: number; b: number }, qPrimeOf: (t: number) => number): TransientPin => ({
    fuelInnerRadius: 0,
    fuelRadius: 0.0041,
    claddingInnerRadius: 0.00418,
    claddingOuterRadius: 0.00475,
    fuelCells: 20,
    claddingCells: 6,
    gapConductance: 5000,
    fuelK: { a: 3, b: 0 },
    claddingK: { a: 15, b: 0 },
    fuelC,
    claddingC: { a: 2.5e6, b: 0 },
    boundary: { kind: "convective", bulkTemperature: 300, heatTransferCoefficient: 1e-9 },
    power: qPrimeOf,
  });
  const area = Math.PI * 0.0041 ** 2;
  const triangle = (peak: number, width: number) => (t: number) => (t < 0 ? 0 : t < width / 2 ? (peak * 2 * t) / width : t < width ? (peak * 2 * (width - t)) / width : 0);
  const E3 = (peak: number, width: number) => (0.5 * peak * width) / area; // J/m3 deposited

  it("constant heat capacity: the fuel heats by E/c; trapezoid source is exact, the new-time source is first order", () => {
    const peak = 1e7;
    const width = 0.01;
    const exact = 300 + E3(peak, width) / 3e6;
    const run = (steps: number, source: "new" | "average") => solveTransientFv(pinWith({ a: 3e6, b: 0 }, triangle(peak, width)), { dt: width / steps, steps, initialTemperature: 300, outputEvery: steps, source }).states[1]!.T;
    const avg = run(100, "average");
    // the interior is untouched by the 0.1 mm of conduction in 10 ms; the surface cell loses a little across the gap
    expect(Math.max(...avg.slice(0, 10))).toBeCloseTo(exact, 3);
    expect(Math.min(...avg.slice(0, 10))).toBeCloseTo(exact, 3);
    expect(avg[19]).toBeLessThan(exact);
    // a coarse new-time source misses by a known amount at mid-pulse, and the error halves with the step
    const mid = (steps: number) => solveTransientFv(pinWith({ a: 3e6, b: 0 }, triangle(peak, width)), { dt: width / 2 / (steps / 2), steps: steps / 2, initialTemperature: 300, outputEvery: steps / 2 }).states[1]!.T[0]!;
    const exactMid = 300 + E3(peak, width) / 2 / 3e6;
    expect(mid(100) - exactMid).toBeCloseTo((exactMid - 300) / 50, 2); // 51/50 for 50 steps over the ramp: the right-endpoint rule
    expect((mid(100) - exactMid) / (mid(200) - exactMid)).toBeCloseTo(2, 1);
  });

  it("heat capacity linear in temperature: the fuel reaches the root of the integral of c dT = E", () => {
    const peak = 1e7;
    const width = 0.01;
    const c = { a: 0.9e6, b: 4170 }; // shaped like U-ZrH
    const exact = adiabaticTemperature(c.a, c.b, 300, E3(peak, width));
    const T = solveTransientFv(pinWith(c, triangle(peak, width)), { dt: width / 200, steps: 200, initialTemperature: 300, outputEvery: 200, source: "average" }).states[1]!.T;
    expect(Math.max(...T.slice(0, 10))).toBeCloseTo(exact, 3);
    expect(Math.min(...T.slice(0, 10))).toBeCloseTo(exact, 3);
    // a constant heat capacity taken at the starting temperature would be badly wrong (the point of the temperature dependence)
    expect(300 + E3(peak, width) / (c.a + c.b * 300)).toBeGreaterThan(exact + 100);
  });
});

describe("energy bookkeeping", () => {
  it("deposited energy equals stored energy plus the heat that left (implicit Euler, linear c, linear k)", () => {
    const p: TransientPin = {
      fuelInnerRadius: 0.001,
      fuelRadius: 0.0041,
      claddingInnerRadius: 0.00418,
      claddingOuterRadius: 0.00475,
      fuelCells: 20,
      claddingCells: 6,
      gapConductance: 5000,
      fuelK: { a: 4, b: -0.0006 },
      claddingK: { a: 15, b: 0 },
      fuelC: { a: 0.9e6, b: 4170 },
      claddingC: { a: 2.5e6, b: 0 },
      boundary: { kind: "convective", bulkTemperature: 573, heatTransferCoefficient: 30000 },
      power: (t) => (t < 0.05 ? 2e6 : 0),
    };
    const out = solveTransientFv(p, { dt: 0.001, steps: 400, initialTemperature: 573, outputEvery: 100 });
    for (const s of out.states.slice(1)) {
      const stored = storedEnergy(p, s.T, 573);
      expect(Math.abs(stored + s.rejected - s.deposited) / s.deposited, "t=" + s.time).toBeLessThan(1e-8);
    }
    expect(out.states[out.states.length - 1]!.rejected).toBeGreaterThan(0);
  });
});
