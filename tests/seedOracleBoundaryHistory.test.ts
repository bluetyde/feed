// Plan 11 B5: the oracle entries for a coolant side that changes with time (feed-synthetic-lumped-*). The expected values come from an RK4 lumped solution written in the generator
// (nothing of src/core); here they are checked against FEED's independent finite-volume solution of the full pin (a second method), and with FEED_SOLVER=1 against the real solver.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { computeIndependent, TransientResultsRecord } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const dir = join(__dirname, "..", "oracles", "seed");
const entries = readdirSync(join(dir, "entries")).map((f) => JSON.parse(readFileSync(join(dir, "entries", f), "utf8")));
const caseOf = (e: any) => JSON.parse(readFileSync(join(dir, e.inputs[0].path), "utf8"));
const lumped = entries.filter((e) => /^feed-synthetic-lumped-.*-temperature-peak-max$/.test(e.oracleId));
const bad = entries.filter((e) => /^feed-bad-boundary-history-/.test(e.oracleId));

describe("the boundary-history oracle entries", () => {
  it("there are three lumped peak entries, one energy entry and five refusals", () => {
    expect(lumped).toHaveLength(3);
    expect(entries.filter((e) => e.oracleId === "feed-synthetic-lumped-film-step-energy-deposited")).toHaveLength(1);
    expect(bad).toHaveLength(5);
  });
  it("each lumped case is valid, has a history, and the tolerance is 1 % of a rise of at least 20 K", () => {
    for (const e of lumped) {
      const v = validateCase(caseOf(e));
      expect(v.errors, e.oracleId).toEqual([]);
      expect(v.normalized!.transient!.boundaryHistory, e.oracleId).toBeDefined();
      expect(e.tolerance.abs, e.oracleId).toBeGreaterThan(0.2);
      expect(e.tolerance.abs, e.oracleId).toBeLessThan(5);
    }
  });
  it("FEED's independent solution of the full pin agrees with the lumped value inside the entry's tolerance, and the history matters (the same case with the first boundary held is far away)", () => {
    for (const e of lumped) {
      const d = caseOf(e);
      const ind = computeIndependent(validateCase(d).normalized!);
      const peak = Math.max(...ind.fv.states.map((s) => Math.max(...s.T)));
      expect(Math.abs(peak - e.expected.value), e.oracleId + " " + peak).toBeLessThanOrEqual(e.tolerance.abs);
      const held = JSON.parse(JSON.stringify(d));
      held.transient.boundaryHistory = held.transient.boundaryHistory.map((p: any) => ({ ...p, bulkTemperature: held.transient.boundaryHistory[0].bulkTemperature, heatTransferCoefficient: held.transient.boundaryHistory[0].heatTransferCoefficient }));
      const hp = Math.max(...computeIndependent(validateCase(held).normalized!).fv.states.map((s) => Math.max(...s.T)));
      expect(Math.abs(hp - e.expected.value), e.oracleId + " held " + hp).toBeGreaterThan(5 * e.tolerance.abs);
    }
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

describe.skipIf(!solverOn)("the lumped entries against the real solver (needs FEED_SOLVER=1)", () => {
  for (const e of lumped) {
    it(e.oracleId + ": every check passes and the solver's largest peak is inside the entry's tolerance", async () => {
      const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-seedtvb-")), backend: new WslBackend(), timeoutMs: 280_000 });
      const s = mgr.start(caseOf(e));
      if (!s.ok) throw new Error(JSON.stringify(s));
      const rec = await mgr.done(s.id);
      expect(rec.state).toBe("completed");
      const res = mgr.results(s.id) as unknown as TransientResultsRecord;
      expect(res.checks.filter((c) => c.verdict !== "pass").map((c) => c.id + ": " + c.note.slice(0, 120))).toEqual([]);
      const peak = Math.max(...res.series.peakT);
      expect(Math.abs(peak - e.expected.value), e.oracleId + " " + peak).toBeLessThanOrEqual(e.tolerance.abs);
    }, 300_000);
  }
});
