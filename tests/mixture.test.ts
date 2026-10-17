// Plan 13 T4: the mixture laws and the equivalent sphere (src/core/mixture.ts), against hand arithmetic and against the resolved three-dimensional model
// (scripts/mixture-reference.cjs, scripts/mixture-reference-layered.cjs; their output is tests/golden/mixture/*.json and is read here without running them).
//
// Tolerances, fixed before the first comparison with the resolved data:
//   - the law is judged against the resolved model's value extrapolated to a zero cell size (first order, from the 64 and 128 grids); the extrapolation itself is uncertain by the
//     size of its correction u = |k_ext - k_128| / k_ext, so a case passes when |law / k_ext - 1| <= the stated bound + u;
//   - the stated bound of the default law is MIXTURE_ERROR_BOUND = 2 %, over particle-to-matrix ratios 0.05 to 3 up to a packing fraction of 0.4 and ratios 3 to 10 up to 0.2
//     (the resolved model is unresolved above a ratio of 10: those cases are in the data but not in the claim);
//   - the equivalent sphere with the default law is judged against layered spheres in the resolved model with 0.5 % + u.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { MIXTURE_DOMAIN, MIXTURE_ERROR_BOUND } from "../src/core/compact";
import { bruggeman, differential, equivalentParticleConductivity, maxwellEucken, MIXTURE_LAWS, mixtureConductivity } from "../src/core/mixture";

const root = join(__dirname, "..");
const read = (f: string) => JSON.parse(readFileSync(join(root, "tests", "golden", "mixture", f), "utf8"));
interface Resolved { arrangement: string; phi: number; alpha: number; seed?: number; keff: Record<string, number> }
const resolved: Resolved[] = read("resolved.json").cases;
/** The resolved value extrapolated to a zero cell size (first order in the cell size) and the size of the correction, relative. */
const extrapolate = (c: { keff: Record<string, number> }) => {
  const k = c.keff["128"]! + (c.keff["128"]! - c.keff["64"]!);
  return { k, u: Math.abs(k - c.keff["128"]!) / k };
};
const inClaim = (c: Resolved) => (c.alpha >= MIXTURE_DOMAIN.contrastMin && c.alpha <= MIXTURE_DOMAIN.contrastMax && c.phi <= MIXTURE_DOMAIN.packingMax + 1e-9) || (c.alpha > MIXTURE_DOMAIN.contrastMax && c.alpha <= 10 && c.phi <= MIXTURE_DOMAIN.packingMaxHighContrast + 1e-9);

describe("the laws, by hand", () => {
  it("Maxwell-Eucken: spheres of 3 in a matrix of 1 at 0.2 give (3 + 2 + 2 x 0.2 x 2) / (3 + 2 - 0.2 x 2) = 5.8 / 4.6", () => {
    expect(maxwellEucken(3, 1, 0.2)).toBeCloseTo(5.8 / 4.6, 14);
    expect(maxwellEucken(3, 2, 0.2)).toBeCloseTo(2 * (3 + 4 + 2 * 0.2 * 1) / (3 + 4 - 0.2 * 1), 14); // the matrix scales it
    expect(maxwellEucken(0.2, 1, 0.1)).toBeCloseTo((0.2 + 2 + 2 * 0.1 * -0.8) / (0.2 + 2 + 0.1 * 0.8), 14); // spheres that conduct less than the matrix
  });
  it("every law gives the matrix at no spheres, the sphere at all spheres, and the same for equal conductivities", () => {
    for (const law of MIXTURE_LAWS) {
      expect(mixtureConductivity(law, 5, 2, 0)).toBeCloseTo(2, 9);
      expect(mixtureConductivity(law, 5, 2, 1)).toBeCloseTo(5, 9);
      expect(mixtureConductivity(law, 4, 4, 0.37)).toBeCloseTo(4, 9);
    }
  });
  it("Bruggeman satisfies its own equation and the differential law satisfies its own", () => {
    for (const [kp, km, phi] of [[3, 1, 0.3], [0.2, 1, 0.4], [10, 2, 0.25]] as const) {
      const k = bruggeman(kp, km, phi);
      expect(phi * (kp - k) / (kp + 2 * k) + (1 - phi) * (km - k) / (km + 2 * k)).toBeCloseTo(0, 12);
      const d = differential(kp, km, phi);
      expect(((kp - d) / (kp - km)) * Math.cbrt(km / d)).toBeCloseTo(1 - phi, 12);
    }
  });
  it("all three have the dilute slope 3 beta phi, beta = (kp - km) / (kp + 2 km) (Maxwell 1873)", () => {
    const beta = (3 - 1) / (3 + 2);
    for (const law of MIXTURE_LAWS) expect((mixtureConductivity(law, 3, 1, 1e-6) - 1) / 1e-6).toBeCloseTo(3 * beta, 4);
  });
});

describe("the equivalent sphere", () => {
  it("one region is that region; two regions are Hashin's coated sphere, written out by hand", () => {
    expect(equivalentParticleConductivity([1], [7])).toBeCloseTo(7, 12);
    // core k1 = 3 to 0.6 R, shell k2 = 0.4 to R: c = 0.6^3 = 0.216; k = k2 [(k1 + 2 k2) + 2 c (k1 - k2)] / [(k1 + 2 k2) - c (k1 - k2)] = 0.4 x 4.9232 / 3.2384
    const c = 0.216;
    const by = (0.4 * (3.8 + 2 * c * 2.6)) / (3.8 - c * 2.6);
    expect(by).toBeCloseTo(0.608, 3);
    expect(equivalentParticleConductivity([0.6, 1], [3, 0.4])).toBeCloseTo(by, 12);
    // a region of the same conductivity as its neighbour changes nothing
    expect(equivalentParticleConductivity([0.3, 0.6, 1], [3, 3, 0.4])).toBeCloseTo(by, 12);
  });
  it("three regions: the two-region formula applied twice, by hand", () => {
    const hashin = (k1: number, k2: number, c: number) => (k2 * (k1 + 2 * k2 + 2 * c * (k1 - k2))) / (k1 + 2 * k2 - c * (k1 - k2));
    const kA = hashin(3, 0.5, (250 / 350) ** 3); // kernel and buffer as one sphere of radius 350
    const kB = hashin(kA, 4, (350 / 390) ** 3); // with the inner carbon outside it
    expect(equivalentParticleConductivity([250, 350, 390], [3, 0.5, 4])).toBeCloseTo(kB, 10);
  });
  it("a gap of conductance h between two regions equals a thin layer of conductivity h t, and lowers the sphere's conductivity as h falls", () => {
    const radii = [250, 350, 390];
    const k = [3, 0.5, 4];
    const none = equivalentParticleConductivity(radii, k);
    const h = 150000 * 1e-6; // W/m2/K, radii in micrometres: the gap's conductance per micrometre of radius
    const t = 1e-5; // um
    const thin = equivalentParticleConductivity([250, 350, 350 + t, 390], [3, 0.5, h * t, 4]);
    const gap = equivalentParticleConductivity(radii, k, [undefined, h]);
    expect(gap).toBeCloseTo(thin, 4);
    expect(gap).toBeLessThan(none);
    expect(equivalentParticleConductivity(radii, k, [undefined, 1e12])).toBeCloseTo(none, 6);
    expect(equivalentParticleConductivity(radii, k, [undefined, h / 10])).toBeLessThan(gap);
  });
});

describe("the mixture law against the resolved three-dimensional model", () => {
  it("the data hold the three lattices and the random arrangements at the packing fractions and ratios the claim is made over", () => {
    expect(new Set(resolved.map((c) => c.arrangement))).toEqual(new Set(["SC", "BCC", "FCC", "RSA"]));
    expect(resolved.filter(inClaim).length).toBeGreaterThan(70);
  });
  it("Maxwell-Eucken is within the stated 2 % (plus the extrapolation's own size) of the resolved value in every case of the claim", () => {
    let worst = 0;
    for (const c of resolved.filter(inClaim)) {
      const { k, u } = extrapolate(c);
      const e = Math.abs(maxwellEucken(c.alpha, 1, c.phi) / k - 1);
      worst = Math.max(worst, e);
      expect(e, `${c.arrangement}${c.seed ?? ""} phi ${c.phi} ratio ${c.alpha}`).toBeLessThanOrEqual(MIXTURE_ERROR_BOUND + u);
    }
    expect(worst).toBeLessThan(0.019); // measured 1.82 %
  });
  it("for ratios of the particle to the matrix of 0.05 to 3 the error is at most 1.6 % up to a packing fraction of 0.4", () => {
    for (const c of resolved.filter((x) => x.alpha <= 3 && x.phi <= 0.4 + 1e-9)) {
      const { k, u } = extrapolate(c);
      expect(Math.abs(maxwellEucken(c.alpha, 1, c.phi) / k - 1), `${c.arrangement}${c.seed ?? ""} phi ${c.phi} ratio ${c.alpha}`).toBeLessThanOrEqual(0.016 + u);
    }
  });
  it("it is the best of the three: Bruggeman and the differential law are far outside the same bound somewhere in the claim", () => {
    const worst = (law: (kp: number, km: number, phi: number) => number) => Math.max(...resolved.filter(inClaim).map((c) => Math.abs(law(c.alpha, 1, c.phi) / extrapolate(c).k - 1)));
    const me = worst(maxwellEucken);
    expect(worst(bruggeman)).toBeGreaterThan(0.1); // measured 13 %
    expect(worst(differential)).toBeGreaterThan(0.04); // measured 5.0 %
    expect(me).toBeLessThan(worst(differential) / 2);
  });
  it("above the claim the error grows as the validator says: 5 % at a packing fraction of 0.5, 4 % at 0.3 to 0.4 with a ratio of 10", () => {
    const sc50 = resolved.find((c) => c.arrangement === "SC" && c.phi === 0.5 && c.alpha === 0.05)!;
    expect(Math.abs(maxwellEucken(0.05, 1, 0.5) / extrapolate(sc50).k - 1)).toBeGreaterThan(0.04);
    const sc40 = resolved.find((c) => c.arrangement === "SC" && c.phi === 0.4 && c.alpha === 10)!;
    expect(Math.abs(maxwellEucken(10, 1, 0.4) / extrapolate(sc40).k - 1)).toBeGreaterThan(0.03);
  });
  it("the resolved model reproduces its own saved value on a coarse grid (the script is the one that wrote the data)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ref = require(join(root, "scripts", "mixture-reference.cjs")) as any;
    const c = resolved.find((x) => x.arrangement === "SC" && x.phi === 0.2 && x.alpha === 3)!;
    const r = ref.solveCell(ref.lattice("SC"), [{ r: ref.radiusFor(0.2, 1), k: 3 }], 32);
    expect(r.keff).toBeCloseTo(c.keff["32"]!, 9);
    // and it is Maxwell's in the dilute limit, to the order the cell is resolved (first order in the cell size at 48 cells)
    const dilute = ref.solveCell(ref.lattice("SC"), [{ r: ref.radiusFor(0.03, 1), k: 3 }], 48);
    expect((dilute.keff - 1) / (maxwellEucken(3, 1, 0.03) - 1)).toBeGreaterThan(0.95);
    expect((dilute.keff - 1) / (maxwellEucken(3, 1, 0.03) - 1)).toBeLessThan(1.05);
  });
});

describe("the layered particle as an equivalent sphere, against layered spheres in the resolved model", () => {
  const layered: { design: string; phi: number; frac: number[]; k: number[]; keff: Record<string, number> }[] = read("layered.json").cases;
  it("equivalent sphere + Maxwell-Eucken is within 0.5 % (plus the extrapolation's size) of the resolved value for a two-layer and a five-region particle at packing fractions 0.1 to 0.4", () => {
    expect(layered).toHaveLength(8);
    for (const c of layered) {
      const { k, u } = extrapolate(c);
      const keq = equivalentParticleConductivity(c.frac, c.k);
      expect(Math.abs(maxwellEucken(keq, 1, c.phi) / k - 1), `${c.design} ${c.phi}`).toBeLessThanOrEqual(0.005 + u);
    }
  });
  it("the simple replacements are far off, which is why the exact one is used: the volume-weighted mean and the shells' series conductivity", () => {
    for (const c of layered.filter((x) => x.phi >= 0.2)) {
      const { k } = extrapolate(c);
      let vol = 0;
      let prev = 0;
      c.k.forEach((kk, i) => {
        vol += kk * (c.frac[i]! ** 3 - prev ** 3);
        prev = c.frac[i]!;
      });
      expect(Math.abs(maxwellEucken(vol, 1, c.phi) / k - 1), `volume mean ${c.design} ${c.phi}`).toBeGreaterThan(0.025);
      let R = 0;
      for (let i = 1; i < c.k.length; i++) R += (1 / c.frac[i - 1]! - 1 / c.frac[i]!) / (4 * Math.PI * c.k[i]!);
      const series = (1 / c.frac[0]! - 1) / (4 * Math.PI * R);
      expect(Math.abs(maxwellEucken(series, 1, c.phi) / k - 1), `series ${c.design} ${c.phi}`).toBeGreaterThan(0.05);
    }
  });
});
