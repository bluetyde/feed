# 0003: Provisional transfer recipe and source shapes

2026-10-05. Status: provisional, until SEED defines its recipe file format (open item in SEED plan 08).

`src/core/transfer.ts` implements the receiving end of plan 05 with FEED-owned shapes: `feed.transfer-recipe/0.1` (kinds `heating` and `boundary`), `feed.heating-source/0.1` and `feed.coolant-source/0.1`. They carry exactly the fields plan 05 and SEED plan 08 list: approver and time, a tolerance set in the recipe, source run and revision, target case revision, units, normalization with its origin, axial slices or region, and the Monte Carlo relative error. When SEED's format exists, the recipe moves to it and these shapes become the adapter's input mapping; the checks do not change.

Choices that matter:
- Nothing is defaulted. No boundary form, no normalization, no tolerance, no uncertainty: each missing item is its own refusal code (`E_BOUNDARY_INCOMPLETE`, `E_NORMALIZATION_MISSING`, `E_RECIPE_INVALID`, `E_UNCERTAINTY_MISSING`).
- Revisions: the target case is named by the SHA-256 of its canonical JSON (`caseRevision`); any edit after approval is `E_STALE_REVISION`. Source revisions are compared as opaque strings.
- Kinds are never converted into each other without their basis: per-source-particle needs a source rate or total power; W/m3 needs the bin volume; a score already in watts with a normalization is refused (it would be applied twice).
- Coverage: every slice must be fully covered by the pin's bins; nothing is extrapolated. Within a bin the density is uniform, and a bin straddling a slice boundary is split by overlap length.
- Conservation is checked against the sum over ALL of the pin's bins, so slices that do not span the pin fail it (`E_CONSERVATION`); this is deliberate. To map part of a pin, give that part its own pin id in the source.
- Uncertainty: independent bins combine in quadrature per slice and the result is recorded with the slice; propagation into temperature is still an open item (plan 05).
- Pressure, if given, must state absolute or gauge.

Not done: the OpenMC and NODAL adapters that would produce these sources, the editor view of a stale link, SEED recipe approval records, and the standalone-versus-workspace equivalence run (plan 05 acceptance 4 to 6).

## Update 2026-10-05: after the Codex F3 review

See [the review record](../reviews/codex-2026-10-05-transfers.md). Changes to the shapes: an approval is `{approver, time, recipeDigest}` and covers the recipe's content; the heating recipe and source name the tally `score` and a coordinate `frame`; sources state `temporal: "steady"`; a total-power normalization states its `domain {binCount, scoreTotal}`; mapped results carry their target revision and slice, and `applyToCase` returns `{ok, doc}` or errors. The digest gives integrity only: anyone who can edit a recipe can recompute it, so the real approval (identity, time, tamper evidence) must come from SEED's record when its format exists.
