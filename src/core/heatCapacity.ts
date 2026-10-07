// Volumetric heat capacity laws as coefficient arrays (docs/conductivity-models.md, "Heat capacity"). A law is [c0, c1, c2]: c(T) = c0 + c1 T + c2 T^2 in J/m3/K with
// T in kelvin, the same representation as a conductivity (src/core/conductivity.ts has the arithmetic: evaluate, the primitive that is the enthalpy, the exact
// minimum, the temperature a given energy reaches). OFFBEAT carries a quadratic through SiCSnead with its T^-2 term set to zero.

import type { HeatCapacity } from "./validate";

/** The law of a normalized heat capacity as coefficients: a constant is [c], a linear law [a, b], a polynomial its three coefficients. */
export function heatCapacityLaw(c: HeatCapacity): readonly number[] {
  if (c.kind === "constant") return [c.c];
  if (c.kind === "linear") return [c.a, c.b];
  return c.coefficients;
}

/** The temperature range a heat capacity law is stated to hold over; a constant has none. */
export function heatCapacityRange(c: HeatCapacity): [number, number] | undefined {
  return c.kind === "constant" ? undefined : c.range;
}
