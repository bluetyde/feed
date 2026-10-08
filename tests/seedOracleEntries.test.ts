// The SEED oracle entries (oracles/seed/, written by scripts/gen-seed-oracles.cjs): every entry is internally consistent (its input hash, its tolerance hash), every
// bad-input entry is refused by FEED's validator with the code the entry names, and the entries added with plan 10 M5 (the reciprocal law, hot dimensions, burnup)
// agree with FEED's own closed form (src/core, a second method: the generator uses none of it) and, with FEED_SOLVER=1, with the real solver within the entry's tolerance.
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { quickLook } from "../src/core/quickLook";
import { ResultsRecord } from "../src/core/resultsParser";
import { RunManager } from "../src/core/runManager";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const dir = join(__dirname, "..", "oracles", "seed");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const canonical = (v: unknown): string =>
  v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
const entries = readdirSync(join(dir, "entries")).map((f) => JSON.parse(readFileSync(join(dir, "entries", f), "utf8")));
const caseOf = (e: any) => JSON.parse(readFileSync(join(dir, e.inputs[0].path), "utf8"));

/** The entries of plan 10 M5 that are steady good entries on the new content. */
const NEW = /^feed-(synthetic-reciprocal-fuel-k|synthetic-reciprocal-clad-k|synthetic-hot-dimensions|synthetic-hot-dimensions-linear-alpha|lwr-uo2-burnup-0|lwr-uo2-burnup-40)-temperature-(peak|surface)$/;

describe("the SEED oracle entries", () => {
  it("each entry pins its case by hash and its expected value and tolerance by hash", () => {
    expect(entries.length).toBe(72);
    for (const e of entries) {
      expect(e.inputs[0].sha256, e.oracleId).toBe(sha(readFileSync(join(dir, e.inputs[0].path))));
      expect(e.toleranceHash, e.oracleId).toBe(sha(canonical({ expected: e.expected, tolerance: e.tolerance === undefined ? null : e.tolerance })));
    }
  });
  it("the set is 46 good, 24 bad-input and 2 known-limit entries", () => {
    const n = (t: string) => entries.filter((e) => e.tag === t).length;
    expect([n("good"), n("bad-input"), n("known-limit")]).toEqual([46, 24, 2]);
  });
  it("every bad-input entry is refused by the validator with the code it names, and it is the first error", () => {
    for (const e of entries.filter((x) => x.tag === "bad-input")) {
      const r = validateCase(caseOf(e));
      expect(r.ok, e.oracleId).toBe(false);
      expect(r.errors[0]!.code, e.oracleId).toBe(e.expected.refusalCode);
    }
  });
  it("the new good entries agree with FEED's closed form to 1e-3 K (the entry's own tolerance is for the mesh)", () => {
    const hits = entries.filter((e) => NEW.test(e.oracleId));
    expect(hits).toHaveLength(12);
    for (const e of hits) {
      const v = validateCase(caseOf(e));
      expect(v.ok, e.oracleId).toBe(true);
      const t = quickLook(v.normalized!).temperatures;
      const mine = e.expected.quantity === "temperature_peak" ? t.centreT : t.claddingOuterT;
      expect(Math.abs(mine - e.expected.value), e.oracleId).toBeLessThan(1e-3);
    }
  });
  it("the hot-dimension and burnup entries are not the cold or fresh answer (the entry would not test the feature)", () => {
    const peak = (id: string) => entries.find((e) => e.oracleId === id)!.expected.value;
    const cold = quickLook(validateCase((() => { const d = caseOf(entries.find((e) => e.oracleId === "feed-synthetic-hot-dimensions-temperature-peak")); delete d.hotDimensions; return d; })()).normalized!).temperatures.centreT;
    expect(Math.abs(cold - peak("feed-synthetic-hot-dimensions-temperature-peak"))).toBeGreaterThan(1);
    expect(peak("feed-lwr-uo2-burnup-40-temperature-peak") - peak("feed-lwr-uo2-burnup-0-temperature-peak")).toBeGreaterThan(200);
  });
});

const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

describe.skipIf(!solverOn)("the new entries against the real solver (needs FEED_SOLVER=1)", () => {
  const cases = [...new Set(entries.filter((e) => NEW.test(e.oracleId)).map((e) => e.inputs[0].path))];
  for (const path of cases) {
    it(path + ": every check passes and the solver's peak and wall temperature are inside the entries' tolerances", async () => {
      const mine = entries.filter((e) => NEW.test(e.oracleId) && e.inputs[0].path === path);
      const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-seedoracle-")), backend: new WslBackend(), timeoutMs: 280_000 });
      const s = mgr.start(caseOf(mine[0]));
      if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
      const rec = await mgr.done(s.id);
      const res = mgr.results(s.id) as ResultsRecord;
      expect(rec.state).toBe("completed");
      expect(res.checks.filter((c) => c.verdict !== "pass").map((c) => c.id)).toEqual([]);
      for (const e of mine) {
        const got = e.expected.quantity === "temperature_peak" ? res.summary.maxT : res.summary.claddingOuterWallT!;
        expect(Math.abs(got - e.expected.value), e.oracleId + " solver " + got + " expected " + e.expected.value).toBeLessThanOrEqual(e.tolerance.abs);
      }
    }, 300_000);
  }
});
