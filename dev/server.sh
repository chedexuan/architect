#!/usr/bin/env bash
# Launch the headless dev server.
set -euo pipefail

INSTALL="${FACTORIO_INSTALL:-$HOME/temp/factorio}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Before starting: this box holds one Factorio server, so whichever instance is being asked for now
# stops the other one. See dev/one-server.sh for why that is a hard rule and not tidiness.
bash "$ROOT/dev/one-server.sh" "${RCON_PORT:-27015}" || exit 1

cd "$INSTALL"
exec ./bin/x64/factorio \
  -c "$ROOT/dev/config.ini" \
  --mod-directory "$ROOT/mods" \
  --start-server "$ROOT/.factorio-data/saves/${SAVE:-m0}.zip" \
  --server-settings "$ROOT/dev/server-settings.json" \
  --rcon-bind "${RCON_BIND:-127.0.0.1}:${RCON_PORT:-27015}" \
  --rcon-password "${RCON_PW:-m0pw}" \
  --console-log "$ROOT/.factorio-data/server-console.log"
