// Plan 13 T3 stage 2, ungated: temperature limits for the kernel and the layers of a particle. The rule's reading (every refusal by its code and field), the arithmetic of the margins
// by hand, the checks on real saved OFFBEAT output (tests/golden/offbeat-triso/intense), and that a pin's limits are untouched.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { TRISO_MAX_LIMITS, TRISO_MAX_LIMIT_TEMPERATURE } from "../src/core/triso";
import { buildTrisoResults } from "../src/core/trisoResults";
import { TrisoLimitRule, evaluateTrisoLimit, trisoLimitChecks } from "../src/core/trisoLimits";
import { MAX_LIMITS, MAX_LIMIT_TEMPERATURE, validateCase } from "../src/core/validate";
import { check } from "../src/server/server";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const vec = (n: string) => JSON.parse(readFileSync(join(root, "schema", "vectors", "good", n + ".json"), "utf8"));
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);
const rule = (extra: Record<string, unknown> = {}) => ({ name: "kernel, synthetic", region: "kernel", maxTemperature: q(1500, "K"), source: "synthetic: a test", ...extra });

describe("reading the limits of a particle", () => {
  it("accepts the vector: a name, a region, a maximum in K or degC, a source; the maxima are in K", () => {
    const v = validateCase(vec("triso-limits"));
    expect(v.errors).toEqual([]);
    const l = v.triso!.limits!;
    expect(l.map((r) => r.region)).toEqual(["kernel", "buffer", "sic"]);
    expect(l.map((r) => r.maxTemperature)).toEqual([1500, 1100 + 273.15, 1300]);
    expect(l[0]!.source).toContain("synthetic");
    expect(l[0]!.name).toBe("kernel, synthetic");
  });
  it("a case with no limits has none in its normalised form", () => {
    expect(validateCase(vec("triso-steady")).triso!.limits).toBeUndefined();
  });
  it("accepts a limit on any region the particle has, and trims the name and the source", () => {
    const d = vec("triso-steady");
    d.limits = ["kernel", "buffer", "ipyc", "sic", "opyc"].map((region) => rule({ region, name: "  " + region + "  ", source: "  s  " }));
    const l = validateCase(d).triso!.limits!;
    expect(l.map((r) => r.region)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    expect(l.map((r) => r.name)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    expect(l[0]!.source).toBe("s");
  });
  it("refuses each fault with its own code and field", () => {
    const withLimits = (limits: unknown) => {
      const d = vec("triso-steady");
      d.limits = limits;
      return d;
    };
    expect(codes(withLimits([rule({ region: "fuel" })]))).toEqual(["E_SCHEMA_INVALID /limits/0/region"]);
    expect(codes(withLimits([rule({ region: "cladding" })]))).toEqual(["E_SCHEMA_INVALID /limits/0/region"]);
    expect(codes(withLimits([rule({ region: 4 })]))).toEqual(["E_SCHEMA_INVALID /limits/0/region"]);
    expect(codes(withLimits([rule({ whileCladding: { atMost: q(500, "degC") } })]))).toEqual(["E_UNSUPPORTED /limits/0/whileCladding"]);
    expect(codes(withLimits([rule({ source: "" })]))).toEqual(["E_PROP_MISSING /limits/0/source"]);
    expect(codes(withLimits([rule({ source: undefined })]))).toEqual(["E_PROP_MISSING /limits/0/source"]);
    expect(codes(withLimits([rule({ maxTemperature: undefined })]))).toEqual(["E_PROP_MISSING /limits/0/maxTemperature"]);
    expect(codes(withLimits([rule({ maxTemperature: q(0, "K") })]))).toEqual(["E_OUT_OF_RANGE /limits/0/maxTemperature"]);
    expect(codes(withLimits([rule({ maxTemperature: q(10001, "K") })]))).toEqual(["E_OUT_OF_RANGE /limits/0/maxTemperature"]);
    expect(codes(withLimits([rule({ maxTemperature: q(10000, "K") })]))).toEqual([]);
    expect(codes(withLimits([rule({ maxTemperature: q(5, "W") })]))).toEqual(["E_UNITS /limits/0/maxTemperature"]);
    expect(codes(withLimits([rule({ name: "" })]))).toEqual(["E_SCHEMA_INVALID /limits/0/name"]);
    expect(codes(withLimits([rule({ name: "x".repeat(81) })]))).toEqual(["E_SCHEMA_INVALID /limits/0/name"]);
    expect(codes(withLimits([rule({ name: "a" + String.fromCharCode(7) })]))).toEqual(["E_SCHEMA_INVALID /limits/0/name"]);
    expect(codes(withLimits([rule(), rule({ region: "buffer" })]))).toEqual(["E_SCHEMA_INVALID /limits/1/name"]);
    expect(codes(withLimits(["not a rule"]))).toEqual(["E_SCHEMA_INVALID /limits/0"]);
    expect(codes(withLimits("not a list"))).toEqual(["E_SCHEMA_INVALID /limits"]);
    expect(codes(withLimits([]))).toEqual(["E_SCHEMA_INVALID /limits"]);
    expect(codes(withLimits(Array.from({ length: 11 }, (_, i) => rule({ name: "n" + i }))))).toEqual(["E_SCHEMA_INVALID /limits"]);
    expect(codes(withLimits(Array.from({ length: 10 }, (_, i) => rule({ name: "n" + i }))))).toEqual([]);
  });
  it("refuses a limit on a layer the particle does not have, by the layer", () => {
    const d = vec("triso-two-layers");
    d.limits = [rule({ region: "ipyc" })];
    expect(codes(d)).toEqual([]);
    d.limits = [rule({ region: "sic" })];
    expect(codes(d)).toEqual(["E_GEOMETRY /limits/0/region"]);
    d.limits = [rule({ region: "opyc" })];
    expect(codes(d)).toEqual(["E_GEOMETRY /limits/0/region"]);
  });
  it("names each fault of several rules once, at its own index", () => {
    const d = vec("triso-steady");
    d.limits = [rule(), rule({ name: "b", source: "" }), rule({ name: "c", region: "fuel" })];
    expect(codes(d)).toEqual(["E_PROP_MISSING /limits/1/source", "E_SCHEMA_INVALID /limits/2/region"]);
  });
  it("has the pin's bounds on the number of rules and on a temperature", () => {
    expect(TRISO_MAX_LIMITS).toBe(MAX_LIMITS);
    expect(TRISO_MAX_LIMIT_TEMPERATURE).toBe(MAX_LIMIT_TEMPERATURE);
  });
  it("leaves a pin's limits as they were: region fuel or cladding, whileCladding allowed", () => {
    const pin = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
    pin.limits = [{ name: "fuel", region: "fuel", maxTemperature: q(1500, "K"), whileCladding: { atMost: q(900, "K") }, source: "s" }];
    expect(validateCase(pin).errors).toEqual([]);
    pin.limits = [{ name: "fuel", region: "kernel", maxTemperature: q(1500, "K"), source: "s" }];
    expect(codes(pin)).toEqual(["E_SCHEMA_INVALID /limits/0/region"]);
  });
  it("the editor's check carries the limits in the normalised particle", () => {
    const r = check(vec("triso-limits")) as { ok: boolean; triso: { normalized: { limits: TrisoLimitRule[] } } };
    expect(r.ok).toBe(true);
    expect(r.triso.normalized.limits).toHaveLength(3);
  });
});

describe("the margins", () => {
  const at = (time: number, max: Record<string, number>) => ({ time, max });
  const rules: TrisoLimitRule[] = [
    { name: "kernel", region: "kernel", maxTemperature: 1500, source: "s1" },
    { name: "sic", region: "sic", maxTemperature: 1300, source: "s2" },
  ];
  it("is the limit minus the hottest cell of the rule's region, the smallest over the moments", () => {
    const o = evaluateTrisoLimit(rules[0]!, [at(0, { kernel: 1400 }), at(1, { kernel: 1450 }), at(2, { kernel: 1420 })]);
    expect(o.margin).toBe(50);
    expect(o.worst).toEqual({ time: 1, temperature: 1450 });
    expect(o.invalid).toBe(0);
  });
  it("judges each rule by its own region, not another's", () => {
    const checks = trisoLimitChecks(rules, [at(0, { kernel: 1400, sic: 1250, buffer: 1900 })]);
    expect(checks.map((c) => c.id)).toEqual(["temperatureLimit1", "temperatureLimit2"]);
    expect(checks.map((c) => c.value)).toEqual([100, 50]);
    expect(checks.map((c) => c.verdict)).toEqual(["pass", "pass"]);
    expect(checks[0]!.label).toBe("Temperature limit: kernel");
    expect(checks[0]!.unit).toBe("K");
    expect(checks[1]!.note).toContain("sic cell");
    expect(checks[1]!.note).toContain("Source: s2");
    expect(checks[1]!.note).toContain("computes no stress");
  });
  it("passes at a margin of exactly zero and fails below it", () => {
    expect(trisoLimitChecks(rules, [at(0, { kernel: 1500, sic: 1300.001 })]).map((c) => c.verdict)).toEqual(["pass", "fail"]);
    expect(trisoLimitChecks(rules, [at(0, { kernel: 1500.5, sic: 1299 })]).map((c) => c.verdict)).toEqual(["fail", "pass"]);
    expect(trisoLimitChecks(rules, [at(0, { kernel: 1500.5, sic: 1299 })])[0]!.value).toBeCloseTo(-0.5, 12);
  });
  it("takes the worse of the solver's outputs and the independent solution's steps, and says which decided", () => {
    const c = trisoLimitChecks([rules[0]!], [at(0, { kernel: 1400 }), at(1, { kernel: 1410 })], [at(0, { kernel: 1400 }), at(0.5, { kernel: 1490 }), at(1, { kernel: 1410 })])[0]!;
    expect(c.value).toBe(10);
    expect(c.note).toContain("the independent solution (every step)");
    expect(c.note).toContain("t = 0.5 s");
    const d = trisoLimitChecks([rules[0]!], [at(0, { kernel: 1495 })], [at(0, { kernel: 1400 })])[0]!;
    expect(d.value).toBe(5);
    expect(d.note).toContain("the solver's outputs");
  });
  it("does not pass a rule it cannot judge: a temperature that is not finite, or a region with no value", () => {
    expect(trisoLimitChecks([rules[0]!], [at(0, { kernel: NaN })])[0]!.verdict).toBe("fail");
    expect(trisoLimitChecks([rules[0]!], [at(0, { kernel: 1400 }), at(1, { kernel: Infinity })])[0]!.verdict).toBe("fail");
    expect(trisoLimitChecks([rules[0]!], [at(0, {})])[0]!.verdict).toBe("fail");
    expect(trisoLimitChecks([rules[0]!], [])[0]!.verdict).toBe("fail");
    expect(trisoLimitChecks([rules[0]!], [at(0, { kernel: 1400 })], [at(0, { kernel: NaN })])[0]!.verdict).toBe("fail");
  });
});

describe("the limits on real OFFBEAT output of a particle (the 49 K rise, wall 1298 K)", () => {
  const d = join(root, "tests", "golden", "offbeat-triso", "intense");
  const f = (x: string) => readFileSync(join(d, x), "utf8");
  const n0 = JSON.parse(f("normalized.json"));
  const rate = JSON.parse(f("rate.json"));
  const read = (limits: TrisoLimitRule[]) => buildTrisoResults({ ...n0, limits }, { T: f("T"), C: f("C"), cellZones: f("cellZones"), time: rate.time, drift: { relativeRate: rate.relativeRate } });
  const base = read([]);
  const hottest = (region: string) => Math.max(...base.cells.filter((c) => c.region === region).map((c) => c.T));

  it("the margin of each rule is its limit minus the hottest cell of its region, to the last digit", () => {
    const r = read([
      { name: "kernel", region: "kernel", maxTemperature: 1500, source: "s" },
      { name: "buffer", region: "buffer", maxTemperature: 1400, source: "s" },
      { name: "sic", region: "sic", maxTemperature: 1300, source: "s" },
    ]);
    const lim = r.checks.filter((c) => c.id.startsWith("temperatureLimit"));
    expect(lim.map((c) => c.id)).toEqual(["temperatureLimit1", "temperatureLimit2", "temperatureLimit3"]);
    expect(lim[0]!.value).toBeCloseTo(1500 - hottest("kernel"), 10);
    expect(lim[1]!.value).toBeCloseTo(1400 - hottest("buffer"), 10);
    expect(lim[2]!.value).toBeCloseTo(1300 - hottest("sic"), 10);
    // by hand from the saved field: the first cell of the kernel, of the buffer and of the SiC (the cells fall outward)
    expect(hottest("kernel")).toBeCloseTo(1346.8767, 3);
    expect(hottest("buffer")).toBeCloseTo(1334.5046, 3);
    expect(hottest("sic")).toBeCloseTo(1298.9125, 3);
    expect(lim.map((c) => c.verdict)).toEqual(["pass", "pass", "pass"]);
    expect(r.checks.filter((c) => c.verdict === "fail")).toEqual([]);
  });

  it("a limit just under the hottest cell of its region fails, with the negative margin; one just over passes", () => {
    const k = hottest("kernel");
    const under = read([{ name: "kernel", region: "kernel", maxTemperature: k - 0.1, source: "s" }]).checks.find((c) => c.id === "temperatureLimit1")!;
    expect(under.verdict).toBe("fail");
    expect(under.value).toBeCloseTo(-0.1, 9);
    const over = read([{ name: "kernel", region: "kernel", maxTemperature: k + 0.1, source: "s" }]).checks.find((c) => c.id === "temperatureLimit1")!;
    expect(over.verdict).toBe("pass");
    expect(over.value).toBeCloseTo(0.1, 9);
  });

  it("the same temperature is a limit for one region and not for another: 1320 K holds the SiC and fails the buffer", () => {
    const r = read([
      { name: "sic", region: "sic", maxTemperature: 1320, source: "s" },
      { name: "buffer", region: "buffer", maxTemperature: 1320, source: "s" },
    ]);
    expect(r.checks.filter((c) => c.id.startsWith("temperatureLimit")).map((c) => c.verdict)).toEqual(["pass", "fail"]);
  });

  it("a case with no limits has no limit checks", () => {
    expect(base.checks.some((c) => c.id.startsWith("temperatureLimit"))).toBe(false);
  });
});
