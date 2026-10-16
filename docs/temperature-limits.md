# Temperature limits

A case can state **limits**: a maximum temperature for the fuel or the cladding, with the source it comes from. Each rule becomes a check in the results. Code: `src/core/limits.ts` (the arithmetic and the checks), `parseLimits` in `src/core/validate.ts`; the editor's "Temperature limits" item; the sourced set in `library/limits.json`. Tests: `tests/limits.test.ts`, `tests/temperatureLimitsSolver.test.ts` (`FEED_SOLVER=1`), the `limits-*` schema vectors.

**FEED has no limits of its own.** A limit is an input of the case, as a material's conductivity is, and it needs its source or the case is refused. A case with no `limits` has no limit checks and its results say nothing about any. A temperature below a limit is **not** an integrity assessment: the temperature-limit check computes no stress, no hydrogen pressure and no failure, and says so (a case that asks for [mechanics](mechanics.md) gets its stress separately, and a stress below a strength is not an integrity assessment either).

## The rule

```json
"limits": [
  {
    "name": "TRIGA fuel limit, cladding at most 500 C",
    "region": "fuel",
    "maxTemperature": { "value": 1150, "unit": "degC" },
    "whileCladding": { "atMost": { "value": 500, "unit": "degC" } },
    "source": "K-State SAR 2004 sections 3.5.1 and 4.7 (NUREG-1282); UT-Austin SAR Ch. 4 section 4.2.1"
  }
]
```

- 1 to 10 rules, each with a unique `name` (80 characters), a `region` (`fuel` or `cladding`), a `maxTemperature` (above 0 K, at most 10000 K, K or degC) and a non-empty `source`.
- `whileCladding` (fuel rules only) makes the rule apply only at the moments the **hottest cladding cell** is `atMost` and/or `above` a temperature. `atMost` includes its temperature and `above` excludes it, so the two TRIGA rules split every cladding temperature between them. A band needs `atMost` above `above`.
- Refusals: `E_SCHEMA_INVALID` (not a list, empty, more than 10, no name, a duplicate name, a bad region, `whileCladding` on a cladding rule or empty), `E_PROP_MISSING` (no source, no maximum), `E_OUT_OF_RANGE` (a temperature of 0 K or above 10000 K, a band that never holds), `E_UNITS`.

## The checks

One check per rule, in order: `temperatureLimit1`, `temperatureLimit2`, ... The value is the **smallest margin** (the limit minus the hottest cell, K) over the moments the rule is in force; negative means exceeded. The verdict is pass at zero or more, fail below zero. A rule whose cladding condition never held in the run passes with no value and says it was not in force.

- A steady run has one moment: its result.
- A pulse has two views, and the verdict takes the **worse**: the solver's outputs, and **every step of the independent finite-volume solution**, which sees a peak between two outputs (a pulse can peak between them). The note says which decided and when.
- A failed limit check is a failed check on a completed run: the result is still shown, marked failed, never plain success.

## The sourced set

`library/limits.json` has two sets. The second, added 2026-10-10 from the General Atomic report (Simnad, E-117-833, chapter 4), is **for steady operation**: the **750 °C operational design limit** on the fuel (set because at the resulting temperatures the growth of the fuel from irradiation and fission products is insignificant; a design limit, not a point of failure, so a pulse goes above it by design and must not use this set) followed by the two safety limits below. The first set is **TRIGA stainless-clad U-ZrH (H/Zr 1.6): fuel temperature limits**: 1150 °C while the cladding is at most 500 °C, 950 °C once it is above. From the K-State SAR (sections 3.5.1 and 4.7, citing NUREG-1282) and the UT-Austin SAR (Ch. 4 section 4.2.1, with the stainless-steel strength figures 4.3a and 4.3b); both give the same two values. The limit exists because hydrogen outgasses from the fuel and the pressure stresses the cladding, whose strength falls above 500 °C. It does not cover aluminium cladding, a different hydrogen ratio, or any other failure mechanism. Two example cases carry it: `ksu-triga-1p25mw-film-limits` and `ut-triga-pulse-4p40-limits`.

Through the real solver: the K-State hot element at 1.25 MW is 783.7 K at its hottest (margin 639 K to the 1150 °C rule; the 950 °C rule is not in force, the cladding is 317 K); the UT-Austin $4.40 pulse (illustrative numbers) reaches 1097.5 K, a margin of 325.7 K, decided from the independent solution's steps.

## A coated particle's regions (plan 13, T3 stage 2)

A particle case takes `limits` too: `src/core/trisoLimits.ts` (the arithmetic and the checks), `parseTrisoLimits` in `src/core/triso.ts`; tests `tests/trisoLimits.test.ts` (18, ungated), `tests/trisoSolver.test.ts` (`FEED_SOLVER=1`), the `triso-limit-*` vectors. A rule has the same four keys (`name`, `region`, `maxTemperature`, `source`) and the same bounds (1 to 10 rules, 0 K to 10000 K, a unique name, a source); the **region is `kernel` or one of the layers the particle has** (`buffer`, `ipyc`, `sic`, `opyc`). `fuel` and `cladding` are a pin's and are refused (`E_SCHEMA_INVALID` at the region); a layer the particle does not have is `E_GEOMETRY` at the region; `whileCladding` has no meaning (a particle has no cladding) and is `E_UNSUPPORTED` at the key. FEED has no limits of its own for a particle either: the vectors' numbers are synthetic and say so.

The checks are the pin's: `temperatureLimit1`, `temperatureLimit2`, ..., the value the smallest margin (the limit minus the hottest **cell** of the region, K), pass at zero or more. A steady result is one moment. **A cell's value understates its region's hottest point** by up to half a cell's drop (the buffer's first cell is 2.1 K below its inner face on 12 cells for a 36 K drop; the kernel's first cell 0.12 K below its centre), so a small margin is a reason to refine the mesh; the check's note says so. A pulse (stage 3) takes the worse of the solver's outputs and every step of the independent solution, as the pin does.

## Not done

- Cladding temperature limits other than what a case states (the SARs give none beyond the 500 °C condition).
- Limits on rates (a heating rate), on time at temperature, or on differences.
- Aluminium cladding: no sourced limit or properties in the library.
- Mechanics: see [the TODO](../TODO.md) F4. Limits are the cheap step before it, not a substitute.
