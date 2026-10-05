// Second-method checks: the closed forms against an independent finite-volume solve (tests/helpers/fvRadial.ts),
// energy balance, refinement order, and tests of the verifier itself.

import { describe, expect, it } from "vitest";
import { closedForm, compositeConstantK, compositeLinearK, fuelTemperatureLinearK } from "../src/core/closedForm";
import { FvPin, solveFv } from "./helpers/fvRadial";

const base = { qPrime: 20000, fuelK: 3, fuelRadius: 0.0041, hGap: 5000, claddingInnerRadius: 0.00418, claddingOuterRadius: 0.00475, claddingK: 15, hFilm: 30000, bulkTemperature: 573 };

const fvOf = (c: typeof base, fuelCells: number, claddingCells: number, kFuel = (_T: number) => c.fuelK, kClad = (_T: number) => c.claddingK): FvPin => ({
  qPrime: c.qPrime,
  fuelRadius: c.fuelRadius,
  hGap: c.hGap,
  claddingInnerRadius: c.claddingInnerRadius,
  claddingOuterRadius: c.claddingOuterRadius,
  kFuel,
  kClad,
  hFilm: c.hFilm,
  bulkTemperature: c.bulkTemperature,
  fuelCells,
  claddingCells,
});

/** Largest fuel-profile error of the FV solve against the closed-form profile, at the FV cell centres. */
function fuelProfileError(c: typeof base, n: number): number {
  const fv = solveFv(fvOf(c, n, 8));
  const exact = compositeConstantK(c);
  let worst = 0;
  fv.fuelR.forEach((r, i) => {
    worst = Math.max(worst, Math.abs(fv.fuelT[i]! - closedForm.fuelProfile(c.qPrime, c.fuelK, c.fuelRadius, r, exact.fuelSurfaceT)));
  });
  return worst;
}

/** Exact cladding temperature at radius r (constant k), from the outer-surface temperature. */
const claddingAt = (c: typeof base, outerT: number, r: number) => outerT + (c.qPrime * Math.log(c.claddingOuterRadius / r)) / (2 * Math.PI * c.claddingK);

// Cell-centred second-order scheme: the expected discretization error is of order dT/N^2 (the refinement test below checks the order itself), so the tolerance is 5 dT/N^2, with dT the temperature rise across the region.
const fvTol = (dT: number, n: number) => (5 * dT) / (n * n);

describe("finite-volume cross-check of the closed forms", () => {
  it("agrees on the synthetic pin", () => {
    const exact = compositeConstantK(base);
    const fv = solveFv(fvOf(base, 400, 40));
    expect(Math.abs(fv.fuelT[0]! - closedForm.fuelProfile(base.qPrime, base.fuelK, base.fuelRadius, fv.fuelR[0]!, exact.fuelSurfaceT))).toBeLessThan(fvTol(exact.fuelDeltaT, 400));
    expect(Math.abs(fv.cladT[0]! - claddingAt(base, exact.claddingOuterT, fv.cladR[0]!))).toBeLessThan(fvTol(exact.claddingDeltaT, 40));
    // the centre itself differs from the first cell centre by the exact, tiny profile offset
    expect(Math.abs(fv.fuelT[0]! - exact.centreT)).toBeLessThan(0.01);
  });

  it("agrees on randomized pins (random radii, conductivities, coefficients)", () => {
    let s = 12345; // fixed seed, deterministic
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let n = 0; n < 25; n++) {
      const Rf = 0.003 + 0.003 * rnd();
      const c = {
        qPrime: 5000 + 40000 * rnd(),
        fuelK: 1.5 + 4 * rnd(),
        fuelRadius: Rf,
        hGap: 2000 + 10000 * rnd(),
        claddingInnerRadius: Rf + 0.00005 + 0.0002 * rnd(),
        claddingOuterRadius: 0,
        claddingK: 10 + 15 * rnd(),
        hFilm: 10000 + 40000 * rnd(),
        bulkTemperature: 500 + 100 * rnd(),
      };
      c.claddingOuterRadius = c.claddingInnerRadius + 0.0003 + 0.0008 * rnd();
      const exact = compositeConstantK(c);
      const fv = solveFv(fvOf(c, 300, 60));
      const fuelExact = closedForm.fuelProfile(c.qPrime, c.fuelK, c.fuelRadius, fv.fuelR[0]!, exact.fuelSurfaceT);
      expect(Math.abs(fv.fuelT[0]! - fuelExact), "fuel " + n).toBeLessThan(fvTol(exact.fuelDeltaT, 300));
      expect(Math.abs(fv.cladT[0]! - claddingAt(c, exact.claddingOuterT, fv.cladR[0]!)), "clad " + n).toBeLessThan(fvTol(exact.claddingDeltaT, 60));
      expect(Math.abs(fv.fuelT[0]! - exact.centreT) / (exact.centreT - c.bulkTemperature)).toBeLessThan(1e-3);
    }
  });

  it("agrees on the conductivity integral for k = a + b T", () => {
    const a = 4.0;
    const b = -0.0006;
    const exact = compositeLinearK({ ...base, fuelK: { a, b }, claddingK: { a: 15, b: 0 }, boundary: { kind: "convective", bulkTemperature: 573, hFilm: 30000 } });
    const fv = solveFv(fvOf(base, 400, 40, (T) => a + b * T));
    const rc = fv.fuelR[0]!;
    const exactAtCell = fuelTemperatureLinearK({ a, b }, base.qPrime, base.fuelRadius, rc, exact.fuelSurfaceT);
    expect(Math.abs(fv.fuelT[0]! - exactAtCell)).toBeLessThan(fvTol(exact.fuelDeltaT, 400));
    expect(exact.centreT).toBeCloseTo(1246.8586, 3);
  });

  it("conserves energy: heat leaving the outer surface equals q'", () => {
    const fv = solveFv(fvOf(base, 100, 20));
    expect(Math.abs(fv.outerHeat - base.qPrime) / base.qPrime).toBeLessThan(1e-9);
  });

  it("converges at second order under mesh refinement", () => {
    const e1 = fuelProfileError(base, 10);
    const e2 = fuelProfileError(base, 20);
    const e3 = fuelProfileError(base, 40);
    expect(e1 / e2).toBeGreaterThan(3.5);
    expect(e1 / e2).toBeLessThan(4.5);
    expect(e2 / e3).toBeGreaterThan(3.5);
    expect(e2 / e3).toBeLessThan(4.5);
  });
});

describe("tests of the verifier: a wrong run must fail the closed-form comparison", () => {
  const exact = compositeConstantK(base);
  const centreError = (c: typeof base) => Math.abs(solveFv(fvOf(c, 300, 40)).fuelT[0]! - exact.centreT);
  it("accepts the correct pin", () => expect(centreError(base)).toBeLessThan(0.01));
  it("rejects a wrong fuel conductivity", () => expect(centreError({ ...base, fuelK: 3.3 })).toBeGreaterThan(1));
  it("rejects a dropped gap (very large gap conductance)", () => expect(centreError({ ...base, hGap: 5e9 })).toBeGreaterThan(1));
  it("rejects a scaled power", () => expect(centreError({ ...base, qPrime: base.qPrime * 1.02 })).toBeGreaterThan(1));
  it("rejects swapped fuel and cladding conductivities", () => expect(centreError({ ...base, fuelK: 15, claddingK: 3 })).toBeGreaterThan(1));
});
