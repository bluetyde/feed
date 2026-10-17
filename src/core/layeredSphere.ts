// The independent elastic solution of a coated particle's coating (plan 14, stage E, M3): concentric linear-elastic spherical shells, small strain, each with its own Young's modulus
// and Poisson's ratio and with free strains (strains the shell has with no stress): a thermal strain that may vary with the radius (isotropic, from a temperature field) and a uniform
// radial and tangential strain the case states (swelling, shrinkage). Written without reference to OFFBEAT and without the finite-volume code: it is the second method of FEED's rule.
//
// The theory (derived in docs/spike/triso-mechanics-probe.md and again in docs/triso-mechanics.md). With u(r) the radial displacement, eps_r = u', eps_t = u/r, free strains
// E_r(r), E_t(r) and c = E / ((1 + nu)(1 - 2 nu)):
//   sigma_r = c [ (1 - nu)(eps_r - E_r) + 2 nu (eps_t - E_t) ],  sigma_t = c [ (eps_t - E_t) + nu (eps_r - E_r) ]
// and radial equilibrium d sigma_r / dr + 2 (sigma_r - sigma_t) / r = 0 gives
//   u'' + 2 u'/r - 2 u/r^2 = f(r),  f = E_r' + 2 nu/(1 - nu) E_t' + 2 (1 - 2 nu)/(1 - nu) (E_r - E_t)/r,
// whose left side is d/dr (u' + 2u/r), so u = A r + B / r^2 + u_p with
//   * for an isotropic thermal strain theta(r):  u_p = (1 + nu)/(1 - nu) (1/r^2) integral_a^r theta s^2 ds
//   * for a uniform anisotropic free strain (e_r, e_t):  u_p = k r ln(r/a),  k = 2 (1 - 2 nu)(e_r - e_t) / (3 (1 - nu)).
// The second term is zero when e_r = e_t and is the one a displacement of the form A r + B/r^2 leaves out: without it radial equilibrium is violated (the probe's trap, a SiC stress 35 %
// wrong). 2N constants A_i, B_i follow from the pressure on the inner and outer surface and from continuity of the displacement and the radial stress at every interface.
//
// Sign: tension positive; a pressure p is a radial stress -p at the surface. Lengths in metres, stresses in Pa. Internally the radius is scaled by the inner radius so that the linear
// system is well conditioned for micrometre-thin shells.

export interface SphereLayer {
  /** Inner and outer radius, m. The layers must touch: a layer's outer radius is the next one's inner radius. */
  a: number;
  b: number;
  /** Young's modulus (Pa) and Poisson's ratio. */
  E: number;
  nu: number;
  /** A uniform free strain, radial and tangential (default 0): the layer's swelling or shrinkage, with no stress. */
  eR?: number;
  eT?: number;
  /** An isotropic free strain that varies with the radius (a thermal strain alpha (T(r) - Tref)), as a function of r in metres. Default none. */
  theta?: (r: number) => number;
}

export interface SphereOptions {
  /**
   * A hook for the negative test of plan 14 only: leave out the r ln r term that an anisotropic uniform free strain needs. The result then violates radial equilibrium (the equilibrium test
   * must fail). Never used by the case code.
   */
  dropAnisotropicTerm?: boolean;
}

export interface SpherePoint {
  /** Radial displacement, m. */
  u: number;
  /** Radial and tangential stress, Pa (tension positive); the two tangential stresses are equal in a sphere. */
  sigmaR: number;
  sigmaT: number;
  /** Total strains (radial, tangential), the elastic part is these minus the free strains. */
  epsR: number;
  epsT: number;
  layer: number;
}

/** Gauss-Legendre nodes and weights on [-1, 1] for n points (Newton iteration on the Legendre polynomial). */
function gaussLegendre(n: number): { x: number[]; w: number[] } {
  const x: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let dp = 1;
    for (let it = 0; it < 100; it++) {
      let p1 = 1;
      let p2 = 0;
      for (let j = 0; j < n; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j + 1) * z * p2 - j * p3) / (j + 1);
      }
      dp = (n * (z * p1 - p2)) / (z * z - 1);
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    x.push(z);
    w.push(2 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
}
const GL = gaussLegendre(24);

/** Gaussian elimination with partial pivoting. Throws when the matrix is singular. */
function solveLinear(m: number[][], y: number[]): number[] {
  const n = y.length;
  const a = m.map((row, i) => [...row, y[i]!]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i]![k]!) > Math.abs(a[p]![k]!)) p = i;
    [a[k], a[p]] = [a[p]!, a[k]!];
    if (!(Math.abs(a[k]![k]!) > 0)) throw new Error("the layered sphere's linear system is singular");
    for (let i = k + 1; i < n; i++) {
      const f = a[i]![k]! / a[k]![k]!;
      for (let j = k; j <= n; j++) a[i]![j]! -= f * a[k]![j]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = a[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= a[i]![j]! * x[j]!;
    x[i] = s / a[i]![i]!;
  }
  return x;
}

export class LayeredSphere {
  private readonly L: SphereLayer[];
  /** The length the radii are scaled by. */
  private readonly s: number;
  private A: number[] = [];
  private B: number[] = [];
  private readonly noLog: boolean;

  /** Solve the stack. `pIn` and `pOut` are the pressures on the inner and outer surface (Pa, compression positive). */
  constructor(layers: SphereLayer[], pIn: number, pOut: number, options: SphereOptions = {}) {
    if (layers.length < 1) throw new Error("a layered sphere needs at least one layer");
    this.L = layers.map((l) => ({ ...l }));
    this.s = layers[0]!.a;
    this.noLog = options.dropAnisotropicTerm === true;
    layers.forEach((l, i) => {
      if (!(l.a > 0 && l.b > l.a)) throw new Error("layer " + i + ": radii must satisfy 0 < a < b");
      if (!(l.E > 0 && l.nu >= 0 && l.nu < 0.5)) throw new Error("layer " + i + ": E must be positive and nu in [0, 0.5)");
      if (i > 0 && Math.abs(l.a - layers[i - 1]!.b) > 1e-12 * l.a) throw new Error("layer " + i + " does not touch the layer inside it");
    });
    const n = layers.length;
    const M: number[][] = Array.from({ length: 2 * n }, () => new Array<number>(2 * n).fill(0));
    const y = new Array<number>(2 * n).fill(0);
    let row = 0;
    const surface = (i: number, r: number, target: number) => {
      const t = this.sigmaRTerms(i, r);
      M[row]![2 * i] = t.ca;
      M[row]![2 * i + 1] = t.cb;
      y[row] = target - t.rhs;
      row++;
    };
    surface(0, layers[0]!.a, -pIn);
    surface(n - 1, layers[n - 1]!.b, -pOut);
    for (let i = 0; i + 1 < n; i++) {
      const r = layers[i]!.b;
      const x = r / this.s;
      // displacement continuity (scaled: u/s = A x + B/x^2 + up)
      M[row]![2 * i] = x;
      M[row]![2 * i + 1] = 1 / (x * x);
      M[row]![2 * i + 2] = -x;
      M[row]![2 * i + 3] = -1 / (x * x);
      y[row] = this.uParticular(i + 1, r) - this.uParticular(i, r);
      row++;
      const t0 = this.sigmaRTerms(i, r);
      const t1 = this.sigmaRTerms(i + 1, r);
      M[row]![2 * i] = t0.ca;
      M[row]![2 * i + 1] = t0.cb;
      M[row]![2 * i + 2] = -t1.ca;
      M[row]![2 * i + 3] = -t1.cb;
      y[row] = t1.rhs - t0.rhs;
      row++;
    }
    const sol = solveLinear(M, y);
    for (let i = 0; i < n; i++) {
      this.A.push(sol[2 * i]!);
      this.B.push(sol[2 * i + 1]!);
    }
  }

  get layers(): readonly SphereLayer[] {
    return this.L;
  }

  private c(i: number): number {
    const l = this.L[i]!;
    return l.E / ((1 + l.nu) * (1 - 2 * l.nu));
  }

  private k(i: number): number {
    if (this.noLog) return 0;
    const l = this.L[i]!;
    return (2 * (1 - 2 * l.nu) * ((l.eR ?? 0) - (l.eT ?? 0))) / (3 * (1 - l.nu));
  }

  /** The integral of theta(s) s^2 ds from the layer's inner radius to r, in the scaled radius (so a number of order theta). */
  private thetaIntegral(i: number, r: number): number {
    const l = this.L[i]!;
    if (!l.theta || r <= l.a) return 0;
    const lo = l.a / this.s;
    const hi = r / this.s;
    // 24-point Gauss-Legendre on up to 4 panels: the temperature profile of a thin shell is smooth, so this is exact to rounding
    const panels = 4;
    let sum = 0;
    for (let p = 0; p < panels; p++) {
      const p0 = lo + ((hi - lo) * p) / panels;
      const p1 = lo + ((hi - lo) * (p + 1)) / panels;
      const half = (p1 - p0) / 2;
      const mid = (p1 + p0) / 2;
      for (let q = 0; q < GL.x.length; q++) {
        const xs = mid + half * GL.x[q]!;
        sum += GL.w[q]! * half * l.theta(xs * this.s) * xs * xs;
      }
    }
    return sum;
  }

  /** The particular displacement of layer i at r, scaled by the length s (u_p / s). */
  private uParticular(i: number, r: number): number {
    const l = this.L[i]!;
    const x = r / this.s;
    const g = (1 + l.nu) / (1 - l.nu);
    return this.k(i) * x * Math.log(r / l.a) + (l.theta ? (g * this.thetaIntegral(i, r)) / (x * x) : 0);
  }

  /** The strains of the particular part at r (radial, tangential). */
  private strainParticular(i: number, r: number): { er: number; et: number } {
    const l = this.L[i]!;
    const x = r / this.s;
    const lg = Math.log(r / l.a);
    const k = this.k(i);
    const g = (1 + l.nu) / (1 - l.nu);
    let er = k * (lg + 1);
    let et = k * lg;
    if (l.theta) {
      const I = this.thetaIntegral(i, r);
      er += g * (l.theta(r) - (2 * I) / (x * x * x));
      et += (g * I) / (x * x * x);
    }
    return { er, et };
  }

  private freeStrain(i: number, r: number): { er: number; et: number } {
    const l = this.L[i]!;
    const th = l.theta ? l.theta(r) : 0;
    return { er: (l.eR ?? 0) + th, et: (l.eT ?? 0) + th };
  }

  /** sigma_r = ca A + cb B + rhs at radius r in layer i (A and B are the scaled constants). */
  private sigmaRTerms(i: number, r: number): { ca: number; cb: number; rhs: number } {
    const l = this.L[i]!;
    const c = this.c(i);
    const x = r / this.s;
    const sp = this.strainParticular(i, r);
    const fs = this.freeStrain(i, r);
    return {
      ca: c * (1 + l.nu),
      cb: (-2 * c * (1 - 2 * l.nu)) / (x * x * x),
      rhs: c * ((1 - l.nu) * (sp.er - fs.er) + 2 * l.nu * (sp.et - fs.et)),
    };
  }

  layerOf(r: number): number {
    for (let i = 0; i < this.L.length; i++) if (r >= this.L[i]!.a * (1 - 1e-12) && r <= this.L[i]!.b * (1 + 1e-12)) return i;
    throw new Error("radius " + r + " is outside the layered sphere");
  }

  /** The state at radius r. At an interface pass the layer to ask for one side (the radial stress and the displacement are continuous, the tangential stress is not). */
  at(r: number, layer?: number): SpherePoint {
    const i = layer ?? this.layerOf(r);
    const l = this.L[i]!;
    const c = this.c(i);
    const x = r / this.s;
    const A = this.A[i]!;
    const B = this.B[i]!;
    const sp = this.strainParticular(i, r);
    const fs = this.freeStrain(i, r);
    const epsR = A - (2 * B) / (x * x * x) + sp.er;
    const epsT = A + B / (x * x * x) + sp.et;
    return {
      u: this.s * (A * x + B / (x * x) + this.uParticular(i, r)),
      sigmaR: c * ((1 - l.nu) * (epsR - fs.er) + 2 * l.nu * (epsT - fs.et)),
      sigmaT: c * (epsT - fs.et + l.nu * (epsR - fs.er)),
      epsR,
      epsT,
      layer: i,
    };
  }
}

/** The textbook thick-walled sphere under an inside and an outside pressure (Lame): radial and tangential stress at r. Used by the tests and by the thin-wall sanity check. */
export function lameSphere(a: number, b: number, pIn: number, pOut: number): { sigmaR: (r: number) => number; sigmaT: (r: number) => number } {
  const den = b ** 3 - a ** 3;
  return {
    sigmaR: (r) => (pIn * a ** 3 * (r ** 3 - b ** 3) + pOut * b ** 3 * (a ** 3 - r ** 3)) / (r ** 3 * den),
    sigmaT: (r) => (pIn * a ** 3 * (b ** 3 + 2 * r ** 3) - pOut * b ** 3 * (a ** 3 + 2 * r ** 3)) / (2 * r ** 3 * den),
  };
}
