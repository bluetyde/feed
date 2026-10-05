// Export a results record as CSV for a lab report. Every export carries the thermal-only statement and where the numbers came from.

import { ResultsRecord } from "./resultsParser";

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
