// Annular fuel: a central hole with an insulated surface (TRIGA's zirconium fill rod). Closed form, validation, case writer,
// results parser on real OFFBEAT output, and (gated) a real solver run. The independent reference numbers come from
// oracles/annulus-reference.py (numerical integration), not from src/core.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { annulusCentreFactor, annulusShape } from "../src/core/closedForm";
import { quickLook, radialProfile } from "../src/core/quickLook";
import { buildResults, ResultsError } from "../src/core/resultsParser";
import { RunManager } from "../src/core/runManager";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const text = (p: string) => readFileSync(join(root, p), "utf8");
const annular = () => validateCase(read("examples/annular-synthetic-pin.json")).normalized!;
const solid = () => validateCase(read("examples/synthetic-pin.json")).normalized!;

describe("annulus closed form", () => {
  const R = 0.0041;
  const ri = 0.001;

  it("is zero at the surface and 1 - r^2/R^2 for solid fuel", () => {
    expect(annulusShape(R, R, ri)).toBeCloseTo(0, 12);
    expect(annulusShape(0.002, R, 0)).toBeCloseTo(1 - (0.002 / R) ** 2, 12);
    expect(annulusCentreFactor(0, R)).toBe(1);
  });

  it("tends to the solid-fuel rise as the hole vanishes, and falls as the hole grows", () => {
    expect(annulusCentreFactor(1e-9, R)).toBeCloseTo(1, 6);
    let prev = 1;
    for (const f of [0.05, 0.1, 0.2, 0.4, 0.6, 0.9]) {
      const c = annulusCentreFactor(f * R, R);
      expect(c).toBeLessThan(prev);
      expect(c).toBeGreaterThan(0);
      prev = c;
    }
  });

  it("has no heat flow across the hole and the right heat flow elsewhere (checked by finite differences)", () => {
    // flux through radius r per unit length = -2 pi r k dT/dr; with T = Ts + q' shape / (4 pi k) it is -q' r shape'(r) / 2, which must be
    // q' (r^2 - ri^2) / (R^2 - ri^2): zero at ri, q' at R.
    const d = (r: number) => (annulusShape(r + 1e-9, R, ri) - annulusShape(r - 1e-9, R, ri)) / 2e-9;
    const flux = (r: number) => (-r * d(r)) / 2; // in units of q'
    for (const r of [0.0012, 0.002, 0.003, 0.004]) expect(flux(r)).toBeCloseTo((r * r - ri * ri) / (R * R - ri * ri), 6);
    expect(Math.abs(flux(ri + 1e-8))).toBeLessThan(1e-4);
  });

  it("matches the independent numerical integration (oracles/annulus-reference.py)", () => {
    const q = 20000;
    const k = 3;
    expect((q / (4 * Math.PI * k)) * annulusCentreFactor(ri, R)).toBeCloseTo(435.823, 3);
    expect(((64970.5512 / (4 * Math.PI * 18)) * annulusCentreFactor(0.003175, 0.018161))).toBeCloseTo(255.6471, 3);
  });
});

describe("annular fuel in the case", () => {
  it("validates and normalizes the hole radius to metres; 0 means solid; absent means solid", () => {
    expect(annular().fuelInnerRadius).toBeCloseTo(0.001, 12);
    expect(solid().fuelInnerRadius).toBe(0);
    const zero = read("examples/synthetic-pin.json");
    zero.geometry.fuelInnerRadius = { value: 0, unit: "mm" };
    expect(validateCase(zero).normalized!.fuelInnerRadius).toBe(0);
  });

  it("refuses a hole that is too big, too negative or in the wrong unit, each with its code", () => {
    const code = (v: unknown) => {
      const d = read("examples/synthetic-pin.json");
      d.geometry.fuelInnerRadius = v;
      return validateCase(d).errors[0]?.code;
    };
    expect(code({ value: 4.1, unit: "mm" })).toBe("E_GEOMETRY");
    expect(code({ value: 5, unit: "mm" })).toBe("E_GEOMETRY");
    expect(code({ value: 3.9, unit: "mm" })).toBe("E_GEOMETRY");
    expect(code({ value: -1, unit: "mm" })).toBe("E_GEOMETRY");
    expect(code({ value: 1, unit: "inch" })).toBe("E_UNITS");
    expect(code(0.001)).toBe("E_UNITS");
  });

  it("quick look: the hottest point is the hole surface, 1213.5607 K for the synthetic annular pin, and the profile starts there", () => {
    const n = annular();
    const look = quickLook(n);
    expect(look.temperatures.centreT).toBeCloseTo(1213.5607, 3); // independent reference
    expect(look.temperatures.fuelDeltaT).toBeCloseTo(435.823, 3);
    const p = radialProfile(n, look);
    expect(p[0]!.r).toBeCloseTo(0.001, 12);
    expect(p[0]!.T).toBeCloseTo(look.temperatures.centreT, 6);
    expect(p[0]!.T).toBeGreaterThan(p[10]!.T); // monotone outward
  });

  it("a solid pin is unchanged by the feature", () => {
    expect(quickLook(solid()).temperatures.centreT).toBeCloseTo(1308.2542 - 0.0001, 3);
  });
});

describe("annular fuel in the OFFBEAT case files", () => {
  const files = () => writeOffbeatCase(annular()).files;

  it("solid cases get no hole patch and no hole conditions", () => {
    const f = writeOffbeatCase(solid()).files;
    for (const name of ["system/blockMeshDict", "0/T", "0/D"]) expect(f[name], name).not.toMatch(/fuelInner/);
  });

  it("annular cases get a plain fuelInner patch, insulated (zeroGradient) for T and D", () => {
    const f = files();
    expect(f["system/blockMeshDict"]).toMatch(/fuelInner\s*\{\s*type patch;\s*faces\s*\(\s*\(0 4 7 3\)\s*\);/);
    expect(f["0/T"]).toMatch(/fuelInner\s*\{\s*type\s+zeroGradient;\s*\}/);
    expect(f["0/D"]).toMatch(/fuelInner\s*\{\s*type\s+zeroGradient;\s*\}/);
  });

  it("the hole radius moves only the fuel block vertices, and the fuel hex has exactly the sector's volume", () => {
    const solidText = writeOffbeatCase(solid()).files["system/blockMeshDict"]!;
    const ann = files()["system/blockMeshDict"]!;
    const vertsOf = (t: string) => {
      const block = /vertices\s*\(([\s\S]*?)\)\s*;\s*blocks/.exec(t)![1]!;
      return [...block.matchAll(/\(([^()]+)\)/g)].map((m) => m[1]!.trim().split(/\s+/).map(Number));
    };
    const vs = vertsOf(solidText);
    const va = vertsOf(ann);
    for (let i = 8; i < 16; i++) expect(va[i]).toEqual(vs[i]); // cladding unchanged
    for (const i of [1, 2, 5, 6]) expect(va[i]).toEqual(vs[i]); // fuel outer edge unchanged
    const half = (0.25 / 2) * (Math.PI / 180);
    const area = (a: number, b: number) => (Math.abs(va[a]![1]!) + Math.abs(va[b]![1]!)) * (va[b]![0]! - va[a]![0]!);
    expect(Math.abs(area(0, 1) / (half * (4.1 * 4.1 - 1 * 1)) - 1)).toBeLessThan(1e-12);
  });

  it("the mapping lists the hole radius", () => {
    expect(writeOffbeatCase(annular()).mapping.some((m) => m.field === "geometry.fuelInnerRadius")).toBe(true);
    expect(writeOffbeatCase(solid()).mapping.some((m) => m.field === "geometry.fuelInnerRadius")).toBe(false);
  });
});

describe("results parser on real OFFBEAT output for the annular pin", () => {
  const T = text("tests/golden/offbeat-annular/T");
  const C = text("tests/golden/offbeat-annular/C");
  const res = buildResults(annular(), { T, C, time: 5e7 });

  it("passes every check against the annular closed form", () => {
    expect(res.checks.map((c) => c.id + ":" + c.verdict)).toEqual(["energyBalance:pass", "closedFormFuel:pass", "closedFormCladding:pass", "wallTemperature:pass"]);
    expect(res.checks.find((c) => c.id === "energyBalance")!.value).toBeCloseTo(0, 5);
  });

  it("the innermost fuel cell is next to the hole and about the closed-form temperature there", () => {
    const first = res.radial[0]!;
    expect(first.region).toBe("fuel");
    expect(first.r).toBeGreaterThan(0.001);
    expect(first.r).toBeLessThan(0.00102);
    expect(Math.abs(res.summary.maxT - 1213.5607)).toBeLessThan(0.05);
  });

  it("the solid-fuel closed form would have rejected this result (the check discriminates)", () => {
    const n = annular();
    // the same numbers read against a case without the hole: the fuel disagrees with the solid closed form by far more than the bound
    const asSolid = { ...n, fuelInnerRadius: 0 };
    expect(() => buildResults(asSolid, { T, C, time: 5e7 })).not.toThrow(); // the cell centres are still inside the pin
    const r = buildResults(asSolid, { T, C, time: 5e7 });
    expect(r.checks.find((c) => c.id === "closedFormFuel")!.verdict).toBe("fail");
  });

  it("a cell centre inside the hole is refused", () => {
    const bigger = { ...annular(), fuelInnerRadius: 0.0011 };
    expect(() => buildResults(bigger, { T, C, time: 5e7 })).toThrow(ResultsError);
  });
});

const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

describe.skipIf(!solverOn)("annular pin through the real solver (needs FEED_SOLVER=1)", () => {
  it("OFFBEAT with the insulated hole reproduces the annular closed form and the independent reference", async () => {
    const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-annular-")), backend: new WslBackend(), timeoutMs: 240_000 });
    const s = mgr.start(read("examples/annular-synthetic-pin.json"));
    if (!s.ok) throw new Error("start refused");
    const rec = await mgr.done(s.id);
    expect(rec.state).toBe("completed");
    const res = mgr.results(s.id)!;
    expect(res.checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(Math.abs(res.summary.maxT - 1213.5607)).toBeLessThan(0.05);
    expect(res.summary.claddingOuterWallT).toBeCloseTo(595.3375, 2);
  }, 300_000);
});
