# Plan 03: Editor and adapter

The guided thermal editor, the run adapter and the SEED verbs. Milestone F2 (editor, run) and F3 (SEED adapter). Follows the suite look (OpenMC Studio ribbon style) unless F0 shows a reason not to.

## Student workflow

Open a documented one-dimensional pin, inspect fuel, gap and cladding dimensions, select compatible project materials, supply power and coolant boundary conditions, run, inspect radial temperatures, change one input and compare.

## Editor parts

| Part | Behaviour |
|---|---|
| Pin view | To-scale radial schematic; dimensions editable in place with units; regions labelled |
| Inputs | Power (linear primary, derived forms shown), boundary choice (one of two), material selection per region with property status, model options |
| Property status | For each material, whether the chosen model's properties exist, their source and range; missing ones shown with the reason |
| Problems | Live validation, each selectable |
| Run | Explicit action; never implicit on edit |
| Results | Radial temperature plot with the region boundaries marked; peak, interface and surface temperatures; heat flux at the outer surface; energy-balance check; domain status (in range or out of domain); provenance |
| Compare | Two runs: input differences and result differences; closed-form overlay for the cases that have one |
| Save/load | Native JSON; unknown fields preserved; unsaved-work prompt |

Rules:
- A result is tied to the case revision and goes stale on a numeric edit.
- The editor never edits solver files directly. It edits the typed case; the case writer produces the files.
- A thermal-only banner stays on every result: "Thermal calculation only. Not a stress, failure or integrity assessment."
- Accessible: keyboard operation, visible focus, no information by colour alone, 200% zoom, text alternatives for plots (a table of the plotted values).

## Run adapter

- Isolated run directory per run; inputs copied and hashed; solver case written from the typed case with a recorded mapping.
- Solver started with an explicit argument list (never a shell string), a timeout and owned process tree; cancel stops that tree only.
- `completed` requires zero exit, expected fields present and finite, and the solver's convergence reported; otherwise `failed` with raw output kept and nothing indexed.
- The native solver status is shown beside the coordinator state.
- One run at a time per solver install until measured limits exist; runs are small.

## SEED verbs (F3)

| Verb | FEED mapping |
|---|---|
| `describe` | App and solver versions, case format, supported models, parameters (power, h, T_bulk, T_surface, dimensions, property values), output quantities, oracle coverage |
| `open` | Open or focus the editor on a case revision; no calculation |
| `validate` | The validation table in [plan 02](02-case-and-materials.md) as typed errors `{code, field, message, unit?, range?, source}` |
| `run` | Execute a snapshot; return job ID and run location |
| `status` / `cancel` | Lifecycle plus solver status; cancel only that job |
| `collect` | Results index (radial temperature K, flux W/m², energy balance, mesh, versions) with hashes; refuses incomplete output |

Typed sweep parameters are case fields within their stated ranges; each case is a new revision through the case core, never a text edit of solver files. The adapter must not change standalone launch.

## Results index

Quantity `temperature_radial` (K) with radial coordinate (m), plus `temperature_peak`, `temperature_interface_fuel_gap`, `temperature_interface_gap_clad`, `temperature_surface`, `heat_flux_outer` (W/m²), `energy_balance_residual` (dimensionless), `domain_status`, `mesh`, `solver` (name, version, build), `input_hashes`, `status`.

## Tests

- Case writer golden files for each model option; a changed option changes only the expected files.
- Direct solver run vs the app's run on the same snapshot: same temperatures within the recorded tolerance.
- Each failure mode (bad mesh, missing property, non-convergence) maps to a named error and never to `completed`.
- Cancel kills the owned tree; a sibling survives.
- Browser: complete the student workflow; keyboard-only run.
- The thermal-only banner is present on every results view and in every export.

## Open

- Stack and plotting approach (decide with SEED's and NODAL's stacks in view after F0).
- Whether the pin view shows the axial layout once transfers need it.
- Export of a run as a lab-report figure and table.
