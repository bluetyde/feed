// Plan 16 through the real solver (needs FEED_SOLVER=1): the five sampled particles of the example population on 12 cells per region (the mesh of the other examples), where four of
// the five failed the run's own finite-volume cross-check before the interface allowance, and the thickest-buffer particle on 6, 24 and 96 cells. Every check of the run now passes,
// and the deviation from the finite volumes is what the estimate says (tests/trisoInterface.test.ts reads the saved output of the same runs without the solver). The band for
// measured / estimate and the factor on the bound are fixed there (0.97 to 1.09 and 0.75), before this file's first run.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { TrisoResultsRecord, trisoInterfaceAllowance } from "../src/core/trisoResults";
import { wedgeEquivalent } from "../src/core/trisoWriter";
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
const BAND: [number, number] = [0.97, 1.09];
const BOUND_FRACTION = 0.75;

async function run(role: string, cells: number) {
  const doc = JSON.parse(readFileSync(join(root, "oracles", "seed-triso", "models", `triso-pop-${role}.case.json`), "utf8"));
  doc.mesh = { kernelCells: cells, bufferCells: cells, ipycCells: cells, sicCells: cells, opycCells: cells };
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-iface-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(doc);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const res = mgr.results(s.id) as unknown as TrisoResultsRecord;
  const normalized = JSON.parse(readFileSync(join(runsRoot, s.id, "normalized.json"), "utf8"));
  return { res, normalized };
}
const failing = (r: TrisoResultsRecord) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 200));

describe.skipIf(!solverOn)("the interface allowance against the real solver (needs FEED_SOLVER=1)", () => {
  const cases: [string, number][] = [
    ["coldest", 12],
    ["hottest", 12],
    ["median", 12],
    ["thickest-buffer", 12],
    ["thinnest-sic", 12],
    ["thickest-buffer", 6],
    ["thickest-buffer", 24],
    ["thickest-buffer", 96],
  ];
  for (const [role, cells] of cases) {
    it(`${role} on ${cells} cells per region: every check passes, and the deviation is what the estimate says`, async () => {
      const { res, normalized } = await run(role, cells);
      expect(failing(res)).toEqual([]);
      const fv = res.checks.find((c) => c.id === "crossCheckFv")!;
      const est = trisoInterfaceAllowance(wedgeEquivalent(normalized)).total;
      console.log(role, cells, "crossCheckFv", fv.value, "estimate", est, "ratio", fv.value! / est);
      expect(fv.value! / est).toBeGreaterThan(BAND[0]);
      expect(fv.value! / est).toBeLessThan(BAND[1]);
      const bound = Number(/bound ([0-9.]+) K/.exec(fv.note)![1]);
      expect(fv.value! / bound).toBeLessThan(BOUND_FRACTION);
    }, 300_000);
  }
});
