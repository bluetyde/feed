// Mesh-refinement study: the same case on a sequence of meshes, error against the closed form, observed order of convergence.
// Pure functions on saved results (docs/plans/04-verification.md, level 5). The closed form is the reference, so a study exists
// only for cases the results parser can check (constant or linear conductivity).

import { ResultsRecord } from "./resultsParser";
import { NormalizedCase } from "./validate";

export interface StudyInput {
  id: string;
  normalized: NormalizedCase;
  results: ResultsRecord;
}

export interface StudyLevel {
  id: string;
  fuelCells: number;
  claddingCells: number;
  /** Largest deviation from the closed form at the cell centres (K). */
  fuelError: number;
  claddingError: number;
  /** Observed order from the previous level to this one (null for the first level, or when an error is at the noise floor). */
  fuelOrder: number | null;
  claddingOrder: number | null;
}

export interface Study {
  levels: StudyLevel[];
  /** Expected order for the cell-centred scheme. */
  expectedOrder: 2;
  verdict: "pass" | "fail" | "na";
  note: string;
}

/** Below this deviation (K) the error is at the solver's own tolerance and an order cannot be estimated. */
export const NOISE_FLOOR = 1e-4;
/** Observed order that counts as close to second order. Same gate as the saved refinement tests (error ratio above 2.5 per doubling is order 1.32). */
export const MIN_ORDER = 1.3;

/** The case with the mesh removed: levels may differ in the mesh and nothing else. */
const withoutMesh = (n: NormalizedCase) => JSON.stringify({ ...n, mesh: undefined });

export function refinementStudy(inputs: StudyInput[]): Study | { error: string } {
  if (inputs.length < 3) return { error: "A refinement study needs at least three meshes." };
  const sorted = [...inputs].sort((a, b) => a.normalized.mesh.fuelCells - b.normalized.mesh.fuelCells);
  const ref = withoutMesh(sorted[0]!.normalized);
  if (sorted.some((s) => withoutMesh(s.normalized) !== ref)) return { error: "The runs differ in more than the mesh, so they are not a refinement study." };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.normalized.mesh.fuelCells <= sorted[i - 1]!.normalized.mesh.fuelCells) return { error: "The meshes must get finer: each level needs more fuel cells than the one before." };
  }
  const errOf = (r: ResultsRecord, id: string): number | undefined => r.checks.find((c) => c.id === id)?.value ?? undefined;
  const levels: StudyLevel[] = [];
  for (const s of sorted) {
    const fe = errOf(s.results, "closedFormFuel");
    const ce = errOf(s.results, "closedFormCladding");
    if (fe === undefined || ce === undefined) return { error: "Run " + s.id + " has no closed-form comparison, so no error can be measured." };
    const prev = levels[levels.length - 1];
    const order = (e0: number | undefined, e1: number, n0: number | undefined, n1: number) =>
      e0 === undefined || n0 === undefined || e0 < NOISE_FLOOR || e1 < NOISE_FLOOR ? null : Math.log2(e0 / e1) / Math.log2(n1 / n0);
    levels.push({
      id: s.id,
      fuelCells: s.normalized.mesh.fuelCells,
      claddingCells: s.normalized.mesh.claddingCells,
      fuelError: fe,
      claddingError: ce,
      fuelOrder: order(prev?.fuelError, fe, prev?.fuelCells, s.normalized.mesh.fuelCells),
      claddingOrder: order(prev?.claddingError, ce, prev?.claddingCells, s.normalized.mesh.claddingCells),
    });
  }
  // Verdict from the fuel (the larger error): every measurable step must be at least MIN_ORDER; unmeasurable steps do not count either way.
  const orders = levels.map((l) => l.fuelOrder).filter((o): o is number => o !== null);
  let verdict: Study["verdict"];
  let note: string;
  if (orders.length === 0) {
    verdict = "na";
    note = "The errors are at the solver's tolerance on every level, so no order can be estimated. The case is converged to the closed form.";
  } else if (orders.every((o) => o >= MIN_ORDER)) {
    verdict = "pass";
    note = `Observed order ${orders.map((o) => o.toFixed(2)).join(", ")} (expected 2; the gate is at least ${MIN_ORDER}).`;
  } else {
    verdict = "fail";
    note = `Observed order ${orders.map((o) => o.toFixed(2)).join(", ")} is below ${MIN_ORDER}: refining the mesh is not reducing the error as a second-order scheme should, so a source of error other than the mesh is present (for example an unfinished steady state).`;
  }
  return { levels, expectedOrder: 2, verdict, note };
}

/** The cases for a study: the same case with the fuel and cladding cell counts multiplied. */
export function studyCases(doc: any, factors = [1, 2, 4]): any[] {
  return factors.map((f) => {
    const d = JSON.parse(JSON.stringify(doc));
    d.mesh = { ...d.mesh, fuelCells: Math.round(doc.mesh.fuelCells * f), claddingCells: Math.round(doc.mesh.claddingCells * f) };
    return d;
  });
}
