// Quadratic and tabulated heat capacity through the real solver, by FEED's own writer (needs FEED_SOLVER=1): a pulse on the synthetic pin whose fuel heat capacity is a
// quadratic (SiCSnead with par4 = 0) or a table, against the independent finite-volume solution, and the range verdict.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { TransientResultsRecord } from "../src/core/transientResults";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

const quadratic = (range: [number, number] = [250, 2500]) => ({ model: "polynomial", a: q(0.9e6, "J/m3/K"), b: q(4170, "J/m3/K2"), c: q(-1, "J/m3/K3"), validRange: { min: q(range[0], "K"), max: q(range[1], "K") }, source: "test" });
const TABLE = [[250, 1.9e6], [500, 2.9e6], [800, 4.0e6], [1200, 5.0e6], [1500, 5.4e6]] as const;
const table = { model: "table", points: TABLE.map(([T, c]) => ({ temperature: q(T, "K"), heatCapacity: q(c, "J/m3/K") })), fit: { degree: 2, tolerance: q(5, "%") }, source: "test" };

async function runPulse(fuelCp: unknown) {
  const d = read("examples/synthetic-pulse.json");
  d.materials.fuel.sets["thermal.volumetricHeatCapacity"] = fuelCp;
  const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-polycp-")), backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  return { rec, res: mgr.results(s.id) as TransientResultsRecord | undefined };
}
const allPass = (r: { checks: { verdict: string }[] }) => r.checks.every((c) => c.verdict === "pass");

describe.skipIf(!solverOn)("polynomial and tabulated heat capacity through the real solver (needs FEED_SOLVER=1)", () => {
  it("a quadratic fuel heat capacity: OFFBEAT (SiCSnead, par4 = 0) and the independent finite-volume solution agree, every check passes, in-domain", async () => {
    const { rec, res } = await runPulse(quadratic());
    expect(rec.state, JSON.stringify(rec).slice(0, 1500)).toBe("completed");
    expect(allPass(res!)).toBe(true);
    expect(res!.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("pass");
    expect(res!.domain.verdict).toBe("in-domain");
    expect(res!.checks.find((c) => c.id === "heatCapacityFitFuel")).toBeUndefined(); // only a table has one
  }, 300_000);

  it("a table: it runs as its fitted quadratic, every check passes, and the result carries the fit's deviation", async () => {
    const { rec, res } = await runPulse(table);
    expect(rec.state, JSON.stringify(rec).slice(0, 1500)).toBe("completed");
    expect(allPass(res!)).toBe(true);
    const fit = res!.checks.find((c) => c.id === "heatCapacityFitFuel")!;
    expect(fit.verdict).toBe("pass");
    expect(fit.value!).toBeGreaterThan(0);
    expect(fit.value!).toBeLessThan(0.05);
    expect(fit.note).toMatch(/OFFBEAT has no tabulated heat capacity/);
    expect(res!.domain.verdict).toBe("in-domain");
  }, 300_000);

  it("a quadratic used outside its stated range is out-of-domain, and the check says so", async () => {
    const { rec, res } = await runPulse(quadratic([250, 400]));
    expect(rec.state, JSON.stringify(rec).slice(0, 1500)).toBe("completed");
    expect(res!.domain.verdict).toBe("out-of-domain");
    expect(res!.checks.find((c) => c.id === "propertyRange")!.verdict).toBe("fail");
  }, 300_000);
});
