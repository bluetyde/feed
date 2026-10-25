// A thermo-elastic solution with properties that change from cell to cell (plan 17 M3, decision D3).
//
// thermoElastic.ts solves two solids with ONE modulus and ONE expansion coefficient each. In a pulse the fuel's temperature moves by hundreds of kelvin and its modulus by a third
// (plan 17 M0: one pair of constants is 25 to 100 % off in the contact pressure), so a transient is judged with the laws of temperature themselves: every cell carries its own
// Young's modulus (from its own temperature) and its own free thermal strain, both CONSTANT inside the cell. That is what OFFBEAT sees (M0: the strain piecewise constant per cell;
// a linear interpolation between cell temperatures gave pressure errors of 22 to 38 %).
//
// With a constant E, nu and free strain e* inside an annulus the radial balance has the exact solution u = A r + B / r (a uniform free strain adds no particular term), so a solid
// of N annuli is solved EXACTLY, not by a second discretisation: two unknowns per annulus, the displacement and the radial stress continuous at every annulus boundary, the
// stresses on the two surfaces, and the axial condition. With lambda = E nu / ((1 + nu)(1 - 2 nu)) and mu = E / (2 (1 + nu)), generalized plane strain (one axial strain e per solid):
//   eps_r = A - B / r^2,  eps_t = A + B / r^2,  eps_z = e
//   sigma_r = 2 (lambda + mu) A - 2 mu B / r^2 + lambda e - (3 lambda + 2 mu) e*,   sigma_t = 2 (lambda + mu) A + 2 mu B / r^2 + lambda e - (3 lambda + 2 mu) e*
//   sigma_z = 2 lambda A + (lambda + 2 mu) e - (3 lambda + 2 mu) e*      (constant in r inside the annulus: the axial force is a sum over annuli)
// Nothing here reads a file or a result of OFFBEAT, and nothing is shared with thermoElastic.ts except the types and the contact rule (the gap is affine in the total interface
// pressure, so two solves find the pressure that closes it). tests/thermoElasticLayers.test.ts checks it against thermoElastic.ts on a profile cut into many annuli.
import type { SolidField, ThermoElasticSolution } from "./thermoElastic";
import type { MechanicsSpec } from "./validate";

/** One annulus: constant Young's modulus (Pa), Poisson ratio and free isotropic thermal strain (dimensionless, from the stress-free temperature). */
export interface Layer {
  r0: number;
  r1: number;
  E: number;
  nu: number;
  strain: number;
}

const lame = (l: Layer) => ({ lambda: (l.E * l.nu) / ((1 + l.nu) * (1 - 2 * l.nu)), mu: l.E / (2 * (1 + l.nu)) });

interface Solved extends SolidField {
  /** The radial displacement of the outer and the inner surface, m. */
  outer: number;
  inner: number;
}

/**
 * One solid made of contiguous annuli (the first starts at the hole's radius, 0 for a solid pellet) under the pressure `pa` on its inner surface (ignored without a hole) and `pb`
 * on its outer one. Free axially: the axial force (per 2 pi) is `axialForce`; plane strain: the axial strain is zero.
 */
export function solveLayers(layers: Layer[], pa: number, pb: number, plane: MechanicsSpec["plane"], axialForce = 0): Solved {
  const N = layers.length;
  const hole = layers[0]!.r0 > 0;
  const free = plane === "free-axial";
  const n = 2 * N + (free ? 1 : 0);
  const M: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const rhs = new Array(n).fill(0);
  const iA = (i: number) => 2 * i;
  const iB = (i: number) => 2 * i + 1;
  const iE = 2 * N;
  const L = layers.map(lame);
  // sigma_r of annulus i at radius r as a row (coefficients of the unknowns) and a constant, so that sigma_r = row . x + constant
  const sigmaR = (i: number, r: number) => {
    const row = new Array(n).fill(0);
    row[iA(i)] = 2 * (L[i]!.lambda + L[i]!.mu);
    row[iB(i)] = (-2 * L[i]!.mu) / (r * r);
    if (free) row[iE] = L[i]!.lambda;
    return { row, k: -(3 * L[i]!.lambda + 2 * L[i]!.mu) * layers[i]!.strain };
  };
  let eq = 0;
  // outer surface: sigma_r = -pb
  {
    const s = sigmaR(N - 1, layers[N - 1]!.r1);
    M[eq] = s.row;
    rhs[eq++] = -pb - s.k;
  }
  // inner surface: sigma_r = -pa with a hole, B = 0 without one (a solid has no 1/r term at the axis)
  if (hole) {
    const s = sigmaR(0, layers[0]!.r0);
    M[eq] = s.row;
    rhs[eq++] = -pa - s.k;
  } else {
    M[eq]![iB(0)] = 1;
    eq++;
  }
  // the annulus boundaries: u and sigma_r continuous
  for (let i = 1; i < N; i++) {
    const r = layers[i]!.r0;
    const u = new Array(n).fill(0);
    u[iA(i - 1)] = r;
    u[iB(i - 1)] = 1 / r;
    u[iA(i)] = -r;
    u[iB(i)] = -1 / r;
    M[eq] = u;
    rhs[eq++] = 0;
    const lo = sigmaR(i - 1, r);
    const hi = sigmaR(i, r);
    M[eq] = lo.row.map((v, j) => v - hi.row[j]!);
    rhs[eq++] = hi.k - lo.k;
  }
  // the axial condition: free, the force of the solid is `axialForce`; plane strain, e = 0 (no unknown)
  if (free) {
    const row = new Array(n).fill(0);
    let k = 0;
    for (let i = 0; i < N; i++) {
      const w = (layers[i]!.r1 ** 2 - layers[i]!.r0 ** 2) / 2;
      row[iA(i)] += 2 * L[i]!.lambda * w;
      row[iE] += (L[i]!.lambda + 2 * L[i]!.mu) * w;
      k += -(3 * L[i]!.lambda + 2 * L[i]!.mu) * layers[i]!.strain * w;
    }
    M[eq] = row;
    rhs[eq++] = axialForce - k;
  }
  const x = gauss(M, rhs);
  const e = free ? x[iE]! : 0;
  const find = (r: number) => {
    for (let i = 0; i < N; i++) if (r <= layers[i]!.r1 || i === N - 1) return i;
    return N - 1;
  };
  const at = (r: number) => {
    const i = find(r);
    const A = x[iA(i)]!;
    const B = x[iB(i)]!;
    const { lambda, mu } = L[i]!;
    const thermal = (3 * lambda + 2 * mu) * layers[i]!.strain;
    return {
      ur: A * r + B / r,
      sigmaR: 2 * (lambda + mu) * A - (2 * mu * B) / (r * r) + lambda * e - thermal,
      sigmaTheta: 2 * (lambda + mu) * A + (2 * mu * B) / (r * r) + lambda * e - thermal,
      sigmaZ: 2 * lambda * A + (lambda + 2 * mu) * e - thermal,
    };
  };
  return { at, axialStrain: e, outer: at(layers[N - 1]!.r1).ur, inner: at(layers[0]!.r0).ur };
}

/** Gaussian elimination with partial pivoting; the systems are two unknowns per annulus (a few hundred at most). */
function gauss(M: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = M.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    if (!(Math.abs(a[col]![col]!) > 0)) throw new Error("singular layered thermo-elastic system");
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / a[col]![col]!;
      if (f === 0) continue;
      for (let cc = col; cc <= n; cc++) a[r]![cc]! -= f * a[col]![cc]!;
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = a[i]![n]!;
    for (let j = i + 1; j < n; j++) sum -= a[i]![j]! * x[j]!;
    x[i] = sum / a[i]![i]!;
  }
  return x;
}

/**
 * The fuel and the cladding, each in layers: the gap is the cladding's inner radius minus the fuel's outer radius. The gas presses on both surfaces with `gas` (Pa); when the solids
 * touch the radial stress at the interface is the contact pressure plus the gas pressure (OFFBEAT adds them), so only the total decides the closure. The end loads of a solid that
 * is free axially follow thermoElastic.ts (the cladding carries gas x the area inside it, the fuel gas x its own area: OFFBEAT's convention, found on the real solver).
 */
export function solveLayeredSlice(fuel: Layer[], cladding: Layer[], plane: MechanicsSpec["plane"], coolantPressure: number, gas = 0): ThermoElasticSolution {
  const fb = fuel[fuel.length - 1]!.r1;
  const fa = fuel[0]!.r0;
  const ca = cladding[0]!.r0;
  const fuelEnd = (gas * (fb * fb - fa * fa)) / 2;
  const cladEnd = (gas * ca * ca) / 2;
  const solve = (p: number) => ({ f: solveLayers(fuel, 0, p, plane, fuelEnd), g: solveLayers(cladding, p, coolantPressure, plane, cladEnd) });
  const gapAt = (s: ReturnType<typeof solve>) => ca - fb + s.g.inner - s.f.outer;
  const open = solve(gas);
  const freeGap = gapAt(open);
  if (freeGap > 0) return { fuel: open.f, cladding: open.g, gap: freeGap, freeGap, contact: false, contactPressure: 0 };
  const probe = 1e6;
  const slope = (gapAt(solve(gas + probe)) - freeGap) / probe;
  const total = gas - freeGap / slope;
  const closed = solve(total);
  return { fuel: closed.f, cladding: closed.g, gap: 0, freeGap, contact: true, contactPressure: total - gas };
}
