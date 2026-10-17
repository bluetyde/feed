# Plan 15, B0: a two-dimensional (r, z) reference against the saved OFFBEAT stack runs

Done 2026-10-16 for [plan 15](../plans/15-axial-2d.md), milestone B0, on branch `claude/axial-2d-b0` (from main 2dcb541). **Verdict: gate met.** On every saved stack run, steady and transient, the (r, z) finite-volume solution is within the mesh bound of the existing checks, with the plan's own choice of kernel (FEED's radial kernel plus the conduction along the height). On the plate it equals OFFBEAT to the printed digits. The difference that remains for a pin is a radial mesh effect that the one-dimensional reference has too, not a difference in the axial model. Nothing under `src/` was changed: the probe is throw-away code in [axial-2d-probe/](axial-2d-probe/) that reads the compiled helpers in `dist/core` (run `npm run build` first). One condition for B1 and B2 is stated at the end (the gain at the TRIGA length for a pin is small and the pin's negative test cannot work as the plan wrote it).

## 1. What OFFBEAT does (read in the feed-solver distro, OFFBEAT `80e84450`; read only, nothing copied)

Paths are under `~/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib/` of the `feed` user.

| Question | What the source says | Where |
|---|---|---|
| The equation | `fvm::ddt(rhoCp, T) - fvm::laplacian(k, T) == Q`, with `k` the material's conductivity field; one equation for the whole (r, z) mesh, so the layers are ordinary neighbours | `physicsSubSolvers/thermalSubSolver/solidConductionSolver.C` 105-111 |
| Face conductivity across cells (radial and axial) | `laplacianSchemes Gauss linear corrected`, `interpolationSchemes linear`, `ddtSchemes Euler`, written by FEED's own writer. A conductivity field interpolated linearly on the faces, the face gradient `(T_N - T_P) / |d|` with `d` the vector between the two cell centres (the volume centroids of the wedge cells), the face area as the area of the wedge face. **That is a linear conductance `k A_face / |d|` for a cylinder too, not the logarithmic one.** In the cell columns the centres lie on the mid-plane, so the mesh is orthogonal and the "corrected" term is zero | `src/core/caseWriter.ts` 537-543 (the settings); OpenFOAM's standard `Gauss linear` (not read here) |
| Layers of the same solid | no special handling: layer k and k+1 are two cells with a plain face between them; with the same material on both sides the face conductivity is that material's (a temperature-dependent one is interpolated linearly with the geometric weights, which for equal cells is the arithmetic mean) | same equation |
| The gap | `resistiveGap` on `fuelOuter` and `cladInner` (a coupled patch pair): the flux coefficient is `alphaEff = 1 / (1/alphaP + 1/alphaN + 1/alpha_gap)` with `alphaP = k / delta` of the cell on each side (delta the normal distance from the cell centroid to the face) and `alpha_gap` the case's stated conductance. Face k of one patch pairs with face k of the other, so each layer has its own gap. Which face area it acts on is not visible in this file; the probe decides it (below): the **fuel** face | `fvPatchFields/temperatureCoupled/resistiveGapFvPatchScalarField.C` 40-72 |
| The coolant | `convectiveHTC` and `timeDependentAxialProfileHTC`: `alpha = k deltaCoeffs / (k deltaCoeffs + h)`, wall value `alpha T_cell + (1 - alpha) T0`, so the half cell (linear) in series with the film. The axial profile table is read at the **centre of the patch face** (`Cf().z()`), that is the layer centre; heights in metres | `fvPatchFields/convectiveHTC/convectiveHTCFvPatchScalarField.C` 175-197; `.../timeDependentAxialProfileHTCfvPatchScalarField.C` 169-241 (z at 209) |
| The power shape | `Q_i = Qavg f_r g_z h_theta`, `Qavg = lhgr (zMax - zMin) angularFraction / refVolume`, with `g_z` the normalised table (integral over 0 to 1 must be 1 to 1e-4) **evaluated at the cell centre**: `z = (C.axialDirection - zMin) / (zMax - zMin)`. A layer's source is therefore uniform in z at the shape's value at the layer centre (not the layer average). The total is checked against `lhgr x length x sum(g_z V)/refVol` and rescaled only if it differs by more than 0.01 %, which a flat radial profile never does | `heatSource/timeDependentLhgr.C` 134-157, 163-194; `profiles/axialProfile/constantTabulatedAxialProfile.C` 72-112; `profiles/axialProfile/axialProfile.C` 109-131 |
| The end faces | `empty` patches (no flux), which is what the writer gives them | `src/core/caseWriter.ts` (A0 found `empty` and `patch zeroGradient` identical) |

So, in words: OFFBEAT's axial discretisation is the simplest one. Two cells of the same solid are joined by `k A / h`, the ends carry nothing, each layer is heated at the shape's centre value and cooled by the table's centre value. The plan's description of the new kernel ("two half cells in series", insulated ends, one gap and one coolant per layer) is the same thing. The only difference of any size is **radial**: OFFBEAT uses centroid nodes and a linear conductance, FEED's kernel (`transientFv.ts`) uses cell-middle nodes and the logarithmic one for a cylinder. For a slab the two are identical.

## 2. The probe

[axial-2d-probe/](axial-2d-probe/), all plain Node (`.cjs`), no dependency, run from the repo root after `npm run build`:

| File | What it is |
|---|---|
| `axial2d.cjs` | The solver. Cells (layer k, radial i); implicit Euler with the source and the boundary at the new time, as `transientFv` and OFFBEAT do; Picard on k(T) and c(T) in the enthalpy form; a banded direct solve (half bandwidth = cells of one layer, no pivoting: the matrix is an M-matrix); axial conduction `2 kL kU A / (h (kL + kU))` (two half cells in series; `arith` option for the arithmetic mean). Option `radial: "feed"` is `transientFv`'s kernel (and with `axial: false` it equals `steadyFv` to 1.5e-11 K), `radial: "offbeat"` is the scheme read in section 1 (centroid nodes, linear conductance, the gap and the half cells in series with `k / delta`). |
| `golden.cjs` | Reads the saved OFFBEAT runs layer by layer (the same block order as `stackResults.ts`). |
| `run-steady.cjs`, `run-transient.cjs` | The cell-by-cell comparison with every saved run (section 3). |
| `run-variants.cjs`, `negative.cjs`, `hybrid.cjs`, `pin-lengths.cjs` | The variants, the negative tests, an option for the pin, the pin at the other two A0 lengths. |
| `tests.cjs` | The reduction, conservation and the exact solution (section 4). |
| `bench.cjs` | The cost (section 6). |
| `results/*.txt` | The output of each script as run (the transient run took about 80 s, the rest seconds). |

The inputs are the `normalized.json` that each golden folder already holds (the case the run was made from), so nothing was re-run in OFFBEAT: every saved run has the full field (steady: `T`, `C`; transient: `times/<t>/T`, `C`). The transient start is the one the run had (every slice at its own one-dimensional steady state, which is the field the writer gave OFFBEAT), not the coupled steady state.

## 3. Against the saved runs, cell by cell

Columns: **OF** = the saved OFFBEAT field. **2D** = the probe with FEED's kernel (the plan's choice). **1D** = the same kernel with the axial term removed (the existing finite-volume reference). The **gate ratio** is the largest, over the layers, of `max |OF - 2D|` over the layer's cells divided by the existing mesh bound of that layer, with no allowance for the axial conduction: for a steady run the closed-form check's `5 dT / N^2` (fuel `N = 20`, cladding `N = 6`), for a transient the cross-check's `min(3 x spatial, 0.5 % of the rise) + 0.02 K` as `buildTransientResults` computes it for that slice (by running it with a zero allowance). It must be below 1.

### Steady (12 runs; the pin was saved at 0.381 m and 0.06 m only, see 3.3)

| Run | Layers, length (m) | max / rms \|OF - 2D\| (K) | max / rms \|OF - 1D\| (K) | Gate ratio, 2D | Gate ratio, closed form with no allowance (the existing check) |
|---|---|---|---|---|---|
| pin cosine | 10, 0.381 | 3.44 / 1.01 | 3.79 / 1.18 | 0.34 | 0.63 |
| pin, coolant warming (rise) | 10, 0.381 | 3.44 / 1.01 | 3.79 / 1.18 | 0.34 | 0.66 |
| pin short | 12, 0.06 | 3.38 / 0.99 | 44.4 / 14.2 | 0.49 | 32.9 |
| plate cosine (= len0.381) | 10, 0.381 | 0.000 / 0.000 | 0.61 / 0.21 | 0.00 | 1.50 |
| plate len0.19 | 10, 0.19 | 0.000 / 0.000 | 2.39 / 0.82 | 0.00 | 5.75 |
| plate len0.762 | 10, 0.762 | 0.000 / 0.000 | 0.15 / 0.05 | 0.00 | 0.41 |
| plate ramp | 10, 0.381 | 0.000 / 0.000 | 0.10 / 0.03 | 0.00 | 0.15 |
| plate negative (table + warming coolant) | 10, 0.381 | 0.000 / 0.000 | 0.15 / 0.05 | 0.00 | 0.19 |
| plate rise | 10, 0.381 | 0.000 / 0.000 | 0.69 / 0.21 | 0.00 | 1.70 |
| plate short | 12, 0.06 | 0.000 / 0.000 | 22.4 / 7.2 | 0.00 | 63.9 |
| plate steep (table, sharp ends) | 20, 0.381 | 0.000 / 0.000 | 1.90 / 0.50 | 0.00 | 2.23 |

(`results/steady.txt` holds per-run wall values and the existing check's numbers with its allowance; `results/hybrid.txt` the last column.) The "0.000" are below the printing digits of OFFBEAT's output (8 significant digits); the plate's kernel is the same scheme as OFFBEAT's (slab: midpoint = centroid, linear conductance), so the two agree to the precision of the saved fields. For the plate the existing check with no allowance exceeds its bound (ratios above 1) in the cases where the axial conduction is more than a mesh effect: that is the effect the allowance covers today.

**The pin's 3.4 K** is entirely radial. It sits in the fuel and grows towards the centre (3.44, 2.57, 2.21, ... 0.80 K from the centre cell outward, then 0.03 K in the cladding, layer 5 of the cosine). It is the same for the one-dimensional reference (3.79 K) and for every layer, so it is not a property of the axial coupling: FEED's kernel places the first node at r/2 and OFFBEAT reports it at the volume centroid 2r/3, and the conductances differ (log against linear). With OFFBEAT's own radial scheme the same code is within **0.0016 K** of OFFBEAT everywhere (max over all cells and walls of all 12 runs; that is OFFBEAT's own solver tolerance and 8-digit output), see 3.2.

### The effect the reference must reproduce (the plan's targets)

The effect is "OFFBEAT stack minus a one-layer solution of the same discretisation". For OFFBEAT that is what A0 measured with separate one-layer runs; here the one-layer OFFBEAT is the probe's decoupled OFFBEAT-kernel solution (which matches OFFBEAT to 0.0016 K). Fuel-centre cell, K:

| Case | End layer: OFFBEAT stack | End layer: FEED 2D minus FEED 1D | Peak layer: OFFBEAT stack | Peak layer: FEED 2D minus 1D | Plan's target |
|---|---|---|---|---|---|
| pin 0.381 m | +1.061 | +1.067 | -0.347 | -0.348 | +1.06 / -0.35 |
| plate 0.381 m | +0.609 | +0.609 | -0.199 | -0.199 | +0.61 / -0.20 |
| plate 0.19 m | +2.394 | +2.394 | -0.799 | -0.799 | |
| plate 0.762 m | +0.153 | +0.153 | -0.050 | -0.050 | |
| pin short 0.06 m (largest over all cells) | +44.83 | +45.05 | | | A2: 44.7 |
| plate short 0.06 m (largest over all cells) | +22.36 | +22.36 | | | A5: 22.4 |

The largest remaining difference in the **effect** itself (FEED 2D minus 1D against OFFBEAT stack minus the one-layer OFFBEAT, over all cells) is 0.006 K for the pin at 0.381 m, 0.215 K (0.5 % of 44.8 K) for the short pin, and 0.000 K for the plates.

### 3.1 Transient (12 runs, every write time, every cell and the outer wall)

The 2D start is each slice's own one-dimensional steady state, as in the run. "Existing 1D" is the cross-check's value for the worst slice and the range of its no-allowance bound over the slices (`crossCheckFv`, run with a zero allowance); "ratio 1D" its worst value/bound; "gate ratio" is for the 2D reference as defined above.

| Run | Layers, length, steps x step (s) | max \|OF - 2D\| / rms (K) | Existing 1D: worst value (K) / bound range (K) | Ratio 1D | Gate ratio, 2D | Axial effect, OFFBEAT / FEED 2D / difference (max, K) |
|---|---|---|---|---|---|---|
| pin asym | 10, 0.381, 1000 x 1e-4 | 1.02 / 0.13 | 1.02 / 3.38-7.17 | 0.14 | 0.14 | 0.006 / 0.006 / 0.000 |
| pin coastdown | 10, 0.381, 1200 x 0.05 | 2.74 / 0.26 | 2.97 / 0.93-5.74 | 0.52 | 0.48 | 0.693 / 0.696 / 0.003 |
| pin pulse | 10, 0.381, 1000 x 1e-4 | 1.16 / 0.14 | 1.17 / 1.31-8.18 | 0.14 | 0.14 | 0.033 / 0.033 / 0.001 |
| pin short pulse | 12, 0.06, 1000 x 1e-4 | 1.16 / 0.14 | 1.60 / 1.11-8.21 | 1.45 | 0.14 | 1.628 / 1.629 / 0.001 |
| pin shortcool | 12, 0.06, 1200 x 0.05 | 2.72 / 0.26 | 30.7 / 0.87-5.75 | 35.2 | 0.54 | 31.03 / 31.14 / 0.123 |
| plate asym | 10, 0.381, 1000 x 1e-4 | 0.000 / 0.000 | 0.000 / 0.09-0.18 | 0.00 | 0.00 | 0.000 / 0.000 / 0.000 |
| plate loss of cooling (60 s) | 10, 0.381, 1200 x 0.05 | 0.000 / 0.000 | 5.57 / 0.07-0.33 | 81.9 | 0.00 | 5.572 / 5.572 / 0.000 |
| plate loss of cooling, **exchange limit** (20 slices, 100 s) | 20, 0.2, 1000 x 0.1 | 0.009 / 0.003 | 64.9 / 0.04-0.33 | 1475 | 0.05 | 64.88 / 64.88 / 0.009 |
| plate loss of cooling, long (200 s) | 10, 0.381, 2000 x 0.1 | 0.008 / 0.003 | 64.4 / 0.07-0.33 | 947 | 0.03 | 64.37 / 64.37 / 0.008 |
| plate loss of cooling, short (0.1 m, 60 s) | 10, 0.1, 600 x 0.1 | 0.004 / 0.001 | 61.7 / 0.07-0.33 | 908 | 0.02 | 61.73 / 61.73 / 0.004 |
| plate pulse | 10, 0.381, 1000 x 1e-4 | 0.000 / 0.000 | 0.001 / 0.05-0.20 | 0.02 | 0.00 | 0.001 / 0.001 / 0.000 |
| plate short pulse | 12, 0.06, 1000 x 1e-4 | 0.000 / 0.000 | 0.036 / 0.04-0.20 | 0.82 | 0.00 | 0.036 / 0.036 / 0.000 |

(`results/transient.txt`.) The loss-of-cooling runs are the ones the one-dimensional reference cannot follow: 61 to 65 K away after 60 to 200 s, a hundred to a thousand times its bound. The 2D reference follows them to 0.004 to 0.009 K (the non-zero values are within the 8 significant digits of the saved fields at the thousands of kelvin these runs reach). The exchange-limit run that fails every check today (a 0.2 m plate, 20 slices, 100 s) passes with a gate ratio of 0.05. The pin's remaining 1.0 to 2.7 K is the radial kernel offset of the previous section again (it is the same in the one-dimensional reference: the first two rows have equal 2D and 1D values because the axial effect there is 0.006 K). The pin coastdown that carries a bound of 10.7 K today (exchange allowance) has a 2D difference of 2.74 K against a no-allowance per-slice bound of 0.93 to 5.74 K, every slice inside its own bound. The 2D energy balance (deposited = stored + rejected) closes to 5e-12 or better on all twelve.

### 3.2 Which choice matches OFFBEAT (the variants; `results/variants.txt`)

Max \|variant - OFFBEAT\| over all cells and walls, K:

| Variant | pin cosine | pin short | plate steep | plate short |
|---|---|---|---|---|
| OFFBEAT's scheme (centroid nodes, linear conductance, gap on the fuel face, arithmetic face k, power at the layer centre) | 0.0016 | 0.0016 | 0.0000 | 0.0000 |
| the same with the harmonic face k | 0.0016 | 0.0016 | 0.0000 | 0.0000 |
| the same with the gap conductance acting on the cladding face | **5.47** | 5.40 | 0.0000 | 0.0000 |
| the same with the layer-average power instead of the centre value | **5.26** | 3.39 | 0.0009 | **0.846** |
| the same with no axial term | 1.06 | 44.8 | 1.90 | 22.4 |
| FEED's kernel (the plan's), harmonic or arithmetic | 3.44 | 3.38 | 0.0000 | 0.0000 |

So: the **power is sampled at the layer centre**, the **gap acts on the fuel face** (this is what FEED's kernel already does), and the **axial term is needed**. The arithmetic against harmonic face conductivity cannot be decided from the saved runs: all of them have constant conductivities, and with a conductivity that varies with temperature the two differ by 0.004 K (pin 0.381 m), 0.08 K (pin 0.06 m) and 0.0002 K (plate) of a rise near 1400 K or 200 K (a made-up linear k(T), no OFFBEAT run exists for it). That is below any bound in use; B1 can take the plan's "two half cells in series" (harmonic), and a stack with k(T) run in OFFBEAT would settle it if the owner wants it settled (not done: the brief says not to re-run OFFBEAT).

### 3.3 The pin at the other two A0 lengths

Only 0.381 m and the short 0.06 m pin are saved, so 0.19 m and 0.762 m were not compared with a field. The probe's effect (coupled minus decoupled, fuel centre) against the numbers A0 recorded from the real solver: 0.19 m **+4.246 / -1.397** against +4.23 / -1.39; 0.381 m +1.067 / -0.348 against +1.06 / -0.35; 0.762 m +0.267 / -0.087 against +0.27 / -0.087 (with OFFBEAT's own scheme: 4.225 / -1.390, 1.061 / -0.346, 0.266 / -0.086). The 1/L^2 scaling holds. If the owner wants these two lengths compared cell by cell, two OFFBEAT runs through the run manager would do it; they were not made.

## 4. The plan's cheap tests (`tests.cjs`, `results/tests.txt`)

| Test | Result |
|---|---|
| **Reduction**: identical layers, flat shape, uniform coolant = N copies of the one-dimensional solution (limit 1e-10 K) | steady pin 4.9e-11, steady plate 4.1e-11, steady pin with k(T) 7.3e-11, transient pin coastdown with k(T) and c(T) (400 steps) 1.7e-11: pass. **Steady plate with k(T): 1.27e-10: not passed.** The cause is the arithmetic floor of an unpivoted double-precision banded solve at temperatures near 1700 K (the constant-k cases are already at 4e-11, a few hundred times the spacing of doubles there), plus the Picard stop at 2e-11 K; tightening the stop only makes the Picard loop fail to settle. The plan's 1e-10 K absolute is at that floor: B1 should state it as 1e-9 K absolute (or 1e-12 relative). One step of iterative refinement (an option in the solver) brought the constant-k cases to 1.6e-11 and 2.7e-11 and did not remove the floor. |
| **Conservation** (limit 1e-9), steady and transient, k(T) and c(T) included | 3e-14 to 9e-12 in all ten (steady pin cosine and short, plate steep, with k(T); transient pin coastdown, short pulse, plate loss of cooling, plate pulse): pass. The twelve transient comparison runs close to 5e-12 or better as well. |
| **Exact solution**, a plate with a fixed wall, insulated ends, source `q0 cos(pi z / H)` (H = 20 mm, half thickness 8 mm in two equal materials with a gap of 1e13 W/m2/K, so the interface is a plain face; lambda X = 0.63; the 1D solution is 854 K off) | the maximum error over all cells with 4, 8, 16, 32, 64 cells by layers: 35.2, 9.32, 2.36, 0.593, 0.148 K, ratios **3.78, 3.94, 3.99, 4.00**: second order; the N one-dimensional solutions stay 805 to 854 K off (the cosine changes sign, so the amplitude is the point of the test). The finest error is 1.2e-4 of the 1279 K rise. **My first absolute limit for it (1e-3 K) was a slip in scale and I dropped it; the criterion is the order, as the plan says, and that passes.** |
| **The same in time** (implicit Euler, 32 x 64 cells, t = 10 s, series solution with 4000 terms) | errors for 5, 10, 20, 40, 80, 160 steps: 24.0, 12.4, 6.34, 3.20, 1.61, 0.80 K, ratios **1.93, 1.96, 1.98, 1.99, 2.00**: first order, as implicit Euler is; the energy balance closes to 1e-12; the N one-dimensional solutions are 70 K off at 160 steps against 0.80 K. |

## 5. Negative tests, and an option for the pin (`negative.cjs`, `hybrid.cjs`)

Perturb the reference and compare with the saved OFFBEAT field; the gate ratio must go above 1 (`results/negative.txt`):

| Run | Reference as planned | Axial term removed | Shape shifted by one layer | Coolant read from the top |
|---|---|---|---|---|
| pin cosine 0.381 m | 0.34 | **0.45** (not caught) | 211 | 0.34 (uniform coolant: nothing to read) |
| pin short 0.06 m | 0.49 | 32.6 | 211 | |
| pin rise (warming) | 0.34 | **0.47** (not caught) | 211 | 97 |
| plate cosine 0.381 m | 0.00 | 1.45 | 212 | |
| plate short | 0.00 | 63.8 | 208 | |
| plate steep | 0.00 | 2.18 | 81 | |
| plate rise | 0.00 | 1.65 | 212 | 347 |
| plate negative | 0.00 | **0.14** (not caught: the effect there is 0.15 K) | 59 | 80 |

**A finding for B2.** The plan's negative test "the axial term removed must fail a check" is true for the plates (all but the 0.15 K case) and for the short pin, and **false for the pin at TRIGA length with the mesh bound**: the effect (1.06 K) is a third of the radial offset of FEED's kernel (3.44 K) and a tenth of the bound (10.3 K). A pin of that length gains nothing in detection from the 2D reference as built; what it gains is the removal of the allowance (3.4 K for the cosine, 136 K for the short pin).

**An option** (`hybrid.cjs`): the exact closed form of each slice at OFFBEAT's reported cell centres, plus the finite-volume axial effect (2D minus 1D in FEED's kernel, in which the kernel's own radial mesh error cancels): `T_ref = T_closed(slice, r_centroid) + (T_2D - T_1D)`. Its largest difference from OFFBEAT is 0.71 K for the pin (cosine and rise), 0.64 K (short), 0.13 K for the plates (the plate's plain 2D is exact, 0.000 K, so the plate should not use the hybrid); gate ratios 0.07 to 0.23. For the pin that is the mesh error of OFFBEAT's own first cells against the exact solution; it makes the 1.06 K effect visible against a 0.7 K floor, not clearly. The only reference with a floor far below the effect is one with OFFBEAT's own radial scheme (0.0016 K), and that is a copy of the solver's discretisation, so it would stop being an independent method for the pin. Which of the three (FEED's kernel with the mesh bound, the hybrid, OFFBEAT's radial scheme) the pin should use is a design choice for the owner at B1.

## 6. Cost (`bench.cjs`, `results/bench.txt`; CPU seconds, unoptimised probe code, shared machine at 30 to 45 % load from other programs)

The largest case the validator's work budget lets through is cells x steps x slices = 3e6: 50 slices x 26 cells = 1300 unknowns x 2300 steps.

| Case | Constant properties | k(T), c(T) (Picard) |
|---|---|---|
| typical stack: 10 slices, 1200 steps (0.31e6) | 0.4 s | 1.4 s |
| largest: 50 slices, 2300 steps (2.99e6) | **3.0 to 3.8 s** | **11 to 22 s** (two runs; machine load) |
| doubled radial mesh (52 cells per layer), 50 slices, 575 steps | | 24 to 39 s (so 95 to 155 s for 2300 steps) |
| halved step, 50 slices, 1150 steps | | 6 to 8 s (so 25 to 34 s for the 4600 steps the halved step of a 2300-step run needs) |

The one-dimensional checks run the same-mesh solution, the doubled-mesh solution and the half-step solution (`computeIndependent`). For the (r, z) reference that triple costs about 130 to 210 s on the largest case with k(T), which is too long for a worker's deadline: B4 should run the (r, z) solution once on the writer's mesh and take the spatial and time error from the cheap one-dimensional slice runs (or from a coarser stack). The probe assembles and allocates the banded matrix at every iteration of every step and calls the property laws for every cell; an assembly that reuses buffers, factors once for a constant-property run with a constant boundary and skips the Picard iteration that only confirms a linear problem would be several times faster. That is not measured.

## 7. What this does not cover

- Every saved run has constant conductivity and constant heat capacity (fuel k 3, cladding 15 W/m/K; c = 3.0 and 2.5 MJ/m3/K) and one gap conductance. The solver's k(T) and c(T) paths are tested by the reduction, conservation and the exact solution (the last two with constants), and by the variants above, but **not against an OFFBEAT run with temperature-dependent properties**. The face-k weighting, the conductivity at the layer interfaces and the burnup/UO2 laws are therefore untested against the solver.
- One mesh (20 fuel cells, 6 cladding cells), one fuel and cladding geometry, two lengths for the pin. A hollow pin (central hole), a prescribed wall (`surface-temperature`) stack and a stack with an axial coolant table together with a transient are not among the saved runs (the plate and pin `rise` runs have a table at steady state; a prescribed-wall stack was not saved).
- The transient comparisons start from the run's own per-slice steady state, so the **coupled steady start** the plan wants for B3 (to remove A3's limitation) was not compared with OFFBEAT; the 2D solution would give it, but OFFBEAT was never started from it.
- The mechanics, burnup, point-kinetics and particle parts are outside the plan.

## 8. Verdict and what B1 would build

**Gate met**, with this reading of "the mesh bound": steady, the closed-form check's `5 dT / N^2` per solid per layer; transient, the cross-check's bound with no allowance. The worst gate ratio over all 24 runs is 0.54 (pin shortcool). The difference between the (r, z) reference and OFFBEAT is **not** a difference in the model: with OFFBEAT's radial scheme the same axial code reproduces OFFBEAT to its solver tolerance (0.0016 K, pin; 0.000 K, plate), and with FEED's kernel it reproduces the effect of the axial conduction to 0.006 K (pin 0.381 m), 0.2 K of 45 K (short pin) and 0.009 K of 65 K (the plate that loses its cooling). It is not a mesh effect of the axial direction either: the axial discretisation is exactly OFFBEAT's, and the layers' heights are the same by construction.

B1 would build `src/core/axialFv.ts` as the probe's `axial2d.cjs` in TypeScript, in FEED's idiom (the kernel of `transientFv.ts` and `geometry.ts`; no copy of OFFBEAT's code, only the scheme in section 1, which is the simplest one) with: the banded solver; the power at the layer centre and the coolant at the layer centre (as `sliceLoads` already gives them); the gap on the fuel face; harmonic face conductivity; Picard with an absolute stop of 1e-11 K and an iteration cap; the reduction tested to 1e-9 K absolute (not 1e-10, section 4); conservation to 1e-9; the exact cosine solution by its observed second-order ratios and a limit on the ratio, not on the absolute error; and a decision recorded for the pin's radial reference (section 5). B2's negative test for "the axial term removed" must be written per geometry: it fails on every plate (but one at 0.15 K) and on short pins, and cannot on the 0.381 m pin unless the pin's bound is tightened to under 1 K.
