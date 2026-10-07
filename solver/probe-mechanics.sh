#!/usr/bin/env bash
# Runs one prepared OFFBEAT case folder in the feed-solver distro (user "feed") for the mechanics probes (docs/spike/mechanics-probe.md) and
# copies EVERYTHING the last time wrote (all fields, not only T and C as run-feed.sh does) to <outDir>/final, with the logs and exit.json.
# The run folder ~/runs/mech-<tag> is kept for inspection; nothing is deleted here, and an existing folder is refused.
# With a fifth argument `clean` the run folder is removed after its results are copied out (only a folder named ~/runs/mech-<tag>).
# usage: probe-mechanics.sh <inputsDir> <outDir> <tag> [timeoutSeconds] [clean]      (paths as seen from the distro, /mnt/c/...)
set +eu
source /opt/openfoam9/etc/bashrc
set +e
set -u
IN="$1"; OUT="$2"; TAG="$3"; TMO="${4:-300}"
case "$TAG" in *[!a-zA-Z0-9_-]*|"") echo "bad tag" >&2; exit 2 ;; esac
RUN="$HOME/runs/mech-$TAG"
if [ -e "$RUN" ]; then echo "run folder $RUN exists; use a new tag (nothing is deleted here)" >&2; exit 3; fi
mkdir -p "$RUN" "$OUT" || exit 3
cp -r "$IN"/. "$RUN"/ || exit 3
cd "$RUN" || exit 3
timeout --foreground "$TMO" blockMesh > log.blockMesh 2>&1
bm=$?
off=-1
if [ "$bm" -eq 0 ]; then
  timeout --foreground "$TMO" offbeat > log.offbeat 2>&1
  off=$?
fi
final=$(ls -d [0-9]* 2>/dev/null | sort -g | tail -1)
[ -z "$final" ] && final=0
if [ "$final" != "0" ]; then
  timeout --foreground "$TMO" postProcess -func writeCellCentres -latestTime > log.cellCentres 2>&1
  rm -rf "$OUT/final"; cp -r "$final" "$OUT/final"
fi
cp log.blockMesh log.offbeat "$OUT"/ 2>/dev/null
printf '{"blockMeshExit": %s, "offbeatExit": %s, "finalTime": "%s"}\n' "$bm" "$off" "$final" > "$OUT/exit.json"
echo "probe $TAG: blockMesh $bm offbeat $off final $final run folder $RUN"
if [ "${5:-}" = "clean" ] && [ "$RUN" = "$HOME/runs/mech-$TAG" ]; then cd "$HOME" && rm -rf "$RUN"; fi
