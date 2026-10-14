// Fixes from the Codex review of plan 11 B2 (2026-10-14): a warning when the saved outputs cannot see a change in the boundary history, a gross local bound on the energy balance
// that a later large exchange cannot dilute, and a time-step check that looks at every cell and the wall when a boundary history is stated.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ENERGY_BALANCE_TOLERANCE, computeIndependent, fieldTimeError, historyEnergyWorst, initialState } from "../src/core/transientResults";
import { unseenHistoryChange, validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const pulse = () => JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));
const conv = (s: number, Tb: number, h: number) => ({ time: q(s, "s"), bulkTemperature: q(Tb, "K"), heatTransferCoefficient: q(h, "W/m2/K") });

describe("a change that the saved outputs cannot see", () => {
  const hist = (points: [number, number, number][]) => ({ kind: "convective" as const, times: points.map((p) => p[0]), bulkTemperature: points.map((p) => p[1]), heatTransferCoefficient: points.map((p) => p[2]) });
  it("a brief pulse in the bulk temperature between two outputs is named", () => {
    const h = hist([[0, 600, 500], [9, 600, 500], [10, 900, 500], [11, 600, 500], [40, 600, 500]]);
    const m = unseenHistoryChange(h, 40, 2)!;
    expect(m).toMatch(/bulk temperature reaches 900 at 10 s, between the outputs at 0 and 20 s/);
  });
  it("a dip in the film coefficient is named; a change the outputs do see (a step, a ramp) is not", () => {
    expect(unseenHistoryChange(hist([[0, 600, 500], [9, 600, 500], [10, 600, 5], [11, 600, 500], [40, 600, 500]]), 40, 2)).toMatch(/film coefficient reaches 5 at 10 s/);
    expect(unseenHistoryChange(hist([[0, 600, 500], [10, 600, 500], [10.05, 600, 100], [40, 600, 100]]), 40, 40)).toBeUndefined();
    expect(unseenHistoryChange(hist([[0, 600, 500], [40, 900, 500]]), 40, 4)).toBeUndefined();
    expect(unseenHistoryChange(hist([[0, 600, 500], [9, 600, 500], [10, 900, 500], [11, 600, 500], [40, 600, 500]]), 40, 40)).toBeUndefined();
    expect(unseenHistoryChange({ kind: "surface-temperature", times: [0, 9, 10, 11, 40], surfaceTemperature: [600, 600, 900, 600, 600] }, 40, 2)).toMatch(/surface temperature reaches 900/);
  });
  it("the validator warns (W_BOUNDARY_BETWEEN_OUTPUTS) and still accepts the case", () => {
    const d = pulse();
    d.transient.powerHistory = [{ time: q(0, "s"), linearHeatRate: q(1, "kW/m") }, { time: q(40, "s"), linearHeatRate: q(1, "kW/m") }];
    d.transient.endTime = q(40, "s");
    d.transient.timeStep = q(1, "s");
    d.transient.outputs = 2;
    d.transient.boundaryHistory = [conv(0, 600, 500), conv(9, 600, 500), conv(10, 900, 500), conv(11, 600, 500), conv(40, 600, 500)];
    d.boundary = { bulkTemperature: q(600, "K"), heatTransferCoefficient: q(500, "W/m2/K") };
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.warnings.map((w) => w.code)).toContain("W_BOUNDARY_BETWEEN_OUTPUTS");
    d.transient.outputs = 40;
    expect(validateCase(d).warnings.map((w) => w.code)).not.toContain("W_BOUNDARY_BETWEEN_OUTPUTS");
  });
});

describe("the energy balance with a history", () => {
  it("the gap is judged against the largest energy exchanged anywhere in the run: an early gap of the size of the early exchange passes the balance (it is what an unresolved jump inside the first interval looks like), and a gap of 3.1 % of the whole run fails", () => {
    expect(historyEnergyWorst([0, 100, 5000], [0, 0, 5000], [0, 0, 0])).toBeLessThan(ENERGY_BALANCE_TOLERANCE);
    expect(historyEnergyWorst([0, 1000], [0, 1000 * (1 - 0.031)], [0, 0])).toBeGreaterThan(ENERGY_BALANCE_TOLERANCE);
  });
  it("a balanced run passes, including one whose stored and rejected energies cross zero and one whose first interval is half missed by the trapezoid", () => {
    expect(historyEnergyWorst([0, 25, 50, 75], [0, -11000, -16500, -9000], [0, 11000, 16500, 9100])).toBeLessThan(ENERGY_BALANCE_TOLERANCE);
    // the first interval of a wall that starts moving: 770 of 61788 J/m missing (1.2 %), 4.9 % of what had been exchanged by then
    expect(historyEnergyWorst([0, 50, 100], [0, 15347.6, 30827.9], [0, -14547.5, -29861.5])).toBeLessThan(ENERGY_BALANCE_TOLERANCE);
  });
  it("nothing exchanged is a pass, and the bound is on the scale of the threshold", () => {
    expect(historyEnergyWorst([0, 0], [0, 0], [0, 0])).toBe(0);
    expect(historyEnergyWorst([0, 1000], [0, 1000 * (1 - 0.029)], [0, 0])).toBeLessThan(ENERGY_BALANCE_TOLERANCE);
    expect(historyEnergyWorst([0, 1000], [0, 1000 * (1 - 0.031)], [0, 0])).toBeGreaterThan(ENERGY_BALANCE_TOLERANCE);
  });
});

describe("the time-step check over every cell and the wall", () => {
  it("a brief dip of the wall temperature that the cladding feels and the fuel's hottest cell (the centre) does not is seen by the field error over every cell and the wall", () => {
    const d = pulse();
    d.boundary = { surfaceTemperature: q(900, "K") };
    d.transient = {
      powerHistory: [{ time: q(0, "s"), linearHeatRate: q(1, "kW/m") }, { time: q(20, "s"), linearHeatRate: q(1, "kW/m") }],
      endTime: q(20, "s"), timeStep: q(1, "s"), outputs: 20, initialTemperature: q(900, "K"),
      boundaryHistory: [{ time: q(0, "s"), surfaceTemperature: q(900, "K") }, { time: q(9.5, "s"), surfaceTemperature: q(900, "K") }, { time: q(10, "s"), surfaceTemperature: q(300, "K") }, { time: q(10.5, "s"), surfaceTemperature: q(900, "K") }, { time: q(20, "s"), surfaceTemperature: q(900, "K") }],
    };
    const c = validateCase(d).normalized!;
    const ind = computeIndependent(c);
    const init = initialState(c);
    const f = fieldTimeError(ind.fv, ind.fvh, init);
    // the hottest cell at the outputs, step against half step, and the same over every cell and the wall: the second can only be larger, and here it exceeds the 2 % bound
    let peakErr = 0;
    ind.fv.states.forEach((s, j) => (peakErr = Math.max(peakErr, Math.abs(Math.max(...s.T) - Math.max(...ind.fvh.states[j]!.T)))));
    expect(f.err).toBeGreaterThanOrEqual(peakErr);
    expect(f.err).toBeGreaterThan(0.02 * Math.max(f.scale, 1));
    expect(f.scale).toBeGreaterThan(100);
  });
  it("no excursion, no error", () => {
    const d = pulse();
    const c = validateCase(d).normalized!;
    const ind = computeIndependent(c);
    const f = fieldTimeError(ind.fv, ind.fv, initialState(c));
    expect(f.err).toBe(0);
  });
});

describe("fieldTimeError by hand", () => {
  const st = (T: number[], wall: number) => ({ time: 0, T, deposited: 0, rejected: 0, wall });
  const run = (states: ReturnType<typeof st>[]) => ({ r: [], states }) as any;
  it("takes the largest difference over the cells and the wall, and the largest excursion of any cell or the wall from its start", () => {
    const init = { T: [600, 600, 600], wall: 600 };
    const coarse = run([st([600, 600, 600], 600), st([650, 640, 610], 620)]);
    const fine = run([st([600, 600, 600], 600), st([649, 643, 611], 600)]);
    const f = fieldTimeError(coarse, fine, init);
    expect(f.err).toBe(20); // the wall: 620 against 600
    expect(f.scale).toBe(50); // the first cell: 650 against 600
    // a cell difference larger than the wall's
    const fine2 = run([st([600, 600, 600], 600), st([640, 643, 611], 619)]);
    expect(fieldTimeError(coarse, fine2, init).err).toBe(10);
    // a wall excursion larger than any cell's
    expect(fieldTimeError(run([st([600, 600, 600], 600), st([601, 601, 601], 900)]), fine, init).scale).toBe(300);
  });
});
