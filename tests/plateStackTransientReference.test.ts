// Plan 15, B3: a transient on a stack of plates judged against FEED's own two-dimensional solution of the whole stack (src/core/stackReference.ts, axialFv.ts), on the real OFFBEAT
// output saved in tests/golden/offbeat-plate-stack/transient-*. The tolerances are fixed here before the first run, with their reasons:
//   AGREEMENT 0.02 K   the largest difference between any OFFBEAT cell and the reference at any output: the probe saw 0.000 to 0.009 K (the 8 significant digits of OFFBEAT's output at
//                      the 3000 K the loss of cooling reaches); 0.02 K is the cross-check's own floor (CROSS_CHECK_FLOOR).
//   CONTRAST           the one-dimensional solutions miss the loss of cooling by 62 to 65 K (60 s: 5.6 K): the numbers are the measured ones of plan 12 A5 and plan 15 B0, with a few percent.
//   START              the distance between the run's start (each slice at its own steady state) and the stack's coupled steady state is the steady axial effect of a 0.381 m cosine
//                      plate, 0.609 K at 200 kW/m (A5), in proportion to the heat rate the run starts at (the conductivities are constant): 1 % either way. (I first wrote 0.55 to 0.65 K
//                      for every run, forgetting that the loss of cooling starts at 100 kW/m; the number is 0.304 K there.)
//   ENERGY             the remaining gap of a slice's energy balance (the trapezoid over the output times, which the check names) is the same for the reference's own fields as for OFFBEAT's:
//                      to 1 % of its value. (I first wrote that it falls below 1e-3; it falls from 7.3 % to 1.4 % and the 1.4 % is the method's, as this comparison shows.)
// Every check passes with NO allowance and NO exchange bound on every saved plate transient, including the 0.2 m 20-slice 100 s case that failed before; the checks fail on a stack that
// was not run; a pin's transient record is unchanged (its hash equals the one computed before plan 15).
import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { solveStackTransient } from "../src/core/axialFv";
import { STACK_TRANSIENT_WORK_MAX, coupledSteadyStart, runStartField, stackModelOf, stackTransientReference } from "../src/core/stackReference";
import { buildStackTransientResults, computeIndependentStack } from "../src/core/stackTransientResults";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const gdir = (dir: string, name: string) => {
  const d = join("tests", "golden", dir, name);
  const n = JSON.parse(read(d, "normalized.json"));
  const times = readdirSync(join(root, d, "times")).sort((a, b) => Number(a) - Number(b));
  return { n, C: read(d, "C"), fields: times.map((t) => ({ time: Number(t), T: read(d, "times", t, "T") })) };
};
const memo = new Map<string, ReturnType<typeof gdir>>();
const g = (name: string) => {
  if (!memo.has(name)) memo.set(name, gdir("offbeat-plate-stack", "transient-" + name));
  return memo.get(name)!;
};
const setsOf = new WeakMap<object, ReturnType<typeof computeIndependentStack>>();
const judge = (x: ReturnType<typeof g>, mutate?: (n: any) => void, reference?: Parameters<typeof buildStackTransientResults>[3]) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  if (!mutate && !setsOf.has(x)) setsOf.set(x, computeIndependentStack(n));
  return buildStackTransientResults(n, { C: x.C, fields: x.fields }, mutate ? computeIndependentStack(n) : setsOf.get(x)!, reference);
};
/** The reference's own cells written as the solver's fields (OFFBEAT's order: every layer's fuel cells, then every layer's cladding cells), to give to the checks in place of the real ones. */
const referenceFields = (x: ReturnType<typeof gdir>) => {
  const res = stackTransientReference(x.n);
  if (!("reference" in res)) throw new Error("no reference");
  const sol = res.reference.solution;
  const N = x.n.axial.slices;
  const nf = x.n.mesh.fuelCells;
  const nc = x.n.mesh.claddingCells;
  const FOOT = "// ************************************************************************* //";
  return sol.states.slice(1).map((s) => {
    const v: number[] = [];
    for (let k = 0; k < N; k++) for (let i = 0; i < nf; i++) v.push(s.T[k * sol.n + i]!);
    for (let k = 0; k < N; k++) for (let i = 0; i < nc; i++) v.push(s.T[k * sol.n + nf + i]!);
    return { time: s.time, T: `FoamFile
{
    class volScalarField;
    object T;
}
internalField   nonuniform List<scalar>
${v.length}
(
${v.map(String).join("\n")}
)
;

boundaryField
{
    cladOuter
    {
        type            fixedValue;
        value           nonuniform List<scalar> ${N}(${Array.from(s.wall).join(" ")});
    }
}

${FOOT}
` };
  });
};
const failingIds = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const check = (r: { checks: { id: string }[] }, id: string) => r.checks.find((c) => c.id === id) as { id: string; value: number | null; verdict: string; note: string };
const AGREEMENT = 0.02;
type Info = { kind: "two-dimensional"; deviation: number; oneDimensionalDeviation: number; startDistance: number | null };
const info = (r: ReturnType<typeof judge>) => r.axial.reference as Info;

describe("every saved plate transient is judged against the two-dimensional reference with no allowance and no exchange bound, and passes", () => {
  const runs: [string, number, [number, number]][] = [
    ["pulse", 10, [0, 0.01]],
    ["asym", 10, [0, 0.01]],
    ["short", 12, [0.02, 0.06]],
    ["lossofcooling", 10, [5.0, 6.2]],
    ["lossofcooling-long", 10, [62, 66]],
    ["lossofcooling-short", 10, [60, 64]],
    ["lossofcooling-limit", 20, [63, 67]],
  ];
  for (const [name, slices, contrast] of runs) {
    it(`${name}: every check passes, the cells agree with the reference to ${AGREEMENT} K at every output; the one-dimensional solutions are ${contrast[0]} to ${contrast[1]} K away`, () => {
      const r = judge(g(name));
      expect(failingIds(r)).toEqual([]);
      expect(r.axial.slices).toHaveLength(slices);
      const i = info(r);
      expect(i.kind).toBe("two-dimensional");
      expect(i.deviation).toBeLessThan(AGREEMENT);
      expect(i.oneDimensionalDeviation).toBeGreaterThanOrEqual(contrast[0]);
      expect(i.oneDimensionalDeviation).toBeLessThanOrEqual(contrast[1]);
      // the cross-check is made against the reference, so its worst value is the reference's, not the one-dimensional solutions'
      expect(check(r, "crossCheckFv").value!).toBeLessThan(AGREEMENT + 1e-9);
      expect(check(r, "axialConduction").verdict).toBe("na");
      expect(check(r, "axialConduction").note).toMatch(/information only/);
      expect(check(r, "energyBalance").label).toMatch(/received along the height/);
      expect(r.thermalOnly).toMatch(/two-dimensional finite-volume solution of the whole stack/);
    });
  }
  it("the 0.2 m, 20-slice, 100 s plate that failed every one-dimensional check (exchange number 1.5) passes them all; with the fallback it still fails, and says why", () => {
    const x = g("lossofcooling-limit");
    expect(failingIds(judge(x))).toEqual([]);
    const old = judge(x, undefined, null);
    expect(failingIds(old)).toEqual(["energyBalance", "crossCheckFv"]);
    expect(old.axial.reference).toEqual({ kind: "allowance", reason: "the allowance was asked for" });
    expect(old.axial.allowance.exchangeCounted).toBe(false);
  });
  it("the loss of cooling's 62 to 65 K that the one-dimensional solutions miss is followed to 0.01 K", () => {
    for (const name of ["lossofcooling-long", "lossofcooling-short", "lossofcooling-limit"]) {
      const i = info(judge(g(name)));
      expect(i.oneDimensionalDeviation).toBeGreaterThan(60);
      expect(i.deviation).toBeLessThan(0.01);
    }
  });
  it("the energy balance of each slice counts the heat it receives along the height: the end slice's 7 % gap falls to the method's own 1.4 %, the same as for the reference's own fields", () => {
    for (const name of ["lossofcooling", "lossofcooling-limit"]) {
      const x = g(name);
      const old = check(judge(x, undefined, null), "energyBalance").value!;
      const now = check(judge(x), "energyBalance").value!;
      if (name === "lossofcooling") expect(old).toBeGreaterThan(0.05);
      expect(now).toBeLessThan(old / 4);
      expect(Math.abs(check(judge(x), "energyBalanceTotal").value!)).toBeLessThan(0.03);
      // the reference's own cells given to the checks as if they were the solver's: the same remaining gap, and a cross-check of exactly zero
      const own = { ...x, fields: referenceFields(x) };
      const self = judge(own);
      expect(failingIds(self)).toEqual([]);
      expect(Math.abs(check(self, "energyBalance").value! / now - 1)).toBeLessThan(0.01);
      expect(check(self, "crossCheckFv").value!).toBeLessThan(1e-9);
    }
  });
  it("the run starts at each slice's own steady state, which is the steady axial effect (0.609 K for a 0.381 m cosine plate) from the coupled steady state; the checks follow the run", () => {
    const d = info(judge(g("lossofcooling"))).startDistance!; // starts at 100 kW/m
    expect(d / 0.609).toBeGreaterThan(0.99 * (100000 / 200000));
    expect(d / 0.609).toBeLessThan(1.01 * (100000 / 200000));
    const dp = info(judge(g("pulse"))).startDistance!; // starts at 20 kW/m
    expect(dp / 0.609).toBeGreaterThan(0.99 * (20000 / 200000));
    expect(dp / 0.609).toBeLessThan(1.01 * (20000 / 200000));
    expect(check(judge(g("lossofcooling")), "axialConduction").note).toMatch(/from the stack's coupled steady state/);
  });
});

describe("the coupled steady start", () => {
  it("is a fixed point of the transient: a stack started on it, with the power and the coolant it was solved for, stays", () => {
    const n = g("pulse").n;
    const c = JSON.parse(JSON.stringify(n));
    c.transient.times = [0, 1];
    c.transient.linearHeatRate = [c.transient.initial.linearHeatRate, c.transient.initial.linearHeatRate];
    const coupled = coupledSteadyStart(c);
    const m = stackModelOf(c);
    const r = solveStackTransient(m, { dt: 0.01, steps: 20, outputEvery: 20, initial: coupled.T });
    expect(Math.max(...Array.from(r.states[1]!.T, (x, i) => Math.abs(x - coupled.T[i]!)))).toBeLessThan(1e-6);
  });
  it("differs from each slice's own steady state by the axial effect, and a uniform start has none", () => {
    const n = g("lossofcooling").n;
    const coupled = coupledSteadyStart(n);
    const own = runStartField(n);
    const d = Math.max(...Array.from(own, (x, i) => Math.abs(x - coupled.T[i]!)));
    expect(d / 0.609).toBeGreaterThan(0.99 * (100000 / 200000));
    expect(d / 0.609).toBeLessThan(1.01 * (100000 / 200000));
    const uniform = JSON.parse(JSON.stringify(n));
    uniform.transient.initial = { kind: "uniform", temperature: 600 };
    expect(() => coupledSteadyStart(uniform)).toThrow(/steady state/);
    expect(Array.from(runStartField(uniform)).every((x) => x === 600)).toBe(true);
  });
});

describe("negative tests: the reference of a stack that was not run fails the checks against the saved OFFBEAT output", () => {
  const mustFail = (r: ReturnType<typeof judge>, label: string) => expect(failingIds(r).length, label).toBeGreaterThan(0);
  it("the axial term removed fails on the loss of cooling, the short pulse and the asymmetric shape's neighbours (the effect there is above the cross-check's bound)", () => {
    for (const name of ["lossofcooling", "lossofcooling-long", "lossofcooling-short", "lossofcooling-limit"]) {
      const x = g(name);
      const decoupled = stackTransientReference(x.n, { axialConduction: false });
      expect("reference" in decoupled, name).toBe(true);
      mustFail(judge(x, undefined, decoupled), name);
      expect(failingIds(judge(x, undefined, decoupled)), name).toContain("crossCheckFv");
    }
  });
  it("a power history of 10 % more heat, or a shape shifted by a tenth of the length, fails", () => {
    const x = g("lossofcooling");
    mustFail(judge(x, (n) => (n.transient.linearHeatRate = n.transient.linearHeatRate.map((v: number) => v * 1.1))), "more heat");
    const L = x.n.axial.length;
    const shifted = judge(x, (n) => {
      n.axial.shape = { kind: "table", positions: Array.from({ length: 41 }, (_, k) => (k / 40) * L), relative: Array.from({ length: 41 }, (_, k) => Math.max(0, Math.cos(Math.PI * ((k - 4) / 40 - 0.5)))) };
    });
    expect(failingIds(shifted)).toContain("crossCheckFv");
  });
  it("a pulse on a different heat-transfer coefficient fails the cross-check", () => {
    const x = g("pulse");
    const r = judge(x, (n) => {
      if (n.boundary.kind === "convective") n.boundary.heatTransferCoefficient *= 0.5;
    });
    expect(failingIds(r)).toContain("crossCheckFv");
  });
});

describe("the fallback to the allowance and the exchange bound", () => {
  it("a stack with more unknowns x steps than the cap is not solved: the result says why, and a record built with that result keeps the allowance and the exchange bound", () => {
    const x = g("lossofcooling");
    const big = JSON.parse(JSON.stringify(x.n));
    big.axial.slices = 50;
    big.mesh = { fuelCells: 40, claddingCells: 12 };
    big.transient.steps = 2300;
    big.transient.outputs = 23;
    big.transient.timeStep = 0.05;
    big.transient.endTime = 115;
    expect(50 * 52 * 2300).toBeGreaterThan(STACK_TRANSIENT_WORK_MAX);
    const res = stackTransientReference(big);
    expect("fallback" in res && res.fallback).toMatch(/more than the 3000000/);
    const r = judge(x, undefined, { fallback: "the cap test" });
    expect(r.axial.reference).toEqual({ kind: "allowance", reason: "the cap test" });
    expect(r.axial.allowance.exchangeCounted).toBe(true);
    expect(failingIds(r)).toEqual([]);
  });
  it("a deadline that passes stops the solution and the result falls back with the reason", () => {
    const res = stackTransientReference(g("lossofcooling").n, { deadlineMs: -1 });
    expect("fallback" in res && res.fallback).toMatch(/did not finish/);
  });
});

describe("a pin's transient stack record is not changed by plan 15", () => {
  const saved = JSON.parse(read("tests/fixtures/pin-stack-transient-hashes-0b60d93.json"));
  for (const name of ["asym", "coastdown", "pulse", "short", "shortcool"]) {
    it(`pin ${name}: the record's hash equals the one computed before plan 15, and it has no reference section`, () => {
      const x = gdir("offbeat-stack-transient", name);
      const r = buildStackTransientResults(x.n, { C: x.C, fields: x.fields }, computeIndependentStack(x.n));
      const js = JSON.stringify(r);
      expect(js.length).toBe(saved[name].bytes);
      expect(createHash("sha256").update(js).digest("hex")).toBe(saved[name].sha256);
      expect(r.axial.reference).toBeUndefined();
    });
  }
});
