// Static gate: every string the panel asks for must exist in every language the mod ships.
//
// A headless run cannot read a window, so nothing else notices when `L("refresh")` has no entry: the
// player sees the literal `architect.refresh` where a button caption should be, and the suite stays
// green because it asserts on keys. This check is the whole reason keys are safe to use here at all.
//
// It reads the keys five ways, because the mod uses five shapes: `L("k")` in gui.lua, a
// `{"architect.k"}` table anywhere in the Lua (the menu placeholders are built that way), the second
// argument of a `fail_key("CODE", "k", ...)` (a refusal's own sentence, which the panel renders while the
// RCON answer keeps the English `msg`), `msg_key = "k"` inside a detail table (the same thing written
// by a method that returns a tuple rather than a failure record), and `said("k", "the English line", ...)`
// in roles.lua -- a sentence built out of other sentences, which the window recomposes from the tokens. A key ASSEMBLED at runtime --
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
  const dupes = [];
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
    const key = line.slice(0, eq).trim();
    // A key written twice is not a later row winning: the game refuses to load the mod at all
    // (`Duplicate key "x" in property tree`), so this is the one mistake in a locale file that costs a
    // restart loop rather than a wrong sentence -- and a bulk edit that re-inserts an anchor line is
    // exactly how it happens.
    if (keys.has(key)) dupes.push(key);
    keys.set(key, line.slice(eq + 1));
  }
  keys.duplicates = dupes;
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
const saidCalls = [];     // {key, en, where} -- a composed sentence and the English beside its key
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
  // ...and the same sentence when the CODE is not a literal: `fail_key(expr or "X", "m-key", ...)` reads
  // nothing to the pattern above, so that refusal's row went unchecked for a whole round and the panel
  // would have printed the key itself. The `m-` prefix is the convention every refusal sentence uses, so
  // this scans the convention rather than the call shape.
  for (const m of src.matchAll(/"(m-[a-z0-9-]+)"/g)) {
    if (!used.has(m[1])) used.set(m[1], rel);
  }
  // ...and the same key written into a detail table by a method that returns a tuple (the solver).
  for (const m of src.matchAll(/\bmsg_key\s*=\s*"([a-z0-9-]+)"/g)) {
    if (!used.has(m[1])) used.set(m[1], rel);
  }
  // ...and any sentence a method answers with an English line beside a key: `next_key`, `why_key`,
  // `claim_how_key`, `note_key` -- the window prefers the key (see `words_for` in gui.lua), so the row
  // has to exist in both files just like a refusal's. One pattern for the family, because the family
  // is the point: a per-field list of names is how the seventh one goes unproven.
  for (const m of src.matchAll(/\b([a-z_]+_key)\s*=\s*[^,\n]*?"([a-z0-9-]+)"/g)) {
    if (!used.has(m[2])) used.set(m[2], rel);
  }
  // ...and a sentence composed out of smaller sentences: `said("rh-best", "best __1__", {...})` in
  // roles.lua. The English is written at the call because the window needs a key and the protocol needs
  // a greppable line, and the pairing below is what stops those two from meaning different things.
  for (const m of src.matchAll(/\bsaid\(\s*"([a-z0-9-]+)",\s*"((?:[^"\\]|\\.)*)"/g)) {
    if (!used.has(m[1])) used.set(m[1], rel);
    saidCalls.push({ key: m[1], en: m[2], where: rel });
  }
}

const problems = [];
const tables = {};
for (const lang of LOCALES) {
  const keys = parse(lang);
  if (!keys) { problems.push(`locale/${lang}/architect.cfg is missing`); continue; }
  for (const k of keys.duplicates || []) {
    problems.push(`${lang}: key "${k}" is written twice -- the game will not load the mod at all`);
  }
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

// `__1__` params: a table call passes its parameters positional, so a value used in code with
// params must have the placeholder in every language file, or the substituted text is silently
// dropped and the player reads a sentence with a hole in it.
//
// ⚠ 这一段的循环以前写的是 `for (const [k, keys_by_lang] of Object.entries(tables))` —— 而 `tables`
// 是 `{en: Map, "zh-CN": Map}`，所以那个 `k` 是**语言名**，`keys_by_lang.get(k)` 查的是"有没有一个键
// 叫 en"，永远 undefined。整段占位符比对因此一条都没跑过（2026-10-14 我想往里加 printf 那条规则时，
// 加了、探针也验不出来，才发现上面那三条本来就是空的）。现在按语言 × 键两层走，规则还是那三条。
for (const lang of Object.keys(tables)) {
  const keys_by_lang = tables[lang];
  for (const k of keys_by_lang.keys()) {
    const here = lang;
    const holes = (value) => {
      const set = new Set();
      for (const m of String(value).matchAll(/__(\d+)__/g)) set.add(Number(m[1]));
      return set;
    };
    const mine = holes(keys_by_lang.get(k) || "");
    const theirs = holes((tables.en || new Map()).get(k) || "");
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
    // printf 那一路（`%d` / `%s`）不是这游戏的语法：引擎只认 `__1__`，`%d` 会**原样印在窗上**。
    // 这一条是 2026-10-14 从 `detail-hidden` 那一句学来的（"还有 %d 句技术细节"，玩家读到的是 `%d`，
    // 而那一句的代码明明传了一个数进去）—— 传参正确、渲染正确、只有文件里的写法是另一种语言的 printf。
    const printf = String(keys_by_lang.get(k) || "").match(/%[sdifxo]\b|%\d*\.\d*[sdif]/);
    if (printf) problems.push(`${k}: ${here} uses printf "${printf[0]}" -- the game never substitutes it, the player reads the literal`);
  }
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

// The same bargain for a COMPOSED sentence. `said("rh-best", "best __1__", ...)` in roles.lua puts a
// token tree into the answer (the window renders it, in the reader's language, at any depth) and the
// flat English line into `how` (what RCON carries and a designer greps). The two are the same sentence
// written by the same call, so this compares them: a reword that only reaches the locale file, or only
// the Lua, fails the build rather than surfacing as a window that disagrees with the protocol.
for (const call of saidCalls) {
  const row = tables.en && tables.en.get(call.key);
  if (row === undefined) { problems.push(`${call.key}: named by said() in ${call.where} but en has no row`); continue; }
  if (row !== call.en) {
    problems.push(`${call.key}: en row is not the sentence said() passes in ${call.where}\n        said: ${call.en}\n        en : ${row}`);
  }
}

// One more place the SAME sentence lives, with its key a field away: a row of a table, which is how
// measure.lua lists the rigs that share the world clock. Writing `msg_key = "k"` and `msg = "…"` in one
// row means a reword that reaches only one of the two halves shows up here instead of surfacing as a
// protocol that disagrees with the window. The walk between them stops at `}` and `;` so it cannot reach
// past the row (or the call) it started in, and it is allowed to cross a line break because a long
// English sentence wraps.
for (const f of luaFiles) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  for (const m of src.matchAll(/\bmsg_key\s*=\s*"([a-z0-9-]+)"[^;}]*?\bmsg\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
    const [, key, msg] = m;
    const row = tables.en && tables.en.get(key);
    if (row === undefined) { problems.push(`${key}: named by msg_key in ${rel} but en has no row`); continue; }
    if (row !== msg) {
      problems.push(`${key}: en row is not the sentence beside msg_key in ${rel}\n        lua: ${msg}\n        en : ${row}`);
    }
  }
}

  // 这条是补自己那个声明过的盲区：本文件认五种写法，而**运行时拼出来的键名**（`L("x" .. h)`、
  // `{"architect." .. k}`）五种都看不见 —— 于是一句话少一个语言、或干脆打出一个键名，门还是绿的。
  // gui.lua 里"列名先写成字面量"那条约定从前只靠人记（AGENTS 还专门写了一句"这条没强制"），
  // 现在强制：谁再拼，就在这里红，而不是等玩家在窗口里读到一个 `architect.column-xxx`。
  const RUNTIME_KEY = [
    [/(?:^|[^A-Za-z_.])L\s*\(\s*"[^"]*"\s*\.\./g, 'L("..." .. 拼键名'],
    [/\{\s*"architect\."\s*\.\./g, '拼出一个 {"architect." .. 本地化表}'],
    [/\bL\s*\(\s*"(?:[a-z0-9-]+)"\s*\.\./g, 'L 的第一个参数是拼出来的'],
  ];
  let exemptSites = 0;
  for (const f of luaFiles) {
    const rel = path.relative(ROOT, f);
    const body = fs.readFileSync(f, "utf8").split("\n");
    // 唯一的豁免：`L` 自己的那一段（它就是把 "architect." 与传进来的键名接成表 —— 那条约定本体）。
    // 豁免写成**行号范围**而不是"跳过这一条正则"，并且下面会数出来：一处之外的每一处都算违例，
    // 而"豁免了几处"是要能在绿灯里看见的数，不是埋在代码里的一句话。
    let lo = -1, hi = -1;
    for (let n = 0; n < body.length; n++) {
      if (/^local function L\s*\(\s*key/.test(body[n])) lo = n;
      if (lo >= 0 && n > lo && body[n] === "end") { hi = n; break; }
    }
    body.forEach((line, n) => {
      if (lo >= 0 && hi > lo && n >= lo && n <= hi) { exemptSites++; return; }
      const code = line.replace(/--.*$/, "");
      for (const [re, label] of RUNTIME_KEY) {
        re.lastIndex = 0;
        if (re.test(code)) {
          problems.push(`${rel}:${n + 1} 把本地化键**拼**出来了（${label}）：locale_check 看不见这种键，`
            + `少哪个语言没人知道。要么在这里写成字面量，要么给这一族加一张"值 → 键"的表`);
        }
      }
    });
  }


if (problems.length) {
  for (const p of problems) console.log("FAIL  " + p);
  console.log(`${problems.length} locale problem(s)`);
  process.exit(1);
}

console.log(`locale ok (${used.size} keys, ${LOCALES.join(" + ")} complete；`
  + `运行时拼键名那一族扫了 ${luaFiles.length} 个文件，豁免 ${exemptSites} 行 = L 自己的定义)`);
