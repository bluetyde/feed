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
- Each solid needs a linear expansion coefficient and **the source it comes from**. The coefficient is either a constant `{value, unit}` (`1/K`, `1e-6/K` or `ppm/K`; above 0 and at most 1e-3 1/K) or a law that rises with temperature, `{"model": "linear", "a": ..., "b": ..., "validRange": {"min": ..., "max": ...}}` for `alpha = a + b T` (T in K; `b` in `1/K2` or `1e-9/K2`). A linear law needs its valid range, is positive and at most 1e-3 over all of it, and gives the warning `W_EXPANSION_RANGE` (never silence, never a refusal) when the solid's temperatures leave it. FEED has no expansion data of its own; nothing is defaulted, and a missing source is refused (`E_PROP_MISSING`).
- Steady cases only (`E_UNSUPPORTED` for a transient: the temperatures, and so the radii, change with time).
- `examples/synthetic-pin-hot.json` shows it with unsourced typical values.

## The rule

Each solid's radii (fuel radius, central hole, or cladding inner and outer radius) are multiplied by `1 + mean thermal strain`, where the thermal strain at a temperature is the integral of alpha from the reference temperature (`alpha (T - Tref)` for a constant, `a (T - Tref) + b (T^2 - Tref^2) / 2` for the linear law) and the mean is **area-weighted over the solid** on the closed-form profile. For a constant coefficient that is `alpha (Tmean - Tref)` with `Tmean` the area-weighted mean temperature. The radii are not known before the temperatures and the temperatures depend on the radii, so the two are iterated from the cold radii until every radius changes by less than 1e-13 relatively (about 5 iterations). The mean is Simpson's rule on 200 intervals. A coefficient that is not positive at the solid's hottest or coolest temperature is refused at run time, not applied.

The gap conductance is the one the case states: it is **not** recomputed for the new gap. For a constant conductance taken from a source (the TRIGA case) that is the right reading; for a gas-gap model, which FEED does not have yet, it would not be.

## What it refuses

If the expansion would close the gap (the hot cladding inner radius is not above the hot fuel radius) the case is refused with `E_GEOMETRY` at `/hotDimensions`, naming the radii. Touching solids need contact and stress, which are the mechanics work ([plan 09](plans/09-mechanics.md)); FEED does not pretend a zero gap is a result.

## What it was checked against

- **A hand-written oracle** (`tests/hotDimensions.test.ts`, 22 tests): for the constant-conductivity pin the mean temperature of the fuel is `Ts + q'/(8 pi k)` and that of the cladding has a closed form, and the fixed point is iterated by a plain loop in the test. The radii agree to 1e-9 for two sets of coefficients and reference temperatures. A pin at its reference temperature does not change, one at a uniform other temperature grows by exactly `alpha dT` (the hole with it), and the refusals are each tested. The code was mutated twice (25 mutants of the constant rule and its refusals; 24 mutants of the linear law, its range handling and its warning): all died except one (`>` against `>=` at a hot gap of exactly zero), which is equivalent for floating-point radii.
- **OFFBEAT's own thermal expansion** (`tests/hotDimensionsSolver.test.ts`, `FEED_SOLVER=1`, 2 tests): the cold pin with a 200 micron gap, run with mechanics on (small strain, `E`, `nu`, `alpha` constant, stress-free at 300 K, [the M0 probe](spike/mechanics-probe.md)), at 20 and 40 kW/m. The displacement of the three surfaces gives the hot radii OFFBEAT has. FEED's rule agrees on the **growth** of each surface to 0.06 % (fuel) and 0.03 % (cladding), on the radii to 8e-6 and 9e-7, and on the hot gap to better than 2e-4. So the area-mean rule is not just a plausible choice: with a real radial gradient, OFFBEAT's surface displacement is `alpha Tmean r` to well inside the tolerance the data deserve.

## The sourced coefficients (`library/expansion.json`)

The editor offers each as a button ("Use: ..."); a case carries the law and the source text. There is **no sourced expansion coefficient in either SAR** (searched in both: the only expansion in them is the coolant's volumetric one and the fuel's yield and modulus), so the sets come from two published papers (cited in `library/expansion.json`; copies are not redistributed here).

| Solid | Law | Source | Caveats |
|---|---|---|---|
| U-ZrH fuel | `alpha = 4.52e-6 + 19.25e-9 T(C)` per C, i.e. 4.9e-6 at 20 C, 17.0e-6 at 650 C, 19.9e-6 at 800 C; in kelvin `a = -7.381375e-7`, `b = 1.925e-8`; range 293.15 to 1073.15 K | Simnad, Nucl. Eng. Des. 64 (1981) 403, section 2.10 (the paper the K-State SAR names for its fuel properties) | the paper gives it for the SNAP data (45 wt% uranium) and says TRIGA's 8 to 12 wt% fuel expands about 0.5% radially at maximum power density against 0.6%, so it may over-state the growth by up to a fifth; no validity range is stated (20 to 800 C, the cycled range, is assumed) |
| SS 304 cladding | constant 17.2e-6 per K | Svajger et al., Nucl. Eng. Technol. 56 (2024) 1165, eq. (4.7), citing Kraut et al. (the JSI TRIGA's cladding is SS 304) | a secondary source with no stated temperature range; stainless steel's coefficient rises with temperature, so over hundreds of kelvin this is an average. A primary source would replace it |

The same 2024 paper also gives a fuel coefficient `7.38e-6 + 15.1e-9 T`. Its temperature unit is not stated in the paper, but the General Atomic report (Simnad, E-117-833, section 2.10) gives the same expression with T in degrees C, as a measurement on 45 wt% U-ZrH1.6: it agrees with the SNAP data at 650 C (17.2e-6 against 17.0e-6) and differs at 20 C (7.7e-6 against 4.9e-6). See [triga-data-gaps.md](spike/triga-data-gaps.md). It is **not** in the library, only noted here as a cross-check.

### Finding: the TRIGA examples cannot use hot dimensions yet

All four TRIGA examples model the fuel and the cladding as touching (zero cold gap, an effective interface conductance from the SAR). Free expansion with these coefficients grows the K-State hot element's fuel by about 52 microns (mean strain 2.9e-3, fuel at 500 to 774 K) and its cladding by about 3 microns (the cladding sits near the pool temperature, 294 to 309 K), so the solids overlap by about 50 microns and the case is refused (`tests/hotDimensions.test.ts`, "FINDING"). That is the right answer for this feature (an overlap needs contact and stress, [plan 09](plans/09-mechanics.md)), and it says the TRIGA cases stay on their cold, as-built dimensions with the SAR's gap conductance until the mechanics exist. Hot dimensions help a pin that has a real gap (the synthetic pin, an LWR-type pin).

## What it does not do

- No axial expansion, no change of the pellet length or of the plenum; the model is one radial slice.
- No coefficient richer than constant or `a + b T` (a table or higher polynomial of alpha(T) is a later change of the same module).
- The comparison with OFFBEAT below used constant coefficients only: OFFBEAT's mechanics was not run with a temperature-dependent coefficient, so the linear law is checked against the hand-written oracle but not against the solver.
- No swelling, densification, relocation, creep or thermal stress: those are irradiation and mechanics.
- The pin the editor draws and the radii in the results are the hot ones when the section is on; the case file keeps the cold ones, and a run's `normalized.json` (which the case hash covers) and its manifest mapping carry both.
