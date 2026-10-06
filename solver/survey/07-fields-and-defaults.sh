#!/bin/bash
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib || exit 1
echo "## fields and required keywords of each conductivity model (lookupObject of a field; dict.lookup without a default)"
cd materials/materialModel/thermoMechanicalPropertiesModels/conductivity
for f in conductivity*.C; do
  b=${f%.C}; [ "$b" = "conductivityModel" ] && continue
  echo "== $b"
  grep -ho 'lookupObject<[a-zA-Z]*>("[A-Za-z_]*")\|lookupObject<[a-zA-Z]*>([a-zA-Z_]*)\|foundObject<[a-zA-Z]*>("[A-Za-z_]*")' "$f" | sort -u | tr '\n' ' '
  echo
  grep -ho 'dict.lookup("[A-Za-z_]*")\|readScalar(dict.lookup("[A-Za-z_]*"))' "$f" | sort -u | tr '\n' ' '
  echo
done
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib
echo "## userParameters.H"
sed -n 26,120p global/userParameters/userParameters.H | grep -v "^\s*$" | head -60
echo "## the default model each material class picks (constructor New() calls)"
cd materials/materialModel
for f in UO2 UPuO2 zircaloy steel1515Ti HastelloyN molybdenum inconel600 SiC PyC buffer; do
  echo "== $f"; grep -h '::New(' $f.C | sed 's/^ *//' | head -3; grep -hn 'Model::New\|New(mesh' $f.C | sed 's/^ *//' | head -12
done
