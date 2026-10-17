// Plan 13 T4 through the real solver (needs FEED_SOLVER=1): a compact (a pin whose fuel is the homogenised mix), a pebble (a sphere of a fuelled zone and a shell) and the hottest
// particle of the compact (a coated particle behind its matrix shell) are run exactly as the editor runs them (RunManager, the real OFFBEAT in the feed-solver distro) and every
// check must pass. FEED_SAVE_GOLDEN=1 saves the solver's output in tests/golden/offbeat-compact, offbeat-pebble and offbeat-two-scale, which tests/compactPebble.test.ts reads
// again without the solver.
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { twoScaleCase } from "../src/core/compact";
import { RunManager } from "../src/core/runManager";
import { lastRelativeRate } from "../src/core/steadyState";
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
const SAVE = process.env.FEED_SAVE_GOLDEN === "1";
const example = (id: string) => JSON.parse(readFileSync(join(root, "examples", id + ".json"), "utf8"));

interface Check { id: string; verdict: string; value: number | null; note: string }
async function run(doc: unknown, saveAs?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-t4-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 580_000 });
  const s = mgr.start(doc);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const dir = join(runsRoot, s.id);
  const native = join(dir, "native");
  const res = mgr.results(s.id) as unknown as { checks: Check[]; time: number; [k: string]: any };
  if (SAVE && saveAs) {
    const save = join(root, "tests", "golden", saveAs);
    mkdirSync(save, { recursive: true });
    copyFileSync(join(dir, "normalized.json"), join(save, "normalized.json"));
    copyFileSync(join(native, "final", "C"), join(save, "C"));
    copyFileSync(join(native, "final", "T"), join(save, "T"));
    if (existsSync(join(native, "final", "cellZones"))) copyFileSync(join(native, "final", "cellZones"), join(save, "cellZones"));
    const log = readFileSync(join(native, "log.offbeat"), "utf8");
    writeFileSync(join(save, "rate.json"), JSON.stringify({ relativeRate: lastRelativeRate(log), time: res.time, exitCode: rec.exitCode }, null, 2) + "\n");
    writeFileSync(join(save, "results.json"), JSON.stringify(res, null, 2) + "\n");
  }
  return res;
}
const notPassing = (r: { checks: Check[] }) => r.checks.filter((c) => c.verdict !== "pass" && c.verdict !== "na").map((c) => c.id + " " + c.verdict + " " + c.value + ": " + c.note.slice(0, 240));

describe.skipIf(!solverOn)("compact, pebble and the hottest particle through the real solver (needs FEED_SOLVER=1)", () => {
  it("the compact: every check passes, the two-scale result is there", async () => {
    const res = await run(example("synthetic-compact-steady"), "offbeat-compact");
    expect(notPassing(res)).toEqual([]);
    expect(res.compact.twoScale.map((e: any) => e.at)).toEqual(["hottest", "mean"]);
    expect(res.checks.some((c) => c.id === "conductivityFitFuel")).toBe(true);
  }, 600_000);

  it("the pebble: every check passes, the two-scale result is there", async () => {
    const res = await run(example("synthetic-pebble-steady"), "offbeat-pebble");
    expect(notPassing(res)).toEqual([]);
    expect(res.kind).toBe("pebble");
    expect(res.checks.some((c) => c.id === "conductivityFitFuelled")).toBe(true);
  }, 600_000);

  it("the compact's hottest particle (matrix shell as a film) through the real solver: the kernel's centre agrees with the two-scale closed form", async () => {
    const doc = example("synthetic-compact-steady");
    const v = validateCase(doc);
    expect(v.ok).toBe(true);
    const spec = v.normalized!.compact!;
    const matrixT = 905.8720321992823; // the compact's centre by the closed form (see the test of the compact's record)
    const { n } = twoScaleCase(spec, matrixT);
    const particle = example("synthetic-triso-compact-steady");
    particle.caseId = "two-scale-hottest-particle";
    particle.power = { particlePower: { value: spec.particlePower, unit: "W" } };
    particle.boundary = { bulkTemperature: { value: matrixT, unit: "K" }, heatTransferCoefficient: { value: (n.boundary as { heatTransferCoefficient: number }).heatTransferCoefficient, unit: "W/m2/K" } };
    const res = await run(particle, "offbeat-two-scale");
    expect(notPassing(res)).toEqual([]);
  }, 600_000);
});
