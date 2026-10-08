// The expected pair for the burnup transfer recipe (SEED writes the recipe, FEED states the target): a record Studio's writer made, a region and a time, and the case the
// transfer must produce. The burnup is the record's cumulative burnup in MWd/tU at that time (linear inside a step, from 0 at t = 0, never extrapolated) times 1e-3, in
// MWd/kgHM, heavy-metal basis, with the record's id as the source. FEED applies its own x 1000 x 0.881 when it writes the solver's field; the transfer never does.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { burnupAt, parseDepletionRecord } from "../src/core/depletionRecord";
import { validateCase } from "../src/core/validate";

const record = parseDepletionRecord(readFileSync("tests/fixtures/studio-depletion-pin-record.json", "utf8"));
const expected = JSON.parse(readFileSync("tests/fixtures/transfer-burnup-expected-case.json", "utf8"));

describe("the burnup transfer pair", () => {
  it("the expected case carries the record's burnup at the chosen time, converted, with the record's id", () => {
    const mwdPerTu = burnupAt(record, "UO2 3.5%", 5);
    expect(mwdPerTu).toBeCloseTo(190, 9);
    expect(expected.burnup.value).toEqual({ value: mwdPerTu * 1e-3, unit: "MWd/kgHM" });
    expect(expected.burnup.basis).toBe("heavy-metal");
    expect(expected.burnup.source).toContain(record.id);
  });
  it("is a valid case", () => {
    const v = validateCase(expected);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.burnup!.value).toBeCloseTo(0.19, 12);
  });
  it("the other times the pair is meant to cover: the end of the first step, a time inside a step, and zero", () => {
    expect(burnupAt(record, "UO2 3.5%", 1) * 1e-3).toBeCloseTo(0.038, 12);
    expect(burnupAt(record, "UO2 3.5%", 3) * 1e-3).toBeCloseTo(0.114, 12);
    expect(burnupAt(record, "UO2 3.5%", 0)).toBe(0);
  });
  it("a time after the end of the record, and an unknown region, are refused by the reader's arithmetic", () => {
    expect(() => burnupAt(record, "UO2 3.5%", 5.01)).toThrow(/out of bounds/);
    expect(() => burnupAt(record, "nope", 1)).toThrow(/unknown region/);
  });
});
