# Plan 12: An axial stack of slices (1.5D), a 3D view of it, and plate geometry

Status: planned 2026-10-14, A0 (the probe) done 2026-10-14 ([findings](../spike/axial-plate-probe.md)), on the user's word ("yeah 1.5D with a 3D view and plate geometry with 1.5D write up a plan"). Follows [plan 11](11-time-varying-boundary.md) (a boundary that changes with time), which closed the F17 finding of the outside test except for the plate and the axial direction. **Nothing here is built beyond the probe; where the probe changed the plan, the text below says so (marked A0).**

## What it adds, and what it does not

FEED today is **one radial slice**: temperature depends on the radius only, the slice has a height but nothing varies along it, and the user picks the slice (usually the hottest). Three things are added:

1. **An axial stack (1.5D).** The pin is N slices along its height. Each slice is a radial problem with its own heat rate and its own coolant (bulk temperature, film coefficient, or wall temperature), taken from an axial profile the case states. The solver's slices **do** exchange a little heat through the layer faces (A0: the stack is a true (r, z) solve; see "Why little axial conduction"); FEED's independent per-slice solutions do not, so the checks carry a bound for it. The case then answers "where along the pin is it hottest, and how hot" with a number per slice.
2. **A 3D view of the stack.** Each slice's radial profile is spun around the axis, the slices are stacked, coloured by temperature, rotatable, with a cut-away to see the inside. It is a **rendering of a 1.5D result**, labelled as such on screen. It shows no effect that the model cannot produce (an off-centre gap, one-sided cooling, a hot spot).
3. **Plate geometry.** A flat plate (fuel meat between two claddings, cooled on one or both faces) as a one-dimensional slab through its thickness, and the same plate as a stack along its height (1.5D). This is the case the outside test (F17) could not run.

It does **not** add: heat conduction between slices (a true 2D r-z model), azimuthal variation or any real 3D solution, boiling or a critical heat flux, melting, or channel flow (the coolant profile along the pin is an **input**, not computed; NODAL or the user supplies it). The thermal-only statement is unchanged; mechanics and burnup are refused with a stack in the first version (as they are with a transient).

## Why little axial conduction

The heat leaves a pin sideways because the path is short. For a pin of radius a few millimetres and a heated length of tens of centimetres to metres, the axial conduction term is smaller than the radial one by the square of the ratio of the two lengths: about 1e-4 to 1e-5. For the TRIGA fuel (38 cm long, 1.8 cm radius) it is about 2e-3 at the ends of a cosine power shape, still far below the other uncertainties. **A0 measured it** with OFFBEAT's own stack: at L = 0.381 m the fuel centre differs from an isolated slice by +1.06 K at the end layer (0.6 % of its rise) and -0.35 K at the peak (0.03 %), and the effect scales as 1/L^2 (4.2 K and 1.4 K at 0.19 m, 0.27 K and 0.09 K at 0.762 m). The plan **states** the approximation, bounds it in the checks from the geometry (calibrated on these numbers in A1), and a case where it is not small (a short heated length, a sharp power step along the pin) gets a warning from that bound; it is not silently accepted.

## What is already there

- The case already has `power`, `boundary`, `geometry`, `mesh`, `transient`, and, since plan 11, a boundary history. All describe **one slice**.
- OFFBEAT runs an axial stack of layers (A0: one mesh with N layers per solid, a normalised axial power profile whose integral over 0 to 1 must be 1, and an axial boundary table whose positions are in metres from the bottom). Plan 11 already writes the same boundary types with two equal columns.
- The results parser and the independent finite-volume solutions (`steadyFv`, `transientFv`) are one-slice and one-dimensional; they stay as they are and are called once per slice.
- The power transfer from OpenMC (`transferRequest.ts`) already carries a power per region; an axial power profile is the same quantity per height bin. No new contract is needed for the first version (a table typed in, or a transfer of N values).

## Decisions (to confirm or change)

1. **Where the stack lives.** `axial` in the case, optional: `{ length, slices, powerShape, boundary }`. **A1: `power.linearHeatRate` is the AVERAGE over the heated length** (the probe found it is OFFBEAT's keyword, and a total power over the length gives it; the hottest slice's rate is derived), the shape is flat, cosine or a table of height and relative power (normalised by FEED); the boundary profile is a table of height (metres from the bottom) against bulk temperature and film coefficient (or wall temperature), linear between points. Format and refusals: [docs/axial-stack.md](../axial-stack.md). A case without `axial` is unchanged, byte for byte, and means one slice as today.
2. **Slice count.** 3 to 50, stated by the case; the validator bounds it and warns when the shape changes by more than a stated fraction between neighbours (the same idea as the outputs warning of plan 11).
3. **How the slices are run.** **Settled by A0: one OFFBEAT run with N axial layers per solid**, the end faces left `empty` as they are. OFFBEAT then solves the (r, z) problem, so the stack **includes axial conduction** (small, measured: at L = 0.381 m +1.06 K at the end layer, -0.35 K at the peak, going as 1/L^2). The results are N radial profiles, and every one of FEED's one-slice checks runs on every slice with a tolerance that includes that conduction.
4. **Plate geometry.** `geometry.kind: "plate"` with half-thickness of the meat, thickness of the cladding on each side, optional gap, and which faces are cooled (both, or one with the other insulated). The plate is a slab through its thickness. **A0: OFFBEAT runs it** (a Cartesian mesh, `empty` faces in y and z, an adiabatic plane at x = 0, `angularFraction 1`), steady, as a pulse and as a stack, and the steady centre temperature matches the slab closed form to 0.01 K. The fallback (an independent-only plate solver, which would break the rule that the solver is checked against a second method) is **not needed**.
5. **The 3D view.** A hand-built canvas or a small library loaded from a stated source, as the editor does for its other plots; no network at run time, no new build step. It reads the same results the editor already holds. It never extrapolates: only the N slices are drawn, with the interpolation between them (linear in height) said on screen.
6. **Not combined** with mechanics, hot dimensions or burnup in the first version (each is a per-slice feature that would need its own per-slice inputs); a burnup profile along the pin is the natural second step and is out of this plan.
7. **The verdict language.** A result with a stack says on its banner "one radial solution per slice, no heat flow between slices"; the temperature limits judge every slice and say which slice fails.

## Verification (written before the code)

The independent solutions already exist per slice; what is new is the axial profile and the plate, so the new checks are:

- **A stack of N identical slices equals one slice N times** (a flat shape and a flat boundary): every slice is within the existing one-slice tolerances of the closed form.
- **A cosine power shape with a flat coolant**: each slice against the closed-form radial solution of its own heat rate (the existing series), so the whole axial profile is checked against N closed forms; the peak slice is the peak of the shape on the mesh.
- **A coolant that warms along the pin** with a uniform power: the hottest fuel is found at the slice the closed forms say (the film drop is constant, the coolant rises).
- **Energy conservation along the pin**: the heat rejected by the stack equals the heat deposited, slice by slice and in total (steady) and with storage (transient).
- **Plate, steady:** the slab with uniform heat generation and a convective face has the closed form T(x) = T_s + q''' (L^2 - x^2) / (2 k) for the meat (plus the film and cladding drops); a cooled-on-one-face plate with the other face insulated is the same with L replaced by the full thickness. Both are closed forms with no shared code.
- **Plate, transient:** the slab series (cosine eigenfunctions of tan(lambda) = Bi / lambda stated for the Biot number of the case), as plan 08 did for the cylinder; and the lumped limit for a thin high-conductivity plate with a changing boundary (plan 11's lumped solutions), which also reproduces the F17 question (how fast a plate heats with its cooling lost).
- **The size of the neglected axial conduction** measured once (A0) and then bounded by the validator's ratio; a test shows the bound holds on the measured case.
- **Negative tests:** a shape that is shifted by one slice, a boundary profile read in the wrong direction (bottom for top) and a plate with its faces swapped must each fail a check; a check that cannot fail is not a check.

Tolerances for the closed-form comparisons are fixed in the tests before the first run, as in plans 09 and 11.

## Milestones

| | Work | Gate |
|---|---|---|
| **A0 Probe** | Through the real OFFBEAT: (i) a 1.5D case of N axial cells with an axial power profile and an axial boundary table against N separate one-slice runs; the size of the axial coupling; (ii) a plate on a planar mesh (does OFFBEAT's thermal solver, fuel and cladding models and BCs run it, and what must be changed in the writer); (iii) what the results parser has to read (axial index). Findings written to `docs/spike/`. | Every unknown above written down with numbers. Done: see the A0 record below. |
| **A1 Case and validator** | `axial` (shape, boundary profile, slice count), `geometry.kind: "plate"`, their refusals and warnings (the axial-conduction ratio), 15 to 25 vectors, the normalised case. | A case without `axial` is byte-identical; every refusal has a bad vector. |
| **A2 Stack, steady** | Writer and runner for the stack (as A0 decided), the results record with one profile per slice, the per-slice checks, the energy balance along the pin. | The verification list above for the steady stack passes on the real solver. |
| **A3 Stack, transient** | The transient and the boundary history with an axial profile (history per slice or one history scaled by the profile: decided in A1), the per-slice cross-check and time-step check. | The stack of identical slices equals one slice; a loss-of-cooling run on a cosine stack passes every check. |
| **A4 Plate, 1D** | The writer for a plate, the independent slab solutions (steady and transient), the checks. | The plate closed forms pass; the negative tests fail. |
| **A5 Plate stack** | A plate with an axial profile (decision: reuse A2 and A3 with the plate slice). | Same gates as A2 and A3 for a plate. |
| **A6 Editor** | A "Stack" section (slice count, shape, coolant profile table with a plot), a geometry choice (pin or plate), per-slice results (a table and a plot of peak temperature against height), the banner. Driven in the browser pane. | A case without a stack looks and behaves as today. |
| **A7 The 3D view** | The rotatable stack with a cut-away and a colour scale shared with the editor, the on-screen label ("1.5D: one radial solution per slice"), keyboard and screen-reader alternatives (the same data as a table), tested by script and driven in the browser pane. | The view and the table show the same numbers; the label cannot be hidden. |
| **A8 Oracles and SEED** | Entries from the closed forms (peak along the stack, the plate), a request to the SEED agent for the count and any new quantity (a per-slice peak is a new quantity: **expected**); nothing pushed to SEED, as in plans 09 and 11. | The entries pass FEED's own checks and the real solver. |
| **A9 Examples and docs** | A cosine-power TRIGA stack with a warming pool; a plate with its cooling lost (the F17 case, labelled illustrative); documentation of the approximation and its measured size. | Every example passes every check on the real solver. |

Each milestone ends with the whole suite green and the earlier oracles unchanged; a mutation run of the new code and a Codex review of the milestone's diff before the branch is offered for merging (merging to main always on the user's word).

## Honest unknowns

- ~~Whether OFFBEAT can run a plate at all~~, ~~whether its stack is one run~~, ~~how large the axial conduction is~~: **settled in A0** (yes, yes, small and 1/L^2).
- How to bound the axial conduction in the checks for any geometry and conductivities (A1: a formula calibrated on the A0 numbers, checked on more lengths, power shapes and a TRIGA-like pin).
- The results parser must read cells block by block (A0: all fuel cells, then all cladding cells, layers in order inside each); a plate with a boundary history and a plate cooled on both faces were not probed (expected to work).
- Whether per-slice checks (energy, cross-check, time step) multiply the run time enough to matter (a stack runs in about a second; the independent solutions are per slice and cheap).
- A per-slice quantity needs a new SEED adapter quantity (the peak along the stack, perhaps per height); that is SEED's agent's work and the user's call, not FEED's.

## Estimate

Eight to twelve sessions, honestly uncertain: A0 one, A1 one, A2 one or two, A3 one, A4 one or two, A5 one, A6 one, A7 one or two, A8 and A9 one each. The risks are A0 (the plate) and A4 (a second geometry in every check), as plan 11's risk was its bookkeeping.

## A0 record (2026-10-14)

Done: [docs/spike/axial-plate-probe.md](../spike/axial-plate-probe.md), through the real solver, with the throw-away scripts kept beside it. Findings that changed the plan: the stack is **one run with N layers and includes axial conduction** (small, 1/L^2, measured), the power profile must be **normalised to 1** and its heat rate keyword is the **average**, the boundary table's axial positions are **metres** (the power profile's are 0 to 1), the cells are written **block by block**, and **a plate runs** (Cartesian mesh, `angularFraction 1`; steady centre temperature within 0.01 K of the slab closed form, a pulse within 0.005 K of the adiabatic value, a 5-layer plate stack). Not probed: a plate with a boundary history, a plate cooled on both faces, mechanics or burnup on either (out of scope). Gate met; no stop for the user was needed.

## A1 record (2026-10-14)

Done: [docs/axial-stack.md](../axial-stack.md). `axial` in the case and validator (`src/core/axial.ts`: `parseAxial`, `shapeTable`, `normalizedShape`, `sliceLoads`, `sliceCase`, `axialConductionEstimate`, `axialSummary`), `E_AXIAL` and two warnings in the error table, 34 vectors (245 in all; the 211 earlier ones unchanged), the server's check returns the per-slice closed form and the hottest slice, the writer refuses a stack until A2. **Decisions taken:** `power.linearHeatRate` is the average (not the peak); the plate's case format and validator move to A4, where its closed forms and its solver files are built (a plate case parsed now would be shown with the cylinder's closed form by the editor); a stack with a transient, mechanics, hot dimensions or a burnup is refused with a reason (A3 lifts the first). **Tests:** `axialCase` 17 (loads against an independent exact cosine and hand-worked tables, the orientation of an asymmetric shape, the estimate against the A0 real-solver measurements at three lengths and its 1/L^2 scaling, the warnings, the quick look, the writer's refusal), the vectors in `validate`. **Mutation run:** 23 mutants of the new code; 20 died at once, one anchor did not match (its equivalent, a normalisation 1 % off, died), and two survived (a shape read from the top, a curvature that skips the last interior slice): both were hidden by symmetric test shapes, each now has an asymmetric test, and with the coolant-from-the-top mutant re-run all die. **Found:** the first estimate counted the slope of the shape at the adiabatic ends as curvature and over-read the cosine's end layer three-fold, so the estimate uses interior slices only, with the end boundary layer a stated limit for A2 to measure on a steeper shape. Not done: the solver files and the parser (A2), the checks per slice (A2), the plate (A4), the editor panel (A6).
