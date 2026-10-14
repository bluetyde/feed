// The axial stack of plan 12 (docs/plans/12-axial-stack-and-plate.md): a pin as N radial slices along its height, each with its own heat rate and coolant.
// This file holds what the case says (parsed, in SI), what each slice is given (`sliceLoads`), and the estimate of the axial conduction that the solver includes and the
// one-dimensional independent solutions do not (`axialConductionEstimate`, calibrated on docs/spike/axial-plate-probe.md).

import { evaluate, lawOf } from "./conductivity";
import { quickLook } from "./quickLook";
import type { Dimension } from "./units";
import type { NormalizedCase } from "./validate";

export const AXIAL_SLICES_MIN = 3;
export const AXIAL_SLICES_MAX = 50;
export const AXIAL_POINTS_MAX = 200;
export const AXIAL_LENGTH_MIN = 1e-3;
export const AXIAL_LENGTH_MAX = 20;
/** The film coefficient and temperature bounds of a boundary table, the same as a boundary history's (plan 11). */
export const AXIAL_HTC_MIN = 1e-3;
export const AXIAL_HTC_MAX = 1e9;
export const AXIAL_TEMPERATURE_MAX = 1e4;
/** A neighbouring pair of slices whose heat rates differ by more than this fraction of the largest slice's is named in a warning (a smooth cosine over 8 or more slices stays under it). */
export const AXIAL_STEP_WARNING = 0.4;
/** The axial conduction estimate (relative to the largest rise) above which a warning is raised. */
export const AXIAL_CONDUCTION_WARNING = 0.02;

export type AxialShape = { kind: "flat" } | { kind: "cosine" } | { kind: "table"; positions: number[]; relative: number[] };
export type AxialBoundary =
  | { kind: "convective"; heights: number[]; bulkTemperature: number[]; heatTransferCoefficient: number[] }
  | { kind: "surface-temperature"; heights: number[]; surfaceTemperature: number[] };

/** The stack as the validator hands it on (SI): the heated length (m), the slices, the shape of the power along the height and, optionally, the coolant along the height. */
export interface AxialSpec {
  length: number;
  slices: number;
  shape: AxialShape;
  /** Absent: the case's own boundary holds for every slice. */
  boundary?: AxialBoundary;
}

const KEYS = ["length", "slices", "powerShape", "boundary"];
const SHAPE_KEYS = { flat: ["kind"], cosine: ["kind"], table: ["kind", "points"] } as const;
type ErrFn = (code: string, field: string, message: string, extra?: Record<string, unknown>) => void;
type QtyFn = (value: unknown, dim: Dimension, field: string) => number | undefined;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Read the `axial` section. `boundaryKind` is the form of the case's own boundary: a boundary table must be in the same form. Every refusal has the code E_AXIAL (or E_UNITS for a unit
 * problem), names the field and says what to change.
 */
export function parseAxial(raw: unknown, boundaryKind: "convective" | "surface-temperature" | undefined, err: ErrFn, qty: QtyFn): AxialSpec | undefined {
  const bad = (field: string, message: string) => err("E_AXIAL", "/axial" + field, message);
  if (!isObject(raw)) {
    bad("", "the axial section is an object with a length, a number of slices, a power shape and, optionally, a coolant table");
    return undefined;
  }
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) bad("/" + k, "unknown key '" + k + "' (the axial section has " + KEYS.join(", ") + ")");
  let ok = true;
  const lengthRaw = raw.length;
  let length: number | undefined;
  if (lengthRaw === undefined) {
    bad("/length", "missing: the heated length of the pin (the height the slices divide)");
    ok = false;
  } else {
    length = qty(lengthRaw, "length", "/axial/length");
    if (length === undefined) ok = false;
    else if (!(length >= AXIAL_LENGTH_MIN && length <= AXIAL_LENGTH_MAX)) {
      bad("/length", "the heated length " + length + " m is outside " + AXIAL_LENGTH_MIN + " to " + AXIAL_LENGTH_MAX + " m; check the units");
      ok = false;
    }
  }
  let slices: number | undefined;
  if (raw.slices === undefined) {
    bad("/slices", "missing: the number of slices along the height");
    ok = false;
  } else if (typeof raw.slices !== "number" || !Number.isInteger(raw.slices)) {
    bad("/slices", "the number of slices is a whole number");
    ok = false;
  } else if (raw.slices < AXIAL_SLICES_MIN || raw.slices > AXIAL_SLICES_MAX) {
    bad("/slices", "the number of slices is " + raw.slices + "; it must be from " + AXIAL_SLICES_MIN + " to " + AXIAL_SLICES_MAX);
    ok = false;
  } else slices = raw.slices;

  const shape = parseShape(raw.powerShape, length, bad, qty);
  if (shape === undefined) ok = false;

  let boundary: AxialBoundary | undefined;
  if (raw.boundary !== undefined) {
    boundary = parseBoundaryTable(raw.boundary, boundaryKind, length, bad, qty);
    if (boundary === undefined) ok = false;
  }
  if (!ok || length === undefined || slices === undefined || shape === undefined) return undefined;
  return { length, slices, shape, ...(boundary ? { boundary } : {}) };
}

function parseShape(raw: unknown, length: number | undefined, bad: (field: string, message: string) => void, qty: QtyFn): AxialShape | undefined {
  if (raw === undefined) {
    bad("/powerShape", "missing: the shape of the power along the height ({\"kind\": \"flat\"}, {\"kind\": \"cosine\"} or a table of points)");
    return undefined;
  }
  if (!isObject(raw) || typeof raw.kind !== "string" || !(raw.kind in SHAPE_KEYS)) {
    bad("/powerShape", "the power shape is an object whose kind is flat, cosine or table");
    return undefined;
  }
  const kind = raw.kind as keyof typeof SHAPE_KEYS;
  let fine = true;
  for (const k of Object.keys(raw)) if (!(SHAPE_KEYS[kind] as readonly string[]).includes(k)) {
    bad("/powerShape/" + k, "unknown key '" + k + "' for a " + kind + " shape (it has " + SHAPE_KEYS[kind].join(", ") + ")");
    fine = false;
  }
  if (kind !== "table") return fine ? { kind } : undefined;
  const pts = raw.points;
  if (!Array.isArray(pts) || pts.length < 2) {
    bad("/powerShape/points", "a table shape needs a list of at least two points {position, relativePower}");
    return undefined;
  }
  if (pts.length > AXIAL_POINTS_MAX) {
    bad("/powerShape/points", "a table shape has at most " + AXIAL_POINTS_MAX + " points");
    return undefined;
  }
  const positions: number[] = [];
  const relative: number[] = [];
  pts.forEach((p, i) => {
    const f = "/powerShape/points/" + i;
    if (!isObject(p)) {
      bad(f, "a point is {position, relativePower}");
      fine = false;
      return;
    }
    for (const k of Object.keys(p)) if (k !== "position" && k !== "relativePower") {
      bad(f + "/" + k, "unknown key '" + k + "' (a point has position and relativePower)");
      fine = false;
    }
    const z = qty(p.position, "length", "/axial" + f + "/position");
    const r = qty(p.relativePower, "fraction", "/axial" + f + "/relativePower");
    if (z === undefined || r === undefined) {
      fine = false;
      return;
    }
    if (r < 0) {
      bad(f + "/relativePower", "the relative power cannot be negative");
      fine = false;
    }
    positions.push(z);
    relative.push(r);
  });
  if (!fine) return undefined;
  if (length !== undefined) {
    if (Math.abs(positions[0]!) > 1e-12 * length) {
      bad("/powerShape/points/0/position", "the table starts at the bottom of the pin: the first position is 0");
      return undefined;
    }
    if (Math.abs(positions[positions.length - 1]! - length) > 1e-9 * length) {
      bad("/powerShape/points/" + (pts.length - 1) + "/position", "the table ends at the top of the heated length (" + length + " m): the last position is the length");
      return undefined;
    }
  }
  for (let i = 1; i < positions.length; i++) if (!(positions[i]! > positions[i - 1]!)) {
    bad("/powerShape/points/" + i + "/position", "positions must increase strictly");
    return undefined;
  }
  if (!(Math.max(...relative) > 0)) {
    bad("/powerShape/points", "every relative power is zero: the pin would make no heat");
    return undefined;
  }
  return { kind: "table", positions, relative };
}

function parseBoundaryTable(raw: unknown, boundaryKind: "convective" | "surface-temperature" | undefined, length: number | undefined, bad: (field: string, message: string) => void, qty: QtyFn): AxialBoundary | undefined {
  if (!Array.isArray(raw) || raw.length < 2) {
    bad("/boundary", "the coolant table is a list of at least two points {height, bulkTemperature, heatTransferCoefficient} (or {height, surfaceTemperature} for a prescribed wall)");
    return undefined;
  }
  if (raw.length > AXIAL_POINTS_MAX) {
    bad("/boundary", "the coolant table has at most " + AXIAL_POINTS_MAX + " points");
    return undefined;
  }
  const heights: number[] = [];
  const Tb: number[] = [];
  const h: number[] = [];
  const Ts: number[] = [];
  let kind: "convective" | "surface-temperature" | undefined;
  let fine = true;
  raw.forEach((p, i) => {
    const f = "/boundary/" + i;
    if (!isObject(p)) {
      bad(f, "a point is {height, bulkTemperature, heatTransferCoefficient} or {height, surfaceTemperature}");
      fine = false;
      return;
    }
    const keys = Object.keys(p);
    const conv = keys.includes("bulkTemperature") || keys.includes("heatTransferCoefficient");
    const wall = keys.includes("surfaceTemperature");
    if (conv && wall) {
      bad(f, "a point gives the boundary in two forms; choose bulk temperature with a heat-transfer coefficient, or the surface temperature");
      fine = false;
      return;
    }
    if (!conv && !wall) {
      bad(f, "a point needs bulkTemperature and heatTransferCoefficient, or surfaceTemperature");
      fine = false;
      return;
    }
    const pk = conv ? "convective" : "surface-temperature";
    if (kind === undefined) kind = pk;
    else if (kind !== pk) {
      bad(f, "the points of a coolant table are all of one form; this one is " + pk + " and the first was " + kind);
      fine = false;
      return;
    }
    const allowed = conv ? ["height", "bulkTemperature", "heatTransferCoefficient"] : ["height", "surfaceTemperature"];
    for (const k of keys) if (!allowed.includes(k)) {
      bad(f + "/" + k, "unknown key '" + k + "' (a " + pk + " point has " + allowed.join(", ") + ")");
      fine = false;
    }
    if (conv && (p.bulkTemperature === undefined || p.heatTransferCoefficient === undefined)) {
      bad(f, "bulk temperature alone is not a boundary condition; a convective point needs both bulkTemperature and heatTransferCoefficient");
      fine = false;
      return;
    }
    const z = qty(p.height, "length", "/axial" + f + "/height");
    if (z === undefined) fine = false;
    else heights.push(z);
    if (conv) {
      const t = qty(p.bulkTemperature, "temperature", "/axial" + f + "/bulkTemperature");
      const c = qty(p.heatTransferCoefficient, "htc", "/axial" + f + "/heatTransferCoefficient");
      if (t === undefined || c === undefined) {
        fine = false;
        return;
      }
      if (!(t > 0 && t <= AXIAL_TEMPERATURE_MAX)) {
        bad(f + "/bulkTemperature", "the bulk temperature is from 0 to " + AXIAL_TEMPERATURE_MAX + " K");
        fine = false;
      }
      if (!(c >= AXIAL_HTC_MIN && c <= AXIAL_HTC_MAX)) {
        bad(f + "/heatTransferCoefficient", "the heat-transfer coefficient is from " + AXIAL_HTC_MIN + " to " + AXIAL_HTC_MAX + " W/m2/K (a lost coolant is a small coefficient, not zero)");
        fine = false;
      }
      Tb.push(t);
      h.push(c);
    } else {
      const t = qty(p.surfaceTemperature, "temperature", "/axial" + f + "/surfaceTemperature");
      if (t === undefined) {
        fine = false;
        return;
      }
      if (!(t > 0 && t <= AXIAL_TEMPERATURE_MAX)) {
        bad(f + "/surfaceTemperature", "the surface temperature is from 0 to " + AXIAL_TEMPERATURE_MAX + " K");
        fine = false;
      }
      Ts.push(t);
    }
  });
  if (!fine || kind === undefined) return undefined;
  if (boundaryKind !== undefined && kind !== boundaryKind) {
    bad("/boundary", "the coolant table is in the " + kind + " form but the case's own boundary is " + boundaryKind + ": use the same form in both");
    return undefined;
  }
  if (length !== undefined) {
    if (Math.abs(heights[0]!) > 1e-12 * length) {
      bad("/boundary/0/height", "the coolant table starts at the bottom of the pin: the first height is 0");
      return undefined;
    }
    if (Math.abs(heights[heights.length - 1]! - length) > 1e-9 * length) {
      bad("/boundary/" + (heights.length - 1) + "/height", "the coolant table ends at the top of the heated length (" + length + " m): the last height is the length");
      return undefined;
    }
  }
  for (let i = 1; i < heights.length; i++) if (!(heights[i]! > heights[i - 1]!)) {
    bad("/boundary/" + i + "/height", "heights must increase strictly");
    return undefined;
  }
  return kind === "convective" ? { kind, heights, bulkTemperature: Tb, heatTransferCoefficient: h } : { kind, heights, surfaceTemperature: Ts };
}

/** Linear interpolation in a table, held at the ends. */
export function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]!) return ys[i - 1]! + ((ys[i]! - ys[i - 1]!) * (x - xs[i - 1]!)) / (xs[i]! - xs[i - 1]!);
  return ys[ys.length - 1]!;
}

/** The number of points the cosine is written with: a fine table so that the linear interpolation of the writer is the cosine to better than 1e-3. */
export const COSINE_POINTS = 41;

/** The shape as a table over the heated length (positions in m, relative values), whatever its kind. A flat shape is two points. */
export function shapeTable(a: AxialSpec): { positions: number[]; relative: number[] } {
  if (a.shape.kind === "table") return { positions: a.shape.positions, relative: a.shape.relative };
  if (a.shape.kind === "flat") return { positions: [0, a.length], relative: [1, 1] };
  const positions: number[] = [];
  const relative: number[] = [];
  for (let i = 0; i < COSINE_POINTS; i++) {
    const x = i / (COSINE_POINTS - 1);
    positions.push(x * a.length);
    relative.push(Math.max(0, Math.cos(Math.PI * (x - 0.5))));
  }
  return { positions, relative };
}

/** The table normalised so that its trapezoid integral over the fractional height 0 to 1 is exactly 1: what OFFBEAT's constantTabulated axial profile demands (to 1e-4); the case's heat rate is then the average over the length. */
export function normalizedShape(a: AxialSpec): { locations: number[]; data: number[] } {
  const t = shapeTable(a);
  const locations = t.positions.map((z) => z / a.length);
  let integral = 0;
  for (let i = 1; i < locations.length; i++) integral += 0.5 * (t.relative[i]! + t.relative[i - 1]!) * (locations[i]! - locations[i - 1]!);
  return { locations, data: t.relative.map((r) => r / integral) };
}

/** What one slice is given: its centre height (m), its heat rate (W/m, the average heat rate times the normalised shape interpolated at the centre, the way OFFBEAT samples it) and its coolant. */
export interface SliceLoad {
  index: number;
  height: number;
  /** The shape at the slice's centre relative to the average (the normalised table interpolated there): the factor on every heat rate of the case. */
  factor: number;
  linearHeatRate: number;
  boundary: NormalizedCase["boundary"];
}

export function sliceLoads(c: NormalizedCase): SliceLoad[] {
  const a = c.axial;
  if (!a) return [];
  const shape = normalizedShape(a);
  const out: SliceLoad[] = [];
  for (let k = 0; k < a.slices; k++) {
    const z = ((k + 0.5) * a.length) / a.slices;
    const factor = interpolate(shape.locations, shape.data, z / a.length);
    const q = c.qPrime * factor;
    let boundary: NormalizedCase["boundary"] = c.boundary;
    const b = a.boundary;
    if (b) boundary = b.kind === "convective" ? { kind: "convective", bulkTemperature: interpolate(b.heights, b.bulkTemperature, z), heatTransferCoefficient: interpolate(b.heights, b.heatTransferCoefficient, z) } : { kind: "surface-temperature", surfaceTemperature: interpolate(b.heights, b.surfaceTemperature, z) };
    out.push({ index: k, height: z, factor, linearHeatRate: q, boundary });
  }
  return out;
}

/** The case of one slice: the same pin with the slice's heat rate and coolant, and no axial section (what a one-dimensional solution is given). */
export function sliceCase(c: NormalizedCase, load: SliceLoad): NormalizedCase {
  const { axial: _axial, ...rest } = c;
  const t = c.transient;
  // a transient stack: the slice's power history is the case's (average) history times the slice's factor, and a steady start is at the slice's own heat rate
  const transient = t ? { ...t, linearHeatRate: t.linearHeatRate.map((x) => x * load.factor), initial: t.initial.kind === "steady" ? { kind: "steady" as const, linearHeatRate: t.initial.linearHeatRate * load.factor } : t.initial } : undefined;
  return { ...rest, qPrime: load.linearHeatRate, boundary: load.boundary, ...(transient ? { transient } : {}) };
}

/** The slice with the largest heat rate: the one a single-slice preview or an end time is judged on. */
export function hottestLoad(c: NormalizedCase): SliceLoad {
  return sliceLoads(c).reduce((m, l) => (l.linearHeatRate > m.linearHeatRate ? l : m));
}

export interface AxialEstimate {
  /** The estimate of the largest temperature change the axial conduction makes, as a fraction of the largest rise of any slice above its coolant. */
  fraction: number;
  /** lambda squared (m2): the axial conduction of the solids over the conductance from them to the coolant. */
  lambdaSquared: number;
  /** The largest second difference of the shape across the slices, per unit length squared, relative to the largest shape value (1/m2). */
  curvature: number;
}

/**
 * An estimate of the axial conduction that OFFBEAT's stack includes and a one-dimensional solution of each slice does not. A fin model of the pin: the solids carry heat along the pin with
 * the conductance k A (the sum over fuel and cladding at the largest conductivity they reach) and lose it radially with the conductance per length U to the coolant (the largest slice's
 * heat rate over its centre-to-coolant rise, a conservative figure); the correction to a slice's temperature is then about lambda^2 T'' with lambda^2 = k A / U and T'' the curvature of
 * the no-conduction profile, that is of the shape. The estimate is that correction as a fraction of the largest rise: lambda^2 x (largest second difference of the shape) / (largest shape value).
 * For the cosine this is lambda^2 (pi / L)^2. Calibrated on the A0 probe (docs/spike/axial-plate-probe.md): within 20 % of the measured end-layer change and 3 times the peak-layer
 * change at 0.19, 0.381 and 0.762 m, so it is used with a factor 3 as a tolerance (A2).
 */
export function axialConductionEstimate(c: NormalizedCase): AxialEstimate | undefined {
  const a = c.axial;
  if (!a) return undefined;
  const loads = sliceLoads(c);
  // the hottest slice of the one-dimensional solutions: its heat rate, its rise from the coolant and the mean temperatures of the two solids
  let hottest: { linearHeatRate: number; centreRise: number; fuelMeanT: number; claddingMeanT: number } | undefined;
  let bestT = -Infinity;
  for (const l of loads) {
    const t = quickLook(sliceCase(c, l)).temperatures;
    if (t.centreT > bestT) {
      bestT = t.centreT;
      const ref = l.boundary.kind === "convective" ? l.boundary.bulkTemperature : l.boundary.surfaceTemperature;
      hottest = { linearHeatRate: l.linearHeatRate, centreRise: t.centreT - ref, fuelMeanT: 0.5 * (t.centreT + t.fuelSurfaceT), claddingMeanT: 0.5 * (t.claddingInnerT + t.claddingOuterT) };
    }
  }
  if (!hottest || !(hottest.centreRise > 0)) return undefined;
  const kmax = (k: NormalizedCase["fuelConductivity"], lo: number, hi: number) => {
    const law = lawOf(k);
    let m = 0;
    for (let i = 0; i <= 8; i++) m = Math.max(m, evaluate(law, lo + ((hi - lo) * i) / 8));
    return m;
  };
  const Af = Math.PI * (c.fuelRadius ** 2 - c.fuelInnerRadius ** 2);
  const Ac = Math.PI * (c.claddingOuterRadius ** 2 - c.claddingInnerRadius ** 2);
  const span = (m: number) => [Math.max(1, m - 0.5 * hottest.centreRise), m + 0.5 * hottest.centreRise] as const;
  const [fl, fh] = span(hottest.fuelMeanT);
  const [cl, ch] = span(hottest.claddingMeanT);
  const kA = kmax(c.fuelConductivity, fl, fh) * Af + kmax(c.claddingConductivity, cl, ch) * Ac;
  const U = hottest.linearHeatRate / hottest.centreRise;
  const lambdaSquared = kA / U;
  // curvature of the shape across the slices: second differences of the values at the slice centres
  const v = loads.map((l) => l.linearHeatRate / c.qPrime);
  const h = a.length / a.slices;
  const top = Math.max(...v);
  let curvature = 0;
  // interior slices only: at an end the missing neighbour has no value to difference with (a ghost slice equal to the end slice would count the slope of the shape as curvature and
  // over-read the cosine's ends three-fold; the measured end change is covered by the interior value, see the calibration test). The boundary layer an end slope makes at an
  // adiabatic end is not in this estimate; it was measured for the cosine only (A2 measures a table shape with steep ends before trusting it there).
  for (let i = 1; i < v.length - 1; i++) curvature = Math.max(curvature, Math.abs(v[i + 1]! - 2 * v[i]! + v[i - 1]!) / (h * h) / top);
  // the second differences of a coarse stack under-read a sharp shape; the larger of this and the cosine value for the same length is not used, the validator warns about steps instead
  return { fraction: lambdaSquared * curvature, lambdaSquared, curvature };
}


export interface SliceSummary {
  index: number;
  height: number;
  linearHeatRate: number;
  boundary: NormalizedCase["boundary"];
  /** The one-dimensional closed-form temperatures of the slice (K), the quick look of the editor. */
  centreT: number;
  fuelSurfaceT: number;
  claddingOuterT: number;
  verdict: "in-domain" | "out-of-domain";
}

export interface AxialSummary {
  slices: SliceSummary[];
  /** Index of the slice with the hottest fuel centre. */
  hottest: number;
  /** The heated length (m), the number of slices and the average and largest heat rates (W/m). */
  length: number;
  averageLinearHeatRate: number;
  peakLinearHeatRate: number;
  conduction: AxialEstimate | null;
}

/** The editor's quick look of a stack: the one-dimensional closed form of every slice (no axial conduction), the hottest slice, and the estimate of what the conduction would add. */
export function axialSummary(c: NormalizedCase): AxialSummary | undefined {
  const a = c.axial;
  if (!a) return undefined;
  const loads = sliceLoads(c);
  const slices: SliceSummary[] = loads.map((l) => {
    const look = quickLook(sliceCase(c, l));
    return { index: l.index, height: l.height, linearHeatRate: l.linearHeatRate, boundary: l.boundary, centreT: look.temperatures.centreT, fuelSurfaceT: look.temperatures.fuelSurfaceT, claddingOuterT: look.temperatures.claddingOuterT, verdict: look.verdict };
  });
  let hottest = 0;
  slices.forEach((s, i) => {
    if (s.centreT > slices[hottest]!.centreT) hottest = i;
  });
  let conduction: AxialEstimate | null = null;
  try {
    conduction = axialConductionEstimate(c) ?? null;
  } catch {
    conduction = null;
  }
  return { slices, hottest, length: a.length, averageLinearHeatRate: c.qPrime, peakLinearHeatRate: Math.max(...loads.map((l) => l.linearHeatRate)), conduction };
}
