// Temperature limits (src/core/limits.ts, docs/temperature-limits.md): the rules' arithmetic at its boundaries, the checks they make, the checks in the results of a
// steady run and of a pulse (on real OFFBEAT output), and the sourced TRIGA set.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { evaluateLimit, limitApplies, limitChecks, LimitRule, LimitState, showT } from "../src/core/limits";
import { buildResults } from "../src/core/resultsParser";
import { buildTransientResults } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";
import { library, sourcedLimits } from "../src/server/server";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const rule = (extra: Partial<LimitRule> = {}): LimitRule => ({ name: "Fuel", region: "fuel", maxTemperature: 1000, source: "a test", ...extra });
const S = (time: number, fuelMax: number, claddingMax: number): LimitState => ({ time, fuelMax, claddingMax });

describe("when a rule is in force", () => {
  it("has no condition: always", () => {
    expect(limitApplies(rule(), S(0, 1, 1e6))).toBe(true);
  });
  it("atMost includes its temperature, above excludes it, and both together are a band", () => {
    expect(limitApplies(rule({ whileCladding: { atMost: 773.15 } }), S(0, 1, 773.15))).toBe(true);
    expect(limitApplies(rule({ whileCladding: { atMost: 773.15 } }), S(0, 1, 773.16))).toBe(false);
    expect(limitApplies(rule({ whileCladding: { above: 773.15 } }), S(0, 1, 773.15))).toBe(false);
    expect(limitApplies(rule({ whileCladding: { above: 773.15 } }), S(0, 1, 773.16))).toBe(true);
    const band = rule({ whileCladding: { above: 400, atMost: 800 } });
    expect([399, 400, 401, 800, 801].map((c) => limitApplies(band, S(0, 1, c)))).toEqual([false, false, true, true, false]);
  });
  it("the two TRIGA rules split every cladding temperature between them (no gap, no overlap)", () => {
    const lo = rule({ whileCladding: { atMost: 773.15 } });
    const hi = rule({ whileCladding: { above: 773.15 } });
    for (const c of [300, 773.14, 773.15, 773.1500001, 900]) expect(Number(limitApplies(lo, S(0, 1, c))) + Number(limitApplies(hi, S(0, 1, c)))).toBe(1);
  });
});

describe("the margin of a rule over a run", () => {
  it("is the smallest limit minus temperature over the moments it is in force, with where it was", () => {
    const states = [S(0, 600, 300), S(1, 900, 350), S(2, 950, 360), S(3, 700, 340)];
    const o = evaluateLimit(rule(), states);
    expect(o.applied).toBe(4);
    expect(o.margin).toBe(50);
    expect(o.worst).toEqual({ time: 2, temperature: 950, cladding: 360 });
  });
  it("a cladding rule looks at the cladding, and a negative margin is an exceedance", () => {
    const o = evaluateLimit(rule({ region: "cladding", maxTemperature: 340 }), [S(0, 5000, 330), S(1, 5000, 345)]);
    expect(o.margin).toBe(-5);
    expect(o.worst!.time).toBe(1);
  });
  it("only the moments the condition holds count: a hot fuel while the cladding is above the band does not break the lower rule", () => {
    const states = [S(0, 1200, 300), S(1, 1000, 900)];
    expect(evaluateLimit(rule({ maxTemperature: 1150, whileCladding: { atMost: 773.15 } }), states).margin).toBe(-50);
    expect(evaluateLimit(rule({ maxTemperature: 1150, whileCladding: { above: 773.15 } }), states).margin).toBe(150);
  });
  it("a rule that never applies has no margin and no worst moment", () => {
    expect(evaluateLimit(rule({ whileCladding: { above: 2000 } }), [S(0, 1, 1)])).toEqual({ applied: 0, margin: null, worst: null });
    expect(evaluateLimit(rule(), [])).toEqual({ applied: 0, margin: null, worst: null });
  });
});

describe("the checks", () => {
  it("pass with a margin, fail past the limit, and say where, with the source, in kelvin and Celsius, and that no stress is computed", () => {
    const r = rule({ name: "TRIGA fuel", maxTemperature: 1423.15, source: "SAR section 4.7", whileCladding: { atMost: 773.15 } });
    const [ok] = limitChecks([r], [S(0, 1000, 400)]);
    expect(ok).toMatchObject({ id: "temperatureLimit1", verdict: "pass", unit: "K" });
    expect(ok!.value).toBeCloseTo(423.15, 9);
    expect(ok!.label).toBe("Temperature limit: TRIGA fuel");
    expect(ok!.note).toContain("1423.15 K (1150 C)");
    expect(ok!.note).toContain("at most 773.15 K (500 C)");
    expect(ok!.note).toContain("Source: SAR section 4.7.");
    expect(ok!.note).toContain("FEED computes no stress; staying below a limit is not an integrity assessment.");
    const [bad] = limitChecks([r], [S(0, 1500, 400)]);
    expect(bad!.verdict).toBe("fail");
    expect(bad!.value!).toBeCloseTo(-76.85, 9);
  });
  it("a margin of exactly zero passes; a rule that never applied passes with no value and says it was not in force", () => {
    expect(limitChecks([rule()], [S(0, 1000, 1)])[0]!.verdict).toBe("pass");
    expect(limitChecks([rule()], [S(0, 1000.0001, 1)])[0]!.verdict).toBe("fail");
    const [c] = limitChecks([rule({ whileCladding: { above: 900 } })], [S(0, 5000, 300)]);
    expect(c).toMatchObject({ verdict: "pass", value: null });
    expect(c!.note).toContain("was not in force");
  });
  it("numbers the rules in order and takes the worse of the outputs and the independent steps, saying which decided", () => {
    const rules = [rule({ name: "A" }), rule({ name: "B", maxTemperature: 2000 })];
    const observed = [S(0, 500, 300), S(0.01, 900, 310)];
    const independent = [S(0, 500, 300), S(0.005, 990, 305), S(0.01, 900, 310)]; // a peak between two outputs
    const [a, b] = limitChecks(rules, observed, independent);
    expect([a!.id, b!.id]).toEqual(["temperatureLimit1", "temperatureLimit2"]);
    expect(a!.value).toBe(10);
    expect(a!.note).toContain("from the independent solution (every step)");
    expect(a!.note).toContain("t = 0.005 s");
    expect(b!.value).toBe(1010);
    const [c] = limitChecks([rule()], [S(0, 990, 300)], [S(0, 900, 300)]);
    expect(c!.note).toContain("from the solver's outputs");
    expect(c!.value).toBe(10);
  });
  it("shows a temperature in kelvin with Celsius beside it, rounded", () => {
    expect(showT(1423.15)).toBe("1423.15 K (1150 C)");
    expect(showT(300)).toBe("300 K (26.85 C)");
  });
});

describe("in the results of a steady run (real OFFBEAT output of the synthetic pin)", () => {
  const golden = (f: string) => readFileSync(join(root, "tests/golden/offbeat-syn", f), "utf8");
  const results = (limits: unknown) => {
    const d = read("examples/synthetic-pin.json");
    d.limits = limits;
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    return buildResults(v.normalized!, { T: golden("T"), C: golden("C"), time: 5e7 });
  };
  const cladHot = Math.max(...buildResults(validateCase(read("examples/synthetic-pin.json")).normalized!, { T: golden("T"), C: golden("C"), time: 5e7 }).radial.filter((p) => p.region === "cladding").map((p) => p.T));

  it("a limit above the hottest fuel cell passes with the margin, one below it fails, and the check is one of the result's checks", () => {
    const r = results([{ name: "high", region: "fuel", maxTemperature: q(1500, "K"), source: "test" }, { name: "low", region: "fuel", maxTemperature: q(1300, "K"), source: "test" }]);
    const hi = r.checks.find((c) => c.id === "temperatureLimit1")!;
    const lo = r.checks.find((c) => c.id === "temperatureLimit2")!;
    expect(hi.verdict).toBe("pass");
    expect(hi.value!).toBeCloseTo(1500 - 1307.2076, 3);
    expect(lo.verdict).toBe("fail");
    expect(lo.value!).toBeCloseTo(1300 - 1307.2076, 3);
  });
  it("a cladding rule uses the hottest cladding cell; the conditions pick the rule in force from it", () => {
    const r = results([
      { name: "clad", region: "cladding", maxTemperature: q(700, "K"), source: "test" },
      { name: "cool clad", region: "fuel", maxTemperature: q(1400, "K"), whileCladding: { atMost: q(700, "K") }, source: "test" },
      { name: "hot clad", region: "fuel", maxTemperature: q(1000, "K"), whileCladding: { above: q(700, "K") }, source: "test" },
    ]);
    expect(r.checks.find((c) => c.id === "temperatureLimit1")!.value!).toBeCloseTo(700 - cladHot, 6);
    expect(r.checks.find((c) => c.id === "temperatureLimit2")!.verdict).toBe("pass"); // the cladding is cool: this one is in force
    expect(r.checks.find((c) => c.id === "temperatureLimit3")).toMatchObject({ verdict: "pass", value: null }); // and this one is not
  });
  it("a case with no limits has no limit checks", () => {
    expect(results(undefined).checks.some((c) => /temperatureLimit/.test(c.id))).toBe(false);
  });
});

describe("in the results of a pulse (real OFFBEAT output of the synthetic pulse)", () => {
  const goldenDir = join(root, "tests/golden/offbeat-pulse");
  const input = () => ({
    C: readFileSync(join(goldenDir, "C"), "utf8"),
    fields: readdirSync(join(goldenDir, "times")).sort((a, b) => Number(a) - Number(b)).map((d) => ({ time: Number(d), T: readFileSync(join(goldenDir, "times", d, "T"), "utf8") })),
  });
  const run = (limits: unknown) => {
    const d = read("examples/synthetic-pulse.json");
    d.limits = limits;
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    return buildTransientResults(v.normalized!, input());
  };

  it("the margin is the limit less the hottest fuel the run reached (about 615.6 K here), found from the independent steps as well as the outputs", () => {
    const res = run([{ name: "fuel", region: "fuel", maxTemperature: q(700, "K"), source: "test" }]);
    const c = res.checks.find((x) => x.id === "temperatureLimit1")!;
    expect(c.verdict).toBe("pass");
    expect(c.value!).toBeGreaterThan(700 - 616 - 0.5);
    expect(c.value!).toBeLessThan(700 - 600);
    expect(c.note).toMatch(/at t = /);
  });
  it("a limit under the peak fails the check, and the result is still a result (the failure is the check's)", () => {
    const res = run([{ name: "fuel", region: "fuel", maxTemperature: q(600, "K"), source: "test" }]);
    const c = res.checks.find((x) => x.id === "temperatureLimit1")!;
    expect(c.verdict).toBe("fail");
    expect(c.value!).toBeLessThan(0);
    expect(res.kind).toBe("transient");
  });
  it("the cladding stays cool in a short pulse, so a rule that needs it hot was not in force", () => {
    const res = run([{ name: "hot", region: "fuel", maxTemperature: q(500, "K"), whileCladding: { above: q(500, "K") }, source: "test" }]);
    expect(res.checks.find((x) => x.id === "temperatureLimit1")).toMatchObject({ verdict: "pass", value: null });
  });
});

describe("the sourced TRIGA set and the example cases that use it", () => {
  const set = sourcedLimits()[0];
  it("is in the library listing, labelled sourced, with the two values of the SARs and a citation naming both", () => {
    expect(library().limits.map((s: { id: string }) => s.id)).toContain("triga-ss-uzrh-h16-fuel-temperature");
    expect(set.label).toBe("sourced");
    expect(set.citation).toMatch(/Kansas State/);
    expect(set.citation).toMatch(/University of Texas/);
    expect(set.rules.map((r: { maxTemperature: unknown }) => r.maxTemperature)).toEqual([q(1150, "degC"), q(950, "degC")]);
    expect(set.rules[0].whileCladding).toEqual({ atMost: q(500, "degC") });
    expect(set.rules[1].whileCladding).toEqual({ above: q(500, "degC") });
  });
  it("applies to a case and normalizes to kelvin", () => {
    const d = read("examples/synthetic-pin.json");
    d.limits = set.rules;
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.limits).toEqual([
      { name: set.rules[0].name, region: "fuel", maxTemperature: 1423.15, whileCladding: { atMost: 773.15 }, source: set.rules[0].source },
      { name: set.rules[1].name, region: "fuel", maxTemperature: 1223.15, whileCladding: { above: 773.15 }, source: set.rules[1].source },
    ]);
  });
  it("the two TRIGA examples with limits validate, and carry the library's rules unchanged", () => {
    for (const id of ["ksu-triga-1p25mw-film-limits", "ut-triga-pulse-4p40-limits"]) {
      const d = read("examples/" + id + ".json");
      expect(validateCase(d).errors, id).toEqual([]);
      expect(d.limits).toEqual(set.rules);
    }
  });
});

describe("edges the mutation run found", () => {
  const withRules = (limits: unknown) => {
    const d = read("examples/synthetic-pin.json");
    d.limits = limits;
    return validateCase(d);
  };
  const base = (extra: Record<string, unknown> = {}) => ({ name: "r", region: "fuel", maxTemperature: q(1000, "K"), source: "test", ...extra });

  it("when the outputs and the independent steps tie, the solver's outputs are the basis", () => {
    const [c] = limitChecks([rule()], [S(0, 900, 300)], [S(0, 900, 300)]);
    expect(c!.note).toContain("from the solver's outputs");
  });
  it("exactly ten rules are accepted, and eleven are not", () => {
    expect(withRules(Array.from({ length: 10 }, (_, i) => base({ name: "r" + i }))).errors).toEqual([]);
    expect(withRules(Array.from({ length: 11 }, (_, i) => base({ name: "r" + i }))).errors.length).toBeGreaterThan(0);
  });
  it("10000 K is the largest limit and a band whose two ends are equal never holds", () => {
    expect(withRules([base({ maxTemperature: q(10000, "K") })]).errors).toEqual([]);
    expect(withRules([base({ maxTemperature: q(10000.01, "K") })]).errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
    expect(withRules([base({ whileCladding: { above: q(600, "K"), atMost: q(600, "K") } })]).errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
    expect(withRules([base({ whileCladding: { above: q(600, "K"), atMost: q(600.01, "K") } })]).errors).toEqual([]);
    expect(withRules([base({ whileCladding: { atMost: q(10000, "K") } })]).errors).toEqual([]);
    expect(withRules([base({ whileCladding: { atMost: q(10001, "K") } })]).errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
  });
  it("a pulse's worst moment is reported in seconds of the run, not in step numbers", () => {
    const goldenDir = join(root, "tests/golden/offbeat-pulse");
    const d = read("examples/synthetic-pulse.json");
    d.limits = [{ name: "fuel", region: "fuel", maxTemperature: q(700, "K"), source: "test" }];
    const v = validateCase(d);
    const res = buildTransientResults(v.normalized!, {
      C: readFileSync(join(goldenDir, "C"), "utf8"),
      fields: readdirSync(join(goldenDir, "times")).sort((a, b) => Number(a) - Number(b)).map((x) => ({ time: Number(x), T: readFileSync(join(goldenDir, "times", x, "T"), "utf8") })),
    });
    const t = Number(/t = ([0-9.e+-]+) s/.exec(res.checks.find((c) => c.id === "temperatureLimit1")!.note)![1]);
    expect(t).toBeGreaterThan(0.005);
    expect(t).toBeLessThanOrEqual(0.1);
  });
});
