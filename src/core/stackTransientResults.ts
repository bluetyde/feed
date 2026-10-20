// The results of a transient axial stack (plan 12, A3): OFFBEAT's temperature fields at every write time for N layers per solid, cut into slices and judged slice by slice with the
// transient checks of plan 08 (cross-check against the independent finite-volume solution, energy balance, time step, property ranges, limits), each slice with its own power history
// (the case's average history times its factor) and its own coolant. The tolerances are widened by the estimated axial conduction exactly as for the steady stack (stackResults.ts).
// A slice is handed to the one-slice builder as the text of its own fields, so the one-slice code is the same code and is not changed for the stack.

import { axialExchange, axialSummary, sliceCase, sliceLoads, SliceLoad } from "./axial";
import { Check, DomainFinding, ResultsError, THERMAL_ONLY_TEXT, parsePatchValues, parseScalarField, parseVectorField } from "./resultsParser";
import { AXIAL_TOLERANCE_FACTOR, stackText, worstOf } from "./stackResults";
import { StackTransientReferenceResult, stackTransientReference } from "./stackReference";
import { IndependentSet, TransientInput, TransientResultsRecord, TransientAllowance, buildTransientResults, computeIndependent, ENERGY_BALANCE_TOLERANCE } from "./transientResults";
import { NormalizedCase } from "./validate";

const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};

/** The independent solutions of every slice (each is the three runs of a one-slice transient), for the run manager's worker. */
export function computeIndependentStack(c: NormalizedCase): IndependentSet[] {
  return sliceLoads(c).map((l) => computeIndependent(sliceCase(c, l)));
}

/**
 * The factor on the transient exchange bound (below). The bound leaves out the damping by the coolant, but it takes the hottest cell of each slice for the slice's temperature and
 * the one-dimensional solutions for the neighbours', and on the real solver it was 1.1 to 1.6 times the measured change in the runs where it applies (the loss of cooling of a
 * plate, 60 and 200 s, and a short one), so 2 is a margin over that, as 3 is over the steady estimate.
 */
export const AXIAL_EXCHANGE_FACTOR = 2;
/** The product of the exchange rate and the run time above which the first-order bound no longer holds: measured, 0.9 held and 1.5 did not (docs/axial-stack.md). */
export const AXIAL_EXCHANGE_NUMBER_LIMIT = 1;

/**
 * What the heat exchanged along the height can add to a slice's temperature and to its energy balance over the whole run (axialExchange in axial.ts): the rate kA / (C h^2) times the
 * integral of the absolute second difference of the slices' independent peak temperatures (an end slice has a neighbour on one side only), as kelvin and as a fraction of the energy
 * the slice is given. It is a first-order bound for a run whose slices stay near the one-dimensional solutions: the steady estimate does not cover a transient in which the
 * coolant cannot carry the heat away (a loss of cooling), where the axial path is the only one left.
 */
export function exchangeAllowances(c: NormalizedCase, solutions: IndependentSet[], loads: SliceLoad[]): { field: number[]; energy: number[]; number: number } | undefined {
  const a = c.axial;
  const t = c.transient;
  if (!a || !t) return undefined;
  const traces = solutions.map((s) => s.fv.trace);
  if (traces.some((x) => x === undefined)) return undefined;
  const fuel: [number, number] = [Math.min(...traces.map((x) => x!.fuelMin)), Math.max(...traces.map((x) => x!.fuelMax))];
  const cladding: [number, number] = [Math.min(...traces.map((x) => x!.claddingMin)), Math.max(...traces.map((x) => x!.claddingMax))];
  const ex = axialExchange(c, fuel, cladding);
  if (!ex) return undefined;
  const dt = t.timeStep;
  const field: number[] = [];
  const energy: number[] = [];
  for (let k = 0; k < a.slices; k++) {
    const p = traces[k]!.peakByStep;
    const below = traces[k > 0 ? k - 1 : k]!.peakByStep;
    const above = traces[k < a.slices - 1 ? k + 1 : k]!.peakByStep;
    let integral = 0;
    for (let j = 0; j < p.length; j++) integral += (j === 0 || j === p.length - 1 ? 0.5 : 1) * Math.abs(below[j]! - 2 * p[j]! + above[j]!) * dt;
    // the energy the slice is given over the run (J per unit height): its factor times the trapezoid of the average history
    let given = 0;
    for (let j = 1; j < t.times.length; j++) given += 0.5 * (t.linearHeatRate[j]! + t.linearHeatRate[j - 1]!) * (t.times[j]! - t.times[j - 1]!);
    given *= loads[k]!.factor;
    field.push(AXIAL_EXCHANGE_FACTOR * ex.rate * integral);
    energy.push(given > 0 ? (AXIAL_EXCHANGE_FACTOR * ex.kA * integral) / (a.length / a.slices) ** 2 / given : 0);
  }
  return { field, energy, number: ex.rate * t.endTime };
}

const FOOTER = "// ************************************************************************* //";
const foamScalar = (values: number[], wall: number) => `FoamFile\n{\n    class volScalarField;\n    object T;\n}\ninternalField   nonuniform List<scalar>\n${values.length}\n(\n${values.map(String).join("\n")}\n)\n;\n\nboundaryField\n{\n    cladOuter\n    {\n        type            fixedValue;\n        value           uniform ${wall};\n    }\n}\n\n${FOOTER}\n`;
const foamVector = (values: number[][]) => `FoamFile\n{\n    class volVectorField;\n    object C;\n}\ninternalField   nonuniform List<vector>\n${values.length}\n(\n${values.map((v) => `(${v.join(" ")})`).join("\n")}\n)\n;\n\n${FOOTER}\n`;

export interface StackSliceSeries {
  index: number;
  height: number;
  /** The slice's factor on the case's average power history. */
  factor: number;
  power: number[];
  peakT: number[];
  claddingOuterWallT: number[];
  maxT: number;
  timeOfMaxT: number;
}

export interface StackTransientRecord extends TransientResultsRecord {
  axial: {
    length: number;
    slices: StackSliceSeries[];
    /** The slice with the hottest peak over the run: the record's own series, profiles, summary and cells are that slice's. */
    hottest: number;
    conduction: { fraction: number } | null;
    /** What was added to each slice's tolerances: kelvin on the cross-check, and on the energy balance a fraction of the slice's own energy (this is for the slice of the largest factor; the others scale with the ratio of the largest factor to their own). */
    allowance: { field: number; energy: number; exchangeField?: number; exchangeEnergy?: number; exchangeNumber?: number; exchangeCounted?: boolean };
    /** What the per-slice checks compare with (plan 15, B3). Present for a stack of plates; a pin's record is as it was before plan 15. With the two-dimensional reference the `allowance` above is information, and was not added to any tolerance. */
    reference?: StackTransientReferenceInfo;
  };
}

export type StackTransientReferenceInfo =
  | {
      kind: "two-dimensional";
      /** The largest difference between OFFBEAT's cells and the reference at any output (K), and between OFFBEAT's cells and the one-dimensional solutions of the slices (K), for contrast. */
      deviation: number;
      oneDimensionalDeviation: number;
      /** The largest difference between the run's start (every slice at its own steady state) and the stack's coupled steady state (K); null for a uniform start. */
      startDistance: number | null;
      /** Why startDistance is null for a steady start; absent for a uniform start. */
      startDistanceReason?: string;
    }
  | { kind: "allowance"; reason: string };

/**
 * `reference`: left out, a stack of plates is judged against its two-dimensional reference (plan 15, B3) and a pin against the one-dimensional solutions with the allowance and the
 * exchange bound; a reference result that is given is used as it is; null forces the allowance.
 */
export function buildStackTransientResults(c: NormalizedCase, input: TransientInput, sets?: IndependentSet[], reference?: StackTransientReferenceResult | null): StackTransientRecord {
  const a = c.axial;
  const t = c.transient;
  if (!a || !t) throw new Error("buildStackTransientResults is for an axial stack with a transient");
  const N = a.slices;
  const nf = c.mesh.fuelCells;
  const nc = c.mesh.claddingCells;
  const total = N * (nf + nc);
  if (sets && sets.length !== N) bad(`the independent solutions are for ${sets.length} slices, the case has ${N}`);
  const C = parseVectorField(input.C, "C");
  if (C.length !== total) bad(`C has ${C.length} cells, expected ${total} (${N} slices x (${nf} fuel + ${nc} cladding))`);
  const loads = sliceLoads(c);
  const height = a.length / N;
  const eps = 1e-6 * a.length;
  const fi = (k: number) => Array.from({ length: nf }, (_, i) => k * nf + i);
  const ci = (k: number) => Array.from({ length: nc }, (_, i) => N * nf + k * nc + i);
  for (let k = 0; k < N; k++) {
    for (const i of [...fi(k), ...ci(k)]) {
      const z = C[i]![2]!;
      if (!(z >= k * height - eps && z <= (k + 1) * height + eps)) bad(`cell ${i} has its centre at height ${z} m, outside the layer ${k + 1} of ${N} (${k * height} to ${(k + 1) * height} m): the cells are not in the order the writer's mesh gives`);
    }
  }
  // the fields at every write time, one slice at a time
  const perSliceFields: { time: number; T: string }[][] = Array.from({ length: N }, () => []);
  for (const f of input.fields) {
    const T = parseScalarField(f.T, "T");
    if (T.length !== total) bad(`time ${f.time}: expected ${total} cells, found ${T.length}`);
    if (!/\bboundaryField\b/.test(f.T)) bad(`time ${f.time}: field T has no boundaryField (the file is cut short)`);
    const faces = parsePatchValues(f.T, "cladOuter");
    if (faces === null) bad(`time ${f.time}: field T has no value for the cladOuter patch`);
    const walls = faces!.length === N ? faces! : faces!.length === 1 ? new Array<number>(N).fill(faces![0]!) : bad(`time ${f.time}: the cladOuter patch has ${faces!.length} values for ${N} slices`);
    for (let k = 0; k < N; k++) perSliceFields[k]!.push({ time: f.time, T: foamScalar([...fi(k), ...ci(k)].map((i) => T[i]!), walls[k]!) });
  }
  const summary = axialSummary(c)!;
  const fraction = summary.conduction?.fraction ?? 0;
  const maxFactor = Math.max(...loads.map((l) => l.factor));
  // The axial conduction is an effect of the whole pin: it is a fraction of the LARGEST rise of any slice (as for the steady stack), not of the slice's own, which is small at an end.
  // The rise of a slice is the independent solution's peak over the whole run above its coolant (a steady start's peak and a pulse's included); the steady-state estimate of the
  // fraction is used. A stack that starts from a steady state starts every slice at its own one-dimensional steady state and the solver's coupled state differs from it by the
  // axial conduction, so the run relaxes toward it: that is part of what the allowance covers (measured, docs/axial-stack.md).
  const widen = AXIAL_TOLERANCE_FACTOR * fraction;
  const solutions = sets ?? computeIndependentStack(c);
  const refOf = (b: NormalizedCase["boundary"]) => (b.kind === "convective" ? b.bulkTemperature : b.surfaceTemperature);
  const largestRise = Math.max(...solutions.map((s, k) => Math.max(...s.fv.trace!.peakByStep) - refOf(loads[k]!.boundary)));
  const field = widen * Math.max(largestRise, 1);

  // the heat exchanged along the height during the run, from the independent solutions; each slice takes the larger of this and the steady estimate's allowance
  // (only where the first-order bound holds: beyond the exchange number limit it is not counted, so a run that long keeps exactly the allowance the steady estimate gives)
  const exchange = exchangeAllowances(c, solutions, loads);
  const counted = exchange !== undefined && exchange.number <= AXIAL_EXCHANGE_NUMBER_LIMIT ? exchange : undefined;
  // plan 15, B3: a stack of plates is judged against the two-dimensional solution of the whole stack; the allowance and the exchange bound above are then information only
  const choice = reference === undefined ? (c.plate ? stackTransientReference(c) : null) : reference;
  const ref = choice && "reference" in choice ? choice.reference : undefined;
  const fallbackReason = ref ? "" : choice && "fallback" in choice ? choice.fallback : c.plate ? "the allowance was asked for" : "a pin keeps the allowance (plan 15: plates first)";
  const recs: TransientResultsRecord[] = [];
  for (let k = 0; k < N; k++) {
    const sc = sliceCase(c, loads[k]!);
    const steadyEnergy = loads[k]!.factor > 0 ? (AXIAL_TOLERANCE_FACTOR * fraction * maxFactor) / loads[k]!.factor : 0;
    const allow: TransientAllowance = ref ? { field: 0, energy: 0 } : { field: Math.max(field, counted?.field[k] ?? 0), energy: Math.max(steadyEnergy, counted?.energy[k] ?? 0) };
    const Ck = foamVector([...fi(k), ...ci(k)].map((i) => C[i]!));
    recs.push(ref ? buildTransientResults(sc, { C: Ck, fields: perSliceFields[k]! }, ref.sliceIndependent(k, solutions[k]!), allow, ref.received(k)) : buildTransientResults(sc, { C: Ck, fields: perSliceFields[k]! }, solutions[k], allow));
  }
  // for contrast and for the record: how far OFFBEAT's cells are from the reference and from the one-dimensional solutions, at every output
  let deviation = 0;
  let oneDimensionalDeviation = 0;
  if (ref)
    recs.forEach((r, k) => {
      const own = solutions[k]!.fv;
      const two = ref.sliceIndependent(k, solutions[k]!).fv;
      r.profiles.forEach((p, j) =>
        p.forEach((x, i) => {
          deviation = Math.max(deviation, Math.abs(x - two.states[j]!.T[i]!));
          oneDimensionalDeviation = Math.max(oneDimensionalDeviation, Math.abs(x - own.states[j]!.T[i]!));
        }),
      );
    });

  const ids: string[] = [];
  for (const r of recs) for (const ch of r.checks) if (!ids.includes(ch.id)) ids.push(ch.id);
  const checks: Check[] = ids.map((id) => worstOf(recs.flatMap((r, k) => r.checks.filter((ch) => ch.id === id).map((check) => ({ check, slice: k, height: loads[k]!.height })))));

  // the heat of the whole pin: the slices' deposited, stored and rejected energies summed; the end faces are closed, so the axial conduction cancels in the sum
  const times = recs[0]!.times;
  const sum = (pick: (r: TransientResultsRecord) => number[]) => times.map((_, j) => recs.reduce((x, r) => x + pick(r)[j]!, 0));
  const dep = sum((r) => r.series.deposited);
  const sto = sum((r) => r.series.stored);
  const rej = sum((r) => r.series.rejected);
  const histOrSteady = t.boundaryHistory !== undefined || t.initial.kind === "steady";
  let worst = 0;
  times.forEach((_, j) => {
    const through = histOrSteady ? Math.max(...dep.map(Math.abs), ...rej.map(Math.abs), ...sto.map(Math.abs)) : dep[j]!;
    if (through > 0) worst = Math.max(worst, Math.abs(dep[j]! - sto[j]! - rej[j]!) / through);
  });
  checks.push({
    id: "energyBalanceTotal",
    label: "Energy balance of the whole pin (deposited = stored + rejected, summed over the slices)",
    value: worst,
    unit: "relative",
    verdict: worst <= ENERGY_BALANCE_TOLERANCE ? "pass" : "fail",
    note: `the slices' energies summed; threshold ${ENERGY_BALANCE_TOLERANCE * 100}% of the ${histOrSteady ? "largest energy exchanged anywhere in the run" : "energy deposited so far"}. The end faces carry no heat, so the heat flow along the pin cancels in the sum and no allowance for it is made here`,
  });
  if (ref) {
    checks.push({
      id: "axialConduction",
      label: "Axial heat flow (in the two-dimensional reference, no allowance)",
      value: fraction,
      unit: "relative",
      verdict: "na",
      note: `information only: the heat flow along the height is in the reference, which is FEED's own two-dimensional finite-volume solution of the whole stack on the writer's mesh with the run's step, powers and coolants, started from the field the run was given. OFFBEAT's cells differ from it by up to ${deviation.toPrecision(3)} K at any output; from the one-dimensional solutions of the slices by up to ${oneDimensionalDeviation.toPrecision(3)} K. ${ref.startDistance !== null ? `The run starts from each slice's own steady state, ${ref.startDistance.toPrecision(3)} K from the stack's coupled steady state, and relaxes toward it; the reference starts from the same field. ` : ""}Without the reference the per-slice cross-check would be widened by ${field.toPrecision(3)} K (the steady estimate, ${(fraction * 100).toPrecision(3)} % of the largest rise${exchange ? `; the exchange bound up to ${Math.max(...exchange.field).toPrecision(3)} K, exchange number ${exchange.number.toPrecision(3)}${counted ? "" : ", above the limit where the bound held"}` : ""}); that allowance is the fallback where the reference cannot be computed. The spatial and time-stepping error estimates in each slice's bound are those of its own one-dimensional runs.`,
    });
  } else checks.push({
    id: "axialConduction",
    label: "Axial heat flow allowed for in the per-slice tolerances",
    value: fraction,
    unit: "relative",
    verdict: "na",
    note: summary.conduction ? `the steady estimate is ${(fraction * 100).toPrecision(3)} % of the largest rise (src/core/axial.ts); the per-slice cross-check is widened by ${AXIAL_TOLERANCE_FACTOR} times it as a fraction of the largest rise of any slice (${field.toPrecision(3)} K), and the per-slice energy balance by ${AXIAL_TOLERANCE_FACTOR} times it as a fraction of the slice's own power (the end slices make little heat and take a larger share). A transient's axial flow is not larger than the steady one for the same shape, but it was measured on the real solver only in the tests of docs/axial-stack.md${exchange ? `. The heat the slices can exchange along the height during the run is bounded from the independent solutions (up to ${Math.max(...exchange.field).toPrecision(3)} K and ${(100 * Math.max(...exchange.energy)).toPrecision(3)} % of a slice's energy; the steady estimate does not bound a run in which the coolant cannot carry the heat away). The exchange number (rate x run time) is ${exchange.number.toPrecision(3)}${counted ? `, below ${AXIAL_EXCHANGE_NUMBER_LIMIT}, where the bound held on the real solver: each slice's allowance is the larger of the two` : `, ABOVE ${AXIAL_EXCHANGE_NUMBER_LIMIT}: the heat has time to spread over several slices, the first-order bound no longer holds (measured) and is NOT counted, the allowance is the steady estimate's alone, and the one-dimensional solutions are no longer a good reference for the slices next to the ends; a failing cross-check there says so rather than a fault of the solver`}` : ""}` : "no estimate could be made; the per-slice tolerances are the one-dimensional ones",
  });
  for (const ch of checks) if (ch.value !== null && !Number.isFinite(ch.value)) bad(`check ${ch.id} is not a finite number (${ch.value})`);

  let hottest = 0;
  recs.forEach((r, i) => {
    if (r.summary.maxT > recs[hottest]!.summary.maxT) hottest = i;
  });
  const slices: StackSliceSeries[] = recs.map((r, k) => ({ index: k, height: loads[k]!.height, factor: loads[k]!.factor, power: r.series.power, peakT: r.series.peakT, claddingOuterWallT: r.series.claddingOuterWallT, maxT: r.summary.maxT, timeOfMaxT: r.summary.timeOfMaxT }));
  const findings: DomainFinding[] = recs.flatMap((r) => r.domain.findings);
  const hot = recs[hottest]!;
  return {
    ...hot,
    caseId: c.caseId,
    checks,
    domain: { verdict: findings.length ? "out-of-domain" : "in-domain", findings },
    thermalOnly: THERMAL_ONLY_TEXT + " " + stackText(c, ref !== undefined),
    axial: {
      length: a.length,
      slices,
      hottest,
      conduction: summary.conduction ? { fraction } : null,
      allowance: { field, energy: widen, ...(exchange ? { exchangeField: Math.max(...exchange.field), exchangeEnergy: Math.max(...exchange.energy), exchangeNumber: exchange.number, exchangeCounted: counted !== undefined } : {}) },
      ...(c.plate ? { reference: ref ? ({ kind: "two-dimensional", deviation, oneDimensionalDeviation, startDistance: ref.startDistance, ...(ref.startDistanceReason ? { startDistanceReason: ref.startDistanceReason } : {}) } as StackTransientReferenceInfo) : ({ kind: "allowance", reason: fallbackReason } as StackTransientReferenceInfo) } : {}),
    },
  };
}
