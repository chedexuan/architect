#!/usr/bin/bash
# One command for "everything is green": restart, then every suite and probe that asserts.
#
# The restart is not ceremony. `create_global_electric_network` cannot be undone on a surface,
# and the cards other suites freeze change what the solver reports for the same request, so a
# suite run against a session another suite left behind answers differently -- with rates that
# look doubled, which is the worst way to be wrong.
set -uo pipefail
cd C:/qoder/factori

bash dev/cycle.sh || { echo "cycle failed"; exit 1; }

status=0
for suite in smoke solve_e2e power_e2e corridor_e2e poletier_e2e; do
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
