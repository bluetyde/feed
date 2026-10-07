# Plan 10: Burnup as a frozen state (the conductivity of burnt fuel)

The concrete plan for the first, smallest part of step 4 of [plan 06](06-mechanics-and-irradiation.md): a case may state how much **burnup** its fuel has, and the fuel's conductivity follows it. Written 2026-10-07 after the user **undeferred burnup** (it had been deferred the same day, see the FEED log entry "investigation: burnup and depletion import"), from what that investigation and the burnup-basis probe found. **Nothing here is built; M0 is the first step, and M1 onwards waits for the decisions in section 4.**

## 1. What it is for, and what a result may claim

A burnt oxide fuel conducts heat worse than a fresh one: fission products, a damaged lattice and porosity lower its conductivity, so the same power gives a hotter centre. The first release lets a case say "this fuel has 40 MWd per kg of heavy metal" and shows the cost in kelvin, against the same pin fresh. That is a real teaching point (it is the first reason a fuel pin that was safe at start of life is not at end of life) and it needs only the thermal solver FEED already has.

A burnup result is a **different kind of claim** from a fuel-performance result and is labelled so: "**frozen-burnup thermal snapshot**: the conductivity of fuel that has this burnup, everything else as stated". It is **not** the history of a rod. Nothing evolves: no swelling, no densification, no relocation, no fission-gas release, no gap change, no cladding creep, no rim structure, no radial burnup profile. At high burnup the real gap has closed and the fuel has swollen; a case that holds the gap at its cold value will understate that, and the result says so. Every burnup result carries that sentence the way every thermal result carries the thermal-only one.

Not in this plan: mechanics ([plan 09](09-mechanics.md), paused), fission-gas release, any burnup evolution computed by FEED, U-Pu oxide fuel, a depletion calculation (that is OpenMC Studio's), and TRIGA fuel (see below).

**TRIGA fuel is out.** OFFBEAT's burnup field and every burnup-dependent conductivity model it has are for oxide fuel; the basis is undefined for U-ZrH, and the SARs give no burnup dependence of its conductivity. A case with a burnup and a fuel that is not an oxide is refused.

## 2. What is established (from the burnup investigation and the basis probe, 2026-10-07)

| Fact | Evidence |
|---|---|
| FEED's laws are temperature-only; the writer says `burnup none`; with `burnup constant` and no `Bu` file the field is 0 and the result is identical to `none` (26 cells, 0 K difference) | the investigation run |
| **OFFBEAT's `Bu` is MWd per tonne of the fuel material's mass as given by its `rho`: for an oxide fuel, per tonne of oxide.** `burnupFromPower` adds `Q dt[days] / rho / 1000`; the run on FEED's pin gave 21916.372 against the hand value 21916.3724 | `tests/burnupBasis.test.ts` (gated, passes); the answer in the FEED log to the OpenMC Studio session |
| `burnup constant` is OFFBEAT's documented hook for a burnup from outside: a `Bu` file in the start time folder (per cell, default 0); the field then never evolves | `constantBurnup.H` |
| The conductivity models that read `Bu` are `UO2MATPRO` (MATPRO v11 as coded, 13 parameters that default silently, `densityFraction` required, optional `GdContent`, `burnupName`), `UO2NFIR`, `conductivityUO2IFA601` and the U-Pu oxide laws | [property-model-survey.md](../spike/property-model-survey.md); source read 2026-10-07 |
| `UO2MATPRO` as coded: `k95 = 1 / (p1 + p2 T + p3 B + p4 Gd + (1 - p5 e^(-p6 B)) p7 B^p8 / (1 + p9 e^(-p10/T))) + p11 T^(-p12) e^(-p13/T)`, then `k = k95 x 1.0789 f / (1 + 0.5 (1 - f))` with `f` the density fraction, `B` the burnup in MWd/kgU computed as **`Bu / 1000 / 0.881`**. The swelling, densification and porosity terms apply only when those fields exist; on a thermal-only case they do not | `conductivityMatproUO2.C`, read |
| **The factor in the model is 0.881; the Lassmann burnup model uses 0.8815.** A heavy-metal burnup written as `B_HM x 0.8815` would reach the model as 0.0006 too high a burnup. FEED must write `Bu = B_HM x 0.881` for this model, the constant the model divides by | the two source files, read; to be confirmed in M0 |
| Whether `UO2MATPRO` runs at all on FEED's thermal-only case (the `UO2` material class, the fields it also looks for) is **not known**: the survey's only run stopped at the missing `densityFraction` | survey; this is M0's question |
| A `depletion.json` reader exists, unmerged, on `claude/agy-depletion-reader` in another session's clone (parse, check, `burnupAt` by interpolation, never extrapolates, `toOxideBasis`); 7 tests pass and it merges cleanly. OpenMC Studio has a writer module on its `main` that nothing calls, no engine that runs a depletion, and no chain file | the FEED log; the Studio session's note |

## 3. The design

- **Where burnup lives: in the case, not the material.** Burnup is a state of the fuel, not a property of the material, so a case has an optional `burnup` section (one value for the slice: `value` in MWd/kgHM or MWd/tHM, `basis: "heavy-metal"`, a required `source` such as "chosen for this study" or a depletion record's id). The material says what it is: a conductivity set with `model: "uo2-matpro"`, its `densityFraction`, its optional `gadoliniaContent`, **all 13 parameters written** (defaults from the source, none left to OFFBEAT), the fuel's `heavyMetalMassFraction` (0.881 for UO2), a validity range in temperature **and in burnup**, and a source. A case without `burnup` and a material with the model is refused (the law needs it); a case with `burnup` and a model that does not use it is refused (it would say something that changes nothing).
- **One law in FEED's arithmetic.** At a stated burnup the law depends on temperature only, so it joins the laws FEED already has: a new kind in `src/core/conductivity.ts` with `evaluate`, a `primitive` (the exponential terms have no closed form, so the integral is a fixed-order Gauss-Legendre quadrature of a smooth function, checked against a much finer one) and `minimum` (the model is **not** monotone: the electronic term `p11 T^(-p12) e^(-p13/T)` makes it rise at high temperature, so there is a minimum inside a wide range; it is found by a scan refined by bisection on the derivative, as the cubic's turning points are, and positivity is judged on it). `solveHot`, the closed forms, the independent finite-volume solver, the time scale, the limits and the editor then work without change, the way they did for the reciprocal law.
- **What OFFBEAT is given:** `conductivityModel UO2MATPRO` with `densityFraction`, the 13 parameters and `GdContent` all written, `burnup constant;` and a `0/Bu` file whose every fuel cell holds `B_HM x 0.881` MWd/t and every cladding cell 0. Run and checked in M0 before any of it is built.
- **Refusals:** a burnup outside the model's stated range (from the source, not invented); a burnup with a fuel that is not an oxide or has no heavy-metal fraction; a negative or non-finite burnup; a density fraction outside 0.5 to 1 (to be set from the source); a fuel with the burnup law and a transient (first release: steady cases only, the way hot dimensions are; the law would be frozen over the pulse).
- **The study that earns its keep:** a "burnup sweep" in the editor that evaluates the independent closed form at several burnups (cheap, no solver) and plots the centre temperature against burnup, with the solver's run at the stated point as the check. Everything on the plot but the stated point is labelled "independent estimate".
- **Depletion import is a later layer on the same field**, not a different feature: a reviewed SEED transfer recipe ([plan 05](05-suite-transfers.md) pattern: units, basis, coverage, revision) carries a burnup from a `depletion.json` record into the case's `burnup` section with the record's id as its source. It is M6 and waits on others (below).

## 4. Decisions for the user

Each has a recommended answer; none is built until answered.

1. **The first fuel.** Recommended: **UO2 with Zircaloy cladding** (the LWR pin OFFBEAT's own tutorial uses), with `UO2MATPRO`. Alternative: also NFIR (a later, better fit at high burnup, but a longer sourcing job).
2. **How burnup is typed.** Recommended: **one value for the slice**, in MWd/kgHM (the unit OpenMC reports), with MWd/tHM accepted. A radial profile (the rim) waits for a model that needs it.
3. **Sourcing.** A model's numbers come from a document, never from memory. OFFBEAT's own source says only "MATPROv11" and gives the 13 numbers; the MATPRO report (NUREG/CR-6150, the usual citation; **not in the research folder**) is the primary source. Recommended: M1 **finds and reads the MATPRO report** (I can fetch it from the NRC or INL site if you allow web access, or you supply it), compares the equation and the 13 constants with OFFBEAT's, and records the page. If they differ, the model's name in FEED says which one ran. Without the document the model is not offered.
4. **Zircaloy cladding.** An LWR pin needs a sourced Zircaloy conductivity (a cubic; FEED's `ZyRELAP` carrier already exists) and a gap conductance. Recommended: take both from the MATPRO report in the same pass as decision 3, and label the example "sourced" only if every number has a page.
5. **What the gap does.** Recommended: **held at its stated cold value**, with the "frozen snapshot, no swelling, gap not closed" sentence on every burnup result. Alternative: let the user state a hot gap through the existing hot-dimensions section (it already exists); neither models swelling.
6. **Order against other work.** Recommended: M0 and M1 first (they decide whether this is possible and sourced), the rest only if both pass. Roughly 8 to 10 sessions in total; M6 is not scheduled.
7. **The depletion record reader.** Recommended: **merge it at M6**, not before: the OpenMC Studio session agrees (no caller, no engine, no chain file, the format unproven). Getting a depletion chain file for Studio is the user's call, outside this plan.

## 5. Milestones

**M0: Probe the real solver (no FEED code).** Run FEED's synthetic pin through OFFBEAT with `conductivityModel UO2MATPRO`, `densityFraction`, all 13 parameters, `burnup constant;` and a hand-made `0/Bu` file, through `solver/probe-mechanics.sh` as the burnup-basis probe did. Establish: whether it runs on a thermal-only case at all and which fields it complains about; that the centre and surface temperatures equal a hand evaluation of the equation above (written in the test, sharing no code with FEED) cell by cell; the 0.881 against 0.8815 question; what changes when a parameter is omitted (the silent default, shown); the cost in kelvin of 0, 20, 40 and 60 MWd/kgU on the synthetic pin. **Gate:** the temperatures match the hand evaluation to 1e-4 relative; if the model will not run thermal-only, stop and decide with the user (it would mean writing the missing fields, which is a larger change).

**M1: Source the model.** Find and read the MATPRO conductivity section; compare equation, constants, validity range (burnup, temperature, density) with OFFBEAT's code; find the Zircaloy conductivity and the LWR gap data; record the pages. **Gate:** every number the example needs has a page, or the example is labelled synthetic and says why.

**M2: The law and the case structure.** The `uo2-matpro` kind in `conductivity.ts` (evaluate, primitive, minimum, solveHot via the existing path), the `burnup` case section and the material fields in the validator and schema with their refusals, units (`MWd/kgHM`, `MWd/tHM`), the writer (model, 13 parameters, `burnup constant`, the `0/Bu` file). Tests: an independent hand evaluation, the quadrature against a finer one, every refusal; a mutation run before the milestone is called done.

**M3: Independent checks and the result.** The closed form and the finite-volume solver on the frozen law; a results check that the solver's cell conductivities (if OFFBEAT writes them: M0 finds out) or its temperatures agree with the independent ones; the "frozen-burnup thermal snapshot" sentence on every result, export and compare. Gated solver test on the pin at 0 and 40 MWd/kgHM.

**M4: Editor and the sweep.** The burnup field in the case, the material's fields, the burnup sweep plot with its accessible table, an example case (`lwr-uo2-burnup`), documentation (`docs/burnup.md`).

**M5: SEED oracle entries.** FEED writes them (D3): the temperatures at two burnups from the closed form, tolerances fixed first, and the refusals; they go on a branch until the SEED agent updates its counts and asks.

**M6: Depletion import (waits on others).** Needs a real `depletion.json` writer in Studio (a run that calls it), the chain file (the user's decision), and a SEED transfer recipe for a burnup (the SEED agent's side, a request to be logged, not made from here). Then the reader is merged and wired through the recipe's checks.

## 6. Risks

- **Sourcing.** The whole plan rests on finding the MATPRO report. If it cannot be found, nothing is offered (a model whose numbers have no page is the thing FEED does not do).
- **Silent defaults.** All 13 parameters are written; a test shows an omitted one changes the answer.
- **The 0.881 against 0.8815.** A 0.06 % difference in burnup; handled by writing the model's own constant, shown in M0.
- **A uniform burnup is optimistic.** Real burnup has a radial profile with a high rim; the sentence says so.
- **Validity.** MATPRO's conductivity is stated to a burnup the report gives; beyond it FEED refuses, never extrapolates.
- **Scope creep.** Swelling, densification, gas release and the gap are the tempting additions and are out; they belong with mechanics.
