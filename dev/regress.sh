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
RAN=""
RAN_MID=""
# Once before anyone runs: a stale pack makes a whole sweep green about code that is not loaded, and
# finding that out after twenty suites is a wasted run rather than a five-second one.
if ! node dev/bench_check.js > .factorio-data/regress_bench_before.txt 2>&1; then
  echo "bench is not fit to measure on:"
  grep -E "^  FAIL" .factorio-data/regress_bench_before.txt | head -5
  exit 1
fi
# One runner for every gate, so the bookkeeping below cannot lose a suite: `RAN` is written where the
# command actually runs, not where somebody remembered to add a name to a second list.
run_suite() {
  local suite="$1"
  shift
  RAN="$RAN $suite"
  printf "%-16s " "$suite"
  if "$@" > ".factorio-data/regress_$suite.txt" 2>&1; then
    tail -1 ".factorio-data/regress_$suite.txt"
  else
    echo "FAILED (see .factorio-data/regress_$suite.txt)"
    # `SETUP` too: the two gates that quit the server print why they could not start, and a run that
    # never got to its assertions is a different problem from one that failed them.
    grep -E "^  FAIL|^FAIL|SETUP" ".factorio-data/regress_$suite.txt" | head -5
    status=1
  fi
  # Between suites, not just before them: the world one suite hands to the next is the reason a
  # suite's answer can be true today and false after a reorder. `bench_check` fails on exactly the
  # four things that change what the next suite measures -- a stale pack, a borrowed world clock, a
  # rig still holding the clock, and a rig's own parts left standing on the bench.
  #
  # Two of these gates close the save and reload it on purpose, so the server they hand over is
  # legitimately a few seconds from answering: their own reload is asserted inside them, and waiting
  # here would only turn a slow reload into a red line about the bench.
  local skip_mid=0
  case "$suite" in lab_reload_e2e|undo_e2e|facts_reload_e2e) skip_mid=1;; esac
  if [ "$skip_mid" = 0 ]; then
    RAN_MID="$RAN_MID bench_check"
    if ! node dev/bench_check.js > ".factorio-data/regress_bench_after_$suite.txt" 2>&1; then
      echo "  bench dirty after $suite:"
      grep -E "^  FAIL" ".factorio-data/regress_bench_after_$suite.txt" | head -5
      status=1
    fi
  fi
}

for suite in smoke refusals recipe_table_e2e layout_ledger lane_split_probe arm_side_probe solve_e2e power_e2e corridor_e2e poletier_e2e region_poles_e2e pipe_seam_probe pipe_route_e2e seam_ask_e2e fluid_chain_e2e port_read_e2e box_here_e2e line_watch_e2e plan_rows_e2e farm_rate_e2e arm_rate_e2e circuit_wire_e2e bus_line_e2e shortage_line_e2e fluid_row_e2e helmod_ghosts_e2e; do
  run_suite "$suite" node "dev/$suite.js"
done

run_suite trunk_exhaust node dev/trunk_exhaust.js

# The gates that quit the server on purpose go last: each saves the world, reloads it, and leaves a
# rig or a row of ghosts in the process, and nothing that asserts about the world should inherit that.
# A failing run especially leaves litter -- which is why they cannot simply run first.
run_suite facts_reload_e2e node dev/facts_reload_e2e.js
run_suite lab_reload_e2e node dev/lab_reload_e2e.js
run_suite undo_e2e node dev/undo_e2e.js

# The `_e2e` suffix is this project's spelling of "a gate over a real world", and a file with that name
# which never RUNS is not red -- it is absent, which reads as green to whoever is scanning the tail of
# this output. Three gates have been added in the last two days and each had to be typed into the lists
# above by hand, so this is the check that makes forgetting one fail instead of go unnoticed.
#
# A file may opt out, but only by name and with a reason that a human wrote: the five below are
# measurement comparisons from the belt-bus argument (they print bus-vs-fanout rates and never fail), and
# pretending they assert would add four minutes of litter to every run for a line nobody checks.
# The rigs' bench default is compared against the player's map rather than asserted: the two figures
# are a handful of whole items each over a 60-second window, so "close" is the honest claim and a
# pass/fail threshold would be a coin flip dressed as a gate. Run it by hand after changing a rig.
#
# `region_e2e` and `region_layout_e2e` are the region tours: they freeze, measure, place and clean up a
# real multi-card line, and print what each step said. They contain no `check(` at all, so including
# them would add two minutes and three frozen cards to the save for a line of stdout that cannot fail.
# What the region's power plan ASSERTS lives in `region_poles_e2e`, which runs above and freezes nothing.
# `supply_pump_e2e` is the same kind of citizen: it asserts nothing, because what it established is a
# fact about the engine rather than about this mod -- a full storage tank hands nothing to a pipe, with
# or without a pump, while the same water poured into the row's own pipe fills a machine's box at once.
# It prints that in three side-by-side arrangements so the next reader can see it without retyping the
# geometry. The behaviour that depends on it is gated for real in `fluid_row_e2e`, which measures a lane
# through its own inlet row and refuses to open a window when the row stops short of a box.
SKIP_E2E="bus_e2e fanout_e2e ghost_e2e region_e2e region_layout_e2e bench_rate_compare supply_pump_e2e"
missing=""
for f in dev/*_e2e.js; do
  n=$(basename "$f" .js)
  case " $RAN " in *" $n "*) continue;; esac
  case " $SKIP_E2E " in *" $n "*) continue;; esac
  missing="$missing $n"
done
if [ -n "$missing" ]; then
  echo "NOT RUN:$missing -- a gate exists and nothing ran it (add it above, or name it in SKIP_E2E with a reason)"
  status=1
fi
# ...and the mirror: an opt-out that no longer has a file behind it is a lie waiting for the next person.
stale=""
for n in $SKIP_E2E; do
  [ -f "dev/$n.js" ] || stale="$stale $n"
done
[ -n "$stale" ] && { echo "SKIP_E2E names files that are gone:$stale -- drop them"; status=1; }

# ...and the mirror of "a gate that never runs is invisible" for the one check that runs BETWEEN suites:
# it has no `_e2e` name, so the walk above cannot see it, and a runner that stopped calling it would
# report exactly the same clean sweep as one that called it twenty times.
missing_mid=""
for n in bench_check; do
  [ -f "dev/$n.js" ] || { echo "the between-suite checker dev/$n.js is gone"; status=1; continue; }
  case " $RAN_MID " in *" $n "*) ;; *) missing_mid="$missing_mid $n";; esac
done
[ -n "$missing_mid" ] && { echo "NOT RUN:$missing_mid -- the bench is not being checked between suites"; status=1; }

exit $status
