// Plan 17 M3: the independent thermo-elastic solution at a time of a transient (src/core/transientMechanics.ts) against the closed forms of the plan, worked by hand below,
// and the checks of OFFBEAT's mechanics at every output time with their negative tests. No file of OFFBEAT is read: a "result" here is made from the independent solution and then
// damaged in one way at a time, each of which a check must catch.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { validateCase, type NormalizedCase } from "../src/core/validate";
import { gasPressureAt, independentAtTime, meshCells, STRESS_NOISE_FLOOR, TOUCHING_FLOOR, transientMechanicsChecks, type MechanicsAtTime, type TemperatureField } from "../src/core/transientMechanics";
import type { MechanicsRecord } from "../src/core/mechanicsResults";
import { hydrogenPressure } from "../src/core/hydrogenPressure";
import { solveSlice, type ThermoElasticSolution } from "../src/core/thermoElastic";

const q = (value: number, unit: string) => ({ value, unit });
const Tref = 300;
const E = 100e9;
const nu = 0.3;
const alpha = 10e-6;
const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
const mu = E / (2 * (1 + nu));
const FR = 4.1e-3; // the pulse example's fuel radius, solid pellet
const CI = 4.18e-3;
const CO = 4.75e-3;
const G0 = CI - FR;

/** The pulse example as a pin with mechanics (constant properties on both solids), the given plane condition, coolant pressure 0 and a fine mesh. */
function fixture(over: { plane?: "free-axial" | "plane-strain"; internalPressure?: unknown; fuelCells?: number; claddingCells?: number; alphaFuel?: number; fuelModulusLinear?: boolean } = {}): NormalizedCase {
  const d = JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-pulse.json"), "utf8"));
  const sets = (a: number) => ({
    "mechanical.elasticity": { model: "constant", youngModulus: q(E / 1e9, "GPa"), poissonRatio: q(nu, "1"), source: "a test" },
    "mechanical.thermalExpansion": { linearExpansion: q(a * 1e6, "ppm/K"), source: "a test" },
  });
  Object.assign(d.materials.fuel.sets, sets(over.alphaFuel ?? alpha));
  if (over.fuelModulusLinear) d.materials.fuel.sets["mechanical.elasticity"] = { model: "linear", a: q(106, "GPa"), b: q(-0.02, "GPa/K"), poissonRatio: q(nu, "1"), validRange: { min: q(250, "K"), max: q(5000, "K") }, source: "a test" };
  Object.assign(d.materials.cladding.sets, sets(alpha));
  d.assumptions.thermalOnly = false;
  d.mechanics = { referenceTemperature: q(Tref, "K"), plane: over.plane ?? "plane-strain", contact: { penaltyFactor: q(0.7, "1") }, coolantPressure: q(0, "MPa"), ...(over.internalPressure ? { internalPressure: over.internalPressure } : {}) };
  d.mesh = { fuelCells: over.fuelCells ?? 200, claddingCells: over.claddingCells ?? 40 };
  const r = validateCase(d);
  if (!r.normalized) throw new Error(JSON.stringify(r.errors));
  return r.normalized;
}
const field = (c: NormalizedCase, fuel: (r: number) => number, clad: (r: number) => number): TemperatureField => {
  const cells = meshCells(c);
  return { fuelT: cells.filter((x) => x.region === "fuel").map((x) => fuel(x.r)), claddingT: cells.filter((x) => x.region === "cladding").map((x) => clad(x.r)) };
};
const uniform = (c: NormalizedCase, Tf: number, Tc = Tf) => field(c, () => Tf, () => Tc);

describe("closed form (a): both solids heated uniformly and equally by a ramp, free", () => {
  it("no stress, u = alpha dT r in both solids, and the gap changes by alpha dT (CI - FR) at every time", () => {
    const c = fixture({ plane: "free-axial" });
    for (const dT of [0, 50, 120, 300]) {
      const sol = independentAtTime(c, uniform(c, Tref + dT), 0);
      for (const r of [0.5e-3, 2e-3, 4.1e-3]) {
        const x = sol.fuel.at(r);
        expect(x.ur / (alpha * dT * r || 1)).toBeCloseTo(dT === 0 ? 0 : 1, 10);
        expect(Math.abs(x.sigmaR) + Math.abs(x.sigmaTheta) + Math.abs(x.sigmaZ)).toBeLessThan(1);
      }
      for (const r of [4.2e-3, 4.5e-3, 4.74e-3]) {
        const x = sol.cladding.at(r);
        expect(x.ur / (alpha * dT * r || 1)).toBeCloseTo(dT === 0 ? 0 : 1, 10);
        expect(Math.abs(x.sigmaR) + Math.abs(x.sigmaTheta) + Math.abs(x.sigmaZ)).toBeLessThan(1);
      }
      expect(sol.contact).toBe(false);
      expect(sol.gap).toBeCloseTo(G0 + alpha * dT * (CI - FR), 12);
    }
  });
});

describe("closed form (b) and (d): the fuel heated uniformly against a cladding at the stress-free temperature (plane strain)", () => {
  // fuel: solid pellet, free strain s = alpha dT; sigma_r(FR) = -p gives A = ((3 lambda + 2 mu) s - p) / (2 (lambda + mu)), u_f = A FR.
  // cladding (tube CI to CO, internal pressure p, plane strain): u_c(CI) = k p, k = (1 + nu) CI ((1 - 2 nu) CI^2 + CO^2) / (E (CO^2 - CI^2)).
  // Closure: G0 + k p - FR A = 0, so p = (FR (3 lambda + 2 mu) s / (2 (lambda + mu)) - G0) / (k + FR / (2 (lambda + mu))) once positive.
  const k = ((1 + nu) * CI * ((1 - 2 * nu) * CI * CI + CO * CO)) / (E * (CO * CO - CI * CI));
  const free = (s: number) => (FR * (3 * lambda + 2 * mu) * s) / (2 * (lambda + mu));
  const pressure = (s: number) => Math.max(0, (free(s) - G0) / (k + FR / (2 * (lambda + mu))));
  const sClose = (G0 * 2 * (lambda + mu)) / (FR * (3 * lambda + 2 * mu));
  const c = fixture({ plane: "plane-strain" });
  it("the strain at which the gap closes is s = 2 (lambda + mu) G0 / (FR (3 lambda + 2 mu)) = about 0.00127 (worked by hand: 0.08e-3 / 4.1e-3 times 1.3 ... )", () => {
    // lambda = 57.69 GPa, mu = 38.46 GPa for E = 100 GPa, nu = 0.3: 2 (96.15) / (3 * 57.69 + 2 * 38.46 = 250.0) = 0.7692; times G0 / FR = 0.019512 gives 0.015009
    expect(lambda / 1e9).toBeCloseTo(57.692, 3);
    expect(mu / 1e9).toBeCloseTo(38.462, 3);
    expect(sClose).toBeCloseTo(0.7692 * (0.08 / 4.1), 3);
  });
  it("before closure there is no pressure and the gap is G0 - free(s); after it the pressure is the interference of the two cylinders, at every dT", () => {
    for (const dT of [0, 400, 1000, 1500, 2000, 3000, 4000]) {
      const s = alpha * dT;
      const sol = independentAtTime(c, uniform(c, Tref + dT, Tref), 0);
      const p = pressure(s);
      if (p === 0) {
        expect(sol.contact).toBe(false);
        expect(sol.contactPressure).toBe(0);
        expect(sol.gap / (G0 - free(s))).toBeCloseTo(1, 10);
      } else {
        expect(sol.contact).toBe(true);
        expect(sol.gap).toBe(0);
        expect(sol.contactPressure / p).toBeCloseTo(1, 9);
        // the fuel's radial stress at its surface is -p
        expect(sol.fuel.at(FR).sigmaR / -p).toBeCloseTo(1, 9);
      }
    }
    // the hand numbers: the gap closes at dT = sClose / alpha (a very hot pellet: a synthetic coefficient, not a property)
    expect(sClose / alpha).toBeGreaterThan(1000);
  });
  it("(d) cooling reopens the gap: the pressure falls to zero at the same strain and the gap grows after it, with no memory of the way up", () => {
    const up = [0, 1000, 2000, 3000, 4000].map((dT) => independentAtTime(c, uniform(c, Tref + dT, Tref), 0));
    const down = [4000, 3000, 2000, 1000, 0].map((dT) => independentAtTime(c, uniform(c, Tref + dT, Tref), 0));
    up.forEach((u, i) => {
      const d = down[4 - i]!;
      expect(d.contactPressure).toBe(u.contactPressure);
      expect(d.gap).toBe(u.gap);
      expect(d.fuel.at(2e-3).sigmaTheta).toBe(u.fuel.at(2e-3).sigmaTheta);
    });
    expect(up[0]!.contact).toBe(false);
    expect(up[4]!.contact).toBe(true);
    expect(down[4]!.gap).toBeGreaterThan(down[3]!.gap);
  });
});

describe("closed form (c): the parabolic temperature of a heating fuel (a source in a cylinder), the cladding free (Timoshenko and Goodier)", () => {
  // theta = t0 (1 - (r/b)^2). With K = alpha E t0 / (1 - nu), the generalized plane strain solution with free ends is
  //   sigma_r = -K (1 - x) / 4,  sigma_theta = K (-1 + 3 x) / 4,  sigma_z = K (-1 + 2 x) / 2,   x = (r/b)^2 (integrals of theta r dr by hand: t0 (r^2/2 - r^4 / (4 b^2)) and t0 b^2 / 4)
  it("the stresses at four radii, 200 cells (the piecewise-constant strain is within 0.5 % of the continuous profile)", () => {
    const c = fixture({ plane: "free-axial" });
    const t0 = 300;
    const sol = independentAtTime(c, field(c, (r) => Tref + t0 * (1 - (r / FR) ** 2), () => Tref), 0);
    const K = (alpha * E * t0) / (1 - nu);
    const cells = meshCells(c).filter((x) => x.region === "fuel");
    for (const i of [10, 60, 120, 190]) {
      const r = cells[i]!.r;
      const x = (r / FR) ** 2;
      const got = sol.fuel.at(r);
      const bound = 0.005 * K;
      expect(Math.abs(got.sigmaR - (-K * (1 - x)) / 4)).toBeLessThan(bound);
      expect(Math.abs(got.sigmaTheta - (K * (-1 + 3 * x)) / 4)).toBeLessThan(bound);
      expect(Math.abs(got.sigmaZ - (K * (-1 + 2 * x)) / 2)).toBeLessThan(bound);
    }
    expect(sol.contact).toBe(false);
  });
});

describe("no memory", () => {
  it("the answer at a time is the same in any order of the times and after any others (the function keeps no state)", () => {
    const c = fixture({ plane: "free-axial" });
    const states = [20, 800, 3000, 200, 4000, 1000].map((dT) => uniform(c, Tref + dT, Tref + dT / 4));
    const run = (order: number[]) => order.map((i) => independentAtTime(c, states[i]!, 0));
    const a = run([0, 1, 2, 3, 4, 5]);
    const b = run([5, 4, 3, 2, 1, 0]).reverse();
    const d = run([3, 0, 5, 1, 4, 2]);
    const key = (s: ThermoElasticSolution) => JSON.stringify([s.gap, s.contactPressure, s.fuel.at(3e-3), s.cladding.at(4.5e-3)]);
    states.forEach((_, i) => {
      expect(key(b[i]!)).toBe(key(a[i]!));
      expect(key(independentAtTime(c, states[i]!, 0))).toBe(key(a[i]!));
    });
    // d holds the states in the order [3, 0, 5, 1, 4, 2]
    [3, 0, 5, 1, 4, 2].forEach((state, pos) => expect(key(d[pos]!)).toBe(key(a[state]!)));
  });
});

describe("the gas pressure at a time", () => {
  const hot = (c: NormalizedCase) => field(c, (r) => 900 + 400 * (1 - (r / FR) ** 2), () => 700).fuelT;
  it("a constant is constant; none is zero; a table is linear between its points and refuses a time outside it", () => {
    expect(gasPressureAt(fixture(), 0.05, [900])).toBe(0);
    expect(gasPressureAt(fixture({ internalPressure: { model: "constant", pressure: q(2, "MPa"), source: "t" } }), 0.05, [900])).toBe(2e6);
    const c = fixture({ internalPressure: { model: "table", table: [{ time: q(0, "ms"), pressure: q(1, "MPa") }, { time: q(10, "ms"), pressure: q(3, "MPa") }, { time: q(100, "ms"), pressure: q(0.5, "MPa") }], source: "t" } });
    expect(gasPressureAt(c, 0, [900])).toBe(1e6);
    expect(gasPressureAt(c, 0.005, [900])).toBeCloseTo(2e6, 6);
    expect(gasPressureAt(c, 0.01, [900])).toBeCloseTo(3e6, 6);
    // between 10 and 100 ms: 3 - 2.5 * (55 - 10) / 90 = 1.75 MPa
    expect(gasPressureAt(c, 0.055, [900])).toBeCloseTo(1.75e6, 6);
    expect(gasPressureAt(c, 0.1, [900])).toBeCloseTo(0.5e6, 6);
    expect(() => gasPressureAt(c, 0.2, [900])).toThrow(/outside the pressure table/);
  });
  it("the hydrogen pressure is Simnad's at the instantaneous peak or at the volume mean of the fuel cells", () => {
    const ip = (basis: string) => ({ model: "hydrogen-zrh", hZrRatio: q(1.65, "1"), fuelTemperature: basis, source: "t" });
    const cp = fixture({ internalPressure: ip("instantaneous-peak") });
    const cm = fixture({ internalPressure: ip("instantaneous-mean") });
    const T = hot(cp);
    const peak = Math.max(...T);
    expect(gasPressureAt(cp, 0.01, T)).toBe(hydrogenPressure(1.65, peak));
    // the mean weighs a cell by the annulus it fills; hand: for the parabola 900 + 400 (1 - x), x = (r/b)^2, the area mean is 900 + 400 / 2 = 1100 K
    expect(gasPressureAt(cm, 0.01, T) / hydrogenPressure(1.65, 1100)).toBeCloseTo(1, 3);
    expect(gasPressureAt(cp, 0.01, T)).toBeGreaterThan(gasPressureAt(cm, 0.01, T));
  });
});

/** An "OFFBEAT result" made from the independent solution at the same temperatures: points at the cell centres and the contact. */
function resultFrom(c: NormalizedCase, sol: ThermoElasticSolution): MechanicsRecord {
  const cells = meshCells(c);
  const points = cells.map((cell) => {
    const x = (cell.region === "fuel" ? sol.fuel : sol.cladding).at(cell.r);
    const eq = Math.sqrt(0.5 * ((x.sigmaR - x.sigmaTheta) ** 2 + (x.sigmaTheta - x.sigmaZ) ** 2 + (x.sigmaZ - x.sigmaR) ** 2));
    return { ur: x.ur, uz: 0, sigmaR: x.sigmaR, sigmaTheta: x.sigmaTheta, sigmaZ: x.sigmaZ, sigmaEq: eq };
  });
  const solid = () => ({ maxEquivalent: 0, radial: [0, 0] as [number, number], hoop: [0, 0] as [number, number], axial: [0, 0] as [number, number], outerDisplacement: 0 });
  return {
    kind: "thermo-elastic",
    plane: c.mechanics!.plane,
    referenceTemperature: Tref,
    penaltyFactor: 0.7,
    coolantPressure: 0,
    internalPressure: 0,
    properties: {} as MechanicsRecord["properties"],
    points,
    summary: { fuel: solid(), cladding: solid(), gapWidth: sol.gap, contactPressure: sol.contact ? sol.contactPressure : 1e-4, contact: sol.contact },
    note: "test",
  };
}
const verdicts = (r: { checks: { id: string; verdict: string }[] }) => Object.fromEntries(r.checks.map((x) => [x.id, x.verdict]));

describe("the checks at every output time", () => {
  // a pulse-like sequence of temperature fields: cold, heating (parabolic), hot enough to close the gap (the cladding stays cold), cooling back
  const c = fixture({ plane: "plane-strain", fuelCells: 60, claddingCells: 12 });
  const dTs = [0, 800, 2200, 3500, 2500, 900];
  const fields = dTs.map((d) => field(c, (r) => Tref + d * (1 - 0.3 * (r / FR) ** 2), () => Tref + d / 40));
  const sols = fields.map((f) => independentAtTime(c, f, 0));
  const times = dTs.map((_, i) => 0.01 * i);
  const good = (): MechanicsAtTime[] => times.map((time, i) => ({ time, record: resultFrom(c, sols[i]!), field: fields[i]! }));
  it("the sequence has an open gap, a closed gap and an open gap again", () => {
    expect(sols.map((s) => s.contact)).toEqual([false, false, true, true, true, false]);
  });
  it("a result that is the independent solution passes every check at every time, with no allowance", () => {
    const r = transientMechanicsChecks(c, good(), 0);
    expect(verdicts(r)).toEqual({ mechanicsDisplacement: "pass", mechanicsStress: "pass", mechanicsEquilibrium: "pass", mechanicsContact: "pass" });
    expect(r.perTime).toHaveLength(6);
    expect(r.perTime.map((v) => v.contactTouching)).toEqual([false, false, true, true, true, false]);
    expect(r.checks.find((x) => x.id === "mechanicsContact")!.note).toMatch(/3 of 6 output times have the solids touching; 0 of 6 fail/);
  });
  it("the touching rule: an open gap OFFBEAT writes 1e-4 Pa on is not contact; a pressure above the 10 kPa floor is", () => {
    expect(TOUCHING_FLOOR).toBe(1e4);
    const r = transientMechanicsChecks(c, good(), 0);
    expect(r.perTime[1]!.contactTouching).toBe(false);
    expect(r.perTime[2]!.contactTouching).toBe(true);
  });
  it("negative: the result of time k read as time k + 1 fails", () => {
    const g = good();
    const shifted = g.map((x, i) => ({ ...x, record: g[Math.max(0, i - 1)]!.record }));
    const v = verdicts(transientMechanicsChecks(c, shifted, 0));
    expect(v.mechanicsDisplacement).toBe("fail");
    expect(v.mechanicsStress).toBe("fail");
  });
  it("negative: the independent temperatures one output late fail (the check cannot be satisfied by the wrong time)", () => {
    const g = good();
    const late = g.map((x, i) => ({ ...x, field: fields[Math.max(0, i - 1)]! }));
    expect(verdicts(transientMechanicsChecks(c, late, 0)).mechanicsStress).toBe("fail");
  });
  it("negative: the displacement of the other solid fails; so does a displacement 3 % too large", () => {
    const g = good();
    const swapped = g.map((x) => ({ ...x, record: { ...x.record, points: x.record.points.map((p, i, all) => ({ ...p, ur: all[(i + 60) % all.length]!.ur })) } }));
    expect(verdicts(transientMechanicsChecks(c, swapped, 0)).mechanicsDisplacement).toBe("fail");
    const big = g.map((x) => ({ ...x, record: { ...x.record, points: x.record.points.map((p) => ({ ...p, ur: p.ur * 1.03 })) } }));
    expect(verdicts(transientMechanicsChecks(c, big, 0)).mechanicsDisplacement).toBe("fail");
  });
  it("negative: the gas pressure applied for the wrong time fails (a table whose values are shifted by one output)", () => {
    const table = (shift: number) => {
      const p = [0.1, 1, 6, 12, 8, 2].map((v) => v);
      return { model: "table", table: [...times.map((t, i) => ({ time: q(t * 1000, "ms"), pressure: q(p[Math.max(0, Math.min(5, i + shift))]!, "MPa") })), { time: q(100, "ms"), pressure: q(p[Math.max(0, Math.min(5, 5 + shift))]!, "MPa") }], source: "t" };
    };
    const cOk = fixture({ plane: "plane-strain", fuelCells: 60, claddingCells: 12, internalPressure: table(0) });
    const cShift = fixture({ plane: "plane-strain", fuelCells: 60, claddingCells: 12, internalPressure: table(-1) });
    const results = times.map((time, i) => ({ time, record: resultFrom(cOk, independentAtTime(cOk, fields[i]!, gasPressureAt(cOk, time, fields[i]!.fuelT))), field: fields[i]! }));
    expect(verdicts(transientMechanicsChecks(cOk, results, 0)).mechanicsStress).toBe("pass");
    // the same results judged by a case whose table is one output late
    const v = verdicts(transientMechanicsChecks(cShift, results, 0));
    expect([v.mechanicsStress, v.mechanicsDisplacement, v.mechanicsContact]).toContain("fail");
  });
  it("negative: a contact pressure 20 % off, a contact reported when the gap is open, and the contact missed when the solids touch, each fail", () => {
    const g = good();
    const bump = (f: (m: MechanicsRecord, i: number) => MechanicsRecord) => g.map((x, i) => ({ ...x, record: f(x.record, i) }));
    expect(verdicts(transientMechanicsChecks(c, bump((m) => (m.summary.contactPressure! > 1e5 ? { ...m, summary: { ...m.summary, contactPressure: m.summary.contactPressure! * 1.2 } } : m)), 0)).mechanicsContact).toBe("fail");
    expect(verdicts(transientMechanicsChecks(c, bump((m, i) => (i === 1 ? { ...m, summary: { ...m.summary, contactPressure: 5e6, gapWidth: 0 } } : m)), 0)).mechanicsContact).toBe("fail");
    expect(verdicts(transientMechanicsChecks(c, bump((m, i) => (i === 3 ? { ...m, summary: { ...m.summary, contactPressure: 1e-4, gapWidth: 2e-6 } } : m)), 0)).mechanicsContact).toBe("fail");
  });
  it("the radial balance of OFFBEAT's own field: a stress that does not balance fails", () => {
    const g = good();
    const bad = g.map((x) => ({ ...x, record: { ...x.record, points: x.record.points.map((p, i) => (i === 30 ? { ...p, sigmaR: p.sigmaR + 40e6 } : p)) } }));
    expect(verdicts(transientMechanicsChecks(c, bad, 0)).mechanicsEquilibrium).toBe("fail");
  });
  it("the temperature allowance: a stress off by what 1 K of temperature gives passes with a 1 K allowance and fails with none; 8 K off fails even with it", () => {
    const g = good();
    const warm = (dK: number) => g.map((x, i) => ({ ...x, record: resultFrom(c, independentAtTime(c, fields[i]!, 0, dK)) }));
    // E alpha dT / (1 - nu) = 100e9 * 10e-6 * 1 / 0.7 = 1.43 MPa per kelvin: above the 0.35 MPa floor plus 3 % of a 20 MPa scale at the cold times, below it at the hot ones
    expect(verdicts(transientMechanicsChecks(c, warm(1), 1)).mechanicsStress).toBe("pass");
    expect(verdicts(transientMechanicsChecks(c, warm(8), 1)).mechanicsStress).toBe("fail");
  });
  it("the verdict is the worst time: one damaged time fails the check, which names it, and the other times are counted", () => {
    const g = good();
    g[3] = { ...g[3]!, record: { ...g[3]!.record, points: g[3]!.record.points.map((p) => ({ ...p, sigmaTheta: p.sigmaTheta * 1.5 })) } };
    const r = transientMechanicsChecks(c, g, 0);
    const s = r.checks.find((x) => x.id === "mechanicsStress")!;
    expect(s.verdict).toBe("fail");
    expect(s.note).toMatch(/worst at t = 0\.03 s/);
    expect(s.note).toMatch(/1 of 6 output times fail/);
    expect(r.perTime.filter((v) => !v.stress.pass).map((v) => v.time)).toEqual([0.03]);
  });
  it("no output time cannot be judged: every check fails; a negative allowance is refused", () => {
    const r = transientMechanicsChecks(c, [], 0);
    expect(r.checks.every((x) => x.verdict === "fail")).toBe(true);
    expect(() => transientMechanicsChecks(c, good(), -1)).toThrow(/allowance/);
  });
  it("the noise floor is 0.35 MPa and is the only floor of the stress check", () => {
    expect(STRESS_NOISE_FLOOR).toBe(0.35e6);
  });
});

describe("the laws of temperature are applied cell by cell (decision D3)", () => {
  it("closed form (b) with the fuel's modulus at its own temperature: E_f = 106 - 0.02 T GPa gives the interference pressure of THAT modulus, not of the modulus at the reference temperature", () => {
    const c = fixture({ plane: "plane-strain", fuelModulusLinear: true });
    const k = ((1 + nu) * CI * ((1 - 2 * nu) * CI * CI + CO * CO)) / (E * (CO * CO - CI * CI));
    for (const dT of [2000, 3000, 4000]) {
      const Ef = 106e9 - 0.02e9 * (Tref + dT);
      const lf = (Ef * nu) / ((1 + nu) * (1 - 2 * nu));
      const mf = Ef / (2 * (1 + nu));
      const sval = alpha * dT;
      const p = (FR * (3 * lf + 2 * mf) * sval / (2 * (lf + mf)) - G0) / (k + FR / (2 * (lf + mf)));
      const sol = independentAtTime(c, uniform(c, Tref + dT, Tref), 0);
      expect(sol.contact).toBe(true);
      expect(sol.contactPressure / p).toBeCloseTo(1, 9);
      // the modulus at the reference temperature (100 GPa) would give a different pressure
      const lr = lambda;
      const mr = mu;
      const pRef = (FR * (3 * lr + 2 * mr) * sval / (2 * (lr + mr)) - G0) / (k + FR / (2 * (lr + mr)));
      expect(Math.abs(pRef / p - 1)).toBeGreaterThan(0.01);
    }
  });
});

describe("what the bounds carry (each term is needed: removing it makes one of these fail)", () => {
  const c = fixture({ plane: "plane-strain", fuelCells: 60, claddingCells: 12 });
  const cold = uniform(c, Tref);
  const coldSol = independentAtTime(c, cold, 0);
  const withStress = (add: number) => {
    const rec = resultFrom(c, coldSol);
    return [{ time: 0, field: cold, record: { ...rec, points: rec.points.map((p, i) => (i === 20 ? { ...p, sigmaZ: p.sigmaZ + add } : p)) } }];
  };
  it("the noise floor: with no stress at all, 0.2 MPa of noise passes and 0.5 MPa fails (the bound is the floor alone)", () => {
    expect(verdicts(transientMechanicsChecks(c, withStress(0.2e6), 0)).mechanicsStress).toBe("pass");
    expect(verdicts(transientMechanicsChecks(c, withStress(0.5e6), 0)).mechanicsStress).toBe("fail");
  });
  it("the same floor in the radial balance: a 0.1 MPa step in sigma_r between two cells passes, 1 MPa fails", () => {
    const stepR = (add: number) => {
      const rec = resultFrom(c, coldSol);
      return [{ time: 0, field: cold, record: { ...rec, points: rec.points.map((p, i) => (i === 20 ? { ...p, sigmaR: p.sigmaR + add } : p)) } }];
    };
    expect(verdicts(transientMechanicsChecks(c, stepR(0.1e6), 0)).mechanicsEquilibrium).toBe("pass");
    expect(verdicts(transientMechanicsChecks(c, stepR(1e6), 0)).mechanicsEquilibrium).toBe("fail");
  });
  it("the displacement allowance: a displacement off by what 1 K gives passes with the 1 K allowance and fails with none", () => {
    const hot = field(c, (r) => Tref + 900 * (1 - 0.3 * (r / FR) ** 2), () => Tref + 22);
    const base = independentAtTime(c, hot, 0);
    const warmer = independentAtTime(c, hot, 0, 1);
    // OFFBEAT's temperatures 1 K above the independent ones: its displacement is the warmer solution's
    const rec = resultFrom(c, warmer);
    const results = [{ time: 0, field: hot, record: rec }];
    expect(resultFrom(c, base).points[10]!.ur).not.toBe(rec.points[10]!.ur);
    // the shift is below 1 % of the largest displacement, so use a damaged scale: 10 K
    const way = resultFrom(c, independentAtTime(c, hot, 0, 10));
    expect(verdicts(transientMechanicsChecks(c, [{ time: 0, field: hot, record: way }], 0)).mechanicsDisplacement).toBe("fail");
    expect(verdicts(transientMechanicsChecks(c, [{ time: 0, field: hot, record: way }], 10)).mechanicsDisplacement).toBe("pass");
    expect(verdicts(transientMechanicsChecks(c, results, 1)).mechanicsDisplacement).toBe("pass");
  });
  it("the contact allowance: a pressure just past the closure, which 8 K of temperature moves by more than 3 % + 10 kPa, passes with the 8 K allowance and fails with none", () => {
    const hot = uniform(c, Tref + 1502, Tref); // 1 K past the closure of the gap, where the pressure is a few kPa
    const sol = independentAtTime(c, hot, 0);
    const warmer = independentAtTime(c, hot, 0, 8);
    expect(sol.contact && warmer.contact).toBe(true);
    expect(Math.abs(warmer.contactPressure - sol.contactPressure)).toBeGreaterThan(0.03 * sol.contactPressure + 1e4);
    const rec = resultFrom(c, sol);
    const results = [{ time: 0, field: hot, record: { ...rec, summary: { ...rec.summary, contactPressure: warmer.contactPressure } } }];
    expect(verdicts(transientMechanicsChecks(c, results, 0)).mechanicsContact).toBe("fail");
    expect(verdicts(transientMechanicsChecks(c, results, 8)).mechanicsContact).toBe("pass");
  });
  it("the end load of the fuel under a gas pressure (free axially): the solution agrees with thermoElastic.ts when the gas is 5 MPa", () => {
    const cf = fixture({ plane: "free-axial", fuelCells: 120, claddingCells: 30 });
    const hot = field(cf, (r) => Tref + 600 * (1 - 0.2 * (r / FR) ** 2), () => Tref + 20);
    const mine = independentAtTime(cf, hot, 5e6);
    // thermoElastic.ts: the same solids with the continuous profile and the constants
    const ref = solveSlice(
      { a: 0, b: FR, E, nu, alpha, theta: (r) => 600 * (1 - 0.2 * (r / FR) ** 2) },
      { a: CI, b: CO, E, nu, alpha, theta: () => 20 },
      "free-axial",
      0,
      5e6,
    );
    expect(mine.contact).toBe(ref.contact);
    for (const r of [1e-3, 2.5e-3, 4e-3]) {
      expect(Math.abs(mine.fuel.at(r).sigmaZ - ref.fuel.at(r).sigmaZ) / 1e6).toBeLessThan(1.5);
    }
    // the gas on the end of the fuel makes its axial stress +p (tension) in OFFBEAT's convention: the mean over the area is about +5 MPa
    expect(mine.fuel.axialStrain).toBeCloseTo(ref.fuel.axialStrain, 6);
  });
});
