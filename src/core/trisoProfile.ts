// The closed-form temperature of a coated particle at points along the radius, for the editor's picture (plan 13, T5): the cross-section is coloured from it and the radial plot draws it.
// It is the closed form of trisoSolve.ts sampled; nothing new is computed here. Each region is sampled over its own radii, so at the gap (between the buffer and the layer after it) the
// profile has two points at the same radius with the gap's drop between them, and the page draws the jump instead of a slope.

import type { NormalizedTriso } from "./triso";
import { TrisoRegionName, trisoClosedForm } from "./trisoSolve";

export interface TrisoProfilePoint {
  /** metres */
  r: number;
  /** kelvin */
  T: number;
  region: TrisoRegionName;
}

/** Points per region: the kernel's temperature is a parabola and a layer's a 1/r curve, both smooth, so these are plenty for a picture. */
export const TRISO_PROFILE_POINTS = { kernel: 49, layer: 25 } as const;

/**
 * The closed-form profile, kernel first and then the layers outward, each region from its inner face to its outer face. `temperatureAt` of a radius that is the inner face of a layer
 * answers for the layer before it, so the first point of a layer is taken a hair outside its inner face (one part in 1e9 of the radius, far below the picture's resolution) and
 * reported at the face itself.
 */
export function trisoProfile(n: NormalizedTriso): TrisoProfilePoint[] {
  const f = trisoClosedForm(n);
  const out: TrisoProfilePoint[] = [];
  f.regions.forEach((reg, i) => {
    const count = i === 0 ? TRISO_PROFILE_POINTS.kernel : TRISO_PROFILE_POINTS.layer;
    for (let k = 0; k < count; k++) {
      const r = reg.innerRadius + ((reg.outerRadius - reg.innerRadius) * k) / (count - 1);
      const sample = k === 0 && i > 0 ? Math.min(reg.outerRadius, r * (1 + 1e-9)) : r;
      out.push({ r, T: f.temperatureAt(sample), region: reg.name });
    }
  });
  return out;
}
