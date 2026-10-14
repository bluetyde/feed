# A boundary that changes with time

A transient case may state how the coolant side changes during the run: the bulk temperature and the film coefficient, or the wall temperature. Plan: [plan 11](plans/11-time-varying-boundary.md). **Status: the case input and its validation are built (B1); the solver files, the independent solution and the checks are not (B2), so a case with a history is valid but a run of it is refused** rather than run with a constant boundary. The editor's preview skips it with that reason.

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
