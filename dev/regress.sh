#!/usr/bin/bash
# One command for "everything is green": restart, then every suite and probe that asserts.
#
# The restart is not ceremony. `create_global_electric_network` cannot be undone on a surface,
# and the cards other suites freeze change what the solver reports for the same request, so a
# suite run against a session another suite left behind answers differently -- with rates that
# look doubled, which is the worst way to be wrong.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

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

exit $status
