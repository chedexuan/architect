#!/usr/bin/env python
"""Offline gate check for src/architect.

Syntax is not the failure that costs time here -- a 25s server restart is. Three
patterns caused those restarts and all three are decidable offline in milliseconds,
so they are gates rather than review notes.

Run before pack.py. Pass paths to check a scratch file (used to prove a gate fires).
"""
import re
import sys
from pathlib import Path

try:
    from luaparser import ast
except ImportError:
    sys.exit("pip install luaparser")

ROOT = Path(__file__).resolve().parent.parent

DECL = re.compile(r"^\s*local function ([A-Za-z_]\w*)")
CALLS = re.compile(r"(?<![\w.:])([A-Za-z_]\w*)\s*\(")
NILOR = re.compile(r"\band\s+nil\s+or\b")
UNIT_FILTER = re.compile(r"find_entities_filtered\s*\{[^}]*\bunit_number\s*=")


def gates(src):
    lines = src.splitlines()
    # name -> first line from which Lua can see the local
    decls = {}
    for i, ln in enumerate(lines, 1):
        m = DECL.match(ln.split("--")[0])
        if m and m.group(1) not in decls:
            decls[m.group(1)] = i

    problems = []
    for i, ln in enumerate(lines, 1):
        code = ln.split("--")[0]
        for name in CALLS.findall(code):
            line = decls.get(name)
            if line and i < line:
                problems.append((i, "forward reference: `%s` is called here but declared as a local at "
                                     "line %d (Lua binds this call as a global lookup, which answers nil)"
                                     % (name, line)))
        if NILOR.search(code):
            problems.append((i, "`and nil or` always evaluates to the right-hand operand; use `if` "
                                "or a boolean"))
        if UNIT_FILTER.search(code):
            problems.append((i, "unit_number is not a filter key, so find_entities_filtered ignores it "
                                "and returns arbitrary entities; filter by name+area and compare "
                                "unit_number in Lua"))
    return problems


SAMPLE_HITS = """
local function uses_helper()
  return helper(1) and nil or helper(2)
end

local function helper(a)
  return game.surfaces[1].find_entities_filtered{ name = "pipe", unit_number = a }
end
"""

SAMPLE_CLEAN = """
local M = {}
local function helper(a) return a end
function M.run(x)
  local ok = x and helper(x) or false
  local list = game.surfaces[1].find_entities_filtered{ name = "pipe", type = "entity-ghost" }
  for _, e in ipairs(list) do if e.unit_number == x then return e end end
  return helper(x)
end
function M.other() return M.run(1) end
return M
"""


def selftest():
    """A gate that cannot be shown to fire is decoration, so its trigger is checked here."""
    hit = [m for _, m in gates(SAMPLE_HITS)]
    want = ("forward reference", "`and nil or`", "unit_number is not a filter key")
    missing = [w for w in want if not any(w in m for m in hit)]
    if missing:
        return "gates never fired for: " + ", ".join(missing)
    clean = gates(SAMPLE_CLEAN)
    if clean:
        return "gate fired on correct code: " + "; ".join("line %d %s" % p for p in clean)
    return None


def main():
    bad = 0
    problem = selftest()
    if problem:
        bad += 1
        print("FAIL  dev/lint.py selftest: " + problem)
    else:
        print("ok    dev/lint.py selftest (3 gates fire, clean sample passes)")

    if len(sys.argv) > 1:
        files = [Path(a).resolve() for a in sys.argv[1:]]
    else:
        files = sorted((ROOT / "src" / "architect").rglob("*.lua"))

    for f in files:
        name = f.relative_to(ROOT).as_posix() if f.is_relative_to(ROOT) else f.as_posix()
        src = f.read_text(encoding="utf-8")
        try:
            ast.parse(src)
        except Exception as e:
            bad += 1
            print("FAIL  {}: {}".format(name, str(e).strip().splitlines()[0]))
            continue
        found = gates(src)
        if found:
            bad += 1
            print("GATE  {}".format(name))
            for ln, msg in found:
                print("      line {}: {}".format(ln, msg))
        else:
            print("ok    {}".format(name))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
