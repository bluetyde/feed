// Plan 14 regression: the OFFBEAT files FEED writes for every example and every good vector that existed before the particle's mechanics (pins, plates, stacks, transients, thermal
// particles) are byte for byte what main (2dcb541) wrote. The fixture holds the first 16 hex digits of the SHA-256 of every written file, made with the code of that commit
// (scripts: write every case, hash every file); this test writes them again with the code under test and compares. A thermal particle without the mechanics section takes the
// thermal writer, a case without it is read as before.
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { writeTrisoParticleCase } from "../src/core/trisoMechanicsWriter";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const baseline: Record<string, Record<string, string>> = JSON.parse(readFileSync(join(root, "tests", "fixtures", "written-case-hashes-main-2dcb541.json"), "utf8"));

describe("the files written for cases without the particle's mechanics section are unchanged", () => {
  it("the fixture covers pins, plates, stacks and particles", () => {
    const keys = Object.keys(baseline);
    expect(keys.length).toBeGreaterThan(90);
    expect(keys.some((k) => k.startsWith("examples/"))).toBe(true);
    expect(keys.some((k) => k.includes("triso-steady"))).toBe(true);
    expect(keys.some((k) => k.includes("triso-pulse"))).toBe(true);
    expect(keys.some((k) => k.includes("plate"))).toBe(true);
  });
  for (const [key, hashes] of Object.entries(baseline)) {
    it(key, () => {
      const path = key.startsWith("examples/") ? join(root, key) : join(root, "schema", "vectors", key);
      const v = validateCase(JSON.parse(readFileSync(path, "utf8")));
      const w = v.normalized ? writeOffbeatCase(v.normalized) : writeTrisoParticleCase(v.triso!);
      const now = Object.fromEntries(Object.entries(w.files).sort().map(([k, t]) => [k, createHash("sha256").update(t).digest("hex").slice(0, 16)]));
      expect(now).toEqual(hashes);
    });
  }
});
