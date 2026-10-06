// Transfer intake (plan 05): how an upstream heat source or coolant condition enters a FEED case.
//
// HEATING moved to transferRequest.ts, which reads SEED's recipe (seed.transfer-recipe/0.2) and request. What remains here is the
// coolant BOUNDARY, whose recipe and source shapes are still PROVISIONAL (docs/decisions/0003-provisional-transfer-shapes.md):
// SEED has not yet fixed the NODAL source shape. It is not reachable from the `transfer` command. Everything is refusal-first:
// a value is mapped only when a complete, approved recipe says how, and every check returns a named code instead of a guess.
//
// Pure functions, no I/O; the case is never modified in place. Reviewed by Codex (docs/reviews/codex-2026-10-05-transfers.md).

import { createHash } from "crypto";

export interface TransferIssue {
  code: string;
  field: string;
  message: string;
}
export type Failed = { ok: false; errors: TransferIssue[] };

const refuse = (code: string, field: string, message: string): Failed => ({ ok: false, errors: [{ code, field, message }] });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isQty = (x: unknown): x is { value: number; unit: string } => isObj(x) && finite(x.value) && typeof x.unit === "string";
const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
/** Relative tolerance for comparing axial coordinates, as a fraction of the interval concerned. */
const REL_Z = 1e-9;

function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
const digest = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

/** SHA-256 of a case document's canonical text: what a recipe's target revision names. */
export function caseRevision(doc: unknown): string {
  return digest(doc);
}

/** SHA-256 of every field of a recipe except its approval. An approval covers exactly this content. */
export function recipeDigest(recipe: unknown): string {
  if (!isObj(recipe)) throw new TypeError("a recipe is an object");
  const { approval: _a, ...rest } = recipe;
  return digest(rest);
}

/**
 * A copy of the recipe with an approval over its current content. This binds the approval to the content (any later change
 * to the tolerance, mapping, source or target invalidates it); it does not authenticate the approver. Authenticity belongs
 * to SEED's approval record, which will replace this.
 */
export function approveRecipe<T extends Record<string, unknown>>(recipe: T, approver: string, time: string): T & { approval: Approval } {
  return { ...recipe, approval: { approver, time, recipeDigest: recipeDigest(recipe) } };
}

// ---- shapes ----

export interface Approval {
  approver: string;
  time: string;
  recipeDigest: string;
}
export interface Z {
  min: number;
  max: number;
}
// ---- common recipe checks ----

function checkApproval(r: Record<string, unknown>): Failed | undefined {
  const a = r.approval;
  if (!isObj(a) || !nonEmpty(a.approver) || typeof a.time !== "string" || Number.isNaN(Date.parse(a.time))) {
    return refuse("E_RECIPE_INVALID", "/approval", "a recipe needs an approver and an approval time; an unapproved recipe is not used");
  }
  if (typeof a.recipeDigest !== "string" || a.recipeDigest !== recipeDigest(r)) {
    return refuse("E_RECIPE_INVALID", "/approval/recipeDigest", "the approval does not cover this recipe's current content (tolerance, mapping, source or target changed after approval)");
  }
  return undefined;
}

/** Do the (sorted) intervals overlap in their interiors? Returns the offending pair's index or -1. */
export function firstOverlap(zs: Z[]): number {
  const order = zs.map((z, i) => ({ z, i })).sort((a, b) => a.z.min - b.z.min);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1]!.z;
    const cur = order[k]!.z;
    const tol = REL_Z * Math.min(prev.max - prev.min, cur.max - cur.min);
    if (cur.min < prev.max - tol) return order[k]!.i;
  }
  return -1;
}

// ---- coolant boundary ----

export interface BoundaryRecipe {
  schema: "feed.transfer-recipe/0.1";
  kind: "boundary";
  recipeId: string;
  approval: Approval;
  source: { runId: string; revision: string; regionId: string; frame: string };
  target: { caseRevision: string };
  /** The explicit choice; nothing is defaulted. */
  boundaryForm: "bulk-plus-h" | "surface-temperature";
  /** The axial slice the boundary applies to, metres; it must lie inside the source region. */
  slice: { id: string; z: Z };
}
export interface CoolantSource {
  schema: "feed.coolant-source/0.1";
  runId: string;
  revision: string;
  frame: string;
  /** Only "steady" is accepted in this release. */
  temporal: "steady";
  region: { id: string; z: Z };
  bulkTemperature?: { value: number; unit: string };
  heatTransferCoefficient?: { value: number; unit: string };
  surfaceTemperature?: { value: number; unit: string };
  pressure?: { value: number; unit: string; convention?: string };
}
export interface BoundaryMapped {
  ok: true;
  boundary: Record<string, { value: number; unit: string }>;
  slice: { id: string; z: Z };
  provenance: { recipeId: string; runId: string; sourceRevision: string; targetRevision: string; regionId: string; frame: string; approval: Approval };
}

const KELVIN_OFFSET: Record<string, number> = { K: 0, degC: 273.15 };
const HTC_UNITS = new Set(["W/m2/K", "kW/m2/K"]);
const PRESSURE_UNITS = new Set(["Pa", "kPa", "MPa", "bar"]);

/** Map a coolant condition for one identified axial region. Bulk temperature alone is never a convective boundary. */
export function mapBoundary(recipeIn: unknown, sourceIn: unknown, targetCase: unknown): BoundaryMapped | Failed {
  if (!isObj(recipeIn) || recipeIn.schema !== "feed.transfer-recipe/0.1" || recipeIn.kind !== "boundary" || !nonEmpty(recipeIn.recipeId)) {
    return refuse("E_RECIPE_INVALID", "/recipe", "not a boundary transfer recipe with a recipe id");
  }
  const bad = checkApproval(recipeIn);
  if (bad) return bad;
  const rec = recipeIn as unknown as BoundaryRecipe;
  if (rec.boundaryForm !== "bulk-plus-h" && rec.boundaryForm !== "surface-temperature") {
    return refuse("E_BOUNDARY_INCOMPLETE", "/boundaryForm", "the recipe must choose bulk-plus-h or surface-temperature; there is no default");
  }
  if (!isObj(rec.source) || !nonEmpty(rec.source.runId) || !nonEmpty(rec.source.revision) || !nonEmpty(rec.source.regionId) || !nonEmpty(rec.source.frame) || !isObj(rec.target) || !nonEmpty(rec.target.caseRevision) || !isObj(rec.slice) || !nonEmpty(rec.slice.id) || !isObj(rec.slice.z) || !finite(rec.slice.z.min) || !finite(rec.slice.z.max) || !(rec.slice.z.max > rec.slice.z.min)) {
    return refuse("E_RECIPE_INVALID", "/source", "the recipe must name the source run, revision, region and coordinate frame, the target case revision and the axial slice");
  }
  if (caseRevision(targetCase) !== rec.target.caseRevision) return refuse("E_STALE_REVISION", "/target/caseRevision", "the target case changed since the recipe was approved");
  if (!isObj(sourceIn) || sourceIn.schema !== "feed.coolant-source/0.1") return refuse("E_SCHEMA_INVALID", "/source", "not a coolant source");
  const src = sourceIn as unknown as CoolantSource;
  if (src.runId !== rec.source.runId || src.revision !== rec.source.revision) return refuse("E_STALE_REVISION", "/source/revision", "the source run or revision is not the one the recipe was approved for");
  if (!nonEmpty(src.frame) || src.frame !== rec.source.frame) return refuse("E_FRAME_MISMATCH", "/source/frame", "the source coordinate frame is not the one the recipe was approved for; no transform is applied");
  if (src.temporal !== "steady") return refuse("E_UNSUPPORTED", "/source/temporal", "only steady-state sources are accepted in this release");
  if (!isObj(src.region) || src.region.id !== rec.source.regionId || !isObj(src.region.z) || !finite(src.region.z.min) || !finite(src.region.z.max) || !(src.region.z.max > src.region.z.min)) {
    return refuse("E_COVERAGE_INCOMPLETE", "/source/region", `the source does not identify axial region ${rec.source.regionId} with a positive length`);
  }
  const tol = REL_Z * (rec.slice.z.max - rec.slice.z.min);
  if (rec.slice.z.min < src.region.z.min - tol || rec.slice.z.max > src.region.z.max + tol) {
    return refuse("E_COVERAGE_INCOMPLETE", "/slice", "the slice lies outside the source region; the boundary is not extrapolated");
  }
  if (src.pressure !== undefined) {
    const p = src.pressure;
    if (!isQty(p) || !PRESSURE_UNITS.has(p.unit)) return refuse("E_UNITS", "/source/pressure", "pressure needs a value with unit Pa, kPa, MPa or bar");
    if (p.convention !== "absolute" && p.convention !== "gauge") return refuse("E_UNITS", "/source/pressure/convention", "pressure must state absolute or gauge");
  }
  const temperature = (name: string, q: unknown): { value: number; unit: string } | Failed => {
    if (!isQty(q)) return refuse("E_BOUNDARY_INCOMPLETE", `/source/${name}`, `${name} is missing`);
    const off = KELVIN_OFFSET[q.unit];
    if (off === undefined) return refuse("E_UNITS", `/source/${name}`, `unit ${q.unit} is not valid for ${name}`);
    if (!(q.value + off > 0)) return refuse("E_OUT_OF_RANGE", `/source/${name}`, `${name} is at or below absolute zero`);
    return { value: q.value, unit: q.unit };
  };
  const out: Record<string, { value: number; unit: string }> = {};
  if (rec.boundaryForm === "bulk-plus-h") {
    if (src.surfaceTemperature !== undefined) return refuse("E_BOUNDARY_INCOMPLETE", "/source/surfaceTemperature", "the recipe chose bulk-plus-h but the source also supplies a surface temperature; one form only");
    const bulk = temperature("bulkTemperature", src.bulkTemperature);
    if ("ok" in bulk) return bulk;
    const h = src.heatTransferCoefficient;
    if (!isQty(h)) return refuse("E_BOUNDARY_INCOMPLETE", "/source/heatTransferCoefficient", "heatTransferCoefficient is missing");
    if (!HTC_UNITS.has(h.unit)) return refuse("E_UNITS", "/source/heatTransferCoefficient", `unit ${h.unit} is not valid for heatTransferCoefficient`);
    if (!(h.value > 0)) return refuse("E_OUT_OF_RANGE", "/source/heatTransferCoefficient", "the heat transfer coefficient must be positive");
    out.bulkTemperature = bulk;
    out.heatTransferCoefficient = { value: h.value, unit: h.unit };
  } else {
    if (src.bulkTemperature !== undefined || src.heatTransferCoefficient !== undefined) return refuse("E_BOUNDARY_INCOMPLETE", "/source", "the recipe chose surface-temperature but the source also supplies bulk/h values; one form only");
    const s = temperature("surfaceTemperature", src.surfaceTemperature);
    if ("ok" in s) return s;
    out.surfaceTemperature = s;
  }
  return {
    ok: true,
    boundary: out,
    slice: { id: rec.slice.id, z: { ...rec.slice.z } },
    provenance: { recipeId: rec.recipeId, runId: src.runId, sourceRevision: src.revision, targetRevision: rec.target.caseRevision, regionId: src.region.id, frame: src.frame, approval: structuredClone(rec.approval) },
  };
}

// ---- applying a boundary mapping to a case ----

/**
 * A copy of the case with the mapped boundary set and the transfer recorded under `provenance.transfers`. Refuses a base case
 * that is not the one the mapping was approved for. Nothing in the result shares references with the inputs.
 */
export function applyToCase(base: Record<string, unknown>, parts: { boundary: BoundaryMapped }): { ok: true; doc: Record<string, unknown> } | Failed {
  if (caseRevision(base) !== parts.boundary.provenance.targetRevision) return refuse("E_STALE_REVISION", "/target", "the case is not the one the boundary mapping was approved for");
  const prov = base.provenance as Record<string, unknown> | undefined;
  if (prov !== undefined && (!isObj(prov) || (prov.transfers !== undefined && !Array.isArray(prov.transfers)))) return refuse("E_SCHEMA_INVALID", "/provenance", "the case's provenance (and its transfers list) must be an object (and a list) to append this transfer to");
  const doc = structuredClone(base) as Record<string, any>;
  doc.boundary = structuredClone(parts.boundary.boundary);
  const entry = structuredClone({ kind: "boundary", sliceId: parts.boundary.slice.id, z: parts.boundary.slice.z, ...parts.boundary.provenance });
  doc.provenance = { ...(doc.provenance ?? {}), transfers: [...((doc.provenance?.transfers as unknown[]) ?? []), entry] };
  return { ok: true, doc };
}
