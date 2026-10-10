// The penalty factor FEED suggests for a mechanics case's contact (docs/plans/09-mechanics.md M5), from the sweep of M3 (docs/mechanics.md, "What the contact sweep found"):
// the factor has to suit the stiffness ratio of the fuel to the cladding. Too small and the contact pressure is low (and the contact check fails); too large and the run
// does not converge. The sweep ran fuel moduli of 0.25, 1 and 2 times the cladding's, at 0.7, 0.3 and 0.3: nothing between or beyond them was run, and the advice says so.
export interface PenaltyAdvice {
  /** The fuel's modulus over the cladding's, from the moduli at the mean temperatures of the solids. */
  ratio: number;
  factor: number;
  /** True when the ratio is inside the range the sweep covered (0.25 to 2). */
  tested: boolean;
  note: string;
}

export function penaltyAdvice(fuelE: number, claddingE: number): PenaltyAdvice {
  const ratio = fuelE / claddingE;
  const tested = ratio >= 0.2 && ratio <= 2.5;
  const factor = ratio >= 0.6 ? 0.3 : 0.7;
  const note =
    ratio >= 0.6
      ? `The fuel is ${ratio.toFixed(2)} times as stiff as the cladding. 0.3 gave a contact pressure within 2.2 % at fuel moduli of 1 and 2 times the cladding's; 0.5 and above did not converge at 2 times.`
      : `The fuel is ${ratio.toFixed(2)} times as stiff as the cladding (a soft fuel, like the TRIGA fuel against steel). 0.7 is the factor that converged at 0.25 times; its contact pressure was 2.7 to 3.1 % low, at the edge of the 3 % tolerance, and the stress check can fail by about 1 MPa. This is a known limit; a lower factor gives a lower pressure.`;
  return { ratio, factor, tested, note: tested ? note : note + ` The ratio is outside the 0.25 to 2 the sweep ran: the factor is a guess and the contact check will say if it is wrong, or the run will fail to converge.` };
}
