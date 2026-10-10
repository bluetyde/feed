// The mechanics entries of the SEED oracle set (plan 09 M6, oracles/seed/entries/feed-mechanics-*, written by scripts/gen-seed-oracles.cjs from plain closed forms): they agree with
// FEED's independent thermo-elastic solution (src/core/thermoElastic.ts, a second method: the generator uses none of it) inside the entries' own tolerances, and with
// FEED_SOLVER=1 the real solver lands inside them too, except the one known limit, which must miss by the known amount. Their quantities are new to SEED (docs/seed-mechanics-request.md).
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { hydrogenPressure } from "../src/core/hydrogenPressure";
import { effectiveMechanics } from "../src/core/mechanicalEval";
import { quickLook } from "../src/core/quickLook";
import { ResultsRecord } from "../src/core/resultsParser";
import { RunManager } from "../src/core/runManager";
import { independentSolution } from "../src/core/thermoElastic";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const dir = join(__dirname, "..", "oracles", "seed");
const entries = readdirSync(join(dir, "entries")).map((f) => JSON.parse(readFileSync(join(dir, "entries", f), "utf8")));
const mech = entries.filter((e) => /^feed-(bad-)?mechanics-/.test(e.oracleId));
const good = mech.filter((e) => e.tag !== "bad-input");
const caseOf = (e: any) => JSON.parse(readFileSync(join(dir, e.inputs[0].path), "utf8"));
const tol = (e: any) => Math.max(e.tolerance.abs, e.tolerance.rel * Math.abs(e.expected.value));
const MESH = { fuel: 20, clad: 8 };

/** The quantity of an entry from FEED's own independent solution at the cell centres of the entry's mesh (uniform cells). */
function independentValue(e: any): number {
  const n = validateCase(caseOf(e)).normalized!;
  const sol = independentSolution(n, effectiveMechanics(n)!, n.mechanics!);
  const Rf = n.fuelRadius, Rci = n.claddingInnerRadius, Rco = n.claddingOuterRadius;
  const fuelLast = Rf * (1 - 1 / (2 * MESH.fuel)), fuelFirst = Rf / (2 * MESH.fuel);
  const cladFirst = Rci + (Rco - Rci) / (2 * MESH.clad), cladLast = Rco - (Rco - Rci) / (2 * MESH.clad);
  switch (e.expected.quantity) {
    case "displacement_radial_fuel_last_cell": return sol.fuel.at(fuelLast).ur;
    case "displacement_radial_clad_last_cell": return sol.cladding.at(cladLast).ur;
    case "stress_axial_fuel_min": return Math.min(...Array.from({ length: MESH.fuel }, (_, i) => sol.fuel.at((Rf * (i + 0.5)) / MESH.fuel).sigmaZ));
    case "stress_limit_margin": return 1e9 - Math.max(...Array.from({ length: MESH.fuel }, (_, i) => { const s = sol.fuel.at((Rf * (i + 0.5)) / MESH.fuel); return Math.sqrt(0.5 * ((s.sigmaR - s.sigmaTheta) ** 2 + (s.sigmaTheta - s.sigmaZ) ** 2 + (s.sigmaZ - s.sigmaR) ** 2)); }));
    case "contact_pressure": return sol.contactPressure;
    case "stress_hoop_clad_first_cell": return sol.cladding.at(cladFirst).sigmaTheta;
    case "gas_pressure": return hydrogenPressure(1.65, quickLook(n).temperatures.centreT);
    default: throw new Error("quantity not handled: " + e.expected.quantity + " " + fuelFirst);
  }
}

describe("the mechanics entries of the SEED oracle set", () => {
  it("are 7 good, 6 bad-input and 1 known-limit entries, all kind analytic or hand, none a solver output", () => {
    const n = (t: string) => mech.filter((e) => e.tag === t).length;
    expect([n("good"), n("bad-input"), n("known-limit")]).toEqual([7, 6, 1]);
    for (const e of good) expect(["analytic"], e.oracleId).toContain(e.source.kind);
    for (const e of mech.filter((x) => x.tag === "bad-input")) expect(e.source.kind).toBe("hand");
  });
  it("every bad-input one is refused with the code it names, as the first error", () => {
    for (const e of mech.filter((x) => x.tag === "bad-input")) {
      const r = validateCase(caseOf(e));
      expect(r.ok, e.oracleId).toBe(false);
      expect(r.errors[0]!.code, e.oracleId).toBe(e.expected.refusalCode);
    }
  });
  it("every case of a good or known-limit entry is accepted by the validator and asks for mechanics", () => {
    for (const e of good) {
      const v = validateCase(caseOf(e));
      expect(v.errors, e.oracleId).toEqual([]);
      expect(v.normalized!.mechanics, e.oracleId).toBeDefined();
    }
  });
  it("each expected value agrees with FEED's independent thermo-elastic solution inside the entry's tolerance (the soft-fuel known limit too: the closed form is the same)", () => {
    for (const e of good) {
      const mine = independentValue(e);
      expect(Math.abs(mine - e.expected.value), e.oracleId + " mine " + mine + " expected " + e.expected.value).toBeLessThanOrEqual(tol(e));
    }
  });
  it("the tolerances are the ones fixed in the generator before any run", () => {
    const t = (id: string) => entries.find((e) => e.oracleId === id)!.tolerance;
    expect(t("feed-mechanics-free-expansion-displacement-radial-fuel-last-cell")).toEqual({ abs: 0, rel: 0.01 });
    expect(t("feed-mechanics-axially-fixed-stress-limit-margin")).toEqual({ abs: 3e6, rel: 0 });
    expect(t("feed-mechanics-gap-closure-contact-pressure")).toEqual({ abs: 0, rel: 0.04 });
    expect(t("feed-mechanics-gap-closure-soft-fuel-contact-pressure")).toEqual({ abs: 0, rel: 0.02 });
    expect(t("feed-mechanics-hydrogen-pressure-gas-pressure")).toEqual({ abs: 0, rel: 1e-4 });
  });
});

const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

/** What SEED's adapter has to read from FEED's result for each new quantity (docs/seed-mechanics-request.md). */
function fromResult(res: ResultsRecord, q: string): number {
  const m = res.mechanics!;
  switch (q) {
    case "displacement_radial_fuel_last_cell": return m.points[MESH.fuel - 1]!.ur;
    case "displacement_radial_clad_last_cell": return m.points[m.points.length - 1]!.ur;
    case "stress_axial_fuel_min": return m.summary.fuel.axial[0];
    case "contact_pressure": return m.summary.contactPressure!;
    case "stress_hoop_clad_first_cell": return m.points[MESH.fuel]!.sigmaTheta;
    case "gas_pressure": return m.internalPressure;
    case "stress_limit_margin": return res.checks.find((c) => c.id === "stressLimit:fuel-flat-1GPa")!.value!;
    default: throw new Error(q);
  }
}

describe.skipIf(!solverOn)("the mechanics entries against the real solver (needs FEED_SOLVER=1)", () => {
  const paths = [...new Set(good.map((e) => e.inputs[0].path))];
  for (const path of paths) {
    it(path + ": every check passes, and each entry's quantity is inside its tolerance (the known limit misses by the known 2.7 to 3.1 %)", async () => {
      const mine = good.filter((e) => e.inputs[0].path === path);
      const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-seedmech-")), backend: new WslBackend(), timeoutMs: 280_000 });
      const s = mgr.start(caseOf(mine[0]));
      if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
      const rec = await mgr.done(s.id);
      expect(rec.state, JSON.stringify(rec.failure)).toBe("completed");
      const res = mgr.results(s.id) as ResultsRecord;
      const known = mine.some((e) => e.tag === "known-limit");
      if (!known) expect(res.checks.filter((c) => c.verdict !== "pass").map((c) => c.id + " value " + c.value + ": " + c.note)).toEqual([]);
      for (const e of mine) {
        const got = fromResult(res, e.expected.quantity);
        const err = Math.abs(got - e.expected.value);
        if (e.tag === "known-limit") {
          const rel = err / Math.abs(e.expected.value);
          expect(err, e.oracleId + " should miss its 2 % tolerance").toBeGreaterThan(tol(e));
          expect(rel, e.oracleId + " known error " + rel).toBeGreaterThan(0.02);
          expect(rel, e.oracleId + " known error " + rel).toBeLessThan(0.045);
        } else expect(err, e.oracleId + " solver " + got + " expected " + e.expected.value).toBeLessThanOrEqual(tol(e));
      }
    }, 300_000);
  }
});
