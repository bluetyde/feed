// Throw-away (plan 17 M0, question 5): the thermo-elastic solution of the two-solid slice with the modulus and the thermal strain given AS LAWS OF TEMPERATURE cell by cell
// (src/core/thermoElastic.ts takes constants per solid; this is a probe-local finite-element version for E(r) and eps_th(r), generalised plane strain, free axially, not shipped).
// One solid: u(r) piecewise linear on N elements, eps_r = u', eps_t = u / r, eps_z = e (one unknown), sigma = c[(1-nu) eps_i + nu (eps_j + eps_k - 2 eps_th... )] as in thermoElastic.ts:
//   sigma_r = c [(1-nu)(eps_r - th) + nu (eps_t - th) + nu (e - th)],  c = E / ((1+nu)(1-2nu)),  th = the thermal strain (isotropic).
// Weak form: integral (sigma_r du' + sigma_t du / r) r dr = -pb b du(b) + pa a du(a); axial: integral sigma_z r dr = axial force. The module validates itself against thermoElastic.js
// when run directly (node vp.cjs).
const path = require("path");
const root = path.join(__dirname, "..", "..", "..");

function gauss(M, rhs) {
  const n = rhs.length;
  const a = M.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      if (f !== 0) for (let cc = col; cc <= n; cc++) a[r][cc] -= f * a[col][cc];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = a[i][n];
    for (let j = i + 1; j < n; j++) s -= a[i][j] * x[j];
    x[i] = s / a[i][i];
  }
  return x;
}

/** s = { a, b, nu, E(r), th(r) } (r in m); pa on the inside (0 for a solid without a hole... or a hole at pressure pa), pb on the outside, axial force per 2 pi. Returns the field. */
function solveSolidVP(s, pa, pb, axialForce = 0, N = 300) {
  const n = N + 1;
  const rs = Array.from({ length: n }, (_, i) => s.a + ((s.b - s.a) * i) / N);
  const size = n + 1; // u nodes + e
  const K = Array.from({ length: size }, () => new Array(size).fill(0));
  const F = new Array(size).fill(0);
  const nu = s.nu;
  const gp = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  const cOf = (E) => E / ((1 + nu) * (1 - 2 * nu));
  for (let k = 0; k < N; k++) {
    const r0 = rs[k], r1 = rs[k + 1], h = r1 - r0;
    for (const g of gp) {
      const r = 0.5 * (r0 + r1) + 0.5 * h * g;
      const w = 0.5 * h; // Gauss weight 1 on [-1,1] -> h/2
      const N0 = (r1 - r) / h, N1 = (r - r0) / h;
      const dN = [-1 / h, 1 / h];
      const Nn = [N0, N1];
      const E = s.E(r), th = s.th(r), c = cOf(E);
      // sigma = D (eps) - load, eps = (B u, e): rows: sigma_r, sigma_t, sigma_z
      // sigma_r = c[(1-nu) eps_r + nu eps_t + nu e] - c (1+nu) th ; sigma_t = c[(1-nu) eps_t + nu eps_r + nu e] - c(1+nu) th ; sigma_z = c[(1-nu) e + nu (eps_r + eps_t)] - c (1+nu) th
      const load = c * (1 + nu) * th;
      for (let i = 0; i < 2; i++) {
        const gi = k + i;
        // virtual displacement i: d eps_r = dN[i], d eps_t = Nn[i]/r
        for (let j = 0; j < 2; j++) {
          const gj = k + j;
          const er = dN[j], et = Nn[j] / r;
          const sr = c * ((1 - nu) * er + nu * et), st = c * ((1 - nu) * et + nu * er);
          K[gi][gj] += (sr * dN[i] + st * (Nn[i] / r)) * r * w;
        }
        // coupling with e
        K[gi][n] += (c * nu * dN[i] + c * nu * (Nn[i] / r)) * r * w;
        F[gi] += load * (dN[i] + Nn[i] / r) * r * w;
        // axial equation row: integral sigma_z r dr = axialForce
        const er = dN[i], et = Nn[i] / r;
        K[n][gi] += c * nu * (er + et) * r * w;
      }
      K[n][n] += c * (1 - nu) * r * w;
      F[n] += load * r * w; // sigma_z has -load
    }
  }
  F[n] += axialForce;
  // boundary tractions: sigma_r(b) = -pb, sigma_r(a) = -pa: the virtual work [sigma_r r du] from a to b = -pb b du(b) + pa a du(a)
  F[N] += -pb * s.b;
  F[0] += pa * s.a;
  const x = gauss(K, F);
  const u = x.slice(0, n);
  const e = x[n];
  const at = (r) => {
    let k = Math.min(N - 1, Math.max(0, Math.floor(((r - s.a) / (s.b - s.a)) * N)));
    const r0 = rs[k], r1 = rs[k + 1], h = r1 - r0;
    const ur = u[k] + ((u[k + 1] - u[k]) * (r - r0)) / h;
    const er = (u[k + 1] - u[k]) / h, et = ur / r;
    const E = s.E(r), th = s.th(r), c = cOf(E), load = c * (1 + nu) * th;
    return {
      ur,
      sigmaR: c * ((1 - nu) * er + nu * et + nu * e) - load,
      sigmaTheta: c * ((1 - nu) * et + nu * er + nu * e) - load,
      sigmaZ: c * ((1 - nu) * e + nu * (er + et)) - load,
    };
  };
  return { at, surface: (r) => at(r), e };
}

/** The slice: fuel and cladding (each as above); the gap is clad.a - fuel.b; returns the same as thermoElastic.solveSlice. */
function solveSliceVP(fuel, clad, coolantPressure = 0, N = 300) {
  const solve = (p) => ({ f: solveSolidVP(fuel, 0, p, 0, N), g: solveSolidVP(clad, p, coolantPressure, 0, N) });
  const gapAt = (s) => clad.a - fuel.b + s.g.surface(clad.a).ur - s.f.surface(fuel.b).ur;
  const open = solve(0);
  const freeGap = gapAt(open);
  if (freeGap > 0) return { fuel: open.f, cladding: open.g, gap: freeGap, freeGap, contact: false, contactPressure: 0 };
  const probe = 1e6;
  const slope = (gapAt(solve(probe)) - freeGap) / probe;
  const total = -freeGap / slope;
  const closed = solve(total);
  return { fuel: closed.f, cladding: closed.g, gap: 0, freeGap, contact: true, contactPressure: total };
}

module.exports = { solveSolidVP, solveSliceVP };

if (require.main === module) {
  // self-check against thermoElastic.js: constant properties, a non-uniform theta
  const { solveSlice } = require(path.join(root, "dist/core/thermoElastic.js"));
  const fuel = { a: 3.175e-3, b: 18.161e-3, nu: 0.32, E: 4.2e10, alpha: 1.1e-5, theta: (r) => 500 + 4e4 * (r - 3.175e-3) - 2e6 * (r - 3.175e-3) ** 2 };
  const clad = { a: 18.161e-3 - 30e-6, b: 18.669e-3, nu: 0.3, E: 1.9e11, alpha: 1.72e-5, theta: (r) => 400 + 3e4 * (r - 18.161e-3) };
  const ref = solveSlice(fuel, clad, "free-axial", 0, 0);
  const vp = solveSliceVP(
    { a: fuel.a, b: fuel.b, nu: fuel.nu, E: () => fuel.E, th: (r) => fuel.alpha * fuel.theta(r) },
    { a: clad.a, b: clad.b, nu: clad.nu, E: () => clad.E, th: (r) => clad.alpha * clad.theta(r) },
    0,
  );
  const rows = [];
  for (const rr of [3.2e-3, 8e-3, 12e-3, 18.1e-3]) {
    const x = ref.fuel.at(rr), y = vp.fuel.at(rr);
    rows.push([rr, x.ur, y.ur, x.sigmaTheta / 1e6, y.sigmaTheta / 1e6, x.sigmaZ / 1e6, y.sigmaZ / 1e6]);
  }
  for (const rr of [18.2e-3, 18.5e-3]) {
    const x = ref.cladding.at(rr), y = vp.cladding.at(rr);
    rows.push([rr, x.ur, y.ur, x.sigmaTheta / 1e6, y.sigmaTheta / 1e6, x.sigmaZ / 1e6, y.sigmaZ / 1e6]);
  }
  console.log("contact", ref.contact, vp.contact, "p", ref.contactPressure / 1e6, vp.contactPressure / 1e6, "freeGap um", ref.freeGap * 1e6, vp.freeGap * 1e6);
  console.log("r  ur_ref ur_vp  hoop_ref hoop_vp  axial_ref axial_vp");
  for (const r of rows) console.log(r.map((v) => v.toPrecision(6)).join("  "));
}
