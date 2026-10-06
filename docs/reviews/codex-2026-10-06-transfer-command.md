# Codex review: the `transfer` command (2026-10-06)

Auditor: specification-gap-auditor (Codex, read-only), on `src/core/transferRequest.ts`, the `transfer` verb in `src/cli/headless.ts` and the stripped `src/core/transfer.ts`. Five findings. Each was checked against the code by reproducing it before changing anything; none was dropped.

| # | Severity | Finding | Verdict | Fix |
|---|---|---|---|---|
| 1 | HIGH | Duplicate column names, or several `std` columns for one value, were resolved by taking the first match: column order chose the heat rate or hid the uncertainty, and conservation could not see it | confirmed | unique names required (`E_SCHEMA_INVALID`); exactly one std column per value; reversed-column table refused too |
| 2 | MEDIUM | `total-power` scaled the uncertainty as if the score total were exact | confirmed | slice uncertainty uses the derivative `P (share_b S - A) / S^2`; checked against a finite difference of the mapping; a whole-pin slice has none |
| 3 | MEDIUM | Bin independence assumed with no source contract | confirmed as an open question, not a bug | cannot be refused (the data contract has no correlation to declare): documented, written into `checks.uncertaintyModel` and the case provenance |
| 4 | MEDIUM | Squared std could underflow to 0 and the relative error was not checked finite | confirmed | scaled sum of squares; a non-finite relative error is `E_NUMERIC` |
| 5 | MEDIUM | A null/malformed column or a non-list `provenance.transfers` threw (CLI exit 1) | confirmed | every column validated; provenance and its transfers list checked (also in the provisional boundary applier) |

Tests: nine new in `tests/transferRequest.test.ts` ("Codex review of the transfer command") and one in `tests/transfer.test.ts`; eight mutations of the fixes (each fix removed in turn) all caught. 112 tests in the two files.

Not raised by the review and left alone: two checks in `transferRequest.ts` duplicate a later one (the non-finite bin check before the source-total check, and the post-mapping validation, which the validated base case and a finite positive heat rate make unreachable); they are kept as defence in depth.
