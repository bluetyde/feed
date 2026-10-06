// examples/synthetic-pulse-operating.json: the synthetic pulse pin started from its steady operating state instead of a uniform temperature.
// The pin runs at 20 kW/m, a 10 ms triangular pulse (peak 10 MW/m) is added on top of that background, and the power returns to 20 kW/m.
// Run: node scripts/make-operating-pulse.cjs
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const d = JSON.parse(fs.readFileSync(path.join(root, "examples", "synthetic-pulse.json"), "utf8"));
const q = (v, unit) => ({ value: v, unit });
d.caseId = "synthetic-pulse-operating";
d.name = "Synthetic pulse on an operating pin: a 10 ms pulse on top of a steady 20 kW/m (illustrative numbers, not a real fuel design)";
d.description =
  "The synthetic pin held at 20 kW/m until it is steady (the starting temperature field is that steady state, computed on the case's own mesh), then a 10 ms triangular pulse (peak 10 MW/m at 5 ms) on top of the background, then 90 ms more at 20 kW/m. " +
  "The pulse adds 49.9 kJ/m above the background, about 315 K of adiabatic heating in the fuel interior. The power history is the TOTAL power, so it starts at the operating value. Synthetic heat capacities. Thermal only; the power history is an input, not a result.";
delete d.transient.initialTemperature;
d.transient.initialSteadyLinearHeatRate = q(20, "kW/m");
d.transient.powerHistory = [
  { time: q(0, "ms"), linearHeatRate: q(20, "kW/m") },
  { time: q(5, "ms"), linearHeatRate: q(10, "MW/m") },
  { time: q(10, "ms"), linearHeatRate: q(20, "kW/m") },
  { time: q(100, "ms"), linearHeatRate: q(20, "kW/m") },
];
fs.writeFileSync(path.join(root, "examples", "synthetic-pulse-operating.json"), JSON.stringify(d, null, 2) + "\n");
console.log("wrote examples/synthetic-pulse-operating.json");
