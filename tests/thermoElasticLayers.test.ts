// Plan 17 M3: the layered thermo-elastic solution (src/core/thermoElasticLayers.ts), written from the Lame and Timoshenko solutions and checked against hand-worked closed forms and
// against src/core/thermoElastic.ts (a different method: one solid with a continuous profile) cut into many annuli.
import { describe, expect, it } from "vitest";
import { solveLayers, solveLayeredSlice, type Layer } from "../src/core/thermoElasticLayers";
import { solveSlice } from "../src/core/thermoElastic";

/** n equal annuli between a and b with the given modulus, Poisson ratio and free strain as functions of the annulus's middle radius. */
const cut = (a: number, b: number, n: number, E: (r: number) => number, nu: number, strain: (r: number) => number): Layer[] =>
  Array.from({ length: n }, (_, i) => {
    const r0 = a + ((b - a) * i) / n;
    const r1 = a + ((b - a) * (i + 1)) / n;
    const m = (r0 + r1) / 2;
    return { r0, r1, E: E(m), nu, strain: strain(m) };
  });

describe("one tube under pressure: the Lame solution (hand-written)", () => {
  // a = 2 mm, b = 5 mm, E = 100 GPa, nu = 0.3, pressure 10 MPa inside: sigma_theta(a) = p (b^2 + a^2) / (b^2 - a^2) = 10 (25 + 4) / 21 = 13.8095 MPa, sigma_theta(b) = 2 p a^2 / (b^2 - a^2) = 2 * 10 * 4 / 21 = 3.8095 MPa
  const a = 2e-3;
  const b = 5e-3;
  const p = 10e6;
  for (const plane of ["plane-strain", "free-axial"] as const) {
    it(`${plane}: the stresses at both surfaces, one annulus or fifty`, () => {
      for (const n of [1, 50]) {
        const s = solveLayers(cut(a, b, n, () => 100e9, 0.3, () => 0), p, 0, plane);
        const inner = s.at(a);
        const outer = s.at(b);
        expect(inner.sigmaR).toBeCloseTo(-p, 0);
        expect(inner.sigmaTheta / 1e6).toBeCloseTo(13.8095, 3);
        expect(outer.sigmaR).toBeCloseTo(0, 0);
        expect(outer.sigmaTheta / 1e6).toBeCloseTo(3.8095, 3);
      }
    });
  }
  it("the displacement of the inner surface (plane strain): u(a) = (1 + nu) p a / E * ((1 - 2 nu) a^2 + b^2) / (b^2 - a^2) = 1.3 * 10e6 * 2e-3 / 100e9 * (0.4 * 4e-6 + 25e-6) / 21e-6", () => {
    const expected = ((1.3 * 10e6 * 2e-3) / 100e9) * ((0.4 * 4e-6 + 25e-6) / 21e-6);
    const s = solveLayers(cut(a, b, 1, () => 100e9, 0.3, () => 0), p, 0, "plane-strain");
    expect(s.at(a).ur / expected).toBeCloseTo(1, 10);
    expect(solveLayers(cut(a, b, 40, () => 100e9, 0.3, () => 0), p, 0, "plane-strain").at(a).ur / expected).toBeCloseTo(1, 10);
  });
});

describe("closed form (a) of the plan: a uniform free strain with nothing holding the solid", () => {
  it("a free tube heated equally has no stress and u = strain r, with a modulus that changes from annulus to annulus", () => {
    const strain = 17.2e-6 * 480; // 480 K above the stress-free temperature
    for (const plane of ["free-axial"] as const) {
      const s = solveLayers(cut(4.18e-3, 4.75e-3, 20, (r) => 150e9 + 4e13 * (r - 4.18e-3), 0.3, () => strain), 0, 0, plane);
      for (const r of [4.18e-3, 4.4e-3, 4.75e-3]) {
        const x = s.at(r);
        expect(Math.abs(x.sigmaR) + Math.abs(x.sigmaTheta) + Math.abs(x.sigmaZ)).toBeLessThan(1e-3);
        expect(x.ur / (strain * r)).toBeCloseTo(1, 12);
      }
      expect(s.axialStrain).toBeCloseTo(strain, 14);
    }
    // a solid pellet too (no hole, no 1/r term)
    const pellet = solveLayers(cut(0, 4.1e-3, 30, (r) => 60e9 - 1e12 * r, 0.32, () => 8e-3), 0, 0, "free-axial");
    expect(pellet.at(2e-3).ur / (8e-3 * 2e-3)).toBeCloseTo(1, 12);
    expect(Math.abs(pellet.at(2e-3).sigmaTheta)).toBeLessThan(1e-3);
  });
  it("held axially (plane strain) the same tube is stressed only in the axial direction: sigma_z = -E strain / (1 - nu... ) worked by hand for one annulus", () => {
    // eps_r = eps_t = strain (free), e = 0: sigma_r = sigma_t = lambda*0 ... with all three strains known: sigma_r = 2 mu (eps_r - e*) + lambda (tr - 3 e*) where tr = 2 strain + 0
    // = 2 mu * 0 + lambda (2 strain - 3 strain) = -lambda strain; sigma_z = 2 mu (0 - strain) + lambda (-strain) = -(2 mu + lambda) strain. The radial surfaces are free, so sigma_r must be 0:
    // A is not the free value then; solve in closed form: sigma_r = 2 (lambda + mu) A + lambda*0 - (3 lambda + 2 mu) s = 0 gives A = (3 lambda + 2 mu) s / (2 (lambda + mu)); sigma_z = 2 lambda A - (3 lambda + 2 mu) s
    const E = 100e9;
    const nu = 0.3;
    const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
    const mu = E / (2 * (1 + nu));
    const s = 5e-3;
    const A = ((3 * lambda + 2 * mu) * s) / (2 * (lambda + mu));
    const expected = 2 * lambda * A - (3 * lambda + 2 * mu) * s;
    const sol = solveLayers(cut(4e-3, 5e-3, 8, () => E, nu, () => s), 0, 0, "plane-strain");
    expect(sol.at(4.5e-3).sigmaZ / expected).toBeCloseTo(1, 12);
    expect(Math.abs(sol.at(4.5e-3).sigmaR)).toBeLessThan(1e-3);
    expect(sol.axialStrain).toBe(0);
  });
});

describe("interfaces and balance of a stack of annuli with different moduli", () => {
  const layers = cut(2e-3, 6e-3, 7, (r) => 40e9 + 2e13 * (r - 2e-3), 0.3, (r) => 1e-4 * (1 + 800 * (r - 2e-3)));
  const s = solveLayers(layers, 3e6, 1e6, "free-axial", 2e-3);
  it("the displacement and the radial stress are continuous across every boundary, the hoop stress is not (the modulus jumps)", () => {
    let jumpedHoop = 0;
    for (let i = 1; i < layers.length; i++) {
      const r = layers[i]!.r0;
      const lo = s.at(r);
      const hi = s.at(r + 1e-12);
      expect(Math.abs(hi.ur - lo.ur) / Math.abs(lo.ur)).toBeLessThan(1e-6);
      expect(Math.abs(hi.sigmaR - lo.sigmaR) / 1e6).toBeLessThan(1e-4);
      jumpedHoop = Math.max(jumpedHoop, Math.abs(hi.sigmaTheta - lo.sigmaTheta));
    }
    expect(jumpedHoop).toBeGreaterThan(1e4);
  });
  it("the radial balance d sigma_r / dr + (sigma_r - sigma_theta) / r = 0 holds inside every annulus (centred difference)", () => {
    for (const l of layers) {
      const r = (l.r0 + l.r1) / 2;
      const h = (l.r1 - l.r0) / 200;
      const d = (s.at(r + h).sigmaR - s.at(r - h).sigmaR) / (2 * h) + (s.at(r).sigmaR - s.at(r).sigmaTheta) / r;
      expect(Math.abs(d * (l.r1 - l.r0)) / 1e6).toBeLessThan(1e-4);
    }
  });
  it("the surface pressures and the axial force are what was asked", () => {
    expect(s.at(2e-3).sigmaR).toBeCloseTo(-3e6, 0);
    expect(s.at(6e-3).sigmaR).toBeCloseTo(-1e6, 0);
    let force = 0;
    for (const l of layers) force += s.at((l.r0 + l.r1) / 2).sigmaZ * ((l.r1 ** 2 - l.r0 ** 2) / 2);
    expect(force / 2e-3).toBeCloseTo(1, 8);
  });
});

describe("against thermoElastic.ts: one solid with a continuous profile, cut into 600 annuli", () => {
  // the fuel: a = 3 mm hole, b = 9 mm, E 60 GPa, alpha 12e-6, theta = 600 (1 - ((r - a)/(b - a))^2) + 100 K; the cladding: 9.05 to 9.6 mm, E 190 GPa, alpha 17e-6, theta 300 K to 280 K
  const fa = 3e-3;
  const fb = 9e-3;
  const ca = 9.05e-3;
  const cb = 9.6e-3;
  const thetaF = (r: number) => 600 * (1 - ((r - fa) / (fb - fa)) ** 2) + 100;
  const thetaC = (r: number) => 300 - (20 * (r - ca)) / (cb - ca);
  const alphaF = 12e-6;
  const alphaC = 17e-6;
  const setup = (gapShift: number) => {
    const fuel = { a: fa, b: fb, E: 60e9, nu: 0.32, alpha: alphaF, theta: thetaF };
    const clad = { a: ca - gapShift, b: cb - gapShift, E: 190e9, nu: 0.3, alpha: alphaC, theta: thetaC };
    const fuelL = cut(fa, fb, 600, () => 60e9, 0.32, (r) => alphaF * thetaF(r));
    const cladL = cut(ca - gapShift, cb - gapShift, 600, () => 190e9, 0.3, (r) => alphaC * thetaC(r));
    return { fuel, clad, fuelL, cladL };
  };
  for (const [name, shift, plane, gas] of [
    ["an open gap, free axially", 0, "free-axial", 0],
    ["a closed gap (contact), free axially", 0.08e-3, "free-axial", 0],
    ["a closed gap, plane strain, gas 5 MPa", 0.08e-3, "plane-strain", 5e6],
  ] as const) {
    it(name, () => {
      const { fuel, clad, fuelL, cladL } = setup(shift);
      const a = solveSlice(fuel, clad, plane, 1e5, gas);
      const b = solveLayeredSlice(fuelL, cladL, plane, 1e5, gas);
      expect(b.contact).toBe(a.contact);
      if (shift > 0) expect(a.contact).toBe(true);
      else expect(a.contact).toBe(false);
      if (a.contact) expect(b.contactPressure / a.contactPressure).toBeCloseTo(1, 3);
      else expect(b.gap / a.gap).toBeCloseTo(1, 3);
      for (const r of [fuelL[5]!, fuelL[150]!, fuelL[350]!, fuelL[595]!].map((l) => (l.r0 + l.r1) / 2)) {
        const x = a.fuel.at(r);
        const y = b.fuel.at(r);
        expect(y.ur / x.ur).toBeCloseTo(1, 3);
        for (const k of ["sigmaR", "sigmaTheta", "sigmaZ"] as const) expect(Math.abs(y[k] - x[k]) / 1e6).toBeLessThan(0.05);
      }
      for (const r of [cladL[20]!, cladL[300]!, cladL[590]!].map((l) => (l.r0 + l.r1) / 2)) {
        const x = a.cladding.at(r);
        const y = b.cladding.at(r);
        expect(y.ur / x.ur).toBeCloseTo(1, 3);
        for (const k of ["sigmaR", "sigmaTheta", "sigmaZ"] as const) expect(Math.abs(y[k] - x[k]) / 1e6).toBeLessThan(0.05);
      }
    });
  }
});
