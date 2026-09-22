#!/usr/bin/env bash
# Stop the dev server by whatever PID holds the RCON port. Never kills by image name, which would
# also take out an open Factorio client.
port="${RCON_PORT:-27015}"
pid=$(ss -ltnp "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
if [ -z "$pid" ]; then echo "no server listening on ${port}"; exit 0; fi
kill -9 "$pid" && echo "stopped pid ${pid}"
