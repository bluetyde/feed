// The case input of plan 11 B1: transient.boundaryHistory, a coolant side that changes with time. What the validator accepts and normalises, each refusal, what the editor's
// check and the writer do with it until B2 carries it to the solver (the run is refused, never run with a constant boundary), and that a case without one is unchanged.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { RunManager } from "../src/core/runManager";
import { HISTORY_HTC_MAX, HISTORY_HTC_MIN, validateCase } from "../src/core/validate";
import { check, checkAsync } from "../src/server/server";
import { FakeBackend } from "./helpers/fakeBackend";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const pulse = () => JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));
const conv = (ms: number, Tb: number, h: number) => ({ time: q(ms, "ms"), bulkTemperature: q(Tb, "K"), heatTransferCoefficient: q(h, "W/m2/K") });
const withHistory = (hist: unknown) => {
  const c = pulse();
  c.transient.boundaryHistory = hist;
  return c;
};
const good = () => withHistory([conv(0, 300, 30000), conv(40, 300, 30000), conv(50, 300, 1000), conv(100, 300, 1000)]);
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);

describe("a boundary history is accepted and normalised", () => {
  it("convective: times in seconds, temperatures in kelvin, coefficients in W/m2/K, in the order written", () => {
    const v = validateCase(good());
    expect(v.errors).toEqual([]);
    const h = v.normalized!.transient!.boundaryHistory!;
    expect(h.kind).toBe("convective");
    expect(h.times).toEqual([0, 0.04, 0.05, 0.1]);
    expect((h as any).bulkTemperature).toEqual([300, 300, 300, 300]);
    expect((h as any).heatTransferCoefficient).toEqual([30000, 30000, 1000, 1000]);
  });
  it("accepts other units (degC, kW/m2/K)", () => {
    const d = withHistory([{ time: q(0, "s"), bulkTemperature: q(26.85, "degC"), heatTransferCoefficient: q(30, "kW/m2/K") }, { time: q(0.1, "s"), bulkTemperature: q(326.85, "degC"), heatTransferCoefficient: q(1, "kW/m2/K") }]);
    const h = validateCase(d).normalized!.transient!.boundaryHistory! as any;
    expect(h.bulkTemperature[0]).toBeCloseTo(300, 9);
    expect(h.bulkTemperature[1]).toBeCloseTo(600, 9);
    expect(h.heatTransferCoefficient).toEqual([30000, 1000]);
  });
  it("a prescribed wall", () => {
    const d = withHistory([{ time: q(0, "ms"), surfaceTemperature: q(300, "K") }, { time: q(100, "ms"), surfaceTemperature: q(400, "K") }]);
    d.boundary = { surfaceTemperature: q(300, "K") };
    const h = validateCase(d).normalized!.transient!.boundaryHistory! as any;
    expect(h.kind).toBe("surface-temperature");
    expect(h.surfaceTemperature).toEqual([300, 400]);
  });
  it("a point at or after the end time ends it; a point after the end is allowed; a segment shorter than a time step is allowed (the new-level rule makes it well defined)", () => {
    expect(validateCase(withHistory([conv(0, 300, 30000), conv(100, 300, 1000)])).errors).toEqual([]);
    expect(validateCase(withHistory([conv(0, 300, 30000), conv(150, 300, 1000)])).errors).toEqual([]);
    expect(validateCase(withHistory([conv(0, 300, 30000), conv(50, 300, 30000), conv(50.01, 300, 1000), conv(100, 300, 1000)])).errors).toEqual([]);
  });
  it("a case without it has none", () => {
    expect(validateCase(pulse()).normalized!.transient!.boundaryHistory).toBeUndefined();
  });
});

describe("zero power", () => {
  const noPower = (c: any) => {
    c.transient.powerHistory = [{ time: q(0, "ms"), linearHeatRate: q(0, "W/m") }, { time: q(100, "ms"), linearHeatRate: q(0, "W/m") }];
    c.transient.initialTemperature = q(800, "K");
    return c;
  };
  it("a pin with no heat source is refused as before, and allowed when a boundary history is stated", () => {
    expect(codes(noPower(pulse()))).toContain("E_OUT_OF_RANGE /transient/powerHistory");
    expect(validateCase(noPower(good())).errors).toEqual([]);
  });
});

describe("refusals", () => {
  it("not a list, one point, not from zero, not increasing, stops short of the end time", () => {
    expect(codes(withHistory({ a: 1 }))).toContain("E_SCHEMA_INVALID /transient/boundaryHistory");
    expect(codes(withHistory([conv(0, 300, 30000)]))).toContain("E_TIME /transient/boundaryHistory");
    expect(validateCase(withHistory([conv(0, 300, 30000)])).errors.map((e) => e.message).join(" ")).toMatch(/at least two points/);
    expect(codes(withHistory([conv(10, 300, 30000), conv(100, 300, 1000)]))).toContain("E_TIME /transient/boundaryHistory/0/time");
    expect(codes(withHistory([conv(0, 300, 30000), conv(60, 300, 30000), conv(60, 300, 1000), conv(100, 300, 1000)]))).toContain("E_TIME /transient/boundaryHistory/2/time");
    expect(codes(withHistory([conv(0, 300, 30000), conv(99, 300, 1000)]))).toContain("E_TIME /transient/boundaryHistory");
  });
  it("film coefficient bounds: 0.001 and 1e9 are accepted, below and above are not; temperature bounds", () => {
    expect(HISTORY_HTC_MIN).toBe(1e-3);
    expect(HISTORY_HTC_MAX).toBe(1e9);
    expect(validateCase(withHistory([conv(0, 300, 30000), conv(100, 300, 1e-3)])).errors).toEqual([]);
    expect(validateCase(withHistory([conv(0, 300, 30000), conv(100, 300, 1e9)])).errors).toEqual([]);
    expect(codes(withHistory([conv(0, 300, 30000), conv(100, 300, 9e-4)]))).toContain("E_OUT_OF_RANGE /transient/boundaryHistory/1/heatTransferCoefficient");
    expect(codes(withHistory([conv(0, 300, 30000), conv(100, 300, 1.1e9)]))).toContain("E_OUT_OF_RANGE /transient/boundaryHistory/1/heatTransferCoefficient");
    expect(codes(withHistory([conv(0, 300, 30000), conv(100, 0, 1000)]))).toContain("E_OUT_OF_RANGE /transient/boundaryHistory/1/bulkTemperature");
    expect(codes(withHistory([conv(0, 300, 30000), conv(100, 10001, 1000)]))).toContain("E_OUT_OF_RANGE /transient/boundaryHistory/1/bulkTemperature");
  });
  it("a point with half a boundary, two forms at once, or an unknown key", () => {
    expect(codes(withHistory([conv(0, 300, 30000), { time: q(100, "ms"), bulkTemperature: q(300, "K") }]))).toContain("E_BOUNDARY_INCOMPLETE /transient/boundaryHistory/1/heatTransferCoefficient");
    expect(codes(withHistory([conv(0, 300, 30000), { time: q(100, "ms"), heatTransferCoefficient: q(1000, "W/m2/K") }]))).toContain("E_BOUNDARY_INCOMPLETE /transient/boundaryHistory/1/bulkTemperature");
    expect(codes(withHistory([{ ...conv(0, 300, 30000), surfaceTemperature: q(300, "K") }, conv(100, 300, 1000)]))[0]).toBe("E_BOUNDARY_INCOMPLETE /transient/boundaryHistory/0");
    expect(codes(withHistory([conv(0, 300, 30000), { ...conv(100, 300, 1000), emissivity: 0.8 }]))).toContain("E_SCHEMA_INVALID /transient/boundaryHistory/1/emissivity");
    expect(codes(withHistory([conv(0, 300, 30000), { time: q(100, "ms") }]))).toContain("E_BOUNDARY_INCOMPLETE /transient/boundaryHistory/1");
  });
  it("points of both forms in one list", () => {
    expect(codes(withHistory([conv(0, 300, 30000), { time: q(100, "ms"), surfaceTemperature: q(300, "K") }]))).toContain("E_BOUNDARY_INCOMPLETE /transient/boundaryHistory/1");
  });
  it("a form that differs from the case's own boundary", () => {
    const d = withHistory([{ time: q(0, "ms"), surfaceTemperature: q(300, "K") }, { time: q(100, "ms"), surfaceTemperature: q(400, "K") }]);
    expect(codes(d)).toContain("E_BOUNDARY_INCOMPLETE /transient/boundaryHistory");
  });
  it("a steady start needs a history that begins at the case's own boundary", () => {
    const steady = (hist: unknown) => {
      const c = withHistory(hist);
      delete c.transient.initialTemperature;
      c.transient.initialSteadyLinearHeatRate = q(20, "kW/m");
      return c;
    };
    expect(validateCase(steady([conv(0, 300, 30000), conv(100, 300, 1000)])).errors).toEqual([]);
    expect(codes(steady([conv(0, 350, 30000), conv(100, 300, 1000)]))).toContain("E_TRANSIENT_INCOMPLETE /transient/boundaryHistory/0");
    expect(codes(steady([conv(0, 300, 29000), conv(100, 300, 1000)]))).toContain("E_TRANSIENT_INCOMPLETE /transient/boundaryHistory/0");
    // a uniform start has no such rule
    expect(validateCase(withHistory([conv(0, 500, 5000), conv(100, 300, 1000)])).errors).toEqual([]);
  });
  it("a prescribed wall: its temperature bound, and a steady start must begin at the case's own wall temperature", () => {
    const wall = (T: number, T1: number) => {
      const d = withHistory([{ time: q(0, "ms"), surfaceTemperature: q(T, "K") }, { time: q(100, "ms"), surfaceTemperature: q(T1, "K") }]);
      d.boundary = { surfaceTemperature: q(300, "K") };
      return d;
    };
    expect(codes(wall(300, 10001))).toContain("E_OUT_OF_RANGE /transient/boundaryHistory/1/surfaceTemperature");
    expect(codes(wall(300, 0))).toContain("E_OUT_OF_RANGE /transient/boundaryHistory/1/surfaceTemperature");
    const steady = (T: number) => {
      const d = wall(T, 400);
      delete d.transient.initialTemperature;
      d.transient.initialSteadyLinearHeatRate = q(20, "kW/m");
      return d;
    };
    expect(validateCase(steady(300)).errors).toEqual([]);
    expect(codes(steady(310))).toContain("E_TRANSIENT_INCOMPLETE /transient/boundaryHistory/0");
  });
  it("is not combined with mechanics", () => {
    const d = good();
    d.assumptions.thermalOnly = false;
    expect(validateCase(d).ok).toBe(false);
  });
});

describe("what the writer gives OFFBEAT and what the editor's check shows (plan 11 B2)", () => {
  it("a convective history becomes timeDependentAxialProfileHTC with the tables, two equal axial columns and one flat point past the end time", () => {
    const w = writeOffbeatCase(validateCase(good()).normalized!);
    const T = w.files["0/T"]!;
    expect(T).toMatch(/type\s+timeDependentAxialProfileHTC;/);
    expect(T).toMatch(/timePoints \(0 0\.04 0\.05 0\.1 0\.1001\);/);
    expect(T).toMatch(/axialLocations \(0 1\);/);
    expect(T).toMatch(/hData \(\(30000 30000\) \(30000 30000\) \(1000 1000\) \(1000 1000\) \(1000 1000\)\);/);
    expect(T).toMatch(/T0Data \(\(300 300\) \(300 300\) \(300 300\) \(300 300\) \(300 300\)\);/);
    expect(T).toMatch(/timeInterpolationMethod linear;/);
    expect(T).not.toMatch(/type\s+convectiveHTC;/);
    expect(w.mapping.find((m) => m.field === "transient.boundaryHistory")!.note).toMatch(/timeDependentAxialProfileHTC.*5 points|4 points/);
  });
  it("a prescribed-wall history becomes timeDependentAxialProfileT with its own keywords (timeDependentProfile, axialData)", () => {
    const d = withHistory([{ time: q(0, "ms"), surfaceTemperature: q(300, "K") }, { time: q(100, "ms"), surfaceTemperature: q(400, "K") }]);
    d.boundary = { surfaceTemperature: q(300, "K") };
    const T = writeOffbeatCase(validateCase(d).normalized!).files["0/T"]!;
    expect(T).toMatch(/type\s+timeDependentAxialProfileT;/);
    expect(T).toMatch(/timeDependentProfile\s*\{/);
    expect(T).toMatch(/axialData \(\(300 300\) \(400 400\) \(400 400\)\);/);
    expect(T).not.toMatch(/axialProfileDict/);
  });
  it("a history that reaches past the end time needs no extra point", () => {
    const T = writeOffbeatCase(validateCase(withHistory([conv(0, 300, 30000), conv(150, 300, 1000)])).normalized!).files["0/T"]!;
    expect(T).toMatch(/timePoints \(0 0\.15\);/);
  });
  it("the writer's other files do not depend on the history, and a run is started", () => {
    const a = writeOffbeatCase(validateCase(pulse()).normalized!);
    const b = writeOffbeatCase(validateCase(good()).normalized!);
    for (const f of ["system/blockMeshDict", "system/controlDict", "constant/solverDict", "system/fvSolution"]) expect(b.files[f], f).toBe(a.files[f]);
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-bh-")), backend: new FakeBackend("good") });
    expect(mgr.start(good()).ok).toBe(true);
  });
  it("the editor's check runs the independent preview with the history, in both the sync and the worker path", async () => {
    const a: any = check(good());
    expect(a.ok).toBe(true);
    expect(a.transient.previewSkipped).toBeNull();
    const times: number[] = a.transient.preview.time;
    const peak: number[] = a.transient.preview.claddingOuterT;
    // the film coefficient falls at 40 to 50 ms: the outer wall differs from the same case without a history
    const plain: any = check(pulse());
    expect(peak[peak.length - 1]).toBeGreaterThan(plain.transient.preview.claddingOuterT[peak.length - 1]);
    expect(times.length).toBe(plain.transient.preview.time.length);
    const b: any = await checkAsync(good());
    b.transient.preview.claddingOuterT.forEach((x: number, i: number) => expect(Math.abs(x - peak[i]!)).toBeLessThan(1e-6));
  });
  it("a case without a history is written exactly as before", () => {
    const a = writeOffbeatCase(validateCase(pulse()).normalized!);
    expect(a.files["0/T"]).toMatch(/type\s+convectiveHTC;/);
    expect(a.files["0/T"]).not.toMatch(/timeDependentAxialProfile/);
    expect(a.mapping.map((m) => m.field)).not.toContain("transient.boundaryHistory");
  });
});
