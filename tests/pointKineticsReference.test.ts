// The generator against an independently written reference (oracles/point-kinetics-reference.py: fixed-step RK4, bisection for the temperature,
// numerical quadrature of the feedback), run in the feed-solver distro's Python 3 and saved. The inputs are in oracles/point-kinetics-cases.json,
// made by scripts/make-kinetics-reference-cases.cjs; the saved results are what the TypeScript must reproduce.
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { generatePulse } from "../src/core/pointKinetics";

const root = join(__dirname, "..");
const saved: { name: string; spec: any; ctx: any; reference: Record<string, number | null> }[] = JSON.parse(readFileSync(join(root, "oracles", "point-kinetics-reference.json"), "utf8"));

describe("the generator against the independent reference", () => {
  for (const c of saved) {
    describe(c.name, () => {
      const g = generatePulse(c.spec, c.ctx);
      const r = c.reference as Record<string, number>;
      const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
      it("peak power to 1e-5", () => expect(rel(g.summary.peakPower, r.peakPower!)).toBeLessThan(1e-5));
      it("time of the peak to 0.02 ms", () => expect(Math.abs(g.summary.timeOfPeak - r.timeOfPeak!)).toBeLessThan(2e-5));
      it("energy released to 1e-5", () => expect(rel(g.summary.totalEnergy, r.totalEnergy!)).toBeLessThan(1e-5));
      it("width at half maximum to 1e-4", () => expect(rel(g.summary.fwhm!, r.fwhm!)).toBeLessThan(1e-4));
      it("the fuel's final average temperature to 0.01 K", () => expect(Math.abs(g.summary.finalFuelTemperature - r.finalFuelTemperature!)).toBeLessThan(0.01));
      it("the power at the end of the window to 1e-4", () => expect(rel(g.summary.finalPower, r.finalPower!)).toBeLessThan(1e-4));
    });
  }

  it("the saved inputs are the ones the case generator makes (no drift between the script and the oracle)", () => {
    const made = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "make-kinetics-reference-cases.cjs")], { encoding: "utf8" }));
    expect(saved.map((c) => ({ name: c.name, spec: c.spec, ctx: c.ctx }))).toEqual(made);
    expect(JSON.parse(readFileSync(join(root, "oracles", "point-kinetics-cases.json"), "utf8"))).toEqual(made);
  });

  it("the reference covers the regimes: delayed and prompt-only, a step and a ramp, constant and linear laws", () => {
    expect(saved.some((c) => c.spec.groups.length === 0)).toBe(true);
    expect(saved.some((c) => c.spec.groups.length === 6)).toBe(true);
    expect(saved.some((c) => c.spec.insertionTime > 0)).toBe(true);
    expect(saved.some((c) => c.spec.feedback.kind === "linear" && c.ctx.fuelC.b !== 0)).toBe(true);
  });
});
