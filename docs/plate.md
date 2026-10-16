# The plate (plan 12, A4)

A case may describe **a plate** instead of a pin: heat made uniformly in a slab of fuel (the meat), a gap, a cladding, cooled on one face, in **one dimension through the thickness** (plan 12, [docs/plans/12-axial-stack-and-plate.md](plans/12-axial-stack-and-plate.md)). It is the case the outside test of the suite (finding F17) could not run: how fast does a plate heat when its cooling is lost. **Status 2026-10-14 (milestone A4): steady and transient plates run through the real solver and are checked against slab closed forms and a slab finite-volume solution.** A plate stack along its height is A5; the editor panel is A6.

```json
"assumptions": { "thermalOnly": true, "steadyState": true, "geometry": "1D-slab" },
"geometry": {
  "kind": "plate",
  "fuelHalfThickness": { "value": 4.1,  "unit": "mm" },
  "gapThickness":      { "value": 0.08, "unit": "mm" },
  "claddingThickness": { "value": 0.57, "unit": "mm" }
},
"power": { "linearHeatRate": { "value": 20, "unit": "kW/m" } }
```

- **The geometry.** The meat runs from an **insulated mid-plane** (x = 0, the symmetry plane of a plate cooled equally on both faces, or an adiabatic back) to `fuelHalfThickness`; then the gap (a thickness, zero allowed with an explicit conductance, as for a pin), then the cladding. The coolant is on the outer face. The case's own `boundary`, `gap`, `materials`, `mesh` and `transient` are as for a pin; `assumptions.geometry` is `1D-slab` (a pin's is `1D-radial`: the other is refused).
- **The heat rate is per metre of height per metre of width** (the unit is still `W/m`, `kW/m`): the plate is one metre wide and its flux through the face is the heat rate per square metre. The sanity warning for a pin's heat rate does not apply.
- **Refused for a plate, with the reason:** a radius or a central hole (a plate has none), hot dimensions, mechanics, a burnup, a point-kinetics pulse (its feedback is the pin's), and a stack along the height (A5).
- **Normalised** as `plate: true`, with `fuelRadius` the half-thickness, `claddingInnerRadius` and `claddingOuterRadius` the positions of the cladding's faces from the mid-plane, `fuelInnerRadius` 0. Every place that used the cylinder's formulas takes its geometry from `src/core/geometry.ts` (the area per unit length, the resistance of a layer, the cell volume, where OFFBEAT puts a cell's centre), so the pin and the plate share one code path and the pin's results are unchanged to the last digit.

## What is written and what it is checked against

- **The files** (`caseWriter.ts`): a Cartesian mesh, the meat from x = 0 (no patch there: a default `empty` face carries no heat, the insulated plane), one metre wide in y, the side and end faces `empty`, no wedge anywhere, `angularFraction 1` (OFFBEAT wants it when there is no wedge), `lhgr` the heat rate per metre of height and width. The probe ([docs/spike/axial-plate-probe.md](spike/axial-plate-probe.md)) found all of this; nothing else needed changing.
- **The closed forms** (`compositeSlab`, `slabFuelIntegral`): the film drops q'/h, the cladding of thickness t has the conductivity integral q' t, the gap q'/h_gap, and the meat from x to its face q' (L^2 - x^2) / (2 L) (the heat made between 0 and x is q' x / L). For the synthetic numbers the centre is 573 + 0.667 + 0.76 + 4 + 13.667 = **592.093 K**, worked by hand in the tests; for a conductivity that depends on temperature the tests check the integral by an independent numerical quadrature.
- **The transient** uses the slab finite-volume solution (the same kernel as the pin's with the slab's areas, resistances and volumes). It is checked against the exact series for a plate that cools through a prescribed wall (cosine eigenfunctions, to 0.5 % of the drop) and by heat conservation to 1e-9, and then against OFFBEAT at run time exactly as for a pin (cross-check, energy balance, time step, wall, property ranges, limits).
- **The checks of a steady plate**: the energy balance (the flux between the two innermost cladding cells against the heat rate), the fuel and cladding profiles against the slab closed form to the mesh bound 5 dT / N^2, the wall temperature, the property ranges, the steady-state gate; they are the pin's with the slab's formulas.

## What the real runs showed (`tests/plateSolver.test.ts`, golden output in `tests/golden/offbeat-plate/`)

- A steady plate: every check passes; the centre is **592.0933 K** against the closed form 592.0933 K; the fuel profile differs from the closed form by 0.009 K (the mesh bound is 0.17 K), the cladding by 3e-6 K, the energy balance by 5e-5. With a prescribed wall (618.427 K) and with a conductivity that falls with temperature: every check passes.
- A 10 ms pulse into a cold plate: every check passes and the peak is the adiabatic one, T0 + E'''/c, to 2 %.
- **The loss of cooling** (the question of F17): a plate at 20 kW per metre of height and width, started from its steady state, the film coefficient falling from 30000 to 100 W/m2/K over 1 s: every check passes (cross-check against the slab finite-volume solution, energy balance, time step) and the plate warms by tens of kelvin and is still warming at 60 s.
- Read as a pin the same output fails: a steady plate's closed-form, cladding and energy checks fail, and a transient plate's cell centres are refused (the cylinder's mesh puts them elsewhere).

## Limits

- One face cooled (the other insulated, or the mid-plane of a plate cooled on both faces); no boiling, no critical heat flux, no melting: the film coefficient is an input (the boundary history makes it a function of time).
- A plate cooled differently on its two faces, or with a different fuel on either side, is not offered.
- Mechanics, burnup and hot dimensions are for pins. The plate's temperature limits are as for a pin (`limits`, judged on the meat and the cladding).

## In the editor (milestone A6, plan 12)

The Pin dimensions item has a **Shape** choice, *Pin* or *Plate*. Switching converts the dimensions without changing them (a plate's meat half-thickness is the pin's fuel radius, its gap and cladding thicknesses are the pin's gap and wall), keeps the units the person typed for the meat, and removes what a plate cannot have (a central hole, hot dimensions, burnup, mechanics, a point-kinetics pulse), saying so in the log. The item is then named *Plate dimensions*; the Hot dimensions, Burnup and Mechanics items say *not for a plate*. The pin's cross-section is drawn as a slab (the insulated mid-plane dashed on the left, the meat coloured by temperature, the gap, the cladding, the coolant on the right, to scale), and the profile's axis is *x (mm from mid-plane)*. The Power note says that for a plate q′ is per metre of height per metre of width.
