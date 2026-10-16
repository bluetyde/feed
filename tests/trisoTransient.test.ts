// Plan 13 T3 stage 3, ungated: the particle's transient. The section as it is read (by hand), the independent solution's boundary table and trace against exact lumped solutions, the
// starting field, and the OFFBEAT case that is written (the heat table, the capacities, the start, the outside's table, the fixed step).
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { SPHERE } from "../src/core/geometry";
import { STEADY_PSEUDO_HEAT_CAPACITY } from "../src/core/steadyState";
import { solveTrisoFv, steadyTrisoFv, trisoClosedForm, trisoModelOf } from "../src/core/trisoSolve";
import { MAX_TRISO_TRANSIENT_WORK, trisoEnergyUntil, trisoPowerAt } from "../src/core/trisoTransient";
import { TRISO_WEDGE_VOLUME_RATIO, computeTrisoIndependent, trisoInitialField, trisoTransientModelOf } from "../src/core/trisoTransientModel";
import { TRISO_WEDGE_SCALE, wedgeEquivalent, writeTrisoCase } from "../src/core/trisoWriter";
import { validateCase } from "../src/core/validate";
import { check } from "../src/server/server";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const vec = (n: string) => JSON.parse(readFileSync(join(root, "schema", "vectors", "good", n + ".json"), "utf8"));
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  expect(v.normalized).toBeUndefined();
  return v.triso!;
};
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);

describe("the section as it is read", () => {
  const n = norm(vec("triso-pulse"));
  it("is the table, the grid, the start and the capacities in SI, and the power is the table's peak", () => {
    const t = n.transient!;
    expect(t.times).toEqual([0, 0.01, 0.02, 0.5]);
    expect(t.particlePower).toEqual([0, 0.4, 0, 0]);
    expect(t.endTime).toBe(0.5);
    expect(t.timeStep).toBeCloseTo(5e-4, 15);
    expect(t.steps).toBe(1000);
    expect(t.outputs).toBe(50);
    expect(t.initial).toEqual({ kind: "uniform", temperature: 1000 });
    expect(t.boundaryHistory).toBeUndefined();
    expect(n.capacities!.map((c) => (c.kind === "constant" ? c.c : NaN))).toEqual([3e6, 1.5e6, 2.5e6, 3.5e6, 2.5e6]);
    expect(n.power.particlePower).toBe(0.4);
    expect(n.power.kernelPowerDensity).toBeCloseTo(0.4 / ((4 / 3) * Math.PI * (250e-6) ** 3), 0);
    expect(n.power.kernelVolume).toBeCloseTo((4 / 3) * Math.PI * (250e-6) ** 3, 22);
  });
  it("a steady start and a table for the outside are read, in SI", () => {
    const m = norm(vec("triso-outside-ramp"));
    expect(m.transient!.initial).toEqual({ kind: "steady", particlePower: 0.2 });
    const h = m.transient!.boundaryHistory!;
    expect(h.kind).toBe("convective");
    expect(h.times).toEqual([0, 0.05, 0.25, 0.5]);
    expect((h as { bulkTemperature: number[] }).bulkTemperature).toEqual([900, 900, 1000, 1000]);
    expect(m.transient!.outputs).toBe(50);
    expect(norm(vec("triso-wall-quench")).transient!.boundaryHistory!.kind).toBe("surface-temperature");
  });
  it("reads the units the case is given in, and a steady case has none of it", () => {
    const d = vec("triso-pulse");
    d.transient.endTime = q(0.5, "s");
    d.transient.timeStep = q(0.0005, "s");
    d.transient.powerHistory[1].particlePower = q(0.0004, "kW");
    expect(norm(d).transient!.particlePower[1]).toBeCloseTo(0.4, 12);
    expect(norm(vec("triso-steady")).transient).toBeUndefined();
    expect(norm(vec("triso-steady")).capacities).toBeUndefined();
  });
  it("a heat capacity set on a steady case is ignored, as a steady pin's is", () => {
    const d = vec("triso-steady");
    d.materials.kernel.sets["thermal.volumetricHeatCapacity"] = { model: "constant", value: q(3, "MJ/m3/K"), referenceTemperature: q(1000, "K"), source: "s" };
    expect(norm(d).capacities).toBeUndefined();
  });
  it("is at the budget of cells x steps and over it", () => {
    expect(MAX_TRISO_TRANSIENT_WORK).toBe(5e5);
    const e = vec("triso-pulse"); // 64 cells
    e.transient.timeStep = q(0.0625, "ms"); // 8000 steps x 64 = 512000, over
    expect(codes(e)).toEqual(["E_TIME /transient/timeStep"]);
    e.transient.timeStep = q(0.0625 * 1.25, "ms"); // 6400 steps x 64 = 409600
    expect(codes(e)).toEqual([]);
    e.transient.timeStep = q(0.1, "ms"); // 5000 steps x 64
    expect(codes(e)).toEqual([]);
    // 7812 steps x 64 cells = 499968 is under, 7813 x 64 = 500032 over: the step 500/7812.5 does not divide, so use the cell count to reach the bound
    const f = vec("triso-pulse");
    f.transient.timeStep = q(0.1, "ms"); // 5000 steps
    f.mesh = { kernelCells: 20, bufferCells: 20, ipycCells: 20, sicCells: 20, opycCells: 20 }; // 100 cells: 5e5, at the bound
    expect(codes(f)).toEqual([]);
    f.mesh.opycCells = 21; // 101 cells: 505000
    expect(codes(f)).toEqual(["E_TIME /transient/timeStep"]);
  });
  it("accepts the editor's check for a transient particle with its numbers", () => {
    const r = check(vec("triso-pulse")) as { ok: boolean; triso: { normalized: { transient: unknown }; derived: { particlePower: number } } };
    expect(r.ok).toBe(true);
    expect(r.triso.normalized.transient).toBeDefined();
    expect(r.triso.derived.particlePower).toBe(0.4);
  });
  it("the steady start has to exist: a conductivity that reaches zero at the start power is refused at the start power", () => {
    const d = vec("triso-outside-ramp");
    d.materials.kernel.sets["thermal.conductivity"] = { model: "linear", a: q(3, "W/m/K"), b: q(-0.002, "W/m/K2"), validRange: { min: q(500, "K"), max: q(1400, "K") }, source: "s" };
    d.transient.initialSteadyParticlePower = q(30, "W");
    d.transient.powerHistory = [{ time: q(0, "ms"), particlePower: q(30, "W") }, { time: q(500, "ms"), particlePower: q(30, "W") }];
    expect(codes(d)).toEqual(["E_OUT_OF_RANGE /materials"]);
  });
});

describe("the table", () => {
  const times = [0, 1, 3, 4];
  const p = [0, 2, 2, 0];
  it("is linear between the points, flat before the first and after the last", () => {
    expect(trisoPowerAt(times, p, 0)).toBe(0);
    expect(trisoPowerAt(times, p, 0.5)).toBe(1);
    expect(trisoPowerAt(times, p, 1)).toBe(2);
    expect(trisoPowerAt(times, p, 2)).toBe(2);
    expect(trisoPowerAt(times, p, 3.5)).toBe(1);
    expect(trisoPowerAt(times, p, 10)).toBe(0);
    expect(trisoPowerAt(times, p, -1)).toBe(0);
  });
  it("integrates exactly: a triangle, a plateau, a triangle", () => {
    expect(trisoEnergyUntil(times, p, 1)).toBe(1);
    expect(trisoEnergyUntil(times, p, 0.5)).toBeCloseTo(0.25, 14);
    expect(trisoEnergyUntil(times, p, 3)).toBe(5);
    expect(trisoEnergyUntil(times, p, 4)).toBe(6);
    expect(trisoEnergyUntil(times, p, 100)).toBe(6);
    expect(trisoEnergyUntil(times, p, 0)).toBe(0);
  });
});

describe("the independent solution with a changing outside, against exact lumped solutions", () => {
  /** A particle so conductive that its temperature is uniform (the Biot number is 1e-4), with constant capacities. */
  const lumped = (boundary: Record<string, unknown>) => {
    const d = vec("triso-pulse");
    for (const r of ["kernel", "buffer", "ipyc", "sic", "opyc"]) d.materials[r].sets["thermal.conductivity"] = { model: "constant", value: q(2000, "W/m/K"), referenceTemperature: q(1000, "K"), source: "s" };
    d.gap.conductance = q(1e8, "W/m2/K");
    d.boundary = boundary;
    d.transient.initialTemperature = q(1000, "K");
    return norm(d);
  };
  const totalCapacity = (n: ReturnType<typeof lumped>) => {
    const e = wedgeEquivalent(n);
    const radii = [0, e.kernelRadius, ...e.layers.map((l) => l.outerRadius)];
    return n.capacities!.reduce((a, c, i) => a + (c.kind === "constant" ? c.c : 0) * SPHERE.volume(radii[i]!, radii[i + 1]!), 0);
  };

  it("with almost no heat leaving, the particle warms linearly: T = T0 + E / C, to 1e-3 K", () => {
    const n = lumped({ bulkTemperature: q(1000, "K"), heatTransferCoefficient: q(1e-3, "W/m2/K") });
    const fv = computeTrisoIndependent(n).fv;
    const C = totalCapacity(n);
    // the energy the implicit step deposits, the source at the end of each step (rectangle on the right), and the exact integral
    const t = n.transient!;
    const k = fv.states.length - 1;
    const E = trisoEnergyUntil(t.times, t.particlePower, fv.states[k]!.time) * TRISO_WEDGE_VOLUME_RATIO;
    const last = fv.states[k]!.T;
    const mean = last.reduce((a, x) => a + x, 0) / last.length;
    expect(mean - 1000).toBeGreaterThan(3);
    // the source of a step is taken at its end: over the 20-step up-ramp that is 1/N = 5 % more than the integral, over the down-ramp 5 % less, so the symmetric pulse deposits its integral by the end
    const sumTo = (steps: number) => {
      let e = 0;
      for (let s = 1; s <= steps; s++) e += trisoPowerAt(t.times, t.particlePower, s * t.timeStep) * TRISO_WEDGE_VOLUME_RATIO * t.timeStep;
      return e;
    };
    expect(Math.abs(1000 + sumTo(t.steps) / C - mean)).toBeLessThan(1e-3);
    expect(sumTo(t.steps) / E - 1).toBeCloseTo(0, 12);
    const mid = fv.states[fv.states.length > 2 ? 1 : 0]!;
    expect(mid.time).toBeCloseTo(0.01, 12);
    expect(sumTo(20) / (trisoEnergyUntil(t.times, t.particlePower, 0.01) * TRISO_WEDGE_VOLUME_RATIO) - 1).toBeCloseTo(0.05, 12);
    expect(mid.deposited / sumTo(20) - 1).toBeCloseTo(0, 12);
    // the cells are equal in temperature (the Biot number is tiny)
    expect(Math.max(...last) - Math.min(...last)).toBeLessThan(1e-4);
  });

  it("with a film, the uniform particle relaxes to the bulk temperature: T = Tb + (T0 - Tb) exp(-t / tau), tau = C / (h A), to 0.1 % of the excursion", () => {
    const h = 2000;
    const n = lumped({ bulkTemperature: q(900, "K"), heatTransferCoefficient: q(h, "W/m2/K") });
    // no heat: a cooling from 1000 K
    const d = n.transient!;
    const quiet = { ...n, transient: { ...d, particlePower: d.particlePower.map(() => 0) } };
    const fv = computeTrisoIndependent(quiet).fv;
    const C = totalCapacity(n);
    const tau = C / (h * SPHERE.area(wedgeEquivalent(n).outerRadius));
    expect(tau).toBeGreaterThan(0.05);
    expect(tau).toBeLessThan(0.5);
    fv.states.forEach((s) => {
      const exact = 900 + 100 * Math.exp(-s.time / tau);
      const mean = s.T.reduce((a, x) => a + x, 0) / s.T.length;
      // implicit Euler is first order: its error is about dt / (2 tau) of the excursion, 5e-4 / 0.2 = 0.25 %: bound it at 0.5 % of 100 K
      expect(Math.abs(mean - exact)).toBeLessThan(0.5);
    });
  });

  it("with a prescribed wall that moves, the wall follows the table and the energy balance of the solution closes to 1e-8 of the energy exchanged", () => {
    const n = lumped({ surfaceTemperature: q(1000, "K") });
    const hist = { kind: "surface-temperature" as const, times: [0, 0.1, 0.5], surfaceTemperature: [1000, 900, 900] };
    const m = { ...n, transient: { ...n.transient!, boundaryHistory: hist } };
    const fv = computeTrisoIndependent(m).fv;
    fv.states.forEach((s) => {
      const want = s.time <= 0.1 ? 1000 - 1000 * 0 - (100 * s.time) / 0.1 : 900;
      expect(s.wall).toBeCloseTo(want, 9);
    });
    // the same model, stored energy from the cells against what was made and what left (the solution's own accounting)
    const model = trisoTransientModelOf(m);
    const run = solveTrisoFv(model, { dt: m.transient!.timeStep, steps: m.transient!.steps, initialField: trisoInitialField(m).T, outputEvery: 100 });
    const last = run.states[run.states.length - 1]!;
    const C = totalCapacity(n);
    const stored = (last.T.reduce((a, x, i) => a + x * run.volume[i]! * (model.capacities![run.region[i]!]![0] as number), 0)) - 1000 * C;
    expect(Math.abs(last.deposited - stored - last.rejected)).toBeLessThan(1e-8 * Math.max(last.deposited, Math.abs(last.rejected), C * 100));
    expect(last.rejected).toBeGreaterThan(0.09); // the wall cooled the particle by 100 K: about C x 100 K = 0.105 J left through the outside
  });

  it("records the hottest cell of each region after every step and the extremes over the run", () => {
    const n = norm(vec("triso-pulse"));
    const fv = computeTrisoIndependent(n).fv;
    const tr = fv.trace!;
    expect(tr.peakByStep).toHaveLength(1001);
    expect(tr.regionMaxByStep).toHaveLength(1001);
    expect(tr.regionMaxByStep[0]).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(Math.max(...tr.peakByStep)).toBeCloseTo(1017.16, 1); // between two outputs: the outputs of the real run show 1016.61 at 20 ms
    tr.regionMaxByStep.forEach((m, j) => expect(Math.max(...m)).toBe(tr.peakByStep[j]));
    expect(tr.regionMax[0]).toBe(Math.max(...tr.regionMaxByStep.map((m) => m[0]!)));
    expect(tr.regionMin.every((x) => x === 1000 || x < 1000)).toBe(true);
    expect(Math.min(...tr.regionMin)).toBeGreaterThan(999.9);
  });

  it("is not changed for a steady solution by the boundary table: the same model with a constant table gives the same field", () => {
    const n = norm(vec("triso-outside-ramp"));
    const flat = { ...n, transient: { ...n.transient!, boundaryHistory: { kind: "convective" as const, times: [0, 1], bulkTemperature: [900, 900], heatTransferCoefficient: [2000, 2000] } } };
    const a = computeTrisoIndependent(flat).fv;
    const b = computeTrisoIndependent({ ...n, transient: { ...n.transient!, boundaryHistory: undefined } }).fv;
    a.states.forEach((s, j) => s.T.forEach((x, i) => expect(x).toBeCloseTo(b.states[j]!.T[i]!, 9)));
  });
});

describe("the starting field", () => {
  it("a uniform start is the temperature in every cell, with the wall at the prescribed value or the start", () => {
    const n = norm(vec("triso-pulse"));
    const s = trisoInitialField(n);
    expect(s.T).toHaveLength(64);
    expect(s.T.every((x) => x === 1000)).toBe(true);
    expect(s.wall).toBe(1000);
    expect(s.peak).toBe(1000);
    const film = norm({ ...vec("triso-pulse"), boundary: { bulkTemperature: q(900, "K"), heatTransferCoefficient: q(2000, "W/m2/K") } });
    expect(trisoInitialField(film).wall).toBe(1000);
  });
  it("a steady start is the independent steady field of the wedge's sphere at the stated power (and its cell count refined)", () => {
    const n = norm(vec("triso-outside-ramp"));
    const s = trisoInitialField(n);
    const eq = wedgeEquivalent({ ...n, transient: undefined });
    const direct = steadyTrisoFv(trisoModelOf(eq), 0.2 * TRISO_WEDGE_SCALE ** 3);
    s.T.forEach((x, i) => expect(x).toBeCloseTo(direct.T[i]!, 9));
    expect(s.wall).toBeCloseTo(direct.wall, 9);
    // and the closed form of the wedge's sphere at 0.2 W x lambda^3: the centre to the mesh's error
    const e2 = wedgeEquivalent({ ...n, power: { ...n.power, particlePower: 0.2, kernelPowerDensity: 0.2 / n.power.kernelVolume } });
    expect(Math.abs(s.peak - trisoClosedForm(e2).centreT)).toBeLessThan(0.15);
    expect(trisoInitialField(n, 2).T).toHaveLength(128);
  });
  it("the start of a case whose history begins elsewhere uses the history's first value", () => {
    const n = norm(vec("triso-wall-quench"));
    expect(trisoInitialField(n).wall).toBeCloseTo(1000, 6);
  });
});

describe("the OFFBEAT case of a transient", () => {
  const n = norm(vec("triso-pulse"));
  const w = writeTrisoCase(n);
  const solver = w.files["constant/solverDict"]!;

  it("writes the files of a transient case, with the marker the run script looks for, and LF line endings only", () => {
    expect(Object.keys(w.files).sort()).toEqual(["0/D", "0/T", "constant/solverDict", "feed-transient.json", "system/blockMeshDict", "system/controlDict", "system/fvSchemes", "system/fvSolution"]);
    for (const [name, text] of Object.entries(w.files)) expect(text.includes("\r"), name).toBe(false);
    expect(JSON.parse(w.files["feed-transient.json"]!)).toEqual({ outputs: 50, steps: 1000, timeStep: 5e-4, endTime: 0.5 });
  });
  it("runs fixed steps to the case's end time and writes every steps / outputs", () => {
    const c = w.files["system/controlDict"]!;
    expect(c).toMatch(/endTime\s+0\.5;/);
    expect(c).toMatch(/deltaT\s+0\.0005;/);
    expect(c).toMatch(/writeInterval\s+20;/);
    expect(c).toMatch(/adjustableTimeStep\s+false;/);
    expect(w.choices).toMatchObject({ endTime: 0.5, timeStep: 5e-4, steps: 1000, outputs: 50 });
  });
  it("writes the case's power table as a volumetric power in the kernel, with one flat point a step after the last", () => {
    const Vk = (4 / 3) * Math.PI * (250e-6) ** 3;
    const pts = /timePoints\s+\(([^)]*)\)/.exec(solver)![1]!.trim().split(/\s+/).map(Number);
    const q3 = /vhgr\s+\(([^)]*)\)/.exec(solver)![1]!.trim().split(/\s+/).map(Number);
    expect(pts).toEqual([0, 0.01, 0.02, 0.5, 0.5005]);
    expect(q3).toHaveLength(5);
    expect(q3[0]).toBe(0);
    expect(q3[1]).toBeCloseTo(0.4 / Vk, -2);
    expect(q3[1]! / 6.11e9).toBeGreaterThan(0.99);
    expect(q3[1]! / 6.11e9).toBeLessThan(1.01);
    expect(q3[4]).toBe(0);
    expect(solver).toMatch(/heatSource\s+timeDependentVhgr;/);
    expect(solver).toContain("materials ( Kernel );");
  });
  it("gives each material its heat capacity as Cp = c / rho with rho 10000, in place of the steady run's placeholder", () => {
    for (const [zone, cp] of [["Kernel", 300], ["Buffer", 150], ["IPyC", 250], ["SiC", 350], ["OPyC", 250]] as const) {
      const block = new RegExp("\\n    " + zone + "\\n    \\{([\\s\\S]*?)\\n    \\}").exec(solver)![1]!;
      expect(block, zone).toMatch(new RegExp("Cp\\s+Cp\\s+\\[0 2 -2 -1 0\\]\\s+" + cp + ";"));
      expect(block).toMatch(/rho\s+rho\s+\[1 -3 0 0 0\]\s+10000;/);
    }
    expect(10000 * 300).toBe(STEADY_PSEUDO_HEAT_CAPACITY);
    // a temperature-dependent capacity goes through the pin's models
    const d = vec("triso-pulse");
    d.materials.kernel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: q(2.4, "MJ/m3/K"), b: q(0.0006, "MJ/m3/K2"), validRange: { min: q(600, "K"), max: q(2000, "K") }, source: "s" };
    expect(writeTrisoCase(norm(d)).files["constant/solverDict"]).toContain("heatCapacityModel steel1515TiBanerjee;");
  });
  it("starts from a uniform temperature, everywhere and on the patches", () => {
    const T = w.files["0/T"]!;
    expect(T).toMatch(/internalField\s+uniform 1000;/);
    expect(T).toMatch(/outer\s*\{\s*type fixedValue;\s*value uniform 1000;/);
    expect(T).toContain("value           $internalField;");
  });
  it("starts from the independent steady field, written for every cell, with the patches near their neighbours", () => {
    const s = norm(vec("triso-outside-ramp"));
    const ws = writeTrisoCase(s);
    const T = ws.files["0/T"]!;
    const m = /internalField\s+nonuniform List<scalar>\s+(\d+)\s+\(\s*([^)]*)\)/.exec(T)!;
    expect(Number(m[1])).toBe(64);
    const vals = m[2]!.trim().split(/\s+/).map(Number);
    const start = trisoInitialField(s);
    vals.forEach((x, i) => expect(x).toBe(start.T[i]));
    // the gap's patches take the neighbouring cell (the last buffer cell, the first IPyC cell), the outside the film's wall value
    expect(T).toMatch(new RegExp("bufferOuter[\\s\\S]*?value\\s+uniform " + String(start.T[23]).replace(".", "\\.")));
    expect(T).toMatch(new RegExp("ipycInner[\\s\\S]*?value\\s+uniform " + String(start.T[24]).replace(".", "\\.")));
    expect(ws.placeholders.map((p) => p.name)).toContain("initial temperature field");
  });
  it("writes a changing wall as the pin's axial table at the one height, with a flat point beyond the end time; a film as the pair of tables", () => {
    const wall = writeTrisoCase(norm(vec("triso-wall-quench"))).files["0/T"]!;
    expect(wall).toContain("type timeDependentAxialProfileT;");
    expect(wall).toMatch(/timePoints \(0 0\.05 0\.5 0\.5005\);/);
    expect(wall).toContain("axialLocations (0 1);");
    expect(wall).toContain("axialData ((1000 1000) (900 900) (900 900) (900 900));");
    const film = writeTrisoCase(norm(vec("triso-outside-ramp"))).files["0/T"]!;
    expect(film).toContain("type timeDependentAxialProfileHTC;");
    expect(film).toContain("hData ((2000 2000) (2000 2000) (2000 2000) (2000 2000) (2000 2000));");
    expect(film).toContain("T0Data ((900 900) (900 900) (1000 1000) (1000 1000) (1000 1000));");
    expect(film).toMatch(/timePoints \(0 0\.05 0\.25 0\.5 0\.5005\);/);
    expect(writeTrisoCase(norm(vec("triso-wall-quench"))).mapping.map((m) => m.field)).toContain("transient.boundaryHistory");
  });
  it("records where the transient's fields went", () => {
    const fields = w.mapping.map((m) => m.field);
    expect(fields).toEqual(expect.arrayContaining(["transient.powerHistory", "transient.timeStep, endTime, outputs", "transient.initialTemperature", "materials.* thermal.volumetricHeatCapacity"]));
    expect(fields).not.toContain("power");
  });
});
