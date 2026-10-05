// Transfer intake (plan 05): the scripted-fake acceptance cases. Each refusal fires with its named code; the good cases map and
// conserve; a deliberately lossy mapping fails; a uniform field reproduces its total exactly.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { applyToCase, caseRevision, mapBoundary, mapHeating } from "../src/core/transfer";
import { validateCase } from "../src/core/validate";

const pin = JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-pin.json"), "utf8"));
const rev = caseRevision(pin);
const approval = { approver: "J. W.", time: "2026-10-05T12:00:00Z" };
const J_PER_MEV = 1.602176634e-13;

/** Four axial bins of 0.25 m on pin p1 plus a second pin p2; the scores are MeV per source particle. */
const bins = (scores = [4, 6, 6, 4], pinId = "p1") => scores.map((v, i) => ({ id: `${pinId}-${i}`, pin: pinId, z: { min: i * 0.25, max: (i + 1) * 0.25 }, value: v, relError: 0.01 }));
const source = (over: Record<string, unknown> = {}) => ({
  schema: "feed.heating-source/0.1",
  runId: "run-1",
  revision: "rev-a",
  score: "heating",
  scoreUnit: "MeV/source-particle",
  normalization: { kind: "source-rate", value: { value: 1e18, unit: "1/s" }, source: "power 20 kW at 200 MeV/fission" },
  bins: [...bins(), ...bins([1, 1, 1, 1], "p2")],
  ...over,
});
const recipe = (over: Record<string, unknown> = {}) => ({
  schema: "feed.transfer-recipe/0.1",
  kind: "heating",
  recipeId: "rcp-heat-1",
  approval,
  conservationTolerance: 1e-9,
  source: { runId: "run-1", revision: "rev-a", pin: "p1" },
  target: { caseRevision: rev },
  slices: [
    { id: "lower", z: { min: 0, max: 0.5 } },
    { id: "upper", z: { min: 0.5, max: 1 } },
  ],
  ...over,
});
const code = (r: any) => (r.ok ? "ok" : r.errors[0].code);

describe("heating: the good case", () => {
  it("converts per-source-particle scores to watts, maps to slices and conserves the total", () => {
    const r = mapHeating(recipe(), source(), pin) as any;
    expect(r.ok).toBe(true);
    const total = 20 * J_PER_MEV * 1e18; // 20 MeV-per-particle units summed over p1
    expect(r.totals.source).toBeCloseTo(total, 6);
    expect(r.totals.mapped).toBeCloseTo(total, 6);
    expect(r.slices.map((s: any) => s.id)).toEqual(["lower", "upper"]);
    expect(r.slices[0].power.value).toBeCloseTo(10 * J_PER_MEV * 1e18, 6);
    expect(r.slices[0].linearHeatRate.value).toBeCloseTo((10 * J_PER_MEV * 1e18) / 0.5, 6);
    expect(r.provenance).toMatchObject({ recipeId: "rcp-heat-1", runId: "run-1", sourceRevision: "rev-a", approval });
  });

  it("the other pin's bins do not enter pin p1's power", () => {
    const only = mapHeating(recipe(), source({ bins: bins() }), pin) as any;
    const both = mapHeating(recipe(), source(), pin) as any;
    expect(both.totals.mapped).toBeCloseTo(only.totals.mapped, 9);
  });

  it("total-power normalization scales by the share of the score over ALL bins", () => {
    const s = source({ scoreUnit: "J/source-particle", normalization: { kind: "total-power", value: { value: 30, unit: "kW" }, source: "core power" } });
    const r = mapHeating(recipe(), s, pin) as any;
    // p1 holds 20 of 24 score units
    expect(r.totals.mapped).toBeCloseTo(30000 * (20 / 24), 6);
  });

  it("W, W/m and W/m3 scores each map with the right basis and give the same watts", () => {
    const watts = bins([100, 150, 150, 100]);
    const w = mapHeating(recipe(), source({ scoreUnit: "W", normalization: undefined, bins: watts }), pin) as any;
    const perM = mapHeating(recipe(), source({ scoreUnit: "W/m", normalization: undefined, bins: watts.map((b) => ({ ...b, value: b.value / 0.25 })) }), pin) as any;
    const perV = mapHeating(recipe(), source({ scoreUnit: "W/m3", normalization: undefined, bins: watts.map((b) => ({ ...b, value: b.value / 1e-3, volume: { value: 1e-3, unit: "m3" } })) }), pin) as any;
    expect(w.totals.mapped).toBeCloseTo(500, 9);
    expect(perM.totals.mapped).toBeCloseTo(500, 9);
    expect(perV.totals.mapped).toBeCloseTo(500, 9);
  });

  it("a bin straddling a slice boundary is split by overlap, still conserving", () => {
    const r = mapHeating(recipe({ slices: [{ id: "a", z: { min: 0, max: 0.4 } }, { id: "b", z: { min: 0.4, max: 1 } }] }), source(), pin) as any;
    expect(r.ok).toBe(true);
    expect(r.totals.relativeDifference).toBeCloseTo(0, 12);
    // bin 1 (z 0.25-0.5, score 6) gives 0.15/0.25 of itself to slice a
    expect(r.slices[0].power.value).toBeCloseTo((4 + 6 * 0.6) * J_PER_MEV * 1e18, 6);
  });

  it("the Monte Carlo error is carried: independent bins combine in quadrature", () => {
    const r = mapHeating(recipe(), source(), pin) as any;
    const p = [4, 6];
    const expected = Math.sqrt(p.reduce((s, x) => s + (x * 0.01) ** 2, 0)) / p.reduce((s, x) => s + x, 0);
    expect(r.slices[0].relError).toBeCloseTo(expected, 9);
  });

  it("property: a uniform field over a uniform target reproduces the total exactly", () => {
    for (const n of [1, 2, 7]) {
      const bs = Array.from({ length: n }, (_, i) => ({ id: `u${i}`, pin: "p1", z: { min: i / n, max: (i + 1) / n }, value: 3, relError: 0 }));
      const r = mapHeating(recipe({ conservationTolerance: 1e-12 }), source({ bins: bs }), pin) as any;
      expect(r.ok).toBe(true);
      expect(r.totals.mapped).toBeCloseTo(3 * n * J_PER_MEV * 1e18, 4);
      expect(Math.abs(r.totals.relativeDifference)).toBeLessThan(1e-12);
    }
  });

  it("applying to a case sets q', keeps everything else, records the transfer and still validates", () => {
    const mapped = mapHeating(recipe(), source(), pin) as any;
    const doc = applyToCase(pin, { heating: { slice: mapped.slices[0], mapped } }) as any;
    expect(doc.power.linearHeatRate.unit).toBe("W/m");
    expect(doc.power.linearHeatRate.value).toBeCloseTo(mapped.slices[0].linearHeatRate.value, 9);
    expect(doc.materials).toEqual(pin.materials);
    expect(doc.provenance.transfers[0]).toMatchObject({ kind: "heating", sliceId: "lower", recipeId: "rcp-heat-1" });
    expect(validateCase(doc).ok).toBe(true);
    expect(pin.provenance).toBeUndefined(); // the original is untouched
  });
});

describe("heating: every refusal names its code", () => {
  it.each([
    ["no approval", () => mapHeating(recipe({ approval: undefined }), source(), pin), "E_RECIPE_INVALID"],
    ["blank approver", () => mapHeating(recipe({ approval: { approver: " ", time: approval.time } }), source(), pin), "E_RECIPE_INVALID"],
    ["unparsable approval time", () => mapHeating(recipe({ approval: { approver: "x", time: "tomorrow-ish" } }), source(), pin), "E_RECIPE_INVALID"],
    ["no tolerance", () => mapHeating(recipe({ conservationTolerance: undefined }), source(), pin), "E_RECIPE_INVALID"],
    ["tolerance of 100%", () => mapHeating(recipe({ conservationTolerance: 1 }), source(), pin), "E_RECIPE_INVALID"],
    ["duplicate slice ids", () => mapHeating(recipe({ slices: [{ id: "a", z: { min: 0, max: 0.5 } }, { id: "a", z: { min: 0.5, max: 1 } }] }), source(), pin), "E_RECIPE_INVALID"],
    ["not a recipe", () => mapHeating({ kind: "heating" }, source(), pin), "E_RECIPE_INVALID"],
    ["stale target case", () => mapHeating(recipe(), source(), { ...pin, name: "edited after approval" }), "E_STALE_REVISION"],
    ["stale source revision", () => mapHeating(recipe(), source({ revision: "rev-b" }), pin), "E_STALE_REVISION"],
    ["another source run", () => mapHeating(recipe(), source({ runId: "run-2" }), pin), "E_STALE_REVISION"],
    ["unknown unit", () => mapHeating(recipe(), source({ scoreUnit: "Btu/source-particle" }), pin), "E_UNITS"],
    ["missing unit", () => mapHeating(recipe(), source({ scoreUnit: undefined }), pin), "E_UNITS"],
    ["per-particle without normalization", () => mapHeating(recipe(), source({ normalization: undefined }), pin), "E_NORMALIZATION_MISSING"],
    ["normalization without its source", () => mapHeating(recipe(), source({ normalization: { kind: "source-rate", value: { value: 1e18, unit: "1/s" } } }), pin), "E_NORMALIZATION_MISSING"],
    ["source rate in the wrong unit", () => mapHeating(recipe(), source({ normalization: { kind: "source-rate", value: { value: 1e18, unit: "W" }, source: "x" } }), pin), "E_UNITS"],
    ["watts with a normalization on top (applied twice)", () => mapHeating(recipe(), source({ scoreUnit: "W" }), pin), "E_UNITS"],
    ["W/m3 without volumes", () => mapHeating(recipe(), source({ scoreUnit: "W/m3", normalization: undefined }), pin), "E_NORMALIZATION_MISSING"],
    ["missing uncertainty", () => mapHeating(recipe(), source({ bins: bins().map((b) => ({ ...b, relError: undefined })) }), pin), "E_UNCERTAINTY_MISSING"],
    ["negative score", () => mapHeating(recipe(), source({ bins: bins([4, -6, 6, 4]) }), pin), "E_SCHEMA_INVALID"],
    ["no bins for the pin", () => mapHeating(recipe({ source: { runId: "run-1", revision: "rev-a", pin: "p9" } }), source(), pin), "E_COVERAGE_INCOMPLETE"],
    ["a gap in the axial coverage", () => mapHeating(recipe(), source({ bins: bins().filter((_, i) => i !== 1) }), pin), "E_COVERAGE_INCOMPLETE"],
    ["bins end short of the slice", () => mapHeating(recipe({ slices: [{ id: "all", z: { min: 0, max: 1.5 } }] }), source(), pin), "E_COVERAGE_INCOMPLETE"],
  ])("%s", (_n, f, c) => expect(code(f())).toBe(c));

  it("a deliberately lossy mapping (slices cover only half the pin's bins) fails conservation", () => {
    const r = mapHeating(recipe({ slices: [{ id: "lower", z: { min: 0, max: 0.5 } }] }), source(), pin) as any;
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("E_CONSERVATION");
    expect(r.errors[0].message).toMatch(/-50\.0000%/);
  });

  it("a mapping that loses a little still fails when the tolerance is tighter than the loss", () => {
    const lossy = recipe({ conservationTolerance: 1e-6, slices: [{ id: "a", z: { min: 0, max: 0.4999 } }, { id: "b", z: { min: 0.4999, max: 0.9999 } }] });
    expect(code(mapHeating(lossy, source(), pin))).toBe("E_CONSERVATION");
    expect(code(mapHeating({ ...lossy, conservationTolerance: 0.01 }, source(), pin))).toBe("ok");
  });

  it("refusals never produce a partial result", () => {
    const r = mapHeating(recipe({ approval: undefined }), source(), pin) as any;
    expect(Object.keys(r).sort()).toEqual(["errors", "ok"]);
  });
});

describe("boundary from a coolant source", () => {
  const coolant = (over: Record<string, unknown> = {}) => ({
    schema: "feed.coolant-source/0.1",
    runId: "n-1",
    revision: "n-rev-1",
    region: { id: "core-mid", z: { min: 0, max: 1 } },
    bulkTemperature: { value: 573, unit: "K" },
    heatTransferCoefficient: { value: 30000, unit: "W/m2/K" },
    pressure: { value: 15.5, unit: "MPa", convention: "absolute" },
    ...over,
  });
  const brecipe = (over: Record<string, unknown> = {}) => ({
    schema: "feed.transfer-recipe/0.1",
    kind: "boundary",
    recipeId: "rcp-bc-1",
    approval,
    source: { runId: "n-1", revision: "n-rev-1", regionId: "core-mid" },
    target: { caseRevision: rev },
    boundaryForm: "bulk-plus-h",
    slice: { id: "mid", z: { min: 0.2, max: 0.6 } },
    ...over,
  });

  it("bulk plus h maps to the case's convective boundary and the case validates", () => {
    const r = mapBoundary(brecipe(), coolant(), pin) as any;
    expect(r.ok).toBe(true);
    expect(r.boundary).toEqual({ bulkTemperature: { value: 573, unit: "K" }, heatTransferCoefficient: { value: 30000, unit: "W/m2/K" } });
    const doc = applyToCase(pin, { boundary: r }) as any;
    expect(validateCase(doc).ok).toBe(true);
    expect(doc.provenance.transfers[0]).toMatchObject({ kind: "boundary", regionId: "core-mid" });
  });

  it("a prescribed surface temperature maps to the surface-temperature form", () => {
    const r = mapBoundary(brecipe({ boundaryForm: "surface-temperature" }), coolant({ bulkTemperature: undefined, heatTransferCoefficient: undefined, surfaceTemperature: { value: 600, unit: "degC" } }), pin) as any;
    expect(r.boundary).toEqual({ surfaceTemperature: { value: 600, unit: "degC" } });
    expect(validateCase(applyToCase(pin, { boundary: r }) as any).ok).toBe(true);
  });

  it.each([
    ["bulk temperature alone", () => mapBoundary(brecipe(), coolant({ heatTransferCoefficient: undefined }), pin), "E_BOUNDARY_INCOMPLETE"],
    ["no form chosen", () => mapBoundary(brecipe({ boundaryForm: undefined }), coolant(), pin), "E_BOUNDARY_INCOMPLETE"],
    ["both forms supplied for bulk-plus-h", () => mapBoundary(brecipe(), coolant({ surfaceTemperature: { value: 600, unit: "K" } }), pin), "E_BOUNDARY_INCOMPLETE"],
    ["surface form with bulk values present", () => mapBoundary(brecipe({ boundaryForm: "surface-temperature" }), coolant({ surfaceTemperature: { value: 600, unit: "K" } }), pin), "E_BOUNDARY_INCOMPLETE"],
    ["surface form with no surface temperature", () => mapBoundary(brecipe({ boundaryForm: "surface-temperature" }), coolant({ bulkTemperature: undefined, heatTransferCoefficient: undefined }), pin), "E_BOUNDARY_INCOMPLETE"],
    ["wrong temperature unit", () => mapBoundary(brecipe(), coolant({ bulkTemperature: { value: 573, unit: "F" } }), pin), "E_UNITS"],
    ["wrong h unit", () => mapBoundary(brecipe(), coolant({ heatTransferCoefficient: { value: 30000, unit: "W/m2" } }), pin), "E_UNITS"],
    ["pressure without a convention", () => mapBoundary(brecipe(), coolant({ pressure: { value: 15.5, unit: "MPa" } }), pin), "E_UNITS"],
    ["non-positive h", () => mapBoundary(brecipe(), coolant({ heatTransferCoefficient: { value: 0, unit: "W/m2/K" } }), pin), "E_OUT_OF_RANGE"],
    ["another region", () => mapBoundary(brecipe(), coolant({ region: { id: "core-top", z: { min: 0, max: 1 } } }), pin), "E_COVERAGE_INCOMPLETE"],
    ["slice outside the region (no extrapolation)", () => mapBoundary(brecipe({ slice: { id: "top", z: { min: 0.8, max: 1.2 } } }), coolant(), pin), "E_COVERAGE_INCOMPLETE"],
    ["stale source", () => mapBoundary(brecipe(), coolant({ revision: "n-rev-2" }), pin), "E_STALE_REVISION"],
    ["stale case", () => mapBoundary(brecipe(), coolant(), { ...pin, name: "changed" }), "E_STALE_REVISION"],
    ["unapproved recipe", () => mapBoundary(brecipe({ approval: {} }), coolant(), pin), "E_RECIPE_INVALID"],
  ])("%s", (_n, f, c) => expect(code(f())).toBe(c));
});

describe("revisions", () => {
  it("caseRevision ignores key order and changes with any value", () => {
    expect(caseRevision({ a: 1, b: { c: 2, d: 3 } })).toBe(caseRevision({ b: { d: 3, c: 2 }, a: 1 }));
    expect(caseRevision({ a: 1 })).not.toBe(caseRevision({ a: 2 }));
  });
});
