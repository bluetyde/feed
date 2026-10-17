// Plan 13, T6: the editor's Population section for a particle, and the server's route behind it. The page was driven in the browser pane (see the plan record); here: the page's own pure
// helpers run without a page against the validator and the sampler (a distribution built for each variable and kind validates and runs; the truncation; the explorer's items; the
// numbers of the result view worked by hand), the page's wiring by its text, and /api/population over HTTP.
import { readFileSync } from "fs";
import { AddressInfo } from "net";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPopulation } from "../src/core/trisoPopulation";
import { validateCase } from "../src/core/validate";
import { check, server } from "../src/server/server";

const root = join(__dirname, "..");
const html = readFileSync(join(root, "src/web/index.html"), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
const q = (value: number, unit: string) => ({ value, unit });

/** The page's pure particle helpers (between the markers), run against a document and a log the test owns. */
function pure(doc: any) {
  const block = script.slice(script.indexOf("/* particle-pure:begin"), script.indexOf("/* particle-pure:end */"));
  const names = ["defaultParticle", "particleItems", "particleRegions", "particleOutsideTemperature", "particleAnalysis", "particleRemoveLayer", "populationVariables", "populationNominal", "defaultPopulation", "populationKind", "setPopulationKind", "setPopulationTruncation", "populationVaried", "populationRows", "populationShortLabel", "populationBars", "populationParameterRows", "POPULATION_KINDS", "POPULATION_LABEL", "POPULATION_TEXT"];
  const make = new Function("doc", "state", "let logText = state.logText; " + block + "; return { " + names.join(", ") + ", log: () => logText };");
  return make(doc, { logText: "" }) as Record<string, any>;
}
const fresh = () => pure(null).defaultParticle();

describe("the population section's helpers", () => {
  it("a particle without a population has the items it always had, and one with a population has the Population item after the limits", () => {
    const d = fresh();
    const h = pure(d);
    expect(h.particleItems().map((i: any) => i[0])).toEqual(["power", "boundary", "geometry", "gap", "mesh", "kernel", "buffer", "ipyc", "sic", "opyc", "limits"]);
    d.population = h.defaultPopulation();
    const items = h.particleItems();
    expect(items.map((i: any) => i[0])).toEqual(["power", "boundary", "geometry", "gap", "mesh", "kernel", "buffer", "ipyc", "sic", "opyc", "limits", "population"]);
    expect(items[items.length - 1]).toEqual(["population", "Population", "Checks", ["/population"]]);
  });
  it("the variables are the kernel radius, the layers the particle has, the power factor and the matrix temperature", () => {
    const d = fresh();
    const h = pure(d);
    expect(h.populationVariables()).toEqual(["kernelRadius", "buffer", "ipyc", "sic", "opyc", "powerFactor", "matrixTemperature"]);
    h.particleRemoveLayer();
    expect(h.populationVariables()).toEqual(["kernelRadius", "buffer", "ipyc", "sic", "powerFactor", "matrixTemperature"]);
  });
  it("the case's own value of each variable: the radius, a thickness, 1 for the factor, and the outside in kelvin (a boundary in degC is converted)", () => {
    const d = fresh();
    const h = pure(d);
    expect(h.populationNominal("kernelRadius")).toEqual(q(250, "um"));
    expect(h.populationNominal("sic")).toEqual(q(35, "um"));
    expect(h.populationNominal("powerFactor")).toEqual(q(1, "1"));
    expect(h.populationNominal("matrixTemperature")).toEqual(q(1000, "K"));
    d.boundary = { surfaceTemperature: q(727, "degC") };
    expect(h.populationNominal("matrixTemperature")).toEqual(q(1000.15, "K"));
    expect(h.populationNominal("foam")).toBeNull();
  });
  it("the starting population is valid and runs: 1000 particles, a named seed, nothing varied", () => {
    const d = fresh();
    const h = pure(d);
    d.population = h.defaultPopulation();
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    const r = runPopulation(v.triso!);
    expect(r.size).toBe(1000);
    expect(r.quantities[0]!.stat.stdDev).toBeLessThan(1e-9);
  });
  it("every variable and every kind builds a distribution round the case's value that validates, and the population then runs", () => {
    for (const kind of ["constant", "normal", "lognormal", "uniform"]) {
      const d = fresh();
      const h = pure(d);
      for (const v of h.populationVariables()) expect(h.setPopulationKind(v, kind), v + " " + kind).toBe(true);
      expect(h.populationKind("kernelRadius")).toBe(kind);
      expect(h.populationVaried()).toBe(7);
      d.population.size = 200;
      const res = validateCase(d);
      expect(res.errors, kind).toEqual([]);
      const r = runPopulation(res.triso!);
      expect(r.size).toBe(200);
      if (kind === "constant") expect(r.quantities[0]!.stat.stdDev).toBeLessThan(1e-9);
      else expect(r.quantities[0]!.stat.stdDev).toBeGreaterThan(0.1);
    }
  });
  it("a normal distribution is built with the mean at the case's value and 5 % of it as the spread (1 % of the kelvin value for the matrix, 0.05 for the factor)", () => {
    const d = fresh();
    const h = pure(d);
    h.setPopulationKind("kernelRadius", "normal");
    h.setPopulationKind("matrixTemperature", "normal");
    h.setPopulationKind("powerFactor", "normal");
    h.setPopulationKind("buffer", "uniform");
    h.setPopulationKind("sic", "lognormal");
    const dist = d.population.distributions;
    expect(dist.kernelRadius).toEqual({ kind: "normal", mean: q(250, "um"), stdDev: q(12.5, "um") });
    expect(dist.matrixTemperature).toEqual({ kind: "normal", mean: q(1000, "K"), stdDev: q(10, "K") });
    expect(dist.powerFactor).toEqual({ kind: "normal", mean: q(1, "1"), stdDev: q(0.05, "1") });
    expect(dist.buffer).toEqual({ kind: "uniform", min: q(95, "um"), max: q(105, "um") });
    expect(dist.sic).toEqual({ kind: "lognormal", median: q(35, "um"), sigmaLog: q(0.05, "1") });
  });
  it("none takes a distribution away and a variable the particle lacks is refused", () => {
    const d = fresh();
    const h = pure(d);
    h.setPopulationKind("buffer", "normal");
    expect(h.populationKind("buffer")).toBe("normal");
    expect(h.setPopulationKind("buffer", "none")).toBe(true);
    expect(h.populationKind("buffer")).toBe("none");
    expect(h.setPopulationKind("foam", "normal")).toBe(false);
    expect(h.setPopulationKind("buffer", "weibull")).toBe(false);
  });
  it("truncation puts the bounds three standard deviations out (three sigma of ln x for a lognormal) and takes them away", () => {
    const d = fresh();
    const h = pure(d);
    h.setPopulationKind("kernelRadius", "normal");
    h.setPopulationKind("sic", "lognormal");
    h.setPopulationKind("ipyc", "uniform");
    expect(h.setPopulationTruncation("kernelRadius", true)).toBe(true);
    expect(d.population.distributions.kernelRadius.truncate).toEqual({ min: q(212.5, "um"), max: q(287.5, "um") });
    expect(h.setPopulationTruncation("sic", true)).toBe(true);
    const t = d.population.distributions.sic.truncate;
    expect(t.min.value).toBeCloseTo(35 * Math.exp(-0.15), 4);
    expect(t.max.value).toBeCloseTo(35 * Math.exp(0.15), 4);
    expect(validateCase({ ...d, population: { ...d.population, size: 10 } }).errors).toEqual([]);
    expect(h.setPopulationTruncation("ipyc", true)).toBe(false);
    expect(h.setPopulationTruncation("kernelRadius", false)).toBe(true);
    expect(d.population.distributions.kernelRadius.truncate).toBeUndefined();
  });
  it("truncation converts the spread's unit to the mean's: a spread in mm on a mean in um", () => {
    const d = fresh();
    const h = pure(d);
    h.setPopulationKind("kernelRadius", "normal");
    d.population.distributions.kernelRadius.stdDev = q(0.01, "mm");
    h.setPopulationTruncation("kernelRadius", true);
    expect(d.population.distributions.kernelRadius.truncate).toEqual({ min: q(220, "um"), max: q(280, "um") });
  });
  it("the numbers of a result: the table rows, the histogram bars and the parameters of a particle, worked by hand", () => {
    const d = fresh();
    const h = pure(d);
    d.population = { size: 50, seed: 5, distributions: { kernelRadius: { kind: "normal", mean: q(250, "um"), stdDev: q(8, "um") }, powerFactor: { kind: "uniform", min: q(0.9, "1"), max: q(1.1, "1") } } };
    const r = runPopulation(validateCase(d).triso!);
    const rows = h.populationRows(r);
    expect(rows.map((x: any) => x.id)).toEqual(r.quantities.map((x) => x.id));
    expect(rows[0]).toMatchObject({ id: "kernelPeakT", mean: r.quantities[0]!.stat.mean, p99: r.quantities[0]!.stat.p99, max: r.quantities[0]!.stat.max });
    const bars = h.populationBars({ edges: [0, 10, 20, 30], counts: [1, 4, 5] });
    expect(bars).toEqual([{ lo: 0, hi: 10, count: 1, share: 0.1, height: 0.2 }, { lo: 10, hi: 20, count: 4, share: 0.4, height: 0.8 }, { lo: 20, hi: 30, count: 5, share: 0.5, height: 1 }]);
    const params = h.populationParameterRows(r.maximum, ["buffer", "ipyc", "sic", "opyc"]);
    expect(params.map((x: string[]) => x[0])).toEqual(["kernel radius", "buffer thickness", "ipyc thickness", "sic thickness", "opyc thickness", "power factor", "matrix temperature", "heat per particle", "kernel peak"]);
    expect(params[0]![1]).toBe((r.maximum.draw.kernelRadius * 1e6).toFixed(1) + " µm");
    expect(params[1]![1]).toBe("100.0 µm");
    expect(params[8]![1]).toBe(r.maximum.kernelPeakT.toFixed(2) + " K");
  });
  it("the short names of a narrow table: the kernel peak, the rise above the matrix and one drop for each region, the gap and the film", () => {
    const h = pure(fresh());
    expect(["kernelPeakT", "rise", "drop:kernel", "drop:buffer", "drop:gap", "drop:film"].map(h.populationShortLabel)).toEqual(["kernel peak", "peak - matrix", "kernel drop", "buffer drop", "gap drop", "film drop"]);
  });
  it("the text the page shows is the sampler's", () => {
    const h = pure(fresh());
    expect(h.POPULATION_TEXT).toBe(runPopulation(validateCase({ ...fresh(), population: { size: 1, seed: 1, distributions: {} } }).triso!).text);
    expect(h.POPULATION_KINDS.map((k: string[]) => k[0])).toEqual(["none", "constant", "normal", "lognormal", "uniform"]);
  });
});

describe("the check response and the page", () => {
  it("the check response carries the normalised population for the page", () => {
    const d = fresh();
    d.population = { size: 20, seed: 3, distributions: { buffer: { kind: "normal", mean: q(100, "um"), stdDev: q(5, "um") } } };
    const r: any = check(d);
    expect(r.ok).toBe(true);
    expect(r.triso.normalized.population).toMatchObject({ size: 20, seed: 3 });
    const b = r.triso.normalized.population.distributions.buffer;
    expect(b.kind).toBe("normal");
    expect(b.mean).toBeCloseTo(100e-6, 15);
    expect(b.stdDev).toBeCloseTo(5e-6, 15);
  });
  it("a population's errors reach the page at their fields, and route to the Population item", () => {
    const d = fresh();
    d.population = { size: 0, seed: 3, distributions: { buffer: { kind: "normal", mean: q(100, "um"), stdDev: q(0, "um") } } };
    const r: any = check(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e: any) => e.field).sort()).toEqual(["/population/distributions/buffer/stdDev", "/population/size"]);
  });
  it("the page's wiring: the panel is routed, Run population posts the case to /api/population, a stale sample is said to be stale, the section is not shown for another document", () => {
    expect(script).toMatch(/else if \(selected === "population"\) particlePopulationPanel\(p\);/);
    expect(script).toMatch(/fetch\("\/api\/population", \{ method: "POST"/);
    expect(script).toMatch(/const r = popRes, stale = popFor !== JSON\.stringify\(doc\);/);
    expect(script).toMatch(/if \(popDoc !== doc\) \{ popRes = null; popMsg = ""; popDoc = null; \}/);
    expect(script).toMatch(/popDoc = doc;/);
    expect(script).toMatch(/doc\.population = defaultPopulation\(\); selected = "population"/);
    expect(script).toMatch(/temperatureDiff: \["K"\]/);
    expect(script).toMatch(/case "population": return /);
  });
  it("the page's script still parses", () => {
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("/api/population over HTTP", () => {
  let base = "";
  const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json", "x-feed-client": "1" }) => fetch(base + "/api/population", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  it("answers a valid population with the spread, and the same case twice with the same numbers", async () => {
    const d = fresh();
    d.population = { size: 300, seed: 12, distributions: { kernelRadius: { kind: "normal", mean: q(250, "um"), stdDev: q(8, "um") } } };
    const a: any = await (await post(d)).json();
    const b: any = await (await post(d)).json();
    expect(a.ok).toBe(true);
    expect(a.result.kind).toBe("triso-population");
    expect(a.result.size).toBe(300);
    expect(a.mode).toBe("worker");
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
    expect(a.result.text).toMatch(/not a prediction for a real core/);
  });
  it("refuses a case with errors, a case without a population, a pin, a body that is not JSON and a request without the client header", async () => {
    const bad = fresh();
    bad.population = { size: 0, seed: 1, distributions: {} };
    const r1 = await post(bad);
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as any).errors[0].code).toBe("E_OUT_OF_RANGE");
    const r2 = await post(fresh());
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as any).errors[0].code).toBe("E_PROP_MISSING");
    const r3 = await post(JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8")));
    expect(r3.status).toBe(400);
    expect(((await r3.json()) as any).errors[0].code).toBe("E_UNSUPPORTED");
    expect((await post("not json")).status).toBe(400);
    expect((await post(fresh(), { "content-type": "application/json" })).status).toBe(403);
    expect((await post(fresh(), { "content-type": "text/plain", "x-feed-client": "1" })).status).toBe(415);
  });
  it("a population whose draws mostly fail is 422 with the reason", async () => {
    const d = fresh();
    const thin = { kind: "normal", mean: q(-1, "um"), stdDev: q(0.5, "um") };
    d.population = { size: 40, seed: 1, distributions: { buffer: thin, ipyc: thin, sic: thin, opyc: thin } };
    const r = await post(d);
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).error).toMatch(/too many particles/);
  });
});
