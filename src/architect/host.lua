-- Leaf primitives shared between control.lua and the modules it requires.
--
-- A required module cannot see control.lua's locals, and control.lua is the file that requires
-- it, so anything used on both sides has to live somewhere that depends on neither.

local host = {}

-- Factorio userdata raises on unknown keys instead of returning nil, so every
-- prototype read goes through here; a missing field is normal across modpacks.
function host.field(t, key)
  local ok, v = pcall(function() return t[key] end)
  if not ok then return nil end
  return v
end

-- The getter answers in J/tick, not kW, while the prototype data states kW. Every power
-- figure this mod reported under a `_kw` name used to carry the raw J/tick number, so the
-- conversion belongs here and nowhere else.
local TICKS_PER_SECOND = 60
function host.kw_of(j_per_tick)
  if type(j_per_tick) ~= "number" then return 0 end
  return math.floor(j_per_tick * TICKS_PER_SECOND / 100 + 0.5) / 10 -- J/tick -> W -> kW
end

-- The failure shape every method returns. A caller reads `ok` and nothing else, so a
-- rejection has to say which rule refused it, not just that one did.
function host.fail(code, msg, detail)
  local t = { fail = true, code = code, msg = msg }
  if detail then t.detail = detail end
  return t
end

-- The engine's own machine categories, spelled once. These are `type` values, not lists of vanilla
-- entities, so a mod's machine whose type is `furnace` is covered without anything being added here.
--
-- They live in one place because two files kept separate copies and card.lua's had silently dropped
-- lab, reactor and boiler: a card with an unfed lab passed lint while the rig starved it.
host.CRAFTER_KINDS = {
  -- Read from this install, not remembered: `get_crafting_speed` answers for exactly these types
  -- (plus `character`, which is the player's hand and is excluded where the sets are consumed).
  -- `oil-refinery`, `chemical-plant` and `centrifuge` are NOT types -- all three are
  -- `assembling-machine` with a distinctive `crafting_categories`, which is why they are absent here.
  ["assembling-machine"] = true, ["furnace"] = true, ["rocket-silo"] = true,
}
-- kinds that receive or hand over items, i.e. the ones an inserter has to be able to reach. A mining
-- drill crafts nothing and still dumps items; a boiler's fuel arrives by arm; a lab takes items too.
host.HANDLED_KINDS = {
  ["assembling-machine"] = true, ["furnace"] = true, ["rocket-silo"] = true, ["mining-drill"] = true,
  ["lab"] = true, ["boiler"] = true, ["reactor"] = true, ["burner-generator"] = true,
}

-- A surface may be named, indexed, or left out; leaving it out means the one the player is on.
function host.resolve_surface(spec)
  if spec == nil then return game.surfaces[1] end
  if type(spec) == "number" then return game.surfaces[spec] end
  return game.surfaces[spec]
end

-- "Not named" and "named wrong" are two different answers, and `x and resolve_surface(x) or
-- game.surfaces[1]` collapses them: a spec that names a surface this save does not have resolves to
-- nil, the `or` swallows it, and the method measures the player's main surface while reporting
-- success. Four methods did exactly that, which also made their own `NO_SURFACE` branches
-- unreachable -- a code no caller could trigger is a code that was never tested.
function host.surface_or_default(spec)
  if spec == nil then return game.surfaces[1] end
  return host.resolve_surface(spec)
end

-- Read from the prototype rather than remembered: a tank's capacity is the ceiling on every
-- fluid measurement this mod makes, and the number that ends a window early has to be the one
-- this install actually uses.
function host.tank_capacity()
  local p = prototypes.entity["storage-tank"]
  local ok, cap = pcall(function() return p.fluid_capacity end)
  return (ok and cap and cap > 0) and cap or 25000
end

-- A whole machine, in the shape scripts can read it. `LuaEntity.fluidbox` is not indexable in
-- 2.0 (`#fluidbox` is 0 and `[1]` is nil), so `get_fluid_contents` is the only way to ask what a
-- box holds. It answers keyed by index with either numbers or {amount=} records depending on the
-- build, and the name lives in the key on some paths and the record on others; both are folded
-- into one flat map here, because every caller only wants "how much of X".
function host.entity_fluids(entity, named)
  local out = {}
  if not entity or not entity.valid then return out end
  local ok, contents = pcall(function() return entity.get_fluid_contents() end)
  if not ok or type(contents) ~= "table" then return out end
  for key, value in pairs(contents) do
    local name = (type(key) == "string") and key or nil
    local amount = 0
    if type(value) == "number" then
      amount = value
    elseif type(value) == "table" then
      amount = value.amount or 0
      name = name or value.name or (type(key) == "table" and key.name)
    end
    if name and (not named or name == named) then
      out[name] = (out[name] or 0) + amount
    end
  end
  return out
end

-- total units, optionally of one named fluid only
function host.fluid_in_tank(tank, named)
  local total = 0
  for name, amount in pairs(host.entity_fluids(tank)) do
    if not named or name == named then total = total + amount end
  end
  return total
end

return host
