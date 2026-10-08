// The thermal conductivity of UO2 fuel with burnup, gadolinia and as-fabricated density: FRAPCON-3.4's modified NFI model (docs/spike/burnup-sourcing.md).
//
//   K95 = 1 / (A + a gad + B T + 0.00187 Bu + (1 - 0.9 exp(-0.04 Bu)) 0.038 Bu^0.28 h(T)) + (E / T^2) exp(-F / T),   h(T) = 1 / (1 + 396 exp(-Q / T))
//   K   = 1.0789 K95 d / (1 + 0.5 (1 - d))
//
// T in kelvin, Bu in GWd per tonne of heavy metal (= MWd per kg), gad the gadolinia weight fraction, d the as-fabricated density as a fraction of theoretical. Source:
// NUREG/CR-7024 (PNNL-19417, Luscher and Geelhood, 2010) Eq. 2.3-10 (page 2.11) and 2.3-11 (page 2.12), range of applicability in section 2.3.2 (page 2.20). OFFBEAT's
// `UO2MATPRO` model is this equation (its name is a misnomer); M0 showed it equals this arithmetic to 1e-5 (docs/spike/burnup-probe.md).
//
// Plain arithmetic on numbers, like src/core/conductivity.ts, which uses it as one kind of law.

/** The constants of Eq. 2.3-10 and 2.3-11, in OFFBEAT's `par1` to `par13` order (conductivityMatproUO2.C): A, B, the Bu coefficient, a, 0.9, 0.04, 0.038, 0.28, 396, Q, E, 2, F. */
export const NFI_PARAMETERS: readonly number[] = [0.0452, 0.000246, 0.00187, 1.1599, 0.9, 0.04, 0.038, 0.28, 396.0, 6380.0, 3.5e9, 2.0, 16361.0];
/** Eq. 2.3-11's factor, which OFFBEAT's code also uses. */
export const NFI_DENSITY_FACTOR = 1.0789;
/** The constant by which the model divides the burnup it is given (per tonne of oxide) to get GWd/tU: conductivityMatproUO2.C, `Bu / 1000 / 0.881`. */
export const NFI_OXIDE_TO_HEAVY_METAL = 0.881;
/** The range of applicability (section 2.3.2): temperature 300 to 3000 K, rod-average burnup 0 to 62 GWd/MTU, density 92 to 97 % TD, gadolinia 0 to 10 wt%. */
export const NFI_RANGE = { temperature: [300, 3000], burnup: [0, 62], densityFraction: [0.92, 0.97], gadolinia: [0, 0.1] } as const;

export interface NfiState {
  /** GWd per tonne of heavy metal (MWd/kgHM). */
  burnup: number;
  /** As-fabricated density as a fraction of theoretical. */
  densityFraction: number;
  /** Gadolinia weight fraction (0 for none). */
  gadolinia: number;
}

/** k(T) in W/m/K at a fixed burnup, density and gadolinia content. */
export function nfiConductivity(T: number, s: NfiState): number {
  const [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13] = NFI_PARAMETERS as [number, number, number, number, number, number, number, number, number, number, number, number, number];
  const Bu = s.burnup;
  const h = 1 / (1 + p9 * Math.exp(-p10 / T));
  const phonon = 1 / (p1 + p4 * s.gadolinia + p2 * T + p3 * Bu + (1 - p5 * Math.exp(-p6 * Bu)) * p7 * Math.pow(Bu, p8) * h);
  const electronic = (p11 / Math.pow(T, p12)) * Math.exp(-p13 / T);
  const d = s.densityFraction;
  return ((phonon + electronic) * NFI_DENSITY_FACTOR * d) / (1 + 0.5 * (1 - d));
}

// ---- the integral of k over temperature, by Gauss-Legendre quadrature on panels (the exponential terms have no closed form)

const GL_ORDER = 12;
const GL: { x: number[]; w: number[] } = (() => {
  const x: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < GL_ORDER; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (GL_ORDER + 0.5)); // a starting guess for the i-th root of P_n
    let dp = 1;
    for (let it = 0; it < 100; it++) {
      let p0 = 1;
      let p1 = z;
      for (let k = 2; k <= GL_ORDER; k++) {
        const p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      dp = (GL_ORDER * (z * p1 - p0)) / (z * z - 1); // P_n'(z)
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    x.push(z);
    w.push(2 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
})();

/** The Gauss-Legendre nodes and weights on [-1, 1] (exposed so a test can check them against known integrals). */
export const gaussLegendre = GL;

/** Panel width, K: k is smooth on this scale (the sharpest feature is the annealing term near 1000 K), and 12 points per panel are exact for degree 23. */
const PANEL = 100;

/** The integral of k from `lo` to `hi` (either order), W/m. */
export function nfiIntegral(lo: number, hi: number, s: NfiState): number {
  if (lo === hi) return 0;
  const sign = hi > lo ? 1 : -1;
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const panels = Math.max(1, Math.ceil((b - a) / PANEL));
  const h = (b - a) / panels;
  let sum = 0;
  for (let p = 0; p < panels; p++) {
    const mid = a + (p + 0.5) * h;
    for (let i = 0; i < GL_ORDER; i++) sum += GL.w[i]! * nfiConductivity(mid + 0.5 * h * GL.x[i]!, s);
  }
  return sign * 0.5 * h * sum;
}

/** The lowest k over [lo, hi]: the law is smooth but not monotone (the electronic term makes it rise at high temperature), so a scan, then a golden-section refinement of the best bracket. */
export function nfiMinimum(lo: number, hi: number, s: NfiState): number {
  const n = 256;
  let best = Infinity;
  let at = lo;
  const step = (hi - lo) / n;
  for (let i = 0; i <= n; i++) {
    const T = lo + i * step;
    const k = nfiConductivity(T, s);
    if (k < best) {
      best = k;
      at = T;
    }
  }
  let a = Math.max(lo, at - step);
  let b = Math.min(hi, at + step);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  for (let i = 0; i < 80; i++) {
    if (nfiConductivity(c, s) < nfiConductivity(d, s)) b = d;
    else a = c;
    c = b - g * (b - a);
    d = a + g * (b - a);
  }
  return Math.min(best, nfiConductivity(0.5 * (a + b), s));
}
