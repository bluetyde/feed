# Plan 06: Mechanics and irradiation

What comes after the thermal release. Milestone F4. **Nothing here starts until F3 is verified.** Each capability needs its own written property requirements, reference data and validation gate before it ships; none is an option on the thermal case.

## Why they are separate

A thermal-only result must not imply a stress, failure or fuel-integrity assessment. Mechanics adds contact, expansion, creep and stress. Irradiation adds burnup, swelling, gas release and property degradation. Each changes what the numbers mean, and each needs data this app does not have today.

## Order

| Step | Capability | New needs |
|---|---|---|
| 1 | Thermal expansion and gap evolution (elastic) | Expansion coefficients, elastic constants, contact model, boundary and symmetry conditions |
| 2 | Pellet-cladding contact and stress output | Contact friction model, stress output definitions, mesh requirements |
| 3 | Creep and plasticity of cladding | Material models and data with ranges |
| 4 | Irradiation history and burnup | Power history, burnup definition and units, property models vs burnup |
| 5 | Fuel swelling and fission-gas release | Models, data, validation against measured cases |
| 6 | Transients and accident cases | Time stepping, boundary histories, validity limits; likely out of scope for teaching |

## Rules for every step

- The assumptions block states the model set in use; a result from a different model set is a different kind of result and is labelled so.
- **Required properties are declared per model.** A material lacking a needed set refuses the run with the property named. Applicable temperature and burnup ranges are stored and enforced.
- Reference cases exist before the feature ships: closed forms where they exist (for example thermal expansion of a free cylinder, thin-wall pressure stress in a cladding tube), published benchmark cases where they do not, with sources, tolerances and data terms recorded.
- A new capability extends SEED oracle coverage only when its entries pass.
- Stress, strain and failure results carry their own labels and limits; nothing implies a licensing conclusion.
- The Monte Carlo and burnup history inputs from OpenMC or other apps arrive only through reviewed transfer recipes ([plan 05](05-suite-transfers.md)), with the burnup definition and units declared.

## Sources to survey (none chosen)

Published fuel-performance benchmark databases and code-to-code comparison exercises; open data on cladding and fuel properties with clear terms. Which of these are usable, with what licenses and what coverage, is a survey task in TOOLING; until done, no validation claim is made.

## Tests

Each step defines its own: free-expansion closed form, thin-wall cylinder stress, a refusal for a missing property, out-of-range flagging, a regression against the thermal oracle set (the thermal results must not change when mechanics is switched off).

## Open

- Whether step 1 can reuse the thermal pin case with one added section or needs a new case schema.
- Which solver models in the pinned OFFBEAT version are usable and documented well enough to teach.
- Whether steps 5 and 6 belong in a teaching tool at all.
