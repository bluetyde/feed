// Temperature limits of a coated particle's regions (plan 13, T3 stage 2). A limit is an INPUT of the case with the source it comes from (FEED has no limits of its own, as for a pin:
// docs/temperature-limits.md); a rule says that the hottest cell of one region (the kernel or a coating layer) stays at or below a value. FEED reports, for each rule, the smallest
// margin the run reaches and where. It computes no stress: a temperature below a limit is not an integrity assessment, and the check says so.

import { showT } from "./limits";
import type { Check } from "./resultsParser";
import type { TrisoRegionName } from "./trisoSolve";

export interface TrisoLimitRule {
  name: string;
  region: TrisoRegionName;
  /** K. */
  maxTemperature: number;
  source: string;
}

/** The hottest cell of every region of the particle at one moment of a run (a steady result has one moment; a transient has one per output, and one per step of the independent solution). */
export interface TrisoLimitState {
  time: number;
  max: Partial<Record<TrisoRegionName, number>>;
}

export interface TrisoLimitOutcome {
  /** The smallest (limit minus temperature), K; negative when exceeded; null when no moment was judged. */
  margin: number | null;
  worst: { time: number; temperature: number } | null;
  /** Moments whose temperature for the rule's region was not a finite number. They are counted, never skipped: a rule that cannot be judged does not pass. */
  invalid: number;
}

export function evaluateTrisoLimit(rule: TrisoLimitRule, states: readonly TrisoLimitState[]): TrisoLimitOutcome {
  let margin: number | null = null;
  let worst: TrisoLimitOutcome["worst"] = null;
  let invalid = 0;
  for (const s of states) {
    const T = s.max[rule.region];
    if (T === undefined || !Number.isFinite(T)) {
      invalid++;
      continue;
    }
    const m = rule.maxTemperature - T;
    if (margin === null || m < margin) {
      margin = m;
      worst = { time: s.time, temperature: T };
    }
  }
  return { margin, worst, invalid };
}

/**
 * The checks for a set of rules, one each, in order: `temperatureLimit1`, ... (the pin's ids). `observed` are the moments of the solver's own result; `independent` (a transient) are the
 * moments of every step of the independent solution, which sees a peak between two outputs. The verdict takes the worse of the two; the note says which one decided.
 */
export function trisoLimitChecks(rules: readonly TrisoLimitRule[], observed: readonly TrisoLimitState[], independent?: readonly TrisoLimitState[]): Check[] {
  return rules.map((rule, i) => {
    const a = evaluateTrisoLimit(rule, observed);
    const b = independent ? evaluateTrisoLimit(rule, independent) : null;
    const pick = b && b.margin !== null && (a.margin === null || b.margin < a.margin) ? { o: b, basis: "the independent solution (every step)" } : { o: a, basis: independent ? "the solver's outputs" : "the solver's result" };
    const o = pick.o;
    const invalid = a.invalid + (b ? b.invalid : 0);
    const id = `temperatureLimit${i + 1}`;
    const label = `Temperature limit: ${rule.name}`;
    const head = `${rule.name}: the hottest ${rule.region} cell stays at or below ${showT(rule.maxTemperature)}. Source: ${rule.source}.`;
    const tail = " This check computes no stress; staying below a limit is not an integrity assessment. It judges cell values: a region's face can be hotter than its hottest cell by up to half a cell's drop, so refine the mesh where a margin is small.";
    if (invalid > 0 || o.margin === null || o.worst === null) {
      return { id, label, value: null, unit: "K", verdict: "fail" as const, note: `${head} ${invalid > 0 ? invalid + " moment(s) had a temperature that is not a finite number" : "no moment could be judged"}, so the limit cannot be judged and the check fails.` + tail };
    }
    return {
      id,
      label,
      value: o.margin,
      unit: "K",
      verdict: o.margin >= 0 ? ("pass" as const) : ("fail" as const),
      note: `${head} Smallest margin ${o.margin.toFixed(2)} K: ${showT(o.worst.temperature)} at ${independent ? `t = ${Number(o.worst.time.toPrecision(6))} s` : "the result"}, from ${pick.basis}.` + tail,
    };
  });
}
