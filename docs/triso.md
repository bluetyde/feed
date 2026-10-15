# The coated particle (plan 13)

A coated particle (TRISO) is a sphere: a fuel **kernel** and two to four coating layers (buffer, inner pyrolytic carbon, silicon carbide, outer pyrolytic carbon). FEED treats it as one-dimensional in the radius (spherically symmetric), **thermal only and steady**. Heat is generated in the kernel and leaves through the layers to the outside.

**Status (milestone T1, 2026-10-15): the case is read and checked, and nothing runs it yet.** A valid particle case is answered with "valid, but nothing runs it yet" by the editor's check, the run manager and the command line; its independent solution is milestone T2, the solver T3, the editor T5. The reasons for each choice below are in [plan 13](plans/13-triso-particle.md) and [the probe](spike/triso-probe.md).

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

## The geometry kernel

`src/core/geometry.ts` has a third shape beside the cylinder and the slab: `SPHERE`, with area 4 pi r^2, the resistance of a shell (1/a - 1/b) / (4 pi k), the volume of a shell 4/3 pi (b^3 - a^3), and the cell centre OFFBEAT reports, the volume centroid of the shell 3/4 (b^4 - a^4) / (b^3 - a^3). Every quantity is for the whole sphere, not per unit length. The tests check each against a quadrature written in the test. The pin's and the plate's results are unchanged (the cylinder and slab entries only gained a `sphere: false` flag).

## What changed for the pin and the plate

The case schema no longer requires `fuel` and `cladding` materials or `fuelCells` and `claddingCells` (a particle has other regions); the validator requires them for a pin or a plate and refuses a missing one with `E_SCHEMA_INVALID` at the field itself (`/materials/fuel`, `/mesh/claddingCells`), where the schema used to refuse the whole section. The validator's gap and boundary reading were moved into two functions both cases use, with the same messages.
