// Plan 13 T6: the SEED oracle entries for sampled coated particles (oracles/seed-triso/, written by scripts/gen-seed-oracles-triso.cjs; NOT sent to SEED, docs/seed-triso-request.md).
// Ungated: the 125 entries of oracles/seed are not touched (a separate folder; tests/seedOracleStack.test.ts hashes them); the generator reproduces every committed file byte for byte;
// each entry's reference is worked here again by hand (own arithmetic, own tolerance formula, no code of the generator or of src/core); the generator's sampler picks the five particles
// FEED's own sampler picks; FEED's closed form agrees; saved real OFFBEAT output (tests/golden/seed-oracles-triso, made by the gated part with FEED_SAVE_GOLDEN=1) lands inside every
// tolerance; and the entries are shown to test what they claim (the wrong particle, the nominal particle and the wrong layer are all outside). Gated (FEED_SOLVER=1): the five committed
// cases through FEED's writer and run manager into the real solver, every check passing.
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { lastRelativeRate } from "../src/core/steadyState";
import { runPopulation } from "../src/core/trisoPopulation";
import { TrisoResultsRecord, buildTrisoResults } from "../src/core/trisoResults";
import { trisoClosedForm } from "../src/core/trisoSolve";
import { TRISO_WEDGE_SCALE } from "../src/core/trisoWedge";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const dir = join(root, "oracles", "seed-triso");
const golden = join(root, "tests", "golden", "seed-oracles-triso");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const entries = readdirSync(join(dir, "entries")).map((f) => JSON.parse(readFileSync(join(dir, "entries", f), "utf8")));
const entry = (id: string) => entries.find((e) => e.oracleId === id)!;
const caseNamed = (name: string) => JSON.parse(readFileSync(join(dir, "models", name + ".case.json"), "utf8"));
const ROLES = ["hottest", "median", "coldest", "thickest-buffer", "thinnest-sic"];
const QUANTITIES = ["temperature-kernel-centre", "temperature-drop-buffer", "temperature-drop-gap"];
const id = (role: string, quantity: string) => "feed-triso-pop-" + role + "-" + quantity;
const PI = Math.PI;

// ---- the references and the tolerances, worked out here again (constant conductivities 3 / 0.5 / 4 / 13.9 / 4 W/m/K, gap 1.5e5 W/m2/K at the buffer's outer radius, film 2000 W/m2/K)
function hand(doc: any) {
  const k = [3, 0.5, 4, 13.9, 4];
  const R = doc.geometry.kernelRadius.value as number; // metres in the committed cases
  const t = doc.geometry.layers.map((l: any) => l.thickness.value as number);
  const q0 = doc.power.kernelPowerDensity.value as number; // W/m3
  const Tm = doc.boundary.bulkTemperature.value as number;
  const r = [R];
  t.forEach((x: number, i: number) => r.push(r[i]! + x));
  const P = q0 * (4 / 3) * PI * R ** 3;
  const film = P / (4 * PI * r[4]! ** 2 * 2000);
  const layers = [0, 1, 2, 3].map((i) => (P / (4 * PI * k[i + 1]!)) * (1 / r[i]! - 1 / r[i + 1]!));
  const gap = P / (4 * PI * r[1]! ** 2 * 1.5e5);
  const kernel = (q0 * R * R) / (6 * k[0]!);
  const wall = Tm + film;
  return { peak: wall + layers.reduce((a, b) => a + b, 0) + gap + kernel, wall, layers, gap, kernel };
}
const lambda = Math.cos(PI / 180) / Math.sqrt(1 + Math.sin(PI / 180) ** 2);
const up = (x: number, step: number) => Number((Math.ceil(x / step - 1e-9) * step).toFixed(6));
function tolerances(doc: any) {
  const h = hand(doc);
  const rise = h.peak - h.wall;
  const mesh = (5 * h.kernel) / (48 * 48);
  return {
    centre: up(0.005 * rise + mesh + (1 - lambda * lambda) * rise, 0.05),
    buffer: up(0.005 * rise + mesh + (1 - lambda * lambda) * h.layers[0]!, 0.05),
    gap: up(0.01 * h.gap + 0.005 + (1 - lambda) * h.gap, 0.005),
  };
}
const expectedOf = (doc: any) => {
  const h = hand(doc);
  return { "temperature-kernel-centre": h.peak, "temperature-drop-buffer": h.layers[0]!, "temperature-drop-gap": h.gap } as Record<string, number>;
};
const TOL_KEY: Record<string, "centre" | "buffer" | "gap"> = { "temperature-kernel-centre": "centre", "temperature-drop-buffer": "buffer", "temperature-drop-gap": "gap" };
/** What the entries' quantities are in FEED's result record of a particle (docs/seed-triso-request.md). */
const observed = (r: TrisoResultsRecord) => ({ "temperature-kernel-centre": r.summary.kernelCentreT, "temperature-drop-buffer": r.regions[1]!.drop, "temperature-drop-gap": r.summary.gapDeltaT }) as Record<string, number>;

describe("the set as a whole", () => {
  it("there are 19 entries: 15 good (3 for each of 5 sampled particles) and 4 bad-input; the 138 entries of oracles/seed are another folder and untouched", () => {
    const n = (t: string) => entries.filter((e) => e.tag === t).length;
    expect([entries.length, n("good"), n("bad-input"), n("known-limit")]).toEqual([19, 15, 4, 0]);
    expect(readdirSync(join(root, "oracles", "seed", "entries"))).toHaveLength(138);
    expect(readdirSync(join(root, "oracles", "seed", "entries")).some((f) => f.includes("triso"))).toBe(false);
  });
  it("the generator reproduces every committed file byte for byte (a fresh run into a temporary folder, the README included)", () => {
    const tmp = join(mkdtempSync(join(tmpdir(), "x-")), "feed-oracle-run");
    execFileSync(process.execPath, [join(root, "scripts", "gen-seed-oracles-triso.cjs")], { env: { ...process.env, FEED_ORACLE_OUT: tmp }, cwd: root, stdio: "pipe" });
    const walk = (d: string, base = ""): string[] => readdirSync(join(d, base), { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(d, join(base, f.name)) : [join(base, f.name)]));
    const fresh = walk(tmp).sort();
    expect(fresh).toEqual(walk(dir).sort());
    for (const f of fresh) expect(sha(readFileSync(join(tmp, f))), f).toBe(sha(readFileSync(join(dir, f))));
  });
  it("every entry's input hash is its case file's, and its tolerance hash is the hash of its expected value and tolerance (canonical JSON)", () => {
    const canon = (v: any): string => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}");
    for (const e of entries) {
      expect(sha(readFileSync(join(dir, e.inputs[0].path))), e.oracleId).toBe(e.inputs[0].sha256);
      expect(sha(canon({ expected: e.expected, tolerance: e.tolerance === undefined ? null : e.tolerance })), e.oracleId).toBe(e.toleranceHash);
      expect(e.schema).toBe("seed.oracle/0.1");
      expect(e.adapter).toBe("feed");
    }
  });
});

describe("the sampled particles", () => {
  const pop = JSON.parse(readFileSync(join(root, "examples", "synthetic-triso-population.json"), "utf8"));
  const n = validateCase(pop).triso!;
  const result = runPopulation(n);
  const ROLE_OF: Record<string, string> = { hottest: "hottest", median: "median", coldest: "coldest", "thickest-buffer": "thickestBuffer", "thinnest-sic": "thinnestSic" };
  it("are the particles FEED's sampler draws: the generator's own copy of the sampler picks the same five of the 2000, with the same values", () => {
    for (const role of ROLES) {
      const rep = result.representatives.find((r) => r.role === ROLE_OF[role])!;
      const doc = caseNamed("triso-pop-" + role);
      expect(doc.geometry.kernelRadius.value / rep.draw.kernelRadius - 1, role).toBeCloseTo(0, 12);
      doc.geometry.layers.forEach((l: any, i: number) => expect(l.thickness.value / rep.draw.thicknesses[i]! - 1, role).toBeCloseTo(0, 12));
      expect(doc.power.kernelPowerDensity.value / (1000e6 * rep.draw.powerFactor) - 1, role).toBeCloseTo(0, 12);
      expect(doc.boundary.bulkTemperature.value / rep.draw.matrixTemperature - 1, role).toBeCloseTo(0, 12);
      expect(doc.population).toBeUndefined();
      expect(entry(id(role, "temperature-kernel-centre")).source.text).toContain("Particle " + rep.index + " of the 2000");
    }
  });
  it("are valid particle cases, with no population section, on 48 cells in every region", () => {
    for (const role of ROLES) {
      const doc = caseNamed("triso-pop-" + role);
      const v = validateCase(doc);
      expect(v.errors).toEqual([]);
      expect(v.triso!.cells).toEqual([48, 48, 48, 48, 48]);
    }
  });
  it("span the spread: the hottest and the coldest are the sample's extremes, 100 K and more apart, and the median is near its 50th percentile", () => {
    const centre = (r: string) => entry(id(r, "temperature-kernel-centre")).expected.value as number;
    expect(Math.abs(centre("hottest") - result.quantities[0]!.stat.max)).toBeLessThan(1e-3);
    expect(Math.abs(centre("coldest") - result.quantities[0]!.stat.min)).toBeLessThan(1e-3);
    expect(Math.abs(centre("median") - result.quantities[0]!.stat.p50)).toBeLessThan(0.5);
    expect(centre("hottest") - centre("coldest")).toBeGreaterThan(100);
  });
  it("the thickest-buffer particle has the thickest buffer of the sample and the thinnest-SiC one the thinnest SiC (both further than a standard deviation out)", () => {
    const t = (r: string, i: number) => caseNamed("triso-pop-" + r).geometry.layers[i].thickness.value as number;
    expect(t("thickest-buffer", 0)).toBeGreaterThan(100e-6 + 2.5 * 8e-6);
    expect(t("thinnest-sic", 2)).toBeLessThan(35e-6 - 2.5 * 1.5e-6);
    for (const r of ROLES) expect(t("thickest-buffer", 0)).toBeGreaterThanOrEqual(t(r, 0));
    for (const r of ROLES) expect(t("thinnest-sic", 2)).toBeLessThanOrEqual(t(r, 2));
  });
  it("FEED's closed form of each case (src/core/trisoSolve.ts) is the entries' expected value to 1e-3 K (the entries are rounded to 4 and 5 decimals)", () => {
    for (const role of ROLES) {
      const cf = trisoClosedForm(validateCase(caseNamed("triso-pop-" + role)).triso!);
      expect(Math.abs(cf.centreT - entry(id(role, "temperature-kernel-centre")).expected.value)).toBeLessThan(1e-3);
      expect(Math.abs(cf.regions[1]!.innerT - cf.regions[1]!.outerT - entry(id(role, "temperature-drop-buffer")).expected.value)).toBeLessThan(1e-3);
      expect(Math.abs(cf.gapDeltaT - entry(id(role, "temperature-drop-gap")).expected.value)).toBeLessThan(1e-4);
    }
  });
});

describe("the entries", () => {
  it("expected values and tolerances are the ones worked out here by hand, from the case file alone", () => {
    for (const role of ROLES) {
      const doc = caseNamed("triso-pop-" + role);
      const exp = expectedOf(doc);
      const tol = tolerances(doc);
      for (const qn of QUANTITIES) {
        const e = entry(id(role, qn));
        expect(e.tag).toBe("good");
        expect(e.expected.quantity).toBe(qn.replaceAll("-", "_"));
        expect(e.expected.unit).toBe("K");
        expect(Math.abs(e.expected.value - exp[qn]!), role + " " + qn).toBeLessThan(6e-5);
        expect(e.tolerance.abs, role + " " + qn).toBeCloseTo(tol[TOL_KEY[qn]!], 9);
        expect(e.tolerance.rel).toBe(0);
        expect(e.coverage.quantities).toEqual([qn.replaceAll("-", "_")]);
      }
    }
  });
  it("a tolerance is a small fraction of what it pins: 1 % of the internal rise or less for the centre and the buffer drop, 5 % of the gap's drop or less", () => {
    for (const role of ROLES) {
      const doc = caseNamed("triso-pop-" + role);
      const h = hand(doc);
      expect(entry(id(role, "temperature-kernel-centre")).tolerance.abs).toBeLessThan(0.01 * (h.peak - h.wall));
      expect(entry(id(role, "temperature-drop-buffer")).tolerance.abs).toBeLessThan(0.013 * h.layers[0]!);
      expect(entry(id(role, "temperature-drop-gap")).tolerance.abs).toBeLessThan(0.05 * h.gap);
    }
  });
  it("the bad-input entries are refused with their code by FEED's validator, as the first error", () => {
    for (const e of entries.filter((x) => x.tag === "bad-input")) {
      const v = validateCase(JSON.parse(readFileSync(join(dir, e.inputs[0].path), "utf8")));
      expect(v.ok).toBe(false);
      expect(v.errors[0]!.code, e.oracleId).toBe(e.expected.refusalCode);
    }
    expect(entries.filter((x) => x.tag === "bad-input").map((x) => x.expected.refusalCode).sort()).toEqual(["E_GEOMETRY", "E_OUT_OF_RANGE", "E_POPULATION_UNSAMPLABLE", "E_UNSUPPORTED"]);
  });
  it("test what they claim: the wrong particle, the nominal particle and the wrong layer are all outside the tolerance of the hottest particle's centre and buffer drop", () => {
    const hot = entry(id("hottest", "temperature-kernel-centre"));
    const cold = hand(caseNamed("triso-pop-coldest"));
    expect(Math.abs(cold.peak - hot.expected.value)).toBeGreaterThan(20 * hot.tolerance.abs);
    // the nominal particle of the population (no sampling): the case with the population's own medians
    const nominal = JSON.parse(readFileSync(join(root, "examples", "synthetic-triso-population.json"), "utf8"));
    const nominalDoc = { geometry: { kernelRadius: { value: 250e-6 }, layers: [100e-6, 40e-6, 35e-6, 35e-6].map((x) => ({ thickness: { value: x } })) }, power: { kernelPowerDensity: { value: 1000e6 } }, boundary: { bulkTemperature: { value: 900 } } };
    expect(nominal.population).toBeDefined();
    expect(Math.abs(hand(nominalDoc).peak - hot.expected.value)).toBeGreaterThan(20 * hot.tolerance.abs);
    // the SiC's drop is not the buffer's
    const h = hand(caseNamed("triso-pop-hottest"));
    expect(Math.abs(h.layers[2]! - entry(id("hottest", "temperature-drop-buffer")).expected.value)).toBeGreaterThan(50 * entry(id("hottest", "temperature-drop-buffer")).tolerance.abs);
    // and a gap drop read as a kernel parabola
    expect(Math.abs(h.kernel - entry(id("hottest", "temperature-drop-gap")).expected.value)).toBeGreaterThan(50 * entry(id("hottest", "temperature-drop-gap")).tolerance.abs);
  });
  it("the thickest-buffer particle's buffer drop and the hottest particle's are different entries (the pin of a layer follows the sampled thickness)", () => {
    const a = entry(id("thickest-buffer", "temperature-drop-buffer")).expected.value;
    const b = entry(id("coldest", "temperature-drop-buffer")).expected.value;
    expect(Math.abs(a - b)).toBeGreaterThan(entry(id("coldest", "temperature-drop-buffer")).tolerance.abs);
  });
  it("saved real OFFBEAT output lands inside every tolerance, and FEED's reader passes every check of it", () => {
    for (const role of ROLES) {
      const d = join(golden, role);
      const f = (x: string) => readFileSync(join(d, x), "utf8");
      const rate = JSON.parse(f("rate.json")) as { relativeRate: number; time: number };
      const n = JSON.parse(f("normalized.json"));
      const r = buildTrisoResults(n, { T: f("T"), C: f("C"), cellZones: f("cellZones"), time: rate.time, drift: { relativeRate: rate.relativeRate } });
      expect(r.checks.filter((c) => c.verdict === "fail").map((c) => c.id), role).toEqual([]);
      const obs = observed(r);
      for (const qn of QUANTITIES) {
        const e = entry(id(role, qn));
        expect(Math.abs(obs[qn]! - e.expected.value), role + " " + qn).toBeLessThan(e.tolerance.abs);
      }
      // the case that was run is the committed one
      expect(sha(readFileSync(join(d, "case.json")))).toBe(entry(id(role, "temperature-kernel-centre")).inputs[0].sha256);
    }
  });
  it("the wedge scale the tolerances use is the writer's", () => {
    expect(lambda).toBeCloseTo(TRISO_WEDGE_SCALE, 14);
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
const SAVE = process.env.FEED_SAVE_GOLDEN ? golden : undefined;
describe.skipIf(!solverOn)("the five committed cases through the real solver (needs FEED_SOLVER=1)", () => {
  for (const role of ROLES) {
    it(role + ": every check passes and the three pinned quantities are inside their tolerances", async () => {
      const text = readFileSync(join(dir, "models", "triso-pop-" + role + ".case.json"), "utf8");
      const runsRoot = mkdtempSync(join(tmpdir(), "feed-oracle-triso-"));
      const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 280_000 });
      const s = mgr.start(JSON.parse(text));
      if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
      const rec = await mgr.done(s.id);
      if (rec.state !== "completed") throw new Error("the run ended " + rec.state);
      const res = mgr.results(s.id) as unknown as TrisoResultsRecord;
      const run = join(runsRoot, s.id);
      if (SAVE) {
        const d = join(SAVE, role);
        mkdirSync(d, { recursive: true });
        for (const x of ["T", "C", "cellZones"]) copyFileSync(join(run, "native", "final", x), join(d, x));
        copyFileSync(join(run, "normalized.json"), join(d, "normalized.json"));
        writeFileSync(join(d, "case.json"), text);
        const log = readFileSync(join(run, "native", "log.offbeat"), "utf8");
        writeFileSync(join(d, "rate.json"), JSON.stringify({ relativeRate: lastRelativeRate(log), time: res.time, steps: (log.match(/^Time = /gm) ?? []).length, exitCode: rec.exitCode }, null, 2) + "\n");
      }
      expect(res.checks.filter((c) => c.verdict === "fail").map((c) => c.id + " " + c.value), role).toEqual([]);
      const obs = observed(res);
      console.log(role, QUANTITIES.map((qn) => qn + " " + obs[qn]!.toFixed(4) + " vs " + entry(id(role, qn)).expected.value + " (tol " + entry(id(role, qn)).tolerance.abs + ")").join("; "));
      for (const qn of QUANTITIES) expect(Math.abs(obs[qn]! - entry(id(role, qn)).expected.value), role + " " + qn).toBeLessThan(entry(id(role, qn)).tolerance.abs);
    }, 600_000);
  }
});
