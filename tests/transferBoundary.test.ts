// The `coolant-boundary` transfer (SEED contract: docs/transfer-recipe.md section 7 in the SEED repository). SEED has checked approval, hashes and
// units against dimensions and has picked the sample of each series; these tests are about what FEED owns: a complete boundary of the chosen
// form, the values and their units, a role FEED has no place for, the region against the slice the case was heated for, and the new case.
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { transferBoundary } from "../src/core/transferBoundary";
import { DESCRIBE_TRANSFERS, transfer, transferHeating } from "../src/core/transferRequest";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pinText = read("examples/synthetic-pin.json");
const pin = JSON.parse(pinText);

const HTC = "heat-transfer-coefficient";
const recipe = (over: Record<string, any> = {}) => ({
  schema: "seed.transfer-recipe/0.2",
  recipeId: "boundary-nodal",
  proposedBy: { kind: "agent", name: "claude" },
  proposedAt: "2026-10-06T10:00:00Z",
  source: {
    runId: "run-007",
    resultsSha256: "a".repeat(64),
    quantity: "t_out",
    dataSha256: "b".repeat(64),
    unit: "K",
    dimension: "temperature",
    normalization: "none",
    additional: [{ role: HTC, quantity: "h_surf", dataSha256: "c".repeat(64), unit: "W/m2/K", dimension: HTC, normalization: "none", unitTo: "W/m2/K" }],
  },
  target: { app: "feed", artifact: "pin-case", revision: "d".repeat(64), field: "coolant-boundary" },
  units: { to: "K" },
  normalization: { kind: "none" },
  mapping: { spatial: { region: { id: "pipe1-outlet", z: { min: 0.8, max: 1 } }, boundaryForm: "bulk-plus-h" }, time: { kind: "steady", select: { kind: "last" } }, extrapolation: "refused" },
  tolerance: { conservation: 0.01, fixedBefore: "mapping" },
  ...over,
});
const request = (over: { recipe?: any; target?: string; primary?: any; extra?: any } = {}) => ({
  schema: "seed.transfer-request/0.2",
  recipe: over.recipe ?? recipe(),
  recipeDigest: "e".repeat(64),
  source: {
    quantity: { name: "t_out", unit: "K", dimension: "temperature", normalization: "none" },
    data: { schema: "seed.quantity-data/0.2", quantity: "t_out", kind: "series", unit: "K", x: [0, 1, 2], values: [560, 570, 573.15] },
    selected: over.primary ?? { x: 2, value: 573.15, interpolated: false },
    additional: [
      {
        role: HTC,
        quantity: { name: "h_surf", unit: "W/m2/K", dimension: HTC, normalization: "none" },
        data: { schema: "seed.quantity-data/0.2", quantity: "h_surf", kind: "series", unit: "W/m2/K", x: [0, 1, 2], values: [28000, 29000, 30000] },
        selected: over.extra ?? { x: 2, value: 30000, interpolated: false },
      },
    ],
  },
  target: { artifact: "pin-case", revision: "d".repeat(64), content: over.target ?? pinText },
});
/** A request changed by a function on a deep copy. */
const change = (f: (r: any) => void, base: any = request()) => {
  const r: any = structuredClone(base);
  f(r);
  return r;
};
const surfaceRequest = (f: (r: any) => void = () => {}) =>
  change((r) => {
    r.recipe.source.quantity = "tw_surf";
    delete r.recipe.source.additional;
    r.recipe.mapping.spatial.boundaryForm = "surface-temperature";
    r.source.quantity.name = "tw_surf";
    delete r.source.additional;
    f(r);
  });
const ok = (r: any) => {
  const out = transferBoundary(r);
  expect(out.ok, JSON.stringify(out)).toBe(true);
  if (!out.ok) throw new Error("not ok");
  return { out, doc: JSON.parse(out.output.content) };
};
const refusal = (r: any) => {
  const out = transferBoundary(r);
  if (out.ok) throw new Error("accepted: " + JSON.stringify(out.checks));
  return out.errors[0]!;
};

describe("a bulk temperature and a heat transfer coefficient (bulk-plus-h)", () => {
  it("sets the case's convective boundary in K and W/m2/K, records the samples, and leaves the rest of the case alone", () => {
    const { out, doc } = ok(request());
    expect(doc.boundary).toEqual({ bulkTemperature: { value: 573.15, unit: "K" }, heatTransferCoefficient: { value: 30000, unit: "W/m2/K" } });
    const { boundary: _b, provenance, ...rest } = doc;
    const { boundary: _b0, ...rest0 } = pin;
    expect(rest).toEqual(rest0);
    expect(provenance.transfers).toHaveLength(1);
    expect(provenance.transfers[0]).toMatchObject({
      kind: "coolant-boundary",
      recipeId: "boundary-nodal",
      recipeDigest: "e".repeat(64),
      boundaryForm: "bulk-plus-h",
      region: { id: "pipe1-outlet", z: { min: 0.8, max: 1 } },
      runId: "run-007",
      samples: [
        { role: "bulk-temperature", quantity: "t_out", unit: "K", x: 2, value: 573.15, interpolated: false },
        { role: HTC, quantity: "h_surf", unit: "W/m2/K", x: 2, value: 30000, interpolated: false },
      ],
    });
    expect(validateCase(doc).ok).toBe(true);
    expect(out.checks).toMatchObject({ boundaryForm: "bulk-plus-h", region: { id: "pipe1-outlet" } });
  });

  it("converts degC to K and kW/m2/K to W/m2/K, and records the source's own unit", () => {
    const r = change((x) => {
      x.recipe.source.unit = "degC";
      x.source.quantity.unit = "degC";
      x.recipe.source.additional[0].unit = "kW/m2/K";
      x.source.additional[0].quantity.unit = "kW/m2/K";
      x.source.selected = { x: 2, value: 300, interpolated: false };
      x.source.additional[0].selected = { x: 2, value: 30, interpolated: false };
    });
    const { doc } = ok(r);
    expect(doc.boundary.bulkTemperature).toEqual({ value: 573.15, unit: "K" });
    expect(doc.boundary.heatTransferCoefficient).toEqual({ value: 30000, unit: "W/m2/K" });
    expect(doc.provenance.transfers[0].samples[0]).toMatchObject({ unit: "degC", value: 300 });
  });

  it("an interpolated sample is flagged in the case and in the checks", () => {
    const { out, doc } = ok(request({ primary: { x: 1.5, value: 571.575, interpolated: true }, extra: { x: 1.5, value: 29500, interpolated: true } }));
    expect(doc.provenance.transfers[0].samples.map((s: any) => s.interpolated)).toEqual([true, true]);
    expect((out.checks as any).samples.map((s: any) => s.x)).toEqual([1.5, 1.5]);
  });

  it("takes the place of the form the case had: a surface-temperature boundary is removed, other keys stay", () => {
    const base = structuredClone(pin);
    base.boundary = { surfaceTemperature: { value: 600, unit: "K" }, note: "kept" };
    const { doc } = ok(request({ target: JSON.stringify(base) }));
    expect(doc.boundary.surfaceTemperature).toBeUndefined();
    expect(doc.boundary.note).toBe("kept");
    expect(doc.boundary.bulkTemperature.value).toBe(573.15);
  });

  it("works on a transient case, and on one that starts from a steady operating state", () => {
    for (const file of ["examples/synthetic-pulse.json", "examples/synthetic-pulse-operating.json"]) {
      const { doc } = ok(request({ target: read(file) }));
      expect(validateCase(doc).ok).toBe(true);
      expect(doc.boundary.bulkTemperature.value).toBe(573.15);
    }
  });

  it("a second transfer replaces the values and appends to the record; the input text is not changed", () => {
    const first = ok(request());
    const again = ok(request({ target: first.out.output.content, primary: { x: 2, value: 590, interpolated: false } }));
    expect(again.doc.boundary.bulkTemperature.value).toBe(590);
    expect(again.doc.provenance.transfers).toHaveLength(2);
    const r = request();
    const before = JSON.stringify(r);
    transferBoundary(r);
    expect(JSON.stringify(r)).toBe(before);
    expect(transferBoundary(r)).toEqual(transferBoundary(request()));
  });

  it("goes through the `transfer` router by the recipe's field, and heating still does", () => {
    expect(transfer(request())).toEqual(transferBoundary(request()));
    const other = change((r) => (r.recipe.target.field = "heating-to-pin"));
    expect(transfer(other)).toEqual(transferHeating(other)); // a boundary-shaped recipe naming the heating field is the heating transfer's to refuse
    expect((transfer(other) as any).ok).toBe(false);
  });
});

describe("a surface temperature (surface-temperature)", () => {
  it("sets the outer surface temperature and removes the convective pair", () => {
    const { doc } = ok(surfaceRequest((r) => (r.source.selected = { x: 2, value: 640, interpolated: false })));
    expect(doc.boundary).toEqual({ surfaceTemperature: { value: 640, unit: "K" } });
    expect(doc.provenance.transfers[0].samples).toEqual([expect.objectContaining({ role: "surface-temperature", quantity: "tw_surf", value: 640 })]);
    expect(validateCase(doc).ok).toBe(true);
  });
});

describe("the region against the slice the case was heated for", () => {
  const heated = (z: { min: number; max: number }) => {
    const base = structuredClone(pin);
    base.provenance = { transfers: [{ kind: "heating", sliceId: "lower", z }] };
    return JSON.stringify(base);
  };
  it("a region that contains the heated slice is accepted and says so", () => {
    const { out } = ok(request({ target: heated({ min: 0.85, max: 0.95 }) }));
    expect((out.checks as any).regionCheck).toMatch(/contains every slice/);
    expect((out.checks as any).heatedSlices).toEqual([{ id: "lower", z: { min: 0.85, max: 0.95 } }]);
  });
  it("a region that equals the heated slice is accepted (to the tolerance)", () => {
    ok(request({ target: heated({ min: 0.8, max: 1 }) }));
  });
  it("a region that does not contain it is refused, with both ranges", () => {
    const e = refusal(request({ target: heated({ min: 0.0, max: 0.5 }) }));
    expect(e.code).toBe("E_COVERAGE_INCOMPLETE");
    expect(e.message).toMatch(/lower/);
  });
  it("a region that ends below the top of the heated slice is refused (the upper end is checked, not only the lower)", () => {
    const e = refusal(request({ target: heated({ min: 0.9, max: 1.1 }) }));
    expect(e.code).toBe("E_COVERAGE_INCOMPLETE");
  });
  it("a region that only partly overlaps it is refused", () => {
    expect(refusal(request({ target: heated({ min: 0.7, max: 0.9 }) })).code).toBe("E_COVERAGE_INCOMPLETE");
  });
  it("with no heating recorded the case is accepted and the checks say the region could not be compared", () => {
    const { out } = ok(request());
    expect((out.checks as any).regionCheck).toMatch(/could not be compared/);
    expect((out.checks as any).heatedSlices).toEqual([]);
  });
});

describe("refusals (each with its code)", () => {
  const cases: [string, any, string][] = [
    ["not a transfer request", { nothing: true }, "E_SCHEMA_INVALID"],
    ["wrong recipe schema", change((r) => (r.recipe.schema = "x")), "E_RECIPE_INVALID"],
    ["another app", change((r) => (r.recipe.target.app = "openmc")), "E_RECIPE_INVALID"],
    ["another field", change((r) => (r.recipe.target.field = "heating-to-pin")), "E_UNSUPPORTED"],
    ["a transient time mapping", change((r) => (r.recipe.mapping.time = { kind: "transient" })), "E_UNSUPPORTED"],
    ["extrapolation allowed", change((r) => (r.recipe.mapping.extrapolation = "linear")), "E_RECIPE_INVALID"],
    ["a normalization on absolute quantities", change((r) => (r.recipe.normalization = { kind: "total-power", value: { value: 1, unit: "W" } })), "E_UNITS"],
    ["units.to is not K", change((r) => (r.recipe.units.to = "degC")), "E_UNITS"],
    ["a primary quantity that is not a temperature", change((r) => (r.recipe.source.dimension = "pressure")), "E_UNITS"],
    ["no spatial block", change((r) => delete r.recipe.mapping.spatial), "E_RECIPE_INVALID"],
    ["an unknown spatial key", change((r) => (r.recipe.mapping.spatial.slices = [])), "E_RECIPE_INVALID"],
    ["a pressure in the spatial block", change((r) => (r.recipe.mapping.spatial.pressure = { convention: "absolute" })), "E_UNSUPPORTED"],
    ["no region", change((r) => delete r.recipe.mapping.spatial.region), "E_RECIPE_INVALID"],
    ["a region with no id", change((r) => (r.recipe.mapping.spatial.region.id = "")), "E_RECIPE_INVALID"],
    ["a region with max below min", change((r) => (r.recipe.mapping.spatial.region.z = { min: 1, max: 0.8 })), "E_RECIPE_INVALID"],
    ["a region with a non-finite end", change((r) => (r.recipe.mapping.spatial.region.z.max = null)), "E_RECIPE_INVALID"],
    ["no boundary form (no default)", change((r) => delete r.recipe.mapping.spatial.boundaryForm), "E_BOUNDARY_INCOMPLETE"],
    ["an unknown boundary form", change((r) => (r.recipe.mapping.spatial.boundaryForm = "adiabatic")), "E_BOUNDARY_INCOMPLETE"],
    ["bulk temperature alone", change((r) => { delete r.recipe.source.additional; delete r.source.additional; }), "E_BOUNDARY_INCOMPLETE"],
    ["a surface temperature with a coefficient", change((r) => (r.recipe.mapping.spatial.boundaryForm = "surface-temperature")), "E_BOUNDARY_INCOMPLETE"],
    ["a role FEED has no place for", change((r) => { r.recipe.source.additional[0].role = "pressure"; r.source.additional[0].role = "pressure"; }), "E_UNSUPPORTED"],
    ["two coefficients", change((r) => { r.recipe.source.additional.push({ ...r.recipe.source.additional[0] }); r.source.additional.push(structuredClone(r.source.additional[0])); }), "E_BOUNDARY_INCOMPLETE"],
    ["more additional quantities in the request than the recipe", change((r) => r.source.additional.push(structuredClone(r.source.additional[0]))), "E_RECIPE_INVALID"],
    ["the request's additional role differs from the recipe's", change((r) => (r.source.additional[0].role = "other")), "E_RECIPE_INVALID"],
    ["the request's primary quantity is another one", change((r) => (r.source.quantity.name = "t_in")), "E_RECIPE_INVALID"],
    ["the request's unit differs from the approved one", change((r) => (r.source.quantity.unit = "degC")), "E_UNITS"],
    ["no sample selected for the temperature", change((r) => delete r.source.selected), "E_TIME_MAPPING"],
    ["no sample selected for the coefficient", change((r) => delete r.source.additional[0].selected), "E_TIME_MAPPING"],
    ["a non-finite selected value", change((r) => (r.source.selected.value = null)), "E_TIME_MAPPING"],
    ["an interpolated flag that is not a boolean", change((r) => (r.source.selected.interpolated = "no")), "E_TIME_MAPPING"],
    ["a temperature at absolute zero", change((r) => (r.source.selected.value = 0)), "E_OUT_OF_RANGE"],
    ["a temperature below absolute zero in degC", change((r) => { r.recipe.source.unit = "degC"; r.source.quantity.unit = "degC"; r.source.selected.value = -300; }), "E_OUT_OF_RANGE"],
    ["a temperature in a unit FEED does not read", change((r) => { r.recipe.source.unit = "F"; r.source.quantity.unit = "F"; }), "E_UNITS"],
    ["a zero coefficient", change((r) => (r.source.additional[0].selected.value = 0)), "E_OUT_OF_RANGE"],
    ["a negative coefficient", change((r) => (r.source.additional[0].selected.value = -5)), "E_OUT_OF_RANGE"],
    ["a coefficient in a unit FEED does not read", change((r) => { r.recipe.source.additional[0].unit = "W/m2"; r.source.additional[0].quantity.unit = "W/m2"; }), "E_UNITS"],
    ["no unitTo for the coefficient", change((r) => delete r.recipe.source.additional[0].unitTo), "E_UNITS"],
    ["unitTo that is not W/m2/K", change((r) => (r.recipe.source.additional[0].unitTo = "kW/m2/K")), "E_UNITS"],
    ["no target text", change((r) => delete r.target.content), "E_SCHEMA_INVALID"],
    ["a target that is not JSON", change((r) => (r.target.content = "{nope")), "E_SCHEMA_INVALID"],
    ["a target that is not a case", change((r) => (r.target.content = JSON.stringify({ schema: "feed.case/0.1" }))), "E_SCHEMA_INVALID"],
    ["provenance transfers that is not a list", change((r) => (r.target.content = JSON.stringify({ ...pin, provenance: { transfers: 3 } }))), "E_SCHEMA_INVALID"],
  ];
  for (const [name, req, code] of cases) {
    it(`${name}: ${code}`, () => {
      const e = refusal(req);
      expect(e.code).toBe(code);
      expect(e.message.length).toBeGreaterThan(10);
    });
  }

  // The case's own validator would refuse some of these values too, with the same code; the transfer's check comes first and names the cause.
  it("each check is the transfer's own, not the validator's behind it (the message says which)", () => {
    expect(refusal(change((r) => (r.source.selected.value = 0))).message).toMatch(/absolute zero/);
    expect(refusal(change((r) => (r.source.additional[0].selected.value = 0))).message).toMatch(/^the heat transfer coefficient is 0 W/);
    expect(refusal(change((r) => (r.target.content = JSON.stringify({ schema: "feed.case/0.1" })))).message).toMatch(/^the target case is not valid/);
  });

  it("the surface-temperature form refuses a missing sample and a bad temperature too", () => {
    expect(refusal(surfaceRequest((r) => delete r.source.selected)).code).toBe("E_TIME_MAPPING");
    expect(refusal(surfaceRequest((r) => (r.source.selected = { x: 1, value: -1, interpolated: false }))).code).toBe("E_OUT_OF_RANGE");
  });

  it("a recipe that names a role while choosing surface-temperature is not accepted as that form", () => {
    expect(refusal(surfaceRequest((r) => { r.recipe.source.additional = [{ role: HTC }]; r.source.additional = [{ role: HTC }]; })).code).toBe("E_BOUNDARY_INCOMPLETE");
  });

  it("a refusal never carries a case", () => {
    const out = transferBoundary(change((r) => (r.source.selected.value = 0)));
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/output/);
  });
});

describe("describe.transfers and the headless command", () => {
  const cli = join(root, "dist", "cli", "headless.js");
  const send = (stdin: string) => {
    const r = spawnSync(process.execPath, [cli, "transfer"], { input: stdin, encoding: "utf8", timeout: 60_000 });
    const lines = r.stdout.trim().split(String.fromCharCode(10));
    return { code: r.status, json: JSON.parse(lines.at(-1)!) };
  };

  it("offers both forms, matched by SEED on exactly their roles, and keeps within the schema's limits", () => {
    const t = DESCRIBE_TRANSFERS.find((x) => x.field === "coolant-boundary")!;
    expect(t.accepts).toEqual([
      { dimension: "temperature", normalization: "none", additional: [{ role: HTC, dimension: HTC }] },
      { dimension: "temperature", normalization: "none" },
    ]);
    expect(Object.keys(t).sort()).toEqual(["accepts", "field", "parameters"]);
    expect(t.accepts.every((a) => (a.additional ?? []).length <= 4)).toBe(true);
    expect(JSON.stringify(t.parameters)).toMatch(/pressure is not accepted/);
  });

  it("an accepted boundary is exit 0 with one JSON line carrying the complete new case", () => {
    const r = send(JSON.stringify(request()));
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(JSON.parse(r.json.output.content).boundary.bulkTemperature.value).toBe(573.15);
    expect(r.json.checks.boundaryForm).toBe("bulk-plus-h");
  });

  it("a refused boundary is also exit 0, with the typed error", () => {
    const r = send(JSON.stringify(change((x) => delete x.source.selected)));
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: false, errors: [{ code: "E_TIME_MAPPING" }] });
  });

  it("heating still goes through the same command", () => {
    const r = send(JSON.stringify(change((x) => (x.recipe.target.field = "heating-to-pin"))));
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(false);
  });
});
