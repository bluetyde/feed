import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { compareResults, diffCases, flatten, profileDifference } from "../src/core/compare";
import { resultsToCsv } from "../src/core/exportResults";
import { buildResults } from "../src/core/resultsParser";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const golden = (f: string) => readFileSync(join(root, "tests/golden/offbeat-syn", f), "utf8");
const pinDoc = (mutate?: (d: any) => void) => {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  mutate?.(d);
  return d;
};
const norm = (d: any) => validateCase(d).normalized!;
const results = (d: any, T = golden("T")) => buildResults(norm(d), { T, C: golden("C"), time: 5e7 });

describe("diffCases", () => {
  it("flattens quantities to one leaf", () => {
    expect(flatten({ power: { linearHeatRate: { value: 20, unit: "kW/m" } }, name: "x" })).toEqual({ "power.linearHeatRate": "20 kW/m", name: "x" });
  });
  it("identical cases have no differences", () => expect(diffCases(pinDoc(), pinDoc())).toEqual([]));
  it("lists exactly the changed fields, sorted, with units", () => {
    const b = pinDoc((d) => {
      d.power.linearHeatRate = { value: 25, unit: "kW/m" };
      d.boundary.heatTransferCoefficient = { value: 25000, unit: "W/m2/K" };
    });
    expect(diffCases(pinDoc(), b)).toEqual([
      { path: "boundary.heatTransferCoefficient", a: "30000 W/m2/K", b: "25000 W/m2/K" },
      { path: "power.linearHeatRate", a: "20 kW/m", b: "25 kW/m" },
    ]);
  });
  it("a unit change is a difference even when the number is the same", () => {
    const b = pinDoc((d) => (d.geometry.fuelRadius = { value: 4.1, unit: "cm" }));
    expect(diffCases(pinDoc(), b).map((r) => r.path)).toEqual(["geometry.fuelRadius"]);
  });
  it("a field present on one side only is shown as absent", () => {
    const b = pinDoc((d) => (d.futureField = 1));
    expect(diffCases(pinDoc(), b)).toEqual([{ path: "futureField", a: "(absent)", b: "1" }]);
  });
});

describe("compareResults and profileDifference", () => {
  const ra = results(pinDoc());
  it("the same run against itself has zero deltas and the same verdicts", () => {
    const c = compareResults(ra, ra);
    expect(c.summary.every((r) => r.delta === 0)).toBe(true);
    expect(c.checks.every((r) => r.a === r.b)).toBe(true);
  });
  it("reports B minus A for each summary value", () => {
    const hot = golden("T").replace("1307.2076", "1317.2076");
    const c = compareResults(ra, results(pinDoc(), hot));
    const centre = c.summary.find((r) => r.id === "centreCellT")!;
    expect(centre.a).toBeCloseTo(1307.2076, 4);
    expect(centre.delta).toBeCloseTo(10, 4);
    expect(c.summary.find((r) => r.id === "maxT")!.delta).toBeCloseTo(10, 4);
    expect(c.summary.find((r) => r.id === "minT")!.delta).toBeCloseTo(0, 6);
  });
  it("shows a verdict that changed between runs", () => {
    const rb = results(pinDoc((d) => (d.materials.fuel.sets["thermal.conductivity"].value = { value: 3.3, unit: "W/m/K" })));
    const row = compareResults(ra, rb).checks.find((r) => r.id === "closedFormFuel")!;
    expect([row.a, row.b]).toEqual(["pass", "fail"]);
  });
  it("gives the point-by-point difference when geometry and mesh match", () => {
    const hot = golden("T").replace("1307.2076", "1317.2076");
    const d = profileDifference(norm(pinDoc()), norm(pinDoc()), ra, results(pinDoc(), hot)) as { r: number[]; dT: number[] };
    expect(d.r.length).toBe(26);
    expect(d.dT[0]).toBeCloseTo(10, 4);
    expect(d.dT.slice(1).every((x) => Math.abs(x) < 1e-9)).toBe(true);
  });
  it("refuses to invent a difference when the geometry differs", () => {
    const r = profileDifference(norm(pinDoc()), norm(pinDoc((d) => (d.geometry.claddingOuterRadius = { value: 4.8, unit: "mm" }))), ra, ra) as { reason: string };
    expect(r.reason).toMatch(/differ in geometry or mesh/);
  });
  it("refuses when only the mesh differs", () => {
    const r = profileDifference(norm(pinDoc()), norm(pinDoc((d) => (d.mesh.fuelCells = 30))), ra, ra) as { reason: string };
    expect(r.reason).toMatch(/differ in geometry or mesh/);
  });
});

describe("CSV export", () => {
  const res = results(pinDoc());
  const csv = resultsToCsv(res, { runId: "abcdef012345", caseName: "Synthetic\ncomposite pin", solver: "OpenFOAM 9 + OFFBEAT", caseHash: "ff00" });
  const lines = csv.split("\n");
  it("starts with the thermal-only statement and the provenance", () => {
    expect(lines[1]).toMatch(/Thermal-only/);
    expect(csv).toMatch(/run: abcdef012345/);
    expect(csv).toMatch(/case hash: ff00/);
  });
  it("keeps a multi-line case name on one comment line", () => expect(lines.filter((l) => l.startsWith("#")).every((l) => !l.includes("\r"))).toBe(true));
  it("has one data row per cell in kelvin and celsius", () => {
    const head = lines.findIndex((l) => l === "r_mm,T_K,T_C,region");
    expect(head).toBeGreaterThan(0);
    const rows = lines.slice(head + 1).filter(Boolean);
    expect(rows.length).toBe(26);
    const first = rows[0]!.split(",");
    expect(Number(first[1])).toBeCloseTo(1307.2076, 4);
    expect(Number(first[2])).toBeCloseTo(1307.2076 - 273.15, 4);
    expect(first[3]).toBe("fuel");
    expect(rows[25]!.split(",")[3]).toBe("cladding");
  });
  it("ends with a newline and has no CR", () => {
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv.includes("\r")).toBe(false);
  });
});
