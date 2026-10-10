// FEED's `burnup` transfer: a burnup read from a depletion record (OpenMC Studio's depletion.json, record kind depletion-record/1) becomes the case's `burnup`
// (docs/transfer-burnup.md, plan 10 M6). SEED's contract is docs/transfer-recipe.md section 8 in the SEED repository: a seed.transfer-request/0.3 whose source is a
// RECORD, not a run quantity.
//
// SEED has already checked, before this runs: the approval, the unit conversion (MWd/tU to MWd/kgHM, x 0.001, heavy metal), that the record file is the pinned file with
// the pinned id and that the id is the SHA-256 of its canonical text, that the region exists, and that the time lies inside the record (cumulative burnup at the end of
// each step, linear inside a step, 0 at t = 0, never extrapolated). It sends the burnup already converted. FEED owns the physics: that the quantity is what the case's
// `burnup` takes (MWd/kgHM, heavy metal), that the request agrees with its recipe, that the fuel uses the burnup model, steady only, 0 to 62 MWd/kgHM, and the case itself.
// FEED never applies 0.881 or 0.8815 here: it multiplies by its own constant when it writes the solver's field. Refusal-first: nothing is defaulted.
//
// Pure functions, no I/O; the target case is never modified in place.

import { Failed, TransferIssue } from "./transfer";
import { validateCase } from "./validate";

export const BURNUP_FIELD = "burnup";
const REQUEST_SCHEMA = "seed.transfer-request/0.3";
const RECIPE_SCHEMA = "seed.transfer-recipe/0.3";
const RECORD_KIND = "depletion-record/1";
const HEX64 = /^[0-9a-f]{64}$/;
/** MWd/tU to MWd/kgHM; SEED sends the converted value and the original, and FEED checks that they agree. */
const FACTOR = 1e-3;

export const BURNUP_DESCRIPTION = {
  field: BURNUP_FIELD,
  accepts: [{ dimension: "burnup", normalization: "none" }],
  parameters: {
    region: "the record's region name (one per burnable material)",
    time: "days from the start of the record (inside the record, never extrapolated)",
    produces: "burnup.value in MWd/kgHM, burnup.basis heavy-metal and burnup.source naming the record id; nothing else in the case changes except a provenance entry",
    case: "the fuel's conductivity must be the burnup model (uo2-nfi); steady only; the result must be 0 to 62 MWd/kgHM; FEED applies its own oxide constant when it writes the solver's field",
  },
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
const refuse = (code: string, field: string, message: string): Failed => ({ ok: false, errors: [{ code, field, message }] });

export interface BurnupOk {
  ok: true;
  output: { content: string };
  checks: Record<string, unknown>;
}
export type BurnupReply = BurnupOk | Failed;

/** Set the case's burnup from one value of a depletion record. */
export function transferBurnup(requestIn: unknown): BurnupReply {
  if (!isObj(requestIn) || requestIn.schema !== REQUEST_SCHEMA) return refuse("E_SCHEMA_INVALID", "/schema", `not a ${REQUEST_SCHEMA} request`);
  const recipe = requestIn.recipe;
  if (!isObj(recipe) || recipe.schema !== RECIPE_SCHEMA || !nonEmpty(recipe.recipeId)) return refuse("E_RECIPE_INVALID", "/recipe", `not a ${RECIPE_SCHEMA} recipe with a recipe id`);
  const recipeDigest = typeof requestIn.recipeDigest === "string" ? requestIn.recipeDigest : undefined;
  const rt = recipe.target;
  if (!isObj(rt) || rt.app !== "feed") return refuse("E_RECIPE_INVALID", "/recipe/target/app", "the recipe's target is not FEED");
  if (rt.field !== BURNUP_FIELD) return refuse("E_UNSUPPORTED", "/recipe/target/field", `this command takes the field ${BURNUP_FIELD}; ${String(rt.field)} is not it`);
  const rs = recipe.source;
  if (!isObj(rs) || rs.kind !== "record" || rs.record !== RECORD_KIND) return refuse("E_RECIPE_INVALID", "/recipe/source", `the recipe's source is not a ${RECORD_KIND} record`);
  const ru = recipe.units;
  if (!isObj(ru) || ru.field !== "burnup_mwd_per_tu" || ru.from !== "MWd/tU" || ru.to !== "MWd/kgHM" || ru.factor !== FACTOR || ru.basis !== "heavy-metal") {
    return refuse("E_UNITS", "/recipe/units", "FEED takes a burnup on a heavy-metal basis, MWd/tU to MWd/kgHM with the factor 0.001; an oxide basis or another factor is refused");
  }

  // the request: the record, the region and the time, and the value already converted
  const src = requestIn.source;
  if (!isObj(src) || src.kind !== "record" || src.record !== RECORD_KIND) return refuse("E_SCHEMA_INVALID", "/source", `the request's source is not a ${RECORD_KIND} record`);
  if (!nonEmpty(src.recordId) || !HEX64.test(src.recordId)) return refuse("E_SCHEMA_INVALID", "/source/recordId", "the record id must be 64 lowercase hex digits (SHA-256)");
  if (!nonEmpty(src.recordSha256) || !HEX64.test(src.recordSha256)) return refuse("E_SCHEMA_INVALID", "/source/recordSha256", "the record file hash must be 64 lowercase hex digits (SHA-256)");
  if (!nonEmpty(src.region)) return refuse("E_SCHEMA_INVALID", "/source/region", "the request names no region");
  if (!finite(src.time) || src.time < 0) return refuse("E_SCHEMA_INVALID", "/source/time", "the time must be a finite number of days, 0 or more");
  // what the recipe approved is what the request carries; a mismatch is a request that is not the approved recipe
  for (const k of ["recordId", "recordSha256", "region", "time"] as const) {
    if (rs[k] !== src[k]) return refuse("E_RECIPE_INVALID", `/source/${k}`, `the request's ${k} (${String(src[k])}) is not the one the recipe was approved for (${String(rs[k])})`);
  }
  const q = src.quantity;
  if (!isObj(q) || q.name !== "burnup" || q.dimension !== "burnup") return refuse("E_SCHEMA_INVALID", "/source/quantity", "the quantity is not a burnup");
  if (q.unit !== "MWd/kgHM") return refuse("E_UNITS", "/source/quantity/unit", `the case takes MWd/kgHM; the request carries ${String(q.unit)}`);
  if (q.basis !== "heavy-metal") return refuse("E_UNSUPPORTED", "/source/quantity/basis", `the burnup is on the ${String(q.basis)} basis; FEED takes heavy metal only`);
  if (!finite(q.value) || q.value < 0) return refuse("E_OUT_OF_RANGE", "/source/quantity/value", "the burnup must be a finite number, 0 or more");
  const orig = src.original;
  if (!isObj(orig) || orig.unit !== "MWd/tU" || !finite(orig.value)) return refuse("E_SCHEMA_INVALID", "/source/original", "the original value (MWd/tU) is missing");
  // the converted value must be the original times the recipe's factor: a disagreement would be a number FEED cannot trace to the record
  if (Math.abs(q.value - orig.value * FACTOR) > 1e-9 * Math.max(Math.abs(orig.value * FACTOR), 1e-12)) {
    return refuse("E_UNITS", "/source/quantity/value", `the converted burnup ${q.value} MWd/kgHM is not the record's ${orig.value} MWd/tU times ${FACTOR}`);
  }
  if (typeof src.interpolated !== "boolean") return refuse("E_SCHEMA_INVALID", "/source/interpolated", "the request does not say whether the time was inside a step (interpolated)");

  // the target case
  const target0 = requestIn.target;
  if (!isObj(target0) || typeof target0.content !== "string") return refuse("E_SCHEMA_INVALID", "/target/content", "the request carries no target case text");
  let base: Record<string, any>;
  try {
    const parsed: unknown = JSON.parse(target0.content);
    if (!isObj(parsed)) throw new Error("not an object");
    base = parsed;
  } catch {
    return refuse("E_SCHEMA_INVALID", "/target/content", "the target case is not a JSON object");
  }
  const model = base.materials?.fuel?.sets?.["thermal.conductivity"]?.model;
  if (model !== "uo2-nfi") {
    return refuse("E_UNSUPPORTED", "/target/content/materials/fuel/sets/thermal.conductivity/model", `a burnup changes only the conductivity model uo2-nfi; this case's fuel uses ${String(model)}, so the burnup would change nothing`);
  }
  if (isObj(base.assumptions) && base.assumptions.steadyState === false) return refuse("E_UNSUPPORTED", "/target/content", "a burnup is frozen over a steady case; it cannot be applied to a transient");
  if (base.provenance !== undefined && (!isObj(base.provenance) || (base.provenance.transfers !== undefined && !Array.isArray(base.provenance.transfers)))) {
    return refuse("E_SCHEMA_INVALID", "/target/content/provenance", "the target case's provenance (and its transfers list) must be an object (and a list) to append this transfer to");
  }

  // the new case: the burnup replaces the case's own (its unit, basis and source are rewritten; nothing else is touched)
  const doc = structuredClone(base);
  doc.burnup = {
    value: { value: q.value, unit: "MWd/kgHM" },
    basis: "heavy-metal",
    source: `${RECORD_KIND} id ${src.recordId}, region "${src.region}", t = ${src.time} d${src.interpolated ? " (interpolated inside a step)" : ""}`,
  };
  const entry = {
    kind: "burnup",
    recipeId: recipe.recipeId,
    ...(recipeDigest ? { recipeDigest } : {}),
    record: RECORD_KIND,
    recordId: src.recordId,
    recordSha256: src.recordSha256,
    region: src.region,
    time: src.time,
    timeUnit: "d",
    interpolated: src.interpolated,
    original: { value: orig.value, unit: "MWd/tU" },
    burnup: { value: q.value, unit: "MWd/kgHM", basis: "heavy-metal" },
  };
  doc.provenance = { ...(doc.provenance ?? {}), transfers: [...((doc.provenance?.transfers as unknown[]) ?? []), structuredClone(entry)] };
  const after = validateCase(doc);
  if (!after.ok) {
    return { ok: false, errors: after.errors.slice(0, 20).map((e): TransferIssue => ({ code: e.code, field: "/target/content" + e.field, message: "the mapped case is not valid: " + e.message })) };
  }
  const content = JSON.stringify(doc, null, 2) + "\n";
  return {
    ok: true,
    output: { content },
    checks: {
      burnup: { value: q.value, unit: "MWd/kgHM", basis: "heavy-metal" },
      record: { kind: RECORD_KIND, id: src.recordId, region: src.region, timeDays: src.time, interpolated: src.interpolated },
      conversion: `the request's ${q.value} MWd/kgHM equals the record's ${orig.value} MWd/tU times ${FACTOR}`,
      warnings: after.warnings.map((w) => ({ code: w.code, field: w.field, message: w.message })),
    },
  };
}
