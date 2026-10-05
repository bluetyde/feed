// Results of a thermal transient (plan 08): the temperature field at every output time, read from OFFBEAT's files, checked
// against an independent finite-volume solution (transientFv.ts) and against energy conservation. The record schema is
// feed.results/0.2; the steady record (feed.results/0.1) is unchanged.

import { Check, DomainFinding, ResultsError, THERMAL_ONLY_TEXT, assertWholeFoamFile, parsePatchValue, parseScalarField, parseVectorField } from "./resultsParser";
import { FvTransient, Linear, TransientPin, enthalpy, maxOf, minOf, solveTransientFv, storedEnergy } from "./transientFv";
import { Conductivity, HeatCapacity, NormalizedCase } from "./validate";

const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};

export interface TransientRadialCell {
  r: number;
  region: "fuel" | "cladding";
}

export interface TransientSeries {
  time: number[];
  /** Input linear heat rate at each output time (W/m) and the energy deposited so far (J/m, exact integral of the history). */
  power: number[];
  deposited: number[];
  /** Hottest cell, last fuel cell, first cladding cell (cell-centre values) and the outer wall (patch value), K. */
  peakT: number[];
  fuelSurfaceCellT: number[];
  claddingInnerCellT: number[];
  claddingOuterWallT: number[];
  /** Energy stored in the solids relative to the initial state (J/m), and the heat rejected so far (J/m, trapezoid over the outputs). */
  stored: number[];
  rejected: number[];
}

export interface TransientResultsRecord {
  schema: "feed.results/0.2";
  kind: "transient";
  caseId: string;
  initialTemperature: number;
  /** Output times in seconds, the first being 0 (the initial state). */
  times: number[];
  /** Cell-centre radii (fuel then cladding, each in radial order) and the temperature of every cell at every output time. */
  cells: TransientRadialCell[];
  profiles: number[][];
  series: TransientSeries;
  summary: { maxT: number; timeOfMaxT: number; maxRise: number; finalPeakT: number; finalTime: number };
  checks: Check[];
  domain: { verdict: "in-domain" | "out-of-domain"; findings: DomainFinding[] };
  thermalOnly: string;
}

export interface TransientInput {
  /** Text of the cell-centre field C (the same at every time). */
  C: string;
  /** The temperature field text at each write time after 0, in time order, with the time taken from the directory name. */
  fields: { time: number; T: string }[];
}

/** Verdict thresholds, fixed here and not tuned to any result. */
export const TIME_STEP_TOLERANCE = 0.02; // estimated time-stepping error of the peak, as a fraction of its rise
export const ENERGY_BALANCE_TOLERANCE = 0.03; // of the energy deposited, from the output fields
export const CROSS_CHECK_SPATIAL_FACTOR = 3; // times the finite-volume solution's own spatial refinement difference
export const CROSS_CHECK_FLOOR = 0.02; // K
/**
 * The cross-check bound is the smaller of the spatial allowance above and this fraction of the peak temperature rise: the two
 * solutions share the cell layout and the (first-order) time scheme, so they agree far more closely than either agrees with the
 * exact solution, and a 1% error in a property or in the power shows up as about 1% of the rise. 0.5% therefore detects it.
 */
export const CROSS_CHECK_RISE_FRACTION = 0.005;

const lin = (k: Conductivity): Linear => (k.kind === "constant" ? { a: k.k, b: 0 } : { a: k.a, b: k.b });
const linC = (c: HeatCapacity): Linear => (c.kind === "constant" ? { a: c.c, b: 0 } : { a: c.a, b: c.b });

/** The independent model of a normalized transient case. */
export function pinOf(c: NormalizedCase, cellFactor = 1): TransientPin {
  if (!c.transient || !c.fuelHeatCapacity || !c.claddingHeatCapacity) throw new Error("not a transient case");
  const { times, linearHeatRate } = c.transient;
  const power = (t: number) => {
    if (t <= times[0]!) return linearHeatRate[0]!;
    for (let i = 1; i < times.length; i++) {
      if (t <= times[i]!) return linearHeatRate[i - 1]! + ((linearHeatRate[i]! - linearHeatRate[i - 1]!) * (t - times[i - 1]!)) / (times[i]! - times[i - 1]!);
    }
    return linearHeatRate[linearHeatRate.length - 1]!;
  };
  return {
    fuelInnerRadius: c.fuelInnerRadius,
    fuelRadius: c.fuelRadius,
    claddingInnerRadius: c.claddingInnerRadius,
    claddingOuterRadius: c.claddingOuterRadius,
    fuelCells: c.mesh.fuelCells * cellFactor,
    claddingCells: c.mesh.claddingCells * cellFactor,
    gapConductance: c.gapConductance,
    fuelK: lin(c.fuelConductivity),
    claddingK: lin(c.claddingConductivity),
    fuelC: linC(c.fuelHeatCapacity),
    claddingC: linC(c.claddingHeatCapacity),
    boundary: c.boundary.kind === "convective" ? { kind: "convective", bulkTemperature: c.boundary.bulkTemperature, heatTransferCoefficient: c.boundary.heatTransferCoefficient } : { kind: "surface-temperature", surfaceTemperature: c.boundary.surfaceTemperature },
    power,
  };
}

/** Exact integral of the piecewise-linear power history from 0 to t (J/m). */
export function depositedEnergy(times: number[], q: number[], t: number): number {
  let e = 0;
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1]!;
    if (t <= a) break;
    const b = Math.min(times[i]!, t);
    const qb = q[i - 1]! + ((q[i]! - q[i - 1]!) * (b - a)) / (times[i]! - a);
    e += 0.5 * (q[i - 1]! + qb) * (b - a);
  }
  return e;
}

/** Run the independent solution for the case: the result at the output times, with the given step divisor and cell factor. */
export function independentSolution(c: NormalizedCase, stepFactor = 1, cellFactor = 1, trace = false): FvTransient {
  const tr = c.transient!;
  return solveTransientFv(pinOf(c, cellFactor), { dt: tr.timeStep / stepFactor, steps: tr.steps * stepFactor, initialTemperature: tr.initialTemperature, outputEvery: (tr.steps / tr.outputs) * stepFactor, trace });
}

/**
 * Build the transient results record. Throws ResultsError for anything that is not a complete, finite, consistent set of fields:
 * wrong cell count or write times, non-finite or non-positive temperatures, a file cut short, a missing wall value.
 */
export function buildTransientResults(c: NormalizedCase, input: TransientInput): TransientResultsRecord {
  const tr = c.transient;
  if (!tr || !c.fuelHeatCapacity || !c.claddingHeatCapacity) bad("the case is not a transient");
  const t = tr!;
  const nf = c.mesh.fuelCells;
  const nc = c.mesh.claddingCells;
  const n = nf + nc;
  if (input.fields.length !== t.outputs) bad(`expected ${t.outputs} write times after 0, found ${input.fields.length}`);
  const dtOut = (t.steps / t.outputs) * t.timeStep;
  input.fields.forEach((f, k) => {
    const want = (k + 1) * dtOut;
    if (!(Math.abs(f.time - want) <= 1e-9 * t.endTime)) bad(`write time ${k + 1} is ${f.time} s, expected ${want} s`);
  });

  const Craw = parseVectorField(input.C, "C");
  if (Craw.length !== n) bad(`C has ${Craw.length} cells, expected ${n}`);
  assertWholeFoamFile(input.C, "C");
  const r = Craw.map((p) => Math.hypot(p[0]!, p[1]!));
  const eps = 1e-9;
  r.forEach((x, i) => {
    if (x > c.claddingOuterRadius + eps) bad(`cell ${i} is outside the pin (r = ${x} m)`);
    if (!(x < c.fuelRadius || x > c.claddingInnerRadius)) bad(`cell ${i} has its centre in the gap or on an interface (r = ${x} m)`);
    if (x < c.fuelInnerRadius + eps) bad(`cell ${i} has its centre inside the central hole (r = ${x} m)`);
  });
  const order = r.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const fuelIdx = order.filter((o) => o.x < c.fuelRadius).map((o) => o.i);
  const cladIdx = order.filter((o) => o.x > c.claddingInnerRadius).map((o) => o.i);
  if (fuelIdx.length !== nf || cladIdx.length !== nc) bad("cell centres do not split into the expected fuel and cladding counts");
  const idx = [...fuelIdx, ...cladIdx];
  const cells: TransientRadialCell[] = idx.map((i, j) => ({ r: r[i]!, region: j < nf ? "fuel" : "cladding" }));
  // The cell centres OFFBEAT writes are the volume centroids of the wedge cells; they must be where THIS case's mesh puts them, or the
  // profile, the stored energy and the independent comparison would all be about a different pin.
  const centroid = (a: number, b: number) => ((2 / 3) * (b ** 3 - a ** 3)) / (b ** 2 - a ** 2);
  const dFuel = (c.fuelRadius - c.fuelInnerRadius) / nf;
  const dClad = (c.claddingOuterRadius - c.claddingInnerRadius) / nc;
  cells.forEach((cell, j) => {
    const k0 = j < nf ? j : j - nf;
    const a = j < nf ? c.fuelInnerRadius + k0 * dFuel : c.claddingInnerRadius + k0 * dClad;
    const d = j < nf ? dFuel : dClad;
    const want = centroid(a, a + d);
    if (!(Math.abs(cell.r - want) <= 1e-3 * d + 1e-9)) bad(`cell ${j}: the centre is at r = ${cell.r} m but this case's mesh puts it at ${want} m`);
  });
  for (let j = 1; j < nf; j++) if (!(cells[j]!.r - cells[j - 1]!.r > 1e-12)) bad("two fuel cells share a centre");
  for (let j = nf + 1; j < n; j++) if (!(cells[j]!.r - cells[j - 1]!.r > 1e-12)) bad("two cladding cells share a centre");

  const times = [0, ...input.fields.map((f) => f.time)];
  const profiles: number[][] = [new Array<number>(n).fill(t.initialTemperature)];
  const walls: number[] = [c.boundary.kind === "surface-temperature" ? c.boundary.surfaceTemperature : t.initialTemperature];
  for (const [k, f] of input.fields.entries()) {
    const T = parseScalarField(f.T, "T");
    if (T.length !== n) bad(`time ${f.time}: expected ${n} cells, found ${T.length}`);
    if (!/\bboundaryField\b/.test(f.T)) bad(`time ${f.time}: field T has no boundaryField (the file is cut short)`);
    const wall = parsePatchValue(f.T, "cladOuter");
    if (wall === null) bad(`time ${f.time}: field T has no value for the cladOuter patch`);
    if (!(wall! > 0)) bad(`time ${f.time}: the outer wall temperature ${wall} K is not above 0 K`);
    assertWholeFoamFile(f.T, "T");
    T.forEach((x, i) => {
      if (!(x > 0)) bad(`time ${f.time}, cell ${i}: temperature ${x} K is not above 0 K`);
    });
    profiles.push(idx.map((i) => T[i]!));
    walls.push(wall!);
    void k;
  }

  // --- series
  const pin = pinOf(c);
  const series: TransientSeries = { time: times, power: times.map((tt) => pin.power(tt)), deposited: times.map((tt) => depositedEnergy(t.times, t.linearHeatRate, tt)), peakT: [], fuelSurfaceCellT: [], claddingInnerCellT: [], claddingOuterWallT: walls, stored: [], rejected: [] };
  const outflow = (prof: number[], wall: number) => {
    if (c.boundary.kind === "convective") return c.boundary.heatTransferCoefficient * 2 * Math.PI * c.claddingOuterRadius * (wall - c.boundary.bulkTemperature);
    const kk = lin(c.claddingConductivity);
    const Tl = prof[n - 1]!;
    return ((2 * Math.PI * (kk.a + kk.b * 0.5 * (Tl + wall))) / Math.log(c.claddingOuterRadius / cells[n - 1]!.r)) * (Tl - wall);
  };
  let rej = 0;
  profiles.forEach((p, k) => {
    series.peakT.push(maxOf(p));
    series.fuelSurfaceCellT.push(p[nf - 1]!);
    series.claddingInnerCellT.push(p[nf]!);
    series.stored.push(storedEnergy(pin, p, t.initialTemperature));
    if (k > 0) rej += 0.5 * (outflow(profiles[k - 1]!, walls[k - 1]!) + outflow(p, walls[k]!)) * (times[k]! - times[k - 1]!);
    series.rejected.push(rej);
  });

  const checks: Check[] = [];
  /** Rise of the hottest cell over the outputs. The check thresholds use the larger rise over every step of the independent solution. */
  const outputRise = maxOf(series.peakT) - t.initialTemperature;
  let peakRise = outputRise;

  // energy balance from the output fields
  const k = times.length - 1;
  const dep = series.deposited[k]!;
  if (dep > 0) {
    const worst = Math.max(...times.map((_, j) => (series.deposited[j]! > 0 ? Math.abs(series.deposited[j]! - series.stored[j]! - series.rejected[j]!) / series.deposited[j]! : 0)));
    checks.push({ id: "energyBalance", label: "Energy balance (deposited = stored + rejected, from the outputs)", value: worst, unit: "relative", verdict: worst <= ENERGY_BALANCE_TOLERANCE ? "pass" : "fail", note: `largest relative gap over the outputs; threshold ${ENERGY_BALANCE_TOLERANCE * 100}% of the energy deposited so far. It includes the first-order error of depositing the source at the new time (about 1/N of the energy over a ramp of N steps) and a trapezoid over the output times for the heat leaving` });
  }

  // independent solution: same mesh and step (cross-check), double mesh (spatial error of the independent solution), half step (time error)
  const fv = independentSolution(c, 1, 1, true);
  const fv2 = independentSolution(c, 1, 2);
  const fvh = independentSolution(c, 2, 1, true);
  if (fv.states.length !== times.length) bad("the independent solution has a different number of outputs");
  peakRise = Math.max(outputRise, maxOf(fv.trace!.peakByStep) - t.initialTemperature);
  const volumeWeights = (cellsPerRegion: number, rIn: number, rOut: number) => {
    const faces = Array.from({ length: cellsPerRegion + 1 }, (_, i) => rIn + ((rOut - rIn) * i) / cellsPerRegion);
    return faces;
  };
  const fuelFaces2 = volumeWeights(2 * nf, c.fuelInnerRadius, c.fuelRadius);
  const cladFaces2 = volumeWeights(2 * nc, c.claddingInnerRadius, c.claddingOuterRadius);
  const subVol = (faces: number[], j: number) => faces[j + 1]! ** 2 - faces[j]! ** 2;
  let spatial = 0;
  let cross = 0;
  let crossAt = 0;
  let timeErr = 0;
  fv.states.forEach((s, j) => {
    for (let i = 0; i < n; i++) {
      const fine = fv2.states[j]!.T;
      let avg: number;
      if (i < nf) {
        const a = subVol(fuelFaces2, 2 * i);
        const b = subVol(fuelFaces2, 2 * i + 1);
        avg = (a * fine[2 * i]! + b * fine[2 * i + 1]!) / (a + b);
      } else {
        const ic = i - nf;
        const a = subVol(cladFaces2, 2 * ic);
        const b = subVol(cladFaces2, 2 * ic + 1);
        avg = (a * fine[2 * nf + 2 * ic]! + b * fine[2 * nf + 2 * ic + 1]!) / (a + b);
      }
      spatial = Math.max(spatial, Math.abs(s.T[i]! - avg));
      const d = Math.abs(profiles[j]![i]! - s.T[i]!);
      if (d > cross) {
        cross = d;
        crossAt = times[j]!;
      }
    }
    // the outer wall as well: it is a patch value that no cell check would catch
    if (j > 0) {
      const dw = Math.abs(walls[j]! - s.wall);
      if (dw > cross) {
        cross = dw;
        crossAt = times[j]!;
      }
    }
  });
  // the time-step error over EVERY step of the run, not only at the saved outputs (a sparse output would hide a pulse that is not resolved)
  const coarse = fv.trace!.peakByStep;
  const fine = fvh.trace!.peakByStep;
  for (let j = 0; j < coarse.length; j++) timeErr = Math.max(timeErr, Math.abs(coarse[j]! - fine[2 * j]!));
  const crossBound = Math.min(CROSS_CHECK_SPATIAL_FACTOR * spatial, CROSS_CHECK_RISE_FRACTION * Math.max(peakRise, 1)) + CROSS_CHECK_FLOOR;
  checks.push({ id: "crossCheckFv", label: "OFFBEAT vs the independent finite-volume solution (max cell deviation)", value: cross, unit: "K", verdict: cross <= crossBound ? "pass" : "fail", note: `largest at t = ${crossAt} s; bound ${crossBound.toFixed(3)} K = min(${CROSS_CHECK_SPATIAL_FACTOR} x ${spatial.toFixed(3)} K [the independent solution's own change when its cells are halved], ${CROSS_CHECK_RISE_FRACTION * 100}% of the peak rise) + ${CROSS_CHECK_FLOOR} K` });
  // the independent run with half the step shows how much the time stepping (first order, as OFFBEAT's) is worth
  const timeBound = TIME_STEP_TOLERANCE * Math.max(peakRise, 1);
  checks.push({ id: "timeStep", label: "Time-stepping error of the peak temperature (step vs half step)", value: timeErr, unit: "K", verdict: timeErr <= timeBound ? "pass" : "fail", note: `the peak changes by at most ${timeErr.toFixed(3)} K, at any step of the run, when the step is halved; threshold ${TIME_STEP_TOLERANCE * 100}% of the peak rise (${timeBound.toFixed(2)} K). If it fails, shorten the time step` });

  if (c.boundary.kind === "surface-temperature") {
    const d = maxOf(walls.map((w) => Math.abs(w - (c.boundary as { surfaceTemperature: number }).surfaceTemperature)));
    checks.push({ id: "wallTemperature", label: "Outer wall temperature vs the prescribed value", value: d, unit: "K", verdict: d < 0.05 ? "pass" : "fail", note: "threshold 0.05 K at every output" });
  }

  // property ranges
  const findings: DomainFinding[] = [];
  const range = (region: "fuel" | "cladding", lo: number, hi: number, stated: [number, number]) => {
    if (lo < stated[0] || hi > stated[1]) findings.push({ region, produced: [lo, hi], validRange: stated });
  };
  /** Extremes of a region over every saved output AND over every step of the independent solution (an excursion between outputs counts). */
  const extremes = (from: number, to: number, traceMin: number, traceMax: number) => {
    let lo = traceMin;
    let hi = traceMax;
    for (const p of profiles) {
      for (let i = from; i < to; i++) {
        if (p[i]! < lo) lo = p[i]!;
        if (p[i]! > hi) hi = p[i]!;
      }
    }
    return { lo, hi };
  };
  const rangesOf = (kk: Conductivity, cc: HeatCapacity | undefined, region: "fuel" | "cladding", e: { lo: number; hi: number }) => {
    if (kk.kind === "linear") range(region, e.lo, e.hi, kk.range);
    if (cc && cc.kind === "linear") range(region, e.lo, e.hi, cc.range);
  };
  rangesOf(c.fuelConductivity, c.fuelHeatCapacity, "fuel", extremes(0, nf, fv.trace!.fuelMin, fv.trace!.fuelMax));
  rangesOf(c.claddingConductivity, c.claddingHeatCapacity, "cladding", extremes(nf, n, fv.trace!.claddingMin, fv.trace!.claddingMax));
  const anyLinear = c.fuelConductivity.kind === "linear" || c.claddingConductivity.kind === "linear" || c.fuelHeatCapacity!.kind === "linear" || c.claddingHeatCapacity!.kind === "linear";
  const domain = { verdict: (findings.length === 0 ? "in-domain" : "out-of-domain") as "in-domain" | "out-of-domain", findings };
  if (anyLinear) {
    checks.push({ id: "propertyRange", label: "Property laws within their stated ranges", value: null, unit: "", verdict: findings.length === 0 ? "pass" : "fail", note: findings.length === 0 ? "all cell temperatures inside the stated ranges at every output and at every step of the independent solution" : findings.map((f) => `${f.region}: ${f.produced.map((x) => x.toFixed(0)).join("-")} K outside ${f.validRange.join("-")} K`).join("; ") + ". A law was extrapolated; this result is out-of-domain." });
  }

  for (const ch of checks) if (ch.value !== null && !Number.isFinite(ch.value)) bad(`check ${ch.id} is not a finite number (${ch.value})`);
  const jMax = series.peakT.indexOf(maxOf(series.peakT));
  return {
    schema: "feed.results/0.2",
    kind: "transient",
    caseId: c.caseId,
    initialTemperature: t.initialTemperature,
    times,
    cells,
    profiles,
    series,
    summary: { maxT: series.peakT[jMax]!, timeOfMaxT: times[jMax]!, maxRise: outputRise, finalPeakT: series.peakT[times.length - 1]!, finalTime: times[times.length - 1]! },
    checks,
    domain,
    thermalOnly: THERMAL_ONLY_TEXT,
  };
}
void enthalpy;
void minOf;
