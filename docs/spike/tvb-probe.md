# Plan 11, B0: what OFFBEAT does with a time-varying boundary

Done 2026-10-14 for [plan 11](../plans/11-time-varying-boundary.md), milestone B0, through the real solver (feed-solver distro, OFFBEAT `80e84450`). **Gate met:** the solver reproduces a lumped case as well as it does with a constant boundary, and every unknown of the plan is answered below. The probe was a throw-away patch of the case writer (`tvb-probe-writer.patch.txt`) driven by an environment variable and a test (`tvb-probe.test.ts.txt`); neither is in the tree.

The case: the synthetic pulse pin with conductivity 100 W/m/K in both solids (Biot number 0.02 at h = 500, so the pin is lumped to a fraction of a percent), gap 1e6, volumetric heat capacity 3 MJ/m3/K (C' = 206.4 J/m/K), 5 W/m (the validator refuses a power history that is zero everywhere), started at 800 K, 40 s, 10 + 4 cells. The lumped solution `C dT/dt = q - h A (T - Tb)` is integrated by RK4 in the test.

## Results

| Probe | What was written | Result |
|---|---|---|
| Control | the constant `convectiveHTC`, h 500, Tb 600 | within 1.24 K (0.2 %) of the lumped curve at every output: this is the baseline offset of the lumped model and the time stepping, not an error of the boundary |
| Step in h | `timeDependentAxialProfileHTC`, h 500 to 100 at t = 10 (over 0.05 s), Tb 600 | maximum deviation 1.24 K, the same as the control |
| Ramp in T0 | the same, T0 600 to 900 over the run, h 500 | maximum deviation 1.18 K |
| Almost no cooling | h falls to 0.001 W/m2/K at t = 10 | runs, converges, maximum deviation 1.24 K; the pin sits at 698 K and drifts up by the 5 W/m, as it should. A near-adiabatic wall is no problem for the solver |
| Prescribed wall ramp | `timeDependentAxialProfileT`, wall 600 to 900 K over 42 s, h irrelevant | the fuel follows the wall within 0.04 K at every output |
| **Which time level** | h steps 500 to 100 at t = 10.0001, time step 2 s, discrete implicit Euler lumped model with the boundary at the new level and at the old level | the solver follows the **new level** (within 0.4 to 1.1 K); the old level is 8 to 11 K off from t = 14. OFFBEAT applies the boundary of the end of the step, as the independent solution has to |
| Table too short | the table ends at 30 s, the run at 40 s | OFFBEAT aborts: "Supplied value 30 is out of bounds (0 ... 30)", exit 134, the output stops at 29 s. **Even a value equal to the last point is out of bounds**, so the table must reach past the end time, as the power table does: the writer appends one flat point beyond it |

## Things the plan did not know

- **Names of the two conditions.** `timeDependentAxialProfileHTC` for a convective boundary (`axialProfileDict` with `timePoints`, `axialLocations`, `hData`, `T0Data`, interpolation words), and for a prescribed wall `timeDependentAxialProfileT` whose dictionary is called **`timeDependentProfile`** and whose table is **`axialData`** (OFFBEAT's own header documents `axialProfileDict` and `data`, which the solver refuses). Axial locations: two columns, 0 and 1 (m; the slice is 1 m high) are accepted.
- **The reader.** OFFBEAT writes the time tables back inside the patch, so the patch block of the written `T` has a sub-dictionary; FEED's `parsePatchValue` ended the block at the sub-dictionary's closing brace and found no `value`, which failed every run ("field T has no value for the cladOuter patch"). Fixed here (the block is now read to its own closing brace, `tests/patchValue.test.ts`, 5 tests); nothing else of the reader changed and the whole suite is unchanged (1513 passed).
- **The checks of a constant boundary do not hold** for a changing one and must change in B2: `crossCheckFv` (the independent solution assumes constants), `energyBalance` (the rejected heat), `timeStep` and, for a prescribed wall, `wallTemperature` (the wall is no longer the constant it is compared with) all failed in the probe, as expected.
- **A zero power history is refused** by the validator ("the power history is zero everywhere"). A pure cooling transient (a hot pin losing its coolant with no heat source at all) therefore needs a decision in B1: keep the rule (the user gives a small or decay power) or allow zero power when a boundary history is stated.
- OFFBEAT still exits 139 after complete output on these runs, as before.

## Consequences for the plan

1. The independent solution takes the boundary **at the new time level** (the boundary at time t_{n+1} in the implicit step).
2. The writer appends a flat point past the end time for the boundary table, like the power table.
3. One reader fix (done), three checks to change (B2), one validator decision (zero power).
4. A film coefficient down to 0.001 W/m2/K is accepted by the solver, so the lower bound in B1 can be a small positive number; whether to also accept exactly zero (adiabatic) is a validator decision, not a solver limit (not probed: zero in the table was not tried because the film-only conductance would divide by it in FEED's own independent solution).
