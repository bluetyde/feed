# TRIGA data gaps: what was checked on 2026-10-10

Done for the open sourcing items of the TODO. The documents are kept outside this repository (not redistributed). Page numbers are PDF pages.

## K-State Table 4.8, read on the scanned page (PDF page 101, SAR page 4-19)

The earlier reading used the text layer only. The scan was decoded and read (the page is a bilevel image; the text layer garbles the header row). The table, in degrees Celsius, for 1,250 kW at the hottest location:

| Pool | Fuel centreline | Fuel/gap interface | Gap/clad interface | Clad/water interface | Bulk water |
|---|---|---|---|---|---|
| 20 C | 503.2 | 229.0 | 37.7 | 21.2 | 20.0 |
| 100 C | 582.0 | 307.8 | 116.4 | 100.0 | 100.0 |

Every number of the text layer is the scan's number. On the same page, equations (8), (9) and (10) read as FEED uses them: the maximum heat flux is 0.423 P per m^2 with P in watts, and the centreline temperature is `T = Tb + 0.423 P [1/(0.0326 P + 16985) + 3.103e-5 + 3.620e-4 + 5.186e-4]`.

## K-State equation 7, the film coefficient (PDF page 100, SAR page 4-18)

The scan shows `1/h = 1 / (0.0326 P(watts) + 16985)`. The earlier worry was the digits of 16985. They are 16985 in the equation, and the fit is consistent with the figure on the same page (Figure 4.10, h against power, 500 to 1900 kW): `0.0326 x 500000 + 16985 = 33285` and `0.0326 x 1900000 + 16985 = 78925` W/m2/K, which are the two ends of the plotted line. The cladding term in the same chapter, Table 4.7, reads 3.457e-5, 3.103e-5 and 2.601e-5 m2 K/W at 300, 400 and 600 K, so the 127 C value that equation (6) and the hot-element cases use is the middle row.

## The JSI papers

Searched in full (text of every page), not by keyword only. The four burnup papers (burnup calculations of the JSI TRIGA fuel; the TRIGLAV mixed-core burnup; the Serpent-2 and RAPID reactivity-worth experiments; the RAPID burnup algorithm) contain no thermal conductivity, heat capacity or heat transfer data. Two other papers do contain some:

- A. Cammi and M. Zanetti, *Characterization of the TRIGA Mark II reactor full-power steady state* (arXiv 1503.00873): the Pavia reactor, which is **aluminium clad**. Its model uses a fuel conductivity of 16.3 W/m/K, a cladding of 0.76 mm and a gap of 0.14 mm with a conductivity of 0.05 W/m/K, and a cladding conductivity of 228 W/m/K (aluminium). The text layer loses some units (the fuel heat capacity appears as "365 kJ/kg/K"), so those would need the page images before use. A different reactor and a different cladding: not added to the library; it could serve as a cross-check of the order of magnitude only.
- The PHYSOR 2020 paper on approximations in the reactor pulse uses a temperature-dependent specific heat for the 12 w/o fuel; the values are in its figures.

## UT-Austin: film coefficient and pool temperature

The UT-Austin SAR gives **no film coefficient** for normal operation. Its hot-channel analysis (section 4.6) was run with the TRACE code, and the SAR reports the channel geometry (Table 4.19: pitch 4.3535 cm, hydraulic diameter 1.8103 cm) and results, not the correlation. The pool temperatures it states: the pool is normally controlled at about 20 C; the fuel cooling analysis assumed a core inlet of 48.9 C, the maximum permitted pool temperature (set to protect the ion exchange resin; Chapter 5, pool cooling); Table 4.20 lists 25, 27 and 49 C as the temperatures of its hydrostatic pressure cases. FEED's UT examples therefore state their boundary themselves, and say so: the hot-channel example prescribes a surface temperature of 132.9 C, and the pulse example uses a 20 C pool with an illustrative coefficient of 10 kW/m2/K.

## U-ZrH conductivity against hydrogen ratio and temperature

The paper that the K-State SAR names, Simnad 1981 (section 2.8, page 410), says that from the recent General Atomics diffusivity measurements the conductivity of U-ZrH **with H/Zr of 1.6** is insensitive both to the uranium weight fraction and to temperature. It gives the design value in cal/s/cm/C (the number is lost where two columns of the text layer meet; 18 W/m/K, the value in both SARs, corresponds to 0.043 cal/s/cm/C). So the constant 18 W/m/K in the library is supported for H/Zr near 1.6. The dependence on other H/Zr is not given in this paper, and General Atomics' own report is not in the research folder: that part stays open and matters only for fuel that is not the standard 1.6.

## Heat capacity

Needed for transients only, and the transient cases carry sourced entries (six heat capacity sets in `library/materials.json`). Nothing further.

## The General Atomic reports (added the same day, read in full for these points)

Four General Atomic reports and one Sandia slide set were added to the research folder. The most useful is the Simnad report itself (General Atomic E-117-833, GA Project No. 4314, 93 pages; its references run to February 1980), the report behind the 1981 paper. Page numbers are the report's own.

**Conductivity (section 2.8, pages 2-24 and 2-25): the open item is answered.** The report gives two things. The older design relation is `k = 0.042 + 1.79e-5 T` cal/s/cm/C (T in C), which rises from 17.7 W/m/K at 25 C to 22.4 W/m/K at 650 C. The newer measurement (short-pulse thermal diffusivity on 8.5, 30 and 45 wt% uranium, with the best density and specific heat data) found the conductivity **independent of both temperature and uranium content: `k = 0.182 +- 0.009` W/cm/C `= 0.043 +- 0.00215` cal/s/cm/C**, that is 18.2 W/m/K, plus or minus 5 %. So the 18 W/m/K constant of both SARs and of the library is the primary source's value for H/Zr of about 1.6. The report adds that the temperature independence "does not agree with measurements made by others", and that with the newer value a maximum-power-density element would run only about 50 C hotter than with the older relation. The ZrH conductivity at other H/Zr is not given in this report either.

**Heat capacity (section 2.9, page 2-25): the library entry is the primary value.** The volumetric specific heat of 8.5 wt% U-ZrH1.6 is `C = 2.04 + 4.17e-3 T` W s/cm3/C (T in C, from 0 C), which is what the UT-Austin SAR copies and what `library/materials.json` uses. GA-7882 (section 7, page 27) gives `2.12 + 4.16e-3 T` for 8 wt% U-ZrH1.7 and `857 + 1.60 (T - 25)` W s/C for a whole 385 cm3 element, and its heat content of ZrHx (from Douglas) is the enthalpy relation the 8.5 wt% figure comes from.

**Thermal expansion (section 2.10, pages 2-26 to 2-30): the open question about the 2024 paper is answered.** The report gives the SNAP-data coefficient `alpha = 4.52e-6 + 19.25e-9 T` (T in C), which is what `library/expansion.json` uses, **and** a measured coefficient for 45 wt% U-ZrH1.6: `alpha = 7.38e-6 + 15.1e-9 T` (T in C). That is the same expression the 2024 JSI paper gives without a unit, so its temperature is in degrees Celsius. The report adds that a maximum-power-density element would expand radially about 0.6 % for 45 wt% fuel against 0.5 % for 8 to 12 wt% fuel, so the 45 wt% coefficient (the one measured on TRIGA-type fuel) is not clearly closer for 8 to 12 wt% fuel than the SNAP one. Not changed in the library; the choice is for the user.

**Temperature limits (chapter 4, pages 4-1 to 4-3 and 4-6 to 4-7): the basis of the library rules.** A pulsing safety limit of 1150 C for stainless-clad U-ZrH1.65 holds while the cladding is below 500 C; where the cladding can be as hot as the fuel the limit is 950 C (the equilibrium hydrogen pressure then equals the cladding's ultimate strength); the pressure at 1150 C is at least a factor of 5 (up to 18) below what the cladding needs to fail, and TRIGA pulse tests have reached 1150 C and above. **There is a third limit the library does not have: a steady-state operational design limit of 750 C**, "based on consideration of irradiation- and fission-product-induced fuel growth and deformation" (page 4-1 to 4-3). It is a candidate rule for `library/limits.json` (open item below).

**GA-7882, Kinetic Behavior of TRIGA Reactors (1967).** The Fuchs-Nordheim kinetics model with a constant and with a variable heat capacity (section 8, from page 27), the prompt negative temperature coefficient and the film boiling discussion. It is the original of the pulse model behind FEED's point kinetics and its Nordheim-Fuchs oracle; not yet compared line by line.

**GA-471, Technical Foundations of TRIGA (1958).** The earliest design basis: hydride properties, heat transfer in the fuel, pulse analysis. Reference only; its thermal properties are older than the report above.

**Sandia SAND2009-7374C, TRIGA cladding steady-state mechanical limitations (slides).** A finite-element look at the cladding stress from the hydrogen pressure in a FREC-II element (2.44 MPa total gas pressure at a 1000 C fuel temperature) and the hoop stress against yield. Context for why FEED only compares temperature and computes no stress.

**Baldwin, Foushee and Greenwood, Fission-product release from TRIGA-LEU reactor fuels.** Release fractions of fission gas from 8.5, 30 and 45 wt% TRIGA fuel against temperature (room temperature to 1100 C), with a low-temperature and a high-temperature term, from General Atomic, November 1980. Not used yet; it is the data a gas-release lesson (the steps 5 and 6 of the TODO) would need.

Done after this, on the user's word (2026-10-10): the 750 C limit is in the library as a second set for steady operation (`triga-ss-uzrh-h16-steady-operation`: the 750 C design limit and the two safety limits; not for pulses); the SNAP expansion entry stays first and the 45 wt% measurement is added as a second fuel entry (`triga-uzrh-simnad-45wt-expansion`); GA-7882's Table VII was compared with the point-kinetics generator (`tests/gaKineticsTable.test.ts`, [point-kinetics.md](../point-kinetics.md)): it agrees.
