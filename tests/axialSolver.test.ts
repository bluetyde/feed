// Plan 12 A2 through the real solver (needs FEED_SOLVER=1): an axial stack written by FEED's writer, run by the run manager, read back layer by layer and judged slice by slice.
// Every check must pass on the real OFFBEAT output; a control shows N equal slices equal one slice; and the checks are shown to FAIL when the output is judged against a stack
// that is not the one that was run (a shifted shape, a flipped coolant table).
import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { sliceLoads } from "../src/core/axial";
import { quickLook } from "../src/core/quickLook";
import { RunManager } from "../src/core/runManager";
import { StackRecord, buildStackResults } from "../src/core/stackResults";
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

function stack(axial: unknown, avg = 20000) {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.power.linearHeatRate = q(avg, "W/m");
  d.mesh = { fuelCells: 20, claddingCells: 6 };
  d.axial = axial;
  return d;
}
const cosine = (L: number, N = 10) => ({ length: q(L, "m"), slices: N, powerShape: { kind: "cosine" } });
const bt = (z: number, Tb: number, h: number) => ({ height: q(z, "m"), bulkTemperature: q(Tb, "K"), heatTransferCoefficient: q(h, "W/m2/K") });

async function run(d: unknown, save?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-axial-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const dir = join(runsRoot, s.id);
  const T = readFileSync(join(dir, "native", "final", "T"), "utf8");
  const C = readFileSync(join(dir, "native", "final", "C"), "utf8");
  if (save) {
    mkdirSync(save, { recursive: true });
    writeFileSync(join(save, "T"), T);
    writeFileSync(join(save, "C"), C);
    copyFileSync(join(dir, "normalized.json"), join(save, "normalized.json"));
  }
  return { rec, res: mgr.results(s.id) as unknown as StackRecord, T, C, normalized: JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8")) };
}
const failing = (r: StackRecord) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 200));
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "offbeat-stack") : undefined;

describe.skipIf(!solverOn)("an axial stack through the real solver (needs FEED_SOLVER=1)", () => {
  it("a cosine stack on a flat coolant: every check passes and each slice's centre is within the allowance of its own closed form", async () => {
    const { res } = await run(stack(cosine(0.381)), GOLDEN ? join(GOLDEN, "cosine") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.slices).toHaveLength(10);
    const n = validateCase(stack(cosine(0.381))).normalized!;
    sliceLoads(n).forEach((l, k) => {
      const sc = { ...n, qPrime: l.linearHeatRate, boundary: l.boundary } as typeof n;
      delete (sc as { axial?: unknown }).axial;
      const closed = quickLook(sc).temperatures.centreT;
      expect(Math.abs(res.axial.slices[k]!.centreCellT - closed), "slice " + k).toBeLessThan(5 * 1141 / 400 + res.axial.allowance.field);
    });
    // the cosine is symmetric: the middle two slices agree, and so do the ends
    expect(Math.abs(res.axial.slices[4]!.centreCellT - res.axial.slices[5]!.centreCellT)).toBeLessThan(1e-3);
    expect(Math.abs(res.axial.slices[0]!.centreCellT - res.axial.slices[9]!.centreCellT)).toBeLessThan(1e-3);
    expect([4, 5]).toContain(res.axial.hottest);
  }, 300_000);

  it("a coolant that warms up the pin: the walls follow the table (positions in metres from the bottom), the hottest slice moves up, every check passes", async () => {
    const d = stack({ ...cosine(0.381), boundary: [bt(0, 573, 30000), bt(0.381, 673, 30000)] });
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "rise") : undefined);
    expect(failing(res)).toEqual([]);
    const w = res.axial.slices.map((s) => s.claddingOuterWallT!);
    // each slice's outer face sits a film drop above the coolant at its height
    res.axial.slices.forEach((s, k) => {
      const tb = 573 + 100 * (s.height / 0.381);
      const drop = s.linearHeatRate / (2 * Math.PI * 4.75e-3 * 30000);
      expect(Math.abs(w[k]! - (tb + drop)), "slice " + k).toBeLessThan(0.2);
    });
    // the coolant warms 100 K from bottom to top, so the hottest slice is above the middle
    expect(res.axial.hottest).toBeGreaterThanOrEqual(5);
  }, 300_000);

  it("a prescribed wall that warms up the pin", async () => {
    const d = stack({ ...cosine(0.381), boundary: [{ height: q(0, "m"), surfaceTemperature: q(573, "K") }, { height: q(0.381, "m"), surfaceTemperature: q(633, "K") }] });
    delete d.boundary.bulkTemperature;
    delete d.boundary.heatTransferCoefficient;
    d.boundary.surfaceTemperature = q(573, "K");
    const { res } = await run(d);
    expect(failing(res)).toEqual([]);
    res.axial.slices.forEach((s) => expect(Math.abs(s.claddingOuterWallT! - (573 + 60 * (s.height / 0.381))), "slice " + s.index).toBeLessThan(0.1));
  }, 300_000);

  it("a control: five equal slices (a flat shape and a flat coolant) give every slice the temperatures of the one-slice pin at the same heat rate", async () => {
    const { res } = await run(stack({ length: q(0.5, "m"), slices: 5, powerShape: { kind: "flat" } }));
    expect(failing(res)).toEqual([]);
    const one = validateCase(JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8")));
    const single = await run(Object.assign(JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8")), { mesh: { fuelCells: 20, claddingCells: 6 }, power: { linearHeatRate: q(20000, "W/m") } }));
    expect(one.ok).toBe(true);
    for (const s of res.axial.slices) expect(Math.abs(s.centreCellT - (single.res as unknown as { summary: { centreCellT: number } }).summary.centreCellT)).toBeLessThan(1e-3);
  }, 600_000);
});

describe.skipIf(!solverOn)("the checks fail when the output is judged against a stack that was not run", () => {
  it("a shape shifted by one slice, a mirrored coolant table and a different heat rate fail the per-slice closed-form checks of a real run", async () => {
    const d = stack({ length: q(0.381, "m"), slices: 10, powerShape: { kind: "table", points: [[0, 0.6], [0.19, 1.0], [0.381, 1.4]].map(([z, r]) => ({ position: q(z!, "m"), relativePower: q(r!, "1") })) }, boundary: [bt(0, 573, 30000), bt(0.381, 633, 30000)] });
    const { T, C, normalized } = await run(d);
    const judge = (mutate: (n: any) => void) => {
      const n = JSON.parse(JSON.stringify(normalized));
      mutate(n);
      return buildStackResults(n, { T, C, time: 5e7 });
    };
    const good = judge(() => undefined);
    expect(good.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual([]);
    const mirroredShape = judge((n) => (n.axial.shape.relative = [...n.axial.shape.relative].reverse()));
    expect(mirroredShape.checks.find((c) => c.id === "closedFormFuel")!.verdict, "the shape read from the top").toBe("fail");
    const mirroredCoolant = judge((n) => {
      n.axial.boundary.bulkTemperature = [...n.axial.boundary.bulkTemperature].reverse();
    });
    expect(mirroredCoolant.checks.find((c) => c.id === "wallTemperature")!.verdict, "the coolant read from the top").toBe("fail");
    const otherPower = judge((n) => (n.qPrime = n.qPrime * 1.1));
    expect(otherPower.checks.find((c) => c.id === "closedFormFuel")!.verdict, "10 % more heat").toBe("fail");
    expect(otherPower.checks.find((c) => c.id === "energyBalanceTotal")!.verdict).toBe("fail");
  }, 300_000);
});

void existsSync;
