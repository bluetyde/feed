// Conductivity laws as coefficient arrays (src/core/conductivity.ts): evaluation, the integral's primitive, the exact minimum over a range, the hot side of a
// conducting layer, and the polynomial fit of a table. Each is checked against something the code under test does not use: brute-force sampling, a
// numerical quadrature, exact recovery of a known polynomial, a fit done another way.
import { describe, expect, it } from "vitest";
import { degree, evaluate, fitPolynomial, minimum, primitive, solveHot } from "../src/core/conductivity";

const near = (a: number, b: number, rel = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(Math.abs(a), Math.abs(b), 1e-300));
const CUBIC = [2.0, 0.003, -1.2e-6, 2e-10];

describe("evaluate and primitive", () => {
  it("evaluate is the polynomial, for every degree and for the short arrays", () => {
    near(evaluate([3], 1000), 3);
    near(evaluate([4, -0.0006], 1000), 3.4);
    near(evaluate(CUBIC, 1000), 2 + 3 - 1.2 + 0.2);
    near(evaluate(CUBIC, 300), 2 + 0.9 - 1.2e-6 * 9e4 + 2e-10 * 2.7e7);
    expect(evaluate([], 5)).toBe(0);
  });
  it("the primitive differentiates back to k (central difference) and is zero at zero", () => {
    expect(primitive(CUBIC, 0)).toBe(0);
    for (const T of [300, 800, 1500]) {
      const h = 1e-3;
      near((primitive(CUBIC, T + h) - primitive(CUBIC, T - h)) / (2 * h), evaluate(CUBIC, T), 1e-8);
    }
  });
  it("the primitive's difference is the integral of k, against Simpson's rule", () => {
    const n = 2000;
    const a = 400;
    const b = 1700;
    const h = (b - a) / n;
    let s = evaluate(CUBIC, a) + evaluate(CUBIC, b);
    for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * evaluate(CUBIC, a + i * h);
    near(primitive(CUBIC, b) - primitive(CUBIC, a), (s * h) / 3, 1e-10);
  });
  it("degree is the highest nonzero coefficient", () => {
    expect(degree([3])).toBe(0);
    expect(degree([3, 0, 0, 0])).toBe(0);
    expect(degree([3, 0.1, 0, 0])).toBe(1);
    expect(degree([3, 0.1, 0, 1e-12])).toBe(3);
    expect(degree([3, 0, 5e-6])).toBe(2);
  });
});

describe("minimum over a range is the true minimum", () => {
  const brute = (c: number[], lo: number, hi: number) => {
    let m = Infinity;
    for (let i = 0; i <= 200000; i++) m = Math.min(m, evaluate(c, lo + ((hi - lo) * i) / 200000));
    return m;
  };
  const laws: [string, number[], number, number][] = [
    ["constant", [3], 300, 2000],
    ["rising line", [2, 0.001], 300, 2000],
    ["falling line", [4, -0.0006], 300, 2000],
    ["the cubic over its range (rising)", CUBIC, 300, 2500],
    ["a cubic with an interior minimum", [10, -0.02, 1.5e-5, 0], 100, 1200],
    ["a quadratic with an interior minimum", [10, -0.02, 1.5e-5], 100, 1200],
    ["a cubic with a minimum inside and a higher end", [8, -0.03, 4e-5, -1e-8], 200, 1500],
    ["a cubic whose turning points are outside the range", [5, 0.001, 0, 1e-10], 300, 900],
  ];
  for (const [name, c, lo, hi] of laws) {
    it(name, () => {
      const exact = minimum(c, lo, hi);
      const found = brute(c, lo, hi);
      expect(exact).toBeLessThanOrEqual(found + 1e-12);
      near(exact, found, 1e-9);
    });
  }
  it("a turning point outside the range is not used", () => {
    // the quadratic's minimum is at T = 666.7 K, below 800 K; over 800 to 1200 the lowest value is at 800
    near(minimum([10, -0.02, 1.5e-5], 800, 1200), evaluate([10, -0.02, 1.5e-5], 800));
  });
});

describe("solveHot: the temperature where the conductivity integral is reached", () => {
  it("identity: the primitive's difference between the cold side and the answer is the integral, for constant, linear, quadratic and cubic laws", () => {
    for (const c of [[3], [4, -0.0006], [10, -0.02, 1.5e-5], CUBIC, [2, 0.003, 0, 2e-10]]) {
      // 8000 W/m is within what the falling line can carry from 600 K (it reaches zero conductivity after about 11000)
      for (const integral of [0, 100, 1600, 8000]) {
        const hot = solveHot(c, 600, integral);
        near(primitive(c, hot) - primitive(c, 600), integral, 1e-10);
        expect(hot).toBeGreaterThanOrEqual(600);
      }
    }
  });
  it("a constant law is the straight formula, and a zero integral is the cold side", () => {
    near(solveHot([3], 600, 1500), 600 + 500);
    expect(solveHot(CUBIC, 700, 0)).toBe(700);
  });
  it("the linear case is the closed form (the quadratic root) to rounding", () => {
    const a = 4;
    const b = -0.0006;
    const hot = solveHot([a, b], 573, 1592);
    near(a * (hot - 573) + (b / 2) * (hot * hot - 573 * 573), 1592, 1e-12);
  });
  it("a cubic that turns negative before the integral is reached has no solution, said so", () => {
    expect(() => solveHot([1, 0.001, -2e-6, 0], 300, 1e6)).toThrow(RangeError);
    expect(() => solveHot([1, 0.001, -2e-6, 0], 300, 1e6)).toThrow(/reaches zero|no solution/);
  });
  it("a law that is not positive at the cold side, and a negative integral", () => {
    expect(() => solveHot(CUBIC, 0, 10)).not.toThrow(); // k(0) = 2
    expect(() => solveHot([-1, 0.01, 0, 1e-9], 10, 1)).toThrow(/not positive at the cold side/);
    expect(() => solveHot([3], 600, -1)).toThrow(/non-negative/);
  });
});

describe("fitPolynomial", () => {
  const sample = (c: number[], Ts: number[]) => Ts.map((T) => ({ T, k: evaluate(c, T) }));
  const Ts = [300, 450, 600, 800, 1000, 1250, 1500, 1800, 2000];

  it("recovers a cubic from its own samples to rounding, in the powers of T that will be written", () => {
    const f = fitPolynomial(sample(CUBIC, Ts), 3);
    f.coefficients.forEach((x, i) => near(x, CUBIC[i]!, 1e-8));
    expect(f.maxRelativeDeviation).toBeLessThan(1e-11);
  });
  it("recovers lower degrees and leaves the higher coefficients at zero", () => {
    const f1 = fitPolynomial(sample([4, -0.0006], Ts), 1);
    near(f1.coefficients[0]!, 4, 1e-10);
    near(f1.coefficients[1]!, -0.0006, 1e-9);
    expect(f1.coefficients[2]).toBe(0);
    expect(f1.coefficients[3]).toBe(0);
    const f2 = fitPolynomial(sample([10, -0.02, 1.5e-5], Ts), 2);
    near(f2.coefficients[2]!, 1.5e-5, 1e-8);
    expect(f2.coefficients[3]).toBe(0);
  });
  it("a degree-2 fit through three points is their interpolation (zero deviation)", () => {
    const f = fitPolynomial([{ T: 300, k: 14.9 }, { T: 400, k: 16.6 }, { T: 600, k: 19.8 }], 2);
    expect(f.maxRelativeDeviation).toBeLessThan(1e-12);
    near(evaluate(f.coefficients, 400), 16.6, 1e-11);
  });
  it("a line through the same three points leaves a stated deviation, at a stated temperature, and it is the least-squares line", () => {
    const pts = [{ T: 300, k: 14.9 }, { T: 400, k: 16.6 }, { T: 600, k: 19.8 }];
    const f = fitPolynomial(pts, 1);
    // the least-squares line by the textbook formulas, written here and not in the module
    const n = 3;
    const sx = 1300;
    const sy = 51.3;
    const sxx = 300 ** 2 + 400 ** 2 + 600 ** 2;
    const sxy = 300 * 14.9 + 400 * 16.6 + 600 * 19.8;
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    near(f.coefficients[1]!, slope, 1e-10);
    near(f.coefficients[0]!, intercept, 1e-10);
    const worst = Math.max(...pts.map((p) => Math.abs(intercept + slope * p.T - p.k) / p.k));
    near(f.maxRelativeDeviation, worst, 1e-9);
    expect(f.maxRelativeDeviation).toBeGreaterThan(0.001);
    expect([300, 400, 600]).toContain(f.worstAt);
    near(f.maxAbsoluteDeviation, Math.max(...pts.map((p) => Math.abs(intercept + slope * p.T - p.k))), 1e-9);
  });
  it("is least-squares: no nearby polynomial has a smaller sum of squares", () => {
    const noisy = Ts.map((T, i) => ({ T, k: evaluate(CUBIC, T) * (1 + 0.01 * Math.sin(3 * i)) }));
    const f = fitPolynomial(noisy, 2);
    const sse = (c: number[]) => noisy.reduce((s, p) => s + (evaluate(c, p.T) - p.k) ** 2, 0);
    const base = sse(f.coefficients);
    for (let i = 0; i < 3; i++) {
      for (const eps of [1e-3, -1e-3]) {
        const c = [...f.coefficients];
        c[i] = c[i]! * (1 + eps);
        expect(sse(c)).toBeGreaterThan(base);
      }
    }
  });
  it("is well conditioned at the temperatures of a hot fuel: a cubic over 1500 to 2900 K is recovered", () => {
    const hotTs = [1500, 1700, 1900, 2100, 2300, 2500, 2700, 2900];
    const c = [-1.5, 0.0092, -2.4e-6, 2.1e-10];
    const f = fitPolynomial(sample(c, hotTs), 3);
    expect(f.maxRelativeDeviation).toBeLessThan(1e-9);
    for (const T of [1600, 2000, 2800]) near(evaluate(f.coefficients, T), evaluate(c, T), 1e-8);
  });
  it("refuses too few points, a degree out of range, and a table with one temperature", () => {
    expect(() => fitPolynomial([{ T: 300, k: 1 }, { T: 400, k: 2 }], 2)).toThrow(/needs at least 3 points/);
    expect(() => fitPolynomial(sample(CUBIC, Ts), 0)).toThrow(/degree is 1, 2 or 3/);
    expect(() => fitPolynomial(sample(CUBIC, Ts), 4)).toThrow(/degree is 1, 2 or 3/);
    expect(() => fitPolynomial(sample(CUBIC, Ts), 1.5)).toThrow(RangeError);
    expect(() => fitPolynomial([{ T: 300, k: 1 }, { T: 300, k: 2 }], 1)).toThrow(/all the same/);
  });
  it("a table whose points are nearly the same temperature does not determine a cubic (the matrix is singular), said so", () => {
    const clustered = [300, 300.0000001, 300.0000002, 300.0000003, 1000].map((T, i) => ({ T, k: 3 + i }));
    expect(() => fitPolynomial(clustered, 3)).toThrow(/does not determine/); // two temperatures in all, whatever the number of points
    expect(() => fitPolynomial(clustered, 1)).not.toThrow(); // but a line through them is determined
    const same = [{ T: 300, k: 1 }, { T: 300, k: 2 }, { T: 300, k: 3 }, { T: 1000, k: 4 }];
    expect(() => fitPolynomial(same, 3)).toThrow(/does not determine/);
  });
});
