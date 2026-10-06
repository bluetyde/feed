# The clean-distro rebuild (2026-10-06)

Evidence for F0 review finding 1 and plan 01's exit criterion "the environment script rebuilds the same pair from scratch on a clean distro (once, recorded)". The pinned stack ([../pins.env](../pins.env), [../PINS.md](../PINS.md)) was built a second time from nothing, in a new distro, using only the two scripts, and compared with the original and with every piece of evidence saved in this repository. **It reproduced the original exactly.** Files here: [rebuild-report.json](rebuild-report.json) (what `scripts/verify-rebuild.cjs` found) and [packages-rebuild.txt](packages-rebuild.txt) (the rebuilt distro's 842 installed packages with versions). `tests/rebuild.test.ts` keeps both honest.

## What was done

| Step | Command (from Windows) | Time |
|---|---|---|
| 1. Check the pinned Ubuntu rootfs | SHA-256 of `ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz` (341,130,963 bytes) equals the one in PINS.md, `1483cc5c...b4109` | seconds |
| 2. Import it under a new name | `wsl --import feed-solver-rebuild C:\WSL\feed-solver-rebuild <tar> --version 2` | about 30 s |
| 3. Confirm it is clean | Ubuntu 22.04.5, 562 packages, no `feed` user, no compiler, no OpenFOAM | |
| 4. Setup, as root | `wsl -d feed-solver-rebuild -u root --exec bash solver/setup-feed-solver.sh` | **322 s** |
| 5. Build, as user feed | `wsl -d feed-solver-rebuild -u feed --exec bash solver/build-offbeat.sh` | **323 s** |
| 6. Compare | `node scripts/verify-rebuild.cjs feed-solver-rebuild` | about 4 minutes |
| 7. The whole test suite on the rebuild | `FEED_SOLVER=1 npx vitest run` in a scratch clone whose only change was the distro name in 8 files | about 6 minutes |

The original distro `feed-solver` was not touched by any of it (its newest run folder predates the rebuild; the suite's run folders are in the new distro). The scripts stopped nowhere: `setup-feed-solver.sh` installed `openfoam9=20220602` and found the package at exactly that version, created user `feed` (uid 1000), and `build-offbeat.sh` found the package version and then checked out OFFBEAT `80e84450...` detached (the `PIN MISMATCH` stops never fired).

## What was compared, and what came out

| Comparison | Result |
|---|---|
| Identity: OFFBEAT commit, OFFBEAT working tree, `openfoam9` version, run user, gcc, OpenFOAM version, OS | **identical** to the original (OFFBEAT `80e84450a115b0c411e1bfa5d166379f6bf6c084`, working tree changed only by the build's own `offbeatLib/Make/files` symlink; `openfoam9` 20220602; `uid=1000(feed)`; gcc 11.4.0 `1ubuntu1~22.04.3`; OpenFOAM 9; Ubuntu 22.04.5) |
| Licence texts the stack ships (`solver/collect-licences.sh`) | the five hashes are **identical** to `docs/licences/third-party/SHA256SUMS` |
| The 9 saved oracle results (`solver/results/*.json`: four meshes of the synthetic pin, four with k(T), the K-State element), regenerated with `solver/run-oracle.sh` | **all identical**, largest temperature difference **0 K** (every number equal, not only within tolerance) |
| The upstream baseline (`generic_pwr_1D` twice, two verification cases), regenerated with `scripts/make-upstream-baseline.cjs` | **identical** to `solver/results/upstream-baseline.json`: the same final-field hashes, probe series and verification numbers |
| The whole suite with the real solver, run against the rebuilt distro | **32 files, 669 tests passed, none skipped** (steady and transient runs, the run manager, the headless runner, cancel and process cleanup, the oracle tests) |

## The package inventory

842 packages in the rebuild, 851 in the original. Nothing is installed in the rebuild that the original lacks.

- **Only in the original (9):** `gdb` and its dependency chain (`libbabeltrace1`, `libboost-regex1.74.0`, `libc6-dbg`, `libdebuginfod-common`, `libdebuginfod1`, `libipt2`, `libsource-highlight-common`, `libsource-highlight4v5`). They were installed by hand during the shutdown-crash investigation; the scripts do not install a debugger.
- **Different versions (24):** all base-system packages in which the original is **newer** (systemd, vim, bind9, git-man, kmod, libelf/libdw, rsync, screen, python3-requests, libpcap and a few others). The original was upgraded at some point; the rebuild keeps what the rootfs shipped and what the setup's dependencies pulled in, and does not run `apt upgrade`. None is the compiler, the C and C++ libraries, MPI, boost, CGAL, OpenFOAM or a build tool, and the results are identical, so the numbers do not depend on them.

## What the rebuild shows about the pins, and the risks it leaves

- **The pin is satisfiable today, and today it is also the only version offered.** `apt-cache policy openfoam9` lists 20220602 and nothing else. If the OpenFOAM Foundation replaces it with a newer package and drops this one, `setup-feed-solver.sh` fails loudly at `apt-get install openfoam9=20220602`; it cannot fall back. The setup log shows the package fetched from `downloads.sourceforge.net/project/foam/foam/ubuntu` through the `dl.openfoam.org` repository. Keeping a copy of the `.deb` (88.6 MB) would remove that dependency; it was not done (a download and a licence question, see docs/licences).
- **Only the OFFBEAT commit and the OpenFOAM package are pinned.** The Ubuntu archive is not: security updates float. The comparison above shows base-system differences do not change the results, but nothing enforces that for the future.
- **One manual input:** the rootfs tarball, whose hash is pinned and checked by hand (PINS.md). Everything else is the two scripts.
- **The distro name is hard-coded** in the backend and about 15 places in the tests, so running the suite on another distro needs a text replacement (done in a scratch clone). An environment override would be simpler; it was not added.

## Repeating it

```
wsl --import feed-solver-rebuild C:\WSL\feed-solver-rebuild <rootfs.tar.gz> --version 2
wsl -d feed-solver-rebuild -u root --exec bash /mnt/c/.../solver/setup-feed-solver.sh
wsl -d feed-solver-rebuild -u feed --exec bash /mnt/c/.../solver/build-offbeat.sh
node scripts/verify-rebuild.cjs feed-solver-rebuild
```

The rebuilt distro `feed-solver-rebuild` (5.8 GB) was **removed on 2026-10-06** with `wsl --unregister feed-solver-rebuild`, after this evidence was committed and pushed (commit `64f0abe`), on the owner's instruction. The original `feed-solver` and the other distros were not touched. Nothing here depends on the rebuilt distro still existing: the report, the package inventory and the hashes are in this folder. To make another one, use the four commands above; the rootfs tarball is not in the repository (PINS.md has its name and SHA-256), and a rebuild takes about 11 minutes plus the download.
