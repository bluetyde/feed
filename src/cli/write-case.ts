// usage: node dist/cli/write-case.js <case.json> <outDir>
// Validates the case, writes the OFFBEAT files and feed-manifest.json (mapping, placeholders, file hashes). LF endings.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { writeOffbeatCase } from "../core/caseWriter";
import { unrunnableErrors, validateCase } from "../core/validate";

function main(argv: string[]): number {
  const [casePath, outDir] = argv;
  if (!casePath || !outDir) {
    console.error("usage: write-case <case.json> <outDir>");
    return 2;
  }
  const doc = JSON.parse(readFileSync(casePath, "utf8"));
  const v = validateCase(doc);
  if (!v.normalized) {
    for (const e of unrunnableErrors(v)) console.error(e.code + " " + e.field + ": " + e.message);
    return 1;
  }
  const out = resolve(outDir);
  // only a folder this tool wrote before (it holds feed-manifest.json) or an empty one is replaced: a wrong path never deletes someone's files (Codex review 2026-10-11)
  if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, "feed-manifest.json"))) {
    console.error("refused: " + out + " exists, is not empty and is not a case this tool wrote (no feed-manifest.json); give an empty or new folder");
    return 1;
  }
  rmSync(out, { recursive: true, force: true });
  const w = writeOffbeatCase(v.normalized);
  const hashes: Record<string, string> = {};
  for (const [rel, text] of Object.entries(w.files)) {
    const p = join(out, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, { encoding: "utf8" });
    hashes[rel] = createHash("sha256").update(text).digest("hex");
  }
  const caseHash = createHash("sha256").update(JSON.stringify(v.normalized)).digest("hex");
  writeFileSync(join(out, "feed-manifest.json"), JSON.stringify({ caseId: v.normalized.caseId, caseHash, solver: "OpenFOAM-9 + OFFBEAT 80e84450", mapping: w.mapping, placeholders: w.placeholders, choices: w.choices, files: hashes, warnings: v.warnings }, null, 2) + "\n");
  console.log("wrote " + Object.keys(w.files).length + " files to " + out);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
