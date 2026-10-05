# Codex review: run manager, WSL backend, server (2026-10-05)

Reviewer: OpenAI Codex (codex-cli 0.157.1, read-only, effort high) through the `codex-review` skill, two auditors: `silent-failure-hunter` and `security-boundary-verifier`. Scope: the whole of `src/core/runManager.ts`, `wslBackend.ts`, `resultsParser.ts`, `caseWriter.ts`, `src/server/server.ts`, `src/cli/write-case.ts`, `solver/run-feed.sh`, `solver/cancel-feed.sh`, reviewed as a diff from an empty tree to `main` at `a5070f4`. Raw reports were not kept in the repo; the findings are restated here after checking each against the code.

**Result: 12 distinct findings, all confirmed (none dropped; the cancellation finding was raised by both auditors).** All 12 were fixed the same day (see "Fix status" below). Method of confirmation is given for each: R = reproduced by running it, C = confirmed by reading the code.

Severity is mine after checking, most severe first.

| # | Severity | Finding | Where | Confirmed |
|---|---|---|---|---|
| 1 | High | An exception while reading native output (for example an unreadable `log.offbeat`) escapes `execute()`: the run stays `running`, `done()` never settles, and the unhandled promise rejection from `void this.pump()` can end the server process. | `runManager.ts` execute, classify, pump, start | R: run never settled, state `running`, unhandled `EISDIR` |
| 2 | High | The localhost server checks neither `Host` nor `Origin`. It can start solver runs and serve cases and results. A DNS-rebinding page, or a cross-origin form POST (cancel), reaches the handlers. | `server.ts` | R: `Host: evil.test` answered 200; a cross-origin form POST reached the cancel route |
| 3 | High | Cancel does not cover meshing or post-processing. `run.pid` exists only after `blockMesh`; `cancel-feed.sh` then exits 1, the backend ignores that, and the run script goes on to launch OFFBEAT. The 10 s fallback only kills the Windows launcher, not the Linux process group. | `run-feed.sh`, `cancel-feed.sh`, `wslBackend.ts` | C |
| 4 | Medium | The shell `timeout` (exit 124) fires 5 s before the manager's timer. If fields were already written, the run is `completed` and the note calls 124 "a known shutdown crash". | `runManager.ts` classify, `wslBackend.ts` | C: no handling of 124 |
| 5 | Medium | A `T` file truncated after the cell list but before `boundaryField` parses: the wall value becomes `null`, the wall check silently disappears, the run completes. | `resultsParser.ts` | R: wall `null`, checks without `wallTemperature` |
| 6 | Medium | `wsl.exe -- bash ...` runs the command through the distro's default shell, so a project path containing `'`, `$` or a backtick breaks (or is interpreted). `--exec` preserves it literally. | `wslBackend.ts` | R: shell form printed an empty string; `--exec` printed the exact path |
| 7 | Medium | Completion metadata is trusted: a manifest without `choices.endTime` makes the intended end 0, so any `finalTime` completes; an `exit.json` without `offbeatExit` completes with an "undefined" exit. | `runManager.ts` classify | C |
| 8 | Medium | The parser accepts inconsistent geometry: a duplicated cladding centre divides by `log(1)`, giving `Infinity` that serialises as `null`; a cladding centre inside the gap is accepted. | `resultsParser.ts` | R: energy balance `Infinity`, JSON `null` |
| 9 | Medium | Recovery trusts the id inside `run.json`, not the directory name; a copied record can make `prune()` delete a different directory. | `runManager.ts` recover, prune | R: the unreadable `bbbbbbbbbbbb` directory was deleted, the copy `zz-backup` kept |
| 10 | Medium | `cancel-feed.sh` signals a PID from a file that is never removed; after the process exits, PID reuse could aim the signal at an unrelated process of the `feed` user. | `cancel-feed.sh`, `run-feed.sh` | C |
| 11 | Medium | No upper bound on mesh cell counts; a small request can ask for a billion cells. The study cap checks fuel cells only. | `validate.ts`, `caseWriter.ts`, `server.ts` | R: 1e9 cells accepted |
| 12 | Medium | Pruning removes only the Windows run directory. Each run leaves `~/runs/feed-<id>` in the distro. | `runManager.ts` prune, `run-feed.sh` | R: 62 directories, 143 MB so far |

Notes on severity: Codex rated #4, #6 and #10 differently or called #1 and #5 high; I kept #1 high because it can take the server down, and rated #5 medium because the temperature list itself was complete.

## Suggested fixes (not applied)

1. Wrap the whole lifecycle in `execute()` in try/catch, record the error as `E_APP_FAILED`, always call `finish()`, and give `pump()` and `queueMicrotask` a `.catch`.
2. Check `Host` against `127.0.0.1:PORT`, `localhost:PORT`, `[::1]:PORT`; for POST require an absent or matching `Origin` and a custom header the page sends; apply to every route.
3. Run the whole script under one `setsid` group with its pid file written first; a `cancel.flag` file in the native directory (written by the backend) checked before each phase; cancel kills the group; surface a cancel that could not signal.
4. Treat `offbeatExit` 124 as `E_TIMEOUT` before accepting output.
5. Require `boundaryField` and the `cladOuter` value in `T`; refuse otherwise.
6. Use `wsl.exe ... --exec bash ...` for both the run and the cancel; add a test with a path containing a space, an apostrophe and a dollar sign.
7. Validate `choices.endTime` (finite, positive) and the `exit.json` fields before use.
8. Check that fuel centres lie in (0, Rf) and cladding centres in (Rci, Rco), strictly increasing; refuse non-finite derived values.
9. Recover only directories named as run ids and require `record.id === directory name`.
10. Remove the pid file on exit and check `/proc/<pid>/cmdline` contains the run id before signalling.
11. Add a validator maximum for cell counts (error `E_MESH`) and apply the study cap to the cladding too.
12. Delete the distro run directory at the end of `run-feed.sh` once the outputs are copied (keep it only with an explicit debug flag).

## Not covered by this review

Live WSL cancellation was not executed by Codex (I tested it by hand earlier, in the OFFBEAT-running phase only). The front-end page (`src/web/index.html`), the library and the oracle tests were not in scope. The review used `main` at `a5070f4`.

## Fix status (2026-10-05)

Every fix was written test-first: the new tests were run against the old code and failed (11 run-manager and parser tests, 16 server tests, 2 mesh vectors, 5 of 6 real-solver lifecycle tests), then the code was changed. After the fixes: `npm test` 270 pass, `FEED_SOLVER=1 npm test` 289 pass, run twice in a row.

| # | Fix | Tests |
|---|---|---|
| 1 | `execute()` classifies inside try/catch and always calls `finish()`; `finish()` settles waiters even if the disk write fails; `pump()` catches and settles the run; no floating promise. | `runManager.test.ts` #1 (two): unreadable log fails the run, manager keeps working |
| 2 | Every request must have Host `127.0.0.1`, `localhost` or `[::1]` at the listening port; state-changing requests also need header `x-feed-client: 1` and an absent or same-origin `Origin`. The page adds the header to its own POSTs. | `serverSecurity.test.ts` (21): bad hosts, no Host (HTTP/1.0), cross-origin form cancel, `Origin: null`, other port, no header, accepted cases, a refused POST starts nothing |
| 3 | `run-feed.sh` re-executes itself as a session and process-group leader and writes `run.pid` first; the backend writes `native/cancel.flag` before running the cancel script; the script checks the flag before every phase; each phase runs under `timeout`; cancel signals the group, waits, escalates to KILL and confirms. A cancel the script could not confirm is recorded in the run's notes. | `wslLifecycle.test.ts` (real): cancel during mesh generation leaves no process with the run's directory as working directory and removes the directory; flag set before start stops the script before `blockMesh` |
| 4 | Exit 124 is `E_TIMEOUT`; exit 137 and 143 are failures; none is accepted because fields were written. | `runManager.test.ts` #4 (two) |
| 5 | The parser requires `boundaryField` and a `cladOuter` value; a file cut short there is refused. | `resultsParser.test.ts` #5 (two) |
| 6 | `wsl.exe ... --exec bash <script> <args>` for both run and cancel (`runArgs`, `cancelArgs`). | `wslBackend.test.ts` (5, including apostrophe, dollar, backtick and space); `wslLifecycle.test.ts` real `--exec` literal-path check |
| 7 | `exit.json` fields and `choices.endTime` are validated (finite, end time positive) before use. | `runManager.test.ts` #7 (two) |
| 8 | Cell centres must lie strictly inside the fuel or strictly inside the cladding, be distinct, and every derived check value must be finite. | `resultsParser.test.ts` #8 (four) |
| 9 | Recovery reads only directories named as run ids and requires `record.id` to equal the directory name and the record to have the expected shape. | `runManager.test.ts` #9 |
| 10 | `cancel-feed.sh` checks `/proc/<pid>/cmdline` is `run-feed.sh` with this run's id and that the pid leads its process group before signalling; the script removes `run.pid` on exit. | `wslLifecycle.test.ts` (real): a pid file naming an unrelated process is refused and that process survives; pid file gone after a run |
| 11 | `MESH_MAXIMUM` (20000 fuel, 10000 cladding) in the validator (`E_MESH`, two new bad vectors); a study's finest level is capped for both regions (4000 fuel, 2000 cladding). | `validate.test.ts` vectors, `serverStudy.test.ts` |
| 12 | `run-feed.sh` removes its distro run directory on exit (`FEED_KEEP_RUNDIR=1` keeps it); `cancel-feed.sh` removes it after stopping; `solver/clean-stale-runs.sh` clears leftovers. The 62 leftover directories (143 MB) were removed. | `wslLifecycle.test.ts` (real): no distro directory after a completed run, a cancelled run, or a pre-flagged run |

Judgement calls: exit 137 and 143 are failures even with complete output, because the solver was killed from outside. A cancel that finds a pid file naming something else exits 1 and is not treated as a failure to cancel, since the flag still stops the run at the next phase. The mesh maximum (20000 and 10000) is a generous guard against abuse, not a physics limit.

Still not covered: the real cancel was tested during mesh generation and during the OFFBEAT phase, not during post-processing (fast on these meshes). The fixes were then re-reviewed; see below.

## Second review: of the fixes (commit 4fc071f, same two auditors)

Six distinct findings; five confirmed and fixed, one dropped.

| # | Finding | Verdict | What was done |
|---|---|---|---|
| S1 | **High.** GNU `timeout` moves its child into a process group of its own, so signalling the run script's group missed `timeout` and the solver (both auditors). | **Confirmed, a regression I introduced.** Reproduced: after a group TERM, `timeout` and its child survived. My first cancel test cancelled before any solver phase existed, so it could not catch it. | Phases run as `timeout --foreground` (same group). The cancel script also sweeps and kills anything whose working directory is the run's before deleting it. New tests cancel while `blockMesh` and while `offbeat` are actually running (synchronised on the real process) and assert the phase process is in the script's group; with plain `timeout` restored that assertion fails (checked), so the test discriminates. |
| S2 | **High.** `WslBackend.cancel()` wrote the flag synchronously before returning a promise; a write error threw inside the time-limit timer and escaped. | Confirmed (code reading, then a fault-injection test). | `cancel()` is async, a failed flag write is recorded and the cancel script still runs; the manager's timer uses `Promise.resolve().then(...).catch(...)` and notes the failure. Two tests with a backend whose `cancel` throws. |
| S3 | Medium. The parser could reject supported fine meshes because the writer corrects vertex radii for the wedge. | **Dropped: does not reproduce.** At the largest allowed meshes the first corrected cladding centre stays above the inner radius (for example 0.0041800043 against 0.00418; 0.018161018 against 0.018161 in the zero-gap case). The cap on cell counts keeps it that way. | A regression test builds the writer's corrected centres at 20000 and 10000 cells, with and without a gap, and requires the parser to classify them correctly. |
| S4 | Medium. A field cut after the wall value, a `C` file cut short, or a wall list that declares more values than it holds still passed. | Confirmed: all three reproduced. | Both fields must end with the OpenFOAM footer and have balanced braces and parentheses; the wall list length must match its declared count. Four new tests. |
| S5 | Medium. Impossible exit statuses (-1, 0.5, 256) were accepted as a completed run. | Confirmed: reproduced. | Statuses must be whole numbers 0 to 255, or -1 for a phase that did not run; `offbeatExit` -1 after a successful mesh fails with "never ran". Three tests. |
| Sec2 | Medium. Ownership by substring: any group leader whose command line contains `run-feed.sh` and the id passes; PID reuse not covered. | Confirmed by reading the pattern, then by a real test with a Python process carrying both strings. | `run.pid` holds `pid starttime`; the cancel script requires the same start time, an exact argv of six elements with `bash`, `run-feed.sh` and the id each a whole argument, and group leadership. Two real tests (lookalike process, wrong start time). |

Neither auditor found a bypass of the Host, Origin and header guard in the visible diff. They could not see the files outside the diff (route coverage, fractional mesh counts, study levels); the guard is applied before routing and mesh counts are schema integers, both covered by tests.

After these fixes: `npm test` 281 pass; `FEED_SOLVER=1 npm test` 304 pass; the lifecycle file passed three times in a row.

One thing both reviews and my own testing have shown: real-process behaviour (process groups, `wsl.exe` quoting, event-loop blocking in the test harness) was wrong three times in ways unit tests could not see. Any further change to the run or cancel scripts needs the gated tests run before it is trusted.
