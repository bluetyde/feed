// Reading a steady particle back from OFFBEAT's output (plan 13, T3): the temperature of every cell, the cell centres, the cell zones, and the values on the three patches the
// results need, turned into a results record with independent checks. Pure functions on text; no solver, no files. Damaged, inconsistent or non-finite output is REFUSED
// (ResultsError), never turned into a partial result.
//
// The tolerances are fixed here, before the first real run, and are justified from docs/spike/triso-probe.md:
//   - a cell against the closed form at the cell's own radius (one check per region): 5 dT / N^2 for the region's own drop dT and N cells (the pin's discretisation bound), plus
//     0.5 % of the particle's rise (centre above the outside), at least 0.01 K. The probe's buffer deviates by up to 0.076 K of a 48 K rise on the finest mesh without shrinking
//     (unexplained), and a 12-cell kernel by 0.05 K; 0.5 % of 48 K is 0.24 K, 0.3 K being the plan's own figure.
//   - against the independent finite-volume solution on the same mesh: 0.3 % of the rise (the two saved runs of T2 agree to 0.2 % of the rise), at least 0.02 K.
//   - the energy balance: 0.5 % of the power plus the rounding of the output, from the first and last cell of the outermost layer (exact for the 1/r profile of a shell, whatever the conductivity law).
//   - the gap's drop: 1 % of the closed-form drop plus 0.005 K (the probe found it to 0.04 %).
//   - the wall: 0.05 K (the pin's), the steadiness: 0.01 K still to change (the pin's).
// Everything is compared with the sphere the wedge solves (wedgeEquivalent in trisoWriter.ts), not with the nominal sphere: they differ by 0.03 % in every radius.

import { Law, evaluate, lawOf, primitive, rangeOf, solveHot } from "./conductivity";
import { SPHERE } from "./geometry";
import { assertWholeFoamFile, Check, parsePatchValue, parseScalarField, parseVectorField, ResultsError, THERMAL_ONLY_TEXT } from "./resultsParser";
import { STEADY_TOLERANCE } from "./steadyState";
import type { NormalizedTriso } from "./triso";
import { trisoLimitChecks } from "./trisoLimits";
import { steadyTrisoFv, trisoClosedForm, trisoModelOf, trisoTimeScale, TrisoRegionName } from "./trisoSolve";
import { TRISO_PATCHES, TRISO_WEDGE_SCALE, TRISO_ZONE, wedgeEquivalent } from "./trisoWriter";
import type { Conductivity } from "./validate";

const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};

export const TRISO_CLOSED_FORM_DISCRETISATION = 5; // times the region's drop over N^2 (the pin's)
export const TRISO_CLOSED_FORM_RISE_FRACTION = 0.005;
export const TRISO_CLOSED_FORM_FLOOR = 0.01; // K
export const TRISO_FV_RISE_FRACTION = 0.003;
export const TRISO_FV_FLOOR = 0.02; // K
export const TRISO_BALANCE_TOLERANCE = 0.005;
/** OFFBEAT writes its fields with this many significant digits; a temperature is therefore known to half a unit of the last digit. */
export const TRISO_OUTPUT_DIGITS = 8;

/**
 * The tolerance of the energy balance taken from two neighbouring cells of the outermost layer: the fixed part, plus what the rounding of the two
 * temperatures to TRISO_OUTPUT_DIGITS significant digits can do to the heat read from their difference. The heat is k (Ta - Tb) / resistance, so the
 * rounding (each temperature within half a unit of its last digit, the difference within one unit) moves it by k x one unit / (resistance x power).
 * A thin outer layer at a high temperature has a small difference and a large term; a mistake of a few percent in the power still fails.
 */
export function balanceTolerance(Ta: number, Tb: number, kMean: number, resistance: number, power: number): { tolerance: number; resolution: number } {
  const top = Math.max(Math.abs(Ta), Math.abs(Tb));
  const unit = top > 0 ? 10 ** (Math.floor(Math.log10(top)) - (TRISO_OUTPUT_DIGITS - 1)) : 0;
  const resolution = (kMean * unit) / (resistance * power);
  return { tolerance: TRISO_BALANCE_TOLERANCE + resolution, resolution };
}
export const TRISO_GAP_FRACTION = 0.01;
export const TRISO_GAP_FLOOR = 0.005; // K
export const TRISO_WALL_TOLERANCE = 0.05; // K
/** A cell whose centre lies farther than this (relative) from where the case's mesh puts it is not a cell of this case. */
export const TRISO_CENTRE_TOLERANCE = 1e-3;

export const TRISO_THERMAL_ONLY_TEXT = THERMAL_ONLY_TEXT + " For a coated particle: the temperatures of the kernel and the layers, not the stress in the silicon carbide, the swelling and creep of the carbon, the gas pressure or a failure fraction.";

export interface TrisoCell {
  /** metres: the length of the cell-centre vector (the radius on the sphere the wedge solves) */
  r: number;
  T: number;
  region: TrisoRegionName;
}

export interface TrisoRegionResult {
  name: TrisoRegionName;
  /** metres, on the sphere the wedge solves (the case's radii times the wedge scale) */
  innerRadius: number;
  outerRadius: number;
  /** The temperature at the region's inner and outer face, K: a patch value where the mesh has one (the gap's two faces, the outside), the kernel's centre from its parabola, an interface from the two cells beside it. */
  innerFaceT: number;
  outerFaceT: number;
  hottestCellT: number;
  coldestCellT: number;
  /** inner face minus outer face, K */
  drop: number;
}

export interface TrisoDomainFinding {
  region: TrisoRegionName;
  produced: [number, number];
  validRange: [number, number];
}

export interface TrisoResultsRecord {
  schema: "feed.results/0.1";
  kind: "triso";
  caseId: string;
  /** Final solver time in seconds. */
  time: number;
  cells: TrisoCell[];
  regions: TrisoRegionResult[];
  summary: {
    /** The kernel's centre, extrapolated from its first cell with the parabola of the kernel's conductivity. */
    kernelCentreT: number;
    kernelCentreCellT: number;
    kernelSurfaceT: number;
    wallT: number;
    /** The drop across the gap between the buffer and the next layer, from the two patch values. */
    gapDeltaT: number;
    maxT: number;
    minT: number;
  };
  checks: Check[];
  domain: { verdict: "in-domain" | "out-of-domain"; findings: TrisoDomainFinding[] };
  thermalOnly: string;
}

export interface TrisoInput {
  /** Text of <finalTime>/T, <finalTime>/C and constant/polyMesh/cellZones */
  T: string;
  C: string;
  cellZones: string;
  time: number;
  /** OFFBEAT's last relative rate (1/s); when present the steady-state check is made, and an absent or non-finite rate fails it. */
  drift?: { relativeRate: number | undefined };
}

/** The cell labels of each zone of `constant/polyMesh/cellZones`, by zone name. */
export function parseCellZones(text: string): Map<string, number[]> {
  assertWholeFoamFile(text, "cellZones");
  const zones = new Map<string, number[]>();
  const re = /(\w+)\s*\{\s*type\s+cellZone\s*;\s*cellLabels\s+List<label>\s*(\d+)\s*\(([^)]*)\)\s*;/g;
  for (const m of text.matchAll(re)) {
    const labels = m[3]!.trim().split(/\s+/).filter(Boolean).map(Number);
    if (labels.length !== Number(m[2])) bad(`cellZones: zone ${m[1]} declares ${m[2]} cells but lists ${labels.length}`);
    if (!labels.every((x) => Number.isInteger(x) && x >= 0)) bad(`cellZones: zone ${m[1]} has a label that is not a cell number`);
    if (zones.has(m[1]!)) bad(`cellZones: zone ${m[1]} is listed twice`);
    zones.set(m[1]!, labels);
  }
  if (zones.size === 0) bad("cellZones: no cell zone found (the file is malformed)");
  return zones;
}

const regionNames = (n: NormalizedTriso): TrisoRegionName[] => ["kernel", ...n.layers.map((l) => l.name)];
const lawsOf = (n: NormalizedTriso): Law[] => [lawOf(n.kernelConductivity), ...n.layers.map((l) => lawOf(l.conductivity))];

/**
 * The temperature of an interface from the cells either side, the way a finite-volume scheme has it: the two half-cell resistances to the face in series, each with the conductivity
 * of its own cell, carry the same heat.
 */
function interfaceT(rA: number, TA: number, kA: Law, rB: number, TB: number, kB: Law, face: number): number {
  const gA = 1 / SPHERE.resist(rA, face, evaluate(kA, TA));
  const gB = 1 / SPHERE.resist(face, rB, evaluate(kB, TB));
  return (gA * TA + gB * TB) / (gA + gB);
}

export interface ParticleCells {
  /** The region (index into the case's regions, kernel first) and the radius (the length of the cell-centre vector, m) of each cell by its number in the mesh. */
  regionOf: number[];
  radius: number[];
  /** The mesh numbers of the cells by increasing radius. */
  order: number[];
  /** The radii of the sphere the wedge solves between the regions (0, the kernel's, each layer's outer). */
  bounds: number[];
  eq: NormalizedTriso;
  names: TrisoRegionName[];
}

/**
 * Put the cells of a run into the particle's regions: the cell zones name them, the cell-centre vectors give each one's radius. Refuses zones that are not the case's, a cell in two
 * zones or in none, a cell in a zone whose radii it is not between, and two cells at one centre. Shared by the steady and the transient results.
 */
export function readParticleCells(n: NormalizedTriso, C: number[][], zonesText: string): ParticleCells {
  const names = regionNames(n);
  const total = n.cells.reduce((a, b) => a + b, 0);
  if (C.length !== total) bad(`C has ${C.length} cells, the case has ${total}`);
  // the zones: exactly the particle's regions, each with its cells, covering every cell once
  const zones = parseCellZones(zonesText);
  const wantedZones = names.map((k) => TRISO_ZONE[k as keyof typeof TRISO_ZONE]);
  for (const z of zones.keys()) if (!wantedZones.includes(z)) bad(`cellZones: zone ${z} is not a region of this particle (${wantedZones.join(", ")})`);
  const regionOf = new Array<number>(total).fill(-1);
  names.forEach((k, ri) => {
    const labels = zones.get(TRISO_ZONE[k as keyof typeof TRISO_ZONE]);
    if (!labels) return bad(`cellZones: zone ${TRISO_ZONE[k as keyof typeof TRISO_ZONE]} is missing`);
    if (labels.length !== n.cells[ri]) bad(`cellZones: zone ${TRISO_ZONE[k as keyof typeof TRISO_ZONE]} has ${labels.length} cells, the case has ${n.cells[ri]} ${k} cells`);
    for (const l of labels) {
      if (l >= total) bad(`cellZones: zone ${TRISO_ZONE[k as keyof typeof TRISO_ZONE]} names cell ${l}, but there are ${total} cells`);
      if (regionOf[l] !== -1) bad(`cellZones: cell ${l} is in two zones`);
      regionOf[l] = ri;
    }
  });
  const eq = wedgeEquivalent(n);
  const bounds = [0, eq.kernelRadius, ...eq.layers.map((l) => l.outerRadius)];
  const radius = C.map((p) => Math.hypot(p[0]!, p[1]!, p[2]!));
  radius.forEach((r, i) => {
    const ri = regionOf[i]!;
    const lo = bounds[ri]!;
    const hi = bounds[ri + 1]!;
    if (!(r > lo * (1 - 1e-9) && r < hi * (1 + 1e-9))) bad(`cell ${i} is in the ${names[ri]} zone but its centre, r = ${r} m, is not between ${lo} and ${hi} m: the zones and the cell centres do not belong together`);
  });
  const order = radius.map((_, i) => i).sort((a, b) => radius[a]! - radius[b]!);
  for (let i = 1; i < order.length; i++) if (!(radius[order[i]!]! - radius[order[i - 1]!]! > 1e-12)) bad(`two cells share a centre (r = ${radius[order[i]!]} m): the cell centres are not distinct`);
  return { regionOf, radius, order, bounds, eq, names };
}

/**
 * Build the results record of a steady particle. Throws ResultsError for anything that is not a complete, finite, consistent field set: the wrong number of cells, a cell in a zone
 * whose radii it is not within, zones that are not the case's, non-finite or non-positive temperatures, a missing patch.
 */
export function buildTrisoResults(n: NormalizedTriso, input: TrisoInput): TrisoResultsRecord {
  const T = parseScalarField(input.T, "T");
  const C = parseVectorField(input.C, "C");
  const names = regionNames(n);
  const expected = n.cells.reduce((a, b) => a + b, 0);
  if (T.length !== expected) bad(`expected ${expected} cells (${n.cells.map((c, i) => c + " " + names[i]).join(" + ")}), found ${T.length}`);
  if (C.length !== T.length) bad(`T has ${T.length} cells but C has ${C.length}`);
  if (!(input.time > 0) || !Number.isFinite(input.time)) bad("final time is not a positive finite number");
  T.forEach((t, i) => {
    if (!(t > 0)) bad(`cell ${i}: temperature ${t} K is not above 0 K`);
  });
  // the boundary block follows the cell list: a file cut short there is not accepted
  if (!/\bboundaryField\b/.test(input.T)) bad("field T has no boundaryField (the file is cut short)");
  const patch = (name: string): number => {
    const v = parsePatchValue(input.T, name);
    if (v === null) return bad(`field T has no value for the ${name} patch (the file is cut short or malformed)`);
    return v;
  };
  const wall = patch(TRISO_PATCHES.outer);
  const gapIn = patch(TRISO_PATCHES.gapInner);
  const gapOut = patch(TRISO_PATCHES.gapOuter);
  assertWholeFoamFile(input.T, "T");
  assertWholeFoamFile(input.C, "C");

  const { regionOf, radius, order, bounds, eq } = readParticleCells(n, C, input.cellZones);
  const cells: TrisoCell[] = order.map((i) => ({ r: radius[i]!, T: T[i]!, region: names[regionOf[i]!]! }));

  // the sphere the wedge solves, in closed form and finite volumes, on the same mesh
  const closed = trisoClosedForm(eq);
  const laws = lawsOf(n);
  const fv = steadyTrisoFv(trisoModelOf(eq), eq.power.particlePower);
  const rise = Math.max(closed.centreT - closed.wallT, 0);
  const checks: Check[] = [];

  // --- the closed form at each cell's own radius, region by region
  regionNames(n).forEach((name, ri) => {
    const mine = cells.filter((c) => c.region === name);
    let worst = 0;
    for (const c of mine) worst = Math.max(worst, Math.abs(c.T - closed.temperatureAt(Math.min(c.r, eq.outerRadius))));
    const reg = closed.regions[ri]!;
    const regionDrop = Math.abs(reg.innerT - reg.outerT);
    const bound = (TRISO_CLOSED_FORM_DISCRETISATION * regionDrop) / (n.cells[ri]! * n.cells[ri]!) + Math.max(TRISO_CLOSED_FORM_RISE_FRACTION * rise, TRISO_CLOSED_FORM_FLOOR);
    checks.push({
      id: "closedForm" + name[0]!.toUpperCase() + name.slice(1),
      label: `${TRISO_ZONE[name as keyof typeof TRISO_ZONE]} vs closed form (max deviation)`,
      value: worst,
      unit: "K",
      verdict: worst < bound ? "pass" : "fail",
      note: `each cell against the closed form of the sphere the wedge solves, at the cell's own radius; bound ${bound.toFixed(3)} K = 5 x ${regionDrop.toPrecision(3)} K / ${n.cells[ri]}^2 + ${Math.max(TRISO_CLOSED_FORM_RISE_FRACTION * rise, TRISO_CLOSED_FORM_FLOOR).toPrecision(3)} K (0.5 % of the ${rise.toPrecision(3)} K rise)`,
    });
  });

  // --- the finite-volume solution, cell by cell
  let fvWorst = 0;
  let fvCentre = 0;
  cells.forEach((c, i) => {
    fvWorst = Math.max(fvWorst, Math.abs(c.T - fv.T[i]!));
    fvCentre = Math.max(fvCentre, Math.abs(c.r / fv.r[i]! - 1));
  });
  if (fvCentre > TRISO_CENTRE_TOLERANCE) bad(`the cell centres differ from the case's mesh by up to ${(fvCentre * 100).toPrecision(3)} %: this output is not the mesh the case would give`);
  const fvBound = Math.max(TRISO_FV_RISE_FRACTION * rise, TRISO_FV_FLOOR);
  checks.push({ id: "crossCheckFv", label: "Cells vs the independent finite-volume solution (max deviation)", value: fvWorst, unit: "K", verdict: fvWorst < fvBound ? "pass" : "fail", note: `the same mesh solved by FEED's own finite-volume code (src/core/trisoSolve.ts); bound ${fvBound.toPrecision(3)} K (0.3 % of the ${rise.toPrecision(3)} K rise, at least ${TRISO_FV_FLOOR} K)` });

  // --- energy balance from the outermost layer (its first and last cell): the flux through a shell is 4 pi (K(Ta) - K(Tb)) / (1/ra - 1/rb), whatever the conductivity law
  {
    // the outermost layer has at least two cells (the validator's minimum, and the cell count was checked above); the flux is read between its first and its last cell, the
    // widest difference the layer offers, so that the rounding of the output weighs least
    const last = cells.length - 1;
    let first = last;
    while (first > 0 && cells[first - 1]!.region === cells[last]!.region) first--;
    const a = cells[first]!;
    const b = cells[last]!;
    const kLast = laws[laws.length - 1]!;
    const resist = SPHERE.resist(a.r, b.r, 1);
    const Q = (primitive(kLast, a.T) - primitive(kLast, b.T)) / resist;
    const want = eq.power.particlePower;
    const rel = (Q - want) / want;
    const bal = balanceTolerance(a.T, b.T, 0.5 * (evaluate(kLast, a.T) + evaluate(kLast, b.T)), resist, want);
    checks.push({ id: "energyBalance", label: "Energy balance (heat through the outer layer vs the power made)", value: rel, unit: "relative", verdict: Math.abs(rel) <= bal.tolerance ? "pass" : "fail", note: `heat through the outermost layer (its first to its last cell) = ${Q.toPrecision(6)} W against ${want.toPrecision(6)} W made in the wedge's kernel (the input ${n.power.particlePower.toPrecision(6)} W times ${(want / n.power.particlePower).toPrecision(6)}: the wedge is the sphere with its radii times ${TRISO_WEDGE_SCALE.toFixed(6)}); threshold ${TRISO_BALANCE_TOLERANCE * 100} % plus ${(bal.resolution * 100).toPrecision(2)} % for the ${TRISO_OUTPUT_DIGITS}-digit rounding of the two temperatures (${(bal.tolerance * 100).toPrecision(3)} % in all)` });
  }

  // --- the gap's drop and the wall
  const gapMeasured = gapIn - gapOut;
  const gapBound = TRISO_GAP_FRACTION * closed.gapDeltaT + TRISO_GAP_FLOOR;
  checks.push({ id: "gapDrop", label: "Drop across the gap vs power / (area x conductance)", value: gapMeasured - closed.gapDeltaT, unit: "K", verdict: Math.abs(gapMeasured - closed.gapDeltaT) <= gapBound ? "pass" : "fail", note: `${TRISO_PATCHES.gapInner} ${gapIn} K minus ${TRISO_PATCHES.gapOuter} ${gapOut} K = ${gapMeasured.toPrecision(5)} K against ${closed.gapDeltaT.toPrecision(5)} K from P / (4 pi R^2 h); bound ${gapBound.toPrecision(3)} K` });
  const wallErr = Math.abs(wall - closed.wallT);
  checks.push({ id: "wallTemperature", label: "Outer wall temperature vs closed form", value: wallErr, unit: "K", verdict: wallErr < TRISO_WALL_TOLERANCE ? "pass" : "fail", note: `solver ${wall} K, closed form ${closed.wallT.toFixed(3)} K; threshold ${TRISO_WALL_TOLERANCE} K` });

  // --- the conductivity laws within their stated ranges
  const findings: TrisoDomainFinding[] = [];
  const ks: Conductivity[] = [n.kernelConductivity, ...n.layers.map((l) => l.conductivity)];
  closed.regions.forEach((reg, ri) => {
    const r = rangeOf(ks[ri]!);
    if (!r) return;
    const t = [...cells.filter((c) => c.region === reg.name).map((c) => c.T), reg.innerT, reg.outerT];
    const lo = Math.min(...t);
    const hi = Math.max(...t);
    if (lo < r[0] || hi > r[1]) findings.push({ region: reg.name, produced: [lo, hi], validRange: r });
  });
  if (ks.some((k) => rangeOf(k))) {
    checks.push({ id: "propertyRange", label: "Conductivity law within its stated range", value: null, unit: "", verdict: findings.length === 0 ? "pass" : "fail", note: findings.length === 0 ? "all cell temperatures and the closed-form face temperatures inside the stated ranges" : findings.map((f) => `${f.region}: ${f.produced.map((x) => x.toFixed(0)).join("-")} K outside ${f.validRange.join("-")} K`).join("; ") + ". The law was extrapolated; this result is out-of-domain." });
  }

  // --- steady state: what the last step could still change, from OFFBEAT's own rate and the Elmore bound of the particle
  if (input.drift !== undefined) {
    const hottest = Math.max(...T);
    const rate = input.drift.relativeRate;
    if (rate === undefined || !Number.isFinite(rate)) {
      checks.push({ id: "steadyState", label: "Steady state reached (bound on what is still to change)", value: null, unit: "K", verdict: "fail", note: "the solver log has no finite temperature-rate record for the last step, so how far the run is from steady cannot be judged" });
    } else {
      const bound = trisoTimeScale(n).tauBound * Math.abs(rate) * hottest;
      checks.push({ id: "steadyState", label: "Steady state reached (bound on what is still to change)", value: bound, unit: "K", verdict: bound <= STEADY_TOLERANCE ? "pass" : "fail", note: `at most ${bound.toPrecision(3)} K is still to change after the last step (OFFBEAT's last relative rate ${rate}, hottest cell ${hottest.toFixed(1)} K); threshold ${STEADY_TOLERANCE} K` });
    }
  }
  // --- the stated limits: the hottest cell of each region against its limit (a steady result is one moment)
  if (n.limits) checks.push(...trisoLimitChecks(n.limits, [{ time: input.time, max: Object.fromEntries(names.map((nm) => [nm, Math.max(...cells.filter((c) => c.region === nm).map((c) => c.T))])) }]));
  for (const ch of checks) if (ch.value !== null && !Number.isFinite(ch.value)) bad(`check ${ch.id} is not a finite number (${ch.value}); the cell geometry is inconsistent`);

  // --- the record: the kernel's centre, the interfaces, the drops
  const byRegion = names.map((name) => cells.filter((c) => c.region === name));
  const kernelFirst = byRegion[0]![0]!;
  const kernelCentre = solveHot(laws[0]!, kernelFirst.T, (eq.power.kernelPowerDensity * kernelFirst.r ** 2) / 6);
  const interfaces = names.slice(0, -1).map((_, ri) => {
    const a = byRegion[ri]![byRegion[ri]!.length - 1]!;
    const b = byRegion[ri + 1]![0]!;
    return interfaceT(a.r, a.T, laws[ri]!, b.r, b.T, laws[ri + 1]!, bounds[ri + 1]!);
  });
  const regions: TrisoRegionResult[] = names.map((name, ri) => {
    // the buffer's outer face and the next layer's inner face are patches; the others are interfaces of two cells; the outside is a patch
    const innerFaceT = ri === 0 ? kernelCentre : ri === 2 ? gapOut : interfaces[ri - 1]!;
    const outerFaceT = ri === names.length - 1 ? wall : ri === 1 ? gapIn : interfaces[ri]!;
    const ts = byRegion[ri]!.map((c) => c.T);
    return { name, innerRadius: bounds[ri]!, outerRadius: bounds[ri + 1]!, innerFaceT, outerFaceT, hottestCellT: Math.max(...ts), coldestCellT: Math.min(...ts), drop: innerFaceT - outerFaceT };
  });
  return {
    schema: "feed.results/0.1",
    kind: "triso",
    caseId: n.caseId,
    time: input.time,
    cells,
    regions,
    summary: { kernelCentreT: kernelCentre, kernelCentreCellT: kernelFirst.T, kernelSurfaceT: regions[0]!.outerFaceT, wallT: wall, gapDeltaT: gapMeasured, maxT: Math.max(...T), minT: Math.min(...T) },
    checks,
    domain: { verdict: findings.length === 0 ? "in-domain" : "out-of-domain", findings },
    thermalOnly: TRISO_THERMAL_ONLY_TEXT,
  };
}

export const isTrisoResults = (r: unknown): r is TrisoResultsRecord => !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "triso";
