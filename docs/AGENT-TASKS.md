# Agent task board

Delegation workflow: **one agent plans and verifies; other agents implement delegated tasks in an isolated sandbox; an independent model reviews non-trivial diffs read-only.** Nothing merges until the planning agent has re-run the checks and a maintainer agrees.

Decide whether to delegate before dispatching, and decide again each time. The clear wins are large, mechanical tasks with a fixed contract and a strong oracle. Judgment, safety and physics-normalization tasks stay with the planning agent.

Note: the agent sandbox has no OpenFOAM and no network by default; delegated tasks here must be solver-free (schemas, writers tested by golden files, closed-form oracles).

Status: `ready` | `blocked` | `pending` | `done`. Triage written 2026-10-03; recheck before any dispatch.

## agy candidates

| # | Task | Status | Oracle | Notes |
|---|---|---|---|---|
| A1 | Case JSON Schema, validator and fixtures (one failing bad fixture per error code) | blocked | Every code has a failing bad fixture; targeted schema breaks are caught | Needs plan 02 decisions (axial layout, gap model) written; brief states units, the "bulk temperature alone is incomplete" rule and the no-expression rule |
| A2 | Closed-form oracle module (fuel, gap, cladding, film; conductivity integral solver) with a table test and a randomized composite test | **done 2026-10-05 by Claude directly** (small; not delegated) | Hand values in plan 04 reproduce exactly; a mutated formula fails | Solver-free and independent; strong oracle |
| A3 | Case writer (typed case to solver files) with golden files | **done 2026-10-05 by Claude directly** (small once the F0 file structure was known) | Golden files; changed option changes only the expected files | Needs the F0 file structure |
| A4 | Results parser for the solver's output fields | blocked | Saved real outputs from F0 parse to the expected record; broken outputs are refused | Needs F0 outputs |
| A5 | Transfer intake checks (units, normalization, coverage, conservation, stale revision) against scripted fake sources | blocked | Each refusal fires; lossy mapping fails conservation | Needs SEED's recipe format |

## Claude-only

| # | Task | Why |
|---|---|---|
| C1 | F0 backend reproduction and license reading | Environment judgment, heavy install needs the user's approval |
| C2 | Case semantics, required-property rules, boundary completeness | Everything depends on it |
| C3 | Oracle derivations, tolerances, refinement design | A wrong closed form corrupts every check |
| C4 | Transfer recipe semantics and normalization (with SEED) | Precision-critical physics bookkeeping |
| C5 | SEED adapter and harness fit | Cross-project contract |
| C6 | Mechanics and irradiation planning | Scope and validation judgment |
| C7 | Briefs, preflight and verification of every delegated diff | By the skill's rules |

## Codex review points

After F0 (evidence and decision record), after the case schema and writer (F1/F2), after the run manager and parser (F2, process handling), after transfer intake and the SEED adapter (F3, conservation and refusal logic).

## Done

- 2026-10-05, Claude: A2 (oracle module, table, cross-check, mutants) and a first draft of A1 (case schema, validator, 35 vectors). A1 stays provisional until F0 fixes the solver geometry; if re-done at scale, delegate with the existing vectors as the oracle.
