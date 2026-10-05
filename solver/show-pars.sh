#!/usr/bin/env bash
D="$HOME/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib/materials/materialModel/thermoMechanicalPropertiesModels/conductivity"
for f in "$@"; do echo "######## $f"; sed -n '55,78p' "$D/$f.C" | grep -v "^ *$"; done
