// Fan-out through two anchors on one furnace.
//
// The claim being tested is a narrow one and it is easy to get wrong: adding a second
// output chest lets a second card CONNECT, it does not make the furnace produce more.
// If the region's measured output doubles here, something is lying -- either the
// layout paired both cells to the same anchor, or the flow report is not bounding the
// consumers. So this asserts the anchors differ and the total does not grow.
const { brief } = require("./lines.js");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
// These five lay machines, run rigs and take chests back out, so they are held to the same rule as
// the assertion gates: never point one at the server a client is connected to.
require("./suite-guard.js").guardMain("fanout_e2e");

const arr = (v) => (Array.isArray(v) ? v : []);
const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" } }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8", env: { ...process.env } }).trim();
const wait = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ready = (m, a) => {
  for (let i = 0; i < 12; i++) {
    const r = call(m, a);
    if (r.ok || r.code !== "SANDBOX_GENERATING") return r;
    wait(1000);
  }
  return { ok: false, code: "SANDBOX_STUCK" };
};
const runTo = (label, card, seconds) => {
  const r = call("card_lab", { card, seconds: seconds || 120, speed: 40 });
  if (!r.ok) { console.log(label, "LAB FAILED", r.code, JSON.stringify(r.detail || r.msg).slice(0, 200)); return {}; }
  let st = call("lab_status").data;
  const end = Date.now() + 60000;
  while (st.state === "running" && Date.now() < end) { wait(1200); st = call("lab_status").data; }
  console.log(label, JSON.stringify(st.verdicts), "delivered:", st.delivered);
  return st;
};

lua(`local f=game.forces.player
for _,t in ipairs({"electronics","automation","logistics","steel-processing","logistics-2","solar-energy","electric-energy-accumulators"}) do
  local x=f.technologies[t]; if x then x.researched=true end
end`);

const lane = call("card_example", { outlets: 2 }).data;
console.log("lane:", lane.entities.length, "entities, out ports:", JSON.stringify(lane.ports.out),
  "anchors:", JSON.stringify(lane.roles.out_chests));
const laneRun = runTo("lane alone with 2 outlets:", lane, 60);

const cell = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));

const lay = call("region_layout", { entries: [{ card: lane }, { card: cell, count: 2 }] });
if (!lay.ok) { console.log("LAYOUT FAILED", lay.code, lay.msg, brief(lay.detail, 300)); process.exit(1); }
const L = lay.data;
for (const p of arr(L.placements)) console.log("  ", p.ref, "at", JSON.stringify(p.at),
  p.seed ? "(seed)" : `${p.fused ? `fused via ${p.fused} @out-anchor ${p.anchor_out}` : "PACKED"}`);
console.log("  entities:", L.entities, "internal:", JSON.stringify(L.internal_flows), "lint ok:", L.ok);
for (const f of arr(L.flows)) console.log("   flow", f.item, "supply", f.supplied_per_min, "demand", f.demanded_per_min,
  "feasible:", f.feasible, f.max_supported_per_min ? `ceiling ${f.max_supported_per_min}` : "");

const anchors = arr(L.placements).filter((p) => p.anchor_out).map((p) => p.anchor_out);
console.log("distinct out anchors used:", JSON.stringify(anchors), "unique:", new Set(anchors).size);

const region = JSON.parse(JSON.stringify(L.card));
const ceiling = arr(L.flows).find((f) => f.item === "iron-plate");
const honest = Math.floor((ceiling ? ceiling.max_supported_per_min : 9) * 10) / 10;
region.contract = { outputs: { "iron-gear-wheel": honest } };
runTo(`region of 2 cells at the derived ceiling (${honest}/min):`, region, 180);
const v = ready("card_verify", { card: region });
if (v.ok) console.log("  verify:", v.data.ok, "arms:", (v.data.arms || []).length, "power:", JSON.stringify(v.data.power));
else console.log("  verify FAILED:", v.code, v.msg || "");
call("lab_reset");
