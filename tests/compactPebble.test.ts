// Plan 13 T4, ungated: a compact (a pin whose fuel is the homogenised mix of coated particles in a matrix) and a pebble (a sphere of such a fuelled zone and a shell), and the two-scale
// step back to the hottest particle. Arithmetic is written out here with constant conductivities (so every number can be reproduced by hand), the real OFFBEAT output saved in
// tests/golden/offbeat-compact, offbeat-pebble and offbeat-two-scale (made by tests/compactPebbleSolver.test.ts with FEED_SOLVER=1 and FEED_SAVE_GOLDEN=1) is judged by the code
// the run manager uses, and the checks are shown to bite.
//
// Tolerances fixed before the first run: hand arithmetic 1e-9 relative (1e-6 where a gap of 1e12 W/m2/K stands for no gap); the polynomial the table is carried by within the case's
// own stated 0.5 %; the real run's particle against the two-scale closed form 0.05 K (the wedge's radii are 0.03 % smaller: its rise of 9 K moves by about 0.006 K).
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildCompactRecord, effectiveConductivity, MIXTURE_DOMAIN, mixtureDomainMessage, mixtureTable, particleEquivalentK, twoScaleParticle } from "../src/core/compact";
import { quickLook } from "../src/core/quickLook";
import { lawOf } from "../src/core/conductivity";
import { SPHERE } from "../src/core/geometry";
import { maxwellEucken } from "../src/core/mixture";
import { pebbleBlockMeshDict, writePebbleCase } from "../src/core/pebbleWriter";
import { pebbleClosedForm, pebbleInterfaceBias, pebbleModel, pebbleSteadyEndTime, pebbleTimeScale, pebbleWedgeEquivalent } from "../src/core/pebble";
import { buildPebbleResults } from "../src/core/pebbleResults";
import { buildResults } from "../src/core/resultsParser";
import { steadyTrisoFv } from "../src/core/trisoSolve";
import { TRISO_WEDGE_SCALE } from "../src/core/trisoWedge";
import { validateCase } from "../src/core/validate";
import { writeOffbeatCase } from "../src/core/caseWriter";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const example = (id: string) => JSON.parse(read("examples", id + ".json"));
const qv = (value: number, unit: string) => ({ value, unit });
interface Check { id: string; verdict: string; value: number | null; note: string }
const notPassing = (r: { checks: Check[] }) => r.checks.filter((c) => c.verdict !== "pass" && c.verdict !== "na").map((c) => c.id + " " + c.verdict);
const ids = (r: { checks: Check[] }) => r.checks.map((c) => c.id);

/** The coated sphere of two regions by Hashin's formula, written out (k1 core to the fraction c of the radius, k2 outside). */
const hashin = (k1: number, k2: number, c: number) => (k2 * (k1 + 2 * k2 + 2 * c * (k1 - k2))) / (k1 + 2 * k2 - c * (k1 - k2));
/** The generic particle's equivalent conductivity with constant layers (3, 0.5, 4, 13.9, 4 W/m/K at 250, 350, 390, 425, 460 um) and no gap, by hand. */
const byHandParticle = () => {
  const kA = hashin(3, 0.5, (250 / 350) ** 3);
  const kB = hashin(kA, 4, (350 / 390) ** 3);
  const kC = hashin(kB, 13.9, (390 / 425) ** 3);
  return hashin(kC, 4, (425 / 460) ** 3);
};
/** The compact example with a constant matrix of 20 W/m/K and a gap that is no gap, so that the effective conductivity does not depend on the temperature. */
const constantCompact = () => {
  const d = example("synthetic-compact-steady");
  d.compact.matrix.sets["thermal.conductivity"] = { model: "constant", value: qv(20, "W/m/K"), referenceTemperature: qv(900, "K"), source: "synthetic: constant, for the hand arithmetic" };
  d.compact.particle.gap.conductance = qv(1e12, "W/m2/K");
  return d;
};
const constantPebble = () => {
  const d = example("synthetic-pebble-steady");
  d.compact.matrix.sets["thermal.conductivity"] = { model: "constant", value: qv(20, "W/m/K"), referenceTemperature: qv(900, "K"), source: "synthetic: constant, for the hand arithmetic" };
  d.compact.particle.gap.conductance = qv(1e12, "W/m2/K");
  return d;
};

describe("a compact: the case, by hand", () => {
  const v = validateCase(example("synthetic-compact-steady"));
  const n = v.normalized!;

  it("the example is valid with no warning, and it is a pin whose fuel and power come from the compact block", () => {
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(n.compact).toBeDefined();
    expect(n.fuelConductivity.kind).toBe("polynomial");
  });

  it("the linear heat rate is the power density times the cross-section: 30 W/cm3 = 3e7 W/m3, times pi x (6 mm)^2", () => {
    expect(n.qPrime).toBeCloseTo(3e7 * Math.PI * 0.006 ** 2, 9);
    expect(n.qPrime).toBeCloseTo(3392.92, 2);
  });

  it("a central hole takes its area out: the same power density, times pi (R^2 - Ri^2)", () => {
    const d = example("synthetic-compact-steady");
    d.geometry.fuelInnerRadius = qv(1.5, "mm");
    const h = validateCase(d);
    expect(h.errors).toEqual([]);
    expect(h.normalized!.qPrime).toBeCloseTo(3e7 * Math.PI * (0.006 ** 2 - 0.0015 ** 2), 9);
  });

  it("the power of a particle is the power density times the particle's volume over the packing fraction, and the particles hold the packing fraction of the volume", () => {
    const Vp = (4 / 3) * Math.PI * (460e-6) ** 3;
    const c = n.compact!;
    expect(c.particlePower).toBeCloseTo((3e7 * Vp) / 0.35, 12);
    expect(c.particlePower).toBeCloseTo(0.0349474, 6);
    expect(c.particlesPerM3 * Vp).toBeCloseTo(0.35, 12); // a cubic metre holds this many particles, filling 35 % of it
    expect(c.particlesPerM3 * c.particlePower).toBeCloseTo(3e7, 3); // and they make the compact's power
    // the packing fraction applied to the wrong volume (the kernel's) would give a power 6.2 times too small... and is not what is used
    const wrong = (3e7 * (4 / 3) * Math.PI * (250e-6) ** 3) / 0.35;
    expect(c.particlePower / wrong).toBeCloseTo((460 / 250) ** 3, 9);
  });

  it("with constant layers and no gap the table is one number: Hashin's coated sphere four times, then Maxwell-Eucken at 0.35, and the polynomial carries it", () => {
    const d = validateCase(constantCompact());
    expect(d.errors).toEqual([]);
    const kp = byHandParticle();
    const keff = maxwellEucken(kp, 20, 0.35);
    expect(particleEquivalentK(d.normalized!.compact!.particle, 900)).toBeCloseTo(kp, 6);
    expect(effectiveConductivity(d.normalized!.compact!, 900)).toBeCloseTo(keff, 6);
    const co = (d.normalized!.fuelConductivity as { coefficients: number[] }).coefficients;
    expect(co[0]).toBeCloseTo(keff, 6);
    expect(Math.abs(co[1] ?? 0)).toBeLessThan(1e-9);
    // the compact's own rise from the axis to the surface of the fuel: q' / (4 pi k)
    const q = quickLook(d.normalized!).temperatures;
    expect(q.fuelDeltaT).toBeCloseTo(d.normalized!.qPrime / (4 * Math.PI * keff), 7);
  });

  it("the gap inside the particle lowers the effective conductivity, by an amount that is not negligible at 1.5e5 W/m2/K", () => {
    const noGap = effectiveConductivity(validateCase(constantCompact()).normalized!.compact!, 900);
    const withGap = (() => {
      const d = constantCompact();
      d.compact.particle.gap.conductance = qv(1.5e5, "W/m2/K");
      return effectiveConductivity(validateCase(d).normalized!.compact!, 900);
    })();
    expect(withGap).toBeLessThan(noGap);
    expect(noGap / withGap - 1).toBeGreaterThan(1e-4); // 0.04 %: the gap is thin against the buffer
    // a poorer gap (1e4) matters 15 times more
    const poor = (() => {
      const d = constantCompact();
      d.compact.particle.gap.conductance = qv(1e4, "W/m2/K");
      return effectiveConductivity(validateCase(d).normalized!.compact!, 900);
    })();
    expect(noGap / poor - 1).toBeGreaterThan(5 * (noGap / withGap - 1));
  });

  it("the table follows the law named: Bruggeman's gives another conductivity (and a warning), so a swapped law is seen", () => {
    const d = example("synthetic-compact-steady");
    d.compact.mixtureLaw = "bruggeman";
    const b = validateCase(d);
    expect(b.warnings.map((w) => w.code)).toEqual(["W_MIXTURE_LAW"]);
    const kb = effectiveConductivity(b.normalized!.compact!, 900);
    const km = effectiveConductivity(n.compact!, 900);
    expect(Math.abs(kb / km - 1)).toBeGreaterThan(0.02);
  });

  it("the polynomial the pin runs is the table within the stated 0.5 %, at every temperature of the range", () => {
    const co = (n.fuelConductivity as { coefficients: number[]; fit: { maxRelativeDeviation: number; tolerance: number } }).coefficients;
    for (const row of mixtureTable(n.compact!, 17)) {
      const poly = co[0]! + co[1]! * row.T + co[2]! * row.T ** 2 + co[3]! * row.T ** 3;
      expect(Math.abs(poly / row.k - 1)).toBeLessThan(0.005);
    }
    const fit = (n.fuelConductivity as { fit: { maxRelativeDeviation: number; tolerance: number } }).fit;
    expect(fit.maxRelativeDeviation).toBeLessThanOrEqual(fit.tolerance);
  });

  it("warns outside the domain the law was measured over, at the edges given: 0.4 is inside, above it is not; a ratio above 3 allows only 0.2; below 0.05 or above 100 is outside", () => {
    const at = (phi: number, lo: number, hi: number) => mixtureDomainMessage({ packingFraction: phi, contrast: [lo, hi], law: "maxwell-eucken" });
    expect(MIXTURE_DOMAIN).toMatchObject({ packingMax: 0.4, packingMaxHighContrast: 0.2, contrastMin: 0.05, contrastMax: 3, contrastCap: 100 });
    expect(at(0.4, 0.05, 3)).toBeUndefined();
    expect(at(0.41, 0.05, 3)).toMatch(/packing fraction 0.41 is above 0.4/);
    expect(at(0.2, 0.1, 50)).toBeUndefined();
    expect(at(0.25, 0.1, 50)).toMatch(/above 3\) at a packing fraction above 0.2/);
    expect(at(0.3, 0.049, 1)).toMatch(/only 0.049 of the matrix/);
    expect(at(0.1, 1, 101)).toMatch(/measured up to 100/);
  });

  it("warns at the packing fraction 0.5 (W_MIXTURE_RANGE only) and refuses what no arrangement can hold", () => {
    const d = example("synthetic-compact-steady");
    d.compact.packingFraction = qv(0.5, "1");
    expect(validateCase(d).warnings.map((w) => w.code)).toEqual(["W_MIXTURE_RANGE"]);
    d.compact.packingFraction = qv(0.8, "1");
    expect(validateCase(d).errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
  });

  it("is written for the real solver as the pin it is, with the fitted cubic as ZyRELAP and nothing from the compact block left unexplained", () => {
    const w = writeOffbeatCase(n);
    expect(w.files["constant/solverDict"]).toMatch(/conductivityModel ZyRELAP/);
    expect(w.mapping.find((m) => m.field === "materials.fuel thermal.conductivity")!.note).toMatch(/fitted to a table of 41 points/);
    for (const f of Object.values(w.files)) expect(f).not.toMatch(/\r/);
  });
});

describe("the hottest particle of a compact (two scales), by hand", () => {
  it("with constant properties the kernel's centre is the matrix temperature plus the sum of the resistances times the heat, written out", () => {
    const d = validateCase(constantCompact());
    const spec = d.normalized!.compact!;
    const Tm = 900;
    const P = spec.particlePower;
    const rp = 460e-6;
    const b = rp / Math.cbrt(0.35); // the sphere that holds one particle's share of the compact
    const R = (a: number, c: number, k: number) => (1 / a - 1 / c) / (4 * Math.PI * k);
    const shell = R(rp, b, 20);
    const layers = R(425e-6, 460e-6, 4) + R(390e-6, 425e-6, 13.9) + R(350e-6, 390e-6, 4);
    const gap = 1 / (4 * Math.PI * (350e-6) ** 2 * 1e12);
    const buffer = R(250e-6, 350e-6, 0.5);
    const kernel = P / (8 * Math.PI * 3 * 250e-6); // q''' R^2 / (6 k) with q''' = P / (4/3 pi R^3)
    const t = twoScaleParticle(spec, Tm);
    expect(t.shellDeltaT).toBeCloseTo(P * shell, 12);
    expect(t.matrixConductivity).toBe(20);
    expect(t.kernelSurfaceT).toBeCloseTo(Tm + P * (shell + layers + gap + buffer), 9);
    expect(t.kernelCentreT).toBeCloseTo(Tm + P * (shell + layers + gap + buffer) + kernel, 9);
    // the shell is a film at the particle's outer surface: its coefficient is 1 / (R_shell x area)
    expect(t.filmCoefficient).toBeCloseTo(1 / (shell * 4 * Math.PI * rp * rp), 6);
  });

  it("the matrix shell is thinner the denser the packing, and a particle that fills its cell has none: the drop falls as the packing rises", () => {
    const base = validateCase(example("synthetic-compact-steady")).normalized!.compact!;
    const drop = (phi: number) => twoScaleParticle({ ...base, packingFraction: phi }, 900).shellDeltaT;
    expect(drop(0.1)).toBeGreaterThan(drop(0.35));
    expect(drop(0.35)).toBeGreaterThan(drop(0.6));
  });
});

describe("the compact through the real solver (saved output)", () => {
  const d = (...p: string[]) => read("tests", "golden", "offbeat-compact", ...p);
  const n = JSON.parse(d("normalized.json"));
  const rate = JSON.parse(d("rate.json")) as { relativeRate: number; time: number };
  const judge = (mutate?: (x: any) => void) => {
    const c = JSON.parse(JSON.stringify(n));
    mutate?.(c);
    return buildResults(c, { T: d("T"), C: d("C"), time: rate.time, drift: { relativeRate: rate.relativeRate } });
  };

  it("the saved case is the example file as it is now (an edited example must be re-run)", () => {
    expect(JSON.parse(JSON.stringify(validateCase(example("synthetic-compact-steady")).normalized))).toEqual(n);
  });

  it("every check passes, and the verdicts are the ones the solver run saved", () => {
    const r = judge();
    expect(notPassing(r)).toEqual([]);
    expect(ids(r)).toEqual(expect.arrayContaining(["energyBalance", "closedFormFuel", "closedFormCladding", "wallTemperature", "conductivityFitFuel", "twoScaleMatrix0", "twoScaleMatrix1", "mixtureDomain", "steadyState"]));
    const saved = JSON.parse(d("results.json")) as { checks: Check[] };
    expect(r.checks.map((c) => [c.id, c.verdict])).toEqual(saved.checks.map((c) => [c.id, c.verdict]));
  });

  it("the compact's hottest cell is 905.86 K, the closed form says 905.87 K, and the hottest kernel is 9 K hotter than that: the particle's rise over the matrix", () => {
    const r = judge();
    const hot = r.compact!.twoScale.find((e) => e.at === "hottest")!;
    expect(hot.matrixT).toBeCloseTo(905.86, 1);
    expect(hot.matrixTIndependent).toBeCloseTo(905.872, 2);
    expect(hot.particle.kernelCentreT - hot.matrixT).toBeGreaterThan(8);
    expect(hot.particle.kernelCentreT - hot.matrixT).toBeLessThan(10);
    const mean = r.compact!.twoScale.find((e) => e.at === "mean")!;
    expect(mean.matrixT).toBeLessThan(hot.matrixT);
    expect(mean.matrixT).toBeGreaterThan(n.fuelRadius > 0 ? 890 : 0);
  });

  it("the mean temperature is the volume mean: it lies a third of the compact's rise below the centre for a constant conductivity (the parabola)", () => {
    // for k constant the rise at r is dT (1 - r^2/R^2) and its mean over the circle is dT / 2: the volume-mean lies half of the rise below the centre
    const r = judge();
    const hot = r.compact!.twoScale.find((e) => e.at === "hottest")!.matrixTIndependent;
    const mean = r.compact!.twoScale.find((e) => e.at === "mean")!.matrixTIndependent;
    const surface = quickLook(n).temperatures.fuelSurfaceT;
    expect((hot - mean) / (hot - surface)).toBeGreaterThan(0.45);
    expect((hot - mean) / (hot - surface)).toBeLessThan(0.55);
  });

  it("the matrix temperature read at the wrong radius (the surface instead of the centre) fails the check, as does a swapped mean", () => {
    const cells = judge().radial.filter((p) => p.region === "fuel").map((p) => ({ r: p.r, T: p.T }));
    const spec = n.compact;
    const closed = (r: number) => quickLook(n).temperatures.fuelSurfaceT + (quickLook(n).temperatures.centreT - quickLook(n).temperatures.fuelSurfaceT) * (1 - (r / n.fuelRadius) ** 2);
    const good = buildCompactRecord(spec, cells, closed, { inner: 0, outer: n.fuelRadius });
    expect(good.checks.filter((c) => c.verdict === "fail")).toEqual([]);
    const atSurface = buildCompactRecord(spec, cells, () => closed(n.fuelRadius), { inner: 0, outer: n.fuelRadius });
    expect(atSurface.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual(["twoScaleMatrix0", "twoScaleMatrix1"]);
    // the mean taken as the plain mean of the cells (not weighted by the cell's area) is also caught: it is the wrong mean by more than the bound
    const plainMean = cells.reduce((s, c) => s + c.T, 0) / cells.length;
    expect(Math.abs(plainMean - good.twoScale.find((e) => e.at === "mean")!.matrixT)).toBeGreaterThan(1);
  });

  it("a case that was not the one run fails: another packing fraction changes the table, and the fuel no longer agrees with the closed form of that case", () => {
    const r = judge((c) => {
      c.fuelConductivity.coefficients = c.fuelConductivity.coefficients.map((x: number) => x * 1.05);
    });
    expect(notPassing(r)).toContain("closedFormFuel fail");
  });
});

describe("the hottest particle through the real solver (saved output)", () => {
  it("OFFBEAT's particle behind the matrix shell, at the compact's centre temperature, has the kernel centre that the two-scale closed form gives", () => {
    const g = JSON.parse(read("tests", "golden", "offbeat-two-scale", "results.json")) as { checks: Check[]; summary: { kernelCentreCellT: number; kernelCentreT: number } };
    expect(notPassing(g)).toEqual([]);
    const spec = JSON.parse(read("tests", "golden", "offbeat-compact", "normalized.json")).compact;
    const tm = JSON.parse(read("tests", "golden", "offbeat-two-scale", "normalized.json")).boundary.bulkTemperature;
    const t = twoScaleParticle(spec, tm);
    expect(Math.abs(g.summary.kernelCentreT - t.kernelCentreT)).toBeLessThan(0.05);
    // and the film that stands for the shell is the one the case was run with
    expect(JSON.parse(read("tests", "golden", "offbeat-two-scale", "normalized.json")).boundary.heatTransferCoefficient).toBeCloseTo(t.filmCoefficient, 6);
  });
});

describe("a pebble: the case, by hand", () => {
  const v = validateCase(example("synthetic-pebble-steady"));
  const p = v.pebble!;

  it("the example is valid with no warning and is a pebble, not a pin or a particle", () => {
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.normalized).toBeUndefined();
    expect(v.triso).toBeUndefined();
    expect(p.cells).toEqual([160, 40]);
  });

  it("the fuelled zone makes the power density times its volume: 8 W/cm3 x 4/3 pi (25 mm)^3", () => {
    expect(p.power.fuelledPower).toBeCloseTo(8e6 * (4 / 3) * Math.PI * 0.025 ** 3, 9);
    expect(p.power.fuelledPower).toBeCloseTo(523.5988, 3);
    expect(p.power.pebbleVolume).toBeCloseTo((4 / 3) * Math.PI * 0.03 ** 3, 12);
  });

  it("closed form by hand (constant properties): the film, the shell's shell-resistance, the fuelled zone's parabola", () => {
    const c = validateCase(constantPebble());
    expect(c.errors).toEqual([]);
    const kf = maxwellEucken(byHandParticle(), 20, 0.35);
    const P = 8e6 * (4 / 3) * Math.PI * 0.025 ** 3;
    const film = P / (4 * Math.PI * 0.03 ** 2 * 400);
    const wall = 900 + film;
    const shell = (P / (4 * Math.PI * 25)) * (1 / 0.025 - 1 / 0.03);
    const parab = (8e6 * 0.025 ** 2) / (6 * kf);
    const cf = pebbleClosedForm(c.pebble!);
    expect(cf.filmDeltaT).toBeCloseTo(film, 9);
    expect(cf.wallT).toBeCloseTo(wall, 9);
    expect(cf.interfaceT).toBeCloseTo(wall + shell, 9);
    expect(cf.centreT).toBeCloseTo(wall + shell + parab, 6);
    expect(cf.temperatureAt(0.0275)).toBeCloseTo(wall + (P / (4 * Math.PI * 25)) * (1 / 0.0275 - 1 / 0.03), 9);
    expect(() => cf.temperatureAt(0.031)).toThrow(RangeError);
  });

  it("the finite-volume solution agrees with the closed form (two methods), and the wedge's sphere is the case's with every radius times 0.9996955", () => {
    const cf = pebbleClosedForm(p);
    const fv = steadyTrisoFv(pebbleModel(p), p.power.fuelledPower);
    expect(fv.T[0]! - cf.temperatureAt(fv.r[0]!)).toBeLessThan(0.01);
    expect(Math.abs(fv.T[0]! - cf.temperatureAt(fv.r[0]!))).toBeLessThan(0.01);
    expect(fv.wall).toBeCloseTo(cf.wallT, 6);
    const e = pebbleWedgeEquivalent(p);
    expect(TRISO_WEDGE_SCALE).toBeCloseTo(Math.cos(Math.PI / 180) / Math.sqrt(1 + Math.sin(Math.PI / 180) ** 2), 14);
    expect(TRISO_WEDGE_SCALE).toBeCloseTo(0.9996955, 7);
    expect(e.fuelledRadius).toBeCloseTo(0.025 * TRISO_WEDGE_SCALE, 15);
    expect(e.power.fuelledPower).toBeCloseTo(8e6 * SPHERE.volume(0, 0.025 * TRISO_WEDGE_SCALE), 9);
  });

  it("the fuelled zone swapped with the shell gives another answer (the regions are not interchangeable)", () => {
    const swapped = { ...p, fuelledConductivity: p.shellConductivity, shellConductivity: p.fuelledConductivity };
    expect(Math.abs(pebbleClosedForm(swapped).centreT - pebbleClosedForm(p).centreT)).toBeGreaterThan(5);
  });

  it("the steady end time is finite and the time scale is the sum of resistances times placeholder capacities (positive, finite)", () => {
    const h = pebbleSteadyEndTime(p);
    expect(h.ok).toBe(true);
    expect(pebbleTimeScale(p).tauBound).toBeGreaterThan(0);
    expect(pebbleTimeScale(p).cells).toBe(200);
  });

  it("the estimate of OFFBEAT's face interpolation: 0.47 K on a 40 + 10 cell mesh (0.488 K measured), 0.12 K on 160 + 40 (0.122 K measured), a quarter as much", () => {
    const coarse = validateCase({ ...example("synthetic-pebble-steady"), mesh: { fuelledCells: 40, shellCells: 10 } }).pebble!;
    expect(pebbleInterfaceBias(coarse).bias).toBeGreaterThan(0.44);
    expect(pebbleInterfaceBias(coarse).bias).toBeLessThan(0.5);
    expect(pebbleInterfaceBias(p).bias).toBeGreaterThan(0.11);
    expect(pebbleInterfaceBias(p).bias).toBeLessThan(0.13);
    // equal conductivities have no jump, so no bias
    expect(pebbleInterfaceBias({ ...p, shellConductivity: p.fuelledConductivity }).bias).toBeCloseTo(0, 12);
  });

  it("two radii are refused for the two-scale step when they lie outside the fuelled zone", () => {
    const d = example("synthetic-pebble-steady");
    d.compact.twoScale = { at: [qv(30, "mm")] };
    expect(validateCase(d).errors.map((e) => e.code + e.field)).toEqual(["E_GEOMETRY/compact/twoScale/at/0"]);
  });
});

describe("the pebble as OFFBEAT is given it", () => {
  const p = validateCase(example("synthetic-pebble-steady")).pebble!;
  const text = pebbleBlockMeshDict(p);
  const verts = [...(/vertices\s*\(([\s\S]*?)\n\);/.exec(text)![1]!).matchAll(/\(\s*([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*\)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);

  it("has two blocks in micrometres named like the zones the results read, with the case's cells, sharing their vertices (no gap)", () => {
    expect(verts).toHaveLength(12);
    expect([...text.matchAll(/hex \( ([\d ]+)\) (\w+) \((\d+) (\d+) (\d+)\)/g)].map((m) => [m[2], m[3], m[4], m[5]])).toEqual([["Kernel", "1", "1", "160"], ["Shell", "1", "1", "40"]]);
    expect(text).toMatch(/hex \( 0 1 2 3 4 5 6 7 \) Kernel/);
    expect(text).toMatch(/hex \( 4 5 6 7 8 9 10 11 \) Shell/);
    expect(text).not.toMatch(/regionCoupledOFFBEAT/);
    const radii = [0, 25000, 30000];
    verts.forEach((q, i) => expect(Math.hypot(q[0]!, q[1]!, q[2]!), "vertex " + i).toBeCloseTo(radii[Math.floor(i / 4)]!, 6));
  });

  it("has the four wedge planes (a face for each block) and the outside", () => {
    for (const nm of ["top", "front", "back", "bottom"]) expect(new RegExp(nm + "\\s*\\{\\s*type wedge;").test(text)).toBe(true);
    expect(/outer\s*\{\s*type patch;\s*faces\s*\(\s*\(8 9 10 11\)/.test(text)).toBe(true);
  });

  it("writes the heat into the fuelled zone only, the shell with no heat, a table past the end time, and nothing but heat switched on", () => {
    const w = writePebbleCase(p);
    const s = w.files["constant/solverDict"]!;
    expect(s).toMatch(/materials \( Kernel \)/);
    expect(s).toMatch(/vhgr\s+\(8000000 8000000\)/);
    const pts = /timePoints\s+\(([^)]*)\)/.exec(s)![1]!.trim().split(/\s+/).map(Number);
    expect(pts[1]).toBeCloseTo(2 * (w.choices.endTime as number), 6);
    expect(s).toMatch(/mechanicsSolver\s+fromLatestTime/);
    expect(s).toMatch(/fgr\s+none/);
    expect(s).toMatch(/Kernel\s*\{[\s\S]*?conductivityModel ZyRELAP/);
    expect(s).toMatch(/Shell\s*\{[\s\S]*?k\s+k\s+\[1 1 -3 -1 0\]\s+25;/);
    expect(w.files["0/T"]).toMatch(/type convectiveHTC;\s*T0 uniform 900;\s*h uniform 400;/);
    for (const f of Object.values(w.files)) expect(f).not.toMatch(/\r/);
  });

  it("a prescribed wall is a fixed temperature", () => {
    const d = example("synthetic-pebble-steady");
    delete d.boundary.bulkTemperature;
    delete d.boundary.heatTransferCoefficient;
    d.boundary.surfaceTemperature = qv(1000, "K");
    expect(writePebbleCase(validateCase(d).pebble!).files["0/T"]).toMatch(/type fixedValue;\s*value uniform 1000;/);
  });
});

describe("the pebble through the real solver (saved output)", () => {
  const d = (...q: string[]) => read("tests", "golden", "offbeat-pebble", ...q);
  const n = JSON.parse(d("normalized.json"));
  const rate = JSON.parse(d("rate.json")) as { relativeRate: number; time: number };
  const input = () => ({ T: d("T"), C: d("C"), cellZones: d("cellZones"), time: rate.time, drift: { relativeRate: rate.relativeRate } });

  it("the saved case is the example file as it is now (an edited example must be re-run)", () => {
    expect(JSON.parse(JSON.stringify({ kind: "pebble", ...validateCase(example("synthetic-pebble-steady")).pebble }))).toEqual(n);
  });

  it("every check passes, with the verdicts the solver run saved, and the two-scale hottest particle is there", () => {
    const r = buildPebbleResults(n, input());
    expect(notPassing(r)).toEqual([]);
    expect(ids(r)).toEqual(["closedFormFuelled", "closedFormShell", "crossCheckFv", "energyBalance", "wallTemperature", "propertyRange", "conductivityFitFuelled", "steadyState", "twoScaleMatrix0", "twoScaleMatrix1", "mixtureDomain"]);
    const saved = JSON.parse(d("results.json")) as { checks: Check[] };
    expect(r.checks.map((c) => [c.id, c.verdict])).toEqual(saved.checks.map((c) => [c.id, c.verdict]));
    expect(r.summary.centreT).toBeGreaterThan(r.summary.interfaceT);
    expect(r.summary.interfaceT).toBeGreaterThan(r.summary.wallT);
    expect(r.compact.twoScale.map((e) => e.at)).toEqual(["hottest", "mean"]);
    const hot = r.compact.twoScale[0]!;
    expect(hot.particle.kernelCentreT).toBeGreaterThan(hot.matrixT + 1); // 9.3 mW a particle: a rise of 2.4 K over the matrix
    expect(hot.particle.kernelCentreT).toBeLessThan(hot.matrixT + 4);
  });

  it("the solver's pebble is 0.12 K below the exact two-region solution all through the fuelled zone: OFFBEAT's face interpolation at the jump in conductivity, as the validator's estimate says", () => {
    const r = buildPebbleResults(n, input());
    const cf = pebbleClosedForm(pebbleWedgeEquivalent(n));
    const fuelled = r.cells.filter((c) => c.region === "fuelled");
    const offsets = fuelled.map((c) => c.T - cf.temperatureAt(c.r));
    expect(Math.max(...offsets)).toBeLessThan(0);
    expect(Math.min(...offsets)).toBeGreaterThan(-0.14);
    expect(Math.abs(Math.max(...offsets) - Math.min(...offsets))).toBeLessThan(0.02); // a shift, not a different profile
    expect(Math.abs(offsets[0]! + pebbleInterfaceBias(n))).toBeDefined();
    expect(Math.abs(offsets[0]!) / pebbleInterfaceBias(n).bias).toBeGreaterThan(0.9);
    expect(Math.abs(offsets[0]!) / pebbleInterfaceBias(n).bias).toBeLessThan(1.1);
    const shell = r.cells.filter((c) => c.region === "shell").map((c) => Math.abs(c.T - cf.temperatureAt(c.r)));
    expect(Math.max(...shell)).toBeLessThan(0.01);
  });

  it("the coarse mesh (40 + 10 cells) made the cross-check fail by 0.49 K of a 0.25 K bound: the case the validator warns about", () => {
    const coarse = JSON.parse(read("tests", "golden", "offbeat-pebble-coarse", "results.json")) as { checks: Check[] };
    const fv = coarse.checks.find((c) => c.id === "crossCheckFv")!;
    expect(fv.verdict).toBe("fail");
    expect(fv.value!).toBeGreaterThan(0.48);
    expect(fv.value!).toBeLessThan(0.5);
    expect(coarse.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual(["crossCheckFv"]);
  });

  it("bites: a wrong power (10 % too much), the shell and the fuelled zone swapped, and a wrong cell count are refused or fail", () => {
    const r1 = buildPebbleResults({ ...n, power: { ...n.power, powerDensity: n.power.powerDensity * 1.1 } }, input());
    expect(notPassing(r1)).toContain("energyBalance fail");
    const r2 = buildPebbleResults({ ...n, fuelledConductivity: n.shellConductivity, shellConductivity: n.fuelledConductivity }, input());
    expect(notPassing(r2)).toContain("closedFormFuelled fail");
    expect(() => buildPebbleResults({ ...n, cells: [150, 50] }, input())).toThrow(/cellZones: zone Kernel has 160 cells, the case has 150/);
  });

  it("damaged output is refused, not turned into a result", () => {
    const i = input();
    expect(() => buildPebbleResults(n, { ...i, T: i.T.slice(0, i.T.length - 200) })).toThrow(/cut short|footer|boundaryField/);
    expect(() => buildPebbleResults(n, { ...i, T: i.T.replace(/outer\s*\{[^}]*\}/, "") })).toThrow(/outer patch/);
    expect(() => buildPebbleResults(n, { ...i, cellZones: i.cellZones.replace(/Shell/g, "Foam") })).toThrow(/not a region of this pebble/);
    expect(() => buildPebbleResults(n, { ...i, time: 0 })).toThrow(/final time/);
    expect(() => buildPebbleResults(n, { ...i, T: i.T.replace(/\n1[01]\d\d\.\d+\n/, "\n-5\n") })).toThrow(/not above 0 K/);
    // the zones swapped between the two blocks: the cell centres do not belong to the zones
    expect(() => buildPebbleResults(n, { ...i, cellZones: i.cellZones.replace(/Kernel/g, "TMP").replace(/Shell/g, "Kernel").replace(/TMP/g, "Shell") })).toThrow();
  });

  it("the saved output is a complete set of files in the folder", () => {
    expect(readdirSync(join(root, "tests", "golden", "offbeat-pebble")).sort()).toEqual(["C", "T", "cellZones", "log.offbeat.txt", "normalized.json", "rate.json", "results.json"]);
  });
});
