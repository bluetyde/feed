# 0001: Provisional stack and first case-contract choices

Date: 2026-10-05. Status: **provisional**, written by Claude Code. The user confirms or changes it ([TODO](../../TODO.md), "Decisions waiting").

## Stack

TypeScript on Node 24, vitest for tests, ajv (JSON Schema 2020-12) for structure. Same as SEED (`../../../experiment-studio`), so the SEED adapter and the shared schemas and oracle format sit in one toolchain. The browser editor and local server (F2) will use the same language; the framework is not chosen yet. The solver (OFFBEAT/OpenFOAM) stays outside Node, run in an isolated Linux or WSL environment (F0, not started).

Alternative considered: Python like Pipe Studio (NODAL). Not chosen because the SEED adapter, schemas and oracle format are TypeScript and would need a second validator. Cost of changing later: the core is about 600 lines plus data files, so low.

## Case contract choices made while writing the first validator

These are in `schema/case.schema.json` and `src/core/validate.ts`; all stay **proposed** until F0 shows what the solver can express.

- Every physical input is `{value, unit}`. A bare number, a missing unit, an unknown unit or a unit of another dimension is `E_UNITS`. SI inside, display units convert in `src/core/units.ts`.
- Geometry is given as three radii (fuel, cladding inner, cladding outer). The plan also allows a gap thickness; not done yet.
- A closed gap (inner cladding radius equal to the fuel radius) is `E_UNSUPPORTED`: contact needs mechanics. Overlap is `E_GEOMETRY`.
- Conductivity lives in `materials.<region>.sets["thermal.conductivity"]`. Models: `constant` (value, reference temperature, source) and `linear` k = a + b T (a, b, valid range, source). Other models are `E_UNSUPPORTED`; a missing set or field is `E_PROP_MISSING` naming it. Other sets (for example `openmc.composition`) and unknown fields are never touched.
- The coolant boundary is exactly one complete form: bulk temperature plus heat-transfer coefficient, or surface temperature. Bulk alone, coefficient alone, both forms, or none is `E_BOUNDARY_INCOMPLETE`.
- Gap model in V1: `constant-conductance` only. `gas-gap` is `E_UNSUPPORTED` (planned).
- Power above 60 kW/m gives `W_POWER_RANGE`, kept as given. This sanity limit is a guess to be replaced by a sourced one.
- A property used outside its range is a **result verdict**, not a blocking error: `quickLook()` returns `out-of-domain` from the closed-form temperatures. The solver run must apply the same check to its own fields (F2).
- Not done: `E_STALE_REVISION` (needs the project and material store, F3), mesh counts beyond a minimum (fuel 4, cladding 2), tolerances for solver runs and the refinement design (F1 item 4).

## What the closed-form table covers

Tolerance 0.001 K on 4-decimal values from an independent Python script. Cross-checked by a finite-volume solve that shares no formula with the closed forms (`tests/helpers/fvRadial.ts`). This verifies the oracle values, not any solver.

## Update 2026-10-05: closed gap with an effective conductance

The K-State TRIGA SAR puts zero cold gap between fuel and cladding and one effective gap conductance (2840 W/m2/K) at the interface. The first validator refused any equal-radius case as needing contact mechanics, which would have refused the SAR's own model. Now equal radii are accepted when the gap model is `constant-conductance`; `closed` and `contact` models are still `E_UNSUPPORTED`. The conductance then stands for the interface as a whole, and the app shows gap thickness 0.
