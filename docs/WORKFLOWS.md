# Workflows

Step-by-step procedures. Everything is **planned**; no code exists. Follow a section when its feature lands.

## 0. Setup (canonical, after F0)

1. Create the solver environment by the recorded script in its own WSL distro or container. Never install into another agent's environment or into `openmc-mcnp`.
2. Install the app's dependencies (Node and/or Python as chosen).
3. Run the oracle set, the golden-file tests and the unit tests; all must pass before any change.
4. Work in your own clone (the workspace folder is not a git repo yet; when it is, agents use separate clones).

## 1. Reproduce the backend (F0)

1. Claim the work in the project log (`CLAIM: feed-backend`); state the environment you will create and its disk cost. The install itself needs the maintainer's approval.
2. Record versions, sources and licenses.
3. Build the environment by a script; record every step and failure.
4. Reproduce one upstream example; save inputs and outputs; compare to the expected result within a recorded tolerance.
5. Probe failure behaviour: bad mesh, missing property, non-convergence.
6. Write the one-page note and decision record (versions, route, license, geometry representation, case-writer implications).

## 2. Change the case schema

1. Post the proposed change in the log before editing (SEED and the oracles depend on it).
2. Edit the schema and version; write the migration.
3. Add a good and a bad fixture for each new rule; every error code needs a bad fixture.
4. Update the case writer golden files and run the oracle set.
5. Update [ARCHITECTURE](ARCHITECTURE.md) and the owning plan.

## 3. Add an oracle

1. Derive the expected value from a closed form or balance, without the solver. Check it a second way (a script and a hand calculation).
2. Fix the tolerance and record it before any run.
3. State what the entry covers and its tag (good, bad-input, known-limit).
4. Run through the app and directly; both must agree.
5. A changed expected value needs a source and a second derivation.

## 4. Add a model option or property set

1. Declare the property requirements, units, ranges, source and interpolation.
2. Add a refusal fixture for a material lacking them.
3. Add a closed-form or published reference case before shipping.
4. Extend SEED oracle coverage in `describe` only when the entries pass.

## 5. Change the SEED adapter or transfer intake

1. Read SEED's current schemas; post a schema change there first.
2. Implement against SEED's fake adapter, then the real app.
3. Re-run the parity set and the transfer refusals.
4. Confirm standalone launch is unchanged.

## 6. Release

Follow [plan 07](plans/07-release.md).

## 7. Multi-agent rules for this project

The maintainers coordinate several coding agents through a shared workspace log kept outside this repository (separate clones, claims, branches, ports). A contributor does not need it. Specific to this project:

- **Log:** the project log in the maintainers' workspace. Agents read it at the start of every session and append at the end.
- **Claims** by area, matching the plans: `CLAIM: feed-backend`, `CLAIM: feed-case`, `CLAIM: feed-editor`, `CLAIM: feed-oracles`, `CLAIM: feed-transfers`, `CLAIM: feed-mechanics`, `CLAIM: feed-release`.
- **Schema changes affect SEED, the oracles and transfers.** Post the change first.
- **The solver stack is heavy and shared state.** One install per environment, announced in the log; never modify another agent's installation; announce long runs and their thread counts; do not start a second heavy run on top of someone else's.
- **Separate clones per agent** once this is a git repo; no worktrees.
- **Keep TODO.md current:** check off finished items with the date and the evidence; add discovered work under the right milestone.
