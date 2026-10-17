// Plan 14, M1: the library's coating property sets (library/coatings.json), sourced from the PARFUME model basis report (INL/EXT-08-14497) and one measured SiC expansion (Ngoepe and
// de Villiers 2013). Each value is checked against the report's own formula or table, written out here from the report (docs/spike/triso-mechanics-data.md), not from the file; each
// entry is checked to be a set the validator accepts in the layers it claims, and to carry a source and a citation.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { validateCase } from "../src/core/validate";
import { library } from "../src/server/server";

const root = join(__dirname, "..");
const entries: any[] = JSON.parse(readFileSync(join(root, "library", "coatings.json"), "utf8"));
const byId = (id: string) => entries.find((e) => e.id === id)!;
const K = 273.15;
const E = (e: any, T: number) => e.sets["mechanical.elasticity"].a.value + e.sets["mechanical.elasticity"].b.value * T;
const alpha = (e: any, T: number) => {
  const x = e.sets["mechanical.thermalExpansion"].linearExpansion;
  return x.model === undefined ? x.value : x.a.value + x.b.value * T;
};
const rel = (a: number, b: number) => Math.abs(a / b - 1);

describe("the coating library", () => {
  it("is offered by the server's library listing", () => {
    expect((library() as any).coatings.map((e: any) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it("every entry is labelled sourced, names the layers it is for, cites a publication and states a source on each set", () => {
    expect(entries.map((e) => e.id).sort()).toEqual(["buffer-parfume-unirradiated", "pyc-dense-parfume-unirradiated", "sic-parfume-1215-1600", "sic-parfume-25-940", "sic-parfume-25-940-xrd-expansion", "sic-parfume-940-1215"]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const e of entries) {
      expect(e.label, e.id).toBe("sourced");
      expect(e.regions.length, e.id).toBeGreaterThan(0);
      expect(e.citation, e.id).toMatch(/INL\/EXT-08-14497|Ngoepe/);
      expect(e.citation, e.id).toMatch(/Read in/);
      expect(e.description.length, e.id).toBeGreaterThan(100);
      for (const name of ["mechanical.elasticity", "mechanical.thermalExpansion"]) {
        expect(e.sets[name].source, e.id + " " + name).toMatch(/INL\/EXT-08-14497|Ngoepe/);
      }
      // no value was taken from OFFBEAT: no entry mentions it as a source
      expect(JSON.stringify(e), e.id).not.toMatch(/OFFBEAT/i);
    }
  });

  it("every entry is accepted by the validator in each layer it claims (E, nu and alpha in their ranges)", () => {
    const base = JSON.parse(readFileSync(join(root, "schema", "vectors", "good", "triso-mechanics-pressure.json"), "utf8"));
    for (const e of entries) {
      for (const region of e.regions as string[]) {
        const c = JSON.parse(JSON.stringify(base));
        c.geometry.layers = [{ name: "buffer", thickness: { value: 100, unit: "um" } }, { name: "ipyc", thickness: { value: 40, unit: "um" } }];
        delete c.materials.sic;
        delete c.mesh.sicCells;
        // a case with the entry as the inner carbon's sets (the validator reads a layer by the position, so the entry stands in for the carbon when it is another layer's)
        c.materials.ipyc.sets["mechanical.elasticity"] = e.sets["mechanical.elasticity"];
        c.materials.ipyc.sets["mechanical.thermalExpansion"] = e.sets["mechanical.thermalExpansion"];
        c.mechanics.freeStrains = undefined;
        const v = validateCase(JSON.parse(JSON.stringify(c)));
        expect(v.errors, e.id + " as " + region).toEqual([]);
      }
    }
  });

  it("the dense carbon: E = 25.5 GPa x (0.384 + 0.324 x 1.96) x (1 + 0.00015 (T - 20 C)), nu = 0.23, alpha = 5.0e-6 x (1 + 0.11 (T - 400 C)/700) (the report's eqs. 7-2 and 7.2.3.1 at BAF 1, zero fluence)", () => {
    const e = byId("pyc-dense-parfume-unirradiated");
    for (const TC of [600, 800, 1000, 1300]) {
      const T = TC + K;
      expect(rel(E(e, T), 25.5e9 * (0.384 + 0.324 * 1.96) * (1 + 0.00015 * (TC - 20))), "E at " + TC).toBeLessThan(1e-9);
      expect(rel(alpha(e, T), 5.0e-6 * (1 + (0.11 * (TC - 400)) / 700)), "alpha at " + TC).toBeLessThan(1e-9);
    }
    expect(E(e, 20 + K)).toBeCloseTo(25.98552e9, -3);
    expect(e.sets["mechanical.elasticity"].poissonRatio.value).toBe(0.23);
    expect(e.regions).toEqual(["ipyc", "opyc"]);
    // the stated range is the report's own: 600 to 1300 C
    expect(e.sets["mechanical.elasticity"].validRange.min.value).toBeCloseTo(600 + K, 9);
    expect(e.sets["mechanical.elasticity"].validRange.max.value).toBeCloseTo(1300 + K, 9);
  });

  it("the buffer: E = 5e6 psi x exp(-2.03 x 0.56) x (1 + 0.00015 (T - 20 C)) (eq. 7-4, density 1 Mg/m3), nu = 0.23, the carbon's expansion", () => {
    const e = byId("buffer-parfume-unirradiated");
    const psi = 6894.757293168;
    for (const TC of [600, 1000, 1300]) expect(rel(E(e, TC + K), 5e6 * psi * Math.exp(-2.03 * 0.56) * (1 + 0.00015 * (TC - 20)))).toBeLessThan(1e-9);
    expect(E(e, 20 + K) / 1e9).toBeCloseTo(11.062, 2);
    expect(e.sets["mechanical.elasticity"].poissonRatio.value).toBe(0.23);
    for (const TC of [600, 1000]) expect(rel(alpha(e, TC + K), alpha(byId("pyc-dense-parfume-unirradiated"), TC + K))).toBeLessThan(1e-12);
    // the description says that another published value is a factor 1.8 higher: the spread is stated, not hidden
    expect(e.description).toMatch(/20 GPa/);
  });

  it("the SiC modulus is Table 7-1 (427.6, 375.2, 340.0 and 197.9 GPa at 25, 940, 1215 and 1600 C), linear between, as three entries that meet at the table's points", () => {
    const seg = [byId("sic-parfume-25-940"), byId("sic-parfume-940-1215"), byId("sic-parfume-1215-1600")];
    const table: [number, number][] = [[25, 427.6e9], [940, 375.2e9], [1215, 340.0e9], [1600, 197.9e9]];
    seg.forEach((s, i) => {
      expect(rel(E(s, table[i]![0] + K), table[i]![1]), s.id + " start").toBeLessThan(1e-9);
      expect(rel(E(s, table[i + 1]![0] + K), table[i + 1]![1]), s.id + " end").toBeLessThan(1e-9);
      const r = s.sets["mechanical.elasticity"].validRange;
      expect(r.min.value).toBeCloseTo(table[i]![0] + K, 9);
      expect(r.max.value).toBeCloseTo(table[i + 1]![0] + K, 9);
      expect(s.sets["mechanical.elasticity"].poissonRatio.value).toBe(0.13);
      expect(alpha(s, 800)).toBe(4.9e-6);
    });
    // midpoint of the first interval by hand
    expect(rel(E(seg[0]!, (25 + 940) / 2 + K), (427.6e9 + 375.2e9) / 2)).toBeLessThan(1e-9);
  });

  it("the measured SiC expansion: 3.3047e-6 + 2.7705e-9 T(C) per K (25 to 1200 C), 4.7e-6 as a mean over 25 to 1000 C, 4 % below the report's constant 4.9e-6", () => {
    const e = byId("sic-parfume-25-940-xrd-expansion");
    expect(rel(alpha(e, 25 + K), 3.3047e-6 + 2.7705e-9 * 25)).toBeLessThan(1e-9);
    expect(rel(alpha(e, 1000 + K), 3.3047e-6 + 2.7705e-9 * 1000)).toBeLessThan(1e-9);
    const mean = (alpha(e, 25 + K) + alpha(e, 1000 + K)) / 2;
    expect(mean).toBeCloseTo(4.72e-6, 8);
    expect(1 - mean / 4.9e-6).toBeGreaterThan(0.03);
    expect(1 - mean / 4.9e-6).toBeLessThan(0.05);
    expect(e.sets["mechanical.thermalExpansion"].linearExpansion.validRange.max.value).toBeCloseTo(1200 + K, 9);
    // the modulus part is the first segment's
    expect(E(e, 500)).toBe(E(byId("sic-parfume-25-940"), 500));
  });
});
