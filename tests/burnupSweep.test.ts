// The burnup sweep (src/core/burnupSweep.ts, docs/plans/10-burnup.md M4): the closed-form centre temperature at a range of burnups, checked point by point against the
// integral of the law done by Simpson's rule and a bisection written here, and what it says when there is nothing to sweep or a point is refused.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { burnupSweep, SWEEP_BURNUPS, SWEEP_NOTE } from "../src/core/burnupSweep";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const pin = (B = 40) => {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.power.linearHeatRate = q(20, "kW/m");
  d.materials.fuel.sets["thermal.conductivity"] = { model: "uo2-nfi", densityFraction: q(0.95, "1"), source: "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11" };
  d.burnup = { value: q(B, "MWd/kgHM"), basis: "heavy-metal", source: "chosen for the study" };
  return d;
};
/** Eq. 2.3-10 and 2.3-11 of NUREG/CR-7024, typed here. */
const kHand = (T: number, B: number, f = 0.95): number => {
  const h = 1 / (1 + 396 * Math.exp(-6380 / T));
  const phonon = 1 / (0.0452 + 0.000246 * T + 0.00187 * B + (1 - 0.9 * Math.exp(-0.04 * B)) * 0.038 * Math.pow(B, 0.28) * h);
  return (1.0789 * (phonon + (3.5e9 / (T * T)) * Math.exp(-16361 / T)) * f) / (1 + 0.5 * (1 - f));
};
const simpson = (g: (x: number) => number, a: number, b: number, n = 4000) => {
  const h = (b - a) / n;
  let s = g(a) + g(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * g(a + i * h);
  return (s * h) / 3;
};
const centreHand = (B: number) => {
  const Tco = 573 + 20000 / (2 * Math.PI * 4.75e-3 * 30000);
  const Tci = Tco + (20000 * Math.log(4.75 / 4.18)) / (2 * Math.PI * 15);
  const Ts = Tci + 20000 / (2 * Math.PI * 4.1e-3 * 5000);
  let lo = Ts;
  let hi = Ts + 3000;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (simpson((T) => kHand(T, B), Ts, mid, 1000) < 20000 / (4 * Math.PI)) lo = mid;
    else hi = mid;
  }
  return { centre: 0.5 * (lo + hi), surface: Ts };
};

describe("the burnup sweep", () => {
  const r = burnupSweep(pin());
  it("covers 0 to 62 MWd/kgHM in steps of 5, the top of the range, and the case's own burnup, in order", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sweep.points.map((p) => p.burnup)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 62]);
    expect(r.sweep.stated).toBe(40);
    expect(SWEEP_BURNUPS.length).toBe(14);
    expect(r.sweep.note).toBe(SWEEP_NOTE);
    expect(SWEEP_NOTE).toMatch(/no solver run.*frozen-burnup snapshot.*not how a rod ages/);
  });
  it("a burnup that is not on the grid is added, and sorted in", () => {
    const x = burnupSweep(pin(33.3));
    expect(x.ok && x.sweep.points.map((p) => p.burnup)).toEqual([0, 5, 10, 15, 20, 25, 30, 33.3, 35, 40, 45, 50, 55, 60, 62]);
  });
  it("every point is the closed form of the law, checked by Simpson's rule and a bisection, at the fuel centre and surface", () => {
    if (!r.ok) throw new Error("no sweep");
    for (const p of r.sweep.points) {
      const hand = centreHand(p.burnup);
      expect(Math.abs(p.centreT! / hand.centre - 1), `${p.burnup}`).toBeLessThan(1e-9);
      expect(Math.abs(p.fuelSurfaceT! / hand.surface - 1), `${p.burnup}`).toBeLessThan(1e-9);
      expect(p.verdict).toBe("in-domain");
    }
  });
  it("the pin runs hotter with every step of burnup, and fresh fuel is the burnup-0 point", () => {
    if (!r.ok) throw new Error("no sweep");
    const T = r.sweep.points.map((p) => p.centreT!);
    for (let i = 1; i < T.length; i++) expect(T[i]!).toBeGreaterThan(T[i - 1]!);
    const fresh = validateCase({ ...pin(), burnup: { ...pin().burnup, value: q(0, "MWd/kgHM") } });
    expect(fresh.errors).toEqual([]);
  });
  it("the case itself is not changed (the sweep works on copies)", () => {
    const d = pin();
    const before = JSON.stringify(d);
    burnupSweep(d);
    expect(JSON.stringify(d)).toBe(before);
  });
  it("says why there is nothing to sweep: no burnup in the case, or a case that is not valid", () => {
    const plain = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
    expect(burnupSweep(plain)).toEqual({ ok: false, reason: "the case has no burnup: the fuel's conductivity does not depend on it" });
    const bad = pin();
    bad.power.linearHeatRate = q(-1, "kW/m");
    const x = burnupSweep(bad);
    expect(x.ok).toBe(false);
    expect(!x.ok && x.reason).toMatch(/^the case is not valid: /);
  });
  it("a point that the case refuses is reported with its reason, and the others stay (hot dimensions that close the gap only at the higher burnups)", () => {
    const closes = (alpha: number, B: number) => {
      const d = pin(B);
      d.hotDimensions = { referenceTemperature: q(293.15, "K"), fuel: { linearExpansion: q(alpha, "1/K"), source: "x" }, cladding: { linearExpansion: q(1e-5, "1/K"), source: "x" } };
      return !validateCase(d).ok;
    };
    // the smallest coefficient that closes the gap at 62 MWd/kgHM, found by bisection; a hair above it closes the gap at the high burnups and not at 0
    let lo = 1e-6;
    let hi = 1e-4;
    for (let i = 0; i < 20; i++) {
      const mid = 0.5 * (lo + hi);
      if (closes(mid, 62)) hi = mid;
      else lo = mid;
    }
    const alpha = hi * 1.002;
    expect(closes(alpha, 62)).toBe(true);
    expect(closes(alpha, 0)).toBe(false);
    const d = pin(20);
    d.hotDimensions = { referenceTemperature: q(293.15, "K"), fuel: { linearExpansion: q(alpha, "1/K"), source: "x" }, cladding: { linearExpansion: q(1e-5, "1/K"), source: "x" } };
    const x = burnupSweep(d);
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    const refused = x.sweep.points.filter((p) => p.problem !== undefined);
    const fine = x.sweep.points.filter((p) => p.problem === undefined);
    expect(refused.length).toBeGreaterThan(0);
    expect(fine.length).toBeGreaterThan(0);
    expect(refused.every((p) => p.centreT === undefined && /closes the gap/.test(p.problem!))).toBe(true);
    expect(fine.every((p) => typeof p.centreT === "number")).toBe(true);
    expect(refused[0]!.burnup).toBeGreaterThan(fine[0]!.burnup); // it is the hotter, more burnt end that closes
  }, 180_000);
});
