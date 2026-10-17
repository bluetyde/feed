// The steady-state gate (src/core/steadyState.ts; F0 exit review, finding 3): a bound on the pin's slowest time constant, the end time
// it requires, a refusal for a pin that cannot settle, and a check on how much is still changing after OFFBEAT's last step.
// The bound is tested against real OFFBEAT runs (solver/results/steady-state-calibration.json), not only against itself.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { buildResults } from "../src/core/resultsParser";
import {
  initialDeviationBound,
  lastRelativeRate,
  lowestConductivity,
  MAX_STEADY_END_TIME,
  MIN_STEADY_END_TIME,
  remainingChangeBound,
  STEADY_PSEUDO_HEAT_CAPACITY,
  STEADY_TOLERANCE,
  steadyEndTime,
  TAU_SAFETY,
  timeScale,
} from "../src/core/steadyState";
import { NormalizedCase, validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const caseDoc = (mutate?: (d: any) => void, file = "examples/synthetic-pin.json") => {
  const d = readJson(file);
  mutate?.(d);
  return d;
};
const norm = (mutate?: (d: any) => void, file?: string): NormalizedCase => {
  const v = validateCase(caseDoc(mutate, file));
  expect(v.errors).toEqual([]);
  return v.normalized!;
};
const film = (h: number) => (d: any) => (d.boundary.heatTransferCoefficient = { value: h, unit: "W/m2/K" });
const golden = (f: string) => readFileSync(join(root, "tests/golden/offbeat-syn", f), "utf8");

describe("the time-constant bound", () => {
  const n = norm();
  const ts = timeScale(n);

  it("is a few seconds for the synthetic pin (about 3 s of heat capacity times resistance, with the safety factor)", () => {
    expect(ts.tauBound).toBeGreaterThan(1);
    expect(ts.tauBound).toBeLessThan(30);
    expect(ts.cells).toBe(26); // 20 fuel + 6 cladding cells
  });

  it("equals the safety factor times an independent computation: the Elmore sum cell by cell (no shortcuts), and the worst node's delay by brute force", () => {
    // every cell: capacity per length, and the resistance from its centroid to the coolant, from the case in the file
    const k = (r: any) => (r.kind === "constant" ? r.k : Math.min(r.a + r.b * r.range[0], r.a + r.b * r.range[1]));
    const kf = k(n.fuelConductivity);
    const kc = k(n.claddingConductivity);
    const Rco = n.claddingOuterRadius;
    const rFilm = 1 / (2 * Math.PI * Rco * (n.boundary as any).heatTransferCoefficient);
    const rGap = 1 / (2 * Math.PI * n.fuelRadius * n.gapConductance);
    const rClad = Math.log(Rco / n.claddingInnerRadius) / (2 * Math.PI * kc);
    const cells: { C: number; R: number }[] = [];
    for (let j = 0; j < n.mesh.fuelCells; j++) {
      const a = (j * n.fuelRadius) / n.mesh.fuelCells;
      const b = ((j + 1) * n.fuelRadius) / n.mesh.fuelCells;
      const centroid = (2 / 3) * ((b ** 3 - a ** 3) / (b ** 2 - a ** 2));
      cells.push({ C: 3e6 * Math.PI * (b * b - a * a), R: Math.log(n.fuelRadius / centroid) / (2 * Math.PI * kf) + rGap + rClad + rFilm });
    }
    for (let j = 0; j < n.mesh.claddingCells; j++) {
      const a = n.claddingInnerRadius + (j * (Rco - n.claddingInnerRadius)) / n.mesh.claddingCells;
      const b = n.claddingInnerRadius + ((j + 1) * (Rco - n.claddingInnerRadius)) / n.mesh.claddingCells;
      const centroid = (2 / 3) * ((b ** 3 - a ** 3) / (b ** 2 - a ** 2));
      cells.push({ C: 3e6 * Math.PI * (b * b - a * a), R: Math.log(Rco / centroid) / (2 * Math.PI * kc) + rFilm });
    }
    const trace = cells.reduce((s, c) => s + c.C * c.R, 0);
    expect(ts.tauBound).toBeCloseTo(1.25 * trace, 9);
    // brute force: the delay of node i is sum_j C_j min(R_i, R_j); the largest over the nodes is the centre's, which is the trace
    const worst = Math.max(...cells.map((ci) => cells.reduce((s, cj) => s + cj.C * Math.min(ci.R, cj.R), 0)));
    expect(worst).toBeCloseTo(trace, 9 - 3);
    expect(ts.capacityRatio).toBeCloseTo(Math.sqrt(cells.reduce((s, c) => s + c.C, 0) / Math.min(...cells.map((c) => c.C))), 9);
  });

  it("the safety factor for what the bound does not model is at least 1.2", () => {
    expect(TAU_SAFETY).toBeGreaterThanOrEqual(1.2);
  });

  it("grows with the resistance to the coolant, and with the heat capacity it carries", () => {
    expect(timeScale(norm(film(3))).tauBound).toBeGreaterThan(ts.tauBound * 10);
    expect(norm((d) => (d.gap.conductance = { value: 50, unit: "W/m2/K" })).gapConductance).toBe(50); // the edit took effect
    expect(timeScale(norm((d) => (d.gap.conductance = { value: 50, unit: "W/m2/K" }))).tauBound).toBeGreaterThan(ts.tauBound * 5);
    expect(STEADY_PSEUDO_HEAT_CAPACITY).toBe(3e6);
  });

  it("uses the lowest conductivity the law allows over its valid range (a larger resistance, so a longer, safer bound)", () => {
    expect(lowestConductivity({ kind: "constant", k: 3, referenceTemperature: 300 })).toBe(3);
    expect(lowestConductivity({ kind: "linear", a: 4, b: -0.0006, range: [500, 2000] })).toBeCloseTo(4 - 0.0006 * 2000, 12);
    expect(lowestConductivity({ kind: "linear", a: 1, b: 0.001, range: [500, 2000] })).toBeCloseTo(1.5, 12);
  });

  it("matches the pseudo heat capacity the case writer really writes (rho 10000, Cp 300)", () => {
    const f = writeOffbeatCase(n).files["constant/solverDict"]!;
    expect(f).toMatch(/rho\s+rho\s+\[1 -3 0 0 0\]\s+10000;/);
    expect(f).toMatch(/Cp\s+Cp\s+\[0 2 -2 -1 0\]\s+300;/);
  });

  it("is validated against real OFFBEAT runs: the bound from the rate OFFBEAT printed is never below the true deviation, and within a factor of 3", () => {
    const ev = readJson("solver/results/steady-state-calibration.json");
    const small = { ...n, mesh: ev.mesh } as NormalizedCase;
    expect(ev.runs.length).toBeGreaterThanOrEqual(10);
    for (const run of ev.runs) {
      const bound = remainingChangeBound(small, run.printedRate, run.maxT);
      expect(bound, `end time ${run.endTime}`).toBeGreaterThanOrEqual(run.trueDeviationK - 1e-6);
      if (run.trueDeviationK > 0.05) expect(bound, `end time ${run.endTime}`).toBeLessThan(3 * run.trueDeviationK);
    }
    // the gate's own threshold lies inside the measured range: some runs are steady to 0.01 K or better, some are far from it
    expect(ev.runs.some((r: any) => r.trueDeviationK <= STEADY_TOLERANCE)).toBe(true);
    expect(ev.runs.some((r: any) => r.trueDeviationK >= 100)).toBe(true);
  });
});

describe("the steady end time", () => {
  it("every example case keeps the 5e7 s the oracles were verified at, so existing case files do not change", () => {
    const files = readdirSync(join(root, "examples")).filter((f) => f.endsWith(".json"));
    let steady = 0;
    for (const f of files) {
      const doc = readJson("examples/" + f);
      const v = validateCase(doc);
      if (!v.ok || v.triso || v.pebble || v.normalized!.transient) continue; // a coated particle has its own steady end time (trisoSteadyEndTime, tests/trisoSolve.test.ts)
      steady++;
      expect({ f, h: steadyEndTime(v.normalized!) }).toMatchObject({ f, h: { ok: true, endTime: MIN_STEADY_END_TIME } });
    }
    expect(steady).toBeGreaterThanOrEqual(5);
  });

  it("a pin with a very weak film needs longer, and the end time follows the bound (rounded up to two digits)", () => {
    const h = steadyEndTime(norm(film(1e-5)));
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    const slow = norm(film(1e-5));
    const ts = timeScale(slow);
    const needed = ts.tauBound * Math.log((ts.capacityRatio * initialDeviationBound(slow)) / STEADY_TOLERANCE);
    expect(h.endTime).toBeGreaterThan(MIN_STEADY_END_TIME);
    expect(h.endTime).toBeGreaterThanOrEqual(needed); // at least what the decay bound needs
    expect(h.endTime).toBeLessThan(1.1 * needed); // and only the rounding up to two digits above it
    expect(Number(h.endTime.toPrecision(2))).toBe(h.endTime); // two significant digits
    expect(steadyEndTime(norm(film(1e-6)))).toMatchObject({ ok: true });
    expect((steadyEndTime(norm(film(1e-6))) as any).endTime).toBeGreaterThan(h.endTime);
  });

  it("a pin that cannot settle within the longest allowed run is refused with the numbers", () => {
    const h = steadyEndTime({ ...norm(), boundary: { kind: "convective" as const, bulkTemperature: 573, heatTransferCoefficient: 1e-10 } });
    expect(h.ok).toBe(false);
    if (h.ok) return;
    expect(h.needed).toBeGreaterThan(MAX_STEADY_END_TIME);
    expect(h.message).toMatch(/slowest thermal time constant/);
    expect(h.message).toMatch(/more than the 1e\+12 s FEED will run/);
  });

  it("the validator refuses such a case with E_TIME and produces no normalized case; a transient is not affected", () => {
    const v = validateCase(caseDoc(film(1e-10)));
    expect(v.ok).toBe(false);
    expect(v.normalized).toBeUndefined();
    expect(v.errors.map((e) => e.code)).toEqual(["E_TIME"]);
    expect(v.errors[0]!.field).toBe("/assumptions/steadyState");
    expect(v.errors[0]!.message).toMatch(/cannot be run as a steady case/);
    // a transient is not a steady case: even with a film so weak that a steady state would be refused, its own time grid decides
    const slowPulse = validateCase(caseDoc((d) => (d.boundary.heatTransferCoefficient = { value: 1e-10, unit: "W/m2/K" }), "examples/synthetic-pulse.json"));
    expect(slowPulse.errors.map((e) => e.code)).not.toContain("E_TIME");
  });

  it("the case writer writes the derived end time into controlDict and the run record; the usual case is unchanged at 5e7", () => {
    const usual = writeOffbeatCase(norm());
    expect(usual.files["system/controlDict"]).toMatch(/endTime\s+50000000;/);
    expect(usual.choices.endTime).toBe(MIN_STEADY_END_TIME);
    const slow = norm(film(1e-5));
    const h = steadyEndTime(slow) as { ok: true; endTime: number };
    const w = writeOffbeatCase(slow);
    expect(w.choices.endTime).toBe(h.endTime);
    expect(w.choices.endTime).toBeGreaterThan(MIN_STEADY_END_TIME);
    expect(Number(/endTime\s+([0-9.e+-]+);/.exec(w.files["system/controlDict"]!)![1])).toBe(h.endTime);
  });

  it("the writer does not write a steady case that cannot settle", () => {
    const n = { ...norm(), boundary: { kind: "convective" as const, bulkTemperature: 573, heatTransferCoefficient: 1e-10 } };
    expect(() => writeOffbeatCase(n)).toThrow(/cannot write a steady case/);
  });
});

describe("OFFBEAT's printed rate", () => {
  const line = (x: string) => `Maximum deltaT calculated by thermal subsolver: 1e+30 with a relative temperature change of ${x} K/s\n`;
  it("takes the LAST one in the log, of any sign (OFFBEAT prints -0 when nothing changed)", () => {
    expect(Math.abs(lastRelativeRate(line("0.4659") + line("3.79e-07") + line("-0"))!)).toBe(0);
    expect(Object.is(lastRelativeRate(line("-0")), -0)).toBe(true);
    expect(lastRelativeRate(line("0.5") + line("2.5e-3"))).toBe(2.5e-3);
  });
  it("reads nan and inf as such, and returns undefined for a log with no record", () => {
    expect(lastRelativeRate(line("nan"))).toBeNaN();
    expect(lastRelativeRate(line("inf"))).toBe(Infinity);
    expect(lastRelativeRate("Time = 1 s\n")).toBeUndefined();
  });
  it("reads the real full steady run's last step", () => {
    const real = readFileSync(join(root, "tests/golden/offbeat-convergence/steady-full-run.log.txt"), "utf8");
    expect(Math.abs(lastRelativeRate(real)!)).toBe(0);
  });
});

describe("the steadyState check in a steady result", () => {
  const n = norm();
  const T = golden("T");
  const C = golden("C");
  const checkOf = (drift?: { relativeRate: number | undefined }) => buildResults(n, { T, C, time: 5e7, ...(drift ? { drift } : {}) }).checks.find((c) => c.id === "steadyState");

  it("a last step with nothing changing passes with a bound of 0 K", () => {
    expect(checkOf({ relativeRate: -0 })).toMatchObject({ verdict: "pass", value: 0, unit: "K" });
  });
  it("a last step that was still changing fails, with the bound and the rate in the note", () => {
    const c = checkOf({ relativeRate: 1e-3 })!;
    expect(c.verdict).toBe("fail");
    expect(c.value).toBeGreaterThan(STEADY_TOLERANCE);
    expect(c.note).toMatch(/still to change/);
    expect(c.note).toMatch(/0\.001/);
  });
  it("the threshold is sharp: a rate whose bound is just under 0.01 K passes and just over fails", () => {
    const hot = 1304; // the hottest cell of the golden field, K
    const rate = STEADY_TOLERANCE / (timeScale(n).tauBound * hot);
    expect(checkOf({ relativeRate: rate * 0.95 })!.verdict).toBe("pass");
    expect(checkOf({ relativeRate: rate * 1.05 })!.verdict).toBe("fail");
  });
  it("a missing or non-finite rate fails: a run that cannot show it settled is not called steady", () => {
    for (const r of [undefined, NaN, Infinity]) {
      const c = checkOf({ relativeRate: r })!;
      expect(c.verdict).toBe("fail");
      expect(c.value).toBeNull();
      expect(c.note).toMatch(/cannot be judged/);
    }
  });
  it("a caller with no log (no drift given) gets no steadyState check at all, not a pass", () => {
    expect(checkOf()).toBeUndefined();
  });
});
