// Plan 12, A4: the plate, a slab through its thickness (the meat from an insulated mid-plane, a gap, a cladding, cooled on one face), in one dimension. Ungated: the case and its
// refusals, the closed forms against hand calculations and a numerical quadrature, the slab finite-volume solution against the exact series for a plate that cools through a
// prescribed wall, the files the writer gives OFFBEAT, and that the pin is unchanged. The real-solver tests are in plateSolver.test.ts.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { compositeSlab, slabFuelIntegral } from "../src/core/closedForm";
import { lawOf } from "../src/core/conductivity";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { geometryOf } from "../src/core/geometry";
import { quickLook, radialProfile } from "../src/core/quickLook";
import { steadyEndTime } from "../src/core/steadyState";
import { solveTransientFv } from "../src/core/transientFv";
import { initialState, pinOf } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const pinDoc = () => JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
/** The synthetic pin's numbers as a plate: meat half-thickness 4.1 mm, a 0.08 mm gap, a 0.57 mm cladding; k 3 and 15 W/m/K; film 30000, gap 5000 W/m2/K; coolant 573 K; 20 kW per metre of height per metre of width. */
function plate(over: Record<string, unknown> = {}) {
  const d = pinDoc();
  d.caseId = "synthetic-plate";
  d.assumptions.geometry = "1D-slab";
  d.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  return Object.assign(d, over);
}
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);

describe("the plate case", () => {
  it("is valid, is normalised as positions from the mid-plane, and says it is a plate", () => {
    const n = norm(plate());
    expect(n.plate).toBe(true);
    expect(n.fuelRadius).toBeCloseTo(4.1e-3, 12);
    expect(n.claddingInnerRadius).toBeCloseTo(4.18e-3, 12);
    expect(n.claddingOuterRadius).toBeCloseTo(4.75e-3, 12);
    expect(n.fuelInnerRadius).toBe(0);
    expect(validateCase(plate()).warnings).toEqual([]);
    // a pin has no such flag
    expect("plate" in norm(pinDoc())).toBe(false);
  });
  it("refuses what a plate does not have, with the reason", () => {
    expect(codes(plate({ assumptions: { thermalOnly: true, steadyState: true, geometry: "1D-radial" } }))).toContain("E_UNSUPPORTED /assumptions/geometry");
    const pinAsSlab = pinDoc();
    pinAsSlab.assumptions.geometry = "1D-slab";
    expect(codes(pinAsSlab)).toContain("E_UNSUPPORTED /assumptions/geometry");
    const withRadius = plate();
    withRadius.geometry.fuelRadius = q(4.1, "mm");
    expect(codes(withRadius)).toContain("E_GEOMETRY /geometry/fuelRadius");
    const hole = plate();
    hole.geometry.fuelInnerRadius = q(1, "mm");
    expect(codes(hole)).toContain("E_GEOMETRY /geometry/fuelInnerRadius");
    for (const k of ["fuelHalfThickness", "gapThickness", "claddingThickness"]) {
      const d = plate();
      delete d.geometry[k];
      expect(codes(d)).toContain("E_SCHEMA_INVALID /geometry/" + k);
    }
    const neg = plate();
    neg.geometry.gapThickness = q(-1, "mm");
    expect(codes(neg)).toContain("E_GEOMETRY /geometry/gapThickness");
    const zero = plate();
    zero.geometry.claddingThickness = q(0, "mm");
    expect(codes(zero)).toContain("E_GEOMETRY /geometry/claddingThickness");
    const unit = plate();
    unit.geometry.fuelHalfThickness = q(4.1, "W/m");
    expect(codes(unit)).toContain("E_UNITS /geometry/fuelHalfThickness");
    const bogus = pinDoc();
    bogus.geometry.kind = "disc";
    expect(codes(bogus)).toContain("E_GEOMETRY /geometry/kind");
    const noGap = plate();
    noGap.geometry.gapThickness = q(0, "mm");
    expect(validateCase(noGap).errors).toEqual([]);
  });
  it("refuses a hot-dimension, mechanics, burnup, axial or kinetics section on a plate: each is for pins in this release", () => {
    const hot = plate();
    hot.hotDimensions = { referenceTemperature: q(20, "degC"), fuel: { linearExpansion: q(12, "ppm/K"), source: "x" }, cladding: { linearExpansion: q(10, "ppm/K"), source: "x" } };
    expect(codes(hot)).toContain("E_UNSUPPORTED /hotDimensions");
    const ax = plate();
    ax.axial = { length: q(0.381, "m"), slices: 10, powerShape: { kind: "cosine" } };
    expect(codes(ax)).toContain("E_UNSUPPORTED /axial");
    const kin = JSON.parse(readFileSync(join(root, "examples/synthetic-pulse-kinetics.json"), "utf8"));
    kin.geometry = plate().geometry;
    kin.assumptions.geometry = "1D-slab";
    expect(codes(kin)).toContain("E_UNSUPPORTED /transient/pointKinetics");
  });
  it("the heat rate of a plate is per metre of height per metre of width and is not judged against the pin's sanity range", () => {
    const d = plate();
    d.power.linearHeatRate = q(200, "kW/m");
    expect(validateCase(d).warnings.map((w) => w.code)).not.toContain("W_POWER_RANGE");
    expect(validateCase(Object.assign(pinDoc(), { power: { linearHeatRate: q(200, "kW/m") } })).warnings.map((w) => w.code)).toContain("W_POWER_RANGE");
  });
});

describe("the slab closed forms", () => {
  it("the centre of the plate is the coolant plus the five drops: film q/h, cladding q t / k, gap q/h, meat q L / (2 k), worked by hand", () => {
    const n = norm(plate());
    const t = quickLook(n).temperatures;
    const hand = 573 + 20000 / 30000 + (20000 * 0.57e-3) / 15 + 20000 / 5000 + (20000 * 4.1e-3) / (2 * 3);
    expect(hand).toBeCloseTo(592.0933333, 6);
    expect(t.centreT).toBeCloseTo(hand, 9);
    expect(t.filmDeltaT).toBeCloseTo(20000 / 30000, 12);
    expect(t.gapDeltaT).toBeCloseTo(4, 12);
    expect(t.claddingOuterT).toBeCloseTo(573 + 20000 / 30000, 12);
  });
  it("a prescribed wall has no film drop", () => {
    const d = plate();
    d.boundary = { surfaceTemperature: q(600, "K") };
    const t = quickLook(norm(d)).temperatures;
    expect(t.filmDeltaT).toBe(0);
    expect(t.claddingOuterT).toBe(600);
    expect(t.centreT).toBeCloseTo(600 + 0.76 + 4 + 13.6666667, 6);
  });
  it("with a conductivity that depends on temperature the meat satisfies its conductivity integral: the integral of k from the centre to the surface is q L / 2 and from x it is q (L^2 - x^2) / (2 L) (a numerical quadrature, not the solver used)", () => {
    const d = plate();
    d.materials.fuel.sets["thermal.conductivity"] = { model: "linear", a: q(4, "W/m/K"), b: q(-0.0006, "W/m/K2"), validRange: { min: q(300, "K"), max: q(2500, "K") }, source: "synthetic: a test" };
    const n = norm(d);
    const k = lawOf(n.fuelConductivity);
    const kT = (T: number) => k[0]! + (k[1] ?? 0) * T;
    const integral = (a: number, b: number) => {
      const N = 4000;
      let s = kT(a) + kT(b);
      for (let i = 1; i < N; i++) s += (i % 2 ? 4 : 2) * kT(a + ((b - a) * i) / N);
      return (s * (b - a)) / (3 * N);
    };
    const look = quickLook(n);
    expect(integral(look.temperatures.fuelSurfaceT, look.temperatures.centreT)).toBeCloseTo(slabFuelIntegral(20000, 4.1e-3, 0), 6);
    expect(slabFuelIntegral(20000, 4.1e-3, 0)).toBeCloseTo((20000 * 4.1e-3) / 2, 12);
    const prof = radialProfile(n, look, 20).filter((p) => p.region === "fuel");
    for (const p of prof) expect(integral(look.temperatures.fuelSurfaceT, p.T), "x = " + p.r).toBeCloseTo(slabFuelIntegral(20000, 4.1e-3, p.r), 5);
    // the hottest point is at the mid-plane and the profile falls toward the face
    expect(prof[0]!.T).toBeCloseTo(look.temperatures.centreT, 9);
    expect(prof[prof.length - 1]!.T).toBeCloseTo(look.temperatures.fuelSurfaceT, 9);
  });
  it("the slab differs from the cylinder of the same numbers: the pin's centre is much hotter at the same linear heat rate (a different geometry, not a rename)", () => {
    const pinCentre = quickLook(norm(pinDoc())).temperatures.centreT;
    const plateCentre = quickLook(norm(plate())).temperatures.centreT;
    expect(Math.abs(pinCentre - plateCentre)).toBeGreaterThan(500);
  });
});

describe("the slab finite-volume solution", () => {
  it("steady, it reproduces the closed form to the mesh bound (5 dT / N^2), cell by cell", () => {
    const d = plate();
    d.assumptions.steadyState = false;
    d.assumptions.thermalOnly = true;
    d.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "constant", value: q(3, "MJ/m3/K"), referenceTemperature: q(300, "K"), source: "synthetic" };
    d.materials.cladding.sets["thermal.volumetricHeatCapacity"] = { model: "constant", value: q(3, "MJ/m3/K"), referenceTemperature: q(300, "K"), source: "synthetic" };
    d.power = {};
    d.transient = { powerHistory: [{ time: q(0, "s"), linearHeatRate: q(20, "kW/m") }, { time: q(10, "s"), linearHeatRate: q(20, "kW/m") }], endTime: q(10, "s"), timeStep: q(1, "s"), outputs: 2, initialSteadyLinearHeatRate: q(20, "kW/m") };
    const c = norm(d);
    const st = initialState(c);
    const look = quickLook(c).temperatures;
    const bound = (5 * (look.centreT - look.fuelSurfaceT)) / 400;
    const k = lawOf(c.fuelConductivity)[0]!;
    st.T.slice(0, 20).forEach((T, i) => {
      const x = (i + 0.5) * (c.fuelRadius / 20);
      expect(Math.abs(T - (look.fuelSurfaceT + (20000 * (c.fuelRadius ** 2 - x * x)) / (2 * c.fuelRadius * k))), "cell " + i).toBeLessThan(bound);
    });
    expect(Math.abs(st.wall - look.claddingOuterT)).toBeLessThan(1e-9);
  });
  it("a plate cooled through a prescribed wall follows the exact series: T(x,t) = Tw + (T0 - Tw) sum 4 (-1)^n / ((2n+1) pi) cos((2n+1) pi x / (2 L)) exp(-alpha ((2n+1) pi / (2 L))^2 t), to 0.5 % of the drop (same material throughout, no gap resistance)", () => {
    const k = 10;
    const c = 2e6;
    const L = 5e-3; // the whole plate: meat 3 mm + cladding 2 mm, the gap of zero thickness with a huge conductance
    const T0 = 900;
    const Tw = 600;
    const alpha = k / c;
    const exact = (x: number, t: number) => {
      let s = 0;
      for (let n = 0; n < 200; n++) s += ((4 * (-1) ** n) / ((2 * n + 1) * Math.PI)) * Math.cos(((2 * n + 1) * Math.PI * x) / (2 * L)) * Math.exp(-alpha * (((2 * n + 1) * Math.PI) / (2 * L)) ** 2 * t);
      return Tw + (T0 - Tw) * s;
    };
    const d = plate();
    d.assumptions.steadyState = false;
    d.geometry = { kind: "plate", fuelHalfThickness: q(3, "mm"), gapThickness: q(0, "mm"), claddingThickness: q(2, "mm") };
    d.mesh = { fuelCells: 60, claddingCells: 40 };
    d.boundary = { surfaceTemperature: q(Tw, "K") };
    d.gap = { model: "constant-conductance", conductance: q(1e12, "W/m2/K"), source: "synthetic: effectively no resistance" };
    for (const m of ["fuel", "cladding"]) {
      d.materials[m].sets["thermal.conductivity"] = { model: "constant", value: q(k, "W/m/K"), referenceTemperature: q(300, "K"), source: "synthetic" };
      d.materials[m].sets["thermal.volumetricHeatCapacity"] = { model: "constant", value: q(c / 1e6, "MJ/m3/K"), referenceTemperature: q(300, "K"), source: "synthetic" };
    }
    d.power = {};
    d.transient = { powerHistory: [{ time: q(0, "s"), linearHeatRate: q(1, "W/m") }, { time: q(2, "s"), linearHeatRate: q(1, "W/m") }], endTime: q(2, "s"), timeStep: q(0.001, "s"), outputs: 4, initialTemperature: q(T0, "K") };
    const n = norm(d);
    const fv = solveTransientFv(pinOf(n), { dt: 0.001, steps: 2000, initialTemperature: T0, outputEvery: 500 });
    expect(fv.states).toHaveLength(5);
    for (const s of fv.states.slice(1)) {
      let worst = 0;
      s.T.forEach((T, i) => {
        worst = Math.max(worst, Math.abs(T - exact(fv.r[i]!, s.time)));
      });
      expect(worst, "t = " + s.time).toBeLessThan(0.005 * (T0 - Tw));
      // the wall is the prescribed temperature
      expect(s.wall).toBe(Tw);
    }
    // the centre at 2 s has cooled substantially but not completely: the test is not a trivial pass at either end
    expect(fv.states[4]!.T[0]!).toBeLessThan(T0 - 100);
    expect(fv.states[4]!.T[0]!).toBeGreaterThan(Tw + 5);
    // the exact solution's centre agrees with the cell next to it (a sanity check of the series itself against a cell-centre value)
    expect(exact(0, 0.0005)).toBeCloseTo(T0, 3);
  });
  it("heat is conserved: the energy stored plus the heat rejected equals the heat deposited, for a plate with a source and a film", () => {
    const d = plate();
    d.assumptions.steadyState = false;
    for (const m of ["fuel", "cladding"]) d.materials[m].sets["thermal.volumetricHeatCapacity"] = { model: "constant", value: q(3, "MJ/m3/K"), referenceTemperature: q(300, "K"), source: "synthetic" };
    d.power = {};
    d.transient = { powerHistory: [{ time: q(0, "s"), linearHeatRate: q(20, "kW/m") }, { time: q(60, "s"), linearHeatRate: q(20, "kW/m") }], endTime: q(60, "s"), timeStep: q(0.1, "s"), outputs: 6, initialTemperature: q(573, "K") };
    const n = norm(d);
    const fv = solveTransientFv(pinOf(n), { dt: 0.1, steps: 600, initialTemperature: 573, outputEvery: 100 });
    const last = fv.states[fv.states.length - 1]!;
    // 20 kW over 60 s = 1.2 MJ per metre of height and width; the cells' stored energy is the volume integral of c (T - T0)
    const stored = last.T.reduce((s, T, i) => s + 3e6 * (T - 573) * (i < 20 ? n.fuelRadius / 20 : (n.claddingOuterRadius - n.claddingInnerRadius) / 6), 0);
    expect(last.deposited).toBeCloseTo(1.2e6, 3);
    expect(Math.abs(stored + last.rejected - last.deposited) / last.deposited).toBeLessThan(1e-9);
  });
});

describe("the time scale of a plate", () => {
  it("steady end time: a plate with the pin's numbers needs the minimum, and a weak film makes it longer (the same code as the pin, with the slab's resistances)", () => {
    const base = steadyEndTime(norm(plate()));
    expect(base.ok).toBe(true);
    const weak = plate();
    weak.boundary.heatTransferCoefficient = q(1e-3, "W/m2/K");
    const w = steadyEndTime(norm(weak));
    expect(w.ok && base.ok && w.endTime >= base.endTime).toBe(true);
    const g = geometryOf(true);
    expect(g.resist(1, 3, 2)).toBe(1);
    expect(g.volume(1, 3)).toBe(2);
  });
});

describe("the files of a plate", () => {
  const w = writeOffbeatCase(norm(plate()));
  it("a Cartesian mesh one metre wide, the side faces empty, no wedge anywhere, the angular fraction stated, and the heat rate per metre of width", () => {
    const b = w.files["system/blockMeshDict"]!;
    expect(b).toMatch(/\(0 -500 0\)/);
    expect(b).toMatch(/\(4\.1 500 0\)/);
    expect(b).toMatch(/\(4\.75 500 1000\)/);
    expect(b).not.toMatch(/wedge/);
    expect(b).toMatch(/fuelFront\s*\{\s*type empty;/);
    expect(b).toMatch(/fuel \(20 1 1\)/);
    expect(w.files["0/T"]!).not.toMatch(/wedge/);
    expect(w.files["0/D"]!).not.toMatch(/wedge/);
    expect(w.files["constant/solverDict"]!).toMatch(/angularFraction\s+1;/);
    expect(w.files["constant/solverDict"]!).toMatch(/lhgr\s+20000;/);
    expect(w.mapping.find((m) => m.field === "geometry")!.note).toMatch(/a plate: a Cartesian mesh/);
  });
  it("a pin is written as before: wedge faces, no angular fraction", () => {
    const p = writeOffbeatCase(norm(pinDoc()));
    expect(p.files["system/blockMeshDict"]).toMatch(/type wedge;/);
    expect(p.files["constant/solverDict"]).not.toMatch(/angularFraction/);
    expect(p.files["0/T"]).toMatch(/type\s+wedge;/);
  });
});
