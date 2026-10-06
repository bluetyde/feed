#!/bin/bash
# registered names and the keywords each conductivity / heat capacity model reads
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib/materials/materialModel/thermoMechanicalPropertiesModels || exit 1
for fam in conductivity heatCapacity; do
  echo "######## $fam"
  for f in $fam/*.H; do
    b=$(basename "$f")
    [ "$b" = "${fam}Model.H" ] && continue
    echo "== $b"
    grep -n "TypeName\|addToRunTimeSelection\|defineTypeName" "$f" | head -3
    grep -n "lookup\|userParameters\|par[0-9]\|readScalar\|get<\|dict_\.\|\.subDict\|Foam::pow\|FatalError" "$f" | head -14
  done
done
