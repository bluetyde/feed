// Semantic validation of a thermal case, before any run (docs/plans/02-case-and-materials.md).
// Structure comes from schema/case.schema.json; everything else is checked here.
// No expression is evaluated and no default is filled in: a missing datum is a named refusal.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import Ajv2020 from "ajv/dist/2020";
import { steadyEndTime } from "./steadyState";
import { Law, evaluate, fitPolynomial, lawOf, minimum } from "./conductivity";
import { NFI_RANGE, nfiConductivity } from "./uo2Nfi";
import { heatCapacityLaw } from "./heatCapacity";
import type { LimitRule } from "./limits";
import { alphaAt, ExpansionLaw, hotGeometry, HotRecord, HotSpec, MAX_EXPANSION_COEFFICIENT, MAX_REFERENCE_TEMPERATURE } from "./hotDimensions";
import { effectiveMechanics } from "./mechanicalEval";
import { HYDROGEN_RATIO_RANGE } from "./hydrogenPressure";
import { GeneratedPulse, KineticsError, KineticsSpec, generatePulse } from "./pointKinetics";
import { fuelMean, initialState } from "./transientResults";
import { AXIAL_CONDUCTION_WARNING, AXIAL_STEP_WARNING, AxialSpec, axialConductionEstimate, parseAxial, sliceCase, sliceLoads } from "./axial";
import { Dimension, toSI } from "./units";
import { trisoClosedForm, trisoSteadyEndTime } from "./trisoSolve";
import { MAX_TRISO_TRANSIENT_WORK, NormalizedTrisoTransient, parseTrisoTransient } from "./trisoTransient";
import { trisoInitialField } from "./trisoTransientModel";
import { HomogenisedDeps, HomogenisedSpec, mixtureConductivitySet, parseHomogenised } from "./compact";
import { NormalizedPebble, PEBBLE_MESH_MAXIMUM, PEBBLE_MESH_MINIMUM, pebbleClosedForm, pebbleInterfaceBias, pebbleSteadyEndTime } from "./pebble";
import { GAP_CONTACT_CONDUCTANCE, NormalizedTriso, TrisoLayer, parseTrisoGeometry, parseTrisoLimits, parseTrisoMesh, parseTrisoPower, particleVolumes } from "./triso";

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
  /** k = a / T + b (a in W/m, b in W/m/K, T in K) over a range. */
  | { kind: "reciprocal"; a: number; b: number; range: [number, number] }
  /** UO2 fuel, FRAPCON-3.4's modified NFI model at the case's burnup (src/core/uo2Nfi.ts): burnup in MWd/kgHM, density as a fraction of theoretical, gadolinia as a weight fraction. */
  | { kind: "uo2-nfi"; burnup: number; densityFraction: number; gadolinia: number; range: [number, number] }
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
  /** The coolant side as a table against time (plan 11): present when the case states `transient.boundaryHistory`; linear between points, applied at the end of each step. */
  boundaryHistory?: BoundaryHistory;
}

/** The outer boundary of a transient as tables against time: the same form as the case's own boundary (convective, or a prescribed wall). Times start at 0 and reach the end time. */
export type BoundaryHistory =
  | { kind: "convective"; times: number[]; bulkTemperature: number[]; heatTransferCoefficient: number[] }
  | { kind: "surface-temperature"; times: number[]; surfaceTemperature: number[] };

/**
 * The first change of the boundary history that the saved outputs cannot see (plan 11, Codex review 2026-10-14): inside one interval between two outputs the history goes more than
 * a tenth of its whole range beyond what its values at the two outputs show (a brief pulse in the coolant temperature, a film coefficient that dips and recovers). The checks compare
 * OFFBEAT with the independent solution at the outputs only, so an event between them is judged by the writer's tests, not by the result; the warning says so and names the interval.
 */
export function unseenHistoryChange(h: BoundaryHistory, endTime: number, outputs: number): string | undefined {
  const series: { name: string; values: number[] }[] = h.kind === "convective" ? [{ name: "bulk temperature", values: h.bulkTemperature }, { name: "film coefficient", values: h.heatTransferCoefficient }] : [{ name: "surface temperature", values: h.surfaceTemperature }];
  for (const s of series) {
    const range = Math.max(...s.values) - Math.min(...s.values);
    if (!(range > 0)) continue;
    const at = (t: number) => {
      if (t <= h.times[0]!) return s.values[0]!;
      for (let i = 1; i < h.times.length; i++) if (t <= h.times[i]!) return s.values[i - 1]! + ((s.values[i]! - s.values[i - 1]!) * (t - h.times[i - 1]!)) / (h.times[i]! - h.times[i - 1]!);
      return s.values[s.values.length - 1]!;
    };
    for (let k = 0; k < outputs; k++) {
      const a = (endTime * k) / outputs;
      const b = (endTime * (k + 1)) / outputs;
      const lo = Math.min(at(a), at(b));
      const hi = Math.max(at(a), at(b));
      for (let i = 0; i < h.times.length; i++) {
        const t = h.times[i]!;
        if (!(t > a && t < b)) continue;
        const v = s.values[i]!;
        if (v > hi + 0.1 * range || v < lo - 0.1 * range) return "the " + s.name + " reaches " + v + " at " + t + " s, between the outputs at " + a + " and " + b + " s, and is back within " + (0.1 * range).toPrecision(3) + " of the outputs' range at both ends";
      }
    }
  }
  return undefined;
}

/** A film coefficient below this is an adiabatic wall in everything but name; OFFBEAT accepts 0.001 (plan 11 B0). */
export const HISTORY_HTC_MIN = 1e-3;
export const HISTORY_HTC_MAX = 1e9;
export const HISTORY_TEMPERATURE_MAX = 1e4;

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
/** A conductivity outside this is a units mistake (vacuum insulation to diamond); it also keeps the closed forms away from overflow. W/m/K. */
export const CONDUCTIVITY_MIN = 1e-3;
export const CONDUCTIVITY_MAX = 1e5;
/** A radius outside this is a units mistake, and a smaller one underflows the cell areas. m. */
export const RADIUS_MIN = 1e-9;
export const RADIUS_MAX = 1e3;
export const HEAT_CAPACITY_MAX = 1e8;

/** Young's modulus (Pa) and Poisson's ratio of a solid: a constant, or E = a + b T over a stated temperature range (T in K). */
export type Elasticity = { kind: "constant"; E: number; nu: number; range?: [number, number] } | { kind: "linear"; a: number; b: number; nu: number; range: [number, number] };
/** The mechanical properties of one solid that a thermo-elastic run needs (docs/plans/09-mechanics.md M1). */
export interface MechanicalProps {
  elasticity: Elasticity;
  expansion: ExpansionLaw;
}

/** The mechanics section (plan 09 M2): what a thermo-elastic run needs besides the geometry, the temperatures and the material sets. */
export interface MechanicsSpec {
  /** The stress-free temperature, K. */
  referenceTemperature: number;
  /** free-axial: each solid takes its own axial strain, free of axial force (OFFBEAT's modifiedPlaneStrain); plane-strain: axially fixed. */
  plane: "free-axial" | "plane-strain";
  /** The penalty factor of the gap contact condition (the contact pressure depends on it: docs/spike/mechanics-probe.md). */
  penaltyFactor: number;
  /** The pressure on the cladding's outer surface, Pa. */
  coolantPressure: number;
  /** The gas pressure in the gap, an input with its source; absent for none (plan 09 M4). */
  internalPressure?: InternalPressure;
  /** Stress limits the case states, each with its source (plan 09 M4); FEED has none of its own. */
  stressLimits?: StressLimit[];
}

/** The von Mises stress of a solid's cells must stay at or below a strength that depends on the cell's temperature, a table the case states. */
export interface StressLimit {
  name: string;
  region: "fuel" | "cladding";
  /** Temperature (K) and strength (Pa) points, temperatures strictly increasing; linear in between, and not defined outside. */
  table: { temperature: number; strength: number }[];
  source: string;
}

/** A constant pressure, or the hydrogen dissociation pressure of the hydride fuel at a fuel temperature the case names (src/core/hydrogenPressure.ts). */
export type InternalPressure =
  | { kind: "constant"; pressure: number; source: string }
  | { kind: "hydrogen-zrh"; hZrRatio: number; basis: "peak" | "mean"; source: string };

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
  /** The burnup the fuel's conductivity was evaluated at (MWd/kgHM, heavy-metal basis) and where it comes from; present exactly when the fuel's conductivity is the burnup-dependent law. */
  burnup?: { value: number; source: string };
  /** Present when the case asks for hot dimensions: the radii above are then the hot ones and this holds the cold ones, the mean temperatures and the factors (src/core/hotDimensions.ts). */
  hot?: HotRecord;
  /** Present when the case asks for mechanics; its material properties are in `mechanical`. */
  mechanics?: MechanicsSpec;
  /** The mechanical property sets of both solids, present when each has a valid mechanical.elasticity and mechanical.thermalExpansion (a thermal run does not use them). */
  mechanical?: { fuel: MechanicalProps; cladding: MechanicalProps };
  /** True for a plate (plan 12, A4): `fuelRadius` is then the half-thickness of the meat, `claddingInnerRadius` and `claddingOuterRadius` the distances of the cladding's faces from the insulated mid-plane, `qPrime` the heat rate per unit height and width. */
  plate?: true;
  /** Present when the case is an axial stack (plan 12): `qPrime` is then the AVERAGE heat rate over the heated length and the slices take their own from the shape (src/core/axial.ts). */
  axial?: AxialSpec;
  /** Present when the fuel is a compact of coated particles in a matrix (plan 13, T4): `fuelConductivity` is then the fitted mixture and `qPrime` the compact's power density times its cross-section. */
  compact?: HomogenisedSpec;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Present only when ok. */
  normalized?: NormalizedCase;
  /** Present instead of `normalized` when ok and the case is a coated particle (plan 13): its own normalised form (run by src/core/trisoWriter.ts, read by src/core/trisoResults.ts). */
  triso?: NormalizedTriso;
  /** Present instead of `normalized` when ok and the case is a pebble (plan 13, T4): its own normalised form. */
  pebble?: NormalizedPebble;
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

  // A coated particle (plan 13) has its own sections and its own normalised form
  if (c.geometry?.kind === "triso") return validateTriso(c, issues, err, qty, positive);
  // a pebble (plan 13, T4) has its own sections and its own normalised form; a compact is a pin whose fuel is derived from the `compact` block
  if (c.geometry?.kind === "pebble") return validatePebble(c, issues, err, qty, positive);
  if (c.compact !== undefined) return validateCompact(c, issues, err, qty, positive);

  // A pin or a plate has a fuel and a cladding and a fuel and a cladding mesh (the schema leaves them optional because a particle has other regions)
  for (const k of ["fuel", "cladding"]) if (!isObject(c.materials[k])) err("E_SCHEMA_INVALID", "/materials/" + k, "missing: the " + k + " material (an object with a materialId, a revision and sets)");
  for (const k of ["fuelCells", "claddingCells"]) if (!isObject(c.mesh) || c.mesh[k] === undefined) err("E_SCHEMA_INVALID", "/mesh/" + k, "missing: the number of " + (k === "fuelCells" ? "fuel" : "cladding") + " cells");
  if (issues.length > 0) return finish(issues);

  // Scope of V1
  // A case either is thermal-only or asks for mechanics, which needs its section (docs/plans/09-mechanics.md M2); irradiation is not offered.
  if (c.mechanics !== undefined && c.assumptions.thermalOnly !== false) err("E_SCHEMA_INVALID", "/assumptions/thermalOnly", "a case with a mechanics section is not thermal-only: set assumptions.thermalOnly to false");
  if (c.assumptions.thermalOnly === false && c.mechanics === undefined) err("E_PROP_MISSING", "/mechanics", "assumptions.thermalOnly is false, which asks for mechanics, but the case has no mechanics section (reference temperature, plane condition, contact and coolant pressure)");
  // steadyState false means a thermal transient: it needs the transient section and heat capacities (checked below). Nothing is assumed.
  const isTransient = c.assumptions.steadyState === false;
  if (!isTransient && c.transient !== undefined) err("E_TRANSIENT_INCOMPLETE", "/transient", "the case has a transient section but assumptions.steadyState is true; set it to false to run the transient, or remove the section");
  if (isTransient && c.transient === undefined) err("E_TRANSIENT_INCOMPLETE", "/transient", "assumptions.steadyState is false, so the case needs a transient section (power history, end time, time step, outputs, initial temperature)");
  const isPlate = c.geometry?.kind === "plate";
  if (c.geometry?.kind !== undefined && c.geometry.kind !== "plate" && c.geometry.kind !== "pin") err("E_GEOMETRY", "/geometry/kind", "the geometry kind is 'pin' (the default), 'plate' or 'triso', got '" + String(c.geometry.kind) + "'");
  if (c.assumptions.geometry !== (isPlate ? "1D-slab" : "1D-radial")) err("E_UNSUPPORTED", "/assumptions/geometry", (isPlate ? "a plate is geometry '1D-slab'" : "V1 supports geometry '1D-radial' only") + ", got '" + String(c.assumptions.geometry) + "'");
  if (c.power?.radialShape !== undefined && c.power.radialShape !== "uniform") err("E_UNSUPPORTED", "/power/radialShape", "V1 supports a uniform radial power shape only");

  // Geometry
  const radius = (value: unknown, field: string, what: string): number | undefined => {
    if (value === undefined) return undefined; // missing: already reported
    const v = qty(value, "length", field);
    if (v === undefined) return undefined;
    if (!(v > 0)) {
      err("E_GEOMETRY", field, what + " must be positive", { unit: "m" });
      return undefined;
    }
    if (v < RADIUS_MIN || v > RADIUS_MAX) {
      err("E_GEOMETRY", field, what + " " + v + " m is outside " + RADIUS_MIN + " to " + RADIUS_MAX + " m; check the units", { unit: "m" });
      return undefined;
    }
    return v;
  };
  let Rf: number | undefined;
  let Rci: number | undefined;
  let Rco: number | undefined;
  if (isPlate) {
    // a plate (plan 12, A4): the meat's half-thickness from the insulated mid-plane, the gap's thickness (zero allowed, as for a pin with an effective conductance) and the cladding's thickness
    const PLATE_KEYS = ["kind", "fuelHalfThickness", "gapThickness", "claddingThickness"];
    for (const k of Object.keys(c.geometry)) if (!PLATE_KEYS.includes(k)) err("E_GEOMETRY", "/geometry/" + k, "unknown key '" + k + "' for a plate (it has " + PLATE_KEYS.join(", ") + "); a plate has no radii and no central hole");
    for (const k of PLATE_KEYS.slice(1)) if (c.geometry[k] === undefined) err("E_SCHEMA_INVALID", "/geometry/" + k, "missing: a plate needs fuelHalfThickness, gapThickness and claddingThickness");
    const half = c.geometry.fuelHalfThickness === undefined ? undefined : radius(c.geometry.fuelHalfThickness, "/geometry/fuelHalfThickness", "fuel half-thickness");
    const tc = c.geometry.claddingThickness === undefined ? undefined : radius(c.geometry.claddingThickness, "/geometry/claddingThickness", "cladding thickness");
    let gap0: number | undefined;
    if (c.geometry.gapThickness !== undefined) {
      gap0 = qty(c.geometry.gapThickness, "length", "/geometry/gapThickness");
      if (gap0 !== undefined && gap0 < 0) {
        err("E_GEOMETRY", "/geometry/gapThickness", "the gap thickness cannot be negative (use 0 for no cold gap)", { unit: "m" });
        gap0 = undefined;
      }
    }
    if (half !== undefined) Rf = half;
    if (half !== undefined && gap0 !== undefined) Rci = half + gap0;
    if (Rci !== undefined && tc !== undefined) Rco = Rci + tc;
    if (c.hotDimensions !== undefined) err("E_UNSUPPORTED", "/hotDimensions", "hot dimensions are for pins: the plate's expansion is not modelled");
    if (c.mechanics !== undefined) err("E_UNSUPPORTED", "/mechanics", "mechanics is for pins: a plate has no thermo-elastic solution here");
    if (c.burnup !== undefined) err("E_UNSUPPORTED", "/burnup", "a burnup is for pins in this release");
    if (c.transient?.pointKinetics !== undefined) err("E_UNSUPPORTED", "/transient/pointKinetics", "a generated pulse is for pins: its feedback is that of the pin's fuel");
  } else {
    for (const k of ["fuelRadius", "claddingInnerRadius", "claddingOuterRadius"]) if (c.geometry[k] === undefined) err("E_SCHEMA_INVALID", "/geometry/" + k, "missing: a pin needs fuelRadius, claddingInnerRadius and claddingOuterRadius");
    Rf = radius(c.geometry.fuelRadius, "/geometry/fuelRadius", "fuel radius");
    Rci = radius(c.geometry.claddingInnerRadius, "/geometry/claddingInnerRadius", "cladding inner radius");
    Rco = radius(c.geometry.claddingOuterRadius, "/geometry/claddingOuterRadius", "cladding outer radius");
  }
  // Optional central hole in the fuel. Its surface is treated as insulated (nothing is conducted into whatever fills it).
  let Rfi = 0;
  if ((c.geometry as Record<string, unknown>).fuelInnerRadius !== undefined) {
    const r = qty((c.geometry as Record<string, unknown>).fuelInnerRadius, "length", "/geometry/fuelInnerRadius");
    if (r !== undefined) {
      if (r < 0) err("E_GEOMETRY", "/geometry/fuelInnerRadius", "the central hole radius cannot be negative (use 0 for solid fuel)", { unit: "m" });
      else if (Rf !== undefined && r > 0 && !(r < Rf)) err("E_GEOMETRY", "/geometry/fuelInnerRadius", "the central hole radius must be smaller than the fuel radius", { unit: "m" });
      else if (r > 0 && r < RADIUS_MIN) err("E_GEOMETRY", "/geometry/fuelInnerRadius", "the central hole radius " + r + " m is below " + RADIUS_MIN + " m; use 0 for solid fuel, or check the units", { unit: "m" });
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
  if (!isTransient && !isPlate && qPrime !== undefined && qPrime > POWER_SANITY_MAX) {
    issues.push({ code: "W_POWER_RANGE", severity: "warning", field: "/power/linearHeatRate", message: "linear heat rate is above the sanity range (" + POWER_SANITY_MAX + " W/m); kept as given", unit: "W/m", range: [0, POWER_SANITY_MAX] });
  }

  // Gap
  const hGap = parseGap(c.gap as Record<string, unknown>, err, positive);

  // Boundary: exactly one complete form
  const boundary = parseBoundary(c.boundary as Record<string, unknown>, err, positive);

  // Materials: a thermal model needs a thermal conductivity set. Composition and density do not satisfy it.
  const burnupSpec = c.burnup === undefined ? undefined : parseBurnup(c.burnup, err, qty);
  const fuelK = conductivity(c.materials.fuel, "fuel", err, qty, burnupSpec ? burnupSpec.value : 0);
  // The burnup and the fuel's conductivity go together: a fuel that depends on burnup needs one (0 for fresh fuel), and a burnup that changes nothing is refused.
  if (fuelK && fuelK.kind === "uo2-nfi" && c.burnup === undefined) err("E_PROP_MISSING", "/burnup", "the fuel's conductivity (uo2-nfi) depends on burnup and the case states none; give 0 for fresh fuel");
  if (fuelK && fuelK.kind !== "uo2-nfi" && c.burnup !== undefined) err("E_UNSUPPORTED", "/burnup", "the fuel's conductivity model '" + fuelK.kind + "' does not depend on burnup, so a burnup would change nothing; use the uo2-nfi model or remove the burnup");
  if (c.burnup !== undefined && isTransient) err("E_UNSUPPORTED", "/burnup", "a burnup is for steady cases in this release: the conductivity would be frozen over the transient");
  const claddingK = conductivity(c.materials.cladding, "cladding", err, qty);
  // Mechanical property sets (plan 09 M1): checked whenever a material carries them; a case that asks for mechanics (assumptions.thermalOnly false) must have both sets for both solids
  const mechFuel = mechanicalSets(c.materials.fuel, "fuel", err, qty, c.assumptions.thermalOnly === false);
  const mechCladding = mechanicalSets(c.materials.cladding, "cladding", err, qty, c.assumptions.thermalOnly === false);

  const limits = c.limits === undefined ? undefined : parseLimits(c.limits, err, qty);
  const hotSpec = c.hotDimensions === undefined ? undefined : parseHot(c.hotDimensions, err, qty);
  const mechanicsSpec = c.mechanics === undefined ? undefined : parseMechanics(c.mechanics, err, qty);
  if (c.mechanics !== undefined) {
    if (isTransient) err("E_UNSUPPORTED", "/mechanics", "mechanics is for steady cases in this release: a transient needs the time history of the stress, which is not offered");
    if (c.hotDimensions !== undefined) err("E_UNSUPPORTED", "/hotDimensions", "a mechanics case computes the thermal expansion itself: hot dimensions would count it twice, so the two cannot be combined");
    if (c.burnup !== undefined) err("E_UNSUPPORTED", "/burnup", "mechanics with a burnup is not offered: the burnup conductivity is frozen and the mechanical response of burnt fuel (swelling, relocation) is not modelled");
  }
  // The axial stack (plan 12, A1): steady cases only until the transient stack is built (A3); not combined with mechanics, hot dimensions or burnup.
  const axialSpec = c.axial === undefined ? undefined : parseAxial(c.axial, boundary?.kind, err, qty);
  if (c.axial !== undefined) {
    if (isTransient && c.transient?.pointKinetics !== undefined) err("E_UNSUPPORTED", "/axial", "an axial stack with a point-kinetics pulse is not offered: the pulse is generated from one fuel temperature; give a power history, or remove the axial section");
    if (isTransient && axialSpec?.boundary !== undefined && c.transient?.boundaryHistory !== undefined) err("E_UNSUPPORTED", "/axial/boundary", "an axial coolant table together with a boundary history is not offered: give the coolant as a table against height or against time, not both (a history alone applies to every slice equally)");
    if (c.mechanics !== undefined) err("E_UNSUPPORTED", "/axial", "an axial stack with mechanics is not offered: the stress of each slice would need its own axial and contact inputs; remove one of them");
    if (c.hotDimensions !== undefined) err("E_UNSUPPORTED", "/axial", "an axial stack with hot dimensions is not offered: each slice would have its own hot radii; remove one of them");
    if (c.burnup !== undefined) err("E_UNSUPPORTED", "/axial", "an axial stack with a burnup is not offered: the burnup would be one number for every slice; remove one of them");
  }
  if (c.hotDimensions !== undefined && isTransient) err("E_UNSUPPORTED", "/hotDimensions", "hot dimensions are for steady cases: in a transient the temperatures, and so the radii, change with time");

  // Transient: heat capacities of both solids and the time section.
  let fuelCp: HeatCapacity | undefined;
  let claddingCp: HeatCapacity | undefined;
  let transient: NormalizedTransient | undefined;
  if (isTransient) {
    fuelCp = heatCapacity(c.materials.fuel, "fuel", err, qty);
    claddingCp = heatCapacity(c.materials.cladding, "cladding", err, qty);
    if (c.transient !== undefined) transient = parseTransient(c.transient, err, qty);
    if (transient && transient.boundaryHistory && boundary) {
      const hist = transient.boundaryHistory;
      if (hist.kind !== boundary.kind) {
        err("E_BOUNDARY_INCOMPLETE", "/transient/boundaryHistory", "the boundary history is in the " + hist.kind + " form but the case's own boundary is " + boundary.kind + ": use the same form in both");
        transient = undefined;
      } else if (transient.initial.kind === "steady") {
        // the run starts at the steady state of the case's own boundary; a history that begins elsewhere would not be starting from that state
        const same = hist.kind === "convective" && boundary.kind === "convective"
          ? Math.abs(hist.bulkTemperature[0]! - boundary.bulkTemperature) <= 1e-9 * boundary.bulkTemperature && Math.abs(hist.heatTransferCoefficient[0]! - boundary.heatTransferCoefficient) <= 1e-9 * boundary.heatTransferCoefficient
          : hist.kind === "surface-temperature" && boundary.kind === "surface-temperature" && Math.abs(hist.surfaceTemperature[0]! - boundary.surfaceTemperature) <= 1e-9 * boundary.surfaceTemperature;
        if (!same) {
          err("E_TRANSIENT_INCOMPLETE", "/transient/boundaryHistory/0", "the run starts at the steady state of the case's own boundary, so the history's value at time 0 must equal it (bulk temperature, heat-transfer coefficient or surface temperature); otherwise start from a uniform temperature");
          transient = undefined;
        }
      }
    }
    if (transient && transient.boundaryHistory) {
      const unseen = unseenHistoryChange(transient.boundaryHistory, transient.endTime, transient.outputs);
      if (unseen) issues.push({ code: "W_BOUNDARY_BETWEEN_OUTPUTS", severity: "warning", field: "/transient/boundaryHistory", message: unseen + ". The outputs of the run (and so the checks against the independent solution) cannot see it; add outputs, or accept that this part of the history is judged by the files FEED writes and not by the result." });
    }
    if (transient) {
      qPrime = Math.max(...transient.linearHeatRate);
      // the heat capacity laws must hold at a uniform starting temperature (a steady start is checked below, on its field), and the work must fit the budget
      const start = transient.initial.kind === "uniform" ? transient.initial.temperature : undefined;
      for (const [region, k] of [["fuel", fuelK], ["cladding", claddingK]] as const) {
        const kStart = start !== undefined && k ? evaluate(lawOf(k), start) : undefined;
        if (kStart !== undefined && !(Number.isFinite(kStart) && kStart > 0)) {
          err("E_OUT_OF_RANGE", "/transient/initialTemperature", "the " + region + " conductivity at the initial temperature " + start + " K is " + kStart.toPrecision(4) + " W/m/K: a conductivity law that is positive over its stated range can be zero or negative where the pin starts", { unit: "W/m/K" });
          transient = undefined;
          break;
        }
      }
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
    const work = ((m.fuelCells ?? 0) + (m.claddingCells ?? 0)) * transient.steps * (axialSpec?.slices ?? 1);
    if (work > MAX_TRANSIENT_WORK) {
      err("E_TIME", "/transient/timeStep", "cells x steps" + (axialSpec ? " x slices" : "") + " = " + work + " exceeds the budget of " + MAX_TRANSIENT_WORK + " (" + transient.steps + " steps on " + ((m.fuelCells ?? 0) + (m.claddingCells ?? 0)) + " cells" + (axialSpec ? " in each of " + axialSpec.slices + " slices" : "") + "); use a coarser mesh, fewer slices or a longer step", { unit: "s" });
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
      ...(mechanicsSpec ? { mechanics: mechanicsSpec } : {}),
      ...(mechFuel && mechCladding ? { mechanical: { fuel: mechFuel, cladding: mechCladding } } : {}),
      ...(fuelK.kind === "uo2-nfi" && burnupSpec ? { burnup: burnupSpec } : {}),
      ...(axialSpec ? { axial: axialSpec } : {}),
      ...(isPlate ? { plate: true as const } : {}),
    };
    // Hot dimensions: the radii above are cold; replace them with the radii each solid has at its own mean temperature (the temperatures and the radii are iterated together).
    if (hotSpec && !isTransient) {
      const h = hotGeometry(result.normalized, hotSpec);
      if (h.ok) {
        Object.assign(result.normalized, h.radii, { hot: h.record });
        for (const solid of ["fuel", "cladding"] as const) {
          const sr = h.record[solid];
          if (sr.outOfRange && sr.expansion.kind === "linear") {
            result.warnings.push({ code: "W_EXPANSION_RANGE", severity: "warning", field: "/hotDimensions/" + solid, message: "the " + solid + " runs from " + sr.temperatureRange[0].toFixed(1) + " to " + sr.temperatureRange[1].toFixed(1) + " K, outside the " + sr.expansion.range[0] + " to " + sr.expansion.range[1] + " K its expansion coefficient is stated for; the formula is applied beyond it, as given" });
          }
        }
      }
      if (!h.ok) {
        result.ok = false;
        // the cause decides the code: a closed gap is a geometry problem, a conductivity that cannot be solved is the material's, a coefficient that goes non-positive is the section's
        const [code, field] = h.kind === "geometry" ? ["E_GEOMETRY", "/hotDimensions"] : h.kind === "temperatures" ? ["E_OUT_OF_RANGE", "/materials"] : ["E_OUT_OF_RANGE", "/hotDimensions"];
        result.errors.push({ code, severity: "error", field, message: h.reason });
        delete result.normalized;
      }
    }
    // Mechanics: a modulus or an expansion coefficient stated as a law of temperature is reduced to a constant for the solver (src/core/mechanicalEval.ts); say where a solid's temperatures leave the range a law is stated for.
    if (result.normalized && result.normalized.mechanics && result.normalized.mechanical) {
      const eff = effectiveMechanics(result.normalized);
      for (const solid of ["fuel", "cladding"] as const) {
        const s = eff?.[solid];
        if (!s) continue;
        const range = "from " + s.temperatureRange[0].toFixed(1) + " to " + s.temperatureRange[1].toFixed(1) + " K";
        if (s.elasticityOutOfRange) result.warnings.push({ code: "W_ELASTICITY_RANGE", severity: "warning", field: "/materials/" + solid + "/sets/mechanical.elasticity", message: "the " + solid + " runs " + range + ", outside the range its Young's modulus law is stated for: the modulus is applied beyond it as given" });
        if (s.expansionOutOfRange) result.warnings.push({ code: "W_EXPANSION_RANGE", severity: "warning", field: "/materials/" + solid + "/sets/mechanical.thermalExpansion", message: "the " + solid + " runs " + range + " (and the reference temperature counts), outside the range its expansion law is stated for: the formula is applied beyond it as given" });
      }
    }
    // A transient that starts from a steady operating state needs that state to exist and to lie where the heat capacity laws hold (the uniform start is checked above).
    const normalized = result.normalized;
    if (!normalized) return result;
    if (normalized.axial) {
      const loads = sliceLoads(normalized);
      const peak = Math.max(...loads.map((l) => l.linearHeatRate));
      if (peak > POWER_SANITY_MAX && !normalized.transient && !normalized.plate) {
        result.warnings.push({ code: "W_POWER_RANGE", severity: "warning", field: "/power/linearHeatRate", message: "the hottest slice's linear heat rate " + peak.toFixed(0) + " W/m is above the sanity range (" + POWER_SANITY_MAX + " W/m); kept as given", unit: "W/m", range: [0, POWER_SANITY_MAX] });
      }
      // a shape that changes a great deal between two neighbouring slices is not resolved by this many slices
      const q = loads.map((l) => l.linearHeatRate);
      const big = Math.max(...q);
      for (let i = 1; i < q.length; i++) {
        if (big > 0 && Math.abs(q[i]! - q[i - 1]!) > AXIAL_STEP_WARNING * big) {
          result.warnings.push({ code: "W_AXIAL_SHAPE_STEP", severity: "warning", field: "/axial/slices", message: "slices " + i + " and " + (i + 1) + " differ in heat rate by " + (100 * Math.abs(q[i]! - q[i - 1]!) / big).toFixed(0) + " % of the largest slice's (" + q[i - 1]!.toFixed(0) + " and " + q[i]!.toFixed(0) + " W/m): the shape is not resolved by " + normalized.axial.slices + " slices; use more slices or a gentler shape" });
          break;
        }
      }
      let est;
      try {
        est = axialConductionEstimate(normalized);
      } catch (_e) {
        est = undefined;
      }
      if (est && est.fraction > AXIAL_CONDUCTION_WARNING) {
        result.warnings.push({ code: "W_AXIAL_CONDUCTION", severity: "warning", field: "/axial", message: "heat flow along the height could change the temperatures by about " + (100 * est.fraction).toFixed(1) + " % of the largest rise (the solver includes it; FEED's one-dimensional checks per slice do not): the heated length is short for this shape and these conductivities" });
      }
    }
    const tn = normalized.transient;
    if (tn && tn.initial.kind === "steady") {
      const field = (() => {
        try {
          if (normalized.axial) {
            // a stack starts every slice at its own steady state; the heat capacity ranges are checked over all of them (fuel cells of every slice, then cladding cells)
            const sts = sliceLoads(normalized).map((l) => initialState(sliceCase(normalized, l)));
            const nf0 = normalized.mesh.fuelCells;
            const T = [...sts.flatMap((s) => s.T.slice(0, nf0)), ...sts.flatMap((s) => s.T.slice(nf0))];
            return { T, wall: sts[0]!.wall, peak: Math.max(...sts.map((s) => s.peak)), fuelPeak: Math.max(...sts.map((s) => s.fuelPeak)) };
          }
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
        const nf = n.mesh.fuelCells * (n.axial?.slices ?? 1);
        for (const [region, cp, from, to] of [["fuel", n.fuelHeatCapacity, 0, nf], ["cladding", n.claddingHeatCapacity, nf, field.T.length]] as const) {
          if (!cp || cp.kind === "constant") continue;
          const part = field.T.slice(from, to);
          const lo = Math.min(...part);
          const hi = Math.max(...part);
          if (lo < cp.range[0] || hi > cp.range[1]) {
            result.ok = false;
            result.errors.push({ code: "E_OUT_OF_RANGE", severity: "error", field: "/transient/initialSteadyLinearHeatRate", message: "the steady state at " + tn.initial.linearHeatRate + " W/m" + (n.axial ? " on average (each slice starts at its own: up to " + (tn.initial.linearHeatRate * Math.max(...sliceLoads(n).map((l) => l.factor))).toFixed(0) + " W/m)" : "") + " puts the " + region + " at " + lo.toFixed(0) + " to " + hi.toFixed(0) + " K, outside the stated range of its heat capacity law (" + cp.range[0] + " to " + cp.range[1] + " K)", unit: "K", range: cp.range });
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
      // The time scale needs the pin's temperatures, which the closed form finds by integrating the conductivity: a law that is positive over its stated range can still reach
      // zero further out, where the pin may run. That is a refusal with the reason, not an exception out of the validator.
      let h: ReturnType<typeof steadyEndTime>;
      try {
        h = steadyEndTime(normalized);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        result.ok = false;
        result.errors.push({ code: "E_OUT_OF_RANGE", severity: "error", field: "/materials", message: "the temperatures of this pin cannot be found: " + e.message + ". A conductivity that is positive over its stated range can still reach zero outside it, where the pin runs; widen the range with a law that stays positive, or change the case" });
        delete result.normalized;
        return result;
      }
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
  mechanicalSets(material, region, err as ErrFn, qty, false);
  return finish(issues);
}

type PositiveFn = (value: unknown, dim: Dimension, field: string, what: string, unit: string) => number | undefined;

/** The gap section: only a stated constant conductance with its source (a closed or contacting gap needs mechanics; the solver's gas-gap model comes later). */
export function parseGap(gap: Record<string, unknown>, err: ErrFn, positive: PositiveFn): number | undefined {
  let hGap: number | undefined;
  if (gap.model === "constant-conductance") {
    if (gap.conductance === undefined) err("E_PROP_MISSING", "/gap/conductance", "the constant-conductance gap model needs the gap conductance (W/m2/K)");
    else hGap = positive(gap.conductance, "htc", "/gap/conductance", "gap conductance", "W/m2/K");
    if (typeof gap.source !== "string" || gap.source.trim() === "") err("E_PROP_MISSING", "/gap/source", "the gap conductance needs a stated source");
  } else if (gap.model === "closed" || gap.model === "contact") {
    err("E_UNSUPPORTED", "/gap/model", "a closed or contacting gap needs mechanics to know the contact state; V1 requires an explicit gap conductance");
  } else if (gap.model === "gas-gap") {
    err("E_UNSUPPORTED", "/gap/model", "the solver's gas-gap model is planned after V1; use 'constant-conductance'");
  } else {
    err("E_UNSUPPORTED", "/gap/model", "unknown gap model '" + String(gap.model) + "'");
  }
  return hGap;
}

/** The coolant boundary: exactly one complete form, a bulk temperature with a heat-transfer coefficient or a prescribed surface temperature. */
export function parseBoundary(b: Record<string, unknown>, err: ErrFn, positive: PositiveFn): NormalizedCase["boundary"] | undefined {
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
  return boundary;
}

/**
 * A coated particle (plan 13, T1): a sphere of a kernel and two to four coating layers, thermal and steady only. It has its own normalised form (`triso` on the result); a pin's sections
 * that have no meaning for it (mechanics, burnup, hot dimensions, an axial stack, limits, a transient) are refused by name, not ignored.
 */
function validateTriso(c: Record<string, any>, issues: Issue[], err: ErrFn, qty: QtyFn, positive: PositiveFn): ValidationResult {
  const warn = (code: string, field: string, message: string, extra: Record<string, unknown> = {}) => issues.push({ code, severity: "warning", field, message, ...extra } as Issue);
  if (c.assumptions.geometry !== "1D-sphere") err("E_UNSUPPORTED", "/assumptions/geometry", "a particle is geometry '1D-sphere', got '" + String(c.assumptions.geometry) + "'");
  if (c.assumptions.thermalOnly !== true) err("E_UNSUPPORTED", "/assumptions/thermalOnly", "a particle is thermal only: its mechanics (the stress in the SiC, the swelling and creep of the carbon, the gas pressure) are decision D1 of plan 13 and not offered");
  // steadyState false means a thermal transient: it needs the transient section and the regions' heat capacities (checked below), as for a pin. Nothing is assumed.
  const isTransient = c.assumptions.steadyState === false;
  if (!isTransient && c.transient !== undefined) err("E_TRANSIENT_INCOMPLETE", "/transient", "the case has a transient section but assumptions.steadyState is true; set it to false to run the transient, or remove the section");
  if (isTransient && c.transient === undefined) err("E_TRANSIENT_INCOMPLETE", "/transient", "assumptions.steadyState is false, so the case needs a transient section (power history, end time, time step, outputs, initial temperature)");
  for (const [key, why] of [
    ["mechanics", "a particle has no mechanics here"],
    ["hotDimensions", "hot dimensions are for pins"],
    ["burnup", "a burnup is for pins in this release"],
    ["axial", "an axial stack is for pins and plates"],
  ] as const) {
    if (c[key] !== undefined) err("E_UNSUPPORTED", "/" + key, why + "; remove the section");
  }
  const radius = (value: unknown, field: string, what: string): number | undefined => {
    const v = qty(value, "length", field);
    if (v === undefined) return undefined;
    if (!(v > 0)) {
      err("E_GEOMETRY", field, what + " must be positive", { unit: "m" });
      return undefined;
    }
    if (v < RADIUS_MIN || v > RADIUS_MAX) {
      err("E_GEOMETRY", field, what + " " + v + " m is outside " + RADIUS_MIN + " to " + RADIUS_MAX + " m; check the units", { unit: "m" });
      return undefined;
    }
    return v;
  };
  const geo = parseTrisoGeometry(c.geometry, radius, err);
  const names: string[] = geo ? geo.layers.map((l) => l.name) : [];
  const volumes = geo ? particleVolumes(geo.kernelRadius, geo.outerRadius) : undefined;
  const powerRaw: Record<string, unknown> = isObject(c.power) ? c.power : {};
  let power: ReturnType<typeof parseTrisoPower>;
  // a steady particle states its power in one of three forms; a transient takes it from transient.powerHistory instead
  if (isTransient) {
    if (c.power !== undefined) err("E_TRANSIENT_INCOMPLETE", "/power", "a transient case takes its power from transient.powerHistory; remove the power section");
  } else if (volumes) power = parseTrisoPower(powerRaw, volumes, err, qty, warn);
  else if (powerRaw.linearHeatRate !== undefined) err("E_UNSUPPORTED", "/power/linearHeatRate", "a particle's power is per particle, per kernel volume or per compact volume; the linear heat rate is for pins");
  const hGap = parseGap(c.gap as Record<string, unknown>, err, positive);
  if (hGap !== undefined && hGap > GAP_CONTACT_CONDUCTANCE) {
    warn("W_GAP_CONTACT", "/gap/conductance", "a gap conductance of " + hGap.toExponential(2) + " W/m2/K is a buffer in contact with the next layer (OFFBEAT's own gap model gives about " + GAP_CONTACT_CONDUCTANCE.toExponential(0) + " for a zero-width gap): an irradiated particle usually has a gap, so this understates the kernel temperature", { unit: "W/m2/K" });
  }
  const boundary = parseBoundary(c.boundary as Record<string, unknown>, err, positive);
  // the materials: one for the kernel and one for each layer, named like them; a thermal conductivity set each (conductivity() itself refuses the burnup-dependent UO2 law for any region but a pin's fuel)
  const materials: Record<string, unknown> = isObject(c.materials) ? c.materials : {};
  const wanted = ["kernel", ...names];
  // (with an unreadable geometry the layers are not known, so no material is judged against them: one fault, one code)
  if (geo) {
    for (const k of Object.keys(materials)) {
      if (!wanted.includes(k)) err("E_GEOMETRY", "/materials/" + k, "'" + k + "' is not a region of this particle (its materials are " + wanted.join(", ") + ")");
    }
  }
  const kernelRef = materials.kernel;
  let kernelK: Conductivity | undefined;
  if (isObject(kernelRef)) kernelK = conductivity(kernelRef, "kernel", err, qty);
  else err("E_SCHEMA_INVALID", "/materials/kernel", "missing: the kernel's material (an object with a materialId, a revision and sets)");
  const layerK: (Conductivity | undefined)[] = names.map((n) => {
    const m = materials[n];
    if (!isObject(m)) {
      err("E_SCHEMA_INVALID", "/materials/" + n, "missing: the material of the " + n + " layer (an object with a materialId, a revision and sets)");
      return undefined;
    }
    return conductivity(m, n, err, qty);
  });
  const cells = geo && isObject(c.mesh) ? parseTrisoMesh(c.mesh, names, err) : undefined;
  // the transient (stage 3 of T3): the heat capacity of every region and the section itself; the outside's table follows the pin's rules
  let transient: NormalizedTrisoTransient | undefined;
  let capacities: HeatCapacity[] | undefined;
  if (isTransient) {
    const caps = ["kernel", ...names].map((r) => (isObject(materials[r]) ? heatCapacity(materials[r] as Record<string, any>, r, err, qty) : undefined));
    if (c.transient !== undefined) transient = isObject(c.transient) ? parseTrisoTransient(c.transient, err, qty, (raw, end) => parseBoundaryHistory(raw, err, qty, end)) : void err("E_SCHEMA_INVALID", "/transient", "the transient section is an object");
    if (caps.every((x) => x !== undefined)) capacities = caps as HeatCapacity[];
    if (transient && transient.boundaryHistory && boundary) {
      const hist = transient.boundaryHistory;
      if (hist.kind !== boundary.kind) {
        err("E_BOUNDARY_INCOMPLETE", "/transient/boundaryHistory", "the boundary history is in the " + hist.kind + " form but the case's own boundary is " + boundary.kind + ": use the same form in both");
        transient = undefined;
      } else if (transient.initial.kind === "steady") {
        // the run starts at the steady state of the case's own boundary; a history that begins elsewhere would not be starting from that state
        const same = hist.kind === "convective" && boundary.kind === "convective"
          ? Math.abs(hist.bulkTemperature[0]! - boundary.bulkTemperature) <= 1e-9 * boundary.bulkTemperature && Math.abs(hist.heatTransferCoefficient[0]! - boundary.heatTransferCoefficient) <= 1e-9 * boundary.heatTransferCoefficient
          : hist.kind === "surface-temperature" && boundary.kind === "surface-temperature" && Math.abs(hist.surfaceTemperature[0]! - boundary.surfaceTemperature) <= 1e-9 * boundary.surfaceTemperature;
        if (!same) {
          err("E_TRANSIENT_INCOMPLETE", "/transient/boundaryHistory/0", "the run starts at the steady state of the case's own boundary, so the history's value at time 0 must equal it (bulk temperature, heat-transfer coefficient or surface temperature); otherwise start from a uniform temperature");
          transient = undefined;
        }
      }
    }
    if (transient && transient.boundaryHistory) {
      const unseen = unseenHistoryChange(transient.boundaryHistory, transient.endTime, transient.outputs);
      if (unseen) issues.push({ code: "W_BOUNDARY_BETWEEN_OUTPUTS", severity: "warning", field: "/transient/boundaryHistory", message: unseen + ". The outputs of the run (and so the checks against the independent solution) cannot see it; add outputs, or accept that this part of the history is judged by the files FEED writes and not by the result." });
    }
    if (transient && cells) {
      // the work must fit the budget; a conductivity and a heat capacity law must hold at a uniform starting temperature (a steady start is checked on its field, below)
      const work = cells.reduce((a, b) => a + b, 0) * transient.steps;
      if (work > MAX_TRISO_TRANSIENT_WORK) {
        err("E_TIME", "/transient/timeStep", "cells x steps = " + work + " exceeds the budget of " + MAX_TRISO_TRANSIENT_WORK + " for a particle (" + transient.steps + " steps on " + cells.reduce((a, b) => a + b, 0) + " cells); use a coarser mesh or a longer step", { unit: "s" });
        transient = undefined;
      }
    }
    if (transient && transient.initial.kind === "uniform") {
      const start = transient.initial.temperature;
      const ks = [kernelK, ...layerK];
      const regionNames = ["kernel", ...names];
      for (let i = 0; i < ks.length && transient; i++) {
        const k = ks[i];
        const kStart = k ? evaluate(lawOf(k), start) : undefined;
        if (kStart !== undefined && !(Number.isFinite(kStart) && kStart > 0)) {
          err("E_OUT_OF_RANGE", "/transient/initialTemperature", "the " + regionNames[i] + " conductivity at the initial temperature " + start + " K is " + kStart.toPrecision(4) + " W/m/K: a conductivity law that is positive over its stated range can be zero or negative where the particle starts", { unit: "W/m/K" });
          transient = undefined;
          break;
        }
        const cp = capacities?.[i];
        if (cp && cp.kind !== "constant" && (start < cp.range[0] || start > cp.range[1])) {
          err("E_OUT_OF_RANGE", "/transient/initialTemperature", "the initial temperature " + start + " K is outside the stated range of the " + regionNames[i] + " heat capacity law (" + cp.range[0] + " to " + cp.range[1] + " K)", { unit: "K", range: cp.range });
          transient = undefined;
          break;
        }
      }
    }
  }
  // temperature limits on the kernel and the layers, each with its source (a pin's whileCladding condition has no meaning here)
  const limits = c.limits === undefined ? undefined : parseTrisoLimits(c.limits, geo ? ["kernel", ...names] : ["kernel", "buffer", "ipyc", "sic", "opyc"], err, qty);
  const result = finish(issues);
  // a transient's power is its table: the particle's `power` is then the table's peak (the steady closed form below is taken at it)
  if (isTransient && transient && volumes) {
    const peak = Math.max(...transient.particlePower);
    power = { form: "particle", particlePower: peak, kernelPowerDensity: peak / volumes.kernelVolume, ...volumes };
  }
  if (result.ok && geo && power && hGap !== undefined && boundary && kernelK && layerK.every((k) => k !== undefined) && cells && (!isTransient || (transient && capacities))) {
    let r = geo.kernelRadius;
    const layers: TrisoLayer[] = geo.layers.map((l, i) => {
      const inner = r;
      r += l.thickness;
      return { name: l.name, innerRadius: inner, outerRadius: r, conductivity: layerK[i]! };
    });
    const triso: NormalizedTriso = { caseId: c.caseId, kernelRadius: geo.kernelRadius, kernelConductivity: kernelK, layers, outerRadius: geo.outerRadius, gapConductance: hGap, boundary, power, cells, ...(limits ? { limits } : {}), ...(transient && capacities ? { transient, capacities } : {}) };
    // The temperatures come from integrating each conductivity: a law that is positive over its stated range can still reach zero further out, where the particle runs; and a steady run has to be able to settle
    try {
      if (triso.transient) {
        trisoClosedForm(triso); // at the table's peak power: finds a conductivity that reaches zero
        if (triso.transient.initial.kind === "steady") trisoInitialField(triso); // the steady start has to exist
      } else {
        const h = trisoSteadyEndTime(triso); // integrates the closed form (and so finds a conductivity that reaches zero) and bounds the time scale
        if (!h.ok) {
          result.ok = false;
          result.errors.push({ code: "E_TIME", severity: "error", field: "/assumptions/steadyState", message: "this case cannot be run as a steady case: " + h.message });
        }
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      result.ok = false;
      result.errors.push({ code: "E_OUT_OF_RANGE", severity: "error", field: "/materials", message: "the temperatures of this particle cannot be found: " + e.message + ". A conductivity that is positive over its stated range can still reach zero outside it, where the particle runs; widen the range with a law that stays positive, or change the case" });
    }
    if (result.ok) result.triso = triso;
  } else if (result.ok) {
    // everything was accepted but a piece did not come out: say so rather than return a case that is neither valid nor refused
    result.ok = false;
    result.errors.push({ code: "E_SCHEMA_INVALID", severity: "error", field: "/", message: "the particle case could not be normalised" });
  }
  return result;
}

/** The helpers the compact block needs from the validator: the conductivity reader, the gap reader and a length reader (positive, in range). */
function homogenisedDeps(err: ErrFn, qty: QtyFn, positive: PositiveFn): HomogenisedDeps {
  return {
    conductivity: (m, region, e, q) => conductivity(m, region, e, q),
    parseGap: (gap, e) => parseGap(gap, e, positive),
    radius: (value, field, what) => {
      const v = qty(value, "length", field);
      if (v === undefined) return undefined;
      if (!(v > 0)) {
        err("E_GEOMETRY", field, what + " must be positive", { unit: "m" });
        return undefined;
      }
      if (v < RADIUS_MIN || v > RADIUS_MAX) {
        err("E_GEOMETRY", field, what + " " + v + " m is outside " + RADIUS_MIN + " to " + RADIUS_MAX + " m; check the units", { unit: "m" });
        return undefined;
      }
      return v;
    },
  };
}

/** Sections of a pin that have no meaning for a compact or a pebble, refused by name (never ignored). */
function refuseSections(c: Record<string, any>, keys: readonly (readonly [string, string])[], err: ErrFn): void {
  for (const [key, why] of keys) if (c[key] !== undefined) err("E_UNSUPPORTED", "/" + key, why + "; remove the section");
}

/**
 * A compact (plan 13, T4): a pin whose fuel is the homogenised mix of coated particles in a matrix. The `compact` block gives the particle, the matrix, the packing fraction, the
 * compact's power density and the range of the table of the effective conductivity; this function derives the pin's fuel (a conductivity table with its fit, which the pin's own
 * reading then accepts or refuses) and its linear heat rate, runs the pin validation on that, and returns the pin's normalised case with the compact's record attached.
 */
function validateCompact(c: Record<string, any>, issues: Issue[], err: ErrFn, qty: QtyFn, positive: PositiveFn): ValidationResult {
  const warn = (code: string, field: string, message: string, extra: Record<string, unknown> = {}) => issues.push({ code, severity: "warning", field, message, ...extra } as Issue);
  if (c.geometry?.kind === "plate") err("E_UNSUPPORTED", "/geometry/kind", "a compact is a cylinder (a pin-like geometry); a plate of particles is not offered");
  refuseSections(c, [["mechanics", "a compact has no mechanics here"], ["hotDimensions", "hot dimensions are for pins"], ["burnup", "a burnup is for pins in this release"], ["axial", "an axial stack is for pins and plates"], ["transient", "a compact is steady in this release (plan 13 T4)"]], err);
  if (c.assumptions.steadyState === false) err("E_UNSUPPORTED", "/assumptions/steadyState", "a compact is steady in this release (plan 13 T4)");
  if (c.materials?.fuel !== undefined) err("E_UNSUPPORTED", "/materials/fuel", "a compact's fuel is the mixture derived from the compact block (particle, matrix, packing fraction); remove materials.fuel");
  if (c.power !== undefined) err("E_UNSUPPORTED", "/power", "a compact's power is compact.powerDensity (the heat rate follows from it and the cross-section); remove the power section");
  if (issues.some((i) => i.severity === "error")) return finish(issues); // a refused section: the rest would only repeat it in other words
  const spec = parseHomogenised(c.compact, homogenisedDeps(err, qty, positive), err, qty, warn);
  if (!spec) return finish(issues);
  // the linear heat rate: the power density times the cross-section of the compact (a central hole has none)
  const Rf = c.geometry?.fuelRadius === undefined ? undefined : qty(c.geometry.fuelRadius, "length", "/geometry/fuelRadius");
  const Ri = c.geometry?.fuelInnerRadius === undefined ? 0 : qty(c.geometry.fuelInnerRadius, "length", "/geometry/fuelInnerRadius");
  const qPrime = Rf !== undefined && Ri !== undefined && Rf > Ri ? spec.powerDensity * Math.PI * (Rf * Rf - Ri * Ri) : 1; // an unreadable radius is reported by the pin reading below; the placeholder is never returned
  spec.twoScale.forEach((p, i) => {
    if (typeof p === "number" && Rf !== undefined && Ri !== undefined && !(p >= Ri && p <= Rf)) err("E_GEOMETRY", "/compact/twoScale/at/" + i, "the radius " + p + " m is not inside the compact (" + Ri + " to " + Rf + " m)");
  });
  const derived = JSON.parse(JSON.stringify(c)) as Record<string, any>;
  delete derived.compact;
  derived.materials = { ...c.materials, fuel: { materialId: "compact-mixture", revision: 1, sets: { "thermal.conductivity": mixtureConductivitySet(spec) } } };
  derived.power = { linearHeatRate: { value: qPrime, unit: "W/m" } };
  const r = validateCase(derived);
  const mapField = (f: string) => (f.startsWith("/materials/fuel") ? "/compact/fit" : f === "/power/linearHeatRate" ? "/compact/powerDensity" : f);
  for (const e of r.errors) issues.push({ ...e, field: mapField(e.field) });
  for (const w of r.warnings) issues.push({ ...w, field: mapField(w.field) });
  const out = finish(issues);
  if (out.ok && r.normalized) out.normalized = { ...r.normalized, compact: spec };
  else if (out.ok) {
    out.ok = false;
    out.errors.push({ code: "E_SCHEMA_INVALID", severity: "error", field: "/", message: "the compact case could not be normalised" });
  }
  return out;
}

/**
 * A pebble (plan 13, T4): a sphere of a fuelled zone (the compact block) and an unfuelled shell, with a film or a wall temperature outside. Steady and thermal only. It has its
 * own normalised form (`pebble` on the result). The shell is bonded to the fuelled zone: the case's `gap` must say model "none".
 */
function validatePebble(c: Record<string, any>, issues: Issue[], err: ErrFn, qty: QtyFn, positive: PositiveFn): ValidationResult {
  const warn = (code: string, field: string, message: string, extra: Record<string, unknown> = {}) => issues.push({ code, severity: "warning", field, message, ...extra } as Issue);
  if (c.assumptions.geometry !== "1D-sphere") err("E_UNSUPPORTED", "/assumptions/geometry", "a pebble is geometry '1D-sphere', got '" + String(c.assumptions.geometry) + "'");
  if (c.assumptions.thermalOnly !== true) err("E_UNSUPPORTED", "/assumptions/thermalOnly", "a pebble is thermal only");
  if (c.assumptions.steadyState !== true) err("E_UNSUPPORTED", "/assumptions/steadyState", "a pebble is steady in this release (plan 13 T4)");
  refuseSections(c, [["mechanics", "a pebble has no mechanics here"], ["hotDimensions", "hot dimensions are for pins"], ["burnup", "a burnup is for pins in this release"], ["axial", "an axial stack is for pins and plates"], ["transient", "a pebble is steady in this release (plan 13 T4)"], ["limits", "temperature limits for a pebble's regions are not offered in this release"], ["power", "a pebble's power is compact.powerDensity (of the fuelled zone)"]], err);
  const deps = homogenisedDeps(err, qty, positive);
  const GEO = ["kind", "fuelledRadius", "outerRadius"];
  for (const k of Object.keys(c.geometry)) if (!GEO.includes(k)) err("E_GEOMETRY", "/geometry/" + k, "unknown key '" + k + "' for a pebble (it has " + GEO.join(", ") + ")");
  for (const k of GEO.slice(1)) if (c.geometry[k] === undefined) err("E_SCHEMA_INVALID", "/geometry/" + k, "missing: a pebble needs fuelledRadius and outerRadius");
  const Rf = c.geometry.fuelledRadius === undefined ? undefined : deps.radius(c.geometry.fuelledRadius, "/geometry/fuelledRadius", "fuelled radius");
  const Ro = c.geometry.outerRadius === undefined ? undefined : deps.radius(c.geometry.outerRadius, "/geometry/outerRadius", "outer radius");
  if (Rf !== undefined && Ro !== undefined && !(Ro > Rf)) err("E_GEOMETRY", "/geometry/outerRadius", "the outer radius must exceed the fuelled radius (the shell has a thickness)");
  if (c.gap?.model !== "none") err("E_UNSUPPORTED", "/gap/model", "a pebble's shell is bonded to its fuelled zone: state gap {model: 'none'}, got '" + String(c.gap?.model) + "'");
  const materials: Record<string, unknown> = isObject(c.materials) ? c.materials : {};
  for (const k of Object.keys(materials)) if (k !== "shell") err("E_GEOMETRY", "/materials/" + k, "'" + k + "' is not a region of a pebble (its material is shell; the fuelled zone is derived from the compact block)");
  let shellK: Conductivity | undefined;
  if (isObject(materials.shell)) shellK = conductivity(materials.shell, "shell", err, qty);
  else err("E_SCHEMA_INVALID", "/materials/shell", "missing: the shell's material (an object with a materialId, a revision and sets)");
  const boundary = parseBoundary(c.boundary as Record<string, unknown>, err, positive);
  const mesh: Record<string, unknown> = isObject(c.mesh) ? c.mesh : {};
  const KEYS = ["fuelledCells", "shellCells"] as const;
  for (const k of Object.keys(mesh)) if (!(KEYS as readonly string[]).includes(k)) err("E_SCHEMA_INVALID", "/mesh/" + k, "unknown key '" + k + "' for a pebble's mesh (it has fuelledCells, shellCells)");
  const cells: number[] = [];
  for (const k of KEYS) {
    const v = mesh[k];
    if (v === undefined) err("E_SCHEMA_INVALID", "/mesh/" + k, "missing: the number of cells in the " + (k === "fuelledCells" ? "fuelled zone" : "shell"));
    else if (typeof v !== "number" || !Number.isInteger(v)) err("E_SCHEMA_INVALID", "/mesh/" + k, k + " is a whole number of cells");
    else if (v < PEBBLE_MESH_MINIMUM[k]) err("E_MESH", "/mesh/" + k, k + " is " + v + "; the minimum is " + PEBBLE_MESH_MINIMUM[k]);
    else if (v > PEBBLE_MESH_MAXIMUM[k]) err("E_MESH", "/mesh/" + k, k + " is " + v + "; the maximum is " + PEBBLE_MESH_MAXIMUM[k]);
    else cells.push(v);
  }
  const spec = parseHomogenised(c.compact, deps, err, qty, warn);
  let fuelledK: Conductivity | undefined;
  if (spec) {
    const mapped: ErrFn = (code, field, message, extra) => err(code, field.startsWith("/materials/fuelled zone") ? "/compact/fit" : field, message, extra);
    fuelledK = conductivity({ materialId: "pebble-fuelled-zone", revision: 1, sets: { "thermal.conductivity": mixtureConductivitySet(spec) } }, "fuelled zone", mapped, qty);
  }
  spec?.twoScale.forEach((p, i) => {
    if (typeof p === "number" && Rf !== undefined && !(p >= 0 && p <= Rf)) err("E_GEOMETRY", "/compact/twoScale/at/" + i, "the radius " + p + " m is not inside the fuelled zone (0 to " + Rf + " m)");
  });
  const result = finish(issues);
  if (result.ok && spec && fuelledK && shellK && boundary && Rf !== undefined && Ro !== undefined && cells.length === 2) {
    const fuelledVolume = (4 / 3) * Math.PI * Rf ** 3;
    const pebble: NormalizedPebble = {
      caseId: c.caseId,
      fuelledRadius: Rf,
      outerRadius: Ro,
      fuelledConductivity: fuelledK,
      shellConductivity: shellK,
      boundary,
      power: { powerDensity: spec.powerDensity, fuelledPower: spec.powerDensity * fuelledVolume, fuelledVolume, pebbleVolume: (4 / 3) * Math.PI * Ro ** 3 },
      cells: [cells[0]!, cells[1]!],
      compact: spec,
    };
    try {
      pebbleClosedForm(pebble); // finds a conductivity that reaches zero where the pebble runs
      const h = pebbleSteadyEndTime(pebble);
      if (!h.ok) {
        result.ok = false;
        result.errors.push({ code: "E_TIME", severity: "error", field: "/assumptions/steadyState", message: "this case cannot be run as a steady case: " + h.message });
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      result.ok = false;
      result.errors.push({ code: "E_OUT_OF_RANGE", severity: "error", field: "/materials", message: "the temperatures of this pebble cannot be found: " + e.message });
    }
    if (result.ok) {
      const { bias, rise } = pebbleInterfaceBias(pebble);
      if (bias > 0.003 * rise && bias > 0.02) result.warnings.push({ code: "W_MESH_INTERFACE", severity: "warning", field: "/mesh", message: "OFFBEAT interpolates the conductivity linearly to the face between the fuelled zone and the shell, where the exact solution does not; across this jump the temperatures near the face may differ by about " + bias.toFixed(2) + " K (" + ((100 * bias) / rise).toFixed(2) + " % of the " + rise.toFixed(0) + " K rise), more than the 0.3 % the cross-check allows. The error is proportional to the cell width: use more cells (docs/compact-pebble.md)", unit: "K" } as Issue);
      result.pebble = pebble;
    }
  } else if (result.ok) {
    result.ok = false;
    result.errors.push({ code: "E_SCHEMA_INVALID", severity: "error", field: "/", message: "the pebble case could not be normalised" });
  }
  return result;
}

/**
 * The errors to give for a result that has neither a `normalized` case nor a `triso` one: its own. A valid case never reaches this; if one ever did (a validator bug), the caller
 * is not answered with an empty list of problems.
 */
export function unrunnableErrors(v: ValidationResult): Issue[] {
  if (v.errors.length > 0 || v.normalized || v.triso || v.pebble) return v.errors;
  return [{ code: "E_SCHEMA_INVALID", severity: "error", field: "/", message: "the case could not be normalised" }];
}

function finish(issues: Issue[]): ValidationResult {
  const errors = issues.filter((i) => i.severity === "error");
  return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === "warning") };
}

type ErrFn = (code: string, field: string, message: string, extra?: Partial<Issue>) => void;
type QtyFn = (value: unknown, dim: Dimension, field: string) => number | undefined;

export function conductivity(material: Record<string, any>, region: string, err: ErrFn, qty: QtyFn, burnup = 0): Conductivity | undefined {
  const base = "/materials/" + region + "/sets/thermal.conductivity";
  const set = isObject(material.sets) ? material.sets["thermal.conductivity"] : undefined;
  if (!isObject(set)) {
    err("E_PROP_MISSING", base, region + " material '" + material.materialId + "' has no thermal.conductivity set; a thermal model needs conductivity (composition and density alone do not satisfy it)");
    return undefined;
  }
  const sourceMissing = set.source === undefined || typeof set.source !== "string" || set.source.trim() === "";
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
    if (k !== undefined && (k < CONDUCTIVITY_MIN || k > CONDUCTIVITY_MAX)) {
      err("E_OUT_OF_RANGE", base + "/value", region + " conductivity " + k + " W/m/K is outside " + CONDUCTIVITY_MIN + " to " + CONDUCTIVITY_MAX + "; check the units", { unit: "W/m/K" });
      return undefined;
    }
    if (tref !== undefined && !(tref > 0)) {
      err("E_OUT_OF_RANGE", base + "/referenceTemperature", "the reference temperature is above 0 K", { unit: "K" });
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
    if (!(lo > 0)) {
      err("E_OUT_OF_RANGE", base + "/validRange/min", "the range starts above 0 K", { unit: "K" });
      return undefined;
    }
    if (!(a + bb * lo > 0) || !(a + bb * hi > 0)) {
      err("E_OUT_OF_RANGE", base, "conductivity a + b T is not positive over its stated range", { unit: "W/m/K", range: [lo, hi] });
      return undefined;
    }
    const kLo = Math.min(a + bb * lo, a + bb * hi);
    const kHi = Math.max(a + bb * lo, a + bb * hi);
    if (!(kLo >= CONDUCTIVITY_MIN) || !(kHi <= CONDUCTIVITY_MAX)) {
      err("E_OUT_OF_RANGE", base, "conductivity is outside " + CONDUCTIVITY_MIN + " to " + CONDUCTIVITY_MAX + " W/m/K somewhere in its stated range (" + kLo.toPrecision(4) + " to " + kHi.toPrecision(4) + "); check the units", { unit: "W/m/K", range: [lo, hi] });
      return undefined;
    }
    return { kind: "linear", a, b: bb, range: [lo, hi] };
  }
  if (set.model === "uo2-nfi") return uo2NfiConductivity(set, region, base, sourceMissing, err, qty, burnup);
  if (set.model === "reciprocal") return reciprocalConductivity(set, region, base, sourceMissing, err, qty);
  if (set.model === "polynomial") return polynomialConductivity(set, region, base, sourceMissing, err, qty);
  if (set.model === "table") return tableConductivity(set, region, base, sourceMissing, err, qty);
  err("E_UNSUPPORTED", base + "/model", "unknown conductivity model '" + String(set.model) + "'; supported: 'constant', 'linear', 'reciprocal', 'polynomial', 'table' and (fuel only) 'uo2-nfi'");
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
  bounds: [CONDUCTIVITY_MIN, CONDUCTIVITY_MAX],
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
  const top = "kind" in c ? Math.max(evaluate(c, lo), evaluate(c, hi)) : -minimum(c.map((x) => -x), lo, hi); // the reciprocal law is monotone: its highest value is at an end
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

/**
 * UO2 fuel with burnup: FRAPCON-3.4's modified NFI model (src/core/uo2Nfi.ts, docs/spike/burnup-sourcing.md). The material states the as-fabricated density as a fraction of
 * theoretical (0.92 to 0.97), optionally the gadolinia content (0 to 0.1 as a weight fraction), optionally the temperature range (inside 300 to 3000 K, the model's own),
 * and a source. The constants are the model's and are not the material's to change. The burnup is the case's.
 */
function uo2NfiConductivity(set: Record<string, any>, region: string, base: string, sourceMissing: boolean, err: ErrFn, qty: QtyFn, burnup: number): Conductivity | undefined {
  let ok = !sourceMissing;
  if (region !== "fuel") {
    err("E_UNSUPPORTED", base + "/model", "uo2-nfi is a fuel model (UO2); the " + region + " cannot use it");
    return undefined;
  }
  for (const k of Object.keys(set)) {
    if (!["model", "densityFraction", "gadolinia", "validRange", "source"].includes(k)) {
      err("E_SCHEMA_INVALID", base + "/" + k, "unknown key '" + k + "' (uo2-nfi has model, densityFraction, gadolinia, validRange and source: its constants are the model's)");
      ok = false;
    }
  }
  let d: number | undefined;
  if (set.densityFraction === undefined) {
    err("E_PROP_MISSING", base + "/densityFraction", "uo2-nfi needs the as-fabricated density as a fraction of theoretical (" + NFI_RANGE.densityFraction[0] + " to " + NFI_RANGE.densityFraction[1] + ")");
    ok = false;
  } else {
    d = qty(set.densityFraction, "fraction", base + "/densityFraction");
    if (d === undefined) ok = false;
    else if (!(d >= NFI_RANGE.densityFraction[0] && d <= NFI_RANGE.densityFraction[1])) {
      err("E_OUT_OF_RANGE", base + "/densityFraction", "the density fraction " + d + " is outside " + NFI_RANGE.densityFraction[0] + " to " + NFI_RANGE.densityFraction[1] + ", the range the model is stated for (NUREG/CR-7024 section 2.3.2)", { unit: "1" });
      ok = false;
    }
  }
  let gad = 0;
  if (set.gadolinia !== undefined) {
    const g = qty(set.gadolinia, "fraction", base + "/gadolinia");
    if (g === undefined) ok = false;
    else if (!(g >= NFI_RANGE.gadolinia[0] && g <= NFI_RANGE.gadolinia[1])) {
      err("E_OUT_OF_RANGE", base + "/gadolinia", "the gadolinia weight fraction " + g + " is outside " + NFI_RANGE.gadolinia[0] + " to " + NFI_RANGE.gadolinia[1] + " (0 to 10 wt%)", { unit: "1" });
      ok = false;
    } else gad = g;
  }
  let range: [number, number] = [NFI_RANGE.temperature[0], NFI_RANGE.temperature[1]];
  if (set.validRange !== undefined) {
    const r = set.validRange;
    const lo = isObject(r) && r.min !== undefined ? qty(r.min, "temperature", base + "/validRange/min") : undefined;
    const hi = isObject(r) && r.max !== undefined ? qty(r.max, "temperature", base + "/validRange/max") : undefined;
    if (!isObject(r) || lo === undefined || hi === undefined) {
      if (!isObject(r) || r.min === undefined || r.max === undefined) err("E_SCHEMA_INVALID", base + "/validRange", "validRange is {min, max}, each a temperature");
      ok = false;
    } else if (!(hi > lo && lo >= NFI_RANGE.temperature[0] && hi <= NFI_RANGE.temperature[1])) {
      err("E_OUT_OF_RANGE", base + "/validRange", "the range must be increasing and inside " + NFI_RANGE.temperature[0] + " to " + NFI_RANGE.temperature[1] + " K, the range of the model", { unit: "K", range: [lo, hi] });
      ok = false;
    } else range = [lo, hi];
  }
  if (!ok || d === undefined) return undefined;
  const state = { burnup, densityFraction: d, gadolinia: gad };
  for (const T of [range[0], range[1]]) {
    const k = nfiConductivity(T, state);
    if (!(Number.isFinite(k) && k >= CONDUCTIVITY_MIN && k <= CONDUCTIVITY_MAX)) {
      err("E_OUT_OF_RANGE", base, "the uo2-nfi conductivity is " + k + " W/m/K at " + T + " K: outside " + CONDUCTIVITY_MIN + " to " + CONDUCTIVITY_MAX, { unit: "W/m/K" });
      return undefined;
    }
  }
  // 95 % read as 95 x 0.01 is 0.9500000000000001; the law and the files get the number that was meant
  const tidy = (x: number) => Number(x.toPrecision(12));
  return { kind: "uo2-nfi", burnup, densityFraction: tidy(d), gadolinia: tidy(gad), range };
}

/**
 * The case's burnup: one value for the slice, on a HEAVY-METAL basis (MWd/kgHM, MWd/tHM or GWd/tHM; an oxide basis is not accepted), and where it comes from. A frozen
 * state of the fuel, not a history (docs/plans/10-burnup.md). Nothing is defaulted: a burnup of 0 is stated as 0.
 */
function parseBurnup(raw: unknown, err: ErrFn, qty: QtyFn): { value: number; source: string } | undefined {
  if (!isObject(raw)) {
    err("E_SCHEMA_INVALID", "/burnup", "burnup is an object with value, basis and source");
    return undefined;
  }
  let ok = true;
  const bad = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
    ok = false;
    err(code, field, message, extra);
  };
  for (const k of Object.keys(raw)) if (!["value", "basis", "source"].includes(k)) bad("E_SCHEMA_INVALID", "/burnup/" + k, "unknown key '" + k + "' (burnup has value, basis and source)");
  let value: number | undefined;
  if (raw.value === undefined) bad("E_PROP_MISSING", "/burnup/value", "the burnup needs its value (0 for fresh fuel)");
  else {
    value = qty(raw.value, "burnup", "/burnup/value");
    if (value === undefined) ok = false;
    else if (!(value >= NFI_RANGE.burnup[0] && value <= NFI_RANGE.burnup[1])) {
      bad("E_OUT_OF_RANGE", "/burnup/value", "the burnup " + value + " MWd/kgHM is outside " + NFI_RANGE.burnup[0] + " to " + NFI_RANGE.burnup[1] + ", the range the fuel conductivity model is stated for (rod-average, NUREG/CR-7024 section 2.3.2)", { unit: "MWd/kgHM" });
      value = undefined;
    }
  }
  if (raw.basis === undefined) bad("E_PROP_MISSING", "/burnup/basis", "the burnup needs its basis: \"heavy-metal\"");
  else if (raw.basis !== "heavy-metal") bad("E_UNSUPPORTED", "/burnup/basis", "only a heavy-metal basis is accepted (MWd per kg or tonne of initial heavy metal, as OpenMC reports it); got " + JSON.stringify(raw.basis));
  if (typeof raw.source !== "string" || raw.source.trim() === "") bad("E_PROP_MISSING", "/burnup/source", "the burnup needs the source it comes from (a study's choice, or a depletion record's id)");
  return ok && value !== undefined ? { value, source: (raw.source as string).trim() } : undefined;
}

/**
 * k = a / T + b over a stated range (the phonon-limited shape: a in W/m, b in W/m/K). Both terms are given (a zero is written as a zero), with a source and the
 * range. The law is monotone in T, so positivity over the range is the two end points, exactly.
 */
function reciprocalConductivity(set: Record<string, any>, region: string, base: string, sourceMissing: boolean, err: ErrFn, qty: QtyFn): Conductivity | undefined {
  for (const key of ["a", "b"]) if (set[key] === undefined) err("E_PROP_MISSING", base + "/" + key, "the reciprocal conductivity model k = a / T + b needs '" + key + "' (give 0 for a term that is not there)");
  const range = set.validRange;
  if (!isObject(range) || range.min === undefined || range.max === undefined) err("E_PROP_MISSING", base + "/validRange", "a temperature-dependent conductivity needs the temperature range it applies to (min and max)");
  const a = set.a === undefined ? undefined : qty(set.a, "linearPower", base + "/a"); // W/m: the unit of a linear heat rate
  const b = set.b === undefined ? undefined : qty(set.b, "conductivity", base + "/b");
  const lo = isObject(range) && range.min !== undefined ? qty(range.min, "temperature", base + "/validRange/min") : undefined;
  const hi = isObject(range) && range.max !== undefined ? qty(range.max, "temperature", base + "/validRange/max") : undefined;
  if (a === undefined || b === undefined || lo === undefined || hi === undefined || sourceMissing) return undefined;
  if (!(hi > lo)) {
    err("E_OUT_OF_RANGE", base + "/validRange", "range maximum must exceed the minimum", { unit: "K" });
    return undefined;
  }
  if (!(lo > 0)) {
    err("E_OUT_OF_RANGE", base + "/validRange/min", "the range starts above 0 K (a / T is not defined at 0)", { unit: "K" });
    return undefined;
  }
  const law = { kind: "reciprocal", a, b } as const;
  if (!positiveOver(law, lo, hi, base, region, err)) return undefined;
  return { kind: "reciprocal", a, b, range: [lo, hi] };
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
  const sourceMissing = set.source === undefined || typeof set.source !== "string" || set.source.trim() === "";
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
    if (tref !== undefined && !(tref > 0)) {
      err("E_OUT_OF_RANGE", base + "/referenceTemperature", "the reference temperature is above 0 K", { unit: "K" });
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
    if (!(lo > 0)) {
      err("E_OUT_OF_RANGE", base + "/validRange/min", "the range starts above 0 K", { unit: "K" });
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
 * One solid's linear expansion coefficient: a constant {value, unit}, or {model: "linear", a, b, validRange} for alpha = a + b T over a stated range of temperature
 * (a range is required: the coefficient is not extrapolated silently). Positive, and at most MAX_EXPANSION_COEFFICIENT, over the whole range.
 */
function expansionLaw(raw: unknown, field: string, err: ErrFn, qty: QtyFn): ExpansionLaw | undefined {
  const outOfBounds = (a: number) => !(a > 0 && a <= MAX_EXPANSION_COEFFICIENT);
  if (!isObject(raw) || raw.model === undefined) {
    const a = qty(raw, "expansion", field);
    if (a === undefined) return undefined;
    if (outOfBounds(a)) {
      err("E_OUT_OF_RANGE", field, "a linear expansion coefficient is above 0 and at most " + MAX_EXPANSION_COEFFICIENT + " 1/K (solids are about 1e-5)", { unit: "1/K" });
      return undefined;
    }
    return { kind: "constant", alpha: a };
  }
  if (raw.model !== "linear") {
    err("E_UNSUPPORTED", field + "/model", "the expansion models are a constant coefficient and 'linear' (alpha = a + b T)");
    return undefined;
  }
  let ok = true;
  for (const k of Object.keys(raw)) if (!["model", "a", "b", "validRange"].includes(k)) {
    err("E_SCHEMA_INVALID", field + "/" + k, "unknown key '" + k + "' (a linear expansion has model, a, b and validRange)");
    ok = false;
  }
  const get = (key: "a" | "b", dim: Dimension): number | undefined => {
    if (raw[key] === undefined) {
      err("E_PROP_MISSING", field + "/" + key, "a linear expansion needs its term '" + key + "'");
      ok = false;
      return undefined;
    }
    const v = qty(raw[key], dim, field + "/" + key);
    if (v === undefined) ok = false;
    return v;
  };
  const a = get("a", "expansion");
  const b = get("b", "expansionPerK");
  let range: [number, number] | undefined;
  const vr = raw.validRange;
  if (vr === undefined) {
    err("E_PROP_MISSING", field + "/validRange", "a linear expansion needs the temperature range it is valid over: it is not extrapolated silently");
    ok = false;
  } else if (!isObject(vr) || vr.min === undefined || vr.max === undefined) {
    err("E_SCHEMA_INVALID", field + "/validRange", "validRange is {min, max}, each a temperature");
    ok = false;
  } else {
    const lo = qty(vr.min, "temperature", field + "/validRange/min");
    const hi = qty(vr.max, "temperature", field + "/validRange/max");
    if (lo === undefined || hi === undefined) ok = false;
    else if (!(lo > 0 && hi > lo && hi <= MAX_REFERENCE_TEMPERATURE)) {
      err("E_OUT_OF_RANGE", field + "/validRange", "the range is above 0 K, increasing and at most " + MAX_REFERENCE_TEMPERATURE + " K", { unit: "K" });
      ok = false;
    } else range = [lo, hi];
  }
  if (!ok || a === undefined || b === undefined || !range) return undefined;
  const law: ExpansionLaw = { kind: "linear", a, b, range };
  if (outOfBounds(alphaAt(law, range[0])) || outOfBounds(alphaAt(law, range[1]))) {
    err("E_OUT_OF_RANGE", field, "the coefficient a + b T must be above 0 and at most " + MAX_EXPANSION_COEFFICIENT + " 1/K across the whole valid range (it is " + alphaAt(law, range[0]).toExponential(3) + " at " + range[0] + " K and " + alphaAt(law, range[1]).toExponential(3) + " at " + range[1] + " K)", { unit: "1/K" });
    return undefined;
  }
  return law;
}

const MECHANICS_KEYS = ["referenceTemperature", "plane", "contact", "coolantPressure", "internalPressure", "stressLimits"];
const MAX_STRESS_LIMITS = 8;
const PENALTY_MIN = 0.05;
const PENALTY_MAX = 1;
const MAX_PRESSURE = 1e9;

/**
 * The mechanics section: the stress-free (reference) temperature, the plane condition, the penalty factor of the gap contact and the coolant pressure on the cladding.
 * Nothing is defaulted. The penalty factor decides the contact pressure (a factor of 10 gave an answer eleven times too large with nothing in the log to say so,
 * docs/spike/mechanics-probe.md), so it is bounded to the range that was shown to be close, and the results check the contact against the closed form (M3).
 */
function parseMechanics(raw: unknown, err: ErrFn, qty: QtyFn): MechanicsSpec | undefined {
  if (!isObject(raw)) {
    err("E_SCHEMA_INVALID", "/mechanics", "mechanics is an object with referenceTemperature, plane, contact and coolantPressure");
    return undefined;
  }
  let ok = true;
  const bad = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
    err(code, field, message, extra);
    ok = false;
  };
  for (const k of Object.keys(raw)) if (!MECHANICS_KEYS.includes(k)) bad("E_SCHEMA_INVALID", "/mechanics/" + k, "unknown key '" + k + "' (the mechanics section has " + MECHANICS_KEYS.join(", ") + ")");
  let referenceTemperature: number | undefined;
  if (raw.referenceTemperature === undefined) bad("E_PROP_MISSING", "/mechanics/referenceTemperature", "the reference temperature, where the solids are free of thermal stress, is required: nothing is assumed");
  else {
    referenceTemperature = qty(raw.referenceTemperature, "temperature", "/mechanics/referenceTemperature");
    if (referenceTemperature === undefined) ok = false;
    else if (!(referenceTemperature > 0 && referenceTemperature <= MAX_REFERENCE_TEMPERATURE)) {
      bad("E_OUT_OF_RANGE", "/mechanics/referenceTemperature", "the reference temperature is above 0 K and at most " + MAX_REFERENCE_TEMPERATURE + " K", { unit: "K" });
      referenceTemperature = undefined;
    }
  }
  let plane: "free-axial" | "plane-strain" | undefined;
  if (raw.plane === undefined) bad("E_PROP_MISSING", "/mechanics/plane", "the plane condition is required: 'free-axial' (each solid takes its own axial strain, free of axial force) or 'plane-strain' (axially fixed)");
  else if (raw.plane === "free-axial" || raw.plane === "plane-strain") plane = raw.plane;
  else bad("E_UNSUPPORTED", "/mechanics/plane", "the plane conditions are 'free-axial' and 'plane-strain'; plane stress is wrong for a rod and a strain common to both solids is not available on this mesh");
  let penaltyFactor: number | undefined;
  if (raw.contact === undefined) bad("E_PROP_MISSING", "/mechanics/contact", "the contact condition is required: {penaltyFactor}");
  else if (!isObject(raw.contact)) bad("E_SCHEMA_INVALID", "/mechanics/contact", "contact is an object with a penaltyFactor");
  else {
    for (const k of Object.keys(raw.contact)) if (k !== "penaltyFactor") bad("E_SCHEMA_INVALID", "/mechanics/contact/" + k, "unknown key '" + k + "' (the contact condition has penaltyFactor)");
    if (raw.contact.penaltyFactor === undefined) bad("E_PROP_MISSING", "/mechanics/contact/penaltyFactor", "the penalty factor of the contact condition is required: it decides the contact pressure");
    else {
      penaltyFactor = qty(raw.contact.penaltyFactor, "fraction", "/mechanics/contact/penaltyFactor");
      if (penaltyFactor === undefined) ok = false;
      else if (!(penaltyFactor >= PENALTY_MIN && penaltyFactor <= PENALTY_MAX)) {
        bad("E_OUT_OF_RANGE", "/mechanics/contact/penaltyFactor", "the penalty factor is from " + PENALTY_MIN + " to " + PENALTY_MAX + ": below it the solids overlap and the pressure is far too low, above it the answer can be an order of magnitude wrong without a warning (docs/spike/mechanics-probe.md)", { unit: "1" });
        penaltyFactor = undefined;
      }
    }
  }
  let coolantPressure: number | undefined;
  if (raw.coolantPressure === undefined) bad("E_PROP_MISSING", "/mechanics/coolantPressure", "the coolant pressure on the cladding's outer surface is required (0 for none)");
  else {
    coolantPressure = qty(raw.coolantPressure, "pressure", "/mechanics/coolantPressure");
    if (coolantPressure === undefined) ok = false;
    else if (!(coolantPressure >= 0 && coolantPressure <= MAX_PRESSURE)) {
      bad("E_OUT_OF_RANGE", "/mechanics/coolantPressure", "the coolant pressure is from 0 to " + MAX_PRESSURE + " Pa", { unit: "Pa" });
      coolantPressure = undefined;
    }
  }
  const internalPressure = raw.internalPressure === undefined ? undefined : parseInternalPressure(raw.internalPressure, bad, qty);
  if (raw.internalPressure !== undefined && internalPressure === undefined) ok = false;
  const stressLimits = raw.stressLimits === undefined ? undefined : parseStressLimits(raw.stressLimits, bad, qty);
  if (raw.stressLimits !== undefined && stressLimits === undefined) ok = false;
  if (!ok || referenceTemperature === undefined || plane === undefined || penaltyFactor === undefined || coolantPressure === undefined) return undefined;
  return { referenceTemperature, plane, penaltyFactor, coolantPressure, ...(internalPressure ? { internalPressure } : {}), ...(stressLimits ? { stressLimits } : {}) };
}

/**
 * The pressure of the gas in the gap (plan 09 M4), an input that names its source: `{model: "constant", pressure, source}`, or `{model: "hydrogen-zrh", hZrRatio, fuelTemperature:
 * "peak" | "mean", source}`, the hydrogen pressure the hydride fuel holds at the hottest (or the area-mean) fuel temperature of the run. FEED computes no fuel hydrogen inventory,
 * no fission gas and no plenum: the case states what it takes the pressure to be.
 */
function parseInternalPressure(raw: unknown, bad: (code: string, field: string, message: string, extra?: Partial<Issue>) => void, qty: QtyFn): InternalPressure | undefined {
  const F = "/mechanics/internalPressure";
  if (!isObject(raw)) {
    bad("E_SCHEMA_INVALID", F, "internalPressure is an object: {model: 'constant', pressure, source} or {model: 'hydrogen-zrh', hZrRatio, fuelTemperature, source}");
    return undefined;
  }
  const keysFor = raw.model === "constant" ? ["model", "pressure", "source"] : ["model", "hZrRatio", "fuelTemperature", "source"];
  if (raw.model !== "constant" && raw.model !== "hydrogen-zrh") {
    bad("E_UNSUPPORTED", F + "/model", "the internal pressure models are 'constant' and 'hydrogen-zrh'");
    return undefined;
  }
  let ok = true;
  for (const k of Object.keys(raw)) {
    if (!keysFor.includes(k)) {
      bad("E_SCHEMA_INVALID", F + "/" + k, "unknown key '" + k + "' (the " + raw.model + " internal pressure has " + keysFor.join(", ") + ")");
      ok = false;
    }
  }
  let source: string | undefined;
  if (typeof raw.source !== "string" || raw.source.trim() === "") {
    bad("E_PROP_MISSING", F + "/source", "the source of the internal pressure is required: FEED has no gas inventory of its own, so the case says where the number comes from");
    ok = false;
  } else source = raw.source;
  if (raw.model === "constant") {
    if (raw.pressure === undefined) {
      bad("E_PROP_MISSING", F + "/pressure", "the gas pressure is required");
      return undefined;
    }
    const pressure = qty(raw.pressure, "pressure", F + "/pressure");
    if (pressure === undefined) return undefined;
    if (!(pressure > 0 && pressure <= MAX_PRESSURE)) {
      bad("E_OUT_OF_RANGE", F + "/pressure", "the gas pressure is above 0 and at most " + MAX_PRESSURE + " Pa (leave internalPressure out for none)", { unit: "Pa" });
      return undefined;
    }
    return ok && source !== undefined ? { kind: "constant", pressure, source } : undefined;
  }
  let hZrRatio: number | undefined;
  if (raw.hZrRatio === undefined) {
    bad("E_PROP_MISSING", F + "/hZrRatio", "the hydrogen-to-zirconium atom ratio of the fuel is required");
    ok = false;
  } else {
    hZrRatio = qty(raw.hZrRatio, "fraction", F + "/hZrRatio");
    if (hZrRatio === undefined) ok = false;
    else if (!(hZrRatio >= HYDROGEN_RATIO_RANGE[0] && hZrRatio <= HYDROGEN_RATIO_RANGE[1])) {
      bad("E_OUT_OF_RANGE", F + "/hZrRatio", "the H/Zr ratio is from " + HYDROGEN_RATIO_RANGE[0] + " to " + HYDROGEN_RATIO_RANGE[1] + ", the delta phase the correlation (Simnad, GA E-117-833 section 2.4) is for", { unit: "1" });
      ok = false;
    }
  }
  const basis = raw.fuelTemperature;
  if (basis === undefined) {
    bad("E_PROP_MISSING", F + "/fuelTemperature", "the fuel temperature the hydrogen pressure is taken at is required: 'peak' (the hottest point, as the SARs do) or 'mean' (the area-weighted mean)");
    ok = false;
  } else if (basis !== "peak" && basis !== "mean") {
    bad("E_UNSUPPORTED", F + "/fuelTemperature", "the fuel temperature is 'peak' or 'mean'");
    ok = false;
  }
  return ok && hZrRatio !== undefined && source !== undefined && (basis === "peak" || basis === "mean") ? { kind: "hydrogen-zrh", hZrRatio, basis, source } : undefined;
}

/**
 * The stress limits a case states (plan 09 M4): a name, a region, a strength table against temperature and the source. FEED ships no strength curve: the digitised figures of the
 * UT-Austin SAR would be good to 5 to 10 % and exist only from 400 C, so the case brings its own table and says where it is from.
 */
function parseStressLimits(raw: unknown, bad: (code: string, field: string, message: string, extra?: Partial<Issue>) => void, qty: QtyFn): StressLimit[] | undefined {
  const F = "/mechanics/stressLimits";
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_STRESS_LIMITS) {
    bad("E_SCHEMA_INVALID", F, "stressLimits is a list of 1 to " + MAX_STRESS_LIMITS + " rules");
    return undefined;
  }
  const out: StressLimit[] = [];
  const names = new Set<string>();
  let ok = true;
  raw.forEach((r: unknown, i: number) => {
    const base = F + "/" + i;
    const fail = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
      bad(code, field, message, extra);
      ok = false;
    };
    if (!isObject(r)) return fail("E_SCHEMA_INVALID", base, "a stress limit is an object with name, region, table and source");
    for (const k of Object.keys(r)) if (!["name", "region", "table", "source"].includes(k)) fail("E_SCHEMA_INVALID", base + "/" + k, "unknown key '" + k + "' (a stress limit has name, region, table, source)");
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (name === "") fail("E_PROP_MISSING", base + "/name", "a stress limit needs a name: a result says which limit it is about");
    else if (names.has(name)) fail("E_SCHEMA_INVALID", base + "/name", "two stress limits are named '" + name + "'");
    names.add(name);
    if (r.region !== "fuel" && r.region !== "cladding") fail("E_SCHEMA_INVALID", base + "/region", "the region is 'fuel' or 'cladding'");
    if (typeof r.source !== "string" || r.source.trim() === "") fail("E_PROP_MISSING", base + "/source", "a stress limit needs the source it comes from: FEED has no strengths of its own");
    const table: { temperature: number; strength: number }[] = [];
    if (!Array.isArray(r.table) || r.table.length < 2 || r.table.length > 200) fail("E_SCHEMA_INVALID", base + "/table", "the table is a list of 2 to 200 points {temperature, strength}");
    else {
      r.table.forEach((pt: unknown, j: number) => {
        const f = base + "/table/" + j;
        if (!isObject(pt) || Object.keys(pt).some((k) => k !== "temperature" && k !== "strength")) return fail("E_SCHEMA_INVALID", f, "a table point is {temperature, strength}");
        const T = pt.temperature === undefined ? undefined : qty(pt.temperature, "temperature", f + "/temperature");
        const S = pt.strength === undefined ? undefined : qty(pt.strength, "pressure", f + "/strength");
        if (T === undefined || S === undefined) return fail(pt.temperature === undefined || pt.strength === undefined ? "E_PROP_MISSING" : "E_SCHEMA_INVALID", f, "a table point needs a temperature and a strength");
        if (!(T > 0 && T <= MAX_REFERENCE_TEMPERATURE)) return fail("E_OUT_OF_RANGE", f + "/temperature", "the temperature is above 0 K and at most " + MAX_REFERENCE_TEMPERATURE + " K", { unit: "K" });
        if (!(S > 0 && S <= MAX_PRESSURE)) return fail("E_OUT_OF_RANGE", f + "/strength", "the strength is above 0 and at most " + MAX_PRESSURE + " Pa", { unit: "Pa" });
        if (table.length > 0 && !(T > table[table.length - 1]!.temperature)) return fail("E_OUT_OF_RANGE", f + "/temperature", "the table's temperatures must increase");
        table.push({ temperature: T, strength: S });
      });
    }
    if (ok && table.length === (r.table as unknown[]).length) out.push({ name, region: r.region as "fuel" | "cladding", table, source: r.source as string });
  });
  return ok && out.length === raw.length ? out : undefined;
}

/** Bounds of a mechanical property: a solid's Young's modulus is between a soft polymer and the stiffest ceramic. */
const E_MIN = 1e7;
const E_MAX = 5e12;

const MECHANICAL_ELASTICITY_KEYS = { constant: ["model", "youngModulus", "poissonRatio", "validRange", "source"], linear: ["model", "a", "b", "poissonRatio", "validRange", "source"] } as const;

/**
 * The mechanical property sets of one solid (docs/plans/09-mechanics.md M1): `mechanical.elasticity` (Young's modulus as a constant or `a + b T` over a stated range, and Poisson's
 * ratio, with the source) and `mechanical.thermalExpansion` (the linear expansion coefficient, constant or `a + b T`, with the source: the same law as the hot dimensions use).
 * Checked whenever present. With `required`, a missing set is refused naming it: FEED has no mechanical properties of its own and a silent default would be a made-up number
 * (OFFBEAT itself stops with a fatal error on a missing one, docs/spike/mechanics-probe.md). Returns both when both are valid.
 */
function mechanicalSets(material: Record<string, any>, region: string, err: ErrFn, qty: QtyFn, required: boolean): MechanicalProps | undefined {
  const sets = isObject(material.sets) ? material.sets : {};
  const eBase = "/materials/" + region + "/sets/mechanical.elasticity";
  const xBase = "/materials/" + region + "/sets/mechanical.thermalExpansion";
  let elasticity: Elasticity | undefined;
  let expansion: ExpansionLaw | undefined;
  const missing = (base: string, name: string, what: string) =>
    err("E_PROP_MISSING", base, region + " material '" + material.materialId + "' has no " + name + " set; a mechanical run needs " + what + " (FEED has none of its own and does not default one)");

  const e = sets["mechanical.elasticity"];
  if (e === undefined) {
    if (required) missing(eBase, "mechanical.elasticity", "Young's modulus and Poisson's ratio of both solids");
  } else if (!isObject(e)) {
    err("E_SCHEMA_INVALID", eBase, "a property set is an object");
  } else {
    let ok = true;
    const bad = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
      err(code, field, message, extra);
      ok = false;
    };
    if (e.model !== "constant" && e.model !== "linear") bad(e.model === undefined ? "E_PROP_MISSING" : "E_UNSUPPORTED", eBase + "/model", "the elasticity models are 'constant' (E and nu) and 'linear' (E = a + b T over a valid range)");
    else for (const k of Object.keys(e)) if (!(MECHANICAL_ELASTICITY_KEYS[e.model] as readonly string[]).includes(k)) bad("E_SCHEMA_INVALID", eBase + "/" + k, "unknown key '" + k + "' for the " + e.model + " elasticity (" + MECHANICAL_ELASTICITY_KEYS[e.model].join(", ") + ")");
    if (e.source === undefined || typeof e.source !== "string" || e.source.trim() === "") bad("E_PROP_MISSING", eBase + "/source", "the elasticity needs the source it comes from (a report and a table or page): FEED has no mechanical properties of its own");
    let nu: number | undefined;
    if (e.poissonRatio === undefined) bad("E_PROP_MISSING", eBase + "/poissonRatio", "the elasticity needs Poisson's ratio");
    else {
      nu = qty(e.poissonRatio, "fraction", eBase + "/poissonRatio");
      if (nu === undefined) ok = false;
      else if (!(nu >= 0 && nu < 0.5)) {
        bad("E_OUT_OF_RANGE", eBase + "/poissonRatio", "Poisson's ratio of a solid is from 0 up to (not including) 0.5, got " + nu, { unit: "1" });
        nu = undefined;
      }
    }
    let range: [number, number] | undefined;
    if (e.validRange !== undefined) {
      const vr = e.validRange;
      if (!isObject(vr) || vr.min === undefined || vr.max === undefined) bad("E_SCHEMA_INVALID", eBase + "/validRange", "validRange is {min, max}, each a temperature");
      else {
        const lo = qty(vr.min, "temperature", eBase + "/validRange/min");
        const hi = qty(vr.max, "temperature", eBase + "/validRange/max");
        if (lo === undefined || hi === undefined) ok = false;
        else if (!(lo > 0 && hi > lo && hi <= MAX_REFERENCE_TEMPERATURE)) bad("E_OUT_OF_RANGE", eBase + "/validRange", "the range is above 0 K, increasing and at most " + MAX_REFERENCE_TEMPERATURE + " K", { unit: "K" });
        else range = [lo, hi];
      }
    } else if (e.model === "linear") bad("E_PROP_MISSING", eBase + "/validRange", "a linear elasticity needs the temperature range it is valid over: it is not extrapolated silently");
    const inBounds = (E: number) => E >= E_MIN && E <= E_MAX;
    if (ok && e.model === "constant") {
      if (e.youngModulus === undefined) bad("E_PROP_MISSING", eBase + "/youngModulus", "a constant elasticity needs its Young's modulus");
      else {
        const E = qty(e.youngModulus, "pressure", eBase + "/youngModulus");
        if (E === undefined) ok = false;
        else if (!inBounds(E)) bad("E_OUT_OF_RANGE", eBase + "/youngModulus", "Young's modulus is between " + E_MIN + " and " + E_MAX + " Pa (solids are 1e9 to 1e12), got " + E, { unit: "Pa" });
        else if (ok && nu !== undefined) elasticity = { kind: "constant", E, nu, ...(range ? { range } : {}) };
      }
    }
    if (ok && e.model === "linear") {
      const a = e.a === undefined ? undefined : qty(e.a, "pressure", eBase + "/a");
      const b = e.b === undefined ? undefined : qty(e.b, "pressurePerK", eBase + "/b");
      if (e.a === undefined) bad("E_PROP_MISSING", eBase + "/a", "a linear elasticity needs its term 'a'");
      if (e.b === undefined) bad("E_PROP_MISSING", eBase + "/b", "a linear elasticity needs its term 'b'");
      if (a === undefined || b === undefined) ok = false;
      else if (ok && range && nu !== undefined) {
        const lo = a + b * range[0];
        const hi = a + b * range[1];
        if (!inBounds(lo) || !inBounds(hi)) bad("E_OUT_OF_RANGE", eBase, "Young's modulus a + b T must be between " + E_MIN + " and " + E_MAX + " Pa across the whole valid range (it is " + lo + " Pa at " + range[0] + " K and " + hi + " Pa at " + range[1] + " K)", { unit: "Pa" });
        else elasticity = { kind: "linear", a, b, nu, range };
      }
    }
  }

  const x = sets["mechanical.thermalExpansion"];
  if (x === undefined) {
    if (required) missing(xBase, "mechanical.thermalExpansion", "the linear expansion coefficient of both solids");
  } else if (!isObject(x)) {
    err("E_SCHEMA_INVALID", xBase, "a property set is an object");
  } else {
    let ok = true;
    for (const k of Object.keys(x)) if (!["linearExpansion", "source"].includes(k)) {
      err("E_SCHEMA_INVALID", xBase + "/" + k, "unknown key '" + k + "' (a thermal expansion set has linearExpansion and source)");
      ok = false;
    }
    if (x.source === undefined || typeof x.source !== "string" || x.source.trim() === "") {
      err("E_PROP_MISSING", xBase + "/source", "the thermal expansion needs the source it comes from (a report and a table or page): FEED has none of its own");
      ok = false;
    }
    if (x.linearExpansion === undefined) {
      err("E_PROP_MISSING", xBase + "/linearExpansion", "the thermal expansion set needs its linearExpansion (a coefficient, or a linear law with its valid range)");
      ok = false;
    } else {
      expansion = expansionLaw(x.linearExpansion, xBase + "/linearExpansion", err, qty);
      if (!expansion) ok = false;
    }
    if (!ok) expansion = undefined;
  }
  return elasticity && expansion ? { elasticity, expansion } : undefined;
}

/**
 * The hot-dimensions section: the temperature the radii are stated at and, for each solid, a linear expansion coefficient with its source. Nothing is defaulted:
 * FEED has no expansion data of its own (docs/hot-dimensions.md).
 */
function parseHot(raw: unknown, err: ErrFn, qty: QtyFn): HotSpec | undefined {
  if (!isObject(raw)) {
    err("E_SCHEMA_INVALID", "/hotDimensions", "hotDimensions is an object with referenceTemperature, fuel and cladding");
    return undefined;
  }
  let ok = true;
  const bad = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
    ok = false;
    err(code, field, message, extra);
  };
  for (const k of Object.keys(raw)) if (!["referenceTemperature", "fuel", "cladding"].includes(k)) bad("E_SCHEMA_INVALID", "/hotDimensions/" + k, "unknown key '" + k + "' (hotDimensions has referenceTemperature, fuel and cladding)");
  let ref: number | undefined;
  if (raw.referenceTemperature === undefined) bad("E_PROP_MISSING", "/hotDimensions/referenceTemperature", "the temperature at which the radii are stated is needed (it is not assumed to be room temperature)");
  else {
    ref = qty(raw.referenceTemperature, "temperature", "/hotDimensions/referenceTemperature");
    if (ref === undefined) ok = false;
    else if (!(ref > 0 && ref <= MAX_REFERENCE_TEMPERATURE)) {
      bad("E_OUT_OF_RANGE", "/hotDimensions/referenceTemperature", "the reference temperature is above 0 K and at most " + MAX_REFERENCE_TEMPERATURE + " K", { unit: "K" });
      ref = undefined;
    }
  }
  const solid = (name: "fuel" | "cladding") => {
    const base = "/hotDimensions/" + name;
    const r = raw[name];
    if (r === undefined) return void bad("E_PROP_MISSING", base, "the " + name + " needs a linear expansion coefficient and its source");
    if (!isObject(r)) return void bad("E_SCHEMA_INVALID", base, "the " + name + " is an object with linearExpansion and source");
    for (const k of Object.keys(r)) if (!["linearExpansion", "source"].includes(k)) bad("E_SCHEMA_INVALID", base + "/" + k, "unknown key '" + k + "' (a solid has linearExpansion and source)");
    if (typeof r.source !== "string" || r.source.trim() === "") bad("E_PROP_MISSING", base + "/source", "the expansion coefficient needs the source it comes from: FEED has no expansion data of its own");
    if (r.linearExpansion === undefined) return void bad("E_PROP_MISSING", base + "/linearExpansion", "the " + name + " needs its linear expansion coefficient");
    const law = expansionLaw(r.linearExpansion, base + "/linearExpansion", err, qty);
    if (!law) {
      ok = false;
      return;
    }
    return { expansion: law, source: typeof r.source === "string" ? r.source.trim() : "" };
  };
  const fuel = solid("fuel");
  const cladding = solid("cladding");
  return ok && ref !== undefined && fuel && cladding && fuel.source !== "" && cladding.source !== "" ? { referenceTemperature: ref, fuel, cladding } : undefined;
}

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
        // all zero is a mistake from a uniform start (nothing is heated), but a shutdown from a steady operating state (a scram) is a real case, and so is a hot pin cooling or warming through a stated boundary history
        if (!(Math.max(...lhgr) > 0) && !(t.initialSteadyLinearHeatRate !== undefined && t.initialSteadyLinearHeatRate !== null) && t.boundaryHistory === undefined) bad("E_OUT_OF_RANGE", "/transient/powerHistory", "the power history is zero everywhere");
      } else ok = false;
    }
  } else if (hist !== undefined) {
    bad("E_SCHEMA_INVALID", "/transient/powerHistory", "the power history is a list of {time, linearHeatRate} points");
  }
  let boundaryHistory: BoundaryHistory | undefined;
  if (t.boundaryHistory !== undefined) {
    boundaryHistory = parseBoundaryHistory(t.boundaryHistory, err, qty, endTime);
    if (boundaryHistory === undefined) ok = false;
  }
  const initial: NormalizedTransient["initial"] | undefined = initialTemperature !== undefined ? { kind: "uniform", temperature: initialTemperature } : initialQ !== undefined ? { kind: "steady", linearHeatRate: initialQ } : undefined;
  if (!ok || endTime === undefined || timeStep === undefined || initial === undefined || typeof outputs !== "number" || times.length < 2) return undefined;
  return { times, linearHeatRate: lhgr, endTime, timeStep, steps, outputs, initial, ...(kinetics ? { kinetics } : {}), ...(boundaryHistory ? { boundaryHistory } : {}) };
}

/**
 * The coolant side as tables against time (plan 11 B1): points {time, bulkTemperature, heatTransferCoefficient} for a convective case or {time, surfaceTemperature} for a prescribed wall,
 * every point of the same form. Linear between points; OFFBEAT applies the value at the end of each step (found in B0), and the independent solution has to do the same. Nothing
 * is defaulted: the first point is at time 0 and the last reaches the end time (the writer adds the flat point OFFBEAT needs beyond it).
 */
function parseBoundaryHistory(raw: unknown, err: ErrFn, qty: QtyFn, endTime: number | undefined): BoundaryHistory | undefined {
  const base = "/transient/boundaryHistory";
  let ok = true;
  const bad = (code: string, field: string, message: string, extra: Partial<Issue> = {}) => {
    ok = false;
    err(code, field, message, extra);
  };
  if (!Array.isArray(raw)) {
    err("E_SCHEMA_INVALID", base, "the boundary history is a list of points: {time, bulkTemperature, heatTransferCoefficient} or {time, surfaceTemperature}");
    return undefined;
  }
  if (raw.length < 2) return void err("E_TIME", base, "the boundary history needs at least two points");
  if (raw.length > MAX_HISTORY_POINTS) return void err("E_TIME", base, "the boundary history has " + raw.length + " points; the maximum is " + MAX_HISTORY_POINTS);
  const times: number[] = [];
  const bulk: number[] = [];
  const h: number[] = [];
  const wall: number[] = [];
  let kind: "convective" | "surface-temperature" | undefined;
  raw.forEach((p: unknown, i: number) => {
    const f = base + "/" + i;
    if (!isObject(p)) return bad("E_SCHEMA_INVALID", f, "each point is {time, bulkTemperature, heatTransferCoefficient} or {time, surfaceTemperature}");
    const isWall = p.surfaceTemperature !== undefined;
    const isConv = p.bulkTemperature !== undefined || p.heatTransferCoefficient !== undefined;
    const allowed = isWall ? ["time", "surfaceTemperature"] : ["time", "bulkTemperature", "heatTransferCoefficient"];
    if (isWall && isConv) return bad("E_BOUNDARY_INCOMPLETE", f, "a point gives the boundary in two forms; choose bulk temperature with a heat-transfer coefficient, or a surface temperature");
    for (const k of Object.keys(p)) if (!allowed.includes(k)) bad("E_SCHEMA_INVALID", f + "/" + k, "unknown key '" + k + "' (a " + (isWall ? "prescribed-wall" : "convective") + " point has " + allowed.join(", ") + ")");
    const here = isWall ? "surface-temperature" : "convective";
    if (!isWall && !isConv) return bad("E_BOUNDARY_INCOMPLETE", f, "a point needs bulkTemperature with heatTransferCoefficient, or surfaceTemperature");
    if (kind === undefined) kind = here;
    else if (kind !== here) return bad("E_BOUNDARY_INCOMPLETE", f, "the points of a boundary history are all of one form; this one is " + here + " and the first was " + kind);
    if (p.time === undefined) return bad("E_PROP_MISSING", f + "/time", "a point needs its time");
    const tt = qty(p.time, "time", f + "/time");
    if (tt === undefined) return void (ok = false);
    if (isWall) {
      if (p.surfaceTemperature === undefined) return;
      const w = qty(p.surfaceTemperature, "temperature", f + "/surfaceTemperature");
      if (w === undefined) return void (ok = false);
      if (!(w > 0 && w <= HISTORY_TEMPERATURE_MAX)) return bad("E_OUT_OF_RANGE", f + "/surfaceTemperature", "the surface temperature is above 0 K and at most " + HISTORY_TEMPERATURE_MAX + " K", { unit: "K" });
      times.push(tt);
      wall.push(w);
    } else {
      if (p.bulkTemperature === undefined) return bad("E_BOUNDARY_INCOMPLETE", f + "/bulkTemperature", "a heat-transfer coefficient alone is not a boundary condition; a convective point also needs the bulk temperature");
      if (p.heatTransferCoefficient === undefined) return bad("E_BOUNDARY_INCOMPLETE", f + "/heatTransferCoefficient", "bulk temperature alone is not a boundary condition; a convective point also needs a heat-transfer coefficient");
      const tb = qty(p.bulkTemperature, "temperature", f + "/bulkTemperature");
      const hh = qty(p.heatTransferCoefficient, "htc", f + "/heatTransferCoefficient");
      if (tb === undefined || hh === undefined) return void (ok = false);
      if (!(tb > 0 && tb <= HISTORY_TEMPERATURE_MAX)) return bad("E_OUT_OF_RANGE", f + "/bulkTemperature", "the bulk temperature is above 0 K and at most " + HISTORY_TEMPERATURE_MAX + " K", { unit: "K" });
      if (!(hh >= HISTORY_HTC_MIN && hh <= HISTORY_HTC_MAX)) return bad("E_OUT_OF_RANGE", f + "/heatTransferCoefficient", "the heat-transfer coefficient is from " + HISTORY_HTC_MIN + " to " + HISTORY_HTC_MAX + " W/m2/K (a lost coolant is a small positive value, not zero)", { unit: "W/m2/K" });
      times.push(tt);
      bulk.push(tb);
      h.push(hh);
    }
  });
  if (!ok || kind === undefined) return undefined;
  if (times[0] !== 0) bad("E_TIME", base + "/0/time", "the boundary history must start at time 0");
  for (let i = 1; i < times.length; i++) {
    if (!(times[i]! > times[i - 1]!)) {
      bad("E_TIME", base + "/" + i + "/time", "history times must increase strictly");
      break;
    }
  }
  if (endTime !== undefined && times[times.length - 1]! < endTime * (1 - 1e-12)) bad("E_TIME", base, "the boundary history ends at " + times[times.length - 1] + " s, before the end time " + endTime + " s; give a point at or after the end time (the last value is not held)");
  if (!ok) return undefined;
  return kind === "convective" ? { kind, times, bulkTemperature: bulk, heatTransferCoefficient: h } : { kind, times, surfaceTemperature: wall };
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
