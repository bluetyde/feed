// Throw-away: the tables of docs/spike/triso-interface-probe.md from the saved runs (node docs/spike/triso-interface-probe/tables.cjs)
const fs = require("fs");
const { chain, SERIES, OFFB, model, A } = require("./replica.cjs");
const maxd = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const names = ["coldest", "hottest", "median", "thickest-buffer", "thinnest-sic"];
const Ns = [6, 12, 24, 48, 96, 192];
const load = (nm, N) => JSON.parse(fs.readFileSync(`docs/spike/triso-interface-probe/runs/triso-pop-${nm}-N${N}.json`, "utf8"));
function estimate(eq, N) {
  const { cells } = model(eq, N); const P = eq.power.particlePower; let sum = 0;
  for (let i = 0; i < cells.length - 1; i++) { const c = cells[i], d = cells[i + 1]; if (c.ri === d.ri || c.ri === 1) continue;
    const f = c.b, dP = f - c.r, dN = d.r - f, kf = (c.k * dN + d.k * dP) / (dP + dN); sum += Math.abs(P * ((dP + dN) / kf - dP / c.k - dN / d.k) / A(f)); }
  return sum;
}
console.log("\nTable A: largest |OFFBEAT - FEED FV| (K)\n| particle | " + Ns.map((n) => n + " cells").join(" | ") + " |\n|---|" + Ns.map(() => "---").join("|") + "|");
for (const nm of names) console.log("| " + nm + " | " + Ns.map((N) => { const r = load(nm, N); return maxd(r.cells.map((c) => c.T), chain(r.eq, N, SERIES).T).toFixed(4); }).join(" | ") + " |");
console.log("\nTable B: largest |OFFBEAT - replica of its face scheme| (K, 8-digit output)\n| particle | " + Ns.map((n) => n + " cells").join(" | ") + " |\n|---|" + Ns.map(() => "---").join("|") + "|");
for (const nm of names) console.log("| " + nm + " | " + Ns.map((N) => { const r = load(nm, N); return maxd(r.cells.map((c) => c.T), chain(r.eq, N, OFFB).T).toExponential(1); }).join(" | ") + " |");
console.log("\nTable C: measured largest deviation / estimate (sum of interface shifts)\n| particle | " + Ns.map((n) => n + " cells").join(" | ") + " |\n|---|" + Ns.map(() => "---").join("|") + "|");
let lo = 9, hi = 0;
for (const nm of names) console.log("| " + nm + " | " + Ns.map((N) => { const r = load(nm, N); const m = maxd(r.cells.map((c) => c.T), chain(r.eq, N, SERIES).T); const q = m / estimate(r.eq, N); lo = Math.min(lo, q); hi = Math.max(hi, q); return q.toFixed(3); }).join(" | ") + " |");
console.log("range", lo.toFixed(3), hi.toFixed(3));
console.log("\nTable D: widths and the kernel-centre deviation at 12 cells (signed, OFFBEAT - FEED)\n| particle | P (W) | kernel cell (um) | buffer cell (um) | rise (K) | kernel centre dev (K) | estimate (K) |\n|---|---|---|---|---|---|---|");
for (const nm of names) { const r = load(nm, 12), eq = r.eq; const ser = chain(eq, 12, SERIES).T; const hk = eq.kernelRadius / 12 * 1e6, hb = (eq.layers[0].outerRadius - eq.kernelRadius) / 12 * 1e6;
  console.log(`| ${nm} | ${eq.power.particlePower.toExponential(3)} | ${hk.toFixed(2)} | ${hb.toFixed(2)} | ${(ser[0] - ser[ser.length - 1]).toFixed(2)} | ${(r.cells[0].T - ser[0]).toFixed(4)} | ${estimate(eq, 12).toFixed(4)} |`); }
