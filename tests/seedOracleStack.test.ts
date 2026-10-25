// Plan 12 A8: the SEED oracle entries for an axial stack and a plate (oracles/seed/entries/feed-stack-*, feed-plate-steady-*, feed-bad-axial-*, feed-bad-plate-*, written by
// scripts/gen-seed-oracles.cjs). Ungated: the generator reproduces every committed file byte for byte and the 101 earlier files are the ones that were there; each entry's reference is
// worked here again by hand (no code of the generator or of src/core); FEED's own per-slice closed form and independent finite-volume solutions agree with them inside the entries'
// tolerances, and the tolerance terms are the ones FEED's checks use; the entries are shown to test what they claim (a stack read from the top, a coolant that does not warm and a
// transient whose cooling is not lost are all far away); saved real OFFBEAT output (tests/golden/seed-oracles, made by the gated part below with FEED_SAVE_GOLDEN=1) is read back and
// lands inside every tolerance. Gated (FEED_SOLVER=1): the same cases through FEED's writer and run manager into the real solver, every check passing.
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { axialConductionEstimate, axialSummary, sliceLoads } from "../src/core/axial";
import { buildResults } from "../src/core/resultsParser";
import { RunManager } from "../src/core/runManager";
import { StackRecord, buildStackResults } from "../src/core/stackResults";
import { StackTransientRecord, buildStackTransientResults, computeIndependentStack, exchangeAllowances } from "../src/core/stackTransientResults";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const dir = join(root, "oracles", "seed");
const golden = join(root, "tests", "golden", "seed-oracles");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const entries = readdirSync(join(dir, "entries")).map((f) => JSON.parse(readFileSync(join(dir, "entries", f), "utf8")));
const entry = (id: string) => entries.find((e) => e.oracleId === id)!;
const caseOf = (e: any) => JSON.parse(readFileSync(join(dir, e.inputs[0].path), "utf8"));
const caseNamed = (name: string) => JSON.parse(readFileSync(join(dir, "models", name + ".case.json"), "utf8"));
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};
const ids = (stem: string, quantities: string[]) => quantities.map((q) => "feed-" + stem + "-" + q);
const STEADY = ["stack-cosine-pin", "stack-warming-coolant-pin", "stack-skewed-pin", "stack-cosine-plate"];
const TRANSIENT = ["stack-lumped-plate-loss-of-cooling", "stack-lumped-pin-coastdown"];

// ---- the references, written out by hand: the synthetic pin (fuel k 3, cladding k 15 W/m/K, radii 4.1, 4.18, 4.75 mm, gap 5000 W/m2/K) and plate (half-thickness 4.1 mm, cladding 0.57 mm)
const pinCentre = (q: number, Tb: number, h: number) => Tb + q / (2 * Math.PI * 4.75e-3 * h) + (q * Math.log(4.75 / 4.18)) / (2 * Math.PI * 15) + q / (2 * Math.PI * 4.1e-3 * 5000) + q / (4 * Math.PI * 3);
const plateCentre = (q: number, Tb: number, h: number) => Tb + q / h + (q * 0.57e-3) / 15 + q / 5000 + (q * 4.1e-3) / (2 * 3);
const cosineFactor = (N: number) => Array.from({ length: N }, (_, k) => (Math.PI / 2) * Math.cos(Math.PI * ((k + 0.5) / N - 0.5)));
/** The skewed table of the case (fractions of the length and relative power), interpolated at the slice centres and normalised to an average of 1 by the trapezoid rule. */
function tableFactor(c: any, N: number) {
  const L = c.axial.length.value;
  const pts: [number, number][] = c.axial.powerShape.points.map((p: any) => [p.position.value / L, p.relativePower.value]);
  let integral = 0;
  for (let i = 1; i < pts.length; i++) integral += 0.5 * (pts[i]![1] + pts[i - 1]![1]) * (pts[i]![0] - pts[i - 1]![0]);
  const at = (x: number) => {
    for (let i = 1; i < pts.length; i++) if (x <= pts[i]![0]) return pts[i - 1]![1] + ((pts[i]![1] - pts[i - 1]![1]) * (x - pts[i - 1]![0])) / (pts[i]![0] - pts[i - 1]![0]);
    return pts[pts.length - 1]![1];
  };
  return Array.from({ length: N }, (_, k) => at((k + 0.5) / N) / integral);
}
const argmax = (a: number[]) => a.reduce((m, x, i) => (x > a[m]! ? i : m), 0);
const REF: Record<string, number[]> = {
  "stack-cosine-pin": cosineFactor(9).map((f) => pinCentre(20000 * f, 573, 30000)),
  "stack-warming-coolant-pin": cosineFactor(9).map((f, k) => pinCentre(5000 * f, 573 + 300 * ((k + 0.5) / 9), 30000)),
  "stack-skewed-pin": tableFactor(caseNamed("stack-skewed-pin"), 10).map((f) => pinCentre(20000 * f, 573, 30000)),
  "stack-cosine-plate": cosineFactor(9).map((f) => plateCentre(200000 * f, 573, 30000)),
};
/** The cosine's table term is part of the tolerance for a cosine and absent for a table. */
const COSINE = new Set(["stack-cosine-pin", "stack-warming-coolant-pin", "stack-cosine-plate"]);

describe("the fuel temperature entries (the return quantity of SEED's power-temperature loop), worked by hand", () => {
  // the volume mean of a slice: a solid pin's parabola has its mean at the surface plus half the rise (q / (4 pi k) = the centre-to-surface rise), a plate's through the half-thickness at two thirds
  const pinMean = (q: number, Tb: number, h: number) => pinCentre(q, Tb, h) - q / (8 * Math.PI * 3);
  const plateMean = (q: number, Tb: number, h: number) => plateCentre(q, Tb, h) - ((q * 4.1e-3) / (2 * 3)) / 3;
  const MEANS: Record<string, number[]> = {
    "stack-cosine-pin": cosineFactor(9).map((f) => pinMean(20000 * f, 573, 30000)),
    "stack-warming-coolant-pin": cosineFactor(9).map((f, k) => pinMean(5000 * f, 573 + 300 * ((k + 0.5) / 9), 30000)),
    "stack-skewed-pin": tableFactor(caseNamed("stack-skewed-pin"), 10).map((f) => pinMean(20000 * f, 573, 30000)),
    "stack-cosine-plate": cosineFactor(9).map((f) => plateMean(200000 * f, 573, 30000)),
  };
  for (const [name, means] of Object.entries(MEANS)) {
    it(name + ": the largest, the smallest and the all-slice mean are the hand values (to the 4 digits written), with the tolerance of the stack's peak entries", () => {
      const all = means.reduce((a, b) => a + b, 0) / means.length;
      for (const [q, want] of [["temperature_fuel_mean_slice_max", Math.max(...means)], ["temperature_fuel_mean_slice_min", Math.min(...means)], ["temperature_fuel_mean", all]] as const) {
        const e = entry("feed-" + name + "-" + q.replace(/_/g, "-"));
        expect(e.expected.quantity).toBe(q);
        expect(e.expected.unit).toBe("K");
        expect(Math.abs(e.expected.value - want), q).toBeLessThan(6e-4);
        expect(e.tolerance.rel).toBe(0);
        expect(e.tolerance.abs).toBeGreaterThanOrEqual(entry("feed-" + name + "-temperature-peak").tolerance.abs); // at least the peak entry's: the largest over the slices
      }
    });
  }
  it("the transferred one-slice pin: the mean is the hand value, 20 kW/m, 573 K, 30000 W/m2/K, and the case carries the slice it is for", () => {
    const e = entry("feed-fuel-mean-transferred-pin-temperature-fuel-mean");
    expect(Math.abs(e.expected.value - pinMean(20000, 573, 30000))).toBeLessThan(6e-4);
    const c = caseNamed("fuel-mean-transferred-pin");
    expect(c.provenance.transfers[0]).toMatchObject({ kind: "heating", z: { min: 0.25, max: 0.5 } });
    expect(norm(c).heatingSlice).toMatchObject({ id: "slice-2", z: { min: 0.25, max: 0.5 } });
  });
});

describe("the set as a whole", () => {
  it("there are 138 entries: 92 good, 43 bad-input, 3 known-limit; 37 are new (24 of plan 12 A8 and 13 fuel temperature entries) and 101 are the earlier ones", () => {
    const n = (t: string) => entries.filter((e) => e.tag === t).length;
    expect([entries.length, n("good"), n("bad-input"), n("known-limit")]).toEqual([138, 92, 43, 3]);
    const old = JSON.parse(readFileSync(join(golden, "files-of-101.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(old).filter((k) => k.startsWith("entries/"))).toHaveLength(101);
    expect(entries.length - 101).toBe(37);
  });
  it("the 101 earlier entries and the 72 cases they pin are byte for byte what they were (their hashes, taken from main before this milestone)", () => {
    const old = JSON.parse(readFileSync(join(golden, "files-of-101.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(old)).toHaveLength(173);
    for (const [file, hash] of Object.entries(old)) expect(sha(readFileSync(join(dir, file))), file).toBe(hash);
  });
  it("the generator reproduces every committed file byte for byte (a fresh run into a temporary folder, the README included)", () => {
    const tmp = join(mkdtempSync(join(tmpdir(), "x-")), "feed-oracle-run");
    execFileSync(process.execPath, [join(root, "scripts", "gen-seed-oracles.cjs")], { env: { ...process.env, FEED_ORACLE_OUT: tmp }, cwd: root, stdio: "pipe" });
    const walk = (d: string, base = ""): string[] => readdirSync(join(d, base), { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(d, join(base, f.name)) : [join(base, f.name)]));
    const fresh = walk(tmp).sort();
    expect(fresh).toEqual(walk(dir).sort());
    for (const f of fresh) expect(sha(readFileSync(join(tmp, f))), f).toBe(sha(readFileSync(join(dir, f))));
  }, 120_000);
  it("each new entry pins its case and its tolerance by hash, and every case is valid (the refusal cases are refused with the code the entry names, first)", () => {
    for (const e of entries.filter((x) => /^feed-(stack-|plate-steady|bad-axial-|bad-plate-)/.test(x.oracleId))) {
      expect(e.inputs[0].sha256, e.oracleId).toBe(sha(readFileSync(join(dir, e.inputs[0].path))));
      const v = validateCase(caseOf(e));
      if (e.tag === "bad-input") {
        expect(v.ok, e.oracleId).toBe(false);
        expect(v.errors[0]!.code, e.oracleId).toBe(e.expected.refusalCode);
      } else {
        expect(v.errors, e.oracleId).toEqual([]);
        expect(e.source.kind).toBe("analytic");
        expect(e.tolerance.rel).toBe(0);
      }
    }
  });
});

describe("the steady stack entries: the reference by hand, FEED's own per-slice closed form, and the tolerance", () => {
  it("the cosine pin: the slice peaks worked out by hand are 773.55, 1150.47, 1457.73, 1658.28, 1727.93 K and back; the entries are the hottest, its index and the coolest", () => {
    const r = REF["stack-cosine-pin"]!;
    [773.5523, 1150.4673, 1457.7312, 1658.2835, 1727.9346, 1658.2835, 1457.7312, 1150.4673, 773.5523].forEach((x, k) => expect(r[k]!, "slice " + k).toBeCloseTo(x, 3));
    expect(entry("feed-stack-cosine-pin-temperature-peak").expected.value).toBeCloseTo(1727.9346, 3);
    expect(entry("feed-stack-cosine-pin-axial-hottest-slice").expected.value).toBe(4);
    expect(entry("feed-stack-cosine-pin-temperature-peak-slice-min").expected.value).toBeCloseTo(773.5523, 3);
    expect(entry("feed-stack-cosine-pin-axial-hottest-slice").expected.unit).toBe("1");
  });
  it("the warming coolant: 5 kW/m on average, 573 to 873 K up 0.381 m: the hottest slice is the sixth (index 5), 1027.65 K; the coolest is the bottom one, 639.80 K", () => {
    const r = REF["stack-warming-coolant-pin"]!;
    [639.8047, 767.3668, 877.5161, 960.9876, 1011.7337, 1027.6542, 1010.8495, 967.3668, 906.4714].forEach((x, k) => expect(r[k]!, "slice " + k).toBeCloseTo(x, 3));
    expect(entry("feed-stack-warming-coolant-pin-temperature-peak").expected.value).toBeCloseTo(1027.6542, 3);
    expect(entry("feed-stack-warming-coolant-pin-axial-hottest-slice").expected.value).toBe(5);
    expect(entry("feed-stack-warming-coolant-pin-temperature-peak-slice-min").expected.value).toBeCloseTo(639.8047, 3);
  });
  it("the skewed shape: the hottest slice is index 3 (1525.45 K) and the coolest is the top one (970.72 K)", () => {
    const r = REF["stack-skewed-pin"]!;
    expect(argmax(r)).toBe(3);
    expect(r[3]!).toBeCloseTo(1525.4511, 3);
    expect(r[9]!).toBeCloseTo(970.7189, 3);
    expect(r[0]!).toBeCloseTo(1122.6905, 3);
    expect(entry("feed-stack-skewed-pin-temperature-peak").expected.value).toBeCloseTo(1525.4511, 3);
    expect(entry("feed-stack-skewed-pin-axial-hottest-slice").expected.value).toBe(3);
    expect(entry("feed-stack-skewed-pin-temperature-peak-slice-min").expected.value).toBeCloseTo(970.7189, 3);
  });
  it("the cosine plate: 200 kW per metre of height and width on average, the slice peaks are 625.08, 722.96, 802.75, 854.83, 872.92 K and back", () => {
    const r = REF["stack-cosine-plate"]!;
    [625.0801, 722.9587, 802.75, 854.8301, 872.9174, 854.8301, 802.75, 722.9587, 625.0801].forEach((x, k) => expect(r[k]!, "slice " + k).toBeCloseTo(x, 3));
    expect(entry("feed-stack-cosine-plate-temperature-peak").expected.value).toBeCloseTo(872.9174, 3);
    expect(entry("feed-stack-cosine-plate-axial-hottest-slice").expected.value).toBe(4);
    expect(entry("feed-stack-cosine-plate-temperature-peak-slice-min").expected.value).toBeCloseTo(625.0801, 3);
  });
  it("the plate alone: 592.0933 K at the centre (573 + 0.6667 + 0.76 + 4 + 13.6667) and 573.6667 K at the face", () => {
    expect(plateCentre(20000, 573, 30000)).toBeCloseTo(592.0933, 4);
    expect(entry("feed-plate-steady-temperature-peak").expected.value).toBeCloseTo(592.0933, 4);
    expect(entry("feed-plate-steady-temperature-surface").expected.value).toBeCloseTo(573 + 20000 / 30000, 4);
    expect(entry("feed-plate-steady-temperature-peak").tolerance.abs).toBe(0.05);
  });
  for (const name of STEADY) {
    it(name + ": FEED's per-slice closed form agrees with the entries (to the cosine's table term, or 1e-3 K for a table), and the tolerance is the sum of FEED's three terms rounded up to 0.05 K", () => {
      const e = ids(name, ["temperature-peak", "axial-hottest-slice", "temperature-peak-slice-min"]).map(entry);
      const n = norm(caseOf(e[0]));
      const s = axialSummary(n)!;
      const centres = s.slices.map((x) => x.centreT);
      const loads = sliceLoads(n);
      const rises = s.slices.map((x, k) => x.centreT - (loads[k]!.boundary.kind === "convective" ? loads[k]!.boundary.bulkTemperature : 0));
      const ref = REF[name]!;
      // FEED's slices come from the 41-point cosine table, so they differ from the exact cosine by at most 1e-3 of the slice's rise
      const tableTerm = (k: number) => (COSINE.has(name) ? 1e-3 * rises[k]! : 0);
      centres.forEach((c, k) => expect(Math.abs(c - ref[k]!), name + " slice " + k).toBeLessThanOrEqual(tableTerm(k) + 1e-3));
      expect(s.hottest).toBe(e[1]!.expected.value);
      expect(argmax(ref)).toBe(e[1]!.expected.value);
      expect(Math.abs(Math.min(...centres) - e[2]!.expected.value)).toBeLessThanOrEqual(1e-3 + tableTerm(centres.indexOf(Math.min(...centres))));
      // the three terms, from FEED's own numbers
      const est = axialConductionEstimate(n)!;
      const peakRise = Math.max(...rises);
      const terms = (k: number) => (5 * centresFuelRise(n, k)) / (100 * 100) + 3 * est.fraction * peakRise + tableTerm(k);
      const hot = s.hottest;
      const cold = centres.indexOf(Math.min(...centres));
      const up = (x: number) => Math.max(0.05, Math.ceil(x / 0.05 - 1e-6) * 0.05);
      // the three terms the entry states in its own text are FEED's within 2 %, and its tolerance is their sum rounded UP to 0.05 K
      for (const [x, k] of [[e[0]!, hot], [e[2]!, cold]] as const) {
        const text: string = x.source.text;
        const mesh = Number(/100\^2 = ([\d.]+) K/.exec(text)![1]);
        const allow = Number(/above its coolant\) = ([\d.]+) K/.exec(text)![1]);
        const table = COSINE.has(name) ? Number(/rise of [\d.]+ K = ([\d.]+) K; rounded/.exec(text)![1]) : 0;
        expect(Math.abs(mesh - (5 * centresFuelRise(n, k)) / 1e4), x.oracleId + " mesh").toBeLessThan(0.02 * mesh + 0.002);
        expect(Math.abs(allow - 3 * est.fraction * peakRise), x.oracleId + " allowance").toBeLessThan(0.02 * allow + 0.002);
        expect(Math.abs(table - tableTerm(k)), x.oracleId + " table").toBeLessThan(0.02 * table + 0.002);
        const sum = mesh + allow + table;
        expect(x.tolerance.abs, x.oracleId + " sum " + sum).toBeGreaterThanOrEqual(Math.max(0.05, sum) - 0.003);
        expect(x.tolerance.abs, x.oracleId + " sum " + sum).toBeLessThan(Math.max(0.05, sum) + 0.0502);
        expect(Math.abs(x.tolerance.abs / 0.05 - Math.round(x.tolerance.abs / 0.05)), x.oracleId + " a multiple of 0.05").toBeLessThan(1e-9);
      }
      void up;
      // the entry is not looser than the allowance FEED's own check applies (3 estimates of the largest rise) and not by more than the mesh and table terms
      expect(e[0]!.tolerance.abs).toBeGreaterThanOrEqual(3 * est.fraction * peakRise);
      expect(e[0]!.tolerance.abs).toBeLessThan(3 * est.fraction * peakRise + 2);
      // the hottest slice leads the next by more than twice the largest tolerance: the index cannot flip inside the tolerances
      const sorted = [...centres].sort((a, b) => b - a);
      expect(sorted[0]! - sorted[1]!).toBeGreaterThan(2 * Math.max(e[0]!.tolerance.abs, e[2]!.tolerance.abs));
    });
  }
  it("the entries test what they claim: a stack read from the top, a flat coolant instead of the warming one, and a flat shape each move the answer by many tolerances", () => {
    // the skewed shape reversed: the hottest slice is index 6, not 3, and the coolest is the bottom one
    const c = caseNamed("stack-skewed-pin");
    const pts = c.axial.powerShape.points;
    const flipped = JSON.parse(JSON.stringify(c));
    flipped.axial.powerShape.points = pts.map((p: any, i: number) => ({ position: p.position, relativePower: pts[pts.length - 1 - i].relativePower }));
    const sFlip = axialSummary(norm(flipped))!;
    expect(sFlip.hottest).toBe(6);
    expect(sFlip.hottest).not.toBe(entry("feed-stack-skewed-pin-axial-hottest-slice").expected.value);
    // the coolest slice is the top one in the entry's stack and the bottom one when it is read from the top (the values are the same set, mirrored, so the index is what tells them apart)
    const lowest = (x: { slices: { centreT: number }[] }) => x.slices.map((y) => y.centreT).indexOf(Math.min(...x.slices.map((y) => y.centreT)));
    expect(lowest(sFlip)).toBe(0);
    expect(lowest(axialSummary(norm(c))!)).toBe(9);
    // the warming coolant held at its bottom value: the hottest slice is the middle one and the peak is far from the entry's
    const w = caseNamed("stack-warming-coolant-pin");
    delete w.axial.boundary;
    const sw = axialSummary(norm(w))!;
    expect(sw.hottest).toBe(4);
    expect(Math.abs(sw.slices[4]!.centreT - entry("feed-stack-warming-coolant-pin-temperature-peak").expected.value)).toBeGreaterThan(5 * entry("feed-stack-warming-coolant-pin-temperature-peak").tolerance.abs);
    // the warming table read from the top (warm at the bottom, cool at the top) puts the hottest slice below the middle
    const r = caseNamed("stack-warming-coolant-pin");
    r.axial.boundary = [{ ...r.axial.boundary[0], bulkTemperature: { value: 873, unit: "K" } }, { ...r.axial.boundary[1], bulkTemperature: { value: 573, unit: "K" } }];
    expect(axialSummary(norm(r))!.hottest).toBeLessThan(4);
  });
});

/** The fuel's centre-to-surface rise of slice k by FEED's closed form: what the mesh term 5 dT / N^2 is taken of. */
function centresFuelRise(n: ReturnType<typeof norm>, k: number): number {
  const s = axialSummary(n)!.slices[k]!;
  return s.centreT - s.fuelSurfaceT;
}

// ---- the transient entries
/** The lumped slice by hand: steady start, then (for the plate) a film that falls linearly between two times; after the ramp the exact exponential. Midpoint steps of 0.1 ms on the ramp. */
function lumpedHand(opts: { C: number; A: number; q: number; Tb: number; h0: number; h1: number; t0: number; t1: number; tEnd: number }): { T0: number; T: number } {
  const { C, A, q, Tb, h0, h1, t0, t1, tEnd } = opts;
  const T0 = Tb + q / (h0 * A);
  let T = T0;
  const h = (t: number) => h0 + ((h1 - h0) * (t - t0)) / (t1 - t0);
  const dt = 1e-4;
  const f = (t: number, x: number) => (q - h(t) * A * (x - Tb)) / C;
  for (let t = t0; t < t1 - 1e-12; t += dt) T += dt * f(t + dt / 2, T + (dt / 2) * f(t, T));
  const Tinf = Tb + q / (h1 * A);
  const tau = C / (h1 * A);
  return { T0, T: Tinf + (T - Tinf) * Math.exp(-(tEnd - t1) / tau) };
}
describe("the transient stack entries", () => {
  const plate = entry("feed-stack-lumped-plate-loss-of-cooling-temperature-peak-max");
  const pin = entry("feed-stack-lumped-pin-coastdown-temperature-peak-max");
  it("the lumped plate by hand: C = 3 MJ/m3/K x (4.1 + 0.57) mm, the middle slice 50 kW/m x pi/2, steady at 3000 W/m2/K, the film falls to 100 between 2 and 3 s, 40 s: 801.92 K", () => {
    const x = lumpedHand({ C: 3e6 * (4.1e-3 + 0.57e-3), A: 1, q: 50000 * (Math.PI / 2) * Math.cos(Math.PI * (4.5 / 10 - 0.5)), Tb: 600, h0: 3000, h1: 100, t0: 2, t1: 3, tEnd: 40 });
    expect(x.T0).toBeCloseTo(625.858, 2);
    expect(x.T).toBeCloseTo(801.919, 2);
    expect(Math.abs(x.T - plate.expected.value)).toBeLessThan(2e-3);
  });
  it("the lumped pin by hand: C = 3 MJ/m3/K x pi (4.1^2 + 4.75^2 - 4.18^2) mm2, A = 2 pi 4.75 mm, 1 kW/m on average, the film decays from 3000 to 300 between 5 and 15 s, 40 s: 728.41 K", () => {
    const Rf = 4.1e-3, Rci = 4.18e-3, Rco = 4.75e-3;
    const x = lumpedHand({ C: 3e6 * Math.PI * (Rf * Rf + Rco * Rco - Rci * Rci), A: 2 * Math.PI * Rco, q: 1000 * (Math.PI / 2) * Math.cos(Math.PI * (4.5 / 10 - 0.5)), Tb: 600, h0: 3000, h1: 300, t0: 5, t1: 15, tEnd: 40 });
    expect(x.T0).toBeCloseTo(617.328, 2);
    expect(x.T).toBeCloseTo(728.414, 2);
    expect(Math.abs(x.T - pin.expected.value)).toBeLessThan(2e-3);
  });
  it("the exchange number of both is 0.133 (the rate 0.00333 per second times 40 s), far below the limit of 1 above which FEED does not count its bound", () => {
    // k / (c h^2) with k = 400 W/m/K, c = 3 MJ/m3/K and the slice height 2 m / 10 = 0.2 m
    const rate = 400 / (3e6 * 0.2 * 0.2);
    expect(rate).toBeCloseTo(0.0033333, 6);
    expect(rate * 40).toBeLessThan(0.14);
    for (const name of TRANSIENT) {
      const n = norm(caseNamed(name));
      const sol = computeIndependentStack(n);
      const ex = exchangeAllowances(n, sol, sliceLoads(n))!;
      expect(ex.number, name).toBeCloseTo(rate * 40, 3);
    }
  });
  for (const [name, e] of [["stack-lumped-plate-loss-of-cooling", plate], ["stack-lumped-pin-coastdown", pin]] as const) {
    it(name + ": FEED's independent finite-volume solution of every slice has its largest peak inside the entry's tolerance, the tolerance is not tighter than FEED's own exchange allowance, and with the first boundary held the answer is far away", () => {
      const d = caseOf(e);
      const n = norm(d);
      const sol = computeIndependentStack(n);
      const peaks = sol.map((s) => Math.max(...s.fv.states.map((st) => Math.max(...st.T))));
      const peak = Math.max(...peaks);
      expect(Math.abs(peak - e.expected.value), name + " " + peak).toBeLessThanOrEqual(e.tolerance.abs);
      const hot = argmax(peaks);
      expect([4, 5]).toContain(hot);
      const ex = exchangeAllowances(n, sol, sliceLoads(n))!;
      // FEED applies this allowance (twice its bound) to the cross-check of the slice; the entry's tolerance contains it, plus 1 % of the rise and the internal rise
      // the tolerance is 1 % of the rise, FEED's own exchange allowance of the slice (twice its bound) and the internal rise of the hottest cell above the lumped mean, worked out here
      // by hand at the middle slice's heat rate (pi/2 cos(0.05 pi) of the average), rounded up to 0.05 K
      const qMid = (name.includes("plate") ? 50000 : 1000) * (Math.PI / 2) * Math.cos(0.05 * Math.PI);
      const internal = name.includes("plate") ? qMid * (4.1e-3 / (2 * 400) + 1 / 1e6 + 0.57e-3 / 400) : qMid * (1 / (4 * Math.PI * 400) + 1 / (2 * Math.PI * 4.1e-3 * 1e6) + Math.log(4.75 / 4.18) / (2 * Math.PI * 400));
      const start = Math.max(...sol[hot]!.fv.states[0]!.T);
      const sum = 0.01 * (peak - start) + ex.field[hot]! + internal;
      expect(e.tolerance.abs, name + " sum " + sum).toBeGreaterThanOrEqual(sum - 0.01);
      expect(e.tolerance.abs, name + " sum " + sum).toBeLessThanOrEqual(sum + 0.07);
      const held = JSON.parse(JSON.stringify(d));
      held.transient.boundaryHistory = held.transient.boundaryHistory.map((p: any) => ({ ...p, heatTransferCoefficient: held.transient.boundaryHistory[0].heatTransferCoefficient }));
      const hp = Math.max(...computeIndependentStack(norm(held)).map((s) => Math.max(...s.fv.states.map((st) => Math.max(...st.T)))));
      expect(Math.abs(hp - e.expected.value), name + " held " + hp).toBeGreaterThan(5 * e.tolerance.abs);
    });
  }
});

// ---- saved real output, read back without the solver
const readGolden = (name: string) => {
  const d = join(golden, name);
  const n = JSON.parse(readFileSync(join(d, "normalized.json"), "utf8"));
  const C = readFileSync(join(d, "C"), "utf8");
  const times = existsSync(join(d, "times")) ? readdirSync(join(d, "times")).sort((a, b) => Number(a) - Number(b)) : [];
  return { n, C, T: existsSync(join(d, "T")) ? readFileSync(join(d, "T"), "utf8") : "", fields: times.map((t) => ({ time: Number(t), T: readFileSync(join(d, "times", t, "T"), "utf8") })) };
};
const failingIds = (r: { checks: { id: string; verdict: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id);
const inside = (e: any, got: number) => expect(Math.abs(got - e.expected.value), e.oracleId + " got " + got + " expected " + e.expected.value).toBeLessThanOrEqual(Math.max(e.tolerance.abs, e.tolerance.rel * Math.abs(e.expected.value)));

/** What each quantity is read as in a stack's record (the readings docs/seed-stack-request.md gives SEED). */
function steadyQuantities(r: StackRecord) {
  const ft = r.fuelTemperature!.scalars;
  return {
    temperature_peak: r.summary.maxT,
    axial_hottest_slice: r.axial.hottest,
    temperature_peak_slice_min: Math.min(...r.axial.slices.map((s) => s.maxT)),
    // the fuel temperature by slice (src/core/fuelTemperature.ts): the largest and the smallest slice mean and the mean over all slices
    temperature_fuel_mean_slice_max: ft.temperature_fuel_mean_slice_max.value,
    temperature_fuel_mean_slice_min: ft.temperature_fuel_mean_slice_min.value,
    temperature_fuel_mean: ft.temperature_fuel_mean.value,
  } as Record<string, number>;
}
const SAVED = existsSync(join(golden, "stack-cosine-pin", "normalized.json"));
describe.skipIf(!SAVED)("saved real OFFBEAT output of the stack entries, read back: every check passes and every quantity is inside its tolerance", () => {
  for (const name of STEADY) {
    it(name, () => {
      const x = readGolden(name);
      const r = buildStackResults(x.n, { T: x.T, C: x.C, time: 5e7 });
      expect(failingIds(r)).toEqual([]);
      const q = steadyQuantities(r);
      for (const e of entries.filter((z) => z.oracleId.startsWith("feed-" + name + "-"))) inside(e, q[e.expected.quantity]!);
      expect(r.axial.slices).toHaveLength(x.n.axial.slices);
    });
  }
  it("the transferred one-slice pin: every check passes and the saved solver output's volume-mean fuel temperature is inside the entry's tolerance (the slice's position is the transfer's)", () => {
    const x = readGolden("fuel-mean-transferred-pin");
    const r = buildResults(x.n, { T: x.T, C: x.C, time: 5e7, drift: { relativeRate: 1e-12 } });
    expect(failingIds(r)).toEqual([]);
    inside(entry("feed-fuel-mean-transferred-pin-temperature-fuel-mean"), r.fuelTemperature!.scalars.temperature_fuel_mean.value);
    expect(r.fuelTemperature!.slices[0]).toMatchObject({ zMin: 0.25, zMax: 0.5 });
  });
  it("the plate alone (mesh 100/20): every check passes, the centre and the face are inside the tolerances", () => {
    const x = readGolden("plate-steady");
    const r = buildResults(x.n, { T: x.T, C: x.C, time: 5e7, drift: { relativeRate: 1e-12 } });
    expect(failingIds(r)).toEqual([]);
    inside(entry("feed-plate-steady-temperature-peak"), r.summary.maxT);
    inside(entry("feed-plate-steady-temperature-surface"), r.summary.claddingOuterWallT!);
  });
  for (const [name, id] of [["stack-lumped-plate-loss-of-cooling", "feed-stack-lumped-plate-loss-of-cooling-temperature-peak-max"], ["stack-lumped-pin-coastdown", "feed-stack-lumped-pin-coastdown-temperature-peak-max"]] as const) {
    it(name, () => {
      const x = readGolden(name);
      const r = buildStackTransientResults(x.n, { C: x.C, fields: x.fields }, computeIndependentStack(x.n)) as StackTransientRecord;
      expect(failingIds(r)).toEqual([]);
      inside(entry(id), Math.max(...r.axial.slices.map((s) => s.maxT)));
      expect(r.axial.slices[r.axial.hottest]!.maxT).toBe(r.summary.maxT);
    });
  }
  it("read against a stack that was not run, the saved output fails a check and misses the entry (the shape read from the top; the coolant not warming)", () => {
    const x = readGolden("stack-skewed-pin");
    const n = JSON.parse(JSON.stringify(x.n));
    n.axial.shape.relative = [...n.axial.shape.relative].reverse();
    expect(failingIds(buildStackResults(n, { T: x.T, C: x.C, time: 5e7 })).length).toBeGreaterThan(0);
    const y = readGolden("stack-warming-coolant-pin");
    const m = JSON.parse(JSON.stringify(y.n));
    m.axial.boundary.bulkTemperature = m.axial.boundary.bulkTemperature.map(() => 573);
    expect(failingIds(buildStackResults(m, { T: y.T, C: y.C, time: 5e7 })).length).toBeGreaterThan(0);
  });
});

// ---- the real solver
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();
const SAVE = process.env.FEED_SAVE_GOLDEN === "1";
async function run(name: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-seedstack-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 580_000 });
  const s = mgr.start(caseNamed(name));
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const runDir = join(runsRoot, s.id);
  const native = join(runDir, "native");
  const normalized = JSON.parse(readFileSync(join(runDir, "normalized.json"), "utf8"));
  if (SAVE) {
    const save = join(golden, name);
    mkdirSync(save, { recursive: true });
    writeFileSync(join(save, "C"), readFileSync(join(native, "final", "C")));
    copyFileSync(join(runDir, "normalized.json"), join(save, "normalized.json"));
    if (normalized.transient) {
      const tdir = join(native, "times");
      for (const n of readdirSync(tdir).filter((z) => /^[0-9.eE+-]+$/.test(z))) {
        mkdirSync(join(save, "times", n), { recursive: true });
        writeFileSync(join(save, "times", n, "T"), readFileSync(join(tdir, n, "T")));
      }
    } else writeFileSync(join(save, "T"), readFileSync(join(native, "final", "T")));
  }
  return mgr.results(s.id) as unknown as StackRecord & StackTransientRecord;
}
const failing = (r: { checks: { id: string; verdict: string; value: number | null; note: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 200));

describe.skipIf(!solverOn)("the stack and plate entries against the real solver (needs FEED_SOLVER=1)", () => {
  for (const name of STEADY) {
    it(name + ": every check passes and the solver's peak, the index of its hottest slice and its coolest slice peak are inside the entries' tolerances", async () => {
      const r = await run(name);
      expect(failing(r)).toEqual([]);
      const q = steadyQuantities(r);
      for (const e of entries.filter((z) => z.oracleId.startsWith("feed-" + name + "-"))) inside(e, q[e.expected.quantity]!);
      // every slice's hottest cell against the hand reference, for the record
      const widest = Math.max(...entries.filter((z) => z.oracleId.startsWith("feed-" + name + "-") && z.expected.unit === "K").map((z) => z.tolerance.abs));
      r.axial.slices.forEach((s, k) => expect(Math.abs(s.maxT - REF[name]![k]!), name + " slice " + k).toBeLessThanOrEqual(widest));
    }, 600_000);
  }
  it("fuel-mean-transferred-pin: every check passes and the solver's volume-mean fuel temperature of its one slice is inside the entry's tolerance, with the slice's position in the record", async () => {
    const r = await run("fuel-mean-transferred-pin");
    expect(failing(r)).toEqual([]);
    inside(entry("feed-fuel-mean-transferred-pin-temperature-fuel-mean"), r.fuelTemperature!.scalars.temperature_fuel_mean.value);
    expect(r.fuelTemperature!.slices[0]).toMatchObject({ zMin: 0.25, zMax: 0.5 });
  }, 600_000);
  it("plate-steady: every check passes and the centre and the face are inside the tolerances", async () => {
    const r = await run("plate-steady");
    expect(failing(r)).toEqual([]);
    inside(entry("feed-plate-steady-temperature-peak"), r.summary.maxT);
    inside(entry("feed-plate-steady-temperature-surface"), r.summary.claddingOuterWallT!);
  }, 600_000);
  for (const [name, id] of [["stack-lumped-plate-loss-of-cooling", "feed-stack-lumped-plate-loss-of-cooling-temperature-peak-max"], ["stack-lumped-pin-coastdown", "feed-stack-lumped-pin-coastdown-temperature-peak-max"]] as const) {
    it(name + ": every check passes and the largest peak of the run is inside the entry's tolerance", async () => {
      const r = await run(name);
      expect(failing(r)).toEqual([]);
      inside(entry(id), Math.max(...r.axial.slices.map((s) => s.maxT)));
      inside(entry(id), Math.max(...r.series.peakT));
    }, 600_000);
  }
});
