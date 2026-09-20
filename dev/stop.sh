#!/usr/bin/env bash
# Stop the dev server by whatever PID holds the RCON port. Never uses /IM, which would
# also kill an open Factorio client.
export MSYS2_ARG_CONV_EXCL='*'
port="${RCON_PORT:-27015}"
pid=$(netstat -ano | grep "0.0.0.0:${port}" | grep LISTENING | awk '{print $5}' | head -1)
if [ -z "$pid" ]; then echo "no server listening on ${port}"; exit 0; fi
taskkill /PID "$pid" /F >/dev/null && echo "stopped pid ${pid}"
