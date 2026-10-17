// The two-dimensional reference of a stack case (plan 15, B2): the case as the model of src/core/axialFv.ts (N layers of the case's radial cells, each with its own heat rate and
// coolant, joined along the height), and its steady solution cut back into the slices the checks judge. A stack of PLATES is judged against it (owner's decision after B0); a pin keeps
// the allowance of stackResults.ts. When the reference cannot be computed (too many unknowns, an iteration that does not settle) the result says why and the caller falls back to the allowance.

import { sliceCase, sliceLoads } from "./axial";
import { StackModel, StackSteady, StackTransient, solveStackSteady, solveStackTransient } from "./axialFv";
import { boundaryAtTime } from "./boundaryHistory";
import { lawOf } from "./conductivity";
import { heatCapacityLaw } from "./heatCapacity";
import { SliceReference } from "./resultsParser";
import { IndependentSet, initialState } from "./transientResults";
import { FvTransient, TransientPin } from "./transientFv";
import { NormalizedCase } from "./validate";

/** The radial model of the case for the stack solver: its geometry, mesh, gap and property laws. A steady case has no heat capacity, and the steady solution does not read one. */
export function stackPinOf(c: NormalizedCase): TransientPin {
  const cap = (h: NormalizedCase["fuelHeatCapacity"]) => (h ? heatCapacityLaw(h) : [1]);
  return {
    ...(c.plate ? { slab: true } : {}),
    fuelInnerRadius: c.fuelInnerRadius,
    fuelRadius: c.fuelRadius,
    claddingInnerRadius: c.claddingInnerRadius,
    claddingOuterRadius: c.claddingOuterRadius,
    fuelCells: c.mesh.fuelCells,
    claddingCells: c.mesh.claddingCells,
    gapConductance: c.gapConductance,
    fuelK: { a: 0, b: 0 },
    fuelLaw: lawOf(c.fuelConductivity),
    claddingK: { a: 0, b: 0 },
    claddingLaw: lawOf(c.claddingConductivity),
    fuelC: { a: 1, b: 0 },
    fuelCLaw: cap(c.fuelHeatCapacity),
    claddingC: { a: 1, b: 0 },
    claddingCLaw: cap(c.claddingHeatCapacity),
    boundary: c.boundary,
    power: () => 0,
  };
}

/**
 * The stack case as the solver's model. Steady: every layer has its own heat rate (the average times the shape at the layer's centre, as OFFBEAT samples it) and its coolant (the table
 * at the layer's centre). Transient: the layer's power is the case's history times the layer's factor, and the coolant is the boundary history's when the case has one.
 */
export function stackModelOf(c: NormalizedCase, o: { axialConduction?: boolean } = {}): StackModel {
  const a = c.axial;
  if (!a) throw new Error("stackModelOf is for an axial stack");
  const loads = sliceLoads(c);
  const tr = c.transient;
  const hist = tr?.boundaryHistory;
  const history = (t: number) => {
    const { times, linearHeatRate } = tr!;
    if (t <= times[0]!) return linearHeatRate[0]!;
    for (let i = 1; i < times.length; i++) if (t <= times[i]!) return linearHeatRate[i - 1]! + ((linearHeatRate[i]! - linearHeatRate[i - 1]!) * (t - times[i - 1]!)) / (times[i]! - times[i - 1]!);
    return linearHeatRate[linearHeatRate.length - 1]!;
  };
  return {
    pin: stackPinOf(c),
    layers: a.slices,
    height: a.length,
    power: (k, t) => (tr ? history(t) * loads[k]!.factor : loads[k]!.linearHeatRate),
    boundary: (k, t) => (hist ? boundaryAtTime(hist, t) : loads[k]!.boundary),
    ...(o.axialConduction === false ? { axialConduction: false } : {}),
  };
}

/** The reference of a steady stack: the solution, and the slice-by-slice cut of it. */
export interface StackReference {
  kind: "two-dimensional";
  solution: StackSteady;
  /** The cells of a slice (fuel then cladding, inner to outer) and its outer wall. */
  slice(k: number): SliceReference;
}

export type StackReferenceResult = { reference: StackReference } | { fallback: string };

/** The steady two-dimensional reference of the case, or the reason it could not be made (the caller then keeps the allowance). */
export function stackReference(c: NormalizedCase, o: { axialConduction?: boolean } = {}): StackReferenceResult {
  if (!c.axial) return { fallback: "the case is not an axial stack" };
  let solution: StackSteady;
  try {
    solution = solveStackSteady(stackModelOf(c, o));
  } catch (e) {
    return { fallback: "the two-dimensional reference could not be computed: " + (e instanceof Error ? e.message : String(e)) };
  }
  const nf = c.mesh.fuelCells;
  return {
    reference: {
      kind: "two-dimensional",
      solution,
      slice: (k) => {
        const cells = Array.from(solution.T.subarray(k * solution.n, (k + 1) * solution.n));
        return { fuel: cells.slice(0, nf), clad: cells.slice(nf), wall: solution.wall[k]! };
      },
    },
  };
}

// ---- the transient (plan 15, B3) ----------------------------------------------------------------------------------------------------------------------------------------

/** The most unknowns x steps a transient reference solves (the largest case the validator's work budget allows is 50 x 26 x 2300 = 3e6), and the wall-clock time it may take (ms). */
export const STACK_TRANSIENT_WORK_MAX = 3e6;
export const STACK_TRANSIENT_DEADLINE_MS = 60000;

/** The temperature field the writer gives OFFBEAT to start from: every slice at its OWN steady state (or the uniform start), layer by layer. */
export function runStartField(c: NormalizedCase): Float64Array {
  const loads = sliceLoads(c);
  const n = c.mesh.fuelCells + c.mesh.claddingCells;
  const out = new Float64Array(loads.length * n);
  loads.forEach((l, k) => out.set(initialState(sliceCase(c, l)).T, k * n));
  return out;
}

/**
 * The COUPLED steady state of a transient stack's initial heat rate: the stack's steady solution at the case's stated steady-start heat rate times each layer's factor and the
 * coolant of t = 0. The run itself starts from each slice's own one-dimensional steady state (the field the writer gives OFFBEAT, `runStartField`), which differs from this by the
 * axial conduction; the checks follow the run, and the record states the distance.
 */
export function coupledSteadyStart(c: NormalizedCase): StackSteady {
  const t = c.transient;
  if (!t || t.initial.kind !== "steady") throw new Error("coupledSteadyStart is for a transient stack that starts from a steady state");
  const loads = sliceLoads(c);
  const q0 = t.initial.linearHeatRate;
  const model = stackModelOf(c);
  return solveStackSteady({ ...model, power: (k) => q0 * loads[k]!.factor });
}

export interface StackTransientReference {
  kind: "two-dimensional";
  solution: StackTransient;
  /** The slice k's part of the solution as the independent solution its checks expect, with the error estimates of the slice's own one-dimensional runs carried over (see sliceIndependent). */
  sliceIndependent(k: number, own: IndependentSet): IndependentSet;
  /** The heat slice k has received from its neighbours up to each output time, J per unit height (the unit of the slice's deposited energy). */
  received(k: number): number[];
  /** The largest difference between the run's start and the coupled steady state (K), for a steady start. */
  startDistance: number | null;
}

export type StackTransientReferenceResult = { reference: StackTransientReference } | { fallback: string };

/**
 * The transient two-dimensional reference of the case: the stack's solution from the field the run started from, with the run's step and the powers and coolants it was given.
 * Not solved (with the reason, and the caller then keeps the allowance) when the unknowns times the steps exceed STACK_TRANSIENT_WORK_MAX or the deadline passes.
 */
export function stackTransientReference(c: NormalizedCase, o: { axialConduction?: boolean; deadlineMs?: number } = {}): StackTransientReferenceResult {
  const a = c.axial;
  const t = c.transient;
  if (!a || !t) return { fallback: "the case is not a transient stack" };
  const n = c.mesh.fuelCells + c.mesh.claddingCells;
  if (a.slices * n * t.steps > STACK_TRANSIENT_WORK_MAX) return { fallback: `the two-dimensional reference was not computed: ${a.slices * n} unknowns x ${t.steps} steps is more than the ${STACK_TRANSIENT_WORK_MAX} the reference solves` };
  let solution: StackTransient;
  let start: Float64Array;
  try {
    start = runStartField(c);
    solution = solveStackTransient(stackModelOf(c, o), { dt: t.timeStep, steps: t.steps, outputEvery: t.steps / t.outputs, initial: start, trace: true, deadlineMs: o.deadlineMs ?? STACK_TRANSIENT_DEADLINE_MS });
  } catch (e) {
    return { fallback: "the two-dimensional reference could not be computed: " + (e instanceof Error ? e.message : String(e)) };
  }
  let startDistance: number | null = null;
  if (t.initial.kind === "steady") {
    try {
      const coupled = coupledSteadyStart(c);
      startDistance = Math.max(...Array.from(start, (x, i) => Math.abs(x - coupled.T[i]!)));
    } catch {
      startDistance = null;
    }
  }
  const height = a.length / a.slices;
  const nf = c.mesh.fuelCells;
  return {
    reference: {
      kind: "two-dimensional",
      solution,
      startDistance,
      received: (k) => solution.states.map((s) => s.layerAxialIn[k]! / height),
      sliceIndependent: (k, own) => {
        const cells = (j: number) => Array.from(solution.states[j]!.T.subarray(k * n, (k + 1) * n));
        const fv: FvTransient = {
          r: solution.r,
          states: solution.states.map((s, j) => ({ time: s.time, T: cells(j), deposited: s.layerDeposited[k]!, rejected: s.layerRejected[k]!, wall: s.wall[k]! })),
          trace: solution.traces![k]!,
        };
        // The error estimates of a slice (what its cross-check bound is made of) come from its own one-dimensional runs on the doubled mesh and at half the step: the radial mesh and the
        // Euler step do not depend on the conduction along the height to first order. Each is carried over as the same difference, added to the two-dimensional solution.
        const shift = (j: number) => ({ dT: fv.states[j]!.T.map((x, i) => x - own.fv.states[j]!.T[i]!), dw: fv.states[j]!.wall - own.fv.states[j]!.wall });
        const fv2: FvTransient = {
          ...own.fv2,
          states: own.fv2.states.map((s, j) => {
            const { dT } = shift(j);
            const T = s.T.map((x, i) => x + (i < 2 * nf ? dT[Math.floor(i / 2)]! : dT[nf + Math.floor((i - 2 * nf) / 2)]!));
            return { ...s, T };
          }),
        };
        const fvh: FvTransient = {
          ...own.fvh,
          states: own.fvh.states.map((s, j) => {
            const { dT, dw } = shift(j);
            return { ...s, T: s.T.map((x, i) => x + dT[i]!), wall: s.wall + dw };
          }),
          trace: {
            ...own.fvh.trace!,
            peakByStep: own.fvh.trace!.peakByStep.map((x, m) => x + (fv.trace!.peakByStep[Math.floor(m / 2)]! - own.fv.trace!.peakByStep[Math.floor(m / 2)]!)),
          },
        };
        return { fv, fv2, fvh };
      },
    },
  };
}
