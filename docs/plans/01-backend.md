# Plan 01: Backend

Choosing, pinning and reproducing the solver. Milestone F0. Nothing in the case model is final until this is done.

OFFBEAT documentation: https://foam-for-nuclear.gitlab.io/offbeat/ ; source: https://gitlab.com/foam-for-nuclear/offbeat (listed 2026-09-30, **not verified in this session**). OFFBEAT is understood to build on OpenFOAM; that, its license and its version compatibility are F0 questions, not facts.

## F0 questions and evidence to record

| Question | Evidence |
|---|---|
| Which OFFBEAT release or commit, and which OpenFOAM version (and distribution: Foundation or ESI) it needs | Version strings, compatibility statement, source |
| License of OFFBEAT, of OpenFOAM, and what redistributing or bundling either requires | License texts; a short note on obligations |
| Install route | Native Linux, WSL2 Ubuntu, or a container; each step and each failure; disk and time cost |
| Windows story | How a Windows user reaches it (WSL), path handling for spaces and `\\wsl$`, file ownership |
| Upstream example | Which one reproduces, its inputs, its expected outputs, and whether it is thermal-only or couples mechanics |
| How a one-dimensional radial pin is represented | Wedge mesh, 2D axisymmetric, or another; what boundary patches exist and how heat source, gap and cladding are specified |
| Run invocation | Exact command, arguments, working directory, environment, how to run headless and quietly |
| Output | Field files written, times, formats, how to read radial temperature, how convergence is reported |
| Failure behaviour | Exit codes and messages for a bad mesh, missing property, non-convergence |
| Determinism | Same case twice gives the same fields (within the solver's tolerance) |
| Property models available | Which conductivity and gap models exist, what data they need and in which units |

Output of F0: the reproduced example, saved inputs and outputs, the exact environment (recorded as a script or a lock description), a one-page note, and a decision record. No design depends on a solver behaviour that is not in the record.

## Environment rules

- The solver lives in its own environment (a dedicated WSL distro or a container). **It is never installed into, or modified in, another agent's environment**, and never into the shared `openmc-mcnp` environment. Agents follow `messages/INSTRUCTIONS.md` (no restarting WSL, no touching others' processes).
- Record disk footprint and build time. An OpenFOAM stack is large; the install is an explicit, user-approved step.
- Record every version of every component; the case writer and the oracles name the versions they were checked on.
- A pinned pair is the only supported pair. Upgrading is a new F0 pass with the oracle set re-run.

## Case writer implications to settle from F0

- Which solver files the typed case maps to, and which parts are fixed templates.
- Which options the app exposes (gap model, conductivity model, mesh controls) and which it refuses.
- Whether the solver handles a case-level restart or reads a prior run; the app starts every run fresh in a new directory.
- How the solver reports its own convergence, so the run manager can classify `completed` vs `failed`.

## Tests

- The reproduced upstream example matches its published or saved expected output within a recorded tolerance.
- A second run of the same case gives the same result.
- A deliberately broken case fails with a classifiable error, not a hang.
- The environment script rebuilds the same pair from scratch on a clean distro (once, recorded).

## Open

- Exact version pair and route (answered by F0).
- Whether a smaller thermal-only solver is accepted for the first lesson if OFFBEAT proves too heavy (would need its own oracle coverage and an explicit decision; not planned).
- Packaging of the solver environment for students ([plan 07](07-release.md)).
