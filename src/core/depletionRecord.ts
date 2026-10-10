// Depletion record reader: parse, validate, interpolate, and convert the depletion hand-off record (docs/ARCHITECTURE.md).
// FEED only reads this hand-off record from an upstream depletion calculation to obtain burnup per region over time.

import { createHash } from "node:crypto";

export class DepletionRecordError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    const fullMessage = message.startsWith(`${path}: `) ? message : `${path}: ${message}`;
    super(fullMessage);
    this.name = "DepletionRecordError";
    this.path = path;
    Object.setPrototypeOf(this, DepletionRecordError.prototype);
  }
}

export interface DepletionRegion {
  name: string;
  cell_ids: number[];
  heavy_metal_mass_kg: number;
  power_w: number[];
  burnup_mwd_per_tu: number[];
}

export interface DepletionRecord {
  schema: "studio.depletion/0.1";
  /** SHA-256 of the canonical JSON without this key (Studio's `record_id`); checked when present. Records from older writers have none. */
  id?: string;
  time_steps_days: number[];
  regions: DepletionRegion[];
  k?: [number, number][];
  isotopics?: Record<string, Record<string, number[]>>;
  provenance: Record<string, unknown>;
}

const TOP_LEVEL_KEYS = new Set(["schema", "id", "time_steps_days", "regions", "k", "isotopics", "provenance"]);
const REGION_KEYS = new Set(["name", "cell_ids", "heavy_metal_mass_kg", "power_w", "burnup_mwd_per_tu"]);

/**
 * Studio's canonical form: sorted keys, no spaces, the top-level `id` left out, number and string tokens exactly as the writer printed them
 * (Python's repr of a float, ASCII escapes). Working on the tokens of the text, not on parsed values, keeps `190.0` and `1e-05` as written.
 */
export function canonicalRecordText(text: string): string {
  let i = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const str = (): string => {
    const start = i;
    i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return text.slice(start, i);
  };
  const value = (top: boolean): string => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const members: [string, string][] = [];
      ws();
      if (text[i] === "}") { i++; return "{}"; }
      for (;;) {
        ws();
        const k = str();
        ws();
        i++; // the colon
        const v = value(false);
        if (!(top && JSON.parse(k) === "id")) members.push([k, v]);
        ws();
        if (text[i++] === "}") break;
      }
      members.sort((a, b) => { const x = JSON.parse(a[0]) as string, y = JSON.parse(b[0]) as string; return x < y ? -1 : x > y ? 1 : 0; });
      return "{" + members.map(([k, v]) => k + ":" + v).join(",") + "}";
    }
    if (c === "[") {
      i++;
      const items: string[] = [];
      ws();
      if (text[i] === "]") { i++; return "[]"; }
      for (;;) {
        items.push(value(false));
        ws();
        if (text[i++] === "]") break;
      }
      return "[" + items.join(",") + "]";
    }
    if (c === '"') return str();
    const start = i;
    while (i < text.length && !",]} \t\n\r".includes(text[i]!)) i++;
    return text.slice(start, i);
  };
  return value(true);
}

export function parseDepletionRecord(text: string): DepletionRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new DepletionRecordError("depletion.json", "not valid JSON");
    }
    throw e;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DepletionRecordError("depletion.json", "expected a JSON object");
  }

  const doc = raw as Record<string, unknown>;

  // Check for unknown top-level keys
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new DepletionRecordError(key, `unknown top-level key '${key}'`);
    }
  }

  // id: the SHA-256 of the canonical text; a record that was edited after it was written no longer matches
  if ("id" in doc) {
    if (typeof doc.id !== "string" || !/^[0-9a-f]{64}$/.test(doc.id)) {
      throw new DepletionRecordError("id", "expected 64 lowercase hex digits");
    }
    const actual = createHash("sha256").update(canonicalRecordText(text), "utf8").digest("hex");
    if (actual !== doc.id) {
      throw new DepletionRecordError("id", "does not match the record's content (it was changed after it was written)");
    }
  }

  // schema
  if (!("schema" in doc)) {
    throw new DepletionRecordError("schema", "schema is required");
  }
  if (doc.schema !== "studio.depletion/0.1") {
    throw new DepletionRecordError("schema", `expected schema 'studio.depletion/0.1', got ${JSON.stringify(doc.schema)}`);
  }

  // time_steps_days
  if (!("time_steps_days" in doc)) {
    throw new DepletionRecordError("time_steps_days", "time_steps_days is required");
  }
  if (!Array.isArray(doc.time_steps_days)) {
    throw new DepletionRecordError("time_steps_days", "time_steps_days must be an array");
  }
  if (doc.time_steps_days.length === 0) {
    throw new DepletionRecordError("time_steps_days", "time_steps_days must be non-empty");
  }
  for (const dt of doc.time_steps_days) {
    if (typeof dt !== "number" || !Number.isFinite(dt) || dt <= 0) {
      throw new DepletionRecordError("time_steps_days", "each time_steps_days entry must be a finite number greater than 0");
    }
  }
  const timeStepsDays = doc.time_steps_days as number[];
  const n = timeStepsDays.length;

  // regions
  if (!("regions" in doc)) {
    throw new DepletionRecordError("regions", "regions is required");
  }
  if (!Array.isArray(doc.regions)) {
    throw new DepletionRecordError("regions", "regions must be an array");
  }
  if (doc.regions.length === 0) {
    throw new DepletionRecordError("regions", "regions must be non-empty");
  }

  const seenRegionNames = new Set<string>();
  const regions: DepletionRegion[] = [];

  for (let i = 0; i < doc.regions.length; i++) {
    const r = doc.regions[i];
    const rPath = `regions[${i}]`;
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      throw new DepletionRecordError(rPath, "region must be an object");
    }
    const reg = r as Record<string, unknown>;

    // Unknown keys inside region
    for (const key of Object.keys(reg)) {
      if (!REGION_KEYS.has(key)) {
        throw new DepletionRecordError(`${rPath}.${key}`, `unknown key '${key}' in region`);
      }
    }

    // name
    if (!("name" in reg)) {
      throw new DepletionRecordError(`${rPath}.name`, "name is required");
    }
    if (typeof reg.name !== "string" || reg.name.length === 0) {
      throw new DepletionRecordError(`${rPath}.name`, "name must be a non-empty string");
    }
    if (seenRegionNames.has(reg.name)) {
      throw new DepletionRecordError(`${rPath}.name`, `duplicate region name '${reg.name}'`);
    }
    seenRegionNames.add(reg.name);

    // cell_ids
    if (!("cell_ids" in reg)) {
      throw new DepletionRecordError(`${rPath}.cell_ids`, "cell_ids is required");
    }
    if (!Array.isArray(reg.cell_ids)) {
      throw new DepletionRecordError(`${rPath}.cell_ids`, "cell_ids must be an array");
    }
    if (reg.cell_ids.length === 0) {
      throw new DepletionRecordError(`${rPath}.cell_ids`, "cell_ids must be non-empty");
    }
    const seenCellIds = new Set<number>();
    for (const cid of reg.cell_ids) {
      if (typeof cid !== "number" || !Number.isInteger(cid) || cid < 1) {
        throw new DepletionRecordError(`${rPath}.cell_ids`, "each cell_id must be an integer at least 1");
      }
      if (seenCellIds.has(cid)) {
        throw new DepletionRecordError(`${rPath}.cell_ids`, `duplicate cell_id ${cid}`);
      }
      seenCellIds.add(cid);
    }

    // heavy_metal_mass_kg
    if (!("heavy_metal_mass_kg" in reg)) {
      throw new DepletionRecordError(`${rPath}.heavy_metal_mass_kg`, "heavy_metal_mass_kg is required");
    }
    if (typeof reg.heavy_metal_mass_kg !== "number" || !Number.isFinite(reg.heavy_metal_mass_kg) || reg.heavy_metal_mass_kg <= 0) {
      throw new DepletionRecordError(`${rPath}.heavy_metal_mass_kg`, "heavy_metal_mass_kg must be a finite number greater than 0");
    }
    const massKg = reg.heavy_metal_mass_kg;

    // power_w
    if (!("power_w" in reg)) {
      throw new DepletionRecordError(`${rPath}.power_w`, "power_w is required");
    }
    if (!Array.isArray(reg.power_w)) {
      throw new DepletionRecordError(`${rPath}.power_w`, "power_w must be an array");
    }
    if (reg.power_w.length !== n) {
      throw new DepletionRecordError(`${rPath}.power_w`, `power_w must have length ${n}, got ${reg.power_w.length}`);
    }
    for (const p of reg.power_w) {
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0) {
        throw new DepletionRecordError(`${rPath}.power_w`, "each power_w entry must be a finite number at least 0");
      }
    }
    const powerW = reg.power_w as number[];

    // burnup_mwd_per_tu
    if (!("burnup_mwd_per_tu" in reg)) {
      throw new DepletionRecordError(`${rPath}.burnup_mwd_per_tu`, "burnup_mwd_per_tu is required");
    }
    if (!Array.isArray(reg.burnup_mwd_per_tu)) {
      throw new DepletionRecordError(`${rPath}.burnup_mwd_per_tu`, "burnup_mwd_per_tu must be an array");
    }
    if (reg.burnup_mwd_per_tu.length !== n) {
      throw new DepletionRecordError(`${rPath}.burnup_mwd_per_tu`, `burnup_mwd_per_tu must have length ${n}, got ${reg.burnup_mwd_per_tu.length}`);
    }
    const burnupMwdPerTu = reg.burnup_mwd_per_tu as number[];
    for (let j = 0; j < n; j++) {
      const b = burnupMwdPerTu[j]!;
      if (typeof b !== "number" || !Number.isFinite(b) || b < 0) {
        throw new DepletionRecordError(`${rPath}.burnup_mwd_per_tu`, "each burnup_mwd_per_tu entry must be a finite number at least 0");
      }
      if (j > 0 && b < burnupMwdPerTu[j - 1]!) {
        throw new DepletionRecordError(`${rPath}.burnup_mwd_per_tu`, "burnup_mwd_per_tu must be non-decreasing");
      }
    }

    // Consistency rule
    const tU = massKg / 1000;
    let cumMwd = 0;
    for (let j = 0; j < n; j++) {
      cumMwd += (powerW[j]! / 1e6) * timeStepsDays[j]!;
      const expectedBurnup = cumMwd / tU;
      const actualBurnup = burnupMwdPerTu[j]!;
      const diff = Math.abs(actualBurnup - expectedBurnup);
      if (!Number.isFinite(cumMwd) || !Number.isFinite(expectedBurnup) || !Number.isFinite(diff)) {
        throw new DepletionRecordError(`${rPath}.burnup_mwd_per_tu`, `the burnup computed at step ${j} is not a finite number (the power, durations or mass overflow)`);
      }
      const tol = expectedBurnup === 0 ? 1e-12 : Math.abs(expectedBurnup) * 1e-9;
      if (diff > tol) {
        throw new DepletionRecordError(
          `${rPath}.burnup_mwd_per_tu`,
          `burnup at step ${j} (${actualBurnup}) does not match computed value (${expectedBurnup}) within tolerance`,
        );
      }
    }

    regions.push({
      name: reg.name,
      cell_ids: (reg.cell_ids as number[]).slice(),
      heavy_metal_mass_kg: massKg,
      power_w: powerW.slice(),
      burnup_mwd_per_tu: burnupMwdPerTu.slice(),
    });
  }

  // k (optional)
  let kResult: [number, number][] | undefined = undefined;
  if ("k" in doc && doc.k !== undefined) {
    if (!Array.isArray(doc.k)) {
      throw new DepletionRecordError("k", "k must be an array");
    }
    if (doc.k.length !== n + 1) {
      throw new DepletionRecordError("k", `k must have length ${n + 1}, got ${doc.k.length}`);
    }
    kResult = [];
    for (const pair of doc.k) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new DepletionRecordError("k", "each k entry must be a [value, sigma] pair of size 2");
      }
      const [val, sigma] = pair as [unknown, unknown];
      if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
        throw new DepletionRecordError("k", "k value must be a finite number greater than 0");
      }
      if (typeof sigma !== "number" || !Number.isFinite(sigma) || sigma < 0) {
        throw new DepletionRecordError("k", "k sigma must be a finite number at least 0");
      }
      kResult.push([val, sigma]);
    }
  }

  // isotopics (optional)
  let isotopicsResult: Record<string, Record<string, number[]>> | undefined = undefined;
  if ("isotopics" in doc && doc.isotopics !== undefined) {
    if (typeof doc.isotopics !== "object" || doc.isotopics === null || Array.isArray(doc.isotopics)) {
      throw new DepletionRecordError("isotopics", "isotopics must be an object");
    }
    isotopicsResult = {};
    for (const [rName, nuclides] of Object.entries(doc.isotopics)) {
      if (!seenRegionNames.has(rName)) {
        throw new DepletionRecordError("isotopics", `isotopics references unknown region '${rName}'`);
      }
      if (typeof nuclides !== "object" || nuclides === null || Array.isArray(nuclides)) {
        throw new DepletionRecordError("isotopics", `isotopics for region '${rName}' must be an object`);
      }
      isotopicsResult[rName] = {};
      for (const [nucName, amounts] of Object.entries(nuclides as Record<string, unknown>)) {
        if (typeof nucName !== "string" || nucName.length === 0) {
          throw new DepletionRecordError("isotopics", "nuclide name must be a non-empty string");
        }
        if (!Array.isArray(amounts)) {
          throw new DepletionRecordError("isotopics", `amounts for nuclide '${nucName}' must be an array`);
        }
        if (amounts.length !== n + 1) {
          throw new DepletionRecordError("isotopics", `amounts for nuclide '${nucName}' must have length ${n + 1}, got ${amounts.length}`);
        }
        for (const amt of amounts) {
          if (typeof amt !== "number" || !Number.isFinite(amt) || amt < 0) {
            throw new DepletionRecordError("isotopics", `amount for nuclide '${nucName}' must be a finite number at least 0`);
          }
        }
        isotopicsResult[rName]![nucName] = (amounts as number[]).slice();
      }
    }
  }

  // provenance (required)
  if (!("provenance" in doc)) {
    throw new DepletionRecordError("provenance", "provenance is required");
  }
  if (typeof doc.provenance !== "object" || doc.provenance === null || Array.isArray(doc.provenance)) {
    throw new DepletionRecordError("provenance", "provenance must be an object");
  }

  const result: DepletionRecord = {
    schema: "studio.depletion/0.1",
    ...(typeof doc.id === "string" ? { id: doc.id } : {}),
    time_steps_days: timeStepsDays.slice(),
    regions,
    provenance: { ...(doc.provenance as Record<string, unknown>) },
  };

  if (kResult !== undefined) {
    result.k = kResult;
  }
  if (isotopicsResult !== undefined) {
    result.isotopics = isotopicsResult;
  }

  return result;
}

export function endTimesDays(record: DepletionRecord): number[] {
  const result: number[] = [];
  let cum = 0;
  for (const dt of record.time_steps_days) {
    cum += dt;
    result.push(cum);
  }
  return result;
}

export function burnupAt(record: DepletionRecord, regionName: string, tDays: number): number {
  const region = record.regions.find((r) => r.name === regionName);
  if (!region) {
    throw new DepletionRecordError("regionName", `unknown region '${regionName}'`);
  }
  const endTimes = endTimesDays(record);
  const lastEndTime = endTimes[endTimes.length - 1]!;
  if (typeof tDays !== "number" || !Number.isFinite(tDays) || tDays < 0 || tDays > lastEndTime) {
    throw new DepletionRecordError("tDays", `time ${tDays} is out of bounds [0, ${lastEndTime}]`);
  }
  if (tDays === 0) {
    return 0;
  }
  for (let i = 0; i < endTimes.length; i++) {
    const tCurr = endTimes[i]!;
    if (tDays <= tCurr) {
      const tPrev = i === 0 ? 0 : endTimes[i - 1]!;
      const bPrev = i === 0 ? 0 : region.burnup_mwd_per_tu[i - 1]!;
      const bCurr = region.burnup_mwd_per_tu[i]!;
      if (tCurr === tPrev) return bCurr;
      const frac = (tDays - tPrev) / (tCurr - tPrev);
      return bPrev + frac * (bCurr - bPrev);
    }
  }
  return region.burnup_mwd_per_tu[region.burnup_mwd_per_tu.length - 1]!;
}

export function toOxideBasis(burnupMwdPerTu: number, hmMassFractionOfOxide: number): number {
  if (typeof hmMassFractionOfOxide !== "number" || !Number.isFinite(hmMassFractionOfOxide) || hmMassFractionOfOxide <= 0 || hmMassFractionOfOxide > 1) {
    throw new DepletionRecordError("hmMassFractionOfOxide", `heavy metal mass fraction must be in (0, 1], got ${hmMassFractionOfOxide}`);
  }
  if (typeof burnupMwdPerTu !== "number" || !Number.isFinite(burnupMwdPerTu)) {
    throw new DepletionRecordError("burnupMwdPerTu", `burnup must be a finite number, got ${burnupMwdPerTu}`);
  }
  return burnupMwdPerTu * hmMassFractionOfOxide;
}
