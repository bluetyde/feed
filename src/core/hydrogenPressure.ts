// The equilibrium hydrogen pressure over the delta phase of zirconium hydride (and so of U-ZrH TRIGA fuel), from the correlation General Atomic printed:
// M. T. Simnad, "The U-ZrHx Alloy: Its Properties and Use in TRIGA Fuel", GA report E-117-833, section 2.4 "Dissociation pressures", pages 2-10 and 2-11 (also Sandia
// SAND2009-7374C slide 10):
//   log10 P(atm) = K1 + K2 x 1e3 / T(K),   K1 = -3.8415 + 38.6433 X - 34.2639 X^2 + 9.2821 X^3,   K2 = -31.2982 + 23.5741 X - 6.0280 X^2,   X the H/Zr atom ratio.
// Simnad says the hydrogen dissociation pressures are comparable for alloys up to 75 wt % uranium. The text we hold gives no range of temperature for the fit, so a caller
// states the temperature it uses and the case's results say what that was. The delta phase spans about 1.5 to 1.8 H/Zr (the report's phase table), the range accepted here.
export const HYDROGEN_RATIO_RANGE: [number, number] = [1.5, 1.8];
const ATM = 101325;

/** The hydrogen pressure in Pa over hydride of H/Zr ratio X at T kelvin. */
export function hydrogenPressure(X: number, T: number): number {
  const k1 = -3.8415 + 38.6433 * X - 34.2639 * X * X + 9.2821 * X * X * X;
  const k2 = -31.2982 + 23.5741 * X - 6.028 * X * X;
  return ATM * 10 ** (k1 + (k2 * 1e3) / T);
}
