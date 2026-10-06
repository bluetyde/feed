#!/usr/bin/env bash
# Generates an OFFBEAT oracle case from a params file (copied into the distro by the caller), runs it, prints the outcome.
# usage: run-oracle.sh <paramsFile (path visible in the distro)> <tag>
set +eu
source /opt/openfoam9/etc/bashrc
set +e
set -u
PARAMS="$1"; TAG="$2"
RUN="$HOME/runs/oracle-$TAG"
HERE="$(cd "$(dirname "$0")" && pwd)"
python3 "$HERE/make-oracle-case.py" "$PARAMS" "$RUN" || { echo "case generation failed"; exit 3; }
cd "$RUN"
start=$(date +%s.%N)
timeout 600 offbeat > log.offbeat 2>&1
code=$?
end=$(date +%s.%N)
echo "oracle=$TAG exit=$code wall=$(echo "$end - $start" | bc)s"
echo "time dirs: $(ls -d [0-9]* 2>/dev/null | sort -g | tr '\n' ' ')"
grep -n -m3 'FOAM FATAL\|FOAM exiting' log.offbeat | cut -c1-200
tail -n 12 log.offbeat | cut -c1-200

# Cell centres + raw extraction ONLY when OFFBEAT ended on its own terms and wrote the INTENDED final time. An intermediate time
# left by a timeout, a kill or a fatal error is not a result; the one accepted nonzero exit is 139, the known shutdown crash
# after the last write (docs/spike/F0-note.md). This wrapper exits nonzero whenever no result was published.
if [ "$code" != "0" ] && [ "$code" != "139" ]; then
  echo "REFUSED: OFFBEAT exit $code; no result extracted" >&2
  exit "$code"
fi
if grep -q 'FOAM FATAL' log.offbeat; then
  echo "REFUSED: FOAM FATAL in the log; no result extracted" >&2
  exit 6
fi
bash "$HERE/check-final-time.sh" "$RUN" || exit $?
postProcess -func writeCellCentres -latestTime > log.cellCentres 2>&1
python3 "$HERE/extract-result.py" "$RUN" "$RUN/result.json"
exit $?
