#!/usr/bin/env bash
# Cancel one FEED run: signal the process group of that run's own script, and only if the recorded pid still is that script.
# usage: cancel-feed.sh <runId>
# Exit codes: 0 nothing to stop or stopped and confirmed gone; 1 refused (the pid is not this run's script; nothing signalled);
#             2 bad arguments; 3 signalled but the group did not exit.
set -u
ID="${1:-}"
case "$ID" in *[!a-f0-9]*|"") echo "bad run id" >&2; exit 2 ;; esac
[ "${#ID}" -eq 12 ] || { echo "bad run id" >&2; exit 2; }
RUN="$HOME/runs/feed-$ID"
PIDFILE="$RUN/run.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "no pid file: the script has not started yet or has finished; the cancel flag stops it before its next phase"
  exit 0
fi
pid=$(cat "$PIDFILE" 2>/dev/null)
case "$pid" in *[!0-9]*|"") echo "bad pid file" >&2; exit 2 ;; esac
[ "$pid" -gt 1 ] || { echo "refused: reserved pid $pid" >&2; exit 1; }

# The pid must still be this run's script, a session leader (its group id is its own pid).
cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
case "$cmd" in
  *run-feed.sh*"$ID"*) ;;
  *) echo "refused: pid $pid is not the script of run $ID; nothing signalled"; exit 1 ;;
esac
pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
[ "$pgid" = "$pid" ] || { echo "refused: pid $pid is not a process-group leader; nothing signalled"; exit 1; }

gone() { ! kill -0 -- "-$pid" 2>/dev/null; }
kill -TERM -- "-$pid" 2>/dev/null
for _ in $(seq 1 30); do gone && break; sleep 0.1; done
if ! gone; then
  kill -KILL -- "-$pid" 2>/dev/null
  for _ in $(seq 1 20); do gone && break; sleep 0.1; done
fi
if gone; then
  rm -rf "$RUN"
  echo "stopped run $ID"
  exit 0
fi
echo "signalled run $ID but its process group is still alive" >&2
exit 3
