#!/usr/bin/env bash
# Run one FEED case inside the feed-solver distro (user "feed"). Called by the run manager with an explicit argument list.
# usage: run-feed.sh <inputsDir> <nativeDir> <runId> <timeoutSeconds>      (paths as seen from the distro, /mnt/c/...)
# Writes <nativeDir>/{log.blockMesh,log.offbeat,exit.json,final/T,final/C}. Exit 0 means the SCRIPT got through; the solver's
# own exit code is in exit.json (OFFBEAT exits 139 after a complete run, so the manager classifies by output).
#
# The whole script is one process group (its own session) whose leader's pid is in <run dir>/run.pid, so cancel-feed.sh can stop
# exactly this run in any phase. <nativeDir>/cancel.flag, written by the backend, is checked before every phase, so a cancel that
# arrives before the pid file exists (or while a phase is starting) still stops the run before the next phase.
# The distro run directory is removed on exit (set FEED_KEEP_RUNDIR=1 to keep it for debugging).

if [ -z "${FEED_SESSION:-}" ]; then
  # become a session and process-group leader; -w keeps the exit status when setsid has to fork
  exec env FEED_SESSION=1 setsid -w bash "$0" "$@"
fi

set +eu
source /opt/openfoam9/etc/bashrc
set +e
set -u
IN="$1"; OUT="$2"; ID="$3"; TMO="$4"
case "$ID" in *[!a-f0-9]*|"") echo "bad run id" >&2; exit 2 ;; esac
[ "${#ID}" -eq 12 ] || { echo "bad run id" >&2; exit 2; }
RUN="$HOME/runs/feed-$ID"

cleanup() {
  rm -f "$RUN/run.pid"
  [ -z "${FEED_KEEP_RUNDIR:-}" ] && rm -rf "$RUN"
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP   # so the EXIT trap runs when cancel signals the group

mkdir -p "$OUT/final" || exit 3
cancelled() { [ -e "$OUT/cancel.flag" ]; }
stop_cancelled() { printf '{"blockMeshExit": -1, "offbeatExit": -1, "finalTime": 0, "cancelled": true}\n' > "$OUT/exit.json"; exit 0; }

cancelled && stop_cancelled
rm -rf "$RUN"; mkdir -p "$RUN" || exit 3
echo "$$" > "$RUN/run.pid"
cp -r "$IN"/. "$RUN"/ || exit 3
cd "$RUN" || exit 3

cancelled && stop_cancelled
timeout "$TMO" blockMesh > log.blockMesh 2>&1
bm=$?
off=-1
if [ "$bm" -eq 0 ]; then
  cancelled && stop_cancelled
  timeout "$TMO" offbeat > log.offbeat 2>&1
  off=$?
fi
cancelled && stop_cancelled

final=$(ls -d [0-9]* 2>/dev/null | sort -g | tail -1)
[ -z "$final" ] && final=0
if [ "$final" != "0" ]; then
  timeout "$TMO" postProcess -func writeCellCentres -latestTime > log.cellCentres 2>&1
  cancelled && stop_cancelled
  cp "$final/T" "$final/C" "$OUT/final/" 2>/dev/null
fi
cp log.blockMesh "$OUT/" 2>/dev/null
cp log.offbeat "$OUT/" 2>/dev/null
printf '{"blockMeshExit": %s, "offbeatExit": %s, "finalTime": %s}\n' "$bm" "$off" "$final" > "$OUT/exit.json"
exit 0
