# Fuel Performance Studio (FEED): TODO

Running list. Check items off, add new ones at the bottom of their section, and note the date when something finishes. Close a task with **evidence** (a command and its result, or a recorded decision); a plan edit alone means "documented", not "verified". Contract status: proposed, accepted, documented, implemented, verified.
Design lives in [PLAN.md](PLAN.md). Details per area in [docs/plans/](docs/plans/); structure in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); delegation in [docs/AGENT-TASKS.md](docs/AGENT-TASKS.md). Suite context: `../plans/nuclear-suite-integration.md`, `../plans/agentic-harness.md`, and SEED's plans.

Flags: **[agy]** = delegation candidate for Antigravity (large, mechanical, contract fixed, strong oracle; solver-free, since the sandbox has no OpenFOAM; run antigravity-task step 0 again before dispatching). Unflagged items are Claude's. **[codex]** = a Codex review checkpoint; every milestone ends with one. **[seed]** = also needed by SEED's harness work.

Started 2026-10-05: solver-free core exists (see Now). No solver, editor, server or repo exists yet; unticked items are not implemented. A thermal-only result must never imply stress, failure or fuel integrity.

## Next (planned 2026-10-03)

1. [ ] **F0 backend reproduction** ([plan 01](docs/plans/01-backend.md)): pin a compatible OFFBEAT/OpenFOAM pair, record sources and licenses, build it in an **isolated** environment (user approves the install and its disk cost), reproduce one upstream example, probe failure behaviour. Evidence: `docs/spike/` with the note and decision record.
2. [ ] Write the thermal case contract from the F0 evidence: how a one-dimensional pin is represented, which options are exposed, the assumptions block ([plan 02](docs/plans/02-case-and-materials.md)).
3. [x] 2026-10-05: closed-form oracle module and table test, done by Claude directly (not delegated; it was small). `src/core/closedForm.ts`, `oracles/closed-form-table.json`; each value rechecked by Python and a finite-volume solve; 12 mutants fail the table. Tolerances here are for the closed-form implementation only.
4. [ ] Fix tolerances and the refinement design for every oracle entry before the first solver run ([plan 04](docs/plans/04-verification.md)).
5. [~] 2026-10-05: case schema, validator and 35 vectors written, every error code has a bad vector (`schema/`, `src/core/validate.ts`). Provisional until item 2 and F0 decide the solver geometry; then re-review.
6. [ ] **[codex]** Review of the F0 evidence, decision record, case schema and oracle derivations (F0/F1 exit).
7. [~] 2026-10-05: provisional stack TypeScript/Node, vitest, ajv (SEED's), recorded in [docs/decisions/0001-provisional-stack.md](docs/decisions/0001-provisional-stack.md). The user confirms or changes it.

## Now


- [x] 2026-09-30: Planning skeleton and first plan (Codex).
- [x] 2026-10-03: In-depth plan, ARCHITECTURE, WORKFLOWS, TOOLING, AGENT-TASKS and plans 01 to 07 written (documentation only). Closed-form numbers recomputed by a script (530.5, 155.3, 27.1, 22.3 K; total 735.3 K above the coolant).
- [x] 2026-10-05: started the solver-free core: units, closed forms (constant and linear k), case validator with E_UNITS, E_GEOMETRY, E_OUT_OF_RANGE, E_PROP_MISSING, E_BOUNDARY_INCOMPLETE, E_UNSUPPORTED, E_MESH, W_POWER_RANGE; quick look with out-of-domain verdict; `npm test` runs 75 tests (Claude).
- [ ] Decide the open questions in [PLAN.md](PLAN.md#open-questions) that block F0 and F1.

## Contracts (before F1 code)

All **proposed**; none implemented.

- [ ] Thermal case: regions, power forms, exactly one boundary form, model options, assumptions block ([plan 02](docs/plans/02-case-and-materials.md)).
- [ ] Required-property table and refusal codes (`E_PROP_MISSING`, `E_OUT_OF_RANGE`, `E_BOUNDARY_INCOMPLETE`, `E_UNITS`), each with a bad fixture.
- [ ] Out-of-domain rule: a property used outside its range gives a flagged result, never silent extrapolation.
- [ ] Power forms: q′ primary; q‴ and total W derived and shown; per-source-particle never accepted as power.
- [ ] Reference density never overwritten by a density-at-temperature function; thermal density is a separate set.
- [ ] Run states and "completed means finite fields present and solver converged" ([ARCHITECTURE](docs/ARCHITECTURE.md)).
- [ ] Results index in SEED's shape [seed]; oracle entry format shared with SEED [seed].
- [ ] Unknown fields and other apps' material sets preserved unchanged; no expression evaluated.
- [ ] Thermal-only banner on every results view and export.

## F0: reproducible backend ([plan 01](docs/plans/01-backend.md))

Started 2026-10-05; see [docs/spike/F0-note.md](docs/spike/F0-note.md) and [solver/PINS.md](solver/PINS.md).

- [~] Versions, sources and licenses recorded: versions and sources done; OFFBEAT GPL-3.0 seen; OpenFOAM Foundation license text not read; redistribution note not written.
- [~] Isolated environment built from a script: `feed-solver` distro built by `solver/setup-feed-solver.sh` and `solver/build-offbeat.sh` (about 8 min, 6.5 GB disk). Clean-distro rebuild not repeated.
- [~] One upstream example reproduced: `generic_pwr_1D` runs to the end and is byte-identical on a second run; **no upstream expected output exists to compare**, so correctness is not established. Shutdown segfault (exit 139) found and traced to a global destructor.
- [x] Failure behaviour mapped: five targeted breaks, exit codes 1, 134, 136 with native messages; none hang. Non-convergence not triggered.
- [~] Run invocation, headless operation and output reading documented in the F0 note. Radial temperature reading from the field files not yet scripted.
- [x] 2026-10-05: thermal case matching the closed-form oracle built and compared (`solver/make-oracle-case.py`, saved outputs in `solver/results/`, `tests/offbeatOracle.test.ts`). Second-order refinement; K-State TRIGA hot element reproduces SAR Table 4.8 within 0.5 K. Lesson: run to a true steady state.
- [x] 2026-10-05: case writer from the validated case (`src/core/caseWriter.ts`, `src/cli/write-case.ts`, `solver/run-case.sh`): writes mesh, solverDict, T, D, controlDict, fvSchemes, fvSolution; runs in OFFBEAT and matches the closed form (gated end-to-end test, `FEED_SOLVER=1 npm test`). Constant properties only; temperature-dependent conductivity is refused by the writer until OFFBEAT is checked for it.
- [x] 2026-10-05: results parser (`src/core/resultsParser.ts`) and run manager (`src/core/runManager.ts`, `src/core/wslBackend.ts`, `solver/run-feed.sh`, `solver/cancel-feed.sh`). Isolated run directory per run (`runs/<id>/inputs|native|results.json|run.json`), one run at a time, timeout, cancel of that run's own process group, classification by output (exit 139 after a complete run is accepted and noted), restart marks leftover runs `interrupted`. Parser refuses truncated, non-finite, wrong-count, uniform, outside-pin and non-positive-temperature fields. Server endpoints (`/api/run`, `/api/run/<id>`, `/results`, `/cancel`) and the editor's Run/Cancel button with solver overlay and checks.
- [x] 2026-10-05: Results view (run list, per-run provenance, summary cards, profile with closed-form line, CSV and JSON export, Open case) and Compare view (pick A and B, input differences as a field diff, B minus A for each summary value, check verdicts side by side, point-by-point difference plot only when geometry and mesh match, same-hash repeat runs flagged). `src/core/compare.ts`, `src/core/exportResults.ts`, endpoints `/api/run/<id>/detail`, `/api/run/<id>/results.csv`, `/api/compare`.
- [x] 2026-10-05: mesh-refinement study from the editor (Case > Check > Refinement): the case on meshes x1, x2, x4, error against the closed form per level, observed order, verdict (gate: order at least 1.3 per step; errors under 1e-4 K are treated as the solver's noise floor). `src/core/refinement.ts`, `/api/study`, tests on real saved output and a gated three-run test. Synthetic pin 20/6, 40/12, 80/24: fuel errors 0.457, 0.141, 0.040 K, orders 1.69 and 1.84.
- [x] 2026-10-05: F2 closing items. (a) `runs/` cleanup: the oldest finished runs beyond 100 are deleted (never a queued or running run; only directories named as run ids; at start-up and after each run). (b) The five F0 failure probes replayed through the real run manager (`tests/runManagerFailures.test.ts`, gated): each broken input ends `failed` with the solver's own text and no result; the manager runs the next case after a failure. (c) Keyboard and 200% zoom pass: Properties no longer disappears below 1000 px (it moves under the editor and the page scrolls), Problems rows and tab lists are keyboard-operable (arrow keys, Home/End; menus too), run status is announced (`role=status`), the dimmest text now has 4.9:1 contrast, an audit found no unnamed controls (29 visible). Finding from (b): a power of 500 MW/m passes validation with only `W_POWER_RANGE`, the solver completes and the centre comes out at 18 million K; the warning now appears in the Results banner and provenance.
- [x] 2026-10-05: Codex review of process handling run (two auditors): 12 confirmed findings, none fixed yet. See [docs/reviews/codex-2026-10-05-process-handling.md](docs/reviews/codex-2026-10-05-process-handling.md).
- [x] 2026-10-05: the 12 Codex findings fixed, each test-first (see the Fix status table in the review record). `npm test` 270 pass; `FEED_SOLVER=1 npm test` 289 pass twice in a row.
- [x] 2026-10-05: `codex-review` re-run on the fixes: 6 findings, 5 confirmed and fixed (one a regression of mine: `timeout` moves its child out of the process group), 1 dropped as not reproducible. See the second-review section of the review record. A third pass has diminishing returns; run one after any change to `solver/*.sh` or the run manager.
- [ ] Still open for F2: a screen-reader pass with a real screen reader (only an automated name audit was done); touch/mobile layouts are not designed; a hard limit or refusal for physically absurd temperatures is not decided (the plan says warn, not clamp)
- [x] 2026-10-05: temperature-dependent conductivity in OFFBEAT. No generic linear or tabulated model exists, but the `steel1515TiTobbe` model is k = par1 + par2 T[degC] and reads par1, par2 from a `conductivity { }` block, so par2 = b and par1 = a + 273.15 b reproduce any linear k = a + b T. The conductivity-integral oracle (a=4.0, b=-0.0006, centre 1246.8586 K) matches OFFBEAT with errors falling 3.7, 3.3, 3.25 times per mesh doubling. The writer now supports constant and linear laws in fuel and cladding; the results parser checks them against the closed form and flags a result `out-of-domain` when cells leave the stated range. Gated real-solver tests cover both.
- [ ] Not expressible yet: tabulated k(T), cubic or other correlations (OFFBEAT's `ZyRELAP` takes par1..par4 and could carry a cubic; not wired). The model name is a misnomer for a generic linear law; the writer's mapping and the manifest say so. Re-check on any OFFBEAT version bump.
- [ ] **[codex]** F0 exit review.

## F1: case contract ([plan 02](docs/plans/02-case-and-materials.md), [04](docs/plans/04-verification.md))

- [ ] Case schema, validator and fixtures; every error code has a failing bad fixture.
- [ ] Required properties per model; selection of sourced properties with ranges and terms.
- [ ] Oracle set final with tolerances fixed before any solver run; closed forms recomputed by a script and checked a second way.
- [ ] Material round trip and unknown-set preservation on the fake.
- [ ] Example pin documented, labelled synthetic or sourced.
- [ ] **[codex]** F1 exit review.

## F2: guided thermal editor ([plan 03](docs/plans/03-editor-and-adapter.md), [04](docs/plans/04-verification.md))

- [x] 2026-10-05: case writer with golden files (Claude, not delegated; see F0 section): vertices match OFFBEAT's rodMaker.py; a changed option changes only the files that own it.
- [ ] Run manager: isolated directory, explicit argument list, timeout, owned process tree, cancel; native solver status shown.
- [ ] **[agy]** Results parser; saved real outputs parse, broken outputs refused. Needs F0 outputs.
- [ ] Pin view, inputs, property status, Problems, results, compare, thermal-only banner; keyboard operation and 200% zoom.
- [ ] Oracle set passes: closed forms, energy balance, mesh refinement at the expected order, parity with the direct solver.
- [ ] Tests of the verifier: wrong conductivity, swapped region, dropped gap, scaled power, lost refusal each fail the check.
- [ ] Failure, cancellation, non-convergence and crash never shown as success.
- [ ] **[codex]** F2 exit review (process handling).

## F3: suite transfers ([plan 05](docs/plans/05-suite-transfers.md))

- [x] 2026-10-05: SEED adapter: seven verbs, typed errors, oracle coverage in `describe` [seed]. FEED side: headless runner `src/cli/headless.ts` (describe, validate, run, cancel) and 19 oracle entries under `oracles/seed` (generator `scripts/gen-seed-oracles.cjs`; closed-form expected values, tolerances fixed before any run). SEED side: `adapters/feed` merged into SEED main (c7f18e1) after two Codex auditors reviewed it (10 findings fixed); see SEED `docs/adapter-feed.md`. Real solver passes all 19 entries (peak within 0.03-0.05 K of closed form against 0.15-0.3 K tolerances) and a real cancel through the adapter stops OFFBEAT in the distro. Open: cancel in the instant before the solver run is registered is untested; SEED catalog entry.
- [x] 2026-10-05: transfer intake: units, normalization, coverage, conservation, stale revision, approval, uncertainty carried; scripted fake sources, 50 tests, four mutations of the code each caught (`src/core/transfer.ts`, [decision 0003](docs/decisions/0003-provisional-transfer-shapes.md)). Recipe and source shapes are FEED-owned and provisional until SEED defines its recipe format. Not an adapter: no OpenMC or NODAL result is read yet.
- [~] OpenMC heating mapping with a recipe; total mapped power conserved within a tolerance fixed beforehand [seed]. The mapping and its conservation check are done against fakes (above); a real OpenMC tally reader is not.
- [~] NODAL boundary mapping: identified axial region; explicit choice of bulk-plus-h or surface temperature; bulk temperature alone refused. Done against fakes (`mapBoundary`); no NODAL reader yet.
- [ ] Standalone vs workspace equivalence on the same immutable input.
- [ ] Material round trip with real OpenMC and thermal sets (cross-app acceptance case).
- [ ] **[codex]** F3 exit review (conservation and refusal logic).

## F4: further physics ([plan 06](docs/plans/06-mechanics-and-irradiation.md))

- [ ] Plan mechanics separately after the thermal release: property needs, reference cases, validation gate per step.
- [ ] Irradiation histories only with a burnup definition, data terms and validation cases chosen.
- [ ] Decide whether steps 5 and 6 (swelling and gas release, transients) belong in a teaching tool.

## Release ([plan 07](docs/plans/07-release.md))

- [ ] Distribution model and license, after the solver stack's terms are known.
- [ ] Pre-release checklist; make the repo public only when the user says so.
- [x] 2026-10-05: repo created, private: https://github.com/bluetyde/feed (local folder `fuel-performance-studio`, branch `main`, commits as bluetyde with the noreply email). Still to do: add a SEED catalog entry; choose a licence before it goes public (none chosen; the repo is all rights reserved until then).

## Fuel library and design ([plan 02](docs/plans/02-case-and-materials.md))

Where fuel comes from (decided with the user 2026-10-05): presets, shared materials from OpenMC Studio, and custom entry. First fuel type: TRIGA (U-ZrH).

- [x] 2026-10-05: Library menus (pin presets, material presets) in the editor; TRIGA-like pin and materials, labelled synthetic (values from memory, NOT sourced). Material picker in the Fuel and Cladding panels.
- [x] 2026-10-05: sourced TRIGA data from the K-State TRIGA SAR (Dec 2004) and the UT-Austin TRIGA II SAR (Ch. 4, 8/2023) in `research/VIRTUAL REACTOR/`: element dimensions, U-ZrH k = 18 W/m/K, stainless-304 k (14.9, 16.6, 19.8 W/m/K at 300, 400, 600 K), effective gap conductance 2840 W/m2/K. Library entries carry citations; the K-State hot-element pin reproduces the SAR's own Table 4.8 temperatures (503.2 C centreline) within 0.5 K, and is an oracle entry. The earlier from-memory TRIGA presets were removed.
- [ ] Not yet sourced or not read: the JSI papers (burnup, reactivity-worth, Serpent/RAPID) were checked by keyword only and have no thermal property tables; the UT-Austin normal-operation film coefficient and pool temperature; U-ZrH conductivity vs hydrogen ratio and temperature (SARs say little dependence, General Atomics/Simnad 1980 is the primary source, not read); K-State eq. 7 for the film coefficient (scanned digits unreliable, `0.0326 P + 16985`); heat capacity (needed for transients only).
- [ ] Check the K-State Table 4.8 reading against the scanned page image (text layer only was read; the sums agree to 0.1 K, which is strong but not the same as looking).
- [ ] Add a normal-operation TRIGA pin (UT-Austin hot channel 20.66 kW = 54.2 kW/m average over 38.1 cm, Table 4.18) once a sourced pool film coefficient is found.
- [ ] Import a material from OpenMC Studio (shared project material by ID and revision); a material with no thermal set names what is missing; adding a thermal set makes a new revision and leaves composition untouched.
- [ ] Custom fuel entry with source and valid range; save a custom material to the library.
- [ ] Pin design helper: edit pellet, gap and cladding dimensions with the to-scale view; derived gap thickness and volumetric power shown.
- [ ] TRIGA specifics to decide: central zirconium rod, axial layout (graphite reflectors), U-ZrH hydrogen-ratio dependence, hot-gap vs cold-gap, and whether stainless or aluminium cladding is first.
- [ ] Other fuel types later (PWR UO2/Zircaloy, plate fuel); each needs its own sourced properties.

## Ideas / later

- A closed-form-only "quick look" mode with no solver, clearly labelled as a limited calculation.
- Radial power shapes beyond uniform.
- Export of runs as lab-report figures and tables.
- Property-uncertainty and sensitivity studies driven through SEED once the harness supports them.

## Decisions waiting (the user's)

- [ ] Approve the F0 solver install (disk and build cost) and its isolated environment.
- [ ] Stack (match SEED/NODAL or choose per the editor needs).
- [ ] Distribution model and license.
- [x] Repo created as `bluetyde/feed` (private), 2026-10-05. Confirm the name is final before making it public.

## Done

- [x] 2026-09-30: Planning skeleton, first plan and suite integration links (Codex).
