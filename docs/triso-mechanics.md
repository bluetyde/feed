# The mechanics of a coated particle (plan 14, stage E)

A coated particle (see [triso.md](triso.md)) may ask for **mechanics**: the stress and the displacement of its coating layers (inner pyrolytic carbon, SiC, outer pyrolytic carbon) from a gas pressure, an outside pressure, the thermal strain of FEED's own temperatures and **free strains the case states**. This is [plan 14](plans/14-triso-mechanics.md), stage E only (the owner's decision of 2026-10-16: stage E, then a gate; stages I, irradiation, and F, a failure fraction, are not approved and not built). Code: `src/core/trisoMechanics.ts` (the section, the constants), `src/core/layeredSphere.ts` (the independent solution), `src/core/trisoMechanicsWriter.ts`, `src/core/trisoMechanicsResults.ts` (the reader and the checks). The data: [spike/triso-mechanics-data.md](spike/triso-mechanics-data.md) and `library/coatings.json`.

**What it is.** Thermal plus elastic screening, not a fuel-failure code. Small strain, linear elastic, steady, one dimension in the radius (a sphere). **Every result says: "Elastic, steady: free strains are inputs, not an irradiation result."** The carbon's shrinkage under irradiation is the largest load on the SiC (the probe: 25 MPa of gas pressure puts +104 MPa in the SiC, and a 1.5 % shrinkage of the carbon with the same pressure puts -846 MPa), and in stage E it is **a number the case states, with its source**. FEED does not compute it.

**What it is not.** No swelling or creep computed from a fluence and a temperature history, no fission-gas or CO inventory (the gas pressure is stated), no buffer-to-carbon contact (the buffer is detached: it is not meshed, no force crosses the gap), no kernel, no irradiation-dependent modulus, no failure criterion, no probability. A stress is not a verdict: nothing is compared with a strength.

## The case

```json
"assumptions": { "thermalOnly": false, "steadyState": true, "geometry": "1D-sphere" },
"materials": { "ipyc": { "...": "sets include mechanical.elasticity and mechanical.thermalExpansion" }, "sic": { "...": "the same" }, "opyc": { "...": "the same" } },
"mechanics": {
  "referenceTemperature": { "value": 300, "unit": "K" },
  "outsidePressure": { "value": 0.1, "unit": "MPa" },
  "gasPressure": { "pressure": { "value": 25, "unit": "MPa" }, "source": "..." },
  "freeStrains": [ { "layer": "ipyc", "radial": { "value": -0.012, "unit": "1" }, "tangential": { "value": 0.004, "unit": "1" }, "source": "..." } ]
}
```

- **`assumptions.thermalOnly: false` and the section go together** (the flag without the section: `E_PROP_MISSING` at `/mechanics`; the section with the flag true: `E_SCHEMA_INVALID`). A particle without the section is unchanged byte for byte (`tests/writtenCasesUnchanged.test.ts`: the OFFBEAT files FEED writes for every example and good vector that existed on main are hashed against a fixture made with main's code).
- **`referenceTemperature`** (required): where the coating is free of thermal stress; not assumed to be room temperature.
- **`outsidePressure`** (required, 0 for none): on the outer face of the last layer. **`gasPressure`** (optional, `{pressure, source}`, above 0 and at most 1 GPa): on the inner face of the inner carbon. FEED has no gas inventory or release model, so the pressure is an input and **needs its source**.
- **`freeStrains`** (optional): at most one per layer (`ipyc`, `sic`, `opyc`), each with a radial and a tangential strain (both required, 0 for none, at most 0.2 in magnitude, negative is shrinkage) and a **source**. The two may differ (the carbon's dimension change is anisotropic). The buffer takes none (it carries no load here).
- **The sets**: every layer the particle has, except the buffer, needs `mechanical.elasticity` and `mechanical.thermalExpansion` with sources, under the pin's rules (a constant or a law linear in temperature over a stated range). A missing set is refused naming the set, the material and the layer (`E_PROP_MISSING` at `/materials/ipyc/sets/mechanical.elasticity`: "ipyc material 'x' has no mechanical.elasticity set; ..."). The buffer's sets are checked if present. [library/coatings.json](../library/coatings.json) holds sourced sets: the PARFUME report's dense carbon and buffer (unirradiated), the SiC modulus in three temperature intervals and one SiC with a measured expansion; the spread against other published values (a factor 1.5 in the carbon's modulus, 1.8 in the buffer's) is in the entries' descriptions.
- **Refused by name**: a transient (`E_UNSUPPORTED` at `/mechanics`), temperature `limits` (`E_UNSUPPORTED` at `/limits`: the kernel's temperature is not computed in the coating run), and inside the section `history`, `gasInventory`, `burnup`, `creep`, `swelling`, `contact`, `plane`, `failure`, `coolantPressure`, `internalPressure`, `stressLimits` (each `E_UNSUPPORTED`, saying which stage would add it), and any other key (`E_SCHEMA_INVALID`). A layer that runs outside the range of a law is **warned** (`W_ELASTICITY_RANGE`, `W_EXPANSION_RANGE`, the pin's codes), the law applied as stated.

## What is written for OFFBEAT

One coating-only mesh: the 2 degree double wedge of the thermal particle but **thinner** (0.25 degree half angle, see "The wedge" below), one block per mechanical layer, patches `inner` and `outer`. `thermalSolver constant` (no conduction solve): **the temperature of every cell is FEED's closed-form temperature of the particle at the cell's volume centroid** (`trisoSolve.ts`), kept by the solver. Pressures are `tractionDisplacement` conditions. `mechanicsSolver smallStrain`, `thermalExpansion on`, `Tref` of the case. Young's modulus and the expansion coefficient of a law of temperature are reduced to constants as for a pin (the modulus at the layer's volume-weighted mean temperature; the coefficient with the same mean thermal strain from the reference temperature), and the reduction is in the result. A **free strain** goes in through OFFBEAT's `PyC` material and its polynomial swelling model: the first coefficient is the strain per 1e25 n/m2 and one step of 10 s at a flux of 1e20 n/cm2/s is exactly that fluence, so the strain applied is the coefficient (and the elastic problem has no history). Every file, with its reason, is in the run's manifest. A run is one step; the displacement's convergence is judged (the temperature is given, so no thermal convergence is looked for). The full particle's kernel temperature is **not** computed in this run: ask for the thermal run of the same particle (the case without the section) for it.

## The independent solution

`layeredSphere.ts`: concentric elastic spheres, each with its modulus and Poisson's ratio, a uniform radial and tangential free strain and an isotropic strain that varies with the radius (the thermal strain of the closed-form profile). Radial equilibrium `d(sigma_r)/dr + 2 (sigma_r - sigma_t)/r = 0` gives `u = A r + B/r^2 + u_p`, with `u_p = (1 + nu)/(1 - nu) r^-2 integral(theta s^2 ds)` for the thermal part and `u_p = k r ln(r/a)`, `k = 2 (1 - 2 nu)(e_r - e_t) / (3 (1 - nu))`, for a uniform anisotropic strain. **The `r ln r` term is what the probe's trap was**: leave it out and equilibrium is violated and the SiC stress is 35 % wrong; a test breaks it on purpose. The constants follow from the two surface pressures and continuity of the displacement and the radial stress at each interface. Written without OFFBEAT and without FEED's finite-volume code; tested against the textbook shell, two layers of one material, a hollow sphere with a conduction profile and one with an exponential profile (Timoshenko and Goodier, integrals computed in the test), thin sublayers converging first order, the probe's face stresses (cases 3 and 4a), the thin-wall formula, signs, and equilibrium.

## The checks every result carries

Tolerances fixed in `trisoMechanicsResults.ts` before the first golden run (the probe's cell values were within 0.03 % tangential, 0.2 % radial of a layer's peak; the plan's 1 %):

| Check | What | Tolerance |
|---|---|---|
| `mechanicsStress` | every cell's tangential and radial stress against the independent solution at the cell's own radius | 1 % of the layer's stress scale + 10 kPa + a wedge allowance (below) |
| `mechanicsDisplacement` | the radial displacement, on the wedge's sphere (scaled by the wedge's factor) | 0.5 % of the layer's largest + 1e-10 m |
| `mechanicsEquilibrium` | OFFBEAT's own stress between neighbouring cells of a layer, residual times the layer's thickness | 2 % of the scale + 10 kPa |
| `mechanicsInterface` | radial stress and displacement either side of each interface, each extrapolated linearly from the two nearest cells | 2 % of the scale + 10 kPa, 0.5 % |
| `mechanicsSymmetry` | the two tangential stress components (yy, zz) | 1e-6 of the scale + 1 Pa |
| `mechanicsOffAxis` | the displacement perpendicular to the radius and the shear stresses (zero for a sphere) | 1e-6 of the layer + 1e-12 m; 1e-6 of the scale + 1 Pa |
| `mechanicsTemperature` | the field the solver kept against the closed form | 0.01 K |
| `mechanicsFreeStrain` | OFFBEAT's own swelling strain of each cell against the case's (a field that was not collected fails) | 1e-9 |

The scale of a layer is the larger of its largest independent stress component and 1 % of `E alpha max|T - Tref|`. A mesh other than the case's, cells in another layer's zone, damaged or non-finite fields are refused (`E_OUTPUT_INCOMPLETE`), never a partial result. Stresses are cell-centre values, never face values (the probe: a face value extrapolated from the first cell is 0.6 to 3 % off).

**The wedge.** OFFBEAT computes the tangential strain on a wedge not exactly as u/r: the difference is about half the square of the half angle times the **total** strain (found in M2, at 1 degree: 5e-7 on a thermal strain of 3.4e-3, which put a 0.4 MPa offset in the SiC where the thermal mismatch stress is 3 MPa). At 0.25 degree it is sixteen times smaller, and the stress tolerance still carries an allowance `a^2 E/(1 - nu) x` the largest strain of the layer, twice the measured size.

## What it was checked against

Through the real solver (`tests/trisoMechanicsSolver.test.ts`, `FEED_SOLVER=1`, six cases, 12 to 15 s; output in `tests/golden/offbeat-triso-mech`, read again without the solver by `tests/trisoMechanicsResults.test.ts`). Largest deviation of a cell from the independent solution, of the layer's stress scale:

| Case | Layer: scale (MPa), tangential, radial, displacement |
|---|---|
| `ipyc` (the carbon alone, 25 MPa inside: the analogue of benchmark case 2) | ipyc: 49.5, 0.015 %, 0.041 %, 0.018 % |
| `pressure` (carbon and SiC, 25 and 0.1 MPa: case 3) | ipyc: 24.7, 0.006 %, 0.007 %, 0.004 %; sic: 105, 0.034 %, 0.002 %, 0.007 % |
| `swelling` (carbon with -0.015: case 4a) | ipyc: 933, 0.002 %, 0.005 %, 0.003 %; sic: 854, 0.006 %, 0.001 %, 0.002 % |
| `anisotropic` (three layers, anisotropic strains, thermal strain from 300 K) | ipyc: 313, 0.007 %, 0.008 %; sic: 195, 0.001 %, 0.012 %; opyc: 501, 0.001 %, 0.002 % |
| `thermal` (a poorly conducting coating, a drop of about 100 K, no pressure) | ipyc: 66, 0.001 %, 0.005 %; sic: 188, 0.003 %, 0.003 %; opyc: 0.7, 0.07 %, 0.6 % (4 kPa) |
| `library` (the PARFUME sets, a free strain in the carbon) | ipyc: 145, 0.007 %, 0.009 %; sic: 165, 0.008 %, 0.016 %; opyc: 9.9, 0.007 %, 0.022 % |

Every check passes on all six; the largest absolute stress difference anywhere is 48 kPa. The interface continuity is within 0.22 MPa and the radial balance residual within 16 kPa. The benchmark's first case, a SiC shell alone, is not offered (a particle always has the carbon beside the buffer); its closed form is in the layered-sphere tests. **Negative tests, each fails a check** (`tests/trisoMechanicsResults.test.ts`): the carbon's and the SiC's laws swapped, the gas and the outside pressure swapped, a stress compared at the cell's inner face, the anisotropic strain without its `r ln r` term, the zones of two layers exchanged (refused), a free strain that differs from the one applied, a temperature field that is not the case's, a stress that breaks the radial balance, a radial offset in one layer, a tangential component that differs.

## What it does not tell you, and what to read first

- The numbers are only as good as the **inputs**: the moduli differ between sources by a factor 1.5 (carbon), and the free strains are whatever the case says. An elastic particle with a stated shrinkage is a teaching result.
- It cannot say that a particle survives: no strength, no failure criterion, no gas release, no irradiation history.
- The reduction of a law of temperature to constants is an approximation (as for a pin), reported in the result.
- The plan's M4 (a gas-pressure helper, stress limits, the SiC's peak as a named result), M5 (the editor's panel and plot) and M6 (oracle entries, a request to SEED) are not built. The editor shows a mechanics particle's banner and a card per layer, nothing more.
