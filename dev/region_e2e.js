// Region assembly, end to end: two frozen-shaped cards -> one card -> powered -> judged.
//
// Lane  ore -> plate      (18.75/min claimed, 18/min measured)
// Cell  plate -> gear     (60/min claimed, 35/min measured, arm-limited)
// Seam  the lane's out chest IS the cell's in chest, so plate becomes an internal flow
// and the region's only export is gears. Neither card alone can tell you the region's
// real ceiling -- it is min(plate/2, gear capacity) -- which is what this exercises.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" } }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8", env: { ...process.env } }).trim();
const wait = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
// the sandbox generates chunks asynchronously, so "not yet" is a normal answer that
// must be retried rather than swallowed as a silent no-op
const callReady = (m, a) => {
  for (let i = 0; i < 12; i++) {
    const r = call(m, a);
    if (r.ok || r.code !== "SANDBOX_GENERATING") return r;
    wait(1000);
  }
  return { ok: false, code: "SANDBOX_STUCK" };
};
const verifyTilReady = (card, extra) => callReady("card_verify", Object.assign({ card }, extra || {}));

lua(`local f=game.forces.player
for _,t in ipairs({"electronics","automation","logistics","steel-processing","logistics-2","solar-energy","electric-energy-accumulators"}) do
  local x=f.technologies[t]; if x then x.researched=true end
end`);

const lane = call("card_example", {}).data;
const cell = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));

// the lane's out chest sits at local (12.5, 5.5); the cell's in chest at (2.5, 1.5)
const seam = { x: 12.5 - 2.5, y: 5.5 - 1.5 };
console.log("seam offset:", JSON.stringify(seam));

let comp = call("card_compose", { slots: [{ card: lane, at: { x: 0, y: 0 } }, { card: cell, at: seam }] });
if (!comp.ok) { console.log("COMPOSE FAILED", comp.code, JSON.stringify(comp.detail)); process.exit(1); }
const region = comp.data;
console.log("composed:", region.entities.length, "entities,",
  "fusions:", JSON.stringify(region.report.fusions),
  "internal:", JSON.stringify(region.internal_flows),
  "contract:", JSON.stringify(region.contract));
console.log("ports in:", JSON.stringify(region.ports["in"]), "out:", JSON.stringify(region.ports.out));
console.log("lint ok:", region.ok, region.ok ? "" : JSON.stringify(region.lint.errors));

let plan = callReady("card_fix_power", { card: region });
if (!plan.ok) console.log("power plan FAILED:", plan.code, plan.msg || "", JSON.stringify(plan.detail || {}).slice(0, 200));
else {
  console.log("power plan:", plan.data.to_add, "additions,", plan.data.served + "/" + plan.data.powered, "served,", plan.data.probes, "probes");
  // appending never shifts existing indices, so the ports stay valid without re-composing
  for (const s of plan.data.suggestion) region.entities.push(s);
}
const v = verifyTilReady(region);
console.log("verify ok:", v.ok && v.data.ok, "power:", JSON.stringify(v.data.power),
  "arms:", (v.data.arms || []).length, "warnings:", JSON.stringify((v.data.warnings || []).map((w) => w.code)));

// The region's honest ceiling is the slower stage: plates/2, not the cell's own claim.
const claim = 9;
region.contract = { outputs: { "iron-gear-wheel": claim } };
let r = call("card_lab", { card: region, seconds: 180, speed: 40 });
if (!r.ok) { console.log("LAB FAILED", r.code, JSON.stringify(r.detail || r.msg)); process.exit(1); }
let st = call("lab_status").data;
const deadline = Date.now() + 60000;
while (st.state === "running" && Date.now() < deadline) { wait(1500); st = call("lab_status").data; }
console.log("region verdict:", JSON.stringify(st.verdicts), "delivered:", st.delivered,
  "pay:", st.pay_fraction, "diag:", JSON.stringify(st.diagnostics));

const fz = call("card_freeze", { name: "ore-to-gears-region" });
console.log("frozen:", fz.ok ? `${fz.data.entities} entities, ${fz.data.blueprint.length} byte blueprint` : fz.code);
const pl = call("card_place", { name: "ore-to-gears-region" });
console.log("ghosts:", pl.ok ? `${pl.data.ghosts} placed at ${JSON.stringify(pl.data.origin)}` : `${pl.code} ${pl.msg || ""}`);
call("lab_reset");
