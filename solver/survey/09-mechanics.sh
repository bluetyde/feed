#!/bin/bash
# read-only survey of OFFBEAT's mechanics (the plan for mechanics: docs/plans/09-mechanics.md)
B=/home/feed/OpenFOAM/feed-9/applications/solvers/offbeat
cd $B || exit 1
echo "== physicsSubSolvers"; ls offbeatLib/physicsSubSolvers; ls offbeatLib/physicsSubSolvers/* | head -80
echo "== rheology"; ls offbeatLib/rheology; ls offbeatLib/rheology/* | head -80
echo "== mechanical boundary patch fields (fvPatchFields)"; ls offbeatLib/fvPatchFields; ls offbeatLib/fvPatchFields/* | head -120
echo "== thermoMechanicalPropertiesModels"; ls offbeatLib/materials/materialModel/thermoMechanicalPropertiesModels
for d in offbeatLib/materials/materialModel/thermoMechanicalPropertiesModels/*/; do echo "-- $d"; ls "$d" | grep "\.C$" | head -40; done
echo "== solverDict docs"; ls mkdocs/docs/user_guide 2>/dev/null; ls mkdocs/docs/user_guide/solverDict 2>/dev/null
