// Plan 12 A9 and plan 13 T7 through the real solver (needs FEED_SOLVER=1): the four new example cases in examples/ are run exactly as the editor runs them (RunManager, the real OFFBEAT in
// the feed-solver distro) and EVERY check must pass. FEED_SAVE_GOLDEN=1 saves the solver's output in tests/golden/examples/<id>/, which tests/exampleGolden.test.ts reads again without
// the solver. FEED_EXAMPLE_REPORT=<file> writes every check of every run (id, verdict, value, note) as JSON, for the record in docs/examples.
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { lastRelativeRate } from "../src/core/steadyState";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "examples") : undefined;
const REPORT = process.env.FEED_EXAMPLE_REPORT;
const example = (id: string) => JSON.parse(readFileSync(join(root, "examples", id + ".json"), "utf8"));
const report: Record<string, unknown> = {};

interface Check { id: string; verdict: string; value: number | null; note: string }
async function run(id: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-example-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 580_000 });
  const s = mgr.start(example(id));
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const dir = join(runsRoot, s.id);
  const native = join(dir, "native");
  const res = mgr.results(s.id) as unknown as { checks: Check[]; time?: number; [k: string]: any };
  const normalized = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
  if (GOLDEN) {
    const save = join(GOLDEN, id);
    mkdirSync(save, { recursive: true });
    copyFileSync(join(dir, "normalized.json"), join(save, "normalized.json"));
    copyFileSync(join(native, "final", "C"), join(save, "C"));
    if (existsSync(join(native, "final", "cellZones"))) copyFileSync(join(native, "final", "cellZones"), join(save, "cellZones"));
    if (normalized.transient) {
      const tdir = join(native, "times");
      for (const n of readdirSync(tdir).filter((x) => /^[0-9.eE+-]+$/.test(x))) {
        mkdirSync(join(save, "times", n), { recursive: true });
        copyFileSync(join(tdir, n, "T"), join(save, "times", n, "T"));
      }
    } else {
      copyFileSync(join(native, "final", "T"), join(save, "T"));
      const log = readFileSync(join(native, "log.offbeat"), "utf8");
      writeFileSync(join(save, "rate.json"), JSON.stringify({ relativeRate: lastRelativeRate(log), time: res.time, exitCode: rec.exitCode }, null, 2) + "\n");
    }
    writeFileSync(join(save, "results.json"), JSON.stringify(res, null, 2) + "\n");
  }
  report[id] = { checks: res.checks.map((c) => ({ id: c.id, verdict: c.verdict, value: c.value, note: c.note })), summary: res.summary, axial: res.axial ? { hottest: res.axial.hottest, allowance: res.axial.allowance, slices: res.axial.slices?.map((x: any) => ({ index: x.index, height: x.height, linearHeatRate: x.linearHeatRate, centreCellT: x.centreCellT, maxT: x.maxT, peakT: x.peakT?.[x.peakT.length - 1] })) } : undefined };
  if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 2) + "\n");
  return { res, normalized };
}
/** Every check must pass or be informational; a check that did not run at all is not a pass either. */
const notPassing = (r: { checks: Check[] }) => r.checks.filter((c) => c.verdict !== "pass" && c.verdict !== "na").map((c) => c.id + " " + c.verdict + " " + c.value + ": " + c.note.slice(0, 240));
const passing = (r: { checks: Check[] }) => r.checks.filter((c) => c.verdict === "pass").length;

describe.skipIf(!solverOn)("the A9 and T7 example cases through the real solver (needs FEED_SOLVER=1)", () => {
  it("ksu-triga-cosine-stack: every check passes, the SAR limits hold in every slice", async () => {
    const { res } = await run("ksu-triga-cosine-stack");
    expect(notPassing(res)).toEqual([]);
    expect(passing(res)).toBeGreaterThanOrEqual(8);
    expect(res.axial.slices).toHaveLength(10);
    expect(res.checks.filter((c) => /^temperatureLimit/.test(c.id))).toHaveLength(2);
  }, 600_000);

  it("synthetic-plate-loss-of-cooling: every check passes", async () => {
    const { res } = await run("synthetic-plate-loss-of-cooling");
    expect(notPassing(res)).toEqual([]);
    expect(passing(res)).toBe(4);
    expect(res.axial.slices).toHaveLength(10);
  }, 900_000);

  it("synthetic-triso-compact-steady: every check passes", async () => {
    const { res } = await run("synthetic-triso-compact-steady");
    expect(notPassing(res)).toEqual([]);
    expect(passing(res)).toBeGreaterThanOrEqual(8);
  }, 600_000);

  it("synthetic-triso-compact-pulse: every check passes, the five limits hold", async () => {
    const { res } = await run("synthetic-triso-compact-pulse");
    expect(notPassing(res)).toEqual([]);
    expect(res.checks.filter((c) => /^temperatureLimit/.test(c.id))).toHaveLength(5);
  }, 600_000);
});
