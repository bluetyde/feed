// Backend that runs the solver in the feed-solver WSL distro. Explicit argument lists only (no shell string), run ids are
// generated hex, directories come from the manager. Windows paths become /mnt/<drive>/... for the distro.

import { execFile, spawn, ChildProcess } from "child_process";
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
  private cancelled = new Set<string>();
  private scripts = join(projectRoot(), "solver");

  run({ id, inputsDir, nativeDir, timeoutMs }: { id: string; inputsDir: string; nativeDir: string; timeoutMs: number }): Promise<BackendOutcome> {
    return new Promise((resolve, reject) => {
      const timeoutSec = String(Math.max(5, Math.floor(timeoutMs / 1000) - 5));
      const child = spawn("wsl.exe", ["-d", DISTRO, "-u", DISTRO_USER, "--", "bash", toWslPath(join(this.scripts, "run-feed.sh")), toWslPath(inputsDir), toWslPath(nativeDir), id, timeoutSec], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      this.children.set(id, child);
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.stdout?.on("data", () => undefined);
      child.on("error", (e) => {
        this.children.delete(id);
        reject(e);
      });
      child.on("close", (code) => {
        this.children.delete(id);
        const wasCancelled = this.cancelled.delete(id);
        if (code !== 0 && !wasCancelled) reject(new Error(`run script exited ${code}: ${stderr.trim().slice(0, 300)}`));
        else resolve({ cancelled: wasCancelled });
      });
    });
  }

  cancel(id: string): Promise<void> {
    this.cancelled.add(id);
    return new Promise((resolve) => {
      execFile("wsl.exe", ["-d", DISTRO, "-u", DISTRO_USER, "--", "bash", toWslPath(join(this.scripts, "cancel-feed.sh")), id], { timeout: 15_000 }, () => {
        // If the run script does not wind down by itself, stop waiting for it.
        const child = this.children.get(id);
        if (child) setTimeout(() => child.kill(), 10_000).unref();
        resolve();
      });
    });
  }
}
