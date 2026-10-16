# Plan 15: A two-dimensional (radius and height) independent solution for the stack

Status: planned 2026-10-16, on the user's word ("plan the 2D solution"), after the question whether the 3D view's label ("no heat flows between the slices") should change or become a setting. **Nothing here is built.** Follows [plan 12](12-axial-stack-and-plate.md) (A0 to A9 done): the stack's checks compare OFFBEAT, which solves the whole stack in two dimensions, with FEED's one-dimensional solutions of each slice, and widen the tolerance for the heat flow along the height that those solutions leave out.

## What it adds, and what it does not

Today, for a stack of pins or plates:
- **OFFBEAT** solves one (r, z) problem with N layers per solid, the end faces insulated. Its cells include the heat that flows along the height (A0 measured it; A5 calibrated it).
- **FEED's references** are N separate one-dimensional solutions (closed forms for the quick look and the steady checks, a finite-volume solution for a transient). They cannot see that heat. The checks therefore carry an **allowance**: 3 times a fin-model estimate of the effect (steady), and, for a transient, a first-order bound on the heat the slices exchange (A5), counted only where the exchange number (rate times run time) is at most 1.

The measured size of what the allowance covers (plan 12 records): a pin of 0.381 m, cosine shape: end layer +1.06 K, peak layer -0.35 K; a plate of 0.381 m: +0.61 K and -0.20 K; both go as 1/L^2; a plate of 0.06 m: an end slice 22.4 K away from its one-dimensional reference (allowance 48 K, mesh bound 0.35 K); a loss of cooling on a cosine plate stack: 5.6 K measured against 2.6 K from the steady estimate, 14.3 K from the exchange bound; a 0.2 m plate of 20 slices over 100 s (exchange number 1.5) fails every check because the one-dimensional references stop being valid there.

This plan adds a **two-dimensional finite-volume solution of the stack on the writer's own mesh** (the same N layers and radial cells, the end faces insulated, the gap a conductance, a coolant per layer), written without reference to OFFBEAT, steady and transient, for pins and plates (one kernel serves both: `src/core/geometry.ts`). It becomes the reference of the stack's checks, so the checks compare like with like and the allowance goes away. It also lets the editor show what the 3D view cannot show today: the case's own two-dimensional temperature field, with the heat flow along the height in it.

It does **not** add: azimuthal variation (a pin stays axisymmetric, a plate stays a slab through its thickness per unit width); the particle (a sphere, no height); mechanics, burnup or boiling; a different solver (OFFBEAT stays the main solver, this is the second method).

## What the user asked, and the answer to "a setting"

The 3D view's caption said "no heat flows between the slices". That is true of the case view (each slice is its own closed form) and not of a run (OFFBEAT includes it). A switch in the picture would not change the physics. **The meaningful setting is in the case view: *Heat flow along the height: not included (closed form per slice, instant) | included (two-dimensional reference solution)*.** The run's results are always OFFBEAT's, which includes it. Until this plan is built, the 3D captions say which of the two they show (a separate small change, not this plan).

## Decisions (to confirm or change)

1. **Replace or add.** The one-dimensional closed forms stay for the quick look, the per-slice table and the editor's instant numbers. The **checks** switch to the two-dimensional reference. The old allowance is kept in the code only as an information line ("the effect of the heat flow along the height, estimated at x %") and as the fallback when the two-dimensional solution cannot be run (deadline, too many cells). Recommendation: yes.
2. **No widening.** A reference with the same mesh and the same physics should agree with OFFBEAT to the mesh bound (the pin's and the plate's existing bounds). If it does not (B0), the plan stops and reports before any check is changed; a widened tolerance is not carried over.
3. **Pin and plate both**, through the geometry kernel. The particle is out (no height).
4. **The case view's option** (above) and the 3D captions: yes, in B5.
5. **Oracles.** The A8 entries' tolerances (mesh bound + 3 times the estimate) could shrink to the mesh bound. That changes entries SEED may already hold: **no entry is changed without the user's word**; the plan only measures how much tighter they could be (B6) and writes it down.

## What is already there

The mesh and the case of a stack (`caseWriter.ts`, `axial.ts`: `sliceLoads` gives each layer its heat rate (OFFBEAT samples the shape at the layer centre, so a layer's power is uniform in z) and coolant), the radial finite-volume kernel (`transientFv.ts`: cells, conductances through `geometry.ts`, implicit Euler or Crank-Nicolson, Picard for temperature-dependent conductivity and heat capacity, enthalpy form so that stored energy is conserved exactly), the saved real outputs of stacks (`tests/golden/offbeat-stack*`, `offbeat-plate-stack*`: cells and fields, including the short-plate and loss-of-cooling cases above) and the stack checks (`stackResults.ts`, `stackTransientResults.ts`).

## The solution

A new module `src/core/axialFv.ts`:
- **Cells.** (radial cell i, layer k): the radial cells of `transientFv` for each of the N layers, the same node positions (the cell's volume centroid, where OFFBEAT reports it). Radial conduction as now. **Axial conduction** between layer k and k+1 in the same solid: the conductance k A / h through the cell's cross-section (annulus or strip) over the distance between the nodes (h, the layer height), each side with its own conductivity (two half cells in series, as the sphere solution does at an interface). The end layers' outer faces are insulated.
- **Gap and coolant.** The gap conductance between the last fuel cell and the first cladding cell of each layer; each layer's boundary (film and bulk, or a wall) from its own coolant, as the stack's slices have today.
- **Time.** Steady (one implicit step of effectively infinite length, checked as a fixed point, as `steadyFv`), and transient (implicit Euler or Crank-Nicolson with the same step as the run, the boundary history as the pin's). The steady start of a transient stack is the **coupled** steady state, not each slice's own (this removes the "starts at its own one-dimensional steady state" limitation of A3).
- **Linear solve.** A banded direct solve (bandwidth = the cells of one layer, unknowns up to about 26 x 50 = 1300 for the largest stack), Picard iteration for properties that depend on temperature. The cost is bounded and checked in B4.

## Verification (written before the code)

- **Reduction.** A stack of identical layers with a flat shape and a uniform coolant equals N copies of the one-dimensional solution (to 1e-10): the axial term vanishes.
- **Conservation.** Heat made equals heat out through the coolant plus stored, to 1e-9, steady and transient, whatever the shape.
- **An exact solution.** A single material slab (a plate), a fixed wall, insulated ends, and a source that is an eigenfunction in z, q0 cos(pi z / H): T(x, z) = T_wall + (q0 / (k lambda^2)) cos(pi z / H) (1 - cosh(lambda x) / cosh(lambda L)), with lambda = pi / H, exact. The solution's error falls at second order in the cell sizes. The same with time (a separable series) for the transient. The axial conduction of the exact solution is the whole effect, so a one-dimensional reference misses it by a known amount: a test shows the one-dimensional solution is off by that amount and the two-dimensional one is not.
- **Against OFFBEAT, cell by cell,** on the saved real runs (steady pin and plate stacks at three lengths, the short plate, the steep-end table, the loss of cooling, the exchange-limit case): the difference must be within the mesh bound of the existing checks, **before** any check is changed (B0). The A0 and A5 numbers are the targets: the end-layer effect of +1.06 K (pin) and +0.61 K (plate) reproduced to within the mesh bound.
- **Negative tests.** The axial term removed, a shape shifted by one layer, the coolant read from the top: each must fail a check against the saved OFFBEAT output.
- **The old limits.** The 0.2 m, 20-slice, 100 s plate that fails today (exchange number 1.5) must pass every check with the new reference, or the reason it does not is stated.

Tolerances are fixed in the tests before the first run, as in plans 09 to 13.

## Milestones

| | Work | Gate |
|---|---|---|
| **B0 Probe** | A throw-away script of the two-dimensional solution (steady and transient) run against the saved OFFBEAT outputs, cell by cell; the axial discretisation OFFBEAT uses (face conductivities, the gap and the layer interfaces, the power sampling) read from its source and from the saved fields; findings in `docs/spike/`. | The difference to OFFBEAT is within the mesh bound on every saved stack run, or the plan stops and goes to the user. |
| **B1 Steady solver** | `axialFv.ts` steady, pin and plate, the reduction, conservation and exact-solution tests. | The verification list for the steady solver passes. |
| **B2 Steady checks** | `stackResults.ts` takes the two-dimensional field as its reference (cells against it, wall, energy balance per layer and whole), the allowance becomes an information line; the case's quick look and table unchanged. | Every saved steady stack run passes with no widening; the negative tests fail. |
| **B3 Transient solver and checks** | The transient solution, the coupled steady start, the transient stack checks without the exchange bound or the exchange-number limit. | The loss-of-cooling and exchange-limit runs pass; the pin coastdown's bound falls back from 10.7 K toward the 3.0 K measured. |
| **B4 Cost and workers** | The run in the worker thread with a deadline (as the pin's independent runs are), the work budget for a stack (cells x steps x layers) rethought, the fallback to the old allowance when the two-dimensional run cannot finish. | A 50-slice transient finishes within the deadline or falls back with a stated reason. |
| **B5 Editor and 3D view** | The case view's option *Heat flow along the height: not included / included*, the 3D captions that say which is shown, the results caption that says OFFBEAT includes it, the table that says the same. | The view and the table show the same numbers; the caption cannot be hidden and is true in each state. |
| **B6 Oracles measured** | What the A8 entries' tolerances would be with the two-dimensional reference (a table). **No entry is changed.** | A table in the plan record; the user decides. |
| **B7 Docs and examples** | `docs/axial-stack.md`, `docs/plate.md`: what the two-dimensional reference is and is not; the examples re-run with the new reference. | Every example passes with no widening. |

## Order and cost

B0 first and alone: it decides whether the rest is worth doing. B1 and B2 are about the size of plan 12's A2, B3 of A3, B4 and B5 of A6; with B0, B6 and B7 the whole is six to eight sessions, honestly uncertain; the risk is B0 (OFFBEAT's own axial discretisation may differ in a way that is not a mesh effect: if so the reference is no better than the allowance) and B4 (a transient on 50 layers with temperature-dependent properties is the most expensive thing FEED's independent solutions would do).

## Open items for the owner

- Whether to do it at all: the gain is tighter stack checks, no exchange-number limit, a truthful 2D field in the editor, and short plates and steep shapes that are refused or loose today. For TRIGA-length stacks the existing allowance is adequate and the gain is small.
- Whether the A8 entries (and what the SEED agent holds) are ever to be tightened (B6 only measures).
