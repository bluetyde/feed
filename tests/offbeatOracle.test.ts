// OFFBEAT against the closed form, from SAVED real solver output (solver/results/*.json, written by solver/extract-result.py
// after solver/run-oracle.sh). The tests run without the solver; regenerate the files with the scripts in solver/.
// Case: examples/synthetic-pin.json (constant k, uniform power, constant gap conductance, convective outer boundary).

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { closedForm, compositeConstantK, compositeLinearK, fuelTemperatureLinearK } from "../src/core/closedForm";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

interface Saved {
  time: number;
  nCells: number;
  r: number[];
  T: number[];
  cladOuterWallT: number;
}
const meshes = [
  { tag: "mesh1", nf: 10, nc: 3 },
  { tag: "mesh2", nf: 20, nc: 6 },
  { tag: "mesh3", nf: 40, nc: 12 },
  { tag: "mesh4", nf: 80, nc: 24 },
].map((m) => ({ ...m, res: read("solver/results/synthetic-pin." + m.tag + ".json") as Saved }));

const pin = {
  qPrime: 20000,
  fuelK: 3,
  fuelRadius: 0.0041,
  hGap: 5000,
  claddingInnerRadius: 0.00418,
  claddingOuterRadius: 0.00475,
  claddingK: 15,
  hFilm: 30000,
  bulkTemperature: 573,
};
const exact = compositeConstantK(pin);
const exactAt = (r: number) =>
  r <= pin.fuelRadius
    ? closedForm.fuelProfile(pin.qPrime, pin.fuelK, pin.fuelRadius, r, exact.fuelSurfaceT)
    : exact.claddingOuterT + closedForm.claddingDeltaT(pin.qPrime, r, pin.claddingOuterRadius, pin.claddingK);

/** Largest |OFFBEAT - closed form| over the cell centres of a region. */
function maxError(res: Saved, region: "fuel" | "clad", T: number[] = res.T): number {
  let worst = 0;
  res.r.forEach((r, i) => {
    const inRegion = region === "fuel" ? r < pin.fuelRadius : r > pin.claddingInnerRadius;
    if (inRegion) worst = Math.max(worst, Math.abs(T[i]! - exactAt(r)));
  });
  return worst;
}

describe("OFFBEAT thermal oracle (saved output)", () => {
  it("input sanity: the saved cells cover the pin and the run reached a late time", () => {
    for (const m of meshes) {
      expect(m.res.nCells).toBe(m.nf + m.nc);
      expect(m.res.time).toBeGreaterThanOrEqual(1e7); // long enough to be steady: the storage term is negligible
      expect(m.res.T.every(Number.isFinite)).toBe(true);
    }
  });

  // Tolerance basis: a second-order cell-centred scheme has error of order dT/N^2; the same bound (5 dT/N^2) was fixed
  // for the independent finite-volume cross-check before this solver ran. It was NOT tuned on these results.
  for (const m of meshes) {
    it(m.tag + ": fuel and cladding temperatures within the discretization bound", () => {
      expect(maxError(m.res, "fuel")).toBeLessThan((5 * exact.fuelDeltaT) / (m.nf * m.nf));
      expect(maxError(m.res, "clad")).toBeLessThan((5 * exact.claddingDeltaT) / (m.nc * m.nc));
    });
  }

  it("outer wall temperature matches the closed form (energy balance at the boundary)", () => {
    for (const m of meshes) expect(Math.abs(m.res.cladOuterWallT - exact.claddingOuterT)).toBeLessThan(0.05);
  });

  // Observed after the runs (not pre-registered): errors fall by factors of 3.1, 3.3, 3.7 per doubling, so the gate is
  // "better than 2.5 per doubling" (second order would be 4).
  it("converges toward second order under mesh refinement", () => {
    const e = meshes.map((m) => maxError(m.res, "fuel"));
    for (let i = 1; i < e.length; i++) expect(e[i - 1]! / e[i]!).toBeGreaterThan(2.5);
  });

  // Tests of the verifier: a wrong solver result must fail these comparisons.
  describe("a wrong result is caught", () => {
    const m = meshes[2]!;
    const bound = (5 * exact.fuelDeltaT) / (m.nf * m.nf);
    const rise = (f: number) => m.res.T.map((t, i) => (m.res.r[i]! < pin.fuelRadius ? exact.fuelSurfaceT + (t - exact.fuelSurfaceT) * f : t));
    it("accepts the real result", () => expect(maxError(m.res, "fuel")).toBeLessThan(bound));
    it("rejects a fuel temperature rise 1% too high (wrong conductivity or power)", () => expect(maxError(m.res, "fuel", rise(1.01))).toBeGreaterThan(bound));
    it("rejects a dropped gap (fuel surface 155 K too cold)", () => {
      const T = m.res.T.map((t, i) => (m.res.r[i]! < pin.fuelRadius ? t - exact.gapDeltaT : t));
      expect(maxError(m.res, "fuel", T)).toBeGreaterThan(bound);
    });
    it("rejects swapped fuel and cladding conductivities (cladding drop wrong)", () => {
      const T = m.res.T.map((t, i) => (m.res.r[i]! > pin.claddingInnerRadius ? exact.claddingOuterT + (t - exact.claddingOuterT) * 5 : t));
      expect(maxError(m.res, "clad", T)).toBeGreaterThan((5 * exact.claddingDeltaT) / (m.nc * m.nc));
    });
  });
});

// The sourced K-State TRIGA hot element (zero cold gap, effective gap conductance, outer surface fixed at 21.2 C).
describe("OFFBEAT on the K-State TRIGA hot element (saved output)", () => {
  const res = read("solver/results/ksu-hot-element.json") as Saved;
  const k = { qPrime: 62021, fuelK: 18, fuelRadius: 0.018161, hGap: 2840, claddingInnerRadius: 0.018161, claddingOuterRadius: 0.018669, claddingK: 16.6 };
  const tOuter = 294.35;
  const tCladInner = tOuter + closedForm.claddingDeltaT(k.qPrime, k.claddingInnerRadius, k.claddingOuterRadius, k.claddingK);
  const tFuelSurface = tCladInner + closedForm.gapDeltaT(k.qPrime, k.fuelRadius, k.hGap);

  it("matches the closed form within the discretization bound (40 fuel cells)", () => {
    let worst = 0;
    res.r.forEach((r, i) => {
      if (r < k.fuelRadius) worst = Math.max(worst, Math.abs(res.T[i]! - closedForm.fuelProfile(k.qPrime, k.fuelK, k.fuelRadius, r, tFuelSurface)));
    });
    expect(worst).toBeLessThan((5 * closedForm.fuelDeltaT(k.qPrime, k.fuelK)) / (40 * 40));
  });

  it("reproduces the SAR's published centreline temperature (Table 4.8: 503.2 C) to within 0.5 K at the first cell", () => {
    const centreCell = res.T[0]!; // first cell centre is 0.3 mm from the axis; the profile offset there is about 0.07 K
    expect(Math.abs(centreCell - (503.2 + 273.15))).toBeLessThan(0.5);
  });

  it("holds the outer wall at the prescribed temperature", () => {
    expect(res.cladOuterWallT).toBeCloseTo(tOuter, 2);
  });
});

// Temperature-dependent fuel conductivity k = 4.0 - 0.0006 T through OFFBEAT's linear-in-degC model with overridden coefficients.
// Oracle: the conductivity integral (oracles/closed-form-table.json, pin-composite-k-of-T-centre = 1246.8586 K).
describe("OFFBEAT with k(T) in the fuel (saved output)", () => {
  const kT = { a: 4.0, b: -0.0006 };
  const lin = compositeLinearK({ qPrime: 20000, fuelK: kT, fuelRadius: 0.0041, hGap: 5000, claddingInnerRadius: 0.00418, claddingOuterRadius: 0.00475, claddingK: { a: 15, b: 0 }, boundary: { kind: "convective", bulkTemperature: 573, hFilm: 30000 } });
  const runs = [
    { tag: "mesh1", nf: 10 },
    { tag: "mesh2", nf: 20 },
    { tag: "mesh3", nf: 40 },
    { tag: "mesh4", nf: 80 },
  ].map((m) => ({ ...m, res: read("solver/results/synthetic-pin-kT." + m.tag + ".json") as Saved }));
  const fuelErr = (res: Saved, T: number[] = res.T) => {
    let worst = 0;
    res.r.forEach((r, i) => {
      if (r < pin.fuelRadius) worst = Math.max(worst, Math.abs(T[i]! - fuelTemperatureLinearK(kT, pin.qPrime, pin.fuelRadius, r, lin.fuelSurfaceT)));
    });
    return worst;
  };

  it("the oracle value the comparison rests on is the table's 1246.8586 K", () => {
    expect(lin.centreT).toBeCloseTo(1246.8586, 3);
  });

  for (const m of runs) {
    it(m.tag + ": within the discretization bound of the conductivity-integral solution", () => {
      expect(fuelErr(m.res)).toBeLessThan((5 * lin.fuelDeltaT) / (m.nf * m.nf));
    });
  }

  it("converges toward second order", () => {
    const e = runs.map((m) => fuelErr(m.res));
    for (let i = 1; i < e.length; i++) expect(e[i - 1]! / e[i]!).toBeGreaterThan(2.5);
  });

  it("the outer wall is unchanged by k(T) in the fuel (same flux, same film)", () => {
    for (const m of runs) expect(Math.abs(m.res.cladOuterWallT - lin.claddingOuterT)).toBeLessThan(0.05);
  });

  describe("a wrong result is caught", () => {
    const m = runs[2]!;
    const bound = (5 * lin.fuelDeltaT) / (m.nf * m.nf);
    it("accepts the real result", () => expect(fuelErr(m.res)).toBeLessThan(bound));
    it("rejects the constant-k answer (ignoring the slope b)", () => {
      // the same output compared with k held at its value at the fuel surface temperature
      const kSurf = kT.a + kT.b * lin.fuelSurfaceT;
      const T = m.res.r.map((r, i) => (r < pin.fuelRadius ? lin.fuelSurfaceT + (pin.qPrime * (1 - (r * r) / (pin.fuelRadius * pin.fuelRadius))) / (4 * Math.PI * kSurf) : m.res.T[i]!));
      expect(fuelErr(m.res, T)).toBeGreaterThan(bound);
    });
    it("rejects the wrong sign of the slope", () => {
      const wrong = { a: kT.a, b: -kT.b };
      const T = m.res.r.map((r, i) => (r < pin.fuelRadius ? fuelTemperatureLinearK(wrong, pin.qPrime, pin.fuelRadius, r, lin.fuelSurfaceT) : m.res.T[i]!));
      expect(fuelErr(m.res, T)).toBeGreaterThan(bound);
    });
  });
});
