# Plan 08: Thermal transients (pulses)

Status: started 2026-10-05, user request "do the pulse transients". Extends the steady thermal tool with a time-dependent heat source and heat capacity. Still thermal only: no mechanics, no reactivity feedback. The power history is an input; FEED does not compute the pulse.

## What is solved

rho c(T) dT/dt = (1/r) d/dr ( r k(T) dT/dr ) + q'''(t)   in the fuel (uniform in r, scaled by the input linear heat rate q'(t))
rho c(T) dT/dt = (1/r) d/dr ( r k(T) dT/dr )              in the cladding

Same geometry (solid or annular fuel, gap as one conductance, cladding, convective or fixed-temperature outer boundary). The gap has no heat capacity. Implicit Euler in time with a fixed step, as OFFBEAT does it.

## Decisions

1. **Heat capacity is volumetric** (`thermal.volumetricHeatCapacity`, J/m3/K), constant or linear c = a + b T (T in K), per material, with a stated source and valid range like conductivity. The UT-Austin SAR gives U-ZrH as 2.04 + 0.00417 T[C] J/cm3/K, which doubles over the pulse range, so a constant is not acceptable for TRIGA. OFFBEAT's `steel1515TiBanerjee` model reads `par1 + par2 T + par3 T^-2` from a `heatCapacity` block, so with `par3 = 0` and the (constant) density as divisor it carries any linear volumetric law (the same trick as the conductivity; the model name is a misnomer, recorded in the manifest).
2. **A transient case is `assumptions.steadyState: false` plus a `transient` section.** The section holds the power history (time, linear heat rate points, linear interpolation), end time, time step, and the number of outputs. A steady case with a `transient` section, or a transient case without one, is refused. Nothing is defaulted.
3. **Initial state: a uniform temperature, or the pin's steady operating state** (added 2026-10-06). The case gives exactly one of `transient.initialTemperature` and `transient.initialSteadyLinearHeatRate`. The steady field is computed by the independent finite-volume solver on the case's own mesh with the case's own properties and boundary (`steadyFv`), written into OFFBEAT's `0/T` as a nonuniform internalField (blockMesh order), and used as the start of the independent solution too. The power history is the TOTAL power and may start at a different value (a step or a shutdown).
4. **Fixed time step.** The user states it; the validator bounds the number of steps; the results report the first-order time error estimate from the independent solver (below), because implicit Euler's energy deposition error is first order in the step (observed in the spike: the mid-pulse temperature was high by exactly the factor 51/50 predicted for 50 steps).
5. **Verification:**
   - exact limits: adiabatic uniform pulse (the fuel heats by E'''/(rho c); with linear c, a + b T gives the quadratic root); cooling of a uniformly hot cylinder against the series solution (Bessel zeros) as the check of the independent solver;
   - an independent time-dependent finite-volume solver (`tests/helpers/fvTransient.ts` and a runtime copy for the results check), validated against those exact limits, then used to cross-check OFFBEAT on the full pin, including the step refinement;
   - energy conservation: energy deposited = energy stored + energy out, from the output fields.
6. **Results**: a time series (peak, fuel surface, cladding inner and outer temperatures, deposited energy) and radial profiles at the output times. The record schema moves to `feed.results/0.2` for transients; the steady record is unchanged.

## Status (2026-10-05)

Steps 1 to 7 and 8 are built and tested; step 9 (Codex review) follows this section's record. Differences from the plan as written:
- Heat capacity enters OFFBEAT through `steel1515TiBanerjee` (the runtime name; the C++ class is `heatCapacityBanerjee1515Ti`, which OFFBEAT rejects as a type name).
- OFFBEAT aborts when asked for the power at a time past the last table point; the writer appends one flat point a step past the end.
- The cross-check bound is the smaller of 3 x the independent solution's own spatial change and 0.5% of the peak rise (plus 0.02 K), and the tests show it fails for a 2% error in the solver's heat capacity or power and for a 1% error in the temperature rise.
- The pulse for the TRIGA case is assumed (sech^2): the UT SAR gives the peak power and the peak temperature of a $4.40 pulse but not the power curve, so that case is illustrative, and is labelled so.
- Mesh cost: the independent solution is run three times (same mesh, doubled mesh, halved step); a case whose cells x steps would take noticeably long skips only the editor's preview, not the run's checks. A hard cap on transient mesh size is still to do (see TODO).

## Steady operating state as the start (2026-10-06)

Evidence: `tests/steadyInitialState.test.ts` (solver-free) and `tests/steadyStartSolver.test.ts` (real OFFBEAT, `FEED_SOLVER=1`); example `examples/synthetic-pulse-operating.json` (`scripts/make-operating-pulse.cjs`).

- The steady field converges to the closed-form profile at second order (errors fall by 3.6 to 3.7 per doubling of the cells; largest in the centre cell, whose value is a volume average) for constant and linear conductivity, convective and prescribed-wall boundaries, and annular fuel. It is a fixed point of the transient solver, and a scram from it returns the stored heat. A field the iteration cannot settle, or with a non-positive conductivity, is refused with the reason.
- **OFFBEAT's own discrete steady state is not exactly this field.** Held at its power for 100 s, the synthetic pin (20 + 6 cells, 20 kW/m, 736 K above its coolant) drifted by 2.2 K at the centre (0.3% of the rise) to OFFBEAT's own steady state; the drift falls by more than 3 when the cells are doubled. The centre cell relaxes in about 0.04 s, so a tenth of that offset is gone within a 10 ms pulse. The cross-check reports it as its value; thresholds for a steady start scale with the peak ever reached above the coolant, not with the rise from the start.
- A pulse on the operating state: the difference between a pulse run and a hold run at 10 ms equals the pulse's own energy over the fuel's heat capacity to 0.005 K (the model is linear for constant properties, so this does not depend on the offset above).
- Energy balance from a steady start is judged against the largest of the energy deposited, rejected and stored (a shutdown deposits nothing). **Limit:** it integrates the heat leaving over the saved outputs, so a fast shutdown with sparse outputs fails it (39% at 10 s outputs on a pin that falls 640 K in 10 s) although the independent comparison agrees to 0.5 K; use outputs fine enough to resolve the decay.
- Deliberate faults caught: a field written in the wrong cell order, and a field for a 5% different power. 28 mutations of the logic, all caught (the first run found two weak spots, an equivalent mutant and a vacuous balance check; both fixed).
- Not done: OFFBEAT computing its own steady state as the start (would remove the offset; costs a second run); a SEED oracle entry for a steady start.

## Order of work

1. Spike: OFFBEAT runs the pulse (done 2026-10-05: power table and fixed step work; adiabatic limit reproduced to the digit at the end of the pulse).
2. Schema, units, validator: heat capacity, `transient` section, new error codes if needed.
3. Closed-form and independent solver; oracle table entries.
4. Writer (power table, heat capacity, controlDict), run script (all output times), run manager classification.
5. Results parser and checks.
6. Editor: transient panel, material heat capacity, time plot.
7. Sourced case: UT-Austin TRIGA pulse (heat capacity from Table 4.1); comparison with the SAR's pulse results (Figures 4.26, 4.27 and the stated 824 C at $4.40) only as a plausibility check, since the pulse shape is not given.
8. SEED adapter and oracle entries for transient results (separate step; the adapter refuses transient results until then).
9. Codex review.

## Open

- Pulse shape for TRIGA: the SAR gives peak power and maximum temperature versus reactivity, not the power curve. Done 2026-10-06: the point-kinetics generator ([../point-kinetics.md](../point-kinetics.md)) is that separate, clearly labelled input generator; the UT-Austin case itself still uses its assumed sech^2 table until sourced kinetics constants for that reactor are put in.
- Gap heat capacity and gas dynamics: none.
- Boiling and film boiling after a pulse (K-State SAR discusses it): the film coefficient is an input; no boiling model.
