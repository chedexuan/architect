// The data behind the `unclassified_crafters` report, on its own.
//
// smoke asserts it, but an assertion that dies two lines earlier proves nothing: breaking
// `host.CRAFTER_KINDS` took out `machines["assembling-machine-1"]` and crashed a later check before
// this one could be read. So the field gets its own probe, which asks one question and prints it.
const { execFileSync } = require("child_process");
const path = require("path");
const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "ignore"] }).trim());

const c = call("capabilities", {});
const cov = (c.data || {}).coverage || {};
console.log(JSON.stringify({
  covered_kinds: cov.crafting_kinds_covered,
  unclassified: cov.unclassified_crafters,
  machines_seen_by_the_solver: Object.keys((c.data || {}).machines || {}).length,
}, null, 1));
