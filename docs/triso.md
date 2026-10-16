# The coated particle (plan 13)

A coated particle (TRISO) is a sphere: a fuel **kernel** and two to four coating layers (buffer, inner pyrolytic carbon, silicon carbide, outer pyrolytic carbon). FEED treats it as one-dimensional in the radius (spherically symmetric), **thermal only, steady or a thermal transient**. Heat is generated in the kernel and leaves through the layers to the outside.

**Status (milestone T5, 2026-10-16): a valid particle, steady or a transient, runs through the real OFFBEAT and is read back with independent checks; the layers can carry stated temperature limits; the editor builds it from scratch and shows its results ("In the editor" below).** The editor's check, the run manager, the command line (`write-case`, `headless run`) and the server's run, results, detail and CSV routes all take a particle; the editor's page (milestone T5) has its own explorer items, panels, picture and results view for a particle. The reasons for each choice below are in [plan 13](plans/13-triso-particle.md) and [the probe](spike/triso-probe.md); the numbers of the real runs are in "Running a particle" below.

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
