# The independent runs in a worker thread

What this is: every transient result is checked against an **independent finite-volume solution** of the same case (`src/core/transientFv.ts`, validated against exact solutions). The check needs three runs of it (same mesh and step; double mesh, for the spatial error of the independent solution itself; half step, for the time error), and the editor's preview runs one of them on every edit. They used to run in the server's own thread. Now they run in a **worker thread with a deadline**. Code: `src/core/independentRunner.ts` (the runner), `src/core/independentWorker.ts` (the thread's entry), wiring in `src/core/runManager.ts` and `src/server/server.ts`; tests `tests/independentRunner.test.ts`, `tests/independentRunManager.test.ts`.

## Why

Measured (synthetic pulse on bigger meshes, this machine, constant properties):

| Cells x steps | The three runs in one thread |
|---|---|
| 26 x 1000 | 0.06 s |
| 68 x 8000 | 0.5 s |
| 130 x 20000 | 2.2 s |
| 130 x 23000 (the validator's limit, 3e6) | 3.5 s |

That is 3.5 s in which the server answered nothing: no status polling, no cancel, no other request, and more with temperature-dependent properties (a Picard iteration per step). A test measures it: with the largest allowed case a 10 ms timer is never late by more than 300 ms when the work is in a worker, and is late by seconds when it is in the server's thread.

## What it does

- **One worker thread per job**, started on demand, at most **3 at once**; the rest wait in a queue. The thread gets the case (without a generated pulse's integrated curve, which it does not use) and answers once.
- **A deadline per job.** At the deadline the thread is **terminated** (the runner counts threads started and exited, and the tests show none is left). Defaults: **120 s** for a run's checks (`RunManager` option `independentDeadlineMs`; `server.RUN_DEADLINE_MS`) and **20 s** for the editor's preview (`server.PREVIEW_DEADLINE_MS`).
- **Cancel.** Cancelling a run whose solver has finished but whose checks are still running stops the thread and ends the run `cancelled` ("while the result was being checked"). A queued job never starts.
- **A newer preview replaces one still waiting** (the editor shows only the latest); one already running is left to finish or to hit its deadline. A results job is never replaced.
- **The same numbers.** The answer from the worker equals, state for state, the answer computed in the server's thread (tested for the three runs, the preview's run, and a generated pulse); and the run manager's `results.json` equals what `buildTransientResults` gives in this thread.

## What a missed deadline means

- **A run fails** with the new code **`E_VERIFY_INCOMPLETE`** ("The solver finished, but its result could not be verified: the independent solution did not finish within N s and was stopped ... Use a coarser mesh or a longer time step, or raise the deadline; the solver's own output is in the run folder."). No `results.json` is written. The same code covers a worker that fails or cannot start.
  - Why not a result with the checks marked "not available": SEED's FEED adapter accepts a check only as `pass` or `fail` and treats anything else as an incomplete result, and the rule here is the same: evidence that could not be produced is not passed on as if it had been. A check marked `fail` would claim a disagreement that was never measured.
  - The cost is a lost run after a long solve. The budget (cells x steps at most 3e6) keeps the checks to seconds, so the deadline is a safety net for a slow machine, not a normal outcome; and the solver's output stays on disk.
- **A preview is skipped** with the reason in `transient.previewSkipped` ("the preview was skipped: the independent solution did not finish within 20 s and was stopped"); the rest of the check (validation, the adiabatic estimate, the generated pulse) is unaffected. The preview is not evidence.

**An answer that is complete is used, even if it is a little late.** The deadline is a timer in the server's thread. If the machine is so busy that the thread is held up past the deadline while the worker has already finished, the loop may handle the finished answer before the timer, and the answer is used rather than discarded. The deadline is a safety net against runs that do not finish, not a precise limit; tests of it therefore use jobs that take seconds against deadlines of a fraction of a second, and a stub where only the handling of the outcome is being tested.

## When there is no compiled worker

Running from source without `npm run build` there is no `dist/core/independentWorker.js`. The job then runs in the server's thread, **the numbers are the same, no deadline applies**, and the run's notes say so ("in the server's own thread (no compiled worker was found, so no deadline applied)"). `npm start` and `npm test` build first.

## Also changed

`/api/check` no longer sends a generated pulse's integrated curve inside the normalized case (thousands of numbers on every edit); the editor uses the downsampled curve in the preview. The synchronous `check()` and `transientPreview()` remain for callers that want everything in their own thread.

## Not done

- The runner is a thread per job, not a pool of reusable threads: starting one costs a few tens of milliseconds, which the preview and the checks tolerate.
- The three runs of a job are done one after another in one thread; running them on three threads would be faster on a machine with cores to spare.
- The solver itself (OFFBEAT in WSL) already runs in its own process; this is only about FEED's own numerics.

## The two-dimensional reference of a stack of plates (plan 15, B4)

A transient stack of plates has one more job kind, `stackReference` (`IndependentRunner.start(case, { what: "stackReference", deadlineMs })`): the two-dimensional solution of the whole stack (`src/core/stackReference.ts`, `solveStackTransientReference`), in a thread of its own, started by the run manager beside the "full" job. It has its own deadline (`referenceDeadlineMs`, default 60 s). The answer is `{ solved }` or `{ fallback: reason }` (a cap, a refusal by the solver); a deadline or a failed worker is an outcome with `ok: false`. The run manager turns each of them into the same thing, the one-dimensional checks with the allowance and the reason in the record and the notes, and does not fail the run; the "full" job's failure still does. Without the compiled worker the job runs in the server's thread and the solver's own deadline (it checks the clock between steps) applies. Numbers and caps: [axial-stack.md](axial-stack.md), last section.
