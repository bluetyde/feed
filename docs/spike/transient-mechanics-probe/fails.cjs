// Throw-away (plan 17 M0): the written times at which a check fails in an analysis JSON (OFFBEAT's own temperatures, or --fv for the finite-volume ones), grouped by check, with the
// size of the stress scale at those times and the worst overshoot of the bound. usage: node fails.cjs <an-tag.json> [--fv]
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const key = process.argv.includes("--fv") ? "withFvT" : "withOffbeatT";
const groups = { stress: [], equil: [], disp: [], contact: [] };
const tl = (t) => (t < 1 ? (t * 1e3).toFixed(1) + " ms" : t.toFixed(1) + " s");
for (const r of j.rows) {
  const a = r[key];
  if (!a) continue;
  const maxS = Math.max(a.fuel.sMaxIndepMPa, a.cladding.sMaxIndepMPa);
  if (!a.sOk) groups.stress.push({ t: r.time, maxS, over: Math.max(a.fuel.sDev / a.fuel.sTol, a.cladding.sDev / a.cladding.sTol) });
  if (!a.eqOk) groups.equil.push({ t: r.time, maxS, over: Math.max(a.fuel.eqRes / a.fuel.eqTol, a.cladding.eqRes / a.cladding.eqTol) });
  if (!a.uOk) groups.disp.push({ t: r.time, maxS, over: Math.max(a.fuel.uDev / a.fuel.uTol, a.cladding.uDev / a.cladding.uTol) });
  if (!a.contactOk) groups.contact.push({ t: r.time, maxS, over: 0, note: a.contactNote });
}
for (const [k, g] of Object.entries(groups)) {
  if (!g.length) { console.log(k + ": none"); continue; }
  const lo = g[0], hi = g[g.length - 1];
  console.log(`${k}: ${g.length} times, ${tl(lo.t)} to ${tl(hi.t)}, largest independent stress there ${Math.max(...g.map((x) => x.maxS)).toFixed(2)} MPa, smallest ${Math.min(...g.map((x) => x.maxS)).toFixed(3)} MPa, worst deviation / bound ${Math.max(...g.map((x) => x.over)).toFixed(2)}${g[0].note ? "; e.g. " + g[0].note : ""}`);
}
