// Static gate: every GUI key the mod writes must exist in the installed 2.0 API.
//
// A headless server cannot build a widget, so "does the engine accept this spec" is
// untestable without a client. What IS testable is whether the name exists at all in the
// authoritative local API -- which is how `element.style.horizontally_stretch` (a 1.1 idiom,
// absent from 2.0's docs entirely) got caught before anyone opened the window.
//
// Runs in dev/cycle.sh: a rebuild fails on an unknown GUI key instead of a player finding it.
const fs = require("fs");
const path = require("path");

const API = "C:/Program Files (x86)/Steam/steamapps/common/Factorio/doc-html/runtime-api.json";
const j = JSON.parse(fs.readFileSync(API, "utf8"));
const cls = (n) => j.classes.find((c) => c.name === n);
const gui = cls("LuaGuiElement");
const attrs = new Set((gui.attributes || []).map((a) => a.name));
const methods = new Set((gui.methods || []).map((m) => m.name));
const addParams = new Set(((gui.methods.find((m) => m.name === "add") || {}).parameters || []).map((p) => p.name));

// `add{...}` accepts the generic params plus any writable attribute (the engine applies the
// table as attribute writes after constructing by `type`), and `name` is always fine.
const legal = new Set([...addParams, ...attrs, ...methods, "children", "parent", "type"]);
// attributes the mod sets on the element itself: must be writable attributes in the docs
const writable = new Set((gui.attributes || [])
  .filter((a) => a.write_type && !(Array.isArray(a.write_type) && a.write_type.length === 0))
  .map((a) => a.name));

const file = path.join(__dirname, "..", "src", "architect", "gui.lua");
const src = fs.readFileSync(file, "utf8");

const problems = [];
const addBlocks = src.match(/\badd\s*\{([^}]*)\}/g) || [];
for (const block of addBlocks) {
  const body = block.slice(block.indexOf("{") + 1, -1);
  for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
    const key = m[1];
    if (key === "return" || key === "true" || key === "false") continue;
    if (!legal.has(key) && !writable.has(key)) {
      problems.push(`add{} key "${key}" is not in the 2.0 LuaGuiElement API`);
    }
  }
}
// The one GUI idiom that changed in 2.0 and is still in everybody's muscle memory: in 1.1
// `element.style.<attr> = true` tweaked per-element styling; in 2.0 `element.style` is the
// style *name* (a string), so any dotted access through it is wrong. A regex over Lua cannot
// tell an element attribute write from `player.gui` or `model.title`, so rather than guess at
// variables this checks the one family that is always a bug.
for (const m of src.matchAll(/\.\s*style\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
  problems.push(`"${m[1]}" set via element.style.<attr>: 2.0 exposes style as a string name, `
    + `not a table (1.1 idiom)`);
}

const seen = new Set();
const uniq = problems.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
if (uniq.length) {
  console.error("gui API check FAILED:\n  " + uniq.join("\n  "));
  process.exit(1);
}
console.log(`gui API ok (${addBlocks.length} add{} sites, ${attrs.size} documented attributes)`);
