// The burnup transfer (plan 10 M6, SEED contract: transfer-recipe.md section 8): a request of schema seed.transfer-request/0.3 whose source is a depletion record. The shapes
// are SEED's published ones; the record is the Studio fixture (region "UO2 3.5%", steps of 1 and 4 days, 38 and 190 MWd/tU); SEED sends the burnup already converted.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { burnupAt, parseDepletionRecord } from "../src/core/depletionRecord";
import { DESCRIBE_TRANSFERS, transfer } from "../src/core/transferRequest";
import { validateCase } from "../src/core/validate";

const record = parseDepletionRecord(readFileSync("tests/fixtures/studio-depletion-pin-record.json", "utf8"));
const ID = record.id!;
const pair = JSON.parse(readFileSync("tests/fixtures/transfer-burnup-expected-case.json", "utf8"));
const base = () => JSON.parse(readFileSync("examples/lwr-uo2-burnup.json", "utf8"));
const QUANTITY = { name: "burnup", dimension: "burnup", unit: "MWd/kgHM", basis: "heavy-metal", value: 0.19 };

interface Over {
  target?: unknown;
  source?: Record<string, unknown>;
  recipe?: Record<string, unknown>;
  recipeSource?: Record<string, unknown>;
}
/** SEED's request for a time in the record (the numbers are the reader's; the converted value is MWd/tU x 0.001). */
function request(time: number, over: Over = {}) {
  const original = burnupAt(record, "UO2 3.5%", time);
  const interpolated = time > 0 && time !== 1 && time !== 5;
  const target = over.target ?? base();
  return {
    schema: "seed.transfer-request/0.3",
    recipe: {
      schema: "seed.transfer-recipe/0.3",
      recipeId: "recipe-burnup-1",
      source: { kind: "record", record: "depletion-record/1", artifact: "art-1", recordSha256: "0".repeat(64), recordId: ID, region: "UO2 3.5%", time, revisionPins: [], ...over.recipeSource },
      target: { app: "feed", artifact: "case-1", revision: "1".repeat(64), field: "burnup" },
      units: { field: "burnup_mwd_per_tu", from: "MWd/tU", to: "MWd/kgHM", factor: 0.001, basis: "heavy-metal" },
      ...over.recipe,
    },
    recipeDigest: "2".repeat(64),
    source: {
      kind: "record",
      record: "depletion-record/1",
      recordId: ID,
      recordSha256: "0".repeat(64),
      region: "UO2 3.5%",
      time,
      quantity: { name: "burnup", dimension: "burnup", unit: "MWd/kgHM", basis: "heavy-metal", value: original * 0.001 },
      original: { unit: "MWd/tU", value: original },
      interpolated,
      ...over.source,
    },
    target: { artifact: "case-1", revision: "1".repeat(64), content: typeof target === "string" ? target : JSON.stringify(target, null, 2) + "\n" },
  };
}
const codes = (r: any) => (r.ok ? [] : r.errors.map((e: any) => e.code + " " + e.field));

describe("the burnup transfer, the expected pair", () => {
  it("record, region and time 5 give the expected case: only the burnup (and the name, id and a provenance entry) differ", () => {
    const r: any = transfer(request(5));
    expect(r.ok).toBe(true);
    const out = JSON.parse(r.output.content);
    expect(out.provenance.transfers).toHaveLength(1);
    expect(out.provenance.transfers[0]).toMatchObject({ kind: "burnup", recordId: ID, region: "UO2 3.5%", time: 5, interpolated: false, original: { value: 190, unit: "MWd/tU" }, burnup: { value: 0.19, unit: "MWd/kgHM", basis: "heavy-metal" } });
    const strip = (d: any) => {
      const c = JSON.parse(JSON.stringify(d));
      delete c.provenance;
      delete c.caseId;
      delete c.name;
      return c;
    };
    expect(strip(out)).toEqual(strip(pair));
    expect(validateCase(out).errors).toEqual([]);
  });
  it("times 1, 3 and 0 give 0.038, 0.114 (interpolated) and 0", () => {
    const at = (t: number) => JSON.parse((transfer(request(t)) as any).output.content);
    expect(at(1).burnup.value.value).toBeCloseTo(0.038, 12);
    expect(at(3).burnup.value.value).toBeCloseTo(0.114, 12);
    expect(at(3).provenance.transfers[0].interpolated).toBe(true);
    expect(at(3).burnup.source).toContain("interpolated");
    expect(at(0).burnup.value.value).toBe(0);
  });
  it("the record id is in the new burnup source, and the original case is not modified", () => {
    const b = base();
    const before = JSON.stringify(b);
    const r: any = transfer(request(5, { target: b }));
    expect(JSON.parse(r.output.content).burnup.source).toContain(ID);
    expect(JSON.stringify(b)).toBe(before);
  });
  it("a second transfer appends to the provenance", () => {
    const first: any = transfer(request(5));
    const second: any = transfer(request(3, { target: JSON.parse(first.output.content) }));
    expect(second.ok).toBe(true);
    expect(JSON.parse(second.output.content).provenance.transfers).toHaveLength(2);
  });
  it("the same transfer applied twice to its own output changes only the provenance, so it is not refused as no change", () => {
    const first: any = transfer(request(5));
    expect(transfer(request(5, { target: JSON.parse(first.output.content) })).ok).toBe(true);
  });
  it("reports the conversion in its checks", () => {
    const r: any = transfer(request(5));
    expect(r.checks.burnup).toEqual({ value: 0.19, unit: "MWd/kgHM", basis: "heavy-metal" });
    expect(r.checks.record).toMatchObject({ id: ID, region: "UO2 3.5%", timeDays: 5, interpolated: false });
  });
});

describe("what the burnup transfer refuses", () => {
  it("a fuel that does not use the burnup model, and a transient", () => {
    const t = base();
    t.materials.fuel.sets["thermal.conductivity"] = { model: "constant", value: { value: 3, unit: "W/m/K" }, referenceTemperature: { value: 1000, unit: "K" }, source: "x" };
    delete t.burnup;
    expect(codes(transfer(request(5, { target: t })))).toEqual(["E_UNSUPPORTED /target/content/materials/fuel/sets/thermal.conductivity/model"]);
    const tr = base();
    tr.assumptions.steadyState = false;
    expect(codes(transfer(request(5, { target: tr })))).toEqual(["E_UNSUPPORTED /target/content"]);
  });
  it("a burnup above the range of the model (the validator of the case speaks)", () => {
    const r: any = transfer(request(5, { source: { quantity: { ...QUANTITY, value: 63 }, original: { unit: "MWd/tU", value: 63000 } } }));
    expect(codes(r)).toEqual(["E_OUT_OF_RANGE /target/content/burnup/value"]);
  });
  it("an oxide basis, a wrong unit, a conversion that does not match the original", () => {
    expect(codes(transfer(request(5, { source: { quantity: { ...QUANTITY, basis: "oxide" } } })))).toEqual(["E_UNSUPPORTED /source/quantity/basis"]);
    expect(codes(transfer(request(5, { source: { quantity: { ...QUANTITY, unit: "GWd/tHM" } } })))).toEqual(["E_UNITS /source/quantity/unit"]);
    expect(codes(transfer(request(5, { source: { quantity: { ...QUANTITY, value: 0.2 } } })))).toEqual(["E_UNITS /source/quantity/value"]);
  });
  it("a recipe whose units are not heavy metal at 0.001, or that is not for the burnup of FEED", () => {
    expect(codes(transfer(request(5, { recipe: { units: { field: "burnup_mwd_per_tu", from: "MWd/tU", to: "MWd/kgHM", factor: 0.0008815, basis: "oxide" } } })))).toEqual(["E_UNITS /recipe/units"]);
    expect(codes(transfer(request(5, { recipe: { target: { app: "nodal", field: "burnup" } } })))).toEqual(["E_RECIPE_INVALID /recipe/target/app"]);
    expect(codes(transfer(request(5, { recipe: { source: { kind: "run" } } })))).toEqual(["E_RECIPE_INVALID /recipe/source"]);
  });
  it("each recipe fault alone is refused: the factor, the basis, the schema, a source that is not a depletion record", () => {
    const units = { field: "burnup_mwd_per_tu", from: "MWd/tU", to: "MWd/kgHM", factor: 0.001, basis: "heavy-metal" };
    expect(codes(transfer(request(5, { recipe: { units: { ...units, factor: 0.0008815 } } })))).toEqual(["E_UNITS /recipe/units"]);
    expect(codes(transfer(request(5, { recipe: { units: { ...units, basis: "oxide" } } })))).toEqual(["E_UNITS /recipe/units"]);
    expect(codes(transfer(request(5, { recipe: { schema: "seed.transfer-recipe/0.2" } })))).toEqual(["E_RECIPE_INVALID /recipe"]);
    const rs = (over: Record<string, unknown>) => ({ kind: "record", record: "depletion-record/1", recordId: ID, region: "UO2 3.5%", time: 5, ...over });
    expect(codes(transfer(request(5, { recipe: { source: rs({ kind: "run" }) } })))).toEqual(["E_RECIPE_INVALID /recipe/source"]);
    expect(codes(transfer(request(5, { recipe: { source: rs({ record: "other-record/1" }) } })))).toEqual(["E_RECIPE_INVALID /recipe/source"]);
  });
  it("a recipe for another record field, a record file hash that is not the approved one, a missing or malformed hash", () => {
    const units = { field: "other_field", from: "MWd/tU", to: "MWd/kgHM", factor: 0.001, basis: "heavy-metal" };
    expect(codes(transfer(request(5, { recipe: { units } })))).toEqual(["E_UNITS /recipe/units"]);
    expect(codes(transfer(request(5, { recipeSource: { recordSha256: "f".repeat(64) } })))).toEqual(["E_RECIPE_INVALID /source/recordSha256"]);
    expect(codes(transfer(request(5, { source: { recordSha256: "abc" }, recipeSource: { recordSha256: "abc" } })))).toEqual(["E_SCHEMA_INVALID /source/recordSha256"]);
    expect(codes(transfer(request(5, { source: { recordSha256: undefined }, recipeSource: { recordSha256: undefined } })))).toEqual(["E_SCHEMA_INVALID /source/recordSha256"]);
  });
  it("a request that is not the approved recipe: another region, time or record id", () => {
    expect(codes(transfer(request(5, { recipeSource: { region: "other" } })))).toEqual(["E_RECIPE_INVALID /source/region"]);
    expect(codes(transfer(request(5, { recipeSource: { time: 4 } })))).toEqual(["E_RECIPE_INVALID /source/time"]);
    expect(codes(transfer(request(5, { recipeSource: { recordId: "a".repeat(64) } })))).toEqual(["E_RECIPE_INVALID /source/recordId"]);
  });
  it("a malformed request: schema, record id, time, negative value, missing original, no interpolated flag", () => {
    expect(codes(transfer({ ...request(5), schema: "seed.transfer-request/0.2" }))).toEqual(["E_SCHEMA_INVALID /schema"]);
    expect(codes(transfer(request(5, { source: { recordId: "abc" } })))).toEqual(["E_SCHEMA_INVALID /source/recordId"]);
    expect(codes(transfer(request(5, { source: { time: -1 } })))).toEqual(["E_SCHEMA_INVALID /source/time"]);
    expect(codes(transfer(request(5, { source: { quantity: { ...QUANTITY, value: -1 } } })))).toEqual(["E_OUT_OF_RANGE /source/quantity/value"]);
    expect(codes(transfer(request(5, { source: { original: undefined } })))).toEqual(["E_SCHEMA_INVALID /source/original"]);
    expect(codes(transfer(request(5, { source: { interpolated: undefined } })))).toEqual(["E_SCHEMA_INVALID /source/interpolated"]);
  });
  it("a target that is not JSON, or has a malformed provenance", () => {
    expect(codes(transfer(request(5, { target: "not json" })))).toEqual(["E_SCHEMA_INVALID /target/content"]);
    const t = base();
    t.provenance = { transfers: "no" };
    expect(codes(transfer(request(5, { target: t })))).toEqual(["E_SCHEMA_INVALID /target/content/provenance"]);
  });
  it("a request for another field is not read as a burnup, and a burnup request is not read as heating", () => {
    const r: any = transfer(request(5, { recipe: { target: { app: "feed", field: "heating-to-pin" } } }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe("E_SCHEMA_INVALID");
  });
});

describe("the describe entry and the command", () => {
  it("describe lists the burnup transfer with its accepted dimension and its parameters", () => {
    const t: any = DESCRIBE_TRANSFERS.find((x) => x.field === "burnup");
    expect(t.accepts).toEqual([{ dimension: "burnup", normalization: "none" }]);
    expect(Object.keys(t.parameters)).toEqual(expect.arrayContaining(["region", "time"]));
  });
  it("the built command answers on stdin with one JSON line and exit 0 (needs npm run build)", () => {
    const p = spawnSync("node", ["dist/cli/headless.js", "transfer"], { input: JSON.stringify(request(5)), encoding: "utf8" });
    expect(p.status).toBe(0);
    const reply = JSON.parse(p.stdout.trim().split("\n").pop()!);
    expect(reply.ok).toBe(true);
    expect(JSON.parse(reply.output.content).burnup.value.value).toBeCloseTo(0.19, 12);
    const bad = spawnSync("node", ["dist/cli/headless.js", "transfer"], { input: JSON.stringify(request(5, { source: { quantity: { ...QUANTITY, basis: "oxide" } } })), encoding: "utf8" });
    expect(bad.status).toBe(0);
    expect(JSON.parse(bad.stdout.trim().split("\n").pop()!).errors[0].code).toBe("E_UNSUPPORTED");
  });
});
