#!/usr/bin/env python
"""Offline gate check for src/architect.

Syntax is not the failure that costs time here -- a 25s server restart is. Three
patterns caused those restarts and all three are decidable offline in milliseconds,
so they are gates rather than review notes.

Run before pack.py. Pass paths to check a scratch file (used to prove a gate fires).
"""
import json
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
# Words that sit where a call would and are not one. `elseif (x) then` matched CALLS and was
# reported as a missing global -- a false alarm on a gate is worse than no gate, because the next
# person starts dismissing its output. Kept apart from GLOBALS on purpose: a keyword can never be
# a variable name, so skipping it costs the gate nothing.
KEYWORDS = {"elseif", "then", "do", "end", "else", "until", "repeat", "break", "continue"}
NILOR = re.compile(r"\band\s+nil\s+or\b")
UNIT_FILTER = re.compile(r"find_entities_filtered\s*\{[^}]*\bunit_number\s*=")
# Factorio keeps ONE handler per bootstrap event: a second `script.on_load(f)` replaces the first
# with no warning. This cost the mod its whole player-facing GUI -- the cache-clearing hooks at the
# bottom of control.lua silently overrode the command registration -- so the shape is a gate now.
BOOTSTRAP = re.compile(r"^\s*script\.(on_init|on_load|on_configuration_changed)\s*\(")

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

# `host.tank_capacity()` reads as a global table lookup plus a call: if host.lua never defines that
# field, Lua raises at the moment the rig runs, which is a server restart away. The bare-name gate
# cannot see it because the name is preceded by a dot, so the module's own export list is checked.
DOTCALL = re.compile(r"\b([a-z]\w*)\.([A-Za-z_]\w*)\s*\(")
REQUIRES = re.compile(r'local\s+([a-z]\w*)\s*=\s*require\("(\w+)"\)')


def module_exports(directory):
    exports = {}
    for f in Path(directory).glob("*.lua"):
        names = set()
        text = f.read_text(encoding="utf-8")
        for mm in re.finditer(r"^\s*(?:local\s+)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=", text, re.M):
            names.add(mm.group(2))
        for mm in re.finditer(r"^\s*function\s+([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(", text, re.M):
            names.add(mm.group(2))
        for mm in re.finditer(r"^\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*function\s*\(", text, re.M):
            names.add(mm.group(1))
        # a table literal returned at the end: `return { name = ..., }`
        tail = text[text.rfind("return"):] if "return" in text else ""
        for mm in re.finditer(r"^\s*([A-Za-z_]\w*)\s*=\s*", tail, re.M):
            names.add(mm.group(1))
        exports[f.stem] = names
    return exports


def code_of(ln):
    """The line with comments and string bodies removed.

    Without this the gates read the words inside `"BELT_INTO_SOLID"` as calls, and a gate that cries
    wolf is switched off within a day.
    """
    ln = STRINGS.sub('""', ln)
    return ln.split("--")[0]


def gates(src, exports=None):
    lines = src.splitlines()
    exports = exports or {}
    aliases = {}
    for mm in REQUIRES.finditer(src):
        aliases[mm.group(1)] = mm.group(2)
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
    seen_bootstrap = {}
    for i, ln in enumerate(lines, 1):
        m = BOOTSTRAP.match(code_of(ln))
        if m:
            first = seen_bootstrap.get(m.group(1))
            if first:
                problems.append((i, "`script.%s` is registered again here (first at line %d): Factorio "
                                 "keeps one handler per bootstrap event and the second replaces the "
                                 "first silently" % (m.group(1), first)))
            else:
                seen_bootstrap[m.group(1)] = i
    for i, ln in enumerate(lines, 1):
        code = code_of(ln)
        for name in CALLS.findall(code):
            if name in KEYWORDS: continue
            line = decls.get(name)
            if line and i < line:
                problems.append((i, "forward reference: `%s` is called here but declared as a local at "
                                     "line %d (Lua binds this call as a global lookup, which answers nil)"
                                     % (name, line)))
            if name not in declared and name not in GLOBALS:
                problems.append((i, "`%s` is called but nothing in this file declares it, and it is not a "
                                    "Factorio global -- Lua reads it as a global, which is nil" % name))
        for alias, field in DOTCALL.findall(code):
            mod = aliases.get(alias)
            if not mod:
                continue
            known = exports.get(mod)
            if known is None or not known:
                continue
            if field not in known:
                problems.append((i, "`%s.%s` is called but %s.lua does not define it -- the table "
                                    "lookup answers nil and the call raises" % (alias, field, mod)))
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

SAMPLE_DOTTED = """
local host = require("host")
local function uses_missing_field()
  return host.not_a_real_field(1)
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

local function first() end
local function second() end
script.on_load(first)
script.on_load(second)
"""

SAMPLE_CLEAN = """
local M = {}
-- parenthesised control flow is not a call, and used to be reported as one
local function branch(x)
  if (x == 1) then return "one"
  elseif (x == 2) then return "two"
  end
  return not (x > 3) and "low" or "high"
end
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
    want = ("forward reference", "`and nil or`", "unit_number is not a filter key",
            "is registered again here")
    missing = [w for w in want if not any(w in m for m in hit)]
    problems = []
    if missing:
        problems.append("gates never fired for: " + ", ".join(missing))
    undef = [m for _, m in gates(SAMPLE_UNDEFINED)]
    if not any("nowhere_found" in m for m in undef):
        problems.append("the undefined-call gate never fired")
    dotted = [m for _, m in gates(SAMPLE_DOTTED, {
        "host": {"field", "fail", "tank_capacity"},
    })]
    if not any("not_a_real_field" in m for m in dotted):
        problems.append("the missing-module-field gate never fired")
    if any("tank_capacity" in m for m in dotted):
        problems.append("the missing-module-field gate fired on a field that exists")
    for sample, label in ((SAMPLE_CLEAN, "clean"), (SAMPLE_UNDEFINED_CLEAN, "clean2")):
        for ln, msg in gates(sample):
            problems.append("gate fired on correct code at line %d: %s" % (ln, msg))
    return problems


def version_pair():
    """The mod reports its version in two places: `info.json` names the zip and Factorio's own mod
    list, and `MOD_VERSION` in control.lua is what every answer says. They drift the moment someone
    bumps one -- this commit history has a rule that the version string follows the change, and twice
    in one night a commit said a version the tree did not carry. A message can be corrected; a mod
    that reports a version it was not built as cannot be noticed by its caller."""
    problems = []
    try:
        info = json.loads((ROOT / "src" / "architect" / "info.json").read_text(encoding="utf-8"))
    except Exception as e:
        return ["info.json unreadable: %s" % e]
    control = (ROOT / "src" / "architect" / "control.lua").read_text(encoding="utf-8")
    m = re.search(r'local\s+MOD_VERSION\s*=\s*"([^"]+)"', control)
    if not m:
        return ['control.lua has no `local MOD_VERSION = "<version>"` line']
    declared, reported = info.get("version"), m.group(1)
    if declared != reported:
        problems.append("info.json says %s but control.lua reports %s -- one bump, two places"
                        % (declared, reported))
    zip_name = "%s_%s.zip" % (info.get("name"), declared)
    packed = sorted(f.name for f in (ROOT / "mods").glob("*.zip")) if (ROOT / "mods").is_dir() else []
    if packed and zip_name not in packed:
        # Reported, not failed: this gate runs before pack.py in dev/cycle.sh, so "mods/ holds the
        # last build" is the normal state of an edited tree and would block the very cycle that
        # fixes it.
        print("note   mods/ holds %s, not %s -- stale until the next pack"
              % (", ".join(packed) or "nothing", zip_name))
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
        print("ok    dev/lint.py selftest (6 gates fire, clean samples pass)")

    for msg in version_pair():
        bad += 1
        print("FAIL  version: " + msg)

    if len(sys.argv) > 1:
        files = [Path(a).resolve() for a in sys.argv[1:]]
    else:
        files = sorted((ROOT / "src" / "architect").rglob("*.lua"))

    exports = module_exports(ROOT / "src" / "architect")
    for f in files:
        name = f.relative_to(ROOT).as_posix() if f.is_relative_to(ROOT) else f.as_posix()
        src = f.read_text(encoding="utf-8")
        try:
            ast.parse(src)
        except Exception as e:
            bad += 1
            # luaparser's SyntaxException carries no position at all -- its whole message is the string
            # "syntax errors: None" -- so this says that out loud instead of looking like the tool had a
            # line number and this script dropped it. The real location comes from a diff of the last
            # edit, or from the server, which does name the line when it refuses to load the mod.
            detail = " | ".join([l.strip() for l in str(e).strip().splitlines() if l.strip()][:4])
            if detail == "syntax errors: None":
                detail = ("unparseable; the parser reports no line number -- start with the last edit")
            print("FAIL  {}: {}".format(name, detail or e.__class__.__name__))
            continue
        found = gates(src, exports)
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
