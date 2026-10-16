// A particle's transient read back from OFFBEAT (plan 13, T3 stage 3): the temperature of every cell at every output, checked against FEED's own finite-volume solution of the same
// sphere, the energy balance, the time-stepping error and the stated limits. Same checks, ids and tolerances as the pin's (src/core/transientResults.ts); the independent solution is
// trisoSolve.ts's, run on the sphere the wedge solves (trisoWedge.ts, wedgeEquivalent) so that the two share the geometry and nothing else (src/core/trisoTransientModel.ts).
//
// Energies are reported for the nominal sphere (the case's radii): the wedge's sphere has every radius 0.03 % smaller, so its energies are the nominal ones times lambda^3 (volume),
// which the record divides out. The heat made is the table's integral exactly.

import { boundaryAtTime } from "./boundaryHistory";
import { primitive, lawOf, rangeOf } from "./conductivity";
import { SPHERE } from "./geometry";
import { heatCapacityRange } from "./heatCapacity";
import { assertWholeFoamFile, Check, parsePatchValue, parseScalarField, parseVectorField, ResultsError } from "./resultsParser";
import { CROSS_CHECK_FLOOR, CROSS_CHECK_RISE_FRACTION, CROSS_CHECK_SPATIAL_FACTOR, ENERGY_BALANCE_TOLERANCE, TIME_STEP_TOLERANCE, historyEnergyWorst } from "./transientResults";
import type { NormalizedTriso } from "./triso";
import { trisoLimitChecks } from "./trisoLimits";
import { TRISO_THERMAL_ONLY_TEXT, TrisoDomainFinding, readParticleCells } from "./trisoResults";
import { TrisoRegionName, trisoStoredEnergy } from "./trisoSolve";
import { TRISO_WEDGE_VOLUME_RATIO, TrisoIndependentSet, computeTrisoIndependent, trisoInitialField, trisoTransientModelOf } from "./trisoTransientModel";
import { trisoEnergyUntil, trisoPowerAt } from "./trisoTransient";
import { TRISO_PATCHES } from "./trisoWriter";
import type { HeatCapacity } from "./validate";

export { computeTrisoIndependent } from "./trisoTransientModel";
export type { TrisoIndependentSet } from "./trisoTransientModel";

const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};
const maxOf = (a: readonly number[]): number => a.reduce((m, x) => (x > m ? x : m), -Infinity);

export interface TrisoTransientSeries {
  time: number[];
  /** Heat made in the kernel (W per particle) and the energy made so far (J), the table's own integral. */
  power: number[];
  deposited: number[];
  /** The energy the implicit time step deposits by each output: the source taken at the end of each step (OFFBEAT's, and the independent solution's), so a ramp of N steps deposits 1/N more than its integral. The energy balance is judged against it. */
  depositedByScheme: number[];
  /** Energy stored in the particle since the start and heat that left through the outside so far, J (the nominal sphere's: the wedge's divided by lambda^3). */
  stored: number[];
  rejected: number[];
  /** The hottest cell of each region at each output, K, by region name. */
  regionMax: Record<string, number[]>;
  /** The hottest cell, the temperature on the outside and the drop across the gap (the two patch values) at each output. */
  peakT: number[];
  wallT: number[];
  gapDeltaT: number[];
}

export interface TrisoTransientResultsRecord {
  schema: "feed.results/0.2";
  kind: "triso-transient";
  caseId: string;
  initialTemperature: number;
  initialState: { kind: "uniform"; temperature: number } | { kind: "steady"; particlePower: number; peakTemperature: number };
  times: number[];
  /** Cell-centre radii (on the sphere the wedge solves, m) and regions, by increasing radius, and the temperature of every cell at every output time in that order. */
  cells: { r: number; region: TrisoRegionName }[];
  profiles: number[][];
  series: TrisoTransientSeries;
  summary: { maxT: number; timeOfMaxT: number; maxRise: number; finalPeakT: number; finalTime: number };
  checks: Check[];
  domain: { verdict: "in-domain" | "out-of-domain"; findings: TrisoDomainFinding[] };
  thermalOnly: string;
}

export interface TrisoTransientInput {
  C: string;
  cellZones: string;
  /** The temperature field text at each write time after 0, in time order, with the time taken from the directory name. */
  fields: { time: number; T: string }[];
}

export const isTrisoTransientResults = (r: unknown): r is TrisoTransientResultsRecord => !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "triso-transient";

/** Build the transient results record. Throws ResultsError for anything that is not a complete, finite, consistent set of fields. */
export function buildTrisoTransientResults(n: NormalizedTriso, input: TrisoTransientInput, independent?: TrisoIndependentSet): TrisoTransientResultsRecord {
  const tr = n.transient;
  if (!tr || !n.capacities) bad("the case is not a transient particle");
  const t = tr!;
  const total = n.cells.reduce((a, b) => a + b, 0);
  if (input.fields.length !== t.outputs) bad(`expected ${t.outputs} write times after 0, found ${input.fields.length}`);
  const dtOut = (t.steps / t.outputs) * t.timeStep;
  input.fields.forEach((f, k) => {
    const want = (k + 1) * dtOut;
    if (!(Math.abs(f.time - want) <= 1e-9 * t.endTime)) bad(`write time ${k + 1} is ${f.time} s, expected ${want} s`);
  });
  const Craw = parseVectorField(input.C, "C");
  assertWholeFoamFile(input.C, "C");
  const info = readParticleCells(n, Craw, input.cellZones);
  const { order, radius, regionOf, names, eq } = info;
  const radiusSorted = order.map((i) => radius[i]!);
  const regionSorted = order.map((i) => regionOf[i]!);

  const times = [0, ...input.fields.map((f) => f.time)];
  const init = trisoInitialField(n);
  const profiles: number[][] = [init.T.slice()];
  const walls: number[] = [init.wall];
  const gaps: number[] = [t.initial.kind === "steady" ? (t.initial.particlePower * TRISO_WEDGE_VOLUME_RATIO) / (SPHERE.area(eq.layers[0]!.outerRadius) * n.gapConductance) : 0];
  for (const f of input.fields) {
    const T = parseScalarField(f.T, "T");
    if (T.length !== total) bad(`time ${f.time}: expected ${total} cells, found ${T.length}`);
    if (!/\bboundaryField\b/.test(f.T)) bad(`time ${f.time}: field T has no boundaryField (the file is cut short)`);
    const patch = (name: string): number => {
      const v = parsePatchValue(f.T, name);
      if (v === null) return bad(`time ${f.time}: field T has no value for the ${name} patch`);
      return v;
    };
    const wall = patch(TRISO_PATCHES.outer);
    const gi = patch(TRISO_PATCHES.gapInner);
    const go = patch(TRISO_PATCHES.gapOuter);
    if (!(wall > 0)) bad(`time ${f.time}: the outer wall temperature ${wall} K is not above 0 K`);
    assertWholeFoamFile(f.T, "T");
    T.forEach((x, i) => {
      if (!(x > 0)) bad(`time ${f.time}, cell ${i}: temperature ${x} K is not above 0 K`);
    });
    profiles.push(order.map((i) => T[i]!));
    walls.push(wall);
    gaps.push(gi - go);
  }

  // the independent solution: same mesh and step (cross-check), doubled mesh (its own spatial error), half step (the time error)
  const { fv, fv2, fvh } = independent ?? computeTrisoIndependent(n);
  if (fv.states.length !== times.length) bad("the independent solution has a different number of outputs");
  const model = trisoTransientModelOf(n);

  const series: TrisoTransientSeries = {
    time: times,
    power: times.map((tt) => trisoPowerAt(t.times, t.particlePower, tt)),
    deposited: times.map((tt) => trisoEnergyUntil(t.times, t.particlePower, tt)),
    depositedByScheme: times.map((_, j) => {
      let e = 0;
      for (let st = 1; st <= j * (t.steps / t.outputs); st++) e += trisoPowerAt(t.times, t.particlePower, st * t.timeStep) * t.timeStep;
      return e;
    }),
    stored: [],
    rejected: [],
    regionMax: Object.fromEntries(names.map((nm) => [nm, [] as number[]])),
    peakT: [],
    wallT: walls,
    gapDeltaT: gaps,
  };
  // the heat that leaves: through the film (convective), or through the last half cell (a prescribed wall), summed over the outputs by the trapezoid; a film that changes between outputs is integrated finely
  const hist = t.boundaryHistory;
  const Ro = eq.outerRadius;
  const lastLaw = lawOf(eq.layers[eq.layers.length - 1]!.conductivity);
  const rLast = radiusSorted[total - 1]!;
  const outflow = (prof: number[], wall: number, at: number): number => {
    const b = hist ? boundaryAtTime(hist, at) : n.boundary;
    if (b.kind === "convective") return b.heatTransferCoefficient * SPHERE.area(Ro) * (wall - b.bulkTemperature);
    return (primitive(lastLaw, prof[total - 1]!) - primitive(lastLaw, wall)) / SPHERE.resist(rLast, Ro, 1);
  };
  const lambda3 = TRISO_WEDGE_VOLUME_RATIO;
  let rej = 0;
  profiles.forEach((p, k) => {
    series.peakT.push(maxOf(p));
    names.forEach((nm, ri) => series.regionMax[nm]!.push(maxOf(p.filter((_, i) => regionSorted[i] === ri))));
    series.stored.push(trisoStoredEnergy(model, fv, p, init.T) / lambda3);
    if (k > 0 && hist && hist.kind === "convective") {
      const t0 = times[k - 1]!;
      const t1 = times[k]!;
      const NSUB = 400;
      let acc = 0;
      for (let s = 0; s <= NSUB; s++) {
        const at = t0 + ((t1 - t0) * s) / NSUB;
        const w = walls[k - 1]! + ((walls[k]! - walls[k - 1]!) * (at - t0)) / (t1 - t0);
        acc += (s === 0 || s === NSUB ? 1 : s % 2 ? 4 : 2) * outflow(p, w, at);
      }
      rej += (acc * (t1 - t0)) / (3 * NSUB);
    } else if (k > 0) rej += 0.5 * (outflow(profiles[k - 1]!, walls[k - 1]!, times[k - 1]!) + outflow(p, walls[k]!, times[k]!)) * (times[k]! - times[k - 1]!);
    series.rejected.push(rej / lambda3);
  });

  const checks: Check[] = [];
  const k = times.length - 1;
  const outputRise = maxOf(series.peakT) - init.peak;

  // energy balance from the output fields (the pin's rule: against the energy deposited, or against the largest energy exchanged anywhere when the run starts steady or the outside moves)
  const steadyStart = t.initial.kind === "steady" || hist !== undefined;
  const dep = series.depositedByScheme;
  const throughput = (j: number) => (hist ? 1 : steadyStart ? Math.max(dep[j]!, series.rejected[j]!, Math.abs(series.stored[j]!)) : dep[j]!);
  if (throughput(k) > 0) {
    const worst = hist ? historyEnergyWorst(dep, series.stored, series.rejected) : Math.max(...times.map((_, j) => (throughput(j) > 0 ? Math.abs(dep[j]! - series.stored[j]! - series.rejected[j]!) / throughput(j) : 0)));
    checks.push({ id: "energyBalance", label: "Energy balance (deposited = stored + rejected, from the outputs)", value: worst, unit: "relative", verdict: worst <= ENERGY_BALANCE_TOLERANCE ? "pass" : "fail", note: `largest relative gap over the outputs; threshold ${100 * ENERGY_BALANCE_TOLERANCE}% of the ${hist ? "largest of the energy deposited, rejected and stored anywhere in the run (a boundary history)" : steadyStart ? "largest of the energy deposited, rejected and stored so far (the run starts from a steady operating state)" : "energy deposited so far"}. Energies are the nominal sphere's (the wedge's divided by ${lambda3.toFixed(6)}). The heat made is that of the implicit step (the source at the end of each step, which is how OFFBEAT and the independent solution deposit it; the integral of the table is in the record as "deposited"), and the heat leaving is a trapezoid over the output times, which is poor when the outputs are far apart compared with the time the heat takes to leave: add outputs` });
  }

  const peakRise = Math.max(outputRise, maxOf(fv.trace!.peakByStep) - init.peak);
  const outerRef = n.boundary.kind === "convective" ? n.boundary.bulkTemperature : n.boundary.surfaceTemperature;
  const baseScale = t.initial.kind === "steady" ? Math.max(peakRise, init.peak + peakRise - outerRef) : peakRise;
  // a changing outside can only cool the particle or warm it with no heat source at all: the scale is then the largest excursion of the peak from its start, up or down
  const scaleRise = hist ? Math.max(baseScale, init.peak - Math.min(...fv.trace!.peakByStep), maxOf(fv.trace!.peakByStep) - init.peak) : baseScale;
  // spatial: the independent solution on the doubled mesh, averaged back onto the case's cells by volume
  const bounds = [0, eq.kernelRadius, ...eq.layers.map((l) => l.outerRadius)];
  const faces = (ri: number, cells: number): number[] => Array.from({ length: cells + 1 }, (_, i) => bounds[ri]! + ((bounds[ri + 1]! - bounds[ri]!) * i) / cells);
  let spatial = 0;
  let cross = 0;
  let crossAt = 0;
  fv.states.forEach((s, j) => {
    let base = 0;
    n.cells.forEach((nc, ri) => {
      const f2 = faces(ri, 2 * nc);
      for (let i = 0; i < nc; i++) {
        const a = SPHERE.volume(f2[2 * i]!, f2[2 * i + 1]!);
        const b = SPHERE.volume(f2[2 * i + 1]!, f2[2 * i + 2]!);
        const fine = fv2.states[j]!.T;
        const avg = (a * fine[2 * base + 2 * i]! + b * fine[2 * base + 2 * i + 1]!) / (a + b);
        spatial = Math.max(spatial, Math.abs(s.T[base + i]! - avg));
        const d = Math.abs(profiles[j]![base + i]! - s.T[base + i]!);
        if (d > cross) {
          cross = d;
          crossAt = times[j]!;
        }
      }
      base += nc;
    });
    // the outer wall as well: it is a patch value that no cell check would catch
    if (j > 0) {
      const dw = Math.abs(walls[j]! - s.wall);
      if (dw > cross) {
        cross = dw;
        crossAt = times[j]!;
      }
    }
  });
  const crossBound = Math.min(CROSS_CHECK_SPATIAL_FACTOR * spatial, CROSS_CHECK_RISE_FRACTION * Math.max(scaleRise, 1)) + CROSS_CHECK_FLOOR;
  checks.push({ id: "crossCheckFv", label: "OFFBEAT vs the independent finite-volume solution (max cell deviation)", value: cross, unit: "K", verdict: cross <= crossBound ? "pass" : "fail", note: `largest at t = ${crossAt} s; bound ${crossBound.toFixed(3)} K = min(${CROSS_CHECK_SPATIAL_FACTOR} x ${spatial.toFixed(3)} K [the independent solution's own change when its cells are halved], ${CROSS_CHECK_RISE_FRACTION * 100}% of the peak rise) + ${CROSS_CHECK_FLOOR} K` });
  // the time-step error over EVERY step of the run, not only at the saved outputs
  let timeErr = 0;
  const coarse = fv.trace!.peakByStep;
  const fine = fvh.trace!.peakByStep;
  for (let j = 0; j < coarse.length; j++) timeErr = Math.max(timeErr, Math.abs(coarse[j]! - fine[2 * j]!));
  // a changing outside can act on the outer layers while the hottest cell hardly moves: the step against half step difference is then also taken over every cell and the wall at each output
  let fieldErr = 0;
  let fieldScale = 0;
  if (hist) {
    fv.states.forEach((s, j) => {
      const sf = fvh.states[j];
      if (!sf) return;
      s.T.forEach((x, i) => {
        fieldErr = Math.max(fieldErr, Math.abs(x - sf.T[i]!));
        fieldScale = Math.max(fieldScale, Math.abs(x - init.T[i]!));
      });
      fieldErr = Math.max(fieldErr, Math.abs(s.wall - sf.wall));
      fieldScale = Math.max(fieldScale, Math.abs(s.wall - init.wall));
    });
  }
  const timeBound = TIME_STEP_TOLERANCE * Math.max(scaleRise, 1);
  const fieldBound = TIME_STEP_TOLERANCE * Math.max(fieldScale, 1);
  const timeOk = timeErr <= timeBound && (!hist || fieldErr <= fieldBound);
  checks.push({ id: "timeStep", label: "Time-stepping error of the peak temperature (step vs half step)", value: hist ? Math.max(timeErr, fieldErr) : timeErr, unit: "K", verdict: timeOk ? "pass" : "fail", note: `the peak changes by at most ${timeErr.toFixed(3)} K, at any step of the run, when the step is halved; threshold ${TIME_STEP_TOLERANCE * 100}% of the peak rise (${timeBound.toFixed(2)} K).${hist ? ` With a boundary history every cell and the outer wall are compared at each output too: at most ${fieldErr.toFixed(3)} K, threshold ${TIME_STEP_TOLERANCE * 100}% of the largest excursion of any cell (${fieldBound.toFixed(2)} K).` : ""} If it fails, shorten the time step` });

  if (n.boundary.kind === "surface-temperature") {
    const wanted = (tt: number) => (hist && hist.kind === "surface-temperature" ? (boundaryAtTime(hist, tt) as { surfaceTemperature: number }).surfaceTemperature : (n.boundary as { surfaceTemperature: number }).surfaceTemperature);
    const d = maxOf(walls.map((w, j) => Math.abs(w - wanted(times[j]!))));
    checks.push({ id: "wallTemperature", label: "Outer wall temperature vs the prescribed value", value: d, unit: "K", verdict: d < 0.05 ? "pass" : "fail", note: "threshold 0.05 K at every output" + (hist ? " (against the boundary history at each output time)" : "") });
  }

  // property ranges: over every output and every step of the independent solution
  const findings: TrisoDomainFinding[] = [];
  const caps: HeatCapacity[] = n.capacities!;
  const ks = [n.kernelConductivity, ...n.layers.map((l) => l.conductivity)];
  names.forEach((nm, ri) => {
    let lo = fv.trace!.regionMin[ri]!;
    let hi = fv.trace!.regionMax[ri]!;
    profiles.forEach((p) =>
      p.forEach((x, i) => {
        if (regionSorted[i] === ri) {
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
      }),
    );
    for (const r of [rangeOf(ks[ri]!), heatCapacityRange(caps[ri]!)]) if (r && (lo < r[0] || hi > r[1])) findings.push({ region: nm, produced: [lo, hi], validRange: r });
  });
  const domain = { verdict: (findings.length === 0 ? "in-domain" : "out-of-domain") as "in-domain" | "out-of-domain", findings };
  if (ks.some((kk) => rangeOf(kk) !== undefined) || caps.some((c) => c.kind !== "constant")) {
    checks.push({ id: "propertyRange", label: "Property laws within their stated ranges", value: null, unit: "", verdict: findings.length === 0 ? "pass" : "fail", note: findings.length === 0 ? "all cell temperatures inside the stated ranges at every output and at every step of the independent solution" : findings.map((f) => `${f.region}: ${f.produced.map((x) => x.toFixed(0)).join("-")} K outside ${f.validRange.join("-")} K`).join("; ") + ". A law was extrapolated; this result is out-of-domain." });
  }

  // the stated limits: the worse of the solver's outputs and every step of the independent solution
  if (n.limits) {
    const observed = times.map((tt, j) => ({ time: tt, max: Object.fromEntries(names.map((nm) => [nm, series.regionMax[nm]![j]!])) }));
    const independentStates = fv.trace!.regionMaxByStep.map((m, j) => ({ time: j * t.timeStep, max: Object.fromEntries(names.map((nm, ri) => [nm, m[ri]!])) }));
    checks.push(...trisoLimitChecks(n.limits, observed, independentStates));
  }
  for (const ch of checks) if (ch.value !== null && !Number.isFinite(ch.value)) bad(`check ${ch.id} is not a finite number (${ch.value})`);
  const jMax = series.peakT.indexOf(maxOf(series.peakT));
  return {
    schema: "feed.results/0.2",
    kind: "triso-transient",
    caseId: n.caseId,
    initialTemperature: init.peak,
    initialState: t.initial.kind === "uniform" ? { kind: "uniform", temperature: t.initial.temperature } : { kind: "steady", particlePower: t.initial.particlePower, peakTemperature: init.peak },
    times,
    cells: radiusSorted.map((r, i) => ({ r, region: names[regionSorted[i]!]! })),
    profiles,
    series,
    summary: { maxT: series.peakT[jMax]!, timeOfMaxT: times[jMax]!, maxRise: outputRise, finalPeakT: series.peakT[times.length - 1]!, finalTime: times[times.length - 1]! },
    checks,
    domain,
    thermalOnly: TRISO_THERMAL_ONLY_TEXT,
  };
}
