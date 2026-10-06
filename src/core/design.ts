// The pin as a designer states it (docs/pin-design.md): diameters and thicknesses, not the radii the case stores. `designOf` reads them off a case;
// `applyDesign` changes one of them and returns the geometry that results, in the units the case already uses. The case itself still holds radii: this is
// a way of entering and reading them, with the derived areas, and nothing about it reaches the solver.
//
// What stays put when one dimension changes (the rule a designer expects):
//   fuelDiameter           the gap and the cladding wall stay, so the cladding moves with the fuel
//   gap                    the cladding wall stays, so the cladding outer surface moves with its inner one
//   claddingWall           the cladding inner surface stays; the outer one moves
//   claddingOuterDiameter  the inner surface stays; the wall changes
//   fuelInnerDiameter      the central hole (0 is solid fuel); nothing else moves
// The result is not judged here beyond being finite and the right sign: the case validator refuses radii that are out of order (E_GEOMETRY).

import { SI_UNIT, fromSI, toSI } from "./units";
import { NormalizedCase } from "./validate";

export type DesignField = "fuelDiameter" | "fuelInnerDiameter" | "gap" | "claddingWall" | "claddingOuterDiameter";
export const DESIGN_FIELDS: readonly DesignField[] = ["fuelDiameter", "fuelInnerDiameter", "gap", "claddingWall", "claddingOuterDiameter"];

export interface DesignView {
  /** Metres. */
  fuelDiameter: number;
  /** Metres; 0 for solid fuel. */
  fuelInnerDiameter: number;
  /** The radial gap between the fuel and the cladding, as cold as the case gives it. */
  gap: number;
  claddingWall: number;
  claddingInnerDiameter: number;
  claddingOuterDiameter: number;
  /** Square metres (= cubic metres per metre of pin): the fuel's cross-section (an annulus with a central hole) and the cladding's. */
  fuelArea: number;
  claddingArea: number;
  /** Cladding wall over its outer diameter. */
  wallToDiameter: number;
  /** Gap over the fuel diameter. */
  gapToDiameter: number;
}

export function designOf(n: NormalizedCase): DesignView {
  const Rf = n.fuelRadius;
  const Ri = n.fuelInnerRadius;
  const Rci = n.claddingInnerRadius;
  const Rco = n.claddingOuterRadius;
  return {
    fuelDiameter: 2 * Rf,
    fuelInnerDiameter: 2 * Ri,
    gap: Rci - Rf,
    claddingWall: Rco - Rci,
    claddingInnerDiameter: 2 * Rci,
    claddingOuterDiameter: 2 * Rco,
    fuelArea: Math.PI * (Rf * Rf - Ri * Ri),
    claddingArea: Math.PI * (Rco * Rco - Rci * Rci),
    wallToDiameter: (Rco - Rci) / (2 * Rco),
    gapToDiameter: (Rci - Rf) / (2 * Rf),
  };
}

export interface DesignIssue {
  code: string;
  field: string;
  message: string;
}
export type DesignResult = { ok: true; geometry: Record<string, { value: number; unit: string }> } | { ok: false; errors: DesignIssue[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const fail = (code: string, field: string, message: string): DesignResult => ({ ok: false, errors: [{ code, field, message }] });

/** Change one design dimension of a case's `geometry` object. The input is not modified; the output has the same keys in the same units. */
export function applyDesign(geometry: unknown, change: { field?: unknown; value?: unknown }): DesignResult {
  if (!isObj(geometry)) return fail("E_SCHEMA_INVALID", "/geometry", "the geometry is an object with the fuel and cladding radii");
  const field = change.field as DesignField;
  if (!DESIGN_FIELDS.includes(field)) return fail("E_SCHEMA_INVALID", "/field", `the design field is one of ${DESIGN_FIELDS.join(", ")}`);
  const read = (key: string): number | undefined => {
    const r = toSI(geometry[key], "length");
    return r.ok ? r.si : undefined;
  };
  const Rf = read("fuelRadius");
  const Rci = read("claddingInnerRadius");
  const Rco = read("claddingOuterRadius");
  if (Rf === undefined || Rci === undefined || Rco === undefined) return fail("E_UNITS", "/geometry", "the geometry's radii must each be {value, unit} lengths before a design dimension can be changed");
  const v = toSI(change.value, "length");
  if (!v.ok) return fail("E_UNITS", "/value", v.reason);
  const x = v.si;
  const gap = Rci - Rf;
  const wall = Rco - Rci;
  const next: Record<string, number> = {};
  switch (field) {
    case "fuelDiameter":
      if (!(x > 0)) return fail("E_OUT_OF_RANGE", "/value", "the fuel diameter must be positive");
      next.fuelRadius = x / 2;
      next.claddingInnerRadius = x / 2 + gap;
      next.claddingOuterRadius = x / 2 + gap + wall;
      break;
    case "fuelInnerDiameter":
      if (!(x >= 0)) return fail("E_OUT_OF_RANGE", "/value", "the central hole's diameter cannot be negative (0 is solid fuel)");
      next.fuelInnerRadius = x / 2;
      break;
    case "gap":
      if (!(x >= 0)) return fail("E_OUT_OF_RANGE", "/value", "the gap cannot be negative");
      next.claddingInnerRadius = Rf + x;
      next.claddingOuterRadius = Rf + x + wall;
      break;
    case "claddingWall":
      if (!(x > 0)) return fail("E_OUT_OF_RANGE", "/value", "the cladding wall must be positive");
      next.claddingOuterRadius = Rci + x;
      break;
    case "claddingOuterDiameter":
      if (!(x > 0)) return fail("E_OUT_OF_RANGE", "/value", "the cladding outer diameter must be positive");
      next.claddingOuterRadius = x / 2;
      break;
  }
  const out = structuredClone(geometry) as Record<string, { value: number; unit: string }>;
  for (const [k, si] of Object.entries(next)) {
    // each radius is written in the unit that radius already had (mm stays mm); a hole that was not there is written in the fuel radius's unit
    const unit = (isObj(geometry[k]) && typeof (geometry[k] as { unit?: unknown }).unit === "string" ? (geometry[k] as { unit: string }).unit : undefined) ?? (geometry.fuelRadius as { unit: string }).unit;
    const value = fromSI(si, unit, "length");
    if (value === undefined) return fail("E_UNITS", "/geometry/" + k, `cannot write ${SI_UNIT.length} into '${unit}'`);
    out[k] = { value, unit };
  }
  return { ok: true, geometry: out };
}
