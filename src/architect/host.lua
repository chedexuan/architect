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

-- A surface may be named, indexed, or left out; leaving it out means the one the player is on.
function host.resolve_surface(spec)
  if spec == nil then return game.surfaces[1] end
  if type(spec) == "number" then return game.surfaces[spec] end
  return game.surfaces[spec]
end

-- What a storage tank holds, read the way the engine returns it: `get_fluid_contents` yields
-- either fluid-name keys with numbers, or prototypes with amounts, depending on the build, and a
-- measurement that silently reads zero from the wrong shape is worse than no measurement.
function host.fluid_in_tank(tank, named)
  local held = 0
  if not tank or not tank.valid then return 0 end
  pcall(function()
    for k, v in pairs(tank.get_fluid_contents() or {}) do
      local nm = (type(k) == "table") and k.name or k
      if not named or nm == named then held = held + ((type(v) == "number") and v or (v.amount or 0)) end
    end
  end)
  return held
end

-- Read from the prototype rather than remembered: a tank's capacity is the ceiling on every
-- fluid measurement this mod makes, and the number that ends a window early has to be the one
-- this install actually uses.
function host.tank_capacity()
  local p = prototypes.entity["storage-tank"]
  local ok, cap = pcall(function() return p.fluid_capacity end)
  return (ok and cap and cap > 0) and cap or 25000
end

return host
