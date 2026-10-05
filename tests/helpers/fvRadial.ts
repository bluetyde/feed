// Independent reference: a small cell-centred finite-volume solve of the same pin, used to cross-check the
// closed forms by a second method (it shares no formula with src/core/closedForm.ts) and to exercise the
// refinement-order check the real solver must also pass. Test-only; not part of the product.

export interface FvPin {
  qPrime: number;
  fuelRadius: number;
  hGap: number;
  claddingInnerRadius: number;
  claddingOuterRadius: number;
  kFuel: (T: number) => number;
  kClad: (T: number) => number;
  hFilm: number;
  bulkTemperature: number;
  fuelCells: number;
  claddingCells: number;
}

export interface FvResult {
  /** Fuel cell-centre radii and temperatures, centre first. */
  fuelR: number[];
  fuelT: number[];
  /** Cladding cell-centre radii and temperatures, inner first. */
  cladR: number[];
  cladT: number[];
  /** Heat per length leaving the outer surface through the film. */
  outerHeat: number;
}

const TWO_PI = 2 * Math.PI;

function thomas(lower: number[], diag: number[], upper: number[], rhs: number[]): number[] {
  const n = diag.length;
  const c = new Array<number>(n).fill(0);
  const d = new Array<number>(n).fill(0);
  c[0] = (upper[0] ?? 0) / diag[0]!;
  d[0] = rhs[0]! / diag[0]!;
  for (let i = 1; i < n; i++) {
    const m = diag[i]! - lower[i]! * c[i - 1]!;
    c[i] = (upper[i] ?? 0) / m;
    d[i] = (rhs[i]! - lower[i]! * d[i - 1]!) / m;
  }
  const x = new Array<number>(n).fill(0);
  x[n - 1] = d[n - 1]!;
  for (let i = n - 2; i >= 0; i--) x[i] = d[i]! - c[i]! * x[i + 1]!;
  return x;
}

export function solveFv(p: FvPin): FvResult {
  const nf = p.fuelCells;
  const nc = p.claddingCells;
  const n = nf + nc;
  // face radii
  const faces: number[] = [];
  for (let i = 0; i <= nf; i++) faces.push((p.fuelRadius * i) / nf);
  const cladFaces: number[] = [];
  for (let i = 0; i <= nc; i++) cladFaces.push(p.claddingInnerRadius + ((p.claddingOuterRadius - p.claddingInnerRadius) * i) / nc);
  const centres: number[] = [];
  for (let i = 0; i < nf; i++) centres.push(0.5 * (faces[i]! + faces[i + 1]!));
  for (let i = 0; i < nc; i++) centres.push(0.5 * (cladFaces[i]! + cladFaces[i + 1]!));
  const source: number[] = [];
  for (let i = 0; i < nf; i++) source.push((p.qPrime * (faces[i + 1]! ** 2 - faces[i]! ** 2)) / p.fuelRadius ** 2);
  for (let i = 0; i < nc; i++) source.push(0);

  let T = new Array<number>(n).fill(p.bulkTemperature + 500);
  for (let iter = 0; iter < 200; iter++) {
    // conductance between cell i and i+1 (per unit length)
    const g: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      if (i < nf - 1) {
        const k = p.kFuel(0.5 * (T[i]! + T[i + 1]!));
        g.push((TWO_PI * k) / Math.log(centres[i + 1]! / centres[i]!));
      } else if (i === nf - 1) {
        // fuel last cell -> gap -> cladding first cell: three resistances in series
        const kf = p.kFuel(T[i]!);
        const kc = p.kClad(T[i + 1]!);
        const rF = Math.log(p.fuelRadius / centres[i]!) / (TWO_PI * kf);
        const rGap = 1 / (TWO_PI * p.fuelRadius * p.hGap);
        const rC = Math.log(centres[i + 1]! / p.claddingInnerRadius) / (TWO_PI * kc);
        g.push(1 / (rF + rGap + rC));
      } else {
        const k = p.kClad(0.5 * (T[i]! + T[i + 1]!));
        g.push((TWO_PI * k) / Math.log(centres[i + 1]! / centres[i]!));
      }
    }
    const kLast = p.kClad(T[n - 1]!);
    const rOutHalf = Math.log(p.claddingOuterRadius / centres[n - 1]!) / (TWO_PI * kLast);
    const gOut = 1 / (rOutHalf + 1 / (TWO_PI * p.claddingOuterRadius * p.hFilm));
    const lower = new Array<number>(n).fill(0);
    const diag = new Array<number>(n).fill(0);
    const upper = new Array<number>(n).fill(0);
    const rhs = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const gl = i > 0 ? g[i - 1]! : 0;
      const gr = i < n - 1 ? g[i]! : gOut;
      diag[i] = gl + gr;
      lower[i] = -gl;
      upper[i] = -(i < n - 1 ? g[i]! : 0);
      rhs[i] = source[i]! + (i === n - 1 ? gOut * p.bulkTemperature : 0);
    }
    const Tn = thomas(lower, diag, upper, rhs);
    let delta = 0;
    for (let i = 0; i < n; i++) delta = Math.max(delta, Math.abs(Tn[i]! - T[i]!));
    T = Tn;
    if (delta < 1e-10) break;
  }
  const kLast = p.kClad(T[n - 1]!);
  const gOut = 1 / (Math.log(p.claddingOuterRadius / centres[n - 1]!) / (TWO_PI * kLast) + 1 / (TWO_PI * p.claddingOuterRadius * p.hFilm));
  return { fuelR: centres.slice(0, nf), fuelT: T.slice(0, nf), cladR: centres.slice(nf), cladT: T.slice(nf), outerHeat: gOut * (T[n - 1]! - p.bulkTemperature) };
}
