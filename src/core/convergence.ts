// Convergence of an OFFBEAT thermal run, judged from what OFFBEAT prints (F0 exit review, finding 2; probe: docs/spike/F0-note.md).
//
// OFFBEAT's outer loop ends a time step when the solvers say converged OR when `maxOuterIter` is reached, and in the second case it
// accepts the step silently: the field is written, nothing is printed, the exit code is the same. So "the final time was written and
// the fields are finite" proves nothing about convergence; the log lines OFFBEAT prints for each outer iteration do. This module
// reads them and applies OFFBEAT's own thermal criterion (offbeatLib/physicsSubSolvers/thermalSubSolver/thermalSubSolver.C,
// converged(), at the pinned commit) to the LAST outer iteration of a step, with the tolerances the run was given.
//
// It is stricter than OFFBEAT in one respect: a residual that is not a finite number is never converged (OFFBEAT's own test
// `absErr > tolerance` is false for NaN, which it would count as converged). Thermal only: FEED switches the mechanics off.

/** The thermal convergence settings of a run: the `stressAnalysis` dictionary of system/fvSolution. */
export interface ConvergenceCriterion {
  maxOuterIter: number;
  /** key `T`, default 1e-6 */
  T: number;
  /** key `relT` (required when useRelResT) */
  relT: number;
  /** key `absErrT`, default 0 */
  absErrT: number;
  /** key `useRelResT`, default true */
  useRelResT: boolean;
}

/** The three numbers OFFBEAT's thermal criterion looks at, for one outer iteration. */
export interface IterationResiduals {
  /** Initial residual of the first T solve of the iteration (OFFBEAT keeps the first inner iteration's) */
  initialResidual: number;
  /** `relResidualT is` (the last inner iteration's) */
  relResidual: number;
  /** `absErrT is` (the last inner iteration's) */
  absErr: number;
}

export interface StepRecord {
  /** The time printed after `Time =` (user time, as OFFBEAT prints it) */
  time: number;
  iterations: number;
  /** Residuals of the last outer iteration, when all three were printed */
  last: IterationResiduals | undefined;
}

export type CriterionResult = { ok: true; criterion: ConvergenceCriterion } | { ok: false; message: string };

const FLOAT = "([-+]?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?|[-+]?nan|[-+]?inf)";
const num = (s: string): number => {
  const t = s.toLowerCase();
  if (t.includes("nan")) return NaN;
  if (t.includes("inf")) return t.startsWith("-") ? -Infinity : Infinity;
  return Number(s);
};

/** Read the criterion from the text of system/fvSolution (the file OFFBEAT was given). Refuses what it cannot read. */
export function readCriterion(fvSolution: string): CriterionResult {
  // the stressAnalysis dictionary: from its name to the matching closing brace (nested braces allowed, e.g. nCorrectors { ... })
  const m = /(^|\s)stressAnalysis\s*\{/.exec(fvSolution);
  if (!m) return { ok: false, message: "system/fvSolution has no stressAnalysis dictionary" };
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < fvSolution.length && depth > 0) {
    const ch = fvSolution[i++];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth !== 0) return { ok: false, message: "the stressAnalysis dictionary is not closed" };
  const body = fvSolution.slice(start, i - 1);
  // top-level entries only: blank out nested dictionaries so `T 1;` inside one cannot be mistaken for the key
  let flat = "";
  depth = 0;
  for (const ch of body) {
    if (ch === "{") depth++;
    if (depth === 0) flat += ch;
    if (ch === "}") depth--;
  }
  const key = (name: string): string | undefined => new RegExp(`(?:^|[\\s;])${name}\\s+([^;\\s]+)\\s*;`).exec(flat)?.[1];
  const number = (name: string, dflt?: number): number | undefined => {
    const raw = key(name);
    if (raw === undefined) return dflt;
    const v = Number(raw);
    return Number.isFinite(v) ? v : NaN;
  };
  const maxOuterIter = number("maxOuterIter");
  if (maxOuterIter === undefined || !Number.isInteger(maxOuterIter) || maxOuterIter < 1) return { ok: false, message: "stressAnalysis has no valid maxOuterIter" };
  const T = number("T", 1e-6)!;
  const absErrT = number("absErrT", 0)!;
  const rawUse = key("useRelResT");
  const useRelResT = rawUse === undefined ? true : /^(true|on|yes|1)$/i.test(rawUse);
  if (rawUse !== undefined && !/^(true|false|on|off|yes|no|1|0)$/i.test(rawUse)) return { ok: false, message: `stressAnalysis useRelResT ${rawUse} is not a boolean` };
  const relT = number("relT");
  if (useRelResT && relT === undefined) return { ok: false, message: "stressAnalysis has no relT (needed because useRelResT is on)" };
  if (![T, absErrT].every(Number.isFinite) || (relT !== undefined && !Number.isFinite(relT))) return { ok: false, message: "stressAnalysis has a tolerance that is not a number" };
  return { ok: true, criterion: { maxOuterIter, T, relT: relT ?? NaN, absErrT, useRelResT } };
}

/** OFFBEAT's thermal criterion for one outer iteration (thermalSubSolver::converged), plus: a value that is not finite is not converged. */
export function thermalConverged(r: IterationResiduals, c: ConvergenceCriterion): boolean {
  if (![r.initialResidual, r.relResidual, r.absErr].every(Number.isFinite)) return false;
  if (!(r.absErr > c.absErrT)) return true;
  if (c.useRelResT) {
    return (r.initialResidual < c.T && r.relResidual < c.relT) || r.initialResidual < c.T / 10 || r.relResidual < c.relT / 10;
  }
  return r.initialResidual < c.T;
}

/** The time steps of an OFFBEAT log, each with its number of outer iterations and the residuals of its last one. */
export function parseSteps(log: string): StepRecord[] {
  const steps: StepRecord[] = [];
  let step: StepRecord | undefined;
  let first: number | undefined;
  let rel: number | undefined;
  let abs: number | undefined;
  const close = () => {
    if (step && step.iterations > 0) {
      step.last = first !== undefined && rel !== undefined && abs !== undefined ? { initialResidual: first, relResidual: rel, absErr: abs } : undefined;
    }
  };
  const reTime = new RegExp(`^Time = ${FLOAT}`);
  const reIter = /^OuterIteration n\. [0-9]+/;
  const reInit = new RegExp(`Solving for T, Initial residual = ${FLOAT}`);
  const reRel = new RegExp(`^relResidualT is ${FLOAT}`);
  const reAbs = new RegExp(`^absErrT is ${FLOAT}`);
  for (const line of log.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = reTime.exec(line))) {
      close();
      step = { time: num(m[1]!), iterations: 0, last: undefined };
      steps.push(step);
      first = rel = abs = undefined;
    } else if (step && reIter.test(line)) {
      close();
      step.iterations++;
      first = rel = abs = undefined;
    } else if (step && step.iterations > 0) {
      if ((m = reInit.exec(line)) && first === undefined) first = num(m[1]!);
      else if ((m = reRel.exec(line))) rel = num(m[1]!);
      else if ((m = reAbs.exec(line))) abs = num(m[1]!);
    }
  }
  close();
  return steps;
}

export type ConvergenceVerdict = { ok: true; stepsChecked: number; iterationsInLastStep: number } | { ok: false; code: "E_NOT_CONVERGED" | "E_OUTPUT_INCOMPLETE"; message: string };

/**
 * Judge a run from its log. A steady case is a result when its FINAL time step converged; a transient case needs EVERY step to
 * converge (an unconverged step in the middle corrupts the history that follows). A log with no outer-iteration records, or a
 * step whose last iteration lacks any of the three numbers, cannot be judged and is refused rather than assumed fine.
 */
export function judgeConvergence(log: string, criterion: ConvergenceCriterion, mode: "final-step" | "every-step"): ConvergenceVerdict {
  const steps = parseSteps(log);
  if (steps.length === 0 || steps.every((s) => s.iterations === 0)) {
    return { ok: false, code: "E_OUTPUT_INCOMPLETE", message: "The solver log has no outer-iteration records, so convergence cannot be judged; the run is not accepted as a result." };
  }
  const toCheck = mode === "final-step" ? [steps[steps.length - 1]!] : steps;
  for (const s of toCheck) {
    if (s.iterations === 0 || !s.last) {
      return { ok: false, code: "E_OUTPUT_INCOMPLETE", message: `The solver log for the time step at t = ${s.time} has no complete residual record (initial residual, relResidualT and absErrT), so convergence cannot be judged.` };
    }
    if (!thermalConverged(s.last, criterion)) {
      const l = s.last;
      return {
        ok: false,
        code: "E_NOT_CONVERGED",
        message:
          `The solver did not converge at t = ${s.time}: after ${s.iterations} outer iteration${s.iterations === 1 ? "" : "s"} (limit ${criterion.maxOuterIter}) the last had absErrT ${l.absErr}, relResidualT ${l.relResidual} and initial residual ${l.initialResidual}, ` +
          `against T ${criterion.T}, relT ${Number.isFinite(criterion.relT) ? criterion.relT : "(unused)"} and absErrT ${criterion.absErrT}. ` +
          `OFFBEAT accepts and writes such a step without a warning, so the output is not a result.`,
      };
    }
  }
  const last = steps[steps.length - 1]!;
  return { ok: true, stepsChecked: toCheck.length, iterationsInLastStep: last.iterations };
}
