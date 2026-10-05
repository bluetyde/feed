#!/usr/bin/env bash
# Cancel one FEED run: signal the process group recorded in that run's pid file. Touches nothing else.
# usage: cancel-feed.sh <runId>
set -u
ID="$1"
case "$ID" in *[!a-f0-9]*|"") echo "bad run id" >&2; exit 2 ;; esac
PIDFILE="$HOME/runs/feed-$ID/run.pid"
[ -f "$PIDFILE" ] || { echo "no pid file"; exit 1; }
pid=$(cat "$PIDFILE")
case "$pid" in *[!0-9]*|"") echo "bad pid"; exit 2 ;; esac
# the pid must belong to a process we started for this run (own session leader)
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
echo "signalled $pid"
