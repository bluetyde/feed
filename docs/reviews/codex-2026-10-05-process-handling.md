# Codex review: run manager, WSL backend, server (2026-10-05)

Reviewer: OpenAI Codex (codex-cli 0.157.1, read-only, effort high) through the `codex-review` skill, two auditors: `silent-failure-hunter` and `security-boundary-verifier`. Scope: the whole of `src/core/runManager.ts`, `wslBackend.ts`, `resultsParser.ts`, `caseWriter.ts`, `src/server/server.ts`, `src/cli/write-case.ts`, `solver/run-feed.sh`, `solver/cancel-feed.sh`, reviewed as a diff from an empty tree to `main` at `a5070f4`. Raw reports were not kept in the repo; the findings are restated here after checking each against the code.

**Result: 12 distinct findings, all confirmed (none dropped; the cancellation finding was raised by both auditors).** Nothing is fixed yet. Method of confirmation is given for each: R = reproduced by running it, C = confirmed by reading the code.

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
