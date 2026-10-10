// A mechanics case through FEED's own writer, run manager and results parser on the real solver (needs FEED_SOLVER=1; docs/plans/09-mechanics.md M2 gate: an elastic case
// runs and its stresses read back). The expected values are closed forms written here (free thermal expansion, the plane-strain cylinder, the interference of two cylinders)
// and the numbers of the M0 probe; the independent thermo-elastic solution and its checks on every result are M3.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { effectiveMechanics } from "../src/core/mechanicalEval";
import { ResultsRecord } from "../src/core/resultsParser";
import { RunManager } from "../src/core/runManager";
import { independentSolution } from "../src/core/thermoElastic";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

const elastic = (E: number, nu: number, alpha: number) => ({
  "mechanical.elasticity": { model: "constant", youngModulus: q(E, "Pa"), poissonRatio: q(nu, "1"), source: "synthetic: chosen for the closed-form checks" },
  "mechanical.thermalExpansion": { linearExpansion: q(alpha, "1/K"), source: "synthetic: chosen for the closed-form checks" },
});
interface Options {
  q?: number;
  T?: number;
  rci?: number;
  plane?: "free-axial" | "plane-strain";
  penalty?: number;
  pressure?: number;
  fuel?: [number, number, number];
  cladding?: [number, number, number];
  Tref?: number;
}
function mechanicsCase(o: Options = {}) {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
  // 10 W/m: the pin is within a third of a kelvin of its coolant temperature, and the cladding's temperature difference (0.014 K) is large enough for the thermal energy balance to be read through OFFBEAT's eight printed digits (at 1 W/m it is about 1 %, the check's threshold)
  d.power.linearHeatRate = q(o.q ?? 10, "W/m");
  d.boundary = { bulkTemperature: q(o.T ?? 600, "K"), heatTransferCoefficient: q(30000, "W/m2/K") };
  d.geometry.claddingInnerRadius = q(o.rci ?? 4.12, "mm");
  d.mesh = { fuelCells: 20, claddingCells: 8 };
  d.assumptions.thermalOnly = false;
  Object.assign(d.materials.fuel.sets, elastic(...(o.fuel ?? [2e11, 0.3, 1e-5])));
  Object.assign(d.materials.cladding.sets, elastic(...(o.cladding ?? [2e11, 0.3, 1e-5])));
  d.mechanics = { referenceTemperature: q(o.Tref ?? 300, "K"), plane: o.plane ?? "free-axial", contact: { penaltyFactor: q(o.penalty ?? 0.5, "1") }, coolantPressure: q(o.pressure ?? 0, "Pa") };
  return d;
}
async function run(d: unknown) {
  const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-mechrun-")), backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1800));
  return { rec, res: mgr.results(s.id) as ResultsRecord };
}
const allPass = (r: ResultsRecord) => r.checks.filter((c) => c.verdict !== "pass").map((c) => c.id + ": " + c.note);

describe.skipIf(!solverOn)("an elastic case through the real solver (needs FEED_SOLVER=1)", () => {
  it("free thermal expansion: a pin at its coolant temperature grows by alpha dT r with no stress, and every check passes", async () => {
    const { rec, res } = await run(mechanicsCase());
    expect(rec.state).toBe("completed");
    expect(allPass(res!)).toEqual([]);
    const m = res!.mechanics!;
    expect(m.kind).toBe("thermo-elastic");
    expect(res!.thermalOnly).toMatch(/^Thermo-elastic result/);
    const expected = 1e-5 * 300; // alpha (600 K - 300 K)
    const fuelOuter = res!.radial.filter((p) => p.region === "fuel").slice(-1)[0]!;
    const i = res!.radial.indexOf(fuelOuter);
    expect(Math.abs(m.points[i]!.ur / (expected * fuelOuter.r) - 1)).toBeLessThan(2e-3);
    for (const p of m.points) for (const s of [p.sigmaR, p.sigmaTheta]) expect(Math.abs(s)).toBeLessThan(2e6); // no stress to 2 MPa: the 0.27 K across the fuel gives E alpha dT = 0.5 MPa at most (the axial component carries the solver's noise of about 50 kPa)
    expect(m.summary.contact).toBe(false);
    // the gap between the solids at the end: b (1 + e) - a (1 + e) with the same strain on both, to a micron
    expect(m.summary.gapWidth! * 1e6).toBeCloseTo((4.12 - 4.1) * 1e3 * (1 + expected), 0);
  }, 300_000);

  it("plane strain (axially fixed): the radial displacement is (1 + nu) alpha dT r and the axial stress is -E alpha dT", async () => {
    const { res } = await run(mechanicsCase({ plane: "plane-strain" }));
    expect(allPass(res!)).toEqual([]);
    const m = res!.mechanics!;
    const nu = 0.3, a = 1e-5, dT = 300, E = 2e11;
    const fuelOuter = res!.radial.filter((p) => p.region === "fuel").slice(-1)[0]!;
    const i = res!.radial.indexOf(fuelOuter);
    expect(Math.abs(m.points[i]!.ur / ((1 + nu) * a * dT * fuelOuter.r) - 1)).toBeLessThan(5e-3);
    const sz = m.points[i]!.sigmaZ;
    expect(Math.abs(sz / (-E * a * dT) - 1)).toBeLessThan(5e-3);
  }, 300_000);

  it("an external pressure on the cladding: the hoop stress of a thick tube (Lame), read back", async () => {
    const { res } = await run(mechanicsCase({ pressure: 15e6, rci: 4.1 + 0.001 }));
    expect(allPass(res!)).toEqual([]);
    const m = res!.mechanics!;
    // the cladding alone is loaded by 15 MPa outside and, through the gap that has closed only to a micron, nothing inside it: it is compressed in the hoop direction
    const clad = res!.radial.map((p, k) => ({ p, k })).filter((x) => x.p.region === "cladding");
    for (const x of clad) expect(m.points[x.k]!.sigmaTheta).toBeLessThan(0);
    expect(m.summary.cladding.hoop[0]).toBeLessThan(-15e6); // the hoop compression of a tube under external pressure exceeds the pressure at the inner surface
  }, 300_000);

  it("a fuel that expands four times as fast as its cladding closes a 20 micron gap and presses on the cladding: the interference pressure of the closed form (101.3 MPa, M0) within 3 %", async () => {
    const { res } = await run(mechanicsCase({ fuel: [2e11, 0.3, 4e-5], cladding: [2e11, 0.3, 1e-5], rci: 4.12, penalty: 0.5 }));
    expect(allPass(res!)).toEqual([]);
    const m = res!.mechanics!;
    expect(m.summary.contact).toBe(true);
    expect(Math.abs(m.summary.contactPressure! / 101.3e6 - 1)).toBeLessThan(0.03);
    // in contact the fuel is under a hydrostatic compression equal to the interface pressure (M0 finding 3), to 3 %
    const fuelCells = res!.radial.map((p, k) => ({ p, k })).filter((x) => x.p.region === "fuel");
    for (const x of fuelCells) expect(Math.abs(m.points[x.k]!.sigmaR / -101.3e6 - 1)).toBeLessThan(0.03);
  }, 300_000);

  it("a temperature-dependent modulus and expansion (the library's TRIGA fuel and stainless cladding) are reduced to constants and the run completes with every check passing", async () => {
    const d = JSON.parse(readFileSync(join(root, "examples", "ksu-triga-hot-element.json"), "utf8"));
    const lib: any[] = JSON.parse(readFileSync(join(root, "library", "materials.json"), "utf8"));
    d.materials.fuel = lib.find((e) => e.material.materialId === "triga-uzrh-h16").material;
    d.materials.cladding = lib.find((e) => e.material.materialId === "ss304-k166").material;
    d.geometry.claddingInnerRadius = q(d.geometry.fuelRadius.value + 0.2, "mm");
    d.assumptions.thermalOnly = false;
    d.mechanics = { referenceTemperature: q(293.15, "K"), plane: "free-axial", contact: { penaltyFactor: q(0.5, "1") }, coolantPressure: q(0.1, "MPa") };
    const { rec, res } = await run(d);
    expect(rec.state, JSON.stringify(rec.failure)).toBe("completed");
    expect(allPass(res!)).toEqual([]);
    const p = res!.mechanics!.properties;
    expect(p.fuel.E).toBeGreaterThan(41e9); // between the SARs' 62.7 GPa at 20 C and 41.4 GPa at 650 C
    expect(p.fuel.E).toBeLessThan(63e9);
    expect(p.cladding.E).toBeCloseTo(190e9, -6);
  }, 300_000);
});

// M3's sweep (docs/plans/09-mechanics.md): the contact pressure depends on the penalty factor, and the M0 probe found that on one geometry and one pair of materials. Here three cold
// gaps (10, 20, 40 micron) and three stiffness ratios of the fuel to the cladding (E 5e10, 2e11, 4e11 against 2e11), the fuel's expansion chosen (by bisection on the independent
// solution) so that free expansion would overlap the solids by 5 micron, which presses them with 23 to 32 MPa, the order of a real pin's contact pressure. What the sweep found
// (docs/mechanics.md, "What it was checked against") is asserted here as it is, so that a change in the writer or the solver that moves it shows:
//  - at a factor that suits the pair the contact pressure is within 3 % of the independent solution and every check passes: 0.3 for the equal and the stiffer fuel;
//  - the fuel a quarter as stiff as the cladding (the TRIGA fuel against steel) is the known limit: the factor must be 0.7 for the penalty contact to be stable and its pressure is
//    then 3 % low (2.7 to 3.1 %), at the edge of the tolerance, so the stress check can fail; the run completes, the solids touch and the pressure is within 4 %;
//  - a factor that is too small is accepted by the solver and by the run and then FAILS the contact check (the pressure 13 % low at 0.05 for equal moduli); a factor that is too
//    large for the pair never converges and the run fails with E_NOT_CONVERGED, never a result. A bad factor is never a pass.
// A first sweep with overlaps of 60 micron (a closure of 1.5 % strain, 100 to 250 MPa) is not repeated: the displacement then missed its 1 % by the micron of overlap the penalty
// contact leaves, and the temperature of the stiff fuel did not converge; that is outside the small-strain range the mechanics is stated for and not what a pin does.
describe.skipIf(!solverOn)("the contact over gaps, stiffness ratios and penalty factors (needs FEED_SOLVER=1)", () => {
  const gaps = [4.11, 4.12, 4.14];
  /** The fuel's expansion coefficient for which free expansion overlaps the solids by `overlap` metres (bisection on the independent solution). */
  function alphaFor(Ef: number, rci: number, overlap: number): number {
    let lo = 1e-6;
    let hi = 2e-4;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const n = validateCase(mechanicsCase({ fuel: [Ef, 0.3, mid], cladding: [2e11, 0.3, 1e-5], rci, penalty: 0.5 })).normalized!;
      const free = independentSolution(n, effectiveMechanics(n)!, n.mechanics!).freeGap;
      if (free > -overlap) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  const pair = (Ef: number, rci: number, penalty: number) => mechanicsCase({ fuel: [Ef, 0.3, alphaFor(Ef, rci, 5e-6)], cladding: [2e11, 0.3, 1e-5], rci, penalty });
  for (const rci of gaps) {
    const um = ((rci - 4.1) * 1e3).toFixed(0);
    it(`gap ${um} micron, equal moduli at 0.3 and a stiffer fuel at 0.3: every check passes and the solids touch`, async () => {
      for (const Ef of [2e11, 4e11]) {
        const { res } = await run(pair(Ef, rci, 0.3));
        expect(allPass(res!), `E fuel ${Ef}`).toEqual([]);
        expect(res!.mechanics!.summary.contact).toBe(true);
        expect(res!.checks.find((c) => c.id === "mechanicsContact")!.note).toMatch(/interface pressure/);
      }
    }, 600_000);
    it(`gap ${um} micron, a fuel a quarter as stiff as the cladding at 0.7: the known limit (touches, pressure within 4 %)`, async () => {
      const d = pair(5e10, rci, 0.7);
      const n = validateCase(d).normalized!;
      const ref = independentSolution(n, effectiveMechanics(n)!, n.mechanics!).contactPressure;
      const { res } = await run(d);
      expect(res!.mechanics!.summary.contact).toBe(true);
      expect(Math.abs(res!.mechanics!.summary.contactPressure! / ref - 1)).toBeLessThan(0.04);
      expect(res!.checks.filter((c) => c.verdict !== "pass").map((c) => c.id).filter((id) => id !== "mechanicsContact" && id !== "mechanicsStress")).toEqual([]);
    }, 300_000);
  }
  it("a factor that is too small runs, and fails the contact check (equal moduli, 0.05: the pressure is 13 % low)", async () => {
    const d = pair(2e11, 4.12, 0.05);
    const { res } = await run(d);
    const c = res!.checks.find((x) => x.id === "mechanicsContact")!;
    expect(c.verdict).toBe("fail");
    expect(c.note).toMatch(/interface pressure/);
    expect(res!.mechanics!.summary.contact).toBe(true);
  }, 300_000);
  it("a factor that is too large for the pair never converges and the run fails (equal moduli at 0.7, a stiffer fuel at 0.5, a soft fuel at 1)", async () => {
    for (const [Ef, pen] of [[2e11, 0.7], [4e11, 0.5], [5e10, 1]] as const) {
      const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-mechrun-")), backend: new WslBackend(), timeoutMs: 280_000 });
      const s = mgr.start(pair(Ef, 4.12, pen));
      if (!s.ok) throw new Error("start refused");
      const rec = await mgr.done(s.id);
      expect(rec.state, `E fuel ${Ef} at ${pen}`).toBe("failed");
      expect(JSON.stringify(rec.failure)).toMatch(/E_NOT_CONVERGED/);
    }
  }, 900_000);
});
