#!/bin/bash
# read-only: look at a finished run folder under ~/runs (docs/plans/09-mechanics.md, M0). usage: 14-inspect-run.sh <run folder name> [lines]
R="$HOME/runs/$1"
cd "$R" || exit 1
echo "== ls"; ls
echo "== log.Allrun tail"; tail -n "${2:-25}" log.Allrun 2>/dev/null | cut -c1-200
echo "== python"; python3 -c "import numpy, matplotlib; print('numpy', numpy.__version__, 'matplotlib', matplotlib.__version__)" 2>&1 | tail -2
echo "== time dirs"; ls -d [0-9]* 2>/dev/null | sort -g | tail -5
echo "== fields in the last time"; ls "$(ls -d [0-9]* | sort -g | tail -1)" | head -60
