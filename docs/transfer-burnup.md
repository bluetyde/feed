# The burnup transfer: a depletion record into the case's burnup

FEED's third transfer (after `heating-to-pin` and `coolant-boundary`): a burnup that OpenMC Studio's depletion run wrote into `depletion.json` becomes the case's [`burnup`](burnup.md). SEED's side of the contract is `docs/transfer-recipe.md` section 8 in the SEED repository (recipe `seed.transfer-recipe/0.3`, request `seed.transfer-request/0.3`, a **record** as the source, not a run quantity). Plan: [plan 10](plans/10-burnup.md) M6. Code: `src/core/transferBurnup.ts`, routed by `transfer` in `src/core/transferRequest.ts`; the reader of the record is `src/core/depletionRecord.ts`.

## What SEED checks before FEED sees the request

The approval; the unit conversion (MWd/tU to MWd/kgHM, x 0.001, heavy metal); that the record file is the pinned file and has the pinned id, and that the id is the SHA-256 of the record's canonical text; that the region exists; that the time lies inside the record (the burnup is cumulative at the **end** of each step, linear inside a step, 0 at t = 0, never extrapolated). SEED sends the burnup **already converted**.

## What FEED checks (and refuses, with the code)

| Fault | Code |
|---|---|
| not a 0.3 request; a recipe that is not 0.3 or not for FEED's `burnup`; a source that is not a `depletion-record/1` record | `E_SCHEMA_INVALID`, `E_RECIPE_INVALID`, `E_UNSUPPORTED` |
| recipe units that are not MWd/tU to MWd/kgHM, factor 0.001, heavy metal; a quantity that is not MWd/kgHM; an oxide basis | `E_UNITS`, `E_UNSUPPORTED` |
| a request whose record id, region or time is not the one the recipe was approved for | `E_RECIPE_INVALID` |
| a converted value that is not the record's original value times 0.001 (to 1e-9, relative) | `E_UNITS` |
| a negative or non-finite value; a burnup above 62 MWd/kgHM (the case's validator speaks) | `E_OUT_OF_RANGE` |
| a fuel whose conductivity is not `uo2-nfi` (a burnup would change nothing); a transient case | `E_UNSUPPORTED` |
| a target that is not a JSON object; a malformed provenance | `E_SCHEMA_INVALID` |

FEED never applies 0.881 or 0.8815 here. It multiplies by its own constant when it writes the solver's field (burnup.md).

## What it produces

The new case is the old one with `burnup` replaced: `value` in MWd/kgHM, `basis: "heavy-metal"`, and `source` naming the record, for example `depletion-record/1 id adde6fb2..., region "UO2 3.5%", t = 5 d` (with ` (interpolated inside a step)` when the time falls inside a step). One entry is appended to `provenance.transfers`: `{kind: "burnup", recipeId, recipeDigest, record, recordId, recordSha256, region, time, timeUnit: "d", interpolated, original {value, unit: "MWd/tU"}, burnup {value, unit, basis}}`. Nothing else in the case changes, and the case sent is never modified in place. The reply's `checks` carry the burnup, the record and region and time, and what the validator said (`warnings`).

## Describe

`node dist/cli/headless.js describe` lists `{field: "burnup", accepts: [{dimension: "burnup", normalization: "none"}], parameters: {region, time, produces, case}}`; SEED refuses a recipe the app has not declared.

## The expected pair

Studio's own record (`tests/fixtures/studio-depletion-pin-record.json`, byte-identical to Studio's `pin_record.json`: region `UO2 3.5%`, steps of 1 and 4 days, 38 and 190 MWd/tU) and the `lwr-uo2-burnup` example: time 5 gives 0.19 MWd/kgHM (`tests/fixtures/transfer-burnup-expected-case.json`), time 1 gives 0.038, time 3 gives 0.114 (interpolated), time 0 gives 0. The fixture run is short, so these burnups are tiny; a realistic test needs a longer Studio run.

## Checked

`tests/transferBurnup.test.ts` (17 tests: the pair, every refusal, the real built command on stdin with one JSON line and exit 0), `tests/transferBurnupPair.test.ts` (4), `tests/studioDepletionRecord.test.ts` (7). 30 mutants of the module and the router: 25 died at the first run (4 of them because the mutant did not compile), 4 survived and got tests (each recipe fault alone), 1 is equivalent (the case text is parsed into a local object, so mutating it in place changes nothing).

## Not done

A real end-to-end test behind SEED's host (SEED adds it once this is on FEED's main); regions finer than a material (axial slices wait on Studio, [plan 10](plans/10-burnup.md)); a record field other than `burnup_mwd_per_tu`.
