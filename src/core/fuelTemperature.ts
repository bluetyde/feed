// The fuel temperature by axial slice (the return quantity of SEED's power-temperature loop): what FEED declares in `describe`, and what a steady result carries.
//
// A loop of OpenMC Studio and FEED sends heating to FEED (the `heating-to-pin` transfer) and needs a fuel temperature back. SEED owns the loop and its records, the apps own the
// physics. This is FEED's part: a **declared** quantity, with its axis, unit, normalization, slice bounds, the pin it belongs to and what the number means, so that SEED does not guess.
//
// Where a slice has a position: (1) an axial stack (plan 12): slice k spans k h to (k + 1) h above the bottom of the heated length, h = length / N; (2) a one-slice case whose heat
// rate was set by a heating transfer: the slice the transfer was made for, in the frame of the transfer (the case's provenance names it). A plain one-slice pin has no height and
// no such quantity. Steady cases only: a transient has no "final" temperature of this kind (see NOT_COVERED).

import type { NormalizedCase } from "./validate";

export const FUEL_TEMPERATURE_SCHEMA = "feed.fuel-temperature/0.1";
/** The series: the volume-mean fuel temperature of every slice, against z. */
export const FUEL_MEAN_SERIES = "temperature_fuel_mean_by_slice";
/** Two scalar summaries of the series (an oracle entry holds one number): its largest and its smallest value. */
export const FUEL_MEAN_MAX = "temperature_fuel_mean_slice_max";
export const FUEL_MEAN_MIN = "temperature_fuel_mean_slice_min";
/** One number for the whole result: the volume-mean fuel temperature over all its slices (the form a code with ONE temperature per material takes, as OpenMC Studio does). */
export const FUEL_MEAN_ALL = "temperature_fuel_mean";

export const FUEL_MEAN_MEANING =
  "The volume-mean temperature of the fuel (the pellet) in the slice: the sum over the slice's fuel cells of the cell-centre temperature of the solver times the cell's volume (the annulus the cell fills for a pin, its width for a plate), over the slice's fuel volume. A mean of the solver's own cell-centre values, absolute (kelvin, not a rise above the coolant). It is NOT a cross-section-weighted (effective, Doppler) temperature: a receiving code that wants that says so and takes it from the radial profile. Steady state: the value of the solver's final, converged state.";

export const FUEL_TEMPERATURE_NOT_COVERED = [
  "A transient: no fuel temperature of this kind is declared for a pulse or a loss of cooling (a loop is steady-state first).",
  "A time series of the slice temperature: one value per slice, the steady state.",
  "A particle, a compact or a pebble (different results).",
  "A plain one-slice pin whose heat rate was not set by a heating transfer: it has no axial position.",
  "A centreline temperature: the solver's innermost cell centre is a cell width from the axis, so it is not the centreline; the hottest cell centre of each slice is `temperature_peak_by_slice` for a stack, `temperature_peak` for one slice.",
  "A temperature averaged over the fuel by a neutron cross-section or flux weight.",
];

/** What `describe` reports for this result (the SEED adapter reads it). */
export const DESCRIBE_RESULT_QUANTITIES = {
  schema: FUEL_TEMPERATURE_SCHEMA,
  quantities: [
    {
      name: FUEL_MEAN_SERIES,
      kind: "series",
      axis: { name: "z", unit: "m", coordinates: "the bounds of each slice, `slices[k].zMin` and `slices[k].zMax`; origin and frame in `axis.origin` of the result record" },
      unit: "K",
      dimension: "temperature",
      normalization: "none",
      state: "steady-state",
      final: "the converged state the solver stopped at (one value per slice)",
      meaning: FUEL_MEAN_MEANING,
      presentIn: "results.json, field `fuelTemperature`, for a steady axial stack, and for a steady one-slice case whose heat rate was set by a heating transfer",
    },
    { name: FUEL_MEAN_MAX, kind: "scalar", unit: "K", dimension: "temperature", normalization: "none", meaning: "The largest value of the series: the hottest slice's volume-mean fuel temperature." },
    { name: FUEL_MEAN_MIN, kind: "scalar", unit: "K", dimension: "temperature", normalization: "none", meaning: "The smallest value of the series: the coolest slice's volume-mean fuel temperature." },
    {
      name: FUEL_MEAN_ALL,
      kind: "scalar",
      unit: "K",
      dimension: "temperature",
      normalization: "none",
      meaning: "The volume-mean fuel temperature over ALL the slices of the result: the mean of the slices' volume means weighted by slice length (the fuel cross-section is the same at every height, so this is the volume mean of the whole heated fuel). Absolute, in kelvin, and not an effective (Doppler) temperature. For a one-slice result it is that slice's value, not the pin's. The form a receiving code with one temperature per material takes.",
    },
  ],
  notCovered: FUEL_TEMPERATURE_NOT_COVERED,
};

export interface FuelTemperatureSlice {
  index: number;
  /** Lower and upper bound of the slice on the axis (m). */
  zMin: number;
  zMax: number;
  /** The volume-mean fuel temperature (K). */
  volumeMean: number;
}

export interface FuelTemperatureRecord {
  schema: typeof FUEL_TEMPERATURE_SCHEMA;
  quantity: typeof FUEL_MEAN_SERIES;
  unit: "K";
  dimension: "temperature";
  normalization: "none";
  axis: { name: "z"; unit: "m"; origin: string; frame: string | null };
  state: "steady-state";
  final: string;
  /** The pin the slices belong to (metres): the geometry of every slice. */
  geometry: { kind: "pin" | "plate"; fuelRadius: number; fuelInnerRadius: number; claddingInnerRadius: number; claddingOuterRadius: number; fuelCells: number; heatedLength: number | null };
  slices: FuelTemperatureSlice[];
  /** The two scalar summaries of the series. */
  scalars: { [FUEL_MEAN_MAX]: { value: number; slice: number }; [FUEL_MEAN_MIN]: { value: number; slice: number }; [FUEL_MEAN_ALL]: { value: number } };
  meaning: string;
  notCovered: string[];
}

/**
 * The volume-mean of the fuel cells' temperatures, inner to outer: equal-width cells between the hole (or the axis) and the fuel's outer radius, so a pin weighs a cell by the
 * annulus it fills (r1^2 - r0^2), a plate by its width. Throws for a count that is not the case's.
 */
export function fuelVolumeMean(c: NormalizedCase, fuelT: number[]): number {
  const n = c.mesh.fuelCells;
  if (fuelT.length !== n) throw new RangeError(`the fuel has ${n} cells, ${fuelT.length} temperatures were given`);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const r0 = c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * i) / n;
    const r1 = c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * (i + 1)) / n;
    const w = c.plate ? r1 - r0 : r1 * r1 - r0 * r0;
    num += w * fuelT[i]!;
    den += w;
  }
  return num / den;
}

/**
 * The record of a steady case: `fuelBySlice[k]` are the fuel cell temperatures of slice k (inner to outer). Undefined when the case has no position for its slices (a transient, or a
 * one-slice case that no heating transfer made).
 */
export function fuelTemperatureRecord(c: NormalizedCase, fuelBySlice: number[][]): FuelTemperatureRecord | undefined {
  if (c.transient) return undefined;
  let slices: { zMin: number; zMax: number }[];
  let axis: FuelTemperatureRecord["axis"];
  let heatedLength: number | null = null;
  if (c.axial) {
    const N = c.axial.slices;
    if (fuelBySlice.length !== N) throw new RangeError(`the stack has ${N} slices, ${fuelBySlice.length} were given`);
    const h = c.axial.length / N;
    slices = Array.from({ length: N }, (_, k) => ({ zMin: k * h, zMax: (k + 1) * h }));
    heatedLength = c.axial.length;
    axis = { name: "z", unit: "m", origin: "z = 0 at the bottom of the heated length of the pin (FEED's own axis, positive upward); slice k spans k h to (k + 1) h for h = length / slices", frame: null };
  } else if (c.heatingSlice) {
    if (fuelBySlice.length !== 1) throw new RangeError(`a one-slice case has one slice, ${fuelBySlice.length} were given`);
    slices = [{ zMin: c.heatingSlice.z.min, zMax: c.heatingSlice.z.max }];
    axis = {
      name: "z",
      unit: "m",
      origin: `the source table's own coordinate frame${c.heatingSlice.frame ? " ('" + c.heatingSlice.frame + "')" : ""}: FEED applies no transform to the slice the heating was transferred for (slice '${c.heatingSlice.id}' of pin '${c.heatingSlice.pin}')`,
      frame: c.heatingSlice.frame || null,
    };
  } else return undefined;
  const out: FuelTemperatureSlice[] = slices.map((s, k) => ({ index: k, zMin: s.zMin, zMax: s.zMax, volumeMean: fuelVolumeMean(c, fuelBySlice[k]!) }));
  let hot = 0;
  let cold = 0;
  out.forEach((s, k) => {
    if (s.volumeMean > out[hot]!.volumeMean) hot = k;
    if (s.volumeMean < out[cold]!.volumeMean) cold = k;
  });
  const length = out.reduce((x, s) => x + (s.zMax - s.zMin), 0);
  const all = out.reduce((x, s) => x + s.volumeMean * (s.zMax - s.zMin), 0) / length;
  for (const s of out) if (!Number.isFinite(s.volumeMean) || !(s.volumeMean > 0)) throw new RangeError(`slice ${s.index} has a fuel temperature that is not a positive finite number`);
  return {
    schema: FUEL_TEMPERATURE_SCHEMA,
    quantity: FUEL_MEAN_SERIES,
    unit: "K",
    dimension: "temperature",
    normalization: "none",
    axis,
    state: "steady-state",
    final: "the converged state the solver stopped at (a result of a run that did not converge is never produced): one value per slice, not a time series",
    geometry: {
      kind: c.plate ? "plate" : "pin",
      fuelRadius: c.fuelRadius,
      fuelInnerRadius: c.fuelInnerRadius,
      claddingInnerRadius: c.claddingInnerRadius,
      claddingOuterRadius: c.claddingOuterRadius,
      fuelCells: c.mesh.fuelCells,
      heatedLength,
    },
    slices: out,
    scalars: { [FUEL_MEAN_MAX]: { value: out[hot]!.volumeMean, slice: hot }, [FUEL_MEAN_MIN]: { value: out[cold]!.volumeMean, slice: cold }, [FUEL_MEAN_ALL]: { value: all } },
    meaning: FUEL_MEAN_MEANING,
    notCovered: FUEL_TEMPERATURE_NOT_COVERED,
  };
}
