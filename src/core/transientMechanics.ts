// The independent thermo-elastic solution of a pin AT A TIME of a transient, and the checks of OFFBEAT's mechanics against it at every output time (plan 17 M3).
//
// An elastic solid has no memory: the displacement and the stress at a time follow from the temperatures, the pressures and the contact of that time, with no dependence on the
// path (no friction, no plasticity, no creep). So the steady solution evaluated at each output time's temperature field is the check, and nothing is marched through time here:
// `independentAtTime` keeps no state, and tests/transientMechanicsSolution.test.ts proves it (the same answer in any order of the times).
//
// The temperatures are the independent finite-volume ones of the same time (transientFv.ts), cell by cell. Each cell carries its own Young's modulus and free thermal strain from
// its own temperature, taken from the laws themselves (decision D3: no pair of constants reduced at one time, which M0 found 25 to 100 % off in the contact pressure over an 800 K
// swing), constant inside the cell as OFFBEAT sees it. The gas pressure is the case's own: a constant, a table against time, or the hydrogen equilibrium pressure at the
// instantaneous fuel temperature.
//
// Tolerances: the steady ones (MECHANICS_TOLERANCE) are the base and none is widened. Three stated additions, from the M0 probe (docs/plans/17-transient-mechanics.md, M0 record):
// (1) a TEMPERATURE ALLOWANCE for the displacement, the stress and the contact: the independent temperatures differ from OFFBEAT's by up to the thermal check's bound, so each
// tolerance gains the change of the independent result when every temperature moves by that bound, both ways; (2) a NOISE FLOOR of 0.35 MPa for the stress and the radial balance of
// OFFBEAT's own field (its thermal front in the cladding and the stresses under that are within the solver's own noise: 20 to 170 kPa at the written precision); (3) the thermal
// strain piecewise constant per cell (above), which is how the independent solution is built, not a tolerance.
import { elasticityAt } from "./mechanicalEval";
import { fuelVolumeMean } from "./fuelTemperature";
import { hydrogenPressure } from "./hydrogenPressure";
import { thermalStrain } from "./hotDimensions";
import { MECHANICS_TOLERANCE, contactCheck } from "./mechanicsChecks";
import type { MechanicsRecord } from "./mechanicsResults";
import type { Check } from "./resultsParser";
import { type Layer, solveLayeredSlice } from "./thermoElasticLayers";
import type { ThermoElasticSolution } from "./thermoElastic";
import type { NormalizedCase } from "./validate";

/** Every result, export and plot of a transient mechanics run carries this sentence (plan 17, "What a result may claim"). */
export const TRANSIENT_MECHANICS_TEXT =
  "Thermo-elastic stress of a pin through a transient, quasi-static, small strain, a frictionless contact, the laws of temperature applied cell by cell. Not a failure assessment: no creep, plasticity, swelling, cracking, gas release or hydrogen kinetics; no strength is compared unless the case states a limit; a stress in a hydride fuel is not the quantity that limits a TRIGA pulse (the SAR's fuel temperature limits do). The inertia of the solids is not modelled.";

/** The stress and radial-balance noise floor of OFFBEAT's own field (Pa), plan 17 M0: the cladding's thermal front and stresses under it. */
export const STRESS_NOISE_FLOOR = 0.35e6;

/** Below this interface pressure OFFBEAT's gap is open: it writes 1e-6 to 1e-3 Pa there (plan 17 M0), so "touching" is a pressure above the steady contact floor, or no gap. */
export const TOUCHING_FLOOR = MECHANICS_TOLERANCE.contact.floor;

export interface Cell {
  region: "fuel" | "cladding";
  r: number;
}

/** The cell temperatures (K) at one time, each solid inner to outer. */
export interface TemperatureField {
  fuelT: number[];
  claddingT: number[];
}

/** The layers (annuli of equal width, as the mesh) of both solids with the modulus and the free strain each cell's temperature gives. */
export function layersAt(c: NormalizedCase, field: TemperatureField, shift = 0): { fuel: Layer[]; cladding: Layer[] } {
  if (!c.mechanics || !c.mechanical) throw new RangeError("the case does not ask for mechanics");
  const Tref = c.mechanics.referenceTemperature;
  const make = (a: number, b: number, T: number[], p: NonNullable<NormalizedCase["mechanical"]>["fuel"], name: string): Layer[] => {
    const n = name === "fuel" ? c.mesh.fuelCells : c.mesh.claddingCells;
    if (T.length !== n) throw new RangeError(`the ${name} has ${n} cells, ${T.length} temperatures were given`);
    return T.map((t, i) => {
      const Ti = t + shift;
      return { r0: a + ((b - a) * i) / n, r1: a + ((b - a) * (i + 1)) / n, E: elasticityAt(p.elasticity, Ti), nu: p.elasticity.nu, strain: thermalStrain(p.expansion, Ti, Tref) };
    });
  };
  return {
    fuel: make(c.fuelInnerRadius, c.fuelRadius, field.fuelT, c.mechanical.fuel, "fuel"),
    cladding: make(c.claddingInnerRadius, c.claddingOuterRadius, field.claddingT, c.mechanical.cladding, "cladding"),
  };
}

/** The gas pressure (Pa) of the case at time t: 0 for none, the constant, the table (linear between points), or the hydrogen equilibrium pressure at the fuel's instantaneous peak or mean. */
export function gasPressureAt(c: NormalizedCase, t: number, fuelT: number[]): number {
  const ip = c.mechanics?.internalPressure;
  if (!ip) return 0;
  if (ip.kind === "constant") return ip.pressure;
  if (ip.kind === "table") {
    const { times, pressures } = ip;
    if (t < times[0]! || t > times[times.length - 1]! * (1 + 1e-9)) throw new RangeError(`time ${t} s is outside the pressure table (${times[0]} to ${times[times.length - 1]} s): nothing is extrapolated`);
    for (let i = 1; i < times.length; i++) if (t <= times[i]!) return pressures[i - 1]! + ((pressures[i]! - pressures[i - 1]!) * (t - times[i - 1]!)) / (times[i]! - times[i - 1]!);
    return pressures[pressures.length - 1]!;
  }
  if (ip.basis === "instantaneous-peak") return hydrogenPressure(ip.hZrRatio, Math.max(...fuelT));
  if (ip.basis === "instantaneous-mean") return hydrogenPressure(ip.hZrRatio, fuelVolumeMean(c, fuelT));
  throw new RangeError(`the hydrogen pressure basis '${ip.basis}' is the temperature of a steady profile, not of a time`);
}

/** The independent solution at one time: stateless, a function of the temperatures and the gas pressure of that time only. `shift` moves every temperature (K) for the allowance. */
export function independentAtTime(c: NormalizedCase, field: TemperatureField, gas: number, shift = 0): ThermoElasticSolution {
  const L = layersAt(c, field, shift);
  return solveLayeredSlice(L.fuel, L.cladding, c.mechanics!.plane, c.mechanics!.coolantPressure, gas);
}

/** The cell centres of the mesh, fuel then cladding (the order of the records' points). */
export function meshCells(c: NormalizedCase): Cell[] {
  const out: Cell[] = [];
  for (let i = 0; i < c.mesh.fuelCells; i++) out.push({ region: "fuel", r: c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * (i + 0.5)) / c.mesh.fuelCells });
  for (let i = 0; i < c.mesh.claddingCells; i++) out.push({ region: "cladding", r: c.claddingInnerRadius + ((c.claddingOuterRadius - c.claddingInnerRadius) * (i + 0.5)) / c.mesh.claddingCells });
  return out;
}

/** One output time: OFFBEAT's mechanics read back and the independent temperatures of the same time. */
export interface MechanicsAtTime {
  time: number;
  record: MechanicsRecord;
  field: TemperatureField;
  /** The gas pressure the run was given at this time; defaults to the case's own (`gasPressureAt`). */
  gas?: number;
}

export interface TimeVerdict {
  time: number;
  displacement: { value: number; bound: number; pass: boolean };
  stress: { value: number; bound: number; pass: boolean };
  equilibrium: { value: number; bound: number; pass: boolean };
  contact: Check;
  contactTouching: boolean;
}

const sensitivity = (a: number, b: number, c: number) => Math.max(Math.abs(b - a), Math.abs(c - a));

/** The mechanics checks of ONE output time. */
function checkTime(c: NormalizedCase, at: MechanicsAtTime, cells: Cell[], allowanceK: number): TimeVerdict {
  const tol = MECHANICS_TOLERANCE;
  const gas = at.gas ?? gasPressureAt(c, at.time, at.field.fuelT);
  const sol = independentAtTime(c, at.field, gas);
  const up = allowanceK > 0 ? independentAtTime(c, at.field, gas, allowanceK) : sol;
  const down = allowanceK > 0 ? independentAtTime(c, at.field, gas, -allowanceK) : sol;
  const layers = layersAt(c, at.field);
  const record = at.record;
  const idx = { fuel: [] as number[], cladding: [] as number[] };
  cells.forEach((p, i) => idx[p.region].push(i));
  let worstU = 0;
  let worstS = 0;
  let boundU = Infinity;
  let boundS = Infinity;
  let uPass = true;
  let sPass = true;
  for (const name of ["fuel", "cladding"] as const) {
    const field = sol[name];
    const ref = idx[name].map((i) => field.at(cells[i]!.r));
    const refUp = idx[name].map((i) => up[name].at(cells[i]!.r));
    const refDown = idx[name].map((i) => down[name].at(cells[i]!.r));
    const thermalScale = Math.max(...layers[name].map((l) => l.E * Math.abs(l.strain)));
    const sScale = Math.max(Math.max(...ref.flatMap((x) => [x.sigmaR, x.sigmaTheta, x.sigmaZ].map(Math.abs))), tol.stress.thermalFraction * thermalScale);
    const uScale = Math.max(...ref.map((x) => Math.abs(x.ur)));
    idx[name].forEach((i, k) => {
      const pt = record.points[i]!;
      const r = ref[k]!;
      const du = Math.abs(pt.ur - r.ur);
      const ds = Math.max(Math.abs(pt.sigmaR - r.sigmaR), Math.abs(pt.sigmaTheta - r.sigmaTheta), Math.abs(pt.sigmaZ - r.sigmaZ));
      const allowU = sensitivity(r.ur, refUp[k]!.ur, refDown[k]!.ur);
      const allowS = Math.max(...(["sigmaR", "sigmaTheta", "sigmaZ"] as const).map((key) => sensitivity(r[key], refUp[k]![key], refDown[k]![key])));
      const uTol = tol.displacement.fraction * uScale + tol.displacement.floor + allowU;
      const sTol = tol.stress.fraction * sScale + STRESS_NOISE_FLOOR + allowS;
      worstU = Math.max(worstU, du);
      worstS = Math.max(worstS, ds);
      boundU = Math.min(boundU, uTol);
      boundS = Math.min(boundS, sTol);
      if (du > uTol) uPass = false;
      if (ds > sTol) sPass = false;
    });
  }
  // OFFBEAT's own radial balance between neighbouring cell centres (the steady rule, with the noise floor)
  let worstEq = 0;
  let boundEq = Infinity;
  let eqPass = true;
  for (const name of ["fuel", "cladding"] as const) {
    const pts = idx[name].map((i) => ({ r: cells[i]!.r, ...record.points[i]! }));
    const scale = Math.max(Math.max(...pts.flatMap((x) => [x.sigmaR, x.sigmaTheta, x.sigmaZ].map(Math.abs))), tol.stress.thermalFraction * Math.max(...layers[name].map((l) => l.E * Math.abs(l.strain))));
    const bound = tol.equilibrium * scale + STRESS_NOISE_FLOOR;
    boundEq = Math.min(boundEq, bound);
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      const h = b.r - a.r;
      const res = Math.abs(b.sigmaR - a.sigmaR + (h / 2) * ((a.sigmaR - a.sigmaTheta) / a.r + (b.sigmaR - b.sigmaTheta) / b.r));
      worstEq = Math.max(worstEq, res);
      if (res > bound) eqPass = false;
    }
  }
  // the contact: "touching" is a pressure above the floor or no gap (OFFBEAT writes 1e-6 to 1e-3 Pa at an open gap)
  const s = record.summary;
  const touching = (s.contactPressure !== null && s.contactPressure > TOUCHING_FLOOR) || (s.gapWidth !== null && s.gapWidth <= 0);
  const contactRecord: MechanicsRecord = { ...record, summary: { ...s, contact: touching } };
  const contact = contactCheck(sol, contactRecord, { pressure: sensitivity(sol.contactPressure, up.contactPressure, down.contactPressure), gap: sensitivity(sol.freeGap, up.freeGap, down.freeGap) });
  return {
    time: at.time,
    displacement: { value: worstU, bound: boundU, pass: uPass },
    stress: { value: worstS, bound: boundS, pass: sPass },
    equilibrium: { value: worstEq, bound: boundEq, pass: eqPass },
    contact,
    contactTouching: touching,
  };
}

/**
 * The four mechanics checks over every output time. The record's verdict for each is the WORST over the times: the value is the largest deviation, the verdict fails if any time
 * fails, and the note names the time of the worst and how many of the times fail. A time that cannot be judged fails (a check is never passed for want of evidence).
 * `temperatureAllowanceK` is the thermal check's bound for the run (the independent temperatures differ from OFFBEAT's by at most this).
 */
export function transientMechanicsChecks(c: NormalizedCase, times: MechanicsAtTime[], temperatureAllowanceK: number, cells: Cell[] = meshCells(c)): { checks: Check[]; perTime: TimeVerdict[] } {
  if (times.length === 0) {
    const none = (id: string, label: string): Check => ({ id, label, value: null, unit: "", verdict: "fail", note: "there is no output time to judge" });
    return { checks: [none("mechanicsDisplacement", "Displacement"), none("mechanicsStress", "Stress"), none("mechanicsEquilibrium", "Radial balance"), none("mechanicsContact", "Contact")], perTime: [] };
  }
  if (!(temperatureAllowanceK >= 0) || !Number.isFinite(temperatureAllowanceK)) throw new RangeError("the temperature allowance is a number of kelvin from 0");
  const perTime = times.map((t) => checkTime(c, t, cells, temperatureAllowanceK));
  const n = perTime.length;
  const aggregate = (id: string, label: string, unit: string, pick: (v: TimeVerdict) => { value: number; bound: number; pass: boolean }, what: string): Check => {
    let worst = 0;
    perTime.forEach((v, k) => {
      if (pick(v).value > pick(perTime[worst]!).value) worst = k;
    });
    const failing = perTime.filter((v) => !pick(v).pass).length;
    const w = pick(perTime[worst]!);
    return {
      id,
      label,
      value: w.value,
      unit,
      verdict: failing === 0 ? "pass" : "fail",
      note: `${what}; worst at t = ${perTime[worst]!.time} s (${w.value.toExponential(3)} ${unit} against a bound of ${w.bound.toExponential(3)}); ${failing} of ${n} output times fail; the bound carries the temperature allowance of ${temperatureAllowanceK} K${id === "mechanicsDisplacement" ? "" : " and the noise floor of " + STRESS_NOISE_FLOOR / 1e6 + " MPa"}`,
    };
  };
  const checks: Check[] = [
    aggregate("mechanicsDisplacement", "OFFBEAT displacement vs the independent thermo-elastic solution at every output time (max cell deviation)", "m", (v) => v.displacement, "the independent solution uses the laws of temperature cell by cell and the independent temperatures of each time"),
    aggregate("mechanicsStress", "OFFBEAT stress vs the independent thermo-elastic solution at every output time (max cell deviation of a component)", "Pa", (v) => v.stress, "same basis"),
    aggregate("mechanicsEquilibrium", "Radial force balance of OFFBEAT's stress at every output time (max residual)", "Pa", (v) => v.equilibrium, "d(sigma_r)/dr + (sigma_r - sigma_theta)/r = 0 by the trapezoid rule"),
  ];
  const failingContact = perTime.filter((v) => v.contact.verdict === "fail");
  const judged = perTime.filter((v) => v.contact.value !== null);
  const worstContact = (failingContact.length > 0 ? failingContact : judged).reduce<TimeVerdict | undefined>((a, b) => (a === undefined || (b.contact.value ?? 0) > (a.contact.value ?? 0) ? b : a), undefined);
  checks.push({
    id: "mechanicsContact",
    label: "Contact between the solids vs the independent solution at every output time",
    value: worstContact?.contact.value ?? null,
    unit: worstContact?.contact.unit ?? "Pa",
    verdict: failingContact.length === 0 ? "pass" : "fail",
    note: `${perTime.filter((v) => v.contactTouching).length} of ${n} output times have the solids touching; ${failingContact.length} of ${n} fail${worstContact ? "; worst at t = " + worstContact.time + " s: " + worstContact.contact.note : ""}`,
  });
  return { checks, perTime };
}
