// Plan 13 T3, ungated: real OFFBEAT output of particles (tests/golden/offbeat-triso, made by tests/trisoSolver.test.ts with FEED_SAVE_GOLDEN=1) read back and judged against the closed
// form of the sphere the wedge solves and FEED's finite-volume solution; the same output read with a wrong case fails a check; damaged output is refused.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ResultsError, buildResults } from "../src/core/resultsParser";
import { TRISO_BALANCE_TOLERANCE, TRISO_OUTPUT_DIGITS, TrisoInput, balanceTolerance, buildTrisoResults, parseCellZones } from "../src/core/trisoResults";
import { trisoClosedForm, trisoTimeScale } from "../src/core/trisoSolve";
import { TRISO_WEDGE_SCALE, wedgeEquivalent } from "../src/core/trisoWriter";

const root = join(__dirname, "..");
const g = (name: string) => {
  const d = join(root, "tests", "golden", "offbeat-triso", name);
  const f = (x: string) => readFileSync(join(d, x), "utf8");
  return { n: JSON.parse(f("normalized.json")), T: f("T"), C: f("C"), cellZones: f("cellZones"), rate: JSON.parse(f("rate.json")) as { relativeRate: number; time: number }, saved: JSON.parse(f("results.json")) };
};
type G = ReturnType<typeof g>;
const read = (x: G, mutate?: (n: any) => void, over: Partial<TrisoInput> = {}) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildTrisoResults(n, { T: x.T, C: x.C, cellZones: x.cellZones, time: x.rate.time, drift: { relativeRate: x.rate.relativeRate }, ...over });
};
const failed = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const check = (r: { checks: { id: string; value: number | null }[] }, id: string) => r.checks.find((c) => c.id === id)!.value!;
const NAMES = ["steady", "intense", "film", "two-layers", "temperature-dependent", "fine", "limits"];

describe("real OFFBEAT output of a particle", () => {
  for (const name of NAMES) {
    it(name + ": every check passes, and the record is what the run saved", () => {
      const x = g(name);
      const r = read(x);
      expect(failed(r)).toEqual([]);
      expect(r.cells).toHaveLength(x.n.cells.reduce((a: number, b: number) => a + b, 0));
      expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["closedFormKernel", "closedFormBuffer", "closedFormIpyc", "crossCheckFv", "energyBalance", "gapDrop", "wallTemperature", "steadyState"]));
      // the saved record (made by the same code on the same files) is reproduced, check by check
      expect(r.checks.map((c) => [c.id, c.verdict])).toEqual(x.saved.checks.map((c: { id: string; verdict: string }) => [c.id, c.verdict]));
      expect(r.summary.kernelCentreT).toBeCloseTo(x.saved.summary.kernelCentreT, 9);
    });
  }

  it("is within a few hundredths of a kelvin of the wedge's closed form on the fine mesh (48 cells in every region), where the 12-cell mesh is within 0.12 K", () => {
    const fine = read(g("fine"));
    for (const id of ["closedFormKernel", "closedFormBuffer", "closedFormIpyc", "closedFormSic", "closedFormOpyc"]) expect(check(fine, id), id).toBeLessThan(0.01);
    expect(check(fine, "crossCheckFv")).toBeLessThan(0.01);
    const coarse = read(g("intense"));
    expect(check(coarse, "closedFormKernel")).toBeLessThan(0.12);
    expect(check(coarse, "closedFormKernel")).toBeGreaterThan(check(fine, "closedFormKernel"));
    // the coarse mesh's largest deviation from the finite-volume solution is below 0.1 K of a rise of 49 K
    expect(check(coarse, "crossCheckFv")).toBeLessThan(0.1);
  });

  it("the energy balance and the gap's drop are exact to a few parts in 1e5 on a mesh of 12 cells", () => {
    for (const name of ["steady", "intense", "film", "temperature-dependent"]) {
      const r = read(g(name));
      expect(Math.abs(check(r, "energyBalance")), name).toBeLessThan(5e-5);
      expect(Math.abs(check(r, "gapDrop")), name).toBeLessThan(5e-5);
    }
  });

  it("the probe's particle (a 49 K rise, a wall at 1298 K): the kernel centre is the hand-worked closed form of the wedge's sphere, to the first cell's error", () => {
    const x = g("intense");
    const r = read(x);
    // by hand, with the wedge's radii (the case's times 0.999695), constant conductivities 3, 0.5, 4, 13.9, 4 and the heat of the smaller kernel
    const L = TRISO_WEDGE_SCALE;
    const R = [250, 350, 390, 425, 460].map((u) => u * 1e-6 * L);
    const P = 3e9 * (4 / 3) * Math.PI * (250e-6 * L) ** 3;
    const drop = (k: number, a: number, b: number) => (P / (4 * Math.PI * k)) * (1 / a - 1 / b);
    const centre = 1298 + drop(4, R[3]!, R[4]!) + drop(13.9, R[2]!, R[3]!) + drop(4, R[1]!, R[2]!) + P / (4 * Math.PI * R[1]! ** 2 * 1.5e5) + drop(0.5, R[0]!, R[1]!) + (3e9 * R[0]! ** 2) / (6 * 3);
    expect(centre).toBeCloseTo(1347.04, 1);
    expect(Math.abs(r.summary.kernelCentreT - centre)).toBeLessThan(0.13);
    // and the nominal sphere is 0.03 to 0.06 % higher in each rise
    expect(trisoClosedForm(x.n).centreT).toBeGreaterThan(centre);
    expect(trisoClosedForm(x.n).centreT - centre).toBeLessThan(0.05);
  });

  it("puts every cell in its region by the zones and gives each region's faces: the drops add up to the whole rise", () => {
    for (const name of NAMES) {
      const r = read(g(name));
      const sum = r.regions.reduce((a, q) => a + q.drop, 0) + r.summary.gapDeltaT;
      expect(sum, name).toBeCloseTo(r.summary.kernelCentreT - r.summary.wallT, 9);
      for (const q of r.regions) {
        expect(q.drop, name + " " + q.name).toBeGreaterThan(0);
        expect(q.innerFaceT).toBeGreaterThanOrEqual(q.outerFaceT);
        // the hottest cell of a region lies between its faces' temperatures, at most a hair beyond (the kernel's centre is extrapolated)
        expect(q.hottestCellT).toBeLessThanOrEqual(q.innerFaceT + 1e-9);
        expect(q.coldestCellT).toBeGreaterThanOrEqual(q.outerFaceT - 1e-6);
      }
    }
    const r = read(g("steady"));
    expect(r.regions.map((q) => q.name)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    expect(r.cells.map((c) => c.region).filter((x, i, a) => a.indexOf(x) === i)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    for (let i = 1; i < r.cells.length; i++) expect(r.cells[i]!.r).toBeGreaterThan(r.cells[i - 1]!.r);
    expect(r.regions[0]!.innerRadius).toBe(0);
    expect(r.regions[4]!.outerRadius).toBeCloseTo(460e-6 * TRISO_WEDGE_SCALE, 14);
    // the wall is the patch value, the film's drop is there for a convective outside
    expect(r.summary.wallT).toBe(1000);
    const film = read(g("film"));
    expect(film.summary.wallT - 900).toBeGreaterThan(30);
  });

  it("each region's faces are the closed form's faces of the wedge's sphere: within 0.15 K on 12 cells, 0.03 K on 48 (the kernel's centre is extrapolated from its first cell)", () => {
    for (const [name, tol] of [["steady", 0.15], ["intense", 0.15], ["film", 0.15], ["temperature-dependent", 0.15], ["fine", 0.03]] as const) {
      const x = g(name);
      const r = read(x);
      const cf = trisoClosedForm(wedgeEquivalent(x.n));
      r.regions.forEach((q, i) => {
        expect(Math.abs(q.innerFaceT - cf.regions[i]!.innerT), name + " " + q.name + " inner").toBeLessThan(tol);
        expect(Math.abs(q.outerFaceT - cf.regions[i]!.outerT), name + " " + q.name + " outer").toBeLessThan(tol);
      });
    }
  });

  it("the kernel's centre is the first cell plus the parabola's rise q r^2 / (6 k) over the cell's radius, to the last digit (k = 3 W/m/K), and the drop of a region is its inner face minus its outer", () => {
    const x = g("steady");
    const r = read(x);
    const r1 = r.cells[0]!.r;
    expect(r.summary.kernelCentreT - r.summary.kernelCentreCellT).toBeCloseTo((6e8 * r1 * r1) / (6 * 3), 9);
    for (const q of r.regions) expect(q.drop).toBeCloseTo(q.innerFaceT - q.outerFaceT, 12);
  });

  it("the buffer carries the largest drop of the five regions in the synthetic particle (its conductivity is a sixth of the carbon's)", () => {
    const r = read(g("steady"));
    const drops = Object.fromEntries(r.regions.map((q) => [q.name, q.drop]));
    expect(drops.buffer).toBeGreaterThan(drops.kernel!);
    expect(drops.buffer).toBeGreaterThan(3 * drops.ipyc!);
  });
});

describe("the same output judged as another particle fails, or is refused", () => {
  it("layers with their conductivities swapped (the buffer's and the inner carbon's): the closed-form checks fail", () => {
    const x = g("intense");
    const r = read(x, (n) => {
      const a = n.layers[0].conductivity;
      n.layers[0].conductivity = n.layers[1].conductivity;
      n.layers[1].conductivity = a;
    });
    expect(failed(r)).toEqual(expect.arrayContaining(["closedFormBuffer", "closedFormIpyc", "crossCheckFv"]));
  });

  it("the cell zones with the buffer's and the inner carbon's names swapped: refused, the zones and the cell centres do not belong together", () => {
    const x = g("steady");
    const swapped = x.cellZones.replace(/Buffer/g, "XX").replace(/IPyC/g, "Buffer").replace(/XX/g, "IPyC");
    expect(() => read(x, undefined, { cellZones: swapped })).toThrow(/do not belong together/);
  });

  it("layers with their thicknesses swapped (the case is another particle): refused, the cells are not where the case's mesh puts them", () => {
    const x = g("steady");
    expect(() =>
      read(x, (n) => {
        const t = (l: { innerRadius: number; outerRadius: number }) => l.outerRadius - l.innerRadius;
        const [b, i] = [n.layers[0], n.layers[1]];
        const tb = t(b);
        const ti = t(i);
        b.outerRadius = b.innerRadius + ti;
        i.innerRadius = b.outerRadius;
        i.outerRadius = i.innerRadius + tb;
        n.layers[2].innerRadius = i.outerRadius;
      }),
    ).toThrow(ResultsError);
  });

  it("a gap conductance that is not the one that was run fails the gap's drop, and nothing else of the layers' checks", () => {
    const r = read(g("intense"), (n) => (n.gapConductance *= 2));
    expect(failed(r)).toContain("gapDrop");
    expect(failed(r)).not.toContain("energyBalance");
    const slight = read(g("intense"), (n) => (n.gapConductance *= 1.05));
    expect(failed(slight)).toContain("gapDrop");
  });

  it("a power that is 10 % off fails the energy balance and the layers' closed forms; a kernel-volume mistake of 3 % too", () => {
    const x = g("intense");
    const r = read(x, (n) => {
      n.power.particlePower *= 1.1;
      n.power.kernelPowerDensity *= 1.1;
    });
    expect(failed(r)).toEqual(expect.arrayContaining(["energyBalance", "closedFormKernel", "closedFormBuffer", "crossCheckFv"]));
    // a particle power that is the kernel density times the WHOLE particle's volume is 2.7 times too much
    const wrong = read(x, (n) => (n.power.kernelPowerDensity *= (n.outerRadius / n.kernelRadius) ** 3));
    expect(failed(wrong)).toContain("energyBalance");
    const slightly = read(x, (n) => (n.power.kernelPowerDensity *= 1.03));
    expect(failed(slightly)).toContain("energyBalance");
  });

  it("a film coefficient that is not the one that was run fails the wall check", () => {
    const r = read(g("film"), (n) => (n.boundary.heatTransferCoefficient *= 0.5));
    expect(failed(r)).toContain("wallTemperature");
  });

  it("a conductivity range that the particle leaves fails the property-range check", () => {
    const r = read(g("temperature-dependent"), (n) => (n.kernelConductivity.range = [600, 950]));
    expect(r.domain.verdict).toBe("out-of-domain");
    expect(failed(r)).toContain("propertyRange");
    expect(r.domain.findings[0]!.region).toBe("kernel");
  });

  it("a run that has not settled (a large last-step rate) or has no rate record fails the steady-state check", () => {
    const x = g("steady");
    expect(failed(read(x, undefined, { drift: { relativeRate: 1e-3 } }))).toContain("steadyState");
    expect(failed(read(x, undefined, { drift: { relativeRate: undefined } }))).toContain("steadyState");
    expect(failed(read(x, undefined, { drift: { relativeRate: NaN } }))).toContain("steadyState");
    // without a log there is no steady-state check at all
    expect(read(x, undefined, { drift: undefined }).checks.map((c) => c.id)).not.toContain("steadyState");
  });

  it("a case whose radii are 0.15 % off the mesh that was run is refused (every cell is in its zone, but not where this case's mesh puts it)", () => {
    const x = g("steady");
    expect(() =>
      read(x, (n) => {
        const s = 1.0015;
        n.kernelRadius *= s;
        n.outerRadius *= s;
        for (const l of n.layers) {
          l.innerRadius *= s;
          l.outerRadius *= s;
        }
      }),
    ).toThrow(/cell centres differ from the case's mesh/);
  });

  it("the steady-state bound uses the hottest cell: a rate that puts it between the coldest and the hottest cell's bound fails", () => {
    const x = g("steady");
    const tau = trisoTimeScale(x.n).tauBound;
    const rate = 0.01 / (tau * 1005); // 0.01 K is the threshold; the cells run from 1000.005 to 1009.775 K
    expect(failed(read(x, undefined, { drift: { relativeRate: rate } }))).toContain("steadyState");
    expect(failed(read(x, undefined, { drift: { relativeRate: rate * 0.98 } }))).not.toContain("steadyState");
  });

  it("two cells at one centre are refused before anything is judged", () => {
    const x = g("steady");
    const lines = x.C.split("\n");
    const i = lines.findIndex((l) => /^\(\d/.test(l));
    lines[i + 1] = lines[i]!;
    expect(() => read(x, undefined, { C: lines.join("\n") })).toThrow(/share a centre/);
  });

  it("a pin's case does not read a particle's fields", () => {
    const x = g("steady");
    const pin = JSON.parse(readFileSync(join(root, "tests", "golden", "offbeat-plate", "steady", "normalized.json"), "utf8"));
    expect(() => buildResults(pin, { T: x.T, C: x.C, time: 5e7 })).toThrow(ResultsError);
  });
});

describe("damaged output is refused", () => {
  const x = g("steady");
  it("a cut field, a field with the wrong number of cells, a negative temperature", () => {
    expect(() => read(x, undefined, { T: x.T.slice(0, x.T.length - 300) })).toThrow(ResultsError);
    expect(() => read(x, (n) => (n.cells[0] = 13))).toThrow(/expected 65 cells/);
    expect(() => read(x, undefined, { T: x.T.replace("1009.7753", "-5") })).toThrow(/not above 0 K/);
    expect(() => read(x, undefined, { T: x.T.replace("1009.7753", "nan") })).toThrow(ResultsError);
  });
  it("a cell centre field of another length, a non-positive time", () => {
    const lines = x.C.split("\n");
    const i = lines.findIndex((l) => /^\(\d/.test(l));
    expect(() => read(x, undefined, { C: lines.slice(0, i).concat(lines.slice(i + 1)).join("\n") })).toThrow(ResultsError);
    expect(() => read(x, undefined, { time: 0 })).toThrow(/final time/);
  });
  it("a missing patch, a field with no boundary, a cut zones file", () => {
    expect(() => read(x, undefined, { T: x.T.replace(/bufferOuter/g, "elsewhere") })).toThrow(/no value for the bufferOuter patch/);
    expect(() => read(x, undefined, { T: x.T.replace(/ipycInner/g, "elsewhere") })).toThrow(/no value for the ipycInner patch/);
    expect(() => read(x, undefined, { T: x.T.replace(/outer/g, "elsewhere") })).toThrow(/no value for the outer patch/);
    expect(() => read(x, undefined, { T: x.T.replace("boundaryField", "boundaries") })).toThrow(/no boundaryField/);
    expect(() => read(x, undefined, { cellZones: x.cellZones.slice(0, 600) })).toThrow(ResultsError);
  });
  it("cell zones that do not belong to the particle: an extra zone, a missing one, a cell in two zones, a wrong count, a label out of range", () => {
    expect(() => read(x, undefined, { cellZones: x.cellZones.replace(/OPyC/g, "Shell") })).toThrow(/zone Shell is not a region/);
    expect(() => read(g("two-layers"), undefined, { cellZones: x.cellZones })).toThrow(/is not a region of this particle/);
    // a particle with more regions than its zones
    const nine = g("steady");
    const zones = parseCellZones(nine.cellZones);
    expect([...zones.keys()]).toEqual(["Kernel", "Buffer", "IPyC", "SiC", "OPyC"]);
    expect(zones.get("Kernel")).toHaveLength(12);
    expect(zones.get("SiC")).toHaveLength(16);
    expect(() => read(x, undefined, { cellZones: x.cellZones.replace(/\nOPyC\n\{[\s\S]*?\n\}\n/, "\n") })).toThrow(/zone OPyC is missing|cellZones/);
    expect(() => read(x, (n) => (n.cells[4] = 11))).toThrow(/expected 64 cells|cells/);
    // the same labels twice
    const dup = x.cellZones.replace(/(Buffer\s*\{\s*type cellZone;\s*cellLabels\s+List<label>\s*12\s*\(\s*)12/, "$10");
    expect(() => read(x, undefined, { cellZones: dup })).toThrow(/in two zones/);
    const far = x.cellZones.replace(/(Buffer\s*\{\s*type cellZone;\s*cellLabels\s+List<label>\s*12\s*\(\s*)12/, "$1999");
    expect(() => read(x, undefined, { cellZones: far })).toThrow(/names cell 999/);
    expect(() => parseCellZones("FoamFile\n{\n}\n// ************************************************************************* //\n")).toThrow(/no cell zone/);
  });
});

describe("the energy balance allows for the rounding of OFFBEAT's output (plan 13, owner's decision of 2026-10-16)", () => {
  // by hand: two nodes at 1 mm and 2 mm, resistance for a conductivity of 1 = (1/1e-3 - 1/2e-3) / (4 pi) = 500 / (4 pi) K/W, a power of 11.65 mW, a mean conductivity of 4
  const resist = (1 / 1e-3 - 1 / 2e-3) / (4 * Math.PI);
  it("eight significant digits at 1300 K is a unit of 1e-4 K, which moves the heat by k x unit / (resistance x power)", () => {
    expect(TRISO_OUTPUT_DIGITS).toBe(8);
    const r = balanceTolerance(1300.2, 1299.9, 4, resist, 0.01165);
    expect(r.resolution).toBeCloseTo((4 * 1e-4) / (resist * 0.01165), 12);
    expect(r.resolution).toBeCloseTo(8.63e-4, 6);
    expect(r.tolerance).toBeCloseTo(TRISO_BALANCE_TOLERANCE + r.resolution, 12);
  });
  it("is ten times larger at ten times the temperature, and inversely proportional to the difference it is read from (the power and the resistance)", () => {
    const lo = balanceTolerance(95, 94, 4, resist, 0.01165).resolution;
    const hi = balanceTolerance(950, 940, 4, resist, 0.01165).resolution;
    expect(hi / lo).toBeCloseTo(10, 9);
    expect(balanceTolerance(950, 940, 4, resist, 0.0233).resolution).toBeCloseTo(hi / 2, 12);
    expect(balanceTolerance(950, 940, 4, 2 * resist, 0.01165).resolution).toBeCloseTo(hi / 2, 12);
    expect(balanceTolerance(950, 940, 8, resist, 0.01165).resolution).toBeCloseTo(2 * hi, 12);
  });
  it("the larger of the two temperatures sets the unit, whatever the order", () => {
    expect(balanceTolerance(999, 1001, 4, resist, 0.01).resolution).toBe(balanceTolerance(1001, 999, 4, resist, 0.01).resolution);
    expect(balanceTolerance(999, 1001, 4, resist, 0.01).resolution).toBeCloseTo((4 * 1e-4) / (resist * 0.01), 12);
  });
  it("a record says how much of its threshold is the rounding, and a power 3 % off still fails the golden particles", () => {
    const r = read(g("steady"));
    const c = r.checks.find((x) => x.id === "energyBalance")!;
    expect(c.note).toMatch(/plus [\d.e+-]+ % for the 8-digit rounding of the two temperatures/);
    expect(c.note).toMatch(/outermost layer \(its first to its last cell\)/);
    for (const name of ["steady", "intense", "film"]) expect(failed(read(g(name), (n) => (n.power.kernelPowerDensity *= 1.03))), name).toContain("energyBalance");
  });
});
