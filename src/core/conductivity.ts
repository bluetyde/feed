// Thermal conductivity laws as coefficient arrays (docs/conductivity-models.md). A law is [a0, a1, a2, a3]: k(T) = a0 + a1 T + a2 T^2 + a3 T^3 in W/m/K with T in
// kelvin (shorter arrays are the lower degrees: a constant is [k], a linear law [a, b]). OFFBEAT carries a cubic through its ZyRELAP model (par3 = -a2, see
// docs/spike/property-model-survey.md); a table is carried by fitting a polynomial to it, with the fit's deviation stated and bounded.
//
// Everything here is plain arithmetic on numbers: no case, no solver. The closed forms and the independent finite-volume solver use these laws; the case writer
// writes them.

import type { Conductivity } from "./validate";

export type Law = readonly number[];

/** The law of a normalized conductivity as coefficients: a constant is [k], a linear law [a, b], a polynomial its four coefficients. */
export function lawOf(k: Conductivity): Law {
  if (k.kind === "constant") return [k.k];
  if (k.kind === "linear") return [k.a, k.b];
  return k.coefficients;
}

/** The temperature range a law is stated to hold over; a constant has none. */
export function rangeOf(k: Conductivity): [number, number] | undefined {
  return k.kind === "constant" ? undefined : k.range;
}

/** k(T), Horner. */
export function evaluate(c: Law, T: number): number {
  let k = 0;
  for (let i = c.length - 1; i >= 0; i--) k = k * T + c[i]!;
  return k;
}

/** The conductivity integral's primitive K(T) = a0 T + a1 T^2/2 + a2 T^3/3 + a3 T^4/4, so that K(T2) - K(T1) is the integral of k from T1 to T2. */
export function primitive(c: Law, T: number): number {
  let K = 0;
  for (let i = c.length - 1; i >= 0; i--) K = K * T + c[i]! / (i + 1);
  return K * T;
}

/** The degree of a law: the highest coefficient that is not zero (0 for a constant). */
export function degree(c: Law): number {
  for (let i = c.length - 1; i > 0; i--) if (c[i] !== 0) return i;
  return 0;
}

/** The lowest value of k over [lo, hi], exactly: the end points and the real roots of dk/dT that lie inside. */
export function minimum(c: Law, lo: number, hi: number): number {
  const candidates = [lo, hi];
  const [, b = 0, cc = 0, d = 0] = c;
  // dk/dT = b + 2 cc T + 3 d T^2
  if (d !== 0) {
    const disc = 4 * cc * cc - 12 * d * b;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      candidates.push((-2 * cc + s) / (6 * d), (-2 * cc - s) / (6 * d));
    }
  } else if (cc !== 0) candidates.push(-b / (2 * cc));
  let m = Infinity;
  for (const T of candidates) if (T >= lo && T <= hi) m = Math.min(m, evaluate(c, T));
  return m;
}

/**
 * The temperature T_hot above T_cold at which the conductivity integral from T_cold reaches `integral` (the hot side of a conducting layer). Closed form for a
 * constant or linear law; for a higher degree a bisection on the primitive, which needs k > 0 all the way from T_cold to the answer (else RangeError: no solution).
 */
export function solveHot(c: Law, tCold: number, integral: number): number {
  if (integral < 0) throw new RangeError("the conductivity integral must be non-negative"); // NaN is not refused here: the case writer refuses a number that is not finite, with its own message
  if (degree(c) <= 1) {
    const a = c[0]!;
    const b = c[1] ?? 0;
    const kCold = a + b * tCold;
    if (kCold <= 0) throw new RangeError("conductivity is not positive at the cold side"); // the comparisons of closedForm.solveLinearK, so a NaN passes through as it did
    if (b === 0) return tCold + integral / a;
    const disc = kCold * kCold + 2 * b * integral;
    if (disc < 0) throw new RangeError("no real solution: conductivity reaches zero first");
    return tCold + (2 * integral) / (kCold + Math.sqrt(disc));
  }
  if (!(evaluate(c, tCold) > 0)) throw new RangeError("conductivity is not positive at the cold side");
  const base = primitive(c, tCold);
  let hi = tCold + 1;
  for (let i = 0; i < 60; i++) {
    if (!(minimum(c, tCold, hi) > 0)) throw new RangeError("conductivity reaches zero before the conductivity integral does: there is no solution");
    if (primitive(c, hi) - base >= integral) break;
    hi = tCold + 2 * (hi - tCold);
    if (i === 59) throw new RangeError("no temperature below 1e18 K reaches the conductivity integral");
  }
  let lo = tCold;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (primitive(c, mid) - base < integral) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export interface Fit {
  /** a0..a3 in W/m/K per K^i, as evaluated by `evaluate` (so exactly what is written to the solver). */
  coefficients: number[];
  /** The largest |k_fit - k_table| / k_table over the table's points, evaluated with the coefficients above. */
  maxRelativeDeviation: number;
  /** The same, as the largest absolute difference in W/m/K. */
  maxAbsoluteDeviation: number;
  /** The temperature where the largest relative deviation is. */
  worstAt: number;
}

function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-14) throw new RangeError("the table does not determine a polynomial of this degree (its points are too few or too close together)");
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      for (let k = col; k <= n; k++) M[r]![k]! -= f * M[col]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let k = i + 1; k < n; k++) s -= M[i]![k]! * x[k]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}

/**
 * Least-squares polynomial of the given degree (1 to 3) through (T, k) points, in a variable scaled to [-1, 1] so that a cubic over 300 to 2000 K is well conditioned,
 * then written out in powers of T. The deviation is measured on the coefficients as returned (the ones that will be used), not on the scaled fit.
 */
export function fitPolynomial(points: { T: number; k: number }[], degreeWanted: number): Fit {
  if (!Number.isInteger(degreeWanted) || degreeWanted < 1 || degreeWanted > 3) throw new RangeError("the fit degree is 1, 2 or 3");
  if (points.length < degreeWanted + 1) throw new RangeError(`a degree ${degreeWanted} fit needs at least ${degreeWanted + 1} points; the table has ${points.length}`);
  const Ts = points.map((p) => p.T);
  const lo = Math.min(...Ts);
  const hi = Math.max(...Ts);
  if (!(hi > lo)) throw new RangeError("the table's temperatures are all the same");
  const T0 = 0.5 * (lo + hi);
  const s = 0.5 * (hi - lo);
  const m = degreeWanted + 1;
  const A: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const b = new Array<number>(m).fill(0);
  for (const p of points) {
    const x = (p.T - T0) / s;
    for (let i = 0; i < m; i++) {
      b[i]! += x ** i * p.k;
      for (let j = 0; j < m; j++) A[i]![j]! += x ** (i + j);
    }
  }
  const q = solveLinearSystem(A, b); // k = sum q_j x^j
  // x = (T - T0) / s: expand sum q_j ((T - T0)/s)^j into powers of T by the binomial theorem
  const coefficients = [0, 0, 0, 0];
  for (let j = 0; j < m; j++) {
    for (let i = 0; i <= j; i++) {
      const binom = j === 0 || i === 0 || i === j ? 1 : j === 2 ? 2 : 3; // C(j, i) for j <= 3
      coefficients[i]! += (q[j]! / s ** j) * binom * (-T0) ** (j - i);
    }
  }
  let worst = 0;
  let worstAbs = 0;
  let at = points[0]!.T;
  for (const p of points) {
    const diff = Math.abs(evaluate(coefficients, p.T) - p.k);
    if (diff / p.k > worst) {
      worst = diff / p.k;
      at = p.T;
    }
    worstAbs = Math.max(worstAbs, diff);
  }
  return { coefficients, maxRelativeDeviation: worst, maxAbsoluteDeviation: worstAbs, worstAt: at };
}
