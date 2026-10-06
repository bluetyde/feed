# The pin as a designer states it

A case stores the pin as three radii (fuel, cladding inner, cladding outer) and an optional central hole. A designer thinks in **diameters and thicknesses**: the pellet diameter, the gap between pellet and cladding, the cladding wall. The Geometry panel's **Design view** lets you enter the pin that way and shows what follows from it. The case still stores radii, and nothing here reaches the solver. Code: `src/core/design.ts`; the route `POST /api/design`; `derived.design` in every `/api/check` answer. Tests: `tests/design.test.ts`.

## What it shows

Fuel diameter, central hole diameter (0 is solid fuel), radial gap, cladding wall, cladding outer diameter; and, read off the case, the fuel's cross-section (an annulus when there is a hole), the cladding's, the wall over the outer diameter, the gap over the fuel diameter, and the volumetric power at the case's peak heat rate. The cross-section in mm² is the fuel volume per metre of pin in cm³.

## What stays when you change one

| You change | What stays | What moves |
|---|---|---|
| Fuel diameter | the gap and the cladding wall | the cladding, with the fuel |
| Gap | the cladding wall | the cladding (both surfaces), outwards |
| Cladding wall | the cladding's inner surface | the outer surface |
| Cladding outer diameter | the cladding's inner surface | the outer surface (so the wall changes) |
| Central hole diameter | everything else | only the hole |

A new value is written back into the case in **the unit each radius already had** (a pin in mm stays in mm, however the value was typed), to 12 significant digits so that 8.4 mm gives a 4.2 mm radius and not 4.2000000000000002. The geometry's other keys are kept.

## What it refuses, and what it leaves to the validator

It refuses a value with no unit or the wrong one, a diameter or wall of zero or less, and a negative gap or hole (`E_UNITS`, `E_OUT_OF_RANGE`; the case is not changed and the editor says why). It does **not** judge the pin: a hole wider than the fuel, or a zero gap, is applied and the case validator gives its own verdict (`E_GEOMETRY`, or the rule that a zero cold gap needs an explicit effective gap conductance). So the design view cannot make a case valid that the validator would refuse, and cannot hide why.

## Not done

- Hot dimensions (thermal expansion): the gap and diameters are the case's, as given; nothing is corrected for temperature.
- Axial layout, and any dimension other than the pin's radial ones (plenum, reflectors).
- A pitch, a lattice or a coolant channel: FEED models one pin with its boundary.
