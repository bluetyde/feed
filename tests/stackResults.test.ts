// Plan 12 A2, ungated: the writer's files for a stack, and the layer-by-layer reading of real OFFBEAT output saved from the real solver (tests/golden/offbeat-stack, made by
// tests/axialSolver.test.ts with FEED_SAVE_GOLDEN=1). The checks are shown to fail on a stack that is not the one that was run, and truncated or reordered output is refused.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { normalizedShape } from "../src/core/axial";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { ResultsError } from "../src/core/resultsParser";
import { buildStackResults, worstOf } from "../src/core/stackResults";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
function stack(axial: unknown, avg = 20000) {
  const d = JSON.parse(read("examples/synthetic-pin.json"));
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
const nums = (s: string) => s.trim().split(/\s+/).map(Number);

describe("the files of a stack", () => {
  const w = writeOffbeatCase(norm(stack(cosine(0.381))));
  it("the mesh has N layers per solid over the heated length and the end faces stay empty", () => {
    const b = w.files["system/blockMeshDict"]!;
    expect(b).toMatch(/fuel \(20 1 10\)/);
    expect(b).toMatch(/cladding \(6 1 10\)/);
    expect(b).toMatch(/\(0 0 381\)/);
    expect(b).not.toMatch(/\(0 0 1000\)/);
    expect(b).toMatch(/fuelBottom\s*\{\s*type empty;/);
  });
  it("the power profile is a table whose trapezoid integral over 0 to 1 is 1 (OFFBEAT's demand) and lhgr is the average heat rate", () => {
    const s = w.files["constant/solverDict"]!;
    const m = /axialProfile \{ type constantTabulated; axialLocations \(([^)]*)\); data \(([^)]*)\); axialInterpolationMethod linear; \}/.exec(s)!;
    expect(m).toBeTruthy();
    const z = nums(m[1]!);
    const v = nums(m[2]!);
    expect(z[0]).toBe(0);
    expect(z[z.length - 1]).toBe(1);
    let I = 0;
    for (let i = 1; i < z.length; i++) I += 0.5 * (v[i]! + v[i - 1]!) * (z[i]! - z[i - 1]!);
    expect(Math.abs(I - 1)).toBeLessThan(1e-12);
    expect(s).toMatch(/lhgr\s+20000;/);
  });
  it("a case without a stack still has the one-cell mesh, the flat profile and the 1 m slice", () => {
    const one = writeOffbeatCase(norm(JSON.parse(read("examples/synthetic-pin.json"))));
    expect(one.files["system/blockMeshDict"]).toMatch(/fuel \(\d+ 1 1\)/);
    expect(one.files["constant/solverDict"]).toMatch(/axialProfile \{ type flat; \}/);
    expect(one.files["system/blockMeshDict"]).toMatch(/\(0 0 1000\)/);
  });
  it("a coolant table is written as timeDependentAxialProfileHTC with heights in metres and rows of the same values for both time points, past the end of the run; a wall table as timeDependentAxialProfileT", () => {
    const t = writeOffbeatCase(norm(stack({ ...cosine(0.381), boundary: [{ height: q(0, "m"), bulkTemperature: q(573, "K"), heatTransferCoefficient: q(30000, "W/m2/K") }, { height: q(381, "mm"), bulkTemperature: q(673, "K"), heatTransferCoefficient: q(25000, "W/m2/K") }] }))).files["0/T"]!;
    expect(t).toMatch(/type timeDependentAxialProfileHTC;/);
    expect(t).toMatch(/axialLocations \(0 0\.381\);/);
    expect(t).toMatch(/hData \(\(30000 25000\) \(30000 25000\)\);/);
    expect(t).toMatch(/T0Data \(\(573 673\) \(573 673\)\);/);
    const times = /timePoints \(0 ([^)]*)\);/.exec(t)!;
    expect(Number(times[1])).toBeGreaterThan(5e7);
    const d = stack({ ...cosine(0.381), boundary: [{ height: q(0, "m"), surfaceTemperature: q(573, "K") }, { height: q(0.381, "m"), surfaceTemperature: q(633, "K") }] });
    delete d.boundary.bulkTemperature;
    delete d.boundary.heatTransferCoefficient;
    d.boundary.surfaceTemperature = q(573, "K");
    const tw = writeOffbeatCase(norm(d)).files["0/T"]!;
    expect(tw).toMatch(/type timeDependentAxialProfileT;/);
    expect(tw).toMatch(/axialData \(\(573 633\) \(573 633\)\);/);
  });
  it("the mapping says what the stack became", () => {
    expect(w.mapping.find((m) => m.field === "axial")!.note).toMatch(/10 layers per solid over 381 mm.*normalised to an integral of 1/);
  });
});

describe("real OFFBEAT output of a stack, read layer by layer", () => {
  const g = (name: string) => ({ n: JSON.parse(read("tests/golden/offbeat-stack", name, "normalized.json")), T: read("tests/golden/offbeat-stack", name, "T"), C: read("tests/golden/offbeat-stack", name, "C") });
  const cos = g("cosine");
  const rise = g("rise");
  const judge = (x: ReturnType<typeof g>, mutate?: (n: any) => void, T = x.T, C = x.C) => {
    const n = JSON.parse(JSON.stringify(x.n));
    mutate?.(n);
    return buildStackResults(n, { T, C, time: 5e7 });
  };
  it("a cosine stack and a stack with a warming coolant: every check passes, the record carries one result per slice and the hottest slice's summary", () => {
    for (const x of [cos, rise]) {
      const r = judge(x);
      expect(r.checks.filter((c) => c.verdict === "fail")).toEqual([]);
      expect(r.axial.slices).toHaveLength(10);
      expect(r.summary.centreCellT).toBe(r.axial.slices[r.axial.hottest]!.centreCellT);
      expect(r.summary.maxT).toBe(Math.max(...r.axial.slices.map((s) => s.maxT)));
      expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["energyBalance", "closedFormFuel", "closedFormCladding", "wallTemperature", "energyBalanceTotal", "axialConduction"]));
      expect(r.thermalOnly).toMatch(/One radial solution per axial slice/);
    }
    expect([4, 5]).toContain(judge(cos).axial.hottest);
    expect(judge(rise).axial.hottest).toBeGreaterThanOrEqual(5);
  });
  it("a short pin (0.06 m, 12 slices), where the axial conduction is 4 % of the rise: the real output differs from the one-dimensional closed form by tens of kelvin, which the widened tolerance covers; without the allowance the checks would fail", () => {
    const s = g("short");
    const r = judge(s);
    expect(r.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    const fuel = r.checks.find((c) => c.id === "closedFormFuel")!;
    expect(fuel.value!).toBeGreaterThan(30);
    expect(fuel.value!).toBeLessThan(r.axial.allowance.field);
    // the estimate is of the size of the measured difference (44.7 K measured at the end slice, 45 K estimated for the peak rise)
    expect(r.axial.conduction!.fraction * 1141).toBeGreaterThan(0.7 * fuel.value!);
    expect(r.axial.conduction!.fraction * 1141).toBeLessThan(1.6 * fuel.value!);
    expect(r.axial.allowance.flux).toBeGreaterThan(1000);
  });
  it("the heat of the whole pin balances to 1e-4: the end faces carry nothing, whatever the axial conduction does", () => {
    const t = judge(cos).checks.find((c) => c.id === "energyBalanceTotal")!;
    expect(Math.abs(t.value!)).toBeLessThan(1e-4);
  });
  it("the axial conduction check is informational and states the widened tolerance", () => {
    const c = judge(cos).checks.find((x) => x.id === "axialConduction")!;
    expect(c.verdict).toBe("na");
    expect(c.value).toBeGreaterThan(0);
    expect(c.note).toMatch(/widened by 3 times it/);
  });
  it("judged against a stack that was not run, the checks fail: a shape read from the top, a coolant read from the top, 10 % more heat", () => {
    const asym = JSON.parse(JSON.stringify(rise.n));
    // the run was a cosine; judged as a ramp the cells disagree, and as the mirrored ramp they disagree too: both fail
    asym.axial.shape = { kind: "table", positions: [0, asym.axial.length], relative: [0.4, 1.6] };
    expect(judge({ ...rise, n: asym }).checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("fail");
    asym.axial.shape = { kind: "table", positions: [0, asym.axial.length], relative: [1.6, 0.4] };
    expect(judge({ ...rise, n: asym }).checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("fail");
    expect(judge(rise, (n) => (n.axial.boundary.bulkTemperature = [...n.axial.boundary.bulkTemperature].reverse())).checks.find((c) => c.id === "wallTemperature")!.verdict).toBe("fail");
    const hot = judge(cos, (n) => (n.qPrime *= 1.1));
    expect(hot.checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("fail");
    expect(hot.checks.find((c) => c.id === "energyBalanceTotal")!.verdict).toBe("fail");
  });
  it("output that is cut short, miscounted or in the wrong order is refused, never turned into a partial result", () => {
    const refuses = (f: () => unknown, re: RegExp, label = "") => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(ResultsError);
        expect((e as Error).message).toMatch(re);
        return;
      }
      throw new Error("not refused: " + label);
    };
    refuses(() => judge(cos, undefined, cos.T.slice(0, cos.T.length - 400)), /footer|cut short|unbalanced|boundary/, "truncated");
    refuses(() => judge(cos, (n) => (n.axial.slices = 9)), /expected 234 cells/);
    refuses(() => judge(cos, (n) => (n.mesh.claddingCells = 7)), /expected 270 cells/);
    // cells shuffled: swap the first fuel cell of layer 1 with the first of layer 2 in C (the heights no longer fit the layers)
    const rows = cos.C.split("\n");
    const i0 = rows.findIndex((l) => /^\([-\d]/.test(l));
    const swapped = [...rows];
    [swapped[i0], swapped[i0 + 20]] = [rows[i0 + 20]!, rows[i0]!];
    refuses(() => judge(cos, undefined, cos.T, swapped.join("\n")), /outside the layer 1 of 10/, "shuffled");
    const at = cos.T.lastIndexOf("cladOuter");
    refuses(() => judge(cos, undefined, cos.T.slice(0, at) + cos.T.slice(at).replace(/value\s+nonuniform List<scalar> 10\(/, "value nonuniform List<scalar> 9(")), /declares 9 values but holds 10|cladOuter patch has 9/, "patch list");
  });
});

describe("one line per check from every slice", () => {
  const c = (id: string, value: number | null, verdict: "pass" | "fail" | "na") => ({ id, label: id, value, unit: "", verdict, note: "n" });
  const at = (check: ReturnType<typeof c>, slice: number) => ({ check, slice, height: slice * 0.1 });
  it("a failing slice is reported, with the count and where; otherwise the worst value; a temperature margin's worst is the smallest", () => {
    const f = worstOf([at(c("closedFormFuel", 1, "pass"), 0), at(c("closedFormFuel", 2, "fail"), 1), at(c("closedFormFuel", 5, "fail"), 2)]);
    expect(f.verdict).toBe("fail");
    expect(f.value).toBe(5);
    expect(f.note).toMatch(/2 of 3 slices fail; the worst is slice 3 of 3/);
    const p = worstOf([at(c("energyBalance", -0.2, "pass"), 0), at(c("energyBalance", 0.1, "pass"), 1)]);
    expect(p.verdict).toBe("pass");
    expect(p.value).toBe(-0.2);
    const m = worstOf([at(c("temperatureLimit1", 300, "pass"), 0), at(c("temperatureLimit1", 120, "pass"), 1), at(c("temperatureLimit1", 500, "pass"), 2)]);
    expect(m.value).toBe(120);
    expect(m.note).toMatch(/slice 2 of 3/);
    expect(worstOf([at(c("x", null, "na"), 0), at(c("x", null, "na"), 1)]).verdict).toBe("na");
  });
});

describe("the shape the writer gives OFFBEAT is the shape the checks use", () => {
  it("normalizedShape of the golden case is what the golden run was given (the cells' heat follows it)", () => {
    const n = JSON.parse(read("tests/golden/offbeat-stack/cosine/normalized.json"));
    const s = normalizedShape(n.axial);
    expect(s.locations[0]).toBe(0);
    expect(s.locations[s.locations.length - 1]).toBe(1);
  });
});
