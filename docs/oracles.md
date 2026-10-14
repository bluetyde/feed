# Oracles: what FEED's results are checked against

An **oracle** is an expected value that does not come from the code it checks. This page lists every one FEED has, what kind it is, where its number comes from, how tight it is and which test holds it. If a result is right, it is right against one of these; if there is none for something, that is stated at the end.

## The rules every oracle follows

- **The expected value never comes from the code under test.** It is a published number, a formula written out again by plain arithmetic in the oracle's own file, or an independent implementation by another method.
- **Tolerances are fixed before any run** and are never loosened after seeing a result. In the SEED entries the tolerance is part of the entry's hash, so changing it needs a new entry version made by a person.
- **An oracle is tested by breaking the code once.** Each fix or new law was run against a mutation script (the code is changed on purpose and the tests must fail); the "done" block of each plan records the runs.
- **Say what it does not prove.** An oracle for the arithmetic of a law does not prove the law.

## The kinds, from strongest to weakest evidence

| Kind | Where the number comes from | What it can catch |
|---|---|---|
| **Literature** | numbers printed in a published report or paper, with the page | a formula or constant that is wrong in the same way as the code |
| **Independent implementation** | the same quantity computed by a different method, in another language or precision | a bug in the method or the numerics |
| **Closed form** | a formula derived by hand and evaluated in the oracle's own file | a bug in the code that implements the same physics |
| **Solver-checked** | the real OFFBEAT's own fields against the closed form | the case writer, the units, the mesh, a wrong basis |
| **Refusal** | a case with one fault that must be refused with a named code | a check that does not fire |

## The catalogue

### Literature oracles

| Oracle | Source | Tolerance | Held by |
|---|---|---|---|
| K-State hot-element centreline temperatures, Table 4.8 (503.2 C at a 20 C pool; 582.0 C at 100 C) | K-State SAR 2004, page 4-19, read on the scan | 0.5 K | `ksu-sar-table-4.8-centreline` in `oracles/closed-form-table.json`; `tests/oracleTable.test.ts` |
| The SAR's own centreline equation (9) and (10) against the series solution | K-State SAR, page 4-19 | 0.1 K | the generator `scripts/gen-seed-oracles.cjs` stops if they disagree |
| TRIGA pulse kinetics, Table VII: peak power, energy and burst temperature rise of a $3 and a $5 pulse, with a constant and a rising heat capacity | General Atomic GA-7882, *Kinetic Behavior of TRIGA Reactors*, 1967, page 31 | 0.5 % (the table is rounded and its equation for the rise is approximate) | `tests/gaKineticsTable.test.ts` (the generator); four SEED entries of kind `published`, `feed-ga7882-pulse-{3,5}-dollar-{energy-deposited,temperature-peak-max}`, which also run on the real solver (energy within 0.4 % of the published value) |
| The values and ranges of the sourced materials, expansion and limits | the reports cited in each `library/` entry; [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), [spike/triga-data-gaps.md](spike/triga-data-gaps.md) | exact | `tests/library.test.ts`, `tests/hotDimensions.test.ts`, `tests/limits.test.ts` |

### Independent implementations

| Oracle | Method | Held by |
|---|---|---|
| `oracles/annulus-reference.py` | annular fuel with an insulated hole by Simpson's rule on the integral, not the closed form | the annular SEED entry (the generator stops if its closed form differs from this value); the annular entries of the closed-form table |
| `oracles/transient-reference.py` | exact transient solutions (cooling and heating of a cylinder) by Bessel functions as power series in 150-digit decimal arithmetic | `tests/transientFv.test.ts` |
| `oracles/transient-case-reference.py` | adiabatic peak of a transient case file: the power history integrated and the heat capacity integral solved, in 60-digit decimal arithmetic | the pulse SEED entries |
| `oracles/point-kinetics-reference.py` (cases and saved results in `oracles/point-kinetics-*.json`) | the pulse generator by fixed-step RK4, bisection and numerical quadrature, where the TypeScript uses Dormand-Prince and closed forms | `tests/pointKineticsReference.test.ts`; the delayed-neutron SEED entries |
| the FEED finite-volume solver for transients (`src/core/transientFv.ts`) | an independent solution of the transient on the same mesh, validated against the exact solutions above | `tests/transientFv.test.ts`; used as the cross-check of every transient result |

### Closed forms

- **`oracles/closed-form-table.json`**: 24 entries (19 values, 5 refusals). Series solution of the pin (film, cladding, gap, fuel), conductivity as a function of temperature by bisection on the integral, annular fuel, exact transient values, adiabatic heating. Tolerance 0.001 K (0.0001 for the transient ones). Held by `tests/oracleTable.test.ts`.
- **The SEED entries, `oracles/seed/`**: on main 92 entries; the branch `claude/tvb-b5` adds 9 for the boundary history ([docs/seed-boundary-request.md](seed-boundary-request.md): three lumped pins against an RK4 solution and five refusals; 101 in all, 63 good, 35 bad-input, 3 known-limit, waiting for SEED's count). The 92: in SEED's `seed.oracle/0.1` format (59 good, 30 bad-input, 3 known-limit; 55 of the good ones have kind `analytic`, the 4 GA-7882 ones `published`; 14 of the 92 are the mechanics entries of plan 09 M6: free thermal expansion, an axially fixed solid and a stress-limit margin, a closing gap, a gas pressure, the hydrogen pressure, one known limit and six refusals, on the mesh 20/8), written by `scripts/gen-seed-oracles.cjs` from plain formulas. Steady pins (constant, linear, cubic and tabulated conductivity, annular, closed gap, prescribed wall, the two TRIGA cases), the reciprocal law, hot dimensions with a constant and a linear coefficient, the UO2 burnup law at 0 and 40 MWd/kgHM, four pulses (adiabatic peak and energy), a pulse from the steady state, Nordheim-Fuchs and delayed-neutron pulses, the temperature limit margins, and the two GA-7882 pulses with the report's printed values. Tolerances: 5 x the fuel's temperature rise / N^2 (the mesh bound) rounded up for steady cases, 0.05 to 0.5 % of the rise for pulses. SEED's adapter reads all 92 (its count test accepts 78 or 92) and runs them on the real solver (SEED agent's report, SEED main `27c0ad8`, 69 of 69 runs; `docs/seed-mechanics-request.md` has what it took); FEED checks the entries against its own closed form (to 1e-3 K) and, with the solver, against OFFBEAT in `tests/seedOracleEntries.test.ts`.
- **Written in the test, sharing no code with FEED**: the burnup law's integral by Simpson's rule and a bisection (`tests/uo2Nfi.test.ts`, `tests/burnupSweep.test.ts`); hot dimensions by a plain fixed-point loop on the closed-form profiles (`tests/hotDimensions.test.ts`); Nordheim-Fuchs, the exact sech^2 pulse with its peak, energy and width (`tests/pointKinetics.test.ts`); the generator against an exact derivation of GA-7882's modified model (`tests/gaKineticsTable.test.ts`).

### Solver-checked

- Saved real OFFBEAT output against the closed form, with mesh refinement (`solver/results/`, `tests/offbeatOracle.test.ts`); the observed order of convergence is checked as well.
- With `FEED_SOLVER=1`: the case through FEED's own writer and run manager into the real solver, every check passing (`tests/solverEndToEnd.test.ts` and the `*Solver.test.ts` files for the polynomial and reciprocal laws, hot dimensions, burnup, point kinetics and limits).
- OFFBEAT's own conductivity and burnup fields against FEED's law cell by cell (`burnupConductivity` and `burnupWritten`), on real fields kept in `tests/golden/offbeat-burnup/` (`tests/burnupResults.test.ts`).

### Refusals

162 bad vectors in `schema/vectors/bad/`, each with one fault and the error code it must give (`tests/validate.test.ts`); 30 of the cases are also SEED bad-input entries, which SEED checks too.

## What the oracles do not prove

- **They are on synthetic or illustrative cases.** The TRIGA cases use the SARs' numbers, not measured pin temperatures. No oracle compares FEED with a measured fuel temperature.
- **The burnup law's equation is typed twice** from the same report (NUREG/CR-7024); the independence is in the integration and the solve. The equation is checked against OFFBEAT's own conductivity field and the report's page, not against measurements.
- **A closed form checks the solver's arithmetic, not the physics assumed:** one radial slice, uniform power, a stated gap conductance, free thermal expansion, a frozen burnup.
- **No oracle covers** swelling, creep or fission-gas release (not built), the temperature-dependent gap, or boiling. The mechanics entries cover stress, displacement and contact only on synthetic closed forms (uniform heating, a Lame tube, two cylinders in contact), not a measured or designed pin, and the contact pressure at a penalty factor that suits the pair is within 2 % of its closed form; a fuel a quarter as stiff as its cladding is a known limit (about 3 % low).

## Adding one

1. Pick the kind. Prefer a literature or independent value over a closed form of your own.
2. Write the expected value in a file that imports nothing from `src/core`; state the source (a page, a method) in the entry.
3. Fix the tolerance, with its reasoning, before running the code.
4. Make the test, then break the code on purpose and see it fail.
5. For a SEED entry, add it to `scripts/gen-seed-oracles.cjs`, run it, check that the existing entries are byte-identical (`git status oracles/seed`), and keep it on a branch until SEED's count test has been told the new total.
