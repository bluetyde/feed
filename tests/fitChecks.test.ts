// The fit check carried by a result: only a tabulated region has one, its value is the fit's own deviation, and the sourced table in the library is exact.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { evaluate, lawOf } from "../src/core/conductivity";
import { fitChecks } from "../src/core/resultsParser";
import { validateCase } from "../src/core/validate";
import { library } from "../src/server/server";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const pts = (rows: number[][]) => rows.map(([T, k]) => ({ temperature: q(T!, "K"), conductivity: q(k!, "W/m/K") }));

function withSets(fuel?: unknown, clad?: unknown) {
  const d = read("examples/synthetic-pin.json");
  if (fuel) d.materials.fuel.sets["thermal.conductivity"] = fuel;
  if (clad) d.materials.cladding.sets["thermal.conductivity"] = clad;
  const v = validateCase(d);
  if (!v.normalized) throw new Error(JSON.stringify(v.errors));
  return v.normalized;
}
const table = (rows: number[][], degree: number, tol = 2) => ({ model: "table", points: pts(rows), fit: { degree, tolerance: q(tol, "%") }, source: "test" });

describe("fitChecks", () => {
  it("a case with no table has none", () => {
    expect(fitChecks(withSets())).toEqual([]);
  });

  it("a tabulated fuel carries one, named for the fuel, with the fit's own deviation as its value", () => {
    const n = withSets(table([[300, 2.8], [600, 3.5], [900, 3.9], [1200, 4.05], [1500, 4.1]], 2, 5));
    const c = fitChecks(n);
    expect(c.map((x) => x.id)).toEqual(["conductivityFitFuel"]);
    const k = n.fuelConductivity;
    if (k.kind !== "polynomial" || !k.fit) throw new Error("not a fitted polynomial");
    expect(c[0]!.value).toBe(k.fit.maxRelativeDeviation);
    expect(c[0]!.value!).toBeGreaterThan(0);
    expect(c[0]!.unit).toBe("relative");
    expect(c[0]!.verdict).toBe("pass");
    expect(c[0]!.note).toMatch(/degree 2 polynomial fitted by least squares to 5 points from 300 to 1500 K/);
    expect(c[0]!.note).toMatch(/tolerance 5\.00%/);
  });

  it("a tabulated cladding carries the cladding's check, and both regions carry one each, fuel first", () => {
    const t = table([[300, 14.9], [400, 16.6], [600, 19.8]], 2, 1);
    expect(fitChecks(withSets(undefined, t)).map((x) => x.id)).toEqual(["conductivityFitCladding"]);
    const both = fitChecks(withSets(table([[300, 2.8], [900, 3.9], [1500, 4.1]], 2), t));
    expect(both.map((x) => x.id)).toEqual(["conductivityFitFuel", "conductivityFitCladding"]);
  });

  it("an exact interpolation has deviation zero, and the check fails if a fit were ever beyond its tolerance", () => {
    const n = withSets(undefined, table([[300, 14.9], [400, 16.6], [600, 19.8]], 2, 1));
    expect(fitChecks(n)[0]!.value!).toBeLessThan(1e-12);
    const k = n.claddingConductivity;
    if (k.kind !== "polynomial" || !k.fit) throw new Error("not a fitted polynomial");
    const worse = { ...n, claddingConductivity: { ...k, fit: { ...k.fit, maxRelativeDeviation: 0.03 } } };
    expect(fitChecks(worse)[0]!.verdict).toBe("fail");
  });

  it("a polynomial given directly has no fit, so no check", () => {
    const poly = { model: "polynomial", a: q(2, "W/m/K"), b: q(0.003, "W/m/K2"), c: q(0, "W/m/K3"), d: q(0, "W/m/K4"), validRange: { min: q(500, "K"), max: q(2500, "K") }, source: "t" };
    expect(fitChecks(withSets(poly))).toEqual([]);
  });
});

describe("the sourced stainless table in the library", () => {
  const entry = library().materials.find((m: any) => m.material.materialId === "ss304-ktable")!;
  it("is labelled sourced, cites the SAR, and its quadratic reproduces all three SAR points exactly (including 16.6 at 400 K, which the line misses)", () => {
    expect(entry.label).toBe("sourced");
    expect(entry.citation).toMatch(/SAR/);
    const n = withSets(undefined, (entry.material.sets as any)["thermal.conductivity"]);
    const k = n.claddingConductivity;
    const law = lawOf(k);
    for (const [T, kk] of [[300, 14.9], [400, 16.6], [600, 19.8]] as const) expect(evaluate(law, T)).toBeCloseTo(kk, 9);
    expect(fitChecks(n)[0]!.value!).toBeLessThan(1e-12);
  });
});
