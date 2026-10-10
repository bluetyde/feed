# Third-party notices

FEED's own code is MIT licensed (see [LICENSE](LICENSE), "Copyright (c) 2026 bluetyde"). This file lists the third-party software and material FEED depends on or draws from, the licence of each, and whether it ships in this repository. It records what each project's own files say; it is not legal advice. The working notes behind it, with the licence texts kept for the pinned versions and how each was read, are in [docs/licences](docs/licences/README.md). A test (`tests/licences.test.ts`) checks the kept texts against their recorded hashes and checks this file against the package files.

## 1. In this repository: nothing third-party is bundled as code

The editor is one HTML page with no external script, style or font. FEED's source (`src/`, `solver/*.sh`, `scripts/`) is its own. The solver case files it writes are plain dictionaries in OpenFOAM's input format using OFFBEAT's keyword names; no OFFBEAT or OpenFOAM source or template is copied.

## 2. npm packages installed by `npm install`

Not bundled: `npm install` fetches them. Each keeps its own licence file inside its folder in `node_modules/`; the full tree and versions are in `package-lock.json`.

| Package | Version | Licence | Used for |
|---|---|---|---|
| ajv | 8.20.0 | MIT | validating cases against the JSON schema (runtime) |
| fast-deep-equal | 3.1.3 | MIT | dependency of ajv (runtime) |
| fast-uri | 3.1.8 | BSD-3-Clause | dependency of ajv (runtime) |
| json-schema-traverse | 1.0.0 | MIT | dependency of ajv (runtime) |
| require-from-string | 2.0.2 | MIT | dependency of ajv (runtime) |
| typescript | 7.0.2 | Apache-2.0 | building (development only) |
| vitest | 5.0.3 | MIT | tests (development only) |
| @types/node | 26.6.4 | MIT | type declarations (development only) |

The development tools bring further packages (MIT, Apache-2.0, ISC, BSD-3-Clause and MPL-2.0 in the current lock file); none runs when FEED is used.

## 3. Installed separately, never bundled: the solver

FEED runs OFFBEAT, built on OpenFOAM, as a separate program in its own Linux environment (a WSL distribution called `feed-solver`). The scripts in `solver/` fetch the upstream software from its own sources onto the user's machine and refuse to run on any version other than the pinned one ([solver/PINS.md](solver/PINS.md), [solver/pins.env](solver/pins.env)). FEED does not contain, copy or redistribute any of it. The licence texts kept in this repository are in [docs/licences/third-party](docs/licences/third-party/); `SHA256SUMS` there records each file's hash.

| Component | Licence | Notes |
|---|---|---|
| OFFBEAT (commit `80e84450a115b0c411e1bfa5d166379f6bf6c084`) | GNU GPL, version 3 or later | text kept: `OFFBEAT-LICENSE.txt` |
| SCIANTIX, inside the OFFBEAT tree | MIT, Copyright (c) 2018 Davide Pizzocri, Tommaso Barani, Lelio Luzzi, Politecnico di Milano | text kept: `SCIANTIX-LICENSE.txt` |
| IF97 water properties, inside OFFBEAT ("based on CoolProp-IF97 v2.1.3, Copyright (C) 2015 Ian H. Bell") | MIT (CoolProp's IF97 upstream) | the OFFBEAT files do not carry the permission notice; it is not kept here |
| OpenFOAM Foundation 9 (`openfoam9` 20220602) | GNU GPL, version 3 or later, Copyright (C) 1991-2022 OpenFOAM Foundation | texts kept: `OpenFOAM-9-COPYING.txt`, `openfoam9-debian-copyright.txt` |
| gzstream, inside OpenFOAM | GNU LGPL, version 2.1 or later | text kept: `openfoam9-gzstream-COPYING.LIB.txt` |
| Scotch / PT-Scotch libraries shipped in the OpenFOAM package | CeCILL-C version 1 | the package points to a `README_scotch` that is not in the installed package; the text is not kept here |
| Ubuntu 22.04 base image and the apt packages the setup script installs (gcc 11, boost, openmpi, CGAL, gnuplot, flex, bison, cmake and others) | each package's own licence (Debian-style `copyright` files under `/usr/share/doc/`) | present in the installed image; not listed one by one here |

**If you distribute the solver environment** (for example an exported WSL image or a virtual machine), you distribute GPL software and must pass on the licence texts and the corresponding source (or a written offer) for OFFBEAT and OpenFOAM under the GPL, and keep the notices above. This repository does not do that: it distributes install scripts only. OFFBEAT and OpenFOAM are open source, so the source is available from the upstream sources named in the pins; FEED keeps no copy.

## 4. Solver output kept as test data

Some test fixtures are output files the solver wrote: OpenFOAM field files under `tests/golden/` and `solver/results/`, and OFFBEAT log text under `tests/golden/offbeat-convergence/`. OpenFOAM writes a short banner naming OpenFOAM, its website and its version at the top of each field file. They are data used by the tests; they are kept as written, banners included, and remain under whatever notice the solver puts on its own output. They are not source code.

## 5. Published data and equations

FEED's material library and examples use numbers and equations from published reports and papers. Each entry cites its source (document, table, equation or page) in its `citation` or `source` text in `library/` and `examples/`. Only the values, the equations and their ranges are used, with citations; the documents are not included in this repository and are not redistributed. The main sources:

- Kansas State University TRIGA Mark II Safety Analysis Report (December 2004), and the University of Texas at Austin TRIGA II Safety Analysis Report (Chapter 4, August 2023): TRIGA dimensions and properties. Both are reports to the US Nuclear Regulatory Commission; the K-State report cites NUREG-1282 for the fuel temperature limits.
- W. G. Luscher and K. J. Geelhood, *Material Property Correlations: Comparisons between FRAPCON-3.4, FRAPTRAN 1.4, and MATPRO*, NUREG/CR-7024 (PNNL-19417), August 2010: the modified NFI conductivity of UO2 and the Zircaloy conductivity (US Government report).
- MATPRO-Version 11, NUREG/CR-0497 (TREE-1280), 1979: the Zircaloy conductivity (CTHCON) (US Government report).
- M. T. Simnad, "The U-ZrHx alloy: its properties and use in TRIGA fuel", Nuclear Engineering and Design 64 (1981) 403-422: U-ZrH thermal expansion.
- I. Svajger et al., "Evaluation of reactor pulse experiments", Nuclear Engineering and Technology 56 (2024) 1165-1203: stainless steel expansion.
- General Atomics report GACD 6977 (cited by the K-State report): TRIGA fuel limits.

Teaching examples marked synthetic use numbers chosen for the example, not taken from any source.

## 6. Other FEED projects

FEED exchanges files with OpenMC Studio (a depletion record), NODAL Studio and SEED. They are separate projects, are not included here, and are not needed to run FEED. A test fixture, `tests/fixtures/studio-depletion-pin-record.json`, is a copy of an output file written by OpenMC Studio's depletion writer (a short run of a synthetic UO2 pin).
