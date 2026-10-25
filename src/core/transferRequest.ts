// FEED's side of the SEED transfer contract (docs/decisions/0003-provisional-transfer-shapes.md, superseded for heating).
//
// SEED sends one `seed.transfer-request/0.2` on stdin of `headless transfer`; FEED answers with the complete new case text or a
// list of typed refusals. SEED has already checked, before calling: the approval and its digest, units against the quantity's
// dimension, a declared normalization, that the source and target revisions are current, that the source run completed, and
// that `describe.transfers` accepts the source. FEED owns the physics: coverage (never extrapolated), conservation within the
// recipe's tolerance, overlap and slice rules, uncertainty, and the target case itself. Refusal-first: nothing is defaulted.
//
// Pure functions, no I/O. `mapping.spatial` is FEED's vocabulary (documented in docs/transfer-heating.md).

import { Failed, TransferIssue, firstOverlap } from "./transfer";
import { BOUNDARY_DESCRIPTION, BOUNDARY_FIELD, BoundaryReply as BoundaryReplyType, transferBoundary } from "./transferBoundary";
import { BURNUP_DESCRIPTION, BURNUP_FIELD, BurnupReply, transferBurnup } from "./transferBurnup";
import { validateCase } from "./validate";

export const REQUEST_SCHEMA = "seed.transfer-request/0.2";
export const RECIPE_SCHEMA = "seed.transfer-recipe/0.2";
/** The transfers FEED accepts; `describe` reports these to SEED. */
export const TRANSFER_FIELDS = ["heating-to-pin", BOUNDARY_FIELD, BURNUP_FIELD] as const;

export const DESCRIBE_TRANSFERS = [
  {
    field: "heating-to-pin",
    accepts: [
      { dimension: "energy", normalization: "per-source-particle" },
      { dimension: "power", normalization: "none" },
      { dimension: "power-per-length", normalization: "none" },
      { dimension: "power-per-volume", normalization: "none" },
    ],
    parameters: {
      spatial: "pin, frame, slices [{id, z {min, max}}], applyTo (a slice id), pinBinCount (total-power only), columns? {pin, zMin, zMax, volume, value}",
      table: "one row per axial bin: a pin label, z_min and z_max (length), a volume (power-per-volume only), the value and its std column; meta.frame names the coordinate frame",
      produces: "power.linearHeatRate of the slice named by applyTo, in W/m; units.to is W (the unit the bins are converted to)",
      time: "steady only",
    },
  },
  BOUNDARY_DESCRIPTION,
  BURNUP_DESCRIPTION,
];

const REL_Z = 1e-9;
/** Root of the sum of squares, scaled by the largest term so tiny or huge values neither underflow nor overflow. */
function rss(xs: number[]): number {
  let m = 0;
  for (const x of xs) if (Math.abs(x) > m) m = Math.abs(x);
  if (m === 0 || !Number.isFinite(m)) return m;
  let s = 0;
  for (const x of xs) s += (x / m) ** 2;
  return m * Math.sqrt(s);
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
const refuse = (code: string, field: string, message: string): Failed => ({ ok: false, errors: [{ code, field, message }] });

// ---- units: the same grammar as SEED's (tokens with SI prefixes, `*`, `/`, `^n` or digits), reduced to what a heating table needs ----

type Vec = { kg: number; m: number; s: number };
const TOKENS: Record<string, { f: number; v: Vec; prefix: boolean }> = {
  m: { f: 1, v: { kg: 0, m: 1, s: 0 }, prefix: true },
  s: { f: 1, v: { kg: 0, m: 0, s: 1 }, prefix: true },
  W: { f: 1, v: { kg: 1, m: 2, s: -3 }, prefix: true },
  J: { f: 1, v: { kg: 1, m: 2, s: -2 }, prefix: true },
  eV: { f: 1.602176634e-19, v: { kg: 1, m: 2, s: -2 }, prefix: true },
  "1": { f: 1, v: { kg: 0, m: 0, s: 0 }, prefix: false },
};
const PREFIX: Record<string, number> = { k: 1e3, M: 1e6, G: 1e9, m: 1e-3, u: 1e-6, c: 1e-2 };

function parseUnit(unit: unknown): { factor: number; vec: Vec } | undefined {
  if (typeof unit !== "string" || unit.length === 0 || unit.length > 40) return undefined;
  const vec: Vec = { kg: 0, m: 0, s: 0 };
  let factor = 1;
  const parts = unit.split("/");
  for (const [k, part] of parts.entries()) {
    const sign = k === 0 ? 1 : -1;
    for (const term of part.split("*")) {
      const m = /^([A-Za-z]+|1)(?:\^?(-?[1-9][0-9]?))?$/.exec(term);
      if (!m) return undefined;
      const name = m[1]!;
      let tok = TOKENS[name];
      let f = tok?.f;
      if (!tok) {
        const p = PREFIX[name[0] ?? ""];
        const base = TOKENS[name.slice(1)];
        if (p === undefined || !base || !base.prefix) return undefined;
        tok = base;
        f = p * base.f;
      }
      const n = m[2] === undefined ? 1 : Number(m[2]);
      factor *= Math.pow(f!, sign * n);
      vec.kg += sign * n * tok.v.kg;
      vec.m += sign * n * tok.v.m;
      vec.s += sign * n * tok.v.s;
    }
  }
  return Number.isFinite(factor) ? { factor, vec } : undefined;
}

const DIM: Record<string, Vec> = {
  energy: { kg: 1, m: 2, s: -2 },
  power: { kg: 1, m: 2, s: -3 },
  "power-per-length": { kg: 1, m: 1, s: -3 },
  "power-per-volume": { kg: 1, m: -1, s: -3 },
  length: { kg: 0, m: 1, s: 0 },
  volume: { kg: 0, m: 3, s: 0 },
  rate: { kg: 0, m: 0, s: -1 },
};
/** Factor to the SI unit of the dimension, or undefined when the unit is unreadable or belongs to another dimension. */
function factorFor(unit: unknown, dim: keyof typeof DIM): number | undefined {
  const p = parseUnit(unit);
  const want = DIM[dim]!;
  return p && p.vec.kg === want.kg && p.vec.m === want.m && p.vec.s === want.s ? p.factor : undefined;
}

// ---- the request ----

export interface TransferOk {
  ok: true;
  output: { content: string };
  checks: Record<string, unknown>;
}
export type TransferReply = TransferOk | Failed;

const SPATIAL_KEYS = new Set(["pin", "frame", "slices", "applyTo", "pinBinCount", "columns"]);
const COLUMN_KEYS = new Set(["pin", "zMin", "zMax", "volume", "value"]);

/** Map a heating table onto the axial slices of one pin and set the chosen slice's linear heat rate in the target case. */
export function transferHeating(requestIn: unknown): TransferReply {
  if (!isObj(requestIn) || requestIn.schema !== REQUEST_SCHEMA) return refuse("E_SCHEMA_INVALID", "/schema", `not a ${REQUEST_SCHEMA} request`);
  const recipe = requestIn.recipe;
  if (!isObj(recipe) || recipe.schema !== RECIPE_SCHEMA || !nonEmpty(recipe.recipeId)) return refuse("E_RECIPE_INVALID", "/recipe", `not a ${RECIPE_SCHEMA} recipe with a recipe id`);
  const recipeDigest = typeof requestIn.recipeDigest === "string" ? requestIn.recipeDigest : undefined;
  const target = recipe.target;
  if (!isObj(target) || target.app !== "feed") return refuse("E_RECIPE_INVALID", "/recipe/target/app", "the recipe's target is not FEED");
  if (target.field !== "heating-to-pin") return refuse("E_UNSUPPORTED", "/recipe/target/field", `FEED accepts ${TRANSFER_FIELDS.join(", ")}; ${String(target.field)} is not one of them`);

  // recipe parts FEED reads
  const rs = recipe.source;
  const norm = recipe.normalization;
  const mapping = recipe.mapping;
  const tol = recipe.tolerance;
  if (!isObj(rs) || !isObj(norm) || !isObj(mapping) || !isObj(tol) || !isObj(recipe.units)) return refuse("E_RECIPE_INVALID", "/recipe", "the recipe lacks source, units, normalization, mapping or tolerance");
  if (!isObj(mapping.time) || mapping.time.kind !== "steady") return refuse("E_UNSUPPORTED", "/recipe/mapping/time/kind", "only a steady transfer is accepted in this release");
  if (mapping.extrapolation !== "refused") return refuse("E_RECIPE_INVALID", "/recipe/mapping/extrapolation", "extrapolation must be refused; FEED never extrapolates");
  if (!finite(tol.conservation) || !(tol.conservation > 0) || tol.conservation > 1) return refuse("E_RECIPE_INVALID", "/recipe/tolerance/conservation", "the conservation tolerance must be above 0 and at most 1");
  if (recipe.units.to !== "W") return refuse("E_UNITS", "/recipe/units/to", "FEED converts the bins to watts (units.to is W) and slices them itself; the linear heat rate it sets is in W/m");

  // spatial vocabulary: strict, so a mistyped key is a refusal and not a silent default
  const sp = mapping.spatial;
  if (!isObj(sp)) return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial", "mapping.spatial is missing");
  for (const k of Object.keys(sp)) if (!SPATIAL_KEYS.has(k)) return refuse("E_RECIPE_INVALID", `/recipe/mapping/spatial/${k}`, `unknown key ${k}; FEED reads pin, frame, slices, applyTo, pinBinCount, columns`);
  if (!nonEmpty(sp.pin) || !nonEmpty(sp.frame) || !nonEmpty(sp.applyTo)) return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial", "spatial needs a pin, a coordinate frame and the id of the slice to apply (applyTo)");
  const cols = sp.columns === undefined ? {} : sp.columns;
  if (!isObj(cols)) return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial/columns", "columns must be an object");
  for (const [k, v] of Object.entries(cols)) if (!COLUMN_KEYS.has(k) || !nonEmpty(v)) return refuse("E_RECIPE_INVALID", `/recipe/mapping/spatial/columns/${k}`, "columns names pin, zMin, zMax, volume or value, each a column name");
  if (!Array.isArray(sp.slices) || sp.slices.length === 0) return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial/slices", "the recipe defines no axial slices");
  const slices: { id: string; z: { min: number; max: number } }[] = [];
  const ids = new Set<string>();
  for (const [i, s] of sp.slices.entries()) {
    if (!isObj(s) || !nonEmpty(s.id) || ids.has(s.id) || !isObj(s.z) || !finite(s.z.min) || !finite(s.z.max) || !(s.z.max > s.z.min)) {
      return refuse("E_RECIPE_INVALID", `/recipe/mapping/spatial/slices/${i}`, "each slice needs a unique id and a z range with max above min (metres)");
    }
    ids.add(s.id);
    slices.push({ id: s.id, z: { min: s.z.min, max: s.z.max } });
  }
  if (firstOverlap(slices.map((s) => s.z)) >= 0) return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial/slices", "slices overlap; each axial position belongs to exactly one slice");
  const chosen = slices.find((s) => s.id === sp.applyTo);
  if (!chosen) return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial/applyTo", `applyTo ${String(sp.applyTo)} is not one of the slices`);

  // the target case: a valid steady case
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
  if (isObj(base.assumptions) && base.assumptions.steadyState === false) return refuse("E_UNSUPPORTED", "/target/content", "a steady heating transfer cannot be applied to a transient case: its power is a history, not one linear heat rate");
  const baseCheck = validateCase(base);
  if (!baseCheck.ok) return { ok: false, errors: baseCheck.errors.slice(0, 20).map((e) => ({ code: e.code, field: "/target/content" + e.field, message: "the target case is not valid: " + e.message })) };

  // the source table
  const src = requestIn.source;
  const data = isObj(src) ? src.data : undefined;
  if (!isObj(data) || data.kind !== "table" || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return refuse("E_SCHEMA_INVALID", "/source/data", "the source is not a table");
  if (data.quantity !== rs.quantity) return refuse("E_RECIPE_INVALID", "/source/data/quantity", `the table is ${String(data.quantity)} but the recipe was approved for ${String(rs.quantity)}`);
  const meta = isObj(data.meta) ? data.meta : {};
  if (!nonEmpty(meta.frame) || meta.frame !== sp.frame) return refuse("E_FRAME_MISMATCH", "/source/data/meta/frame", `the table's coordinate frame ${String(meta.frame)} is not the recipe's ${sp.frame}; no transform is applied`);

  type Col = { name: string; unit: string; role: string; of?: string };
  const columns = data.columns as Col[];
  const seenNames = new Set<string>();
  for (const [i, c] of columns.entries()) {
    if (!isObj(c) || !nonEmpty(c.name) || typeof c.unit !== "string" || typeof c.role !== "string") return refuse("E_SCHEMA_INVALID", `/source/data/columns/${i}`, "each column needs a name, a unit and a role");
    // two columns of one name would let their order choose the heating value (or hide a std column)
    if (seenNames.has(c.name)) return refuse("E_SCHEMA_INVALID", `/source/data/columns/${i}/name`, `column name ${c.name} appears twice; the table must say which column is meant`);
    seenNames.add(c.name);
  }
  const find = (name: string) => columns.findIndex((c) => isObj(c) && c.name === name);
  const named = (key: string, dflt: string): number => find(String((cols as Record<string, unknown>)[key] ?? dflt));
  const iPin = named("pin", "pin");
  const iZ0 = named("zMin", "z_min");
  const iZ1 = named("zMax", "z_max");
  if (iPin < 0 || columns[iPin]!.role !== "label") return refuse("E_COVERAGE_INCOMPLETE", "/source/data/columns", "no label column names the pin (default name: pin)");
  if (iZ0 < 0 || iZ1 < 0 || columns[iZ0]!.role !== "coordinate" || columns[iZ1]!.role !== "coordinate") return refuse("E_COVERAGE_INCOMPLETE", "/source/data/columns", "the table needs coordinate columns for the bin's lower and upper z (default names: z_min, z_max)");
  const lenZ0 = factorFor(columns[iZ0]!.unit, "length");
  const lenZ1 = factorFor(columns[iZ1]!.unit, "length");
  if (lenZ0 === undefined || lenZ1 === undefined) return refuse("E_UNITS", "/source/data/columns", "the z columns must have a length unit");
  let iVal = (cols as Record<string, unknown>).value !== undefined ? find(String((cols as Record<string, unknown>).value)) : -1;
  if ((cols as Record<string, unknown>).value === undefined) {
    const values = columns.map((c, i) => (c.role === "value" ? i : -1)).filter((i) => i >= 0);
    if (values.length !== 1) return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial/columns/value", values.length === 0 ? "the table has no value column" : "the table has several value columns; name the one to map in columns.value");
    iVal = values[0]!;
  }
  if (iVal < 0 || columns[iVal]!.role !== "value") return refuse("E_RECIPE_INVALID", "/recipe/mapping/spatial/columns/value", "the named value column is not in the table");
  const valueCol = columns[iVal]!;
  if (valueCol.unit !== rs.unit) return refuse("E_UNITS", `/source/data/columns/${iVal}/unit`, `the table's value is in ${valueCol.unit} but the recipe was approved for ${String(rs.unit)}`);
  const stds = columns.map((c, i) => (c.role === "std" && c.of === valueCol.name ? i : -1)).filter((i) => i >= 0);
  if (stds.length > 1) return refuse("E_SCHEMA_INVALID", "/source/data/columns", `${stds.length} std columns name ${valueCol.name}; exactly one uncertainty per value`);
  const iStd = stds.length === 1 ? stds[0]! : -1;
  if (iStd < 0) return refuse("E_UNCERTAINTY_MISSING", "/source/data/columns", "the Monte Carlo uncertainty (a std column of the value) is carried through the mapping and cannot be dropped");
  if (columns[iStd]!.unit !== valueCol.unit) return refuse("E_UNITS", `/source/data/columns/${iStd}/unit`, "the std column has a different unit from its value");

  // normalization to watts per bin
  const dim = String(rs.dimension);
  const nk = norm.kind;
  let toW: number; // watts per unit of the value column (the shared factor for a total-power scale is applied later)
  let totalPowerW: number | undefined;
  let iVol = -1;
  let volF = 1;
  if (dim === "energy") {
    const eF = factorFor(valueCol.unit, "energy");
    if (eF === undefined) return refuse("E_UNITS", `/source/data/columns/${iVal}/unit`, "the value is not an energy");
    if (nk === "source-rate") {
      const v = norm.value;
      const rF = isObj(v) ? factorFor(v.unit, "rate") : undefined;
      if (!isObj(v) || rF === undefined || !finite(v.value) || !(v.value > 0)) return refuse("E_UNITS", "/recipe/normalization/value", "a source rate is a positive number per second (1/s)");
      toW = eF * v.value * rF;
    } else if (nk === "total-power") {
      const v = norm.value;
      const pF = isObj(v) ? factorFor(v.unit, "power") : undefined;
      if (!isObj(v) || pF === undefined || !finite(v.value) || !(v.value > 0)) return refuse("E_UNITS", "/recipe/normalization/value", "a total power is a positive number in W, kW or MW");
      totalPowerW = v.value * pF;
      toW = 1;
    } else return refuse("E_NORMALIZATION_MISSING", "/recipe/normalization/kind", "an energy per source particle has no watts without a source rate or a total power");
  } else if (dim === "power" || dim === "power-per-length" || dim === "power-per-volume") {
    if (nk !== "none") return refuse("E_UNITS", "/recipe/normalization/kind", `the value is already a ${dim}; a normalization would be applied twice`);
    const f = factorFor(valueCol.unit, dim);
    if (f === undefined) return refuse("E_UNITS", `/source/data/columns/${iVal}/unit`, `the value's unit is not a ${dim} unit`);
    toW = f;
    if (dim === "power-per-volume") {
      iVol = named("volume", "volume");
      const vf = iVol >= 0 && columns[iVol]!.role === "coordinate" ? factorFor(columns[iVol]!.unit, "volume") : undefined;
      if (vf === undefined) return refuse("E_NORMALIZATION_MISSING", "/source/data/columns", "a power per volume needs the bin volume (a coordinate column with a volume unit; default name: volume) to become watts");
      volF = vf;
    }
  } else return refuse("E_UNITS", "/recipe/source/dimension", `FEED maps energy, power, power-per-length or power-per-volume; ${dim} is not one of them`);

  // rows of the target pin
  const pinBins: { z: { min: number; max: number }; watts: number; std: number; score: number; scoreStd: number }[] = [];
  let score = 0;
  for (const [i, row] of (data.rows as unknown[]).entries()) {
    if (!Array.isArray(row) || row.length !== columns.length) return refuse("E_SCHEMA_INVALID", `/source/data/rows/${i}`, "a row must have one cell per column");
    const label = row[iPin];
    const labelText = Array.isArray(label) ? label.join(",") : label;
    if (typeof labelText !== "string") return refuse("E_SCHEMA_INVALID", `/source/data/rows/${i}`, "the pin cell must be a string or a list of strings");
    if (labelText !== sp.pin) continue;
    const z0 = row[iZ0];
    const z1 = row[iZ1];
    const v = row[iVal];
    const sd = row[iStd];
    if (!finite(z0) || !finite(z1) || !(z1 * lenZ1 > z0 * lenZ0) || !finite(v) || v < 0) return refuse("E_SCHEMA_INVALID", `/source/data/rows/${i}`, "a bin needs finite z limits with max above min and a non-negative finite value");
    if (!finite(sd) || sd < 0) return refuse("E_UNCERTAINTY_MISSING", `/source/data/rows/${i}`, "the bin has no finite non-negative std; the Monte Carlo error cannot be dropped");
    const zMin = z0 * lenZ0;
    const zMax = z1 * lenZ1;
    let basis = 1; // per-length and per-volume values need the bin's length or volume
    if (dim === "power-per-length") basis = zMax - zMin;
    if (dim === "power-per-volume") {
      const vol = row[iVol];
      if (!finite(vol) || !(vol > 0)) return refuse("E_NORMALIZATION_MISSING", `/source/data/rows/${i}`, "a power per volume needs a positive bin volume");
      basis = vol * volF;
    }
    pinBins.push({ z: { min: zMin, max: zMax }, watts: v * toW * basis, std: sd * toW * basis, score: v, scoreStd: sd });
    score += v;
  }
  if (pinBins.length === 0) return refuse("E_COVERAGE_INCOMPLETE", "/source/data/rows", `no bins belong to pin ${sp.pin}`);
  if (totalPowerW !== undefined) {
    // a total power over a partial export would hand the power of the missing bins to the rest: the recipe states the bin count
    if (!Number.isInteger(sp.pinBinCount) || (sp.pinBinCount as number) < 1) return refuse("E_NORMALIZATION_MISSING", "/recipe/mapping/spatial/pinBinCount", "a total power needs pinBinCount, the number of bins it was defined over");
    if (pinBins.length !== sp.pinBinCount) return refuse("E_NORMALIZATION_DOMAIN", "/recipe/mapping/spatial/pinBinCount", `the total power was defined over ${String(sp.pinBinCount)} bins of pin ${sp.pin} but ${pinBins.length} were supplied; a partial export would hand power of the missing bins to the rest`);
    if (!(score > 0)) return refuse("E_COVERAGE_INCOMPLETE", "/source/data/rows", "the pin's bins carry no score to scale a total power by");
    for (const b of pinBins) {
      b.watts = (b.watts / score) * totalPowerW;
      b.std = (b.std / score) * totalPowerW;
    }
  }
  if (pinBins.some((b) => !finite(b.watts) || !finite(b.std))) return refuse("E_NUMERIC", "/source/data/rows", "a converted bin power or std is not a finite number");
  if (firstOverlap(pinBins.map((b) => b.z)) >= 0) return refuse("E_SCHEMA_INVALID", "/source/data/rows", `bins of pin ${sp.pin} overlap in z; their contributions would be double counted`);
  const sourceW = pinBins.reduce((s, b) => s + b.watts, 0);
  if (!finite(sourceW)) return refuse("E_NUMERIC", "/source/data/rows", "the source total is not a finite number");
  if (!(sourceW > 0)) return refuse("E_COVERAGE_INCOMPLETE", "/source/data/rows", "the source has no power in the target pin");

  // coverage: every slice must be covered by the pin's bins (no gaps, no extrapolation)
  const sorted = [...pinBins].sort((a, b) => a.z.min - b.z.min);
  for (const s of slices) {
    const eps = REL_Z * (s.z.max - s.z.min);
    let at = s.z.min;
    for (const b of sorted) {
      if (b.z.max <= at + eps) continue;
      if (b.z.min > at + eps) break;
      at = Math.max(at, b.z.max);
      if (at >= s.z.max - eps) break;
    }
    if (at < s.z.max - eps) return refuse("E_COVERAGE", `/recipe/mapping/spatial/slices/${s.id}`, `slice ${s.id} is not fully covered by bins of pin ${sp.pin} (covered to z = ${at} of ${s.z.max}); no extrapolation is done`);
  }

  // map: uniform density inside a bin, split by overlap length
  const mappedSlices = slices.map((s) => {
    let power = 0;
    const shares: number[] = []; // per bin, in pinBins order: the fraction of the bin inside this slice
    for (const b of pinBins) {
      const overlap = Math.min(b.z.max, s.z.max) - Math.max(b.z.min, s.z.min);
      const share = overlap > 0 ? overlap / (b.z.max - b.z.min) : 0;
      shares.push(share);
      power += b.watts * share;
    }
    const length = s.z.max - s.z.min;
    // Independent bins (the table gives marginal std only; see docs/transfer-heating.md). For a total power the slice is
    // P * (sum_b share_b v_b) / S with S = sum of ALL the pin's bins, so each bin also enters through S:
    // d/dv_b = P (share_b S - A) / S^2 with A = sum share v. Squares are accumulated scaled by the largest term (no underflow).
    const grads: number[] = [];
    if (totalPowerW !== undefined) {
      let A = 0;
      pinBins.forEach((b, i) => (A += shares[i]! * b.score));
      pinBins.forEach((b, i) => grads.push(((totalPowerW * (shares[i]! * score - A)) / (score * score)) * b.scoreStd));
    } else {
      pinBins.forEach((b, i) => grads.push(b.std * shares[i]!));
    }
    return { id: s.id, z: s.z, length, power, q: power / length, std: rss(grads) };
  });
  if (mappedSlices.some((s) => !finite(s.power) || !finite(s.q) || !finite(s.std))) return refuse("E_NUMERIC", "/recipe/mapping/spatial/slices", "a slice gave a non-finite power, heat rate or uncertainty");
  const mapped = mappedSlices.reduce((s, x) => s + x.power, 0);
  const rel = (mapped - sourceW) / sourceW;
  if (!finite(mapped) || !finite(rel)) return refuse("E_NUMERIC", "/recipe/mapping/spatial/slices", "the mapped total or its difference from the source total is not a finite number");
  if (Math.abs(rel) > tol.conservation) {
    return refuse("E_CONSERVATION", "/recipe/tolerance/conservation", `mapped power ${mapped.toFixed(6)} W differs from the source total ${sourceW.toFixed(6)} W by ${(rel * 100).toFixed(4)}% (tolerance ${(tol.conservation * 100).toFixed(4)}%)`);
  }
  if (mappedSlices.some((s) => !(s.q > 0))) return refuse("E_COVERAGE_INCOMPLETE", "/recipe/mapping/spatial/slices", "a slice received no power; a case needs a positive linear heat rate");
  const slice = mappedSlices.find((s) => s.id === chosen.id)!;
  const relError = slice.std / slice.power;
  if (!finite(relError)) return refuse("E_NUMERIC", "/source/data/rows", "the slice's relative uncertainty is not a finite number");

  // the new case
  if (base.provenance !== undefined && (!isObj(base.provenance) || (base.provenance.transfers !== undefined && !Array.isArray(base.provenance.transfers)))) {
    return refuse("E_SCHEMA_INVALID", "/target/content/provenance", "the target case's provenance (and its transfers list) must be an object (and a list) to append this transfer to");
  }
  const doc = structuredClone(base);
  doc.power = { ...(doc.power ?? {}), linearHeatRate: { value: slice.q, unit: "W/m" } };
  const entry = {
    kind: "heating",
    recipeId: recipe.recipeId,
    ...(recipeDigest ? { recipeDigest } : {}),
    pin: sp.pin,
    sliceId: slice.id,
    z: slice.z,
    relError,
    runId: rs.runId,
    quantity: rs.quantity,
    resultsSha256: rs.resultsSha256,
    dataSha256: rs.dataSha256,
    frame: sp.frame,
    normalization: { kind: nk, origin: norm.origin },
    totals: { mappedW: mapped, sourceW, relativeDifference: rel },
    uncertaintyModel: "independent-bins",
  };
  // Applying heating again REPLACES the earlier heating: the case has one heat rate (set above), so an earlier heating entry no longer describes it and is dropped, never kept beside the new one
  // (a loop applies it up to 25 times in a row; the other transfers' entries, boundary and burnup, are kept as they are).
  const kept = ((doc.provenance?.transfers as unknown[]) ?? []).filter((e) => !(isObj(e) && e.kind === "heating"));
  doc.provenance = { ...(doc.provenance ?? {}), transfers: [...kept, structuredClone(entry)] };
  const after = validateCase(doc);
  if (!after.ok) {
    return { ok: false, errors: after.errors.slice(0, 20).map((e): TransferIssue => ({ code: e.code, field: "/target/content" + e.field, message: "the mapped case is not valid: " + e.message })) };
  }
  const content = JSON.stringify(doc, null, 2) + "\n";
  if (content === target0.content) return refuse("E_NO_CHANGE", "/target/content", "the mapping would not change the target case");
  return {
    ok: true,
    output: { content },
    checks: {
      conservation: { mappedW: mapped, sourceW, relativeDifference: rel, tolerance: tol.conservation },
      slice: { id: slice.id, z: slice.z, linearHeatRate: { value: slice.q, unit: "W/m" }, relError },
      slices: mappedSlices.map((s) => ({ id: s.id, powerW: s.power })),
      bins: pinBins.length,
      uncertaintyModel: "independent-bins (marginal std only; bin-to-bin correlation is not available and not assumed)",
      // what FEED's validator says about the new case (for example a linear heat rate above its sanity range); recorded, not hidden
      warnings: after.warnings.map((w) => ({ code: w.code, field: w.field, message: w.message })),
    },
  };
}

/** The `transfer` command: route SEED's request to the transfer its recipe names. */
export function transfer(requestIn: unknown): TransferReply | BoundaryReplyType | BurnupReply {
  const field = isObj(requestIn) && isObj(requestIn.recipe) && isObj(requestIn.recipe.target) ? requestIn.recipe.target.field : undefined;
  if (field === BURNUP_FIELD) return transferBurnup(requestIn);
  return field === BOUNDARY_FIELD ? transferBoundary(requestIn) : transferHeating(requestIn);
}
