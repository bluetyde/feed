"use strict";
// Builds examples/ut-triga-pulse-4p40.json: an ILLUSTRATIVE TRIGA pulse made from numbers in the UT-Austin TRIGA II SAR (8/2023)
// plus one stated assumption (the shape of the pulse). Run: node scripts/make-ut-pulse.cjs
//
// From the SAR: fuel k = 0.18 W/cm/K and heat capacity 2.04 + 0.00417 T[C] J/cm3/K (Table 4.1); fuel and cladding diameters
// (Table 4.1); fuel length 38.1 cm; element axial peaking 1.017 (Table 4.17); peak pulse power of the hot channel at $4.40 about
// 8.9e4 kW (Figure 4.32, read from the figure); maximum fuel temperature 824 C at $4.40 (text of section 4.6); Zr fill rod
// 0.125 in radius (Figure 4.30). K-State SAR Table 13.3 for the cladding (density 7900 kg/m3, Cp 477 J/kg/K at 300 K).
// NOT from the SAR: the power-versus-time curve. It is assumed to be sech^2 (the exact shape of an adiabatic Nordheim-Fuchs
// excursion), with its width fixed so that the energy deposited takes the fuel from the pool temperature to 824 C if no heat
// leaves. The width that results (about 11 ms FWHM) is a plausibility check on the SAR's three numbers, not a result.

const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const NL = String.fromCharCode(10);

const rFuel = 0.018161;
const rHole = 0.003175;
const length = 0.381;
const axialPeaking = 1.017;
const peakElementPower = 8.9e7; // W, Figure 4.32 at $4.40 (read from the figure)
const peakTempC = 824; // text of section 4.6
const t0 = 293.15; // pool at 20 C
// fuel heat capacity c = 2.04e6 + 4170 (T - 273.15) J/m3/K  =  a + b T
const b = 4170;
const a = 2.04e6 - b * 273.15;
const tPeak = peakTempC + 273.15;
const dH = a * (tPeak - t0) + 0.5 * b * (tPeak * tPeak - t0 * t0); // J/m3 per unit fuel volume
const area = Math.PI * (rFuel * rFuel - rHole * rHole);
const energyPerLength = dH * area; // J/m
const peakLhgr = (peakElementPower / length) * axialPeaking; // W/m at the peak slice
const tau = energyPerLength / (2 * peakLhgr); // sech^2(t/tau): integral = 2 tau P
const fwhm = 2 * Math.log(1 + Math.SQRT2) * tau;

// tabulated history: 0.5 ms spacing over 0..60 ms, then a zero tail; the table is rescaled so its trapezoid integral is exactly
// the target energy (a coarse table of a smooth pulse is off by a fraction of a percent)
const dt = 0.5e-3;
const t1 = 0.06;
const centre = 0.03;
const times = [];
const raw = [];
for (let t = 0; t <= t1 + 1e-12; t += dt) {
  times.push(Number(t.toFixed(6)));
  raw.push(1 / Math.cosh((t - centre) / tau) ** 2);
}
let integral = 0;
for (let i = 1; i < times.length; i++) integral += 0.5 * (raw[i] + raw[i - 1]) * (times[i] - times[i - 1]);
const scale = energyPerLength / integral;
const lhgr = raw.map((v) => v * scale);

const history = times.map((t, i) => ({ time: { value: Number((t * 1e3).toFixed(3)), unit: "ms" }, linearHeatRate: { value: Number((lhgr[i] / 1e6).toPrecision(6)), unit: "MW/m" } }));
history.push({ time: { value: 100, unit: "ms" }, linearHeatRate: { value: 0, unit: "W/m" } });

const doc = {
  schema: "feed.case/0.1",
  caseId: "ut-triga-pulse-4p40",
  name: "TRIGA $4.40 pulse, hot channel, built from UT-Austin SAR numbers (illustrative)",
  label: "synthetic",
  citation:
    "Properties and geometry from the University of Texas TRIGA II SAR, Chapter 4 (8/2023): fuel k 0.18 W/cm/K and heat capacity 2.04 + 0.00417 T[C] J/cm3/K (Table 4.1; the K-State SAR Table 13.3 gives the same law as 340.1 + 0.6952 T[C] J/kg/K at 5996 kg/m3), diameters and the 38.1 cm fuel length (Table 4.1), the 6.35 mm zirconium fill rod (Figure 4.30), element axial peaking 1.017 (Table 4.17). Cladding heat capacity 7900 kg/m3 x 477 J/kg/K at 300 K from the K-State SAR Table 13.3. Pulse numbers: peak hot-channel power about 8.9e4 kW at $4.40 (Figure 4.32, READ FROM THE FIGURE) and maximum fuel temperature 824 C (section 4.6). Gap conductance 4096 W/m2/K and the SAR's TRACE wall temperature are not used; the gap value is read from Figure 4.30 (see ut-triga-hot-channel-annular).",
  description:
    "ILLUSTRATIVE, not a reproduction of the SAR. The SAR gives the peak power and the peak temperature of a $4.40 pulse but not the power-versus-time curve, so the curve here is ASSUMED to be sech^2 (the exact shape of an adiabatic Nordheim-Fuchs excursion) with the width chosen so that the energy deposited takes the fuel from 20 C to 824 C if no heat leaves: " +
    (energyPerLength / 1e6).toFixed(3) +
    " MJ/m, " +
    (peakLhgr / 1e6).toFixed(1) +
    " MW/m at the peak (8.9e4 kW over 0.381 m x 1.017), FWHM " +
    (fwhm * 1e3).toFixed(1) +
    " ms. A pulse width of about 10 ms is what a $4 TRIGA pulse looks like, so the SAR's three numbers are consistent; that is a plausibility check, not a validation. The peak temperature is 824 C by construction (the interior is adiabatic over a pulse this short). What the case shows is the effect of the temperature-dependent heat capacity (the fuel's heat capacity roughly doubles over the pulse) and the cool-down after it. The film coefficient is an assumed 10 kW/m2/K. Thermal only: the power history is an input, FEED does not compute the pulse.",
  assumptions: { thermalOnly: true, steadyState: false, geometry: "1D-radial" },
  geometry: {
    fuelRadius: { value: 18.161, unit: "mm" },
    fuelInnerRadius: { value: 3.175, unit: "mm" },
    claddingInnerRadius: { value: 18.161, unit: "mm" },
    claddingOuterRadius: { value: 18.669, unit: "mm" },
  },
  power: { radialShape: "uniform" },
  boundary: { bulkTemperature: { value: 20, unit: "degC" }, heatTransferCoefficient: { value: 10, unit: "kW/m2/K" } },
  materials: {
    fuel: {
      materialId: "triga-uzrh-pulse",
      revision: 1,
      sets: {
        "thermal.conductivity": {
          model: "constant",
          value: { value: 18, unit: "W/m/K" },
          referenceTemperature: { value: 300, unit: "K" },
          source: "UT-Austin SAR Table 4.1 (0.18 W/cm/K); K-State SAR Table 13.3 (18 W/m/K, all temperatures)",
        },
        "thermal.volumetricHeatCapacity": {
          model: "linear",
          a: { value: Number(a.toFixed(0)), unit: "J/m3/K" },
          b: { value: b, unit: "J/m3/K2" },
          validRange: { min: { value: 273.15, unit: "K" }, max: { value: 1273.15, unit: "K" } },
          source: "UT-Austin SAR Table 4.1: 2.04 + 0.00417 T[C] J/cm3/K, rewritten in kelvin (a = 2.04e6 - 4170 x 273.15). The SAR states no validity range; 0 to 1000 C is assumed to cover the pulse",
        },
      },
    },
    cladding: {
      materialId: "ss304-pulse",
      revision: 1,
      sets: {
        "thermal.conductivity": {
          model: "constant",
          value: { value: 16.6, unit: "W/m/K" },
          referenceTemperature: { value: 400, unit: "K" },
          source: "K-State SAR Table 13.3 (16.6 W/m/K at 400 K)",
        },
        "thermal.volumetricHeatCapacity": {
          model: "constant",
          value: { value: Number((7900 * 477).toFixed(0)), unit: "J/m3/K" },
          referenceTemperature: { value: 300, unit: "K" },
          source: "K-State SAR Table 13.3: 7900 kg/m3 x 477 J/kg/K at 300 K (515 J/kg/K at 400 K: the value rises 8% over 100 K, which matters little for a pulse this short)",
        },
      },
    },
  },
  gap: { model: "constant-conductance", conductance: { value: 4096, unit: "W/m2/K" }, source: "READ from UT-Austin SAR Figure 4.30 (TRACE): fuel surface heat flux over the 139 K gap drop at the 24.34 kW hot channel; the pulse gap may differ" },
  transient: {
    powerHistory: history,
    endTime: { value: 100, unit: "ms" },
    timeStep: { value: 0.05, unit: "ms" },
    outputs: 40,
    initialTemperature: { value: 20, unit: "degC" },
  },
  mesh: { fuelCells: 60, claddingCells: 8 },
};
fs.writeFileSync(path.join(root, "examples", "ut-triga-pulse-4p40.json"), JSON.stringify(doc, null, 2) + NL);
console.log(JSON.stringify({ dH_GJ_per_m3: dH / 1e9, energyPerLength_MJ: energyPerLength / 1e6, peakLhgr_MW_per_m: peakLhgr / 1e6, tau_ms: tau * 1e3, fwhm_ms: fwhm * 1e3, tableScale: scale, points: history.length }));
