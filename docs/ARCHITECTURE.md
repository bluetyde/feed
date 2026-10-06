# Architecture

How Fuel Performance Studio's parts fit together. Everything is **proposed**; no code exists. Goal and principles: [../PLAN.md](../PLAN.md). Per-area plans: [plans/](plans/).

## The big picture

```
 Browser editor                          SEED (optional client)
  pin view, inputs, problems,             describe / open / validate / run /
  results, compare                        status / cancel / collect
        |                                          |
        +-------------------+----------------------+
                            |
                  Local server (case core)
                   case store, schema validation, property-requirement check,
                   case writer, run manager, results parser, transfer intake
                            |
              isolated run directory per run
                            |
               OFFBEAT on OpenFOAM (pinned pair)
```

1. **The case core owns meaning; the solver owns the numerics.** The core decides what a valid thermal case is and what to refuse. The solver computes temperatures from a valid generated case.
2. **The editor and SEED use the same core.** A refusal enforced for SEED is enforced for the editor.

## Components

| Component | Responsibility | Status |
|---|---|---|
| Case core | Typed case, schema, units, ranges, required-property check | planned (F1) |
| Case writer | Typed case to solver files; golden-file tested | implemented (constant properties), 2026-10-05 |
| Run manager | Isolated run directory, owned process tree, timeout, cancel, native status | implemented, 2026-10-05 |
| Results parser | Radial/axial temperature fields into the results index; incomplete output refused | implemented, 2026-10-05 |
| Editor | Pin schematic, inputs, plots, compare | planned (F2) |
| Transfer intake | Accept mapped power and boundary values from a SEED transfer recipe; refuse without a valid recipe | planned (F3) |
| SEED adapter | Seven verbs over the core | planned (F3) |
| Oracle set | Closed-form and balance entries in SEED's oracle format | planned (F1 draft, F2) |

## The case model

A JSON document with schema ID and version.

- **Header:** case ID, name, schema version, assumptions block (`thermal-only`, `steady-state`, `1D radial` or the stated solver geometry, gap model, conductivity model per region).
- **Geometry:** fuel radius, gap (as thickness or as inner cladding radius), cladding outer radius, active length of the slice or axial layout; all in metres internally, with display units separate.
- **Power:** linear heat rate q′ (W/m) as the primary form; volumetric q‴ (W/m³) derived as q′ / (π R_fuel²) and shown; total W only with a stated length. A radial power shape is `uniform` in the first release.
- **Coolant boundary:** exactly one of (a) bulk temperature (K) with heat-transfer coefficient (W/m²/K), or (b) prescribed outer-surface temperature (K). Pressure, if used, states absolute or gauge.
- **Materials:** one material reference per region (fuel, cladding, gap gas): project material ID and revision, and the selected thermal-property set with its model identifier, units, source, applicable ranges and interpolation.
- **Model options:** gap model (constant gap conductance, or the solver's gas-gap model), conductivity model, mesh controls (cell counts per region).
- **Provenance:** where each non-default value came from (typed by the user, sourced, mapped from another app with a recipe ID).
- Unknown fields are preserved on save.

Rules:
- A property used outside its stated range produces an out-of-domain result, not a silent extrapolation.
- A material without the property set the chosen model needs is refused with the missing property named.
- Reference density is never overwritten by a density-at-temperature function; thermal density is a separate set with its own conditions.
- No expression is stored or evaluated.

## Interfaces

### 1. Case to solver (case writer)

Generates the OpenFOAM/OFFBEAT case directory from the typed case into the run directory, with a recorded mapping from case fields to solver files. Only modelled options are written; anything else is refused. The exact files, solver version and hashes are recorded. See [plan 01](plans/01-backend.md) and [plan 03](plans/03-editor-and-adapter.md).

### 2. Solver to results (results parser)

Parses the written fields into the results index: radial temperature (K) at defined radii and times, peak, surface and interface temperatures, heat flux at the outer surface, mesh used, solver and version. Missing output, a non-zero exit, or a field with non-finite values is not a result.

### 3. Adapter verbs (SEED to core)

Defined by the SEED harness plan; FEED's mapping is in [plan 03](plans/03-editor-and-adapter.md). Errors are typed `{code, field, message, unit?, range?, source}`.

### 4. Transfer intake (SEED to core)

A mapped quantity arrives with its recipe ID, units, normalization, spatial and time mapping, coverage and provenance, and is checked against the case ([plan 05](plans/05-suite-transfers.md)). Without a valid recipe the value is not accepted.

### 5. Oracle entries

SEED's oracle-entry format: inputs, expected quantity or refusal code, tolerance fixed before the run, source of the answer, coverage.

## Run flow

1. Validate the case: units, ranges, geometry, boundary completeness, required properties for the chosen models.
2. Snapshot the case into `runs/<id>/inputs/` with hashes.
3. Write the solver case; record the mapping.
4. Run the pinned solver with an explicit argument list, timeout and owned process tree.
5. Check completion: exit code, expected fields present, finite values, residual or convergence status from the solver. Implemented in `src/core/convergence.ts`: the log's last outer iteration (final step; every step for a transient) must meet OFFBEAT's own criterion, else `E_NOT_CONVERGED`. A steady result also carries the `steadyState` check (`src/core/steadyState.ts`): the bound on what is still changing after OFFBEAT's last step must be at most 0.01 K.
6. Parse to `results.json`; keep the solver's native output untouched in `native/`.
7. Show results with the assumptions and domain status; compute the energy-balance check from the result.

States: queued, running, completed, failed, cancelled, interrupted. A solver that stops without convergence is `failed` with the native status kept; it is never a result.

## Conventions

- **Units inside the app:** SI (m, K, W, W/m, W/m³, W/m²/K, Pa); display units converted in one place. W, W/m and W/m³ are distinct quantities.
- **Temperatures:** kelvin internally; °C only for display.
- **Coordinates:** radial coordinate r in metres from the pin axis; axial coordinate z with its origin stated; time in seconds for transient cases (later).
- **Determinism:** the thermal solve is deterministic for a pinned solver and mesh; a rerun with the same inputs and versions agrees within the solver's stated tolerance.
- **No hidden defaults:** every value used comes from the case, and its provenance is recorded.
- **Line endings:** LF everywhere (see `AGENTS.md`).
- **Security:** no shell strings; run roots enforced; files from other apps or the user are data; no command taken from case or material content.

## Repository layout (planned)

```
fuel-performance-studio/
  README.md  PLAN.md  TODO.md
  docs/            ARCHITECTURE.md, WORKFLOWS.md, TOOLING.md, AGENT-TASKS.md, plans/
  schema/          case.schema.json, vectors/ (good and bad fixtures)
  oracles/         entries in the SEED oracle format, results/
  src/core/        case, validation, case writer, run manager, results parser
  src/server/      local server
  src/web/         editor
  src/adapter/     SEED adapter and transfer intake
  examples/        documented pins (synthetic or sourced, labelled)
  tests/           unit, oracle, golden-file, e2e
```

## How the milestones depend on each other

```
 F0 backend reproduced --> F1 case contract + oracle set --> F2 editor + adapter --> F3 transfers + SEED --> F4 mechanics
 SEED E0 contracts -----------------------------------------------------------------^
 OpenMC result adapter, NODAL boundary export ---------------------------------------^
```

- F0 comes first: the solver's real input structure and geometry options fix what the case model can express.
- F1's oracle set can be written before the solver adapter exists; it is the target the adapter must meet.
- F3 depends on SEED's transfer recipes and on result adapters owned by the OpenMC and NODAL plans.
