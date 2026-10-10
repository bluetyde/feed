# Mechanics: a thermo-elastic result for one slice

A case may ask for **mechanics**: the displacement and the stress of the fuel and the cladding in one radial slice, from the temperatures, the thermal expansion and the contact between the solids. It is [plan 09](plans/09-mechanics.md) (M0 probe, M1 properties, M2 the run, M3 the independent check of every result; M4 internal pressure and stress limits and M5 the editor are still to do). Code: `src/core/validate.ts` (`parseMechanics`, `mechanicalSets`), `src/core/mechanicalEval.ts`, `src/core/caseWriter.ts`, `src/core/mechanicsResults.ts`, `src/core/convergence.ts`, `src/core/thermoElastic.ts` (the independent solution) and `src/core/mechanicsChecks.ts` (the checks). Data and what the sources give: [spike/mechanics-data.md](spike/mechanics-data.md).

## What it is, and is not

Small strain, **linear elastic**, one radial slice, thermal expansion, a contact condition between the fuel and the cladding. **No creep, no plasticity, no swelling or densification, no fuel cracking or relocation**, no pressure inside the cladding (that is M4), steady cases only. A stress is **not** a verdict: nothing is compared with a strength unless a limit is stated, and this release states none. Every result and export carries that sentence (`MECHANICS_TEXT`). The thermal result of the same case is the one FEED always gave: the temperatures do not depend on the mechanics (the M0 probe found them equal to 1e-5 K), and the gap conductance is the stated one.

## What a case says

```json
"assumptions": { "thermalOnly": false, "steadyState": true, "geometry": "1D-radial" },
"materials": { "fuel": { "...": "sets include mechanical.elasticity and mechanical.thermalExpansion" }, "cladding": { "...": "the same" } },
"mechanics": {
  "referenceTemperature": { "value": 300, "unit": "K" },
  "plane": "free-axial",
  "contact": { "penaltyFactor": { "value": 0.5, "unit": "1" } },
  "coolantPressure": { "value": 0.1, "unit": "MPa" }
}
```

- **`assumptions.thermalOnly: false` and the section go together.** The flag without the section is refused (`E_PROP_MISSING` at `/mechanics`), the section with the flag true is refused (`E_SCHEMA_INVALID`). A case without either is unchanged, byte for byte, in what it writes and what it reports.
- **`referenceTemperature`**: where the solids are free of thermal stress (K or degC). Required, nothing assumed.
- **`plane`**: `free-axial` (each solid takes its own axial strain, free of axial force; OFFBEAT's `modifiedPlaneStrain on`, what a short free slice of a rod does) or `plane-strain` (axially fixed). Plane stress is wrong for a rod and a strain common to both solids is not available on this mesh.
- **`contact.penaltyFactor`**, from 0.05 to 1: the contact pressure depends on it. The M0 probe found 0.1 about 7 % low, 0.5 about 1 % low and 10 eleven times too high with nothing in the log to say so; a factor outside 0.05 to 1 is refused. Every result with a contact is checked against the independent solution (below), and a factor that does not suit the materials fails there; the sweep is in the last section.
- **`coolantPressure`**: the pressure on the cladding's outer surface (Pa, kPa, MPa, GPa, psi, ksi), 0 for none.
- **The property sets** of both solids are required (`mechanical.elasticity`, `mechanical.thermalExpansion`); a missing one is refused naming the set, the material and the solid.
- **`internalPressure`** (optional, M4): the pressure of the gas in the gap, an input that names its source (FEED has no plenum, fission gas or hydrogen inventory of its own). `{"model": "constant", "pressure": {...}, "source": "..."}`, or `{"model": "hydrogen-zrh", "hZrRatio": {"value": 1.65, "unit": "1"}, "fuelTemperature": "peak" | "mean", "source": "..."}`, the equilibrium hydrogen pressure of the hydride fuel from the correlation of Simnad (GA E-117-833, section 2.4: `log10 P(atm) = K1 + K2 1e3 / T`, [src/core/hydrogenPressure.ts](../src/core/hydrogenPressure.ts)) at the hottest (or the area-mean) fuel temperature of the closed-form profile, for an H/Zr ratio of 1.5 to 1.8 (the delta phase). The report gives no temperature range for the fit, so none is checked; the record says the temperature the pressure was taken at. With no `internalPressure` the files are written as before.

- **`stressLimits`** (optional, M4): a list of limits the case states, each `{name, region, table, source}` where the table is 2 to 200 points `{temperature, strength}` with increasing temperatures. A limit is the case's own input; `library/strengths.json` holds two sourced tables to copy into it: the 304 stainless steel's ultimate tensile and 0.2 % yield strength from the UT-Austin SAR figure 4.3a (read by eye from a log plot, good to about 10 %; ultimate 400 to 1100 C, yield 400 to 870 C; below 400 C nothing is stated, which is where a TRIGA cladding usually runs, so such a cladding is not judged by them and the check says so). The result carries one check per limit, `stressLimit:<name>`: the smallest margin (the strength at the cell's temperature, linear between points, minus the cell's von Mises stress) over the solid's cells and where it is. **A cell whose temperature is outside the table is not judged and the check fails**, saying how many cells and what the table covers: nothing is extrapolated and a limit that cannot be judged does not pass. A pass says the stress is below that strength; it is **not an integrity assessment** (no creep, fatigue, plasticity or strain limit is checked).

- **Not combined** with a transient, with hot dimensions (a mechanics case computes the expansion itself: the two would count it twice) or with a burnup (`E_UNSUPPORTED`).

## A law of temperature becomes a constant

OFFBEAT's `constant` material takes one Young's modulus and one expansion coefficient per solid; it has no model that is linear in temperature. A modulus or a coefficient stated as a law is reduced to constants on the closed-form temperature profile of the case (`mechanicalEval.ts`): the modulus **at the area-weighted mean temperature** of the solid, and the coefficient that gives the **same mean thermal strain** from the reference temperature (the rule the hot dimensions use for the radii). The stress is therefore approximate for a law that changes much over the solid (the strain profile is the constant coefficient's); where a solid's temperatures leave the stated range of a law the result carries a warning (`W_ELASTICITY_RANGE`, `W_EXPANSION_RANGE`) and the run mapping says what each constant is.

## What is written, and what is read back

- **A gas pressure** is given to OFFBEAT through its tabulated gap gas model (`gapGas timeTabulated` with a constant pressure and pure helium, plus the state file `0/uniform/gapGas`); OFFBEAT adds it to the traction on the fuel surface and the cladding bore. It changes no temperature: the gap's heat transfer is the case's stated conductance (checked on the real solver, every thermal check passes). In a contact the radial stress at the interface is the contact pressure plus the gas pressure (the independent solution does the same, so the reported contact pressure is the total less the gas). **OFFBEAT's axial balance (free-axial) gives the cladding the gas's closed-end load** (`sigma_z = p a^2 / (b^2 - a^2)`, found equal to 0.1 % on the real solver) **and the fuel a tensile axial stress of +p**; the second is OFFBEAT's convention and not what a pellet column under gas pressure would do (compression), so the fuel's axial stress with a gas pressure is the solver's, not independent physics; the checks use OFFBEAT's convention and say so here. The coolant has no end load.
- The writer sets `mechanicsSolver smallStrain`, `thermalExpansion on`, `planeStress off`, `modifiedPlaneStrain` on or off, the materials' `E`, `nu`, `G = E / (2 (1 + nu))`, `alpha` and `Tref`, a `tractionDisplacement` condition on the cladding's outside with the coolant pressure, and the penalty factor on the `gapContact` condition. The displacement is under-relaxed by **0.5** (0.8 for a thermal case): with a contact the default settings oscillate and never reach OFFBEAT's criterion within its 1000 outer iterations, which OFFBEAT then accepts silently; with 0.5 the contact case converges in two iterations.
- **The displacement must converge, or the run fails.** FEED reads OFFBEAT's own criterion for the displacement (`mechanicsSubSolver::converged`: the initial residual of `D` below the `D` tolerance and the relative residual below `relD`, or one of the two ten times below, from the same `stressAnalysis` dictionary) on the last outer iteration of the final step, the same way it judges the temperature. A run that did not converge is `failed` with `E_NOT_CONVERGED`, never a result.
- The run script copies `D`, `sigma`, `sigmaCyl`, `gapWidth` and `interfaceP` out of OFFBEAT's last time; the results record carries, for each cell, the radial and axial displacement, the radial, hoop and axial stress (tension positive) and the von Mises equivalent, and for each solid the ranges and the displacement of its outer surface, the gap between the solids (negative when they overlap), the contact pressure and whether they touch. A missing or damaged field is a **failed check** (`mechanicsFields`) and no record, never a pass.

## The checks every result carries

Each mechanics result is compared with an **independent thermo-elastic solution** (`src/core/thermoElastic.ts`) written without OFFBEAT: two concentric cylinders with the constants OFFBEAT is given (the reduced constants of the record) and the closed-form temperatures of the case. For a solid, with the thermal strain `theta = T - Tref`, the displacement is `u = A r + B / r + (1 + nu) alpha / (1 - nu) x (1 / r) x the integral of theta s ds` (the hollow cylinder of Timoshenko and Goodier, with the axial strain of the generalized plane strain); the constants A, B and the axial strain follow from the surface pressures and the axial condition, and a gap that closes gets the interface pressure that makes it exactly zero. The module was itself checked first (`tests/thermoElastic.test.ts`: Timoshenko's long solid cylinder with free ends and a parabolic temperature, the Lame thick tube, the interference pressure of two cylinders from their compliances).

| Check | What it compares | Tolerance (fixed in the plan before the first run) |
|---|---|---|
| `mechanicsDisplacement` | the radial displacement of every cell | 1 % of the largest displacement of the solid + 1e-9 m |
| `mechanicsStress` | radial, hoop and axial stress of every cell | 3 % of the solid's stress scale + 10 kPa (the scale is the larger of its largest independent stress and 1 % of E alpha max abs(T - Tref)) |
| `mechanicsEquilibrium` | OFFBEAT's own stress against the radial balance between neighbouring cells | 2 % of the same scale + 10 kPa |
| `mechanicsContact` | whether the solids touch, the interface pressure, or the open gap | pressure 3 % + 10 kPa; gap 2 % + 1e-8 m; a gap within 0.5 micron of closing is not judged for touching |

The first run of the independent solution against OFFBEAT's real output (the golden case of M2) passed all four inside those tolerances (the displacement within 2e-8 m, the open gap to 0.05 %, the stress within 2.1 MPa of 760 MPa). Each check was then shown to fail when its field is damaged by more than the tolerance (`tests/mechanicsChecks.test.ts`), and a mutation run of the module and the checks (33 mutants; 5 survived and got tests, none survives now).

### What the contact sweep found (gated tests, real solver)

Three cold gaps (10, 20, 40 micron) and fuels of E 5e10, 2e11 and 4e11 Pa against a cladding of 2e11, each closed by 5 micron of free overlap (23 to 32 MPa), at several penalty factors:

- **The contact pressure depends on the penalty factor, and by different amounts for different stiffness ratios.** The pressure is always low, by about 0.3 / factor % for the stiffer fuel, 0.7 / factor % for equal moduli and 2.1 / factor % for a fuel a quarter as stiff as the cladding. Equal moduli: 0.05 gives 13 % low, 0.1 gives 6.6 %, 0.2 gives 3.2 %, 0.3 gives 2.0 %.
- **A factor that is too large does not converge:** equal moduli at 0.7, the stiffer fuel at 0.5 and the soft fuel at 1.0 all end `E_NOT_CONVERGED` (the criterion of M2 catching it: the run is failed, never a result).
- **At a factor that suits the pair** every check passes: 0.3 for equal moduli and for the stiffer fuel (the pressure within 2.2 % and 1.1 % at worst over the three gaps).
- **A fuel a quarter as stiff as the cladding (the TRIGA fuel against steel) is the known limit.** Its factor has to be 0.7 for the contact to be stable, and its pressure is then 2.7 to 3.1 % low, at the edge of the 3 % tolerance; the stress check can fail by about 1 MPa. The solids touch and the pressure is right to 4 %, but the result is not within the tolerance fixed in advance, and it is reported as such.
- **A factor that is too small is accepted by OFFBEAT and by the run, and then fails the contact check.** A bad factor is never a pass.
- A first sweep with 60 micron of free overlap (1.5 % strain, 100 to 250 MPa) was outside the small-strain range and not a pin: the displacement missed its 1 % by the micron of overlap the penalty contact leaves, and the temperature of the stiff fuel did not converge. It is not part of the tests.
- Not tried in the tests: a displacement relaxation of 0.3 instead of 0.5 widens the stable range (the stiffer fuel at 0.5 then converges and is 0.3 % low; equal moduli at 0.5 is 1.1 % low) but does not move the soft fuel's limit. It is a candidate for a later change of the writer, with a recommended factor in the editor (M5).

## What it was checked against

- **Through the real solver** (`tests/mechanicsSolver.test.ts`, `FEED_SOLVER=1`): free thermal expansion (`u = alpha dT r`, no stress); plane strain (`u = (1 + nu) alpha dT r`, `sigma_z = -E alpha dT`); an external pressure on the cladding; a fuel that expands four times as fast as its cladding closing a 20 micron gap (the interference pressure of the closed form, 101.3 MPa); the library's TRIGA fuel and stainless steel cladding with their laws reduced to constants.
- **On real saved OFFBEAT output** (`tests/golden/offbeat-mechanics`, `tests/mechanicsResults.test.ts`, `tests/mechanicsConvergence.test.ts`): the parser, the order of the points, the damaged-field refusals, the criterion with the thresholds on both sides.
- **The reduction of a law** (`tests/mechanicalEval.test.ts`): the mean strain against an exact integral of the profile written in the test.
- **The independent solution and the four checks on every result** (M3, above), with the contact sweep over gaps, stiffness ratios and penalty factors.
- **Gas pressure and stress limits** (M4): the independent solution carries the gas on both surfaces and OFFBEAT's end load; real-solver tests with an open gap, a closed gap and the hydrogen model on the TRIGA fuel and steel; the stress-limit check on OFFBEAT's real fields (`tests/mechanicsStressLimits.test.ts`).
- **Not yet**: the editor (M5), SEED oracle entries (M6). A strength of the cladding below 400 C has no source we hold (only Sandia's single point at 154 C).
