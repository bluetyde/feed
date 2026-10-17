// Plan 16 (the interface probe), ungated: why OFFBEAT's cells sit away from FEED's finite-volume solution on a coarse particle mesh, and what the cross-check allows for it.
//
// The mechanism (docs/spike/triso-interface-probe.md): OFFBEAT puts the conductivity at a cell face by linear interpolation of the two cells' values and the conductance as
// k_face x face area / distance between the cell centres. FEED's finite volumes put two half cells of the exact spherical shells in series. Inside a region the two agree to the second
// order; across a jump in conductivity (kernel to buffer, inner carbon to silicon carbide, silicon carbide to outer carbon) they differ by a term proportional to the cell width. The
// buffer-to-carbon gap is a coupled patch with the two half cells and the gap's conductance in series, so it is not such an interface.
//
// Tolerances, fixed here before the first run, with their reasons:
//   - SAFETY 1.25 on the estimate (the sum of the heat times the resistance difference at the three interfaces), added to the check's own 0.3 % of the rise: over the 30 real runs of
//     the probe (5 sampled particles x 6 meshes of 6 to 192 cells per region) the measured largest deviation was 0.98 to 1.07 times the estimate, over T3's 7 saved runs up to 1.22
//     (a thin particle where the second-order interior term is a larger part). The safety asked of the whole bound: the measured deviation at most 0.75 of it (a factor 1.33) on every
//     saved run; the probe measured at most 0.72.
//   - the band for measured / estimate on the saved runs: 0.97 to 1.09 (the 30 runs spread over 0.983 to 1.071; the band is the spread widened by about 1 % on either side).
//   - the negative controls move the answer by far more than the bound: a power 5 % high (0.8 K of the 16 K rise, the bound is 0.29 K) and the buffer's and the inner carbon's
//     conductivities swapped (several K).
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildTrisoResults, TRISO_FV_FLOOR, TRISO_FV_RISE_FRACTION, TRISO_INTERFACE_SAFETY, trisoInterfaceAllowance } from "../src/core/trisoResults";
import { trisoClosedForm } from "../src/core/trisoSolve";
import { wedgeEquivalent } from "../src/core/trisoWriter";

const SAFETY = 1.25;
const BAND: [number, number] = [0.97, 1.09];
const root = join(__dirname, "..");
const g = (name: string) => {
  const d = join(root, "tests", "golden", "offbeat-triso-mesh", name);
  const f = (x: string) => readFileSync(join(d, x), "utf8");
  return { n: JSON.parse(f("normalized.json")), T: f("T"), C: f("C"), cellZones: f("cellZones"), rate: JSON.parse(f("rate.json")) as { relativeRate: number; time: number } };
};
type G = ReturnType<typeof g>;
const read = (x: G, mutate?: (n: any) => void) => {
  const n = JSON.parse(JSON.stringify(x.n));
  mutate?.(n);
  return buildTrisoResults(n, { T: x.T, C: x.C, cellZones: x.cellZones, time: x.rate.time, drift: { relativeRate: x.rate.relativeRate } });
};
const failed = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const fv = (r: { checks: { id: string; value: number | null; note: string; verdict: string }[] }) => r.checks.find((c) => c.id === "crossCheckFv")!;
const ROLES = ["coldest", "hottest", "median", "thickest-buffer", "thinnest-sic"];
/** The check's own bound before the allowance: 0.3 % of the particle's internal rise, at least 0.02 K. */
const baseBound = (n: any) => {
  const closed = trisoClosedForm(wedgeEquivalent(n));
  return Math.max(0.003 * (closed.centreT - closed.wallT), 0.02);
};

describe("the interface allowance of a particle", () => {
  it("is a documented constant, and the constants of the unchanged part of the bound are what they were", () => {
    expect(TRISO_INTERFACE_SAFETY).toBe(SAFETY);
    expect(TRISO_FV_RISE_FRACTION).toBe(0.003);
    expect(TRISO_FV_FLOOR).toBe(0.02);
  });

  it("counts the three interfaces of a five-region particle and not the gap; a two-layer particle has one", () => {
    const five = trisoInterfaceAllowance(wedgeEquivalent(g("median-12").n));
    expect(five.interfaces.map((i) => i.between)).toEqual(["kernel/buffer", "ipyc/sic", "sic/opyc"]);
    expect(five.total).toBeCloseTo(five.interfaces.reduce((s, i) => s + Math.abs(i.shift), 0), 12);
    const n = JSON.parse(JSON.stringify(g("median-12").n));
    n.layers = n.layers.slice(0, 2);
    n.cells = n.cells.slice(0, 3);
    n.outerRadius = n.layers[1].outerRadius;
    expect(trisoInterfaceAllowance(wedgeEquivalent(n)).interfaces.map((i) => i.between)).toEqual(["kernel/buffer"]);
  });

  it("is zero when the two sides of an interface have one conductivity (the two schemes then agree)", () => {
    const n = JSON.parse(JSON.stringify(g("median-12").n));
    for (const l of n.layers) l.conductivity = { ...n.kernelConductivity };
    expect(trisoInterfaceAllowance(wedgeEquivalent(n)).total).toBeLessThan(1e-9);
  });

  it("matches the hand arithmetic at the kernel-to-buffer face: P x |(k1 - k2)(d1^2/k1 - d2^2/k2) / (k1 k2 (d1/k1 + d2/k2) A)|, with the distances from the cell centroids to the face", () => {
    const eq = wedgeEquivalent(g("thickest-buffer-12").n);
    const P = eq.power.particlePower;
    const Rk = eq.kernelRadius;
    const Rb = eq.layers[0]!.outerRadius;
    const nk = eq.cells[0]!;
    const nb = eq.cells[1]!;
    const centroid = (a: number, b: number) => (0.75 * (b ** 4 - a ** 4)) / (b ** 3 - a ** 3);
    const d1 = Rk - centroid(Rk - Rk / nk, Rk);
    const d2 = centroid(Rk, Rk + (Rb - Rk) / nb) - Rk;
    const k1 = 3;
    const k2 = 0.5;
    const A = 4 * Math.PI * Rk * Rk;
    const hand = Math.abs(P * (((k1 - k2) * (d1 * d1 / k1 - d2 * d2 / k2)) / (k1 * k2 * (d1 / k1 + d2 / k2) * A)));
    const got = trisoInterfaceAllowance(eq).interfaces[0]!;
    expect(got.between).toBe("kernel/buffer");
    expect(Math.abs(got.shift)).toBeCloseTo(hand, 9);
    // the hand value for this particle: about 0.18 K on 12 cells
    expect(hand).toBeGreaterThan(0.17);
    expect(hand).toBeLessThan(0.19);
  });

  it("falls with the cell width, as the first power plus a curvature part that shrinks (the expectation of a pure first power, 2 within 3 %, was wrong on the first run: 2.18 from 12 to 24 cells)", () => {
    const at = (name: string) => trisoInterfaceAllowance(wedgeEquivalent(g(name).n)).total;
    // the estimate of the thickest-buffer particle: 6 -> 12 -> 24 -> 96 cells per region
    const r612 = at("thickest-buffer-6") / at("thickest-buffer-12");
    const r1224 = at("thickest-buffer-12") / at("thickest-buffer-24");
    const r2496 = at("thickest-buffer-24") / at("thickest-buffer-96");
    expect(r1224).toBeGreaterThan(2.0);
    expect(r1224).toBeLessThan(2.3);
    expect(r612).toBeGreaterThan(2.0);
    expect(r612).toBeLessThan(2.4);
    // four times the cells: a little above four, the part above shrinking toward the first power
    expect(r2496).toBeGreaterThan(4.0);
    expect(r2496).toBeLessThan(4.6);
  });

  it("moves the cells inside an interface and not the cells outside it: the kernel gets all three, the buffer the two outer ones, the outermost region none", () => {
    const a = trisoInterfaceAllowance(wedgeEquivalent(g("median-12").n));
    const s = a.interfaces.map((i) => Math.abs(i.shift));
    expect(a.forRegion).toHaveLength(5);
    expect(a.forRegion[0]).toBeCloseTo(s[0]! + s[1]! + s[2]!, 12);
    expect(a.forRegion[1]).toBeCloseTo(s[1]! + s[2]!, 12);
    expect(a.forRegion[2]).toBeCloseTo(s[1]! + s[2]!, 12);
    expect(a.forRegion[3]).toBeCloseTo(s[2]!, 12);
    expect(a.forRegion[4]).toBe(0);
  });
});

describe("the allowance in detail (found by the mutation run: three changes of it had survived)", () => {
  it("takes the conductivity of a temperature-dependent material at the temperature of the interface: the kernel's at its surface and the buffer's at its inner face", () => {
    const n = JSON.parse(JSON.stringify(g("median-12").n));
    // k = a + b T: the kernel's falls with temperature, the buffer's rises, so that the value at the centre or at the buffer's outer face is a visibly different number
    n.kernelConductivity = { kind: "linear", a: 6, b: -0.003, referenceTemperature: 1000 };
    n.layers[0].conductivity = { kind: "linear", a: 0.2, b: 0.0004, referenceTemperature: 1000 };
    const eq = wedgeEquivalent(n);
    const closed = trisoClosedForm(eq);
    const T = closed.regions[0]!.outerT;
    expect(closed.regions[1]!.innerT).toBeCloseTo(T, 9);
    // the centre and the buffer's outer face are not at that temperature (so a conductivity read there would be another number)
    expect(Math.abs(closed.regions[0]!.innerT - T)).toBeGreaterThan(3);
    expect(Math.abs(closed.regions[1]!.outerT - T)).toBeGreaterThan(3);
    const k1 = 6 - 0.003 * T;
    const k2 = 0.2 + 0.0004 * T;
    const P = eq.power.particlePower;
    const Rk = eq.kernelRadius;
    const centroid = (a: number, b: number) => (0.75 * (b ** 4 - a ** 4)) / (b ** 3 - a ** 3);
    const d1 = Rk - centroid(Rk - Rk / eq.cells[0]!, Rk);
    const d2 = centroid(Rk, Rk + (eq.layers[0]!.outerRadius - Rk) / eq.cells[1]!) - Rk;
    const hand = Math.abs(P * (((k1 - k2) * (d1 * d1 / k1 - d2 * d2 / k2)) / (k1 * k2 * (d1 / k1 + d2 / k2) * 4 * Math.PI * Rk * Rk)));
    expect(Math.abs(trisoInterfaceAllowance(eq).interfaces[0]!.shift)).toBeCloseTo(hand, 9);
  });

  it("each region's closed-form bound carries the allowance of the interfaces outside it, and the outermost region none (the notes say how much)", () => {
    const x = g("median-12");
    const r = read(x);
    const a = trisoInterfaceAllowance(wedgeEquivalent(x.n));
    ["closedFormKernel", "closedFormBuffer", "closedFormIpyc", "closedFormSic", "closedFormOpyc"].forEach((id, ri) => {
      const note = r.checks.find((c) => c.id === id)!.note;
      if (a.forRegion[ri]! > 0) expect(note, id).toContain((SAFETY * a.forRegion[ri]!).toPrecision(3) + " K interface allowance");
      else expect(note, id).not.toMatch(/interface allowance/);
    });
    // the kernel's is the largest, the buffer's and the inner carbon's are equal (the gap is not an interface), the outermost has none
    expect(a.forRegion[0]!).toBeGreaterThan(a.forRegion[1]!);
    expect(a.forRegion[1]!).toBeCloseTo(a.forRegion[2]!, 15);
    expect(a.forRegion[4]!).toBe(0);
  });

  it("keeps the floor of 0.02 K under the 0.3 % of a small rise: a particle whose rise is 3 K has a bound of 0.02 K plus the allowance", () => {
    const x = g("median-12");
    const mutate = (n: any) => {
      n.power.particlePower *= 0.2;
      n.power.kernelPowerDensity *= 0.2;
    };
    const r = read(x, mutate);
    const n = JSON.parse(JSON.stringify(x.n));
    mutate(n);
    const closed = trisoClosedForm(wedgeEquivalent(n));
    expect(0.003 * (closed.centreT - closed.wallT)).toBeLessThan(0.02);
    const want = 0.02 + SAFETY * trisoInterfaceAllowance(wedgeEquivalent(n)).total;
    expect(Number(/bound ([0-9.]+) K/.exec(fv(r).note)![1])).toBeCloseTo(want, 3);
  });
});

describe("real OFFBEAT output on coarse meshes (tests/golden/offbeat-triso-mesh)", () => {
  for (const role of ROLES) {
    it(role + " on 12 cells per region: every check passes now; without the allowance the cross-check would fail, and the estimate predicts the deviation", () => {
      const x = g(role + "-12");
      const r = read(x);
      expect(failed(r)).toEqual([]);
      const c = fv(r);
      const base = baseBound(x.n);
      const est = trisoInterfaceAllowance(wedgeEquivalent(x.n)).total;
      // the deviation is above the old bound (four of the five: all but the coldest were failing; the coldest passed it by 1 %), and the allowance is what widens it
      expect(c.value!).toBeGreaterThan(0.95 * base);
      expect(c.value! / est).toBeGreaterThan(BAND[0]);
      expect(c.value! / est).toBeLessThan(BAND[1]);
      expect(c.value!).toBeLessThan(base + SAFETY * est);
      expect(c.note).toMatch(/interface allowance/);
      expect(c.note).toContain((base + SAFETY * est).toPrecision(3));
    });
  }

  it("four of the five were failing the cross-check before the allowance (the bound without it), and the thickest-buffer particle's kernel also failed the closed form", () => {
    const failing = ROLES.filter((role) => {
      const x = g(role + "-12");
      return fv(read(x)).value! > baseBound(x.n);
    });
    expect(failing).toEqual(["hottest", "median", "thickest-buffer", "thinnest-sic"]);
    // the kernel against the closed form: the bound it had was 5 x drop / N^2 + the larger of 0.5 % of the rise and 0.01 K
    const x = g("thickest-buffer-12");
    const closed = trisoClosedForm(wedgeEquivalent(x.n));
    const kernel = closed.regions[0]!;
    const old = (5 * Math.abs(kernel.innerT - kernel.outerT)) / x.n.cells[0] ** 2 + Math.max(0.005 * (closed.centreT - closed.wallT), 0.01);
    const c = read(x).checks.find((k) => k.id === "closedFormKernel")!;
    expect(c.value!).toBeGreaterThan(old);
    expect(c.verdict).toBe("pass");
    expect(c.note).toMatch(/interface allowance/);
  });

  for (const name of ["thickest-buffer-6", "thickest-buffer-24", "thickest-buffer-96"]) {
    it(name + ": passes, and the estimate predicts the deviation on 6, 24 and 96 cells too", () => {
      const x = g(name);
      const r = read(x);
      expect(failed(r)).toEqual([]);
      const est = trisoInterfaceAllowance(wedgeEquivalent(x.n)).total;
      expect(fv(r).value! / est).toBeGreaterThan(BAND[0]);
      expect(fv(r).value! / est).toBeLessThan(BAND[1]);
    });
  }
});

describe("the safety factor on every saved run of a particle", () => {
  const dirs: [string, string][] = [];
  for (const base of ["offbeat-triso", "offbeat-triso-pop", "offbeat-triso-mesh"]) for (const d of readdirSync(join(root, "tests", "golden", base))) if (existsSync(join(root, "tests", "golden", base, d, "normalized.json"))) dirs.push([base, d]);
  it("finds the 7 + 5 + 8 saved particles", () => {
    expect(dirs).toHaveLength(20);
  });
  for (const [base, d] of dirs) {
    it(base + "/" + d + ": the largest deviation from the finite volumes is at most 0.75 of its bound, and at most 1.25 times the estimate", () => {
      const dir = join(root, "tests", "golden", base, d);
      const f = (x: string) => readFileSync(join(dir, x), "utf8");
      const n = JSON.parse(f("normalized.json"));
      const rate = JSON.parse(f("rate.json"));
      const r = buildTrisoResults(n, { T: f("T"), C: f("C"), cellZones: f("cellZones"), time: rate.time, drift: { relativeRate: rate.relativeRate } });
      const c = fv(r);
      const bound = Number(/bound ([0-9.]+) K/.exec(c.note)![1]);
      expect(c.verdict).toBe("pass");
      expect(c.value! / bound).toBeLessThan(0.75);
      expect(c.value! / trisoInterfaceAllowance(wedgeEquivalent(n)).total).toBeLessThan(1.25);
    });
  }
});

describe("the allowance does not hide a wrong case", () => {
  it("a power 5 % high fails the cross-check (and the energy balance) on the 12-cell thickest-buffer output", () => {
    const x = g("thickest-buffer-12");
    const r = read(x, (n) => {
      n.power.particlePower *= 1.05;
      n.power.kernelPowerDensity *= 1.05;
    });
    expect(failed(r)).toContain("crossCheckFv");
    expect(failed(r)).toContain("energyBalance");
    // the shift is the rise's 5 %, far above the bound
    expect(fv(r).value!).toBeGreaterThan(3 * (baseBound(x.n) + SAFETY * trisoInterfaceAllowance(wedgeEquivalent(x.n)).total));
  });

  it("the buffer's and the inner carbon's conductivities swapped fail the cross-check", () => {
    const r = read(g("median-12"), (n) => {
      const a = n.layers[0].conductivity;
      n.layers[0].conductivity = n.layers[1].conductivity;
      n.layers[1].conductivity = a;
    });
    expect(failed(r)).toContain("crossCheckFv");
  });

  it("the output of one particle read as another's case (the coldest's cells under the hottest's power) fails the cross-check", () => {
    const hot = g("hottest-12").n;
    const x = g("coldest-12");
    const r = read(x, (n) => {
      n.power = hot.power;
    });
    expect(failed(r)).toContain("crossCheckFv");
  });
});
