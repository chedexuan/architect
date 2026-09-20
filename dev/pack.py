"""Package src/architect into mods/architect_<version>.zip (Factorio layout: <name>/files).

The server can only push mods to joining clients when they are zips, not loose
directories, so dev iteration goes through this even though only the server runs.
"""
import json, os, subprocess, sys, zipfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, "src", "architect")
mods = os.path.join(root, "mods")

# A Lua syntax error costs a full server restart to discover, so refuse to package past one.
lint = subprocess.run([sys.executable, os.path.join(root, "dev", "lint.py")],
                      capture_output=True, text=True)
if lint.returncode != 0:
    sys.stdout.write(lint.stdout)
    sys.exit("refusing to pack: fix the syntax errors above")

info = json.load(open(os.path.join(src, "info.json"), encoding="utf-8"))
out = os.path.join(mods, f"{info['name']}_{info['version']}.zip")

os.makedirs(mods, exist_ok=True)
for f in os.listdir(mods):
    if f.startswith(info["name"] + "_") and f.endswith(".zip"):
        os.remove(os.path.join(mods, f))

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _, files in os.walk(src):
        for name in files:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, os.path.dirname(src)).replace("\\", "/")
            z.write(full, rel)
print(out)
