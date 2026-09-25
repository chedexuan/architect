local MOD_VERSION = "0.52.0"

-- What this process's startup steps report, kept out of `storage` on purpose: Factorio CRC-checks
-- the mod's storage across `on_load` and refuses to boot a server whose mod wrote to it there
-- ("not save/load stable and not multiplayer safe"). A load-time fact is also not a save fact -- it
-- has to be re-established every boot, which is exactly what makes it worth recording.
local boot = {}

local rat = require("rat")
local solve = require("solve")
local card = require("card")
local verify = require("verify")
local compose = require("compose")
local region = require("region")
local powers = require("power")
local gui = require("gui")
local host = require("host")
local roles = require("roles")
local measure = require("measure")
local fluidrig = require("fluidrig")
local boxes = require("boxes")
local seams = require("seams")
local fields = require("fields")
local ports = require("ports")

-- The shared primitives keep their old local names: every call site in this file reads them, and
-- `host.field(...)` everywhere would bury the data those calls are about.
local field = host.field
local fail = host.fail
local kw_of = host.kw_of
local resolve_surface = host.resolve_surface
local surface_or_default = host.surface_or_default

local M = {}

local lane_units              -- defined below; card_example needs it from above
local availability_checker    -- defined below; card_example needs it from above
local inserter_reach          -- defined below; card_example needs it from above
local bus_line                -- defined below; bus_example needs it from above
local lane_of                 -- ditto: the capacity a belt row declares

-- A lab job's live entity handles live INSIDE the job record (`storage.lab.ents` / `.rig`), not in a
-- module-level cache. They have to travel with the save: a process that loads the game -- a client
-- joining an in-progress server, or this server after a restart -- would otherwise find a job marked
-- `running` with no handles anywhere and write an abandonment the process that started it never
-- writes. Two machines, one save, two mod states: a multiplayer desync, invisible to every
-- single-process test. Putting them in storage is also the only legal place, because the engine
-- CRCs `storage` around `on_load` and refuses to start a game over a mod that changes it there -- so
-- a table rebound into storage at load time is itself the bug it was meant to fix.

-- defines.direction is 16-stepped: north=0, east=4, south=8, west=12.
-- Never write raw 0/2/4/6 for cardinals.
local DIR = {
  north = defines.direction.north,
  east = defines.direction.east,
  south = defines.direction.south,
  west = defines.direction.west,
}

local function getter(t, name, ...)
  local fn = field(t, name)
  if type(fn) ~= "function" then return nil end
  local ok, v = pcall(fn, ...)
  if not ok then return nil end
  return v
end

-- Runtime bounding boxes are {left_top={x,y}, right_bottom={x,y}}; data stage uses {{x,y},{x,y}}.
local function box_size(box)
  if not box then return nil, nil end
  local a, b = box.left_top or box[1], box.right_bottom or box[2]
  if not a or not b then return nil, nil end
  local ax, ay = a.x or a[1], a.y or a[2]
  local bx, by = b.x or b[1], b.y or b[2]
  if not (ax and ay and bx and by) then return nil, nil end
  return bx - ax, by - ay
end

local function keys_of(dict, limit)
  local out, n = {}, 0
  local ok = pcall(function()
    for k in pairs(dict) do
      n = n + 1
      if not limit or n <= limit then out[n] = k end
    end
  end)
  if not ok then return nil end
  if limit and n > limit then out.__count = n end
  return out
end

-- ============================================================
-- Physical model: distilled from prototypes, never hardcoded
-- ============================================================

local model_cache = nil

local function place_item_of(p)
  local list = field(p, "items_to_place_this")
  if not list then return nil end
  local first = list[1]
  if type(first) == "table" then return first.name end
  return first
end

-- 2.0 exposes the draw through a getter; the `energy_usage` attribute is nil for inserters and
-- belts, so reading only the attribute silently drops a large share of a card's demand -- a stack
-- inserter costs more than an assembler.
local function draw_kw_of(p)
  if not p then return 0 end
  local v = getter(p, "get_max_energy_usage")
  if v == nil then v = field(p, "energy_usage") end
  -- The energy interface reports math.huge; anything unbounded is a supply, not a draw.
  if type(v) ~= "number" or not (v >= 0) or v > 1e9 then return 0 end
  return kw_of(v)
end

local function energy_of(p)
  local emissions = 0
  local e = field(p, "emissions_per_second")
  if type(e) == "number" then
    emissions = e
  elseif type(e) == "table" then
    -- 2.0 splits emissions per pollution type
    pcall(function() for _, v in pairs(e) do if type(v) == "number" then emissions = emissions + v end end end)
  end
  return draw_kw_of(p),
         field(p, "electric_energy_source_prototype") ~= nil,
         emissions
end

local function build_model()
  local machines, belts, inserters = {}, {}, {}

  for name, p in pairs(prototypes.entity) do
    local kind = field(p, "type")
    local speed = getter(p, "get_crafting_speed")
    if speed and host.CRAFTER_KINDS[kind] then
      local cats = {}
      local cc = field(p, "crafting_categories")
      if cc then pcall(function() for k, v in pairs(cc) do if v then cats[#cats + 1] = k end end end) end
      local bw, bh = box_size(field(p, "collision_box"))
      local eu, og, em = energy_of(p)
      machines[name] = {
        kind = kind,
        speed = speed,
        categories = cats,
        w = bw,
        h = bh,
        module_slots = field(p, "module_inventory_size"),
        energy = field(p, "energy_usage"),
        place_item = place_item_of(p),
        energy_usage = eu,
        on_grid = og,
        emissions = em,
        hidden = field(p, "hidden") or false,
      }
    elseif kind == "mining-drill" then
      local bw, bh = box_size(field(p, "collision_box"))
      local rcats = {}
      local rc = field(p, "resource_categories")
      if rc then pcall(function() for k, v in pairs(rc) do if v then rcats[#rcats + 1] = tostring(k) end end end) end
      local eu, og, em = energy_of(p)
      machines[name] = {
        kind = "mining-drill",
        mining_speed = field(p, "mining_speed"),
        radius = getter(p, "get_mining_drill_radius"),
        w = bw,
        h = bh,
        energy = field(p, "energy_usage"),
        resource_categories = rcats,
        place_item = place_item_of(p),
        energy_usage = eu,
        on_grid = og,
        emissions = em,
        -- `mining_category` is not a member of anything in 2.0 (the first read was always nil); the
        -- categories a drill takes are `resource_categories`, which is what `roles.miner_for` matches.
        category = field(p, "resource_categories"),
        hidden = field(p, "hidden") or false,
      }
    elseif kind == "transport-belt" then
      local bs = field(p, "speed") or field(p, "belt_speed")
      if bs then
        belts[name] = { speed = bs, throughput_per_sec = bs * 8 * 60,
                      -- no `next`: 1.1's belt-stage field is not on a 2.0 runtime prototype
                      -- (reading it raises), so the key was a permanent blank in every answer.
                      place_item = place_item_of(p) }
      end
    elseif kind == "inserter" then
      local ieu, iog, iem = energy_of(p)
      inserters[name] = {
        rotation = getter(p, "get_inserter_rotation_speed"),
        extension = getter(p, "get_inserter_extension_speed"),
        -- no `stack_size` and no `length`: both raise on a runtime inserter prototype (measured:
        -- "LuaEntityPrototype doesn't contain key inserter_stack_size_override"), which is why an
        -- arm's reach is MEASURED off a live one rather than read -- see `inserter_reach`.
        place_item = place_item_of(p),
        energy_usage = ieu,
        on_grid = iog,
        emissions = iem,
        pickup_mask = keys_of(field(p, "pickup_position"), nil),
      }
    end
  end

  return { machines = machines, belts = belts, inserters = inserters }
end

local function model()
  if not model_cache then model_cache = build_model() end
  return model_cache
end

-- ============================================================
-- Recipe graph for the solver
-- ============================================================

-- Categories that can never be a production route, only a disposal or utility step.
--
-- This used to be a table naming `recycling`, and it caught 310 of the 311 disposal recipes on this
-- install. The one that got through was `scrap-recycling`, whose category is `recycling-or-hand-crafting`
-- -- a category whose whole purpose is to say "the recycler does this, and your hand does too". It
-- outputs 0.05 of an ice chunk, and the solver happily planned an ice line out of shredded turrets.
-- So the test is on the category name, which every recipe carries: 29 categories exist here and the 2
-- whose names contain `recycling` are both disposal. A modded pack that names a real production
-- category after recycling will lose it as a route, which is the safe direction to be wrong in: the
-- item then reports as unsourceable instead of being planned out of trash.
local function is_disposal_category(category)
  return category ~= nil and category:find("recycling", 1, true) ~= nil
end

local db_cache = nil

local function world_db()
  if db_cache then return db_cache end

  local machines = {}
  for name, v in pairs(model().machines) do
    machines[name] = {
      name = name, kind = v.kind, speed = v.speed, mining_speed = v.mining_speed,
      place_item = v.place_item,
      categories = v.categories, resource_categories = v.resource_categories,
      energy_usage = v.energy_usage, on_grid = v.on_grid, emissions = v.emissions,
      w = v.w, h = v.h, module_slots = v.module_slots,
    }
  end

  local recipes, producers = {}, {}
  for name, r in pairs(prototypes.recipe) do
    local energy = field(r, "energy")
    local raw_products = field(r, "products") or {}
    if energy and energy > 0 and #raw_products > 0 then
      local ing, pro = {}, {}
      for _, i in ipairs(field(r, "ingredients") or {}) do
        -- `type` is the whole reason a fluid can or cannot be planned: without it an ingredient
        -- record for water is indistinguishable from one for an iron plate, and every consumer
        -- downstream has to guess from the name. `capabilities` already carried it.
        ing[#ing + 1] = {
          name = i.name, amount = rat.from(i.amount or i.minimum or 1),
          type = i.type or (prototypes.fluid[i.name] and "fluid" or "item"),
        }
      end
      for _, p in ipairs(raw_products) do
        -- `always_affected_by_products_effects` used to filter the product OUT of the model.
        -- In vanilla 2.0 no product carries the flag, so it was dead code; the moment a
        -- modpack or a productivity plan meets one, the recipe would silently lose an output.
        if p.name then
          -- Expected yield is amount TIMES probability, not one or the other. 2.0's uranium
          -- enrichment writes {amount=1, probability=0.007}; reading `amount or probability`
          -- turned a 7:993 split into 1:1 and sized every centrifuge 143x too small.
          local amount = (p.amount or p.amount_min or 1) * (p.probability or 1)
          if p.amount == nil and (p.amount_min or p.amount_max) then
            amount = ((p.amount_min or 0) + (p.amount_max or 0)) / 2 * (p.probability or 1)
          end
          pro[#pro + 1] = {
            name = p.name, amount = rat.from(amount), probability = p.probability,
            type = p.type or (prototypes.fluid[p.name] and "fluid" or "item"),
            -- refining yields carry the temperature the fluid arrives at; dropping it is what
            -- makes hot/light water and 25C water look like the same thing to the planner
            temperature = p.temperature,
            module_affected = p.always_affected_by_products_effects or nil,
          }
        end
      end
      local ae = field(r, "allowed_effects")
      local recipe = {
        name = name, category = field(r, "category"), energy = rat.from(energy),
        ingredients = ing, products = pro,
        -- 2.0 gates productivity per recipe through `allowed_effects`; every vanilla recipe
        -- sampled says true, including smelting, which 1.1 refused. Measured on the game:
        -- two productivity modules on an electric furnace do raise plate output.
        allow_productivity = (ae == nil) or (ae.productivity ~= false),
        max_productivity = field(r, "maximum_productivity"),
        -- Where the recipe may be run at all. Read once and kept in the model with the rest of the
        -- recipe, because the alternative is a plan that counts machines the planet will not let work:
        -- `big-mining-drill` is unlocked, researchable and unbuildable on this nauvis (pressure 4000
        -- wanted, 1000 answered), and every drill-based rate in this mod leans on it.
        surface_conditions = host.surface_conditions(r),
        enabled = (function()
          local fr = game.forces.player.recipes[name]
          return fr and fr.enabled or false
        end)(),
      }
      recipes[name] = recipe
      -- Recycling turns trash into a by-product stream; treating it as a production
      -- route lets the planner "make" a processing unit by shredding artillery turrets.
      if not is_disposal_category(field(r, "category")) then
        for _, p in ipairs(pro) do
          local list = producers[p.name]
          if not list then list = {}; producers[p.name] = list end
          if not list[name] then
            list[name] = true
            list[#list + 1] = name
          end
        end
      end
    end
  end

  for item, list in pairs(producers) do
    local function rank(name)
      local r = recipes[name]
      local score = 0
      if name == item then score = score + 100 end          -- canonical recipe for the item
      if #r.products == 1 then score = score + 50 end       -- avoid by-product bookkeeping
      if r.enabled then score = score + 20 end
      if #r.ingredients == 0 then score = score - 30 end
      return score
    end
    table.sort(list, function(a, b)
      local ra, rb = rank(a), rank(b)
      if ra ~= rb then return ra > rb end
      return a < b
    end)
    local resolved = {}
    for _, n in ipairs(list) do resolved[#resolved + 1] = recipes[n] end
    producers[item] = resolved
  end

  -- A resource entity is a leaf: nothing may try to "craft" its item, otherwise
  -- recycling/crushing recipes that also output ore turn the graph into a cycle.
  local raw = {}
  for name, p in pairs(prototypes.entity) do
    if field(p, "type") == "resource" then
      -- An ore can demand a fluid before a drill will take it, and that is a production
      -- requirement, not a detail: uranium-ore wants sulfuric-acid. Read from the ore so the
      -- solver says so before anything is built.
      local mp = field(p, "mineable_properties")
      raw[name] = {
        category = field(p, "resource_category") or field(p, "category"),
        required_fluid = mp and field(mp, "required_fluid"),
        fluid_amount = mp and field(mp, "fluid_amount"),
        -- seconds of speed-1 drilling per unit. An ore that takes five times as long to break is
        -- mined five times as slowly by the same machine, so a nameplate without it is wrong by
        -- exactly that factor.
        mining_time = mp and field(mp, "mining_time"),
        -- What one broken "unit" of this ore turns into. For iron ore it is one item and the
        -- nameplate has been right for every ore measured so far; crude oil gives ten units of
        -- fluid per unit mined, so a nameplate that assumes one promises a fraction of what a
        -- pumpjack actually hands over.
        product = (function()
          local ps = mp and field(mp, "products")
          local first = ps and ps[1]
          if not first then return nil end
          local amount = field(first, "amount")
          if not amount then
            local lo, hi = field(first, "amount_min"), field(first, "amount_max")
            if lo and hi then
              amount = (lo + hi) / 2
            elseif lo then
              amount = lo
            end
          end
          local probability = field(first, "probability")
          return { name = field(first, "name"), type = field(first, "type"),
            units = (amount or 1) * (probability or 1) }
        end)(),
        infinite = field(p, "infinite_resource") or false,
      }
    end
  end
  -- Two of the twelve resource entities here are not named after what they give: `fluorine-vent`
  -- yields `fluorine` and `sulfuric-acid-geyser` yields `sulfuric-acid`. Every lookup in the solver
  -- goes by the item, so without the alias the graph says the fluid has no source at all -- which is
  -- worse than a wrong rate, because the plan refuses and sounds certain.
  local aliased = {}
  for name, r in pairs(raw) do
    r.entity = name
    local prod = r.product
    if prod and prod.name and prod.name ~= name then aliased[#aliased + 1] = { from = prod.name, to = name } end
  end
  for _, a in ipairs(aliased) do
    if not raw[a.from] then raw[a.from] = raw[a.to] end
  end

  -- Which technology would unlock a recipe. Reported to the designer as a
  -- prerequisite instead of silently planning with machines nobody can build.
  local tech_for_recipe = {}
  for tname, t in pairs(prototypes.technology) do
    for _, e in ipairs(field(t, "effects") or {}) do
      if e.type == "unlock-recipe" and e.recipe then
        local list = tech_for_recipe[e.recipe]
        if not list then list = {}; tech_for_recipe[e.recipe] = list end
        list[#list + 1] = tname
      end
    end
  end

  for name, r in pairs(recipes) do
    r.techs = tech_for_recipe[name]
  end

  for name, b in pairs(model().belts) do
    machines[name] = { name = name, kind = "transport-belt", belt_throughput = b.throughput_per_sec,
                       place_item = b.place_item }
  end
  local modules = {}
  for name, p in pairs(prototypes.item) do
    if field(p, "type") == "module" then
      local e = field(p, "module_effects")
      if e then
        -- the runtime hands back 0.30000001192093 for "30%"; rounding to 4 dp is what the
        -- player sees in the tooltip and keeps the derived machine counts from drifting
        local function r4(v) return type(v) == "number" and math.floor(v * 10000 + 0.5) / 10000 or nil end
        modules[name] = {
          speed = r4(field(e, "speed")), productivity = r4(field(e, "productivity")),
          consumption = r4(field(e, "consumption")), pollution = r4(field(e, "pollution")),
          -- no `limit` key at all. Which machines a module may be used in is data-stage on 2.0:
          -- `limitation_count` is not a runtime member and reading it raises (measured), so this
          -- line reported nil under a name that looked like a fact. The absence is stated in
          -- `coverage.not_modelled`, which is where a caller who cannot see it should read it.
        }
      end
    end
  end

  for name, v in pairs(model().inserters) do
    machines[name] = { name = name, kind = "inserter", rotation = v.rotation, extension = v.extension,
                       place_item = v.place_item }
  end

  local function apply_availability(list)
    for name, m in pairs(list) do
      if m.place_item then
        local producer = producers[m.place_item] and producers[m.place_item][1]
        m.unlock_recipe = producer and producer.name or nil
        m.techs = producer and tech_for_recipe[producer.name] or nil
        m.available = producer and producer.enabled or false
      else
        m.available = true
      end
      if m.hidden then m.available = false end
    end
  end
  apply_availability(machines)
  -- The same question asked of the ENTITY rather than of the item: an asteroid collector needs a
  -- vacuum under it (pressure 0) and no amount of research changes that. Placement asks the engine and
  -- gets a bare `false` back, so the reason is read from here when `why_not_there` has to say why a
  -- patch of clear ground still refuses the card.
  for name, m in pairs(machines) do
    m.surface_conditions = host.surface_conditions(prototypes.entity[name])
  end

  local default_miner, fastest, miners_by_category
  miners_by_category = {}
  for name, m in pairs(machines) do
    if m.kind == "mining-drill" and m.mining_speed and m.mining_speed > 0 and m.available ~= false then
      if not fastest or m.mining_speed > fastest then
        fastest, default_miner = m.mining_speed, name
      end
      for _, c in ipairs(m.resource_categories or {}) do
        local cur = miners_by_category[c]
        if not cur or m.mining_speed > cur.speed then
          miners_by_category[c] = { name = name, speed = m.mining_speed }
        end
      end
    end
  end

  db_cache = {
    recipes = recipes, producers = producers, machines = machines,
    raw = raw, default_miner = default_miner, miners_by_category = miners_by_category,
    modules = modules,
  }
  return db_cache
end

-- Prototype structure is cacheable; what a force has unlocked is not, so it is
-- refreshed against live force state on every query.
local function refresh_availability(db, force_name)
  local force = game.forces[force_name]
  if not force then return false end
  for name, r in pairs(db.recipes) do
    local fr = force.recipes[name]
    r.enabled = fr and fr.enabled or false
  end
  for _, m in pairs(db.machines) do
    if m.unlock_recipe then
      local fr = force.recipes[m.unlock_recipe]
      m.available = (fr and fr.enabled) or false
    else
      m.available = true
    end
  end
  return true
end

-- Everything the rigs have read back, in the one shape both the solver and the chain sizer want:
-- keyed "machine|resource", drills and pumps sharing the key space because they measure the same
-- question -- what one machine of this name takes out of this ore per minute.
local function measured_cache()
  local measured = {}
  for _, cache in ipairs({ storage and storage.drills or {}, storage and storage.pumps or {} }) do
    for key, record in pairs(cache) do measured[key] = record end
  end
  return measured
end

-- What the form can offer, read from this install rather than remembered. Items are the products of
-- recipes THIS FORCE has enabled -- a menu listing everything in the game invites a plan for something
-- the player cannot build, and the solver's NO_UNLOCKED_RECIPE would then be the panel surprising
-- them. Index 1 of machines and modules is a "no choice" row (empty value), so the widget's first row
-- and the method's `nil` mean the same thing.
-- The two rows that mean "no choice". They are locale keys rather than words in this file so a
-- Chinese client reads them in Chinese; the `value` stays the empty string the solver expects.
local MENU_ANY = { "architect.menu-any-unlocked" }
local MENU_NONE = { "architect.menu-none" }

local function panel_menus(force)
  local db = world_db()
  if force then refresh_availability(db, force.name) end
  local function sorted(t)
    local l = {}
    for k in pairs(t or {}) do l[#l + 1] = k end
    table.sort(l)
    return l
  end
  local items, seen = {}, {}
  for _, r in pairs(db.recipes or {}) do
    -- `== true`, not `~= false`: a force with no record of a recipe at all is a force that cannot make
    -- it, and reading that as enabled would put locked technology in the menu the player trusts.
    local live = force and force.recipes and force.recipes[r.name]
    if not force or (live and field(live, "enabled") == true) then
      for _, p in ipairs(r.products or {}) do
        if p.name and not seen[p.name] then
          seen[p.name] = true
          items[#items + 1] = { value = p.name, label = p.name,
            -- the name the player's own client shows for this item or fluid
            localised = host.localised(prototypes.item[p.name] or prototypes.fluid[p.name]) }
        end
      end
    end
  end
  table.sort(items, function(a, b) return a.value < b.value end)
  local machines = { { value = "", label = "any unlocked", localised = MENU_ANY } }
  -- `speed` and `categories` are what the machine model calls these fields; the first version of this
  -- line filtered on `crafting_speed`, which no entry has, so the menu offered five miners and no
  -- furnace -- a list too short to be wrong in any way the panel would notice. `place_item` is what
  -- makes an entry a thing a player could put down: without it the menu offered
  -- `captive-biter-spawner`, which has a crafting speed and cannot be built by anybody.
  for _, name in ipairs(sorted(db.machines)) do
    local m = db.machines[name]
    if m and m.place_item and ((tonumber(m.speed) or 0) > 0 or m.kind == "mining-drill"
      or #(m.categories or {}) > 0) then
      machines[#machines + 1] = { value = name, label = name, categories = m.categories,
        speed = m.speed, slots = m.module_slots,
        localised = host.localised(prototypes.entity[name]) }
    end
  end
  local modules = { { value = "", label = "none", localised = MENU_NONE } }
  for _, name in ipairs(sorted(db.modules)) do
    modules[#modules + 1] = { value = name, label = name,
      localised = host.localised(prototypes.item[name]) }
  end
  return { items = items, machines = machines, modules = modules,
    units = { { value = "per_second", label = "/second" }, { value = "per_minute", label = "/minute" },
      { value = "per_hour", label = "/hour" } },
    counts = { items = #items, machines = #machines, modules = #modules } }
end

-- The form's shape of the question. `solve` takes an exact request -- `want.rate_per_min`, `machines`
-- keyed by crafting category, `modules` as a list -- and a player thinks in "45 a second on the big
-- drill with two speed modules". Translating between those is deciding, so it lives here and not in
-- the widget file, and every way the form can be wrong answers by name.
--
-- One rule the translation does not bend: the unit is a display choice, and the number handed to the
-- solver is always per minute. Reading `rate_per_min` as "per whatever the caller meant" is the quiet
-- wrong answer; `unit_shown` is how the panel says it in the player's unit afterwards.
local UNITS = { per_second = 1, per_minute = 60, per_hour = 3600 }

function M.plan_form(args)
  args = args or {}
  local db = world_db()
  if not refresh_availability(db, args.force or "player") then
    return fail("NO_FORCE", tostring(args.force))
  end
  -- A drop-down answers with an index, so the form may send `item_index` instead of a name. Both are
  -- accepted and neither is guessed at: an index off the end of the menu is BAD_ARGS, a name the world
  -- model does not know is UNKNOWN_ITEM -- different mistakes, and a caller that got the second
  -- message for the first would go looking in the wrong place.
  local menus = panel_menus(game.forces[args.force or "player"])
  local picked = {}
  for field_name, menu_key in pairs({ item = "items", machine = "machines",
    module = "modules", unit = "units" }) do
    local idx = args[field_name .. "_index"]
    if idx ~= nil then
      local entry = menus[menu_key] and menus[menu_key][math.floor(tonumber(idx) or 0)]
      if not entry then
        return fail("BAD_ARGS", field_name .. "_index = a row of the menu, 1 up",
          { got = idx, field = field_name, menu_rows = #(menus[menu_key] or {}) })
      end
      picked[field_name] = entry.value
    end
  end
  -- An empty-string row means "no choice" (any unlocked machine, no modules). Empty strings are truthy
  -- in Lua, so leaving one in would have the form ask for a machine named "" -- refused, but refused
  -- because of the panel's own bookkeeping rather than because of anything the player meant.
  for k, v in pairs(picked) do
    if v == "" then v = nil end
    if args[k] == nil then args[k] = v end
  end

  local item = args.item
  if type(item) ~= "string" or item == "" then
    local some = {}
    for i = 1, math.min(#menus.items, 8) do some[i] = menus.items[i].value end
    return fail("BAD_ARGS", "item = what the line should make", { got = type(args.item),
      examples = some, note = "a name the world model does not know is refused rather than planned as nothing" })
  end
  if not (prototypes.item[item] or prototypes.fluid[item]) then
    return fail("UNKNOWN_ITEM", item .. " is not an item or fluid on this install", { asked_for = item })
  end
  local unit = args.unit or "per_minute"
  local seconds_each = UNITS[unit]
  if not seconds_each then
    return fail("UNKNOWN_UNIT", "unit = per_second, per_minute or per_hour",
      { asked_for = unit, known = { "per_second", "per_minute", "per_hour" } })
  end
  local rate = tonumber(args.rate)
  if not rate then return fail("BAD_RATE", "rate = a number, e.g. 45", { got = args.rate, unit = unit }) end
  if rate <= 0 then
    return fail("BAD_RATE", "a rate of " .. tostring(rate) .. " is not a rate", { got = args.rate, unit = unit })
  end
  -- exact: 45/second is 2700/minute, and doing that in floats is how a plan ends up 0.0001 short
  local per_min = rat.toNumber(rat.mul(rat.from(rate), rat.new(60, seconds_each)))

  local sent = { want = { item = item, rate_per_min = per_min }, force = args.force or "player" }
  if prototypes.fluid[item] then sent.want = { fluid = item, rate_per_min = per_min } end

  if args.machine then
    if not db.machines[args.machine] then
      return fail("UNKNOWN_MACHINE", tostring(args.machine) .. " is not a machine this mod can size",
        { asked_for = args.machine })
    end
    -- The hint is keyed by the recipe's category. Two ways to get this wrong, and both were here
    -- first: `crafting_categories` is a MAP of category -> true (iterated as an array it reads as
    -- "this machine can do nothing"), and a player naming one route was treated as demanding a
    -- machine for every recipe that yields the item, recycling included.
    local cats = {}
    for _, r in pairs(prototypes.recipe) do
      for _, p in ipairs(field(r, "products") or {}) do
        if p.name == item then cats[field(r, "category") or "crafting"] = true end
      end
    end
    local mp = prototypes.entity[args.machine]
    local mc = mp and field(mp, "crafting_categories")
    local can = {}
    if type(mc) == "table" then
      for c, v in pairs(mc) do if v ~= false then can[c] = true end end
    end
    local keyed, mismatch = {}, {}
    for c in pairs(cats) do
      if can[c] then keyed[c] = args.machine else mismatch[#mismatch + 1] = c end
    end
    if not next(keyed) then
      table.sort(mismatch)
      return fail("MACHINE_WRONG_CATEGORY",
        tostring(args.machine) .. " runs none of the recipes that make " .. item,
        { asked_for = args.machine, needs = mismatch, does = (function()
            local l = {} for c in pairs(can) do l[#l + 1] = c end table.sort(l) return l end)(),
          -- A miner has no crafting categories at all, so `does: {}` alone reads like the machine is
          -- broken rather than like the wrong kind of machine was asked for.
          kind = db.machines[args.machine].kind, speed = db.machines[args.machine].speed,
          -- and name the machines that CAN do the job: the refusal is one lookup from being the fix.
          alternatives = (function()
            local l = {}
            for name, m in pairs(db.machines) do
              for _, c in ipairs(m.categories or {}) do
                if cats[c] then l[#l + 1] = name break end
              end
            end
            table.sort(l)
            local t = {} for i = 1, math.min(#l, 8) do t[i] = l[i] end
            return t
          end)() })
    end
    sent.machines = keyed
  end

  local module_notes
  if args.module and args.module ~= "" then
    local n = tonumber(args.module_count) or 1
    if not db.modules[args.module] then
      return fail("UNKNOWN_MODULE", tostring(args.module) .. " is not a module on this install",
        { asked_for = args.module, known = (function()
            local l = {} for k in pairs(db.modules) do l[#l + 1] = k end table.sort(l)
            local t = {} for i = 1, math.min(#l, 10) do t[i] = l[i] end return t end)() })
    end
    if n < 1 then return fail("BAD_MODULE_COUNT", "count = how many per machine, at least 1", { got = n }) end
    sent.modules = { { item = args.module, count = n } }
  end
  if args.power then sent.check_power = true end
  if args.field_supply ~= nil then sent.field_supply = args.field_supply end
  -- Where this plan would stand. `M.solve` checks the recipe graph's rates against the ground, and the
  -- check is only meaningful for a surface somebody named: the panel passes the box the player drew or
  -- the planet under their feet, and a caller who says nothing gets a plan with no surface claim on it
  -- rather than one quietly aimed at nauvis.
  if args.surface ~= nil then sent.surface = args.surface end
  if args.allow_locked then sent.allow_locked = true end

  local plan = M.solve(sent)
  if not plan then return fail("SOLVE_FAILED", "the solver answered nothing") end
  if plan.fail then return plan end
  -- How many slots the machine really has, and what was dropped for not fitting, come back inside each
  -- node's `modules`: a plan that quietly ignored "4 productivity modules in a 2-slot furnace" would be
  -- a lie by omission, so those notes are lifted to the top of the answer where a player will read them.
  for _, node in ipairs(((plan.unit or {}).nodes) or {}) do
    for _, note in ipairs((node.modules or {}).notes or {}) do
      module_notes = module_notes or {}
      module_notes[#module_notes + 1] = { machine = node.machine, item = args.module,
        note = note.note or tostring(note.item), asked = note.asked, fitted = note.fitted }
    end
    if (node.modules or {}).capped_productivity then
      module_notes = module_notes or {}
      module_notes[#module_notes + 1] = { machine = node.machine, item = args.module,
        note = "productivity capped by the recipe" }
    end
  end
  return {
    sent = sent, plan = plan, unit_shown = unit, rate_shown = rate, item = item,
    modules = module_notes,
    how_many = (function()
      local l = {}
      for _, n in ipairs(((plan.unit or {}).nodes) or {}) do
        l[#l + 1] = { machine = n.machine, count = n.count,
          per_machine_per_min = n.per_machine_per_min, estimated = n.estimated,
          item = n.item, recipe = n.recipe,
          -- the row a player reads is "machines x rate", and for a recipe that feeds part of its own
          -- output back into itself the rate shown is what the line KEEPS. Without the other number
          -- beside it, the row is a half-truth about a belt that carries more than that.
          recirculated = n.recirculated,
          modules = n.modules and { speed = n.modules.speed, productivity = n.modules.productivity,
            slots_used = n.modules.slots_used } or nil }
      end
      return l
    end)(),
  }
end

-- Which parts of a plan the ground it is aimed at will not allow, and in which of the two ways.
--
-- A recipe can be refused by the surface it would run on. A machine can be refused as something to
-- BUILD there. Those are different news and the plan has to keep them apart: the first voids the rate
-- (ghosts of it would sit there forever producing nothing), the second only says the hardware has to
-- arrive by other means, which is a fact about logistics and not a reason to refuse the arithmetic.
-- Measured on this install: `big-mining-drill` is the second case on nauvis (its recipe wants pressure
-- 4000, the surface answers 1000) and it is the machine almost every ore-fed plan here stands on.
local function surface_reality(db, plan, surface)
  if not surface or not plan or not (plan.unit or {}).nodes then return nil end
  local values = host.surface_values(surface)
  local blocked, unbuildable, seen_b, seen_u = {}, {}, {}, {}
  for _, n in ipairs(plan.unit.nodes) do
    local rec = n.recipe and db.recipes[n.recipe]
    local miss = rec and host.condition_miss(rec.surface_conditions, values)
    if miss and not seen_b[n.recipe] then
      seen_b[n.recipe] = true
      miss.recipe = n.recipe
      blocked[#blocked + 1] = miss
    end
    local mach = n.machine and db.machines[n.machine]
    local own = mach and mach.unlock_recipe and db.recipes[mach.unlock_recipe]
    local miss2 = own and host.condition_miss(own.surface_conditions, values)
    if miss2 and not seen_u[n.machine] then
      seen_u[n.machine] = true
      miss2.machine = n.machine
      miss2.crafted_by = own.name
      unbuildable[#unbuildable + 1] = miss2
    end
  end
  table.sort(blocked, function(a, b) return tostring(a.recipe) < tostring(b.recipe) end)
  table.sort(unbuildable, function(a, b) return tostring(a.machine) < tostring(b.machine) end)
  -- Emptied lists are the answer "nothing here refuses this plan", which is a different thing from
  -- never having asked, so the report is returned whenever a surface was named.
  return {
    surface = field(surface, "name"), values = values, checked = true,
    recipes_refused_here = #blocked > 0 and blocked or nil,
    machines_built_elsewhere = #unbuildable > 0 and unbuildable or nil,
  }
end

function M.solve(args)
  args = args or {}
  local db = world_db()
  if not refresh_availability(db, args.force or "player") then
    return fail("NO_FORCE", tostring(args.force))
  end
  if args.check_power and not args.power_available_kw then
    local p = M.power({ force = args.force })
    if type(p) == "table" and not p.fail then args.power_available_kw = p.total_capacity_kw end
  end
  -- whatever has been measured on this map so far; the solver marks a mining node `estimated`
  -- only while nothing was measured for that machine and ore.
  args.measured = measured_cache()
  -- How much of each ore is actually lying on this map. A plan that sizes extractors without it
  -- can only answer "how many machines for X per minute"; with it, the answer says how long the
  -- ground will keep paying at that rate, which is the difference between a plan and a wish.
  -- A caller may hand in its own field figures -- to ask "what if the patch only holds this much"
  -- -- and `false` says do not look at the map at all. Only when neither was given does the plan
  -- pay for a scan.
  local surface = resolve_surface(args.surface)
  -- The surface a plan is CLAIMED to stand on is only one the caller named. `resolve_surface` falls
  -- back to the player's feet when it is handed nothing, which is the right business for counting the
  -- ore under them, but a default is exactly what a surface verdict must not be: "30 drills" and "30
  -- drills, whose frames nauvis refuses to build" are different claims, and the second one needs
  -- somebody to have said where.
  local aimed_at = args.surface ~= nil and surface or nil
  if args.field_supply == nil then
    local field_of = {}
    if surface then
      for _, e in ipairs(surface.find_entities_filtered { type = "resource" }) do
        -- Counted under the thing that comes out of the ground, because that is the name every
        -- consumer of this table looks up. For ten of the twelve resource entities here it is the same
        -- word; a geyser and a vent are named after the hole and not the fluid, and a solver that asks
        -- "does this map have sulfuric acid" by entity name is told no on a map covered in them.
        local src = db.raw[e.name]
        local key = (src and src.product and src.product.name) or e.name
        local f = field_of[key]
        if not f then
          local pr = prototypes.entity[e.name]
          f = { tiles = 0, units = 0, infinite = (pr and pr.infinite_resource) or false,
            surface = field(surface, "name"), entity = e.name }
          field_of[key] = f
        end
        f.tiles = f.tiles + 1
        f.units = f.units + (e.amount or 0)
      end
      args.field_supply = field_of
    end
  end
  local plan, err, detail, extra = solve.plan(db, args)
  if not plan then
    return fail(err or "SOLVE_FAILED", tostring(detail), extra)
  end
  -- The ground gets a say in a plan that was aimed at it. Nothing about the arithmetic changes with the
  -- planet -- the same rates hold anywhere -- so the two news are kept apart: a step of the plan that
  -- this surface will not let run VOIDs the claim (the ghosts would sit there forever producing
  -- nothing), while hardware the surface will not build only says the crate has to arrive from
  -- somewhere else and the line is then exactly as good.
  plan.surface = surface_reality(db, plan, aimed_at)
  if type(plan.surface) == "table" and type(plan.surface.recipes_refused_here) == "table" then
    local names = {}
    for _, r in ipairs(plan.surface.recipes_refused_here) do names[#names + 1] = tostring(r.recipe) end
    return fail("SURFACE_REFUSES_RECIPE", table.concat(names, ", ")
      .. " cannot be crafted on " .. tostring(plan.surface.surface), {
        surface = plan.surface.surface, values = plan.surface.values,
        recipes = plan.surface.recipes_refused_here,
        use_instead = "ask the same question with no surface for the arithmetic alone, or fit the line "
          .. "where the pressure and gravity allow it",
        why = "every step of this plan has to run on the ground it is aimed at, and one of them is "
          .. "refused by that ground; `recipes` carries what each wants and what this surface answers",
      })
  end
  return plan
end

-- ============================================================
-- Methods
-- ============================================================

local function parse_area(spec)
  if type(spec) ~= "table" or type(spec[1]) ~= "table" or type(spec[2]) ~= "table" then
    return nil, fail("BAD_ARGS", "area must be [[x1,y1],[x2,y2]]")
  end
  local a, b = spec[1], spec[2]
  for _, v in ipairs({ a[1], a[2], b[1], b[2] }) do
    if type(v) ~= "number" then return nil, fail("BAD_ARGS", "area coordinates must be numbers") end
  end
  return {
    left_top = { x = math.min(a[1], b[1]), y = math.min(a[2], b[2]) },
    right_bottom = { x = math.max(a[1], b[1]), y = math.max(a[2], b[2]) },
  }
end

function M.ping(args)
  -- Discovery, generated from the surface itself so it cannot go stale the way a hand-written
  -- list does: a model's first call has to tell it what it may ask for.
  local methods = {}
  for k in pairs(M) do methods[#methods + 1] = k end
  table.sort(methods)
  return {
    mod_version = MOD_VERSION,
    methods = methods,
    game_version = (script.active_mods or {}).base,
    tick = game.tick,
    ticks_played = game.ticks_played,
    surfaces = keys_of(game.surfaces, nil),
    forces = keys_of(game.forces, nil),
    active_mods = (function()
      local out = {}
      for m, v in pairs(script.active_mods or {}) do out[m] = v end
      return out
    end)(),
    -- The commands a player can actually type. Registered in a Lua handler that runs at load, so a
    -- wrong `add_command` signature leaves this empty without any error surfacing anywhere -- which
    -- is how `/arch` shipped broken: no headless test looked, and no headless test could have failed.
    player_commands = (function()
      local out = {}
      local ok, cmds = pcall(function() return commands.commands end)
      if ok and type(cmds) == "table" then
        for name in pairs(cmds) do out[#out + 1] = tostring(name) end
      end
      table.sort(out)
      return out
    end)(),
    -- and if it is not there, what the registration step said: an empty list with no error means the
    -- handler never ran, which is a different bug from a rejected call
    command_registration = boot.command_reg,
  }
end

-- L1 capability model: what can be produced, how fast, and what unlocks it.
-- What the rules engine sees, and what it therefore cannot promise. Computed from the
-- running game rather than written as a disclaimer, so it moves when the game does: a
-- Space Age save with planets generated, or a modpack with heat-based power, changes these
-- numbers, and a caller reading `coverage` cannot mistake a nameplate item-only plan for a
-- complete one. This is the same discipline as `ceiling_is_upper_bound` on a flow.
local function coverage_report()
  local c = { resources = {}, fluids = 0, heat_sources = 0, spoilable = 0, quality_active = false,
              platforms = 0, surfaces = {}, fluid_portable = false }
  for _, s in pairs(game.surfaces) do
    c.surfaces[#c.surfaces + 1] = s.name
    local okp, plat = pcall(function() return s.platform end)
    if okp and plat then c.platforms = c.platforms + 1 end
  end
  for _, p in pairs(prototypes.entity) do
    local ok, ty = pcall(function() return p.type end)
    if ok and ty == "resource" then
      local cat = field(p, "resource_category") or "unknown"
      c.resources[cat] = (c.resources[cat] or 0) + 1
    end
    if field(p, "heat_energy_source_prototype") then c.heat_sources = c.heat_sources + 1 end
  end
  for _, f in pairs(prototypes.fluid) do
    c.fluids = c.fluids + 1
    if field(f, "max_temperature") and (field(f, "heat_capacity") or 0) > 0 then
      c.heat_fluids = (c.heat_fluids or 0) + 1
    end
  end
  for _, i in pairs(prototypes.item) do
    if field(i, "spoil_result") then c.spoilable = c.spoilable + 1 end
  end
  c.quality_active = (script.active_mods or {}).quality ~= nil
  c.space_age_active = (script.active_mods or {})["space-age"] ~= nil
  -- What the box table already knows, so a caller can tell a card that will measure on the spot
  -- from one that will spend a discovery pass first. Neither is a problem; the second is only slower.
  c.fluid_box_table = boxes.covered()
  -- Anything the engine hands a crafting speed to, whose kind no set above covers. On a modded save
  -- this is the silent failure mode: an unknown machine is not an error, it is simply absent from
  -- every plan, and a caller cannot tell "no recipe makes this" from "I never looked at that
  -- machine". Reported even when it is empty, because an empty list is the thing being asserted.
  local unknown = {}
  for name, p in pairs(prototypes.entity) do
    local kind = field(p, "type")
    -- `character` is the one thing with a crafting speed that is not a machine: the player's own
    -- hand. It came up the first time this loop ran, which is the detector doing its job on the
    -- author before anyone had to file it as a bug report from a modded save.
    if kind and kind ~= "character" and not host.CRAFTER_KINDS[kind] and getter(p, "get_crafting_speed") then
      unknown[#unknown + 1] = { name = name, kind = kind }
    end
  end
  table.sort(unknown, function(a, b)
    if a.kind ~= b.kind then return a.kind < b.kind end
    return a.name < b.name
  end)
  local seen, ukinds = {}, {}
  for _, u in ipairs(unknown) do
    if not seen[u.kind] then seen[u.kind] = true; ukinds[#ukinds + 1] = u.kind end
  end
  local covered = {}
  for k in pairs(host.CRAFTER_KINDS) do covered[#covered + 1] = k end
  table.sort(covered)
  c.crafting_kinds_covered = covered
  -- The same question one level down: the mod places arms, belts, chests and poles too, so a modpack
  -- whose inserter-shaped machine is not `type == "inserter"` is invisible to `roles` -- and it is
  -- invisible *silently*, because the role simply has no candidate and the caller falls back.
  -- Counted per role from `roles.KINDS`, so adding a type to that table adds a report line here.
  c.parts = {}
  for kind, spec in pairs(roles.KINDS) do
    local want = {}
    for _, t in ipairs(spec.types) do want[t] = true end
    local n, figures = 0, 0
    for _, p in pairs(prototypes.entity) do
      local ty = field(p, "type")
      if ty and want[ty] then
        local place = field(p, "items_to_place_this")
        if place and place[1] then
          n = n + 1
          if spec.read and spec.read(p) then figures = figures + 1 end
        end
      end
    end
    c.parts[kind] = {
      types = spec.types, placeable = n,
      ranked_by = spec.key or "name",
      figures_read = spec.measured and "measured at use time" or figures,
    }
  end
  -- And the gap on the other side: placeable entities whose `type` no role and no crafter set covers.
  -- A logistic chest is a real example -- this mod's `chest` role asks for `container`, so a modpack
  -- that ships only logistic chests has no arm-visible buffer and says nothing about it. Counted, not
  -- guessed, because the number is the thing that decides whether to widen a role's types.
  local role_types = {}
  for _, spec in pairs(roles.KINDS) do
    for _, t in ipairs(spec.types) do role_types[t] = true end
  end
  local unplaced, uncounted = {}, 0
  for name, p in pairs(prototypes.entity) do
    local ty = field(p, "type")
    local place = field(p, "items_to_place_this")
    if ty and place and place[1] and not role_types[ty] and not host.CRAFTER_KINDS[ty]
      and ty ~= "character" and not unplaced[ty] then
      unplaced[ty] = true; uncounted = uncounted + 1
    end
  end
  local unseen = {}
  for t in pairs(unplaced) do unseen[#unseen + 1] = t end
  table.sort(unseen)
  c.placeable_types_not_in_any_role = { count = uncounted, sample = unseen }
  c.unclassified_crafters = {
    count = #unknown, kinds = ukinds,
    sample = (function()
      local l = {}
      for i = 1, math.min(#unknown, 20) do l[i] = unknown[i] end
      return l
    end)(),
  }

  c.not_modelled = {
    "circuit network and control behaviours, in two halves that are NOT the same kind of limit. "
      .. "The half that is an engine boundary: nothing can put a signal onto a wire from script in "
      .. "2.0.77. `LuaConstantCombinatorControlBehavior` and its `set_signal`/`signals_count` are "
      .. "gone, and the `sections` left on a control behaviour carry no field for the value a "
      .. "combinator emits -- measured by building one and reading every member it offers "
      .. "(dev/circuit_signal_probe.js, dev/circuit_probe.js). So no plan from this mod gates, "
      .. "prioritises or retools anything by signal, and a card is one recipe at one rate. That is "
      .. "not a backlog item: a caller should plan the wire the way a player draws it. "
      .. "The half that is this mod's own gap, and is fixable here: `roles` covers inserter, belt, "
      .. "container, furnace, pole and solar-panel types, so a combinator cannot even be PLACED by "
      .. "`card_place` today -- `coverage.placeable_types_not_in_any_role` says so by name rather "
      .. "than letting it go missing from every plan quietly. And recipe binding is "
      .. "`LuaEntity::set_recipe`, which exists only on an assembling machine: a furnace has no "
      .. "setter in 2.0 at all (it answers `Entity is not assembling-machine`), so a furnace runs "
      .. "what its inputs allow and the rig reports that rather than pretending to have chosen it.",
    "the box-fitting layout knows one lane: `plan_fit` fills a rectangle with smelting lanes, because "
      .. "that is the one template `card_example` builds. Asking it for gears, circuits or chemistry "
      .. "refuses with LANE_NOT_FOR_ITEM and says what the lane does make -- it will not lay a factory "
      .. "it cannot describe. The machine counts for any item come from `plan_form`, and any card can "
      .. "be laid with `card_place`; what is missing is a lane template per crafting category, which is "
      .. "a widening and not a gap in the arithmetic",
    "beacons: their module effect multiplies nothing in these numbers, so a design that leans on them "
      .. "is being sized without the bonus it will actually get",
    "module `limitations` (where a module may be used at all) are not read: a module restricted to "
      .. "furnaces is offered to assemblers as well",
    "trains, logistic robots and vehicle paths: what placement can put down is machines, arms, belts, "
      .. "chests, pipes, poles, tanks, pumps, drills, boilers and generators, solar panels and "
      .. "accumulators, and the electric-energy-interface a rig supplies its own grid with. None "
      .. "of it moves on a network of its own, and nothing here plans a rail block, a bot reach or "
      .. "a path an entity drives along",
    "fluid boxes the lab cannot reach: `boxes.lua` carries the cell each ingredient of a known "
      .. "machine enters, and anything not in it is found by offering fluid one cell at a time; a "
      .. "face is then split between runs that touch neither each other's pipes nor each other's "
      .. "tanks. Two boxes one cell apart have no such split, three on one face are not planned at "
      .. "all, and both cases say so instead of measuring a starved machine. A table entry is never "
      .. "trusted -- it has to move fluid or the whole machine is discovered from scratch",
    "fluid products are read from the machine's own boxes by script, which is the rate the machine "
      .. "is capable of and not a claim that a player could pipe them away",
    "a card's fluid ports name the machine whose box they are. A port declared on a pipe is neither "
      .. "a lint error nor a refusal: the pipe has no box for the rig to fill, so `card_lab` carries "
      .. "on and reports the port in `unwired_inputs` (`FLUID_PORT_NOT_ON_A_MACHINE`, measured on "
      .. "this build) -- the claim stays unproven from the card rather than being quietly measured "
      .. "off plumbing. `card_check` accepts it because a pipe really does hand fluid to a machine "
      .. "in the world.",
    "fluid temperature: carried on what a recipe yields, but no consumer is matched against it, so "
      .. "hot and cold water are planned as one fluid and heat exchange is arithmetic this mod does not do",
    "heat energy sources (reactor -> heat -> steam): power reads electric sources only",
    "spoilage: an item that decays on a bus is still counted as conserved",
    "space platforms: the hub is a mobile grid with autonomous forging; placement assumes a static surface",
    "what the ground itself allows, which Space Age splits into two answers and this mod now gives "
      .. "both. 36 of the 659 recipes here and 51 of the 1016 entities carry `surface_conditions` -- "
      .. "pressure mostly (a foundry wants 4000, this nauvis answers 1000), gravity and magnetic field "
      .. "for the rest. A step of the plan that the aimed-at surface will not run is refused by name, "
      .. "with the bound and the number the ground gave (`SURFACE_REFUSES_RECIPE`); hardware the "
      .. "surface will not let anybody build is reported beside a plan that is still worth having "
      .. "(`surface.machines_built_elsewhere`), because carrying a drill frame in from another planet "
      .. "is a normal thing for a player to do. A plan with no surface named claims nothing about one. "
      .. "What is NOT modelled: the solver does not reroute around a refused step, and the numbers read "
      .. "here are `get_property` on the surface, not the tile-level values the game uses for solar "
      .. "and temperature (`calculate_tile_properties` is a separate door and stays unopened).",
    "what the ground allows, which is a second gate over the same plan. 36 of the 659 recipes here and "
      .. "51 of the 1016 entities carry `surface_conditions` -- pressure mostly (`biolab` wants exactly "
      .. "1000, `crusher` wants gravity 0), and a bound with no `min` or no `max` is one-sided, not "
      .. "zero. `solve` aimed at a surface says which machines it could not build there and refuses a "
      .. "step the planet will not run (`SURFACE_REFUSES_RECIPE`); `card_fits` names the planet when the "
      .. "engine's `can_place_entity` answers false on clear ground. What it does NOT do is pick a "
      .. "different planet, or read the tile-level values (temperature and the like) that "
      .. "`calculate_tile_properties` would answer -- the five surface properties are enough for every "
      .. "condition written in this pack.",
    "what arrives by something that is not a recipe. The solver answers `NO_RECIPE_SOURCE` and names "
      .. "the number instead of sizing the machine: an asteroid chunk is caught from orbit by an "
      .. "asteroid collector (its throughput is an arm swinging at rocks -- `arm_speed_base`, "
      .. "collection_radius, how many asteroids the planet's `asteroid_defines` spawn per minute -- "
      .. "and no prototype field states a rate the way a drill does), and a plantation item needs a "
      .. "farm on a surface whose conditions allow it. Measured on this install: the chunk types "
      .. "reprocess each other -- `metallic-asteroid-reprocessing` eats one metallic chunk and hands "
      .. "back 0.4 metallic plus 0.2 oxide plus 0.2 carbonic -- so each colour is a net product of "
      .. "some recipe and a net consumer of itself, and the SET is closed: nothing outside it feeds "
      .. "anything inside it, and no machine count opens it. `solve` still gives the useful half: "
      .. "which recipe it ran out at (`blocked_by`), and how many of the item a minute the plan "
      .. "would have to be handed (`blocked_demand_per_min`, e.g. 120 ice/min wants 38 oxide "
      .. "chunks/min through `advanced-oxide-asteroid-crushing`).",
    "item quality: getters are called at default quality, so quality-gated recipes and modules are seen at normal",
    "by-products: counted as produced and named against the node that wants them, never routed -- "
      .. "feeding one changes the plan's integer structure, which is a different problem than sizing it",
    "pipe routes that bend: a straight run the layout can verify is placed, and anything that has "
      .. "to turn a corner is reported as the cells that would close it (`seam_check`) rather than "
      .. "laid -- routing through ground another card or the player occupies is where a quiet wrong "
      .. "answer would live. `plan_fit` extends this rather than escaping it: it lays whole lanes side "
      .. "by side inside a box the player drew, and what it does NOT do is join one lane's output to "
      .. "the next lane's input -- the aisles between lanes are left clear precisely so the player "
      .. "runs the belt, which is the part they do in three seconds and script does in three hundred",
    "what the world already holds: rates come from recipes and from rigs, never from a chest count "
      .. "or an inserter in flight, so a plan cannot say 'you already have 4k of this'",
    "pipe throughput: a fluid line is sized by pumps and tanks, and nothing in this mod reads how "
      .. "many units a second a run of pipe can carry, so a long line is not yet known to be the "
      .. "narrow place in it",
    "infinite/depleting ore patches: resource_drain_rate_percent means a drill's measured rate is a property of the patch",
    "answering a player: `/arch`'s Ask button queues the question and Queue shows whatever came back, "
      .. "and this is the whole of what the mod can do about it -- Factorio gives a mod no way to "
      .. "reach a model and this mod does not pretend there is one. An agent outside the game reads "
      .. "`requests` and writes with `answer`; nobody doing that leaves the question open, and the "
      .. "panel says so rather than answering it itself",
  }
  return c
end

function M.capabilities(args)
  args = args or {}
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end

  local m = model()
  local recipes = {}
  for name, r in pairs(prototypes.recipe) do
    if args.enabled_only then
      local fr = force.recipes[name]
      if not fr or not fr.enabled then goto continue end
    end
    if not field(r, "hidden") then
      local ing, pro = {}, {}
      for _, i in ipairs(field(r, "ingredients") or {}) do
        ing[#ing + 1] = { name = i.name, amount = i.amount, type = i.type }
      end
      for _, p in ipairs(field(r, "products") or {}) do
        pro[#pro + 1] = {
          name = p.name, amount = p.amount, type = p.type,
          -- 2.0 carries no `catalyst_amount` on a runtime product (it is absent from the
            -- pinned API doc and the read answers nil), so this key was always missing. What
            -- the engine does say about a catalyst-shaped product is how much of it
            -- productivity is not allowed to multiply.
            probability = p.probability,
            ignored_by_productivity = p.ignored_by_productivity,
          -- spelled out, because `amount or probability` -- the obvious reading -- is what
          -- turned 2.0's uranium split into 1:1 and sized every centrifuge 143x too small
          expected_amount = (p.amount or p.amount_min or 1) * (p.probability or 1),
        }
      end
      recipes[#recipes + 1] = {
        name = name,
        category = field(r, "category"),
        energy = field(r, "energy"),
        ingredients = ing,
        products = pro,
        enabled = (force.recipes[name] and force.recipes[name].enabled) or false,
      }
    end
    ::continue::
  end

  local techs, researched_count, total = {}, 0, 0
  for name, t in pairs(prototypes.technology) do
    total = total + 1
    local ft = force.technologies[name]
    local researched = ft and ft.researched or false
    if researched then researched_count = researched_count + 1 end
    if not args.enabled_only or not researched then
      local unlocks, prereq = {}, {}
      for _, e in ipairs(field(t, "effects") or {}) do
        if e.type == "unlock-recipe" and e.recipe then unlocks[#unlocks + 1] = e.recipe end
      end
      for _, p in ipairs(field(t, "prerequisites") or {}) do prereq[#prereq + 1] = p end
      techs[#techs + 1] = {
        name = name, researched = researched, unlocks = unlocks,
        prerequisites = prereq, unit = field(t, "research_unit_energy"),
      }
    end
  end

  return {
    force = force.name,
    tech_progress = { total = total, researched = researched_count },
    recipes = recipes,
    technologies = techs,
    machines = m.machines,
    belts = m.belts,
    inserters = m.inserters,
    coverage = coverage_report(),
    modules = (function()
      local out = {}
      for name, v in pairs(world_db().modules or {}) do out[#out + 1] = { name = name, speed = v.speed, productivity = v.productivity, consumption = v.consumption, limit = v.limit } end
      table.sort(out, function(a, b) return a.name < b.name end)
      return out
    end)(),
  }
end

-- L1: the minimal capability subgraph between what is unlocked and the targets.
-- Full capabilities is 260KB / ~72k tokens, so this is the only form that can
-- actually be handed to a model.
function M.l1(args)
  args = args or {}
  local db = world_db()
  if not refresh_availability(db, args.force or "player") then
    return fail("NO_FORCE", tostring(args.force))
  end

  local targets = args.targets
  if type(targets) ~= "table" then targets = { args.target } end
  if #targets == 0 then return fail("BAD_ARGS", "targets is required") end

  local max_nodes = args.max_nodes or 60
  local items, machines, gaps = {}, {}, {}
  local seen, queue = {}, {}
  local n_items = 0
  for _, t in ipairs(targets) do queue[#queue + 1] = t end

  local guard = 0
  while #queue > 0 do
    guard = guard + 1
    if guard > 400 then return fail("SUBGRAPH_TOO_LARGE", "cycle or fan-out beyond 400 items") end
    local item = table.remove(queue, 1)
    if not seen[item] then
      seen[item] = true
      if n_items >= max_nodes then
        gaps[item] = { item = item, reason = "TRUNCATED" }
      elseif db.raw[item] then
        items[item] = { kind = "raw", mining = true }
        n_items = n_items + 1
      else
        local producers = db.producers[item] or {}
        local chosen, locked
        for _, r in ipairs(producers) do
          if r.enabled and not chosen then chosen = r end
          if not r.enabled and not locked then locked = r end
        end
        if not chosen then
          gaps[item] = {
            item = item,
            reason = #producers == 0 and "NO_RECIPE" or "ALL_LOCKED",
            locked_alternative = locked and locked.name or nil,
            unlocks_with = locked and locked.techs or nil,
          }
          -- Show what the locked route would need so the designer can plan the tech
          -- chain, but do not recurse: one level keeps the snapshot bounded.
          if locked and args.show_locked then
            local node = { kind = "recipe", recipe = locked.name, category = locked.category,
                           locked = true, ingredients = {}, products = {} }
            for _, i in ipairs(locked.ingredients) do
              node.ingredients[#node.ingredients + 1] = { name = i.name, amount = rat.toNumber(i.amount) }
            end
            for _, p in ipairs(locked.products) do
              node.products[#node.products + 1] = { name = p.name, amount = rat.toNumber(p.amount) }
            end
            items[item] = node
            n_items = n_items + 1
          end
        else
          local machine, nearest_locked = solve.best_machine(db, chosen)
          local node = {
            kind = "recipe", recipe = chosen.name, category = chosen.category,
            seconds = math.floor(rat.toNumber(chosen.energy) * 1000 + 0.5) / 1000,
            ingredients = {}, products = {},
            alternatives = {},
          }
          for _, r in ipairs(producers) do
            if r.name ~= chosen.name and #node.alternatives < (args.max_alternatives or 6) then
              node.alternatives[#node.alternatives + 1] = {
                recipe = r.name, unlocked = r.enabled or false,
              }
            end
          end
          local extra = #producers - 1 - #node.alternatives
          if extra > 0 then node.more_alternatives = extra end
          for _, i in ipairs(chosen.ingredients) do
            node.ingredients[#node.ingredients + 1] = { name = i.name, amount = rat.toNumber(i.amount) }
            queue[#queue + 1] = i.name
          end
          for _, p in ipairs(chosen.products) do
            node.products[#node.products + 1] = { name = p.name, amount = rat.toNumber(p.amount) }
          end
          if #chosen.products > 1 then node.multi_product = true end

          if machine then
            node.machine = machine.name
            node.machine_kw = machine.energy_usage
            node.on_grid = machine.on_grid and true or false
            local speed = machine.speed or machine.mining_speed
            node.per_machine_per_min = speed and
              math.floor((60 / (rat.toNumber(chosen.energy) / speed)) * 1000 + 0.5) / 1000 or nil
            machines[machine.name] = {
              kind = machine.kind, speed = speed, kw = machine.energy_usage,
              on_grid = machine.on_grid and true or false,
              tiles = { machine.w, machine.h }, module_slots = machine.module_slots,
            }
          else
            node.machine = nil
            gaps[item] = {
              item = item, reason = "NO_AVAILABLE_MACHINE", recipe = chosen.name,
              category = chosen.category,
              needs_machine = nearest_locked and nearest_locked.name or nil,
              unlocks_with = nearest_locked and nearest_locked.techs or nil,
            }
          end
          items[item] = node
          n_items = n_items + 1
        end
      end
    end
  end

  return {
    force = args.force or "player",
    targets = targets,
    node_count = n_items,
    items = items,
    machines = machines,
    gaps = gaps,
  }
end

-- What an example card is built from. The candidate set is every entity of the engine's own type that
-- this force can place, ranked by a figure read from the prototype (`belt_speed`, crafting speed) or
-- measured (arm reach). The names below are only *hints* -- what a vanilla player expects to see in a
-- fixture -- and `roles.pick` replaces one with the best data-ranked candidate on any save where that
-- entity does not exist. The ladder this replaces was a list of names, and two of its five entries
-- (`filter-inserter`, `chest`) are not entities in 2.0 at all.
local PART_HINTS = {
  arm = "stack-inserter", belt = "express-transport-belt",
  chest = "steel-chest", furnace = "electric-furnace",
}

-- The same rule for every example generator: a vanilla name is a hint, and what comes back is whatever
-- entity of that engine type actually exists on this install. Unlock state is deliberately not
-- consulted here -- `card_check` is the layer that refuses a part the force cannot build, and a
-- fixture whose shape moved with the tech tree would not be something anyone could assert against.
local function example_part(kind, hint, wanted)
  return roles.pick(kind, { prefer = wanted or hint })
end

-- A known-good card, expressed the way an author would express it, so the linter
-- itself can be tested from both sides.
-- The three words a player reaches for, in cells of clear ground between neighbouring lanes. They are
-- not skins over one number: at 0 nothing shares a cell but the geometry itself is what leaves the
-- room, so "compact" here means the tightest layout that can still be BUILT, and every cell above it
-- is aisle the player will later run belts, pipes or a second row through. A named preset rather than a
-- bare integer because the difference between 1 and 2 is a decision about the future aisle, and a
-- player should see which they picked.
local SPACING = { compact = 0, standard = 1, loose = 2 }

function M.card_example(args)
  args = args or {}
  local db = world_db()
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
  if not refresh_availability(db, force.name) then return fail("NO_FORCE", force.name) end
  local is_available = availability_checker(db, force)

  local how = {}
  local function pick(kind, wanted)
    -- built inside `pick` because `kind` is this function's argument: hoisting it next to the
    -- definition compared `nil == "arm"` forever, the arm ladder got no figure, and the example lane
    -- quietly built itself out of a burner inserter instead of a long-handed one
    local measure_of = nil
    if kind == "arm" then
      measure_of = function(n) return inserter_reach(game.surfaces[1], n, force.name) end
    end
    local name, meta = roles.pick(kind, {
      prefer = wanted or PART_HINTS[kind],
      available = is_available,
      measure_of = measure_of,
    })
    how[kind] = meta and meta.how or "none"
    return name, meta
  end

  local furnace = pick("furnace", args.furnace)
  local ins = pick("arm", args.inserter)
  local belt = pick("belt", args.belt)
  local chest = pick("chest", args.chest)
  if not (furnace and ins and belt and chest) then
    -- an example card with an unplaceable part in it is worse than no card: every lint result it
    -- produces would be about a fixture nobody can build
    return fail("NO_AVAILABLE_PART", "no placeable candidate for one of the card's roles",
      { wanted = { furnace = args.furnace, arm = args.inserter, belt = args.belt, chest = args.chest },
        picks = how })
  end

  local fp = prototypes.entity[furnace]
  local fw, fh = (fp and fp.tile_width) or 2, (fp and fp.tile_height) or 2
  local reach = inserter_reach(game.surfaces[1], ins, force.name)
  -- Lanes, not one lane: `machines` is the count a plan asked for and `spacing` is the gap between
  -- them. Both are reported back as the footprint they cost, because a number of machines you cannot
  -- fit anywhere is a wish, not a plan.
  local lanes = math.max(1, math.floor(tonumber(args.machines) or 1))
  local gap = SPACING[args.spacing]
  if args.spacing and not gap then
    local known = {}
    for k in pairs(SPACING) do known[#known + 1] = k end
    table.sort(known)
    return fail("UNKNOWN_SPACING", "spacing = " .. table.concat(known, ", ") .. " (or a number of cells)",
      { asked_for = args.spacing, known = known })
  end
  gap = gap or 0
  local specs = lane_units(0, 0, lanes, furnace, belt, ins, chest, fw, fh, nil, reach, args.outlets, gap)
  local ents = {}
  for _, s in ipairs(specs) do
    local p = prototypes.entity[s.name]
    local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
    ents[#ents + 1] = {
      name = s.name,
      position = { x = s.cell[1] + w / 2, y = s.cell[2] + h / 2 },
      direction = s.dir,
      _role = s.role,
    }
  end
  local ports = { ["in"] = {}, out = {} }
  -- Advisory index map: anyone mutating this card (the regression suite, or a model
  -- using it as a template) should look entities up by role instead of counting them,
  -- because the geometry shifts with arm reach and furnace size.
  local roles = { arms = {}, belts = {}, machines = {}, out_chests = {} }
  for i, e in ipairs(ents) do
    local kind = (prototypes.entity[e.name] and field(prototypes.entity[e.name], "type")) or "?"
    if e._role == "in" then
      ports["in"][#ports["in"] + 1] = { item = "iron-ore", entity = i, chest = true }
      roles.in_chest = i
    elseif e._role == "out" then
      ports.out[#ports.out + 1] = { item = "iron-plate", entity = i, chest = true }
      roles.out_chests[#roles.out_chests + 1] = i
      roles.out_chest = roles.out_chest or i
    elseif e._role == "overflow" then
      roles.overflow_chest = i
    end
    if kind == "inserter" then roles.arms[#roles.arms + 1] = i
    elseif kind == "transport-belt" then roles.belts[#roles.belts + 1] = i
    elseif kind == "furnace" or kind == "assembling-machine" then roles.machines[#roles.machines + 1] = i end
    e._role = nil
  end
  local speed = (fp and getter(fp, "get_crafting_speed")) or 1
  local energy = rat.toNumber(db.recipes["iron-plate"].energy)
  -- emit the anchor list alongside the ports so an unfrozen card is structurally the
  -- same shape as a frozen one; otherwise the first composition silently depends on
  -- the ports fallback and the second one does not
  local anchors = {}
  for _, p in ipairs(ports["in"]) do anchors[#anchors + 1] = { kind = "in", item = p.item, entity = p.entity } end
  for _, p in ipairs(ports.out) do anchors[#anchors + 1] = { kind = "out", item = p.item, entity = p.entity } end
  -- The ground it actually took, which is what a box gets compared against. Measured from the entities
  -- rather than from the pitch formula, because the supply a lane grows (chests, outlets) is what
  -- decides the width, and a formula kept beside it would be a second truth free to drift.
  local wide, high = 0, 0
  for _, e in ipairs(ents) do
    local proto = prototypes.entity[e.name]
    local w, h = (proto and proto.tile_width) or 1, (proto and proto.tile_height) or 1
    wide = math.max(wide, math.floor(e.position.x + w / 2) + 1)
    high = math.max(high, math.floor(e.position.y + h / 2) + 1)
  end
  return { name = "smelter-lane-" .. tostring(lanes), lane_count = lanes, spacing = args.spacing or "compact",
           gap_cells = gap, footprint = { width = wide, height = high },
           components = { furnace = furnace, inserter = ins, belt = belt, chest = chest },
           -- how each part was chosen, so a caller on a modded save can see that it was chosen at all
           components_how = how,
           arm_reach = reach, roles = roles, anchors = anchors,
           entities = ents, ports = ports,
           -- One lane's rate times the lanes built. The first version of this line forgot the second
           -- factor, so a 4-lane card claimed a 1-lane output: the footprint grew, the claim did not,
           -- and every number downstream -- "how many of these", the lab's verdict -- read a card that
           -- under-promised by a factor of four. `rat.from` is where the float recipe energy becomes a
           -- rational; `rat.new(lanes, energy)` floors both sides, which turned 37.5 into
           -- 37.49999999999999 and is the mistake this library's boundary exists to prevent.
           contract = { outputs = { ["iron-plate"] = rat.toNumber(rat.div(
             rat.mul(rat.mul(rat.from(speed), rat.new(60)), rat.new(lanes)), rat.from(energy))) } } }
end

-- A bus on its own produces nothing, so it carries no contract: it exists to move an
-- item from one anchor to several. Its in port fuses onto a producer's out chest and
-- each tap chest fuses onto a consumer's in chest, which is what lets one furnace line
-- feed several cells without the cells fighting over the same machine.
function M.bus_example(args)
  args = args or {}
  local item = args.item or "iron-plate"
  local belt = example_part("belt", "fast-transport-belt", args.belt)
  local ins = example_part("arm", "long-handed-inserter", args.inserter)
  local chest = example_part("chest", "steel-chest", args.chest)
  local taps = args.taps or 2
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
  if not (belt and ins and chest) then
    return fail("NO_AVAILABLE_PART", "a bus needs a belt, an arm and a container; this install has none for one of them",
      { belt = belt, arm = ins, chest = chest })
  end
  local reach = inserter_reach(game.surfaces[1], ins, force.name)
  local specs = bus_line(0, 0, taps, belt, ins, chest, reach, args.pitch)

  local ents, ports = {}, { ["in"] = {}, out = {} }
  local roles = { arms = {}, belts = {}, taps = {} }
  for _, s in ipairs(specs) do
    local p = prototypes.entity[s.name]
    local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
    local kind = (p and field(p, "type")) or "?"
    local i = #ents + 1
    ents[i] = { name = s.name, position = { x = s.cell[1] + w / 2, y = s.cell[2] + h / 2 }, direction = s.dir }
    if s.role == "in" then ports["in"][#ports["in"] + 1] = { item = item, entity = i }
    elseif s.role == "tap" then ports.out[#ports.out + 1] = { item = item, entity = i }; roles.taps[#roles.taps + 1] = i
    elseif s.role == "collector" then roles.collector = i end
    if kind == "inserter" then roles.arms[#roles.arms + 1] = i
    elseif kind == "transport-belt" then roles.belts[#roles.belts + 1] = i end
  end
  local anchors = {}
  for _, p in ipairs(ports["in"]) do anchors[#anchors + 1] = { kind = "in", item = p.item, entity = p.entity } end
  for _, p in ipairs(ports.out) do anchors[#anchors + 1] = { kind = "out", item = p.item, entity = p.entity } end

  return { name = "belt-bus-" .. taps .. "tap", entities = ents, ports = ports, anchors = anchors,
           roles = roles, arm_reach = reach, contract = { outputs = {} },
           item = item, tap_pitch = math.max(2 * reach + 2, args.pitch or 12),
           lanes = { lane_of(item, belt, #roles.belts) } }
end

-- One belt row carries its tier's throughput; a longer spine does not carry more, because
-- every segment of a series has to pass the whole flow. This is the figure the flow
-- arithmetic holds a rate claim against.
lane_of = function(item, tier, spine_tiles)
  local b = model().belts[tier]
  return {
    item = item, tier = tier, spine_tiles = spine_tiles or 1,
    per_min = b and (b.throughput_per_sec * 60) or nil,
  }
end

-- A corridor: several belt rows in one card, each carrying its own item, with taps on every
-- row. This is the shape a main bus in an actual factory has -- one yellow belt per
-- commodity, not one belt per commodity running to a separate junction -- and until now a
-- region that needed two items moved side by side had no card to ask for.
--
-- Rows are stacked with enough pitch to clear each other's tap chests, so the card stays a
-- rectangle a consumer can butt up against, and every row declares its own carrying
-- capacity so the flow arithmetic can refuse a rate the road cannot move.
function M.corridor_example(args)
  args = args or {}
  local items = {}
  for _, it in ipairs(args.items or { "iron-plate", "copper-plate" }) do items[#items + 1] = it end
  if #items == 0 then return fail("BAD_ARGS", "items = { iron-plate, copper-plate, ... }") end
  local tier = example_part("belt", "fast-transport-belt", args.belt)
  local ins = example_part("arm", "long-handed-inserter", args.inserter)
  local chest = example_part("chest", "steel-chest", args.chest)
  local taps = args.taps or 2
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
  if not (tier and ins and chest) then
    return fail("NO_AVAILABLE_PART", "a corridor needs a belt, an arm and a container",
      { belt = tier, arm = ins, chest = chest })
  end
  local reach = inserter_reach(game.surfaces[1], ins, force.name)
  local R = math.max(1, reach or 1)
  -- Row pitch is not just enough to clear this row's own tap chests -- a consumer butts up
  -- against those, so the next row has to start beyond the machine that will hang off this
  -- one. 2R+2 passed the corridor's own lint and geometry checks and then left every
  -- consumer PACKED: nothing could attach without standing on the row below.
  local row_pitch = args.row_pitch or (3 * R + 6)

  local ents, ports, anchors = {}, { ["in"] = {}, out = {} }, {}
  local roles = { arms = {}, belts = {}, taps = {} }
  local lanes, lane_roles = {}, {}
  for li, item in ipairs(items) do
    local oy = li * row_pitch
    local specs = bus_line(0, oy, taps, tier, ins, chest, R, args.pitch)
    local base = #ents
    local seen = { arms = {}, belts = {}, taps = {}, in_chest = nil, collector = nil }
    for _, s in ipairs(specs) do
      local p = prototypes.entity[s.name]
      local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
      local kind = (p and field(p, "type")) or "?"
      local i = #ents + 1
      ents[i] = { name = s.name, position = { x = s.cell[1] + w / 2, y = s.cell[2] + h / 2 }, direction = s.dir }
      if s.role == "in" then
        ports["in"][#ports["in"] + 1] = { item = item, entity = i }
        anchors[#anchors + 1] = { kind = "in", item = item, entity = i }
        seen.in_chest = i
      elseif s.role == "tap" then
        ports.out[#ports.out + 1] = { item = item, entity = i }
        anchors[#anchors + 1] = { kind = "out", item = item, entity = i }
        seen.taps[#seen.taps + 1] = i
        roles.taps[#roles.taps + 1] = i
      elseif s.role == "collector" then
        seen.collector = i
        roles.collector = roles.collector or i
      end
      if kind == "inserter" then roles.arms[#roles.arms + 1] = i; seen.arms[#seen.arms + 1] = i
      elseif kind == "transport-belt" then roles.belts[#roles.belts + 1] = i; seen.belts[#seen.belts + 1] = i end
    end
    local cap = lane_of(item, tier, #seen.belts)
    cap.row = li
    lanes[#lanes + 1] = cap
    lane_roles[li] = { item = item, in_chest = seen.in_chest, taps = seen.taps, collector = seen.collector,
      feed_arm = seen.arms[1], belt_tiles = #seen.belts }
  end

  return {
    name = "corridor-" .. #items .. "lane-" .. taps .. "tap", entities = ents, ports = ports,
    anchors = anchors, roles = roles, lane_roles = lane_roles, arm_reach = reach,
    contract = { outputs = {} }, lanes = lanes, row_pitch = row_pitch, tier = tier,
  }
end


-- Availability for any entity, not just the ones the solver tracks. Belts and
-- inserters land in db.machines but chests, poles and pipes do not, and an
-- ungated steel-chest would let a card pass lint that the player cannot build.
availability_checker = function(db, force)
  local memo = {}
  return function(name)
    if memo[name] ~= nil then return memo[name] end
    local v
    local m = db.machines[name]
    -- The live force answers first. `db.machines[].available` is ONE field shared by every force,
    -- and `refresh_availability` writes it from whichever force asked last -- so a checker built for
    -- a second force was returning the first force's research, and the `force` argument was
    -- decorative. Measured: `card_example{force:"enemy"}` came back with a full vanilla lane rather
    -- than a refusal. The cached record still supplies which recipe gates the machine, which is
    -- prototype data and does not vary by force.
    if force and m and m.unlock_recipe then
      local fr = force.recipes[m.unlock_recipe]
      v = (fr and fr.enabled) and true or false
    elseif m and m.available ~= nil then
      v = m.available and true or false
    else
      local p = prototypes.entity[name]
      local pi = p and place_item_of(p)
      local fr = pi and force.recipes[pi]
      if fr then
        v = fr.enabled and true or false
      else
        -- no recipe to craft it: scripts place it, so there is no research gate to test
        v = true
      end
    end
    memo[name] = v
    return v
  end
end

function M.card_check(args)
  args = args or {}
  local input = args.card
  if not input then return fail("BAD_ARGS", "card is required") end
  local normalized = card.normalize(input)
  local db = world_db()
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
  -- cached prototype structure must be re-gated against live force state, or a
  -- card linted before researching automation stays "locked" forever
  if not refresh_availability(db, force.name) then return fail("NO_FORCE", force.name) end
  local opts = {}
  -- `x and nil or y` would always give y; ignoring the gate has to be an explicit branch.
  if not args.ignore_locked then opts.available = availability_checker(db, force) end
  local res = card.lint(normalized, opts)
  res.card_name = normalized.name
  res.ok = #res.errors == 0
  return res
end

-- Compose several cards into one card. The result is an ordinary card, so every tier
-- applies to it unchanged: there is no second, weaker validation path for regions.
function M.card_compose(args)
  args = args or {}
  local slots_arg, slots_why = host.list_arg(args.slots)
  if not slots_arg then
    return fail("BAD_ARGS", "slots must be a list of { name = .. | card = .., at = {x,y} }",
      { got = slots_why })
  end
  if #slots_arg == 0 then
    return fail("BAD_ARGS", "slots = [{ name = <frozen card> | card = <inline>, at = {x,y} }, ...]")
  end
  storage.cards = storage.cards or {}
  local function resolve(name)
    local rec = storage.cards[name]
    return rec and rec.card
  end

  local merged, code, errors = compose.compose(args.slots, { resolve = resolve })
  if not merged then
    return fail(code or "COMPOSE_FAILED", (errors and errors[1] and errors[1].msg) or "could not compose",
      { errors = errors })
  end

  local normalized = card.normalize(merged)
  local db = world_db()
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
  refresh_availability(db, force.name)
  local opts = {}
  if not args.ignore_locked then opts.available = availability_checker(db, force) end
  local l = card.lint(normalized, opts)
  merged.lint = { errors = l.errors, warnings = l.warnings, stats = l.stats }
  merged.ok = #l.errors == 0
  merged.sources = (function()
    local out = {}
    for _, slot in ipairs(args.slots) do out[#out + 1] = slot.name or (slot.card and slot.card.name) or "inline" end
    return out
  end)()
  return merged
end

-- can_place_entity for the whole card before anything is created: create_entity
-- happily builds off-map and returns a "valid" entity, which poisoned a full round
-- of earlier experiments with data that looked fine and meant nothing.
-- Why the engine said no, which `can_place_entity` does not say and the caller has to find out.
--
-- A false answer covers two facts with opposite advice: something stands in these cells (move the
-- thing, or move the plan), or nothing stands there and the GROUND will not take it -- water, lava,
-- or chunks that were never generated, where reading a tile raises because there is no tile. Before
-- this split, both came back as `blockers = {<the entity this card wanted>}`, so placing a card on
-- ungenerated ground reported the card's own steel-chest as an obstacle blocking its own steel-chest.
local function why_not_there(surface, e, at, surface_values)
  local proto = prototypes.entity[e.name]
  local w = (proto and host.field(proto, "tile_width")) or 2
  local h = (proto and host.field(proto, "tile_height")) or 2
  local r = math.max(w, h) / 2 + 0.5
  local occupants = {}
  local ok, found = pcall(function()
    return surface.find_entities_filtered { position = at, radius = r }
  end)
  for _, o in ipairs((ok and found) or {}) do
    occupants[#occupants + 1] = o.name
    if #occupants >= 4 then break end
  end
  -- A tile read raises on an ungenerated chunk, which is itself the answer rather than a missing one.
  local tile, generated = nil, true
  local tok, t = pcall(function() return surface.get_tile(math.floor(at.x), math.floor(at.y)).name end)
  if tok then tile = t else generated = false end
  -- The third thing that can refuse a placement with clear, legal ground under it: Space Age says some
  -- machines only stand in certain gravity, pressure, magnetic field. `can_place_entity` answers a bare
  -- false for it and the tile read answers "land", so without this the report blames the ground for
  -- what the PLANET did. Measured: `crusher` wants gravity exactly 0, and every one of nauvis, the
  -- sandbox and the lab answers 10.
  local refused = surface_values ~= nil
    and host.condition_miss(host.surface_conditions(proto), surface_values) or nil
  return { occupants = #occupants, tile = tile, generated = generated, names = occupants,
    surface_refused = refused }
end

local function card_fits(surface, normalized, origin, force_name)
  local blockers, wanted = {}, {}
  local ground_only = true
  -- read once per fit check: the surface answers the same five properties wherever the card goes
  local surface_values = host.surface_values(surface)
  for i, e in ipairs(normalized.entities) do
    local at = { x = e.position.x + origin.x, y = e.position.y + origin.y }
    local ok, can = pcall(function()
      return surface.can_place_entity {
        name = e.name, force = force_name, direction = e.direction, position = at,
      }
    end)
    if not ok or not can then
      local why = why_not_there(surface, e, at, surface_values)
      local entry = { at = i, name = e.name, tile = why.tile, generated = why.generated,
        occupants = why.names, surface_refused = why.surface_refused }
      if why.occupants > 0 then
        ground_only = false
        blockers[#blockers + 1] = { at = i, name = e.name, on_top_of = why.names,
          surface_refused = why.surface_refused }
      else
        -- Nothing is standing here. What refused it is the ground -- or, when the machine cannot stand
        -- on this planet at all, the planet, which `surface_refused` says in numbers.
        wanted[#wanted + 1] = entry
      end
      if #blockers + #wanted >= 4 then break end
    end
  end
  local n = #blockers + #wanted
  return n == 0, n == 0 and {} or blockers, #wanted > 0 and wanted or nil,
    (#wanted > 0 and #blockers == 0) and ground_only or nil
end

-- Spiral out from the map centre until the whole card fits. Shared by verification
-- and measurement so both are judged on the same placement rules.
local function find_card_site(surface, normalized, force_name, wanted, limit)
  local sites = {}
  if wanted then
    sites[1] = { x = wanted.x or 0, y = wanted.y or 0 }
  else
    -- Step from the card's own bounding box: a big card must not keep proposing sites
    -- overlapping the one it just failed, and a small one must not be flung wide.
    local minx, miny, maxx, maxy
    for _, e in ipairs(normalized.entities) do
      local p = prototypes.entity[e.name]
      local hw = ((p and p.tile_width) or 1) / 2
      local hh = ((p and p.tile_height) or 1) / 2
      minx = math.min(minx or (e.position.x - hw), e.position.x - hw)
      maxx = math.max(maxx or (e.position.x + hw), e.position.x + hw)
      miny = math.min(miny or (e.position.y - hh), e.position.y - hh)
      maxy = math.max(maxy or (e.position.y + hh), e.position.y + hh)
    end
    if not maxx then
      -- no entities, no bounding box: this is a caller handing over an empty card, not a region
      -- the ground has no room for
      return nil, {}
    end
    local extent = math.ceil(math.max(4, maxx - minx, maxy - miny))
    -- half-extent steps so a card wider than half the search area still gets several
    -- candidate sites; a full-extent stride leaves only the origin on a small pad
    local step = math.max(8, math.ceil(extent / 2) + 1)
    -- candidates outside the region whose chunks exist are not "occupied", they just
    -- are not there yet -- reporting them as blocked sends the reader chasing terrain
    local lim = limit or 200
    for r = 0, 24 do
      local dirs = r == 0 and { { 0, 0 } }
        or { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 }, { 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 } }
      local any = false
      for _, d in ipairs(dirs) do
        local x, y = r * d[1] * step, r * d[2] * step
        if math.abs(x) <= lim and math.abs(y) <= lim then
          any = true
          sites[#sites + 1] = { x = x, y = y }
        end
      end
      if r > 0 and not any then break end
    end
  end
  local rejected = {}
  for _, s in ipairs(sites) do
    local fits, blockers, wanted, ground_only = card_fits(surface, normalized, s, force_name)
    if fits then return s, nil end
    if #rejected < 4 then
      rejected[#rejected + 1] = { x = s.x, y = s.y, blockers = blockers,
        -- which of the two kinds of "no" this was, on the first site the caller will look at: a map
        -- full of machines and a map of water both fail every site, and they want opposite fixes
        wanted = wanted, ground_only = ground_only }
    end
  end
  return nil, rejected
end

-- Power coverage cannot be computed statically (supply_area_distance is not on the
-- runtime prototype), so it has to be asked of the engine -- but nauvis is usually a
-- create_global_electric_network surface by now, where every consumer reports the
-- same network id and the answer is meaningless. Verification therefore happens on a
-- dedicated surface that is never given a global grid.
local SANDBOX_SURFACE = "arch-sandbox"
local SANDBOX_SETTLE_TICKS = 40
local SANDBOX_PAD = 64

-- Two surfaces, because two invariants cannot share one ground. Planning a grid has to measure a
-- pole's reach, and `create_global_electric_network` makes that unmeasurable for the life of the
-- save: every pole joins every other, so the probe reads its own ceiling for all four tiers. Running
-- a measurement job needs exactly that -- every machine powered, with no wire routing in the way --
-- and cannot have it undone. So the planner keeps the pad below, which is never given a grid, and
-- the rigs get `arch-lab`, which is converted by the first job and says so (`ideal_grid`).
local LAB_SURFACE = "arch-lab"
-- Which benches have already been painted is a fact about the SAVE, not about this process, so it is
-- kept in `storage` (see `prepared_surface`). As a module local it was the same bug the lab's entity
-- handles had: a client that joins, or a server after a restart, starts with an empty table and paints
-- the pad a second time -- different tiles under the same rig, in one process and not the other.
local PRIME_KEY = "primed_surface_"

-- A lab bench has to be known, not lucky: a script surface gets normal autoplace, so
-- the origin can come up as an iron-ore patch or a Fulgoran ruin, and every placement
-- there reads as "blocked" for reasons that have nothing to do with the card.
-- Clearing once is not enough: chunks finish generating *after* the pad is painted and
-- autoplace fills it in behind us (598 ore/fish/rocks repopulated a pad that had been
-- cleared), so the sweep runs on every take of the surface. Once it is clean the check
-- is just an empty query.
local function prime_sandbox(s, paint)
  if paint then
    local tiles = {}
    for x = -SANDBOX_PAD, SANDBOX_PAD - 1 do
      for y = -SANDBOX_PAD, SANDBOX_PAD - 1 do
        tiles[#tiles + 1] = { name = "grass-1", position = { x = x, y = y }, tile_index = 1 }
      end
    end
    pcall(function() s.set_tiles(tiles) end)
  end
  local cleared = 0
  for _, e in ipairs(s.find_entities_filtered { area = { { -SANDBOX_PAD, -SANDBOX_PAD }, { SANDBOX_PAD, SANDBOX_PAD } } }) do
    if e.type ~= "character" then
      pcall(function() e.destroy() end)
      cleared = cleared + 1
    end
  end
  return cleared
end



local function prepared_surface(name)
  local ready_key = "surface_ready_" .. name
  local s = game.surfaces[name]
  if not s then
    local ok, created = pcall(function() return game.create_surface(name) end)
    if not ok or not created then return nil, nil, "CREATE_FAILED" end
    -- chunk generation is asynchronous: requesting here and placing in the same tick
    -- reads "out-of-map" everywhere, and can_place_entity answers false for terrain
    -- that will exist a few ticks later. Report the wait instead of blaming the card.
    pcall(function() created.request_to_generate_chunks({ 0, 0 }, 9) end)
    storage[ready_key] = game.tick + SANDBOX_SETTLE_TICKS
    return nil, nil, "GENERATING"
  end
  if not storage[ready_key] then
    pcall(function() s.request_to_generate_chunks({ 0, 0 }, 9) end)
    storage[ready_key] = game.tick + SANDBOX_SETTLE_TICKS
    return nil, nil, "GENERATING"
  end
  if game.tick < storage[ready_key] then return nil, nil, "GENERATING" end
  -- The paint happens once per save; the sweep happens on every take, because chunks finish generating
  -- behind us and autoplace repopulates the pad (measured: 598 ore/fish/rocks came back once).
  prime_sandbox(s, storage[PRIME_KEY .. name] ~= true)
  storage[PRIME_KEY .. name] = true
  return s, SANDBOX_PAD, nil
end

-- The grid planner's pad: never given a global electric network, because that is the one thing that
-- makes a pole's reach unanswerable.
local function lab_surface() return prepared_surface(SANDBOX_SURFACE) end

-- The measurement rigs' bench: it takes the grid conversion the planner cannot afford.
local function rig_surface() return prepared_surface(LAB_SURFACE) end

local function power_profile_of(name)
  local p = prototypes.entity[name]
  if not p then return 0, 0 end
  -- Production is J/tick as well. The raw figure made a 60 kW panel out-supply a machine
  -- drawing 75 by a factor of ten, so an under-provisioned grid looked fine.
  local out = getter(p, "get_max_energy_production")
  local cap = (type(out) == "number" and out > 0) and kw_of(math.min(out, 1e6)) or 0
  local es = field(p, "electric_energy_source_prototype")
  if es and (field(es, "buffer_capacity") or 0) > 0 then
    -- An accumulator's "production" is its discharge limit. Counting it as supply lets a
    -- grid of nothing-but-batteries certify itself as powered, which is the exact lie this
    -- figure exists to prevent.
    cap = 0
  end
  return draw_kw_of(p), cap
end

-- Every figure the sizing maths uses is read from the engine, in kW and kJ. The two things
-- that decide a supply -- nameplate output and the accumulator's discharge limit -- differ by
-- a factor of five for the same load, so neither can be inferred from the other.
local function energy_unit_facts(name)
  local p = prototypes.entity[name]
  if not p then return nil end
  local prod = getter(p, "get_max_energy_production")
  local es = field(p, "electric_energy_source_prototype")
  local buffer = es and field(es, "buffer_capacity")
  local inflow = nil
  local outflow = nil
  if es then
    local ok, v = pcall(function() return es.get_input_flow_limit("normal") end)
    if ok then inflow = v end
    local ok2, v2 = pcall(function() return es.get_output_flow_limit("normal") end)
    if ok2 then outflow = v2 end
  end
  return {
    name = name,
    kw_each = kw_of(prod or 0),
    usage_priority = es and field(es, "usage_priority") or nil,
    day_only = (es and field(es, "usage_priority") == "solar") or nil,
    buffer_kj = (type(buffer) == "number" and buffer / 1000) or 0,
    -- an energy source with no flow limit reports infinity, and an infinity does not
    -- survive a JSON round trip; "no limit" is better said as "absent"
    in_kw = (type(inflow) == "number" and inflow < 1e12) and kw_of(inflow) or nil,
    out_kw = (type(outflow) == "number" and outflow < 1e12) and kw_of(outflow) or nil,
    footprint = { (p.tile_width or 1), (p.tile_height or 1) },
  }
end

-- Which supply units this force may actually build. A sized grid that names an entity the
-- player cannot craft fails its own lint one step later, which makes the fix unactionable --
-- so availability decides the menu before any arithmetic does.
--
-- The menu is now every entity the engine will answer a power figure for, rather than five vanilla
-- names: on a modpack whose generator is called something else, the old list could not propose it no
-- matter how many kW it made. The order is still a preference -- sun before fuel (whatever
-- `usage_priority` says), then the smaller unit first so a plan is not handed a 40 MW reactor to run
-- one lamp -- but it is a preference applied to read figures, not to a remembered list of names.
local supply_scan = nil
local function supply_menu()
  if supply_scan then return supply_scan end
  local gens, stores = {}, {}
  for name, p in pairs(prototypes.entity) do
    local place = field(p, "items_to_place_this")
    local place_item = place and place[1] and field(place[1], "name")
    -- a recipe, not just a place item: see roles.candidates -- the creative interfaces are placeable,
    -- have no recipe, and their infinite figures would otherwise be proposed as the plan's power station
    local craftable = false
    if place_item then
      local okr, r = pcall(function() return prototypes.recipe[place_item] ~= nil end)
      craftable = okr and r
    end
    if craftable then
      local f = energy_unit_facts(name)
      if f then
        -- An accumulator's get_max_energy_production is its DISCHARGE limit (300 kW), not a source of
        -- energy, so "has a buffer" has to be asked first: classifying by kW alone filed the
        -- accumulator as a generator, left the storage list empty, and the day-only fallback then
        -- handed back the accumulator as the power station.
        if (f.buffer_kj or 0) > 0 then stores[#stores + 1] = f
        elseif (f.kw_each or 0) > 0 then gens[#gens + 1] = f end
      end
    end
  end
  local function rank(a, b, prefer_small)
    if a.day_only ~= b.day_only then return a.day_only and true or false end
    if a.kw_each ~= b.kw_each then return prefer_small and (a.kw_each < b.kw_each) or (a.kw_each > b.kw_each) end
    return a.name < b.name
  end
  table.sort(gens, function(a, b) return rank(a, b, true) end)
  -- storage wants the opposite bias: the biggest buffer first, so a night is covered by fewer units
  table.sort(stores, function(a, b)
    if (a.buffer_kj or 0) ~= (b.buffer_kj or 0) then return (a.buffer_kj or 0) > (b.buffer_kj or 0) end
    return a.name < b.name
  end)
  supply_scan = { gens = gens, stores = stores }
  return supply_scan
end

local function pick_supply_units(available, want_generator, want_storage, unlock_of)
  local locked = {}
  local function usable(name)
    if want_generator and name ~= want_generator then return nil end
    if want_storage and name ~= want_storage then return nil end
    local f = energy_unit_facts(name)
    if not f then return nil end
    if available and available(name) == false then
      -- "cannot build that" is only half an answer; the half that lets the designer act is
      -- the research that changes it.
      locked[#locked + 1] = { item = name, technology = unlock_of and unlock_of(name) or nil }
      return nil
    end
    return f
  end
  local gens, stores = {}, {}
  if want_generator then
    local f = usable(want_generator)
    if f then gens[#gens + 1] = f end
  end
  if want_storage then
    local f = usable(want_storage)
    if f and (f.buffer_kj or 0) > 0 then stores[#stores + 1] = f end
  end
  local menu = supply_menu()
  for _, f in ipairs(menu.gens) do
    local u = usable(f.name)
    if u then gens[#gens + 1] = u end
  end
  for _, f in ipairs(menu.stores) do
    local u = usable(f.name)
    if u and (u.buffer_kj or 0) > 0 then stores[#stores + 1] = u end
  end
  -- Sun with no buffer cannot survive a night, so a storageless force is steered onto
  -- something dispatchable rather than handed an answer that browns out at 0:45.
  local gen = gens[1]
  if gen and gen.day_only and #stores == 0 then
    for _, g in ipairs(gens) do
      if not g.day_only and g.kw_each > 0 then gen = g; break end
    end
  end
  return gen, stores[1], { generators = (function()
    local out = {}
    for _, g in ipairs(gens) do out[#out + 1] = g.name end
    return out
  end)(), storage = stores[1] and stores[1].name or nil, locked = locked }
end

-- The callback plan_power asks when it wants the grid sized, not merely covered. It gets the
-- wired demand and a count of what the grid already carries, and answers with units to add;
-- the placement and the engine's verdict on each one stay in verify.lua.
local function make_sizer(surface, generator_name, storage_name, available, unlock_of)
  local day = powers.day_model(surface)
  local gen, store, menu = pick_supply_units(available, generator_name, storage_name, unlock_of)
  if not gen then
    return nil, { code = "NO_BUILDABLE_GENERATOR", generator = generator_name, menu = menu }
  end
  local info = { generator = gen, storage = store, day = day, choices = menu }
  if not day then
    return nil, { code = "NO_SURFACE_FOR_DAY_MODEL", generator = gen.name, choices = menu }
  end
  local function wrap(x) return x - math.floor(x) end
  local function arc(a, b) return wrap(b - a) end
  local d, e, m, w = day.phases.dusk, day.phases.evening, day.phases.morning, day.phases.dawn
  local function in_arc(t, a, b) local len = arc(a, b) return len > 0 and arc(a, t) <= len end
  -- the same piecewise-linear curve power.day_model averaged to get `duty`
  local function sun(t)
    t = wrap(t)
    if in_arc(t, d, e) then return 1 - arc(d, t) / math.max(arc(d, e), 1e-9) end
    if in_arc(t, e, m) then return 0 end
    if in_arc(t, m, w) then return arc(m, t) / math.max(arc(m, w), 1e-9) end
    return 1
  end

  local function size(demand_kw, in_grid)
    local counts = in_grid or {}
    local r = powers.size({
      demand_kw = demand_kw, day = day, sun = sun,
      generator = gen.name, gen_kw = gen.kw_each, day_only = gen.day_only,
      storage = store and store.name, acc_kj = store and store.buffer_kj,
      acc_out_kw = store and store.out_kw, acc_in_kw = store and store.in_kw,
      have_panels = counts[gen.name] or 0,
      have_accumulators = store and (counts[store.name] or 0) or 0,
    })
    info.sizing = r
    if not r.ok then return {}, r end
    local units = {}
    if r.panels_extra > 0 then units[#units + 1] = { name = gen.name, count = r.panels_extra } end
    if store and r.accumulators_extra > 0 then
      units[#units + 1] = { name = store.name, count = r.accumulators_extra }
    end
    return units, r
  end
  return size, info
end

-- How much a chain can actually deliver is arithmetic, not design: an internal flow has
-- a supply rate (the sum of claims on that item) and a demand rate (each consumer's own
-- claim scaled by its recipe's ingredient ratio). When demand exceeds supply the region
-- ceiling is supply/ratio, and saying so is what lets the author ship an honest contract
-- instead of guessing a number the measurement will contradict.
local function amount_in(list, item)
  for _, x in ipairs(list or {}) do
    if x.name == item then return rat.toNumber(x.amount) or 0 end
  end
  return 0
end

local function flows_report(entries, internal, db, placements)
  local function is_internal(item)
    for _, i in ipairs(internal or {}) do if i == item then return true end end
    return false
  end
  -- Only a card whose in-port actually fused draws on the internal supply. A card that
  -- was packed beside the cluster wants the same item from outside, and counting it as
  -- internal demand makes the region look under-supplied by machines it never fed.
  local fused_ref = {}
  for _, p in ipairs(placements or {}) do
    if p.fused then fused_ref[p.ref] = true end
  end
  local supply, demand, claimed, external, shared_anchors = {}, {}, {}, {}, {}
  for _, e in ipairs(entries) do
    local card_ = e.card
    local claims = (card_.contract or {}).outputs or {}
    local counted = {}
    for _, p in ipairs((card_.ports or {}).out or {}) do
      -- one card's rate is one card's rate, however many chests it exposes it through:
      -- counting per port made a two-outlet lane look like it produced twice as much
      if is_internal(p.item) and claims[p.item] and not counted[p.item] then
        counted[p.item] = true
        supply[p.item] = (supply[p.item] or 0) + claims[p.item]
      end
      if is_internal(p.item) then
        shared_anchors[p.item] = (shared_anchors[p.item] or 0) + 1
      end
    end
    if fused_ref[e.ref] then
      for _, p in ipairs((card_.ports or {})["in"] or {}) do
        if is_internal(p.item) then
          for out_item, claim in pairs(claims) do
            local r = db.recipes[out_item]
            if r and amount_in(r.ingredients, p.item) > 0 and amount_in(r.products, out_item) > 0 then
              local ratio = amount_in(r.ingredients, p.item) / amount_in(r.products, out_item)
              demand[p.item] = (demand[p.item] or 0) + claim * ratio
              -- keep the ratio of the FLOW, not the sum of ratios: two cells sharing one
              -- plate flow still convert plate->gear at 2:1 each, so the line supports
              -- supply/2 between them, not supply/4. Summing them halved the answer and
              -- the measurement contradicted it.
              claimed[p.item] = (claimed[p.item] or 0) + claim
            end
          end
        end
      end
    else
      -- say what this card still has to be handed from outside, so the gap is not lost
      for _, p in ipairs((card_.ports or {})["in"] or {}) do
        if is_internal(p.item) then
          external[p.item] = external[p.item] or {}
          external[p.item][#external[p.item] + 1] = e.ref
        end
      end
    end
  end
  -- Which belt rows carry this item, and what one row can actually move. A machine
  -- arithmetic that ignores the road under it will cheerfully promise a rate no belt can
  -- deliver, so the carry limit joins the machine limit as a ceiling -- and where more than
  -- one card carries the same item the SUM is unknowable (series or parallel?), so the
  -- figure quoted is the worst single link, which understates rather than overpromises.
  local function belt_capacity_for(item)
    local worst, carriers, tier = nil, 0, nil
    for _, e in ipairs(entries) do
      for _, ln in ipairs(e.card.lanes or {}) do
        if ln.item == item and ln.per_min then
          carriers = carriers + 1
          if not worst or ln.per_min < worst then worst = ln.per_min; tier = ln.tier end
        end
      end
    end
    if not worst then return nil end
    return { per_min = worst, carriers = carriers, tier = tier }
  end

  local out = {}
  for item, need in pairs(demand) do
    local have = supply[item] or 0
    local entry = { item = item, supplied_per_min = have, demanded_per_min = need,
                    feasible = have + 1e-9 >= need }
    if external[item] then entry.demanded_from_outside = external[item] end
    local flow_ratio = (claimed[item] or 0) > 0 and (need / claimed[item]) or 0
    if entry.feasible == false and flow_ratio > 0 then
      entry.max_supported_per_min = have / flow_ratio
      entry.supported_fraction = have / need
      entry.conversion = flow_ratio
      entry.fix = "this flow supports " .. string.format("%.3f", entry.max_supported_per_min)
        .. " per minute of whatever consumes " .. item .. ", shared by its consumers;"
        .. " lower those claims or add a producer of " .. item
    end
    -- Two anchors on one card split that card's rate; the ratio they divide it in is
    -- emergent (arm swing, contention, belt timing) and no static rule can state it,
    -- so the ceiling above is an upper bound and the measurement is the arbiter.
    if shared_anchors[item] and shared_anchors[item] > 1 then
      entry.anchors_sharing_supply = shared_anchors[item]
      entry.ceiling_is_upper_bound = true
      entry.note = shared_anchors[item] .. " anchors draw on one card's rate of " .. item
        .. "; the split between them is not modelled, so treat max_supported_per_min as an"
        .. " upper bound and trust the measurement"
    end
    local belt = belt_capacity_for(item)
    if belt then
      entry.belt_capacity_per_min = belt.per_min
      entry.belt_carrier_rows = belt.carriers
      entry.belt_tier = belt.tier
      if belt.carriers > 1 then
        entry.belt_capacity_is_worst_link = true
        entry.belt_note = belt.carriers .. " cards carry " .. item .. " on belts; whether they are"
          .. " in series or parallel is not derived, so the limit quoted is the worst single row"
      end
      if need > belt.per_min + 1e-9 then
        entry.belt_limited = true
        entry.feasible = false
        entry.max_supported_per_min = math.min(entry.max_supported_per_min or math.huge, belt.per_min)
        entry.supported_fraction = math.min(entry.supported_fraction or 1, belt.per_min / need)
        local rows = math.ceil(need / belt.per_min)
        entry.fix = item .. " wants " .. string.format("%.1f", need) .. "/min but one "
          .. tostring(belt.tier or "belt") .. " row carries " .. string.format("%.1f", belt.per_min)
          .. "/min: run " .. rows .. " parallel rows, or raise the belt tier"
      end
    end
    out[#out + 1] = entry
  end
  table.sort(out, function(a, b) return a.item < b.item end)
  return out
end

-- A rectangle in one of the three shapes a caller may hand it -- {left_top=,right_bottom=}, {{x1,y1},
-- {x2,y2}}, or the BoundingBox struct the selection tool event carries -- normalised to a tile count
-- and two corners. Shared by `region_scan` and `plan_fit`: the box a player dragged is one fact, and
-- two parsers reading it slightly differently is how a scan and a fit disagree about the same rectangle.
local function scan_bounds(a)
  if type(a) ~= "table" then return nil, type(a) end
  local lt, rb = a.left_top or a[1], a.right_bottom or a[2]
  if type(lt) ~= "table" or type(rb) ~= "table" then return nil, "shape" end
  local x1 = math.min(lt.x or lt[1], rb.x or rb[1])
  local y1 = math.min(lt.y or lt[2], rb.y or rb[2])
  local x2 = math.max(lt.x or lt[1], rb.x or rb[1])
  local y2 = math.max(lt.y or lt[2], rb.y or rb[2])
  return { x1 = x1, y1 = y1, x2 = x2, y2 = y2,
    w = math.max(1, math.ceil(x2) - math.floor(x1)), h = math.max(1, math.ceil(y2) - math.floor(y1)),
    left_top = { x = x1, y = y1 }, right_bottom = { x = x2, y = y2 } }
end

-- Read what the player has BUILT, as a card.
--
-- Until now every card in this mod came from a plan or from JSON typed at a terminal, which left the
-- panel with nothing to act on for anyone who does not run one: the design had to exist somewhere the
-- mod put it first. This is that missing door, and it is deliberately narrow -- it turns the contents
-- of a rectangle into entities, positions and live recipes, and claims only what the arithmetic of
-- those recipes gives at nameplate, saying so in the same breath.
--
-- The rectangle is what the vanilla selection tool hands `on_player_selected_area` (`area`, `surface`,
-- `entities`), so the player's own gesture -- pick the tool, drag a box -- is the input.
function M.region_scan(args)
  args = args or {}
  local surface = args.surface ~= nil and resolve_surface(args.surface) or nil
  if args.surface == nil then return fail("NO_SURFACE", "surface = the surface the box was drawn on") end
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  local a = args.area
  local box = scan_bounds(a)
  if not box then
    return fail("BAD_ARGS", "area = {left_top = {x,y}, right_bottom = {x,y}} -- the box the selection tool gave",
      { got = box or type(a) })
  end
  local lt, rb = box.left_top, box.right_bottom
  local x1, y1, x2, y2 = box.x1, box.y1, box.x2, box.y2
  local force_name = args.force or "player"
  local force = game.forces[force_name]
  if not force then return fail("NO_FORCE", tostring(force_name)) end
  if (x2 - x1) * (y2 - y1) > 40000 then
    -- 200x200 is already more entities than a card should describe, and the scan is synchronous: a
    -- player dragging over the whole bus would hang the server for a tick they cannot get back.
    return fail("AREA_TOO_BIG", string.format("%.0fx%.0f is past what one card should hold", x2 - x1, y2 - y1),
      { cells = (x2 - x1) * (y2 - y1), limit = 40000 })
  end
  local found = {}
  local ok, ents = pcall(function()
    return surface.find_entities_filtered { area = { { x1, y1 }, { x2, y2 } } }
  end)
  if not ok then return fail("SCAN_FAILED", tostring(ents)) end
  found = ents

  local entities, skipped, recipes = {}, {}, {}
  local minx, miny, maxx, maxy
  for _, e in ipairs(found) do
    local name = field(e, "name")
    local keep, why
    if not name then
      why = "unnamed"
    elseif e.valid == false then
      why = "gone before the scan finished"
    elseif field(e, "force") and field(e.force, "name") ~= force_name then
      why = "owned by " .. tostring(field(e.force, "name"))
    elseif not roles.exists(name) then
      -- Not in any role this mod knows: it cannot be placed back, so a card holding it would place
      -- short of what was scanned. Named rather than dropped quietly.
      why = "this mod has no placeable role for it"
    else
      keep = true
    end
    if keep then
      local p = e.position or {}
      local px, py = p.x or p[1], p.y or p[2]
      local i = #entities + 1
      entities[i] = { name = name, position = { x = px, y = py }, direction = e.direction }
      minx = (not minx or px < minx) and px or minx
      maxx = (not maxx or px > maxx) and px or maxx
      miny = (not miny or py < miny) and py or miny
      maxy = (not maxy or py > maxy) and py or maxy
      local live = getter(e, "get_recipe")
      local lname = live and field(live, "name")
      if lname then recipes[tostring(i)] = lname end
    else
      local s
      for _, k in ipairs(skipped) do if k.name == (name or "?") then s = k end end
      if s then s.count = s.count + 1 else skipped[#skipped + 1] = { name = name or "?", why = why, count = 1 } end
    end
  end
  if #entities == 0 then
    return fail("NOTHING_SCANNED", "no entity this mod can name stands in that box",
      { area = { { x1, y1 }, { x2, y2 } }, skipped = skipped,
        note = "a box of terrain, ore or someone else's machines reads as nothing, and says so" })
  end

  -- Positions relative to the TOP-LEFT TILE of what was kept, not to the first entity's centre. The
  -- difference is half a tile, and half a tile is the difference between a card and a card that cannot
  -- be built: subtracting 240.5 turned an assembling machine's legal 0.5-grid centre into 0, which
  -- `card_check` rejects as MISALIGNED for a 3x3 footprint. An integral shift keeps every entity's own
  -- fractional alignment, whatever mix of 1x1 belts and 3x3/5x5 machines the box holds.
  local shift_x, shift_y = math.floor(minx), math.floor(miny)
  for _, e in ipairs(entities) do
    e.position.x = e.position.x - shift_x
    e.position.y = e.position.y - shift_y
  end
  table.sort(skipped, function(l, r) return l.name < r.name end)

  -- The claim, at nameplate: whatever these machines are set to right now, times their speed. Exact
  -- rationals until the last step, because summing twelve 0.1-ish rates in floats is how a card ends
  -- up claiming 1.1999999 of something.
  local outputs, fluid_outputs, nameplate_of = {}, {}, {}
  for i, e in ipairs(entities) do
    local rname = recipes[tostring(i)]
    local r = rname and prototypes.recipe[rname]
    local proto = prototypes.entity[e.name]
    local speed = proto and getter(proto, "get_crafting_speed")
    if r and speed and speed > 0 and (field(r, "energy") or 0) > 0 then
      local per = rat.mul(rat.from(speed), rat.div(rat.new(60, 1), rat.from(field(r, "energy"))))
      for _, prod in ipairs(field(r, "products") or {}) do
        local pname = field(prod, "name")
        local amount = field(prod, "amount") or field(prod, "amount_min") or 1
        local add = rat.mul(per, rat.from(amount))
        if field(prod, "type") == "fluid" then
          fluid_outputs[pname] = rat.add(fluid_outputs[pname] or rat.new(0), add)
        else
          outputs[pname] = rat.add(outputs[pname] or rat.new(0), add)
        end
        nameplate_of[i] = tostring(rname)
      end
    end
  end
  local claim, claim_fluid = {}, {}
  for k, v in pairs(outputs) do claim[k] = rat.toNumber(v) end
  for k, v in pairs(fluid_outputs) do claim_fluid[k] = rat.toNumber(v) end

  local wide = math.ceil(maxx + 0.5) - shift_x
  local high = math.ceil(maxy + 0.5) - shift_y
  return {
    card = {
      name = args.name or ("scanned " .. tostring(wide) .. "x" .. tostring(high)),
      entities = entities,
      contract = { outputs = claim, fluid_outputs = next(claim_fluid) and claim_fluid or nil },
      machine_recipes = next(recipes) and recipes or nil,
    },
    -- Said out loud next to the card, because a caller who reads only `card.contract` would take a
    -- nameplate sum for a measurement, which is the one mistake this project will not make twice.
    claim_how = (#entities > 0) and (string.format(
      "nameplate: %d machines read live, at their current recipe and speed -- NOT measured. "
      .. "card_lab on this card is what turns it into a number the game confirmed.", #nameplate_of)) or nil,
    surface = field(surface, "name"),
    area = { left_top = { x = x1, y = y1 }, right_bottom = { x = x2, y = y2 } },
    -- The world position this card was cut from: place it at this origin and the entities land back
    -- where they were scanned, half-tile alignments and all.
    origin = { x = shift_x, y = shift_y },
    entities_kept = #entities,
    machines_bound = (function() local n = 0 for _ in pairs(nameplate_of) do n = n + 1 end return n end)(),
    skipped = skipped,
    next = "card_freeze {card = <this card>, allow_unmeasured = true} to keep it, then card_lab to measure it",
  }
end

-- Does this plan fit where the player is standing? The box question, answered before anything is built.
--
-- A plan says "20 furnaces"; the ground says "I have 34x9 next to this bus". Turning one into the other
-- is the step where a designer's spreadsheet and a player's factory part company, and it is the step
-- helmod-style tools leave out. So: pick a lane card, pick a spacing, and this says how many lanes fit,
-- how many the plan wanted, what the shortfall is in machines AND in rate, and -- when the ground is
-- not just empty space -- where a lane actually cannot be placed because something stands there.
function M.plan_fit(args)
  args = args or {}
  local surface = args.surface ~= nil and resolve_surface(args.surface) or nil
  if args.surface == nil then return fail("NO_SURFACE", "surface = the surface the box was drawn on") end
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  local box = scan_bounds(args.area)
  if not box then
    return fail("BAD_ARGS", "area = {left_top = {x,y}, right_bottom = {x,y}} -- the box to fill",
      { got = type(args.area) })
  end
  local x1, y1 = box.x1, box.y1
  local lanes_wanted = math.floor(tonumber(args.lanes) or 0)
  if lanes_wanted < 1 then return fail("BAD_ARGS", "lanes = how many lanes the plan wants, 1 up",
    { got = args.lanes }) end
  local form = { item = args.item, rate = args.rate, unit = args.unit, machine = args.machine,
    module = args.module, module_count = args.module_count, power = args.power, force = args.force,
    item_index = args.item_index, machine_index = args.machine_index, module_index = args.module_index,
    unit_index = args.unit_index,
    -- The plan behind a fit is aimed at the ground the ghosts would stand on, because that is the one
    -- surface the player has actually pointed at. Without it, `fit` answers "how many lanes fit" for a
    -- factory the planet will not run.
    surface = field(surface, "name") }
  local lane = M.card_example({ machines = 1, furnace = args.furnace, belt = args.belt,
    inserter = args.inserter, chest = args.chest, spacing = args.spacing, force = args.force,
    outlets = args.outlets })
  if lane.fail then return lane end
  local planned = M.plan_form(form)
  if planned.fail then return planned end
  local surf = (planned.plan or {}).surface
  -- The lane template this method can lay is a smelting lane: a furnace row making iron plate. Ask
  -- for gears and the honest answer is that it cannot lay them -- not a box full of furnaces and a
  -- `rate_placed` counted in plates. `card_example` builds one shape, and arithmetic that ignores what
  -- the lane produces reports a number for a factory nobody asked for. Widening it means a lane
  -- template per crafting category, which is the named next step.
  local item = planned.item
  local made_by_lane = (lane.contract or {}).outputs or {}
  local lane_makes = {}
  for name, rate in pairs(made_by_lane) do
    lane_makes[#lane_makes + 1] = name .. " at " .. tostring(rate) .. "/min"
  end
  table.sort(lane_makes)
  local per_lane = made_by_lane[item]
  if not per_lane then
    return fail("LANE_NOT_FOR_ITEM",
      "the lane this fits into a box makes " .. table.concat(lane_makes, ", ") .. ", not " .. item, {
        asked_for = item,
        lane_makes = made_by_lane,
        lane_card = lane.name,
        use_instead = "plan_form gives the machine counts; card_compose and card_place lay any card, and card_lab measures it",
        what_this_does = "fit a smelting lane into a rectangle, and lay it as ghosts",
      })
  end
  -- `footprint` keeps the {width,height} shape card_check's stats use; the first version of this
  -- feature called the lane count `lanes` and the box `footprint = {w,h}`, and both collided --
  -- `lanes` is a card's list of belt-capacity rows, so compose crashed on `ipairs(slot.lanes)` with
  -- a number in it, arriving as a RUNTIME_ERROR in someone else's file.

  -- Row-packing the lanes into the rectangle: as many per row as the lane's width plus the gap allows,
  -- as many rows as the height allows. Reported in cells, because "it fits" without the numbers is the
  -- kind of answer a player cannot check.
  local gap = lane.gap_cells or 0
  local pitch_w = lane.footprint.width + gap
  local per_row = math.max(0, math.floor((box.w - gap) / pitch_w))
  local rows = math.max(0, math.floor((box.h + gap) / lane.footprint.height))
  local capacity = per_row * rows
  local placed = math.min(lanes_wanted, capacity)
  local out = {
    lane = { name = lane.name, footprint = lane.footprint, spacing = lane.spacing, gap = gap,
      per_lane_rate = per_lane },
    box = { w = box.w, h = box.h, surface = field(surface, "name"),
      left_top = box.left_top, right_bottom = box.right_bottom },
    per_row = per_row, rows = rows, lanes_fit = capacity, lanes_wanted = lanes_wanted,
    lanes_placed = placed,
    -- Rate, not just counts: 6 of 20 lanes is a third of the line, and the number a player is choosing
    -- between is the one per minute they end up with.
    rate_placed = placed * per_lane,
    rate_wanted = planned.sent.want.rate_per_min,
    shortfall_lanes = math.max(0, lanes_wanted - capacity),
    fits = capacity >= lanes_wanted,
    -- What the planet thinks of the ground the ghosts are going into. A step this surface will not run
    -- was already refused two calls up, inside `M.solve` -- so what survives to here is the other news:
    -- `big-mining-drill`'s frame wants pressure 4000 and nauvis answers 1000, which is a delivery
    -- problem for a player and not a reason to refuse the arithmetic.
    surface = surf,
  }
  if out.shortfall_lanes > 0 then
    out.shortfall_rate = out.shortfall_lanes * per_lane
    -- capacity, not shortfall: the first version of this sentence put the number of lanes that did NOT
    -- fit where the number that did belongs, so a box holding one of four reported "3 of 4 lanes fit".
    -- The advice is the part a player reads, which makes it the part a wrong number in matters most.
    out.next = string.format(
      "only %d of %d lanes fit. Wider box, smaller spacing (now %s), a shorter lane, or accept %s/min less.",
      capacity, lanes_wanted, tostring(lane.spacing),
      string.format("%.1f", out.shortfall_lanes * per_lane))
  else
    out.next = "fits -- build it with plan_fit {build = true}"
  end

  -- Build it: the lanes composed into one card at the cells they were packed into, frozen, and put
  -- down as ghosts inside the box. Composing rather than placing one lane at a time, because compose
  -- is where seams are decided -- if lane two's output chest lands on lane one's belt, that is a
  -- conflict worth refusing before a player gets 56 ghosts that cannot be built.
  if args.build then
    local slots, skipped_rows = {}, 0
    for i = 1, placed do
      local row, col = math.floor((i - 1) / per_row), (i - 1) % per_row
      if row < rows then
        slots[#slots + 1] = {
          card = lane,
          at = { x = x1 + col * (lane.footprint.width + gap), y = y1 + row * (lane.footprint.height + gap) },
        }
      else
        skipped_rows = skipped_rows + 1
      end
    end
    if #slots == 0 then return fail("NO_ROOM_IN_BOX", "the box holds no lane at this spacing",
      { box = out.box, lane = out.lane }) end
    local merged = M.card_compose({ slots = slots, force = force_name })
    if merged.fail then return merged end
    -- `card_compose` answers with the card itself -- its `name`, `entities`, `lint` -- rather than one
    -- wrapped in a `card` field. Reading `merged.card` here handed the freeze a nil, and the freeze
    -- answered "run card_lab first": a wrong shape surfacing as advice about a different method.
    local frozen = M.card_freeze({ card = merged, name = args.name or "planned line",
      allow_unmeasured = true, force = force_name })
    if frozen.fail then return frozen end
    local site = M.card_place({ name = frozen.name, surface = field(surface, "name"), ghosts = true,
      origin = { x = x1, y = y1 }, force = force_name })
    -- A method called DIRECTLY answers with its payload, or with the `fail` marker -- the `{ok=,data=}`
    -- shape is added by the remote interface and by `envelope`, for callers that cannot see the
    -- difference. Checking `site.ok` here read a successful placement as a refusal with no code, which
    -- is the mistake this file has now made in three different places: it is why the envelope exists.
    out.built = { card = frozen.name, lanes_used = #slots, composed = #(merged.entities or {}),
      placed = (not site.fail) and { ghosts = site.ghosts, origin = site.origin,
        refused = site.refused } or nil }
    if site.fail then
      out.built.refused = { code = site.code, msg = site.msg, detail = site.detail }
    end
    out.next = (not site.fail) and string.format("%d ghosts down at %s,%s on %s -- measure them with card_lab",
      site.ghosts, tostring(site.origin and site.origin.x), tostring(site.origin and site.origin.y),
      tostring(site.surface))
      or ("the composed line does not fit where the box starts: " .. tostring(site.code)
        .. (site.detail and site.detail.ground and site.detail.ground.tile
          and (" (the ground there is " .. tostring(site.detail.ground.tile) .. ")") or ""))
  end
  return out
end

-- Lay several cards out on one patch of ground. Structure first (compose decides every
-- seam and rejects overlaps), then ground truth for the finished region as a whole --
-- sliding the whole layout until the terrain takes it is obstacle avoidance that does
-- not need to be guessed per card.
function M.region_layout(args)
  args = args or {}
  storage.cards = storage.cards or {}
  local function frozen(name)
    local rec = storage.cards[name]
    return rec and rec.card
  end

  local entries_arg, entries_why = host.list_arg(args.entries)
  if not entries_arg then
    return fail("BAD_ARGS", "entries must be a list of { name = <frozen> | card = <inline>, count = n }",
      { got = entries_why })
  end
  local entries = {}
  for i, spec in ipairs(entries_arg) do
    local src = spec.card or (spec.name and frozen(spec.name))
    if not src then
      return fail("UNKNOWN_CARD", "entry " .. i .. " names no frozen card", M.cards({}))
    end
    local copies = spec.count or 1
    for c = 1, copies do
      entries[#entries + 1] = {
        ref = (spec.name or ("entry" .. i)) .. (copies > 1 and ("#" .. c) or ""),
        card = src,
      }
    end
  end
  if #entries == 0 then
    return fail("BAD_ARGS", "entries = [ { name = <frozen> | card = <inline>, count = n }, ... ]")
  end

  -- A pole name is checked here rather than at placement. `plan_power` refuses an unknown one, but the
  -- tier loop below would take the refusal as "this tier failed" and escalate -- reporting a plan
  -- built with a different pole than the caller asked for, and `ok`.
  if args.pole and not roles.exists(args.pole) then
    return fail("UNKNOWN_POLE", "pole " .. tostring(args.pole) .. " is not an entity on this install",
      { pole = args.pole, known = roles.names("pole") })
  end

  -- `gap` is the clear space the packer leaves between cards. Exposed rather than fixed at the
  -- packer's default of 2 because a player deciding "does this fit my box" is asking about the aisle,
  -- and the aisle is the part they will route through later.
  local layout, code = region.layout(entries, { compose = compose, gap = args.gap })
  if not layout then return fail(code or "LAYOUT_FAILED", "could not lay these cards out") end

  local merged = card.normalize(layout.card)
  -- Two different surfaces answer two different questions, and conflating them once produced a
  -- power plan that covered 12 of 12 machines and then, applied, covered 6 of 12.
  --   `surface` / `site`  -- where this region fits ON THE GROUND, obstacles included.
  --   `plan_surface`       -- the deterministic sandbox the grid is planned and verified on,
  --                          so a plan reproduces and card_verify agrees with it.
  local surface = surface_or_default(args.surface)
  if not surface then
    return fail("NO_SURFACE", "surface " .. tostring(args.surface) .. " is not in this save",
      { surfaces = keys_of(game.surfaces, nil) })
  end
  local site, rejected = find_card_site(surface, merged, args.force or "player", args.origin, nil)
  local plan_surface, plan_site_limit = surface, nil
  if args.power then
    local pad, why
    plan_surface, pad, why = lab_surface()
    if not plan_surface then
      -- Refuse, the way `card_verify`, `power_plan` and `card_fix_power` all do. Falling through to
      -- the player's main surface was not a slower answer: on a surface that already carries a global
      -- electric network every pole joins every other, so the probe reads its own ceiling and the
      -- ladder reported 44 tiles of wire for a pole that reaches 7 -- and cached that for the rest of
      -- the session under the pole's name.
      if why == "GENERATING" then
        return fail("SANDBOX_GENERATING", "planning surface still generating; call again")
      end
      return fail("SANDBOX_" .. tostring(why or "UNAVAILABLE"),
        "no planning surface, and the grid cannot be measured on a surface that is not the sandbox",
        { why = why })
    end
    plan_site_limit = pad
  end

  local db = world_db()
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
  refresh_availability(db, force.name)
  local l = card.lint(merged, { available = availability_checker(db, force) })

  -- A region that lints but cannot be powered is still not buildable, so `power` folds the
  -- grid into the same card instead of leaving it as advice. The poles are appended, never
  -- spliced in, so every port index downstream keeps pointing where it did before.
  local power
  local plan_site = plan_site_limit and find_card_site(plan_surface, merged, args.force or "player", args.origin, plan_site_limit) or site
  if args.power and plan_site and #l.errors == 0 then
    local sizer, sizer_info
    if args.size ~= false then
      sizer, sizer_info = make_sizer(plan_surface, args.generator, args.storage,
        availability_checker(db, force), function(name)
          local r = db.recipes and db.recipes[name]
          return r and r.techs and r.techs[1] or nil
        end)
    end
    -- A dense region that two small poles cannot bridge is often one medium pole away from
    -- being one grid, and the plan cannot say "done" until it is.
    --
    -- Reach is not readable off a pole prototype (`supply_area` raises, `connection_distance` is nil),
    -- so the ladder's order comes from measuring each candidate -- the same figure plan_power uses,
    -- read through its cache rather than re-probed. Ascending, so the first tier that suffices is also
    -- the cheapest tier that suffices, and a modded pole joins the ladder by being measured like the
    -- rest instead of needing an entry in a vanilla list.
    --
    -- The locked ones are measured too, on purpose: half of `unmerged_fix`'s value is naming the pole
    -- you cannot build yet together with the research that changes it, and a name-free ladder that only
    -- contains unlocked entries would lose that.
    local can_build = availability_checker(db, force)
    local ladder = roles.ladder("pole", {
      order = "asc",
      measure_of = function(name)
        local f = verify.measure_facts(plan_surface, args.force or "player", name)
        return f and f.wire or nil
      end,
    }) or {}
    local tiers, pole_reach = {}, nil
    if args.pole then tiers[#tiers + 1] = args.pole end
    for _, e in ipairs(ladder) do
      if e.name ~= args.pole and can_build(e.name) ~= false then tiers[#tiers + 1] = e.name end
    end
    local plan, pole_used, attempts = nil, nil, {}
    for _, pole in ipairs(tiers) do
      plan = verify.plan_power(plan_surface, merged, {
        force = args.force or "player", origin = plan_site, power_of = power_profile_of,
        pole = pole, supply = args.supply, max_adds = args.max_adds, size = sizer,
      })
      pole_used = pole
      attempts[#attempts + 1] = { pole = pole, wires = plan.facts and plan.facts.wire_tiles,
        added = plan.to_add, networks = plan.networks_after, unserved = plan.still_unserved,
        probes = plan.probes, exhausted = plan.exhausted_search }
      -- Take the trial apart before trying the next tier. Leaving 59 entities standing on the
      -- site means the next attempt reads them as obstacles, and the region it plans is the
      -- one from the previous attempt plus a copy of itself.
      local cleared = verify.destroy(plan._built)
      plan._built = nil
      plan.destroyed = (plan.destroyed or 0) + cleared
      if not plan.error and plan.still_unserved == 0 and plan.networks_after <= 1 then break end
    end
    if not plan then
      -- `tiers` is empty when nothing in the pole role is buildable here -- a modded save whose poles
      -- all sit behind an unresearched recipe. Indexing the nil plan was a runtime error out of the
      -- dispatcher, on the one path where the answer should have been a named refusal.
      return fail("NO_BUILDABLE_POLE", "no electric pole in this install can be built by this force",
        { pole = args.pole, ladder = (function()
            local l = {}
            for _, e in ipairs(ladder) do l[#l + 1] = { name = e.name, unlocked = e.unlocked } end
            return l
          end)() })
    end
    plan.pole = pole_used
    plan.poles_tried = attempts
    -- what the winner actually reaches, so "larger" below is a comparison and not a remembered list
    for _, e in ipairs(ladder) do if e.name == pole_used then pole_reach = e.figure end end
    plan.pole_ladder = ladder
    if plan.unmerged and #plan.unmerged > 0 then
      -- Two grids one tile apart with nowhere to stand is a real answer, not a failure to
      -- try hard enough -- but it is only useful with the remedy attached. Longer reach is
      -- the way out, so name the next tier AND the research that makes it buildable.
      -- The next tier is the smallest measured reach that beats the winner's, which is also the only
      -- answer that cannot be wrong: a modded install may have ten poles no vanilla ladder mentions,
      -- and the gap on the ground is a distance, not a name.
      local nxt, nxt_reach
      for _, e in ipairs(ladder) do
        if e.name ~= pole_used and e.figure and (not pole_reach or e.figure > pole_reach) then
          if not nxt or e.figure < nxt_reach then nxt, nxt_reach = e.name, e.figure end
        end
      end
      local tech = nil
      if nxt then
        local r = db.recipes and db.recipes[nxt]
        tech = r and r.techs and r.techs[1] or nil
      end
      local note
      if not nxt then
        note = "nothing reaches further than the " .. tostring(pole_used)
          .. (pole_reach and (" (wire " .. tostring(pole_reach) .. " tiles)") or "")
          .. "; split the region or move these cards closer"
      else
        note = "a longer-reach pole bridges a gap the " .. pole_used .. " cannot: " .. nxt
          .. " (wire " .. tostring(nxt_reach) .. " vs " .. tostring(pole_reach) .. ")"
        if tech then note = note .. ", locked behind research " .. tech end
      end
      plan.unmerged_fix = {
        pole = nxt, reach_tiles = nxt_reach, current_reach_tiles = pole_reach,
        technology = tech,
        buildable = nxt and (can_build(nxt) ~= false) or false,
        note = note,
      }
    end
    if plan.error then
      power = { ok = false, code = plan.error, pole = plan.pole }
    else
      local ents = {}
      for _, e in ipairs(merged.entities) do ents[#ents + 1] = e end
      for _, s in ipairs(plan.suggestion) do
        ents[#ents + 1] = { name = s.name, position = s.position }
      end
      local with_grid = card.normalize({
        name = merged.name, entities = ents, ports = merged.ports, contract = merged.contract,
        machine_recipes = merged.machine_recipes, internal_flows = merged.internal_flows,
        anchors = merged.anchors,
      })
      local l2 = card.lint(with_grid, { available = availability_checker(db, force) })
      if #l2.errors == 0 then merged, l = with_grid, l2 end
      power = {
        ok = plan.still_unserved == 0 and #l2.errors == 0,
        added = plan.to_add, probes = plan.probes, exhausted_search = plan.exhausted_search,
        networks_before = plan.networks_before, networks_after = plan.networks_after,
        chains = plan.chains, supply_added = plan.supply_added, unmerged = plan.unmerged,
        pole = plan.pole, poles_tried = plan.poles_tried, probes_budget = plan.probe_budget,
        -- Which ground the reach figures were measured on, because the answer is only worth as much
        -- as that surface can tell: a pole ladder measured on a surface with a global electric
        -- network reports the probe's ceiling for every tier, and looks ascending while it lies.
        planned_on = plan_surface and field(plan_surface, "name") or nil,
        -- the ladder it ranked on, with the figure per pole (or why there is none): a plan that says
        -- "the cheapest sufficient pole won" is only checkable if the ordering is visible
        pole_ladder = (function()
          local l = {}
          for _, e in ipairs(ladder) do
            l[#l + 1] = { name = e.name, wire_tiles = e.figure, unlocked = e.unlocked,
                          not_measured = e.figure_error }
          end
          return l
        end)(),
        unmerged_fix = plan.unmerged_fix,
        served = plan.served, powered = plan.powered, still_unserved = plan.still_unserved,
        demand_kw = plan.demand_kw, supply_kw = plan.supply_kw, facts = plan.facts,
        lint_errors = l2.errors,
        -- the arithmetic behind the supply that went in: what each unit is rated at, what
        -- the day model assumes, and how many panels/accumulators it decided on
        sizing = (plan.sizing and plan.sizing.trail) or sizer_info,
        placed_units = plan.sizing and plan.sizing.placed,
        unit_shortfall = plan.sizing and plan.sizing.short,
      }
    end
  elseif args.power and not plan_site and #l.errors == 0 then
    -- An absent `power` and a power plan that came out clean are two different answers, and a
    -- caller reading data.power.ok cannot tell them apart: both are undefined. So the plan says
    -- which one it is, and how big the region turned out to be.
    local minx, miny, maxx, maxy
    for _, e in ipairs(merged.entities) do
      local p = prototypes.entity[e.name]
      local hw, hh = ((p and p.tile_width) or 1) / 2, ((p and p.tile_height) or 1) / 2
      minx = math.min(minx or (e.position.x - hw), e.position.x - hw)
      maxx = math.max(maxx or (e.position.x + hw), e.position.x + hw)
      miny = math.min(miny or (e.position.y - hh), e.position.y - hh)
      maxy = math.max(maxy or (e.position.y + hh), e.position.y + hh)
    end
    power = {
      planned = false, reason = "NO_CLEAR_SITE",
      msg = "the grid was not planned: no candidate site fits a region this size",
      region_tiles = maxx and { width = math.ceil(maxx - minx), height = math.ceil(maxy - miny) } or nil,
      rejections = #rejected > 0 and rejected or nil,
    }
  end

  return {
    entities = #merged.entities,
    ports = merged.ports,
    contract = merged.contract,
    internal_flows = merged.internal_flows,
    placements = layout.placements,
    unplaced = layout.unplaced,
    rejected_offsets = layout.rejections,
    flows = flows_report(entries, merged.internal_flows, db, layout.placements),
    site = site,
    site_rejections = rejected,
    -- the policy the composition deliberately deferred: a finished region that hands
    -- nothing out is not a region, it is a pile of machines feeding each other
    nothing_exports = next((merged.contract or {}).outputs or {}) == nil,
    lint = { errors = l.errors, warnings = l.warnings, stats = l.stats },
    power = power,
    ok = #l.errors == 0,
    card = merged,
  }
end

function M.card_verify(args)
  args = args or {}
  if not args.card then return fail("BAD_ARGS", "card is required") end
  local normalized = card.normalize(args.card)
  if #normalized.entities == 0 then return fail("EMPTY_CARD", "no entities") end

  local db = world_db()
  local force_name = args.force or "player"
  local force = game.forces[force_name]
  if not force then return fail("NO_FORCE", force_name) end
  refresh_availability(db, force_name)

  -- Two-tier feedback: placement is cheap but not free, so an unlintable card never gets here.
  if args.lint ~= false then
    local opts = {}
    if not args.ignore_locked then opts.available = availability_checker(db, force) end
    local l = card.lint(normalized, opts)
    if #l.errors > 0 then
      return fail("CARD_DOES_NOT_LINT", #l.errors .. " lint error(s); fix them before paying for verification",
        { errors = l.errors, warnings = l.warnings })
    end
  end

  -- default to the no-global-grid sandbox; pass surface= to check against a real base
  local surface, site_limit
  if args.surface then
    surface = resolve_surface(args.surface)
  else
    local pad, why
    surface, pad, why = lab_surface()
    if not surface then
      if why == "GENERATING" then
        return fail("SANDBOX_GENERATING", "the verification surface is still generating chunks; call again in a second")
      end
      return fail("NO_SANDBOX", tostring(why))
    end
    site_limit = pad
  end
  if not surface then return fail("NO_SURFACE", tostring(args.surface or "sandbox")) end

  local origin, rejected = find_card_site(surface, normalized, force_name, args.origin, site_limit)
  if not origin then
    return fail("NO_CLEAR_SITE", "no candidate site fits this card; pass an explicit origin", rejected)
  end

  -- args.global_grid is the escape hatch for checking a card inside an existing base;
  -- by default no grid is created, so electric_network_id means what it should mean.
  if args.global_grid then pcall(function() surface.create_global_electric_network() end) end
  local v = verify.verify(surface, normalized, {
    force = force_name, origin = origin, power_of = power_profile_of,
    require_single_network = args.require_single_network,
  })
  v.origin = origin
  v.surface = field(surface, "name") or tostring(args.surface)
  v.card_name = normalized.name
  v.destroyed = args.keep and 0 or verify.destroy(v._built or {})
  if args.keep then v.kept = true end
  v.ok = #v.errors == 0
  v._built = nil
  return v
end

-- Measure a submitted card against the output it claims. Lint first, then place,
-- then feed every in-port and collect from every out-port, then judge.
-- Power is supplied by the rig rather than by the card, so a card that forgot its
-- poles still yields a throughput number; card_verify is what reports coverage.
-- A job counts as live while it is either measuring or discovering. `probing` is a state a job can
-- sit in for a second of real time and a hundred entities' worth of fixtures, so treating it as
-- idle lets a second card_lab start on top of it and neither job can be taken apart.
local function lab_is_live(j)
  return j and (j.state == "running" or j.state == "probing" or j.state == "proving") or false
end

-- A machine that draws nothing from any cell of any face must not leave the caller waiting on a
-- verdict that never arrives, so discovery is bounded in game time the way the window is; and a
-- pass has to outlast one craft before "nothing was taken" means anything.
local LAB_PROBE_TICKS = 1800
local LAB_PROBE_SETTLE = 90
-- Long enough for a box to have taken a mouthful if the row is sitting on it, and short enough that
-- a wrong guess costs the caller almost nothing.
local LAB_PROVE_SETTLE = 120

-- Which entities hold a fluid box that a port could mean. A storage tank holds fluid but has no
-- box to fill: it is the reservoir, not the customer.
local FLUID_BOX_KINDS = {
  ["assembling-machine"] = true, furnace = true, boiler = true, ["mining-drill"] = true,
  pump = true, generator = true, reactor = true, ["electric-energy-interface"] = true,
}

function M.card_lab(args)
  args = args or {}
  if lab_is_live(storage.lab) then
    return fail("LAB_BUSY", "job " .. tostring(storage.lab.id) .. " still " .. storage.lab.state
      .. "; call lab_stop")
  end
  if not args.card then return fail("BAD_ARGS", "card is required") end

  local normalized = card.normalize(args.card)
  if #normalized.entities == 0 then return fail("EMPTY_CARD", "no entities") end

  local db = world_db()
  local force_name = args.force or "player"
  local force = game.forces[force_name]
  if not force then return fail("NO_FORCE", force_name) end
  refresh_availability(db, force_name)

  local opts = {}
  if not args.ignore_locked then opts.available = availability_checker(db, force) end
  local l = card.lint(normalized, opts)
  if #l.errors > 0 then
    return fail("CARD_DOES_NOT_LINT", #l.errors .. " lint error(s); fix them before paying for a measurement",
      { errors = l.errors, warnings = l.warnings })
  end

  local ports_in = normalized.ports["in"] or {}
  local ports_out = normalized.ports.out or {}
  if #ports_in == 0 or #ports_out == 0 then
    return fail("CARD_NO_PORTS", "measuring needs at least one in port and one out port",
      { in_ports = #ports_in, out_ports = #ports_out })
  end
  local contract = (normalized.contract or {}).outputs or {}
  -- A refinery's product is a fluid, so `contract.outputs` -- which is a map of items -- cannot
  -- carry its claim at all. Fluid claims live beside them rather than inside them: one key that
  -- sometimes means an item and sometimes means a fluid is how an oil card starts looking like a
  -- smelting card to everything downstream.
  local fluid_contract = (normalized.contract or {}).fluid_outputs or {}
  if next(contract) == nil and next(fluid_contract) == nil then
    return fail("CARD_NO_CONTRACT", "contract.outputs or contract.fluid_outputs is required;"
      .. " without a claim to check there is no verdict")
  end

  -- Unnamed means the bench, not the player's world: `create_global_electric_network` below cannot
  -- be undone, and a surface that has been given one answers "is this card covered?" the same way for
  -- every card -- including one with no poles. A caller who names a surface still gets that surface.
  local surface, bench_pad, bench_why
  if args.surface == nil then
    surface, bench_pad, bench_why = rig_surface()
    if not surface then
      -- The bench is created on the first request and its chunks finish a moment later, so the
      -- honest answer here is "ask again" rather than a quiet substitution.
      return fail("SANDBOX_" .. tostring(bench_why or "UNAVAILABLE"),
        bench_why == "GENERATING" and "the measurement bench is still generating; call again"
          or "the measurement bench could not be prepared", { reason = bench_why })
    end
  else
    surface = resolve_surface(args.surface)
    if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  end
  local seconds = args.seconds or 30
  local speed = args.speed or 20

  -- The site search has to see the fixtures, not only the card. The lab surface is scattered with
  -- ore tiles by design, so almost any spot fits a refinery and then has room for no tank on any
  -- of its four faces -- which surfaces as a card that cannot be measured at all. Probe with the
  -- supply and collector tanks already standing where they would go.
  local fluid_ports = 0
  for _, list in ipairs({ ports_in, ports_out }) do
    for _, p in ipairs(list) do if p.fluid then fluid_ports = fluid_ports + 1 end end
  end
  local site_card = normalized
  if fluid_ports > 0 then
    local probe = { name = normalized.name, entities = {}, ports = normalized.ports,
                    anchors = normalized.anchors, contract = normalized.contract,
                    machine_recipes = normalized.machine_recipes }
    for _, e in ipairs(normalized.entities) do probe.entities[#probe.entities + 1] = e end
    local seen = {}
    for _, list in ipairs({ ports_in, ports_out }) do
      for _, p in ipairs(list) do
        local host = p.entity and normalized.entities[p.entity]
        if p.fluid and host and host.position then
          local q = prototypes.entity[host.name]
          local w, h = (q and q.tile_width) or 1, (q and q.tile_height) or 1
          -- A supply run's tank stands two cells beyond the row of pipes that lies on the machine's
          -- border, which is one cell further out than a tank placed flush against it: the pipes in
          -- between are what reaches the box's cell.
          for _, side in ipairs({
            { h / 2 + 2.5, 0 }, { -(h / 2 + 2.5), 0 },
            { 0, w / 2 + 2.5 }, { 0, -(w / 2 + 2.5) },
          }) do
            local pos = { x = host.position.x + side[1], y = host.position.y + side[2] }
            local k = pos.x .. "," .. pos.y
            if not seen[k] then
              seen[k] = true
              probe.entities[#probe.entities + 1] = { name = "storage-tank", position = pos }
            end
          end
        end
      end
    end
    site_card = probe
  end

  -- Inside the pad, when the surface is the bench: `prime_sandbox` clears that square on every
  -- take of it, and a site outside the square is ground nobody sweeps -- so a job placed there
  -- survives its own teardown check, and the next run finds its furnace standing where the next
  -- run's fuel arm wants to be. (Measured: `fuelled = 0, fuel_blocked = 3601` on a second run of
  -- the suite in one server session, which is this bug.)
  local origin, rejected = find_card_site(surface, site_card, force_name, args.origin, bench_pad)
  if not origin then
    return fail("NO_CLEAR_SITE", "no candidate site fits this card on the bench; pass an explicit origin",
      { rejected = rejected, bench_pad = bench_pad })
  end

  local grid_before = field(surface, "has_global_electric_network")
  pcall(function() surface.create_global_electric_network() end)
  -- Irreversible, so it is reported: after this call the surface answers "is this card
  -- covered?" for every card the same way, and only the next caller can be told that.
  local ideal_grid = {
    surface = field(surface, "name"), was_global = grid_before == true,
    converted_here = grid_before ~= true and field(surface, "has_global_electric_network") == true,
  }
  local built, _, problems = verify.place(surface, normalized, origin, force_name)
  if #problems > 0 then
    verify.destroy(built)
    return fail("CARD_PLACE_FAILED", problems[1].msg, { problems = problems })
  end

  local ents_array = {}
  for _, rec in pairs(built) do ents_array[#ents_array + 1] = rec.entity end

  -- The rig supplies grid power so a card without poles still yields a throughput
  -- number; coverage itself is reported by card_verify, not papered over here.
  local gens = {}
  if args.supply ~= false then
    for i = 1, (args.generators or 1) do
      local g = surface.create_entity {
        name = "electric-energy-interface",
        position = { x = origin.x - 2, y = origin.y + 14 + i }, force = force_name,
      }
      if g then gens[#gens + 1] = g; ents_array[#ents_array + 1] = g end
    end
  end

  -- Fuel is not a grid service, so nothing supplies it implicitly: a stone furnace
  -- loaded with ore and no coal runs the whole window and yields 0, which looks
  -- exactly like a broken card. The rig seeds it and keeps it topped, like the lane
  -- rig does, and reports that it did.
  local fuel
  if args.fuel ~= false then fuel = args.fuel or "coal" end
  local fuel_targets = {}
  -- The card's own crafting machines, kept so the window can end with an explanation: a machine
  -- that never ran, and a machine that ran happily on a recipe nobody asked it to, both report the
  -- same zero, and only the status and the bound recipe tell them apart.
  local machines = {}
  for _, rec in pairs(built) do
    if rec.kind == "furnace" or rec.kind == "assembling-machine" or rec.kind == "mining-drill" then
      fuel_targets[#fuel_targets + 1] = rec.entity
    end
    if rec.kind == "furnace" or rec.kind == "assembling-machine" or rec.kind == "boiler" then
      machines[#machines + 1] = { entity = rec.entity, name = rec.name }
    end
  end
  local fuelled = 0
  if fuel then
    for _, e in ipairs(fuel_targets) do
      local ok, moved = pcall(function()
        local inv = e.get_inventory(defines.inventory.fuel)
        if not inv then return 0 end
        return inv.insert({ name = fuel, count = 200 })
      end)
      if ok and moved and moved > 0 then fuelled = fuelled + 1 end
    end
  end

  -- An in-port whose item the region declares INTERNAL must not be hand-fed: that is
  -- precisely the wire that failed to connect, and supplying it by hand makes a broken
  -- topology measure like a working one. Report it as unwired_inputs instead.
  local internal_set = {}
  for _, item in ipairs(normalized.internal_flows or {}) do internal_set[item] = true end

  -- A fluid port cannot be served by a chest, and nothing in the runtime data says which cell of
  -- which face a machine's box sits on: `fluid_boxes` is not exposed, `fluidbox_prototypes` gives
  -- only in/out, and a placed machine reports an empty box list. So no fluid fixture is placed
  -- here. The job opens in `probing`, offers a little of each ingredient at one cell at a time
  -- until a cell takes it, and only then builds its supply runs -- against cells rather than
  -- guesses, because a machine whose two ingredients share one face cannot be fed by two rows that
  -- each cover the whole face.
  --
  -- Products are the same problem backwards, and need no plumbing at all: 2.0 lets a script take
  -- what a machine's own boxes hold, so the reading is the box. A collector laid on a guessed face
  -- puts a ceiling on the number and hides it as a slow card.
  local feeds, collect, unwired = {}, {}, {}
  local fluid_want, fluid_out = {}, {}
  for _, port in ipairs(ports_in) do
    local rec = built[port.entity]
    if rec and port.item then
      if internal_set[port.item] then
        unwired[#unwired + 1] = { item = port.item, entity = port.entity, card = rec.name }
      else
        feeds[#feeds + 1] = { chest = rec.entity, item = port.item }
      end
    elseif rec and port.fluid then
      -- A fluid box belongs to a machine, so a fluid port has to name the machine it is on. A port
      -- left on a pipe or a tank has no box to find, and the rig would spend its discovery probing
      -- plumbing and report a card it never could have fed.
      if not FLUID_BOX_KINDS[rec.kind] then
        unwired[#unwired + 1] = { fluid = port.fluid, entity = port.entity, card = rec.name,
          kind = rec.kind, why = "FLUID_PORT_NOT_ON_A_MACHINE",
          msg = port.fluid .. " is declared on " .. rec.name .. " (" .. tostring(rec.kind)
            .. "), which has no fluid box of its own; declare the port on the machine" }
      else
        local want = fluid_want[port.entity]
        if not want then
          want = {}
          fluid_want[port.entity] = want
        end
        want[port.fluid] = true
      end
    end
  end
  for _, port in ipairs(ports_out) do
    local rec = built[port.entity]
    if rec then
      if port.item then
        collect[#collect + 1] = { entity = rec.entity, item = port.item }
      else
        local gives = fluid_out[port.entity]
        if not gives then
          gives = {}
          fluid_out[port.entity] = gives
        end
        gives[port.fluid] = true
      end
    end
  end
  local fluid_obligations = 0
  for _, want in pairs(fluid_want) do
    for _ in pairs(want) do fluid_obligations = fluid_obligations + 1 end
  end
  if #feeds == 0 and fluid_obligations == 0 then
    verify.destroy(built)
    return fail("CARD_NO_FEEDS", "no in port resolved to an entity that is not already internal",
      { unwired_inputs = unwired })
  end

  -- A furnace takes its recipe from whatever is in its source slot, but an assembling
  -- machine sits idle until something sets `recipe` -- an unbound assembler measures
  -- as zero output and looks like a broken layout rather than an unspecified intent.
  local supplied = {}
  for _, f in ipairs(feeds) do supplied[f.item] = true end
  for _, want in pairs(fluid_want) do
    for fluid in pairs(want) do supplied[fluid] = true end
  end
  -- An internal flow is supplied too: a composed region feeds its second stage from
  -- the first one's output chest, and demanding an external in-port for it would make
  -- composition impossible to measure.
  for _, item in ipairs(normalized.internal_flows or {}) do supplied[item] = true end
  local function candidates_for(item)
    local list = {}
    for rname, r in pairs(db.recipes) do
      local makes = false
      for _, p in ipairs(r.products) do if p.name == item then makes = true end end
      if makes then
        local feeds_ok = true
        for _, i in ipairs(r.ingredients) do
          if not supplied[i.name] then feeds_ok = false end
        end
        if feeds_ok then list[#list + 1] = rname end
      end
    end
    table.sort(list)
    return list
  end

  local bound, bound_err = {}, nil
  for idx, rec in pairs(built) do
    if rec.kind == "assembling-machine" then
      local explicit = normalized.machine_recipes and (normalized.machine_recipes[tostring(idx)]
        or normalized.machine_recipes[idx])
      local want, cands = explicit, nil
      if not want then
        -- one machine per claimed output; a card making two things declares two
        -- the claim may be a fluid: an oil refinery is bound by the petroleum-gas it promises,
        -- and looking only at item claims would leave it idle and measured as a zero card
        for name in pairs(contract) do
          local list = candidates_for(name)
          if #list == 1 then
            want = list[1]
            break
          elseif #list > 1 then
            cands = list
          end
        end
        for name in pairs(fluid_contract) do
          local list = candidates_for(name)
          if #list == 1 then
            want = list[1]
            break
          elseif #list > 1 then
            cands = list
          end
        end
      end
      if want then
        local locked_tech
        for _, t in ipairs((db.recipes[want] or {}).techs or {}) do
          local tech = force.technologies[t]
          if not tech or tech.researched == false then locked_tech = t break end
        end
        if locked_tech then
          -- The machine accepts the recipe and then sits at `recipe_not_researched` for the whole
          -- window, which reports as "this card produces nothing" -- the exact false verdict this
          -- rig exists to prevent. Research is checked before any time is spent.
          bound_err = { code = "RECIPE_NOT_RESEARCHED", at = idx, entity = rec.name, recipe = want,
            technology = locked_tech,
            msg = want .. " is not researched (needs " .. locked_tech
              .. "); measuring it now would only yield a zero" }
        else
          -- 2.0 has no `entity.recipe` property; the setter is set_recipe(name) and a
          -- wrong shape here reads as "the machine refuses the recipe" rather than "I
          -- called nothing".
          local ok, err = pcall(function() rec.entity.set_recipe(want) end)
          if ok then
            bound[#bound + 1] = { at = idx, machine = rec.name, recipe = want }
          else
            bound_err = { code = "RECIPE_REJECTED", at = idx, entity = rec.name, recipe = want,
              msg = rec.name .. " cannot run " .. want .. ": " .. tostring(err) }
          end
        end
      elseif cands then
        bound_err = { code = "RECIPE_AMBIGUOUS", at = idx, entity = rec.name, candidates = cands,
          msg = "several recipes could make the claimed output from the supplied items; declare machine_recipes["
            .. idx .. "] = one of them" }
      else
        bound_err = { code = "RECIPE_UNFEEDABLE", at = idx, entity = rec.name,
          msg = "no recipe makes " .. table.concat((function()
            local t = {} for k in pairs(contract) do t[#t + 1] = k end return t end)(), "/")
            .. " from the items this card's in-ports supply; declare machine_recipes or add an in port" }
      end
    end
  end
  if bound_err then
    verify.destroy(built)
    return fail(bound_err.code, bound_err.msg, bound_err)
  end

  local expected_total = 0
  for _, per_min in pairs(contract) do expected_total = expected_total + per_min end

  local window = math.floor(seconds * 60)
  local probing = fluid_obligations > 0
  -- `boxes` may already know where a machine's intakes are, because the lab or a raw probe read it
  -- once. A hit skips the discovery for that fluid -- and only that fluid: the run it produces is
  -- still required to make the tank lose fluid before the window opens, so a wrong entry costs a
  -- settle and comes back as a note rather than as a measurement of a machine nobody fed.
  local queue, known, unwanted = {}, {}, {}
  for idx, want in pairs(fluid_want) do
    for fluid in pairs(want) do
      local ob = { at = idx, fluid = fluid }
      local rec = built[idx]
      -- Asking whether the bound recipe takes this fluid at all comes before anything expensive,
      -- and before the box table: a card that declares an ingredient its machine never draws is
      -- wrong whatever cell the box sits on, and discovery would spend two passes proving it.
      local wants = fluidrig.ingredient_names(rec.entity)
      local recipe
      pcall(function() recipe = rec.entity.get_recipe() and rec.entity.get_recipe().name end)
      if wants and not wants[fluid] then
        unwanted[#unwanted + 1] = { fluid = fluid, at = idx, entity = rec.name, recipe = recipe }
      else
        if not args.ignore_box_table then
          local face, off = boxes.lookup(rec.name, rec.entity.direction, fluid, "in")
          if face then
            ob.face, ob.off, ob.source = face, off, "table"
          end
        end
        if ob.face then known[#known + 1] = ob else queue[#queue + 1] = ob end
      end
    end
  end
  if #unwanted > 0 then
    table.sort(unwanted, function(a, b)
      return a.at < b.at or (a.at == b.at and a.fluid < b.fluid)
    end)
    verify.destroy(built)
    local first = unwanted[1]
    return fail("FLUID_NOT_AN_INGREDIENT", first.fluid .. " is an in port of " .. first.entity
      .. " running " .. tostring(first.recipe) .. ", which does not take it",
      { not_ingredients = unwanted, recipe = first.recipe })
  end
  local function by_position(a, b)
    return a.at < b.at or (a.at == b.at and a.fluid < b.fluid)
  end
  table.sort(queue, by_position)
  table.sort(known, by_position)

  storage.lab = {
    id = (storage.lab and storage.lab.id or 1000) + 1,
    mode = "submitted",
    -- Discovery is part of the job rather than a preamble to it: the offers have to come back out
    -- of the ground before a window is timed, and a window that ran over the top of them would
    -- measure a machine with its ingredients half in place.
    state = probing and "probing" or "running",
    started = game.tick,
    -- A machine that draws nothing from any cell would otherwise leave the job in `probing` while
    -- the caller waits on a verdict that never comes.
    deadline = game.tick + (probing and LAB_PROBE_TICKS or window),
    window_ticks = window,
    prev_speed = game.speed,
    speed = speed,
    surface = field(surface, "name") or "?",
    force = force_name,
    submitted_card = normalized,
    contract = contract,
    warmup_seconds = args.warmup_seconds or 4,
    fuel = fuel,
    expected_per_min = expected_total,
    ingredient = (feeds[1] or {}).item,
    product = (ports_out[1] or {}).item or (ports_out[1] or {}).fluid,
    contract_fluids = next(fluid_contract) and fluid_contract or nil,
    produced = 0,
    fed = 0, fed_blocked = 0,
    fuelled = 0, fuel_blocked = 0,
    missing = 0,
  }
  storage.lab.ents = ents_array
  storage.lab.rig = {
    feeds = feeds, collect = collect, gens = gens,
    machines = machines, fuel_targets = fuel_targets, ents = ents_array,
    -- what has to be taken apart when the job ends, whatever state it ends in
    probes = {}, runs = {}, problems = {}, notes = {}, drains = {},
    machine_of = (function()
      local t = {}
      for idx, rec in pairs(built) do t[idx] = rec.entity end
      return t
    end)(),
    -- which entity each card index turned into, so the tick loop can put a fixture next to the
    -- machine it belongs to without re-deriving the placement
    -- a table hit still has to be looked up by machine index when its run is built, so it joins
    -- `found` in the same shape the discovery pass writes
    probe = probing and { queue = queue, found = known, probes = {}, pass = 0, until_tick = 0,
      built = {}, all = (function()
        local t = {}
        for _, ob in ipairs(known) do t[#t + 1] = { at = ob.at, fluid = ob.fluid } end
        for _, ob in ipairs(queue) do t[#t + 1] = { at = ob.at, fluid = ob.fluid } end
        table.sort(t, by_position)
        return t
      end)() } or nil,
    in_chests = (function()
      local t = {} for _, f in ipairs(feeds) do t[#t + 1] = f.chest end return t
    end)(),
    out_chests = (function()
      local t = {} for _, c in ipairs(collect) do t[#t + 1] = c.entity end return t
    end)() }

  host.clock_raise(speed)

  -- Which card this job belongs to. The job record is the only place a later click can find out: a
  -- player who presses Measure on one row then Keep measurement must not have the numbers land on
  -- whatever card was asked for last. `for_card` is the frozen name the caller started the job under;
  -- the card's own `name` is not it, because an inline card from a plan carries a template name.
  storage.lab.card_name = args.for_card or normalized.name
  storage.lab.for_card = args.for_card

  return {
    job = storage.lab.id, state = storage.lab.state, card_name = normalized.name,
    entities = #ents_array, origin = origin, run_ticks = window,
    speed = speed, contract = contract, expected_per_min = expected_total,
    supplied_grid = #gens > 0, ideal_grid = ideal_grid,
    feeds = #feeds, collectors = #collect,
    fluid_obligations = fluid_obligations, fluid_products = next(fluid_out) and true or nil,
    unwired_inputs = #unwired > 0 and unwired or nil,
    fuel = fuel, fuelled_machines = fuelled,
    recipes_bound = bound,
    box_table_served = #known > 0 and #known or nil,
  }
end

-- Both deliverables come from the same geometry: a shareable compressed string and
-- in-game ghosts. There is no blueprint item on the ground in a headless server, so
-- the string is produced through an off-screen inventory holding a blueprint stack.
local function blueprint_string(entities, label)
  local inv = game.create_inventory(1)
  local ok, out = pcall(function()
    inv.insert { name = "blueprint", count = 1 }
    local st = inv[1]
    local specs = {}
    for i, e in ipairs(entities) do
      specs[#specs + 1] = {
        entity_number = i, name = e.name, direction = e.direction or 0,
        position = { x = e.position.x, y = e.position.y },
      }
    end
    st.set_blueprint_entities(specs)
    if label then st.label = label end
    return st.export_stack()
  end)
  pcall(function() inv.destroy() end)
  if not ok then return nil, tostring(out) end
  return out, nil
end

-- Freezing has two doors, and they say different things about what is known.
--
-- The measured door (the default) requires a finished card_lab run that delivered: what
-- comes out is a template whose rate the game itself confirmed. The second door,
-- `card + allow_unmeasured`, exists because a finished REGION should be placeable without
-- first spending game time proving it -- but it stamps `measured = false` into the record,
-- and the panel and every reader carry that, so an unproven plan never becomes a proven one
-- just by passing through storage.
function M.card_freeze(args)
  args = args or {}
  local j = storage.lab
  local source, measured, claimed, window, warmup, job_id, was_measured

  if args.card then
    if args.allow_unmeasured ~= true then
      return fail("NOT_MEASURED", "freezing a card you already hold needs allow_unmeasured = true; run card_lab, then card_freeze, to freeze a measured one",
        { why = "a frozen card is the thing later work trusts, so the two doors are labelled" })
    end
    source = card.normalize(args.card)
    if #source.entities == 0 then return fail("EMPTY_CARD", "no entities") end
    -- Every other force-taking method answers NO_FORCE for a force that is not in the save; this one
    -- passed the nil straight into `availability_checker`, which indexes `force.recipes`, so a typo
    -- came back as a raw runtime error from the dispatcher's own pcall.
    local freeze_force = game.forces[args.force or "player"]
    if not freeze_force then return fail("NO_FORCE", tostring(args.force)) end
    -- Refresh first. `availability_checker` prefers the unlocks recorded in the shared world cache
    -- and only falls back to the live force, so without this a freeze under a named force was lints
    -- against whoever asked last -- and `card_freeze` is the one of the thirteen call sites that
    -- reads that cache without refreshing it.
    local fdb = world_db()
    refresh_availability(fdb, freeze_force.name)
    local l = card.lint(source, { available = availability_checker(fdb, freeze_force) })
    if #l.errors > 0 then
      return fail("CARD_DOES_NOT_LINT", "an unmeasured card still has to be a legal one", { errors = l.errors })
    end
    claimed = (source.contract or {}).outputs or {}
    window, warmup, job_id, was_measured = nil, nil, nil, false
  else
    if not j then return fail("NO_JOB", "run card_lab first") end
    if j.state ~= "done" then return fail("JOB_NOT_DONE", "job " .. tostring(j.id) .. " is " .. tostring(j.state)) end
    if not j.submitted_card then return fail("NOT_A_CARD_JOB", "only card_lab measurements can be frozen") end
    if j.delivered ~= true then
      return fail("NOT_DELIVERED", "the measurement says this card cannot pay its claim; fix the layout or the claim",
        { verdicts = j.verdicts, pay_fraction = j.pay_fraction })
    end
    source, claimed, was_measured = j.submitted_card, j.contract, true
    measured = {}
    for _, v in ipairs(j.verdicts or {}) do measured[v.item] = v.measured_per_min end
    window = (j.deadline - j.started) / 60
    warmup, job_id = j.warmup_seconds, j.id
  end

  storage.cards = storage.cards or {}
  local name = args.name or source.name or ("card-" .. tostring(job_id or game.tick))

  local bp, bp_err = blueprint_string(source.entities, name)
  local rec = {
    name = name,
    card = source,
    claimed = claimed,
    measured = measured,
    measured_this_card = was_measured,
    window_seconds = window,
    warmup_seconds = warmup,
    source_job = job_id,
    frozen_tick = game.tick,
    blueprint = bp,
  }
  -- What was there before, if anything. `measured` is a rates table, and an empty one means both
  -- "measured and produced nothing" and "never measured" once it reaches JSON -- so the boolean the
  -- record keeps beside it is the only honest answer, and the replacement is reported in its terms.
  local held = storage.cards[name]
  storage.cards[name] = rec

  return {
    name = name, frozen = true, measured = measured, claimed = rec.claimed,
    replaced = held and {
      entities = held.card and #held.card.entities or nil,
      measured_this_card = held.measured_this_card == true,
      window_seconds = held.window_seconds, source_job = held.source_job,
      frozen_tick = held.frozen_tick,
    } or nil,
    measured_this_card = was_measured,
    entities = #source.entities, window_seconds = rec.window_seconds,
    warmup_seconds = rec.warmup_seconds, cards_held = (function()
      local n = 0 for _ in pairs(storage.cards) do n = n + 1 end return n
    end)(),
    blueprint = bp, blueprint_error = bp_err,
    note = was_measured and nil
      or "frozen unmeasured on purpose: the claim is what the card says, not what the game confirmed",
  }
end

-- The player's side of the loop. A designer outside the game can call every method in this file and
-- still has no voice inside it; this queue is how the game speaks back. Three rules shape it: it is
-- bounded, because an answer arriving about a world that has moved on is worse than no answer; every
-- entry carries the tick it was asked at and the surface it was asked on, so an agent can tell a
-- stale ask from a live one; and an answer replaces rather than appends, and reports what it
-- replaced, because two answers to one question is the same ambiguity as a silent overwrite.
local REQUEST_CAP = 20

-- The cap above only holds down the questions nobody has answered. The answered ones are a log, and
-- a log nobody trims is a save file that grows by every question a session ever asked -- so "it is
-- bounded" would be true of one state and quietly false of the other.
local ANSWERED_KEEP = 50

-- Returns how many records it dropped, because a caller reading the queue should be able to tell
-- "nobody asked that" from "that ask aged out", and `answer`'s NO_SUCH_REQUEST carries the ids that
-- are still here either way.
local function trim_answers()
  local done = {}
  for _, r in ipairs(storage.requests) do
    if r.state ~= "open" then done[#done + 1] = r end
  end
  if #done <= ANSWERED_KEEP then return 0 end
  local drop = {}
  for i = 1, #done - ANSWERED_KEEP do drop[done[i]] = true end
  local kept = {}
  for _, r in ipairs(storage.requests) do
    if not drop[r] then kept[#kept + 1] = r end
  end
  local n = #storage.requests - #kept
  storage.requests = kept
  return n
end

-- Chat is the only channel that reaches a player who is not looking at the panel, so an answer
-- arriving is announced rather than left for whoever asked to think to ask again. Returns how many
-- players it reached, because on a headless server that number is zero and a claim of "told the
-- player" without a number in it is exactly the sort of fallback that has to look like one.
local function tell_players(msg)
  local told = 0
  for _, p in pairs(game.players or {}) do
    if p and p.connected then
      p.print(msg)
      told = told + 1
    end
  end
  return told
end

function M.request(args)
  args = args or {}
  local ask = args.ask
  if type(ask) ~= "string" or ask:gsub("%s", "") == "" then
    return fail("BAD_ARGS", "ask = the question, in the words a player would use",
      { got = type(args.ask) })
  end
  storage.requests = storage.requests or {}
  local open = 0
  for _, r in ipairs(storage.requests) do if r.state == "open" then open = open + 1 end end
  if open >= REQUEST_CAP then
    return fail("QUEUE_FULL", "up to " .. REQUEST_CAP .. " questions may sit unanswered",
      { open = open, cap = REQUEST_CAP, oldest = storage.requests[1] and storage.requests[1].id,
        why = "an answer about a world that has moved on is worse than no answer" })
  end
  local surface = surface_or_default(args.surface)
  storage.request_next = (storage.request_next or 0) + 1
  local rec = {
    id = storage.request_next, ask = ask, state = "open",
    asked_tick = game.tick, asked_at = game.ticks_played,
    surface = surface and field(surface, "name") or nil,
    card = args.card, answered_tick = nil, answer = nil,
  }
  storage.requests[#storage.requests + 1] = rec
  local trimmed = trim_answers()
  return {
    request = rec, open = open + 1, held = #storage.requests, cap = REQUEST_CAP,
    trimmed = trimmed, keep = ANSWERED_KEEP,
    note = "an agent outside the game takes this with requests{}, works, and calls answer; "
      .. "this mod cannot reach a model itself and does not pretend to",
  }
end

function M.requests(args)
  args = args or {}
  storage.requests = storage.requests or {}
  local want = args.state or "all"
  local out, open_count = {}, 0
  for _, r in ipairs(storage.requests) do
    if r.state == "open" then open_count = open_count + 1 end
    if (want == "all" or r.state == want) and not (args.since_id and r.id <= args.since_id) then
      out[#out + 1] = r
    end
  end
  return { requests = out, open = open_count, held = #storage.requests, tick = game.tick,
           cap = REQUEST_CAP, keep = ANSWERED_KEEP }
end

function M.answer(args)
  args = args or {}
  storage.requests = storage.requests or {}
  local found
  for _, r in ipairs(storage.requests) do if r.id == args.id then found = r break end end
  if not found then
    return fail("NO_SUCH_REQUEST", "no request with id " .. tostring(args.id),
      { asked_for = args.id, known = (function()
          local l = {}
          for _, r in ipairs(storage.requests) do l[#l + 1] = r.id end
          return l
        end)() })
  end
  if type(args.text) ~= "string" or args.text:gsub("%s", "") == "" then
    return fail("BAD_ARGS", "text = the answer the player should read", { got = type(args.text) })
  end
  local replaced = found.state == "answered" and {
    text = found.answer, at_tick = found.answered_tick, at_card = found.answer_card,
  } or nil
  found.state = "answered"
  found.answer = args.text
  found.answered_tick = game.tick
  found.answer_card = args.card or found.card
  local still_open = 0
  for _, r in ipairs(storage.requests) do if r.state == "open" then still_open = still_open + 1 end end
  -- Say so in the game: the panel shows an answer only to whoever opens it and clicks Queue, and a
  -- player who asked a question while the agent was working is not watching that window.
  local told = tell_players(string.format("architect: answer to #%d -- %s%s", found.id,
    host.clip(tostring(args.text):gsub("[\r\n]+", " "), 180),
    still_open > 0 and string.format(" (%d still open, /arch -> Queue)", still_open) or ""))
  return { request = found, replaced = replaced, open = still_open, told = told }
end

function M.cards(args)
  storage.cards = storage.cards or {}
  local out = {}
  for name, rec in pairs(storage.cards) do
    local ents = rec.card and rec.card.entities or {}
    out[#out + 1] = {
      name = name, entities = #ents, measured = rec.measured, claimed = rec.claimed,
      measured_this_card = rec.measured_this_card == true,
      window_seconds = rec.window_seconds, warmup_seconds = rec.warmup_seconds,
      frozen_tick = rec.frozen_tick, has_blueprint = rec.blueprint ~= nil,
    }
  end
  table.sort(out, function(a, b) return a.name < b.name end)
  return { count = #out, cards = out }
end

function M.card_blueprint(args)
  args = args or {}
  storage.cards = storage.cards or {}
  local rec = storage.cards[args.name or ""]
  if not rec then return fail("NO_SUCH_CARD", "nothing frozen under that name", M.cards({})) end
  local bp, err = blueprint_string(rec.card.entities, rec.name)
  return { name = rec.name, blueprint = bp, bytes = bp and #bp or nil, error = err,
           measured = rec.measured, measured_this_card = rec.measured_this_card == true,
           claimed = rec.claimed }
end

-- The other deliverable: drop a frozen card on the map as ghosts, which costs no
-- materials and is what the player walks up to and confirms.
function M.card_place(args)
  args = args or {}
  storage.cards = storage.cards or {}
  local rec = storage.cards[args.name or ""]
  if not rec then return fail("NO_SUCH_CARD", "nothing frozen under that name", M.cards({})) end
  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  local force_name = args.force or "player"
  -- `find_card_site` below hands the name to `can_place_entity`, which raises on a force that does
  -- not exist; the other thirteen sites answer NO_FORCE.
  if not game.forces[force_name] then return fail("NO_FORCE", tostring(args.force)) end
  local origin = args.origin
  if not origin then
    local rejected
    origin, rejected = find_card_site(surface, rec.card, force_name, nil)
    if not origin then
      return fail("NO_CLEAR_SITE", "no candidate site fits this card; pass an explicit origin", rejected)
    end
  end

  local placed, ghosts, refused = 0, 0, {}
  -- Ghosts are create_entity calls, and create_entity happily builds off-map and
  -- hands back something that looks fine but can never be revived. The preview is
  -- only worth anything if the real build would fit, so check before placing.
  local fits, blockers, wanted, ground_only = card_fits(surface, rec.card, origin, force_name)
  if not fits then
    -- Three refusals wear this one code and the advice differs in each: something is standing here
    -- (move it, or move the plan); nothing is here and the tiles will not take it (water, lava, ground
    -- this save has never generated); or the ground is perfect and the PLANET will not hold the
    -- machine -- a chest wants gravity, a crusher wants none. `can_place_entity` answers the same bare
    -- `false` for all three, so without the third case a card refused by gravity is reported as a
    -- problem with the patch of grass it was aimed at.
    local refused_by_planet = nil
    for _, w in ipairs(wanted or {}) do
      if w.surface_refused then refused_by_planet = w end
    end
    local why_message
    if refused_by_planet then
      local r = refused_by_planet.surface_refused
      why_message = string.format("%s cannot stand on this surface -- %s is not allowed here (see "
        .. "`wanted[].surface_refused` for the bound and what this surface answers)",
        tostring(refused_by_planet.name), tostring(r.property))
    elseif ground_only then
      why_message = "the ground at that origin cannot receive this card -- nothing stands in the way, "
        .. "the tiles themselves refuse it (water, lava, or chunks that are not generated yet)"
    else
      why_message = "this card will not build at that origin; the ghosts would be lies"
    end
    return fail("SITE_REJECTED", why_message,
      { blockers = #blockers > 0 and blockers or nil, wanted = wanted, origin = origin,
        ground = ground_only and { tile = (wanted[1] or {}).tile, generated = (wanted[1] or {}).generated } or nil })
  end
  for i, e in ipairs(rec.card.entities) do
    local pos = { x = e.position.x + origin.x, y = e.position.y + origin.y }
    if args.ghosts == false then
      local ent = surface.can_place_entity { name = e.name, position = pos, direction = e.direction, force = force_name }
        and surface.create_entity { name = e.name, position = pos, direction = e.direction, force = force_name } or nil
      if ent then placed = placed + 1 else refused[#refused + 1] = { at = i, name = e.name } end
    else
      local g = surface.create_entity {
        name = "entity-ghost", inner_name = e.name, position = pos, direction = e.direction, force = force_name,
      }
      if g then ghosts = ghosts + 1 else refused[#refused + 1] = { at = i, name = e.name } end
    end
  end
  return { name = rec.name, origin = origin, ghosts = ghosts, built = placed, refused = refused,
           surface = surface.name, measured = rec.measured,
           measured_this_card = rec.measured_this_card == true }
end

-- The rigs live in measure.lua; they are methods like any other, and the dispatcher only sees
-- names on M.
M.drill_rate = measure.drill_rate
M.pump_rate = measure.pump_rate

-- The lab surface is created on demand and its chunks arrive a few ticks later, so a caller on a
-- fresh save needs a way to ask "is the ground there yet" instead of reading `out-of-map` and
-- blaming whatever it was holding. Everything that measures goes through this surface.
-- Is this seam closed? Read off the ground rather than off the plan: which pipes are standing, what
-- fluid is inside them, and -- when the answer is no -- the corridor of free cells that would close
-- it. The rig proposes that corridor and does not lay it: turning a corner through ground someone
-- else has built on is a judgement call with a human in it, and a wrong guess places cleanly and
-- then moves nothing, which is the worst way to be wrong.
function M.seam_check(args)
  args = args or {}
  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  if not args.fluid then return fail("BAD_ARGS", "fluid is required") end
  if not args.from or not args.to then return fail("BAD_ARGS", "from and to are required as {x=,y=}") end

  local function rect_at(pt)
    local here = surface.find_entities_filtered { position = { x = pt.x, y = pt.y }, radius = 0.1 }
    local e = here[1]
    if not e then return nil end
    local pr = prototypes.entity[e.name]
    return { x = e.position.x, y = e.position.y, name = e.name,
      w = (pr and pr.tile_width) or 1, h = (pr and pr.tile_height) or 1 }
  end

  local a, b = rect_at(args.from), rect_at(args.to)
  if not a then return fail("NO_ENTITY_AT", "nothing stands at from", { from = args.from }) end
  if not b then return fail("NO_ENTITY_AT", "nothing stands at to", { to = args.to }) end

  local verdict = seams.trace(surface, a, b, args.fluid)
  if verdict.connected then
    return { seam = args.fluid, connected = true, pipes = verdict.pipes, between = { a.name, b.name } }
  end

  -- what the ground has in the way, so the proposal is a corridor and not a wish
  local reach = math.max(a.w, a.h, b.w, b.h) / 2 + 20
  local mid_x, mid_y = (a.x + b.x) / 2, (a.y + b.y) / 2
  local blocked, existing = {}, {}
  local function same(e, r)
    return math.abs(e.position.x - r.x) < 0.01 and math.abs(e.position.y - r.y) < 0.01
  end
  for _, e in ipairs(surface.find_entities_filtered {
    area = { { mid_x - reach, mid_y - reach }, { mid_x + reach, mid_y + reach } } }) do
    local pr = prototypes.entity[e.name]
    local w, h = (pr and pr.tile_width) or 1, (pr and pr.tile_height) or 1
    local k = math.floor(e.position.x * 1000) .. "," .. math.floor(e.position.y * 1000)
    if e.name == "pipe" then
      existing[k] = true
    elseif not same(e, a) and not same(e, b) and e.type ~= "resource" then
      -- ore underfoot is not an obstacle to a pipe, and saying so keeps the corridor honest about
      -- the ground a player would actually be clicking
      blocked[#blocked + 1] = { x = e.position.x, y = e.position.y, w = w, h = h }
    end
  end

  local cells, info = seams.route(a, b, { blocked = blocked, existing = existing,
    limit = args.limit or 16 })
  return {
    seam = args.fluid, connected = false, why = verdict.why,
    foreign = verdict.foreign, stopped_at = verdict.stopped_at,
    between = { a.name, b.name },
    -- the cells a hand has to click; `already` marks the ones that hold pipe, so a partly built
    -- run comes back as what is left rather than as nothing at all
    ask = cells and { kind = "lay_pipes", pipes = info.to_lay, cells = cells }
      or { kind = "no_corridor", why = (info or {}).why, limit = (info or {}).limit },
  }
end

-- The fluid ports of a machine, answered two ways at once: read from data (`ports`), and recalled
-- from the table that was won by measurement (`boxes`). Both are reported, and disagreement is the
-- payload -- the read is the answer that generalises to any machine in any modpack, but it is new, and
-- the only reason to trust it is that the old, slower witness agrees with it.
--
-- `at`/`surface` ask the third source instead: a machine that is standing there, which is the only one
-- that knows the recipe it is actually set to. A crafting machine holds only the boxes its current
-- recipe needs, so a port question asked before the recipe is set has no answer to check.
function M.machine_ports(args)
  args = args or {}
  local kinds = { "in", "out" }

  local function cross_check(name, direction, recipe_name)
    local declared, why = ports.declared(name, direction)
    if not declared then return nil, why end
    local assigned = ports.assign(declared, recipe_name)
    local rows, diverged = {}, {}
    for _, b in ipairs(declared.boxes) do
      local line = assigned[b.index]
      local kind = (b.kind == "input" and "in") or (b.kind == "output" and "out") or nil
      if line and kind then
        local face, off = b.face, b.off
        local m_face, m_off = boxes.lookup(name, direction, line.fluid, kind)
        rows[#rows + 1] = {
          box = b.index, fluid = line.fluid, kind = kind, face = face, off = off,
          how = line.how, volume = b.volume,
          min_temperature = b.min_temperature, max_temperature = b.max_temperature,
          needs_temperature = line.temperature or line.min_temperature,
          recipe_disagrees = line.recipe_disagrees,
          measured = m_face and { face = m_face, off = m_off } or nil,
        }
        if m_face and (m_face ~= face or m_off ~= off) then
          diverged[#diverged + 1] = { fluid = line.fluid, kind = kind, read = face .. "," .. tostring(off),
            measured = m_face .. "," .. tostring(m_off), box = b.index }
        end
      end
    end
    -- the other direction: a cell the table claims that the read cannot reproduce is the more
    -- dangerous kind of disagreement, because the table is what today's cards were built from
    for _, claim in ipairs(boxes.covered()) do
      if claim.machine == name and claim.direction == direction then
        local found = false
        for _, r in ipairs(rows) do
          if r.fluid == claim.fluid and r.kind == claim.kind then found = true end
        end
        if not found then
          diverged[#diverged + 1] = { fluid = claim.fluid, kind = claim.kind,
            why = "in the measured table, not reachable from the data", face = claim.face, off = claim.off }
        end
      end
    end
    table.sort(rows, function(a, b2)
      if a.kind ~= b2.kind then return a.kind < b2.kind end
      return a.box < b2.box
    end)
    return { machine = name, direction = direction, recipe = recipe_name,
      tile = declared.tile_width .. "x" .. declared.tile_height, entries = rows,
      diverged = #diverged > 0 and diverged or nil,
      diverged_count = #diverged }, nil
  end

  if args.at and args.surface ~= false then
    local surface = resolve_surface(args.surface)
    if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
    local at = args.at
    local here = surface.find_entities_filtered {
      position = { x = at.x or at[1], y = at.y or at[2] }, radius = 0.1 }
    local entity = here[1]
    if not entity then
      return fail("NO_ENTITY_AT", "nothing stands at the position given", { at = at })
    end
    local read, why = ports.read(entity)
    if not read then return fail(why or "NO_FLUID_BOXES", entity.name, { machine = entity.name }) end
    local compared
    if read.recipe then
      compared = cross_check(entity.name, entity.direction, read.recipe)
    end
    return { machine = entity.name, direction = entity.direction, recipe = read.recipe,
      source = "placed entity", position = read.position, boxes = read.boxes,
      from_data = (compared and not compared.fail) and compared or nil,
      joined = (function()
        local l = {}
        for _, b in ipairs(read.boxes) do
          if b.joined and b.joined > 0 then l[#l + 1] = b.box end
        end
        return #l > 0 and l or nil
      end)() }
  end

  local name = args.machine
  if not name then return fail("BAD_ARGS", "machine is required (or `at` a standing entity)") end
  local recipe = args.recipe
  if not recipe then
    -- without a recipe the assignment between a machine's boxes and a recipe's fluid lines has no
    -- subject, and an answer that silently used the first recipe it found would be worse than none
    return fail("NO_RECIPE", name .. " has boxes but ports need to know which recipe is running",
      { machine = name, hint = "pass recipe=, or point at a placed entity with at=/" })
  end
  local directions = args.directions or { 0, 4, 8, 12 }
  local by_direction, all_diverged = {}, {}
  for _, d in ipairs(directions) do
    local one, why = cross_check(name, d, recipe)
    if not one then return fail(why or "PORTS_FAILED", tostring(name), { machine = name, direction = d }) end
    by_direction[#by_direction + 1] = one
    for _, x in ipairs(one.diverged or {}) do
      all_diverged[#all_diverged + 1] = x
      x.direction = d
    end
  end
  return {
    machine = name, recipe = recipe, source = "data", by_direction = by_direction,
    diverged = #all_diverged > 0 and all_diverged or nil,
    -- the measured table says nothing for most machines, and silence is not agreement
    measured_table_claims = #boxes.covered(),
  }
end

-- Which miner the ground would be put on a resource: the fastest machine that is unlocked *now* and
-- able to take that ore's category. Read from the live db rather than from `miners_by_category`,
-- because that cache is built when the prototype table is first walked -- on a server where nothing
-- is researched yet it holds no pumpjack at all, and a stale "nothing can mine this" is exactly the
-- kind of answer that looks like a rule and is really a timing accident.
local function miner_for(db, resource)
  local raw = db.raw and db.raw[resource]
  local cat = raw and raw.category
  if not cat then return nil end
  -- The rule lives in `roles` so a plan and a measurement rig cannot disagree about the same ground.
  -- Availability still comes from the LIVE db rather than `miners_by_category`, because that cache is
  -- built when the prototype table is first walked -- on a server where nothing is researched yet it
  -- holds no pumpjack at all, and a stale "nothing can mine this" looks like a rule and is a timing
  -- accident.
  local name = roles.miner_for(cat, {
    available = function(n)
      local m = db.machines[n]
      return m ~= nil and m.available ~= false
    end,
  })
  return name
end

-- What the ground under one resource can hold. A plan that says "ten pumpjacks" has answered a rate
-- question; this answers the building question, and the two come apart as soon as a patch is small
-- or already paved over. `slots` is a lower bound on purpose (see fields.lua), so `need_fits` being
-- true means a plan can be built and false means the scan finished and came up short -- a scan that
-- ran out of budget leaves the question open rather than answering it.
function M.field_survey(args)
  args = args or {}
  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  if not args.resource then return fail("BAD_ARGS", "resource is required") end
  local db = world_db()
  if not refresh_availability(db, args.force or "player") then
    return fail("NO_FORCE", tostring(args.force))
  end
  if not db.raw[args.resource] then
    return fail("NOT_A_RESOURCE", args.resource .. " is not an ore or resource patch to survey",
      { resource = args.resource })
  end
  local machine = args.machine or miner_for(db, args.resource)
  local s = fields.survey(surface, args.resource, machine, args.force or "player",
    { need = args.need, budget = args.budget })
  if args.need then
    s.need = args.need
    -- three-valued for the same reason as in fluid_chain: "the scan did not finish" is not "it does
    -- not fit", and a caller that reads the second from the first goes off looking for new ground
    if s.slots >= args.need then
      s.need_fits = true
    elseif s.slots_complete then
      s.need_fits = false
    end
  end
  return s
end

-- The extraction end of a fluid line, sized in units of fluid rather than in ore tiles.
--
-- Three things a rate answer leaves out, and all three have to be answered together or one of them
-- silently lies: how many machines deliver the rate (a nameplate divided by the ore's own mining
-- time and multiplied by what one broken unit of it yields -- crude oil gives ten units per unit),
-- whether the ground has anywhere to stand them, and how much tank sits between the pumps and the
-- consumer so a buffered line keeps running while a pipe is being laid.
--
-- The ground figure is reported in ore units and in fluid units at once, because the two differ by
-- that same factor and a "this field lasts 400 minutes" claim made in the wrong one is wrong by ten.
function M.fluid_chain(args)
  args = args or {}
  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  local db = world_db()
  if not refresh_availability(db, args.force or "player") then
    return fail("NO_FORCE", tostring(args.force))
  end
  local raw = args.fluid and db.raw[args.fluid]
  if not raw then
    return fail("NOT_A_RESOURCE", tostring(args.fluid) .. " is not a resource on this map",
      { fluid = args.fluid })
  end
  if not (raw.product and raw.product.type == "fluid") then
    return fail("NOT_A_FLUID_RESOURCE",
      args.fluid .. " yields items, not fluid; an item line is sized by solve",
      { fluid = args.fluid, product_type = raw.product and raw.product.type })
  end
  local per_min = args.per_min
  if type(per_min) ~= "number" or per_min <= 0 then
    return fail("BAD_ARGS", "per_min is the units of fluid per minute the line has to deliver")
  end
  local machine = args.machine or miner_for(db, args.fluid)
  if not machine or not db.machines[machine] then
    return fail("NO_MINER_FOR_RESOURCE",
      "nothing unlocked takes a " .. tostring(raw.category) .. " patch", { fluid = args.fluid })
  end

  local units_per_ore = raw.product.units or 1
  local ore_time = (raw.mining_time and raw.mining_time > 0) and raw.mining_time or 1
  local miner = db.machines[machine]
  local nameplate = (miner.mining_speed or 0) * 60 / ore_time * units_per_ore
  -- a rig that ran and read a zero measured a starved machine, not a rate
  local record = measured_cache()[machine .. "|" .. args.fluid]
  local measured = record and (record.steady_items_per_min or record.items_per_min
    or record.units_per_min)
  if measured and measured <= 0 then measured = nil end
  local per_each = measured or nameplate
  if per_each <= 0 then
    return fail("NO_RATE_FOR_MACHINE", machine .. " has no mining speed on " .. args.fluid,
      { machine = machine, nameplate = nameplate })
  end

  local n = math.ceil(per_min / per_each)
  local scanned = M.field_survey { resource = args.fluid, surface = args.surface, machine = machine,
    force = args.force, need = n, budget = args.budget }
  if type(scanned) == "table" and scanned.fail then return scanned end
  local buffer = fields.tanks_for(per_min, args.buffer_seconds or 60)
  -- `slots` is a lower bound, so the two ways it can fall short of the ask are not the same answer:
  -- a complete scan that came back short means the field is too small, while a scan that stopped
  -- early means nobody knows yet. Collapsing those into one `false` would tell a caller to go find
  -- another field when all that is missing is a bigger budget.
  local enough = scanned.slots >= n
  local certain = enough or scanned.slots_complete
  -- `nil` on purpose for the third case: Lua's `and`/`or` chain cannot carry three values, and a
  -- shorthand here would quietly turn "not known yet" into one of the two answers it is not
  local slots_enough
  if enough then
    slots_enough = true
  elseif certain then
    slots_enough = false
  end
  local shortfall = (certain and not enough) and (n - scanned.slots) or nil
  -- Ground may be handed in rather than scanned, to ask "what if the patch only holds this much".
  -- It is not only a convenience: every fluid on a vanilla map comes from an infinite vent, so the
  -- lifetime figure below could otherwise never be checked against arithmetic anywhere.
  local told = args.ground or {}
  local units = told.units or scanned.units
  local infinite = told.infinite
  if infinite == nil then infinite = scanned.infinite end
  -- the field is counted in ore units; the line spends them at per_min divided by what one unit
  -- yields, and asking "how long does this patch last" in fluid units overstates it every time
  local ore_per_min = per_min / units_per_ore
  return {
    fluid = args.fluid, per_min = per_min,
    machine = machine, extractors = n, per_each = per_each,
    delivered_per_min = n * per_each, over_by = n * per_each - per_min,
    rate_source = measured
      and ("measured on this map by the pump rig over "
        .. tostring(record.elapsed_game_seconds) .. " game seconds")
      or ("nameplate mining_speed / ore mining_time x units_per_ore_unit"
        .. (record and ", a rig ran and did not deliver a rate" or "")),
    rate_measured = measured ~= nil,
    units_per_ore_unit = units_per_ore, ore_mining_time = raw.mining_time,
    ground = {
      surface = scanned.surface, infinite = infinite,
      fields = #scanned.fields, tiles = scanned.tiles,
      ore_units = units,
      -- `ore_per_min` is already ore units per MINUTE, so dividing the patch by it is the answer in
      -- minutes; the extra /60 here reported hours in a field named minutes, which is a factor of
      -- sixty in the direction that makes a field look nearly spent.
      minutes_at_this_rate = (not infinite and units > 0 and ore_per_min > 0)
        and (units / ore_per_min) or nil,
      -- an infinite patch does not run out; what it does instead is deliver less as it drains,
      -- which is a measured thing (`pump_rate` reports field_drain_fraction) and not a duration
      lifetime = infinite and "infinite patch: it does not run out, and the rate falls as it drains"
        or nil,
      slots = scanned.slots, slots_complete = scanned.slots_complete,
      slots_method = scanned.slots_method, patches = scanned.fields,
    },
    -- the whole point of counting the ground: a plan whose pumps do not fit is not a plan
    slots_enough = slots_enough, shortfall = shortfall,
    storage = buffer,
    pipes = { modelled = false,
      note = "pumps are sized and tanks are counted; how much a run of pipe carries is not "
        .. "measured by this mod, so a long or narrow line is not yet known to be the bottleneck" },
  }
end

function M.sandbox(args)
  -- Both benches, because they are two different grounds with two different jobs: `arch-sandbox` is
  -- what the grid planner measures on and must never see a global network, `arch-lab` is what a
  -- measurement job runs on and is converted the first time it is used. A caller that has asked
  -- whether the rig is ready should not have to know there are two.
  local surface, pad, why = lab_surface()
  local rig, rig_pad, rig_why = rig_surface()
  if not surface then
    return fail("SANDBOX_" .. (why or "UNAVAILABLE"),
      why == "GENERATING" and "the lab surface exists but its chunks are still generating; call again"
        or "the lab surface could not be prepared", { reason = why, pad = pad })
  end
  return { surface = surface.name, pad = pad, ready = true,
           chunk_generated = surface.is_chunk_generated({ 0, 0 }),
           rig = rig and { surface = rig.name, pad = rig_pad, ready = true,
                           chunk_generated = rig.is_chunk_generated({ 0, 0 }) }
             or { ready = false, reason = rig_why } }
end

-- "How big does the power supply have to be?" -- answered as arithmetic, with every constant
-- read from the engine and the one modelled figure (the day curve) printed beside the answer
-- instead of buried in a rule of thumb. Give it `demand_kw`, or a `card` to read the draw of.
function M.power_plan(args)
  args = args or {}
  local surface = surface_or_default(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end

  local demand = args.demand_kw
  local have = {}
  local demand_read_on
  if args.card then
    local normalized = card.normalize(args.card)
    if #normalized.entities == 0 then return fail("EMPTY_CARD", "no entities") end
    for _, e in ipairs(normalized.entities) do have[e.name] = (have[e.name] or 0) + 1 end
    if demand == nil then
      local s, pad, why = lab_surface()
      if not s then
        if why == "GENERATING" then return fail("SANDBOX_GENERATING", "call again in a second") end
        return fail("NO_SANDBOX", tostring(why))
      end
      local origin = find_card_site(s, normalized, args.force or "player", args.origin, pad)
      if not origin then return fail("NO_CLEAR_SITE", "no candidate site fits this card") end
      local v = verify.verify(s, normalized, { force = args.force or "player", origin = origin, power_of = power_profile_of })
      verify.destroy(v._built)
      demand = v.power.demand_kw
      -- the draw was read off the bench, not off the surface named above: that one answers the day
      -- model, this one answers "how much does this card want"
      if args.surface then demand_read_on = field(s, "name") end
    end
  end
  if type(demand) ~= "number" then return fail("BAD_ARGS", "pass demand_kw or a card") end

  local db = world_db()
  local force = game.forces[args.force or "player"]
  refresh_availability(db, args.force or "player")
  local sizer, info = make_sizer(surface, args.generator, args.storage,
    force and availability_checker(db, force) or nil, function(name)
      local r = db.recipes and db.recipes[name]
      return r and r.techs and r.techs[1] or nil
    end)
  if not sizer then return fail(info.code or "NO_GENERATOR", "cannot size a grid", info) end
  local trail = sizer(demand, have)
  info.units_to_add = trail
  info.demand_kw = demand
  info.already_in_grid = have
  info.demand_read_on = demand_read_on
  info.note = "duty and night_seconds come from the piecewise-linear day model; nameplate kW, "
    .. "accumulator buffer and the charge/discharge limits are read from the engine"
  return info
end

-- Turn a coverage failure into a fix. The answer is searched, not estimated: candidate
-- cells are tried on the sandbox and the engine says which ones actually bring the
-- machines onto a grid, so the suggestion cannot be wrong in the way a hand-derived
-- reach calculation would be.
function M.card_fix_power(args)
  args = args or {}
  if not args.card then return fail("BAD_ARGS", "card is required") end
  local normalized = card.normalize(args.card)
  if #normalized.entities == 0 then return fail("EMPTY_CARD", "no entities") end

  local db = world_db()
  local force_name = args.force or "player"
  local force = game.forces[force_name]
  if not force then return fail("NO_FORCE", force_name) end
  refresh_availability(db, force_name)

  local opts = {}
  if not args.ignore_locked then opts.available = availability_checker(db, force) end
  local l = card.lint(normalized, opts)
  if #l.errors > 0 then
    return fail("CARD_DOES_NOT_LINT", #l.errors .. " lint error(s); fix those before asking for a power plan",
      { errors = l.errors })
  end

  -- This method never plans on the surface the caller named: a pole's reach can only be measured on
  -- ground that is not already one grid, and the plan has to reproduce. That is a fact about the
  -- answer, so it is in the answer rather than being something the caller has to know.
  local surface, pad, why = lab_surface()
  if not surface then
    if why == "GENERATING" then
      return fail("SANDBOX_GENERATING", "the verification surface is still generating chunks; call again in a second")
    end
    return fail("NO_SANDBOX", tostring(why))
  end
  local surface_not_used = args.surface and {
    asked = tostring(args.surface),
    reason = "a power plan is sized and measured on the planning bench, where a pole's reach can be "
      .. "read; the plan it returns is placed by you, wherever you place it",
  } or nil
  local origin, rejected = find_card_site(surface, normalized, force_name, args.origin, pad)
  if not origin then
    return fail("NO_CLEAR_SITE", "no candidate site fits this card", rejected)
  end

  local plan = verify.plan_power(surface, normalized, {
    force = force_name, origin = origin, power_of = power_profile_of,
    pole = args.pole, supply = args.supply, max_adds = args.max_adds,
  })
  plan.destroyed = verify.destroy(plan._built)
  plan._built = nil
  if plan.error then
    -- a method that answers with a bare {error=...} table is a method whose caller has to guess the
    -- shape; the envelope is what every other refusal in this API uses
    return fail(plan.error, "the power plan could not be made",
      { pole = plan.pole, known = plan.known, msg = plan.msg })
  end
  plan.planned_on = field(surface, "name")
  plan.surface_not_used = surface_not_used
  plan.card_name = normalized.name
  -- `plan.pole` and `plan.supply` already say what the plan was actually built with; re-stating a
  -- default here reported "small-electric-pole" for a card that had been planned with another tier.
  plan.next = plan.still_unserved == 0
    and "append the suggestion entries to entities, then re-run card_check and card_verify"
    or "this pole/supply pair cannot reach every machine here; try a longer-reach pole, more supply, or split the card"
  return plan
end

-- Supply side: which prototypes actually feed the electric grid is discovered from
-- data rather than a hardcoded list, so modpack generators are counted too.
local supply_cache = nil

local function supply_prototypes()
  if supply_cache then return supply_cache end
  local names, cap = {}, {}
  local INFINITE = 1e6
  for name, p in pairs(prototypes.entity) do
    local out = getter(p, "get_max_energy_production")
    if type(out) == "number" and out > 0 then
      names[#names + 1] = name
      -- kW like every other power figure here; the raw getter answer is J/tick.
      cap[name] = kw_of(out > INFINITE and INFINITE or out)
      if out > INFINITE then cap[name .. "_infinite"] = true end
    end
  end
  table.sort(names)
  supply_cache = { names = names, cap = cap }
  return supply_cache
end

function M.power(args)
  args = args or {}
  local sp = supply_prototypes()
  local out = { surfaces = {}, total_capacity_kw = 0, infinite_sources = 0 }
  if #sp.names == 0 then
    return fail("NO_GENERATORS", "no prototype produces electric energy")
  end

  for _, surface in pairs(game.surfaces) do
    if args.surface == nil or args.surface == surface.name or args.surface == surface.index then
      local ents = surface.find_entities_filtered { name = sp.names, force = args.force or "player" }
      local capacity, solar_kw, by_kind = 0, 0, {}
      for _, e in ipairs(ents) do
        local kw = sp.cap[e.name] or 0
        capacity = capacity + kw
        -- Sun output is nameplate; at night it is zero, so report both figures
        -- rather than letting a solar-only base look power-rich.
        if field(e.prototype, "type") == "solar-panel" then solar_kw = solar_kw + kw end
        local k = by_kind[e.name]
        if not k then k = { count = 0, kw_each = sp.cap[e.name] }; by_kind[e.name] = k end
        k.count = k.count + 1
      end
      out.surfaces[#out.surfaces + 1] = {
        surface = surface.name,
        capacity_kw = capacity,
        night_capacity_kw = capacity - solar_kw,
        solar_kw = solar_kw,
        generators = #ents,
        by_kind = by_kind,
      }
      out.total_capacity_kw = out.total_capacity_kw + capacity
    end
  end

  return out
end

-- Research and world state (L0 summary): the force, what it is researching, what queue it has,
-- and which surfaces exist. NOT power and NOT production -- per-surface totals need the 2.0
-- statistics model (`input_counts`/`output_counts`/`storage_counts`) and are deferred below;
-- the one power fact it does carry is `has_global_electric_network`, which is the tell for
-- whether a coverage answer on that surface means anything at all.
function M.state(args)
  args = args or {}
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end

  local queue = {}
  for _, t in ipairs(field(force, "research_queue") or {}) do queue[#queue + 1] = t.name end

  local surfaces = {}
  for _, s in pairs(game.surfaces) do
    -- Per-surface production/electricity totals are deferred: 2.0 rebuilt the
    -- statistics model around input_counts/output_counts/storage_counts.
    surfaces[#surfaces + 1] = {
      surface = s.name,
      has_global_electric_network = field(s, "has_global_electric_network"),
    }
  end

  return {
    force = force.name,
    current_research = (function()
      local cr = field(force, "current_research")
      return cr and cr.name or nil
    end)(),
    research_queue = queue,
    tech_total = (function()
      local n, done = 0, 0
      for _, t in pairs(force.technologies) do n = n + 1; if t.researched then done = done + 1 end end
      return { total = n, researched = done }
    end)(),
    surfaces = surfaces,
  }
end

-- Physical site survey. Ore is per-tile in 2.0, so it is aggregated here
-- rather than shipped as an entity list.
function M.site(args)
  args = args or {}
  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  local area, err = parse_area(args.area)
  if err then return err end

  local w = area.right_bottom.x - area.left_top.x
  local h = area.right_bottom.y - area.left_top.y
  if w * h > (args.max_cells or 65536) then
    return fail("AREA_TOO_LARGE", string.format("%dx%d exceeds %d cells", w, h, args.max_cells or 65536))
  end

  local ores = {}
  for _, e in ipairs(surface.find_entities_filtered { area = area, type = "resource" }) do
    local o = ores[e.name]
    if not o then
      o = { tiles = 0, amount = 0, min_x = e.position.x, max_x = e.position.x,
            min_y = e.position.y, max_y = e.position.y }
      ores[e.name] = o
    end
    o.tiles = o.tiles + 1
    o.amount = o.amount + (e.amount or 0)
    o.min_x = math.min(o.min_x, e.position.x); o.max_x = math.max(o.max_x, e.position.x)
    o.min_y = math.min(o.min_y, e.position.y); o.max_y = math.max(o.max_y, e.position.y)
  end
  for name, o in pairs(ores) do
    o.amount_per_tile = o.tiles > 0 and (o.amount / o.tiles) or 0
    o.prototype = (function()
      local p = prototypes.entity[name]
      if not p then return nil end
      return {
        -- Measured on this build: a resource prototype answers neither `category` nor `mining_time`
        -- (both raise, and `field` turns a raise into a silent nil, so the survey reported that ores
        -- have no mining cost at all), and there is no `walking_speed` on any prototype. The mining
        -- cost is on `mineable_properties`; walkability is a collision box, and an ore tile has one.
        category = field(p, "resource_category"),
        mining_time = (function()
          local mp = field(p, "mineable_properties")
          return mp and field(mp, "mining_time")
        end)(),
        infinite = field(p, "infinite_resource"),
        walkable = (function()
          local b = field(p, "collision_box")
          local lt, rb = b and field(b, "left_top"), b and field(b, "right_bottom")
          if not (lt and rb) then return nil end
          return ((rb.x or 0) - (lt.x or 0)) * ((rb.y or 0) - (lt.y or 0)) <= 0
        end)(),
      }
    end)()
  end

  local entities = {}
  for _, e in ipairs(surface.find_entities_filtered { area = area }) do
    if e.name ~= "character" then
      local k = e.name
      local en = entities[k]
      if not en then en = { count = 0, forces = {} }; entities[k] = en end
      en.count = en.count + 1
      local f = field(e, "force")
      local fname = (type(f) == "table" and f.name) or tostring(f)
      en.forces[fname] = (en.forces[fname] or 0) + 1
    end
  end

  local tiles
  if args.tiles then
    if w * h > (args.max_tile_cells or 4096) then
      return fail("AREA_TOO_LARGE_FOR_TILES", "per-tile sampling is capped; reduce the area")
    end
    tiles = {}
    for x = math.floor(area.left_top.x), math.floor(area.right_bottom.x) do
      for y = math.floor(area.left_top.y), math.floor(area.right_bottom.y) do
        local t = surface.get_tile(x, y)
        local n = t.name
        tiles[n] = (tiles[n] or 0) + 1
      end
    end
  end

  return {
    surface = surface.name,
    area = { area.left_top, area.right_bottom },
    size = { w, h },
    chunk_loaded = surface.is_chunk_generated {
      x = math.floor(area.left_top.x / 32), y = math.floor(area.left_top.y / 32),
    },
    ores = ores,
    entity_counts = entities,
    tile_counts = tiles,
  }
end

-- ============================================================
-- Lab: build, fast-forward, measure, tear down
--
-- V1 deliberately has zero geometry variables: no belts, no inserters.
-- Lua feeds the machines and drains their output, so the only thing under
-- test is whether the rig measures machine throughput correctly.
-- ============================================================

local SOURCE_INVENTORIES = { "furnace_source", "assembling_machine_input" }
local RESULT_INVENTORIES = { "furnace_result", "assembling_machine_output" }
-- A submitted card's in-ports are usually chests, but a card may point a port at
-- the machine itself, so the feed probe walks every plausible inventory.
local FEED_INVENTORIES = { "chest", "furnace_source", "assembling_machine_input" }

-- LuaEntity references are only valid within one game session, so lab jobs do
-- not survive save/load; a resumed job with no handles is aborted on the next tick.
-- (the job's own `ents`/`rig` tables are what the card methods filled in.)

local function top_up(e, inv_names, item, want, job, blocked_key)
  if not item then return 0 end
  for _, name in ipairs(inv_names) do
    local id = defines.inventory[name]
    if id then
      local ok, moved = pcall(function()
        local inv = e.get_inventory(id)
        if not inv then return 0 end
        return inv.insert({ name = item, count = want })
      end)
      if ok and moved > 0 then return moved end
      -- An error here is non-recoverable and takes the whole server down, so the
      -- counter has to survive a job created without this field.
      if ok then job[blocked_key] = (job[blocked_key] or 0) + 1 end
    end
  end
  return 0
end

-- One self-contained lane, parameterised by arm reach.
--
--   y=0:        [in] ...[A]... [belt][belt][belt][belt][belt] [overflow]
--   y=R:                        [B]
--   y=2R:                     [furnace fw x fh]
--   y=2R+fh-1:                              [C] [out]
-- An inserter's `direction` is its PICKUP side; it drops on the opposite side, so
-- every offset below is a multiple of the arm's reach. Hardcoding reach-1 spacing
-- made a long-handed lane lint clean and then drop its plates on the ground — only
-- the engine sees that, which is why lane_units takes reach instead of assuming it.
lane_units = function(ox, oy, count, furnace, belt, inserter, chest, fw, fh, power, reach, outlets, gap)
  local R = math.max(1, math.floor(reach or 1))
  local run = 2 * R + 3                       -- belt tiles on the input row
  local fcol = 2 * R + math.floor(run / 2)    -- column the furnace column starts at
  local out_row = oy + 2 * R + fh - 1
  local rightmost = fcol + fw - 1 + 2 * R
  -- Spacing is empty columns between lanes, and it is a real number rather than a label: it decides
  -- how much ground a lane takes and therefore how many fit in a box. `0` is what the geometry alone
  -- allows -- the tightest lane where no belt, arm or chest shares a cell with its neighbour. Anything
  -- more is room for the runs a player will route by hand later, which is the part this mod leaves
  -- alone on purpose.
  local pitch = math.max(2 * R + run + 3, rightmost + 3) + math.max(0, math.floor(gap or 0))
  local out = {}
  for i = 0, count - 1 do
    local ux = ox + i * pitch
    out[#out + 1] = { name = chest,    cell = { ux, oy }, dir = 0, role = "in" }
    out[#out + 1] = { name = inserter, cell = { ux + R, oy }, dir = DIR.west }
    for b = 2 * R, 2 * R + run - 1 do
      out[#out + 1] = { name = belt, cell = { ux + b, oy }, dir = DIR.east }
    end
    out[#out + 1] = { name = chest, cell = { ux + 2 * R + run, oy }, dir = 0, role = "overflow" }
    out[#out + 1] = { name = inserter, cell = { ux + fcol, oy + R }, dir = DIR.north }
    out[#out + 1] = { name = furnace,  cell = { ux + fcol, oy + 2 * R }, dir = 0 }
    out[#out + 1] = { name = inserter, cell = { ux + fcol + fw - 1 + R, out_row }, dir = DIR.west }
    out[#out + 1] = { name = chest,    cell = { ux + rightmost, out_row }, dir = 0, role = "out" }
    -- A second outlet takes from the furnace's top row: one machine, two anchors.
    -- Fan-out never creates throughput -- it only lets several downstream cards
    -- reach the same output -- so the lane's claim stays what the furnace can make.
    if outlets and outlets >= 2 then
      out[#out + 1] = { name = inserter, cell = { ux + fcol + fw - 1 + R, oy + 2 * R }, dir = DIR.west }
      out[#out + 1] = { name = chest,    cell = { ux + rightmost, oy + 2 * R }, dir = 0, role = "out" }
    end
    if power then
      out[#out + 1] = { name = power, cell = { ux + rightmost + 2, oy + R }, dir = 0 }
    end
  end
  return out
end

-- Inserter reach is not readable from the runtime prototype (type-specific fields
-- are absent there), so it is measured from a live entity once per type. Hardcoding
-- a reach table would silently rot the moment a modded inserter shows up.
local reach_cache = {}

inserter_reach = function(surface, name, force_name)
  if not surface or not name then return 1 end
  if reach_cache[name] then return reach_cache[name] end
  local p = prototypes.entity[name]
  if not p or field(p, "type") ~= "inserter" then return 1 end
  local reach
  for r = 0, 10 do
    local pos = { x = -r * 3, y = -r * 3 - 1 }
    if surface.can_place_entity { name = name, position = pos, force = force_name, direction = DIR.west } then
      local e = surface.create_entity { name = name, position = pos, force = force_name, direction = DIR.west }
      if e then
        local ok, pp = pcall(function() return e.pickup_position end)
        if ok and type(pp) == "table" and type(pp.x) == "number" then
          reach = math.floor((pos.x - pp.x) + 0.5)
        end
        e.destroy()
      end
      break
    end
  end
  reach_cache[name] = reach or 1
  return reach_cache[name]
end

-- A belt bus: one input, one main belt, N equally spaced tap points.
--
-- Chests cannot distribute: two arms pulling from the same furnace split its output and both
-- starve. A belt carries the stack past every consumer and each consumer takes its own, so the
-- only limit left is the supply rate. Tap pitch must exceed the widest consumer's footprint or the
-- consumers collide with each other, which is why it is a parameter and not a constant.
bus_line = function(ox, oy, taps, belt, inserter, chest, reach, pitch)
  local R = math.max(1, math.floor(reach or 1))
  local step = math.max(2 * R + 2, pitch or 12)
  local feed = 2 * R
  local span = math.max(3, (taps or 1) * step + 3)
  local out = {}
  out[#out + 1] = { name = chest, cell = { ox, oy }, dir = 0, role = "in" }
  out[#out + 1] = { name = inserter, cell = { ox + R, oy }, dir = DIR.west }
  for b = feed, feed + span - 1 do
    out[#out + 1] = { name = belt, cell = { ox + b, oy }, dir = DIR.east }
  end
  -- whatever no consumer took has to land somewhere visible, not on the ground
  out[#out + 1] = { name = chest, cell = { ox + feed + span, oy }, dir = 0, role = "collector" }
  for k = 0, (taps or 1) - 1 do
    local tc = ox + feed + 1 + k * step
    out[#out + 1] = { name = inserter, cell = { tc, oy + R }, dir = DIR.north }
    out[#out + 1] = { name = chest, cell = { tc, oy + 2 * R }, dir = 0, role = "tap" }
  end
  return out
end

-- 2.0 inserters draw power. The rig supplies it through an electric energy
-- interface on a single global grid so pole routing stays out of the measurement;
-- real cards still have to solve coverage themselves.
local function add_supply(specs, ox, oy, gens)
  for i = 1, gens do
    specs[#specs + 1] = { name = "electric-energy-interface", cell = { ox - 2, oy + 6 + i }, dir = DIR.north, role = "gen" }
  end
  return specs
end

function M.lab_card(args)
  args = args or {}
  if lab_is_live(storage.lab) then
    return fail("LAB_BUSY", "job " .. tostring(storage.lab.id) .. " still " .. storage.lab.state
      .. "; call lab_stop")
  end

  -- Deliberately NOT the bench, the way `card_lab` now is: this rig smelts ore, so it needs a surface
  -- that has ore on it, and a cleared grass pad answers "there is no ore here" instead of a rate. The
  -- global grid it makes is still irreversible, so it is still reported (`ideal_grid`).
  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  local count = args.furnaces or 4
  -- the *cheap* end of each role on purpose: a measurement fixture wants the slowest legal machine so
  -- the rate it reports belongs to the card, not to a tier nobody can build yet
  local furnace = example_part("furnace", "stone-furnace", args.furnace)
  local belt = example_part("belt", "transport-belt", args.belt)
  local inserter = example_part("arm", "inserter", args.inserter)
  local chest = example_part("chest", "steel-chest", args.chest)
  if not (furnace and belt and inserter and chest) then
    return fail("NO_AVAILABLE_PART", "the rig needs a furnace, a belt, an arm and a container",
      { furnace = furnace, belt = belt, arm = inserter, chest = chest })
  end
  local recipe = args.recipe or "iron-plate"
  local product = args.product or recipe
  local ingredient = args.ingredient or "iron-ore"
  local fuel = args.fuel or "coal"
  local seconds = args.seconds or 30
  local speed = args.speed or 20
  local ox = (args.origin or {}).x or 1200
  local oy = (args.origin or {}).y or 1200

  local fp = prototypes.entity[furnace]
  if not fp then return fail("UNKNOWN_MACHINE", furnace) end
  local rp = prototypes.recipe[recipe]
  if not rp then return fail("UNKNOWN_RECIPE", recipe) end
  local fw = field(fp, "tile_width") or 2
  local fh = field(fp, "tile_height") or 2
  local m_speed = getter(fp, "get_crafting_speed")
  if not m_speed then return fail("NOT_A_CRAFTER", furnace) end
  local energy = field(rp, "energy")
  local expected_per_min = count * (60 / (energy / m_speed))

  local power = args.power
  local gens_wanted = args.generators or 1

  local reach = inserter_reach(surface, inserter, "player")

  local function plan(at_x, at_y)
    return add_supply(lane_units(at_x, at_y, count, furnace, belt, inserter, chest, fw, fh, power, reach),
      at_x, at_y, gens_wanted)
  end

  local function blockers(at_x, at_y)
    local bad = {}
    for _, s in ipairs(plan(at_x, at_y)) do
      local p = prototypes.entity[s.name]
      local w = (p and p.tile_width) or 1
      local h = (p and p.tile_height) or 1
      if not surface.can_place_entity {
        name = s.name, position = { x = s.cell[1] + w / 2, y = s.cell[2] + h / 2 },
        direction = s.dir, force = "player",
      } then
        bad[#bad + 1] = { name = s.name, x = s.cell[1], y = s.cell[2] }
      end
    end
    return bad
  end

  local specs, tried = nil, {}
  local candidates = {}
  if args.origin then
    candidates[1] = { ox, oy }
  else
    for r = 0, 6 do
      for _, d in ipairs({ { r, 0 }, { -r, 0 }, { 0, r }, { 0, -r },
                           { r, r }, { -r, -r }, { r, -r }, { -r, r } }) do
        candidates[#candidates + 1] = { d[1] * 10, d[2] * 10 }
      end
    end
  end

  for _, c in ipairs(candidates) do
    local bad = blockers(c[1], c[2])
    if #bad == 0 then
      ox, oy = c[1], c[2]
      specs = plan(ox, oy)
      break
    end
    if #tried < 6 then tried[#tried + 1] = { x = c[1], y = c[2], blocked = #bad } end
  end

  if not specs then
    return fail("NO_CLEAR_SITE", "no origin fits a lane; pass an explicit origin", tried)
  end

  local grid_before = field(surface, "has_global_electric_network")
  pcall(function() surface.create_global_electric_network() end)
  local ideal_grid = {
    surface = field(surface, "name"), was_global = grid_before == true,
    converted_here = grid_before ~= true and field(surface, "has_global_electric_network") == true,
  }

  local in_chests, out_chests, over_chests, gens = {}, {}, {}, {}
  local built = {}

  -- Inserters get auto-oriented at creation time, so they must be placed last
  -- and then forced to the intended direction once their neighbours exist.
  local pending_inserters = {}
  for pass = 1, 2 do
    for _, s in ipairs(specs) do
      local proto = prototypes.entity[s.name]
      local is_ins = (proto and field(proto, "type")) == "inserter"
      if (pass == 1) ~= is_ins then
        local w = (proto and proto.tile_width) or 1
        local h = (proto and proto.tile_height) or 1
        local pos = { x = s.cell[1] + w / 2, y = s.cell[2] + h / 2 }
        local e = surface.create_entity { name = s.name, position = pos, direction = s.dir, force = "player" }
        if not e then
          for _, prev in ipairs(built) do if prev.valid then prev.destroy() end end
          return fail("LAB_BUILD_FAILED", s.name .. " at " .. s.cell[1] .. "," .. s.cell[2])
        end
        built[#built + 1] = e
        if is_ins then
          pending_inserters[#pending_inserters + 1] = { e = e, dir = s.dir }
        elseif s.role == "in" then
          in_chests[#in_chests + 1] = e
        elseif s.role == "out" then
          out_chests[#out_chests + 1] = e
        elseif s.role == "overflow" then
          over_chests[#over_chests + 1] = e
        elseif s.role == "gen" then
          gens[#gens + 1] = e
        end
      end
    end
  end

  local orient_err
  for _, p in ipairs(pending_inserters) do
    if p.e.valid then
      local ok, err = pcall(function()
        p.e.direction = p.dir
        p.e.rotatable = false
      end)
      if not ok then orient_err = tostring(err) end
    end
  end

  local fuel_err
  for _, e in ipairs(built) do
    local et = field(e, "type")
    if et == "furnace" or et == "assembling-machine" then
      local ok, err = pcall(function()
        local inv = e.get_inventory(defines.inventory.fuel)
        if inv then return inv.insert({ name = fuel, count = 40 }) end
        return 0
      end)
      if not ok then fuel_err = tostring(err) end
    end
  end

  storage.lab = {
    id = (storage.lab and storage.lab.id or 1000) + 1,
    mode = "card",
    state = "running",
    started = game.tick,
    deadline = game.tick + math.floor(seconds * 60),
    prev_speed = game.speed,
    speed = speed,
    surface = surface.name,
    machine = furnace,
    recipe = recipe,
    product = product,
    ingredient = ingredient,
    fuel = fuel,
    units = count,
    expected_per_min = expected_per_min,
    produced = 0,
    fed = 0,
    fed_blocked = 0,
    fuelled = 0,
    fuel_blocked = 0,
    missing = 0,
  }
  storage.lab.ents = built
  storage.lab.rig = { in_chests = in_chests, out_chests = out_chests, over_chests = over_chests, gens = gens }

  -- Peak draw of everything actually placed, so the arms and belts that dominate
  -- a card's demand are visible instead of being hand-waved at the machine count.
  local card_power = { peak_grid_kw = 0, peak_fuel_kw = 0, by_kind = {} }
  for _, s in ipairs(specs) do
    if s.role ~= "gen" then
      local p = prototypes.entity[s.name]
      local w = draw_kw_of(p)
      local og = field(p, "electric_energy_source_prototype") ~= nil
      local e = card_power.by_kind[s.name]
      if not e then e = { count = 0, kw_each = w, on_grid = og }; card_power.by_kind[s.name] = e end
      e.count = e.count + 1
      if og then card_power.peak_grid_kw = card_power.peak_grid_kw + w
      else card_power.peak_fuel_kw = card_power.peak_fuel_kw + w end
    end
  end

  host.clock_raise(speed)

  return {
    job = storage.lab.id,
    state = "running",
    lane_count = count,
    card_power = card_power,
    ideal_grid = ideal_grid,
    entities = #specs,
    furnace = furnace,
    furnace_tiles = { fw, fh },
    belt = belt,
    inserter = inserter,
    recipe_energy = energy,
    machine_speed = m_speed,
    expected_per_min = expected_per_min,
    run_ticks = math.floor(seconds * 60),
    speed = speed,
    fuel_seed_error = fuel_err,
    inserter_orient_error = orient_err,
    origin = { ox, oy },
    arm_reach = reach,
    layout = { furnace_cells = { fw, fh }, input_row = oy },
  }
end

function M.lab_start(args)
  args = args or {}
  if lab_is_live(storage.lab) then
    return fail("LAB_BUSY", "job " .. tostring(storage.lab.id) .. " still " .. storage.lab.state
      .. "; call lab_stop")
  end

  -- The rig bench, not the player's world. `lab_start` is the one path in this API that used to
  -- place machines without asking the ground anything: no site search, no obstacle test, and an
  -- `origin` that defaulted to the literal (600,600) -- which on the main surface means "build four
  -- furnaces wherever that happens to be, and report nothing about it".
  local surface = args.surface and resolve_surface(args.surface)
  if args.surface == nil then
    local why
    surface, _, why = rig_surface()
    if not surface then
      return fail("SANDBOX_" .. tostring(why or "UNAVAILABLE"),
        why == "GENERATING" and "the measurement bench is still generating; call again"
          or "the measurement bench could not be prepared", { reason = why })
    end
  end
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end

  local machine = args.machine or "stone-furnace"
  local recipe = args.recipe or "iron-plate"
  local count = args.count or 4
  local seconds = args.seconds or 30
  local speed = args.speed or 20
  local fuel = args.fuel or "coal"

  local mp = prototypes.entity[machine]
  if not mp then return fail("UNKNOWN_MACHINE", machine) end
  local rp = prototypes.recipe[recipe]
  if not rp then return fail("UNKNOWN_RECIPE", recipe) end

  local m_speed = getter(mp, "get_crafting_speed") or getter(mp, "get_researching_speed")
  if not m_speed then return fail("NOT_A_CRAFTER", machine) end
  local energy = field(rp, "energy")
  -- The same expected-yield rule every other site uses, and the fourth copy of it lived here:
  -- `amount` is absent whenever a product is randomised (`amount_min`/`amount_max` are there
  -- instead), and `probability` is a chance, not a quantity -- reading one as the other is what
  -- sized a centrifuge 143x too small once before.
  local yields = 0
  for _, pr in ipairs(field(rp, "products") or {}) do
    if pr.name == (args.product or recipe) then
      local each = (pr.amount or pr.amount_min or 1) * (pr.probability or 1)
      if pr.amount == nil and (pr.amount_min or pr.amount_max) then
        each = ((pr.amount_min or 0) + (pr.amount_max or 0)) / 2 * (pr.probability or 1)
      end
      yields = yields + each
    end
  end
  local product = args.product or recipe
  local ingredients = field(rp, "ingredients") or {}
  local ingredient = args.ingredient or (ingredients[1] or {}).name
  if not ingredient then return fail("NO_SINGLE_INGREDIENT", recipe) end
  -- The runner inserts this name into every machine's input. A name that is not an item raises on
  -- each insert, is swallowed by the pcall around it, and the job then measures a machine that was
  -- never fed -- a rate of 0 with nothing in the answer saying the ingredient was made up.
  if not prototypes.item[ingredient] then
    return fail("UNKNOWN_INGREDIENT", ingredient .. " is not an item on this install",
      { recipe = recipe, ingredients = (function()
          local l = {}
          for _, ing in ipairs(ingredients) do l[#l + 1] = ing.name end
          return l
        end)() })
  end
  -- The runner feeds this one item into every machine. A recipe with two ingredients therefore
  -- crafts nothing at all, and the answer was a measured rate of 0 against a non-zero expectation --
  -- a machine that "cannot make this recipe" rather than "was only given half of what it needs".
  if #ingredients > 1 and not args.ingredient then
    local list = {}
    for _, ing in ipairs(ingredients) do list[#list + 1] = ing.name end
    return fail("NOT_A_SINGLE_INGREDIENT_RECIPE",
      recipe .. " takes " .. #ingredients .. " ingredients and this rig feeds one; pass `ingredient`",
      { ingredients = list, recipe = recipe })
  end

  local expected_per_min = count * (60 / (energy / m_speed)) * yields

  local origin = args.origin
  if not origin then
    -- A row wide enough for every machine, found rather than assumed. The pad is cleared, but
    -- autoplace puts something back, and `create_entity` will happily build on ground the next
    -- placement needs -- so every slot is asked for before any is built.
    local step = 4
    local found, tried = nil, 0
    for oy = -SANDBOX_PAD + 8, SANDBOX_PAD - 8, step do
      for ox = -SANDBOX_PAD + 8, SANDBOX_PAD - 8, step do
        tried = tried + 1
        local fits = true
        for i = 1, count do
          if not surface.can_place_entity { name = machine, position = { x = ox + i * step, y = oy },
                                            force = "player" } then
            fits = false
            break
          end
        end
        if fits then found = { x = ox, y = oy } break end
        if tried > 400 then break end
      end
      if found or tried > 400 then break end
    end
    if not found then
      return fail("NO_CLEAR_SITE", "no row of " .. count .. " " .. machine
        .. " fits on the bench; pass an explicit origin", { spots_tried = tried })
    end
    origin = found
  end

  local built, bound, bind_note = {}, 0, nil
  for i = 1, count do
    local pos = { x = origin.x + i * 4, y = origin.y }
    local e = surface.create_entity { name = machine, position = pos, force = "player" }
    if not e then
      for _, prev in ipairs(built) do if prev.valid then prev.destroy() end end
      return fail("LAB_BUILD_FAILED", "no room at " .. pos.x .. "," .. pos.y,
        { built_then_destroyed = #built, origin = origin })
    end
    built[#built + 1] = e
    -- Measured on this build: `set_recipe` answers "Entity is not assembling-machine." for a furnace
    -- -- 2.0 lets a furnace choose from the ingredients in front of it and exposes no setter. A raise
    -- here is therefore not the rig doing something wrong, and must not stop the job; it is also not
    -- something to hide, because the caller should know the recipe was fixed by what the bench feeds
    -- rather than by a command. On an assembling-machine the setter exists, and a machine that will
    -- not take the recipe cannot be measured at all -- that one is a refusal.
    local ok_set, set_err = pcall(function() e.set_recipe(recipe) end)
    if not ok_set then
      local msg = tostring(set_err):gsub("[\r\n]+", " "):sub(1, 160)
      if field(mp, "type") == "assembling-machine" then
        for _, prev in ipairs(built) do if prev.valid then prev.destroy() end end
        return fail("RECIPE_REJECTED", machine .. " refused " .. recipe, { error = msg })
      end
      if not bind_note then bind_note = msg end
    else
      bound = bound + 1
    end
  end

  storage.lab = {
    id = (storage.lab and storage.lab.id or 1000) + 1,
    state = "running",
    started = game.tick,
    deadline = game.tick + math.floor(seconds * 60),
    prev_speed = game.speed,
    speed = speed,
    surface = surface.name,
    machine = machine,
    recipe = recipe,
    product = product,
    ingredient = ingredient,
    fuel = fuel,
    expected_per_min = expected_per_min,
    recipes_bound = bound,
    recipe_bind_note = bind_note,
    produced = 0,
    fed = 0,
    fed_blocked = 0,
    fuelled = 0,
    fuel_blocked = 0,
    missing = 0,
  }
  storage.lab.ents = built

  host.clock_raise(speed)

  return {
    job = storage.lab.id,
    state = "running",
    machines = count,
    machine = machine,
    recipe = recipe,
    ingredient = ingredient,
    product = product,
    machine_speed = m_speed,
    recipe_energy = energy,
    expected_per_min = expected_per_min,
    run_ticks = math.floor(seconds * 60),
    speed = speed,
    -- where the machines went, and on which ground: this rig used to build at a literal (600,600)
    -- without saying so, which is the sort of fact a caller cannot recover afterwards
    surface = surface.name, origin = origin,
    recipes_bound = bound,
    recipe_bind_note = bind_note,
    wall_seconds_estimate = seconds * 60 / (60 * speed),
  }
end

function M.lab_status(args)
  args = args or {}
  local j = storage.lab
  if not j then return fail("NO_JOB", "no lab job has been started") end
  local elapsed = game.tick - j.started
  return {
    job = j.id, state = j.state,
    -- which card this job belongs to, so the panel's "Keep measurement" can name the row it will
    -- change before the player presses it
    card = j.card_name, for_card = j.for_card,
    elapsed_ticks = elapsed,
    remaining_ticks = math.max(0, j.deadline - game.tick),
    produced = j.produced,
    expected_per_min = j.expected_per_min,
    measured_per_min = j.measured_per_min,
    ratio_measured_over_expected = j.ratio,
    fed = j.fed, fed_blocked = j.fed_blocked,
    fuelled = j.fuelled, fuel_blocked = j.fuel_blocked,
    missing_entities = j.missing,
    destroyed = j.destroyed,
    verdicts = j.verdicts,
    delivered = j.delivered,
    pay_fraction = j.pay_fraction,
    -- fluid measurement has to reach the caller through the same door the item numbers do;
    -- these live on the job, and a projection that forgets them reads as "nothing was measured"
    fluid_yields = j.fluid_yields,
    machine_status = j.machine_status,
    supply_faces = j.supply_faces,
    supply_problems = j.supply_problems,
    box_notes = j.box_notes,
    probed = j.probed,
    diagnostics = j.diagnostics,
    tick_error = j.tick_error,
    -- which of the two endings this was, and what was taken out: an `abandoned` job with
    -- `destroyed = 0` is a bench full of machines that belong to nothing
    abandoned_because = j.abandoned_because,
    game_speed = game.speed,
  }
end

-- What this process's SAVE knows about the bench, read-only.
--
-- The question a desync report needs answered is not "is a job running" but "does the job record
-- still carry the entities it is measuring" -- the failure that caused one was a `running` record
-- whose handles lived only in the process that started it, so every process that loaded the game
-- afterwards drew a different conclusion about the same save. Both halves are here (the record and
-- the ground it stands on) so a client and a server can be compared with one call each and the
-- difference named instead of guessed at.
function M.bench_state(args)
  args = args or {}
  local j = storage.lab
  local out = {
    tick = game.tick,
    surfaces = {},
    lab_job = j and {
      id = j.id, state = j.state, mode = j.mode, surface = j.surface,
      -- a `running` job with `entities_carried = 0` is the desync shape: the record claims a
      -- measurement nobody in this process can reach
      entities_carried = #(j.ents or {}),
      rig_carried = j.rig ~= nil,
      abandoned_because = j.abandoned_because,
    } or nil,
    -- the two ore/fluid rigs look their entities up by unit number every tick, so they carry
    -- identity rather than handles and have never had the problem above. Said here so the comparison
    -- is complete: if these two disagree between machines, it is not the same bug.
    drill_job = storage.drill_job ~= nil,
    pump_job = storage.pump_job ~= nil,
  }
  for _, name in ipairs({ LAB_SURFACE, SANDBOX_SURFACE }) do
    local s = game.surfaces[name]
    out.surfaces[name] = {
      exists = s ~= nil,
      -- whose pads have been painted is a per-save fact; a process that has to paint again is a
      -- process about to lay tiles the others will not
      primed = storage[PRIME_KEY .. name] == true,
      ready_at_tick = storage["surface_ready_" .. name],
      pad_entities = s and #s.find_entities_filtered {
        area = { { -SANDBOX_PAD, -SANDBOX_PAD }, { SANDBOX_PAD, SANDBOX_PAD } } } or nil,
    }
  end
  return out
end

local function lab_diagnostics(j)
  local rig = j.rig
  if not rig then return nil end
  local d = { in_chest_left = 0, out_chest_have = 0, overflow_caught = 0,
              fuel_left = 0, starved_furnaces = 0, furnaces = 0 }
  for _, c in ipairs(rig.in_chests) do
    if c.valid then pcall(function() d.in_chest_left = d.in_chest_left + c.get_item_count(j.ingredient) end) end
  end
  for _, c in ipairs(rig.over_chests or {}) do
    if c.valid then pcall(function() d.overflow_caught = d.overflow_caught + c.get_item_count(j.ingredient) end) end
  end
  for _, c in ipairs(rig.out_chests) do
    if c.valid then pcall(function() d.out_chest_have = d.out_chest_have + c.get_item_count(j.product) end) end
  end
  for _, e in ipairs(j.ents or {}) do
    if e.valid and e.type == "furnace" then
      d.furnaces = d.furnaces + 1
      pcall(function()
        local f = e.get_inventory(defines.inventory.fuel)
        if f then d.fuel_left = d.fuel_left + f.get_item_count(j.fuel) end
        local s = e.get_inventory(defines.inventory.furnace_source)
        if s and s.get_item_count(j.ingredient) == 0 then d.starved_furnaces = d.starved_furnaces + 1 end
      end)
    end
  end
  return d
end

local function finalize_lab(j)
  j.state = "done"
  local elapsed = game.tick - j.started
  local minutes = elapsed / 3600
  j.measured_per_min = minutes > 0 and (j.produced / minutes) or 0
  j.ratio = j.expected_per_min > 0 and (j.measured_per_min / j.expected_per_min) or nil

  -- A contract is a set of claims, so it is judged item by item: a card that hits
  -- its plates but misses its gears has not delivered, and a blended average
  -- would hide that.
  --
  -- The claim is a steady-state rate but every window pays a fixed startup cost (belt fill +
  -- first arm swing + first craft cycle), which is a constant delay rather than a proportional
  -- loss. Judging a short run against full steady state would fail correct
  -- cards, so the expectation is discounted by the fraction of the window that was
  -- actually producing. The undiscounted ratio is still reported, nothing is hidden.
  if j.contract then
    local window = elapsed / 60
    local warm = j.warmup_seconds or 4
    local pay = window > warm and ((window - warm) / window) or 0
    j.pay_fraction = pay
    j.verdicts = {}
    local function judge(name, want, kind)
      local got = ((kind == "fluid" and j.fluid_yields or j.yields) or {})[name] or 0
      local per_min = minutes > 0 and (got / minutes) or 0
      local expected_got = want * minutes * pay
      j.verdicts[#j.verdicts + 1] = {
        kind = kind, item = kind == "item" and name or nil,
        fluid = kind == "fluid" and name or nil,
        claimed_per_min = want, measured_per_min = per_min,
        produced = got, expected_in_window = expected_got,
        ratio = want > 0 and (per_min / want) or nil,
        met = got + 1e-6 >= expected_got,
      }
    end
    for item, want in pairs(j.contract) do judge(item, want, "item") end
    for fluid, want in pairs(j.contract_fluids or {}) do judge(fluid, want, "fluid") end
    table.sort(j.verdicts, function(a, b)
      if a.kind ~= b.kind then return a.kind < b.kind end
      return (a.item or a.fluid) < (b.item or b.fluid)
    end)
    j.delivered = true
    for _, v in ipairs(j.verdicts) do if not v.met then j.delivered = false end end
  end

  j.diagnostics = lab_diagnostics(j)
  local gone = 0
  for _, e in ipairs(j.ents or {}) do
    if e.valid then
      e.destroy()
      gone = gone + 1
    end
  end
  j.ents, j.rig = nil, nil
  j.destroyed = gone
  if j.prev_speed then host.clock_lower(j.prev_speed) end

  return {
    job = j.id, state = j.state,
    -- which card this job belongs to, so the panel's "Keep measurement" can name the row it will
    -- change before the player presses it
    card = j.card_name, for_card = j.for_card,
    elapsed_ticks = elapsed,
    produced = j.produced,
    fluid_yields = j.fluid_yields,
    machine_status = j.machine_status,
    supply_faces = j.supply_faces,
    supply_problems = j.supply_problems,
    box_notes = j.box_notes,
    probed = j.probed,
    measured_per_min = j.measured_per_min,
    expected_per_min = j.expected_per_min,
    ratio_measured_over_expected = j.ratio,
    fed = j.fed, fed_blocked = j.fed_blocked,
    fuelled = j.fuelled, fuel_blocked = j.fuel_blocked,
    missing_entities = j.missing,
    destroyed = gone,
    verdicts = j.verdicts,
    delivered = j.delivered,
    pay_fraction = j.pay_fraction,
    contract = j.contract,
    diagnostics = j.diagnostics,
    speed_restored_to = game.speed,
  }
end

function M.lab_stop(args)
  local j = storage.lab
  if not j then return fail("NO_JOB", "nothing to stop") end
  if not lab_is_live(j) then
    return fail("LAB_IDLE", "job " .. tostring(j.id) .. " already " .. j.state)
  end
  return finalize_lab(j)
end

-- Jobs do not survive save/load, but their state does; this clears a resurrected
-- record so a stale "running" job cannot block every later start.
function M.lab_reset(args)
  local j = storage.lab
  local cleared = 0
  if j then
    for _, e in ipairs(j.ents or {}) do
      if e.valid then e.destroy(); cleared = cleared + 1 end
    end
    j.ents, j.rig = nil, nil
    storage.lab = nil
    if j.prev_speed then host.clock_lower(j.prev_speed) end
  end
  -- What the rigs measured is bench state too. A cached rate silently changes which machine the
  -- solver picks for the next request, so a suite that resets the bench and then plans would plan
  -- against a world some earlier run probed.
  local forgotten = 0
  for _, cache in ipairs({ "drills", "pumps" }) do
    for _ in pairs(storage[cache] or {}) do forgotten = forgotten + 1 end
    storage[cache] = nil
  end
  return { cleared_entities = cleared, forgot_measurements = forgotten, had_job = j and j.id or nil }
end

-- An error thrown out of on_nth_tick is non-recoverable: Factorio tears the whole
-- server down and leaves game.speed raised. The lab walks arbitrary AI-authored
-- cards, so it must never be able to take the game with it.
-- One fluid, one pass, one reading. The offers are laid on every face at cells that cannot touch
-- each other, the game is given a moment to draw one of them in, and the pipe that emptied names
-- the cell the box is on. Nothing is guessed except which two passes cover a face.
local function probe_lay(j, rig)
  local st = rig.probe
  local ent = rig.machine_of[st.current.at]
  if not ent or not ent.valid then
    rig.problems[#rig.problems + 1] = { fluid = st.current.fluid, at = st.current.at,
      why = "MACHINE_GONE" }
    st.current = nil
    return
  end
  local surface = game.surfaces[j.surface]
  -- empty the box before testing for it, or a machine already holding this fluid answers "no box"
  -- to every cell on the face where its box actually is
  fluidrig.clear_box(ent, st.current.fluid)
  st.probes = fluidrig.offer_pass(ent, surface, j.force, st.current.fluid, st.pass, 50)
  st.until_tick = game.tick + LAB_PROBE_SETTLE
end

-- The fixtures are built only once every ingredient has a cell, because a row laid over the wrong
-- cell steals fluid from the machine just as plausibly as the right one and the reading would not
-- tell them apart.
local function probe_build(j, rig)
  local st = rig.probe
  local surface = game.surfaces[j.surface]
  local by_machine = {}
    for _, f in ipairs(st.found) do
    by_machine[f.at] = by_machine[f.at] or {}
    table.insert(by_machine[f.at], { fluid = f.fluid, face = f.face, off = f.off,
      source = f.source })
  end
  local order = {}
  for at in pairs(by_machine) do order[#order + 1] = at end
  table.sort(order)
  for _, at in ipairs(order) do
    local ent = rig.machine_of[at]
    local runs, problems = fluidrig.plan(ent, by_machine[at])
    for _, pr in ipairs(problems or {}) do rig.problems[#rig.problems + 1] = pr end
    for _, r in ipairs(runs) do
      -- Building happens again after a table entry is rejected and its fluid goes through discovery,
      -- and a machine's plan covers every fluid it holds -- so what is already standing on the
      -- ground is left standing rather than built twice.
      local key = at .. "|" .. r.fluid
      if not st.built[key] then
        -- where the tank stands is the one part of a run the site search cannot have cleared in
        -- advance, so a refused tank is tried at the rest of the row's cells rather than given up
        -- on: the pipes already fit, and which cell the machine drew from is measured either way
        local made, why = nil, nil
        for _, anchor in ipairs(fluidrig.anchor_order(r.cells, r.anchor)) do
          local got, err = fluidrig.run(ent, surface, j.force, r.fluid, r.face, r.cells, anchor, true)
          if got then made = got break end
          why = err
        end
        if made then
          made.at, made.source = at, r.source
          st.built[key] = made
          rig.runs[#rig.runs + 1] = made
          rig.ents[#rig.ents + 1] = made.tank
          for _, p in ipairs(made.pipes) do rig.ents[#rig.ents + 1] = p end
        else
          rig.problems[#rig.problems + 1] = { fluid = r.fluid, at = at, face = r.face, why = why }
        end
      end
    end
  end
end

local function open_window(j, rig)
  j.probed = rig.probe.found
  j.supply_problems = #rig.problems > 0 and rig.problems or nil
  j.box_notes = #rig.notes > 0 and rig.notes or nil
  -- A job that cannot feed every ingredient it was given has no rate to report: the machine would
  -- run short of one fluid and idle for the other, and the number that came out would be the rig's,
  -- not the card's. So the window only opens on a plan proved to be moving fluid.
  if #rig.problems > 0 or #rig.runs == 0 then
    j.state = "supply_unproven"
    j.reason = (rig.problems[1] or {}).why or "NO_RUNS_BUILT"
    if j.prev_speed then host.clock_lower(j.prev_speed) end
    return
  end
  j.started = game.tick
  j.deadline = game.tick + j.window_ticks
  j.state = "running"
end

-- Every run has to be moving fluid before the window opens. This is where a `boxes` entry that is
-- wrong, or stale, or read at a direction this machine is not facing, gets caught: the row comes
-- back out, that fluid goes through discovery like any unknown one, and the mismatch is reported
-- rather than swallowed.
local function prove_start(j, rig)
  for _, r in ipairs(rig.runs) do
    r.moved = 0
    r.last = fluidrig.held(r.tank, r.fluid)
  end
  rig.probe.until_tick = game.tick + LAB_PROVE_SETTLE
  j.state = "proving"
end

local function prove_tick(j, rig)
  local st = rig.probe
  for _, r in ipairs(rig.runs) do fluidrig.top_up(r) end
  if game.tick < st.until_tick then return end
  local stalled, unproven = {}, {}
  for _, r in ipairs(rig.runs) do
    if (r.moved or 0) <= 0 then stalled[#stalled + 1] = r else unproven[#unproven + 1] = r end
  end
  local rejected = {}
  for _, r in ipairs(stalled) do
    if r.source == "table" then rejected[#rejected + 1] = r end
  end
  if #rejected > 0 then
    -- The whole plan comes back out, not just the row that failed. A claim that was wrong leaves
    -- its own pipes standing on cells the next fluid may well need -- a water row laid over the
    -- cell where crude actually enters cannot be left there while crude is discovered -- so the
    -- machine is discovered from scratch, with nothing of ours on the ground.
    for _, r in ipairs(rig.runs) do
      fluidrig.destroy(r)
      st.built[r.at .. "|" .. r.fluid] = nil
    end
    for _, r in ipairs(rejected) do
      rig.notes[#rig.notes + 1] = { fluid = r.fluid, at = r.at, claimed = r.face,
        why = "BOX_TABLE_STALE",
        msg = "boxes.lua puts " .. r.fluid .. " at " .. r.face .. " of entity " .. r.at
          .. ", and nothing was drawn from a row laid there; the whole machine is being discovered"
          .. " instead, and that entry wants correcting" }
    end
    rig.runs, st.found, st.queue = {}, {}, {}
    for _, ob in ipairs(st.all) do st.queue[#st.queue + 1] = { at = ob.at, fluid = ob.fluid } end
    j.state = "probing"
    return
  end
  if #stalled > 0 then
    -- every row here was laid on a cell the discovery itself named, and one of them draws nothing:
    -- no further guessing helps, so the job names the fluids it could not feed and stops
    for _, r in ipairs(stalled) do
      local machine = rig.machine_of[r.at]
      rig.problems[#rig.problems + 1] = { fluid = r.fluid, at = r.at, face = r.face,
        cells = r.cells, anchor = r.anchor, tank = r.tank_pos,
        pipes = #(r.pipes or {}), adopted = #(r.adopted or {}),
        filled = r.started, holds = fluidrig.held(r.tank, r.fluid),
        machine_boxes = machine and fluidrig.boxes(machine) or nil,
        why = "RUN_NOT_PROVEN",
        msg = r.fluid .. " was laid on the cell that took it during discovery and its tank still"
          .. " has given up nothing" }
    end
    open_window(j, rig)
    return
  end
  open_window(j, rig)
end

local function probe_tick(j, rig)
  local st = rig.probe
  if game.tick < st.until_tick then return end
  if #st.probes > 0 then
    local taken = fluidrig.poll_offers(st.probes)
    fluidrig.destroy_offers(st.probes)
    st.probes = {}
    if #taken > 0 then
      local t = taken[1]
      st.found[#st.found + 1] = { at = st.current.at, fluid = t.fluid, face = t.face, off = t.off }
      st.current, st.pass = nil, 0
    elseif st.pass == 0 then
      st.pass = 1
    else
      rig.problems[#rig.problems + 1] = { fluid = st.current.fluid, at = st.current.at,
        why = "BOX_NOT_FOUND",
        msg = st.current.fluid .. " was offered at every cell of every face and none of them took it" }
      st.current, st.pass = nil, 0
    end
  end
  if not st.current then
    st.current = st.queue[1]
    if st.current then table.remove(st.queue, 1) end
  end
  if st.current then
    probe_lay(j, rig)
    return
  end
  probe_build(j, rig)
  if #rig.problems > 0 or #rig.runs == 0 then open_window(j, rig) return end
  prove_start(j, rig)
end

-- An error thrown out of on_nth_tick is non-recoverable: Factorio tears the whole server down and
-- leaves game.speed raised. The lab walks arbitrary AI-authored cards, so it must never be able to
-- take the game with it.
-- A job that has lost its live handles -- after a save/load, or a rig whose chests were taken out
-- from under it -- has no verdict left to compute. What it does have is machines, belts, chests and
-- supply rigs still standing where it put them, and nothing else ever removes them: `lab_reset`
-- iterates the same handles that are gone, so it reported `cleared_entities: 0` about a bench full of
-- strangers. Take down what is reachable, count it, and name why the job ended.
local function abandon_lab(j, why)
  j.state = "abandoned"
  j.abandoned_because = why
  local gone = 0
  for _, e in ipairs(j.ents or {}) do
    if e and e.valid then pcall(function() e:destroy() end) gone = gone + 1 end
  end
  local rig = j.rig
  if type(rig) == "table" then
    for _, list in ipairs({ rig.probes, rig.runs, rig.drains, rig.gens, rig.in_chests, rig.out_chests }) do
      for _, e in ipairs(type(list) == "table" and list or {}) do
        if e and e.valid then pcall(function() e:destroy() end) end
      end
    end
  end
  j.destroyed = (j.destroyed or 0) + gone
  j.ents, j.rig = nil, nil
  if j.prev_speed then host.clock_lower(j.prev_speed) end
end

local function run_lab_tick()
  local j = storage.lab
  if not j or (j.state ~= "running" and j.state ~= "probing" and j.state ~= "proving") then
    return
  end

  local ents = j.ents
  if not ents then
    abandon_lab(j, "its live entity handles were gone on a later tick")
    return
  end

  if j.mode == "submitted" then
    local rig = j.rig
    if not rig then
      abandon_lab(j, "its live entity handles were gone on a later tick")
      return
    end
    if j.state == "proving" then
      prove_tick(j, rig)
      return
    end
    if j.state == "probing" then
      if game.tick > j.deadline then
        j.state = "supply_unproven"
        j.reason = "PROBE_TIMED_OUT"
        j.supply_problems = rig.problems
        j.box_notes = #rig.notes > 0 and rig.notes or nil
        if j.prev_speed then host.clock_lower(j.prev_speed) end
        return
      end
      probe_tick(j, rig)
      return
    end
    local alive = 0
    for _, f in ipairs(rig.feeds) do
      if f.chest.valid then
        alive = alive + 1
        local have = 0
        pcall(function() have = f.chest.get_item_count(f.item) end)
        if have < 200 then
          j.fed = j.fed + top_up(f.chest, FEED_INVENTORIES, f.item, 200 - have, j, "fed_blocked")
        end
      end
    end
    -- A supply tank is a reservoir, not a hose: it has to stay full or the machine runs out of
    -- fluid mid-window, and the tail of the measurement becomes a starvation curve rather than a
    -- rate. What it actually gave up is also the proof that the run sits on the box it was found
    -- at, which is the only evidence of that geometry the engine offers.
    for _, r in ipairs(rig.runs) do
      if r.tank and r.tank.valid then
        alive = alive + 1
        fluidrig.top_up(r)
      end
    end
    -- Products leave the machine's own boxes rather than a collector network: `remove_fluid` both
    -- proves the product exists and keeps the machine from blocking on a box that has nowhere to
    -- put it, which a collector on a guessed face does neither. The reading is named per fluid, so
    -- a card that claims petroleum gas and yields heavy oil says so in its own numbers.
    for _, m in ipairs(rig.machines or {}) do
      if m.entity and m.entity.valid then
        local got = fluidrig.drain(m.entity, fluidrig.product_names(m.entity))
        for name, units in pairs(got) do
          rig.drains[name] = (rig.drains[name] or 0) + units
          j.produced_by = j.produced_by or {}
          j.produced_by[name] = (j.produced_by[name] or 0) + units
        end
      end
    end
    if alive == 0 then
      abandon_lab(j, "its live entity handles were gone on a later tick")
      return
    end
    -- Burners starve quietly: an unfuelled furnace produces nothing and looks like
    -- a broken card, so fuel is kept topped for the whole window, not just seeded.
    -- Only refill when low, otherwise every tick reports a "blocked" insert and the
    -- counter turns into noise.
    if j.fuel then
      for _, e in ipairs(rig.fuel_targets or {}) do
        if e.valid then
          local have = 0
          pcall(function()
            local inv = e.get_inventory(defines.inventory.fuel)
            if inv then have = inv.get_item_count(j.fuel) end
          end)
          if have < 20 then
            j.fuelled = j.fuelled + top_up(e, { "fuel" }, j.fuel, 40 - have, j, "fuel_blocked")
          end
        end
      end
    end
    if game.tick >= j.deadline then
      local got = {}
      for _, c in ipairs(rig.collect) do
        if c.entity.valid then
          for item in pairs(j.contract) do
            pcall(function()
              local n = c.entity.get_item_count(item)
              if n and n > 0 then got[item] = (got[item] or 0) + n end
            end)
          end
        end
      end
      j.yields = got
      local total = 0
      for _, n in pairs(got) do total = total + n end
      j.produced = total
      -- what the boxes handed over, named per fluid: a card that promises petroleum gas and yields
      -- heavy oil says so in its own numbers rather than as a shortfall against the claim
      local fluids = {}
      for name, units in pairs(rig.drains) do fluids[name] = units end
      if next(fluids) then j.fluid_yields = fluids end
      -- which face and which cells each machine actually drew each fluid from, measured: the piece
      -- of geometry the runtime data will not give up, bought with the offers above
      local faces = {}
      for _, r in ipairs(rig.runs) do
        faces[#faces + 1] = { fluid = r.fluid, side = r.face, cells = r.cells, anchor = r.anchor,
          units = r.moved, tank = r.tank_pos,
          -- where the cell came from: a fact this file already carried, or one this job paid a
          -- discovery pass to read. A table entry that failed to move fluid never reaches here --
          -- it is taken back out and rediscovered, with a note saying so
          source = r.source or "probed" }
      end
      if #faces > 0 then j.supply_faces = faces end
      j.supply_problems = #rig.problems > 0 and rig.problems or nil
      local rev
      for k, v in pairs(defines.entity_status) do rev = rev or {} ; rev[v] = k end
      local st = {}
      for _, m in ipairs(rig.machines or {}) do
        if m.entity.valid then
          st[#st + 1] = { name = m.name, status = rev and rev[m.entity.status] or tostring(m.entity.status),
            recipe = (function()
              -- 2.0 has no `entity.recipe`; read through get_recipe or this field is always absent
              local ok2, r2 = pcall(function() return m.entity.get_recipe() end)
              return ok2 and r2 and r2.name or nil
            end)(),
            boxes = (function()
              local t = fluidrig.boxes(m.entity)
              return #t > 0 and t or nil
            end)() }
        end
      end
      if #st > 0 then j.machine_status = st end
      finalize_lab(j)
    end
    return
  end

  if j.mode == "card" then
    local rig = j.rig
    if not rig or not rig.in_chests[1] or not rig.in_chests[1].valid then
      abandon_lab(j, "its live entity handles were gone on a later tick")
      return
    end
    -- Keep each source chest topped to a modest level rather than flooding it,
    -- so a starved lane shows up as a real signal instead of being masked.
    for _, c in ipairs(rig.in_chests) do
      local have = 0
      pcall(function() have = c.get_item_count(j.ingredient) end)
      if have < 200 then
        j.fed = j.fed + top_up(c, { "chest" }, j.ingredient, 200 - have, j, "fed_blocked")
      end
    end
    for _, g in ipairs(rig.gens or {}) do
      if not g.valid then j.missing = j.missing + 1 end
    end
    if game.tick >= j.deadline then
      local got = 0
      for _, c in ipairs(rig.out_chests) do
        if c.valid then pcall(function() got = got + c.get_item_count(j.product) end) end
      end
      j.produced = got
      finalize_lab(j)
    end
    return
  end

  for _, e in ipairs(ents) do
    if not e.valid then
      j.missing = j.missing + 1
    else
      j.fed = j.fed + top_up(e, SOURCE_INVENTORIES, j.ingredient, 2, j, "fed_blocked")
      j.fuelled = j.fuelled + top_up(e, { "fuel" }, j.fuel, 4, j, "fuel_blocked")

      for _, name in ipairs(RESULT_INVENTORIES) do
        local id = defines.inventory[name]
        if id then
          pcall(function()
            local inv = e.get_inventory(id)
            if not inv then return end
            local n = inv.get_item_count(j.product)
            if n > 0 then
              inv.remove({ name = j.product, count = n })
              j.produced = j.produced + n
            end
          end)
        end
      end
    end
  end

  if game.tick >= j.deadline then finalize_lab(j) end
end

-- An error escaping on_nth_tick takes the server down, and an error swallowed by pcall looks
-- exactly like a measurement that never finished -- so each rig is driven through here, and the
-- reason it died is kept until the request that started it comes back to read it. Clearing the
-- record on the next healthy tick was what made a dead job indistinguishable from a runner that
-- had never fired.
local function drive_measurement(step, job_field, dead_field, error_field, reap)
  local ok, err = pcall(step)
  if ok then return end
  local job = storage[job_field]
  storage[dead_field] = { reason = "RUNNER_RAISED", job = job and job.key, msg = host.errtext(err),
                          tick = game.tick }
  storage[error_field] = host.errtext(err)
  if job then
    reap(job)
    host.clock_lower(job.prev_speed, job.prev_paused)
    storage[job_field] = nil
  end
end

script.on_nth_tick(1, function()
  drive_measurement(measure.step_drill_job, "drill_job", "drill_dead", "drill_error", measure.reap_rig)
  drive_measurement(measure.step_pump_job, "pump_job", "pump_dead", "pump_error", measure.reap_parts)
  local ok, err = pcall(run_lab_tick)
  if ok then return end
  local j = storage.lab
  if j then
    j.state = "error"
    j.tick_error = host.errtext(err, 240)
    -- not just an error string: the job's entities are in the world and this is the last moment
    -- their handles are all in one place
    local gone = 0
    for _, e in ipairs(j.ents or {}) do
      if e and e.valid then pcall(function() e:destroy() end) gone = gone + 1 end
    end
    j.destroyed = (j.destroyed or 0) + gone
    j.ents, j.rig = nil, nil
    if j.prev_speed then host.clock_lower(j.prev_speed) end
  end
end)

-- ============================================================
-- Transport envelope
-- ============================================================

local function encode(tbl)
  local ok, json = pcall(helpers.table_to_json, tbl)
  if ok then return json end
  return '{"ok":false,"code":"JSON_ENCODE_FAILED","msg":"field not json-serialisable"}'
end

-- ---------------------------------------------------------------- player surface ----
-- The rules answer over RCON; this is the part a player can open in the game. It renders and
-- dispatches and decides nothing, and the data it shows comes from the same pure function the
-- test suite asserts on -- so "what the panel would say" is verified even though the widgets
-- themselves cannot be, with no client connected.

-- The shape every RCON caller sees: the remote interface wraps a payload in {ok=,data=} and turns a
-- `fail` table into {ok=false, code=, msg=}. The panel calls these same functions DIRECTLY, so it has
-- to apply the same envelope itself -- handing the bare payload to a click handler that checks
-- `res.ok` makes every button look refused, and a self-test whose stand-in api hand-writes {ok=true}
-- passes while the real button does nothing.
local function envelope(res)
  if type(res) ~= "table" then return { ok = false, code = "BAD_RESULT", msg = tostring(res) } end
  if res.fail then return { ok = false, code = res.code, msg = res.msg, detail = res.detail } end
  return { ok = true, data = res }
end

-- The panel's whole view of the mod. It takes the player's index because two of the verbs are about
-- what THAT player selected and where THAT player is standing -- an api with no player in it could
-- only ever guess, and a guess reported as an answer is what the rest of this file exists to avoid.
-- The box a given player last dragged, as the panel shows it: surface, corners, and how many things
-- are in it. Nil when nobody has, which the panel renders as a refusal rather than an empty card.
local function scan_of(player_index)
  return player_index and storage.scan and storage.scan[player_index] or nil
end

local function gui_api(player_index)
  local held = function(name)
    local rec = storage.cards and storage.cards[name]
    return rec
  end
  local selected = function() return scan_of(player_index) end
  return {
    -- The box the player dragged with the selection tool, and the two clicks that act on it.
    selection = function() return selected() end,
    scan = function()
      local sel = selected()
      if not sel then return envelope(fail("NO_SELECTION", "nothing is boxed -- drag a rectangle with the selection tool")) end
      return envelope(M.region_scan({ surface = sel.surface, area = sel, force = "player" }))
    end,
    freeze_scan = function(name)
      local sel = selected()
      if not sel then return envelope(fail("NO_SELECTION", "nothing is boxed -- drag a rectangle with the selection tool")) end
      local scanned = M.region_scan({ surface = sel.surface, area = sel, force = "player" })
      if scanned.fail then return envelope(scanned) end
      local frozen = M.card_freeze({ card = scanned.card, name = name or scanned.card.name,
        allow_unmeasured = true })
      -- Both halves, because the useful sentence is "82 entities, and none of them were measured":
      -- freezing is not a measurement and the card has to arrive saying that.
      return { ok = frozen.ok, code = frozen.code, msg = frozen.msg, detail = frozen.detail,
        data = { frozen = frozen.data, entities = scanned.entities_kept,
          claim_how = scanned.claim_how, skipped = scanned.skipped, surface = scanned.surface } }
    end,
    -- The ask row: submit what the player typed, then show the queue, in one click. The surface comes
    -- from the player's feet rather than from the default, because an ask recorded "on nauvis" while
    -- whoever typed it stood on a platform answers a question nobody asked.
    request = function(text, card, surface) return envelope(M.request({ ask = text, card = card, surface = surface })) end,
    queue = function() return envelope(M.requests({ state = "all" })) end,
    -- The measuring trio: start a job on a frozen card, read where it has got to, and keep the numbers
    -- it came back with. Split into three clicks because the measurement takes real game time and a
    -- panel that pretended otherwise would be showing a number that has not happened yet.
    measure = function(name, seconds)
      local rec = held(name)
      if not rec then return envelope(fail("NO_SUCH_CARD", "nothing frozen under that name")) end
      -- `for_card` is the row the player pressed: the card object carries its own template name, and
      -- freezing the measurement back onto THAT would create a second card next to the one measured.
      return envelope(M.card_lab({ card = rec.card, seconds = seconds or 30, force = "player",
        for_card = name }))
    end,
    progress = function() return envelope(M.lab_status({})) end,
    -- Keeping the measurement re-freezes the card the job ran for. No name from the widget: the job
    -- knows which row started it, and taking the name from anywhere else could write the numbers onto
    -- a different card than the one that was measured.
    save_measurement = function()
      local st = M.lab_status({})
      if st.fail then return envelope(st) end
      return envelope(M.card_freeze({ name = st.card or st.for_card, force = "player" }))
    end,
    -- The form's answer. `M.plan_form` takes the widget indexes directly, so the panel never has to
    -- know which row means which prototype -- and a plan the solver refuses comes back refused, with
    -- the reason the solver gave rather than a summary of it.
    -- The plan, aimed at somewhere. The box the player drew is the best answer to "where would this
    -- stand"; failing that, the ground under their feet. Neither is a guess about a world nobody
    -- mentioned, which is what reading `nauvis` out of a default would have been: the surface is what
    -- turns "30 big-mining-drills" from an arithmetic answer into a claim about a planet, and Space Age
    -- refuses some of those claims by name (`host.surface_conditions`).
    plan = function(form)
      local args = form or {}
      if args.surface == nil then
        local sel = selected()
        local who = player_index and game.players[player_index]
        args.surface = (sel and sel.surface)
          or (who and who.valid and who.connected and who.surface.name) or nil
      end
      return envelope(M.plan_form(args))
    end,
    -- "does this fit the box I drew", and the same question answered by laying the ghosts. The lanes
    -- asked for are the plan's own count, so the panel never has to know how a machine count becomes
    -- lanes -- and the box is the player's, passed through as the corners the selection tool gave.
    fit = function(form, sel, build)
      local planned = M.plan_form(form or {})
      if planned.fail then return envelope(planned) end
      -- The lanes the plan wants is the machine count divided by what a lane holds -- one machine per
      -- lane here, so they are the same number. Stated rather than assumed because the box answers a
      -- question about the plan, and a `1` quietly substituted would make every fit verdict wrong by
      -- the size of the lane.
      local slots = planned.plan and planned.plan.unit and planned.plan.unit.machine_slots
      return envelope(M.plan_fit({
        item = planned.item, rate = planned.rate_shown, unit = planned.unit_shown,
        lanes = (type(slots) == "number" and slots) or 1,
        surface = sel and sel.surface, area = sel, build = build, force = "player",
        spacing = (form or {}).spacing, power = (form or {}).power,
      }))
    end,
    place = function(name) return envelope(M.card_place({ name = name, ghosts = true })) end,
    blueprint = function(name) return envelope(M.card_blueprint({ name = name })) end,
    -- The three verbs the panel gained. Each is the same call a designer makes over RCON; `why` is
    -- the one that is not a method of its own, because it is a composition of what a frozen card
    -- already carries (claim, measurement, window) with a fresh lint -- the answer to "why was this
    -- refused / how do you know", not a new capability.
    verify = function(name)
      local rec = held(name)
      if not rec then return envelope(fail("NO_SUCH_CARD", "nothing frozen under that name")) end
      return envelope(M.card_verify({ card = rec.card, require_single_network = true }))
    end,
    power = function(name)
      local rec = held(name)
      if not rec then return envelope(fail("NO_SUCH_CARD", "nothing frozen under that name")) end
      return envelope(M.card_fix_power({ card = rec.card }))
    end,
    why = function(name)
      local rec = held(name)
      if not rec then return envelope(fail("NO_SUCH_CARD", "nothing frozen under that name")) end
      local check = M.card_check({ card = rec.card })
      local ok = not (check or {}).fail
      return { ok = ok, code = (not ok and check.code) or nil, msg = (not ok and check.msg) or nil,
        data = { name = name, errors = ok and check.errors or nil, warnings = ok and check.warnings or nil,
          claimed = rec.claimed,
          record = { measured_this_card = rec.measured_this_card, measured = rec.measured,
            claimed = rec.claimed, window_seconds = rec.window_seconds,
            warmup_seconds = rec.warmup_seconds, source_job = rec.source_job } } }
    end,
  }
end

-- The model the window renders. Three call sites build it -- a click, the /arch command and
-- `gui_model` over RCON -- and they must not differ, or the panel a player sees and the panel a suite
-- asserts on are two different windows.
local function panel_model(player)
  local force = player and player.force or game.forces.player
  local m = gui.model(storage.cards, MOD_VERSION, player and scan_of(player.index) or nil)
  m.menus = panel_menus(force)
  return m
end

function M.gui_model(args)
  args = args or {}
  -- A player index is optional here but not on the panel: without one the box a player dragged
  -- simply is not there, which is what the headless caller has -- not what the player has.
  local player = args.player_index and game.get_player(args.player_index) or nil
  return panel_model(player)
end

-- The panel cannot be built for real on a headless server: 2.0 has no way to create a
-- player without a client. So run the real build code against a recording stand-in and hand
-- back the tree it produced -- which catches nil indexing, wrong argument shapes, miscounted
-- table rows and broken button dispatch, none of which the data model check can see.
-- What it CANNOT catch is the engine rejecting a widget spec; that is checked separately
-- against the installed runtime-api.json by dev/gui_api_check.js.
-- A stand-in for a LuaGuiElement: enough behaviour to run the real build code.
local function mock_element(parent, spec)
  local e = { type = spec.type, name = spec.name, caption = spec.caption, children = {}, parent = parent }
  e.add = function(s)
    s = s or {}
    if not s.type then error("mock: add{} requires a type") end
    local child = mock_element(e, s)
    e.children[#e.children + 1] = child
    return child
  end
  -- The engine removes a destroyed element from its parent, so a panel that has been closed is
  -- really gone from the tree. A stand-in that only set a flag let every later lookup succeed on a
  -- frame the player had already closed -- which is exactly the sequence `show_string` and
  -- `show_report` return false for, and the reason those paths were never reached here.
  e.destroy = function()
    e.destroyed = true
    local kids = parent and rawget(parent, "children")
    if kids then
      for i, c in ipairs(kids) do
        if c == e then table.remove(kids, i); break end
      end
    end
  end
  -- `G.show_report` empties the area before refilling it; without a stand-in for the call the whole
  -- path would pcall past a missing member and the report would accumulate lines instead
  e.clear = function() e.children = {} end
  -- a text field's whole job here is becoming selected so a hand can copy it; the stand-in has to
  -- answer that call or the path that does it is never exercised
  -- Form widgets answer with the fields the click handler reads: `selected_index` for a drop-down,
  -- `state` for a checkbox, `text` for a field. Without them `read_form` would see a nil index for
  -- every menu and the form would assert nothing while looking like it drove the panel.
  e.selected_index = spec.selected_index
  e.state = spec.state
  e.items = spec.items
  e.text = spec.text
  e.select_all = function() e.selected = true end
  e.select = function() e.selected = true end
  -- the engine resolves `parent[name]` to the child with that element name
  return setmetatable(e, { __index = function(tbl, key)
    local kids = rawget(tbl, "children")
    if kids then
      for _, c in ipairs(kids) do
        if rawget(c, "name") == key then return c end
      end
    end
    return nil
  end })
end

function M.gui_selftest(args)
  args = args or {}
  local screen = mock_element(nil, { type = "screen" })
  local calls = {}
  local player = {
    index = 1, name = "tester", valid = true,
    gui = { screen = screen },
    -- dot-called in gui.lua (`player.print(msg)`), so the stand-in must not model a self
    -- parameter: with one, every message below arrived as nil
    print = function(msg) calls[#calls + 1] = tostring(msg) end,
  }
  -- A box the player dragged, as the panel would receive it. Supplied rather than read from
  -- `storage.scan`, because the headless run has no player who has dragged anything -- and the row
  -- that renders it is the part under test.
  local selection = { surface = "nauvis", entities = 41, tick = 999,
    left_top = { x = 10, y = 20 }, right_bottom = { x = 30, y = 40 } }
  -- Built the way the panel builds it, menus and all: a form asserted against a model without the
  -- menus would be asserting an empty drop-down, which is a very confident way to prove nothing.
  local model = gui.model(args.cards or storage.cards, MOD_VERSION, selection)
  model.menus = panel_menus(game.forces.player)
  local opened = gui.open(player, model)
  -- A player always stands SOMEWHERE, and the ask records the surface under their feet. A stand-in
  -- without one made that path pass on its default branch -- the answer said "nauvis" and nothing
  -- could tell that apart from "the code never read the player at all".
  player.surface = { name = "nauvis-stand-in", index = 1 }
  -- the ask field starts empty, and an empty ask is a refusal -- so the queue is driven twice: once
  -- with what the player typed, once with the field left blank, which is the path that would silently
  -- "succeed" if the guard were missing
  do
    local row = screen[gui.ROOT] and screen[gui.ROOT]["arch-ask-row"]
    local field = row and row["arch-ask-in"]
    if field then field.text = "" end
  end

  local tree, rendered, buttons = {}, {}, {}
  -- A caption is usually a localized string by now, and `tostring` on one prints `table: 0x…`, which
  -- would make every caption assertion in the suite blind to the caption. Flattened instead to the key
  -- and its parameters, so the tree says `architect.boxed|41|nauvis|10,20 to 30,40` -- the key is the
  -- thing a headless run CAN check, and `dev/locale_check.js` is what ties that key to words.
  -- The panel owns the one flattening, because the panel owns the shape: key and parameters joined,
  -- nested lists folded, a concatenation list wrapped in delimiters. `dev/lines.js` reads that back.
  local caption_of = gui.flat
  local function walk(e, depth)
    tree[#tree + 1] = string.rep("  ", depth) .. tostring(e.type) ..
      (e.name and "[" .. e.name .. "]" or "") ..
      (e.caption and " '" .. caption_of(e.caption) .. "'" or "")
    -- collected on the way, so what gets clicked below is what the panel actually built rather
    -- than a list of names this function also writes by hand -- which is how a button that only
    -- exists for a real frozen card could be clicked in a test and never in the game
    if type(e.name) == "string" and e.name:sub(1, 5) == "arch-" then
      rendered[#rendered + 1] = e.name
      if e.type == "button" then buttons[#buttons + 1] = e.name end
    end
    for _, c in ipairs(e.children or {}) do walk(c, depth + 1) end
  end
  if screen[gui.ROOT] then walk(screen[gui.ROOT], 0) end

  -- drive every button the panel rendered, through the same handler a click uses, plus one that is
  -- not ours to make sure a foreign name is left alone
  local clicks = {}
  local answered = {}
  -- The stand-in api answers like the real one, shapes and all, because `G.report_lines` is the
  -- part a player reads and the part a mock could get wrong in silence: a field renamed on the
  -- method side would show up as an empty report here first.
  local api = {
    -- The box row, shaped like `M.region_scan` and `freeze_scan` answer, for the same reason the
    -- other stand-ins are: a renamed field on the method side has to show up here first.
    scan = function() clicks[#clicks + 1] = "read"
      return { ok = true, data = {
        entities_kept = 41, machines_bound = 12, surface = "nauvis",
        card = { name = "scanned 21x21", contract = { outputs = { ["iron-plate"] = 18.75 } } },
        claim_how = "nameplate: 12 machines read live, at their current recipe and speed -- NOT measured. card_lab on this card is what turns it into a number the game confirmed.",
        skipped = { { name = "transport-belt", count = 3, why = "this mod has no placeable role for it" } },
        next = "card_freeze {card = <this card>, allow_unmeasured = true} to keep it, then card_lab to measure it" } } end,
    freeze_scan = function() clicks[#clicks + 1] = "freeze"
      return { ok = true, data = {
        frozen = { name = "scanned 21x21", measured_this_card = false }, entities = 41,
        claim_how = "nameplate: 12 machines read live -- NOT measured",
        surface = "nauvis" } } end,
    -- The measuring trio, answering the way the rig does: a job still running says it is running, and
    -- only a finished one carries verdicts. A stand-in that always reported `done` would let the panel
    -- claim a measurement that had not happened -- the exact mistake the rig itself refuses to make.
    measure = function(n) clicks[#clicks + 1] = "measure:" .. n
      return { ok = true, data = { job = 7, state = "running", card_name = n, run_ticks = 1800,
        expected_per_min = 18.75, entities = 14, feeds = 2, collectors = 1 } } end,
    progress = function() clicks[#clicks + 1] = "status"
      return { ok = true, data = { job = 7, state = "done", card = "smoke-lane",
        elapsed_ticks = 1800, remaining_ticks = 0, measured_per_min = 18, expected_per_min = 18.75,
        verdicts = { { item = "iron-plate", claimed_per_min = 18.75, measured_per_min = 18,
          met = false, ratio = 0.96 } }, delivered = false, pay_fraction = 0.96 } } end,
    save_measurement = function() clicks[#clicks + 1] = "save"
      return { ok = false, code = "NOT_DELIVERED",
        msg = "the measurement says this card cannot pay its claim; fix the layout or the claim",
        detail = { verdicts = { { item = "iron-plate", measured_per_min = 18 } },
          pay_fraction = 0.96 } } end,
    -- The form's Plan button, answering in the shape `M.plan_form` returns -- module note included,
    -- which is the whole reason the form offers modules at all.
    plan = function(form) clicks[#clicks + 1] = "plan:" .. (function()
        local l = {}
        for k, v in pairs(form or {}) do l[#l + 1] = k .. "=" .. tostring(v) end
        table.sort(l) return table.concat(l, ",") end)()
      return { ok = true, data = {
        item = "iron-plate", rate_shown = 45, unit_shown = "per_second",
        sent = { want = { item = "iron-plate", rate_per_min = 2700 } },
        how_many = {
          { machine = "electric-furnace", count = 72, per_machine_per_min = 37.5, item = "iron-plate" },
          { machine = "big-mining-drill", count = 18, per_machine_per_min = 225, item = "iron-ore",
            estimated = true },
          -- A row whose recipe feeds itself, in the shape `solve` answers: the count and the rate are
          -- the net side of it, and the belt figure rides along in `recirculated` because a reader who
          -- is shown only one of the two cannot tell this machine from an ordinary one.
          { machine = "centrifuge", count = 993, per_machine_per_min = 1, item = "uranium-235",
            recipe = "kovarex-enrichment-process",
            recirculated = { item = "uranium-235", per_craft_in = 40, per_craft_out = 41,
              per_craft_net = 1, gross_per_machine_per_min = 41 } },
        },
        modules = { { machine = "electric-furnace", item = "speed-module", asked = 3, fitted = 2,
          note = "only 2 of 3 fit in electric-furnace's 2 slots" } },
        plan = { unit = { power = { machine_grid_kw = 1800, machine_fuel_kw = 0,
          emissions_per_sec = 0.4 } }, margin = 3.5, needs_measured_margin = true,
          prerequisites = {},
          in_flight = { { item = "oxide-asteroid-chunk", per_min = 1.6, per_craft = 1,
            recipe = "oxide-asteroid-crushing" } },
          cyclic = { { item = "uranium-235", throughput_per_min = 39720 } },
          -- What the window does with a surface it was told about. `solve` answers this shape on the
          -- save it runs on: drill frames that nauvis refuses to build, with the number the planet
          -- gave next to the number it wants.
          surface = { surface = "nauvis", checked = true, values = { pressure = 1000, gravity = 10 },
            machines_built_elsewhere = { { machine = "big-mining-drill", crafted_by = "big-mining-drill",
              property = "pressure", need_min = 4000, need_max = 4000, here = 1000 } } } },
      } } end,
    -- The Fit / Fit+ghosts buttons, in the shape `M.plan_fit` answers with.
    fit = function(form, sel, build) clicks[#clicks + 1] = "fit:" .. tostring(build)
      return { ok = true, data = {
        lane = { name = "smelter-lane-1", footprint = { width = 15, height = 8 }, spacing = "compact",
          gap = 0, per_lane_rate = 37.5 },
        box = { w = 40, h = 16, surface = "nauvis", left_top = { x = 10, y = 10 },
          right_bottom = { x = 50, y = 26 } },
        per_row = 2, rows = 2, lanes_fit = 4, lanes_wanted = 5, lanes_placed = 4,
        rate_placed = 150, rate_wanted = 300, shortfall_lanes = 1, fits = false,
        -- the fit answer carries the same report, because the ghosts are going into that ground
        surface = { surface = "nauvis", checked = true, values = { pressure = 1000 },
          machines_built_elsewhere = { { machine = "big-mining-drill", crafted_by = "big-mining-drill",
            property = "pressure", need_min = 4000, need_max = 4000, here = 1000 } } },
        built = build and { card = "planned line", lanes_used = 4, composed = 56,
          placed = { ghosts = 56, origin = { x = 10, y = 10 }, refused = {} } } or nil,
        next = build and "42 ghosts down at 10,10 -- measure them with card_lab"
          or "1 of 5 lanes fit. Wider box, smaller spacing, or accept 37.5/min less." } } end,
    place = function(n) clicks[#clicks + 1] = "place:" .. n; return { ok = true, data = { ghosts = 3, built = 0,
      refused = {}, origin = { x = 0, y = 0 }, surface = "mock", measured = { ["iron-plate"] = 18 },
      measured_this_card = true } } end,
    blueprint = function(n) clicks[#clicks + 1] = "string:" .. n; return { ok = true, data = { blueprint = "0eNq...",
      bytes = 7, name = n, measured = { ["iron-plate"] = 18 }, measured_this_card = true } } end,
    -- The stand-in answers `request` with the surface it was actually handed rather than a literal,
    -- so the assertion below cannot be satisfied by a panel that never reads the player's feet.
    request = function(t, c, s) clicks[#clicks + 1] = "ask:" .. tostring(t)
      if not t or t:gsub("%s", "") == "" then
        return { ok = false, code = "BAD_ARGS", msg = "ask = the question, in the words a player would use" }
      end
      return { ok = true, data = { request = { id = 1, ask = t, state = "open", asked_tick = 1234,
        surface = s or "<no surface read>" }, held = 1, open = 1, cap = 20,
        note = "an agent outside the game takes this with requests{}, works, and calls answer" } } end,
    queue = function() clicks[#clicks + 1] = "queue"
      return { ok = true, data = { requests = {
        { id = 1, ask = "can this line reach 500 gears/min?", state = "answered",
          answer = "planned: 3 assemblers; two more arms needed -- see why on the card" },
        { id = 2, ask = "why is the oil line short?", state = "open" } }, open = 1, held = 2 } } end,
    verify = function(n)
      clicks[#clicks + 1] = "verify:" .. n
      return { ok = true, data = { ok = true, placed = 14, networks = { { id = 1 } }, arms = { {}, {} },
        power = { covered = 3, powered_entities = 3, demand_kw = 117, in_card_supply_kw = 60 },
        errors = {}, warnings = { { code = "GRID_UNDER_PROVISIONED", msg = "card draws 117 kW, carries 60" } } } }
    end,
    why = function(n)
      clicks[#clicks + 1] = "why:" .. n
      return { ok = true, data = { name = n, errors = {}, warnings = { { code = "BELT_EXITS_CARD", msg = "belt #4 leaves the card" } },
        claimed = { ["iron-plate"] = 18.75 },
        record = { measured_this_card = true, measured = { ["iron-plate"] = 18 }, window_seconds = 60,
          warmup_seconds = 4, source_job = 7 } } }
    end,
    power = function(n)
      clicks[#clicks + 1] = "power:" .. n
      return { ok = false, code = "UNKNOWN_POLE", msg = "pole not-a-real-pole is not an entity on this install",
        detail = { pole = "not-a-real-pole", known = { "small-electric-pole" } } }
    end,
  }
  -- what the report area holds at one moment in time. Read more than once, because "the last verb
  -- wins" is only a fact if you know which verb was the last one when you looked.
  local function snap_report()
    local box = screen[gui.ROOT] and screen[gui.ROOT][gui.REPORT]
    if not box then return nil end
    local lines = {}
    for _, c in ipairs(box.children or {}) do
      lines[#lines + 1] = tostring(c.name or "") .. "=" .. caption_of(c.caption or "")
    end
    return { widgets = #lines, lines = lines }
  end

  -- One place that turns a pcall'd `on_click` into a line a suite can read. The three ways a click
  -- goes wrong -- it raised, it answered nothing, it refused -- have to look different in the output,
  -- and `ok and res.ok or "raised"` printed "raised" for a refusal that simply answered false, which
  -- is how a dead Ask button stayed invisible for a whole suite run.
  local function verdict(ok, ...)
    if not ok then return "RAISED " .. tostring((...)) end
    local verb, res = ...
    if verb == nil then return "NO-ANSWER" end
    if type(res) ~= "table" then return tostring(verb) end
    return tostring(res.ok) .. (res.code and (" " .. tostring(res.code)) or "")
      .. " verb=" .. tostring(verb)
  end

  -- Which answer is in the window after each per-card click, keyed by the button's own name. Tracked
  -- per verb rather than once at the end, because "the last verb wins" asserted on the last click only
  -- says the last click worked -- a verb that quietly stopped writing would be overwritten by the next
  -- one and never noticed.
  local report_after = {}

  for _, name in ipairs(rendered) do
    -- Close is not clicked with the rest: a real Close destroys the frame, and driving it in the
    -- middle would leave every check below answering for a window nobody has open. It goes last, on
    -- its own, where its effect can be measured.
    if name == "arch-close" or name == "arch-plan" then
      -- Close destroys the frame; Plan is only meaningful once the form holds something, so both are
      -- driven separately below where their state is known rather than wherever the walk reached.
      clicks[#clicks + 1] = name .. " -> deferred"
    else
      local ok, res = pcall(gui.on_click, player, name, model, api)
      if ok then answered[name] = res end
      -- Snapshotted for the verbs that answer INTO the window -- the five per-card ones (whose names
      -- carry a colon) and the two box ones -- because "the last click wins" asserted on the last
      -- click proves only that click: a verb that quietly stopped writing gets overwritten by the
      -- next one and passes unseen.
      if name:find("^arch%-%a+:") or name == "arch-read" or name == "arch-freeze"
        or name == "arch-plan" or name == "arch-fit" or name == "arch-build"
        or name == "arch-status" or name == "arch-save" then
        report_after[name] = snap_report()
      end
      clicks[#clicks + 1] = name .. " -> " .. (ok and tostring(res or "unhandled") or "ERROR " .. tostring(res))
    end
  end
  -- Fill the form the way a player does: AFTER the loop, whose Refresh click rebuilds the frame and
  -- with it every widget value. A preset applied before that loop looked correct and proved nothing --
  -- the click following it saw a freshly built form sitting back at its defaults.
  local preset = {}
  do
    local frow = screen[gui.ROOT] and screen[gui.ROOT]["arch-form-row"]
    local menus = model.menus or {}
    local function row_of(list, value)
      for i, e in ipairs(list or {}) do if e.value == value then return i end end
    end
    if not frow then
      preset.found = false
    else
      frow["arch-form-item"].selected_index = row_of(menus.items, "iron-plate")
      frow["arch-form-machine"].selected_index = row_of(menus.machines, "electric-furnace")
      frow["arch-form-module"].selected_index = row_of(menus.modules, "speed-module")
      frow["arch-form-unit"].selected_index = 1          -- "/second"
      frow["arch-form-rate"].text = "45"
      frow["arch-form-module-count"].text = "3"
      frow["arch-form-power"].state = true
      preset.item_index = frow["arch-form-item"].selected_index
      preset.machine_index = frow["arch-form-machine"].selected_index
      -- The same button twice: once with what the player left it at (the click loop was told to skip
      -- it, so this is the only place that path is exercised) and once filled. A form that only ever
      -- worked when filled would pass the interesting assertion and still be broken for the player who
      -- opens the panel and presses the first button they see.
      local ok_d, verb_d = pcall(gui.on_click, player, "arch-plan", model, api)
      clicks[#clicks + 1] = "plan-default -> " .. tostring(ok_d and verb_d or ("RAISED " .. tostring(verb_d)))
      -- Recorded by index rather than searched for afterwards: `clicks` is one flat log that other
      -- handlers append to while the click runs, so "the entry after the marker" is only true until
      -- somebody adds a verb that logs twice.
      local filled_at = #clicks + 1
      local ok, verb, res = pcall(gui.on_click, player, "arch-plan", model, api)
      preset.clicked = tostring(ok and verb)
      if not ok then preset.err = tostring(res) end
      report_after["arch-plan"] = snap_report()
      -- Fit and Build next, while the box the model carries is still the one under test.
      local ok_f, verb_f, res_f = pcall(gui.on_click, player, "arch-fit", model, api)
      preset.fit_clicked = tostring(ok_f and verb_f)
      report_after["arch-fit"] = snap_report()
      local ok_b, verb_b, res_b = pcall(gui.on_click, player, "arch-build", model, api)
      preset.build_clicked = tostring(ok_b and verb_b)
      report_after["arch-build"] = snap_report()
      if not ok_d then preset.err_default = tostring(verb_d) end
      -- What the filled form actually sent, from the line the stand-in appended for THIS click.
      preset.filled_line = clicks[filled_at]
    end
  end

  local report_ask
  -- the field left blank, then filled: Ask has to refuse the first and queue the second
  do
    local ok_e, verb_e, res_e = pcall(gui.on_click, player, "arch-ask", model, api)
    clicks[#clicks + 1] = "ask-empty -> " .. verdict(ok_e, verb_e, res_e)
    local row = screen[gui.ROOT] and screen[gui.ROOT]["arch-ask-row"]
    local field = row and row["arch-ask-in"]
    if field then field.text = "can this line reach 500 gears/min?" end
    local ok_a, verb_a, res_a = pcall(gui.on_click, player, "arch-ask", model, api)
    clicks[#clicks + 1] = "ask-filled -> " .. verdict(ok_a, verb_a, res_a)
    report_ask = snap_report()
    local ok_q, verb_q, res_q = pcall(gui.on_click, player, "arch-queue", model, api)
    clicks[#clicks + 1] = "queue -> " .. verdict(ok_q, verb_q, res_q)
  end
  -- a name that is not the panel's must fall through untouched, whatever else the loop does
  do
    local ok, res = pcall(gui.on_click, player, "not-ours", model, api)
    clicks[#clicks + 1] = "not-ours -> " .. (ok and tostring(res or "unhandled") or "ERROR " .. tostring(res))
  end

  -- ...and one click through the bridge the real buttons use, against a card that really is frozen.
  -- The stand-in api above can prove dispatch but never that a direct `M.*` call arrives in the
  -- shape the handler checks -- and that mismatch is exactly what made every String button report
  -- failure while the same method answered correctly over RCON.
  local bridge
  for name in pairs(storage.cards or {}) do
    if not bridge then
      local ok, res = pcall(function() return gui_api(1).blueprint(name) end)
      bridge = {
        card = name, handler_ran = ok,
        ok = ok and type(res) == "table" and res.ok or false,
        bytes = ok and type(res) == "table" and res.data and res.data.blueprint
          and #res.data.blueprint or nil,
        printed = calls[#calls],
      }
    end
  end
  -- ...and one verb through the REAL api, against a card that really is frozen. The stand-in above
  -- proves the dispatch and the formatting; only this proves the closure in `gui_api` reaches the
  -- method it claims to and gets a shape `report_lines` can read. `why` is the one that touches no
  -- world at all (a lint over stored data), so it is the one the selftest can afford to call.
  local why_real
  for name in pairs(storage.cards or {}) do
    if not why_real then
      local ok, res = pcall(function() return gui_api(1).why(name) end)
      why_real = { card = name, handler_ran = ok, ok = ok and type(res) == "table" and res.ok or false }
      if ok and type(res) == "table" and res.data then
        local lines = gui.report_lines("why", name, res)
        why_real.title = gui.flat(lines.title)
        why_real.lines = #lines.lines
        why_real.measured = res.data.record and res.data.record.measured_this_card
      end
    end
  end
  -- ...and a refusal through the SAME bridge, so that the shape a real `fail` arrives in is what the
  -- window renders. The stand-in api can hand-write any detail it likes, and the mock's refusal was
  -- written by the same hand that wrote the assertion over it -- which is worth nothing on its own.
  -- Two cases, because the two kinds of refusal read differently: one names what it meant.
  local api_real = gui_api(1)
  local function real_refusal(verb, card)
    local ok, res = pcall(function() return api_real[verb](card) end)
    if not ok or type(res) ~= "table" then return { handler_ran = false, err = tostring(res) } end
    local lines = gui.report_lines(verb, card, res)
    return { handler_ran = true, code = res.code, has_detail = res.detail ~= nil,
      answer = res.ok, render = gui.flat_lines(lines.lines), title = gui.flat(lines.title) }
  end
  local refuse_named = real_refusal("blueprint", "no card under this name")
  local refuse_bare = real_refusal("verify", "no card under this name")
  -- The box row clicked by someone who never dragged a box. Through the REAL api with no player, so
  -- this is the closure's own guard answering, not a stand-in made to refuse: the panel shows a Read
  -- and a Freeze button whether or not anything is selected, and the answer has to say what to do.
  local no_box = {}
  do
    local api_nobody = gui_api(nil)
    local res = api_nobody.scan()
    local lines = gui.report_lines("scan", "nothing boxed", res)
    no_box = { code = res.code, render = gui.flat_lines(lines.lines) }
    local frez = api_nobody.freeze_scan()
    no_box.freeze_code = frez.code
  end
  -- A refusal handed in by the caller, rendered by the panel's own formatter. This exists so a suite
  -- can assert the window's answer against a detail it MEASURED from a live method rather than one it
  -- typed out by hand -- a hand-written fixture proves the renderer matches the author's belief, which
  -- is a much weaker thing.
  local refuse_live
  if type(args.render_refusal) == "table" then
    local lines = gui.report_lines(args.render_refusal.cmd or "place",
      args.render_refusal.name or "rendered",
      { ok = false, code = args.render_refusal.code, msg = args.render_refusal.msg,
        detail = args.render_refusal.detail })
    refuse_live = { code = args.render_refusal.code, render = gui.flat_lines(lines.lines), title = gui.flat(lines.title) }
  end
  -- One more shape, taken from the source rather than invented: `find_card_site` hands NO_CLEAR_SITE a
  -- bare list of the origins it tried, and a detail that is a list has no key for the loop above to
  -- find it under. Rendered here because the real method would have to fail to find a site, which on
  -- this world it does not.
  local refuse_list = gui.report_lines("place", "smoke-lane", {
    ok = false, code = "NO_CLEAR_SITE", msg = "no candidate site fits this card; pass an explicit origin",
    detail = { { x = 0, y = 64, blockers = { "pipe" } }, { x = 4, y = 64, blockers = { "boiler" } } },
  })
  -- The lane/item mismatch `plan_fit` refuses with. Its useful half is a bag of rates plus a sentence
  -- pointing at the method that CAN do the job, and neither is a list the keyed lookup above reaches.
  local refuse_lane = gui.report_lines("fit", "iron-gear-wheel", {
    ok = false, code = "LANE_NOT_FOR_ITEM",
    msg = "the lane this fits into a box makes iron-plate at 37.5/min, not iron-gear-wheel",
    detail = { asked_for = "iron-gear-wheel", lane_makes = { ["iron-plate"] = 37.5 },
      use_instead = "plan_form gives the machine counts; card_place lay any card" },
  })
  -- what the copy path actually left behind: the field has to hold the string and be selected, or a
  -- player has nothing to press Ctrl+C on
  local string_field
  local row = screen[gui.ROOT] and screen[gui.ROOT]["arch-string-row"]
  local field = row and row["arch-string-out"]
  if field then
    string_field = { text = tostring(field.text or ""), selected = field.selected and true or false }
  end
  -- the report as it stands now: the last thing clicked was Queue, so this is the answer to that
  local report = snap_report()
  -- Every button the panel built has to be dispatched by the handler. This is the gate the colon
  -- required by the per-card naming pattern defeated: "arch-ask" has no colon, so on_click returned
  -- nil for it, and a player clicking Ask got nothing at all while the suite still reported green.
  local unhandled = {}
  for _, b in ipairs(buttons) do
    -- Close and Plan are clicked below, not here, where the state they need is set up on purpose; the
    -- `answered` entries they leave there mean neither can slip through unhandled by accident.
    if b ~= "arch-close" and b ~= "arch-plan" and not answered[b] then unhandled[#unhandled + 1] = b end
  end
  -- ...and Close, driven last, has to really take the window away
  local closed
  do
    local ok, res = pcall(gui.on_click, player, "arch-close", model, api)
    closed = { ok = ok, frame_gone = screen[gui.ROOT] == nil }
    -- written with an `if`, because `ok and nil or tostring(res)` -- which is what this line was --
    -- always takes the right-hand branch, so a successful close reported an error string. The lint
    -- gate has a name for exactly that shape and said so before any of this ran.
    if ok then closed.verb = res else closed.err = tostring(res) end
    clicks[#clicks + 1] = "arch-close -> " .. verdict(ok, res)
  end
  return { built = opened ~= nil, tree = tree, widgets = #tree, clicks = clicks,
           buttons = #buttons, unhandled = unhandled, report_after = report_after,
           printed = calls, bridge = bridge, why_real = why_real,
           refuse_named = refuse_named, refuse_bare = refuse_bare, refuse_live = refuse_live,
           no_box = no_box,
           refuse_list = { title = gui.flat(refuse_list.title), render = gui.flat_lines(refuse_list.lines) },
           refuse_lane = { title = gui.flat(refuse_lane.title), render = gui.flat_lines(refuse_lane.lines) },
           string_field = string_field, report = report,
           report_ask = report_ask, close = closed, preset = preset,
           form_items = (function()
             local l = {}
             for _, e in ipairs(model.menus and model.menus.items or {}) do l[#l + 1] = e.value end
             return l
           end)(),
           form_machines = (function()
             local l = {}
             for _, e in ipairs(model.menus and model.menus.machines or {}) do l[#l + 1] = e.value end
             return l
           end)(),
           form_modules = (function()
             local l = {}
             for _, e in ipairs(model.menus and model.menus.modules or {}) do l[#l + 1] = e.value end
             return l
           end)() }
end

script.on_event(defines.events.on_gui_click, function(event)
  local player = game.get_player(event.player_index)
  if not player then return end
  local element = event.element
  if not element then return end
  local name = field(element, "name")
  if type(name) ~= "string" or name:sub(1, 5) ~= "arch-" then return end
  pcall(function()
    gui.on_click(player, name, panel_model(player), gui_api(player.index))
  end)
end)

-- The player drags a box with the vanilla selection tool. Nothing is read and nothing is frozen here
-- -- the box is remembered, and the panel says what it holds before anyone commits to it. Reading is
-- a click because a scan costs entities walked and a player who mistyped a drag should get to look
-- first.
script.on_event(defines.events.on_player_selected_area, function(event)
  local player = game.get_player(event.player_index)
  if not player then return end
  local area = event.area
  if type(area) ~= "table" then return end
  storage = storage or {}
  storage.scan = storage.scan or {}
  local lt, rb = area.left_top or area[1], area.right_bottom or area[2]
  if not lt or not rb then return end
  storage.scan[event.player_index] = {
    surface = field(event.surface, "name") or field(player.surface, "name"),
    left_top = { x = lt.x or lt[1], y = lt.y or lt[2] },
    right_bottom = { x = rb.x or rb[1], y = rb.y or rb[2] },
    tick = game.tick,
    entities = event.entities and #event.entities or nil,
  }
  pcall(function()
    player.print(string.format("architect: %s entities in the box on %s (%s,%s to %s,%s) -- read it from /arch",
      tostring(event.entities and #event.entities or "?"), tostring(storage.scan[event.player_index].surface),
      tostring(lt.x or lt[1]), tostring(lt.y or lt[2]), tostring(rb.x or rb[1]), tostring(rb.y or rb[2])))
  end)
end)

script.on_event(defines.events.on_player_left_game, function(event)
  local player = game.get_player(event.player_index)
  if player then pcall(function() gui.close(player) end) end
end)

-- 2.0's `commands.add_command(name, localised_name, handler)`: three positional arguments, name
-- first. The 1.1-shaped call `add_command(fn, {"" ,"..."}, "arch")` raises on every init and load
-- ("bad argument #1 of 4 to 'add_command' (string expected, got function)"), and because the raise
-- happens inside the `on_init`/`on_load` handler the command simply never existed -- invisible to
-- every headless test, since only a player typing `/arch` can notice a command that is not there.
local function register_commands()
  pcall(function()
    commands.remove_command("arch")
  end)
  -- Recorded rather than logged: a load-time step that fails leaves no trace anywhere a headless
  -- caller can look, and "the panel is not in my command list" is a fact the rig should report.
  local ok, err = pcall(commands.add_command, "arch",
    { "", "Architect: open or close the design panel; /arch bench prints what the save knows" }, function(context)
    local player = context.player_index and game.get_player(context.player_index) or nil
    if not player then
      game.print("architect: /arch needs a player in the game to show a window")
      return
    end
    -- `/arch bench`: the same facts a headless caller gets from `bench_state`, printed for whoever
    -- typed it. It exists because the bug it reports on is only visible from two machines at once --
    -- a client and a server holding the same save can now disagree in one line each, which is a far
    -- better report than a desync summary. Local `print`, so each side answers for itself.
    local args = tostring(context.parameters or ""):gsub("^%s+", ""):lower()
    if args:sub(1, 4) == "bench" or args:sub(1, 5) == "state" then
      local b = M.bench_state({})
      -- A chat command runs in every process, so the same text arrives from the server and from this
      -- client, and two answers that disagree are only useful if you know which machine said which.
      -- The `rcon` module exists where a console can be reached, which is the server and not a client.
      local ok_rcon = pcall(function() if rcon == nil then error("no console here") end end)
      local lines = { "architect bench (" .. (ok_rcon and "server" or "client") .. ") @ tick " .. tostring(b.tick) }
      local j = b.lab_job
      lines[#lines + 1] = j and string.format("  job %s: %s, carrying %d entities%s%s",
        tostring(j.id), tostring(j.state), tonumber(j.entities_carried) or 0,
        j.rig_carried and " + rig" or "",
        j.abandoned_because and (" -- " .. tostring(j.abandoned_because)) or "")
        or "  no lab job in the save"
      local names = {}
      for name in pairs(b.surfaces or {}) do names[#names + 1] = name end
      -- Sorted, because the whole point of the line is to be read against the same line from another
      -- machine: two answers whose rows arrive in different orders cannot be compared by eye.
      table.sort(names)
      for _, name in ipairs(names) do
        local s = b.surfaces[name]
        lines[#lines + 1] = string.format("  %s: exists=%s primed=%s pad=%s",
          tostring(name), tostring(s.exists), tostring(s.primed),
          s.pad_entities == nil and "?" or tostring(s.pad_entities))
      end
      lines[#lines + 1] = "  ore rigs: drill=" .. tostring(b.drill_job == true)
        .. " pump=" .. tostring(b.pump_job == true)
      for _, l in ipairs(lines) do player.print(l) end
      return
    end
    local state = gui.toggle(player, panel_model(player))
    if state == "failed" then game.print("architect: could not build the window") end
  end)
  -- `err` holds the message only when the call raised; re-declaring it here (which is what this
  -- line used to be) shadowed the pcall result, so the one fact this record exists to keep -- why
  -- `/arch` was rejected -- came out as the string "nil" on every failure.
  if not ok then err = tostring(err):gsub("[\r\n]+", " "):sub(1, 200) end
  -- No `game` and no `storage` here: both are unavailable or forbidden during `on_load`, which is
  -- what makes a load-time failure invisible unless the step reports itself.
  boot.command_reg_count = (boot.command_reg_count or 0) + 1
  boot.command_reg = {
    ok = ok,
    registrations = boot.command_reg_count,
    err = err,
  }
end

-- Each of `script.on_init` / `on_load` / `on_configuration_changed` holds ONE handler: registering a
-- second replaces the first without a word of complaint. The cache-clearing hooks that used to sit at
-- the bottom of this file quietly replaced the command registration, so `/arch` never existed on any
-- save -- and nothing a headless test does could notice a chat command nobody typed. Every bootstrap
-- job therefore lives in this one handler.
-- Anything computed from prototypes has to be thrown away when the mod set changes, and
-- `reach_cache`/`probe_cache` are exactly that: an inserter's reach and a pole's wire distance are
-- measured once per name and kept for the process. `verify`'s probe cache lives in that module and
-- clears itself through the exported function below.
local function bootstrap()
  model_cache, db_cache, supply_cache = nil, nil, nil
  reach_cache = {}
  -- Nothing in `storage` may be created or edited here: the engine compares the CRC of `storage`
  -- across `on_load` and calls a change "not save/load stable and not multiplayer safe". The lab's
  -- handles ride in the job record for exactly that reason.
  pcall(function() verify.clear_probe_cache() end)
  register_commands()
end

script.on_init(bootstrap)
script.on_load(bootstrap)
script.on_configuration_changed(bootstrap)

remote.add_interface("arch", {
  version = function() return MOD_VERSION end,
  -- Returns a JSON string; rcon.print on the outside is the only egress.
  call = function(method, args)
    local fn = M[method]
    if not fn then
      local known = {}
      for k in pairs(M) do known[#known + 1] = k end
      table.sort(known)
      return encode({ ok = false, code = "UNKNOWN_METHOD", msg = tostring(method), known = known })
    end
    local t0 = game.tick
    local ok, res = pcall(fn, args or {})
    if not ok then
      return encode({ ok = false, code = "RUNTIME_ERROR", msg = tostring(res) })
    end
    if type(res) == "table" and res.fail then
      return encode({ ok = false, code = res.code, msg = res.msg, detail = res.detail })
    end
    return encode({ ok = true, method = method, data = res, cost_ticks = game.tick - t0 })
  end,
  invalidate = function() model_cache = nil db_cache = nil supply_cache = nil return true end,
})
