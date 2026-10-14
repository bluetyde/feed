// Plan 12, A1: the axial section of the case. What the validator makes of it, what each slice is given (checked against an independent formula), the estimate of the axial conduction
// against the measurements of the A0 probe (docs/spike/axial-plate-probe.md, made with the real solver), the editor's quick look, and that nothing runs as a single slice by mistake.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { axialConductionEstimate, axialSummary, normalizedShape, shapeTable, sliceCase, sliceLoads } from "../src/core/axial";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { quickLook } from "../src/core/quickLook";
import { check } from "../src/server/server";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const pin = () => JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
function stack(axial: unknown, avg = 20000) {
  const d = pin();
  d.power.linearHeatRate = q(avg, "W/m");
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  d.axial = axial;
  return d;
}
const cosine = (L: number, N = 10) => ({ length: q(L, "m"), slices: N, powerShape: { kind: "cosine" } });
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};

describe("what each slice is given", () => {
  it("the cosine, normalised, has the trapezoid integral 1 over 0 to 1 (OFFBEAT demands 1 to 1e-4) and the heat rate of a slice is the average times the shape at its centre", () => {
    const c = norm(stack(cosine(0.381)));
    const s = normalizedShape(c.axial!);
    let I = 0;
    for (let i = 1; i < s.locations.length; i++) I += 0.5 * (s.data[i]! + s.data[i - 1]!) * (s.locations[i]! - s.locations[i - 1]!);
    expect(Math.abs(I - 1)).toBeLessThan(1e-12);
    const loads = sliceLoads(c);
    expect(loads).toHaveLength(10);
    loads.forEach((l, k) => {
      const z = (k + 0.5) / 10;
      // an independent formula: the exact cosine, normalised by its exact integral 2 / pi
      const exact = 20000 * (Math.PI / 2) * Math.cos(Math.PI * (z - 0.5));
      expect(Math.abs(l.linearHeatRate / exact - 1), "slice " + k).toBeLessThan(2e-3);
      expect(l.height).toBeCloseTo(z * 0.381, 12);
    });
    // the average over the slices is the case's average heat rate
    expect(Math.abs(loads.reduce((a, l) => a + l.linearHeatRate, 0) / 10 / 20000 - 1)).toBeLessThan(1e-2);
  });
  it("a table shape is read as given (linear between the points) and normalised; a flat one gives every slice the average", () => {
    const c = norm(stack({ length: q(1, "m"), slices: 4, powerShape: { kind: "table", points: [[0, 1], [0.5, 2], [1, 1]].map(([z, r]) => ({ position: q(z!, "m"), relativePower: q(r!, "1") })) } }));
    const t = shapeTable(c.axial!);
    expect(t.relative).toEqual([1, 2, 1]);
    const loads = sliceLoads(c).map((l) => l.linearHeatRate);
    // the integral of the table 1,2,1 over 0..1 is 1.5, so the shape is 2/3, 4/3, 2/3; slice centres 0.125, 0.375, 0.625, 0.875 give 2/3 + (4/3 - 2/3) 2 z' on each half
    expect(loads[0]! / 20000).toBeCloseTo((2 / 3) * (1 + 2 * 0.125), 9);
    expect(loads[1]! / 20000).toBeCloseTo((2 / 3) * (1 + 2 * 0.375), 9);
    expect(loads[2]! / 20000).toBeCloseTo(loads[1]! / 20000, 9);
    const flat = sliceLoads(norm(stack({ length: q(1, "m"), slices: 5, powerShape: { kind: "flat" } }))).map((l) => l.linearHeatRate);
    flat.forEach((x) => expect(x).toBeCloseTo(20000, 6));
  });
  it("a coolant table is interpolated at the slice centres, in metres from the bottom; without one every slice has the case's own boundary", () => {
    const withTable = norm(stack({ ...cosine(0.381), boundary: [{ height: q(0, "m"), bulkTemperature: q(573, "K"), heatTransferCoefficient: q(30000, "W/m2/K") }, { height: q(0.381, "m"), bulkTemperature: q(673, "K"), heatTransferCoefficient: q(30000, "W/m2/K") }] }));
    sliceLoads(withTable).forEach((l, k) => {
      expect(l.boundary.kind).toBe("convective");
      expect((l.boundary as { bulkTemperature: number }).bulkTemperature).toBeCloseTo(573 + 100 * ((k + 0.5) / 10), 9);
    });
    sliceLoads(norm(stack(cosine(0.381)))).forEach((l) => expect(l.boundary).toEqual({ kind: "convective", bulkTemperature: 573, heatTransferCoefficient: 30000 }));
  });
  it("a case without an axial section has no axial part and is unchanged", () => {
    const d = pin();
    const n = norm(d);
    expect("axial" in n).toBe(false);
    expect(sliceLoads(n)).toEqual([]);
  });
});

describe("the estimate of the axial conduction against what the real solver gave (A0)", () => {
  // the measurements of docs/spike/axial-plate-probe.md: the fuel-centre change from an isolated slice, at the end layer and at the peak layer (K), 10 layers, cosine, 20 kW/m average
  const measured: [number, number, number][] = [[0.19, 4.23, 1.39], [0.381, 1.06, 0.35], [0.762, 0.27, 0.087]];
  const peakRise = 1141; // the peak layer's fuel centre above the coolant, from the same runs
  for (const [L, end, peak] of measured) {
    it("L = " + L + " m: the estimate times the peak rise covers the measured end and peak changes, and is within a factor 2 of the end change", () => {
      const e = axialConductionEstimate(norm(stack(cosine(L))))!;
      expect(e).toBeDefined();
      const predicted = e.fraction * peakRise;
      expect(predicted, "predicted " + predicted).toBeGreaterThanOrEqual(end);
      expect(predicted).toBeGreaterThanOrEqual(peak);
      expect(predicted / end).toBeLessThan(2);
    });
  }
  it("the estimate goes as 1/L^2: halving the length multiplies it by 4 (to a few percent: the conductivities are constant here)", () => {
    const a = axialConductionEstimate(norm(stack(cosine(0.381))))!.fraction;
    const b = axialConductionEstimate(norm(stack(cosine(0.1905))))!.fraction;
    expect(b / a).toBeGreaterThan(3.8);
    expect(b / a).toBeLessThan(4.2);
  });
  it("the validator warns when the estimate is above 2 % (a short pin) and not for the TRIGA-length pin", () => {
    expect(validateCase(stack(cosine(0.381))).warnings.map((w) => w.code)).toEqual([]);
    expect(validateCase(stack(cosine(0.05, 20))).warnings.map((w) => w.code)).toContain("W_AXIAL_CONDUCTION");
  });
  it("the warning for a shape that one slice step does not resolve names the pair", () => {
    const w = validateCase(stack(cosine(0.381, 3))).warnings.find((x) => x.code === "W_AXIAL_SHAPE_STEP")!;
    expect(w.message).toMatch(/slices 1 and 2 differ in heat rate by 50 % of the largest slice's/);
    expect(validateCase(stack(cosine(0.381, 8))).warnings.map((x) => x.code)).not.toContain("W_AXIAL_SHAPE_STEP");
  });
  it("a hot-spot power above the sanity range warns about the hottest slice, not the average", () => {
    const w = validateCase(stack(cosine(0.381), 45000)).warnings.find((x) => x.code === "W_POWER_RANGE")!;
    expect(w.message).toMatch(/hottest slice/);
    expect(validateCase(stack(cosine(0.381), 20000)).warnings.map((x) => x.code)).not.toContain("W_POWER_RANGE");
  });
});

describe("the quick look of a stack", () => {
  it("the per-slice closed form: the hottest slice is the middle one for a cosine, and the summary agrees with a hand calculation", () => {
    const n = norm(stack(cosine(0.381)));
    const s = axialSummary(n)!;
    expect(s.slices).toHaveLength(10);
    expect([4, 5]).toContain(s.hottest);
    const hand = pin();
    hand.power.linearHeatRate = q(s.slices[s.hottest]!.linearHeatRate, "W/m");
    const mine = quickLook(norm(hand)).temperatures.centreT;
    expect(s.slices[s.hottest]!.centreT).toBeCloseTo(mine, 6);
    // the centre temperatures are symmetric for a cosine
    for (let k = 0; k < 5; k++) expect(s.slices[k]!.centreT).toBeCloseTo(s.slices[9 - k]!.centreT, 6);
    expect(s.peakLinearHeatRate).toBeCloseTo(Math.max(...sliceLoads(n).map((l) => l.linearHeatRate)), 9);
    expect(s.conduction!.fraction).toBeGreaterThan(0);
  });
  it("the server's check gives the hottest slice's quick look and the table, and a case without a stack has neither", () => {
    const r: any = check(stack(cosine(0.381)));
    expect(r.ok).toBe(true);
    expect(r.axial.slices).toHaveLength(10);
    expect(r.quick.temperatures.centreT).toBeCloseTo(r.axial.slices[r.axial.hottest].centreT, 6);
    expect(r.derived.volumetricPower).toBeCloseTo(r.axial.slices[r.axial.hottest].linearHeatRate / (Math.PI * 4.1e-3 ** 2), -3);
    const plain: any = check(pin());
    expect(plain.axial).toBeUndefined();
  });
  it("the slice case has no axial section and the slice's own heat rate", () => {
    const n = norm(stack(cosine(0.381)));
    const l = sliceLoads(n)[3]!;
    const sc = sliceCase(n, l);
    expect(sc.axial).toBeUndefined();
    expect(sc.qPrime).toBe(l.linearHeatRate);
  });
});

describe("nothing runs as one slice by mistake", () => {
  it("the writer refuses a stack until A2, and says why", () => {
    expect(() => writeOffbeatCase(norm(stack(cosine(0.381))))).toThrow(/axial stack.*milestone A2/);
  });
});
