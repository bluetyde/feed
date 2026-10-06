# Solver pins (F0, 2026-10-05)

| Component | Pin | How checked |
|---|---|---|
| WSL distro | `feed-solver`, Ubuntu 22.04.5 LTS, imported from the official `ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz` (341130963 bytes, SHA256 `1483cc5c1dce13064f774834cbffdff226559fd522a67a381a8ea77d63fb4109`, matched the published SHA256SUMS) | `wsl --import` to `C:\WSL\feed-solver` |
| OpenFOAM | Foundation 9, apt package `openfoam9` 20220602 from `dl.openfoam.org/ubuntu` (jammy), installed in `/opt/openfoam9` | `WM_PROJECT_VERSION=9` printed by the sourced bashrc |
| Compiler | gcc 11.4.0 (Ubuntu 22.04) | `gcc --version` |
| OFFBEAT | `https://gitlab.com/foam-for-nuclear/offbeat.git`, branch `master`, commit `80e84450a115b0c411e1bfa5d166379f6bf6c084` (`git describe`: `OperaHPC-MS9-175-g80e84450`) | `git rev-parse HEAD` in the build log |
| OFFBEAT docs say | master needs OpenFOAM Foundation 9 or ESI v2506 | https://foam-for-nuclear.gitlab.io/offbeat/installation/ read 2026-10-05 |
| Run user | `feed` (uid 1000) inside the distro, created by `setup-feed-solver.sh`; builds land in `/home/feed/OpenFOAM/feed-9/` | `id feed` |

The machine-readable form of these pins is [pins.env](pins.env); `setup-feed-solver.sh` installs exactly that package version and creates the run user, `build-offbeat.sh` checks out exactly that OFFBEAT commit (detached) and both stop with `PIN MISMATCH` if the result differs. `tests/solverScripts.test.ts` checks that pins.env and this table agree. A rebuild from a fresh import has still NOT been repeated (F0 review finding 1).

Scripts (run from Git Bash with `MSYS_NO_PATHCONV=1 wsl.exe -d feed-solver -u <user> --exec bash "<script>"`; `--exec` starts bash directly, which is what the backend does, and a bare `--` would run the command through the distro's default shell): `setup-feed-solver.sh` (root), `build-offbeat.sh` (feed), `run-example.sh`, `compare-runs.sh` (byte equality; exit 1 on any difference or missing file), `check-final-time.sh` (used by `run-oracle.sh` and `run-case.sh`: the latest written time must be the intended end time), `probe-failure.sh`, `run-variant.sh`. Logs are in `solver/logs/` (git-ignored).

Paths: the Windows backend accepts an absolute drive-letter path (either slash, spaces fine) and refuses everything else, including `\\wsl$\...` paths, other UNC paths and `/mnt/...`, with `expected an absolute Windows path`. Workspaces under `\\wsl$` are therefore not supported; keep them on a drive letter.
