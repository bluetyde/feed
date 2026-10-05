#!/usr/bin/env bash
# Delete leftover FEED run directories in the distro (feed-<12 hex> under ~/runs) older than N minutes, e.g. from runs made before
# run-feed.sh removed its own directory, or from a script killed with SIGKILL. Touches nothing else.
# usage: clean-stale-runs.sh [minutes (default 30)]
MIN="${1:-30}"
case "$MIN" in *[!0-9]*|"") echo "minutes must be a number" >&2; exit 2 ;; esac
n=0
for d in "$HOME"/runs/feed-*; do
  [ -d "$d" ] || continue
  name="${d##*/feed-}"
  case "$name" in *[!a-f0-9]*) continue ;; esac
  [ "${#name}" -eq 12 ] || continue
  # skip a run that is still active (its script holds the pid file and is alive)
  if [ -f "$d/run.pid" ] && kill -0 "$(cat "$d/run.pid" 2>/dev/null)" 2>/dev/null; then continue; fi
  if [ -n "$(find "$d" -maxdepth 0 -mmin +"$MIN" 2>/dev/null)" ]; then rm -rf "$d"; n=$((n + 1)); fi
done
echo "removed $n stale run directories"
