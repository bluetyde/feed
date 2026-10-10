// The independent thermo-elastic solution (src/core/thermoElastic.ts, docs/plans/09-mechanics.md M3) against textbook closed forms written out here from other formulas than
// the ones the module uses: Timoshenko's thermal stress of a long solid cylinder with free ends, the Lame thick cylinder under pressure, and the interference pressure of two
// cylinders found from their compliances. A verifier that is wrong would make every later comparison with OFFBEAT meaningless, so it is checked first.
import { describe, expect, it } from "vitest";
import { SolidSetup, solveSlice } from "../src/core/thermoElastic";

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const solid = (a: number, b: number, E: number, nu: number, alpha: number, theta: (r: number) => number): SolidSetup => ({ a, b, E, nu, alpha, theta });
const uniform = (t: number) => () => t;

describe("a free solid cylinder", () => {
  const R = 4e-3;
  const clad = solid(5e-3, 6e-3, 2e11, 0.3, 1e-5, uniform(0));
  it("uniform heating with free ends expands it freely: u = alpha theta r and no stress", () => {
    const s = solveSlice(solid(0, R, 2e11, 0.3, 1.2e-5, uniform(200)), clad, "free-axial", 0);
    for (const r of [0.5e-3, 2e-3, 4e-3]) {
      const p = s.fuel.at(r);
      expect(rel(p.ur, 1.2e-5 * 200 * r)).toBeLessThan(1e-12);
      for (const v of [p.sigmaR, p.sigmaTheta, p.sigmaZ]) expect(Math.abs(v)).toBeLessThan(1e-3);
    }
  });
  it("plane strain: u = (1 + nu) alpha theta r, sigma_z = -E alpha theta, sigma_r = sigma_theta = 0", () => {
    const s = solveSlice(solid(0, R, 2e11, 0.3, 1.2e-5, uniform(200)), clad, "plane-strain", 0);
    const p = s.fuel.at(2e-3);
    expect(rel(p.ur, 1.3 * 1.2e-5 * 200 * 2e-3)).toBeLessThan(1e-12);
    expect(rel(p.sigmaZ, -2e11 * 1.2e-5 * 200)).toBeLessThan(1e-12);
    expect(Math.abs(p.sigmaR) + Math.abs(p.sigmaTheta)).toBeLessThan(1e-3);
  });
});

describe("Timoshenko's long solid cylinder with free ends and theta = T0 (1 - r^2 / R^2)", () => {
  const R = 4.1e-3;
  const E = 1.9e11;
  const nu = 0.32;
  const alpha = 1.1e-5;
  const T0 = 700;
  const s = solveSlice(solid(0, R, E, nu, alpha, (r) => T0 * (1 - (r * r) / (R * R))), solid(5e-3, 6e-3, E, nu, alpha, uniform(0)), "free-axial", 0);
  // the integrals of theta s ds from 0 to r and to R, exact: T0 (r^2 / 2 - r^4 / (4 R^2)) and T0 R^2 / 4
  const Ir = (r: number) => T0 * ((r * r) / 2 - r ** 4 / (4 * R * R));
  const IR = (T0 * R * R) / 4;
  const k = (alpha * E) / (1 - nu);
  it("radial, hoop and axial stress are Timoshenko's formulas", () => {
    for (const f of [0.1, 0.3, 0.55, 0.8, 0.99]) {
      const r = f * R;
      const t = T0 * (1 - (r * r) / (R * R));
      const p = s.fuel.at(r);
      expect(Math.abs(p.sigmaR - k * (IR / (R * R) - Ir(r) / (r * r)))).toBeLessThan(2e-6 * Math.abs(k * T0) + 1e-3);
      expect(Math.abs(p.sigmaTheta - k * (IR / (R * R) + Ir(r) / (r * r) - t))).toBeLessThan(2e-6 * Math.abs(k * T0) + 1e-3);
      expect(Math.abs(p.sigmaZ - k * ((2 * IR) / (R * R) - t))).toBeLessThan(2e-6 * Math.abs(k * T0) + 1e-3);
    }
  });
  it("the radial stress is zero at the surface and the axial force is zero", () => {
    expect(Math.abs(s.fuel.at(R).sigmaR)).toBeLessThan(1);
    let F = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const r = ((i + 0.5) * R) / n;
      F += s.fuel.at(r).sigmaZ * r * (R / n);
    }
    expect(Math.abs(F) / (k * T0 * R * R)).toBeLessThan(1e-5);
  });
});

describe("the Lame thick cylinder", () => {
  const a = 4.18e-3;
  const b = 4.75e-3;
  const E = 1.9e11;
  const nu = 0.3;
  const fuel = solid(0, 4.1e-3, E, nu, 1e-5, uniform(0));
  it("external pressure on a thick tube with plane strain: sigma_r, sigma_theta and sigma_z = nu (sigma_r + sigma_theta)", () => {
    const pc = 15.5e6;
    const s = solveSlice(fuel, solid(a, b, E, nu, 1e-5, uniform(0)), "plane-strain", pc);
    for (const r of [a, 4.4e-3, b]) {
      const lamR = ((-pc * b * b) / (b * b - a * a)) * (1 - (a * a) / (r * r));
      const lamT = ((-pc * b * b) / (b * b - a * a)) * (1 + (a * a) / (r * r));
      const p = s.cladding.at(r);
      expect(Math.abs(p.sigmaR - lamR)).toBeLessThan(1e-9 * pc);
      expect(Math.abs(p.sigmaTheta - lamT) / Math.abs(lamT)).toBeLessThan(1e-9);
      expect(Math.abs(p.sigmaZ - nu * (lamR + lamT)) / Math.abs(nu * lamT)).toBeLessThan(1e-9);
    }
    expect(s.contact).toBe(false);
  });
});

describe("two cylinders that touch", () => {
  // uniform temperatures: the fuel expands by alpha_f theta_f, the cladding by alpha_c theta_c, and the gap closes into an interference pressure found from the compliances
  const Rf = 4.1e-3;
  const Rci = 4.12e-3;
  const Rco = 4.75e-3;
  const Ef = 1.8e11;
  const Ec = 2e11;
  const nuf = 0.32;
  const nuc = 0.3;
  const af = 4e-5;
  const ac = 1e-5;
  const th = 300;
  // plane strain: the fuel's surface moves in by (1 + nu_f)(1 - 2 nu_f) p Rf / E_f; the cladding's bore moves out by (1 + nu_c) p Rci / E_c [(1 - nu_c)(Rci^2 + Rco^2) / (Rco^2 - Rci^2) + nu_c]
  const cf = ((1 + nuf) * (1 - 2 * nuf) * Rf) / Ef;
  const cc = (((1 + nuc) * Rci) / Ec) * (((1 - nuc) * (Rci * Rci + Rco * Rco)) / (Rco * Rco - Rci * Rci) + nuc);
  const overlap = (1 + nuf) * af * th * Rf - (Rci - Rf); // plane strain: the free expansion is (1 + nu) alpha theta r; the cladding stays at the reference temperature
  const pExpected = overlap / (cf + cc);
  it("the interference pressure is the closed form, the gap is closed and the pressure is the radial stress on both surfaces", () => {
    const s = solveSlice(solid(0, Rf, Ef, nuf, af, uniform(th)), solid(Rci, Rco, Ec, nuc, ac, uniform(0)), "plane-strain", 0);
    expect(s.contact).toBe(true);
    expect(s.freeGap).toBeLessThan(0);
    expect(rel(s.contactPressure, pExpected)).toBeLessThan(1e-9);
    expect(s.gap).toBe(0);
    expect(rel(s.fuel.at(Rf).sigmaR, -pExpected)).toBeLessThan(1e-9);
    expect(rel(s.cladding.at(Rci).sigmaR, -pExpected)).toBeLessThan(1e-9);
    // the two surfaces meet: Rf + u_f = Rci + u_c
    expect(Math.abs(Rf + s.fuel.at(Rf).ur - (Rci + s.cladding.at(Rci).ur))).toBeLessThan(1e-15);
  });
  it("a gap that stays open has no pressure and its width is the free one", () => {
    const s = solveSlice(solid(0, Rf, Ef, nuf, 1e-5, uniform(th)), solid(Rci, Rco, Ec, nuc, ac, uniform(0)), "plane-strain", 0);
    expect(s.contact).toBe(false);
    expect(s.contactPressure).toBe(0);
    expect(rel(s.gap, Rci - Rf - (1 + nuf) * 1e-5 * th * Rf)).toBeLessThan(1e-12);
  });
  it("the coolant pressure raises the interface pressure of a closed gap", () => {
    const a = solveSlice(solid(0, Rf, Ef, nuf, af, uniform(th)), solid(Rci, Rco, Ec, nuc, ac, uniform(0)), "plane-strain", 0);
    const b = solveSlice(solid(0, Rf, Ef, nuf, af, uniform(th)), solid(Rci, Rco, Ec, nuc, ac, uniform(0)), "plane-strain", 20e6);
    expect(b.contactPressure).toBeGreaterThan(a.contactPressure);
  });
  it("a hole in the fuel carries no pressure and the radial balance holds in both solids for a graded temperature", () => {
    const s = solveSlice(solid(1e-3, Rf, Ef, nuf, 1.1e-5, (r) => 400 - 8e4 * (r - 1e-3)), solid(Rci, Rco, Ec, nuc, ac, (r) => 100 - 3e4 * (r - Rci)), "free-axial", 1e6);
    expect(Math.abs(s.fuel.at(1e-3).sigmaR)).toBeLessThan(1);
    // d sigma_r / dr + (sigma_r - sigma_theta) / r = 0, by a centred difference inside each solid
    for (const [f, r0, r1] of [[s.fuel, 1.3e-3, 3.8e-3], [s.cladding, 4.3e-3, 4.6e-3]] as const) {
      for (let i = 0; i <= 4; i++) {
        const r = r0 + ((r1 - r0) * i) / 4;
        const h = 1e-8;
        const d = (f.at(r + h).sigmaR - f.at(r - h).sigmaR) / (2 * h);
        const p = f.at(r);
        expect(Math.abs(d + (p.sigmaR - p.sigmaTheta) / r)).toBeLessThan(1e-4 * Math.abs(p.sigmaTheta / r) + 1e3);
      }
    }
  });
});
