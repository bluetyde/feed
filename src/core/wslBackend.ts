// Backend that runs the solver in the feed-solver WSL distro. Explicit argument lists only, and `--exec` so that no Linux shell
// sits between Node and bash (with `--`, wsl.exe re-parses the command line in the default shell, which breaks or interprets
// paths containing quotes, dollar signs or backticks). Run ids are generated hex; directories come from the manager.

import { execFile, spawn, ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { BackendOutcome, RunBackend } from "./runManager";
import { projectRoot } from "./validate";

export const DISTRO = "feed-solver";
export const DISTRO_USER = "feed";

export const toWslPath = (p: string): string => {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) throw new Error("expected an absolute Windows path, got " + p);
  return "/mnt/" + m[1]!.toLowerCase() + "/" + m[2]!.replace(/\\/g, "/");
};

/** Arguments for wsl.exe to run the run script: bash is started directly (--exec), each argument one element. */
export const runArgs = (script: string, inputsDir: string, nativeDir: string, id: string, timeoutSec: number): string[] => [
  "-d", DISTRO, "-u", DISTRO_USER, "--exec", "bash", toWslPath(script), toWslPath(inputsDir), toWslPath(nativeDir), id, String(timeoutSec),
];
/** Arguments for wsl.exe to run the cancel script. */
export const cancelArgs = (script: string, id: string): string[] => ["-d", DISTRO, "-u", DISTRO_USER, "--exec", "bash", toWslPath(script), id];

/** True when WSL is present and the feed-solver distro is registered. */
export function solverAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("wsl.exe", ["-l", "-q"], { encoding: "utf16le", timeout: 10_000 }, (err, stdout) => {
      resolve(!err && String(stdout).split(/\r?\n/).some((l) => l.trim() === DISTRO));
    });
  });
}

export class WslBackend implements RunBackend {
  private children = new Map<string, ChildProcess>();
  private nativeDirs = new Map<string, string>();
  private cancelled = new Set<string>();
  private scripts = join(projectRoot(), "solver");

  run({ id, inputsDir, nativeDir, timeoutMs }: { id: string; inputsDir: string; nativeDir: string; timeoutMs: number }): Promise<BackendOutcome> {
    return new Promise((resolve, reject) => {
      const timeoutSec = Math.max(5, Math.floor(timeoutMs / 1000) - 5);
      this.nativeDirs.set(id, nativeDir);
      // a cancel that arrived before the script started is already recorded as a flag file; the script checks it before each phase
      const child = spawn("wsl.exe", runArgs(join(this.scripts, "run-feed.sh"), inputsDir, nativeDir, id, timeoutSec), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      this.children.set(id, child);
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.stdout?.on("data", () => undefined);
      child.on("error", (e) => {
        this.children.delete(id);
        this.nativeDirs.delete(id);
        reject(e);
      });
      child.on("close", (code) => {
        this.children.delete(id);
        this.nativeDirs.delete(id);
        // a cancel can come from another process (the headless runner's cancel verb): it leaves the flag file behind
        const wasCancelled = this.cancelled.delete(id) || existsSync(join(nativeDir, "cancel.flag"));
        if (code !== 0 && !wasCancelled) reject(new Error(`run script exited ${code}: ${stderr.trim().slice(0, 300)}`));
        else resolve({ cancelled: wasCancelled });
      });
    });
  }

  /** Cancel a run started by another process: the headless runner's `cancel` verb knows the run's native folder from disk. */
  async cancelAt(id: string, nativeDir: string): Promise<void> {
    this.nativeDirs.set(id, nativeDir);
    try {
      await this.cancel(id);
    } finally {
      this.nativeDirs.delete(id);
      this.cancelled.delete(id);
    }
  }

  /**
   * Stop that run. First a flag file in its native directory (so the script stops before its next phase even if no process exists
   * yet), then the cancel script, which signals the run's own process group after checking the pid still is that run's script.
   * Rejects when the script could not confirm the stop, so the manager can say so.
   */
  async cancel(id: string): Promise<void> {
    this.cancelled.add(id);
    // The flag is written first so that a script with no process to signal yet stops before its next phase. If it cannot be
    // written (disk, permissions), the cancel script still runs: signalling the process group does not need the flag.
    let flagError: string | undefined;
    const native = this.nativeDirs.get(id);
    if (native) {
      try {
        mkdirSync(native, { recursive: true });
        writeFileSync(join(native, "cancel.flag"), "cancelled\n");
      } catch (e) {
        flagError = "could not write cancel.flag: " + String((e as Error).message);
      }
    }
    await new Promise<void>((resolve, reject) => {
      execFile("wsl.exe", cancelArgs(join(this.scripts, "cancel-feed.sh"), id), { timeout: 20_000, encoding: "utf8" }, (err, stdout, stderr) => {
        const child = this.children.get(id);
        // last resort for the Windows side only: stop waiting for a launcher that does not exit
        if (child) setTimeout(() => child.kill(), 15_000).unref();
        if (!err) return resolve();
        const code = (err as unknown as { code?: number | string }).code;
        // exit 1 (refused: the pid was not this run's script) is not a failure to stop the run when the flag is in place
        if (code === 1 && !flagError) return resolve();
        reject(new Error(`cancel script exited ${String(code)}: ${(String(stdout) + String(stderr)).trim().slice(0, 200)}`));
      });
    });
    if (flagError) throw new Error(flagError + " (the cancel script ran and reported success)");
  }
}
