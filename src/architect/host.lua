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

-- Factorio's Lua sandbox has no `utf8` library -- measured: `utf8.offset` raises "attempt to index
-- global 'utf8' (a nil value)" -- so a character boundary is found by hand. A byte below 0x80 is its
-- own character; 0xC0 and above starts one; 0x80-0xBF continues the one before it. Cutting in the
-- middle of a sequence is what showed a broken glyph in the panel where a card's name should be, and
-- a chat line built by `sub(1, n)` has the same problem, which is why the scan lives here rather than
-- in whichever file noticed it first.
function host.clip(s, n)
  s = tostring(s or "")
  local i, seen = 1, 0
  while i <= #s do
    local b = s:byte(i)
    if b < 0x80 or b >= 0xC0 then
      if seen == n then break end
      seen = seen + 1
    end
    i = i + 1
  end
  return s:sub(1, i - 1)
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

-- A list argument, checked before anything indexes it. `ipairs(x or {})` is not a guard: a caller
-- sending a string or a number has a length, sails past the emptiness test, and raises inside
-- `ipairs` -- which the dispatcher reports as RUNTIME_ERROR, a message about this mod's plumbing
-- rather than about the caller's argument. Refusing by name is the same answer `parse_area` gives.
function host.list_arg(v)
  if v == nil then return {} end
  if type(v) ~= "table" then return nil, type(v) end
  return v, nil
end

-- Whether an entity is a LOAD on the grid, decided from what this install reports rather than from
-- a list of type names. The list this replaces carried 1.1 types that no longer exist as types
-- (`chemical-plant`, `oil-refinery`, `centrifuge`, `provider`, `smokestack`,
-- `electric-energy-distribution-1/2` -- the last two being 1.1's name for *poles*), and missed
-- `rocket-silo`, `beacon`, `radar`, `roboport` and the turrets, so a card with a silo reported no
-- grid demand for a machine that draws power, and a plan sized to match under-provisioned it.
--
-- Measured on 2.0.77, per prototype: `electric_energy_source_prototype` is set for solar-panel,
-- accumulator, rocket-silo, radar, assembling-machine, lab, mining-drill, pump, burner-generator,
-- inserter and beacon, and absent for poles, belts, pipes, tanks, boiler and offshore-pump. Since a
-- source is not by itself a load, `get_max_energy_usage` has to be positive and
-- `get_max_energy_production` zero: that keeps a panel (use 0), an accumulator and a
-- burner-generator (both report production) on the supply side instead of the demand side.
function host.is_grid_load(proto)
  if not proto then return false end
  if host.field(proto, "electric_energy_source_prototype") == nil then return false end
  local ok_use, use = pcall(function() return proto.get_max_energy_usage() end)
  if not ok_use or type(use) ~= "number" or use <= 0 then return false end
  local ok_out, out = pcall(function() return proto.get_max_energy_production() end)
  if ok_out and type(out) == "number" and out > 0 then return false end
  return true
end

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

-- Space Age's other half of `enabled`: a recipe or an entity can be unlocked, researchable, affordable
-- and still impossible WHERE YOU ARE. 36 of the 659 recipes on this install and 51 of its 1016
-- entities carry `surface_conditions`, and among the recipes is `big-mining-drill` -- so a plan that
-- never reads them sizes a factory on drill frames the planet will not let anybody build, and says
-- nothing. This is the reading side; the judgement is `host.condition_miss`.
--
-- Normalised to `{property = <string>, min = <number?>, max = <number?>}` because the engine's own
-- entries are one-sided (`min` alone means "at least"), and an absent bound is not zero: reading a
-- missing `min` as 0 would turn "any pressure above 100" into "exactly 100 or below".
function host.surface_conditions(prototype)
  local raw = prototype and host.field(prototype, "surface_conditions")
  if type(raw) ~= "table" then return nil end
  local out = {}
  for _, c in ipairs(raw) do
    out[#out + 1] = {
      property = host.field(c, "property"),
      min = host.field(c, "min"),
      max = host.field(c, "max"),
    }
  end
  return #out > 0 and out or nil
end

-- What a surface answers for each property it has. The names come from `prototypes.surface_property`
-- (five on this install: pressure, gravity, magnetic-field, day-night-cycle, solar-power) rather than
-- from a list in this file, because a property the install does not have must read as ABSENT and not
-- as zero -- `get_property` raises for an unknown name, and `temperature` is not a surface property
-- here at all even though other packs write it into their recipe conditions.
function host.surface_values(surface)
  if not surface then return nil end
  local out = {}
  for name in pairs(prototypes.surface_property or {}) do
    local ok, v = pcall(function() return surface.get_property(name) end)
    if ok and type(v) == "number" then out[name] = v end
  end
  return out
end

-- The first condition a surface fails, or nil when it satisfies all of them. The failure is returned
-- WITH the number the surface gave, because "too dry" is not actionable and "wants pressure 4000, this
-- surface is 1000" is -- and because a caller shown both numbers can check the claim against the game's
-- own tooltip rather than trusting this mod.
function host.condition_miss(conditions, values)
  if type(conditions) ~= "table" then return nil end
  for _, c in ipairs(conditions) do
    local have = (type(values) == "table") and values[c.property] or nil
    if have == nil then
      return { property = c.property, need_min = c.min, need_max = c.max,
        why = "this surface does not answer " .. tostring(c.property) }
    end
    if (c.min ~= nil and have < c.min) or (c.max ~= nil and have > c.max) then
      return { property = c.property, need_min = c.min, need_max = c.max, here = have }
    end
  end
  return nil
end

return host
