// What OFFBEAT's burnup field Bu is per (FEED_SOLVER=1): with `burnup fromPower` on FEED's own pin, Bu in a fuel cell is the heat produced per unit mass of the
// cell's material, Bu = Q * t[days] / rho / 1000, in MWd per tonne of the material's mass: for an oxide fuel that is MWd per tonne of OXIDE, not of heavy metal.
// The oxide-to-heavy-metal factor OFFBEAT itself uses is 0.8815 (burnupLassmann.C, read, not run). Records the answer to the question from the OpenMC Studio session
// in messages/fuel-performance-studio.md (2026-10-07). The hand value is written here and shares no code with FEED.
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { WRITER_DENSITY } from "../src/core/caseWriter";
import { cells, probeCase, runProbe } from "./helpers/mechanicsProbe";

const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

describe.skipIf(!solverOn)("the basis of OFFBEAT's Bu (needs FEED_SOLVER=1)", () => {
  it("burnup fromPower on the 20 kW/m pin for 5e7 s: Bu = Q t / rho / 1000 in the fuel cells (21916.37), and 0 in the cladding", async () => {
    const files = probeCase({ q: 20000, T: 573, mechanics: false, edit: { "constant/solverDict": (t) => t.replace("burnup                  none;", "burnup                  fromPower;") } });
    const run = await runProbe(files, 280);
    expect(run.exit.offbeatExit === 0 || run.exit.offbeatExit === 139).toBe(true);
    const Q = 20000 / (Math.PI * 4.1e-3 * 4.1e-3); // W/m3, the uniform source of the 4.1 mm fuel radius
    const days = 5e7 / 86400;
    const hand = (Q * days) / WRITER_DENSITY / 1000; // MWd per tonne of the material at the written density
    const Bu = cells(run, "Bu").map((r) => r[0]!);
    expect(Bu.length).toBe(26);
    for (const b of Bu.slice(0, 20)) expect(Math.abs(b / hand - 1), String(b)).toBeLessThan(1e-6); // observed 21916.372 against 21916.3724
    for (const b of Bu.slice(20)) expect(b).toBe(0);
    expect(hand).toBeCloseTo(21916.37, 1);
  }, 300_000);
});
