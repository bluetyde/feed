// The F0 failure probes replayed through the real run manager and the real solver. The manager always writes valid inputs, so a
// tampering backend breaks ONE thing in the written inputs just before the solver starts. Needs FEED_SOLVER=1 and the distro.
//   FEED_SOLVER=1 npm test

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const enabled = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

class TamperBackend extends WslBackend {
  constructor(private tamper: (inputsDir: string) => void) {
    super();
  }
  override run(args: { id: string; inputsDir: string; nativeDir: string; timeoutMs: number }) {
    this.tamper(args.inputsDir);
    return super.run(args);
  }
}
const edit = (dir: string, rel: string, fn: (t: string) => string) => {
  const p = join(dir, rel);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  if (after === before) throw new Error("tamper changed nothing in " + rel);
  writeFileSync(p, after);
};
const pin = () => JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));

async function runTampered(tamper: (dir: string) => void) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-fail-"));
  const mgr = new RunManager({ runsRoot, backend: new TamperBackend(tamper), timeoutMs: 180_000 });
  const s = mgr.start(pin());
  if (!s.ok) throw new Error("start refused");
  const rec = await mgr.done(s.id);
  const out = { rec, results: mgr.results(s.id), runsRoot, id: s.id };
  return out;
}

describe.skipIf(!enabled)("F0 failure probes through the real run manager", () => {
  it("mesh dictionary removed: failed, the mesh could not be built, native text kept", async () => {
    const { rec, results, runsRoot, id } = await runTampered((d) => rmSync(join(d, "system", "blockMeshDict")));
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_APP_FAILED");
    expect(rec.failure!.message).toMatch(/mesh could not be built/);
    expect(results).toBeUndefined();
    expect(existsSync(join(runsRoot, id, "results.json"))).toBe(false);
  }, 240_000);

  it("unknown heat-source type: failed with the solver's FOAM FATAL text", async () => {
    const { rec, results } = await runTampered((d) => edit(d, "constant/solverDict", (t) => t.replace("heatSource              constantLhgr;", "heatSource              noSuchHeatSource;")));
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_APP_FAILED");
    expect(rec.exitCode).toBe(1);
    expect(rec.failure!.native).toMatch(/FOAM FATAL/);
    expect(rec.failure!.native).toMatch(/noSuchHeatSource/);
    expect(results).toBeUndefined();
  }, 240_000);

  it("required entry deleted (lhgr): failed with a FOAM FATAL IO error that names the dictionary", async () => {
    const { rec, results } = await runTampered((d) => edit(d, "constant/solverDict", (t) => t.replace(/^\s*lhgr .*\n/m, "")));
    expect(rec.state).toBe("failed");
    expect(rec.failure!.native).toMatch(/FOAM FATAL IO ERROR/);
    expect(rec.failure!.native).toMatch(/lhgr/);
    expect(results).toBeUndefined();
  }, 240_000);

  it("heat source names a material that does not exist: failed, not completed", async () => {
    const { rec, results } = await runTampered((d) => edit(d, "constant/solverDict", (t) => t.replace("materials ( fuel );", "materials ( nosuchmaterial );")));
    expect(rec.state).toBe("failed");
    expect(rec.failure!.native).toMatch(/FOAM FATAL/);
    expect([1, 134]).toContain(rec.exitCode); // the F0 probe saw 134 (SIGABRT) after the error text
    expect(results).toBeUndefined();
  }, 240_000);

  it("absurd power (500 MW/m): not refused (the plan makes it a warning), completes, and the warning travels with the result", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-fail-"));
    const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 180_000 });
    const doc = pin();
    doc.power.linearHeatRate = { value: 5e8, unit: "W/m" };
    const s = mgr.start(doc);
    if (!s.ok) throw new Error("start refused");
    expect((await mgr.done(s.id)).state).toBe("completed");
    const d = mgr.detail(s.id)!;
    expect(d.results!.summary.centreCellT).toBeGreaterThan(1e6); // physically meaningless, and the result says what the number is
    expect(d.manifest.warnings.map((w: any) => w.code)).toContain("W_POWER_RANGE");
    // the wall-temperature check disagrees because the solver writes 8 significant digits; one failing check is enough to see it
    expect(d.results!.checks.some((c: { verdict: string }) => c.verdict === "fail")).toBe(true);
  }, 240_000);

  it("the manager stays usable after failures: the next valid run completes", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-fail-"));
    let n = 0;
    const mgr = new RunManager({ runsRoot, backend: new TamperBackend((d) => { if (n++ === 0) rmSync(join(d, "system", "blockMeshDict")); }), timeoutMs: 180_000 });
    const a = mgr.start(pin());
    const b = mgr.start(pin());
    if (!a.ok || !b.ok) throw new Error();
    expect((await mgr.done(a.id)).state).toBe("failed");
    expect((await mgr.done(b.id)).state).toBe("completed");
  }, 400_000);
});
