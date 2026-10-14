# Plan 12: An axial stack of slices (1.5D), a 3D view of it, and plate geometry

Status: planned 2026-10-14, on the user's word ("yeah 1.5D with a 3D view and plate geometry with 1.5D write up a plan"). Follows [plan 11](11-time-varying-boundary.md) (a boundary that changes with time), which closed the F17 finding of the outside test except for the plate and the axial direction. **Nothing here is built.**

## What it adds, and what it does not

FEED today is **one radial slice**: temperature depends on the radius only, the slice has a height but nothing varies along it, and the user picks the slice (usually the hottest). Three things are added:

1. **An axial stack (1.5D).** The pin is N slices along its height. Each slice is a radial problem with its own heat rate and its own coolant (bulk temperature, film coefficient, or wall temperature), taken from an axial profile the case states. Slices do **not** exchange heat with each other (see "Why no axial conduction"). The case then answers "where along the pin is it hottest, and how hot" with a number per slice.
2. **A 3D view of the stack.** Each slice's radial profile is spun around the axis, the slices are stacked, coloured by temperature, rotatable, with a cut-away to see the inside. It is a **rendering of a 1.5D result**, labelled as such on screen. It shows no effect that the model cannot produce (an off-centre gap, one-sided cooling, a hot spot).
3. **Plate geometry.** A flat plate (fuel meat between two claddings, cooled on one or both faces) as a one-dimensional slab through its thickness, and the same plate as a stack along its height (1.5D). This is the case the outside test (F17) could not run.

It does **not** add: heat conduction between slices (a true 2D r-z model), azimuthal variation or any real 3D solution, boiling or a critical heat flux, melting, or channel flow (the coolant profile along the pin is an **input**, not computed; NODAL or the user supplies it). The thermal-only statement is unchanged; mechanics and burnup are refused with a stack in the first version (as they are with a transient).

## Why no axial conduction

The heat leaves a pin sideways because the path is short. For a pin of radius a few millimetres and a heated length of tens of centimetres to metres, the axial conduction term is smaller than the radial one by the square of the ratio of the two lengths: about 1e-4 to 1e-5. For the TRIGA fuel (38 cm long, 1.8 cm radius) it is about 2e-3 at the ends of a cosine power shape, still far below the other uncertainties. The plan therefore **states** the approximation, **measures** it once (milestone A0) with OFFBEAT's own axial coupling if it has one, and writes the measured size into the documentation. A case where the approximation is not small (a short heated length, a sharp power step along the pin) gets a warning from a bound the validator computes (the ratio above); it is not silently accepted.

## What is already there

- The case already has `power`, `boundary`, `geometry`, `mesh`, `transient`, and, since plan 11, a boundary history. All describe **one slice**.
- OFFBEAT can run an axial stack natively (its 1.5D mode: several axial cells with a column of radial cells, axially coupled only through the gas and the contact) and can read an axial power profile and axial boundary tables (plan 11 already writes the axial profile boundary types with two equal columns). **Whether FEED can use that, or must run N separate one-slice cases, is the first thing A0 finds out.**
- The results parser and the independent finite-volume solutions (`steadyFv`, `transientFv`) are one-slice and one-dimensional; they stay as they are and are called once per slice.
- The power transfer from OpenMC (`transferRequest.ts`) already carries a power per region; an axial power profile is the same quantity per height bin. No new contract is needed for the first version (a table typed in, or a transfer of N values).

## Decisions (to confirm or change)

1. **Where the stack lives.** `axial` in the case, optional: `{ slices: N, length, power: shape, boundary: profile }`. `power.linearHeatRate` is the **peak** and the shape is a normalised profile (cosine, flat, or a table of height and relative power); the boundary profile is a table of height against bulk temperature and film coefficient (or wall temperature), linear between points. A case without `axial` is unchanged, byte for byte, and means one slice as today.
2. **Slice count.** 3 to 50, stated by the case; the validator bounds it and warns when the shape changes by more than a stated fraction between neighbours (the same idea as the outputs warning of plan 11).
3. **How the slices are run.** Decided by A0: one OFFBEAT case with N axial cells if it reproduces N separate runs, otherwise N separate runs of the existing one-slice writer, in sequence (a later option is threads). Either way the results are N radial profiles, and every one of FEED's one-slice checks runs on every slice.
4. **Plate geometry.** `geometry.kind: "plate"` with half-thickness of the meat, thickness of the cladding on each side, optional gap, and which faces are cooled (both, or one with the other insulated). The plate is a slab through its thickness. **Whether OFFBEAT can run it is the other question for A0.** If it cannot, the options are, in order: (a) a planar mesh OFFBEAT's solvers accept with a Cartesian-like boundary setup, (b) FEED's independent finite-volume solution becomes the solver for plates, and the checks compare it with the closed forms only. (b) breaks FEED's rule "the solver is checked against a second method", so it is **the user's decision**, not mine; the plan proceeds with (a) and stops at the end of A0 if (a) fails.
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
| **A0 Probe** | Through the real OFFBEAT: (i) a 1.5D case of N axial cells with an axial power profile and an axial boundary table against N separate one-slice runs; the size of the axial coupling; (ii) a plate on a planar mesh (does OFFBEAT's thermal solver, fuel and cladding models and BCs run it, and what must be changed in the writer); (iii) what the results parser has to read (axial index). Findings written to `docs/spike/`. | Every unknown above written down with numbers. **Stop and ask the user if the plate cannot be run by OFFBEAT** (decision 4). |
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

- **Whether OFFBEAT can run a plate at all** (its models are for fuel rods; its mesh tools are cylindrical). This decides decision 4 and may end the plate part. It is the biggest risk of the plan.
- Whether OFFBEAT's own 1.5D mode is usable as a single run or only as separate slices, and whether its results (one field with an axial index) are read by the existing parser without change.
- How large the neglected axial conduction really is for the TRIGA fuel at a cosine shape (estimated above as small; A0 measures it).
- Whether per-slice checks (energy, cross-check, time step) multiply the run time enough to need threads (a TODO item already: three runs of a job one after another).
- A per-slice quantity needs a new SEED adapter quantity (the peak along the stack, perhaps per height); that is SEED's agent's work and the user's call, not FEED's.

## Estimate

Eight to twelve sessions, honestly uncertain: A0 one, A1 one, A2 one or two, A3 one, A4 one or two, A5 one, A6 one, A7 one or two, A8 and A9 one each. The risks are A0 (the plate) and A4 (a second geometry in every check), as plan 11's risk was its bookkeeping.
