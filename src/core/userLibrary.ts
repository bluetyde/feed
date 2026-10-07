// The user's own materials (docs/user-library.md): a material entered or edited in the editor and saved so it can be reused, kept apart from the
// committed, sourced library (library/materials.json). Stored in library/custom/materials.json (git-ignored; FEED_USER_LIBRARY names another file, for
// tests). Every revision is kept: saving a changed material under its id adds revision n+1 and leaves the earlier ones, so a case that names revision 2
// still means what it meant. The properties are checked with the rules a case applies (validateMaterial); nothing here invents a value.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Origin, setsHash } from "./projectImport";
import { Issue, MATERIAL_ID, projectRoot, validateMaterial } from "./validate";

export const USER_LIBRARY_SCHEMA = "feed.user-materials/0.1";
export const MAX_ENTRIES = 1000;
export const MAX_FILE_BYTES = 5_000_000;
export const MAX_MATERIAL_BYTES = 100_000;

export interface UserEntry {
  region: "fuel" | "cladding";
  name: string;
  label: "custom";
  description: string;
  citation: string;
  savedAt: string;
  material: { materialId: string; revision: number; sets: Record<string, unknown>; origin?: Origin };
}

export function userLibraryFile(): string {
  return process.env.FEED_USER_LIBRARY ?? join(projectRoot(), "library", "custom", "materials.json");
}

/** Every saved revision, oldest first, or the reason the file cannot be read (a damaged file is reported, never overwritten or guessed at). */
export function readUserEntries(): { entries: UserEntry[]; problem?: string } {
  const f = userLibraryFile();
  if (!existsSync(f)) return { entries: [] };
  try {
    const doc = JSON.parse(readFileSync(f, "utf8"));
    if (!doc || doc.schema !== USER_LIBRARY_SCHEMA || !Array.isArray(doc.entries)) return { entries: [], problem: `${f} is not a ${USER_LIBRARY_SCHEMA} file` };
    const entries: UserEntry[] = [];
    for (const e of doc.entries) {
      const checked = validateMaterial(e?.region, e?.material);
      if ((e?.region !== "fuel" && e?.region !== "cladding") || typeof e.name !== "string" || !checked.ok) return { entries: [], problem: `${f} holds an entry that is not a valid material (${checked.errors[0]?.message ?? "bad region or name"})` };
      entries.push(e as UserEntry);
    }
    return { entries };
  } catch (e) {
    return { entries: [], problem: `${f} cannot be read: ${String((e as Error).message)}` };
  }
}

/** The latest revision of each id, in the order the ids were first saved. */
export function latestEntries(entries: UserEntry[]): UserEntry[] {
  const latest = new Map<string, UserEntry>();
  for (const e of entries) {
    const cur = latest.get(e.material.materialId);
    if (!cur || e.material.revision > cur.material.revision) latest.set(e.material.materialId, e);
  }
  return [...latest.values()];
}

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
};

export interface SaveInput {
  region?: unknown;
  name?: unknown;
  description?: unknown;
  citation?: unknown;
  material?: unknown;
}
export type SaveResult =
  | { ok: true; status: "saved" | "unchanged"; entry: UserEntry }
  | { ok: false; status: 400 | 409 | 500; errors: Issue[] };

const refuse = (status: 400 | 409 | 500, code: string, field: string, message: string): SaveResult => ({ ok: false, status, errors: [{ code, severity: "error", field, message }] });

/**
 * Save a material. The properties must pass validateMaterial; the id must not belong to a sourced library material or to a material of the other region.
 * Identical to the latest revision: `unchanged`, nothing written. Otherwise the revision is the latest plus one (1 for a new id), whatever revision the
 * input carried. A material imported from a SEED project carries its `origin`: a NEW id then takes the project's revision when its sets are as imported and
 * that revision plus one when they changed (adding a thermal set makes a new revision of the project's material); a later save is still the latest plus one,
 * and never below that.
 */
export function saveUserMaterial(input: SaveInput, sourcedIds: ReadonlySet<string>, now: Date = new Date()): SaveResult {
  const region = input.region;
  if (region !== "fuel" && region !== "cladding") return refuse(400, "E_SCHEMA_INVALID", "/region", "region is fuel or cladding");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "" || name.length > 120 || /[\u0000-\u001f]/.test(name)) return refuse(400, "E_SCHEMA_INVALID", "/name", "a material needs a name of 1 to 120 characters, with no control characters");
  const description = input.description === undefined ? "" : input.description;
  const citation = input.citation === undefined ? "" : input.citation;
  if (typeof description !== "string" || description.length > 1000) return refuse(400, "E_SCHEMA_INVALID", "/description", "the description is text of at most 1000 characters");
  if (typeof citation !== "string" || citation.length > 2000) return refuse(400, "E_SCHEMA_INVALID", "/citation", "the citation is text of at most 2000 characters");
  if (JSON.stringify(input.material ?? null).length > MAX_MATERIAL_BYTES) return refuse(400, "E_OUT_OF_RANGE", "/material", `a material is at most ${MAX_MATERIAL_BYTES} bytes`);
  // a sourced id is reported as taken before its spelling is judged (a sourced id may be spelled in ways a new one may not)
  const rawId = typeof input.material === "object" && input.material !== null ? (input.material as { materialId?: unknown }).materialId : undefined;
  if (typeof rawId === "string" && sourcedIds.has(rawId)) return refuse(409, "E_MATERIAL_ID_TAKEN", "/material/materialId", `'${rawId}' is a sourced library material and cannot be replaced; give your material its own id`);
  const checked = validateMaterial(region, input.material);
  if (!checked.ok) return { ok: false, status: 400, errors: checked.errors };
  const incoming = input.material as UserEntry["material"];
  const origin = incoming.origin;
  if (origin !== undefined) {
    const o = origin as unknown as Record<string, unknown>;
    const okOrigin = typeof o === "object" && o !== null && o.kind === "seed-project" && typeof o.projectId === "string" && o.projectId.length >= 1 && o.projectId.length <= 200 && o.materialId === incoming.materialId && typeof o.revision === "number" && Number.isInteger(o.revision) && o.revision >= 1 && typeof o.name === "string" && o.name.length <= 120 && typeof o.setsSha256 === "string" && /^[0-9a-f]{64}$/.test(o.setsSha256);
    if (!okOrigin) return refuse(400, "E_SCHEMA_INVALID", "/material/origin", "origin records where an imported material came from: kind seed-project, the project id, the material's id and revision there, its name, and the hash of its sets as imported");
  }

  const read = readUserEntries();
  if (read.problem) return refuse(500, "E_LIBRARY_UNREADABLE", "/", read.problem + ". It was left as it is; fix or move it, then save again.");
  const same = read.entries.filter((e) => e.material.materialId === incoming.materialId);
  if (same.some((e) => e.region !== region)) return refuse(409, "E_MATERIAL_ID_TAKEN", "/material/materialId", `'${incoming.materialId}' is already a ${same[0]!.region} material of yours; an id belongs to one region`);
  if (read.entries.length >= MAX_ENTRIES) return refuse(400, "E_OUT_OF_RANGE", "/", `the library holds ${MAX_ENTRIES} saved revisions, the most it takes`);

  const latest = same.reduce<UserEntry | undefined>((a, e) => (!a || e.material.revision > a.material.revision ? e : a), undefined);
  const sets = JSON.parse(JSON.stringify(incoming.sets)) as Record<string, unknown>;
  if (latest && canonical(latest.material.sets) === canonical(sets) && latest.name === name && latest.description === description && latest.citation === citation) return { ok: true, status: "unchanged", entry: latest };

  let revision = (latest?.material.revision ?? 0) + 1;
  if (origin) {
    const fromProject = setsHash(sets) === origin.setsSha256 ? origin.revision : origin.revision + 1;
    revision = latest ? Math.max(revision, fromProject) : fromProject;
  }
  const entry: UserEntry = { region, name, label: "custom", description, citation, savedAt: now.toISOString(), material: { materialId: incoming.materialId, revision, sets, ...(origin ? { origin: JSON.parse(JSON.stringify(origin)) as Origin } : {}) } };
  const text = JSON.stringify({ schema: USER_LIBRARY_SCHEMA, entries: [...read.entries, entry] }, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return refuse(400, "E_OUT_OF_RANGE", "/", `the library file would pass ${MAX_FILE_BYTES} bytes`);
  const f = userLibraryFile();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = f + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, f);
  return { ok: true, status: "saved", entry };
}
