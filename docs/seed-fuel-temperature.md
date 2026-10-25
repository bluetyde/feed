# The fuel temperature by slice: FEED's side of SEED's power-temperature loop

Written 2026-10-25 for the SEED agent, on the owner's word, from the brief that SEED's session left (SEED `docs/coupling-prerequisites.md` sections 2 to 4, `transfer-recipe.md` 2.1 and 5, `adapter-feed.md`). **Nothing was pushed to SEED and no SEED file was edited.** SEED owns the loop and its records; FEED owns the physics (decision D3). What FEED provides is a **declared** return quantity, a heating transfer that replaces instead of accumulating, and the evidence that a run is deterministic and fails typed.

The loop: OpenMC heating to FEED (`heating-to-pin`, exists), FEED's fuel temperature back to OpenMC (a material temperature; OpenMC Studio's side takes one absolute temperature per material, the volume-mean fuel temperature, and says it must not be called a Doppler-effective one).

## 1. The quantity

Declared in `node dist/cli/headless.js describe`, field `resultQuantities` (`schema: "feed.fuel-temperature/0.1"`), and carried in `results.json` of a **steady** run as the field `fuelTemperature`.

| Name | Kind | Unit | Dimension | Normalization | What it is |
|---|---|---|---|---|---|
| `temperature_fuel_mean_by_slice` | series | K | temperature | none (absolute) | the volume-mean fuel temperature of each axial slice, against `z` |
| `temperature_fuel_mean_slice_max` | scalar | K | temperature | none | the largest value of the series |
| `temperature_fuel_mean_slice_min` | scalar | K | temperature | none | the smallest value of the series |
| `temperature_fuel_mean` | scalar | K | temperature | none | the volume mean over **all** the slices of the result: the slices' means weighted by slice length (the fuel cross-section is the same at every height). One number, the form a code with one temperature per material takes. For a one-slice result it is that slice's value, **not** the pin's |

The maximum of each slice is not a new quantity: `temperature_peak_by_slice` (a stack's `axial.slices[k].maxT`, in `docs/seed-stack-request.md`) is the hottest cell centre of each slice, which is a fuel cell. A centreline temperature is not offered: the solver's innermost cell centre is a cell width from the axis.

**The shape in `results.json`** (a stack of N slices; numbers illustrative):

```
"fuelTemperature": {
  "schema": "feed.fuel-temperature/0.1",
  "quantity": "temperature_fuel_mean_by_slice", "unit": "K", "dimension": "temperature", "normalization": "none",
  "axis": { "name": "z", "unit": "m", "origin": "<text>", "frame": null },
  "state": "steady-state", "final": "<text>",
  "geometry": { "kind": "pin" | "plate", "fuelRadius": m, "fuelInnerRadius": m, "claddingInnerRadius": m, "claddingOuterRadius": m, "fuelCells": n, "heatedLength": m | null },
  "slices": [ { "index": 0, "zMin": m, "zMax": m, "volumeMean": K }, ... ],
  "scalars": { "temperature_fuel_mean_slice_max": { "value": K, "slice": i }, "temperature_fuel_mean_slice_min": { "value": K, "slice": i }, "temperature_fuel_mean": { "value": K } },
  "meaning": "<text>", "notCovered": [ ... ]
}
```

- **The axis `z`, its unit and origin.** Metres. For an **axial stack**: z = 0 at the bottom of the heated length of the pin (FEED's own axis, positive upward); slice k spans k h to (k + 1) h, h = length / slices; `axis.frame` is null. For a **one-slice case whose heat rate a heating transfer set**: the slice the transfer was made for, its `zMin` and `zMax` taken from the case's provenance (`provenance.transfers`, the last entry of kind `heating`), in **the source table's own frame** (FEED applies no transform; `axis.frame` is that frame's name and `axis.origin` says so and names the slice and the pin). A plain one-slice pin with no transfer has no position and **no such field**.
- **The pin geometry the slices belong to** is in `geometry`, in metres (hot radii when the case asks for hot dimensions). A plate has the same fields; its `fuelRadius` is the half-thickness of the meat.
- **The meaning** (`meaning`, and in `describe`): the sum over the slice's fuel cells of the **solver's cell-centre temperature times the cell's volume** (the annulus the cell fills for a pin, its width for a plate) over the slice's fuel volume. Absolute kelvin, not a rise above the coolant. **Not** a cross-section-weighted (effective, Doppler) temperature; a code that wants one takes it from the radial profile.
- **Steady or a time series, and what final is.** **Steady-state only**, one value per slice: the value of the converged state the solver stopped at. A result of a run that did not converge is never produced (section 4), so "final" is always a converged state. A transient (a pulse, a loss of cooling) has no such field; a loop is steady-state first (SEED's 4.2).
- **Where it is present:** a steady axial stack (pin or plate); a steady one-slice case whose heat rate came from a heating transfer. **Absent:** a transient, a particle, a compact, a pebble, a plain one-slice case with no position.

## 2. Applying heating again replaces

`transferHeating` sets `power.linearHeatRate` (overwritten, never added to) and records the transfer in `provenance.transfers`. **It used to append its entry every time**, so 25 passes left 25 heating entries. It now **drops any earlier entry of kind `heating`** and appends its own: the case has one heat rate, so only the last heating describes it. Entries of other transfers (burnup, coolant boundary) are kept as they are. Tests (`tests/seedFuelTemperature.test.ts`): applying A then B gives the case that applying B alone gives, byte for byte; 25 passes in a row leave one heating entry, the last pass's, and the other transfer's entry; the position of the quantity follows the replacement. Not changed: the coolant-boundary and burnup transfers still append their own entries on every application (the loop does not apply them again; say so if it will).

A note for the loop: the transfer sets the heat rate of **one chosen slice** (`mapping.spatial.applyTo`) of a one-slice case, so a profile of N slices needs N cases (N recipes) per pass, or a FEED transfer that builds a **stack** case from all the slices at once (`heating-to-stack`: it does not exist; it is a decision for the owner and a FEED change). The quantity above works for both.

## 3. Determinism

The same inputs give the same output. The pure parts (the transfer, the results builders) are tested twice byte for byte. Through the real solver (`FEED_SOLVER=1`): a stack and a transferred one-slice pin were each run twice through FEED's run manager and the whole results record (the new field included) is **byte-identical** (2026-10-25, Windows 11, the `feed-solver` distro, OFFBEAT 80e84450). SEED's own test already found FEED's `results.json`, `derived.json` and `case.json` byte-identical across two standalone runs of nine cases (adapter-feed.md, 2026-10-14). **Not tested:** across machines or thread counts.

## 4. A thermal solve that does not converge is a typed failure

OFFBEAT ends a step at its iteration cap and accepts it silently (same output, exit 139), so FEED judges the solver's own log: the last outer iteration of the final step must meet OFFBEAT's thermal criterion. If it does not, the run **ends `failed` with `E_NOT_CONVERGED`**, the evidence from the log is kept in the failure, and **no result is made: no `results.json` and no `fuelTemperature`**. This happens before any result is read, so it holds for a stack as for one slice (`tests/runManager.test.ts`, "THE PROBE CASE"; `tests/seedFuelTemperature.test.ts` for a stack). Through the headless runner: `run` replies exit 0 with `status: "failed"` and `reason: "<CODE>: <message>"`.

The codes a run can end with: `E_NOT_CONVERGED`, `E_TIMEOUT`, `E_CANCELLED`, `E_APP_FAILED` (the solver or its environment failed: the mesh, the exit record, a FOAM FATAL, a kill from outside), `E_OUTPUT_INCOMPLETE` (output cut short or unreadable), `E_VERIFY_INCOMPLETE` (a transient whose independent checks could not finish: not this quantity), `E_SCHEMA_INVALID`. A case that is refused before running: exit 2, `ok: false`, typed errors (for example `E_UNITS`, `E_PROP_MISSING`, `E_OUT_OF_RANGE`, `E_BOUNDARY_INCOMPLETE`, `E_MESH`, `E_GEOMETRY`, `E_AXIAL`, `E_UNSUPPORTED`); no solver found: `E_SETUP_REQUIRED`. A completed run whose own checks fail (`closedFormFuel` and the others) is not accepted by the SEED adapter (`E_OUTPUT_INCOMPLETE` in `collect`), as today.

## 5. The time per run (measured 2026-10-25, one machine, not verified idle: indicative)

Steady, mesh 100 fuel / 20 cladding cells, through FEED's run manager and the real solver (the WSL distro already running): **1.6 to 1.8 s** for a stack of 9 or 10 slices, a plate stack, a one-slice pin; **3.6 s** for the two transient stacks (not this quantity). Start-up of the distro when it is cold is extra. A loop of 25 passes at this size is about 45 s of FEED time per case.

## 6. Oracle entries

13 new entries in `oracles/seed/entries/` (138 now: 92 good, 43 bad-input, 3 known-limit; the 125 earlier files are byte-identical): for each of the four stack models (`stack-cosine-pin`, `stack-warming-coolant-pin`, `stack-skewed-pin`, `stack-cosine-plate`) the three scalars `temperature_fuel_mean_slice_max`, `temperature_fuel_mean_slice_min`, `temperature_fuel_mean`, and one for the **transferred one-slice pin** (`fuel-mean-transferred-pin`, a case with a heating provenance entry: `temperature_fuel_mean` = 1042.996 K). **The oracle format holds one number, so the series itself is not pinned**, only its largest, smallest and mean (as for the peak by slice).

How the expected values were made: in `scripts/gen-seed-oracles.cjs`, plain arithmetic, nothing from `src/core` and no solver output: the mean of a solid pin's parabola is the surface plus half the centre-to-surface rise, a plate's the surface plus two thirds of it, per slice at its own heat rate and coolant; tolerances are the terms of the stack's peak entries (the mesh bound 5 rise / N^2 at N = 100, the axial conduction allowance 3 x estimate x the largest rise, the cosine's table term), taken at their largest over the slices and rounded up to 0.05 K, fixed before any run (the transferred pin: the mesh bound, 0.3 K). The values are worked again by hand in `tests/seedOracleStack.test.ts` and against FEED's closed form integrated numerically (`tests/seedFuelTemperature.test.ts`); the saved real-solver output (`tests/golden/seed-oracles`) is inside every tolerance, and a live run through the solver is too (all five steady cases, `FEED_SOLVER=1`).

**For SEED:** its `tests/feed-oracles.test.ts` accepts an exact set and will need the new count (138 = 92 / 43 / 3) and the new quantity names when the adapter is changed to read `fuelTemperature`; the adapter's `describe` can read `resultQuantities`. The 13 entries are on a FEED branch until the owner merges and pushes them.

## 7. Not covered

A transient, a particle, a compact, a pebble; a time series; a plain one-slice pin without a transfer; a centreline temperature; a cross-section- or flux-weighted temperature; the physical validity of the loop's result (SEED's coupled-result oracle, 4.6, is SEED's); the heating transfer's boundary and burnup entries still append; a heating transfer that fills a whole stack at once; reproducibility across machines.
