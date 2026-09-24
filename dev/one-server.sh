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

# The instance to keep is recognised by either spelling of its RCON address: `--rcon-port 27015` or
# `--rcon-bind 127.0.0.1:27015` (2.0 refuses those two options together, so binding means the port is
# only ever in the bind value). Getting this wrong kills the server that was just asked FOR.
# `ps` truncates its output to the terminal width by default, and the RCON address sits at the end
# of a ~300-character command line: without an explicit width the token that decides which server to
# KEEP is simply not there, and the script kills the instance it was asked to leave running.
#
# Matching goes by the process's own name (`comm`), not by a pattern over its arguments. A shell
# running `dev/one-server.sh` has the caller's command line in its argv, and the caller's command line
# quotes the very `bin/x64/factorio ... --start-server` string this script hunts for -- so a grep over
# `args` selects the terminal that asked for the switch and SIGTERMs it. That is how a "switch servers"
# run once took the session down with it.
rcon_of() { ps -o args= --width 4096 -p "$1" | grep -oE -- '--rcon-(bind|port)( |=)[^ ]+' | tail -1 | grep -oE '[0-9]+$'; }
others=$(ps -eo pid=,comm=,args= --width 4096 | awk -v keep="$keep" '
  $2 == "factorio" && /--start-server/ {
    line = $0
    if (index(line, "--rcon-port " keep) == 0 && index(line, "--rcon-bind 127.0.0.1:" keep) == 0 \
        && index(line, "--rcon-bind 0.0.0.0:" keep) == 0) print $1
  }')
[ -z "$others" ] && exit 0

for pid in $others; do
  port=$(rcon_of "$pid")
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
