// Plan 13 T3 through the real solver (needs FEED_SOLVER=1): a particle written by FEED's writer (a 2 degree double wedge), run by the run manager, read back and judged against the closed
// form of the sphere the wedge solves and FEED's own finite-volume solution. The saved output (FEED_SAVE_GOLDEN=1) is read again, without the solver, by tests/trisoResults.test.ts.
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { lastRelativeRate } from "../src/core/steadyState";
import { RunManager } from "../src/core/runManager";
import { TrisoResultsRecord } from "../src/core/trisoResults";
import { trisoClosedForm } from "../src/core/trisoSolve";
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
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "offbeat-triso") : undefined;
const vector = (name: string) => JSON.parse(readFileSync(join(root, "schema", "vectors", "good", name + ".json"), "utf8"));

async function run(d: unknown, save?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-triso-run-"));
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
    // the real log of one run (145 kB) is kept for the run manager's tests; the others keep the rate they ended on
    if (save.endsWith("steady")) writeFileSync(join(save, "log.offbeat.txt"), log);
    writeFileSync(join(save, "results.json"), JSON.stringify(res, null, 2) + "\n");
    writeFileSync(join(save, "rate.json"), JSON.stringify({ relativeRate: lastRelativeRate(log), time: res.time, steps: (log.match(/^Time = /gm) ?? []).length, exitCode: rec.exitCode }, null, 2) + "\n");
  }
  const normalized = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
  return { res, normalized, rec, log };
}
const failing = (r: TrisoResultsRecord) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 200));
const show = (name: string, r: TrisoResultsRecord) => console.log(name, r.checks.map((c) => c.id + "=" + (c.value === null ? "n/a" : Number(c.value.toPrecision(3)))).join(" "), "centre", r.summary.kernelCentreT.toFixed(3));

/** The probe's particle: 3000 MW/m3 in the kernel (the tutorial's 3e9), a 1298 K wall: a 48 K rise. */
const intense = () => {
  const d = vector("triso-steady");
  d.power = { kernelPowerDensity: q(3000, "MW/m3") };
  d.boundary = { surfaceTemperature: q(1298, "K") };
  return d;
};

describe.skipIf(!solverOn)("a coated particle through the real solver (needs FEED_SOLVER=1)", () => {
  it("the vector as it is (a 10 K rise, a prescribed wall): every check passes", async () => {
    const { res, rec } = await run(vector("triso-steady"), GOLDEN ? join(GOLDEN, "steady") : undefined);
    show("steady", res);
    expect(failing(res)).toEqual([]);
    expect(rec.exitCode === 0 || rec.exitCode === 139).toBe(true);
    expect(res.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["closedFormKernel", "closedFormBuffer", "closedFormIpyc", "closedFormSic", "closedFormOpyc", "crossCheckFv", "energyBalance", "gapDrop", "wallTemperature", "steadyState"]));
  }, 300_000);

  it("a 49 K rise with a prescribed wall (the probe's particle): the kernel centre is the closed form of the nominal sphere to 0.5 % of the rise", async () => {
    const { res, normalized } = await run(intense(), GOLDEN ? join(GOLDEN, "intense") : undefined);
    show("intense", res);
    expect(failing(res)).toEqual([]);
    const nominal = trisoClosedForm(normalized);
    const rise = nominal.centreT - nominal.wallT;
    expect(rise).toBeGreaterThan(40);
    // the plan's own figure, 0.5 % of the rise: the wedge is the sphere with its radii 0.03 % smaller (the rises 0.03 to 0.06 % smaller), and the centre is extrapolated from a 12-cell kernel's first cell (0.12 K low)
    expect(Math.abs(res.summary.kernelCentreT - nominal.centreT)).toBeLessThan(0.005 * rise);
    // the gap's drop, from the patch values, to 1 %
    expect(Math.abs(res.summary.gapDeltaT / nominal.gapDeltaT - 1)).toBeLessThan(0.01);
  }, 300_000);

  it("a film outside (2000 W/m2/K at 900 K), 3000 MW/m3: the long run settles it, every check passes", async () => {
    const d = vector("triso-convective-outside");
    d.power = { kernelPowerDensity: q(3000, "MW/m3") };
    const { res, normalized } = await run(d, GOLDEN ? join(GOLDEN, "film") : undefined);
    show("film", res);
    expect(failing(res)).toEqual([]);
    const nominal = trisoClosedForm(normalized);
    expect(nominal.filmDeltaT).toBeGreaterThan(30);
    expect(Math.abs(res.summary.wallT - nominal.wallT)).toBeLessThan(0.05);
  }, 300_000);

  it("a two-layer particle (a buffer and an inner carbon only)", async () => {
    const d = vector("triso-two-layers");
    d.power = { kernelPowerDensity: q(3000, "MW/m3") };
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "two-layers") : undefined);
    show("two-layers", res);
    expect(failing(res)).toEqual([]);
    expect(res.regions.map((r) => r.name)).toEqual(["kernel", "buffer", "ipyc"]);
  }, 300_000);

  it("conductivities that depend on temperature (linear, linear, reciprocal)", async () => {
    const { res } = await run(vector("triso-temperature-dependent"), GOLDEN ? join(GOLDEN, "temperature-dependent") : undefined);
    show("temperature-dependent", res);
    expect(failing(res)).toEqual([]);
    expect(res.checks.find((c) => c.id === "propertyRange")!.verdict).toBe("pass");
  }, 300_000);

  it("a fine mesh (48 cells in every region): the cells agree with the closed form of the wedge's sphere to a few hundredths of a kelvin", async () => {
    const d = intense();
    d.mesh = { kernelCells: 48, bufferCells: 48, ipycCells: 48, sicCells: 48, opycCells: 48 };
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "fine") : undefined);
    show("fine", res);
    expect(failing(res)).toEqual([]);
    for (const id of ["closedFormKernel", "closedFormBuffer", "closedFormIpyc", "closedFormSic", "closedFormOpyc"]) expect(res.checks.find((c) => c.id === id)!.value!, id).toBeLessThan(0.05);
  }, 300_000);
});
