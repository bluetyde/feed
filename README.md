# Fuel Performance Studio (FEED, Fuel Engineering and Experimental Design)

FEED is a browser editor and a command line for the thermal analysis of one fuel pin: steady heat conduction through fuel, gap, cladding and coolant film, or a thermal transient such as a reactor pulse. A steady case can also ask for a thermo-elastic result (displacement, stress and the gap closing into a contact) in the same radial slice. It is for students and for engineers who want a small, checkable model of a pin, with the assumptions written next to every result. The solver behind it is OFFBEAT, which runs in a separate Linux environment; without it the editor gives a closed-form quick look.

**Status: experimental and educational. Results are not validated for safety, licensing or operation.** A thermal result never implies stress, failure or fuel integrity, and a thermo-elastic result is linear elastic only: it has no creep, plasticity, swelling or cracking and says nothing about whether anything fails or holds.

## What works, and what does not

Works: the case editor and local server; runs on OFFBEAT with checks of each result against closed forms and against the solver's own fields; steady and transient (pulse) cases; a conductivity model per solid ([constant, linear, reciprocal, polynomial, table, and a burnup-dependent UO2 model](docs/conductivity-models.md)); [hot dimensions](docs/hot-dimensions.md) (radii at operating temperature from free thermal expansion); a [burnup](docs/burnup.md) for UO2 fuel; [temperature limits](docs/temperature-limits.md) with a margin check; [point kinetics](docs/point-kinetics.md) for a generated pulse; [mechanics](docs/mechanics.md) for steady cases (thermal expansion, gap closure and contact, a gas pressure in the gap, stress limits the case states, each result checked against an independent thermo-elastic solution); a library of sourced materials and strength tables; teaching examples in `examples/`, each labelled synthetic or sourced.

Does not: plate or slab geometry (one round pin, with at most a central hole whose wall is at least 5 % of the fuel radius, so a plate cannot be run as a very large pin), boiling or a critical heat flux, melting or relocation, or a boundary that changes with time (the film coefficient and the bulk temperature are constants for a run; a power history is the only thing that varies); creep, plasticity, swelling, fuel cracking or relocation, fission-gas release or a fuel history (the mechanics is thermo-elastic only, steady cases only, and the contact depends on a penalty factor that has to suit the fuel and cladding stiffness: [docs/mechanics.md](docs/mechanics.md) says how). A coated particle's mechanics is thermal plus elastic screening, not a fuel-failure code: elastic, steady, with free strains the case states; no irradiation swelling, creep or gas release is computed ([docs/triso-mechanics.md](docs/triso-mechanics.md)). A burnup case is a frozen snapshot of the conductivity: the gap stays as stated and nothing evolves. TRIGA fuel has no burnup model. Several figures in the examples are illustrative; each says so. [TODO.md](TODO.md) lists what is open.

## Install and first run

Needs Node 24. The editor and the quick look need nothing else.

```bash
npm install
npm test          # builds, then runs the tests
npm start         # the editor, on http://127.0.0.1:8771/
```

On Windows, `Start Fuel Performance Studio.cmd` does the same with a double click. With the `feed-solver` WSL distro present ([solver/PINS.md](solver/PINS.md) says how it is built and which versions it pins) the Run button runs OFFBEAT; `FEED_SOLVER=1 npm test` also runs the tests that use the real solver. OFFBEAT exits with code 139 (a segmentation fault at shutdown) after writing a complete result on every run here; FEED accepts such a run only when the output is complete and finite and the convergence record of the final step is present, and says so in the run's notes ([why](docs/spike/F0-note.md)). Tested on Windows 11 with WSL 2 only; the Linux and macOS paths for the solver are not tested.

Regenerate the bad vectors after changing the example pin: `node scripts/make-vectors.cjs`. Regenerate the SEED oracle entries after changing a case they pin: `node scripts/gen-seed-oracles.cjs` (SEED pins each entry by hash; a changed tolerance needs a new entry version made by a person).

## Where things are

`docs/` design notes, plans and [decision records](docs/decisions/); `src/core/` units, closed forms, case validator, results checks; `src/server/` and `src/web/` the server and the editor; `schema/` the case schema, error codes and good and bad vectors; `oracles/` the closed-form tables and the SEED oracle entries; `library/` sourced material, expansion and limit data; `examples/` teaching cases; `solver/` the pins and scripts for the solver environment; `tests/`. Start with [PLAN.md](PLAN.md), then [docs/README.md](docs/README.md).

FEED is one app of a small suite. A burnup can come from an OpenMC Studio depletion record, and heating and coolant conditions from other apps, through hand-off files that SEED, the experiment harness, checks ([burnup](docs/transfer-burnup.md), [heating](docs/transfer-heating.md), [boundary](docs/transfer-boundary.md)). Nothing needs SEED to run FEED.

Made with the assistance of AI coding agents, under the direction and review of the maintainer. How the project is developed (several agents, a shared log, independent reviews): [docs/WORKFLOWS.md](docs/WORKFLOWS.md). An unchecked task or a proposed contract is not implemented support.

## Licence and third-party software

FEED's own code is MIT licensed (see [LICENSE](LICENSE)). It does not contain, bundle or redistribute OpenFOAM or OFFBEAT (both GPL): the solver is installed separately (SEED's installer, or the scripts in `solver/`) and FEED runs it as a separate program. FEED writes input files in OFFBEAT's format, using OFFBEAT's keyword names, and its tests compare against output files the solver produced. No OFFBEAT source is copied. The sourced property values cite the reports and papers they come from (see `library/` and `examples/`). What is used, under which licence and what ships where is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the working notes behind it, with the texts kept for the pinned versions, are in [docs/licences](docs/licences/README.md).
