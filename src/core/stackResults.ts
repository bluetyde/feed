// The results of an axial stack (plan 12, A2): OFFBEAT's final fields for N layers per solid, read back layer by layer, each slice judged as the one-radial-slice pin it is
// (its own heat rate and coolant, FEED's closed form and energy balance) with the tolerance widened by the estimated axial conduction, which the solver includes and the
// one-dimensional closed forms do not (src/core/axial.ts, docs/spike/axial-plate-probe.md). Incomplete or inconsistent output is refused, never turned into a partial result.

import { AxialEstimate, axialConductionEstimate, axialSummary, sliceCase, sliceLoads } from "./axial";
import { BALANCE_TOLERANCE, Check, DomainFinding, ParseInput, RadialPoint, ResultsError, ResultsRecord, SliceAllowance, THERMAL_ONLY_TEXT, assertWholeFoamFile, finishResults, parsePatchValues, parseScalarField, parseVectorField, radialSplit } from "./resultsParser";
import { NormalizedCase } from "./validate";

const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};

/** The factor on the axial-conduction estimate that widens a tolerance: the estimate covered the measured effect within a factor 2 (tests/axialCase.test.ts), so 3 is a margin over it. */
export const AXIAL_TOLERANCE_FACTOR = 3;

export const STACK_TEXT = "One radial solution per axial slice, with the heat flow along the pin that the solver includes. The checks compare each slice with its own one-dimensional closed form within a bound that includes an estimate of that heat flow.";

/** The same statement for a stack of plates (plan 12, A5): a slice is a slab through its thickness, the heat flows along the height. */
export const STACK_TEXT_PLATE = "One through-thickness solution per axial slice of the plate, with the heat flow along the height that the solver includes. The checks compare each slice with its own one-dimensional slab closed form within a bound that includes an estimate of that heat flow.";
export const stackText = (c: NormalizedCase): string => (c.plate ? STACK_TEXT_PLATE : STACK_TEXT);

export interface SliceResult {
  index: number;
  /** Height of the slice's centre above the bottom of the heated length (m). */
  height: number;
  linearHeatRate: number;
  boundary: NormalizedCase["boundary"];
  centreCellT: number;
  fuelSurfaceCellT: number;
  claddingInnerCellT: number;
  /** The temperature of the slice's outer face (K), from the boundary patch. */
  claddingOuterWallT: number | null;
  maxT: number;
  radial: RadialPoint[];
}

export interface StackRecord extends ResultsRecord {
  axial: {
    length: number;
    slices: SliceResult[];
    /** The slice with the hottest fuel cell. `summary` and `radial` of the record are that slice's. */
    hottest: number;
    averageLinearHeatRate: number;
    /** The sum of the slices' heat rates over their number: what OFFBEAT deposits (it samples the shape at the slice centres), which can differ a little from the stated average. */
    sampledAverageLinearHeatRate: number;
    conduction: AxialEstimate | null;
    /** What was added to the tolerances of the per-slice checks for the axial conduction: K on a field, W/m on a flux, K on the wall. */
    allowance: SliceAllowance;
  };
}

/** Of the same check from every slice, the one to report: a failing one first, then the worst value (the smallest for a margin). */
export function worstOf(same: { check: Check; slice: number; height: number }[]): Check {
  const failing = same.filter((s) => s.check.verdict === "fail");
  const pool = failing.length ? failing : same;
  const isMargin = /^temperatureLimit/.test(same[0]!.check.id);
  let pick = pool[0]!;
  for (const s of pool) {
    const a = s.check.value;
    const b = pick.check.value;
    if (a === null || b === null) continue;
    if (isMargin ? a < b : Math.abs(a) > Math.abs(b)) pick = s;
  }
  const verdict = failing.length ? "fail" : same.every((s) => s.check.verdict === "na") ? "na" : same.some((s) => s.check.verdict === "pass") ? "pass" : "na";
  const where = `slice ${pick.slice + 1} of ${same.length} (height ${pick.height.toFixed(4)} m)`;
  return { ...pick.check, verdict, note: `${failing.length ? failing.length + " of " + same.length + " slices fail; the worst is" : "all " + same.length + " slices pass; the worst is"} ${where}: ${pick.check.note}` };
}

export function buildStackResults(c: NormalizedCase, input: ParseInput): StackRecord {
  const a = c.axial;
  if (!a) throw new Error("buildStackResults is for an axial stack");
  const N = a.slices;
  const nf = c.mesh.fuelCells;
  const nc = c.mesh.claddingCells;
  const T = parseScalarField(input.T, "T");
  const C = parseVectorField(input.C, "C");
  if (T.length !== N * (nf + nc)) bad(`expected ${N * (nf + nc)} cells (${N} slices x (${nf} fuel + ${nc} cladding)), found ${T.length}`);
  if (C.length !== T.length) bad(`T has ${T.length} cells but C has ${C.length}`);
  if (!(input.time > 0) || !Number.isFinite(input.time)) bad("final time is not a positive finite number");
  if (!/\bboundaryField\b/.test(input.T)) bad("field T has no boundaryField (the file is cut short)");
  const faces = parsePatchValues(input.T, "cladOuter");
  if (faces === null) bad("field T has no value for the cladOuter patch (the file is cut short or malformed)");
  const walls = faces!.length === N ? faces! : faces!.length === 1 ? new Array<number>(N).fill(faces![0]!) : bad(`the cladOuter patch has ${faces!.length} values for ${N} slices`);
  assertWholeFoamFile(input.T, "T");
  assertWholeFoamFile(input.C, "C");

  const loads = sliceLoads(c);
  const summary = axialSummary(c)!;
  const est = summary.conduction;
  const fraction = est?.fraction ?? 0;
  const ref = (b: NormalizedCase["boundary"]) => (b.kind === "convective" ? b.bulkTemperature : b.surfaceTemperature);
  const peakRise = Math.max(...summary.slices.map((s, i) => s.centreT - ref(loads[i]!.boundary)));
  const peakQ = Math.max(...loads.map((l) => l.linearHeatRate));
  const wallRise = Math.max(...summary.slices.map((s, i) => s.claddingOuterT - ref(loads[i]!.boundary)));
  const allow: SliceAllowance = { field: AXIAL_TOLERANCE_FACTOR * fraction * peakRise, flux: AXIAL_TOLERANCE_FACTOR * fraction * peakQ, wall: AXIAL_TOLERANCE_FACTOR * fraction * wallRise };

  const height = a.length / N;
  const eps = 1e-6 * a.length;
  const perSlice: { rec: ResultsRecord; load: (typeof loads)[number] }[] = [];
  for (let k = 0; k < N; k++) {
    const fi = Array.from({ length: nf }, (_, i) => k * nf + i);
    const ci = Array.from({ length: nc }, (_, i) => N * nf + k * nc + i);
    for (const i of [...fi, ...ci]) {
      const z = C[i]![2]!;
      if (!(z >= k * height - eps && z <= (k + 1) * height + eps)) bad(`cell ${i} has its centre at height ${z} m, outside the layer ${k + 1} of ${N} (${k * height} to ${(k + 1) * height} m): the cells are not in the order the writer's mesh gives`);
    }
    const Tk = [...fi, ...ci].map((i) => T[i]!);
    const Ck = [...fi, ...ci].map((i) => C[i]!);
    const sc = sliceCase(c, loads[k]!);
    const { radial, fuel, clad } = radialSplit(sc, Tk, Ck);
    perSlice.push({ rec: finishResults(sc, { T: Tk, radial, fuel, clad, wall: walls[k]!, input: { ...input, T: input.T, C: input.C }, allow }), load: loads[k]! });
  }

  // the checks of the slices, one line each in the result: a failing one, or the worst
  const ids: string[] = [];
  for (const s of perSlice) for (const ch of s.rec.checks) if (!ids.includes(ch.id)) ids.push(ch.id);
  const checks: Check[] = ids.map((id) => worstOf(perSlice.flatMap((s, k) => s.rec.checks.filter((ch) => ch.id === id).map((check) => ({ check, slice: k, height: s.load.height })))));

  // the heat balance of the whole pin: what the cladding walls carry away, summed, against what the slices were given (the ends are closed, so it is conserved exactly)
  const sumQ = perSlice.reduce((x, s) => x + s.load.linearHeatRate, 0);
  const balances = perSlice.map((s) => s.rec.checks.find((ch) => ch.id === "energyBalance")?.value);
  if (balances.every((v) => typeof v === "number")) {
    const out = perSlice.reduce((x, s, k) => x + s.load.linearHeatRate * (1 + (balances[k] as number)), 0);
    const rel = (out - sumQ) / sumQ;
    checks.push({
      id: "energyBalanceTotal",
      label: "Energy balance of the whole pin (heat leaving through all slices vs the heat given)",
      value: rel,
      unit: "relative",
      verdict: Math.abs(rel) <= BALANCE_TOLERANCE ? "pass" : "fail",
      note: `the cladding fluxes of the ${N} slices sum to ${(out / N).toFixed(1)} W/m on average against ${(sumQ / N).toFixed(1)} W/m given (the shape sampled at the slice centres; the stated average is ${c.qPrime} W/m); threshold ${BALANCE_TOLERANCE * 100}%. The end faces carry no heat, so the whole pin's balance does not depend on the axial conduction`,
    });
  }
  checks.push({
    id: "axialConduction",
    label: "Axial heat flow allowed for in the per-slice tolerances",
    value: fraction,
    unit: "relative",
    verdict: "na",
    note: est ? `estimated at ${(fraction * 100).toPrecision(3)} % of the largest rise (src/core/axial.ts, calibrated on the real-solver measurements of docs/spike/axial-plate-probe.md); the per-slice tolerances are widened by ${AXIAL_TOLERANCE_FACTOR} times it: ${allow.field.toPrecision(3)} K on a field, ${allow.flux.toPrecision(3)} W/m on a flux, ${allow.wall.toPrecision(3)} K on the wall` : "no estimate could be made; the per-slice tolerances are the one-dimensional ones",
  });
  for (const ch of checks) if (ch.value !== null && !Number.isFinite(ch.value)) bad(`check ${ch.id} is not a finite number (${ch.value}); the cell geometry is inconsistent`);

  const slices: SliceResult[] = perSlice.map((s) => ({
    index: s.load.index,
    height: s.load.height,
    linearHeatRate: s.load.linearHeatRate,
    boundary: s.load.boundary,
    centreCellT: s.rec.summary.centreCellT,
    fuelSurfaceCellT: s.rec.summary.fuelSurfaceCellT,
    claddingInnerCellT: s.rec.summary.claddingInnerCellT,
    claddingOuterWallT: s.rec.summary.claddingOuterWallT,
    maxT: s.rec.summary.maxT,
    radial: s.rec.radial,
  }));
  let hottest = 0;
  slices.forEach((s, i) => {
    if (s.maxT > slices[hottest]!.maxT) hottest = i;
  });
  const hot = perSlice[hottest]!.rec;
  const findings: DomainFinding[] = perSlice.flatMap((s) => s.rec.domain.findings);
  return {
    ...hot,
    time: input.time,
    caseId: c.caseId,
    summary: { ...hot.summary, maxT: Math.max(...slices.map((s) => s.maxT)), minT: Math.min(...perSlice.map((s) => s.rec.summary.minT)) },
    checks,
    domain: { verdict: findings.length ? "out-of-domain" : "in-domain", findings },
    thermalOnly: THERMAL_ONLY_TEXT + " " + stackText(c),
    axial: { length: a.length, slices, hottest, averageLinearHeatRate: c.qPrime, sampledAverageLinearHeatRate: sumQ / N, conduction: est, allowance: allow },
  };
}
