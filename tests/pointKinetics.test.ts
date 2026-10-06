// The point-kinetics pulse generator against exact results written independently of it:
//  - Nordheim-Fuchs (no delayed neutrons, adiabatic temperature feedback): P(t) = Pmax sech^2(rho0 (t - tp) / (2 Lambda)), with
//    Pmax = rho0^2 / (2 gamma Lambda), total energy 2 rho0 / gamma and full width at half maximum 3.5255 Lambda / rho0;
//  - the inhour equation: a step of reactivity from equilibrium with six delayed groups and no feedback is a sum of exponentials whose
//    rates are the roots of rho = s Lambda + s sum beta_i / (s + lambda_i).
import { describe, expect, it } from "vitest";
import { feedbackReactivity, generatePulse, integrate, KineticsContext, KineticsError, KineticsSpec, temperatureRise } from "../src/core/pointKinetics";

// Keepin's thermal-fission U-235 six-group data (beta_i, lambda_i); the sum is 0.006502
const KEEPIN = [
  { beta: 0.000215, lambda: 0.0124 },
  { beta: 0.001424, lambda: 0.0305 },
  { beta: 0.001274, lambda: 0.111 },
  { beta: 0.002568, lambda: 0.301 },
  { beta: 0.000748, lambda: 1.14 },
  { beta: 0.000273, lambda: 3.01 },
];
const BETA = KEEPIN.reduce((s, g) => s + g.beta, 0);

const ctx = (over: Partial<KineticsContext> = {}): KineticsContext => ({ fuelArea: 1e-4, fuelC: { a: 3e6, b: 0 }, startTemperature: 300, ...over });
const spec = (over: Partial<KineticsSpec> = {}): KineticsSpec => ({
  reactivity: 0.01,
  insertionTime: 0,
  generationTime: 1e-4,
  groups: [],
  feedback: { kind: "constant", alpha: -1e-4 },
  initialPower: 1,
  pins: 1,
  activeLength: 1,
  peakingFactor: 1,
  endTime: 0.3,
  ...over,
});

describe("Nordheim-Fuchs: prompt neutrons only, adiabatic feedback", () => {
  const s = spec();
  const c = ctx();
  // energy per fuel volume = E / A; temperature rise = that over c; rho = rho0 + alpha dT, so gamma = |alpha| / (A c) per joule
  const gamma = 1e-4 / (c.fuelArea * c.fuelC.a);
  const pulse = generatePulse(s, c);

  it("the peak power is rho0^2 / (2 gamma Lambda)", () => {
    const exact = (s.reactivity ** 2) / (2 * gamma * s.generationTime);
    expect(Math.abs(pulse.summary.peakPower - exact) / exact).toBeLessThan(2e-4);
  });

  it("the energy released is 2 rho0 / gamma", () => {
    const exact = (2 * s.reactivity) / gamma;
    expect(Math.abs(pulse.summary.totalEnergy - exact) / exact).toBeLessThan(2e-4);
  });

  it("the width is 3.5255 Lambda / rho0", () => {
    const exact = (2 * 2 * Math.acosh(Math.SQRT2) * s.generationTime) / s.reactivity; // sech^2(x) = 1/2 at x = acosh(sqrt 2)
    expect(Math.abs(pulse.summary.fwhm! - exact) / exact).toBeLessThan(5e-3);
    expect(exact).toBeCloseTo(3.5255 * s.generationTime / s.reactivity, 3);
  });

  it("the whole curve is the sech^2, centred where the peak is", () => {
    const tp = pulse.summary.timeOfPeak;
    const Pmax = pulse.summary.peakPower;
    let worst = 0;
    pulse.trace.time.forEach((t, i) => {
      const x = (s.reactivity * (t - tp)) / (2 * s.generationTime);
      worst = Math.max(worst, Math.abs(pulse.trace.power[i]! - Pmax / Math.cosh(x) ** 2) / Pmax);
    });
    expect(worst).toBeLessThan(2e-3); // the starting power (1 W of 1.5 MW) and the end of the window are the only departures
  });

  it("the fuel's temperature rise is the energy over its heat capacity", () => {
    const dT = pulse.summary.finalFuelTemperature - 300;
    expect(dT).toBeCloseTo(pulse.summary.totalEnergy / (c.fuelArea * c.fuelC.a), 4);
  });

  it("the reactivity ends at minus its inserted value: the pulse is terminated by the feedback alone", () => {
    expect(pulse.trace.reactivity[pulse.trace.reactivity.length - 1]!).toBeCloseTo(-s.reactivity, 4);
  });
});

describe("the integrator against the inhour equation (six groups, no feedback)", () => {
  /** Roots of rho = s Lambda + s sum beta_i / (s + lambda_i): one in each gap between the -lambda_i, one above the highest, one below the lowest. */
  function inhourRoots(rho: number, Lambda: number): number[] {
    const f = (x: number) => x * Lambda + x * KEEPIN.reduce((a, g) => a + g.beta / (x + g.lambda), 0) - rho;
    const bisect = (lo: number, hi: number) => {
      let a = lo;
      let b = hi;
      for (let i = 0; i < 300; i++) {
        const mid = 0.5 * (a + b);
        const fm = f(mid);
        if (f(a) * fm <= 0) b = mid;
        else a = mid;
      }
      return 0.5 * (a + b);
    };
    const poles = KEEPIN.map((g) => -g.lambda).sort((x, y) => y - x);
    const roots: number[] = [];
    roots.push(rho > 0 ? bisect(1e-12, 1e6) : bisect(poles[0]! + 1e-12, -1e-12)); // the dominant root (positive for rho > 0)
    for (let i = 0; i + 1 < poles.length; i++) roots.push(bisect(poles[i + 1]! + 1e-12, poles[i]! - 1e-12));
    roots.push(bisect(-1e6, poles[poles.length - 1]! - 1e-12));
    return roots;
  }
  const exact = (rho: number, Lambda: number, t: number) => {
    let n = 0;
    for (const s of inhourRoots(rho, Lambda)) {
      const num = Lambda + KEEPIN.reduce((a, g) => a + g.beta / (s + g.lambda), 0);
      const den = Lambda + KEEPIN.reduce((a, g) => a + (g.beta * g.lambda) / (s + g.lambda) ** 2, 0);
      n += (num / den) * Math.exp(s * t);
    }
    return n;
  };

  for (const [name, rho] of [["delayed-supercritical ($0.5)", 0.5 * BETA], ["prompt-critical ($1)", BETA * 1.0001], ["subcritical (-$1)", -BETA]] as const) {
    it(`${name}: power at ten times matches the sum of exponentials to 1e-6`, () => {
      const s = spec({ reactivity: rho, groups: KEEPIN, feedback: { kind: "constant", alpha: 0 }, initialPower: 1e3, endTime: 0.05, generationTime: 4e-5 });
      const tr = integrate(s, ctx());
      let worst = 0;
      for (let k = 1; k <= 10; k++) {
        const target = (0.05 * k) / 10;
        let i = tr.time.findIndex((t) => t >= target - 1e-12);
        i = i < 0 ? tr.time.length - 1 : i;
        const t = tr.time[i]!;
        worst = Math.max(worst, Math.abs(tr.power[i]! - 1e3 * exact(rho, 4e-5, t)) / (1e3 * exact(rho, 4e-5, t)));
      }
      expect(worst).toBeLessThan(1e-6);
    });
  }

  it("equilibrium is a fixed point: with no reactivity the power stays put", () => {
    const tr = integrate(spec({ reactivity: 0, groups: KEEPIN, feedback: { kind: "constant", alpha: 0 }, initialPower: 5e3, endTime: 1 }), ctx());
    for (const p of tr.power) expect(Math.abs(p - 5e3) / 5e3).toBeLessThan(1e-8);
  });
});

describe("with delayed neutrons and the feedback", () => {
  const delayed = spec({ reactivity: 3 * BETA, groups: KEEPIN, generationTime: 4e-5, initialPower: 10, endTime: 0.1, feedback: { kind: "constant", alpha: -1e-4 } });
  const pulse = generatePulse(delayed, ctx({ fuelArea: 5e-5 }));

  it("a $3 pulse peaks, then the feedback shuts it down: the final power is far below the peak and the reactivity is negative", () => {
    expect(pulse.summary.peakPower).toBeGreaterThan(1e6);
    expect(pulse.summary.finalPower).toBeLessThan(0.05 * pulse.summary.peakPower);
    expect(pulse.trace.reactivity[pulse.trace.reactivity.length - 1]!).toBeLessThan(0);
    expect(pulse.summary.insertedDollars).toBeCloseTo(3, 9);
  });

  it("is close to the prompt-only result for the prompt reactivity (rho - beta) at this size: Nordheim-Fuchs with the prompt excess", () => {
    const prompt = delayed.reactivity - BETA;
    const gamma = 1e-4 / (5e-5 * 3e6);
    const exactPeak = (prompt ** 2) / (2 * gamma * delayed.generationTime);
    // the delayed groups and the starting power shift it slightly: a few percent, not a different pulse
    expect(Math.abs(pulse.summary.peakPower - exactPeak) / exactPeak).toBeLessThan(0.05);
  });

  it("a larger insertion gives a higher, narrower pulse that releases more energy", () => {
    const bigger = generatePulse({ ...delayed, reactivity: 4 * BETA }, ctx({ fuelArea: 5e-5 }));
    expect(bigger.summary.peakPower).toBeGreaterThan(pulse.summary.peakPower);
    expect(bigger.summary.fwhm!).toBeLessThan(pulse.summary.fwhm!);
    expect(bigger.summary.totalEnergy).toBeGreaterThan(pulse.summary.totalEnergy);
  });

  it("a ramped insertion is later and lower than a step of the same size", () => {
    const ramp = generatePulse({ ...delayed, insertionTime: 0.03 }, ctx({ fuelArea: 5e-5 }));
    expect(ramp.summary.timeOfPeak).toBeGreaterThan(pulse.summary.timeOfPeak);
    expect(ramp.summary.peakPower).toBeLessThan(pulse.summary.peakPower);
  });

  it("a linear temperature coefficient and a temperature-dependent heat capacity run, and the thinned history keeps its energy", () => {
    const p = generatePulse({ ...delayed, feedback: { kind: "linear", a: -8e-5, b: -1e-8, range: [250, 2000] } }, ctx({ fuelArea: 5e-5, fuelC: { a: 2e6, b: 3000 } }));
    expect(p.summary.energyError).toBeLessThan(1e-3);
    expect(p.summary.points).toBeLessThanOrEqual(1000);
    expect(p.summary.peakFuelRise).toBeGreaterThan(100);
  });
});

describe("the history it writes", () => {
  const pulse = generatePulse(spec({ groups: KEEPIN, reactivity: 2.5 * BETA, generationTime: 4e-5, initialPower: 100, endTime: 0.08 }), ctx({ fuelArea: 5e-5 }));
  const lin = (t: number) => {
    let i = 1;
    while (i < pulse.times.length - 1 && pulse.times[i]! < t) i++;
    const f = (t - pulse.times[i - 1]!) / (pulse.times[i]! - pulse.times[i - 1]!);
    return pulse.linearHeatRate[i - 1]! + f * (pulse.linearHeatRate[i]! - pulse.linearHeatRate[i - 1]!);
  };

  it("starts at 0 and ends at the end time, strictly increasing, within the point budget", () => {
    expect(pulse.times[0]).toBe(0);
    expect(pulse.times[pulse.times.length - 1]).toBeCloseTo(0.08, 12);
    for (let i = 1; i < pulse.times.length; i++) expect(pulse.times[i]!).toBeGreaterThan(pulse.times[i - 1]!);
    expect(pulse.times.length).toBeLessThanOrEqual(1000);
    expect(pulse.linearHeatRate.every((q) => Number.isFinite(q) && q >= 0)).toBe(true);
  });

  it("follows the integrated curve to 0.1% of the peak at every step", () => {
    const share = 1;
    let worst = 0;
    pulse.trace.time.forEach((t, i) => (worst = Math.max(worst, Math.abs(lin(t) - pulse.trace.power[i]! * share))));
    expect(worst / pulse.summary.peakLinearHeatRate).toBeLessThan(2e-3);
  });

  it("carries the energy: the history's integral is the integrated energy to 0.1%", () => {
    let e = 0;
    for (let i = 1; i < pulse.times.length; i++) e += 0.5 * (pulse.linearHeatRate[i]! + pulse.linearHeatRate[i - 1]!) * (pulse.times[i]! - pulse.times[i - 1]!);
    expect(Math.abs(e - pulse.summary.energyPerLength) / pulse.summary.energyPerLength).toBeLessThan(1e-3);
    expect(pulse.summary.energyError).toBeLessThan(1e-3);
  });

  it("the peak vertex is kept: the history's maximum is the peak linear heat rate", () => {
    expect(Math.max(...pulse.linearHeatRate)).toBeCloseTo(pulse.summary.peakLinearHeatRate, 6 + 0);
  });

  it("scales with the slice's share of the power: peaking 1.3, 4 pins of 0.5 m", () => {
    const a = generatePulse(spec({ groups: KEEPIN, reactivity: 2.5 * BETA, generationTime: 4e-5, initialPower: 100, endTime: 0.08 }), ctx({ fuelArea: 5e-5 }));
    const b = generatePulse(spec({ groups: KEEPIN, reactivity: 2.5 * BETA, generationTime: 4e-5, initialPower: 100, endTime: 0.08, peakingFactor: 1.3, pins: 4, activeLength: 0.5 }), ctx({ fuelArea: 5e-5 }));
    // the same energy per fuel volume would give the same temperature; here each slice gets 1.3/(4 x 0.5) = 0.65 of the heat per metre per watt,
    // so the feedback is weaker and the pulse bigger. The scaling of the history itself is exactly peaking / (pins x length):
    expect(b.linearHeatRate[0]! / b.trace.power[0]!).toBeCloseTo(1.3 / 2, 12);
    expect(a.linearHeatRate[0]! / a.trace.power[0]!).toBeCloseTo(1, 12);
    expect(b.summary.peakPower).toBeGreaterThan(a.summary.peakPower);
  });
});

describe("the error control and the budgets", () => {
  it("a very fast pulse in a long window stays exact: the step size is chosen by the error, not by the window", () => {
    // Lambda = 1 microsecond, rho0 = 0.01: the pulse is 0.35 ms wide in a 0.3 s window, whose step cap (60 microseconds) alone would be far too coarse
    const s = spec({ generationTime: 1e-6, endTime: 0.3 });
    const gamma = 1e-4 / (1e-4 * 3e6);
    const p = generatePulse(s, ctx());
    expect(Math.abs(p.summary.peakPower - 0.01 ** 2 / (2 * gamma * 1e-6)) / (0.01 ** 2 / (2 * gamma * 1e-6))).toBeLessThan(1e-3);
    expect(Math.abs(p.summary.fwhm! - (3.5255 * 1e-6) / 0.01) / ((3.5255 * 1e-6) / 0.01)).toBeLessThan(5e-3);
    expect(p.summary.steps).toBeGreaterThan(5000); // the controller took more steps than the cap alone would have
  });
  it("a history that cannot be written within the point budget is refused, with the count it needs", () => {
    expect(() => generatePulse(spec(), ctx(), { maxPoints: 5 })).toThrow(/at most 5 points/);
    expect(generatePulse(spec(), ctx(), { maxPoints: 1000 }).times.length).toBeLessThanOrEqual(1000);
  });
  it("a negative power is refused, not carried on", () => {
    expect(() => integrate(spec({ initialPower: -1 }), ctx())).toThrow(/negative/);
  });
});

describe("what it refuses", () => {
  it("a pulse that has not happened by the end of the window", () => {
    expect(() => generatePulse(spec({ initialPower: 1e-6, endTime: 0.001 }), ctx())).toThrow(/still rising at the end time/);
  });

  it("a fuel heat capacity law with no temperature for this much energy", () => {
    expect(() => temperatureRise({ a: 1e6, b: -1e3 }, 300, 1e12)).toThrow(KineticsError);
    expect(() => temperatureRise({ a: -1, b: 0 }, 300, 1)).toThrow(/not positive/);
  });

  it("a window too long for the generation time", () => {
    expect(() => generatePulse(spec({ generationTime: 1e-9, reactivity: 0.01, endTime: 100, initialPower: 1e-3 }), ctx())).toThrow(KineticsError);
  });
});

describe("the feedback and the heat-capacity helpers", () => {
  it("the temperature rise inverts the enthalpy exactly, constant and linear c", () => {
    expect(temperatureRise({ a: 3e6, b: 0 }, 300, 3e8)).toBeCloseTo(100, 10);
    const c = { a: 2e6, b: 4000 };
    const dT = temperatureRise(c, 300, 5e8);
    expect(c.a * dT + 0.5 * c.b * ((300 + dT) ** 2 - 300 ** 2)).toBeCloseTo(5e8, 3);
  });
  it("the feedback reactivity integrates the differential coefficient", () => {
    expect(feedbackReactivity({ kind: "constant", alpha: -2e-4 }, 300, 800)).toBeCloseTo(-0.1, 12);
    expect(feedbackReactivity({ kind: "linear", a: -1e-4, b: -1e-7, range: [0, 2000] }, 300, 800)).toBeCloseTo(-1e-4 * 500 - 0.5 * 1e-7 * (800 ** 2 - 300 ** 2), 12);
  });
});
