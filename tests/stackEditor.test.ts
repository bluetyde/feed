// Plan 12, A6: the editor's Stack item, the pin/plate choice and the per-slice results view. The page itself was driven in the browser pane (see the plan record); here: what the check
// response gives the page, the page's own pure helpers run without a page (the shape conversion and the defaults it writes into a case, which the validator must accept), and the page's wiring.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { STACK_TEXT } from "../src/core/stackResults";
import { validateCase } from "../src/core/validate";
import { check } from "../src/server/server";

const root = join(__dirname, "..");
const read = (id: string) => JSON.parse(readFileSync(join(root, "examples", id + ".json"), "utf8"));
const html = readFileSync(join(root, "src/web/index.html"), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
const q = (value: number, unit: string) => ({ value, unit });

/** The page's pure helpers (between the markers), run against a document and a log the test owns. */
function pure(doc: any) {
  const block = script.slice(script.indexOf("/* pure:begin"), script.indexOf("/* pure:end */"));
  const state = { logText: "" };
  const make = new Function("doc", "state", "let logText = state.logText; " + block + "; return { isPlate, convertGeometry, defaultStack, defaultShapeTable, defaultCoolantTable, log: () => logText };");
  return make(doc, state) as { isPlate(): boolean; convertGeometry(to: string): void; defaultStack(): any; defaultShapeTable(a: any): any; defaultCoolantTable(a: any, b: any, form: string): any[]; log(): string };
}

describe("the check response for a stack", () => {
  it("carries the per-slice summary and the words that go with it, and neither for a single slice", () => {
    const d = read("synthetic-pin");
    d.axial = { length: q(0.381, "m"), slices: 10, powerShape: { kind: "cosine" } };
    const r: any = check(d);
    expect(r.ok).toBe(true);
    expect(r.axial.slices).toHaveLength(10);
    expect(r.axial.hottest).toBeGreaterThanOrEqual(0);
    expect(r.axialNote).toBe(STACK_TEXT);
    expect(r.axial.slices[0].boundary.kind).toBe("convective");
    const single: any = check(read("synthetic-pin"));
    expect(single.axial).toBeUndefined();
    expect(single.axialNote).toBeUndefined();
  });
  it("carries them for a transient on a stack too", () => {
    const d = read("synthetic-coastdown");
    d.axial = { length: q(0.381, "m"), slices: 8, powerShape: { kind: "cosine" } };
    const r: any = check(d);
    expect(r.ok).toBe(true);
    expect(r.transient).toBeTruthy();
    expect(r.axial.slices).toHaveLength(8);
    expect(r.axialNote).toBe(STACK_TEXT);
  });
});

describe("the page's helpers, run without a page", () => {
  it("turns a pin into a plate and back without changing a dimension, whatever units the lengths are in, and drops what a plate cannot have", () => {
    const d = read("synthetic-pin");
    d.geometry = { fuelRadius: q(0.41, "cm"), claddingInnerRadius: q(4.18, "mm"), claddingOuterRadius: q(0.00475, "m"), fuelInnerRadius: q(1, "mm") };
    d.hotDimensions = { referenceTemperature: q(20, "degC") };
    d.burnup = { value: q(10, "MWd/kgHM") };
    const h = pure(d);
    expect(h.isPlate()).toBe(false);
    h.convertGeometry("plate");
    expect(h.isPlate()).toBe(true);
    expect(d.assumptions.geometry).toBe("1D-slab");
    expect(Object.keys(d.geometry).sort()).toEqual(["claddingThickness", "fuelHalfThickness", "gapThickness", "kind"]);
    expect(d.geometry.fuelHalfThickness).toEqual(q(0.41, "cm"));
    expect(d.geometry.gapThickness.unit).toBe("mm");
    expect(d.geometry.gapThickness.value).toBeCloseTo(0.08, 9);
    expect(d.geometry.claddingThickness.value).toBeCloseTo(0.57, 9);
    expect(d.hotDimensions).toBeUndefined();
    expect(d.burnup).toBeUndefined();
    expect(h.log()).toContain("removed the central hole, hotDimensions, burnup");
    h.convertGeometry("pin");
    expect(h.isPlate()).toBe(false);
    expect(d.assumptions.geometry).toBe("1D-radial");
    expect(d.geometry.kind).toBeUndefined();
    expect(Object.keys(d.geometry).sort()).toEqual(["claddingInnerRadius", "claddingOuterRadius", "fuelRadius"]);
    const v = validateCase(d);
    expect(v.errors.map((e) => e.code + " " + e.field)).not.toContain("E_GEOMETRY /geometry/claddingInnerRadius");
    const n = v.normalized!;
    expect(n.fuelRadius).toBeCloseTo(4.1e-3, 12);
    expect(n.claddingInnerRadius).toBeCloseTo(4.18e-3, 12);
    expect(n.claddingOuterRadius).toBeCloseTo(4.75e-3, 12);
  });
  it("gives a valid plate from the synthetic pin, which is a plate for the validator and one slice for the stack", () => {
    const d = read("synthetic-pin");
    pure(d).convertGeometry("plate");
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.plate).toBe(true);
    expect(v.normalized!.claddingOuterRadius).toBeCloseTo(4.75e-3, 12);
  });
  it("removes the mechanics section and the thermal-only flag of a case that is made a plate, and a point-kinetics pulse", () => {
    const d = read("synthetic-pulse-kinetics");
    d.mechanics = { referenceTemperature: q(293.15, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0, "Pa") };
    d.assumptions.thermalOnly = false;
    const h = pure(d);
    h.convertGeometry("plate");
    expect(d.mechanics).toBeUndefined();
    expect(d.assumptions.thermalOnly).toBe(true);
    expect(d.transient.pointKinetics).toBeUndefined();
    expect(h.log()).toContain("the point-kinetics pulse");
  });
  it("writes defaults the validator accepts: a stack, a table shape and a coolant table, in the units of the length the person chose", () => {
    for (const unit of ["m", "cm", "mm"]) {
      const d = read("synthetic-pin");
      const h = pure(d);
      d.axial = h.defaultStack();
      d.axial.length = q(unit === "m" ? 0.381 : unit === "cm" ? 38.1 : 381, unit);
      expect(validateCase(d).errors).toEqual([]);
      d.axial.powerShape = h.defaultShapeTable(d.axial);
      expect(d.axial.powerShape.points.map((p: any) => p.position.unit)).toEqual([unit, unit, unit]);
      expect(validateCase(d).errors).toEqual([]);
      d.axial.boundary = h.defaultCoolantTable(d.axial, d.boundary, "convective");
      expect(d.axial.boundary).toHaveLength(2);
      expect(d.axial.boundary[0].height.value).toBe(0);
      expect(d.axial.boundary[1].height).toEqual(d.axial.length);
      const v = validateCase(d);
      expect(v.errors).toEqual([]);
      // the table copies the case's own boundary: every slice sees the same coolant as without the table
      const n = v.normalized!;
      expect(n.axial!.boundary!.kind).toBe("convective");
    }
  });
  it("writes a coolant table in the form of a prescribed wall too, and refuses nothing the page lets the person do with it", () => {
    const d = read("synthetic-pin");
    delete d.boundary.bulkTemperature;
    delete d.boundary.heatTransferCoefficient;
    d.boundary.surfaceTemperature = q(600, "K");
    const h = pure(d);
    d.axial = h.defaultStack();
    d.axial.boundary = h.defaultCoolantTable(d.axial, d.boundary, "surface");
    expect(Object.keys(d.axial.boundary[0]).sort()).toEqual(["height", "surfaceTemperature"]);
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.normalized!.axial!.boundary!.kind).toBe("surface-temperature");
  });
});

describe("the page's wiring", () => {
  it("has the page script parse, the Stack item routed to /axial, and the plate and stack views", () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script).toMatch(/\["axial", "Stack", "Pin", \["\/axial"\]\]/);
    expect(script).toMatch(/selected === "axial"\) \{\s*stackPanel\(p\);/);
    expect(script).toMatch(/function stackPanel\(p\)/);
    expect(script).toMatch(/function drawStackSummary\(\)/);
    expect(script).toMatch(/function drawStackResults\(d\)/);
    expect(script).toMatch(/function drawSlab\(x, w, h, n\)/);
    expect(script).toMatch(/if \(n\.plate\) \{ x\.save\(\); drawSlab\(x, w, h, n\)/);
    expect(script).toMatch(/id: "gshape"/);
    expect(script).toMatch(/"Plate dimensions"/);
    expect(script).toMatch(/not for a plate/);
    expect(html).toMatch(/id="raxWrap"/);
    expect(html).toMatch(/id="raxTable"/);
    expect(html).toMatch(/#docResults>\.metrics/);
  });
  it("drops the coolant table when the coolant form changes, labels the power as an average with a stack, and shows the banner of the stack", () => {
    expect(script).toMatch(/if \(doc\.axial && doc\.axial\.boundary\) \{ delete doc\.axial\.boundary; logText \+= "The coolant table along the height was removed/);
    expect(script).toMatch(/doc\.axial \? "q′ average" : "q′"/);
    expect(script).toMatch(/result\.axialNote\) \$\("caseBanner"\)\.textContent = result\.axialNote/);
    expect(script).toMatch(/card\("Hottest slice"/);
    expect(script).toMatch(/With a stack the history is the <b>average<\/b>/);
  });
  it("does not offer pin-only panels for a plate and leaves the pin's panels as they were", () => {
    expect(script).toMatch(/if \(isPlate\(\)\) p\.append\(plateOnlyNote\("Burnup"\)\); else burnupPanel\(p\)/);
    expect(script).toMatch(/if \(isPlate\(\)\) p\.append\(plateOnlyNote\("Hot dimensions"\)\); else hotPanel\(p\)/);
    expect(script).toMatch(/if \(isPlate\(\)\) p\.append\(plateOnlyNote\("Mechanics"\)\); else mechanicsPanel\(p\)/);
    expect(script).toMatch(/qField\("Fuel radius", \["geometry", "fuelRadius"\], "length"\)/);
  });
});
