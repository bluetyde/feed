// The effective conductivity of a compact or of a pebble's fuelled zone (plan 13, T4; docs/compact-pebble.md): coated particles in a matrix, replaced by one homogeneous solid.
// Two steps, each tested against a resolved three-dimensional model (tests/mixture.test.ts, scripts/mixture-reference.cjs):
//   1. `equivalentParticleConductivity`: the layered particle (kernel, buffer, gap, layers) as ONE homogeneous sphere of the same size, exact for the particle's response to a
//      uniform outside temperature gradient (the l = 1 mode of the heat equation in a sphere, layer by layer).
//   2. a mixture law: spheres of that conductivity at a volume fraction in a matrix.
// Everything here is plain arithmetic on numbers; the laws are written for FEED from their definitions (Maxwell 1873, Bruggeman 1935).

export type MixtureLawName = "maxwell-eucken" | "bruggeman" | "differential";
export const MIXTURE_LAWS: readonly MixtureLawName[] = ["maxwell-eucken", "bruggeman", "differential"];

/** Maxwell-Eucken (Maxwell's 1873 result, also the Hashin-Shtrikman bound for the dispersed phase being the better conductor): dilute spheres of conductivity kp in a matrix of km at volume fraction phi. */
export function maxwellEucken(kp: number, km: number, phi: number): number {
  const d = kp - km;
  return (km * (kp + 2 * km + 2 * phi * d)) / (kp + 2 * km - phi * d);
}

/** Bruggeman's symmetric effective-medium law: phi (kp - k)/(kp + 2k) + (1 - phi)(km - k)/(km + 2k) = 0, the positive root. */
export function bruggeman(kp: number, km: number, phi: number): number {
  // multiply out: 2 k^2 - k (3 phi kp... ) as a quadratic  2k^2 + k (kp (1 - 3 phi) + km (3 phi - 2)) ... derived: a k^2 + b k + c = 0 with a = 2, b = -(3 phi - 1) kp - (2 - 3 phi) km, c = -kp km
  const b = -((3 * phi - 1) * kp + (2 - 3 * phi) * km);
  const c = -kp * km;
  return (-b + Math.sqrt(b * b - 8 * c)) / 4;
}

/** The differential effective-medium law (Bruggeman's asymmetric form, spheres added to the matrix a little at a time): (kp - k)/(kp - km) (km / k)^(1/3) = 1 - phi. Bisection on k. */
export function differential(kp: number, km: number, phi: number): number {
  if (kp === km || phi === 0) return km;
  const f = (k: number) => ((kp - k) / (kp - km)) * Math.cbrt(km / k) - (1 - phi);
  // f(km) = phi > 0 and f(kp) = -(1 - phi) < 0, monotone in between: the root lies between km and kp
  let a = km;
  let b = kp;
  const sign = Math.sign(f(a));
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (a + b);
    if (Math.sign(f(m)) === sign) a = m;
    else b = m;
    if (Math.abs(b - a) <= 1e-15 * Math.abs(b)) break;
  }
  return 0.5 * (a + b);
}

export const MIXTURE_FN: Record<MixtureLawName, (kp: number, km: number, phi: number) => number> = { "maxwell-eucken": maxwellEucken, bruggeman, differential };

/** The effective conductivity by the named law. */
export function mixtureConductivity(law: MixtureLawName, kp: number, km: number, phi: number): number {
  return MIXTURE_FN[law](kp, km, phi);
}

/**
 * The conductivity of the homogeneous sphere that responds to a uniform outside gradient exactly as the layered sphere does. Regions from the centre out have outer radii
 * `radii[i]` and conductivities `k[i]`; `gaps[i]` (optional, W/m2/K, default none) is a thin gap between region i and region i+1 at radius `radii[i]` (a temperature jump of
 * flux / h). In a region the l = 1 solution is T = (A r + B / r^2) cos(theta), flux k (A - 2B / r^3) cos(theta); the centre has B = 0. Matching T and the flux (with the gap's
 * jump) outward gives, at the outer face, k_eq = k_last (A - 2B / b^3) / (A + B / b^3): the conductivity a solid sphere T = A r would need to have the same ratio of flux to temperature.
 */
export function equivalentParticleConductivity(radii: readonly number[], k: readonly number[], gaps: readonly (number | undefined)[] = []): number {
  if (radii.length !== k.length || radii.length === 0) throw new RangeError("one conductivity per region");
  let A = 1;
  let B = 0;
  for (let i = 0; i < radii.length - 1; i++) {
    const r = radii[i]!;
    // values at the face in region i
    const T = A * r + B / (r * r);
    const q = k[i]! * (A - (2 * B) / r ** 3); // flux per cos(theta)
    const h = gaps[i];
    const Tn = h === undefined ? T : T + q / h; // T_out = T_in + q / h (the heat flows radially at -q across the gap; the sign is pinned by the test against a thin shell)
    // next region: A' r + B' / r^2 = Tn, k' (A' - 2 B' / r^3) = q  ->  solve the 2x2
    const kn = k[i + 1]!;
    // from the second: A' = q / kn + 2 B' / r^3 ; substitute: (q / kn + 2 B' / r^3) r + B' / r^2 = Tn  ->  B' (3 / r^2) = Tn - q r / kn
    const Bn = ((Tn - (q * r) / kn) * r * r) / 3;
    const An = q / kn + (2 * Bn) / r ** 3;
    A = An;
    B = Bn;
  }
  const b = radii[radii.length - 1]!;
  return (k[k.length - 1]! * (A - (2 * B) / b ** 3)) / (A + B / b ** 3);
}
