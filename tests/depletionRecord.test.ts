// Depletion record reader (src/core/depletionRecord.ts): parse, validate, interpolate burnup in time, and basis conversion.
// Hand-off record from depletion calculations: verifies consistency between power history and burnup, strictly validates structure,
// and interpolates cumulative burnup per region.

import { describe, expect, it } from "vitest";
import {
  burnupAt,
  DepletionRecord,
  DepletionRecordError,
  endTimesDays,
  parseDepletionRecord,
  toOxideBasis,
} from "../src/core/depletionRecord";

function baseWorkedExample(): Record<string, unknown> {
  return {
    schema: "studio.depletion/0.1",
    time_steps_days: [10, 20, 30],
    regions: [
      {
        name: "fuel",
        cell_ids: [1],
        heavy_metal_mass_kg: 2.0,
        power_w: [1000, 2000, 1500],
        burnup_mwd_per_tu: [5.0, 25.0, 47.5],
      },
    ],
    k: [
      [1.3, 0.001],
      [1.29, 0.001],
      [1.28, 0.001],
      [1.27, 0.001],
    ],
    provenance: { written: "2026-10-07T12:00:00+00:00" },
  };
}

function assertErrorPath(fn: () => unknown, expectedPath: string): void {
  expect(fn).toThrowError(DepletionRecordError);
  try {
    fn();
  } catch (e) {
    if (e instanceof DepletionRecordError) {
      expect(e.path).toBe(expectedPath);
      expect(e.message.startsWith(`${expectedPath}: `)).toBe(true);
      return;
    }
    throw e;
  }
}

describe("depletion record reader", () => {
  it("parses the worked example and satisfies interpolation and boundary checks", () => {
    const raw = baseWorkedExample();
    const rec = parseDepletionRecord(JSON.stringify(raw));

    expect(rec.schema).toBe("studio.depletion/0.1");
    expect(endTimesDays(rec)).toEqual([10, 30, 60]);

    // burnupAt points: (0, 0), (10, 5), (15, 10), (30, 25), (60, 47.5)
    expect(burnupAt(rec, "fuel", 0)).toBe(0);
    expect(burnupAt(rec, "fuel", 10)).toBe(5);
    expect(burnupAt(rec, "fuel", 15)).toBe(10);
    expect(burnupAt(rec, "fuel", 30)).toBe(25);
    expect(burnupAt(rec, "fuel", 60)).toBe(47.5);

    // out of bounds tDays
    assertErrorPath(() => burnupAt(rec, "fuel", 61), "tDays");
    assertErrorPath(() => burnupAt(rec, "fuel", -1), "tDays");

    // unknown region
    assertErrorPath(() => burnupAt(rec, "cladding", 10), "regionName");
  });

  it("handles a two-region record comparing burnupAt at each end time and midpoint to an independent oracle loop", () => {
    const timeSteps = [5, 15, 25];
    const r1 = {
      name: "inner_fuel",
      cell_ids: [1, 2],
      heavy_metal_mass_kg: 1.5,
      power_w: [500, 1200, 800],
    };
    const r2 = {
      name: "outer_fuel",
      cell_ids: [3, 4],
      heavy_metal_mass_kg: 2.5,
      power_w: [800, 1500, 1000],
    };

    // Independent plain loop to compute expected cumulative burnups
    const computeExpected = (massKg: number, powers: number[]): number[] => {
      const burnups: number[] = [];
      let cumMWd = 0;
      const tU = massKg / 1000;
      for (let i = 0; i < timeSteps.length; i++) {
        cumMWd += (powers[i]! / 1e6) * timeSteps[i]!;
        burnups.push(cumMWd / tU);
      }
      return burnups;
    };

    const b1 = computeExpected(r1.heavy_metal_mass_kg, r1.power_w);
    const b2 = computeExpected(r2.heavy_metal_mass_kg, r2.power_w);

    const doc = {
      schema: "studio.depletion/0.1",
      time_steps_days: timeSteps,
      regions: [
        { ...r1, burnup_mwd_per_tu: b1 },
        { ...r2, burnup_mwd_per_tu: b2 },
      ],
      provenance: { id: "two-region-test" },
    };

    const rec = parseDepletionRecord(JSON.stringify(doc));
    const endTimes = endTimesDays(rec);
    expect(endTimes).toEqual([5, 20, 45]);

    // Compare at each end time for both regions to 1e-12
    for (let i = 0; i < endTimes.length; i++) {
      const t = endTimes[i]!;
      expect(Math.abs(burnupAt(rec, "inner_fuel", t) - b1[i]!)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(burnupAt(rec, "outer_fuel", t) - b2[i]!)).toBeLessThanOrEqual(1e-12);
    }

    // Midpoint of the second step: between step 1 end (5 d) and step 2 end (20 d) => t = 12.5 d
    const tMid = 0.5 * (endTimes[0]! + endTimes[1]!);
    const expectedMid1 = b1[0]! + 0.5 * (b1[1]! - b1[0]!);
    const expectedMid2 = b2[0]! + 0.5 * (b2[1]! - b2[0]!);

    expect(Math.abs(burnupAt(rec, "inner_fuel", tMid) - expectedMid1)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(burnupAt(rec, "outer_fuel", tMid) - expectedMid2)).toBeLessThanOrEqual(1e-12);
  });

  it("converts burnup to oxide basis and validates fraction bounds", () => {
    expect(toOxideBasis(100, 0.8)).toBe(80);
    expect(toOxideBasis(100, 1.0)).toBe(100);

    // f <= 0 or f > 1 or non-finite
    expect(() => toOxideBasis(100, 0)).toThrowError(DepletionRecordError);
    expect(() => toOxideBasis(100, -0.2)).toThrowError(DepletionRecordError);
    expect(() => toOxideBasis(100, 1.2)).toThrowError(DepletionRecordError);
    expect(() => toOxideBasis(100, NaN)).toThrowError(DepletionRecordError);
    expect(() => toOxideBasis(100, Infinity)).toThrowError(DepletionRecordError);
    expect(() => toOxideBasis(100, -Infinity)).toThrowError(DepletionRecordError);

    // burnupMwdPerTu non-finite
    expect(() => toOxideBasis(NaN, 0.8)).toThrowError(DepletionRecordError);
    expect(() => toOxideBasis(Infinity, 0.8)).toThrowError(DepletionRecordError);
  });

  it("fails every validation rule with the expected error path", () => {
    // 1. wrong schema
    {
      const d = baseWorkedExample();
      d.schema = "studio.depletion/0.2";
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "schema");
    }

    // 2. unknown top-level key
    {
      const d = baseWorkedExample();
      d.unknown_extra = 123;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "unknown_extra");
    }

    // 3. time_steps_days: empty, with 0, negative, NaN, a boolean
    {
      const d = baseWorkedExample();
      d.time_steps_days = [];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "time_steps_days");
    }
    {
      const d = baseWorkedExample();
      d.time_steps_days = [0, 20, 30];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "time_steps_days");
    }
    {
      const d = baseWorkedExample();
      d.time_steps_days = [10, -20, 30];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "time_steps_days");
    }
    {
      // NaN becomes null in JSON
      const json = JSON.stringify(baseWorkedExample()).replace("[10,20,30]", "[null,20,30]");
      assertErrorPath(() => parseDepletionRecord(json), "time_steps_days");
    }
    {
      const d = baseWorkedExample();
      d.time_steps_days = [10, true, 30];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "time_steps_days");
    }

    // 4. duplicate region name
    {
      const d = baseWorkedExample();
      const r0 = (d.regions as Record<string, unknown>[])[0]!;
      d.regions = [r0, { ...r0, cell_ids: [2] }];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[1].name");
    }

    // 5. empty region name
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).name = "";
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].name");
    }

    // 6. cell_ids: empty, duplicated, 0, a boolean
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).cell_ids = [];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].cell_ids");
    }
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).cell_ids = [1, 1];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].cell_ids");
    }
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).cell_ids = [0];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].cell_ids");
    }
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).cell_ids = [true];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].cell_ids");
    }

    // 7. mass 0, negative, NaN
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).heavy_metal_mass_kg = 0;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].heavy_metal_mass_kg");
    }
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).heavy_metal_mass_kg = -2.0;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].heavy_metal_mass_kg");
    }
    {
      const json = JSON.stringify(baseWorkedExample()).replace('"heavy_metal_mass_kg":2', '"heavy_metal_mass_kg":null');
      assertErrorPath(() => parseDepletionRecord(json), "regions[0].heavy_metal_mass_kg");
    }

    // 8. power_w: wrong length, negative, a boolean
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).power_w = [1000, 2000];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].power_w");
    }
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).power_w = [1000, -2000, 1500];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].power_w");
    }
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).power_w = [1000, false, 1500];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].power_w");
    }

    // 9. burnup_mwd_per_tu: wrong length, decreasing, negative
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).burnup_mwd_per_tu = [5.0, 25.0];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].burnup_mwd_per_tu");
    }
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).burnup_mwd_per_tu = [5.0, 4.0, 47.5];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].burnup_mwd_per_tu");
    }
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).burnup_mwd_per_tu = [-5.0, 25.0, 47.5];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].burnup_mwd_per_tu");
    }

    // 10. burnup that disagrees with the power history by 1 part in 1e6
    {
      const d = baseWorkedExample();
      const b = [5.0 * (1 + 1e-6), 25.0, 47.5];
      ((d.regions as Record<string, unknown>[])[0]!).burnup_mwd_per_tu = b;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].burnup_mwd_per_tu");
    }

    // 11. k: wrong length, a pair of the wrong size, value 0, negative sigma
    {
      const d = baseWorkedExample();
      d.k = [[1.3, 0.001]]; // length 1 instead of 4 (n + 1)
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "k");
    }
    {
      const d = baseWorkedExample();
      d.k = [
        [1.3, 0.001, 0.001],
        [1.29, 0.001],
        [1.28, 0.001],
        [1.27, 0.001],
      ];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "k");
    }
    {
      const d = baseWorkedExample();
      d.k = [
        [0, 0.001],
        [1.29, 0.001],
        [1.28, 0.001],
        [1.27, 0.001],
      ];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "k");
    }
    {
      const d = baseWorkedExample();
      d.k = [
        [1.3, -0.001],
        [1.29, 0.001],
        [1.28, 0.001],
        [1.27, 0.001],
      ];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "k");
    }

    // 12. isotopics: naming a region that does not exist, a list of the wrong length, a negative amount
    {
      const d = baseWorkedExample();
      d.isotopics = {
        nonexistent: {
          U235: [1e20, 1e20, 1e20, 1e20],
        },
      };
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "isotopics");
    }
    {
      const d = baseWorkedExample();
      d.isotopics = {
        fuel: {
          U235: [1e20, 1e20], // length 2 instead of 4
        },
      };
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "isotopics");
    }
    {
      const d = baseWorkedExample();
      d.isotopics = {
        fuel: {
          U235: [1e20, -1, 1e20, 1e20],
        },
      };
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "isotopics");
    }

    // 13. provenance: missing or an array
    {
      const d = baseWorkedExample();
      delete d.provenance;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "provenance");
    }
    {
      const d = baseWorkedExample();
      d.provenance = ["invalid", "array"];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "provenance");
    }

    // 14. text that is not JSON
    {
      const notJson = "{ invalid json: 123";
      expect(() => parseDepletionRecord(notJson)).toThrowError(DepletionRecordError);
      try {
        parseDepletionRecord(notJson);
      } catch (e) {
        if (e instanceof DepletionRecordError) {
          expect(e.path).toBe("depletion.json");
          expect(e.message).toBe("depletion.json: not valid JSON");
        } else {
          throw e;
        }
      }
    }

    // 15. text that is a JSON array
    {
      assertErrorPath(() => parseDepletionRecord("[]"), "depletion.json");
    }

    // 16. unknown key inside a region
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).extra_prop = true;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].extra_prop");
    }

    // 17. missing required top-level and region properties
    {
      const d = baseWorkedExample();
      delete d.schema;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "schema");
    }
    {
      const d = baseWorkedExample();
      delete d.time_steps_days;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "time_steps_days");
    }
    {
      const d = baseWorkedExample();
      delete d.regions;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions");
    }
    {
      const d = baseWorkedExample();
      delete ((d.regions as Record<string, unknown>[])[0]!).name;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].name");
    }
    {
      const d = baseWorkedExample();
      delete ((d.regions as Record<string, unknown>[])[0]!).cell_ids;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].cell_ids");
    }
    {
      const d = baseWorkedExample();
      delete ((d.regions as Record<string, unknown>[])[0]!).heavy_metal_mass_kg;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].heavy_metal_mass_kg");
    }
    {
      const d = baseWorkedExample();
      delete ((d.regions as Record<string, unknown>[])[0]!).power_w;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].power_w");
    }
    {
      const d = baseWorkedExample();
      delete ((d.regions as Record<string, unknown>[])[0]!).burnup_mwd_per_tu;
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].burnup_mwd_per_tu");
    }

    // 18. non-integer and negative cell_ids
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).cell_ids = [1.5];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].cell_ids");
    }
    {
      const d = baseWorkedExample();
      ((d.regions as Record<string, unknown>[])[0]!).cell_ids = [-5];
      assertErrorPath(() => parseDepletionRecord(JSON.stringify(d)), "regions[0].cell_ids");
    }
  });

  it("checks absolute tolerance 1e-12 when computed burnup is 0", () => {
    // Zero power in step 1 => computed burnup is 0.0 MWd/tU
    // Stored burnup of 0.0 or <= 1e-12 should pass; > 1e-12 should fail
    const d = {
      schema: "studio.depletion/0.1",
      time_steps_days: [10, 20],
      regions: [
        {
          name: "idle_fuel",
          cell_ids: [1],
          heavy_metal_mass_kg: 2.0,
          power_w: [0, 1000],
          // step 1: 0 MWd/tU; step 2: (1000/1e6)*20 / (2/1000) = 10.0 MWd/tU
          burnup_mwd_per_tu: [0.0, 10.0],
        },
      ],
      provenance: {},
    };

    const rec = parseDepletionRecord(JSON.stringify(d));
    expect(burnupAt(rec, "idle_fuel", 5)).toBe(0);

    // Stored 1e-13 is within 1e-12 absolute tolerance
    const passD = {
      ...d,
      regions: [{ ...d.regions[0]!, burnup_mwd_per_tu: [1e-13, 10.0] }],
    };
    expect(() => parseDepletionRecord(JSON.stringify(passD))).not.toThrow();

    // Stored 1e-11 exceeds 1e-12 absolute tolerance
    const failD = {
      ...d,
      regions: [{ ...d.regions[0]!, burnup_mwd_per_tu: [1e-11, 10.0] }],
    };
    assertErrorPath(() => parseDepletionRecord(JSON.stringify(failD)), "regions[0].burnup_mwd_per_tu");
  });

  it("checks non-finite time inputs for burnupAt", () => {
    const rec = parseDepletionRecord(JSON.stringify(baseWorkedExample()));
    assertErrorPath(() => burnupAt(rec, "fuel", NaN), "tDays");
    assertErrorPath(() => burnupAt(rec, "fuel", Infinity), "tDays");
    assertErrorPath(() => burnupAt(rec, "fuel", -Infinity), "tDays");
  });

  it("parses records with optional k and isotopics and verifies absence when omitted", () => {
    // Record with both k and isotopics
    const withOpt = baseWorkedExample();
    withOpt.isotopics = {
      fuel: {
        U235: [1.0e20, 0.99e20, 0.98e20, 0.97e20],
        Pu239: [0, 1.0e17, 2.5e17, 4.0e17],
      },
    };
    const recWith = parseDepletionRecord(JSON.stringify(withOpt));
    expect(recWith.k).toBeDefined();
    expect(recWith.k!.length).toBe(4);
    expect(recWith.isotopics).toBeDefined();
    expect(recWith.isotopics!["fuel"]!["U235"]).toEqual([1.0e20, 0.99e20, 0.98e20, 0.97e20]);

    // Record without k and isotopics
    const withoutOpt = baseWorkedExample();
    delete withoutOpt.k;
    delete withoutOpt.isotopics;
    const recWithout = parseDepletionRecord(JSON.stringify(withoutOpt));
    expect("k" in recWithout).toBe(false);
    expect("isotopics" in recWithout).toBe(false);
    expect(recWithout.k).toBeUndefined();
    expect(recWithout.isotopics).toBeUndefined();
  });
});
