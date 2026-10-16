// Plan 12 A3, ungated: the writer's files for a transient on a stack, the slice's own case, and the reading of real OFFBEAT output saved from the real solver
// (tests/golden/offbeat-stack-transient, made by tests/axialTransientSolver.test.ts with FEED_SAVE_GOLDEN=1). The checks are shown to fail on a stack that is not the one that was run,
// and truncated, miscounted or reordered output is refused.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { sliceCase, sliceLoads } from "../src/core/axial";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { ResultsError } from "../src/core/resultsParser";
import { buildStackTransientResults, computeIndependentStack } from "../src/core/stackTransientResults";
import { initialState } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const example = (id: string) => JSON.parse(read("examples", id + ".json"));
const cosine = (L: number, N = 10) => ({ length: q(L, "m"), slices: N, powerShape: { kind: "cosine" } });
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};
const nums = (s: string) => s.trim().split(/\s+/).map(Number);

describe("a slice of a transient stack", () => {
  it("has the case's average history times its factor, a steady start at its own heat rate, and no axial section", () => {
    const d = example("synthetic-pulse-operating");
    d.axial = cosine(0.381);
    const n = norm(d);
    const loads = sliceLoads(n);
    const k = 3;
    const sc = sliceCase(n, loads[k]!);
    expect(sc.axial).toBeUndefined();
    sc.transient!.linearHeatRate.forEach((x, i) => expect(x).toBeCloseTo(n.transient!.linearHeatRate[i]! * loads[k]!.factor, 6));
    expect(sc.transient!.initial).toEqual({ kind: "steady", linearHeatRate: (n.transient!.initial as { linearHeatRate: number }).linearHeatRate * loads[k]!.factor });
    expect(sc.qPrime).toBeCloseTo(n.qPrime * loads[k]!.factor, 6);
    // the original is not changed
    expect(n.transient!.linearHeatRate[1]).toBe(1e7);
  });
  it("a stack's validator accepts a pulse, a steady start, a boundary history and a coolant table, and refuses point kinetics, a table with a history, and too much work", () => {
    const base = () => example("synthetic-pulse");
    const withAxial = (extra: Record<string, unknown> = {}) => ({ ...base(), axial: { ...cosine(0.381), ...extra } });
    expect(validateCase(withAxial()).errors).toEqual([]);
    const kin = example("synthetic-pulse-kinetics");
    kin.axial = cosine(0.381);
    expect(validateCase(kin).errors.map((e) => e.code)).toContain("E_UNSUPPORTED");
    const both = withAxial({ boundary: [{ height: q(0, "m"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") }, { height: q(0.381, "m"), bulkTemperature: q(330, "K"), heatTransferCoefficient: q(30000, "W/m2/K") }] });
    both.transient.boundaryHistory = [{ time: q(0, "ms"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") }, { time: q(100, "ms"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(1000, "W/m2/K") }];
    expect(validateCase(both).errors.map((e) => e.field)).toContain("/axial/boundary");
    const big = withAxial({ slices: 50 });
    big.transient.timeStep = q(0.001, "ms");
    expect(validateCase(big).errors.map((e) => e.code)).toContain("E_TIME");
    // no pulse warning: a pulse's peak is far above the sanity range of a steady heat rate and that is no fault
    expect(validateCase(withAxial()).warnings.map((w) => w.code)).not.toContain("W_POWER_RANGE");
  });
});

describe("the files of a transient on a stack", () => {
  const d = example("synthetic-pulse-operating");
  d.axial = cosine(0.381);
  const n = norm(d);
  const w = writeOffbeatCase(n);
  it("the power is the average history times the axial table, the mesh has N layers and the end time and outputs are the case's", () => {
    const s = w.files["constant/solverDict"]!;
    expect(s).toMatch(/axialProfile \{ type constantTabulated;/);
    expect(s).toMatch(/lhgr\s+\(20000 10000000 20000 20000 20000\);/);
    expect(w.files["system/blockMeshDict"]).toMatch(/fuel \(20 1 10\)/);
    expect(w.files["feed-transient.json"]).toMatch(/"outputs":20/);
  });
  it("every slice starts at its own steady state, written for all cells in the mesh's order: the fuel cells of every layer, then the cladding cells of every layer", () => {
    const t = w.files["0/T"]!;
    const m = /internalField\s+nonuniform List<scalar>\s*(\d+)\s*\(([^)]*)\)/.exec(t)!;
    expect(Number(m[1])).toBe(260);
    const T = nums(m[2]!);
    expect(T).toHaveLength(260);
    const loads = sliceLoads(n);
    for (const k of [0, 4, 9]) {
      const st = initialState(sliceCase(n, loads[k]!));
      st.T.slice(0, 20).forEach((x, i) => expect(T[k * 20 + i]).toBeCloseTo(x, 6));
      st.T.slice(20).forEach((x, i) => expect(T[200 + k * 6 + i]).toBeCloseTo(x, 6));
    }
    // the layers differ: the middle ones are hotter than the ends
    expect(T[4 * 20]).toBeGreaterThan(T[0]! + 100);
  });
  it("a boundary history on a stack is written with the axial positions in metres (0 to the length)", () => {
    const c = example("synthetic-coastdown");
    c.axial = cosine(0.381);
    const t = writeOffbeatCase(norm(c)).files["0/T"]!;
    expect(t).toMatch(/type timeDependentAxialProfileHTC;/);
    expect(t).toMatch(/axialLocations \(0 0\.381\);/);
  });
});

describe("real OFFBEAT output of a transient stack, read slice by slice", () => {
  const g = (name: string) => {
    const d = join("tests", "golden", "offbeat-stack-transient", name);
    const n = JSON.parse(read(d, "normalized.json"));
    const times = readdirSync(join(root, d, "times")).sort((a, b) => Number(a) - Number(b));
    return { n, C: read(d, "C"), fields: times.map((t) => ({ time: Number(t), T: read(d, "times", t, "T") })) };
  };
  const pulse = g("pulse");
  const cool = g("coastdown");
  const asym = g("asym");
  const judge = (x: ReturnType<typeof g>, mutate?: (n: any) => void, over: Partial<ReturnType<typeof g>> = {}) => {
    const n = JSON.parse(JSON.stringify(x.n));
    mutate?.(n);
    return buildStackTransientResults(n, { C: over.C ?? x.C, fields: over.fields ?? x.fields }, computeIndependentStack(n));
  };
  it("a pulse on an operating stack, a pump coastdown and an asymmetric shape: every check passes, the record has one series per slice and the hottest slice's profiles", () => {
    for (const x of [pulse, cool, asym]) {
      const r = judge(x);
      expect(r.checks.filter((c) => c.verdict === "fail")).toEqual([]);
      expect(r.axial.slices).toHaveLength(10);
      expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["energyBalance", "crossCheckFv", "timeStep", "energyBalanceTotal", "axialConduction"]));
      expect(r.summary.maxT).toBe(Math.max(...r.axial.slices.map((s) => s.maxT)));
      expect(r.axial.slices[r.axial.hottest]!.maxT).toBe(r.summary.maxT);
      expect(r.thermalOnly).toMatch(/One radial solution per axial slice/);
    }
    expect([4, 5]).toContain(judge(pulse).axial.hottest);
    // the asymmetric shape has more power at the top
    expect(judge(asym).axial.hottest).toBeGreaterThan(5);
  });
  it("a short stack (0.06 m, 12 slices), where the heat flow along the pin is large: over 60 s of a coastdown the real output differs from the independent solution by tens of kelvin at the end slice (it starts from the one-dimensional steady states and relaxes toward the solver's coupled one), which the widened tolerance covers; without the allowance the cross-check fails", () => {
    const s = g("shortcool");
    const r = judge(s);
    expect(r.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    const cross = r.checks.find((c) => c.id === "crossCheckFv")!;
    expect(cross.value!).toBeGreaterThan(10);
    expect(cross.value!).toBeLessThan(r.axial.allowance.field);
    // the exchange number of this 60 s run is 4.8, above the limit of 1 where the first-order bound of the heat the slices exchange holds: it is not counted, and the allowance is the steady one (136 K)
    expect(r.axial.allowance.exchangeNumber!).toBeGreaterThan(4);
    expect(r.axial.allowance.exchangeCounted).toBe(false);
    expect(r.axial.allowance.field).toBeCloseTo(136.02, 1);
    expect(r.checks.find((c) => c.id === "axialConduction")!.note).toMatch(/ABOVE 1.*NOT counted/);
    // the pin's pump coastdown, over 60 s with its coolant, is below it: the exchange bound (10.7 K, undamped) is counted and exceeds the steady allowance (3.4 K), the measured change is 3.0 K
    const cd = judge(cool);
    expect(cd.axial.allowance.exchangeCounted).toBe(true);
    expect(cd.axial.allowance.exchangeField!).toBeGreaterThan(cd.axial.allowance.field);
    expect(cd.checks.find((c) => c.id === "crossCheckFv")!.value!).toBeLessThan(cd.axial.allowance.exchangeField!);
    // a pulse on the short stack is over in 0.1 s, before heat can flow along the pin: it passes with a deviation of a degree or two, and the allowance is loose there (a stated limit)
    const p = judge(g("short"));
    expect(p.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    expect(p.checks.find((c) => c.id === "crossCheckFv")!.value!).toBeLessThan(5);
  });
  it("the whole pin's energy balances, and the allowance is a fraction of the largest rise of any slice", () => {
    const r = judge(pulse);
    expect(r.checks.find((c) => c.id === "energyBalanceTotal")!.value!).toBeLessThan(0.03);
    expect(r.axial.allowance.field).toBeGreaterThan(1);
    expect(r.axial.allowance.field).toBeLessThan(10);
    expect(r.axial.allowance.energy).toBeLessThan(0.01);
    // the cross-check bound of the worst slice includes the allowance
    expect(r.checks.find((c) => c.id === "crossCheckFv")!.note).toMatch(/for the heat flow along the pin \(an axial stack/);
  });
  it("judged against a stack that was not run, the checks fail: the shape read from the top, 20 % more power", () => {
    const m = judge(asym, (n) => (n.axial.shape.relative = [...n.axial.shape.relative].reverse()));
    expect(m.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("fail");
    expect(m.checks.find((c) => c.id === "energyBalance")!.verdict).toBe("fail");
    const p = judge(asym, (n) => (n.transient.linearHeatRate = n.transient.linearHeatRate.map((x: number) => x * 1.2)));
    expect(p.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("fail");
    expect(p.checks.find((c) => c.id === "energyBalanceTotal")!.verdict, "20 % more power: the whole pin does not balance").toBe("fail");
    const h = judge(cool, (n) => (n.transient.boundaryHistory.heatTransferCoefficient = n.transient.boundaryHistory.heatTransferCoefficient.map((x: number) => x * 0.5)));
    expect(h.checks.find((c) => c.id === "crossCheckFv")!.verdict, "half the film coefficient").toBe("fail");
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
    const last = pulse.fields[pulse.fields.length - 1]!;
    refuses(() => judge(pulse, undefined, { fields: [...pulse.fields.slice(0, -1), { time: last.time, T: last.T.slice(0, last.T.length - 400) }] }), /footer|cut short|unbalanced|cladOuter/, "truncated");
    refuses(() => judge(pulse, (n) => (n.axial.slices = 9)), /C has 260 cells, expected 234/, "slice count");
    const rows = pulse.C.split("\n");
    const i0 = rows.findIndex((l) => /^\([-\d]/.test(l));
    const swapped = [...rows];
    [swapped[i0], swapped[i0 + 20]] = [rows[i0 + 20]!, rows[i0]!];
    refuses(() => judge(pulse, undefined, { C: swapped.join("\n") }), /outside the layer 1 of 10/, "shuffled");
    const at = last.T.lastIndexOf("cladOuter");
    const short = last.T.slice(0, at) + last.T.slice(at).replace(/value\s+nonuniform List<scalar> 10\(/, "value nonuniform List<scalar> 9(");
    refuses(() => judge(pulse, undefined, { fields: [...pulse.fields.slice(0, -1), { time: last.time, T: short }] }), /declares 9 values but holds 10|cladOuter patch has 9/, "patch list");
    refuses(() => buildStackTransientResults(pulse.n, { C: pulse.C, fields: pulse.fields }, computeIndependentStack(pulse.n).slice(0, 9)), /independent solutions are for 9 slices/, "sets");
  });
});
