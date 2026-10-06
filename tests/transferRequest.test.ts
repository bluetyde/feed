// The `transfer` command's core: SEED's recipe (seed.transfer-recipe/0.2) and request (seed.transfer-request/0.2) in, a complete new
// case or typed refusals out. Heating into a pin. SEED has already checked approval, digest, revisions and dimension; these tests
// are about what FEED owns: coverage, conservation, overlap, uncertainty, units on the table, and the target case itself.
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { DESCRIBE_TRANSFERS, transferHeating } from "../src/core/transferRequest";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const pinText = readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8");
const pin = JSON.parse(pinText);
const J_PER_MEV = 1.602176634e-13;
const FRAME = "pin-axis z up, m, origin at bottom of fuel";

type Row = unknown[];
/** Four axial bins of 0.25 m on pin p1 (MeV per source particle, 1% std) plus one bin of a second pin. */
const bins = (scores = [4, 6, 6, 4], pinId = "p1", asList = true): Row[] => scores.map((v, i) => [asList ? [pinId] : pinId, i * 0.25, (i + 1) * 0.25, v, v * 0.01]);
const table = (over: Record<string, unknown> = {}) => ({
  schema: "seed.quantity-data/0.2",
  quantity: "Fuel:heating",
  kind: "table",
  unit: "MeV",
  columns: [
    { name: "pin", unit: "1", role: "label" },
    { name: "z_min", unit: "m", role: "coordinate" },
    { name: "z_max", unit: "m", role: "coordinate" },
    { name: "mean", unit: "MeV", role: "value" },
    { name: "std", unit: "MeV", role: "std", of: "mean" },
  ],
  rows: [...bins(), ...bins([1, 1, 1, 1], "p2")],
  meta: { frame: FRAME },
  ...over,
});
const recipe = (over: Record<string, any> = {}) => ({
  schema: "seed.transfer-recipe/0.2",
  recipeId: "heat-to-pin-1",
  proposedBy: { kind: "agent", name: "claude" },
  proposedAt: "2026-10-06T10:00:00Z",
  source: { runId: "run-001", resultsSha256: "a".repeat(64), quantity: "Fuel:heating", dataSha256: "b".repeat(64), unit: "MeV", dimension: "energy", normalization: "per-source-particle", revisionPins: [{ artifact: "openmc-model", revision: "c".repeat(64) }] },
  target: { app: "feed", artifact: "pin-case", revision: "d".repeat(64), field: "heating-to-pin" },
  units: { to: "W" },
  normalization: { kind: "source-rate", value: { value: 1e18, unit: "1/s" }, origin: "20 kW at 200 MeV per fission" },
  mapping: {
    spatial: {
      pin: "p1",
      frame: FRAME,
      slices: [
        { id: "lower", z: { min: 0, max: 0.5 } },
        { id: "upper", z: { min: 0.5, max: 1 } },
      ],
      applyTo: "lower",
    },
    time: { kind: "steady" },
    extrapolation: "refused",
  },
  tolerance: { conservation: 1e-9, fixedBefore: "mapping" },
  ...over,
});
const request = (over: { recipe?: any; data?: any; target?: string } = {}) => ({
  schema: "seed.transfer-request/0.2",
  recipe: over.recipe ?? recipe(),
  recipeDigest: "e".repeat(64),
  source: { quantity: { name: "Fuel:heating", unit: "MeV", dimension: "energy", normalization: "per-source-particle" }, data: over.data ?? table() },
  target: { artifact: "pin-case", revision: "d".repeat(64), content: over.target ?? pinText },
});
/** Mutate a deep copy of the standard request. */
const change = (f: (r: any) => void) => {
  const r: any = structuredClone(request());
  f(r);
  return r;
};
const codeOf = (r: any) => (r.ok ? "ok" : r.errors[0].code);
const total20 = 20 * J_PER_MEV * 1e18;

describe("heating into a pin: the good case", () => {
  it("converts energy per source particle to watts with the source rate, maps to slices and conserves the total", () => {
    const r = transferHeating(request()) as any;
    expect(r.ok).toBe(true);
    expect(r.checks.conservation.sourceW).toBeCloseTo(total20, 6);
    expect(r.checks.conservation.mappedW).toBeCloseTo(total20, 6);
    expect(r.checks.slices.map((s: any) => s.id)).toEqual(["lower", "upper"]);
    expect(r.checks.slice.linearHeatRate.value).toBeCloseTo((10 * J_PER_MEV * 1e18) / 0.5, 6);
    expect(r.checks.bins).toBe(4);
  });

  it("returns the COMPLETE new case: q' set, everything else kept, the transfer recorded, and it validates", () => {
    const r = transferHeating(request()) as any;
    const doc = JSON.parse(r.output.content);
    expect(r.output.content.endsWith("\n")).toBe(true);
    expect(doc.power.linearHeatRate).toEqual({ value: r.checks.slice.linearHeatRate.value, unit: "W/m" });
    expect(doc.materials).toEqual(pin.materials);
    expect(doc.geometry).toEqual(pin.geometry);
    expect(doc.provenance.transfers[0]).toMatchObject({ kind: "heating", recipeId: "heat-to-pin-1", recipeDigest: "e".repeat(64), pin: "p1", sliceId: "lower", runId: "run-001", quantity: "Fuel:heating", resultsSha256: "a".repeat(64), dataSha256: "b".repeat(64), frame: FRAME });
    expect(doc.provenance.transfers[0].totals.relativeDifference).toBeCloseTo(0, 12);
    expect(validateCase(doc).ok).toBe(true);
    expect(JSON.parse(pinText).provenance).toBeUndefined(); // the request's own text is untouched
  });

  it("applies the slice named by applyTo", () => {
    const r = transferHeating(request({ recipe: recipe({ mapping: { ...recipe().mapping, spatial: { ...recipe().mapping.spatial, applyTo: "upper" } } }) })) as any;
    expect(JSON.parse(r.output.content).power.linearHeatRate.value).toBeCloseTo((10 * J_PER_MEV * 1e18) / 0.5, 6);
    expect(JSON.parse(r.output.content).provenance.transfers[0].sliceId).toBe("upper");
  });

  it("the other pin's rows do not enter pin p1's power; a pin cell may be a plain string or a one-item list", () => {
    const only = transferHeating(request({ data: table({ rows: bins() }) })) as any;
    const plain = transferHeating(request({ data: table({ rows: bins([4, 6, 6, 4], "p1", false) }) })) as any;
    const both = transferHeating(request()) as any;
    expect(both.checks.conservation.sourceW).toBeCloseTo(only.checks.conservation.sourceW, 9);
    expect(plain.checks.conservation.sourceW).toBeCloseTo(only.checks.conservation.sourceW, 9);
  });

  it("total power over the pin's stated bin count scales the score shares to the stated total", () => {
    const r = transferHeating(
      request({ recipe: recipe({ normalization: { kind: "total-power", value: { value: 30, unit: "kW" }, origin: "core power" }, mapping: { ...recipe().mapping, spatial: { ...recipe().mapping.spatial, pinBinCount: 4 } } }) }),
    ) as any;
    expect(r.ok).toBe(true);
    expect(r.checks.conservation.sourceW).toBeCloseTo(30000, 6);
    expect(r.checks.slice.linearHeatRate.value).toBeCloseTo(15000 / 0.5, 6);
  });

  it("W, W/m and W/m3 tables each use the right basis and give the same watts; units may be kW and cm", () => {
    const watts = [100, 150, 150, 100];
    const mk = (unit: string, rows: Row[], extra: object[] = [], dim = "power") => transferHeating(request({ recipe: recipe({ source: { ...recipe().source, unit, dimension: dim, normalization: "none" }, normalization: { kind: "none" } }), data: table({ unit, columns: [{ name: "pin", unit: "1", role: "label" }, { name: "z_min", unit: "m", role: "coordinate" }, { name: "z_max", unit: "m", role: "coordinate" }, ...extra, { name: "mean", unit, role: "value" }, { name: "std", unit, role: "std", of: "mean" }], rows }) })) as any;
    const row = (i: number, ...mid: number[]) => [["p1"], i * 0.25, (i + 1) * 0.25, ...mid];
    const w = mk("W", watts.map((v, i) => row(i, v, 0)));
    const perM = mk("W/m", watts.map((v, i) => row(i, v / 0.25, 0)), [], "power-per-length");
    const perV = mk("W/m3", watts.map((v, i) => row(i, 1e-3, v / 1e-3, 0)), [{ name: "volume", unit: "m3", role: "coordinate" }], "power-per-volume");
    const perVcm = mk("kW/m^3", watts.map((v, i) => row(i, 1000, v / 1e-3 / 1000, 0)), [{ name: "volume", unit: "cm3", role: "coordinate" }], "power-per-volume");
    for (const r of [w, perM, perV, perVcm]) {
      expect(r.ok).toBe(true);
      expect(r.checks.conservation.sourceW).toBeCloseTo(500, 9);
    }
    // z in centimetres
    const cm = transferHeating(request({ data: table({ columns: table().columns.map((c: any) => (c.role === "coordinate" ? { ...c, unit: "cm" } : c)), rows: bins().map((r) => [r[0], (r[1] as number) * 100, (r[2] as number) * 100, r[3], r[4]]) }) })) as any;
    expect(cm.ok).toBe(true);
    expect(cm.checks.conservation.sourceW).toBeCloseTo(total20, 6);
  });

  it("a bin straddling a slice boundary is split by overlap, still conserving", () => {
    const r = transferHeating(request({ recipe: recipe({ mapping: { ...recipe().mapping, spatial: { ...recipe().mapping.spatial, slices: [{ id: "lower", z: { min: 0, max: 0.4 } }, { id: "upper", z: { min: 0.4, max: 1 } }] } } }) })) as any;
    expect(r.ok).toBe(true);
    expect(Math.abs(r.checks.conservation.relativeDifference)).toBeLessThan(1e-12);
    expect(r.checks.slices[0].powerW).toBeCloseTo((4 + 6 * 0.6) * J_PER_MEV * 1e18, 6); // bin 1 gives 0.15 of 0.25 of itself to the lower slice
  });

  it("the Monte Carlo error is carried: independent bins combine in quadrature", () => {
    const r = transferHeating(request()) as any;
    expect(r.checks.slice.relError).toBeCloseTo(Math.sqrt(0.04 ** 2 + 0.06 ** 2) / 10, 9);
    expect(JSON.parse(r.output.content).provenance.transfers[0].relError).toBeCloseTo(r.checks.slice.relError, 12);
  });

  it("property: a uniform field over a uniform target reproduces the total exactly", () => {
    for (const n of [1, 2, 7]) {
      const rows = Array.from({ length: n }, (_, i) => [["p1"], i / n, (i + 1) / n, 3, 0]);
      const r = transferHeating(request({ recipe: recipe({ tolerance: { conservation: 1e-12, fixedBefore: "mapping" } }), data: table({ rows }) })) as any;
      expect(r.ok).toBe(true);
      expect(r.checks.conservation.sourceW).toBeCloseTo(3 * n * J_PER_MEV * 1e18, 4);
      expect(Math.abs(r.checks.conservation.relativeDifference)).toBeLessThan(1e-12);
    }
  });

  it("the table's value column and the other column names can be chosen in the recipe", () => {
    const columns = [{ name: "id", unit: "1", role: "label" }, { name: "lo", unit: "m", role: "coordinate" }, { name: "hi", unit: "m", role: "coordinate" }, { name: "heat", unit: "MeV", role: "value" }, { name: "heat_std", unit: "MeV", role: "std", of: "heat" }, { name: "other", unit: "MeV", role: "value" }];
    const rows = bins().map((r) => [...r, 0]);
    const sp = { ...recipe().mapping.spatial, columns: { pin: "id", zMin: "lo", zMax: "hi", value: "heat" } };
    const r = transferHeating(request({ recipe: recipe({ mapping: { ...recipe().mapping, spatial: sp } }), data: table({ columns, rows }) })) as any;
    expect(r.ok).toBe(true);
    // two value columns and no choice is a refusal, not a guess
    const ambiguous = transferHeating(request({ recipe: recipe({ mapping: { ...recipe().mapping, spatial: { ...sp, columns: { pin: "id", zMin: "lo", zMax: "hi" } } } }), data: table({ columns, rows }) }));
    expect(codeOf(ambiguous)).toBe("E_RECIPE_INVALID");
  });
});

describe("heating into a pin: every refusal names its code and returns no case", () => {
  const sp = (f: (s: any) => void) => (r: any) => f(r.recipe.mapping.spatial);
  const cases: [string, (r: any) => void, string, string?][] = [
    ["not a transfer request", (r) => (r.schema = "x"), "E_SCHEMA_INVALID"],
    ["a recipe of another schema", (r) => (r.recipe.schema = "feed.transfer-recipe/0.1"), "E_RECIPE_INVALID"],
    ["a recipe for another app", (r) => (r.recipe.target.app = "nodal"), "E_RECIPE_INVALID"],
    ["a transfer kind FEED does not offer", (r) => (r.recipe.target.field = "coolant-boundary"), "E_UNSUPPORTED"],
    ["a time series", (r) => (r.recipe.mapping.time = { kind: "series" }), "E_UNSUPPORTED"],
    ["extrapolation not refused", (r) => (r.recipe.mapping.extrapolation = "allowed"), "E_RECIPE_INVALID"],
    ["a tolerance of zero", (r) => (r.recipe.tolerance.conservation = 0), "E_RECIPE_INVALID"],
    ["a tolerance above 1", (r) => (r.recipe.tolerance.conservation = 2), "E_RECIPE_INVALID"],
    ["units.to other than W", (r) => (r.recipe.units.to = "W/m"), "E_UNITS"],
    ["a mistyped spatial key", sp((s) => ((s.applyto = s.applyTo), delete s.applyTo)), "E_RECIPE_INVALID"],
    ["no slice to apply", sp((s) => delete s.applyTo), "E_RECIPE_INVALID"],
    ["applyTo not among the slices", sp((s) => (s.applyTo = "middle")), "E_RECIPE_INVALID"],
    ["no pin", sp((s) => delete s.pin), "E_RECIPE_INVALID"],
    ["no slices", sp((s) => (s.slices = [])), "E_RECIPE_INVALID"],
    ["duplicate slice ids", sp((s) => (s.slices[1].id = "lower")), "E_RECIPE_INVALID"],
    ["a slice with max below min", sp((s) => (s.slices[0].z = { min: 0.5, max: 0 })), "E_RECIPE_INVALID"],
    ["overlapping slices (they could hide an uncovered half)", sp((s) => (s.slices[1].z = { min: 0.4, max: 1 })), "E_RECIPE_INVALID"],
    ["an unknown column key", sp((s) => (s.columns = { colour: "mean" })), "E_RECIPE_INVALID"],
    ["a target that is not JSON", (r) => (r.target.content = "not json"), "E_SCHEMA_INVALID"],
    ["a target that is a list", (r) => (r.target.content = "[]"), "E_SCHEMA_INVALID"],
    ["a target case that is already invalid", (r) => (r.target.content = JSON.stringify({ ...pin, geometry: { ...pin.geometry, fuelRadius: { value: -1, unit: "mm" } } })), "E_GEOMETRY"],
    ["a transient target", (r) => (r.target.content = JSON.stringify({ ...pin, assumptions: { ...pin.assumptions, steadyState: false } })), "E_UNSUPPORTED"],
    ["a source that is not a table", (r) => (r.source.data = { kind: "scalar", value: 1 }), "E_SCHEMA_INVALID"],
    ["another quantity than the recipe was approved for", (r) => (r.source.data.quantity = "Fuel:flux"), "E_RECIPE_INVALID"],
    ["a different coordinate frame (no transform)", (r) => (r.source.data.meta.frame = "top-down"), "E_FRAME_MISMATCH"],
    ["no frame in the table", (r) => delete r.source.data.meta, "E_FRAME_MISMATCH"],
    ["no pin column", (r) => (r.source.data.columns[0].name = "rod"), "E_COVERAGE_INCOMPLETE"],
    ["z columns that are not coordinates", (r) => (r.source.data.columns[1].role = "value"), "E_COVERAGE_INCOMPLETE"],
    ["z columns with a unit that is not a length", (r) => (r.source.data.columns[1].unit = "s"), "E_UNITS"],
    ["a value unit different from the recipe's", (r) => ((r.source.data.columns[3].unit = "keV"), (r.source.data.columns[4].unit = "keV")), "E_UNITS"],
    ["a value that is not an energy for an energy recipe", (r) => ((r.recipe.source.unit = "W"), (r.source.data.columns[3].unit = "W"), (r.source.data.columns[4].unit = "W")), "E_UNITS"],
    ["no std column (the Monte Carlo error cannot be dropped)", (r) => r.source.data.columns.pop(), "E_UNCERTAINTY_MISSING"],
    ["a std column of another value", (r) => (r.source.data.columns[4].of = "other"), "E_UNCERTAINTY_MISSING"],
    ["a bin without a std", (r) => (r.source.data.rows[1][4] = null), "E_UNCERTAINTY_MISSING"],
    ["a negative std", (r) => (r.source.data.rows[1][4] = -1), "E_UNCERTAINTY_MISSING"],
    ["an energy with no normalization", (r) => (r.recipe.normalization = { kind: "none" }), "E_NORMALIZATION_MISSING"],
    ["a power with a source rate (normalization twice)", (r) => ((r.recipe.source.unit = "W"), (r.recipe.source.dimension = "power"), (r.source.data.columns[3].unit = "W"), (r.source.data.columns[4].unit = "W")), "E_UNITS"],
    ["a source rate that is not per second", (r) => (r.recipe.normalization.value.unit = "W"), "E_UNITS"],
    ["a source rate of zero", (r) => (r.recipe.normalization.value.value = 0), "E_UNITS"],
    ["a total power in the wrong unit", (r) => (r.recipe.normalization = { kind: "total-power", value: { value: 30, unit: "1/s" }, origin: "x" }), "E_UNITS"],
    ["a total power with no bin count", (r) => (r.recipe.normalization = { kind: "total-power", value: { value: 30, unit: "kW" }, origin: "x" }), "E_NORMALIZATION_MISSING"],
    ["a total power over a partial export", (r) => ((r.recipe.normalization = { kind: "total-power", value: { value: 30, unit: "kW" }, origin: "x" }), (r.recipe.mapping.spatial.pinBinCount = 5)), "E_NORMALIZATION_DOMAIN"],
    ["a dimension FEED does not map", (r) => (r.recipe.source.dimension = "pressure"), "E_UNITS"],
    ["no rows for the pin", sp((s) => (s.pin = "p9")), "E_COVERAGE_INCOMPLETE"],
    ["a row with the wrong number of cells", (r) => r.source.data.rows[0].pop(), "E_SCHEMA_INVALID"],
    ["a negative bin value", (r) => (r.source.data.rows[0][3] = -1), "E_SCHEMA_INVALID"],
    ["a non-finite bin value", (r) => (r.source.data.rows[0][3] = null), "E_SCHEMA_INVALID"],
    ["a bin with max below min", (r) => (r.source.data.rows[0][2] = -1), "E_SCHEMA_INVALID"],
    ["bins of the pin that overlap in z (double counted)", (r) => (r.source.data.rows[1][1] = 0.2), "E_SCHEMA_INVALID"],
    ["a gap in coverage (no extrapolation)", (r) => r.source.data.rows.splice(1, 1), "E_COVERAGE"],
    ["a slice no bin reaches", sp((s) => (s.slices[1].z = { min: 0.5, max: 1.5 })), "E_COVERAGE"],
    ["a slice that receives no power", (r) => ((r.source.data.rows[2][3] = 0), (r.source.data.rows[3][3] = 0)), "E_COVERAGE_INCOMPLETE"],
    ["a conversion that overflows", (r) => (r.source.data.rows[0][3] = 1e308), "E_NUMERIC"],
    ["a lossy mapping (slices cover only half of the pin's bins)", sp((s) => (s.slices = [{ id: "lower", z: { min: 0, max: 0.5 } }])), "E_CONSERVATION"],
  ];
  it.each(cases)("%s", (_name, f, code) => {
    const r = transferHeating(change(f)) as any;
    expect(codeOf(r)).toBe(code);
    expect(r.output).toBeUndefined(); // a refusal never carries a partial case
    expect(r.errors[0].field).toMatch(/^\//);
  });

  it("an extra spatial key on an otherwise valid recipe is refused, not ignored", () => {
    const r = transferHeating(change((q) => (q.recipe.mapping.spatial.colour = "red"))) as any;
    expect(r.errors[0]).toMatchObject({ code: "E_RECIPE_INVALID", field: "/recipe/mapping/spatial/colour" });
  });

  it("an invalid target case is refused before anything is mapped, and says so", () => {
    const r = transferHeating(change((q) => (q.target.content = JSON.stringify({ ...pin, geometry: { ...pin.geometry, fuelRadius: { value: -1, unit: "mm" } } })))) as any;
    expect(r.errors[0].message).toMatch(/^the target case is not valid/);
    expect(r.errors[0].field).toMatch(/^\/target\/content\//);
  });

  it("a heat rate above the validator's sanity range is carried with its warning in the evidence, not hidden and not refused", () => {
    // the standard request's source rate (1e18 /s) gives 3.2 MW/m, far outside the range; 1e15 /s gives 3.2 kW/m
    const big = transferHeating(request()) as any;
    expect(big.ok).toBe(true);
    expect(big.checks.slice.linearHeatRate.value).toBeGreaterThan(60_000);
    expect(big.checks.warnings.map((w: any) => w.code)).toEqual(["W_POWER_RANGE"]);
    const small = transferHeating(change((q) => (q.recipe.normalization.value.value = 1e15))) as any;
    expect(small.ok).toBe(true);
    expect(small.checks.slice.linearHeatRate.value).toBeCloseTo(3200, -1);
    expect(small.checks.warnings).toEqual([]);
  });

  it("a mapping that loses 2% fails a 1% tolerance and passes a 5% one", () => {
    const slices = [{ id: "lower", z: { min: 0, max: 0.49 } }, { id: "upper", z: { min: 0.49, max: 0.98 } }];
    const mk = (conservation: number) => transferHeating(change((r) => ((r.recipe.mapping.spatial.slices = slices), (r.recipe.tolerance.conservation = conservation))));
    expect(codeOf(mk(0.01))).toBe("E_CONSERVATION");
    expect(codeOf(mk(0.05))).toBe("ok");
  });

  it("the coverage tolerance is relative: a bin a thousandth of a slice long does not cover it", () => {
    const r = transferHeating(change((q) => (q.source.data.rows = [[["p1"], 0, 0.001, 4, 0.04], [["p1"], 0.5, 1, 4, 0.04]]))) as any;
    expect(codeOf(r)).toBe("E_COVERAGE");
  });
});

describe("Codex review of the transfer command: each finding as a test", () => {
  const withColumn = (col: any, cell: unknown) => change((q) => (q.source.data.columns.push(col), q.source.data.rows.forEach((r: any[]) => r.push(cell))));

  it("two columns of one name are refused: the order of columns cannot choose the heating value", () => {
    const dup = withColumn({ name: "mean", unit: "MeV", role: "value" }, 2);
    dup.recipe.mapping.spatial.columns = { value: "mean" };
    expect((transferHeating(dup) as any).errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/source/data/columns/5/name" });
    // the same table with the columns reversed is refused too
    const rev = structuredClone(dup);
    rev.source.data.columns.reverse();
    rev.source.data.rows.forEach((r: any[]) => r.reverse());
    expect(codeOf(transferHeating(rev))).toBe("E_SCHEMA_INVALID");
  });

  it("two std columns for one value are refused: an extra zero std cannot hide the uncertainty", () => {
    const two = withColumn({ name: "std0", unit: "MeV", role: "std", of: "mean" }, 0);
    expect((transferHeating(two) as any).errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/source/data/columns" });
  });

  it("a total power carries the uncertainty of its own denominator: a whole-pin slice with an exact total has none", () => {
    const one = change((q) => {
      q.recipe.normalization = { kind: "total-power", value: { value: 1000, unit: "W" }, origin: "x" };
      q.recipe.mapping.spatial = { pin: "p1", frame: FRAME, slices: [{ id: "all", z: { min: 0, max: 1 } }], applyTo: "all", pinBinCount: 1 };
      q.source.data.rows = [[["p1"], 0, 1, 10, 1]];
    });
    const r = transferHeating(one) as any;
    expect(r.ok).toBe(true);
    expect(r.checks.slice.relError).toBeCloseTo(0, 12);
  });

  it("a total power's slice uncertainty matches the analytic derivative P(w_b S - A)/S^2 for several bins", () => {
    const r = transferHeating(change((q) => {
      q.recipe.normalization = { kind: "total-power", value: { value: 30, unit: "kW" }, origin: "x" };
      q.recipe.mapping.spatial.pinBinCount = 4;
    })) as any;
    const g = 750; // 30000 * (1 * 20 - 10) / 400 for the two bins in the lower slice, and the same size with the other sign for the two above
    const std = g * Math.sqrt(0.04 ** 2 + 0.06 ** 2 + 0.06 ** 2 + 0.04 ** 2);
    expect(r.checks.slice.relError).toBeCloseTo(std / 15000, 9);
    // and against a finite-difference of the whole mapping, bin by bin
    const power = (v: number[]) => (transferHeating(change((q) => {
      q.recipe.normalization = { kind: "total-power", value: { value: 30, unit: "kW" }, origin: "x" };
      q.recipe.mapping.spatial.pinBinCount = 4;
      q.source.data.rows = [[["p1"], 0, 0.25, v[0], 0], [["p1"], 0.25, 0.5, v[1], 0], [["p1"], 0.5, 0.75, v[2], 0], [["p1"], 0.75, 1, v[3], 0]];
    })) as any).checks.slices[0].powerW as number;
    const v0 = [4, 6, 6, 4];
    const h = 1e-4;
    const grad = v0.map((_, i) => (power(v0.map((x, j) => (j === i ? x + h : x))) - power(v0.map((x, j) => (j === i ? x - h : x)))) / (2 * h));
    const fd = Math.sqrt(grad.reduce((t, gi, i) => t + (gi * [0.04, 0.06, 0.06, 0.04][i]!) ** 2, 0));
    expect(fd).toBeCloseTo(std, 6);
  });

  it("tiny and huge standard deviations neither underflow to zero nor become infinite relative errors", () => {
    const watts = (value: number, std: number) => change((q) => {
      q.recipe.source = { ...q.recipe.source, unit: "W", dimension: "power", normalization: "none" };
      q.recipe.normalization = { kind: "none" };
      q.recipe.mapping.spatial.slices = [{ id: "all", z: { min: 0, max: 1 } }];
      q.recipe.mapping.spatial.applyTo = "all";
      q.source.data.columns[3].unit = "W";
      q.source.data.columns[4].unit = "W";
      q.source.data.rows = [[["p1"], 0, 1, value, std]];
    });
    const small = transferHeating(watts(1e-200, 1e-201)) as any;
    expect(small.ok).toBe(true);
    expect(small.checks.slice.relError).toBeCloseTo(0.1, 9);
    expect(codeOf(transferHeating(watts(1e-200, 1e150)))).toBe("E_NUMERIC");
  });

  it("the independence of bins is stated and recorded with the result, never silent", () => {
    const r = transferHeating(request()) as any;
    expect(r.checks.uncertaintyModel).toMatch(/independent-bins/);
    expect(JSON.parse(r.output.content).provenance.transfers[0].uncertaintyModel).toBe("independent-bins");
  });

  it("a malformed column entry is a refusal, not a crash", () => {
    const bad = change((q) => q.source.data.columns.push(null));
    expect((transferHeating(bad) as any).errors[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/source/data/columns/5" });
    for (const col of [{ name: 1, unit: "m", role: "value" }, { name: "x", role: "value" }, "text"]) {
      expect(codeOf(transferHeating(change((q) => q.source.data.columns.push(col))))).toBe("E_SCHEMA_INVALID");
    }
  });

  it("a target whose provenance or transfers list is not what an append needs is a refusal, not a crash", () => {
    for (const provenance of [{ transfers: {} }, { transfers: "x" }, [], "x"]) {
      const r = transferHeating(change((q) => (q.target.content = JSON.stringify({ ...pin, provenance })))) as any;
      expect(r.errors?.[0]).toMatchObject({ code: "E_SCHEMA_INVALID", field: "/target/content/provenance" });
    }
    // a good earlier transfer list is kept and extended
    const r = transferHeating(change((q) => (q.target.content = JSON.stringify({ ...pin, provenance: { transfers: [{ kind: "earlier" }] } })))) as any;
    expect(JSON.parse(r.output.content).provenance.transfers.map((t: any) => t.kind)).toEqual(["earlier", "heating"]);
  });

  it("through the command: a null column is exit 0 with a typed refusal", () => {
    const r = spawnSync(process.execPath, [join(root, "dist", "cli", "headless.js"), "transfer"], { input: JSON.stringify(change((q) => q.source.data.columns.push(null))), encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split(String.fromCharCode(10)).at(-1)!)).toMatchObject({ ok: false, errors: [{ code: "E_SCHEMA_INVALID" }] });
  });
});

describe("describe.transfers", () => {
  it("names the field FEED offers and the dimensions it accepts, as the SEED adapter schema allows", () => {
    expect(DESCRIBE_TRANSFERS.map((t) => t.field)).toEqual(["heating-to-pin", "coolant-boundary"]);
    const t = DESCRIBE_TRANSFERS[0]!;
    expect(t.field).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(t.accepts.map((a) => `${a.dimension}/${a.normalization}`)).toEqual(["energy/per-source-particle", "power/none", "power-per-length/none", "power-per-volume/none"]);
    expect(Object.keys(t).sort()).toEqual(["accepts", "field", "parameters"]);
  });
});

describe("the headless `transfer` command", () => {
  const cli = join(root, "dist", "cli", "headless.js");
  const send = (stdin: string) => {
    const r = spawnSync(process.execPath, [cli, "transfer"], { input: stdin, encoding: "utf8", timeout: 60_000 });
    const lines = r.stdout.trim().split("\n");
    return { code: r.status, lines, json: JSON.parse(lines.at(-1)!) };
  };

  it("describe reports the transfers", () => {
    const r = spawnSync(process.execPath, [cli, "describe"], { encoding: "utf8", timeout: 60_000 });
    expect(JSON.parse(r.stdout.trim()).transfers).toEqual(JSON.parse(JSON.stringify(DESCRIBE_TRANSFERS)));
  });

  it("an accepted transfer is exit 0 with one JSON line carrying the complete new case", () => {
    const r = send(JSON.stringify(request()));
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.json.ok).toBe(true);
    expect(validateCase(JSON.parse(r.json.output.content)).ok).toBe(true);
    expect(r.json.checks.conservation.tolerance).toBe(1e-9);
  });

  it("a refusal is also exit 0, with typed errors", () => {
    const r = send(JSON.stringify(change((q) => (q.source.data.meta.frame = "top-down"))));
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: false, errors: [{ code: "E_FRAME_MISMATCH" }] });
  });

  it("garbage on stdin is a refusal, not a crash", () => {
    const r = send("not json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: false, errors: [{ code: "E_SCHEMA_INVALID" }] });
  });

  it("the reply is within SEED's size limit for a large table", () => {
    const rows = Array.from({ length: 20000 }, (_, i) => [["p1"], i / 20000, (i + 1) / 20000, 1, 0.01]);
    const r = send(JSON.stringify(request({ data: table({ rows }) })));
    expect(r.json.ok).toBe(true);
    expect(JSON.stringify(r.json).length).toBeLessThan(8 * 1024 * 1024);
  });
});
