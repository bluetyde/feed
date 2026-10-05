#!/usr/bin/env bash
# Runs an OFFBEAT test case from a COPY in ~/runs/<name>-<tag> inside feed-solver (user "feed"). Never runs in the source tree.
# usage: run-example.sh <caseName> <tag>      e.g. run-example.sh generic_pwr_1D a
set -eu
CASE="$1"; TAG="$2"
set +eu
source /opt/openfoam9/etc/bashrc
set -eu
SRC="$HOME/OpenFOAM/feed-9/applications/solvers/offbeat/Cases/testCases/$CASE"
RUN="$HOME/runs/$CASE-$TAG"
rm -rf "$RUN"; mkdir -p "$HOME/runs"; cp -rL "$SRC" "$RUN"; cd "$RUN"
echo "== $(date -Is) run dir $RUN"
python3 rodMaker.py
mv blockMeshDict system
blockMesh > log.blockMesh 2>&1
echo "blockMesh exit $?"
set +e
start=$(date +%s.%N)
offbeat > log.offbeat 2>&1
echo "offbeat exit $?"
end=$(date +%s.%N)
echo "offbeat wall seconds: $(echo "$end - $start" | bc)"
tail -n 5 log.offbeat
ls
