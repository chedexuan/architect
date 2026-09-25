// The bus hypothesis, tested against the alternative it is meant to replace.
//
// Same furnace line, same two gear cells:
//   A) cells bolted straight onto two chests of the one furnace
//   B) cells hanging off two taps of a belt bus fed by that furnace
// If a bus is the right primitive, B must reach the arithmetic ceiling (~9 gears/min)
// while A stays contention-limited (measured 4.33). Anything else and the bus is
// decoration.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
// These five lay machines, run rigs and take chests back out, so they are held to the same rule as
// the assertion gates: never point one at the server a client is connected to.
require("./suite-guard.js").guardMain("bus_e2e");

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
const measure = (label, card, claim, seconds) => {
  const c = JSON.parse(JSON.stringify(card));
  c.contract = { outputs: { "iron-gear-wheel": claim } };
  const r = call("card_lab", { card: c, seconds: seconds || 180, speed: 40 });
  if (!r.ok) { console.log(label, "LAB FAILED", r.code, JSON.stringify(r.detail || r.msg).slice(0, 220)); return null; }
  let st = call("lab_status").data;
  const end = Date.now() + 60000;
  while (st.state === "running" && Date.now() < end) { wait(1500); st = call("lab_status").data; }
  const v = arr(st.verdicts)[0] || {};
  console.log(label, `${v.measured_per_min}/min gears (claim ${v.claimed_per_min}) produced=${v.produced} delivered=${st.delivered}`,
    `out_chest=${st.diagnostics && st.diagnostics.out_chest_have}`);
  call("lab_reset");
  return st;
};

lua(`local f=game.forces.player
for _,t in ipairs({"electronics","automation","logistics","steel-processing","logistics-2","solar-energy","electric-energy-accumulators"}) do
  local x=f.technologies[t]; if x then x.researched=true end
end`);

const lane = call("card_example", {}).data;
const bus = call("bus_example", { taps: 2 }).data;
const cell = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));

// A) direct two-anchor fan-out, the design the bus is supposed to beat
const layA = ready("region_layout", { entries: [{ card: lane }, { card: cell, count: 2 }] });
if (!layA.ok) { console.log("LAYOUT A FAILED", layA.code, layA.msg); process.exit(1); }
console.log("A placements:", layA.data.placements.map((p) => `${p.ref}:${p.fused ? "fused" : p.packed ? "PACKED" : "seed"}`).join("  "));
const stA = measure("A) cells on the furnace's own chests:", layA.data.card, 9.3);
const perA = stA ? ((arr(stA.verdicts)[0] || {}).measured_per_min || 0) : 0;

// B) through the bus
const layB = ready("region_layout", { entries: [{ card: lane }, { card: bus }, { card: cell, count: 2 }], power: true });
if (!layB.ok) { console.log("LAYOUT B FAILED", layB.code, layB.msg); process.exit(1); }
const LB = layB.data;
console.log("B placements:");
for (const p of arr(LB.placements)) console.log("   ", p.ref, "at", JSON.stringify(p.at),
  p.seed ? "(seed)" : `${p.fused ? `fused ${p.fused} (${p.seam})` : "PACKED"}`);
console.log("   entities:", LB.entities, "internal:", JSON.stringify(LB.internal_flows),
  "outside-needed:", JSON.stringify(arr(LB.flows).map((f) => f.demanded_from_outside)));
for (const f of arr(LB.flows)) console.log("   flow", f.item, "supply", f.supplied_per_min, "demand", f.demanded_per_min,
  "feasible:", f.feasible, f.max_supported_per_min ? `ceiling ${f.max_supported_per_min}` : "");
console.log("   lint ok:", LB.ok, LB.ok ? "" : JSON.stringify(arr(LB.lint.errors).map((e) => e.code + "@" + e.at)));

const vB = ready("card_verify", { card: LB.card });
if (!vB.ok) console.log("B verify FAILED:", vB.code, vB.msg, JSON.stringify(vB.detail || {}).slice(0, 240));
else console.log("B verify:", vB.data.ok, "placed", vB.data.placed, "arms", arr(vB.data.arms).length,
  "power", JSON.stringify(vB.data.power), "errors", JSON.stringify(arr(vB.data.errors).map((e) => e.code)));

const stB = measure("B) cells on a belt bus:", LB.card, 9.3);
if (stB) {
  const perB = (arr(stB.verdicts)[0] || {}).measured_per_min || 0;
  // Both numbers come from this run. The 4.33 that used to sit here was a measured result
  // from an earlier layout, and it stayed in the sentence after the layout changed underneath
  // it -- a hardcoded figure in a verdict line is a claim that goes stale silently.
  console.log(`verdict: bus ${perB}/min vs direct-fanout ${perA}/min; arithmetic ceiling 9.375/min`);
}
