// Transfer intake (plan 05): how an upstream heat source or coolant condition enters a FEED case.
//
// The recipe and source shapes here are PROVISIONAL (docs/decisions/0003-provisional-transfer-shapes.md): SEED's recipe file
// format is still an open item in its plan 08. Everything is refusal-first: a value is mapped only when a complete,
// approved recipe says how, and every check below returns a named code instead of a guess.
//
// Pure functions, no I/O; the case is never modified in place.

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

/** SHA-256 of a case document's canonical text: what a recipe's target revision names. */
export function caseRevision(doc: unknown): string {
  return createHash("sha256").update(canonical(doc)).digest("hex");
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

// ---- shapes ----

export interface Approval {
  approver: string;
  time: string;
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
  source: { runId: string; revision: string; pin: string };
  target: { caseRevision: string };
  /** Axial slices of the pin, metres. One FEED case per slice. */
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
  /** Required for per-source-particle scores. */
  normalization?:
    | { kind: "source-rate"; value: { value: number; unit: string }; source: string }
    | { kind: "total-power"; value: { value: number; unit: string }; source: string };
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
  provenance: { recipeId: string; runId: string; sourceRevision: string; approval: Approval };
}

// ---- units ----

const ENERGY_J: Record<string, number> = { J: 1, eV: 1.602176634e-19, keV: 1.602176634e-16, MeV: 1.602176634e-13 };
const RATE: Record<string, number> = { "1/s": 1 };
const POWER_W: Record<string, number> = { W: 1, kW: 1e3, MW: 1e6 };
const LENGTH_M: Record<string, number> = { m: 1, cm: 1e-2, mm: 1e-3 };
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

// ---- heating ----

function checkApproval(r: Record<string, unknown>): Failed | undefined {
  const a = r.approval;
  if (!isObj(a) || typeof a.approver !== "string" || a.approver.trim() === "" || typeof a.time !== "string" || Number.isNaN(Date.parse(a.time))) {
    return refuse("E_RECIPE_INVALID", "/approval", "a recipe needs an approver and an approval time; an unapproved recipe is not used");
  }
  return undefined;
}

/**
 * Map a heating source onto the axial slices of one pin. Refuses: invalid or unapproved recipe, stale revision, wrong or
 * missing units or normalization, kinds mixed up, missing uncertainty, bins that do not cover a slice, and a mapping that
 * loses or invents power beyond the recipe's tolerance. Bins are taken as uniform in z within the bin; a bin that straddles
 * a slice boundary is split by overlap length.
 */
export function mapHeating(recipeIn: unknown, sourceIn: unknown, targetCase: unknown): HeatingMapped | Failed {
  if (!isObj(recipeIn) || recipeIn.schema !== "feed.transfer-recipe/0.1" || recipeIn.kind !== "heating" || typeof recipeIn.recipeId !== "string" || recipeIn.recipeId === "") {
    return refuse("E_RECIPE_INVALID", "/recipe", "not a heating transfer recipe with a recipe id");
  }
  const bad = checkApproval(recipeIn);
  if (bad) return bad;
  const rec = recipeIn as unknown as HeatingRecipe;
  if (!finite(rec.conservationTolerance) || rec.conservationTolerance <= 0 || rec.conservationTolerance >= 1) {
    return refuse("E_RECIPE_INVALID", "/conservationTolerance", "the conservation tolerance must be set in the recipe, above 0 and below 1");
  }
  if (!isObj(rec.source) || typeof rec.source.runId !== "string" || typeof rec.source.revision !== "string" || typeof rec.source.pin !== "string" || !isObj(rec.target) || typeof rec.target.caseRevision !== "string") {
    return refuse("E_RECIPE_INVALID", "/source", "the recipe must name the source run, revision and pin, and the target case revision");
  }
  if (!Array.isArray(rec.slices) || rec.slices.length === 0) return refuse("E_RECIPE_INVALID", "/slices", "the recipe defines no axial slices");
  const ids = new Set<string>();
  for (const [i, s] of rec.slices.entries()) {
    if (!isObj(s) || typeof s.id !== "string" || ids.has(s.id) || !isObj(s.z) || !finite(s.z.min) || !finite(s.z.max) || !(s.z.max > s.z.min)) {
      return refuse("E_RECIPE_INVALID", `/slices/${i}`, "each slice needs a unique id and a z range with max above min (metres)");
    }
    ids.add(s.id);
  }

  if (caseRevision(targetCase) !== rec.target.caseRevision) return refuse("E_STALE_REVISION", "/target/caseRevision", "the target case changed since the recipe was approved");

  if (!isObj(sourceIn) || sourceIn.schema !== "feed.heating-source/0.1" || !Array.isArray(sourceIn.bins)) {
    return refuse("E_SCHEMA_INVALID", "/source", "not a heating source");
  }
  const src = sourceIn as unknown as HeatingSource;
  if (src.runId !== rec.source.runId || src.revision !== rec.source.revision) return refuse("E_STALE_REVISION", "/source/revision", "the source run or revision is not the one the recipe was approved for");

  const kind = typeof src.scoreUnit === "string" ? scoreKind(src.scoreUnit) : undefined;
  if (!kind) return refuse("E_UNITS", "/source/scoreUnit", `unit ${String(src.scoreUnit)} is not one of J|eV|keV|MeV per source-particle, W, W/m, W/m3`);

  // Normalization to watts per unit score.
  let perScoreToW: number | undefined; // for per-particle scores
  let totalPowerNorm: number | undefined;
  if (kind.kind === "per-particle") {
    const n = src.normalization;
    if (!n || !isObj(n) || !isQty(n.value) || typeof n.source !== "string" || n.source === "") {
      return refuse("E_NORMALIZATION_MISSING", "/source/normalization", "a per-source-particle score has no watts without a stated source rate or total power and where it came from");
    }
    if (n.kind === "source-rate") {
      const f = RATE[n.value.unit];
      if (f === undefined || !(n.value.value > 0)) return refuse("E_UNITS", "/source/normalization/value", "a source rate is given in 1/s and is positive");
      perScoreToW = kind.toJ * n.value.value * f;
    } else if (n.kind === "total-power") {
      const f = POWER_W[n.value.unit];
      if (f === undefined || !(n.value.value > 0)) return refuse("E_UNITS", "/source/normalization/value", "a total power is given in W, kW or MW and is positive");
      totalPowerNorm = n.value.value * f;
    } else return refuse("E_NORMALIZATION_MISSING", "/source/normalization/kind", "normalization kind must be source-rate or total-power");
  } else if (src.normalization !== undefined) {
    return refuse("E_UNITS", "/source/normalization", `the score is already in ${src.scoreUnit}; a normalization would be applied twice`);
  }

  // Bins of the target pin, converted to watts.
  const pinBins: { z: Z; power: number; relError: number }[] = [];
  let allScore = 0;
  for (const [i, b] of src.bins.entries()) {
    if (!isObj(b) || typeof b.id !== "string" || typeof b.pin !== "string" || !isObj(b.z) || !finite(b.z.min) || !finite(b.z.max) || !(b.z.max > b.z.min) || !finite(b.value) || b.value < 0) {
      return refuse("E_SCHEMA_INVALID", `/source/bins/${i}`, "a bin needs an id, a pin, a z range and a non-negative finite value");
    }
    allScore += b.value;
    if (b.pin !== rec.source.pin) continue;
    if (!finite(b.relError) || b.relError < 0) return refuse("E_UNCERTAINTY_MISSING", `/source/bins/${i}/relError`, "the Monte Carlo relative error is carried through the mapping and cannot be dropped");
    const length = b.z.max - b.z.min;
    let watts: number;
    if (kind.kind === "per-particle") {
      watts = totalPowerNorm !== undefined ? 0 : b.value * perScoreToW!;
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
    pinBins.push({ z: { min: b.z.min, max: b.z.max }, power: kind.kind === "per-particle" && totalPowerNorm !== undefined ? b.value : watts, relError: b.relError });
  }
  if (kind.kind === "per-particle" && totalPowerNorm !== undefined) {
    if (!(allScore > 0)) return refuse("E_NORMALIZATION_MISSING", "/source/bins", "total-power normalization needs a positive score summed over all bins");
    for (const b of pinBins) b.power = (b.power / allScore) * totalPowerNorm;
  }
  if (pinBins.length === 0) return refuse("E_COVERAGE_INCOMPLETE", "/source/bins", `no bins belong to pin ${rec.source.pin}`);

  const sourceTotal = pinBins.reduce((s, b) => s + b.power, 0);
  if (!(sourceTotal > 0)) return refuse("E_COVERAGE_INCOMPLETE", "/source/bins", "the source has no power in the target pin");

  // Coverage: every slice must be fully covered by the pin's bins (no gaps, no extrapolation).
  const sorted = [...pinBins].sort((a, b) => a.z.min - b.z.min);
  const EPS = 1e-12;
  for (const s of rec.slices) {
    let at = s.z.min;
    for (const b of sorted) {
      if (b.z.max <= at + EPS) continue;
      if (b.z.min > at + EPS) break;
      at = Math.max(at, b.z.max);
      if (at >= s.z.max - EPS) break;
    }
    if (at < s.z.max - EPS) return refuse("E_COVERAGE_INCOMPLETE", `/slices/${s.id}`, `slice ${s.id} is not fully covered by bins of pin ${rec.source.pin} (covered to z = ${at} of ${s.z.max}); no extrapolation is done`);
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
    slices.push({ id: s.id, z: { ...s.z }, length, power: { value: power, unit: "W" }, linearHeatRate: { value: power / length, unit: "W/m" }, relError: power > 0 ? Math.sqrt(varSum) / power : 0 });
  }

  // Conservation against the source total over the mapped region (the pin's whole bin list), not over the slices.
  const mapped = slices.reduce((s, x) => s + x.power.value, 0);
  const rel = (mapped - sourceTotal) / sourceTotal;
  if (Math.abs(rel) > rec.conservationTolerance) {
    return refuse("E_CONSERVATION", "/slices", `mapped power ${mapped.toFixed(6)} W differs from the source total ${sourceTotal.toFixed(6)} W by ${(rel * 100).toFixed(4)}% (tolerance ${(rec.conservationTolerance * 100).toFixed(4)}%)`);
  }
  if (slices.some((s) => !(s.linearHeatRate.value > 0))) return refuse("E_COVERAGE_INCOMPLETE", "/slices", "a slice received no power; a case needs a positive linear heat rate");

  return { ok: true, slices, totals: { mapped, source: sourceTotal, relativeDifference: rel }, provenance: { recipeId: rec.recipeId, runId: src.runId, sourceRevision: src.revision, approval: rec.approval } };
}

// ---- coolant boundary ----

export interface BoundaryRecipe {
  schema: "feed.transfer-recipe/0.1";
  kind: "boundary";
  recipeId: string;
  approval: Approval;
  source: { runId: string; revision: string; regionId: string };
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
  region: { id: string; z: Z };
  bulkTemperature?: { value: number; unit: string };
  heatTransferCoefficient?: { value: number; unit: string };
  surfaceTemperature?: { value: number; unit: string };
  pressure?: { value: number; unit: string; convention?: string };
}
export interface BoundaryMapped {
  ok: true;
  boundary: Record<string, { value: number; unit: string }>;
  provenance: { recipeId: string; runId: string; sourceRevision: string; regionId: string; approval: Approval };
}

const TEMP_UNITS = new Set(["K", "degC"]);
const HTC_UNITS = new Set(["W/m2/K", "kW/m2/K"]);
const PRESSURE_UNITS = new Set(["Pa", "kPa", "MPa", "bar"]);

/** Map a coolant condition for one identified axial region. Bulk temperature alone is never a convective boundary. */
export function mapBoundary(recipeIn: unknown, sourceIn: unknown, targetCase: unknown): BoundaryMapped | Failed {
  if (!isObj(recipeIn) || recipeIn.schema !== "feed.transfer-recipe/0.1" || recipeIn.kind !== "boundary" || typeof recipeIn.recipeId !== "string" || recipeIn.recipeId === "") {
    return refuse("E_RECIPE_INVALID", "/recipe", "not a boundary transfer recipe with a recipe id");
  }
  const bad = checkApproval(recipeIn);
  if (bad) return bad;
  const rec = recipeIn as unknown as BoundaryRecipe;
  if (rec.boundaryForm !== "bulk-plus-h" && rec.boundaryForm !== "surface-temperature") {
    return refuse("E_BOUNDARY_INCOMPLETE", "/boundaryForm", "the recipe must choose bulk-plus-h or surface-temperature; there is no default");
  }
  if (!isObj(rec.source) || typeof rec.source.runId !== "string" || typeof rec.source.revision !== "string" || typeof rec.source.regionId !== "string" || !isObj(rec.target) || typeof rec.target.caseRevision !== "string" || !isObj(rec.slice) || !isObj(rec.slice.z) || !finite(rec.slice.z.min) || !finite(rec.slice.z.max) || !(rec.slice.z.max > rec.slice.z.min)) {
    return refuse("E_RECIPE_INVALID", "/source", "the recipe must name the source run, revision and region, the target case revision and the axial slice");
  }
  if (caseRevision(targetCase) !== rec.target.caseRevision) return refuse("E_STALE_REVISION", "/target/caseRevision", "the target case changed since the recipe was approved");
  if (!isObj(sourceIn) || sourceIn.schema !== "feed.coolant-source/0.1") return refuse("E_SCHEMA_INVALID", "/source", "not a coolant source");
  const src = sourceIn as unknown as CoolantSource;
  if (src.runId !== rec.source.runId || src.revision !== rec.source.revision) return refuse("E_STALE_REVISION", "/source/revision", "the source run or revision is not the one the recipe was approved for");
  if (!isObj(src.region) || src.region.id !== rec.source.regionId || !isObj(src.region.z) || !finite(src.region.z.min) || !finite(src.region.z.max)) {
    return refuse("E_COVERAGE_INCOMPLETE", "/source/region", `the source does not identify axial region ${rec.source.regionId}`);
  }
  if (rec.slice.z.min < src.region.z.min - 1e-12 || rec.slice.z.max > src.region.z.max + 1e-12) {
    return refuse("E_COVERAGE_INCOMPLETE", "/slice", "the slice lies outside the source region; the boundary is not extrapolated");
  }
  if (src.pressure !== undefined) {
    const p = src.pressure;
    if (!isQty(p) || !PRESSURE_UNITS.has(p.unit)) return refuse("E_UNITS", "/source/pressure", "pressure needs a value with unit Pa, kPa, MPa or bar");
    if (p.convention !== "absolute" && p.convention !== "gauge") return refuse("E_UNITS", "/source/pressure/convention", "pressure must state absolute or gauge");
  }
  const t = (name: string, q: unknown, units: Set<string>): { value: number; unit: string } | Failed => {
    if (!isQty(q)) return refuse("E_BOUNDARY_INCOMPLETE", `/source/${name}`, `${name} is missing`);
    if (!units.has(q.unit)) return refuse("E_UNITS", `/source/${name}`, `unit ${q.unit} is not valid for ${name}`);
    return { value: q.value, unit: q.unit };
  };
  const out: Record<string, { value: number; unit: string }> = {};
  if (rec.boundaryForm === "bulk-plus-h") {
    if (src.surfaceTemperature !== undefined) return refuse("E_BOUNDARY_INCOMPLETE", "/source/surfaceTemperature", "the recipe chose bulk-plus-h but the source also supplies a surface temperature; one form only");
    const bulk = t("bulkTemperature", src.bulkTemperature, TEMP_UNITS);
    if ("ok" in bulk) return bulk;
    const h = t("heatTransferCoefficient", src.heatTransferCoefficient, HTC_UNITS);
    if ("ok" in h) return h;
    if (!(h.value > 0)) return refuse("E_OUT_OF_RANGE", "/source/heatTransferCoefficient", "the heat transfer coefficient must be positive");
    out.bulkTemperature = bulk;
    out.heatTransferCoefficient = h;
  } else {
    if (src.bulkTemperature !== undefined || src.heatTransferCoefficient !== undefined) return refuse("E_BOUNDARY_INCOMPLETE", "/source", "the recipe chose surface-temperature but the source also supplies bulk/h values; one form only");
    const s = t("surfaceTemperature", src.surfaceTemperature, TEMP_UNITS);
    if ("ok" in s) return s;
    out.surfaceTemperature = s;
  }
  return { ok: true, boundary: out, provenance: { recipeId: rec.recipeId, runId: src.runId, sourceRevision: src.revision, regionId: src.region.id, approval: rec.approval } };
}

// ---- applying a mapping to a case ----

/** A copy of the case with the mapped values set and the transfer recorded under `provenance.transfers`. */
export function applyToCase(base: Record<string, unknown>, parts: { heating?: { slice: SliceResult; mapped: HeatingMapped }; boundary?: BoundaryMapped }): Record<string, unknown> {
  const doc = structuredClone(base) as Record<string, any>;
  const transfers: unknown[] = [];
  if (parts.heating) {
    const { slice, mapped } = parts.heating;
    doc.power = { ...(doc.power ?? {}), linearHeatRate: { value: slice.linearHeatRate.value, unit: "W/m" } };
    transfers.push({ kind: "heating", sliceId: slice.id, z: slice.z, relError: slice.relError, ...mapped.provenance, totals: mapped.totals });
  }
  if (parts.boundary) {
    doc.boundary = { ...parts.boundary.boundary };
    transfers.push({ kind: "boundary", ...parts.boundary.provenance });
  }
  doc.provenance = { ...(doc.provenance ?? {}), transfers: [...((doc.provenance?.transfers as unknown[]) ?? []), ...transfers] };
  return doc;
}
