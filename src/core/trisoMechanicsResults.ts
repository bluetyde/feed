// Reading a particle's mechanics back from OFFBEAT's output (plan 14, stage E, M2) and checking it against the independent layered-sphere solution (src/core/layeredSphere.ts,
// src/core/trisoMechanics.ts). Pure functions on text; no solver, no files. Damaged, inconsistent or non-finite output is REFUSED (ResultsError), never turned into a partial result.
//
// The tolerances are fixed here, before the first golden run, from the probe (docs/spike/triso-mechanics-probe.md: a finite-volume cell value with 8 to 16 cells per layer is within
// 0.03 % of a layer's peak in the tangential stress and 0.2 % in the radial one) and the plan's list (docs/plans/14-triso-mechanics.md, "Verification"):
//   - stress, tangential and radial, every cell against the independent solution at the cell's own radius: 1 % of the layer's stress scale + 10 kPa (the probe: 0.002 to 0.03 %
//     and 0.03 to 0.16 %; the plan's 1 %); the scale is the larger of the layer's largest independent stress component and 1 % of E alpha max|T - Tref| (the pin's rule), and a WEDGE
//     ALLOWANCE is added: OFFBEAT's tangential strain on a wedge differs from u / r by about half the square of the half angle times the total strain (found in M2: 5e-7 of a
//     thermal strain of 3.4e-3 at a half angle of 1 degree), so a thermal or free strain that is large against the elastic one moves the stress by about
//     a^2 E / (1 - nu) x the largest of those strains (twice the measured size).
//   - displacement: 0.5 % of the layer's largest |u| + 1e-10 m (the plan's 0.5 %; the probe 0.01 %).
//   - radial balance of OFFBEAT's own stress between neighbouring cells of one layer: the residual times the LAYER'S THICKNESS, 2 % of the scale + 10 kPa. (First written with the
//     cell spacing, the pin's rule; the negative test found that too weak, a tangential stress removed altogether passed, and it was changed before any golden was kept.)
//   - interface: the radial stress and the displacement of the two layers beside an interface, each extrapolated linearly from its two nearest cells, agree within 2 % of the scale
//     + 10 kPa and 0.5 % of the displacement.
//   - the two tangential components of the stress agree within 1e-6 of the scale + 1 Pa (a sphere has one); the temperature is the one written (0.01 K); the stated free strain is the
//     one OFFBEAT applied (1e-9).
// A result that misses a tolerance fails its check; nothing is relaxed to make it pass.

import type { SphereOptions } from "./layeredSphere";
import { assertWholeFoamFile, Check, parseScalarField, parseVectorField, ResultsError } from "./resultsParser";
import type { NormalizedTriso } from "./triso";
import { parseCellZones } from "./trisoResults";
import { trisoClosedForm } from "./trisoSolve";
import { trisoCellCentre, trisoLayeredSphere, trisoMechanicsConstants } from "./trisoMechanics";
import { TRISO_MECH_WEDGE_HALF, TRISO_MECH_WEDGE_SCALE, trisoMechanicsCells, trisoMechanicsTemperatures } from "./trisoMechanicsWriter";
import { TRISO_ZONE } from "./trisoWriter";

const bad = (message: string): never => {
  throw new ResultsError("E_OUTPUT_INCOMPLETE", message);
};

export const TRISO_MECH_TOLERANCE = {
  stress: { fraction: 0.01, floor: 1e4, thermalFraction: 0.01, wedgeAllowance: 1.0 },
  displacement: { fraction: 0.005, floor: 1e-10 },
  equilibrium: { fraction: 0.02, floor: 1e4 },
  interface: { stressFraction: 0.02, floor: 1e4, displacementFraction: 0.005 },
  symmetry: { fraction: 1e-6, floor: 1 },
  temperature: 0.01,
  freeStrain: 1e-9,
  /** Cell centres within this (relative) of where the case's mesh puts them. */
  centre: 1e-3,
};

export const TRISO_MECHANICS_TEXT =
  "Elastic, steady: free strains are inputs, not an irradiation result. Stress and displacement of the coating layers (inner carbon, SiC, outer carbon) from the gas pressure and the outside pressure the case states, the thermal strain from FEED's own temperatures and the free strains the case states. It has no swelling or creep computed from a fluence, no fission-gas or CO inventory, no contact with the buffer, no kernel and no failure criterion. It does not say that the particle survives or fails.";

export interface TrisoMechanicsCell {
  /** metres: the length of the cell-centre vector (the radius on the sphere the wedge solves) */
  r: number;
  layer: string;
  T: number;
  /** OFFBEAT's stress, Pa (tension positive): radial, tangential (yy), tangential (zz). */
  sigmaR: number;
  sigmaT: number;
  sigmaTz: number;
  /** OFFBEAT's radial displacement at the cell centre, m (on the wedge's sphere). */
  ur: number;
  /** The independent solution at the same cell (stress, and the displacement on the wedge's sphere). */
  ind: { sigmaR: number; sigmaT: number; ur: number };
}

export interface TrisoMechanicsLayerResult {
  name: string;
  innerRadius: number;
  outerRadius: number;
  E: number;
  nu: number;
  alpha: number;
  meanTemperature: number;
  /** The largest and smallest tangential stress among the layer's cells (OFFBEAT), Pa. */
  sigmaTMax: number;
  sigmaTMin: number;
  sigmaRMax: number;
  sigmaRMin: number;
  freeStrain?: { radial: number; tangential: number; source: string };
}

export interface TrisoMechanicsResultsRecord {
  schema: "feed.results/0.1";
  kind: "triso-mechanics";
  caseId: string;
  time: number;
  referenceTemperature: number;
  gasPressure: number;
  outsidePressure: number;
  cells: TrisoMechanicsCell[];
  layers: TrisoMechanicsLayerResult[];
  summary: {
    /** The SiC's largest tangential stress (OFFBEAT's cell value), Pa, when the particle has a SiC layer; positive is tension. */
    sicPeakTangential: number | null;
    /** The radial stress at each interface (extrapolated from the cells either side and averaged), Pa, from the inside outward, and the gas pressure's -sigma_r on the inner face is the case's. */
    interfaceRadialStress: number[];
  };
  checks: Check[];
  domain: { verdict: "in-domain" | "out-of-domain"; findings: { layer: string; what: string }[] };
  text: string;
}

export interface TrisoMechanicsInput {
  T: string;
  C: string;
  D: string;
  sigma: string;
  /** OFFBEAT's epsilonSwelling field, when it was collected (a free strain is then checked against it). */
  epsilonSwelling?: string;
  cellZones: string;
  time: number;
  /** Hooks for the NEGATIVE tests of plan 14 only (a check must fail when the comparison is made wrongly); never set by the case code. */
  hook?: {
    /** Read the independent solution at each cell's inner face instead of its centre (a stress read at a face). */
    evaluateAt?: "inner-face";
    /** Options of the independent solution (leave out the anisotropic term). */
    sphere?: SphereOptions;
  };
}

/** A list field of a vector or symmetric tensor: `internalField nonuniform List<type> N ( (a b c ...) ... )` or a uniform value, `width` numbers per cell. */
function parseListField(text: string, name: string, width: number, cells: number): number[][] {
  assertWholeFoamFile(text, name);
  const un = /internalField\s+uniform\s+\(([^)]*)\)/.exec(text);
  if (un) {
    const row = un[1]!.trim().split(/\s+/).map(Number);
    if (row.length !== width || !row.every(Number.isFinite)) bad(`field ${name}: the uniform value is not ${width} finite numbers`);
    return Array.from({ length: cells }, () => row);
  }
  const m = /internalField\s+nonuniform\s+List<[a-zA-Z]+>\s*(\d+)\s*\(/.exec(text);
  if (!m) return bad(`field ${name}: no internalField found`);
  const n = Number(m[1]);
  const body = text.slice(m.index + m[0].length);
  const end = body.indexOf("\n)");
  if (end < 0) return bad(`field ${name}: list is not closed (truncated file?)`);
  const rows = [...body.slice(0, end).matchAll(/\(([^()]*)\)/g)].map((r) => r[1]!.trim().split(/\s+/).map(Number));
  if (rows.length !== n) bad(`field ${name}: header says ${n} entries, found ${rows.length}`);
  if (n !== cells) bad(`field ${name} has ${n} cells, the case has ${cells}`);
  rows.forEach((r, i) => {
    if (r.length !== width || !r.every(Number.isFinite)) bad(`field ${name}: entry ${i} is not ${width} finite numbers`);
  });
  return rows;
}

const XX = 0;
const YY = 3;
const ZZ = 5;

/** The independent solution's values for every cell, as the checks and the record use them (on the wedge's sphere: the stress is the same, the displacement scales). */
function independentAt(n: NormalizedTriso, rWedge: number, sol: ReturnType<typeof trisoLayeredSphere>, layer: number): { sigmaR: number; sigmaT: number; ur: number } {
  const p = sol.at(rWedge / TRISO_MECH_WEDGE_SCALE, layer);
  return { sigmaR: p.sigmaR, sigmaT: p.sigmaT, ur: TRISO_MECH_WEDGE_SCALE * p.u };
}

/** Linear extrapolation to x of the line through (x0, y0) and (x1, y1). */
const extrapolate = (x0: number, y0: number, x1: number, y1: number, x: number): number => y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);

export function buildTrisoMechanicsResults(n: NormalizedTriso, input: TrisoMechanicsInput): TrisoMechanicsResultsRecord {
  const m = n.mechanics;
  if (!m) throw new Error("this particle has no mechanics section");
  const tol = TRISO_MECH_TOLERANCE;
  const ks = trisoMechanicsConstants(n);
  const layerIndex = new Map(ks.map((k, i) => [k.name as string, i]));
  const total = trisoMechanicsCells(n).length;
  const T = parseScalarField(input.T, "T");
  const C = parseVectorField(input.C, "C");
  const D = parseListField(input.D, "D", 3, total);
  const S = parseListField(input.sigma, "sigma", 6, total);
  if (T.length !== total) bad(`expected ${total} cells (${ks.map((k) => n.cells[n.layers.findIndex((l) => l.name === k.name) + 1] + " " + k.name).join(" + ")}), found ${T.length}`);
  if (C.length !== total) bad(`T has ${T.length} cells but C has ${C.length}`);
  if (!(input.time > 0) || !Number.isFinite(input.time)) bad("final time is not a positive finite number");
  assertWholeFoamFile(input.T, "T");
  assertWholeFoamFile(input.C, "C");
  for (const [name, rows] of [["sigma", S], ["D", D]] as const) rows.forEach((r, i) => r.forEach((v) => !Number.isFinite(v) && bad(`field ${name}: cell ${i} is not finite`)));
  T.forEach((t, i) => !(t > 0) && bad(`cell ${i}: temperature ${t} K is not above 0 K`));

  // the zones: exactly the mechanical layers' zones, each covering its cells once
  const zones = parseCellZones(input.cellZones);
  const wanted = ks.map((k) => TRISO_ZONE[k.name]);
  for (const z of zones.keys()) if (!wanted.includes(z)) bad(`cellZones: zone ${z} is not a layer of this mechanics mesh (${wanted.join(", ")})`);
  const layerOf = new Array<number>(total).fill(-1);
  ks.forEach((k, li) => {
    const labels = zones.get(TRISO_ZONE[k.name]);
    if (!labels) return bad(`cellZones: zone ${TRISO_ZONE[k.name]} is missing`);
    const want = n.cells[n.layers.findIndex((l) => l.name === k.name) + 1]!;
    if (labels.length !== want) bad(`cellZones: zone ${TRISO_ZONE[k.name]} has ${labels.length} cells, the case has ${want} ${k.name} cells`);
    for (const l of labels) {
      if (l >= total) bad(`cellZones: zone ${TRISO_ZONE[k.name]} names cell ${l}, but there are ${total} cells`);
      if (layerOf[l] !== -1) bad(`cellZones: cell ${l} is in two zones`);
      layerOf[l] = li;
    }
  });
  // every cell's centre is where the case's mesh puts it (the volume centroid of its shell, on the wedge's sphere)
  const expected = trisoMechanicsCells(n);
  const radius = C.map((p) => Math.hypot(p[0]!, p[1]!, p[2]!));
  const order = radius.map((_, i) => i).sort((a, b) => radius[a]! - radius[b]!);
  order.forEach((cell, rank) => {
    const e = expected[rank]!;
    const want = TRISO_MECH_WEDGE_SCALE * trisoCellCentre(e.a, e.b);
    if (Math.abs(radius[cell]! / want - 1) > tol.centre) bad(`cell ${cell} has its centre at ${radius[cell]} m but the case's mesh puts the ${rank + 1}th cell from the inside at ${want} m: this output is not the mesh the case would give`);
    if (layerOf[cell] !== layerIndex.get(e.layer)) bad(`cell ${cell} is in the zone of another layer than the case's mesh gives it (${e.layer})`);
  });

  const cf = trisoClosedForm(n);
  const sol = trisoLayeredSphere(n, ks, input.hook?.sphere ?? {}, cf);
  const Tref = m.referenceTemperature;
  const cellsAll: TrisoMechanicsCell[] = order.map((cell, rank) => {
    const li = layerOf[cell]!;
    const r = radius[cell]!;
    const rEval = input.hook?.evaluateAt === "inner-face" ? TRISO_MECH_WEDGE_SCALE * expected[rank]!.a : r;
    const ur = (D[cell]![0]! * C[cell]![0]! + D[cell]![1]! * C[cell]![1]! + D[cell]![2]! * C[cell]![2]!) / r;
    return { r, layer: ks[li]!.name, T: T[cell]!, sigmaR: S[cell]![XX]!, sigmaT: S[cell]![YY]!, sigmaTz: S[cell]![ZZ]!, ur, ind: independentAt(n, rEval, sol, li) };
  });
  const checks: Check[] = [];
  const a2 = TRISO_MECH_WEDGE_HALF ** 2;
  const perLayer = ks.map((k, li) => {
    const cells = cellsAll.filter((c) => c.layer === k.name);
    const stressMax = Math.max(...cells.flatMap((c) => [Math.abs(c.ind.sigmaR), Math.abs(c.ind.sigmaT)]));
    const dTmax = Math.max(...cells.map((c) => Math.abs(c.T - Tref)));
    const strainMax = Math.max(k.alpha * dTmax, Math.abs(k.freeStrain?.radial ?? 0), Math.abs(k.freeStrain?.tangential ?? 0));
    const scale = Math.max(stressMax, tol.stress.thermalFraction * k.E * k.alpha * dTmax);
    const allowance = tol.stress.wedgeAllowance * a2 * (k.E / (1 - k.nu)) * strainMax;
    const uMax = Math.max(...cells.map((c) => Math.abs(c.ind.ur)));
    return { k, li, cells, scale, allowance, uMax, sTol: tol.stress.fraction * scale + tol.stress.floor + allowance, uTol: tol.displacement.fraction * uMax + tol.displacement.floor };
  });

  // --- temperatures: the field the solver was given and kept
  {
    const want = trisoMechanicsTemperatures(n);
    let worst = 0;
    order.forEach((cell, rank) => (worst = Math.max(worst, Math.abs(T[cell]! - want[rank]!))));
    checks.push({ id: "mechanicsTemperature", label: "Temperature field kept (vs FEED's closed form)", value: worst, unit: "K", verdict: worst <= tol.temperature ? "pass" : "fail", note: `every cell's temperature against the closed form of the particle at the cell's centroid (the solver is told to keep the field; it writes 8 digits); bound ${tol.temperature} K` });
  }
  // --- stress and displacement against the independent solution, layer by layer
  {
    let worstT = 0;
    let worstR = 0;
    let worstU = 0;
    let pass = true;
    let uPass = true;
    let where = "";
    for (const p of perLayer) {
      for (const c of p.cells) {
        const dt = Math.abs(c.sigmaT - c.ind.sigmaT);
        const dr = Math.abs(c.sigmaR - c.ind.sigmaR);
        const du = Math.abs(c.ur - c.ind.ur);
        if (dt > p.sTol || dr > p.sTol) {
          pass = false;
          where = where || `${p.k.name} cell at ${(c.r * 1e6).toFixed(2)} um: tangential ${(c.sigmaT / 1e6).toFixed(3)} MPa against ${(c.ind.sigmaT / 1e6).toFixed(3)} MPa, radial ${(c.sigmaR / 1e6).toFixed(3)} MPa against ${(c.ind.sigmaR / 1e6).toFixed(3)} MPa, bound ${(p.sTol / 1e6).toFixed(3)} MPa`;
        }
        if (du > p.uTol) uPass = false;
        worstT = Math.max(worstT, dt);
        worstR = Math.max(worstR, dr);
        worstU = Math.max(worstU, du);
      }
    }
    const bounds = perLayer.map((p) => `${p.k.name} ${(p.sTol / 1e6).toFixed(3)} MPa`).join(", ");
    checks.push({ id: "mechanicsStress", label: "Stress vs the independent layered-sphere solution (max deviation, tangential and radial)", value: Math.max(worstT, worstR), unit: "Pa", verdict: pass ? "pass" : "fail", note: (pass ? "" : where + ". ") + `every cell, tangential and radial, against the independent solution at the cell's own radius; largest tangential deviation ${(worstT / 1e6).toFixed(4)} MPa, radial ${(worstR / 1e6).toFixed(4)} MPa; bounds 1 % of the layer's stress scale + 10 kPa + the wedge allowance: ${bounds}` });
    checks.push({ id: "mechanicsDisplacement", label: "Radial displacement vs the independent solution (max deviation)", value: worstU, unit: "m", verdict: uPass ? "pass" : "fail", note: `every cell's radial displacement against the independent solution on the wedge's sphere (the displacement scales with the radii); bound 0.5 % of the layer's largest displacement + 1e-10 m` });
  }
  // --- radial balance of OFFBEAT's own stress between neighbouring cells of a layer
  {
    let worst = 0;
    let pass = true;
    for (const p of perLayer) {
      const tolE = tol.equilibrium.fraction * p.scale + tol.equilibrium.floor + p.allowance;
      const thickness = (p.k.outerRadius - p.k.innerRadius) * TRISO_MECH_WEDGE_SCALE;
      for (let i = 0; i + 1 < p.cells.length; i++) {
        const a = p.cells[i]!;
        const b = p.cells[i + 1]!;
        const h = b.r - a.r;
        const rm = (a.r + b.r) / 2;
        const resid = Math.abs((b.sigmaR - a.sigmaR) / h + (2 * ((a.sigmaR + b.sigmaR) / 2 - (a.sigmaT + b.sigmaT) / 2)) / rm) * thickness;
        worst = Math.max(worst, resid);
        if (resid > tolE) pass = false;
      }
    }
    checks.push({ id: "mechanicsEquilibrium", label: "Radial balance of the solver's own stress (max residual x spacing)", value: worst, unit: "Pa", verdict: pass ? "pass" : "fail", note: "d(sigma_r)/dr + 2 (sigma_r - sigma_t)/r = 0 between neighbouring cells of one layer, residual times the layer's thickness (a stress); bound 2 % of the layer's stress scale + 10 kPa + the wedge allowance" });
  }
  // --- interfaces: the radial stress and the displacement are continuous
  const interfaceStress: number[] = [];
  {
    let worstS = 0;
    let worstU = 0;
    let pass = true;
    for (let i = 0; i + 1 < perLayer.length; i++) {
      const A = perLayer[i]!;
      const B = perLayer[i + 1]!;
      if (A.cells.length < 2 || B.cells.length < 2) continue;
      const face = A.k.outerRadius * TRISO_MECH_WEDGE_SCALE;
      const ea = A.cells.slice(-2);
      const eb = B.cells.slice(0, 2);
      const sA = extrapolate(ea[0]!.r, ea[0]!.sigmaR, ea[1]!.r, ea[1]!.sigmaR, face);
      const sB = extrapolate(eb[0]!.r, eb[0]!.sigmaR, eb[1]!.r, eb[1]!.sigmaR, face);
      const uA = extrapolate(ea[0]!.r, ea[0]!.ur, ea[1]!.r, ea[1]!.ur, face);
      const uB = extrapolate(eb[0]!.r, eb[0]!.ur, eb[1]!.r, eb[1]!.ur, face);
      const scale = Math.max(A.scale, B.scale);
      const sTol = tol.interface.stressFraction * scale + tol.interface.floor + Math.max(A.allowance, B.allowance);
      const uTol = tol.interface.displacementFraction * Math.max(A.uMax, B.uMax) + tol.displacement.floor;
      worstS = Math.max(worstS, Math.abs(sA - sB));
      worstU = Math.max(worstU, Math.abs(uA - uB));
      if (Math.abs(sA - sB) > sTol || Math.abs(uA - uB) > uTol) pass = false;
      interfaceStress.push((sA + sB) / 2);
    }
    checks.push({ id: "mechanicsInterface", label: "Continuity across the layer interfaces (radial stress, displacement)", value: worstS, unit: "Pa", verdict: pass ? "pass" : "fail", note: `the radial stress and the radial displacement of the two layers beside each interface, each extrapolated linearly from its two nearest cells: largest radial stress difference ${(worstS / 1e6).toFixed(4)} MPa, displacement ${(worstU * 1e9).toFixed(3)} nm; bounds 2 % of the stress scale + 10 kPa and 0.5 % of the displacement` });
  }
  // --- symmetry: yy = zz
  {
    let worst = 0;
    let pass = true;
    for (const p of perLayer) for (const c of p.cells) {
      const d = Math.abs(c.sigmaT - c.sigmaTz);
      worst = Math.max(worst, d);
      if (d > tol.symmetry.fraction * p.scale + tol.symmetry.floor) pass = false;
    }
    checks.push({ id: "mechanicsSymmetry", label: "The two tangential stresses agree (yy and zz)", value: worst, unit: "Pa", verdict: pass ? "pass" : "fail", note: "a sphere has one tangential stress; the wedge's yy and zz components must be equal; bound 1e-6 of the layer's scale + 1 Pa" });
  }
  // --- the free strain OFFBEAT applied is the one the case stated
  if (m.freeStrains.length > 0) {
    if (input.epsilonSwelling === undefined) {
      checks.push({ id: "mechanicsFreeStrain", label: "Free strain applied as stated", value: null, unit: "", verdict: "fail", note: "OFFBEAT's epsilonSwelling field was not collected, so the free strain that was applied cannot be compared with the one the case states" });
    } else {
      const eps = parseListField(input.epsilonSwelling, "epsilonSwelling", 6, total);
      let worst = 0;
      for (const cell of order) {
        const k = ks[layerOf[cell]!]!;
        const wantR = k.freeStrain?.radial ?? 0;
        const wantT = k.freeStrain?.tangential ?? 0;
        const e = eps[cell]!;
        worst = Math.max(worst, Math.abs(e[XX]! - wantR), Math.abs(e[YY]! - wantT), Math.abs(e[ZZ]! - wantT));
      }
      checks.push({ id: "mechanicsFreeStrain", label: "Free strain applied as stated (max deviation)", value: worst, unit: "", verdict: worst <= tol.freeStrain ? "pass" : "fail", note: `OFFBEAT's own swelling strain of every cell against the radial and tangential strain the case states for its layer (0 for a layer without one); bound ${tol.freeStrain}` });
    }
  }
  for (const ch of checks) if (ch.value !== null && !Number.isFinite(ch.value)) bad(`check ${ch.id} is not a finite number (${ch.value})`);

  const layers: TrisoMechanicsLayerResult[] = perLayer.map((p) => ({
    name: p.k.name,
    innerRadius: p.k.innerRadius * TRISO_MECH_WEDGE_SCALE,
    outerRadius: p.k.outerRadius * TRISO_MECH_WEDGE_SCALE,
    E: p.k.E,
    nu: p.k.nu,
    alpha: p.k.alpha,
    meanTemperature: p.k.meanTemperature,
    sigmaTMax: Math.max(...p.cells.map((c) => c.sigmaT)),
    sigmaTMin: Math.min(...p.cells.map((c) => c.sigmaT)),
    sigmaRMax: Math.max(...p.cells.map((c) => c.sigmaR)),
    sigmaRMin: Math.min(...p.cells.map((c) => c.sigmaR)),
    ...(p.k.freeStrain ? { freeStrain: { radial: p.k.freeStrain.radial, tangential: p.k.freeStrain.tangential, source: p.k.freeStrain.source } } : {}),
  }));
  const findings: { layer: string; what: string }[] = [];
  for (const k of ks) {
    if (k.elasticityOutOfRange) findings.push({ layer: k.name, what: `runs ${k.temperatureRange[0].toFixed(1)} to ${k.temperatureRange[1].toFixed(1)} K, outside the range of its Young's modulus law` });
    if (k.expansionOutOfRange) findings.push({ layer: k.name, what: `runs ${k.temperatureRange[0].toFixed(1)} to ${k.temperatureRange[1].toFixed(1)} K (and the reference temperature counts), outside the range of its expansion law` });
  }
  const sic = layers.find((l) => l.name === "sic");
  return {
    schema: "feed.results/0.1",
    kind: "triso-mechanics",
    caseId: n.caseId,
    time: input.time,
    referenceTemperature: Tref,
    gasPressure: m.gasPressure,
    outsidePressure: m.outsidePressure,
    cells: cellsAll,
    layers,
    summary: { sicPeakTangential: sic ? sic.sigmaTMax : null, interfaceRadialStress: interfaceStress },
    checks,
    domain: { verdict: findings.length === 0 ? "in-domain" : "out-of-domain", findings },
    text: TRISO_MECHANICS_TEXT,
  };
}

export const isTrisoMechanicsResults = (r: unknown): r is TrisoMechanicsResultsRecord => !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "triso-mechanics";
