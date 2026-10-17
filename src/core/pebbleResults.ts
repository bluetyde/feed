// Reading a steady pebble back from OFFBEAT's output (plan 13, T4): the temperature of every cell, the cell centres, the cell zones and the outside's patch value, turned into a
// results record with independent checks. Pure functions on text; damaged, inconsistent or non-finite output is REFUSED (ResultsError), never turned into a partial result.
//
// The tolerances are those of the particle (src/core/trisoResults.ts), fixed before the first run and unchanged:
//   - a cell against the closed form at the cell's own radius, per region: 5 dT / N^2 for the region's own drop and N cells, plus 0.5 % of the pebble's rise (at least 0.01 K);
//   - against the independent finite-volume solution: 0.3 % of the rise (at least 0.02 K);
//   - the energy balance 0.5 % of the power, from the two outermost cells; the wall 0.05 K; the steadiness 0.01 K still to change.
// Everything is compared with the sphere the wedge solves (pebbleWedgeEquivalent), not the nominal one.

import { evaluate, primitive, solveHot } from "./conductivity";
import { buildCompactRecord, CompactRecord } from "./compact";
import { SPHERE } from "./geometry";
import { NormalizedPebble, pebbleClosedForm, pebbleLaws, pebbleModel, pebbleRanges, pebbleTimeScale, pebbleWedgeEquivalent } from "./pebble";
import { PEBBLE_PATCH, PEBBLE_ZONE } from "./pebbleWriter";
import { assertWholeFoamFile, Check, parsePatchValue, parseScalarField, parseVectorField, ResultsError, THERMAL_ONLY_TEXT } from "./resultsParser";
import { STEADY_TOLERANCE } from "./steadyState";
import { parseCellZones } from "./trisoResults";
import { steadyTrisoFv } from "./trisoSolve";
import { TRISO_WEDGE_SCALE } from "./trisoWedge";

const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};

export const PEBBLE_CLOSED_FORM_DISCRETISATION = 5;
export const PEBBLE_CLOSED_FORM_RISE_FRACTION = 0.005;
export const PEBBLE_CLOSED_FORM_FLOOR = 0.01; // K
export const PEBBLE_FV_RISE_FRACTION = 0.003;
export const PEBBLE_FV_FLOOR = 0.02; // K
export const PEBBLE_BALANCE_TOLERANCE = 0.005;
export const PEBBLE_WALL_TOLERANCE = 0.05; // K
export const PEBBLE_CENTRE_TOLERANCE = 1e-3;

export const PEBBLE_THERMAL_ONLY_TEXT = THERMAL_ONLY_TEXT + " For a pebble: the temperatures of a homogenised fuelled zone and its shell, and the two-scale temperature of the hottest particle; not the stress in a particle, fission-gas release or a failure fraction.";

export type PebbleRegionName = "fuelled" | "shell";

export interface PebbleCell {
  /** metres: the length of the cell-centre vector (the radius on the sphere the wedge solves) */
  r: number;
  T: number;
  region: PebbleRegionName;
}

export interface PebbleRegionResult {
  name: PebbleRegionName;
  innerRadius: number;
  outerRadius: number;
  innerFaceT: number;
  outerFaceT: number;
  hottestCellT: number;
  coldestCellT: number;
  drop: number;
}

export interface PebbleResultsRecord {
  schema: "feed.results/0.1";
  kind: "pebble";
  caseId: string;
  time: number;
  cells: PebbleCell[];
  regions: PebbleRegionResult[];
  summary: { centreT: number; centreCellT: number; interfaceT: number; wallT: number; maxT: number; minT: number };
  checks: Check[];
  domain: { verdict: "in-domain" | "out-of-domain"; findings: { region: PebbleRegionName; produced: [number, number]; validRange: [number, number] }[] };
  /** The mixture and the hottest particle (src/core/compact.ts). */
  compact: CompactRecord;
  thermalOnly: string;
}

export interface PebbleInput {
  T: string;
  C: string;
  cellZones: string;
  time: number;
  drift?: { relativeRate: number | undefined };
}

export function buildPebbleResults(p: NormalizedPebble, input: PebbleInput): PebbleResultsRecord {
  const T = parseScalarField(input.T, "T");
  const C = parseVectorField(input.C, "C");
  const total = p.cells[0] + p.cells[1];
  if (T.length !== total) bad(`expected ${total} cells (${p.cells[0]} fuelled + ${p.cells[1]} shell), found ${T.length}`);
  if (C.length !== T.length) bad(`T has ${T.length} cells but C has ${C.length}`);
  if (!(input.time > 0) || !Number.isFinite(input.time)) bad("final time is not a positive finite number");
  T.forEach((t, i) => {
    if (!(t > 0)) bad(`cell ${i}: temperature ${t} K is not above 0 K`);
  });
  if (!/\bboundaryField\b/.test(input.T)) bad("field T has no boundaryField (the file is cut short)");
  const wallV = parsePatchValue(input.T, PEBBLE_PATCH.outer);
  if (wallV === null) bad(`field T has no value for the ${PEBBLE_PATCH.outer} patch (the file is cut short or malformed)`);
  const wall = wallV as number;
  assertWholeFoamFile(input.T, "T");
  assertWholeFoamFile(input.C, "C");

  // the cells into their regions: the zones, then the radii
  const zones = parseCellZones(input.cellZones);
  const names: PebbleRegionName[] = ["fuelled", "shell"];
  for (const z of zones.keys()) if (z !== PEBBLE_ZONE.fuelled && z !== PEBBLE_ZONE.shell) bad(`cellZones: zone ${z} is not a region of this pebble (${PEBBLE_ZONE.fuelled}, ${PEBBLE_ZONE.shell})`);
  const regionOf = new Array<number>(total).fill(-1);
  names.forEach((nm, ri) => {
    const zone = PEBBLE_ZONE[nm];
    const labels = zones.get(zone);
    if (!labels) return bad(`cellZones: zone ${zone} is missing`);
    if (labels.length !== p.cells[ri]) bad(`cellZones: zone ${zone} has ${labels.length} cells, the case has ${p.cells[ri]}`);
    for (const l of labels) {
      if (l >= total) bad(`cellZones: zone ${zone} names cell ${l}, but there are ${total} cells`);
      if (regionOf[l] !== -1) bad(`cellZones: cell ${l} is in two zones`);
      regionOf[l] = ri;
    }
  });
  const eq = pebbleWedgeEquivalent(p);
  const bounds = [0, eq.fuelledRadius, eq.outerRadius];
  const radius = C.map((v) => Math.hypot(v[0]!, v[1]!, v[2]!));
  radius.forEach((r, i) => {
    const ri = regionOf[i]!;
    if (!(r > bounds[ri]! * (1 - 1e-9) && r < bounds[ri + 1]! * (1 + 1e-9))) bad(`cell ${i} is in the ${PEBBLE_ZONE[names[ri]!]} zone but its centre, r = ${r} m, is not between ${bounds[ri]} and ${bounds[ri + 1]} m: the zones and the cell centres do not belong together`);
  });
  const order = radius.map((_, i) => i).sort((a, b) => radius[a]! - radius[b]!);
  for (let i = 1; i < order.length; i++) if (!(radius[order[i]!]! - radius[order[i - 1]!]! > 1e-12)) bad(`two cells share a centre (r = ${radius[order[i]!]} m): the cell centres are not distinct`);
  const cells: PebbleCell[] = order.map((i) => ({ r: radius[i]!, T: T[i]!, region: names[regionOf[i]!]! }));

  const closed = pebbleClosedForm(eq);
  const laws = pebbleLaws(p);
  const fv = steadyTrisoFv(pebbleModel(eq), eq.power.fuelledPower);
  const rise = Math.max(closed.centreT - closed.wallT, 0);
  const checks: Check[] = [];
  const regionDrops = [closed.centreT - closed.interfaceT, closed.interfaceT - closed.wallT];
  names.forEach((nm, ri) => {
    const mine = cells.filter((c) => c.region === nm);
    let worst = 0;
    for (const c of mine) worst = Math.max(worst, Math.abs(c.T - closed.temperatureAt(Math.min(c.r, eq.outerRadius))));
    const floor = Math.max(PEBBLE_CLOSED_FORM_RISE_FRACTION * rise, PEBBLE_CLOSED_FORM_FLOOR);
    const bound = (PEBBLE_CLOSED_FORM_DISCRETISATION * Math.abs(regionDrops[ri]!)) / (p.cells[ri]! * p.cells[ri]!) + floor;
    checks.push({
      id: "closedForm" + nm[0]!.toUpperCase() + nm.slice(1),
      label: `${PEBBLE_ZONE[nm]} vs closed form (max deviation)`,
      value: worst,
      unit: "K",
      verdict: worst < bound ? "pass" : "fail",
      note: `each cell against the closed form of the sphere the wedge solves, at the cell's own radius; bound ${bound.toFixed(3)} K = 5 x ${Math.abs(regionDrops[ri]!).toPrecision(3)} K / ${p.cells[ri]}^2 + ${floor.toPrecision(3)} K (0.5 % of the ${rise.toPrecision(3)} K rise)`,
    });
  });
  let fvWorst = 0;
  let fvCentre = 0;
  cells.forEach((c, i) => {
    fvWorst = Math.max(fvWorst, Math.abs(c.T - fv.T[i]!));
    fvCentre = Math.max(fvCentre, Math.abs(c.r / fv.r[i]! - 1));
  });
  if (fvCentre > PEBBLE_CENTRE_TOLERANCE) bad(`the cell centres differ from the case's mesh by up to ${(fvCentre * 100).toPrecision(3)} %: this output is not the mesh the case would give`);
  const fvBound = Math.max(PEBBLE_FV_RISE_FRACTION * rise, PEBBLE_FV_FLOOR);
  checks.push({ id: "crossCheckFv", label: "Cells vs the independent finite-volume solution (max deviation)", value: fvWorst, unit: "K", verdict: fvWorst < fvBound ? "pass" : "fail", note: `the same mesh solved by FEED's own finite-volume code (src/core/trisoSolve.ts); bound ${fvBound.toPrecision(3)} K (0.3 % of the ${rise.toPrecision(3)} K rise, at least ${PEBBLE_FV_FLOOR} K)` });
  {
    // energy balance from the two outermost cells (both in the shell: the validator's minimum is two shell cells)
    const a = cells[total - 2]!;
    const b = cells[total - 1]!;
    const Q = (primitive(laws[1]!, a.T) - primitive(laws[1]!, b.T)) / SPHERE.resist(a.r, b.r, 1);
    const want = eq.power.fuelledPower;
    const rel = (Q - want) / want;
    checks.push({ id: "energyBalance", label: "Energy balance (heat through the shell vs the power made)", value: rel, unit: "relative", verdict: Math.abs(rel) <= PEBBLE_BALANCE_TOLERANCE ? "pass" : "fail", note: `heat through the two outermost cells = ${Q.toPrecision(6)} W against ${want.toPrecision(6)} W made in the wedge's fuelled zone (the input ${p.power.fuelledPower.toPrecision(6)} W times ${(want / p.power.fuelledPower).toPrecision(6)}: the wedge is the sphere with its radii times ${TRISO_WEDGE_SCALE.toFixed(6)}); threshold ${PEBBLE_BALANCE_TOLERANCE * 100} %` });
  }
  const wallErr = Math.abs(wall - closed.wallT);
  checks.push({ id: "wallTemperature", label: "Outer wall temperature vs closed form", value: wallErr, unit: "K", verdict: wallErr < PEBBLE_WALL_TOLERANCE ? "pass" : "fail", note: `solver ${wall} K, closed form ${closed.wallT.toFixed(3)} K; threshold ${PEBBLE_WALL_TOLERANCE} K` });

  // the conductivity laws within their ranges: the fuelled zone's is the table's range
  const findings: PebbleResultsRecord["domain"]["findings"] = [];
  const ranges = pebbleRanges(p);
  const faceTs = [[closed.centreT, closed.interfaceT], [closed.interfaceT, closed.wallT]];
  names.forEach((nm, ri) => {
    const r = ranges[ri];
    if (!r) return;
    const t = [...cells.filter((c) => c.region === nm).map((c) => c.T), ...faceTs[ri]!];
    const lo = Math.min(...t);
    const hi = Math.max(...t);
    if (lo < r[0] || hi > r[1]) findings.push({ region: nm, produced: [lo, hi], validRange: r });
  });
  checks.push({ id: "propertyRange", label: "Conductivity law within its stated range", value: null, unit: "", verdict: findings.length === 0 ? "pass" : "fail", note: findings.length === 0 ? "all cell temperatures and the closed-form face temperatures inside the stated ranges (the fuelled zone's is the range its mixture was tabulated over)" : findings.map((f) => `${f.region}: ${f.produced.map((x) => x.toFixed(0)).join("-")} K outside ${f.validRange.join("-")} K`).join("; ") + ". The law was extrapolated; this result is out-of-domain." });
  const fit = p.fuelledConductivity.kind === "polynomial" ? p.fuelledConductivity.fit : undefined;
  if (fit) checks.push({ id: "conductivityFitFuelled", label: "The fuelled zone's tabulated conductivity vs the polynomial that was run (max deviation at the table's points)", value: fit.maxRelativeDeviation, unit: "relative", verdict: fit.maxRelativeDeviation <= fit.tolerance ? "pass" : "fail", note: `a degree ${fit.degree} polynomial fitted to ${fit.points.length} points of the mixture; the largest deviation is ${(fit.maxRelativeDeviation * 100).toPrecision(3)} % at ${fit.worstAt} K; tolerance ${(fit.tolerance * 100).toPrecision(3)} %` });

  if (input.drift !== undefined) {
    const hottest = Math.max(...T);
    const rate = input.drift.relativeRate;
    if (rate === undefined || !Number.isFinite(rate)) checks.push({ id: "steadyState", label: "Steady state reached (bound on what is still to change)", value: null, unit: "K", verdict: "fail", note: "the solver log has no finite temperature-rate record for the last step, so how far the run is from steady cannot be judged" });
    else {
      const bound = pebbleTimeScale(p).tauBound * Math.abs(rate) * hottest;
      checks.push({ id: "steadyState", label: "Steady state reached (bound on what is still to change)", value: bound, unit: "K", verdict: bound <= STEADY_TOLERANCE ? "pass" : "fail", note: `at most ${bound.toPrecision(3)} K is still to change after the last step (OFFBEAT's last relative rate ${rate}, hottest cell ${hottest.toFixed(1)} K); threshold ${STEADY_TOLERANCE} K` });
    }
  }

  // the two-scale step on the fuelled zone's cells, against the wedge sphere's closed form (the radii asked for are the case's, so they are scaled to the wedge's)
  const fuelledCells = cells.filter((c) => c.region === "fuelled");
  const spec = { ...p.compact, twoScale: p.compact.twoScale.map((x) => (typeof x === "number" ? x * TRISO_WEDGE_SCALE : x)) };
  const compact = buildCompactRecord(spec, fuelledCells.map((c) => ({ r: c.r, T: c.T })), (r) => closed.temperatureAt(r), { inner: 0, outer: eq.fuelledRadius }, SPHERE);
  checks.push(...compact.checks);
  for (const ch of checks) if (ch.value !== null && !Number.isFinite(ch.value)) bad(`check ${ch.id} is not a finite number (${ch.value}); the cell geometry is inconsistent`);

  // the record: the centre from the fuelled zone's parabola, the interface from the two cells beside it
  const byRegion = names.map((nm) => cells.filter((c) => c.region === nm));
  const first = byRegion[0]![0]!;
  const centre = solveHot(laws[0]!, first.T, (eq.power.powerDensity * first.r ** 2) / 6);
  const a = byRegion[0]![byRegion[0]!.length - 1]!;
  const b = byRegion[1]![0]!;
  const gA = 1 / SPHERE.resist(a.r, bounds[1]!, evaluate(laws[0]!, a.T));
  const gB = 1 / SPHERE.resist(bounds[1]!, b.r, evaluate(laws[1]!, b.T));
  const interfaceT = (gA * a.T + gB * b.T) / (gA + gB);
  const faces: [number, number][] = [[centre, interfaceT], [interfaceT, wall]];
  const regions: PebbleRegionResult[] = names.map((nm, ri) => {
    const ts = byRegion[ri]!.map((c) => c.T);
    return { name: nm, innerRadius: bounds[ri]!, outerRadius: bounds[ri + 1]!, innerFaceT: faces[ri]![0], outerFaceT: faces[ri]![1], hottestCellT: Math.max(...ts), coldestCellT: Math.min(...ts), drop: faces[ri]![0] - faces[ri]![1] };
  });
  return {
    schema: "feed.results/0.1",
    kind: "pebble",
    caseId: p.caseId,
    time: input.time,
    cells,
    regions,
    summary: { centreT: centre, centreCellT: first.T, interfaceT, wallT: wall, maxT: Math.max(...T), minT: Math.min(...T) },
    checks,
    domain: { verdict: findings.length === 0 ? "in-domain" : "out-of-domain", findings },
    compact,
    thermalOnly: PEBBLE_THERMAL_ONLY_TEXT,
  };
}

export const isPebbleResults = (r: unknown): r is PebbleResultsRecord => !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "pebble";
