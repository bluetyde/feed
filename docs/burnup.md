# Burnup: the conductivity of burnt UO2 fuel

A case may state a **burnup** for its fuel, and the fuel's conductivity follows it. This is a *frozen-burnup snapshot*: the same pin as stated, with fuel that has this burnup. It is not the history of a rod and not a fuel-performance prediction. Plan: [plan 10](plans/10-burnup.md). Sources and checks: [burnup-sourcing.md](spike/burnup-sourcing.md) and [burnup-probe.md](spike/burnup-probe.md).

## What a case says

```json
"materials": { "fuel": { "materialId": "uo2-nfi-95td", "revision": 1, "sets": { "thermal.conductivity": {
  "model": "uo2-nfi",
  "densityFraction": { "value": 0.95, "unit": "1" },
  "source": "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11 ..."
} } }, "cladding": { "...": "..." } },
"burnup": { "value": { "value": 40, "unit": "MWd/kgHM" }, "basis": "heavy-metal", "source": "chosen for this study" }
```

- **The material** (`model: "uo2-nfi"`, fuel only) states the as-fabricated density as a fraction of theoretical (0.92 to 0.97), optionally the gadolinia weight fraction (`gadolinia`, 0 to 0.1) and optionally a temperature `validRange` inside 300 to 3000 K. Its 13 constants are the model's and are not the material's to change.
- **The case** states the burnup: `value` in MWd/kgHM, GWd/tHM (the same number) or MWd/tHM, a `basis` that must be `heavy-metal` (an oxide basis is refused), and a `source`. 0 is fresh fuel and is **stated**, not assumed: a fuel with the model and no burnup is refused (`E_PROP_MISSING` at `/burnup`), and a burnup with a fuel that does not use it is refused (`E_UNSUPPORTED`, it would change nothing). A burnup outside 0 to 62 MWd/kgHM is refused (`E_OUT_OF_RANGE`).
- **Steady cases only.** A burnup in a transient is refused (`E_UNSUPPORTED`): the conductivity would be frozen over the pulse.
- **The model name is the declaration that the fuel is UO2.** FEED does not read the material's label or composition, so a case that gives a TRIGA or other non-oxide material this model is not refused; the results would be those of oxide fuel. Choose the model only for UO2.
- **TRIGA fuel has no burnup model here**: OFFBEAT's burnup field and every burnup-dependent conductivity model it has are for oxide fuel, and the SARs give no burnup dependence for U-ZrH.
- It works together with hot dimensions.

## The model

FRAPCON-3.4's modified NFI conductivity (NUREG/CR-7024, Luscher and Geelhood, 2010, Eq. 2.3-10 and 2.3-11, pages 2.11 and 2.12; range of applicability section 2.3.2, page 2.20): `K95 = 1 / (A + a gad + B T + 0.00187 Bu + (1 - 0.9 exp(-0.04 Bu)) 0.038 Bu^0.28 h(T)) + (E / T^2) exp(-F / T)`, `K = 1.0789 K95 d / (1 + 0.5 (1 - d))`, with `h(T) = 1 / (1 + 396 exp(-6380 / T))`, T in kelvin, Bu in GWd/tU, `d` the density fraction. **It is not MATPRO**: MATPRO's fuel conductivity has no burnup term (OFFBEAT's name for it, `UO2MATPRO`, is a misnomer). Valid for 300 to 3000 K, rod-average burnup 0 to 62 GWd/MTU, 92 to 97 % TD and 0 to 10 wt% gadolinia. The cladding in the example uses MATPRO's Zircaloy conductivity (CTHCON, Eq. 3.2-1), also from that report.

## What OFFBEAT is given

`conductivityModel UO2MATPRO` with `densityFraction`, `GdContent` and all 13 parameters written (par13 = 16361, the report's, not OFFBEAT's default 16360; an omitted parameter takes a default without a word); `burnup constant;`; and a `0/Bu` file of **B x 1000 x 0.881** MWd per tonne of oxide in every fuel cell and 0 in the cladding. OFFBEAT's `Bu` is per tonne of the material's mass, and this model divides it by its own 0.881 to get GWd/tU, so a heavy-metal burnup needs no factor from the fuel; the Lassmann model's 0.8815 is not used (writing it would put the conductivity 95 ppm off at 40 MWd/kgHM).

## What a result carries

Every result, CSV export and comparison of a burnup case says, after the thermal-only sentence: **"Frozen-burnup snapshot: the fuel's conductivity is that of fuel with B MWd per kg of heavy metal, everything else as stated. Nothing evolves: there is no swelling, densification, relocation or fission-gas release, and the gap is the stated one, not the closed gap of burnt fuel. It is not a fuel-performance prediction."** The editor shows it under the page banner while the case is edited. The run also carries two checks that read OFFBEAT's own fields: `burnupConductivity` (its conductivity in each fuel cell against FEED's law at its own cell temperature, accepted to 1e-4, observed 1e-5) and `burnupWritten` (its `Bu` against what was written, accepted to 1e-5). A result without those fields fails them. A comparison of two runs carries each run's own statement.

## In the editor

The fuel's conductivity model list offers **UO2 with burnup (modified NFI)**; choosing it adds a Burnup item (under Materials) with the value, its unit and its source (to fill in: the source starts empty and the case is refused until it is stated). **Show the cost of burnup** plots the closed-form centre and surface temperature of the fuel against burnup, 0 to 62 MWd/kgHM, for the same pin, with the case's own burnup marked, and a table of the plotted values for a screen reader. A point whose fuel runs outside the model's stated temperature range is drawn as a hollow mark and listed in words under the plot. Those are **independent estimates** (FEED's own closed form on the law, no solver); the solver's run at the case's own burnup is the check at that one point. On the example `lwr-uo2-burnup` (a typical PWR pin at 20 kW/m) the centre goes from 1235 K fresh to 1466 K at 40 and 1560 K at 62 MWd/kgHM.

## Not done

Swelling, densification, relocation and fission-gas release; the closing of the gap; a radial burnup profile (the rim); a burnup history; MOX and the Halden correlation (NUREG/CR-7024 Eq. 2.3-12 and 2.3-13, each needing its own sourcing); gas-gap mechanics for gas-cooled reactors (kept in notes in plan 10); importing a burnup from a depletion record is done as a SEED transfer ([transfer-burnup.md](transfer-burnup.md)); regions finer than one per burnable material (axial slices) wait on OpenMC Studio.
