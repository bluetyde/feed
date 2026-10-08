// The burnup-dependent fuel through the real solver, by FEED's own writer (not an edited input, unlike tests/burnupProbe.test.ts), needs FEED_SOLVER=1:
// FEED's case with `uo2-nfi` and a burnup is run through the run manager (every check passes, the closed form of the burnup law included), and its files are run once more
// so that OFFBEAT's own conductivity field `k` can be compared cell by cell with FEED's law at OFFBEAT's own temperatures (docs/plans/10-burnup.md M2).
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { ResultsRecord } from "../src/core/resultsParser";
import { RunManager } from "../src/core/runManager";
import { nfiConductivity } from "../src/core/uo2Nfi";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";
import { cells, runProbe } from "./helpers/mechanicsProbe";

const root = join(__dirname, "..");
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();
const q = (value: number, unit: string) => ({ value, unit });
const doc = (B: number, extra: Record<string, unknown> = {}) => {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
  d.mesh = { fuelCells: 100, claddingCells: 20 };
  d.power.linearHeatRate = q(20, "kW/m");
  d.materials.fuel.sets["thermal.conductivity"] = { model: "uo2-nfi", densityFraction: q(0.95, "1"), source: "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11", ...extra };
  d.burnup = { value: q(B, "MWd/kgHM"), basis: "heavy-metal", source: "chosen for the study" };
  return d;
};
async function run(d: unknown) {
  const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-nfi-")), backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  return { rec, res: mgr.results(s.id) as ResultsRecord };
}

describe.skipIf(!solverOn)("the burnup-dependent fuel conductivity through the real solver (needs FEED_SOLVER=1)", () => {
  for (const B of [0, 40, 62]) {
    it(`at ${B} MWd/kgHM: the run completes, every check passes (the closed form of the law included) and the fuel is in-domain`, async () => {
      const { rec, res } = await run(doc(B));
      expect(rec.state).toBe("completed");
      expect(res.checks.every((c) => c.verdict === "pass"), JSON.stringify(res.checks.filter((c) => c.verdict !== "pass"))).toBe(true);
      expect(res.domain.verdict).toBe("in-domain");
      expect(res.checks.find((c) => c.id === "closedFormFuel")!.value!).toBeLessThan(1.5);
      // the run script copies OFFBEAT's k and Bu out, so the two burnup checks are in the result and pass (a result without the fields would fail them)
      expect(res.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["burnupConductivity", "burnupWritten"]));
      expect(res.checks.find((c) => c.id === "burnupConductivity")!.value!).toBeLessThan(1e-5);
      expect(res.thermalOnly).toMatch(/Frozen-burnup snapshot/);
    }, 300_000);
  }

  it("OFFBEAT's own conductivity field equals FEED's law at OFFBEAT's own temperatures, in every fuel cell, at 40 MWd/kgHM with gadolinia", async () => {
    const d = doc(40, { gadolinia: q(0.05, "1") });
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    const r = await runProbe(writeOffbeatCase(v.normalized!).files, 280);
    expect(r.exit.offbeatExit === 0 || r.exit.offbeatExit === 139).toBe(true);
    const T = cells(r, "T").map((x) => x[0]!);
    const k = cells(r, "k").map((x) => x[0]!);
    const Bu = cells(r, "Bu").map((x) => x[0]!);
    for (let i = 0; i < 100; i++) {
      expect(Math.abs(Bu[i]! / 35240 - 1), "Bu " + i).toBeLessThan(1e-6);
      expect(Math.abs(k[i]! / nfiConductivity(T[i]!, { burnup: 40, densityFraction: 0.95, gadolinia: 0.05 }) - 1), "k, cell " + i).toBeLessThan(1e-5);
    }
  }, 300_000);
});
