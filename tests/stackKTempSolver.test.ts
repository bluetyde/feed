// Stacks with conductivities that depend on temperature, through the real solver (needs FEED_SOLVER=1). Every saved stack run before this one had constant conductivities, so two
// things were untested against OFFBEAT: (a) the heat that crosses from one layer to the next (OFFBEAT interpolates the conductivity to the face; FEED's two-dimensional reference puts
// two half cells in series, the harmonic form), and (b) the two-dimensional reference's iteration for k(T) (Picard) on a real run. The layers of one solid differ in temperature by a
// few kelvin only, so the two forms of the face conductivity are expected to differ by a few hundredths of a kelvin at most (the B0 probe made a k(T) up: 0.08 K).
//
// Tolerances, fixed before the first run:
//   - the cells of a plate stack against the two-dimensional reference: 0.05 K (the plan 15 B0 and B1 runs with constant k agree to 5e-6 K; the face form is the only difference),
//   - every check of every run passes (a pin stack with the allowance, as before: it is not judged against the reference),
//   - the transient (loss of cooling on a plate stack): the reference's deviation 0.05 K.
// FEED_SAVE_GOLDEN=1 saves the output in tests/golden/offbeat-stack-ktemp/<name>/, read again without the solver by tests/stackKTempGolden.test.ts.
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { StackRecord } from "../src/core/stackResults";
import { StackTransientRecord } from "../src/core/stackTransientResults";
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
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "offbeat-stack-ktemp") : undefined;
const DEVIATION = 0.05;

/** Fuel k = 2000 / T + 0.5 (2.64 W/m/K at 900 K, 2.0 at 1400 K: the shape of a ceramic), cladding k = 12 + 0.006 T (15.6 W/m/K at 600 K): both solids temperature dependent. */
function withLaws(d: any) {
  d.materials.fuel.sets["thermal.conductivity"] = { model: "reciprocal", a: q(2000, "W/m"), b: q(0.5, "W/m/K"), validRange: { min: q(280, "K"), max: q(2500, "K") }, source: "synthetic: chosen to make the conductivity depend on temperature, not a sourced property" };
  d.materials.cladding.sets["thermal.conductivity"] = { model: "linear", a: q(12, "W/m/K"), b: q(0.006, "W/m/K2"), validRange: { min: q(280, "K"), max: q(1000, "K") }, source: "synthetic: chosen to make the conductivity depend on temperature, not a sourced property" };
  return d;
}
const cosine = (L: number, N = 10) => ({ length: q(L, "m"), slices: N, powerShape: { kind: "cosine" } });
function plateSteady() {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
  d.caseId = "synthetic-plate-stack-ktemp";
  d.assumptions.geometry = "1D-slab";
  d.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
  d.power.linearHeatRate = q(200000, "W/m");
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  d.axial = cosine(0.381);
  return withLaws(d);
}
function pinSteady() {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
  d.caseId = "synthetic-pin-stack-ktemp";
  d.power.linearHeatRate = q(15, "kW/m");
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  d.axial = cosine(0.381);
  return withLaws(d);
}
function plateLossOfCooling() {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pulse.json"), "utf8"));
  d.caseId = "synthetic-plate-stack-ktemp-lossofcooling";
  d.assumptions.geometry = "1D-slab";
  d.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  d.axial = cosine(0.2, 10);
  const tEnd = 60;
  d.transient = {
    powerHistory: [{ time: q(0, "s"), linearHeatRate: q(100, "kW/m") }, { time: q(tEnd, "s"), linearHeatRate: q(100, "kW/m") }],
    endTime: q(tEnd, "s"), timeStep: q(0.1, "s"), outputs: 60, initialSteadyLinearHeatRate: q(100, "kW/m"),
    boundaryHistory: [
      { time: q(0, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") },
      { time: q(2, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(30000, "W/m2/K") },
      { time: q(3, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(100, "W/m2/K") },
      { time: q(tEnd, "s"), bulkTemperature: q(300, "K"), heatTransferCoefficient: q(100, "W/m2/K") },
    ],
  };
  return withLaws(d);
}

async function run(d: unknown, save?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-ktemp-run-"));
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
    writeFileSync(join(save, "time.json"), JSON.stringify({ time: (mgr.results(s.id) as any).time }) + "\n");
    for (const f of fields) {
      mkdirSync(join(save, "times", String(f.time)), { recursive: true });
      writeFileSync(join(save, "times", String(f.time), "T"), f.T);
    }
  }
  return { res: mgr.results(s.id) as unknown as StackRecord & StackTransientRecord, normalized };
}
const failing = (r: { checks: { id: string; verdict: string; value: number | null; note: string }[] }) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 200));
const reference = (r: any) => r.axial.reference as { kind: string; deviation: number };

describe.skipIf(!solverOn)("stacks with temperature-dependent conductivities through the real solver (needs FEED_SOLVER=1)", () => {
  it("a cosine plate stack with k(T) in the fuel (reciprocal) and the cladding (linear): every check passes and OFFBEAT's cells agree with the two-dimensional reference", async () => {
    const { res, normalized } = await run(plateSteady(), GOLDEN ? join(GOLDEN, "plate-steady") : undefined);
    expect(normalized.fuelConductivity.kind).toBe("reciprocal");
    expect(failing(res)).toEqual([]);
    expect(reference(res).kind).toBe("two-dimensional");
    console.log("plate steady k(T): deviation from the 2D reference", reference(res).deviation);
    expect(reference(res).deviation).toBeLessThan(DEVIATION);
  }, 600_000);

  it("a cosine pin stack with the same laws: every check passes (judged with the allowance, as before: pins are not wired to the reference)", async () => {
    const { res } = await run(pinSteady(), GOLDEN ? join(GOLDEN, "pin-steady") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.slices).toHaveLength(10);
  }, 600_000);

  it("a loss of cooling on a 0.2 m plate stack with k(T): every check passes and the cells agree with the two-dimensional reference through the transient", async () => {
    const { res } = await run(plateLossOfCooling(), GOLDEN ? join(GOLDEN, "plate-lossofcooling") : undefined);
    expect(failing(res)).toEqual([]);
    expect(reference(res).kind).toBe("two-dimensional");
    console.log("plate transient k(T): deviation from the 2D reference", reference(res).deviation);
    expect(reference(res).deviation).toBeLessThan(DEVIATION);
  }, 600_000);
});
