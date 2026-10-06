import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { check, library } from "../src/server/server";
import { annulusShape } from "../src/core/closedForm";
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

  describe("presets that can run a pulse", () => {
    const withHc = lib.materials.filter((x: any) => x.material.sets["thermal.volumetricHeatCapacity"]);
    const ut = read("examples/ut-triga-pulse-4p40.json");
    /** The law without its prose: the numbers and units must be the example's, the wording of the source may differ. */
    const numbers = ({ source: _s, ...rest }: any) => rest;

    it("the TRIGA fuel and the stainless-steel cladding presets carry the SAR heat capacities (the very sets the UT-Austin pulse example uses)", () => {
      const fuel = lib.materials.find((x: any) => x.material.materialId === "triga-uzrh-h16")!.material.sets as any;
      expect(numbers(fuel["thermal.volumetricHeatCapacity"])).toEqual(numbers(ut.materials.fuel.sets["thermal.volumetricHeatCapacity"]));
      for (const id of ["ss304-k166", "ss304-ktemp"]) {
        const clad = lib.materials.find((x: any) => x.material.materialId === id)!.material.sets as any;
        expect(numbers(clad["thermal.volumetricHeatCapacity"])).toEqual(numbers(ut.materials.cladding.sets["thermal.volumetricHeatCapacity"]));
      }
    });

    it("adding the set made a new revision and left the conductivity as it was", () => {
      const byId = (id: string) => lib.materials.find((x: any) => x.material.materialId === id)!.material;
      expect(byId("triga-uzrh-h16").revision).toBe(2);
      expect((byId("triga-uzrh-h16").sets as any)["thermal.conductivity"].value).toEqual({ value: 18, unit: "W/m/K" });
      expect((byId("ss304-k166").sets as any)["thermal.conductivity"].value).toEqual({ value: 16.6, unit: "W/m/K" });
      for (const x of withHc) if (x.material.materialId !== "ss304-ktable") expect(x.material.revision, x.material.materialId).toBeGreaterThanOrEqual(2); // ss304-ktable was born with its heat capacity
    });

    it("every heat capacity in the library has a stated source, and a sourced material's names a SAR or says it is assumed", () => {
      expect(withHc.length).toBe(6);
      for (const x of withHc) {
        const hc = x.material.sets["thermal.volumetricHeatCapacity"] as any;
        expect(hc.source, x.material.materialId).toBeTruthy();
        if (x.label === "sourced") expect(hc.source, x.material.materialId).toMatch(/SAR/);
        else expect(hc.source, x.material.materialId).toMatch(/^synthetic/);
      }
      // the one thing the SAR does not state is said, not hidden
      expect((lib.materials.find((x: any) => x.material.materialId === "triga-uzrh-h16")!.material.sets as any)["thermal.volumetricHeatCapacity"].source).toMatch(/states no validity range; 0 to 1000 C is assumed/);
    });

    it("a library fuel and a library cladding run a pulse as they are: the pulse case validates with both swapped in", () => {
      for (const fuel of withHc.filter((x: any) => x.region === "fuel")) {
        for (const clad of withHc.filter((x: any) => x.region === "cladding")) {
          const doc = read("examples/synthetic-pulse.json");
          doc.materials.fuel = fuel.material;
          doc.materials.cladding = clad.material;
          expect(validateCase(doc).errors, fuel.material.materialId + " + " + clad.material.materialId).toEqual([]);
        }
      }
    });

    it("a preset without a heat capacity still refuses a pulse and names what is missing", () => {
      const doc = read("examples/synthetic-pulse.json");
      doc.materials.cladding = lib.materials.find((x: any) => x.material.materialId === "zry-clad-like")!.material;
      const e = validateCase(doc).errors;
      expect(e.map((x) => x.code + " " + x.field)).toEqual(["E_PROP_MISSING /materials/cladding/sets/thermal.volumetricHeatCapacity"]);
    });
  });

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

  it("UT hot channel with the zirconium rod: the figure lies between the solid and annular models, and its shape favours the annulus", () => {
    const fig = read("docs/sources/ut-triga-fig-4.30.json") as { points: { x: number; T_C: number; where?: string }[] };
    const solidT = quickLook(validateCase(read("examples/ut-triga-hot-channel-trace.json")).normalized!).temperatures.centreT - 273.15;
    const doc = read("examples/ut-triga-hot-channel-annular.json");
    const n = validateCase(doc).normalized!;
    const annT = quickLook(n).temperatures.centreT - 273.15;
    expect(doc.geometry.fuelInnerRadius.value).toBe(3.175); // the 6.35 mm zirconium fill rod
    expect(solidT).toBeGreaterThan(562.5);
    expect(annT).toBeLessThan(562.5);
    expect(annT).toBeGreaterThan(540);
    // least-squares fit of the digitized fuel profile (inches, though the SAR labels cm) to each shape, k = 18 W/m/K:
    // T = Ts + c shape(r); c = q'/(4 pi k)
    const R = 0.018161;
    const ri = 0.003175;
    const pts = fig.points.filter((p) => !p.where || p.where === "Zr rod / fuel boundary" || p.where === "fuel surface");
    const fit = (shape: (r: number) => number) => {
      const m = pts.length;
      const s = pts.map((p) => shape(p.x * 0.0254));
      const sx = s.reduce((a, b) => a + b, 0);
      const sy = pts.reduce((a, p) => a + p.T_C, 0);
      const sxx = s.reduce((a, b) => a + b * b, 0);
      const sxy = pts.reduce((a, p, i) => a + s[i]! * p.T_C, 0);
      const c = (m * sxy - sx * sy) / (m * sxx - sx * sx);
      const ts = (sy - c * sx) / m;
      const rms = Math.sqrt(pts.reduce((a, p, i) => a + (ts + c * s[i]! - p.T_C) ** 2, 0) / m);
      return { c, rms };
    };
    const solidFit = fit((r) => annulusShape(r, R, 0));
    const annFit = fit((r) => annulusShape(r, R, ri));
    expect(annFit.rms).toBeLessThan(solidFit.rms); // the figure's curvature near the rod is the annulus's
    // with the SAR's power, the annular fit asks for an effective conductivity of about 17 W/m/K instead of 18
    const kEff = n.qPrime / (4 * Math.PI * annFit.c);
    expect(kEff).toBeGreaterThan(16.5);
    expect(kEff).toBeLessThan(17.5);
  });

  it("check() returns the profile and derived values for a valid case", () => {
    const r = check(pin) as any;
    expect(r.ok).toBe(true);
    expect(r.profile.length).toBe(82);
    expect(r.derived.volumetricPower).toBeCloseTo(20000 / (Math.PI * 0.0041 ** 2), 0);
  });
});
