// Plan 13 T5 through the real solver (needs FEED_SOLVER=1): the particles the editor builds (the starting case, a layer removed or added, a transient switched on) are run by the run manager,
// every check passes, and the numbers the results view shows (per-region rows, the regions' peaks) are those in the record the solver's output was read into.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const script = readFileSync(join(root, "src/web/index.html"), "utf8").match(/<script>([\s\S]*)<\/script>/)![1]!;
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();
function pure(doc: any) {
  const block = script.slice(script.indexOf("/* particle-pure:begin"), script.indexOf("/* particle-pure:end */"));
  return new Function("doc", "let logText = ''; " + block + "; return { defaultParticle, particleRemoveLayer, particleAddLayer, particleAnalysis, particleInitial, particleRegionRows, particleRegionPeaks, tempInRegion };")(doc) as Record<string, any>;
}
async function run(d: unknown) {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-pe-run-"));
  const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(d);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  if (rec.state !== "completed") throw new Error("the run ended " + rec.state + ": " + JSON.stringify(rec.failure).slice(0, 1500));
  const normalized = JSON.parse(readFileSync(join(runsRoot, s.id, "normalized.json"), "utf8"));
  return { res: mgr.results(s.id) as any, normalized, rec };
}
const failing = (r: any) => r.checks.filter((c: any) => c.verdict === "fail").map((c: any) => c.id + " " + c.value);

describe.skipIf(!solverOn)("the particles the editor builds, through the real solver (needs FEED_SOLVER=1)", () => {
  it("the starting case runs and every check passes; the results view's rows are the record's: the drops and the gap add up to the whole rise, the first row's inner face is the kernel centre", async () => {
    const d = pure(null).defaultParticle();
    const { res, normalized } = await run(d);
    expect(failing(res)).toEqual([]);
    const rows = pure(d).particleRegionRows(res, normalized);
    expect(rows.map((r: any) => r.name)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    expect(rows[0].innerT).toBe(res.summary.kernelCentreT);
    const total = rows.reduce((a: number, r: any) => a + r.drop, 0) + res.summary.gapDeltaT;
    expect(total).toBeCloseTo(res.summary.kernelCentreT - res.summary.wallT, 6);
    // the colour of the picture at a ring in a layer is a cell's temperature between that region's cells
    const T = pure(d).tempInRegion(res.cells, "sic", (normalized.layers[2].innerRadius + normalized.layers[2].outerRadius) / 2);
    expect(T).toBeGreaterThan(res.summary.wallT);
    expect(T).toBeLessThan(res.summary.kernelSurfaceT);
  }, 300_000);
  it("a particle with the two outer layers removed (the page's button) and one with them added back run, and the two-layer one has two layer rows", async () => {
    const d = pure(null).defaultParticle();
    const h = pure(d);
    h.particleRemoveLayer();
    h.particleRemoveLayer();
    const two = await run(d);
    expect(failing(two.res)).toEqual([]);
    expect(h.particleRegionRows(two.res, two.normalized).map((r: any) => r.name)).toEqual(["kernel", "buffer", "ipyc"]);
    h.particleAddLayer();
    h.particleAddLayer();
    const four = await run(d);
    expect(failing(four.res)).toEqual([]);
    expect(h.particleRegionRows(four.res, four.normalized)).toHaveLength(5);
  }, 600_000);
  it("the transient the page switches on runs from a uniform and from a steady start, every check passes, and the region peaks are the record's: the kernel's is the hottest cell", async () => {
    const d = pure(null).defaultParticle();
    const h = pure(d);
    h.particleAnalysis("transient");
    const uniform = await run(d);
    expect(failing(uniform.res)).toEqual([]);
    const peaks = h.particleRegionPeaks(uniform.res);
    expect(peaks.map((p: any) => p.name)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    expect(peaks[0].peak).toBeCloseTo(uniform.res.summary.maxT, 9);
    expect(peaks[0].time).toBeCloseTo(uniform.res.summary.timeOfMaxT, 12);
    h.particleInitial("steady");
    const steady = await run(d);
    expect(failing(steady.res)).toEqual([]);
    expect(steady.res.initialState.kind).toBe("steady");
    expect(steady.res.summary.maxT).toBeGreaterThan(uniform.res.summary.maxT); // it starts from a warm particle: the pulse rides on the steady rise
  }, 600_000);
});
