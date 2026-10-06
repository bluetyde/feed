// A transient that starts from the pin's steady operating state (plan 08, decision 3), through the real solver (FEED_SOLVER=1) and
// the case files without it: the nonuniform starting field, a hold, a pulse on an operating state, a shutdown, an annular pin with
// temperature-dependent properties, and deliberate faults in the written field.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { RunBackend, RunManager } from "../src/core/runManager";
import { initialState, TransientResultsRecord } from "../src/core/transientResults";
import { steadyFv, storedEnergy } from "../src/core/transientFv";
import { pinOf } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const NL = String.fromCharCode(10);
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (v: number, unit = "kW/m") => ({ value: v, unit });
const normalized = (doc: unknown) => {
  const v = validateCase(doc);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};

/** The synthetic pulse pin, started from its steady state at q0 with the given power history (time in s or ms as given). */
function operating(q0: number, history: [number, string, number][], endTime: { value: number; unit: string }, timeStep: { value: number; unit: string }, outputs: number) {
  const d = read("examples/synthetic-pulse.json");
  delete d.transient.initialTemperature;
  d.transient.initialSteadyLinearHeatRate = q(q0);
  d.transient.powerHistory = history.map(([t, u, v]) => ({ time: { value: t, unit: u }, linearHeatRate: q(v) }));
  d.transient.endTime = endTime;
  d.transient.timeStep = timeStep;
  d.transient.outputs = outputs;
  return d;
}

// ---- the written files (no solver needed)
describe("the case files of a transient that starts from a steady state", () => {
  const doc = operating(20, [[0, "s", 20], [100, "s", 20]], q(100, "s"), q(0.5, "s"), 20);
  doc.mesh = { fuelCells: 8, claddingCells: 3 };
  const n = normalized(doc);
  const files = writeOffbeatCase(n).files;
  const T = files["0/T"]!;
  const init = initialState(n);

  it("writes every cell's temperature in blockMesh order (fuel inner to outer, then cladding inner to outer)", () => {
    const m = /internalField\s+nonuniform List<scalar>\s+(\d+)\s*\(([\s\S]*?)\)\s*;/.exec(T)!;
    expect(Number(m[1])).toBe(11);
    const values = m[2]!.trim().split(/\s+/).map(Number);
    expect(values).toEqual(init.T);
    // the fuel falls from the centre outwards, the cladding falls from the gap to the coolant
    for (let i = 1; i < 8; i++) expect(values[i]!).toBeLessThan(values[i - 1]!);
    expect(values[8]!).toBeGreaterThan(values[10]!);
    expect(values[7]!).toBeGreaterThan(values[8]!); // the gap's drop sits between the last fuel cell and the first cladding cell
  });

  it("patches start from a uniform value (a list cannot be copied into a patch), and none refers to $internalField", () => {
    expect(T).not.toMatch(/\$internalField/);
    expect(T).toMatch(/type\s+convectiveHTC;[\s\S]*?value uniform 3\d\d\.\d+;/);
    const wedge = /\.\*Front\|\.\*Back"\s*\{[\s\S]*?value\s+uniform ([\d.]+);/.exec(T)!;
    expect(Number(wedge[1])).toBeGreaterThan(300);
    expect(Number(wedge[1])).toBeLessThan(init.peak);
    // each gap face starts from the cell beside it, the coolant face from the wall
    const patchValue = (name: string) => Number(new RegExp(name + "\\s*\\{[\\s\\S]*?value\\s+uniform ([-\\d.e+]+);").exec(T)![1]);
    expect(patchValue("fuelOuter")).toBe(init.T[7]);
    expect(patchValue("cladInner")).toBe(init.T[8]);
    expect(patchValue("cladOuter")).toBe(init.wall);
  });

  it("the mapping and the placeholders say where the field came from", () => {
    const w = writeOffbeatCase(n);
    expect(w.mapping.find((m) => m.field === "transient.initialSteadyLinearHeatRate")!.note).toMatch(/blockMesh order/);
    expect(w.mapping.some((m) => m.field === "transient.initialTemperature")).toBe(false);
    expect(w.placeholders.find((p) => p.name === "initial temperature field")!.value).toMatch(/steady state at 20000 W\/m/);
  });

  it("a uniform start is still written as before", () => {
    const u = writeOffbeatCase(normalized(read("examples/synthetic-pulse.json"))).files["0/T"]!;
    expect(u).toMatch(/internalField\s+uniform 300;/);
    expect(u).toMatch(/value\s+\$internalField;/);
  });

  it("the independent solution starts from the same field", () => {
    expect(init.T.length).toBe(11);
    const direct = steadyFv(pinOf(n), 20000).T;
    expect(init.T).toEqual(direct);
  });
});

describe("validation of the steady start", () => {
  it("a shutdown (an all-zero power history) is allowed from a steady state and refused from a uniform start", () => {
    const scram = operating(20, [[0, "s", 0], [100, "s", 0]], q(100, "s"), q(1, "s"), 10);
    expect(validateCase(scram).errors).toEqual([]);
    const cold = read("examples/synthetic-pulse.json");
    cold.transient.powerHistory.forEach((p: any) => (p.linearHeatRate = q(0, "W/m")));
    expect(validateCase(cold).errors.map((e) => e.code + " " + e.field)).toEqual(["E_OUT_OF_RANGE /transient/powerHistory"]);
  });

  it("zero is a valid steady heat rate: the pin sits at the coolant temperature", () => {
    const d = operating(0, [[0, "s", 1], [100, "s", 1]], q(100, "s"), q(1, "s"), 10);
    const n = normalized(d);
    for (const x of initialState(n).T) expect(x).toBeCloseTo(300, 9);
  });

  it("a steady start on a prescribed surface temperature starts at that wall", () => {
    const d = operating(20, [[0, "s", 20], [100, "s", 20]], q(100, "s"), q(1, "s"), 10);
    delete d.boundary.bulkTemperature;
    delete d.boundary.heatTransferCoefficient;
    d.boundary.surfaceTemperature = { value: 560, unit: "K" };
    const init = initialState(normalized(d));
    expect(init.wall).toBe(560);
    expect(init.T[init.T.length - 1]!).toBeGreaterThan(560);
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

/** A backend that edits one input file before the real run (a deliberate fault in the solver's input). */
class FileFaultBackend implements RunBackend {
  inner = new WslBackend();
  constructor(private file: string, private edit: (text: string) => string) {}
  async run(args: Parameters<RunBackend["run"]>[0]) {
    const f = join(args.inputsDir, this.file);
    writeFileSync(f, this.edit(readFileSync(f, "utf8")));
    return this.inner.run(args);
  }
  cancel(id: string) {
    return this.inner.cancel(id);
  }
}

async function runCase(doc: unknown, backend: RunBackend = new WslBackend()) {
  const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-ss-")), backend, timeoutMs: 280_000 });
  const s = mgr.start(doc);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  return { rec, res: mgr.results(s.id) as TransientResultsRecord | undefined };
}

const maxDiff = (a: number[], b: number[]) => Math.max(...a.map((x, i) => Math.abs(x - b[i]!)));
const cellsOf = (doc: any) => doc.mesh.fuelCells + doc.mesh.claddingCells;

describe.skipIf(!solverOn)("a steady start through the real solver (needs FEED_SOLVER=1)", () => {
  it("held at its own power the pin stays put: the only drift is the two discretisations' steady states, and it falls as the mesh is refined", async () => {
    const drifts: number[] = [];
    for (const [nf, nc] of [[20, 6], [40, 12]]) {
      const d = operating(20, [[0, "s", 20], [100, "s", 20]], q(100, "s"), q(0.5, "s"), 20);
      d.mesh = { fuelCells: nf, claddingCells: nc };
      const { rec, res } = await runCase(d);
      expect(rec.state).toBe("completed");
      expect(res!.checks.every((c) => c.verdict === "pass")).toBe(true);
      expect(res!.initialState.kind).toBe("steady");
      expect(res!.profiles[0]!.length).toBe(cellsOf(d));
      expect(res!.profiles.length).toBe(21);
      drifts.push(maxDiff(res!.profiles[res!.profiles.length - 1]!, res!.profiles[0]!));
      // heat made equals heat that left, to the energy-balance threshold
      expect(res!.checks.find((c) => c.id === "energyBalance")!.value!).toBeLessThan(0.01);
    }
    // measured: 2.2 K on the 20 + 6 cell mesh (0.3% of the 736 K the pin is above its coolant)
    expect(drifts[0]!).toBeLessThan(0.004 * 736);
    expect(drifts[1]! * 3).toBeLessThan(drifts[0]!);
  }, 600_000);

  it("a pulse on an operating state: the interior gains exactly the pulse's own energy (pulse run minus hold run)", async () => {
    // The model is linear for constant properties, so the difference of two runs from the same start is the response to the extra source alone and does not
    // depend on the small offset between the two solvers' steady states. In the adiabatic interior that response is the energy per unit fuel volume over c.
    const history: [number, string, number][] = [[0, "ms", 20], [5, "ms", 10000], [10, "ms", 20], [100, "ms", 20]];
    const pulse = await runCase(operating(20, history, q(100, "ms"), q(0.1, "ms"), 20));
    const held = await runCase(operating(20, [[0, "ms", 20], [100, "ms", 20]], q(100, "ms"), q(0.1, "ms"), 20));
    expect(pulse.rec.state).toBe("completed");
    expect(pulse.res!.checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(held.res!.checks.every((c) => c.verdict === "pass")).toBe(true);
    const area = Math.PI * 0.0041 ** 2;
    const extra = 0.5 * (10e6 - 20e3) * 0.01; // J/m above the background over the 10 ms pulse
    const at10ms = pulse.res!.times.findIndex((t) => Math.abs(t - 0.01) < 1e-9);
    expect(at10ms).toBeGreaterThan(0);
    expect(pulse.res!.profiles[at10ms]![0]! - held.res!.profiles[at10ms]![0]!).toBeCloseTo(extra / area / 3e6, 2);
    expect(pulse.res!.initialState).toMatchObject({ kind: "steady", linearHeatRate: 20000 });
    // and the pulse is on top of the operating state: the hottest cell starts at the steady peak and rises by the pulse
    expect(pulse.res!.series.peakT[0]!).toBeCloseTo(pulse.res!.initialTemperature, 9);
    expect(pulse.res!.summary.maxRise).toBeGreaterThan(extra / area / 3e6 - 1);
  }, 300_000);

  it("a shutdown: the pin cools to its coolant and rejects the heat it held (outputs fine enough to resolve the decay)", async () => {
    const d = operating(20, [[0, "s", 0], [100, "s", 0]], q(100, "s"), q(0.1, "s"), 100);
    const { rec, res } = await runCase(d);
    expect(rec.state).toBe("completed");
    expect(res!.checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(res!.checks.map((c) => c.id)).toContain("energyBalance"); // a run that deposits nothing is still balanced against what it held
    const n = normalized(d);
    const held = storedEnergy(pinOf(n), initialState(n).T, 300);
    const k = res!.series.rejected.length - 1;
    expect(Math.abs(res!.series.rejected[k]! - held) / held).toBeLessThan(0.02);
    expect(res!.summary.finalPeakT).toBeLessThan(300.5);
  }, 300_000);
  it("an annular pin with temperature-dependent conductivity and heat capacity (the TRIGA pulse started at 5 kW/m)", async () => {
    const d = read("examples/ut-triga-pulse-4p40.json");
    delete d.transient.initialTemperature;
    d.transient.initialSteadyLinearHeatRate = q(5);
    const { rec, res } = await runCase(d);
    expect(rec.state).toBe("completed");
    expect(res!.checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(res!.domain.verdict).toBe("in-domain");
    expect(res!.initialState.kind).toBe("steady");
  }, 300_000);

  // The check has teeth on the starting field too: a field written in the wrong order, or at the wrong power, is not what the independent solution started from.
  const hold = () => operating(20, [[0, "s", 20], [100, "s", 20]], q(100, "s"), q(0.5, "s"), 20);
  const rewriteList = (f: (values: string[]) => string[]) => (text: string) =>
    text.replace(/(internalField\s+nonuniform List<scalar>\s+\d+\s*\()([\s\S]*?)(\)\s*;)/, (_m, a: string, body: string, c: string) => a + f(body.trim().split(/\s+/)).join(NL) + NL + c);

  it("a starting field written in the wrong order is caught by the cross-check", async () => {
    const { rec, res } = await runCase(hold(), new FileFaultBackend("0/T", rewriteList((v) => v.slice().reverse())));
    expect(rec.state).toBe("completed");
    const cross = res!.checks.find((c) => c.id === "crossCheckFv")!;
    expect(cross.verdict).toBe("fail");
    expect(cross.value!).toBeGreaterThan(50);
  }, 300_000);

  it("a starting field for the wrong power (5% too high above the coolant) is caught by the cross-check", async () => {
    const { rec, res } = await runCase(hold(), new FileFaultBackend("0/T", rewriteList((v) => v.map((x) => String(300 + (Number(x) - 300) * 1.05)))));
    expect(rec.state).toBe("completed");
    expect(res!.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("fail");
  }, 300_000);

  it("the check does not fail a correct field (the same case, unedited)", async () => {
    const { res } = await runCase(hold());
    expect(res!.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("pass");
  }, 300_000);
});
