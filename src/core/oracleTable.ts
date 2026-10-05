// Evaluates the closed-form entries of oracles/closed-form-table.json against an implementation.
// The implementation is injected so tests can pass deliberately wrong ones: a gate that cannot fail is useless.

import { adiabaticTemperature, cylinderCooling, cylinderHeating } from "./transientExact";
import { ClosedFormImpl, compositeConstantK, compositeLinearK } from "./closedForm";

export interface OracleEntry {
  id: string;
  tag: "good" | "bad-input" | "known-limit";
  /** Quantity id for computed entries. */
  quantity?: string;
  inputs?: Record<string, any>;
  expected?: { value: number; unit: string };
  /** Tolerances are fixed before any solver run and never loosened after seeing a result. */
  tolerance?: { abs: number; rel: number };
  /** For refusal and known-limit entries: the fixture and what it must produce. */
  fixture?: string;
  refusalCode?: string;
  verdict?: string;
  method: string;
  source: string;
}

export interface OracleTable {
  schema: "feed.oracle-table/0.1";
  entries: OracleEntry[];
}

export interface Failure {
  id: string;
  expected: number;
  actual: number;
  detail?: string;
}

const pin = (i: Record<string, number>) => ({
  qPrime: i.qPrime!,
  fuelK: i.fuelK!,
  fuelRadius: i.fuelRadius!,
  hGap: i.hGap!,
  claddingInnerRadius: i.claddingInnerRadius!,
  claddingOuterRadius: i.claddingOuterRadius!,
  claddingK: i.claddingK!,
  hFilm: i.hFilm!,
  bulkTemperature: i.bulkTemperature!,
  fuelInnerRadius: i.fuelInnerRadius ?? 0,
});

/** Values the implementation produces for a computed entry (several when the entry sweeps a parameter). */
export function evaluate(impl: ClosedFormImpl, e: OracleEntry): number[] {
  const i = e.inputs ?? {};
  switch (e.quantity) {
    case "fuel.deltaT":
      return [impl.fuelDeltaT(i.qPrime, i.k)];
    case "fuel.centreMinusSurface":
      return (i.fuelRadii as number[]).map((R) => impl.fuelProfile(i.qPrime, i.k, R, 0, i.surfaceTemperature) - impl.fuelProfile(i.qPrime, i.k, R, R, i.surfaceTemperature));
    case "fuel.annulus.deltaT":
      return [impl.fuelDeltaT(i.qPrime, i.k) * impl.fuelCentreFactor(i.fuelInnerRadius, i.fuelRadius)];
    case "pin.centreTemperature.annular":
      return [compositeConstantK(pin(i), impl).centreT];
    case "cylinder.cooling":
      return [cylinderCooling(i.r, i.t, i.R, i.alpha, i.dT0)];
    case "cylinder.heating":
      return [cylinderHeating(i.r, i.t, i.R, i.k, i.alpha, i.q3)];
    case "adiabatic.linearC.temperature":
      return [adiabaticTemperature(i.a, i.b, i.T0, i.e3)];
    case "gap.deltaT":
      return [compositeConstantK(pin(i), impl).gapDeltaT];
    case "cladding.deltaT":
      return [compositeConstantK(pin(i), impl).claddingDeltaT];
    case "film.deltaT":
      return [compositeConstantK(pin(i), impl).filmDeltaT];
    case "pin.fuelDeltaT":
      return [compositeConstantK(pin(i), impl).fuelDeltaT];
    case "pin.centreTemperature":
      return [compositeConstantK(pin(i), impl).centreT];
    case "pin.centreTemperature.linearFuelK":
      return [
        compositeLinearK(
          {
            qPrime: i.qPrime,
            fuelK: { a: i.fuelA, b: i.fuelB },
            fuelRadius: i.fuelRadius,
            hGap: i.hGap,
            claddingInnerRadius: i.claddingInnerRadius,
            claddingOuterRadius: i.claddingOuterRadius,
            claddingK: { a: i.claddingK, b: 0 },
            boundary: { kind: "convective", bulkTemperature: i.bulkTemperature, hFilm: i.hFilm },
          },
          impl,
        ).centreT,
      ];
    case "pin.centreTemperature.surfaceFixed":
      return [
        compositeLinearK(
          {
            qPrime: i.qPrime,
            fuelK: { a: i.fuelK, b: 0 },
            fuelRadius: i.fuelRadius,
            hGap: i.hGap,
            claddingInnerRadius: i.claddingInnerRadius,
            claddingOuterRadius: i.claddingOuterRadius,
            claddingK: { a: i.claddingK, b: 0 },
            boundary: { kind: "surface-temperature", surfaceTemperature: i.surfaceTemperature },
          },
          impl,
        ).centreT,
      ];
    case "fuel.centreTemperature.surfaceFixed.linearK":
      return [impl.solveLinearK(i.a, i.b, i.surfaceTemperature, impl.fuelConductivityIntegral(i.qPrime))];
    default:
      throw new Error("unknown quantity '" + String(e.quantity) + "' in entry " + e.id);
  }
}

export function withinTolerance(expected: number, actual: number, tol: { abs: number; rel: number }): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tol.abs + tol.rel * Math.abs(expected);
}

/** Run every computed entry; return the failures (empty means the implementation matches the table). */
export function runTable(impl: ClosedFormImpl, table: OracleTable): Failure[] {
  const failures: Failure[] = [];
  for (const e of table.entries) {
    if (e.quantity === undefined) continue;
    const expected = e.expected!.value;
    for (const actual of evaluate(impl, e)) {
      if (!withinTolerance(expected, actual, e.tolerance!)) failures.push({ id: e.id, expected, actual });
    }
  }
  return failures;
}
