# M1 of the burnup plan: where the numbers come from

Done 2026-10-07 for [plan 10](../plans/10-burnup.md), milestone M1, after the user allowed the fetch. **Question:** can the equation and the 13 constants of OFFBEAT's `UO2MATPRO` conductivity, and a Zircaloy conductivity, each be put on a page of a document, with their range of validity? **Answer: yes, but the model is not MATPRO.**

## The documents (copies kept outside this repository, not redistributed; the maintainers' notes record their sources and SHA-256)

| File | What it is | Source and size |
|---|---|---|
| `NUREG-CR-7024 PNNL-19417 Material Property Correlations FRAPCON-3.4 FRAPTRAN-1.4 MATPRO (2010).pdf` | W. G. Luscher and K. J. Geelhood, PNNL, for the NRC, August 2010: the material property correlations of FRAPCON-3.4 and FRAPTRAN 1.4 compared with each other and with MATPRO, with their ranges, uncertainties and Fortran | pnnl.gov, 604 KB |
| `NUREG-CR-0497 TREE-1280 MATPRO-Version 11 (1979).pdf` | MATPRO Version 11, a handbook of materials properties for LWR fuel rod analysis, EG&G Idaho, February 1979 (the first issue; revisions followed) | OSTI copy on the UNT digital library, 21.7 MB |

The NRC's own site refused scripted downloads (HTTP 403), so the NUREG/CR-7022 volume (the FRAPCON-3.4 manual, ML11101A005) was **not** fetched and is not needed: NUREG/CR-7024 prints the same equations. Nothing was circumvented.

## The finding: `UO2MATPRO` is not MATPRO

OFFBEAT's source comment says "MATPROv11". The MATPRO report's fuel conductivity (its subcode FTHCON, Eq. A-2.1) is `k = 40.4 / (464 + T) + 1.216e-4 exp(1.867e-3 T)` W/cm/K, T in degrees C, **with no burnup term** (the 2010 report says so too: "unlike the MATPRO model, the modified NFI model can account for degradation of thermal conductivity with increasing burnup"). The equation OFFBEAT runs is **FRAPCON-3.4's modified NFI model**, with a gadolinia term and a density correction:

- NUREG/CR-7024 **Eq. 2.3-10** (page 2.11): `K95 = 1 / (A + a gad + B T + f(Bu) + (1 - 0.9 exp(-0.04 Bu)) g(Bu) h(T)) + (E / T^2) exp(-F / T)`, with `A = 0.0452` m-K/W, `a = 1.1599`, `B = 2.46e-4` m-K/W/K, `f(Bu) = 0.00187 Bu`, `g(Bu) = 0.038 Bu^0.28`, `h(T) = 1 / (1 + 396 exp(-Q / T))`, `Q = 6380` K, `E = 3.5e9` W-K/m, `F = 16,361` K, T in kelvin, **Bu in GWd/MTU** (a tonne of heavy metal), `gad` the weight fraction of gadolinia.
- **Eq. 2.3-11** (page 2.12): `K_d = 1.0789 K95 d / (1 + 0.5 (1 - d))`, `d` the as-fabricated density as a fraction of theoretical (the Lucuta correction for spherical pores).
- Its history, as the report gives it: the NFI model of Ohira and Itagaki (1997), modified in January 2002 (Lanning et al. 2005) to raise the low-burnup conductivity and change the electronic term, with the gadolinia dependence of Massih et al. (1992) and the porosity correction of Lucuta et al. (1996). The report also prints FRAPCON's Fortran (Appendix A: `rphonon = 1.0/(0.0452 + 0.000246 t + 1.0 0.00187 bug + 1.1599 gadoln + (1 - 0.9 exp(-0.04 bug)) 0.038 bug**0.28 h)`, `elect = 3.50e9/t**2 exp(-16361/t)`).
- **Range of applicability (page 2.20, section 2.3.2): temperature 300 to 3000 K, rod-average burnup 0 to 62 GWd/MTU, as-fabricated density 92 to 97 % TD, gadolinia 0 to 10 wt%.** The report does not give an uncertainty for the modified NFI model in the passage read; it gives the MATPRO and NFI biases against unirradiated data (about -9.5 % with a 11 % standard deviation for MATPRO, about -2.4 % with 8 % for the modified NFI).

## Comparison with what OFFBEAT runs

| | The report | OFFBEAT's `UO2MATPRO` | Effect |
|---|---|---|---|
| `par1` to `par12` | as above (`par2` is 2.46e-4) | 0.0452, 0.000246, 0.00187, 1.1599, 0.9, 0.04, 0.038, 0.28, 396, 6380, 3.5e9, 2 | none |
| `par13` (F) | **16,361** K (the equation and the Fortran) | **16360** (the default and the value M0 ran) | at most **2e-4** in k, at 3000 K and 62 GWd/MTU, from a scan over 300 to 3000 K and 0 to 62; FEED writes 16361 |
| density factor | 1.0789 (Eq. 2.3-11) | 1.0789 | none (FRAPCON's own listing uses 1.079 in its UO2 branch: 9e-5 apart over the range) |
| burnup | GWd per tonne of **uranium** | `Bu / 1000 / 0.881` with `Bu` per tonne of oxide | consistent: 0.881 converts oxide mass to heavy-metal mass; FEED writes `B_HM x 0.881 x 1000` |

M0 had shown OFFBEAT's `k` equals this equation (with 16360) to 1e-5 in every cell; so the source's equation, not only OFFBEAT's code, is what ran.

## The Zircaloy conductivity

NUREG/CR-7024 **Eq. 3.2-1** (section 3.2.1, page 3.4), the MATPRO CTHCON correlation, the same in MATPRO, FRAPCON-3.4 and FRAPTRAN 1.4, for Zircaloy-2 and -4, ZIRLO and M5: `k = 7.51 + 2.09e-2 T - 1.45e-5 T^2 + 7.67e-9 T^3` W/m/K, T in kelvin, below 2098 K, with a standard deviation of 1.01 W/m/K (Eq. 3.2-2); 36 W/m/K at and above 2098 K. "Equation 3.2-1 predicts k very well from room temperature to the data limit of about 1800 K and may be extrapolated with some confidence to the melting point." It is **exactly OFFBEAT's `ZyRELAP` defaults** (7.51, 2.09e-2, 1.45e-5, 7.67e-9) and so exactly what FEED's cubic carrier takes: a sourced Zircaloy material needs no new model. The MATPRO report holds the same correlation (its Eq. B-2.3, cladding thermal conductivity, subcode CTHCON).

## What is still not on a page

- **A gap conductance and the pin's dimensions and power.** Not in these reports. The example takes the dimensions from OFFBEAT's own tutorial pin and a gap conductance the case states with its source; it is labelled **synthetic, properties sourced**.
- **The uncertainty of the modified NFI model** at high burnup (the passage read gives none for it; the report's section 2.7 compares it with irradiated data, figures only, not read for numbers).
- **The original Ohira and Itagaki paper** (1997) and Lanning et al. (2005): cited by the report, not fetched; the report's equations are the source FEED cites.
- **The MATPRO report's revisions.** The copy used is the first issue of Version 11 (February 1979); the unirradiated equation FEED does not use.

## What this changes

- The FEED model is called **`uo2-nfi`** ("UO2, modified NFI, as in FRAPCON-3.4"), never "MATPRO"; its source text is NUREG/CR-7024 Eq. 2.3-10 and 2.3-11 with the page and the range.
- The ranges become refusals (burnup 0 to 62 GWd/MTU, density fraction 0.92 to 0.97, gadolinia 0 to 10 wt%) and a flag (temperature 300 to 3000 K).
- `par13` is written as 16361; the other twelve as OFFBEAT's defaults, which equal the report's.
- Plan 10's M2 proceeds on these numbers.
