// Quantity parsing: every physical input is {value, unit}; the unit must belong to the expected dimension.
// SI is used inside the app (docs/ARCHITECTURE.md, Conventions).

export type Dimension = "length" | "temperature" | "linearPower" | "conductivity" | "conductivityPerK" | "htc" | "time" | "volumetricHeatCapacity" | "volumetricHeatCapacityPerK" | "volumetricHeatCapacityPerK2" | "conductivityPerK2" | "conductivityPerK3" | "expansion" | "expansionPerK" | "pressure" | "pressurePerK" | "burnup" | "power" | "reactivity" | "reactivityPerK" | "reactivityPerK2" | "rate" | "fraction";

interface UnitDef {
  dim: Dimension;
  scale: number;
  offset?: number;
}

const UNITS: Record<string, UnitDef> = {
  m: { dim: "length", scale: 1 },
  cm: { dim: "length", scale: 1e-2 },
  mm: { dim: "length", scale: 1e-3 },
  K: { dim: "temperature", scale: 1 },
  degC: { dim: "temperature", scale: 1, offset: 273.15 },
  "W/m": { dim: "linearPower", scale: 1 },
  "kW/m": { dim: "linearPower", scale: 1e3 },
  "MW/m": { dim: "linearPower", scale: 1e6 },
  "W/cm": { dim: "linearPower", scale: 1e2 },
  "W/m/K": { dim: "conductivity", scale: 1 },
  "W/m/K2": { dim: "conductivityPerK", scale: 1 },
  "W/m/K3": { dim: "conductivityPerK2", scale: 1 },
  "W/m/K4": { dim: "conductivityPerK3", scale: 1 },
  // linear thermal expansion coefficient (a length change per length per kelvin)
  "1/K": { dim: "expansion", scale: 1 },
  "1e-6/K": { dim: "expansion", scale: 1e-6 },
  "ppm/K": { dim: "expansion", scale: 1e-6 },
  "1/K2": { dim: "expansionPerK", scale: 1 },
  // burnup per tonne (or kg) of HEAVY METAL; 1 MWd/kgHM is 1 GWd/tHM. The oxide basis is a different thing and is not accepted (docs/plans/10-burnup.md).
  "MWd/kgHM": { dim: "burnup", scale: 1 },
  "GWd/tHM": { dim: "burnup", scale: 1 },
  "MWd/tHM": { dim: "burnup", scale: 1e-3 },
  "1e-9/K2": { dim: "expansionPerK", scale: 1e-9 },
  // pressure and stress (Young's modulus, strength); psi is 6894.757293168 Pa
  Pa: { dim: "pressure", scale: 1 },
  kPa: { dim: "pressure", scale: 1e3 },
  MPa: { dim: "pressure", scale: 1e6 },
  GPa: { dim: "pressure", scale: 1e9 },
  psi: { dim: "pressure", scale: 6894.757293168 },
  ksi: { dim: "pressure", scale: 6894757.293168 },
  "Pa/K": { dim: "pressurePerK", scale: 1 },
  "MPa/K": { dim: "pressurePerK", scale: 1e6 },
  "GPa/K": { dim: "pressurePerK", scale: 1e9 },
  "W/m2/K": { dim: "htc", scale: 1 },
  "kW/m2/K": { dim: "htc", scale: 1e3 },
  s: { dim: "time", scale: 1 },
  ms: { dim: "time", scale: 1e-3 },
  us: { dim: "time", scale: 1e-6 },
  "J/m3/K": { dim: "volumetricHeatCapacity", scale: 1 },
  "J/cm3/K": { dim: "volumetricHeatCapacity", scale: 1e6 },
  "MJ/m3/K": { dim: "volumetricHeatCapacity", scale: 1e6 },
  "J/m3/K2": { dim: "volumetricHeatCapacityPerK", scale: 1 },
  "J/cm3/K2": { dim: "volumetricHeatCapacityPerK", scale: 1e6 },
  "MJ/m3/K2": { dim: "volumetricHeatCapacityPerK", scale: 1e6 },
  "J/m3/K3": { dim: "volumetricHeatCapacityPerK2", scale: 1 },
  "J/cm3/K3": { dim: "volumetricHeatCapacityPerK2", scale: 1e6 },
  "MJ/m3/K3": { dim: "volumetricHeatCapacityPerK2", scale: 1e6 },
  W: { dim: "power", scale: 1 },
  kW: { dim: "power", scale: 1e3 },
  MW: { dim: "power", scale: 1e6 },
  // reactivity as a fraction of k (delta-k over k). The dollar needs the delayed fraction of the case and is converted by the validator, not here.
  "dk/k": { dim: "reactivity", scale: 1 },
  pcm: { dim: "reactivity", scale: 1e-5 },
  "dk/k/K": { dim: "reactivityPerK", scale: 1 },
  "pcm/K": { dim: "reactivityPerK", scale: 1e-5 },
  "dk/k/K2": { dim: "reactivityPerK2", scale: 1 },
  "pcm/K2": { dim: "reactivityPerK2", scale: 1e-5 },
  "1/s": { dim: "rate", scale: 1 },
  "1": { dim: "fraction", scale: 1 },
  "%": { dim: "fraction", scale: 0.01 },
};

export const SI_UNIT: Record<Dimension, string> = {
  length: "m",
  temperature: "K",
  linearPower: "W/m",
  conductivity: "W/m/K",
  conductivityPerK: "W/m/K2",
  conductivityPerK2: "W/m/K3",
  conductivityPerK3: "W/m/K4",
  expansion: "1/K",
  expansionPerK: "1/K2",
  pressure: "Pa",
  pressurePerK: "Pa/K",
  burnup: "MWd/kgHM",
  htc: "W/m2/K",
  time: "s",
  volumetricHeatCapacity: "J/m3/K",
  volumetricHeatCapacityPerK: "J/m3/K2",
  volumetricHeatCapacityPerK2: "J/m3/K3",
  power: "W",
  reactivity: "dk/k",
  reactivityPerK: "dk/k/K",
  reactivityPerK2: "dk/k/K2",
  rate: "1/s",
  fraction: "1",
};

/** A value in SI as a number in `unit` (the inverse of toSI), to 12 significant digits so that 0.0041 m is 4.1 mm and not 4.1000000000000005. Undefined for an unknown unit or one of another dimension. */
export function fromSI(si: number, unit: string, dim: Dimension): number | undefined {
  const def = Object.prototype.hasOwnProperty.call(UNITS, unit) ? UNITS[unit] : undefined;
  if (!def || def.dim !== dim || !Number.isFinite(si)) return undefined;
  const v = (si - (def.offset ?? 0)) / def.scale;
  return Number.isFinite(v) ? Number(v.toPrecision(12)) : undefined;
}

export type QuantityResult = { ok: true; si: number } | { ok: false; reason: string };

/** Convert `{value, unit}` to SI. A bare number, a missing unit, an unknown unit or a unit of another dimension is refused. */
export function toSI(q: unknown, dim: Dimension): QuantityResult {
  if (typeof q === "number") return { ok: false, reason: "a bare number has no unit; give {value, unit} (expected " + SI_UNIT[dim] + " or an equivalent)" };
  if (typeof q !== "object" || q === null || Array.isArray(q)) return { ok: false, reason: "expected {value, unit}" };
  const { value, unit } = q as { value?: unknown; unit?: unknown };
  if (typeof unit !== "string" || unit === "") return { ok: false, reason: "unit is missing (expected " + SI_UNIT[dim] + " or an equivalent)" };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "value must be a finite number" };
  const def = Object.prototype.hasOwnProperty.call(UNITS, unit) ? UNITS[unit] : undefined;
  if (!def) return { ok: false, reason: "unknown unit '" + unit + "'" };
  if (def.dim !== dim) return { ok: false, reason: "unit '" + unit + "' is a " + def.dim + " unit, expected " + dim + " (" + SI_UNIT[dim] + ")" };
  const si = value * def.scale + (def.offset ?? 0);
  if (!Number.isFinite(si)) return { ok: false, reason: "the value is too large: it overflows when converted to " + SI_UNIT[dim] };
  return { ok: true, si };
}
