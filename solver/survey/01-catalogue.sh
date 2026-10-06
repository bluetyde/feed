#!/bin/bash
# read-only survey of OFFBEAT's property models
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib/materials/materialModel || exit 1
echo "== top"; ls
echo "== thermoMechanicalPropertiesModels"; ls thermoMechanicalPropertiesModels
for d in thermoMechanicalPropertiesModels/*/; do
  echo "== $d"
  ls "$d" | grep -v "\.C$" | head -100
done
echo "== behavioralModels"; ls behavioralModels | head -50
