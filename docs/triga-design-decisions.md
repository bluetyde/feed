# TRIGA design decisions

Five decisions from the TODO's fuel-library item, each with what FEED does now, why, and what would change it. I chose the defaults below from the sourced SAR material in the repository, and **the user confirmed all five on 2026-10-07** ("keep all five") after each was explained. They stand until the user changes one.

## 1. Cladding: stainless steel first

**Now:** the TRIGA presets are stainless steel 304 cladding (K-State SAR Table 13.3, 14.9 to 19.8 W/m/K over 300 to 600 K; three library entries: constant, linear, tabulated). The limit set is stainless-only.
**Why:** both SARs in the repository (K-State: stainless fuel inventory, two aluminium-clad instrumented spares; UT-Austin: stainless) describe stainless-clad fuel as the design case, and the limits and strength figures that were read are for it.
**Aluminium:** no sourced properties and no sourced limit are in the library, so there is nothing to offer; a case may still state its own aluminium material and its own limits with their sources. **Would change:** a source for aluminium conductivity, heat capacity and its fuel temperature limit.

## 2. U-ZrH hydrogen ratio: one ratio, no dependence

**Now:** U-ZrH at H/Zr about 1.6 (`triga-uzrh-h16`, k = 18 W/m/K from the K-State SAR). The material has no hydrogen-ratio parameter and the limit set says it is for H/Zr 1.6.
**Why:** the conductivity and heat capacity of the hydride depend on the ratio, but the repository has sourced values for one ratio only; a dependence invented between sources would be a made-up property. The SARs' limits are stated for that ratio (and for fuel at 1.65 or more pulsed to about 1150 °C without damage).
**Would change:** a sourced correlation k(T, H/Zr) and c(T, H/Zr) (the editor would then need a ratio field and the limit set a ratio range).

## 3. Gap: the SAR's conductance, as given (cold)

**Now:** the gap is an effective conductance the case states (constant), as the SAR cases do; the dimensions are the case's own, with no thermal expansion. The design view says so.
**Why:** OFFBEAT's only gap model without mechanics is `resistiveGap` with a constant conductance ([property survey](spike/property-model-survey.md)); a hot gap needs thermal expansion of pellet and cladding and a gas model, which need mechanics.
**Effect to know:** a real gap closes as the fuel heats and swells, so a constant cold-gap conductance is a stated assumption; the case's source note carries which one it is.
**Would change:** hot dimensions (a modest change to the geometry arithmetic and checks, the "hot dimensions" option in the roadmap) or mechanics (F4).

## 4. Axial layout and reflectors: not modelled, one radial slice

**Now:** FEED is one radial slice at the hottest axial position (the "hot channel" of the K-State and UT cases): the axial power shape and the radial peaking are carried in that slice's linear heat rate. The graphite end reflectors of a TRIGA element, the axial zirconium rod and the plenum are not modelled; heat flow along the axis is ignored.
**Why:** FEED's solver case is 1D radial. Ignoring axial conduction from the hot slice to its cooler neighbours makes the peak temperature higher than a full axial model would give, so for the peak and the limits the omission errs on the high side; it is not a statement about the reflectors' neutronics.
**Would change:** a 2D axisymmetric case (a different mesh and case writer, and the pin design extended with axial layers). Not planned.

## 5. Central zirconium rod: the hole is a hole, with an insulated surface

**Now:** an annular fuel has a central hole whose surface is insulated (the series solution and OFFBEAT's mesh both treat it so, [closed forms](plans/04-verification.md)). The zirconium rod that sits in a TRIGA element's hole is not modelled.
**Why:** a rod in contact with the hole surface would carry some heat to the end of the element and to the gas; with no sourced contact conductance or rod properties in the repository, an insulated hole is the stated simplification. It errs on the high side for the fuel temperature.
**Would change:** a conducting inner boundary with a sourced rod and gap (a boundary-condition change in the writer and the closed forms).
