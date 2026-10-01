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

# The gate itself is 3.9+ (Path.is_relative_to below) and luaparser's wheel is too. On this box
# `python3` is 3.6 and `pip install luaparser` succeeds there and then dies on import -- so say
# which interpreter to use before either failure can be read as "the mod is broken".
if sys.version_info < (3, 9):
    sys.exit(f"dev/lint.py needs python 3.9+, this is {sys.version.split()[0]} -- try: python3.11 dev/lint.py")

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
# Factorio's deterministic-lockstep rule: every process must reach the same world from the same
# actions. Anything that DRIVES the player's own input -- clipboard, paste, selection -- is an
# interaction, and an interaction has a mouse on the client and nothing on a headless server, so the
# two sides branch apart. Measured, not theorised: 2026-10-01, `desync-report-2026-10-01_16-21-49`,
# where pressing 拿到手上 desynced a real client at the click tick with `script.dat` BYTE-IDENTICAL
# (the plan and our storage agreed perfectly) and the client's `next-unit-number` one ahead of the
# server's -- the client's paste machinery had made a unit the server never could.
INTERACTION = re.compile(r"\b(activate_paste|add_to_clipboard)\s*\(")

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

# What makes a JS template literal a Lua one, for the comment gate below. Three markers are enough --
# a probe's Lua always prints through `rcon.print`, declares with `local`, and branches with `then`.
LUA_MARK = re.compile(r"\brcon\.print|\blocal\s+\w|\bthen\b")

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
        im = INTERACTION.search(code)
        if im:
            problems.append((i, "`%s` drives the player's own input, which only exists on a client: "
                                "server and client branch apart and the game desyncs at that tick. "
                                "Write world state instead (cursor_stack.set_stack / player.insert)"
                                % im.group(1)))
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

local function carry(p, inv)
  p.add_to_clipboard(inv[1])
  p:activate_paste()
end
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
            "is registered again here", "drives the player")
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
    js_bad = js_lua_comment_lines(SAMPLE_JS_COMMENT_IN_LUA)
    if js_bad != [4]:
        problems.append("the '//'-inside-Lua gate answered %r on a file that has one at line 4" % js_bad)
    if js_lua_comment_lines(SAMPLE_JS_COMMENT_CLEAN):
        problems.append("the '//'-inside-Lua gate fired on JS comments that are in JS")
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


SAMPLE_JS_COMMENT_IN_LUA = '''
const HEAD = `
local s = game.surfaces["x"]
// written the JS way, and Lua refuses it
rcon.print("ok")
`;
'''

SAMPLE_JS_COMMENT_CLEAN = '''
const sleep = (ms) => exec(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
// a JS comment outside any literal
const T = `
local ok = true
-- a Lua comment, written right
rcon.print(tostring(ok))
`;
'''


def js_lua_comment_lines(text):
    """Line numbers of JS-style `//` comments sitting inside a template literal that is Lua.

    The mirror of the two characters above: a Lua template literal written with `--` comments is fine,
    and one written with `//` is a Lua syntax error the engine refuses with silence.

    A real JS parse is not available offline and a walk over backticks is worse than useless here --
    these files write `code spans` in their prose comments by the hundred and one regex literal in
    smoke.js holds three of them, any of which flips every later boundary. So the boundary is taken
    from the shape these snippets are always written in: the opening backtick ends its line, and the
    literal cannot outlive the next backtick anywhere, because that character closes it. Which literal
    is Lua cannot be read off the file, so the body has to look like it -- `local`, `rcon.print`, a
    `then` -- before a comment in it is called wrong, which keeps the gate off the JS templates that
    legitimately hold code.
    """
    lines = text.splitlines()
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        opened = line.rstrip().endswith("`") and line.count("`") % 2 == 1
        if not opened:
            i += 1
            continue
        body, j = [], i + 1
        while j < len(lines) and "`" not in lines[j]:
            body.append(lines[j])
            j += 1
        if LUA_MARK.search("\n".join(body)):
            for k, ln in enumerate(body):
                if ln.lstrip().startswith("//"):
                    out.append(i + k + 2)          # 1-based, and the opener line is not part of the body
        i = j + 1
    return out


def js_embedded_lua_problems(root, bad):
    """Dev scripts hold Lua inside JS template literals, and three characters silently wreck that.

    A backtick ends the template, so the rest of the "Lua" becomes JS -- which is often still valid JS
    (an expression referencing an undefined name), so `node --check` passes and the script dies at
    runtime instead. A backslash-quote is eaten by JS on the way in, so the Lua arrives with a string
    terminated early. A `//` comment is Lua's `unexpected symbol near '/'`. All three reach the engine
    as a console command it refuses -- and Factorio answers a parse error with SILENCE, which reads as
    "the server is down" and costs a restart's worth of debugging before the log is opened.
    """
    found = 0
    for f in sorted((root / "dev").glob("*.js")):
        text = f.read_text(encoding="utf-8")
        for num, line in enumerate(text.splitlines(), 1):
            if not line.lstrip().startswith("--"):
                continue
            if "`" in line:
                bad += 1
                found += 1
                print("FAIL  dev/{}:{}: a backtick in a Lua comment inside a JS template literal ends "
                      "the literal -- write 'this' instead of `this`".format(f.name, num))
            if '\\"' in line:
                bad += 1
                found += 1
                print("FAIL  dev/{}:{}: JS eats this escape before Lua sees it, which arrives as a "
                      "string terminated early -- and Factorio reports a console parse error as "
                      "silence".format(f.name, num))
        for num in js_lua_comment_lines(text):
            bad += 1
            found += 1
            print("FAIL  dev/{}:{}: '//' is not a Lua comment -- the engine refuses the whole console "
                  "command with 'unexpected symbol' and answers nothing, so the probe reports the "
                  "server as down. Write '--'".format(f.name, num))
    return found


def main():
    bad = 0
    problems = selftest()
    if problems:
        bad += 1
        print("FAIL  dev/lint.py selftest")
        for msg in problems:
            print("      " + msg)
    else:
        print("ok    dev/lint.py selftest (7 gates fire, clean samples pass)")

    for msg in version_pair():
        bad += 1
        print("FAIL  version: " + msg)

    if len(sys.argv) > 1:
        files = [Path(a).resolve() for a in sys.argv[1:]]
    else:
        files = sorted((ROOT / "src" / "architect").rglob("*.lua"))

    exports = module_exports(ROOT / "src" / "architect")
    bad += js_embedded_lua_problems(ROOT, bad)
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
