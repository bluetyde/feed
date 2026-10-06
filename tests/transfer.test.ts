// Coolant-boundary intake (plan 05), still on FEED's PROVISIONAL recipe (decision 0003): the heating transfer moved to SEED's recipe
// and is tested in transferRequest.test.ts. Each refusal fires with its named code; the Codex F3 findings on applying mappings stay.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { applyToCase, approveRecipe, caseRevision, mapBoundary, recipeDigest } from "../src/core/transfer";
import { validateCase } from "../src/core/validate";

const pin = JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-pin.json"), "utf8"));
const rev = caseRevision(pin);
const WHEN = "2026-10-05T12:00:00Z";

const code = (r: any) => (r.ok ? "ok" : r.errors[0].code);

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

  it("a case edited after the mapping was approved is refused", () => {
    const edited = { ...pin, name: "edited" };
    expect(applyToCase(edited, { boundary: boundary() })).toMatchObject({ ok: false, errors: [{ code: "E_STALE_REVISION" }] });
  });

  it("a case whose provenance transfers is not a list is refused, not a crash", () => {
    for (const provenance of [{ transfers: {} }, [], "x"]) {
      expect(applyToCase({ ...pin, provenance } as any, { boundary: boundary() })).toMatchObject({ ok: false });
    }
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

describe("the approval digest (boundary recipe)", () => {
  it("the digest ignores the approval itself and key order, and changes with content", () => {
    const r: any = { schema: "x", a: 1, b: { c: 2, d: 3 } };
    const approved = approveRecipe(r, "J. W.", WHEN);
    expect(recipeDigest(approved)).toBe(recipeDigest({ b: { d: 3, c: 2 }, a: 1, schema: "x" }));
    expect(recipeDigest(r)).not.toBe(recipeDigest({ ...r, a: 2 }));
  });
});

describe("revisions", () => {
  it("caseRevision ignores key order and changes with any value", () => {
    expect(caseRevision({ a: 1, b: { c: 2, d: 3 } })).toBe(caseRevision({ b: { d: 3, c: 2 }, a: 1 }));
    expect(caseRevision({ a: 1 })).not.toBe(caseRevision({ a: 2 }));
  });
});
