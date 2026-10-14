# A boundary that changes with time

A transient case may state how the coolant side changes during the run: the bulk temperature and the film coefficient, or the wall temperature. Plan: [plan 11](plans/11-time-varying-boundary.md). **Status: the case input (B1), the solver files, the independent solution and the checks (B2) are built; the editor panel and the example cases are not (B4, B3).** A case with a history runs on OFFBEAT and every result is checked against FEED's independent solution with the same history.

## What a case says

```json
"boundary": { "bulkTemperature": { "value": 300, "unit": "K" }, "heatTransferCoefficient": { "value": 30000, "unit": "W/m2/K" } },
"transient": {
  "...": "the power, the time step, the start as usual",
  "boundaryHistory": [
    { "time": { "value": 0,   "unit": "ms" }, "bulkTemperature": { "value": 300, "unit": "K" }, "heatTransferCoefficient": { "value": 30000, "unit": "W/m2/K" } },
    { "time": { "value": 40,  "unit": "ms" }, "bulkTemperature": { "value": 300, "unit": "K" }, "heatTransferCoefficient": { "value": 30000, "unit": "W/m2/K" } },
    { "time": { "value": 50,  "unit": "ms" }, "bulkTemperature": { "value": 300, "unit": "K" }, "heatTransferCoefficient": { "value": 1000,  "unit": "W/m2/K" } },
    { "time": { "value": 100, "unit": "ms" }, "bulkTemperature": { "value": 300, "unit": "K" }, "heatTransferCoefficient": { "value": 1000,  "unit": "W/m2/K" } }
  ]
}
```

A point is `{time, bulkTemperature, heatTransferCoefficient}` for a convective case or `{time, surfaceTemperature}` for a prescribed wall; all points are of one form, and it is the form of the case's own `boundary`, which stays required.

- **Between points the values are linear**; a step is two points close together. The solver (found in B0) applies the value of the **end of each time step**, so a change inside a step acts for the whole step; the independent solution will do the same.
- **The first point is at time 0 and the last at or after the end time**; times strictly increase; 2 to 1000 points. The last value is not held beyond its time, the validator asks for a point that reaches the end.
- **Film coefficient from 0.001 to 1e9 W/m2/K.** A lost coolant is a small positive number: OFFBEAT runs 0.001 without trouble (B0); exactly zero is refused. Temperatures above 0 K and at most 10000 K.
- **A steady start** (`initialSteadyLinearHeatRate`) begins at the steady state of the case's own `boundary`, so the history's value at time 0 must equal it, or the case is refused (`E_TRANSIENT_INCOMPLETE`). A uniform start has no such rule.
- **Zero power is allowed with a history**: a hot pin cooling through a stated boundary has no heat source. Without a history (and without a steady start) a power history that is zero everywhere is still refused.
- Not combined with mechanics, hot dimensions or a burnup (a transient already refuses them).

## Refusals

`E_SCHEMA_INVALID` (not a list, an unknown key), `E_TIME` (fewer than two points, not from 0, not increasing, stops before the end time), `E_BOUNDARY_INCOMPLETE` (half a boundary, both forms in a point, forms mixed in the list, a form that differs from the case's boundary), `E_OUT_OF_RANGE` (a film coefficient or a temperature outside its bounds), `E_UNITS` (a wrong unit), `E_TRANSIENT_INCOMPLETE` (a steady start that the history does not begin at). Every one has a vector in `schema/vectors/bad/boundary-history-*.json`; four good vectors cover a convective history, a prescribed wall, no power and a steady start.

## What it is not

Not boiling or a critical heat flux (the coefficient is an input, not a function of the wall), not an axial variation, not a plate. The thermal-only statement is unchanged.

## How it is written and checked (B2)

- **The solver files.** A convective history becomes OFFBEAT's `timeDependentAxialProfileHTC` on the cladding's outside (`hData` and `T0Data`, two equal axial columns at 0 and 1 m, linear in time), a prescribed wall `timeDependentAxialProfileT` (`timeDependentProfile` and `axialData`: OFFBEAT's header documents other keywords, which the solver refuses, plan 11 B0). One flat point is appended a time step beyond the end time when the last point is not strictly after it, because OFFBEAT aborts on a time equal to its last point.
- **The independent solution** (`src/core/transientFv.ts`) takes the boundary as a function of time and uses the value of the **end of each step**, the way OFFBEAT steps (B0: with a 2 s step the new level matches within 1 K, the old level is 8 to 11 K off). It is checked against the exact lumped solutions (a ramp in the bulk temperature, a step in the film coefficient), the discrete implicit recurrence at both time levels, and energy conservation (`tests/transientFvBoundary.test.ts`). The steady start still uses the case's own boundary.
- **The checks of a run** read the history: `crossCheckFv` and `timeStep` run the independent solution with it; `wallTemperature` compares OFFBEAT's wall with the history at each output; the **energy balance** integrates the heat leaving with the history's film coefficient between outputs (the wall temperature taken linear between two outputs, Simpson's rule) and is judged against the **largest energy exchanged anywhere in the run**, because with a changing boundary the stored and rejected energies can pass through zero and the heat leaving can jump within a few steps while the outputs are seconds apart (the trapezoid of the first interval misses half of it). The threshold is the same 3 %. The checks of a pin that cools or warms with no heat source use the largest excursion of the peak, up or down, as their scale.
- **Shown to fail** (`tests/boundaryHistorySolver.test.ts`, real solver): the output of a real run, judged against a history whose step is at another time, whose level differs, whose first level is held, or against no history, fails `crossCheckFv`. Real runs pass every check: a step in the film coefficient and a ramp in the bulk temperature (both within 2 K of the exact lumped solution), a lost coolant (0.001 W/m2/K), a prescribed wall ramp, a pump coastdown from a steady state, and a hot pin with no heat source in a falling then rising coolant.

### Example cases and a violent quench (B3)

- `examples/ksu-triga-loss-of-pool.json`: the K-State hottest element at its 1.25 MW steady state (film case), then a scram at 10 s and the pool lost (film 57.7 kW/m2/K to 100 W/m2/K over 1 s, decay heat from an assumed curve). Settles near 600 K and is still about 500 K at ten minutes; with the pool kept it would be near the pool. `examples/synthetic-coastdown.json`: the synthetic pin at 20 kW/m, pumps trip at 2 s (film follows flow^0.8, 5 s half time, floor 15 %), scram at 3 s, coolant 60 K warmer by 60 s. Both are **synthetic** and say in their descriptions what is assumed; neither is a safety analysis; neither is an oracle. Both pass every check on the real solver (`tests/boundaryExamples.test.ts`, gated part) and their claims are tested on the independent solution (ungated part).
- **A violent quench needs enough outputs.** A hot unheated pin whose film coefficient rises 200-fold within 1 s (`tests/boundaryHistorySolver.test.ts`): with 60 outputs (1 s apart) the wall falls between two outputs and the energy balance, which takes the wall linear between outputs, reports 8.7 % and **fails**; with 120 outputs (the case file's maximum is 200) every check passes. The failure is correct (the outputs cannot close the balance); the remedy is more outputs, and both runs are tests.

### What the checks cannot see (Codex review of B2, 2026-10-14)

Three things the review found, and what was done:

- **A change between two outputs.** OFFBEAT and the independent solution are compared only at the saved outputs, so a brief pulse in the coolant temperature (or a dip in the film coefficient) that comes and goes inside one output interval is invisible to the cross-check and to the wall check. The validator now **warns** (`W_BOUNDARY_BETWEEN_OUTPUTS`) when the history goes more than a tenth of its range beyond what its values at the two ends of an output interval show, and names the interval. Add outputs, or accept that this part of the history is judged by the files FEED writes (tested) and not by the result.
- **The energy balance** is judged against the largest energy exchanged anywhere in the run, so an early gap of the size of the early exchange passes it. A local gross bound was tried and removed: by energy alone it cannot be told from a jump of the heat leaving inside the first output interval (the trapezoid misses up to half of that interval's exchange), and it failed a correct prescribed-wall ramp. A wrong early field is caught by the cross-check, which compares every cell at every output.
- **The time-step check** compared only the hottest cell; with a history it also compares every cell and the outer wall at each output, against 2 % of the largest excursion of any cell or the wall from its start (`fieldTimeError`). A brief dip of the wall temperature on a hot pin, where the peak check sees 2.7 K and passes, now fails it (real solver test).
