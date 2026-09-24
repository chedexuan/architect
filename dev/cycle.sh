#!/usr/bin/env bash
# Full dev cycle: stop -> lint -> pack -> relaunch -> wait for RCON.
# Repeated by hand often enough to be worth scripting.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# luaparser requires Python >= 3.7 and the platform python on this box is 3.6.
PY="${PYTHON:-python3.11}"
# dev/test.sh repoints both at the throwaway instance; a bare `bash dev/cycle.sh` is unchanged.
SERVER="${DEV_SERVER:-dev/server.sh}"
OUT="${SERVER_OUT:-.factorio-data/server.out}"

bash dev/stop.sh || true
sleep 1

if ! "$PY" dev/lint.py; then
  echo "not repacking: Lua syntax errors above"
  exit 1
fi
# GUI specs cannot be exercised without a client, so check the names against the installed
# API instead -- cheaper than a player discovering them.
if ! node dev/gui_api_check.js; then
  echo "not repacking: GUI keys not in the 2.0 API"
  exit 1
fi
# Same class: a caption that resolves to `architect.refresh` in front of a player is a bug no headless
# run can see, so the keys are matched against the locale files instead, before anything is packed.
if ! node dev/locale_check.js; then
  echo "not repacking: locale keys missing or unused above"
  exit 1
fi
"$PY" dev/pack.py || exit 1

nohup bash "$SERVER" > "$OUT" 2>&1 &
for i in $(seq 1 30); do
  if ss -ltn | grep -q ":${RCON_PORT:-27015}"; then
    echo "rcon up"; node dev/call.js ping '{}' 2>/dev/null | grep -o '"mod_version": "[^"]*"'
    # 2.0 has no game.save(), so a restart always returns the world to its on-disk state.
    # The fixtures need researched recipes, and re-granting them by hand after every cycle
    # was turning LOCKED_ENTITY errors into a ritual. Keep this list identical to the one
    # smoke.js grants: a wider one silently changes which parts card_example picks and
    # which entities count as locked.
    # The measurement bench is created on the first request and its chunks finish generating a
    # moment later; `card_lab` refuses with SANDBOX_GENERATING rather than fall back to the player's
    # surface, so the bench is asked for twice here and the suites never see that refusal.
    node dev/call.js sandbox '{}' >/dev/null 2>&1 || true
    sleep 3
    node dev/call.js sandbox '{}' 2>/dev/null | grep -o '"surface": "[^"]*"' || echo "bench not ready yet (a first card_lab will ask again)"
    node dev/lua.js 'local f=game.forces.player for _,n in ipairs({"electronics","automation","logistics","steel-processing","logistics-2","solar-energy","electric-energy-accumulators"}) do local r=f.technologies[n] if r then r.researched=true r.enabled=false end end rcon.print("techs granted (same list as smoke.js)")' 2>/dev/null | tail -1
    # Watchdog. A session once emptied every resource tile off nauvis while the on-disk save
    # stayed intact (2.0 autosaves to _autosaveN and never rewrites the source), so the
    # damage was invisible until a measurement returned a suspicious zero. Any probe that
    # touches a real surface should be able to see that it broke the world.
    node dev/lua.js 'local s=game.surfaces["nauvis"] local n=0 for _,r in ipairs(s.find_entities_filtered{type="resource"}) do n=n+1 end
if n == 0 then rcon.print("WARNING: nauvis has NO resource tiles -- restart to restore the save") else rcon.print("nauvis ore tiles: "..n) end' 2>/dev/null | tail -1
    # Fixtures: this save has no crude oil and no Space Age ore at all, and anything built by a
    # script lives only in memory -- a restart from m0.zip clears it. Rebuild the measurement
    # fields after every cycle so a rate is never measured against a field that no longer exists.
    node dev/oilfield.js 2>/dev/null | tail -1
    exit 0
  fi
  sleep 2
done
echo "server did not come up; see $OUT"
tail -20 "$OUT"
exit 1
