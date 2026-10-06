// The pin as a designer states it (src/core/design.ts, docs/pin-design.md): reading diameters and thicknesses off a case, changing one of them with the
// rest of the design left where a designer expects, in the units the case already uses; and the route the editor calls.
import { AddressInfo } from "net";
import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_FIELDS, DesignField, applyDesign, designOf } from "../src/core/design";
import { fromSI, toSI } from "../src/core/units";
import { validateCase } from "../src/core/validate";
import { check, server } from "../src/server/server";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const pin = () => read("examples/synthetic-pin.json");
const annular = () => read("examples/annular-synthetic-pin.json");
const q = (value: number, unit: string) => ({ value, unit });
const si = (x: unknown) => {
  const r = toSI(x, "length");
  if (!r.ok) throw new Error(r.reason);
  return r.si;
};
const near = (a: number, b: number, rel = 1e-10) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(Math.abs(a), Math.abs(b), 1e-12));
/** The design of a geometry, through the validator (so the case is a real one). */
const designOfGeometry = (geometry: unknown, base = pin()) => {
  const d = { ...base, geometry };
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return designOf(v.normalized!);
};

describe("fromSI", () => {
  it("is the inverse of toSI, without float noise", () => {
    expect(fromSI(0.0041, "mm", "length")).toBe(4.1);
    expect(fromSI(0.0041, "cm", "length")).toBe(0.41);
    expect(fromSI(0.0041, "m", "length")).toBe(0.0041);
    expect(fromSI(573.15, "degC", "temperature")).toBe(300);
    for (const x of [4.1, 0.08, 9.5, 12.7, 0.508]) expect(fromSI(si(q(x, "mm")), "mm", "length")).toBe(x);
  });
  it("refuses a unit that is unknown or of another dimension, and a value that is not a number", () => {
    expect(fromSI(1, "furlong", "length")).toBeUndefined();
    expect(fromSI(1, "K", "length")).toBeUndefined();
    expect(fromSI(NaN, "mm", "length")).toBeUndefined();
    expect(fromSI(Infinity, "mm", "length")).toBeUndefined();
  });
});

describe("designOf: the pin as a designer reads it", () => {
  it("the synthetic pin (4.1 mm fuel radius, cladding 4.18 to 4.75 mm)", () => {
    const d = designOfGeometry(pin().geometry);
    near(d.fuelDiameter, 8.2e-3);
    near(d.fuelInnerDiameter, 0);
    near(d.gap, 0.08e-3);
    near(d.claddingWall, 0.57e-3);
    near(d.claddingInnerDiameter, 8.36e-3);
    near(d.claddingOuterDiameter, 9.5e-3);
    near(d.fuelArea, Math.PI * 4.1e-3 ** 2);
    near(d.claddingArea, Math.PI * (4.75e-3 ** 2 - 4.18e-3 ** 2));
    near(d.wallToDiameter, 0.57 / 9.5);
    near(d.gapToDiameter, 0.08 / 8.2);
  });
  it("a central hole takes its area out of the fuel's", () => {
    const g = annular().geometry;
    const d = designOfGeometry(g, annular());
    near(d.fuelInnerDiameter, 2 * si(g.fuelInnerRadius));
    near(d.fuelArea, Math.PI * (si(g.fuelRadius) ** 2 - si(g.fuelInnerRadius) ** 2));
    expect(d.fuelArea).toBeLessThan(Math.PI * si(g.fuelRadius) ** 2);
  });
  it("the server's check carries it for a steady and a transient case, and the volumetric power it implies is the fuel area's", () => {
    for (const file of ["examples/synthetic-pin.json", "examples/synthetic-pulse.json"]) {
      const j: any = check(read(file));
      expect(j.derived.design.fuelDiameter, file).toBeCloseTo(8.2e-3, 12);
      near(j.derived.volumetricPower, j.normalized.qPrime / j.derived.design.fuelArea);
    }
  });
});

describe("applyDesign: change one dimension, keep what a designer expects to keep", () => {
  const radii = (g: any) => [si(g.fuelRadius), si(g.claddingInnerRadius), si(g.claddingOuterRadius)];

  it("fuel diameter: the gap and the wall stay, so the cladding moves with the fuel", () => {
    const r = applyDesign(pin().geometry, { field: "fuelDiameter", value: q(8.4, "mm") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = designOfGeometry(r.geometry);
    near(d.fuelDiameter, 8.4e-3);
    near(d.gap, 0.08e-3, 1e-9);
    near(d.claddingWall, 0.57e-3, 1e-9);
  });
  it("gap: the wall stays, the outer surface moves with the inner one, the fuel is untouched", () => {
    const r = applyDesign(pin().geometry, { field: "gap", value: q(0.12, "mm") });
    if (!r.ok) throw new Error("refused");
    const d = designOfGeometry(r.geometry);
    near(d.gap, 0.12e-3, 1e-9);
    near(d.claddingWall, 0.57e-3, 1e-9);
    near(d.fuelDiameter, 8.2e-3);
  });
  it("cladding wall: the inner surface stays, the outer one moves", () => {
    const r = applyDesign(pin().geometry, { field: "claddingWall", value: q(0.7, "mm") });
    if (!r.ok) throw new Error("refused");
    const d = designOfGeometry(r.geometry);
    near(d.claddingWall, 0.7e-3, 1e-9);
    near(d.gap, 0.08e-3, 1e-9);
    near(d.claddingInnerDiameter, 8.36e-3);
  });
  it("cladding outer diameter: the inner surface stays, the wall changes", () => {
    const r = applyDesign(pin().geometry, { field: "claddingOuterDiameter", value: q(10, "mm") });
    if (!r.ok) throw new Error("refused");
    const d = designOfGeometry(r.geometry);
    near(d.claddingOuterDiameter, 10e-3);
    near(d.claddingInnerDiameter, 8.36e-3);
    near(d.claddingWall, (10e-3 - 8.36e-3) / 2, 1e-9);
  });
  it("central hole: only the hole moves; 0 is solid fuel again", () => {
    const g = annular().geometry;
    const a = applyDesign(g, { field: "fuelInnerDiameter", value: q(3, "mm") });
    if (!a.ok) throw new Error("refused");
    near(si(a.geometry.fuelInnerRadius), 1.5e-3);
    expect(radii(a.geometry)).toEqual(radii(g));
    const b = applyDesign(g, { field: "fuelInnerDiameter", value: q(0, "mm") });
    if (!b.ok) throw new Error("refused");
    expect(validateCase({ ...annular(), geometry: b.geometry }).errors).toEqual([]);
    expect(designOfGeometry(b.geometry, annular()).fuelArea).toBeCloseTo(Math.PI * si(g.fuelRadius) ** 2, 12);
  });
  it("a hole where there was none is written in the fuel radius's unit", () => {
    const r = applyDesign(pin().geometry, { field: "fuelInnerDiameter", value: q(2, "mm") });
    if (!r.ok) throw new Error("refused");
    expect(r.geometry.fuelInnerRadius).toEqual({ value: 1, unit: "mm" });
  });

  it("every radius is written in the unit it already had, whatever unit the new value is given in", () => {
    const g = pin().geometry;
    g.claddingInnerRadius = q(0.418, "cm");
    g.claddingOuterRadius = q(0.475, "cm");
    const r = applyDesign(g, { field: "fuelDiameter", value: q(0.0084, "m") });
    if (!r.ok) throw new Error("refused");
    expect(r.geometry.fuelRadius!.unit).toBe("mm");
    expect(r.geometry.claddingInnerRadius!.unit).toBe("cm");
    expect(r.geometry.claddingOuterRadius!.unit).toBe("cm");
    expect(r.geometry.fuelRadius!.value).toBe(4.2);
  });

  it("a value that does not change the design changes the radii by nothing: every dimension, solid and annular", () => {
    for (const [g, base] of [[pin().geometry, pin()], [annular().geometry, annular()]] as const) {
      const d = designOfGeometry(g, base);
      const asDiameter: Record<DesignField, number> = { fuelDiameter: d.fuelDiameter, fuelInnerDiameter: d.fuelInnerDiameter, gap: d.gap, claddingWall: d.claddingWall, claddingOuterDiameter: d.claddingOuterDiameter };
      for (const field of DESIGN_FIELDS) {
        if (field === "fuelInnerDiameter" && d.fuelInnerDiameter === 0 && g.fuelInnerRadius === undefined) continue;
        const r = applyDesign(g, { field, value: q(asDiameter[field] * 1e3, "mm") });
        if (!r.ok) throw new Error(field + " refused: " + JSON.stringify(r.errors));
        radii(r.geometry).forEach((x, i) => near(x, radii(g)[i]!, 1e-9));
      }
    }
  });

  it("does not change its input, and keeps every key the geometry carries", () => {
    const g = pin().geometry;
    (g as any).note = "kept";
    const before = JSON.stringify(g);
    const r = applyDesign(g, { field: "gap", value: q(0.1, "mm") });
    expect(JSON.stringify(g)).toBe(before);
    if (!r.ok) throw new Error("refused");
    expect((r.geometry as any).note).toBe("kept");
  });

  it("a result the case validator refuses is still returned (the editor shows the validator's reason): a hole wider than the fuel", () => {
    const r = applyDesign(annular().geometry, { field: "fuelInnerDiameter", value: q(9, "mm") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validateCase({ ...annular(), geometry: r.geometry }).errors.map((e) => e.code)).toContain("E_GEOMETRY");
  });
});

describe("applyDesign refusals", () => {
  const codes = (r: ReturnType<typeof applyDesign>) => (r.ok ? ["ok"] : r.errors.map((e) => e.code + " " + e.field));
  const g = () => pin().geometry;
  it("a value of the wrong sign", () => {
    expect(codes(applyDesign(g(), { field: "fuelDiameter", value: q(0, "mm") }))).toEqual(["E_OUT_OF_RANGE /value"]);
    expect(codes(applyDesign(g(), { field: "fuelDiameter", value: q(-8, "mm") }))).toEqual(["E_OUT_OF_RANGE /value"]);
    expect(codes(applyDesign(g(), { field: "gap", value: q(-0.01, "mm") }))).toEqual(["E_OUT_OF_RANGE /value"]);
    expect(codes(applyDesign(g(), { field: "claddingWall", value: q(0, "mm") }))).toEqual(["E_OUT_OF_RANGE /value"]);
    expect(codes(applyDesign(g(), { field: "claddingOuterDiameter", value: q(-1, "mm") }))).toEqual(["E_OUT_OF_RANGE /value"]);
    expect(codes(applyDesign(annular().geometry, { field: "fuelInnerDiameter", value: q(-1, "mm") }))).toEqual(["E_OUT_OF_RANGE /value"]);
  });
  it("a zero gap is allowed (the validator decides whether the case may have one)", () => {
    expect(applyDesign(g(), { field: "gap", value: q(0, "mm") }).ok).toBe(true);
  });
  it("a value with no unit, a bare number, the wrong dimension, or not finite", () => {
    for (const value of [8.4, { value: 8.4 }, q(8.4, "K"), q(8.4, "furlong"), q(NaN, "mm"), q(Infinity, "mm"), "8 mm", null]) {
      expect(codes(applyDesign(g(), { field: "fuelDiameter", value })), JSON.stringify(value)).toEqual(["E_UNITS /value"]);
    }
  });
  it("an unknown field, a missing field, a geometry that is not one", () => {
    expect(codes(applyDesign(g(), { field: "pitch", value: q(1, "mm") }))).toEqual(["E_SCHEMA_INVALID /field"]);
    expect(codes(applyDesign(g(), { value: q(1, "mm") }))).toEqual(["E_SCHEMA_INVALID /field"]);
    expect(codes(applyDesign(null, { field: "gap", value: q(1, "mm") }))).toEqual(["E_SCHEMA_INVALID /geometry"]);
    expect(codes(applyDesign([], { field: "gap", value: q(1, "mm") }))).toEqual(["E_SCHEMA_INVALID /geometry"]);
    const bare = g();
    (bare as any).fuelRadius = 4.1;
    expect(codes(applyDesign(bare, { field: "gap", value: q(1, "mm") }))).toEqual(["E_UNITS /geometry"]);
    const missing = g();
    delete (missing as any).claddingOuterRadius;
    expect(codes(applyDesign(missing, { field: "gap", value: q(1, "mm") }))).toEqual(["E_UNITS /geometry"]);
  });
  it("a unit the radius is written in that cannot hold the value is not silently changed", () => {
    const odd = g();
    (odd as any).fuelRadius = { value: 4.1, unit: "W/m" };
    expect(codes(applyDesign(odd, { field: "gap", value: q(1, "mm") }))).toEqual(["E_UNITS /geometry"]);
  });
});

describe("the route", () => {
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json", "x-feed-client": "1" }) => fetch(base + "/api/design", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("returns the new geometry (200), or the reasons (400)", async () => {
    const a = await post({ geometry: pin().geometry, field: "gap", value: q(0.1, "mm") });
    expect(a.status).toBe(200);
    const j: any = await a.json();
    expect(j.ok).toBe(true);
    near(si(j.geometry.claddingInnerRadius) - si(j.geometry.fuelRadius), 0.1e-3, 1e-9);
    const b = await post({ geometry: pin().geometry, field: "gap", value: q(-1, "mm") });
    expect(b.status).toBe(400);
    expect(((await b.json()) as any).errors[0].code).toBe("E_OUT_OF_RANGE");
    expect((await post({})).status).toBe(400);
  });
  it("needs the client header and JSON, like every state-changing request", async () => {
    expect((await post({ geometry: pin().geometry, field: "gap", value: q(1, "mm") }, { "content-type": "application/json" })).status).toBe(403);
    expect((await post("x", { "content-type": "text/plain", "x-feed-client": "1" })).status).toBe(415);
    expect((await post("{broken", { "content-type": "application/json", "x-feed-client": "1" })).status).toBe(400);
  });
});
