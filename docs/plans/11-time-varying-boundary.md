# Plan 11: A boundary that changes with time

Status: planned 2026-10-12, on the user's word ("yes plan the time-varying boundary"), after an outside test of the suite (`suite-test-ne360`, finding F17) could ask only how fast a plate heats up with its cooling lost, because FEED's film coefficient and bulk temperature are constants for a run. Extends the thermal transients of [plan 08](08-transients.md). Nothing here is built.

## What it adds, and what it does not

A transient case may state how the **coolant side changes with time**: the bulk temperature and the film coefficient (or, for a prescribed wall, the wall temperature) as tables against time. It makes the cases FEED could not run runnable: loss of cooling (h falls to a trickle), a pump coastdown (h decays, in steps), a coolant heat-up or quench ramp, and a power pulse into a coolant that is itself changing.

It does **not** add: boiling or a critical heat flux (h is still an input, not a function of the wall temperature: that would be its own plan, a boundary model that sets h from the wall), axial variation, plate geometry, or anything for steady cases (a steady case has no time). The thermal-only statement is unchanged.

## What is already there

- OFFBEAT has the boundary conditions: `timeDependentAxialProfileHTC` (a convective patch whose film coefficient `hData` and sink temperature `T0Data` are tables of time and axial position, linear or step interpolation in each) and `timeDependentAxialProfile` for a prescribed temperature (the solver's source, `fvPatchFields/convectiveHTC` and `fixedTemperature`). FEED's slice is one axial cell, so the axial dimension is two equal columns.
- FEED already writes the power as a time table (`timeDependentLhgr`, with one flat point appended a step past the end because OFFBEAT aborts on a time past its table). The same trap is to be expected here and is the first thing the probe tests.
- FEED's independent finite-volume solution (`src/core/transientFv.ts`) takes the boundary as two constants (`gOut`, `outerT`); the cross-check, the energy bookkeeping and the steady-start state all read it. These are the code that has to change.

## Decisions

1. **Where it lives.** `transient.boundaryHistory`, optional, a list of points `{time, bulkTemperature, heatTransferCoefficient}` for a convective case or `{time, surfaceTemperature}` for a prescribed wall, linear interpolation between points, the same form (convective or wall) as the case's `boundary`. The case's own `boundary` stays required: it is the boundary of the steady start and the value before the first point. A case without `boundaryHistory` is unchanged, byte for byte.
2. **Coverage.** The history starts at time 0 and reaches the end time, like the power history (a table that stops short is refused; the writer adds the one flat point OFFBEAT needs). A step is two points a time step apart; the validator says so and bounds the number of points (as `MAX_HISTORY_POINTS`).
3. **Positive film coefficient.** A lost coolant is a small `h` (the lower bound is a stated minimum, not zero: a film coefficient of zero is an adiabatic wall, which is a different, explicit option to decide on in B1; the probe shows whether OFFBEAT accepts it).
4. **Consistency with a steady start.** With `initialSteadyLinearHeatRate` the pin starts at the steady state of its own `boundary`; the history's value at time 0 must equal that boundary or the start would not be steady: refused (`E_TRANSIENT_INCOMPLETE`) with the numbers. With a uniform start there is no such rule.
5. **The time step has to resolve the boundary.** As for the power, each segment of the history has to be at least one step; a shorter one is refused (`E_TIME`), because OFFBEAT's implicit step would otherwise see only part of a change and the independent solution the same.
6. **Not combined** with mechanics, hot dimensions or burnup (they are already refused with a transient).
7. **The verdict language.** A result with a changing boundary says so in its banner, and its checks name the boundary history they were made against. Temperature-limit rules are unchanged (they judge every output time).

## Verification (written before the code)

The independent solution is extended first, and checked first against closed forms that share no code with it:

- **Lumped cooling and heating** (small Biot number, a thin cladding-only or high-conductivity pin): `C dT/dt = q - h(t) (T - T_b(t))` solved by quadrature in the test: a step in `T_b`, a ramp in `T_b`, a step in `h` with a source, and a pump-coastdown decay of `h`. Exact for a ramp and a step; a numerical quadrature at 1e-9 for a decaying `h`.
- **The cylinder with a convective boundary that steps** against the series solution (Bessel roots of `x J1(x) = Bi J0(x)`), which FEED already has for cooling to a fixed coolant; the step in `T_b` is the same problem shifted.
- **Energy conservation** with a changing boundary: deposited = stored + rejected, where the rejected heat is the integral of the history's `h(t)` times the film drop.
- **The real solver against the independent solution** on the full pin, with the step refinement, as in plan 08: cross-check bound, time-step check.
- **Negative tests of each check:** a wrong `h` table written to the solver (shifted by one point, held instead of interpolated, the flat tail missing) must fail the cross-check; the checks are shown to fail before they are trusted.

Tolerances for the closed-form comparisons are fixed in the tests before the first run, as in M3 of the mechanics plan.

## Milestones

| | Work | Gate |
|---|---|---|
| **B0 Probe** | Through the real OFFBEAT: a step in `h` and a ramp in `T0` on the synthetic pin (`timeDependentAxialProfileHTC`; the same for a prescribed wall); find the axial table's coordinates for FEED's one-cell slice, whether time past the last point aborts, what `h` near zero does, whether `exit 139` and the convergence record behave as for the power table. | The solver reproduces a lumped case to a few percent; every unknown above is written down. |
| **B1 Case and validator** | `transient.boundaryHistory`, its refusals (form mismatch, no coverage, unordered times, non-positive values, a segment shorter than a step, the steady-start mismatch), warnings, 8 to 12 vectors, the normalised case. | A case without a history is byte-identical; every refusal has a bad vector. |
| **B2 Independent solution and writer** | `transientFv` and `steadyState` take the boundary as a function of time; the writer emits the tables; the cross-check, the energy balance and the boundary-temperature checks read the history. | The closed forms above pass; the checks fail when the table is damaged. |
| **B3 Real solver set** | The gated tests: step and ramp in `T_b`, loss of cooling, a coastdown, a quench; the example cases (a loss-of-cooling pulse on the TRIGA pin, labelled illustrative). | Every check passes on the real solver; the thermal oracles and every earlier test are unchanged. |
| **B4 Editor** | The Coolant boundary panel gets a table editor for the history (a transient only), a plot of `h(t)` and `T_b(t)` beside the pin's temperature history, the banner. Driven in the browser pane. | A case without a history looks and behaves as today. |
| **B5 Oracles and SEED** | Entries in `oracles/seed/` from the lumped closed forms (the existing quantities `temperature_peak_max` and `temperature_peak_history` suffice, so no new adapter work is expected); a request to the SEED agent for the count, as for the mechanics entries; nothing pushed to SEED. | The entries pass FEED's own checks and the real solver. |

Each milestone ends with the whole suite green and the earlier oracles unchanged; a mutation run of the new code and a Codex review of the milestone's diff before the branch is offered for merging (merging to main always on the user's word).

## Honest unknowns

- Whether OFFBEAT's tabulated boundary treats `h` and `T0` at the new time level (implicit) or the old one; the independent solution must do the same or the cross-check is off by a step. The probe settles it.
- How a very small `h` interacts with OFFBEAT's convergence criterion for the temperature (a nearly adiabatic wall makes the steady-state test meaningless, but a transient has no steady test; the per-step convergence record is what is judged).
- Whether the slab-like use that prompted this (a plate cooled on one face) needs anything more than this plan gives: it does not, apart from the geometry, which stays out of scope.

## Estimate

Four to six sessions, honestly uncertain: B0 and B1 one, B2 one or two, B3 one, B4 one, B5 one. The risk is B2 (the independent solution and its bookkeeping), as it was in plan 08.
