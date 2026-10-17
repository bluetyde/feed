// Throw-away probe: the steady chain solution of the particle under several face-conductance schemes, compared with OFFBEAT's cells and with FEED's finite-volume scheme ("series").
// Scheme parts, each switchable: interior (spherical exact "ex" | planar "pl"), interface between regions that are not the gap (series of two exact half cells "ex" | planar series
// "pl" | linear k with planar distance "lin" | linear k with exact sphere "linex"), gap face ("ex" series | "pl" planar series), outside half cell ("ex" | "pl").
const A = (r) => 4 * Math.PI * r * r;
const resistEx = (a, b, k) => (1 / a - 1 / b) / (4 * Math.PI * k);
const centroid = (a, b) => (0.75 * (b ** 4 - a ** 4)) / (b ** 3 - a ** 3);
function model(eq, N) {
  const bounds = [0, eq.kernelRadius, ...eq.layers.map((l) => l.outerRadius)];
  const ks = [eq.kernelConductivity.k ?? eq.kernelConductivity.value, ...eq.layers.map((l) => l.conductivity.k)];
  const cells = [];
  const ns = Array.isArray(N) ? N : bounds.slice(1).map(() => N);
  ns.forEach((nc, ri) => {
    for (let i = 0; i < nc; i++) {
      const a = bounds[ri] + ((bounds[ri + 1] - bounds[ri]) * i) / nc, b = bounds[ri] + ((bounds[ri + 1] - bounds[ri]) * (i + 1)) / nc;
      cells.push({ a, b, r: centroid(a, b), ri, k: ks[ri] });
    }
  });
  return { bounds, ks, cells };
}
// returns { T, parts }: parts[i] = the face resistance between cell i and i+1 and the heat through it
function chain(eq, N, scheme) {
  const { bounds, cells } = model(eq, N);
  const P = eq.power.particlePower, kv = (4 / 3) * Math.PI * bounds[1] ** 3;
  const Q = (c) => (c.ri === 0 ? (P * ((4 / 3) * Math.PI * c.b ** 3)) / kv : P);
  const n = cells.length, Ro = bounds[bounds.length - 1];
  const bnd = eq.boundary;
  const Tout = bnd.kind === "convective" ? bnd.bulkTemperature : bnd.surfaceTemperature;
  const film = bnd.kind === "convective" ? 1 / (A(Ro) * bnd.heatTransferCoefficient) : 0;
  const last = cells[n - 1];
  const outHalf = scheme.out === "pl" ? (Ro - last.r) / (last.k * A(Ro)) : resistEx(last.r, Ro, last.k);
  const T = new Array(n), faceR = new Array(n - 1), faceQ = new Array(n - 1);
  T[n - 1] = Tout + P * (film + outHalf);
  for (let i = n - 2; i >= 0; i--) {
    const c = cells[i], d = cells[i + 1], f = c.b;
    const gap = c.ri === 1 && d.ri === 2;
    const dP = f - c.r, dN = d.r - f;
    const ex = resistEx(c.r, f, c.k) + resistEx(f, d.r, d.k);
    const pl = dP / (c.k * A(f)) + dN / (d.k * A(f));
    const kf = (c.k * dN + d.k * dP) / (dP + dN);
    const lin = (dP + dN) / (kf * A(f));
    let res;
    if (gap) res = (scheme.gap === "pl" ? pl : ex) + 1 / (A(f) * eq.gapConductance);
    else if (c.ri !== d.ri) res = { ex, pl, lin }[scheme.iface];
    else res = scheme.interior === "pl" ? pl : ex;
    faceR[i] = res; faceQ[i] = Q(c);
    T[i] = T[i + 1] + Q(c) * res;
  }
  return { T, cells, faceR, faceQ };
}
const SERIES = { interior: "ex", iface: "ex", gap: "ex", out: "ex" };
const OFFB = { interior: "pl", iface: "lin", gap: "pl", out: "pl" };
module.exports = { chain, model, SERIES, OFFB, A, resistEx, centroid };
