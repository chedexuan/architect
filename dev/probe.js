// Probe a mod method with a fixture and print only the fields under discussion.
// Usage: node dev/probe.js <method> <fixture.json|-> <field> [field...]
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const [, , method, fixtureFile, ...fields] = process.argv;
if (!method) { console.error("usage: node probe.js <method> <fixture.json> [fields]"); process.exit(1); }

let args = {};
if (fixtureFile && fixtureFile !== "-") {
  // an inline object is used as-is; a bare card fixture is wrapped, because most fixtures
  // are cards and every method that takes one names the field `card`
  const raw = fixtureFile.trim().startsWith("{") ? fixtureFile : fs.readFileSync(fixtureFile, "utf8");
  const fixture = JSON.parse(raw);
  args = fixture.entities ? { card: fixture } : fixture;
}

let out;
try {
  out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args)],
    { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  const text = (e.stdout || "") + (e.stderr || "");
  console.log("FAILED\n" + text.slice(0, 4000));
  process.exit(0);
}
const j = JSON.parse(out);
// helpers.table_to_json serialises an empty Lua table as {}, so every list read here
// has to tolerate the object shape as well as the array.
const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : Object.keys(v).length ? Object.values(v) : []);
const pick = (o, k) => k.split(".").reduce((a, x) => (a == null ? a : a[x]), o);
if (!fields.length) { console.log(JSON.stringify(j, null, 1).slice(0, 6000)); }
else {
  const view = {};
  for (const f of fields) view[f] = pick(j, f);
  console.log(JSON.stringify(view, null, 1));
  const sug = asArr(j.suggestion);
  if (sug.length) console.log("suggestion: " + sug.map((s) => `${s.name}@${s.position.x},${s.position.y}`).join(" "));
}
