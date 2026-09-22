#!/usr/bin/env bash
# Launch the headless dev server.
set -euo pipefail

INSTALL="${FACTORIO_INSTALL:-$HOME/temp/factorio}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$INSTALL"
exec ./bin/x64/factorio \
  -c "$ROOT/dev/config.ini" \
  --mod-directory "$ROOT/mods" \
  --start-server "$ROOT/.factorio-data/saves/${SAVE:-m0}.zip" \
  --server-settings "$ROOT/dev/server-settings.json" \
  --rcon-port "${RCON_PORT:-27015}" \
  --rcon-password "${RCON_PW:-m0pw}" \
  --console-log "$ROOT/.factorio-data/server-console.log"
