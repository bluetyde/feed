#!/usr/bin/env bash
# Print the description and correct() body of OFFBEAT conductivity models (read-only inspection).
# usage: show-model.sh <modelFileStem> [...]     e.g. conductivityRelapZy
D="$HOME/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib/materials/materialModel/thermoMechanicalPropertiesModels/conductivity"
for f in "$@"; do
  echo "######## $f"
  sed -n '/^Description/,/^SourceFiles/p' "$D/$f.H" | head -40
  sed -n '/::correct/,$p' "$D/$f.C" | head -45
done
