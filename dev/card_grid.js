// One card, drawn as a grid, from the remote door's own JSON.
//
// The generator's answer is a list of parts with `role` marks; a text dump of it cannot show whether the
// pipe row really sits against the machine face it was measured on, whether the arms stand one row beyond
// it, and whether the two pipe rows are one cell apart (they must not be). So this prints the footprint
// with one glyph per part and the roles kept, the way the game would put it on the ground.
//
//   node dev/card_grid.js sulfuric-acid 3
const { execFileSync } = require("child_process");
const recipe = process.argv[2] || "sulfuric-acid";
const machines = parseInt(process.argv[3] || "3", 10);
const extra = process.argv[4] ? JSON.parse(process.argv[4]) : {};

const args = JSON.stringify(Object.assign({ recipe, machines, force: "player" }, extra));
// `call.js` exits non-zero when the mod's answer is a refusal -- and a refusal is exactly what this
// reader is for. So the failure's stdout is taken rather than thrown.
let raw;
try {
  raw = execFileSync("node", [require("path").join(__dirname, "call.js"), "card_example", args],
    { encoding: "utf8", env: process.env, maxBuffer: 1 << 28 });
} catch (e) { raw = String(e.stdout || "") + String(e.stderr || ""); }
const m = raw.match(/\{[\s\S]*\}/);
if (!m) { console.log(raw); process.exit(1); }
const d = JSON.parse(m[0]);
if (d.fail) {
  console.log(`FAIL ${d.code} :: ${d.message}\n  detail=${JSON.stringify(d.detail).slice(0, 900)}`);
  process.exit(0);
}

const SHORT = {
  "chemical-plant": "C", "oil-refinery": "R", "assembling-machine-2": "A", "assembling-machine-3": "A",
  "foundry": "F", "cryogenic-plant": "Y", "electromagnetic-plant": "E", "centrifuge": "G",
  "pipe": "P", "long-handed-inserter": "L", "fast-inserter": "i", "inserter": "I",
  "filter-inserter": "f", "fast-transport-belt": "t", "transport-belt": "b",
  "express-transport-belt": "e", "steel-chest": "X", "display-panel": "n", "emitter-box": "N",
  "small-electric-pole": "+", "medium-electric-pole": "+",
};
const cell = (p) => [Math.floor(p.x - 0.5 + 1e-3), Math.floor(p.y - 0.5 + 1e-3)];
const occ = {};
for (const e of d.entities) {
  const [x, y] = cell(e.position);
  let g = SHORT[e.name] || (e.name.includes("belt") ? "t" : e.name.includes("pipe") ? "P"
    : e.name.includes("inserter") ? "i" : "?");
  if (e.role === "fluid_in") g = "p<";
  if (e.role === "fluid_out") g = "p>";
  if (e.role === "feed_line") g = "T" + (e.line || "");
  if (e.role === "product_line") g = "T" + (e.line || "") + ">";
  occ[y] = occ[y] || {};
  occ[y][x] = g;
}
const ys = Object.keys(occ).map(Number).sort((a, b) => a - b);
const xs = [...new Set(ys.flatMap((y) => Object.keys(occ[y]).map(Number)))].sort((a, b) => a - b);
const rows = ys.map((y) => `${String(y).padStart(3)} |${xs.map((x) => (occ[y][x] || ".")).join("")}|`);
console.log(`style=${d.style} fp=${d.footprint.width}x${d.footprint.height} `
  + `parts=${JSON.stringify(d.parts)}`);
console.log(rows.join("\n"));
console.log("feed_plan=" + JSON.stringify(d.feed_plan && {
  materials: d.feed_plan.materials, lane_rows: d.feed_plan.lane_rows,
  per_lane: d.feed_plan.per_lane, lanes_wanted: d.feed_plan.lanes_wanted }).slice(0, 200));
console.log("fluid_in=" + JSON.stringify(d.fluid_in));
console.log("fluid_out=" + JSON.stringify(d.fluid_out));
console.log("contract=" + JSON.stringify(d.contract));
console.log("unfed=" + JSON.stringify(d.unfed));
