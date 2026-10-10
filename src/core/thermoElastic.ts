// An independent thermo-elastic solution of the same slice (docs/plans/09-mechanics.md M3), written without OFFBEAT: two concentric annular cylinders (the fuel, with or without a
// central hole, and the cladding) with constant properties, the closed-form temperatures of the case, the coolant pressure on the cladding and a gap that either stays open or
// closes into a contact.
//
// For one solid with constant E, nu, alpha and theta(r) = T(r) - Tref, small strain, an axial strain e that does not depend on r (generalized plane strain):
//   u(r)    = A r + B / r + k I(r) / r,      k = (1 + nu) alpha / (1 - nu),   I(r) = integral from a to r of theta s ds
//   eps_r   = A - B / r^2 + k theta - k I / r^2,     eps_t = u / r = A + B / r^2 + k I / r^2
//   sigma_r = c [(1 - nu) eps_r + nu eps_t + nu e] - E alpha theta / (1 - 2 nu),  sigma_t with the first two terms swapped,
//   sigma_z = c [(1 - nu) e + nu (eps_r + eps_t)] - E alpha theta / (1 - 2 nu),   c = E / ((1 + nu)(1 - 2 nu))
// (Timoshenko and Goodier, Theory of Elasticity, the thermal stress of a hollow cylinder, with the axial strain of the generalized plane strain). This u satisfies the radial
// balance d(sigma_r)/dr + (sigma_r - sigma_t)/r = 0 for any theta(r). A, B and e follow from the surface pressures and from the axial condition (no axial force for a solid that
// is free axially, e = 0 for plane strain); B is zero for a solid without a hole. The gap between the solids closes when the two surfaces meet: the interface pressure p then
// makes the closed gap exactly zero (each solid's surface displacement is linear in p). Nothing here reads a file or a result of OFFBEAT.
import { fuelTemperatureLaw } from "./closedForm";
import { lawOf, solveHot } from "./conductivity";
import type { EffectiveMechanics } from "./mechanicalEval";
import { quickLook } from "./quickLook";
import type { MechanicsSpec, NormalizedCase } from "./validate";

export interface SolidField {
  /** Radial displacement, m, and the three normal stresses, Pa (tension positive), at radius r. */
  at(r: number): { ur: number; sigmaR: number; sigmaTheta: number; sigmaZ: number };
  /** The axial strain of the solid. */
  axialStrain: number;
}

export interface ThermoElasticSolution {
  fuel: SolidField;
  cladding: SolidField;
  /** The gap between the solids after the deformation, m: positive when open, 0 when they touch. */
  gap: number;
  /** The gap the free expansion (no contact) would leave, m: negative when the solids would overlap. */
  freeGap: number;
  contact: boolean;
  /** The interface pressure, Pa (0 without contact). */
  contactPressure: number;
}

const SIMPSON_INTERVALS = 400;

/** The integral of theta(s) s ds from a to r (Simpson's rule on an even number of intervals; exact enough for the smooth closed-form profiles). */
function integral(theta: (s: number) => number, a: number, r: number): number {
  if (!(r > a)) return 0;
  const n = SIMPSON_INTERVALS;
  const h = (r - a) / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const s = a + i * h;
    sum += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * theta(s) * s;
  }
  return (sum * h) / 3;
}

export interface SolidSetup {
  a: number;
  b: number;
  E: number;
  nu: number;
  alpha: number;
  theta: (r: number) => number;
}

/** One solid's field for given constants A, B, e. */
function field(s: SolidSetup, A: number, B: number, e: number): SolidField & { surface(r: number): { ur: number; sigmaR: number }; force: number } {
  const k = ((1 + s.nu) * s.alpha) / (1 - s.nu);
  const c = s.E / ((1 + s.nu) * (1 - 2 * s.nu));
  const load = (t: number) => (s.E * s.alpha * t) / (1 - 2 * s.nu);
  const at = (r: number) => {
    const I = integral(s.theta, s.a, r);
    const t = s.theta(r);
    const epsR = A - B / (r * r) + k * t - (k * I) / (r * r);
    const epsT = A + B / (r * r) + (k * I) / (r * r);
    return {
      ur: A * r + B / r + (k * I) / r,
      sigmaR: c * ((1 - s.nu) * epsR + s.nu * epsT + s.nu * e) - load(t),
      sigmaTheta: c * ((1 - s.nu) * epsT + s.nu * epsR + s.nu * e) - load(t),
      sigmaZ: c * ((1 - s.nu) * e + s.nu * (epsR + epsT)) - load(t),
    };
  };
  // the axial force per 2 pi: the integral of sigma_z r dr, with the integral of (eps_r + eps_t) r dr = A (b^2 - a^2) + k I(b) and that of theta r dr = I(b)
  const Ib = integral(s.theta, s.a, s.b);
  const area = s.b * s.b - s.a * s.a;
  const force = c * ((1 - s.nu) * e * (area / 2) + s.nu * (A * area + k * Ib)) - load(Ib);
  return { at, axialStrain: e, surface: at, force };
}

/** Solve A, (B) and (e) of one solid from its surface pressures (pa on the inside, pb on the outside; a solid without a hole has none inside) and the axial condition. */
function solveSolid(s: SolidSetup, pa: number, pb: number, plane: MechanicsSpec["plane"], axialForce = 0) {
  const hasB = s.a > 0;
  const hasE = plane === "free-axial";
  // unknown vector x = [A, B?, e?]; every equation is affine in x, so the columns come from the unit responses
  const idx = { A: 0, B: hasB ? 1 : -1, e: hasE ? (hasB ? 2 : 1) : -1 };
  const n = 1 + (hasB ? 1 : 0) + (hasE ? 1 : 0);
  const residual = (x: number[]) => {
    const f = field(s, x[idx.A]!, hasB ? x[idx.B]! : 0, hasE ? x[idx.e]! : 0);
    const eqs: number[] = [f.surface(s.b).sigmaR + pb];
    if (hasB) eqs.push(f.surface(s.a).sigmaR + pa);
    if (hasE) eqs.push(f.force - axialForce);
    return eqs;
  };
  const base = residual(new Array(n).fill(0));
  const M: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const x = new Array(n).fill(0);
    x[j] = 1;
    const r = residual(x);
    for (let i = 0; i < n; i++) M[i]![j] = r[i]! - base[i]!;
  }
  const x = gauss(M, base.map((v) => -v));
  return field(s, x[idx.A]!, hasB ? x[idx.B]! : 0, hasE ? x[idx.e]! : 0);
}

/** Gaussian elimination with partial pivoting (the systems here are at most 3 x 3). */
function gauss(M: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = M.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    if (!(Math.abs(a[col]![col]!) > 0)) throw new Error("singular thermo-elastic system");
    for (let r = col + 1; r < n; r++) {
      const f = a[r]![col]! / a[col]![col]!;
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

/** The closed-form temperature (K) of each solid as a function of radius. */
export function closedFormTemperatures(c: NormalizedCase): { fuel: (r: number) => number; cladding: (r: number) => number } {
  const look = quickLook(c);
  const fk = lawOf(c.fuelConductivity);
  const ck = lawOf(c.claddingConductivity);
  return {
    fuel: (r) => fuelTemperatureLaw(fk, c.qPrime, c.fuelRadius, r, look.temperatures.fuelSurfaceT, c.fuelInnerRadius),
    cladding: (r) => solveHot(ck, look.temperatures.claddingOuterT, (c.qPrime * Math.log(c.claddingOuterRadius / r)) / (2 * Math.PI)),
  };
}

/** The independent solution of a case that asks for mechanics, with the constants OFFBEAT is given for each solid. */
export function independentSolution(c: NormalizedCase, props: EffectiveMechanics, spec: MechanicsSpec): ThermoElasticSolution {
  const Tref = props.referenceTemperature;
  const temps = closedFormTemperatures(c);
  const tFuel = temps.fuel;
  const tClad = temps.cladding;
  const fuel: SolidSetup = { a: c.fuelInnerRadius, b: c.fuelRadius, E: props.fuel.E, nu: props.fuel.nu, alpha: props.fuel.alpha, theta: (r) => tFuel(r) - Tref };
  const clad: SolidSetup = { a: c.claddingInnerRadius, b: c.claddingOuterRadius, E: props.cladding.E, nu: props.cladding.nu, alpha: props.cladding.alpha, theta: (r) => tClad(r) - Tref };
  return solveSlice(fuel, clad, spec.plane, spec.coolantPressure, props.internalPressure);
}

/**
 * The two solids with the given constants and temperature differences theta(r) = T - Tref: the gap is clad.a - fuel.b. The gas in the gap presses on both surfaces with `gas`
 * (Pa); when the solids touch the radial stress at the interface is the contact pressure plus the gas pressure, which is how OFFBEAT adds them, so only the total decides the
 * closure and `contactPressure` is the total minus the gas.
 */
export function solveSlice(fuel: SolidSetup, clad: SolidSetup, plane: MechanicsSpec["plane"], coolantPressure: number, gas = 0): ThermoElasticSolution {
  // the surface pressures: the coolant outside the cladding, the total interface pressure p between the solids (the gas alone while the gap is open), nothing inside a hole
  // The axial force of a solid that is free axially (per 2 pi): OFFBEAT's modifiedPlaneStrain balances the slice against the gas pressure on the end it is given: the cladding
  // carries p x (the area inside it), a closed-end tube (sigma_z = p a^2 / (b^2 - a^2) on the thin-walled limit), and the fuel p x its own area (OFFBEAT's convention, found on the
  // real solver, not derived: the fuel's axial stress is then +p, tension). The coolant has no end load.
  const fuelEnd = (gas * (fuel.b * fuel.b - fuel.a * fuel.a)) / 2;
  const cladEnd = (gas * clad.a * clad.a) / 2;
  const solve = (p: number) => ({ f: solveSolid(fuel, 0, p, plane, fuelEnd), g: solveSolid(clad, p, coolantPressure, plane, cladEnd) });
  const gapAt = (s: { f: ReturnType<typeof field>; g: ReturnType<typeof field> }) => clad.a - fuel.b + s.g.surface(clad.a).ur - s.f.surface(fuel.b).ur;
  const open = solve(gas);
  const freeGap = gapAt(open);
  if (freeGap > 0) return { fuel: open.f, cladding: open.g, gap: freeGap, freeGap, contact: false, contactPressure: 0 };
  // the gap is affine in the total pressure: two evaluations give the one that closes it (a probe of 1 MPa: a probe of 1 Pa moves the gap by 1e-17 m, below what the difference can resolve)
  const probe = 1e6;
  const slope = (gapAt(solve(gas + probe)) - freeGap) / probe;
  const total = gas - freeGap / slope;
  const closed = solve(total);
  return { fuel: closed.f, cladding: closed.g, gap: 0, freeGap, contact: true, contactPressure: total - gas };
}
