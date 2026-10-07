#!/bin/bash
# read-only: how OFFBEAT's own mechanics verification cases and the 1D tutorial are set up (docs/plans/09-mechanics.md)
B=/home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/Cases
for c in Verification/thickCylinderExpansion Verification/gapVolume1D Verification/gapVolumeHeatedFuel1D; do
  echo "######## $c"; ls "$B/$c"; ls "$B/$c/0" "$B/$c/constant" "$B/$c/system" 2>/dev/null | head -30
  echo "-- README / notes"; cat "$B/$c/README" 2>/dev/null | head -30
  echo "-- solverDict"; sed -n 1,120p "$B/$c/constant/solverDict" 2>/dev/null | grep -v "^ *$" | head -100
done
echo "######## testCases/generic_pwr_1D"
ls "$B/testCases/generic_pwr_1D" "$B/testCases/generic_pwr_1D/0" "$B/testCases/generic_pwr_1D/constant" 2>/dev/null | head -40
grep -n -i "mechanics\|rheology\|thermalExpansion\|swelling\|relocation\|densification\|gap\|fgr\|failure\|planeStress\|planeStrain\|axial" "$B/testCases/generic_pwr_1D/constant/solverDict" 2>/dev/null | head -80
echo "-- 0/D"; sed -n 1,90p "$B/testCases/generic_pwr_1D/0/D" 2>/dev/null | grep -v "^ *$"
