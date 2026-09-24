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

# Its own save, seeded from the real one once. This line used to point at .factorio-data/saves/m0.zip
# -- the SAME file the server a client connects to loads -- which made the "throwaway" instance
# write into the player's world on every graceful save. write-data was already separate (that is what
# stops the two fighting over _autosaveN.zip); the start-server path was the half nobody isolated.
SAVES="$ROOT/.factorio-test/saves"
TEST_SAVE="${TEST_SAVE:-m0-test}"
mkdir -p "$SAVES"
if [ ! -f "$SAVES/$TEST_SAVE.zip" ]; then
  if [ -f "$ROOT/.factorio-data/saves/m0.zip" ]; then
    cp "$ROOT/.factorio-data/saves/m0.zip" "$SAVES/$TEST_SAVE.zip"
    echo "seeded $SAVES/$TEST_SAVE.zip from the main save"
  else
    echo "no main save to seed from, and no $TEST_SAVE.zip -- refusing to invent a world" >&2
    exit 1
  fi
fi

bash "$ROOT/dev/one-server.sh" "$RCON_PORT" || exit 1

cd "$INSTALL"
exec ./bin/x64/factorio \
  -c "$ROOT/dev/config-test.ini" \
  --mod-directory "$ROOT/mods" \
  --start-server "$SAVES/$TEST_SAVE.zip" \
  --server-settings "$ROOT/dev/server-settings.json" \
  --port "$GAME_PORT" \
  --rcon-bind "${RCON_BIND:-127.0.0.1}:$RCON_PORT" \
  --rcon-password "${TEST_RCON_PW:-testpw}" \
  --console-log "$ROOT/.factorio-test/server-console.log"
