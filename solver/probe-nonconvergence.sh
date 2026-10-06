#!/usr/bin/env bash
# Non-convergence probe (F0 exit review, finding 2): make a FRESH thermal case from a params file, cap the outer iterations of the
# stressAnalysis loop so a time step ends before absErrT/relResidualT meet their tolerances, run OFFBEAT, and record what it does:
# exit code, whether it says anything about the iteration limit, the last time written, and the last residual lines.
# usage: probe-nonconvergence.sh <paramsFile> <tag> <maxOuterIter> [absTolT relTolT [timeoutSeconds]]
# absTolT and relTolT replace the stressAnalysis tolerances T and relT (a tolerance of 0 can never be met, so no step converges).
# The case is generated into ~/runs/probe-nonconv-<tag> (make-oracle-case.py replaces an existing folder itself); nothing is deleted here.
set +eu
source /opt/openfoam9/etc/bashrc
set +e
set -u
PARAMS="$1"; TAG="$2"; MAXITER="$3"; ABS="${4:-}"; REL="${5:-}"; LIMIT="${6:-300}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$HOME/runs/probe-nonconv-$TAG"
python3 "$HERE/make-oracle-case.py" "$PARAMS" "$RUN" || { echo "case generation failed"; exit 3; }
cd "$RUN"
blockMesh > log.blockMesh 2>&1
echo "blockMesh exit $?"
before=$(grep -c "maxOuterIter" system/fvSolution)
sed -i "s/^\( *maxOuterIter *\)[0-9]*;/\1$MAXITER;/" system/fvSolution
# PROBE_ENDTIME: replace the end time in system/controlDict (a single 1 s step from the initial state is far from converged after
# the loop's minimum of two outer iterations); PROBE_ABSERRT: add the thermal absolute-change tolerance absErrT to stressAnalysis.
if [ -n "${PROBE_ENDTIME:-}" ]; then sed -i "s/^endTime .*/endTime         $PROBE_ENDTIME;/" system/controlDict; fi
if [ -n "${PROBE_ABSERRT:-}" ]; then sed -i "s/^\( *maxOuterIter *[0-9]*;\)/\1\n    absErrT $PROBE_ABSERRT;/" system/fvSolution; fi
echo "controlDict: $(grep -n '^endTime\|^deltaT\|^writeInterval' system/controlDict | tr -s ' ' | tr '\n' ' ')"
if [ -n "$ABS" ]; then sed -i "s/^\( *T *\)1e-5;/\1$ABS;/" system/fvSolution; fi
if [ -n "$REL" ]; then sed -i "s/^\( *relT *\)1e-6;/\1$REL;/" system/fvSolution; fi
echo "maxOuterIter lines: $before; now: $(grep -n 'maxOuterIter' system/fvSolution | tr -s ' ')"
echo "tolerances now: $(grep -n '^ *T  *[0-9e.-]*;\|^ *relT  *[0-9e.-]*;' system/fvSolution | tr -s ' ' | tr '\n' ' ')"
start=$(date +%s.%N)
timeout "$LIMIT" offbeat > log.offbeat 2>&1
code=$?
end=$(date +%s.%N)
echo "probe=$TAG maxOuterIter=$MAXITER offbeat exit=$code wall=$(echo "$end - $start" | bc)s"
echo "time dirs: $(ls -d [0-9]* 2>/dev/null | sort -g | tr '\n' ' ')"
echo "has End line: $(grep -c '^End' log.offbeat)"
echo "FOAM FATAL / exiting: $(grep -c 'FOAM FATAL\|FOAM exiting' log.offbeat)"
echo "warning lines about iterations/convergence:"
grep -n -i "warning\|not converge\|did not converge\|maximum number\|max.*iter\|unconverged" log.offbeat | sort -u -t: -k2 | head -8 | cut -c1-220
echo "residual lines (first 3 and last 3):"
grep -n "relResidualT is\|absErrT is" log.offbeat | head -3
grep -n "relResidualT is\|absErrT is" log.offbeat | tail -3
echo "outer iterations per time step (count of 'OuterIteration n. 1' lines vs time steps):"
echo "  OuterIteration lines: $(grep -c 'OuterIteration n\.' log.offbeat); Total Timesteps line: $(grep -o 'Total Timesteps = [0-9]*' log.offbeat | tail -1)"
last=$(ls -d [0-9]* 2>/dev/null | sort -g | tail -1)
if [ -n "$last" ] && [ "$last" != "0" ]; then
  postProcess -func writeCellCentres -latestTime > log.cellCentres 2>&1
  python3 "$HERE/extract-result.py" "$RUN" "$RUN/result.json"
fi
echo "tail:"
tail -n 6 log.offbeat | cut -c1-200
