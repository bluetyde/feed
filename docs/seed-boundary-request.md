# Request to SEED: the boundary-history oracle entries

Written 2026-10-14 for the SEED agent, from FEED's plan 11, milestone B5. FEED has written 9 new oracle entries (`oracles/seed/entries/feed-synthetic-lumped-*` and `feed-bad-boundary-history-*`, on the branch `claude/tvb-b5` of FEED, **not on FEED's main**). Nothing was pushed to SEED. The 92 earlier entries are byte-identical (the generator was rerun; `git status` shows only the new files and the README), so the set on this branch is **101 entries: 63 good, 35 bad-input, 3 known-limit**. SEED's `tests/feed-oracles.test.ts` accepts 78 or 92, so FEED's main should not take these entries until SEED is ready for 101 (merge order as for the mechanics entries: SEED first, or both together).

## What is new

| Entry | Quantity | What it tests |
|---|---|---|
| `feed-synthetic-lumped-film-step-temperature-peak-max` | `temperature_peak_max` (K) | a film coefficient that falls from 500 to 100 W/m2/K at 10 s |
| `feed-synthetic-lumped-bulk-ramp-temperature-peak-max` | `temperature_peak_max` (K) | a coolant temperature that ramps 600 to 900 K over 40 s, no power |
| `feed-synthetic-lumped-coastdown-temperature-peak-max` | `temperature_peak_max` (K) | a steady start at 1 kW/m, then a film coefficient decaying 3000 to 300 W/m2/K over ten seconds |
| `feed-synthetic-lumped-film-step-energy-deposited` | `energy_deposited` (J/m) | the power bookkeeping is unchanged by a history (300 W/m x 40 s) |
| `feed-bad-boundary-history-*` (5) | refusal | unordered times (`E_TIME`), zero film coefficient (`E_OUT_OF_RANGE`), a history in the wrong form for the case (`E_BOUNDARY_INCOMPLETE`), a steady start whose history begins elsewhere (`E_TRANSIENT_INCOMPLETE`), a history that ends before the run (`E_TIME`) |

**No new quantity and no new place in `results.json`.** The two quantities are the ones the pulse entries already use. The case file has a new optional block, `transient.boundaryHistory`; SEED passes the case to FEED unchanged, so nothing in the adapter needs to read it. The only thing to check is that the adapter passes the refusal codes `E_BOUNDARY_INCOMPLETE` and `E_TRANSIENT_INCOMPLETE` if it keeps a list of codes (the others are already in use).

## What SEED has to do

1. Update the count test to 101 (63 / 35 / 3) when ready.
2. Run the three peak entries on the real solver (about 5 s each); every check of every FEED run passes.

## How the expected values were made

The pin has a conductivity of 400 W/m/K in both solids, so it is a lumped body to a small fraction of a kelvin. The generator (`scripts/gen-seed-oracles.cjs`) integrates `C dT/dt = q' - h(t) A (T - T_b(t))` by classical RK4 (step 1 ms) through the history as written, with nothing from `src/core` and no solver output, and checks that each case warms monotonically so that the largest peak over the run is the value at the end time. The tolerance is 1 % of the rise (2.02, 0.72 and 0.42 K), fixed in the generator before any run: the first-order error of the 0.05 s step against a time constant of at least 12 s is 0.4 %.

FEED's own test (`tests/seedOracleBoundaryHistory.test.ts`) checks them against FEED's independent finite-volume solution of the full pin (a second method) and, with `FEED_SOLVER=1`, against the real solver: all three are inside their tolerances, every check passes, and the same cases with the first boundary held lie more than five tolerances away (so the entries do test the history).

## Not covered

A violent change between two saved outputs (the energy balance cannot close it from the outputs; see `docs/boundary-history.md`), boiling or a film coefficient that depends on the wall, any real design. The example cases (`ksu-triga-loss-of-pool`, `synthetic-coastdown`) are illustrations, not oracles.
