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
DECL_LIST = re.compile(r"^\s*local\s+(?:function\s+)?([A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_][\w]*)+)")

DECL_ANY = re.compile(r"\blocal\s+(?:function\s+)?([A-Za-z_]\w*)|\bfunction\s+([A-Za-z_]\w*)\s*\(")
CALLS = re.compile(r"(?<![\w.:])([A-Za-z_]\w*)\s*[({\"]")
NILOR = re.compile(r"\band\s+nil\s+or\b")
UNIT_FILTER = re.compile(r"find_entities_filtered\s*\{[^}]*\bunit_number\s*=")

# Names Lua and the Factorio runtime provide. Deliberately short: every entry here is a hole in the
# gate, so anything not obviously global has to be declared in the file that calls it.
GLOBALS = set("""
game script storage defines rcon helpers rendering protocols surface prototypes prototypes
math table string os coroutine bit debug io package require module self
pairs ipairs next type tonumber tostring select unpack rawget rawset setmetatable getmetatable
assert error pcall xpcall print log warn logError exit
true false nil function local end then do if while for repeat until return in and or not goto
server commands_ lua_api add_commands register_command registered
""".split())


STRINGS = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'')


def code_of(ln):
    """The line with comments and string bodies removed.

    Without this the undefined-call gate reads the words inside `"BELT_INTO_SOLID"` as calls, and a
    gate that cries wolf is switched off within a day.
    """
    ln = STRINGS.sub('""', ln)
    return ln.split("--")[0]


def gates(src):
    lines = src.splitlines()
    # name -> first line from which Lua can see the local
    decls = {}
    declared = set()
    for i, ln in enumerate(lines, 1):
        code = code_of(ln)
        m = DECL.match(code)
        if m and m.group(1) not in decls:
            decls[m.group(1)] = i
        # `local a, b, c` and `local function a, b` -- a forward declaration list is exactly how
        # the rigs break their circular references, so every name in it is declared
        for mm in DECL_LIST.finditer(code):
            for part in mm.group(1).split(","):
                part = part.strip()
                if re.match(r"^[A-Za-z_]\w*$", part): declared.add(part)
        for mm in DECL_ANY.finditer(code):
            for g in mm.groups():
                if g: declared.add(g)
    # parameters count as declared: a callback held in one is called all over these files
    for ln in lines:
        for mm in re.finditer(r"\bfunction\s*[A-Za-z_.:]*\s*\(([^)]*)\)", code_of(ln)):
            for part in mm.group(1).split(","):
                part = part.strip()
                if part and re.match(r"^[A-Za-z_]\w*$", part): declared.add(part)

    problems = []
    for i, ln in enumerate(lines, 1):
        code = code_of(ln)
        for name in CALLS.findall(code):
            line = decls.get(name)
            if line and i < line:
                problems.append((i, "forward reference: `%s` is called here but declared as a local at "
                                     "line %d (Lua binds this call as a global lookup, which answers nil)"
                                     % (name, line)))
            if name not in declared and name not in GLOBALS:
                problems.append((i, "`%s` is called but nothing in this file declares it, and it is not a "
                                    "Factorio global -- Lua reads it as a global, which is nil" % name))
        if NILOR.search(code):
            problems.append((i, "`and nil or` always evaluates to the right-hand operand; use `if` "
                                "or a boolean"))
        if UNIT_FILTER.search(code):
            problems.append((i, "unit_number is not a filter key, so find_entities_filtered ignores it "
                                "and returns arbitrary entities; filter by name+area and compare "
                                "unit_number in Lua"))
    return problems


SAMPLE_UNDEFINED = """
local function uses_missing()
  return nowhere_found(1)
end
"""

SAMPLE_UNDEFINED_CLEAN = """
local helper = require("helper")
local function ok(x, cb)
  local total = 0
  for _, v in ipairs(x) do total = total + v end
  return total + helper.field(x, "a") + math.floor(cb(x)) + tostring(game.tick)
end
"""

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
    problems = []
    if missing:
        problems.append("gates never fired for: " + ", ".join(missing))
    undef = [m for _, m in gates(SAMPLE_UNDEFINED)]
    if not any("nowhere_found" in m for m in undef):
        problems.append("the undefined-call gate never fired")
    for sample, label in ((SAMPLE_CLEAN, "clean"), (SAMPLE_UNDEFINED_CLEAN, "clean2")):
        for ln, msg in gates(sample):
            problems.append("gate fired on correct code at line %d: %s" % (ln, msg))
    return problems


def main():
    bad = 0
    problems = selftest()
    if problems:
        bad += 1
        print("FAIL  dev/lint.py selftest")
        for msg in problems:
            print("      " + msg)
    else:
        print("ok    dev/lint.py selftest (4 gates fire, 2 clean samples pass)")

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
