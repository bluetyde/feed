// The mechanics half of a result (docs/plans/09-mechanics.md M2): the displacement and the stress OFFBEAT wrote for each cell of a thermo-elastic run, read back as numbers,
// with the contact at the gap. What a result of this kind is, and is not, is in MECHANICS_TEXT, which every view and export carries.
//
// Sign convention: OFFBEAT's own. Stress is positive in tension, negative in compression (a fuel that is hotter than its cladding is compressed in the radial and hoop
// directions). The wedge is thin (0.25 degree) and lies along the x axis, so the x component of a vector or tensor is the radial one, y the hoop one (for a vector there is
// none) and z the axial one; OFFBEAT also writes the cylindrical components (`sigmaCyl`, with `cylindricalStress on`), and those are read when present.
import type { EffectiveMechanics } from "./mechanicalEval";
import type { Check } from "./resultsParser";
import type { MechanicsSpec } from "./validate";

export const MECHANICS_TEXT =
  "Thermo-elastic result: small strain, linear elastic, one radial slice. It has no creep, plasticity, swelling, fuel cracking or relocation, no fission-gas or hydrogen pressure inside the cladding (unless a pressure is stated), and each solid is free axially or held to plane strain as stated. It does not say that anything fails or holds: a stress is not compared with a strength unless a limit is stated.";

/** A damaged or missing field: reported by a failed check, not thrown past the parser. */
class FieldError extends Error {}

/** The six components of OFFBEAT's symmetric tensor, in its order. */
const XX = 0;
const YY = 3;
const ZZ = 5;

/** One cell of the mechanics result (the points are in the order of ResultsRecord.radial). */
export interface MechanicsPoint {
  /** Radial displacement of the cell centre, m. */
  ur: number;
  /** Axial displacement of the cell centre, m (each solid takes its own axial strain, so it differs between the solids). */
  uz: number;
  /** Radial, hoop and axial stress, Pa (tension positive). */
  sigmaR: number;
  sigmaTheta: number;
  sigmaZ: number;
  /** von Mises equivalent stress from the three normal components (the shear stresses of the wedge are zero to the solver's precision), Pa. */
  sigmaEq: number;
}

export interface MechanicsRecord {
  kind: "thermo-elastic";
  plane: MechanicsSpec["plane"];
  referenceTemperature: number;
  penaltyFactor: number;
  coolantPressure: number;
  /** The constants OFFBEAT was given for each solid: a law of temperature is reduced to these (mechanicalEval.ts). */
  properties: EffectiveMechanics;
  points: MechanicsPoint[];
  summary: {
    fuel: SolidStress;
    cladding: SolidStress;
    /** The gap between the solids at the end, m, as OFFBEAT reports it (negative when the solids overlap), and the contact pressure, Pa. */
    gapWidth: number | null;
    contactPressure: number | null;
    /** True when the solids are in contact: a pressure at the interface, or no gap. */
    contact: boolean;
  };
  note: string;
}

export interface SolidStress {
  /** The largest von Mises stress of the solid's cells, and the most negative and most positive of each component, Pa. */
  maxEquivalent: number;
  radial: [number, number];
  hoop: [number, number];
  axial: [number, number];
  /** The radial displacement of the solid's outer surface cell, m. */
  outerDisplacement: number;
}

export interface MechanicsInput {
  /** The texts of the last time's `D`, `sigma` (and `sigmaCyl` when written), `gapWidth` and `interfaceP` files. A field that is absent is reported by the check, not guessed. */
  D?: string;
  sigma?: string;
  sigmaCyl?: string;
  gapWidth?: string;
  interfaceP?: string;
}

/** `internalField nonuniform List<type> N ( ... )` or `internalField uniform (...)` of a vector or symmetric tensor field, n numbers per cell. */
function listField(text: string, name: string, width: number, cells: number): number[][] {
  const un = /internalField\s+uniform\s+\(([^)]*)\)/.exec(text);
  if (un) {
    const row = un[1]!.trim().split(/\s+/).map(Number);
    if (row.length !== width || !row.every(Number.isFinite)) throw new FieldError(`field ${name}: the uniform value is not ${width} finite numbers`);
    return Array.from({ length: cells }, () => row);
  }
  const m = /internalField\s+nonuniform\s+List<[a-zA-Z]+>\s*(\d+)\s*\(/.exec(text);
  if (!m) throw new FieldError(`field ${name}: no internalField found`);
  const n = Number(m[1]);
  const body = text.slice(m.index + m[0].length);
  const end = body.indexOf("\n)");
  if (end < 0) throw new FieldError(`field ${name}: list is not closed (truncated file?)`);
  const rows = [...body.slice(0, end).matchAll(/\(([^()]*)\)/g)].map((r) => r[1]!.trim().split(/\s+/).map(Number));
  if (rows.length !== n) throw new FieldError(`field ${name}: header says ${n} entries, found ${rows.length}`);
  if (n !== cells) throw new FieldError(`field ${name} has ${n} cells, the case has ${cells}`);
  rows.forEach((r, i) => {
    if (r.length !== width || !r.every(Number.isFinite)) throw new FieldError(`field ${name}: entry ${i} is not ${width} finite numbers`);
  });
  return rows;
}

/** The value of a patch of a scalar field written as `value uniform X` or a one-entry list: the gap width and the interface pressure. */
function patchScalar(text: string, patch: string, key = "value"): number | null {
  const block = new RegExp(`\\b${patch}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(text.slice(text.indexOf("boundaryField")));
  if (!block) return null;
  const un = new RegExp(`${key}\\s+uniform\\s+([-+.\\deE]+)\\s*;`).exec(block[1]!);
  if (un) return Number(un[1]);
  const list = new RegExp(`${key}\\s+nonuniform\\s+List<scalar>\\s*(\\d+)\\s*\\(([^)]*)\\)`).exec(block[1]!);
  if (!list) return null;
  const vals = list[2]!.trim().split(/\s+/).filter(Boolean).map(Number);
  return vals.length > 0 && vals.every(Number.isFinite) ? vals[0]! : null;
}

const vonMises = (r: number, t: number, z: number) => Math.sqrt(0.5 * ((r - t) ** 2 + (t - z) ** 2 + (z - r) ** 2));
const range = (v: number[]): [number, number] => [Math.min(...v), Math.max(...v)];

/**
 * The mechanics record of a thermal result's cells (`regions` and `r` in the order of the T field), or the checks that say why there is none. A missing or damaged field gives a
 * FAILED check and no record; it is never passed for want of evidence.
 */
export function buildMechanics(
  spec: MechanicsSpec,
  properties: EffectiveMechanics,
  cells: { region: "fuel" | "cladding"; r: number }[],
  input: MechanicsInput,
): { record?: MechanicsRecord; checks: Check[] } {
  const fail = (note: string): { checks: Check[] } => ({
    checks: [{ id: "mechanicsFields", label: "Displacement and stress fields read back", value: null, unit: "", verdict: "fail", note }],
  });
  if (input.D === undefined) return fail("OFFBEAT wrote no displacement field D (or it was not collected), so the mechanics cannot be read.");
  const stressText = input.sigmaCyl ?? input.sigma;
  if (stressText === undefined) return fail("OFFBEAT wrote no stress field sigma (or it was not collected), so the stress cannot be read.");
  let D: number[][];
  let S: number[][];
  try {
    D = listField(input.D, "D", 3, cells.length);
    S = listField(stressText, input.sigmaCyl !== undefined ? "sigmaCyl" : "sigma", 6, cells.length);
  } catch (e) {
    if (e instanceof FieldError) return fail(e.message);
    throw e;
  }
  const points: MechanicsPoint[] = cells.map((_, i) => {
    const s = S[i]!;
    return { ur: D[i]![0]!, uz: D[i]![2]!, sigmaR: s[XX]!, sigmaTheta: s[YY]!, sigmaZ: s[ZZ]!, sigmaEq: vonMises(s[XX]!, s[YY]!, s[ZZ]!) };
  });
  const solid = (region: "fuel" | "cladding"): SolidStress => {
    const idx = cells.map((c, i) => (c.region === region ? i : -1)).filter((i) => i >= 0);
    const outer = idx.reduce((a, b) => (cells[b]!.r > cells[a]!.r ? b : a), idx[0]!);
    return {
      maxEquivalent: Math.max(...idx.map((i) => points[i]!.sigmaEq)),
      radial: range(idx.map((i) => points[i]!.sigmaR)),
      hoop: range(idx.map((i) => points[i]!.sigmaTheta)),
      axial: range(idx.map((i) => points[i]!.sigmaZ)),
      outerDisplacement: points[outer]!.ur,
    };
  };
  const gapWidth = input.gapWidth !== undefined ? patchScalar(input.gapWidth, "fuelOuter") : null;
  const contactPressure = input.interfaceP !== undefined ? patchScalar(input.interfaceP, "fuelOuter") : null;
  const contact = (contactPressure !== null && contactPressure > 0) || (gapWidth !== null && gapWidth <= 0);
  return {
    record: {
      kind: "thermo-elastic",
      plane: spec.plane,
      referenceTemperature: spec.referenceTemperature,
      penaltyFactor: spec.penaltyFactor,
      coolantPressure: spec.coolantPressure,
      properties,
      points,
      summary: { fuel: solid("fuel"), cladding: solid("cladding"), gapWidth, contactPressure, contact },
      note: MECHANICS_TEXT,
    },
    checks: [{ id: "mechanicsFields", label: "Displacement and stress fields read back", value: null, unit: "", verdict: "pass", note: `D and ${input.sigmaCyl !== undefined ? "sigmaCyl" : "sigma"} hold one finite entry for each of the ${cells.length} cells` }],
  };
}
