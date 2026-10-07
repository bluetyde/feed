// M0 of docs/plans/09-mechanics.md: what the real OFFBEAT does when FEED's 1D pin case has its mechanics switched on (FEED_SOLVER=1). Not FEED's mechanics (that does
// not exist yet): FEED's own case, edited to turn mechanics on, run through solver/probe-mechanics.sh, against closed forms written here and sharing no code with
// FEED. Findings: docs/spike/mechanics-probe.md.
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { cells, fieldNames, patch, probeCase, ProbeOptions, ProbeRun, runProbe } from "./helpers/mechanicsProbe";

const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

const a = 4.1e-3; // fuel radius
const b = 4.12e-3; // cladding inner radius (a 20 micron gap)
const c = 4.75e-3; // cladding outer radius
const E = 2e11;
const nu = 0.3;
const Tref = 300;

const run = (o: ProbeOptions = {}): Promise<ProbeRun> => runProbe(probeCase(o), o.timeoutSeconds);
const T0 = (r: ProbeRun) => cells(r, "T")[0]![0]!;

/**
 * The contact pressure between a solid cylinder (radius a) and a tube (inner radius b, outer c) that grow freely by e1 and e2 and are pressed together after the gap
 * b - a closes, each solid free of axial force (so each has zero axial stress, as OFFBEAT's modified plane strain gives here). Lame for both.
 */
const contactPressure = (e1: number, e2: number) => {
  const num = a * e1 - b * e2 - (b - a);
  const den = (a * (1 - nu)) / E + (b * ((b * b + c * c) / (c * c - b * b) + nu)) / E;
  return num / den;
};

describe.skipIf(!solverOn)("OFFBEAT's mechanics on FEED's 1D pin case (needs FEED_SOLVER=1)", () => {
  it("free thermal expansion: every patch moves by alpha dT r, the gap stays open, no stress, and the temperature is what a thermal-only run gives", async () => {
    const on = await run({ fuel: { alpha: "1.2e-5" }, cladding: { alpha: "1e-5" } });
    expect(on.exit.offbeatExit === 0 || on.exit.offbeatExit === 139).toBe(true); // OFFBEAT's known shutdown crash after a complete run
    const dT = T0(on) - Tref;
    expect(dT).toBeGreaterThan(299.9);
    const near = (got: number, want: number) => expect(Math.abs(got - want) / want).toBeLessThan(2e-4);
    near(patch(on, "D", "fuelOuter")[0]!, 1.2e-5 * dT * a);
    near(patch(on, "D", "cladInner")[0]!, 1e-5 * dT * b);
    near(patch(on, "D", "cladOuter")[0]!, 1e-5 * dT * c);
    // the gap: b(1 + e2) - a(1 + e1), a little less than the 20 microns the cold gap is
    const gap = patch(on, "gapWidth", "fuelOuter")[0]!;
    expect(Math.abs(gap - (b * (1 + 1e-5 * dT) - a * (1 + 1.2e-5 * dT))) / gap).toBeLessThan(0.01);
    // no stress where nothing is held (the largest component is axial noise of about 50 kPa)
    const sigma = cells(on, "sigma");
    expect(Math.max(...sigma.flatMap((s) => s.map(Math.abs)))).toBeLessThan(1e5); // noise of a tenth of a megapascal, against the 100 MPa of the contact case below
    // the thermal solution is the same with the mechanics off
    const off = await run({ mechanics: false });
    const tOn = cells(on, "T").map((x) => x[0]!);
    const tOff = cells(off, "T").map((x) => x[0]!);
    expect(Math.max(...tOn.map((x, i) => Math.abs(x - tOff[i]!)))).toBeLessThan(1e-4); // the files hold 8 significant digits: 600.03678 against 600.03677 is one unit of the last digit
  }, 300_000);

  it("the fields written by a mechanics run, and the numbers its log prints for the displacement", async () => {
    const r = await run();
    const names = fieldNames(r);
    for (const f of ["D", "DCyl", "epsilon", "epsilonCyl", "epsEl", "epsTh", "sigma", "sigmaCyl", "sigmaDev", "sigmaHyd", "gapWidth", "interfaceP", "hGap", "T", "C"]) expect(names, f).toContain(f);
    expect(r.log).toMatch(/Solving for Dx, Initial residual/);
    expect(r.log).toMatch(/relResidualD is/);
    expect(r.log).toMatch(/absErrD is/);
    expect(r.log).toMatch(/Domain average displacement/);
    expect(cells(r, "D").length).toBe(26); // 20 fuel cells and 6 cladding cells
  }, 300_000);

  it("a pressurised thick tube (the cladding under external pressure, the gap open) agrees with Lame: displacement to 0.02 %, stress to 0.1 % in the hoop direction", async () => {
    const p = 15e6;
    const r = await run({ thermalExpansion: "off", outerPressure: p });
    // sigma_r(b) = 0 and sigma_r(c) = -p: A - B/b^2 = 0, A - B/c^2 = -p
    const A = (-p * c * c) / (c * c - b * b);
    const B = A * b * b;
    const sr = (x: number) => A - B / (x * x);
    const st = (x: number) => A + B / (x * x);
    const u = (x: number) => (x * (st(x) - nu * sr(x))) / E; // sigma_z = 0
    expect(Math.abs(patch(r, "D", "cladInner")[0]! / u(b) - 1)).toBeLessThan(2e-4);
    expect(Math.abs(patch(r, "D", "cladOuter")[0]! / u(c) - 1)).toBeLessThan(2e-4);
    const C = cells(r, "C").map((x) => x[0]!);
    const sigma = cells(r, "sigma"); // xx xy xz yy yz zz: radial, shear, shear, hoop, shear, axial
    for (const i of [20, 23, 25]) {
      expect(Math.abs(sigma[i]![3]! / st(C[i]!) - 1), `hoop stress, cladding cell ${i - 20}`).toBeLessThan(1e-3);
      expect(Math.abs(sigma[i]![0]! - sr(C[i]!)), `radial stress, cladding cell ${i - 20}`).toBeLessThan(0.3e6); // of 15 MPa
      expect(Math.abs(sigma[i]![5]!)).toBeLessThan(0.2e6); // axial: the force-free condition leaves only noise
    }
    expect(patch(r, "gapWidth", "fuelOuter")[0]!).toBeGreaterThan(15e-6); // the gap is still open
  }, 300_000);

  describe("the gap closes and the solids press on each other (a fuel that grows four times as fast as its cladding)", () => {
    const pressure = async (penalty: string, type = "gapContact") => {
      const r = await run({
        fuel: { alpha: "4e-5" },
        cladding: { alpha: "1e-5" },
        edit: { "0/D": (t) => t.replace(/penaltyFactor\s+[0-9.e+-]+;/g, `penaltyFactor   ${penalty};`).replace(/type\s+gapContact;/g, type === "gapContact" ? "type            gapContact;" : `type            ${type};\n        penaltyFactorFriction 0.1;`) },
      });
      const dT = T0(r) - Tref;
      return { r, dT, p: patch(r, "interfaceP", "fuelOuter")[0]!, exact: contactPressure(4e-5 * dT, 1e-5 * dT) };
    };

    it("contact works in the 1D wedge: the pressure is about 100 MPa (closed form 101.3), the fuel is in uniform hydrostatic compression and the cladding hoop stress is Lame's at that pressure", async () => {
      const { r, p, exact } = await pressure("0.3");
      expect(exact).toBeGreaterThan(1.0e8);
      expect(exact).toBeLessThan(1.03e8);
      expect(Math.abs(p / exact - 1)).toBeLessThan(0.03);
      const sigma = cells(r, "sigma");
      for (const i of [0, 10, 19]) {
        expect(Math.abs(sigma[i]![0]! / -p - 1)).toBeLessThan(0.01); // radial
        expect(Math.abs(sigma[i]![3]! / -p - 1)).toBeLessThan(0.01); // hoop
        expect(Math.abs(sigma[i]![5]!)).toBeLessThan(0.01 * p); // axial: free
      }
      const C = cells(r, "C").map((x) => x[0]!);
      const hoop = (x: number) => (p * b * b * (1 + (c * c) / (x * x))) / (c * c - b * b);
      expect(Math.abs(sigma[20]![3]! / hoop(C[20]!) - 1)).toBeLessThan(0.02);
      // the fuel's axial strain is what its own expansion and its Poisson response give, not the cladding's
      expect(cells(r, "epsilon")[0]![5]!).toBeGreaterThan(0.0122);
      expect(cells(r, "epsilon")[20]![5]!).toBeLessThan(0.0025);
    }, 300_000);

    it("the answer depends on the contact penalty factor, and not monotonically near the writer's default: the error against the closed form", async () => {
      const err: Record<string, number> = {};
      for (const pen of ["0.05", "0.1", "0.3", "0.5"]) {
        const { p, exact } = await pressure(pen);
        err[pen] = p / exact - 1;
      }
      expect(err["0.05"]!).toBeLessThan(-0.1); // too soft: 13 % low
      expect(err["0.1"]!).toBeLessThan(-0.03); // the writer's default penaltyFactor: about 7 % low
      expect(err["0.1"]!).toBeGreaterThan(-0.1);
      expect(Math.abs(err["0.3"]!)).toBeLessThan(0.03);
      expect(Math.abs(err["0.5"]!)).toBeLessThan(0.02);
      expect(err["0.05"]!).toBeLessThan(err["0.1"]!); // the pressure rises with the penalty over this range
      expect(err["0.1"]!).toBeLessThan(err["0.3"]!);
    }, 600_000);

    it("a penalty factor of 10 does not converge to the answer (the pressure is an order of magnitude too high), and nothing in the run says so by itself", async () => {
      const { r, p, exact } = await pressure("10");
      expect(r.exit.offbeatExit === 0 || r.exit.offbeatExit === 139).toBe(true);
      expect(p / exact).toBeGreaterThan(5);
      expect(r.log).not.toMatch(/FOAM FATAL/);
    }, 300_000);

    it("the implicit contact condition gives the same pressure as the explicit one at the same penalty (it needs one more keyword, penaltyFactorFriction)", async () => {
      const explicit = await pressure("0.1");
      const implicit = await pressure("0.1", "implicitGapContact");
      expect(Math.abs(implicit.p / explicit.p - 1)).toBeLessThan(0.02);
    }, 300_000);
  });

  describe("a mechanical property that is missing or misspelled in a constant material stops the run (unlike the thermal properties, which take a silent default)", () => {
    const dropFrom = (name: string, re: RegExp) => (t: string) => t.replace(new RegExp(`(    ${name}\\n    \\{[\\s\\S]*?\\n    \\})`), (blk) => blk.replace(re, ""));
    for (const [what, re] of [
      ["E", /\n        E           E     \[1 -1 -2 0 0\]  [^;]+;/],
      ["nu", /\n        nu          nu    \[0 0 0 0 0\]    [^;]+;/],
      ["alpha", /\n        alpha       alpha \[0 0 0 0 0\]    [^;]+;/],
    ] as const) {
      it(`without ${what}`, async () => {
        const r = await run({ editDict: dropFrom("cladding", re) });
        expect(r.final).toBeUndefined();
        expect(r.exit.offbeatExit).toBe(1);
        expect(r.log).toMatch(new RegExp(`keyword ${what} is undefined in dictionary .*materials/cladding`));
      }, 300_000);
    }
    it("a misspelled alpha is the same as a missing one", async () => {
      const r = await run({ editDict: (t) => t.replace(/(cladding\n    \{[\s\S]*?)alpha       alpha/, "$1alfa        alpha") });
      expect(r.exit.offbeatExit).toBe(1);
      expect(r.log).toMatch(/keyword alpha is undefined/);
    }, 300_000);
  });
});
