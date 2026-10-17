// The `population` section of a particle case (plan 13, T6): reading it, with every refusal named by its field. The sampler and the batch are in trisoPopulation.ts.

import type { Dimension } from "./units";
import { TRISO_LAYER_NAMES } from "./triso";
import {
  Distribution,
  NormalizedPopulation,
  POPULATION_MAX_SIZE,
  POPULATION_MIN_ACCEPTANCE,
  POPULATION_VARIABLES,
  POPULATION_WARN_LOSS,
  PopulationVariable,
  Truncation,
  keptFractions,
  validRange,
} from "./trisoPopulation";

type ErrFn = (code: string, field: string, message: string, extra?: Record<string, unknown>) => void;
type QtyFn = (value: unknown, dim: Dimension, field: string) => number | undefined;
type WarnFn = (code: string, field: string, message: string, extra?: Record<string, unknown>) => void;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const POPULATION_KEYS = ["size", "seed", "distributions"];
const KINDS = ["constant", "normal", "lognormal", "uniform"] as const;
const KIND_KEYS: Record<(typeof KINDS)[number], string[]> = {
  constant: ["kind", "value"],
  normal: ["kind", "mean", "stdDev", "truncate"],
  lognormal: ["kind", "median", "sigmaLog", "truncate"],
  uniform: ["kind", "min", "max"],
};

/** The dimension a variable's values are given in, and the unit to say in a message. */
function dimensionOf(v: PopulationVariable): { dim: "length" | "fraction" | "temperature"; unit: string } {
  return v === "powerFactor" ? { dim: "fraction", unit: "1" } : v === "matrixTemperature" ? { dim: "temperature", unit: "K" } : { dim: "length", unit: "m" };
}

/**
 * Read the case's `population` section: `size` (a whole number, 1 to POPULATION_MAX_SIZE), `seed` (a whole number from 0 to 2^32 - 1; stated, never defaulted, so the case says which
 * sample it is) and `distributions`: for any of kernelRadius, the layers the particle has, powerFactor and matrixTemperature, one of constant (value), normal (mean, stdDev),
 * lognormal (median, sigmaLog: the standard deviation of ln x) or uniform (min, max). A normal or lognormal may be truncated to {min, max} (either may be left out). A distribution
 * that cannot be sampled (it keeps under 1 % of its draws once truncated and cut to the valid values) is E_POPULATION_UNSAMPLABLE; an empty or inverted range is E_OUT_OF_RANGE.
 */
export function parsePopulation(raw: unknown, layers: readonly string[], err: ErrFn, qty: QtyFn, warn: WarnFn): NormalizedPopulation | undefined {
  if (!isObj(raw)) {
    err("E_SCHEMA_INVALID", "/population", "the population section is an object with a size, a seed and distributions");
    return undefined;
  }
  let ok = true;
  const bad: ErrFn = (code, field, message, extra = {}) => {
    ok = false;
    err(code, field, message, extra);
  };
  for (const k of Object.keys(raw)) if (!POPULATION_KEYS.includes(k)) bad("E_SCHEMA_INVALID", "/population/" + k, "unknown key '" + k + "' in a population (it has " + POPULATION_KEYS.join(", ") + ")");
  let size: number | undefined;
  if (raw.size === undefined) bad("E_PROP_MISSING", "/population/size", "a population needs its size: the number of particles to draw");
  else if (typeof raw.size !== "number" || !Number.isInteger(raw.size)) bad("E_SCHEMA_INVALID", "/population/size", "size is a whole number of particles");
  else if (raw.size < 1 || raw.size > POPULATION_MAX_SIZE) bad("E_OUT_OF_RANGE", "/population/size", "size is " + raw.size + "; a population has 1 to " + POPULATION_MAX_SIZE + " particles", { range: [1, POPULATION_MAX_SIZE] });
  else size = raw.size;
  let seed: number | undefined;
  if (raw.seed === undefined) bad("E_PROP_MISSING", "/population/seed", "a population needs its seed, a whole number from 0 to 4294967295: it names the sample, so the case gives the same one every time");
  else if (typeof raw.seed !== "number" || !Number.isInteger(raw.seed)) bad("E_SCHEMA_INVALID", "/population/seed", "seed is a whole number");
  else if (raw.seed < 0 || raw.seed > 0xffffffff) bad("E_OUT_OF_RANGE", "/population/seed", "seed is " + raw.seed + "; it is a whole number from 0 to 4294967295", { range: [0, 0xffffffff] });
  else seed = raw.seed;
  const distributions: NormalizedPopulation["distributions"] = {};
  const dr = raw.distributions;
  if (dr === undefined) bad("E_PROP_MISSING", "/population/distributions", "a population needs its distributions (an object; it may be empty, which draws copies of the case's particle)");
  else if (!isObj(dr)) bad("E_SCHEMA_INVALID", "/population/distributions", "distributions is an object keyed by variable");
  else {
    const layerNames = TRISO_LAYER_NAMES as readonly string[];
    for (const [name, spec] of Object.entries(dr)) {
      const base = "/population/distributions/" + name;
      if (!(POPULATION_VARIABLES as readonly string[]).includes(name)) {
        bad("E_SCHEMA_INVALID", base, "'" + name + "' is not a variable of a population (it has " + POPULATION_VARIABLES.join(", ") + ")");
        continue;
      }
      if (layerNames.includes(name) && !layers.includes(name)) {
        bad("E_GEOMETRY", base, "this particle has no " + name + " layer, so its thickness has no distribution (its layers are " + layers.join(", ") + ")");
        continue;
      }
      const d = parseDistribution(spec, name as PopulationVariable, base, bad, qty, warn);
      if (d) distributions[name as PopulationVariable] = d;
    }
  }
  return ok && size !== undefined && seed !== undefined ? { size, seed, distributions } : undefined;
}

function parseDistribution(spec: unknown, v: PopulationVariable, base: string, bad: ErrFn, qty: QtyFn, warn: WarnFn): Distribution | undefined {
  if (!isObj(spec)) {
    bad("E_SCHEMA_INVALID", base, "a distribution is an object with a kind (" + KINDS.join(", ") + ") and its parameters");
    return undefined;
  }
  const kind = spec.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    bad("E_SCHEMA_INVALID", base + "/kind", "kind is one of " + KINDS.join(", ") + ", got '" + String(kind) + "'");
    return undefined;
  }
  const k = kind as (typeof KINDS)[number];
  let ok = true;
  const fail: ErrFn = (code, field, message, extra = {}) => {
    ok = false;
    bad(code, field, message, extra);
  };
  for (const key of Object.keys(spec)) if (!KIND_KEYS[k].includes(key)) fail("E_SCHEMA_INVALID", base + "/" + key, "unknown key '" + key + "' for a " + k + " distribution (it has " + KIND_KEYS[k].filter((x) => x !== "kind").join(", ") + ")");
  const { dim, unit: unitSay } = dimensionOf(v);
  const need = (key: string, what: string, d: Dimension): number | undefined => {
    if (spec[key] === undefined) {
      fail("E_PROP_MISSING", base + "/" + key, "a " + k + " distribution needs " + key + " (" + what + ")");
      return undefined;
    }
    // a spread of a temperature is a temperature DIFFERENCE: degC would add 273.15 to it
    if (v === "matrixTemperature" && key === "stdDev" && isObj(spec[key]) && (spec[key] as Record<string, unknown>).unit === "degC") {
      fail("E_UNITS", base + "/" + key, "a standard deviation of a temperature is a difference: give it in K, not degC");
      return undefined;
    }
    const x = qty(spec[key], d, base + "/" + key);
    if (x === undefined) ok = false;
    return x;
  };
  let dist: Distribution | undefined;
  if (k === "constant") {
    const value = need("value", "the value every particle has", dim);
    if (value !== undefined) {
      const [lo, hi] = validRange(v);
      if (!(lo > 0 ? value >= lo : value > lo) || value > hi) fail("E_OUT_OF_RANGE", base + "/value", "the value " + value + " " + unitSay + " is not a valid " + v + " (it is above " + lo + " and at most " + hi + " " + unitSay + ")", { unit: unitSay, range: [lo, hi] });
      else dist = { kind: "constant", value };
    }
  } else if (k === "uniform") {
    const min = need("min", "the lower end", dim);
    const max = need("max", "the upper end", dim);
    if (min !== undefined && max !== undefined) {
      if (!(max > min)) fail("E_OUT_OF_RANGE", base + "/max", "max must be above min (got " + min + " to " + max + " " + unitSay + ")", { unit: unitSay });
      else dist = { kind: "uniform", min, max };
    }
  } else {
    let a: number | undefined;
    let b: number | undefined;
    if (k === "normal") {
      a = need("mean", "the mean", dim);
      b = need("stdDev", "the standard deviation, in the units of the variable", dim);
      if (b !== undefined && !(b > 0)) {
        fail("E_OUT_OF_RANGE", base + "/stdDev", "stdDev must be positive (use a constant for no spread)", { unit: unitSay });
        b = undefined;
      }
    } else {
      a = need("median", "the median, the value half the particles are below", dim);
      if (a !== undefined && !(a > 0)) {
        fail("E_OUT_OF_RANGE", base + "/median", "the median of a lognormal distribution must be positive", { unit: unitSay });
        a = undefined;
      }
      b = need("sigmaLog", "the standard deviation of ln x, a plain number such as 0.05 for about 5 %", "fraction");
      if (b !== undefined && !(b > 0)) {
        fail("E_OUT_OF_RANGE", base + "/sigmaLog", "sigmaLog must be positive (use a constant for no spread)", { unit: "1" });
        b = undefined;
      }
    }
    let truncate: Truncation | undefined;
    if (spec.truncate !== undefined) {
      const t = spec.truncate;
      if (!isObj(t) || (t.min === undefined && t.max === undefined)) fail("E_SCHEMA_INVALID", base + "/truncate", "truncate is an object with a min, a max or both");
      else {
        for (const key of Object.keys(t)) if (key !== "min" && key !== "max") fail("E_SCHEMA_INVALID", base + "/truncate/" + key, "unknown key '" + key + "' in a truncation (it has min, max)");
        const tmin = t.min === undefined ? undefined : qty(t.min, dim, base + "/truncate/min");
        const tmax = t.max === undefined ? undefined : qty(t.max, dim, base + "/truncate/max");
        if ((t.min !== undefined && tmin === undefined) || (t.max !== undefined && tmax === undefined)) ok = false;
        else if (tmin !== undefined && tmax !== undefined && !(tmax > tmin)) fail("E_OUT_OF_RANGE", base + "/truncate", "the truncation range is empty: max " + tmax + " is not above min " + tmin + " " + unitSay, { unit: unitSay });
        else truncate = { ...(tmin !== undefined ? { min: tmin } : {}), ...(tmax !== undefined ? { max: tmax } : {}) };
      }
    }
    if (a !== undefined && b !== undefined && ok) dist = k === "normal" ? { kind: "normal", mean: a, stdDev: b, ...(truncate ? { truncate } : {}) } : { kind: "lognormal", median: a, sigmaLog: b, ...(truncate ? { truncate } : {}) };
  }
  if (!ok || !dist) return undefined;
  const kept = keptFractions(dist, v);
  if (dist.kind !== "constant" && kept.valid < POPULATION_MIN_ACCEPTANCE) {
    bad("E_POPULATION_UNSAMPLABLE", base, "this distribution cannot be sampled: only " + (kept.valid * 100).toPrecision(2) + " % of its draws are inside its truncation and the valid range of " + v + " (the least allowed is " + POPULATION_MIN_ACCEPTANCE * 100 + " %); change its parameters or its truncation");
    return undefined;
  }
  if (dist.kind !== "constant" && kept.lossToRange > POPULATION_WARN_LOSS) {
    warn("W_POPULATION_REJECTION", base, "about " + (kept.lossToRange * 100).toPrecision(2) + " % of this distribution's draws are not valid values of " + v + " and are thrown away (counted in the result); the sample is then the distribution conditioned on being valid, with a different mean and spread from the one stated");
  }
  return dist;
}
