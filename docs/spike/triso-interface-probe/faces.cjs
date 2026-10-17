// Throw-away probe: the resistance OFFBEAT's cells imply across each face (dT / heat through the face) against candidate formulas. Usage: node faces.cjs <runs/file.json>
const fs = require("fs");
const run = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const eq = run.eq, cells = run.cells;
const A = (r) => 4 * Math.PI * r * r;
const resist = (a, b, k) => (1 / a - 1 / b) / (4 * Math.PI * k);
const bounds = [0, eq.kernelRadius, ...eq.layers.map((l) => l.outerRadius)];
const ks = [eq.kernelConductivity.k ?? eq.kernelConductivity.value, ...eq.layers.map((l) => l.conductivity.k)];
const N = run.N, P = eq.power.particlePower, kv = (4 / 3) * Math.PI * bounds[1] ** 3;
const idx = (i) => Math.floor(i / N);
const rows = [];
for (let i = 0; i < cells.length - 1; i++) {
  const ri = idx(i), rj = idx(i + 1);
  const a = bounds[ri], b = bounds[ri + 1], n = N;
  const f = a + ((b - a) * ((i % N) + 1)) / n;
  const Q = ri === 0 ? (P * ((4 / 3) * Math.PI * f ** 3)) / kv : P;
  const rP = cells[i].r, rN = cells[i + 1].r;
  const Reff = (cells[i].T - cells[i + 1].T) / Q;
  const gap = ri === 1 && rj === 2 ? 1 / (A(f) * eq.gapConductance) : 0;
  const ser = resist(rP, f, ks[ri]) + resist(f, rN, ks[rj]) + gap;
  const dP = f - rP, dN = rN - f;
  const kf = (ks[ri] * dN + ks[rj] * dP) / (dP + dN);
  const lin = (dP + dN) / (kf * A(f)) + gap;
  const planar = dP / (ks[ri] * A(f)) + dN / (ks[rj] * A(f)) + gap;
  rows.push({ i, ri, rj, f, Reff, ser, lin, planar, iface: ri !== rj });
}
const show = (r) => `face ${String(r.i).padStart(3)} reg ${r.ri}-${r.rj} Reff ${r.Reff.toExponential(5)}  Reff-ser ${((r.Reff - r.ser) * 1).toExponential(3)} (${(((r.Reff - r.ser) / r.ser) * 100).toFixed(3)} %)  Reff-planar ${((r.Reff - r.planar) / r.planar * 100).toFixed(3)} %  Reff-lin ${((r.Reff - r.lin) / r.lin * 100).toFixed(3)} %`;
const sel = process.argv[3] === "all" ? rows : rows.filter((r) => r.iface || r.i % N === 0 || r.i % N === N - 2);
sel.forEach((r) => console.log(show(r)));
