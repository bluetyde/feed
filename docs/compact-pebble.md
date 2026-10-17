# A compact and a pebble (plan 13, T4)

A TRISO compact is a cylinder of coated particles in a matrix. A pebble is a sphere with a fuelled zone of the same kind and an unfuelled graphite shell. FEED does not mesh every particle. It replaces the mix of particles and matrix by **one homogeneous solid** with an effective conductivity, runs that solid, and then goes back to the hottest particle with a second, small calculation. This page says how, how good the effective conductivity is, and what the results do and do not mean.

Thermal only and steady, like the rest of plan 13. A prismatic block (a compact in a graphite block with coolant channels) is not offered (decision D5). Mechanics, burnup, hot dimensions and a transient are refused by name.

## The two objects

**Compact.** A pin. The case is an ordinary pin case (`geometry` with `fuelRadius`, `claddingInnerRadius`, `claddingOuterRadius`, an optional `fuelInnerRadius` for a central hole, a `gap`, a `boundary`, `materials.cladding`, a `mesh`) with one extra top-level block, `compact`. The "fuel" is the compact; the "gap" is the gap between the compact and its holder; the "cladding" is the holder (a graphite sleeve). There is no `materials.fuel` and no `power`: both come from the `compact` block (giving them is refused, `E_UNSUPPORTED`). The pin's writer, results reader and checks run it unchanged.

**Pebble.** `geometry.kind: "pebble"` with `fuelledRadius` and `outerRadius`, `assumptions.geometry: "1D-sphere"`, the same `compact` block for the fuelled zone, `materials.shell`, a `boundary` (film and bulk temperature, or a wall temperature), `gap: {"model": "none"}` (the shell is bonded to the fuelled zone), `mesh: {fuelledCells, shellCells}`. It has its own normalised form (`pebble` on the validation result) and its own writer and results reader, because the particle's writer builds a gap between the buffer and the next layer and names its layers after the particle's. What is shared is the wedge mesh formulas (`src/core/trisoWedge.ts`), the sphere kernel (`SPHERE`), the finite-volume solution (`steadyTrisoFv` takes any number of regions and has no gap here) and the way the kernel is treated: **the fuelled zone is OFFBEAT's cell zone `Kernel`, the only zone with a heat source (`timeDependentVhgr`, `materials ( Kernel )`), and the shell is the zone `Shell`.** That is how the particle writer treats its kernel, so the reuse is sound; the regions in the results are called `fuelled` and `shell`.

### The `compact` block

```
"compact": {
  "particle": { "kernelRadius", "layers": [{name, thickness}...], "gap": {constant-conductance, as for a particle}, "materials": {kernel, buffer, ipyc, ...} },
  "matrix":   { a material with a thermal.conductivity set },
  "packingFraction": 35 %,          // the fraction of the volume the WHOLE particles fill
  "powerDensity": 30 W/cm3,         // of the whole compact (or of the pebble's fuelled zone)
  "validRange": {min, max},         // the temperatures the effective conductivity is tabulated over
  "fit": {"degree": 3, "tolerance": 0.5 %},
  "mixtureLaw": "maxwell-eucken",   // optional; the others are allowed with a warning
  "twoScale": {"at": ["hottest", "mean", 3 mm]}   // optional; default hottest and mean
}
```

Nothing is assumed: a missing range, fit, matrix or packing fraction is `E_PROP_MISSING` at its field. The conductivity of the matrix and of each particle region must be stated over the whole `validRange` (a law stated for a narrower range would be extrapolated: `E_OUT_OF_RANGE`).

The effective conductivity is tabulated (41 points over `validRange`) and carried by a fitted polynomial through the pin's own table reading, so the existing rules apply: the case states the degree and the largest deviation it accepts (`E_FIT` if the fit is further away), and OFFBEAT is given the cubic as a `ZyRELAP` conductivity. The fit's deviation is a check in every result.

### Power and the packing fraction

The compact's power density `q` (W/m3 of the whole compact) gives the pin's linear heat rate `q' = q x pi (R^2 - Ri^2)`. Each particle makes `q x V_particle / phi`, where `V_particle` is the volume of the **whole** particle (kernel to outer carbon) and `phi` the packing fraction; a cubic metre holds `phi / V_particle` particles, which together make `q` (a test checks this both ways, and that using the kernel's volume instead gives a power 6.2 times too small for the generic particle). The particle's power is the one the two-scale step uses.

## The mixture law: how good is it?

Two steps, each tested against a resolved model.

**Step 1, the particle as one sphere.** A layered particle (kernel, buffer, gap, inner carbon, silicon carbide, outer carbon) is replaced by a homogeneous sphere of the same size whose response to a uniform temperature gradient is the same. This is exact: in each region the gradient mode of the heat equation is `T = (A r + B / r^2) cos(theta)`; matching the temperature and the heat flux across each interface (a gap of conductance `h` is a temperature jump of flux / `h`) from the kernel outwards gives the ratio of flux to temperature at the outer face, and that ratio is the equivalent conductivity (`equivalentParticleConductivity` in `src/core/mixture.ts`). For one interface it is Hashin's coated sphere; the test writes it out by hand. The conductivity of every region is taken at the one temperature of the compact there (the particle's own rise, a few kelvin, is neglected in this step).

**Step 2, spheres in a matrix.** Three laws were written from their definitions: **Maxwell-Eucken** (Maxwell 1873), **Bruggeman's** symmetric effective-medium law and the **differential** effective-medium law (spheres added to the matrix a little at a time). Other published series (Jeffrey 1973, Chiew and Glandt 1983) were looked for but their formulas were not read from a source in this work, so they are not implemented or claimed.

**The resolved model** is `scripts/mixture-reference.cjs`: the periodic unit cell, a three-dimensional finite-volume solution (a cube with a macroscopic gradient imposed, the periodic fluctuation solved by conjugate gradients, harmonic-mean faces, cells at the sphere's surface sub-sampled 5 x 5 x 5), written for FEED and independent of every formula above. It was run on 32, 64 and 128 cells per side for simple cubic, body-centred and face-centred arrays and for random sequential additions of 30 spheres (seeds 1 and 2; the densest random arrangement reachable this way is about 0.38), at packing fractions 0.1 to 0.5 and particle-to-matrix ratios 0.05, 0.1, 0.3, 3, 10 and 100. It converges to first order in the cell size; the value used is extrapolated to zero cell size from the 64 and 128 grids, and the size of that correction is kept as the numerical uncertainty (at most 0.6 % for ratios up to 3 and packing fractions up to 0.4; up to 3.9 % at a ratio of 10; 36 % at 100, where the model is unresolved and is not used for any claim). The saved results are `tests/golden/mixture/resolved.json` (126 cases) and `layered.json` (8); the tests read them without running the script. The script was checked against Maxwell's result in the dilute limit and reproduces its own saved value.

**Error of each law against the resolved model** (worst of the arrangements at each point, law / resolved - 1, in percent; a negative number means the law is low):

Maxwell-Eucken

| ratio \ packing | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 |
|---|---|---|---|---|---|
| 0.05 | 0.3 | 0.7 | 1.1 | 1.5 | 5.1 |
| 0.1 | 0.3 | 0.6 | 0.8 | 1.2 | 3.7 |
| 0.3 | 0.1 | 0.2 | 0.2 | 0.4 | 1.0 |
| 3 | -0.2 | -0.3 | -0.7 | -0.5 | -1.5 |
| 10 | -1.0 | -1.8 | -4.3 | -3.4 | -9.7 |

Bruggeman: -22 % at (0.05, 0.5), -13 % at (0.05, 0.4), +33 % at (10, 0.4). Differential: -7.6 % at (0.05, 0.5), -5.0 % at (0.05, 0.4), +13 % at (10, 0.4). (The full tables are produced by the analysis in `tests/mixture.test.ts` from the data.)

**Choice: Maxwell-Eucken**, which has the smallest error everywhere. **Stated bound: 2 %** (measured at most 1.8 %) for particle-to-matrix ratios 0.05 to 3 up to a packing fraction of 0.4 (at most 1.5 % there) and ratios 3 to 10 up to 0.2. Beyond that the validator warns (`W_MIXTURE_RANGE`) and says why: above a packing fraction of 0.4 the error exceeds 2 % (5 % at 0.5), above a ratio of 3 and a packing fraction of 0.2 it reached 4.3 % (the resolved model is uncertain by 3.9 % there), below 0.05 and above 10 the law was not measured. The effective conductivity is still computed and the case runs; the bound simply does not apply. A different law is allowed by name and warned (`W_MIXTURE_LAW`).

**The equivalent-sphere step was tested too**, against layered spheres in the resolved model (a two-layer particle and the generic five-region particle, packing fractions 0.1 to 0.4): equivalent sphere + Maxwell-Eucken is within 0.2 % of the resolved value (0.6 % at 0.1, where the resolved value itself is uncertain by that much). Replacing the particle by its volume-weighted mean conductivity is 2.8 to 19 % off (packing fractions 0.2 to 0.4), and by the series conductivity of its shells 6 to 24 % off: this is why the exact replacement is used.

**What the resolved model does not cover.** Real compacts are random packings, with a spread of particle sizes, up to packing fractions of 0.4 and above; the model covers lattices and 30-sphere random cells up to about 0.38. The ratios of a real compact (a particle 4 to 6 times worse than a graphite matrix) lie inside the claim. The temperature dependence is not resolved: the law is applied at each temperature.

## The two-scale result

The compact (or pebble) result has a temperature field of the **homogeneous solid**. It does not contain the particles' own rise. For the hottest particle FEED solves the particle in closed form (`trisoClosedForm`, the particle's own solution) with the matrix at the solid's local temperature behind a **matrix shell**: the sphere that holds one particle's share of the volume has radius `r_p / phi^(1/3)`, and the matrix between the particle and that radius, with the matrix conductivity at the local temperature, is a thermal resistance `(1/r_p - 1/b) / (4 pi k_matrix)`, which is exactly a film at the particle's outer surface. The particle's outside temperature is the solid's temperature at the place asked for: the **hottest cell** (the centre, or the surface of a central hole), the **volume mean**, or a stated **radius**. The default is the first two. The result is labelled "Two-scale result" in the record and the pebble's CSV.

What this assumes, and what it leaves out: the temperature at the edge of the cell is the solid's local temperature (the solid is smooth over a particle); the matrix's conductivity is taken at that temperature (the shell's drop is 0.09 K for the example, so the neglected variation is tiny); particles do not touch (a packing fraction near the random close-packing limit has a shell only 16 % thicker than the particle); the heat path inside the matrix is spherically symmetric about each particle. It is a model of one particle in its cell, not a calculation of the matrix's field around neighbours.

The shell's drop and the kernel's rise are small against the compact's own drop in the examples (compact centre 905.9 K, hottest kernel 914.7 K).

## Checks

The compact is judged by the pin's checks (energy balance, closed form for fuel and holder, wall, property range, the fit, steady state) plus `twoScaleMatrix<i>` (the matrix temperature read from the solver's cells against the closed form of the same field, to the pin's discretisation bound 5 dT / N^2 + 0.01 K: a temperature read at the wrong radius or averaged the wrong way fails) and `mixtureDomain` (pass, or `na` with the reason outside the domain). The pebble is judged by the particle's checks (closed form per region, the cells against the independent finite-volume solution, energy balance through the shell, wall, property range, the fit, steady state) plus the two-scale checks.

### A finding about OFFBEAT

On the first pebble run the cells of the fuelled zone were 0.49 K colder than both independent solutions (of an 83 K rise), the cross-check failing its 0.3 % bound, while the shell agreed to 4 mK. The offset was the same for every fuelled cell. OFFBEAT interpolates the conductivity **linearly to the face** between the fuelled zone (11.5 W/m/K) and the shell (25 W/m/K); the exact scheme, and FEED's finite-volume solution, puts the two half-cells' resistances in series. Across a jump in conductivity the two differ by a term proportional to the cell width: the estimate `q'' x ((d1 + d2) / k_face - d1 / k1 - d2 / k2)` gives 0.47 K on 40 + 10 cells, and the runs gave 0.488 K; on 160 + 40 cells the estimate is 0.12 K and the runs 0.122 K (a quarter, as the width). No tolerance was changed. The example uses 160 + 40 cells, and the validator warns (`W_MESH_INTERFACE`) when its estimate exceeds the check's bound. The coarse run is kept as `tests/golden/offbeat-pebble-coarse`. A pin has the same effect between fuel and cladding but its gap resistance dominates the interface. The coated particle has the same effect at its kernel-buffer, inner-carbon-to-SiC and SiC-to-outer-carbon interfaces; plan 16 reconstructed OFFBEAT's face scheme (linear conductivity at an interface, the gap as two planar half cells in series with its conductance), which reproduces its cells to 5e-6 K, and the particle's cross-check now carries a stated allowance for it ([triso.md](triso.md), "The interface allowance"; [the probe](spike/triso-interface-probe.md), which also finds the pebble's 0.4746 K at the face).

## Examples

`examples/synthetic-compact-steady.json`: a 12 mm compact (30 W/cm3, 35 % packing) in a graphite holder, helium at 800 K and 2000 W/m2/K. `examples/synthetic-pebble-steady.json`: a 60 mm pebble with a 50 mm fuelled zone (8 W/cm3, 35 %), helium at 900 K and 400 W/m2/K. Both are labelled synthetic: the conductivities, the gaps and the film coefficients are FEED's own numbers (the particle's are those of `examples/synthetic-triso-compact-steady.json`, with the dimensions of OpenMC Studio's illustrative particle), not sourced properties. Real results are saved in `tests/golden/offbeat-compact`, `offbeat-pebble` and (for the hottest particle run as a particle behind its shell) `offbeat-two-scale`:

| | compact | pebble |
|---|---|---|
| effective conductivity at the mean (W/m/K) | 12.70 | 11.62 |
| particle / matrix ratio | 0.17 to 0.22 | 0.19 to 0.26 |
| hottest cell, solver (K) | 905.86 (closed form 905.87) | 1098.65 (OFFBEAT's face offset, 0.12 K) |
| hottest kernel, two-scale (K) | 914.69 | 1101.01 |
| mean, solver (K) / hottest kernel at the mean (K) | 895.23 / 904.06 | 1055.22 / 1057.58 |
| checks | all pass | all pass |

The compact's hottest particle was also run through OFFBEAT as a coated particle behind its matrix shell (the shell as a film of 1.41e5 W/m2/K at the compact's hottest temperature): kernel centre 914.67 K against the two-scale closed form's 914.69 K.

## What is not done

The editor has no panel for a compact or a pebble. A compact opens in it as the pin it is (the quick look and the profile are drawn; its Fuel item says the fuel is derived from the `compact` block, which is edited in the JSON tab); a valid pebble is shown as a notice with its closed-form centre and hottest kernel, not drawn as a pin (driven in the browser pane: no console error either way). The server's check answers a valid compact with the pin's quick look plus `compact` (the mixture and the hottest particle) and a valid pebble with `pebble` (the closed form and the hottest particle); a script, `write-case`, `headless validate` and the run API all work. A transient compact or pebble (steady first; the finite-volume kernels would allow it), limits for a pebble's regions, a prismatic block, a population of particles (T6) and mechanics are not done. A compact in the Compare tab works (it is a pin); a pebble is refused there. The random-packing resolved model stops at about 0.38. Nothing here says whether a particle survives.
