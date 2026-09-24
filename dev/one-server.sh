#!/usr/bin/env bash
# Keep this box to ONE Factorio server, and switch rather than refuse.
#
# 1.8GB of RAM, a headless server at ~400MB resident, and a CLI that was itself OOM-killed at 822MB
# during a session that had two servers up. So this is not tidiness: two of them plus a working shell
# is enough to reach for swap and get the session killed, which loses the run AND the terminal.
#
# Both launchers call this. The one being asked for is the one that stays: `dev/cycle.sh` means
# "give the player-facing server back" and `dev/test.sh bash dev/cycle.sh` means "give the tests the
# box", and either way the other one is stopped -- gracefully first, because SIGTERM lets Factorio
# save, and killing it outright would throw away however long the run had been up.
#
# Usage: bash dev/one-server.sh <rcon-port-to-keep-running>
set -uo pipefail
keep="${1:-}"
[ "${FORCE_SERVER:-0}" = "1" ] && exit 0

others=$(ps -eo pid,args | grep -E "bin/x64/factorio .*--start-server" | grep -v grep \
  | grep -vE -- "--rcon-port ${keep}" | awk '{print $1}')
[ -z "$others" ] && exit 0

for pid in $others; do
  port=$(ps -o args= -p "$pid" 2>/dev/null | grep -oE -- '--rcon-port [0-9]+' | awk '{print $2}')
  echo "one-server: stopping pid $pid (rcon port ${port:-?}) so port ${keep:-?} runs alone; SIGTERM first so it saves" >&2
  kill "$pid" 2>/dev/null || true
done
for _ in $(seq 1 40); do
  alive=$(ps -o pid= -p $others 2>/dev/null | tr -d ' ')
  [ -z "$alive" ] && break
  sleep 0.5
done
for pid in $others; do
  if ps -o pid= -p "$pid" >/dev/null 2>&1; then
    echo "one-server: pid $pid ignored SIGTERM for 20s; killing -- its save is being lost" >&2
    kill -9 "$pid" 2>/dev/null || true
  fi
done
exit 0
