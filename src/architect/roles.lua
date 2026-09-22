-- Which part fills a role, decided from the engine's own categories instead of a remembered list of
-- vanilla names.
--
-- The debt this closes: the mod used to keep ladders like
-- `{ "stack-inserter", "long-handed-inserter", "filter-inserter", "inserter", "burner-inserter" }`
-- and `{ "small-electric-pole", "medium-electric-pole", ... }`. Two of those five names do not exist
-- in 2.0 at all (`filter-inserter` and `chest` are not entities here -- the inserter family is
-- burner/inserter/fast/long-handed/stack/bulk, measured from `prototypes.entity`), and on a modpack
-- where steel-chest or small-electric-pole is absent every one of those ladders silently offered a
-- part the player cannot place.
--
-- What is actually readable off a runtime prototype was measured, not assumed:
--   belt      `belt_speed` answers (0.03125 / 0.0625 / 0.125 ...); `speed` is nil
--   furnace   `get_crafting_speed()` answers
--   arm       `inserter_length`, `inserter_stack_size_override`, `entity_flags` all RAISE; only
--             rotation/extension speeds read, and neither is the thing a lane needs -- reach is,
--             which is why `arm` takes a measured figure from the caller
--   pole      `supply_area` raises, `connection_distance` is nil, so reach only comes from measuring
--   chest     no capacity field is readable at all, so there is no honest figure to rank by
--
-- Ranking rules, in the order they are tried:
--   1. `opts.prefer` -- a name the caller asked for (an argument, or a documented vanilla default).
--      It wins only if it is really a candidate here: placeable by the force and, when `available`
--      is given, unlocked. This is what keeps a vanilla save picking the same parts it always did.
--   2. a figure -- read from the prototype, or measured through `opts.measure_of`. Every candidate
--      needs one for this to mean anything; ties keep name order so the result is deterministic.
--   3. name order, and `how` says the figure was not readable rather than pretending it was ranked.
--
-- `how` travels with every answer for the same reason `ports.lookup` reports it: a caller must be
-- able to tell "derived from data" from "the name you gave me".
local host = require("host")

local roles = {}

local function getter(t, name, ...)
  local fn = host.field(t, name)
  if type(fn) ~= "function" then return nil end
  local ok, v = pcall(fn, ...)
  if not ok then return nil end
  return v
end

-- Engine `type` values, not entity names. A mod's inserter-shaped machine joins `arm` by being an
-- `inserter`, which is the whole point.
roles.KINDS = {
  arm     = { types = { "inserter" }, key = "reach", measured = true },
  belt    = { types = { "transport-belt" }, key = "belt_speed",
              read = function(p) return host.field(p, "belt_speed") end },
  chest   = { types = { "container" }, key = nil },
  furnace = { types = { "furnace" }, key = "crafting_speed",
              read = function(p) return getter(p, "get_crafting_speed") end },
  pole    = { types = { "electric-pole" }, key = "supply_reach", measured = true },
  -- the one entity type that only ever *makes* power; `supply_menu` in control.lua ranks real
  -- generators by their read figures, and this exists so a bare "put something on this island"
  -- fallback does not have to name a vanilla entity
  solar   = { types = { "solar-panel" }, key = nil },
}

-- The candidate set: an entity of one of the role's types that a player can actually place
-- (`items_to_place_this`), and that the force has unlocked when a checker was passed in.
function roles.candidates(kind, opts)
  opts = opts or {}
  local spec = roles.KINDS[kind]
  if not spec then return nil, "UNKNOWN_ROLE" end
  local want = {}
  for _, t in ipairs(spec.types) do want[t] = true end
  local out = {}
  for name, p in pairs(prototypes.entity) do
    local kind_of = host.field(p, "type")
    if kind_of and want[kind_of] then
      local place = host.field(p, "items_to_place_this")
      local place_item = place and place[1] and host.field(place[1], "name")
      -- A place item is not enough: the creative-only ones (`bottomless-chest`,
      -- `electric-energy-interface`) have items and no recipe, and offering either to a plan is worse
      -- than offering nothing -- the interface in particular reports 5 GW of "supply" and a 10 GJ
      -- "battery", which is how a data-driven power menu briefly replaced every accumulator with a
      -- cheat entity. So: craftable means a recipe exists, and unlocked is the force's layer on top.
      local craftable = false
      if place_item then
        local ok, r = pcall(function() return prototypes.recipe[place_item] ~= nil end)
        craftable = ok and r
      end
      if craftable then
        local ok = true
        if opts.available then
          local av = opts.available(name)
          ok = av ~= false
        end
        out[#out + 1] = { name = name, kind = kind_of, place_item = place_item, unlocked = ok }
      end
    end
  end
  table.sort(out, function(a, b) return a.name < b.name end)
  return out, spec
end

-- Ordered candidates. `opts.order` = "asc" asks for the smallest figure first, which is what the pole
-- ladder wants (try the cheapest reach that might work, escalate when it does not).
function roles.ladder(kind, opts)
  opts = opts or {}
  local list, spec = roles.candidates(kind, opts)
  if not list then return nil, spec end
  if #list == 0 then
    return {}, { kind = kind, how = "no candidate of this type is placeable by this force", types = spec.types }
  end

  local figure_of = function(entry)
    if not spec.key then return nil end
    if spec.read then
      local p = prototypes.entity[entry.name]
      return p and spec.read(p) or nil
    end
    if spec.measured then
      if not opts.measure_of then return nil end
      local ok, v = pcall(opts.measure_of, entry.name)
      return ok and v or nil
    end
    return nil
  end

  local missing = 0
  for _, e in ipairs(list) do
    e.figure = figure_of(e)
    if e.figure == nil then missing = missing + 1 end
  end

  local how
  if missing == #list then
    if spec.measured then
      how = "name order: " .. spec.key .. " is not readable from the prototype and was not measured"
    else
      how = "name order: " .. kind .. " has no readable figure on a runtime prototype"
    end
  elseif missing > 0 then
    -- a half-ranked menu is worse than an unranked one, because it looks like a decision: the ones
    -- with no figure go last and the answer says so
    how = spec.key .. " desc where it could be read, " .. missing .. " candidate(s) had none"
  else
    how = spec.key .. (opts.order == "asc" and " asc" or " desc")
      .. (spec.read and " (read from the prototype)" or " (measured)")
  end

  table.sort(list, function(a, b)
    local av, bv = a.figure, b.figure
    if av == nil and bv == nil then return a.name < b.name end
    if av == nil then return false end
    if bv == nil then return true end
    if av == bv then return a.name < b.name end
    if opts.order == "asc" then return av < bv end
    return av > bv
  end)
  return list, { kind = kind, how = how, figure_key = spec.key, types = spec.types }
end

-- One name to use, plus the facts about how it was chosen. `nil` with the ladder attached is the
-- honest answer when nothing in this role can be built -- a caller must not fall back to a remembered
-- vanilla name in that case, because that is the bug this module exists to remove.
--
-- A hint that hits costs nothing: the candidate is checked against the prototypes and returned before
-- any figure is read or measured. Without that, every vanilla call to `pick("pole")` would measure all
-- four poles to rank a choice that was already settled by the name the caller asked for.
function roles.pick(kind, opts)
  opts = opts or {}
  local spec = roles.KINDS[kind]
  if not spec then return nil, { kind = kind, error = "UNKNOWN_ROLE" } end

  local function is_candidate(name)
    local p = prototypes.entity[name]
    if not p then return nil, "not an entity on this install" end
    local want
    for _, t in ipairs(spec.types) do if host.field(p, "type") == t then want = t end end
    if not want then return nil, "its type is " .. tostring(host.field(p, "type")) .. ", not one of " .. table.concat(spec.types, "/") end
    local place = host.field(p, "items_to_place_this")
    if not (place and place[1]) then return nil, "nothing places it" end
    if opts.available and opts.available(name) == false then return nil, "this force has not unlocked it" end
    return true
  end

  if opts.prefer then
    local why
    if is_candidate(opts.prefer) then
      return opts.prefer, { kind = kind, how = "preferred name, and it is placeable here",
                            figure_key = spec.key, types = spec.types }, { name = opts.prefer }
    end
    local ok2, why2 = is_candidate(opts.prefer)
    why = (not ok2) and why2 or nil
    -- fall through to the data order, and say what was replaced
    local name, meta = roles._ladder_pick(kind, opts)
    if meta then
      meta.requested_absent = opts.prefer
      meta.requested_reason = why
      if name then
        meta.how = "asked for " .. opts.prefer .. " (" .. tostring(why) .. "); "
          .. tostring(meta.how) .. " instead"
      end
    end
    return name, meta
  end
  return roles._ladder_pick(kind, opts)
end

-- The ladder without a hint: rank what is here and take the winner.
function roles._ladder_pick(kind, opts)
  local list, meta = roles.ladder(kind, opts)
  if not list then return nil, { kind = kind, error = meta } end
  meta.candidates = list
  local usable = {}
  for _, e in ipairs(list) do if e.unlocked then usable[#usable + 1] = e end end
  if #usable == 0 then
    meta.how = tostring(meta.how) .. "; nothing in it is unlocked"
    return nil, meta
  end
  meta.how = "best " .. tostring(meta.how)
  return usable[1].name, meta, usable[1]
end

-- The engine types this mod knows how to reason about, for the same reason `unclassified_crafters`
-- exists: a modded machine whose type is not in here is a fact the caller should hear, not a machine
-- that quietly disappears from a report.
roles.TYPES = {
  assembling_machine = "assembling-machine", furnace = "furnace", rocket_silo = "rocket-silo",
  mining_drill = "mining-drill", inserter = "inserter", transport_belt = "transport-belt",
  container = "container", electric_pole = "electric-pole", storage_tank = "storage-tank",
  pipe = "pipe", lab = "lab", boiler = "boiler",
}

-- Which miner goes on which ore: the fastest machine that is unlocked and whose `resource_categories`
-- covers the ore's category. The category match is the engine's own key -- a pumpjack is a
-- `mining-drill` whose categories are the set {basic-fluid=true}, while an ore carries
-- `resource_category` (singular) -- so this is set membership, not a name comparison. It lives here so
-- a measurement rig and a plan cannot drift into two different answers about the same ground.
function roles.miner_for(category, opts)
  opts = opts or {}
  if not category then return nil, { error = "NO_CATEGORY" } end
  local best, best_speed
  local seen = {}
  for name, p in pairs(prototypes.entity) do
    if host.field(p, "type") == "mining-drill" then
      local place = host.field(p, "items_to_place_this")
      local speed = host.field(p, "mining_speed")
      local cats = host.field(p, "resource_categories")
      local matches = false
      if cats then
        pcall(function() for k, v in pairs(cats) do if v and k == category then matches = true end end end)
      end
      if place and place[1] and speed and speed > 0 and matches then
        local unlocked = true
        if opts.available then unlocked = opts.available(name) ~= false end
        if unlocked and (not best or speed > best_speed) then best, best_speed = name, speed end
        seen[#seen + 1] = { name = name, speed = speed, unlocked = unlocked }
      end
    end
  end
  table.sort(seen, function(a, b) return a.name < b.name end)
  -- a hinted drill wins only if it can actually mine this category, which is the whole point: the
  -- hint says "prefer the cheap one", the category test says whether that is even a candidate here
  if opts.prefer then
    for _, e in ipairs(seen) do
      if e.name == opts.prefer and e.unlocked then
        return e.name, { category = category, picked = e.name, mining_speed = e.speed,
                         how = "preferred name, and it takes " .. category, candidates = seen }
      end
    end
  end
  return best, { category = category, picked = best, mining_speed = best_speed,
                 how = "fastest unlocked drill whose resource_categories cover " .. category,
                 candidates = seen,
                 requested_absent = opts.prefer and best ~= opts.prefer and opts.prefer or nil }
end

return roles
