// Export a results record as CSV for a lab report. Every export carries the thermal-only statement and where the numbers came from.

import { ResultsRecord } from "./resultsParser";
import { TransientResultsRecord } from "./transientResults";
import type { PebbleResultsRecord } from "./pebbleResults";
import type { TrisoResultsRecord } from "./trisoResults";
import type { TrisoTransientResultsRecord } from "./trisoTransientResults";

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

/** A pebble (plan 13, T4): one row per cell, the regions' faces, then the hottest particle of each two-scale entry. */
export function pebbleResultsToCsv(res: PebbleResultsRecord, meta: { runId: string; caseName: string; solver: string; caseHash: string }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ");
  const lines = [
    "# Fuel Performance Studio results (pebble)",
    "# " + clean(res.thermalOnly),
    "# " + clean(res.compact.label),
    "# case: " + clean(meta.caseName) + " (" + clean(res.caseId) + ")",
    "# run: " + clean(meta.runId) + "  solver: " + clean(meta.solver) + "  case hash: " + clean(meta.caseHash),
    "# time: " + res.time + " s (steady state); values are at cell centres, on the sphere the 2 degree wedge solves (radii 0.03 % smaller than the case's)",
    "r_um,T_K,T_C,region",
  ];
  for (const p of res.cells) lines.push(`${p.r * 1e6},${p.T},${p.T - 273.15},${p.region}`);
  lines.push("# region,inner_face_T_K,outer_face_T_K,drop_K,hottest_cell_T_K");
  for (const r of res.regions) lines.push(`# ${r.name},${r.innerFaceT},${r.outerFaceT},${r.drop},${r.hottestCellT}`);
  lines.push("# hottest particle (two-scale): at,matrix_T_K,kernel_centre_T_K,kernel_surface_T_K,matrix_shell_drop_K");
  for (const e of res.compact.twoScale) lines.push(`# ${e.at},${e.matrixT},${e.particle.kernelCentreT},${e.particle.kernelSurfaceT},${e.particle.shellDeltaT}`);
  return lines.join("\n") + "\n";
}

/** A coated particle (plan 13): one row per cell, then the regions' faces. */
export function trisoResultsToCsv(res: TrisoResultsRecord, meta: { runId: string; caseName: string; solver: string; caseHash: string }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ");
  const lines = [
    "# Fuel Performance Studio results (coated particle)",
    "# " + clean(res.thermalOnly),
    "# case: " + clean(meta.caseName) + " (" + clean(res.caseId) + ")",
    "# run: " + clean(meta.runId) + "  solver: " + clean(meta.solver) + "  case hash: " + clean(meta.caseHash),
    "# time: " + res.time + " s (steady state); values are at cell centres, on the sphere the 2 degree wedge solves (radii 0.03 % smaller than the case's)",
    "r_um,T_K,T_C,region",
  ];
  for (const p of res.cells) lines.push(`${p.r * 1e6},${p.T},${p.T - 273.15},${p.region}`);
  lines.push("# region,inner_face_T_K,outer_face_T_K,drop_K,hottest_cell_T_K");
  for (const r of res.regions) lines.push(`# ${r.name},${r.innerFaceT},${r.outerFaceT},${r.drop},${r.hottestCellT}`);
  return lines.join("\n") + "\n";
}

/** A coated particle's transient (plan 13): one row per output time, then the hottest cell of each region. */
export function trisoTransientResultsToCsv(res: TrisoTransientResultsRecord, meta: { runId: string; caseName: string; solver: string; caseHash: string }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ");
  const regions = Object.keys(res.series.regionMax);
  const lines = [
    "# Fuel Performance Studio results (coated particle, transient)",
    "# " + clean(res.thermalOnly),
    "# case: " + clean(meta.caseName) + " (" + clean(res.caseId) + ")",
    "# run: " + clean(meta.runId) + "  solver: " + clean(meta.solver) + "  case hash: " + clean(meta.caseHash),
    "# power is an input; temperatures are cell centres except the outer wall (patch value); energies are the nominal sphere's, per particle",
    ["time_s", "power_W", "deposited_J", "stored_J", "rejected_J", "peak_T_K", ...regions.map((r) => r + "_max_T_K"), "outer_wall_T_K", "gap_drop_K"].join(","),
  ];
  const s = res.series;
  s.time.forEach((t, i) => lines.push([t, s.power[i], s.deposited[i], s.stored[i], s.rejected[i], s.peakT[i], ...regions.map((r) => s.regionMax[r]![i]), s.wallT[i], s.gapDeltaT[i]].join(",")));
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
