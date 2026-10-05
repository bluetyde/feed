# Plan 08: Thermal transients (pulses)

Status: started 2026-10-05, user request "do the pulse transients". Extends the steady thermal tool with a time-dependent heat source and heat capacity. Still thermal only: no mechanics, no reactivity feedback. The power history is an input; FEED does not compute the pulse.

## What is solved

rho c(T) dT/dt = (1/r) d/dr ( r k(T) dT/dr ) + q'''(t)   in the fuel (uniform in r, scaled by the input linear heat rate q'(t))
rho c(T) dT/dt = (1/r) d/dr ( r k(T) dT/dr )              in the cladding

Same geometry (solid or annular fuel, gap as one conductance, cladding, convective or fixed-temperature outer boundary). The gap has no heat capacity. Implicit Euler in time with a fixed step, as OFFBEAT does it.

## Decisions

1. **Heat capacity is volumetric** (`thermal.volumetricHeatCapacity`, J/m3/K), constant or linear c = a + b T (T in K), per material, with a stated source and valid range like conductivity. The UT-Austin SAR gives U-ZrH as 2.04 + 0.00417 T[C] J/cm3/K, which doubles over the pulse range, so a constant is not acceptable for TRIGA. OFFBEAT's `steel1515TiBanerjee` model reads `par1 + par2 T + par3 T^-2` from a `heatCapacity` block, so with `par3 = 0` and the (constant) density as divisor it carries any linear volumetric law (the same trick as the conductivity; the model name is a misnomer, recorded in the manifest).
2. **A transient case is `assumptions.steadyState: false` plus a `transient` section.** The section holds the power history (time, linear heat rate points, linear interpolation), end time, time step, and the number of outputs. A steady case with a `transient` section, or a transient case without one, is refused. Nothing is defaulted.
3. **Initial state: uniform temperature** (given). A steady operating state as the start is a later feature; to approximate one, start the history with a hold.
4. **Fixed time step.** The user states it; the validator bounds the number of steps; the results report the first-order time error estimate from the independent solver (below), because implicit Euler's energy deposition error is first order in the step (observed in the spike: the mid-pulse temperature was high by exactly the factor 51/50 predicted for 50 steps).
5. **Verification:**
   - exact limits: adiabatic uniform pulse (the fuel heats by E'''/(rho c); with linear c, a + b T gives the quadratic root); cooling of a uniformly hot cylinder against the series solution (Bessel zeros) as the check of the independent solver;
   - an independent time-dependent finite-volume solver (`tests/helpers/fvTransient.ts` and a runtime copy for the results check), validated against those exact limits, then used to cross-check OFFBEAT on the full pin, including the step refinement;
   - energy conservation: energy deposited = energy stored + energy out, from the output fields.
6. **Results**: a time series (peak, fuel surface, cladding inner and outer temperatures, deposited energy) and radial profiles at the output times. The record schema moves to `feed.results/0.2` for transients; the steady record is unchanged.

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

- Pulse shape for TRIGA: the SAR gives peak power and maximum temperature versus reactivity, not the power curve. A parametric pulse (Fuchs-Nordheim) would be a separate, clearly labelled input generator.
- Gap heat capacity and gas dynamics: none.
- Boiling and film boiling after a pulse (K-State SAR discusses it): the film coefficient is an input; no boiling model.
