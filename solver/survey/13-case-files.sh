#!/bin/bash
# read-only: the files of OFFBEAT's 1D mechanics verification cases (docs/plans/09-mechanics.md, M0): Allrun, 0/D, changeDictionary, blockMesh patches
B=/home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/Cases/Verification
for c in gapVolume1D gapVolumeHeatedFuel1D thickCylinderExpansion; do
  echo "################ $c"
  echo "---- Allrun"; grep -v "^ *#\|^ *$" "$B/$c/Allrun" | head -40
  for f in 0/D system/changeDictionaryDict system/controlDict; do
    echo "---- $f"; sed -n 8,140p "$B/$c/$f" 2>/dev/null | grep -v "^ *$" | head -110
  done
done
