// Plan 14, stage E: a test for every survivor of the first mutation run of the new code (scripts/mut-triso-e.cjs: 141 mutants, 27 survived). Each test below is named by the survivor it
// kills; the survivors that are equivalent (below the stated tolerance, or unreachable) are listed in docs/plans/14-triso-mechanics.md and not tested here.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ResultsError } from "../src/core/resultsParser";
import { buildTrisoMechanicsResults, TRISO_MECH_TOLERANCE, TrisoMechanicsInput } from "../src/core/trisoMechanicsResults";
import { trisoMechanicsConstants } from "../src/core/trisoMechanics";
import { trisoMechanicsBlockMeshDict, writeTrisoMechanicsCase, TRISO_MECH_WEDGE_HALF } from "../src/core/trisoMechanicsWriter";
import { trisoClosedForm } from "../src/core/trisoSolve";
import { validateCase } from "../src/core/validate";

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
  return { n: JSON.parse(f("normalized.json")), T: f("T"), C: f("C"), D: f("D"), sigma: f("sigma"), eps: has("epsilonSwelling") ? f("epsilonSwelling") : undefined, cellZones: f("cellZones"), run: JSON.parse(f("run.json")) as { time: number } };
};
type G = ReturnType<typeof g>;
const read = (x: G, mutate?: (n: any) => void, over: Partial<TrisoMechanicsInput> = {}) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildTrisoMechanicsResults(n, { T: x.T, C: x.C, D: x.D, sigma: x.sigma, ...(x.eps !== undefined ? { epsilonSwelling: x.eps } : {}), cellZones: x.cellZones, time: x.run.time, ...over });
};
const failed = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);

/** The head of a list field: its start, the end of its rows, and the rows. */
function rowsOf(text: string) {
  const head = /internalField\s+nonuniform\s+List<\w+>\s*\d+\s*\(\s*\n/.exec(text)!;
  const start = head.index + head[0].length;
  const end = text.indexOf("\n)", start);
  return { head, start, end, rows: text.slice(start, end).split("\n").map((l) => l.trim()) };
}
function editRows(text: string, fn: (row: number[], i: number) => number[]): string {
  const { start, end, rows } = rowsOf(text);
  const out = rows.map((l, i) => {
    const vals = l.startsWith("(") ? l.slice(1, -1).trim().split(/\s+/).map(Number) : [Number(l)];
    const nv = fn(vals, i);
    return l.startsWith("(") ? "(" + nv.join(" ") + ")" : String(nv[0]);
  });
  return text.slice(0, start) + out.join("\n") + text.slice(end);
}
/** The list field with its last row removed and its count lowered by one. */
function dropLastRow(text: string): string {
  const { head, start, end, rows } = rowsOf(text);
  const count = rows.length;
  const header = head[0].replace(String(count), String(count - 1));
  return text.slice(0, head.index) + header + rows.slice(0, -1).join("\n") + text.slice(end);
}
/** One zone's labels of the cellZones text, edited. The count is rewritten to match. */
function editZone(text: string, zone: string, fn: (labels: number[]) => number[]): string {
  const re = new RegExp(zone + "\\s*\\{\\s*type cellZone;\\s*cellLabels\\s+List<label>\\s*\\d+\\s*\\(([^)]*)\\)\\s*;");
  const m = re.exec(text)!;
  const labels = fn(m[1]!.trim().split(/\s+/).map(Number));
  const nl = String.fromCharCode(10);
  return text.replace(re, zone + nl + "{" + nl + "    type cellZone;" + nl + "cellLabels      List<label> " + nl + labels.length + nl + "(" + nl + labels.join(nl) + nl + ")" + nl + ";");
}

describe("results reader: input it must refuse (mutation survivors)", () => {
  const x = g("pressure");
  it("a temperature that is not above 0 K", () => {
    expect(() => read(x, undefined, { T: x.T.replace(/\n1000\.\d+/, "\n-5") })).toThrow(/not above 0 K/);
  });
  it("a final time that is not a positive finite number", () => {
    expect(() => read(x, undefined, { time: 0 })).toThrow(/final time/);
    expect(() => read(x, undefined, { time: Number.NaN })).toThrow(/final time/);
  });
  it("a T field with a cell fewer than the case's mesh, and a C field with a cell fewer than T", () => {
    expect(() => read(x, undefined, { T: dropLastRow(x.T), C: dropLastRow(x.C) })).toThrow(/expected 28 cells/);
    expect(() => read(x, undefined, { C: dropLastRow(x.C) })).toThrow(/T has 28 cells but C has 27/);
  });
  it("a zone with a cell fewer than the case's layer", () => {
    expect(() => read(x, undefined, { cellZones: editZone(x.cellZones, "IPyC", (l) => l.slice(0, -1)) })).toThrow(/has 11 cells, the case has 12/);
  });
  it("a cell that is in two zones", () => {
    // the carbon's last label becomes the SiC's first cell: the counts are right, the zones overlap
    expect(() => read(x, undefined, { cellZones: editZone(x.cellZones, "IPyC", (l) => [...l.slice(0, -1), 12]) })).toThrow(/is in two zones/);
  });
  it("a zone that is not a layer of the mechanics mesh, beside the right ones", () => {
    const nl = String.fromCharCode(10);
    const extra = x.cellZones.replace(nl + "SiC" + nl + "{", nl + "Kernel" + nl + "{" + nl + "    type cellZone;" + nl + "cellLabels      List<label> " + nl + "1" + nl + "(" + nl + "0" + nl + ")" + nl + ";" + nl + "}" + nl + nl + "SiC" + nl + "{");
    expect(extra).not.toBe(x.cellZones);
    expect(() => read(x, undefined, { cellZones: extra })).toThrow(/not a layer of this mechanics mesh/);
  });
});

describe("results checks: each part of a check does its own work (mutation survivors)", () => {
  it("the radial component of a free strain is compared, not only the tangential", () => {
    const x = g("swelling");
    const nIp = x.n.cells[2];
    const eps = editRows(x.eps!, (row, i) => (i < nIp ? [row[0]! + 0.001, ...row.slice(1)] : row));
    expect(failed(read(x, undefined, { epsilonSwelling: eps }))).toContain("mechanicsFreeStrain");
  });

  it("the interface check judges the displacement too: the SiC's displacement 2 % off breaks it (the bound is 0.5 %)", () => {
    const x = g("swelling");
    const nIp = x.n.cells[2];
    const D = editRows(x.D, (row, i) => (i >= nIp ? row.map((v) => v * 1.02) : row));
    expect(failed(read(x, undefined, { D }))).toContain("mechanicsInterface");
    expect(failed(read(x))).toEqual([]);
  });

  it("the stress scale of a layer with a small stress still has the thermal floor of 1 % of E alpha dT, not 100 %: an outer carbon (0.7 MPa of stress) 150 kPa off fails", () => {
    const x = g("thermal");
    const nFirst = x.n.cells[2] + x.n.cells[3];
    const sigma = editRows(x.sigma, (row, i) => (i >= nFirst ? [row[0]!, row[1]!, row[2]!, row[3]! + 1.5e5, row[4]!, row[5]! + 1.5e5] : row));
    expect(failed(read(x, undefined, { sigma }))).toContain("mechanicsStress");
  });

  it("the wedge allowance is in the stress bound: a SiC tangential stress off by the bound without it plus half the allowance still passes, and a stress off by twice the allowance beyond fails", () => {
    const x = g("thermal");
    const base = read(x);
    const ks = trisoMechanicsConstants(x.n);
    const sic = ks.find((k) => k.name === "sic")!;
    const cells = base.cells.filter((c) => c.layer === "sic");
    const stressMax = Math.max(...cells.flatMap((c) => [Math.abs(c.ind.sigmaR), Math.abs(c.ind.sigmaT)]));
    const dTmax = Math.max(...cells.map((c) => Math.abs(c.T - x.n.mechanics.referenceTemperature)));
    const scale = Math.max(stressMax, TRISO_MECH_TOLERANCE.stress.thermalFraction * sic.E * sic.alpha * dTmax);
    const allowance = TRISO_MECH_TOLERANCE.stress.wedgeAllowance * TRISO_MECH_WEDGE_HALF ** 2 * (sic.E / (1 - sic.nu)) * sic.alpha * dTmax;
    expect(allowance).toBeGreaterThan(2e4); // the allowance is a stress that matters here
    const bound = TRISO_MECH_TOLERANCE.stress.fraction * scale + TRISO_MECH_TOLERANCE.stress.floor;
    const nIp = x.n.cells[2];
    const nSic = x.n.cells[3];
    const shift = (d: number) => editRows(x.sigma, (row, i) => (i >= nIp && i < nIp + nSic ? [row[0]!, row[1]!, row[2]!, row[3]! + d, row[4]!, row[5]! + d] : row));
    expect(failed(read(x, undefined, { sigma: shift(bound + 0.5 * allowance) }))).not.toContain("mechanicsStress");
    expect(failed(read(x, undefined, { sigma: shift(bound + 2 * allowance) }))).toContain("mechanicsStress");
  });

  it("the domain: a law used outside its range is a finding naming the layer, and the verdict says out-of-domain; a case in range says in-domain", () => {
    const lib = g("library");
    const r = read(lib, (n) => {
      n.mechanics.layers[0].props.elasticity.range = [1500, 1600];
    });
    expect(r.domain.verdict).toBe("out-of-domain");
    expect(r.domain.findings.some((f) => f.layer === "ipyc" && /Young's modulus/.test(f.what))).toBe(true);
    // the library case's carbon expansion is stated from 873 K and the reference temperature is 300 K: out of domain on its own account
    expect(read(lib).domain.verdict).toBe("out-of-domain");
    expect(read(g("pressure")).domain).toEqual({ verdict: "in-domain", findings: [] });
  });
});

describe("the validator and the run manager (mutation survivors)", () => {
  it("a buffer with mechanical sets is not a mechanical shell", () => {
    const d = JSON.parse(readFileSync(join(root, "schema", "vectors", "good", "triso-mechanics-pressure.json"), "utf8"));
    d.materials.buffer.sets["mechanical.elasticity"] = { model: "constant", youngModulus: { value: 1e4, unit: "MPa" }, poissonRatio: { value: 0.23, unit: "1" }, source: "x" };
    d.materials.buffer.sets["mechanical.thermalExpansion"] = { linearExpansion: { value: 5e-6, unit: "1/K" }, source: "x" };
    const v = validateCase(d);
    expect(v.errors).toEqual([]);
    expect(v.triso!.mechanics!.layers.map((l) => l.name)).toEqual(["ipyc", "sic"]);
    expect(trisoMechanicsBlockMeshDict(v.triso!)).not.toContain("Buffer");
  });
});

describe("the writer (mutation survivors)", () => {
  const d = JSON.parse(readFileSync(join(root, "schema", "vectors", "good", "triso-mechanics-anisotropic.json"), "utf8"));
  const n = validateCase(d).triso!;
  const w = writeTrisoMechanicsCase(n);
  const ks = trisoMechanicsConstants(n);

  it("the four side planes are wedges", () => {
    const mesh = trisoMechanicsBlockMeshDict(n);
    for (const name of ["top", "front", "back", "bottom"]) expect(mesh).toMatch(new RegExp("    " + name + "\\s*\\{\\s*type wedge;"));
    expect(mesh.match(/type wedge;/g)).toHaveLength(4);
  });

  it("a free-strain layer carries the case's reference temperature and the reduced expansion coefficient", () => {
    const s = w.files["constant/solverDict"]!;
    const block = (zone: string) => {
      const from = s.indexOf("    " + zone + String.fromCharCode(10) + "    {");
      return s.slice(from, s.indexOf(String.fromCharCode(10) + "    }", from));
    };
    const ip = block("IPyC");
    expect(ip).toContain("Tref        Tref  [0 0 0 1 0]    300;");
    expect(ip).toContain("alpha       alpha [0 0 0 0 0]    " + ks[0]!.alpha + ";");
    expect(ip).toContain("E           E     [1 -1 -2 0 0]  " + ks[0]!.E + ";");
    const op = block("OPyC");
    expect(op).toContain("alpha       alpha [0 0 0 0 0]    " + ks[2]!.alpha + ";");
    // the SiC has no free strain: a constant material with its G
    const sic = block("SiC");
    expect(sic).toContain("G           G     [1 -1 -2 0 0]  " + ks[1]!.G + ";");
    expect(sic).toContain("Tref        Tref  [0 0 0 1 0]    300;");
  });

  it("the displacement is relaxed by 0.5 (the settings that converge with a contact), not 0.8", () => {
    expect(w.files["system/fvSolution"]).toContain("fields { D 0.5; }");
  });

  it("the volume-mean temperature of a layer is the closed form's (constant conductivity: T = T_out + c (1/r - 1/b)), to 1e-8 K", () => {
    const cf = trisoClosedForm(n);
    for (const k of ks) {
      const i = n.layers.findIndex((l) => l.name === k.name);
      const reg = cf.regions[i + 1]!;
      const a = k.innerRadius;
      const b = k.outerRadius;
      const c = (reg.innerT - reg.outerT) / (1 / a - 1 / b);
      const mean = reg.outerT - c / b + (c * 1.5 * (b * b - a * a)) / (b ** 3 - a ** 3);
      expect(Math.abs(k.meanTemperature - mean)).toBeLessThan(1e-8);
    }
  });
});
