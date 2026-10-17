// Mutation run for plan 15, B1 to B3 (the two-dimensional solution of a stack of plates: src/core/axialFv.ts, src/core/stackReference.ts, and the branches that judge a plate stack
// against it in resultsParser.ts, stackResults.ts, stackTransientResults.ts, transientResults.ts).
// usage: node scripts/mut-plan15-b1.cjs [comma list of mutant numbers]      (commit first and keep a green baseline; never run two mutation runs at once on this machine)
// Each mutant is [file, from, to, name]: `from` is a unique anchor in `file`. The file is changed, the fast tests are run, and when they pass the slow tests too; the file is restored from the
// copy read before (never from git, so uncommitted work is safe). A mutant is KILLED when a run exits non-zero AND prints a "Tests N ..." summary; it SURVIVES when both runs exit 0; a run
// with no summary line is BROKEN (a crashed run must not count as a kill). Judge the result by the printed table.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const FAST = ["tests/axialFv.test.ts", "tests/plateStackReference.test.ts", "tests/plateStackResults.test.ts"];
const SLOW = ["tests/plateStackTransientReference.test.ts", "tests/plateStackTransientResults.test.ts", "tests/stackTransientResults.test.ts", "tests/stackResults.test.ts"];
const AF = "src/core/axialFv.ts";
const SRF = "src/core/stackReference.ts";
const RP = "src/core/resultsParser.ts";
const SR = "src/core/stackResults.ts";
const ST = "src/core/stackTransientResults.ts";
const TR = "src/core/transientResults.ts";

const mutants = [
  // ---- the banded solve
  [AF, "    const rEnd = Math.min(n - 1, p + m);", "    const rEnd = Math.min(n - 1, p + m - 1);", "solve: the band cut by one"],
  [AF, "    const cEnd = Math.min(n - 1, i + m);", "    const cEnd = Math.min(n - 1, i + m - 1);", "back substitution: the band cut by one"],
  [AF, "    if (!(piv > 0)) throw new RangeError(\"the stack's matrix has a pivot", "    if (false) throw new RangeError(\"the stack's matrix has a pivot", "solve: a pivot that is not positive accepted"],
  [AF, "      for (let c = p; c <= rEnd; c++) a[r * w + (c - r + m)]! -= f * a[p * w + (c - p + m)]!;", "      for (let c = p + 1; c <= rEnd; c++) a[r * w + (c - r + m)]! -= f * a[p * w + (c - p + m)]!;", "solve: the pivot column not eliminated"],
  // ---- the model
  [AF, "  const h = m.height / N;", "  const h = m.height;", "the layer height is the whole height"],
  [AF, "  const coupled = m.axialConduction !== false;", "  const coupled = m.axialConduction === true;", "the conduction between layers off by default"],
  [AF, "  const share = vol.map((v, i) => (m.heatAllCells ? v / totalVol : i < nf ? v / fuelVol : 0));", "  const share = vol.map((v, i) => (i < nf ? v / fuelVol : 0));", "the source never fills the cladding"],
  [AF, "  const share = vol.map((v, i) => (m.heatAllCells ? v / totalVol : i < nf ? v / fuelVol : 0));", "  const share = vol.map((v, i) => (m.heatAllCells ? v / totalVol : v / totalVol));", "the source always fills every cell"],
  [AF, "          const gz = ((2 * ka * kb) / (ka + kb)) * (vol[i]! / h);\n          A[at(id, id)]! += gz;", "          const gz = (0.5 * (ka + kb)) * (vol[i]! / h);\n          A[at(id, id)]! += gz;", "the matrix takes the arithmetic mean between layers, the flux the harmonic one"],
  [AF, "          const gz = ((2 * ka * kb) / (ka + kb)) * (vol[i]! / h);\n          A[at(id, id)]! += gz;", "          const gz = ((2 * ka * kb) / (ka + kb)) * (vol[i]! / (2 * h));\n          A[at(id, id)]! += gz;", "the axial distance doubled"],
  [AF, "          const gz = ((2 * ka * kb) / (ka + kb)) * (vol[i]! / h);\n          A[at(id, id)]! += gz;", "          const gz = ((2 * ka * kb) / (ka + kb)) * (vol[0]! / h);\n          A[at(id, id)]! += gz;", "the axial area is the first cell's"],
  [AF, "          A[at(id, id + n)]! -= gz;\n          A[at(id + n, id)]! -= gz;", "          A[at(id, id + n)]! -= gz;\n          A[at(id + n, id)]! -= 0;", "the axial coupling not symmetric"],
  [AF, "        if (coupled && k < N - 1) {", "        if (coupled && k < N - 2) {", "the top layer not coupled"],
  [AF, "        if (coupled && k < N - 1) {", "        if (coupled && k > 0) {", "the bottom layer not coupled"],
  [AF, "        const rGap = 1 / (geo.area(p.fuelRadius) * p.gapConductance);", "        const rGap = 1 / (geo.area(p.claddingInnerRadius) * p.gapConductance);", "the gap acts on the cladding face"],
  [AF, "        const rC = geo.resist(p.claddingInnerRadius, r[i + 1]!, kv[off + i + 1]!);", "        const rC = geo.resist(p.claddingInnerRadius, r[i + 1]!, kv[off + i]!);", "the cladding half cell with the fuel's conductivity"],
  [AF, "      if (i !== nf - 1) g[i] = geo.conductance(r[i]!, r[i + 1]!, 0.5 * (kv[off + i]! + kv[off + i + 1]!));", "      if (i !== nf - 1) g[i] = geo.conductance(r[i]!, r[i + 1]!, kv[off + i]!);", "the conductivity between cells not the mean"],
  [AF, "    const rHalf = geo.resist(r[n - 1]!, p.claddingOuterRadius, kl);", "    const rHalf = geo.resist(r[n - 2]!, p.claddingOuterRadius, kl);", "the outer half cell from the wrong node"],
  [AF, "    if (b.kind === \"convective\") return { g, gOut: 1 / (rHalf + 1 / (geo.area(p.claddingOuterRadius) * b.heatTransferCoefficient)) };", "    if (b.kind === \"convective\") return { g, gOut: 1 / (1 / (geo.area(p.claddingOuterRadius) * b.heatTransferCoefficient)) };", "no half cell in front of the film"],
  [AF, "      rhs[last]! += h * gOut * coolantOf(b);", "      rhs[last]! += h * gOut * coolantOf(bs[0]!);", "every layer cooled by the first layer's coolant"],
  [AF, "        rhs[id]! += h * share[i]! * qs[k]!;", "        rhs[id]! += h * share[i]! * qs[0]!;", "every layer heated at the first layer's rate"],
  [AF, "          const Cdt = (h * vol[i]! * capacityOf(p, fuel, Tn[id]!)) / dt;", "          const Cdt = (vol[i]! * capacityOf(p, fuel, Tn[id]!)) / dt;", "heat capacity without the layer height"],
  [AF, "          rhs[id]! += Cdt * Tn[id]! - (h * vol[i]! * (enthalpyOf(p, fuel, Tn[id]!) - enthalpyOf(p, fuel, Told![id]!))) / dt;", "          rhs[id]! += Cdt * Told![id]!;", "enthalpy form replaced by the plain capacity (k(T) and c(T) lose energy)"],
  // ---- Picard
  [AF, "      if (constant || delta < PICARD_TOLERANCE) {", "      if (constant || delta < 1e-2) {", "Picard stops at 0.01 K"],
  [AF, "export const PICARD_ITERATIONS = 200;", "export const PICARD_ITERATIONS = 2;", "Picard allowed two iterations"],
  [AF, "  return k(p.fuelLaw, p.fuelK) && k(p.claddingLaw, p.claddingK) && (!transient || (c(p.fuelCLaw, p.fuelC) && c(p.claddingCLaw, p.claddingC)));", "  return k(p.fuelLaw, p.fuelK) && k(p.claddingLaw, p.claddingK);", "a constant conductivity with a heat capacity that varies counted as constant"],
  [AF, "  return k(p.fuelLaw, p.fuelK) && k(p.claddingLaw, p.claddingK) && (!transient || (c(p.fuelCLaw, p.fuelC) && c(p.claddingCLaw, p.claddingC)));", "  return k(p.fuelLaw, p.fuelK) && (!transient || (c(p.fuelCLaw, p.fuelC) && c(p.claddingCLaw, p.claddingC)));", "the cladding's conductivity not looked at for constancy"],
  [AF, "        if (!Tn.every((x) => Number.isFinite(x) && x > 0)) throw", "        if (false) throw", "a field with temperatures at or below 0 K accepted"],
  // ---- the walls, the heat out, the storage
  [AF, "      if (b.kind !== \"convective\") w[k] = b.surfaceTemperature;", "      if (b.kind !== \"convective\") w[k] = 0;", "the wall of a prescribed-temperature layer"],
  [AF, "        w[k] = (gHalf * Tl + gFilm * b.bulkTemperature) / (gHalf + gFilm);", "        w[k] = (gFilm * Tl + gHalf * b.bulkTemperature) / (gHalf + gFilm);", "the wall weights swapped"],
  [AF, "  const outOf = (T: Float64Array, sides: Side[]) => Float64Array.from(sides, (s, k) => h * s.gOut * (T[k * n + n - 1]! - s.cool));", "  const outOf = (T: Float64Array, sides: Side[]) => Float64Array.from(sides, (s, k) => s.gOut * (T[k * n + n - 1]! - s.cool));", "heat out without the layer height"],
  [AF, "    for (let id = 0; id < rows; id++) e += h * vol[id % n]! * (enthalpyOf(p, id % n < nf, T[id]!) - enthalpyOf(p, id % n < nf, T0[id]!));\n    return e;\n  };\n  /** The heat flowing", "    for (let id = 0; id < rows; id++) e += vol[id % n]! * (enthalpyOf(p, id % n < nf, T[id]!) - enthalpyOf(p, id % n < nf, T0[id]!));\n    return e;\n  };\n  /** The heat flowing", "stored energy without the layer height"],
  [AF, "    if (coupled)\n      for (let k = 0; k < N - 1; k++)", "    if (true)\n      for (let k = 0; k < N - 1; k++)", "heat along the height reported with the conduction off"],
  [AF, "          f[k]! += ((2 * ka * kb) / (ka + kb)) * (vol[i]! / h) * (T[k * n + i]! - T[(k + 1) * n + i]!);", "          f[k]! += ((2 * ka * kb) / (ka + kb)) * (vol[i]! / h) * (T[(k + 1) * n + i]! - T[k * n + i]!);", "heat along the height with the wrong sign"],
  [AF, "    for (let id = 0; id < rows; id++) e[Math.floor(id / n)]! += ", "    for (let id = 0; id < rows; id++) e[id % N]! += ", "stored energy of a layer attributed to the wrong layer"],
  [AF, "  const made = Float64Array.from(qs, (q) => s.h * q);", "  const made = Float64Array.from(qs, (q) => q);", "heat made without the layer height"],
  [AF, "  const start = new Float64Array(s.rows).fill(coolantOf(bs[0]!));", "  const start = new Float64Array(s.rows).fill(1);", "steady iteration started from 1 K"],
  [AF, "  for (let id = 0; id < s.rows; id++) if (!(s.kOf(id % s.n, T[id]!) > 0)) throw", "  for (let id = 0; id < s.rows; id++) if (false) throw", "a conductivity that is not positive accepted"],
  [AF, "  if (!qs.every((q) => Number.isFinite(q))) throw", "  if (false) throw", "a heat rate that is not finite accepted"],
  // ---- the transient
  [AF, "    const t1 = step * o.dt;\n    const qs = Array.from({ length: N }, (_, k) => m.power(k, t1));", "    const t1 = (step - 1) * o.dt;\n    const qs = Array.from({ length: N }, (_, k) => m.power(k, t1));", "power and coolant at the start of the step"],
  [AF, "      layerAxialIn[k]! += o.dt * ((k > 0 ? flux[k - 1]! : 0) - (k < N - 1 ? flux[k]! : 0));", "      layerAxialIn[k]! += o.dt * ((k > 0 ? flux[k - 1]! : 0) + (k < N - 1 ? flux[k]! : 0));", "heat received from the neighbours: signs"],
  [AF, "      layerRejected[k]! += o.dt * out[k]!;", "      layerRejected[k]! += o.dt * out[0]!;", "heat rejected by a layer is the first layer's"],
  [AF, "    deposited += o.dt * s.h * qs.reduce((x, y) => x + y, 0);", "    deposited += o.dt * qs.reduce((x, y) => x + y, 0);", "deposited energy without the layer height"],
  [AF, "    if (step % o.outputEvery === 0) states.push(", "    if (step % o.outputEvery === 1) states.push(", "outputs at the wrong steps"],
  [AF, "    if (o.deadlineMs !== undefined && Date.now() - started > o.deadlineMs) throw", "    if (o.deadlineMs !== undefined && Date.now() - started < o.deadlineMs) throw", "the deadline inverted"],
  [AF, "      tr.peakByStep.push(Math.max(fuelHot, cladHot));", "      tr.peakByStep.push(fuelHot);", "the trace's hottest cell is the fuel's"],
  [AF, "      tr.peakByStep.push(Math.max(fuelHot, cladHot));", "      tr.peakByStep.push(cladHot);", "the trace's hottest cell is the cladding's"],
  [AF, "          if (x > tr.claddingMax) tr.claddingMax = x;", "          if (x > tr.claddingMax) tr.claddingMax = tr.claddingMax;", "the cladding's maximum never recorded"],
  [AF, "          if (x < tr.fuelMin) tr.fuelMin = x;", "          if (x < tr.fuelMin) tr.fuelMin = tr.fuelMin;", "the fuel's minimum never recorded"],
  [AF, "  record(T);\n  const started", "  const started", "the start not in the trace"],
  [AF, "  if (o.initial.length !== s.rows ||", "  if (false ||", "a start field of the wrong size accepted"],
  [AF, "|| !Number.isInteger(o.steps) || o.steps < 1 ||", "|| o.steps < 1 ||", "a fractional number of steps accepted"],
  // ---- the reference of a stack
  [SRF, "  const cap = (h: NormalizedCase[\"fuelHeatCapacity\"]) => (h ? heatCapacityLaw(h) : [1]);", "  const cap = (h: NormalizedCase[\"fuelHeatCapacity\"]) => [1];", "the heat capacities never read"],
  [SRF, "    fuelLaw: lawOf(c.fuelConductivity),", "    fuelLaw: lawOf(c.claddingConductivity),", "the fuel with the cladding's conductivity"],
  [SRF, "    power: (k, t) => (tr ? history(t) * loads[k]!.factor : loads[k]!.linearHeatRate),", "    power: (k, t) => (tr ? history(t) : loads[k]!.linearHeatRate),", "the transient power without the layer's factor"],
  [SRF, "    boundary: (k, t) => (hist ? boundaryAtTime(hist, t) : loads[k]!.boundary),", "    boundary: (k, t) => loads[k]!.boundary,", "the boundary history ignored"],
  [SRF, "    if (t <= times[0]!) return linearHeatRate[0]!;", "    if (t <= times[0]!) return 0;", "the power before the first time point"],
  [SRF, "    return linearHeatRate[linearHeatRate.length - 1]!;\n  };", "    return 0;\n  };", "the power after the last time point"],
  [SRF, "        return { fuel: cells.slice(0, nf), clad: cells.slice(nf), wall: solution.wall[k]! };", "        return { fuel: cells.slice(0, nf), clad: cells.slice(nf), wall: solution.wall[0]! };", "every slice's wall is the first layer's"],
  [SRF, "        const cells = Array.from(solution.T.subarray(k * solution.n, (k + 1) * solution.n));", "        const cells = Array.from(solution.T.subarray(0, solution.n));", "every slice's cells are the first layer's"],
  [SRF, "  loads.forEach((l, k) => out.set(initialState(sliceCase(c, l)).T, k * n));", "  loads.forEach((l, k) => out.set(initialState(sliceCase(c, l)).T, 0));", "the start field of every layer is written over the first"],
  [SRF, "  return solveStackSteady({ ...model, power: (k) => q0 * loads[k]!.factor });", "  return solveStackSteady({ ...model, power: (k) => q0 });", "the coupled steady start without the shape"],
  [SRF, "  if (a.slices * n * t.steps > STACK_TRANSIENT_WORK_MAX) return", "  if (a.slices * n * t.steps < STACK_TRANSIENT_WORK_MAX) return", "the work cap inverted"],
  [SRF, "  if (a.slices * n * t.steps > STACK_TRANSIENT_WORK_MAX) return", "  if (false) return", "no work cap"],
  [SRF, "      received: (k) => solution.states.map((s) => s.layerAxialIn[k]! / height),", "      received: (k) => solution.states.map((s) => s.layerAxialIn[k]!),", "the heat received not per unit height"],
  [SRF, "      received: (k) => solution.states.map((s) => s.layerAxialIn[k]! / height),", "      received: (k) => solution.states.map((s) => s.layerAxialIn[0]! / height),", "the heat received is the first layer's"],
  [SRF, "          states: solution.states.map((s, j) => ({ time: s.time, T: cells(j), deposited: s.layerDeposited[k]!, rejected: s.layerRejected[k]!, wall: s.wall[k]! })),", "          states: solution.states.map((s, j) => ({ time: s.time, T: cells(j), deposited: s.layerDeposited[k]!, rejected: s.layerRejected[k]!, wall: s.wall[0]! })),", "the transient's wall is the first layer's"],
  [SRF, "          trace: solution.traces![k]!,", "          trace: solution.traces![0]!,", "the trace of the first layer for every slice"],
  [SRF, "            const T = s.T.map((x, i) => x + (i < 2 * nf ? dT[Math.floor(i / 2)]! : dT[nf + Math.floor((i - 2 * nf) / 2)]!));", "            const T = s.T.map((x, i) => x);", "the doubled mesh's error estimate not carried over"],
  [SRF, "            return { ...s, T: s.T.map((x, i) => x + dT[i]!), wall: s.wall + dw };", "            return { ...s, T: s.T.map((x, i) => x), wall: s.wall };", "the half step's error estimate not carried over"],
  [SRF, "            peakByStep: own.fvh.trace!.peakByStep.map((x, m) => x + (fv.trace!.peakByStep[Math.floor(m / 2)]! - own.fv.trace!.peakByStep[Math.floor(m / 2)]!)),", "            peakByStep: own.fvh.trace!.peakByStep.map((x) => x),", "the half step's peak error estimate not carried over"],
  [SRF, "      const coupled = coupledSteadyStart(c);\n      startDistance = Math.max(", "      const coupled = coupledSteadyStart(c);\n      startDistance = 0 * Math.max(", "the start distance not reported"],
  // ---- the checks against the reference (steady)
  [RP, "    const fuelRefBound = (5 * fuelDeltaT) / (c.mesh.fuelCells * c.mesh.fuelCells) + REFERENCE_FLOOR;", "    const fuelRefBound = (5 * fuelDeltaT) / (c.mesh.fuelCells * c.mesh.fuelCells) + 1e9;", "the fuel bound unlimited"],
  [RP, "    const cladRefBound = (5 * claddingDeltaT) / (c.mesh.claddingCells * c.mesh.claddingCells) + REFERENCE_FLOOR;", "    const cladRefBound = (5 * claddingDeltaT) / (c.mesh.claddingCells * c.mesh.claddingCells) + 1e9;", "the cladding bound unlimited"],
  [RP, "    const fuelDev = Math.max(...fuel.map((p, i) => Math.abs(p.T - ref.fuel[i]!)));", "    const fuelDev = Math.max(...fuel.map((p, i) => Math.abs(p.T - ref.fuel[0]!)));", "every fuel cell against the first reference cell"],
  [RP, "    const cladDev = Math.max(...clad.map((p, i) => Math.abs(p.T - ref.clad[i]!)));", "    const cladDev = 0;", "the cladding not compared"],
  [RP, "      const d = Math.abs(wall - ref.wall);\n      checks.push({ id: \"wallTemperature\", label: \"Outer wall temperature vs the two-dimensional reference\", value: d, unit: \"K\", verdict: d < 0.05 ? \"pass\" : \"fail\"", "      const d = Math.abs(wall - tOuter);\n      checks.push({ id: \"wallTemperature\", label: \"Outer wall temperature vs the two-dimensional reference\", value: d, unit: \"K\", verdict: d < 0.05 ? \"pass\" : \"fail\"", "the wall against the one-dimensional closed form"],
  [RP, "      const d = Math.abs(wall - ref.wall);\n      checks.push({ id: \"wallTemperature\", label: \"Outer wall temperature vs the two-dimensional reference\", value: d, unit: \"K\", verdict: d < 0.05 ? \"pass\" : \"fail\"", "      const d = Math.abs(wall - ref.wall);\n      checks.push({ id: \"wallTemperature\", label: \"Outer wall temperature vs the two-dimensional reference\", value: d, unit: \"K\", verdict: d < 50 ? \"pass\" : \"fail\"", "the wall threshold 50 K"],
  [RP, "      const bound = BALANCE_TOLERANCE * Math.abs(qRef) + 1e-9;", "      const bound = BALANCE_TOLERANCE * Math.abs(qRef) + 1e9;", "the layer energy balance unlimited"],
  [RP, "      const qRef = wallFlux(c, clad.map((p, i) => ({ r: p.r, T: x.reference!.clad[i]! })))!;", "      const qRef = c.qPrime;", "the layer balance against the layer's own heat (the one-dimensional reading)"],
  [RP, "  return (primitive(lawOf(c.claddingConductivity), clad[0]!.T) - primitive(lawOf(c.claddingConductivity), clad[1]!.T)) / geometryOf(c.plate).resist(clad[0]!.r, clad[1]!.r, 1);", "  return (primitive(lawOf(c.claddingConductivity), clad[0]!.T) - primitive(lawOf(c.claddingConductivity), clad[1]!.T)) / geometryOf(undefined).resist(clad[0]!.r, clad[1]!.r, 1);", "the wall flux with a pin's resistance"],
  [RP, "export const REFERENCE_FLOOR = 0.01;", "export const REFERENCE_FLOOR = 100;", "the floor under the mesh bound 100 K"],
  [SR, "  const choice = reference === undefined ? (c.plate ? stackReference(c) : null) : reference;", "  const choice = reference === undefined ? stackReference(c) : reference;", "a pin judged against the reference"],
  [SR, "  const choice = reference === undefined ? (c.plate ? stackReference(c) : null) : reference;", "  const choice = reference === undefined ? null : reference;", "a plate not judged against the reference by default"],
  [SR, "  const allow: SliceAllowance = ref ? { field: 0, flux: 0, wall: 0 } : estimate;", "  const allow: SliceAllowance = estimate;", "the allowance added to the reference's tolerances"],
  [SR, "    const out = ref ? perSlice.reduce((x, s) => x + s.flux!, 0) :", "    const out = ref ? sumQ :", "the whole-plate balance of the reference record is the heat given"],
  [SR, "        if (!(Math.abs(p.r - ref.solution.r[i]!) <= 1e-3 * dx + 1e-9)) bad(", "        if (false) bad(", "cells not where the mesh puts them accepted"],
  [SR, "        deviation = Math.max(deviation, Math.abs(p.T - (i < nf ? sliceRef!.fuel[i]! : sliceRef!.clad[i - nf]!)));", "        deviation = 0;", "the deviation from the reference not recorded"],
  [SR, "        at.forEach((p, i) => (oneDimensionalDeviation = Math.max(oneDimensionalDeviation, Math.abs(p.T - (i < nf ? one.fuel[i]! : one.clad[i - nf]!)))));", "        at.forEach((p, i) => (oneDimensionalDeviation = 0));", "the one-dimensional contrast not recorded"],
  [SR, "  if (ref && decoupled && \"reference\" in decoupled) axialEffect = Math.max(...Array.from(ref.solution.T, (x, i) => Math.abs(x - decoupled.reference.solution.T[i]!)));", "  if (ref && decoupled && \"reference\" in decoupled) axialEffect = 0;", "the axial effect not reported"],
  [SR, "    thermalOnly: THERMAL_ONLY_TEXT + \" \" + stackText(c, ref !== undefined),", "    thermalOnly: THERMAL_ONLY_TEXT + \" \" + stackText(c, false),", "the banner of a reference record names the allowance"],
  [SR, "export const stackText = (c: NormalizedCase, twoDimensional = false): string => (c.plate ? (twoDimensional ? STACK_TEXT_PLATE_2D : STACK_TEXT_PLATE) : STACK_TEXT);", "export const stackText = (c: NormalizedCase, twoDimensional = false): string => (c.plate ? (twoDimensional ? STACK_TEXT_PLATE : STACK_TEXT_PLATE) : STACK_TEXT);", "the reference banner text is the allowance's"],
  // ---- the checks against the reference (transient)
  [ST, "  const choice = reference === undefined ? (c.plate ? stackTransientReference(c) : null) : reference;", "  const choice = reference === undefined ? stackTransientReference(c) : reference;", "a pin judged against the transient reference"],
  [ST, "  const choice = reference === undefined ? (c.plate ? stackTransientReference(c) : null) : reference;", "  const choice = reference === undefined ? null : reference;", "a plate not judged against the transient reference by default"],
  [ST, "    const allow: TransientAllowance = ref ? { field: 0, energy: 0 } :", "    const allow: TransientAllowance = false ? { field: 0, energy: 0 } :", "the allowance added to the reference's tolerances"],
  [ST, "ref.sliceIndependent(k, solutions[k]!), allow, ref.received(k))", "ref.sliceIndependent(k, solutions[k]!), allow)", "the heat received from the neighbours not counted"],
  [ST, "ref.sliceIndependent(k, solutions[k]!), allow, ref.received(k))", "solutions[k]!, allow, ref.received(k))", "the one-dimensional solution as the reference with the reference's balance"],
  [ST, "          deviation = Math.max(deviation, Math.abs(x - two.states[j]!.T[i]!));", "          deviation = 0;", "the transient deviation not recorded"],
  [ST, "          oneDimensionalDeviation = Math.max(oneDimensionalDeviation, Math.abs(x - own.states[j]!.T[i]!));", "          oneDimensionalDeviation = 0;", "the transient one-dimensional contrast not recorded"],
  [TR, "  const made = exchanged ? series.deposited.map((d, j) => d + exchanged[j]!) : series.deposited;", "  const made = series.deposited;", "the energy balance without the heat received"],
  [TR, "  const made = exchanged ? series.deposited.map((d, j) => d + exchanged[j]!) : series.deposited;", "  const made = exchanged ? series.deposited.map((d, j) => d - exchanged[j]!) : series.deposited;", "the heat received subtracted"],
  [TR, "Math.max(series.deposited[j]!, Math.abs(exchanged?.[j] ?? 0), series.rejected[j]!, Math.abs(series.stored[j]!))", "Math.max(series.deposited[j]!, series.rejected[j]!, Math.abs(series.stored[j]!))", "the heat received not in the energy the gap is judged against"],
  [TR, "  if (exchanged && exchanged.length !== times.length) bad(", "  if (false) bad(", "heat received of the wrong length accepted"],
];

function run(files) {
  const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...files], { cwd: root, encoding: "utf8", timeout: 900000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out) || /Tests\s+(\d+) failed/.exec(out);
  return { code: r.status, summary: m ? m[0] : null, out };
}

const only = process.argv[2] ? new Set(process.argv[2].split(",").map(Number)) : undefined;
if (process.env.ANCHORS_ONLY) {
  mutants.forEach(([file, from], i) => {
    const count = fs.readFileSync(path.join(root, file), "utf8").split(from).length - 1;
    if (count !== 1) console.log("ANCHOR " + count + "  #" + i + " " + mutants[i][3]);
  });
  console.log("checked " + mutants.length + " anchors");
  process.exit(0);
}
const base1 = run(FAST);
const base2 = run(SLOW);
console.log("baseline: fast exit " + base1.code + ", " + base1.summary + "; slow exit " + base2.code + ", " + base2.summary);
if (base1.code !== 0 || !base1.summary || base2.code !== 0 || !base2.summary) {
  console.log("ABORT: the baseline is not green");
  process.exit(2);
}
const rows = [];
mutants.forEach(([file, from, to, name], i) => {
  if (only && !only.has(i)) return;
  const p = path.join(root, file);
  const original = fs.readFileSync(p, "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) {
    rows.push([i, name, "ANCHOR " + count, ""]);
    console.log("ANCHOR " + count + "  #" + i + " " + name);
    return;
  }
  try {
    fs.writeFileSync(p, original.replace(from, () => to), "utf8");
    let r = run(FAST);
    let tier = "fast";
    if (r.summary && r.code === 0) {
      r = run(SLOW);
      tier = "slow";
    }
    const verdict = !r.summary ? "BROKEN" : r.code === 0 ? "SURVIVED" : "killed";
    rows.push([i, name, verdict, r.summary || ""]);
    console.log(verdict.padEnd(9) + "#" + i + " " + name + "   [" + tier + ": " + (r.summary || "no summary") + "]");
  } finally {
    fs.writeFileSync(p, original, "utf8");
  }
});
const n = (v) => rows.filter((r) => r[2] === v).length;
console.log("\nkilled " + n("killed") + ", survived " + n("SURVIVED") + ", broken " + n("BROKEN") + ", anchor problems " + rows.filter((r) => String(r[2]).startsWith("ANCHOR")).length + " of " + rows.length);
for (const r of rows) if (r[2] !== "killed") console.log("  " + r[2] + " #" + r[0] + " " + r[1] + " " + r[3]);
