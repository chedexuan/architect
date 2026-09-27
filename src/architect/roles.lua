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
--
-- Each of those sentences is written twice, and the two halves are the same sentence. `said(key, en,
-- params)` returns a node carrying the key the window renders in the player's language, the English a
-- designer greps over RCON, and -- filled from the two -- the flat line the `how` field still holds.
-- A node is itself a legal parameter, which is how "best __1__" wraps "supply_reach desc (measured)"
-- without either language having to know the other's word order.
--
-- `dev/locale_check.js` fails the build when an `en` template here and the locale row for the same key
-- stop being the same sentence, because that is the one way this duplication goes wrong quietly.

-- `__N__` is filled by the Nth parameter; a parameter that is a sentence contributes its own English
-- instead of tables printing at the end of a string.
local function fill(template, params)
  local out, rest = "", template
  while true do
    local s, e, n = rest:find("__(%d+)__", 1, false)
    if not s then return out .. rest end
    local p = (params or {})[tonumber(n)]
    local word
    if p == nil then word = "nil"
    elseif type(p) == "table" then word = tostring(rawget(p, "en") or "")
    else word = tostring(p) end
    out = out .. rest:sub(1, s - 1) .. word
    rest = rest:sub(e + 1)
  end
end

local function said(key, en, params)
  params = params or {}
  local flat, wired = {}, {}
  for i = 1, #params do
    local p = params[i]
    if type(p) == "table" and rawget(p, "key") then
      flat[i] = rawget(p, "en")
      -- One copy of each sentence: a nested node keeps its key and its own parameters, and leaves its
      -- English behind, so an answer over RCON does not carry the same line three times deep.
      wired[i] = { key = p.key, params = p.params }
    else
      flat[i] = p
      wired[i] = p
    end
  end
  return { key = key, en = fill(en, flat), params = wired }
end

-- The sentence behind a meta table, kept OUTSIDE it. A wrapper ("best __1__", "asked for X, __2__
-- instead") needs the sentence it is wrapping, and a fourth field on the answer is a field every caller
-- would have to know to strip. Weak-keyed because these tables die with their answers.
local NODES = setmetatable({}, { __mode = "k" })

-- Write one sentence into a meta table as both spellings. `params` are the node's own, so a caller that
-- serialises the answer gets the same positional list the locale row expects.
local function how_of(meta, node)
  meta.how = node.en
  meta.how_key = node.key
  meta.how_params = node.params
  NODES[meta] = node
  return meta
end
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
  -- Everything that runs a crafting recipe, which is what a lane needs when the recipe is not
  -- smelting. The type alone cannot answer that -- a centrifuge and an oil refinery are both
  -- `assembling-machine` -- so a caller that names a `category` gets the filter as well as the type.
  machine = { types = { "furnace", "assembling-machine", "rocket-silo" }, key = "crafting_speed",
              read = function(p) return getter(p, "get_crafting_speed") end },
  pole    = { types = { "electric-pole" }, key = "supply_reach", measured = true },
  -- the one entity type that only ever *makes* power; `supply_menu` in control.lua ranks real
  -- generators by their read figures, and this exists so a bare "put something on this island"
  -- fallback does not have to name a vanilla entity
  solar   = { types = { "solar-panel" }, key = nil },
}

-- The candidate set: an entity of one of the role's types that a player can actually place
-- (`items_to_place_this`), and that the force has unlocked when a checker was passed in.
--
-- The walk itself is remembered per kind. It goes over every entity prototype on the install --
-- thousands -- and the panel asks for four roles every time it rebuilds, which is every click. What it
-- finds depends on nothing that can change while the game runs: prototypes are immutable, and a mod
-- added or removed reloads this file, which drops the cache exactly when an old answer would be wrong.
-- The force's unlock layer is the only per-call part, so that is what gets recomputed.
local WALKED = {}

local function walk(kind, spec)
  if WALKED[kind] then return WALKED[kind] end
  local want = {}
  for _, t in ipairs(spec.types) do want[t] = true end
  local found = {}
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
        local cats
        local cc = host.field(p, "crafting_categories")
        if cc then
          cats = {}
          pcall(function() for k, v in pairs(cc) do if v then cats[k] = true end end end)
        end
        found[#found + 1] = { name = name, kind = kind_of, place_item = place_item, categories = cats }
      end
    end
  end
  table.sort(found, function(a, b) return a.name < b.name end)
  WALKED[kind] = found
  return found
end

function roles.candidates(kind, opts)
  opts = opts or {}
  local spec = roles.KINDS[kind]
  if not spec then return nil, "UNKNOWN_ROLE" end
  local out = {}
  for _, e in ipairs(walk(kind, spec)) do
    -- Which recipes a machine may run is data, and for a lane it is the difference between "an
    -- assembling machine" and "the assembling machine that makes this". `oil-refinery`,
    -- `chemical-plant` and `centrifuge` are all `assembling-machine` to the engine, so the category is
    -- the only thing that tells them apart.
    if not opts.category or (e.categories and e.categories[opts.category]) then
      local unlocked = true
      if opts.available then unlocked = opts.available(e.name) ~= false end
      out[#out + 1] = { name = e.name, kind = e.kind, place_item = e.place_item, unlocked = unlocked }
    end
  end
  return out, spec
end

-- Is this a real entity on this install at all? A name that came from a caller has to be answered
-- before it reaches `create_entity`, whose "Unknown entity name" raise arrives from inside a placement
-- and reads like a bug in the planner rather than a bad argument. Indexing `prototypes.entity` with a
-- key that is not there answers nil rather than raising (measured: `prototypes.entity[name]` with
-- a name this install does not have returns nil, while reading an unknown *member* off a
-- prototype is what raises). The pcall is kept as cheap insurance against a build that changes
-- it, not because this one needs it.
function roles.exists(name)
  if type(name) ~= "string" then return false end
  local ok, p = pcall(function() return prototypes.entity[name] end)
  return ok and p ~= nil
end

-- The placeable names for a role, in name order: what a refusal lists when a caller's name is not
-- among them.
function roles.names(kind)
  local out = {}
  for _, e in ipairs(roles.candidates(kind) or {}) do out[#out + 1] = e.name end
  return out
end

-- Ordered candidates. `opts.order` = "asc" asks for the smallest figure first, which is what the pole
-- ladder wants (try the cheapest reach that might work, escalate when it does not).
function roles.ladder(kind, opts)
  opts = opts or {}
  local list, spec = roles.candidates(kind, opts)
  if not list then return nil, spec end
  if #list == 0 then
    return {}, how_of({ kind = kind, types = spec.types }, said("rh-unplaceable",
      "no candidate of this type is placeable by this force"))
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
      -- A raise and a nil answer look identical from here, and that is how a ladder of four poles
      -- became "one pole measured, three did not" while still producing a green plan. Keep the error
      -- so the caller can say *why* a candidate has no figure.
      if not ok then entry.figure_error = tostring(v):gsub("[\r\n]+", " "):sub(1, 160) end
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
      how = said("rh-name-order-proto", "name order: __1__ is not readable from the prototype and was not measured",
        { spec.key })
    else
      how = said("rh-name-order-kind", "name order: __1__ has no readable figure on a runtime prototype",
        { kind })
    end
  elseif missing > 0 then
    -- a half-ranked menu is worse than an unranked one, because it looks like a decision: the ones
    -- with no figure go last and the answer says so
    how = said("rh-partial", "__1__ desc where it could be read, __2__ candidate(s) had none",
      { spec.key, missing })
  else
    -- Spelled as two calls rather than one `and`-chain over the key: the key is what locale_check
    -- matches a locale row against, and a key built inside an expression is a row it cannot prove.
    local order = opts.order == "asc" and said("rh-asc", "asc") or said("rh-desc", "desc")
    local source = spec.read and said("rh-from-prototype", "read from the prototype")
      or said("rh-measured", "measured")
    how = said("rh-ranked", "__1__ __2__ (__3__)", { spec.key, order, source })
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
  return list, how_of({ kind = kind, figure_key = spec.key, types = spec.types }, how)
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

  -- The reasons a named candidate is not one. `requested_reason` on the answer stays the flat English a
  -- designer reads; the window takes the key off the node, which is why both come from this one call.
  local function is_candidate(name)
    local p = prototypes.entity[name]
    if not p then return nil, said("rh-not-entity", "not an entity on this install") end
    local want
    for _, t in ipairs(spec.types) do if host.field(p, "type") == t then want = t end end
    if not want then
      return nil, said("rh-wrong-type", "its type is __1__, not one of __2__",
        { tostring(host.field(p, "type")), table.concat(spec.types, "/") })
    end
    local place = host.field(p, "items_to_place_this")
    if not (place and place[1]) then return nil, said("rh-not-placeable", "nothing places it") end
    if opts.category then
      local cc = host.field(p, "crafting_categories")
      local runs
      pcall(function() runs = cc and cc[opts.category] and true or false end)
      if not runs then
        return nil, said("rh-no-category", "it cannot run the __1__ category", { tostring(opts.category) })
      end
    end
    if opts.available and opts.available(name) == false then
      return nil, said("rh-locked", "this force has not unlocked it")
    end
    return true
  end

  if opts.prefer then
    local ok1, why = is_candidate(opts.prefer)
    if ok1 then
      -- the hint hit: still show the menu it chose from (an enumeration is cheap), but with no
      -- figures, because nothing needed measuring. A caller reading only `candidates` must be able to
      -- tell "these exist and were not ranked" from "these were ranked and this one won".
      local menu = roles.candidates(kind, opts) or {}
      return opts.prefer, how_of({ kind = kind, figure_key = spec.key, types = spec.types,
        ranked = false, candidates = menu },
        said("rh-preferred", "preferred name, and it is placeable here")), { name = opts.prefer }
    end
    -- fall through to the data order, and say what was replaced
    local name, meta = roles._ladder_pick(kind, opts)
    if meta then
      meta.requested_absent = opts.prefer
      meta.requested_reason = why and why.en
      if name then
        how_of(meta, said("rh-asked-other", "asked for __1__ (__2__); __3__ instead",
          { opts.prefer, why, NODES[meta] }))
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
    how_of(meta, said("rh-nothing-unlocked", "__1__; nothing in it is unlocked", { NODES[meta] }))
    return nil, meta
  end
  how_of(meta, said("rh-best", "best __1__", { NODES[meta] }))
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
-- Every entity this install can place that takes `category` out of the ground. One predicate for
-- the whole mod, because there were two: the rigs asked this and refused an unknown category, while
-- the solver's own copy matched an unknown category against EVERY drill -- so an ore whose category
-- could not be read was plannable by one caller and unminable by another.
function roles.drills_for(category, opts)
  opts = opts or {}
  if not category then return nil, { error = "NO_CATEGORY" } end
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
        seen[#seen + 1] = { name = name, speed = speed, unlocked = unlocked }
      end
    end
  end
  table.sort(seen, function(a, b) return a.name < b.name end)
  return seen
end

function roles.miner_for(category, opts)
  opts = opts or {}
  local seen, err = roles.drills_for(category, opts)
  if not seen then return nil, err end
  local best, best_speed
  for _, e in ipairs(seen) do
    if e.unlocked and (not best or e.speed > best_speed) then best, best_speed = e.name, e.speed end
  end
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
