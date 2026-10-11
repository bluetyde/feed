# Whole-repo review before release, 2026-10-11

Three Codex auditors (model `gpt-6-sol`, read-only, files passed as additions against the empty tree) over the parts of the repository where a mistake matters most. Each finding was checked against the code before anything was changed; the verdicts are below. (A first security run failed on an invalid base ref and a stale findings file of 5 October was read by mistake: it was discarded and not used.)

## Security boundary (server, run manager, WSL backend, CLI, scripts): 5 findings

| Finding | Verdict |
|---|---|
| A case file's `label` goes into the page's HTML unescaped (case file executes script in the editor's origin) | **Confirmed, fixed.** `esc()` for the label, a stress limit's region, a refusal's text and a library revision; tested (`tests/releaseReview.test.ts`). Other `note()` interpolations are numbers or fixed text. |
| The editor can be framed by another page and its own requests induced by a click | **Confirmed, fixed.** `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on the page. |
| `write-case` deletes any output folder | **Confirmed, fixed.** It refuses a non-empty folder that has no `feed-manifest.json` (one it wrote itself). |
| Run-folder symlinks can redirect writes outside the run storage | **Accepted, not changed.** It needs another writer inside the run folder, which is the same user's own folder on a single-user machine. The remedy (reject links at every write) is a larger change with no attacker in this threat model; noted for anyone who runs FEED as a shared service, which it is not built for. |

The Host and Origin checks, the custom header for state changes and the body limit were already in place (`tests/serverSecurity.test.ts`); the review confirmed nothing missing there.

## Silent failure (results parser, convergence, mechanics results and checks, run manager): 5 findings

| Finding | Verdict |
|---|---|
| A mechanics run with no readable displacement or stress field completes with a failed `mechanicsFields` check | **Confirmed, fixed.** The run is `failed` with `E_OUTPUT_INCOMPLETE`. (Other failed checks, such as a stress limit exceeded or a failed comparison, still complete with the failing verdict visible: that is the design, and SEED refuses to collect a result with any failed check other than a limit.) |
| Convergence is judged on the log's last step, not the step of the final output time | **Confirmed, fixed.** The last logged step must be at the final time (1e-6 relative), else `E_OUTPUT_INCOMPLETE`; the real-solver tests all pass with it (45 of 45). |
| An unreadable gap width with a zero interface pressure gets a passing contact verdict | **Confirmed, fixed.** A gap that is not nearly closed is never passed unread. |
| A mechanics field file cut right after a complete cell list is accepted | **Confirmed, fixed.** The same whole-file check as the thermal fields (footer, balanced braces). |
| A non-finite interface pressure or gap value passes into the record | **Confirmed, fixed.** It reads as unread. |

## Consistency (README and docs): 10 findings

All confirmed and fixed: the README said mechanics was planned and not built; the temperature-limit text said FEED computes no stress and no hydrogen pressure (now scoped to the check, and the generated note says "This check computes no stress"); `docs/oracles.md` said 78 entries, 131 bad vectors, no oracle for stress or contact, and that SEED runs every entry (now 92, 162, the mechanics entries named with their limits, SEED's adapter status); the mechanics guide's opening said there is no pressure and no stress limit; TODO counts of 149 vectors; the docs index said M3 was the last mechanics milestone; the hot-dimensions guide said a coefficient was not in the library; two TODO notes about the legal review disagreed (reconciled with the user's later decision). No broken link or nonexistent command was found.

## Also

- The one place the user's account name appeared in the repository's text (the list of strings `tests/docLinks.test.ts` forbids) is built from two pieces now. **The name is still in 33 older commits** (earlier documents named local folders); removing it needs a history rewrite, which has not been done.
- Tests added: `tests/releaseReview.test.ts` (6), additions to `mechanicsResults`, `mechanicsChecks`; a mutation run of the new guards killed all 6 mutants.
