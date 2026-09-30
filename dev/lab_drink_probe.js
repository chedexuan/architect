// Why does `card_lab` stop short of a window on a lane that drinks its own water row?
//
// The shape is the one `card_example` lays for `concrete`: three assemblers, one pipe row along their
// north face, and a port at one end for the player's network. The card declares water on each machine's
// box, so the rig has every fact it needs -- and the run stopped at `supply_unproven` rather than
// opening a window. This asks which cell of that plan the ground refused, printing the rig's own
// problem records and the machine statuses beside them instead of folding them into one code.
//
// Raw entities on the bench; `dev/cycle.sh` restarts from the save, so nothing here persists.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("lab_drink_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const call = (method, args) => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
    { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 });
  return JSON.parse(out.trim());
};
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV, maxBuffer: 1 << 28 }).trim();
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const one = (s) => String(s).split(/\r?\n/)[0].trim();

const TECHS = ["automation", "automation-2", "concrete", "electronics", "logistics", "steel-processing",
  "fluid-handling"];
const LUA_TECHS = TECHS.map((t) => JSON.stringify(t)).join(",");
const before = lua(`local f=game.forces.player
local out={}
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; out[#out+1]=t.."="..(x and tostring(x.researched) or "absent")
end
rcon.print(table.concat(out," "))`);
console.log("research before:", one(before));
const alreadyOn = {};
for (const pair of one(before).split(/\s+/)) {
  const [k, v] = pair.split("=");
  if (v === "true") alreadyOn[k] = true;
}
lua(`local f=game.forces.player
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; if x then x.researched=true end
end
rcon.print("on")`);

const finish = (code) => {
  try {
    call("lab_reset", {});
    lua(`local f=game.forces.player
local want={${Object.keys(alreadyOn).map((k) => `[${JSON.stringify(k)}]=true`).join(",")}}
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; if x and not want[t] then x.researched=false end
end
rcon.print("restored")`);
  } catch (e) { console.log("cleanup failed:", String(e).slice(0, 160)); }
  process.exit(code || 0);
};

const SURF = "arch-lab";
const ex = call("card_example", { recipe: "concrete", machines: 3, machine: "assembling-machine-2" });
const card = ex.data || ex;
if (!card.name) { console.log("no card:", JSON.stringify(ex).slice(0, 300)); finish(1); }
console.log("card:", card.name, "entities=" + (card.entities || []).length,
  "pipes=" + (card.entities || []).filter((e) => e.name === "pipe").length,
  "fluid_in=" + JSON.stringify(card.fluid_in));

const started = call("card_lab", { card, seconds: 10 });
// One line per key: the interesting fields (recipes_bound, unwired_inputs, detail) are the ones a
// single sliced print always cuts off, and the whole diagnosis of a drinking lane is in them.
const sdata = started.data || started;
for (const k of Object.keys(sdata).sort()) {
  console.log("  " + k + " = " + JSON.stringify(sdata[k]).slice(0, 500));
}
if (started.ok === false) finish(1);

const show = (j) => {
  const keys = ["state", "elapsed_ticks", "remaining_ticks", "produced", "measured_per_min", "fed",
    "fed_blocked", "fuelled", "fuel_blocked", "delivered", "game_speed", "tick_error",
    "machine_status", "supply_faces", "box_notes", "probed", "supply_problems", "verdicts",
    "diagnostics", "abandoned_because"];
  for (const k of keys) {
    const v = j[k];
    if (v === undefined) continue;
    const s = JSON.stringify(v);
    console.log("  - " + k + " = " + (s.length > 900 ? s.slice(0, 900) + "..." : s));
  }
};

const READ = `local s = game.surfaces["${SURF}"]
local out = {}
local function g(k, fn) local ok, v = pcall(fn) out[#out+1]=k.."="..(ok and tostring(v) or "ERR:"..tostring(v)) end
g("status", function() return am and am.valid and am.status end)
g("recipe", function() return am and am.valid and am.get_recipe() and am.get_recipe().name end)
g("energy", function() return am and am.valid and am.energy end)
g("electric_network", function() return am and am.valid and am.electric_network ~= nil end)
g("input_items", function()
  local inv = am and am.valid and am.get_inventory(defines.inventory.assembling_machine_input)
  return inv and inv.get_item_count() end)
g("crafting", function() return am and am.valid and am.crafting_progress end)
g("fluid", function()
  if not (am and am.valid) then return nil end
  local t = 0
  for _, v in pairs(am.get_fluid_contents()) do t = t + (tonumber(v) or 0) end
  return string.format("%.1f", t) end)
g("tank_fluid", function()
  if not (tk and tk.valid) then return nil end
  local t = 0
  for _, v in pairs(tk.get_fluid_contents()) do t = t + (tonumber(v) or 0) end
  return string.format("%.0f", t) end)
g("tank_joined", function()
  if not (tk and tk.valid) then return nil end
  local n = 0
  for _ in pairs(tk.fluidbox.get_connections(1) or {}) do n = n + 1 end
  return n end)
g("row_wet", function()
  local wet, dry = 0, 0
  for _, e in ipairs(s.find_entities_filtered{area={{-4,-6},{46,12}}, name="pipe"}) do
    local h = 0
    for _, v in pairs(e.get_fluid_contents()) do h = h + (tonumber(v) or 0) end
    if h > 0 then wet = wet + 1 else dry = dry + 1 end
  end
  return "wet="..wet.." dry="..dry end)
rcon.print(table.concat(out, " | "))`;

// One machine of the lane, and the tank the rig stood on its port, read straight off the ground. The
// lane is placed at the bench origin (0,0) by the site search this run, so the cells named in the card
// answer are the cells on the map.
const peek = (label) => {
  const out = lua(`local s = game.surfaces["${SURF}"]
local am = (s.find_entities_filtered{area={{-4,-6},{46,12}}, name="assembling-machine-2"})[1]
local tk = (s.find_entities_filtered{area={{-8,-8},{46,12}}, name="storage-tank"})[1]
${READ}`);
  console.log("  peek " + label + " => " + one(out));
};
for (let i = 0; i < 12; i++) {
  sleep(2500);
  const st = call("lab_status", {});
  const d = st.data || st;
  if (i % 2 === 0) peek(d.state);
  show(d);
  if (d.state !== "probing" && d.state !== "proving" && d.state !== "running") break;
}
const stopped = call("lab_stop", {});
console.log("lab_stop =>", JSON.stringify(stopped).slice(0, 1600));
finish(0);
