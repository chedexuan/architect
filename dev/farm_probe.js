#!/usr/bin/env node
// Probe, not a gate: what does an agricultural tower need before it produces?
//
// Task #29 is "give the non-recipe sources a rate". For a farm the data answers part of it and not the
// rest: `yumako-tree` states `growth_ticks = 5 minutes` and `minable.results = 50 yumako`, but tiles
// per tower and the crane's plant-and-harvest cycle live in animation geometry
// (`planting_procedure_points`, `crane.speed.arm.extension_speed`), and turning those into
// items/minute is arithmetic this project only publishes once the bench agrees. So: place a tower,
// feed it seeds, let game time pass, and read what it says about itself -- including the statuses,
// which is where "it refused to farm" becomes a reason instead of a zero.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("farm_probe");
const ENV = process.env;
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV }).trim();
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

console.log("=== what this install states about the tower, the seed and the plant");
console.log(lua(`local function show(t, names)
  local o = {}
  for _, n in ipairs(names) do
    local ok, v = pcall(function() return t[n] end)
    if ok and v ~= nil then
      if type(v) == "table" then
        local q = {}
        for k, x in pairs(v) do q[#q+1] = tostring(k) .. ":" .. (type(x) == "table" and "{" .. (tostring(x.name) ~= "nil" and tostring(x.name) or "?") .. "}" or tostring(x)) end
        table.sort(q)
        o[#o+1] = n .. "={" .. table.concat(q, " ") .. "}"
      else o[#o+1] = n .. "=" .. tostring(v) end
    elseif not ok then o[#o+1] = n .. "=RAISE" end
  end
  return table.concat(o, "  ")
end
local t = prototypes.entity["agricultural-tower"]
local seed = prototypes.item["yumako-seed"]
local tree = prototypes.entity["yumako-tree"]
rcon.print("tower " .. show(t, {"type", "radius", "input_inventory_size", "energy_usage", "heating_energy",
  "accepted_seeds", "growth_area_radius", "growth_grid_tile_size", "growth_ticks", "farm_tile_requires_water",
  "farm_tiles_per_tower", "production", "mining_speed", "crafting_speed"}))
rcon.print("seed  " .. show(seed, {"plant_result", "place_result", "stack_size", "fuel_value"}))
rcon.print("plant " .. show(tree, {"type", "growth_ticks", "mining_time", "name", "subgroup"}))
rcon.print("plant.minable " .. show(tree.minable or {}, {"mining_time", "results", "result"}))`));

console.log("=== a tower on the powered bench, fed seeds, watched through two growth cycles");
console.log(lua(`local s = game.surfaces["arch-lab"]
if not s then rcon.print("no arch-lab") return end
for _, e in ipairs(s.find_entities_filtered{name = "agricultural-tower"}) do e.destroy() end
local t = s.create_entity{name = "agricultural-tower", position = {x = 20.5, y = 20.5}, force = "player"}
if not t then rcon.print("create failed") return end
local rep = {}
for _, id in ipairs({"agricultural_tower_input", "agricultural_tower_output"}) do
  local ok, inv = pcall(function() return t.get_inventory(defines.inventory[id]) end)
  rep[#rep+1] = id .. "=" .. (ok and (inv and "ok" or "nil") or "RAISE")
end
local ok_i, inv = pcall(function() return t.get_inventory(defines.inventory.agricultural_tower_input) end)
local inserted = ok_i and inv and inv.insert{name = "yumako-seed", count = 50} or -1
rcon.print("placed unit=" .. t.unit_number .. " inserted=" .. tostring(inserted) .. " " .. table.concat(rep, " ")
  .. " | grid=" .. tostring((select(2, pcall(function() return t.electric_network_id end))))
  .. " | water_near=" .. tostring((select(2, pcall(function()
      for _, e in ipairs(s.find_entities_filtered{position = t.position, radius = 8, type = "water"}) do return true end
      return false end)))))
game.speed = 40`));

for (let i = 1; i <= 6; i++) {
  sleep(6000);
  console.log(lua(`local s = game.surfaces["arch-lab"]
local t = s.find_entities_filtered{name = "agricultural-tower"}[1]
if not t then rcon.print("tower gone") return end
local function how_many(inv_id, names)
  local ok, inv = pcall(function() return t.get_inventory(defines.inventory[inv_id]) end)
  if not ok or not inv then return "no-inventory" end
  local o = {}
  for _, n in ipairs(names) do
    local ok2, c = pcall(function() return inv.get_item_count(n) end)
    if ok2 and (c or 0) > 0 then o[#o+1] = n .. "x" .. tostring(c) end
  end
  return #o > 0 and table.concat(o, " ") or "empty"
end
local around = {}
for _, e in ipairs(s.find_entities_filtered{position = t.position, radius = 8}) do
  if e.unit_number ~= t.unit_number then
    local key = e.name .. "/" .. tostring(e.type)
    around[key] = (around[key] or 0) + 1
  end
end
local keys = {} for k in pairs(around) do keys[#keys+1] = k end table.sort(keys)
local st = {}
local ok_s, statuses = pcall(function() return t.status end)
if ok_s and type(statuses) == "table" then
  for k, v in pairs(statuses) do st[#st+1] = tostring(k) .. "=" .. tostring(v) end
  table.sort(st)
end
rcon.print("tick=" .. game.tick
  .. " in=[" .. how_many("agricultural_tower_input", {"yumako-seed"}) .. "]"
  .. " out=[" .. how_many("agricultural_tower_output", {"yumako", "yumako-seed"}) .. "]"
  .. " around=" .. (#keys > 0 and table.concat(keys, ",") or "nothing")
  .. " status=[" .. table.concat(st, " ") .. "]"
  .. " energy=" .. tostring((select(2, pcall(function() return t.energy end)))))`));
}

console.log(lua(`game.speed = 1
local s = game.surfaces["arch-lab"]
for _, e in ipairs(s.find_entities_filtered{position = {x = 20.5, y = 20.5}, radius = 12}) do
  if e.type ~= "resource" and e.name ~= "character" then e.destroy() end
end
rcon.print("cleaned the bench, speed back to " .. game.speed)`));
