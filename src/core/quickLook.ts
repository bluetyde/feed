// Closed-form solution of a validated case, and the out-of-domain check on it.
// This is a limited calculation (constant or linear k, uniform source, steady state), not a solver result.

import { CompositeResult, LinearK, compositeLinearK, fuelTemperatureLinearK, solveLinearK } from "./closedForm";
import { Conductivity, NormalizedCase } from "./validate";

export interface DomainFinding {
  region: "fuel" | "cladding";
  temperatureRange: [number, number];
  validRange: [number, number];
}

export interface QuickLook {
  temperatures: CompositeResult;
  /** 'out-of-domain' when a solid region's temperatures leave its conductivity's stated range. Never silently extrapolated. */
  verdict: "in-domain" | "out-of-domain";
  findings: DomainFinding[];
}

function asLinear(k: Conductivity): LinearK {
  return k.kind === "constant" ? { a: k.k, b: 0 } : { a: k.a, b: k.b };
}

export function quickLook(c: NormalizedCase): QuickLook {
  const temperatures = compositeLinearK({
    qPrime: c.qPrime,
    fuelK: asLinear(c.fuelConductivity),
    fuelRadius: c.fuelRadius,
    fuelInnerRadius: c.fuelInnerRadius,
    hGap: c.gapConductance,
    claddingInnerRadius: c.claddingInnerRadius,
    claddingOuterRadius: c.claddingOuterRadius,
    claddingK: asLinear(c.claddingConductivity),
    boundary:
      c.boundary.kind === "convective"
        ? { kind: "convective", bulkTemperature: c.boundary.bulkTemperature, hFilm: c.boundary.heatTransferCoefficient }
        : { kind: "surface-temperature", surfaceTemperature: c.boundary.surfaceTemperature },
  });
  const findings: DomainFinding[] = [];
  const check = (region: "fuel" | "cladding", k: Conductivity, lo: number, hi: number) => {
    if (k.kind === "linear" && (lo < k.range[0] || hi > k.range[1])) findings.push({ region, temperatureRange: [lo, hi], validRange: k.range });
  };
  check("fuel", c.fuelConductivity, temperatures.fuelSurfaceT, temperatures.centreT);
  check("cladding", c.claddingConductivity, temperatures.claddingOuterT, temperatures.claddingInnerT);
  return { temperatures, verdict: findings.length === 0 ? "in-domain" : "out-of-domain", findings };
}

export interface ProfilePoint {
  /** Radius in metres. */
  r: number;
  /** Temperature in kelvin. */
  T: number;
  region: "fuel" | "cladding";
}

/** Radial temperature at `n` points per solid region (fuel centre to fuel surface, cladding inner to outer), closed form. The gap is the jump between the two segments. */
export function radialProfile(c: NormalizedCase, look: QuickLook, n = 40): ProfilePoint[] {
  const out: ProfilePoint[] = [];
  const fk = asLinear(c.fuelConductivity);
  const ck = asLinear(c.claddingConductivity);
  for (let i = 0; i <= n; i++) {
    const r = c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * i) / n;
    out.push({ r, T: fuelTemperatureLinearK(fk, c.qPrime, c.fuelRadius, r, look.temperatures.fuelSurfaceT, c.fuelInnerRadius), region: "fuel" });
  }
  for (let i = 0; i <= n; i++) {
    const r = c.claddingInnerRadius + ((c.claddingOuterRadius - c.claddingInnerRadius) * i) / n;
    const integral = (c.qPrime * Math.log(c.claddingOuterRadius / r)) / (2 * Math.PI);
    out.push({ r, T: solveLinearK(ck.a, ck.b, look.temperatures.claddingOuterT, integral), region: "cladding" });
  }
  return out;
}
