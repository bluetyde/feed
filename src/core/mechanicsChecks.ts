// The checks every mechanics result carries (docs/plans/09-mechanics.md M3): OFFBEAT's displacement and stress compared with the independent thermo-elastic solution
// (src/core/thermoElastic.ts), the radial balance of OFFBEAT's own stress, and the contact (whether the solids touch, the pressure, the gap). The tolerances are the ones fixed in
// the plan before the independent solution was first run against an OFFBEAT result; a result that misses one fails its check, nothing is relaxed to make it pass.
import type { EffectiveMechanics } from "./mechanicalEval";
import type { MechanicsRecord } from "./mechanicsResults";
import type { Check } from "./resultsParser";
import { closedFormTemperatures, independentSolution } from "./thermoElastic";
import type { MechanicsSpec, NormalizedCase } from "./validate";

export const MECHANICS_TOLERANCE = {
  /** Displacement: this fraction of the largest |ur| of the solid, plus the floor (m). */
  displacement: { fraction: 0.01, floor: 1e-9 },
  /** Stress: this fraction of the stress scale of the solid (below), plus the floor (Pa). */
  stress: { fraction: 0.03, floor: 1e4, thermalFraction: 0.01 },
  /** Radial balance between neighbouring cells: the residual times the cell spacing, as a fraction of the stress scale. */
  equilibrium: 0.02,
  /** Contact pressure: this fraction of the independent pressure plus the floor (Pa); a gap of less than `nearlyClosed` (m) either way is not judged for touching. */
  contact: { fraction: 0.03, floor: 1e4, nearlyClosed: 0.5e-6 },
  /** Gap with no contact: this fraction of the independent gap plus the floor (m). */
  gap: { fraction: 0.02, floor: 1e-8 },
};

type Cell = { region: "fuel" | "cladding"; r: number };

export function mechanicsChecks(c: NormalizedCase, props: EffectiveMechanics, record: MechanicsRecord, cells: Cell[]): Check[] {
  const tol = MECHANICS_TOLERANCE;
  const sol = independentSolution(c, props, c.mechanics!);
  const temps = closedFormTemperatures(c);
  const thetaOf = (cell: Cell) => Math.abs((cell.region === "fuel" ? temps.fuel(cell.r) : temps.cladding(cell.r)) - props.referenceTemperature);
  const out: Check[] = [];
  const fuelIdx: number[] = [];
  const cladIdx: number[] = [];
  cells.forEach((p, i) => (p.region === "fuel" ? fuelIdx : cladIdx).push(i));
  const solids = [
    { name: "fuel", idx: fuelIdx, field: sol.fuel, p: props.fuel },
    { name: "cladding", idx: cladIdx, field: sol.cladding, p: props.cladding },
  ] as const;

  // displacement and stress against the independent solution, solid by solid
  let worstU = 0;
  let tightU = Infinity;
  let worstS = 0;
  let tightS = Infinity;
  let uPass = true;
  let sPass = true;
  let where = "";
  for (const s of solids) {
    const ref = s.idx.map((i) => s.field.at(cells[i]!.r));
    const thetaMax = Math.max(...s.idx.map((i) => thetaOf(cells[i]!)));
    const uScale = Math.max(...ref.map((x) => Math.abs(x.ur)));
    const sScale = Math.max(Math.max(...ref.flatMap((x) => [x.sigmaR, x.sigmaTheta, x.sigmaZ].map(Math.abs))), tol.stress.thermalFraction * s.p.E * s.p.alpha * thetaMax);
    const uTol = tol.displacement.fraction * uScale + tol.displacement.floor;
    const sTol = tol.stress.fraction * sScale + tol.stress.floor;
    s.idx.forEach((i, k) => {
      const pt = record.points[i]!;
      const r = ref[k]!;
      const du = Math.abs(pt.ur - r.ur);
      const ds = Math.max(Math.abs(pt.sigmaR - r.sigmaR), Math.abs(pt.sigmaTheta - r.sigmaTheta), Math.abs(pt.sigmaZ - r.sigmaZ));
      if (du > worstU) worstU = du;
      if (ds > worstS) worstS = ds;
      if (du > uTol) {
        uPass = false;
        if (!where) where = `${s.name} cell at r = ${(cells[i]!.r * 1e3).toFixed(3)} mm: ur ${pt.ur.toExponential(4)} m against ${r.ur.toExponential(4)} m`;
      }
      if (ds > sTol) {
        sPass = false;
        if (!where) where = `${s.name} cell at r = ${(cells[i]!.r * 1e3).toFixed(3)} mm: stress deviates by ${(ds / 1e6).toFixed(3)} MPa`;
      }
    });
    tightU = Math.min(tightU, uTol);
    tightS = Math.min(tightS, sTol);
  }
  out.push({
    id: "mechanicsDisplacement",
    label: "OFFBEAT displacement vs the independent thermo-elastic solution (max cell deviation)",
    value: worstU,
    unit: "m",
    verdict: uPass ? "pass" : "fail",
    note: `bound ${tol.displacement.fraction * 100} % of the largest radial displacement of the solid + ${tol.displacement.floor} m, tightest ${tightU.toExponential(2)} m; same constants (E, nu, alpha, reference temperature) and the closed-form temperatures${uPass ? "" : "; " + where}`,
  });
  out.push({
    id: "mechanicsStress",
    label: "OFFBEAT stress vs the independent thermo-elastic solution (max cell deviation of a component)",
    value: worstS,
    unit: "Pa",
    verdict: sPass ? "pass" : "fail",
    note: `bound ${tol.stress.fraction * 100} % of the solid's stress scale (its largest independent stress, or ${tol.stress.thermalFraction * 100} % of E alpha max|T - Tref| if that is larger) + ${tol.stress.floor} Pa, tightest ${tightS.toExponential(2)} Pa${sPass ? "" : "; " + where}`,
  });

  // the radial balance of OFFBEAT's own stress between neighbouring cell centres
  let worstEq = 0;
  let eqPass = true;
  let eqWhere = "";
  for (const s of solids) {
    const pts = s.idx.map((i) => ({ r: cells[i]!.r, ...record.points[i]! }));
    const scale = Math.max(Math.max(...pts.flatMap((x) => [x.sigmaR, x.sigmaTheta, x.sigmaZ].map(Math.abs))), tol.stress.thermalFraction * s.p.E * s.p.alpha * Math.max(...s.idx.map((i) => thetaOf(cells[i]!))));
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      const h = b.r - a.r;
      // (sigma_r(b) - sigma_r(a)) + h (mean of (sigma_r - sigma_theta) / r) = 0
      const res = Math.abs(b.sigmaR - a.sigmaR + (h / 2) * ((a.sigmaR - a.sigmaTheta) / a.r + (b.sigmaR - b.sigmaTheta) / b.r));
      if (res > worstEq) worstEq = res;
      if (res > tol.equilibrium * scale + tol.stress.floor && eqPass) {
        eqPass = false;
        eqWhere = `${s.name} between r = ${(a.r * 1e3).toFixed(3)} and ${(b.r * 1e3).toFixed(3)} mm: residual ${(res / 1e6).toFixed(3)} MPa`;
      }
    }
  }
  out.push({
    id: "mechanicsEquilibrium",
    label: "Radial force balance of OFFBEAT's stress between neighbouring cells (max residual)",
    value: worstEq,
    unit: "Pa",
    verdict: eqPass ? "pass" : "fail",
    note: `d(sigma_r)/dr + (sigma_r - sigma_theta)/r = 0 by the trapezoid rule; bound ${tol.equilibrium * 100} % of the solid's stress scale + ${tol.stress.floor} Pa${eqPass ? "" : "; " + eqWhere}`,
  });

  out.push(contactCheck(sol, record));
  return out;
}

function contactCheck(sol: ReturnType<typeof independentSolution>, record: MechanicsRecord): Check {
  const tol = MECHANICS_TOLERANCE.contact;
  const id = "mechanicsContact";
  const label = "Contact between the solids vs the independent solution";
  const s = record.summary;
  const refTouch = sol.contact;
  const nearly = Math.abs(sol.freeGap) < tol.nearlyClosed;
  const p = s.contactPressure ?? 0;
  if (s.gapWidth === null && s.contactPressure === null) {
    return { id, label, value: null, unit: "Pa", verdict: "fail", note: "OFFBEAT's gap width and interface pressure could not be read, so the contact cannot be judged" };
  }
  if (!nearly && s.contact !== refTouch) {
    return {
      id,
      label,
      value: p,
      unit: "Pa",
      verdict: "fail",
      note: `the independent solution says the solids ${refTouch ? "touch (free overlap " + (-sol.freeGap * 1e6).toFixed(2) + " micron)" : "do not touch (free gap " + (sol.freeGap * 1e6).toFixed(2) + " micron)"}, OFFBEAT's result says they ${s.contact ? "touch" : "do not touch"} (gap ${s.gapWidth === null ? "unread" : (s.gapWidth * 1e6).toFixed(2) + " micron"}, pressure ${(p / 1e6).toFixed(3)} MPa)`,
    };
  }
  if (refTouch && s.contact) {
    const dev = Math.abs(p - sol.contactPressure);
    const bound = tol.fraction * sol.contactPressure + tol.floor;
    return { id, label, value: dev, unit: "Pa", verdict: dev <= bound ? "pass" : "fail", note: `interface pressure ${(p / 1e6).toFixed(3)} MPa against ${(sol.contactPressure / 1e6).toFixed(3)} MPa; bound ${tol.fraction * 100} % + ${tol.floor} Pa` };
  }
  if (!refTouch && !s.contact && s.gapWidth !== null) {
    const g = MECHANICS_TOLERANCE.gap;
    const dev = Math.abs(s.gapWidth - sol.gap);
    const bound = g.fraction * Math.abs(sol.gap) + g.floor;
    return { id, label, value: dev, unit: "m", verdict: dev <= bound ? "pass" : "fail", note: `gap ${(s.gapWidth * 1e6).toFixed(3)} micron against ${(sol.gap * 1e6).toFixed(3)} micron, no contact; bound ${g.fraction * 100} % + ${g.floor} m` };
  }
  if (!nearly) return { id, label, value: null, unit: "Pa", verdict: "fail", note: `the contact cannot be judged: the independent solution says the solids ${refTouch ? "touch" : "do not touch (free gap " + (sol.freeGap * 1e6).toFixed(2) + " micron)"} and OFFBEAT's gap width is unread or its result is not comparable, and a gap that is not nearly closed is never passed unread` };
  return { id, label, value: null, unit: "Pa", verdict: "pass", note: `the gap is nearly closed (free gap ${(sol.freeGap * 1e6).toFixed(3)} micron, within ${tol.nearlyClosed * 1e6} micron of touching): touching is not judged either way` };
}

/** The strength a limit's table gives at T (linear between points), or null outside the table: nothing is extrapolated. */
export function strengthAt(table: { temperature: number; strength: number }[], T: number): number | null {
  if (!(T >= table[0]!.temperature && T <= table[table.length - 1]!.temperature)) return null;
  for (let i = 0; i + 1 < table.length; i++) {
    const a = table[i]!;
    const b = table[i + 1]!;
    if (T <= b.temperature) return a.strength + ((b.strength - a.strength) * (T - a.temperature)) / (b.temperature - a.temperature);
  }
  return table[table.length - 1]!.strength;
}

/**
 * One check per stress limit the case states: the smallest margin (strength at the cell's temperature minus its von Mises stress) over the solid's cells. A cell whose temperature
 * is outside the table cannot be judged, and a limit that cannot be judged does not pass: it fails, and says how many cells and what range the table covers. A stress that is
 * not a number fails too. A passing check says that the stress is below THIS strength; it is not an integrity assessment (no creep, no fatigue, no plasticity).
 */
export function stressLimitChecks(limits: NonNullable<MechanicsSpec["stressLimits"]>, record: MechanicsRecord, cells: { region: "fuel" | "cladding"; T: number }[]): Check[] {
  return limits.map((lim) => {
    let margin: number | null = null;
    let worst = "";
    let outside = 0;
    let invalid = 0;
    let judged = 0;
    cells.forEach((c, i) => {
      if (c.region !== lim.region) return;
      const s = record.points[i]!.sigmaEq;
      if (!Number.isFinite(s) || !Number.isFinite(c.T)) {
        invalid++;
        return;
      }
      const strength = strengthAt(lim.table, c.T);
      if (strength === null) {
        outside++;
        return;
      }
      judged++;
      const m = strength - s;
      if (margin === null || m < margin) {
        margin = m;
        worst = `cell ${i} at ${c.T.toFixed(1)} K: von Mises ${(s / 1e6).toFixed(2)} MPa against ${(strength / 1e6).toFixed(2)} MPa`;
      }
    });
    const range = `${lim.table[0]!.temperature} to ${lim.table[lim.table.length - 1]!.temperature} K`;
    const id = "stressLimit:" + lim.name;
    const label = `Stress limit '${lim.name}' (${lim.region}, von Mises, smallest margin)`;
    const src = ` Source: ${lim.source}. A stress below a strength is not an integrity assessment: no creep, fatigue, plasticity or strain limit is checked.`;
    if (invalid > 0) return { id, label, value: null, unit: "Pa", verdict: "fail" as const, note: `${invalid} cells have a stress or temperature that is not a finite number, so the limit cannot be judged.${src}` };
    if (outside > 0) return { id, label, value: margin, unit: "Pa", verdict: "fail" as const, note: `${outside} of the ${lim.region}'s cells are at temperatures outside the table (${range}), where the strength is not stated: the limit cannot be judged there and is not passed.${judged > 0 ? " Smallest margin of the " + judged + " cells inside: " + worst + "." : ""}${src}` };
    return { id, label, value: margin, unit: "Pa", verdict: margin !== null && margin >= 0 ? "pass" as const : "fail" as const, note: `smallest margin at ${worst}.${src}` };
  });
}
