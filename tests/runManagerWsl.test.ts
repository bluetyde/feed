// The run manager driving the real solver in the feed-solver distro. Runs only with FEED_SOLVER=1 (see solverEndToEnd.test.ts).
//   FEED_SOLVER=1 npm test

import type { ResultsRecord } from "../src/core/resultsParser";
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
// Processes of ONE run: working directory in the run's folder (offbeat, blockMesh; also after the folder is removed) or its run-feed.sh.
// Other runs' solvers (other tests, other jobs on the machine) are not counted; this shell and its parent are skipped.
const RUN_PROCS = [
  'for p in /proc/[0-9]*; do p=${p#/proc/}; [ "$p" = "$$" ] || [ "$p" = "$PPID" ] && continue',
  'c=$(readlink /proc/$p/cwd 2>/dev/null); a=$(cat /proc/$p/cmdline 2>/dev/null | tr -c "[:print:]" " ")',
  'case "$c" in */runs/feed-$1|*/runs/feed-$1/*|*/runs/feed-$1" (deleted)") echo "$p cwd $c: $a";; esac',
  'case "$a" in *run-feed.sh*" $1 "*) echo "$p script: $a";; esac; done; true',
].join("\n");
const runProcesses = (id: string): string[] =>
  execFileSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", "-c", RUN_PROCS, "_", id], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.trim() !== "");
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
    const res = mgr.results(s.id)! as ResultsRecord;
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
    const res = mgr.results(s.id)! as ResultsRecord;
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
    const res = mgr.results(s.id)! as ResultsRecord;
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
    const res = mgr.results(s.id)! as ResultsRecord;
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
    const s = mgr.start(pin((d) => ((d.mesh.fuelCells = 20000), (d.mesh.claddingCells = 9000))));
    if (!s.ok) throw new Error("start refused");
    await new Promise((r) => setTimeout(r, 4000));
    await mgr.cancel(s.id);
    const rec = await mgr.done(s.id);
    expect(["cancelled", "completed"]).toContain(rec.state); // completed only if the machine was faster than 4 s
    if (rec.state === "cancelled") {
      expect(rec.failure!.code).toBe("E_CANCELLED");
      expect(mgr.results(s.id)).toBeUndefined();
    }
    // No process of THIS run is left (other runs' offbeats are not counted). The cancel script already waits for the group and
    // sweeps the folder, so anything left is a real leftover; poll up to 10 s and fail with the list.
    let left = runProcesses(s.id);
    for (let i = 0; i < 20 && left.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      left = runProcesses(s.id);
    }
    expect(left).toEqual([]);
  }, 300_000);

  it("the per-run process counter counts a live process of that run and none of another run's (negative control)", () => {
    const id = "abcdef012345";
    const other = "fedcba543210";
    // one distro call: the sleepers die when the call that started them returns. The counter runs as a child shell, so it skips this shell ($PPID).
    const script =
      'mkdir -p "$HOME/runs/feed-$1" "$HOME/runs/feed-$2"; for i in $1 $2; do (cd "$HOME/runs/feed-$i" && exec setsid sleep 120) </dev/null >/dev/null 2>&1 & done; sleep 0.5; ' +
      'for x in $1 $2 000000000000; do echo "[$x]"; bash -c "$3" _ $x; done; ' +
      'for i in $1 $2; do for p in /proc/[0-9]*; do p=${p#/proc/}; case "$(readlink /proc/$p/cwd 2>/dev/null)" in */runs/feed-$i) kill -KILL $p;; esac; done; rm -rf "$HOME/runs/feed-$i"; done; true';
    const out = execFileSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", "-c", script, "_", id, other, RUN_PROCS], { encoding: "utf8" });
    const lines = (id: string) => {
      const at = out.indexOf(`[${id}]`);
      const next = out.indexOf("\n[", at + 1);
      return out.slice(at + id.length + 3, next < 0 ? undefined : next).split("\n").filter((l) => l.trim() !== "");
    };
    expect(lines(id), out).toHaveLength(1); // exactly the sleeper in this run's folder
    expect(lines(id)[0]).toContain("cwd");
    expect(lines(other), out).toHaveLength(1); // the other run's sleeper, counted only for the other run
    expect(lines("000000000000")).toEqual([]);
    expect(runProcesses(id)).toEqual([]); // and it is gone afterwards
  }, 60_000);
});
