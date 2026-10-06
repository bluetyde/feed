// The upstream baseline (F0 exit review, finding 8; plan 01: "the reproduced upstream example matches its published or saved expected
// output within a recorded tolerance"). Saved evidence only, so it runs without the solver; scripts/make-upstream-baseline.cjs makes it.
//   - OFFBEAT's generic_pwr_1D example, run on the pinned stack: deterministic, and its temperature and burnup probe against the
//     published curve (Figure 4 of OFFBEAT's LWR 1D tutorial, digitized);
//   - OFFBEAT's own verification cases heatConservation and testUserParameters against what upstream recorded and expects.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const json = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const baseline = json("solver/results/upstream-baseline.json");
const fig = json("docs/sources/offbeat-lwr1d-tutorial-fig4.json");
const pins = Object.fromEntries(
  readFileSync(join(root, "solver/pins.env"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const PX_PER_DAY = 0.87; // the figure's calibration (docs/sources/offbeat-lwr1d-tutorial-fig4.json)
const K_PER_PX = fig.resolution.kelvinPerPixel as number;
const MWD_PER_PX = fig.resolution.mwdPerKgPerPixel as number;
type Pt = [number, number];
const days = (series: Pt[]) => series.map((p) => [p[0] / 86400, p[1]] as Pt);
const interp = (xs: number[], ys: number[], x: number) => {
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]!) return ys[i - 1]! + ((ys[i]! - ys[i - 1]!) * (x - xs[i - 1]!)) / (xs[i]! - xs[i - 1]!);
  return ys[ys.length - 1]!;
};
/**
 * Largest distance of a digitized point from our curve, allowing the curve to move +-pxX pixels in time: the point may be anywhere between
 * the lowest and highest value our curve takes in that window, and the distance is how far it lies outside.
 */
function worstGap(digitized: Pt[], ours: Pt[], pxX: number): number {
  const xs = ours.map((p) => p[0]);
  const ys = ours.map((p) => p[1]);
  let worst = 0;
  for (const [d, v] of digitized) {
    const lo = d - pxX / PX_PER_DAY;
    const hi = d + pxX / PX_PER_DAY;
    const grid = [...Array.from({ length: 41 }, (_, i) => lo + ((hi - lo) * i) / 40), ...xs.filter((x) => x >= lo && x <= hi)];
    const vals = grid.map((x) => interp(xs, ys, x));
    const gap = Math.max(0, Math.min(...vals) - v, v - Math.max(...vals));
    if (gap > worst) worst = gap;
  }
  return worst;
}
const oursT = days(baseline.example.probe.temperatureK);
const oursBu = days(baseline.example.probe.burnupMWdPerTonne).map((p) => [p[0], p[1] / 1000] as Pt);

describe("provenance and determinism of the saved baseline", () => {
  it("was made on the pinned OFFBEAT commit and OpenFOAM package, and the figure is from the same repository and commit", () => {
    expect(baseline.pins.offbeatCommit).toBe(pins.OFFBEAT_COMMIT);
    expect(baseline.pins.openfoamPackage).toBe(pins.OPENFOAM_PACKAGE + " " + pins.OPENFOAM_VERSION);
    expect(fig.source.commit).toBe(pins.OFFBEAT_COMMIT);
    expect(fig.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two independent runs of the example were byte-identical in the final fields and both probe files (compare-runs.sh exited 0)", () => {
    const d = baseline.example.determinism;
    expect(d.compareExit).toBe(0);
    expect(d.files).toEqual(["31500000/T", "31500000/Bu", "31500000/D", "postProcessing/probes/0/T", "postProcessing/probes/0/Bu"]);
    expect(d.compareOutput).toEqual(d.files.map((f: string) => "identical: " + f));
    expect(baseline.example.runs).toHaveLength(2);
    for (const r of baseline.example.runs) expect(r.offbeatExit).toBe(139); // the known shutdown crash after the last write
  });

  it("the hashes that make a rebuild checkable are all there: 22 input files and the 5 output files", () => {
    expect(Object.keys(baseline.example.inputSha256)).toHaveLength(22);
    expect(Object.keys(baseline.example.inputSha256)).toEqual(expect.arrayContaining(["rodDict", "constant/solverDict", "system/controlDict", "system/blockMeshDict"]));
    expect(Object.keys(baseline.example.outputSha256).sort()).toEqual([...baseline.example.determinism.files].sort());
    for (const h of [...Object.values(baseline.example.inputSha256), ...Object.values(baseline.example.outputSha256)]) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the run is the 122-step, 3.15e7 s example, with the probe at (0 0 1.5), starting at 300 K and 0 burnup", () => {
    const e = baseline.example;
    expect(e.steps).toBe(122);
    expect(e.timeDirs).toEqual(["0", "25547802.486828219146", "31500000"]);
    expect(e.probe.point).toBe("(0 0 1.5)");
    expect(e.probe.temperatureK).toHaveLength(123);
    expect(e.probe.burnupMWdPerTonne).toHaveLength(123);
    expect(e.probe.temperatureK[0]).toEqual([0, 300]);
    expect(e.probe.burnupMWdPerTonne[0]).toEqual([0, 0]);
    const t = e.probe.temperatureK.map((p: Pt) => p[0]);
    expect(t.every((x: number, i: number) => i === 0 || x > t[i - 1])).toBe(true);
    expect(e.summary.finalTimeS).toBe(31500000);
  });

  it("the summary agrees with the series", () => {
    const e = baseline.example;
    expect(e.summary.peakK).toBe(Math.max(...e.probe.temperatureK.map((p: Pt) => p[1])));
    expect(e.summary.finalK).toBe(e.probe.temperatureK.at(-1)[1]);
    expect(e.summary.finalBurnupMWdPerKg).toBeCloseTo(e.probe.burnupMWdPerTonne.at(-1)[1] / 1000, 9);
  });
});

describe("against the published curve (Figure 4 of OFFBEAT's LWR 1D tutorial)", () => {
  it("the digitized figure is what it says: ordered, in range, from the right place", () => {
    expect(fig.temperature.points.length).toBeGreaterThan(300);
    expect(fig.burnup.points.length).toBeGreaterThan(200);
    const t = fig.temperature.points.map((p: Pt) => p[0]);
    expect(t.every((x: number, i: number) => i === 0 || x > t[i - 1])).toBe(true);
    for (const [, k] of fig.temperature.points) expect(k).toBeGreaterThan(950);
    for (const [, k] of fig.temperature.points) expect(k).toBeLessThan(1200);
    expect(fig.resolution).toMatchObject({ daysPerPixel: 1.149, kelvinPerPixel: 2.857 });
  });

  it("TEMPERATURE: every digitized point lies within +-2 pixels (5.7 K, 2.3 days) of our probe curve, and in fact within 2.5 K when the time shift is allowed", () => {
    const tolerance = 2 * K_PER_PX;
    expect(worstGap(fig.temperature.points, oursT, 2)).toBeLessThanOrEqual(tolerance);
    expect(worstGap(fig.temperature.points, oursT, 2)).toBeLessThan(2.5); // observed 2.2 K: a regression threshold, tighter than the stated tolerance
    expect(worstGap(fig.temperature.points, oursT, 0)).toBeLessThan(3.5); // with no time shift at all: about one pixel (3.0 K observed, at the steep start; 2.8 K elsewhere)
  });

  it("BURNUP: every digitized point lies within +-2 pixels (0.055 MWd/kg, 2.3 days) of our probe curve, and in fact within 0.02", () => {
    expect(worstGap(fig.burnup.points, oursBu, 2)).toBeLessThanOrEqual(2 * MWD_PER_PX);
    expect(worstGap(fig.burnup.points, oursBu, 2)).toBeLessThan(0.02);
  });

  it("the peak (first columns of the figure) and the end of the curve agree", () => {
    const peak = fig.temperature.points.reduce((a: Pt, b: Pt) => (b[1] > a[1] ? b : a));
    expect(Math.abs(peak[1] - baseline.example.summary.peakK)).toBeLessThan(2 * K_PER_PX);
    const last = fig.temperature.points.at(-1) as Pt;
    expect(Math.abs(last[1] - baseline.example.summary.finalK)).toBeLessThan(2 * K_PER_PX);
    expect(Math.abs(last[0] - baseline.example.summary.finalTimeS / 86400)).toBeLessThan(2 / PX_PER_DAY);
  });

  describe("the comparison has teeth: a wrong result is not accepted", () => {
    const shifted = (series: Pt[], f: (p: Pt) => Pt) => series.map(f);
    it("10 K too hot (a wrong conductivity or power) fails", () => {
      expect(worstGap(fig.temperature.points, shifted(oursT, (p) => [p[0], p[1] + 10]), 2)).toBeGreaterThan(2 * K_PER_PX);
    });
    it("a 3% error in burnup (a wrong power or burnup model) fails", () => {
      expect(worstGap(fig.burnup.points, shifted(oursBu, (p) => [p[0], p[1] * 1.03]), 2)).toBeGreaterThan(2 * MWD_PER_PX);
    });
    it("a power history stretched 10% in time fails", () => {
      expect(worstGap(fig.temperature.points, shifted(oursT, (p) => [p[0] * 1.1, p[1]]), 2)).toBeGreaterThan(2 * K_PER_PX);
    });
    it("burnup plotted as temperature, and the curves swapped, fail", () => {
      expect(worstGap(fig.temperature.points, oursBu, 2)).toBeGreaterThan(100);
      expect(worstGap(fig.burnup.points, oursT, 2)).toBeGreaterThan(100);
    });
  });
});

describe("against OFFBEAT's own verification cases, run with their own Allrun", () => {
  const v = baseline.verification;
  const recorded = (lines: string[], re: RegExp) => Number(re.exec(lines.join("\n"))![1]);

  it("heatConservation: the heat out of the fuel and into the cladding equals what OFFBEAT recorded, and the 300 W produced, within 0.1%", () => {
    const h = v.heatConservation;
    expect(h.ours.fuelOuterW).toBe(recorded(h.upstreamRecorded, /fuelOuter patch: ([0-9.eE+-]+) W/));
    expect(h.ours.cladInnerW).toBe(recorded(h.upstreamRecorded, /cladInner patch: ([0-9.eE+-]+) W/));
    expect(h.ours.expectedW).toBe(300);
    for (const w of [h.ours.fuelOuterW, h.ours.cladInnerW]) expect(Math.abs(w - 300) / 300).toBeLessThan(1e-3);
    expect(h.oursRaw).toEqual(h.upstreamRecorded); // every line identical, relative errors included
  });

  it("testUserParameters: the probe temperature equals what OFFBEAT recorded to the printed digits, and passes upstream's own rule (relative error under 0.5% of 1040.01 K)", () => {
    const u = v.testUserParameters;
    expect(u.ours.probeTemperatureK).toBe(recorded(u.upstreamRecorded, /1.25 : ([0-9.eE+-]+) K/));
    expect(u.ours.expectedK).toBe(1040.01);
    expect(Math.abs(u.ours.probeTemperatureK - u.ours.expectedK) / u.ours.expectedK).toBeLessThan(0.005);
    expect(u.ours.relativeError).toBeCloseTo(recorded(u.upstreamRecorded, /Relative error: ([-0-9.eE+]+)/), 15);
    expect(u.oursRaw).toEqual(u.upstreamRecorded);
    expect(u.oursRaw.at(-1)).toBe("Test passed");
  });

  it("the record being compared with is OFFBEAT's, dated 11 September 2025: older than the pinned commit (5 January 2026), so equality is evidence, not a tautology", () => {
    expect(v.upstreamResultsFile.path).toBe("Cases/Verification/results");
    expect(v.upstreamResultsFile.date).toMatch(/Sep 11 .* 2025/);
    expect(new Date(baseline.pins.offbeatCommitDate).getTime()).toBeGreaterThan(Date.UTC(2025, 8, 11));
    expect(v.upstreamResultsFile.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the tolerances were stated before the comparison and are recorded with the baseline", () => {
    const t = baseline.tolerances;
    expect(t.sameStack).toMatch(/byte-identical/);
    expect(t.otherStack).toMatch(/0\.01 K/);
    expect(t.publishedFigure).toMatch(/2 pixel/);
    expect(t.upstreamCriteria).toMatch(/0\.5%/);
  });
});
