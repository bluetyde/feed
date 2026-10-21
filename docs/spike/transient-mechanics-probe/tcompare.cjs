// Throw-away (plan 17 M0, question 4): the temperature field OFFBEAT wrote with the mechanics on against the same case with the mechanics off (written time by written time), as the
// largest difference over the cells, in kelvin and as a fraction of the largest temperature rise above the start at that time. usage: node tcompare.cjs <outDirMech> <outDirControl>
const fs = require("fs");
const path = require("path");
const [a, b] = process.argv.slice(2);
const field = (f) => {
  const t = fs.readFileSync(f, "utf8");
  const m = /internalField\s+nonuniform\s+List<scalar>\s*(\d+)\s*\(/.exec(t);
  const body = t.slice(m.index + m[0].length);
  return body.slice(0, body.indexOf("\n)")).trim().split(/\s+/).map(Number);
};
const dirs = fs.readdirSync(path.join(a, "times")).filter((d) => fs.existsSync(path.join(b, "times", d)));
let worstK = 0, worstFrac = 0, at = "", n = 0;
const rows = [];
for (const d of dirs.sort((x, y) => Number(x) - Number(y))) {
  const Ta = field(path.join(a, "times", d, "T")), Tb = field(path.join(b, "times", d, "T"));
  const dT = Math.max(...Ta.map((x, i) => Math.abs(x - Tb[i])));
  const rise = Math.max(...Tb) - 293.15;
  const frac = rise > 1e-3 ? dT / rise : 0;
  n++;
  if (dT > worstK) { worstK = dT; at = d; }
  if (frac > worstFrac) worstFrac = frac;
  rows.push({ t: Number(d), dT, rise, frac });
}
const pick = (t) => rows.reduce((p, r) => (Math.abs(r.t - t) < Math.abs(p.t - t) ? r : p));
console.log(JSON.stringify({ timesCompared: n, worstDiffK: worstK, atTime: Number(at), worstFractionOfRise: worstFrac, atSample: [0.03, 0.06, 0.1, 1, 10, 30, 100].map((t) => { const r = pick(t); return { t: r.t, dT_K: r.dT, rise_K: r.rise, frac: r.frac }; }) }, null, 1));
