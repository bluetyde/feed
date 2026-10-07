// Temperature limits through the real solver (needs FEED_SOLVER=1): the two TRIGA examples with the SAR's limits, and a limit set so low that the run fails it.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ResultsRecord } from "../src/core/resultsParser";
import { RunManager } from "../src/core/runManager";
import { TransientResultsRecord } from "../src/core/transientResults";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();
async function runCase(doc: unknown) {
  const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-limits-")), backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(doc);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  return { rec, res: mgr.results(s.id) as ResultsRecord | TransientResultsRecord | undefined };
}
const limitChecks = (r: { checks: { id: string }[] }) => r.checks.filter((c) => /^temperatureLimit/.test(c.id)) as { id: string; verdict: string; value: number | null; note: string }[];

describe.skipIf(!solverOn)("temperature limits through the real solver (needs FEED_SOLVER=1)", () => {
  it("the K-State hot element at 1.25 MW is far inside the 1150 C rule, the 950 C rule is not in force (cladding stays near 45 C), every other check passes", async () => {
    const { rec, res } = await runCase(read("examples/ksu-triga-1p25mw-film-limits.json"));
    expect(rec.state).toBe("completed");
    const [a, b] = limitChecks(res!);
    expect(a).toMatchObject({ id: "temperatureLimit1", verdict: "pass" });
    expect(a!.value!).toBeGreaterThan(500);
    expect(b).toMatchObject({ id: "temperatureLimit2", verdict: "pass", value: null });
    expect(res!.checks.every((c) => c.verdict === "pass")).toBe(true);
  }, 300_000);

  it("the UT-Austin pulse stays under the 1150 C rule with a margin of a few hundred kelvin, decided from every step of the independent solution", async () => {
    const { rec, res } = await runCase(read("examples/ut-triga-pulse-4p40-limits.json"));
    expect(rec.state).toBe("completed");
    const [a, b] = limitChecks(res!);
    expect(a!.verdict).toBe("pass");
    expect(a!.value!).toBeGreaterThan(200);
    expect(a!.value!).toBeLessThan(450);
    expect(b).toMatchObject({ verdict: "pass", value: null });
    expect(res!.checks.every((c) => c.verdict === "pass")).toBe(true);
  }, 300_000);

  it("a limit under the pulse's peak is a failed check on a completed run, with a negative margin", async () => {
    const d = read("examples/ut-triga-pulse-4p40-limits.json");
    d.limits = [{ name: "too low", region: "fuel", maxTemperature: { value: 600, unit: "degC" }, source: "test" }];
    const { rec, res } = await runCase(d);
    expect(rec.state).toBe("completed");
    const [a] = limitChecks(res!);
    expect(a!.verdict).toBe("fail");
    expect(a!.value!).toBeLessThan(0);
    expect(res!.checks.filter((c) => c.verdict !== "pass").map((c) => c.id)).toEqual(["temperatureLimit1"]);
  }, 300_000);
});
