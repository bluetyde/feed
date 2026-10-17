"use strict";
// Plan 15, B0: a throw-away two-dimensional (r, z) finite-volume solution of a stack of pins or plates, written for the probe. NOT FEED code (nothing under src/ uses it).
// It takes the radial kernel of src/core/transientFv.ts (cells, conductances through src/core/geometry.ts) and adds the conduction along the height between layers of the same
// solid. It reads the compiled helpers in dist/core (run `npm run build` first). Options (all are probe switches, the defaults are the plan's choice):
//   radial     "feed"    the kernel of transientFv: cell nodes at the middle of the cell, log (cylinder) or linear (slab) conductance between nodes, mean conductivity
//              "offbeat" what OFFBEAT's source does (read, not copied): nodes at the volume centroid, conductance k A_face / |centroid distance| (linear, also for a cylinder),
//                        gap and outer boundary in series with k / (distance from the centroid to the face)
//   axial      true      couple layer k to k+1 (two half cells in series), false: N independent one-dimensional solutions (the existing FEED reference)
//   faceK      "harmonic" (two half cells in series) or "arith" (mean of the two conductivities, which is what OFFBEAT's linear interpolation gives on equal cells)
//   gapArea    "fuel" | "clad": the area the gap conductance acts on (offbeat radial only; FEED uses the fuel face)
//   sourceAll  true: the heat source fills every cell (for the exact-solution test); false: fuel only
//   powerSample "centre" (the shape at the layer centre, what OFFBEAT does) is handled by the caller through q(k, t)

const path = require("path");
const D = path.join(__dirname, "..", "..", "..", "dist", "core");
const { geometryOf } = require(D + "/geometry");
const fv = require(D + "/transientFv");
const { lawOf } = require(D + "/conductivity");
const { heatCapacityLaw } = require(D + "/heatCapacity");
const { boundaryAtTime } = require(D + "/boundaryHistory");
const { sliceLoads, normalizedShape, interpolate } = require(D + "/axial");

/** Banded solve without pivoting (the matrix is diagonally dominant: an M-matrix). a: Float64Array(rows * (2m+1)), element (i, j) at i * (2m+1) + (j - i + m). */
function solveBanded(a, b, n, m) {
  const w = 2 * m + 1;
  for (let p = 0; p < n; p++) {
    const piv = a[p * w + m];
    const rEnd = Math.min(n - 1, p + m);
    for (let r = p + 1; r <= rEnd; r++) {
      const f = a[r * w + (p - r + m)] / piv;
      if (f === 0) continue;
      for (let c = p; c <= rEnd; c++) a[r * w + (c - r + m)] -= f * a[p * w + (c - p + m)];
      b[r] -= f * b[p];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    const cEnd = Math.min(n - 1, i + m);
    for (let j = i + 1; j <= cEnd; j++) s -= a[i * w + (j - i + m)] * x[j];
    x[i] = s / a[i * w + m];
  }
  return x;
}

/** The properties of a solid as the TransientPin helpers want them. */
function propsOf(c) {
  const p = { fuelLaw: lawOf(c.fuelConductivity), claddingLaw: lawOf(c.claddingConductivity) };
  if (c.fuelHeatCapacity) p.fuelCLaw = heatCapacityLaw(c.fuelHeatCapacity);
  if (c.claddingHeatCapacity) p.claddingCLaw = heatCapacityLaw(c.claddingHeatCapacity);
  return p;
}

/**
 * m: { slab, fuelInner, fuelR, cladInner, cladOuter, nf, nc, N, H, props, gap, q(k, t), bnd(k, t) -> {kind, ...} }
 * o: { radial, axial, faceK, gapArea, sourceAll }, and either { steady: true } or { dt, steps, outputEvery, initial: Float64Array/array of N*n }
 * Returns { r (node radii per layer), states: [{ time, T: Float64Array(N*n), wall: [N], deposited, rejected }] }. Per-unit-height quantities are multiplied by the layer height h.
 */
function solve2D(m, o) {
  const radial = o.radial || "feed";
  const axial = o.axial !== false;
  const faceK = o.faceK || "harmonic";
  const gapArea = o.gapArea || "fuel";
  const geo = geometryOf(m.slab);
  const { nf, nc, N } = m;
  const n = nf + nc;
  const h = m.H / N;
  const faces = [];
  for (let i = 0; i <= nf; i++) faces.push(m.fuelInner + ((m.fuelR - m.fuelInner) * i) / nf);
  const cf = [];
  for (let i = 0; i <= nc; i++) cf.push(m.cladInner + ((m.cladOuter - m.cladInner) * i) / nc);
  const ends = [];
  for (let i = 0; i < nf; i++) ends.push([faces[i], faces[i + 1]]);
  for (let i = 0; i < nc; i++) ends.push([cf[i], cf[i + 1]]);
  const r = ends.map(([a, b]) => (radial === "offbeat" ? geo.centroid(a, b) : 0.5 * (a + b)));
  const vol = ends.map(([a, b]) => geo.volume(a, b));
  const fuelVol = geo.volume(m.fuelInner, m.fuelR);
  const totVol = vol.reduce((x, y) => x + y, 0);
  const share = vol.map((v, i) => (o.sourceAll ? v / totVol : i < nf ? v / fuelVol : 0));
  const kOf = (i, T) => fv.conductivityOf(m.props, i < nf, T);
  const cOf = (i, T) => fv.capacityOf(m.props, i < nf, T);
  const HOf = (i, T) => fv.enthalpyOf(m.props, i < nf, T);

  /** Radial conductances (W/K per unit height) between node i and i+1 of one layer, and to the coolant, at conductivities kv[0..n-1] and the boundary b. */
  function radialG(kv, b) {
    const g = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      if (i !== nf - 1) {
        if (radial === "feed") g[i] = geo.conductance(r[i], r[i + 1], 0.5 * (kv[i] + kv[i + 1]));
        else {
          const rf = ends[i][1];
          const dP = rf - r[i];
          const dN = r[i + 1] - rf;
          const w = dN / (dP + dN);
          g[i] = (geo.area(rf) * (w * kv[i] + (1 - w) * kv[i + 1])) / (r[i + 1] - r[i]);
        }
      } else if (radial === "feed") {
        const rF = geo.resist(r[i], m.fuelR, kv[i]);
        const rGap = 1 / (geo.area(m.fuelR) * m.gap);
        const rC = geo.resist(m.cladInner, r[i + 1], kv[i + 1]);
        g[i] = 1 / (rF + rGap + rC);
      } else {
        const aP = kv[i] / (m.fuelR - r[i]);
        const aN = kv[i + 1] / (r[i + 1] - m.cladInner);
        const eff = 1 / (1 / aP + 1 / aN + 1 / m.gap);
        g[i] = eff * geo.area(gapArea === "fuel" ? m.fuelR : m.cladInner);
      }
    }
    const kl = kv[n - 1];
    let gOut, wallW;
    if (radial === "feed") {
      const rHalf = geo.resist(r[n - 1], m.cladOuter, kl);
      const gHalf = geo.conductance(r[n - 1], m.cladOuter, kl);
      if (b.kind === "convective") {
        const gFilm = geo.area(m.cladOuter) * b.heatTransferCoefficient;
        gOut = 1 / (rHalf + 1 / gFilm);
        wallW = [gHalf / (gHalf + gFilm), gFilm / (gHalf + gFilm)]; // wall = wallW[0] T + wallW[1] Tb
      } else {
        gOut = 1 / rHalf;
        wallW = [0, 0];
      }
    } else {
      const aP = (geo.area(m.cladOuter) * kl) / (m.cladOuter - r[n - 1]);
      if (b.kind === "convective") {
        const gFilm = geo.area(m.cladOuter) * b.heatTransferCoefficient;
        gOut = (aP * gFilm) / (aP + gFilm);
        wallW = [aP / (aP + gFilm), gFilm / (aP + gFilm)];
      } else {
        gOut = aP;
        wallW = [0, 0];
      }
    }
    return { g, gOut, wallW };
  }
  const coolant = (b) => (b.kind === "convective" ? b.bulkTemperature : b.surfaceTemperature);

  const rows = N * n;
  const w2 = 2 * n + 1;
  const steady = !!o.steady;

  /** One linear solve about the iterate Tn (conductivities, capacities at Tn), previous time level Told, at time t1. */
  function step(Tn, Told, t1, dt) {
    const A = new Float64Array(rows * w2);
    const rhs = new Float64Array(rows);
    const at = (i, j) => i * w2 + (j - i + n);
    const kv = new Float64Array(rows);
    for (let k = 0; k < N; k++) for (let i = 0; i < n; i++) kv[k * n + i] = kOf(i, Tn[k * n + i]);
    const out = [];
    for (let k = 0; k < N; k++) {
      const b = m.bnd(k, t1);
      const kl = kv.subarray(k * n, (k + 1) * n);
      const { g, gOut, wallW } = radialG(kl, b);
      out.push({ gOut, wallW, b, Tcool: coolant(b) });
      const q = m.q(k, t1);
      for (let i = 0; i < n; i++) {
        const id = k * n + i;
        if (!steady) {
          const Cdt = (h * vol[i] * cOf(i, Tn[id])) / dt;
          A[at(id, id)] += Cdt;
          rhs[id] += Cdt * Tn[id] - (h * vol[i] * (HOf(i, Tn[id]) - HOf(i, Told[id]))) / dt;
        }
        rhs[id] += h * share[i] * q;
        if (i < n - 1) {
          const gi = h * g[i];
          A[at(id, id)] += gi;
          A[at(id + 1, id + 1)] += gi;
          A[at(id, id + 1)] -= gi;
          A[at(id + 1, id)] -= gi;
        }
        if (axial && k < N - 1) {
          const ku = kv[id + n];
          const kk = kv[id];
          const kEff = faceK === "harmonic" ? (2 * kk * ku) / (kk + ku) : 0.5 * (kk + ku);
          const gz = (kEff * vol[i]) / h;
          A[at(id, id)] += gz;
          A[at(id + n, id + n)] += gz;
          A[at(id, id + n)] -= gz;
          A[at(id + n, id)] -= gz;
        }
      }
      const last = k * n + n - 1;
      A[at(last, last)] += h * gOut;
      rhs[last] += h * gOut * coolant(b);
    }
    if (!o.refine) return { x: solveBanded(A, rhs, rows, n), out };
    // one step of iterative refinement: the unpivoted banded elimination loses a few digits on a matrix with a large spread of conductances
    const A0 = Float64Array.from(A);
    const b0 = Float64Array.from(rhs);
    const x = solveBanded(A, rhs, rows, n);
    const res = new Float64Array(rows);
    for (let i = 0; i < rows; i++) {
      let sum = b0[i];
      for (let j = Math.max(0, i - n); j <= Math.min(rows - 1, i + n); j++) sum -= A0[i * w2 + (j - i + n)] * x[j];
      res[i] = sum;
    }
    const dx = solveBanded(A0, res, rows, n);
    for (let i = 0; i < rows; i++) x[i] += dx[i];
    return { x, out };
  }

  const constant = [0, 1].every((s) => {
    const T1 = 300, T2 = 1800;
    const okK = [0, nf].every((i) => kOf(i, T1) === kOf(i, T2));
    return okK && (steady || [0, nf].every((i) => cOf(i, T1) === cOf(i, T2)));
  });

  function converge(Tstart, Told, t1, dt) {
    let Tn = Float64Array.from(Tstart);
    let res;
    for (let iter = 0; iter < 200; iter++) {
      res = step(Tn, Told, t1, dt);
      let delta = 0;
      for (let i = 0; i < rows; i++) delta = Math.max(delta, Math.abs(res.x[i] - Tn[i]));
      Tn = res.x;
      if (constant || delta < (o.tol || 1e-10)) break;
      if (iter === 199) throw new Error("Picard did not settle");
    }
    return { T: Tn, out: res.out };
  }
  const wallsOf = (T, out) => out.map((x, k) => (x.b.kind === "convective" ? x.wallW[0] * T[k * n + n - 1] + x.wallW[1] * x.Tcool : x.Tcool));
  const rejectedRate = (T, out) => out.reduce((s, x, k) => s + h * x.gOut * (T[k * n + n - 1] - x.Tcool), 0);

  if (steady) {
    const T0 = new Float64Array(rows).fill(coolant(m.bnd(0, 0)));
    const { T, out } = converge(T0, T0, 0, Infinity);
    let dep = 0;
    for (let k = 0; k < N; k++) dep += h * m.q(k, 0);
    return { r, n, states: [{ time: Infinity, T, wall: wallsOf(T, out), deposited: dep, rejected: rejectedRate(T, out) }] };
  }
  let T = Float64Array.from(o.initial);
  const states = [];
  {
    // wall of the start from the boundary at t = 0, conductivities at the start field
    const kv = new Float64Array(rows);
    for (let k = 0; k < N; k++) for (let i = 0; i < n; i++) kv[k * n + i] = kOf(i, T[k * n + i]);
    const out = [];
    for (let k = 0; k < N; k++) {
      const b = m.bnd(k, 0);
      const { gOut, wallW } = radialG(kv.subarray(k * n, (k + 1) * n), b);
      out.push({ gOut, wallW, b, Tcool: coolant(b) });
    }
    states.push({ time: 0, T: Float64Array.from(T), wall: wallsOf(T, out), deposited: 0, rejected: 0 });
  }
  let deposited = 0;
  let rejected = 0;
  for (let s = 1; s <= o.steps; s++) {
    const t1 = s * o.dt;
    const res = converge(T, T, t1, o.dt);
    // the source of a step is the new time's, as in transientFv (implicit Euler)
    for (let k = 0; k < N; k++) deposited += o.dt * h * m.q(k, t1);
    rejected += o.dt * rejectedRate(res.T, res.out);
    T = res.T;
    if (s % o.outputEvery === 0) states.push({ time: t1, T: Float64Array.from(T), wall: wallsOf(T, res.out), deposited, rejected });
  }
  // the energy stored since the start, J (per unit width for a plate)
  const T0 = Float64Array.from(o.initial);
  const stored = (Tx) => {
    let e = 0;
    for (let k = 0; k < N; k++) for (let i = 0; i < n; i++) e += h * vol[i] * (HOf(i, Tx[k * n + i]) - HOf(i, T0[k * n + i]));
    return e;
  };
  for (const st of states) st.stored = stored(st.T);
  return { r, n, states };
}

/** The probe's model of a normalised stack case (src/core/validate.ts NormalizedCase with `axial`), steady or transient. */
function modelOfCase(c, opt) {
  const a = c.axial;
  const loads = sliceLoads(c);
  if (opt && opt.powerSample === "average") {
    // variant: each layer gets the AVERAGE of the normalised shape over its height instead of the value at its centre
    const sh = normalizedShape(a);
    loads.forEach((l, k) => {
      const z0 = (k / a.slices), z1 = ((k + 1) / a.slices);
      let s = 0;
      const M = 400;
      for (let j = 0; j < M; j++) s += interpolate(sh.locations, sh.data, z0 + ((j + 0.5) * (z1 - z0)) / M);
      l.factor = s / M;
      l.linearHeatRate = c.qPrime * l.factor;
    });
  }
  const tr = c.transient;
  const hist = tr && tr.boundaryHistory;
  const power = (t) => {
    const { times, linearHeatRate } = tr;
    if (t <= times[0]) return linearHeatRate[0];
    for (let i = 1; i < times.length; i++) if (t <= times[i]) return linearHeatRate[i - 1] + ((linearHeatRate[i] - linearHeatRate[i - 1]) * (t - times[i - 1])) / (times[i] - times[i - 1]);
    return linearHeatRate[linearHeatRate.length - 1];
  };
  return {
    slab: !!c.plate,
    fuelInner: c.fuelInnerRadius,
    fuelR: c.fuelRadius,
    cladInner: c.claddingInnerRadius,
    cladOuter: c.claddingOuterRadius,
    nf: c.mesh.fuelCells,
    nc: c.mesh.claddingCells,
    N: a.slices,
    H: a.length,
    props: propsOf(c),
    gap: c.gapConductance,
    q: (k, t) => (tr ? power(t) * loads[k].factor : loads[k].linearHeatRate),
    bnd: (k, t) => (hist ? boundaryAtTime(hist, t) : loads[k].boundary),
    loads,
  };
}

module.exports = { solve2D, modelOfCase, propsOf, solveBanded };
