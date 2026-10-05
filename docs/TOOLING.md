# Tooling and ecosystem survey

What this app will use, may use, and must check. Written 2026-10-03. **Nothing in sections 2 and 3 has been verified in this session: no solver is installed and no external page was read. Treat it as a list of questions, not facts.**

## 1. Our own context

| Item | Role |
|---|---|
| SEED (`bluetyde/seed`) | Workspace host and the harness this app's adapter plugs into |
| OpenMC Studio | Heat-source provider (heating tallies); ribbon look to follow |
| NODAL Studio (`pipe-studio` folder) | Coolant conditions provider; stack and renderer decision to compare |
| Virtual Reactor (RAFT) | Pattern for `schema/` and validation plans |

## 2. External tools, with the question to answer in F0

| Tool | Listed source | Question |
|---|---|---|
| OFFBEAT (fuel-performance solver) | https://foam-for-nuclear.gitlab.io/offbeat/ , https://gitlab.com/foam-for-nuclear/offbeat (listed 2026-09-30) | Release or commit, license, compatible OpenFOAM, models available, how a one-dimensional pin is expressed |
| OpenFOAM | Chosen with OFFBEAT's compatibility statement | Distribution (Foundation or ESI), version, license, install footprint, Windows route (WSL) |
| WSL2 distro or container for the solver | Ours | Isolation from other agents' environments; disk and build cost |
| JSON Schema validator | Chosen with the stack | Draft, error codes, size |
| Plot library | Chosen with the stack | Offline, license, accessibility |
| Property datasets for fuel and cladding | To survey | Terms, ranges, units, redistribution |

## 3. Candidates to survey (unchecked)

- Other fuel-performance codes and teaching tools (prior art for the "why" table).
- Published fuel-performance benchmark and code-comparison exercises (for validation in later phases).
- Mesh and post-processing tools needed to read the solver's fields headlessly.
- Containerization options for a reproducible solver environment.

## 4. How to refresh this survey

For each item: record the date; read the license file, latest release and activity (with `gh` or the project's host if available); read the part of the documentation that answers the question; write a two-line verdict (use, learn from, ignore) with the evidence. Do not copy a claim into PLAN.md until it has a date and a source here. Pin versions in the F0 decision record.

## 5. Decisions already made

Use an existing solver rather than writing one; thermal-only first; keep the typed case authoritative and generate solver files from it; no solver or data bundled until licenses are recorded; the solver lives in its own isolated environment.
