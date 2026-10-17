// Plan 13 T6 through the real solver (needs FEED_SOLVER=1): five particles of the example population (examples/synthetic-triso-population.json, 2000 particles, seed 20261016) -- the
// hottest, the median, the coldest, the one with the thickest buffer and the one with the thinnest SiC -- are written out as cases (particleDocument), run by FEED's run manager through
// the real OFFBEAT, and compared with the closed form of the particle that was drawn. This is the check that FEED's independent solution, which the whole population is run through,
// holds across the spread. FEED_SAVE_GOLDEN=1 saves the output in tests/golden/offbeat-triso-pop/<role>/, which tests/trisoPopulationGolden.test.ts reads again without the solver.
//
// Tolerances, fixed before the first run (the plan's own figures for a particle, docs/triso.md):
//   - the kernel centre against the closed form of the SAMPLED particle (the number the population reported): 0.6 % of the particle's rise above the matrix. The wedge the mesh solves
//     is a sphere 0.03 % smaller in every radius (0.03 to 0.06 % of the rise), and the centre is extrapolated from the first cell of a 12-cell kernel (0.12 K of 49 K on the T3 runs):
//     the plan's 0.5 % plus the wedge's 0.1 %.
//   - every region's face-to-face drop against the closed form of the wedge's sphere: 0.2 K (T3: 0.15 K on 12 cells).
//   - the spread: OFFBEAT's hottest minus coldest kernel centre against the population's, within 1 % of it.
//   - every check the run itself makes (closed form per region, finite-volume cross-check, energy balance, gap, wall, steadiness) passes.
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { lastRelativeRate } from "../src/core/steadyState";
import { TrisoResultsRecord } from "../src/core/trisoResults";
import { RepresentativeRole, particleDocument, particleOf, runPopulation } from "../src/core/trisoPopulation";
import { trisoClosedForm } from "../src/core/trisoSolve";
import { wedgeEquivalent } from "../src/core/trisoWriter";
import { validateCase } from "../src/core/validate";
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
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "offbeat-triso-pop") : undefined;
const ROLES: RepresentativeRole[] = ["hottest", "median", "coldest", "thickestBuffer", "thinnestSic"];
const CENTRE_FRACTION = 0.006;
const FACE_TOLERANCE = 0.2;
const SPREAD_FRACTION = 0.01;

async function run(d: unknown, save?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-pop-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const dir = join(runsRoot, s.id);
  const native = join(dir, "native", "final");
  const res = mgr.results(s.id) as unknown as TrisoResultsRecord;
  const log = readFileSync(join(dir, "native", "log.offbeat"), "utf8");
  if (save) {
    mkdirSync(save, { recursive: true });
    for (const f of ["T", "C", "cellZones"]) copyFileSync(join(native, f), join(save, f));
    copyFileSync(join(dir, "normalized.json"), join(save, "normalized.json"));
    writeFileSync(join(save, "results.json"), JSON.stringify(res, null, 2) + "\n");
    writeFileSync(join(save, "rate.json"), JSON.stringify({ relativeRate: lastRelativeRate(log), time: res.time, steps: (log.match(/^Time = /gm) ?? []).length, exitCode: rec.exitCode }, null, 2) + "\n");
  }
  return { res, normalized: JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8")), rec };
}
const failing = (r: TrisoResultsRecord) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 200));

describe.skipIf(!solverOn)("the sampled particles of a population through the real solver (needs FEED_SOLVER=1)", () => {
  it("the hottest, median, coldest, thickest-buffer and thinnest-SiC particles of the example population: every check passes and the closed form of each drawn particle holds", async () => {
    const doc = JSON.parse(readFileSync(join(root, "examples", "synthetic-triso-population.json"), "utf8"));
    const n = validateCase(doc).triso!;
    const pop = runPopulation(n);
    const centres: Record<string, number> = {};
    const closed: Record<string, number> = {};
    const failed: string[] = [];
    for (const role of ROLES) {
      const rep = pop.representatives.find((r) => r.role === role)!;
      const { res, normalized } = await run(particleDocument(doc, n, rep.draw), GOLDEN ? join(GOLDEN, role) : undefined);
      if (GOLDEN) writeFileSync(join(GOLDEN, role, "meta.json"), JSON.stringify({ role, index: rep.index, kernelPeakT: rep.kernelPeakT, particlePower: rep.particlePower, draw: rep.draw }, null, 2) + "\n");
      console.log(role, "index", rep.index, "closed form", rep.kernelPeakT.toFixed(3), "OFFBEAT", res.summary.kernelCentreT.toFixed(3), "checks", res.checks.map((c) => c.id + "=" + (c.value === null ? "n/a" : Number(c.value.toPrecision(3)))).join(" "));
      failed.push(...failing(res).map((f) => role + ": " + f));
      const sampled = particleOf(n, rep.draw);
      const rise = rep.kernelPeakT - rep.draw.matrixTemperature;
      expect(rise).toBeGreaterThan(10);
      // the particle the run solved is the sampled one
      expect(normalized.kernelRadius).toBeCloseTo(sampled.kernelRadius, 12);
      expect(normalized.outerRadius).toBeCloseTo(sampled.outerRadius, 12);
      // the population's number for the particle (the closed form of the nominal sphere) against the real solver's kernel centre
      expect(Math.abs(res.summary.kernelCentreT - rep.kernelPeakT), role).toBeLessThan(CENTRE_FRACTION * rise);
      // every region's drop against the closed form of the wedge's sphere
      const cf = trisoClosedForm(wedgeEquivalent(normalized));
      cf.regions.forEach((g, i) => expect(Math.abs(res.regions[i]!.drop - (g.innerT - g.outerT)), role + " " + g.name).toBeLessThan(FACE_TOLERANCE));
      centres[role] = res.summary.kernelCentreT;
      closed[role] = rep.kernelPeakT;
    }
    expect(failed).toEqual([]);
    // across the spread: the real solver sees the same ordering and the same width
    expect(centres.hottest!).toBeGreaterThan(centres.median!);
    expect(centres.median!).toBeGreaterThan(centres.coldest!);
    const span = closed.hottest! - closed.coldest!;
    expect(span).toBeGreaterThan(60);
    expect(Math.abs(centres.hottest! - centres.coldest! - span)).toBeLessThan(SPREAD_FRACTION * span);
  }, 1_800_000);
});
