// The two-dimensional reference of a stack case (plan 15, B2): the case as the model of src/core/axialFv.ts (N layers of the case's radial cells, each with its own heat rate and
// coolant, joined along the height), and its steady solution cut back into the slices the checks judge. A stack of PLATES is judged against it (owner's decision after B0); a pin keeps
// the allowance of stackResults.ts. When the reference cannot be computed (too many unknowns, an iteration that does not settle) the result says why and the caller falls back to the allowance.

import { sliceCase, sliceLoads } from "./axial";
import { StackModel, StackSteady, StackTransient, solveStackSteady, solveStackTransient } from "./axialFv";
import { boundaryAtTime } from "./boundaryHistory";
import { lawOf } from "./conductivity";
import { heatCapacityLaw } from "./heatCapacity";
import type { ProfilePoint } from "./quickLook";
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

/**
 * What a STEADY reference is allowed to cost (found by the Codex review of 2026-10-17: the check response and a steady run solved it on the server thread with no bound but the
 * 20000 unknowns of the solver; 50 layers of 130 cells with temperature-dependent conductivities took 27 s there and 50 layers of 400 cells did not finish in 200 s). The banded solve
 * costs rows x n^2 (n the cells of one layer) per iteration, so the bound is on that: 2e7 (50 layers of 26 cells are 9e5 and take 30 ms, 10 layers of 100 cells 1e7).
 * A case over it keeps the allowance, with the reason.
 */
export const STACK_STEADY_BAND_WORK_MAX = 2e7;
/** The banded-solve work of one steady solution of the case: slices x (cells of one layer)^3. */
export function stackSteadyBandWork(c: NormalizedCase): number {
  const n = c.mesh.fuelCells + c.mesh.claddingCells;
  return c.axial ? c.axial.slices * n * n * n : 0;
}

/** The steady two-dimensional reference of the case, or the reason it could not be made (the caller then keeps the allowance). */
export function stackReference(c: NormalizedCase, o: { axialConduction?: boolean } = {}): StackReferenceResult {
  if (!c.axial) return { fallback: "the case is not an axial stack" };
  const work = stackSteadyBandWork(c);
  if (work > STACK_STEADY_BAND_WORK_MAX) return { fallback: `the two-dimensional reference was not computed: ${c.axial.slices} layers of ${c.mesh.fuelCells + c.mesh.claddingCells} cells are more work (${work.toExponential(2)}) than the ${STACK_STEADY_BAND_WORK_MAX.toExponential(0)} the steady reference solves` };
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

// ---- the editor's steady field (plan 15, B5) ---------------------------------------------------------------------------------------------------------------------------

/** What the check offers the case view's 3D picture besides the closed forms: the steady two-dimensional field of a stack of plates, or the reason it is not offered. */
export type AxialField2d =
  | {
      available: true;
      /** The field of every slice in the form of the closed-form profile (radius from the mid-plane, temperature, region): one point per cell. */
      slices: { index: number; height: number; points: ProfilePoint[] }[];
      /** The largest change the conduction along the height makes to any cell (K): the field against the same solution with the conduction between the layers off. */
      effect: number;
      note: string;
    }
  | { available: false; reason: string };

export const FIELD_2D_NOTE = "FEED's own finite-volume solution of the whole stack on the writer's mesh (radius and height, the end faces insulated), steady. A second method on the same mesh as the run, not OFFBEAT's result and not a measurement.";
export const FIELD_2D_PIN_REASON = "not offered for a stack of pins: the pin's radial reference is 3 to 4 K from OFFBEAT's in cell-middle nodes and a logarithmic conductance (docs/axial-stack.md), which hides the 1 K the conduction along the height changes at TRIGA length. A pin keeps the closed forms and the allowance.";

/** The steady two-dimensional field of a steady stack for the case view; undefined for a case that is not a steady stack. */
export function axialField2d(c: NormalizedCase): AxialField2d | undefined {
  if (!c.axial || c.transient) return undefined;
  if (!c.plate) return { available: false, reason: FIELD_2D_PIN_REASON };
  const ref = stackReference(c);
  if ("fallback" in ref) return { available: false, reason: ref.fallback };
  const off = stackReference(c, { axialConduction: false });
  let effect = NaN;
  if ("reference" in off) {
    effect = 0;
    ref.reference.solution.T.forEach((x, i) => (effect = Math.max(effect, Math.abs(x - (off.reference.solution.T[i] as number)))));
  } else return { available: false, reason: off.fallback };
  const loads = sliceLoads(c);
  const nf = c.mesh.fuelCells;
  const r = ref.reference.solution.r;
  return {
    available: true,
    effect,
    note: FIELD_2D_NOTE,
    slices: loads.map((l, k) => {
      const s = ref.reference.slice(k);
      const cells = [...s.fuel, ...s.clad];
      return { index: l.index, height: l.height, points: cells.map((T, i) => ({ r: r[i]!, T, region: i < nf ? "fuel" : "cladding" }) as ProfilePoint) };
    }),
  };
}

// ---- the transient (plan 15, B3) ----------------------------------------------------------------------------------------------------------------------------------------

/**
 * What a transient reference is allowed to cost (plan 15, B4). The validator already bounds cells x steps x slices (MAX_TRANSIENT_WORK, 3e6): STACK_TRANSIENT_WORK_MAX repeats it as
 * the unknowns x steps the reference solves. That alone does not bound the time, because the banded solve costs rows x n^2 per step (n the cells of one layer): 10 layers of 100 cells
 * and 3000 steps are 3e6 unknown-steps and took 38 s, 50 layers of 26 cells and 1200 steps (1.6e6) took 1.7 s. So the second bound is the work of the banded solves,
 * unknowns x cells per layer x steps (STACK_TRANSIENT_BAND_WORK_MAX, 4e8: 3e8 took 38 s with constant properties on this machine, and a temperature-dependent law costs a few times
 * more), and the deadline (STACK_TRANSIENT_DEADLINE_MS, ms of wall-clock time) is the last guard. A reference that exceeds any of them is not solved and the allowance stays, with the reason.
 */
export const STACK_TRANSIENT_WORK_MAX = 3e6;
export const STACK_TRANSIENT_BAND_WORK_MAX = 4e8;
export const STACK_TRANSIENT_DEADLINE_MS = 60000;

/** The size of the transient reference of a case: its unknowns, steps, and the two works the caps above bound. */
export function stackTransientWork(c: NormalizedCase): { unknowns: number; steps: number; work: number; bandWork: number } | undefined {
  const a = c.axial;
  const t = c.transient;
  if (!a || !t) return undefined;
  const n = c.mesh.fuelCells + c.mesh.claddingCells;
  const unknowns = a.slices * n;
  return { unknowns, steps: t.steps, work: unknowns * t.steps, bandWork: unknowns * n * t.steps };
}

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
  /** Why `startDistance` is null for a steady start (the coupled steady state was not solved); absent for a uniform start, which has no coupled state to compare with. */
  startDistanceReason?: string;
}

export type StackTransientReferenceResult = { reference: StackTransientReference } | { fallback: string };

/**
 * The part of the transient reference that is computed (and, in the server, computed in a worker thread): the solution, the field the run started from and the distance of that
 * from the coupled steady state. Plain numbers and typed arrays, so a worker can send it; `stackTransientReferenceFrom` makes the reference of it.
 */
export interface StackTransientSolved {
  solution: StackTransient;
  /** The same stack at half the step and on a radial mesh of twice the cells: the time and space error estimates of the COUPLED solution (R2a-1, R2a-2 of the Codex review of 2026-10-17). */
  half?: StackTransient;
  fine?: StackTransient;
  start: Float64Array;
  startDistance: number | null;
  startDistanceReason?: string;
}
export type StackTransientSolveResult = { solved: StackTransientSolved } | { fallback: string };

/**
 * Solve the transient two-dimensional reference of the case: the stack's solution from the field the run started from, with the run's step and the powers and coolants it was given.
 * Not solved (with the reason, and the caller then keeps the allowance) when the case is over a cap above, the solver refuses, or the deadline passes.
 */
export function solveStackTransientReference(c: NormalizedCase, o: { axialConduction?: boolean; deadlineMs?: number } = {}): StackTransientSolveResult {
  const w = stackTransientWork(c);
  if (!w) return { fallback: "the case is not a transient stack" };
  if (w.work > STACK_TRANSIENT_WORK_MAX) return { fallback: `the two-dimensional reference was not computed: ${w.unknowns} unknowns x ${w.steps} steps is more than the ${STACK_TRANSIENT_WORK_MAX} the reference solves` };
  if (w.bandWork > STACK_TRANSIENT_BAND_WORK_MAX) return { fallback: `the two-dimensional reference was not computed: ${w.unknowns} unknowns x ${c.mesh.fuelCells + c.mesh.claddingCells} cells per layer x ${w.steps} steps is more work (${w.bandWork.toExponential(2)}) than the ${STACK_TRANSIENT_BAND_WORK_MAX.toExponential(0)} the reference solves in its deadline` };
  const t = c.transient!;
  let solution: StackTransient;
  let start: Float64Array;
  let half: StackTransient;
  let fine: StackTransient;
  try {
    const budget = o.deadlineMs ?? STACK_TRANSIENT_DEADLINE_MS;
    const t0 = Date.now();
    const left = () => budget - (Date.now() - t0);
    start = runStartField(c);
    solution = solveStackTransient(stackModelOf(c, o), { dt: t.timeStep, steps: t.steps, outputEvery: t.steps / t.outputs, initial: start, trace: true, deadlineMs: left() });
    // the error estimates of the checks come from the coupled problem itself: the same stack at half the step, and on twice the cells (the one-dimensional runs of the slices, which these replace,
    // leave out the conduction along the height and so cannot see its effect on the time and space error)
    half = solveStackTransient(stackModelOf(c, o), { dt: t.timeStep / 2, steps: t.steps * 2, outputEvery: (t.steps / t.outputs) * 2, initial: start, trace: true, deadlineMs: left() });
    const cFine = { ...c, mesh: { ...c.mesh, fuelCells: c.mesh.fuelCells * 2, claddingCells: c.mesh.claddingCells * 2 } };
    fine = solveStackTransient(stackModelOf(cFine, o), { dt: t.timeStep, steps: t.steps, outputEvery: t.steps / t.outputs, initial: runStartField(cFine), deadlineMs: left() });
  } catch (e) {
    return { fallback: "the two-dimensional reference could not be computed: " + (e instanceof Error ? e.message : String(e)) };
  }
  let startDistance: number | null = null;
  let startDistanceReason: string | undefined;
  if (t.initial.kind === "steady") {
    try {
      const work = stackSteadyBandWork(c);
      if (work > STACK_STEADY_BAND_WORK_MAX) throw new Error(`the coupled steady state is more work (${work.toExponential(2)}) than the ${STACK_STEADY_BAND_WORK_MAX.toExponential(0)} the steady reference solves`);
      const coupled = coupledSteadyStart(c);
      startDistance = Math.max(...Array.from(start, (x, i) => Math.abs(x - coupled.T[i]!)));
    } catch (e) {
      startDistance = null;
      startDistanceReason = "the distance of the start from the coupled steady state was not computed: " + (e instanceof Error ? e.message : String(e));
    }
  }
  return { solved: { solution, half, fine, start, startDistance, ...(startDistanceReason ? { startDistanceReason } : {}) } };
}

/** The transient two-dimensional reference of the case in this thread (solve, then build). */
export function stackTransientReference(c: NormalizedCase, o: { axialConduction?: boolean; deadlineMs?: number } = {}): StackTransientReferenceResult {
  const r = solveStackTransientReference(c, o);
  return "solved" in r ? { reference: stackTransientReferenceFrom(c, r.solved) } : r;
}

/** The reference of a case from a solution computed elsewhere (a worker thread): the cut into slices and the error estimates of each slice. */
export function stackTransientReferenceFrom(c: NormalizedCase, solved: StackTransientSolved): StackTransientReference {
  const a = c.axial!;
  const { solution, half, fine, startDistance, startDistanceReason } = solved;
  const n = c.mesh.fuelCells + c.mesh.claddingCells;
  const height = a.length / a.slices;
  const nf = c.mesh.fuelCells;
  return {
    kind: "two-dimensional",
    solution,
    startDistance,
    ...(startDistanceReason ? { startDistanceReason } : {}),
    received: (k) => solution.states.map((s) => s.layerAxialIn[k]! / height),
    sliceIndependent: (k, own) => {
      const cells = (j: number) => Array.from(solution.states[j]!.T.subarray(k * n, (k + 1) * n));
      const fv: FvTransient = {
        r: solution.r,
        states: solution.states.map((s, j) => ({ time: s.time, T: cells(j), deposited: s.layerDeposited[k]!, rejected: s.layerRejected[k]!, wall: s.wall[k]! })),
        trace: solution.traces![k]!,
      };
      if (half && fine) {
        // the estimates are the coupled solution's own: the stack at half the step and on twice the cells, cut into this slice
        const cut = (sol: StackTransient, m: number, trace: boolean): FvTransient => ({
          r: sol.r,
          states: sol.states.map((s) => ({ time: s.time, T: Array.from(s.T.subarray(k * m, (k + 1) * m)), deposited: s.layerDeposited[k]!, rejected: s.layerRejected[k]!, wall: s.wall[k]! })),
          ...(trace ? { trace: sol.traces![k]! } : {}),
        });
        return { fv, fv2: cut(fine, 2 * n, false), fvh: cut(half, n, true) };
      }
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
  };
}
