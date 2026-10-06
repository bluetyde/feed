# The point-kinetics pulse generator

A power history for a pulse, computed from a reactivity insertion instead of typed in as a table. It is an **input generator**: it produces the `transient.powerHistory` the thermal run uses, and the pin affects it only through one lumped number (the fuel's average temperature, below). Code: `src/core/pointKinetics.ts`; validation in `src/core/validate.ts`; example `examples/synthetic-pulse-kinetics.json` (`scripts/make-kinetics-pulse.cjs`); tests `tests/pointKinetics*.test.ts`.

## What it solves

```
dP/dt   = ((rho - beta) / Lambda) P + sum_i lambda_i C_i      P: total reactor power (W)
dC_i/dt = (beta_i / Lambda) P - lambda_i C_i                  C_i: precursor power of group i (W)
dE/dt   = P                                                   E: energy released (J)
rho     = rho_inserted(t) + integral from T0 to Tbar of alpha(T) dT
```

- **Insertion:** a step, or a linear ramp over `insertionTime` (a rod ejected in tens of milliseconds is a ramp). The reactivity may be given in `dk/k`, `pcm` or **dollars** (a dollar is the case's own total delayed fraction, so dollars need the delayed groups).
- **Delayed neutrons:** any number of groups up to 8, each `{fraction, decayConstant}`, with a stated source; an empty list is a prompt-only model. The precursors start in equilibrium with the initial power.
- **Feedback:** the differential coefficient `alpha(T)` of the fuel temperature, **negative** (zero or positive feedback does not end a pulse and is refused): `constant`, or `linear` (a + b T) over a stated range, with a stated source. `Tbar` is the fuel's volume-average temperature **if the heat stayed where it was made**: the energy per unit fuel volume is `E x peaking / (pins x active length) / fuel area`, and the fuel's own heat capacity law `c(T) = a + b T` from the case turns it into a temperature (closed form).
- **The pin's share:** `core {pins, activeLength, peakingFactor}` (nothing defaulted): the linear heat rate of the modelled slice is `P x peaking / (pins x active length)`.
- **Integration:** Dormand-Prince 5(4) with error control (relative 1e-9), steps capped at the window / 5000. The curve is then thinned (Douglas-Peucker, peak vertex always kept) to at most **1000 points** whose energy is within **0.1%** of the integrated energy; if it cannot be, the case is refused (`E_KINETICS`).

## In the case

`transient.pointKinetics` **replaces** `transient.powerHistory`: exactly one (`E_TRANSIENT_INCOMPLETE` for both or neither). The validator generates the pulse once, after the case is normalized, and the history it makes is an ordinary history to everything downstream (the case writer, the independent finite-volume solution, the results, the preview). With a steady start (`initialSteadyLinearHeatRate`) the pin's operating heat rate must equal the generator's initial power times peaking over pins times length, else `E_OUT_OF_RANGE` with both numbers: they are one operating state.

Refusals: a pulse that does not happen inside the window (`E_KINETICS`: lengthen the run or raise the initial power), a linear coefficient whose range the fuel temperature leaves, a heat capacity law that cannot absorb the energy, an integration that would need more than 2 million steps, implausible inputs (delayed fraction above 0.02, reactivity above 0.1 dk/k, generation time outside 1 ns to 1 s), a missing source for the delayed data or the feedback.

## Evidence

- **Exact results, written independently of the integrator** (`tests/pointKinetics.test.ts`): Nordheim-Fuchs (no delayed neutrons, constant feedback): peak `rho0^2 / (2 gamma Lambda)`, energy `2 rho0 / gamma`, width `3.5255 Lambda / rho0`, the whole curve a `sech^2`, the reactivity ending at minus its inserted value (peak and energy to 2e-4). The **inhour equation**: a step with six delayed groups and no feedback is a sum of exponentials whose rates are roots of `rho = s Lambda + s sum beta_i / (s + lambda_i)`; the power at ten times matches to 1e-6 for a delayed-supercritical ($0.5), a prompt-critical ($1) and a subcritical (-$1) step. Equilibrium is a fixed point.
- **An independent implementation** (`oracles/point-kinetics-reference.py`: fixed-step RK4, bisection for the temperature, numerical quadrature of the feedback; run in the feed-solver distro's Python and saved in `oracles/point-kinetics-reference.json`, its inputs in `oracles/point-kinetics-cases.json`): three cases (the example; a ramped $2.5 with linear feedback, linear heat capacity, peaking 1.3 on 4 pins, warm start; prompt-only Nordheim-Fuchs). Peak power agrees to 1e-5 (the example to about 1e-8), time of peak to 0.02 ms, energy to 1e-5, width to 1e-4, final fuel temperature to 0.01 K.
- **Through OFFBEAT** (`tests/pointKineticsSolver.test.ts`, `FEED_SOLVER=1`): the example (a $3 step on the synthetic pin: peak 167.7 MW, 10.8 ms wide, 265 K) runs, every check passes, and the centre of the fuel reaches the adiabatic value of the generated energy to 0.5 K.

## The check that tests the model's assumption

The feedback used the fuel's temperature as if no heat left it. The pin loses heat to the coolant, so the generated pulse is valid only while that is small. The results carry a check `pulseGenerator`: the generator's lumped fuel temperature against the **pin's real volume-average fuel temperature** (from OFFBEAT's fields) at every output, failing above 2% of the generator's peak rise plus 0.1 K. Measured on the example: at 60 ms (the pulse and a few milliseconds after it) it passes (3.0 K against a bound of 5.3 K); at 80 ms the pin is 5.7 K below the adiabatic average (bound 5.3 K) and the check fails; at 150 ms it is 13.8 K (5.2% of the rise). The example's window is therefore 60 ms, the pulse and its immediate aftermath. A solver given half the heat capacity is caught by this check and by the cross-check.

## Not modelled, and not claimed

- **Heat leaving the fuel** inside the generator (the check above measures it; it does not correct for it). Coolant, void and moderator feedback, control rods and scram, xenon, spatial effects, changes of the delayed fractions or generation time with temperature.
- **Any real reactor's numbers.** The delayed-neutron data of the example are Keepin's U-235 set (textbook); the generation time, coefficient and core are chosen. A TRIGA case would need that reactor's own sourced values and a comparison with its safety analysis report; the UT-Austin $4.40 example still uses its assumed sech^2 table.
- Which pulse you get depends on the inputs; FEED does not know whether they describe a reactor that exists.

## Not done

- Moving the independent solutions out of the server process (the worker) is the next item of the roadmap.
- A reference for the delayed groups with a ramp against a published pulse is not available here; the exact results above cover the model, not a plant.
