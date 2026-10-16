# Design notes

Start with [../PLAN.md](../PLAN.md). Then:

- [ARCHITECTURE.md](ARCHITECTURE.md): components, the case model, interfaces, run flow, conventions, layout, dependencies
- [WORKFLOWS.md](WORKFLOWS.md): setup, backend reproduction, case changes, oracles, model options, SEED adapter, release, multi-agent rules
- [TOOLING.md](TOOLING.md): tools and the unchecked survey list
- [AGENT-TASKS.md](AGENT-TASKS.md): delegation board
- [plans/](plans/): 01 backend, 02 case and materials, 03 editor and adapter, 04 verification, 05 suite transfers, 06 mechanics and irradiation, 07 release, 08 transients, 09 mechanics (done on FEED's side, M0 to M6; SEED integrated the entries), 10 burnup, 11 time-varying boundary (done), 12 axial stack, 3D view and plate (A0 to A6 done; A7 to A9 open), 13 TRISO particle (T0 to T2 done), 14 TRISO mechanics (drafted 2026-10-16 for decision D1 of plan 13, not approved)
- [oracles.md](oracles.md): every oracle FEED checks its results against, by kind, with its source and tolerance
- Feature notes: [conductivity-models.md](conductivity-models.md), [hot-dimensions.md](hot-dimensions.md), [burnup.md](burnup.md), [temperature-limits.md](temperature-limits.md), [point-kinetics.md](point-kinetics.md), [accessibility.md](accessibility.md); [boundary-history.md](boundary-history.md) (the coolant side as tables against time in a transient; case input only so far), [triso.md](triso.md) (the coated particle of plan 13: the case, its refusals, what is and is not modelled), [plate.md](plate.md) (the plate of plan 12: a slab through its thickness, case format, closed forms, what the real runs showed), [axial-stack.md](axial-stack.md) (the axial stack of plan 12: case format, warnings, the axial conduction estimate; case input and quick look only so far), [mechanics.md](mechanics.md) (the mechanics case section, what is written and read back), [seed-mechanics-request.md](seed-mechanics-request.md) (the request to SEED for the mechanics oracle entries), [spike/mechanics-data.md](spike/mechanics-data.md) (the mechanical properties and what the sources give); SEED transfers: [heating](transfer-heating.md), [boundary](transfer-boundary.md), [burnup](transfer-burnup.md)

Shared suite contracts live in the workspace draft `plans/nuclear-suite-integration.md`; do not duplicate them here, restate only what this app must implement. Add normative schemas under `schema/` only after the F0 backend reproduction.
