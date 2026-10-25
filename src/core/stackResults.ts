// The results of an axial stack (plan 12, A2): OFFBEAT's final fields for N layers per solid, read back layer by layer, each slice judged as the one-radial-slice pin it is
// (its own heat rate and coolant, FEED's closed form and energy balance) with the tolerance widened by the estimated axial conduction, which the solver includes and the
// one-dimensional closed forms do not (src/core/axial.ts, docs/spike/axial-plate-probe.md). Incomplete or inconsistent output is refused, never turned into a partial result.

import { AxialEstimate, axialConductionEstimate, axialSummary, sliceCase, sliceLoads } from "./axial";
import { BALANCE_TOLERANCE, Check, DomainFinding, ParseInput, RadialPoint, ResultsError, ResultsRecord, SliceAllowance, SliceReference, THERMAL_ONLY_TEXT, assertWholeFoamFile, finishResults, sliceClosedForm, parsePatchValues, parseScalarField, parseVectorField, radialSplit, wallFlux } from "./resultsParser";
import { StackReferenceResult, pinReferenceDecision, stackReference } from "./stackReference";
import { NormalizedCase } from "./validate";

const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};

/** The factor on the axial-conduction estimate that widens a tolerance: the estimate covered the measured effect within a factor 2 (tests/axialCase.test.ts), so 3 is a margin over it. */
export const AXIAL_TOLERANCE_FACTOR = 3;

export const STACK_TEXT = "One radial solution per axial slice, with the heat flow along the pin that the solver includes. The checks compare each slice with its own one-dimensional closed form within a bound that includes an estimate of that heat flow.";

/** The same statement for a stack of plates (plan 12, A5): a slice is a slab through its thickness, the heat flows along the height. */
export const STACK_TEXT_PLATE = "One through-thickness solution per axial slice of the plate, with the heat flow along the height that the solver includes. The checks compare each slice with its own one-dimensional slab closed form within a bound that includes an estimate of that heat flow.";
/** The statement for a stack of plates judged against the two-dimensional reference (plan 15): the heat flow along the height is in the reference, not in a widened bound. */
export const STACK_TEXT_PLATE_2D = "One through-thickness solution per axial slice of the plate, with the heat flow along the height that the solver includes. The checks compare the cells with FEED's own two-dimensional finite-volume solution of the whole stack on the same mesh, which includes that heat flow, within the mesh bound and with no allowance for it. The reference is a second method on the same discretisation, not a measurement.";
/** The statement for a stack of PINS judged with the heat flow along the height added (plan 19 D1): used only where that flow is larger than the pin's radial mesh bound (src/core/stackReference.ts, pinReferenceDecision). */
export const STACK_TEXT_2D = "One radial solution per axial slice of the pin, with the heat flow along the pin that the solver includes. The checks compare each slice with its own one-dimensional closed form plus the effect of that heat flow, taken from FEED's own two-dimensional finite-volume solution of the whole stack (the stack solved with and without conduction between the layers: only the difference is added, so the two-dimensional scheme's own radial offset from the solver's cells does not enter), within the radial mesh bound and with no allowance. A pin is judged this way when the heat flow along the height is larger than that bound, as in a short pin; a long pin keeps the widened bound. FEED's second method on the writer's mesh, not a measurement of the pin. A thermal-only result never implies stress, failure or fuel integrity.";
export const stackText = (c: NormalizedCase, twoDimensional = false): string => (c.plate ? (twoDimensional ? STACK_TEXT_PLATE_2D : STACK_TEXT_PLATE) : twoDimensional ? STACK_TEXT_2D : STACK_TEXT);

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
    /** The allowance the one-dimensional reference needs for the axial conduction (3 times the fin-model estimate): K on a field, W/m on a flux, K on the wall. It is added to the tolerances of the per-slice checks only where `reference.kind` is "allowance"; with the two-dimensional reference it is information. */
    allowance: SliceAllowance;
    /** What the per-slice checks compare with (plan 15). Present for a stack of plates; a pin's record is as it was before plan 15. */
    reference?: StackReferenceInfo;
  };
}

export type StackReferenceInfo =
  | {
      kind: "two-dimensional";
      /** The largest difference between the stack's two-dimensional solution and the same solution with no conduction along the height (K): the effect of that heat flow in the cells. */
      axialEffect: number;
      /** The largest difference between OFFBEAT's cells and the decoupled (one-dimensional) solutions (K): what the one-dimensional reference misses, for contrast. */
      oneDimensionalDeviation: number;
      /** The largest difference between OFFBEAT's cells and the two-dimensional solution (K). */
      deviation: number;
    }
  | { kind: "allowance"; reason: string };

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

/**
 * `reference`: left out, a stack of plates is judged against its two-dimensional reference (plan 15) and a pin against its one-dimensional closed forms with the allowance; a
 * reference result that is given is used as it is; null forces the allowance (the fallback, and the one-dimensional contrast).
 */
export function buildStackResults(c: NormalizedCase, input: ParseInput, reference?: StackReferenceResult | null): StackRecord {
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
  const coolantRef = (b: NormalizedCase["boundary"]) => (b.kind === "convective" ? b.bulkTemperature : b.surfaceTemperature);
  const peakRise = Math.max(...summary.slices.map((s, i) => s.centreT - coolantRef(loads[i]!.boundary)));
  const peakQ = Math.max(...loads.map((l) => l.linearHeatRate));
  const wallRise = Math.max(...summary.slices.map((s, i) => s.claddingOuterT - coolantRef(loads[i]!.boundary)));
  const estimate: SliceAllowance = { field: AXIAL_TOLERANCE_FACTOR * fraction * peakRise, flux: AXIAL_TOLERANCE_FACTOR * fraction * peakQ, wall: AXIAL_TOLERANCE_FACTOR * fraction * wallRise };
  const choice = reference === undefined ? (c.plate || pinReferenceDecision(c).use ? stackReference(c) : null) : reference;
  let ref = choice && "reference" in choice ? choice.reference : undefined;
  // a pin is judged with the heat along the height added to its closed form: the stack's two-dimensional solution minus the same solution with no conduction between the layers (plan 19 D1);
  // without that second solution the pin keeps the allowance
  const decoupled = ref ? stackReference(c, { axialConduction: false }) : undefined;
  if (!c.plate && !(decoupled && "reference" in decoupled)) ref = undefined;
  const fallbackReason = ref ? "" : choice && "fallback" in choice ? choice.fallback : c.plate ? "the allowance was asked for" : "a pin keeps the allowance (the heat along the height does not exceed its radial mesh bound)";
  // judged against the two-dimensional reference there is no allowance on any tolerance
  const allow: SliceAllowance = ref ? { field: 0, flux: 0, wall: 0 } : estimate;

  const height = a.length / N;
  const eps = 1e-6 * a.length;
  const perSlice: { rec: ResultsRecord; load: (typeof loads)[number]; flux: number | null }[] = [];
  let deviation = 0;
  let oneDimensionalDeviation = 0;
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
    let sliceRef: SliceReference | undefined;
    if (ref && !c.plate) {
      // a pin: the closed form at the cell's own radius plus the effect of the heat along the height at that cell; the two-dimensional scheme's cell-middle nodes sit elsewhere than the solver's
      // cell centres (3 to 4 K in a pin, plan 15), and the difference of the two solutions cancels that
      const at = [...fuel, ...clad];
      const two = ref.slice(k);
      const one = (decoupled as { reference: { slice(k: number): SliceReference } }).reference.slice(k);
      const cf = sliceClosedForm(sc);
      sliceRef = { fuel: fuel.map((p, i) => cf.fuelAt(p.r) + two.fuel[i]! - one.fuel[i]!), clad: clad.map((p, i) => cf.claddingAt(p.r) + two.clad[i]! - one.clad[i]!), wall: cf.tOuter + two.wall - one.wall };
      at.forEach((p, i) => {
        deviation = Math.max(deviation, Math.abs(p.T - (i < nf ? sliceRef!.fuel[i]! : sliceRef!.clad[i - nf]!)));
        oneDimensionalDeviation = Math.max(oneDimensionalDeviation, Math.abs(p.T - (i < nf ? cf.fuelAt(p.r) : cf.claddingAt(p.r))));
      });
    } else if (ref) {
      // the reference's cells are at the writer's cell centres: a cell that is not there is a different mesh, not a deviation
      const at = [...fuel, ...clad];
      sliceRef = ref.slice(k);
      at.forEach((p, i) => {
        const dx = i < nf ? (c.fuelRadius - c.fuelInnerRadius) / nf : (c.claddingOuterRadius - c.claddingInnerRadius) / nc;
        if (!(Math.abs(p.r - ref.solution.r[i]!) <= 1e-3 * dx + 1e-9)) bad(`cell ${i} of layer ${k + 1} is at r = ${p.r} m but the writer's mesh puts it at ${ref.solution.r[i]} m: the reference cannot be compared cell by cell`);
        deviation = Math.max(deviation, Math.abs(p.T - (i < nf ? sliceRef!.fuel[i]! : sliceRef!.clad[i - nf]!)));
      });
      if (decoupled && "reference" in decoupled) {
        const one = decoupled.reference.slice(k);
        at.forEach((p, i) => (oneDimensionalDeviation = Math.max(oneDimensionalDeviation, Math.abs(p.T - (i < nf ? one.fuel[i]! : one.clad[i - nf]!)))));
      }
    }
    perSlice.push({ rec: finishResults(sc, { T: Tk, radial, fuel, clad, wall: walls[k]!, input: { ...input, T: input.T, C: input.C }, allow, ...(sliceRef ? { reference: sliceRef } : {}) }), load: loads[k]!, flux: wallFlux(sc, clad) });
  }

  // the checks of the slices, one line each in the result: a failing one, or the worst
  const ids: string[] = [];
  for (const s of perSlice) for (const ch of s.rec.checks) if (!ids.includes(ch.id)) ids.push(ch.id);
  const checks: Check[] = ids.map((id) => worstOf(perSlice.flatMap((s, k) => s.rec.checks.filter((ch) => ch.id === id).map((check) => ({ check, slice: k, height: s.load.height })))));

  // the heat balance of the whole pin: what the cladding walls carry away, summed, against what the slices were given (the ends are closed, so it is conserved exactly)
  const sumQ = perSlice.reduce((x, s) => x + s.load.linearHeatRate, 0);
  const balances = perSlice.map((s) => s.rec.checks.find((ch) => ch.id === "energyBalance")?.value);
  // against the reference the slices' balance values are relative to the reference's flux, so the total is taken from the fluxes themselves
  if (ref ? perSlice.every((s) => s.flux !== null) : balances.every((v) => typeof v === "number")) {
    const out = ref ? perSlice.reduce((x, s) => x + s.flux!, 0) : perSlice.reduce((x, s, k) => x + s.load.linearHeatRate * (1 + (balances[k] as number)), 0);
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
  let axialEffect = 0;
  if (ref && decoupled && "reference" in decoupled) axialEffect = Math.max(...Array.from(ref.solution.T, (x, i) => Math.abs(x - decoupled.reference.solution.T[i]!)));
  if (ref) {
    checks.push({
      id: "axialConduction",
      label: "Axial heat flow (in the two-dimensional reference, no allowance)",
      value: fraction,
      unit: "relative",
      verdict: "na",
      note: `information only: the heat flow along the height is in the reference. It changes the cells by up to ${axialEffect.toPrecision(3)} K (the stack's solution against the same solution with no conduction between layers); the one-dimensional solutions of the slices differ from the solver's cells by up to ${oneDimensionalDeviation.toPrecision(3)} K, the two-dimensional one by up to ${deviation.toPrecision(3)} K. The fin-model estimate (src/core/axial.ts) is ${est ? (fraction * 100).toPrecision(3) + " % of the largest rise, which would widen the tolerances by " + estimate.field.toPrecision(3) + " K on a field, " + estimate.flux.toPrecision(3) + " W/m on a flux and " + estimate.wall.toPrecision(3) + " K on the wall" : "not available"}; it is the fallback where the reference cannot be computed`,
    });
  } else checks.push({
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
    thermalOnly: THERMAL_ONLY_TEXT + " " + stackText(c, ref !== undefined),
    axial: {
      length: a.length,
      slices,
      hottest,
      averageLinearHeatRate: c.qPrime,
      sampledAverageLinearHeatRate: sumQ / N,
      conduction: est,
      allowance: estimate,
      ...(c.plate || ref ? { reference: ref ? ({ kind: "two-dimensional", axialEffect, oneDimensionalDeviation, deviation } as StackReferenceInfo) : ({ kind: "allowance", reason: fallbackReason } as StackReferenceInfo) } : {}),
    },
  };
}
