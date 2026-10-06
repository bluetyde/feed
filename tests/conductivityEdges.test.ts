// Boundaries of the polynomial and table conductivity validation, each exactly at the edge (found by the mutation run): a range of zero width, a range from 0 K,
// a conductivity that touches zero, 200 and 201 table points, a point at 0 K, two points at one temperature.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { MAX_TABLE_POINTS, validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const range = (lo: number, hi: number) => ({ min: q(lo, "K"), max: q(hi, "K") });
const poly = (a: number[], r: [number, number]) => ({ model: "polynomial", a: q(a[0]!, "W/m/K"), b: q(a[1]!, "W/m/K2"), c: q(a[2]!, "W/m/K3"), d: q(a[3]!, "W/m/K4"), validRange: range(r[0], r[1]), source: "t" });
const pts = (rows: number[][]) => rows.map(([T, k]) => ({ temperature: q(T!, "K"), conductivity: q(k!, "W/m/K") }));
const table = (rows: number[][], degree = 1, tol = 50) => ({ model: "table", points: pts(rows), fit: { degree, tolerance: q(tol, "%") }, source: "t" });
const check = (set: unknown) => {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.materials.fuel.sets["thermal.conductivity"] = set;
  return validateCase(d);
};
const codes = (set: unknown) => check(set).errors.map((e) => e.code + " " + e.field.replace("/materials/fuel/sets/thermal.conductivity", ""));

describe("polynomial conductivity edges", () => {
  it("accepts a good one (the reference for the refusals below)", () => {
    expect(codes(poly([2, 0.003, -1.2e-6, 2e-10], [500, 2500]))).toEqual([]);
  });
  it("a range of zero width is refused", () => {
    expect(codes(poly([2, 0, 0, 0], [800, 800]))).toEqual(["E_OUT_OF_RANGE /validRange"]);
  });
  it("a range that starts at 0 K is refused, and one above 0 K is not", () => {
    expect(codes(poly([2, 0, 0, 0], [0, 800]))).toEqual(["E_OUT_OF_RANGE /validRange/min"]);
    expect(codes(poly([2, 0, 0, 0], [1, 800]))).toEqual([]);
  });
  it("a conductivity that reaches exactly zero inside or at the end of the range is refused (it must be positive, not non-negative)", () => {
    // k = 1000 - 2 T + 0.001 T^2 = 0.001 (T - 1000)^2: zero at 1000 K
    expect(codes(poly([1000, -2, 0.001, 0], [500, 1000]))).toEqual(["E_OUT_OF_RANGE "]);
    expect(codes(poly([1000, -2, 0.001, 0], [1000, 1500]))).toEqual(["E_OUT_OF_RANGE "]);
    expect(codes(poly([1000, -2, 0.001, 0], [500, 999]))).toEqual([]);
  });
});

describe("table conductivity edges", () => {
  const line = (n: number) => Array.from({ length: n }, (_, i) => [300 + i, 3 + 0.001 * i]);
  it("a table of exactly the most points is accepted, one more is refused", () => {
    expect(MAX_TABLE_POINTS).toBe(200);
    expect(codes(table(line(200)))).toEqual([]);
    expect(codes(table(line(201)))).toEqual(["E_OUT_OF_RANGE /points"]);
  });
  it("a table of two points is accepted for a line", () => {
    expect(codes(table([[300, 3], [600, 4]]))).toEqual([]);
  });
  it("a point at 0 K is refused", () => {
    expect(codes(table([[0, 3], [300, 3.5], [600, 4]]))).toEqual(["E_OUT_OF_RANGE /points/0/temperature"]);
  });
  it("two points at one temperature are refused as not increasing", () => {
    expect(codes(table([[300, 3], [300, 3.5], [600, 4]]))).toEqual(["E_OUT_OF_RANGE /points/1/temperature"]);
  });
});
