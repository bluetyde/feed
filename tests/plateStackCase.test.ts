// Plan 12 A5, ungated: a stack of plates. The case and its refusals, what each slice is given, the axial conduction estimate for a slab (worked by hand, and against the
// real-solver measurements saved in tests/golden/offbeat-plate-stack), the files the writer gives OFFBEAT, and the heat the slices of a transient stack can exchange.
// The real-solver runs are in plateStackSolver.test.ts; the reading of their saved output is in plateStackResults.test.ts and plateStackTransientResults.test.ts.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { axialConductionEstimate, axialExchange, axialSummary, normalizedShape, sliceCase, sliceLoads } from "../src/core/axial";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { quickLook } from "../src/core/quickLook";
import { buildStackResults } from "../src/core/stackResults";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const example = (id: string) => JSON.parse(read("examples", id + ".json"));
const slab = (d: any) => {
  d.assumptions.geometry = "1D-slab";
  d.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  return d;
};
const cosine = (L: number, N = 10) => ({ length: q(L, "m"), slices: N, powerShape: { kind: "cosine" } });
const plateStack = (axial: unknown = cosine(0.381), avg = 200000) => {
  const d = slab(example("synthetic-pin"));
  d.power.linearHeatRate = q(avg, "W/m");
  d.axial = axial;
  return d;
};
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);
const nums = (s: string) => s.trim().split(/\s+/).map(Number);
const bt = (z: number, Tb: number, h: number) => ({ height: q(z, "m"), bulkTemperature: q(Tb, "K"), heatTransferCoefficient: q(h, "W/m2/K") });

describe("the case of a stack of plates", () => {
  it("is valid, is normalised as a plate with an axial section, and the heat rate is the average per metre of height and width", () => {
    const n = norm(plateStack());
    expect(n.plate).toBe(true);
    expect(n.axial!.slices).toBe(10);
    expect(n.axial!.length).toBeCloseTo(0.381, 12);
    expect(n.qPrime).toBe(200000);
    // the peak of a cosine over 10 slices is 1.5726 times the average, sampled at the slice centres: a plate's heat rate is not judged against a pin's sanity range
    expect(validateCase(plateStack()).warnings).toEqual([]);
    const pin = example("synthetic-pin");
    pin.power.linearHeatRate = q(200000, "W/m");
    pin.axial = cosine(0.381);
    expect(validateCase(pin).warnings.map((w) => w.code)).toContain("W_POWER_RANGE");
  });
  it("accepts a table shape with a coolant table, a prescribed wall and a transient (a pulse, a steady start with a boundary history, a coolant table)", () => {
    const shape = { kind: "table", points: [[0, 0.4], [0.19, 1.3], [0.381, 0.5]].map(([z, r]) => ({ position: q(z!, "m"), relativePower: q(r!, "1") })) };
    expect(validateCase(plateStack({ ...cosine(0.381), powerShape: shape, boundary: [bt(0, 573, 30000), bt(0.381, 633, 30000)] })).errors).toEqual([]);
    const wall = plateStack({ ...cosine(0.381), boundary: [{ height: q(0, "m"), surfaceTemperature: q(573, "K") }, { height: q(0.381, "m"), surfaceTemperature: q(613, "K") }] });
    delete wall.boundary.bulkTemperature;
    delete wall.boundary.heatTransferCoefficient;
    wall.boundary.surfaceTemperature = q(573, "K");
    expect(validateCase(wall).errors).toEqual([]);
    const pulse = slab(example("synthetic-pulse"));
    pulse.axial = cosine(0.381);
    expect(validateCase(pulse).errors).toEqual([]);
    expect(validateCase(pulse).normalized!.transient).toBeTruthy();
    const op = slab(example("synthetic-coastdown"));
    op.axial = cosine(0.381);
    expect(validateCase(op).errors).toEqual([]);
    const tab = slab(example("synthetic-pulse"));
    tab.axial = { ...cosine(0.381), boundary: [bt(0, 300, 30000), bt(0.381, 330, 30000)] };
    expect(validateCase(tab).errors).toEqual([]);
  });
  it("keeps refusing what stays out of scope, each with the reason: mechanics, hot dimensions, a burnup, a point-kinetics pulse, a coolant table with a boundary history, and a bad axial section", () => {
    const hot = plateStack();
    hot.hotDimensions = { referenceTemperature: q(20, "degC"), fuel: { linearExpansion: q(12, "ppm/K"), source: "x" }, cladding: { linearExpansion: q(10, "ppm/K"), source: "x" } };
    expect(codes(hot)).toContain("E_UNSUPPORTED /hotDimensions");
    const mech = plateStack();
    mech.mechanics = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0.1, "MPa") };
    expect(codes(mech)).toContain("E_UNSUPPORTED /mechanics");
    const bu = plateStack();
    bu.burnup = { value: 10, unit: "MWd/kgHM", source: "x" };
    expect(codes(bu)).toContain("E_UNSUPPORTED /burnup");
    const kin = slab(example("synthetic-pulse-kinetics"));
    kin.axial = cosine(0.381);
    expect(codes(kin)).toContain("E_UNSUPPORTED /transient/pointKinetics");
    expect(codes(kin)).toContain("E_UNSUPPORTED /axial");
    const both = slab(example("synthetic-coastdown"));
    both.axial = { ...cosine(0.381), boundary: [bt(0, 300, 30000), bt(0.381, 330, 30000)] };
    expect(codes(both)).toContain("E_UNSUPPORTED /axial/boundary");
    expect(codes(plateStack({ ...cosine(0.381), slices: 2 }))).toContain("E_AXIAL /axial/slices");
    expect(codes(plateStack({ ...cosine(0.381), slices: 51 }))).toContain("E_AXIAL /axial/slices");
    expect(codes(plateStack({ ...cosine(0.381), length: q(0.381, "W/m") }))).toContain("E_UNITS /axial/length");
    expect(codes(plateStack({ ...cosine(0.381), powerShape: { kind: "gaussian" } }))).toContain("E_AXIAL /axial/powerShape");
    expect(codes(plateStack({ ...cosine(0.381), boundary: [{ height: q(0, "m"), surfaceTemperature: q(573, "K") }, { height: q(0.381, "m"), surfaceTemperature: q(600, "K") }] }))).toContain("E_AXIAL /axial/boundary");
    // a pin's assumption on a plate is still refused
    const radial = plateStack();
    radial.assumptions.geometry = "1D-radial";
    expect(codes(radial)).toContain("E_UNSUPPORTED /assumptions/geometry");
  });
  it("warns about a shape the slices do not resolve and about a short plate (the same two warnings as for a pin)", () => {
    expect(validateCase(plateStack(cosine(0.381, 3))).warnings.map((w) => w.code)).toContain("W_AXIAL_SHAPE_STEP");
    const w = validateCase(plateStack(cosine(0.05, 20))).warnings.find((x) => x.code === "W_AXIAL_CONDUCTION")!;
    expect(w).toBeTruthy();
    expect(w.message).toMatch(/along the height/);
    expect(validateCase(plateStack(cosine(0.381))).warnings.map((x) => x.code)).not.toContain("W_AXIAL_CONDUCTION");
  });
  it("gives every slice the plate's heat rate times the shape at its centre, and the slice's own case is a plate without an axial section", () => {
    const n = norm(plateStack());
    const loads = sliceLoads(n);
    // the cosine over 10 slices, sampled at the slice centres: (pi / 2) sin(pi (k + 1/2) / 10) times the average (the integral of sin over 0 to pi is 2)
    loads.forEach((l, k) => expect(l.linearHeatRate / n.qPrime, "slice " + k).toBeCloseTo((Math.PI / 2) * Math.sin((Math.PI * (k + 0.5)) / 10), 2));
    expect(normalizedShape(n.axial!).locations).toHaveLength(41);
    const sc = sliceCase(n, loads[3]!);
    expect(sc.axial).toBeUndefined();
    expect(sc.plate).toBe(true);
    expect(sc.qPrime).toBe(loads[3]!.linearHeatRate);
    // the quick look of a slice is the slab's closed form, worked by hand: coolant 573 + q/h + q t/k + q/h_gap + q L/(2 k)
    const q3 = loads[3]!.linearHeatRate;
    expect(quickLook(sc).temperatures.centreT).toBeCloseTo(573 + q3 / 30000 + (q3 * 0.57e-3) / 15 + q3 / 5000 + (q3 * 4.1e-3) / 6, 6);
    // the editor's summary of the stack names the hottest slice among the middle two
    const sum = axialSummary(n)!;
    expect([4, 5]).toContain(sum.hottest);
    expect(sum.slices[sum.hottest]!.centreT).toBeGreaterThan(sum.slices[0]!.centreT);
  });
});

describe("the axial conduction estimate for a plate", () => {
  const n = norm(plateStack());
  const est = axialConductionEstimate(n)!;
  it("is the fin model with the slab's cross-sections: lambda squared = k A / U with A the meat's and the cladding's strips of one metre width, worked by hand", () => {
    const hot = sliceLoads(n).reduce((m, l) => (l.linearHeatRate > m.linearHeatRate ? l : m));
    const rise = hot.linearHeatRate * (1 / 30000 + 0.57e-3 / 15 + 1 / 5000 + 4.1e-3 / 6);
    const kA = 3 * 4.1e-3 + 15 * 0.57e-3;
    const U = hot.linearHeatRate / rise;
    expect(est.lambdaSquared / (kA / U)).toBeCloseTo(1, 9);
    // 1.9e-5 m2; a pin's areas (pi R^2: 20 times smaller) would give a twentieth of it
    expect(est.lambdaSquared).toBeGreaterThan(1.8e-5);
    expect(est.lambdaSquared).toBeLessThan(2.1e-5);
    expect(est.fraction).toBeCloseTo(est.lambdaSquared * est.curvature, 12);
    // the cosine's curvature across the slices: close to (pi / L)^2 at the peak
    expect(est.curvature / (Math.PI / 0.381) ** 2).toBeGreaterThan(0.9);
    expect(est.curvature / (Math.PI / 0.381) ** 2).toBeLessThan(1.02);
  });
  it("goes as 1/L^2 and does not depend on the heat rate (a constant-conductivity plate is linear)", () => {
    const e = (L: number, avg = 200000) => axialConductionEstimate(norm(plateStack(cosine(L), avg)))!.fraction;
    expect(e(0.19) / e(0.381)).toBeGreaterThan(3.8);
    expect(e(0.19) / e(0.381)).toBeLessThan(4.2);
    expect(e(0.381) / e(0.762)).toBeGreaterThan(3.8);
    expect(e(0.381) / e(0.762)).toBeLessThan(4.2);
    expect(e(0.381, 20000) / e(0.381, 200000)).toBeCloseTo(1, 9);
  });
  it("is the real-solver calibration: against the saved runs at three lengths it covers the peak slice's change and the end slice's change within 3 times, and is not absurdly loose", () => {
    for (const L of ["0.19", "0.381", "0.762"]) {
      const d = join("tests", "golden", "offbeat-plate-stack", "len" + L);
      const nn = JSON.parse(read(d, "normalized.json"));
      const res = buildStackResults(nn, { T: read(d, "T"), C: read(d, "C"), time: 5e7 });
      expect(res.checks.filter((c) => c.verdict === "fail")).toEqual([]);
      const e = axialConductionEstimate(nn)!;
      const rise = res.axial.slices[5]!.centreCellT - 573;
      const loads = sliceLoads(nn);
      const closed = (k: number) => {
        const x = loads[k]!.linearHeatRate;
        return 573 + x / 30000 + (x * 0.57e-3) / 15 + x / 5000 + (x * 4.1e-3) / 6;
      };
      const peak = res.axial.slices[5]!.centreCellT - closed(5);
      const end = res.axial.slices[0]!.centreCellT - closed(0);
      expect(peak, "the peak layer is cooled, L = " + L).toBeLessThan(0);
      expect(end, "the end layer is warmed, L = " + L).toBeGreaterThan(0);
      expect(e.fraction * rise, "L = " + L).toBeGreaterThan(Math.abs(peak));
      expect(e.fraction * rise, "L = " + L).toBeLessThan(3 * Math.abs(peak));
      expect(3 * e.fraction * rise, "L = " + L).toBeGreaterThan(end);
      expect(e.fraction * rise, "L = " + L).toBeGreaterThan(0.4 * end);
    }
  });
  it("the pin's estimate is unchanged by the geometry kernel: the annulus areas pi (R^2 - r^2) are the kernel's cell volumes", () => {
    const pin = example("synthetic-pin");
    pin.axial = cosine(0.381);
    pin.mesh = { fuelCells: 20, claddingCells: 6 };
    const e = axialConductionEstimate(norm(pin))!;
    const Af = Math.PI * 4.1e-3 ** 2;
    const Ac = Math.PI * (4.75e-3 ** 2 - 4.18e-3 ** 2);
    const hot = sliceLoads(norm(pin)).reduce((m, l) => (l.linearHeatRate > m.linearHeatRate ? l : m));
    const look = quickLook(sliceCase(norm(pin), hot));
    const U = hot.linearHeatRate / (look.temperatures.centreT - 573);
    expect(e.lambdaSquared / ((3 * Af + 15 * Ac) / U)).toBeGreaterThan(0.99);
    expect(e.lambdaSquared / ((3 * Af + 15 * Ac) / U)).toBeLessThan(1.01);
  });
});

describe("the files of a stack of plates", () => {
  const w = writeOffbeatCase(norm(plateStack()));
  it("is a Cartesian mesh of N layers per solid over the heated length, one metre wide, with empty side and end faces and no wedge", () => {
    const b = w.files["system/blockMeshDict"]!;
    expect(b).toMatch(/fuel \(20 1 10\)/);
    expect(b).toMatch(/cladding \(6 1 10\)/);
    expect(b).toMatch(/\(0 -500 0\)/);
    expect(b).toMatch(/\(0 500 381\)/);
    expect(b).not.toMatch(/wedge/);
    expect(b).toMatch(/fuelFront\s*\{\s*type empty;/);
    expect(b).toMatch(/fuelTop\s*\{\s*type empty;/);
    expect(b).toMatch(/\(4\.1 -500 0\)/);
    expect(b).toMatch(/\(4\.75 500 381\)/);
    expect(w.files["0/T"]!).not.toMatch(/wedge/);
    expect(w.files["0/D"]!).not.toMatch(/wedge/);
  });
  it("has angularFraction 1, the average heat rate and the normalised axial table", () => {
    const s = w.files["constant/solverDict"]!;
    expect(s).toMatch(/angularFraction\s+1;/);
    expect(s).toMatch(/lhgr\s+200000;/);
    const m = /axialProfile \{ type constantTabulated; axialLocations \(([^)]*)\); data \(([^)]*)\); axialInterpolationMethod linear; \}/.exec(s)!;
    const z = nums(m[1]!);
    const v = nums(m[2]!);
    let I = 0;
    for (let i = 1; i < z.length; i++) I += 0.5 * (v[i]! + v[i - 1]!) * (z[i]! - z[i - 1]!);
    expect(Math.abs(I - 1)).toBeLessThan(1e-12);
    expect(z[0]).toBe(0);
    expect(z[z.length - 1]).toBe(1);
  });
  it("a coolant table is written with heights in metres, and the mapping says it is a plate stack", () => {
    const t = writeOffbeatCase(norm(plateStack({ ...cosine(0.381), boundary: [bt(0, 573, 30000), bt(381e-3, 673, 25000)] }))).files["0/T"]!;
    expect(t).toMatch(/type timeDependentAxialProfileHTC;/);
    expect(t).toMatch(/axialLocations \(0 0\.381\);/);
    expect(t).toMatch(/hData \(\(30000 25000\) \(30000 25000\)\);/);
    expect(w.mapping.find((m) => m.field === "geometry")!.note).toMatch(/a plate: a Cartesian mesh/);
    expect(w.mapping.find((m) => m.field === "axial")!.note).toMatch(/10 layers per solid over 381 mm.*normalised to an integral of 1/);
  });
  it("a plate without a stack is written as before (the one-cell mesh, a flat profile) and a pin stack still has its wedge", () => {
    const one = slab(example("synthetic-pin"));
    const w1 = writeOffbeatCase(norm(one));
    expect(w1.files["system/blockMeshDict"]).toMatch(/fuel \(20 1 1\)/);
    expect(w1.files["constant/solverDict"]).toMatch(/axialProfile \{ type flat; \}/);
    const pin = example("synthetic-pin");
    pin.axial = cosine(0.381);
    const wp = writeOffbeatCase(norm(pin));
    expect(wp.files["system/blockMeshDict"]).toMatch(/wedge/);
    expect(wp.files["constant/solverDict"]).not.toMatch(/angularFraction/);
  });
  it("a transient: every slice starts at its own slab steady state, written for all cells (every fuel layer, then every cladding layer)", () => {
    const d = slab(example("synthetic-pulse-operating"));
    d.axial = cosine(0.381);
    const n = norm(d);
    const t = writeOffbeatCase(n).files["0/T"]!;
    const m = /internalField\s+nonuniform List<scalar>\s*(\d+)\s*\(([^)]*)\)/.exec(t)!;
    expect(Number(m[1])).toBe(260);
    const T = nums(m[2]!);
    expect(T[4 * 20]).toBeGreaterThan(T[0]! + 1);
    // the first fuel cell of the first layer (the centre of the end slice) is that slice's closed form to the mesh error
    const l0 = sliceLoads(n)[0]!;
    const start = (n.transient!.initial as { linearHeatRate: number }).linearHeatRate * l0.factor;
    const centre = 300 + start * (1 / 30000 + 0.57e-3 / 15 + 1 / 5000 + 4.1e-3 / 6);
    expect(Math.abs(T[0]! - centre)).toBeLessThan(0.05);
  });
});

describe("the heat the slices of a transient stack can exchange along the height", () => {
  const d = slab(example("synthetic-coastdown"));
  d.axial = cosine(0.381);
  const n = norm(d);
  it("the rate is k A / (C h^2) with the conductivity at its largest and the heat capacity at its smallest over the temperatures given, worked by hand for the plate", () => {
    const ex = axialExchange(n, [300, 1000], [300, 600])!;
    // fuel 3 W/m/K and cladding 15 W/m/K (constants), heat capacity of both 3 MJ/m3/K in the example; strips of one metre width
    const kA = 3 * 4.1e-3 + 15 * 0.57e-3;
    const cf = n.fuelHeatCapacity!.kind === "constant" ? n.fuelHeatCapacity!.c : NaN;
    const cc = n.claddingHeatCapacity!.kind === "constant" ? n.claddingHeatCapacity!.c : NaN;
    const C = cf * 4.1e-3 + cc * 0.57e-3;
    expect(ex.kA).toBeCloseTo(kA, 12);
    expect(ex.heatCapacity / C).toBeCloseTo(1, 12);
    const h = 0.381 / 10;
    expect(ex.rate / (kA / (C * h * h))).toBeCloseTo(1, 12);
  });
  it("takes the conductivity at its largest and the heat capacity at its smallest over the temperatures given (laws that depend on temperature, worked by hand)", () => {
    const d = slab(example("synthetic-coastdown"));
    d.axial = cosine(0.381);
    // fuel k = 4 - 0.0006 T (falls with temperature: largest at the cool end of a range), cladding k = 15; fuel c = 2.4 + 0.002 T MJ/m3/K (rises: smallest at the cool end)
    d.materials.fuel.sets["thermal.conductivity"] = { model: "linear", a: q(4, "W/m/K"), b: q(-0.0006, "W/m/K2"), validRange: { min: q(300, "K"), max: q(2500, "K") }, source: "synthetic: a test" };
    d.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: q(2.4, "MJ/m3/K"), b: q(0.002, "MJ/m3/K2"), validRange: { min: q(250, "K"), max: q(2500, "K") }, source: "synthetic: a test" };
    const nn = norm(d);
    const ex = axialExchange(nn, [400, 900], [300, 600])!;
    const kA = (4 - 0.0006 * 400) * 4.1e-3 + 15 * 0.57e-3;
    const C = (2.4e6 + 2000 * 400) * 4.1e-3 + 2.5e6 * 0.57e-3;
    expect(ex.kA / kA).toBeCloseTo(1, 9);
    expect(ex.heatCapacity / C).toBeCloseTo(1, 9);
    // a range the other way round gives a different answer: the range matters
    expect(axialExchange(nn, [800, 1200], [300, 600])!.kA).toBeLessThan(ex.kA);
    expect(axialExchange(nn, [800, 1200], [300, 600])!.heatCapacity).toBeGreaterThan(ex.heatCapacity);
  });
  it("there is none for a case without a stack or without heat capacities", () => {
    const one = slab(example("synthetic-coastdown"));
    expect(axialExchange(norm(one), [300, 600], [300, 600])).toBeUndefined();
    expect(axialExchange(norm(plateStack()), [300, 600], [300, 600])).toBeUndefined();
  });
});
