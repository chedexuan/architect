// Static gate: every string the panel asks for must exist in every language the mod ships.
//
// A headless run cannot read a window, so nothing else notices when `L("refresh")` has no entry: the
// player sees the literal `architect.refresh` where a button caption should be, and the suite stays
// green because it asserts on keys. This check is the whole reason keys are safe to use here at all.
//
// It reads the keys four ways, because the mod uses four shapes: `L("k")` in gui.lua, a
// `{"architect.k"}` table anywhere in the Lua (the menu placeholders are built that way), the second
// argument of a `fail_key("CODE", "k", ...)` (a refusal's own sentence, which the panel renders while the
// RCON answer keeps the English `msg`), and `msg_key = "k"` inside a detail table (the same thing written
// by a method that returns a tuple rather than a failure record). A key ASSEMBLED at runtime --
// `L("column-" .. h)` -- is invisible to all four, which is why gui.lua spells its column headings out;
// if this file ever reports "defined but never used" for a key that looks used, that is the shape to look
// for.
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
  // A refusal's sentence: `fail_key("CODE", "m-where", params, "the English line", detail)`.
  for (const m of src.matchAll(/\bfail_key\(\s*"[A-Z0-9_]+",\s*"([a-z0-9-]+)"/g)) {
    if (!used.has(m[1])) used.set(m[1], rel);
  }
  // ...and the same key written into a detail table by a method that returns a tuple (the solver).
  for (const m of src.matchAll(/\bmsg_key\s*=\s*"([a-z0-9-]+)"/g)) {
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
  const here = Object.keys(tables).find((l) => tables[l] === keys_by_lang) || "?";
  const holes = (value) => {
    const set = new Set();
    for (const m of String(value).matchAll(/__(\d+)__/g)) set.add(Number(m[1]));
    return set;
  };
  const mine = holes(keys_by_lang.get(k) || "");
  const theirs = holes(tables.en.get(k) || "");
  // One rule in both directions: the code passes a fixed positional list to one key, so a placeholder
  // that exists in only one language means that language reads either a hole (`__3__` on screen) or a
  // value the other language never sees. Both files carry the same sentence, in whatever word order
  // the language wants -- the SET of slots is the part that has to agree.
  for (const n of theirs) if (!mine.has(n)) problems.push(`${k}: en has __${n}__ but ${here} does not`);
  for (const n of mine) if (!theirs.has(n)) problems.push(`${k}: ${here} has __${n}__ but en does not`);
  // `__1____2__` is not two slots: the game's own reader stops at the first `_` that is not a digit and
  // the player sees an underscore-prefixed fragment where the second value should be. Two slots need a
  // space, a comma or a word between them.
  const adj = String(keys_by_lang.get(k) || "").match(/__\d+____\d+__/);
  if (adj) problems.push(`${k}: ${here} has two placeholders touching (${adj[0]}) -- the game will not substitute the second`);
}

// The sentence behind a refusal key has to BE the sentence the code wrote.
//
// `fail_key(CODE, key, nil, "the English line")` puts the same sentence in two places at once: the `msg`
// the protocol prints, and the `en` row the window renders when no other language answers. Nothing else
// in the build notices when one is reworded and the other is not -- the panel would quietly show a
// different claim from the RCON answer, which is the exact class of wrong this whole file exists to stop.
// Only the single-line, no-params form is checked here; a key with parameters takes its words from a Lua
// expression, and that pairing is proven at runtime instead (smoke.js compares the rendered head line with
// the `msg` of a live refusal).
if (tables.en) {
  for (const f of luaFiles) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(ROOT, f);
    for (const m of src.matchAll(/\bfail_key\(\s*"([A-Z0-9_]+)",\s*"([a-z0-9-]+)",\s*nil,\s*"((?:[^"\\]|\\.)*)"/g)) {
      const [, code, key] = m;
      // The sentence may be written as `"a" .. "b"` across two lines, and the gate has to compare the
      // WHOLE of it: matching only the first fragment would fail every wrapped line (and the tempting
      // "fix" for that is to delete the check, which is how a gate dies).
      let msg = m[3];
      let at = m.index + m[0].length;
      for (;;) {
        const rest = /^\s*\.\.\s*"/.exec(src.slice(at));
        if (!rest) break;
        const start = at + rest[0].length - 1;
        const piece = /^"((?:[^"\\]|\\.)*)"/.exec(src.slice(start));
        if (!piece) { msg = null; break; }
        msg += piece[1];
        at = start + piece[0].length;
      }
      if (msg === null) { problems.push(`${key}: fail_key(${code}) in ${rel} has a sentence the gate cannot read`); continue; }
      const row = tables.en.get(key);
      if (row === undefined) { problems.push(`${key}: named by fail_key(${code}) in ${rel} but en has no row`); continue; }
      if (row !== msg) {
        problems.push(`${key}: en row is not the sentence fail_key(${code}) passes in ${rel}\n        msg: ${msg}\n        en : ${row}`);
      }
    }
  }
}

if (problems.length) {
  for (const p of problems) console.log("FAIL  " + p);
  console.log(`${problems.length} locale problem(s)`);
  process.exit(1);
}
console.log(`locale ok (${used.size} keys, ${LOCALES.join(" + ")} complete)`);
