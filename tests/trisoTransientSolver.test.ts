// Plan 13 T3 stage 3 through the real solver (needs FEED_SOLVER=1): a particle's transient written by FEED (a power table in the kernel, heat capacities, a start, an outside that may move),
// run by the run manager, read back at every output and judged against FEED's own finite-volume solution of the sphere the wedge solves. The saved output (FEED_SAVE_GOLDEN=1) is read
// again, without the solver, by tests/trisoTransientResults.test.ts.
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { TrisoTransientResultsRecord } from "../src/core/trisoTransientResults";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "offbeat-triso-transient") : undefined;
const vector = (name: string) => JSON.parse(readFileSync(join(root, "schema", "vectors", "good", name + ".json"), "utf8"));

async function run(d: unknown, save?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-trisot-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const dir = join(runsRoot, s.id);
  const native = join(dir, "native");
  const res = mgr.results(s.id) as unknown as TrisoTransientResultsRecord;
  const normalized = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
  if (save) {
    mkdirSync(save, { recursive: true });
    for (const f of ["C", "cellZones"]) copyFileSync(join(native, "final", f), join(save, f));
    copyFileSync(join(dir, "normalized.json"), join(save, "normalized.json"));
    writeFileSync(join(save, "results.json"), JSON.stringify(res, null, 2) + "\n");
    for (const t of readdirSync(join(native, "times"))) {
      mkdirSync(join(save, "times", t), { recursive: true });
      copyFileSync(join(native, "times", t, "T"), join(save, "times", t, "T"));
    }
  }
  return { res, normalized, rec };
}
const failing = (r: TrisoTransientResultsRecord) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 200));
const show = (name: string, r: TrisoTransientResultsRecord) => console.log(name, r.checks.map((c) => c.id + "=" + (c.value === null ? "n/a" : Number(c.value.toPrecision(3)))).join(" "), "max", r.summary.maxT.toFixed(3), "at", r.summary.timeOfMaxT);

describe.skipIf(!solverOn)("a coated particle's transient through the real solver (needs FEED_SOLVER=1)", () => {
  it("a 10 ms pulse into a particle at 1000 K, the wall held: every check passes; the cells agree with the independent solution to 0.014 K and the peak is the hottest cell of the kernel", async () => {
    const { res, rec } = await run(vector("triso-pulse"), GOLDEN ? join(GOLDEN, "pulse") : undefined);
    show("pulse", res);
    expect(failing(res)).toEqual([]);
    expect(rec.exitCode === 0 || rec.exitCode === 139).toBe(true);
    expect(res.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["energyBalance", "crossCheckFv", "timeStep", "wallTemperature"]));
    // 4 mJ made (the table's integral), and it has all left by the end; the peak is at the end of the pulse, in the kernel
    expect(res.series.deposited[res.series.deposited.length - 1]).toBeCloseTo(4e-3, 12);
    expect(res.summary.timeOfMaxT).toBeCloseTo(0.02, 9);
    expect(res.series.regionMax.kernel![res.series.peakT.indexOf(res.summary.maxT)]).toBe(res.summary.maxT);
    expect(res.summary.maxRise).toBeGreaterThan(10);
    expect(res.summary.finalPeakT - 1000).toBeLessThan(0.01);
  }, 300_000);

  it("the loss of the outside's cooling: the film's bulk temperature rises 100 K from a steady start at 0.2 W; every check passes", async () => {
    const { res } = await run(vector("triso-outside-ramp"), GOLDEN ? join(GOLDEN, "outside-ramp") : undefined);
    show("outside-ramp", res);
    expect(failing(res)).toEqual([]);
    expect(res.initialState.kind).toBe("steady");
    expect(res.summary.finalPeakT).toBeGreaterThan(res.initialTemperature + 50);
  }, 300_000);

  it("the wall dropped 100 K in 50 ms (a quench) from a steady start: every check passes and the wall follows the table at every output", async () => {
    const { res } = await run(vector("triso-wall-quench"), GOLDEN ? join(GOLDEN, "wall-quench") : undefined);
    show("wall-quench", res);
    expect(failing(res)).toEqual([]);
    expect(res.checks.find((c) => c.id === "wallTemperature")!.value!).toBeLessThan(1e-6);
    expect(res.series.wallT[res.series.wallT.length - 1]).toBeCloseTo(900, 6);
    expect(res.summary.finalPeakT).toBeLessThan(res.initialTemperature - 50);
  }, 300_000);

  it("temperature-dependent conductivity and heat capacity (linear, linear, reciprocal; linear and quadratic capacities), a pulse with a film", async () => {
    const d = vector("triso-pulse");
    const range = { min: q(600, "K"), max: q(2000, "K") };
    d.caseId = "triso-pulse-laws";
    d.boundary = { bulkTemperature: q(900, "K"), heatTransferCoefficient: q(2000, "W/m2/K") };
    d.transient.initialTemperature = q(950, "K");
    d.materials.kernel.sets["thermal.conductivity"] = { model: "linear", a: q(3.5, "W/m/K"), b: q(-0.0008, "W/m/K2"), validRange: range, source: "synthetic: a test" };
    d.materials.sic.sets["thermal.conductivity"] = { model: "reciprocal", a: q(17885, "W/m"), b: q(2, "W/m/K"), validRange: range, source: "synthetic: a test" };
    d.materials.kernel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: q(2.4, "MJ/m3/K"), b: q(0.0006, "MJ/m3/K2"), validRange: range, source: "synthetic: a test" };
    d.materials.buffer.sets["thermal.volumetricHeatCapacity"] = { model: "polynomial", a: q(1.0, "MJ/m3/K"), b: q(0.0005, "MJ/m3/K2"), c: q(-1e-7, "MJ/m3/K3"), validRange: range, source: "synthetic: a test" };
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "laws") : undefined);
    show("laws", res);
    expect(failing(res)).toEqual([]);
    expect(res.checks.find((c) => c.id === "propertyRange")!.verdict).toBe("pass");
  }, 300_000);

  it("a limit on the kernel in the pulse: the margin is decided by the independent solution's steps or the outputs, and a limit under the peak fails on a completed run", async () => {
    const { res } = await run(vector("triso-pulse-limits"));
    show("pulse-limits", res);
    expect(failing(res)).toEqual([]);
    const lim = res.checks.find((c) => c.id === "temperatureLimit1")!;
    expect(lim.value!).toBeGreaterThan(80);
    expect(lim.value!).toBeLessThan(84);
    const d = vector("triso-pulse-limits");
    d.limits[0].maxTemperature = q(1010, "K");
    const r2 = await run(d);
    const l2 = r2.res.checks.find((c) => c.id === "temperatureLimit1")!;
    expect(l2.verdict).toBe("fail");
    expect(l2.value!).toBeLessThan(-5);
    expect(failing(r2.res)).toEqual([expect.stringContaining("temperatureLimit1")]);
  }, 300_000);

  it("a time step that does not resolve the pulse (5 ms, four steps up the ramp): the time-step check fails and says to shorten it, while the cells still agree with the independent solution of the same step", async () => {
    const d = vector("triso-pulse");
    d.caseId = "triso-pulse-coarse";
    d.transient.timeStep = q(5, "ms");
    d.transient.outputs = 20;
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "coarse-step") : undefined);
    show("coarse-step", res);
    const ts = res.checks.find((c) => c.id === "timeStep")!;
    expect(ts.verdict).toBe("fail");
    expect(ts.note).toContain("shorten the time step");
    expect(res.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("pass");
  }, 300_000);
});
