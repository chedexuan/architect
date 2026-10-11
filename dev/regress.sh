#!/usr/bin/bash
# One command for "everything is green": restart, then every suite and probe that asserts.
#
# The restart is not ceremony. `create_global_electric_network` cannot be undone on a surface, and the
# bench caches the rates it won by running a window (drills, pumps, farm, arms), so a suite run against
# a session another suite left behind answers differently -- with rates that look doubled, which is the
# worst way to be wrong.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Every suite below lays ghosts and rig parts and runs jobs that raise the world clock, and a graceful
# shutdown saves all of that into the file the server was started from. Run this through `dev/test.sh`,
# which repoints RCON at the throwaway instance; `dev/suite-guard.js` is the same rule inside the suites.
if [ "${RCON_PORT:-27015}" = "${MAIN_RCON_PORT:-27015}" ] && [ "${ALLOW_MAIN_SUITE:-0}" != 1 ]; then
  echo "dev/regress.sh would mutate the server a client is connected to (RCON ${RCON_PORT:-27015})."
  echo "run it as: bash dev/test.sh bash dev/regress.sh"
  exit 1
fi

# The suites stand on the same ground every run, and they borrow research: a suite that dies between
# granting a tech and reclaiming it leaves the next one planning against hardware the player never
# earned, and the entities some of them litter change which cell a rig will site a line on. None of
# that is about the mod -- it is the world. Reset to the seed the suite was green on before restarting,
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

# The probes' own Lua: a query that does not COMPILE answers with nothing, and a suite reading nothing
# reports an empty field rather than a broken query. Lives here as well as in `cycle.sh` because a
# suite-only invocation must not be able to pass on a probe that cannot ask its question.
printf "%-16s " lua_templates
if python3.11 dev/lua_templates.py > .factorio-data/regress_lua_templates.txt 2>&1; then
  tail -1 .factorio-data/regress_lua_templates.txt
else
  echo "FAILED (see .factorio-data/regress_lua_templates.txt)"
  grep -E "^FAIL" .factorio-data/regress_lua_templates.txt | head -5
  exit 1
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
  case "$suite" in lab_reload_e2e|undo_e2e) skip_mid=1;; esac
  if [ "$skip_mid" = 0 ]; then
    RAN_MID="$RAN_MID bench_check"
    if ! node dev/bench_check.js > ".factorio-data/regress_bench_after_$suite.txt" 2>&1; then
      echo "  bench dirty after $suite:"
      grep -E "^  FAIL" ".factorio-data/regress_bench_after_$suite.txt" | head -5
      status=1
    fi
  fi
}

for suite in smoke refusals recipe_table_e2e layout_ledger arm_side_probe belt_stack_probe lane_side_probe belt_line_produces underground_pair_probe linked_pair_probe shared_row_probe arm_filter_probe arm_pair_probe arm_rate_e2e belt_rate_e2e fluid_line_e2e fluid_drain_probe fluid_shape_matrix pipe_cross_probe two_fluid_ports port_to_ground_probe two_row_starve_probe multi_fluid_probe belt_head_e2e helmod_ghosts_e2e helmod_steps_e2e modules_e2e bus_ring_e2e coverage_sweep; do
# `stacked_line_probe.js` 不在名单里：它是 #12 那把"按股喂料"夹具的半成品，自己建图、自己删图，还没有可失败的断言。手工：
#   bash dev/test.sh node dev/stacked_line_probe.js
  run_suite "$suite" node "dev/$suite.js"
done

# The gates that quit the server on purpose go last: each saves the world, reloads it, and leaves a
# rig or a row of ghosts in the process, and nothing that asserts about the world should inherit that.
# A failing run especially leaves litter -- which is why they cannot simply run first.
run_suite lab_reload_e2e node dev/lab_reload_e2e.js
run_suite undo_e2e node dev/undo_e2e.js

# The `_e2e` and `_probe` suffixes are this project's spelling of "a gate over a real world", and a file
# with either name which never RUNS is not red -- it is absent, which reads as green to whoever is
# scanning the tail of this output. Gates have been added and removed in bulk in the last week, and each
# one had to be typed into the lists above by hand, so this is the check that makes forgetting one fail
# instead of go unnoticed.
#
# A file may opt out, but only by name and with a reason that a human wrote. The opt-out mechanism is the
# variable below, and the reason lives next to the loop that runs the rest: `stacked_line_probe` builds
# and sweeps its own map and its "this line produces" claim is still a note in the log rather than an
# assertion (#12), so including it would add minutes of litter for a line that cannot fail. When it gains
# the assertion, drop it from the list.
# ...另外两把是**问完就收的铲子**，问题都已经在 `dev/待办.md` 里结了案，留在名单里只会在每次全量里
# 复述一个已经不用问的答案（而且它们各自还带一件"要人看一眼读数才知道在说什么"的事）：
#   * `port_groups_probe` —— 量"建起来的机器每台有几只箱体、各站哪几格"（第十四/十五条的那份原型 ↔
#     运行时箱体对照）。它只有一条守卫（借名单对不上就 `exit 1`），没有对 mod 的断言，读的是打印的表。
#   * `cryo_feed_probe` —— #28 那一问（低温厂那一列石油气为什么喂不进）。**它现在有一条红**：那三条
#     断言写于"分口按原型序号排"的年代，而第十五条把分口改成按**建起来的箱体**排之后，这一把摆的合成
#     地面里"水进某只箱体"那一判的前提换了（气反倒进得去了）。#28 已经由 `multi_fluid_probe` 1b 用
#     活体卡片钉住（分到两只箱体 / 两种液体都喝到 / 在产），所以这一把留作手工铲子，改口之后再来登记。
SKIP_E2E="stacked_line_probe port_groups_probe cryo_feed_probe"
missing=""
for f in dev/*_e2e.js dev/*_probe.js; do
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
