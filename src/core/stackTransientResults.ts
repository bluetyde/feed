// The results of a transient axial stack (plan 12, A3): OFFBEAT's temperature fields at every write time for N layers per solid, cut into slices and judged slice by slice with the
// transient checks of plan 08 (cross-check against the independent finite-volume solution, energy balance, time step, property ranges, limits), each slice with its own power history
// (the case's average history times its factor) and its own coolant. The tolerances are widened by the estimated axial conduction exactly as for the steady stack (stackResults.ts).
// A slice is handed to the one-slice builder as the text of its own fields, so the one-slice code is the same code and is not changed for the stack.

import { axialConductionEstimate, axialSummary, sliceCase, sliceLoads } from "./axial";
import { Check, DomainFinding, ResultsError, THERMAL_ONLY_TEXT, parsePatchValues, parseScalarField, parseVectorField } from "./resultsParser";
import { AXIAL_TOLERANCE_FACTOR, STACK_TEXT, worstOf } from "./stackResults";
import { IndependentSet, TransientInput, TransientResultsRecord, TransientAllowance, buildTransientResults, computeIndependent, ENERGY_BALANCE_TOLERANCE } from "./transientResults";
import { NormalizedCase } from "./validate";

const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};

/** The independent solutions of every slice (each is the three runs of a one-slice transient), for the run manager's worker. */
export function computeIndependentStack(c: NormalizedCase): IndependentSet[] {
  return sliceLoads(c).map((l) => computeIndependent(sliceCase(c, l)));
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
    /** What was added to each slice's tolerances: a fraction of the slice's rise on the cross-check, and (relative to the slice's own power, scaled by the shape) on the energy balance. */
    allowance: { fraction: number; energy: number };
  };
}

export function buildStackTransientResults(c: NormalizedCase, input: TransientInput, sets?: IndependentSet[]): StackTransientRecord {
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
  // the allowance on the cross-check is a fraction of each slice's own rise (the transient's rise is the independent solution's, not the steady one at the history's peak)
  const widen = AXIAL_TOLERANCE_FACTOR * fraction;

  const recs: TransientResultsRecord[] = [];
  for (let k = 0; k < N; k++) {
    const sc = sliceCase(c, loads[k]!);
    const allow: TransientAllowance = { fraction: widen, energy: loads[k]!.factor > 0 ? (AXIAL_TOLERANCE_FACTOR * fraction * maxFactor) / loads[k]!.factor : 0 };
    const Ck = foamVector([...fi(k), ...ci(k)].map((i) => C[i]!));
    recs.push(buildTransientResults(sc, { C: Ck, fields: perSliceFields[k]! }, sets?.[k], allow));
  }

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
  checks.push({
    id: "axialConduction",
    label: "Axial heat flow allowed for in the per-slice tolerances",
    value: fraction,
    unit: "relative",
    verdict: "na",
    note: summary.conduction ? `the steady estimate is ${(fraction * 100).toPrecision(3)} % of the largest rise (src/core/axial.ts); the per-slice cross-check is widened by ${AXIAL_TOLERANCE_FACTOR} times it as a fraction of the slice's rise, and the per-slice energy balance by ${AXIAL_TOLERANCE_FACTOR} times it as a fraction of the slice's own power (the end slices make little heat and take a larger share). A transient's axial flow is not larger than the steady one for the same shape, but it was measured on the real solver only in the tests of docs/axial-stack.md` : "no estimate could be made; the per-slice tolerances are the one-dimensional ones",
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
    thermalOnly: THERMAL_ONLY_TEXT + " " + STACK_TEXT,
    axial: { length: a.length, slices, hottest, conduction: summary.conduction ? { fraction } : null, allowance: { fraction: widen, energy: widen } },
  };
}
