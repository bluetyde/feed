# The coated particle (plan 13)

A coated particle (TRISO) is a sphere: a fuel **kernel** and two to four coating layers (buffer, inner pyrolytic carbon, silicon carbide, outer pyrolytic carbon). FEED treats it as one-dimensional in the radius (spherically symmetric), **thermal only, steady or a thermal transient**. Heat is generated in the kernel and leaves through the layers to the outside.

**Status (milestone T6, 2026-10-16): a valid particle, steady or a transient, runs through the real OFFBEAT and is read back with independent checks; the layers can carry stated temperature limits; the editor builds it from scratch and shows its results ("In the editor" below); a population of sampled particles is run through the closed form and its spread reported ("A population of particles" below).** The editor's check, the run manager, the command line (`write-case`, `headless run`) and the server's run, results, detail and CSV routes all take a particle; the editor's page (milestone T5) has its own explorer items, panels, picture and results view for a particle. The reasons for each choice below are in [plan 13](plans/13-triso-particle.md) and [the probe](spike/triso-probe.md); the numbers of the real runs are in "Running a particle" below.

**What it is not.** It says how hot the kernel and each layer are. It does not say whether the particle survives: the stress in the SiC, the swelling and creep of the carbon, the pressure of the fission gas and CO, a failure fraction and kernel migration are not modelled (decision D1 of plan 13: thermal only first). Gamma heating of the coatings is not modelled either: all the heat is in the kernel.

## The case

```json
{
  "schema": "feed.case/0.1",
  "caseId": "triso",
  "name": "...",
  "assumptions": { "thermalOnly": true, "steadyState": true, "geometry": "1D-sphere" },
  "geometry": {
    "kind": "triso",
    "kernelRadius": { "value": 250, "unit": "um" },
    "layers": [
      { "name": "buffer", "thickness": { "value": 100, "unit": "um" } },
      { "name": "ipyc",   "thickness": { "value": 40,  "unit": "um" } },
      { "name": "sic",    "thickness": { "value": 35,  "unit": "um" } },
      { "name": "opyc",   "thickness": { "value": 35,  "unit": "um" } }
    ]
  },
  "power":    { "kernelPowerDensity": { "value": 600, "unit": "MW/m3" } },
  "boundary": { "surfaceTemperature": { "value": 1000, "unit": "K" } },
  "materials": { "kernel": { ... }, "buffer": { ... }, "ipyc": { ... }, "sic": { ... }, "opyc": { ... } },
  "gap":  { "model": "constant-conductance", "conductance": { "value": 1.5e5, "unit": "W/m2/K" }, "source": "..." },
  "mesh": { "kernelCells": 12, "bufferCells": 12, "ipycCells": 12, "sicCells": 16, "opycCells": 12 }
}
```

A complete case is `schema/vectors/good/triso-steady.json`; its dimensions are those of OpenMC Studio's illustrative particle (250, 100, 40, 35, 35 micrometres), its conductivities are FEED's own synthetic numbers.

- **Layers.** The first two to all four of `buffer`, `ipyc`, `sic`, `opyc`, in that order, from the kernel outward. A kernel without a buffer is not offered (OFFBEAT's own mesh script does not allow it), and the gap lies between the buffer and the layer after it, so a particle has at least those two layers. A layer out of order, a repeated or unknown name, or a fifth layer is refused with the field of the first fault.
- **Materials.** One for the kernel and one for each layer the particle has, named like them; each needs a stated `thermal.conductivity` set, under the same rules as a pin's. The burnup-dependent `uo2-nfi` law is refused (a particle has no burnup here). A material for a region the particle does not have (`fuel`, `cladding`, a missing layer) is refused.
- **Power**, exactly one of: `particlePower` (W, the heat generated in the kernel), `kernelPowerDensity` (W/m3 of kernel), or `compactPowerDensity` (W/m3 of compact) with `packingFraction`. The first two are two ways to say the same thing (power = density x the kernel's volume 4/3 pi R^3). The compact form gives each particle the compact's power density times the particle's whole volume divided by the packing fraction: the compact holds (packing fraction / particle volume) particles per cubic metre, so each carries the density divided by that. **The packing fraction is the fraction of the compact's volume that the whole particles (kernel to outer coating) fill.** It is an input number: OpenMC can model a packed compact, OpenMC Studio cannot yet, so FEED cannot check that the two apps use the same number. It is refused above 0.7405 (pi / sqrt 18, the densest packing of equal spheres) and warned above 0.64 (random close packing: an ordered arrangement is needed). A packing fraction given without a compact power density is refused, since it would change nothing. The pin's `linearHeatRate` is refused.
- **Boundary.** The same two forms as a pin: a prescribed surface temperature, or a bulk temperature with a heat-transfer coefficient (the matrix or coolant outside the outer coating).
- **Gap.** A constant conductance with its source, as for a pin, **at the buffer's outer radius** (W/m2/K). An irradiated particle has a gap between the buffer and the inner carbon, and the gap's width and gas decide how much it insulates; computing it needs mechanics, so FEED takes the conductance as an input. A conductance above 3e5 W/m2/K (about what OFFBEAT's own gap model gives for a zero-width gap) is warned: a buffer in contact understates the kernel temperature of an irradiated particle.
- **Limits.** Optional `limits` on the kernel and on the layers the particle has, each with its source ([docs/temperature-limits.md](temperature-limits.md), "A coated particle's regions"): the results carry one check per rule with its margin.
- **Mesh.** `kernelCells` and one `<layer>Cells` for each layer the particle has: whole numbers, at least 4 in the kernel and 2 in a layer, at most 20000 and 10000.
- **Units.** Lengths in `um` (or the micro sign `µm`), `mm`, `cm`, `m`; volumetric power in `W/m3`, `kW/m3`, `MW/m3`, `W/cm3`; the packing fraction as `1` or `%`.

## What is refused, and with which code

| Fault | Code and field |
|---|---|
| a pin's keys in the geometry (`fuelRadius`, thicknesses, a hole), an unknown key, layers out of order or of the wrong number, a layer with an unknown key, a material for a region the particle does not have | `E_GEOMETRY` at the key |
| a missing kernel radius, layer thickness, material, mesh count, a power in none or two forms, a mesh key the particle does not have | `E_SCHEMA_INVALID` at the field |
| a compact power density without a packing fraction; a material without a conductivity | `E_PROP_MISSING` |
| a packing fraction that does nothing, mechanics, hot dimensions, burnup, an axial stack, a particle that is not thermal-only, a `linearHeatRate`, a closed or contacting gap, the burnup law, a limit's `whileCladding`, point kinetics or a pin's steady-start key in a transient | `E_UNSUPPORTED` at the section |
| a transient section with a steady case, none with a transient case, a `power` section in a transient, no or two starts | `E_TRANSIENT_INCOMPLETE` |
| a history that does not start at 0, is not increasing or ends before the end time, a step that does not divide the end time, outputs that do not divide the steps, too much work | `E_TIME` |
| a limit with a region that is a pin's or unknown, a duplicate or empty name | `E_SCHEMA_INVALID` at the field |
| a limit on a layer the particle does not have | `E_GEOMETRY` at `/limits/i/region` |
| a limit without a source or a maximum | `E_PROP_MISSING` |
| a limit temperature of 0 K or above 10000 K | `E_OUT_OF_RANGE` |
| a packing fraction of 0 or above 0.7405 | `E_OUT_OF_RANGE` |
| a count of cells below or above the bounds | `E_MESH` |
| a boundary that is missing, in two forms or incomplete | `E_BOUNDARY_INCOMPLETE` |
| a length or power in the wrong unit | `E_UNITS` |

Warnings: `W_PACKING_FRACTION` (above 0.64), `W_GAP_CONTACT` (a gap conductance above 3e5), `W_POWER_RANGE` (a kernel power density above 1e10 W/m3). Every refusal has a bad vector in `schema/vectors/bad/triso-*.json`, and `tests/triso.test.ts` (29 tests) and `tests/trisoLimits.test.ts` state each one's code and field.

## Running a particle (T3)

`src/core/trisoWriter.ts` writes the OFFBEAT case, `src/core/trisoResults.ts` reads it back; both are used by the run manager (`start`, then `classify` reads the log, the fields, `constant/polyMesh/cellZones`, which `solver/run-feed.sh` now collects beside `T` and `C`).

- **The mesh** is a 2 degree double wedge on the x axis, written from FEED's own vertex formulas (nothing from OFFBEAT's tutorial or its mesh script, which are GPL-3.0): a level of radius r has four vertices at `(x, ±y, ±y)` with `x = r cos(a)/s`, `y = r sin(a)/s`, `s = sqrt(1 + sin(a)^2)`, `a` = 1 degree, so every vertex lies on the sphere of radius r. One block per region (cell zones Kernel, Buffer, IPyC, SiC, OPyC), in micrometres; the buffer's outer face and the next layer's inner face are the coupled patches `bufferOuter` and `ipycInner` (a zero-width gap and a conductance, like the pin), the outside is the patch `outer`, the four side planes are `wedge` patches.
- **What the wedge solves.** In the coordinate along the axis the section at x is a square of side 2 x tan(a), area `4 tan(a)^2 x^2`, so the heat equation on the pyramid is the heat equation of a **sphere with every radius multiplied by lambda = cos(a)/sqrt(1 + sin(a)^2) = 0.999698**, with the same conductivities, conductances (gap and film) and volumetric power. A cell centre is reported at its volume centroid, whose length is x, so a cell's radius is the length of its centre vector and lies on that smaller sphere. The ratio of the wedge's volume fraction (9.6894e-5) to its face fraction (9.6923e-5) is lambda; the probe's "0.03 % flux factor" is this. The results are compared with that sphere (`wedgeEquivalent`), not with the nominal one: the nominal sphere's rises are 0.03 to 0.06 % larger, which is what the probe saw as an unexplained residual in the buffer (0.076 K at 48 cells; with the correction it is 0.009 K).
- **The dictionaries.** `mechanicsSolver fromLatestTime`, `fgr none`, `gapGas none`, `burnup none`, `fastFlux none`; the heat is `timeDependentVhgr` in the kernel only (`materials ( Kernel )`), a two-point table that runs to twice the end time (OFFBEAT aborts when a table point equals the end time); each region is a `constant` material under the name of its cell zone, with the conductivity laws the pin writer writes (constant, linear, reciprocal, polynomial), rho 10000 and Cp 300; the gap is a `resistiveGap` with the case's conductance on both coupled patches; the outside is `fixedValue` or `convectiveHTC`. The end time is the particle's steady one (`trisoSteadyEndTime`, at least 5e7 s); OFFBEAT's adaptive steps make a run 84 steps and 3 to 4 seconds in all, 139 after complete output.
- **The results** (`TrisoResultsRecord`, `kind: "triso"`): every cell (radius, temperature, region), per region the inner and outer face temperature (the gap's two faces and the outside are patch values, the other interfaces come from the two cells beside them, the kernel's centre from its first cell and the kernel's parabola), the hottest and coldest cell and the drop; the summary has the kernel's centre, its surface, the wall, the gap's drop. The checks, with the tolerances fixed in `trisoResults.ts` before the first run:

| Check | Tolerance | Why |
|---|---|---|
| `closedFormKernel`, `closedFormBuffer`, `closedFormIpyc`, `closedFormSic`, `closedFormOpyc` | `5 dT_region / N^2 + max(0.5 % of the rise, 0.01 K)` | each cell against the closed form of the wedge's sphere at the cell's own radius; the first term is the pin's discretisation bound, the second the plan's 0.5 % of the rise |
| `crossCheckFv` | `max(0.3 % of the rise, 0.02 K)` | every cell against FEED's finite-volume solution (`trisoSolve.ts`) on the same mesh; the two saved runs of T2 agreed to 0.2 % |
| `energyBalance` | 0.5 % | the heat through the two outermost cells, `4 pi (K(Ta) - K(Tb)) / (1/ra - 1/rb)`, against the power made in the wedge's kernel (the input times lambda^3) |
| `gapDrop` | `1 % + 0.005 K` | the difference of the two patch values against `P / (4 pi R^2 h)` |
| `wallTemperature` | 0.05 K | the outside patch against the closed form |
| `steadyState` | 0.01 K still to change | OFFBEAT's last relative rate times the hottest cell times the particle's Elmore bound |
| `propertyRange` | | a conductivity law used outside its stated range makes the result out-of-domain |

A cell in a zone whose radii it is not between, a mesh other than the case's (cell centres 0.1 % off), zones that are not the particle's, a cell in two zones, a missing patch, a cut field, a non-finite or non-positive temperature are refused (`E_OUTPUT_INCOMPLETE`), never a partial result. `energyBalance` and `gapDrop` have a margin of 1e-3 to 1e-5 of their tolerance on the real runs; the closed-form checks use about a quarter to a half of theirs on a 12-cell mesh.

**Through the real solver** (`tests/trisoSolver.test.ts`, `FEED_SOLVER=1`; the output is saved in `tests/golden/offbeat-triso/<name>` and read again without the solver by `tests/trisoResults.test.ts`). Largest deviation of a cell from the closed form of the wedge's sphere, K, with 12 cells (16 in the SiC) per region unless stated:

| Case | rise | kernel | buffer | IPyC | SiC | OPyC | vs FV |
|---|---|---|---|---|---|---|---|
| `steady` (the vector, wall 1000 K) | 9.8 K | 0.023 | 0.010 | 0.0077 | 0.0032 | 0.00005 | 0.020 |
| `intense` (3000 MW/m3, wall 1298 K) | 49 K | 0.116 | 0.050 | 0.038 | 0.016 | 0.00013 | 0.098 |
| `film` (3000 MW/m3, 900 K, 2000 W/m2/K) | 49 K + 37 K film | 0.116 | 0.050 | 0.038 | 0.016 | 0.00009 | 0.098 |
| `two-layers` (buffer and IPyC only) | | 0.078 | 0.013 | 0.0002 | | | 0.060 |
| `temperature-dependent` (linear, linear, reciprocal) | | 0.062 | 0.061 | 0.048 | 0.020 | 0.00009 | 0.061 |
| `fine` (48 cells in every region) | 49 K | 0.0051 | 0.0087 | 0.0079 | 0.0032 | 0.00005 | 0.0087 |

The energy balance is within 5e-5 of the power made on every 12-cell run (3.5e-4 on the fine one, 4e-4 on the two-layer one); the gap's drop is within 2e-5 K of its closed form (0.850 K); the wall of the film case is 936.9098 K against the closed form to 4e-6 K. The error is the mesh's, as in the pin: it falls with the cell count (kernel 0.116 K at 12 cells, 0.005 K at 48).

**Entry points.** `check()` returns `{ ok: true, triso: { normalized, quick, derived } }` for a valid particle (and the particle's own errors for an invalid one); `POST /api/run` starts it, `/results`, `/detail` and `/results.csv` carry the record (a CSV row per cell and a comment row per region); compare refuses a particle (pins and plates only); `write-case` writes the files and the manifest; `headless run` writes `results.json`, a particle `derived.json` and the manifest. The editor's page shows a particle through its own views ("In the editor" below).

**Not in T3:** the editor (T5, below), a compact or pebble (T4), a population (T6).

## In the editor (T5)

A person can build the generic particle in the page, run it and read the layers' temperatures. The page decides by the document: `geometry.kind` is `triso` and the explorer, the properties, the picture and the results switch to the particle's; a case without a particle looks and behaves as before. The code is in its own section of `src/web/index.html` ("Coated particle (plan 13, T5)"); the helpers that touch only the document are between the markers `particle-pure:begin` and `particle-pure:end` so that `tests/particleEditor.test.ts` runs them without a page.

**Starting.** Library > Pins > **New coated particle** loads a valid steady particle (the content of `schema/vectors/good/triso-steady.json`: 250, 100, 40, 35, 35 micrometres, constant conductivities, 600 MW/m3 in the kernel, the wall at 1000 K; every number says "synthetic" in its source). File > Open takes any particle case, the library of examples included.

**The explorer's items** (errors from the validator go to the item, the field and the problems list through the pin's routing, extended for the particle's names: a material of a region the particle does not have is shown on Particle dimensions):

| Item | What it has |
|---|---|
| Power | the analysis (steady or transient). Steady: the power in one of the three forms (per particle, kernel power density, compact power density with a packing fraction); changing the form keeps the heat per particle; beside it the numbers the server returns in `triso.derived` (heat per particle, kernel power density, the two volumes, the heat flux at the outer surface, for a compact the particles per cubic metre, the closed-form centre and wall temperatures, every region's drop, the gap's) and the validator's warnings (`W_PACKING_FRACTION`, `W_POWER_RANGE`). Transient: a uniform or a steady start (`initialTemperature`, `initialSteadyParticlePower`), end time, time step, outputs, the power table in W per particle (add or remove a point), its peak and energy |
| Coolant boundary | the pin's panel: a prescribed surface temperature or a bulk temperature with a film; in a transient the optional table against time, with its plot |
| Particle dimensions | the kernel radius and the thickness of each layer (micrometres, millimetres, centimetres or metres; a unit the case uses that the list lacks is shown as it is); the layers are named and in order, so **Add** puts the next of buffer, inner PyC, SiC, outer PyC after the last, and **Remove** takes the outermost off; two to four layers; removing a layer also removes its material, its mesh count and any limit on it, and adding one gives it a synthetic material and a mesh count (and a heat capacity in a transient); a table of the radii |
| Gap | the conductance at the buffer's outer radius and its source; `W_GAP_CONTACT` is shown beside it |
| Mesh | the cells of the kernel and of each layer |
| Kernel, Buffer, Inner PyC, SiC, Outer PyC | the material: id, revision, the conductivity law (constant, linear, reciprocal, polynomial, table: the pin's fields; the burnup law is not offered) with its source, and in a transient the heat capacity |
| Temperature limits | rules on the kernel or a layer, each with a name, a maximum and the source it comes from (no sourced sets: the library's are a pin's) |

**The picture** (the Case view, and again in the results): concentric circles to scale, the kernel and each layer coloured by temperature from the closed form (steady) or, in a transient's case view, from the steady closed form at the table's peak power (stated on the picture; the transient is the run's result), the gap marked as a dashed ring on the buffer's outer face with its drop, one line per region (radii, inner and outer face temperature), and always the line **1D, spherically symmetric: thermal only**. The radial plot under it draws the closed form (`triso.profile`: every region over its own radii, with the gap as a jump) and, after a run, OFFBEAT's cells; in a transient case view it draws the power table instead. The picture is drawn from the document's radii as soon as they are positive lengths, so a fault elsewhere does not hide it; the colours need a valid case.

**The banner** (case and results): "1D, spherically symmetric: thermal only. Thermal-only result. It says nothing about stress, failure or fission-gas release: no stress in the silicon carbide, no swelling or creep of the carbon, no gas pressure, no kernel migration. All the heat is made in the kernel (no gamma heating of the coatings)." The results banner is that label and the record's own text.

**The results view** (Results tab, a steady or a transient run; the numbers are the record's `results.json`):
- *Steady*: cards for the kernel centre, kernel surface, outer wall and gap drop; one card per region (its radii, the drop or, for the kernel, the rise, the inner and outer face temperature); a checks card; the cross-section coloured cell by cell from OFFBEAT; the radial profile with OFFBEAT's cells and the closed form dashed (the toggle of the toolbar); a table of the regions (face temperatures, drop, hottest and coldest cell) and a table of every check with its value, verdict and note.
- *Transient*: cards for the hottest cell, the rise, the hottest cell at the end, the energy made, stored and rejected, the hottest cell of each region over the run and when, the checks; the hottest cell, each region's hottest cell and the outer wall against time, with the power table as a grey area and each stated limit as a dashed line (a limit far above the temperatures reached is named under the plot instead of flattening the curve); a table of the limits with their margins from the checks; the cross-section and the radial profile at an output, which a click on the time plot moves (the colour scale spans the whole run, so a hot output and a cold one are comparable).
- CSV and JSON export work on a particle run (the server's `/results.csv`, the page's own JSON).

**The server's addition** is additive: the check response of a valid particle carries `triso.profile`, the closed form sampled by `src/core/trisoProfile.ts` (49 points in the kernel, 25 in each layer, each region from its inner to its outer face). Nothing else in the response changed.

**What the editor does not do (T5):** the cut-away sphere of the 3D view (it waits for plan 12's A7); an independent preview of a transient in the case view (the transient is shown after a run); a particle in the Compare tab (the server refuses it and says so) or in a refinement study (the page says so; the particle's own checks compare every cell with the closed form and an independent solution, and the mesh item changes the cells); saving a particle's material to the user library or importing one from a SEED project (the library's regions are a pin's `fuel` and `cladding`); a compact, a pebble or a population (T4, T6).

## The transient (T3, stage 3)

`assumptions.steadyState: false` asks for a thermal transient: the heat made in the kernel is a **table against time**, the particle starts from a uniform temperature or from its steady state, and the outside may change with time. Code: `src/core/trisoTransient.ts` (the section), `src/core/trisoTransientModel.ts` (the independent model and the start), `src/core/trisoTransientResults.ts` (the checks), the writer; the vectors `triso-pulse`, `triso-outside-ramp`, `triso-wall-quench`, `triso-pulse-limits` and the `triso-transient-*` bad ones.

```json
"assumptions": { "thermalOnly": true, "steadyState": false, "geometry": "1D-sphere" },
"transient": {
  "powerHistory": [ { "time": { "value": 0, "unit": "ms" }, "particlePower": { "value": 0, "unit": "W" } }, { "time": { "value": 10, "unit": "ms" }, "particlePower": { "value": 0.4, "unit": "W" } }, ... ],
  "endTime": { "value": 500, "unit": "ms" }, "timeStep": { "value": 0.5, "unit": "ms" }, "outputs": 50,
  "initialTemperature": { "value": 1000, "unit": "K" },        // or "initialSteadyParticlePower": { "value": 0.2, "unit": "W" }
  "boundaryHistory": [ ... ]                                    // optional: the pin's form, the outside against time
}
```

- **Power.** `transient.powerHistory` is a table of `{time, particlePower}` (W per particle, linear between the points, from 0, increasing, reaching the end time, never negative); the case has **no `power` section** (`E_TRANSIENT_INCOMPLETE` at `/power`), and the case's `power` is the table's peak. Not offered, by name: `pointKinetics`, a pin's `initialSteadyLinearHeatRate`.
- **Heat capacity.** Every region's material needs a `thermal.volumetricHeatCapacity` set (constant, linear or polynomial, under the pin's rules and with its source; `E_PROP_MISSING` otherwise). OFFBEAT is given `rho` 10000 and `Cp = c / rho` (a temperature-dependent one through the pin's models).
- **Time grid.** `endTime` a whole number of `timeStep`s, `outputs` dividing the steps, at most 100000 steps and 200 outputs, as for a pin; **cells x steps at most 5e5** (`E_TIME`), because the independent runs (about five times that work) are done in the server's own thread. A particle's time scale is a fraction of a second: the slowest time constant of the synthetic particle with a film is 0.2 s, its kernel's a few milliseconds.
- **Start.** A uniform `initialTemperature`, or `initialSteadyParticlePower`, the steady field at that power written as the starting field of every cell (FEED's finite-volume solution of the wedge's sphere on the same mesh; refused with `E_OUT_OF_RANGE` when there is none).
- **Outside.** `transient.boundaryHistory` is the pin's (plan 11): points `{time, bulkTemperature, heatTransferCoefficient}` for a film or `{time, surfaceTemperature}` for a prescribed wall, linear in time, in the same form as the case's own boundary, starting at the case's boundary when the run starts steady, reaching the end time; written as OFFBEAT's `timeDependentAxialProfileHTC` / `...T` at the one height with a flat point beyond the end time (they work on the wedge: the table is read at the height of the mesh, a few micrometres, with two equal columns).
- **Refused still:** point kinetics, an axial stack, mechanics, burnup, hot dimensions (as for a particle at all).

**Results** (`TrisoTransientResultsRecord`, `kind: "triso-transient"`, schema `feed.results/0.2`): the times, every cell by increasing radius with its region, the temperature of every cell at every output, the series (power, the energy made, the energy the step deposits, stored, rejected, the hottest cell of each region, the outside's temperature, the gap's drop), the summary, the checks and the thermal-only statement. **The checks are the pin's, with its ids and tolerances** (`src/core/transientResults.ts`), against FEED's finite-volume solution (`solveTrisoFv`) of the sphere the wedge solves, run on the same mesh and step, on the doubled mesh (its own spatial error) and on the half step:

| Check | Rule |
|---|---|
| `energyBalance` | the energy made = stored + rejected, from the output fields, 3 % of the energy made (or of the largest exchanged anywhere, with a steady start or a moving outside). **The energy made is the one the implicit step deposits**, the source taken at the end of each step (the independent solution does the same, and OFFBEAT was found to): a ramp of N steps deposits 1/N more than its integral on the way up and 1/N less on the way down, so the 10 ms pulse of 20 steps is 5 % high at its peak (5.75 % gap against the exact integral, 0.85 % against the step's). The record carries both series. The heat leaving is a trapezoid over the outputs: with the outputs far apart against the time the heat takes to leave it is poor, and the note says to add outputs |
| `crossCheckFv` | every cell and the wall at every output, `min(3 x the independent solution's own change when its cells are halved, 0.5 % of the peak rise) + 0.02 K` |
| `timeStep` | the peak changes by less than 2 % of its rise when the step is halved (at every step of the run), and with an outside table every cell and the wall too |
| `wallTemperature` | a prescribed wall follows the table at every output to 0.05 K |
| `propertyRange` | a conductivity or heat capacity law used outside its stated range makes the result out-of-domain |
| `temperatureLimit1...` | the worse of the outputs and **every step of the independent solution**, which sees a peak between two outputs: the pulse's outputs show 1016.61 K at 20 ms, the steps 1017.16 K |

Energies in the record are the nominal sphere's (the wedge's, divided by lambda^3 = 0.999087).

**Through the real solver** (`tests/trisoTransientSolver.test.ts`, 6 tests, `FEED_SOLVER=1`; output in `tests/golden/offbeat-triso-transient`, read again without the solver by `tests/trisoTransientResults.test.ts`; 1000 steps, 5 to 6 seconds a run):

| Case | max cell vs independent | energy balance | time-step (of threshold) | peak |
|---|---|---|---|---|
| `pulse`: 0.4 W triangle in 20 ms, uniform 1000 K, wall held | 0.014 K | 0.85 % | 0.205 K (0.34) | 1016.61 K at 20 ms, 16.6 K up |
| `outside-ramp`: steady at 0.2 W, film bulk 900 to 1000 K over 50 to 250 ms | 0.067 K | 0.09 % | 0.029 K | 1062.5 K at 500 ms |
| `wall-quench`: steady at 0.2 W, wall 1000 to 900 K in 50 ms | 0.26 K (bound 0.41) | 1.0 % | 0.123 K (2.0) | 949.8 K at 500 ms |
| `laws`: linear and reciprocal conductivities, linear and quadratic capacities, a film | 0.027 K | 2.4 % | 0.208 K | 966.8 K at 20 ms |
| `coarse-step`: the pulse with a 5 ms step | 0.013 K | **3.9 %, fails** | **1.87 K, fails** | 1013.6 K |

A step that does not resolve the pulse fails `timeStep` and says to shorten it, while the cells still agree with the independent solution of the same step. A heat capacity 1.5 times too large, a power 10 % too high, a wall table other than the one that was run, a conductivity 20 % off and a step twice the one that was run each fail a check on the saved real output.

## A population of particles (T6)

Particles are not identical: the kernel's size, each layer's thickness, the local power and the matrix temperature all spread. A **population** draws N particles from distributions the case states, runs every one through the independent closed form of the sphere (the same solution as "The independent solutions" below) and reports the **spread** of the kernel's peak temperature and of every drop. **It is a sample of a stated population, not a prediction for a real core**: the distributions are the case's, the spread is the spread of the N particles drawn, and it is thermal only (no stress, no failure fraction: that is plan 14). A real core holds billions of particles; N is thousands.

Code: `src/core/trisoPopulation.ts` (the generator, the distributions, the batch and the statistics), `src/core/trisoPopulationCase.ts` (the case's section), `src/core/populationRunner.ts` and `populationWorker.ts` (a worker thread with a deadline), the server route `POST /api/population`, the editor's Population item. Tests: `tests/trisoPopulation.test.ts` (45), `tests/populationEditor.test.ts` (19), `tests/trisoPopulationGolden.test.ts` (14, ungated), `tests/trisoPopulationSolver.test.ts` (gated), `tests/seedOracleTriso.test.ts`, `tests/transferParticle.test.ts`.

### The case's section

```json
"population": {
  "size": 2000,
  "seed": 20261016,
  "distributions": {
    "kernelRadius": { "kind": "normal", "mean": { "value": 250, "unit": "um" }, "stdDev": { "value": 5, "unit": "um" },
                      "truncate": { "min": { "value": 235, "unit": "um" }, "max": { "value": 265, "unit": "um" } } },
    "buffer":       { "kind": "normal", "mean": { "value": 100, "unit": "um" }, "stdDev": { "value": 8, "unit": "um" } },
    "sic":          { "kind": "lognormal", "median": { "value": 35, "unit": "um" }, "sigmaLog": { "value": 0.04, "unit": "1" } },
    "ipyc":         { "kind": "uniform", "min": { "value": 36, "unit": "um" }, "max": { "value": 44, "unit": "um" } },
    "opyc":         { "kind": "constant", "value": { "value": 35, "unit": "um" } },
    "powerFactor":  { "kind": "lognormal", "median": { "value": 1, "unit": "1" }, "sigmaLog": { "value": 0.1, "unit": "1" } },
    "matrixTemperature": { "kind": "normal", "mean": { "value": 900, "unit": "K" }, "stdDev": { "value": 15, "unit": "K" } }
  }
}
```

- **`size`**: a whole number from 1 to **100000**. **`seed`**: a whole number from 0 to 4294967295, **always stated** (it names the sample: the case gives the same particles every time, on every machine). A different seed is another sample of the same population.
- **Variables** (each optional; one not given is the case's own value and draws nothing): `kernelRadius`, the thickness of each layer **the particle has** (`buffer`, `ipyc`, `sic`, `opyc`; a thickness for a layer it lacks is `E_GEOMETRY`), `powerFactor` and `matrixTemperature`.
- **What each changes.** The *power factor* multiplies the case's **kernel power density**, so the heat per particle is that density times the DRAWN kernel volume (a bigger kernel makes more heat in the same neutron field; the power per particle is not held fixed). The *matrix temperature* is the bulk temperature of a convective boundary or the temperature of a prescribed wall. The gap's conductance (at the buffer's outer radius), the film coefficient and every conductivity are the case's. A population of constants is the case's own particle.
- **Kinds.** `constant` (`value`), `normal` (`mean`, `stdDev`), `lognormal` (`median`, `sigmaLog`: the standard deviation of ln x, a plain number such as 0.05 for about 5 %), `uniform` (`min`, `max`). A normal or lognormal may be **truncated** to `{min, max}` (either may be left out) by rejection inside the range. The spread of a temperature is a **difference**: `stdDev` of the matrix temperature is in `K`, a `degC` is refused (`E_UNITS`) because it would add 273.15.
- **Steady only**: a population on a transient particle is `E_UNSUPPORTED` (a transient is one particle's history; its power is a table, not a density a factor can scale). A pin or a plate with a `population` is `E_UNSUPPORTED` too.

### What is refused

| Fault | Code and field |
|---|---|
| a population that is not an object, an unknown key, an unknown variable or kind, an unknown key of a distribution or truncation, `size` or `seed` that is not a whole number, a truncation with neither bound | `E_SCHEMA_INVALID` at the field |
| no `size`, `seed`, `distributions` or a parameter of a kind | `E_PROP_MISSING` |
| `size` of 0 or above 100000, a `seed` outside 0 to 4294967295, a `stdDev` or `sigmaLog` of 0 or less, a lognormal median of 0 or less, a uniform with `max` not above `min`, a truncation whose `max` is not above its `min`, a constant that is not a valid value | `E_OUT_OF_RANGE` |
| a distribution for a layer the particle does not have | `E_GEOMETRY` |
| a quantity in the wrong unit (a thickness in K, a bare number, a temperature spread in degC) | `E_UNITS` |
| **a distribution that cannot be sampled**: once truncated and cut to the valid values of its variable (a thickness of at least 1 nm, a factor above 0 and at most 100, a temperature above 0 K and at most 10000 K) it keeps **under 1 %** of its draws | `E_POPULATION_UNSAMPLABLE` (new) |
| a population on a transient particle, a pin or a plate | `E_UNSUPPORTED` |

Warning `W_POPULATION_REJECTION` (new): more than 1 % of a distribution's draws are not valid values (for example a buffer of 100 +- 45 um, which is below 1 nm in 1.3 % of the draws): they are thrown away and counted, and the sample is then the distribution **conditioned on being valid**, with a mean and spread that differ from the stated ones. At run time a population whose draws mostly fail (more than ten rejections for each particle kept, plus 100) stops with the reason and the counts (HTTP 422). 43 vectors (7 good, 36 bad) are in `schema/vectors/*/triso-population-*.json` and `pin-with-population.json`; each bad one has one fault and one code.

### The generator

Written here, no `Math.random`: **xoshiro128\*\*** on 32-bit integers, its four words filled from the seed by **splitmix32**, and a **Box-Muller** normal, `sqrt(-2 ln u1) cos(2 pi u2)` from two uniforms of 53 bits each (the sine partner is thrown away, so a draw never depends on the one before). The integer generator gives the same numbers on every platform and engine. The normal draw uses `Math.log`, `Math.sqrt` and `Math.cos`, which are the same code on every platform of one engine (V8 takes them from fdlibm) and **may differ in the last bits on another engine**; the tests pin the first words of the seed 1 exactly and its first normal draws to 1e-12. One particle is drawn in a fixed order (kernel radius, buffer, inner PyC, SiC, outer PyC, power factor, matrix temperature); a constant draws nothing. A draw that is not a valid particle (a length outside 1 nm to 1 km, a power factor or a temperature outside its range, a closed form that does not exist) is **rejected as a whole and counted** by reason (`geometry`, `powerFactor`, `matrixTemperature`, `noClosedForm`), and the particle is drawn again.

### What it reports

For every sampled particle the closed form gives the kernel's peak temperature, its rise above the matrix, and the drop across the kernel, each layer, the gap and (for a convective boundary) the film. For each of them: **mean, standard deviation (n - 1), minimum, maximum and the 5, 50, 95 and 99 percentiles** (linear interpolation between the order statistics at position (n - 1) p: NumPy's and R's default). Also: a **histogram** of the kernel peak (20 equal bins), the **maximum** with its particle's parameters, five **representative particles** (the hottest, the one nearest the median, the coldest, the one with the thickest buffer, the one with the thinnest SiC) with their numbers, the **counts of rejected draws**, the case's own particle for comparison, and, when the case has `limits`, the **fraction of particles above each** (a region's hottest point is its inner face, from the closed form; so a limit on the SiC is judged at the SiC's inner face). Speed: 2000 particles take 0.3 s and 100000 take 4.4 s in one thread on the development machine; the server runs the batch in a worker thread with a deadline of 60 s.

### How it was checked

Written before the code, in the plan: the same seed gives the same sample, another seed another; the sampled **mean of the kernel temperature equals the mean particle's value plus the Jensen correction**, the correction computed by quadrature in the test (a kernel radius of 250 +- 30 um at 3000 MW/m3: the mean particle gives 1049.06 K, the quadrature gives 1049.27 K, 100000 draws give a mean within four standard errors of the quadrature and more than four from the mean particle's value); the percentiles against a sorted list done by hand (21 particles, the draws replayed with the generator); the population of constants equals the single particle; a population changes nothing for a case without one (the normalised particle is byte-identical to the saved real runs, and with a population it is the same particle plus the section). The generator is held against a second implementation in BigInt arithmetic; the distributions against their theory (mean, variance, skewness, a Kolmogorov-Smirnov distance, the truncated mean) with tolerances of four standard errors fixed in the test file first. Negative controls fail the same checks: a swapped distribution (the buffer's law given to the SiC) and a read of the wrong layer.

### The real solver across the spread

The population is run through the closed form; **OFFBEAT is the check on a few of its particles**, which is what `tests/trisoPopulationSolver.test.ts` does (`FEED_SOLVER=1`; saved in `tests/golden/offbeat-triso-pop/`, read again without the solver by `tests/trisoPopulationGolden.test.ts`). The five representatives of the example population are written out as cases of constants (`particleDocument`) and run through the run manager. Tolerances were fixed before the first run: the kernel centre against the closed form of the sampled particle 0.6 % of its internal rise, every region's drop against the closed form of the wedge's sphere 0.2 K, the spread (hottest minus coldest) within 1 %, and every check the run itself makes passing.

| Particle (of 2000) | closed form of the sampled particle | OFFBEAT kernel centre | difference | cross-check against FEED's finite volumes (bound 0.3 % of the internal rise, 0.044 to 0.054 K) |
|---|---|---|---|---|
| hottest (1355) | 978.387 K | 978.358 K | -0.029 K | 0.015 K |
| median (398) | 928.933 K | 928.899 K | -0.034 K | 0.020 K |
| coldest (817) | 867.630 K | 867.612 K | -0.018 K | 0.005 K |
| thickest buffer (1098, 123.5 um) | 916.176 K | 916.121 K | -0.055 K | 0.041 K |
| thinnest SiC (7) | 930.655 K | 930.607 K | -0.048 K | 0.033 K |

The real solver sees the same ordering and the same width (110.7 K from the coldest to the hottest). **A finding, and the reason the example's mesh is 48 cells:** on the 12 cells per region of the other examples, the four representatives that were run first (the hottest, median, coldest and thickest-buffer particles; the fifth was not reached) **all failed the run's own finite-volume cross-check**: the largest cell deviation from FEED's finite volumes was 0.087, 0.107, 0.046 and 0.190 K against bounds of 0.050, 0.051, 0.044 and 0.049 K (0.3 % of the internal rise of 14.6 to 16.9 K). T3's particle (49 K rise) agrees to 0.2 % of its rise. The deviation sits in the kernel and grows with the buffer's thickness in these four (99.7 um: 0.046 K, 103.5: 0.087, 107.9: 0.107, 123.5: 0.190), a step at the kernel-buffer interface of OFFBEAT's mesh; the mechanism was not isolated. **No tolerance was widened:** on 48 cells every check of every run passes, with the deviations 4.6 to 9 times smaller (the table). The closed form the population uses is right on either mesh; a sampled particle run through OFFBEAT on 12 cells can fail the real solver's own cross-check by this amount, so use 48.

### The example

`examples/synthetic-triso-population.json`: the generic particle (250/100/40/35/35 um, FEED's synthetic conductivities) at a kernel power density of 1000 MW/m3 in a 900 K, 2000 W/m2/K matrix (assumed), 48 cells per region, and a population of 2000 particles with the seed 20261016: normal spreads of a few percent in the radius (truncated at 3 sigma) and each thickness, a lognormal power factor (median 1, sigma of ln x 0.1) and a normal matrix temperature (900 K, 15 K). **The spreads are assumed numbers, not measured ones.** Result: a kernel peak of **929.0 K on average (sd 15.5 K), 5 % at 903.6 K, 50 % at 928.9 K, 95 % at 953.6 K, 99 % at 965.6 K, from 867.6 to 978.4 K**; the case's own particle has 928.66 K (the mean is 0.35 K higher: the Jensen effect of the radius and the thicknesses). Per drop (mean, sd): kernel 3.47 +- 0.36 K, buffer 11.89 +- 1.37 K, inner PyC 0.38 +- 0.05 K, SiC 0.08 +- 0.01 K, outer PyC 0.23 +- 0.03 K, gap 0.28 +- 0.03 K, film 12.3 +- 1.3 K. None of the 2000 draws was rejected.

### In the editor

A particle gets **Population** in the explorer when its case has the section (a particle without one has the items it always had); the **Power** item of a steady particle has *Add a population*. The panel has the size and the seed, one row for each variable with a kind (not varied, constant, normal, lognormal, uniform), its parameters with units and, for a normal or lognormal, a *truncate at 3 sigma* box whose bounds can be edited; the validator's errors show at their fields and the Run button is off until the case is valid. **Run population** posts the case to `/api/population` and shows the banner (a sample, not a prediction for a real core), the counts of particles and rejected draws, two small tables (mean, sd, max; then the 5, 50, 95 and 99 percentiles), a histogram of the kernel peak with the percentiles and the limits marked, the fraction above each limit and the five representative particles with their parameters. A sample is marked stale when the case changes and is not shown for another document. Driven in the browser pane on a server of its own port (8794): the particle from the menu, *Add a population*, five distributions and a truncation set, a limit added, the run (1000 particles), the tables and the histogram read, a size of 0 showing its error at the field with the Run button off and the sample marked stale, and a pin loaded after it showing no Population item. **Found by driving it and fixed:** the tables were unreadable in the narrow properties panel (a first column that wrapped letter by letter: now two four-column tables and a details block per particle), and the histogram's labels ran off the plot.

### Power from OpenMC: per particle, and the gap

OpenMC Studio (read 2026-10-16, branch `claude/mc-checks`): its result view turns any tally into a `kind: "table"` with the filter bins as labels (cell names; a material filter; and, for a part inside a lattice, a cell-instance filter whose bins are `(cell, instance)`) and for each row and score a `mean`, a `std` and a relative error, **per source particle**; its depletion writer already tallies `kappa-fission` per material to split the power. Its TRISO example (`examples/triso-particle`) is one particle with a flux tally by cell, in a fixed-source run with fission production off, and **no power tally and no packing fraction**: its own TODO says a packing template (`pack_spheres`, `create_triso_lattice`) is "eventually", with no TRISO users confirmed.

**So a power per particle can be derived, by arithmetic outside FEED's transfer:** a `kappa-fission` (or `heating`) tally over the kernel cell(s) gives energy per source neutron summed over the kernels it covers; the heat per particle is that, times the source rate (or scaled to a stated total power, as the pin transfer does with `total-power`), **divided by the number of kernels the tally covers**. That number is a recipe input, not in the table: for a single-particle model it is 1; for a compact it is the count of the model (which Studio cannot express today); with a cell-instance filter every particle has its own row and no division is needed. FEED's `particlePower` (W) is then that number, or `kernelPowerDensity` if divided by the kernel volume.

**FEED's transfer cannot carry it today, and this was not changed.** `transferHeating` (`src/core/transferRequest.ts`, [transfer-heating.md](transfer-heating.md)) maps a heating table onto the *axial slices of one pin* and writes `power.linearHeatRate` of the chosen slice; the transfer fields FEED describes to SEED are `heating-to-pin`, `coolant-boundary` and `burnup`. A particle as the target is refused with the validator's reason (`E_UNSUPPORTED` at `/target/content/power/linearHeatRate`: a particle's power is per particle, per kernel volume or per compact volume), and no case comes out (`tests/transferParticle.test.ts`). A per-particle form would be a new field (`heating-to-particle`: a label for the kernel cell, the count of kernels, the source rate or a total, `particlePower` as the product) with its own recipe vocabulary in SEED's contract (`seed.transfer-recipe`), which is a decision for SEED's side as well as FEED's, not a small change here. It is written as a question in [seed-triso-request.md](seed-triso-request.md). The packing fraction stays an input of the case.

### SEED

[seed-triso-request.md](seed-triso-request.md) (a document, **not sent**): 19 oracle entries for five sampled particles in `oracles/seed-triso/` (a separate folder: the 125 entries of `oracles/seed` are untouched), the new per-layer quantities, how FEED reads each, the tolerances, the real-solver numbers and the questions for SEED.

## The independent solutions (T2)

`src/core/trisoSolve.ts` is a second method, written without any reference to OFFBEAT, for the sphere:

- **Closed form** (`trisoClosedForm`). The heat made in the kernel, P, crosses every sphere outside it, so in a shell of conductivity k(T) the conductivity integral from the shell's outer face to radius r is P (1/r - 1/b) / (4 pi); inside the kernel it is q''' (R^2 - r^2) / 6. The gap drops P / (4 pi R_g^2 h) at the buffer's outer radius, the film P / (4 pi R_o^2 h_film) at the outside. A conductivity that depends on temperature is handled by solving the integral (`solveHot`, as for the pin). It returns the temperature at every face, the drops and the temperature at any radius. A conductivity that reaches zero before the heat is carried is refused by the validator as `E_OUT_OF_RANGE` on `/materials`, as for a pin.
- **Finite-volume solution** (`solveTrisoFv`, `steadyTrisoFv`). Cell-centred, one dimension in the radius, any number of regions, cell nodes at the cell's volume centroid (where OFFBEAT reports its cells), the two half-cell resistances in series at every face (each with its own conductivity) and the gap's resistance at the buffer's outer face. Implicit Euler or Crank-Nicolson, Picard iteration for a conductivity and heat capacity that depend on temperature, heat capacity through the enthalpy so that stored energy is conserved exactly. The steady field is one implicit step of effectively infinite length, checked as a fixed point.
- **Time scale** (`trisoTimeScale`, `trisoSteadyEndTime`). The Elmore bound of the pin's argument (docs of `steadyState.ts`) on the sphere: each cell's placeholder capacity times its resistance to the coolant, with the lowest conductivity each material allows, times 1.25. The particle's bound is a fraction of a second; the steady end time is the pin's floor (5e7 s) unless the bound needs more.
- **Quick look and derived numbers** (`trisoQuickLook`, `trisoDerived`): the closed form with an out-of-domain check per region (a region whose temperatures leave its conductivity's stated range is named, never extrapolated), and the heat per particle, the kernel's power density, the volumes, the heat flux at the outer surface, the compact's particle count per cubic metre, the drop of each region and of the gap, and the time scale.

**What was checked.** The closed form against arithmetic written in the test and against a Runge-Kutta integration of the conduction equation for conductivities that fall with temperature (agreement to 1e-6 K). The finite-volume solution against the closed form (second order in the cell width: the error falls by 2.5 or more each time the mesh is doubled), against the exact series of a sphere with a heated core and a prescribed wall (constant properties; Crank-Nicolson to 0.5 %, implicit Euler to 3 % of the rise at 1/400 of the slowest decay time), for conservation of energy to 1e-9 of the heat made with a time-dependent power and properties that depend on temperature, for the order in time (implicit Euler first order, Crank-Nicolson second), and **cell by cell against two saved OFFBEAT runs of the same particle** (tests/golden/offbeat-triso: a prescribed wall at 48 cells per layer, within 0.1 K of a rise of 48 K; a convective outside at 12 cells per layer, within 0.15 K of a rise of 85 K). The time scale against the sum written out in the test and against the measured slowest decay of the finite-volume field (the bound is above it, within a factor 40).

The case-level transient of a particle (a power history in the case, heat capacities for the layers) is built with the solver in T3 (stage 3), where it is compared with OFFBEAT; the solutions above take a power history and heat capacities as inputs.

## The geometry kernel

`src/core/geometry.ts` has a third shape beside the cylinder and the slab: `SPHERE`, with area 4 pi r^2, the resistance of a shell (1/a - 1/b) / (4 pi k), the volume of a shell 4/3 pi (b^3 - a^3), and the cell centre OFFBEAT reports, the volume centroid of the shell 3/4 (b^4 - a^4) / (b^3 - a^3). Every quantity is for the whole sphere, not per unit length. The tests check each against a quadrature written in the test. The pin's and the plate's results are unchanged (the cylinder and slab entries only gained a `sphere: false` flag).

## What changed for the pin and the plate

The case schema no longer requires `fuel` and `cladding` materials or `fuelCells` and `claddingCells` (a particle has other regions); the validator requires them for a pin or a plate and refuses a missing one with `E_SCHEMA_INVALID` at the field itself (`/materials/fuel`, `/mesh/claddingCells`), where the schema used to refuse the whole section. The validator's gap and boundary reading were moved into two functions both cases use, with the same messages.

## Examples (milestone T7)

Two generic-particle cases are in `examples/`, both synthetic and illustrative, both through the real solver with every check passing (`tests/exampleRuns.test.ts`; the output in `tests/golden/examples/`, read again by `tests/exampleGolden.test.ts`). The compact, the pebble and a sampled population (T4, T6) are not built, so there is no example of them.

- **`synthetic-triso-compact-steady`**: the dimensions of OpenMC Studio's illustrative particle (250/100/40/35/35 um) in a compact of 10 W/cm3 and a packing fraction of 35 %, which gives each particle 11.65 mW (a kernel power density of 178 MW/m3). The conductivities are FEED's synthetic numbers (kernel 3, buffer 0.5, PyC 4, SiC 13.9 W/m/K, constant, each source says so): the library holds no sourced PyC, SiC or buffer set. The outside is a convective boundary of 900 K and 2000 W/m2/K that stands for the matrix (assumed). The kernel centre is 905.09 K, 5.1 K above the matrix: 2.19 K across the film, 0.04 K the outer PyC, 0.01 K the SiC, 0.07 K the inner PyC, 0.05 K the gap, 2.12 K the buffer, 0.62 K the kernel's own parabola. All ten checks pass; the closed forms agree within 0.007 K. The energy balance (heat through the two outermost cells against the heat made) passes at 0.21 % of a 0.5 % threshold. **Found:** the first version had the matrix at 1000 K and the energy balance failed at 1.03 %. At this low power the temperature difference across the two outermost cells is 3 mK, and the solver writes 8 significant digits, which is 0.1 mK at 1000 K and above but 0.01 mK below 1000 K; the rounding was then a third of the signal. The matrix was moved to 900 K (the value of the `triso-convective-outside` vector) and the check passes. Nothing in the checks was changed; the lesson is that a particle at a low power and 1000 K or more can fail the energy balance by rounding and needs a higher power or a lower reference temperature.
- **`synthetic-triso-compact-pulse`**: the same particle from its steady state with a 10 ms triangular overpower to 0.6 W (about 51 times the steady power; an input in W per particle, not a result), synthetic heat capacities (kernel 3, buffer 1.5, PyC 2.5, SiC 3.5 MJ/m3/K) and five limits of 1000 K, one per region, each with the source "synthetic: an illustrative number chosen for this example, not a design limit". The kernel peaks at 929.53 K at the 20 ms output (+24.4 K; the independent solution's steps show 930.33 K between outputs, which is what the limit check uses), the smallest margins are 69.7 K (kernel), 78.2 K (buffer), 93.8 K (inner PyC), 93.9 K (SiC), 94.0 K (outer PyC), and at 0.5 s the particle is 0.9 K above its start. The energy balance gap is 0.07 % (3 % threshold), the cross-check 0.021 K (0.17 K), the time step 0.30 K (0.61 K).

Neither says anything about whether a particle survives.
