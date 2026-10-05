// Transfer intake (plan 05): how an upstream heat source or coolant condition enters a FEED case.
//
// The recipe and source shapes here are PROVISIONAL (docs/decisions/0003-provisional-transfer-shapes.md): SEED's recipe file
// format is still an open item in its plan 08. Everything is refusal-first: a value is mapped only when a complete,
// approved recipe says how, and every check below returns a named code instead of a guess.
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
export interface HeatingRecipe {
  schema: "feed.transfer-recipe/0.1";
  kind: "heating";
  recipeId: string;
  approval: Approval;
  /** Relative tolerance on total mapped power against the source total over the mapped region; fixed before mapping. */
  conservationTolerance: number;
  /** The tally score (for example "heating") and the coordinate frame the bins and slices are given in. */
  source: { runId: string; revision: string; pin: string; score: string; frame: string };
  target: { caseRevision: string };
  /** Axial slices of the pin, metres. One FEED case per slice. They must not overlap. */
  slices: { id: string; z: Z }[];
}
export interface HeatingBin {
  id: string;
  pin: string;
  z: Z;
  /** In the source's score unit. */
  value: number;
  relError: number;
  /** Required when the score is a per-volume density. */
  volume?: { value: number; unit: string };
}
export interface HeatingSource {
  schema: "feed.heating-source/0.1";
  runId: string;
  revision: string;
  score: string;
  scoreUnit: string;
  frame: string;
  /** Only "steady" is accepted in this release. */
  temporal: "steady";
  /** Required for per-source-particle scores. A total power also states the domain it was defined over. */
  normalization?:
    | { kind: "source-rate"; value: { value: number; unit: string }; source: string }
    | { kind: "total-power"; value: { value: number; unit: string }; source: string; domain: { binCount: number; scoreTotal: number } };
  bins: HeatingBin[];
}

export interface SliceResult {
  id: string;
  z: Z;
  length: number;
  power: { value: number; unit: "W" };
  linearHeatRate: { value: number; unit: "W/m" };
  relError: number;
}
export interface HeatingMapped {
  ok: true;
  slices: SliceResult[];
  totals: { mapped: number; source: number; relativeDifference: number };
  provenance: { recipeId: string; runId: string; sourceRevision: string; targetRevision: string; score: string; frame: string; approval: Approval };
}

// ---- units ----

const ENERGY_J: Record<string, number> = { J: 1, eV: 1.602176634e-19, keV: 1.602176634e-16, MeV: 1.602176634e-13 };
const RATE: Record<string, number> = { "1/s": 1 };
const POWER_W: Record<string, number> = { W: 1, kW: 1e3, MW: 1e6 };
const VOLUME_M3: Record<string, number> = { m3: 1, cm3: 1e-6 };

type ScoreKind = { kind: "per-particle"; toJ: number } | { kind: "power" } | { kind: "per-length" } | { kind: "per-volume" };
function scoreKind(unit: string): ScoreKind | undefined {
  const m = /^(J|eV|keV|MeV)\/source-particle$/.exec(unit);
  if (m) return { kind: "per-particle", toJ: ENERGY_J[m[1]!]! };
  if (unit === "W") return { kind: "power" };
  if (unit === "W/m") return { kind: "per-length" };
  if (unit === "W/m3") return { kind: "per-volume" };
  return undefined;
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
function firstOverlap(zs: Z[]): number {
  const order = zs.map((z, i) => ({ z, i })).sort((a, b) => a.z.min - b.z.min);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1]!.z;
    const cur = order[k]!.z;
    const tol = REL_Z * Math.min(prev.max - prev.min, cur.max - cur.min);
    if (cur.min < prev.max - tol) return order[k]!.i;
  }
  return -1;
}

// ---- heating ----

/**
 * Map a heating source onto the axial slices of one pin. Refuses: invalid, unapproved or altered recipe, stale revision, a
 * different score or coordinate frame, a non-steady source, wrong or missing units or normalization (including an
 * unverifiable total-power domain), kinds mixed up, missing uncertainty, duplicate or overlapping bins, overlapping slices,
 * bins that do not cover a slice, non-finite arithmetic, and a mapping that loses or invents power beyond the recipe's
 * tolerance. Bins are taken as uniform in z within the bin; a bin that straddles a slice boundary is split by overlap length.
 */
export function mapHeating(recipeIn: unknown, sourceIn: unknown, targetCase: unknown): HeatingMapped | Failed {
  if (!isObj(recipeIn) || recipeIn.schema !== "feed.transfer-recipe/0.1" || recipeIn.kind !== "heating" || !nonEmpty(recipeIn.recipeId)) {
    return refuse("E_RECIPE_INVALID", "/recipe", "not a heating transfer recipe with a recipe id");
  }
  const bad = checkApproval(recipeIn);
  if (bad) return bad;
  const rec = recipeIn as unknown as HeatingRecipe;
  if (!finite(rec.conservationTolerance) || rec.conservationTolerance <= 0 || rec.conservationTolerance >= 1) {
    return refuse("E_RECIPE_INVALID", "/conservationTolerance", "the conservation tolerance must be set in the recipe, above 0 and below 1");
  }
  if (!isObj(rec.source) || !nonEmpty(rec.source.runId) || !nonEmpty(rec.source.revision) || !nonEmpty(rec.source.pin) || !nonEmpty(rec.source.score) || !nonEmpty(rec.source.frame) || !isObj(rec.target) || !nonEmpty(rec.target.caseRevision)) {
    return refuse("E_RECIPE_INVALID", "/source", "the recipe must name the source run, revision, pin, tally score and coordinate frame, and the target case revision");
  }
  if (!Array.isArray(rec.slices) || rec.slices.length === 0) return refuse("E_RECIPE_INVALID", "/slices", "the recipe defines no axial slices");
  const ids = new Set<string>();
  for (const [i, s] of rec.slices.entries()) {
    if (!isObj(s) || !nonEmpty(s.id) || ids.has(s.id) || !isObj(s.z) || !finite(s.z.min) || !finite(s.z.max) || !(s.z.max > s.z.min)) {
      return refuse("E_RECIPE_INVALID", `/slices/${i}`, "each slice needs a unique id and a z range with max above min (metres)");
    }
    ids.add(s.id);
  }
  if (firstOverlap(rec.slices.map((s) => s.z)) >= 0) return refuse("E_RECIPE_INVALID", "/slices", "slices overlap; each axial position belongs to exactly one slice");

  if (caseRevision(targetCase) !== rec.target.caseRevision) return refuse("E_STALE_REVISION", "/target/caseRevision", "the target case changed since the recipe was approved");

  if (!isObj(sourceIn) || sourceIn.schema !== "feed.heating-source/0.1" || !Array.isArray(sourceIn.bins)) {
    return refuse("E_SCHEMA_INVALID", "/source", "not a heating source");
  }
  const src = sourceIn as unknown as HeatingSource;
  if (src.runId !== rec.source.runId || src.revision !== rec.source.revision) return refuse("E_STALE_REVISION", "/source/revision", "the source run or revision is not the one the recipe was approved for");
  if (!nonEmpty(src.score) || src.score !== rec.source.score) return refuse("E_SCORE_MISMATCH", "/source/score", `the source score ${String(src.score)} is not the approved score ${rec.source.score}`);
  if (!nonEmpty(src.frame) || src.frame !== rec.source.frame) return refuse("E_FRAME_MISMATCH", "/source/frame", "the source coordinate frame is not the one the recipe was approved for; no transform is applied");
  if (src.temporal !== "steady") return refuse("E_UNSUPPORTED", "/source/temporal", "only steady-state sources are accepted in this release");

  const kind = typeof src.scoreUnit === "string" ? scoreKind(src.scoreUnit) : undefined;
  if (!kind) return refuse("E_UNITS", "/source/scoreUnit", `unit ${String(src.scoreUnit)} is not one of J|eV|keV|MeV per source-particle, W, W/m, W/m3`);

  // Normalization to watts per unit score.
  let perScoreToW: number | undefined; // per-particle scores with a source rate
  let totalPowerNorm: { watts: number; binCount: number; scoreTotal: number } | undefined;
  if (kind.kind === "per-particle") {
    const n = src.normalization;
    if (!n || !isObj(n) || !isQty(n.value) || !nonEmpty(n.source)) {
      return refuse("E_NORMALIZATION_MISSING", "/source/normalization", "a per-source-particle score has no watts without a stated source rate or total power and where it came from");
    }
    if (n.kind === "source-rate") {
      const f = RATE[n.value.unit];
      if (f === undefined || !(n.value.value > 0)) return refuse("E_UNITS", "/source/normalization/value", "a source rate is given in 1/s and is positive");
      perScoreToW = kind.toJ * n.value.value * f;
    } else if (n.kind === "total-power") {
      const f = POWER_W[n.value.unit];
      if (f === undefined || !(n.value.value > 0)) return refuse("E_UNITS", "/source/normalization/value", "a total power is given in W, kW or MW and is positive");
      const d = (n as { domain?: unknown }).domain;
      if (!isObj(d) || !Number.isInteger(d.binCount) || !(d.binCount as number > 0) || !finite(d.scoreTotal) || !(d.scoreTotal > 0)) {
        return refuse("E_NORMALIZATION_MISSING", "/source/normalization/domain", "a total power must state the domain it was defined over: the number of bins and the score total across them");
      }
      totalPowerNorm = { watts: n.value.value * f, binCount: d.binCount as number, scoreTotal: d.scoreTotal };
    } else return refuse("E_NORMALIZATION_MISSING", "/source/normalization/kind", "normalization kind must be source-rate or total-power");
    if (!finite(perScoreToW ?? totalPowerNorm?.watts)) return refuse("E_NUMERIC", "/source/normalization", "the normalization is not a finite number");
  } else if (src.normalization !== undefined) {
    return refuse("E_UNITS", "/source/normalization", `the score is already in ${src.scoreUnit}; a normalization would be applied twice`);
  }

  // Bins: unique ids; the target pin's bins converted to watts and not overlapping.
  const binIds = new Set<string>();
  const pinBins: { z: Z; power: number; relError: number }[] = [];
  let allScore = 0;
  for (const [i, b] of src.bins.entries()) {
    if (!isObj(b) || !nonEmpty(b.id) || !nonEmpty(b.pin) || !isObj(b.z) || !finite(b.z.min) || !finite(b.z.max) || !(b.z.max > b.z.min) || !finite(b.value) || b.value < 0) {
      return refuse("E_SCHEMA_INVALID", `/source/bins/${i}`, "a bin needs an id, a pin, a z range and a non-negative finite value");
    }
    if (binIds.has(b.id)) return refuse("E_SCHEMA_INVALID", `/source/bins/${i}/id`, `bin id ${b.id} appears twice; a repeated bin would count its power twice`);
    binIds.add(b.id);
    allScore += b.value;
    if (b.pin !== rec.source.pin) continue;
    if (!finite(b.relError) || b.relError < 0) return refuse("E_UNCERTAINTY_MISSING", `/source/bins/${i}/relError`, "the Monte Carlo relative error is carried through the mapping and cannot be dropped");
    const length = b.z.max - b.z.min;
    let watts: number;
    if (kind.kind === "per-particle") {
      watts = totalPowerNorm ? b.value : b.value * perScoreToW!; // total-power: still a score, scaled below
    } else if (kind.kind === "power") {
      watts = b.value;
    } else if (kind.kind === "per-length") {
      watts = b.value * length;
    } else {
      const v = b.volume;
      const f = v && isQty(v) ? VOLUME_M3[v.unit] : undefined;
      if (f === undefined || !(v!.value > 0)) return refuse("E_NORMALIZATION_MISSING", `/source/bins/${i}/volume`, "a W/m3 score needs the bin volume (m3 or cm3) to become watts");
      watts = b.value * v!.value * f;
    }
    pinBins.push({ z: { min: b.z.min, max: b.z.max }, power: watts, relError: b.relError });
  }
  if (totalPowerNorm) {
    if (src.bins.length !== totalPowerNorm.binCount) return refuse("E_NORMALIZATION_DOMAIN", "/source/normalization/domain/binCount", `the total power was defined over ${totalPowerNorm.binCount} bins but ${src.bins.length} were supplied; a partial export would hand power of the missing bins to the rest`);
    if (!(Math.abs(allScore - totalPowerNorm.scoreTotal) <= 1e-9 * totalPowerNorm.scoreTotal)) return refuse("E_NORMALIZATION_DOMAIN", "/source/normalization/domain/scoreTotal", `the supplied bins sum to ${allScore} but the normalization domain states ${totalPowerNorm.scoreTotal}`);
    for (const b of pinBins) b.power = (b.power / allScore) * totalPowerNorm.watts;
  }
  if (pinBins.length === 0) return refuse("E_COVERAGE_INCOMPLETE", "/source/bins", `no bins belong to pin ${rec.source.pin}`);
  if (pinBins.some((b) => !finite(b.power) || b.power < 0)) return refuse("E_NUMERIC", "/source/bins", "a converted bin power is not a finite non-negative number");
  if (firstOverlap(pinBins.map((b) => b.z)) >= 0) return refuse("E_SCHEMA_INVALID", "/source/bins", `bins of pin ${rec.source.pin} overlap in z; their contributions would be double counted`);

  const sourceTotal = pinBins.reduce((s, b) => s + b.power, 0);
  if (!finite(sourceTotal)) return refuse("E_NUMERIC", "/source/bins", "the source total is not a finite number");
  if (!(sourceTotal > 0)) return refuse("E_COVERAGE_INCOMPLETE", "/source/bins", "the source has no power in the target pin");

  // Coverage: every slice must be fully covered by the pin's bins (no gaps, no extrapolation).
  const sorted = [...pinBins].sort((a, b) => a.z.min - b.z.min);
  for (const s of rec.slices) {
    const eps = REL_Z * (s.z.max - s.z.min);
    let at = s.z.min;
    for (const b of sorted) {
      if (b.z.max <= at + eps) continue;
      if (b.z.min > at + eps) break;
      at = Math.max(at, b.z.max);
      if (at >= s.z.max - eps) break;
    }
    if (at < s.z.max - eps) return refuse("E_COVERAGE_INCOMPLETE", `/slices/${s.id}`, `slice ${s.id} is not fully covered by bins of pin ${rec.source.pin} (covered to z = ${at} of ${s.z.max}); no extrapolation is done`);
  }

  // Map: uniform density inside a bin, split by overlap length.
  const slices: SliceResult[] = [];
  for (const s of rec.slices) {
    let power = 0;
    let varSum = 0;
    for (const b of pinBins) {
      const overlap = Math.min(b.z.max, s.z.max) - Math.max(b.z.min, s.z.min);
      if (overlap <= 0) continue;
      const p = (b.power * overlap) / (b.z.max - b.z.min);
      power += p;
      varSum += (p * b.relError) ** 2;
    }
    const length = s.z.max - s.z.min;
    const q = power / length;
    const relError = power > 0 ? Math.sqrt(varSum) / power : 0;
    if (!finite(power) || !finite(q) || !finite(relError)) return refuse("E_NUMERIC", `/slices/${s.id}`, `slice ${s.id} gave a non-finite power, heat rate or uncertainty`);
    slices.push({ id: s.id, z: { ...s.z }, length, power: { value: power, unit: "W" }, linearHeatRate: { value: q, unit: "W/m" }, relError });
  }

  // Conservation against the source total over the mapped region (the pin's whole bin list), not over the slices.
  const mapped = slices.reduce((s, x) => s + x.power.value, 0);
  const rel = (mapped - sourceTotal) / sourceTotal;
  if (!finite(mapped) || !finite(rel)) return refuse("E_NUMERIC", "/slices", "the mapped total or its difference from the source total is not a finite number");
  if (Math.abs(rel) > rec.conservationTolerance) {
    return refuse("E_CONSERVATION", "/slices", `mapped power ${mapped.toFixed(6)} W differs from the source total ${sourceTotal.toFixed(6)} W by ${(rel * 100).toFixed(4)}% (tolerance ${(rec.conservationTolerance * 100).toFixed(4)}%)`);
  }
  if (slices.some((s) => !(s.linearHeatRate.value > 0))) return refuse("E_COVERAGE_INCOMPLETE", "/slices", "a slice received no power; a case needs a positive linear heat rate");

  return {
    ok: true,
    slices,
    totals: { mapped, source: sourceTotal, relativeDifference: rel },
    provenance: { recipeId: rec.recipeId, runId: src.runId, sourceRevision: src.revision, targetRevision: rec.target.caseRevision, score: src.score, frame: src.frame, approval: structuredClone(rec.approval) },
  };
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

// ---- applying a mapping to a case ----

/**
 * A copy of the case with the mapped values set and the transfer recorded under `provenance.transfers`. Refuses a base case
 * that is not the one each mapping was approved for, and a heating slice and a boundary slice that are not the same axial
 * interval. Nothing in the result shares references with the inputs.
 */
export function applyToCase(base: Record<string, unknown>, parts: { heating?: { slice: SliceResult; mapped: HeatingMapped }; boundary?: BoundaryMapped }): { ok: true; doc: Record<string, unknown> } | Failed {
  const rev = caseRevision(base);
  if (parts.heating) {
    if (rev !== parts.heating.mapped.provenance.targetRevision) return refuse("E_STALE_REVISION", "/target", "the case is not the one the heating mapping was approved for");
    if (!parts.heating.mapped.slices.some((s) => s.id === parts.heating!.slice.id && s.z.min === parts.heating!.slice.z.min && s.z.max === parts.heating!.slice.z.max && s.linearHeatRate.value === parts.heating!.slice.linearHeatRate.value)) {
      return refuse("E_RECIPE_INVALID", "/heating/slice", "the slice does not belong to this heating mapping");
    }
  }
  if (parts.boundary && rev !== parts.boundary.provenance.targetRevision) return refuse("E_STALE_REVISION", "/target", "the case is not the one the boundary mapping was approved for");
  if (parts.heating && parts.boundary) {
    const a = parts.heating.slice.z;
    const b = parts.boundary.slice.z;
    const tol = REL_Z * (a.max - a.min);
    if (Math.abs(a.min - b.min) > tol || Math.abs(a.max - b.max) > tol) {
      return refuse("E_COVERAGE_INCOMPLETE", "/boundary/slice", `the heating slice (z ${a.min} to ${a.max}) and the boundary slice (z ${b.min} to ${b.max}) are not the same axial interval`);
    }
  }
  const doc = structuredClone(base) as Record<string, any>;
  const transfers: unknown[] = [];
  if (parts.heating) {
    const { slice, mapped } = parts.heating;
    doc.power = { ...(doc.power ?? {}), linearHeatRate: { value: slice.linearHeatRate.value, unit: "W/m" } };
    transfers.push(structuredClone({ kind: "heating", sliceId: slice.id, z: slice.z, relError: slice.relError, ...mapped.provenance, totals: mapped.totals }));
  }
  if (parts.boundary) {
    doc.boundary = structuredClone(parts.boundary.boundary);
    transfers.push(structuredClone({ kind: "boundary", sliceId: parts.boundary.slice.id, z: parts.boundary.slice.z, ...parts.boundary.provenance }));
  }
  doc.provenance = { ...(doc.provenance ?? {}), transfers: [...((doc.provenance?.transfers as unknown[]) ?? []), ...transfers] };
  return { ok: true, doc };
}
