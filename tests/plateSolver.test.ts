// Plan 12 A4 through the real solver (needs FEED_SOLVER=1): a plate written by FEED's writer (a Cartesian mesh), run by the run manager, read back and judged against the slab closed
// forms (steady) and the slab finite-volume solution (transient). Every check passes on the real output, and the same output judged as a pin fails: the geometry is what the checks test.
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ResultsRecord, buildResults } from "../src/core/resultsParser";
import { RunManager } from "../src/core/runManager";
import { TransientResultsRecord, buildTransientResults, computeIndependent } from "../src/core/transientResults";
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
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "offbeat-plate") : undefined;

function plateOf(base: string) {
  const d = JSON.parse(readFileSync(join(root, "examples", base + ".json"), "utf8"));
  d.caseId = "synthetic-plate";
  d.assumptions.geometry = "1D-slab";
  d.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  return d;
}

async function run(d: unknown, save?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-plate-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const dir = join(runsRoot, s.id);
  const native = join(dir, "native");
  const normalized = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
  const C = readFileSync(join(native, "final", "C"), "utf8");
  const T = readFileSync(join(native, "final", "T"), "utf8");
  const tdir = join(native, "times");
  const names = normalized.transient ? readdirSync(tdir).filter((n) => /^[0-9.eE+-]+$/.test(n)).sort((a, b) => Number(a) - Number(b)) : [];
  const fields = names.map((n) => ({ time: Number(n), T: readFileSync(join(tdir, n, "T"), "utf8") }));
  if (save) {
    mkdirSync(save, { recursive: true });
    writeFileSync(join(save, "T"), T);
    writeFileSync(join(save, "C"), C);
    copyFileSync(join(dir, "normalized.json"), join(save, "normalized.json"));
    for (const f of fields) {
      mkdirSync(join(save, "times", String(f.time)), { recursive: true });
      writeFileSync(join(save, "times", String(f.time), "T"), f.T);
    }
  }
  return { res: mgr.results(s.id) as unknown as ResultsRecord & TransientResultsRecord, T, C, fields, normalized };
}
const failing = (r: { checks: { id: string; verdict: string; value: number | null; note: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 200));

describe.skipIf(!solverOn)("a plate through the real solver (needs FEED_SOLVER=1)", () => {
  it("steady, cooled by a film: every check passes and the centre of the plate is the slab's closed form, 592.093 K", async () => {
    const { res } = await run(plateOf("synthetic-pin").valueOf(), GOLDEN ? join(GOLDEN, "steady") : undefined);
    expect(failing(res)).toEqual([]);
    expect(Math.abs(res.summary.centreCellT - 592.0933)).toBeLessThan(0.05);
    // the profile falls from the mid-plane to the face
    const fuel = res.radial.filter((p) => p.region === "fuel");
    for (let i = 1; i < fuel.length; i++) expect(fuel[i]!.T).toBeLessThan(fuel[i - 1]!.T);
  }, 300_000);

  it("steady, with a prescribed wall", async () => {
    const d = plateOf("synthetic-pin");
    d.boundary = { surfaceTemperature: q(600, "K") };
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "wall") : undefined);
    expect(failing(res)).toEqual([]);
    expect(Math.abs(res.summary.centreCellT - (600 + 0.76 + 4 + 13.6667))).toBeLessThan(0.05);
  }, 300_000);

  it("steady, with a conductivity that depends on temperature", async () => {
    const d = plateOf("synthetic-pin");
    d.materials.fuel.sets["thermal.conductivity"] = { model: "linear", a: q(4, "W/m/K"), b: q(-0.0006, "W/m/K2"), validRange: { min: q(300, "K"), max: q(2500, "K") }, source: "synthetic: a test" };
    const { res } = await run(d);
    expect(failing(res)).toEqual([]);
  }, 300_000);

  it("a 10 ms pulse into a cold plate: every check passes and the peak is the adiabatic one, T0 + E''' / c", async () => {
    const d = plateOf("synthetic-pulse");
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "pulse") : undefined);
    expect(failing(res)).toEqual([]);
    // 50 kJ per metre of height and width over a meat of half-thickness 4.1 mm: 12.2 MJ/m3 over the fuel's heat capacity
    const E = res.series.deposited[res.series.deposited.length - 1]!;
    expect(E).toBeCloseTo(50000, -1);
    const c = 3e6;
    expect(Math.abs(res.summary.maxT - (300 + E / 4.1e-3 / c))).toBeLessThan(0.02 * (E / 4.1e-3 / c));
  }, 300_000);

  it("the loss of cooling (the question that started plan 11 and plan 12): a plate at 20 kW per metre of height and width, started from its steady state, the film coefficient falls from 30000 to 100 W/m2/K over 1 s at t = 2 s; every check passes and the plate warms", async () => {
    const d = plateOf("synthetic-pulse");
    d.transient = {
      powerHistory: [{ time: q(0, "s"), linearHeatRate: q(20, "kW/m") }, { time: q(60, "s"), linearHeatRate: q(20, "kW/m") }],
      endTime: q(60, "s"), timeStep: q(0.05, "s"), outputs: 60, initialSteadyLinearHeatRate: q(20, "kW/m"),
      boundaryHistory: [
        { time: q(0, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") },
        { time: q(2, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") },
        { time: q(3, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(100, "W/m2/K") },
        { time: q(60, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(100, "W/m2/K") },
      ],
    };
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "lossofcooling") : undefined);
    expect(failing(res)).toEqual([]);
    const peak = res.series.peakT;
    expect(peak[peak.length - 1]!).toBeGreaterThan(peak[2]! + 50);
    // a plate with 20 kW per metre of height and width and a film of 100 W/m2/K would sit at 300 + 200 + ... K in the end: it is far from there after 60 s and still warming
    expect(peak[peak.length - 1]!).toBeGreaterThan(peak[peak.length - 5]!);
  }, 600_000);
});

describe.skipIf(!solverOn)("the same output judged as a pin fails", () => {
  it("a steady plate's output read with the cylinder's closed forms fails them, and a transient plate's output is refused by the cylinder's cell centres", async () => {
    const s = await run(plateOf("synthetic-pin"));
    const asPin = JSON.parse(JSON.stringify(s.normalized));
    delete asPin.plate;
    const wrong = buildResults(asPin, { T: s.T, C: s.C, time: 5e7 });
    expect(wrong.checks.some((c) => c.verdict === "fail" && ["closedFormFuel", "closedFormCladding", "energyBalance", "wallTemperature"].includes(c.id))).toBe(true);
    const t = await run(plateOf("synthetic-pulse"));
    const asPinT = JSON.parse(JSON.stringify(t.normalized));
    delete asPinT.plate;
    // the cylinder's mesh puts its cell centres elsewhere (the volume centroids of wedge cells, not the middles of slab cells): the output is refused before any physics is compared
    expect(() => buildTransientResults(asPinT, { C: t.C, fields: t.fields }, computeIndependent(asPinT))).toThrow(/this case's mesh puts it at/);
  }, 600_000);
});
