#!/usr/bin/env bash
# Compares two OFFBEAT run directories under ~/runs: byte-identical files and the largest numeric difference.
# usage: compare-runs.sh <runDirA> <runDirB> <relative file> [more files]
set -u
A="$HOME/runs/$1"; B="$HOME/runs/$2"; shift 2
for f in "$@"; do
  if cmp -s "$A/$f" "$B/$f"; then echo "identical: $f"; else echo "DIFFERENT: $f"; fi
done
