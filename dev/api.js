// Throwaway query against the installed runtime-api.json — the authoritative 2.0
// reference for "does this field even exist", so the mod stops guessing keys.
const fs = require("fs");
const path = require("path");
const DOC = process.env.FACTORIO_DOC || path.join(__dirname, "..", "doc-html");
const PATH = path.join(DOC, "runtime-api.json");
const j = JSON.parse(fs.readFileSync(PATH, "utf8"));
const s = (v) => (Array.isArray(v) ? v.join("|") : String(v));
const sig = (m) =>
  `  ${m.name}(${(m.parameters || []).map((p) => `${p.name}:${s(p.type)}`).join(", ")}) -> ${s(m.return_type)}`;
const cls = (n) => j.classes.find((c) => c.name === n);

const what = process.argv[2] || "energy";
if (what === "energy") {
  const e = cls("LuaEntityPrototype");
  console.log("=== LuaEntityPrototype energy/stat methods");
  (e.methods || []).filter((m) => /energy|usage|production|speed/i.test(m.name)).forEach((m) => console.log(sig(m)));
  console.log("=== LuaEntity energy/network attributes+methods");
  const en = cls("LuaEntity");
  (en.attributes || []).filter((a) => /electric|energy|network/i.test(a.name)).forEach((a) => console.log(`  attr ${a.name} : ${s(a.read_type)}`));
  (en.methods || []).filter((a) => /electric|energy|network/i.test(a.name)).forEach((m) => console.log(sig(m)));
} else if (what === "day") {
  console.log("=== classes matching day/timing/control");
  console.log(j.classes.filter((c) => /day|timing|control|surface/i.test(c.name)).map((c) => c.name).join(", "));
  for (const n of ["LuaSurface", "LuaGameScript", "LuaController"]) {
    const c = cls(n);
    if (!c) { console.log(n + ": ABSENT"); continue; }
    console.log(`=== ${n}`);
    (c.attributes || []).filter((a) => /day|time|tick|night/i.test(a.name)).forEach((a) => console.log(`  attr ${a.name} : ${s(a.read_type)} (w:${s(a.write_type)}) ${(a.description || "").slice(0, 140).replace(/\s+/g, " ")}`));
    (c.methods || []).filter((a) => /day|time|tick|night/i.test(a.name)).forEach((m) => console.log(sig(m)));
  }
} else {
  const c = cls(what);
  if (!c) { console.log(what + ": ABSENT"); process.exit(0); }
  console.log("=== " + what);
  (c.attributes || []).forEach((a) => console.log(`  attr ${a.name} : ${s(a.read_type)}`));
  (c.methods || []).forEach((m) => console.log(sig(m)));
}
