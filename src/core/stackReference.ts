// The two-dimensional reference of a stack case (plan 15, B2): the case as the model of src/core/axialFv.ts (N layers of the case's radial cells, each with its own heat rate and
// coolant, joined along the height), and its steady solution cut back into the slices the checks judge. A stack of PLATES is judged against it (owner's decision after B0); a pin keeps
// the allowance of stackResults.ts. When the reference cannot be computed (too many unknowns, an iteration that does not settle) the result says why and the caller falls back to the allowance.

import { sliceLoads } from "./axial";
import { StackModel, StackSteady, solveStackSteady } from "./axialFv";
import { boundaryAtTime } from "./boundaryHistory";
import { lawOf } from "./conductivity";
import { heatCapacityLaw } from "./heatCapacity";
import { SliceReference } from "./resultsParser";
import { TransientPin } from "./transientFv";
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
