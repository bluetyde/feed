// End to end through the real solver: case JSON -> validate -> case writer -> OFFBEAT in the feed-solver WSL distro -> compare
// with the closed form. Runs only when FEED_SOLVER=1 and the distro exists; otherwise it is skipped and says why.
//   FEED_SOLVER=1 npm test

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { describe, expect, it } from "vitest";
import { closedForm, compositeConstantK } from "../src/core/closedForm";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");

function distroAvailable(): boolean {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    const out = execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" });
    return out.split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
}

/** /mnt/c/... path for a Windows path. */
const toWsl = (p: string) => "/mnt/" + p[0]!.toLowerCase() + p.slice(2).replace(/\\/g, "/");

describe.skipIf(!distroAvailable())("case writer -> OFFBEAT (needs FEED_SOLVER=1 and the feed-solver distro)", () => {
  it("runs the synthetic pin and matches the closed form within the discretization bound", () => {
    const doc = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
    const n = validateCase(doc).normalized!;
    const w = writeOffbeatCase(n);
    const dir = mkdtempSync(join(tmpdir(), "feed-e2e-"));
    for (const [rel, text] of Object.entries(w.files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    const tag = "e2e" + Date.now();
    const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
    let out = "";
    try {
      out = execFileSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--", "bash", toWsl(join(root, "solver", "run-case.sh")), toWsl(dir), tag], { encoding: "utf8", env, timeout: 300000 });
    } catch (e: any) {
      out = String(e.stdout ?? "");
    }
    // The solver exits 139 after a complete run, so classify by output, not exit code (decision 0002).
    expect(out).toMatch(/time dirs: 0 50000000/);
    const res = JSON.parse(execFileSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--", "cat", `/home/feed/runs/feed-${tag}/result.json`], { encoding: "utf8", env }));
    expect(res.T.every(Number.isFinite)).toBe(true);

    const pin = { qPrime: n.qPrime, fuelK: 3, fuelRadius: n.fuelRadius, hGap: n.gapConductance, claddingInnerRadius: n.claddingInnerRadius, claddingOuterRadius: n.claddingOuterRadius, claddingK: 15, hFilm: 30000, bulkTemperature: 573 };
    const exact = compositeConstantK(pin);
    let worst = 0;
    res.r.forEach((r: number, i: number) => {
      if (r < pin.fuelRadius) worst = Math.max(worst, Math.abs(res.T[i] - closedForm.fuelProfile(pin.qPrime, pin.fuelK, pin.fuelRadius, r, exact.fuelSurfaceT)));
    });
    expect(worst).toBeLessThan((5 * exact.fuelDeltaT) / (n.mesh.fuelCells * n.mesh.fuelCells));
    expect(Math.abs(res.cladOuterWallT - exact.claddingOuterT)).toBeLessThan(0.05);
  });
});
