# Plan 14, M0: what OFFBEAT does for the mechanics of a coated particle, and what can be checked independently

Done 2026-10-16 for [plan 14](../plans/14-triso-mechanics.md) (the D1 question of [plan 13](../plans/13-triso-particle.md)), through the real solver (feed-solver distro, user `feed`, OFFBEAT `80e84450`, OpenFOAM 9). Documents and throw-away scripts only: no change to `src/`, `tests/`, `schema/` or another plan. The scripts are kept as `.txt` in [triso-mechanics-probe/](triso-mechanics-probe/); the log of one complete run of all of them is [probe-log.txt](triso-mechanics-probe/probe-log.txt). Run them with `MSYS_NO_PATHCONV=1 wsl -d feed-solver -u feed -- bash <script file>` (`run-all.sh.txt` runs everything, 2 to 3 minutes). Every run is on a **copy** under `~/spike/d1/`; OFFBEAT's tree was only read. OFFBEAT is GPL-3.0; no OFFBEAT file, script or coefficient table is kept here (the scripts name its paths, and the numbers they use are the ones the shipped cases give, quoted as results of a run, not as data).

**Result in one paragraph.** OFFBEAT runs the whole shipped TRISO set (benchmark cases 1 to 11 and 13, the tutorial, three of its module tests) without a failure; each takes 0.2 to 28 s. Where a closed form exists, OFFBEAT's cell stresses agree with it to **0.002 to 0.03 % (tangential) and 0.03 to 0.16 % (radial) of the layer's peak stress** for a layered elastic sphere under pressure (cases 1 to 3), for a swelling layer (case 4a) and for a heated shell with thermal expansion (case 1 with the switch on). For constant-coefficient creep (cases 4b, 4c) an independent time march written for this probe reproduces the benchmark's expected values (the SiC stress to 0.001 % and 0.1 %). The shipped scripts' own "relative error" lines (0.6 to 3 %) are mostly **where the stress is read** (a face value extrapolated from the first cell, or the first cell 2.5 micrometres inside), not solver error. For the coupled cases 9 to 13 (SCIANTIX, CO, gap, swelling and creep correlations) there is no independent solution here; the shipped "previous values" are **not reproduced** by this build (5 to 27 % apart) and 5 of the 14 results fall outside the "range of other codes" quoted in the same files.

## Machine and conditions

16 logical processors; load average 0.97 at the start of the final run and 1.15 at the end (another agent shares the machine, but no heavy job was running in this window, so the times below are indicative, not benchmarks). A direct `offbeat` run exits **139 (segmentation fault) after it has written a complete result** (the known shutdown crash, as in the earlier probes); the cases' own `Allrun` scripts hide it and exit 0. No exit-139 run lost a result.

## The shipped runs

All "Allrun" rows are the case's own script (`blockMesh`, `changeDictionary` if present, `offbeat`, `postProcess -func sampleDict`), time is its wall clock; exit 0 for all.

| Case | What it is (read from its files) | Time | What it writes | Reference in the shipped script, and this run |
|---|---|---|---|---|
| case_1 | one SiC shell 350 to 385 um, 25 MPa inside, 0.1 MPa outside, elastic, 12 cells | 0.28 s | times 0, 10; all fields incl. `sigma` | expected 1.2519e8 Pa (tangential, inner face); run 1.24386e8 (-0.64 %) |
| case_2 | one IPyC shell 350 to 440 um, same loads, 16 cells | 0.25 s | same | expected 50.2e6; run 49.03e6 (-2.3 %) |
| case_3 | IPyC 350 to 390 + SiC 390 to 425 um, same loads, 8 + 8 cells | 0.30 s | same | expected 8.8e6 / 104.4e6; run 8.538e6 / 103.70e6 (-3.0 % / -0.67 %) |
| case_4a | case 3 + PyC swelling at a constant rate (-0.005 per 1e25 n/m2), flux 3e19 n/cm2/s for 100 s | 0.40 s | 11 times | expected 926.8e6 / -845.71e6; run 921.38e6 / -841.52e6 (-0.58 % / -0.49 %) |
| case_4b | case 3 + PyC creep at a constant coefficient, flux 3e14 for 1e7 s | 0.60 s | times 0, 1e7 | expected -25e6 / 139.34e6; run -24.999e6 / 138.43e6 (-0.004 % / -0.65 %) |
| case_4c | 4a + 4b together | 1.01 s | same | expected 26.05e6 / 86.5e6; run 25.47e6 / 86.03e6 (-2.2 % / -0.54 %) |
| case_4d | IPyC with the PyC swelling correlation + creep | 1.69 s | same | "previous value" 29.16e6 / 78.69e6; run 28.95e6 / 78.74e6; other codes [25,35] / [71,88] MPa |
| case_5 to 8 | IPyC, SiC, OPyC shells, 1000 days, swelling correlation and creep (8: correlation creep, incremental-updated solver, thermal expansion on) | 2.3, 1.6, 2.1, 7.0 s | times 0, 8.64e7 | see "Where the coupled cases land" |
| case_9, 10, 11, 13 | whole particle (kernel to OPyC), heat source, TRISO gap model, SCIANTIX, CO, swelling and creep, 89 to 600 days | 7.8, 15.5, 27.8, 18.4 s | final time only (plus 0) | see below |
| case_12 | **not shipped** (the directory has 1 to 11 and 13) | | | |
| generic_TRISO_1D (the tutorial) | the T0 case, 1780 steps to 5e7 s | 18.1 s wall (19.8 s in an earlier run) | a time directory every 50 steps | aborts at its last step on a heat table ending at the end time (T0); with one more table point (6e7, 0) it completes, exit 139 after complete output; gas pressure 15.45 MPa |
| trisoModulesTest: hollowsphere_1D, sphere_1D, testPyC_creep | OFFBEAT's own unit-type tests with an expected value from a spreadsheet | 1.3, 0.23, 1.7 s | | hollow sphere: displacements 0.03 % / 0.01 %, face stresses 0.4 to 1.5 %, face strains up to 3.3 %; sphere: outer displacement 0.002 %, centre temperature -0.18 %; PyC creep strain -0.008 % |

What a coupled run needs: `fgr SCIANTIX` needs the case's `input_settings.txt` (SCIANTIX's own switches: 18 lines of model choices) and is built into the distro's OFFBEAT (it ran in all four); the whole-particle meshes (2 degree wedge) come with a `constant/referenceMesh`; `gapGas TRISO` needs the `0/gapGas` file (all fractions 0, `gasPressureType fromModel`); the heat source and fast flux are tables against time (`timeDependentVhgr`, `timeDependentAxialProfile`). The log of case_13 holds 14350 warnings (about 8 per step) that the buffer and IPyC patches' bounding boxes are not similar (the gap AMI coupling) and one empty-field warning per step (1830); 1830 steps and 13060 iterations in 19.7 s. These are the warnings of a gap that has opened: at the end of case_13 the buffer's outer face is at 338.06 um and the IPyC's inner face at 349.36 um, an **11.3 um gap** that the mechanics opened (the buffer shrank): the quantity plan 13's D4 had to take as an input conductance.

What OFFBEAT writes for the mechanics (case_13, last time, 64 cells): `D`, `DCyl`, `sigma` (xx = radial, yy = zz = tangential on the wedge mesh; yy and zz agree exactly in the elastic cases), `sigmaCyl`, `sigmaEq`, `sigmaHyd`, `sigmaDev`, `epsilon`, `epsEl`, `epsTh`, `epsilonSwelling`, `epsilonCreep`, `epsilonCreepEq`, `epsilonP`, `fastFluence`, `fastFlux`, `Bu`, `gapWidth`, `hGap`, `interfaceP`, `porosity`, `intergranularGasSwelling`, `intragranularGasSwelling`, `k`, `T`, `Q`; the log prints `Gap conditions` (gap volume and temperature, buffer gas volume, gas pressure, gas mass, mass fractions `Y` and molar masses `M`). The results parser FEED has for the pin (`D`, `sigmaCyl`, `gapWidth`, `interfaceP`) would need `sigma` and a radius from `writeCellCentres` (as the thermal reader of T0 already does), and a layer from the cell zones.

## The comparison with a closed form (elastic cases)

The independent solution is [lame.py.txt](triso-mechanics-probe/lame.py.txt), written for this probe: concentric elastic spheres, each with its own modulus, Poisson's ratio and a uniform free strain (radial and tangential, for thermal expansion and swelling), the displacement `u = A r + B/r^2` (plus, for a free strain that is not the same in both directions, the term `k r ln r` that radial equilibrium needs; `k = -2(1-2nu)(e_t-e_r)/(3(1-nu))`), the unknowns found from the surface pressures and the continuity of displacement and radial stress at every interface. **Self tests** (in the log): the textbook single-shell formula agrees to 6e-8 Pa; two layers of one material agree with one shell to 1e-7 Pa; for an anisotropic free strain the radial equilibrium residual is 4e-3 Pa. It reproduces the benchmark's expected values at the inner faces: the textbook value `[p_i (b^3+2a^3) - 3 p_o b^3] / (2 (b^3-a^3))` for case 1 is 1.2519e8 Pa (the script's expected value, to its five digits), case 2 gives 5.01997e7 (script: 50.2e6), case 3 gives 8.779e6 and 104.38e6 (script: 8.8e6 and 104.4e6, rounded to two to four digits). (The loads and geometry are those of the shipped case files, read from the copies: SiC E 3.7e11 Pa, nu 0.13; IPyC E 3.96e10 Pa, nu 0.33, thermal expansion off; pressures 25 and 0.1 MPa; the kernel and buffer are not meshed in cases 1 to 4, the coating starts at 350 um.)

OFFBEAT's **cell-centre** stresses, all cells, against this solution at the same radii ([compare.py.txt](triso-mechanics-probe/compare.py.txt)):

| Case | Layer (cells) | Largest tangential difference | Largest radial difference |
|---|---|---|---|
| 1 | SiC (12) | 2133 Pa = 0.0017 % of the layer's peak 1.246e8 Pa | 1.1e4 Pa = 0.048 % of 2.4e7 Pa |
| 2 | IPyC (16) | 3616 Pa = 0.0073 % of 4.96e7 Pa | 2.3e4 Pa = 0.098 % of 2.4e7 Pa |
| 3 | IPyC (8) / SiC (8) | 1953 Pa = 0.023 % / 6001 Pa = 0.0058 % | 8.0e3 Pa = 0.033 % / 1.9e4 Pa = 0.11 % |
| 4a (swelling, free strain -0.015) | IPyC (8) / SiC (8) | 1.04e5 Pa = 0.011 % of 9.2e8 Pa / 1.10e5 Pa = 0.013 % of 8.4e8 Pa | 2.2e5 Pa = 0.16 % of 1.4e8 Pa / 1.3e5 Pa = 0.09 % |
| 1 with thermal expansion on | SiC (12), wall temperatures 793 K and 393 K | 1.0e5 Pa = 0.021 % of 4.7e8 Pa (closed-form hollow sphere + pressure) | 1.7e5 Pa = 0.51 % of 3.4e7 Pa |

So **a finite-volume cell value with 8 to 16 cells per layer is within 0.03 % (tangential) and 0.2 % (radial) of the closed form**. What the shipped scripts report is different, and it is the reading:
- case 1 and 2 read the **face value** of `sigma` at the inner patch, which OFFBEAT extrapolates from the first cell: -0.64 % in case 1 (12 cells over 35 um) and -2.3 % in case 2 (16 cells over 90 um). The first cell's own value is within 0.003 % of the closed form at its radius, and the closed form at the face is the shipped "expected" value (to the digits the script gives).
- case 3 to 13 read the cell the probe point falls in: the first cell, whose centre is 2.5 um inside the face in case 3. The "-3 %" of the IPyC in case 3 is the stress gradient over those 2.5 um (the closed form at the face 8.779e6, at the cell's radius 8.540e6, OFFBEAT 8.538e6).
- **For FEED: read the cell-centre values, compare at the cell radius, and do not compare face values** (or compare them with a stated allowance of 1 to 3 %).
- The 1 with thermal expansion run's radial difference (0.51 %, 1.7e5 Pa) is of the size the 0.0985 K gap between OFFBEAT's cell temperatures and the analytic profile would give (alpha E dT about 2e5 Pa) and the T0 probe's 0.03 % flux factor of the wedge mesh (0.03 % of 400 K = 0.12 K); this attribution was **not tested** (the run was not repeated with the temperature field corrected).

## Constant-coefficient creep (cases 4b, 4c): an independent time march

[creep1d.py.txt](triso-mechanics-probe/creep1d.py.txt) uses lame.py with the IPyC cut into M thin sublayers, each with its own creep strain. The creep law is the one OFFBEAT's own header comment gives for its creep models (strain rate in direction i = K [s_i - vc (s_j + s_k)] x flux, here with K = 2.715e-4 per MPa per 1e25 n/m2 and vc = 0.5 as in the case files; the sign and the units of K come from the case file and from OFFBEAT's source reading K in per MPa); the elastic problem is linear, so the stress at the sublayer mid-radii is a matrix times the creep strains; the fluence is marched with Heun's method (600 steps to 3e25 n/m2). **It does not use any OFFBEAT code.** Results (stress at the faces, tangential, M = 10 / 20 / 40 sublayers; the benchmark's expected value and OFFBEAT's value for comparison):

| Case | Face | M=10 | M=20 | M=40 | Richardson (M=40 + (M=40 - M=20)) | Expected (script) | OFFBEAT cell near the face |
|---|---|---|---|---|---|---|---|
| 4a | IPyC | 928.226e6 | 928.226e6 | 928.226e6 | exact (no creep) | 926.8e6 | 921.38e6 |
| 4a | SiC | -847.187e6 | same | same | | -845.71e6 | -841.52e6 |
| 4b | IPyC | -24.236e6 | -24.616e6 | -24.807e6 | -24.999e6 | -25e6 | -24.999e6 |
| 4b | SiC | 139.337e6 | 139.340e6 | 139.341e6 | | 139.34e6 | 138.43e6 |
| 4c | IPyC | 46.358e6 | 36.217e6 | 31.103e6 | 25.99e6 | 26.05e6 | 25.47e6 |
| 4c | SiC | 86.493e6 | 86.575e6 | 86.595e6 | | 86.5e6 | 86.03e6 |

So the march reproduces the benchmark's expected values: the SiC stress of 4b to 0.001 %, of 4c to 0.1 %, the IPyC face stress by Richardson extrapolation to 0.004 % (4b) and 0.23 % (4c) (the piecewise-constant sublayers converge only to first order at a face; the SiC values, which depend on the interface pressure, converge faster). The 4a value 928.2e6 differs from the script's 926.8e6 by 0.15 %; the reason is not known (an unrounded benchmark value, a different swelling or fluence convention, or a rounding; **not determined**). What this shows: creep and swelling with a **constant** coefficient, and with a stated fluence history, can have a second method in an afternoon of code; the benchmark's own expected values for 4b and 4c are the steady-state asymptote (a fully relaxed IPyC passes the 25 MPa to the SiC), so they are closed forms too.

A first version of this march gave 89.7e6 for the SiC of 4b: the layered solver then assumed `u = A r + B/r^2` for an anisotropic free strain, which violates radial equilibrium (the creep strain differs radially and tangentially). The self test above (equilibrium residual) now catches that; a note for the FEED version: **an independent solution for a layered sphere with anisotropic free strain must carry the `r ln r` term**, and a test must check equilibrium.

## Where the coupled cases land (5 to 13)

There is no independent solution for these here. The comparison is with the numbers the shipped scripts hold: a "previous value" (an earlier OFFBEAT result) and the "range of other codes" (presumably the benchmark's round-robin spread; **the origin of these ranges was not checked**, they are quoted from OFFBEAT's files).

| Case | Quantity | This run | "Previous value" | Change | "Range of other codes" | Inside? |
|---|---|---|---|---|---|---|
| 4d | IPyC / SiC tangential, MPa | 28.95 / 78.74 | 29.16 / 78.69 | -0.7 % / +0.06 % | [25, 35] / [71, 88] | yes / yes |
| 5 | IPyC / SiC | 43.14 / -45.25 | 43.41 / -45.30 | -0.6 % / -0.1 % | [40, 58] / [-56, -28] | yes / yes |
| 6 | IPyC / SiC | 30.39 / 31.59 | 30.60 / 31.55 | -0.7 % / +0.1 % | [27, 38] / [28, 48] | yes / yes |
| 7 | IPyC / SiC | 39.36 / 9.04 | 39.59 / 9.00 | -0.6 % / +0.4 % | [37, 50] / [10, 25] | yes / **no (below by 1 MPa)** |
| 8 | IPyC / SiC | 58.53 / -138.5 | 57.99 / -110.1 | +0.9 % / **+25.9 %** | [50, 56] / [-161, 17] | **no (above by 2.5 MPa)** / yes |
| 9 | gas pressure, MPa / SiC | 4.445 / -183.4 | 4.201 / -144.6 | +5.8 % / **+26.8 %** | [0.7, 16] / [-157, -75] | yes / **no** |
| 10 | pressure / SiC | 6.886 / -200.1 | 6.562 / -170.4 | +4.9 % / **+17.4 %** | [0.7, 13] / [-179, -121] | yes / **no** |
| 11 | pressure / SiC | 33.65 / -74.7 | 31.95 / -84.2 | +5.3 % / -11.3 % | [6, 75] / [-159, 439] | yes / yes |
| 13 | pressure / SiC | 15.23 / -160.6 | 14.36 / -134.6 | +6.1 % / **+19.3 %** | [12, 84] / [-127, 426] | yes / **no (by 33 MPa)** |

Reading: (i) the **thin-shell cases 4d to 7 reproduce the previous values to 0.1 to 0.7 %**; (ii) the cases with the **incremental-updated solver and the gas model** (8 to 13) differ by 5 to 27 % from the shipped previous values, so the shipped values come from another version, setting or tolerance (not determined; the pinned commit is `80e84450`, the repository's README says the code is moving to another framework, so a different state is plausible); FEED must hold **its own reference values from the pinned build** if it ever uses these cases as goldens, and not the shipped numbers; (iii) the spread of "other codes" is itself wide (case 11 SiC from -159 to +439 MPa, the pressures by a factor of 10), so these cases cannot say that a code is right to a few percent: they only say it is not wildly off; (iv) 5 of the 14 comparisons are outside the quoted range.

Gas pressure check from the log of case_13, by hand (the ideal gas law; the log prints the gap volume 1.62738e-15 m3 at 1318.6 K, the buffer gas volume 4.4618e-15 m3 at 1351.49 K, the gas mass 7.39291e-13 kg and the mass fractions of Kr 0.0642, Xe 0.8167, CO 0.1191): mean molar mass 0.08897 kg/mol, n = 8.309e-12 mol, p = n R / (V_gap/T_gap + V_buf/T_buf) = **1.5231e7 Pa against the printed 1.52327e7** (0.01 %). The gap volume is the geometric shell between the two faces times the wedge's volume fraction (1.6256e-15 m3 from the printed face radii against 1.62738e-15 printed, 0.1 %, which is the precision of the radii in the log). So the **pressure given the gas inventory and the volumes is a closed form**; the inventory (fission gas release from SCIANTIX, CO from a correlation) and the volumes (from the deformation) are the parts without an independent check.

## What was not determined

- Why the buffer's thermal result of T0 deviates by 0.076 K (still unexplained, T0), and the origin of the 0.15 % difference on case 4a.
- The origin and meaning of the "range of other codes" and "previous value" numbers; the identity of the cases with the IAEA CRP-6 specification (OFFBEAT's documentation says they are; the specification itself was not read).
- The inputs and coefficients of the PyC and buffer swelling, expansion and Young's modulus correlations (read as far as their inputs: fast fluence, temperature, density, the Bacon anisotropy factor; **no coefficient was copied or checked against its published source**).
- Anything about case 12; a run with a convective outside and mechanics together; the three-dimensional TRISO mesh and `sphericalStress`; the fission-product diffusion cases (`trisoFpDiffusion`, not run); the remaining module tests (14 of 17 not run).
- Whether the 11.3 um gap of case_13 is physically right (no measurement is available here).
