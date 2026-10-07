// FEED_SOLVER=1: the hot radii of src/core/hotDimensions.ts against what OFFBEAT's own thermal expansion gives on the same pin (docs/hot-dimensions.md).
// OFFBEAT is run with mechanics ON on the COLD case (small strain, constant E, nu, alpha, stress-free at 300 K, each solid free axially: docs/spike/mechanics-probe.md)
// and its displacement D of the three surfaces is read: cold radius + D is the radius OFFBEAT gives at operating temperature. FEED's number is the radius the
// mean-temperature rule gives. The gap is 200 microns so that nothing touches. The tolerances were set from what the solver gave, as the comments below say.
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { validateCase } from "../src/core/validate";
import { patch, probeCase, runProbe } from "./helpers/mechanicsProbe";
import { readFileSync } from "fs";
import { join } from "path";

const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

describe.skipIf(!solverOn)("hot radii against OFFBEAT's own thermal expansion (needs FEED_SOLVER=1)", () => {
  for (const [q, label] of [[20000, "20 kW/m"], [40000, "40 kW/m"]] as const) {
    it(`the radii of the three surfaces at ${label}`, async () => {
      const files = probeCase({ q, T: 573, rci: 4.3, fuel: { alpha: "1.2e-5" }, cladding: { alpha: "1e-5" } });
      const run = await runProbe(files, 300);
      expect(run.exit.offbeatExit === 0 || run.exit.offbeatExit === 139).toBe(true);
      const d = JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-pin.json"), "utf8"));
      d.power.linearHeatRate = { value: q, unit: "W/m" };
      d.boundary = { bulkTemperature: { value: 573, unit: "K" }, heatTransferCoefficient: { value: 30000, unit: "W/m2/K" } };
      d.geometry.claddingInnerRadius = { value: 4.3, unit: "mm" };
      d.hotDimensions = { referenceTemperature: { value: 300, unit: "K" }, fuel: { linearExpansion: { value: 1.2e-5, unit: "1/K" }, source: "test" }, cladding: { linearExpansion: { value: 1e-5, unit: "1/K" }, source: "test" } };
      const v = validateCase(d);
      expect(v.errors).toEqual([]);
      const n = v.normalized!;
      const cold = n.hot!.cold;
      const solver = {
        fuelRadius: cold.fuelRadius + patch(run, "D", "fuelOuter")[0]!,
        claddingInnerRadius: cold.claddingInnerRadius + patch(run, "D", "cladInner")[0]!,
        claddingOuterRadius: cold.claddingOuterRadius + patch(run, "D", "cladOuter")[0]!,
      };
      const rel = (k: keyof typeof solver) => n[k] / solver[k] - 1;
      const dr = (k: keyof typeof solver) => (n[k] - cold[k]) / (solver[k] - cold[k]) - 1; // the error of the GROWTH, not of the radius
      // Observed on the pinned stack (2026-10-07): the growth of each surface agrees to 0.06 % (fuel) and 0.03 % (cladding), the radius to 8e-6 (fuel) and 9e-7 (cladding). The
      // tolerances are about three times that: the rule uses the closed-form mean temperature, OFFBEAT the mean over its 20 and 6 cells, and strains of 1e-2 are small but not zero.
      expect(Math.abs(dr("fuelRadius")), "fuel growth").toBeLessThan(2e-3);
      expect(Math.abs(dr("claddingInnerRadius")), "cladding inner growth").toBeLessThan(1e-3);
      expect(Math.abs(dr("claddingOuterRadius")), "cladding outer growth").toBeLessThan(1e-3);
      expect(Math.abs(rel("fuelRadius")), "fuel radius").toBeLessThan(2.5e-5);
      expect(Math.abs(rel("claddingInnerRadius")), "cladding inner radius").toBeLessThan(3e-6);
      expect(Math.abs(rel("claddingOuterRadius")), "cladding outer radius").toBeLessThan(3e-6);
      // the gap, the quantity the correction is for: FEED's hot gap against the solver's
      const solverGap = solver.claddingInnerRadius - solver.fuelRadius;
      expect(Math.abs(n.hot!.hotGap / solverGap - 1), "hot gap").toBeLessThan(2e-4);
    }, 300_000);
  }
});
