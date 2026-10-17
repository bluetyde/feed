# Plan 16: why OFFBEAT's cells sit away from FEED's finite volumes on a coarse particle mesh

Done 2026-10-17 on branch `claude/triso-interface-probe`, through the real solver (feed-solver distro, user `feed`, OFFBEAT `80e84450`, OpenFOAM 9). The question came from plan 13 T6 ([triso.md](../triso.md), "A finding"): on 12 cells per region four of the five sampled particles of `examples/synthetic-triso-population.json` failed FEED's own `crossCheckFv`, with the deviation at the kernel-buffer interface, first order in the cell width, and the mechanism not isolated. A first guess (OFFBEAT interpolates the conductivity linearly to the face and uses a planar conductance) predicted the right sign and 2.5 times the size.

**Answer: the first guess was right about the interface and wrong about the gap.** OFFBEAT's face scheme reproduces every cell of every run to 5e-6 K (the rounding of its 8-digit output), on 30 runs (five particles, 6 to 192 cells per region). The deviation from FEED's finite volumes is the sum of the shifts at the interfaces between regions of different conductivity (kernel to buffer, inner carbon to silicon carbide, silicon carbide to outer carbon); the earlier script had also applied the linear interpolation to the buffer-to-carbon **gap** face, which OFFBEAT does not do (it puts the two half cells and the gap's conductance in series), and that alone made the 2.5 times. FEED's finite volumes are not changed (they are the independent method); the cross-check now states and includes an interface allowance computed from the case.

The probe is a set of throw-away scripts in [triso-interface-probe/](triso-interface-probe/) (the saved runs are in `runs/`, one JSON per particle and mesh with the cell radii, the temperatures and the particle that was run). OFFBEAT's source was read, not copied (GPL-3.0); nothing of it is in FEED.

## What OFFBEAT does (read in the distro, `~/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib`, `/opt/openfoam9/src/finiteVolume`)

| File | Lines | What it does for this problem |
|---|---|---|
| `physicsSubSolvers/thermalSubSolver/solidConductionSolver.C` | 105-111 | The heat equation: `fvm::ddt(rhoCp, T) - fvm::laplacian(mat_.k(), T) == Q`, with `k` the cell field of conductivities. FEED writes `thermalSolver solidConduction` (`src/core/trisoWriter.ts`). |
| `finiteVolume/laplacianSchemes/gaussLaplacianScheme/gaussLaplacianScheme.C` (OpenFOAM 9) | 46-70 | The matrix coefficient between two cells is `deltaCoeffs x (gamma x face area)`, `gamma` the face value of the conductivity: the Gauss scheme. |
| `src/core/caseWriter.ts` (FEED's `system/fvSchemes`) | 536-552 | `laplacianSchemes { default Gauss linear corrected; }`, `interpolationSchemes { default linear; }`: the face conductivity is the **linear interpolation** of the two cells' values, with the mesh's geometric weights (the face's distances to the two cell centres); the `corrected` (non-orthogonal) part is zero on this mesh, whose cell centres lie on the axis and whose faces are normal to it, so the conductance is `k_face x face area / distance between the cell centres` (a planar one). |
| `fvPatchFields/temperatureCoupled/resistiveGapFvPatchScalarField.C` | 66-72 | The gap (a `regionCoupledOFFBEAT` patch pair on the buffer's outer face): `alphaP = k / (cell centre to face distance)` on each side, `alphaEff = 1 / (1/alphaP + 1/alphaN + 1/alpha_gap)`. The planar half cells and the gap in series, **no interpolated conductivity**. |
| `physicsSubSolvers/thermalSubSolver/thermalSubSolver.C` | 186-211 | `gradT` is computed afterwards with the coupled patch's own temperature; it is not part of the solve and does not change `T`. |
| `heatSource/timeDependentVhgr.C` | 144-156 | The source is a cell field `Q` in the `Kernel` zone times the cell volume; FEED's finite volumes share the particle's power by cell volume, and the two agree. |

The conductivity of a cell is its zone's material (`constantMaterial`), taken at the cell's temperature. A cell is on the axis, so it is one end of a chain of cells; the problem is one-dimensional.

## How it was probed

`run-cells.cjs` runs one of the five sampled particles (`oracles/seed-triso/models/triso-pop-*.case.json`) with N cells in every region through FEED's run manager and keeps the cells. `faces.cjs` reconstructs, face by face, the resistance the cells imply: `(T_i - T_{i+1}) / (heat through the face)`, the heat being known exactly (the kernel's cumulative source, then the particle's power) and the temperatures known to 1e-5 K against drops of 0.1 to 1 K per face. `replica.cjs` is a chain solution of the steady sphere with a switchable face scheme (interior faces, the interfaces, the gap, the outside half cell each "exact spherical series" or "planar"), `compare.cjs`, `decompose.cjs`, `estimate.cjs` and `tables.cjs` compare it with the runs.

## The faces

The thickest-buffer particle on 12 cells (`faces.cjs ... all`), the resistance OFFBEAT's cells imply against three formulas:

| Face | against FEED's exact series | against planar series | against linear-k planar |
|---|---|---|---|
| inside the kernel, face 0 | +20.6 % | +0.015 % | +0.015 % |
| inside the kernel, face 10 | +0.07 % | -0.001 % | -0.001 % |
| **kernel to buffer** (face 11) | **-17.0 %** | -17.4 % | **0.000 %** |
| inside the buffer | +0.006 to +0.013 % | within 0.001 % | within 0.001 % |
| **buffer to carbon, with the gap** (face 23) | -0.80 % | **+0.001 %** | +96.3 % |
| inner carbon to SiC (face 35) | -34.0 % | -33.9 % | **-0.036 %** |
| SiC to outer carbon (face 47) | -29.4 % | -29.5 % | **+0.013 %** |
| inside the other layers | within 0.13 % | within 0.13 % | within 0.13 % |

(The residuals of 0.01 to 0.13 % inside the thin layers are the 8-digit output: the drop across one face there is 0.003 to 0.01 K.) So: inside a region OFFBEAT's conductance is the planar one (it differs from the exact shell's by the second order: 20 % at the first cell of the kernel, where the shell is not thin, 0.07 % ten cells out); at an interface it is the planar one with the linearly interpolated conductivity; at the gap it is the planar half cells in series with the gap. The same reconstruction on the pebble goldens (`pebble-face.cjs tests/golden/offbeat-pebble-coarse`) gives, at the fuelled-to-shell face, linear-k to 0.001 %, and a shift `Q (R_eff - R_exact)` of -0.4746 K (T4's estimate 0.47 K, the largest cell deviation 0.488 K; the 0.013 K between them is made of the second-order planar-versus-exact terms of the other faces, which were not separated for the pebble); on 160 + 40 cells -0.1179 K (measured 0.122 K). **It is the same mechanism in the pebble and in the particle.** The earlier script differed on the gap face: its "openfoam" scheme interpolated the conductivity there too, and that face has a 7.5 times jump (buffer 0.5, inner carbon 4 W/m/K), which the real scheme never sees.

## The replica

A chain solution with the interior faces planar, the interfaces linear-k planar, the gap planar-in-series plus the gap, and the outside half cell planar reproduces every cell:

| largest abs. difference OFFBEAT minus replica, K | 6 cells | 12 | 24 | 48 | 96 | 192 |
|---|---|---|---|---|---|---|
| five particles, all | 4.7e-6 to 5.0e-6 | 4.9e-6 to 5.0e-6 | 4.8e-6 to 5.0e-6 | 5.0e-6 | 5.0e-6 | 5.0e-6 to 5.1e-6 |

5e-6 K is half a unit in the last place of a 1000 K temperature written with 8 digits. (Brief's target: 0.01 K or 5 % of the deviation. Met by three orders of magnitude.)

## What moves the cells

Largest `|OFFBEAT - FEED FV|` over the cells (K), the quantity `crossCheckFv` reports:

| particle | 6 cells | 12 | 24 | 48 | 96 | 192 |
|---|---|---|---|---|---|---|
| coldest | 0.1525 | 0.0436 | 0.0137 | 0.0048 | 0.0019 | 0.0008 |
| hottest | 0.2399 | 0.0846 | 0.0335 | 0.0146 | 0.0068 | 0.0032 |
| median | 0.2798 | 0.1047 | 0.0436 | 0.0196 | 0.0093 | 0.0045 |
| thickest buffer | 0.4360 | 0.1878 | 0.0864 | 0.0413 | 0.0202 | 0.0100 |
| thinnest SiC | 0.3839 | 0.1567 | 0.0696 | 0.0326 | 0.0158 | 0.0078 |

The sign is OFFBEAT colder than FEED in the kernel everywhere (the whole kernel shifted by one constant, since the heat leaves it through the one interface). The deviation falls as the first power of the cell width with a curvature part on top that fades (ratio 2.2 from 12 to 24 cells, 2.1 from 24 to 48, 2.05 from 48 to 96). At 12 cells the kernel centre is 0.029, 0.069, 0.089, 0.173 and 0.140 K colder (coldest, hottest, median, thickest buffer, thinnest SiC), the largest deviation anywhere being a little more (0.044, 0.085, 0.105, 0.188, 0.157 K).

Each part of OFFBEAT's scheme switched on alone, on top of FEED's series (`decompose.cjs`), largest deviation at 12 cells: **the interfaces 0.041, 0.081, 0.101, 0.184, 0.153 K**; the planar interior 0.015 to 0.018 K; the planar gap 0.004 to 0.005 K; the planar outside half cell 0.0000 K. At 48 cells the interfaces are 0.0047 to 0.0324 K, the interior 0.0013 to 0.0015 K, the gap 0.0002 to 0.0003 K. So the **interfaces make the deviation**, and the interior and the gap are second order and small (they are already inside the check's 0.3 % of the rise).

**Why it is not proportional to P x the buffer's cell width.** The shift at an interface is `P x ((d1 + d2) / k_face - d1 / k1 - d2 / k2) / A`, with `d1`, `d2` the distances from the two cell centroids to the face and `k_face = (k1 d2 + k2 d1) / (d1 + d2)`. Written out it is `(k1 - k2)(d1^2 / k1 - d2^2 / k2) / (k1 k2 (d1/k1 + d2/k2) A)` times `P`: a **difference of two quadratic terms**, one from each side, so it depends on both cell widths and changes sign where the two terms are equal, `d2 / d1` close to `sqrt(k2 / k1)` = 0.41 for the kernel 3 and the buffer 0.5 W/m/K (the centroids shift the exact point a little: evaluated with the real centroids, for a 20.8 um kernel cell the shift is zero at a buffer cell of 8.17 um). The coldest particle (8.31 um) sits just above the zero and has the smallest shift; the shift grows nearly linearly with the buffer's cell width above it (-0.5, -1.3, -2.0, -2.7, -3.4 in arbitrary units at 8.5, 9, 9.5, 10, 10.5 um); that is the "function that starts near 8 um". P (5.6e-2 to 6.6e-2 W) enters only as a factor of about 1.2.

| particle (12 cells) | P (W) | kernel cell (um) | buffer cell (um) | rise (K) | kernel centre, OFFBEAT - FEED (K) | estimate (K) |
|---|---|---|---|---|---|---|
| coldest | 5.620e-2 | 20.30 | 8.31 | 14.56 | -0.0291 | 0.0408 |
| hottest | 6.173e-2 | 20.13 | 8.62 | 16.47 | -0.0686 | 0.0825 |
| median | 6.351e-2 | 20.53 | 8.99 | 16.82 | -0.0885 | 0.1031 |
| thickest buffer | 5.993e-2 | 20.94 | 10.29 | 16.41 | -0.1729 | 0.1894 |
| thinnest SiC | 6.644e-2 | 20.78 | 9.62 | 17.81 | -0.1400 | 0.1566 |

(The estimate is the sum of the absolute shifts at the three interfaces; the kernel-to-buffer one is nearly all of it, the other two are 0.003 to 0.005 K each at 12 cells.)

## The estimate and what it covers

The estimate of the largest deviation is the sum, over the interfaces that are not the gap, of the absolute shift above (`trisoInterfaceAllowance` in `src/core/trisoResults.ts`). Measured largest deviation divided by the estimate, over all 30 runs:

| particle | 6 cells | 12 | 24 | 48 | 96 | 192 |
|---|---|---|---|---|---|---|
| coldest | 1.071 | 1.068 | 1.056 | 1.039 | 1.027 | 1.019 |
| hottest | 1.031 | 1.025 | 1.016 | 1.010 | 1.006 | 1.004 |
| median | 1.019 | 1.015 | 1.010 | 1.006 | 1.003 | 1.002 |
| thickest buffer | 0.983 | 0.992 | 0.996 | 0.998 | 0.999 | 1.000 |
| thinnest SiC | 0.998 | 1.001 | 1.001 | 1.001 | 1.000 | 1.001 |

0.983 to 1.071. The estimate is therefore a predictor of the deviation, to 7 % on this family; on T3's seven saved particles (12 cells, a 10 to 49 K rise, the generic particle with 16 cells in the SiC, a two-layer one and one with a temperature-dependent conductivity; the conductivities at the closed-form temperatures of the face) it is 1.13, 1.22 and 0.53 times (the temperature-dependent one) the estimate, where the second-order interior term is a larger part of a smaller total. With the check's own bound added (0.3 % of the rise, at least 0.02 K: 0.044 to 0.054 K) and a safety factor of 1.25 on the estimate, the largest ratio of a measured deviation to the new bound is 0.72 at 6 cells, 0.66 at 12, 0.55 at 24, 0.41 at 48, 0.27 at 96 and 0.16 at 192 (the smallest 0.69, 0.46, 0.23, 0.10, 0.04, 0.02).

## The decision

The mechanism is explained, so (a) of the brief applies: **FEED's finite volumes are not changed** (they are the independent method: the exact shells). `crossCheckFv` keeps its bound (0.3 % of the rise, at least 0.02 K) and adds the interface allowance, 1.25 times the estimate, stated in the check's note with the shift at each interface. The `closedForm<Region>` checks get the part of the allowance of the interfaces outside the region (the heat crosses every face from the kernel outward, so an interface moves the cells inside it, not those outside): the thickest-buffer particle's `closedFormKernel` on 12 cells was 0.1933 K against a bound of 0.192 K, which the first coarse run showed; it was failing for the same reason. No tolerance of an existing check is widened for anything but the interface term, and the term is zero for a particle whose neighbouring regions have one conductivity.

What the allowance costs: on 12 cells the cross-check now accepts a deviation of up to 0.095 K (coldest) to 0.29 K (thickest buffer), 0.6 to 1.7 % of the rise. A wrong power is found by `energyBalance` at 0.5 % whatever the mesh; a power 5 % high, or two layers' conductivities swapped, still fails `crossCheckFv` (tests/trisoInterface.test.ts). The allowance falls with the cell width: 0.05 to 0.24 K on 12 cells, 0.006 to 0.052 K on 48, 0.002 to 0.025 K on 96.

**Mesh guidance.** The default of 12 cells per region is fine for the particle's own checks, and for the cross-check once the allowance is in; it is **not** a mesh on which OFFBEAT is the same discretisation as FEED's finite volumes: across the kernel and the buffer it differs by up to 0.19 K of a 16 K rise. Where OFFBEAT's temperatures are used for a quantity that matters to 0.1 K or better (a kernel peak against a limit, a population), use 48 cells (deviation 0.005 to 0.04 K) or let FEED's own solution carry the number. The pebble keeps its `W_MESH_INTERFACE` warning; no validator warning is added for the particle (the allowance makes the check pass and states why), and the editor's default is unchanged.

## Not done and open

- The transient particle's `crossCheckFv` (`trisoTransientResults.ts`) has a different bound (3 times the independent solution's own change when its cells are halved, at most 0.5 % of the peak rise, plus 0.02 K) and was not touched; the saved transient goldens pass. The same scheme applies to a transient, the interface part of the deviation depends on the heat flux through the face at that time, and was not measured.
- T0's observation that the buffer deviates by up to 0.076 K from the closed form on a four times finer mesh without shrinking (docs/spike/triso-probe.md) is a different mesh and a constant-conductivity closed form; the scheme above does not obviously explain a non-vanishing term and it was not re-examined.
- The pebble's `crossCheckFv` has no allowance (a warning instead); the face scheme is the same, so an allowance could be added there on the same terms.
