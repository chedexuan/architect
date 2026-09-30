// The bench's supply tank never empties into a lane's row. Does a pump between them fix it?
//
// Three identical assemblers, each with its recipe bound, both of its item ingredients in hand (2.0.77
// wants iron ore AND stone brick for concrete, which the engine says as `fluid_ingredient_shortage` once
// those are there -- the machine is ready and thirsty), and its water box one pipe away. The only thing
// that differs is what stands between the full tank and that pipe: nothing, a pump pushing at the pipe,
// or a pump pushing at the tank. The reading is the machine's own box and what it made, because a tank
// reports no connections at all and a pipe holding water is the only witness the engine offers.
//
// Raw entities on the bench; `dev/cycle.sh` restarts from the save, so nothing here persists.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("supply_pump_e2e");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV, maxBuffer: 1 << 28 }).trim();
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const one = (s) => String(s).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "OK").join(" | ");

const SURF = process.argv[2] || "arch-lab";
const OY = -940;
const CASES = [
  { label: "bare", x: 940 },
  { label: "pump->pipe", x: 980 },
  { label: "pump->tank", x: 1020 },
];

lua(`local f=game.forces.player
for _,t in ipairs{"automation","automation-2","concrete","electronics","logistics","steel-processing","fluid-handling"} do
  local x=f.technologies[t]; if x then x.researched=true end
end
local r=f.recipes["concrete"]; if r then r.enabled=true end
rcon.print("techs on")`);

const build = (c, pumpDir) => lua(`local GKEY = "SUPPLY_${c.x}"
local s = game.surfaces["${SURF}"]
local OX, OY = ${c.x}, ${OY}
for _, e in ipairs(s.find_entities_filtered{area={{OX-10,OY-10},{OX+10,OY+10}}}) do
  if e.type ~= "resource" and e.type ~= "tile" then e.destroy() end
end
s.create_global_electric_network()
local gen = s.create_entity{name="electric-energy-interface", position={OX-5,OY+6}, force="player"}
local am = s.create_entity{name="assembling-machine-2", position={OX,OY}, force="player"}
am.set_recipe("concrete")
local inv = am.get_inventory(defines.inventory.assembling_machine_input)
local a = inv.insert{name="stone-brick", count=100}
local b = inv.insert{name="iron-ore", count=100}
local w = prototypes.entity["assembling-machine-2"].tile_width
local box = { x = am.position.x, y = am.position.y - (w / 2 + 0.5) }
local pipe = s.create_entity{name="pipe", position=box, force="player"}
local tank = s.create_entity{name="storage-tank", position={x=box.x, y=box.y-2},
  direction=defines.direction.south, force="player"}
local pump
local dir = "${pumpDir}"
if dir ~= "none" then
  local d = (dir == "south") and defines.direction.south or defines.direction.north
  pump = s.create_entity{name="pump", position={x=box.x, y=box.y-1}, direction=d, force="player"}
end
local filled = 0
pcall(function() filled = tank.insert_fluid{name="water", amount=25000} or 0 end)
_G[GKEY] = { am=am, pipe=pipe, tank=tank, pump=pump, gen=gen }
rcon.print("${c.label} bricks="..a.." ore="..b.." filled="..filled.." pump="..tostring(pump ~= nil))`);

const read = (c) => lua(`local s = game.surfaces["${SURF}"]
local d = _G["SUPPLY_" .. ${c.x}] or {}
local rev
for k, v in pairs(defines.entity_status) do rev = rev or {}; rev[v] = k end
local function held(e)
  if not (e and e.valid) then return -1 end
  local t = 0
  pcall(function() for _, v in pairs(e.get_fluid_contents()) do t = t + (tonumber(v) or 0) end end)
  return t
end
local made = 0
if d.am and d.am.valid then
  local out = d.am.get_inventory(defines.inventory.assembling_machine_output)
  if out then made = out.get_item_count("concrete") end
end
rcon.print(string.format("${c.label} am=%s box=%.1f pipe=%.1f tank=%.0f pump=%s made=%d",
  tostring(d.am and d.am.valid and rev[d.am.status] or "gone"), held(d.am), held(d.pipe), held(d.tank),
  tostring(d.pump and d.pump.valid and rev[d.pump.status] or "none"), made))`);

const dirs = ["none", "south", "north"];
for (let i = 0; i < CASES.length; i++) {
  console.log("  " + one(build(CASES[i], dirs[i])));
}
sleep(9000);
for (const c of CASES) console.log("  " + one(read(c)));
sleep(6000);
console.log("  (after 15s)");
for (const c of CASES) console.log("  " + one(read(c)));

for (const c of CASES) {
  lua(`local s = game.surfaces["${SURF}"]
local OX, OY = ${c.x}, ${OY}
for _, e in ipairs(s.find_entities_filtered{area={{OX-10,OY-10},{OX+10,OY+10}}}) do
  if e.type ~= "resource" and e.type ~= "tile" then e.destroy() end
end
_G["SUPPLY_" .. ${c.x}] = nil
rcon.print("cleared ${c.label}")`);
}
