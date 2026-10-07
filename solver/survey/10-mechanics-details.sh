#!/bin/bash
# read-only survey of OFFBEAT's mechanics, part 2 (thermal expansion, creep, yield, the tutorial cases): docs/plans/09-mechanics.md
B=/home/feed/OpenFOAM/feed-9/applications/solvers/offbeat
cd $B/offbeatLib || exit 1
echo "== thermalExpansion"; ls materials/materialModel/thermoMechanicalPropertiesModels/thermalExpansion | grep "\.C$"
echo "== creepModels"; ls rheology/constitutiveLaws/creepModels | grep "\.C$"
echo "== yieldStressModels"; ls rheology/constitutiveLaws/yieldStressModels | grep "\.C$"
echo "== tractionDisplacement (rest)"; ls fvPatchFields/tractionDisplacement | grep "\.C$"
echo "== Cases"; ls $B/Cases
echo "== generic_pwr_1D files"; cd $B/Cases/generic_pwr_1D 2>/dev/null && ls . 0 constant system 2>/dev/null
echo "== generic_pwr_1D solverDict (mechanics keywords)"; grep -n -i "mechanics\|rheology\|thermalExpansion\|Young\|Poisson\|planeStress\|swelling\|relocation\|densif\|gap\|fgr\|plenum\|failure" $B/Cases/generic_pwr_1D/constant/solverDict 2>/dev/null | head -60
echo "== generic_pwr_1D 0/D boundary"; cat $B/Cases/generic_pwr_1D/0/D 2>/dev/null | head -70
