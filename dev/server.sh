#!/usr/bin/env bash
# Launch the headless dev server. Git Bash mangles leading-slash args (/c -> C:/Program Files/Git/c),
# so path conversion is disabled for everything spawned from here.
set -euo pipefail
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1

INSTALL="${FACTORIO_INSTALL:-C:/Program Files (x86)/Steam/steamapps/common/Factorio}"
ROOT="C:/qoder/factori"

cd "$INSTALL"
exec ./bin/x64/factorio.exe \
  -c "$ROOT/dev/config.ini" \
  --mod-directory "$ROOT/mods" \
  --start-server "$ROOT/.factorio-data/saves/${SAVE:-m0}.zip" \
  --server-settings "$ROOT/dev/server-settings.json" \
  --rcon-port "${RCON_PORT:-27015}" \
  --rcon-password "${RCON_PW:-m0pw}" \
  --console-log "$ROOT/.factorio-data/server-console.log"
