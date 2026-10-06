// Polynomial and tabulated conductivity through the real solver, by FEED's own writer (not an edited input, unlike tests/propertyModelProbe.test.ts), needs
// FEED_SOLVER=1: a cubic and a table on the steady pin against the closed form, a polynomial line against the linear route, a cubic in a transient, the range verdict.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/core/conductivity";
import { RunManager } from "../src/core/runManager";
import { ResultsRecord } from "../src/core/resultsParser";
import { TransientResultsRecord } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });
const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

const A = [2.0, 0.003, -1.2e-6, 2e-10];
const polySet = (a = A, range: [number, number] = [500, 2500]) => ({ model: "polynomial", a: q(a[0]!, "W/m/K"), b: q(a[1]!, "W/m/K2"), c: q(a[2]!, "W/m/K3"), d: q(a[3]!, "W/m/K4"), validRange: { min: q(range[0], "K"), max: q(range[1], "K") }, source: "test" });
const TABLE = [[300, 2.8], [600, 3.5], [900, 3.9], [1200, 4.05], [1500, 4.1]] as const;
const tableSet = () => ({ model: "table", points: TABLE.map(([T, k]) => ({ temperature: q(T, "K"), conductivity: q(k, "W/m/K") })), fit: { degree: 3, tolerance: q(2, "%") }, source: "test" });

const steadyDoc = (set: unknown, nf = 40, nc = 12) => {
  const d = read("examples/synthetic-pin.json");
  d.mesh = { fuelCells: nf, claddingCells: nc };
  d.materials.fuel.sets["thermal.conductivity"] = set;
  return d;
};
async function runCase(doc: unknown) {
  const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-polyk-")), backend: new WslBackend(), timeoutMs: 280_000 });
  const s = mgr.start(doc);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  return { rec, res: mgr.results(s.id) as ResultsRecord | TransientResultsRecord | undefined };
}
const allPass = (r: { checks: { verdict: string }[] }) => r.checks.every((c) => c.verdict === "pass");

describe.skipIf(!solverOn)("polynomial and tabulated conductivity through the real solver (needs FEED_SOLVER=1)", () => {
  it("a cubic on the steady pin: every check passes, including the closed form of the cubic (which fails if the T^2 sign were wrong), in-domain", async () => {
    const { rec, res } = await runCase(steadyDoc(polySet()));
    expect(rec.state).toBe("completed");
    const r = res as ResultsRecord;
    expect(allPass(r)).toBe(true);
    expect(r.domain.verdict).toBe("in-domain");
    expect(r.checks.find((c) => c.id === "closedFormFuel")!.value!).toBeLessThan(1.5);
    expect(r.summary.maxT).toBeGreaterThan(1100); // a real temperature dependence is in play
  }, 300_000);

  it("a table on the steady pin: it runs as its fitted polynomial, every check passes, and the result carries the fit's deviation", async () => {
    const { rec, res } = await runCase(steadyDoc(tableSet()));
    expect(rec.state).toBe("completed");
    const r = res as ResultsRecord;
    expect(allPass(r)).toBe(true);
    const fit = r.checks.find((c) => c.id === "conductivityFitFuel")!;
    expect(fit.verdict).toBe("pass");
    expect(fit.value!).toBeGreaterThan(0);
    expect(fit.value!).toBeLessThan(0.02);
    expect(fit.note).toMatch(/degree 3 polynomial fitted by least squares to 5 points from 300 to 1500 K/);
    expect(fit.note).toMatch(/OFFBEAT has no tabulated conductivity/);
    expect(r.domain.verdict).toBe("in-domain");
    expect(r.checks.find((c) => c.id === "conductivityFitCladding")).toBeUndefined(); // only a tabulated region has one
  }, 300_000);

  it("a polynomial line and the linear model give the same OFFBEAT result (ZyRELAP and steel1515TiTobbe carry the same law)", async () => {
    const lin = read("schema/vectors/good/linear-conductivity.json");
    const k = lin.materials.fuel.sets["thermal.conductivity"];
    const asPoly = JSON.parse(JSON.stringify(lin));
    const a = k.a.value;
    const b = k.b.value;
    asPoly.materials.fuel.sets["thermal.conductivity"] = polySet([a, b, 0, 0], [k.validRange.min.value, k.validRange.max.value]);
    const one = await runCase(lin);
    const two = await runCase(asPoly);
    expect(one.rec.state).toBe("completed");
    expect(two.rec.state).toBe("completed");
    const x = (one.res as ResultsRecord).radial;
    const y = (two.res as ResultsRecord).radial;
    expect(y.length).toBe(x.length);
    expect(Math.max(...x.map((p, i) => Math.abs(p.T - y[i]!.T)))).toBeLessThan(1e-4);
  }, 600_000);

  it("a cubic in a pulse: the independent finite-volume solution (with the cubic) agrees with OFFBEAT and every check passes", async () => {
    const d = read("examples/synthetic-pulse.json");
    d.materials.fuel.sets["thermal.conductivity"] = polySet(A, [250, 2500]);
    const { rec, res } = await runCase(d);
    expect(rec.state).toBe("completed");
    const r = res as TransientResultsRecord;
    expect(allPass(r)).toBe(true);
    expect(r.checks.find((c) => c.id === "crossCheckFv")!.verdict).toBe("pass");
    expect(r.domain.verdict).toBe("in-domain");
  }, 300_000);

  it("a cubic used outside its stated range is out-of-domain, and the check says so (never plain success)", async () => {
    const { rec, res } = await runCase(steadyDoc(polySet(A, [500, 900])));
    expect(rec.state).toBe("completed");
    const r = res as ResultsRecord;
    expect(r.domain.verdict).toBe("out-of-domain");
    expect(r.domain.findings[0]).toMatchObject({ region: "fuel", validRange: [500, 900] });
    expect(r.checks.find((c) => c.id === "propertyRange")!.verdict).toBe("fail");
  }, 300_000);

  it("between OFFBEAT's own fuel cells the conductivity integral of the temperature drop is the heat made between their radii (Simpson quadrature, nothing from the module)", async () => {
    const d = steadyDoc(polySet());
    const n = validateCase(d).normalized!;
    const { res } = await runCase(d);
    const fuel = (res as ResultsRecord).radial.filter((p) => p.region === "fuel");
    const simpson = (f: (x: number) => number, lo: number, hi: number, m = 600) => {
      const h = (hi - lo) / m;
      let s = f(lo) + f(hi);
      for (let i = 1; i < m; i++) s += (i % 2 ? 4 : 2) * f(lo + i * h);
      return (s * h) / 3;
    };
    // uniform heating of a solid cylinder: k dT/dr = -q' r / (2 pi R^2), so the integral of k dT from T(r2) to T(r1) is q' (r2^2 - r1^2) / (4 pi R^2)
    for (const [i, j] of [[0, fuel.length - 1], [0, 10], [10, 25], [25, fuel.length - 1]] as const) {
      const heat = (n.qPrime * (fuel[j]!.r ** 2 - fuel[i]!.r ** 2)) / (4 * Math.PI * n.fuelRadius ** 2);
      const integral = simpson((T) => evaluate(A, T), fuel[j]!.T, fuel[i]!.T);
      expect(Math.abs(integral - heat) / heat, `cells ${i} to ${j}`).toBeLessThan(0.01);
    }
  }, 300_000);
});
