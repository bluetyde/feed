# Property-model survey: what OFFBEAT can carry

Done 2026-10-06 for the last open item of F0 ([F0-note.md](F0-note.md)) and as the groundwork for tabulated k(T) and cubic correlations. **Question:** which thermal-conductivity, heat-capacity and gap models does the pinned OFFBEAT have, in what units, with what equations, ranges and requirements, and which of them can FEED use in a thermal-only case?

**Method.** OFFBEAT `80e84450a115b0c411e1bfa5d166379f6bf6c084` (the pin, checked out in the `feed-solver` distro; the only local change is the build's own `offbeatLib/Make/files` symlink) was read with the queries in [solver/survey/](../../solver/survey/README.md), which only list, grep and print. Paths below are under `offbeatLib/`. Claims that matter for FEED's next steps were then **run** through the real solver on the synthetic pin (`tests/propertyModelProbe.test.ts`, 8 probes, `FEED_SOLVER=1`); each says "run" with its number. Everything else is **read**, not run.

## 1. How a material gets its models

- FEED writes `material constant;`. `constantMaterial.C:58-77` builds every property with `Model::New(mesh, dict, "constant")`: the model is the word under the keyword `conductivityModel` (or `heatCapacityModel`, `densityModel`, ...), defaulting to `constant`. So **any registered model can be named from a `constant` material**, which is how FEED already carries a linear k(T) and c(T).
- An unknown name is **fatal** and the message lists every registered type (`materialModel/thermoMechanicalPropertiesModels/conductivity/conductivityModel.C`, `New()`). **Run:** `ZyRELAPP` stops the run with `Unknown conductivityModel type ZyRELAPP` and the log lists exactly 15 types (section 2). FEED's run record keeps only the head of that message; the complete list is in `log.offbeat`.
- A model reads its numbers from a sub-dictionary named for the property (`conductivity { par1 ...; }`, `heatCapacity { ... }`) with **`lookupOrDefault`: an omitted or mistyped parameter is not an error, it takes the model's built-in default** (for example `conductivityRelapZy.C:61-73`, `conductivityTobbe1515Ti.C:61-70`). **Run:** a cubic written without `par4` completed with no refusal and no warning and gave the Zircaloy default (`7.67e-9`): its fuel profile was 220 K from the law intended and within 0.06 K of the law with the default. A mistyped `par44` gave the identical wrong answer.
- **The temperature is only ever read, never checked against a validity range except by a `WarningInFunction` printed to the log.** **Run:** a pin taken to 2099 K with `ZyRELAP` (stated range 290 to 1800 K) completed; the log held 3,890 warning lines (the first: `Supplied temperature, 2295.79, out of range 290 < T < 1800 K`, a value from an iteration above the final maximum) and nothing refused it.
- Heat capacity is **mass-based** (J/kg/K) times a density the density model gives; FEED writes a constant `rho` and puts the volumetric law into `Cp = c / rho` (that is what `WRITER_DENSITY` is for).
- The comments in the source say `[J/m.K]` for conductivity (`conductivityConstant.H:66`); the value is W/m/K. Read it as W/m/K.

## 2. Conductivity models: 15 registered

Temperature in kelvin unless said. "Fields" are the other quantities the model reads from the case: **a model that needs one FEED's thermal-only case does not have cannot be used there** (`burnup none` in the writer's solverDict).

| Registered name | Equation (W/m/K) | Parameters and defaults | Range in code | Fields needed | Usable thermal-only |
|---|---|---|---|---|---|
| `constant` | k | `k` (required) | none | none | **yes, FEED uses it** (`conductivityConstant.C:62`, `:88`) |
| `steel1515TiTobbe` | par1 + par2 (T - 273.15) | 13.95, 1.163e-2 (`conductivityTobbe1515Ti.C:61-70`, eq. `:97`) | none | none | **yes, FEED uses it for a linear law** |
| `SwindemanHastelloyN` | par1 + par2 (T - 273.15) | 8.431, 0.0205 (`conductivitySwindemanHastelloyN.C:61-69`, `:97`) | none | none | yes (same shape as Tobbe) |
| `ZyRELAP` | par1 + par2 T **- par3 T^2** + par4 T^3 | 7.51, 2.09e-2, 1.45e-5, 7.67e-9 (`conductivityRelapZy.C:61-73`, eq. `:109`) | warns outside 290 to 1800 K (`:103`) | none | **yes: a cubic** |
| `Mo` | par1 T^2 - par2 T + par3 | 9.128e-6, 4.945e-2, 152 (`conductivityMolybdenum.C:61-71`, `:98`) | none | none | yes: a quadratic with the sign of the linear term built in |
| `SiCPARFUME` | par1 / T + par2 | 17885, 2 (`conductivityPARFUMESiC.C:61-69`, `:99`) | none | none | yes: **a / T + b**, the shape of a phonon-limited ceramic |
| `BufferPARFUME` | a function of the density field | `initialDensity`, `theoreticalDensity`, `initialConductivity`, `theoreticalConductivity` (`conductivityPARFUMEBuffer.C:61-66`, `:98`) | none | density field `rho` | not as a temperature law |
| `UPuO2Brancheria` | 100 (D1 (1/(2.88 + 0.0252 T) + 5.83e-13 T^3)), D1 from porosity (`conductivityUPuO2Brancheria.C:117-124`) | `densityFraction` (required), `perturb` | none | `porosity` optional (`:95-100`) | **by reading, with only `densityFraction`; not run** |
| `UO2MATPRO` | MATPRO UO2 with burnup and porosity | 13 parameters, `densityFraction` (required), `burnupName`, `GdContent` | | burnup `Bu`, porosity and swelling fields (`conductivityMatproUO2.C:116-155`) | **yes, with `burnup constant` (updated 2026-10-07, [burnup-probe.md](burnup-probe.md)); the name is a misnomer: the equation is FRAPCON-3.4's modified NFI model, not MATPRO ([burnup-sourcing.md](burnup-sourcing.md))**: it runs thermal-only once `densityFraction` is given (an earlier run without it was refused: `FOAM FATAL IO ERROR: keyword densityFraction is undefined`), and its `k` equals the equation to 1e-5 in every cell |
| `UO2NFIR` | NFIR UO2 | | | burnup, swelling fields | no (read) |
| `conductivityUO2IFA601` | 1 / (term1 + term2 T) + par7 exp(par8 T), burnup-dependent terms, x 1000 (`conductivityUO2IFA601.C:134-136`) | 8 parameters | | burnup | no (read) |
| `UPuO2Kato`, `UPuO2LanningBeyer`, `UPuO2MagniMAMOX`, `UPuO2Philipponeau` | U-Pu oxide laws | | | burnup, oxygen-to-metal ratio, `N_U`, `N_Pu`, porosity (varies) | no (read) |

So **for a thermal-only case the carriers are**: constant; **linear** (`steel1515TiTobbe`, `SwindemanHastelloyN`; in degrees Celsius); **quadratic** (`Mo`); **cubic** (`ZyRELAP`); **a/T + b** (`SiCPARFUME`). There is **no tabulated conductivity**: the only tables in the library are for power profiles, a time-tabulated gap gas, and swelling (`03-tables-and-selector.sh`).

### The cubic, run

`ZyRELAP` carries any cubic k = a0 + a1 T + a2 T^2 + a3 T^3 **with par3 = -a2** (the equation subtracts it) and **all four parameters written**. On the synthetic pin (40 fuel cells) with k = 2 + 0.003 T - 1.2e-6 T^2 + 2e-10 T^3 (2.80 W/m/K at 300 K, 4.0 at 1000 K, fuel to 1179 K):

| Probe | Result |
|---|---|
| par3 = -a2 | the fuel profile is within **0.12 K** of the closed form (the conductivity integral of the cubic solved independently), inside the 1.25 K discretisation bound |
| par3 = +a2 (the natural reading) | OFFBEAT solves the law it was given, to **0.086 K**, which is **131.6 K** from the law intended |
| par4 omitted | within 0.06 K of the law with the default `7.67e-9`; **220 K** from the intended one; no refusal |
| `par44` for `par4` | the same 220 K |

## 3. Heat-capacity models: 9 registered, every one temperature-only

None looks up another field (`08-heatcapacity-fields.sh`), so all are usable in a thermal-only case. J/kg/K, T in kelvin.

| Registered name | Equation | Parameters and defaults | Range in code |
|---|---|---|---|
| `constant` | Cp | `Cp` (required) | none |
| `steel1515TiBanerjee` | par1 + par2 T + par3 T^-2 | 431, 0.177, 8.72e-5 (`heatCapacityBanerjee1515Ti.C:61-71`, eq. `:107`) | warns outside 293 to 1273 K |
| `SiCSnead` | par1 + par2 T + par3 T^2 + par4 T^-2 | 925.65, 0.3772, -7.9259e-5, -3.1946e7 (`heatCapacitySneadSiC.C:61-73`, eq. `:109`) | warns outside 200 to 2400 K |
| `Mo` | par1 T^2 + par2 T + par3 | 9.74e-6, 5.37e-2, 235 (`heatCapacityMolybdenum.C:61-71`, `:100`) | none |
| `ZyIAEA` | piecewise in T with a phase-transition bump (`heatCapacityIAEAZy.C:117-137`) | 9 parameters | warns outside 273 to 2000 K |
| `ZyMATPRO` | interpolation between hard-coded (T, Cp) points of Zircaloy (`heatCapacityMatproZy.C:95-136`; the interpolation step itself was not read) | none | warns outside 273 to 2099 K |
| `UO2MATPRO` | Einstein-type term + K2 T + defect term (`heatCapacityMatproUO2.C:112-114`) | `OM`, `K1`, `K2`, `K3`, `phi`, `ED`, `par1` to `par3` | none |
| `UPuO2Fink`, `UPuO2MATPRO` | U-Pu oxide laws | | |

- **Quadratic heat capacity is available**: `SiCSnead` with `par4 = 0` is par1 + par2 T + par3 T^2. **Run:** with par1 = 200, par2 = 0.2, par3 = 5e-5 the interior of the synthetic pulse reached **613.213 K** against the root of the integral of rho Cp dT = E solved independently, **613.330 K** (0.12 K of a 313 K rise, first order in the step, as for the linear law).
- FEED's linear law is carried by `steel1515TiBanerjee` with `par3 = 0` (unchanged). A heat capacity with a real `T^-2` term fits `Banerjee` or `SiCSnead` as they stand.
- `UO2MATPRO` heat capacity is temperature-only by reading: a sourced UO2 pulse could use it without a burnup field; not run.

## 4. Gap models

- **`resistiveGap`** (what FEED writes): a per-face `alpha`, W/m^2/K, read once (`resistiveGapFvPatchScalarField.C:119`, `:137`), no temperature dependence, combined **in series** with the two half-cell conductances: `alphaEff = 1 / (1/alphaP + 1/alphaN + 1/alpha_gap)` with `alphaP = kappa / delta` (`:66-70`). If no face has a positive value the run stops (`:217-222`). The `kappa` keyword names the neighbour's conductivity field (`k`).
- **`fuelRodGap`**: a gap conductance computed from the FRAPCON 4.0 manual as the sum of gas, radiative and contact conductance; it needs a **gapGas model** in the case, the displacement fields `D` and `DD` (mechanics), `roughness` and `interfaceP` (`fuelRodGapFvPatchScalarField.C:70-145`). **Not usable thermal-only**: the gap width comes from mechanics, and FEED refuses a case that would need computed contact.
- **`trisoGap`**: the TRISO-particle gap (file seen, not read); irrelevant to a pin.
- **Gap gas models** (`gapGasModel/`): `none`, `FRAPCON`, `timeTabulated`, `TRISO`. All need the fission-gas-release class, the temperature and the displacement fields (`gapGasModel.H`); `timeTabulated` is, by its name and file, a gas history given as a table (not read). None is usable without mechanics.

So **FEED's constant effective gap conductance is the only gap option a thermal-only case has**, and the survey changes nothing there. A gap conductance that depends on temperature or on gap width is not expressible without mechanics.

## 5. What this means for the next step (tabulated k(T), cubic correlations)

1. **A cubic correlation can be carried exactly**: `ZyRELAP` with par3 = -a2 and all four parameters always written (the writer must never rely on a default; it must also write `par4 = 0` for a quadratic). FEED's own side needs the same law: its independent finite-volume solver and closed forms handle linear k(T) only (`kOf` in `transientFv.ts`, `solveLinearK` in `closedForm.ts`), so a polynomial conductivity needs those extended, and the conductivity integral of a cubic has no closed-form root (a bounded numerical solve, as the probes use).
2. **A table cannot be carried as a table.** There is no tabulated conductivity or heat capacity in OFFBEAT, and FEED does not modify it. A tabulated k(T) therefore has to become a polynomial (cubic) or a/T + b by **fitting**, with the **fit's largest deviation from the table stated and a limit beyond which the case is refused** (nothing silently smoothed), and the table kept as the source data. `ZyMATPRO` interpolates a table, but it is Zircaloy's, hard-coded.
3. **Ranges must be FEED's.** OFFBEAT enforces none (a log warning at most, 3,890 lines in one run), so the stated valid range of a polynomial law has to be checked by FEED, as it already does for linear laws (`E_OUT_OF_RANGE` in validation, the `propertyRange` check on the result). A fit is valid only over the table's own range.
4. **Positivity**: a cubic can go negative or non-monotone outside the fitted range; FEED's validator must check k > 0 over the stated range (it does so for linear laws at the end points; a cubic needs the interior too).
5. **Heat capacity**: a polynomial up to quadratic is available through `SiCSnead` (par4 = 0); a cubic heat capacity is not. A tabulated c(T) would be fitted to a quadratic (or to `Banerjee`'s T^-2 form) under the same rules.
6. **Writer safeguards that follow from section 1**: write every parameter of a model (never rely on a default), refuse any parameter name the model does not read (a typo is silent in OFFBEAT), and keep a test that the registered-name list in the log is the 15 above (a different OFFBEAT would change it).

## 6. Not surveyed, and limits

- Density, emissivity, Young's modulus, Poisson ratio and thermal expansion: not relevant to a thermal-only case (FEED writes constants), except that **density enters the heat capacity** (section 1). `constant` density and emissivity read `rho` and `emissivity` (`densityConstant.C:62`, `emissivityConstant.C:62`).
- The burnup, swelling, relocation, densification and failure models (`behavioralModels/`), the fission-gas-release and heat-source libraries: outside thermal-only.
- `userParameters` (`global/userParameters/userParameters.H`) is a separate mechanism: user-modifiable scalars read from `system/userParameters` and registered by group and name. It is not how material laws are chosen; FEED does not use it.
- The U-Pu oxide conductivity and heat-capacity models were read only far enough to list the fields they need; their equations were not checked.
- **Counts:** 15 conductivity models (the log's own list), 9 heat-capacity models (the directory's files, less the base class), 4 gap-gas models, 3 temperature-coupled gap patches (`resistiveGap`, `fuelRodGap`, `trisoGap`).
- **Read, not run:** every row of the tables except those marked "run". The default models of each material class (zircaloy: `ZyRELAP` conductivity, `ZyIAEA` heat capacity; `steel1515Ti`: `Tobbe`, `Banerjee`; `HastelloyN`: `Swindeman`, constant; `molybdenum`: `Mo`, `Mo`; `SiC`: `SiCPARFUME`, `SiCSnead`; `UPuO2`: `MagniMAMOX`, `UPuO2MATPRO`) are in `07-fields-and-defaults.sh`; FEED does not use the material classes, only `constant`.
- OFFBEAT is GPL: nothing here is copied from it into FEED; the survey cites equations and defaults by file and line.
