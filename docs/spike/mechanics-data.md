# Mechanics M1: what the sources give for the mechanical properties

Done 2026-10-10 for [plan 09](../plans/09-mechanics.md), milestone M1. **Question:** what do the documents we hold give for Young's modulus, Poisson's ratio and thermal expansion of TRIGA fuel (U-ZrH) and its stainless steel cladding, and for the strength of the cladding? Which of the user's two answers (cladding plasticity, the hydrogen pressure as an input) can the data support? The documents are kept outside this repository (not redistributed); pages are the documents' own.

## The properties

| Property | Value | Source | How good |
|---|---|---|---|
| **U-ZrH, Young's modulus** (delta phase, H/Zr 1.6) | 9.1e6 psi (62.7 GPa) at 20 C, 6.0e6 psi (41.4 GPa) at 650 C | UT-Austin SAR 2023 Table 4.1 (page 4-1); K-State SAR 2004 (the same table, source "Texas SAR 1991") | the SARs' own design values; two points, linear between them is an assumption of ours |
| the same, measured | 63,000 MPa at room temperature, about 41,000 MPa at 650 C ("dynamic elastic modulus", on ZrH1.6) | Simnad, General Atomic E-117-833, section 2.11, page 2-31 (Ref. 17 there) | primary, and agrees with the SARs to 0.5 %; it is measured on the hydride **without uranium** |
| **U-ZrH, Poisson's ratio** | 0.32 | Sandia SAND2009-7374C (Black et al.), slide 9 | **secondary**: a given value of a finite-element analysis; **no SAR or General Atomic report we hold gives one** |
| **U-ZrH, thermal expansion** | `4.52e-6 + 19.25e-9 T(C)` per C (SNAP data); `7.38e-6 + 15.1e-9 T(C)` (measured, 45 wt% uranium) | Simnad E-117-833 section 2.10, pages 2-26 to 2-31; the first is also on Sandia slide 9 | primary; both in `library/expansion.json` |
| **U-ZrH, strength** | tensile strength to 650 C 24,000 psi (165 MPa); compressive strength at 20 C 60,000 psi (414 MPa); compressive yield at 20 C 35,000 psi (241 MPa) | UT-Austin SAR Table 4.1; K-State SAR | the SARs' design values, one number each, no temperature curve; brittle material that creeps at elevated temperature (Simnad Fig. 2-17) |
| **SS 304, Young's modulus** | 1.9e11 Pa (190 GPa) | Sandia SAND2009-7374C slide 9 | **secondary**, one value, no range; stainless steel's modulus falls with temperature (about a fifth over 600 K) |
| **SS 304, Poisson's ratio** | 0.3 | Sandia slide 9 | secondary |
| **SS 304, thermal expansion** | 17.2e-6 per K | Svajger et al. 2024 eq. (4.7), citing Kraut et al. | secondary, no range (already in `library/expansion.json`) |
| **SS 304, yield and ultimate strength** | 2.0e8 Pa (yield) and 5.1e8 Pa (ultimate) at 154 C; a curve from 400 to 1100 C in UT-Austin Figure 4.3a (below) | Sandia slides 11 and 17; UT-Austin SAR section 4.2.1, Figure 4.3a (reference: Carpenter and Crucible Steel) | one point at 154 C; a figure from 400 C up |

No document we hold gives a stainless steel modulus against temperature, a Poisson's ratio from a primary source, a stress-strain law for the cladding, or creep of the cladding.

## Answer to the user's first decision (plasticity)

The user said: check whether the UT SAR figures 4.3a and 4.3b supply yield strength against temperature; if they do, include cladding plasticity; if not, thermo-elastic only.

- **Figure 4.3a** (on PDF page 70, read as an image) gives the **ultimate tensile strength and the 0.2 % yield strength** of the stainless steel against temperature, on a logarithmic stress axis in psi, **from 400 to 1100 C only**. Read roughly from the plot: at 400 C the ultimate and the yield strength are near 9e4 and 4e4 psi, and both fall steeply above 700 C, the ultimate to a few thousand psi at 1100 C.
- **Figure 4.3b** gives the ultimate strength of 304 SS from 500 to 1100 C against the hoop stress of the hydrogen pressure in ZrH1.65, and they cross at about 960 C and about 9e3 psi, which the text rounds to 950 C.
- So the figures do supply a yield strength against temperature, but only above 400 C, read from a log plot (a digitised value is good to perhaps 5 to 10 %), and **they give no stress-strain law** (no hardening, no strain at which the yield is reached) and nothing below 400 C except Sandia's single point at 154 C, which is where the cladding of a TRIGA runs in steady operation (about 300 to 600 K).
- **Conclusion: the data support a stress limit, not a plasticity model.** A plastic cladding needs a constitutive law we cannot source; an elastic-perfectly-plastic law with the yield strength alone would be a made-up law below 400 C. Recommended, as the user's rule says: **thermo-elastic only**, with the two strength curves used for stress-limit rules in M4 (decision 6). This is the answer to the user's condition; it is the user's to confirm.

## Answer to the fourth decision (the hydrogen pressure as an input)

The user accepted the pressure as a sourced input against fuel temperature, digitised from a figure. **It is not a figure**: the General Atomic report gives the correlation itself (Simnad E-117-833, section 2.4 "Dissociation pressures", pages 2-10 and 2-11, the equilibrium hydrogen pressure of the delta phase, and Sandia slide 10):

`log10 P(atm) = K1 + K2 x 10^3 / T(K)`, with `K1 = -3.8415 + 38.6433 X - 34.2639 X^2 + 9.2821 X^3` and `K2 = -31.2982 + 23.5741 X - 6.0280 X^2`, `X` the H/Zr atom ratio.

Checked against the UT-Austin figure: at X = 1.65 it gives 0.67 MPa at 900 C, 1.56 MPa at 960 C and 14.0 MPa at 1150 C; with the SAR's thin-shell factor (hoop stress is 36.7 times the pressure for its 1.5 in diameter and 0.02 in wall) the stress at 960 C is 8.3 ksi, where Figure 4.3b shows the ZrH1.65 curve crossing the strength curve at about 9 ksi. At X = 1.6 and 1000 C it gives 1.66 MPa of hydrogen, and Sandia's total gas pressure there is 2.44 MPa (hydrogen plus the backfill and fission gases). So the M4 input can be this formula with its source, instead of a digitised table; the case still states it as an input with the source, and FEED computes no fuel hydrogen inventory.

## What M1 built

- `mechanical.elasticity` (constant, or `E = a + b T` over a stated range, with Poisson's ratio and the source) and `mechanical.thermalExpansion` (the hot-dimension law with its source) as material property sets, checked whenever present, in Pa, GPa, MPa, kPa, psi, ksi and per kelvin (`src/core/validate.ts`, `src/core/units.ts`). Poisson's ratio from 0 up to 0.5; a modulus between 1e7 and 5e12 Pa; a linear modulus positive and in bounds over the whole range.
- A case with `assumptions.thermalOnly: false` that lacks a set is refused naming the set, the material and the solid (`E_PROP_MISSING`, besides the refusal that mechanics is not solved yet). OFFBEAT itself stops fatally on a missing mechanical property ([the M0 probe](mechanics-probe.md)); FEED stops earlier and says which.
- Library: the TRIGA fuel `triga-uzrh-h16` (revision 3) and the three stainless steel claddings (`ss304-k166` and `ss304-ktemp` revision 3, `ss304-ktable` revision 2) carry the sets above; the thermal sets are as they were.
- Tests: `tests/mechanicalSets.test.ts` (18), nine vectors (one good, eight bad), the library test.

## Not done, and open

- **Poisson's ratio of the fuel and the steel from a primary source**: the values are Sandia's. A handbook value with its range would replace them.
- **The modulus of stainless steel against temperature**: constant 190 GPa over a range where the real value falls by about a fifth; the library entry says so. A primary source would give a linear law over a range.
- **The strength curves** (UT-Austin Figures 4.3a and 4.3b) are not digitised yet: that is M4 (stress limits).
- **The pulsing limit for low-enriched fuel**: the UT-Austin SAR (page 4-6) also cites General Atomics (2008, *Pulsing Temperature Limit for TRIGA LEU Fuel*) for a pulsing limit of **830 C** on the fuel of a conversion core; our limit sets are for standard 8 to 12 wt% fuel (1150 C and 950 C). Not in the library; the report is not in the research folder.
