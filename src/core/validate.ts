// Semantic validation of a thermal case, before any run (docs/plans/02-case-and-materials.md).
// Structure comes from schema/case.schema.json; everything else is checked here.
// No expression is evaluated and no default is filled in: a missing datum is a named refusal.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import Ajv2020 from "ajv/dist/2020";
import { steadyEndTime } from "./steadyState";
import { initialState } from "./transientResults";
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

export type HeatCapacity =
  | { kind: "constant"; c: number; referenceTemperature: number }
  | { kind: "linear"; a: number; b: number; range: [number, number] };

/** A thermal transient: the power history is an input, the step is fixed. All values in SI. */
export interface NormalizedTransient {
  /** Power history points: time (s) and linear heat rate (W/m); linear interpolation between points. Starts at 0 and reaches the end time. */
  times: number[];
  linearHeatRate: number[];
  endTime: number;
  timeStep: number;
  steps: number;
  /** Number of equally spaced output times after t = 0 (the last is the end time). */
  outputs: number;
  /** Where the run starts: a uniform temperature, or the steady state of this pin at a constant linear heat rate (W/m) with its own boundary and properties. */
  initial: { kind: "uniform"; temperature: number } | { kind: "steady"; linearHeatRate: number };
}

/** Limits on the time grid; beyond them a case is refused, not truncated. */
export const MAX_STEPS = 100000;
export const MAX_OUTPUTS = 200;
export const MAX_HISTORY_POINTS = 1000;
/**
 * Budget for cells x steps. After the solver, FEED runs its independent solution three times (same mesh and step, doubled mesh,
 * halved step, so about five times this work, with nonlinear iterations) inside the server; this keeps that to seconds.
 */
export const MAX_TRANSIENT_WORK = 3e6;
/** Sanity bounds on a volumetric heat capacity (J/m3/K): below air at room temperature, above anything solid. */
export const HEAT_CAPACITY_MIN = 1e3;
export const HEAT_CAPACITY_MAX = 1e8;

export interface NormalizedCase {
  caseId: string;
  /** Steady: the linear heat rate (W/m). Transient: the peak of the power history, as a reference value only. */
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
  /** Present exactly when the case is a transient (assumptions.steadyState false). */
  transient?: NormalizedTransient;
  fuelHeatCapacity?: HeatCapacity;
  claddingHeatCapacity?: HeatCapacity;
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
  // steadyState false means a thermal transient: it needs the transient section and heat capacities (checked below). Nothing is assumed.
  const isTransient = c.assumptions.steadyState === false;
  if (!isTransient && c.transient !== undefined) err("E_TRANSIENT_INCOMPLETE", "/transient", "the case has a transient section but assumptions.steadyState is true; set it to false to run the transient, or remove the section");
  if (isTransient && c.transient === undefined) err("E_TRANSIENT_INCOMPLETE", "/transient", "assumptions.steadyState is false, so the case needs a transient section (power history, end time, time step, outputs, initial temperature)");
  if (c.assumptions.geometry !== "1D-radial") err("E_UNSUPPORTED", "/assumptions/geometry", "V1 supports geometry '1D-radial' only, got '" + String(c.assumptions.geometry) + "'");
  if (c.power?.radialShape !== undefined && c.power.radialShape !== "uniform") err("E_UNSUPPORTED", "/power/radialShape", "V1 supports a uniform radial power shape only");

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

  // Power: a steady case states one linear heat rate; a transient case states a history in the transient section instead.
  let qPrime: number | undefined;
  if (isTransient) {
    if (c.power?.linearHeatRate !== undefined) err("E_TRANSIENT_INCOMPLETE", "/power/linearHeatRate", "a transient case takes its power from transient.powerHistory; remove power.linearHeatRate");
  } else if (c.power?.linearHeatRate === undefined) {
    err("E_SCHEMA_INVALID", "/power/linearHeatRate", "missing: a steady case needs the linear heat rate");
  } else {
    qPrime = positive(c.power.linearHeatRate, "linearPower", "/power/linearHeatRate", "linear heat rate", "W/m");
  }
  if (!isTransient && qPrime !== undefined && qPrime > POWER_SANITY_MAX) {
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

  // Transient: heat capacities of both solids and the time section.
  let fuelCp: HeatCapacity | undefined;
  let claddingCp: HeatCapacity | undefined;
  let transient: NormalizedTransient | undefined;
  if (isTransient) {
    fuelCp = heatCapacity(c.materials.fuel, "fuel", err, qty);
    claddingCp = heatCapacity(c.materials.cladding, "cladding", err, qty);
    if (c.transient !== undefined) transient = parseTransient(c.transient, err, qty);
    if (transient) {
      qPrime = Math.max(...transient.linearHeatRate);
      // the heat capacity laws must hold at a uniform starting temperature (a steady start is checked below, on its field), and the work must fit the budget
      const start = transient.initial.kind === "uniform" ? transient.initial.temperature : undefined;
      for (const [region, cp] of [["fuel", fuelCp], ["cladding", claddingCp]] as const) {
        if (start !== undefined && cp && cp.kind === "linear" && (start < cp.range[0] || start > cp.range[1])) {
          err("E_OUT_OF_RANGE", "/transient/initialTemperature", "the initial temperature " + start + " K is outside the stated range of the " + region + " heat capacity law (" + cp.range[0] + " to " + cp.range[1] + " K)", { unit: "K", range: cp.range });
          transient = undefined;
          break;
        }
      }
    }
  }

  // Mesh
  const mesh = c.mesh as { fuelCells: number; claddingCells: number };
  for (const key of ["fuelCells", "claddingCells"] as const) {
    if (mesh[key] < MESH_MINIMUM[key]) err("E_MESH", "/mesh/" + key, key + " is " + mesh[key] + "; the minimum is " + MESH_MINIMUM[key]);
    else if (mesh[key] > MESH_MAXIMUM[key]) err("E_MESH", "/mesh/" + key, key + " is " + mesh[key] + "; the maximum is " + MESH_MAXIMUM[key]);
  }

  if (transient) {
    const m = c.mesh as { fuelCells?: number; claddingCells?: number };
    const work = ((m.fuelCells ?? 0) + (m.claddingCells ?? 0)) * transient.steps;
    if (work > MAX_TRANSIENT_WORK) {
      err("E_TIME", "/transient/timeStep", "cells x steps = " + work + " exceeds the budget of " + MAX_TRANSIENT_WORK + " (" + transient.steps + " steps on " + ((m.fuelCells ?? 0) + (m.claddingCells ?? 0)) + " cells); use a coarser mesh or a longer step", { unit: "s" });
      transient = undefined;
    }
  }
  const result = finish(issues);
  if (result.ok && Rf !== undefined && Rci !== undefined && Rco !== undefined && qPrime !== undefined && hGap !== undefined && boundary && fuelK && claddingK && (!isTransient || (transient && fuelCp && claddingCp))) {
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
      ...(isTransient ? { transient, fuelHeatCapacity: fuelCp, claddingHeatCapacity: claddingCp } : {}),
    };
    // A transient that starts from a steady operating state needs that state to exist and to lie where the heat capacity laws hold (the uniform start is checked above).
    const normalized = result.normalized!;
    const tn = normalized.transient;
    if (tn && tn.initial.kind === "steady") {
      const field = (() => {
        try {
          return initialState(normalized);
        } catch (e) {
          result.ok = false;
          result.errors.push({ code: "E_OUT_OF_RANGE", severity: "error", field: "/transient/initialSteadyLinearHeatRate", message: "there is no steady state of this pin at " + tn.initial.linearHeatRate + " W/m: " + (e as Error).message, unit: "W/m" });
          delete result.normalized;
          return undefined;
        }
      })();
      const n = result.normalized;
      if (field && n) {
        const nf = n.mesh.fuelCells;
        for (const [region, cp, from, to] of [["fuel", n.fuelHeatCapacity, 0, nf], ["cladding", n.claddingHeatCapacity, nf, field.T.length]] as const) {
          if (!cp || cp.kind !== "linear") continue;
          const part = field.T.slice(from, to);
          const lo = Math.min(...part);
          const hi = Math.max(...part);
          if (lo < cp.range[0] || hi > cp.range[1]) {
            result.ok = false;
            result.errors.push({ code: "E_OUT_OF_RANGE", severity: "error", field: "/transient/initialSteadyLinearHeatRate", message: "the steady state at " + tn.initial.linearHeatRate + " W/m puts the " + region + " at " + lo.toFixed(0) + " to " + hi.toFixed(0) + " K, outside the stated range of its heat capacity law (" + cp.range[0] + " to " + cp.range[1] + " K)", unit: "K", range: cp.range });
            delete result.normalized;
            break;
          }
        }
      }
    }
    // A steady case is run to a long end time; one whose pin could not settle within the longest run FEED allows is refused, not run
    // to a time at which it is still changing (src/core/steadyState.ts).
    if (!isTransient) {
      const h = steadyEndTime(normalized);
      if (!h.ok) {
        result.ok = false;
        result.errors.push({ code: "E_TIME", severity: "error", field: "/assumptions/steadyState", message: "this case cannot be run as a steady case: " + h.message });
        delete result.normalized;
      }
    }
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

/** Volumetric heat capacity c (J/m3/K) of one solid: constant, or linear c = a + b T (T in K) over a stated range. Needed by transients only. */
function heatCapacity(material: Record<string, any>, region: string, err: ErrFn, qty: QtyFn): HeatCapacity | undefined {
  const base = "/materials/" + region + "/sets/thermal.volumetricHeatCapacity";
  const set = isObject(material.sets) ? material.sets["thermal.volumetricHeatCapacity"] : undefined;
  if (!isObject(set)) {
    err("E_PROP_MISSING", base, region + " material '" + material.materialId + "' has no thermal.volumetricHeatCapacity set; a transient needs the heat capacity of both solids");
    return undefined;
  }
  const sourceMissing = set.source === undefined || typeof set.source !== "string" || set.source === "";
  if (sourceMissing) err("E_PROP_MISSING", base + "/source", "the " + region + " heat capacity needs a stated source");
  if (set.model === "constant") {
    if (set.value === undefined) {
      err("E_PROP_MISSING", base + "/value", "the constant heat capacity model needs c (J/m3/K)");
      return undefined;
    }
    if (set.referenceTemperature === undefined) err("E_PROP_MISSING", base + "/referenceTemperature", "the constant heat capacity model needs the reference temperature the value applies at");
    const c = qty(set.value, "volumetricHeatCapacity", base + "/value");
    const tref = set.referenceTemperature === undefined ? undefined : qty(set.referenceTemperature, "temperature", base + "/referenceTemperature");
    if (c !== undefined && !(c > 0)) {
      err("E_OUT_OF_RANGE", base + "/value", region + " heat capacity must be positive", { unit: "J/m3/K" });
      return undefined;
    }
    if (c !== undefined && (c < HEAT_CAPACITY_MIN || c > HEAT_CAPACITY_MAX)) {
      err("E_OUT_OF_RANGE", base + "/value", region + " heat capacity " + c + " J/m3/K is outside " + HEAT_CAPACITY_MIN + " to " + HEAT_CAPACITY_MAX + "; check the units", { unit: "J/m3/K" });
      return undefined;
    }
    if (c === undefined || tref === undefined || sourceMissing) return undefined;
    return { kind: "constant", c, referenceTemperature: tref };
  }
  if (set.model === "linear") {
    for (const key of ["a", "b"]) {
      if (set[key] === undefined) err("E_PROP_MISSING", base + "/" + key, "the linear heat capacity model c = a + b T needs '" + key + "'");
    }
    const range = set.validRange;
    if (!isObject(range) || range.min === undefined || range.max === undefined) {
      err("E_PROP_MISSING", base + "/validRange", "a temperature-dependent heat capacity needs the temperature range it applies to (min and max)");
    }
    const a = set.a === undefined ? undefined : qty(set.a, "volumetricHeatCapacity", base + "/a");
    const bb = set.b === undefined ? undefined : qty(set.b, "volumetricHeatCapacityPerK", base + "/b");
    const lo = isObject(range) && range.min !== undefined ? qty(range.min, "temperature", base + "/validRange/min") : undefined;
    const hi = isObject(range) && range.max !== undefined ? qty(range.max, "temperature", base + "/validRange/max") : undefined;
    if (a === undefined || bb === undefined || lo === undefined || hi === undefined || sourceMissing) return undefined;
    if (!(hi > lo)) {
      err("E_OUT_OF_RANGE", base + "/validRange", "range maximum must exceed the minimum", { unit: "K" });
      return undefined;
    }
    const cLo = a + bb * lo;
    const cHi = a + bb * hi;
    if (!(cLo > 0) || !(cHi > 0)) {
      err("E_OUT_OF_RANGE", base, "heat capacity a + b T is not positive over its stated range", { unit: "J/m3/K", range: [lo, hi] });
      return undefined;
    }
    if (Math.min(cLo, cHi) < HEAT_CAPACITY_MIN || Math.max(cLo, cHi) > HEAT_CAPACITY_MAX) {
      err("E_OUT_OF_RANGE", base, "heat capacity is outside " + HEAT_CAPACITY_MIN + " to " + HEAT_CAPACITY_MAX + " J/m3/K somewhere in its stated range; check the units", { unit: "J/m3/K", range: [lo, hi] });
      return undefined;
    }
    return { kind: "linear", a, b: bb, range: [lo, hi] };
  }
  err("E_UNSUPPORTED", base + "/model", "unknown heat capacity model '" + String(set.model) + "'; supported: 'constant' and 'linear'");
  return undefined;
}

/** The transient section: power history, time grid, outputs and initial temperature. Every problem is named; nothing is defaulted. */
function parseTransient(t: Record<string, any>, err: ErrFn, qty: QtyFn): NormalizedTransient | undefined {
  let ok = true;
  const bad = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
    ok = false;
    err(code, field, message, extra);
  };
  for (const key of ["powerHistory", "endTime", "timeStep", "outputs"]) {
    if (t[key] === undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/" + key, "the transient section needs '" + key + "'");
  }
  // the initial state: exactly one of a uniform temperature and a steady operating state
  if (t.initialTemperature !== undefined && t.initialSteadyLinearHeatRate !== undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/initialSteadyLinearHeatRate", "give either 'initialTemperature' (a uniform start) or 'initialSteadyLinearHeatRate' (the steady state at that heat rate), not both");
  else if (t.initialTemperature === undefined && t.initialSteadyLinearHeatRate === undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/initialTemperature", "the transient section needs an initial state: 'initialTemperature' (a uniform start) or 'initialSteadyLinearHeatRate' (the steady state of this pin at that heat rate)");
  const endTime = t.endTime === undefined ? undefined : qty(t.endTime, "time", "/transient/endTime");
  const timeStep = t.timeStep === undefined ? undefined : qty(t.timeStep, "time", "/transient/timeStep");
  const initialTemperature = t.initialTemperature === undefined ? undefined : qty(t.initialTemperature, "temperature", "/transient/initialTemperature");
  if (endTime === undefined && t.endTime !== undefined) ok = false;
  if (timeStep === undefined && t.timeStep !== undefined) ok = false;
  if (initialTemperature === undefined && t.initialTemperature !== undefined) ok = false;
  if (endTime !== undefined && !(endTime > 0)) bad("E_OUT_OF_RANGE", "/transient/endTime", "end time must be positive", { unit: "s" });
  if (timeStep !== undefined && !(timeStep > 0)) bad("E_OUT_OF_RANGE", "/transient/timeStep", "time step must be positive", { unit: "s" });
  if (initialTemperature !== undefined && !(initialTemperature > 0)) bad("E_OUT_OF_RANGE", "/transient/initialTemperature", "initial temperature must be above 0 K", { unit: "K" });
  const initialQ = t.initialSteadyLinearHeatRate === undefined ? undefined : qty(t.initialSteadyLinearHeatRate, "linearPower", "/transient/initialSteadyLinearHeatRate");
  if (initialQ === undefined && t.initialSteadyLinearHeatRate !== undefined) ok = false;
  if (initialQ !== undefined && !(initialQ >= 0)) bad("E_OUT_OF_RANGE", "/transient/initialSteadyLinearHeatRate", "the steady heat rate cannot be negative", { unit: "W/m" });

  let steps = 0;
  if (endTime !== undefined && timeStep !== undefined && endTime > 0 && timeStep > 0) {
    const ratio = endTime / timeStep;
    steps = Math.round(ratio);
    if (Math.abs(ratio - steps) > 1e-9 * Math.max(1, ratio)) bad("E_TIME", "/transient/timeStep", "the end time is not a whole number of time steps (" + ratio + " steps); choose a step that divides it", { unit: "s" });
    else if (steps < 1) bad("E_TIME", "/transient/timeStep", "the time step is longer than the end time", { unit: "s" });
    else if (steps > MAX_STEPS) bad("E_TIME", "/transient/timeStep", "the run would take " + steps + " steps; the maximum is " + MAX_STEPS, { unit: "s" });
  }
  const outputs = t.outputs;
  if (typeof outputs === "number" && Number.isInteger(outputs)) {
    if (outputs < 1 || outputs > MAX_OUTPUTS) bad("E_TIME", "/transient/outputs", "outputs is " + outputs + "; it must be between 1 and " + MAX_OUTPUTS);
    else if (steps >= 1 && steps % outputs !== 0) bad("E_TIME", "/transient/outputs", "outputs (" + outputs + ") must divide the number of steps (" + steps + ") so the outputs fall on step boundaries");
  }

  const times: number[] = [];
  const lhgr: number[] = [];
  const hist = t.powerHistory;
  if (Array.isArray(hist)) {
    if (hist.length < 2) bad("E_TIME", "/transient/powerHistory", "the power history needs at least two points");
    else if (hist.length > MAX_HISTORY_POINTS) bad("E_TIME", "/transient/powerHistory", "the power history has " + hist.length + " points; the maximum is " + MAX_HISTORY_POINTS);
    else {
      hist.forEach((p: any, i: number) => {
        const f = "/transient/powerHistory/" + i;
        if (!isObject(p)) return bad("E_SCHEMA_INVALID", f, "each history point is {time, linearHeatRate}");
        const tt = qty(p.time, "time", f + "/time");
        const q = qty(p.linearHeatRate, "linearPower", f + "/linearHeatRate");
        if (tt === undefined || q === undefined) {
          ok = false;
          return;
        }
        if (q < 0) return bad("E_OUT_OF_RANGE", f + "/linearHeatRate", "linear heat rate cannot be negative", { unit: "W/m" });
        times.push(tt);
        lhgr.push(q);
      });
      if (times.length === hist.length) {
        if (times[0] !== 0) bad("E_TIME", "/transient/powerHistory/0/time", "the power history must start at time 0");
        for (let i = 1; i < times.length; i++) {
          if (!(times[i]! > times[i - 1]!)) {
            bad("E_TIME", "/transient/powerHistory/" + i + "/time", "history times must increase strictly");
            break;
          }
        }
        if (endTime !== undefined && times[times.length - 1]! < endTime * (1 - 1e-12)) bad("E_TIME", "/transient/powerHistory", "the power history ends at " + times[times.length - 1] + " s, before the end time " + endTime + " s; give the power over the whole run");
        // all zero is a mistake from a uniform start (nothing is heated), but a shutdown from a steady operating state (a scram) is a real case
        if (!(Math.max(...lhgr) > 0) && !(t.initialSteadyLinearHeatRate !== undefined && t.initialSteadyLinearHeatRate !== null)) bad("E_OUT_OF_RANGE", "/transient/powerHistory", "the power history is zero everywhere");
      } else ok = false;
    }
  } else if (hist !== undefined) {
    bad("E_SCHEMA_INVALID", "/transient/powerHistory", "the power history is a list of {time, linearHeatRate} points");
  }
  const initial: NormalizedTransient["initial"] | undefined = initialTemperature !== undefined ? { kind: "uniform", temperature: initialTemperature } : initialQ !== undefined ? { kind: "steady", linearHeatRate: initialQ } : undefined;
  if (!ok || endTime === undefined || timeStep === undefined || initial === undefined || typeof outputs !== "number" || times.length < 2) return undefined;
  return { times, linearHeatRate: lhgr, endTime, timeStep, steps, outputs, initial };
}
