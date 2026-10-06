#!/usr/bin/env bash
# Compares files of two OFFBEAT run directories under ~/runs for BYTE equality (the determinism check: the same input must give the
# same bytes). Exit 0 only when every named file exists in both runs and is identical; 1 when any differs or is missing; 2 on usage.
# usage: compare-runs.sh <runDirA> <runDirB> <relative file> [more files]
set -u
if [ "$#" -lt 3 ]; then
  echo "usage: compare-runs.sh <runDirA> <runDirB> <relative file> [more files]" >&2
  exit 2
fi
A="$HOME/runs/$1"; B="$HOME/runs/$2"; shift 2
bad=0
for f in "$@"; do
  if [ ! -f "$A/$f" ] || [ ! -f "$B/$f" ]; then
    echo "MISSING: $f"
    bad=1
  elif cmp -s "$A/$f" "$B/$f"; then
    echo "identical: $f"
  else
    echo "DIFFERENT: $f"
    bad=1
  fi
done
exit $bad
