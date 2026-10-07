# Plan 02: Case and materials

The thermal case document, the required-property rules and how materials arrive from the project. Milestone F1. Suite-level material rules are in the workspace `plans/nuclear-suite-integration.md`; this plan turns them into FEED behaviour.

## Thermal-only case (V1)

Steady-state, one pin cross-section (one axial slice), uniform radial heat source in the fuel, three regions plus coolant boundary:

| Region | Needs |
|---|---|
| Fuel | Radius; thermal conductivity model; heat source (from the case's power) |
| Gap | Thickness (or cladding inner radius); gap model: constant gap conductance (W/m²/K) in V1, the solver's gas-gap model later |
| Cladding | Inner and outer radius; thermal conductivity model |
| Coolant boundary | Either bulk temperature plus heat-transfer coefficient, or prescribed outer-surface temperature |

A thermal-only case with a closed gap or with fuel-cladding contact needs mechanics to know the contact state; V1 therefore requires an explicit gap conductance or a gap thickness with a stated model and refuses a case that would need computed contact.

## Power forms

Linear heat rate q′ (W/m) is primary. Volumetric q‴ = q′ / (π R_fuel²) is derived and shown. Total W needs a stated active length. The case stores the primary form and the derivation; a power from another app arrives only through a transfer recipe ([plan 05](05-suite-transfers.md)) and records its recipe ID. Per-source-particle scores are never accepted as power.

## Required properties per model

| Model | Needs | Refusal if missing |
|---|---|---|
| Constant conductivity | k (W/m/K), source, reference temperature | `E_PROP_MISSING` naming k |
| Conductivity as a function of temperature | Correlation identifier or table, units, applicable temperature range, interpolation | `E_PROP_MISSING`, or `E_OUT_OF_RANGE` when the solution leaves the range |
| Constant gap conductance | h_gap (W/m²/K), source | `E_PROP_MISSING` |
| Convective boundary | h (W/m²/K), T_bulk (K) | `E_BOUNDARY_INCOMPLETE` (bulk temperature alone is incomplete) |
| Prescribed surface temperature | T_surface (K) | `E_BOUNDARY_INCOMPLETE` |

Composition and density alone do not satisfy any thermal model. The refusal names the missing property and which model needs it.

## Material handling

- Materials are project data with stable IDs and immutable revisions; property sets are namespaced per consumer. FEED reads the `thermal.*` sets and preserves every other set (for example OpenMC composition) unchanged on save.
- The thermal-property source is chosen explicitly. No fallback to a default correlation. No overwrite of reference density with a density-at-temperature function; thermal density is a separate set with its own conditions.
- Each set records units, source, reference conditions, applicable ranges and interpolation. A property used outside its range gives an out-of-domain result.
- A material revision change invalidates dependent results. Equal names are never merged; matching is by ID.
- The cross-app acceptance case: an OpenMC-only custom material opens in FEED with its fields intact; a thermal run names the missing properties; adding a sourced thermal set creates a new revision without changing composition; reopening in OpenMC keeps both sets; old results stay tied to the old revision.

## Validation (before any run)

Stable error codes, each with a bad fixture: unit missing or wrong, negative radius, gap or cladding radii out of order, power out of a stated sanity range (warning, not silent clamp), boundary incomplete or doubly specified, required property missing, property outside range, unknown option, mesh counts below the minimum, material revision stale.

## Examples

Documented pins are labelled `synthetic` or `sourced`. A sourced example carries citation, conditions and redistribution terms. The first example is the synthetic pin in [plan 04](04-verification.md).

## Tests

- Good and bad fixtures for every code above.
- Material round trip and unknown-set preservation.
- A layout- or label-only edit leaves the case hash unchanged; a numeric edit changes it and marks results stale.
- Units: mixed or missing units refuse; linear vs volumetric power conversion round trips.

## Open

- Which conductivity correlations and gap models the first release exposes: F0's survey is done ([property-model-survey.md](../spike/property-model-survey.md)): the gap model stays the constant effective conductance (the only one without mechanics); the conductivity carriers are constant, linear (today), quadratic, cubic (`ZyRELAP`, par3 = -a2), a/T + b; a tabulated law would be a fitted polynomial with its deviation stated. Done 2026-10-06: constant, linear, cubic and fitted table are exposed ([conductivity-models.md](../conductivity-models.md)); the heat-capacity polynomials were done afterwards, and a/T + b on 2026-10-07 (the reciprocal model).
- Whether radial power shape beyond `uniform` (for example a depression near the pellet edge) is a later option.
- Representation of an axial layout (several slices) for the transfer in plan 05.
