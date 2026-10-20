// The Codex review of 2026-10-17, the items that were left open (docs/codex-review-2026-10-17.md), each with a test that fails without its fix.
//   R2b-2  the particle mechanics reader looked at the radial displacement and the diagonal stress only: a displacement across the radius or a shear stress could be anything
//   R2b-3  the free-strain check compared the diagonal of epsilonSwelling only
//   R2b-4  the mechanics bounds were widened by the largest temperature step of the output T under test, so a damaged T inflated them
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildTrisoMechanicsResults, TrisoMechanicsInput } from "../src/core/trisoMechanicsResults";
import { validateCase } from "../src/core/validate";
import { buildCompactRecord, HomogenisedSpec } from "../src/core/compact";
import { stackSteadyBandWork, STACK_STEADY_BAND_WORK_MAX, stackTransientReference } from "../src/core/stackReference";

const root = join(__dirname, "golden", "offbeat-triso-mech");
const g = (name: string) => {
  const f = (x: string) => readFileSync(join(root, name, x), "utf8");
  const has = (x: string) => {
    try {
      f(x);
      return true;
    } catch {
      return false;
    }
  };
  return { n: JSON.parse(f("normalized.json")), T: f("T"), C: f("C"), D: f("D"), sigma: f("sigma"), eps: has("epsilonSwelling") ? f("epsilonSwelling") : undefined, cellZones: f("cellZones"), time: (JSON.parse(f("run.json")) as { time: number }).time };
};
type G = ReturnType<typeof g>;
const read = (x: G, over: Partial<TrisoMechanicsInput> = {}) => buildTrisoMechanicsResults(JSON.parse(JSON.stringify(x.n)), { T: x.T, C: x.C, D: x.D, sigma: x.sigma, ...(x.eps !== undefined ? { epsilonSwelling: x.eps } : {}), cellZones: x.cellZones, time: x.time, ...over });
const failed = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);

/** Rewrite the rows of a nonuniform list field ("(a b c)" per line): fn(row, cell index) returns the new row. */
function editRows(text: string, fn: (row: number[], i: number) => number[]): string {
  const head = /internalField\s+nonuniform\s+List<\w+>\s*\d+\s*\(\s*\n/.exec(text)!;
  const start = head.index + head[0].length;
  const end = text.indexOf("\n)", start);
  const rows = text.slice(start, end).split("\n").map((l) => l.trim());
  const out = rows.map((l, i) => "(" + fn(l.slice(1, -1).trim().split(/\s+/).map(Number), i).map((v) => String(v)).join(" ") + ")");
  return text.slice(0, start) + out.join("\n") + text.slice(end);
}
/** Rewrite the values of a nonuniform scalar field (one value per line). */
function editScalars(text: string, fn: (v: number, i: number) => number): string {
  const head = /internalField\s+nonuniform\s+List<scalar>\s*\d+\s*\(\s*\n/.exec(text)!;
  const start = head.index + head[0].length;
  const end = text.indexOf("\n)", start);
  const rows = text.slice(start, end).split("\n").map((l) => Number(l.trim()));
  return text.slice(0, start) + rows.map((v, i) => String(fn(v, i))).join("\n") + text.slice(end);
}

describe("the mechanics reader looks off the radial axis (R2b-2, R2b-3)", () => {
  it("the saved runs pass the new check with a large margin (the measured shear is 5.5e-8 Pa at most, the perpendicular displacement 1e-24 m)", () => {
    for (const name of ["ipyc", "pressure", "swelling", "anisotropic", "thermal", "library"]) {
      const r = read(g(name));
      expect(failed(r), name).toEqual([]);
      const c = r.checks.find((k) => k.id === "mechanicsOffAxis")!;
      expect(c.verdict).toBe("pass");
      expect(c.value!).toBeLessThan(1e-3);
    }
  });
  it("a shear stress in one cell fails the check", () => {
    const x = g("pressure");
    for (const comp of [1, 2, 4]) {
      const sigma = editRows(x.sigma, (row, i) => (i === 3 ? row.map((v, k) => (k === comp ? 1e5 : v)) : row));
      expect(failed(read(x, { sigma })), "component " + comp).toEqual(["mechanicsOffAxis"]);
    }
  });
  it("a displacement across the radius fails the check", () => {
    const x = g("pressure");
    // a cell on the x axis (the wedge's radius) moved in y by a tenth of its radial displacement
    const D = editRows(x.D, (row, i) => (i === 3 ? [row[0]!, row[1]! + 0.1 * Math.abs(row[0]!), row[2]!] : row));
    expect(failed(read(x, { D }))).toContain("mechanicsOffAxis");
  });
  it("an off-diagonal swelling strain fails the free-strain check", () => {
    const x = g("anisotropic");
    expect(failed(read(x))).toEqual([]);
    for (const comp of [1, 2, 4]) {
      const epsilonSwelling = editRows(x.eps!, (row, i) => (i === 2 ? row.map((v, k) => (k === comp ? 1e-4 : v)) : row));
      expect(failed(read(x, { epsilonSwelling })), "component " + comp).toContain("mechanicsFreeStrain");
    }
  });
});

describe("the bounds do not depend on the output temperature under test (R2b-4)", () => {
  it("a temperature field with one cell 5000 K off fails the temperature check and leaves the stress bound where it was", () => {
    const x = g("thermal");
    const base = read(x);
    const T = editScalars(x.T, (v, i) => (i === 0 ? v + 5000 : v));
    const bad = read(x, { T });
    expect(failed(bad)).toContain("mechanicsTemperature");
    const bounds = (r: typeof base) => /bounds [^]*$/.exec(r.checks.find((c) => c.id === "mechanicsStress")!.note)![0];
    expect(bounds(bad)).toBe(bounds(base));
    // the stress itself is unchanged by T (it is OFFBEAT's own), so the stress check still passes: only the temperature check reports the damage
    expect(failed(bad)).toEqual(["mechanicsTemperature"]);
  });
});

describe("the SiC expansion has a stated range (R4-3)", () => {
  const lib = JSON.parse(readFileSync(join(__dirname, "..", "library", "coatings.json"), "utf8")) as { id: string; sets: Record<string, any> }[];
  const sicCase = (surfaceK: number) => {
    const d = JSON.parse(readFileSync(join(__dirname, "..", "schema", "vectors", "good", "triso-mechanics-library.json"), "utf8"));
    d.materials.sic.sets["mechanical.thermalExpansion"] = JSON.parse(JSON.stringify(lib.find((e) => e.id === "sic-parfume-25-940")!.sets["mechanical.thermalExpansion"]));
    d.boundary.surfaceTemperature = { value: surfaceK, unit: "K" };
    return validateCase(d);
  };
  it("the three PARFUME segments state the coefficient as a linear law with b = 0 over 22 to 1300 C, so the same value is used and the range can be checked", () => {
    for (const id of ["sic-parfume-25-940", "sic-parfume-940-1215", "sic-parfume-1215-1600"]) {
      const x = lib.find((e) => e.id === id)!.sets["mechanical.thermalExpansion"].linearExpansion;
      expect(x.model, id).toBe("linear");
      expect(x.a.value, id).toBe(4.9e-6);
      expect(x.b.value, id).toBe(0);
      expect([x.validRange.min.value, x.validRange.max.value], id).toEqual([295.15, 1573.15]);
    }
  });
  it("a SiC layer hotter than 1573 K gets W_EXPANSION_RANGE, one inside the range does not", () => {
    const hot = sicCase(1700);
    expect(hot.errors).toEqual([]);
    expect(hot.warnings.map((w) => w.code + " " + w.field)).toContain("W_EXPANSION_RANGE /materials/sic/sets/mechanical.thermalExpansion");
    const cool = sicCase(900);
    // (the carbon layers warn here, their own law starts at 873 K: only the SiC field is judged)
    expect(cool.warnings.map((w) => w.code + " " + w.field)).not.toContain("W_EXPANSION_RANGE /materials/sic/sets/mechanical.thermalExpansion");
  });
});

describe("the two-scale particle's own conductivity ranges (R4-2)", () => {
  const spec0 = () => {
    const d = JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-compact-steady.json"), "utf8"));
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    return JSON.parse(JSON.stringify(v.normalized!.compact)) as HomogenisedSpec;
  };
  // a compact whose cells are all at one temperature: the two-scale particle behind the matrix shell is then the only thing that can be hotter than the solid's range
  const record = (spec: HomogenisedSpec, matrixT: number) => {
    const cells = Array.from({ length: 20 }, (_, i) => ({ r: (i + 0.5) * 1e-4, T: matrixT }));
    return buildCompactRecord(spec, cells, () => matrixT, { inner: 0, outer: 2e-3 });
  };
  const withKernelRange = (spec: HomogenisedSpec, range: [number, number]) => {
    const k = spec.particle.kernelConductivity as { kind: string; k?: number };
    spec.particle.kernelConductivity = { kind: "linear", a: k.k ?? 3, b: 0, range } as never;
    return spec;
  };
  it("a kernel that the two-scale step heats above its law's range fails twoScaleRange naming the region and the place; the same case with the matrix cooler passes", () => {
    const base = record(spec0(), 600).twoScale[0]!.particle;
    const rise = base.kernelCentreT - 600;
    expect(rise).toBeGreaterThan(1); // the particle is hotter than the solid around it: the whole point
    const top = 600 + rise / 2;
    const hot = record(withKernelRange(spec0(), [300, top]), 600);
    const c = hot.checks.find((x) => x.id === "twoScaleRange")!;
    expect(c.verdict).toBe("fail");
    expect(c.note).toMatch(/kernel at the hottest: \d+-\d+ K outside 300-/);
    const ok = record(withKernelRange(spec0(), [300, top + rise]), 600);
    expect(ok.checks.find((x) => x.id === "twoScaleRange")!.verdict).toBe("pass");
  });
  it("a particle whose laws are constants has no range to check: no such check is added", () => {
    expect(record(spec0(), 600).checks.map((x) => x.id)).not.toContain("twoScaleRange");
  });
});

describe("a coupled start that could not be solved says why (R1-3)", () => {
  const plate = (slices: number, fuelCells: number, claddingCells: number, initial: "steady" | "uniform") => {
    const d = JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-plate-loss-of-cooling.json"), "utf8"));
    d.mesh = { fuelCells, claddingCells };
    d.axial.slices = slices;
    d.transient.timeStep = { value: 0.6, unit: "s" }; // 100 steps: the transient is cheap, the steady coupled start is not
    d.transient.outputs = 10;
    if (initial === "uniform") {
      delete d.transient.initialSteadyLinearHeatRate;
      d.transient.initialTemperature = { value: 300, unit: "K" };
    }
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    return v.normalized!;
  };
  it("over the steady work cap the transient reference is still solved, startDistance is null and the record carries the reason", () => {
    const c = plate(30, 100, 20, "steady");
    expect(stackSteadyBandWork(c)).toBeGreaterThan(STACK_STEADY_BAND_WORK_MAX);
    const r = stackTransientReference(c);
    expect("reference" in r).toBe(true);
    const ref = (r as { reference: { startDistance: number | null; startDistanceReason?: string } }).reference;
    expect(ref.startDistance).toBeNull();
    expect(ref.startDistanceReason).toMatch(/was not computed: the coupled steady state is more work \(5\.18e\+7\) than the 2e\+7/);
  }, 120_000);
  it("a case under the cap has a distance and no reason; a uniform start has neither (there is no coupled state to compare with, which is not a failure)", () => {
    const small = stackTransientReference(plate(10, 20, 6, "steady")) as { reference: { startDistance: number | null; startDistanceReason?: string } };
    expect(small.reference.startDistance).toBeGreaterThan(0);
    expect(small.reference.startDistanceReason).toBeUndefined();
    const uniform = stackTransientReference(plate(10, 20, 6, "uniform")) as { reference: { startDistance: number | null; startDistanceReason?: string } };
    expect(uniform.reference.startDistance).toBeNull();
    expect(uniform.reference.startDistanceReason).toBeUndefined();
  }, 120_000);
});
