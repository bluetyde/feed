# Plan 09: Mechanics (thermo-elastic first)

The concrete plan for steps 1 and 2 of [plan 06](06-mechanics-and-irradiation.md): thermal expansion, gap closure, pellet-cladding contact and stress output for FEED's one-dimensional pin slice. Written 2026-10-07 from a read-only survey of the pinned OFFBEAT (`solver/survey/09` to `12`). **M0 (the probe of the real solver) was done on 2026-10-07 and its gate is met ([the findings](../spike/mechanics-probe.md)); nothing else is built, and nothing further starts until the user answers the decisions in section 3.** Creep, plasticity, irradiation, swelling and gas release stay in plan 06 for later.

## 1. What it is for, and what a result may claim

Today a FEED result is thermal only, and every result says it implies no stress, failure or integrity. The first mechanics release adds, for the same pin slice: how far the fuel and cladding grow when they heat, whether and when the gap closes, the contact pressure after it closes, and the stresses in both solids. It is for **teaching and for seeing the mechanism** behind the temperature limits that are already in (hydrogen outgassing stresses the cladding, whose strength falls above 500 °C).

A mechanics result is a **different kind of result** from a thermal one and is labelled so: "thermo-elastic, small strain, no creep, no plasticity, no irradiation". It is not a failure or licensing assessment. A stress is compared with a strength only through a stated, sourced **stress limit** (the same idea as the temperature limits: an input with its source, never a built-in verdict).

Not in the first release: creep and plasticity of cladding, fuel swelling and densification, relocation, fission-gas release, burnup, accident transients, any 2D or 3D geometry, any failure model OFFBEAT has (`ZyOverstrainBISON` and the others need Zircaloy data).

## 2. What OFFBEAT gives us (surveyed, not yet run for this)

From the source at the pinned commit (`80e84450`), read with `solver/survey/09-mechanics.sh`, `10-mechanics-details.sh`, `11-verification-cases.sh`, `12-mechanics-cases.sh`:

| Need | What exists |
|---|---|
| Mechanics solvers | `smallStrain`, `smallStrainIncUpdated`, `largeStrainTotLag`, `largeStrainUpdLag` (`physicsSubSolvers/mechanicsSubSolver`). FEED's case writer sets `mechanicsSolver fromLatestTime`, which switches mechanics off. |
| Constitutive laws | `elasticity`, `misesPlasticity`, `misesPlasticCreep`, hyper-elastic and neo-Hookean variants, with creep models (Limback, Matpro, Tobbe, a power law, ...) and yield-stress models. **First release uses `elasticity` only.** |
| Elastic constants | `E`, `nu` as `constant` material entries (verification cases use them), plus Young's modulus and Poisson's ratio models per material (Matpro Zircaloy, Tobbe 15-15Ti steel, UO2 and others). No U-ZrH model. |
| Thermal expansion | `alpha` as a constant, plus models (Matpro Zircaloy, Gehr 15-15Ti steel, UO2 relap, ...). No U-ZrH model; none for 304 stainless by name (Gehr 1515Ti is a different steel). |
| Plane condition | `rheologyOptions { thermalExpansion on; planeStress off; modifiedPlaneStrain on/off; }`: `modifiedPlaneStrain` is OFFBEAT's generalised plane strain along the axis, the usual choice for a 1D rod slice. |
| Gap and contact | The pellet-cladding interface is a pair of coupled patches (FEED already has them: `fuelOuter` and `cladInner`, `regionCoupledOFFBEAT`). Mechanical conditions: `gapContact`, `contact`, `implicitGapContact`, `gapPressure`, `coolantPressure`, `fixedDisplacement`, `plenumSpringPressure` (`fvPatchFields`). Thermally the gap stays `resistiveGap` (constant conductance) or `fuelRodGap` (gas model, needs more input). |
| Gap gas | `gapGas FRAPCON` (fill gas, pressure, volume options); `none` is allowed. Not needed for a first elastic release, but it is how internal pressure normally arrives. |
| Output fields | Displacement `D`, stress and strain fields, equivalent stress (`sigmaEq` is printed in the log already), hydrostatic stress, gap width, contact state. Established in M0: `D`, `epsilon`, `epsEl`, `epsTh`, `sigma` (six numbers per cell: xx xy xz yy yz zz), `sigmaCyl`, `sigmaHyd`, `gapWidth`, `hGap`, `interfaceP` and others are written for the last time; the log prints `relResidualD` and `absErrD` per outer iteration. |
| Own verification cases | `Cases/Verification/thickCylinderExpansion` (thick-walled cylinder), `gapVolume`, `gapVolume1D`, `gapVolumeHeatedFuel1D` (a 1D pin slice with thermal expansion on, FRAPCON gap gas, `modifiedPlaneStrain`), `multiMaterial` and `testCases/hotBiMaterialCylinder`, `beamBending`, `plateHole`. These are the reference cases to run first, and they show the keywords. |

Two warnings already known from the thermal work: an omitted or mistyped property parameter takes a **silent default** in OFFBEAT, and OFFBEAT enforces **no range**. Both apply to mechanics too, so FEED must write every parameter and enforce ranges itself.

## 3. Decisions for the user

Each has a recommended answer; none is built until answered.

### Answers (user, 2026-10-07)

1. Scope: check whether the UT SAR figures 4.3a and 4.3b supply yield strength against temperature; if they do, include cladding plasticity, if not, thermo-elastic only (the recommendation).
2. Optional `mechanics` section in the case; a case without it is unchanged.
3. Each solid free axially, as M0 found (recommended).
4. Internal pressure as a sourced input table against fuel temperature (recommended).
5. Material data: as written (sourced, else user-entered custom, never invented).
6. Stress limits: as written (the temperature-limit mechanism).
7. Order: pause after M0; resume the more important projects first. M1 onwards waits until the user restarts it.

1. **Scope of the first release.** Recommended: **thermo-elastic only** (plan 06 steps 1 and 2: expansion, gap closure, contact, stress output). Creep and plasticity wait. Alternative: include cladding plasticity for yield behaviour (needs yield-strength data vs temperature; the UT SAR figures 4.3a and 4.3b are a source).
2. **Case structure.** Recommended: an **optional `mechanics` section** in the existing case (a model set, the plane condition, the contact and pressure conditions), with `assumptions.thermalOnly` false when present and a distinct result kind. A case without it is unchanged and every thermal oracle must stay byte-identical. Alternative: a separate case type (more duplication, cleaner separation).
3. **Plane condition.** M0 found what `modifiedPlaneStrain on` does on FEED's mesh: **each solid takes its own axial strain, free of axial force** (the fuel and the cladding are separate blocks and are not tied axially). Recommended: keep that (it is what a short free slice of a rod does), with plane strain (axially fixed) as the stated alternative. A common axial strain for both solids is not available in this mesh; plane stress is wrong for a rod and not offered.
4. **Internal pressure.** TRIGA fuel's limiting mechanism is hydrogen pressure on the cladding, a function of fuel temperature (K-State SAR figure 3.8; UT SAR section 4.2.1, figures 4.3a and 4.3b). OFFBEAT has no hydrogen model. Recommended: the case gives the **internal pressure as an input** with its source (a table against fuel temperature, from the SAR figure, digitised and checked the way the UT figure was), applied to the cladding's inner surface. Without it, the elastic result has contact pressure only. This is the step that makes the TRIGA story real, and it needs data we do not yet have in the repository as numbers.
5. **Material data.** E, nu, alpha for stainless 304 and U-ZrH: the SARs may give some (K-State Table 13.3 gave conductivity and density); **M1 finds out**. Anything not sourced is entered by the user as a custom material, never invented.
6. **Stress limits.** Recommended: the same mechanism as temperature limits (a `limits`-style list with a source, comparing a stress measure with a strength, possibly temperature dependent). Needs the strength numbers; the UT SAR figures give stainless 304 strength vs temperature.
7. **Order against other work.** Mechanics is weeks of work. The alternatives that are quicker and independent (hot dimensions without a solver, more property models, the screen-reader pass) can be done first or alongside.

## 4. Milestones, each with a gate

**M0: Probe the real solver (no FEED code).** Run OFFBEAT's own `thickCylinderExpansion`, `gapVolume1D` and `gapVolumeHeatedFuel1D` in the `feed-solver` distro; then FEED's existing 1D wedge case with `mechanicsSolver smallStrain`, `thermalExpansion on`, constant E, nu, alpha, `modifiedPlaneStrain on` and the displacement and contact boundary conditions. Establish: which fields are written and their form on the wedge, how the gap closes in 1D, what `resistiveGap` does when mechanics is on, whether the contact conditions work in a 1D wedge or need a 2D slice, the silent-default behaviour of the mechanical properties, run time, convergence and what "converged" means for `D`. Output: `docs/spike/mechanics-probe.md`, `tests/mechanicsProbe.test.ts` (`FEED_SOLVER=1`). **Gate:** free thermal expansion of the cylinder, a pressurised thick cylinder (Lamé) and a gap closure each agree with the closed form; if contact does not work in the 1D wedge, stop and decide with the user (a 2D axisymmetric slice is a larger change).

**Done 2026-10-07, gate met** ([findings](../spike/mechanics-probe.md), `tests/mechanicsProbe.test.ts`, 11 tests): free expansion and Lamé agree to 2e-4 and 1e-3; contact works in the 1D wedge, so no 2D slice is needed; the contact pressure depends on the `penaltyFactor` (the writer's 0.1 is 6.6 % low, 0.3 is 2 % low, 1 is 4.6 % high, 10 is eleven times too high with nothing in the log to say so); each solid takes its own axial strain; a missing mechanical property of a constant material is fatal, not silent; OFFBEAT's own `gapVolume1D` and `gapVolumeHeatedFuel1D` pass on the pin. What it changes: M2 must write a penalty factor on purpose, and M3's independent contact solution must check every result with contact (overlap and pressure against the interference closed form).

**M1: Properties and data.** What the sources give for E, nu, alpha; sets `mechanical.elasticity` and `mechanical.thermalExpansion` with models, sources, ranges and units (Pa, 1/K); required-property refusals naming the property; library entries only where sourced. **Gate:** a case with mechanics switched on and a missing set is refused with the set named; vectors for good and bad.

**M2: Case structure, writer and parser.** The `mechanics` section, its validator, the writer (solver, rheology options, mechanical boundary conditions, internal and coolant pressure), the results parser for `D` and the stress fields, and the result kind and banner. Extend the convergence predicate to the mechanics residual (today it is thermal only, and a mechanics run that did not converge must be `failed`). **Gate:** the thermal oracle set and every existing test unchanged with mechanics off; an elastic case runs and its stresses read back.

**M3: Independent solution and checks.** A TypeScript solution of the thermo-elastic problem for the same slice (a closed form for a thermal-stress field in a cylinder with constant properties, Timoshenko's formulas; a gap-closure and contact solve built from two thick cylinders), written independently of OFFBEAT, in the pattern of the thermal checks: cross-check, mesh check, equilibrium check (the stress satisfies the radial balance), contact-pressure check. **Gate:** OFFBEAT and the independent solution agree within tolerances fixed before the run, on the free-expansion, thick-cylinder and thermal-stress cases, and on a gap that closes.

**M4: Internal pressure and stress limits.** The sourced hydrogen-pressure table as an input, the stress limit rules with their sources, the checks. **Gate:** the K-State and UT hot-element cases give a stress state that can be compared with the SAR's own statement (clad stress within yield below 500 °C), recorded with its limits and what the comparison does not show.

**M5: Editor.** A mechanics panel (model set, plane condition, pressures, contact), stress and displacement plots, the changed banner and labels, the gap-closure view. **Gate:** driven in the browser pane; a case with mechanics off looks and behaves as today.

**M6: Oracles and SEED.** FEED writes mechanics oracle entries in its own repo (closed forms fixed before any run); SEED needs new quantity names in its adapter (stress, displacement, gap width) and a decision on a failed stress limit: a **request to the SEED agent**, not something FEED pushes. **Gate:** the new entries pass through SEED's adapter once its side exists.

Estimate, honestly uncertain: M0 one session, M1 one or two, M2 two or three, M3 two, M4 one or two, M5 one or two, M6 one: **about nine to thirteen sessions**, and M0's finding on contact in 1D can change all of it.

## 5. Reference cases (all with closed forms, fixed before any run)

- **Free thermal expansion** of a cylinder at uniform temperature: the radius grows by alpha dT R.
- **Thick-walled cylinder** under internal and external pressure (Lamé): radial and hoop stress, radial displacement.
- **Thermal stress** in a solid cylinder with the radial temperature of a uniformly heated rod (parabolic), constant properties: Timoshenko's radial, hoop and axial stresses (the axial one depends on the plane condition).
- **Gap closure:** the gap closes when the fuel's outward growth exceeds the cladding's plus the gap; the contact pressure after it from the two-cylinder interference (Lamé on both).
- **Thin-wall tube:** hoop stress = pR/t as a sanity limit of the thick-wall solution.
- OFFBEAT's own verification cases as a cross-check of the cross-check, not as the oracle.

## 6. Rules carried from plan 06

The assumptions block states the model set; a result from a different model set is a different kind of result; required properties are declared per model and a missing one refuses the run naming it; ranges are stored and enforced by FEED; a new capability extends SEED coverage only when its entries pass; stress and failure results carry their own labels and imply no licensing conclusion; the thermal results do not change when mechanics is off (a regression test against the whole thermal oracle set).

## 7. Risks

- **Contact accuracy** (found in M0): the penalty contact works in the 1D wedge but its pressure depends on the penalty factor (-27 % to +4.6 % over 0.02 to 1, and wrong by an order of magnitude at 10 without any warning in the run). The sweep was one geometry and one pair of materials; a factor that suits it may not suit another stiffness or gap, so every contact result needs the independent check and M3 includes a sweep over gaps and moduli.
- **Thermal-mechanical coupling:** a closing gap changes the gap conductance (with `fuelRodGap`) or not (with `resistiveGap`, a constant). FEED's constant conductance would then hide the feedback; a stated limitation, or a gap-conductance model that depends on the gap width.
- **Silent defaults and no ranges** in OFFBEAT's mechanical properties: handled the same way as the thermal ones (write all, enforce ranges).
- **Convergence and run time** of the mechanics solve; the existing predicate is thermal only.
- **Data:** no sourced numbers for U-ZrH elasticity or expansion exist in the repository yet; if the SARs have none, the first TRIGA mechanics cases use user-entered values and say so.
- **Scope creep** toward creep, plasticity and swelling, which are different studies with their own data and validation.

## 8. Rollback and the definition of done

Each milestone ends with the whole suite green and the thermal oracles unchanged; a milestone that cannot meet its gate is reported with what was found, not shipped partly. The release is done when M0 to M5 pass their gates, the docs say what a mechanics result is and is not, and M6's SEED side is either done by the SEED agent or recorded as waiting.
