// Compare two completed runs: what inputs differ, how the results differ, and (only when it is meaningful) the point-by-point
// temperature difference. Pure functions on saved records; no solver. Thermal-only: nothing here implies stress or integrity.

import { ResultsRecord } from "./resultsParser";
import { NormalizedCase } from "./validate";

export interface DiffRow {
  path: string;
  a: string;
  b: string;
}

const isQuantity = (v: unknown): v is { value: number; unit: string } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).sort().join() === "unit,value" && typeof (v as any).value === "number" && typeof (v as any).unit === "string";

/** Flatten a case document to path -> display string. A {value, unit} pair is one leaf ("20 kW/m"). */
export function flatten(doc: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (isQuantity(doc)) out[prefix] = `${doc.value} ${doc.unit}`;
  else if (Array.isArray(doc)) out[prefix] = JSON.stringify(doc);
  else if (typeof doc === "object" && doc !== null) for (const [k, v] of Object.entries(doc)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  else out[prefix] = String(doc);
  return out;
}

/** Fields that differ between two case documents, sorted by path. A field present on one side only shows "(absent)". */
export function diffCases(a: unknown, b: unknown): DiffRow[] {
  const fa = flatten(a);
  const fb = flatten(b);
  const paths = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  const rows: DiffRow[] = [];
  for (const path of paths) {
    const x = fa[path] ?? "(absent)";
    const y = fb[path] ?? "(absent)";
    if (x !== y) rows.push({ path, a: x, b: y });
  }
  return rows;
}

export interface SummaryRow {
  id: string;
  label: string;
  unit: string;
  a: number | null;
  b: number | null;
  /** b - a, null if either side is missing. */
  delta: number | null;
}

const SUMMARY_FIELDS: [keyof ResultsRecord["summary"], string][] = [
  ["centreCellT", "Centre cell temperature"],
  ["fuelSurfaceCellT", "Fuel surface cell"],
  ["claddingInnerCellT", "Cladding inner cell"],
  ["claddingOuterWallT", "Outer wall"],
  ["maxT", "Maximum"],
  ["minT", "Minimum"],
];

export interface CheckRow {
  id: string;
  label: string;
  a: string;
  b: string;
}

export function compareResults(ra: ResultsRecord, rb: ResultsRecord): { summary: SummaryRow[]; checks: CheckRow[] } {
  const summary = SUMMARY_FIELDS.map(([id, label]) => {
    const a = ra.summary[id] as number | null;
    const b = rb.summary[id] as number | null;
    return { id, label, unit: "K", a, b, delta: a === null || b === null ? null : b - a };
  });
  const ids = [...new Set([...ra.checks.map((c) => c.id), ...rb.checks.map((c) => c.id)])];
  const show = (r: ResultsRecord, id: string) => {
    const c = r.checks.find((x) => x.id === id);
    return c ? c.verdict : "(absent)";
  };
  const checks = ids.map((id) => ({ id, label: (ra.checks.find((c) => c.id === id) ?? rb.checks.find((c) => c.id === id))!.label, a: show(ra, id), b: show(rb, id) }));
  return { summary, checks };
}

/**
 * B minus A at each cell centre. Only defined when both runs have the same geometry and the same mesh (so the cell centres
 * coincide); otherwise the reason is returned and no difference is invented by interpolation.
 */
export function profileDifference(na: NormalizedCase, nb: NormalizedCase, ra: ResultsRecord, rb: ResultsRecord): { r: number[]; dT: number[] } | { reason: string } {
  const same =
    na.fuelRadius === nb.fuelRadius &&
    na.claddingInnerRadius === nb.claddingInnerRadius &&
    na.claddingOuterRadius === nb.claddingOuterRadius &&
    na.mesh.fuelCells === nb.mesh.fuelCells &&
    na.mesh.claddingCells === nb.mesh.claddingCells;
  if (!same) return { reason: "The runs differ in geometry or mesh, so their cells do not line up. Compare the summary values and the overlaid profiles instead." };
  if (ra.radial.length !== rb.radial.length) return { reason: "The runs have a different number of cells." };
  const r = ra.radial.map((p) => p.r);
  const dT = ra.radial.map((p, i) => rb.radial[i]!.T - p.T);
  return { r, dT };
}
