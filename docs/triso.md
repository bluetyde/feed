# The coated particle (plan 13)

A coated particle (TRISO) is a sphere: a fuel **kernel** and two to four coating layers (buffer, inner pyrolytic carbon, silicon carbide, outer pyrolytic carbon). FEED treats it as one-dimensional in the radius (spherically symmetric), **thermal only and steady**. Heat is generated in the kernel and leaves through the layers to the outside.

**Status (milestone T2, 2026-10-15): the case is read and checked, and its independent solutions exist; the solver does not run it yet.** A valid particle case is answered with "valid, but nothing runs it yet" by the editor's check (which now also returns the closed form and the derived numbers), the run manager and the command line; the solver is milestone T3, the editor T5. The reasons for each choice below are in [plan 13](plans/13-triso-particle.md) and [the probe](spike/triso-probe.md).

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
- **Mesh.** `kernelCells` and one `<layer>Cells` for each layer the particle has: whole numbers, at least 4 in the kernel and 2 in a layer, at most 20000 and 10000.
- **Units.** Lengths in `um` (or the micro sign `µm`), `mm`, `cm`, `m`; volumetric power in `W/m3`, `kW/m3`, `MW/m3`, `W/cm3`; the packing fraction as `1` or `%`.

## What is refused, and with which code

| Fault | Code and field |
|---|---|
| a pin's keys in the geometry (`fuelRadius`, thicknesses, a hole), an unknown key, layers out of order or of the wrong number, a layer with an unknown key, a material for a region the particle does not have | `E_GEOMETRY` at the key |
| a missing kernel radius, layer thickness, material, mesh count, a power in none or two forms, a mesh key the particle does not have | `E_SCHEMA_INVALID` at the field |
| a compact power density without a packing fraction; a material without a conductivity | `E_PROP_MISSING` |
| a packing fraction that does nothing, mechanics, hot dimensions, burnup, an axial stack, limits, a transient, a particle that is not thermal-only or steady, a `linearHeatRate`, a closed or contacting gap, the burnup law | `E_UNSUPPORTED` at the section |
| a packing fraction of 0 or above 0.7405 | `E_OUT_OF_RANGE` |
| a count of cells below or above the bounds | `E_MESH` |
| a boundary that is missing, in two forms or incomplete | `E_BOUNDARY_INCOMPLETE` |
| a length or power in the wrong unit | `E_UNITS` |

Warnings: `W_PACKING_FRACTION` (above 0.64), `W_GAP_CONTACT` (a gap conductance above 3e5), `W_POWER_RANGE` (a kernel power density above 1e10 W/m3). Every refusal has a bad vector in `schema/vectors/bad/triso-*.json` (40 vectors in all, 308 with the pin's, the plate's and the stack's), and `tests/triso.test.ts` (29 tests) states each one's code and field.

## The independent solutions (T2)

`src/core/trisoSolve.ts` is a second method, written without any reference to OFFBEAT, for the sphere:

- **Closed form** (`trisoClosedForm`). The heat made in the kernel, P, crosses every sphere outside it, so in a shell of conductivity k(T) the conductivity integral from the shell's outer face to radius r is P (1/r - 1/b) / (4 pi); inside the kernel it is q''' (R^2 - r^2) / 6. The gap drops P / (4 pi R_g^2 h) at the buffer's outer radius, the film P / (4 pi R_o^2 h_film) at the outside. A conductivity that depends on temperature is handled by solving the integral (`solveHot`, as for the pin). It returns the temperature at every face, the drops and the temperature at any radius. A conductivity that reaches zero before the heat is carried is refused by the validator as `E_OUT_OF_RANGE` on `/materials`, as for a pin.
- **Finite-volume solution** (`solveTrisoFv`, `steadyTrisoFv`). Cell-centred, one dimension in the radius, any number of regions, cell nodes at the cell's volume centroid (where OFFBEAT reports its cells), the two half-cell resistances in series at every face (each with its own conductivity) and the gap's resistance at the buffer's outer face. Implicit Euler or Crank-Nicolson, Picard iteration for a conductivity and heat capacity that depend on temperature, heat capacity through the enthalpy so that stored energy is conserved exactly. The steady field is one implicit step of effectively infinite length, checked as a fixed point.
- **Time scale** (`trisoTimeScale`, `trisoSteadyEndTime`). The Elmore bound of the pin's argument (docs of `steadyState.ts`) on the sphere: each cell's placeholder capacity times its resistance to the coolant, with the lowest conductivity each material allows, times 1.25. The particle's bound is a fraction of a second; the steady end time is the pin's floor (5e7 s) unless the bound needs more.
- **Quick look and derived numbers** (`trisoQuickLook`, `trisoDerived`): the closed form with an out-of-domain check per region (a region whose temperatures leave its conductivity's stated range is named, never extrapolated), and the heat per particle, the kernel's power density, the volumes, the heat flux at the outer surface, the compact's particle count per cubic metre, the drop of each region and of the gap, and the time scale.

**What was checked.** The closed form against arithmetic written in the test and against a Runge-Kutta integration of the conduction equation for conductivities that fall with temperature (agreement to 1e-6 K). The finite-volume solution against the closed form (second order in the cell width: the error falls by 2.5 or more each time the mesh is doubled), against the exact series of a sphere with a heated core and a prescribed wall (constant properties; Crank-Nicolson to 0.5 %, implicit Euler to 3 % of the rise at 1/400 of the slowest decay time), for conservation of energy to 1e-9 of the heat made with a time-dependent power and properties that depend on temperature, for the order in time (implicit Euler first order, Crank-Nicolson second), and **cell by cell against two saved OFFBEAT runs of the same particle** (tests/golden/offbeat-triso: a prescribed wall at 48 cells per layer, within 0.1 K of a rise of 48 K; a convective outside at 12 cells per layer, within 0.15 K of a rise of 85 K). The time scale against the sum written out in the test and against the measured slowest decay of the finite-volume field (the bound is above it, within a factor 40).

**Not yet:** the case-level transient of a particle (a power history in the case, heat capacities for the layers) is built with the solver in T3, where it can be compared with OFFBEAT; the solutions above already take a power history and heat capacities as inputs.

## The geometry kernel

`src/core/geometry.ts` has a third shape beside the cylinder and the slab: `SPHERE`, with area 4 pi r^2, the resistance of a shell (1/a - 1/b) / (4 pi k), the volume of a shell 4/3 pi (b^3 - a^3), and the cell centre OFFBEAT reports, the volume centroid of the shell 3/4 (b^4 - a^4) / (b^3 - a^3). Every quantity is for the whole sphere, not per unit length. The tests check each against a quadrature written in the test. The pin's and the plate's results are unchanged (the cylinder and slab entries only gained a `sphere: false` flag).

## What changed for the pin and the plate

The case schema no longer requires `fuel` and `cladding` materials or `fuelCells` and `claddingCells` (a particle has other regions); the validator requires them for a pin or a plate and refuses a missing one with `E_SCHEMA_INVALID` at the field itself (`/materials/fuel`, `/mesh/claddingCells`), where the schema used to refuse the whole section. The validator's gap and boundary reading were moved into two functions both cases use, with the same messages.
