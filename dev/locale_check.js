// Static gate: every string the panel asks for must exist in every language the mod ships.
//
// A headless run cannot read a window, so nothing else notices when `L("refresh")` has no entry: the
// player sees the literal `architect.refresh` where a button caption should be, and the suite stays
// green because it asserts on keys. This check is the whole reason keys are safe to use here at all.
//
// It reads the keys two ways, because the panel uses both: `L("k")` in gui.lua, and a
// `{"architect.k"}` table anywhere in the mod (the menu placeholders are built that way). A key
// ASSEMBLED at runtime -- `L("column-" .. h)` -- is invisible to both patterns, which is why gui.lua
// spells its column headings out; if this file ever reports "defined but never used" for a key that
// looks used, that is the shape to look for.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src", "architect");
const LOCALES = ["en", "zh-CN"];

const parse = (lang) => {
  const file = path.join(SRC, "locale", lang, "architect.cfg");
  if (!fs.existsSync(file)) return null;
  const keys = new Map();
  let section = null;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) { section = line.slice(1, -1); continue; }
    if (section !== "architect") continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    // Everything after the first `=` is the value, whitespace and all: two of these sentences are
    // indented on purpose (a detail line sits under the answer it belongs to), and a trimmed value
    // would make this file disagree with what the panel actually shows.
    keys.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return keys;
};

const luaFiles = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { if (name !== "locale") walk(full); }
    else if (name.endsWith(".lua")) luaFiles.push(full);
  }
})(SRC);

const used = new Map();   // key -> where
for (const f of luaFiles) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  for (const m of src.matchAll(/\bL\("([a-z0-9-]+)"/g)) {
    if (!used.has(m[1])) used.set(m[1], rel);
  }
  for (const m of src.matchAll(/"architect\.([a-z0-9-]+)"/g)) {
    if (!used.has(m[1])) used.set(m[1], rel);
  }
}

const problems = [];
const tables = {};
for (const lang of LOCALES) {
  const keys = parse(lang);
  if (!keys) { problems.push(`locale/${lang}/architect.cfg is missing`); continue; }
  tables[lang] = keys;
  for (const [k, where] of used) {
    if (!keys.has(k)) problems.push(`${lang}: key "${k}" used in ${where} is not defined`);
    else if (!keys.get(k)) problems.push(`${lang}: key "${k}" has an empty value`);
  }
  for (const k of keys.keys()) {
    if (!used.has(k)) problems.push(`${lang}: key "${k}" is defined but never used`);
  }
}
// Both files the same set of keys: a language missing a row renders that one line in the fallback
// language in the middle of an otherwise translated window, which looks like a bug in the translation.
if (tables.en && tables["zh-CN"]) {
  for (const k of tables.en.keys()) if (!tables["zh-CN"].has(k)) problems.push(`zh-CN is missing "${k}" that en has`);
  for (const k of tables["zh-CN"].keys()) if (!tables.en.has(k)) problems.push(`zh-CN has "${k}" that en lacks`);
}

// `__1__` params: a table call passes its parameters positionally, so a value used in code with
// params must have the placeholder in every language file, or the substituted text is silently
// dropped and the player reads a sentence with a hole in it.
for (const [k, keys_by_lang] of Object.entries(tables)) {
  for (let i = 1; i <= 8; i++) {
    const inEn = (tables.en.get(k) || "").includes(`__${i}__`);
    const inThis = (keys_by_lang.get(k) || "").includes(`__${i}__`);
    if (inEn && !inThis) problems.push(`${k}: en has __${i}__ but ${Object.keys(tables).find(l => tables[l] === keys_by_lang)} does not`);
  }
}

if (problems.length) {
  for (const p of problems) console.log("FAIL  " + p);
  console.log(`${problems.length} locale problem(s)`);
  process.exit(1);
}
console.log(`locale ok (${used.size} keys, ${LOCALES.join(" + ")} complete)`);
