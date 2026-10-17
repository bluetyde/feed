// The coated particle of plan 13 (docs/plans/13-triso-particle.md): a sphere of a kernel and up to four coating layers, one-dimensional in the radius, thermal only.
// This file holds what the case says about the particle (parsed, in SI) and the numbers derived from it: the power per particle, the kernel's volumetric power and the volumes.
// The sphere's geometry kernel is in geometry.ts (SPHERE); the validator's branch for a particle is `validateTriso` in validate.ts.

import { SPHERE } from "./geometry";
import type { Dimension } from "./units";
import type { TrisoLimitRule } from "./trisoLimits";
import type { TrisoMechanicsSpec } from "./trisoMechanics";
import type { NormalizedPopulation } from "./trisoPopulation";
import type { NormalizedTrisoTransient } from "./trisoTransient";
import type { Conductivity, HeatCapacity } from "./validate";

/** The coating layers in the order they lie, from the kernel outward. A particle has the first two to all four (the buffer and the inner pyrolytic carbon at least: the gap between them is the case's gap). */
export const TRISO_LAYER_NAMES = ["buffer", "ipyc", "sic", "opyc"] as const;
export type TrisoLayerName = (typeof TRISO_LAYER_NAMES)[number];
export const TRISO_LAYERS_MIN = 2;
export const TRISO_LAYERS_MAX = TRISO_LAYER_NAMES.length;

/** The densest packing of equal spheres (pi / sqrt(18)); no packing fraction can exceed it. */
export const PACKING_MAX = Math.PI / Math.sqrt(18);
/** Random close packing of equal spheres: above it the particles must be in an ordered arrangement, and the case is warned. */
export const PACKING_RANDOM = 0.64;
/** A kernel's volumetric power above this (W/m3) is outside what the reactors that use coated particles reach; a warning, not a limit. (The generic particle of OFFBEAT's tutorial has 3e9.) */
export const KERNEL_POWER_DENSITY_SANITY_MAX = 1e10;
/** A gap conductance above this (W/m2/K) is a buffer in contact with the inner pyrolytic carbon: OFFBEAT's own gap model gives about 2.6e5 for a zero-width gap (docs/spike/triso-probe.md). */
export const GAP_CONTACT_CONDUCTANCE = 3e5;
/** Cells per region of the particle's mesh. */
export const TRISO_MESH_MINIMUM = { kernelCells: 4, layerCells: 2 } as const;
export const TRISO_MESH_MAXIMUM = { kernelCells: 20000, layerCells: 10000 } as const;

export interface TrisoLayer {
  name: TrisoLayerName;
  innerRadius: number;
  outerRadius: number;
  conductivity: Conductivity;
}

/** How the case gave the power: per particle, per kernel volume, or as a compact's power density with a packing fraction. */
export interface TrisoPower {
  form: "particle" | "kernel-density" | "compact";
  /** The heat generated in the kernel, W (the coatings generate none: gamma heating is not modelled). */
  particlePower: number;
  /** W/m3 of kernel. */
  kernelPowerDensity: number;
  kernelVolume: number;
  /** The volume of the whole particle, kernel to outer coating, m3. */
  particleVolume: number;
  /** Present for the compact form: the power density of the compact (W/m3) and the fraction of its volume the whole particles fill. */
  compact?: { powerDensity: number; packingFraction: number };
}

export interface NormalizedTriso {
  caseId: string;
  kernelRadius: number;
  kernelConductivity: Conductivity;
  /** From the buffer outward. */
  layers: TrisoLayer[];
  /** The outer radius of the particle, m. */
  outerRadius: number;
  /** The gap between the buffer and the layer after it, W/m2/K, at the buffer's outer radius. */
  gapConductance: number;
  boundary: { kind: "convective"; bulkTemperature: number; heatTransferCoefficient: number } | { kind: "surface-temperature"; surfaceTemperature: number };
  power: TrisoPower;
  /** Cells in the kernel, then in each layer in the same order as `layers`. */
  cells: number[];
  /** The temperature limits the case states for its regions (stage 2 of T3), each with its source; absent when the case states none. */
  limits?: TrisoLimitRule[];
  /** Present for a transient (stage 3 of T3): the power table, the time grid, the start and the outside's table; `power` is then the table's peak. */
  transient?: NormalizedTrisoTransient;
  /** A transient's volumetric heat capacity of each region, kernel first. */
  capacities?: HeatCapacity[];
  /** Present when the case asks for the stress in the coating (plan 14, stage E): elastic and steady, with the gas pressure, the outside pressure and the free strains the case states. */
  mechanics?: TrisoMechanicsSpec;
  /** The population section (plan 13, T6): how many particles to draw and from which distributions. A run of the case runs the nominal particle; the population is run by trisoPopulation.ts. */
  population?: NormalizedPopulation;
}

type ErrFn = (code: string, field: string, message: string, extra?: Record<string, unknown>) => void;
type QtyFn = (value: unknown, dim: Dimension, field: string) => number | undefined;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The sphere's volumes: the kernel's and the whole particle's. */
export function particleVolumes(kernelRadius: number, outerRadius: number): { kernelVolume: number; particleVolume: number } {
  return { kernelVolume: SPHERE.volume(0, kernelRadius), particleVolume: SPHERE.volume(0, outerRadius) };
}

export interface TrisoGeometry {
  kernelRadius: number;
  /** The layers' names and thicknesses (m), in order. */
  layers: { name: TrisoLayerName; thickness: number }[];
  outerRadius: number;
}

const GEOMETRY_KEYS = ["kind", "kernelRadius", "layers"];

/**
 * Read the particle's geometry. `radius` is the validator's positive-length reader (units, sign, plausible range). Every refusal names the field; the layers are the first two to all four
 * of buffer, ipyc, sic, opyc, in that order (OFFBEAT's own mesh script does not allow a kernel without a buffer, and the gap sits between the buffer and the layer after it).
 */
export function parseTrisoGeometry(g: Record<string, unknown>, radius: (value: unknown, field: string, what: string) => number | undefined, err: ErrFn): TrisoGeometry | undefined {
  for (const k of Object.keys(g)) if (!GEOMETRY_KEYS.includes(k)) err("E_GEOMETRY", "/geometry/" + k, "unknown key '" + k + "' for a particle (it has " + GEOMETRY_KEYS.join(", ") + "); a particle has no pin radii, no plate thicknesses and no central hole");
  let ok = true;
  if (g.kernelRadius === undefined) {
    err("E_SCHEMA_INVALID", "/geometry/kernelRadius", "missing: a particle needs the radius of its kernel");
    ok = false;
  }
  const kernelRadius = g.kernelRadius === undefined ? undefined : radius(g.kernelRadius, "/geometry/kernelRadius", "kernel radius");
  if (g.kernelRadius !== undefined && kernelRadius === undefined) ok = false;
  const raw = g.layers;
  if (raw === undefined) {
    err("E_SCHEMA_INVALID", "/geometry/layers", "missing: a particle needs its coating layers, from the buffer outward (" + TRISO_LAYER_NAMES.join(", ") + ")");
    return undefined;
  }
  if (!Array.isArray(raw)) {
    err("E_GEOMETRY", "/geometry/layers", "layers is a list of {name, thickness}, from the buffer outward");
    return undefined;
  }
  if (raw.length < TRISO_LAYERS_MIN || raw.length > TRISO_LAYERS_MAX) {
    err("E_GEOMETRY", "/geometry/layers", "a particle has " + TRISO_LAYERS_MIN + " to " + TRISO_LAYERS_MAX + " coating layers (the first " + TRISO_LAYERS_MIN + " to all of " + TRISO_LAYER_NAMES.join(", ") + "), got " + raw.length);
    return undefined;
  }
  const layers: { name: TrisoLayerName; thickness: number }[] = [];
  raw.forEach((l: unknown, i: number) => {
    const base = "/geometry/layers/" + i;
    if (!isObject(l)) {
      err("E_GEOMETRY", base, "a layer is an object with a name and a thickness");
      ok = false;
      return;
    }
    for (const k of Object.keys(l)) if (k !== "name" && k !== "thickness") err("E_GEOMETRY", base + "/" + k, "unknown key '" + k + "' for a layer (it has name, thickness)");
    const expected = TRISO_LAYER_NAMES[i]!;
    if (l.name !== expected) {
      err("E_GEOMETRY", base + "/name", "layer " + (i + 1) + " is '" + String(l.name) + "' but the layers lie in the order " + TRISO_LAYER_NAMES.join(", ") + ", so it must be '" + expected + "'");
      ok = false;
    }
    if (l.thickness === undefined) {
      err("E_SCHEMA_INVALID", base + "/thickness", "missing: the thickness of the " + expected + " layer");
      ok = false;
      return;
    }
    const t = radius(l.thickness, base + "/thickness", "thickness of the " + expected + " layer");
    if (t === undefined) {
      ok = false;
      return;
    }
    layers.push({ name: expected, thickness: t });
  });
  if (!ok || kernelRadius === undefined || layers.length !== raw.length) return undefined;
  const outerRadius = layers.reduce((r, l) => r + l.thickness, kernelRadius);
  return { kernelRadius, layers, outerRadius };
}

const POWER_KEYS = ["particlePower", "kernelPowerDensity", "compactPowerDensity", "packingFraction", "radialShape"];

/**
 * Read the power: exactly one of the particle's power (W), the kernel's volumetric power (W/m3) or a compact's power density (W/m3) with the packing fraction (the fraction of the compact's
 * volume that the whole particles fill). The kernel's volumetric power and the power per particle follow from the volumes.
 */
export function parseTrisoPower(p: Record<string, unknown>, volumes: { kernelVolume: number; particleVolume: number }, err: ErrFn, qty: QtyFn, warn: (code: string, field: string, message: string, extra?: Record<string, unknown>) => void): TrisoPower | undefined {
  for (const k of Object.keys(p)) {
    if (k === "linearHeatRate") err("E_UNSUPPORTED", "/power/linearHeatRate", "a particle's power is per particle, per kernel volume or per compact volume; the linear heat rate is for pins");
    else if (!POWER_KEYS.includes(k)) err("E_SCHEMA_INVALID", "/power/" + k, "unknown key '" + k + "' for a particle's power (it has particlePower, kernelPowerDensity, compactPowerDensity with packingFraction)");
  }
  if (p.linearHeatRate !== undefined) return undefined; // refused above: one fault, one code
  if (p.radialShape !== undefined && p.radialShape !== "uniform") err("E_UNSUPPORTED", "/power/radialShape", "V1 supports a uniform radial power shape only");
  const forms = ["particlePower", "kernelPowerDensity", "compactPowerDensity"].filter((k) => p[k] !== undefined);
  if (forms.length === 0) {
    err("E_SCHEMA_INVALID", "/power", "missing: give the particle's power, the kernel's volumetric power or a compact's power density with its packing fraction");
    return undefined;
  }
  if (forms.length > 1) {
    err("E_SCHEMA_INVALID", "/power", "the power is given in " + forms.length + " forms (" + forms.join(", ") + "); give one");
    return undefined;
  }
  const form = forms[0]!;
  if (form !== "compactPowerDensity" && p.packingFraction !== undefined) {
    err("E_UNSUPPORTED", "/power/packingFraction", "a packing fraction only turns a compact's power density into a power per particle; with " + form + " it would change nothing, so remove it");
    return undefined;
  }
  const positiveQty = (value: unknown, dim: Dimension, field: string, what: string, unit: string): number | undefined => {
    const v = qty(value, dim, field);
    if (v === undefined) return undefined;
    if (!(v > 0)) {
      err("E_OUT_OF_RANGE", field, what + " must be positive", { unit });
      return undefined;
    }
    return v;
  };
  let particlePower: number | undefined;
  let compact: TrisoPower["compact"];
  if (form === "particlePower") particlePower = positiveQty(p.particlePower, "power", "/power/particlePower", "the particle's power", "W");
  else if (form === "kernelPowerDensity") {
    const q = positiveQty(p.kernelPowerDensity, "powerDensity", "/power/kernelPowerDensity", "the kernel's power density", "W/m3");
    particlePower = q === undefined ? undefined : q * volumes.kernelVolume;
  } else {
    const pd = positiveQty(p.compactPowerDensity, "powerDensity", "/power/compactPowerDensity", "the compact's power density", "W/m3");
    let pf: number | undefined;
    if (p.packingFraction === undefined) err("E_PROP_MISSING", "/power/packingFraction", "a compact's power density needs the packing fraction: the fraction of the compact's volume that the whole particles fill");
    else {
      pf = qty(p.packingFraction, "fraction", "/power/packingFraction");
      if (pf !== undefined && !(pf > 0)) {
        err("E_OUT_OF_RANGE", "/power/packingFraction", "the packing fraction must be positive", { unit: "1" });
        pf = undefined;
      } else if (pf !== undefined && pf > PACKING_MAX) {
        err("E_OUT_OF_RANGE", "/power/packingFraction", "the packing fraction " + pf + " is above " + PACKING_MAX.toFixed(4) + ", the densest packing of equal spheres: no arrangement of particles fills that much of a compact", { unit: "1", range: [0, PACKING_MAX] });
        pf = undefined;
      } else if (pf !== undefined && pf > PACKING_RANDOM) {
        warn("W_PACKING_FRACTION", "/power/packingFraction", "the packing fraction " + pf + " is above " + PACKING_RANDOM + ", random close packing of equal spheres: the particles would have to lie in an ordered arrangement", { unit: "1", range: [0, PACKING_RANDOM] });
      }
    }
    if (pd !== undefined && pf !== undefined) {
      // the compact holds pf / V particles in each cubic metre, so each particle carries the compact's power density times V / pf
      particlePower = (pd * volumes.particleVolume) / pf;
      compact = { powerDensity: pd, packingFraction: pf };
    }
  }
  if (particlePower === undefined) return undefined;
  const kernelPowerDensity = particlePower / volumes.kernelVolume;
  if (kernelPowerDensity > KERNEL_POWER_DENSITY_SANITY_MAX) {
    warn("W_POWER_RANGE", "/power/" + form, "the kernel's power density " + kernelPowerDensity.toExponential(2) + " W/m3 is above the sanity range (" + KERNEL_POWER_DENSITY_SANITY_MAX.toExponential(0) + " W/m3); kept as given", { unit: "W/m3", range: [0, KERNEL_POWER_DENSITY_SANITY_MAX] });
  }
  return { form: form === "particlePower" ? "particle" : form === "kernelPowerDensity" ? "kernel-density" : "compact", particlePower, kernelPowerDensity, ...volumes, ...(compact ? { compact } : {}) };
}

/** The most limits a case states, and the highest temperature one may name: the pin's (src/core/validate.ts MAX_LIMITS, MAX_LIMIT_TEMPERATURE; a test holds them equal). */
export const TRISO_MAX_LIMITS = 10;
export const TRISO_MAX_LIMIT_TEMPERATURE = 10000;

/**
 * The limits a particle case states: each with a name, a region (the kernel or one of the layers the particle has), a maximum temperature and the source it comes from. Nothing is
 * defaulted and FEED has no limit of its own (docs/temperature-limits.md). A pin's `whileCladding` condition has no meaning here and is refused by name.
 */
export function parseTrisoLimits(raw: unknown, regions: readonly string[], err: ErrFn, qty: QtyFn): TrisoLimitRule[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > TRISO_MAX_LIMITS) {
    err("E_SCHEMA_INVALID", "/limits", "limits is a list of 1 to " + TRISO_MAX_LIMITS + " rules");
    return undefined;
  }
  const out: TrisoLimitRule[] = [];
  let ok = true;
  const names = new Set<string>();
  const known = ["kernel", ...TRISO_LAYER_NAMES] as readonly string[];
  raw.forEach((r: unknown, i: number) => {
    const base = "/limits/" + i;
    const bad = (code: string, field: string, message: string, extra: Record<string, unknown> = {}) => {
      ok = false;
      err(code, field, message, extra);
    };
    if (!isObject(r)) return bad("E_SCHEMA_INVALID", base, "a limit is an object with a name, a region, a maximum temperature and a source");
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (name === "" || name.length > 80 || /[\u0000-\u001f]/.test(name)) bad("E_SCHEMA_INVALID", base + "/name", "a limit needs a name of 1 to 80 characters");
    else if (names.has(name)) bad("E_SCHEMA_INVALID", base + "/name", "two limits are named '" + name + "'; a name says which limit a result is about");
    names.add(name);
    if (typeof r.region !== "string" || !known.includes(r.region)) bad("E_SCHEMA_INVALID", base + "/region", "region is one of " + known.join(", ") + " (the kernel or a coating layer; 'fuel' and 'cladding' are a pin's)");
    else if (!regions.includes(r.region)) bad("E_GEOMETRY", base + "/region", "this particle has no " + r.region + " layer (its regions are " + regions.join(", ") + ")");
    if (typeof r.source !== "string" || r.source.trim() === "") bad("E_PROP_MISSING", base + "/source", "a limit needs the source it comes from: FEED has no limits of its own");
    if (r.whileCladding !== undefined) bad("E_UNSUPPORTED", base + "/whileCladding", "whileCladding conditions a pin's fuel limit on its cladding; a particle has no cladding, so a limit on a region has no condition");
    let max: number | undefined;
    if (r.maxTemperature === undefined) bad("E_PROP_MISSING", base + "/maxTemperature", "a limit needs its maximum temperature");
    else {
      max = qty(r.maxTemperature, "temperature", base + "/maxTemperature");
      if (max === undefined) ok = false;
      else if (!(max > 0 && max <= TRISO_MAX_LIMIT_TEMPERATURE)) {
        bad("E_OUT_OF_RANGE", base + "/maxTemperature", "a limit temperature is above 0 K and at most " + TRISO_MAX_LIMIT_TEMPERATURE + " K", { unit: "K" });
        max = undefined;
      }
    }
    if (ok && max !== undefined && typeof r.region === "string" && regions.includes(r.region) && typeof r.source === "string" && name !== "") out.push({ name, region: r.region as TrisoLimitRule["region"], maxTemperature: max, source: r.source.trim() });
  });
  return ok && out.length === raw.length ? out : undefined;
}

/** The mesh keys of a particle with the given layers: kernelCells, then <layer>Cells for each. */
export function trisoMeshKeys(layers: readonly string[]): string[] {
  return ["kernelCells", ...layers.map((n) => n + "Cells")];
}

/** Read the mesh: a whole number of cells for the kernel and for each layer the particle has, within the bounds; keys for layers it does not have are refused. */
export function parseTrisoMesh(m: Record<string, unknown>, layers: readonly string[], err: ErrFn): number[] | undefined {
  const keys = trisoMeshKeys(layers);
  let ok = true;
  for (const k of Object.keys(m)) {
    if (!keys.includes(k)) {
      err("E_SCHEMA_INVALID", "/mesh/" + k, "unknown key '" + k + "' for this particle's mesh (it has " + keys.join(", ") + ")");
      ok = false;
    }
  }
  const cells: number[] = [];
  keys.forEach((k, i) => {
    const v = m[k];
    if (v === undefined) {
      err("E_SCHEMA_INVALID", "/mesh/" + k, "missing: the number of cells in the " + (i === 0 ? "kernel" : layers[i - 1] + " layer"));
      ok = false;
      return;
    }
    if (typeof v !== "number" || !Number.isInteger(v)) {
      err("E_SCHEMA_INVALID", "/mesh/" + k, k + " is a whole number of cells");
      ok = false;
      return;
    }
    const lo = i === 0 ? TRISO_MESH_MINIMUM.kernelCells : TRISO_MESH_MINIMUM.layerCells;
    const hi = i === 0 ? TRISO_MESH_MAXIMUM.kernelCells : TRISO_MESH_MAXIMUM.layerCells;
    if (v < lo) {
      err("E_MESH", "/mesh/" + k, k + " is " + v + "; the minimum is " + lo);
      ok = false;
    } else if (v > hi) {
      err("E_MESH", "/mesh/" + k, k + " is " + v + "; the maximum is " + hi);
      ok = false;
    }
    cells.push(v);
  });
  return ok ? cells : undefined;
}
