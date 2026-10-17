// The Codex review of 2026-10-17 (plan 15 B4 to B7, the interface allowance, plan 14 stage E, plan 13 T4 and T6): the findings confirmed against the code, and a test for each fix. Each
// test was run against the code before the fix and failed there (the fixes are one commit; `git stash` of src shows it).
//   R1-1  the steady two-dimensional solve had no cost bound (27 s on the server thread for 50 layers of 130 cells with k(T))
//   R3-1  a population request started a worker at once however many were running; R3-2 without the compiled worker the route ran on the server thread without a deadline
//   R3-3  a compact with a packing fraction of 5e-324 was accepted with an infinite power per particle
//   (R3-4, a population draw's total size, was checked and is not a defect: an ordinary case checks each length, not the sum, either; no change)
//   R4-1  another mixture law got the 2 % bound of Maxwell-Eucken and a passing domain verdict
//   R4-4  a `compact` block on a coated particle was silently ignored
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { MIXTURE_ERROR_BOUND, PACKING_MIN, mixtureDomainMessage, mixtureErrorBound, mixtureLawNote } from "../src/core/compact";
import { stackReference, stackSteadyBandWork, STACK_STEADY_BAND_WORK_MAX, axialField2d } from "../src/core/stackReference";
import { validateCase } from "../src/core/validate";
import { POPULATION_MAX_JOBS, populationFor } from "../src/server/server";

const root = join(__dirname, "..");
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
const ex = (f: string) => read("examples/" + f);
const q = (value: number, unit: string) => ({ value, unit });
const codes = (v: { errors: { code: string; field: string }[] }) => v.errors.map((e) => e.code + " " + e.field);

describe("a compact's packing fraction and mixture law (R3-3, R4-1)", () => {
  const compact = (mutate: (d: any) => void) => {
    const d = ex("synthetic-compact-steady.json");
    mutate(d);
    return validateCase(d);
  };
  it("a packing fraction below the stated minimum is refused, and the smallest one allowed gives a finite power per particle", () => {
    expect(PACKING_MIN).toBe(1e-3);
    for (const pf of [5e-324, 1e-12, 9.99e-4]) {
      const v = compact((d) => (d.compact.packingFraction = q(pf, "1")));
      expect(v.ok, String(pf)).toBe(false);
      expect(codes(v)).toContain("E_OUT_OF_RANGE /compact/packingFraction");
    }
    const edge = compact((d) => (d.compact.packingFraction = q(PACKING_MIN, "1")));
    expect(edge.errors.filter((e) => e.field.includes("packingFraction"))).toEqual([]);
    expect(Number.isFinite(edge.normalized?.compact?.particlePower)).toBe(true);
  });
  it("a power density so large that the power per particle overflows is refused, not accepted with an infinite power", () => {
    const v = compact((d) => (d.compact.powerDensity = q(1e308, "W/m3")));
    expect(codes(v).join("|")).toMatch(/E_OUT_OF_RANGE \/compact\/powerDensity/);
  });
  it("the 2 % bound belongs to Maxwell-Eucken: the other laws carry their own figure and a note that the bound does not hold for them, the domain message itself does not depend on the law", () => {
    expect(mixtureErrorBound("maxwell-eucken")).toBe(MIXTURE_ERROR_BOUND);
    expect(mixtureErrorBound("bruggeman")).toBe(0.13);
    expect(mixtureErrorBound("differential")).toBe(0.05);
    expect(mixtureLawNote("maxwell-eucken")).toBeUndefined();
    for (const law of ["bruggeman", "differential"] as const) {
      const msg = mixtureLawNote(law);
      expect(msg, law).toMatch(new RegExp("measured for the maxwell-eucken law; the " + law + " law's error"));
      expect(msg).toContain((mixtureErrorBound(law) * 100).toFixed(0) + " %");
    }
    // the packing-and-contrast message (the validator's W_MIXTURE_RANGE) is about the domain only: inside it, whatever the law, there is none
    const inside = { packingFraction: 0.3, contrast: [0.5, 2] as [number, number] };
    for (const law of ["maxwell-eucken", "bruggeman", "differential"] as const) expect(mixtureDomainMessage({ ...inside, law }), law).toBeUndefined();
    // an unknown name has no figure at all: the bound is 1 (100 %), never the 2 % of the default
    expect(mixtureErrorBound("not-a-law")).toBe(1);
  });
});

describe("a compact block on a coated particle (R4-4)", () => {
  it("is refused, naming the block, instead of being ignored", () => {
    const d = ex("synthetic-triso-compact-steady.json");
    expect(validateCase(d).ok).toBe(true);
    d.compact = ex("synthetic-compact-steady.json").compact;
    const v = validateCase(d);
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain("E_UNSUPPORTED /compact");
  });
  it("the pebble and the compact pin, which use the block, are still accepted", () => {
    expect(validateCase(ex("synthetic-compact-steady.json")).ok).toBe(true);
    expect(validateCase(ex("synthetic-pebble-steady.json")).ok).toBe(true);
  });
});

describe("the cost of the steady two-dimensional reference (R1-1)", () => {
  function plateStack(slices: number, fuelCells: number, claddingCells: number) {
    const d = ex("synthetic-pin.json");
    d.caseId = "cost";
    d.assumptions.geometry = "1D-slab";
    d.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
    d.power.linearHeatRate = q(200000, "W/m");
    d.mesh = { fuelCells, claddingCells };
    d.axial = { length: q(0.381, "m"), slices, powerShape: { kind: "cosine" } };
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    return v.normalized!;
  }
  it("the work of a case is slices x (cells of a layer)^3, the cap is 2e7", () => {
    expect(STACK_STEADY_BAND_WORK_MAX).toBe(2e7);
    expect(stackSteadyBandWork(plateStack(10, 20, 6))).toBe(10 * 26 ** 3);
    expect(stackSteadyBandWork(plateStack(50, 100, 30))).toBe(50 * 130 ** 3);
  });
  it("a case over the cap is not solved: the reference falls back with the reason, at once, in the check and in a run", () => {
    const big = plateStack(50, 100, 30); // 27 s measured on the server thread with k(T); constant k is quicker, the cap does not look at it
    const t0 = Date.now();
    const r = stackReference(big);
    expect("fallback" in r && r.fallback).toMatch(/more work \(1\.10e\+8\) than the 2e\+7 the steady reference solves/);
    const f = axialField2d(big);
    expect(f && !f.available && f.reason).toMatch(/not computed/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("a case under the cap is still solved", () => {
    const small = plateStack(10, 20, 6);
    expect("reference" in stackReference(small)).toBe(true);
    const f = axialField2d(small);
    expect(f && f.available).toBe(true);
  });
});

describe("the population route's limits (R3-1, R3-2)", () => {
  function particle(size: number) {
    const c = read("schema/vectors/good/triso-steady.json");
    c.power = { kernelPowerDensity: q(600, "MW/m3") };
    c.population = { size, seed: 1, distributions: { kernelRadius: { kind: "normal", mean: q(250, "um"), stdDev: q(5, "um") } } };
    return c;
  }
  it("without the compiled worker the route refuses (503) instead of running the batch on the server thread", async () => {
    const r = await populationFor(particle(100), 5000, { workerFile: null });
    expect(r.status).toBe(503);
    expect((r.body as { reason: string }).reason).toBe("no-worker");
  });
  it("at most POPULATION_MAX_JOBS populations run at once: the next request is answered 429 at once, and a slot is free again when they finish", async () => {
    expect(POPULATION_MAX_JOBS).toBe(2);
    const slow = particle(100000);
    const first = populationFor(slow, 30000);
    const second = populationFor(slow, 30000);
    const t0 = Date.now();
    const third = await populationFor(slow, 30000);
    expect(third.status).toBe(429);
    expect((third.body as { reason: string }).reason).toBe("busy");
    expect(Date.now() - t0).toBeLessThan(1000);
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const after = await populationFor(particle(100), 30000);
    expect(after.status).toBe(200);
  }, 120_000);
});
