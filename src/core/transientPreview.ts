// The quick look of a transient case: no solver, no closed form for the whole pin, so the independent finite-volume solution
// (transientFv.ts) stands in. It is a preview, labelled as such; the solver result is what the run produces.

import { adiabaticTemperature } from "./transientExact";
import { maxOf } from "./transientFv";
import { depositedEnergy, independentSolution, pinOf } from "./transientResults";
import { NormalizedCase } from "./validate";

/** Cells x steps above which the preview is skipped (it would take noticeable time in the server). */
export const PREVIEW_MAX_WORK = 4e7;

export interface TransientPreview {
  steps: number;
  outputs: number;
  /** Energy deposited per unit length over the whole history (J/m) and per unit fuel volume (J/m3). */
  depositedEnergy: number;
  depositedPerVolume: number;
  /** Temperature the fuel would reach if nothing left it: exact for any uniform source. */
  adiabaticPeak: number;
  /** The independent solution at the outputs, or null with the reason when it was not run. */
  preview: { time: number[]; power: number[]; peakT: number[]; fuelSurfaceCellT: number[]; claddingInnerCellT: number[]; claddingOuterT: number[] } | null;
  previewSkipped: string | null;
  note: string;
}

export function transientPreview(c: NormalizedCase): TransientPreview {
  const t = c.transient!;
  const energy = depositedEnergy(t.times, t.linearHeatRate, t.endTime);
  const perVolume = energy / (Math.PI * (c.fuelRadius ** 2 - c.fuelInnerRadius ** 2));
  const cp = c.fuelHeatCapacity!;
  const a = cp.kind === "constant" ? cp.c : cp.a;
  const b = cp.kind === "constant" ? 0 : cp.b;
  const adiabaticPeak = adiabaticTemperature(a, b, t.initialTemperature, perVolume);
  const work = (c.mesh.fuelCells + c.mesh.claddingCells) * t.steps * 6;
  let preview: TransientPreview["preview"] = null;
  let skipped: string | null = null;
  if (work > PREVIEW_MAX_WORK) skipped = "the preview would take too long for this mesh and number of steps; run the solver instead";
  else {
    const fv = independentSolution(c);
    const nf = c.mesh.fuelCells;
    const pin = pinOf(c);
    preview = {
      time: fv.states.map((s) => s.time),
      power: fv.states.map((s) => pin.power(s.time)),
      peakT: fv.states.map((s) => maxOf(s.T)),
      fuelSurfaceCellT: fv.states.map((s) => s.T[nf - 1]!),
      claddingInnerCellT: fv.states.map((s) => s.T[nf]!),
      claddingOuterT: fv.states.map((s) => s.T[s.T.length - 1]!),
    };
  }
  return {
    steps: t.steps,
    outputs: t.outputs,
    depositedEnergy: energy,
    depositedPerVolume: perVolume,
    adiabaticPeak,
    preview,
    previewSkipped: skipped,
    note: "The adiabatic peak is what the fuel reaches if no heat leaves; the real peak is lower when the pulse is long. The curve is an independent finite-volume preview, not the solver.",
  };
}
