// The transient section of a coated particle (plan 13, T3 stage 3): the heat made in the kernel as a table against time (W per particle), the time grid, the outputs, the starting state
// (a uniform temperature, or the steady state at a stated power) and, optionally, the outside as a table against time (the pin's boundary history, same forms). Nothing is defaulted.
// A particle's time scale is a fraction of a second, so the grid is fine; the work (cells x steps) is bounded more tightly than a pin's, because the independent finite-volume
// runs of the results are done in the server's own thread (they take a second or two at the bound).

import { MAX_HISTORY_POINTS, MAX_OUTPUTS, MAX_STEPS } from "./validate";
import type { BoundaryHistory } from "./validate";
import type { Dimension } from "./units";

type ErrFn = (code: string, field: string, message: string, extra?: Record<string, unknown>) => void;
type QtyFn = (value: unknown, dim: Dimension, field: string) => number | undefined;

export interface NormalizedTrisoTransient {
  /** The power history: heat made in the kernel, W per particle, linear between the points. */
  times: number[];
  particlePower: number[];
  endTime: number;
  timeStep: number;
  steps: number;
  outputs: number;
  initial: { kind: "uniform"; temperature: number } | { kind: "steady"; particlePower: number };
  boundaryHistory?: BoundaryHistory;
}

/** Cells x steps allowed for a particle's transient: the independent runs (same mesh, doubled mesh, half step) are done in the server's own thread. */
export const MAX_TRISO_TRANSIENT_WORK = 5e5;

const KEYS = ["powerHistory", "endTime", "timeStep", "outputs", "initialTemperature", "initialSteadyParticlePower", "boundaryHistory"];
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The power at time t from the table: linear between the points, the last value held (the table reaches the end time). */
export function trisoPowerAt(times: readonly number[], power: readonly number[], t: number): number {
  if (t <= times[0]!) return power[0]!;
  for (let i = 1; i < times.length; i++) {
    if (t <= times[i]!) return power[i - 1]! + ((power[i]! - power[i - 1]!) * (t - times[i - 1]!)) / (times[i]! - times[i - 1]!);
  }
  return power[power.length - 1]!;
}

/** Exact integral of the piecewise-linear power from 0 to t, J. */
export function trisoEnergyUntil(times: readonly number[], power: readonly number[], t: number): number {
  let e = 0;
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1]!;
    if (t <= a) break;
    const b = Math.min(times[i]!, t);
    const pb = power[i - 1]! + ((power[i]! - power[i - 1]!) * (b - a)) / (times[i]! - a);
    e += 0.5 * (power[i - 1]! + pb) * (b - a);
  }
  return e;
}

/**
 * Read the section. `readHistory` is the validator's reader of a boundary history (the pin's, shared). Every refusal names the field. Returns undefined when anything was refused.
 */
export function parseTrisoTransient(t: Record<string, unknown>, err: ErrFn, qty: QtyFn, readHistory: (raw: unknown, endTime: number | undefined) => BoundaryHistory | undefined): NormalizedTrisoTransient | undefined {
  let ok = true;
  const bad = (code: string, field: string, message: string, extra: Record<string, unknown> = {}) => {
    ok = false;
    err(code, field, message, extra);
  };
  for (const k of Object.keys(t)) {
    if (k === "pointKinetics") bad("E_UNSUPPORTED", "/transient/pointKinetics", "a generated pulse (point kinetics) is for pins: give the particle's power as a table, 'powerHistory'");
    else if (k === "initialSteadyLinearHeatRate") bad("E_UNSUPPORTED", "/transient/initialSteadyLinearHeatRate", "a particle's steady start is given as a power per particle: 'initialSteadyParticlePower'");
    else if (!KEYS.includes(k)) bad("E_SCHEMA_INVALID", "/transient/" + k, "unknown key '" + k + "' for a particle's transient (it has " + KEYS.join(", ") + ")");
  }
  for (const key of ["endTime", "timeStep", "outputs"]) if (t[key] === undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/" + key, "the transient section needs '" + key + "'");
  if (t.powerHistory === undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/powerHistory", "the transient section needs its power: 'powerHistory', a table of {time, particlePower}");
  if (t.initialTemperature !== undefined && t.initialSteadyParticlePower !== undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/initialSteadyParticlePower", "give either 'initialTemperature' (a uniform start) or 'initialSteadyParticlePower' (the steady state at that power), not both");
  else if (t.initialTemperature === undefined && t.initialSteadyParticlePower === undefined && t.initialSteadyLinearHeatRate === undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/initialTemperature", "the transient section needs an initial state: 'initialTemperature' (a uniform start) or 'initialSteadyParticlePower' (the steady state of this particle at that power)");

  const endTime = t.endTime === undefined ? undefined : qty(t.endTime, "time", "/transient/endTime");
  const timeStep = t.timeStep === undefined ? undefined : qty(t.timeStep, "time", "/transient/timeStep");
  const initialTemperature = t.initialTemperature === undefined ? undefined : qty(t.initialTemperature, "temperature", "/transient/initialTemperature");
  const initialP = t.initialSteadyParticlePower === undefined ? undefined : qty(t.initialSteadyParticlePower, "power", "/transient/initialSteadyParticlePower");
  if ((endTime === undefined && t.endTime !== undefined) || (timeStep === undefined && t.timeStep !== undefined) || (initialTemperature === undefined && t.initialTemperature !== undefined) || (initialP === undefined && t.initialSteadyParticlePower !== undefined)) ok = false;
  if (endTime !== undefined && !(endTime > 0)) bad("E_OUT_OF_RANGE", "/transient/endTime", "end time must be positive", { unit: "s" });
  if (timeStep !== undefined && !(timeStep > 0)) bad("E_OUT_OF_RANGE", "/transient/timeStep", "time step must be positive", { unit: "s" });
  if (initialTemperature !== undefined && !(initialTemperature > 0)) bad("E_OUT_OF_RANGE", "/transient/initialTemperature", "initial temperature must be above 0 K", { unit: "K" });
  if (initialP !== undefined && !(initialP >= 0)) bad("E_OUT_OF_RANGE", "/transient/initialSteadyParticlePower", "the steady power cannot be negative", { unit: "W" });

  let steps = 0;
  if (endTime !== undefined && timeStep !== undefined && endTime > 0 && timeStep > 0) {
    const ratio = endTime / timeStep;
    steps = Math.round(ratio);
    if (Math.abs(ratio - steps) > 1e-9 * Math.max(1, ratio)) bad("E_TIME", "/transient/timeStep", "the end time is not a whole number of time steps (" + ratio + " steps); choose a step that divides it", { unit: "s" });
    else if (steps < 1) bad("E_TIME", "/transient/timeStep", "the time step is longer than the end time", { unit: "s" });
    else if (steps > MAX_STEPS) bad("E_TIME", "/transient/timeStep", "the run would take " + steps + " steps; the maximum is " + MAX_STEPS, { unit: "s" });
  }
  const outputs = t.outputs;
  if (typeof outputs === "number" && Number.isInteger(outputs)) {
    if (outputs < 1 || outputs > MAX_OUTPUTS) bad("E_TIME", "/transient/outputs", "outputs is " + outputs + "; it must be between 1 and " + MAX_OUTPUTS);
    else if (steps >= 1 && steps % outputs !== 0) bad("E_TIME", "/transient/outputs", "outputs (" + outputs + ") must divide the number of steps (" + steps + ") so the outputs fall on step boundaries");
  } else if (outputs !== undefined) bad("E_SCHEMA_INVALID", "/transient/outputs", "outputs is a whole number");

  const times: number[] = [];
  const power: number[] = [];
  const hist = t.powerHistory;
  if (Array.isArray(hist)) {
    if (hist.length < 2) bad("E_TIME", "/transient/powerHistory", "the power history needs at least two points");
    else if (hist.length > MAX_HISTORY_POINTS) bad("E_TIME", "/transient/powerHistory", "the power history has " + hist.length + " points; the maximum is " + MAX_HISTORY_POINTS);
    else {
      hist.forEach((p: unknown, i: number) => {
        const f = "/transient/powerHistory/" + i;
        if (!isObject(p)) return bad("E_SCHEMA_INVALID", f, "each history point is {time, particlePower}");
        for (const k of Object.keys(p)) if (k !== "time" && k !== "particlePower") bad("E_SCHEMA_INVALID", f + "/" + k, "unknown key '" + k + "' (a point has time, particlePower)");
        const tt = qty(p.time, "time", f + "/time");
        const q = qty(p.particlePower, "power", f + "/particlePower");
        if (tt === undefined || q === undefined) {
          ok = false;
          return;
        }
        if (q < 0) return bad("E_OUT_OF_RANGE", f + "/particlePower", "the power cannot be negative", { unit: "W" });
        times.push(tt);
        power.push(q);
      });
      if (times.length === hist.length) {
        if (times[0] !== 0) bad("E_TIME", "/transient/powerHistory/0/time", "the power history must start at time 0");
        for (let i = 1; i < times.length; i++) {
          if (!(times[i]! > times[i - 1]!)) {
            bad("E_TIME", "/transient/powerHistory/" + i + "/time", "history times must increase strictly");
            break;
          }
        }
        if (endTime !== undefined && times[times.length - 1]! < endTime * (1 - 1e-12)) bad("E_TIME", "/transient/powerHistory", "the power history ends at " + times[times.length - 1] + " s, before the end time " + endTime + " s; give the power over the whole run");
        // all zero is a mistake from a uniform start (nothing is heated), but a shutdown from a steady operating state and a particle cooling or warming through a stated outside are real cases
        if (!(Math.max(...power) > 0) && t.initialSteadyParticlePower === undefined && t.boundaryHistory === undefined) bad("E_OUT_OF_RANGE", "/transient/powerHistory", "the power history is zero everywhere");
      } else ok = false;
    }
  } else if (hist !== undefined) bad("E_SCHEMA_INVALID", "/transient/powerHistory", "the power history is a list of {time, particlePower} points");

  let boundaryHistory: BoundaryHistory | undefined;
  if (t.boundaryHistory !== undefined) {
    boundaryHistory = readHistory(t.boundaryHistory, endTime);
    if (boundaryHistory === undefined) ok = false;
  }
  const initial: NormalizedTrisoTransient["initial"] | undefined = initialTemperature !== undefined ? { kind: "uniform", temperature: initialTemperature } : initialP !== undefined ? { kind: "steady", particlePower: initialP } : undefined;
  if (!ok || endTime === undefined || timeStep === undefined || initial === undefined || typeof outputs !== "number" || times.length < 2) return undefined;
  return { times, particlePower: power, endTime, timeStep, steps, outputs, initial, ...(boundaryHistory ? { boundaryHistory } : {}) };
}
