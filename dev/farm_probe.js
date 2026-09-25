// Probe, not a gate: what does an agricultural tower actually need before it produces?
//
// Task #29 is "give the non-recipe sources a rate". For a farm the data answers part of it and not the
// rest: `yumako-tree` says `growth_ticks = 5 minutes` and `minable.results = 50 yumako`, but tiles per
// tower and the crane's plant-and-harvest cycle live in animation geometry (`planting_procedure_points`,
// `crane.speed.arm.extension_speed`), and turning those into items/minute is the kind of arithmetic this
// project only publishes after the bench agrees with it. So: put a tower on the bench, feed it seeds,
// let game time pass, and read its inventories -- then either measure it like a drill or say out loud,
// with numbers, which part refuses to be known.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("farm_probe");
const ENV = process.env;
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV }).trim();
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

console.log("=== the fields this install states about the tower and its plants");
console.log(lua(`local function f(p, names) local o = {}
for _, n in ipairs(names) do
  local ok, v = pcall(function() return p[n] end)
  o[#o+1] = n .. "=" .. (ok and (type(v) == "table" and table.concat((function() local q = {} for _, x in ipairs(v) do q[#q+1] = tostring(x) end return q end)(), "/") or tostring(v)) or "RAISE")
end
return table.concat(o, " ") end
local t = prototypes.entity["agricultural-tower"]
local s = prototypes.item["yumako-seed"]
local y = prototypes.entity["yumako-tree"]
rcon.print("tower   " .. f(t, {"radius", "input_inventory_size", "energy_usage", "heating_energy", "crane_energy_usage", "type", "farm_tile_requires_water", "growth_area_radius", "growth_grid_tile_size", "growth_ticks", "accepted_seeds", "produce_slots", "quality_trigger_radius"}))
rcon.print("seed    " .. f(s, {"plant_result", "place_result", "stack_size", "subgroup"}))
rcon.print("plant   " .. f(y, {"growth_ticks", "type", "growth_time_modifier"}))
local ok, mn = pcall(function() return y.minable end)
rcon.print("minable " .. tostring(ok) .. " " .. (ok and string.format("time=%s results=%s", tostring(mn and mn.mining_time),
  (function() local q = {} for _, r in ipairs((mn or {}).results or {}) do q[#q+1] = tostring(r.name) .. "x" .. tostring(r.amount) end return table.concat(q, ",") end)()) or "raise"))`));

console.log("=== a tower placed on the bench, fed seeds, and left to it");
lua(`local s = game.surfaces["arch-sandbox"]
if not s then rcon.print("no bench") return end
for _, e in ipairs(s.find_entities_filtered{name = "agricultural-tower"}) do e.destroy() end
local ok, t = pcall(function() return s.create_entity{name = "agricultural-tower", position = {x = 0.5, y = 0.5}, force = "player"} end)
if not ok or not t then rcon.print("CREATE FAILED " .. tostring(t)) return end
local got = {}
for _, id in ipairs({"agricultural_tower_input", "agricultural_tower_output"}) do
  local inv_id = defines.inventory[id]
  local ok2, inv = pcall(function() return t.get_inventory(inv_id) end)
  if ok2 and inv then
    if id == "agricultural_tower_input" then pcall(function() inv.insert{name = "yumako-seed", count = 50} end) end
    got[#got+1] = id .. "=ok"
  else got[#got+1] = id .. "=no" end
end
rcon.print("tower unit=" .. t.unit_number .. " inventories: " .. table.concat(got, " ")
  .. " | speed=" .. tostring(game.speed))
game.speed = 40`);

for (let i = 1; i <= 8; i++) {
  sleep(5000);
  console.log(lua(`local s = game.surfaces["arch-sandbox"]
local t = s.find_entities_filtered{name = "agricultural-tower"}[1]
if not t then rcon.print("tower gone") return end
local function contents(inv_id)
  local ok, inv = pcall(function() return t.get_inventory(defines.inventory[inv_id]) end)
  if not ok or not inv then return "no inventory" end
  local ok2, stacks = pcall(function() return inv.get_contents() end)
  if not ok2 then return "get_contents raised" end
  local out = {}
  for name, n in pairs(stacks) do out[#out+1] = name .. "x" .. tostring(n) end
  table.sort(out)
  return #out > 0 and table.concat(out, " ") or "empty"
end
local plants = 0
for _, e in ipairs(s.find_entities_filtered{position = t.position, radius = 6}) do
  local ok, ty = pcall(function() return e.type end)
  if ok and (ty == "plant" or ty == "tree") then plants = plants + 1 end
end
local ok_h, h = pcall(function() return t.health end)
local ok_e, e = pcall(function() return t.electric_energy_usage end)
rcon.print("tick=" .. game.tick .. " plants=" .. plants
  .. " input=[" .. contents("agricultural_tower_input") .. "]"
  .. " output=[" .. contents("agricultural_tower_output") .. "]"
  .. " grid_kw=" .. (ok_e and tostring(e) or "RAISE")
  .. " health=" .. (ok_h and tostring(h) or "?"))`));
}
lua(`game.speed = 1
local s = game.surfaces["arch-sandbox"]
for _, e in ipairs(s.find_entities_filtered{name = "agricultural-tower"}) do e.destroy() end
for _, e in ipairs(s.find_entities_filtered{position = {x = 0.5, y = 0.5}, radius = 8, type = "plant"}) do e.destroy() end
rcon.print("cleaned up")`);
