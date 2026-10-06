#!/bin/bash
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib || exit 1
echo "## any table / interpolation / Function1 in the property models?"
grep -rln "Function1\|interpolationTable\|tableFile\|tabulated\|linearInterpolat\|interpolate" materials | head -20
echo "## in the whole library, by file name containing Tabulated/table"
find . -iname "*tabulat*" -o -iname "*table*" | grep -v lnInclude | head -20
echo "## userParameters.H"
sed -n 26,140p global/userParameters.H 2>/dev/null || find . -name userParameters.H | head
echo "## conductivityModel.H: the selector (New) and base data"
grep -n "New\|defaultModel\|keyword\|conductivityModel\b" materials/materialModel/thermoMechanicalPropertiesModels/conductivity/conductivityModel.H | head -30
echo "## conductivityModel.C New()"
sed -n 26,140p materials/materialModel/thermoMechanicalPropertiesModels/conductivity/conductivityModel.C
