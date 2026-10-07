// Materials shared through a SEED project (docs/seed-material-import.md). A SEED project (seed.project.json, schema seed.project/0.1) lists materials by id and
// revision, each with property sets named by their consumer: openmc.composition, thermal.conductivity, and so on. FEED reads a project's material, uses the
// thermal sets it understands, keeps every other set exactly as it found it, and says which thermal properties are missing. It never writes into a project: SEED
// owns the manifest (its writer lock, its expected-revision check). A changed material is saved in FEED's own library as a new revision (src/core/userLibrary.ts).
//
// What FEED reads: a set named thermal.conductivity or thermal.volumetricHeatCapacity whose `schema` is feed.thermal-property/0.1, with the fields of FEED's own
// property sets (docs/conductivity-models.md); its `source` is SEED's {kind, text}, which becomes FEED's source text. A thermal-named set of any other schema is
// another app's: FEED does not guess at it and refuses the import (SEED's rule: another app's set is not overwritten, and not evaluated).

import { createHash } from "crypto";
import { closeSync, existsSync, fstatSync, openSync, promises as fsp, readSync, statSync } from "fs";
import { basename, join } from "path";
import { Issue, MATERIAL_ID, validateMaterial } from "./validate";

export const PROJECT_MANIFEST_FILE = "seed.project.json";
export const PROJECT_SCHEMA = "seed.project/0.1";
export const THERMAL_SET_SCHEMA = "feed.thermal-property/0.1";
export const MAX_MANIFEST_BYTES = 8_000_000;
export const THERMAL_SETS = ["thermal.conductivity", "thermal.volumetricHeatCapacity"] as const;
const SET_NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/;
const SOURCE_KINDS = ["synthetic", "sourced", "assumed"];
/** SEED's set names are lower case (contracts.md section 5); FEED's heat capacity set has a capital in its own name, so a project holds it as thermal.volumetric_heat_capacity. */
export const PROJECT_SET_NAME: Record<(typeof THERMAL_SETS)[number], string> = { "thermal.conductivity": "thermal.conductivity", "thermal.volumetricHeatCapacity": "thermal.volumetric_heat_capacity" };
const FEED_SET_NAME = new Map<string, (typeof THERMAL_SETS)[number]>(THERMAL_SETS.map((n) => [PROJECT_SET_NAME[n], n]));

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const issue = (code: string, field: string, message: string): Issue => ({ code, severity: "error", field, message });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Canonical JSON (keys sorted), for comparing and hashing sets. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Obj;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}
/** The hash of a material's sets, which a saved material records so that a later save can tell whether the sets changed. */
export const setsHash = (sets: unknown) => createHash("sha256").update(canonicalJson(sets)).digest("hex");

/** Where a material came from: the project, the id and the revision it had there, and the hash of the sets as imported. */
export interface Origin {
  kind: "seed-project";
  projectId: string;
  materialId: string;
  revision: number;
  name: string;
  setsSha256: string;
}

export interface Manifest {
  schema: string;
  projectId: string;
  name?: string;
  materials: Obj[];
}
export type ReadResult = { ok: true; manifest: Manifest; file: string } | { ok: false; errors: Issue[] };

/** The origin a material carries: one contract, checked when a project is imported and again when the material is saved. */
export const PROJECT_ID_MAX = 200;
export const ORIGIN_NAME_MAX = 120;
export const ORIGIN_RULE_TEXT = "origin records where an imported material came from: kind seed-project, the project id (1 to " + PROJECT_ID_MAX + " characters), the material's id and revision there (a whole number from 1 that adding one keeps exact), its name (at most " + ORIGIN_NAME_MAX + " characters), and the hash of its sets as imported";
export function originProblem(origin: unknown, materialId: string): string | null {
  const o = origin as Record<string, unknown> | null;
  const ok = typeof o === "object" && o !== null && o.kind === "seed-project" && typeof o.projectId === "string" && o.projectId.length >= 1 && o.projectId.length <= PROJECT_ID_MAX && o.materialId === materialId && typeof o.revision === "number" && Number.isSafeInteger(o.revision) && o.revision >= 1 && o.revision < Number.MAX_SAFE_INTEGER && typeof o.name === "string" && o.name.length <= ORIGIN_NAME_MAX && typeof o.setsSha256 === "string" && /^[0-9a-f]{64}$/.test(o.setsSha256);
  return ok ? null : ORIGIN_RULE_TEXT;
}

/** The deadline for reading a project from the server: a folder on a share that does not answer must not hold the server. */
export const READ_DEADLINE_MS = 5000;

const projectError = (message: string, field = "/path"): ReadResult => ({ ok: false, errors: [issue("E_IMPORT_PROJECT", field, message)] });
class ReadFailure extends Error {}
const TOO_LARGE = `${PROJECT_MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes`;

/** The path as given, checked without touching the disk: text of a sane size. */
function pathProblem(path: unknown): ReadResult | null {
  if (typeof path !== "string" || path.trim() === "" || path.length > 1000 || /[\u0000-\u001f]/.test(path)) return projectError("give the path of a SEED project folder (or of its seed.project.json)");
  return null;
}
const wrongName = (file: string): ReadResult | null => (basename(file) !== PROJECT_MANIFEST_FILE ? projectError(`FEED reads only a file named ${PROJECT_MANIFEST_FILE}; give the project folder or that file`) : null);
const readFailure = (e: unknown, file: string): ReadResult => {
  if (e instanceof ReadFailure) return projectError(e.message);
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return projectError(`no ${PROJECT_MANIFEST_FILE} at ${file}`);
  return projectError("the file cannot be read: " + (e as Error).message);
};

/** The manifest's text parsed and checked for what FEED needs of it (SEED's own validation is SEED's). */
function parseManifest(text: string, file: string): ReadResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return projectError(`${PROJECT_MANIFEST_FILE} is not valid JSON`);
  }
  if (!isObject(doc) || doc.schema !== PROJECT_SCHEMA) return projectError(`not a ${PROJECT_SCHEMA} project (schema is ${isObject(doc) ? JSON.stringify(doc.schema) : "missing"}); FEED reads that version only`, "/schema");
  if (typeof doc.projectId !== "string" || doc.projectId.length < 1 || doc.projectId.length > PROJECT_ID_MAX || !Array.isArray(doc.materials)) return projectError(`the project has no projectId (1 to ${PROJECT_ID_MAX} characters) or no materials list`, "/");
  return { ok: true, manifest: doc as unknown as Manifest, file };
}

/** The bytes of an open file, at most MAX_MANIFEST_BYTES of them: it must be a regular file, and a file that grows while it is read is refused, not cut. */
function readOpenSync(fd: number): string {
  const st = fstatSync(fd);
  if (!st.isFile()) throw new ReadFailure(`${PROJECT_MANIFEST_FILE} is not a regular file`);
  if (st.size > MAX_MANIFEST_BYTES) throw new ReadFailure(TOO_LARGE);
  const buf = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
  let n = 0;
  while (n < buf.length) {
    const got = readSync(fd, buf, n, buf.length - n, null);
    if (got === 0) break;
    n += got;
  }
  if (n > MAX_MANIFEST_BYTES) throw new ReadFailure(TOO_LARGE);
  return buf.toString("utf8", 0, n);
}

/** Read a project: the folder, or the seed.project.json inside it. Nothing else is read, and only a file of that name. The server uses readProjectAsync. */
export function readProject(path: unknown): ReadResult {
  const bad = pathProblem(path);
  if (bad) return bad;
  let file = (path as string).trim();
  try {
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, PROJECT_MANIFEST_FILE);
  } catch {
    return projectError("the path cannot be read");
  }
  const name = wrongName(file);
  if (name) return name;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    return parseManifest(readOpenSync(fd), file);
  } catch (e) {
    return readFailure(e, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** What the async read needs of a file and of the disk, so a test can stand in for a share that does not answer. */
export interface FileLike {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(buf: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface ReadIo {
  open?: (file: string) => Promise<FileLike>;
  isDirectory?: (path: string) => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * The same read for the server: on the thread pool, not on the server's thread, with a deadline (READ_DEADLINE_MS). A read that does not finish by then is
 * answered with E_IMPORT_PROJECT; what it was doing is closed when it does finish.
 */
export async function readProjectAsync(path: unknown, io: ReadIo = {}): Promise<ReadResult> {
  const bad = pathProblem(path);
  if (bad) return bad;
  const timeoutMs = io.timeoutMs ?? READ_DEADLINE_MS;
  const open = io.open ?? ((f: string) => fsp.open(f, "r") as unknown as Promise<FileLike>);
  const isDirectory = io.isDirectory ?? (async (p: string) => (await fsp.stat(p).catch(() => null))?.isDirectory() === true);
  const work = async (): Promise<ReadResult> => {
    let file = (path as string).trim();
    if (await isDirectory(file)) file = join(file, PROJECT_MANIFEST_FILE);
    const name = wrongName(file);
    if (name) return name;
    let handle: FileLike | undefined;
    try {
      handle = await open(file);
      const st = await handle.stat();
      if (!st.isFile()) throw new ReadFailure(`${PROJECT_MANIFEST_FILE} is not a regular file`);
      if (st.size > MAX_MANIFEST_BYTES) throw new ReadFailure(TOO_LARGE);
      const buf = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
      let n = 0;
      while (n < buf.length) {
        const got = (await handle.read(buf, n, buf.length - n, null)).bytesRead;
        if (got === 0) break;
        n += got;
      }
      if (n > MAX_MANIFEST_BYTES) throw new ReadFailure(TOO_LARGE);
      return parseManifest(buf.toString("utf8", 0, n), file);
    } catch (e) {
      return readFailure(e, file);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ReadResult>((resolve) => {
    timer = setTimeout(() => resolve(projectError(`reading the project took longer than ${timeoutMs} ms; the folder may be on a share that is not answering`)), timeoutMs);
  });
  try {
    return await Promise.race([work(), late]);
  } finally {
    clearTimeout(timer);
  }
}

export type ThermalState = "ready" | "missing" | "foreign";
export interface MaterialInfo {
  id: string;
  revision: number;
  name: string;
  sets: string[];
  /** For each thermal set FEED needs: ready (FEED's schema), missing (not in the material) or foreign (named so, written to another schema). */
  thermal: Record<(typeof THERMAL_SETS)[number], ThermalState>;
}

const materialsOf = (m: Manifest) => m.materials.filter(isObject);
function thermalState(sets: Obj, name: (typeof THERMAL_SETS)[number]): ThermalState {
  const s = sets[PROJECT_SET_NAME[name]];
  if (s === undefined) return "missing";
  return isObject(s) && s.schema === THERMAL_SET_SCHEMA ? "ready" : "foreign";
}

/** The project's materials, with what each offers FEED. */
export function listMaterials(manifest: Manifest): MaterialInfo[] {
  const out: MaterialInfo[] = [];
  for (const m of materialsOf(manifest)) {
    if (typeof m.id !== "string" || typeof m.revision !== "number") continue;
    const sets = isObject(m.sets) ? m.sets : {};
    out.push({
      id: m.id,
      revision: m.revision,
      name: typeof m.name === "string" ? m.name : "",
      sets: Object.keys(sets).filter((k) => SET_NAME.test(k)),
      thermal: { "thermal.conductivity": thermalState(sets, "thermal.conductivity"), "thermal.volumetricHeatCapacity": thermalState(sets, "thermal.volumetricHeatCapacity") },
    });
  }
  return out;
}

export interface ImportInput {
  id?: unknown;
  region?: unknown;
  revision?: unknown;
}
export type ImportResult =
  | {
      ok: true;
      material: { materialId: string; revision: number; sets: Record<string, unknown>; origin: Origin };
      /** The thermal sets the material lacks, and what each is for. */
      missing: { set: string; neededFor: string }[];
      /** What FEED did with what it found: converted, kept, ignored. */
      notes: string[];
      /** The case's own rules applied to the material as imported: what it cannot yet do. */
      problems: Issue[];
    }
  | { ok: false; errors: Issue[] };

const NEEDED_FOR: Record<(typeof THERMAL_SETS)[number], string> = { "thermal.conductivity": "every run", "thermal.volumetricHeatCapacity": "a transient (a pulse)" };

/** A thermal set in SEED's form to FEED's: `source` {kind, text} becomes the text, and the project's record of it is kept beside it. */
function readThermalSet(name: string, set: Obj, notes: string[]): { ok: true; set: Obj } | { ok: false; error: Issue } {
  const out = clone(set);
  const src = out.source;
  if (isObject(src)) {
    if (typeof src.text !== "string" || src.text.trim() === "" || !SOURCE_KINDS.includes(String(src.kind))) return { ok: false, error: issue("E_IMPORT_SET", `/sets/${name}/source`, `the source of ${name} is {kind: synthetic|sourced|assumed, text}; this one has no usable kind or text`) };
    out.sourceRecord = clone(src);
    out.source = src.text;
    if (src.kind !== "sourced") notes.push(`${name}: the project marks its source "${String(src.kind)}"; FEED keeps the text and the record, and does not call it sourced`);
  } else if (typeof src !== "string") return { ok: false, error: issue("E_IMPORT_SET", `/sets/${name}/source`, `${name} has no source text; FEED needs to know where a property came from`) };
  return { ok: true, set: out };
}

/** Import one material of a project into a region of a case. Matching is by id; a revision, if given, must be the project's. The manifest is not changed. */
export function importMaterial(manifest: Manifest, input: ImportInput): ImportResult {
  const region = input.region;
  if (region !== "fuel" && region !== "cladding") return { ok: false, errors: [issue("E_SCHEMA_INVALID", "/region", "region is fuel or cladding")] };
  if (typeof input.id !== "string" || input.id === "") return { ok: false, errors: [issue("E_SCHEMA_INVALID", "/id", "give the id of the material to import")] };
  const found = materialsOf(manifest).find((m) => m.id === input.id);
  if (!found) return { ok: false, errors: [issue("E_IMPORT_NOT_FOUND", "/id", `the project has no material with id '${input.id}' (ids are matched exactly; a name is not an id)`)] };
  if (typeof found.revision !== "number" || !Number.isSafeInteger(found.revision) || found.revision < 1 || found.revision >= Number.MAX_SAFE_INTEGER) return { ok: false, errors: [issue("E_IMPORT_PROJECT", "/revision", `material '${input.id}' has no valid revision in the project`)] };
  if (input.revision !== undefined && input.revision !== found.revision) return { ok: false, errors: [issue("E_IMPORT_REVISION", "/revision", `the project has '${input.id}' at revision ${found.revision}, not ${String(input.revision)}; a revision is immutable and FEED can only read the one the project holds`)] };
  if (!MATERIAL_ID.test(input.id)) return { ok: false, errors: [issue("E_IMPORT_ID", "/id", `'${input.id}' is not an id FEED can carry (3 to 64 characters: lower case letters, digits and hyphens, not starting or ending with a hyphen); FEED does not rewrite ids`)] };
  if (typeof manifest.projectId !== "string" || manifest.projectId.length < 1 || manifest.projectId.length > PROJECT_ID_MAX) return { ok: false, errors: [issue("E_IMPORT_PROJECT", "/projectId", `the project's id is 1 to ${PROJECT_ID_MAX} characters`)] };
  if (found.name !== undefined && (typeof found.name !== "string" || found.name.length > ORIGIN_NAME_MAX)) return { ok: false, errors: [issue("E_IMPORT_PROJECT", "/name", `material '${input.id}' has a name over ${ORIGIN_NAME_MAX} characters (SEED's contract allows 1 to 120); FEED does not cut it`)] };
  if (!isObject(found.sets)) return { ok: false, errors: [issue("E_IMPORT_PROJECT", "/sets", `material '${input.id}' has no sets`)] };

  const notes: string[] = [];
  const sets: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(found.sets)) {
    if (!SET_NAME.test(name)) return { ok: false, errors: [issue("E_IMPORT_SET", `/sets/${name}`, `'${name}' is not a property set name (consumer.property)`)] };
    if (!isObject(value)) return { ok: false, errors: [issue("E_IMPORT_SET", `/sets/${name}`, "a property set is an object")] };
    const feedName = FEED_SET_NAME.get(name);
    if (feedName !== undefined) {
      if (value.schema !== THERMAL_SET_SCHEMA) {
        return { ok: false, errors: [issue("E_IMPORT_FOREIGN_SET", `/sets/${name}`, `'${name}' is written to the schema ${JSON.stringify(value.schema)}; FEED reads ${THERMAL_SET_SCHEMA} only and does not guess at another app's set, so the material is not imported`)] };
      }
      const r = readThermalSet(name, value, notes);
      if (!r.ok) return { ok: false, errors: [r.error] };
      sets[feedName] = r.set;
    } else {
      sets[name] = clone(value);
      notes.push(`${name}: another app's set, kept exactly as it is and not read`);
    }
  }
  const missing = THERMAL_SETS.filter((n) => sets[n] === undefined).map((n) => ({ set: n, neededFor: NEEDED_FOR[n] }));
  const origin: Origin = {
    kind: "seed-project",
    projectId: manifest.projectId,
    materialId: input.id,
    revision: found.revision,
    name: typeof found.name === "string" ? found.name : "",
    setsSha256: setsHash(sets),
  };
  const material = { materialId: input.id, revision: found.revision, sets, origin };
  // the case's own rules on what was read: a material that lacks a conductivity is imported (the rest of it is still the project's) and the case then names what it lacks
  const checked = validateMaterial(region, material);
  return { ok: true, material, missing, notes, problems: checked.errors };
}

/**
 * A FEED material as a project material (the form other apps and SEED hold): thermal sets get the schema and SEED's source record, every other set is
 * carried as it is. The inverse of importMaterial for the sets; `kind` is how the source is to be labelled, and FEED never says "sourced" on its own account.
 */
export function toProjectMaterial(material: { materialId: string; revision: number; sets: Record<string, unknown>; origin?: Origin }, name: string, kind: "synthetic" | "assumed" | "sourced" = "assumed") {
  const sets: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(material.sets)) {
    if (!(THERMAL_SETS as readonly string[]).includes(k) || !isObject(v)) {
      sets[k] = clone(v);
      continue;
    }
    const s = clone(v);
    const record = s.sourceRecord;
    delete s.sourceRecord;
    s.schema = THERMAL_SET_SCHEMA;
    s.source = isObject(record) ? record : { kind, text: String(s.source ?? "") };
    sets[PROJECT_SET_NAME[k as (typeof THERMAL_SETS)[number]]] = s;
  }
  return { id: material.materialId, revision: material.revision, name, sets };
}
