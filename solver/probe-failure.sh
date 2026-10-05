#!/usr/bin/env bash
# Failure probes: copy a finished case dir, apply ONE targeted break, run offbeat, record exit code and the log tail.
# usage: probe-failure.sh <sourceRunDir> <probeName>
set +eu
source /opt/openfoam9/etc/bashrc
set +e
set -u
SRC="$HOME/runs/$1"; NAME="$2"
RUN="$HOME/runs/probe-$NAME"
rm -rf "$RUN"; mkdir -p "$RUN"
# fresh inputs only: 0/, constant/, system/ (no results)
cp -r "$SRC/0" "$SRC/constant" "$SRC/system" "$RUN/"
cd "$RUN"
case "$NAME" in
  no-mesh)        rm -rf constant/polyMesh ;;
  bad-keyword)    sed -i 's/^heatSource .*/heatSource              noSuchHeatSource;/' constant/solverDict ;;
  missing-lhgr)   sed -i '/^    lhgr /d' constant/solverDict ;;
  huge-power)     sed -i 's/^    lhgr .*/    lhgr        ( 0  5e8    5e8 );/' constant/solverDict ;;
  missing-material-block) sed -i 's/^    materials ( fuel );/    materials ( nosuchmaterial );/' constant/solverDict ;;
  *) echo "unknown probe"; exit 2 ;;
esac
timeout 300 offbeat > log.offbeat 2>&1
code=$?
echo "probe=$NAME exit=$code"
echo "has End: $(grep -c '^End' log.offbeat)"
echo "last time dir: $(ls -d [0-9]* 2>/dev/null | sort -g | tail -1)"
grep -n -m3 'FOAM FATAL\|FOAM exiting\|Floating point\|nan' log.offbeat | cut -c1-200
tail -n 8 log.offbeat | cut -c1-200
