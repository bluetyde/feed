// Plan 19 D1, "the middle option for pins" (the owner's word, 2026-10-24; plan 15's own wording after B0: the two-dimensional reference is used for a pin only where the axial effect
// exceeds the radial bound). Ungated: the real OFFBEAT output of the saved pin stacks (tests/golden/offbeat-stack, offbeat-stack-transient) judged by the default builders.
//   - a pin at the length of a TRIGA rod (0.381 m): the heat along the height (about 1 K) is below the radial mesh bound (about 10 K): the pin keeps the allowance, results as before;
//   - a short pin (0.06 m): the effect (about 45 K) is above the bound: the pin is judged with the heat along the height added (closed form plus the two-dimensional solution minus the
//     same solution with no conduction between layers), with no allowance: the 135 K that a deviation of 45 K used to hide is gone;
//   - the checks have teeth there: a stack judged without the axial term fails, a damaged cell fails where the allowance let it pass.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildStackResults } from "../src/core/stackResults";
import { buildStackTransientResults } from "../src/core/stackTransientResults";
import { pinReferenceDecision, stackReference, stackTransientReference } from "../src/core/stackReference";

const root = join(__dirname, "golden");
const f = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const steady = (name: string) => ({ n: JSON.parse(f("offbeat-stack", name, "normalized.json")), input: { T: f("offbeat-stack", name, "T"), C: f("offbeat-stack", name, "C"), time: 1 } });
const transient = (name: string) => {
  const d = join(root, "offbeat-stack-transient", name);
  const n = JSON.parse(f("offbeat-stack-transient", name, "normalized.json"));
  const fields = readdirSync(join(d, "times")).sort((a, b) => Number(a) - Number(b)).map((t) => ({ time: Number(t), T: f("offbeat-stack-transient", name, "times", t, "T") }));
  return { n, input: { C: f("offbeat-stack-transient", name, "C"), fields } };
};
const check = (r: { checks: { id: string; value: number | null; verdict: string; note: string }[] }, id: string) => r.checks.find((c) => c.id === id)!;
const failing = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);

describe("which pins are judged with the heat along the height added", () => {
  it("a pin of 0.381 m keeps the allowance (the effect is about 1 K, the radial bound about 10 K); a pin of 0.06 m does not (about 45 K against 10 K); a plate always uses the reference", () => {
    const long = pinReferenceDecision(steady("cosine").n);
    expect(long.use).toBe(false);
    expect(long.axialEstimate).toBeGreaterThan(0.8);
    expect(long.axialEstimate).toBeLessThan(1.5);
    expect(long.radialBound).toBeGreaterThan(8);
    const short = pinReferenceDecision(steady("short").n);
    expect(short.use).toBe(true);
    expect(short.axialEstimate).toBeGreaterThan(30);
    expect(short.axialEstimate).toBeGreaterThan(3 * short.radialBound);
    const plate = JSON.parse(f("offbeat-plate-stack", "short", "normalized.json"));
    expect(pinReferenceDecision(plate).use).toBe(true);
    // a case that is not a stack never is
    const single = JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-pin.json"), "utf8"));
    expect(pinReferenceDecision(single).use).toBe(false);
  });
});

describe("a steady pin stack", () => {
  it("a long pin: the result is what it was (the allowance, no reference record)", () => {
    const { n, input } = steady("cosine");
    const r = buildStackResults(n, input);
    const old = buildStackResults(n, input, null);
    expect(r.axial.reference).toBeUndefined();
    expect(JSON.stringify(r)).toBe(JSON.stringify(old));
    expect(failing(r)).toEqual([]);
  });
  it("a short pin: judged with the heat along the height added, no allowance, and OFFBEAT's cells agree with closed form plus axial effect to under a kelvin (the old check passed a 44.7 K deviation on a 135.8 K allowance)", () => {
    const { n, input } = steady("short");
    const r = buildStackResults(n, input);
    const old = buildStackResults(n, input, null);
    expect(old.axial.allowance.field).toBeGreaterThan(100);
    expect(check(old, "closedFormFuel").value!).toBeGreaterThan(40); // the one-dimensional closed form is far from the cells: the allowance covered it
    const ref = r.axial.reference as { kind: string; axialEffect: number; oneDimensionalDeviation: number; deviation: number };
    expect(ref.kind).toBe("two-dimensional");
    expect(failing(r)).toEqual([]);
    expect(check(r, "closedFormFuel").value!).toBeLessThan(1);
    expect(check(r, "closedFormCladding").value!).toBeLessThan(0.1);
    expect(check(r, "wallTemperature").value!).toBeLessThan(0.05);
    expect(ref.deviation).toBeLessThan(1);
    // the effect the heat along the height has in the cells is the size of what the one-dimensional closed form misses
    expect(ref.axialEffect).toBeGreaterThan(30);
    expect(Math.abs(ref.oneDimensionalDeviation / ref.axialEffect - 1)).toBeLessThan(0.2);
    expect(r.thermalOnly).toMatch(/plus the effect of that heat flow/);
    expect(check(r, "axialConduction").note).toMatch(/the heat flow along the height is in the reference/);
  });
  it("teeth: the same pin judged without the axial term (the decoupled solution given as the reference) fails the fuel check: the deviation that is the heat along the height is not forgiven", () => {
    const { n, input } = steady("short");
    const decoupled = stackReference(n, { axialConduction: false });
    expect("reference" in decoupled).toBe(true);
    const r = buildStackResults(n, input, decoupled);
    expect(failing(r)).toContain("closedFormFuel");
    expect(check(r, "closedFormFuel").value!).toBeGreaterThan(40);
  });
  it("teeth: a cell 8 K off in the middle of a short pin fails with the reference (bound 5 dT / N^2 + 0.01 about 10 K for the cell's own error of under 1 K...) and one 60 K off fails where the allowance would have passed", () => {
    const { n, input } = steady("short");
    const bump = (K: number) => {
      // one fuel cell of the middle layer shifted: the field is "internalField nonuniform List<scalar> N ( ... )", one value per line
      const head = /internalField\s+nonuniform\s+List<scalar>\s*\d+\s*\(\s*\n/.exec(input.T)!;
      const start = head.index + head[0].length;
      const end = input.T.indexOf("\n)", start);
      const rows = input.T.slice(start, end).split("\n").map(Number);
      const i = 6 * n.mesh.fuelCells + 3;
      rows[i] = rows[i]! + K;
      return { ...input, T: input.T.slice(0, start) + rows.map(String).join("\n") + input.T.slice(end) };
    };
    const allowance = buildStackResults(n, bump(60), null);
    expect(failing(allowance)).toEqual([]); // the 135 K allowance let a 60 K error through
    const r = buildStackResults(n, bump(60));
    expect(failing(r)).toContain("closedFormFuel");
  });
});

describe("a transient pin stack", () => {
  it("a long pin keeps the allowance: no reference record, the result as before", () => {
    const { n, input } = transient("coastdown");
    const r = buildStackTransientResults(n, input);
    expect(r.axial.reference).toBeUndefined();
    expect(failing(r)).toEqual([]);
  }, 120_000);
  it("a short pin with a lost cooling: judged against the two-dimensional solution, the cross-check bound falls from the allowance's about 136 K to about 6 K and the run still passes every check", () => {
    const { n, input } = transient("shortcool");
    expect(pinReferenceDecision(n).use).toBe(true);
    const r = buildStackTransientResults(n, input);
    expect((r.axial.reference as { kind: string }).kind).toBe("two-dimensional");
    expect(failing(r)).toEqual([]);
    const bound = (x: typeof r) => Number(/bound ([0-9.]+) K/.exec(check(x, "crossCheckFv").note)![1]);
    expect(bound(r)).toBeLessThan(8);
    const old = buildStackTransientResults(n, input, undefined, null);
    expect(bound(old)).toBeGreaterThan(100);
    expect(check(old, "crossCheckFv").value!).toBeGreaterThan(5 * check(r, "crossCheckFv").value!); // what the allowance regime saw as the cross-check value: 30.7 K, against 2.7 K
  }, 300_000);
  it("teeth: a cell 20 K off at the end of the run passes under the allowance and fails against the reference", () => {
    const { n, input } = transient("shortcool");
    const fields = input.fields.map((fl, j) => {
      if (j !== input.fields.length - 1) return fl;
      const head = /internalField\s+nonuniform\s+List<scalar>\s*\d+\s*\(\s*\n/.exec(fl.T)!;
      const start = head.index + head[0].length;
      const end = fl.T.indexOf("\n)", start);
      const rows = fl.T.slice(start, end).split("\n").map(Number);
      const i = 6 * n.mesh.fuelCells + 3;
      rows[i] = rows[i]! + 20;
      return { ...fl, T: fl.T.slice(0, start) + rows.map(String).join("\n") + fl.T.slice(end) };
    });
    const damaged = { ...input, fields };
    expect(failing(buildStackTransientResults(n, damaged, undefined, null))).toEqual([]);
    const ref = stackTransientReference(n);
    expect("reference" in ref).toBe(true);
    expect(failing(buildStackTransientResults(n, damaged, undefined, ref))).toContain("crossCheckFv");
  }, 300_000);
});
