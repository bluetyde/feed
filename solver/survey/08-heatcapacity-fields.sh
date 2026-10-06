#!/bin/bash
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib/materials/materialModel/thermoMechanicalPropertiesModels/heatCapacity || exit 1
for f in heatCapacity*.C; do
  b=${f%.C}; [ "$b" = "heatCapacityModel" ] && continue
  echo "== $b"
  grep -ho 'lookupObject<[a-zA-Z]*>("[A-Za-z_]*")\|lookupObject<[a-zA-Z]*>([a-zA-Z_]*)\|foundObject<[a-zA-Z]*>("[A-Za-z_]*")' "$f" | sort -u | tr '\n' ' '
  grep -ho 'dict.lookup("[A-Za-z_]*")' "$f" | sort -u | tr '\n' ' '
  echo
done
echo "## density and emissivity models that are temperature-only constants (the constant material's own)"
cd ..
grep -n "TypeName" density/densityConstant.H emissivity/emissivityConstant.H
grep -n "lookup" density/densityConstant.C emissivity/emissivityConstant.C | head -6
