// Plan 12 A5 through the real solver (needs FEED_SOLVER=1): a stack of plates written by FEED's writer (a Cartesian mesh with N layers along the height), run by the run manager,
// read back layer by layer and judged slice by slice against the slab closed forms (steady) and the slab finite-volume solution (transient). Every check must pass on the real
// OFFBEAT output; a control shows N equal slices equal one slice; the axial conduction estimate is calibrated against the stack's own difference from the one-dimensional closed
// form at three lengths; and the checks are shown to FAIL when the output is judged against a stack that was not the one that was run.
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { axialConductionEstimate, sliceLoads } from "../src/core/axial";
import { compositeSlab } from "../src/core/closedForm";
import { lawOf } from "../src/core/conductivity";
import { RunManager } from "../src/core/runManager";
import { StackRecord, buildStackResults } from "../src/core/stackResults";
import { StackTransientRecord, buildStackTransientResults, computeIndependentStack } from "../src/core/stackTransientResults";
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
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "offbeat-plate-stack") : undefined;

/** A heat rate of 200 kW per metre of height and width on average: a face flux of 0.2 MW/m2 (a plate reactor's order), 296 K from the coolant to the centre at the peak of the cosine. */
const AVG = 200000;
/** The synthetic pin's numbers as a plate (half-thickness 4.1 mm, gap 0.08 mm, cladding 0.57 mm; k 3 and 15 W/m/K; film 30000; gap 5000; coolant 573 K) with an axial section. */
function plateStack(axial: unknown, avg = AVG) {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
  d.caseId = "synthetic-plate-stack";
  d.assumptions.geometry = "1D-slab";
  d.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
  d.power.linearHeatRate = q(avg, "W/m");
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  d.axial = axial;
  return d;
}
/** A transient plate case from one of the pin examples (the same numbers as thicknesses), with an axial section. */
function plateTransient(base: string, axial: unknown) {
  const d = JSON.parse(readFileSync(join(root, "examples", base + ".json"), "utf8"));
  d.caseId = "synthetic-plate-stack-" + base;
  d.assumptions.geometry = "1D-slab";
  d.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  d.axial = axial;
  return d;
}
const cosine = (L: number, N = 10) => ({ length: q(L, "m"), slices: N, powerShape: { kind: "cosine" } });
const bt = (z: number, Tb: number, h: number) => ({ height: q(z, "m"), bulkTemperature: q(Tb, "K"), heatTransferCoefficient: q(h, "W/m2/K") });
const table = (rows: number[][]) => ({ kind: "table", points: rows.map(([z, r]) => ({ position: q(z!, "m"), relativePower: q(r!, "1") })) });

/** A plate stack that starts at its steady states at 100 kW/m on average and loses its cooling: the film coefficient falls from 30000 to `h2` W/m2/K over 1 s at t = 2 s (the coolant stays at 300 K). */
function lossOfCooling(L: number, N: number, tEnd: number, h2: number, outputs: number) {
  const d = plateTransient("synthetic-pulse", cosine(L, N));
  d.transient = {
    powerHistory: [{ time: q(0, "s"), linearHeatRate: q(100, "kW/m") }, { time: q(tEnd, "s"), linearHeatRate: q(100, "kW/m") }],
    endTime: q(tEnd, "s"), timeStep: q(0.1, "s"), outputs, initialSteadyLinearHeatRate: q(100, "kW/m"),
    boundaryHistory: [
      { time: q(0, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") },
      { time: q(2, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") },
      { time: q(3, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(h2, "W/m2/K") },
      { time: q(tEnd, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(h2, "W/m2/K") },
    ],
  };
  return d;
}
const crossOf = (r: { checks: { id: string; value: number | null; verdict: string }[] }) => r.checks.find((c) => c.id === "crossCheckFv")!;

async function run(d: unknown, save?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-platestack-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 580_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const dir = join(runsRoot, s.id);
  const native = join(dir, "native");
  const normalized = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
  const T = readFileSync(join(native, "final", "T"), "utf8");
  const C = readFileSync(join(native, "final", "C"), "utf8");
  const tdir = join(native, "times");
  const names = normalized.transient ? readdirSync(tdir).filter((n) => /^[0-9.eE+-]+$/.test(n)).sort((a, b) => Number(a) - Number(b)) : [];
  const fields = names.map((n) => ({ time: Number(n), T: readFileSync(join(tdir, n, "T"), "utf8") }));
  if (save) {
    mkdirSync(save, { recursive: true });
    if (!normalized.transient) writeFileSync(join(save, "T"), T);
    writeFileSync(join(save, "C"), C);
    copyFileSync(join(dir, "normalized.json"), join(save, "normalized.json"));
    for (const f of fields) {
      mkdirSync(join(save, "times", String(f.time)), { recursive: true });
      writeFileSync(join(save, "times", String(f.time), "T"), f.T);
    }
  }
  return { res: mgr.results(s.id) as unknown as StackRecord & StackTransientRecord, T, C, fields, normalized };
}
const failing = (r: { checks: { id: string; verdict: string; value: number | null; note: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 200));

/** The slab closed form of a slice written out by hand (constant conductivities): coolant + film q/h + cladding q t / k + gap q/h + meat q L / 2 k. */
const byHand = (q1: number, Tb: number, h: number) => Tb + q1 / h + (q1 * 0.57e-3) / 15 + q1 / 5000 + (q1 * 4.1e-3) / (2 * 3);

/** The stack's slice centres minus the one-dimensional closed form of the slice's own heat rate and coolant: the axial conduction and the mesh, which is 0.01 K here. */
function deviations(res: StackRecord, d: unknown) {
  const n = validateCase(d).normalized!;
  return sliceLoads(n).map((l, k) => {
    const b = l.boundary;
    const closed = compositeSlab({ slab: true, qPrime: l.linearHeatRate, fuelK: lawOf(n.fuelConductivity), fuelRadius: n.fuelRadius, hGap: n.gapConductance, claddingInnerRadius: n.claddingInnerRadius, claddingOuterRadius: n.claddingOuterRadius, claddingK: lawOf(n.claddingConductivity), boundary: b.kind === "convective" ? { kind: "convective", bulkTemperature: b.bulkTemperature, hFilm: b.heatTransferCoefficient } : { kind: "surface-temperature", surfaceTemperature: b.surfaceTemperature } }).centreT;
    return res.axial.slices[k]!.centreCellT - closed;
  });
}

describe.skipIf(!solverOn)("a stack of plates through the real solver, steady (needs FEED_SOLVER=1)", () => {
  it("a cosine plate stack on a flat coolant: every check passes and each slice's centre is its own slab closed form within the allowance", async () => {
    const d = plateStack(cosine(0.381));
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "cosine") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.slices).toHaveLength(10);
    const n = validateCase(d).normalized!;
    sliceLoads(n).forEach((l, k) => {
      // the hand formula (no shared code) and the allowance: the slab's own mesh error is 0.01 K, the rest is the axial conduction the estimate bounds
      expect(Math.abs(res.axial.slices[k]!.centreCellT - byHand(l.linearHeatRate, 573, 30000)), "slice " + k).toBeLessThan(res.axial.allowance.field);
    });
    expect(res.axial.allowance.field).toBeGreaterThan(0);
    expect(Math.abs(res.axial.slices[4]!.centreCellT - res.axial.slices[5]!.centreCellT)).toBeLessThan(1e-3);
    expect(Math.abs(res.axial.slices[0]!.centreCellT - res.axial.slices[9]!.centreCellT)).toBeLessThan(1e-3);
    expect([4, 5]).toContain(res.axial.hottest);
    // the whole plate: the heat the faces carry away is the heat made
    expect(res.checks.find((c) => c.id === "energyBalanceTotal")!.verdict).toBe("pass");
    expect(Math.abs(res.checks.find((c) => c.id === "energyBalanceTotal")!.value!)).toBeLessThan(1e-4);
    expect(res.thermalOnly).toMatch(/through-thickness solution per axial slice/);
  }, 600_000);

  it("a coolant that warms up the plate: the faces follow the table (heights in metres from the bottom), the hottest slice moves up, every check passes", async () => {
    const d = plateStack({ ...cosine(0.381), boundary: [bt(0, 573, 30000), bt(0.381, 673, 30000)] });
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "rise") : undefined);
    expect(failing(res)).toEqual([]);
    // each slice's outer face sits a film drop (q'/h for a plate) above the coolant at its height
    res.axial.slices.forEach((s) => expect(Math.abs(s.claddingOuterWallT! - (573 + 100 * (s.height / 0.381) + s.linearHeatRate / 30000)), "slice " + s.index).toBeLessThan(0.2));
    expect(res.axial.hottest).toBeGreaterThanOrEqual(5);
  }, 600_000);

  it("a prescribed wall that warms up the plate", async () => {
    const d = plateStack({ ...cosine(0.381), boundary: [{ height: q(0, "m"), surfaceTemperature: q(573, "K") }, { height: q(0.381, "m"), surfaceTemperature: q(633, "K") }] });
    delete d.boundary.bulkTemperature;
    delete d.boundary.heatTransferCoefficient;
    d.boundary.surfaceTemperature = q(573, "K");
    const { res } = await run(d);
    expect(failing(res)).toEqual([]);
    res.axial.slices.forEach((s) => expect(Math.abs(s.claddingOuterWallT! - (573 + 60 * (s.height / 0.381))), "slice " + s.index).toBeLessThan(0.1));
  }, 600_000);

  it("a short plate (0.06 m, 12 slices), where the axial conduction is large: the checks pass only because their tolerance includes the estimate of it (the golden output is kept to show that)", async () => {
    const d = plateStack(cosine(0.06, 12));
    const { res, normalized } = await run(d, GOLDEN ? join(GOLDEN, "short") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.conduction!.fraction).toBeGreaterThan(0.02);
    // the measured difference from the one-dimensional closed form is many times what the mesh alone allows
    expect(res.checks.find((c) => c.id === "closedFormFuel")!.value!).toBeGreaterThan(5);
    expect(Math.max(...deviations(res, d).map(Math.abs))).toBeLessThan(res.axial.allowance.field);
    expect(normalized.plate).toBe(true);
  }, 600_000);

  it("a ramp shape (a table from 0.6 to 1.4 of the average, no curvature): the end slices are within the allowance (golden output kept)", async () => {
    const d = plateStack({ length: q(0.381, "m"), slices: 10, powerShape: table([[0, 0.6], [0.381, 1.4]]) });
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "ramp") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.hottest).toBe(9);
  }, 600_000);

  it("a table with steep ends (0.3 of the maximum at both ends, 1.0 from a tenth of the length in; 20 slices): the end slices differ from their closed forms by 1.9 K and the allowance is 6.0 K (golden output kept)", async () => {
    const d = plateStack({ length: q(0.381, "m"), slices: 20, powerShape: table([[0, 0.3], [0.038, 1.0], [0.343, 1.0], [0.381, 0.3]]) });
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "steep") : undefined);
    expect(failing(res)).toEqual([]);
    const dev = deviations(res, d);
    // the end slices are warmed and the next ones cooled (the step in the shape drives the heat), and the allowance is more than twice the largest change
    expect(dev[0]!).toBeGreaterThan(1);
    expect(dev[1]!).toBeLessThan(-0.5);
    expect(res.axial.allowance.field).toBeGreaterThan(2 * Math.max(...dev.map(Math.abs)));
  }, 600_000);

  it("a control: five equal slices (a flat shape and a flat coolant) give every slice the temperatures of the one-slice plate at the same heat rate", async () => {
    const a = await run(plateStack({ length: q(0.5, "m"), slices: 5, powerShape: { kind: "flat" } }));
    expect(failing(a.res)).toEqual([]);
    const single = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
    single.assumptions.geometry = "1D-slab";
    single.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
    single.mesh = { fuelCells: 20, claddingCells: 6 };
    single.power.linearHeatRate = q(AVG, "W/m");
    const one = await run(single);
    expect(failing(one.res)).toEqual([]);
    const centre = (one.res as unknown as { summary: { centreCellT: number } }).summary.centreCellT;
    expect(Math.abs(centre - byHand(AVG, 573, 30000))).toBeLessThan(0.05);
    for (const s of a.res.axial.slices) expect(Math.abs(s.centreCellT - centre), "slice " + s.index).toBeLessThan(1e-3);
  }, 900_000);

  it("the axial conduction estimate against the stack's own difference from the closed form at three lengths: it covers the peak slice's change twice over, the end slice's change within the allowance (3 times the estimate), and the change goes as 1/L^2", async () => {
    const dev: Record<number, number[]> = {};
    for (const L of [0.19, 0.381, 0.762]) {
      const d = plateStack(cosine(L));
      const { res } = await run(d, GOLDEN ? join(GOLDEN, "len" + L) : undefined);
      expect(failing(res), "L = " + L).toEqual([]);
      dev[L] = deviations(res, d);
      const est = axialConductionEstimate(validateCase(d).normalized!)!;
      const rise = res.axial.slices[5]!.centreCellT - 573;
      const peakChange = Math.abs(dev[L]![5]!);
      const endChange = Math.abs(dev[L]![0]!);
      // measured: the peak layer cools by about half the estimate, the end layer warms by about one and a half times it
      expect(est.fraction * rise, "peak, L = " + L).toBeGreaterThan(peakChange);
      expect(est.fraction * rise, "peak, not absurdly loose, L = " + L).toBeLessThan(3 * peakChange);
      expect(3 * est.fraction * rise, "end, L = " + L).toBeGreaterThan(endChange);
      expect(est.fraction * rise, "end, L = " + L).toBeGreaterThan(0.4 * endChange);
      // the peak layer is the one that is cooled, the end layer the one that is warmed (the sign of the conduction)
      expect(dev[L]![5]!).toBeLessThan(0);
      expect(dev[L]![0]!).toBeGreaterThan(0);
    }
    for (const k of [0, 5]) {
      expect(dev[0.19]![k]! / dev[0.381]![k]!, "halving the length, slice " + k).toBeGreaterThan(3.6);
      expect(dev[0.19]![k]! / dev[0.381]![k]!, "halving the length, slice " + k).toBeLessThan(4.4);
      expect(dev[0.381]![k]! / dev[0.762]![k]!, "halving the length, slice " + k).toBeGreaterThan(3.6);
      expect(dev[0.381]![k]! / dev[0.762]![k]!, "halving the length, slice " + k).toBeLessThan(4.4);
    }
  }, 900_000);
});

describe.skipIf(!solverOn)("a transient on a stack of plates through the real solver (needs FEED_SOLVER=1)", () => {
  it("a 10 ms pulse on an operating cosine plate stack (every slice starts at its own steady state): every check passes and the pulse follows the shape", async () => {
    const d = plateTransient("synthetic-pulse-operating", cosine(0.381));
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "transient-pulse") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.slices).toHaveLength(10);
    expect([4, 5]).toContain(res.axial.hottest);
    const rises = res.axial.slices.map((s) => s.maxT - s.peakT[0]!);
    expect(rises[4]!).toBeGreaterThan(rises[0]! * 3);
    expect(Math.abs(res.axial.slices[0]!.peakT[0]! - res.axial.slices[9]!.peakT[0]!)).toBeLessThan(1e-3);
    expect(res.checks.find((c) => c.id === "energyBalanceTotal")!.verdict).toBe("pass");
  }, 600_000);

  it("the loss of cooling on a cosine plate stack (the question of F17): 100 kW per metre of height and width on average, started from its steady states, the film coefficient falls from 30000 to 100 W/m2/K over 1 s at t = 2 s; every check passes and the plate warms, the middle most", async () => {
    const d = plateTransient("synthetic-pulse", cosine(0.381));
    d.transient = {
      powerHistory: [{ time: q(0, "s"), linearHeatRate: q(100, "kW/m") }, { time: q(60, "s"), linearHeatRate: q(100, "kW/m") }],
      endTime: q(60, "s"), timeStep: q(0.05, "s"), outputs: 30, initialSteadyLinearHeatRate: q(100, "kW/m"),
      boundaryHistory: [
        { time: q(0, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") },
        { time: q(2, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") },
        { time: q(3, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(100, "W/m2/K") },
        { time: q(60, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(100, "W/m2/K") },
      ],
    };
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "transient-lossofcooling") : undefined);
    expect(failing(res)).toEqual([]);
    const mid = res.axial.slices[5]!.peakT;
    const end = res.axial.slices[0]!.peakT;
    expect(mid[mid.length - 1]!).toBeGreaterThan(mid[1]! + 200);
    expect(mid[mid.length - 1]!).toBeGreaterThan(mid[mid.length - 5]!);
    expect(mid[mid.length - 1]! - mid[0]!).toBeGreaterThan(3 * (end[end.length - 1]! - end[0]!));
    expect([4, 5]).toContain(res.axial.hottest);
    expect(res.checks.find((c) => c.id === "energyBalanceTotal")!.verdict).toBe("pass");
  }, 900_000);

  it("a pulse on a short operating plate stack (0.06 m, 12 slices), where the axial conduction is large: the checks pass with their allowance (golden output kept)", async () => {
    const d = plateTransient("synthetic-pulse-operating", cosine(0.06, 12));
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "transient-short") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.conduction!.fraction).toBeGreaterThan(0.02);
  }, 600_000);

  it("a long loss of cooling (200 s, the film coefficient down to 10 W/m2/K, the plate almost isolated): every check passes with the heat the slices can exchange along the height counted, and the exchange number is far below its limit", async () => {
    const { res } = await run(lossOfCooling(0.381, 10, 200, 10, 100), GOLDEN ? join(GOLDEN, "transient-lossofcooling-long") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.allowance.exchangeNumber!).toBeLessThan(0.5);
    // the steady estimate's allowance is far too small for this run: the change the checks accept is the exchange bound
    expect(crossOf(res).value!).toBeGreaterThan(5 * res.axial.allowance.field);
    expect(res.axial.allowance.exchangeField!).toBeGreaterThan(crossOf(res).value!);
  }, 900_000);

  it("a loss of cooling on a short plate (0.1 m, 10 slices of 10 mm, 60 s): heat spreads along it (exchange number 0.9) and the checks pass only because the exchange bound is counted (golden output kept)", async () => {
    const { res } = await run(lossOfCooling(0.1, 10, 60, 100, 60), GOLDEN ? join(GOLDEN, "transient-lossofcooling-short") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.allowance.exchangeNumber!).toBeGreaterThan(0.5);
    expect(res.axial.allowance.exchangeNumber!).toBeLessThan(1);
    expect(crossOf(res).value!).toBeGreaterThan(res.axial.allowance.field);
    expect(res.axial.allowance.exchangeField!).toBeGreaterThan(crossOf(res).value!);
  }, 900_000);

  it("THE LIMIT, measured: a loss of cooling on a 0.2 m plate of 20 slices over 100 s (exchange number 1.5): the slice next to the end differs from the one-dimensional solution by more than the first-order bound, the bound is not counted, the cross-check and the slice energy balance fail and the note says why; the checks that do not depend on the neighbours pass", async () => {
    const { res } = await run(lossOfCooling(0.2, 20, 100, 100, 50), GOLDEN ? join(GOLDEN, "transient-lossofcooling-limit") : undefined);
    expect(res.axial.allowance.exchangeNumber!).toBeGreaterThan(1);
    expect(crossOf(res).verdict).toBe("fail");
    expect(res.axial.allowance.exchangeCounted).toBe(false);
    expect(res.checks.find((c) => c.id === "axialConduction")!.note).toMatch(/ABOVE 1.*NOT counted/);
    for (const id of ["energyBalanceTotal", "timeStep"]) expect(res.checks.find((c) => c.id === id)!.verdict, id).toBe("pass");
  }, 900_000);

  it("a control: five equal slices (a flat shape) give every slice the history of the one-slice plate at the same power", async () => {
    const flat = plateTransient("synthetic-pulse-operating", { length: q(0.5, "m"), slices: 5, powerShape: { kind: "flat" } });
    const a = await run(flat);
    expect(failing(a.res)).toEqual([]);
    const one = plateTransient("synthetic-pulse-operating", undefined);
    delete one.axial;
    const b = await run(one);
    expect(failing(b.res)).toEqual([]);
    for (const s of a.res.axial.slices) s.peakT.forEach((T, j) => expect(Math.abs(T - b.res.series.peakT[j]!), "slice " + s.index + " output " + j).toBeLessThan(1e-3));
  }, 900_000);
});

describe.skipIf(!solverOn)("the checks fail when the output is judged against a plate stack that was not run", () => {
  it("steady: a shape read from the top, a coolant read from the top, 10 % more heat and the plate read as a pin fail a check of a real run", async () => {
    const d = plateStack({ length: q(0.381, "m"), slices: 10, powerShape: table([[0, 0.6], [0.19, 1.0], [0.381, 1.4]]), boundary: [bt(0, 573, 30000), bt(0.381, 633, 30000)] });
    const { T, C, normalized } = await run(d, GOLDEN ? join(GOLDEN, "negative") : undefined);
    const judge = (mutate: (n: any) => void) => {
      const n = JSON.parse(JSON.stringify(normalized));
      mutate(n);
      return buildStackResults(n, { T, C, time: 5e7 });
    };
    expect(judge(() => undefined).checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual([]);
    expect(judge((n) => (n.axial.shape.relative = [...n.axial.shape.relative].reverse())).checks.find((c) => c.id === "closedFormFuel")!.verdict, "the shape read from the top").toBe("fail");
    expect(judge((n) => (n.axial.boundary.bulkTemperature = [...n.axial.boundary.bulkTemperature].reverse())).checks.find((c) => c.id === "wallTemperature")!.verdict, "the coolant read from the top").toBe("fail");
    const more = judge((n) => (n.qPrime = n.qPrime * 1.1));
    expect(more.checks.find((c) => c.id === "closedFormFuel")!.verdict, "10 % more heat").toBe("fail");
    expect(more.checks.find((c) => c.id === "energyBalanceTotal")!.verdict).toBe("fail");
    // the same output with the plate flag removed is read with the cylinder's formulas and fails
    let asPin: ReturnType<typeof judge> | undefined;
    try {
      asPin = judge((n) => delete n.plate);
    } catch {
      asPin = undefined; // refused outright is also a failure to pass
    }
    if (asPin) expect(asPin.checks.some((c) => c.verdict === "fail")).toBe(true);
  }, 600_000);

  it("transient: a shape read from the top and 20 % more power fail the cross-check of a real run", async () => {
    const d = plateTransient("synthetic-pulse-operating", { length: q(0.381, "m"), slices: 10, powerShape: table([[0, 0.6], [0.19, 1.0], [0.381, 1.4]]) });
    const { fields, C, normalized } = await run(d, GOLDEN ? join(GOLDEN, "transient-asym") : undefined);
    const judge = (mutate: (n: any) => void) => {
      const n = JSON.parse(JSON.stringify(normalized));
      mutate(n);
      return buildStackTransientResults(n, { C, fields }, computeIndependentStack(n));
    };
    expect(judge(() => undefined).checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual([]);
    expect(judge((n) => (n.axial.shape.relative = [...n.axial.shape.relative].reverse())).checks.find((c) => c.id === "crossCheckFv")!.verdict, "the shape read from the top").toBe("fail");
    expect(judge((n) => (n.transient.linearHeatRate = n.transient.linearHeatRate.map((x: number) => x * 1.2))).checks.find((c) => c.id === "crossCheckFv")!.verdict, "20 % more power").toBe("fail");
  }, 600_000);
});
