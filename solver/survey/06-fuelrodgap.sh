#!/bin/bash
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib/fvPatchFields/temperatureCoupled || exit 1
echo "## files"; ls
echo "## fuelRodGap: keywords it reads"
grep -n "lookup\|dict\.\|lookupOrDefault\|found(" fuelRodGapFvPatchScalarField.C | head -30
echo "## fuelRodGap: what it needs from the rest of the case"
grep -n "lookupObject\|gapGas\|mesh().foundObject\|FatalError" fuelRodGapFvPatchScalarField.C | head -30
echo "## fuelRodGap.H comment block"
sed -n 26,112p fuelRodGapFvPatchScalarField.H | grep -v "^\s*$" | head -70
