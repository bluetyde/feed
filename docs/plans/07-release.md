# Plan 07: Release

Packaging, licensing and the pre-release checklist. Not before F3 is verified.

## Distribution (to decide)

| Option | For | Against |
|---|---|---|
| Source clone plus local server and a user-built solver environment | No packaging work; SEED can clone it | The solver stack is heavy; students cannot easily build it |
| A prebuilt solver environment (WSL distro image or container) with a launcher | Reproducible; same pair for everyone | Size; redistribution terms of the solver stack; Windows prerequisites (WSL2) |
| Bundled with a turnkey package like OpenMC Studio's | One download | Size and coupling of release cycles |
| Hosted solver service | Easiest for students | Needs hosting, security for other people's inputs, cost; not planned |

The choice follows the F0 findings on versions, install footprint and licenses.

## Licensing and provenance

- **Do not bundle OFFBEAT, OpenFOAM or any property dataset** before their licenses and redistribution terms are checked and recorded in `THIRD_PARTY_NOTICES.md`. Public binary redistribution needs corresponding-source obligations reviewed.
- The repo's license is not set. Choose one (the suite default is MIT) after the solver stack's terms are known; keep the solver as a separate program if that preserves the choice.
- Property data and example cases carry their sources and redistribution terms; sourced examples are included only when allowed.
- Fonts and assets bundled with their licenses; no remote script or font loading.

## Pre-release checklist

1. Fresh-machine install from the documented prerequisites only (including the solver environment) on each supported OS.
2. All oracle entries pass on the shipped solver pair; parity with the direct solver passes.
3. Case writer golden files pass; the example pin runs end to end.
4. Harness acceptance: workspace and standalone runs agree; transfer refusals hold (SEED E4).
5. Security pass: no shell strings, run roots enforced, no command taken from case, material or transferred content.
6. Accessibility pass: keyboard, focus, contrast, plot text alternatives, 200% zoom.
7. Docs: install guide, student guide, instructor notes, supported models and limits, transfer guide.
8. The thermal-only banner and the educational-use statement present in the app, exports and docs.
9. Changelog, tag, release assets; make the repo public only when the user says so.

## Open

- Distribution model and license.
- Footprint budget for students (disk, build time) and whether a smaller path is acceptable for the first lessons.
- Update channel and the SEED catalog entry once a repo exists.
