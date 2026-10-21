#!/usr/bin/env bash
# Throw-away runner of plan 17 M0 (docs/spike/transient-mechanics-probe.md): one OFFBEAT case folder in the feed-solver distro (user "feed"), the fields of EVERY written time
# copied out (solver/run-feed.sh copies only T, and only for a transient; this copies T D sigma sigmaCyl gapWidth interfaceP epsTh of each time), with the logs, the wall and CPU
# seconds of each stage. The run folder ~/runs/m0-<tag> is kept; an existing folder is refused (nothing is deleted).
# A folder stage2/controlDict in the case makes a second OFFBEAT run from the last time written by the first, with that controlDict (restart / cooldown stage); a stage2/solverDict
# replaces constant/solverDict for that stage (new constants at the restart).
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
TIMEFORMAT='%R %U %S'
timeout --foreground "$TMO" blockMesh > log.blockMesh 2>&1
bm=$?
off=-1; off2=-1
if [ "$bm" -eq 0 ]; then
  { time timeout --foreground "$TMO" offbeat > log.offbeat 2>&1 ; } 2> time1.txt
  off=$?
  if [ -e stage2/controlDict ]; then
    mv system/controlDict system/controlDict.stage1
    cp stage2/controlDict system/controlDict
    [ -e stage2/solverDict ] && { mv constant/solverDict constant/solverDict.stage1; cp stage2/solverDict constant/solverDict; }
    { time timeout --foreground "$TMO" offbeat > log.offbeat2 2>&1 ; } 2> time2.txt
    off2=$?
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
cp log.blockMesh log.offbeat log.offbeat2 time1.txt time2.txt "$OUT"/ 2>/dev/null
cp constant/solverDict system/controlDict system/fvSolution 0/D "$OUT"/ 2>/dev/null
last() { tail -1 "$1" 2>/dev/null | awk '{printf "[%s, %s, %s]", $1, $2, $3}'; }
w1=$(last time1.txt); w2=$(last time2.txt); [ -z "$w2" ] && w2="null"; [ -z "$w1" ] && w1="null"
printf '{"blockMeshExit": %s, "offbeatExit": %s, "offbeat2Exit": %s, "finalTime": "%s", "stage1_real_user_sys_s": %s, "stage2_real_user_sys_s": %s}\n' "$bm" "$off" "$off2" "$final" "$w1" "$w2" > "$OUT/exit.json"
echo "m0 $TAG: blockMesh $bm offbeat $off/$off2 final $final stage1 $w1 stage2 $w2, folder $RUN"
