// The checks on every mechanics result (src/core/mechanicsChecks.ts, docs/plans/09-mechanics.md M3) on the REAL OFFBEAT fields of tests/golden/offbeat-mechanics (the synthetic
// pin at 20 kW/m, E = 200 GPa, nu = 0.3, alpha = 1e-5, free axial strain, an open gap of 62 micron), and each of them broken: a field changed by more than its tolerance must
// fail the check it belongs to, and a pass is only worth something if it can fail.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { effectiveMechanics } from "../src/core/mechanicalEval";
import { MECHANICS_TOLERANCE, mechanicsChecks } from "../src/core/mechanicsChecks";
import { independentSolution } from "../src/core/thermoElastic";
import { buildResults } from "../src/core/resultsParser";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const g = (f: string) => readFileSync(join(root, "tests/golden/offbeat-mechanics", f), "utf8");
const q = (value: number, unit: string) => ({ value, unit });
const sets = {
  "mechanical.elasticity": { model: "constant", youngModulus: q(200, "GPa"), poissonRatio: q(0.3, "1"), source: "a test" },
  "mechanical.thermalExpansion": { linearExpansion: q(10, "ppm/K"), source: "a test" },
};
function normalized() {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.power.linearHeatRate = q(20, "kW/m");
  d.assumptions.thermalOnly = false;
  Object.assign(d.materials.fuel.sets, sets);
  Object.assign(d.materials.cladding.sets, sets);
  d.mechanics = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0, "Pa") };
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
}
type Fields = Record<string, string | undefined>;
const fields = (): Fields => ({ D: g("D"), sigma: g("sigma"), sigmaCyl: g("sigmaCyl"), gapWidth: g("gapWidth"), interfaceP: g("interfaceP") });
const checks = (mech: Fields) => {
  const r = buildResults(normalized(), { T: g("T"), C: g("C"), time: 5e7, mechanics: mech });
  return Object.fromEntries(r.checks.filter((c) => /^mechanics/.test(c.id)).map((c) => [c.id, c]));
};
/** Apply f to the numbers of entry `k` (or every entry when k is undefined) of a nonuniform list field. */
function changeRows(text: string, f: (row: number[], k: number) => number[], only?: number[]): string {
  const lines = text.split("\n");
  const open = lines.findIndex((l, i) => /^\d+$/.test(l.trim()) && lines[i + 1] === "(");
  const n = Number(lines[open]!.trim());
  for (let k = 0; k < n; k++) {
    if (only && !only.includes(k)) continue;
    const line = lines[open + 2 + k]!;
    const row = line.slice(1, -1).trim().split(/\s+/).map(Number);
    lines[open + 2 + k] = "(" + f(row, k).map((v) => v.toPrecision(8)).join(" ") + ")";
  }
  return lines.join("\n");
}
const patch = (text: string, v: string) => text.replace(/(fuelOuter\s*\{[^}]*?value\s+)uniform\s+[^;]+;/, "$1uniform " + v + ";");

describe("the real OFFBEAT result of the golden case passes every mechanics check", () => {
  const c = checks(fields());
  it("displacement, stress, equilibrium and contact each pass", () => {
    for (const id of ["mechanicsFields", "mechanicsDisplacement", "mechanicsStress", "mechanicsEquilibrium", "mechanicsContact"]) expect(c[id], id).toBeDefined();
    for (const x of Object.values(c)) expect(x.verdict, x.id + ": " + x.note).toBe("pass");
  });
  it("and each carries the number it was judged on", () => {
    expect(c.mechanicsDisplacement!.value).toBeGreaterThan(0);
    expect(c.mechanicsDisplacement!.value!).toBeLessThan(2e-7);
    expect(c.mechanicsStress!.unit).toBe("Pa");
    expect(c.mechanicsContact!.note).toMatch(/no contact/);
  });
});

describe("each check fails when its field is damaged by more than the tolerance", () => {
  it("the radial displacement 5 % too large fails the displacement check and leaves the others", () => {
    const c = checks({ ...fields(), D: changeRows(g("D"), (r) => [r[0]! * 1.05, r[1]!, r[2]!]) });
    expect(c.mechanicsDisplacement!.verdict).toBe("fail");
    expect(c.mechanicsDisplacement!.note).toMatch(/cell at r = /);
    expect(c.mechanicsStress!.verdict).toBe("pass");
    expect(c.mechanicsContact!.verdict).toBe("pass");
  });
  it("the displacement 0.4 % too large passes (inside the tolerance)", () => {
    const c = checks({ ...fields(), D: changeRows(g("D"), (r) => [r[0]! * 1.004, r[1]!, r[2]!]) });
    expect(c.mechanicsDisplacement!.verdict).toBe("pass");
  });
  it("a stress 8e7 Pa off in one fuel cell fails the stress check", () => {
    const c = checks({ ...fields(), sigmaCyl: changeRows(g("sigmaCyl"), (r) => [r[0]! + 8e7, r[1]!, r[2]!, r[3]! + 8e7, r[4]!, r[5]! + 8e7], [10]) });
    expect(c.mechanicsStress!.verdict).toBe("fail");
  });
  it("a stress component off by 8e7 Pa in one fuel cell fails the stress check whichever component it is: radial, hoop or axial", () => {
    for (const col of [0, 3, 5]) {
      const c = checks({ ...fields(), sigmaCyl: changeRows(g("sigmaCyl"), (r) => r.map((v, i) => (i === col ? v + 8e7 : v)), [10]) });
      expect(c.mechanicsStress!.verdict, "component " + col).toBe("fail");
    }
  });
  it("a stress change that stays inside the stress tolerance but breaks the radial balance fails only the balance", () => {
    // 2.5 % of the fuel's stress scale (about 7.5e8 Pa): under the 3 % of the cross check, over the 2 % of the balance
    const c = checks({ ...fields(), sigmaCyl: changeRows(g("sigmaCyl"), (r) => [r[0]! + 1.9e7, ...r.slice(1)], [10]) });
    expect(c.mechanicsStress!.verdict, c.mechanicsStress!.note).toBe("pass");
    expect(c.mechanicsEquilibrium!.verdict).toBe("fail");
    expect(c.mechanicsEquilibrium!.note).toMatch(/fuel between r = /);
  });
  it("a gap 12 % too wide fails the contact check", () => {
    const c = checks({ ...fields(), gapWidth: patch(g("gapWidth"), "7e-5") });
    expect(c.mechanicsContact!.verdict).toBe("fail");
    expect(c.mechanicsContact!.note).toMatch(/gap 70\.000 micron against 62\.4\d+ micron/);
  });
  it("a pressure at an interface the independent solution says is open fails the contact check, and so does a closed gap width", () => {
    const p = checks({ ...fields(), interfaceP: patch(g("interfaceP"), "5e6") });
    expect(p.mechanicsContact!.verdict).toBe("fail");
    expect(p.mechanicsContact!.note).toMatch(/do not touch/);
    const w = checks({ ...fields(), gapWidth: patch(g("gapWidth"), "-1e-6") });
    expect(w.mechanicsContact!.verdict).toBe("fail");
  });
  it("an unreadable gap width with a pressure that reads zero is not a pass for an open gap that is not nearly closed (Codex review 2026-10-11)", () => {
    const c = checks({ ...fields(), gapWidth: g("gapWidth").replace(/(fuelOuter\s*\{[^}]*?value\s+)uniform\s+[^;]+;/, "$1uniform nan;") });
    expect(c.mechanicsContact!.verdict).toBe("fail");
    expect(c.mechanicsContact!.note).toMatch(/never passed unread/);
  });
  it("no gap field and no pressure field is a failed contact check, not a pass", () => {
    const c = checks({ ...fields(), gapWidth: undefined, interfaceP: undefined });
    expect(c.mechanicsContact!.verdict).toBe("fail");
  });
});

describe("the tolerances are the ones fixed in the plan before the first run", () => {
  it("displacement 1 % + 1e-9 m, stress 3 % + 1e4 Pa (scale floor 1 % of E alpha dT), balance 2 %, contact 3 % + 1e4 Pa with 0.5 micron undecided, gap 2 % + 1e-8 m", () => {
    expect(MECHANICS_TOLERANCE).toEqual({
      displacement: { fraction: 0.01, floor: 1e-9 },
      stress: { fraction: 0.03, floor: 1e4, thermalFraction: 0.01 },
      equilibrium: 0.02,
      contact: { fraction: 0.03, floor: 1e4, nearlyClosed: 0.5e-6 },
      gap: { fraction: 0.02, floor: 1e-8 },
    });
  });
  it("and the plan says so", () => {
    const plan = readFileSync(join(root, "docs/plans/09-mechanics.md"), "utf8");
    expect(plan).toMatch(/Displacement\*\* `ur`: within 1 %/);
    expect(plan).toMatch(/within 3 % of the larger of/);
    expect(plan).toMatch(/within 2 % of the solid's stress scale/);
  });
});

// Records made from the independent solution itself (every cell exact), then disturbed: what the checks do at the edges of their tolerances and where the golden case cannot reach
// (a contact, a stress that is nearly zero).
describe("records built from the independent solution, then disturbed", () => {
  const cells = [...Array.from({ length: 20 }, (_, i) => ({ region: "fuel" as const, r: ((i + 0.5) / 20) * 4.1e-3 })), ...Array.from({ length: 8 }, (_, i) => ({ region: "cladding" as const, r: 4.12e-3 + ((i + 0.5) / 8) * 0.63e-3 }))];
  /** The synthetic pin at 10 W/m, 600 K coolant, reference 300 K, E 2e11 and nu 0.3 for both solids, the fuel's alpha as given. */
  function make(fuelAlpha: number, rci: number) {
    const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
    d.power.linearHeatRate = q(10, "W/m");
    d.boundary = { bulkTemperature: q(600, "K"), heatTransferCoefficient: q(30000, "W/m2/K") };
    d.geometry.claddingInnerRadius = q(rci, "mm");
    d.assumptions.thermalOnly = false;
    const e = (a: number) => ({ "mechanical.elasticity": { model: "constant", youngModulus: q(2e11, "Pa"), poissonRatio: q(0.3, "1"), source: "a test" }, "mechanical.thermalExpansion": { linearExpansion: q(a, "1/K"), source: "a test" } });
    Object.assign(d.materials.fuel.sets, e(fuelAlpha));
    Object.assign(d.materials.cladding.sets, e(1e-5));
    d.mechanics = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0, "Pa") };
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    const n = v.normalized!;
    const props = effectiveMechanics(n)!;
    const sol = independentSolution(n, props, n.mechanics!);
    const points = cells.map((c) => {
      const p = (c.region === "fuel" ? sol.fuel : sol.cladding).at(c.r);
      return { ur: p.ur, uz: 0, sigmaR: p.sigmaR, sigmaTheta: p.sigmaTheta, sigmaZ: p.sigmaZ, sigmaEq: 0 };
    });
    const record = (over: { contactPressure?: number; gapWidth?: number; contact?: boolean } = {}) =>
      ({ points: points.map((x) => ({ ...x })), summary: { gapWidth: over.gapWidth ?? sol.gap, contactPressure: over.contactPressure ?? sol.contactPressure, contact: over.contact ?? sol.contact } }) as any;
    return { n, props, sol, record };
  }
  const verdicts = (m: ReturnType<typeof make>, rec: any) => Object.fromEntries(mechanicsChecks(m.n, m.props, rec, cells).map((c) => [c.id, c.verdict]));

  it("an exact record passes everything, with a contact and without", () => {
    for (const [alpha, rci] of [[4e-5, 4.12], [1e-5, 4.12]] as const) {
      const m = make(alpha, rci);
      expect(Object.values(verdicts(m, m.record())).every((v) => v === "pass")).toBe(true);
    }
    expect(make(4e-5, 4.12).sol.contact).toBe(true);
    expect(make(1e-5, 4.12).sol.contact).toBe(false);
  });
  it("the contact pressure 2 % off passes and 5 % off fails (3 % bound)", () => {
    const m = make(4e-5, 4.12);
    const p = m.sol.contactPressure;
    expect(verdicts(m, m.record({ contactPressure: p * 0.98 })).mechanicsContact).toBe("pass");
    expect(verdicts(m, m.record({ contactPressure: p * 1.02 })).mechanicsContact).toBe("pass");
    expect(verdicts(m, m.record({ contactPressure: p * 0.95 })).mechanicsContact).toBe("fail");
    expect(verdicts(m, m.record({ contactPressure: p * 1.05 })).mechanicsContact).toBe("fail");
  });
  it("where the stress is nearly zero (a pin at 10 W/m, free expansion) the floor of 1 % of E alpha dT keeps solver noise of 100 kPa from failing the check, and 1 MPa still fails", () => {
    const m = make(1e-5, 4.2);
    const noisy = (amp: number) => {
      const r = m.record();
      r.points.forEach((x: any, i: number) => (x.sigmaZ += i % 2 ? amp : -amp));
      return r;
    };
    expect(verdicts(m, noisy(1e5)).mechanicsStress).toBe("pass");
    expect(verdicts(m, noisy(1e6)).mechanicsStress).toBe("fail");
  });
  it("a gap that is open by less than a micron is open (a mutant that called it closed would pass the pressure check with a made-up pressure)", () => {
    // find the alpha for which the free gap is +0.3 micron by bisection, then the independent solution says no contact and gap 0.3 micron
    let lo = 1e-6;
    let hi = 2e-4;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (make(mid, 4.12).sol.freeGap > 0.3e-6) lo = mid;
      else hi = mid;
    }
    const s = make(lo, 4.12).sol;
    expect(s.freeGap).toBeGreaterThan(0.29e-6);
    expect(s.contact).toBe(false);
    expect(s.contactPressure).toBe(0);
    expect(s.gap).toBeCloseTo(s.freeGap, 15);
  });
});
