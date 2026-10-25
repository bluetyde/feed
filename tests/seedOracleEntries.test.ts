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
const near = (x: number, ref: number, rel: number) => Math.abs(x / ref - 1) <= rel;
const entries = readdirSync(join(dir, "entries")).map((f) => JSON.parse(readFileSync(join(dir, "entries", f), "utf8")));
const caseOf = (e: any) => JSON.parse(readFileSync(join(dir, e.inputs[0].path), "utf8"));

/** The entries of plan 10 M5 that are steady good entries on the new content. */
const MARGIN = /^feed-(ksu-triga-1p25mw-film-limits|ut-triga-pulse-4p40-limits)-temperature-limit-margin$/;
const GA = /^feed-ga7882-pulse-(3|5)-dollar-(energy-deposited|temperature-peak-max)$/;
const NEW = /^feed-(synthetic-reciprocal-fuel-k|synthetic-reciprocal-clad-k|synthetic-hot-dimensions|synthetic-hot-dimensions-linear-alpha|lwr-uo2-burnup-0|lwr-uo2-burnup-40)-temperature-(peak|surface)$/;

describe("the SEED oracle entries", () => {
  it("each entry pins its case by hash and its expected value and tolerance by hash", () => {
    expect(entries.length).toBe(138);
    for (const e of entries) {
      expect(e.inputs[0].sha256, e.oracleId).toBe(sha(readFileSync(join(dir, e.inputs[0].path))));
      expect(e.toleranceHash, e.oracleId).toBe(sha(canonical({ expected: e.expected, tolerance: e.tolerance === undefined ? null : e.tolerance })));
    }
  });
  it("the set is 92 good, 43 bad-input and 3 known-limit entries (79, 43, 3 before the 13 fuel temperature entries of the SEED power-temperature loop; 63, 35, 3 before the stack and plate entries of plan 12 A8)", () => {
    const n = (t: string) => entries.filter((e) => e.tag === t).length;
    expect([n("good"), n("bad-input"), n("known-limit")]).toEqual([92, 43, 3]);
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
  it("the steady limit-margin entry is the limit minus FEED's closed-form centre temperature, to 1e-3 K; the pulse entry is the limit minus the independent peak", () => {
    const k = entries.find((e) => e.oracleId === "feed-ksu-triga-1p25mw-film-limits-temperature-limit-margin")!;
    const t = quickLook(validateCase(caseOf(k)).normalized!).temperatures;
    expect(Math.abs(1150 + 273.15 - t.centreT - k.expected.value)).toBeLessThan(1e-3);
    const u = entries.find((e) => e.oracleId === "feed-ut-triga-pulse-4p40-limits-temperature-limit-margin")!;
    expect(Math.abs(1150 + 273.15 - 1097.469086 - u.expected.value)).toBeLessThan(1e-3);
  });
  it("the GA-7882 entries are the report's printed numbers (kind published), and FEED's generator reproduces them within the entries' tolerances", () => {
    const hits = entries.filter((e) => GA.test(e.oracleId));
    expect(hits).toHaveLength(4);
    const published = { "3": { pmax: 2130, e: 26.1, rise: 262 }, "5": { pmax: 9210, e: 59.7, rise: 506 } } as Record<string, { pmax: number; e: number; rise: number }>;
    for (const e of hits) {
      expect(e.source.kind, e.oracleId).toBe("published");
      expect(e.source.text, e.oracleId).toContain("GA-7882");
      const row = published[GA.exec(e.oracleId)![1]!]!;
      const v = validateCase(caseOf(e));
      expect(v.errors, e.oracleId).toEqual([]);
      const g = v.normalized!.transient!.generated!.summary;
      expect(near(g.peakPower / 1e6, row.pmax, 0.005), e.oracleId + " peak power " + g.peakPower / 1e6).toBe(true);
      if (e.expected.quantity === "energy_deposited") {
        expect(e.expected.value, e.oracleId).toBeCloseTo((row.e * 1e6) / 720, 2);
        expect(Math.abs(g.energyPerLength / e.expected.value - 1), e.oracleId).toBeLessThanOrEqual(e.tolerance.rel);
      } else {
        expect(e.expected.value, e.oracleId).toBeCloseTo(298.15 + row.rise, 6);
        expect(Math.abs(g.finalFuelTemperature - e.expected.value), e.oracleId + " " + g.finalFuelTemperature).toBeLessThanOrEqual(e.tolerance.abs);
      }
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
  const wanted = (e: any) => NEW.test(e.oracleId) || MARGIN.test(e.oracleId) || GA.test(e.oracleId);
  const cases = [...new Set(entries.filter(wanted).map((e) => e.inputs[0].path))];
  for (const path of cases) {
    it(path + ": every check passes and the solver's peak and wall temperature are inside the entries' tolerances", async () => {
      const mine = entries.filter((e) => wanted(e) && e.inputs[0].path === path);
      const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-seedoracle-")), backend: new WslBackend(), timeoutMs: 280_000 });
      const s = mgr.start(caseOf(mine[0]));
      if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
      const rec = await mgr.done(s.id);
      const res = mgr.results(s.id) as ResultsRecord;
      expect(rec.state).toBe("completed");
      expect(res.checks.filter((c) => c.verdict !== "pass").map((c) => c.id + " value " + c.value + ": " + c.note)).toEqual([]);
      for (const e of mine) {
        const q = e.expected.quantity;
        const got = q === "energy_deposited" ? (res as any).series.deposited.at(-1) : q === "temperature_peak_max" ? res.summary.maxT : q === "temperature_limit_margin" ? res.checks.find((c) => c.id === "temperatureLimit1")!.value! : q === "temperature_peak" ? res.summary.maxT : res.summary.claddingOuterWallT!;
        expect(Math.abs(got - e.expected.value), e.oracleId + " solver " + got + " expected " + e.expected.value).toBeLessThanOrEqual(Math.max(e.tolerance.abs, e.tolerance.rel * Math.abs(e.expected.value)));
      }
    }, 300_000);
  }
});
