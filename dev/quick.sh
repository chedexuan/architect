#!/usr/bin/env bash
# The fast loop: prove one changed thing, not the whole world.
#
# `dev/regress.sh` is the full sweep and costs about 25 minutes -- which is exactly why it stops being
# the tool you reach for after an edit, and why an edit that needed four checks took four full sweeps.
# This runs the static gates (seconds), repacks only when Lua actually changed, and then runs the
# suites that can see the files you touched.
#
#   bash dev/quick.sh                 # infer from git: what changed, what proves it
#   bash dev/quick.sh watch rig       # name the areas
#   bash dev/quick.sh all             # everything, same as regress minus the restart gates
#   bash dev/quick.sh --no-pack ...   # server already runs this code
#   bash dev/quick.sh --list          # show the map and exit
#
# Full regress still runs before a commit. This is for the minutes in between.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -uo pipefail

# Area -> the suites that would notice it being wrong. Keyed on behaviour rather than file, because
# the question after an edit is "what could this have broken", and one file often serves two areas
# (host.lua holds both the box parser and the clock policy).
areas_map() {
  case "$1" in
    helmod)   echo "helmod_ghosts_e2e helmod_steps_e2e modules_e2e bus_ring_e2e arm_filter_probe smoke" ;;
    layout)   echo "layout_ledger belt_head_e2e arm_side_probe belt_stack_probe lane_side_probe shared_row_probe arm_filter_probe two_row_starve_probe" ;;
    shape)    echo "layout_ledger belt_head_e2e" ;;
    lab)      echo "lab_reload_e2e smoke" ;;
    # 覆盖率那一把尺（dev/待办.md §6 那张表）：研究全打开、每条生产配方按 4 台问一次 card_example、
    # 按拒因归类，跑完把研究照原样还。慢（几百次远程调用），所以只在点名它的时候跑。
    coverage) echo "coverage_sweep" ;;
    undo)     echo "undo_e2e" ;;
    arm)      echo "arm_rate_e2e arm_pair_probe belt_stack_probe arm_filter_probe" ;;
    gui)      echo "smoke" ;;
    locale)   echo "refusals smoke" ;;
    core)     echo "smoke refusals layout_ledger helmod_ghosts_e2e" ;;
    fluid)    echo "fluid_line_e2e linked_pair_probe fluid_drain_probe fluid_shape_matrix pipe_cross_probe two_fluid_ports port_to_ground_probe multi_fluid_probe pipe_row_flow" ;;
    # 这几个名字**故意**不给套件：随它们的那几套门禁在 0.61.0"删到只剩 helmod→蓝图这一条链"那一刀里
    # 一起删了（`farm_rate_e2e`、`line_watch`、`power`/`solve`/`region_poles`/`pipe_seam` 那一族）。
    # 留着名字不是为了"以后补"，是为了让点名它们的人当场听见"这一面没有门禁"，而不是混在一次绿里跑过去。
    watch|rig|solve|power|seam|region) echo "" ;;
    *)        echo "" ;;
  esac
}

# 这些面**今天没有门禁**：名字认识，套件不在。
no_gate_reason() {
  case "$1" in
    watch|rig|solve|power|seam|region)
      echo "这一面的套件随 0.61.0 那一刀删了，现在没有门禁" ;;
    *) echo "这个名字既不是面也不是套件" ;;
  esac
}

# Everything, in one place rather than derived from the map above: an area list that generated this by
# walking `areas_map` would quietly drop whichever suite nobody mapped a file to, and the whole point of
# the sweep is to catch what the per-file map forgot. Kept in step with dev/regress.sh by hand.
ALL_SUITES="arm_rate_e2e belt_head_e2e bus_ring_e2e helmod_ghosts_e2e helmod_steps_e2e modules_e2e lab_reload_e2e recipe_table_e2e undo_e2e"

# File -> areas. The left column is a path under src/architect; the right is the list above.
file_areas() {
  case "$1" in
    *measure.lua)      echo "arm" ;;
    *styles.lua)       echo "layout shape" ;;
    *roles.lua|*card.lua|*ports.lua|*rat.lua) echo "core layout" ;;
    *gui.lua)          echo "gui locale" ;;
    *control.lua)      echo "core layout helmod lab undo" ;;
    *locale/*)         echo "locale" ;;
    *)                 echo "core" ;;
  esac
}

LIST=0
NOPACK=0
MISSING=""
AREAS=""
for a in "$@"; do
  case "$a" in
    --list) LIST=1 ;;
    --no-pack) NOPACK=1 ;;
    *) AREAS="$AREAS $a" ;;
  esac
done

if [ "$LIST" = 1 ]; then
  for k in helmod core layout shape arm lab undo gui locale fluid watch rig solve power seam region; do
    hit="$(areas_map "$k")"
    printf "%-8s -> %s\n" "$k" "${hit:-（没有门禁：$(no_gate_reason "$k")）}"
  done
  exit 0
fi

# Nothing named: ask git. A modified file's areas are unioned, because "I touched control.lua" is four
# questions and the cheap answer is to run all four rather than guess which one the edit was about.
if [ -z "${AREAS// /}" ]; then
  CHANGED=$(git status --porcelain 2>/dev/null | awk '{print $NF}')
  if [ -z "$CHANGED" ]; then
    echo "nothing is modified in git; name an area (see --list) or use 'all'"
    exit 0
  fi
  NEEDS_PACK=0
  for f in $CHANGED; do
    case "$f" in src/architect/*) NEEDS_PACK=1 ;; esac
    for area in $(file_areas "$f"); do
      case " $AREAS " in *" $area "*) ;; *) AREAS="$AREAS $area" ;; esac
    done
  done
  [ "$NEEDS_PACK" = 1 ] || NOPACK=1
fi

SUITES=""
for a in $AREAS; do
  hit=$(areas_map "$a")
  # Not an area? Then it is a suite, and asking for one by name should work -- `quick.sh refusals`
  # is a shorter thing to type at 1am than `quick.sh rig` when you already know which file is lying.
  if [ "$a" = "all" ]; then
    # The header promised this and the script never had it: `quick.sh all` answered "unknown area", so
    # the sweep the docs point at was only reachable by naming thirteen suites by hand.
    hit="$ALL_SUITES"
  fi
  if [ -z "$hit" ]; then
    if [ -f "dev/$a.js" ]; then hit="$a"; else
      # 认得这个名字但这一面没有套件 —— 不能静悄悄跳过去：一次"绿"里混着一个没人查的面，比一次红更贵。
      echo "注意：$a —— $(no_gate_reason "$a")"
      MISSING="$MISSING $a"
      continue
    fi
  fi
  for s in $hit; do
    case " $SUITES " in *" $s "*) ;; *) SUITES="$SUITES $s" ;; esac
  done
done
if [ -z "$SUITES" ]; then
  # 一个都没匹配上：这不是"跑完了没测到东西"，这是"什么都没跑"。按名拒，别让人以为是绿的。
  echo "no suites ran: ${MISSING# } —— 这些面今天没有门禁（见 --list），要么补套件，要么换 dev/regress.sh"
  exit 1
fi
# 跑了一些、但有些面没人查：把这行留在最上面，一次绿里混着没查的面必须是看得见的。
if [ -n "${MISSING// /}" ]; then
  echo "注意：这些面没有门禁，这一趟没查它们 ——${MISSING}"
fi

echo "areas:  ${AREAS# }"
echo "suites: ${SUITES# }"
echo

# The static gates are seconds and catch more than their size suggests: a forward reference, a locale
# row that drifted from the sentence in the code, a widget attribute that does not exist. They run
# first so a typo costs seconds rather than a suite timeout.
# The same interpreter cycle.sh picks: the platform python here is 3.6 and luaparser needs >= 3.7,
# so a hand-written `python3` would fail this gate for a reason that has nothing to do with the code.
PY="${PYTHON:-python3.11}"
bash dev/test.sh "$PY" dev/lint.py > /tmp/quick_lint.txt 2>&1 || { grep -v '^ok' /tmp/quick_lint.txt | head -20; exit 1; }
# Every suite file parsed before any of them runs. A redeclared `const` in a suite is a SyntaxError
# that kills the file before its first check, and the run reports "FAILED" with no FAIL line anywhere
# in it -- which reads like a broken mod and is a typo in the harness.
for f in dev/*.js; do
  if ! node --check "$f" > /tmp/quick_syntax.txt 2>&1; then
    echo "SYNTAX $f"; head -4 /tmp/quick_syntax.txt; exit 1
  fi
done
bash dev/test.sh node dev/gui_api_check.js 2>&1 | tail -1
bash dev/test.sh node dev/locale_check.js 2>&1 | tail -1

if [ "$NOPACK" = 0 ]; then
  echo "--- packing + restarting the test server"
  bash dev/test.sh bash dev/cycle.sh > /tmp/quick_cycle.txt 2>&1 \
    || { grep -iv '^ok' /tmp/quick_cycle.txt | tail -20; exit 1; }
  tail -1 /tmp/quick_cycle.txt
fi

status=0
for suite in $SUITES; do
  printf "%-18s " "$suite"
  if bash dev/test.sh node "dev/$suite.js" > "/tmp/quick_$suite.txt" 2>&1; then
    tail -1 "/tmp/quick_$suite.txt"
  else
    echo "FAILED"
    grep -E "^  FAIL|^FAIL" "/tmp/quick_$suite.txt" | head -6
    status=1
  fi
done
[ "$status" = 0 ] && echo "-- all matched suites pass" || echo "-- see /tmp/quick_<suite>.txt"
exit $status
