#!/bin/bash
# show.sh <path under offbeatLib> [from] [to] : a file with line numbers (read-only)
cd /home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/offbeatLib || exit 1
f="$1"; a="${2:-1}"; b="${3:-400}"
sed -n "${a},${b}p" "$f" | cat -n | sed "s/^ *\([0-9]*\)/\1+$((a-1))/" | awk -F'\t' '{split($1,p,"+"); printf "%d\t%s\n", p[1]+p[2], $2}'
