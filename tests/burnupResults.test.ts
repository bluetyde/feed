// The checks of a burnup case's results (src/core/resultsParser.ts, docs/plans/10-burnup.md M3), on the REAL fields OFFBEAT wrote for FEED's own burnup case
// (tests/golden/offbeat-burnup: the 20 kW/m synthetic pin, 20 + 6 cells, UO2 at 95 % density, 40 MWd/kgHM, T C k Bu of the last time), and on damaged copies of them.
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { BURNUP_BU_TOLERANCE, BURNUP_K_TOLERANCE, buildResults, burnupText, ResultsError, THERMAL_ONLY_TEXT } from "../src/core/resultsParser";
import { resultsToCsv } from "../src/core/exportResults";
import { RunManager } from "../src/core/runManager";
import { validateCase } from "../src/core/validate";
import { FakeBackend, Script } from "./helpers/fakeBackend";

const root = join(__dirname, "..");
const g = (f: string) => readFileSync(join(root, "tests/golden/offbeat-burnup", f), "utf8");
const { T, C, k, Bu } = { T: g("T"), C: g("C"), k: g("k"), Bu: g("Bu") };
const q = (value: number, unit: string) => ({ value, unit });
const pin = (B = 40) => {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.power.linearHeatRate = q(20, "kW/m");
  d.materials.fuel.sets["thermal.conductivity"] = { model: "uo2-nfi", densityFraction: q(95, "%"), source: "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11" };
  d.burnup = { value: q(B, "MWd/kgHM"), basis: "heavy-metal", source: "chosen for the study" };
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
};
const build = (over: { k?: string | undefined; Bu?: string | undefined; T?: string; n?: ReturnType<typeof pin> } = {}) =>
  buildResults(over.n ?? pin(), { T: over.T ?? T, C, k: "k" in over ? over.k : k, Bu: "Bu" in over ? over.Bu : Bu, time: 5e7 });
/** A field file cut short after its complete cell list: no boundary block, no footer. */
const cut = (text: string) => text.slice(0, text.lastIndexOf("boundaryField"));
const check = (r: ReturnType<typeof build>, id: string) => r.checks.find((c) => c.id === id)!;
/** The list of a nonuniform scalar field with each value of the fuel cells passed through f. */
const mapCells = (text: string, f: (v: number, i: number) => number) => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "(");
  for (let i = 0; i < 26; i++) lines[start + 1 + i] = String(f(Number(lines[start + 1 + i]), i));
  return lines.join("\n");
};

describe("a burnup result from real OFFBEAT fields", () => {
  const r = build();
  it("every check passes: the closed form of the law, the balance, the conductivity field and the burnup field", () => {
    expect(r.checks.filter((c) => c.verdict !== "pass").map((c) => c.id + " " + c.value)).toEqual([]);
    expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["closedFormFuel", "energyBalance", "burnupConductivity", "burnupWritten"]));
  });
  it("OFFBEAT's k equals the law in every fuel cell to the printed digits, and Bu is what was written", () => {
    expect(check(r, "burnupConductivity").value!).toBeLessThan(1e-5);
    expect(check(r, "burnupConductivity").note).toMatch(/20 fuel cells.*40 MWd\/kgHM.*Largest relative difference/);
    expect(check(r, "burnupWritten").value!).toBeLessThan(1e-6);
    expect(check(r, "burnupWritten").note).toMatch(/40 MWd\/kgHM x 1000 x 0\.881 = 35240 MWd\/t of oxide/);
  });
  it("the record says it is a frozen-burnup snapshot and carries the burnup and its source", () => {
    expect(r.thermalOnly).toBe(THERMAL_ONLY_TEXT + " " + burnupText(40));
    expect(r.thermalOnly).toMatch(/^Thermal-only result\. .*Frozen-burnup snapshot: .*40 MWd per kg of heavy metal.*no swelling, densification, relocation or fission-gas release.*not the closed gap.*not a fuel-performance prediction/);
    expect(r.burnup).toEqual({ value: 40, source: "chosen for the study" });
    expect(resultsToCsv(r, { runId: "r1", caseName: "burnup", solver: "OFFBEAT", caseHash: "x" })).toContain("Frozen-burnup snapshot");
  });
  it("a case without a burnup has the plain banner, no burnup record and no burnup checks", () => {
    const plain = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
    const n = validateCase(plain).normalized!;
    const res = buildResults(n, { T: readFileSync(join(root, "tests/golden/offbeat-syn/T"), "utf8"), C: readFileSync(join(root, "tests/golden/offbeat-syn/C"), "utf8"), time: 5e7 });
    expect(res.thermalOnly).toBe(THERMAL_ONLY_TEXT);
    expect(res.burnup).toBeUndefined();
    expect(res.checks.some((c) => c.id.startsWith("burnup"))).toBe(false);
  });
});

describe("the burnup checks fail what is wrong, and a result without the evidence does not pass", () => {
  it("a conductivity field 1 % off in one fuel cell fails, naming the cell; 1e-4 off is the limit", () => {
    const bad = build({ k: mapCells(k, (v, i) => (i === 7 ? v * 1.01 : v)) });
    expect(check(bad, "burnupConductivity").verdict).toBe("fail");
    expect(check(bad, "burnupConductivity").note).toMatch(/at fuel cell 7/);
    expect(check(build({ k: mapCells(k, (v, i) => (i < 20 ? v * (1 + 0.5e-4) : v)) }), "burnupConductivity").verdict).toBe("pass");
    expect(check(build({ k: mapCells(k, (v, i) => (i < 20 ? v * (1 + 2e-4) : v)) }), "burnupConductivity").verdict).toBe("fail");
  });
  it("a k or Bu field cut short after its complete cell list is refused, as T and C are", () => {
    expect(() => build({ k: cut(k) })).toThrow(/footer|cut short/);
    expect(() => build({ Bu: cut(Bu) })).toThrow(/footer|cut short/);
  });
  it("the cladding's k is not judged against the fuel law (only the fuel cells are)", () => {
    expect(check(build({ k: mapCells(k, (v, i) => (i >= 20 ? v * 2 : v)) }), "burnupConductivity").verdict).toBe("pass");
  });
  it("the Bu tolerance is 1e-5 (written here, not read from the module): half of it passes, twice it fails", () => {
    expect(check(build({ Bu: mapCells(Bu, (v, i) => (i < 20 ? v * (1 + 0.5e-5) : v)) }), "burnupWritten").verdict).toBe("pass");
    expect(check(build({ Bu: mapCells(Bu, (v, i) => (i < 20 ? v * (1 + 2e-5) : v)) }), "burnupWritten").verdict).toBe("fail");
  });
  it("a Bu written on the wrong basis (0.8815 for 0.881, the Lassmann constant) fails the burnup check", () => {
    const wrong = build({ Bu: mapCells(Bu, (v, i) => (i < 20 ? (v * 0.8815) / 0.881 : v)) });
    expect(check(wrong, "burnupWritten").verdict).toBe("fail");
    expect(check(wrong, "burnupWritten").value!).toBeGreaterThan(5e-4);
  });
  it("a burnup in the cladding, or a case burnup that is not the one written, fails", () => {
    expect(check(build({ Bu: mapCells(Bu, (v, i) => (i === 22 ? 1 : v)) }), "burnupWritten").verdict).toBe("fail");
    expect(check(build({ n: pin(30) }), "burnupWritten").verdict).toBe("fail"); // the fields are those of 40 MWd/kgHM
    expect(check(build({ n: pin(30) }), "burnupConductivity").verdict).toBe("fail"); // and so is k
  });
  it("a missing k or Bu field fails its check, with a note saying so, and does not pass for want of evidence", () => {
    const a = build({ k: undefined });
    expect(check(a, "burnupConductivity")).toMatchObject({ verdict: "fail", value: null });
    expect(check(a, "burnupConductivity").note).toMatch(/OFFBEAT wrote no conductivity \(k\) field/);
    const b = build({ Bu: undefined });
    expect(check(b, "burnupWritten")).toMatchObject({ verdict: "fail", value: null });
    expect(check(b, "burnupWritten").note).toMatch(/OFFBEAT wrote no burnup \(Bu\) field/);
  });
  it("a field that is not finite, or has the wrong number of cells, is refused as an incomplete output", () => {
    expect(() => build({ k: mapCells(k, (v, i) => (i === 3 ? NaN : v)) })).toThrow(ResultsError);
    expect(() => build({ k: k.replace(/\n26\n\(/, "\n25\n(") })).toThrow(ResultsError);
  });
  it("a field that is consistent in itself but has another number of cells than the case is refused", () => {
    const lines = k.split("\n");
    const start = lines.findIndex((l) => l.trim() === "(");
    lines.splice(start + 26, 1); // one cell fewer, and the header says so
    const short = lines.join("\n").replace(/\n26\n\(/, "\n25\n(");
    expect(() => build({ k: short })).toThrow(/has 25 cells, the case has 26/);
  });
  it("a Bu that OFFBEAT wrote compactly as `uniform 0` is read as 0 in every cell: right for a fresh fuel, wrong for 40 MWd/kgHM", () => {
    const uniform0 = Bu.replace(/internalField\s+nonuniform List<scalar>\s*\n\d+\s*\n\([\s\S]*?\n\)\s*\n;/, "internalField   uniform 0;");
    expect(uniform0).toContain("internalField   uniform 0;");
    expect(check(build({ Bu: uniform0 }), "burnupWritten").verdict).toBe("fail");
    expect(BURNUP_BU_TOLERANCE).toBeLessThan(1e-4);
  });
});

describe("through the run manager (a scripted backend writing the real OFFBEAT fields)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const runWith = async (script: Script) => {
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-bu-runs-"));
    dirs.push(runsRoot);
    const mgr = new RunManager({ runsRoot, backend: new FakeBackend(script) });
    const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
    d.power.linearHeatRate = q(20, "kW/m");
    d.materials.fuel.sets["thermal.conductivity"] = { model: "uo2-nfi", densityFraction: q(95, "%"), source: "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11" };
    d.burnup = { value: q(40, "MWd/kgHM"), basis: "heavy-metal", source: "chosen for the study" };
    const s = mgr.start(d);
    if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
    const rec = await mgr.done(s.id);
    return { rec, res: mgr.results(s.id) as ReturnType<typeof build> | undefined, mgr, id: s.id };
  };
  it("the run completes, its record carries the burnup sentence and every check passes", async () => {
    const { rec, res } = await runWith("burnup-good");
    expect(rec.state).toBe("completed");
    expect(res!.checks.filter((c) => c.verdict !== "pass").map((c) => c.id)).toEqual([]);
    expect(res!.thermalOnly).toMatch(/Frozen-burnup snapshot/);
    expect(res!.burnup!.value).toBe(40);
  });
  it("without OFFBEAT's k field the check fails, and a Bu on the wrong basis fails the burnup check: neither is called a success", async () => {
    const a = await runWith("burnup-no-k");
    expect(a.res!.checks.find((c) => c.id === "burnupConductivity")!.verdict).toBe("fail");
    const b = await runWith("burnup-wrong-basis");
    expect(b.res!.checks.find((c) => c.id === "burnupWritten")!.verdict).toBe("fail");
    for (const r of [a, b]) expect(r.res!.checks.some((c) => c.verdict === "fail")).toBe(true);
  });
});
