// Runs FEED's own 1D pin case through the real OFFBEAT with the mechanics switched ON, by editing what the case writer wrote (the writer itself writes mechanics
// off, `mechanicsSolver fromLatestTime`). Only for the M0 probes of docs/plans/09-mechanics.md (tests/mechanicsProbe.test.ts, FEED_SOLVER=1): it is not the
// case writer's mechanics, which does not exist yet. The runs happen in the feed-solver distro through solver/probe-mechanics.sh, which copies every field of the
// last time out, so the displacement, stress and contact fields can be read.
import { execFile } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { writeOffbeatCase } from "../../src/core/caseWriter";
import { validateCase } from "../../src/core/validate";
import { DISTRO, DISTRO_USER, toWslPath } from "../../src/core/wslBackend";

const root = join(__dirname, "..", "..");

export interface Material {
  E?: string;
  nu?: string;
  alpha?: string;
  G?: string;
}
export interface ProbeOptions {
  /** Linear heat rate, W/m: tiny, so that the pin is at its coolant temperature. */
  q?: number;
  /** Coolant (and so uniform pin) temperature, K. */
  T?: number;
  /** Cladding inner radius, mm: the gap is this less the fuel radius (4.1 mm). */
  rci?: number;
  mechanics?: boolean;
  thermalExpansion?: "on" | "off";
  fuel?: Material;
  cladding?: Material;
  /** External pressure on the cladding's outer surface, Pa (compressive positive). */
  outerPressure?: number;
  /** Edits of the text of any file the writer made, by its path in the case. */
  edit?: Record<string, (text: string) => string>;
  /** Edit of the solverDict text, after the others. */
  editDict?: (text: string) => string;
  timeoutSeconds?: number;
}
export interface ProbeRun {
  dir: string;
  /** The folder of the last time's fields, or undefined when the solver wrote none. */
  final?: string;
  log: string;
  exit: { blockMeshExit: number; offbeatExit: number; finalTime: string };
}

const setMaterial = (text: string, name: string, m: Material): string =>
  text.replace(new RegExp(`(    ${name}\\n    \\{[\\s\\S]*?\\n    \\})`), (blk) => {
    let b = blk;
    if (m.E !== undefined) b = b.replace(/E           E     \[1 -1 -2 0 0\]  [^;]+;/, `E           E     [1 -1 -2 0 0]  ${m.E};`);
    if (m.nu !== undefined) b = b.replace(/nu          nu    \[0 0 0 0 0\]    [^;]+;/, `nu          nu    [0 0 0 0 0]    ${m.nu};`);
    if (m.alpha !== undefined) b = b.replace(/alpha       alpha \[0 0 0 0 0\]    [^;]+;/, `alpha       alpha [0 0 0 0 0]    ${m.alpha};`);
    if (m.G !== undefined) b = b.replace(/G           G     \[1 -1 -2 0 0\]  [^;]+;/, `G           G     [1 -1 -2 0 0]  ${m.G};`);
    return b;
  });

let counter = 0;
export function probeCase(o: ProbeOptions = {}) {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
  d.power.linearHeatRate = { value: o.q ?? 1, unit: "W/m" };
  d.boundary = { bulkTemperature: { value: o.T ?? 600, unit: "K" }, heatTransferCoefficient: { value: 30000, unit: "W/m2/K" } };
  d.geometry.claddingInnerRadius = { value: o.rci ?? 4.12, unit: "mm" };
  const v = validateCase(d);
  if (!v.normalized) throw new Error(JSON.stringify(v.errors));
  const NL = "\n";
  const files: Record<string, string> = {};
  for (const [rel, text] of Object.entries(writeOffbeatCase(v.normalized).files)) {
    let t = text;
    if (rel === "constant/solverDict" && o.mechanics !== false) {
      t = t.replace("mechanicsSolver         fromLatestTime;", "mechanicsSolver         smallStrain;");
      t = t.replace(
        "heatSourceOptions",
        ["rheologyOptions", "{", `    thermalExpansion ${o.thermalExpansion ?? "on"};`, "    planeStress off;", "    modifiedPlaneStrain on;", "    coolantPressureList { values 2 ( (0 0) (1e10 0) ); }", "    springModulus 3500;", "}", "", "mechanicsSolverOptions", "{", "    forceSummary off;", "    cylindricalStress on;", "    RhieChowCorrection false;", "}", "", "heatSourceOptions"].join(NL),
      );
      if (o.fuel) t = setMaterial(t, "fuel", o.fuel);
      if (o.cladding) t = setMaterial(t, "cladding", o.cladding);
      if (o.editDict) t = o.editDict(t);
    }
    if (rel === "0/D" && o.mechanics !== false) {
      t = t.replace(/cladOuter\s*\{[^}]*\}/, `cladOuter\n    {\n        type            tractionDisplacement;\n        traction        uniform (0 0 0);\n        pressure        uniform ${o.outerPressure ?? 0};\n        relax           1.0;\n        value           uniform (0 0 0);\n    }`);
    }
    if (o.edit?.[rel]) t = o.edit[rel]!(t);
    files[rel] = t;
  }
  return files;
}

/** Run the case in the distro and return where its results are. */
export function runProbe(files: Record<string, string>, timeoutSeconds = 300): Promise<ProbeRun> {
  const dir = mkdtempSync(join(tmpdir(), "feed-mech-"));
  const inputs = join(dir, "inputs");
  const out = join(dir, "out");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(inputs, rel)), { recursive: true });
    writeFileSync(join(inputs, rel), text);
  }
  const tag = `t${Date.now().toString(36)}${(counter++).toString(36)}`;
  return new Promise((resolve, reject) => {
    execFile("wsl.exe", ["-d", DISTRO, "-u", DISTRO_USER, "--exec", "bash", toWslPath(join(root, "solver", "probe-mechanics.sh")), toWslPath(inputs), toWslPath(out), tag, String(timeoutSeconds), "clean"], { timeout: (timeoutSeconds + 120) * 1000, encoding: "utf8" }, (err) => {
      if (err && !existsSync(join(out, "exit.json"))) return reject(err);
      const exit = JSON.parse(readFileSync(join(out, "exit.json"), "utf8"));
      const final = join(out, "final");
      resolve({ dir, ...(existsSync(final) ? { final } : {}), log: existsSync(join(out, "log.offbeat")) ? readFileSync(join(out, "log.offbeat"), "utf8") : "", exit });
    });
  });
}

type Row = number[];
const rows = (body: string): Row[] =>
  body
    .trim()
    .split("\n")
    .map((l) => l.replace(/[()]/g, "").trim().split(/\s+/).map(Number));

/** The text of a field value entry (`key  nonuniform List<...> n ( ... )` or `key uniform ...;`) as numbers, one row per cell or face, or undefined. */
function entry(text: string, key: string): Row[] | undefined {
  const nu = new RegExp(`${key}\\s+nonuniform List<[a-zA-Z]+>\\s*\\n(\\d+)\\s*\\n\\(([\\s\\S]*?)\\n\\)\\s*\\n;`).exec(text);
  if (nu) return rows(nu[2]!);
  const un = new RegExp(`${key}\\s+uniform\\s+([^;]+);`).exec(text);
  if (un) return [un[1]!.replace(/[()]/g, "").trim().split(/\s+/).map(Number)];
  return undefined;
}

/** The cell values of a field, from the last time's file. One row per cell (a scalar field has one number per row). */
export function cells(run: ProbeRun, field: string): Row[] {
  const t = readFileSync(join(run.final!, field), "utf8");
  const e = entry(t.slice(t.indexOf("internalField"), t.indexOf("boundaryField")), "internalField");
  if (!e) throw new Error(`field ${field} has no readable internalField`);
  return e;
}

/** The value of a patch entry (default `value`) of a field, one row. */
export function patch(run: ProbeRun, field: string, name: string, key = "value"): Row {
  const t = readFileSync(join(run.final!, field), "utf8");
  const b = t.slice(t.indexOf("boundaryField"));
  const m = new RegExp(`\\n    ${name}\\s*\\n    \\{([\\s\\S]*?)\\n    \\}`).exec(b);
  const e = m ? entry(m[1]!, key) : undefined;
  if (!e) throw new Error(`patch ${name} of ${field} has no ${key}`);
  return e[0]!;
}

export const fieldNames = (run: ProbeRun): string[] => readdirSync(run.final!);
