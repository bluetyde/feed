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
import { buildTransientResults, depositedEnergy, TransientResultsRecord } from "../src/core/transientResults";
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
