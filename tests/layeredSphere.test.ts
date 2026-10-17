// Plan 14, M3: the independent layered-sphere solution (src/core/layeredSphere.ts) against textbook closed forms and its own consistency conditions.
// Tolerances, fixed here BEFORE the first run (each with its reason):
//   TEXTBOOK        1e-7 of the layer's peak stress: the probe's solver agreed with the textbook shell to 6e-8 Pa on 1e8 Pa; the same linear algebra in double precision.
//   SPLIT           1e-7 of the peak: two layers of one material are one shell (probe: 1e-7 Pa).
//   EQUILIBRIUM     1e-6 of sigma / thickness: a central difference of order h^4 with h = thickness/1000; the probe's residual was 4e-3 Pa on 1e7.
//   CONTINUITY      1e-9 relative: u and sigma_r must agree across an interface to rounding.
//   HOLLOW (thermal) 1e-6 of the peak: the closed form's integrals are exact (analytic), ours use a 24-point Gauss-Legendre rule: exact to rounding for a smooth profile, 1e-6 is slack.
//   THIN WALL       7 %: sigma_t = p a / (2 t); the exact Lame value on the inner radius differs by about 5 % for 35 um on 350 um (plan 14), 7 % leaves 2 % for the arithmetic.
//   PROBE NUMBERS   5e-4 relative: the probe quoted its results to 4 or 5 digits (docs/spike/triso-mechanics-probe.md).
import { describe, expect, it } from "vitest";
import { lameSphere, LayeredSphere } from "../src/core/layeredSphere";

const um = 1e-6;
const TEXTBOOK = 1e-7;
const SPLIT = 1e-7;
const EQUILIBRIUM = 1e-6;
const CONTINUITY = 1e-9;
const HOLLOW = 1e-6;
const THIN_WALL = 0.07;
const PROBE = 5e-4;

const SiC = { E: 3.7e11, nu: 0.13 };
const IPyC = { E: 3.96e10, nu: 0.33 };

/** The residual of radial equilibrium d sigma_r / dr + 2 (sigma_r - sigma_t) / r at r, with a fourth-order central difference, scaled by thickness over stress. */
function equilibriumResidual(s: LayeredSphere, r: number, thickness: number, layer: number, scale: number): number {
  const h = thickness / 1000;
  const f = (x: number) => s.at(x, layer).sigmaR;
  const d = (-f(r + 2 * h) + 8 * f(r + h) - 8 * f(r - h) + f(r - 2 * h)) / (12 * h);
  const p = s.at(r, layer);
  return (Math.abs(d + (2 * (p.sigmaR - p.sigmaT)) / r) * thickness) / scale;
}

describe("the layered sphere against the textbook shell", () => {
  const a = 350 * um;
  const b = 385 * um;

  it("one SiC shell under 25 MPa inside and 0.1 MPa outside is the Lame sphere", () => {
    const s = new LayeredSphere([{ a, b, ...SiC }], 25e6, 0.1e6);
    const lame = lameSphere(a, b, 25e6, 0.1e6);
    const peak = lame.sigmaT(a);
    for (let k = 0; k <= 20; k++) {
      const r = a + ((b - a) * k) / 20;
      const p = s.at(r);
      expect(Math.abs(p.sigmaT - lame.sigmaT(r)) / peak).toBeLessThan(TEXTBOOK);
      expect(Math.abs(p.sigmaR - lame.sigmaR(r)) / peak).toBeLessThan(TEXTBOOK);
    }
    // the value the benchmark case quotes for the inner face, to its five digits (1.2519e8 Pa)
    expect(lame.sigmaT(a)).toBeCloseTo(1.2519e8, -3);
  });

  it("the displacement is the Lame displacement: u = r / E ((1 - nu) sigma_t - nu sigma_r)", () => {
    const s = new LayeredSphere([{ a, b, ...SiC }], 25e6, 0.1e6);
    const lame = lameSphere(a, b, 25e6, 0.1e6);
    for (const r of [a, (a + b) / 2, b]) {
      const u = (r / SiC.E) * ((1 - SiC.nu) * lame.sigmaT(r) - SiC.nu * lame.sigmaR(r));
      expect(Math.abs(s.at(r).u - u) / Math.abs(u)).toBeLessThan(TEXTBOOK);
    }
  });

  it("two layers of the same material are the one shell", () => {
    const m = (a + b) / 2;
    const two = new LayeredSphere([{ a, b: m, ...SiC }, { a: m, b, ...SiC }], 25e6, 0.1e6);
    const lame = lameSphere(a, b, 25e6, 0.1e6);
    const peak = lame.sigmaT(a);
    for (let k = 0; k <= 20; k++) {
      const r = a + ((b - a) * k) / 20;
      const p = two.at(r, r <= m ? 0 : 1);
      expect(Math.abs(p.sigmaT - lame.sigmaT(r)) / peak).toBeLessThan(SPLIT);
      expect(Math.abs(p.sigmaR - lame.sigmaR(r)) / peak).toBeLessThan(SPLIT);
    }
  });

  it("a thin shell carries sigma_t about p a / (2 t) (within the thick-wall correction)", () => {
    const t = b - a;
    const s = new LayeredSphere([{ a, b, ...SiC }], 25e6, 0);
    const mid = s.at((a + b) / 2).sigmaT;
    expect(Math.abs(mid - (25e6 * a) / (2 * t)) / ((25e6 * a) / (2 * t))).toBeLessThan(THIN_WALL);
  });
});

describe("signs", () => {
  const a = 350 * um;
  it("an inside pressure puts -p on the inner face and tension in the wall; an outside pressure compresses", () => {
    const s = new LayeredSphere([{ a, b: 385 * um, ...SiC }], 25e6, 0);
    expect(s.at(a).sigmaR).toBeCloseTo(-25e6, 0);
    expect(s.at(385 * um).sigmaR).toBeCloseTo(0, 0);
    expect(s.at(a).sigmaT).toBeGreaterThan(0);
    const o = new LayeredSphere([{ a, b: 385 * um, ...SiC }], 0, 25e6);
    expect(o.at(a).sigmaT).toBeLessThan(0);
    expect(o.at(385 * um).sigmaR).toBeCloseTo(-25e6, 0);
  });

  it("a shrinking inner carbon against a stiff SiC: tension in the carbon, compression in the SiC", () => {
    const s = new LayeredSphere([{ a, b: 390 * um, ...IPyC, eR: -0.01, eT: -0.01 }, { a: 390 * um, b: 425 * um, ...SiC }], 0, 0);
    expect(s.at(a).sigmaT).toBeGreaterThan(0);
    expect(s.at(425 * um).sigmaT).toBeLessThan(0);
    // and a swelling carbon does the opposite
    const w = new LayeredSphere([{ a, b: 390 * um, ...IPyC, eR: 0.01, eT: 0.01 }, { a: 390 * um, b: 425 * um, ...SiC }], 0, 0);
    expect(w.at(a).sigmaT).toBeLessThan(0);
    expect(w.at(425 * um).sigmaT).toBeGreaterThan(0);
  });

  it("a layer free to deform with a uniform free strain and no load has no stress and u = e r", () => {
    const e = -0.004;
    const s = new LayeredSphere([{ a, b: 390 * um, ...IPyC, eR: e, eT: e }], 0, 0);
    for (const r of [a, 370 * um, 390 * um]) {
      const p = s.at(r);
      expect(Math.abs(p.sigmaR)).toBeLessThan(1);
      expect(Math.abs(p.sigmaT)).toBeLessThan(1);
      expect(p.u / (e * r)).toBeCloseTo(1, 10);
    }
    // a uniform temperature change of a free shell is the same
    const th = new LayeredSphere([{ a, b: 390 * um, ...IPyC, theta: () => 5e-6 * 300 }], 0, 0);
    expect(Math.abs(th.at(370 * um).sigmaT)).toBeLessThan(1);
    expect(th.at(370 * um).u / (5e-6 * 300 * 370 * um)).toBeCloseTo(1, 10);
  });
});

describe("two layers with different moduli: the benchmark shell stacks of the probe", () => {
  const a = 350 * um;
  const m = 390 * um;
  const b = 425 * um;

  it("case 3 (IPyC and SiC under 25 MPa inside, 0.1 MPa outside) reproduces the probe's face stresses", () => {
    const s = new LayeredSphere([{ a, b: m, ...IPyC }, { a: m, b, ...SiC }], 25e6, 0.1e6);
    // the probe quoted the closed form at the IPyC's inner face as 8.779e6 Pa and at the SiC's inner face as 104.38e6 Pa
    expect(Math.abs(s.at(a).sigmaT - 8.779e6) / 8.779e6).toBeLessThan(PROBE);
    expect(Math.abs(s.at(m, 1).sigmaT - 104.38e6) / 104.38e6).toBeLessThan(PROBE);
  });

  it("case 4a (the IPyC with an isotropic free strain of -0.015) reproduces the probe's face stresses", () => {
    const s = new LayeredSphere([{ a, b: m, ...IPyC, eR: -0.015, eT: -0.015 }, { a: m, b, ...SiC }], 25e6, 0.1e6);
    // probe, creep1d.py on the same stack: 928.226e6 (IPyC inner face) and -847.187e6 (SiC)
    expect(Math.abs(s.at(a).sigmaT - 928.226e6) / 928.226e6).toBeLessThan(PROBE);
    expect(Math.abs(s.at(m, 1).sigmaT + 847.187e6) / 847.187e6).toBeLessThan(PROBE);
  });

  it("the radial stress and the displacement are continuous across the interface", () => {
    const s = new LayeredSphere([{ a, b: m, ...IPyC, eR: -0.012, eT: -0.003 }, { a: m, b, ...SiC }], 25e6, 0.1e6);
    const p0 = s.at(m, 0);
    const p1 = s.at(m, 1);
    expect(Math.abs(p0.sigmaR - p1.sigmaR) / Math.abs(p0.sigmaR)).toBeLessThan(CONTINUITY);
    expect(Math.abs(p0.u - p1.u) / Math.abs(p0.u)).toBeLessThan(CONTINUITY);
    // the tangential stress is not continuous (different moduli): a check that the two sides are not the same function
    expect(Math.abs(p0.sigmaT - p1.sigmaT)).toBeGreaterThan(1e6);
  });
});

describe("radial equilibrium d(sigma_r)/dr + 2 (sigma_r - sigma_t)/r = 0", () => {
  const a = 350 * um;
  const m = 390 * um;
  const b = 425 * um;
  const stack = (extra: object = {}, opts = {}) => new LayeredSphere([{ a, b: m, ...IPyC, ...extra }, { a: m, b, ...SiC }], 25e6, 0.1e6, opts);

  it("holds for pressure, for an isotropic free strain and for an anisotropic one", () => {
    for (const extra of [{}, { eR: -0.015, eT: -0.015 }, { eR: -0.012, eT: 0.004 }, { eR: 0.02, eT: -0.006 }]) {
      const s = stack(extra);
      for (const [lo, hi, layer, sc] of [[a, m, 0, 1e9], [m, b, 1, 1e9]] as const) {
        for (let k = 1; k < 10; k++) {
          const r = lo + ((hi - lo) * k) / 10;
          expect(equilibriumResidual(s, r, hi - lo, layer, sc)).toBeLessThan(EQUILIBRIUM);
        }
      }
    }
  });

  it("holds with a temperature-dependent thermal strain in both layers", () => {
    const T = (r: number) => 900 + 400 * ((1 / a - 1 / r) / (1 / a - 1 / b));
    const s = new LayeredSphere([{ a, b: m, ...IPyC, theta: (r) => 5.5e-6 * (T(r) - 300) }, { a: m, b, ...SiC, theta: (r) => 4.9e-6 * (T(r) - 300) }], 25e6, 0.1e6);
    for (const [lo, hi, layer] of [[a, m, 0], [m, b, 1]] as const) {
      for (let k = 1; k < 10; k++) expect(equilibriumResidual(s, lo + ((hi - lo) * k) / 10, hi - lo, layer, 1e9)).toBeLessThan(EQUILIBRIUM);
    }
  });

  it("NEGATIVE: leaving out the r ln r term of an anisotropic free strain breaks equilibrium and the test sees it", () => {
    const wrong = stack({ eR: -0.012, eT: 0.004 }, { dropAnisotropicTerm: true });
    let worst = 0;
    for (let k = 1; k < 10; k++) worst = Math.max(worst, equilibriumResidual(wrong, a + ((m - a) * k) / 10, m - a, 0, 1e9));
    expect(worst).toBeGreaterThan(1e3 * EQUILIBRIUM);
    // and the wrong answer is far from the right one in the SiC (the probe's 35 %)
    const right = stack({ eR: -0.012, eT: 0.004 });
    const rel = Math.abs(wrong.at(m, 1).sigmaT - right.at(m, 1).sigmaT) / Math.abs(right.at(m, 1).sigmaT);
    expect(rel).toBeGreaterThan(0.05);
  });

  it("the anisotropic term vanishes when the free strain is isotropic (the option changes nothing then)", () => {
    const x = stack({ eR: -0.015, eT: -0.015 });
    const y = stack({ eR: -0.015, eT: -0.015 }, { dropAnisotropicTerm: true });
    expect(y.at(m, 1).sigmaT).toBe(x.at(m, 1).sigmaT);
  });
});

describe("a thermal strain that varies with the radius: the hollow sphere of Timoshenko and Goodier", () => {
  // T(r) = T0 + c (1/a - 1/r): the conduction profile of a sphere. The integral of T s^2 ds is analytic: T0' s^3/3 + c'' s^2 / 2 with T = T1 + c/r... written out here.
  const a = 350 * um;
  const b = 385 * um;
  const E = 3.7e11;
  const nu = 0.13;
  const alpha = 4.9e-6;
  const Tref = 300;
  // T(r) = Ta + c (1/a - 1/r): T(a) = Ta, T(b) = Ta + c (1/a - 1/b) -> c = (T(b) - Ta) / (1/a - 1/b)
  const Ta = 1100;
  const cc = (1000 - Ta) / (1 / a - 1 / b);
  const T = (r: number) => Ta + cc * (1 / a - 1 / r);
  // integral of T s^2 from a to r: (Ta + cc/a) (r^3 - a^3)/3 - cc (r^2 - a^2)/2
  const I = (r: number) => (Ta + cc / a) * (r ** 3 - a ** 3) / 3 - (cc * (r ** 2 - a ** 2)) / 2;
  const k = (alpha * E) / (1 - nu);
  // theta = alpha (T - Tref): the Tref part is a uniform strain of a free shell and gives no stress, so the closed form uses T - Tref
  const J = (r: number) => I(r) - (Tref * (r ** 3 - a ** 3)) / 3;
  const Jtot = J(b);
  const sigmaR = (r: number) => 2 * k * (((r ** 3 - a ** 3) / ((b ** 3 - a ** 3) * r ** 3)) * Jtot - J(r) / r ** 3);
  const sigmaT = (r: number) => k * (((2 * r ** 3 + a ** 3) / ((b ** 3 - a ** 3) * r ** 3)) * Jtot + J(r) / r ** 3 - (T(r) - Tref));

  it("one free shell with the conduction profile matches the closed form", () => {
    const s = new LayeredSphere([{ a, b, E, nu, theta: (r) => alpha * (T(r) - Tref) }], 0, 0);
    const peak = Math.max(...[a, (a + b) / 2, b].map((r) => Math.abs(sigmaT(r))));
    expect(peak).toBeGreaterThan(1e6); // there is a stress to compare
    for (let n = 0; n <= 20; n++) {
      const r = a + ((b - a) * n) / 20;
      expect(Math.abs(s.at(r).sigmaT - sigmaT(r)) / peak).toBeLessThan(HOLLOW);
      expect(Math.abs(s.at(r).sigmaR - sigmaR(r)) / peak).toBeLessThan(HOLLOW);
    }
    // free surfaces
    expect(Math.abs(s.at(a).sigmaR) / peak).toBeLessThan(HOLLOW);
    expect(Math.abs(s.at(b).sigmaR) / peak).toBeLessThan(HOLLOW);
  });

  it("two layers of the same material with the same temperature field are the one shell", () => {
    const m = (a + b) / 2;
    const th = (r: number) => alpha * (T(r) - Tref);
    const two = new LayeredSphere([{ a, b: m, E, nu, theta: th }, { a: m, b, E, nu, theta: th }], 0, 0);
    const peak = Math.abs(sigmaT(a));
    for (let n = 0; n <= 20; n++) {
      const r = a + ((b - a) * n) / 20;
      expect(Math.abs(two.at(r, r <= m ? 0 : 1).sigmaT - sigmaT(r)) / peak).toBeLessThan(HOLLOW);
    }
  });

  it("a stack of thin sublayers, each with a uniform thermal strain, converges to the same stress (the probe's way of doing a temperature profile)", () => {
    const err = (M: number) => {
      const edges = Array.from({ length: M + 1 }, (_, i) => a + ((b - a) * i) / M);
      const sub = Array.from({ length: M }, (_, i) => ({ a: edges[i]!, b: edges[i + 1]!, E, nu, eR: alpha * (T((edges[i]! + edges[i + 1]!) / 2) - Tref), eT: alpha * (T((edges[i]! + edges[i + 1]!) / 2) - Tref) }));
      const s = new LayeredSphere(sub, 0, 0);
      let worst = 0;
      for (let i = 0; i < M; i++) {
        const r = (edges[i]! + edges[i + 1]!) / 2;
        worst = Math.max(worst, Math.abs(s.at(r, i).sigmaT - sigmaT(r)));
      }
      return worst / Math.abs(sigmaT(a));
    };
    const e20 = err(20);
    const e80 = err(80);
    const e320 = err(320);
    expect(e20).toBeGreaterThan(e80);
    expect(e80).toBeGreaterThan(e320);
    // first order in the sublayer width: a fourfold refinement cuts the error by more than three
    expect(e20 / e80).toBeGreaterThan(3);
    expect(e320).toBeLessThan(0.01);
  });

  it("the sign: the hot inside is in compression, the cool outside in tension", () => {
    expect(sigmaT(a)).toBeLessThan(0);
    expect(sigmaT(b)).toBeGreaterThan(0);
  });
});

describe("input the solver refuses", () => {
  const a = 350 * um;
  const ok = { a, b: 385 * um, ...SiC };
  it("an empty stack, a layer that is not between 0 and its outer radius, layers that do not touch, a non-positive modulus and a Poisson ratio of 0.5 or more", () => {
    expect(() => new LayeredSphere([], 0, 0)).toThrow(/at least one layer/);
    expect(() => new LayeredSphere([{ ...ok, a: 0 }], 0, 0)).toThrow(/radii/);
    expect(() => new LayeredSphere([{ ...ok, b: a }], 0, 0)).toThrow(/radii/);
    expect(() => new LayeredSphere([{ ...ok, b: a / 2 }], 0, 0)).toThrow(/radii/);
    expect(() => new LayeredSphere([ok, { a: 390 * um, b: 420 * um, ...IPyC }], 0, 0)).toThrow(/does not touch/);
    expect(() => new LayeredSphere([{ ...ok, E: 0 }], 0, 0)).toThrow(/E must be positive/);
    expect(() => new LayeredSphere([{ ...ok, nu: 0.5 }], 0, 0)).toThrow(/nu in/);
    expect(() => new LayeredSphere([{ ...ok, nu: -0.1 }], 0, 0)).toThrow(/nu in/);
    expect(() => new LayeredSphere([ok], 0, 0).at(500 * um)).toThrow(/outside the layered sphere/);
  });
});

describe("a thermal strain that is not a polynomial in the radius (the quadrature must be accurate, not only exact for 1/r profiles)", () => {
  // theta(r) = 1e-3 exp(4 (r - a) / (b - a)): T&G's hollow sphere with J(r) = integral of theta s^2 ds by Simpson's rule on 4000 intervals, written here
  const a = 350 * um;
  const b = 385 * um;
  const E = 3.7e11;
  const nu = 0.13;
  const theta = (r: number) => 1e-3 * Math.exp((4 * (r - a)) / (b - a));
  const J = (r: number) => {
    const n = 4000;
    const h = (r - a) / n;
    let sum = theta(a) * a * a + theta(r) * r * r;
    for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * theta(a + i * h) * (a + i * h) ** 2;
    return (sum * h) / 3;
  };
  const k = E / (1 - nu);
  const Jt = J(b);
  const sigmaR = (r: number) => 2 * k * (((r ** 3 - a ** 3) / ((b ** 3 - a ** 3) * r ** 3)) * Jt - J(r) / r ** 3);
  const sigmaT = (r: number) => k * (((2 * r ** 3 + a ** 3) / ((b ** 3 - a ** 3) * r ** 3)) * Jt + J(r) / r ** 3 - theta(r));
  it("matches the closed form at 21 radii", () => {
    const s = new LayeredSphere([{ a, b, E, nu, theta }], 0, 0);
    const peak = Math.max(...[a, (a + b) / 2, b].map((r) => Math.abs(sigmaT(r))));
    expect(peak).toBeGreaterThan(1e8);
    for (let n = 0; n <= 20; n++) {
      const r = a + ((b - a) * n) / 20;
      expect(Math.abs(s.at(r).sigmaT - sigmaT(r)) / peak).toBeLessThan(HOLLOW);
      expect(Math.abs(s.at(r).sigmaR - sigmaR(r)) / peak).toBeLessThan(HOLLOW);
    }
  });
});
