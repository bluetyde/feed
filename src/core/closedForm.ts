// Closed-form steady-state conduction for a fuel pin, per unit length, SI units.
// Derived without any solver (docs/plans/04-verification.md). Used as the oracle
// the solver must match and as the quick-look check on a case.

import { Law, solveHot } from "./conductivity";

const TWO_PI = 2 * Math.PI;
const FOUR_PI = 4 * Math.PI;

/** The building blocks the oracle table exercises; mutants of these must fail the table. */
export interface ClosedFormImpl {
  /** Centre-to-surface rise in a uniformly heated solid cylinder, constant k. Independent of radius. */
  fuelDeltaT(qPrime: number, k: number): number;
  /** T(r) in the same cylinder: T_s + q' (1 - r^2/R^2) / (4 pi k). */
  fuelProfile(qPrime: number, k: number, radius: number, r: number, surfaceT: number): number;
  /** Drop across a gap of conductance h_gap at the fuel outer radius. */
  gapDeltaT(qPrime: number, fuelRadius: number, hGap: number): number;
  /** Drop across a cylindrical wall of conductivity kc. */
  claddingDeltaT(qPrime: number, rInner: number, rOuter: number, kc: number): number;
  /** Drop across the coolant film at the cladding outer radius. */
  filmDeltaT(qPrime: number, rOuter: number, hFilm: number): number;
  /** Right-hand side of the conductivity integral in the fuel: q′ / (4 pi). */
  fuelConductivityIntegral(qPrime: number): number;
  /** Multiplier on the fuel's centre-to-surface rise for a central hole of radius ri with an insulated surface (1 for solid fuel). */
  fuelCentreFactor(fuelInnerRadius: number, fuelRadius: number): number;
  /** Right-hand side of the conductivity integral across the cladding wall: q′ ln(Ro/Ri) / (2 pi). */
  claddingConductivityIntegral(qPrime: number, rInner: number, rOuter: number): number;
  /** Hot-side temperature for k = a + b T given the integral and the cold-side temperature. */
  solveLinearK(a: number, b: number, tCold: number, integral: number): number;
}

export const closedForm: ClosedFormImpl = {
  fuelDeltaT: (q, k) => q / (FOUR_PI * k),
  fuelProfile: (q, k, R, r, Ts) => Ts + (q * (1 - (r * r) / (R * R))) / (FOUR_PI * k),
  gapDeltaT: (q, Rf, h) => q / (TWO_PI * Rf * h),
  claddingDeltaT: (q, Ri, Ro, kc) => (q * Math.log(Ro / Ri)) / (TWO_PI * kc),
  filmDeltaT: (q, Ro, h) => q / (TWO_PI * Ro * h),
  fuelConductivityIntegral: (q) => q / FOUR_PI,
  fuelCentreFactor: (ri, R) => annulusCentreFactor(ri, R),
  claddingConductivityIntegral: (q, Ri, Ro) => (q * Math.log(Ro / Ri)) / TWO_PI,
  solveLinearK,
};

export interface CompositeInput {
  qPrime: number;
  fuelK: number;
  fuelRadius: number;
  /** Central hole radius with an insulated surface; 0 or absent for solid fuel. */
  fuelInnerRadius?: number;
  hGap: number;
  claddingInnerRadius: number;
  claddingOuterRadius: number;
  claddingK: number;
  hFilm: number;
  bulkTemperature: number;
}

export interface CompositeResult {
  filmDeltaT: number;
  claddingDeltaT: number;
  gapDeltaT: number;
  fuelDeltaT: number;
  claddingOuterT: number;
  claddingInnerT: number;
  fuelSurfaceT: number;
  centreT: number;
}

/** Constant-property series solution: coolant film, cladding, gap, fuel. */
export function compositeConstantK(c: CompositeInput, impl: ClosedFormImpl = closedForm): CompositeResult {
  const filmDeltaT = impl.filmDeltaT(c.qPrime, c.claddingOuterRadius, c.hFilm);
  const claddingDeltaT = impl.claddingDeltaT(c.qPrime, c.claddingInnerRadius, c.claddingOuterRadius, c.claddingK);
  const gapDeltaT = impl.gapDeltaT(c.qPrime, c.fuelRadius, c.hGap);
  const fuelDeltaT = impl.fuelDeltaT(c.qPrime, c.fuelK) * impl.fuelCentreFactor(c.fuelInnerRadius ?? 0, c.fuelRadius);
  const claddingOuterT = c.bulkTemperature + filmDeltaT;
  const claddingInnerT = claddingOuterT + claddingDeltaT;
  const fuelSurfaceT = claddingInnerT + gapDeltaT;
  return { filmDeltaT, claddingDeltaT, gapDeltaT, fuelDeltaT, claddingOuterT, claddingInnerT, fuelSurfaceT, centreT: fuelSurfaceT + fuelDeltaT };
}

/**
 * Conductivity integral for k(T) = a + b T on the cold side `tCold`:
 * a (T - tCold) + b/2 (T^2 - tCold^2) = integral. Returns the hot-side T (the root above tCold).
 * Throws when no real root exists (k would have to turn negative).
 */
export function solveLinearK(a: number, b: number, tCold: number, integral: number): number {
  if (integral < 0) throw new RangeError("integral must be non-negative");
  const kCold = a + b * tCold;
  if (kCold <= 0) throw new RangeError("conductivity is not positive at the cold side");
  if (b === 0) return tCold + integral / a;
  // (b/2) T^2 + a T - c = 0 with c = a tCold + (b/2) tCold^2 + integral; the root branch is
  // the one that tends to tCold as integral -> 0 (k positive there). Written as
  // T = tCold + 2 I / (kCold + sqrt(kCold^2 + 2 b I)) to avoid cancellation when b I is small.
  const disc = kCold * kCold + 2 * b * integral;
  if (disc < 0) throw new RangeError("no real solution: conductivity reaches zero first");
  return tCold + (2 * integral) / (kCold + Math.sqrt(disc));
}

export interface LinearK {
  a: number;
  b: number;
}

export interface CompositeLinearInput {
  qPrime: number;
  fuelK: LinearK;
  fuelRadius: number;
  /** Central hole radius with an insulated surface; 0 or absent for solid fuel. */
  fuelInnerRadius?: number;
  hGap: number;
  claddingInnerRadius: number;
  claddingOuterRadius: number;
  claddingK: LinearK;
  /** Coolant side: either bulk + film coefficient, or a prescribed outer-surface temperature. */
  boundary: { kind: "convective"; bulkTemperature: number; hFilm: number } | { kind: "surface-temperature"; surfaceTemperature: number };
}

/** Same series with k = a + b T in fuel and cladding (conductivity integral in each solid region). */
export function compositeLinearK(c: CompositeLinearInput, impl: ClosedFormImpl = closedForm): CompositeResult {
  const filmDeltaT = c.boundary.kind === "convective" ? impl.filmDeltaT(c.qPrime, c.claddingOuterRadius, c.boundary.hFilm) : 0;
  const claddingOuterT = c.boundary.kind === "convective" ? c.boundary.bulkTemperature + filmDeltaT : c.boundary.surfaceTemperature;
  const claddingInnerT = impl.solveLinearK(c.claddingK.a, c.claddingK.b, claddingOuterT, impl.claddingConductivityIntegral(c.qPrime, c.claddingInnerRadius, c.claddingOuterRadius));
  const gapDeltaT = impl.gapDeltaT(c.qPrime, c.fuelRadius, c.hGap);
  const fuelSurfaceT = claddingInnerT + gapDeltaT;
  const centreT = impl.solveLinearK(c.fuelK.a, c.fuelK.b, fuelSurfaceT, impl.fuelConductivityIntegral(c.qPrime) * impl.fuelCentreFactor(c.fuelInnerRadius ?? 0, c.fuelRadius));
  return { filmDeltaT, claddingDeltaT: claddingInnerT - claddingOuterT, gapDeltaT, fuelDeltaT: centreT - fuelSurfaceT, claddingOuterT, claddingInnerT, fuelSurfaceT, centreT };
}

export interface CompositeLawInput {
  /** A plate: every layer is a slab, the heat rate is per unit height and width, the coordinates are distances from the insulated mid-plane (src/core/geometry.ts). */
  slab?: boolean;
  qPrime: number;
  fuelK: Law;
  fuelRadius: number;
  fuelInnerRadius?: number;
  hGap: number;
  claddingInnerRadius: number;
  claddingOuterRadius: number;
  claddingK: Law;
  boundary: { kind: "convective"; bulkTemperature: number; hFilm: number } | { kind: "surface-temperature"; surfaceTemperature: number };
}

/** The same series as compositeLinearK for ANY conductivity law (constant, linear, quadratic, cubic): the conductivity integral of each solid solved by solveHot. */
export function compositeLaw(c: CompositeLawInput): CompositeResult {
  if (c.slab) return compositeSlab(c);
  const filmDeltaT = c.boundary.kind === "convective" ? closedForm.filmDeltaT(c.qPrime, c.claddingOuterRadius, c.boundary.hFilm) : 0;
  const claddingOuterT = c.boundary.kind === "convective" ? c.boundary.bulkTemperature + filmDeltaT : c.boundary.surfaceTemperature;
  const claddingInnerT = solveHot(c.claddingK, claddingOuterT, closedForm.claddingConductivityIntegral(c.qPrime, c.claddingInnerRadius, c.claddingOuterRadius));
  const gapDeltaT = closedForm.gapDeltaT(c.qPrime, c.fuelRadius, c.hGap);
  const fuelSurfaceT = claddingInnerT + gapDeltaT;
  const centreT = solveHot(c.fuelK, fuelSurfaceT, closedForm.fuelConductivityIntegral(c.qPrime) * closedForm.fuelCentreFactor(c.fuelInnerRadius ?? 0, c.fuelRadius));
  return { filmDeltaT, claddingDeltaT: claddingInnerT - claddingOuterT, gapDeltaT, fuelDeltaT: centreT - fuelSurfaceT, claddingOuterT, claddingInnerT, fuelSurfaceT, centreT };
}

/**
 * The plate: heat made uniformly in a meat of half-thickness L (an insulated plane at x = 0), q' per unit height and width, so a flux q' leaves through every layer to the coolant.
 * The film drops q'/h, the cladding of thickness t has the conductivity integral q' t, the gap q'/h_gap, and the meat from x to its surface q' (L^2 - x^2) / (2 L) (the heat made
 * between 0 and x is q' x / L, so k dT/dx = -q' x / L). Plain slab results, none of the pin's.
 */
export function compositeSlab(c: CompositeLawInput): CompositeResult {
  const filmDeltaT = c.boundary.kind === "convective" ? c.qPrime / c.boundary.hFilm : 0;
  const claddingOuterT = c.boundary.kind === "convective" ? c.boundary.bulkTemperature + filmDeltaT : c.boundary.surfaceTemperature;
  const claddingInnerT = solveHot(c.claddingK, claddingOuterT, c.qPrime * (c.claddingOuterRadius - c.claddingInnerRadius));
  const gapDeltaT = c.qPrime / c.hGap;
  const fuelSurfaceT = claddingInnerT + gapDeltaT;
  const centreT = solveHot(c.fuelK, fuelSurfaceT, slabFuelIntegral(c.qPrime, c.fuelRadius, 0));
  return { filmDeltaT, claddingDeltaT: claddingInnerT - claddingOuterT, gapDeltaT, fuelDeltaT: centreT - fuelSurfaceT, claddingOuterT, claddingInnerT, fuelSurfaceT, centreT };
}

/** The conductivity integral of the meat from x to its surface at L: q' (L^2 - x^2) / (2 L). */
export function slabFuelIntegral(qPrime: number, L: number, x: number): number {
  return (qPrime * (L * L - x * x)) / (2 * L);
}

/** Fuel temperature at radius r for any conductivity law, given the fuel surface temperature (and the hole radius, if any). For a plate, r is the distance x from the insulated plane and the hole is not offered. */
export function fuelTemperatureLaw(k: Law, qPrime: number, fuelRadius: number, r: number, surfaceT: number, fuelInnerRadius = 0, slab = false): number {
  if (slab) return solveHot(k, surfaceT, slabFuelIntegral(qPrime, fuelRadius, r));
  return solveHot(k, surfaceT, (qPrime * annulusShape(r, fuelRadius, fuelInnerRadius)) / FOUR_PI);
}

/**
 * Radial shape of the temperature rise in uniformly heated fuel, from the radius r out to the surface R, when the fuel has a
 * central hole of radius ri whose surface is insulated. With a = ri/R,
 *   shape(r) = [ (1 - r^2/R^2) - 2 a^2 ln(R/r) ] / (1 - a^2),   ri <= r <= R,
 * so the conductivity integral from r to the surface is shape(r) q' / (4 pi). For ri = 0 it is 1 - r^2/R^2 (solid fuel).
 * Derivation: the heat that crosses radius r is all the heat made between ri and r, q' (r^2 - ri^2) / (R^2 - ri^2), so
 * k dT/dr = -q' (r^2 - ri^2) / (2 pi r (R^2 - ri^2)); integrate from r to R.
 */
export function annulusShape(r: number, fuelRadius: number, fuelInnerRadius = 0): number {
  const a2 = (fuelInnerRadius / fuelRadius) ** 2;
  if (fuelInnerRadius === 0) return 1 - (r * r) / (fuelRadius * fuelRadius);
  return (1 - (r * r) / (fuelRadius * fuelRadius) - 2 * a2 * Math.log(fuelRadius / r)) / (1 - a2);
}

/** The hottest point of the fuel is its centre (solid) or the surface of the hole: shape(ri), which is 1 for solid fuel. */
export function annulusCentreFactor(fuelInnerRadius: number, fuelRadius: number): number {
  return fuelInnerRadius === 0 ? 1 : annulusShape(fuelInnerRadius, fuelRadius, fuelInnerRadius);
}

/** Fuel temperature at radius r for k = a + b T, given the fuel surface temperature (and the hole radius, if any). */
export function fuelTemperatureLinearK(k: LinearK, qPrime: number, fuelRadius: number, r: number, surfaceT: number, fuelInnerRadius = 0): number {
  return solveLinearK(k.a, k.b, surfaceT, (qPrime * annulusShape(r, fuelRadius, fuelInnerRadius)) / FOUR_PI);
}
