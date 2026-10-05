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

  it("the K-State film-coefficient pin follows the SAR's own equations 7 and 9 (and is not Table 4.8)", () => {
    const doc = read("examples/ksu-triga-1p25mw-film.json");
    const n = validateCase(doc).normalized!;
    const t = quickLook(n).temperatures;
    const P = 1.25e6; // W
    const h = 0.0326 * P + 16985; // eq. 7, P in watts
    expect(doc.boundary.heatTransferCoefficient.value).toBeCloseTo(h, 6);
    // eq. 9: T = T_pool + 0.423 P [1/h + 3.103e-5 + 3.6196e-4 + 5.1858e-4]
    const eq9 = 293.15 + 0.423 * P * (1 / h + 3.103e-5 + 3.6196e-4 + 5.1858e-4);
    expect(Math.abs(t.centreT - eq9)).toBeLessThan(0.1);
    // Table 4.8 gives 503.2 C; eq. 7 gives about 511 C. The SAR does not reconcile them; this pin must not pretend to.
    expect(t.centreT - 273.15).toBeGreaterThan(509);
    expect(t.centreT - 273.15).toBeLessThan(513);
    expect(doc.description).toMatch(/Source inconsistency/);
  });

  it("the UT hot-channel pin is consistent with the digitized TRACE profile (Figure 4.30), and says what is read", () => {
    const doc = read("examples/ut-triga-hot-channel-trace.json");
    const fig = read("docs/sources/ut-triga-fig-4.30.json") as { xUnit: string; points: { x: number; T_C: number; where?: string }[] };
    const n = validateCase(doc).normalized!;
    const t = quickLook(n).temperatures;
    const C = (k: number) => k - 273.15;
    const at = (w: string) => fig.points.find((p) => p.where === w)!.T_C;
    // the inputs read from the figure are what the case uses
    expect(C(t.claddingOuterT)).toBeCloseTo(at("cladding outer surface"), 1);
    expect(doc.gap.source).toMatch(/READ from SAR Figure 4.30/);
    // the rest is FEED's own conduction, compared with the figure
    expect(Math.abs(C(t.claddingInnerT) - at("cladding inner surface"))).toBeLessThan(8);
    expect(Math.abs(C(t.fuelSurfaceT) - at("fuel surface"))).toBeLessThan(8);
    expect(C(t.centreT) - 562.5).toBeGreaterThan(5); // known: solid cylinder over-predicts
    expect(C(t.centreT) - 562.5).toBeLessThan(25);
    // the figure's fuel profile, fitted as a solid cylinder with k = 18, implies the SAR's own linear heat rate
    const R = 0.018161;
    const fuel = fig.points.filter((p) => !p.where || p.where === "Zr rod / fuel boundary" || p.where === "fuel surface");
    const s = (x: number) => 1 - ((x * 0.0254) / R) ** 2; // x is in inches although the SAR labels it cm
    expect(fig.xUnit).toBe("in");
    const m = fuel.length;
    const sx = fuel.reduce((a, p) => a + s(p.x), 0);
    const sy = fuel.reduce((a, p) => a + p.T_C, 0);
    const sxx = fuel.reduce((a, p) => a + s(p.x) ** 2, 0);
    const sxy = fuel.reduce((a, p) => a + s(p.x) * p.T_C, 0);
    const c = (m * sxy - sx * sy) / (m * sxx - sx * sx);
    const qFit = c * 4 * Math.PI * 18;
    expect(Math.abs(qFit / n.qPrime - 1)).toBeLessThan(0.01);
    expect(Math.abs(n.qPrime / ((24340 / 0.381) * 1.017) - 1)).toBeLessThan(1e-4);
  });

  it("check() returns the profile and derived values for a valid case", () => {
    const r = check(pin) as any;
    expect(r.ok).toBe(true);
    expect(r.profile.length).toBe(82);
    expect(r.derived.volumetricPower).toBeCloseTo(20000 / (Math.PI * 0.0041 ** 2), 0);
  });
});
