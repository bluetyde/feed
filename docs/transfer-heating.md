# The `transfer` command: heating into a pin

2026-10-06. FEED's side of SEED's transfer contract (SEED `docs/transfer-recipe.md`, recipe `seed.transfer-recipe/0.2`, request `seed.transfer-request/0.2`). Code: `src/core/transferRequest.ts`, entry point `node dist/cli/headless.js transfer`. Tests: `tests/transferRequest.test.ts`.

## What it does

SEED writes one request on stdin. FEED maps a heating table onto the axial slices of one pin, sets the **linear heat rate of one chosen slice** in the target case, and replies with the complete new case text. One transfer makes one case; to run several slices, make several recipes (one `applyTo` each). Steady only.

SEED has already checked: the approval and its digest, units against the quantity's dimension, a declared normalization, current source and target revisions, the source run, cycles, and that `describe.transfers` accepts the source. FEED does not re-check those. FEED owns: coverage, conservation, overlap, uncertainty, the table's own units and columns, and the target case.

## The command

- `node dist/cli/headless.js transfer`, request JSON on stdin, one reply as the last stdout line, **exit 0 for every answer**.
- Success: `{ok: true, output: {content}, checks}`. `content` is the whole new case (indented JSON, final newline). `checks` carries the conservation numbers, the applied slice, every slice's power, the bin count, and `warnings` (the validator's own warnings on the new case, for example `W_POWER_RANGE`; recorded, not refused).
- Refusal: `{ok: false, errors: [{code, field, message}]}`, at most 20. Never a partial case.

## `describe.transfers`

```
{ field: "heating-to-pin",
  accepts: [ {energy, per-source-particle}, {power, none}, {power-per-length, none}, {power-per-volume, none} ] }
```

`coolant-boundary` is the second transfer of the same command: see [transfer-boundary.md](transfer-boundary.md).

## `mapping.spatial` (FEED's vocabulary)

| Key | Meaning |
|---|---|
| `pin` | the label value whose rows are used |
| `frame` | the coordinate frame; must equal the table's `meta.frame`, no transform is applied |
| `slices` | `[{id, z: {min, max}}]` in metres, non-overlapping; all of them take part in the conservation check |
| `applyTo` | the id of the slice whose heat rate goes into the case |
| `pinBinCount` | required for `total-power`: the number of the pin's bins the total was defined over |
| `columns` | optional names `{pin, zMin, zMax, volume, value}`; defaults `pin`, `z_min`, `z_max`, `volume`, and the table's single `value` column |

An unknown key is a refusal (`E_RECIPE_INVALID`), not an ignored one.

## The table (what FEED needs from the source)

`kind: "table"`, `meta.frame` set, and per axial bin one row with: a `label` column naming the pin (a string or a one-item list); two `coordinate` columns for the bin's lower and upper z with a length unit; for a power per volume a `coordinate` column with the bin volume; one `value` column (unit equal to the recipe's `source.unit`); and the `std` column of that value (`of` names it), the Monte Carlo error in the value's unit. Rows of other pins are ignored. Bins of the pin must not overlap and must cover every slice. Column names must be unique and exactly one `std` column may name the value (a duplicate would let column order choose the power or hide the uncertainty); every column needs a name, unit and role.

## Normalization and units

| Source dimension | Recipe `normalization` | Watts per bin |
|---|---|---|
| `energy` (per source particle) | `source-rate` (1/s) | value x joules per unit x rate |
| `energy` | `total-power` (W, kW, MW) | the pin's bins scaled so they sum to the total |
| `power` / `power-per-length` / `power-per-volume` | `none` | value (x bin length, x bin volume) |

`units.to` must be `W`: FEED converts the bins to watts and slices them itself; the case's heat rate is set in W/m. A `total-power` is the **pin's** total, not the whole core's. Any other combination is a refusal (an energy without a normalization is `E_NORMALIZATION_MISSING`, a power with a normalization is `E_UNITS`).

## Refusal codes FEED raises

`E_SCHEMA_INVALID`, `E_RECIPE_INVALID`, `E_UNSUPPORTED` (another field, a time series, a transient target), `E_UNITS`, `E_NORMALIZATION_MISSING`, `E_NORMALIZATION_DOMAIN` (a total over a partial export), `E_FRAME_MISMATCH`, `E_UNCERTAINTY_MISSING`, `E_COVERAGE_INCOMPLETE` (no rows for the pin, no power), `E_COVERAGE` (a slice not fully covered), `E_CONSERVATION`, `E_NUMERIC`, and the validator's own codes (a target case that is not valid, with `field` under `/target/content`).

## Applying again replaces (2026-10-25)

The case has one heat rate, so applying heating again **replaces** the earlier heating: `power.linearHeatRate` is overwritten and the earlier entry of kind `heating` in `provenance.transfers` is dropped before the new one is appended (it used to be kept, so a loop that applied heating 25 times left 25 entries). Entries of other transfers (burnup, coolant boundary) are kept. The fuel temperature that comes back out of the run, with the slice's position from this entry, is described in [seed-fuel-temperature.md](seed-fuel-temperature.md).

## What it does not do

- No time series (a pulse from a transferred power history is a later step).
- Uncertainty is carried into the slice's `relError` and recorded in the case's provenance; propagation into temperature is still open (plan 05). **Bins are taken as independent**: the table gives marginal std only and has no way to state correlation, so a source whose bins are correlated understates the slice's uncertainty (two fully correlated bins would combine linearly, not in quadrature). The model is written into `checks.uncertaintyModel` and the case's provenance (`independent-bins`). For a `total-power` the slice is P times a ratio of sums over the same bins, so the uncertainty of the denominator is propagated too (derivative `P (share_b S - A) / S^2`); a whole-pin slice with an exact total has none from the tally. Squares are summed scaled by the largest term, and a relative error that is not finite is `E_NUMERIC`.
- The case's other inputs are untouched: a transferred heat rate with a film coefficient fitted to a different power is the recipe author's responsibility, recorded only in the provenance.
