// The run manager driving the real solver in the feed-solver distro. Runs only with FEED_SOLVER=1 (see solverEndToEnd.test.ts).
//   FEED_SOLVER=1 npm test

import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { refinementStudy, studyCases } from "../src/core/refinement";
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
const pin = (mutate?: (d: any) => void) => {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
  mutate?.(d);
  return d;
};
const offbeatRunning = (id: string) => {
  const out = execFileSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--", "bash", "-c", `pgrep -f 'feed-${id}' | wc -l; ls /home/feed/runs/feed-${id} >/dev/null 2>&1 && echo present`], { encoding: "utf8" });
  return Number(out.split("\n")[0]);
};

describe.skipIf(!enabled)("run manager + real solver (needs FEED_SOLVER=1 and the feed-solver distro)", () => {
  it("completes the synthetic pin, accepts the exit-139 shutdown, and the checks pass", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-wsl-")), backend: new WslBackend(), timeoutMs: 180_000 });
    const s = mgr.start(pin());
    if (!s.ok) throw new Error("start refused");
    const rec = await mgr.done(s.id);
    expect(rec.failure).toBeUndefined();
    expect(rec.state).toBe("completed");
    const res = mgr.results(s.id)!;
    expect(res.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    expect(res.checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("pass");
    expect(res.summary.centreCellT).toBeGreaterThan(1300);
    expect(res.summary.centreCellT).toBeLessThan(1310);
  }, 240_000);

  it("runs a temperature-dependent fuel conductivity and every check passes, including the property range", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-wsl-")), backend: new WslBackend(), timeoutMs: 180_000 });
    const doc = JSON.parse(readFileSync(join(root, "schema", "vectors", "good", "linear-conductivity.json"), "utf8"));
    const s = mgr.start(doc);
    if (!s.ok) throw new Error("start refused");
    const rec = await mgr.done(s.id);
    expect(rec.failure).toBeUndefined();
    expect(rec.state).toBe("completed");
    const res = mgr.results(s.id)!;
    expect(res.checks.map((c) => c.id)).toContain("propertyRange");
    expect(res.checks.filter((c) => c.verdict !== "pass")).toEqual([]);
    expect(res.domain.verdict).toBe("in-domain");
    // oracle: conductivity-integral solution gives 1246.8586 K on the axis; the first cell centre is 0.14 mm off it
    expect(res.summary.centreCellT).toBeGreaterThan(1244);
    expect(res.summary.centreCellT).toBeLessThan(1247);
  }, 240_000);

  it("runs a temperature-dependent cladding conductivity and every check passes", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-wsl-")), backend: new WslBackend(), timeoutMs: 180_000 });
    const doc = pin((d) => (d.materials.cladding.sets["thermal.conductivity"] = { model: "linear", a: { value: 10, unit: "W/m/K" }, b: { value: 0.016333, unit: "W/m/K2" }, validRange: { min: { value: 300, unit: "K" }, max: { value: 800, unit: "K" } }, source: "test: fit to an SS304 table" }));
    const s = mgr.start(doc);
    if (!s.ok) throw new Error("start refused");
    expect((await mgr.done(s.id)).state).toBe("completed");
    const res = mgr.results(s.id)!;
    expect(res.checks.filter((c) => c.verdict !== "pass")).toEqual([]);
    expect(Math.abs(res.checks.find((c) => c.id === "energyBalance")!.value!)).toBeLessThan(1e-3);
  }, 240_000);

  it("a result outside the conductivity law's stated range is flagged out-of-domain by the real run", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-wsl-")), backend: new WslBackend(), timeoutMs: 180_000 });
    const doc = JSON.parse(readFileSync(join(root, "schema", "vectors", "good", "linear-conductivity.json"), "utf8"));
    doc.materials.fuel.sets["thermal.conductivity"].validRange.max = { value: 1000, unit: "K" };
    const s = mgr.start(doc);
    if (!s.ok) throw new Error("start refused");
    expect((await mgr.done(s.id)).state).toBe("completed");
    const res = mgr.results(s.id)!;
    expect(res.domain.verdict).toBe("out-of-domain");
    expect(res.checks.find((c) => c.id === "propertyRange")!.verdict).toBe("fail");
  }, 240_000);

  it("refinement study: three real runs show close to second-order convergence", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-wsl-")), backend: new WslBackend(), timeoutMs: 180_000 });
    const base = pin((d) => (d.mesh = { fuelCells: 10, claddingCells: 3 }));
    const ids = studyCases(base).map((d) => {
      const s = mgr.start(d);
      if (!s.ok) throw new Error("start refused");
      return s.id;
    });
    for (const id of ids) expect((await mgr.done(id)).state).toBe("completed");
    const details = ids.map((id) => mgr.detail(id)!);
    const study = refinementStudy(details.map((d) => ({ id: d.record.id, normalized: d.normalized, results: d.results! }))) as any;
    expect(study.verdict).toBe("pass");
    expect(study.levels.map((l: any) => l.fuelCells)).toEqual([10, 20, 40]);
    expect(study.levels[2].fuelError).toBeLessThan(study.levels[0].fuelError / 5);
  }, 400_000);

  it("cancels a long run and leaves no solver process of that run behind", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-wsl-")), backend: new WslBackend(), timeoutMs: 240_000 });
    // a mesh large enough that blockMesh + the solve take several seconds
    const s = mgr.start(pin((d) => ((d.mesh.fuelCells = 30000), (d.mesh.claddingCells = 9000))));
    if (!s.ok) throw new Error("start refused");
    await new Promise((r) => setTimeout(r, 4000));
    await mgr.cancel(s.id);
    const rec = await mgr.done(s.id);
    expect(["cancelled", "completed"]).toContain(rec.state); // completed only if the machine was faster than 4 s
    if (rec.state === "cancelled") {
      expect(rec.failure!.code).toBe("E_CANCELLED");
      expect(mgr.results(s.id)).toBeUndefined();
    }
    await new Promise((r) => setTimeout(r, 1500));
    // no offbeat process for this run id
    const procs = execFileSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--", "bash", "-c", `ps -eo args | grep -c "[o]ffbeat" || true`], { encoding: "utf8" });
    expect(Number(procs.trim())).toBe(0);
  }, 300_000);
});
