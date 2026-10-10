# Mechanics: a thermo-elastic result for one slice

A case may ask for **mechanics**: the displacement and the stress of the fuel and the cladding in one radial slice, from the temperatures, the thermal expansion and the contact between the solids. It is the first step of [plan 09](plans/09-mechanics.md) (M0 probe, M1 properties, M2 this page; M3 the independent check of every result, M4 internal pressure and stress limits, M5 the editor are still to do). Code: `src/core/validate.ts` (`parseMechanics`, `mechanicalSets`), `src/core/mechanicalEval.ts`, `src/core/caseWriter.ts`, `src/core/mechanicsResults.ts`, `src/core/convergence.ts`. Data and what the sources give: [spike/mechanics-data.md](spike/mechanics-data.md).

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
- **`contact.penaltyFactor`**, from 0.05 to 1: the contact pressure depends on it. The M0 probe found 0.1 about 7 % low, 0.5 about 1 % low and 10 eleven times too high with nothing in the log to say so; a factor outside 0.05 to 1 is refused. M3 will check every result with contact against the closed form.
- **`coolantPressure`**: the pressure on the cladding's outer surface (Pa, kPa, MPa, GPa, psi, ksi), 0 for none.
- **The property sets** of both solids are required (`mechanical.elasticity`, `mechanical.thermalExpansion`); a missing one is refused naming the set, the material and the solid.
- **Not combined** with a transient, with hot dimensions (a mechanics case computes the expansion itself: the two would count it twice) or with a burnup (`E_UNSUPPORTED`).

## A law of temperature becomes a constant

OFFBEAT's `constant` material takes one Young's modulus and one expansion coefficient per solid; it has no model that is linear in temperature. A modulus or a coefficient stated as a law is reduced to constants on the closed-form temperature profile of the case (`mechanicalEval.ts`): the modulus **at the area-weighted mean temperature** of the solid, and the coefficient that gives the **same mean thermal strain** from the reference temperature (the rule the hot dimensions use for the radii). The stress is therefore approximate for a law that changes much over the solid (the strain profile is the constant coefficient's); where a solid's temperatures leave the stated range of a law the result carries a warning (`W_ELASTICITY_RANGE`, `W_EXPANSION_RANGE`) and the run mapping says what each constant is.

## What is written, and what is read back

- The writer sets `mechanicsSolver smallStrain`, `thermalExpansion on`, `planeStress off`, `modifiedPlaneStrain` on or off, the materials' `E`, `nu`, `G = E / (2 (1 + nu))`, `alpha` and `Tref`, a `tractionDisplacement` condition on the cladding's outside with the coolant pressure, and the penalty factor on the `gapContact` condition. The displacement is under-relaxed by **0.5** (0.8 for a thermal case): with a contact the default settings oscillate and never reach OFFBEAT's criterion within its 1000 outer iterations, which OFFBEAT then accepts silently; with 0.5 the contact case converges in two iterations.
- **The displacement must converge, or the run fails.** FEED reads OFFBEAT's own criterion for the displacement (`mechanicsSubSolver::converged`: the initial residual of `D` below the `D` tolerance and the relative residual below `relD`, or one of the two ten times below, from the same `stressAnalysis` dictionary) on the last outer iteration of the final step, the same way it judges the temperature. A run that did not converge is `failed` with `E_NOT_CONVERGED`, never a result.
- The run script copies `D`, `sigma`, `sigmaCyl`, `gapWidth` and `interfaceP` out of OFFBEAT's last time; the results record carries, for each cell, the radial and axial displacement, the radial, hoop and axial stress (tension positive) and the von Mises equivalent, and for each solid the ranges and the displacement of its outer surface, the gap between the solids (negative when they overlap), the contact pressure and whether they touch. A missing or damaged field is a **failed check** (`mechanicsFields`) and no record, never a pass.

## What it was checked against

- **Through the real solver** (`tests/mechanicsSolver.test.ts`, `FEED_SOLVER=1`): free thermal expansion (`u = alpha dT r`, no stress); plane strain (`u = (1 + nu) alpha dT r`, `sigma_z = -E alpha dT`); an external pressure on the cladding; a fuel that expands four times as fast as its cladding closing a 20 micron gap (the interference pressure of the closed form, 101.3 MPa); the library's TRIGA fuel and stainless steel cladding with their laws reduced to constants.
- **On real saved OFFBEAT output** (`tests/golden/offbeat-mechanics`, `tests/mechanicsResults.test.ts`, `tests/mechanicsConvergence.test.ts`): the parser, the order of the points, the damaged-field refusals, the criterion with the thresholds on both sides.
- **The reduction of a law** (`tests/mechanicalEval.test.ts`): the mean strain against an exact integral of the profile written in the test.
- **Not yet**: an independent thermo-elastic solution that checks every result (M3), stress limits and the hydrogen pressure (M4), the editor (M5), SEED oracle entries (M6).
