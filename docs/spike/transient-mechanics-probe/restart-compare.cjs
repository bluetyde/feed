// Throw-away (plan 17 M0, question 5): the fields OFFBEAT wrote at the same times in two runs (matched by time to the microsecond), as the largest difference over the cells of the
// displacement, the stress and the temperature, as a fraction of the larger run's own largest value, plus the contact pressure and the gap. usage: node restart-compare.cjs <outA> <outB> <fromSeconds> <toSeconds>
const fs = require("fs");
const path = require("path");
const [A, B, from, to] = process.argv.slice(2);
const field = (f, w) => {
  const t = fs.readFileSync(f, "utf8");
  const m = /internalField\s+nonuniform\s+List<[a-zA-Z]+>\s*(\d+)\s*\(/.exec(t);
  const body = t.slice(m.index + m[0].length);
  const inner = body.slice(0, body.indexOf("\n)"));
  return w === 1 ? inner.trim().split(/\s+/).map(Number) : [...inner.matchAll(/\(([^()]*)\)/g)].map((r) => r[1].trim().split(/\s+/).map(Number));
};
const patch = (f, name) => {
  const t = fs.readFileSync(f, "utf8");
  const b = t.slice(t.indexOf("boundaryField"));
  const m = new RegExp(`\\b${name}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(b);
  const u = /value\s+uniform\s+([-+.\deE]+)\s*;/.exec(m[1]);
  return Number(u[1]);
};
const key = (d) => Math.round(Number(d) * 1e6);
const list = (X) => new Map(fs.readdirSync(path.join(X, "times")).map((d) => [key(d), d]));
const a = list(A), b = list(B);
const rows = [];
for (const [k, da] of [...a.entries()].sort((x, y) => x[0] - y[0])) {
  const t = k / 1e6;
  if (t < Number(from) || t > Number(to) || !b.has(k)) continue;
  const db = b.get(k);
  const pa = (X, d, f) => path.join(X, "times", d, f);
  const rel = (fa, fb, w, pick) => {
    const x = field(pa(A, da, fa), w), y = field(pa(B, db, fb), w);
    const scale = Math.max(...x.flat().map(Math.abs), ...y.flat().map(Math.abs), 1e-30);
    let d = 0;
    x.forEach((v, i) => { const u = y[i]; if (w === 1) d = Math.max(d, Math.abs(v - u)); else for (const c of pick) d = Math.max(d, Math.abs(v[c] - u[c])); });
    return { abs: d, rel: d / scale };
  };
  rows.push({
    t,
    D: rel("D", "D", 3, [0]),
    sigma: rel("sigmaCyl", "sigmaCyl", 6, [0, 3, 5]),
    T: rel("T", "T", 1),
    dP_Pa: Math.abs(patch(pa(A, da, "interfaceP"), "fuelOuter") - patch(pa(B, db, "interfaceP"), "fuelOuter")),
    P_A: patch(pa(A, da, "interfaceP"), "fuelOuter"),
    dGap_m: Math.abs(patch(pa(A, da, "gapWidth"), "fuelOuter") - patch(pa(B, db, "gapWidth"), "fuelOuter")),
  });
}
const worst = (g) => rows.reduce((m, r) => Math.max(m, g(r)), 0);
const first = rows[0];
console.log(
  JSON.stringify({
    timesCompared: rows.length,
    from: rows[0] && rows[0].t,
    to: rows[rows.length - 1] && rows[rows.length - 1].t,
    worstRelD: worst((r) => r.D.rel), worstAbsD_m: worst((r) => r.D.abs),
    worstRelSigma: worst((r) => r.sigma.rel), worstAbsSigma_Pa: worst((r) => r.sigma.abs),
    worstAbsT_K: worst((r) => r.T.abs),
    worstAbsDP_Pa: worst((r) => r.dP_Pa), PatFirst_Pa: first && first.P_A, worstAbsDGap_m: worst((r) => r.dGap_m),
    firstRow: first,
  }),
);
