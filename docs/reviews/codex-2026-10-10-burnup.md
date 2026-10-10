# Codex review of burnup M1 to M6 (2026-10-10)

Two read-only auditors (silent-failure-hunter, specification-gap-auditor), range `b0e444e^..main` for the first and `..claude/release-readme` for the second, limited to the burnup code, the transfer and their docs. Eight findings. What was done with each:

| # | Finding | Checked against the code | Disposition |
|---|---|---|---|
| 1 | A failed burnup check still leaves the run `completed` | true, and true of every FEED check: the verdicts are in `results.json` and SEED's adapter refuses a run with a failed check at collection | not changed, by design |
| 2 | A truncated `k` or `Bu` file can pass | true: `cellValues` skipped the whole-file check that `T` and `C` get | fixed, test in `tests/burnupResults.test.ts` |
| 3 | An overflowing record (power and time near 1e308) passes the consistency rule | true: `Infinity > Infinity` is false | fixed, test in `tests/studioDepletionRecord.test.ts` |
| 4 | The transfer does not bind the record hash or the recipe's field | true | fixed, tests in `tests/transferBurnup.test.ts` |
| 5 | A non-oxide material can be given the UO2 model | true: FEED trusts the model name | documented in `docs/burnup.md`; TODO for a composition check |
| 6 | The transfer is not verified end to end | true, and known: SEED owns the record checks and adds the host test | open on SEED's side |
| 7 | The range check misses the fuel peak (cell centres only) | true, under a kelvin on the oracle mesh, not burnup-specific | TODO |
| 8 | The sweep plots out-of-range points without their verdict | true | fixed: hollow marks and a sentence under the plot; page test |

Each fix was broken on purpose once to show its test fails (5 of 5 killed).

## Auditor 1: silent failures

1. **High — Failed burnup checks still produce a completed run.** Location: `src/core/runManager.ts:418–426`. If OFFBEAT omits `k` or `Bu`, or writes either on the wrong basis, `burnupChecks` records a failure, but the manager still writes `results.json` and sets the run to `completed`. The headless path then emits a completed manifest without surfacing that failure in its status. **Fix:** require both burnup checks to pass before marking a burnup run completed, or give the run an explicit unverified status that downstream callers must handle.

2. **Medium — Truncated `k` and `Bu` files can pass their checks.** Location: `src/core/resultsParser.ts:325–335`. `cellValues` parses the internal values but does not call the whole-file check used for `T` and `C`. A field cut off after a complete cell list, with its boundary block and footer missing, can pass the burnup comparison. **Fix:** check the complete OpenFOAM file before accepting either field.

3. **Medium — Arithmetic overflow lets an inconsistent depletion record pass.** Location: `src/core/depletionRecord.ts:267–278`. Finite inputs such as `power_w = 1e308` and `time_steps_days = 1e308` make the computed burnup and tolerance `Infinity`; `Infinity > Infinity` is false, so a finite recorded burnup is accepted. **Fix:** reject non-finite intermediate energy, cumulative burnup, expected burnup, and tolerance values.

4. **Medium — The transfer does not bind all source details to the recipe.** Location: `src/core/transferBurnup.ts:57–71, 119`. The units check ignores `recipe.units.field`, and the request’s `recordSha256` is copied into provenance without comparison to the recipe’s pinned value. A request can therefore name a different record field or carry a conflicting hash and still return `ok: true`. **Fix:** require the expected burnup field and compare the request hash with the approved recipe before writing provenance.

## Auditor 2: specification gaps

### [HIGH] Specification Gap / Ambiguity — Non-oxide fuel can use the UO2 burnup law

* **Location:** `src/core/validate.ts:L676`
* **Category:** Omission
* **Epistemic Status:** [INFERENCE]
* **Identified Gap:** The validator restricts `uo2-nfi` to the fuel region but does not verify that the fuel is UO2. A TRIGA U-ZrH case can retain `materialId: "triga-uzrh-h16"`, replace its conductivity set with `uo2-nfi`, and supply a valid burnup.
* **Impact:** The case can pass validation and receive oxide-fuel conductivity results despite the plan’s promise to refuse non-oxide fuel.
* **Remediation Recommendation:** Define a structured fuel-composition requirement for this model and test that **100% of U-ZrH and other non-oxide cases are refused**.

### [HIGH] Specification Gap / Ambiguity — Transfer provenance is not verified end to end

* **Location:** `src/core/transferBurnup.ts:L79`
* **Category:** Omission
* **Epistemic Status:** [INFERENCE]
* **Identified Gap:** FEED compares two values supplied in the request; it does not read the depletion record. The documentation assigns record and approval checks to SEED, while `docs/transfer-burnup.md:L39` says a real SEED-host end-to-end test is still absent. If SEED sends an incorrect record value and a matching converted value, FEED accepts both and records the value under that record’s ID.
* **Impact:** A wrong burnup can acquire apparently valid record provenance without any current integration test detecting it.
* **Remediation Recommendation:** Add a SEED-to-FEED test using a Studio-written record. Mutate the record value, ID, region, time, and approval independently; require **zero accepted mismatches**.

### [MEDIUM] Specification Gap / Ambiguity — Result domain check misses the fuel peak

* **Location:** `src/core/resultsParser.ts:L267`
* **Category:** Edge Case
* **Epistemic Status:** [INFERENCE]
* **Identified Gap:** `propertyRange` checks cell-centre temperatures only. The closed-form fuel centre is hotter than the innermost cell. A case can set a valid-range maximum between those two temperatures: the peak is outside the stated range, but the solver result is marked `in-domain`.
* **Impact:** A burnup result can be presented as valid after its conductivity law has been used beyond its temperature limit.
* **Remediation Recommendation:** Include the calculated fuel peak and surface temperatures in the range gate. Test a maximum placed between the peak and first-cell temperatures; require an `out-of-domain` verdict.

### [MEDIUM] Specification Gap / Ambiguity — Sweep plots extrapolated points without their verdict

* **Location:** `src/web/index.html:L768`
* **Category:** Omission
* **Epistemic Status:** [INFERENCE]
* **Identified Gap:** The sweep returns `out-of-domain` for calculated points, but the editor filters and plots points by the presence of `centreT` and does not display that verdict. For example, a fresh-fuel case with a 1400 K model limit can be valid while higher-burnup sweep points exceed that limit and still appear as ordinary estimates.
* **Impact:** Readers may interpret extrapolated temperatures as estimates within the sourced model’s range.
* **Remediation Recommendation:** Mark or omit every out-of-domain point in both the plot and accessible table. Test a sweep crossing a 1400 K limit and require **every affected point** to carry a visible status.
