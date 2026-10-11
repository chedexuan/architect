#!/usr/bin/env python
"""Every Lua template in `dev/*.js` has to parse.

The trap this closes is measured and repeated in three probe headers: a `/c` that fails to COMPILE
answers with NOTHING AT ALL. So a broken query in a dev script does not look red -- it looks like an
empty reading, and the next person spends the afternoon suspecting the game. One real case: a lane-read
query grew four more fields and lost the parenthesis that closed `rcon.print(`, and the probe reported
`MACHINE_STATE=""` while the line it was checking kept passing and failing on the same evidence.

The templates are extracted from the JS by hand (backtick-delimited, `${expr}` replaced with a number),
because the JS is the source of truth for what the game receives.
"""
import re
import sys
from pathlib import Path

if sys.version_info < (3, 9):
    sys.exit(f"dev/lua_templates.py needs python 3.9+, this is {sys.version.split()[0]}")
try:
    from luaparser import ast
except ImportError:
    sys.exit("pip install luaparser")

DEV = Path(__file__).resolve().parent
# The harness composes Lua out of fragments (`lua.js` wraps a query in a pcall, `p.js` prints it), so a
# backtick string inside those files is not a query and never will be. Same for the JS-side helpers that
# only build command lines.
SKIP_FILES = {"lua.js", "p.js", "call.js", "lines.js", "suite-guard.js", "api_query.js", "gui_api_check.js",
              "locale_check.js", "bench_check.js"}
# A template is Lua-shaped when it prints through rcon or opens with a Lua keyword. Anything else
# (`${...}` JS strings, log formats) is not this gate's business.
TEMPLATE = re.compile(r"`((?:[^`\\]|\\.)*)`", re.S)
LUAISH = re.compile(r"^\s*(local\s|for\s|if\s|while\s|function\s|rcon\.print|game\.|s\.)", re.M)
SUBST = re.compile(r"\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}")
# A fragment of a larger statement (the harness's own building blocks) is not a query: it cannot parse
# on its own and nobody would ask it to.
FRAGMENT = re.compile(r"^\s*(end|else|elseif|until|\}|\)|,|\+|\.\.)[^\n]*$")


def lua_name(text):
    """A label for a template: its first line, which is usually `local s = game.surfaces[...]`."""
    for line in text.split("\n"):
        if line.strip():
            return line.strip()[:64]
    return "(empty)"


def strip_comments(src):
    """Blank out comment lines, keeping every character position.

    This repo writes its prose with backticks in it (`game.speed`, `card_lab`), and a template that
    spans two comment lines is not a query. Newlines are preserved so the reported line numbers stay
    the ones a person reads in the file.
    """
    out = []
    in_block = False
    for line in src.split("\n"):
        stripped = line.strip()
        if in_block:
            if "*/" in stripped:
                in_block = False
            out.append("")
            continue
        if stripped.startswith("//") or stripped.startswith("/*"):
            in_block = stripped.startswith("/*") and "*/" not in stripped
            out.append("")
            continue
        out.append(line)
    return "\n".join(out)


def main():
    bad, checked = [], 0
    for js in sorted(DEV.glob("*.js")):
        if js.name in SKIP_FILES:
            continue
        src = strip_comments(js.read_text(encoding="utf8"))
        # 反引号是 JS 模板串的**边界**，所以它不可能出现在一段 Lua 注释里而不弄坏整条命令：写着强调的
        # 那两个反引号会在这里把模板截断，游戏收到的是半条语句，而半条语句**不回话**（这个文件头上写的
        # 就是这件事）。这一格先把这种写法点名报出来 —— 否则报错的是"line 1:1 token recognition error
        # at: '交'"，看着像 Lua 坏了，其实是 markdown 强调吃掉了边界。
        for i, line in enumerate(src.split("\n"), 1):
            if re.match(r"^\s*--", line) and "`" in line:
                bad.append("%s:%d  这段 Lua 注释里有反引号，它会截断 JS 模板串（强调用 ** 就够了）\n    %s"
                           % (js.name, i, line.strip()[:120]))
        for m in TEMPLATE.finditer(src):
            body = m.group(1)
            if "rcon.print" not in body and not LUAISH.search(body):
                continue
            first = next((l for l in body.split("\n") if l.strip()), "")
            if FRAGMENT.match(first):
                continue
            # `${...}` becomes a number so the Lua that reaches the parser has the same SHAPE as the
            # Lua the game receives. A template whose hole happens to close a parenthesis is exactly
            # the bug this gate is for, so the substitution must not paper over it.
            lua = SUBST.sub("7300", body).replace("\\n", "\n").replace('\\"', '"').replace("\\`", "`")
            checked += 1
            try:
                ast.parse(lua)
            except Exception as e:  # noqa: BLE001 - any parse failure is the answer
                line = src[:m.start()].count("\n") + 1
                bad.append("%s:%d  %s\n    %s" % (js.name, line, str(e).split("\n")[0][:150],
                                                  lua_name(lua)))
    for b in bad:
        print("FAIL  " + b)
    if bad:
        print("%d/%d Lua template(s) do not parse" % (len(bad), checked))
        return 1
    print("ok    %d Lua template(s) in dev/*.js parse" % checked)
    return 0


if __name__ == "__main__":
    sys.exit(main())
