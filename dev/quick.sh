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
    watch)    echo "line_watch_e2e box_here_e2e" ;;
    rig)      echo "smoke refusals" ;;
    gui)      echo "box_here_e2e line_watch_e2e smoke" ;;
    locale)   echo "refusals box_here_e2e line_watch_e2e" ;;
    solve)    echo "solve_e2e smoke" ;;
    power)    echo "power_e2e poletier_e2e" ;;
    fluid)    echo "pipe_seam_probe pipe_route_e2e fluid_chain_e2e port_read_e2e" ;;
    seam)     echo "seam_ask_e2e corridor_e2e" ;;
    undo)     echo "undo_e2e" ;;
    lab)      echo "lab_reload_e2e smoke" ;;
    region)   echo "corridor_e2e solve_e2e" ;;
    core)     echo "smoke refusals solve_e2e box_here_e2e line_watch_e2e" ;;
    *)        echo "" ;;
  esac
}

# File -> areas. The left column is a path under src/architect; the right is the list above.
file_areas() {
  case "$1" in
    *measure.lua)      echo "rig watch" ;;
    *host.lua)         echo "rig watch core" ;;
    *gui.lua)          echo "gui locale" ;;
    *control.lua)      echo "core gui watch rig" ;;
    *locale/*)         echo "locale" ;;
    *solve.lua)        echo "solve" ;;
    *power.lua)        echo "power" ;;
    *fluidrig.lua|*ports.lua|*pipe*) echo "fluid" ;;
    *seams.lua|*corridor*) echo "seam" ;;
    *card.lua|*compose.lua|*roles.lua) echo "solve core" ;;
    *region.lua|*boxes.lua) echo "region" ;;
    *)                 echo "core" ;;
  esac
}

LIST=0
NOPACK=0
AREAS=""
for a in "$@"; do
  case "$a" in
    --list) LIST=1 ;;
    --no-pack) NOPACK=1 ;;
    *) AREAS="$AREAS $a" ;;
  esac
done

if [ "$LIST" = 1 ]; then
  for k in watch rig gui locale solve power fluid seam undo lab region core; do
    printf "%-8s -> %s\n" "$k" "$(areas_map "$k")"
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
  if [ -z "$hit" ]; then
    [ -f "dev/$a.js" ] && hit="$a" || { echo "unknown area or suite: $a  (see --list)"; exit 1; }
  fi
  for s in $hit; do
    case " $SUITES " in *" $s "*) ;; *) SUITES="$SUITES $s" ;; esac
  done
done
if [ -z "$SUITES" ]; then
  echo "no suites matched those areas (see --list)"; exit 1
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
