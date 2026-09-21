// Query the installed Factorio API docs instead of guessing names.
//
// Every one of this project's expensive mistakes this week had the same shape: a field or method was
// guessed at from 1.1 memory, the guess raised, and the raise got recorded as "the engine cannot answer
// this". `fluidbox`, `set_recipe`, `add_command`, `control_behavior` -- all of them. So this is the
// alternative: a tiny CLI over the authoritative local machine-readable docs, used before any probe.
//
//   node dev/api_query.js entity              # methods/attributes of LuaEntity
//   node dev/api_query.js match connect       # anything named *connect*, anywhere
//   node dev/api_query.js class LuaFluidBox    # one class in full
//   node dev/api_query.js proto FluidBox       # data-stage type and its properties
//   node dev/api_query.js defines signal       # define tables matching a word
//   node dev/api_query.js search circuit_set_recipe   # full-text over descriptions
//
// Output is meant to be pasted into a probe, not remembered.
const fs = require("fs");
const path = require("path");

const DOC = process.env.FACTORIO_DOC || "C:/Program Files (x86)/Steam/steamapps/common/Factorio/doc-html";
const runtime = JSON.parse(fs.readFileSync(path.join(DOC, "runtime-api.json"), "utf8"));
const prototype = JSON.parse(fs.readFileSync(path.join(DOC, "prototype-api.json"), "utf8"));

const typeName = (t) => {
  if (typeof t === "string") return t;
  if (!t || typeof t !== "object") return "?";
  if (t.type_name) return t.type_name;
  if (t.complex_type === "array") return typeName(t.value) + "[]";
  if (t.complex_type === "dictionary") return "dict<" + typeName(t.key) + "," + typeName(t.value) + ">";
  if (t.complex_type === "union") return "(" + (t.options || []).map(typeName).join(" | ") + ")";
  if (t.complex_type) return t.complex_type;
  return "?";
};
const sig = (m) => {
  // The doc's parameter array is NOT in call order: several entries this week (`add_command`,
  // `connect_to`, `get_wire_connector`, `set_slot`) list the parameters one way and the `order`
  // field says another, and the `order` field is what the engine checks. Sort by it, and say when
  // the two disagree so nobody reads the list order as truth again.
  const listed = m.parameters || [];
  const byOrder = listed.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const mismatch = listed.some((p, i) => (p.order ?? i) !== i);
  return m.name + "(" + byOrder.map((p) => p.name + ": " + typeName(p.type)).join(", ") + ")"
    + (mismatch ? "   [!! listed order != call order; call order is shown]" : "");
};
const clip = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n || 160);

const kind = process.argv[2];
const arg = process.argv[3];
const out = [];

if (kind === "entity" || (kind === "class" && arg)) {
  const name = kind === "entity" ? "LuaEntity" : arg;
  const c = (runtime.classes || []).find((x) => x.name === name);
  if (!c) console.log("no class " + name);
  else {
    console.log("== " + c.name + (c.parent ? " : " + c.parent : "") + "\n   " + clip(c.description, 400));
    console.log("\n-- attributes\n" + (c.attributes || []).map((a) => "   " + a.name + " : " + typeName(a.read_type)
      + (a.write_type ? " (write: " + typeName(a.write_type) + ")" : " (read only)")
      + "\n      " + clip(a.description, 220)).join("\n"));
    console.log("\n-- methods\n" + (c.methods || []).map((m) => "   " + sig(m) + (m.return_type ? " -> " + typeName(m.return_type) : "")
      + "\n      " + clip(m.description, 220)).join("\n"));
  }
} else if (kind === "match") {
  const re = new RegExp(arg, "i");
  for (const c of runtime.classes || []) {
    const attrs = (c.attributes || []).filter((a) => re.test(a.name));
    const meths = (c.methods || []).filter((m) => re.test(m.name));
    if (attrs.length || meths.length) {
      console.log("== " + c.name);
      for (const a of attrs) console.log("   attr " + a.name + " : " + typeName(a.read_type)
        + (a.write_type ? " writable" : "") + " :: " + clip(a.description, 150));
      for (const m of meths) console.log("   meth " + sig(m) + " :: " + clip(m.description, 150));
    }
  }
} else if (kind === "proto") {
  const t = (prototype.types || []).find((x) => x.name === arg);
  if (!t) console.log("no data type " + arg + "  (close: " + (prototype.types || [])
    .filter((x) => new RegExp(arg.replace(/^Lua/, ""), "i").test(x.name)).map((x) => x.name).slice(0, 12).join(", ") + ")");
  else {
    console.log("== " + t.name + (t.parent ? " : " + t.parent : "") + "  :: " + clip(t.description, 260));
    const props = t.properties || {};
    const list = Array.isArray(props) ? props.map((p) => [p.name, p]) : Object.entries(props);
    for (const [k, v] of list) {
      const o = v && typeof v === "object" ? v : {};
      console.log("   " + (k || o.name) + " : " + typeName(o.type_name ? { type_name: o.type_name } : o.type)
        + (o.required ? " [required]" : "") + (o.default ? " (default " + JSON.stringify(o.default) + ")" : "")
        + " :: " + clip(o.description, 160));
    }
  }
} else if (kind === "protos") {
  const re = new RegExp(arg, "i");
  for (const t of prototype.types || []) if (re.test(t.name)) console.log("   " + t.name + (t.parent ? " : " + t.parent : ""));
} else if (kind === "defines") {
  const re = new RegExp(arg, "i");
  for (const d of runtime.defines || []) if (re.test(d.name)) {
    console.log("== defines." + d.name + "  (" + (d.values || []).length + ")");
    console.log("   " + (d.values || []).map((v) => v.name).join(" "));
  }
} else if (kind === "search") {
  const re = new RegExp(arg, "i");
  for (const c of runtime.classes || []) {
    for (const m of c.methods || []) if (re.test(String(m.description))) console.log("meth " + c.name + "." + m.name + " :: " + clip(m.description, 240));
    for (const a of c.attributes || []) if (re.test(String(a.description))) console.log("attr " + c.name + "." + a.name + " :: " + clip(a.description, 240));
  }
  for (const t of prototype.types || []) for (const [k, v] of Object.entries(t.properties || {})) {
    if (re.test(String((v || {}).description))) console.log("data " + t.name + "." + k + " :: " + clip(v && v.description, 200));
  }
} else if (kind === "globals") {
  for (const g of runtime.global_objects || []) console.log("   " + g.name + " : " + typeName(g.type));
  for (const g of runtime.global_functions || []) console.log("   fn " + g.name + "(" + (g.parameters || []).map((p) => p.name).join(",") + ")");
} else {
  console.log("usage: node dev/api_query.js <entity|class X|match RE|proto Name|protos RE|defines RE|search RE|globals>");
}
