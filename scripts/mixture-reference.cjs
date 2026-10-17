// The resolved reference for the mixture law of plan 13 T4 (docs/compact-pebble.md): the effective conductivity of spheres in a matrix, from a three-dimensional finite-volume
// solution of a periodic unit cell. Written for FEED, independent of every mixture formula in src/core/mixture.ts.
//
// The cell is a cube of side 1 with N^3 cells. A macroscopic temperature gradient of 1 along x is imposed; the unknown is the periodic fluctuation T' so that the temperature is
// x + T'. Each cell has the conductivity of its volume mix (spheres by 5^3 sub-samples where the sphere's surface crosses the cell, exact inside or outside), the conductivity of a
// face is the harmonic mean of its two cells, and the equations  sum over faces k_f (T'_nb - T'_c + dx)  = 0  are solved by conjugate gradients (Jacobi preconditioner, the
// right side sums to zero, so the constant mode never grows). The effective conductivity is the mean of k_f (dT'/dx + 1) over the x faces, in units of the matrix's.
//
// Spheres are given as centres (fractions of the cell) with a radius, or as layered spheres (radii and conductivities from the centre out). Usage as a module:
//   const { solveCell } = require("./mixture-reference.cjs");
// Usage as a program (writes the table the tests read):
//   node scripts/mixture-reference.cjs            -> tests/golden/mixture/resolved.json
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Conductivity of the cell at (x,y,z) given lists of centres and a radius profile: layers = [{r, k}] from the centre outward (outer radius r, conductivity k), the matrix has conductivity 1. */
function cellMix(ix, iy, iz, N, centres, layers) {
  const h = 1 / N;
  const cx = (ix + 0.5) * h, cy = (iy + 0.5) * h, cz = (iz + 0.5) * h;
  const rOut = layers[layers.length - 1].r;
  const diag = h * Math.sqrt(3) / 2;
  // nearest centre (minimum image)
  let dmin = Infinity;
  for (const c of centres) {
    let dx = Math.abs(cx - c[0]); dx = Math.min(dx, 1 - dx);
    let dy = Math.abs(cy - c[1]); dy = Math.min(dy, 1 - dy);
    let dz = Math.abs(cz - c[2]); dz = Math.min(dz, 1 - dz);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < dmin) dmin = d;
  }
  if (dmin > rOut + diag) return 1;
  // is the cell wholly inside one layer?
  const kAt = (d) => { for (const l of layers) if (d <= l.r) return l.k; return 1; };
  const lo = kAt(Math.max(0, dmin - diag)), hi = kAt(dmin + diag);
  if (lo === hi && dmin - diag >= 0) return lo;
  // sub-sample
  const S = 5;
  let sum = 0;
  for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) for (let c = 0; c < S; c++) {
    const x = cx + ((a + 0.5) / S - 0.5) * h, y = cy + ((b + 0.5) / S - 0.5) * h, z = cz + ((c + 0.5) / S - 0.5) * h;
    let dm = Infinity;
    for (const cc of centres) {
      let dx = Math.abs(x - cc[0]); dx = Math.min(dx, 1 - dx);
      let dy = Math.abs(y - cc[1]); dy = Math.min(dy, 1 - dy);
      let dz = Math.abs(z - cc[2]); dz = Math.min(dz, 1 - dz);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < dm) dm = d;
    }
    sum += kAt(dm);
  }
  return sum / (S * S * S);
}

/** Effective conductivity (matrix = 1) of the periodic cell. layers: [{r,k}] from the centre. Returns {keff, iterations, fraction}. */
function solveCell(centres, layers, N, opts = {}) {
  const tol = opts.tol ?? 1e-10;
  const n3 = N * N * N;
  const kc = new Float64Array(n3);
  let vol = 0;
  const rOut = layers[layers.length - 1].r;
  for (let iz = 0; iz < N; iz++) for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    const k = cellMix(ix, iy, iz, N, centres, layers);
    kc[ix + N * (iy + N * iz)] = k;
  }
  // volume fraction occupied by the whole spheres (from the sub-sampled mix of a unit-conductivity-contrast probe is not needed: exact from the radius, spheres do not overlap)
  vol = centres.length * (4 / 3) * Math.PI * rOut ** 3;
  // face conductivities: fx[i] between cell i and i+1 in x, and so on
  const idx = (x, y, z) => ((x + N) % N) + N * (((y + N) % N) + N * ((z + N) % N));
  const fx = new Float64Array(n3), fy = new Float64Array(n3), fz = new Float64Array(n3);
  const hm = (a, b) => (2 * a * b) / (a + b);
  for (let iz = 0; iz < N; iz++) for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    const i = idx(ix, iy, iz);
    fx[i] = hm(kc[i], kc[idx(ix + 1, iy, iz)]);
    fy[i] = hm(kc[i], kc[idx(ix, iy + 1, iz)]);
    fz[i] = hm(kc[i], kc[idx(ix, iy, iz + 1)]);
  }
  const h = 1 / N;
  // matrix-vector: (A T)_i = sum_f k_f (T_i - T_nb)   (positive semi-definite)
  const diag = new Float64Array(n3);
  const b = new Float64Array(n3);
  for (let iz = 0; iz < N; iz++) for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    const i = idx(ix, iy, iz);
    const xm = idx(ix - 1, iy, iz), ym = idx(ix, iy - 1, iz), zm = idx(ix, iy, iz - 1);
    diag[i] = fx[i] + fx[xm] + fy[i] + fy[ym] + fz[i] + fz[zm];
    // right side from the imposed gradient: flux into cell i across its x faces: k_f * h from the right face minus from the left face
    b[i] = -(fx[i] * h) + fx[xm] * h; // equations: sum k_f (T_nb - T_i + dxterm) = 0 -> A T = sum k_f dxterm
  }
  // careful with the sign: sum_f k_f (T_nb - T_c) + (fx[i]*h - fx[xm]*h) = 0  =>  A T = fx[i]*h - fx[xm]*h
  for (let i = 0; i < n3; i++) b[i] = -b[i];
  const apply = (T, out) => {
    for (let iz = 0; iz < N; iz++) for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
      const i = ix + N * (iy + N * iz);
      const xp = idx(ix + 1, iy, iz), xm = idx(ix - 1, iy, iz), yp = idx(ix, iy + 1, iz), ym = idx(ix, iy - 1, iz), zp = idx(ix, iy, iz + 1), zm = idx(ix, iy, iz - 1);
      out[i] = diag[i] * T[i] - fx[i] * T[xp] - fx[xm] * T[xm] - fy[i] * T[yp] - fy[ym] * T[ym] - fz[i] * T[zp] - fz[zm] * T[zm];
    }
  };
  const T = new Float64Array(n3), r = new Float64Array(n3), z = new Float64Array(n3), p = new Float64Array(n3), Ap = new Float64Array(n3);
  for (let i = 0; i < n3; i++) { r[i] = b[i]; z[i] = r[i] / diag[i]; p[i] = z[i]; }
  let rz = 0, bn = 0;
  for (let i = 0; i < n3; i++) { rz += r[i] * z[i]; bn += b[i] * b[i]; }
  bn = Math.sqrt(bn);
  let it = 0;
  for (; it < 20000; it++) {
    apply(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n3; i++) pAp += p[i] * Ap[i];
    const a = rz / pAp;
    let rn = 0;
    for (let i = 0; i < n3; i++) { T[i] += a * p[i]; r[i] -= a * Ap[i]; rn += r[i] * r[i]; }
    if (Math.sqrt(rn) < tol * bn) break;
    let rz2 = 0;
    for (let i = 0; i < n3; i++) { z[i] = r[i] / diag[i]; rz2 += r[i] * z[i]; }
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n3; i++) p[i] = z[i] + beta * p[i];
  }
  // effective conductivity: mean over x faces of k_f * ((T_{i+1} - T_i)/h + 1)
  let flux = 0;
  for (let iz = 0; iz < N; iz++) for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    const i = idx(ix, iy, iz);
    flux += fx[i] * ((T[idx(ix + 1, iy, iz)] - T[i]) / h + 1);
  }
  return { keff: flux / n3, iterations: it, fraction: vol };
}

/** Lattice centres (fractions of the cell) for SC, BCC, FCC. */
function lattice(kind) {
  if (kind === "SC") return [[0.5, 0.5, 0.5]];
  if (kind === "BCC") return [[0.25, 0.25, 0.25], [0.75, 0.75, 0.75]];
  if (kind === "FCC") return [[0.25, 0.25, 0.25], [0.75, 0.75, 0.25], [0.75, 0.25, 0.75], [0.25, 0.75, 0.75]];
  throw new Error("lattice " + kind);
}
const PACK_MAX = { SC: Math.PI / 6, BCC: (Math.PI * Math.sqrt(3)) / 8, FCC: Math.PI / Math.sqrt(18) };

/** Radius of the spheres of n per cell at volume fraction phi. */
const radiusFor = (phi, n) => Math.cbrt((3 * phi) / (4 * Math.PI * n));

/** A seeded random sequential addition of n equal spheres of radius r into the unit periodic cell (returns centres, or null when it cannot place them). */
function rsa(n, r, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const cs = [];
  for (let tries = 0; cs.length < n && tries < 2e6; tries++) {
    const c = [rnd(), rnd(), rnd()];
    let ok = true;
    for (const o of cs) {
      let dx = Math.abs(c[0] - o[0]); dx = Math.min(dx, 1 - dx);
      let dy = Math.abs(c[1] - o[1]); dy = Math.min(dy, 1 - dy);
      let dz = Math.abs(c[2] - o[2]); dz = Math.min(dz, 1 - dz);
      if (dx * dx + dy * dy + dz * dz < 4 * r * r) { ok = false; break; }
    }
    if (ok) cs.push(c);
  }
  return cs.length === n ? cs : null;
}

module.exports = { solveCell, lattice, radiusFor, rsa, PACK_MAX };

/** A job is one cell and one conductivity ratio; the table is the list of jobs run on several grids by worker processes. */
function jobCentres(job) {
  if (job.arrangement === "RSA") return rsa(job.n, radiusFor(job.phi, job.n), job.seed);
  return lattice(job.arrangement);
}
function runJob(job) {
  const centres = jobCentres(job);
  const r = radiusFor(job.phi, centres.length);
  const keff = {};
  for (const N of job.grids) keff[N] = solveCell(centres, [{ r, k: job.alpha }], N).keff;
  return { arrangement: job.arrangement, phi: job.phi, alpha: job.alpha, ...(job.seed !== undefined ? { seed: job.seed, n: job.n } : {}), keff };
}
module.exports.runJob = runJob;

if (require.main === module && process.argv[2] === "--job") {
  process.send(runJob(JSON.parse(process.argv[3])));
  process.exit(0);
} else if (require.main === module) {
  const { fork } = require("node:child_process");
  const grids = [32, 64, 128];
  const alphas = [0.05, 0.1, 0.3, 3, 10, 100];
  const phis = [0.1, 0.2, 0.3, 0.4, 0.5];
  const jobs = [];
  for (const kind of ["SC", "BCC", "FCC"]) for (const phi of phis) {
    if (phi > PACK_MAX[kind] * 0.999) continue;
    for (const alpha of alphas) jobs.push({ arrangement: kind, phi, alpha, grids });
  }
  for (const seed of [1, 2]) for (const phi of [0.1, 0.2, 0.3]) for (const alpha of alphas) jobs.push({ arrangement: "RSA", n: 30, seed, phi, alpha, grids });
  const results = [];
  let next = 0, running = 0;
  const t0 = Date.now();
  const finish = () => {
    const rank = (r) => ["SC", "BCC", "FCC", "RSA"].indexOf(r.arrangement);
    results.sort((a, b) => rank(a) - rank(b) || (a.seed || 0) - (b.seed || 0) || a.phi - b.phi || a.alpha - b.alpha);
    const out = { note: "Resolved reference for plan 13 T4 (scripts/mixture-reference.cjs): keff / k_matrix of equal spheres of conductivity alpha x k_matrix in a periodic cube, 3D finite volume on N^3 cells (grids), harmonic-mean faces, 5^3 sub-sampled interface cells. Arrangements: SC, BCC, FCC lattices and random sequential addition (RSA, 30 spheres, seeds 1 and 2).", grids, cases: results };
    const dir = path.join(__dirname, "..", "tests", "golden", "mixture");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "resolved.json"), JSON.stringify(out) + String.fromCharCode(10));
    console.log("written", results.length, "cases", ((Date.now() - t0) / 1000).toFixed(0) + "s");
  };
  const launch = () => {
    while (running < 12 && next < jobs.length) {
      const job = jobs[next++];
      running++;
      const child = fork(__filename, ["--job", JSON.stringify(job)]);
      child.on("message", (m) => results.push(m));
      child.on("exit", () => { running--; if (next >= jobs.length && running === 0) finish(); else launch(); });
    }
  };
  launch();
}
