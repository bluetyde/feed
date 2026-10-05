// Transfer intake (plan 05): the scripted-fake acceptance cases, then every finding of the Codex F3 exit review as a test.
// Each refusal fires with its named code; the good cases map and conserve; a deliberately lossy mapping fails; a uniform field
// reproduces its total exactly.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { applyToCase, approveRecipe, caseRevision, mapBoundary, mapHeating, recipeDigest } from "../src/core/transfer";
import { validateCase } from "../src/core/validate";

const pin = JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-pin.json"), "utf8"));
const rev = caseRevision(pin);
const WHEN = "2026-10-05T12:00:00Z";
const J_PER_MEV = 1.602176634e-13;

/** Four axial bins of 0.25 m on pin p1 plus a second pin p2; the scores are MeV per source particle. */
const bins = (scores = [4, 6, 6, 4], pinId = "p1") => scores.map((v, i) => ({ id: `${pinId}-${i}`, pin: pinId, z: { min: i * 0.25, max: (i + 1) * 0.25 }, value: v, relError: 0.01 }));
const source = (over: Record<string, unknown> = {}) => ({
  schema: "feed.heating-source/0.1",
  runId: "run-1",
  revision: "rev-a",
  score: "heating",
  scoreUnit: "MeV/source-particle",
  frame: "pin-axis z up, m, origin at bottom of fuel",
  temporal: "steady",
  normalization: { kind: "source-rate", value: { value: 1e18, unit: "1/s" }, source: "power 20 kW at 200 MeV/fission" },
  bins: [...bins(), ...bins([1, 1, 1, 1], "p2")],
  ...over,
});
const recipeBody = (over: Record<string, unknown> = {}) => ({
  schema: "feed.transfer-recipe/0.1",
  kind: "heating",
  recipeId: "rcp-heat-1",
  conservationTolerance: 1e-9,
  source: { runId: "run-1", revision: "rev-a", pin: "p1", score: "heating", frame: "pin-axis z up, m, origin at bottom of fuel" },
  target: { caseRevision: rev },
  slices: [
    { id: "lower", z: { min: 0, max: 0.5 } },
    { id: "upper", z: { min: 0.5, max: 1 } },
  ],
  ...over,
});
/** An approved recipe: the approval covers the content given. */
const recipe = (over: Record<string, unknown> = {}) => approveRecipe(recipeBody(over), "J. W.", WHEN);
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
    expect(r.provenance).toMatchObject({ recipeId: "rcp-heat-1", runId: "run-1", sourceRevision: "rev-a", targetRevision: rev, score: "heating", approval: { approver: "J. W.", time: WHEN } });
  });

  it("the other pin's bins do not enter pin p1's power", () => {
    const only = mapHeating(recipe(), source({ bins: bins() }), pin) as any;
    const both = mapHeating(recipe(), source(), pin) as any;
    expect(both.totals.mapped).toBeCloseTo(only.totals.mapped, 9);
  });

  it("total-power normalization scales by the share of the score over ALL bins, over a stated domain", () => {
    const s = source({ scoreUnit: "J/source-particle", normalization: { kind: "total-power", value: { value: 30, unit: "kW" }, source: "core power", domain: { binCount: 8, scoreTotal: 24 } } });
    const r = mapHeating(recipe(), s, pin) as any;
    expect(r.totals.mapped).toBeCloseTo(30000 * (20 / 24), 6); // p1 holds 20 of 24 score units
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
    expect(r.slices[0].power.value).toBeCloseTo((4 + 6 * 0.6) * J_PER_MEV * 1e18, 6); // bin 1 gives 0.15/0.25 of itself to a
  });

  it("the Monte Carlo error is carried: independent bins combine in quadrature", () => {
    const r = mapHeating(recipe(), source(), pin) as any;
    const p = [4, 6];
    expect(r.slices[0].relError).toBeCloseTo(Math.sqrt(p.reduce((s, x) => s + (x * 0.01) ** 2, 0)) / p.reduce((s, x) => s + x, 0), 9);
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
    const r = applyToCase(pin, { heating: { slice: mapped.slices[0], mapped } }) as any;
    expect(r.ok).toBe(true);
    const doc = r.doc;
    expect(doc.power.linearHeatRate.unit).toBe("W/m");
    expect(doc.power.linearHeatRate.value).toBeCloseTo(mapped.slices[0].linearHeatRate.value, 9);
    expect(doc.materials).toEqual(pin.materials);
    expect(doc.provenance.transfers[0]).toMatchObject({ kind: "heating", sliceId: "lower", recipeId: "rcp-heat-1", score: "heating" });
    expect(validateCase(doc).ok).toBe(true);
    expect(pin.provenance).toBeUndefined(); // the original is untouched
  });
});

describe("heating: every refusal names its code", () => {
  const tweak = (f: (r: any) => void) => {
    const r: any = recipe();
    f(r);
    return r;
  };
  it.each([
    ["no approval", () => mapHeating({ ...recipeBody() }, source(), pin), "E_RECIPE_INVALID"],
    ["blank approver", () => mapHeating(approveRecipe(recipeBody(), " ", WHEN), source(), pin), "E_RECIPE_INVALID"],
    ["unparsable approval time", () => mapHeating(approveRecipe(recipeBody(), "x", "tomorrow-ish"), source(), pin), "E_RECIPE_INVALID"],
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
    ["no bins for the pin", () => mapHeating(recipe({ source: { runId: "run-1", revision: "rev-a", pin: "p9", score: "heating", frame: "pin-axis z up, m, origin at bottom of fuel" } }), source(), pin), "E_COVERAGE_INCOMPLETE"],
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
    const slices = [{ id: "a", z: { min: 0, max: 0.4999 } }, { id: "b", z: { min: 0.4999, max: 0.9999 } }];
    expect(code(mapHeating(recipe({ conservationTolerance: 1e-6, slices }), source(), pin))).toBe("E_CONSERVATION");
    expect(code(mapHeating(recipe({ conservationTolerance: 0.01, slices }), source(), pin))).toBe("ok");
  });

  it("refusals never produce a partial result", () => {
    const r = mapHeating({ ...recipeBody() }, source(), pin) as any;
    expect(Object.keys(r).sort()).toEqual(["errors", "ok"]);
  });

  void tweak;
});

describe("Codex F3 review: approval is bound to the recipe content", () => {
  it("changing the tolerance after approval invalidates the approval (the half-pin mapping cannot be forced through)", () => {
    const approved: any = recipe({ slices: [{ id: "lower", z: { min: 0, max: 0.5 } }] });
    expect(code(mapHeating(approved, source(), pin))).toBe("E_CONSERVATION");
    const edited = { ...approved, conservationTolerance: 0.6 };
    const r = mapHeating(edited, source(), pin) as any;
    expect(r.errors[0]).toMatchObject({ code: "E_RECIPE_INVALID", field: "/approval/recipeDigest" });
  });

  it.each([
    ["the slices", (r: any) => (r.slices[1].z.max = 2)],
    ["the source pin", (r: any) => (r.source.pin = "p2")],
    ["the target revision", (r: any) => (r.target.caseRevision = "0".repeat(64))],
    ["the recipe id", (r: any) => (r.recipeId = "other")],
  ])("changing %s after approval invalidates it", (_n, edit) => {
    const r: any = structuredClone(recipe());
    edit(r);
    expect(mapHeating(r, source(), pin)).toMatchObject({ ok: false, errors: [{ code: "E_RECIPE_INVALID", field: "/approval/recipeDigest" }] });
  });

  it("the digest ignores the approval itself and key order", () => {
    const body = recipeBody();
    expect(recipeDigest(body)).toBe(recipeDigest({ ...body, approval: { approver: "x" } }));
    expect(recipeDigest({ a: 1, b: 2 })).toBe(recipeDigest({ b: 2, a: 1 }));
  });
});

describe("Codex F3 review: slices, bins and normalization domain", () => {
  it("overlapping slices are refused (they could hide an uncovered half)", () => {
    const r = mapHeating(recipe({ slices: [{ id: "a", z: { min: 0, max: 0.5 } }, { id: "b", z: { min: 0, max: 0.5 } }] }), source({ bins: [{ id: "x", pin: "p1", z: { min: 0, max: 1 }, value: 4, relError: 0 }] }), pin) as any;
    expect(r.errors[0]).toMatchObject({ code: "E_RECIPE_INVALID", field: "/slices" });
    expect(code(mapHeating(recipe({ slices: [{ id: "a", z: { min: 0, max: 0.5 } }, { id: "b", z: { min: 0.25, max: 0.75 } }] }), source(), pin))).toBe("E_RECIPE_INVALID");
  });

  it("touching slices are fine", () => {
    expect(code(mapHeating(recipe(), source(), pin))).toBe("ok");
  });

  it("a repeated bin id (a duplicated record) is refused, not summed", () => {
    const dup = [...bins(), bins()[0]!];
    expect(mapHeating(recipe(), source({ bins: dup }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_SCHEMA_INVALID" }] });
  });

  it("a bin id reused by another pin is refused too (ids identify records across the whole source)", () => {
    const clash = [...bins(), { ...bins([1], "p2")[0]!, id: "p1-0" }];
    expect(mapHeating(recipe(), source({ bins: clash }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_SCHEMA_INVALID", field: "/source/bins/4/id" }] });
  });

  it("bins of the target pin that overlap in z are refused", () => {
    const over = bins();
    over[1] = { ...over[1]!, z: { min: 0.2, max: 0.5 } };
    expect(mapHeating(recipe(), source({ bins: over }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_SCHEMA_INVALID", field: "/source/bins" }] });
  });

  it("a total power over a partial export is refused: the stated domain does not match the bins supplied", () => {
    const norm = { kind: "total-power", value: { value: 1, unit: "kW" }, source: "core", domain: { binCount: 8, scoreTotal: 24 } };
    const base = { scoreUnit: "J/source-particle", normalization: norm };
    expect(code(mapHeating(recipe(), source({ ...base, bins: [...bins(), ...bins([1, 1, 1, 1], "p2")] }), pin))).toBe("ok");
    expect(mapHeating(recipe(), source({ ...base, bins: bins() }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_NORMALIZATION_DOMAIN", field: "/source/normalization/domain/binCount" }] });
    // same count but a different total
    expect(mapHeating(recipe(), source({ ...base, bins: [...bins(), ...bins([2, 2, 2, 2], "p2")] }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_NORMALIZATION_DOMAIN", field: "/source/normalization/domain/scoreTotal" }] });
  });

  it("a total power with no domain statement is refused", () => {
    const norm = { kind: "total-power", value: { value: 1, unit: "kW" }, source: "core" };
    expect(code(mapHeating(recipe(), source({ scoreUnit: "J/source-particle", normalization: norm }), pin))).toBe("E_NORMALIZATION_MISSING");
  });
});

describe("Codex F3 review: score, frame and time", () => {
  it("a missing, different or unapproved score is refused", () => {
    expect(mapHeating(recipe(), source({ score: undefined }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_SCORE_MISMATCH" }] });
    expect(mapHeating(recipe(), source({ score: "flux" }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_SCORE_MISMATCH" }] });
    expect(code(mapHeating(recipe({ source: { runId: "run-1", revision: "rev-a", pin: "p1", frame: "f" } }), source(), pin))).toBe("E_RECIPE_INVALID");
  });

  it("a different or missing coordinate frame is refused without a transform", () => {
    expect(mapHeating(recipe(), source({ frame: "bottom-up, cm" }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_FRAME_MISMATCH" }] });
    expect(mapHeating(recipe(), source({ frame: undefined }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_FRAME_MISMATCH" }] });
  });

  it("a source that is not steady (or does not say) is refused", () => {
    expect(mapHeating(recipe(), source({ temporal: "transient" }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_UNSUPPORTED" }] });
    expect(mapHeating(recipe(), source({ temporal: undefined }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_UNSUPPORTED" }] });
  });
});

describe("Codex F3 review: numerics", () => {
  it("a conversion that overflows to Infinity is refused, never returned as ok", () => {
    const huge = bins([1, 1, 1, 1]).map((b) => ({ ...b, value: 1e308, volume: { value: 2, unit: "m3" } }));
    expect(mapHeating(recipe(), source({ scoreUnit: "W/m3", normalization: undefined, bins: huge }), pin)).toMatchObject({ ok: false, errors: [{ code: "E_NUMERIC" }] });
  });

  it("a heat rate that overflows only when divided by a very short slice is refused", () => {
    const thin = [{ id: "t", pin: "p1", z: { min: 0, max: 1e-10 }, value: 1e300, relError: 0 }];
    const r = mapHeating(recipe({ slices: [{ id: "s", z: { min: 0, max: 1e-10 } }] }), source({ scoreUnit: "W", normalization: undefined, bins: thin }), pin);
    expect(r).toMatchObject({ ok: false, errors: [{ code: "E_NUMERIC", field: "/slices/s" }] });
  });

  it("non-finite inputs are refused at the bin", () => {
    expect(code(mapHeating(recipe(), source({ bins: bins([4, Infinity, 6, 4]) }), pin))).toBe("E_SCHEMA_INVALID");
    expect(code(mapHeating(recipe(), source({ bins: bins([4, NaN, 6, 4]) }), pin))).toBe("E_SCHEMA_INVALID");
  });

  it("the coverage tolerance is relative: a bin a thousandth of a slice long does not cover it", () => {
    const tiny = [{ id: "t", pin: "p1", z: { min: 0, max: 1e-15 }, value: 4, relError: 0 }];
    const r = mapHeating(recipe({ slices: [{ id: "s", z: { min: 0, max: 1e-12 } }] }), source({ bins: tiny }), pin);
    expect(code(r)).toBe("E_COVERAGE_INCOMPLETE");
  });
});

describe("boundary from a coolant source", () => {
  const coolant = (over: Record<string, unknown> = {}) => ({
    schema: "feed.coolant-source/0.1",
    runId: "n-1",
    revision: "n-rev-1",
    frame: "pin-axis z up, m, origin at bottom of fuel",
    temporal: "steady",
    region: { id: "core-mid", z: { min: 0, max: 1 } },
    bulkTemperature: { value: 573, unit: "K" },
    heatTransferCoefficient: { value: 30000, unit: "W/m2/K" },
    pressure: { value: 15.5, unit: "MPa", convention: "absolute" },
    ...over,
  });
  const brecipe = (over: Record<string, unknown> = {}) =>
    approveRecipe(
      {
        schema: "feed.transfer-recipe/0.1",
        kind: "boundary",
        recipeId: "rcp-bc-1",
        source: { runId: "n-1", revision: "n-rev-1", regionId: "core-mid", frame: "pin-axis z up, m, origin at bottom of fuel" },
        target: { caseRevision: rev },
        boundaryForm: "bulk-plus-h",
        slice: { id: "mid", z: { min: 0.2, max: 0.6 } },
        ...over,
      },
      "J. W.",
      WHEN,
    );

  it("bulk plus h maps to the case's convective boundary and the case validates", () => {
    const r = mapBoundary(brecipe(), coolant(), pin) as any;
    expect(r.ok).toBe(true);
    expect(r.boundary).toEqual({ bulkTemperature: { value: 573, unit: "K" }, heatTransferCoefficient: { value: 30000, unit: "W/m2/K" } });
    expect(r.slice).toEqual({ id: "mid", z: { min: 0.2, max: 0.6 } });
    const a = applyToCase(pin, { boundary: r }) as any;
    expect(a.ok).toBe(true);
    expect(validateCase(a.doc).ok).toBe(true);
    expect(a.doc.provenance.transfers[0]).toMatchObject({ kind: "boundary", regionId: "core-mid", sliceId: "mid" });
  });

  it("a prescribed surface temperature maps to the surface-temperature form", () => {
    const r = mapBoundary(brecipe({ boundaryForm: "surface-temperature" }), coolant({ bulkTemperature: undefined, heatTransferCoefficient: undefined, surfaceTemperature: { value: 600, unit: "degC" } }), pin) as any;
    expect(r.boundary).toEqual({ surfaceTemperature: { value: 600, unit: "degC" } });
    expect(validateCase((applyToCase(pin, { boundary: r }) as any).doc).ok).toBe(true);
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
    ["bulk below absolute zero", () => mapBoundary(brecipe(), coolant({ bulkTemperature: { value: -300, unit: "degC" } }), pin), "E_OUT_OF_RANGE"],
    ["surface temperature of 0 K", () => mapBoundary(brecipe({ boundaryForm: "surface-temperature" }), coolant({ bulkTemperature: undefined, heatTransferCoefficient: undefined, surfaceTemperature: { value: 0, unit: "K" } }), pin), "E_OUT_OF_RANGE"],
    ["another region", () => mapBoundary(brecipe(), coolant({ region: { id: "core-top", z: { min: 0, max: 1 } } }), pin), "E_COVERAGE_INCOMPLETE"],
    ["a zero-length region", () => mapBoundary(brecipe({ slice: { id: "s", z: { min: 0, max: 1e-12 } } }), coolant({ region: { id: "core-mid", z: { min: 0, max: 0 } } }), pin), "E_COVERAGE_INCOMPLETE"],
    ["slice outside the region (no extrapolation)", () => mapBoundary(brecipe({ slice: { id: "top", z: { min: 0.8, max: 1.2 } } }), coolant(), pin), "E_COVERAGE_INCOMPLETE"],
    ["stale source", () => mapBoundary(brecipe(), coolant({ revision: "n-rev-2" }), pin), "E_STALE_REVISION"],
    ["stale case", () => mapBoundary(brecipe(), coolant(), { ...pin, name: "changed" }), "E_STALE_REVISION"],
    ["unapproved recipe", () => mapBoundary({ ...(brecipe() as any), approval: {} }, coolant(), pin), "E_RECIPE_INVALID"],
    ["a recipe edited after approval", () => mapBoundary({ ...(brecipe() as any), boundaryForm: "surface-temperature" }, coolant(), pin), "E_RECIPE_INVALID"],
    ["a different coordinate frame", () => mapBoundary(brecipe(), coolant({ frame: "top-down" }), pin), "E_FRAME_MISMATCH"],
    ["a transient source", () => mapBoundary(brecipe(), coolant({ temporal: "transient" }), pin), "E_UNSUPPORTED"],
    ["a source that does not say steady", () => mapBoundary(brecipe(), coolant({ temporal: undefined }), pin), "E_UNSUPPORTED"],
  ])("%s", (_n, f, c) => expect(code(f())).toBe(c));
});

describe("Codex F3 review: applying mappings", () => {
  const heating = () => mapHeating(recipe(), source(), pin) as any;
  const boundary = (slice = { id: "lower-bc", z: { min: 0, max: 0.5 } }) =>
    mapBoundary(
      approveRecipe(
        { schema: "feed.transfer-recipe/0.1", kind: "boundary", recipeId: "bc", source: { runId: "n-1", revision: "n-rev-1", regionId: "r", frame: "pin-axis z up, m, origin at bottom of fuel" }, target: { caseRevision: rev }, boundaryForm: "bulk-plus-h", slice },
        "J. W.",
        WHEN,
      ),
      { schema: "feed.coolant-source/0.1", runId: "n-1", revision: "n-rev-1", frame: "pin-axis z up, m, origin at bottom of fuel", temporal: "steady", region: { id: "r", z: { min: 0, max: 1 } }, bulkTemperature: { value: 573, unit: "K" }, heatTransferCoefficient: { value: 30000, unit: "W/m2/K" } },
      pin,
    ) as any;

  it("a case edited after the mappings were approved is refused", () => {
    const h = heating();
    const edited = { ...pin, name: "edited" };
    expect(applyToCase(edited, { heating: { slice: h.slices[0], mapped: h } })).toMatchObject({ ok: false, errors: [{ code: "E_STALE_REVISION" }] });
    expect(applyToCase(edited, { boundary: boundary() })).toMatchObject({ ok: false, errors: [{ code: "E_STALE_REVISION" }] });
  });

  it("a heating slice and a boundary slice at different heights are refused", () => {
    const h = heating();
    const r = applyToCase(pin, { heating: { slice: h.slices[0], mapped: h }, boundary: boundary({ id: "upper-bc", z: { min: 0.5, max: 1 } }) });
    expect(r).toMatchObject({ ok: false, errors: [{ code: "E_COVERAGE_INCOMPLETE", field: "/boundary/slice" }] });
    const same = applyToCase(pin, { heating: { slice: h.slices[0], mapped: h }, boundary: boundary() });
    expect(same.ok).toBe(true);
  });

  it("a slice that is not part of the mapping is refused", () => {
    const h = heating();
    const forged = { ...h.slices[0], linearHeatRate: { value: 1e9, unit: "W/m" } };
    expect(applyToCase(pin, { heating: { slice: forged, mapped: h } })).toMatchObject({ ok: false, errors: [{ code: "E_RECIPE_INVALID" }] });
  });

  it("two cases made from one boundary mapping do not share objects", () => {
    const b = boundary();
    const one = (applyToCase(pin, { boundary: b }) as any).doc;
    const two = (applyToCase(pin, { boundary: b }) as any).doc;
    one.boundary.heatTransferCoefficient.value = 1;
    one.provenance.transfers[0].approval.approver = "changed";
    expect(two.boundary.heatTransferCoefficient.value).toBe(30000);
    expect(b.boundary.heatTransferCoefficient.value).toBe(30000);
    expect(two.provenance.transfers[0].approval.approver).toBe("J. W.");
    expect(b.provenance.approval.approver).toBe("J. W.");
  });
});

describe("revisions", () => {
  it("caseRevision ignores key order and changes with any value", () => {
    expect(caseRevision({ a: 1, b: { c: 2, d: 3 } })).toBe(caseRevision({ b: { d: 3, c: 2 }, a: 1 }));
    expect(caseRevision({ a: 1 })).not.toBe(caseRevision({ a: 2 }));
  });
});
