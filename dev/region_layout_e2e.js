// Region layout: the seam offset is DERIVED, and the ceiling is ARITHMETIC.
//
// Nothing here computes an offset by hand -- region_layout picks it, measures it against
// the ground, and reports the internal flow that doesn't balance. That report is the
// point: 18.75 plates/min feeding a cell that claims 60 gears/min needs 120 plates/min,
// and only the ratio arithmetic knows the region can ship 9.375.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

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
const runTo = (label) => {
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

// ---- freeze the two stages, each with a claim it can actually pay ----
const lane = call("card_example", {}).data;
call("card_lab", { card: lane, seconds: 60, speed: 40 });
const laneRun = runTo("lane:");
call("card_freeze", { name: "smelter-lane" });

const cellPath = path.join(__dirname, "card_gear_fixed.json");
const authored = JSON.parse(fs.readFileSync(cellPath, "utf8"));
call("card_lab", { card: authored, seconds: 60, speed: 40 });
const firstRun = runTo("cell as authored:");
const honest = Math.floor(firstRun.verdicts[0].measured_per_min);
const cell = JSON.parse(JSON.stringify(authored));
cell.contract.outputs["iron-gear-wheel"] = honest;
console.log("cell claim lowered to the measured", honest, "/min -- that is what freezing means");
call("card_lab", { card: cell, seconds: 60, speed: 40 });
runTo("cell at its own rate:");
call("card_freeze", { name: "gear-cell" });

// ---- layout: ask for a line, not for coordinates ----
const lay = call("region_layout", { entries: [{ name: "smelter-lane" }, { name: "gear-cell", count: 3 }] });
if (!lay.ok) { console.log("LAYOUT FAILED", lay.code, lay.msg, JSON.stringify(lay.detail)); process.exit(1); }
const L = lay.data;
console.log("placements:");
for (const p of L.placements) console.log("  ", p.ref, "at", JSON.stringify(p.at), p.seed ? "(seed)" : p.fused ? `fused via ${p.fused}` : p.packed ? "PACKED (no shared item)" : "");
console.log("entities:", L.entities, "contract:", JSON.stringify(L.contract), "internal:", JSON.stringify(L.internal_flows));
console.log("flows:");
for (const f of L.flows) console.log("  ", f.item, "supply", f.supplied_per_min, "demand", f.demanded_per_min,
  "feasible:", f.feasible, f.supported_fraction ? "supported " + (f.supported_fraction * 100).toFixed(1) + "%" : "");
console.log("site:", JSON.stringify(L.site), "lint ok:", L.ok, L.ok ? "" : JSON.stringify(L.lint.errors).slice(0, 240));

// an over-declared region must be caught before any time is spent measuring it
const region = JSON.parse(JSON.stringify(L.card));
region.contract = { outputs: { "iron-gear-wheel": honest } };
call("card_lab", { card: region, seconds: 120, speed: 40 });
runTo("region at one cell's rate:");

const v0 = ready("card_verify", { card: region });
console.log("region before power planning:", v0.data.power.covered + "/" + v0.data.power.powered_entities,
  "covered, errors:", JSON.stringify((v0.data.errors || []).map((e) => e.code)));
const rp = ready("card_fix_power", { card: region });
if (rp.ok) {
  console.log("region power plan:", rp.data.to_add, "additions,", rp.data.served + "/" + rp.data.powered,
    "served,", rp.data.probes, "probes, exhausted:", rp.data.exhausted_search);
  for (const s of rp.data.suggestion) region.entities.push(s);
} else console.log("region power plan FAILED:", rp.code, rp.msg || "");
const v = ready("card_verify", { card: region });
console.log("region verify ok:", v.ok && v.data.ok, "power:", JSON.stringify(v.data.power),
  "arms:", (v.data.arms || []).length, "warnings:", JSON.stringify((v.data.warnings || []).map((w) => w.code)));

// measure the card that is about to be frozen, not an earlier draft of it
region.contract = { outputs: { "iron-gear-wheel": 9 } };
call("card_lab", { card: region, seconds: 180, speed: 40 });
let st = call("lab_status").data;
const rend = Date.now() + 60000;
while (st.state === "running" && Date.now() < rend) { wait(1500); st = call("lab_status").data; }
console.log("final region verdict:", JSON.stringify(st.verdicts), "delivered:", st.delivered);
const rfz = call("card_freeze", { name: "ore-to-gears-line" });
console.log("frozen region:", rfz.ok ? `${rfz.data.entities} entities, ${rfz.data.blueprint.length} byte blueprint` : rfz.code);
const rpl = call("card_place", { name: "ore-to-gears-line" });
console.log("ghosts:", rpl.ok ? `${rpl.data.ghosts} at ${JSON.stringify(rpl.data.origin)}` : `${rpl.code} ${rpl.msg || ""}`);
call("lab_reset");

// this script really does place ghosts on the player's surface, so it really does remove them
console.log(lua(`local n=0 for _,s in pairs(game.surfaces) do for _,e in ipairs(s.find_entities_filtered{type="entity-ghost"}) do e.destroy() n=n+1 end end
rcon.print("ghosts cleaned: "..n)`));
