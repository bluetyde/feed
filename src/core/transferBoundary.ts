// FEED's `coolant-boundary` transfer: a coolant condition from an upstream run (NODAL) becomes the case's boundary at the outside of the
// cladding (docs/transfer-boundary.md). SEED's contract is docs/transfer-recipe.md section 7 in the SEED repository.
//
// SEED has already checked the approval, the pinned hashes, units against dimensions and that the source run completed, and it has PICKED
// the sample of each time series (`source.selected`, `source.additional[i].selected`: the last one, or one at a time, linear between two
// samples and flagged, never extrapolated). FEED owns the physics: that the quantities make a complete boundary of the chosen form, the
// values (absolute temperature above 0 K, a positive coefficient), the conversion to the case's units, and what the new case says.
// Refusal-first: nothing is defaulted, and a role FEED has no place for is refused, not dropped.
//
// Pure functions, no I/O; the target case is never modified in place.

import { Failed, TransferIssue, Z } from "./transfer";
import { validateCase } from "./validate";

const REQUEST_SCHEMA = "seed.transfer-request/0.2";
const RECIPE_SCHEMA = "seed.transfer-recipe/0.2";
export const BOUNDARY_FIELD = "coolant-boundary";
export const HTC_ROLE = "heat-transfer-coefficient";

/** What `describe.transfers` says FEED takes for this field: two forms, matched by SEED on exactly these roles. */
export const BOUNDARY_DESCRIPTION = {
  field: BOUNDARY_FIELD,
  accepts: [
    { dimension: "temperature", normalization: "none", additional: [{ role: HTC_ROLE, dimension: "heat-transfer-coefficient" }] },
    { dimension: "temperature", normalization: "none" },
  ],
  parameters: {
    spatial: "region {id, z {min, max}} in metres (the axial region of the source the values belong to), boundaryForm: bulk-plus-h | surface-temperature. No other keys; pressure is not accepted",
    forms: "bulk-plus-h: the primary quantity is the coolant bulk temperature and the additional role heat-transfer-coefficient is required. surface-temperature: the primary quantity is the temperature of the cladding's outer surface and there is no additional quantity",
    produces: "boundary.bulkTemperature (K) and boundary.heatTransferCoefficient (W/m2/K), or boundary.surfaceTemperature (K); units.to is K and the coefficient's unitTo is W/m2/K",
    time: "steady only: SEED selects the sample of each series (last, or at a time) before the request reaches FEED",
    region: "a FEED case is one axial slice: if a heating transfer is already recorded in the case, the region must contain that slice",
  },
};

const REL_Z = 1e-9;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
const refuse = (code: string, field: string, message: string): Failed => ({ ok: false, errors: [{ code, field, message }] });

const TEMPERATURE_OFFSET: Record<string, number> = { K: 0, degC: 273.15 };
const HTC_FACTOR: Record<string, number> = { "W/m2/K": 1, "W/m^2/K": 1, "kW/m2/K": 1e3, "kW/m^2/K": 1e3 };
const SPATIAL_KEYS = new Set(["region", "boundaryForm"]);

export interface BoundaryOk {
  ok: true;
  output: { content: string };
  checks: Record<string, unknown>;
}
export type BoundaryReply = BoundaryOk | Failed;

interface Sample {
  role: string;
  quantity: string;
  x: number;
  value: number;
  unit: string;
  interpolated: boolean;
  dataSha256: unknown;
}

/** One quantity of the request: the recipe's spec, the request's entry, and the sample SEED selected. */
function readSample(role: string, spec: unknown, entry: unknown, at: string): Sample | Failed {
  if (!isObj(spec) || !nonEmpty(spec.quantity) || !nonEmpty(spec.unit)) return refuse("E_RECIPE_INVALID", at, "the recipe's quantity needs a name and a unit");
  if (!isObj(entry)) return refuse("E_SCHEMA_INVALID", at, "the request carries no entry for this quantity");
  const q = isObj(entry.quantity) ? entry.quantity : undefined;
  if (!q || q.name !== spec.quantity) return refuse("E_RECIPE_INVALID", `${at}/quantity`, `the request's quantity is ${String(q?.name)} but the recipe was approved for ${String(spec.quantity)}`);
  if (q.unit !== spec.unit) return refuse("E_UNITS", `${at}/quantity/unit`, `the quantity is in ${String(q.unit)} but the recipe was approved for ${String(spec.unit)}`);
  const sel = entry.selected;
  if (!isObj(sel) || !finite(sel.x) || !finite(sel.value) || typeof sel.interpolated !== "boolean") {
    return refuse("E_TIME_MAPPING", `${at}/selected`, "a steady boundary needs the one sample SEED selected from the series (x, value, interpolated); none arrived");
  }
  return { role, quantity: String(spec.quantity), x: sel.x, value: sel.value, unit: String(spec.unit), interpolated: sel.interpolated, dataSha256: spec.dataSha256 };
}

/** Temperature in kelvin, or a refusal. */
function toKelvin(s: Sample, at: string): number | Failed {
  const off = TEMPERATURE_OFFSET[s.unit];
  if (off === undefined) return refuse("E_UNITS", at, `${s.quantity} is in ${s.unit}; FEED reads temperatures in K or degC`);
  const k = s.value + off;
  if (!(k > 0)) return refuse("E_OUT_OF_RANGE", at, `${s.quantity} is ${s.value} ${s.unit}, at or below absolute zero`);
  return k;
}

/** Turn the coolant condition of a NODAL (or other) run into the boundary of the pin case. */
export function transferBoundary(requestIn: unknown): BoundaryReply {
  if (!isObj(requestIn) || requestIn.schema !== REQUEST_SCHEMA) return refuse("E_SCHEMA_INVALID", "/schema", `not a ${REQUEST_SCHEMA} request`);
  const recipe = requestIn.recipe;
  if (!isObj(recipe) || recipe.schema !== RECIPE_SCHEMA || !nonEmpty(recipe.recipeId)) return refuse("E_RECIPE_INVALID", "/recipe", `not a ${RECIPE_SCHEMA} recipe with a recipe id`);
  const recipeDigest = typeof requestIn.recipeDigest === "string" ? requestIn.recipeDigest : undefined;
  const target = recipe.target;
  if (!isObj(target) || target.app !== "feed") return refuse("E_RECIPE_INVALID", "/recipe/target/app", "the recipe's target is not FEED");
  if (target.field !== BOUNDARY_FIELD) return refuse("E_UNSUPPORTED", "/recipe/target/field", `this transfer sets ${BOUNDARY_FIELD}; ${String(target.field)} is not it`);

  const rs = recipe.source;
  const mapping = recipe.mapping;
  const norm = recipe.normalization;
  if (!isObj(rs) || !isObj(mapping) || !isObj(norm) || !isObj(recipe.units)) return refuse("E_RECIPE_INVALID", "/recipe", "the recipe lacks source, units, normalization or mapping");
  if (!isObj(mapping.time) || mapping.time.kind !== "steady") return refuse("E_UNSUPPORTED", "/recipe/mapping/time/kind", "only a steady boundary is accepted in this release");
  if (mapping.extrapolation !== "refused") return refuse("E_RECIPE_INVALID", "/recipe/mapping/extrapolation", "extrapolation must be refused; FEED never extrapolates");
  if (norm.kind !== "none") return refuse("E_UNITS", "/recipe/normalization/kind", "a temperature and a coefficient are absolute quantities; a normalization would change them");
  if (recipe.units.to !== "K") return refuse("E_UNITS", "/recipe/units/to", "FEED sets the temperature in K (units.to is K)");
  if (rs.dimension !== "temperature" || rs.normalization !== "none") return refuse("E_UNITS", "/recipe/source", "the primary quantity of a coolant boundary is a temperature with normalization none");

  // the spatial vocabulary: strict, so a mistyped key is a refusal and not a silent default
  const sp = mapping.spatial;
  if (!isObj(sp)) return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial", "mapping.spatial is missing");
  for (const k of Object.keys(sp)) {
    if (k === "pressure") return refuse("E_UNSUPPORTED", "/recipe/mapping/spatial/pressure", "FEED's thermal model has no use for a coolant pressure and would drop it; it is not accepted");
    if (!SPATIAL_KEYS.has(k)) return refuse("E_RECIPE_INVALID", `/recipe/mapping/spatial/${k}`, `unknown key ${k}; FEED reads region and boundaryForm`);
  }
  const region = sp.region;
  if (!isObj(region) || !nonEmpty(region.id) || !isObj(region.z) || !finite(region.z.min) || !finite(region.z.max) || !(region.z.max > region.z.min)) {
    return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial/region", "the region needs an id and a z range with max above min (metres)");
  }
  const regionZ: Z = { min: region.z.min, max: region.z.max };
  const form = sp.boundaryForm;
  if (form !== "bulk-plus-h" && form !== "surface-temperature") return refuse("E_BOUNDARY_INCOMPLETE", "/recipe/mapping/spatial/boundaryForm", "choose bulk-plus-h or surface-temperature; there is no default");

  // the quantities and their roles
  const src = requestIn.source;
  if (!isObj(src)) return refuse("E_SCHEMA_INVALID", "/source", "the request carries no source");
  const recipeAdditional = Array.isArray(rs.additional) ? (rs.additional as unknown[]) : [];
  const requestAdditional = Array.isArray(src.additional) ? (src.additional as unknown[]) : [];
  if (recipeAdditional.length !== requestAdditional.length) return refuse("E_RECIPE_INVALID", "/source/additional", "the request's additional quantities are not the recipe's");
  for (const [i, a] of recipeAdditional.entries()) {
    const role = isObj(a) ? a.role : undefined;
    if (role !== HTC_ROLE) return refuse("E_UNSUPPORTED", `/recipe/source/additional/${i}/role`, `FEED has no place for the role ${String(role)}; it takes ${HTC_ROLE} with a bulk temperature and nothing with a surface temperature`);
    if (!isObj(requestAdditional[i]) || (requestAdditional[i] as Record<string, unknown>).role !== role) return refuse("E_RECIPE_INVALID", `/source/additional/${i}/role`, "the request's additional quantity has another role than the recipe's");
  }
  if (form === "bulk-plus-h" && recipeAdditional.length === 0) return refuse("E_BOUNDARY_INCOMPLETE", "/recipe/source/additional", "a bulk temperature alone is not a convective boundary: the heat transfer coefficient of the same run is needed (bulk-plus-h)");
  if (form === "surface-temperature" && recipeAdditional.length > 0) return refuse("E_BOUNDARY_INCOMPLETE", "/recipe/source/additional", "the recipe chose surface-temperature but also carries a heat transfer coefficient; one form only");
  if (recipeAdditional.length > 1) return refuse("E_BOUNDARY_INCOMPLETE", "/recipe/source/additional", "a boundary takes one heat transfer coefficient");

  const primary = readSample(form === "bulk-plus-h" ? "bulk-temperature" : "surface-temperature", rs, src, "/source");
  if ("ok" in primary) return primary;
  const kelvin = toKelvin(primary, "/source/selected/value");
  if (typeof kelvin !== "number") return kelvin;
  const samples: Sample[] = [primary];
  let h: number | undefined;
  if (form === "bulk-plus-h") {
    const spec = recipeAdditional[0] as Record<string, unknown>;
    const s = readSample(HTC_ROLE, spec, requestAdditional[0], "/source/additional/0");
    if ("ok" in s) return s;
    const f = HTC_FACTOR[s.unit];
    if (f === undefined) return refuse("E_UNITS", "/source/additional/0/quantity/unit", `the coefficient is in ${s.unit}; FEED reads W/m2/K or kW/m2/K`);
    // unitTo is optional in the contract: absent, FEED converts from the known source unit to the unit its case uses; present, it must name that unit
    if (spec.unitTo !== undefined && spec.unitTo !== "W/m2/K") return refuse("E_UNITS", "/recipe/source/additional/0/unitTo", "FEED sets the coefficient in W/m2/K; unitTo is " + String(spec.unitTo));
    h = s.value * f;
    if (!finite(h) || !(h > 0)) return refuse("E_OUT_OF_RANGE", "/source/additional/0/selected/value", `the heat transfer coefficient is ${s.value} ${s.unit}; it must be positive`);
    samples.push(s);
  }

  // the target case: a valid case
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
  const baseCheck = validateCase(base);
  if (!baseCheck.ok) return { ok: false, errors: baseCheck.errors.slice(0, 20).map((e) => ({ code: e.code, field: "/target/content" + e.field, message: "the target case is not valid: " + e.message })) };
  if (base.provenance !== undefined && (!isObj(base.provenance) || (base.provenance.transfers !== undefined && !Array.isArray(base.provenance.transfers)))) {
    return refuse("E_SCHEMA_INVALID", "/target/content/provenance", "the target case's provenance (and its transfers list) must be an object (and a list) to append this transfer to");
  }

  // A FEED case is one axial slice. SEED cannot know which slice that is; FEED can, when a heating transfer was already recorded in the case.
  const earlier = ((base.provenance?.transfers as unknown[]) ?? []).filter((t): t is Record<string, any> => isObj(t) && t.kind === "heating" && isObj(t.z) && finite(t.z.min) && finite(t.z.max));
  for (const t of earlier) {
    const tol = REL_Z * (t.z.max - t.z.min);
    if (regionZ.min > t.z.min + tol || regionZ.max < t.z.max - tol) {
      return refuse("E_COVERAGE_INCOMPLETE", "/recipe/mapping/spatial/region", `region ${region.id} (z ${regionZ.min} to ${regionZ.max} m) does not contain slice ${String(t.sliceId)} (z ${t.z.min} to ${t.z.max} m), the slice this case's heating was set for; the boundary would belong to another part of the pin`);
    }
  }

  // the new case
  const doc = structuredClone(base);
  const boundary: Record<string, unknown> = { ...(isObj(doc.boundary) ? doc.boundary : {}) };
  delete boundary.bulkTemperature;
  delete boundary.heatTransferCoefficient;
  delete boundary.surfaceTemperature;
  if (form === "bulk-plus-h") {
    boundary.bulkTemperature = { value: kelvin, unit: "K" };
    boundary.heatTransferCoefficient = { value: h, unit: "W/m2/K" };
  } else {
    boundary.surfaceTemperature = { value: kelvin, unit: "K" };
  }
  doc.boundary = boundary;
  const entry = {
    kind: "coolant-boundary",
    recipeId: recipe.recipeId,
    ...(recipeDigest ? { recipeDigest } : {}),
    boundaryForm: form,
    region: { id: region.id, z: regionZ },
    runId: rs.runId,
    resultsSha256: rs.resultsSha256,
    samples: samples.map((s) => ({ role: s.role, quantity: s.quantity, unit: s.unit, x: s.x, value: s.value, interpolated: s.interpolated, dataSha256: s.dataSha256 })),
    uncertainty: "none supplied by the source series; none carried",
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
      boundaryForm: form,
      boundary: structuredClone(boundary),
      samples: samples.map((s) => ({ role: s.role, quantity: s.quantity, x: s.x, value: s.value, unit: s.unit, interpolated: s.interpolated })),
      region: { id: region.id, z: regionZ },
      heatedSlices: earlier.map((t) => ({ id: t.sliceId, z: t.z })),
      regionCheck: earlier.length > 0 ? "the region contains every slice this case's heating was set for" : "no heating transfer is recorded in the case, so the region could not be compared with a slice",
      uncertainty: "the source series carries none; none is carried into the case",
      warnings: after.warnings.map((w) => ({ code: w.code, field: w.field, message: w.message })),
    },
  };
}
