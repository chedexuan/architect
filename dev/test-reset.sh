#!/usr/bin/env bash
# Put the test world back the way it was seeded.
#
# `--start-server <file>.zip` is not read-only: a graceful quit saves the world back into that file, so
# every suite that mines ore, freezes a card or lays a ghost leaves the next run standing on a slightly
# smaller map. It shows up as a measurement refusing with `NO_SITE_FOR_DRILL` three suites after a cycle
# that was green -- the patch is still there, the richest tile has just moved under the crash site. The
# player's own save is only ever the source of the copy, never the target.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RCON_PORT="${TEST_RCON_PORT:-27016}" bash dev/stop.sh || true
sleep 1

SAVES=".factorio-test/saves"
# The seed is the snapshot the whole suite was last green on, not the player's world: their save has
# fixture fields and mined-out patches of its own by now, and a test world cloned forward from that
# inherits a densest iron-ore patch sitting under the crash site, which the measurement rigs then
# refuse to site on. `seed.zip` is written by hand (cp m0-test.zip seed.zip) at the moment a run is
# known good, so "back to the way it was" means the way it was when it passed.
SRC="$SAVES/seed.zip"
[ -f "$SRC" ] || SRC=".factorio-data/saves/m0.zip"
DST="$SAVES/m0-test.zip"
mkdir -p "$SAVES"
if [ ! -f "$SRC" ]; then echo "no seed and no main save to re-seed from" >&2; exit 1; fi
if [ -f "$DST" ]; then
  mv "$DST" "$SAVES/m0-test.stale-$(date +%s).zip"
  echo "moved the drifted test save aside"
fi
cp "$SRC" "$DST"
echo "re-seeded $DST from $SRC"
# Anything older than a few runs is nobody's business again.
find "$SAVES" -maxdepth 1 -name 'm0-test.stale-*.zip' -printf '%T@ %p\n' 2>/dev/null | sort -rn |
  tail -n +4 | cut -d' ' -f2- | while read -r f; do rm -f "$f"; done
