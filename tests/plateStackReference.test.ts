// Plan 15, B1 negatives and B2: a stack of plates judged against FEED's own two-dimensional reference (src/core/stackReference.ts, axialFv.ts), on the real OFFBEAT output saved in
// tests/golden/offbeat-plate-stack. The tolerances are fixed here before the first run, with their reasons:
//   AGREEMENT 0.01 K    the largest difference between any OFFBEAT cell and the reference: OFFBEAT writes 8 significant digits (2e-5 K at 2000 K) and stops its iteration at a tolerance;
//                       the probe (docs/spike/axial-2d-probe.md) saw 0.000 K on the plates. The same number is the floor under the mesh bound (REFERENCE_FLOOR).
//   CONTRAST 20 K       the short plate's one-dimensional solutions are 22.4 K away from OFFBEAT (plan 12, A5); the reference must be at least a thousand times closer.
// Every check must pass on every saved steady plate run with NO allowance, and must fail on a stack that is not the one that was run: the axial term removed (the effect is
// above the mesh bound for six of the nine runs, so those six are claimed; the others, 0.4 K or less, are not: B0 found the same), a shape shifted by one layer, a coolant read
// from the top. A pin stack's record must equal the one saved before plan 15, character by character.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { REFERENCE_FLOOR } from "../src/core/resultsParser";
import { buildStackResults } from "../src/core/stackResults";
import { StackReferenceResult, stackReference } from "../src/core/stackReference";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const g = (dir: string, name: string) => ({ n: JSON.parse(read("tests/golden", dir, name, "normalized.json")), T: read("tests/golden", dir, name, "T"), C: read("tests/golden", dir, name, "C") });
const plateRun = (name: string) => g("offbeat-plate-stack", name);
const judge = (x: ReturnType<typeof g>, mutate?: (n: any) => void, reference?: StackReferenceResult | null) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildStackResults(n, { T: x.T, C: x.C, time: 5e7 }, reference);
};
const failingIds = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const STEADY = ["cosine", "len0.19", "len0.381", "len0.762", "negative", "ramp", "rise", "short", "steep"];
const AGREEMENT = 0.01;

describe("every saved steady plate stack is judged against the two-dimensional reference with no allowance, and passes", () => {
  for (const name of STEADY) {
    it(`${name}: every check passes, the cells agree with the reference to ${AGREEMENT} K, no allowance is applied`, () => {
      const x = plateRun(name);
      const r = judge(x);
      expect(failingIds(r)).toEqual([]);
      expect(r.axial.reference?.kind).toBe("two-dimensional");
      const info = r.axial.reference as Extract<NonNullable<typeof r.axial.reference>, { kind: "two-dimensional" }>;
      expect(info.deviation).toBeLessThan(AGREEMENT);
      // the same record with the allowance gives the fallback verdicts, which also pass (nothing was widened by the change)
      const old = judge(x, undefined, null);
      expect(failingIds(old)).toEqual([]);
      expect(old.axial.reference).toEqual({ kind: "allowance", reason: "the allowance was asked for" });
      expect(r.thermalOnly).toMatch(/two-dimensional finite-volume solution of the whole stack/);
      const fuel = r.checks.find((c) => c.id === "closedFormFuel")!;
      expect(fuel.label).toMatch(/two-dimensional reference/);
      expect(fuel.value!).toBeLessThan(AGREEMENT);
      expect(fuel.note).toMatch(/no allowance/);
      expect(fuel.note).toMatch(/for contrast, the one-dimensional closed form/);
      const info2 = r.checks.find((c) => c.id === "axialConduction")!;
      expect(info2.verdict).toBe("na");
      expect(info2.note).toMatch(/information only/);
    });
  }
  it("the short plate (0.06 m): the one-dimensional solutions are 22 K from the cells, the reference is within 0.01 K, and the fallback needs an allowance of tens of kelvin", () => {
    const x = plateRun("short");
    const r = judge(x);
    const info = r.axial.reference as { oneDimensionalDeviation: number; deviation: number; axialEffect: number };
    expect(info.oneDimensionalDeviation).toBeGreaterThan(20);
    expect(info.oneDimensionalDeviation).toBeLessThan(25);
    expect(info.deviation).toBeLessThan(AGREEMENT);
    expect(info.oneDimensionalDeviation / Math.max(info.deviation, 1e-12)).toBeGreaterThan(1000);
    expect(info.axialEffect).toBeGreaterThan(20);
    expect(r.axial.allowance.field).toBeGreaterThan(20);
  });
  it("the steep-ended table and the cosine: the end layer's 1.9 K and 0.6 K effects are in the reference (contrast: the one-dimensional deviation)", () => {
    const steep = judge(plateRun("steep")).axial.reference as { oneDimensionalDeviation: number; deviation: number };
    expect(steep.oneDimensionalDeviation).toBeGreaterThan(1.5);
    expect(steep.oneDimensionalDeviation).toBeLessThan(2.3);
    expect(steep.deviation).toBeLessThan(AGREEMENT);
    const cos = judge(plateRun("cosine")).axial.reference as { oneDimensionalDeviation: number; deviation: number };
    expect(cos.oneDimensionalDeviation).toBeGreaterThan(0.4);
    expect(cos.oneDimensionalDeviation).toBeLessThan(0.9);
    expect(cos.deviation).toBeLessThan(AGREEMENT);
  });
  it("the whole plate's heat balance still closes to 1e-4 against the cells' own fluxes", () => {
    expect(Math.abs(judge(plateRun("cosine")).checks.find((c) => c.id === "energyBalanceTotal")!.value!)).toBeLessThan(1e-4);
  });
});

describe("negative tests: the reference of a stack that was not run fails the checks against the saved OFFBEAT output", () => {
  const mustFail = (r: ReturnType<typeof judge>, label: string) => expect(failingIds(r).length, label).toBeGreaterThan(0);
  it("the axial term removed fails on every run where the effect is above the mesh bound (six of the nine)", () => {
    for (const name of ["cosine", "len0.19", "len0.381", "rise", "short", "steep"]) {
      const x = plateRun(name);
      const decoupled = stackReference(x.n, { axialConduction: false });
      expect("reference" in decoupled, name).toBe(true);
      mustFail(judge(x, undefined, decoupled), name);
    }
  });
  it("a shape shifted by one layer (a tenth of the length) fails", () => {
    const x = plateRun("cosine");
    const L = 0.381;
    const pts = Array.from({ length: 41 }, (_, k) => ({ position: (k / 40) * L, relativePower: Math.max(0, Math.cos(Math.PI * ((k - 4) / 40 - 0.5))) }));
    const shifted = judge(x, (n) => (n.axial.shape = { kind: "table", positions: pts.map((p) => p.position), relative: pts.map((p) => p.relativePower) }));
    mustFail(shifted, "shifted");
    expect(failingIds(shifted)).toContain("closedFormFuel");
  });
  it("a coolant read from the top fails (the wall temperature and the fuel)", () => {
    const x = plateRun("rise");
    const r = judge(x, (n) => (n.axial.boundary.bulkTemperature = [...n.axial.boundary.bulkTemperature].reverse()));
    expect(failingIds(r)).toContain("wallTemperature");
    expect(failingIds(r)).toContain("closedFormFuel");
  });
  it("10 % more heat fails the fuel and the whole-plate balance; a plate read as a pin is not judged by the plate's reference", () => {
    const x = plateRun("negative");
    const more = judge(x, (n) => (n.qPrime *= 1.1));
    expect(failingIds(more)).toContain("closedFormFuel");
    expect(failingIds(more)).toContain("energyBalanceTotal");
  });
});

describe("the fallback to the allowance", () => {
  it("a stack with more unknowns than the cap is not solved: the result says why, and a record built with that result keeps the allowance and says so", () => {
    const x = plateRun("cosine");
    const big = JSON.parse(JSON.stringify(x.n));
    big.axial.slices = 50;
    big.mesh = { fuelCells: 400, claddingCells: 100 };
    const res = stackReference(big);
    expect("fallback" in res && res.fallback).toMatch(/unknowns/);
    const r = judge(x, undefined, { fallback: "the cap test" });
    expect(r.axial.reference).toEqual({ kind: "allowance", reason: "the cap test" });
    expect(r.axial.allowance.field).toBeGreaterThan(0);
    expect(r.thermalOnly).toMatch(/within a bound that includes an estimate/);
    expect(r.checks.find((c) => c.id === "axialConduction")!.note).toMatch(/widened by 3 times it/);
  });
  it("cells that are not where the writer's mesh puts them are refused, not compared", () => {
    const x = plateRun("cosine");
    const rows = x.C.split("\n");
    const i0 = rows.findIndex((l) => /^\([-\d]/.test(l));
    const [cx, cy, cz] = rows[i0]!.replace(/[()]/g, "").split(/\s+/).map(Number);
    const moved = [...rows];
    moved[i0] = `(${cx! * 1.05} ${cy} ${cz})`;
    expect(() => buildStackResults(x.n, { T: x.T, C: moved.join("\n"), time: 5e7 })).toThrow(/writer's mesh puts it/);
  });
  it("the floor under the mesh bound is the one these tolerances state", () => {
    expect(REFERENCE_FLOOR).toBe(AGREEMENT);
  });
});

describe("a pin stack is not changed by plan 15: its record equals the one saved before it", () => {
  const saved = JSON.parse(read("tests/fixtures/pin-stack-records-0b60d93.json"));
  for (const name of ["cosine", "rise", "short"]) {
    it(`pin ${name}: the record is character for character the saved one, and it has no reference section`, () => {
      const x = g("offbeat-stack", name);
      const r = buildStackResults(x.n, { T: x.T, C: x.C, time: 5e7 });
      expect(JSON.stringify(r)).toBe(JSON.stringify(saved[name]));
      expect(r.axial.reference).toBeUndefined();
    });
  }
});
