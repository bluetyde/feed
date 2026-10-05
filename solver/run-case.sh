#!/usr/bin/env bash
# Runs a case directory written by the FEED case writer (dist/cli/write-case.js) in a fresh run dir inside the distro.
# usage: run-case.sh <caseDir (path visible in the distro)> <tag>
set +eu
source /opt/openfoam9/etc/bashrc
set +e
set -u
SRC="$1"; TAG="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$HOME/runs/feed-$TAG"
rm -rf "$RUN"; mkdir -p "$RUN"
cp -r "$SRC"/. "$RUN"/
cd "$RUN"
blockMesh > log.blockMesh 2>&1
echo "blockMesh exit $?"
start=$(date +%s.%N)
timeout 600 offbeat > log.offbeat 2>&1
code=$?
end=$(date +%s.%N)
echo "run=$TAG offbeat exit=$code wall=$(echo "$end - $start" | bc)s"
echo "time dirs: $(ls -d [0-9]* 2>/dev/null | sort -g | tr '\n' ' ')"
grep -n -m3 'FOAM FATAL\|FOAM exiting' log.offbeat | cut -c1-200
last=$(ls -d [0-9]* 2>/dev/null | sort -g | tail -1)
if [ -n "$last" ] && [ "$last" != "0" ]; then
  postProcess -func writeCellCentres -latestTime > log.cellCentres 2>&1
  python3 "$HERE/extract-result.py" "$RUN" "$RUN/result.json"
else
  tail -n 15 log.offbeat | cut -c1-200
fi
