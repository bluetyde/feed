import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { quickLook } from "../src/core/quickLook";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const codes: Record<string, unknown> = read("schema/error-codes.json");

interface Vector {
  file: string;
  valid: boolean;
  code?: string;
  field?: string;
  warnings?: string[];
}
const vectors: Vector[] = read("schema/vectors/index.json");

describe("case vectors", () => {
  it("lists every file in schema/vectors", () => {
    const { readdirSync } = require("fs") as typeof import("fs");
    const onDisk = ["good", "bad"].flatMap((d) => readdirSync(join(root, "schema/vectors", d)).map((f: string) => d + "/" + f));
    expect(vectors.map((v) => v.file).sort()).toEqual(onDisk.sort());
  });

  for (const v of vectors.filter((x) => x.valid)) {
    it("accepts " + v.file, () => {
      const r = validateCase(read("schema/vectors/" + v.file));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.normalized ?? r.triso).toBeDefined();
      expect(r.warnings.map((w) => w.code)).toEqual(v.warnings ?? []);
    });
  }

  for (const v of vectors.filter((x) => !x.valid)) {
    it("refuses " + v.file + " with " + v.code, () => {
      const r = validateCase(read("schema/vectors/" + v.file));
      expect(r.ok).toBe(false);
      expect(r.normalized).toBeUndefined();
      // The single targeted break yields exactly the expected code at the expected field.
      const hit = r.errors.filter((e) => e.code === v.code);
      expect(hit.length, JSON.stringify(r.errors)).toBeGreaterThan(0);
      if (v.field !== "/") expect(hit.map((e) => e.field)).toContain(v.field);
      expect(r.errors.every((e) => e.code === v.code), JSON.stringify(r.errors)).toBe(true);
    });
  }

  it("has at least one bad vector for every error code", () => {
    const covered = new Set(vectors.filter((v) => !v.valid).map((v) => v.code));
    for (const [code, def] of Object.entries(codes)) {
      if ((def as { severity: string }).severity === "error") expect(covered.has(code), code).toBe(true);
    }
  });

  it("covers every warning code with a good vector", () => {
    const covered = new Set(vectors.flatMap((v) => v.warnings ?? []));
    for (const [code, def] of Object.entries(codes)) {
      if ((def as { severity: string }).severity === "warning") expect(covered.has(code), code).toBe(true);
    }
  });

  it("only emits codes that are declared", () => {
    for (const v of vectors) {
      const r = validateCase(read("schema/vectors/" + v.file));
      for (const i of [...r.errors, ...r.warnings]) expect(Object.keys(codes), i.code).toContain(i.code);
    }
  });
});

describe("validated case", () => {
  const doc = read("examples/synthetic-pin.json");

  it("normalizes to SI", () => {
    const n = validateCase(doc).normalized!;
    expect(n.fuelRadius).toBeCloseTo(0.0041, 12);
    expect(n.claddingInnerRadius).toBeCloseTo(0.00418, 12);
    expect(n.qPrime).toBe(20000);
    expect(n.boundary).toEqual({ kind: "convective", bulkTemperature: 573, heatTransferCoefficient: 30000 });
  });

  it("converts degC and kW/m", () => {
    const n = validateCase(read("schema/vectors/good/surface-temperature.json")).normalized!;
    expect(n.boundary).toEqual({ kind: "surface-temperature", surfaceTemperature: 873.15 });
  });

  it("gives the oracle centre temperature through the quick look", () => {
    const look = quickLook(validateCase(doc).normalized!);
    expect(look.temperatures.centreT).toBeCloseTo(1308.2542, 3);
    expect(look.verdict).toBe("in-domain");
  });

  it("does not modify the document (unknown fields and other apps' sets stay)", () => {
    const d = read("schema/vectors/good/unknown-fields-kept.json");
    const before = JSON.stringify(d);
    expect(validateCase(d).ok).toBe(true);
    expect(JSON.stringify(d)).toBe(before);
    expect(d.futureField).toEqual({ kept: true });
    expect(d.materials.fuel.sets["openmc.composition"]).toBeDefined();
  });

  it("reports several independent problems at once", () => {
    const d = read("examples/synthetic-pin.json");
    d.power.linearHeatRate = { value: 20000 };
    delete d.boundary.heatTransferCoefficient;
    d.mesh.fuelCells = 1;
    expect(validateCase(d).errors.map((e) => e.code).sort()).toEqual(["E_BOUNDARY_INCOMPLETE", "E_MESH", "E_UNITS"]);
  });

  it("is not fooled by a __proto__ unit name", () => {
    const d = read("examples/synthetic-pin.json");
    d.geometry.fuelRadius = { value: 4.1, unit: "__proto__" };
    expect(validateCase(d).errors.map((e) => e.code)).toEqual(["E_UNITS"]);
  });
});
