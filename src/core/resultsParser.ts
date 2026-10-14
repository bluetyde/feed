// Results parser: OFFBEAT final-time field text -> validated results record (docs/ARCHITECTURE.md, interface 2).
// Incomplete, non-finite or inconsistent output is REFUSED with a typed error; it never becomes a partial result.
// Pure functions on text: no solver, no files. Tested on real saved output (tests/golden/offbeat-syn/).

import { limitChecks } from "./limits";
import { closedForm, fuelTemperatureLaw } from "./closedForm";
import { evaluate, lawOf, primitive, rangeOf, solveHot } from "./conductivity";
import { NFI_OXIDE_TO_HEAVY_METAL } from "./uo2Nfi";
import { remainingChangeBound, STEADY_TOLERANCE } from "./steadyState";
import { effectiveMechanics } from "./mechanicalEval";
import { mechanicsChecks, stressLimitChecks } from "./mechanicsChecks";
import { MECHANICS_TEXT, MechanicsInput, MechanicsRecord, buildMechanics } from "./mechanicsResults";
import { Conductivity, NormalizedCase } from "./validate";

export class ResultsError extends Error {
  constructor(public code: "E_OUTPUT_INCOMPLETE", message: string) {
    super(message);
  }
}
const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};

/**
 * A written OpenFOAM field file ends with the "// ***** //" footer and has balanced braces and parentheses. A file killed mid-write
 * does not, even when its cell list happens to be complete.
 */
export function assertWholeFoamFile(text: string, name: string): void {
  if (!/\/\/ \*{20,} \/\/\s*$/.test(text)) bad(`field ${name} does not end with the OpenFOAM footer (the file is cut short)`);
  const count = (ch: string) => text.split(ch).length - 1;
  if (count("{") !== count("}") || count("(") !== count(")")) bad(`field ${name} has unbalanced braces or parentheses (the file is cut short or malformed)`);
}

/** Parse `internalField nonuniform List<scalar> N ( ... )`. A uniform field is refused: a radial profile needs per-cell values. */
export function parseScalarField(text: string, name: string): number[] {
  const m = /internalField\s+(nonuniform|uniform)\s+(?:List<scalar>\s*(\d+)\s*\(|([^;\s]+)\s*;)/.exec(text);
  if (!m) return bad(`field ${name}: no internalField found`);
  if (m[1] === "uniform") return bad(`field ${name}: internalField is uniform; per-cell values are required`);
  const n = Number(m[2]);
  const body = text.slice(m.index + m[0].length);
  const end = body.indexOf("\n)");
  if (end < 0) return bad(`field ${name}: list is not closed (truncated file?)`);
  const tokens = body.slice(0, end).trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== n) return bad(`field ${name}: header says ${n} values, found ${tokens.length}`);
  const vals = tokens.map(Number);
  vals.forEach((v, i) => {
    if (!Number.isFinite(v)) bad(`field ${name}: value ${i} is not finite (${tokens[i]})`);
  });
  return vals;
}

/** Parse `internalField nonuniform List<vector> N ( (x y z) ... )`. */
export function parseVectorField(text: string, name: string): number[][] {
  const m = /internalField\s+nonuniform\s+List<vector>\s*(\d+)\s*\(/.exec(text);
  if (!m) return bad(`field ${name}: no nonuniform vector internalField found`);
  const n = Number(m[1]);
  const body = text.slice(m.index + m[0].length);
  const end = body.indexOf("\n)");
  if (end < 0) return bad(`field ${name}: list is not closed (truncated file?)`);
  const rows = [...body.slice(0, end).matchAll(/\(\s*([^()\s]+)\s+([^()\s]+)\s+([^()\s]+)\s*\)/g)].map((r) => [Number(r[1]), Number(r[2]), Number(r[3])]);
  if (rows.length !== n) return bad(`field ${name}: header says ${n} vectors, found ${rows.length}`);
  rows.forEach((r, i) => {
    if (!r.every(Number.isFinite)) bad(`field ${name}: vector ${i} is not finite`);
  });
  return rows;
}

/**
 * The values of a named boundary patch block (the patch temperature the solver converged to), to the block's own closing brace: a boundary condition may hold a sub-dictionary
 * (the time tables of timeDependentAxialProfileHTC), so the first closing brace is not the end. `value uniform X` is one value; `value nonuniform List<scalar> N(...)` is one per face
 * (one per axial layer in a stack). Null when the patch or its value is not there or not finite.
 */
export function parsePatchValues(text: string, patch: string): number[] | null {
  const open = new RegExp(`\\b${patch}\\s*\\{`).exec(text);
  if (!open) return null;
  let depth = 1;
  let end = open.index + open[0].length;
  for (; end < text.length && depth > 0; end++) {
    if (text[end] === "{") depth++;
    else if (text[end] === "}") depth--;
  }
  if (depth !== 0) return null;
  const block = text.slice(open.index + open[0].length, end - 1);
  const uniform = /value\s+uniform\s+([-+.\deE]+)\s*;/.exec(block);
  if (uniform) {
    const x = Number(uniform[1]);
    return Number.isFinite(x) ? [x] : null;
  }
  const list = /value\s+nonuniform\s+List<scalar>\s*(\d+)\s*\(([^)]*)\)/.exec(block);
  if (!list) return null;
  const vals = list[2]!.trim().split(/\s+/).filter(Boolean).map(Number);
  if (vals.length !== Number(list[1])) bad(`patch ${patch}: the value list declares ${list[1]} values but holds ${vals.length}`);
  if (!vals.every(Number.isFinite)) return null;
  return vals;
}

/** `value uniform X` inside a named boundary patch block: the one temperature a single-face wall holds (several equal values are the same wall; the first is returned). */
export function parsePatchValue(text: string, patch: string): number | null {
  const v = parsePatchValues(text, patch);
  return v === null ? null : v[0]!;
}

export type CheckVerdict = "pass" | "fail" | "na";
export interface Check {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  verdict: CheckVerdict;
  note: string;
}

export interface RadialPoint {
  /** metres */
  r: number;
  /** kelvin */
  T: number;
  region: "fuel" | "cladding";
}

export interface DomainFinding {
  region: "fuel" | "cladding";
  /** Temperature range the solver produced in that region (K). */
  produced: [number, number];
  /** The range the conductivity law is stated to hold over (K). */
  validRange: [number, number];
}

export interface ResultsRecord {
  schema: "feed.results/0.1";
  caseId: string;
  /** Final solver time in seconds. */
  time: number;
  radial: RadialPoint[];
  summary: {
    /** First fuel cell (nearest the axis); its centre is a cell-size away from r = 0. */
    centreCellT: number;
    fuelSurfaceCellT: number;
    claddingInnerCellT: number;
    claddingOuterWallT: number | null;
    maxT: number;
    minT: number;
  };
  checks: Check[];
  /** 'out-of-domain' when a region's temperatures leave its conductivity law's stated range. Such a result is not valid. */
  domain: { verdict: "in-domain" | "out-of-domain"; findings: DomainFinding[] };
  /** Thermal-only banner text; every results view and export carries it. For a burnup case it also says that the result is a frozen-burnup snapshot. */
  thermalOnly: string;
  /** Present when the fuel's conductivity is the burnup law: the burnup it was evaluated at (MWd/kgHM, heavy-metal basis) and where that came from. */
  burnup?: { value: number; source: string };
  /** Present for a case that asks for mechanics: the displacement and the stress of each cell, the contact, and what the result is and is not (src/core/mechanicsResults.ts). */
  mechanics?: MechanicsRecord;
}

/**
 * One check for each solid whose conductivity came from a table: how far the polynomial that was run is from the table at the table's own points. The case was refused
 * if this exceeded its tolerance, so it passes by construction; it is in the result so that a result carries the approximation it rests on.
 */
export function fitChecks(c: NormalizedCase): Check[] {
  const out: Check[] = [];
  const regions = [
    ["fuel", "conductivity", "conductivityFitFuel", c.fuelConductivity],
    ["cladding", "conductivity", "conductivityFitCladding", c.claddingConductivity],
    ["fuel", "heat capacity", "heatCapacityFitFuel", c.fuelHeatCapacity],
    ["cladding", "heat capacity", "heatCapacityFitCladding", c.claddingHeatCapacity],
  ] as const;
  for (const [region, what, id, k] of regions) {
    if (!k || k.kind !== "polynomial" || !k.fit) continue;
    const f = k.fit;
    out.push({
      id,
      label: `The ${region}'s tabulated ${what} vs the polynomial that was run (max deviation at the table's points)`,
      value: f.maxRelativeDeviation,
      unit: "relative",
      verdict: f.maxRelativeDeviation <= f.tolerance ? "pass" : "fail",
      note: `a degree ${f.degree} polynomial fitted by least squares to ${f.points.length} points from ${k.range[0]} to ${k.range[1]} K; the largest deviation is ${(f.maxRelativeDeviation * 100).toPrecision(3)}% at ${f.worstAt} K; tolerance ${(f.tolerance * 100).toPrecision(3)}%. OFFBEAT has no tabulated ${what}, so what ran is the polynomial, not the table`,
    });
  }
  return out;
}

export const THERMAL_ONLY_TEXT = "Thermal-only result. It says nothing about stress, failure or fuel integrity.";

/** What a burnup result is and is not (docs/plans/10-burnup.md section 1): appended to the thermal-only text of every result, export and comparison of a burnup case. */
export const burnupText = (MWdPerKgHM: number): string =>
  `Frozen-burnup snapshot: the fuel's conductivity is that of fuel with ${Number(MWdPerKgHM.toPrecision(6))} MWd per kg of heavy metal, everything else as stated. Nothing evolves: there is no swelling, densification, relocation or fission-gas release, and the gap is the stated one, not the closed gap of burnt fuel. It is not a fuel-performance prediction.`;

/** The largest relative difference between OFFBEAT's own conductivity field and FEED's burnup law at OFFBEAT's own temperatures that a result accepts. The field holds 7 digits. */
export const BURNUP_K_TOLERANCE = 1e-4;
/** The same for the Bu field against what was written (7 digits again). */
export const BURNUP_BU_TOLERANCE = 1e-5;

/** Energy-balance diagnostic threshold (relative). A diagnostic from two cladding cell values, not a gate. */
export const BALANCE_TOLERANCE = 0.01;

export interface ParseInput {
  /** Text of <finalTime>/T */
  T: string;
  /** Text of <finalTime>/C (cell centres) */
  C: string;
  time: number;
  /** Text of <finalTime>/k, OFFBEAT's conductivity field, and of <finalTime>/Bu. Read for a burnup case, whose results check them; absent for others. */
  k?: string;
  Bu?: string;
  /** The text of the last time's displacement, stress, gap width and interface pressure fields, for a case that asks for mechanics. */
  mechanics?: MechanicsInput;
  /**
   * What OFFBEAT printed for the last time step: max |dT/dt| / T over the cells (1/s). Present for runs read from a solver log; when
   * given, the steady-state check is made, and an absent or non-finite rate fails it (a run that cannot show it settled is not
   * silently called steady). Left out by callers that have no log, which then have no steady-state check.
   */
  drift?: { relativeRate: number | undefined };
}

/**
 * Build the results record for a validated case. Throws ResultsError for anything that is not a complete, finite,
 * consistent field set: wrong cell count, non-finite values, cell centres outside the pin, temperatures not above 0 K.
 */
export function buildResults(c: NormalizedCase, input: ParseInput): ResultsRecord {
  const T = parseScalarField(input.T, "T");
  const C = parseVectorField(input.C, "C");
  const expected = c.mesh.fuelCells + c.mesh.claddingCells;
  if (T.length !== expected) bad(`expected ${expected} cells (${c.mesh.fuelCells} fuel + ${c.mesh.claddingCells} cladding), found ${T.length}`);
  if (C.length !== T.length) bad(`T has ${T.length} cells but C has ${C.length}`);
  if (!(input.time > 0) || !Number.isFinite(input.time)) bad("final time is not a positive finite number");
  const { radial, fuel, clad } = radialSplit(c, T, C);
  // The final-time file must be whole: the boundary block follows the cell list, so a file cut short there is not accepted.
  if (!/\bboundaryField\b/.test(input.T)) bad("field T has no boundaryField (the file is cut short)");
  const wall = parsePatchValue(input.T, "cladOuter");
  if (wall === null) bad("field T has no value for the cladOuter patch (the file is cut short or malformed)");
  // last: the specific checks above give clearer messages; this one catches what they cannot (cut after the wall, in either file)
  assertWholeFoamFile(input.T, "T");
  assertWholeFoamFile(input.C, "C");

  return finishResults(c, { T, radial, fuel, clad, wall, input });
}

/** The cells of one slice split into the fuel and the cladding by radius: every centre inside the pin and inside a solid, none in the central hole, positive temperatures, distinct radii. */
export function radialSplit(c: NormalizedCase, T: number[], C: number[][]): { radial: RadialPoint[]; fuel: RadialPoint[]; clad: RadialPoint[] } {
  const r = C.map((p) => Math.hypot(p[0]!, p[1]!));
  const eps = 1e-9;
  r.forEach((x, i) => {
    if (x > c.claddingOuterRadius + eps) bad(`cell ${i} is outside the pin (r = ${x} m)`);
    // a centre must lie strictly inside the fuel or strictly inside the cladding wall, never in the gap or on an interface
    if (!(x < c.fuelRadius || x > c.claddingInnerRadius)) bad(`cell ${i} has its centre in the gap or on an interface (r = ${x} m)`);
    if (x < c.fuelInnerRadius + eps) bad(`cell ${i} has its centre inside the central hole (r = ${x} m, hole radius ${c.fuelInnerRadius} m)`);
  });
  T.forEach((t, i) => {
    if (!(t > 0)) bad(`cell ${i}: temperature ${t} K is not above 0 K`);
  });

  const radial: RadialPoint[] = r.map((x, i) => ({ r: x, T: T[i]!, region: x < c.fuelRadius ? "fuel" : "cladding" }));
  const fuel = radial.filter((p) => p.region === "fuel");
  const clad = radial.filter((p) => p.region === "cladding");
  if (fuel.length !== c.mesh.fuelCells || clad.length !== c.mesh.claddingCells) bad("cell centres do not split into the expected fuel and cladding counts");
  fuel.sort((a, b) => a.r - b.r);
  clad.sort((a, b) => a.r - b.r);
  for (const [name, pts] of [["fuel", fuel], ["cladding", clad]] as const) {
    for (let i = 1; i < pts.length; i++) if (!(pts[i]!.r - pts[i - 1]!.r > 1e-12)) bad(`two ${name} cells share a centre (r = ${pts[i]!.r} m): the cell centres are not distinct`);
  }
  return { radial, fuel, clad };
}

/** What a stack adds to the tolerances of a slice's checks: the estimated axial conduction, as K on a temperature field, W/m on a flux and K on the wall (src/core/stackResults.ts). */
export interface SliceAllowance {
  field: number;
  flux: number;
  wall: number;
}

export interface CellsContext {
  T: number[];
  radial: RadialPoint[];
  fuel: RadialPoint[];
  clad: RadialPoint[];
  wall: number | null;
  input: ParseInput;
  allow?: SliceAllowance;
}

/** The checks and the record of one slice (or of the whole one-slice pin) from its cells: shared by buildResults and the stack's builder. */
export function finishResults(c: NormalizedCase, x: CellsContext): ResultsRecord {
  const { T, radial, fuel, clad, wall, input } = x;
  const allow = x.allow ?? { field: 0, flux: 0, wall: 0 };
  // --- checks
  const kf = lawOf(c.fuelConductivity);
  const kc = lawOf(c.claddingConductivity);
  const checks: Check[] = [];
  // Energy balance from the solver's own cladding temperatures: the radial flux through the wall is 2 pi (K(T_i) - K(T_j)) / ln(r_j / r_i), with K the primitive of k(T)
  // (for k = a + b T that is 2 pi (a (T_i - T_j) + b/2 (T_i^2 - T_j^2)) / ln(r_j / r_i)), independent of the boundary form. Compared with the input linear heat rate.
  if (clad.length >= 2) {
    const a = clad[0]!;
    const b = clad[1]!;
    const qWall = (2 * Math.PI * (primitive(kc, a.T) - primitive(kc, b.T))) / Math.log(b.r / a.r);
    const rel = (qWall - c.qPrime) / c.qPrime;
    checks.push({ id: "energyBalance", label: "Energy balance (cladding wall flux vs input)", value: rel, unit: "relative", verdict: Math.abs(qWall - c.qPrime) <= BALANCE_TOLERANCE * c.qPrime + allow.flux ? "pass" : "fail", note: `flux from the two innermost cladding cells = ${qWall.toFixed(1)} W/m against ${c.qPrime} W/m; threshold ${BALANCE_TOLERANCE * 100}%` });
  }

  // Closed-form agreement (constant or linear conductivity), same discretization-error bound used for the finite-volume cross-check.
  const filmDrop = c.boundary.kind === "convective" ? closedForm.filmDeltaT(c.qPrime, c.claddingOuterRadius, c.boundary.heatTransferCoefficient) : 0;
  const tOuter = c.boundary.kind === "convective" ? c.boundary.bulkTemperature + filmDrop : c.boundary.surfaceTemperature;
  const claddingAt = (r: number) => solveHot(kc, tOuter, (c.qPrime * Math.log(c.claddingOuterRadius / r)) / (2 * Math.PI));
  const tCladInner = claddingAt(c.claddingInnerRadius);
  const tFuelSurface = tCladInner + closedForm.gapDeltaT(c.qPrime, c.fuelRadius, c.gapConductance);
  // the hottest fuel point: the axis of solid fuel, or the surface of the central hole
  const fuelDeltaT = fuelTemperatureLaw(kf, c.qPrime, c.fuelRadius, c.fuelInnerRadius === 0 ? 0 : c.fuelInnerRadius, tFuelSurface, c.fuelInnerRadius) - tFuelSurface;
  const claddingDeltaT = tCladInner - tOuter;
  const fuelErr = Math.max(...fuel.map((p) => Math.abs(p.T - fuelTemperatureLaw(kf, c.qPrime, c.fuelRadius, p.r, tFuelSurface, c.fuelInnerRadius))));
  const cladErr = Math.max(...clad.map((p) => Math.abs(p.T - claddingAt(p.r))));
  const fuelBound = (5 * fuelDeltaT) / (c.mesh.fuelCells * c.mesh.fuelCells) + allow.field;
  const cladBound = (5 * claddingDeltaT) / (c.mesh.claddingCells * c.mesh.claddingCells) + allow.field;
  checks.push({ id: "closedFormFuel", label: "Fuel vs closed form (max deviation)", value: fuelErr, unit: "K", verdict: fuelErr < fuelBound ? "pass" : "fail", note: `bound 5 dT / N^2 = ${fuelBound.toFixed(3)} K for ${c.mesh.fuelCells} cells` });
  checks.push({ id: "closedFormCladding", label: "Cladding vs closed form (max deviation)", value: cladErr, unit: "K", verdict: cladErr < cladBound ? "pass" : "fail", note: `bound 5 dT / N^2 = ${cladBound.toFixed(3)} K for ${c.mesh.claddingCells} cells` });
  if (wall !== null) {
    const d = Math.abs(wall - tOuter);
    checks.push({ id: "wallTemperature", label: "Outer wall temperature vs closed form", value: d, unit: "K", verdict: d < 0.05 + allow.wall ? "pass" : "fail", note: `solver ${wall} K, closed form ${tOuter.toFixed(3)} K; threshold ${(0.05 + allow.wall).toPrecision(3)} K` });
  }

  // Property range: a conductivity law is used outside its stated range => the result is out-of-domain, never plain success.
  const findings: DomainFinding[] = [];
  // The cell-centre values stop a cell short of the axis (and of the hole surface), so the closed-form hottest and surface points of each solid count as well: a stated range
  // whose upper end lies between the first cell and the true hottest point is crossed.
  const range = (region: "fuel" | "cladding", k: Conductivity, pts: RadialPoint[], extra: number[]) => {
    const r = rangeOf(k);
    if (!r) return;
    const t = [...pts.map((p) => p.T), ...extra];
    const lo = Math.min(...t);
    const hi = Math.max(...t);
    if (lo < r[0] || hi > r[1]) findings.push({ region, produced: [lo, hi], validRange: r });
  };
  range("fuel", c.fuelConductivity, fuel, [tFuelSurface, tFuelSurface + fuelDeltaT]);
  range("cladding", c.claddingConductivity, clad, [tOuter, tCladInner]);
  const domain = { verdict: (findings.length === 0 ? "in-domain" : "out-of-domain") as "in-domain" | "out-of-domain", findings };
  if (rangeOf(c.fuelConductivity) || rangeOf(c.claddingConductivity)) {
    checks.push({ id: "propertyRange", label: "Conductivity law within its stated range", value: null, unit: "", verdict: findings.length === 0 ? "pass" : "fail", note: findings.length === 0 ? "all cell temperatures and the closed-form hottest and surface points inside the stated range" : findings.map((f) => `${f.region}: ${f.produced.map((x) => x.toFixed(0)).join("-")} K outside ${f.validRange.join("-")} K`).join("; ") + ". The law was extrapolated; this result is out-of-domain." });
  }

  checks.push(...fitChecks(c));
  if (c.limits) {
    const hot = (region: "fuel" | "cladding") => radial.filter((p) => p.region === region).reduce((m, p) => (p.T > m ? p.T : m), -Infinity);
    checks.push(...limitChecks(c.limits, [{ time: 0, fuelMax: hot("fuel"), claddingMax: hot("cladding") }]));
  }

  if (input.drift !== undefined) {
    // Steady-state gate (src/core/steadyState.ts): after an implicit step the deviation still to go is K^-1 C (dT/dt), so its largest
    // value is at most the worst Elmore delay times the largest |dT/dt|, which is OFFBEAT's printed relative rate times the hottest T.
    const hottest = radial.reduce((m, p) => (p.T > m ? p.T : m), -Infinity);
    const rate = input.drift.relativeRate;
    if (rate === undefined || !Number.isFinite(rate)) {
      checks.push({ id: "steadyState", label: "Steady state reached (bound on what is still to change)", value: null, unit: "K", verdict: "fail", note: "the solver log has no finite temperature-rate record for the last step, so how far the run is from steady cannot be judged" });
    } else {
      const bound = remainingChangeBound(c, rate, hottest);
      checks.push({ id: "steadyState", label: "Steady state reached (bound on what is still to change)", value: bound, unit: "K", verdict: bound <= STEADY_TOLERANCE ? "pass" : "fail", note: `at most ${bound.toPrecision(3)} K is still to change after the last step (OFFBEAT's last relative rate ${rate}, hottest cell ${hottest.toFixed(1)} K); threshold ${STEADY_TOLERANCE} K` });
    }
  }

  if (c.burnup && c.fuelConductivity.kind === "uo2-nfi") checks.push(...burnupChecks(c, T, input));
  // mechanics: read the displacement and the stress back in the order of the cells, then in the order of the record's points (fuel, then cladding, each by radius)
  let mechanics: MechanicsRecord | undefined;
  if (c.mechanics) {
    const eff = effectiveMechanics(c)!;
    const built = buildMechanics(c.mechanics, eff, radial.map((p) => ({ region: p.region, r: p.r })), input.mechanics ?? {});
    checks.push(...built.checks);
    if (built.record) {
      const order = [...fuel, ...clad].map((p) => radial.indexOf(p));
      mechanics = { ...built.record, points: order.map((i) => built.record!.points[i]!) };
      checks.push(...mechanicsChecks(c, eff, mechanics, [...fuel, ...clad].map((p) => ({ region: p.region, r: p.r }))));
      if (c.mechanics.stressLimits) checks.push(...stressLimitChecks(c.mechanics.stressLimits, mechanics, [...fuel, ...clad].map((p) => ({ region: p.region, T: p.T }))));
    }
  }
  for (const ch of checks) if (ch.value !== null && !Number.isFinite(ch.value)) bad(`check ${ch.id} is not a finite number (${ch.value}); the cell geometry is inconsistent`);
  const temps = radial.map((p) => p.T);
  return {
    schema: "feed.results/0.1",
    caseId: c.caseId,
    time: input.time,
    radial: [...fuel, ...clad],
    summary: {
      centreCellT: fuel[0]!.T,
      fuelSurfaceCellT: fuel[fuel.length - 1]!.T,
      claddingInnerCellT: clad[0]!.T,
      claddingOuterWallT: wall,
      maxT: Math.max(...temps),
      minT: Math.min(...temps),
    },
    checks,
    domain,
    thermalOnly: c.mechanics ? MECHANICS_TEXT : c.burnup ? THERMAL_ONLY_TEXT + " " + burnupText(c.burnup.value) : THERMAL_ONLY_TEXT,
    ...(c.burnup ? { burnup: c.burnup } : {}),
    ...(mechanics ? { mechanics } : {}),
  };
}


/** A scalar field that may be written compactly as `uniform X` (OFFBEAT does that when every cell is equal): expanded to n values. */
function cellValues(text: string, name: string, n: number): number[] {
  assertWholeFoamFile(text, name);
  const u = /internalField\s+uniform\s+([^;\s]+)\s*;/.exec(text);
  if (u) {
    const v = Number(u[1]);
    if (!Number.isFinite(v)) bad(`field ${name}: the uniform value is not finite (${u[1]})`);
    return Array.from({ length: n }, () => v);
  }
  const v = parseScalarField(text, name);
  if (v.length !== n) bad(`field ${name} has ${v.length} cells, the case has ${n}`);
  return v;
}

/**
 * The checks of a burnup case: OFFBEAT's own conductivity field `k` against FEED's burnup law at OFFBEAT's own cell temperatures (the model's arithmetic, cell by cell,
 * apart from the temperature solution), and the `Bu` field against what the writer wrote (B x 1000 x 0.881 in the fuel cells, 0 in the cladding): a wrong basis would show
 * here. A result without those fields fails them; it is not passed for want of evidence.
 */
function burnupChecks(c: NormalizedCase, T: number[], input: ParseInput): Check[] {
  const nf = c.mesh.fuelCells;
  const law = lawOf(c.fuelConductivity);
  const B = c.burnup!.value;
  const out: Check[] = [];
  const missing = (id: string, label: string, what: string): Check => ({ id, label, value: null, unit: "relative", verdict: "fail", note: `OFFBEAT wrote no ${what} field (or it was not collected), so ${label.toLowerCase()} cannot be checked.` });
  if (input.k === undefined) out.push(missing("burnupConductivity", "Burnup conductivity (OFFBEAT's k against the law)", "conductivity (k)"));
  else {
    const k = cellValues(input.k, "k", T.length);
    let worst = 0;
    let at = 0;
    for (let i = 0; i < nf; i++) {
      const want = evaluate(law, T[i]!);
      const d = Math.abs(k[i]! / want - 1);
      if (!(d <= worst)) {
        worst = d;
        at = i;
      }
    }
    out.push({
      id: "burnupConductivity",
      label: "Burnup conductivity (OFFBEAT's k against the law)",
      value: worst,
      unit: "relative",
      verdict: worst <= BURNUP_K_TOLERANCE ? "pass" : "fail",
      note: `The conductivity OFFBEAT used in each of the ${nf} fuel cells, against FEED's law (UO2, modified NFI, NUREG/CR-7024 Eq. 2.3-10 and 2.3-11) at ${B} MWd/kgHM, evaluated at OFFBEAT's own cell temperature. Largest relative difference ${worst.toExponential(2)} at fuel cell ${at} (accepted: ${BURNUP_K_TOLERANCE}); the field holds 7 digits.`,
    });
  }
  if (input.Bu === undefined) out.push(missing("burnupWritten", "Burnup given to OFFBEAT", "burnup (Bu)"));
  else {
    const bu = cellValues(input.Bu, "Bu", T.length);
    const want = B * 1000 * NFI_OXIDE_TO_HEAVY_METAL;
    let worst = 0;
    for (let i = 0; i < T.length; i++) {
      const w = i < nf ? want : 0;
      const d = w === 0 ? Math.abs(bu[i]!) : Math.abs(bu[i]! / w - 1);
      if (!(d <= worst)) worst = d;
    }
    out.push({
      id: "burnupWritten",
      label: "Burnup given to OFFBEAT",
      value: worst,
      unit: "relative",
      verdict: worst <= BURNUP_BU_TOLERANCE ? "pass" : "fail",
      note: `The Bu field of the result against what was written: ${B} MWd/kgHM x 1000 x 0.881 = ${Number(want.toPrecision(8))} MWd/t of oxide in each fuel cell and 0 in the cladding (the model divides by its own 0.881, docs/spike/burnup-probe.md). Largest difference ${worst.toExponential(2)} (accepted: ${BURNUP_BU_TOLERANCE}).`,
    });
  }
  return out;
}
