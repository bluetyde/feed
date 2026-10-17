// Throw-away probe: the same face-by-face reconstruction for the pebble goldens (plan 13 T4): the resistance OFFBEAT's cells imply across the fuelled/shell face against the
// exact series, the planar series, and the linear-k scheme (conductivities at the two cells' temperatures). Usage (repo root): node pebble-face.cjs <golden dir>
const fs = require("fs");
const dir = process.argv[2];
const res = JSON.parse(fs.readFileSync(dir + "/results.json", "utf8"));
const n = JSON.parse(fs.readFileSync(dir + "/normalized.json", "utf8"));
const lam = Math.cos(Math.PI / 180) / Math.sqrt(1 + Math.sin(Math.PI / 180) ** 2);
const A = (r) => 4 * Math.PI * r * r;
const resist = (a, b, k) => (1 / a - 1 / b) / (4 * Math.PI * k);
const kF = (T) => n.fuelledConductivity.coefficients.reduce((s, c, i) => s + c * T ** i, 0);
const kS = () => n.shellConductivity.k;
const cells = res.cells.slice().sort((a, b) => a.r - b.r);
const [nf, ns] = n.cells;
const Rf = n.fuelledRadius * lam, q = n.power.powerDensity;
const kOf = (c) => (c.region === "fuelled" ? kF(c.T) : kS());
const rows = [];
for (let i = 0; i < nf + ns - 1; i++) {
  const c = cells[i], d = cells[i + 1];
  const region = i < nf ? 0 : 1;
  const faceF = region === 0 ? ((i + 1) / nf) * Rf : Rf + (((i + 1 - nf) / ns) * (n.outerRadius * lam - Rf));
  const Q = q * (4 / 3) * Math.PI * Math.min(faceF, Rf) ** 3;
  const Reff = (c.T - d.T) / Q;
  const k1 = kOf(c), k2 = kOf(d);
  const dP = faceF - c.r, dN = d.r - faceF;
  const kf = (k1 * dN + k2 * dP) / (dP + dN);
  rows.push({ i, faceF, Reff, ex: resist(c.r, faceF, k1) + resist(faceF, d.r, k2), pl: dP / (k1 * A(faceF)) + dN / (k2 * A(faceF)), lin: (dP + dN) / (kf * A(faceF)), dP, dN, k1, k2, Q, dT: c.T - d.T });
}
const show = (r) => console.log(`face ${r.i} Reff ${r.Reff.toExponential(5)} vs exact series ${(100 * (r.Reff / r.ex - 1)).toFixed(3)} %  planar series ${(100 * (r.Reff / r.pl - 1)).toFixed(3)} %  linear-k ${(100 * (r.Reff / r.lin - 1)).toFixed(3)} %   Q (R_lin - R_ex) = ${(r.Q * (r.lin - r.ex)).toFixed(4)} K, Q (R_eff - R_ex) = ${(r.Q * (r.Reff - r.ex)).toFixed(4)} K, Q (R_pl - R_ex) = ${(r.Q * (r.pl - r.ex)).toFixed(4)}`);
[rows[nf - 2], rows[nf - 1], rows[nf], rows[0], rows[5]].forEach(show);
// interior faces: sum of Q (Reff - ex) over the fuelled zone and over the shell, away from the interface
const sum = (a, b) => rows.slice(a, b).reduce((s, r) => s + r.Q * (r.Reff - r.ex), 0);
console.log("sum over fuelled interior faces of Q (Reff - ex):", sum(0, nf - 1).toFixed(4), " shell interior:", sum(nf, nf + ns - 1).toFixed(4));
