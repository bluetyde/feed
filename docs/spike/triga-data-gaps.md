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
