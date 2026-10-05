# Fuel Performance Studio (FEED, Fuel Engineering and Experimental Design)

Planning folder created 2026-09-30; in-depth plan written 2026-10-03. Started 2026-10-05: a solver-free core (closed-form oracles, case schema and validator) with tests. No solver is installed and no editor or server exists yet.

Start with [PLAN.md](PLAN.md), then [TODO.md](TODO.md). Design documents are in [docs/](docs/README.md): architecture, workflows, tooling, the delegation board and seven area plans. Suite decisions and cross-app contracts live in [the integration draft](../plans/nuclear-suite-integration.md); the agentic harness it plugs into is in [the harness plan](../plans/agentic-harness.md) and the SEED repo (`../experiment-studio`).

Folders: `docs/` design notes and [decision records](docs/decisions/); `src/core/` units, closed forms, case validator, quick look; `schema/` case schema, error codes and good/bad vectors; `oracles/` the closed-form oracle table; `examples/` teaching cases (synthetic or sourced, labelled); `tests/` unit, oracle and cross-check tests.

With the `feed-solver` WSL distro present (see [solver/PINS.md](solver/PINS.md)) the editor's Run button runs OFFBEAT; without it the button gives the closed-form quick look. `FEED_SOLVER=1 npm test` also runs the tests that use the real solver.

Run the tests (Node 24):

```bash
cd fuel-performance-studio && npm install && npm test
```

Regenerate the bad vectors after changing the example pin: `node scripts/make-vectors.cjs`.

A thermal-only result never implies stress, failure or fuel integrity.

Development coordination: [project log](../messages/fuel-performance-studio.md) and [workspace rules](../messages/INSTRUCTIONS.md). Do not interpret an unchecked task or proposed contract as implemented support.

## Licence and third-party software

FEED's own code is MIT licensed (see [LICENSE](LICENSE)). It does not contain, bundle or redistribute OpenFOAM or OFFBEAT (both GPL): the solver is installed separately (SEED's installer, or the scripts in `solver/`) and FEED runs it as a separate program. FEED writes input files in OFFBEAT's format, using OFFBEAT's keyword names, and its tests compare against output files the solver produced. The mesh vertex correction in `src/core/caseWriter.ts` is derived in that file's comment and checked against OFFBEAT's `rodMaker.py` output; no OFFBEAT source is copied. The sourced property values cite the reactor safety analysis reports they come from (see `library/` and `examples/`).
