# M0 of the mechanics plan: what OFFBEAT's mechanics does on FEED's 1D pin case

Done 2026-10-07 for [plan 09](../plans/09-mechanics.md), milestone M0. **Question:** with the mechanics switched on, does the pinned OFFBEAT (`80e84450`, OpenFOAM 9) give the closed forms for free thermal expansion, a pressurised thick tube and a closing gap with contact, on FEED's own 1D wedge with its coupled fuel and cladding patches? **Answer: yes to all three; the contact pressure depends on a penalty factor and is within 2 to 3 % of the closed form only for a narrow range of it.**

Nothing in FEED's case writer changed: the writer still writes `mechanicsSolver fromLatestTime` (mechanics off). The probes edit what it wrote, run it through `solver/probe-mechanics.sh` (copies every field of the last time out, which `run-feed.sh` does not), and compare with closed forms written in the test file and sharing no code with FEED. Test: `tests/mechanicsProbe.test.ts` (`FEED_SOLVER=1`, 11 tests, helper `tests/helpers/mechanicsProbe.ts`). Queries that were read, not run: `solver/survey/09` to `15`.

## OFFBEAT's own verification cases run on the pin (through `solver/run-upstream-verification.sh`, from a copy)

| Case | Result |
|---|---|
| `gapVolume1D` | its own `Allrun` passes: total gas volume 1.44013e-07 against the expected 1.44042e-07 (-0.0201 %) |
| `gapVolumeHeatedFuel1D` | passes: 1.3795e-07 against 1.37734e-07 (+0.157 %) |
| `thickCylinderExpansion` | all four solves ran to the end (the exit status 139 after a complete write is the known shutdown crash); its comparison script needs `numpy`, which the distro does not have, so its error table is empty. Not used as an oracle. |

## What the probes found (case: the synthetic pin, 1 W/m so the pin sits at its coolant temperature of 600 K, Tref 300 K, E = 2e11 Pa, nu = 0.3, generalised plane strain on)

1. **Free thermal expansion is exact.** The radial displacement of the three patches is alpha dT r to better than 5e-5 relative (tolerance in the test 2e-4); the gap is b(1 + e2) - a(1 + e1) to 1 %; no stress (the largest component is axial noise of about 50 kPa). The temperatures are the same as with the mechanics off to one unit in the last printed digit (1e-5 K).
2. **A thick tube under external pressure agrees with Lamé:** radial displacement of both surfaces within 1.3e-4, the hoop stress within 1e-3 at three cells, the radial stress within 0.15 MPa of 15 MPa.
3. **The gap closes and contact works in the 1D wedge.** A fuel growing four times as fast as its cladding (alpha 4e-5 against 1e-5, a 20 micron gap, dT = 300 K) presses on the cladding. The closed form (Lamé for both solids, each free of axial force) is 101.3 MPa. In the fuel the stress is uniform hydrostatic compression, equal to the interface pressure to 1 % in the radial and hoop components; the cladding's hoop stress is Lamé's at that pressure to 2 %.
4. **The contact pressure depends on the penalty factor of the `gapContact` condition** (`penaltyFactor` in `0/D`; the writer writes 0.1). The error against the closed form:

   | penalty factor | interface pressure | error | `gapWidth` at the interface |
   |---|---|---|---|
   | 0.02 | 73.8 MPa | -27.1 % | -4.6 µm (overlap) |
   | 0.05 | 88.4 MPa | -12.8 % | -2.2 µm |
   | **0.1 (the writer's)** | 94.6 MPa | **-6.6 %** | -1.2 µm |
   | 0.2 | 98.0 MPa | -3.2 % | -0.6 µm |
   | 0.3 | 99.2 MPa | -2.0 % | -0.4 µm |
   | 0.5 | 100.3 MPa | -1.0 % | +1.7 µm |
   | 1 | 106.0 MPa | +4.6 % | +1.2 µm |
   | 10 | 1144 MPa | **x11.3** | +160 µm |
   | 100 | no result written (not examined) | | |

   The soft end under-predicts the pressure because the solids overlap; at 0.5 the `gapWidth` reading has the wrong sign although the pressure is within 1 %; at 10 the answer is an order of magnitude wrong **and the run exits normally with nothing in its log to say so**. So: a contact result needs an independent check (the interference closed form is exact for linear elastic solids), and a penalty factor chosen on one problem is not known to suit another.
5. **The implicit contact condition** (`implicitGapContact`, needs `penaltyFactorFriction` in addition) gives the same pressure as the explicit one at the same penalty (94.46 against 94.59 MPa at 0.1).
6. **Each solid takes its own axial strain, free of axial force.** In the fuel the axial stress is zero (strain 0.012285 = alpha dT + Poisson's response to the 94.6 MPa); in the cladding it integrates to zero. The generalised plane strain does not tie the two blocks together axially, so a case where the fuel and the cladding are held to a common length is not what this mesh gives. (The earlier assumption in the plan, a common axial strain, was wrong.)
7. **Missing mechanical properties are fatal, not silent.** A constant material without `E`, `nu` or `alpha`, or with `alpha` misspelled, stops OFFBEAT with `keyword ... is undefined in dictionary ... materials/cladding` (exit 1, no result). This is different from the thermal property models, whose omitted parameters take a silent default (property survey), and it holds for the `constant` material only: the E and alpha models (Matpro and others) were not probed.
8. **What a mechanics run writes** (the last time, in addition to `T` and `C`): `D`, `DCyl`, `epsilon`, `epsilonCyl`, `epsEl`, `epsTh`, `sigma`, `sigmaCyl`, `sigmaDev`, `sigmaHyd`, `sigmaExp`, `gapWidth`, `hGap`, `interfaceP`, `gradD`, `divSigmaExp`, and others. `sigma` is a symmetric tensor, six numbers per cell in the order xx xy xz yy yz zz (radial, shear, shear, hoop, shear, axial in the wedge); `D` is a vector (radial, 0, axial). The log prints for every outer iteration `relResidualD`, `absErrD` and `Domain average displacement`, and the temperature ones FEED's convergence predicate already reads.
9. **Cost:** a run of 84 pseudo-time steps takes about 0.15 s of solver time; the wall time of one probe (WSL start, file copies, the case) is 10 to 35 s on this machine with other agents running.

## What this changes in the plan

- The M0 gate is met: free expansion, Lamé and a closing gap agree with their closed forms, and contact works in the wedge, so a 2D slice is **not** needed.
- Contact accuracy is the real risk. M2 must write a penalty factor on purpose (not 0.1), and M3's independent contact solution must be a check on every result with contact (overlap and pressure against the interference closed form), with a tolerance of a few percent and a refusal or a failed check beyond it.
- The plane-condition decision (decision 3) changes: the options in this mesh are each solid free axially (what `modifiedPlaneStrain` gave) or plane strain (axially fixed); a coupled axial strain is not available.
- Silent defaults: not for `constant` mechanical properties; to be checked again for the property models (M1).

## Not probed

The penalty sweep was done on one geometry and one pair of materials; the failed run at a factor of 100; the models for E, nu and alpha; a pressure on the cladding's inner surface or a gas pressure (`gapPressure`); plane strain instead of modified plane strain; a transient; an annular fuel; whether the contact condition survives a coarse or a fine mesh; the convergence tolerances for `D` in `fvSolution` and how FEED's convergence predicate should read them.
