// The two geometries of the one-dimensional models (plan 12, A4): the pin (a cylinder: the coordinate is the radius, every quantity per unit length of the pin) and the plate (a slab:
// the coordinate is the distance x from the insulated mid-plane, every quantity per unit height and per unit width, one metre of each). The numerical kernels (the finite-volume
// solutions, the closed forms, the time scales and the results checks) take their geometry from here, so the same code serves both and nothing is copied.
//
//   area(x)         the heat-flow area per unit length (cylinder: 2 pi x) or per unit width and height (slab: 1)
//   resist(a, b, k) the thermal resistance of a layer between the coordinates a and b of conductivity k (cylinder: ln(b/a) / (2 pi k); slab: (b - a) / k)
//   volume(a, b)    the volume of the cell between a and b per unit length (cylinder: pi (b^2 - a^2); slab: b - a)
//   centroid(a, b)  where OFFBEAT reports the cell's centre (cylinder: the volume centroid of the wedge cell, 2/3 (b^3 - a^3) / (b^2 - a^2); slab: the middle)

export interface Geometry {
  slab: boolean;
  area(x: number): number;
  resist(a: number, b: number, k: number): number;
  /** The conductance 1 / resist, written the way each geometry has always written it so that the pin's results do not change in the last digit (a cylinder: 2 pi k / ln(b/a); a slab: k / (b - a)). */
  conductance(a: number, b: number, k: number): number;
  volume(a: number, b: number): number;
  centroid(a: number, b: number): number;
}

export const CYLINDER: Geometry = {
  slab: false,
  area: (x) => 2 * Math.PI * x,
  resist: (a, b, k) => Math.log(b / a) / (2 * Math.PI * k),
  conductance: (a, b, k) => (2 * Math.PI * k) / Math.log(b / a),
  volume: (a, b) => Math.PI * (b * b - a * a),
  centroid: (a, b) => ((2 / 3) * (b ** 3 - a ** 3)) / (b * b - a * a),
};

export const SLAB: Geometry = {
  slab: true,
  area: () => 1,
  resist: (a, b, k) => (b - a) / k,
  conductance: (a, b, k) => k / (b - a),
  volume: (a, b) => b - a,
  centroid: (a, b) => 0.5 * (a + b),
};

export const geometryOf = (slab: boolean | undefined): Geometry => (slab ? SLAB : CYLINDER);

/** The width of a plate in the solver's mesh (m): every plate quantity is per metre of width. */
export const PLATE_WIDTH_M = 1;
