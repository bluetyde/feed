# M0 of the burnup plan: what OFFBEAT's `UO2MATPRO` does on FEED's thermal-only pin

Done 2026-10-07 for [plan 10](../plans/10-burnup.md), milestone M0. **Question:** with the fuel on OFFBEAT's `UO2MATPRO` conductivity model and a burnup given through `burnup constant` and a `Bu` file, does the pinned OFFBEAT (`80e84450`, OpenFOAM 9) run on FEED's own thermal-only case, and does its conductivity equal the MATPRO equation as the source codes it? **Answer: yes to both. The gate is met by a wide margin.**

Nothing in FEED's case writer changed. The probes take what the writer wrote, replace the fuel's conductivity lines, switch `burnup none` to `burnup constant`, add a `0/Bu` file, and run it through `solver/probe-mechanics.sh`. Test: `tests/burnupProbe.test.ts` (`FEED_SOLVER=1`, 7 tests). The expected values are the equation written in the test file, sharing no code with FEED.

## What the probes found (the synthetic pin at 20 kW/m, 100 fuel and 20 cladding cells, fuel density fraction 0.95, cladding k = 15, film 30000 W/m2/K at 573 K, gap 5000 W/m2/K)

1. **It runs thermal-only.** `conductivityModel UO2MATPRO;` in the fuel material block of a `constant` material, with `densityFraction 0.95;` and the 13 parameters, works with `burnup constant;` and with no other change: no `UO2` material class, and no swelling, porosity or densification fields needed (they are absent, and the model skips them). Exit 139 after a complete write (the known shutdown crash), no `FOAM FATAL`. The two warnings in the log are not about burnup: **`mechanicsSolver fromLatestTime` and `corrosion fromLatestTime` are deprecated** ("please use `constant`"), which FEED's writer still writes (see the last section).
2. **OFFBEAT writes its own conductivity field `k`** (W/m/K, one value per cell, 7 digits), and `Bu`. So the model's arithmetic can be compared cell by cell with the temperature solution out of the way.
3. **`k` equals the MATPRO equation as coded, in every fuel cell, to the printed digits** (relative difference below 1e-5, the field holds 7 digits) at 0, 20, 40 and 60 MWd/kgHM, using OFFBEAT's own cell temperature in the equation. The equation, from `conductivityMatproUO2.C`: `k95 = 1 / (p1 + p2 T + p3 B + p4 Gd + (1 - p5 e^(-p6 B)) p7 B^p8 / (1 + p9 e^(-p10 / T))) + p11 T^(-p12) e^(-p13 / T)`, `k = k95 x 1.0789 f / (1 + 0.5 (1 - f))`, B in MWd/kgU.
4. **The temperatures follow the closed form** (the integral of this k by Simpson and a bisection, in the test): the largest difference over the 100 fuel cells is **0.035 K at 20, 0.037 K at 40 and 0.039 K at 60 MWd/kgHM** (tolerance in the test 0.5 K, the discretisation bound for 100 cells).
5. **The cost of burnup on this pin** (centre cell temperature): **1238.4 K fresh, 1368.0 K at 20 (+129.6 K), 1469.6 K at 40 (+231.2 K), 1555.3 K at 60 MWd/kgHM (+316.9 K)**; the centre cell's conductivity falls from 2.86 to 2.34, 2.04 and 1.84 W/m/K. (Frozen burnup, fixed gap, uniform over the slice: the teaching number, not a prediction for a real rod.)
6. **The model divides `Bu` by 0.881, not 0.8815.** A `Bu` written as `B x 0.8815 x 1000` is read as B x 0.8815 / 0.881 and gives a conductivity 95 ppm away from the intended one at 40 MWd/kgHM; the test shows `k` equals the equation at the burnup the model sees. So FEED writes `Bu = B_HM x 0.881 x 1000` MWd/t for this model, the model's own constant.
7. **An omitted parameter takes MATPRO's default silently.** With `par1` left out the run completes, the log never mentions it, and `k` equals the equation with the default 0.0452; with `par1 = 0.06` written `k` differs (2.8 % at the centre cell) and equals the equation with 0.06. FEED writes all 13 parameters, as it does for every OFFBEAT model.
8. **`Bu` is not changed by the run** (`burnup constant`): the fuel cells keep their written value and the cladding cells their 0.
9. **The default `Bu` file** OFFBEAT writes when none is given is `internalField uniform 0;` with a boundary condition per patch (zeroGradient on the coupled and outer patches, empty and wedge on the others): a handwritten file is made from it by replacing `uniform 0` with a `nonuniform List<scalar>` of one value per cell (fuel cells first, then cladding). A file written from a guess at the boundary conditions failed with `FOAM FATAL IO ERROR` in the earlier investigation; this one does not.

## What this changes in the plan

- **The M0 gate is met**: it runs thermal-only, no missing fields to write, and the model equals the equation to 1e-5 in every cell at four burnups.
- **M3's results check can use OFFBEAT's own `k` field**: compare the solver's conductivity cell by cell with FEED's law at the same temperatures, not only the temperatures.
- **The 0.881 question is closed** (item 6), and the factor is the model's, as plan 10 says.
- **The sourcing is the open job**: the equation and the 13 numbers are now known to be exactly what OFFBEAT runs, but they are OFFBEAT's `MATPROv11`; whether they equal the MATPRO report's is M1.

## Not probed

The temperature and burnup range the model is good for (M1: the report states it); Gd content (the `GdContent` keyword, 0 here); other density fractions (the formula is in the test, one value was run); a transient; a radial burnup profile (the file takes one value per cell, so a profile is possible and is not planned); `UO2NFIR` and the IFA601 law; whether OFFBEAT warns outside the model's range (it prints nothing for `UO2MATPRO` on these runs); the U-Pu oxide laws.

## A finding that is not about burnup: the deprecated `fromLatestTime`

Every run log carries two deprecation warnings: `mechanicsSolver fromLatestTime` and `corrosion fromLatestTime`, which OFFBEAT says to replace with `constant`. FEED's writer writes the old words (they work on the pinned stack). Whether `constant` gives byte-identical fields was **not** tried here; it is a small change to make and check separately, and a pinned OFFBEAT is the reason it can wait.
