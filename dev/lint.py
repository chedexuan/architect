#!/usr/bin/env python
"""Offline Lua syntax check for src/architect.

Catches the class of mistake that costs a 25s server restart to discover
(reserved words as keys, missing 'end', Lua-isms Factorio's Lua rejects).
Run before pack.py.
"""
import sys
from pathlib import Path

try:
    from luaparser import ast
except ImportError:
    sys.exit("pip install luaparser")

ROOT = Path(__file__).resolve().parent.parent
FILES = sorted((ROOT / "src" / "architect").rglob("*.lua"))

bad = 0
for f in FILES:
    src = f.read_text(encoding="utf-8")
    try:
        ast.parse(src)
        print(f"ok    {f.relative_to(ROOT)}")
    except Exception as e:
        bad += 1
        first = str(e).strip().splitlines()[0]
        print(f"FAIL  {f.relative_to(ROOT)}: {first}")

sys.exit(1 if bad else 0)
