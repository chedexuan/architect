// Read a panel line the way the player's client would.
//
// The window no longer holds English sentences: it holds `{"architect.rate", "18.75", ...}` and the
// client turns that into words in whoever's language. A headless run sees the same table flattened to
// `architect.rate|18.75|item-name.iron-plate`, which is provable but not readable -- so this file
// substitutes the mod's OWN `en` table back in, and a suite can keep asserting on the sentence a
// player sees (`18.75/min iron-plate`) while the Lua keeps nothing but keys.
//
// Two things follow from that, and both are the point:
//   * a key with no row in `locale/en/architect.cfg` THROWS here rather than passing with the raw key
//     in the middle of the text. `dev/locale_check.js` catches a missing row statically; this catches a
//     line the code assembled at runtime that check could not see.
//   * the English file is load-bearing for the tests. Reword a value there and the assertion that
//     quotes it fails, which is the same coupling the code used to have -- with the difference that
//     `zh-CN` can be reworded as the language needs, as long as it keeps the same placeholders, which
//     is the half `dev/locale_check.js` holds it to.
//
// A name the game owns (`item-name.iron-plate`) comes back as the prototype id (`iron-plate`): the
// suite has always compared ids, and ids are what the RCON answer carries. What the client really
// shows for that name -- 铁板 -- is not something a headless run can see either way.
const fs = require("fs");
const path = require("path");

const CFG = path.join(__dirname, "..", "src", "architect", "locale", "en", "architect.cfg");

const EN = new Map();
{
  let section = null;
  for (const raw of fs.readFileSync(CFG, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/[\r\uFEFF]+$/g, "");
    if (!line.trim() || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) { section = line.slice(1, -1); continue; }
    if (section !== "architect") continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    EN.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
}

// Which locale sections `localised_name` is known to answer from on this install. A token whose
// section is not listed here is treated as a literal, which is the safe direction: it still renders,
// and a suite that expected the id fails loudly enough to come and add the section.
const GAME_SECTIONS = new Set([
  "item-name", "fluid-name", "entity-name", "recipe-name", "technology-name", "tile-name",
  "surface-name", "space-location-name", "surface-property-name", "equipment-name", "module-name",
  "ammo-name", "armor-name", "gui", "prototypes", "status", "style", "shortcut", "controller",
  "mod-name",
]);

const gameKey = (tok) => {
  const dot = tok.indexOf(".");
  if (dot < 1) return null;
  return GAME_SECTIONS.has(tok.slice(0, dot)) ? tok.slice(dot + 1) : null;
};

const arityOf = (value) => {
  let n = 0;
  for (const m of value.matchAll(/__(\d+)__/g)) n = Math.max(n, Number(m[1]));
  return n;
};

// One element of a flattened line: a key with its parameters after it, a concatenation list folded
// between `~`, or a literal that came out of a number or a message.
const parse = (toks, i, whole) => {
  const tok = toks[i];
  if (tok === "~") {
    const parts = [];
    i += 1;
    while (i < toks.length && toks[i] !== "~") {
      const [v, next] = parse(toks, i, whole);
      parts.push(v);
      i = next;
    }
    if (toks[i] !== "~") throw new Error(`unbalanced concatenation in: ${whole}`);
    return [parts.join(""), i + 1];
  }
  // The widget holds `architect.rate`; the file defines `rate` under its `[architect]` header.
  const bare = tok.startsWith("architect.") ? tok.slice("architect.".length) : tok;
  if (EN.has(bare)) {
    const value = EN.get(bare);
    const arity = arityOf(value);
    const params = [];
    i += 1;
    for (let p = 0; p < arity; p++) {
      const [v, next] = parse(toks, i, whole);
      params.push(v);
      i = next;
    }
    return [value.replace(/__(\d+)__/g, (_, d) => params[Number(d) - 1] ?? ""), i];
  }
  if (tok.startsWith("architect.")) {
    throw new Error(`no en value for "${tok}" in line: ${whole}`);
  }
  const id = gameKey(tok);
  if (id !== null) return [id, i + 1];
  return [tok, i + 1];
};

// `en("architect.rate|18.75|item-name.iron-plate")` -> `18.75/min iron-plate`
const en = (line) => {
  if (line === null || line === undefined) return "";
  const text = typeof line === "string" ? line : JSON.stringify(line);
  const toks = text.split("|");
  const [out, next] = parse(toks, 0, text);
  if (next !== toks.length) {
    // trailing tokens means a parameter went somewhere the sentence did not ask for it: a placeholder
    // is missing from the file, which is exactly the silent hole `locale_check` exists to stop.
    throw new Error(`line has ${toks.length - next} token(s) left over after the sentence: ${text}`);
  }
  return out;
};

// True for the text of a caption this file can be strict about: it starts as a key, or as a
// concatenation list. Anything else -- a message the method wrote, a tree dump, a name a click echoed
// back -- has no sentence to substitute and is returned as it came.
const structured = (toks) => toks[0] === "~"
  || EN.has(toks[0].replace(/^architect\./, "")) || toks[0].startsWith("architect.");

// One line as the self-test dumps it, which is `widget-name=caption` for a label that has a name and
// `=caption` for one that does not. Only a name is stripped: a flattened key always has a `.` in it, so
// a caption whose own text contains `=` (a message saying `pole=x`) is left alone.
const enLine = (raw) => {
  const text = String(raw === null || raw === undefined ? "" : raw);
  const eq = text.indexOf("=");
  const named = eq >= 0 && /^[a-z0-9_-]*$/.test(text.slice(0, eq));
  const head = named ? text.slice(0, eq + 1) : "";
  const body = named ? text.slice(eq + 1) : text;
  if (!structured(body.split("|"))) return text;
  return head + en(body);
};

// The same, for a value that never went through a widget: `gui_model` answers the card row's label as
// the table it is, so JSON brings back a nested array. Flattening it here is the mirror of `gui.flat`,
// which is what lets a suite read the sentence rather than the shape.
const flattenValue = (v) => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) {
    const parts = v.map(flattenValue);
    // the same rule `gui.flat` uses: a list headed by `""` is a concatenation, and it says so
    if (parts[0] === "") return "~|" + parts.slice(1).join("|") + "|~";
    return parts.join("|");
  }
  return String(v);
};
const enValue = (v) => en(flattenValue(v));

// A line of the widget tree the self-test dumps: `  label[arch-x] 'caption'`. The caption is the only
// part with a sentence in it, and it is quoted from the first `'` to the last because a caption (the
// hint) has quotes of its own.
const enTree = (line) => String(line).replace(/'(.*)'/s, (_, cap) => `'${enLine(cap)}'`);

module.exports = { en, enLine, enValue, enTree, flattenValue, EN, parse };

if (require.main === module) {
  const lines = process.argv.slice(2);
  if (!lines.length) { console.log(`${EN.size} en values loaded`); process.exit(0); }
  for (const l of lines) console.log(enLine(l));
}
