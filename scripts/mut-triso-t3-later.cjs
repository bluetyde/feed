// Mutants of the later stages of plan 13, T3 (see mut-triso-t3.cjs, which loads this file): stage 2 (limits for the layers) and stage 3 (the particle transient).
const T = "src/core/triso.ts";
const L = "src/core/trisoLimits.ts";
const R = "src/core/trisoResults.ts";
const V = "src/core/validate.ts";

const stage2 = [
  [T, "export const TRISO_MAX_LIMITS = 10;", "export const TRISO_MAX_LIMITS = 100;", "limit count bound"],
  [T, "export const TRISO_MAX_LIMIT_TEMPERATURE = 10000;", "export const TRISO_MAX_LIMIT_TEMPERATURE = 1e9;", "limit temperature bound"],
  [T, "if (typeof r.region !== \"string\" || !known.includes(r.region))", "if (typeof r.region !== \"string\")", "unknown region accepted"],
  [T, "else if (!regions.includes(r.region)) bad(\"E_GEOMETRY\"", "else if (false) bad(\"E_GEOMETRY\"", "region the particle lacks accepted"],
  [T, "if (r.whileCladding !== undefined) bad(", "if (false) bad(", "whileCladding accepted"],
  [T, "else if (names.has(name)) bad(", "else if (false) bad(", "duplicate names accepted"],
  [T, "name.length > 80 ||", "name.length > 800 ||", "name length bound"],
  [T, "if (typeof r.source !== \"string\" || r.source.trim() === \"\") bad(", "if (typeof r.source !== \"string\") bad(", "empty source accepted"],
  [T, "else if (!(max > 0 && max <= TRISO_MAX_LIMIT_TEMPERATURE)) {", "else if (!(max <= TRISO_MAX_LIMIT_TEMPERATURE)) {", "zero kelvin accepted"],
  [L, "const m = rule.maxTemperature - T;", "const m = T - rule.maxTemperature;", "margin sign"],
  [L, "verdict: o.margin >= 0 ? (\"pass\" as const) : (\"fail\" as const),", "verdict: o.margin > 0 ? (\"pass\" as const) : (\"fail\" as const),", "zero margin fails"],
  [L, "if (T === undefined || !Number.isFinite(T)) {", "if (T === undefined) {", "non-finite temperature judged"],
  [L, "if (margin === null || m < margin) {", "if (margin === null || m > margin) {", "largest margin reported"],
  [L, "(a.margin === null || b.margin < a.margin)", "(a.margin === null || b.margin > a.margin)", "better of the two views taken"],
  [L, "if (invalid > 0 || o.margin === null || o.worst === null) {", "if (o.margin === null || o.worst === null) {", "invalid moments ignored"],
  [R, "if (n.limits) checks.push(...trisoLimitChecks(", "if (false) checks.push(...trisoLimitChecks(", "limits not checked"],
  [R, "[nm, Math.max(...cells.filter((c) => c.region === nm)", "[nm, Math.min(...cells.filter((c) => c.region === nm)", "coldest cell of the region"],
  [V, "gapConductance: hGap, boundary, power, cells, ...(limits ? { limits } : {}) };", "gapConductance: hGap, boundary, power, cells };", "limits dropped from the normalised case"],
];

const TT = "src/core/trisoTransient.ts";
const TM = "src/core/trisoTransientModel.ts";
const TR = "src/core/trisoTransientResults.ts";
const SV = "src/core/trisoSolve.ts";
const WR = "src/core/trisoWriter.ts";
const RM = "src/core/runManager.ts";
const SR = "src/server/server.ts";
const EX = "src/core/exportResults.ts";

const stage3 = [
  [TT, "export const MAX_TRISO_TRANSIENT_WORK = 5e5;", "export const MAX_TRISO_TRANSIENT_WORK = 5e8;", "work budget"],
  [TT, "if (q < 0) return bad(", "if (false) return bad(", "negative power accepted"],
  [TT, "if (times[0] !== 0) bad(", "if (false) bad(", "history not from zero accepted"],
  [TT, "if (!(times[i]! > times[i - 1]!)) {", "if (false) {", "history not increasing accepted"],
  [TT, "times[times.length - 1]! < endTime * (1 - 1e-12)", "times[times.length - 1]! < 0", "history ending early accepted"],
  [TT, "if (!(Math.max(...power) > 0) && t.initialSteadyParticlePower === undefined && t.boundaryHistory === undefined)", "if (false)", "all-zero power accepted"],
  [TT, "if (Math.abs(ratio - steps) > 1e-9 * Math.max(1, ratio))", "if (false)", "step not dividing accepted"],
  [TT, "else if (steps >= 1 && steps % outputs !== 0)", "else if (false)", "outputs not dividing accepted"],
  [TT, "if (t.initialTemperature !== undefined && t.initialSteadyParticlePower !== undefined)", "if (false)", "two starts accepted"],
  [TT, "if (k === \"pointKinetics\") bad(", "if (false) bad(", "point kinetics accepted"],
  [TT, "e += 0.5 * (power[i - 1]! + pb) * (b - a);", "e += power[i - 1]! * (b - a);", "energy integral by the left value"],
  [TT, "if (t <= times[0]!) return power[0]!;", "if (t <= times[0]!) return 0;", "power before the first point"],
  [TM, "power: (t) => trisoPowerAt(tr.times, tr.particlePower, t) * TRISO_WEDGE_VOLUME_RATIO }", "power: (t) => trisoPowerAt(tr.times, tr.particlePower, t) }", "model power not scaled to the wedge's volume"],
  [TM, "tr.initial.particlePower * TRISO_WEDGE_VOLUME_RATIO", "tr.initial.particlePower", "steady start power not scaled"],
  [TM, "cells: base.cells.map((c) => c * cellFactor)", "cells: base.cells.map((c) => c)", "cell factor ignored"],
  [TM, "dt: tr.timeStep / stepFactor,", "dt: tr.timeStep,", "half step ignored"],
  [TM, "outputEvery: (tr.steps / tr.outputs) * stepFactor,", "outputEvery: tr.steps / tr.outputs,", "output grid of the half step"],
  [TM, "...(hist ? { boundaryAt: (t: number) => boundaryAtTime(hist, t) } : {})", "", "outside's table ignored"],
  [SV, "const b1 = boundaryOf(t1);", "const b1 = boundaryOf(t0);", "outside taken at the start of the step"],
  [SV, "trace.regionMaxByStep.push(mx);", "", "region trace not recorded"],
  [SV, "if (x > trace.regionMax[ri]!) trace.regionMax[ri] = x;", "", "region maximum over the run"],
  [TR, "verdict: worst <= ENERGY_BALANCE_TOLERANCE ? \"pass\" : \"fail\"", "verdict: worst <= 1 ? \"pass\" : \"fail\"", "energy balance tolerance"],
  [TR, "const dep = series.depositedByScheme;", "const dep = series.deposited;", "balance against the exact integral"],
  [TR, "verdict: cross <= crossBound ? \"pass\" : \"fail\"", "verdict: cross <= 1e9 ? \"pass\" : \"fail\"", "cross-check tolerance"],
  [TR, "const timeOk = timeErr <= timeBound && (!hist || fieldErr <= fieldBound);", "const timeOk = true;", "time-step check void"],
  [TR, "const fine = fvh.trace!.peakByStep;", "const fine = fv.trace!.peakByStep.flatMap((x) => [x, x]);", "half-step run replaced"],
  [TR, "series.rejected.push(rej / lambda3);", "series.rejected.push(rej);", "rejected not in nominal energy"],
  [TR, "series.stored.push(trisoStoredEnergy(model, fv, p, init.T) / lambda3);", "series.stored.push(trisoStoredEnergy(model, fv, p, init.T));", "stored not in nominal energy"],
  [TR, "} else if (k > 0) rej += 0.5 * (outflow(", "} else if (k > 0) rej += 1 * (outflow(", "trapezoid of the heat leaving"],
  [TR, "const d = maxOf(walls.map((w, j) => Math.abs(w - wanted(times[j]!))));", "const d = 0;", "wall check void"],
  [TR, "if (n.limits) {", "if (false) {", "limits not checked in a transient"],
  [TR, "for (const r of [rangeOf(ks[ri]!), heatCapacityRange(caps[ri]!)])", "for (const r of [rangeOf(ks[ri]!)])", "heat capacity range not checked"],
  [TR, "const independentStates = fv.trace!.regionMaxByStep.map(", "const independentStates = observed.map((o) => ({ ...o, max: o.max })).concat([]).filter(() => false).map(", "limits not judged on the independent steps"],
  [TR, "if (!(Math.abs(f.time - want) <= 1e-9 * t.endTime)) bad(", "if (false) bad(", "write times not checked"],
  [WR, "writeEvery: tr.steps / tr.outputs }) :", "writeEvery: 1 }) :", "every step written"],
  [WR, "[...tr.times, tr.times[tr.times.length - 1]! + tr.timeStep].map(num)", "[...tr.times].map(num)", "no flat point beyond the table"],
  [WR, "(p) => num(p / n.power.kernelVolume)", "(p) => num(p)", "power not divided by the kernel's volume"],
  [WR, "trisoMaterial(\"Kernel\", n.kernelConductivity, tr ? caps![0] : undefined)", "trisoMaterial(\"Kernel\", n.kernelConductivity, undefined)", "kernel's heat capacity not written"],
  [WR, "const steadyStart = tr && tr.initial.kind === \"steady\" ? trisoInitialField(n) : undefined;", "const steadyStart = undefined;", "steady start not written"],
  [WR, "...(tr ? { \"feed-transient.json\":", "...(false ? { \"feed-transient.json\":", "transient marker not written"],
  [WR, "return hist.kind === \"convective\"", "return hist.kind === \"convective\" && false", "film table written as a wall table"],
  [RM, "if (normalized.kind === \"triso\" && normalized.transient) {", "if (false) {", "particle transient not dispatched"],
  [RM, "claddingOuterWallT: tr.series.wallT[tr.series.wallT.length - 1]!, transient: true };", "claddingOuterWallT: tr.series.wallT[0]!, transient: true };", "headline wall from the start"],
  [SR, "if (\"kind\" in d.results && d.results.kind === \"triso-transient\") return void res.end(trisoTransientResultsToCsv(d.results, meta));", "if (false) return void res.end(trisoTransientResultsToCsv(d.results as any, meta));", "transient CSV not routed"],
  [EX, "...regions.map((r) => r + \"_max_T_K\"), \"outer_wall_T_K\"", "\"outer_wall_T_K\"", "CSV without the region maxima"],
  [V, "if (c.power !== undefined) err(\"E_TRANSIENT_INCOMPLETE\", \"/power\"", "if (false) err(\"E_TRANSIENT_INCOMPLETE\", \"/power\"", "power section in a transient accepted"],
  [V, "if (!isTransient && c.transient !== undefined) err(", "if (false) err(", "transient section in a steady case accepted"],
  [V, "if (isTransient && c.transient === undefined) err(", "if (false) err(", "transient case without its section accepted"],
  [V, "if (work > MAX_TRISO_TRANSIENT_WORK) {", "if (false) {", "work not bounded"],
  [V, "if (triso.transient.initial.kind === \"steady\") trisoInitialField(triso); // the steady start has to exist", "void 0;", "steady start not checked"],
  [V, "trisoClosedForm(triso); // at the table's peak power: finds a conductivity that reaches zero", "void 0;", "closed form at the peak not taken"],
];

module.exports = { 2: stage2, 3: stage3 };
