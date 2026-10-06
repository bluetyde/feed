#!/usr/bin/env bash
# Runs one of OFFBEAT's own verification cases (Cases/Verification/<case>) with ITS OWN Allrun, from a COPY under
# ~/runs/verif-<case>-<tag> in the feed-solver distro (user "feed"). The source tree is never touched, and nothing is deleted here
# (the Allrun scripts clean their own copy, as upstream wrote them). It prints the case's `results` file: the numbers upstream
# compares with its expected values, and records the OFFBEAT commit and OpenFOAM version the run used.
# usage: run-upstream-verification.sh <case> <tag>      e.g. run-upstream-verification.sh heatConservation a
set -eu
CASE="$1"; TAG="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/pins.env"
OFF="$HOME/OpenFOAM/feed-9/applications/solvers/offbeat"
got=$(git -C "$OFF" rev-parse HEAD)
[ "$got" = "$OFFBEAT_COMMIT" ] || { echo "PIN MISMATCH: OFFBEAT is at $got, the pin is $OFFBEAT_COMMIT (solver/pins.env)" >&2; exit 1; }
SRC="$OFF/Cases/Verification/$CASE"
RUN="$HOME/runs/verif-$CASE-$TAG"
[ -d "$SRC" ] || { echo "no such verification case: $CASE" >&2; exit 2; }
mkdir -p "$HOME/runs"
if [ -e "$RUN" ]; then echo "run folder $RUN exists; use a new tag (nothing is deleted here)" >&2; exit 3; fi
set +eu
source /opt/openfoam9/etc/bashrc
set -eu
cp -rL "$SRC" "$RUN"
echo "== $(date -Is) OFFBEAT $got, OpenFOAM $WM_PROJECT_VERSION, case $CASE, run dir $RUN"
cd "$RUN"
set +e
bash ./Allrun > log.Allrun 2>&1
code=$?
set -e
echo "Allrun exit $code"
if [ -f results ]; then echo "== results"; cat results; else echo "no results file" >&2; tail -n 15 log.Allrun; exit 4; fi
