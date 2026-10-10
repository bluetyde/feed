// FEED's point-kinetics generator against the General Atomic report GA-7882, "Kinetic Behavior of TRIGA Reactors" (1967), section 8 and Table VII (page 31 of the report): the
// Fuchs-Nordheim model (prompt neutrons only, a constant prompt temperature coefficient) for a TRIGA core with a constant heat capacity (the "standard" model) and with the heat
// capacity C = C0 + C1 T of the fuel (Scalettar's "modified" model). The published numbers are the oracle; a second, independent derivation (written here with plain quadrature,
// not the generator's integrator) must agree with the table as well.
//
// The report's parameters: prompt neutron lifetime 4e-5 s, C0 (at 25 C) = 8e4 W s/C per core, C1 = 1.5e2 W s/C^2 per core, alpha = 1e-4 per C; Delta k_p = 0.014 (a $3
// pulse) and 0.028 (a $5 pulse). The core is described to FEED as 100 pins of 1 m with a fuel area of 1e-3 m2 (0.1 m3), so its heat capacity per cubic metre is the core's over 0.1.
import { describe, expect, it } from "vitest";
import { integrate, KineticsSpec } from "../src/core/pointKinetics";

const LIFETIME = 4e-5, C0 = 8e4, C1 = 1.5e2, ALPHA = 1e-4, T0K = 298.15;
const PINS = 100, LENGTH = 1, AREA = 1e-3, VOLUME = PINS * LENGTH * AREA;

/** The published rows of Table VII: peak power (MW), burst energy (MW s) and the temperature rise of the burst (C; the modified model only). */
const TABLE = {
  "$3": { dk: 0.014, modified: { pmax: 2130, e: 26.1, rise: 262 }, c0: { pmax: 1960, e: 22.4 }, cbar: { pmax: 2475, e: 28.3 }, dT: 280 },
  "$5": { dk: 0.028, modified: { pmax: 9210, e: 59.7, rise: 506 }, c0: { pmax: 7840, e: 44.8 }, cbar: { pmax: 11950, e: 68.3 }, dT: 560 },
} as const;

/** Scalettar's modified Fuchs-Nordheim model derived from dP/dT = C(T) (dk - alpha (T - T0)) / lifetime, integrated by Simpson's rule (not the generator's integrator). */
function modified(dk: number, c0: number, c1: number) {
  const simpson = (f: (x: number) => number, a: number, b: number, n = 4000) => {
    const h = (b - a) / n;
    let s = f(a) + f(b);
    for (let i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
    return (s * h) / 3;
  };
  const energy = (th: number) => c0 * th + (c1 * th * th) / 2; // J of core energy for a rise th (C = c0 + c1 th above the start)
  const work = (th: number) => simpson((x) => (c0 + c1 * x) * x, 0, th); // integral of C th dth
  const power = (th: number) => (dk * energy(th) - ALPHA * work(th)) / LIFETIME; // W at a rise th
  const peakRise = dk / ALPHA; // the power peaks where the reactivity is back to zero
  let lo = peakRise, hi = 4 * peakRise;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (power(mid) > 0) lo = mid;
    else hi = mid;
  }
  const rise = 0.5 * (lo + hi);
  return { pmax: power(peakRise), e: energy(rise), rise };
}

function generate(dk: number, c1: number) {
  const spec: KineticsSpec = {
    reactivity: dk,
    insertionTime: 0,
    generationTime: LIFETIME,
    groups: [],
    feedback: { kind: "constant", alpha: -ALPHA },
    initialPower: 1e3,
    pins: PINS,
    activeLength: LENGTH,
    peakingFactor: 1,
    endTime: 0.2,
  };
  // C(T) = C0 + C1 (T - 25 C) per core, written per cubic metre of fuel in kelvin: a = (C0 - C1 T0K) / V, b = C1 / V
  const ctx = { fuelArea: AREA, fuelC: { a: (C0 - c1 * T0K) / VOLUME, b: c1 / VOLUME }, startTemperature: T0K };
  const tr = integrate(spec, ctx);
  const n = tr.time.length;
  return { pmax: Math.max(...tr.power), e: tr.energy[n - 1]!, rise: tr.fuelTemperature[n - 1]! - T0K };
}
const near = (x: number, ref: number, rel: number) => Math.abs(x / ref - 1) <= rel;

describe("GA-7882 Table VII, the modified Fuchs-Nordheim model (heat capacity rising with temperature)", () => {
  for (const [name, row] of Object.entries(TABLE)) {
    it(`${name}: an independent derivation reproduces the published peak power, energy and burst temperature rise`, () => {
      const m = modified(row.dk, C0, C1);
      expect(near(m.pmax / 1e6, row.modified.pmax, 0.003), `Pmax ${m.pmax / 1e6} MW against ${row.modified.pmax}`).toBe(true);
      expect(near(m.e / 1e6, row.modified.e, 0.005), `E ${m.e / 1e6} MW s against ${row.modified.e}`).toBe(true);
      expect(Math.abs(m.rise - row.modified.rise), `rise ${m.rise} against ${row.modified.rise}`).toBeLessThan(1);
    });
    it(`${name}: FEED's generator reproduces them too (prompt neutrons only, constant feedback, a linear heat capacity)`, () => {
      const g = generate(row.dk, C1);
      expect(near(g.pmax / 1e6, row.modified.pmax, 0.005), `Pmax ${g.pmax / 1e6} MW against ${row.modified.pmax}`).toBe(true);
      expect(near(g.e / 1e6, row.modified.e, 0.005), `E ${g.e / 1e6} MW s against ${row.modified.e}`).toBe(true);
      expect(Math.abs(g.rise - row.modified.rise), `rise ${g.rise} against ${row.modified.rise}`).toBeLessThan(1.5);
    });
  }
  it("the generator agrees with the exact derivation to 1e-4 (the table is rounded and the report's equation 16 for the rise is an approximation: 262 against 262.7 C for the $3 pulse)", () => {
    for (const row of Object.values(TABLE)) {
      const m = modified(row.dk, C0, C1);
      const g = generate(row.dk, C1);
      expect(near(g.pmax, m.pmax, 1e-4), `Pmax ${g.pmax} against ${m.pmax}`).toBe(true);
      expect(near(g.e, m.e, 1e-4), `E ${g.e} against ${m.e}`).toBe(true);
      expect(Math.abs(g.rise - m.rise)).toBeLessThan(0.02);
    }
  });
  it("the burst temperature rise is a fraction of the constant-capacity value 2 dk / alpha, 0.937 and 0.904 for the two pulses, as the report's last row says", () => {
    expect(generate(0.014, C1).rise / 280).toBeCloseTo(0.937, 2);
    expect(generate(0.028, C1).rise / 560).toBeCloseTo(0.904, 2);
  });
});

describe("GA-7882 Table VII, the standard model (a constant heat capacity)", () => {
  for (const [name, row] of Object.entries(TABLE)) {
    it(`${name}: with C = C0 the generator gives Pmax = dk^2 C / (2 alpha lifetime), E = 2 C dk / alpha and a rise of 2 dk / alpha`, () => {
      const g = generate(row.dk, 0);
      expect(near(g.pmax / 1e6, row.c0.pmax, 0.005), `Pmax ${g.pmax / 1e6} against ${row.c0.pmax}`).toBe(true);
      expect(near(g.e / 1e6, row.c0.e, 0.005), `E ${g.e / 1e6} against ${row.c0.e}`).toBe(true);
      expect(Math.abs(g.rise - row.dT), `rise ${g.rise} against ${row.dT}`).toBeLessThan(1.5);
    });
    it(`${name}: with the average capacity C = C0 + C1 dT/2 of the burst (the report's second standard row) the same formulas give its numbers`, () => {
      const cbar = C0 + (C1 * row.dT) / 2;
      const pmax = (row.dk * row.dk * cbar) / (2 * ALPHA * LIFETIME);
      const e = (2 * cbar * row.dk) / ALPHA;
      expect(near(pmax / 1e6, row.cbar.pmax, 0.002), `Pmax ${pmax / 1e6} against ${row.cbar.pmax}`).toBe(true);
      expect(near(e / 1e6, row.cbar.e, 0.002), `E ${e / 1e6} against ${row.cbar.e}`).toBe(true);
    });
  }
  it("the report's two comparisons: the standard model with C0 under-states the modified model's energy by 14 to 25 % and the average-capacity one over-states by 8 to 14 %", () => {
    const m3 = TABLE.$3, m5 = TABLE.$5;
    expect(1 - m3.c0.e / m3.modified.e).toBeGreaterThan(0.1);
    expect(1 - m5.c0.e / m5.modified.e).toBeGreaterThan(0.2);
    expect(m3.cbar.e / m3.modified.e - 1).toBeGreaterThan(0.05);
    expect(m5.cbar.e / m5.modified.e - 1).toBeGreaterThan(0.1);
  });
});
