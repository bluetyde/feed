// Plan 12 A5, ungated: the reading of real OFFBEAT output of a stack of plates, saved from the real solver (tests/golden/offbeat-plate-stack, made by tests/plateStackSolver.test.ts
// with FEED_SAVE_GOLDEN=1). Each slice is judged against its own slab closed form, written out by hand here; the checks are shown to fail on a stack that is not the one that was
// run (a shifted or mirrored shape, a coolant read from the top, more heat, the plate read as a pin), and cut, miscounted or reordered output is refused.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { sliceLoads } from "../src/core/axial";
import { ResultsError } from "../src/core/resultsParser";
import { buildStackResults } from "../src/core/stackResults";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const g = (name: string) => ({ n: JSON.parse(read("tests/golden/offbeat-plate-stack", name, "normalized.json")), T: read("tests/golden/offbeat-plate-stack", name, "T"), C: read("tests/golden/offbeat-plate-stack", name, "C") });
const judge = (x: ReturnType<typeof g>, mutate?: (n: any) => void, T = x.T, C = x.C) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildStackResults(n, { T, C, time: 5e7 });
};
/** The slab closed form of a slice by hand (constant conductivities 3 and 15, gap 5000, half-thickness 4.1 mm, cladding 0.57 mm): coolant + q/h + q t / k + q/h_gap + q L / (2 k). */
const byHand = (q: number, Tb: number, h: number) => Tb + q / h + (q * 0.57e-3) / 15 + q / 5000 + (q * 4.1e-3) / 6;
const failingIds = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);

describe("real OFFBEAT output of a stack of plates, read layer by layer", () => {
  const cos = g("cosine");
  const rise = g("rise");
  it("a cosine stack and a stack with a warming coolant: every check passes, the record has one result per slice and the hottest slice's summary", () => {
    for (const x of [cos, rise]) {
      const r = judge(x);
      expect(failingIds(r)).toEqual([]);
      expect(r.axial.slices).toHaveLength(10);
      expect(r.summary.centreCellT).toBe(r.axial.slices[r.axial.hottest]!.centreCellT);
      expect(r.summary.maxT).toBe(Math.max(...r.axial.slices.map((s) => s.maxT)));
      expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["energyBalance", "closedFormFuel", "closedFormCladding", "wallTemperature", "energyBalanceTotal", "axialConduction"]));
      expect(r.thermalOnly).toMatch(/through-thickness solution per axial slice of the plate/);
      expect(r.thermalOnly).not.toMatch(/radial solution/);
    }
    expect([4, 5]).toContain(judge(cos).axial.hottest);
    expect(judge(rise).axial.hottest).toBeGreaterThanOrEqual(5);
  });
  it("each slice's centre is its own slab closed form (worked by hand) to within the axial conduction the estimate allows, and the mesh error is 0.01 K", () => {
    const r = judge(cos);
    const loads = sliceLoads(cos.n);
    loads.forEach((l, k) => {
      const dev = r.axial.slices[k]!.centreCellT - byHand(l.linearHeatRate, 573, 30000);
      expect(Math.abs(dev), "slice " + k).toBeLessThan(r.axial.allowance.field);
    });
    // the middle of the plate: the peak layer, 1.5726 x 200 kW/m, a rise of 296 K (the conduction takes 0.2 K of it)
    expect(Math.abs(r.axial.slices[5]!.centreCellT - byHand(loads[5]!.linearHeatRate, 573, 30000) + 0.2)).toBeLessThan(0.02);
    // the faces follow the coolant table: a film drop q/h above the coolant at the slice's height
    const w = judge(rise);
    w.axial.slices.forEach((s) => expect(Math.abs(s.claddingOuterWallT! - (573 + 100 * (s.height / 0.381) + s.linearHeatRate / 30000)), "slice " + s.index).toBeLessThan(0.2));
  });
  it("the heat of the whole plate balances to 1e-4: the end faces carry nothing, whatever the axial conduction does", () => {
    expect(Math.abs(judge(cos).checks.find((c) => c.id === "energyBalanceTotal")!.value!)).toBeLessThan(1e-4);
  });
  it("a short plate (0.06 m, 12 slices), where the axial conduction is large: the real output differs from the closed form by many times the mesh error, which the widened tolerance covers; the estimate is of the size of the difference", () => {
    const s = g("short");
    const r = judge(s);
    expect(failingIds(r)).toEqual([]);
    const fuel = r.checks.find((c) => c.id === "closedFormFuel")!;
    expect(fuel.value!).toBeGreaterThan(5);
    expect(fuel.value!).toBeLessThan(r.axial.allowance.field);
    const loads = sliceLoads(s.n);
    const worst = Math.max(...r.axial.slices.map((x, k) => Math.abs(x.centreCellT - byHand(loads[k]!.linearHeatRate, 573, 30000))));
    // the estimate times the peak rise (296 K) is of the size of the change the end slice shows (within a factor 2)
    const rise = r.axial.slices[6]!.centreCellT - 573;
    expect(r.axial.conduction!.fraction * rise).toBeGreaterThan(0.5 * worst);
    expect(r.axial.conduction!.fraction * rise).toBeLessThan(2 * worst);
    expect(r.axial.allowance.flux).toBeGreaterThan(1000);
  });
  it("a ramp shape (no curvature), where the estimate is zero: the end slices still pass, by the mesh bound; the limit is that the estimate sees only curvature", () => {
    const r = judge(g("ramp"));
    expect(failingIds(r)).toEqual([]);
    expect(r.axial.hottest).toBe(9);
    expect(r.axial.conduction!.fraction).toBeLessThan(1e-12);
    const closed = byHand(sliceLoads(g("ramp").n)[0]!.linearHeatRate, 573, 30000);
    const end = Math.abs(r.axial.slices[0]!.centreCellT - closed);
    // the end layer is changed by the neighbour (about 0.16 K on a 24 K step between slices) and nothing in the allowance covers it: the mesh bound does
    expect(end).toBeGreaterThan(0.05);
    expect(end).toBeLessThan(0.5);
  });
  it("judged against a stack that was not run, the checks fail: a shape read from the top, a coolant read from the top, 10 % more heat, the plate read as a pin", () => {
    const neg = g("negative");
    expect(failingIds(judge(neg))).toEqual([]);
    expect(judge(neg, (n) => (n.axial.shape.relative = [...n.axial.shape.relative].reverse())).checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("fail");
    expect(judge(neg, (n) => (n.axial.boundary.bulkTemperature = [...n.axial.boundary.bulkTemperature].reverse())).checks.find((c) => c.id === "wallTemperature")!.verdict).toBe("fail");
    // a shape shifted by one slice (the table's values moved by a tenth of the length) also fails
    const shifted = judge(neg, (n) => {
      const r = n.axial.shape.relative as number[];
      n.axial.shape = { kind: "table", positions: [0, 0.381 / 10, 0.381 * 0.5, 0.381], relative: [r[0], r[0], r[1], r[2]] };
    });
    expect(shifted.checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("fail");
    const more = judge(neg, (n) => (n.qPrime *= 1.1));
    expect(more.checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("fail");
    expect(more.checks.find((c) => c.id === "energyBalanceTotal")!.verdict).toBe("fail");
    // the plate read with the cylinder's formulas: refused or failing, never passing
    let pin: ReturnType<typeof judge> | undefined;
    try {
      pin = judge(neg, (n) => delete n.plate);
    } catch (e) {
      expect(e).toBeInstanceOf(ResultsError);
    }
    if (pin) expect(failingIds(pin).length).toBeGreaterThan(0);
  });
  it("output that is cut short, miscounted or in the wrong order is refused, never turned into a partial result", () => {
    const refuses = (f: () => unknown, re: RegExp, label: string) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(ResultsError);
        expect((e as Error).message, label).toMatch(re);
        return;
      }
      throw new Error("not refused: " + label);
    };
    refuses(() => judge(cos, undefined, cos.T.slice(0, cos.T.length - 400)), /footer|cut short|unbalanced|boundary/, "truncated");
    refuses(() => judge(cos, (n) => (n.axial.slices = 9)), /expected 234 cells/, "slice count");
    refuses(() => judge(cos, (n) => (n.mesh.claddingCells = 7)), /expected 270 cells/, "mesh");
    const rows = cos.C.split("\n");
    const i0 = rows.findIndex((l) => /^\([-\d]/.test(l));
    const swapped = [...rows];
    [swapped[i0], swapped[i0 + 20]] = [rows[i0 + 20]!, rows[i0]!];
    refuses(() => judge(cos, undefined, cos.T, swapped.join("\n")), /outside the layer 1 of 10/, "shuffled");
  });
});
