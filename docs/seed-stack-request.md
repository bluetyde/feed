# Request to SEED: the axial stack and plate oracle entries

Written 2026-10-16 for the SEED agent, from FEED's plan 12, milestone A8. **Nothing was pushed to SEED.** The SEED agent was told by an entry in SEED's log (`messages/experiment-studio.md`) on 2026-10-16, on the user's word; what to do with it is for the SEED agent and the user. FEED has written 24 new oracle entries (`oracles/seed/entries/feed-stack-*`, `feed-plate-steady-*`, `feed-bad-axial-*`, `feed-bad-plate-*`), **now on FEED's main** (merged 2026-10-16 with the branch `claude/oracles-a8`). The 101 earlier entries and their 72 case files are byte-identical (FEED's test `tests/seedOracleStack.test.ts` checks the hash of every one of the 173 files), so the set on this branch is **125 entries: 79 good, 43 bad-input, 3 known-limit**. The 101 are on FEED's main (the nine boundary-history entries of [seed-boundary-request.md](seed-boundary-request.md) among them; SEED's `docs/adapter-feed.md`, read on 2026-10-16, still lists them as held back on a FEED branch, so whether SEED's `tests/feed-oracles.test.ts` accepts 101 yet is for the SEED agent to say). It accepted exactly 78, 92 or 101 before, so **a SEED pointed at FEED's main now sees 125 and its count test fails until SEED is updated**; a SEED pointed at an older FEED checkout is not affected.

## What is new

A **stack** is one pin (or one plate) cut into N slices along its height. Each slice has its own heat rate (from a power shape along the height) and its own coolant. The case file has a new optional block `axial` (heated length, number of slices, power shape, optional coolant table against height). A **plate** is a flat fuel plate, one dimension through its thickness: `geometry.kind: "plate"` with `assumptions.geometry: "1D-slab"`. The heat rate of a plate is per metre of height and per metre of width. SEED passes the case to FEED unchanged, so the adapter does not have to read either.

| Case | Entries | What it tests |
|---|---|---|
| `stack-cosine-pin` | peak, hottest slice, lowest slice peak | 9 slices, cosine power, 20 kW/m on average, flat coolant |
| `stack-warming-coolant-pin` | the same three | the coolant warms 573 to 873 K up the pin, so the hottest slice moves up (index 5, not the middle) |
| `stack-skewed-pin` | the same three | a power shape that is not symmetric (a table), so a stack read from the top gives a different answer |
| `stack-cosine-plate` | the same three | a plate, 200 kW per metre of height and width |
| `plate-steady` | `temperature_peak`, `temperature_surface` | one plate, no stack: 592.0933 K at the centre |
| `stack-lumped-plate-loss-of-cooling` | `temperature_peak_max` | 10 plate slices, the film coefficient falls from 3000 to 100 W/m2/K (cooling lost), against a lumped solution |
| `stack-lumped-pin-coastdown` | `temperature_peak_max` | 10 pin slices, the film coefficient decays from 3000 to 300 W/m2/K |
| 8 refusals | `case-validation` | too few slices, a shape of zeros, an unordered coolant table, a stack with mechanics, a coolant table with a boundary history, a plate with a hole, a plate with a radial assumption, a plate thickness in a wrong unit |

That is 12 stack entries, 2 plate entries, 2 transient entries and 8 refusals. The only new refusal code is **`E_AXIAL`** (3 entries); the other five codes are in use already. If the adapter keeps a list of codes, add it.

## New quantities (SEED has to know them)

| Name | Unit | How FEED's result holds it | Kind |
|---|---|---|---|
| `axial_hottest_slice` | 1 | `axial.hottest` of the result record: the index of the slice with the hottest fuel, **0 = the lowest slice** | new scalar, pinned by 4 entries |
| `temperature_peak_slice_min` | K | the smallest of `axial.slices[k].maxT`, the hottest cell of each slice (a cell centre, as everywhere in this set): the coolest slice, usually an end slice | new scalar, pinned by 4 entries |
| `temperature_peak_by_slice` | K | the series `axial.slices[k].maxT` against `axial.slices[k].height` (m above the bottom of the heated length, the slice centre) | **new series quantity: the per-slice peak** |

`temperature_peak_by_slice` is the quantity FEED wants SEED to collect for a stack, like `temperature_peak_history` is collected for a pulse. **An oracle entry holds one number** (`expected` is a scalar), so the series itself cannot be pinned; the two scalars above are what the entries pin. `temperature_peak_slice_min` is the smallest value of the series, and `temperature_peak` (the existing quantity, already the hottest cell of the whole stack) is its largest, so the pinned numbers are the two ends of the series; `axial_hottest_slice` says where the largest is. The question is below.

The existing quantities keep their meaning for a stack: `temperature_peak` is `summary.maxT` (the hottest cell of the hottest slice; the record's `summary` and `radial` are that slice's), `temperature_peak_max` for a transient stack is the largest peak of any slice over the run (`axial.slices[k].maxT` for a transient is the peak over the run; the record's own `series.peakT` is the hottest slice's and gives the same number).

## How FEED reads each entry

- A **steady stack** is run, and FEED's result judges **each slice** as the one-slice pin it is (the same checks, one line per check: a failing slice if there is one, else the worst). `collect` should refuse a stack whose checks fail, as for a single slice. There is one new check line, `energyBalanceTotal` (all the slices' heat against the heat given) and one informational line, `axialConduction` (verdict `na`, never fails).
- The coolant table of a stack is in **metres from the bottom** and the shape table in length units from the bottom.
- The entries pin the hottest slice's peak, its index, and the coolest slice's peak. Quantities are cell-centre values of the mesh 100/20, as for the other steady entries.

## How the expected values were made, and the tolerances

The expected value of a slice is the closed-form solution of that one slice (the series for a pin, the slab formulas for a plate) at its own heat rate and coolant, written out in `scripts/gen-seed-oracles.cjs` in plain arithmetic, with nothing from FEED's `src/core` and no solver output. The solver's slices exchange a little heat along the height, which that solution does not have, so the tolerance is a sum of three terms, each fixed in the generator before any run and written in the entry:

1. **The mesh**: 5 times the slice's centre-to-surface rise over N squared (N = 100), as for the other steady entries.
2. **The axial conduction allowance**: 3 times FEED's estimate of that conduction (a fin model, `docs/axial-stack.md`) as a fraction of the largest rise, times the largest rise of any slice above its coolant. The estimate is 0.1 to 0.2 % of the rise; this term is 0.9 to 6.6 K.
3. **A cosine** is written to the solver as a 41-point table; this differs from the exact cosine by at most 1e-3 of a slice's rise. A table shape has no such term.

The sum is rounded up to 0.05 K. The index entries have no tolerance (an integer), and the generator stops if the hottest slice does not lead the next by more than twice the largest tolerance, so the solver's own choice cannot differ. The two transient entries add: 1 % of the rise (as the boundary-history entries), twice FEED's bound on the heat the slices exchange along the height during a run (rate 0.0033 per second, exchange number 0.13 against the limit of 1 FEED counts it up to), and the internal rise of the hottest cell above the lumped mean (0.4 to 0.6 K). Their expected value is a lumped (one temperature per slice) solution by RK4, as in the boundary-history request.

## What the real solver gave

FEED's own test (`tests/seedOracleStack.test.ts`) runs the cases through FEED's writer and run manager into the real solver (WSL distro `feed-solver`) with `FEED_SOLVER=1`, and keeps the output (`tests/golden/seed-oracles/`) so that the comparison also runs without the solver. Every check of every run passes. Observed minus expected, with the tolerance:

| Entry | Expected | Solver minus expected | Tolerance |
|---|---|---|---|
| `stack-cosine-pin` peak / lowest slice | 1727.93 / 773.55 K | +0.17 / +0.92 K | 5 / 3.7 K |
| `stack-warming-coolant-pin` peak / lowest slice | 1027.65 / 639.80 K | -0.16 / +0.35 K | 1.25 / 0.95 K |
| `stack-skewed-pin` peak / lowest slice | 1525.45 / 970.72 K | -0.22 / +0.36 K | 6.05 / 5.85 K |
| `stack-cosine-plate` peak / lowest slice | 872.92 / 625.08 K | -0.05 / +0.54 K | 1.65 / 1.3 K |
| `plate-steady` centre / face | 592.0933 / 573.6667 K | 0.0000 / 0.0000 K | 0.05 / 0.2 K |
| `stack-lumped-plate-loss-of-cooling` | 801.92 K | -0.76 K | 5.3 K |
| `stack-lumped-pin-coastdown` | 728.41 K | -0.14 K | 3.3 K |

All four hottest-slice indexes (4, 5, 3, 4) are the solver's. The run time is a few seconds each (21 s for the eight runs together).

## Questions for SEED

1. **Do SEED's project and case formats need the axial section?** Today the whole case is passed through unchanged, so a stack works without any change in SEED. But the natural sources of a stack's inputs are other apps: the power shape along the height comes from an OpenMC tally (heating by height bin) and the coolant along the height from a NODAL channel. Should SEED's transfer recipes fill `axial.powerShape` and `axial.boundary`? FEED's existing transfer (`docs/transfer-heating.md`) fills one power per region, not per height. This is a design question, not something these entries need.
2. **The per-slice quantity.** Will SEED collect `temperature_peak_by_slice` (a series on a height axis) and the two scalars? Or does SEED want the oracle format to hold a position (an `at` coordinate on a scalar), so that each slice of a stack can be pinned by its own entry? FEED can regenerate the entries either way.
3. Update the count test to 125 (79 / 43 / 3) when ready, and pass the code `E_AXIAL` if the adapter keeps a list.

## Not covered

The heat that the slices exchange along the height is not in the expected values; only its bound is in the tolerance. A power shape with steep ends, a stack so short that the conduction is more than 2 % (FEED warns with `W_AXIAL_CONDUCTION`), a transient with an exchange number above 1, a plate cooled differently on its two faces, mechanics or burnup on a stack, boiling. The example cases are illustrations, not oracles.

## Files

`oracles/seed/entries/feed-stack-*` (14: 12 steady stack entries and 2 transient ones), `feed-plate-steady-*` (2), `feed-bad-axial-*` (5), `feed-bad-plate-*` (3), `oracles/seed/models/stack-*.case.json`, `plate-steady.case.json`, `bad-axial-*.case.json`, `bad-plate-*.case.json`; [docs/axial-stack.md](axial-stack.md), [docs/plate.md](plate.md).
