// Semantic validation of a thermal case, before any run (docs/plans/02-case-and-materials.md).
// Structure comes from schema/case.schema.json; everything else is checked here.
// No expression is evaluated and no default is filled in: a missing datum is a named refusal.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import Ajv2020 from "ajv/dist/2020";
import { steadyEndTime } from "./steadyState";
import { Law, fitPolynomial, minimum } from "./conductivity";
import { heatCapacityLaw } from "./heatCapacity";
import type { LimitRule } from "./limits";
import { GeneratedPulse, KineticsError, KineticsSpec, generatePulse } from "./pointKinetics";
import { fuelMean, initialState } from "./transientResults";
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

/** What a table became: the polynomial fitted to it and how far that is from the table (docs/conductivity-models.md). */
export interface TableFit {
  degree: number;
  /** The largest relative deviation the case allows, and the largest it has (at `worstAt` kelvin), both as fractions of the table's k. */
  tolerance: number;
  maxRelativeDeviation: number;
  worstAt: number;
  points: { temperature: number; conductivity: number }[];
}

export type Conductivity =
  | { kind: "constant"; k: number; referenceTemperature: number }
  | { kind: "linear"; a: number; b: number; range: [number, number] }
  /** k = a0 + a1 T + a2 T^2 + a3 T^3 (W/m/K, T in K) over a range; `fit` is present when it came from a table. */
  | { kind: "polynomial"; coefficients: number[]; range: [number, number]; fit?: TableFit };

export type HeatCapacity =
  | { kind: "constant"; c: number; referenceTemperature: number }
  | { kind: "linear"; a: number; b: number; range: [number, number] }
  /** c = a0 + a1 T + a2 T^2 (J/m3/K, T in K) over a range; `fit` is present when it came from a table. */
  | { kind: "polynomial"; coefficients: number[]; range: [number, number]; fit?: TableFit };

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
  /** Present when the history comes from point kinetics: the validated inputs and, once the case is normalized, the generated pulse (times and linearHeatRate are then its thinned history). */
  kinetics?: KineticsSpec;
  generated?: GeneratedPulse;
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
  /** Temperature limits the case states, with their sources (src/core/limits.ts). */
  limits?: LimitRule[];
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

  const limits = c.limits === undefined ? undefined : parseLimits(c.limits, err, qty);

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
        if (start !== undefined && cp && cp.kind !== "constant" && (start < cp.range[0] || start > cp.range[1])) {
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
      ...(limits ? { limits } : {}),
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
          if (!cp || cp.kind === "constant") continue;
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
    // A transient whose power comes from point kinetics: the pulse is generated from the fuel (its area, its heat capacity law, its starting average
    // temperature) and replaces the placeholder history. It is generated here, once, so that everything downstream (the writer, the independent solution,
    // the results, the preview) sees an ordinary power history.
    if (result.ok && normalized.transient?.kinetics) {
      const tk = normalized.transient;
      const spec = tk.kinetics!;
      const cp = normalized.fuelHeatCapacity!;
      let startTemperature: number | undefined;
      if (tk.initial.kind === "uniform") startTemperature = tk.initial.temperature;
      else {
        try {
          startTemperature = fuelMean(normalized, initialState(normalized).T);
        } catch {
          startTemperature = undefined; // the steady start was already refused above
        }
      }
      if (startTemperature !== undefined) {
        try {
          const pulse = generatePulse(spec, { fuelArea: Math.PI * (normalized.fuelRadius ** 2 - normalized.fuelInnerRadius ** 2), fuelC: cp.kind === "constant" ? { a: cp.c, b: 0 } : cp.kind === "linear" ? { a: cp.a, b: cp.b } : { a: cp.coefficients[0]!, b: cp.coefficients[1]! }, fuelLaw: heatCapacityLaw(cp), startTemperature });
          const fb = spec.feedback;
          const [lo, hi] = pulse.summary.temperatureRange;
          if (fb.kind === "linear" && (lo < fb.range[0] || hi > fb.range[1])) {
            result.ok = false;
            result.errors.push({ code: "E_OUT_OF_RANGE", severity: "error", field: "/transient/pointKinetics/feedback/validRange", message: "the pulse takes the fuel's average from " + lo.toFixed(0) + " to " + hi.toFixed(0) + " K, outside the stated range of the temperature coefficient (" + fb.range[0] + " to " + fb.range[1] + " K)", unit: "K", range: fb.range });
            delete result.normalized;
          } else if (tk.initial.kind === "steady" && Math.abs(tk.initial.linearHeatRate - pulse.linearHeatRate[0]!) > 1e-6 * Math.max(tk.initial.linearHeatRate, pulse.linearHeatRate[0]!)) {
            result.ok = false;
            result.errors.push({ code: "E_OUT_OF_RANGE", severity: "error", field: "/transient/initialSteadyLinearHeatRate", message: "the pin starts steady at " + tk.initial.linearHeatRate + " W/m but the generator's initial power of " + spec.initialPower + " W gives " + pulse.linearHeatRate[0] + " W/m in this slice (initial power x peaking factor / (pins x active length)); they must be the same operating state", unit: "W/m" });
            delete result.normalized;
          } else {
            tk.times = pulse.times;
            tk.linearHeatRate = pulse.linearHeatRate;
            tk.generated = pulse;
            normalized.qPrime = Math.max(...pulse.linearHeatRate);
          }
        } catch (e) {
          if (!(e instanceof KineticsError)) throw e;
          result.ok = false;
          result.errors.push({ code: "E_KINETICS", severity: "error", field: "/transient/pointKinetics", message: "the pulse cannot be generated: " + e.message });
          delete result.normalized;
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

/** A material id: lower case letters, digits and hyphens, 3 to 64 characters, not starting or ending with a hyphen. */
export const MATERIAL_ID = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * A material as the library stores it, checked with the same rules a case applies to it: an id, a revision, a thermal conductivity with its stated source (and
 * range for a temperature-dependent law), and, if present, a volumetric heat capacity under the same rules. Sets that belong to other apps are not looked at
 * beyond being objects: they are kept as they are. Errors name fields as they would in a case (/materials/<region>/...).
 */
export function validateMaterial(region: "fuel" | "cladding", material: unknown): { ok: boolean; errors: Issue[] } {
  const issues: Issue[] = [];
  const err = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => issues.push({ code, severity: "error", field, message, ...extra });
  const base = "/materials/" + region;
  if (!isObject(material)) {
    err("E_SCHEMA_INVALID", base, "a material is an object with a materialId, a revision and sets");
    return finish(issues);
  }
  if (typeof material.materialId !== "string" || !MATERIAL_ID.test(material.materialId)) err("E_SCHEMA_INVALID", base + "/materialId", "the material id is 3 to 64 characters: lower case letters, digits and hyphens, not starting or ending with a hyphen");
  if (typeof material.revision !== "number" || !Number.isSafeInteger(material.revision) || material.revision < 1) err("E_SCHEMA_INVALID", base + "/revision", "the revision is a whole number from 1");
  if (!isObject(material.sets)) {
    err("E_SCHEMA_INVALID", base + "/sets", "sets is an object of named property sets");
    return finish(issues);
  }
  const sets = material.sets;
  if (Object.keys(sets).length > 20) err("E_OUT_OF_RANGE", base + "/sets", "at most 20 property sets");
  for (const [k, v] of Object.entries(sets)) if (!isObject(v)) err("E_SCHEMA_INVALID", base + "/sets/" + k, "a property set is an object");
  const qty = (value: unknown, dim: Dimension, field: string): number | undefined => {
    const r = toSI(value, dim);
    if (r.ok) return r.si;
    err("E_UNITS", field, r.reason);
    return undefined;
  };
  conductivity(material, region, err as ErrFn, qty);
  if (sets["thermal.volumetricHeatCapacity"] !== undefined) heatCapacity(material, region, err as ErrFn, qty);
  return finish(issues);
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
  if (set.model === "polynomial") return polynomialConductivity(set, region, base, sourceMissing, err, qty);
  if (set.model === "table") return tableConductivity(set, region, base, sourceMissing, err, qty);
  err("E_UNSUPPORTED", base + "/model", "unknown conductivity model '" + String(set.model) + "'; supported: 'constant', 'linear', 'polynomial' and 'table'");
  return undefined;
}

/**
 * What a temperature-dependent property is, for the rules that conductivity and volumetric heat capacity share (a polynomial over a range, or a table carried by
 * a fitted polynomial): the words the messages use, the units, how many coefficients, and the values the property may take.
 */
interface LawSpec {
  what: string;
  /** The law as the message shows it. */
  law: string;
  unit: string;
  valueDim: Dimension;
  /** The coefficients' keys and dimensions, lowest power first. */
  terms: readonly (readonly [string, Dimension])[];
  /** The key of a table point's value. */
  pointKey: string;
  /** The highest fit degree: the polynomial's own degree. */
  maxDegree: number;
  /** The values the property may take over the range (the units check of a heat capacity); none for a conductivity. */
  bounds?: readonly [number, number];
}

const CONDUCTIVITY_SPEC: LawSpec = {
  what: "conductivity",
  law: "k = a + b T + c T^2 + d T^3",
  unit: "W/m/K",
  valueDim: "conductivity",
  terms: [["a", "conductivity"], ["b", "conductivityPerK"], ["c", "conductivityPerK2"], ["d", "conductivityPerK3"]],
  pointKey: "conductivity",
  maxDegree: 3,
};

const HEAT_CAPACITY_SPEC: LawSpec = {
  what: "heat capacity",
  law: "c = a + b T + c T^2",
  unit: "J/m3/K",
  valueDim: "volumetricHeatCapacity",
  terms: [["a", "volumetricHeatCapacity"], ["b", "volumetricHeatCapacityPerK"], ["c", "volumetricHeatCapacityPerK2"]],
  pointKey: "heatCapacity",
  maxDegree: 2,
  bounds: [HEAT_CAPACITY_MIN, HEAT_CAPACITY_MAX],
};

/** The property must be positive over the whole of its range, exactly (the end points and the turning points), not at samples; and inside its bounds if it has any. */
function positiveOver(c: Law, lo: number, hi: number, base: string, region: string, err: ErrFn, spec: LawSpec = CONDUCTIVITY_SPEC): boolean {
  const m = minimum(c, lo, hi);
  const top = -minimum(c.map((x) => -x), lo, hi);
  if (!Number.isFinite(m) || !Number.isFinite(top)) {
    err("E_OUT_OF_RANGE", base, "the " + region + " " + spec.what + " cannot be evaluated over its stated range " + lo + " to " + hi + " K: it overflows; check the coefficients and their units", { unit: spec.unit, range: [lo, hi] });
    return false;
  }
  if (!(m > 0)) {
    err("E_OUT_OF_RANGE", base, "the " + region + " " + spec.what + " is not positive over its stated range " + lo + " to " + hi + " K (its lowest value there is " + m.toPrecision(4) + " " + spec.unit + ")", { unit: spec.unit, range: [lo, hi] });
    return false;
  }
  if (spec.bounds) {
    if (m < spec.bounds[0] || top > spec.bounds[1]) {
      err("E_OUT_OF_RANGE", base, "the " + region + " " + spec.what + " is outside " + spec.bounds[0] + " to " + spec.bounds[1] + " " + spec.unit + " somewhere in its stated range (" + m.toPrecision(4) + " to " + top.toPrecision(4) + "); check the units", { unit: spec.unit, range: [lo, hi] });
      return false;
    }
  }
  return true;
}

/** A polynomial over a stated range. Every coefficient is given (a zero is written as a zero), with a source and the range. */
function polynomialLaw(spec: LawSpec, set: Record<string, any>, region: string, base: string, sourceMissing: boolean, err: ErrFn, qty: QtyFn): { coefficients: number[]; range: [number, number] } | undefined {
  for (const [key] of spec.terms) if (set[key] === undefined) err("E_PROP_MISSING", base + "/" + key, "the polynomial " + spec.what + " " + spec.law + " needs '" + key + "' (give 0 for a term that is not there)");
  const range = set.validRange;
  if (!isObject(range) || range.min === undefined || range.max === undefined) err("E_PROP_MISSING", base + "/validRange", "a temperature-dependent " + spec.what + " needs the temperature range it applies to (min and max)");
  const co = spec.terms.map(([key, dim]) => (set[key] === undefined ? undefined : qty(set[key], dim, base + "/" + key)));
  const lo = isObject(range) && range.min !== undefined ? qty(range.min, "temperature", base + "/validRange/min") : undefined;
  const hi = isObject(range) && range.max !== undefined ? qty(range.max, "temperature", base + "/validRange/max") : undefined;
  if (co.some((x) => x === undefined) || lo === undefined || hi === undefined || sourceMissing) return undefined;
  if (!(hi > lo)) {
    err("E_OUT_OF_RANGE", base + "/validRange", "range maximum must exceed the minimum", { unit: "K" });
    return undefined;
  }
  if (!(lo > 0)) {
    err("E_OUT_OF_RANGE", base + "/validRange/min", "the range starts above 0 K", { unit: "K" });
    return undefined;
  }
  const coefficients = co as number[];
  if (!positiveOver(coefficients, lo, hi, base, region, err, spec)) return undefined;
  return { coefficients, range: [lo, hi] };
}

const polynomialConductivity = (set: Record<string, any>, region: string, base: string, sourceMissing: boolean, err: ErrFn, qty: QtyFn): Conductivity | undefined => {
  const law = polynomialLaw(CONDUCTIVITY_SPEC, set, region, base, sourceMissing, err, qty);
  return law ? { kind: "polynomial", ...law } : undefined;
};

/** The most points a table may have, and the tolerance a fit may be allowed (a fraction of the value): beyond it the table is not being represented, it is being ignored. */
export const MAX_TABLE_POINTS = 200;
export const MAX_FIT_TOLERANCE = 0.5;

/**
 * A table of (temperature, value) points, carried by a polynomial FITTED to it: OFFBEAT has no tabulated conductivity or heat capacity (docs/spike/property-model-survey.md).
 * The case states the degree (1 to the polynomial's own) and the largest deviation it accepts; a fit that is further from the table than that is refused (E_FIT),
 * never smoothed silently. The range is the table's own: a law fitted to 300 to 600 K says nothing about 900 K.
 */
function tableLaw(spec: LawSpec, set: Record<string, any>, region: string, base: string, sourceMissing: boolean, err: ErrFn, qty: QtyFn): { coefficients: number[]; range: [number, number]; fit: TableFit } | undefined {
  const pts = set.points;
  if (!Array.isArray(pts)) {
    err("E_PROP_MISSING", base + "/points", "a " + spec.what + " table needs 'points': a list of {temperature, " + spec.pointKey + "}");
    return undefined;
  }
  const fitSpec = set.fit;
  const degreeList = Array.from({ length: spec.maxDegree }, (_, i) => i + 1);
  const degreeText = degreeList.slice(0, -1).join(", ") + " or " + spec.maxDegree;
  if (!isObject(fitSpec) || fitSpec.degree === undefined || fitSpec.tolerance === undefined) err("E_PROP_MISSING", base + "/fit", "a " + spec.what + " table is carried by a fitted polynomial: give fit.degree (" + degreeText + ") and fit.tolerance (the largest deviation from the table you accept, as a fraction or in %)");
  let ok = !sourceMissing && isObject(fitSpec) && fitSpec.degree !== undefined && fitSpec.tolerance !== undefined;
  if (pts.length < 2 || pts.length > MAX_TABLE_POINTS) {
    err("E_OUT_OF_RANGE", base + "/points", "a " + spec.what + " table has 2 to " + MAX_TABLE_POINTS + " points; this one has " + pts.length);
    ok = false;
  }
  const table: { temperature: number; conductivity: number }[] = [];
  if (pts.length <= MAX_TABLE_POINTS) {
    pts.forEach((p: unknown, i: number) => {
      const at = base + "/points/" + i;
      if (!isObject(p)) {
        err("E_SCHEMA_INVALID", at, "each point is {temperature, " + spec.pointKey + "}");
        ok = false;
        return;
      }
      const T = qty(p.temperature, "temperature", at + "/temperature");
      const k = qty(p[spec.pointKey], spec.valueDim, at + "/" + spec.pointKey);
      if (T === undefined || k === undefined) {
        ok = false;
        return;
      }
      if (!(T > 0)) err("E_OUT_OF_RANGE", at + "/temperature", "a temperature above 0 K", { unit: "K" }), (ok = false);
      else if (!(k > 0)) err("E_OUT_OF_RANGE", at + "/" + spec.pointKey, "a " + spec.what + " above 0 " + spec.unit, { unit: spec.unit }), (ok = false);
      else if (table.length > 0 && !(T > table[table.length - 1]!.temperature)) err("E_OUT_OF_RANGE", at + "/temperature", "the table's temperatures must increase strictly (point " + i + " is " + T + " K after " + table[table.length - 1]!.temperature + " K)", { unit: "K" }), (ok = false);
      else table.push({ temperature: T, conductivity: k });
    });
  }
  let degreeWanted: number | undefined;
  let tolerance: number | undefined;
  if (isObject(fitSpec)) {
    if (fitSpec.degree !== undefined) {
      if (typeof fitSpec.degree !== "number" || !Number.isInteger(fitSpec.degree) || fitSpec.degree < 1 || fitSpec.degree > spec.maxDegree) {
        err("E_OUT_OF_RANGE", base + "/fit/degree", "the fit degree is " + degreeText);
        ok = false;
      } else degreeWanted = fitSpec.degree;
    }
    if (fitSpec.tolerance !== undefined) {
      tolerance = qty(fitSpec.tolerance, "fraction", base + "/fit/tolerance");
      if (tolerance === undefined) ok = false;
      else if (!(tolerance > 0 && tolerance <= MAX_FIT_TOLERANCE)) {
        err("E_OUT_OF_RANGE", base + "/fit/tolerance", "the fit tolerance is above 0 and at most " + MAX_FIT_TOLERANCE * 100 + "% of the table's " + spec.what);
        ok = false;
      }
    }
  }
  if (!ok || degreeWanted === undefined || tolerance === undefined || table.length < 2) return undefined;
  if (table.length < degreeWanted + 1) {
    err("E_FIT", base + "/fit/degree", "a degree " + degreeWanted + " fit needs at least " + (degreeWanted + 1) + " points; the table has " + table.length + "; lower the degree or add points");
    return undefined;
  }
  let fit;
  try {
    fit = fitPolynomial(table.map((p) => ({ T: p.temperature, k: p.conductivity })), degreeWanted);
  } catch (e) {
    err("E_FIT", base + "/fit", "the table cannot be fitted: " + (e as Error).message);
    return undefined;
  }
  if (!(fit.maxRelativeDeviation <= tolerance)) {
    err("E_FIT", base + "/fit", "the degree " + degreeWanted + " polynomial is " + (fit.maxRelativeDeviation * 100).toPrecision(3) + "% from the table at " + fit.worstAt + " K; the tolerance is " + (tolerance * 100).toPrecision(3) + "%. Raise the degree, shorten the table to the range you need, or raise the tolerance if that is what you accept", { range: [fit.maxRelativeDeviation, tolerance] });
    return undefined;
  }
  const lo = table[0]!.temperature;
  const hi = table[table.length - 1]!.temperature;
  const coefficients = fit.coefficients.slice(0, spec.terms.length);
  if (!positiveOver(coefficients, lo, hi, base + "/fit", region, err, spec)) return undefined;
  return { coefficients, range: [lo, hi], fit: { degree: degreeWanted, tolerance, maxRelativeDeviation: fit.maxRelativeDeviation, worstAt: fit.worstAt, points: table } };
}

function tableConductivity(set: Record<string, any>, region: string, base: string, sourceMissing: boolean, err: ErrFn, qty: QtyFn): Conductivity | undefined {
  const t = tableLaw(CONDUCTIVITY_SPEC, set, region, base, sourceMissing, err, qty);
  return t ? { kind: "polynomial", ...t } : undefined;
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
  if (set.model === "polynomial") {
    const t = polynomialLaw(HEAT_CAPACITY_SPEC, set, region, base, sourceMissing, err, qty);
    return t ? { kind: "polynomial", ...t } : undefined;
  }
  if (set.model === "table") {
    const t = tableLaw(HEAT_CAPACITY_SPEC, set, region, base, sourceMissing, err, qty);
    return t ? { kind: "polynomial", ...t } : undefined;
  }
  err("E_UNSUPPORTED", base + "/model", "unknown heat capacity model '" + String(set.model) + "'; supported: constant, linear, polynomial, table");
  return undefined;
}

export const MAX_LIMITS = 10;
export const MAX_LIMIT_TEMPERATURE = 10000;

/**
 * The limits a case states: each with a name, a region, a maximum temperature and the source it comes from; a fuel limit may apply only while the hottest cladding
 * is at most / above a temperature. Nothing is defaulted and FEED has no limit of its own (docs/temperature-limits.md).
 */
function parseLimits(raw: unknown, err: ErrFn, qty: QtyFn): LimitRule[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LIMITS) {
    err("E_SCHEMA_INVALID", "/limits", "limits is a list of 1 to " + MAX_LIMITS + " rules");
    return undefined;
  }
  const out: LimitRule[] = [];
  let ok = true;
  const names = new Set<string>();
  raw.forEach((r: unknown, i: number) => {
    const base = "/limits/" + i;
    const bad = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
      ok = false;
      err(code, field, message, extra);
    };
    if (!isObject(r)) return bad("E_SCHEMA_INVALID", base, "a limit is an object with a name, a region, a maximum temperature and a source");
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (name === "" || name.length > 80 || /[\u0000-\u001f]/.test(name)) bad("E_SCHEMA_INVALID", base + "/name", "a limit needs a name of 1 to 80 characters");
    else if (names.has(name)) bad("E_SCHEMA_INVALID", base + "/name", "two limits are named '" + name + "'; a name says which limit a result is about");
    names.add(name);
    if (r.region !== "fuel" && r.region !== "cladding") bad("E_SCHEMA_INVALID", base + "/region", "region is fuel or cladding");
    if (typeof r.source !== "string" || r.source.trim() === "") bad("E_PROP_MISSING", base + "/source", "a limit needs the source it comes from: FEED has no limits of its own");
    let max: number | undefined;
    if (r.maxTemperature === undefined) bad("E_PROP_MISSING", base + "/maxTemperature", "a limit needs its maximum temperature");
    else {
      max = qty(r.maxTemperature, "temperature", base + "/maxTemperature");
      if (max === undefined) ok = false;
      else if (!(max > 0 && max <= MAX_LIMIT_TEMPERATURE)) {
        bad("E_OUT_OF_RANGE", base + "/maxTemperature", "a limit temperature is above 0 K and at most " + MAX_LIMIT_TEMPERATURE + " K", { unit: "K" });
        max = undefined;
      }
    }
    let while_: { atMost?: number; above?: number } | undefined;
    if (r.whileCladding !== undefined) {
      if (r.region !== "fuel") bad("E_SCHEMA_INVALID", base + "/whileCladding", "whileCladding conditions a fuel limit on the cladding; a cladding limit has none");
      else if (!isObject(r.whileCladding) || (r.whileCladding.atMost === undefined && r.whileCladding.above === undefined)) bad("E_SCHEMA_INVALID", base + "/whileCladding", "whileCladding gives atMost and/or above, each a temperature");
      else {
        while_ = {};
        for (const key of ["atMost", "above"] as const) {
          if (r.whileCladding[key] === undefined) continue;
          const t = qty(r.whileCladding[key], "temperature", base + "/whileCladding/" + key);
          if (t === undefined) ok = false;
          else if (!(t > 0 && t <= MAX_LIMIT_TEMPERATURE)) bad("E_OUT_OF_RANGE", base + "/whileCladding/" + key, "a cladding temperature is above 0 K and at most " + MAX_LIMIT_TEMPERATURE + " K", { unit: "K" });
          else while_[key] = t;
        }
        if (while_.atMost !== undefined && while_.above !== undefined && !(while_.atMost > while_.above)) bad("E_OUT_OF_RANGE", base + "/whileCladding", "atMost must be above 'above', or the condition never holds", { unit: "K" });
      }
    }
    if (ok && max !== undefined && (r.region === "fuel" || r.region === "cladding") && typeof r.source === "string" && name !== "") out.push({ name, region: r.region, maxTemperature: max, ...(while_ ? { whileCladding: while_ } : {}), source: r.source.trim() });
  });
  return ok && out.length === raw.length ? out : undefined;
}

/** The transient section: power history, time grid, outputs and initial temperature. Every problem is named; nothing is defaulted. */
function parseTransient(t: Record<string, any>, err: ErrFn, qty: QtyFn): NormalizedTransient | undefined {
  let ok = true;
  const bad = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
    ok = false;
    err(code, field, message, extra);
  };
  for (const key of ["endTime", "timeStep", "outputs"]) {
    if (t[key] === undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/" + key, "the transient section needs '" + key + "'");
  }
  // the power: exactly one of a table (powerHistory) and a point-kinetics generator (pointKinetics)
  if (t.powerHistory !== undefined && t.pointKinetics !== undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/pointKinetics", "give either 'powerHistory' (a table) or 'pointKinetics' (a generated pulse), not both");
  else if (t.powerHistory === undefined && t.pointKinetics === undefined) bad("E_TRANSIENT_INCOMPLETE", "/transient/powerHistory", "the transient section needs its power: 'powerHistory' (a table) or 'pointKinetics' (a generated pulse)");
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
  let kinetics: KineticsSpec | undefined;
  if (t.pointKinetics !== undefined && t.powerHistory === undefined) {
    kinetics = parseKinetics(t.pointKinetics, err, qty, endTime);
    if (kinetics === undefined) ok = false;
    else {
      // placeholders until the case is normalized and the pulse can be generated from the fuel (validateCase)
      times.push(0, endTime ?? 1);
      lhgr.push(0, 0);
    }
  } else if (Array.isArray(hist)) {
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
  return { times, linearHeatRate: lhgr, endTime, timeStep, steps, outputs, initial, ...(kinetics ? { kinetics } : {}) };
}

/** The point-kinetics section: the reactivity, the neutronics constants, the feedback and the pin's share of the power. Nothing is defaulted. */
function parseKinetics(pk: unknown, err: ErrFn, qty: QtyFn, endTime: number | undefined): KineticsSpec | undefined {
  const base = "/transient/pointKinetics";
  let ok = true;
  const bad = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
    ok = false;
    err(code, field, message, extra);
  };
  if (!isObject(pk)) {
    err("E_SCHEMA_INVALID", base, "pointKinetics is an object");
    return undefined;
  }
  for (const key of ["reactivityInsertion", "insertionTime", "promptGenerationTime", "delayedGroups", "feedback", "initialPower", "core"]) {
    if (pk[key] === undefined) bad("E_TRANSIENT_INCOMPLETE", base + "/" + key, "the pointKinetics section needs '" + key + "'");
  }
  // delayed groups first: a reactivity in dollars needs their sum
  const groups: { beta: number; lambda: number }[] = [];
  if (pk.delayedGroups !== undefined) {
    if (!Array.isArray(pk.delayedGroups)) bad("E_SCHEMA_INVALID", base + "/delayedGroups", "delayedGroups is a list of {fraction, decayConstant} (an empty list means no delayed neutrons)");
    else if (pk.delayedGroups.length > 8) bad("E_OUT_OF_RANGE", base + "/delayedGroups", "at most 8 delayed groups");
    else {
      pk.delayedGroups.forEach((g: unknown, i: number) => {
        const at = base + "/delayedGroups/" + i;
        if (!isObject(g)) return bad("E_SCHEMA_INVALID", at, "each group is {fraction, decayConstant}");
        const beta = qty(g.fraction, "fraction", at + "/fraction");
        const lambda = qty(g.decayConstant, "rate", at + "/decayConstant");
        if (beta === undefined || lambda === undefined) return void (ok = false);
        if (!(beta > 0) || beta > 0.02) return bad("E_OUT_OF_RANGE", at + "/fraction", "a delayed fraction is above 0 and at most 0.02 (the whole set is about 0.0065 for U-235)");
        if (!(lambda >= 1e-4) || lambda > 1e3) return bad("E_OUT_OF_RANGE", at + "/decayConstant", "a precursor decay constant is between 1e-4 and 1e3 per second", { unit: "1/s" });
        groups.push({ beta, lambda });
      });
      const sum = groups.reduce((a, g) => a + g.beta, 0);
      if (sum > 0.05) bad("E_OUT_OF_RANGE", base + "/delayedGroups", "the delayed fractions add up to " + sum + "; more than 0.05 is not a fission reactor");
      if (pk.delayedGroups.length > 0 && !(typeof pk.delayedSource === "string" && pk.delayedSource !== "")) bad("E_PROP_MISSING", base + "/delayedSource", "the delayed-neutron data need a stated source (for example the data set and the fuel)");
    }
  }
  const beta = groups.reduce((a, g) => a + g.beta, 0);
  let reactivity: number | undefined;
  const ri = pk.reactivityInsertion;
  if (isObject(ri) && ri.unit === "$") {
    if (typeof ri.value !== "number" || !Number.isFinite(ri.value)) bad("E_UNITS", base + "/reactivityInsertion", "value must be a finite number");
    else if (!(beta > 0)) bad("E_UNITS", base + "/reactivityInsertion", "a reactivity in dollars needs delayed groups (a dollar is the total delayed fraction); give it in dk/k or pcm for a prompt-only model");
    else reactivity = ri.value * beta;
  } else if (ri !== undefined) {
    reactivity = qty(ri, "reactivity", base + "/reactivityInsertion");
    if (reactivity === undefined) ok = false;
  }
  if (reactivity !== undefined && !(reactivity > 0)) bad("E_OUT_OF_RANGE", base + "/reactivityInsertion", "the inserted reactivity must be positive (a pulse is a supercritical insertion)");
  else if (reactivity !== undefined && reactivity > 0.1) bad("E_OUT_OF_RANGE", base + "/reactivityInsertion", "the inserted reactivity is " + reactivity + " dk/k, above 0.1; check the unit", { unit: "dk/k" });
  const insertionTime = pk.insertionTime === undefined ? undefined : qty(pk.insertionTime, "time", base + "/insertionTime");
  if (insertionTime === undefined && pk.insertionTime !== undefined) ok = false;
  if (insertionTime !== undefined && insertionTime < 0) bad("E_OUT_OF_RANGE", base + "/insertionTime", "the insertion time cannot be negative (0 is a step)", { unit: "s" });
  if (insertionTime !== undefined && endTime !== undefined && insertionTime > endTime) bad("E_TIME", base + "/insertionTime", "the insertion takes longer than the run", { unit: "s" });
  const generationTime = pk.promptGenerationTime === undefined ? undefined : qty(pk.promptGenerationTime, "time", base + "/promptGenerationTime");
  if (generationTime === undefined && pk.promptGenerationTime !== undefined) ok = false;
  if (generationTime !== undefined && !(generationTime >= 1e-9 && generationTime <= 1)) bad("E_OUT_OF_RANGE", base + "/promptGenerationTime", "the prompt generation time is between 1 ns and 1 s (a thermal reactor is tens of microseconds to milliseconds)", { unit: "s" });
  const initialPower = pk.initialPower === undefined ? undefined : qty(pk.initialPower, "power", base + "/initialPower");
  if (initialPower === undefined && pk.initialPower !== undefined) ok = false;
  if (initialPower !== undefined && !(initialPower > 0)) bad("E_OUT_OF_RANGE", base + "/initialPower", "the initial power must be positive (a pulse grows from it)", { unit: "W" });

  // the feedback: the differential coefficient d rho / d T, negative (a pulse ends itself only by it)
  let feedback: KineticsSpec["feedback"] | undefined;
  const fb = pk.feedback;
  if (fb !== undefined) {
    const at = base + "/feedback";
    if (!isObject(fb)) bad("E_SCHEMA_INVALID", at, "feedback is an object");
    else {
      if (!(typeof fb.source === "string" && fb.source !== "")) bad("E_PROP_MISSING", at + "/source", "the feedback coefficient needs a stated source");
      if (fb.model === "constant") {
        if (fb.coefficient === undefined) bad("E_PROP_MISSING", at + "/coefficient", "the constant feedback model needs the coefficient (dk/k per K)");
        const a = fb.coefficient === undefined ? undefined : qty(fb.coefficient, "reactivityPerK", at + "/coefficient");
        if (a === undefined) ok = false;
        else if (!(a < 0)) bad("E_OUT_OF_RANGE", at + "/coefficient", "the prompt temperature coefficient must be negative: with zero or positive feedback the pulse is not ended by the fuel heating", { unit: "dk/k/K" });
        else feedback = { kind: "constant", alpha: a };
      } else if (fb.model === "linear") {
        for (const key of ["a", "b"]) if (fb[key] === undefined) bad("E_PROP_MISSING", at + "/" + key, "the linear feedback model alpha = a + b T needs '" + key + "'");
        const range = fb.validRange;
        if (!isObject(range) || range.min === undefined || range.max === undefined) bad("E_PROP_MISSING", at + "/validRange", "a temperature-dependent coefficient needs the temperature range it applies to (min and max)");
        const a = fb.a === undefined ? undefined : qty(fb.a, "reactivityPerK", at + "/a");
        const b = fb.b === undefined ? undefined : qty(fb.b, "reactivityPerK2", at + "/b");
        const lo = isObject(range) && range.min !== undefined ? qty(range.min, "temperature", at + "/validRange/min") : undefined;
        const hi = isObject(range) && range.max !== undefined ? qty(range.max, "temperature", at + "/validRange/max") : undefined;
        if (a === undefined || b === undefined || lo === undefined || hi === undefined) ok = false;
        else if (!(hi > lo)) bad("E_OUT_OF_RANGE", at + "/validRange", "range maximum must exceed the minimum", { unit: "K" });
        else if (!(a + b * lo < 0) || !(a + b * hi < 0)) bad("E_OUT_OF_RANGE", at, "the prompt temperature coefficient a + b T must be negative over its whole range", { unit: "dk/k/K", range: [lo, hi] });
        else feedback = { kind: "linear", a, b, range: [lo, hi] };
      } else if (fb.model !== undefined) bad("E_UNSUPPORTED", at + "/model", "unknown feedback model '" + String(fb.model) + "'; supported: 'constant' and 'linear'");
      else bad("E_PROP_MISSING", at + "/model", "the feedback needs a model: 'constant' or 'linear'");
      if (feedback === undefined) ok = false;
    }
  }

  // the pin's share of the power
  let pins: number | undefined;
  let activeLength: number | undefined;
  let peakingFactor: number | undefined;
  const core = pk.core;
  if (core !== undefined) {
    const at = base + "/core";
    if (!isObject(core)) bad("E_SCHEMA_INVALID", at, "core is {pins, activeLength, peakingFactor}");
    else {
      for (const key of ["pins", "activeLength", "peakingFactor"]) if (core[key] === undefined) bad("E_TRANSIENT_INCOMPLETE", at + "/" + key, "core needs '" + key + "'");
      if (core.pins !== undefined) {
        if (typeof core.pins !== "number" || !Number.isInteger(core.pins) || core.pins < 1 || core.pins > 1e6) bad("E_OUT_OF_RANGE", at + "/pins", "pins is a whole number from 1 to 1000000");
        else pins = core.pins;
      }
      if (core.activeLength !== undefined) {
        activeLength = qty(core.activeLength, "length", at + "/activeLength");
        if (activeLength === undefined) ok = false;
        else if (!(activeLength > 0)) bad("E_OUT_OF_RANGE", at + "/activeLength", "the active length must be positive", { unit: "m" });
      }
      if (core.peakingFactor !== undefined) {
        peakingFactor = qty(core.peakingFactor, "fraction", at + "/peakingFactor");
        if (peakingFactor === undefined) ok = false;
        else if (!(peakingFactor > 0 && peakingFactor <= 10)) bad("E_OUT_OF_RANGE", at + "/peakingFactor", "the peaking factor is the power of the modelled slice over the average pin's, above 0 and at most 10");
      }
    }
  }
  if (!ok || reactivity === undefined || insertionTime === undefined || generationTime === undefined || feedback === undefined || initialPower === undefined || pins === undefined || activeLength === undefined || peakingFactor === undefined || endTime === undefined || !(activeLength > 0)) return undefined;
  return { reactivity, insertionTime, generationTime, groups, feedback, initialPower, pins, activeLength, peakingFactor, endTime };
}
