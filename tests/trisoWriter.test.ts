// Plan 13 T3, ungated: the OFFBEAT case of a particle that FEED writes. The mesh is checked against volumes and areas computed from its own vertices by formulas written here (not the
// writer's), the dictionaries by what they must say, and the wedge's scale by the pyramid it makes.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { SPHERE } from "../src/core/geometry";
import { STEADY_PSEUDO_HEAT_CAPACITY } from "../src/core/steadyState";
import { trisoSteadyEndTime } from "../src/core/trisoSolve";
import { TRISO_WEDGE_AREA_FRACTION, TRISO_WEDGE_SCALE, TRISO_WEDGE_VOLUME_FRACTION, TRISO_WEDGE_HALF_ANGLE_DEG, trisoBlockMeshDict, wedgeEquivalent, writeTrisoCase } from "../src/core/trisoWriter";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const vec = (n: string) => JSON.parse(readFileSync(join(root, "schema", "vectors", "good", n + ".json"), "utf8"));
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.triso!;
};

/** The vertices (micrometres), the blocks (vertex indices, name, cells) and the patches (type, face lists) of a blockMeshDict, read back from its text. */
function readMesh(text: string) {
  const vtxText = /vertices\s*\(([\s\S]*?)\n\);/.exec(text)![1]!;
  const vertices = [...vtxText.matchAll(/\(\s*([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*\)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  const blocks = [...text.matchAll(/hex \( ([\d ]+)\) (\w+) \((\d+) (\d+) (\d+)\) simpleGrading/g)].map((m) => ({ v: m[1]!.trim().split(/\s+/).map(Number), name: m[2]!, cells: [Number(m[3]), Number(m[4]), Number(m[5])] }));
  const patches = new Map<string, { type: string; faces: number[][]; body: string }>();
  for (const m of text.matchAll(/\n    (\w+)\n    \{\n        type (\w+);([\s\S]*?)faces\n        \(\n([\s\S]*?)\n        \);/g)) {
    patches.set(m[1]!, { type: m[2]!, body: m[3]!, faces: [...m[4]!.matchAll(/\(([\d ]+)\)/g)].map((f) => f[1]!.trim().split(/\s+/).map(Number)) });
  }
  return { vertices, blocks, patches };
}

describe("the wedge mesh", () => {
  const n = norm(vec("triso-steady"));
  const mesh = readMesh(trisoBlockMeshDict(n));

  it("has a block per region in micrometres, with the cells of the case along the radius, named like OFFBEAT's cell zones", () => {
    expect(mesh.blocks.map((b) => b.name)).toEqual(["Kernel", "Buffer", "IPyC", "SiC", "OPyC"]);
    expect(mesh.blocks.map((b) => b.cells)).toEqual([[1, 1, 12], [1, 1, 12], [1, 1, 12], [1, 1, 16], [1, 1, 12]]);
    expect(trisoBlockMeshDict(n)).toContain("convertToMeters 1e-06;");
    // 7 levels (the centre, the kernel, the buffer twice, the three outer layers) of 4 vertices
    expect(mesh.vertices).toHaveLength(28);
  });

  it("puts every vertex on the sphere of its radius, so the length of a vertex is the radius of the case (the centre apart)", () => {
    const radii = [0, 250, 350, 350, 390, 425, 460];
    mesh.vertices.forEach((p, i) => expect(Math.hypot(p[0]!, p[1]!, p[2]!), "vertex " + i).toBeCloseTo(radii[Math.floor(i / 4)]!, 9));
    // the four vertices of a level are the corners of a square about the axis
    for (let l = 1; l < 7; l++) {
      const [a, b, c, d] = mesh.vertices.slice(4 * l, 4 * l + 4) as number[][];
      expect(a![0]).toBeCloseTo(b![0]!, 9);
      expect(a![1]).toBeCloseTo(b![1]!, 9);
      expect(a![2]).toBeCloseTo(-b![2]!, 9);
      expect(c![1]).toBeCloseTo(-a![1]!, 9);
      expect(d![1]).toBeCloseTo(-a![1]!, 9);
    }
  });

  it("has the wedge's 2 degrees: the side faces are at 1 degree from the axis in both directions", () => {
    expect(TRISO_WEDGE_HALF_ANGLE_DEG).toBe(1);
    const p = mesh.vertices[4]!; // the kernel's outer level
    expect(Math.atan(p[1]! / p[0]!)).toBeCloseTo((1 * Math.PI) / 180, 12);
    expect(Math.atan(p[2]! / p[0]!)).toBeCloseTo((-1 * Math.PI) / 180, 12);
  });

  it("makes a pyramid whose faces and cells are the fractions of the sphere's that the writer states, and the fractions' ratio is the scale of the sphere it solves", () => {
    // face at level l: a square of side 2 y; block between levels: a frustum of a square pyramid, h/3 (A1 + A2 + sqrt(A1 A2)) with h the distance along the axis
    const level = (l: number) => {
      const p = mesh.vertices[4 * l]!;
      return { x: p[0]!, side: 2 * Math.abs(p[1]!) };
    };
    for (let l = 1; l < 7; l++) {
      const { side } = level(l);
      const r = [0, 250, 350, 350, 390, 425, 460][l]!;
      expect((side * side) / (4 * Math.PI * r * r)).toBeCloseTo(TRISO_WEDGE_AREA_FRACTION, 12);
    }
    // block 1 (the buffer, levels 1 to 2) and block 3 (the SiC, levels 4 to 5)
    for (const [l1, l2, r1, r2] of [[1, 2, 250, 350], [4, 5, 390, 425]] as const) {
      const a = level(l1);
      const b = level(l2);
      const A1 = a.side ** 2;
      const A2 = b.side ** 2;
      const volume = ((b.x - a.x) / 3) * (A1 + A2 + Math.sqrt(A1 * A2));
      expect(volume / ((4 / 3) * Math.PI * (r2 ** 3 - r1 ** 3))).toBeCloseTo(TRISO_WEDGE_VOLUME_FRACTION, 12);
    }
    expect(TRISO_WEDGE_VOLUME_FRACTION / TRISO_WEDGE_AREA_FRACTION).toBeCloseTo(TRISO_WEDGE_SCALE, 14);
    // the numbers of docs/spike/triso-probe.md, measured on OFFBEAT's own mesh: 9.6894e-5 and 9.6923e-5
    expect(TRISO_WEDGE_VOLUME_FRACTION).toBeCloseTo(9.6894e-5, 8);
    expect(TRISO_WEDGE_AREA_FRACTION).toBeCloseTo(9.6923e-5, 8);
    expect(TRISO_WEDGE_SCALE).toBeCloseTo(0.9997, 4);
  });

  it("has the patches: four wedge planes with a face for each block, the outside, and the gap's two faces as coupled patches that name each other", () => {
    for (const side of ["top", "front", "back", "bottom"]) {
      expect(mesh.patches.get(side)!.type, side).toBe("wedge");
      expect(mesh.patches.get(side)!.faces, side).toHaveLength(5);
    }
    expect(mesh.patches.get("outer")!.type).toBe("patch");
    expect(mesh.patches.get("outer")!.faces).toEqual([[24, 25, 26, 27]]);
    const bo = mesh.patches.get("bufferOuter")!;
    const ii = mesh.patches.get("ipycInner")!;
    expect(bo.type).toBe("regionCoupledOFFBEAT");
    expect(ii.type).toBe("regionCoupledOFFBEAT");
    expect(bo.body).toContain("neighbourPatch ipycInner;");
    expect(ii.body).toContain("neighbourPatch bufferOuter;");
    expect(bo.body).toContain("owner true;");
    expect(ii.body).toContain("owner false;");
    // the buffer's outer face is the upper level of block 1 (vertices 8 to 11) and the next layer's inner face the lower level of block 2 (12 to 15): the same radius, separate vertices
    expect(bo.faces).toEqual([[8, 9, 10, 11]]);
    expect(ii.faces).toEqual([[12, 13, 14, 15]]);
    expect(mesh.blocks[1]!.v.slice(4)).toEqual([8, 9, 10, 11]);
    expect(mesh.blocks[2]!.v.slice(0, 4)).toEqual([12, 13, 14, 15]);
    for (let i = 0; i < 4; i++) expect(mesh.vertices[8 + i]).toEqual(mesh.vertices[12 + i]);
  });

  it("the volumes of all the blocks add to the wedge's fraction of the sphere", () => {
    let v = 0;
    for (const [l1, l2] of [[0, 1], [1, 2], [3, 4], [4, 5], [5, 6]] as const) {
      const a = mesh.vertices[4 * l1]!;
      const b = mesh.vertices[4 * l2]!;
      const A1 = (2 * a[1]!) ** 2;
      const A2 = (2 * b[1]!) ** 2;
      v += ((b[0]! - a[0]!) / 3) * (A1 + A2 + Math.sqrt(A1 * A2));
    }
    expect(v).toBeCloseTo(TRISO_WEDGE_VOLUME_FRACTION * (4 / 3) * Math.PI * 460 ** 3, 6);
  });

  it("a two-layer particle has three blocks and ends on the inner carbon", () => {
    const m = readMesh(trisoBlockMeshDict(norm(vec("triso-two-layers"))));
    expect(m.blocks.map((b) => b.name)).toEqual(["Kernel", "Buffer", "IPyC"]);
    expect(m.vertices).toHaveLength(20);
    expect(m.patches.get("outer")!.faces).toEqual([[16, 17, 18, 19]]);
    expect(m.patches.get("ipycInner")!.faces).toEqual([[12, 13, 14, 15]]);
  });
});

describe("the sphere the wedge solves", () => {
  it("has every radius times the scale, the kernel's power density unchanged and the power of the smaller kernel", () => {
    const n = norm(vec("triso-steady"));
    const e = wedgeEquivalent(n);
    expect(e.kernelRadius).toBeCloseTo(n.kernelRadius * TRISO_WEDGE_SCALE, 18);
    expect(e.outerRadius).toBeCloseTo(n.outerRadius * TRISO_WEDGE_SCALE, 18);
    e.layers.forEach((l, i) => {
      expect(l.innerRadius).toBeCloseTo(n.layers[i]!.innerRadius * TRISO_WEDGE_SCALE, 18);
      expect(l.outerRadius).toBeCloseTo(n.layers[i]!.outerRadius * TRISO_WEDGE_SCALE, 18);
    });
    expect(e.power.kernelPowerDensity).toBe(n.power.kernelPowerDensity);
    expect(e.power.particlePower).toBeCloseTo(n.power.kernelPowerDensity * SPHERE.volume(0, e.kernelRadius), 15);
    expect(e.power.particlePower / n.power.particlePower).toBeCloseTo(TRISO_WEDGE_SCALE ** 3, 12);
    // the case's own form is untouched
    expect(n.kernelRadius).toBeCloseTo(250e-6, 18);
  });
});

describe("the dictionaries", () => {
  const n = norm(vec("triso-steady"));
  const w = writeTrisoCase(n);

  it("writes the files of a case, with LF line endings only", () => {
    expect(Object.keys(w.files).sort()).toEqual(["0/D", "0/T", "constant/solverDict", "system/blockMeshDict", "system/controlDict", "system/fvSchemes", "system/fvSolution"]);
    for (const [name, text] of Object.entries(w.files)) expect(text.includes("\r"), name).toBe(false);
  });

  it("switches off everything but the heat: no mechanics, no fission-gas code, no gas model, no burnup; the heat source is a table in the kernel only", () => {
    const s = w.files["constant/solverDict"]!;
    expect(s).toMatch(/mechanicsSolver\s+fromLatestTime;/);
    expect(s).toMatch(/fgr\s+none;/);
    expect(s).toMatch(/gapGas\s+none;/);
    expect(s).toMatch(/burnup\s+none;/);
    expect(s).toMatch(/fastFlux\s+none;/);
    expect(s).toMatch(/heatSource\s+timeDependentVhgr;/);
    expect(s).toMatch(/materialProperties\s+byZone;/);
    expect(s).toContain("materials ( Kernel );");
    expect(s).toMatch(/vhgr\s+\(6e\+8 6e\+8\)|vhgr\s+\(600000000 600000000\)/);
  });

  it("the heat table reaches past the end time (OFFBEAT aborts when a point equals it), and the end time is the particle's steady one", () => {
    const h = trisoSteadyEndTime(n);
    if (!h.ok) throw new Error("not settled");
    const end = Number(/endTime\s+([^;]+);/.exec(w.files["system/controlDict"]!)![1]);
    expect(end).toBe(h.endTime);
    expect(end).toBeGreaterThanOrEqual(5e7);
    const pts = /timePoints\s+\(([^)]*)\)/.exec(w.files["constant/solverDict"]!)![1]!.trim().split(/\s+/).map(Number);
    expect(pts[0]).toBe(0);
    expect(pts[pts.length - 1]!).toBeGreaterThan(end);
    expect(w.choices.endTime).toBe(end);
  });

  it("writes a material for each region under the name of its cell zone, with its own conductivity, and the placeholder capacity of every steady run", () => {
    const s = w.files["constant/solverDict"]!;
    for (const [zone, k] of [["Kernel", 3], ["Buffer", 0.5], ["IPyC", 4], ["SiC", 13.9], ["OPyC", 4]] as const) {
      const block = new RegExp("\\n    " + zone + "\\n    \\{([\\s\\S]*?)\\n    \\}").exec(s);
      expect(block, zone).not.toBeNull();
      expect(block![1]).toMatch(new RegExp("k\\s+k\\s+\\[1 1 -3 -1 0\\]\\s+" + k + ";"));
      expect(block![1]).toContain("material constant;");
      expect(block![1]).toMatch(/rho\s+rho\s+\[1 -3 0 0 0\]\s+10000;/);
      expect(block![1]).toMatch(/Cp\s+Cp\s+\[0 2 -2 -1 0\]\s+300;/);
    }
    expect(10000 * 300).toBe(STEADY_PSEUDO_HEAT_CAPACITY);
  });

  it("writes a temperature-dependent conductivity the way the pin does", () => {
    const t = norm(vec("triso-temperature-dependent"));
    const s = writeTrisoCase(t).files["constant/solverDict"]!;
    expect(s).toContain("conductivityModel steel1515TiTobbe;"); // linear
    expect(s).toContain("conductivityModel SiCPARFUME;"); // reciprocal
    expect(s).toMatch(/par1 17885; par2 2;/);
  });

  it("puts the gap's conductance on both coupled patches as a resistiveGap, and the outside as a fixed temperature or a film", () => {
    const T = w.files["0/T"]!;
    for (const p of ["bufferOuter", "ipycInner"]) {
      const b = new RegExp("\\n    " + p + "\\n    \\{([\\s\\S]*?)\\n    \\}").exec(T)![1]!;
      expect(b).toContain("type            resistiveGap;");
      expect(b).toContain("patchType       regionCoupledOFFBEAT;");
      expect(b).toContain("alpha           uniform 150000;");
      expect(b).toContain("coupled         true;");
    }
    expect(T).toMatch(/outer\s*\{\s*type fixedValue;\s*value uniform 1000;/);
    expect(T).toMatch(/internalField\s+uniform 1000;/);
    expect(T).toContain('"top|bottom|front|back"');
    const film = writeTrisoCase(norm(vec("triso-convective-outside"))).files["0/T"]!;
    expect(film).toMatch(/outer\s*\{\s*type convectiveHTC;\s*T0 uniform 900;\s*h uniform 2000;/);
    expect(film).toMatch(/internalField\s+uniform 900;/);
  });

  it("records where each case field went, and the placeholders", () => {
    const fields = w.mapping.map((m) => m.field);
    expect(fields).toEqual(expect.arrayContaining(["geometry", "geometry.kernelRadius", "geometry.layers.sic.thickness", "mesh.kernelCells", "mesh.opycCells", "power", "gap.conductance", "boundary"]));
    expect(w.placeholders.map((p) => p.name)).toEqual(expect.arrayContaining(["rho, Cp", "initial temperature"]));
  });

  it("refuses a particle that cannot settle rather than writing a short run", () => {
    const slow = { ...n, gapConductance: 1e-12 };
    expect(() => writeTrisoCase(slow)).toThrow(/cannot write a steady particle case/);
  });
});
