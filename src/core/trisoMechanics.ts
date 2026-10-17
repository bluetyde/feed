// The mechanics of a coated particle (plan 14, stage E): what the case says (`mechanics` section, parsed and in SI), the constants OFFBEAT is given for each coating layer, and the
// independent layered-sphere solution those constants imply. Stage E is ELASTIC and STEADY: stress and displacement of the coating layers from a stated gas pressure, a stated
// outside pressure, the thermal strain from FEED's own temperatures and free strains the case states (the carbon's shrinkage, as an input with its source, never FEED's own
// correlation). Only the coating shells that are loaded are meshed: the buffer is detached from the inner carbon (no contact, no force across it), so a particle's mechanical shells
// are the inner pyrolytic carbon, the SiC and the outer pyrolytic carbon (as many as the particle has). docs/plans/14-triso-mechanics.md, docs/triso.md.

import { solveHot, lawOf } from "./conductivity";
import { SPHERE } from "./geometry";
import { alphaAt, thermalStrain } from "./hotDimensions";
import { LayeredSphere, type SphereLayer, type SphereOptions } from "./layeredSphere";
import type { Dimension } from "./units";
import type { NormalizedTriso, TrisoLayerName } from "./triso";
import { trisoClosedForm, type TrisoClosedForm } from "./trisoSolve";
import type { Elasticity, MechanicalProps } from "./validate";

type ErrFn = (code: string, field: string, message: string, extra?: Record<string, unknown>) => void;
type QtyFn = (value: unknown, dim: Dimension, field: string) => number | undefined;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The mechanical shells: every coating layer except the buffer (which is detached from the next layer and carries no load in stage E). */
export const TRISO_MECHANICAL_LAYERS: readonly TrisoLayerName[] = ["ipyc", "sic", "opyc"];

/** A pressure of the case is at most this (Pa): a coated particle's gas pressure is a few to a few tens of MPa. */
export const TRISO_MAX_PRESSURE = 1e9;
/** A free strain (radial or tangential) is at most this in magnitude: the carbon's dimensional change is a few per cent. */
export const TRISO_MAX_FREE_STRAIN = 0.2;

export interface TrisoFreeStrain {
  layer: TrisoLayerName;
  /** The strain the layer has with no stress, radial and tangential (negative: shrinkage). */
  radial: number;
  tangential: number;
  source: string;
}

export interface TrisoMechanicalLayer {
  name: TrisoLayerName;
  /** The layer's laws (a constant or a + b T), as in a pin's mechanical sets. */
  props: MechanicalProps;
}

export interface TrisoMechanicsSpec {
  /** Where the coating is free of thermal stress, K. */
  referenceTemperature: number;
  /** The gas pressure on the inner carbon's inner face, Pa (0 when the case states none), and its source. */
  gasPressure: number;
  gasPressureSource?: string;
  /** The pressure on the outer face of the last layer, Pa. */
  outsidePressure: number;
  /** The free strains the case states (at most one per mechanical layer). */
  freeStrains: TrisoFreeStrain[];
  /** The laws of the mechanical shells, from the inside outward. */
  layers: TrisoMechanicalLayer[];
}

const KEYS = ["referenceTemperature", "gasPressure", "outsidePressure", "freeStrains"];
const REFUSED: Record<string, string> = {
  history: "a fluence, temperature or power history is stage I of plan 14 (irradiation), not built: stage E is a steady state",
  gasInventory: "a gas inventory (fission gas, CO) is stage I of plan 14, not built: state the gas pressure itself, with its source",
  burnup: "a burnup is not a particle input in stage E",
  creep: "creep of the carbon is stage I of plan 14, not built",
  swelling: "swelling computed from a correlation is stage I of plan 14, not built: state the free strain of the layer, with its source",
  contact: "the buffer is detached from the inner carbon and there is no contact in stage E",
  plane: "a particle is a sphere: there is no plane condition",
  failure: "a failure criterion is stage F of plan 14, not built",
  coolantPressure: "the outside pressure of a particle is `outsidePressure`",
  internalPressure: "the gas pressure of a particle is `gasPressure`",
  stressLimits: "stress limits of a particle are milestone M4 of plan 14, not built",
};

/** Read the section. `layers` are the particle's coating layer names; the free strains refer to the mechanical ones among them. Returns undefined when anything was refused. */
export function parseTrisoMechanics(raw: unknown, layers: readonly string[], err: ErrFn, qty: QtyFn): Omit<TrisoMechanicsSpec, "layers"> | undefined {
  if (!isObject(raw)) {
    err("E_SCHEMA_INVALID", "/mechanics", "the mechanics section is an object (" + KEYS.join(", ") + ")");
    return undefined;
  }
  let ok = true;
  const bad = (code: string, field: string, message: string, extra: Record<string, unknown> = {}) => {
    ok = false;
    err(code, field, message, extra);
  };
  for (const k of Object.keys(raw)) {
    if (KEYS.includes(k)) continue;
    if (REFUSED[k] !== undefined) bad("E_UNSUPPORTED", "/mechanics/" + k, "'" + k + "': " + REFUSED[k]);
    else bad("E_SCHEMA_INVALID", "/mechanics/" + k, "unknown key '" + k + "' (a particle's mechanics section has " + KEYS.join(", ") + ")");
  }
  let ref: number | undefined;
  if (raw.referenceTemperature === undefined) bad("E_PROP_MISSING", "/mechanics/referenceTemperature", "the temperature at which the coating is free of thermal stress is needed (it is not assumed to be room temperature)");
  else {
    ref = qty(raw.referenceTemperature, "temperature", "/mechanics/referenceTemperature");
    if (ref === undefined) ok = false;
    else if (!(ref > 0 && ref <= 10000)) {
      bad("E_OUT_OF_RANGE", "/mechanics/referenceTemperature", "the reference temperature is above 0 K and at most 10000 K", { unit: "K" });
      ref = undefined;
    }
  }
  const pressure = (value: unknown, field: string, what: string, positive: boolean): number | undefined => {
    const p = qty(value, "pressure", field);
    if (p === undefined) {
      ok = false;
      return undefined;
    }
    if (!(positive ? p > 0 : p >= 0) || p > TRISO_MAX_PRESSURE) {
      bad("E_OUT_OF_RANGE", field, what + " is " + (positive ? "above 0" : "0 or more") + " and at most " + TRISO_MAX_PRESSURE + " Pa, got " + p, { unit: "Pa" });
      return undefined;
    }
    return p;
  };
  let outside: number | undefined;
  if (raw.outsidePressure === undefined) bad("E_PROP_MISSING", "/mechanics/outsidePressure", "the pressure on the outside of the particle is needed (0 for none)");
  else outside = pressure(raw.outsidePressure, "/mechanics/outsidePressure", "the outside pressure", false);
  let gas = 0;
  let gasSource: string | undefined;
  if (raw.gasPressure !== undefined) {
    const g = raw.gasPressure;
    if (!isObject(g)) bad("E_SCHEMA_INVALID", "/mechanics/gasPressure", "the gas pressure is {pressure, source}: FEED has no fission-gas or CO inventory of its own, so the pressure is an input with its source");
    else {
      for (const k of Object.keys(g)) if (k !== "pressure" && k !== "source") bad("E_SCHEMA_INVALID", "/mechanics/gasPressure/" + k, "unknown key '" + k + "' (the gas pressure has pressure and source)");
      if (typeof g.source !== "string" || g.source.trim() === "") bad("E_PROP_MISSING", "/mechanics/gasPressure/source", "the gas pressure needs the source it comes from: FEED has no gas inventory or release model of its own");
      else gasSource = g.source.trim();
      if (g.pressure === undefined) bad("E_PROP_MISSING", "/mechanics/gasPressure/pressure", "the gas pressure needs its pressure");
      else {
        const p = pressure(g.pressure, "/mechanics/gasPressure/pressure", "the gas pressure", true);
        if (p !== undefined) gas = p;
      }
    }
  }
  const strains: TrisoFreeStrain[] = [];
  if (raw.freeStrains !== undefined) {
    if (!Array.isArray(raw.freeStrains) || raw.freeStrains.length < 1) bad("E_SCHEMA_INVALID", "/mechanics/freeStrains", "freeStrains is a list of {layer, radial, tangential, source}, at most one per layer");
    else {
      const seen = new Set<string>();
      raw.freeStrains.forEach((f: unknown, i: number) => {
        const base = "/mechanics/freeStrains/" + i;
        if (!isObject(f)) return bad("E_SCHEMA_INVALID", base, "a free strain is an object with a layer, a radial and a tangential strain and a source");
        for (const k of Object.keys(f)) if (!["layer", "radial", "tangential", "source"].includes(k)) bad("E_SCHEMA_INVALID", base + "/" + k, "unknown key '" + k + "' (a free strain has layer, radial, tangential, source)");
        const layer = f.layer;
        if (typeof layer !== "string" || !TRISO_MECHANICAL_LAYERS.includes(layer as TrisoLayerName)) {
          if (layer === "buffer") bad("E_UNSUPPORTED", base + "/layer", "the buffer is detached from the inner carbon and carries no load in stage E: it has no free strain here");
          else bad("E_SCHEMA_INVALID", base + "/layer", "layer is one of " + TRISO_MECHANICAL_LAYERS.join(", "));
        } else if (!layers.includes(layer)) bad("E_GEOMETRY", base + "/layer", "this particle has no " + layer + " layer (its layers are " + layers.join(", ") + ")");
        else if (seen.has(layer)) bad("E_SCHEMA_INVALID", base + "/layer", "two free strains for the " + layer + " layer; give one");
        else seen.add(layer);
        if (typeof f.source !== "string" || f.source.trim() === "") bad("E_PROP_MISSING", base + "/source", "a free strain needs the source it comes from (a publication, a table): FEED has no swelling or shrinkage data of its own");
        const get = (key: "radial" | "tangential"): number | undefined => {
          if (f[key] === undefined) {
            bad("E_PROP_MISSING", base + "/" + key, "a free strain needs its " + key + " strain (0 for none): nothing is assumed");
            return undefined;
          }
          const v = qty(f[key], "fraction", base + "/" + key);
          if (v === undefined) {
            ok = false;
            return undefined;
          }
          if (!(Math.abs(v) <= TRISO_MAX_FREE_STRAIN)) {
            bad("E_OUT_OF_RANGE", base + "/" + key, "a free strain is at most " + TRISO_MAX_FREE_STRAIN + " in magnitude (small strain), got " + v, { unit: "1" });
            return undefined;
          }
          return v;
        };
        const radial = get("radial");
        const tangential = get("tangential");
        if (ok && typeof layer === "string" && radial !== undefined && tangential !== undefined && typeof f.source === "string" && f.source.trim() !== "") {
          strains.push({ layer: layer as TrisoLayerName, radial, tangential, source: f.source.trim() });
        }
      });
    }
  }
  if (!ok || ref === undefined || outside === undefined) return undefined;
  return { referenceTemperature: ref, gasPressure: gas, ...(gasSource ? { gasPressureSource: gasSource } : {}), outsidePressure: outside, freeStrains: strains };
}

// ---- the constants OFFBEAT is given, and the independent solution

export interface TrisoLayerConstants {
  name: TrisoLayerName;
  innerRadius: number;
  outerRadius: number;
  /** Young's modulus (Pa) at the layer's volume-mean temperature, Poisson's ratio, the shear modulus. */
  E: number;
  nu: number;
  G: number;
  /** The constant expansion coefficient (1/K) that reproduces the layer's mean thermal strain from the reference temperature. */
  alpha: number;
  meanTemperature: number;
  temperatureRange: [number, number];
  /** True when the layer (or the reference temperature, for the expansion) leaves the range a law is stated for. */
  elasticityOutOfRange: boolean;
  expansionOutOfRange: boolean;
  freeStrain?: TrisoFreeStrain;
}

export const elasticityAt = (e: Elasticity, T: number): number => (e.kind === "constant" ? e.E : e.a + e.b * T);

/** The temperature in the coating layer `index` (an index into `n.layers`) at radius r, from the closed form: the layer's own side of an interface, never the gap's other side. */
export function trisoLayerTemperature(n: NormalizedTriso, cf: TrisoClosedForm, index: number, r: number): number {
  const l = n.layers[index]!;
  const reg = cf.regions[index + 1]!;
  return solveHot(lawOf(l.conductivity), reg.outerT, (n.power.particlePower / (4 * Math.PI)) * (1 / r - 1 / l.outerRadius));
}

/** The volume-weighted mean of f(T(r)) over a layer and of T itself, by Simpson's rule (the profiles are smooth: 1/r shaped). */
function layerMeans(n: NormalizedTriso, cf: TrisoClosedForm, index: number, f: (T: number) => number): { meanT: number; mean: number; min: number; max: number } {
  const l = n.layers[index]!;
  const N = 200;
  const h = (l.outerRadius - l.innerRadius) / N;
  let w = 0;
  let sT = 0;
  let sF = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= N; i++) {
    const r = l.innerRadius + i * h;
    const c = i === 0 || i === N ? 1 : i % 2 === 1 ? 4 : 2;
    const T = trisoLayerTemperature(n, cf, index, r);
    const wt = c * r * r;
    w += wt;
    sT += wt * T;
    sF += wt * f(T);
    min = Math.min(min, T);
    max = Math.max(max, T);
  }
  return { meanT: sT / w, mean: sF / w, min, max };
}

/** The constants OFFBEAT is given for each mechanical shell of a particle that asks for mechanics, with the particle's closed-form temperatures. */
export function trisoMechanicsConstants(n: NormalizedTriso, cf: TrisoClosedForm = trisoClosedForm(n)): TrisoLayerConstants[] {
  const m = n.mechanics;
  if (!m) throw new Error("this particle has no mechanics section");
  const Tref = m.referenceTemperature;
  return m.layers.map((ml) => {
    const index = n.layers.findIndex((l) => l.name === ml.name);
    const l = n.layers[index]!;
    const p = ml.props;
    const s = layerMeans(n, cf, index, (T) => thermalStrain(p.expansion, T, Tref));
    const E = elasticityAt(p.elasticity, s.meanT);
    const nu = p.elasticity.nu;
    const dT = s.meanT - Tref;
    const alpha = Math.abs(dT) < 1e-9 ? alphaAt(p.expansion, s.meanT) : s.mean / dT;
    const outside = (range: [number, number] | undefined, lo: number, hi: number) => range !== undefined && (lo < range[0] || hi > range[1]);
    const fs = m.freeStrains.find((f) => f.layer === ml.name);
    return {
      name: ml.name,
      innerRadius: l.innerRadius,
      outerRadius: l.outerRadius,
      E,
      nu,
      G: E / (2 * (1 + nu)),
      alpha,
      meanTemperature: s.meanT,
      temperatureRange: [s.min, s.max],
      elasticityOutOfRange: outside(p.elasticity.range, s.min, s.max),
      expansionOutOfRange: outside(p.expansion.kind === "linear" ? p.expansion.range : undefined, Math.min(s.min, Tref), Math.max(s.max, Tref)),
      ...(fs ? { freeStrain: fs } : {}),
    };
  });
}

/** Where a cell centre of the mechanics mesh lies on the nominal sphere: the volume centroid of the cell's shell between two radii. */
export const trisoCellCentre = (a: number, b: number): number => SPHERE.centroid(a, b);

/**
 * The independent solution: the coating's layered elastic sphere with the constants OFFBEAT is given (E at the layer's mean temperature, the expansion coefficient of the same mean
 * thermal strain), the temperatures of the closed form, the stated free strains, the gas pressure inside and the outside pressure. Radii are the case's (the nominal sphere): the
 * wedge's results are compared at radius / TRISO_WEDGE_SCALE.
 */
export function trisoLayeredSphere(n: NormalizedTriso, constants: TrisoLayerConstants[] = trisoMechanicsConstants(n), options: SphereOptions = {}, cf: TrisoClosedForm = trisoClosedForm(n)): LayeredSphere {
  const m = n.mechanics!;
  const layers: SphereLayer[] = constants.map((c) => {
    const index = n.layers.findIndex((l) => l.name === c.name);
    return {
      a: c.innerRadius,
      b: c.outerRadius,
      E: c.E,
      nu: c.nu,
      ...(c.freeStrain ? { eR: c.freeStrain.radial, eT: c.freeStrain.tangential } : {}),
      theta: (r: number) => c.alpha * (trisoLayerTemperature(n, cf, index, r) - m.referenceTemperature),
    };
  });
  return new LayeredSphere(layers, m.gasPressure, m.outsidePressure, options);
}
