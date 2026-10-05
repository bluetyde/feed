# Plan 05: Suite transfers

How OpenMC heating and NODAL coolant conditions enter a FEED case, and how FEED works with SEED. Milestone F3. First pipelines are **offline, one-way and acyclic**; thermal feedback to neutronics is a later design with convergence and failure criteria. Suite-level rules: workspace `plans/nuclear-suite-integration.md`; the transfer framework is in SEED's `docs/plans/08-transfers-and-pipelines.md`.

This is the receiving end of SEED's first reviewed transfer and first end-to-end agent demonstration, so its checks must be exact.

## Why transfers are gated

Temperature alone does not define convective heat transfer. A neutronics geometry alone does not define a fuel case. A transfer needs an explicit recipe, a human decision (SEED tier A3) and checks that run before the case starts. FEED accepts a mapped value only with a valid recipe ID; without one the value is refused.

## Heat source from OpenMC

OpenMC tallies carry scores such as heating per source particle. Per-source-particle scores are not watts.

| Needed in the recipe | Why |
|---|---|
| Tally score and its units | Heating, fission energy deposition and others differ |
| Normalization | Source rate or total power that turns per-source-particle into W; the value and its source |
| Volume or length basis | Converts W to W/m or W/m³; the volumes used for the bins |
| Spatial mapping | Which tally bins map to which pin and axial slice; coordinates and IDs |
| Uncertainty | Monte Carlo statistical error carried, not dropped |
| Provenance | Run ID, model and material revisions, data library, mapping recipe ID |

Checks (each a refusal with a named code and each tested):
- **Units and normalization:** missing or inconsistent → refuse.
- **Coverage:** the bins must cover the target pin and slices; incomplete coverage refuses, and no extrapolation is performed.
- **Conservation:** total mapped power equals the source total (over the mapped region) within a tolerance set beforehand.
- **Revision:** a stale source or target revision refuses.
- **Kinds:** W, W/m and W/m³ are never interchanged silently.

FEED converts to its primary form (linear heat rate q′ per axial slice) and records the recipe ID in the case provenance. An axial shape means several slices (a case family), one per mapped slice, in the first release; a true multi-slice case is a later design (see plan 02 open item).

## Boundary from NODAL Studio

- NODAL supplies an **identified axial region** and an explicit choice: bulk temperature with a heat-transfer coefficient, or a prescribed surface temperature, as supported.
- Bulk temperature alone is not a complete convective boundary and is refused.
- If pressure is used, the absolute or gauge convention and units are stated.
- Axial and radial coordinates, the mesh association, the time grid, the interpolation method and the coverage are declared in the recipe; extrapolation is refused.
- Steady-state only in the first release; time-dependent boundaries wait for transient cases.

## FEED in SEED

- Adapter verbs in [plan 03](03-editor-and-adapter.md).
- `describe` states oracle coverage ([plan 04](04-verification.md)); values outside it are `unverified`.
- Transfer intake accepts only SEED recipes with approver, time and tolerance; the approval record is stored with the case.
- Changing the upstream source invalidates the case's results; the editor shows the stale link and does not silently refetch.
- An agent may propose a recipe (A2) and run an approved pipeline (A1); it cannot enable a transfer, edit a conservation tolerance or choose a default for a missing quantity.

## Acceptance

1. A scripted fake OpenMC result with a known total power maps to the case; total power in equals total power mapped within the declared tolerance.
2. Wrong units, a missing normalization, incomplete axial coverage, a stale revision and a bulk-temperature-only boundary are each refused with the named code.
3. A deliberately lossy mapping fails the conservation check.
4. Standalone and workspace runs of the same case agree.
5. Material round trip: custom OpenMC-only material, missing-property error, sourced thermal set creating a new revision, reopening in OpenMC with both sets, old results tied to the old revision.
6. Then the same with a real OpenMC result (SEED E4).

## Open

- Axial layout representation for the case (a family of slices or one multi-slice case).
- Mesh and coordinate conventions shared with OpenMC and NODAL (declared per recipe until a common one is justified).
- How Monte Carlo uncertainty on the heat source propagates into the temperature result (report the sensitivity first; propagation later).
- The feedback loop (temperature to cross sections) is not designed here; it needs its own convergence and failure criteria.
