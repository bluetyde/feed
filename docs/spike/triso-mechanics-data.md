# Plan 14, M1: the elastic and thermal-expansion data of the coating layers, from published sources

Done 2026-10-16 for [plan 14](../plans/14-triso-mechanics.md) stage E. A literature check of Young's modulus E, Poisson's ratio nu and the linear thermal expansion coefficient alpha of the buffer, the inner and outer pyrolytic carbon (IPyC, OPyC) and the silicon carbide (SiC). **No value here comes from an OFFBEAT file** (the check was made from the published documents named below; OFFBEAT's own header comments say its classes are "taken from PARFUME", which is where the lead pointed, and the PARFUME report itself was then read). The library entries made from it are in [library/coatings.json](../../library/coatings.json).

**Result in one paragraph.** One open report, the INL PARFUME theory and model basis report, gives E, nu and alpha for all four layers with their temperature dependence and the range the models are meant for. It was fetched as a PDF, its text extracted, and the equations and tables **read from the page images** (not only from the extracted text, which garbles formulas). Everything in the library comes from that report, plus one measured SiC expansion law from a second paper that was also read in full where it matters. Other published values for the same layers were found and read (Boer et al. 2010, Tang et al. 2021, Liu et al. 2023) and **they do not agree with the report in the moduli** (a factor 1.5 for the PyC, 1.8 for the buffer); the library says so and the spread is part of the result. The report's own source for these numbers is the CEGA report CEGA-002820 (a 1993 NP-MHTGR report), **which I could not read**, as I could not read IAEA-TECDOC-978/1674 (the publisher returns HTTP 402), the Snead SiC handbook (J. Nucl. Mater. 371, 2007), Powers and Wirth 2010, or MacDonald and Thompson 1976. So: every library value has a cited publication that was read; none has been checked against the primary data behind the report.

## What was read, what was not

| Document | Status | Used for |
|---|---|---|
| G. K. Miller, D. A. Petti, J. T. Maki, D. L. Knudson, *PARFUME Theory and Model Basis Report*, INL/EXT-08-14497, 2009 (OSTI 968587, 108 pages) | **read**: sections 7.1.1 to 7.1.3 (pages 67 to 69), 7.2.3 (pages 78 and 79) as page images; the swelling polynomials (Table 7-2) seen but not used (stage I); the reference list read | all library values |
| N. Ngoepe, J. de Villiers, *The thermal expansion of 3C-SiC in TRISO particles by high temperature X-ray diffraction*, J. Nucl. Mater. 438 (2013) 88-93 (University of Pretoria repository copy) | **read**: abstract, introduction table, section 3.3, conclusion (equations 9 to 13) | the measured SiC expansion; cross-check of the report's 4.9e-6 |
| B. Boer, Y. M. Kim, W. Wu, A. M. Ougouag, D. McEachern, F. Venneri, *Inter-comparison of computer codes for TRISO-based fuel micro-modeling and performance assessment*, HTR 2010, INL/CON-10-18055, Table 1 | **read** (the table as an image) | cross-check: PyC E 3.96e4 MPa, nu 0.33; SiC E 4.0e5 MPa, nu 0.13 (the thermal expansion cells say "Ref."): no thermal expansion value, no buffer |
| C. Tang, Y. Li, et al., *Numerical simulation research on the irradiation-thermal-mechanical performance evolution of FCM fuel*, Front. Energy Res. 9 (2021) 664345 | **read** (text extract; values in running text) | cross-check: SiC 340 GPa, 0.13 (cites Snead 2007); porous PyC 20 GPa, 0.23 (cites MacDonald and Thompson 1976); dense PyC "470,000 MPa, 0.23" (cites Hales 2013): **the last looks like a misprint of 47,000 or 4.7e4 MPa, and is not used** |
| S. Liu, Y. Li, et al., *Effect of residual pore structure on the performance of TRISO particle fuel*, Front. Mater. 9 (2022) 1072255 | **read** (page image of the equations) | cross-check only: its SiC modulus polynomial, as printed, goes negative at 1000 C (a misprint in the paper or an unstated unit), so **it is not used**; it gives nu(SiC) = 0.13 and the PyC modulus form 25.5 GPa x (0.384 + 0.000324 rho)(0.481 + 0.519 BAF)(1 + 0.23 phi)(0.956 + 0.00015 T), the same as the report's |
| L. L. Snead et al., *Handbook of SiC properties for fuel performance modeling*, J. Nucl. Mater. 371 (2007) 329 | **not read** (paywalled; a search snippet says the highest SiC Poisson's ratio, 0.21, is for pure CVD SiC, and a nanoindentation paper on SiC coatings gives 391 and 442 GPa for two orientations: both second hand, not used in a value) | named only |
| CEGA Corporation, *NP-MHTGR Material Models of Pyrocarbon and Pyrolytic Silicon Carbide*, CEGA-002820, 1993 (the report's reference 25, its source for the properties) | **not found, not read** | named only |
| IAEA-TECDOC-978 (1997), IAEA-TECDOC-1674 (2012), Powers and Wirth, J. Nucl. Mater. 405 (2010) 74, MacDonald and Thompson (1976), J. D. Hales et al., J. Nucl. Mater. 443 (2013) 531, the INL materials-properties report of the ART program | **not read** (HTTP 402 or 404, or only a search summary) | named only |

## The values

All temperatures below in degrees Celsius as the report states them; the library entries are rewritten in kelvin. "phi" is the fast fluence in 1e25 n/m2 (E > 0.18 MeV), rho the density in Mg/m3, BAF the Bacon anisotropy factor.

### Dense pyrolytic carbon (IPyC, OPyC)

| Property | Value | Dependence | Source and what was read |
|---|---|---|---|
| E, tangential and radial | E = 25.5 GPa x (0.384 + 0.324 rho) x (0.481 + 0.519 BAF) [tangential] or (1.463 - 0.463 BAF) [radial] x (2.985 - 0.0662 Lc) x (1 + 0.23 phi) x (1 + 0.00015 (T - 20)); Lc = 30 Angstrom is fixed in the report, which makes the Lc factor 1 | density, anisotropy, fluence, temperature, crystallite size | PARFUME report eqs. 7-1 to 7-3, p. 68 (page image). At rho = 1.96, BAF = 1, phi = 0: 25.99 GPa at 20 C, +0.015 %/K |
| nu | 0.23, constant | "the dependency of Poisson's ratio on the various factors ... is unknown", so none is modelled; the report says 0.23 is what its source prescribes for isotropic pyrocarbon | section 7.1.3.1, p. 69 |
| alpha | alpha_r = A (-37.5 R_r + 30), alpha_t = A (36 (R_t - 1)^2 + 1), in 1e-6/C; R_r = 2/(2 + BAF), R_t = 1 - R_r/2; A = 1 + 0.11 (T - 400)/700 | anisotropy (BAF), temperature | section 7.2.3.1, p. 78 (page image). At BAF = 1 both are 5.0e-6 A: 5.0e-6 at 400 C, 5.4e-6 at 1000 C |
| Range of the models | fluence up to 4e25 n/m2 (E > 0.18 MeV); irradiation temperature 600 to 1300 C; dense PyC density 1.8 to 2.0 Mg/m3; the effects of temperature, fluence and density are assumed independent and multiply | | section 7.1.1, p. 67 |
| Other published values | E = 39.6 GPa, nu = 0.33 (Boer et al. 2010, Table 1; the benchmark-style value); E "47 GPa" or "470 GPa" in Tang et al. 2021 (a misprint, see above) | | **E differs by a factor 1.5 from the report's value at zero fluence.** The report's value rises 23 % per 1e25 n/m2 of fluence, which would reach the Boer value near phi = 2.3, but FEED applies no fluence |

### Buffer (porous carbon)

| Property | Value | Source and what was read |
|---|---|---|
| E | 5e6 psi x exp(-2.03 p) x (1 + 0.23 phi) x (1 + 0.00015 (T - 20)), p the porosity; density 1 Mg/m3 means p = 0.56 (eq. 7-4: 11.06 GPa at 20 C and zero fluence) | PARFUME report section 7.1.2.2, p. 68. The report warns that most data are for 1.5 Mg/m3 and above and the buffer needs a large extrapolation |
| nu | 0.23 | section 7.1.3.2, p. 69 |
| alpha | the pyrocarbon law with R_r = R_t = 2/3: 5.0e-6 A | section 7.2.3.2, p. 79 |
| Other published values | 20 GPa, 0.23, density 1.0, the paper citing MacDonald and Thompson 1976 (Tang et al. 2021) | **a factor 1.8 above the report**; the original was not read |

The buffer is detached from the IPyC in FEED's stage E (no contact) and is not meshed for mechanics, so these values are in the library for the stage that would mesh it.

### Silicon carbide (CVD, in the SiC layer)

| Property | Value | Source and what was read |
|---|---|---|
| E | piecewise linear in T: 427.6 GPa at 25 C, 375.2 GPa at 940 C, 340.0 GPa at 1215 C, 197.9 GPa at 1600 C | PARFUME report Table 7-1, p. 69 (page image). Independent of irradiation in the report |
| nu | 0.13 | section 7.1.3.3, p. 69; Boer et al. 2010 and Tang et al. 2021 and Liu et al. 2022 agree (0.13). Snead (not read) is reported second hand to give up to 0.21 for pure CVD SiC |
| alpha | constant 4.9e-6 /K, "mean value ... between 22 C and 1000 C", assumed constant to 1300 C; "free carbon in the SiC could reduce it by 40 %" | section 7.2.3.3, p. 79 |
| alpha, measured | 3.3047e-6 + 2.7705e-9 T (T in C), per K, 25 to 1200 C, CVD SiC shells of TRISO particles, by X-ray diffraction (instantaneous coefficient from the lattice parameter) | Ngoepe and de Villiers 2013, eq. 9. Mean over 25 to 1000 C: 4.72e-6, **4 % below the report's 4.9e-6**. The paper's own table of earlier averages runs 4.3 to 6.2e-6 |
| Other published values | E = 340 GPa (Tang et al. 2021, citing Snead 2007); E = 400 GPa (Boer et al. 2010, room temperature) | the report's value at 25 C (427.6) is 7 % above Boer's and its value at 1215 C (340) equals Tang's, so the three are consistent if the temperature of each is the one the report's table gives |

## What this means for the cases

- A stage-E case states, with the sets, which of these it uses. The library offers: `pyc-dense-parfume-unirradiated` (IPyC and OPyC), `buffer-parfume-unirradiated`, three SiC entries by temperature interval (the table has four points, so three linear pieces), and one SiC entry with the measured expansion.
- **The spread in E is as large as many of the effects the stress would be used to show.** A SiC stress that depends on E(IPyC) (the carbon's shrinkage load is carried by the SiC) changes by tens of percent between 26 GPa and 40 GPa. The result and the editor must not present one value as the carbon's modulus.
- **Irradiation is not in these numbers.** E rises 23 % per 1e25 n/m2 in the report; alpha and the layers' dimensions change with fluence, density and BAF; none of it is applied (the entries say "unirradiated"). The carbon's shrinkage is a stated free strain of the case, with its own source. A stage-I set (swelling polynomials of Table 7-2 and the creep coefficient) is a separate literature step.
- **Not checked against primary data.** The report takes these from the CEGA report. A second independent source exists for the SiC expansion (Ngoepe 2013) and the moduli in the three cross-check papers agree to within the table's temperature dependence for SiC, but for the PyC and buffer moduli there is **no** second source that agrees; they are what the report says, with the range above.
- The SiC strength distribution, the PyC creep coefficient and Poisson's ratio of creep, the swelling polynomials and the CO laws are not in this note (stages I and F).
