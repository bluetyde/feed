// A compact or a pebble's fuelled zone (plan 13, T4; docs/compact-pebble.md): coated particles in a matrix, replaced by ONE homogeneous solid whose conductivity comes from a
// mixture law (src/core/mixture.ts), plus the two-scale step that goes back from the solid's temperature to the hottest particle.
//
// This file holds what the case's `compact` block says (parsed, in SI), the table of the effective conductivity the pin or the pebble is run with, the packing fraction's
// power arithmetic and the two-scale particle. The validator's branches that use it are `validateCompact` and `validatePebble` in validate.ts.
//
// What the homogenisation is and is not (the numbers are in docs/compact-pebble.md and tests/mixture.test.ts):
//   - the particle becomes a sphere of one conductivity (exact for its response to a uniform gradient), then Maxwell-Eucken for spheres of that conductivity in the matrix;
//   - the solid carries the heat the particles make as a uniform volumetric power (the compact's power density);
//   - the particle's own temperature is NOT in that solid: the two-scale step solves the particle (closed form of src/core/trisoSolve.ts) with the matrix at the solid's local temperature
//     behind a matrix shell sized from the packing fraction.

import { CYLINDER, Geometry, SPHERE } from "./geometry";
import { evaluate, lawOf, rangeOf } from "./conductivity";
import { equivalentParticleConductivity, MIXTURE_LAWS, MixtureLawName, mixtureConductivity } from "./mixture";
import { PACKING_MAX, PACKING_RANDOM, KERNEL_POWER_DENSITY_SANITY_MAX, TrisoLayer, TrisoLayerName, NormalizedTriso, parseTrisoGeometry, particleVolumes } from "./triso";
import { trisoClosedForm, TrisoClosedForm } from "./trisoSolve";
import type { Dimension } from "./units";
import type { Conductivity } from "./validate";

/** The law the case gets when it names none: the one that was tested against the resolved model and has the smallest error (docs/compact-pebble.md). */
export const DEFAULT_MIXTURE_LAW: MixtureLawName = "maxwell-eucken";
/** Points of the table of the effective conductivity, evenly spaced over the case's range. */
export const MIXTURE_TABLE_POINTS = 41;

/**
 * The domain over which the default law was measured against the resolved model (tests/golden/mixture/resolved.json, tests/mixture.test.ts): particle-to-matrix conductivity
 * ratio 0.05 to 3 up to a packing fraction of 0.4, and ratios 3 to 10 up to 0.2. Over it the error was at most 1.8 % (lattices and random arrangements). Beyond it, at ratios
 * above 3 and packing fractions 0.3 to 0.4, it reached 4.3 % and at 0.5 and ratios below 1 it reached 5 %. Above a ratio of 10 the resolved model itself is unresolved (its correction is 36 % at 100). Outside the domain the validator warns.
 */
export const MIXTURE_DOMAIN = { packingMax: 0.4, packingMaxHighContrast: 0.2, contrastMin: 0.05, contrastMax: 3, contrastCap: 10 } as const;
/** The largest error (relative) of the default law over the domain above, against the resolved model (the data are in the test). */
export const MIXTURE_ERROR_BOUND = 0.02;

export interface HomogenisedParticle {
  kernelRadius: number;
  kernelConductivity: Conductivity;
  layers: TrisoLayer[];
  outerRadius: number;
  /** W/m2/K at the buffer's outer radius. */
  gapConductance: number;
}

export type TwoScalePoint = "hottest" | "mean" | number;

export interface HomogenisedSpec {
  law: MixtureLawName;
  packingFraction: number;
  /** W/m3 of the compact (or of the pebble's fuelled zone). */
  powerDensity: number;
  particle: HomogenisedParticle;
  matrixConductivity: Conductivity;
  /** The temperature range the effective conductivity is tabulated over. */
  range: [number, number];
  fit: { degree: number; tolerance: number };
  /** Where the matrix temperature of the particle-scale solution is read: the hottest cell, the volume mean, or a radius (m). */
  twoScale: TwoScalePoint[];
  /** The heat of one particle, W (the power density times the particle's volume over the packing fraction), and the number of particles in a cubic metre. */
  particlePower: number;
  particlesPerM3: number;
  /** The particle-to-matrix conductivity ratio over the range: its lowest and highest values. */
  contrast: [number, number];
}

type ErrFn = (code: string, field: string, message: string, extra?: Record<string, unknown>) => void;
type QtyFn = (value: unknown, dim: Dimension, field: string) => number | undefined;
type WarnFn = (code: string, field: string, message: string, extra?: Record<string, unknown>) => void;

/** What the homogenised block needs from the validator (injected: validate.ts imports this file). */
export interface HomogenisedDeps {
  conductivity: (material: Record<string, any>, region: string, err: ErrFn, qty: QtyFn) => Conductivity | undefined;
  parseGap: (gap: Record<string, unknown>, err: ErrFn) => number | undefined;
  radius: (value: unknown, field: string, what: string) => number | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The particle's equivalent conductivity at one temperature: every layer evaluated there, the gap between the buffer and the next layer as an interface conductance. */
export function particleEquivalentK(p: HomogenisedParticle, T: number): number {
  const radii = [p.kernelRadius, ...p.layers.map((l) => l.outerRadius)];
  const k = [evaluate(lawOf(p.kernelConductivity), T), ...p.layers.map((l) => evaluate(lawOf(l.conductivity), T))];
  const gaps: (number | undefined)[] = radii.map((_, i) => (i === 1 ? p.gapConductance : undefined)); // the gap lies at the buffer's outer radius, between region 1 and region 2
  return equivalentParticleConductivity(radii, k, gaps);
}

/** The effective conductivity of the compact at temperature T (W/m/K). */
export function effectiveConductivity(s: HomogenisedSpec, T: number): number {
  return mixtureConductivity(s.law, particleEquivalentK(s.particle, T), evaluate(lawOf(s.matrixConductivity), T), s.packingFraction);
}

/** The table of the effective conductivity the solid is run with: evenly spaced over the case's range. */
export function mixtureTable(s: HomogenisedSpec, n = MIXTURE_TABLE_POINTS): { T: number; k: number }[] {
  const [lo, hi] = s.range;
  return Array.from({ length: n }, (_, i) => {
    const T = lo + ((hi - lo) * i) / (n - 1);
    return { T, k: effectiveConductivity(s, T) };
  });
}

/** The thermal.conductivity set (a table with a fit) that the validator reads for the homogenised solid, in the case's own quantity form. */
export function mixtureConductivitySet(s: HomogenisedSpec): Record<string, unknown> {
  return {
    model: "table",
    source: `derived: ${s.law} mixture of the coated particle (equivalent sphere) in the matrix at packing fraction ${s.packingFraction}, tabulated over ${s.range[0]} to ${s.range[1]} K (docs/compact-pebble.md)`,
    points: mixtureTable(s).map((p) => ({ temperature: { value: p.T, unit: "K" }, conductivity: { value: p.k, unit: "W/m/K" } })),
    fit: { degree: s.fit.degree, tolerance: { value: s.fit.tolerance, unit: "1" } },
  };
}

/** The first and last radii of the matrix shell around a particle: the particle's own radius, and the radius of the sphere that holds one particle's share of the compact's volume. */
export function cellRadius(particleOuterRadius: number, packingFraction: number): number {
  return particleOuterRadius / Math.cbrt(packingFraction);
}

export interface TwoScaleParticle {
  /** The matrix temperature the particle sees (K) and the conductivity of the matrix there. */
  matrixT: number;
  matrixConductivity: number;
  /** The matrix shell around the particle, between its outer radius and `cellRadius`: its resistance, its drop, and the film coefficient (W/m2/K at the particle's outer radius) it stands for. */
  cellRadius: number;
  shellResistance: number;
  shellDeltaT: number;
  filmCoefficient: number;
  particlePower: number;
  closed: TrisoClosedForm;
  kernelCentreT: number;
  kernelSurfaceT: number;
  particleOuterT: number;
}

/** The particle of a spec as a NormalizedTriso with a convective outside: the matrix shell is the film. Used for the closed form here and, by the gated test, for the real solver. */
export function twoScaleCase(s: HomogenisedSpec, matrixT: number, caseId = "two-scale-particle"): { n: NormalizedTriso; kMatrix: number; cellRadius: number; shellResistance: number } {
  const p = s.particle;
  const kMatrix = evaluate(lawOf(s.matrixConductivity), matrixT);
  const b = cellRadius(p.outerRadius, s.packingFraction);
  const shellResistance = SPHERE.resist(p.outerRadius, b, kMatrix);
  const h = 1 / (shellResistance * SPHERE.area(p.outerRadius));
  const vols = particleVolumes(p.kernelRadius, p.outerRadius);
  const n: NormalizedTriso = {
    caseId,
    kernelRadius: p.kernelRadius,
    kernelConductivity: p.kernelConductivity,
    layers: p.layers,
    outerRadius: p.outerRadius,
    gapConductance: p.gapConductance,
    boundary: { kind: "convective", bulkTemperature: matrixT, heatTransferCoefficient: h },
    power: { form: "particle", particlePower: s.particlePower, kernelPowerDensity: s.particlePower / vols.kernelVolume, ...vols },
    cells: [],
  };
  return { n, kMatrix, cellRadius: b, shellResistance };
}

/** The particle-scale solution for a matrix at temperature matrixT: the kernel's centre and surface and the drop across the matrix shell. */
export function twoScaleParticle(s: HomogenisedSpec, matrixT: number): TwoScaleParticle {
  const { n, kMatrix, cellRadius: b, shellResistance } = twoScaleCase(s, matrixT);
  const closed = trisoClosedForm(n);
  return {
    matrixT,
    matrixConductivity: kMatrix,
    cellRadius: b,
    shellResistance,
    shellDeltaT: s.particlePower * shellResistance,
    filmCoefficient: n.boundary.kind === "convective" ? n.boundary.heatTransferCoefficient : 0,
    particlePower: s.particlePower,
    closed,
    kernelCentreT: closed.centreT,
    kernelSurfaceT: closed.kernelSurfaceT,
    particleOuterT: closed.wallT,
  };
}

/** The parsed mixture law name, or undefined after an error. */
function parseLaw(raw: unknown, field: string, err: ErrFn, warn: WarnFn): MixtureLawName | undefined {
  if (raw === undefined) return DEFAULT_MIXTURE_LAW;
  if (typeof raw !== "string" || !(MIXTURE_LAWS as readonly string[]).includes(raw)) {
    err("E_UNSUPPORTED", field, "unknown mixture law '" + String(raw) + "'; the laws are " + MIXTURE_LAWS.join(", ") + " (" + DEFAULT_MIXTURE_LAW + " is the one tested against the resolved model, docs/compact-pebble.md)");
    return undefined;
  }
  if (raw !== DEFAULT_MIXTURE_LAW) warn("W_MIXTURE_LAW", field, "the mixture law '" + raw + "' is not the one tested against the resolved model: its error there is larger than that of " + DEFAULT_MIXTURE_LAW + " (docs/compact-pebble.md, the table of errors); kept as given");
  return raw as MixtureLawName;
}

const BLOCK_KEYS = ["particle", "matrix", "packingFraction", "powerDensity", "validRange", "fit", "mixtureLaw", "twoScale"];
const PARTICLE_KEYS = ["kernelRadius", "layers", "gap", "materials"];

/**
 * Read the `compact` block (a compact's, or a pebble's fuelled zone's): the particle, the matrix, the packing fraction, the power density, the range and the fit of the table, the
 * law, and where the two-scale step reads the matrix temperature. Every refusal names its field. Returns undefined after any error.
 */
export function parseHomogenised(raw: unknown, deps: HomogenisedDeps, err: ErrFn, qty: QtyFn, warn: WarnFn): HomogenisedSpec | undefined {
  if (!isObject(raw)) {
    err("E_SCHEMA_INVALID", "/compact", "the compact block is an object (particle, matrix, packingFraction, powerDensity, validRange, fit)");
    return undefined;
  }
  let ok = true;
  const bad = (code: string, field: string, message: string, extra?: Record<string, unknown>) => {
    ok = false;
    err(code, field, message, extra);
  };
  for (const k of Object.keys(raw)) if (!BLOCK_KEYS.includes(k)) bad("E_SCHEMA_INVALID", "/compact/" + k, "unknown key '" + k + "' in the compact block (it has " + BLOCK_KEYS.join(", ") + ")");
  const law = parseLaw(raw.mixtureLaw, "/compact/mixtureLaw", err, warn);
  if (law === undefined) ok = false;

  // the particle
  let particle: HomogenisedParticle | undefined;
  const pr = raw.particle;
  if (!isObject(pr)) bad("E_PROP_MISSING", "/compact/particle", "missing: the coated particle (kernelRadius, layers, gap, materials)");
  else {
    for (const k of Object.keys(pr)) if (!PARTICLE_KEYS.includes(k)) bad("E_SCHEMA_INVALID", "/compact/particle/" + k, "unknown key '" + k + "' for the particle (it has " + PARTICLE_KEYS.join(", ") + ")");
    const geo = parseTrisoGeometry({ kind: "triso", kernelRadius: pr.kernelRadius, layers: pr.layers } as Record<string, unknown>, (v, f, w) => deps.radius(v, f.replace("/geometry", "/compact/particle"), w), (code, field, message, extra) => bad(code, field.replace("/geometry", "/compact/particle"), message, extra));
    const names = geo ? geo.layers.map((l) => l.name) : [];
    let hGap: number | undefined;
    if (!isObject(pr.gap)) bad("E_PROP_MISSING", "/compact/particle/gap", "missing: the gap between the buffer and the next layer, as a constant conductance");
    else hGap = deps.parseGap(pr.gap, (code, field, message, extra) => bad(code, field.replace("/gap", "/compact/particle/gap"), message, extra));
    const mats = isObject(pr.materials) ? pr.materials : undefined;
    if (!mats) bad("E_PROP_MISSING", "/compact/particle/materials", "missing: the particle's materials, one for the kernel and one for each layer");
    let kernelK: Conductivity | undefined;
    const layerK: (Conductivity | undefined)[] = [];
    if (mats) {
      for (const k of Object.keys(mats)) if (k !== "kernel" && !names.includes(k as TrisoLayerName) && geo) bad("E_GEOMETRY", "/compact/particle/materials/" + k, "'" + k + "' is not a region of this particle (its materials are kernel, " + names.join(", ") + ")");
      const read = (region: string): Conductivity | undefined => {
        const m = mats[region];
        if (!isObject(m)) {
          bad("E_SCHEMA_INVALID", "/compact/particle/materials/" + region, "missing: the material of the " + region + " (an object with a materialId, a revision and sets)");
          return undefined;
        }
        const k = deps.conductivity(m, region, (code, field, message, extra) => bad(code, field.replace("/materials/" + region, "/compact/particle/materials/" + region), message, extra), qty);
        if (!k) ok = false;
        return k;
      };
      kernelK = read("kernel");
      for (const n of names) layerK.push(read(n));
    }
    if (ok && geo && hGap !== undefined && kernelK && layerK.length === names.length && layerK.every((k) => k)) {
      let r = geo.kernelRadius;
      const layers: TrisoLayer[] = geo.layers.map((l, i) => {
        const inner = r;
        r += l.thickness;
        return { name: l.name, innerRadius: inner, outerRadius: r, conductivity: layerK[i]! };
      });
      particle = { kernelRadius: geo.kernelRadius, kernelConductivity: kernelK, layers, outerRadius: geo.outerRadius, gapConductance: hGap };
    } else ok = false;
  }

  // the matrix
  let matrixK: Conductivity | undefined;
  if (!isObject(raw.matrix)) bad("E_PROP_MISSING", "/compact/matrix", "missing: the matrix's material (an object with a materialId, a revision and sets)");
  else {
    matrixK = deps.conductivity(raw.matrix, "matrix", (code, field, message, extra) => bad(code, field.replace("/materials/matrix", "/compact/matrix"), message, extra), qty);
    if (!matrixK) ok = false;
  }

  // the packing fraction and the power
  let phi: number | undefined;
  if (raw.packingFraction === undefined) bad("E_PROP_MISSING", "/compact/packingFraction", "missing: the packing fraction, the fraction of the compact's volume that the whole particles fill");
  else {
    phi = qty(raw.packingFraction, "fraction", "/compact/packingFraction");
    if (phi === undefined) ok = false;
    else if (!(phi > 0)) {
      bad("E_OUT_OF_RANGE", "/compact/packingFraction", "the packing fraction must be positive", { unit: "1" });
      phi = undefined;
    } else if (phi > PACKING_MAX) {
      bad("E_OUT_OF_RANGE", "/compact/packingFraction", "the packing fraction " + phi + " is above " + PACKING_MAX.toFixed(4) + ", the densest packing of equal spheres: no arrangement of particles fills that much of a compact", { unit: "1", range: [0, PACKING_MAX] });
      phi = undefined;
    } else if (phi > PACKING_RANDOM) {
      warn("W_PACKING_FRACTION", "/compact/packingFraction", "the packing fraction " + phi + " is above " + PACKING_RANDOM + ", random close packing of equal spheres: the particles would have to lie in an ordered arrangement", { unit: "1", range: [0, PACKING_RANDOM] });
    }
  }
  let pd: number | undefined;
  if (raw.powerDensity === undefined) bad("E_PROP_MISSING", "/compact/powerDensity", "missing: the power density of the compact (W/m3 of the whole compact, particles and matrix)");
  else {
    pd = qty(raw.powerDensity, "powerDensity", "/compact/powerDensity");
    if (pd === undefined) ok = false;
    else if (!(pd > 0)) {
      bad("E_OUT_OF_RANGE", "/compact/powerDensity", "the power density must be positive", { unit: "W/m3" });
      pd = undefined;
    }
  }

  // the range and the fit of the table
  let range: [number, number] | undefined;
  const vr = raw.validRange;
  if (!isObject(vr) || vr.min === undefined || vr.max === undefined) bad("E_PROP_MISSING", "/compact/validRange", "missing: the temperature range (min and max) the effective conductivity is tabulated over; the compact must stay inside it");
  else {
    const lo = qty(vr.min, "temperature", "/compact/validRange/min");
    const hi = qty(vr.max, "temperature", "/compact/validRange/max");
    if (lo === undefined || hi === undefined) ok = false;
    else if (!(lo > 0) || !(hi > lo)) bad("E_OUT_OF_RANGE", "/compact/validRange", "the range is above 0 K and its maximum exceeds its minimum", { unit: "K" });
    else range = [lo, hi];
  }
  let fit: { degree: number; tolerance: number } | undefined;
  const ft = raw.fit;
  if (!isObject(ft) || ft.degree === undefined || ft.tolerance === undefined) bad("E_PROP_MISSING", "/compact/fit", "missing: the effective conductivity is carried by a fitted polynomial: give fit.degree (1 to 3) and fit.tolerance (the largest deviation from the table you accept)");
  else {
    const tol = qty(ft.tolerance, "fraction", "/compact/fit/tolerance");
    if (typeof ft.degree !== "number" || !Number.isInteger(ft.degree) || ft.degree < 1 || ft.degree > 3) bad("E_OUT_OF_RANGE", "/compact/fit/degree", "the fit degree is 1, 2 or 3");
    else if (tol === undefined) ok = false;
    else if (!(tol > 0 && tol <= 0.5)) bad("E_OUT_OF_RANGE", "/compact/fit/tolerance", "the fit tolerance is above 0 and at most 50 %");
    else fit = { degree: ft.degree, tolerance: tol };
  }

  // where the particle-scale solution reads the matrix temperature
  let twoScale: TwoScalePoint[] = ["hottest", "mean"];
  if (raw.twoScale !== undefined) {
    const ts = raw.twoScale;
    const at = isObject(ts) ? ts.at : undefined;
    if (!isObject(ts) || !Array.isArray(at) || at.length < 1 || at.length > 5) bad("E_SCHEMA_INVALID", "/compact/twoScale", "twoScale is {at: [...]}, a list of 1 to 5 places: 'hottest', 'mean' or a radius");
    else {
      const out: TwoScalePoint[] = [];
      at.forEach((a: unknown, i: number) => {
        if (a === "hottest" || a === "mean") out.push(a);
        else {
          const r = deps.radius(a, "/compact/twoScale/at/" + i, "radius of the matrix temperature");
          if (r === undefined) ok = false;
          else out.push(r);
        }
      });
      twoScale = out;
    }
  }
  if (!ok || law === undefined || !particle || !matrixK || phi === undefined || pd === undefined || !range || !fit) return undefined;

  // each conductivity law must cover the range the table is built over, or it would be extrapolated
  const covers = (k: Conductivity, what: string, field: string): boolean => {
    const r = rangeOf(k);
    if (r && (r[0] > range![0] || r[1] < range![1])) {
      err("E_OUT_OF_RANGE", field, "the " + what + " conductivity is stated for " + r[0] + " to " + r[1] + " K but the compact's range is " + range![0] + " to " + range![1] + " K: the law would be extrapolated", { unit: "K", range: r });
      return false;
    }
    return true;
  };
  let covered = covers(matrixK, "matrix", "/compact/matrix");
  covered = covers(particle.kernelConductivity, "kernel", "/compact/particle/materials/kernel") && covered;
  for (const l of particle.layers) covered = covers(l.conductivity, l.name, "/compact/particle/materials/" + l.name) && covered;
  if (!covered) return undefined;

  const vols = particleVolumes(particle.kernelRadius, particle.outerRadius);
  // the compact holds phi / V particles in each cubic metre, so each particle carries the compact's power density times V / phi
  const particlePower = (pd * vols.particleVolume) / phi;
  const kernelPowerDensity = particlePower / vols.kernelVolume;
  if (kernelPowerDensity > KERNEL_POWER_DENSITY_SANITY_MAX) {
    warn("W_POWER_RANGE", "/compact/powerDensity", "the kernel's power density " + kernelPowerDensity.toExponential(2) + " W/m3 is above the sanity range (" + KERNEL_POWER_DENSITY_SANITY_MAX.toExponential(0) + " W/m3); kept as given", { unit: "W/m3", range: [0, KERNEL_POWER_DENSITY_SANITY_MAX] });
  }
  const spec: HomogenisedSpec = { law, packingFraction: phi, powerDensity: pd, particle, matrixConductivity: matrixK, range, fit, twoScale, particlePower, particlesPerM3: phi / vols.particleVolume, contrast: [0, 0] };
  // the contrast over the range, and the table's values must be positive and finite
  let cLo = Infinity;
  let cHi = -Infinity;
  for (let i = 0; i < 21; i++) {
    const T = range[0] + ((range[1] - range[0]) * i) / 20;
    const kp = particleEquivalentK(particle, T);
    const km = evaluate(lawOf(matrixK), T);
    if (!(kp > 0 && km > 0 && Number.isFinite(kp) && Number.isFinite(km))) {
      err("E_OUT_OF_RANGE", "/compact", "the conductivity of the particle or of the matrix is not positive at " + T.toFixed(0) + " K inside the compact's range");
      return undefined;
    }
    cLo = Math.min(cLo, kp / km);
    cHi = Math.max(cHi, kp / km);
  }
  spec.contrast = [cLo, cHi];
  const msg = mixtureDomainMessage(spec);
  if (msg) warn("W_MIXTURE_RANGE", "/compact/packingFraction", msg);
  return spec;
}

/** Why the packing fraction and the particle-to-matrix contrast are outside the domain the law was measured over, or undefined when inside. */
export function mixtureDomainMessage(s: Pick<HomogenisedSpec, "packingFraction" | "contrast" | "law">): string | undefined {
  const D = MIXTURE_DOMAIN;
  const [lo, hi] = s.contrast;
  const why: string[] = [];
  if (lo < D.contrastMin) why.push("the particle conducts only " + lo.toPrecision(2) + " of the matrix (the law was measured down to " + D.contrastMin + ")");
  if (hi > D.contrastCap) why.push("the particle conducts " + hi.toPrecision(2) + " times the matrix (the law was measured up to " + D.contrastCap + ")");
  if (s.packingFraction > D.packingMax) why.push("the packing fraction " + s.packingFraction + " is above " + D.packingMax + ", where the law's error against the resolved model exceeded 2 % (5 % at 0.5)");
  else if (hi > D.contrastMax && s.packingFraction > D.packingMaxHighContrast) why.push("the particle conducts " + hi.toPrecision(2) + " times the matrix (above " + D.contrastMax + ") at a packing fraction above " + D.packingMaxHighContrast + ", where the law's error reached 4.3 %");
  if (why.length === 0) return undefined;
  return "outside the domain the mixture law was measured over (docs/compact-pebble.md): " + why.join("; ") + ". The effective conductivity is kept as computed; its error is not bounded by the stated " + (MIXTURE_ERROR_BOUND * 100).toFixed(1) + " %";
}


// ---- the compact's results: the two-scale step on a finished pin run

export interface CompactTwoScaleEntry {
  /** What was asked ("hottest", "mean" or a radius in metres as text) and the radius the matrix temperature belongs to (the hottest cell's, or the stated one; absent for the mean). */
  at: string;
  radius?: number;
  /** The compact's temperature there from the solver's cells, and from the independent closed form. */
  matrixT: number;
  matrixTIndependent: number;
  /** The particle solved with the matrix at that temperature: from the solver's, and from the independent field. */
  particle: TwoScaleParticle;
  particleIndependent: TwoScaleParticle;
}

export interface CompactRecord {
  law: MixtureLawName;
  packingFraction: number;
  powerDensity: number;
  particlePower: number;
  particlesPerM3: number;
  /** The effective conductivity at the volume-mean temperature of the compact, from the law (W/m/K). */
  effectiveConductivityAtMean: number;
  /** The particle-to-matrix conductivity ratio over the range, and the error the law was measured to have inside its domain (a bound, not an estimate for this case). */
  contrast: [number, number];
  errorBound: number;
  inDomain: boolean;
  twoScale: CompactTwoScaleEntry[];
  checks: { id: string; label: string; value: number | null; unit: string; verdict: "pass" | "fail" | "na"; note: string }[];
  /** The label every view carries: what the two-scale result is. */
  label: string;
}

export const COMPACT_TWO_SCALE_LABEL = "Two-scale result: the compact is solved as one homogeneous solid; the hottest particle's temperatures are the particle solved with the matrix at the compact's local temperature behind a matrix shell sized from the packing fraction. The compact's own field does not contain the particle's rise.";
/** The matrix temperature read from the solver's cells against the closed form: the pin's discretisation bound (5 dT / N^2) plus this floor (K). Fixed before the first run. */
export const COMPACT_MATRIX_DISCRETISATION = 5;
export const COMPACT_MATRIX_FLOOR = 0.01;

/**
 * The two-scale record of a finished compact run. `fuelCells` are the solver's fuel cells (radius, temperature) in order; `independentAt(r)` is the independent closed form of the compact's
 * temperature at radius r; `radii` the fuel's inner and outer radii (a central hole's, or 0, and the compact's). The mean is the volume mean over the compact's cross-section.
 */
export function buildCompactRecord(spec: HomogenisedSpec, fuelCells: { r: number; T: number }[], independentAt: (r: number) => number, radii: { inner: number; outer: number }, geom: Geometry = CYLINDER, floor: number = COMPACT_MATRIX_FLOOR): CompactRecord {
  const cells = [...fuelCells].sort((a, b) => a.r - b.r);
  if (cells.length < 2) throw new RangeError("the compact's fuel needs at least two cells");
  const N = cells.length;
  const dr = (radii.outer - radii.inner) / N;
  // cell volumes (per unit length for the cylinder) from the faces of the equal cells of the mesh (the writer's)
  const area = cells.map((_, i) => geom.volume(radii.inner + i * dr, radii.inner + (i + 1) * dr));
  const totalArea = area.reduce((a, b) => a + b, 0);
  const meanSolver = cells.reduce((s, c, i) => s + c.T * area[i]!, 0) / totalArea;
  // the independent mean: Simpson over the cross-section
  const M = 400;
  let acc = 0;
  for (let i = 0; i <= M; i++) {
    const r = radii.inner + ((radii.outer - radii.inner) * i) / M;
    const w = i === 0 || i === M ? 1 : i % 2 === 1 ? 4 : 2;
    acc += w * independentAt(r) * geom.area(r);
  }
  const meanIndependent = (acc * ((radii.outer - radii.inner) / M)) / 3 / totalArea;
  const solverAt = (r: number): number => {
    if (r <= cells[0]!.r) return cells[0]!.T;
    for (let i = 1; i < N; i++) if (r <= cells[i]!.r) return cells[i - 1]!.T + ((cells[i]!.T - cells[i - 1]!.T) * (r - cells[i - 1]!.r)) / (cells[i]!.r - cells[i - 1]!.r);
    return cells[N - 1]!.T;
  };
  const entries: CompactTwoScaleEntry[] = spec.twoScale.map((p) => {
    let matrixT: number;
    let matrixTI: number;
    let radius: number | undefined;
    let at: string;
    if (p === "mean") {
      matrixT = meanSolver;
      matrixTI = meanIndependent;
      at = "mean";
    } else if (p === "hottest") {
      const hot = cells.reduce((m, c) => (c.T > m.T ? c : m), cells[0]!);
      matrixT = hot.T;
      radius = hot.r;
      matrixTI = independentAt(radii.inner); // the hottest point of uniformly heated fuel is the centre (or the hole's surface)
      at = "hottest";
    } else {
      matrixT = solverAt(p);
      matrixTI = independentAt(p);
      radius = p;
      at = p + " m";
    }
    return { at, ...(radius !== undefined ? { radius } : {}), matrixT, matrixTIndependent: matrixTI, particle: twoScaleParticle(spec, matrixT), particleIndependent: twoScaleParticle(spec, matrixTI) };
  });
  // the matrix temperature each particle is solved with, from the solver's cells and from the closed form of the same field: they agree to the discretisation bound of the cells
  // (the pin's, 5 dT / N^2 for the fuel's own rise dT and N cells, plus 0.01 K), so a temperature read at the wrong radius or averaged the wrong way cannot pass
  const rise = Math.abs(independentAt(radii.inner) - independentAt(radii.outer));
  const bound = (COMPACT_MATRIX_DISCRETISATION * rise) / (N * N) + floor;
  const checks: CompactRecord["checks"] = entries.map((e, i) => {
    const dMatrix = Math.abs(e.matrixT - e.matrixTIndependent);
    return {
      id: "twoScaleMatrix" + i,
      label: `Matrix temperature of the hottest particle at the ${e.at}: from the solver's cells vs the closed form`,
      value: dMatrix,
      unit: "K",
      verdict: dMatrix <= bound ? ("pass" as const) : ("fail" as const),
      note: `${e.matrixT.toFixed(3)} K from the solver's cells and ${e.matrixTIndependent.toFixed(3)} K from the closed form; bound ${bound.toFixed(3)} K = 5 x ${rise.toPrecision(3)} K / ${N}^2 + ${floor.toPrecision(3)} K. The kernel's centre is then ${e.particle.kernelCentreT.toFixed(2)} K (${e.particleIndependent.kernelCentreT.toFixed(2)} K from the closed form's field)`,
    };
  });
  const msg = mixtureDomainMessage(spec);
  checks.push({ id: "mixtureDomain", label: "Mixture law inside the domain it was measured over", value: null, unit: "", verdict: msg ? "na" : "pass", note: msg ?? `packing fraction ${spec.packingFraction} and particle-to-matrix conductivity ratio ${spec.contrast[0].toPrecision(2)} to ${spec.contrast[1].toPrecision(2)} are inside the domain; the law's error against the resolved model there was at most ${(MIXTURE_ERROR_BOUND * 100).toFixed(1)} %` });
  return {
    law: spec.law,
    packingFraction: spec.packingFraction,
    powerDensity: spec.powerDensity,
    particlePower: spec.particlePower,
    particlesPerM3: spec.particlesPerM3,
    effectiveConductivityAtMean: effectiveConductivity(spec, meanSolver),
    contrast: spec.contrast,
    errorBound: MIXTURE_ERROR_BOUND,
    inDomain: msg === undefined,
    twoScale: entries,
    checks,
    label: COMPACT_TWO_SCALE_LABEL,
  };
}
