// Plan 11 B2 through the real solver (needs FEED_SOLVER=1): a transient whose coolant side changes with time, run by FEED's own writer, run manager and results parser. Every check
// must pass on the real OFFBEAT output; the lumped pin follows the exact lumped solution (written here); and the checks are shown to FAIL when the written history is not the one
// the result is judged against (a different step time, a different level, no history at all): a check that cannot fail is not a check.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { TransientResultsRecord, buildTransientResults, computeIndependent } from "../src/core/transientResults";
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

const pt = (t: number, Tb: number, h: number) => ({ time: q(t, "s"), bulkTemperature: q(Tb, "K"), heatTransferCoefficient: q(h, "W/m2/K") });
/** The lumped pin of the B0 probe: k 100 in both solids (Biot 0.02), c 3 MJ/m3/K, 5 W/m, 800 K start, 40 s, 0.05 s step. */
function lumped(history?: unknown) {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));
  d.boundary = { bulkTemperature: q(600, "K"), heatTransferCoefficient: q(500, "W/m2/K") };
  d.gap.conductance = q(1e6, "W/m2/K");
  d.mesh = { fuelCells: 10, claddingCells: 4 };
  for (const m of ["fuel", "cladding"]) {
    d.materials[m].sets["thermal.conductivity"].value = q(100, "W/m/K");
    d.materials[m].sets["thermal.volumetricHeatCapacity"].value = q(3, "MJ/m3/K");
  }
  d.transient = { powerHistory: [{ time: q(0, "s"), linearHeatRate: q(5, "W/m") }, { time: q(40, "s"), linearHeatRate: q(5, "W/m") }], endTime: q(40, "s"), timeStep: q(0.05, "s"), outputs: 40, initialTemperature: q(800, "K"), ...(history ? { boundaryHistory: history } : {}) };
  return d;
}
const Rf = 4.1e-3, Rci = 4.18e-3, Rco = 4.75e-3;
const Cp = 3e6 * (Math.PI * Rf * Rf + Math.PI * (Rco * Rco - Rci * Rci));
const A = 2 * Math.PI * Rco;
/** The exact lumped solution for a film coefficient that is constant on each of two stretches and a bulk temperature that is linear: RK4 on C dT/dt = q - h A (T - Tb). */
function lumpedExact(h: (t: number) => number, Tb: (t: number) => number, times: number[]) {
  let T = 800, t = 0;
  const f = (tt: number, TT: number) => (5 - h(tt) * A * (TT - Tb(tt))) / Cp;
  return times.map((target) => {
    while (t < target - 1e-12) {
      const dt = 1e-3;
      const k1 = f(t, T), k2 = f(t + dt / 2, T + (dt / 2) * k1), k3 = f(t + dt / 2, T + (dt / 2) * k2), k4 = f(t + dt, T + dt * k3);
      T += (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      t += dt;
    }
    return T;
  });
}

async function run(d: unknown) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-bh-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  return { rec, res: mgr.results(s.id) as unknown as TransientResultsRecord, dir: join(runsRoot, s.id) };
}
const failing = (r: TransientResultsRecord) => r.checks.filter((c) => c.verdict !== "pass").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 160));

describe.skipIf(!solverOn)("a transient with a changing boundary through the real solver (needs FEED_SOLVER=1)", () => {
  it("a step in the film coefficient: every check passes and the peak follows the exact lumped solution within 2 K", async () => {
    const { res } = await run(lumped([pt(0, 600, 500), pt(10, 600, 500), pt(10.05, 600, 100), pt(40, 600, 100)]));
    expect(failing(res)).toEqual([]);
    const ref = lumpedExact((t) => (t < 10 ? 500 : t > 10.05 ? 100 : 500 - (400 * (t - 10)) / 0.05), () => 600, res.series.time);
    res.series.peakT.forEach((T, i) => expect(Math.abs(T - ref[i]!), "t = " + res.series.time[i]).toBeLessThan(2));
  }, 300_000);

  it("a ramp in the bulk temperature", async () => {
    const { res } = await run(lumped([pt(0, 600, 500), pt(40, 900, 500)]));
    expect(failing(res)).toEqual([]);
    const ref = lumpedExact(() => 500, (t) => 600 + (300 * t) / 40, res.series.time);
    res.series.peakT.forEach((T, i) => expect(Math.abs(T - ref[i]!), "t = " + res.series.time[i]).toBeLessThan(2));
  }, 300_000);

  it("a lost coolant: the film coefficient falls to 0.001 W/m2/K and the pin, with 5 W/m, nearly stops cooling; every check passes", async () => {
    const { res } = await run(lumped([pt(0, 600, 500), pt(10, 600, 500), pt(10.05, 600, 0.001), pt(40, 600, 0.001)]));
    expect(failing(res)).toEqual([]);
    expect(res.series.peakT[res.series.peakT.length - 1]!).toBeGreaterThan(res.series.peakT[Math.round(res.series.peakT.length / 4)]!);
  }, 300_000);

  it("a prescribed wall that ramps: the wall check is made against the history and passes", async () => {
    const d = lumped();
    d.boundary = { surfaceTemperature: q(600, "K") };
    d.transient.initialTemperature = q(600, "K");
    d.transient.boundaryHistory = [{ time: q(0, "s"), surfaceTemperature: q(600, "K") }, { time: q(40, "s"), surfaceTemperature: q(900, "K") }];
    const { res } = await run(d);
    expect(failing(res)).toEqual([]);
    expect(res.checks.find((c) => c.id === "wallTemperature")!.note).toMatch(/boundary history/);
    expect(res.series.peakT[res.series.peakT.length - 1]!).toBeGreaterThan(890);
  }, 300_000);

  it("a pump coastdown from a steady operating state (the synthetic pin, 20 kW/m): the film coefficient decays and every check passes", async () => {
    const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));
    d.mesh = { fuelCells: 20, claddingCells: 6 };
    d.transient = {
      powerHistory: [{ time: q(0, "s"), linearHeatRate: q(20, "kW/m") }, { time: q(20, "s"), linearHeatRate: q(20, "kW/m") }],
      endTime: q(20, "s"), timeStep: q(0.05, "s"), outputs: 20, initialSteadyLinearHeatRate: q(20, "kW/m"),
      boundaryHistory: [pt(0, 300, 30000), pt(2, 300, 30000), pt(6, 300, 5000), pt(20, 300, 5000)],
    };
    const { res } = await run(d);
    expect(failing(res)).toEqual([]);
    expect(res.series.peakT[res.series.peakT.length - 1]!).toBeGreaterThan(res.series.peakT[0]! + 50);
  }, 300_000);

  it("a hot pin with no heat source cooling through a falling then rising coolant temperature", async () => {
    const d = lumped([pt(0, 400, 500), pt(20, 300, 500), pt(40, 500, 500)]);
    d.transient.powerHistory = [{ time: q(0, "s"), linearHeatRate: q(0, "W/m") }, { time: q(40, "s"), linearHeatRate: q(0, "W/m") }];
    const { res } = await run(d);
    expect(failing(res)).toEqual([]);
  }, 300_000);
});

describe.skipIf(!solverOn)("the checks fail when the history the result is judged against is not the one that was run", () => {
  it("a different step time, a different level and no history all fail the cross-check of a real run", async () => {
    const good = lumped([pt(0, 600, 500), pt(10, 600, 500), pt(10.05, 600, 100), pt(40, 600, 100)]);
    const { dir } = await run(good);
    const tdir = join(dir, "native", "times");
    const names = readdirSync(tdir).filter((n) => /^[0-9.eE+-]+$/.test(n)).sort((a, b) => Number(a) - Number(b));
    const fields = names.map((n) => ({ time: Number(n), T: readFileSync(join(tdir, n, "T"), "utf8") }));
    const C = readFileSync(existsSync(join(dir, "native", "final", "C")) ? join(dir, "native", "final", "C") : join(tdir, names[0]!, "C"), "utf8");
    const judge = (d: unknown) => {
      const n = validateCase(d).normalized!;
      return buildTransientResults(n, { C, fields }, computeIndependent(n));
    };
    const same = judge(good);
    expect(same.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("pass");
    const later = judge(lumped([pt(0, 600, 500), pt(20, 600, 500), pt(20.05, 600, 100), pt(40, 600, 100)]));
    expect(later.checks.find((c) => c.id === "crossCheckFv")!.verdict, "the step moved from 10 s to 20 s").toBe("fail");
    const level = judge(lumped([pt(0, 600, 500), pt(10, 600, 500), pt(10.05, 600, 200), pt(40, 600, 200)]));
    expect(level.checks.find((c) => c.id === "crossCheckFv")!.verdict, "the film 200 instead of 100").toBe("fail");
    const none = judge(lumped());
    expect(none.checks.find((c) => c.id === "crossCheckFv")!.verdict, "no history").toBe("fail");
    const held = judge(lumped([pt(0, 600, 500), pt(40, 600, 500)]));
    expect(held.checks.find((c) => c.id === "crossCheckFv")!.verdict, "the first level held").toBe("fail");
  }, 300_000);
});

describe.skipIf(!solverOn)("the time-step check looks at every cell and the wall (Codex review 2026-10-14)", () => {
  it("a brief dip of the wall temperature on a hot pin: the hottest cell hardly moves between the step and half the step, the cladding does, and the check fails with the field named", async () => {
    const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));
    d.boundary = { surfaceTemperature: q(900, "K") };
    d.mesh = { fuelCells: 20, claddingCells: 6 };
    d.transient = {
      powerHistory: [{ time: q(0, "s"), linearHeatRate: q(20, "kW/m") }, { time: q(20, "s"), linearHeatRate: q(20, "kW/m") }],
      endTime: q(20, "s"), timeStep: q(1, "s"), outputs: 20, initialSteadyLinearHeatRate: q(20, "kW/m"),
      boundaryHistory: [0, 9, 10, 11, 20].map((s) => ({ time: q(s, "s"), surfaceTemperature: q(s === 10 ? 800 : 900, "K") })),
    };
    const { res } = await run(d);
    const c = res.checks.find((x) => x.id === "timeStep")!;
    expect(c.verdict).toBe("fail");
    expect(c.note).toMatch(/every cell and the outer wall are compared at each output too: at most [\d.]+ K, threshold 2% of the largest excursion of any cell \(2\.00 K\)/);
    expect(c.note).toMatch(/the peak changes by at most 2\.\d+ K/);
  }, 300_000);
});
