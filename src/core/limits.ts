// Temperature limits of a case (docs/temperature-limits.md). A limit is an INPUT of the case, with the source it comes from, never a verdict built into FEED: a
// rule says that a region's hottest temperature must stay at or below a value, optionally only while the hottest cladding is at most or above a temperature (the
// TRIGA fuel limit is 1150 C while the cladding is at most 500 C and 950 C above it). FEED reports, for each rule, the smallest margin the run reaches and where.
// It computes no stress: a temperature below a limit is not an integrity assessment, and the check says so.

import type { Check } from "./resultsParser";

export interface LimitRule {
  name: string;
  region: "fuel" | "cladding";
  /** K. */
  maxTemperature: number;
  /** Only while the hottest cladding cell is at most / above this (K). Fuel rules only. */
  whileCladding?: { atMost?: number; above?: number };
  source: string;
}

/** The hottest cell of each solid at one moment of a run (a steady result has one moment; a transient has one per output, and one per step of the independent solution). */
export interface LimitState {
  time: number;
  fuelMax: number;
  claddingMax: number;
}

export interface LimitOutcome {
  /** Moments at which the rule applies (its cladding condition holds). */
  applied: number;
  /** The smallest (limit minus temperature) over those moments, K; negative when exceeded; null when the rule never applied. */
  margin: number | null;
  /** The moment of that smallest margin. */
  worst: { time: number; temperature: number; cladding: number } | null;
}

export const limitApplies = (rule: LimitRule, s: LimitState): boolean => {
  const w = rule.whileCladding;
  if (!w) return true;
  if (w.atMost !== undefined && !(s.claddingMax <= w.atMost)) return false;
  if (w.above !== undefined && !(s.claddingMax > w.above)) return false;
  return true;
};

export function evaluateLimit(rule: LimitRule, states: readonly LimitState[]): LimitOutcome {
  let applied = 0;
  let margin: number | null = null;
  let worst: LimitOutcome["worst"] = null;
  for (const s of states) {
    if (!limitApplies(rule, s)) continue;
    applied++;
    const T = rule.region === "fuel" ? s.fuelMax : s.claddingMax;
    const m = rule.maxTemperature - T;
    if (margin === null || m < margin) {
      margin = m;
      worst = { time: s.time, temperature: T, cladding: s.claddingMax };
    }
  }
  return { applied, margin, worst };
}

/** A temperature the way the SARs write it too: kelvin, with degrees Celsius beside it. */
export const showT = (K: number): string => `${Number(K.toFixed(2))} K (${Number((K - 273.15).toFixed(2))} C)`;

const condition = (rule: LimitRule): string => {
  const w = rule.whileCladding;
  if (!w) return "";
  const parts: string[] = [];
  if (w.above !== undefined) parts.push(`above ${showT(w.above)}`);
  if (w.atMost !== undefined) parts.push(`at most ${showT(w.atMost)}`);
  return ` while the hottest cladding is ${parts.join(" and ")}`;
};

/**
 * The checks for a set of rules. `observed` are the moments of the solver's own result; `independent` (transients) are the moments of every step of the independent
 * solution, which sees a peak between two outputs. The verdict takes the worse of the two; the note says which one decided and what was looked at.
 */
export function limitChecks(rules: readonly LimitRule[], observed: readonly LimitState[], independent?: readonly LimitState[]): Check[] {
  return rules.map((rule, i) => {
    const a = evaluateLimit(rule, observed);
    const b = independent ? evaluateLimit(rule, independent) : null;
    const pick = b && b.margin !== null && (a.margin === null || b.margin < a.margin) ? { o: b, basis: "the independent solution (every step)" } : { o: a, basis: independent ? "the solver's outputs" : "the solver's result" };
    const o = pick.o;
    const head = `${rule.name}: the hottest ${rule.region} stays at or below ${showT(rule.maxTemperature)}${condition(rule)}. Source: ${rule.source}.`;
    const tail = " FEED computes no stress; staying below a limit is not an integrity assessment.";
    const id = `temperatureLimit${i + 1}`;
    const label = `Temperature limit: ${rule.name}`;
    if (o.margin === null || o.worst === null) {
      return { id, label, value: null, unit: "K", verdict: "pass" as const, note: head + " The cladding condition never held in this run, so the limit was not in force." + tail };
    }
    const where = `${showT(o.worst.temperature)} at ${independent ? `t = ${Number(o.worst.time.toPrecision(6))} s` : "the result"} (cladding ${showT(o.worst.cladding)})`;
    return {
      id,
      label,
      value: o.margin,
      unit: "K",
      verdict: o.margin >= 0 ? ("pass" as const) : ("fail" as const),
      note: `${head} Smallest margin ${o.margin.toFixed(1)} K: ${where}, from ${pick.basis}; the rule was in force at ${o.applied} moment(s).` + tail,
    };
  });
}
