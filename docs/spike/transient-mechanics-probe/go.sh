#!/usr/bin/env bash
# Throw-away driver (plan 17 M0), Git Bash: generate a case (gen-case.cjs), run it in the feed-solver distro (run-case.sh) and summarise the convergence of every step.
# usage: go.sh <tag> <gen-case.cjs arguments...>      the case and its output go to $M0DIR/in-<tag> and $M0DIR/out-<tag>
M0DIR=${M0DIR:-./scratch/m0}
WIN=${M0WSL:?set M0WSL to the WSL path of $M0DIR (a /mnt/... path)}
HERE="$(cd "$(dirname "$0")" && pwd)"
TAG="$1"; shift
mkdir -p "$M0DIR"
node "$HERE/gen-case.cjs" --out "$M0DIR/in-$TAG" "$@" > "$M0DIR/gen-$TAG.json" || exit 1
MSYS_NO_PATHCONV=1 wsl -d feed-solver -u feed -- bash /mnt/c/agents/claude/feed-m0/docs/spike/transient-mechanics-probe/run-case.sh "$WIN/in-$TAG" "$WIN/out-$TAG" "$TAG" "${M0TMO:-900}"
for L in log.offbeat log.offbeat2; do
  [ -e "$M0DIR/out-$TAG/$L" ] && echo "$L: $(node "$HERE/log-summary.cjs" "$M0DIR/out-$TAG/$L" "$M0DIR/out-$TAG/fvSolution" --json "$M0DIR/out-$TAG/$L.summary.json")"
done
cat "$M0DIR/out-$TAG/exit.json"
