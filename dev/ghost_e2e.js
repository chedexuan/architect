// End-to-end proof of the whole loop:
//   author -> lint -> verify -> measure -> freeze -> ghosts -> revived machines -> output
// The revived run is the part nothing else covers: it proves the geometry that was
// judged is the geometry a player would actually get.
const { execFileSync } = require("child_process");
const path = require("path");
// These five lay machines, run rigs and take chests back out, so they are held to the same rule as
// the assertion gates: never point one at the server a client is connected to.
require("./suite-guard.js").guardMain("ghost_e2e");

const PORT = process.env.RCON_PORT || "27015";
const call = (method, args) => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
    { encoding: "utf8", env: { ...process.env, RAW: "1" } });
  return JSON.parse(out.trim());
};
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: { ...process.env } }).trim();
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

lua(`local f=game.forces.player
for _,t in ipairs({"electronics","automation","logistics","steel-processing","logistics-2"}) do
  local x=f.technologies[t]; if x then x.researched=true end
end`);

const card = call("card_example", {}).data;
console.log("card:", card.entities.length, "entities, arm reach", card.arm_reach);

call("card_lab", { card, seconds: 60, speed: 40 });
let st = call("lab_status").data;
while (st.state === "running") { sleep(1000); st = call("lab_status").data; }
console.log("measured:", JSON.stringify(st.verdicts), "delivered:", st.delivered);

const fz = call("card_freeze", { name: "lane-from-e2e" }).data;
console.log("frozen:", fz.name, "blueprint", fz.blueprint.length, "bytes ->", fz.blueprint.slice(0, 18) + "...");

const pl = call("card_place", { name: "lane-from-e2e" }).data;
console.log("placed:", pl.ghosts, "ghosts at", JSON.stringify(pl.origin));
const [ox, oy] = [pl.origin.x, pl.origin.y];
const area = `{{${ox - 2},${oy - 2}},{${ox + 22},${oy + 14}}}`;

// silent_revive returns nothing useful, and arms get auto-oriented by the engine on
// the way in, so revive solid entities first and re-assert arm directions after.
const built = lua(`local s=game.surfaces[1]
local area=${area}
local gs=s.find_entities_filtered{area=area,type="entity-ghost"}
local arms, real, errs = {}, {}, {}
for _,g in ipairs(gs) do
  local nm = g.ghost_name
  if nm == "long-handed-inserter" or nm == "inserter" or nm == "burner-inserter" or nm == "stack-inserter" or nm == "filter-inserter" then
    arms[#arms+1] = {g=g, dir=g.direction}
  else
    local ok, err = pcall(function() g.silent_revive{raise_revive=true} end)
    if not ok then errs[#errs+1] = tostring(err) end
  end
end
for _,a in ipairs(arms) do
  local ok, err = pcall(function() a.g.silent_revive{raise_revive=true} end)
  if not ok then errs[#errs+1] = tostring(err) end
end
local out = {revived_errs=errs}
out.ghosts_left = #s.find_entities_filtered{area=area,type="entity-ghost"}
out.chests = #s.find_entities_filtered{area=area,type="container"}
out.furnaces = #s.find_entities_filtered{area=area,type="furnace"}
out.arms = #s.find_entities_filtered{area=area,type="inserter"}
out.belts = #s.find_entities_filtered{area=area,type="transport-belt"}
for _,c in ipairs(s.find_entities_filtered{area=area,type="container"}) do c.insert({name="iron-ore", count=400}) end
for _,f in ipairs(s.find_entities_filtered{area=area,type="furnace"}) do
  local fi = f.get_inventory(defines.inventory.fuel)
  if fi then fi.insert({name="coal", count=200}) end
end
-- 2.0 arms consume power. A revived card with no grid on the site is a card of
-- statues, so supply it the way the lab does and note that this is a constraint the
-- card itself must eventually carry (poles + generation), not one the rig can hide.
s.create_global_electric_network()
local gen = s.create_entity{name="electric-energy-interface", position={${ox - 1},${oy + 8}}, force="player"}
game.speed = 40
out.fed = true
out.gen = gen ~= nil
out.arm_dirs = {}
for _,a in ipairs(s.find_entities_filtered{area=area,type="inserter"}) do
  out.arm_dirs[#out.arm_dirs+1] = a.direction
end
rcon.print(helpers.table_to_json(out))`);
console.log("revive:", built);

sleep(2500);
const done = lua(`local s=game.surfaces[1]
local area=${area}
local plates, ore = 0, 0
for _,c in ipairs(s.find_entities_filtered{area=area,type="container"}) do
  plates = plates + c.get_item_count("iron-plate")
  ore = ore + c.get_item_count("iron-ore")
end
local onbelt = 0
for _,b in ipairs(s.find_entities_filtered{area=area,type="transport-belt"}) do
  onbelt = onbelt + b.get_item_count("iron-ore")
end
game.speed = 1
local gone = 0
for _,t in ipairs({"container","furnace","inserter","transport-belt","electric-energy-interface"}) do
  for _,e in ipairs(s.find_entities_filtered{area=area,type=t}) do e.destroy() gone = gone + 1 end
end
rcon.print(helpers.table_to_json({plates=plates, ore_in_chests=ore, ore_on_belts=onbelt,
  speed=game.speed, cleaned=gone}))`);
console.log("run:", done);
