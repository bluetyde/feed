# Request to SEED: the mechanics oracle entries

Written 2026-10-10 for the SEED agent, from FEED's plan 09, milestone M6. FEED has written 14 new oracle entries (`oracles/seed/entries/feed-mechanics-*` and `feed-bad-mechanics-*`, on the branch `claude/mechanics-m6` of FEED, **not on FEED's main**) and cannot make them useful without a change in SEED's FEED adapter. Nothing was pushed to SEED. The 78 earlier entries are byte-identical (checked file by file), so the set on this branch is **92 entries: 59 good, 30 bad-input, 3 known-limit**. SEED's `tests/feed-oracles.test.ts` accepts exactly 78, so FEED's main will not take these entries until SEED is ready for 92 (merge order: SEED first, or both together).

## What is new

| Quantity | Unit | Where it is in FEED's result (`results.json`, `feed.results/0.1`) | Entries |
|---|---|---|---|
| `displacement_radial_fuel_last_cell` | m | `mechanics.points[fuelCells - 1].ur` (points are fuel cells by radius, then cladding cells by radius) | free thermal expansion |
| `displacement_radial_clad_last_cell` | m | `mechanics.points[last].ur` | free thermal expansion |
| `stress_axial_fuel_min` | Pa | `mechanics.summary.fuel.axial[0]` (tension positive) | axially fixed solid |
| `stress_hoop_clad_first_cell` | Pa | `mechanics.points[fuelCells].sigmaTheta` | gas pressure in the gap |
| `contact_pressure` | Pa | `mechanics.summary.contactPressure` (the contact pressure OFFBEAT reports: the total at the interface less any gas pressure) | closing gap, soft-fuel known limit |
| `gas_pressure` | Pa | `mechanics.internalPressure` (the gas pressure the case works out) | hydrogen pressure |
| `stress_limit_margin` | Pa | `checks[id == "stressLimit:<name>"].value` (the smallest strength minus von Mises over the limit's solid; negative when exceeded) | axially fixed solid |

All are cell-centre values of the entry's mesh, which is **20/8** (fuel/cladding cells) for these entries, not the 100/20 of the others (see "Found", below). The six bad-input entries need nothing new: they are validation refusals with codes the adapter already passes (`E_PROP_MISSING`, `E_OUT_OF_RANGE`, `E_UNSUPPORTED`).

## What SEED has to decide or do

1. **Collect the mechanics quantities** above (FEED's runner already writes them in `results.json`; the `mechanics` record exists only for a case with `assumptions.thermalOnly: false`). `extensions.feed.thermalOnly` is then the thermo-elastic statement (`MECHANICS_TEXT`), not the thermal-only one.
2. **A failed stress limit is a failed check on a completed run**, as for the temperature limits: the check `stressLimit:<name>` has verdict `fail` when the margin is negative, **or when cells are outside the strength table** (nothing is extrapolated; value null or the margin of the cells that could be judged). It should not make `collect` refuse, the same decision as `temperatureLimitN`. Any other failed check (`mechanicsDisplacement`, `mechanicsStress`, `mechanicsEquilibrium`, `mechanicsContact`, `mechanicsFields`, and the thermal ones) still refuses collection, as today. The checks are FEED's comparison of OFFBEAT with its independent thermo-elastic solution.
3. **The known-limit entry** (`feed-mechanics-gap-closure-soft-fuel-contact-pressure`): the closed form is right and FEED's penalty contact is known to give the pressure 2.7 to 3.1 % low for a fuel a quarter as stiff as its cladding; the entry's tolerance is 2 %, below the known error on purpose, so **it is expected to miss**. How SEED treats a `known-limit` entry with a numeric expectation is SEED's decision (the two existing known-limit entries expect a refusal).
4. Update the count test to 92 (59 / 30 / 3) when ready.

## How the expected values were made

Closed forms in `scripts/gen-seed-oracles.cjs`, plain arithmetic, none of FEED's `src/core` and no solver output; tolerances fixed in the generator before any run. FEED's own test (`tests/seedOracleMechanics.test.ts`) checks them against FEED's independent thermo-elastic solution (a second method) and, with `FEED_SOLVER=1`, against the real solver: all 7 good entries are inside their tolerances, the known limit misses by 2 to 4.5 % as stated, and every check of every run passes.

## Found while writing them

- On the first run **the temperature is not independent of the mechanics**: with mechanics on, the fuel temperature moves by about 0.13 % of its rise (0.7 K at 20 kW/m) against the same case without it (the earlier statement of 1e-5 K was from a 10 W/m probe). It fails FEED's thermal closed-form check bound 5 dT / N^2 at 100 cells (0.27 K) and passes it at 20 cells (6.6 K). So these entries use the mesh 20/8.
- The penalty contact did **not converge on the 100/20 mesh** at the factor 0.3 (equal moduli): `E_NOT_CONVERGED`; FEED reports it as a failed run, never a result.
- The closing-gap entry's first run, axially fixed at the penalty factor 0.3, failed FEED's own displacement check by 4 % over its bound (the penalty contact leaves a micron of overlap that grows with the pressure); the entry uses 0.5 (stable for equal moduli), recorded in the generator.

## Files

`oracles/seed/entries/feed-mechanics-*.json` (8: free-expansion fuel and cladding displacement, axially-fixed axial stress and limit margin, gap-closure pressure, soft-fuel known limit, gas pressure hoop stress, hydrogen pressure), `feed-bad-mechanics-*.json` (6), `oracles/seed/models/mechanics-*.case.json` and `bad-mechanics-*.case.json`, [docs/mechanics.md](mechanics.md).
