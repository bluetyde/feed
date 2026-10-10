// The hydrogen dissociation pressure of the delta hydride (src/core/hydrogenPressure.ts, Simnad GA E-117-833 section 2.4). The expected values were computed from the printed
// coefficients with a separate script (Python), and agree with what the UT-Austin SAR figure 4.3b shows (docs/spike/mechanics-data.md): 1.56 MPa at 960 C for H/Zr 1.65.
import { describe, expect, it } from "vitest";
import { HYDROGEN_RATIO_RANGE, hydrogenPressure } from "../src/core/hydrogenPressure";

describe("hydrogen pressure over the delta hydride", () => {
  it("matches the correlation evaluated independently at four points", () => {
    const cases: [number, number, number][] = [
      [1.65, 900, 0.6714377407799473e6],
      [1.65, 960, 1.5577093401285877e6],
      [1.65, 1150, 14.013064824104156e6],
      [1.6, 1000, 1.6573806079151092e6],
    ];
    for (const [X, C, P] of cases) expect(Math.abs(hydrogenPressure(X, C + 273.15) / P - 1), `${X} ${C} C`).toBeLessThan(1e-9);
  });
  it("rises with temperature and with the hydrogen ratio", () => {
    expect(hydrogenPressure(1.6, 1100)).toBeGreaterThan(hydrogenPressure(1.6, 1000));
    expect(hydrogenPressure(1.7, 1100)).toBeGreaterThan(hydrogenPressure(1.6, 1100));
  });
  it("the accepted ratio range is the delta phase, 1.5 to 1.8", () => {
    expect(HYDROGEN_RATIO_RANGE).toEqual([1.5, 1.8]);
  });
});
