#!/usr/bin/env bash
# Run one FEED case inside the feed-solver distro (user "feed"). Called by the run manager with an explicit argument list.
# usage: run-feed.sh <inputsDir> <nativeDir> <runId> <timeoutSeconds>      (paths as seen from the distro, /mnt/c/...)
# Writes <nativeDir>/{log.blockMesh,log.offbeat,exit.json,final/T,final/C}. Exit 0 means the SCRIPT got through; the solver's
# own exit code is in exit.json (OFFBEAT exits 139 after a complete run, so the manager classifies by output).
set +eu
source /opt/openfoam9/etc/bashrc
set +e
set -u
IN="$1"; OUT="$2"; ID="$3"; TMO="$4"
case "$ID" in *[!a-f0-9]*|"") echo "bad run id" >&2; exit 2 ;; esac
RUN="$HOME/runs/feed-$ID"
rm -rf "$RUN"; mkdir -p "$RUN" "$OUT/final" || exit 3
cp -r "$IN"/. "$RUN"/ || exit 3
cd "$RUN" || exit 3

blockMesh > log.blockMesh 2>&1
bm=$?
off=-1
if [ "$bm" -eq 0 ]; then
  # own session/process group so cancel can signal exactly this run
  setsid timeout "$TMO" offbeat > log.offbeat 2>&1 &
  pid=$!
  echo "$pid" > run.pid
  wait "$pid"
  off=$?
fi
final=$(ls -d [0-9]* 2>/dev/null | sort -g | tail -1)
[ -z "$final" ] && final=0
if [ "$final" != "0" ]; then
  postProcess -func writeCellCentres -latestTime > log.cellCentres 2>&1
  cp "$final/T" "$final/C" "$OUT/final/" 2>/dev/null
fi
cp log.blockMesh "$OUT/" 2>/dev/null
cp log.offbeat "$OUT/" 2>/dev/null
printf '{"blockMeshExit": %s, "offbeatExit": %s, "finalTime": %s}\n' "$bm" "$off" "$final" > "$OUT/exit.json"
exit 0
