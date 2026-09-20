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

return host
