// The reciprocal conductivity k = a / T + b through the real solver, by FEED's own writer (needs FEED_SOLVER=1): OFFBEAT's SiCPARFUME model on the steady pin against
// the closed form, with b = 0 written as a zero (the model's own default is 2), and a reciprocal cladding.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { ResultsRecord } from "../src/core/resultsParser";
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
const recip = (a: number, b: number, lo = 300, hi = 2000) => ({ model: "reciprocal", a: q(a, "W/m"), b: q(b, "W/m/K"), validRange: { min: q(lo, "K"), max: q(hi, "K") }, source: "synthetic: chosen for the closed-form oracle" });
const doc = (region: "fuel" | "cladding", set: unknown) => {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
  d.mesh = { fuelCells: 40, claddingCells: 12 };
  d.materials[region].sets["thermal.conductivity"] = set;
  return d;
};
async function run(d: unknown) {
  const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-recipk-")), backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  return { rec, res: mgr.results(s.id) as ResultsRecord };
}
const allPass = (r: { checks: { verdict: string }[] }) => r.checks.every((c) => c.verdict === "pass");

describe.skipIf(!solverOn)("the reciprocal conductivity through the real solver (needs FEED_SOLVER=1)", () => {
  it("a reciprocal fuel on the steady pin: every check passes (the closed form of a / T + b included) and the fuel is in-domain", async () => {
    const { rec, res } = await run(doc("fuel", recip(6000, 3)));
    expect(rec.state).toBe("completed");
    expect(allPass(res)).toBe(true);
    expect(res.domain.verdict).toBe("in-domain");
    expect(res.checks.find((c) => c.id === "closedFormFuel")!.value!).toBeLessThan(1.5);
    // the centre of the same pin with a constant k of 3 W/m/K is 1308 K; this fuel conducts 8 to 11 W/m/K, so it runs well below that (936.5 K observed)
    expect(res.summary.maxT).toBeGreaterThan(900);
    expect(res.summary.maxT).toBeLessThan(1000);
  }, 300_000);

  it("b = 0 is written as 0 and not left to the model's default of 2: the closed form still holds (it would miss by the difference)", async () => {
    const { rec, res } = await run(doc("fuel", recip(6000, 0)));
    expect(rec.state).toBe("completed");
    expect(allPass(res)).toBe(true);
    expect(res.checks.find((c) => c.id === "closedFormFuel")!.value!).toBeLessThan(1.5);
  }, 300_000);

  it("a reciprocal cladding", async () => {
    const { rec, res } = await run(doc("cladding", recip(9000, 5, 300, 900)));
    expect(rec.state).toBe("completed");
    expect(allPass(res)).toBe(true);
    expect(res.checks.find((c) => c.id === "closedFormCladding")?.verdict ?? "pass").toBe("pass");
  }, 300_000);
});
