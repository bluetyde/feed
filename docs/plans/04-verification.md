# Plan 04: Verification

How we know the temperatures are right. Runs through every milestone; F2 is the main gate. These entries are also the **fuel app's oracle set for SEED's agentic harness**, in SEED's oracle-entry format (SEED repo `docs/plans/06-oracles-and-verification.md`). Method follows Virtual Reactor's validation plan: define the metrics and decision process before looking at results.

This verifies a limited thermal calculation, not complete fuel behaviour. Nothing here validates mechanics, irradiation or fuel integrity.

## Levels

| Level | Question | Method | When |
|---|---|---|---|
| 1. Contract | Does the case and result schema hold? | Good and bad fixtures; validator | F1, every change |
| 2. Case writer | Are the solver files right? | Golden files per option | F2 |
| 3. Oracle | Is the temperature right? | Closed forms, derived without the solver | F1 (written), F2 (run) |
| 4. Balance | Is energy conserved? | Heat generated vs heat leaving the outer surface | F2 |
| 5. Convergence | Does refinement approach the answer at the expected rate? | Mesh refinement study | F2 |
| 6. Parity | Does the app's run equal a direct solver run? | Same snapshot through app and directly | F2, every solver or adapter change |
| 7. Refusal and limit | Does it refuse and flag out-of-domain? | Bad-input and out-of-range cases | F1 onward |
| 8. Suite | Does the transfer conserve and refuse correctly? | Plan 05 checks | F3 |

**Independence:** parity (level 6) catches wrapper drift only. A mistake shared by the solver and its direct use passes it. Levels 3 to 5 are what catch shared mistakes, so every case has a closed form or balance derived without the solver.

## Closed forms (steady state, uniform heat source, per unit length)

For a solid fuel cylinder of radius R with conductivity k and linear heat rate q′: the centre-to-surface rise is **ΔT_fuel = q′ / (4 π k)**, independent of R; the profile is T(r) = T_s + q′ (1 − r²/R²) / (4 π k).
With temperature-dependent k the conductivity integral holds: **∫ k dT from T_s to T_0 = q′ / (4 π)**.
Gap with conductance h_gap at the fuel outer radius R_f: ΔT_gap = q′ / (2 π R_f h_gap).
Cladding (conductivity k_c, radii R_ci to R_co): ΔT_clad = q′ ln(R_co / R_ci) / (2 π k_c).
Coolant film (h_c at R_co): ΔT_film = q′ / (2 π R_co h_c).
Heat leaving the outer surface per unit length equals q′ in steady state.

## Draft oracle entries

Synthetic and **illustrative**; F1 re-derives them with a script, checks each by a second method, and fixes tolerances before any solver run. Numbers below were computed 2026-10-03 and checked once.

| ID | Case | Expected | Method |
|---|---|---|---|
| fuel-solid-const | Solid cylinder, k = 3 W/m/K, q′ = 20 kW/m, prescribed T_s | ΔT_centre = 530.5 K | q′ / (4 π k) |
| fuel-radius-independence | Same, R = 3, 4.1, 5 mm | Same ΔT_centre | closed form shows no R dependence |
| pin-composite | R_f = 4.1 mm, h_gap = 5000 W/m²/K, R_ci = 4.18 mm, R_co = 4.75 mm, k_c = 15 W/m/K, h_c = 30000 W/m²/K, T_bulk = 573 K, q′ = 20 kW/m, k = 3 | ΔT_gap = 155.3 K; ΔT_clad = 27.1 K; ΔT_film = 22.3 K; ΔT_fuel = 530.5 K; centre T = 1308.3 K | series of the forms above |
| fuel-k-of-T | k = a + b T, T_s given | T_0 from a (T_0 − T_s) + b/2 (T_0² − T_s²) = q′ / (4 π) | conductivity integral (numbers fixed in F1) |
| balance | Any pin-composite case | Outer-surface heat flux × area per length = q′ within tolerance | energy balance |
| refine | pin-composite at 3 mesh levels | Error vs closed form decreases at the solver's expected order | refinement study (order fixed in F1) |
| bad-units | Power given without units | refusal `E_UNITS` | bad-input |
| bad-boundary | T_bulk without h | refusal `E_BOUNDARY_INCOMPLETE` | bad-input |
| missing-k | Fuel material has composition and density only | refusal `E_PROP_MISSING` naming conductivity | bad-input |
| out-of-range | Solution exceeds the conductivity correlation's range | result flagged `out-of-domain`, never plain success | known-limit |
| contact-needed | Closed gap with no gap model | refusal explaining contact needs mechanics | known-limit |

Tolerances: stated per entry before running; closed-form agreement expected to a small mesh-dependent error, with the allowed value set from the refinement study. A tolerance is never loosened after seeing a result.

## Gates

- A failing level 1 to 4 or 7 entry blocks the build and any SEED study using the app.
- A failing level 5 or 8 entry blocks the affected feature and is recorded.
- A solver or adapter version bump re-runs the set and records which verdicts moved.

## Tests of the verifier

A deliberately wrong run must fail each level: a wrong conductivity, a swapped region, a dropped gap, a scaled power, a lost refusal, a changed tolerance. A gate that cannot fail is useless.

## Honesty rules

- Do not adjust an expected value to match the solver; a changed expected value needs a source and a second derivation.
- Keep sourced, computed and assumed values apart and labelled.
- Say what the set does not cover: transients, mechanics, irradiation, contact, real property uncertainty.
- Every results view carries the thermal-only banner.

## Open

- Convergence order and refinement levels for the first example (from F0).
- Whether to add a randomized property test of the closed-form composite (random radii and conductivities) as a cheap independent check.
- Sourced validation data for later phases (surveyed in TOOLING; none chosen).
