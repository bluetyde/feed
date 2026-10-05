import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildResults } from "../src/core/resultsParser";
import { refinementStudy, StudyInput, studyCases } from "../src/core/refinement";
import { validateCase } from "../src/core/validate";
import { scalarFieldText, vectorFieldText } from "./helpers/foamText";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const meshes = [
  { tag: "mesh1", nf: 10, nc: 3 },
  { tag: "mesh2", nf: 20, nc: 6 },
  { tag: "mesh3", nf: 40, nc: 12 },
  { tag: "mesh4", nf: 80, nc: 24 },
];

/** Real saved OFFBEAT output of one mesh, turned back into field text and read by the real parser. */
function level(prefix: string, m: (typeof meshes)[number], baseDoc?: any): StudyInput {
  const saved = read(`solver/results/${prefix}.${m.tag}.json`);
  const doc = JSON.parse(JSON.stringify(baseDoc ?? read("examples/synthetic-pin.json")));
  doc.mesh = { fuelCells: m.nf, claddingCells: m.nc };
  const n = validateCase(doc).normalized!;
  return { id: m.tag, normalized: n, results: buildResults(n, { T: scalarFieldText(saved.T, saved.cladOuterWallT), C: vectorFieldText(saved.r), time: saved.time }) };
}
const kTdoc = () => read("schema/vectors/good/linear-conductivity.json");

describe("refinement study on real saved OFFBEAT output", () => {
  it("constant k: close to second order on three meshes", () => {
    const s = refinementStudy([level("synthetic-pin", meshes[0]!), level("synthetic-pin", meshes[1]!), level("synthetic-pin", meshes[2]!)]) as any;
    expect(s.verdict).toBe("pass");
    expect(s.levels.map((l: any) => l.fuelCells)).toEqual([10, 20, 40]);
    expect(s.levels[0].fuelOrder).toBeNull();
    expect(s.levels[1].fuelOrder).toBeGreaterThan(1.3);
    expect(s.levels[2].fuelOrder).toBeGreaterThan(1.3);
    expect(s.levels[2].fuelError).toBeLessThan(s.levels[0].fuelError);
  });

  it("four meshes work and the finest has the smallest error", () => {
    const s = refinementStudy(meshes.map((m) => level("synthetic-pin", m))) as any;
    expect(s.verdict).toBe("pass");
    const e = s.levels.map((l: any) => l.fuelError);
    expect(e).toEqual([...e].sort((a, b) => b - a));
  });

  it("k(T) fuel: also close to second order", () => {
    const s = refinementStudy(meshes.slice(0, 3).map((m) => level("synthetic-pin-kT", m, kTdoc()))) as any;
    expect(s.verdict).toBe("pass");
    expect(s.levels[1].fuelOrder).toBeGreaterThan(1.3);
  });

  it("input order does not matter", () => {
    const a = refinementStudy([level("synthetic-pin", meshes[2]!), level("synthetic-pin", meshes[0]!), level("synthetic-pin", meshes[1]!)]) as any;
    expect(a.levels.map((l: any) => l.fuelCells)).toEqual([10, 20, 40]);
  });

  describe("tests of the verifier", () => {
    it("fails when the error does not shrink (the first-round 2000 s runs behaved like this)", () => {
      const lv = meshes.slice(0, 3).map((m) => level("synthetic-pin", m));
      // make every level carry the same error: an unfinished steady state is a mesh-independent offset
      for (const l of lv) l.results.checks.find((c) => c.id === "closedFormFuel")!.value = 0.5;
      const s = refinementStudy(lv) as any;
      expect(s.verdict).toBe("fail");
      expect(s.note).toMatch(/not reducing the error/);
    });
    it("fails when the error grows", () => {
      const lv = meshes.slice(0, 3).map((m) => level("synthetic-pin", m));
      lv[0]!.results.checks.find((c) => c.id === "closedFormFuel")!.value = 0.1;
      lv[1]!.results.checks.find((c) => c.id === "closedFormFuel")!.value = 0.2;
      lv[2]!.results.checks.find((c) => c.id === "closedFormFuel")!.value = 0.4;
      expect((refinementStudy(lv) as any).verdict).toBe("fail");
    });
    it("reports not-applicable when every level is at the solver tolerance", () => {
      const lv = meshes.slice(0, 3).map((m) => level("synthetic-pin", m));
      for (const l of lv) l.results.checks.find((c) => c.id === "closedFormFuel")!.value = 1e-6;
      expect((refinementStudy(lv) as any).verdict).toBe("na");
    });
  });

  describe("inputs that are not a refinement study are refused", () => {
    it("fewer than three meshes", () => {
      expect((refinementStudy([level("synthetic-pin", meshes[0]!), level("synthetic-pin", meshes[1]!)]) as any).error).toMatch(/at least three/);
    });
    it("runs that differ in more than the mesh", () => {
      const lv = meshes.slice(0, 3).map((m) => level("synthetic-pin", m));
      const other = validateCase((() => { const d = read("examples/synthetic-pin.json"); d.power.linearHeatRate = { value: 21, unit: "kW/m" }; d.mesh = { fuelCells: 40, claddingCells: 12 }; return d; })()).normalized!;
      lv[2] = { ...lv[2]!, normalized: other };
      expect((refinementStudy(lv) as any).error).toMatch(/differ in more than the mesh/);
    });
    it("the same mesh twice", () => {
      const lv = [level("synthetic-pin", meshes[0]!), level("synthetic-pin", meshes[1]!), level("synthetic-pin", meshes[1]!)];
      expect((refinementStudy(lv) as any).error).toMatch(/must get finer/);
    });
    it("a level with no closed-form comparison", () => {
      const lv = meshes.slice(0, 3).map((m) => level("synthetic-pin", m));
      lv[1]!.results.checks = lv[1]!.results.checks.filter((c) => c.id !== "closedFormFuel");
      expect((refinementStudy(lv) as any).error).toMatch(/no closed-form comparison/);
    });
  });
});

describe("studyCases", () => {
  it("multiplies the mesh and changes nothing else", () => {
    const base = read("examples/synthetic-pin.json");
    const c = studyCases(base);
    expect(c.map((d) => [d.mesh.fuelCells, d.mesh.claddingCells])).toEqual([[20, 6], [40, 12], [80, 24]]);
    for (const d of c) expect({ ...d, mesh: undefined }).toEqual({ ...base, mesh: undefined });
    expect(base.mesh).toEqual({ fuelCells: 20, claddingCells: 6 });
  });
});
