#!/bin/bash
# read-only: the last time step of a probe run's log, and what the log prints about the mechanics (docs/spike/mechanics-probe.md). usage: 15-log-lines.sh <tag>
L="$HOME/runs/mech-$1/log.offbeat"
echo "== last 45 lines"; tail -n 45 "$L" | cut -c1-170
echo "== distinct keywords about the displacement solve"; grep -i -o "Solving for D[a-z]*\|relResidualD\|absErrD\|relResidualT\|Max von Mises[^=]*\|Maximum deltaT calculated by[ a-zA-Z]*\|Execution Time = [0-9.]* s\|Total Timesteps = [0-9]*" "$L" | sort | uniq -c | sort -rn | head -20
echo "== total outer iterations of the last step"; grep -c "OuterIteration n\." "$L"
