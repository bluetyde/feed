#!/usr/bin/env bash
# Throw-away runner of plan 17 M0 (docs/spike/transient-mechanics-probe.md): one OFFBEAT case folder in the feed-solver distro (user "feed"), the fields of EVERY written time
# copied out (solver/run-feed.sh copies only T, and only for a transient; this copies T D sigma sigmaCyl gapWidth interfaceP epsTh of each time), with the logs and the wall seconds
# of each stage. The run folder ~/runs/m0-<tag> is kept; an existing folder is refused (nothing is deleted).
# A folder stage2/controlDict in the case makes a second OFFBEAT run from the last time written by the first, with that controlDict (restart / cooldown stage).
# usage: run-case.sh <inputsDir> <outDir> <tag> [timeoutSecondsPerStage]       (paths as seen from the distro, /mnt/c/...)
set +eu
source /opt/openfoam9/etc/bashrc
set +e
set -u
IN="$1"; OUT="$2"; TAG="$3"; TMO="${4:-900}"
case "$TAG" in *[!a-zA-Z0-9_-]*|"") echo "bad tag" >&2; exit 2 ;; esac
RUN="$HOME/runs/m0-$TAG"
if [ -e "$RUN" ]; then echo "run folder $RUN exists; use a new tag (nothing is deleted here)" >&2; exit 3; fi
mkdir -p "$RUN" "$OUT" || exit 3
cp -r "$IN"/. "$RUN"/ || exit 3
cd "$RUN" || exit 3
now() { date +%s.%N; }
t0=$(now)
timeout --foreground "$TMO" blockMesh > log.blockMesh 2>&1
bm=$?
off=-1; off2=-1; w1=0; w2=0
if [ "$bm" -eq 0 ]; then
  a=$(now)
  timeout --foreground "$TMO" offbeat > log.offbeat 2>&1
  off=$?
  w1=$(awk -v x="$(now)" -v y="$a" "BEGIN{print x-y}")
  if [ -e stage2/controlDict ]; then
    mv system/controlDict system/controlDict.stage1
    cp stage2/controlDict system/controlDict
    a=$(now)
    timeout --foreground "$TMO" offbeat > log.offbeat2 2>&1
    off2=$?
    w2=$(awk -v x="$(now)" -v y="$a" "BEGIN{print x-y}")
  fi
fi
final=$(ls -d [0-9]* 2>/dev/null | sort -g | tail -1)
[ -z "$final" ] && final=0
if [ "$final" != "0" ]; then
  timeout --foreground 120 postProcess -func writeCellCentres -latestTime > log.cellCentres 2>&1
  mkdir -p "$OUT/times"
  cp "$final/C" "$OUT/C"
  for d in $(ls -d [0-9]* 2>/dev/null | sort -g); do
    [ "$d" = "0" ] && continue
    mkdir -p "$OUT/times/$d"
    for f in T D sigma sigmaCyl gapWidth interfaceP epsTh; do cp "$d/$f" "$OUT/times/$d/" 2>/dev/null; done
  done
fi
cp log.blockMesh log.offbeat log.offbeat2 "$OUT"/ 2>/dev/null
cp constant/solverDict system/controlDict system/fvSolution 0/D "$OUT"/ 2>/dev/null
printf '{"blockMeshExit": %s, "offbeatExit": %s, "offbeat2Exit": %s, "finalTime": "%s", "wallStage1": %s, "wallStage2": %s}\n' "$bm" "$off" "$off2" "$final" "$w1" "$w2" > "$OUT/exit.json"
echo "m0 $TAG: blockMesh $bm offbeat $off/$off2 final $final wall $w1 + $w2 s, folder $RUN"
