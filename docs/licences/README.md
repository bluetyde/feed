# Licences: FEED, the solver stack it runs, and what each way of distributing needs

2026-10-06. Evidence for F0 review finding 9 ([review](../reviews/codex-2026-10-06-f0-exit.md)). **Not legal advice: no lawyer has reviewed this.** It records what the files and pages say, how that was checked, what each route of distribution would have to carry, and what is still missing.

Everything about the solver is for the pinned versions in [solver/pins.env](../../solver/pins.env): OFFBEAT commit `80e84450a115b0c411e1bfa5d166379f6bf6c084` and the apt package `openfoam9` 20220602, on the Ubuntu 22.04.5 base of the `feed-solver` distro. The texts below were copied out of that installation by [solver/collect-licences.sh](../../solver/collect-licences.sh), which stops if the pins do not match; their hashes are in [third-party/SHA256SUMS](third-party/SHA256SUMS) and are checked by `tests/licences.test.ts`.

## 1. Inventory

| Component | Licence as stated | Evidence (read 2026-10-06) | Text kept |
|---|---|---|---|
| **FEED** (this repo) | MIT, holder "bluetyde" | [LICENSE](../../LICENSE); `package.json` `license` field | in the repo |
| FEED's npm packages that run (5, with their own dependencies) | MIT (ajv, fast-deep-equal, json-schema-traverse, require-from-string); BSD-3-Clause (fast-uri) | the `license` field of each installed package | not bundled by FEED |
| FEED's build and test tools (`typescript`, `vitest`, `@types/node`) | Apache-2.0, MIT, MIT | same | not bundled |
| **OFFBEAT** at the pinned commit | GNU GPL, version 3 or later | `LICENSE` is the GPL v3 text; every one of the 776 files in the checkout that mention the GPL (sources, scripts, tests) carries the grant "either version 3 of the License, or (at your option) any later version"; none says version 3 only. OFFBEAT's documentation page also says GPL-3.0-or-later (read 2026-10-05) | [third-party/OFFBEAT-LICENSE.txt](third-party/OFFBEAT-LICENSE.txt) |
| **SCIANTIX**, vendored inside the OFFBEAT tree (`SCIANTIX/`, not a submodule) | MIT, "Copyright (c) 2018 Davide Pizzocri, Tommaso Barani, Lelio Luzzi. Politecnico di Milano." | its own `LICENSE`; its 44 source files carry no GPL header (the `lnInclude` copies are generated links) | [third-party/SCIANTIX-LICENSE.txt](third-party/SCIANTIX-LICENSE.txt) |
| `offbeatLib/materials/iapws/IF97.H` and `IF97.C`, inside OFFBEAT | files say only "based on CoolProp-IF97 v2.1.3, Copyright (C) 2015 Ian H. Bell"; CoolProp's IF97 upstream is MIT (its `LICENSE` fetched 2026-10-06 from `raw.githubusercontent.com/CoolProp/IF97/master/LICENSE`) | the two files carry no licence text, so the MIT permission notice does not travel with them | **missing** (see section 5) |
| **OpenFOAM Foundation 9**, apt package `openfoam9` 20220602 | GNU GPL, version 3 or later; "Copyright (C) 1991-2022 OpenFOAM Foundation" | the package's copyright file; `/opt/openfoam9/COPYING` (GPL text); 1706 source headers in `src/OpenFOAM` with the same grant; the Foundation's licence page (openfoam.org/licence, 2026-10-06) says GPL and its footer GPLv3 | [third-party/openfoam9-debian-copyright.txt](third-party/openfoam9-debian-copyright.txt), [third-party/OpenFOAM-9-COPYING.txt](third-party/OpenFOAM-9-COPYING.txt) |
| `gzstream` inside OpenFOAM | LGPL, version 2.1 or later | `COPYING.LIB` in the package; its header says "version 2.1 ... or (at your option) any later version" | [third-party/openfoam9-gzstream-COPYING.LIB.txt](third-party/openfoam9-gzstream-COPYING.LIB.txt) |
| **Scotch / PT-Scotch** shared libraries shipped in the OpenFOAM package (`libscotch.so`, `libscotchmetis.so`, ...) | CeCILL-C V1, "Copyright (C) 2004-2014 ENSEIRB, IPB, Universite de Bordeaux, INRIA, CNRS"; the copyright file says "See README_scotch for details" | **neither `README_scotch` nor the CeCILL-C text is in the installed package** (searched `/opt/openfoam9` and `/usr/share/doc/openfoam9`) | **missing** (section 5) |
| Other packages `setup-feed-solver.sh` installs (gcc/g++ 11, boost 1.74, openmpi, CGAL, gnuplot, flex, bison, cmake, ...) | each its own; Debian-style `copyright` files in `/usr/share/doc/<package>/` | present in the image; **not reviewed one by one** | in the image only |
| **Ubuntu 22.04.5** root filesystem (base of `feed-solver`) | individual package licences (GPL, LGPL, MIT, ...), common texts in `/usr/share/common-licenses/`; the "Ubuntu" name and marks are Canonical's | Canonical's intellectual-property policy (canonical.com/legal/intellectual-property-policy, 2026-10-06): unmodified Ubuntu may be redistributed; a modified one needs Canonical's permission to use the marks, or the marks removed | not kept |

OpenFOAM's trademark is not addressed on the Foundation's licence page, and no trademark policy was found in this pass.

## 2. What FEED does and does not do

- FEED's code contains no OFFBEAT or OpenFOAM source. The case files it writes are plain dictionaries (`FoamFile { ... }` headers, values), not copies of OFFBEAT's templates.
- `solver/make-oracle-case.py` (the F0 harness) reads a copy of OFFBEAT's `generic_pwr_1D` test case **at run time from the user's own installation**; it does not embed it.
- The scripts in `solver/` are FEED's own (MIT). They fetch and build the upstream software on the user's machine and refuse to run on a version other than the pinned one.
- FEED runs the solver as a separate program (`wsl.exe` to `bash` to `offbeat`) and exchanges files with it. The user's Windows installation holds the solver, not FEED.
- FEED's repo does hold **outputs** of the solver as test fixtures: field files under `tests/golden/` and `solver/results/` (OpenFOAM writes a six-line banner naming OpenFOAM, its website and version at the top of each field file), and OFFBEAT log text under `tests/golden/offbeat-convergence/`. They are data, not program code. Whether that needs a notice, or the banner removed, is a question for legal review (section 5).

## 3. What each way of distributing would have to carry

**A. Install instructions only (the plan: SEED's installer, or the scripts, fetch OpenFOAM from dl.openfoam.org and OFFBEAT from GitLab on the user's machine).** FEED ships its own MIT code and the pins; it passes on no third-party code. Checklist:

- [x] FEED's [LICENSE](../../LICENSE) ships with FEED.
- [x] The README says the solver is installed separately, not bundled.
- [x] The exact versions are recorded and enforced (`solver/pins.env`, `PIN MISMATCH` stops).
- [x] This inventory exists.
- [ ] SEED's installer and its documentation say OpenFOAM and OFFBEAT are fetched, not bundled (SEED agent's item).

**B. Source distribution of FEED (publishing the repository).** The MIT notice stays with FEED. Checklist:

- [x] `LICENSE` and the `license` field are MIT.
- [x] `docs/licences/third-party/` holds reference copies of other parties' licences; they do not apply to FEED's own code and the README says so.
- [ ] Decide on the solver-output fixtures (section 2): keep, or strip the OpenFOAM banner and log text.
- [ ] If a release bundles `node_modules` or a built bundle: include the MIT, BSD-3-Clause and Apache-2.0 notices of the packages in section 1.

**C. A binary distribution: the `feed-solver` WSL image, or built solver binaries.** Not planned and not ready. It would be redistribution of GPL programs and of a modified Ubuntu. Checklist, with what is held:

| Needed | Held? |
|---|---|
| The GPL v3 text and OpenFOAM's and OFFBEAT's copyright notices | yes |
| The corresponding source for the exact OFFBEAT and OpenFOAM versions, or a written offer (GPL v3 section 6), and the build scripts | the pins and scripts yes; a source offer or archive no |
| The MIT notice of SCIANTIX | yes |
| The MIT notice of CoolProp-IF97 (IF97.H/.C) | **no** |
| The CeCILL-C text and the source availability of Scotch | **no** |
| The LGPL v2.1 text for gzstream | yes |
| The copyright file of every Debian/Ubuntu package in the image | in the image |
| For an image: Canonical's permission for a modified Ubuntu, or the marks removed | **no, undecided** |
| OpenFOAM trademark terms | **not found** |

The practical answer for now is route A, which needs none of the missing items.

## 4. Verifying and regenerating

- `solver/collect-licences.sh <dir>` copies the texts out of a pinned installation and writes `SHA256SUMS`; it was run again on the clean-distro rebuild (2026-10-06) and the hashes did not change.
- `tests/licences.test.ts` checks the saved files against `SHA256SUMS`, that this inventory names the pins and every saved file, that FEED's own licence fields are MIT, and that the licences of FEED's production npm packages are among those named here.

## 5. Still open (needs a person, or a download that was not made)

1. The **CeCILL-C** text and Scotch's `README_scotch` (upstream: the Scotch project). Not in the installed package and not downloaded in this pass.
2. The **MIT text of CoolProp-IF97** as a file (its upstream licence was read, not saved), and a decision whether to add it to a source or binary distribution.
3. **OpenFOAM trademark terms**: not on the Foundation's licence page; not found.
4. The **fixture question** in section 2, and a **legal review** of this whole document.
5. Route C for an image: **Canonical's** position on a modified Ubuntu.
6. OFFBEAT's own `LICENSE` is the GPL v3 text; the "or later" comes from the per-file headers (all 776 files that mention the GPL have it). Anyone relying on "or later" should rely on the headers, which are in the pinned source.
