#!/bin/bash
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib || exit 1
echo "## where resistiveGap and gap conductance are defined"
grep -rn "resistiveGap" --include=*.C --include=*.H . | grep -v lnInclude | head -12
echo
echo "## gapGasModel registration names and base class"
grep -n "TypeName\|addToRunTimeSelection" gapGasModel/*.H gapGasModel/*.C | head -20
echo
echo "## gapGasModel.H : what a gap gas model supplies"
sed -n 60,200p gapGasModel/gapGasModel.H | grep -v "^\s*$" | head -110
