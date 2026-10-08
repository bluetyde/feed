// The reader against a record OpenMC Studio's own writer made (fixture copied from OpenMC test/fixtures/depletion/pin_record.json, a real run, D3 2026-10-08).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { burnupAt, parseDepletionRecord } from "../src/core/depletionRecord";

const text = readFileSync("tests/fixtures/studio-depletion-pin-record.json", "utf8");

describe("a record written by OpenMC Studio", () => {
  it("is read by the reader", () => {
    const r = parseDepletionRecord(text);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0]!.burnup_mwd_per_tu[1]).toBeCloseTo(190, 6);
  });
  it("is accepted with its id, which Studio computed in Python (floats as printed: 1.0, not 1)", () => {
    expect(JSON.parse(text).id).toMatch(/^[0-9a-f]{64}$/);
    expect(parseDepletionRecord(text).id).toBe(JSON.parse(text).id);
  });
  it("is refused when a number is changed after it was written", () => {
    expect(() => parseDepletionRecord(text.replace("190.0", "191.0"))).toThrow(/id: does not match/);
  });
  it("is refused when the id is not a SHA-256", () => {
    expect(() => parseDepletionRecord(text.replace(/"id": "[0-9a-f]{64}"/, '"id": "abc"'))).toThrow(/id: expected 64/);
  });
  it("is accepted without an id (older writers)", () => {
    const j = JSON.parse(text);
    delete j.id;
    expect(parseDepletionRecord(JSON.stringify(j)).id).toBeUndefined();
  });
  it("reads the number tokens as written: a re-serialised copy (1.0 printed as 1) no longer matches", () => {
    const j = JSON.parse(text);
    const r = parseDepletionRecord(text);
    const shuffled = JSON.stringify({ provenance: j.provenance, id: j.id, regions: j.regions, k: j.k, isotopics: j.isotopics, time_steps_days: j.time_steps_days, schema: j.schema }, null, 3);
    // JS prints 1.0 as 1, so the number tokens differ from the writer's: the id must refuse, which shows the check reads the tokens
    expect(() => parseDepletionRecord(shuffled)).toThrow(/id: does not match/);
    expect(r.id).toBe(j.id);
  });
  it("gives the burnup at the end of each step, MWd/tU, heavy-metal basis", () => {
    const r = parseDepletionRecord(text);
    const name = r.regions[0]!.name;
    const ends = r.time_steps_days.reduce<number[]>((a, d) => [...a, (a[a.length - 1] ?? 0) + d], []);
    expect(burnupAt(r, name, ends[0]!)).toBeCloseTo(38, 6);
    expect(burnupAt(r, name, ends[1]!)).toBeCloseTo(190, 6);
  });
});
