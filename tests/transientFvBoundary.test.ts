// Plan 11 B2: the independent finite-volume solution with a coolant side that changes with time. A pin with an enormous conductivity is lumped (the Biot number is 1e-7), so its
// temperature must follow C dT/dt = q - h(t) A (T - Tb(t)); the solution is checked against that in three ways written here without any FEED code: the exact solution of the
// continuous equation (a ramp in the bulk temperature; a step in the film coefficient), the discrete implicit-Euler recurrence with the boundary at the NEW time level (the way OFFBEAT
// steps, plan 11 B0), and energy conservation. Tolerances were fixed before the first run.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { boundaryAtTime, tableForSolver } from "../src/core/boundaryHistory";
import { initialState, pinOf } from "../src/core/transientResults";
import { solveTransientFv, storedEnergy } from "../src/core/transientFv";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });

/** A lumped pin: k = 1e5 W/m/K in both solids, gap 1e9, c = 3 MJ/m3/K, 5 W/m, 40 s, started at 800 K. */
function lumpedCase(history: unknown, dt = 0.05) {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));
  d.boundary = { bulkTemperature: q(600, "K"), heatTransferCoefficient: q(500, "W/m2/K") };
  d.gap.conductance = q(1e9, "W/m2/K");
  d.mesh = { fuelCells: 6, claddingCells: 3 };
  for (const m of ["fuel", "cladding"]) {
    d.materials[m].sets["thermal.conductivity"].value = q(1e5, "W/m/K");
    d.materials[m].sets["thermal.volumetricHeatCapacity"].value = q(3, "MJ/m3/K");
  }
  d.transient = { powerHistory: [{ time: q(0, "s"), linearHeatRate: q(5, "W/m") }, { time: q(40, "s"), linearHeatRate: q(5, "W/m") }], endTime: q(40, "s"), timeStep: q(dt, "s"), outputs: 20, initialTemperature: q(800, "K"), ...(history ? { boundaryHistory: history } : {}) };
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
}
const pt = (t: number, Tb: number, h: number) => ({ time: q(t, "s"), bulkTemperature: q(Tb, "K"), heatTransferCoefficient: q(h, "W/m2/K") });
const Rf = 4.1e-3, Rci = 4.18e-3, Rco = 4.75e-3;
const Cp = 3e6 * (Math.PI * Rf * Rf + Math.PI * (Rco * Rco - Rci * Rci));
const A = 2 * Math.PI * Rco;
const peak = (c: ReturnType<typeof lumpedCase>, dt: number, steps: number) => {
  const pin = pinOf(c);
  const run = solveTransientFv(pin, { dt, steps, initialTemperature: 800, outputEvery: 1 });
  return run.states.map((s) => ({ t: s.time, T: Math.max(...s.T), state: s }));
};

describe("the boundary as a function of time", () => {
  const h = { kind: "convective" as const, times: [0, 10, 20], bulkTemperature: [300, 300, 600], heatTransferCoefficient: [1000, 100, 100] };
  it("is linear between points, the first value before and the last value after", () => {
    expect(boundaryAtTime(h, 0)).toEqual({ kind: "convective", bulkTemperature: 300, heatTransferCoefficient: 1000 });
    expect((boundaryAtTime(h, 5) as any).heatTransferCoefficient).toBeCloseTo(550, 12);
    expect((boundaryAtTime(h, 15) as any).bulkTemperature).toBeCloseTo(450, 12);
    expect(boundaryAtTime(h, 20)).toEqual({ kind: "convective", bulkTemperature: 600, heatTransferCoefficient: 100 });
    expect(boundaryAtTime(h, 99)).toEqual({ kind: "convective", bulkTemperature: 600, heatTransferCoefficient: 100 });
    expect(boundaryAtTime(h, -1)).toEqual({ kind: "convective", bulkTemperature: 300, heatTransferCoefficient: 1000 });
    expect((boundaryAtTime({ kind: "surface-temperature", times: [0, 4], surfaceTemperature: [300, 500] }, 1) as any).surfaceTemperature).toBeCloseTo(350, 12);
  });
  it("the table for the solver gets one flat point past the end time unless the last point is strictly after it", () => {
    const a = tableForSolver(h, 20, 0.5);
    expect(a.times).toEqual([0, 10, 20, 20.5]);
    expect(a.columns[0]).toEqual([1000, 100, 100, 100]);
    expect(a.columns[1]).toEqual([300, 300, 600, 600]);
    expect(tableForSolver(h, 15, 0.5).times).toEqual([0, 10, 20]);
    expect(tableForSolver(h, 25, 0.5).times).toEqual([0, 10, 20, 25.5]);
    expect(tableForSolver({ kind: "surface-temperature", times: [0, 40], surfaceTemperature: [600, 900] }, 40, 0.05).columns).toEqual([[600, 900, 900]]);
  });
});

describe("a lumped pin follows its boundary", () => {
  it("a ramp in the bulk temperature: the exact solution of C dT/dt = q - hA (T - Tb(t)) to 0.1 K at a step of 0.01 s", () => {
    const c = lumpedCase([pt(0, 600, 500), pt(40, 900, 500)], 0.01);
    const run = peak(c, 0.01, 4000);
    // Tb = 600 + s t, s = 7.5 K/s; with tau = C / (h A) and the 5 W/m: T = Tinf(t) + (T0 - Tinf(0)) e^(-t/tau), Tinf(t) = Tb(t) + q/(hA) - s tau
    const tau = Cp / (500 * A);
    const s = 300 / 40;
    const exact = (t: number) => 600 + s * t + 5 / (500 * A) - s * tau + (800 - 600 - 5 / (500 * A) + s * tau) * Math.exp(-t / tau);
    for (const k of [500, 1000, 2000, 3000, 4000]) expect(Math.abs(run[k]!.T - exact(run[k]!.t)), "t = " + run[k]!.t).toBeLessThan(0.1);
  });
  it("a step in the film coefficient: the two exponentials of the continuous equation, to 0.1 K at a step of 0.005 s", () => {
    const c = lumpedCase([pt(0, 600, 500), pt(10, 600, 500), pt(10.005, 600, 100), pt(40, 600, 100)], 0.005);
    const run = peak(c, 0.005, 8000);
    const tauOf = (hh: number) => Cp / (hh * A);
    const inf = (hh: number) => 600 + 5 / (hh * A);
    const at10 = inf(500) + (800 - inf(500)) * Math.exp(-10 / tauOf(500));
    const exact = (t: number) => (t <= 10 ? inf(500) + (800 - inf(500)) * Math.exp(-t / tauOf(500)) : inf(100) + (at10 - inf(100)) * Math.exp(-(t - 10) / tauOf(100)));
    for (const k of [1000, 2000, 2400, 4000, 8000]) expect(Math.abs(run[k]!.T - exact(run[k]!.t)), "t = " + run[k]!.t).toBeLessThan(0.1);
  });
  it("the step is taken at the NEW time level: a 2 s step with the change at 10 s equals the implicit recurrence with the end-of-step film coefficient, and not the one with the start-of-step coefficient", () => {
    const hist = [pt(0, 600, 500), pt(10, 600, 500), pt(10.0001, 600, 100), pt(40, 600, 100)];
    const c = lumpedCase(hist, 2);
    const run = peak(c, 2, 20);
    const hf = (t: number) => (t < 10.0001 ? 500 : 100);
    const recurrence = (level: "new" | "old") => {
      let T = 800;
      const out = [T];
      for (let n = 1; n <= 20; n++) {
        const hh = level === "new" ? hf(2 * n) : hf(2 * (n - 1));
        T = (T + (2 / Cp) * (5 + hh * A * 600)) / (1 + (2 * hh * A) / Cp);
        out.push(T);
      }
      return out;
    };
    const nw = recurrence("new");
    const od = recurrence("old");
    let worstNew = 0;
    let worstOld = 0;
    run.forEach((r, k) => {
      worstNew = Math.max(worstNew, Math.abs(r.T - nw[k]!));
      worstOld = Math.max(worstOld, Math.abs(r.T - od[k]!));
    });
    // the FV pin is lumped to a few parts in 1e6 (k 1e5, six cells), not exactly: 5 mK of 800 K, against 5 K or more for the other level
    expect(worstNew).toBeLessThan(5e-3);
    expect(worstOld).toBeGreaterThan(5);
  });
  it("a prescribed wall that ramps: the fuel follows it within the lag of the cladding", () => {
    const d = JSON.parse(JSON.stringify(lumpedCase(undefined, 0.05)));
    void d;
    const raw = JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));
    raw.boundary = { surfaceTemperature: q(600, "K") };
    raw.gap.conductance = q(1e9, "W/m2/K");
    raw.mesh = { fuelCells: 6, claddingCells: 3 };
    for (const m of ["fuel", "cladding"]) {
      raw.materials[m].sets["thermal.conductivity"].value = q(1e5, "W/m/K");
      raw.materials[m].sets["thermal.volumetricHeatCapacity"].value = q(3, "MJ/m3/K");
    }
    raw.transient = { powerHistory: [{ time: q(0, "s"), linearHeatRate: q(5, "W/m") }, { time: q(40, "s"), linearHeatRate: q(5, "W/m") }], endTime: q(40, "s"), timeStep: q(0.05, "s"), outputs: 20, initialTemperature: q(600, "K"), boundaryHistory: [{ time: q(0, "s"), surfaceTemperature: q(600, "K") }, { time: q(40, "s"), surfaceTemperature: q(900, "K") }] };
    const c = validateCase(raw).normalized!;
    const run = solveTransientFv(pinOf(c), { dt: 0.05, steps: 800, initialTemperature: 600, outputEvery: 1 });
    run.states.forEach((s) => {
      expect(Math.abs(s.wall - (600 + (300 * s.time) / 40))).toBeLessThan(1e-9);
      expect(Math.abs(Math.max(...s.T) - s.wall)).toBeLessThan(0.05);
    });
  });
});

describe("conservation and the unchanged case", () => {
  it("deposited = stored + rejected for a pin whose film changes (the rejected heat is the boundary integral of the history)", () => {
    const c = lumpedCase([pt(0, 600, 500), pt(10, 700, 500), pt(20, 700, 50), pt(40, 400, 50)], 0.05);
    const pin = pinOf(c);
    const run = solveTransientFv(pin, { dt: 0.05, steps: 800, initialTemperature: 800, outputEvery: 800 });
    const last = run.states[run.states.length - 1]!;
    const stored = storedEnergy(pin, last.T, 800);
    expect(Math.abs(last.deposited - stored - last.rejected) / Math.max(Math.abs(last.rejected), 1)).toBeLessThan(1e-6);
    expect(last.rejected).toBeGreaterThan(0);
  });
  it("a constant history gives exactly the same states as no history", () => {
    const a = lumpedCase(undefined, 0.5);
    const b = lumpedCase([pt(0, 600, 500), pt(40, 600, 500)], 0.5);
    const ra = solveTransientFv(pinOf(a), { dt: 0.5, steps: 80, initialTemperature: 800, outputEvery: 10 });
    const rb = solveTransientFv(pinOf(b), { dt: 0.5, steps: 80, initialTemperature: 800, outputEvery: 10 });
    ra.states.forEach((s, k) => {
      expect(rb.states[k]!.T).toEqual(s.T);
      expect(rb.states[k]!.rejected).toBe(s.rejected);
      expect(rb.states[k]!.wall).toBe(s.wall);
    });
  });
  it("the steady start uses the case's own boundary, not the history", () => {
    const raw = JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));
    raw.transient.initialSteadyLinearHeatRate = q(20, "kW/m");
    delete raw.transient.initialTemperature;
    const plain = validateCase(raw).normalized!;
    raw.transient.boundaryHistory = [{ time: q(0, "ms"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") }, { time: q(100, "ms"), bulkTemperature: q(500, "K"), heatTransferCoefficient: q(100, "W/m2/K") }];
    const hist = validateCase(raw).normalized!;
    expect(initialState(hist).T).toEqual(initialState(plain).T);
  });
  it("a uniform start with a prescribed wall begins at the history's value at time 0, not the case's own wall temperature", () => {
    const raw = JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));
    raw.boundary = { surfaceTemperature: q(600, "K") };
    raw.transient.boundaryHistory = [{ time: q(0, "ms"), surfaceTemperature: q(700, "K") }, { time: q(100, "ms"), surfaceTemperature: q(800, "K") }];
    const c = validateCase(raw).normalized!;
    expect(initialState(c).wall).toBe(700);
    delete raw.transient.boundaryHistory;
    expect(initialState(validateCase(raw).normalized!).wall).toBe(600);
  });
});
