#!/usr/bin/env bash
# A throwaway second instance, so an experiment can never damage the server a client is
# connected to. Different game port, different RCON port, different write-data -- and a
# different RCON password, which is the part that stops a forgotten env prefix from
# delivering a mutating command to the wrong server in silence.
#
# Reach it through dev/test.sh. Stop it with: RCON_PORT=27016 bash dev/stop.sh
set -euo pipefail

INSTALL="${FACTORIO_INSTALL:-$HOME/temp/factorio}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GAME_PORT="${TEST_GAME_PORT:-34397}"
RCON_PORT="${TEST_RCON_PORT:-27016}"

cd "$INSTALL"
exec ./bin/x64/factorio \
  -c "$ROOT/dev/config-test.ini" \
  --mod-directory "$ROOT/mods" \
  --start-server "$ROOT/.factorio-data/saves/m0.zip" \
  --server-settings "$ROOT/dev/server-settings.json" \
  --port "$GAME_PORT" \
  --rcon-port "$RCON_PORT" \
  --rcon-password "${TEST_RCON_PW:-testpw}" \
  --console-log "$ROOT/.factorio-test/server-console.log"
