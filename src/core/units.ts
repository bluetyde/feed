// Quantity parsing: every physical input is {value, unit}; the unit must belong to the expected dimension.
// SI is used inside the app (docs/ARCHITECTURE.md, Conventions).

export type Dimension = "length" | "temperature" | "linearPower" | "conductivity" | "conductivityPerK" | "htc" | "time" | "volumetricHeatCapacity" | "volumetricHeatCapacityPerK";

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
};

export const SI_UNIT: Record<Dimension, string> = {
  length: "m",
  temperature: "K",
  linearPower: "W/m",
  conductivity: "W/m/K",
  conductivityPerK: "W/m/K2",
  htc: "W/m2/K",
  time: "s",
  volumetricHeatCapacity: "J/m3/K",
  volumetricHeatCapacityPerK: "J/m3/K2",
};

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
