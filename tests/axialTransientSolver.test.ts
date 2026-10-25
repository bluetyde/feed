// Plan 12 A3 through the real solver (needs FEED_SOLVER=1): a transient on an axial stack written by FEED's writer, run by the run manager, cut into slices and judged slice by slice
// with the transient checks of plan 08. Every check must pass on the real output; a control shows equal slices equal one slice; and the checks are shown to FAIL when the output
// is judged against a stack that is not the one that was run.
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { StackTransientRecord, buildStackTransientResults, computeIndependentStack } from "../src/core/stackTransientResults";
import { TransientResultsRecord } from "../src/core/transientResults";
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
const example = (id: string) => JSON.parse(readFileSync(join(root, "examples", id + ".json"), "utf8"));
const cosine = (L: number, N = 10) => ({ length: q(L, "m"), slices: N, powerShape: { kind: "cosine" } });
const GOLDEN = process.env.FEED_SAVE_GOLDEN ? join(root, "tests", "golden", "offbeat-stack-transient") : undefined;

async function run(d: unknown, save?: string) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-axialt-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 580_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const dir = join(runsRoot, s.id);
  const native = join(dir, "native");
  const tdir = join(native, "times");
  const names = readdirSync(tdir).filter((n) => /^[0-9.eE+-]+$/.test(n)).sort((a, b) => Number(a) - Number(b));
  const fields = names.map((n) => ({ time: Number(n), T: readFileSync(join(tdir, n, "T"), "utf8") }));
  const C = readFileSync(join(native, "final", "C"), "utf8");
  const normalized = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
  if (save) {
    mkdirSync(join(save, "times"), { recursive: true });
    writeFileSync(join(save, "C"), C);
    copyFileSync(join(dir, "normalized.json"), join(save, "normalized.json"));
    for (const f of fields) {
      mkdirSync(join(save, "times", String(f.time)), { recursive: true });
      writeFileSync(join(save, "times", String(f.time), "T"), f.T);
    }
  }
  return { res: mgr.results(s.id) as unknown as StackTransientRecord, fields, C, normalized };
}
const failing = (r: TransientResultsRecord) => r.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value + ": " + c.note.slice(0, 220));

describe.skipIf(!solverOn)("a transient on an axial stack through the real solver (needs FEED_SOLVER=1)", () => {
  it("a 10 ms pulse on an operating cosine stack (every slice starts at its own steady state): every check passes, the middle slices peak highest and the pulse follows the shape", async () => {
    const d = example("synthetic-pulse-operating");
    d.axial = cosine(0.381);
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "pulse") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.slices).toHaveLength(10);
    expect([4, 5]).toContain(res.axial.hottest);
    // the pulse adds heat in proportion to the slice's factor: a slice's own rise over its start follows it
    const rises = res.axial.slices.map((s) => s.maxT - s.peakT[0]!);
    expect(rises[4]!).toBeGreaterThan(rises[0]! * 3);
    expect(Math.abs(res.axial.slices[0]!.peakT[0]! - res.axial.slices[9]!.peakT[0]!)).toBeLessThan(1e-3);
  }, 600_000);

  it("a pump coastdown on a cosine stack (a boundary history, the same for every slice): every check passes", async () => {
    const d = example("synthetic-coastdown");
    d.axial = cosine(0.381);
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "coastdown") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.checks.find((c) => c.id === "energyBalanceTotal")!.verdict).toBe("pass");
  }, 600_000);

  it("a pulse on a short operating stack (0.06 m, 12 slices), where the axial conduction is 4 % of the rise: the checks pass, judged against the stack's two-dimensional solution because the heat along the height exceeds the pin's radial bound (plan 19 D1; the run manager started the reference job; golden output kept)", async () => {
    const d = example("synthetic-pulse-operating");
    d.axial = cosine(0.06, 12);
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "short") : undefined);
    expect(failing(res)).toEqual([]);
    expect(res.axial.conduction!.fraction).toBeGreaterThan(0.02);
    expect((res.axial as unknown as { reference?: { kind: string } }).reference?.kind).toBe("two-dimensional");
  }, 600_000);

  it("a pump coastdown over 60 s on a short stack (0.06 m, 12 slices), long enough for heat to flow along the pin: the checks pass against the stack's two-dimensional solution (plan 19 D1: the cross-check bound is about 6 K, not the allowance's 136 K; golden output kept)", async () => {
    const d = example("synthetic-coastdown");
    d.axial = cosine(0.06, 12);
    const { res } = await run(d, GOLDEN ? join(GOLDEN, "shortcool") : undefined);
    expect(failing(res)).toEqual([]);
    expect((res.axial as unknown as { reference?: { kind: string } }).reference?.kind).toBe("two-dimensional");
    const cross = res.checks.find((c) => c.id === "crossCheckFv")!;
    expect(Number(/bound ([0-9.]+) K/.exec(cross.note)![1])).toBeLessThan(10);
  }, 600_000);

  it("a control: five equal slices (a flat shape) give every slice the history of the one-slice pin at the same power", async () => {
    const flat = example("synthetic-pulse-operating");
    flat.axial = { length: q(0.5, "m"), slices: 5, powerShape: { kind: "flat" } };
    const a = await run(flat);
    expect(failing(a.res)).toEqual([]);
    const one = await run(example("synthetic-pulse-operating"));
    for (const s of a.res.axial.slices) s.peakT.forEach((T, j) => expect(Math.abs(T - one.res.series.peakT[j]!), "slice " + s.index + " output " + j).toBeLessThan(1e-3));
  }, 900_000);
});

describe.skipIf(!solverOn)("the checks fail when the output is judged against a stack that was not run", () => {
  it("an asymmetric shape read as its mirror, and a different power history, fail the cross-check of a real run", async () => {
    const d = example("synthetic-pulse-operating");
    d.axial = { length: q(0.381, "m"), slices: 10, powerShape: { kind: "table", points: [[0, 0.6], [0.19, 1.0], [0.381, 1.4]].map(([z, r]) => ({ position: q(z!, "m"), relativePower: q(r!, "1") })) } };
    const { fields, C, normalized } = await run(d, GOLDEN ? join(GOLDEN, "asym") : undefined);
    const judge = (mutate: (n: any) => void) => {
      const n = JSON.parse(JSON.stringify(normalized));
      mutate(n);
      return buildStackTransientResults(n, { C, fields }, computeIndependentStack(n));
    };
    expect(judge(() => undefined).checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual([]);
    expect(judge((n) => (n.axial.shape.relative = [...n.axial.shape.relative].reverse())).checks.find((c) => c.id === "crossCheckFv")!.verdict, "the shape read from the top").toBe("fail");
    expect(judge((n) => (n.transient.linearHeatRate = n.transient.linearHeatRate.map((x: number) => x * 1.2))).checks.find((c) => c.id === "crossCheckFv")!.verdict, "20 % more power").toBe("fail");
    void validateCase;
  }, 600_000);
});
