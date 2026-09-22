#!/usr/bin/env bash
# Point any probe, suite, or a whole dev cycle at the throwaway test server (dev/server-test.sh)
# instead of the one a client is connected to.
#
#   dev/test.sh node dev/call.js ping '{}'
#   dev/test.sh bash dev/cycle.sh
#
# The call/lua scripts already read RCON_PORT/RCON_PW/CONSOLE_LOG from the environment, so this
# only has to set them -- no project code has to know a second server exists.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"
export RCON_PORT="${TEST_RCON_PORT:-27016}"
export RCON_PW="${TEST_RCON_PW:-testpw}"
export CONSOLE_LOG="$ROOT/.factorio-test/server-console.log"
export DEV_SERVER="$ROOT/dev/server-test.sh"
export SERVER_OUT="$ROOT/.factorio-test/server.out"
mkdir -p "$ROOT/.factorio-test"
exec "$@"
