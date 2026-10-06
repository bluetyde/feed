#!/bin/bash
# the body of correct() (the equation), the defaults in the constructor, and any stated range, for every model of one family
fam="$1"
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib/materials/materialModel/thermoMechanicalPropertiesModels/$fam || exit 1
for f in *.C; do
  b=$(basename "$f" .C)
  [ "$b" = "${fam}Model" ] && continue
  echo "######## $f"
  awk '/::correct/ {on=1} on {printf "%d\t%s\n", NR, $0} on && /^}/ {exit}' "$f" | grep -v "^[0-9]*\s*$" | head -${2:-45}
  echo "-- constructor defaults / lookups:"
  grep -n "lookup\|dict.found\|subDict\|par[0-9]*(" "$f" | head -14
done
