#!/usr/bin/env bash
# Is the latest time written in an OFFBEAT run directory the INTENDED end time (endTime of system/controlDict)?
# usage: check-final-time.sh <runDir>
# Exit 0 only when it is (to a relative 1e-9). Exit 4: an earlier time was left (timeout, kill, fatal error) or none was written;
# exit 5: the controlDict or its endTime cannot be read. An intermediate time is never a result.
set -u
RUN="$1"
CD="$RUN/system/controlDict"
[ -r "$CD" ] || { echo "check-final-time: cannot read $CD" >&2; exit 5; }
end=$(sed -n 's/^endTime[[:space:]]*\([^;[:space:]]*\)[[:space:]]*;.*/\1/p' "$CD" | head -1)
[ -n "$end" ] || { echo "check-final-time: no endTime in $CD" >&2; exit 5; }
last=$(cd "$RUN" && ls -d [0-9]* 2>/dev/null | sort -g | tail -1)
[ -n "$last" ] || { echo "FINAL TIME NOT REACHED: no time directory written, intended $end" >&2; exit 4; }
if awk -v a="$last" -v b="$end" 'BEGIN { exit !(b > 0 && a >= b * (1 - 1e-9)) }'; then
  echo "final time $last reached (intended $end)"
  exit 0
fi
echo "FINAL TIME NOT REACHED: latest written time $last, intended $end" >&2
exit 4
