// The quick look of a transient case: no solver, no closed form for the whole pin, so the independent finite-volume solution
// (transientFv.ts) stands in. It is a preview, labelled as such; the solver result is what the run produces.

import { adiabaticTemperature } from "./transientExact";
import { degree, solveHot } from "./conductivity";
import { heatCapacityLaw } from "./heatCapacity";
import { maxOf } from "./transientFv";
import { GeneratedPulse } from "./pointKinetics";
import { FvTransient } from "./transientFv";
import { depositedEnergy, downsample, independentSolution, initialState, pinOf } from "./transientResults";
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
  /** Present when the power comes from point kinetics: the pulse's summary, and its curve for plotting. */
  generator: { summary: GeneratedPulse["summary"]; curve: { time: number[]; power: number[]; reactivity: number[]; fuelTemperature: number[] }; history: { time: number[]; linearHeatRate: number[] } } | null;
}

/** True when the editor's independent preview would take too long for this case, so it is not run at all. */
export function previewTooBig(c: NormalizedCase): boolean {
  return (c.mesh.fuelCells + c.mesh.claddingCells) * c.transient!.steps * 6 > PREVIEW_MAX_WORK;
}

/**
 * The editor's quick look at a transient. `external` carries the independent solution when it was run elsewhere (a worker), or the reason it was not;
 * left out, it is run here, in this thread.
 */
export function transientPreview(c: NormalizedCase, external?: { fv: FvTransient | null; skipped?: string }): TransientPreview {
  const t = c.transient!;
  const energy = depositedEnergy(t.times, t.linearHeatRate, t.endTime);
  const perVolume = energy / (Math.PI * (c.fuelRadius ** 2 - c.fuelInnerRadius ** 2));
  const cp = c.fuelHeatCapacity!;
  const law = heatCapacityLaw(cp);
  const start = initialState(c).fuelPeak;
  const adiabaticPeak = degree(law) > 1 ? solveHot(law, start, perVolume) : adiabaticTemperature(law[0]!, law[1] ?? 0, start, perVolume);
  let preview: TransientPreview["preview"] = null;
  let skipped: string | null = null;
  if (previewTooBig(c)) skipped = "the preview would take too long for this mesh and number of steps; run the solver instead";
  else if (external && external.fv === null) skipped = external.skipped ?? "the preview was not run";
  else {
    const fv = external?.fv ?? independentSolution(c);
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
    generator: t.generated ? { summary: t.generated.summary, curve: downsample(t.generated), history: { time: t.times, linearHeatRate: t.linearHeatRate } } : null,
    note: "The adiabatic peak is what the fuel reaches if no heat leaves; the real peak is lower when the pulse is long. The curve is an independent finite-volume preview, not the solver.",
  };
}
