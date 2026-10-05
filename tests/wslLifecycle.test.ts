// Real-solver tests for the Codex findings on cancel coverage (#3), pid ownership (#10), shell-free invocation (#6) and
// leftover run directories (#12). Needs FEED_SOLVER=1 and the feed-solver distro.
//   FEED_SOLVER=1 npm test

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { RunManager } from "../src/core/runManager";
import { validateCase } from "../src/core/validate";
import { WslBackend, toWslPath } from "../src/core/wslBackend";

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
/** Run a bash snippet in the distro as user feed, without a shell between Node and bash. */
const sh = (script: string, ...args: string[]) => execFileSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", "-c", script, "_", ...args], { encoding: "utf8" });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait (inside the distro) until a process named `comm` has this run's directory as its working directory. Asynchronous on
 * purpose: the run manager lives in this same Node process, and a synchronous wait would block it from ever starting the run.
 */
const waitForPhase = async (comm: string, id: string, seconds = 40): Promise<string> => {
  const script = 'for i in $(seq 1 $(( $3 * 20 ))); do for p in $(pgrep -x "$1"); do if readlink /proc/$p/cwd 2>/dev/null | grep -q "feed-$2"; then echo found; exit 0; fi; done; sleep 0.05; done; echo timeout';
  const { stdout } = await promisify(execFile)("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", "-c", script, "_", comm, id, String(seconds)], { encoding: "utf8" });
  return stdout.trim();
};
const survivors = (id: string) => sh('for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null; done | grep -c "feed-$1" || true', id).trim();

describe.skipIf(!enabled)("WSL lifecycle (needs FEED_SOLVER=1 and the feed-solver distro)", () => {
  for (const phase of ["blockMesh", "offbeat"]) {
    it("S1 cancel while " + phase + " is actually running stops that process and everything it started", async () => {
      const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-life-")), backend: new WslBackend(), timeoutMs: 240_000 });
      const s = mgr.start(pin((d) => ((d.mesh.fuelCells = 20000), (d.mesh.claddingCells = 10000))));
      if (!s.ok) throw new Error("start refused");
      expect(await waitForPhase(phase, s.id)).toBe("found"); // the phase's own process exists right now
      // the phase's process (and the timeout wrapper) are in the SCRIPT's process group, so signalling the group reaches them;
      // plain `timeout` would put its child in a group of its own
      const groups = sh('pid=$(cut -d" " -f1 "$HOME/runs/feed-$1/run.pid"); for p in $(pgrep -x "$2"); do if readlink /proc/$p/cwd 2>/dev/null | grep -q "feed-$1"; then echo "$(ps -o pgid= -p $p | tr -d " ") $pid"; fi; done', s.id, phase).trim().split(/\r?\n/);
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) {
        const [pgid, scriptPid] = g.split(" ");
        expect(pgid).toBe(scriptPid);
      }
      // the pid file names the script and its start time
      expect(sh('cat "$HOME/runs/feed-$1/run.pid" 2>/dev/null || true', s.id).trim()).toMatch(/^\d+ \d+$/);
      await mgr.cancel(s.id);
      const rec = await mgr.done(s.id);
      expect(rec.state).toBe("cancelled");
      await wait(2500);
      expect(survivors(s.id)).toBe("0"); // blockMesh/offbeat and the timeout wrapper are all gone
      expect(sh('ps -eo args | grep -E "timeout.*(blockMesh|offbeat)" | grep -v grep | grep -c "feed-$1" || true', s.id).trim()).toBe("0");
      expect(sh('test -e "$HOME/runs/feed-$1" && echo present || echo absent', s.id).trim()).toBe("absent");
    }, 300_000);
  }

  it("#6 --exec keeps a hostile path literal", () => {
    const hostile = "/mnt/c/x/O'Brien $HOME `id` \"q\" a b";
    expect(sh('printf %s "$1"', hostile)).toBe(hostile);
  });

  it("#12 a completed run leaves no directory behind in the distro", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-life-")), backend: new WslBackend(), timeoutMs: 180_000 });
    const s = mgr.start(pin());
    if (!s.ok) throw new Error("start refused");
    expect((await mgr.done(s.id)).state).toBe("completed");
    expect(sh('test -e "$HOME/runs/feed-$1" && echo present || echo absent', s.id).trim()).toBe("absent");
  }, 240_000);

  it("#3 cancel before the solver starts (mesh generation) cancels the run and no solver process remains", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-life-")), backend: new WslBackend(), timeoutMs: 240_000 });
    const s = mgr.start(pin((d) => ((d.mesh.fuelCells = 20000), (d.mesh.claddingCells = 9000))));
    if (!s.ok) throw new Error("start refused");
    await wait(300); // the script is at its start or in blockMesh: no solver and no old-style pid file yet
    await mgr.cancel(s.id);
    const rec = await mgr.done(s.id);
    expect(rec.state).toBe("cancelled");
    expect(rec.failure!.code).toBe("E_CANCELLED");
    expect(mgr.results(s.id)).toBeUndefined();
    await wait(3000);
    // nothing of this run may still be running or start later (the old script launched OFFBEAT after a cancel during meshing)
    expect(sh('ps -eo args | grep -E "run-feed.sh|offbeat|blockMesh" | grep -v grep | grep -c "$1" || true', s.id).trim()).toBe("0");
    // and no process anywhere has this run's directory as its working directory (blockMesh and offbeat run there);
    // other tests may be running their own solvers at the same time, so this must not look at process names alone
    expect(sh('for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null; done | grep -c "feed-$1" || true', s.id).trim()).toBe("0");
    expect(sh('test -e "$HOME/runs/feed-$1" && echo present || echo absent', s.id).trim()).toBe("absent");
  }, 300_000);

  it("#3 a cancel flag set before the script starts stops it before meshing", () => {
    const n = validateCase(pin()).normalized!;
    const dir = mkdtempSync(join(tmpdir(), "feed-flag-"));
    const inputs = join(dir, "inputs");
    const native = join(dir, "native");
    for (const [rel, text] of Object.entries(writeOffbeatCase(n).files)) {
      mkdirSync(dirname(join(inputs, rel)), { recursive: true });
      writeFileSync(join(inputs, rel), text);
    }
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "cancel.flag"), "cancelled\n");
    const id = "f1a9f1a9f1a9";
    execFileSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", toWslPath(join(root, "solver", "run-feed.sh")), toWslPath(inputs), toWslPath(native), id, "60"], { encoding: "utf8" });
    expect(existsSync(join(native, "log.blockMesh"))).toBe(false); // meshing never started
    expect(existsSync(join(native, "log.offbeat"))).toBe(false);
    expect(sh('test -e "$HOME/runs/feed-$1" && echo present || echo absent', id).trim()).toBe("absent");
  }, 120_000);

  it("#10 cancel never signals a process that is not this run's script, even if a pid file names it", () => {
    const id = "a1b2c3d4e5f6";
    const out = sh(
      'RUN="$HOME/runs/feed-$1"; mkdir -p "$RUN"; setsid sleep 120 </dev/null >/dev/null 2>&1 & p=$!; echo "$p" > "$RUN/run.pid"; ' +
        'bash "$2" "$1"; code=$?; if kill -0 "$p" 2>/dev/null; then alive=yes; else alive=no; fi; kill -KILL -- "-$p" 2>/dev/null; rm -rf "$RUN"; echo "cancel-exit=$code sleep-alive=$alive"',
      id,
      toWslPath(join(root, "solver", "cancel-feed.sh")),
    );
    expect(out).toMatch(/sleep-alive=yes/); // the unrelated process survived
    expect(out).toMatch(/cancel-exit=[1-9]/); // and cancel reported that it did not signal anything
  }, 60_000);

  it("#10 a stale pid file is removed when the run ends", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-life-")), backend: new WslBackend(), timeoutMs: 180_000 });
    const s = mgr.start(pin());
    if (!s.ok) throw new Error("start refused");
    await mgr.done(s.id);
    expect(sh('ls "$HOME/runs/feed-$1/run.pid" 2>/dev/null | wc -l', s.id).trim()).toBe("0");
  }, 240_000);
});

describe.skipIf(!enabled)("WSL lifecycle: process ownership (re-review)", () => {
  const startTimeOf = 'sed "s/^.*) //" /proc/$1/stat | cut -d" " -f20';
  it("S-sec2 a process whose command line merely contains 'run-feed.sh' and the id is refused", () => {
    const id = "012345abcdef";
    const out = sh(
      'RUN="$HOME/runs/feed-$1"; mkdir -p "$RUN"; ' +
        'setsid python3 -c "import time; time.sleep(120)" "--source=run-feed.sh" "--label=$1-old" </dev/null >/dev/null 2>&1 & p=$!; sleep 0.3; ' +
        'st=$(sed "s/^.*) //" /proc/$p/stat | cut -d" " -f20); echo "$p $st" > "$RUN/run.pid"; ' +
        'bash "$2" "$1"; code=$?; if kill -0 "$p" 2>/dev/null; then alive=yes; else alive=no; fi; kill -KILL -- "-$p" 2>/dev/null; rm -rf "$RUN"; echo "cancel-exit=$code alive=$alive"',
      id,
      toWslPath(join(root, "solver", "cancel-feed.sh")),
    );
    expect(out).toMatch(/alive=yes/);
    expect(out).toMatch(/cancel-exit=1/);
  }, 60000);

  it("S-sec2 a pid file whose start time does not match the process (pid reuse) is refused", () => {
    const id = "abcabcabcabc";
    const out = sh(
      'RUN="$HOME/runs/feed-$1"; mkdir -p "$RUN"; setsid sleep 120 </dev/null >/dev/null 2>&1 & p=$!; sleep 0.2; ' +
        'echo "$p 1" > "$RUN/run.pid"; bash "$2" "$1"; code=$?; if kill -0 "$p" 2>/dev/null; then alive=yes; else alive=no; fi; kill -KILL -- "-$p" 2>/dev/null; rm -rf "$RUN"; echo "cancel-exit=$code alive=$alive"',
      id,
      toWslPath(join(root, "solver", "cancel-feed.sh")),
    );
    expect(out).toMatch(/alive=yes/);
    expect(out).toMatch(/cancel-exit=1/);
    void startTimeOf;
  }, 60000);
});
