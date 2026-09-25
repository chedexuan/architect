#!/usr/bin/bash
# One command for "everything is green": restart, then every suite and probe that asserts.
#
# The restart is not ceremony. `create_global_electric_network` cannot be undone on a surface,
# and the cards other suites freeze change what the solver reports for the same request, so a
# suite run against a session another suite left behind answers differently -- with rates that
# look doubled, which is the worst way to be wrong.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Every suite below freezes cards, lays ghosts and runs drills that eat ore, and a graceful shutdown
# saves all of that into the file the server was started from. Run this through `dev/test.sh`, which
# repoints RCON at the throwaway instance; `dev/suite-guard.js` is the same rule inside the suites.
if [ "${RCON_PORT:-27015}" = "${MAIN_RCON_PORT:-27015}" ] && [ "${ALLOW_MAIN_SUITE:-0}" != 1 ]; then
  echo "dev/regress.sh would mutate the server a client is connected to (RCON ${RCON_PORT:-27015})."
  echo "run it as: bash dev/test.sh bash dev/regress.sh"
  exit 1
fi

# The suites dig in the same ground every run: a pumpjack on a 36-tile crude field takes ore out and
# the amount is written back into the save on a graceful quit, so the third full run of a day starts
# failing a nameplate tolerance ("measured 567.2/min against 600") that the first two passed. Nothing
# about the mod changed -- the world did. Reset to the seed the suite was green on before restarting,
# so "everything is green" means the same thing every morning.
bash dev/test-reset.sh || { echo "test world could not be reset"; exit 1; }

bash dev/cycle.sh || { echo "cycle failed"; exit 1; }

# A suite with a syntax error does not pass, it just never runs -- and a suite that never runs looks
# exactly like a green line to whoever is reading the tail of this output. Three of the edits to
# dev/refusals.js made that shape in the last hour, each one caught only by the run that came after.
syntax_bad=0
for f in dev/*.js; do
  if ! node --check "$f" >/dev/null 2>&1; then
    echo "FAIL  $f"; node --check "$f" 2>&1 | head -3; syntax_bad=1
  fi
done
[ "$syntax_bad" = 0 ] && echo "ok    node --check on $(ls dev/*.js | wc -l) dev scripts"
[ "$syntax_bad" = 0 ] || { echo "not running suites: fix the syntax errors above"; exit 1; }

# The GUI spec gate lives in cycle.sh, but `gui_model`/`gui_selftest` assertions run below, and a
# suite-only invocation would otherwise read as green while an unknown widget attribute waited for a
# player to notice it. Cheap (no server), so it belongs in "everything is green" as well.
printf "%-16s " gui_api_check
if node dev/gui_api_check.js > .factorio-data/regress_gui_api.txt 2>&1; then
  tail -1 .factorio-data/regress_gui_api.txt
else
  echo "FAILED (see .factorio-data/regress_gui_api.txt)"; tail -5 .factorio-data/regress_gui_api.txt; exit 1
fi

printf "%-16s " locale_check
if node dev/locale_check.js > .factorio-data/regress_locale.txt 2>&1; then
  tail -1 .factorio-data/regress_locale.txt
else
  echo "FAILED (see .factorio-data/regress_locale.txt)"; tail -8 .factorio-data/regress_locale.txt; exit 1
fi

status=0
for suite in smoke refusals solve_e2e power_e2e corridor_e2e poletier_e2e pipe_seam_probe pipe_route_e2e seam_ask_e2e fluid_chain_e2e port_read_e2e; do
  printf "%-16s " "$suite"
  if node "dev/$suite.js" > ".factorio-data/regress_$suite.txt" 2>&1; then
    tail -1 ".factorio-data/regress_$suite.txt"
  else
    echo "FAILED (see .factorio-data/regress_$suite.txt)"
    grep -E "^  FAIL|^FAIL" ".factorio-data/regress_$suite.txt" | head -5
    status=1
  fi
done

printf "%-16s " trunk_exhaust
if node dev/trunk_exhaust.js > .factorio-data/regress_trunk.txt 2>&1; then
  tail -1 .factorio-data/regress_trunk.txt
else
  echo "FAILED (see .factorio-data/regress_trunk.txt)"; grep -E "^FAIL" .factorio-data/regress_trunk.txt | head -5
  status=1
fi

# Last, and on purpose: this gate stops and reloads the server to prove a job survives a save, and a
# failing run leaves a rig standing on the bench. Nothing that asserts about the world should inherit
# that.
printf "%-16s " lab_reload_e2e
if node dev/lab_reload_e2e.js > .factorio-data/regress_lab_reload.txt 2>&1; then
  tail -1 .factorio-data/regress_lab_reload.txt
else
  echo "FAILED (see .factorio-data/regress_lab_reload.txt)"
  grep -E "^  FAIL|SETUP" .factorio-data/regress_lab_reload.txt | head -4
  status=1
fi


exit $status
