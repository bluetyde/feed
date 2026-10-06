// Closed-form solution of a validated case, and the out-of-domain check on it.
// This is a limited calculation (a conductivity law of degree up to 3, uniform source, steady state), not a solver result.

import { CompositeResult, compositeLaw, fuelTemperatureLaw } from "./closedForm";
import { lawOf, rangeOf, solveHot } from "./conductivity";
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

export function quickLook(c: NormalizedCase): QuickLook {
  const temperatures = compositeLaw({
    qPrime: c.qPrime,
    fuelK: lawOf(c.fuelConductivity),
    fuelRadius: c.fuelRadius,
    fuelInnerRadius: c.fuelInnerRadius,
    hGap: c.gapConductance,
    claddingInnerRadius: c.claddingInnerRadius,
    claddingOuterRadius: c.claddingOuterRadius,
    claddingK: lawOf(c.claddingConductivity),
    boundary:
      c.boundary.kind === "convective"
        ? { kind: "convective", bulkTemperature: c.boundary.bulkTemperature, hFilm: c.boundary.heatTransferCoefficient }
        : { kind: "surface-temperature", surfaceTemperature: c.boundary.surfaceTemperature },
  });
  const findings: DomainFinding[] = [];
  const check = (region: "fuel" | "cladding", k: Conductivity, lo: number, hi: number) => {
    const r = rangeOf(k);
    if (r && (lo < r[0] || hi > r[1])) findings.push({ region, temperatureRange: [lo, hi], validRange: r });
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
  const fk = lawOf(c.fuelConductivity);
  const ck = lawOf(c.claddingConductivity);
  for (let i = 0; i <= n; i++) {
    const r = c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * i) / n;
    out.push({ r, T: fuelTemperatureLaw(fk, c.qPrime, c.fuelRadius, r, look.temperatures.fuelSurfaceT, c.fuelInnerRadius), region: "fuel" });
  }
  for (let i = 0; i <= n; i++) {
    const r = c.claddingInnerRadius + ((c.claddingOuterRadius - c.claddingInnerRadius) * i) / n;
    const integral = (c.qPrime * Math.log(c.claddingOuterRadius / r)) / (2 * Math.PI);
    out.push({ r, T: solveHot(ck, look.temperatures.claddingOuterT, integral), region: "cladding" });
  }
  return out;
}
