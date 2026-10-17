// Plan 14, stage E (M1/M2), ungated: the particle's `mechanics` section as the validator reads it, the constants OFFBEAT is given (worked by hand here), the files the writer writes, the
// run manager reading a real saved run back, and that the thermal particle is untouched. The independent solution has its own tests (tests/layeredSphere.test.ts); the real solver's
// output is judged in tests/trisoMechanicsResults.test.ts.
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { trisoClosedForm } from "../src/core/trisoSolve";
import { TRISO_MECH_FLUX, TRISO_MECH_WEDGE_SCALE, trisoMechanicsBlockMeshDict, trisoMechanicsCells, trisoMechanicsTemperatures, writeTrisoMechanicsCase, writeTrisoParticleCase } from "../src/core/trisoMechanicsWriter";
import { trisoLayerTemperature, trisoMechanicsConstants } from "../src/core/trisoMechanics";
import type { TrisoMechanicsResultsRecord } from "../src/core/trisoMechanicsResults";
import { validateCase } from "../src/core/validate";
import { check } from "../src/server/server";
import { FakeBackend, Script } from "./helpers/fakeBackend";

const root = join(__dirname, "..");
const vec = (name: string, dir = "good") => JSON.parse(readFileSync(join(root, "schema", "vectors", dir, name + ".json"), "utf8"));
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.triso!;
};
const q = (value: number, unit: string) => ({ value, unit });

describe("the mechanics section", () => {
  it("is read into SI: pressures in Pa, the free strains per layer, the laws of the three shells from the inside outward", () => {
    const n = norm(vec("triso-mechanics-anisotropic"));
    const m = n.mechanics!;
    expect(m.referenceTemperature).toBe(300);
    expect(m.gasPressure).toBe(10e6);
    expect(m.outsidePressure).toBe(0.1e6);
    expect(m.freeStrains.map((f) => [f.layer, f.radial, f.tangential])).toEqual([["ipyc", -0.012, 0.004], ["opyc", -0.01, -0.01]]);
    expect(m.layers.map((l) => l.name)).toEqual(["ipyc", "sic", "opyc"]);
    expect(m.layers[0]!.props.elasticity).toEqual({ kind: "constant", E: 3.96e10, nu: 0.33 });
    expect(m.layers[1]!.props.elasticity).toEqual({ kind: "constant", E: 4.0e11, nu: 0.13 });
  });

  it("a pressure of 0 outside and no gas pressure are a valid case: the stress is the thermal one", () => {
    const n = norm(vec("triso-mechanics-thermal"));
    expect(n.mechanics!.gasPressure).toBe(0);
    expect(n.mechanics!.outsidePressure).toBe(0);
    expect(n.mechanics!.gasPressureSource).toBeUndefined();
  });

  it("a case that asks for mechanics with a set missing is refused, naming the set, the material and the layer", () => {
    const bad = vec("triso-mechanics-no-elasticity", "bad");
    const v = validateCase(bad);
    expect(v.ok).toBe(false);
    const e = v.errors.find((x) => x.field === "/materials/ipyc/sets/mechanical.elasticity")!;
    expect(e.code).toBe("E_PROP_MISSING");
    expect(e.message).toContain("mechanical.elasticity");
    expect(e.message).toContain("'" + bad.materials.ipyc.materialId + "'");
    expect(e.message).toContain("ipyc");
    const x = validateCase(vec("triso-mechanics-no-expansion", "bad")).errors.find((e2) => e2.field === "/materials/sic/sets/mechanical.thermalExpansion")!;
    expect(x.message).toMatch(/mechanical\.thermalExpansion/);
    expect(x.message).toContain("sic");
  });

  it("every layer the particle has needs its sets (the buffer's are not needed: it carries no load), and none is defaulted", () => {
    const d = vec("triso-mechanics-pressure");
    for (const layer of ["ipyc", "sic"]) {
      for (const set of ["mechanical.elasticity", "mechanical.thermalExpansion"]) {
        const c = JSON.parse(JSON.stringify(d));
        delete c.materials[layer].sets[set];
        expect(validateCase(c).errors.map((e) => e.code + " " + e.field), layer + " " + set).toEqual(["E_PROP_MISSING /materials/" + layer + "/sets/" + set]);
      }
    }
    // the buffer has none and the case is valid; a buffer set that is present is still checked
    expect(validateCase(d).ok).toBe(true);
    const withBuffer = JSON.parse(JSON.stringify(d));
    withBuffer.materials.buffer.sets["mechanical.elasticity"] = { model: "constant", youngModulus: q(1e4, "MPa"), poissonRatio: q(0.6, "1"), source: "x" };
    expect(validateCase(withBuffer).errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
  });

  it("is refused for a transient and with temperature limits, and the thermal-only flag and the section go together", () => {
    expect(validateCase(vec("triso-mechanics-with-transient", "bad")).errors.map((e) => e.code + " " + e.field)).toEqual(["E_UNSUPPORTED /mechanics"]);
    expect(validateCase(vec("triso-mechanics-with-limits", "bad")).errors.map((e) => e.code + " " + e.field)).toEqual(["E_UNSUPPORTED /limits"]);
    expect(validateCase(vec("triso-mechanics-flag-without-section", "bad")).errors.map((e) => e.code + " " + e.field)).toEqual(["E_PROP_MISSING /mechanics"]);
    expect(validateCase(vec("triso-mechanics-section-with-thermal-only", "bad")).errors.map((e) => e.code + " " + e.field)).toEqual(["E_SCHEMA_INVALID /mechanics"]);
  });

  it("a history, a gas inventory, a swelling correlation and a pin's keys are refused by name, never silently ignored", () => {
    for (const [name, field] of [["triso-mechanics-history", "history"], ["triso-mechanics-gas-inventory", "gasInventory"], ["triso-mechanics-swelling-correlation", "swelling"]] as const) {
      const e = validateCase(vec(name, "bad")).errors;
      expect(e.map((x) => x.code + " " + x.field), name).toEqual(["E_UNSUPPORTED /mechanics/" + field]);
      expect(e[0]!.message).toMatch(/stage I|not built|state/);
    }
    for (const key of ["plane", "contact", "coolantPressure", "internalPressure", "stressLimits", "failure"]) {
      const c = vec("triso-mechanics-pressure");
      c.mechanics[key] = {};
      expect(validateCase(c).errors.map((x) => x.code + " " + x.field), key).toEqual(["E_UNSUPPORTED /mechanics/" + key]);
    }
  });

  it("warns, not refuses, when a layer runs outside the range of a law, and the warning names the layer and the set", () => {
    const v = validateCase(vec("triso-mechanics-range-warning"));
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.field)).toEqual([
      "/materials/ipyc/sets/mechanical.elasticity",
      "/materials/ipyc/sets/mechanical.thermalExpansion",
      "/materials/opyc/sets/mechanical.elasticity",
      "/materials/opyc/sets/mechanical.thermalExpansion",
    ]);
  });
});

describe("the section's bounds", () => {
  const ok = () => vec("triso-mechanics-pressure");
  const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);
  it("a gas pressure above 1 GPa, an outside pressure above it and a reference temperature above 10000 K are out of range; an outside pressure of 0 is valid", () => {
    const g = ok();
    g.mechanics.gasPressure.pressure = q(2, "GPa");
    expect(codes(g)).toEqual(["E_OUT_OF_RANGE /mechanics/gasPressure/pressure"]);
    const o = ok();
    o.mechanics.outsidePressure = q(2, "GPa");
    expect(codes(o)).toEqual(["E_OUT_OF_RANGE /mechanics/outsidePressure"]);
    const t = ok();
    t.mechanics.referenceTemperature = q(20000, "K");
    expect(codes(t)).toEqual(["E_OUT_OF_RANGE /mechanics/referenceTemperature"]);
    const z = ok();
    z.mechanics.outsidePressure = q(0, "MPa");
    expect(codes(z)).toEqual([]);
  });
  it("a free strain of exactly the bound is accepted and a positive one beyond it is refused", () => {
    const f = ok();
    f.mechanics.freeStrains = [{ layer: "ipyc", radial: q(0.2, "1"), tangential: q(-0.2, "1"), source: "x" }];
    expect(codes(f)).toEqual([]);
    f.mechanics.freeStrains[0].tangential = q(0.21, "1");
    expect(codes(f)).toEqual(["E_OUT_OF_RANGE /mechanics/freeStrains/0/tangential"]);
  });
});

describe("the constants OFFBEAT is given", () => {
  it("constant laws are written as they are; the expansion of a constant coefficient is itself", () => {
    const ks = trisoMechanicsConstants(norm(vec("triso-mechanics-pressure")));
    expect(ks.map((k) => k.name)).toEqual(["ipyc", "sic"]);
    expect(ks[0]).toMatchObject({ E: 3.96e10, nu: 0.33 });
    expect(ks[1]).toMatchObject({ E: 4.0e11, nu: 0.13 });
    // the mean strain of a constant coefficient over the layer, divided by the mean temperature rise, is the coefficient (to the rounding of the quadrature)
    expect(Math.abs(ks[0]!.alpha / 5.5e-6 - 1)).toBeLessThan(1e-9);
    expect(Math.abs(ks[1]!.alpha / 4.9e-6 - 1)).toBeLessThan(1e-9);
    expect(ks[0]!.G).toBeCloseTo(3.96e10 / (2 * 1.33), 3);
  });

  it("a linear law is taken at the layer's volume-weighted mean temperature, and the coefficient is the one of the same mean thermal strain (worked here by quadrature)", () => {
    const d = vec("triso-mechanics-library");
    const n = norm(d);
    const cf = trisoClosedForm(n);
    const k = trisoMechanicsConstants(n, cf)[0]!; // the inner carbon: E = a + b T, alpha = a + b T
    // the library's carbon, from its file: E(T) and alpha(T), as the case holds them
    const E = d.materials.ipyc.sets["mechanical.elasticity"];
    const X = d.materials.ipyc.sets["mechanical.thermalExpansion"].linearExpansion;
    const l = n.layers[1]!;
    let w = 0;
    let sT = 0;
    let sStrain = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const r = l.innerRadius + ((i + 0.5) * (l.outerRadius - l.innerRadius)) / N;
      const T = trisoLayerTemperature(n, cf, 1, r);
      // the strain from 300 K: the integral of a + b T' from 300 K to T
      const strain = X.a.value * (T - 300) + 0.5 * X.b.value * (T * T - 300 * 300);
      w += r * r;
      sT += r * r * T;
      sStrain += r * r * strain;
    }
    const meanT = sT / w;
    expect(Math.abs(k.meanTemperature - meanT)).toBeLessThan(1e-4);
    expect(Math.abs(k.E / (E.a.value + E.b.value * meanT) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(k.alpha / (sStrain / w / (meanT - 300)) - 1)).toBeLessThan(1e-6);
  });

  it("the temperature in a layer is the layer's own side of an interface (not the gap's other side) and falls outward", () => {
    const n = norm(vec("triso-mechanics-pressure"));
    const cf = trisoClosedForm(n);
    const l = n.layers[1]!;
    expect(trisoLayerTemperature(n, cf, 1, l.innerRadius)).toBeCloseTo(cf.regions[2]!.innerT, 9);
    expect(trisoLayerTemperature(n, cf, 1, l.outerRadius)).toBeCloseTo(cf.regions[2]!.outerT, 9);
    // the buffer's side is hotter than the carbon's by the gap's drop: the mechanics uses the carbon's
    expect(cf.regions[1]!.outerT - cf.regions[2]!.innerT).toBeCloseTo(cf.gapDeltaT, 9);
  });
});

describe("the files written for the mechanics of a particle", () => {
  const n = norm(vec("triso-mechanics-anisotropic"));
  const w = writeTrisoMechanicsCase(n);

  it("a case with the section takes the mechanics writer and one without it the thermal writer", () => {
    expect(writeTrisoParticleCase(n).files["constant/solverDict"]).toContain("smallStrain");
    expect(writeTrisoParticleCase(norm(vec("triso-steady"))).files["constant/solverDict"]).toContain("mechanicsSolver         fromLatestTime");
  });

  it("meshes the three coating shells only, on a wedge whose vertices lie on the spheres of the layer radii", () => {
    const mesh = trisoMechanicsBlockMeshDict(n);
    expect(mesh).toMatch(/hex \( 0 1 2 3 4 5 6 7 \) IPyC \(1 1 12\)/);
    expect(mesh).toMatch(/hex \( 4 5 6 7 8 9 10 11 \) SiC \(1 1 16\)/);
    expect(mesh).toMatch(/hex \( 8 9 10 11 12 13 14 15 \) OPyC \(1 1 12\)/);
    expect(mesh).not.toContain("Kernel");
    expect(mesh).not.toContain("Buffer");
    const verts = [...mesh.slice(mesh.indexOf("vertices"), mesh.indexOf("blocks")).matchAll(/\(([-\d.e]+) ([-\d.e]+) ([-\d.e]+)\)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    expect(verts).toHaveLength(16);
    const radii = [350, 390, 425, 460];
    verts.forEach((p, i) => expect(Math.hypot(p[0]!, p[1]!, p[2]!)).toBeCloseTo(radii[Math.floor(i / 4)]!, 9));
    expect(TRISO_MECH_WEDGE_SCALE).toBeGreaterThan(0.99998);
    for (const patch of ["top", "front", "back", "bottom", "inner", "outer"]) expect(mesh).toContain("    " + patch + "\n");
  });

  it("gives the temperature of every cell from the closed form at the cell's centroid, and tells the solver to keep it", () => {
    const T = trisoMechanicsTemperatures(n);
    expect(T).toHaveLength(12 + 16 + 12);
    const cells = trisoMechanicsCells(n);
    expect(cells[0]).toMatchObject({ layer: "ipyc" });
    const cf = trisoClosedForm(n);
    // the first cell of the inner carbon: its centroid is 3/4 (b^4 - a^4)/(b^3 - a^3), by hand
    const a = 350e-6;
    const b = a + 40e-6 / 12;
    const c = (0.75 * (b ** 4 - a ** 4)) / (b ** 3 - a ** 3);
    expect(Math.abs(T[0]! - trisoLayerTemperature(n, cf, 1, c))).toBeLessThan(1e-9);
    expect(T[0]!).toBeLessThan(cf.regions[2]!.innerT);
    expect(T[0]!).toBeGreaterThan(cf.regions[2]!.outerT);
    expect(w.files["constant/solverDict"]).toContain("thermalSolver           constant;");
    const field = w.files["0/T"]!;
    expect(field).toContain("List<scalar>\n40\n(");
  });

  it("puts the inner patch on the inside face of the first block and the outer patch on the outside face of the last, and gives the faces the closed form's temperatures", () => {
    const mesh = trisoMechanicsBlockMeshDict(n);
    expect(mesh).toMatch(/inner\s*\{\s*type patch;\s*faces\s*\(\s*\(0 1 2 3\)\s*\);/);
    expect(mesh).toMatch(/outer\s*\{\s*type patch;\s*faces\s*\(\s*\(12 13 14 15\)\s*\);/);
    const cf = trisoClosedForm(n);
    const T = w.files["0/T"]!;
    const block = (name: string) => T.slice(T.indexOf("    " + name + "\n    {"));
    expect(block("inner")).toContain("value           uniform " + cf.regions[2]!.innerT + ";");
    expect(block("outer")).toContain("value           uniform " + cf.wallT + ";");
  });

  it("one step of 10 s, a flux table that runs past the end time (OFFBEAT aborts on a table point equal to it), a displacement criterion in fvSolution", () => {
    expect(w.files["system/controlDict"]).toMatch(/deltaT\s+10;/);
    expect(w.files["system/controlDict"]).toMatch(/writeInterval\s+1;/);
    expect(w.files["constant/solverDict"]).toContain("timePoints  (0 20);");
    expect(w.files["constant/solverDict"]).toContain("fastFlux    (100000000000000000000 100000000000000000000);");
    expect(w.files["system/fvSolution"]).toMatch(/stressAnalysis/);
  });

  it("states the pressures on the inner and outer patch and the Tref and the thermal expansion", () => {
    const D = w.files["0/D"]!;
    expect(D).toMatch(/outer\s*\{[^}]*pressure\s+uniform 100000;/);
    expect(D).toMatch(/inner\s*\{[^}]*pressure\s+uniform 10000000;/);
    const s = w.files["constant/solverDict"]!;
    expect(s).toContain("thermalExpansion on;");
    expect(s).toMatch(/Tref\s+Tref\s+\[0 0 0 1 0\]\s+300;/);
  });

  it("writes a free strain through the PyC swelling polynomial at one unit of fluence, only for the layers that have one", () => {
    const s = w.files["constant/solverDict"]!;
    expect(s).toContain("fastFlux                timeDependentAxialProfile;");
    expect(s).toContain("radialCoefficients          (-0.012 0 0 0 0 0);");
    expect(s).toContain("tangentialCoefficients      (0.004 0 0 0 0 0);");
    expect(s).toContain("radialCoefficients          (-0.01 0 0 0 0 0);");
    expect(s).toContain("materials (IPyC SiC OPyC);");
    // the SiC has no free strain: a constant material
    expect(s.match(/swellingModel\s+PyCCorrelation/g)).toHaveLength(2);
    expect(s).toMatch(/SiC\s*\{\s*material constant;/);
    // the fluence of the step is one unit of the polynomial: 1e25 n/m2 = 1e21 n/cm2 = flux x 10 s
    expect(TRISO_MECH_FLUX * 10).toBe(1e21);
    expect(w.files["system/controlDict"]).toMatch(/endTime\s+10;/);
    // without a free strain no flux model is asked for and no swelling material is written
    const p = writeTrisoMechanicsCase(norm(vec("triso-mechanics-pressure"))).files["constant/solverDict"]!;
    expect(p).toContain("fastFlux                none;");
    expect(p).not.toContain("PyCCorrelation");
  });

  it("the mapping says what was written and where, with every source", () => {
    const text = JSON.stringify(w.mapping);
    expect(text).toContain("freeStrains.ipyc");
    expect(text).toContain("synthetic: an input chosen for the closed-form oracle");
    expect(text).toContain("mechanics.gasPressure");
    expect(w.placeholders.length).toBeGreaterThan(0);
    expect(w.files["system/fvSolution"]).toContain("D ");
  });
});

describe("the run manager reads a real saved run back", () => {
  const manager = (script: Script) => {
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-trisomech-"));
    return { runsRoot, mgr: new RunManager({ runsRoot, backend: new FakeBackend(script) }) };
  };
  const swelling = () => vec("triso-mechanics-swelling");

  it("completes a mechanics run: the displacement's convergence is judged (the temperatures were given), results.json is the mechanics record", async () => {
    const { mgr } = manager("triso-mech-good");
    const s = mgr.start(swelling());
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const rec = await mgr.done(s.id);
    expect(rec.state, JSON.stringify(rec.failure)).toBe("completed");
    const r = mgr.results(s.id) as unknown as TrisoMechanicsResultsRecord;
    expect(r.kind).toBe("triso-mechanics");
    expect(r.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    expect(r.summary.sicPeakTangential).toBeLessThan(0);
    expect(r.text).toMatch(/Elastic, steady/);
  });

  it("fails a run whose displacement did not converge (nothing judges the temperature, but the displacement is judged)", async () => {
    const { mgr } = manager("triso-mech-unconverged");
    const s = mgr.start(swelling());
    if (!s.ok) throw new Error("not started");
    const rec = await mgr.done(s.id);
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_NOT_CONVERGED");
  });

  it("fails a run whose stress field was not collected, in the run manager's own words", async () => {
    const { mgr } = manager("triso-mech-no-sigma");
    const s = mgr.start(swelling());
    if (!s.ok) throw new Error("not started");
    const rec = await mgr.done(s.id);
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_OUTPUT_INCOMPLETE");
    expect(rec.failure!.message).toMatch(/stress \(sigma\)/);
  });
});

describe("the editor's check and the thermal particle", () => {
  it("the check accepts a mechanics particle and carries it", () => {
    const r = check(vec("triso-mechanics-swelling")) as { ok: boolean; errors: unknown[]; triso?: { normalized: { mechanics?: { gasPressure: number } } } };
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.triso!.normalized.mechanics!.gasPressure).toBe(25e6);
  });
});
