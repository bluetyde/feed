#!/usr/bin/env bash
# Runs a variant of a finished case: fresh inputs from <sourceRunDir>, ONE edit set chosen by <variantName>, then offbeat.
# usage: run-variant.sh <sourceRunDir> <variantName>
set +eu
source /opt/openfoam9/etc/bashrc
set +e
set -u
SRC="$HOME/runs/$1"; NAME="$2"
RUN="$HOME/runs/variant-$NAME"
rm -rf "$RUN"; mkdir -p "$RUN"
cp -r "$SRC/0" "$SRC/constant" "$SRC/system" "$RUN/"
cd "$RUN"
case "$NAME" in
  thermal-only)
    sed -i 's/^mechanicsSolver .*/mechanicsSolver         fromLatestTime;/' constant/solverDict
    sed -i "s/^fgr .*/fgr                     none;/" constant/solverDict
    ;;
  *) echo "unknown variant"; exit 2 ;;
esac
start=$(date +%s.%N)
timeout 600 offbeat > log.offbeat 2>&1
code=$?
end=$(date +%s.%N)
echo "variant=$NAME exit=$code wall=$(echo "$end - $start" | bc)s"
echo "last time dir: $(ls -d [0-9]* 2>/dev/null | sort -g | tail -1)"
grep -n -m3 'FOAM FATAL\|FOAM exiting' log.offbeat | cut -c1-200
tail -n 6 log.offbeat | cut -c1-200
