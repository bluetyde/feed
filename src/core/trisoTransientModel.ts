// The independent model of a particle's transient (plan 13, T3 stage 3): the sphere the wedge solves (trisoWedge.ts), the case's heat capacities, its power table and its outside, as
// trisoSolve.ts's finite-volume solution takes them; and where the run starts. The writer (the starting field), the results (the independent runs) and the tests read this one definition.

import { boundaryAtTime } from "./boundaryHistory";
import { heatCapacityLaw } from "./heatCapacity";
import type { NormalizedTriso } from "./triso";
import { TrisoFv, TrisoModel, solveTrisoFv, steadyTrisoFv, trisoModelOf } from "./trisoSolve";
import { trisoPowerAt } from "./trisoTransient";
import { TRISO_WEDGE_SCALE, wedgeEquivalent } from "./trisoWedge";

/** The volume of the wedge's sphere is this fraction of the nominal sphere's, so it makes this fraction of the nominal power from the same volumetric power. */
export const TRISO_WEDGE_VOLUME_RATIO = TRISO_WEDGE_SCALE ** 3;

/** The independent model of a transient particle case: the sphere the wedge solves, the case's capacities, the power table (times the volume ratio) and the outside, on a mesh refined by cellFactor. */
export function trisoTransientModelOf(n: NormalizedTriso, cellFactor = 1): TrisoModel {
  const tr = n.transient;
  if (!tr || !n.capacities) throw new Error("not a transient particle case");
  const eq = wedgeEquivalent(n);
  const hist = tr.boundaryHistory;
  const base = trisoModelOf(eq, { capacities: n.capacities.map(heatCapacityLaw), power: (t) => trisoPowerAt(tr.times, tr.particlePower, t) * TRISO_WEDGE_VOLUME_RATIO });
  return { ...base, cells: base.cells.map((c) => c * cellFactor), ...(hist ? { boundaryAt: (t: number) => boundaryAtTime(hist, t) } : {}) };
}

export interface TrisoStart {
  /** The temperature of every cell (kernel inner to outer, then each layer), K. */
  T: number[];
  /** The outside's temperature at the start: the wall, or the film's bulk temperature for a uniform start. */
  wall: number;
  peak: number;
}

/** Where the transient starts, on the case's mesh refined by cellFactor: a uniform temperature, or the independent steady solution at the stated power (which throws a RangeError, with the reason, when there is none). */
export function trisoInitialField(n: NormalizedTriso, cellFactor = 1): TrisoStart {
  const tr = n.transient!;
  const model = trisoTransientModelOf(n, cellFactor);
  const cells = model.cells.reduce((a, b) => a + b, 0);
  const b0 = tr.boundaryHistory ? boundaryAtTime(tr.boundaryHistory, 0) : n.boundary;
  if (tr.initial.kind === "uniform") {
    const T0 = tr.initial.temperature;
    return { T: new Array<number>(cells).fill(T0), wall: b0.kind === "surface-temperature" ? b0.surfaceTemperature : T0, peak: T0 };
  }
  const s = steadyTrisoFv({ ...model, boundary: b0 }, tr.initial.particlePower * TRISO_WEDGE_VOLUME_RATIO);
  return { T: s.T, wall: s.wall, peak: Math.max(...s.T) };
}

function independentRun(n: NormalizedTriso, stepFactor: number, cellFactor: number, trace: boolean): TrisoFv {
  const tr = n.transient!;
  return solveTrisoFv(trisoTransientModelOf(n, cellFactor), { dt: tr.timeStep / stepFactor, steps: tr.steps * stepFactor, initialField: trisoInitialField(n, cellFactor).T, outputEvery: (tr.steps / tr.outputs) * stepFactor, ...(trace ? { trace: true } : {}) });
}

/** The three independent runs the results need: same mesh and step (with its trace), the doubled mesh (the independent solution's own spatial error), the half step (the time error, with its trace). */
export interface TrisoIndependentSet {
  fv: TrisoFv;
  fv2: TrisoFv;
  fvh: TrisoFv;
}

export function computeTrisoIndependent(n: NormalizedTriso): TrisoIndependentSet {
  return { fv: independentRun(n, 1, 1, true), fv2: independentRun(n, 1, 2, false), fvh: independentRun(n, 2, 1, true) };
}
