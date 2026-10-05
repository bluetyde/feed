# Solver pins (F0, 2026-10-05)

| Component | Pin | How checked |
|---|---|---|
| WSL distro | `feed-solver`, Ubuntu 22.04.5 LTS, imported from the official `ubuntu-jammy-wsl-amd64-ubuntu22.04lts.rootfs.tar.gz` (341130963 bytes, SHA256 `1483cc5c1dce13064f774834cbffdff226559fd522a67a381a8ea77d63fb4109`, matched the published SHA256SUMS) | `wsl --import` to `C:\WSL\feed-solver` |
| OpenFOAM | Foundation 9, apt package `openfoam9` 20220602 from `dl.openfoam.org/ubuntu` (jammy), installed in `/opt/openfoam9` | `WM_PROJECT_VERSION=9` printed by the sourced bashrc |
| Compiler | gcc 11.4.0 (Ubuntu 22.04) | `gcc --version` |
| OFFBEAT | `https://gitlab.com/foam-for-nuclear/offbeat.git`, branch `master`, commit `80e84450a115b0c411e1bfa5d166379f6bf6c084` (`git describe`: `OperaHPC-MS9-175-g80e84450`) | `git rev-parse HEAD` in the build log |
| OFFBEAT docs say | master needs OpenFOAM Foundation 9 or ESI v2506 | https://foam-for-nuclear.gitlab.io/offbeat/installation/ read 2026-10-05 |
| Run user | `feed` (uid 1000) inside the distro; builds land in `/home/feed/OpenFOAM/feed-9/` | |

Scripts (run from Git Bash with `MSYS_NO_PATHCONV=1 wsl.exe -d feed-solver -u <user> -- bash "<script>"`): `setup-feed-solver.sh` (root), `build-offbeat.sh` (feed), `run-example.sh`, `compare-runs.sh`, `probe-failure.sh`, `run-variant.sh`. Logs are in `solver/logs/` (git-ignored).
