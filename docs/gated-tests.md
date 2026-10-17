# Gated tests (FEED_SOLVER=1): two load-dependent flakes and their causes

The gated tests drive the real solver in the feed-solver distro. Two of them failed only when the machine was busy (the full gated suite, or other solver jobs
running). Neither was a numerical failure. Both were test bugs; the source did not change.

## 1. burnupProbe: `run folder .../mech-<tag> exists; use a new tag`

`solver/probe-mechanics.sh` refuses an existing run folder `~/runs/mech-<tag>`. The tag came from `tests/helpers/mechanicsProbe.ts`
(`runProbe`): the clock in milliseconds plus a counter that starts at 0 in every vitest worker. `tests/burnupProbe.test.ts` and `tests/mechanicsProbe.test.ts`
run in different workers, each with its own counter; when both started a probe in the same millisecond they made the same tag, and the second was refused.
A busy machine makes the workers start together, so the flake showed only under load.

Fix: the tag now also carries the process id and 4 random bytes (`tests/helpers/mechanicsProbe.ts`). `tests/solverEndToEnd.test.ts` made its tag from the clock
alone (`e2e<ms>`); it has one test per file, so it could not collide with itself, but it now carries the process id too. No other gated test builds a run folder
name by hand: the run manager makes a random 12-digit hex id for every run.

## 2. runManagerWsl: "cancels a long run and leaves no solver process of that run behind"

The test counted `ps -eo args | grep -c "[o]ffbeat"`: every offbeat process in the distro, not the ones of this run. Any other solver job (another test file,
another agent) made it find 1 or more. It was not a leftover of the cancel: `solver/cancel-feed.sh` signals the run's process group, waits, then kills anything
whose working directory is the run folder, and exits non-zero if something is still alive.

Reproduction before the fix: two copies of this test run at once (each sees the other's offbeat): 4 of 12 runs failed (`expected 1 to be 0`); alone, 6 of 6 passed.
(A first attempt with `tests/trisoSolver.test.ts` as the second job did not collide: that file runs about 19 s and rarely overlaps the 4 to 6 s window.)

Fix: the test now counts only the processes of its own run: a process whose working directory is `~/runs/feed-<id>` (or below it, or deleted), or a `run-feed.sh`
with that id as an argument. It polls up to 10 s and fails with the list of what is left; the number is still 0. A negative control in the same file starts a
sleeper in a run folder and checks the counter finds it, finds none for another run id, and finds nothing after the sleeper is killed.
