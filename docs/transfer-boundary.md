# The `coolant-boundary` transfer

What FEED does when SEED hands it a coolant condition from another run (NODAL) for the outside of the cladding. SEED's side of the contract is `docs/transfer-recipe.md` section 7 in the SEED repository; the heating transfer is in [transfer-heating.md](transfer-heating.md). Code: `src/core/transferBoundary.ts`, tests: `tests/transferBoundary.test.ts`.

SEED has already checked the approval, the pinned hashes, the units against the dimensions, and that the source run completed, and it has **picked the sample** of each time series (the last one, or one at a time, linear between two samples and flagged, never extrapolated). FEED owns the rest: a complete boundary of the chosen form, the values and their units, a role it has no place for, the region against the case, and the new case.

## Two forms, chosen in the recipe (no default)

| `mapping.spatial.boundaryForm` | Primary quantity | Additional quantity | Sets in the case |
|---|---|---|---|
| `bulk-plus-h` | coolant bulk temperature (`dimension` temperature, K or degC) | role `heat-transfer-coefficient` (W/m2/K or kW/m2/K), required | `boundary.bulkTemperature` (K) and `boundary.heatTransferCoefficient` (W/m2/K) |
| `surface-temperature` | temperature of the cladding's outer surface | none | `boundary.surfaceTemperature` (K) |

A bulk temperature alone is not a convective boundary (refused, `E_BOUNDARY_INCOMPLETE`); a surface temperature with a coefficient is two forms (refused). `describe.transfers` offers both as separate `accepts` entries, because SEED matches a recipe on exactly its roles.

## The rest of the recipe

- `target.field` is `coolant-boundary`; `units.to` is `K`; `normalization.kind` is `none`; `mapping.time.kind` is `steady` with SEED's `select`; `extrapolation` is `refused`.
- `mapping.spatial` has exactly two keys, `region {id, z {min, max}}` (metres) and `boundaryForm`. A third key is refused, a `pressure` in particular (`E_UNSUPPORTED`): FEED's thermal model has nowhere to put a coolant pressure, and accepting it would drop it silently. A `pressure` role is therefore not offered either.
- `unitTo` of the coefficient is optional; absent, FEED converts from the source unit; present, it must be `W/m2/K`.
- A role other than `heat-transfer-coefficient` is refused (`E_UNSUPPORTED`).

## What FEED checks that SEED cannot

- **The region against the slice the case was heated for.** A FEED case is one axial slice. If a heating transfer is already recorded in the case's provenance, the boundary's region must contain that slice (to 1e-9 of its length), else `E_COVERAGE_INCOMPLETE`. With no heating recorded the region cannot be compared, and the reply's `checks.regionCheck` says so. Not checked: that the NODAL cell and the fuel pin belong together at all (the human approving the recipe reads both).
- Absolute temperature above 0 K (`E_OUT_OF_RANGE`), a positive finite coefficient, units FEED reads (K, degC; W/m2/K, kW/m2/K), the sample actually selected and flagged (`E_TIME_MAPPING` when none arrived), a valid target case, and a valid new case.

## The new case

The three boundary keys are replaced by the chosen form (the other form's keys are removed; unrelated keys stay) and `provenance.transfers` gets an entry `kind: "coolant-boundary"` with the recipe id and digest, the form, the region, the run, and every sample (role, quantity, source unit, time `x`, value, `interpolated`, data hash). It works on steady and transient cases, including a transient that starts from a steady operating state.

**No uncertainty is carried:** the NODAL series has none, and FEED does not invent one; the entry and the reply say so.

## Evidence

- `tests/transferBoundary.test.ts`: both forms, unit conversions, interpolated flags, region checks, 41 refusals each with its code, the router, the headless command; 30 mutations of the transfer all caught (several only by pinning the transfer's own message, because the case validator behind it refuses the same input with the same code).
- A real NODAL run (the heated-pipe golden model) through SEED's adapter, recipe and approval into this command, with the coolant `t_out` and the wall `h_surf` of the golden vector, and with `tw_surf` as a surface temperature: the boundary equals the golden vector's last values, a time between samples is its linear mean and is flagged, and a time past the end of the run is refused by SEED. That is SEED's `tests/nodal-boundary.test.ts` with FEED's command in place of the fake target (run 2026-10-06; it found that `unitTo` is optional, which the first version of this transfer wrongly demanded).

## Not done

- A time series (a boundary that changes during a transient): steady only, like heating.
- Pressure, and any coolant property other than these two forms.
- A shared geometry convention between NODAL and the fuel case (open item of plan 08).
