// Export a results record as CSV for a lab report. Every export carries the thermal-only statement and where the numbers came from.

import { ResultsRecord } from "./resultsParser";
import { TransientResultsRecord } from "./transientResults";

export function resultsToCsv(res: ResultsRecord, meta: { runId: string; caseName: string; solver: string; caseHash: string }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ");
  const lines = [
    "# Fuel Performance Studio results",
    "# " + clean(res.thermalOnly),
    "# case: " + clean(meta.caseName) + " (" + clean(res.caseId) + ")",
    "# run: " + clean(meta.runId) + "  solver: " + clean(meta.solver) + "  case hash: " + clean(meta.caseHash),
    "# time: " + res.time + " s (steady state)",
    "# values are at cell centres; the first fuel cell is about half a cell from the axis",
    "r_mm,T_K,T_C,region",
  ];
  for (const p of res.radial) lines.push(`${p.r * 1000},${p.T},${p.T - 273.15},${p.region}`);
  return lines.join("\n") + "\n";
}

/** The time series of a transient: one row per output time. */
export function transientResultsToCsv(res: TransientResultsRecord, meta: { runId: string; caseName: string; solver: string; caseHash: string }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ");
  const lines = [
    "# Fuel Performance Studio results (transient)",
    "# " + clean(res.thermalOnly),
    "# case: " + clean(meta.caseName) + " (" + clean(res.caseId) + ")",
    "# run: " + clean(meta.runId) + "  solver: " + clean(meta.solver) + "  case hash: " + clean(meta.caseHash),
    "# power is an input; temperatures are cell centres except the outer wall (patch value); energies are per metre of rod",
    "time_s,power_W_per_m,deposited_J_per_m,stored_J_per_m,rejected_J_per_m,peak_T_K,fuel_surface_cell_T_K,cladding_inner_cell_T_K,outer_wall_T_K",
  ];
  const s = res.series;
  s.time.forEach((t, i) => lines.push([t, s.power[i], s.deposited[i], s.stored[i], s.rejected[i], s.peakT[i], s.fuelSurfaceCellT[i], s.claddingInnerCellT[i], s.claddingOuterWallT[i]].join(",")));
  return lines.join("\n") + "\n";
}
