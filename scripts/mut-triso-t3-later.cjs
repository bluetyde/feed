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

module.exports = { 2: stage2 };
