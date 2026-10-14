// Plan 11 B3: the two example cases with a boundary history. Ungated: they validate cleanly (no warning about a change between outputs) and the independent solution shows the
// behaviour the description claims. Gated (FEED_SOLVER=1): they run through the real solver and every check passes.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { TransientResultsRecord, computeIndependent } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const read = (id: string) => JSON.parse(readFileSync(join(root, "examples", id + ".json"), "utf8"));
const IDS = ["ksu-triga-loss-of-pool", "synthetic-coastdown"];
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

describe("the boundary-history examples validate", () => {
  for (const id of IDS) {
    it(id + " is valid, labelled synthetic, says what is assumed, and has no warning", () => {
      const d = read(id);
      const v = validateCase(d);
      expect(v.errors).toEqual([]);
      expect(v.warnings.map((w) => w.code)).toEqual([]);
      expect(d.label).toBe("synthetic");
      expect(d.description).toMatch(/ASSUMED/);
      expect(d.transient.boundaryHistory.length).toBeGreaterThanOrEqual(4);
    });
  }
});

describe("what the independent solution shows (the claims in the descriptions)", () => {
  it("loss of the pool: the pin sits at the SAR's steady state until 10 s, then settles near 600 K and is still about 500 K at ten minutes, where the same scram with the pool kept is within a few kelvin of the pool by then", () => {
    const d = read("ksu-triga-loss-of-pool");
    const ind = computeIndependent(validateCase(d).normalized!);
    const peak = ind.fv.states.map((s) => Math.max(...s.T));
    const t = ind.fv.states.map((s) => s.time);
    const at = (time: number) => peak[t.findIndex((x) => Math.abs(x - time) < 1e-6)]!;
    // the steady 1.25 MW state of the film case is about 511 C (784 K); the history leaves it alone for 10 s
    expect(at(0)).toBeGreaterThan(780);
    expect(at(0)).toBeLessThan(790);
    expect(Math.abs(at(10) - at(0))).toBeLessThan(1);
    expect(at(50)).toBeGreaterThan(600);
    expect(at(50)).toBeLessThan(670);
    const final = peak[peak.length - 1]!;
    expect(final).toBeGreaterThan(480);
    expect(final).toBeLessThan(540);
    const kept = JSON.parse(JSON.stringify(d));
    kept.transient.boundaryHistory = kept.transient.boundaryHistory.map((p: any) => ({ ...p, heatTransferCoefficient: { value: 57735, unit: "W/m2/K" } }));
    const control = computeIndependent(validateCase(kept).normalized!).fv.states;
    const ctl = control.map((s) => Math.max(...s.T));
    expect(ctl[ctl.length - 1]!, "with the pool kept the pin is near the pool at the end").toBeLessThan(310);
    expect(ctl[ctl.findIndex((_, i) => control[i]!.time >= 59.9)]!, "and within 55 K of it after a minute").toBeLessThan(350);
    expect(final - ctl[ctl.length - 1]!, "the lost film leaves the pin about 200 K hotter").toBeGreaterThan(150);
  });

  it("coastdown: the peak falls with the scram and the pin ends warmer than a pin cooled by the original film", () => {
    const n = validateCase(read("synthetic-coastdown")).normalized!;
    const ind = computeIndependent(n);
    const peak = ind.fv.states.map((s) => Math.max(...s.T));
    expect(peak[peak.length - 1]!).toBeLessThan(peak[0]!);
    const c = read("synthetic-coastdown");
    c.transient.boundaryHistory = c.transient.boundaryHistory.map((p: any) => ({ ...p, bulkTemperature: { value: 300, unit: "K" }, heatTransferCoefficient: { value: 30000, unit: "W/m2/K" } }));
    const control = computeIndependent(validateCase(c).normalized!);
    const ctl = control.fv.states.map((s) => Math.max(...s.T));
    expect(peak[peak.length - 1]!, "the coolant is hotter and the film worse, so the end is warmer than with the original coolant").toBeGreaterThan(ctl[ctl.length - 1]! + 20);
  });
});

async function run(d: unknown) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-bex-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 580_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  return mgr.results(s.id) as unknown as TransientResultsRecord;
}
const failing = (r: TransientResultsRecord) => r.checks.filter((c) => c.verdict !== "pass").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 160));

describe.skipIf(!solverOn)("the boundary-history examples through the real solver (needs FEED_SOLVER=1)", () => {
  for (const id of IDS) {
    it(id + ": every check passes", async () => {
      const res = await run(read(id));
      expect(failing(res)).toEqual([]);
      expect(res.checks.some((c) => c.id === "crossCheckFv")).toBe(true);
    }, 600_000);
  }
});
