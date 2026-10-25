# Plan 18: Parity with OFFBEAT, then further parity

Status: **drafted 2026-10-24 from the suite-research note of 2026-10-17 (the owner's decision then: "parity first with OFFBEAT, then extend to further parity"), carried into this repository on the owner's word. Not approved as a build; nothing is built.** Each slice below is a separate step with its own design note, probe and approval, as [plan 06](06-mechanics-and-irradiation.md) requires. The four questions at the end are the owner's.

## What parity means here

FEED runs OFFBEAT and does not replace it. Today FEED exposes conduction, free expansion and elastic contact; OFFBEAT's source at the pinned commit (80e84450) has classes for much more (burnup, fuel densification, relocation and swelling, fission gas release through SCIANTIX, a gap gas model and plenum, cladding creep and plasticity, failure criteria, coolant channels, corrosion and hydrogen, PARFUME models for coated particles). **Parity** means: FEED lets a case use a model OFFBEAT already has, writes it correctly, refuses what it does not model, and says in the result which model produced the number. It does not mean that the result is validated, and it does not make FEED a licensing tool.

A class name is not a working model. Before a slice is built it needs a **probe** like plan 17's M0: does the model run in the pinned build, converge, write the fields a reader needs, and what does it need as data.

## How "independent check" reads under parity

FEED's results are checked against solutions FEED derives without the solver (closed forms and its own finite-volume solutions). That stays the strongest label. A model that OFFBEAT holds and FEED has no independent solution for (fission gas release, corrosion kinetics, a creep law with history) cannot carry that label. Every result therefore says which of three levels its numbers have, and the editor, the results record and the docs use the same words:

| Level | Meaning | Example |
|---|---|---|
| **Independently checked** | FEED's own closed form or finite-volume solution agrees with OFFBEAT's field within a stated tolerance, on every result | conduction, transients, the elastic layered sphere, the pin's elastic contact |
| **Reproduces a reference case** | OFFBEAT's output agrees with a published or OFFBEAT-shipped verification case for the same model; no independent solution is run on the user's case | a creep law against OFFBEAT's own verification case |
| **Model parity only** | The model is OFFBEAT's, as documented there; nothing checks the number | a sourced coefficient set run through a model with no oracle yet |

A slice is not shipped at a level it has not earned, and the label cannot be dropped. Parity claim for the repository: "same models as OFFBEAT where OFFBEAT's own documentation gives them; no claim of equal results to other codes or to experiments"; no result is called validated without data.

## Slices (parity with OFFBEAT), in plan 06's order

Each slice, as FEED already works: a design note with criteria first, a probe, a reference case before the feature ships, a mutation run, a Codex review, and the labels and refusals that stop a result implying more than it computes.

| Slice | OFFBEAT models it would expose | What it needs that FEED lacks | Oracle idea |
|---|---|---|---|
| **P1** Cladding creep and plasticity | Limback, MATPRO or Tobbe creep; Mises plasticity; the FRAPTRAN yield stress | Zircaloy data with ranges; a case that carries a history | thick-wall creep closed form for a tube under pressure; then OFFBEAT's own verification cases |
| **P2** Power history and burnup | Lassmann burnup, time-dependent profiles, properties as functions of burnup | history inputs through the existing transfer recipes ([plan 05](05-suite-transfers.md)); burnup units declared | the frozen-burnup oracles exist; a history case against the published form |
| **P3** Densification, relocation, swelling | the FRAPCON densification and relocation models; FRAPCON or MATPRO swelling | sourced coefficients (FRAPCON manuals; the NUREG/CR-7022 family) | free-strain closed forms; gap closure at a stated swelling rate |
| **P4** Gap gas, plenum pressure, fission gas release | the FRAPCON gap model, plenum patches, SCIANTIX | whether the pinned build includes SCIANTIX (not checked); gas inventory inputs | FEED's constant-gap oracles reduce to this when the gas is inert; SCIANTIX's own verification |
| **P5** Coolant channel instead of a constant film | the coolant channel patch | a coolant property set and a flow input; the boundary-history plan ([plan 11](11-time-varying-boundary.md)) exists | energy balance along the channel (closed form) |
| **P6** Corrosion and hydrogen | oxide kinetics, hydrogen transport | cladding alloy data | OFFBEAT's own corrosion and hydrogen verification cases |
| **P7** Failure indicators | the Zircaloy overstrain, overstress and plastic-instability criteria; RIA criteria | explicit labels: an indicator, never a licensing result; data | OFFBEAT's own cases and published thresholds |
| **P8** Coated particle with irradiation | PARFUME pyrocarbon, buffer and SiC swelling and creep; the particle gap | kernel and layer data; the particle path exists ([plan 13](13-triso-particle.md), [plan 14](14-triso-mechanics.md)) | OFFBEAT's generic coated-particle case; the benchmark shapes the public codes cite |
| **P9** Accident transients | the reactivity-insertion fission gas model, the LOCA creep variant, RIA failure models | time-step control, validity ranges; plan 06 listed accidents as likely out of scope for teaching (the owner later said yes as teaching content) | OFFBEAT cases only until real data is held |

The first to build is the owner's choice (question 1). Plan 17 (the stress of a pin through a transient) is the TRIGA track and is not one of these slices; its M0 probe is the model for what each slice's probe must show.

## Then "further parity": fuels OFFBEAT does not have

OFFBEAT has no classes for: plate fuel with aluminium cladding, U-ZrH (TRIGA), metallic fuel, silicides and nitrides, coated-particle failure statistics. These are the research-reactor fuels FEED started with, so this is where FEED's own work would count. Two ways, and a licence check before either:

- **Own models in FEED's own solvers.** FEED already has independent finite-volume solutions for plates and particles.
- **An OFFBEAT extension kept outside this repository.** OFFBEAT is GPL-3.0 or later; FEED runs it as a separate program and holds none of its files. A compiled extension that links OFFBEAT would be GPL and would live outside the MIT repository, as the solver does now. Not legal advice; the owner decides after a licence check.

## What this changes in the project's stated scope

[PLAN.md](../../PLAN.md) said "no replacement solver, teaching tool, thermal first". The first two stay true (FEED still runs OFFBEAT and teaches). "Thermal first" is rewritten as the order of work, with this plan as the path beyond the thermal and elastic results. The README's "experimental and educational" status line is unchanged: no slice makes a result validated.

## Decisions of the owner (2026-10-25)

The four questions below were answered on 2026-10-25 ("finish the TRIGA and plate work first, then probe the light-water slices (P1 to P4)", "claim parity only, since no public validation data was found", "write FEED's own models for the missing fuels"):

1. **Which fuel first:** the TRIGA and plate work first (plan 17 and what follows from it), **then** the light-water rod slices P1 to P4, each started with a probe like plan 17's M0. Order inside them: plan 06's, P1 to P4.
2. **Order:** plan 06's order (P1, P2, P3, P4); P4 is not brought forward.
3. **Claim:** **parity only**: "same models as OFFBEAT where OFFBEAT's own documentation gives them", no validation claim (no public validation data was found).
4. **Fuels OFFBEAT lacks** (plates, U-ZrH, metallic, silicides and nitrides, particle failure statistics): **FEED's own models**, in FEED's own solvers, not an OFFBEAT extension, so the MIT repository holds no GPL code.

Nothing in this plan starts before plan 17 reaches its end. The questions as asked, kept for the record:

## Questions that were asked

1. Which fuel first: a light-water rod (P1 to P4), a coated particle (P8), or the TRIGA and plate track (plan 17 and further parity)?
2. Order inside OFFBEAT parity: plan 06's order as above, or P4 first (gap gas, plenum and fission gas: the most visible feature)?
3. Data: a validation claim, or only the OFFBEAT-parity claim for now? (FRAPCON-family manuals are public; experimental assessment data was not found public.)
4. For further parity: own models in FEED, or an OFFBEAT extension outside the repository?
