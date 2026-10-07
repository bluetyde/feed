# Conductivity and heat capacity models: constant, linear, cubic or quadratic, table

A material's `thermal.conductivity` set takes one of four models. Code: `src/core/conductivity.ts` (laws as arithmetic), `src/core/validate.ts` (the rules), `src/core/caseWriter.ts` (what OFFBEAT is given). Tests: `tests/conductivity.test.ts`, `tests/polynomialConductivity.test.ts`, `tests/conductivityEdges.test.ts`, `tests/fitChecks.test.ts`, `tests/polynomialHeatCapacity.test.ts`, and, with `FEED_SOLVER=1`, `tests/polynomialConductivitySolver.test.ts` and `tests/polynomialHeatCapacitySolver.test.ts`. Why these and not others: [the property-model survey](spike/property-model-survey.md).

## The models

| Model | Law | Keys | Notes |
|---|---|---|---|
| `constant` | k | `value`, `referenceTemperature`, `source` | as before |
| `linear` | a + b T | `a` (W/m/K), `b` (W/m/K²), `validRange`, `source` | as before; carried by `steel1515TiTobbe` |
| `polynomial` | a + b T + c T² + d T³ | `a` W/m/K, `b` W/m/K², `c` W/m/K³, `d` W/m/K⁴, `validRange`, `source` | all four are given (a zero is written as 0); T in kelvin |
| `table` | fitted polynomial | `points`, `fit {degree 1–3, tolerance}`, `source` | the range is the table's own |

The conductivity must be **positive over the whole stated range**, checked exactly (end points and the turning points of the cubic), not at samples; a law that touches zero is refused (`E_OUT_OF_RANGE`).

## What OFFBEAT is given

A polynomial is written as OFFBEAT's `ZyRELAP` model, which evaluates `k = par1 + par2 T − par3 T² + par4 T³` (T in K). So **par3 is minus c**, and **all four parameters are always written**: an omitted or mistyped parameter takes a Zircaloy default without a word. The case's mapping record says so. A polynomial that is a straight line gives the same temperatures as the linear model to 1e-4 K (tested through the solver).

## Tables are fitted, not interpolated

OFFBEAT has **no tabulated conductivity**. A table is therefore carried by a least-squares polynomial of the degree the case states (1, 2 or 3). The case also states the **tolerance**: the largest relative deviation from the table's points it accepts (a fraction or a %, above 0 and at most 50%). If the fit is further away, or the degree needs more points than the table has, the case is refused with **`E_FIT`**, saying where the deviation is largest; nothing is smoothed silently. The range is the table's own temperatures: a law fitted to 300–600 K says nothing about 900 K, and a run outside it is out-of-domain like any other range violation.

A result of a tabulated case carries a check, `conductivityFitFuel` / `conductivityFitCladding`: the fit's largest deviation, the degree, the points and the tolerance, and the sentence that what ran was the polynomial and not the table. It passes by construction (a worse fit would have been refused); it is there so a result states the approximation it rests on. A case with no table has no such check. Three points and degree 2 are an exact interpolation (deviation about 1e-16, the library's `ss304-ktable`).

## The editor

The material panel's Model select offers Constant, Linear, Cubic (Quadratic for a heat capacity) and Table, for both properties, from one editor. Changing model keeps the source, the range and the values that carry over; a table made from a law is sampled at 5 temperatures (in the units the law is written in, when the editor knows them), and the source then says the points are sampled and must be replaced by measured ones. A table shows its points (Add point / Remove last), the fit degree and tolerance, a plot of the points and the fitted curve, and the fitted deviation.

## Heat capacity (volumetric, for transients)

The same four models, with a quadratic where the conductivity has a cubic. The set is `thermal.volumetricHeatCapacity`, the law is **c = a + b T + c T²** in J/m³/K (keys `a`, `b`, `c` with units J/m³/K, J/m³/K², J/m³/K³; MJ and J/cm³ are accepted), a `validRange` and a `source`; a table has `points` of `{temperature, heatCapacity}`, `fit {degree 1–2, tolerance}` and a `source`. The rules are the conductivity's, through the same code (`src/core/validate.ts`, one specification per property): positive over the whole range, exactly; a table is a least-squares fit refused with `E_FIT` beyond its tolerance; the range of a table is its own. One more rule: the value must stay between 1e3 and 1e8 J/m³/K over the range, found from the extremes and not from samples, because the likeliest mistake is a unit.

OFFBEAT is given the polynomial through **`SiCSnead`** (`Cp = par1 + par2 T + par3 T² + par4 T⁻²`, J/kg/K): par1..par3 are a, b, c over the writer's density (10000 kg/m³, the carrier of the volumetric law) and **par4 = 0**, all four written. The linear law keeps its own route (`steel1515TiBanerjee` with par3 = 0). Run through the real solver, with FEED's writer: a quadratic pulse agrees with the independent finite-volume solution, every check passes, and a table's result carries `heatCapacityFitFuel` / `heatCapacityFitCladding` (the fit's largest deviation).

What uses the law: the independent finite-volume solver (enthalpy is the primitive of the law, so stored energy is conserved exactly), the point-kinetics generator's fuel feedback (the temperature at which the enthalpy has risen by the energy per volume, a bracketed solve; a law that would have to turn negative is `E_KINETICS`), the preview's adiabatic ceiling, the range checks (a pulse that leaves the stated range is out-of-domain), and the initial-state checks.

## What this is not

- Not a cubic heat capacity, nor a T^-2 term (OFFBEAT's `SiCSnead` and `steel1515TiBanerjee` have one; FEED sets it to zero): the heat capacity stops at the quadratic.
- Not a pressure, burnup or composition dependence (U-ZrH hydrogen ratio is a TRIGA decision still open).
- A table is not a measurement: the points are the user's, with the source they give.
