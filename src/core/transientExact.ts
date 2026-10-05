// Exact solutions for transient conduction in a solid cylinder (plan 08). They check the independent finite-volume solver
// (transientFv.ts), which in turn checks OFFBEAT. Bessel functions are evaluated by their integral representation, so nothing
// here depends on a library.

import { solveLinearK } from "./closedForm";

/** J_n(x) = (1/pi) integral from 0 to pi of cos(n t - x sin t) dt, composite Simpson; accurate to about 1e-13 for x up to about 60. */
export function besselJ(n: number, x: number): number {
  const m = 4000;
  const h = Math.PI / m;
  let s = Math.cos(0) + Math.cos(n * Math.PI);
  for (let i = 1; i < m; i++) {
    const t = i * h;
    s += (i % 2 ? 4 : 2) * Math.cos(n * t - x * Math.sin(t));
  }
  return (s * h) / (3 * Math.PI);
}

/** The k-th positive zero of J0 (k >= 1), by Newton's method from the McMahon guess. */
export function j0Zero(k: number): number {
  let x = (k - 0.25) * Math.PI;
  for (let i = 0; i < 20; i++) {
    const f = besselJ(0, x);
    const d = -besselJ(1, x);
    const dx = f / d;
    x -= dx;
    if (Math.abs(dx) < 1e-13) break;
  }
  return x;
}

const zeroCache: number[] = [];
const zeros = (n: number) => {
  while (zeroCache.length < n) zeroCache.push(j0Zero(zeroCache.length + 1));
  return zeroCache;
};

/**
 * A solid cylinder of radius R, uniform initial temperature excess dT0 over its fixed surface temperature, no source:
 * excess(r, t) = sum 2 dT0 J0(l r / R) exp(-l^2 alpha t / R^2) / (l J1(l)), l the zeros of J0. alpha = k / c.
 */
export function cylinderCooling(r: number, t: number, R: number, alpha: number, dT0: number, terms = 60): number {
  const z = zeros(terms);
  let s = 0;
  for (let n = 0; n < terms; n++) {
    const l = z[n]!;
    s += (2 * besselJ(0, (l * r) / R) * Math.exp((-l * l * alpha * t) / (R * R))) / (l * besselJ(1, l));
  }
  return dT0 * s;
}

/**
 * A solid cylinder at its surface temperature, a uniform volumetric source q3 switched on at t = 0: rise above the surface
 * temperature = q3 R^2 / (4 k) (1 - r^2/R^2) - 2 q3 R^2 / k sum J0(l r / R) exp(-l^2 alpha t / R^2) / (l^3 J1(l)).
 */
export function cylinderHeating(r: number, t: number, R: number, k: number, alpha: number, q3: number, terms = 60): number {
  const z = zeros(terms);
  let s = 0;
  for (let n = 0; n < terms; n++) {
    const l = z[n]!;
    s += (besselJ(0, (l * r) / R) * Math.exp((-l * l * alpha * t) / (R * R))) / (l * l * l * besselJ(1, l));
  }
  return (q3 * R * R) / (4 * k) * (1 - (r * r) / (R * R)) - ((2 * q3 * R * R) / k) * s;
}

/**
 * Adiabatic uniform heating: all the deposited energy per unit volume e3 (J/m3) stays in the material, so the temperature solves
 * the integral of c dT from T0 to T equal to e3, with c = a + b T. Exact for any uniform source when no heat leaves.
 */
export function adiabaticTemperature(a: number, b: number, T0: number, e3: number): number {
  return solveLinearK(a, b, T0, e3);
}
