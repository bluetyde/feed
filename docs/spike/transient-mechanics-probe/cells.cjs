// Throw-away: print OFFBEAT's cell values against the independent solution (OFFBEAT's own T) at one written time. usage: node cells.cjs <inDir> <outDir> <time_ms> [step]
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "..");
const { solveSlice } = require(path.join(root, "dist/core/thermoElastic.js"));
const [inDir, outDir, tms] = process.argv.slice(2);
const step = Number(process.argv[5] || 6);
const meta = JSON.parse(fs.readFileSync(path.join(inDir, "probe-meta.json"), "utf8"));
const lf = (text, w) => {
  const m = /internalField\s+nonuniform\s+List<[a-zA-Z]+>\s*(\d+)\s*\(/.exec(text);
  const body = text.slice(m.index + m[0].length);
  const inner = body.slice(0, body.indexOf("\n)"));
  return w === 1 ? inner.trim().split(/\s+/).map((x) => [Number(x)]) : [...inner.matchAll(/\(([^()]*)\)/g)].map((r) => r[1].trim().split(/\s+/).map(Number));
};
const dirs = fs.readdirSync(path.join(outDir, "times")).map((d) => ({ d, t: Number(d) }));
const sel = dirs.reduce((a, b) => (Math.abs(b.t * 1e3 - Number(tms)) < Math.abs(a.t * 1e3 - Number(tms)) ? b : a));
const rd = (f) => fs.readFileSync(path.join(outDir, "times", sel.d, f), "utf8");
const C = lf(fs.readFileSync(path.join(outDir, "C"), "utf8"), 3).map((v) => Math.hypot(v[0], v[1]));
const T = lf(rd("T"), 1).map((v) => v[0]), D = lf(rd("D"), 3), S = lf(rd("sigmaCyl"), 6);
const nf = meta.nf, Tref = meta.Tref;
const interp = (rs, Ts) => (x) => { let i = rs.findIndex((v) => v >= x); if (i <= 0) i = 1; if (i < 0) i = rs.length - 1; return Ts[i - 1] + ((Ts[i] - Ts[i - 1]) * (x - rs[i - 1])) / (rs[i] - rs[i - 1]) - Tref; };
const fuel = { a: meta.fuelInnerRadius, b: meta.fuelRadius, ...meta.fuel, theta: interp(C.slice(0, nf), T.slice(0, nf)) };
const clad = { a: meta.claddingInnerRadius, b: meta.claddingOuterRadius, ...meta.clad, theta: interp(C.slice(nf), T.slice(nf)) };
const sol = solveSlice(fuel, clad, "free-axial", 0, 0);
console.log("time", sel.t, "freeGap um", sol.freeGap * 1e6, "contact", sol.contact);
console.log("i r_mm T  ur_off ur_ind ratio | sigR_off sigR_ind | hoop_off hoop_ind | axial_off axial_ind (MPa)");
const idx = [...Array(C.length).keys()].filter((i) => i % step === 0 || i === nf - 1 || i === nf || i === C.length - 1);
for (const i of idx) {
  const s = (i < nf ? sol.fuel : sol.cladding).at(C[i]);
  const f = (x, d = 4) => (x / 1e6).toFixed(d);
  console.log(i, (C[i] * 1e3).toFixed(3), T[i].toFixed(2), D[i][0].toExponential(4), s.ur.toExponential(4), (D[i][0] / s.ur).toFixed(4), "|", f(S[i][0]), f(s.sigmaR), "|", f(S[i][3]), f(s.sigmaTheta), "|", f(S[i][5]), f(s.sigmaZ));
}
