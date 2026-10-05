# 0002: Solver pair and how a run is classified

Date: 2026-10-05. Status: **provisional**, written by Claude Code after a partial F0. Evidence: [../spike/F0-note.md](../spike/F0-note.md).

## Decisions

1. **Pair**: OpenFOAM Foundation 9 (apt, jammy) with OFFBEAT master at commit `80e84450a115b0c411e1bfa5d166379f6bf6c084`, in the dedicated WSL distro `feed-solver` (Ubuntu 22.04). Reason: the OFFBEAT installation page names Foundation 9 as supported, it installs from a package, and the build took about 5 minutes. ESI v2506 stays an alternative, not tried.
2. **Reaching it from Windows**: the app starts the solver with `wsl.exe -d feed-solver -u feed -- ...` and an explicit argument list. Run directories live inside the distro (not under `/mnt/c`), and results are copied out. Path conversion by Git Bash must be off when testing by hand.
3. **A run is classified by outputs, not exit code.** `completed` requires the expected final time directory and finite values in the required fields. `failed` carries the native `FOAM FATAL` text when present, or the signal (134, 136, ...). The shutdown segfault (exit 139 after a full run) must not turn a good run into a failure; a nonzero exit with a full output is recorded as "completed, solver exited abnormally" and shown to the user.
4. **Thermal-only** is a configuration of OFFBEAT (mechanics `fromLatestTime`, fission gas `none`), not a different solver. The case writer starts from a known-good template case and changes only modelled options.
5. **Every run starts from fresh inputs in a new directory**, as planned; the example was only ever run from copies.

## Open (blocks F2, not the F1 contracts)

- Whether the shutdown crash is a build problem or an upstream bug, and whether it also happens with ESI v2506.
- Licenses of OpenFOAM Foundation 9 and the obligations if the app ever ships or documents the stack.

## Update 2026-10-05: thermal oracle reproduced

Constant conductivity (`constantMaterial`), a constant gap conductance (`resistiveGap`), uniform power (`constantLhgr`, flat profiles) and convective or fixed-temperature outer boundaries are all expressible; the table is in the F0 note. OFFBEAT matches the closed forms with close to second-order mesh convergence, and the sourced K-State TRIGA hot element within 0.5 K. New rule for the case writer: **a steady thermal run uses an end time far beyond the slowest thermal time constant** (5e7 s was used); a short end time leaves a storage term that looks like a solver error.

## Update 2026-10-05: temperature-dependent conductivity

A linear conductivity k = a + b T is written through OFFBEAT's `steel1515TiTobbe` model with overridden coefficients (par2 = b, par1 = a + 273.15 b), checked against the conductivity-integral oracle in the solver. This is a use of the model beyond its name and relies on the override block in this OFFBEAT commit; a version bump re-runs the k(T) tests. The alternative, a small compiled OFFBEAT conductivity library loaded from the case, was not needed. A result whose cell temperatures leave a law's stated range is `out-of-domain` (check `propertyRange` fails) and the Results view says so.

## Update 2026-10-05: after the Codex review

- Reaching the distro: `wsl.exe -d feed-solver -u feed --exec bash <script> <args>` (decision 2 above said `-- ...`; `--` runs the command line through the default shell and breaks on paths with quotes or dollar signs).
- A run is one process group: `run-feed.sh` becomes a session leader, writes `run.pid` first, and checks `native/cancel.flag` before every phase. Cancel writes the flag, then signals the group after checking the pid still is that run's script.
- Classification also refuses: exit 124 (`E_TIMEOUT`), exit 137 and 143 (killed), an invalid `exit.json`, a manifest without a positive intended end time, a field file without its boundary block, and cell centres that are not strictly inside fuel or cladding.
- The distro run directory is removed when the script ends; `solver/clean-stale-runs.sh` clears leftovers.

## Update 2026-10-05: second review

- Phases run under `timeout --foreground`; plain `timeout` puts its child in a new process group, which a group signal misses. `cancel-feed.sh` also kills anything left with the run directory as its working directory.
- `run.pid` is `pid starttime`. Cancel signals only a process with that start time, the exact argv `bash <path>/run-feed.sh <in> <out> <runId> <timeout>` and its own process group.
- Exit statuses must be whole numbers 0 to 255 or -1. Field files must end with the OpenFOAM footer with balanced braces.
