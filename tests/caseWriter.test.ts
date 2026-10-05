import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const normalize = (doc: any) => {
  const v = validateCase(doc);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};
const base = () => JSON.parse(JSON.stringify(read("examples/synthetic-pin.json")));
const written = (doc = base()) => writeOffbeatCase(normalize(doc));

/** Files whose content differs between two written cases. */
const changedFiles = (a: ReturnType<typeof written>, b: ReturnType<typeof written>) =>
  Object.keys(a.files).filter((f) => a.files[f] !== b.files[f]).sort();

const ref0 = writeOffbeatCase(normalize(JSON.parse(JSON.stringify(read("examples/synthetic-pin.json")))));

describe("OFFBEAT case writer", () => {
  it("writes the expected file set with LF endings", () => {
    const w = written();
    expect(Object.keys(w.files).sort()).toEqual(["0/D", "0/T", "constant/solverDict", "system/blockMeshDict", "system/controlDict", "system/fvSchemes", "system/fvSolution"]);
    for (const [f, text] of Object.entries(w.files)) {
      expect(text.includes("\r"), f).toBe(false);
      expect(text.endsWith("\n"), f).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(written().files).toEqual(written().files);
  });

  it("writes vertices within 2e-5 of the ones OFFBEAT's own rodMaker.py writes for the same pin (an independent cross-check)", () => {
    // golden: 16 vertices (mm) from rodMaker.py at OFFBEAT 80e84450 for the synthetic pin. The two tools use slightly
    // different wedge corrections (both are 1 + O(angle^2) with a 0.25 degree wedge), so exact equality is not expected.
    const golden: number[][] = read("tests/golden/rodmaker-vertices-synthetic-pin.json").vertices;
    const text = written().files["system/blockMeshDict"]!;
    const block = /vertices\s*\(([\s\S]*?)\)\s*;\s*blocks/.exec(text)![1]!;
    const ours = [...block.matchAll(/\(([^()]+)\)/g)].map((m) => m[1]!.trim().split(/\s+/).map(Number));
    expect(ours.length).toBe(16);
    ours.forEach((p, i) => p.forEach((x, j) => expect(Math.abs(x - golden[i]![j]!), `vertex ${i}.${j}`).toBeLessThan(2e-5 * Math.max(1, Math.abs(golden[i]![j]!)))));
  });

  it("each hex has exactly the volume of the cylindrical sector it stands for", () => {
    const text = written().files["system/blockMeshDict"]!;
    const block = /vertices\s*\(([\s\S]*?)\)\s*;\s*blocks/.exec(text)![1]!;
    const v = [...block.matchAll(/\(([^()]+)\)/g)].map((m) => m[1]!.trim().split(/\s+/).map(Number));
    const half = (0.25 / 2) * (Math.PI / 180); // half of the wedge angle
    // The planar hex is a trapezoid in x-y (parallel sides at xi and xo, half-widths yi and yo), per unit height.
    // Vertices 0,3 are its inner edge and 1,2 its outer edge; the fuel hex is vertices 0-7, the cladding hex 8-15.
    const area = (i0: number, o0: number) => (Math.abs(v[i0]![1]!) + Math.abs(v[o0]![1]!)) * (v[o0]![0]! - v[i0]![0]!);
    const sector = (ri: number, ro: number) => half * (ro * ro - ri * ri); // area of the sector of full angle 2 half: half (ro^2 - ri^2)
    const rf = 4.1, rci = 4.18, rco = 4.75; // synthetic pin, mm
    expect(Math.abs(area(0, 1) / sector(0, rf) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(area(8, 9) / sector(rci, rco) - 1)).toBeLessThan(1e-12);
  });

  it("writes the case values where the mapping says", () => {
    const w = written();
    expect(w.files["constant/solverDict"]).toMatch(/lhgr\s+20000;/);
    expect(w.files["constant/solverDict"]).toMatch(/k\s+k\s+\[1 1 -3 -1 0\]\s+3;/);
    expect(w.files["constant/solverDict"]).toMatch(/k\s+k\s+\[1 1 -3 -1 0\]\s+15;/);
    expect(w.files["0/T"]).toMatch(/alpha\s+uniform 5000;/);
    expect(w.files["0/T"]).toMatch(/T0 uniform 573;/);
    expect(w.files["0/T"]).toMatch(/h uniform 30000;/);
    expect(w.files["system/blockMeshDict"]).toMatch(/fuel \(20 1 1\)/);
    expect(w.files["system/blockMeshDict"]).toMatch(/cladding \(6 1 1\)/);
    expect(w.mapping.length).toBeGreaterThan(8);
    expect(w.placeholders.map((p) => p.name)).toContain("Cp");
  });

  describe("a changed option changes only the files that own it", () => {
    const ref = written();
    it("power -> solverDict only", () => {
      const d = base();
      d.power.linearHeatRate = { value: 25, unit: "kW/m" };
      expect(changedFiles(ref, written(d))).toEqual(["constant/solverDict"]);
    });
    it("fuel conductivity -> solverDict only", () => {
      const d = base();
      d.materials.fuel.sets["thermal.conductivity"].value = { value: 4, unit: "W/m/K" };
      expect(changedFiles(ref, written(d))).toEqual(["constant/solverDict"]);
    });
    it("gap conductance -> 0/T only", () => {
      const d = base();
      d.gap.conductance = { value: 6000, unit: "W/m2/K" };
      expect(changedFiles(ref, written(d))).toEqual(["0/T"]);
    });
    it("coolant heat-transfer coefficient -> 0/T only", () => {
      const d = base();
      d.boundary.heatTransferCoefficient = { value: 25000, unit: "W/m2/K" };
      expect(changedFiles(ref, written(d))).toEqual(["0/T"]);
    });
    it("mesh -> blockMeshDict only", () => {
      const d = base();
      d.mesh.fuelCells = 30;
      expect(changedFiles(ref, written(d))).toEqual(["system/blockMeshDict"]);
    });
    it("a label-only edit changes nothing", () => {
      const d = base();
      d.name = "renamed";
      d.label = "sourced";
      expect(changedFiles(ref, written(d))).toEqual([]);
    });
  });

  it("writes the fixed-temperature boundary form", () => {
    const w = written(read("schema/vectors/good/surface-temperature.json"));
    expect(w.files["0/T"]).toMatch(/type fixedValue;\s+value uniform 873.15;/);
    expect(w.files["0/T"]).not.toMatch(/convectiveHTC/);
  });

  it("accepts the zero-cold-gap K-State case", () => {
    const w = written(read("examples/ksu-triga-hot-element.json"));
    expect(w.files["0/T"]).toMatch(/alpha\s+uniform 2840;/);
  });

  describe("temperature-dependent conductivity k = a + b T", () => {
    const w = written(read("schema/vectors/good/linear-conductivity.json"));
    const dict = w.files["constant/solverDict"]!;
    it("is written through OFFBEAT's linear-in-degC model with converted coefficients", () => {
      // a = 4.0 W/m/K, b = -0.0006 W/m/K2  ->  par1 = a + 273.15 b, par2 = b
      expect(dict).toMatch(/conductivityModel steel1515TiTobbe;/);
      expect(dict).toMatch(/conductivity \{ par1 3\.83611; par2 -0\.0006; \}/);
    });
    it("leaves the constant cladding as a plain k and drops k from the linear fuel", () => {
      const fuel = /fuel\n\s*\{[\s\S]*?\n    \}/.exec(dict)![0];
      const clad = /cladding\n\s*\{[\s\S]*?\n    \}/.exec(dict)![0];
      expect(fuel).not.toMatch(/\bk\s+k\s+\[/);
      expect(clad).toMatch(/k\s+k\s+\[1 1 -3 -1 0\]\s+15;/);
      expect(clad).not.toMatch(/steel1515TiTobbe/);
    });
    it("is stated in the mapping, and the stated range is not sent to the solver", () => {
      expect(w.mapping.find((m) => m.field.startsWith("materials.fuel"))!.note).toMatch(/linear k\(T\)/);
      expect(dict).not.toMatch(/validRange|500|2500/);
    });
    it("a linear cladding works too and only the cladding block changes", () => {
      const d = base();
      d.materials.cladding.sets["thermal.conductivity"] = { model: "linear", a: { value: 10, unit: "W/m/K" }, b: { value: 0.016333, unit: "W/m/K2" }, validRange: { min: { value: 300, unit: "K" }, max: { value: 600, unit: "K" } }, source: "test" };
      const c = written(d);
      expect(c.files["constant/solverDict"]).toMatch(/par1 14\.46135\d*; par2 0\.016333;/);
      expect(changedFiles(ref0, c)).toEqual(["constant/solverDict"]);
    });
    it("changing only the law's coefficient changes only solverDict", () => {
      const a = written(read("schema/vectors/good/linear-conductivity.json"));
      const d = read("schema/vectors/good/linear-conductivity.json");
      d.materials.fuel.sets["thermal.conductivity"].b = { value: -0.0005, unit: "W/m/K2" };
      expect(changedFiles(a, written(d))).toEqual(["constant/solverDict"]);
    });
  });

  it("cannot write a number that is not finite", () => {
    const n = normalize(base());
    expect(() => writeOffbeatCase({ ...n, qPrime: Number.NaN })).toThrow(/non-finite/);
  });
});
