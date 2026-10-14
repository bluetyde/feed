# The axial stack (plan 12)

A case may describe the pin as **N slices along its height**, each a radial problem with its own heat rate and its own coolant (plan 12, [docs/plans/12-axial-stack-and-plate.md](plans/12-axial-stack-and-plate.md)). **Status 2026-10-14 (milestone A2): a steady stack runs through the real solver and is read back and checked slice by slice** (the editor's panel and the 3D view are A6 and A7). Not for transients (A3), mechanics, hot dimensions or burnup (refused, with the reason).

```json
"power": { "linearHeatRate": { "value": 20, "unit": "kW/m" } },
"axial": {
  "length": { "value": 0.381, "unit": "m" },
  "slices": 10,
  "powerShape": { "kind": "cosine" },
  "boundary": [
    { "height": { "value": 0, "unit": "m" },     "bulkTemperature": { "value": 573, "unit": "K" }, "heatTransferCoefficient": { "value": 30000, "unit": "W/m2/K" } },
    { "height": { "value": 0.381, "unit": "m" }, "bulkTemperature": { "value": 633, "unit": "K" }, "heatTransferCoefficient": { "value": 30000, "unit": "W/m2/K" } }
  ]
}
```

- **`power.linearHeatRate` is the AVERAGE over the heated length** (what OFFBEAT takes, and what a total power over the length gives); the hottest slice's heat rate is derived and shown. (Plan 12 first said "the peak"; the probe found OFFBEAT's keyword is the average, so the case follows it.)
- **`powerShape`**: `flat`, `cosine` (cos of pi (z/L - 1/2): zero at both ends, peak in the middle) or `table` (`points`: `{position, relativePower}`, positions in length units from the bottom, the first 0 and the last the length, strictly increasing, relative power at least 0 and not all zero, linear between points). FEED normalises the shape so that its integral over the height is 1; the writer will give OFFBEAT exactly that table (it aborts when the integral is not 1 to 1e-4).
- **`boundary`** (optional): a table of `height` against `bulkTemperature` and `heatTransferCoefficient`, or against `surfaceTemperature` for a prescribed wall, in the same form as the case's own `boundary`, linear between points, from height 0 to the length (the heights are in **metres from the bottom**, as OFFBEAT's table is). Without it every slice has the case's own boundary. The film coefficient is 0.001 to 1e9 W/m2/K as in a boundary history.
- **Slices**: 3 to 50. Each slice's heat rate is the average times the shape **at the slice's centre** (the way OFFBEAT samples a profile), its coolant the table at the same height.
- Every refusal has the code `E_AXIAL` (or `E_UNITS`, `E_UNSUPPORTED`) and names the field; 34 vectors (`schema/vectors/good/axial-*`, `bad/axial-*`).

## Warnings

- **`W_AXIAL_SHAPE_STEP`**: two neighbouring slices differ in heat rate by more than 40 % of the largest slice's, so the shape is not resolved by this many slices. A cosine needs about 8 slices to stay under it.
- **`W_AXIAL_CONDUCTION`**: the estimate below is above 2 %. The warning for a short pin or a steep shape.
- **`W_POWER_RANGE`** is judged on the **hottest slice**, not the average.

## The axial conduction

OFFBEAT solves the stack as one mesh with N layers per solid, so the layers exchange a little heat along the pin (the probe, [docs/spike/axial-plate-probe.md](spike/axial-plate-probe.md)). FEED's independent solutions are one-dimensional per slice and do not. The size is estimated (`axialConductionEstimate` in `src/core/axial.ts`) from a fin model: lambda squared = (k A of fuel and cladding at their largest conductivity) / (the conductance per length from the pin to the coolant), times the largest second difference of the shape across the slices (1/m2) relative to its largest value; for the cosine this is lambda^2 (pi / L)^2.

**Calibration:** against the real-solver measurements at L = 0.19, 0.381 and 0.762 m (10 layers, cosine, 20 kW/m average), the estimate times the peak rise covers the measured end-layer change (1.06 K at 0.381 m) and peak-layer change (0.35 K) and is within a factor 2 of the end-layer change; it goes as 1/L^2 as the measurements do (`tests/axialCase.test.ts`).

**Limits:** measured for the cosine only; an adiabatic end with a steep shape (a table with a large end slope) makes a boundary layer that the estimate does not include, so A2 measures such a shape before the estimate is used as a tolerance there; interior slices only. The estimate is an alarm now, and from A2 a part of the cross-check tolerance (with a factor 3).

## The editor

The server's check of a stack returns the one-dimensional closed form of every slice (`axial.slices`: height, heat rate, coolant, centre, fuel-surface and outer-wall temperatures, the property-range verdict), the hottest slice, and the conduction estimate; the quick look and the radial profile are those of the hottest slice. The editor's panel and the 3D view are milestones A6 and A7.

## How it is written and checked (A2)

- **The mesh.** One OFFBEAT run: each solid has N layers over the heated length (`blockMeshDict`: `fuel (nf 1 N)`, `cladding (nc 1 N)`, the height in mm), the end faces stay `empty`. `lhgr` is the average heat rate and `heatSourceOptions.axialProfile` is `constantTabulated` with the shape as a table normalised to an integral of 1 over 0 to 1 (OFFBEAT aborts otherwise; the cosine is written with 41 points). With a coolant table the outer wall is `timeDependentAxialProfileHTC` (or `timeDependentAxialProfileT` for a prescribed wall): heights in metres, two time points `0` and twice the end time (a table must reach past the end of the run), the same row at both. Without one the case's own boundary is written on every layer. A case without a stack is written exactly as before.
- **Reading it back.** The cells come block by block (all fuel cells layer by layer, then all cladding cells); the parser takes layer k's fuel cells `k nf .. (k+1) nf - 1` and cladding cells `N nf + k nc ..` and **refuses output whose cell heights do not fit the layers** (a reordered mesh would otherwise be read as a wrong but plausible result). The outer faces come from the `cladOuter` patch's value list, one per layer.
- **The checks, per slice.** Each slice is judged as the one-radial-slice pin it is: its own heat rate and coolant, FEED's closed form for the fuel and the cladding, the wall temperature, the flux through the cladding (the energy balance), the property ranges, the temperature limits, the steady-state gate. The result reports **one line per check**: a failing slice if there is one (with how many fail and where), otherwise the worst value (the smallest margin for a temperature limit). The tolerances are the one-dimensional ones **plus 3 times the estimated axial conduction** (`allowance` in the record): that many K on a field, W/m on a flux and K on the wall (the factor 3 is a margin over the estimate, which covered the measurements within a factor 2).
- **The whole pin.** `energyBalanceTotal`: the heat the cladding walls carry away, summed over the slices, against the heat given (the shape sampled at the slice centres, which is what OFFBEAT deposits and can differ from the stated average: 0.46 % for 10 slices of a cosine). The end faces carry no heat, so this balance is exact whatever the axial conduction does; it passes to 3e-6 on the real runs. `axialConduction` is an informational line (verdict `na`) that states the estimate and the widening.
- **The record.** A stack's results are the hottest slice's (`summary`, `radial`, so every existing view, export and comparison still works), plus `axial`: the heated length, the hottest slice, one entry per slice (height, heat rate, coolant, the temperatures that the editor shows, the radial profile), the sampled and stated average heat rates, the conduction estimate and the allowance. The banner adds that this is one radial solution per slice, with the heat flow along the pin that the solver includes.
- **A limit with a cladding condition** (the TRIGA fuel limit applies 1150 C while the cladding is at most 500 C and 950 C above it) is judged **per slice, with that slice's cladding**: a slice's own cladding temperature decides its limit.
- **Shown to fail.** Real output judged against a stack that was not run fails: a shape read as a ramp or its mirror, a coolant table read from the top, 10 % more heat (the closed-form checks and the whole-pin balance). `tests/axialSolver.test.ts` (real solver), `tests/stackResults.test.ts` (saved real output in `tests/golden/offbeat-stack/`).
