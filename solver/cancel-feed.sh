#!/usr/bin/env bash
# Cancel one FEED run: signal the process group of that run's own script, and only if the recorded process still is that script.
# usage: cancel-feed.sh <runId>
# Exit codes: 0 nothing to stop, or stopped and confirmed gone; 1 refused (the pid file does not name this run's script;
#             nothing signalled); 2 bad arguments; 3 signalled but something of the run is still alive.
#
# Ownership is established by all of: the pid file's "pid starttime" pair matches the live process (so a reused pid is refused),
# its argv is exactly  bash <.../run-feed.sh> <in> <out> <runId> <timeout>  with the run id as a whole argument, and it leads
# its own process group. A last sweep stops anything still using the run's directory as its working directory.
set -u
ID="${1:-}"
case "$ID" in *[!a-f0-9]*|"") echo "bad run id" >&2; exit 2 ;; esac
[ "${#ID}" -eq 12 ] || { echo "bad run id" >&2; exit 2; }
RUN="$HOME/runs/feed-$ID"
PIDFILE="$RUN/run.pid"

starttime() { sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }

if [ ! -f "$PIDFILE" ]; then
  echo "no pid file: the script has not started yet or has finished; the cancel flag stops it before its next phase"
  exit 0
fi
read -r pid recorded_start < "$PIDFILE" 2>/dev/null
case "$pid" in *[!0-9]*|"") echo "refused: bad pid file; nothing signalled" >&2; exit 1 ;; esac
case "$recorded_start" in *[!0-9]*|"") echo "refused: pid file has no start time; nothing signalled" >&2; exit 1 ;; esac
[ "$pid" -gt 1 ] || { echo "refused: reserved pid $pid" >&2; exit 1; }

# 1. same process as when the script wrote the file (a reused pid has a different start time)
[ "$(starttime "$pid")" = "$recorded_start" ] || { echo "refused: pid $pid is not the process recorded for run $ID (gone or reused); nothing signalled"; exit 1; }

# 2. exact argv: bash, the run script, input dir, output dir, this run id, timeout
mapfile -d '' -t ARGV < "/proc/$pid/cmdline" 2>/dev/null
if [ "${#ARGV[@]}" -ne 6 ] || [ "${ARGV[0]##*/}" != "bash" ] || [ "${ARGV[1]##*/}" != "run-feed.sh" ] || [ "${ARGV[4]}" != "$ID" ]; then
  echo "refused: pid $pid is not the script of run $ID; nothing signalled"
  exit 1
fi

# 3. leads its own process group
pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
[ "$pgid" = "$pid" ] || { echo "refused: pid $pid is not a process-group leader; nothing signalled"; exit 1; }

gone() { ! kill -0 -- "-$pid" 2>/dev/null; }
kill -TERM -- "-$pid" 2>/dev/null
for _ in $(seq 1 30); do gone && break; sleep 0.1; done
if ! gone; then
  kill -KILL -- "-$pid" 2>/dev/null
  for _ in $(seq 1 20); do gone && break; sleep 0.1; done
fi

# 4. sweep: anything still working inside this run's directory belongs to the run
sweep() {
  local found=0 p
  for p in /proc/[0-9]*; do
    p="${p#/proc/}"
    [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$RUN" ] || continue
    kill -KILL "$p" 2>/dev/null; found=1
  done
  return $found
}
sweep; sleep 0.2; sweep && swept_clean=1 || swept_clean=0

if gone && [ "$swept_clean" -eq 1 ]; then
  rm -rf "$RUN"
  echo "stopped run $ID"
  exit 0
fi
echo "signalled run $ID but part of it is still alive" >&2
exit 3
