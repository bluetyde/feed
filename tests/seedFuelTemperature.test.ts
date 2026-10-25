// SEED's power-temperature loop, FEED's part (the owner's word, 2026-10-25; brief from the SEED session: docs/coupling-prerequisites.md sections 2 to 4 and transfer-recipe.md of SEED).
// The return quantity is the fuel temperature by axial slice: declared in `describe`, carried in a steady result, with its axis, unit, normalization, slice bounds, pin geometry and meaning.
//   1. the declared quantity (describe, the record's shape, its values against an independent closed form and against the stack's two-dimensional reference);
//   2. applying heating again REPLACES the earlier heating in the case (never accumulates);
//   3. the same input gives the same output;
//   4. a thermal solve that does not converge is a typed failure and no result;
//   (5, the oracle entries: tests/seedOracleStack.test.ts and scripts/gen-seed-oracles.cjs.)
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { sliceCase, sliceLoads } from "../src/core/axial";
import { FUEL_MEAN_ALL, FUEL_MEAN_MAX, FUEL_MEAN_MIN, FUEL_MEAN_SERIES, fuelTemperatureRecord, fuelVolumeMean } from "../src/core/fuelTemperature";
import { buildResults } from "../src/core/resultsParser";
import { RunManager } from "../src/core/runManager";
import { buildStackResults } from "../src/core/stackResults";
import { stackReference } from "../src/core/stackReference";
import { transferHeating } from "../src/core/transferRequest";
import { sliceClosedForm } from "../src/core/resultsParser";
import { validateCase } from "../src/core/validate";
import { FakeBackend, Script } from "./helpers/fakeBackend";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const golden = (dir: string, name: string) => ({ n: JSON.parse(read("tests/golden", dir, name, "normalized.json")), T: read("tests/golden", dir, name, "T"), C: read("tests/golden", dir, name, "C") });

/** The exact mean of a solid pin's fuel temperature over its cross-section from the one-dimensional closed form of the slice (Simpson over the annulus), no cell of the solver in it. */
function exactFuelMean(sliceCaseN: Parameters<typeof sliceClosedForm>[0]): number {
  const cf = sliceClosedForm(sliceCaseN);
  const a = sliceCaseN.fuelInnerRadius;
  const b = sliceCaseN.fuelRadius;
  const M = 2000;
  let num = 0;
  let den = 0;
  for (let i = 0; i <= M; i++) {
    const r = a + ((b - a) * i) / M;
    const w = (i === 0 || i === M ? 1 : i % 2 ? 4 : 2) * (sliceCaseN.plate ? 1 : r);
    num += w * cf.fuelAt(r);
    den += w;
  }
  return num / den;
}

describe("1. the declared quantity", () => {
  it("describe lists it: the series and its three scalars, with unit, dimension, normalization, state, what final is, the meaning, where it is present and what is not covered", () => {
    const r = spawnSync(process.execPath, [join(root, "dist", "cli", "headless.js"), "describe"], { encoding: "utf8", timeout: 120_000 });
    expect(r.status).toBe(0);
    const d = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    const q = d.resultQuantities;
    expect(q.schema).toBe("feed.fuel-temperature/0.1");
    expect(q.quantities.map((x: { name: string }) => x.name)).toEqual([FUEL_MEAN_SERIES, FUEL_MEAN_MAX, FUEL_MEAN_MIN, FUEL_MEAN_ALL]);
    const s = q.quantities[0];
    expect(s).toMatchObject({ kind: "series", unit: "K", dimension: "temperature", normalization: "none", state: "steady-state", axis: { name: "z", unit: "m" } });
    expect(s.final).toMatch(/converged state/);
    expect(s.meaning).toMatch(/volume-mean temperature of the fuel/);
    expect(s.meaning).toMatch(/NOT a cross-section-weighted \(effective, Doppler\) temperature/);
    expect(s.meaning).toMatch(/absolute \(kelvin, not a rise above the coolant\)/);
    for (const x of q.quantities.slice(1)) expect(x).toMatchObject({ kind: "scalar", unit: "K", dimension: "temperature", normalization: "none" });
    expect(q.notCovered.join(" ")).toMatch(/transient/);
  });

  it("an axial stack: the record has the declared shape, slice bounds k h to (k + 1) h, the pin's geometry, and the scalars are the series' largest, smallest and length-weighted mean", () => {
    const { n, T, C } = golden("offbeat-stack", "cosine");
    const r = buildStackResults(n, { T, C, time: 1 });
    const ft = r.fuelTemperature!;
    expect(ft).toBeDefined();
    expect(ft).toMatchObject({ schema: "feed.fuel-temperature/0.1", quantity: FUEL_MEAN_SERIES, unit: "K", dimension: "temperature", normalization: "none", state: "steady-state" });
    expect(ft.axis).toMatchObject({ name: "z", unit: "m", frame: null });
    expect(ft.axis.origin).toMatch(/z = 0 at the bottom of the heated length/);
    expect(ft.final).toMatch(/not a time series/);
    expect(ft.geometry).toEqual({ kind: "pin", fuelRadius: n.fuelRadius, fuelInnerRadius: n.fuelInnerRadius, claddingInnerRadius: n.claddingInnerRadius, claddingOuterRadius: n.claddingOuterRadius, fuelCells: n.mesh.fuelCells, heatedLength: n.axial.length });
    const N = n.axial.slices;
    const h = n.axial.length / N;
    expect(ft.slices).toHaveLength(N);
    ft.slices.forEach((s, k) => {
      expect(s.index).toBe(k);
      expect(s.zMin).toBeCloseTo(k * h, 12);
      expect(s.zMax).toBeCloseTo((k + 1) * h, 12);
      expect(Number.isFinite(s.volumeMean)).toBe(true);
    });
    const v = ft.slices.map((s) => s.volumeMean);
    expect(ft.scalars[FUEL_MEAN_MAX].value).toBe(Math.max(...v));
    expect(ft.scalars[FUEL_MEAN_MAX].slice).toBe(v.indexOf(Math.max(...v)));
    expect(ft.scalars[FUEL_MEAN_MIN].value).toBe(Math.min(...v));
    expect(ft.scalars[FUEL_MEAN_ALL].value).toBeCloseTo(v.reduce((a, b) => a + b, 0) / N, 9);
    // the record is in the result, and the slice that is hottest by the mean is a middle one for a cosine
    expect(ft.scalars[FUEL_MEAN_MAX].slice).toBeGreaterThan(2);
    expect(ft.scalars[FUEL_MEAN_MAX].slice).toBeLessThan(N - 3);
  });

  it("the values of a pin stack agree with the exact mean of each slice's own one-dimensional closed form (no solver cell in it) within the mesh bound plus the axial allowance of the result", () => {
    for (const name of ["cosine", "rise", "short"]) {
      const { n, T, C } = golden("offbeat-stack", name);
      const r = buildStackResults(n, { T, C, time: 1 });
      const loads = sliceLoads(n);
      r.fuelTemperature!.slices.forEach((s, k) => {
        const sc = sliceCase(n, loads[k]!);
        const exact = exactFuelMean(sc);
        // for a short pin the heat along the height is large and is not in the one-dimensional closed form: the result's own allowance covers it
        const bound = 0.5 + r.axial.allowance.field;
        expect(Math.abs(s.volumeMean - exact), `${name} slice ${k}`).toBeLessThan(bound);
      });
    }
  });

  it("a plate stack: the mean of every slice equals the mean of the stack's two-dimensional reference over the same cells to 0.05 K", () => {
    const { n, T, C } = golden("offbeat-plate-stack", "cosine");
    const r = buildStackResults(n, { T, C, time: 1 });
    expect(r.fuelTemperature!.geometry.kind).toBe("plate");
    const ref = stackReference(n);
    expect("reference" in ref).toBe(true);
    const refStack = (ref as { reference: { slice(k: number): { fuel: number[] } } }).reference;
    r.fuelTemperature!.slices.forEach((s, k) => {
      expect(Math.abs(s.volumeMean - fuelVolumeMean(n, refStack.slice(k).fuel)), `slice ${k}`).toBeLessThan(0.05);
    });
  });

  it("the mean is a volume mean: a pin weighs the cells by their annuli, a plate by their widths (a parabolic profile gives its exact mean; an unweighted mean would be 1 % of the rise away)", () => {
    const n = validateCase(JSON.parse(read("examples/synthetic-pin.json"))).normalized!;
    const N = n.mesh.fuelCells;
    const rise = 800;
    // a solid cylinder's parabola T = 600 + rise (1 - r^2 / R^2) at the cells' mid radii
    const cells = Array.from({ length: N }, (_, i) => {
      const rm = ((i + 0.5) * n.fuelRadius) / N;
      return 600 + rise * (1 - (rm * rm) / (n.fuelRadius * n.fuelRadius));
    });
    expect(Math.abs(fuelVolumeMean(n, cells) - (600 + rise / 2))).toBeLessThan(1e-3 * rise);
    const plain = cells.reduce((a, b) => a + b, 0) / N;
    expect(Math.abs(plain - (600 + rise / 2))).toBeGreaterThan(0.1 * rise); // the unweighted mean is far off: the weighting is what the test pins
    expect(() => fuelVolumeMean(n, cells.slice(1))).toThrow(/cells/);
  });

  it("a one-slice case: present, with one slice whose bounds and frame are those of the heating transfer, and absent without that transfer", () => {
    const base = JSON.parse(read("examples/synthetic-pin.json"));
    const T = read("tests/golden/offbeat-syn/T");
    const C = read("tests/golden/offbeat-syn/C");
    const plain = buildResults(validateCase(base).normalized!, { T, C, time: 5e7 });
    expect(plain.fuelTemperature).toBeUndefined();
    const withHeat = structuredClone(base);
    withHeat.provenance = { transfers: [{ kind: "heating", recipeId: "r1", pin: "p1", sliceId: "lower", z: { min: 0.25, max: 0.5 }, frame: "core-z up, m" }] };
    const res = buildResults(validateCase(withHeat).normalized!, { T, C, time: 5e7 });
    const ft = res.fuelTemperature!;
    expect(ft.slices).toHaveLength(1);
    expect(ft.slices[0]).toMatchObject({ index: 0, zMin: 0.25, zMax: 0.5 });
    expect(ft.axis.frame).toBe("core-z up, m");
    expect(ft.axis.origin).toMatch(/slice 'lower' of pin 'p1'/);
    expect(ft.geometry.heatedLength).toBeNull();
    expect(ft.scalars[FUEL_MEAN_ALL].value).toBe(ft.slices[0]!.volumeMean);
    // the mean of the golden pin's fuel cells is between its centre cell and its surface cell
    expect(ft.slices[0]!.volumeMean).toBeLessThan(res.summary.centreCellT);
    expect(ft.slices[0]!.volumeMean).toBeGreaterThan(res.summary.fuelSurfaceCellT);
    // an unusable slice in the provenance (min not below max) gives no position: no quantity
    const bad = structuredClone(withHeat);
    bad.provenance.transfers[0].z = { min: 0.5, max: 0.25 };
    expect(buildResults(validateCase(bad).normalized!, { T, C, time: 5e7 }).fuelTemperature).toBeUndefined();
  });

  it("a transient has none, and the builder refuses a count of slices that is not the case's", () => {
    const tr = validateCase(JSON.parse(read("examples/synthetic-pulse.json"))).normalized!;
    expect(fuelTemperatureRecord(tr, [[500, 600]])).toBeUndefined();
    const { n } = golden("offbeat-stack", "cosine");
    expect(() => fuelTemperatureRecord(n, [[1]])).toThrow(/slices/);
  });
});

// ---- the heating transfer
const J_PER_MEV = 1.602176634e-13;
const FRAME = "pin-axis z up, m, origin at bottom of fuel";
const pinText = read("examples/synthetic-pin.json");
const rows = (scores: number[], pinId = "p1") => scores.map((v, i) => [[pinId], i * 0.25, (i + 1) * 0.25, v, v * 0.01]);
const table = (scores: number[]) => ({
  schema: "seed.quantity-data/0.2",
  quantity: "Fuel:heating",
  kind: "table",
  unit: "MeV",
  columns: [
    { name: "pin", unit: "1", role: "label" },
    { name: "z_min", unit: "m", role: "coordinate" },
    { name: "z_max", unit: "m", role: "coordinate" },
    { name: "mean", unit: "MeV", role: "value" },
    { name: "std", unit: "MeV", role: "std", of: "mean" },
  ],
  rows: rows(scores),
  meta: { frame: FRAME },
});
const recipe = (id: string, applyTo = "lower") => ({
  schema: "seed.transfer-recipe/0.2",
  recipeId: id,
  proposedBy: { kind: "agent", name: "claude" },
  proposedAt: "2026-10-25T10:00:00Z",
  source: { runId: "run-" + id, resultsSha256: "a".repeat(64), quantity: "Fuel:heating", dataSha256: "b".repeat(64), unit: "MeV", dimension: "energy", normalization: "per-source-particle", revisionPins: [{ artifact: "openmc-run", revision: "c".repeat(64) }] },
  target: { app: "feed", artifact: "pin-case", revision: "d".repeat(64), field: "heating-to-pin" },
  units: { to: "W" },
  normalization: { kind: "source-rate", value: { value: 1e18, unit: "1/s" }, origin: "20 kW at 200 MeV per fission" },
  mapping: { spatial: { pin: "p1", frame: FRAME, slices: [{ id: "lower", z: { min: 0, max: 0.5 } }, { id: "upper", z: { min: 0.5, max: 1 } }], applyTo }, time: { kind: "steady" }, extrapolation: "refused" },
  tolerance: { conservation: 1e-9, fixedBefore: "mapping" },
});
const apply = (content: string, id: string, scores: number[], applyTo = "lower") => {
  const r = transferHeating({
    schema: "seed.transfer-request/0.2",
    recipe: recipe(id, applyTo),
    recipeDigest: id.padEnd(64, "e").slice(0, 64),
    source: { quantity: { name: "Fuel:heating", unit: "MeV", dimension: "energy", normalization: "per-source-particle" }, data: table(scores) },
    target: { artifact: "pin-case", revision: "d".repeat(64), content },
  });
  if (!r.ok) throw new Error("transfer refused: " + JSON.stringify(r.errors));
  return r.output.content;
};

describe("2. applying heating again replaces the earlier heating, it never accumulates", () => {
  it("apply A then B gives the case that applying B alone gives: the heat rate is B's and the provenance holds one heating entry, B's", () => {
    const once = apply(pinText, "pass-2", [5, 5, 7, 7]);
    const twice = apply(apply(pinText, "pass-1", [4, 6, 6, 4]), "pass-2", [5, 5, 7, 7]);
    expect(twice).toBe(once);
    const doc = JSON.parse(twice);
    expect(doc.provenance.transfers).toHaveLength(1);
    expect(doc.provenance.transfers[0].recipeId).toBe("pass-2");
    // and the heat rate is what the second table gives for the lower slice: (5 + 5) MeV x 1e18 / s over 0.5 m
    expect(doc.power.linearHeatRate.value).toBeCloseTo((10 * J_PER_MEV * 1e18) / 0.5, 6);
  });

  it("25 passes in a row leave one heating entry and the last pass's heat rate; entries of other transfers are kept", () => {
    let content = pinText;
    const withOther = JSON.parse(pinText);
    withOther.provenance = { transfers: [{ kind: "burnup", recordId: "r".repeat(64), note: "kept" }] };
    content = JSON.stringify(withOther, null, 2) + "\n";
    for (let i = 1; i <= 25; i++) content = apply(content, "pass-" + i, [4 + i, 6, 6, 4], i % 2 ? "lower" : "upper");
    const doc = JSON.parse(content);
    const heating = doc.provenance.transfers.filter((e: { kind: string }) => e.kind === "heating");
    expect(heating).toHaveLength(1);
    expect(heating[0].recipeId).toBe("pass-25");
    expect(doc.provenance.transfers.filter((e: { kind: string }) => e.kind === "burnup")).toHaveLength(1);
    expect(doc.provenance.transfers).toHaveLength(2);
  });

  it("the position follows the replacement: the case's heating slice is the last one applied", () => {
    const first = apply(pinText, "pass-1", [4, 6, 6, 4], "lower");
    const second = apply(first, "pass-2", [4, 6, 6, 4], "upper");
    const n = validateCase(JSON.parse(second)).normalized!;
    expect(n.heatingSlice).toMatchObject({ id: "upper", z: { min: 0.5, max: 1 }, frame: FRAME });
  });
});

describe("3. the same input gives the same output", () => {
  it("the heating transfer and the results builder are deterministic: the same inputs twice, byte for byte", () => {
    expect(apply(pinText, "pass-1", [4, 6, 6, 4])).toBe(apply(pinText, "pass-1", [4, 6, 6, 4]));
    const { n, T, C } = golden("offbeat-stack", "cosine");
    const a = JSON.stringify(buildStackResults(JSON.parse(JSON.stringify(n)), { T, C, time: 1 }));
    const b = JSON.stringify(buildStackResults(JSON.parse(JSON.stringify(n)), { T, C, time: 1 }));
    expect(a).toBe(b);
  });
});

describe("4. a thermal solve that does not converge is a typed failure, never a partial result", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  it("a stack whose last step hit the iteration cap unconverged: E_NOT_CONVERGED, no results, no results.json", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-seedft-"));
    dirs.push(runsRoot);
    const mgr = new RunManager({ runsRoot, backend: new FakeBackend("unconverged" as Script) });
    const s = mgr.start(JSON.parse(read("examples/ksu-triga-cosine-stack.json")));
    if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
    const rec = await mgr.done(s.id);
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_NOT_CONVERGED");
    expect(mgr.results(s.id)).toBeUndefined();
  });
});
