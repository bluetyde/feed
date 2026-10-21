// Throw-away (plan 17 M0, question 6): the transit time of a stress wave across the fuel against the speed of the pulse. Densities are NOT in FEED's cases (the writer's rho is a
// placeholder carrier for the heat capacity): the fuel value is the K-State SAR Table 13.3 figure that the example's own text quotes (5996 kg/m3 for U-ZrH, "340.1 + 0.6952 T[C] J/kg/K at
// 5996 kg/m3"), the steel value is the same table's 7900 kg/m3 (also quoted in the example's cladding heat-capacity source). Both are read from the example file, not from the SAR itself.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "..");
const ex = JSON.parse(fs.readFileSync(path.join(root, "examples/ut-triga-pulse-4p40-limits.json"), "utf8"));
const lib = JSON.parse(fs.readFileSync(path.join(root, "library/materials.json"), "utf8"));
const fm = lib.find((e) => e.material && e.material.materialId === "triga-uzrh-h16").material.sets;
const Ea = fm["mechanical.elasticity"].a.value, Eb = fm["mechanical.elasticity"].b.value;
const rhoF = 5996, rhoC = 7900;
const R = 18.161e-3, Ri = 3.175e-3, t = 0.508e-3;
const rows = [];
for (const [name, E, nu, rho, len] of [
  ["fuel, 293 K", Ea + Eb * 293.15, 0.32, rhoF, R - Ri],
  ["fuel, 923 K (end of the library's range)", Ea + Eb * 923.15, 0.32, rhoF, R - Ri],
  ["fuel, 1097 K (the pulse's peak, law extrapolated)", Ea + Eb * 1097, 0.32, rhoF, R - Ri],
  ["cladding, 190 GPa", 190e9, 0.3, rhoC, t],
]) {
  const c1 = Math.sqrt(E / rho); // thin bar
  const cp = Math.sqrt((E * (1 - nu)) / (rho * (1 + nu) * (1 - 2 * nu))); // dilatational wave in an infinite medium
  rows.push({ name, E_GPa: E / 1e9, c_bar: c1, c_dilatational: cp, transit_us_bar: (len / c1) * 1e6, transit_us_dil: (len / cp) * 1e6, lengthMm: len * 1e3 });
}
// the pulse: the fastest relative change of the power, and the time to rise from 10 % to the peak
const h = ex.transient.powerHistory.map((p) => [p.time.value / 1e3, p.linearHeatRate.value * (p.linearHeatRate.unit === "MW/m" ? 1e6 : 1)]);
let peak = 0, ip = 0;
h.forEach(([t0, q], i) => { if (q > peak) { peak = q; ip = i; } });
const t10 = h.find(([, q]) => q >= 0.1 * peak)[0];
let fast = 0, at = 0;
for (let i = 1; i < h.length; i++) {
  if (!(h[i][1] > 0 && h[i - 1][1] > 0)) continue; // the last point is zero
  const rate = Math.abs(Math.log(h[i][1] / h[i - 1][1])) / (h[i][0] - h[i - 1][0]);
  if (rate > fast) { fast = rate; at = h[i][0]; }
}
const out = { rows, peakMW_per_m: peak / 1e6, peakTime_ms: h[ip][0] * 1e3, t10pct_ms: t10 * 1e3, riseFrom10pct_ms: (h[ip][0] - t10) * 1e3, fastestLogRate_per_s: fast, doublingTime_ms: (Math.log(2) / fast) * 1e3, atTime_ms: at * 1e3, steps_ms: 0.05 };
out.ratio = { doublingTime_over_barTransit_fuel: (out.doublingTime_ms * 1e-3) / (rows[2].transit_us_bar * 1e-6), riseTime_over_barTransit_fuel: (out.riseFrom10pct_ms * 1e-3) / (rows[2].transit_us_bar * 1e-6) };
console.log(JSON.stringify(out, null, 1));
