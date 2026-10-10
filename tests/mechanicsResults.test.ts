// The mechanics half of a result, read back from the REAL fields OFFBEAT wrote for FEED's own elastic case (tests/golden/offbeat-mechanics: the synthetic pin at 20 kW/m,
// E = 200 GPa, nu = 0.3, alpha = 1e-5 for both solids, reference 300 K, free axial strain, no coolant pressure, penalty factor 0.3; T C D sigma sigmaCyl gapWidth interfaceP of
// the last time), the banner text, the order of the points, and what a missing or damaged field does. The numbers expected are those OFFBEAT printed for the first cells.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { MECHANICS_TEXT } from "../src/core/mechanicsResults";
import { ResultsError, buildResults } from "../src/core/resultsParser";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const g = (f: string) => readFileSync(join(root, "tests/golden/offbeat-mechanics", f), "utf8");
const q = (value: number, unit: string) => ({ value, unit });
const sets = {
  "mechanical.elasticity": { model: "constant", youngModulus: q(200, "GPa"), poissonRatio: q(0.3, "1"), source: "a test" },
  "mechanical.thermalExpansion": { linearExpansion: q(10, "ppm/K"), source: "a test" },
};
function normalized() {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.power.linearHeatRate = q(20, "kW/m");
  d.assumptions.thermalOnly = false;
  Object.assign(d.materials.fuel.sets, sets);
  Object.assign(d.materials.cladding.sets, sets);
  d.mechanics = { referenceTemperature: q(300, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.3, "1") }, coolantPressure: q(0, "Pa") };
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
}
const fields = () => ({ D: g("D"), sigma: g("sigma"), sigmaCyl: g("sigmaCyl"), gapWidth: g("gapWidth"), interfaceP: g("interfaceP") });
const build = (mech: Record<string, string | undefined> = fields()) => buildResults(normalized(), { T: g("T"), C: g("C"), time: 5e7, mechanics: mech });
const vm = (r: number, t: number, z: number) => Math.sqrt(0.5 * ((r - t) ** 2 + (t - z) ** 2 + (z - r) ** 2));

describe("a thermo-elastic result from real OFFBEAT fields", () => {
  const r = build();
  const m = r.mechanics!;
  it("carries the mechanics record, the banner and a passing fields check", () => {
    expect(m.kind).toBe("thermo-elastic");
    expect(r.thermalOnly).toBe(MECHANICS_TEXT);
    expect(r.thermalOnly).toMatch(/^Thermo-elastic result/);
    expect(r.thermalOnly).toMatch(/does not say that anything fails or holds/);
    expect(r.checks.find((c) => c.id === "mechanicsFields")).toMatchObject({ verdict: "pass" });
    expect(r.checks.filter((c) => c.verdict !== "pass").map((c) => c.id)).toEqual([]);
  });
  it("has one point for each cell, in the order of the radial profile (fuel, then cladding, by radius)", () => {
    expect(m.points).toHaveLength(r.radial.length);
    const fuelN = r.radial.filter((p) => p.region === "fuel").length;
    // the first fuel cell is the one nearest the axis: its radial stress is the one OFFBEAT printed for the first cell
    expect(m.points[0]!.sigmaR).toBeCloseTo(-380612550, -2);
    expect(m.points[0]!.sigmaTheta).toBeCloseTo(-379533060, -2);
    expect(m.points[0]!.sigmaZ).toBeCloseTo(-755462280, -2);
    expect(m.points[1]!.sigmaR).toBeCloseTo(-377733930, -2);
    expect(m.points[0]!.ur).toBeCloseTo(1.3489867e-6, 14);
    expect(m.points[0]!.uz).toBeCloseTo(0.0074271259, 10);
    expect(fuelN).toBeGreaterThan(5);
    expect(r.radial[fuelN]!.region).toBe("cladding");
  });
  it("the equivalent stress is von Mises of the three normal components", () => {
    const p = m.points[0]!;
    expect(p.sigmaEq).toBeCloseTo(vm(p.sigmaR, p.sigmaTheta, p.sigmaZ), 3);
    expect(p.sigmaEq).toBeCloseTo(vm(-380612550, -379533060, -755462280), -2);
  });
  it("the summary: the solids are not in contact (the gap is 62.5 microns), the outer displacement of each solid, the ranges", () => {
    expect(m.summary.contact).toBe(false);
    expect(m.summary.gapWidth! * 1e6).toBeCloseTo(62.455894, 4);
    expect(m.summary.contactPressure).toBe(0);
    // the fuel's outer surface moves by about alpha x (its mean strain temperature rise) x 4.1 mm = 3e-5 m; the cladding's outer surface by 1.45e-5 m (OFFBEAT's last cell)
    expect(m.summary.fuel.outerDisplacement).toBeGreaterThan(2.9e-5);
    expect(m.summary.fuel.outerDisplacement).toBeLessThan(3.1e-5);
    expect(m.summary.cladding.outerDisplacement).toBeCloseTo(1.4508539e-5, 12);
    expect(m.summary.fuel.radial[0]).toBeLessThan(m.summary.fuel.radial[1]);
    expect(m.summary.fuel.maxEquivalent).toBe(Math.max(...m.points.slice(0, r.radial.filter((p) => p.region === "fuel").length).map((p) => p.sigmaEq)));
  });
  it("carries the constants OFFBEAT was given, the reference temperature, the penalty factor and the pressure", () => {
    expect(m.properties.fuel.E).toBeCloseTo(2e11, 0);
    expect(m.properties.fuel.G).toBeCloseTo(2e11 / 2.6, 0);
    expect(m.properties.fuel.alpha).toBeCloseTo(1e-5, 15);
    expect(m.referenceTemperature).toBe(300);
    expect(m.penaltyFactor).toBeCloseTo(0.3, 12);
    expect(m.coolantPressure).toBe(0);
    expect(m.plane).toBe("free-axial");
  });
  it("sigma is read when sigmaCyl is not there", () => {
    const f = fields();
    const r2 = build({ ...f, sigmaCyl: undefined });
    expect(r2.mechanics!.points[0]!.sigmaR).toBeCloseTo(-380612550, -2);
    expect(r2.checks.find((c) => c.id === "mechanicsFields")!.note).toMatch(/sigma hold/);
  });
});

describe("the contact is read from the gap width and the interface pressure", () => {
  /** The gapWidth or interfaceP file with the value of the fuelOuter patch replaced. */
  const withPatch = (text: string, v: string) => text.replace(/(fuelOuter\s*\{[^}]*?value\s+)uniform\s+[^;]+;/, "$1uniform " + v + ";");
  it("the golden values are a gap and no pressure: no contact", () => {
    expect(build().mechanics!.summary).toMatchObject({ contact: false, contactPressure: 0 });
  });
  it("a gap of zero or less is contact, even with no pressure written", () => {
    expect(build({ ...fields(), gapWidth: withPatch(g("gapWidth"), "-1e-6") }).mechanics!.summary).toMatchObject({ contact: true, gapWidth: -1e-6 });
    expect(build({ ...fields(), gapWidth: withPatch(g("gapWidth"), "0") }).mechanics!.summary.contact).toBe(true);
    expect(build({ ...fields(), gapWidth: withPatch(g("gapWidth"), "1e-9") }).mechanics!.summary.contact).toBe(false);
  });
  it("a positive interface pressure is contact, whatever the gap width reads", () => {
    const s = build({ ...fields(), interfaceP: withPatch(g("interfaceP"), "5e6") }).mechanics!.summary;
    expect(s).toMatchObject({ contact: true, contactPressure: 5e6 });
    expect(s.gapWidth).toBeGreaterThan(0);
    expect(build({ ...fields(), interfaceP: withPatch(g("interfaceP"), "1") }).mechanics!.summary.contact).toBe(true);
  });
});

describe("the points follow the radial profile whatever order the solver wrote its cells in", () => {
  /** The same field with its entries in another order: the list is one entry per line between the "(" line after the count and the closing ")" line. */
  const reorder = (text: string, perm: number[]) => {
    const lines = text.split("\n");
    const open = lines.findIndex((l, i) => /^\d+$/.test(l.trim()) && lines[i + 1] === "(");
    const n = Number(lines[open]!.trim());
    const rows = lines.slice(open + 2, open + 2 + n);
    return [...lines.slice(0, open + 2), ...perm.map((i) => rows[i]!), ...lines.slice(open + 2 + n)].join("\n");
  };
  it("a permutation of every field leaves the record as it was", () => {
    const same = build();
    const count = same.radial.length;
    expect(count).toBeGreaterThan(5);
    const perm = Array.from({ length: count }, (_, i) => (i * 7 + 3) % count);
    expect(new Set(perm).size).toBe(count); // a permutation when 7 and the count are coprime
    const permuted = buildResults(normalized(), {
      T: reorder(g("T"), perm),
      C: reorder(g("C"), perm),
      time: 5e7,
      mechanics: { D: reorder(g("D"), perm), sigma: reorder(g("sigma"), perm), sigmaCyl: reorder(g("sigmaCyl"), perm), gapWidth: g("gapWidth"), interfaceP: g("interfaceP") },
    });
    expect(permuted.radial).toEqual(same.radial);
    expect(permuted.mechanics!.points).toEqual(same.mechanics!.points);
  });
});

describe("a missing or damaged field is a failed check and no record, never a pass", () => {
  const failed = (mech: Record<string, string | undefined>) => {
    const r = build(mech);
    expect(r.mechanics).toBeUndefined();
    const c = r.checks.find((x) => x.id === "mechanicsFields")!;
    expect(c.verdict).toBe("fail");
    return c.note;
  };
  it("no displacement field", () => expect(failed({ ...fields(), D: undefined })).toMatch(/no displacement field D/));
  it("no stress field at all", () => expect(failed({ ...fields(), sigma: undefined, sigmaCyl: undefined })).toMatch(/no stress field/));
  it("no mechanics fields at all", () => {
    const r = buildResults(normalized(), { T: g("T"), C: g("C"), time: 5e7 });
    expect(r.mechanics).toBeUndefined();
    expect(r.checks.find((c) => c.id === "mechanicsFields")!.verdict).toBe("fail");
  });
  it("a list of the wrong length", () => {
    const D = g("D");
    const cut = D.replace(/\n\(\s*[-\d.e+]+ [-\d.e+]+ [-\d.e+]+\)\n/, "\n"); // one row less than the header says
    expect(failed({ ...fields(), D: cut })).toMatch(/header says/);
  });
  it("a value that is not a finite number", () => {
    const first = /\n\((-?[\d.]+(?:e[-+]?\d+)?) /;
    expect(first.test(g("sigmaCyl"))).toBe(true);
    expect(failed({ ...fields(), sigmaCyl: g("sigmaCyl").replace(first, "\n(nan ") })).toMatch(/not 6 finite numbers/);
  });
  it("a list with a different number of cells from the case's (a consistent header and rows)", () => {
    const lines = g("D").split("\n");
    const open = lines.findIndex((l, i) => /^\d+$/.test(l.trim()) && lines[i + 1] === "(");
    const n = Number(lines[open]!.trim());
    const shorter = [...lines.slice(0, open), String(n - 1), "(", ...lines.slice(open + 2, open + 2 + n - 1), ...lines.slice(open + 2 + n)].join("\n");
    expect(failed({ ...fields(), D: shorter })).toMatch(new RegExp(`field D has ${n - 1} cells, the case has ${n}`));
  });
  it("a list that is cut short", () => {
    const D = g("D");
    expect(failed({ ...fields(), D: D.slice(0, D.indexOf("\n)") - 5) })).toMatch(/not closed|header says/);
  });
  it("the thermal part of the result is still checked when the mechanics fields are damaged (a bad T is refused as before)", () => {
    expect(() => buildResults(normalized(), { T: g("T").slice(0, 600), C: g("C"), time: 5e7, mechanics: fields() })).toThrow(ResultsError);
  });
});

describe("a case without mechanics is unchanged", () => {
  it("the thermal banner, no mechanics record, no mechanics check", () => {
    const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
    const v = validateCase(d);
    expect(v.normalized!.mechanics).toBeUndefined();
    const r = buildResults(v.normalized!, { T: g("T"), C: g("C"), time: 5e7 });
    expect(r.mechanics).toBeUndefined();
    expect(r.thermalOnly).toMatch(/^Thermal-only result/);
    expect(r.checks.find((c) => c.id === "mechanicsFields")).toBeUndefined();
  });
});
