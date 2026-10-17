// Throw-away probe: the interface estimate against the measured runs. For each non-gap interface: P * |R_lin - R_series| with the planar distances from the two cell centroids to the face.
// Prints, per run, the measured max |OFFBEAT - FEED|, the sum of the estimates, their ratio, and the ratio to (existing bound + estimate).
const fs = require("fs");
const { chain, SERIES, model, A } = require("./replica.cjs");
const maxd = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
function estimate(eq, N) {
  const { cells } = model(eq, N);
  const P = eq.power.particlePower;
  let sum = 0; const each = [];
  for (let i = 0; i < cells.length - 1; i++) {
    const c = cells[i], d = cells[i + 1];
    if (c.ri === d.ri) continue;
    if (c.ri === 1) continue; // the gap
    const f = c.b, dP = f - c.r, dN = d.r - f;
    const a = dP / c.k, b = dN / d.k;
    const kf = (c.k * dN + d.k * dP) / (dP + dN);
    const dR = ((dP + dN) / kf - a - b) / A(f);
    each.push(P * dR); sum += Math.abs(P * dR);
  }
  return { sum, each };
}
const names = ["coldest", "hottest", "median", "thickest-buffer", "thinnest-sic"];
console.log("case N  measured  estimate  meas/est  rise  base  meas/(base+est)");
for (const N of [6, 12, 24, 48, 96, 192]) for (const nm of names) {
  const run = JSON.parse(fs.readFileSync(`docs/spike/triso-interface-probe/runs/triso-pop-${nm}-N${N}.json`, "utf8"));
  const ser = chain(run.eq, N, SERIES).T;
  const meas = maxd(run.cells.map((c) => c.T), ser);
  const est = estimate(run.eq, N);
  const rise = ser[0] - ser[ser.length - 1] + 0; // approx rise: centre minus outermost cell
  const base = Math.max(0.003 * rise, 0.02);
  console.log(nm.padEnd(16), String(N).padStart(3), meas.toFixed(4), est.sum.toFixed(4), (meas / est.sum).toFixed(3), rise.toFixed(2), base.toFixed(3), (meas / (base + est.sum)).toFixed(3), est.each.map((x) => x.toFixed(4)).join(" "));
}
