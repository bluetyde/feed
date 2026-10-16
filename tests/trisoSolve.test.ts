// Plan 13, T2: the independent solutions of a coated particle: the closed form of the layered sphere, the finite-volume solution (steady and time-dependent), the time scale, the quick
// look. Ungated. The closed form is checked against arithmetic written out here and against a Runge-Kutta integration of the conduction equation for a conductivity that depends on
// temperature; the finite-volume solution against the closed form (and its order), against the exact series of a sphere with a heated core (constant properties, a fixed wall), for
// conservation of energy, and cell by cell against two saved OFFBEAT runs of the same particle (tests/golden/offbeat-triso, docs/spike/triso-probe.md).
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { MAX_STEADY_END_TIME, MIN_STEADY_END_TIME, STEADY_PSEUDO_HEAT_CAPACITY, TAU_SAFETY } from "../src/core/steadyState";
import { SPHERE } from "../src/core/geometry";
import { NormalizedTriso } from "../src/core/triso";
import { solveTrisoFv, steadyTrisoFv, trisoClosedForm, trisoDerived, trisoInitialDeviationBound, trisoModelOf, trisoQuickLook, trisoSteadyEndTime, trisoStoredEnergy, trisoTimeScale } from "../src/core/trisoSolve";
import { validateCase } from "../src/core/validate";
import { check } from "../src/server/server";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
const PI = Math.PI;
/** 600 MW/m3 in a kernel of 250 um, layers 100, 40, 35, 35 um, conductivities 3, 0.5, 4, 13.9, 4 W/m/K, a gap of 1.5e5 W/m2/K, a wall at 1000 K. */
const particle = () => read("schema/vectors/good/triso-steady.json");
const norm = (d: unknown): NormalizedTriso => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.triso!;
};
const lin = (a: number, b: number, lo: number, hi: number) => ({ model: "linear", a: q(a, "W/m/K"), b: q(b, "W/m/K2"), validRange: { min: q(lo, "K"), max: q(hi, "K") }, source: "synthetic: a law that falls with temperature, for the conduction integral" });

describe("the closed form of the layered sphere", () => {
  it("has the drops of each region, worked out here: shell P (1/a - 1/b) / (4 pi k), kernel q R^2 / (6 k), gap P / (4 pi R^2 h), film P / (4 pi R^2 h)", () => {
    const n = norm(particle());
    const P = 6e8 * ((4 / 3) * PI * 250e-6 ** 3);
    const shell = (a: number, b: number, k: number) => (P / (4 * PI * k)) * (1 / a - 1 / b);
    const [R, b, i, s, o] = [250e-6, 350e-6, 390e-6, 425e-6, 460e-6];
    const dOp = shell(s, o, 4);
    const dSi = shell(i, s, 13.9);
    const dIp = shell(b, i, 4);
    const dGap = P / (4 * PI * b * b * 1.5e5);
    const dBuf = shell(R, b, 0.5);
    const dKer = (6e8 * R * R) / (6 * 3);
    const cf = trisoClosedForm(n);
    expect(cf.wallT).toBe(1000);
    expect(cf.filmDeltaT).toBe(0);
    expect(cf.regions.map((r) => r.name)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    const want = [dKer, dBuf, dIp, dSi, dOp];
    cf.regions.forEach((r, k) => expect(r.innerT - r.outerT).toBeCloseTo(want[k]!, 9));
    expect(cf.gapDeltaT).toBeCloseTo(dGap, 12);
    expect(cf.kernelSurfaceT).toBeCloseTo(1000 + dOp + dSi + dIp + dGap + dBuf, 9);
    expect(cf.centreT).toBeCloseTo(1000 + dOp + dSi + dIp + dGap + dBuf + dKer, 9);
    // the numbers themselves, so a slip in the arithmetic above is caught: 0.03927 W, a rise of 50 K in the kernel (6e8 x 250e-6^2 / 18), 0.0392699 W through each shell
    expect(P).toBeCloseTo(0.0392699, 7);
    expect(dKer).toBeCloseTo(2.0833, 4);
    expect(cf.centreT).toBeGreaterThan(1000);
  });
  it("adds the film's drop to the wall for a convective outside", () => {
    const d = particle();
    d.boundary = { bulkTemperature: q(900, "K"), heatTransferCoefficient: q(2000, "W/m2/K") };
    const n = norm(d);
    const P = n.power.particlePower;
    const cf = trisoClosedForm(n);
    expect(cf.filmDeltaT).toBeCloseTo(P / (4 * PI * 460e-6 ** 2 * 2000), 12);
    expect(cf.wallT).toBeCloseTo(900 + cf.filmDeltaT, 12);
    expect(cf.regions[4]!.outerT).toBeCloseTo(cf.wallT, 12);
  });
  it("is continuous across the faces between regions, and the gap's drop is the only jump", () => {
    const cf = trisoClosedForm(norm(particle()));
    for (let i = 0; i < 4; i++) {
      const inside = cf.regions[i]!;
      const outside = cf.regions[i + 1]!;
      if (i === 1) continue; // the gap lies between the buffer (region 1) and the ipyc (region 2): the next test
      expect(outside.innerT - inside.outerT).toBeCloseTo(0, 9);
    }
    // the buffer's outer face is hotter than the ipyc's inner face by the gap's drop
    expect(cf.regions[1]!.outerT - cf.regions[2]!.innerT).toBeCloseTo(cf.gapDeltaT, 10);
  });
  it("gives the temperature at any radius: the centre, the faces, and the middle of a shell", () => {
    const n = norm(particle());
    const cf = trisoClosedForm(n);
    expect(cf.temperatureAt(0)).toBeCloseTo(cf.centreT, 12);
    expect(cf.temperatureAt(n.kernelRadius)).toBeCloseTo(cf.kernelSurfaceT, 9);
    expect(cf.temperatureAt(n.outerRadius)).toBeCloseTo(1000, 9);
    // inside the kernel the profile is q (R^2 - r^2) / (6 k) above the surface
    expect(cf.temperatureAt(125e-6)).toBeCloseTo(cf.kernelSurfaceT + (6e8 * (250e-6 ** 2 - 125e-6 ** 2)) / 18, 9);
    // the IPyC (350 to 390 um): the middle at 370 um
    const P = n.power.particlePower;
    expect(cf.temperatureAt(370e-6)).toBeCloseTo(cf.regions[2]!.outerT + (P / (4 * PI * 4)) * (1 / 370e-6 - 1 / 390e-6), 9);
    expect(() => cf.temperatureAt(500e-6)).toThrow(RangeError);
    expect(() => cf.temperatureAt(-1e-6)).toThrow(RangeError);
  });
  it("matches a Runge-Kutta integration of the conduction equation when the conductivities depend on temperature", () => {
    const d = particle();
    d.materials.kernel.sets["thermal.conductivity"] = lin(4, -0.0015, 500, 2500);
    d.materials.buffer.sets["thermal.conductivity"] = lin(0.8, -0.0003, 500, 2500);
    d.materials.sic.sets["thermal.conductivity"] = lin(20, -0.006, 500, 2500);
    d.power = { kernelPowerDensity: q(6000, "MW/m3") };
    const n = norm(d);
    const P = n.power.particlePower;
    const qv = n.power.kernelPowerDensity;
    const kOf: ((T: number) => number)[] = [(T) => 4 - 0.0015 * T, (T) => 0.8 - 0.0003 * T, () => 4, (T) => 20 - 0.006 * T, () => 4];
    // inward from the wall: dT/dr = -P / (4 pi r^2 k(T)) outside the kernel, -q r / (3 k(T)) inside it; the gap's drop at the buffer's outer face
    const rk4 = (f: (r: number, T: number) => number, r0: number, r1: number, T0: number, steps = 4000) => {
      const h = (r1 - r0) / steps;
      let T = T0;
      let r = r0;
      for (let s = 0; s < steps; s++) {
        const k1 = f(r, T);
        const k2 = f(r + h / 2, T + (h * k1) / 2);
        const k3 = f(r + h / 2, T + (h * k2) / 2);
        const k4 = f(r + h, T + h * k3);
        T += (h * (k1 + 2 * k2 + 2 * k3 + k4)) / 6;
        r += h;
      }
      return T;
    };
    let T = 1000;
    for (let i = 4; i >= 1; i--) {
      const l = n.layers[i - 1]!;
      if (i === 1) T += P / (4 * PI * l.outerRadius ** 2 * 1.5e5);
      T = rk4((r, t) => -P / (4 * PI * r * r * kOf[i]!(t)), l.outerRadius, l.innerRadius, T);
    }
    const surface = T;
    const centre = rk4((r, t) => (-qv * r) / (3 * kOf[0]!(t)), n.kernelRadius, 0, surface);
    const cf = trisoClosedForm(n);
    expect(cf.kernelSurfaceT).toBeCloseTo(surface, 6);
    expect(cf.centreT).toBeCloseTo(centre, 6);
    // the conductivity really falls over the kernel: the rise is more than the constant-conductivity estimate at the surface's temperature gives
    const constant = (qv * n.kernelRadius ** 2) / (6 * kOf[0]!(surface));
    expect((centre - surface) / constant - 1).toBeGreaterThan(0.003);
  });
  it("refuses, with the reason, a conductivity that reaches zero before the heat is carried (the validator reports it as E_OUT_OF_RANGE on /materials)", () => {
    const d = particle();
    d.materials.kernel.sets["thermal.conductivity"] = lin(3, -0.002, 500, 1400);
    d.power = { kernelPowerDensity: q(30000, "MW/m3") };
    const v = validateCase(d);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.code + " " + e.field)).toEqual(["E_OUT_OF_RANGE /materials"]);
  });
});

describe("the finite-volume solution, steady", () => {
  const n0 = () => norm(particle());
  const withCells = (f: number) => {
    const d = particle();
    d.mesh = { kernelCells: 12 * f, bufferCells: 12 * f, ipycCells: 12 * f, sicCells: 16 * f, opycCells: 12 * f };
    return norm(d);
  };
  it("reproduces the closed form's wall and rejects exactly the power it is given", () => {
    const n = n0();
    const m = trisoModelOf(n);
    const s = steadyTrisoFv(m, n.power.particlePower);
    expect(s.wall).toBeCloseTo(1000, 9);
    // the heat leaving through the outer face is the heat made: the wall flux per area times the area
    const cf = trisoClosedForm(n);
    expect(s.T[0]!).toBeLessThanOrEqual(cf.centreT);
    expect(s.T[0]!).toBeGreaterThan(cf.kernelSurfaceT);
    const run = solveTrisoFv({ ...m, power: () => n.power.particlePower }, { dt: 1e30, steps: 1, initialTemperature: 1000, outputEvery: 1 });
    const st = run.states[1]!;
    expect(st.rejected / 1e30).toBeCloseTo(st.deposited / 1e30, 6);
  });
  it("converges to the closed form at second order in the cell width: the centre's error falls by about four each time the mesh is doubled", () => {
    const errs = [1, 2, 4].map((f) => {
      const n = withCells(f);
      const s = steadyTrisoFv(trisoModelOf(n), n.power.particlePower);
      const fv = solveTrisoFv({ ...trisoModelOf(n), power: () => n.power.particlePower }, { dt: 1e30, steps: 1, initialTemperature: 1000, outputEvery: 1 });
      // compare every cell with the closed form at the cell's centre radius
      const cf = trisoClosedForm(n);
      let worst = 0;
      s.T.forEach((t, i) => {
        worst = Math.max(worst, Math.abs(t - cf.temperatureAt(fv.r[i]!)));
      });
      return worst;
    });
    expect(errs[0]!).toBeLessThan(0.05);
    expect(errs[0]! / errs[1]!).toBeGreaterThan(2.5);
    expect(errs[1]! / errs[2]!).toBeGreaterThan(2.5);
    expect(errs[0]! / errs[2]!).toBeGreaterThan(7);
  });
  it("matches the closed form with temperature-dependent conductivities, and is a fixed point", () => {
    const d = particle();
    d.materials.kernel.sets["thermal.conductivity"] = lin(4, -0.0015, 500, 2500);
    d.materials.sic.sets["thermal.conductivity"] = lin(20, -0.006, 500, 2500);
    d.power = { kernelPowerDensity: q(2500, "MW/m3") };
    d.mesh = { kernelCells: 48, bufferCells: 48, ipycCells: 48, sicCells: 64, opycCells: 48 };
    const n = norm(d);
    const s = steadyTrisoFv(trisoModelOf(n), n.power.particlePower);
    const cf = trisoClosedForm(n);
    expect(Math.abs(s.T[0]! - cf.centreT)).toBeLessThan(0.05);
    expect(Math.abs(s.T[s.T.length - 1]! - cf.temperatureAt(s.r[s.r.length - 1]!))).toBeLessThan(0.01);
  });
  it("puts the gap between the buffer and the ipyc and nowhere else: a particle with a hundredfold conductance has a gap drop a hundredth as large", () => {
    const base = norm(particle());
    const d = particle();
    d.gap.conductance = q(1.5e7, "W/m2/K");
    const stiff = norm(d);
    const a = trisoClosedForm(base).gapDeltaT;
    const b = trisoClosedForm(stiff).gapDeltaT;
    expect(a / b).toBeCloseTo(100, 8);
    // and the finite-volume field shows it: the kernel is hotter with the weak gap by the difference of the drops
    const sa = steadyTrisoFv(trisoModelOf(base), base.power.particlePower);
    const sb = steadyTrisoFv(trisoModelOf(stiff), stiff.power.particlePower);
    expect(sa.T[0]! - sb.T[0]!).toBeCloseTo(a - b, 2);
  });
  it("refuses a negative power and a field that cannot settle, with a message", () => {
    const n = n0();
    expect(() => steadyTrisoFv(trisoModelOf(n), -1)).toThrow(RangeError);
    expect(() => steadyTrisoFv(trisoModelOf(n), NaN)).toThrow(RangeError);
    // a conductivity that falls to zero before the heat is carried: there is no steady state, and the message says where
    const m = trisoModelOf(n);
    m.laws[0] = [3000, -2.9];
    expect(() => steadyTrisoFv(m, 0.5)).toThrow(/not positive at/);
    expect(steadyTrisoFv(m, 0.04).T[0]!).toBeGreaterThan(1000);
  });
});

/** Parse the cell values of an OpenFOAM scalar or vector list from a saved run. */
const foamList = (file: string, vector: boolean): number[][] => {
  const txt = readFileSync(join(root, "tests/golden/offbeat-triso", file), "utf8");
  const m = txt.match(/internalField\s+nonuniform\s+List<(?:scalar|vector)>\s*\n?(\d+)\s*\n\(/)!;
  const n = Number(m[1]);
  const body = txt.slice(m.index! + m[0].length);
  if (vector) return [...body.matchAll(/\(([-\d.eE+]+) ([-\d.eE+]+) ([-\d.eE+]+)\)/g)].slice(0, n).map((x) => [Number(x[1]), Number(x[2]), Number(x[3])]);
  return body.split(")")[0]!.split(/\s+/).filter(Boolean).slice(0, n).map((x) => [Number(x)]);
};

describe("against OFFBEAT's own runs of the same particle (the T0 probe's saved cells)", () => {
  /** OFFBEAT's tutorial particle (kernel 251, buffer 95, ipyc 41, sic 35, opyc 40 um), the probe's conductivities, a resistive gap of 1.5e5 W/m2/K, 3 GW/m3 in the kernel. */
  const probe = (boundary: Record<string, unknown>, cells: Record<string, number>) => {
    const d = particle();
    d.geometry.kernelRadius = q(251, "um");
    d.geometry.layers = [
      { name: "buffer", thickness: q(95, "um") },
      { name: "ipyc", thickness: q(41, "um") },
      { name: "sic", thickness: q(35, "um") },
      { name: "opyc", thickness: q(40, "um") },
    ];
    d.power = { kernelPowerDensity: q(3000, "MW/m3") };
    d.boundary = boundary;
    d.mesh = cells;
    return norm(d);
  };
  const compare = (dir: string, n: NormalizedTriso, tolerance: number) => {
    const T = foamList(dir + "/T", false).map((x) => x[0]!);
    const C = foamList(dir + "/C", true);
    expect(T.length).toBe(n.cells.reduce((a, b) => a + b, 0));
    // OFFBEAT's cells in order of radius (its cell centre vector has the length of the radius), against the same cells of the finite-volume solution
    const radius = C.map((c) => Math.hypot(c[0]!, c[1]!, c[2]!));
    const order = radius.map((_, i) => i).sort((a, b) => radius[a]! - radius[b]!);
    const s = steadyTrisoFv(trisoModelOf(n), n.power.particlePower);
    let worst = 0;
    order.forEach((cell, k) => {
      worst = Math.max(worst, Math.abs(T[cell]! - s.T[k]!));
    });
    expect(worst).toBeLessThan(tolerance);
    return { worst, s, T, order };
  };
  it("agrees cell by cell with the run that had a prescribed wall (48, 48, 48, 64, 48 cells), to 0.1 K of a rise of 48 K", () => {
    const n = probe({ surfaceTemperature: q(1298, "K") }, { kernelCells: 48, bufferCells: 48, ipycCells: 48, sicCells: 64, opycCells: 48 });
    const r = compare("fixed-wall", n, 0.1);
    expect(r.s.T[0]! - 1298).toBeGreaterThan(40);
  });
  it("agrees cell by cell with the run that had a convective outside (900 K, 2000 W/m2/K, 12, 12, 12, 16, 12 cells), to 0.15 K of a rise of 85 K", () => {
    const n = probe({ bulkTemperature: q(900, "K"), heatTransferCoefficient: q(2000, "W/m2/K") }, { kernelCells: 12, bufferCells: 12, ipycCells: 12, sicCells: 16, opycCells: 12 });
    const r = compare("convective", n, 0.15);
    // the wall: 937.04 K by the closed form, 937.032 K from OFFBEAT's own boundary value after 1e5 s
    expect(trisoClosedForm(n).wallT).toBeCloseTo(937.0431, 3);
    expect(r.s.wall).toBeCloseTo(937.0431, 1);
  });
});

describe("the finite-volume solution, in time", () => {
  /** A sphere of one material (k, c) with the kernel heated and a prescribed wall: the exact solution is a series in sin(n pi r / R) / r. */
  const k = 4;
  const c = 3e6;
  const alpha = k / c;
  const Tw = 1000;
  const uniform = () => {
    const d = particle();
    for (const name of ["kernel", "buffer", "ipyc", "sic", "opyc"]) d.materials[name].sets["thermal.conductivity"] = { model: "constant", value: q(k, "W/m/K"), referenceTemperature: q(1000, "K"), source: "synthetic: one material, for the exact series" };
    return norm(d);
  };
  const exact = (n: NormalizedTriso, t: number, r: number): number => {
    const R = n.outerRadius;
    const Rk = n.kernelRadius;
    const P = n.power.particlePower;
    const qv = n.power.kernelPowerDensity;
    const steadyDev = (x: number) => (x >= Rk ? (P / (4 * PI * k)) * (1 / x - 1 / R) : (P / (4 * PI * k)) * (1 / Rk - 1 / R) + (qv * (Rk * Rk - x * x)) / (6 * k));
    let sum = 0;
    for (let nn = 1; nn <= 400; nn++) {
      const lam = (nn * PI) / R;
      // b_n = (2 / R) integral of x d(x) sin(lam x) dx, by the midpoint rule
      const M = 4000;
      let b = 0;
      for (let i = 0; i < M; i++) {
        const x = ((i + 0.5) * R) / M;
        b += x * steadyDev(x) * Math.sin(lam * x) * (R / M);
      }
      b *= 2 / R;
      sum += b * Math.exp(-alpha * lam * lam * t) * (r === 0 ? lam : Math.sin(lam * r) / r);
    }
    return Tw + steadyDev(r) - sum;
  };
  const model = (n: NormalizedTriso) => ({ ...trisoModelOf(n, { capacities: [n.cells.map(() => [c])[0]!, [c], [c], [c], [c]], power: () => n.power.particlePower }), gapConductance: Infinity });
  it("follows the exact series of a sphere with a heated core and a prescribed wall, to 0.5 % of the rise (Crank-Nicolson) and 3 % (implicit Euler, one step of 1/400 of the slowest decay time), at four times and four cells", () => {
    const n = uniform();
    const R = n.outerRadius;
    const tau = (R * R) / (PI * PI * alpha); // the slowest decay time of the series
    const rise = exact(n, 1e9, 0) - Tw;
    const dt = tau / 400;
    const m = model(n);
    for (const scheme of ["crank-nicolson", "implicit-euler"] as const) {
      const fv = solveTrisoFv(m, { dt, steps: 1600, initialTemperature: Tw, outputEvery: 200, scheme });
      for (const s of fv.states.slice(1)) {
        // the cell nearest to the centre, and one in a coating
        for (const i of [0, 20, 40, 60]) {
          const want = exact(n, s.time, fv.r[i]!);
          expect(Math.abs(s.T[i]! - want)).toBeLessThan((scheme === "crank-nicolson" ? 0.005 : 0.03) * rise);
        }
      }
    }
  });
  it("is first order in the step for implicit Euler and second order for Crank-Nicolson (measured against the same mesh at a very small step, so the spatial error is not in it)", () => {
    const n = uniform();
    const R = n.outerRadius;
    const tau = (R * R) / (PI * PI * alpha);
    const m = model(n);
    const t = tau / 2;
    const at = (scheme: "implicit-euler" | "crank-nicolson", steps: number) => solveTrisoFv(m, { dt: t / steps, steps, initialTemperature: Tw, outputEvery: steps, scheme }).states[1]!.T;
    const ref = at("crank-nicolson", 1280);
    const err = (scheme: "implicit-euler" | "crank-nicolson", steps: number) => Math.max(...at(scheme, steps).map((x, i) => Math.abs(x - ref[i]!)));
    const ie = [10, 20, 40].map((s) => err("implicit-euler", s));
    expect(ie[0]! / ie[1]!).toBeGreaterThan(1.8);
    expect(ie[0]! / ie[1]!).toBeLessThan(2.2);
    expect(ie[1]! / ie[2]!).toBeGreaterThan(1.8);
    const cn = [10, 20, 40].map((s) => err("crank-nicolson", s));
    expect(cn[0]! / cn[1]!).toBeGreaterThan(3.5);
    expect(cn[0]! / cn[1]!).toBeLessThan(4.5);
    expect(cn[1]! / cn[2]!).toBeGreaterThan(3.5);
  });
  it("conserves energy to rounding, with a time-dependent power and conductivity and heat capacity that depend on temperature", () => {
    const d = particle();
    d.materials.kernel.sets["thermal.conductivity"] = lin(4, -0.0015, 300, 2500);
    d.materials.buffer.sets["thermal.conductivity"] = lin(0.8, -0.0003, 300, 2500);
    const n = norm(d);
    const caps = [[2.5e6, 400], [1.0e6, 300], [2.0e6, 200], [2.8e6, 300], [2.0e6, 100]];
    const power = (t: number) => n.power.particlePower * (0.2 + 0.8 * Math.sin((Math.PI * Math.min(t, 0.5)) / 0.5) ** 2);
    const m = trisoModelOf(n, { capacities: caps, power });
    for (const scheme of ["implicit-euler", "crank-nicolson"] as const) {
      const fv = solveTrisoFv(m, { dt: 0.002, steps: 300, initialTemperature: 1000, outputEvery: 100, scheme });
      for (const s of fv.states.slice(1)) {
        const stored = trisoStoredEnergy(m, fv, s.T, 1000);
        expect(s.deposited - s.rejected).toBeCloseTo(stored, 6);
        expect(Math.abs(s.deposited - s.rejected - stored)).toBeLessThan(1e-9 * s.deposited);
      }
    }
  });
  it("settles at the steady field: a long run of constant power ends where the steady solution is", () => {
    const n = norm(particle());
    const m = trisoModelOf(n, { capacities: [[2.5e6], [1.0e6], [2.0e6], [2.8e6], [2.0e6]] });
    const steady = steadyTrisoFv(m, n.power.particlePower);
    const fv = solveTrisoFv(m, { dt: 0.5, steps: 400, initialTemperature: 1000, outputEvery: 400 });
    const end = fv.states[1]!.T;
    expect(Math.max(...end.map((x, i) => Math.abs(x - steady.T[i]!)))).toBeLessThan(1e-6);
  });
  it("refuses an initial field of the wrong size, and two starts or none", () => {
    const n = norm(particle());
    const m = trisoModelOf(n);
    expect(() => solveTrisoFv(m, { dt: 1, steps: 1, initialField: [1000, 1000], outputEvery: 1 })).toThrow();
    expect(() => solveTrisoFv(m, { dt: 1, steps: 1, outputEvery: 1 })).toThrow();
    expect(() => solveTrisoFv(m, { dt: 1, steps: 1, initialTemperature: 1000, initialField: [], outputEvery: 1 })).toThrow();
  });
});

describe("the time scale and the steady end time", () => {
  it("is the Elmore sum written out here: each cell's capacity times its resistance to the coolant, times the safety factor", () => {
    const d = particle();
    d.mesh = { kernelCells: 4, bufferCells: 2, ipycCells: 2, sicCells: 2, opycCells: 2 };
    const n = norm(d);
    const ks = [3, 0.5, 4, 13.9, 4];
    const b = [0, 250e-6, 350e-6, 390e-6, 425e-6, 460e-6];
    const rg = 1 / (4 * PI * b[2]! ** 2 * 1.5e5);
    const shell = (x: number, y: number, k: number) => (1 / x - 1 / y) / (4 * PI * k);
    let sum = 0;
    n.cells.forEach((cells, ri) => {
      for (let j = 0; j < cells; j++) {
        const x0 = b[ri]! + ((b[ri + 1]! - b[ri]!) * j) / cells;
        const x1 = b[ri]! + ((b[ri + 1]! - b[ri]!) * (j + 1)) / cells;
        const rc = (3 / 4) * (x1 ** 4 - x0 ** 4) / (x1 ** 3 - x0 ** 3);
        let res = shell(rc, b[ri + 1]!, ks[ri]!);
        for (let o = ri + 1; o < 5; o++) res += shell(b[o]!, b[o + 1]!, ks[o]!);
        if (ri <= 1) res += rg;
        sum += STEADY_PSEUDO_HEAT_CAPACITY * ((4 / 3) * PI * (x1 ** 3 - x0 ** 3)) * res;
      }
    });
    const ts = trisoTimeScale(n);
    expect(ts.tauBound).toBeCloseTo(TAU_SAFETY * sum, 10);
    expect(ts.cells).toBe(12);
    // the factor that turns the bound into a max-norm horizon: the root of the total capacity over the smallest cell's
    const caps: number[] = [];
    n.cells.forEach((cells, ri) => {
      for (let j = 0; j < cells; j++) {
        const x0 = b[ri]! + ((b[ri + 1]! - b[ri]!) * j) / cells;
        const x1 = b[ri]! + ((b[ri + 1]! - b[ri]!) * (j + 1)) / cells;
        caps.push(STEADY_PSEUDO_HEAT_CAPACITY * ((4 / 3) * PI * (x1 ** 3 - x0 ** 3)));
      }
    });
    expect(ts.capacityRatio).toBeCloseTo(Math.sqrt(caps.reduce((a, c) => a + c, 0) / Math.min(...caps)), 9);
  });
  it("bounds the slowest decay of the particle from above: the finite-volume field decays no more slowly than the bound says, and not absurdly faster", () => {
    const n = norm(particle());
    const m = trisoModelOf(n);
    const steady = steadyTrisoFv(m, n.power.particlePower);
    // switch the power off and watch the centre return to the wall: the late decay rate is the slowest time constant
    const off = solveTrisoFv({ ...m, power: () => 0 }, { dt: 0.001, steps: 100, initialField: steady.T, outputEvery: 25, scheme: "crank-nicolson" });
    const dev = off.states.map((s) => s.T[0]! - 1000);
    const rate = Math.log(dev[2]! / dev[3]!) / (off.states[3]!.time - off.states[2]!.time);
    const tauMeasured = 1 / rate;
    const bound = trisoTimeScale(n).tauBound;
    expect(bound).toBeGreaterThanOrEqual(tauMeasured);
    expect(bound / tauMeasured).toBeLessThan(40);
  });
  it("gives the steady end time as at least the pin's floor, and says when the time scale is not a number", () => {
    const n = norm(particle());
    const h = trisoSteadyEndTime(n);
    expect(h.ok).toBe(true);
    if (h.ok) {
      expect(h.endTime).toBe(MIN_STEADY_END_TIME);
      expect(h.tauBound).toBeGreaterThan(0);
      expect(h.tauBound).toBeLessThan(1e3); // a particle settles in seconds; the floor is the pin's
    }
    expect(trisoInitialDeviationBound(n)).toBeCloseTo(trisoClosedForm(n).centreT - 1000, 9);
    // a particle that hardly warms starts within a kelvin of its steady state: the bound has a floor of 1 K
    const cold = particle();
    cold.power = { particlePower: q(1e-9, "W") };
    expect(trisoInitialDeviationBound(norm(cold))).toBe(1);
    const bad = { ...n, gapConductance: NaN };
    const hb = trisoSteadyEndTime(bad);
    expect(hb.ok).toBe(false);
    if (!hb.ok) expect(hb.message).toContain("not a finite number");
    expect(MAX_STEADY_END_TIME).toBeGreaterThan(MIN_STEADY_END_TIME);
    // a gap so weak that the particle could not settle within the longest run FEED allows is refused by the validator, with the reason
    const slow = particle();
    slow.gap.conductance = q(1e-12, "W/m2/K");
    const v = validateCase(slow);
    expect(v.errors.map((e) => e.code + " " + e.field)).toEqual(["E_TIME /assumptions/steadyState"]);
    expect(v.errors[0]!.message).toContain("slowest thermal time constant");
  });
  it("is bigger with a weaker gap and with a convective film, as the physics says", () => {
    const base = trisoTimeScale(norm(particle())).tauBound;
    const g = particle();
    g.gap.conductance = q(1.5e3, "W/m2/K");
    expect(trisoTimeScale(norm(g)).tauBound).toBeGreaterThan(base);
    const f = particle();
    f.boundary = { bulkTemperature: q(900, "K"), heatTransferCoefficient: q(200, "W/m2/K") };
    expect(trisoTimeScale(norm(f)).tauBound).toBeGreaterThan(base);
  });
});

describe("the quick look and the numbers beside the case", () => {
  it("says in-domain for constant conductivities and names a region whose temperatures leave its stated range", () => {
    const n = norm(particle());
    expect(trisoQuickLook(n).verdict).toBe("in-domain");
    const d = particle();
    d.materials.buffer.sets["thermal.conductivity"] = lin(0.8, -0.0003, 500, 1005);
    const look = trisoQuickLook(norm(d));
    expect(look.verdict).toBe("out-of-domain");
    expect(look.findings.map((f) => f.region)).toEqual(["buffer"]);
    expect(look.findings[0]!.validRange).toEqual([500, 1005]);
    expect(look.findings[0]!.temperatureRange[1]).toBeGreaterThan(1005);
  });
  it("derives the heat, the volumes, the flux, the compact's particle count and the layer drops by hand", () => {
    const d = particle();
    d.power = { compactPowerDensity: q(10, "W/cm3"), packingFraction: q(0.35, "1") };
    const n = norm(d);
    const dv = trisoDerived(n);
    const V = (4 / 3) * PI * 460e-6 ** 3;
    expect(dv.particleVolume).toBeCloseTo(V, 20);
    expect(dv.particlePower).toBeCloseTo((1e7 * V) / 0.35, 12);
    expect(dv.outerSurfaceHeatFlux).toBeCloseTo(dv.particlePower / (4 * PI * 460e-6 ** 2), 6);
    expect(dv.particlesPerCubicMetre).toBeCloseTo(0.35 / V, 0);
    expect(dv.compactPowerDensity).toBe(1e7);
    expect(dv.packingFraction).toBeCloseTo(0.35, 15);
    expect(dv.regionDrops.map((r) => r.name)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    expect(dv.centreT - dv.wallT).toBeCloseTo(dv.regionDrops.reduce((a, r) => a + r.deltaT, 0) + dv.gapDeltaT, 9);
    expect(dv.timeScale).toBeGreaterThan(0);
    // a power given per particle has no compact numbers
    expect(trisoDerived(norm(particle())).compactPowerDensity).toBeUndefined();
  });
  it("is shown by the editor's check beside the valid case (which now runs)", () => {
    const r = check(particle()) as { ok: boolean; errors: { code: string }[]; triso?: { quick: { verdict: string; closed: { centreT: number } }; derived: { particlePower: number } } };
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.triso!.quick.verdict).toBe("in-domain");
    expect(r.triso!.quick.closed.centreT).toBeCloseTo(trisoClosedForm(norm(particle())).centreT, 12);
    expect(r.triso!.derived.particlePower).toBeCloseTo(norm(particle()).power.particlePower, 15);
  });
  it("uses the sphere kernel for its cell volumes: the particle's volume is the sum of its cells'", () => {
    const n = norm(particle());
    const fv = solveTrisoFv(trisoModelOf(n), { dt: 1, steps: 1, initialTemperature: 1000, outputEvery: 1 });
    expect(fv.volume.reduce((a, b) => a + b, 0)).toBeCloseTo(SPHERE.volume(0, n.outerRadius), 18);
    expect(fv.volume.length).toBe(64);
    expect(fv.region.filter((x) => x === 0).length).toBe(12);
  });
});
