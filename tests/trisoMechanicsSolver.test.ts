// Plan 14, stage E (M2/M3) through the real solver (needs FEED_SOLVER=1): a particle's mechanics written by FEED's writer (the coating shells on a thin wedge, the temperatures of the
// closed form, the gas pressure and the stated free strains), run by the run manager, read back and judged against the independent layered-sphere solution. The saved output
// (FEED_SAVE_GOLDEN=1) is read again, without the solver, by tests/trisoMechanicsResults.test.ts.
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import type { TrisoMechanicsResultsRecord } from "../src/core/trisoMechanicsResults";
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
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "offbeat-triso-mech") : undefined;
const vector = (name: string) => JSON.parse(readFileSync(join(root, "schema", "vectors", "good", name + ".json"), "utf8"));

async function run(d: unknown, save?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-trisomech-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const dir = join(runsRoot, s.id);
  const native = join(dir, "native", "final");
  const res = mgr.results(s.id) as unknown as TrisoMechanicsResultsRecord;
  if (save) {
    mkdirSync(save, { recursive: true });
    for (const f of ["T", "C", "cellZones", "D", "sigma", "epsilonSwelling"]) if (existsSync(join(native, f))) copyFileSync(join(native, f), join(save, f));
    copyFileSync(join(dir, "normalized.json"), join(save, "normalized.json"));
    writeFileSync(join(save, "results.json"), JSON.stringify(res, null, 2) + "\n");
    writeFileSync(join(save, "log.offbeat.txt"), readFileSync(join(dir, "native", "log.offbeat"), "utf8"));
    writeFileSync(join(save, "run.json"), JSON.stringify({ time: res.time, exitCode: rec.exitCode }, null, 2) + "\n");
  }
  return { res, rec };
}
const failing = (r: TrisoMechanicsResultsRecord) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 300));
const show = (name: string, r: TrisoMechanicsResultsRecord) => console.log(name, r.checks.map((c) => c.id + "=" + (c.value === null ? "n/a" : Number(c.value.toPrecision(3)))).join(" "), "sic peak", r.summary.sicPeakTangential);

describe.skipIf(!solverOn)("a particle's mechanics through the real solver (needs FEED_SOLVER=1)", () => {
  for (const [name, note] of [
    ["triso-mechanics-ipyc", "the inner carbon alone under 25 MPa inside and 0.1 MPa outside (the analogue of benchmark case 2)"],
    ["triso-mechanics-pressure", "the carbon and the SiC under the same pressures (the analogue of case 3)"],
    ["triso-mechanics-swelling", "the carbon with an isotropic free strain of -0.015 against the SiC (the analogue of case 4a)"],
    ["triso-mechanics-anisotropic", "three layers, anisotropic free strains in the inner carbon and an isotropic one in the outer, 10 MPa inside, thermal strain from 300 K"],
    ["triso-mechanics-thermal", "a poorly conducting coating with a drop of about a hundred kelvin, no pressure: a thermal stress only"],
    ["triso-mechanics-library", "the library's PARFUME sets, a free strain in the inner carbon"],
  ] as const) {
    it(name + ": " + note + " (every check passes)", async () => {
      const { res, rec } = await run(vector(name), GOLDEN ? join(GOLDEN, name.replace("triso-mechanics-", "")) : undefined);
      show(name, res);
      expect(failing(res)).toEqual([]);
      expect(rec.exitCode === 0 || rec.exitCode === 139).toBe(true);
      expect(res.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["mechanicsTemperature", "mechanicsStress", "mechanicsDisplacement", "mechanicsEquilibrium", "mechanicsInterface", "mechanicsSymmetry"]));
    }, 300_000);
  }
});
