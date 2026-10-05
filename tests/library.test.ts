import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { check, library } from "../src/server/server";
import { quickLook } from "../src/core/quickLook";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const pin = read("examples/synthetic-pin.json");

describe("library", () => {
  const lib = library();

  it("lists every example pin", () => {
    expect(lib.pins.map((p) => p.id).sort()).toEqual(readdirSync(join(root, "examples")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort());
  });

  for (const p of library().pins) {
    it("pin " + p.id + " is valid and labelled", () => {
      const doc = read("examples/" + p.id + ".json");
      const r = validateCase(doc);
      expect(r.errors).toEqual([]);
      expect(["synthetic", "sourced"]).toContain(doc.label);
      if (doc.label === "sourced") expect(doc.citation, "a sourced pin cites its source").toBeTruthy();
    });
  }

  for (const m of library().materials) {
    it("material " + m.material.materialId + " works in the " + m.region + " slot", () => {
      const doc = JSON.parse(JSON.stringify(pin));
      doc.materials[m.region] = m.material;
      const r = validateCase(doc);
      expect(r.errors).toEqual([]);
      expect(["synthetic", "sourced"]).toContain(m.label);
      if (m.label === "synthetic") expect(m.material.sets["thermal.conductivity"].source).toMatch(/^synthetic/);
    });
  }

  it("sourced entries cite their source", () => {
    for (const m of lib.materials.filter((x: any) => x.label === "sourced")) expect((m as any).citation, m.material.materialId).toMatch(/SAR/);
  });

  it("the K-State hot-element pin reproduces the SAR's Table 4.8 temperatures", () => {
    const n = validateCase(read("examples/ksu-triga-hot-element.json")).normalized!;
    const t = quickLook(n).temperatures;
    const C = (k: number) => k - 273.15;
    // SAR Table 4.8 (C): centreline 503.2, fuel surface 229.0, cladding inner 37.7, cladding outer 21.2
    expect(C(t.claddingOuterT)).toBeCloseTo(21.2, 1);
    expect(Math.abs(C(t.claddingInnerT) - 37.7)).toBeLessThan(0.2);
    expect(Math.abs(C(t.fuelSurfaceT) - 229.0)).toBeLessThan(0.3);
    expect(Math.abs(C(t.centreT) - 503.2)).toBeLessThan(0.5);
  });

  it("check() returns the profile and derived values for a valid case", () => {
    const r = check(pin) as any;
    expect(r.ok).toBe(true);
    expect(r.profile.length).toBe(82);
    expect(r.derived.volumetricPower).toBeCloseTo(20000 / (Math.PI * 0.0041 ** 2), 0);
  });
});
