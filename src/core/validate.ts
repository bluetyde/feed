// Semantic validation of a thermal case, before any run (docs/plans/02-case-and-materials.md).
// Structure comes from schema/case.schema.json; everything else is checked here.
// No expression is evaluated and no default is filled in: a missing datum is a named refusal.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import Ajv2020 from "ajv/dist/2020";
import { Dimension, toSI } from "./units";

export interface Issue {
  code: string;
  severity: "error" | "warning";
  /** JSON pointer into the case document. */
  field: string;
  message: string;
  unit?: string;
  range?: [number, number];
}

export type Conductivity =
  | { kind: "constant"; k: number; referenceTemperature: number }
  | { kind: "linear"; a: number; b: number; range: [number, number] };

export interface NormalizedCase {
  caseId: string;
  qPrime: number;
  fuelRadius: number;
  /** Radius of a central hole whose surface is insulated (TRIGA's zirconium fill rod); 0 for solid fuel. */
  fuelInnerRadius: number;
  claddingInnerRadius: number;
  claddingOuterRadius: number;
  gapConductance: number;
  boundary: { kind: "convective"; bulkTemperature: number; heatTransferCoefficient: number } | { kind: "surface-temperature"; surfaceTemperature: number };
  fuelConductivity: Conductivity;
  claddingConductivity: Conductivity;
  mesh: { fuelCells: number; claddingCells: number };
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Present only when ok. */
  normalized?: NormalizedCase;
}

/** Heat rate above which a warning is raised (W/m). Sanity range, not a limit. */
export const POWER_SANITY_MAX = 60_000;
export const MESH_MINIMUM = { fuelCells: 4, claddingCells: 2 } as const;
/** A 1D pin needs nowhere near this many cells; the cap stops a small request asking for gigabytes of mesh. */
export const MESH_MAXIMUM = { fuelCells: 20000, claddingCells: 10000 } as const;
export const SCHEMA_ID = "feed.case/0.1";

const ajv = new Ajv2020({ strict: true, allErrors: true });
/** Project root: the nearest parent of this file that holds schema/case.schema.json (works from src/ and from dist/). */
export function projectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "schema", "case.schema.json"))) return dir;
    dir = join(dir, "..");
  }
  throw new Error("schema/case.schema.json not found above " + __dirname);
}

const checkSchema = ajv.compile(JSON.parse(readFileSync(join(projectRoot(), "schema", "case.schema.json"), "utf8")));

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateCase(doc: unknown): ValidationResult {
  const issues: Issue[] = [];
  const err = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => issues.push({ code, severity: "error", field, message, ...extra });

  if (!checkSchema(doc)) {
    for (const e of checkSchema.errors ?? []) err("E_SCHEMA_INVALID", e.instancePath || "/", e.message ?? "invalid");
    return finish(issues);
  }
  const c = doc as Record<string, any>;

  /** Read a quantity; on failure record E_UNITS and return undefined. */
  const qty = (value: unknown, dim: Dimension, field: string): number | undefined => {
    const r = toSI(value, dim);
    if (r.ok) return r.si;
    err("E_UNITS", field, r.reason);
    return undefined;
  };
  /** A required positive quantity. */
  const positive = (value: unknown, dim: Dimension, field: string, what: string, unit: string): number | undefined => {
    const v = qty(value, dim, field);
    if (v === undefined) return undefined;
    if (!(v > 0)) {
      err("E_OUT_OF_RANGE", field, what + " must be positive", { unit });
      return undefined;
    }
    return v;
  };

  // Scope of V1
  if (c.assumptions.thermalOnly !== true) err("E_UNSUPPORTED", "/assumptions/thermalOnly", "V1 is thermal-only; mechanics and irradiation are later capabilities");
  if (c.assumptions.steadyState !== true) err("E_UNSUPPORTED", "/assumptions/steadyState", "V1 is steady state; transients are a later capability");
  if (c.assumptions.geometry !== "1D-radial") err("E_UNSUPPORTED", "/assumptions/geometry", "V1 supports geometry '1D-radial' only, got '" + String(c.assumptions.geometry) + "'");
  if (c.power.radialShape !== undefined && c.power.radialShape !== "uniform") err("E_UNSUPPORTED", "/power/radialShape", "V1 supports a uniform radial power shape only");

  // Geometry
  const radius = (value: unknown, field: string, what: string): number | undefined => {
    const v = qty(value, "length", field);
    if (v === undefined) return undefined;
    if (!(v > 0)) {
      err("E_GEOMETRY", field, what + " must be positive", { unit: "m" });
      return undefined;
    }
    return v;
  };
  const Rf = radius(c.geometry.fuelRadius, "/geometry/fuelRadius", "fuel radius");
  const Rci = radius(c.geometry.claddingInnerRadius, "/geometry/claddingInnerRadius", "cladding inner radius");
  const Rco = radius(c.geometry.claddingOuterRadius, "/geometry/claddingOuterRadius", "cladding outer radius");
  // Optional central hole in the fuel. Its surface is treated as insulated (nothing is conducted into whatever fills it).
  let Rfi = 0;
  if ((c.geometry as Record<string, unknown>).fuelInnerRadius !== undefined) {
    const r = qty((c.geometry as Record<string, unknown>).fuelInnerRadius, "length", "/geometry/fuelInnerRadius");
    if (r !== undefined) {
      if (r < 0) err("E_GEOMETRY", "/geometry/fuelInnerRadius", "the central hole radius cannot be negative (use 0 for solid fuel)", { unit: "m" });
      else if (Rf !== undefined && r > 0 && !(r < Rf)) err("E_GEOMETRY", "/geometry/fuelInnerRadius", "the central hole radius must be smaller than the fuel radius", { unit: "m" });
      else if (Rf !== undefined && r > 0.95 * Rf) err("E_GEOMETRY", "/geometry/fuelInnerRadius", "the central hole radius leaves less than 5% of the fuel radius as wall; refused (the cell widths would be unreliable)", { unit: "m" });
      else Rfi = r; // 0 is solid fuel
    }
  }
  if (Rf !== undefined && Rci !== undefined) {
    if (Rci < Rf) err("E_GEOMETRY", "/geometry/claddingInnerRadius", "cladding inner radius is smaller than the fuel radius (fuel overlaps cladding)");
    // Rci === Rf (zero cold gap) is allowed: the explicit gap conductance below is then an effective interface conductance.
    // A closed gap with no explicit conductance is refused by the gap-model check, which is where contact is rejected.
  }
  if (Rci !== undefined && Rco !== undefined && Rco <= Rci) err("E_GEOMETRY", "/geometry/claddingOuterRadius", "cladding outer radius must exceed the inner radius");

  // Power
  const qPrime = positive(c.power.linearHeatRate, "linearPower", "/power/linearHeatRate", "linear heat rate", "W/m");
  if (qPrime !== undefined && qPrime > POWER_SANITY_MAX) {
    issues.push({ code: "W_POWER_RANGE", severity: "warning", field: "/power/linearHeatRate", message: "linear heat rate is above the sanity range (" + POWER_SANITY_MAX + " W/m); kept as given", unit: "W/m", range: [0, POWER_SANITY_MAX] });
  }

  // Gap
  let hGap: number | undefined;
  const gap = c.gap as Record<string, unknown>;
  if (gap.model === "constant-conductance") {
    if (gap.conductance === undefined) err("E_PROP_MISSING", "/gap/conductance", "the constant-conductance gap model needs the gap conductance (W/m2/K)");
    else hGap = positive(gap.conductance, "htc", "/gap/conductance", "gap conductance", "W/m2/K");
    if (typeof gap.source !== "string" || gap.source === "") err("E_PROP_MISSING", "/gap/source", "the gap conductance needs a stated source");
  } else if (gap.model === "closed" || gap.model === "contact") {
    err("E_UNSUPPORTED", "/gap/model", "a closed or contacting gap needs mechanics to know the contact state; V1 requires an explicit gap conductance");
  } else if (gap.model === "gas-gap") {
    err("E_UNSUPPORTED", "/gap/model", "the solver's gas-gap model is planned after V1; use 'constant-conductance'");
  } else {
    err("E_UNSUPPORTED", "/gap/model", "unknown gap model '" + String(gap.model) + "'");
  }

  // Boundary: exactly one complete form
  const b = c.boundary as Record<string, unknown>;
  const hasBulk = b.bulkTemperature !== undefined;
  const hasH = b.heatTransferCoefficient !== undefined;
  const hasSurface = b.surfaceTemperature !== undefined;
  let boundary: NormalizedCase["boundary"] | undefined;
  if ((hasBulk || hasH) && hasSurface) {
    err("E_BOUNDARY_INCOMPLETE", "/boundary", "the coolant boundary is given in two forms; choose either bulk temperature with a heat-transfer coefficient, or a prescribed surface temperature");
  } else if (hasSurface) {
    const ts = positive(b.surfaceTemperature, "temperature", "/boundary/surfaceTemperature", "surface temperature", "K");
    if (ts !== undefined) boundary = { kind: "surface-temperature", surfaceTemperature: ts };
  } else if (hasBulk || hasH) {
    if (!hasH) err("E_BOUNDARY_INCOMPLETE", "/boundary/heatTransferCoefficient", "bulk temperature alone is not a boundary condition; a convective boundary also needs the heat-transfer coefficient", { unit: "W/m2/K" });
    else if (!hasBulk) err("E_BOUNDARY_INCOMPLETE", "/boundary/bulkTemperature", "a heat-transfer coefficient alone is not a boundary condition; a convective boundary also needs the bulk temperature", { unit: "K" });
    else {
      const tb = positive(b.bulkTemperature, "temperature", "/boundary/bulkTemperature", "bulk temperature", "K");
      const h = positive(b.heatTransferCoefficient, "htc", "/boundary/heatTransferCoefficient", "heat-transfer coefficient", "W/m2/K");
      if (tb !== undefined && h !== undefined) boundary = { kind: "convective", bulkTemperature: tb, heatTransferCoefficient: h };
    }
  } else {
    err("E_BOUNDARY_INCOMPLETE", "/boundary", "no coolant boundary given; provide bulk temperature with a heat-transfer coefficient, or a prescribed surface temperature");
  }

  // Materials: a thermal model needs a thermal conductivity set. Composition and density do not satisfy it.
  const fuelK = conductivity(c.materials.fuel, "fuel", err, qty);
  const claddingK = conductivity(c.materials.cladding, "cladding", err, qty);

  // Mesh
  const mesh = c.mesh as { fuelCells: number; claddingCells: number };
  for (const key of ["fuelCells", "claddingCells"] as const) {
    if (mesh[key] < MESH_MINIMUM[key]) err("E_MESH", "/mesh/" + key, key + " is " + mesh[key] + "; the minimum is " + MESH_MINIMUM[key]);
    else if (mesh[key] > MESH_MAXIMUM[key]) err("E_MESH", "/mesh/" + key, key + " is " + mesh[key] + "; the maximum is " + MESH_MAXIMUM[key]);
  }

  const result = finish(issues);
  if (result.ok && Rf !== undefined && Rci !== undefined && Rco !== undefined && qPrime !== undefined && hGap !== undefined && boundary && fuelK && claddingK) {
    result.normalized = {
      caseId: c.caseId,
      qPrime,
      fuelRadius: Rf,
      fuelInnerRadius: Rfi,
      claddingInnerRadius: Rci,
      claddingOuterRadius: Rco,
      gapConductance: hGap,
      boundary,
      fuelConductivity: fuelK,
      claddingConductivity: claddingK,
      mesh: { fuelCells: mesh.fuelCells, claddingCells: mesh.claddingCells },
    };
  }
  return result;
}

function finish(issues: Issue[]): ValidationResult {
  const errors = issues.filter((i) => i.severity === "error");
  return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === "warning") };
}

type ErrFn = (code: string, field: string, message: string, extra?: Partial<Issue>) => void;
type QtyFn = (value: unknown, dim: Dimension, field: string) => number | undefined;

function conductivity(material: Record<string, any>, region: string, err: ErrFn, qty: QtyFn): Conductivity | undefined {
  const base = "/materials/" + region + "/sets/thermal.conductivity";
  const set = isObject(material.sets) ? material.sets["thermal.conductivity"] : undefined;
  if (!isObject(set)) {
    err("E_PROP_MISSING", base, region + " material '" + material.materialId + "' has no thermal.conductivity set; a thermal model needs conductivity (composition and density alone do not satisfy it)");
    return undefined;
  }
  const sourceMissing = (set.source === undefined || typeof set.source !== "string" || set.source === "");
  if (sourceMissing) err("E_PROP_MISSING", base + "/source", "the " + region + " conductivity needs a stated source");
  if (set.model === "constant") {
    if (set.value === undefined) {
      err("E_PROP_MISSING", base + "/value", "the constant conductivity model needs k (W/m/K)");
      return undefined;
    }
    if (set.referenceTemperature === undefined) err("E_PROP_MISSING", base + "/referenceTemperature", "the constant conductivity model needs the reference temperature the value applies at");
    const k = qty(set.value, "conductivity", base + "/value");
    const tref = set.referenceTemperature === undefined ? undefined : qty(set.referenceTemperature, "temperature", base + "/referenceTemperature");
    if (k !== undefined && !(k > 0)) {
      err("E_OUT_OF_RANGE", base + "/value", region + " conductivity must be positive", { unit: "W/m/K" });
      return undefined;
    }
    if (k === undefined || tref === undefined || sourceMissing) return undefined;
    return { kind: "constant", k, referenceTemperature: tref };
  }
  if (set.model === "linear") {
    for (const key of ["a", "b"]) {
      if (set[key] === undefined) err("E_PROP_MISSING", base + "/" + key, "the linear conductivity model k = a + b T needs '" + key + "'");
    }
    const range = set.validRange;
    if (!isObject(range) || range.min === undefined || range.max === undefined) {
      err("E_PROP_MISSING", base + "/validRange", "a temperature-dependent conductivity needs the temperature range it applies to (min and max)");
    }
    const a = set.a === undefined ? undefined : qty(set.a, "conductivity", base + "/a");
    const bb = set.b === undefined ? undefined : qty(set.b, "conductivityPerK", base + "/b");
    const lo = isObject(range) && range.min !== undefined ? qty(range.min, "temperature", base + "/validRange/min") : undefined;
    const hi = isObject(range) && range.max !== undefined ? qty(range.max, "temperature", base + "/validRange/max") : undefined;
    if (a === undefined || bb === undefined || lo === undefined || hi === undefined || sourceMissing) return undefined;
    if (!(hi > lo)) {
      err("E_OUT_OF_RANGE", base + "/validRange", "range maximum must exceed the minimum", { unit: "K" });
      return undefined;
    }
    if (!(a + bb * lo > 0) || !(a + bb * hi > 0)) {
      err("E_OUT_OF_RANGE", base, "conductivity a + b T is not positive over its stated range", { unit: "W/m/K", range: [lo, hi] });
      return undefined;
    }
    return { kind: "linear", a, b: bb, range: [lo, hi] };
  }
  err("E_UNSUPPORTED", base + "/model", "unknown conductivity model '" + String(set.model) + "'; V1 supports 'constant' and 'linear'");
  return undefined;
}
