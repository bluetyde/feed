# Fuel Performance Studio (FEED): Plan

FEED = Fuel Engineering and Experimental Design. The folder and log keep the running name `fuel-performance-studio`. Status: plan only, no code, no engine installed. Written 2026-09-30, rewritten in depth 2026-10-03.

Detailed documents:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, the case model, interfaces, run flow, conventions, layout, dependencies
- [docs/WORKFLOWS.md](docs/WORKFLOWS.md): setup, backend reproduction, case changes, oracles, SEED adapter, release, multi-agent rules
- [docs/TOOLING.md](docs/TOOLING.md): OFFBEAT, OpenFOAM and other tools, what is verified and what is not
- [docs/AGENT-TASKS.md](docs/AGENT-TASKS.md): delegation board
- [docs/plans/](docs/plans/): one plan per area: [01 backend](docs/plans/01-backend.md), [02 case and materials](docs/plans/02-case-and-materials.md),
  [03 editor and adapter](docs/plans/03-editor-and-adapter.md), [04 verification](docs/plans/04-verification.md), [05 suite transfers](docs/plans/05-suite-transfers.md),
  [06 mechanics and irradiation](docs/plans/06-mechanics-and-irradiation.md), [07 release](docs/plans/07-release.md)
- Suite context (workspace): `plans/nuclear-suite-integration.md`, `plans/agentic-harness.md`, and the SEED repo's plans (`experiment-studio/`).

## Goal

Help students inspect fuel-pin thermal behaviour with a guided workflow on top of an existing fuel-performance solver. A student opens a documented one-dimensional pin, reads the fuel, gap and cladding dimensions, selects project materials, supplies power and coolant boundary conditions, runs, inspects radial temperatures, changes one input and compares.

It is a teaching tool. A **thermal-only result never implies stress, failure or fuel integrity.** It does not replace a fuel solver. It is one of the suite apps: it works alone and SEED can open it, run it and read its results; it is also the receiving end of the first reviewed inter-app transfer (OpenMC heating, [plan 05](docs/plans/05-suite-transfers.md)).

## Design principles

- **Use an existing solver.** OFFBEAT (OpenFOAM-based) does the calculation; this app builds validated cases, runs them in isolation and explains the results. No replacement solver.
- **A case is structured, not free-form.** The app writes the solver's case files from a typed case document and refuses options it does not model. It is not an OpenFOAM case editor.
- **Required properties depend on the model.** Composition and density are not enough for a thermal run. A missing conductivity, range or boundary datum blocks the affected run with a named reason. No implicit property substitution.
- **Explicit boundaries.** A convective boundary needs a heat-transfer coefficient and a bulk temperature; bulk temperature alone is not a boundary condition. Prescribed surface temperature is a different, stated choice.
- **Say which number it is.** Total W, linear W/m and volumetric W/m3 are distinct quantities, and per-source-particle scores are not watts.
- **Independent oracles.** Closed-form conduction solutions, energy balance and mesh refinement, derived without the solver.
- **Honest scope.** Thermal first; mechanics, irradiation, burnup, gas release and accidents are later capabilities with their own property needs and validation ([plan 06](docs/plans/06-mechanics-and-irradiation.md)).
- **Standalone.** Nothing requires SEED. Materials may travel in a project envelope; unknown sets are preserved unchanged.

## Why it's worth building

Written 2026-10-03 from the repo's plans. **Statements about other tools are unverified until [docs/TOOLING.md](docs/TOOLING.md) section 3 is done; do not repeat them outside the repo before then.**

| Existing kind of tool | Good at | Missing for teaching |
|---|---|---|
| Fuel-performance codes (OFFBEAT, and others to survey) | Real fuel behaviour, including mechanics and irradiation | Expert input workflows; no guided case, no checks a student can read, no suite link |
| General finite-element and CFD packages | Anything, with effort | Not fuel-aware; no units or property-requirement checks |
| Textbook radial conduction formulas | Concepts | No feedback with real property models; no gap or cladding |

The gap: a guided, checked front end where the case is validated before it runs, the answer can be compared with a closed form, and the heat source and coolant boundary can come from the other suite apps under explicit rules.

## Core technique: case, check, run, compare

1. **Case:** a typed document with dimensions, power, coolant boundary, materials with property sets, and the model options.
2. **Check:** validate units, ranges and required properties for the chosen models, before any run.
3. **Run:** generate the solver case in an isolated directory, run the pinned solver, collect radial temperature fields.
4. **Compare:** against the closed form (when the case allows one), the energy balance, a refined mesh and a previous run.

It fails when a case leaves the range of its property data or the model's assumptions; the app labels such results out-of-domain instead of presenting them as valid.

## Architecture

```
 Browser editor (pin schematic, inputs, radial plot, compare)
        |  case JSON, validate, run requests
 Local server (case core, validation, case writer, run manager, results parser)
        |  solver case directory in, fields out; isolated run dir
      OFFBEAT on OpenFOAM (pinned pair, Linux or WSL)

 SEED (optional) --- adapter verbs ---> same core
 OpenMC Studio / NODAL Studio --- reviewed transfer recipes (through SEED) ---> power and boundary inputs
```

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Views

- **Pin:** a to-scale radial schematic of fuel, gap and cladding with dimensions and labels.
- **Inputs:** power (as linear heat rate, with the other forms derived and shown), coolant boundary, material selection, model options, each with units and ranges.
- **Problems:** live validation, each selectable.
- **Results:** radial temperature profile, peak and surface values, energy balance check, run provenance, domain status.
- **Compare:** two runs, with differences in inputs and results; closed-form overlay where valid.
- **Mapping (later):** the source of power and boundary values when they come from another app, with the recipe and its checks.

## Tech choices (tentative)

- Browser app with a local server, following the NODAL and Virtual Reactor pattern. Stack chosen with SEED's and NODAL's in view after F0.
- OFFBEAT and OpenFOAM in WSL or Linux (a heavy install; see [plan 01](docs/plans/01-backend.md)); the app never edits an installed solver.
- JSON Schema for the case with good and bad fixtures (Virtual Reactor's `schema/` pattern).
- Case writer is a function from the typed case to solver files, tested by golden files and by running.

## First test cases

Synthetic and illustrative until F1 fixes and re-derives them. Full table in [plan 04](docs/plans/04-verification.md).

- Uniformly heated solid cylinder, constant conductivity, prescribed surface temperature: ΔT_centre = q' / (4 π k), independent of radius. q' = 20 kW/m, k = 3 W/m/K gives 530.5 K.
- Composite pin (fuel, gap, cladding, coolant film) in series: illustrative total about 735 K above the coolant bulk temperature.

## Milestones

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| F0: reproducible backend | Pin compatible OFFBEAT/OpenFOAM versions; reproduce one upstream example in WSL/Linux; license and source provenance | Exact environment, invocation, case inputs and output fields recorded |
| F1: case contract | Pin dimensions, material property references, heat source and coolant conditions; units and ranges; the oracle set | Good and bad fixtures and documented model assumptions; no implicit property substitution; tolerances fixed before solver-adapter work |
| F2: guided thermal editor | Pin view, case writer, run adapter, temperature plots | Independent constant-property conduction case, energy balance, mesh refinement, engine-parity check |
| F3: suite transfers | Reviewed OpenMC heating and NODAL boundary mappings, saved comparison, SEED adapter | Total mapped power conserved within a declared tolerance; wrong units, stale revisions and incomplete coverage rejected |
| F4: further physics | Mechanics, then selected irradiation histories | Each capability gets its own property requirements, reference data and validation gate |

## Open questions

- Exact OFFBEAT and OpenFOAM version pair, supported first case, and how a one-dimensional pin is represented in the solver (wedge, 2D axisymmetric or other).
- Property dataset and redistribution terms; installation footprint; packaging.
- Which gap-conductance model the thermal-only case uses (constant, or the solver's gas-gap model) and how to teach the difference.
- Whether to offer a closed-form-only "quick look" mode with no solver, clearly labelled as a limited calculation.
- Stack, distribution license and repo name.
