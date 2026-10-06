# Conductivity models: constant, linear, cubic, table

A material's `thermal.conductivity` set takes one of four models. Code: `src/core/conductivity.ts` (laws as arithmetic), `src/core/validate.ts` (the rules), `src/core/caseWriter.ts` (what OFFBEAT is given). Tests: `tests/conductivity.test.ts`, `tests/polynomialConductivity.test.ts`, `tests/conductivityEdges.test.ts`, `tests/fitChecks.test.ts`, and, with `FEED_SOLVER=1`, `tests/polynomialConductivitySolver.test.ts`. Why these and not others: [the property-model survey](spike/property-model-survey.md).

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

The material panel's Model select offers Constant, Linear, Cubic and Table. Changing model keeps the source, the range and the values that carry over; a table made from a law is sampled at 5 temperatures **only when the units are SI**, and the source then says the points are sampled and must be replaced by measured ones. A table shows its points (Add point / Remove last), the fit degree and tolerance, a plot of the points and the fitted curve, and the fitted deviation.

## What this is not

- Not a heat-capacity model: heat capacities are still constant or linear in T (a quadratic is possible through `SiCSnead` with par4 = 0, not done).
- Not a pressure, burnup or composition dependence (U-ZrH hydrogen ratio is a TRIGA decision still open).
- A table is not a measurement: the points are the user's, with the source they give.
