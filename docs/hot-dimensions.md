# Hot dimensions

A case states its radii cold, as manufactured. With a `hotDimensions` section FEED runs the temperature solution on the radii each solid has at operating temperature, from free linear thermal expansion. It is the cheapest correction of the gap, and the only one FEED makes without mechanics: no stress, no contact, no swelling, no creep, no pressure.

## The input

```json
"hotDimensions": {
  "referenceTemperature": { "value": 20, "unit": "degC" },
  "fuel":     { "linearExpansion": { "value": 12, "unit": "ppm/K" }, "source": "..." },
  "cladding": { "linearExpansion": { "value": 10, "unit": "ppm/K" }, "source": "..." }
}
```

- `referenceTemperature` is the temperature the radii are stated at. It is required and is not assumed to be room temperature.
- Each solid needs a constant linear expansion coefficient (`1/K`, `1e-6/K` or `ppm/K`; above 0 and at most 1e-3 1/K) and **the source it comes from**. FEED has no expansion data of its own; nothing is defaulted, and a missing source is refused (`E_PROP_MISSING`).
- Steady cases only (`E_UNSUPPORTED` for a transient: the temperatures, and so the radii, change with time).
- `examples/synthetic-pin-hot.json` shows it with unsourced typical values.

## The rule

Each solid's radii (fuel radius, central hole, or cladding inner and outer radius) are multiplied by `1 + alpha (Tmean - Tref)`, where `Tmean` is the **area-weighted mean temperature** of that solid on the closed-form profile. The radii are not known before the temperatures and the temperatures depend on the radii, so the two are iterated from the cold radii until every radius changes by less than 1e-13 relatively (about 5 iterations). The mean is Simpson's rule on 200 intervals.

The gap conductance is the one the case states: it is **not** recomputed for the new gap. For a constant conductance taken from a source (the TRIGA case) that is the right reading; for a gas-gap model, which FEED does not have yet, it would not be.

## What it refuses

If the expansion would close the gap (the hot cladding inner radius is not above the hot fuel radius) the case is refused with `E_GEOMETRY` at `/hotDimensions`, naming the radii. Touching solids need contact and stress, which are the mechanics work ([plan 09](plans/09-mechanics.md)); FEED does not pretend a zero gap is a result.

## What it was checked against

- **A hand-written oracle** (`tests/hotDimensions.test.ts`, 11 tests): for the constant-conductivity pin the mean temperature of the fuel is `Ts + q'/(8 pi k)` and that of the cladding has a closed form, and the fixed point is iterated by a plain loop in the test. The radii agree to 1e-9 for two sets of coefficients and reference temperatures. A pin at its reference temperature does not change, one at a uniform other temperature grows by exactly `alpha dT` (the hole with it), and the refusals are each tested. 25 mutants of the code were run; 24 died, and the survivor (`>` against `>=` at a hot gap of exactly zero) is equivalent for floating-point radii.
- **OFFBEAT's own thermal expansion** (`tests/hotDimensionsSolver.test.ts`, `FEED_SOLVER=1`, 2 tests): the cold pin with a 200 micron gap, run with mechanics on (small strain, `E`, `nu`, `alpha` constant, stress-free at 300 K, [the M0 probe](spike/mechanics-probe.md)), at 20 and 40 kW/m. The displacement of the three surfaces gives the hot radii OFFBEAT has. FEED's rule agrees on the **growth** of each surface to 0.06 % (fuel) and 0.03 % (cladding), on the radii to 8e-6 and 9e-7, and on the hot gap to better than 2e-4. So the area-mean rule is not just a plausible choice: with a real radial gradient, OFFBEAT's surface displacement is `alpha Tmean r` to well inside the tolerance the data deserve.

## What it does not do

- No axial expansion, no change of the pellet length or of the plenum; the model is one radial slice.
- No temperature-dependent coefficient (a table or polynomial of alpha(T) is a later change of the same module).
- No swelling, densification, relocation, creep or thermal stress: those are irradiation and mechanics.
- The pin the editor draws and the radii in the results are the hot ones when the section is on; the case file keeps the cold ones, and a run's `normalized.json` (which the case hash covers) and its manifest mapping carry both.
