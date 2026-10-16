// The geometry of the 2 degree double wedge a particle is meshed as (plan 13, T3), and the sphere it solves. Written from FEED's own formulas (nothing from OFFBEAT's tutorial or its
// mesh script, which are GPL-3.0; FEED is MIT).
//
// A level of radius r has four vertices at (x, +-y, +-y) with
//     x = r cos(a) / s,  y = r sin(a) / s,  s = sqrt(1 + sin(a)^2),
// so that x^2 + 2 y^2 = r^2: every vertex lies on the sphere of radius r, and a = 1 degree gives the 2 degree wedge. The four side faces are the planes y = +-x tan(a) and
// z = +-x tan(a), so a block between two levels is a frustum of a square pyramid with its apex at the origin.
//
// What the solver then solves (checked in tests/trisoWriter.test.ts against volumes and areas computed from the written vertices, and against the saved real runs): in the
// coordinate x along the axis the section at x is a square of side 2 x tan(a), area A(x) = 4 tan(a)^2 x^2, so the heat equation on the pyramid is the heat equation of a SPHERE
// in the coordinate x, with the same conductivities and conductances, the same volumetric power, and every radius multiplied by
//     lambda = cos(a) / sqrt(1 + sin(a)^2)    (0.999698 for a = 1 degree).
// A cell centre is reported at its volume centroid, whose length is x, so the radius of a cell is the length of its centre vector and lies on that scaled sphere. The scaled
// sphere is `wedgeEquivalent`: the one the results are checked against.

import { SPHERE } from "./geometry";
import type { NormalizedTriso } from "./triso";

/** Half of the wedge's opening angle, degrees (the wedge is 2 degrees). */
export const TRISO_WEDGE_HALF_ANGLE_DEG = 1;
export const TRISO_WEDGE_HALF = (TRISO_WEDGE_HALF_ANGLE_DEG / 180) * Math.PI;
export const TRISO_WEDGE_S = Math.sqrt(1 + Math.sin(TRISO_WEDGE_HALF) ** 2);
/** The factor by which the wedge's pyramid differs from a sphere of the same radii: the wedge is the sphere with every radius multiplied by it (see above). */
export const TRISO_WEDGE_SCALE = Math.cos(TRISO_WEDGE_HALF) / TRISO_WEDGE_S;
/** The fraction of a sphere's surface that a face of the wedge covers at radius r (the face is a square of side 2 y), and of a sphere's volume that a block between two radii covers (a frustum of a pyramid). Their ratio is the scale above. */
export const TRISO_WEDGE_AREA_FRACTION = Math.sin(TRISO_WEDGE_HALF) ** 2 / (Math.PI * TRISO_WEDGE_S * TRISO_WEDGE_S);
export const TRISO_WEDGE_VOLUME_FRACTION = (Math.sin(TRISO_WEDGE_HALF) ** 2 * Math.cos(TRISO_WEDGE_HALF)) / (Math.PI * TRISO_WEDGE_S ** 3);

/**
 * The particle the wedge solves: the same case with every radius multiplied by TRISO_WEDGE_SCALE and the kernel's power density unchanged (so the power is that of the smaller
 * kernel). Its closed form and its finite-volume solution are what OFFBEAT's cell values are compared with.
 */
export function wedgeEquivalent(n: NormalizedTriso, scale = TRISO_WEDGE_SCALE): NormalizedTriso {
  const kernelRadius = n.kernelRadius * scale;
  const kernelVolume = SPHERE.volume(0, kernelRadius);
  const particlePower = n.power.kernelPowerDensity * kernelVolume;
  return {
    ...n,
    kernelRadius,
    layers: n.layers.map((l) => ({ ...l, innerRadius: l.innerRadius * scale, outerRadius: l.outerRadius * scale })),
    outerRadius: n.outerRadius * scale,
    power: { ...n.power, particlePower, kernelVolume, particleVolume: SPHERE.volume(0, n.outerRadius * scale) },
  };
}
