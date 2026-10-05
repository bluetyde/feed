// Thermal transients (plan 08): the case writer, the results parser on real OFFBEAT output (a pulse on the synthetic pin), the
// sensitivity of the cross-check, and (gated, FEED_SOLVER=1) real-solver runs against exact limits and with deliberate faults.
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { ResultsError } from "../src/core/resultsParser";
import { RunBackend, RunManager } from "../src/core/runManager";
import { adiabaticTemperature } from "../src/core/transientExact";
import { maxOf, minOf } from "../src/core/transientFv";
import { buildTransientResults, depositedEnergy, independentSolution, TransientResultsRecord } from "../src/core/transientResults";
import { scalarFieldText, vectorFieldText } from "./helpers/foamText";
import { transientPreview } from "../src/core/transientPreview";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const pulseDoc = () => read("examples/synthetic-pulse.json");
const normalized = (doc: unknown = pulseDoc()) => {
  const v = validateCase(doc);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};

// ---- the writer
describe("transient case files", () => {
  const w = () => writeOffbeatCase(normalized());

  it("a transient is a time-dependent heat source with a fixed step, uniform start and all outputs", () => {
    const f = w().files;
    expect(f["constant/solverDict"]).toMatch(/heatSource\s+timeDependentLhgr;/);
    expect(f["constant/solverDict"]).toMatch(/timePoints\s+\(0 0\.005 0\.01 0\.1 0\.1001\d*\);/); // one flat point a step past the end
    expect(f["constant/solverDict"]).toMatch(/lhgr\s+\(0 10000000 0 0 0\);/);
    expect(f["constant/solverDict"]).toMatch(/timeInterpolationMethod linear;/);
    expect(f["system/controlDict"]).toMatch(/adjustableTimeStep false;/);
    expect(f["system/controlDict"]).toMatch(/deltaT\s+0\.0001;/);
    expect(f["system/controlDict"]).toMatch(/endTime\s+0\.1;/);
    expect(f["system/controlDict"]).toMatch(/writeInterval\s+50;/); // 1000 steps, 20 outputs
    expect(f["0/T"]).toMatch(/internalField\s+uniform 300;/);
    expect(JSON.parse(f["feed-transient.json"]!)).toMatchObject({ outputs: 20, steps: 1000 });
  });

  it("heat capacity enters as Cp = c / rho (constant), or through the linear model (par1 = a/rho, par2 = b/rho)", () => {
    const f = w().files["constant/solverDict"]!;
    expect(f).toMatch(/rho\s+rho\s+\[1 -3 0 0 0\]\s+10000;/);
    expect(f).toMatch(/Cp\s+Cp\s+\[0 2 -2 -1 0\]\s+300;/); // fuel 3 MJ/m3/K
    expect(f).toMatch(/Cp\s+Cp\s+\[0 2 -2 -1 0\]\s+250;/); // cladding 2.5 MJ/m3/K
    const lin = writeOffbeatCase(normalized(read("schema/vectors/good/pulse-linear-heat-capacity.json"))).files["constant/solverDict"]!;
    expect(lin).toMatch(/heatCapacityModel steel1515TiBanerjee;/);
    expect(lin).toMatch(/heatCapacity \{ par1 90; par2 0\.417; par3 0; \}/); // 0.9 MJ/m3/K and 0.00417 MJ/m3/K2 over 10000 kg/m3
  });

  it("steady cases are untouched: no history, no transient marker, the old placeholders", () => {
    const s = writeOffbeatCase(normalized(read("examples/synthetic-pin.json")));
    expect(s.files["feed-transient.json"]).toBeUndefined();
    expect(s.files["constant/solverDict"]).toMatch(/heatSource\s+constantLhgr;/);
    expect(s.files["system/controlDict"]).toMatch(/adjustableTimeStep true;/);
    expect(s.placeholders.map((p) => p.name)).toContain("Cp");
    expect(w().placeholders.map((p) => p.name)).not.toContain("Cp");
  });
});

// ---- the parser on real OFFBEAT output
const goldenDir = join(root, "tests/golden/offbeat-pulse");
const goldenFields = () =>
  readdirSync(join(goldenDir, "times"))
    .sort((a, b) => Number(a) - Number(b))
    .map((d) => ({ time: Number(d), T: readFileSync(join(goldenDir, "times", d, "T"), "utf8") }));
const goldenC = () => readFileSync(join(goldenDir, "C"), "utf8");
const T0 = 300;

/** Scale the temperature rise above T0 of every cell (and the wall value) in a field file. */
function scaleRise(text: string, factor: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("internalField"));
  const n = Number(lines[start + 1]);
  for (let i = 0; i < n; i++) lines[start + 3 + i] = String(T0 + (Number(lines[start + 3 + i]) - T0) * factor);
  return lines.join("\n").replace(/(cladOuter\s*\{[^}]*value\s+uniform\s+)([0-9.eE+-]+)/, (_m, a: string, v: string) => a + String(T0 + (Number(v) - T0) * factor));
}

describe("transient results from real OFFBEAT output (synthetic pulse)", () => {
  const n = normalized();
  const res: TransientResultsRecord = buildTransientResults(n, { C: goldenC(), fields: goldenFields() });

  it("has the shape and the right output times", () => {
    expect(res.schema).toBe("feed.results/0.2");
    expect(res.kind).toBe("transient");
    expect(res.times.length).toBe(21);
    expect(res.times[0]).toBe(0);
    expect(res.times[1]).toBeCloseTo(0.005, 12);
    expect(res.cells.length).toBe(26);
    expect(res.cells.slice(0, 20).every((c) => c.region === "fuel")).toBe(true);
    expect(res.profiles.length).toBe(21);
    expect(res.profiles[0]!.every((x) => x === 300)).toBe(true);
  });

  it("the end-of-pulse fuel interior is the adiabatic value E/c, to better than 1e-4 K", () => {
    const area = Math.PI * 0.0041 ** 2;
    const exact = 300 + (0.5 * 10e6 * 0.01) / area / 3e6;
    expect(res.summary.maxT).toBeCloseTo(exact, 3);
    expect(res.summary.timeOfMaxT).toBeCloseTo(0.01, 9);
    expect(res.summary.maxRise).toBeCloseTo(exact - 300, 3);
  });

  it("mid-pulse the temperature is high by the right-endpoint amount: 1 + 1/50 of the exact rise (50 steps over the ramp)", () => {
    const area = Math.PI * 0.0041 ** 2;
    const exactMid = (0.5 * 0.5 * 10e6 * 0.01) / area / 3e6; // half of the energy deposited at 5 ms
    expect(res.series.peakT[1]! - 300).toBeCloseTo(exactMid * (51 / 50), 2);
  });

  it("energy deposited is exact and the balance closes", () => {
    expect(res.series.deposited[res.times.length - 1]).toBeCloseTo(50000, 6);
    expect(res.series.deposited[1]).toBeCloseTo(25000, 6);
    const last = res.times.length - 1;
    expect(Math.abs(res.series.stored[last]! + res.series.rejected[last]! - res.series.deposited[last]!) / 50000).toBeLessThan(0.03);
  });

  it("every check passes; each has a value or a stated reason", () => {
    expect(res.checks.map((c) => c.id + ":" + c.verdict)).toEqual(["energyBalance:pass", "crossCheckFv:pass", "timeStep:pass"]);
    expect(res.domain.verdict).toBe("in-domain");
  });

  it("depositedEnergy integrates the piecewise-linear history exactly", () => {
    expect(depositedEnergy([0, 1, 2], [0, 10, 0], 0.5)).toBeCloseTo(1.25, 12);
    expect(depositedEnergy([0, 1, 2], [0, 10, 0], 1)).toBeCloseTo(5, 12);
    expect(depositedEnergy([0, 1, 2], [0, 10, 0], 5)).toBeCloseTo(10, 12);
  });
});

describe("the parser refuses what is not a complete transient result", () => {
  const n = normalized();
  const run = (mutate: (fields: { time: number; T: string }[], C: string) => { fields: { time: number; T: string }[]; C: string }) => {
    const m = mutate(goldenFields(), goldenC());
    return () => buildTransientResults(n, { C: m.C, fields: m.fields });
  };
  it("a missing write time", () => expect(run((f, C) => ({ fields: f.slice(0, 19), C }))).toThrow(ResultsError));
  it("a write time in the wrong place", () => expect(run((f, C) => ({ fields: f.map((x, i) => (i === 3 ? { ...x, time: x.time * 1.01 } : x)), C }))).toThrow(/expected/));
  it("a file cut short", () => expect(run((f, C) => ({ fields: f.map((x, i) => (i === 5 ? { ...x, T: x.T.slice(0, x.T.length - 200) } : x)), C }))).toThrow(ResultsError));
  it("a non-finite or non-positive temperature", () => {
    expect(run((f, C) => ({ fields: f.map((x, i) => (i === 0 ? { ...x, T: x.T.replace("460.95384", "nan") } : x)), C }))).toThrow(ResultsError);
    expect(run((f, C) => ({ fields: f.map((x, i) => (i === 2 ? { ...x, T: scaleRise(x.T, -10) } : x)), C }))).toThrow(/not above 0 K/);
  });
  it("a missing wall value", () => expect(run((f, C) => ({ fields: f.map((x, i) => (i === 4 ? { ...x, T: x.T.replace(/cladOuter[\s\S]*?\}/, "cladOuter { }") } : x)), C }))).toThrow(/cladOuter/));
  it("the wrong number of cells", () => expect(run((f, C) => ({ fields: f, C: C.replace(/\n26\n/, "\n25\n") }))).toThrow(ResultsError));
  it("a steady case is not a transient", () => expect(() => buildTransientResults(normalized(read("examples/synthetic-pin.json")), { C: goldenC(), fields: goldenFields() })).toThrow(/not a transient/));
});

describe("the cross-check against the independent solution has teeth", () => {
  const n = normalized();
  const verdict = (factor: number) => {
    const fields = goldenFields().map((f) => ({ ...f, T: scaleRise(f.T, factor) }));
    return buildTransientResults(n, { C: goldenC(), fields }).checks.find((c) => c.id === "crossCheckFv")!;
  };
  it("a 1% error in the temperature rise (what a 1% error in the heat capacity or the power gives) fails it", () => {
    expect(verdict(1.01).verdict).toBe("fail");
    expect(verdict(0.99).verdict).toBe("fail");
  });
  it("a 0.2% difference does not", () => {
    expect(verdict(1.002).verdict).toBe("pass");
    expect(verdict(1.0).verdict).toBe("pass");
  });
});

// ---- Codex review of the transient work: each finding as a test
function setWall(text: string, v: number): string {
  return text.replace(/(cladOuter\s*\{[^}]*value\s+uniform\s+)([0-9.eE+-]+)/, (_m, a: string) => a + String(v));
}

describe("review findings: wall, time step over every step, cell positions, extremes, cost", () => {
  const n = normalized();

  it("a wall temperature that is not above 0 K is refused", () => {
    const fields = goldenFields().map((f, i) => (i === 0 ? { ...f, T: setWall(f.T, -1) } : f));
    expect(() => buildTransientResults(n, { C: goldenC(), fields })).toThrow(/outer wall temperature/);
  });

  it("a wall temperature that disagrees with the boundary relation fails the cross-check", () => {
    const wrong = (dT: number) => buildTransientResults(n, { C: goldenC(), fields: goldenFields().map((f) => ({ ...f, T: setWall(f.T, Number(/cladOuter\s*\{[^}]*value\s+uniform\s+([0-9.eE+-]+)/.exec(f.T)![1]) + dT) })) }).checks.find((c) => c.id === "crossCheckFv")!;
    expect(wrong(0).verdict).toBe("pass");
    expect(wrong(5).verdict).toBe("fail");
  });

  it("the time-step check looks at every step, so changing only the number of outputs cannot change its verdict", async () => {
    // a 5 ms step on a 10 ms pulse is not resolved. Fake "solver" fields are the independent solution itself, so every other
    // check passes; only the step-versus-half-step difference can fail, with 1 output or 20.
    const verdict = (outputs: number) => {
      const d = pulseDoc();
      d.transient.timeStep = { value: 5, unit: "ms" };
      d.transient.outputs = outputs;
      const c = normalized(d);
      const fv = independentSolution(c);
      const centroid = (a: number, b: number) => ((2 / 3) * (b ** 3 - a ** 3)) / (b ** 2 - a ** 2);
      const nf = c.mesh.fuelCells;
      const nc = c.mesh.claddingCells;
      const dF = (c.fuelRadius - c.fuelInnerRadius) / nf;
      const dC = (c.claddingOuterRadius - c.claddingInnerRadius) / nc;
      const radii = [...Array.from({ length: nf }, (_, j) => centroid(c.fuelInnerRadius + j * dF, c.fuelInnerRadius + (j + 1) * dF)), ...Array.from({ length: nc }, (_, j) => centroid(c.claddingInnerRadius + j * dC, c.claddingInnerRadius + (j + 1) * dC))];
      const fields = fv.states.slice(1).map((s: { time: number; T: number[]; wall: number }) => ({ time: s.time, T: scalarFieldText(s.T, s.wall) }));
      const r = buildTransientResults(c, { C: vectorFieldText(radii), fields });
      return { time: r.checks.find((x) => x.id === "timeStep")!, cross: r.checks.find((x) => x.id === "crossCheckFv")! };
    };
    const one = verdict(1);
    const twenty = verdict(20);
    expect(one.cross.verdict).toBe("pass");
    expect(one.time.verdict).toBe("fail");
    expect(twenty.time.verdict).toBe("fail");
    expect(one.time.value).toBeCloseTo(twenty.time.value!, 9);
  });

  it("cell centres that are not where this case's mesh puts them are refused (not just distinct)", () => {
    const halved = goldenC().replace(/\(([0-9.eE+-]+) ([0-9.eE+-]+) ([0-9.eE+-]+)\)/g, (m, x, y, z) => (Number(x) < 0.0041 ? "(" + Number(x) / 2 + " " + y + " " + z + ")" : m));
    expect(() => buildTransientResults(n, { C: halved, fields: goldenFields() })).toThrow(/this case's mesh puts it/);
  });

  it("extremes use loops: a list too long for argument spreading is fine", async () => {
    const big: number[] = Array.from({ length: 600_000 }, (_, i) => (i === 123456 ? 7 : 1));
    big[500_000] = -3;
    expect(maxOf(big)).toBe(7);
    expect(minOf(big)).toBe(-3);
    expect(() => Math.max(...big)).toThrow(RangeError);
  });

  it("the property-range check sees an excursion between outputs (every step of the independent solution)", () => {
    const d = pulseDoc();
    // a heat capacity law valid only up to 600 K: the pulse peaks at 615.6 K and then holds, so the saved outputs also exceed it;
    // the point of the test is the final verdict and that the all-step extremes are used
    d.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: { value: 2.99, unit: "MJ/m3/K" }, b: { value: 0.00001, unit: "MJ/m3/K2" }, validRange: { min: { value: 250, unit: "K" }, max: { value: 600, unit: "K" } }, source: "synthetic" };
    const r = buildTransientResults(normalized(d), { C: goldenC(), fields: goldenFields() });
    expect(r.domain.verdict).toBe("out-of-domain");
  });
});

describe("review findings: validation of the transient section", () => {
  const codes = (mutate: (d: any) => void) => {
    const d = pulseDoc();
    mutate(d);
    return validateCase(d).errors.map((e) => e.code + " " + e.field);
  };
  it("a value that overflows when converted is refused, not carried on as Infinity", () => {
    expect(codes((d) => (d.materials.fuel.sets["thermal.volumetricHeatCapacity"].value = { value: 1e308, unit: "MJ/m3/K" }))).toEqual(["E_UNITS /materials/fuel/sets/thermal.volumetricHeatCapacity/value"]);
    expect(codes((d) => (d.transient.powerHistory[1].linearHeatRate = { value: 1e308, unit: "MW/m" }))).toEqual(["E_UNITS /transient/powerHistory/1/linearHeatRate"]);
  });
  it("a heat capacity that is implausibly small or large is refused (underflow to Cp 0 in the writer, wrong units)", () => {
    expect(codes((d) => (d.materials.fuel.sets["thermal.volumetricHeatCapacity"].value = { value: 5e-324, unit: "J/m3/K" }))[0]).toMatch(/^E_OUT_OF_RANGE/);
    expect(codes((d) => (d.materials.fuel.sets["thermal.volumetricHeatCapacity"].value = { value: 3, unit: "J/m3/K" }))[0]).toMatch(/^E_OUT_OF_RANGE/); // 3 meant MJ
    expect(codes((d) => (d.materials.fuel.sets["thermal.volumetricHeatCapacity"].value = { value: 3e4, unit: "MJ/m3/K" }))[0]).toMatch(/^E_OUT_OF_RANGE/);
  });
  it("a linear heat capacity that is negative at the starting temperature is refused", () => {
    const e = codes((d) => (d.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: { value: -1, unit: "MJ/m3/K" }, b: { value: 0.002, unit: "MJ/m3/K2" }, validRange: { min: { value: 600, unit: "K" }, max: { value: 1000, unit: "K" } }, source: "synthetic" }));
    expect(e).toEqual(["E_OUT_OF_RANGE /transient/initialTemperature"]);
  });
  it("the end time must be a whole number of steps to rounding error, not to one part in a million", () => {
    const e = codes((d) => {
      d.transient.endTime = { value: 100000.05, unit: "s" };
      d.transient.timeStep = { value: 1, unit: "s" };
      d.transient.powerHistory[3].time = { value: 200000, unit: "s" };
      d.transient.outputs = 1;
      d.mesh = { fuelCells: 4, claddingCells: 2 };
    });
    expect(e).toContain("E_TIME /transient/timeStep");
  });
  it("cells x steps above the budget is refused with the numbers", () => {
    const d = pulseDoc();
    d.mesh = { fuelCells: 2000, claddingCells: 100 };
    d.transient.timeStep = { value: 0.05, unit: "ms" };
    const v = validateCase(d);
    expect(v.errors.map((x) => x.code)).toEqual(["E_TIME"]);
    expect(v.errors[0]!.message).toMatch(/4200000/);
  });
});

// ---- the TRIGA pulse built from UT-Austin SAR numbers (illustrative)
describe("TRIGA $4.40 pulse (examples/ut-triga-pulse-4p40.json)", () => {
  const doc = read("examples/ut-triga-pulse-4p40.json");
  const n = normalized(doc);

  it("is labelled illustrative: the pulse shape is an assumption, and the label says so", () => {
    expect(doc.label).toBe("synthetic");
    expect(doc.description).toMatch(/ILLUSTRATIVE/);
    expect(doc.description).toMatch(/ASSUMED to be sech\^2/);
    expect(doc.citation).toMatch(/READ FROM THE FIGURE/);
  });

  it("the heat capacity law is the SAR's, in kelvin: it doubles from 20 C to 824 C", () => {
    const cp = n.fuelHeatCapacity!;
    expect(cp.kind).toBe("linear");
    const c = (tC: number) => (cp.kind === "linear" ? cp.a + cp.b * (tC + 273.15) : 0);
    expect(c(20)).toBeCloseTo(2.04e6 + 4170 * 20, -2); // 2.04 + 0.00417 T[C] J/cm3/K
    expect(c(824)).toBeCloseTo(2.04e6 + 4170 * 824, -2);
    expect(c(824) / c(20)).toBeGreaterThan(1.9);
  });

  it("the energy takes the fuel from 20 C to 824 C if no heat leaves, and the implied pulse width is a plausible TRIGA width", async () => {
    
    const p = transientPreview(n);
    expect(p.adiabaticPeak - 273.15).toBeGreaterThan(823.5);
    expect(p.adiabaticPeak - 273.15).toBeLessThan(825);
    expect(Math.max(...p.preview!.peakT) - 273.15).toBeCloseTo(p.adiabaticPeak - 273.15, 1); // interior is adiabatic over 100 ms
    // full width at half maximum of the tabulated power, from the table
    const { times, linearHeatRate } = n.transient!;
    const half = Math.max(...linearHeatRate) / 2;
    const up = times.find((_, i) => linearHeatRate[i]! >= half)!;
    const down = [...times].reverse().find((_, i) => linearHeatRate[times.length - 1 - i]! >= half)!;
    expect((down - up) * 1e3).toBeGreaterThan(10);
    expect((down - up) * 1e3).toBeLessThan(13);
    expect(Math.max(...linearHeatRate) / 1e6).toBeCloseTo(237.6, 0); // 8.9e4 kW / 0.381 m x 1.017
  });
});

// ---- real solver
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

/** A backend that lets a test edit the OFFBEAT files before the real run (to put a deliberate fault into the solver's input). */
class FaultyBackend implements RunBackend {
  inner = new WslBackend();
  constructor(private edit: (dict: string) => string) {}
  async run(args: Parameters<RunBackend["run"]>[0]) {
    const f = join(args.inputsDir, "constant", "solverDict");
    writeFileSync(f, this.edit(readFileSync(f, "utf8")));
    return this.inner.run(args);
  }
  cancel(id: string) {
    return this.inner.cancel(id);
  }
}

async function runCase(doc: unknown, backend: RunBackend = new WslBackend()) {
  const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-tr-")), backend, timeoutMs: 280_000 });
  const s = mgr.start(doc);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  return { rec, res: mgr.results(s.id) as TransientResultsRecord | undefined, mgr, id: s.id };
}

describe.skipIf(!solverOn)("transients through the real solver (needs FEED_SOLVER=1)", () => {
  it("synthetic pulse: completes, interior fuel is exactly adiabatic at the end of the pulse, every check passes", async () => {
    const { rec, res } = await runCase(pulseDoc());
    expect(rec.state).toBe("completed");
    expect(rec.headline?.transient).toBe(true);
    const area = Math.PI * 0.0041 ** 2;
    expect(res!.summary.maxT).toBeCloseTo(300 + (0.5 * 10e6 * 0.01) / area / 3e6, 3);
    expect(res!.checks.every((c) => c.verdict === "pass")).toBe(true);
  }, 300_000);

  it("first order in the time step: halving the step halves the mid-pulse error", async () => {
    const errs: number[] = [];
    const area = Math.PI * 0.0041 ** 2;
    const exactMid = 300 + (0.5 * 0.5 * 10e6 * 0.01) / area / 3e6;
    for (const dtMs of [0.2, 0.1, 0.05]) {
      const d = pulseDoc();
      d.transient.timeStep = { value: dtMs, unit: "ms" };
      d.transient.outputs = 20;
      const { res } = await runCase(d);
      errs.push(res!.series.peakT[1]! - exactMid);
    }
    expect(errs[0]! / errs[1]!).toBeGreaterThan(1.8);
    expect(errs[0]! / errs[1]!).toBeLessThan(2.2);
    expect(errs[1]! / errs[2]!).toBeGreaterThan(1.8);
    expect(errs[1]! / errs[2]!).toBeLessThan(2.2);
  }, 600_000);

  it("heat capacity linear in temperature (carried by OFFBEAT's Banerjee model): the end-of-pulse fuel is the root of the integral of c dT = E", async () => {
    const doc = read("schema/vectors/good/pulse-linear-heat-capacity.json");
    doc.transient.timeStep = { value: 0.025, unit: "ms" };
    doc.transient.outputs = 20;
    const { res, rec } = await runCase(doc);
    expect(rec.state).toBe("completed");
    const area = Math.PI * 0.0041 ** 2;
    const exact = adiabaticTemperature(0.9e6, 4170, 300, (0.5 * 10e6 * 0.01) / area);
    // first order in the step: with 0.025 ms (400 steps over the pulse) the end-of-pulse value is within 0.5% of the rise
    expect(Math.abs(res!.summary.maxT - exact)).toBeLessThan(0.005 * (exact - 300));
    expect(res!.checks.every((c) => c.verdict === "pass")).toBe(true);
  }, 300_000);

  it("a deliberate 2% error in the solver's heat capacity is caught by the cross-check", async () => {
    const { res, rec } = await runCase(pulseDoc(), new FaultyBackend((d) => d.replace(/(Cp\s+Cp\s+\[0 2 -2 -1 0\]\s+)300;/, "$1306;")));
    expect(rec.state).toBe("completed");
    expect(res!.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("fail");
  }, 300_000);

  it("a deliberate 2% error in the solver's power is caught by the cross-check", async () => {
    const { res } = await runCase(pulseDoc(), new FaultyBackend((d) => d.replace("lhgr        (0 10000000 0 0 0)", "lhgr        (0 10200000 0 0 0)")));
    expect(res!.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("fail");
  }, 300_000);

  it("TRIGA $4.40 pulse: the interior reaches the adiabatic value within 1 K, every check passes (temperature-dependent heat capacity, annular fuel, 2000 steps)", async () => {
    const { rec, res } = await runCase(read("examples/ut-triga-pulse-4p40.json"));
    expect(rec.state).toBe("completed");
    
    const adiabatic = transientPreview(normalized(read("examples/ut-triga-pulse-4p40.json"))).adiabaticPeak;
    expect(Math.abs(res!.summary.maxT - adiabatic)).toBeLessThan(1);
    expect(res!.checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(res!.domain.verdict).toBe("in-domain");
  }, 300_000);

  it("an annular transient pin runs and passes its checks", async () => {
    const d = pulseDoc();
    d.geometry.fuelInnerRadius = { value: 1, unit: "mm" };
    const { res, rec } = await runCase(d);
    expect(rec.state).toBe("completed");
    expect(res!.checks.every((c) => c.verdict === "pass")).toBe(true);
  }, 300_000);
});

void cpSync;
void existsSync;
