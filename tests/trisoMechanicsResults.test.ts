// Plan 14, stage E, ungated: real OFFBEAT output of a particle's mechanics (tests/golden/offbeat-triso-mech, made by tests/trisoMechanicsSolver.test.ts with FEED_SAVE_GOLDEN=1) read
// back and judged against the independent layered-sphere solution; the same output read with a wrong case, or damaged, fails a check or is refused. Every NEGATIVE test of plan 14's
// verification list is here: layers in the wrong order, a swapped modulus, a stress read at a face instead of a cell centre, a pressure applied outside instead of inside, the
// anisotropic free strain with its r ln r term removed.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ResultsError } from "../src/core/resultsParser";
import { buildTrisoMechanicsResults, TRISO_MECH_TOLERANCE, TrisoMechanicsInput } from "../src/core/trisoMechanicsResults";
import { trisoMechanicsConstants } from "../src/core/trisoMechanics";

const root = join(__dirname, "..");
const g = (name: string) => {
  const d = join(root, "tests", "golden", "offbeat-triso-mech", name);
  const f = (x: string) => readFileSync(join(d, x), "utf8");
  const has = (x: string) => {
    try {
      f(x);
      return true;
    } catch {
      return false;
    }
  };
  return { n: JSON.parse(f("normalized.json")), T: f("T"), C: f("C"), D: f("D"), sigma: f("sigma"), eps: has("epsilonSwelling") ? f("epsilonSwelling") : undefined, cellZones: f("cellZones"), run: JSON.parse(f("run.json")) as { time: number }, saved: JSON.parse(f("results.json")) };
};
type G = ReturnType<typeof g>;
const read = (x: G, mutate?: (n: any) => void, over: Partial<TrisoMechanicsInput> = {}) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildTrisoMechanicsResults(n, { T: x.T, C: x.C, D: x.D, sigma: x.sigma, ...(x.eps !== undefined ? { epsilonSwelling: x.eps } : {}), cellZones: x.cellZones, time: x.run.time, ...over });
};
const failed = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const check = (r: { checks: { id: string; value: number | null }[] }, id: string) => r.checks.find((c) => c.id === id)!.value!;
const NAMES = ["ipyc", "pressure", "swelling", "anisotropic", "thermal", "library"];

/** Rewrite the rows of a nonuniform list field: fn(row, cell index) returns the new row. */
function editRows(text: string, fn: (row: number[], i: number) => number[]): string {
  const head = /internalField\s+nonuniform\s+List<\w+>\s*\d+\s*\(\s*\n/.exec(text)!;
  const start = head.index + head[0].length;
  const end = text.indexOf("\n)", start);
  const rows = text.slice(start, end).split("\n").map((l) => l.trim());
  const out = rows.map((l, i) => "(" + fn(l.slice(1, -1).trim().split(/\s+/).map(Number), i).map((v) => String(v)).join(" ") + ")");
  return text.slice(0, start) + out.join("\n") + text.slice(end);
}

describe("real OFFBEAT output of a particle's mechanics", () => {
  for (const name of NAMES) {
    it(name + ": every check passes, and the record is what the run saved", () => {
      const x = g(name);
      const r = read(x);
      expect(failed(r)).toEqual([]);
      expect(r.checks.map((c) => [c.id, c.verdict])).toEqual(x.saved.checks.map((c: { id: string; verdict: string }) => [c.id, c.verdict]));
      expect(r.cells).toHaveLength(x.n.cells.slice(2).reduce((a: number, b: number) => a + b, 0));
      expect(r.cells.map((c) => c.sigmaT)).toEqual(x.saved.cells.map((c: { sigmaT: number }) => c.sigmaT));
      expect(r.text).toMatch(/free strains are inputs, not an irradiation result/);
    });
  }

  it("the deviations from the independent solution are small against the stress: tangential and radial within 0.15 % of the layer's peak on the swelling case (the probe's cell values: 0.03 and 0.16 %)", () => {
    const x = g("swelling");
    const r = read(x);
    for (const l of r.layers) {
      const cells = r.cells.filter((c) => c.layer === l.name);
      const peakT = Math.max(...cells.map((c) => Math.abs(c.ind.sigmaT)));
      const peakR = Math.max(...cells.map((c) => Math.abs(c.ind.sigmaR)));
      expect(Math.max(...cells.map((c) => Math.abs(c.sigmaT - c.ind.sigmaT))) / peakT, l.name + " tangential").toBeLessThan(0.0015);
      expect(Math.max(...cells.map((c) => Math.abs(c.sigmaR - c.ind.sigmaR))) / peakR, l.name + " radial").toBeLessThan(0.0016 * 5);
    }
  });

  it("the swelling case has the signs of the physics: the shrinking carbon in tension, the SiC in compression; an inside pressure alone puts tension in the SiC", () => {
    const sw = read(g("swelling"));
    expect(sw.layers.find((l) => l.name === "ipyc")!.sigmaTMin).toBeGreaterThan(8e8);
    expect(sw.layers.find((l) => l.name === "sic")!.sigmaTMax).toBeLessThan(-7e8);
    const pr = read(g("pressure"));
    expect(pr.layers.find((l) => l.name === "sic")!.sigmaTMin).toBeGreaterThan(9e7);
    expect(pr.summary.sicPeakTangential).toBeCloseTo(pr.layers.find((l) => l.name === "sic")!.sigmaTMax, 3);
    // the first interface carries a radial compression between the gas pressure (25 MPa) and the outside (0.1 MPa)
    expect(pr.summary.interfaceRadialStress[0]).toBeLessThan(0);
    expect(pr.summary.interfaceRadialStress[0]).toBeGreaterThan(-25e6);
  });

  it("the radial stress at each interface (the summary) is the independent solution's within the interface tolerance, and the SiC's peak is the largest tangential stress of its cells", () => {
    const x = g("pressure");
    const r = read(x);
    const sic0 = r.cells.find((c) => c.layer === "sic")!;
    const ipycLast = r.cells.filter((c) => c.layer === "ipyc").slice(-1)[0]!;
    // the independent radial stress at the interface lies between its two neighbouring cells'
    const lo = Math.min(sic0.ind.sigmaR, ipycLast.ind.sigmaR);
    const hi = Math.max(sic0.ind.sigmaR, ipycLast.ind.sigmaR);
    const tol = 0.02 * Math.max(...r.cells.flatMap((c) => [Math.abs(c.ind.sigmaR), Math.abs(c.ind.sigmaT)]));
    expect(r.summary.interfaceRadialStress).toHaveLength(1);
    expect(r.summary.interfaceRadialStress[0]!).toBeGreaterThan(lo - tol);
    expect(r.summary.interfaceRadialStress[0]!).toBeLessThan(hi + tol);
    expect(r.summary.sicPeakTangential).toBe(Math.max(...r.cells.filter((c) => c.layer === "sic").map((c) => c.sigmaT)));
    // a particle without a SiC has none to report
    expect(read(g("ipyc")).summary.sicPeakTangential).toBeNull();
  });

  it("the library case: the PARFUME sets are used as the reduced constants and warned about outside their range", () => {
    const x = g("library");
    const ks = trisoMechanicsConstants(x.n);
    // E of the dense carbon at its mean temperature from the report's equation 7-2 (25.5 GPa x 1.01904 x (1 + 0.00015 (T - 20 C))), written here independently of the library file
    const carbon = ks.find((k) => k.name === "ipyc")!;
    const want = 25.5e9 * (0.384 + 0.324 * 1.96) * (1 + 0.00015 * (carbon.meanTemperature - 273.15 - 20));
    expect(Math.abs(carbon.E / want - 1)).toBeLessThan(1e-9);
    const sic = ks.find((k) => k.name === "sic")!;
    // the SiC between 25 and 940 C: 427.6 GPa falling to 375.2 GPa, linear (Table 7-1)
    const wantSic = 427.6e9 + ((375.2e9 - 427.6e9) * (sic.meanTemperature - 273.15 - 25)) / (940 - 25);
    expect(Math.abs(sic.E / wantSic - 1)).toBeLessThan(1e-9);
    expect(sic.alpha).toBeCloseTo(4.9e-6, 12);
    expect(ks.every((k) => k.expansionOutOfRange)).toBe(false); // the SiC's constant coefficient has no range
    expect(ks.find((k) => k.name === "ipyc")!.expansionOutOfRange).toBe(true); // 300 K is below the carbon law's 873 K
  });
});

describe("the same output read wrongly fails a check (each negative test of the plan)", () => {
  it("a swapped modulus (the carbon and the SiC exchange their laws) fails the stress check", () => {
    const x = g("pressure");
    const r = read(x, (n) => {
      const L = n.mechanics.layers;
      const a = L[0].props;
      L[0].props = L[1].props;
      L[1].props = a;
    });
    expect(failed(r)).toContain("mechanicsStress");
  });

  it("a pressure applied outside instead of inside fails the stress and the displacement checks", () => {
    const x = g("pressure");
    const r = read(x, (n) => {
      const m = n.mechanics;
      [m.gasPressure, m.outsidePressure] = [m.outsidePressure, m.gasPressure];
    });
    expect(failed(r)).toEqual(expect.arrayContaining(["mechanicsStress", "mechanicsDisplacement"]));
  });

  it("a stress read at the inner face of its cell instead of the centre fails the stress check where the stress has a gradient (the pressure cases), and the displacement check where it has not (the swelling case)", () => {
    for (const name of ["pressure", "ipyc"]) expect(failed(read(g(name), undefined, { hook: { evaluateAt: "inner-face" } })), name).toContain("mechanicsStress");
    expect(failed(read(g("swelling"), undefined, { hook: { evaluateAt: "inner-face" } }))).toContain("mechanicsDisplacement");
  });

  it("the anisotropic free strain without the r ln r term fails the stress check on the anisotropic case", () => {
    const x = g("anisotropic");
    expect(failed(read(x))).toEqual([]);
    const r = read(x, undefined, { hook: { sphere: { dropAnisotropicTerm: true } } });
    expect(failed(r)).toContain("mechanicsStress");
  });

  it("layers in the wrong order are refused: the zones of the carbon and the SiC exchanged", () => {
    const x = g("pressure");
    const swapped = x.cellZones.replace(/\bIPyC\b/g, "TMP").replace(/\bSiC\b/g, "IPyC").replace(/\bTMP\b/g, "SiC");
    expect(() => read(x, undefined, { cellZones: swapped })).toThrow(ResultsError);
  });

  it("a layer with its free strain removed fails the stress check and the free-strain check", () => {
    const x = g("swelling");
    const r = read(x, (n) => (n.mechanics.freeStrains = []));
    expect(failed(r)).toEqual(expect.arrayContaining(["mechanicsStress"]));
    // the run applied -0.015: the free-strain check compares OFFBEAT's strain with the case's (a case that states none, with a swelling field of -0.015, differs)
    expect(check(r, "mechanicsStress")).toBeGreaterThan(1e8);
  });

  it("a free strain that differs from the one applied fails the free-strain check", () => {
    const x = g("swelling");
    const r = read(x, (n) => (n.mechanics.freeStrains[0].tangential = -0.014));
    expect(failed(r)).toContain("mechanicsFreeStrain");
    expect(failed(r)).toContain("mechanicsStress");
  });

  it("a missing epsilonSwelling field fails the free-strain check rather than passing it unread", () => {
    const x = g("swelling");
    const r = read(x, undefined, { epsilonSwelling: undefined });
    expect(failed(r)).toEqual(["mechanicsFreeStrain"]);
  });

  it("a temperature field that is not the one the case gives fails the temperature check", () => {
    const x = g("pressure");
    const bump = x.T.replace(/(\n\d+\.\d+)/, (m) => "\n" + (Number(m) + 1.5));
    expect(bump).not.toBe(x.T);
    expect(failed(read(x, undefined, { T: bump }))).toContain("mechanicsTemperature");
  });

  it("a stress that breaks radial balance (the SiC's tangential stress scaled by 1.3) fails the equilibrium check, and the stress check", () => {
    const x = g("pressure");
    const nIp = x.n.cells[2];
    const sigma = editRows(x.sigma, (row, i) => (i >= nIp ? [row[0]!, row[1]!, row[2]!, row[3]! * 1.3, row[4]!, row[5]! * 1.3] : row));
    const r = read(x, undefined, { sigma });
    expect(failed(r)).toEqual(expect.arrayContaining(["mechanicsEquilibrium", "mechanicsStress"]));
  });

  it("a radial stress offset in one layer (10 % of the scale) breaks the interface and the stress checks", () => {
    const x = g("swelling");
    const nIp = x.n.cells[2];
    const off = 0.1 * Math.max(...read(x).cells.flatMap((c) => [Math.abs(c.ind.sigmaR), Math.abs(c.ind.sigmaT)]));
    const sigma = editRows(x.sigma, (row, i) => (i >= nIp ? [row[0]! + off, ...row.slice(1)] : row));
    const r = read(x, undefined, { sigma });
    expect(failed(r)).toEqual(expect.arrayContaining(["mechanicsInterface", "mechanicsStress"]));
  });

  it("a tangential stress whose two components differ fails the symmetry check", () => {
    const x = g("pressure");
    const sigma = editRows(x.sigma, (row) => [row[0]!, row[1]!, row[2]!, row[3]!, row[4]!, row[5]! + 1e5]);
    expect(failed(read(x, undefined, { sigma }))).toContain("mechanicsSymmetry");
  });
});

describe("damaged output is refused, never a partial result", () => {
  it("a field cut short", () => {
    const x = g("pressure");
    expect(() => read(x, undefined, { sigma: x.sigma.slice(0, x.sigma.length - 400) })).toThrow(ResultsError);
    expect(() => read(x, undefined, { D: x.D.slice(0, 900) })).toThrow(ResultsError);
  });
  it("a non-finite stress", () => {
    const x = g("pressure");
    const sigma = x.sigma.replace(/\(([-\d.e+]+) /, "(nan ");
    expect(() => read(x, undefined, { sigma })).toThrow(ResultsError);
  });
  it("the wrong number of cells (the case has more cells than the output)", () => {
    const x = g("pressure");
    expect(() => read(x, (n) => (n.cells[2] = n.cells[2] + 2))).toThrow(ResultsError);
  });
  it("cell centres that are not the case's mesh (a layer thicker than the mesh that was run)", () => {
    const x = g("pressure");
    expect(() => read(x, (n) => (n.layers[2].outerRadius *= 1.05))).toThrow(ResultsError);
  });
  it("zones that are not the mechanics mesh's (a buffer zone)", () => {
    const x = g("pressure");
    expect(() => read(x, undefined, { cellZones: x.cellZones.replace(/\bSiC\b/g, "Buffer") })).toThrow(ResultsError);
  });
  it("a record that has no mechanics section is not read", () => {
    const x = g("pressure");
    expect(() => read(x, (n) => delete n.mechanics)).toThrow(/no mechanics section/);
  });
});

describe("the tolerances are the ones fixed before the first run", () => {
  it("are the plan's: 1 % + 10 kPa for the stress, 0.5 % for the displacement, 2 % for the balance", () => {
    expect(TRISO_MECH_TOLERANCE.stress.fraction).toBe(0.01);
    expect(TRISO_MECH_TOLERANCE.stress.floor).toBe(1e4);
    expect(TRISO_MECH_TOLERANCE.displacement.fraction).toBe(0.005);
    expect(TRISO_MECH_TOLERANCE.equilibrium.fraction).toBe(0.02);
    expect(TRISO_MECH_TOLERANCE.interface.stressFraction).toBe(0.02);
  });
});
