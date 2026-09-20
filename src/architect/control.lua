local MOD_VERSION = "0.34.0"

local rat = require("rat")
local solve = require("solve")
local card = require("card")
local verify = require("verify")
local compose = require("compose")
local region = require("region")
local powers = require("power")
local gui = require("gui")
local host = require("host")
local measure = require("measure")

-- The shared primitives keep their old local names: every call site in this file reads them, and
-- `host.field(...)` everywhere would bury the data those calls are about.
local field = host.field
local fail = host.fail
local kw_of = host.kw_of
local resolve_surface = host.resolve_surface
local tank_capacity = host.tank_capacity
local fluid_in_tank = host.fluid_in_tank

local M = {}

local lane_units              -- defined below; card_example needs it from above
local availability_checker    -- defined below; card_example needs it from above
local inserter_reach          -- defined below; card_example needs it from above
local bus_line                -- defined below; bus_example needs it from above
local lane_of                 -- ditto: the capacity a belt row declares

-- Live entity handles for in-flight lab jobs. Declared here because both the card
-- methods above and the runner below touch them; a second `local` further down
-- would silently turn the earlier uses into global indexing.
local lab_ents = {}
local lab_rigs = {}

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
    if speed and (kind == "assembling-machine" or kind == "furnace" or kind == "rocket-silo"
      or kind == "centrifuge" or kind == "chemical-plant" or kind == "oil-refinery"
      or kind == "boiler" or kind == "lab" or kind == "reactor" or kind == "burner-generator") then
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
        category = field(p, "mining_category") or field(p, "resource_categories"),
        hidden = field(p, "hidden") or false,
      }
    elseif kind == "transport-belt" then
      local bs = field(p, "speed") or field(p, "belt_speed")
      if bs then
        belts[name] = { speed = bs, throughput_per_sec = bs * 8 * 60, next = field(p, "next_speed"),
                      place_item = place_item_of(p) }
      end
    elseif kind == "inserter" then
      local ieu, iog, iem = energy_of(p)
      inserters[name] = {
        rotation = getter(p, "get_inserter_rotation_speed"),
        extension = getter(p, "get_inserter_extension_speed"),
        stack_size = field(p, "inserter_stack_size_override"),
        length = field(p, "inserter_length"),
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
-- Guardrails like this belong in one table: a score-based ranking picked
-- "artillery-turret-recycling" as the way to make processing units and looked valid.
local NON_ROUTE_CATEGORIES = { recycling = true }

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
        enabled = (function()
          local fr = game.forces.player.recipes[name]
          return fr and fr.enabled or false
        end)(),
      }
      recipes[name] = recipe
      -- Recycling turns trash into a by-product stream; treating it as a production
      -- route lets the planner "make" a processing unit by shredding artillery turrets.
      if not NON_ROUTE_CATEGORIES[field(r, "category")] then
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
      }
    end
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
          limit = field(p, "module_spec") and field(field(p, "module_spec"), "limitation_count") or nil,
        }
      end
    end
  end

  for name, v in pairs(model().inserters) do
    machines[name] = { name = name, kind = "inserter", rotation = v.rotation, extension = v.extension,
                       stack_size = v.stack_size, place_item = v.place_item }
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
  -- only while nothing was measured for that machine and ore. Drills and pumps write the same
  -- "machine|ore" key, so the two caches merge into one lookup table.
  local measured = {}
  for _, cache in ipairs({ storage and storage.drills or {}, storage and storage.pumps or {} }) do
    for key, record in pairs(cache) do measured[key] = record end
  end
  args.measured = measured
  local plan, err, detail, extra = solve.plan(db, args)
  if not plan then
    return fail(err or "SOLVE_FAILED", tostring(detail), extra)
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
  c.not_modelled = {
    "fluids: recipes and resources use them, but a card has no fluid port, pipe, or tank",
    "fluid temperature: heat-exchange and refinery outputs differ only by temperature, which is not carried",
    "heat energy sources (reactor -> heat -> steam): power reads electric sources only",
    "spoilage: an item that decays on a bus is still counted as conserved",
    "space platforms: the hub is a mobile grid with autonomous forging; placement assumes a static surface",
    "item quality: getters are called at default quality, so quality-gated recipes and modules are seen at normal",
    "infinite/depleting ore patches: resource_drain_rate_percent means a drill's measured rate is a property of the patch",
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
          probability = p.probability, catalyst = p.catalyst_amount,
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

-- Best-first component lists for the example card. Deriving the parts from what
-- the force has actually unlocked keeps the fixture legal in any save state;
-- hardcoding "inserter" made it fail lint on a fresh Nauvis start.
local CARD_PART_PICKS = {
  inserter = { "stack-inserter", "long-handed-inserter", "filter-inserter", "inserter", "burner-inserter" },
  belt     = { "express-transport-belt", "fast-transport-belt", "transport-belt" },
  chest    = { "steel-chest", "chest", "wooden-chest" },
  furnace  = { "electric-furnace", "stone-furnace" },
}

-- A known-good card, expressed the way an author would express it, so the linter
-- itself can be tested from both sides.
function M.card_example(args)
  args = args or {}
  local db = world_db()
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
  if not refresh_availability(db, force.name) then return fail("NO_FORCE", force.name) end
  local is_available = availability_checker(db, force)

  local function pick(kind, wanted)
    if wanted then return wanted end
    local list = CARD_PART_PICKS[kind]
    for _, n in ipairs(list) do if is_available(n) then return n end end
    return list[#list]
  end

  local furnace = pick("furnace", args.furnace)
  local ins = pick("inserter", args.inserter)
  local belt = pick("belt", args.belt)
  local chest = pick("chest", args.chest)

  local fp = prototypes.entity[furnace]
  local fw, fh = (fp and fp.tile_width) or 2, (fp and fp.tile_height) or 2
  local reach = inserter_reach(game.surfaces[1], ins, force.name)
  local specs = lane_units(0, 0, 1, furnace, belt, ins, chest, fw, fh, nil, reach, args.outlets)
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
  return { name = "smelter-lane-1", components = { furnace = furnace, inserter = ins, belt = belt, chest = chest },
           arm_reach = reach, roles = roles, anchors = anchors,
           entities = ents, ports = ports,
           contract = { outputs = { ["iron-plate"] = 60 * speed / energy } } }
end

-- A bus on its own produces nothing, so it carries no contract: it exists to move an
-- item from one anchor to several. Its in port fuses onto a producer's out chest and
-- each tap chest fuses onto a consumer's in chest, which is what lets one furnace line
-- feed several cells without the cells fighting over the same machine.
function M.bus_example(args)
  args = args or {}
  local item = args.item or "iron-plate"
  local belt = args.belt or "fast-transport-belt"
  local ins = args.inserter or "long-handed-inserter"
  local chest = args.chest or "steel-chest"
  local taps = args.taps or 2
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
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
  local tier = args.belt or "fast-transport-belt"
  local ins = args.inserter or "long-handed-inserter"
  local chest = args.chest or "steel-chest"
  local taps = args.taps or 2
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
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
    if m and m.available ~= nil then
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
  if not args.slots or #args.slots == 0 then
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
local function card_fits(surface, normalized, origin, force_name)
  local blockers = {}
  for i, e in ipairs(normalized.entities) do
    local ok, can = pcall(function()
      return surface.can_place_entity {
        name = e.name, force = force_name, direction = e.direction,
        position = { x = e.position.x + origin.x, y = e.position.y + origin.y },
      }
    end)
    if not ok or not can then
      blockers[#blockers + 1] = { at = i, name = e.name }
      if #blockers >= 4 then break end
    end
  end
  return #blockers == 0, blockers
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
    local fits, blockers = card_fits(surface, normalized, s, force_name)
    if fits then return s, nil end
    if #rejected < 4 then rejected[#rejected + 1] = { x = s.x, y = s.y, blockers = blockers } end
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
local sandbox_primed = false

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

local function lab_surface()
  local s = game.surfaces[SANDBOX_SURFACE]
  if not s then
    local ok, created = pcall(function() return game.create_surface(SANDBOX_SURFACE) end)
    if not ok or not created then return nil, nil, "CREATE_FAILED" end
    -- chunk generation is asynchronous: requesting here and placing in the same tick
    -- reads "out-of-map" everywhere, and can_place_entity answers false for terrain
    -- that will exist a few ticks later. Report the wait instead of blaming the card.
    pcall(function() created.request_to_generate_chunks({ 0, 0 }, 9) end)
    storage.sandbox_ready = game.tick + SANDBOX_SETTLE_TICKS
    return nil, nil, "GENERATING"
  end
  if not storage.sandbox_ready then
    pcall(function() s.request_to_generate_chunks({ 0, 0 }, 9) end)
    storage.sandbox_ready = game.tick + SANDBOX_SETTLE_TICKS
    return nil, nil, "GENERATING"
  end
  if game.tick < storage.sandbox_ready then return nil, nil, "GENERATING" end
  prime_sandbox(s, not sandbox_primed)
  sandbox_primed = true
  return s, SANDBOX_PAD, nil
end

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

-- The callback plan_power asks when it wants the grid sized, not merely covered. It gets the
-- wired demand and a count of what the grid already carries, and answers with units to add;
-- the placement and the engine's verdict on each one stay in verify.lua.
-- Which supply units this force may actually build. A sized grid that names an entity the
-- player cannot craft fails its own lint one step later, which makes the fix unactionable --
-- so availability decides the menu before any arithmetic does. The list is a preference,
-- not an assumption: every entry is checked for a real power figure and for being buildable.
local SUPPLY_PREFERENCE = { "solar-panel", "accumulator", "boiler", "steam-engine", "nuclear-reactor" }

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
  for _, name in ipairs(SUPPLY_PREFERENCE) do
    local f = usable(name)
    if f then
      -- An accumulator's get_max_energy_production is its DISCHARGE limit (300 kW), not a
      -- source of energy, so "has a buffer" has to be asked first: classifying by kW alone
      -- filed the accumulator as a generator, left the storage list empty, and the
      -- day-only fallback then handed back the accumulator as the power station.
      if (f.buffer_kj or 0) > 0 then stores[#stores + 1] = f
      elseif f.kw_each > 0 then gens[#gens + 1] = f end
    end
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

  local entries = {}
  for i, spec in ipairs(args.entries or {}) do
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

  local layout, code = region.layout(entries, { compose = compose })
  if not layout then return fail(code or "LAYOUT_FAILED", "could not lay these cards out") end

  local merged = card.normalize(layout.card)
  -- Two different surfaces answer two different questions, and conflating them once produced a
  -- power plan that covered 12 of 12 machines and then, applied, covered 6 of 12.
  --   `surface` / `site`  -- where this region fits ON THE GROUND, obstacles included.
  --   `plan_surface`       -- the deterministic sandbox the grid is planned and verified on,
  --                          so a plan reproduces and card_verify agrees with it.
  local surface = args.surface and resolve_surface(args.surface) or game.surfaces[1]
  local site, rejected
  if surface then
    site, rejected = find_card_site(surface, merged, args.force or "player", args.origin, nil)
  end
  local plan_surface, plan_site_limit = surface, nil
  if args.power then
    local pad, why
    plan_surface, pad, why = lab_surface()
    if not plan_surface then
      if why == "GENERATING" then return fail("SANDBOX_GENERATING", "planning surface still generating; call again") end
      plan_surface, pad = game.surfaces[1], nil
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
    -- Pole tiers are tried in order of reach, and the reach is the MEASURED figure, so
    -- escalating is a rule deciding with data rather than a user guessing which pole fits.
    -- A dense region that two small poles cannot bridge is often one medium pole away from
    -- being one grid, and the plan cannot say "done" until it is.
    local can_build = availability_checker(db, force)
    local tiers = {}
    if args.pole then tiers[#tiers + 1] = args.pole end
    for _, name in ipairs({ "small-electric-pole", "medium-electric-pole", "big-electric-pole", "substation" }) do
      if name ~= args.pole and can_build(name) ~= false then tiers[#tiers + 1] = name end
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
    plan.pole = pole_used
    plan.poles_tried = attempts
    if plan.unmerged and #plan.unmerged > 0 then
      -- Two grids one tile apart with nowhere to stand is a real answer, not a failure to
      -- try hard enough -- but it is only useful with the remedy attached. Longer reach is
      -- the way out, so name the next tier AND the research that makes it buildable.
      local POLE_LADDER = { ["small-electric-pole"] = "medium-electric-pole",
        ["medium-electric-pole"] = "big-electric-pole", ["big-electric-pole"] = "substation" }
      local nxt = POLE_LADDER[pole_used]
      local tech = nil
      if nxt then
        local r = db.recipes and db.recipes[nxt]
        tech = r and r.techs and r.techs[1] or nil
      end
      local note
      if not nxt then
        note = "no larger pole tier exists; split the region or move these cards closer"
      else
        note = "a longer-reach pole bridges a gap the " .. pole_used .. " cannot: " .. nxt
        if tech then note = note .. " (locked behind research " .. tech .. ")" end
      end
      plan.unmerged_fix = {
        pole = nxt, technology = tech,
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
function M.card_lab(args)
  args = args or {}
  if storage.lab and storage.lab.state == "running" then
    return fail("LAB_BUSY", "job " .. tostring(storage.lab.id) .. " still running; call lab_stop")
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

  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
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
          for _, side in ipairs({ { (w + 3) / 2, 0 }, { -(w + 3) / 2, 0 },
                                  { 0, (h + 3) / 2 }, { 0, -(h + 3) / 2 } }) do
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

  local origin, rejected = find_card_site(surface, site_card, force_name, args.origin)
  if not origin then
    return fail("NO_CLEAR_SITE", "no candidate site fits this card; pass an explicit origin", rejected)
  end

  pcall(function() surface.create_global_electric_network() end)
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
  -- that never ran and a machine whose product left by a face the collector cannot see produce the
  -- same zero, and only the status tells them apart.
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

  -- A fluid port cannot be served by a chest: a machine takes and gives fluid through a box, and
  -- the only route script has into a box it cannot index is a full tank touching the machine --
  -- that is what made uranium minable at all. Collection is the same geometry the other way: an
  -- empty tank beside the port, read every tick. Nothing is drained here, because a 2.0 entity has
  -- no extract_fluid, so a collector that fills up is reported as a ceiling instead of reading
  -- short and looking like a slow card.
  -- One tank per face that fits. Two facts from the rigs decide the shape: the face a fluid box
  -- sits on cannot be read from runtime data -- `fluid_boxes` is not exposed,
  -- `fluidbox_prototypes` gives only in/out -- so guessing one face reads as a machine that will
  -- not run; and a full tank touching a machine does move fluid into it, which is what made the
  -- water side of a refinery drain 100 units while the crude on the wrong face moved nothing.
  -- Separate faces are separate networks (the machine sits between them), so two input fluids
  -- cannot mix, and the tank that drains names the face the box was on.
  --
  -- A pipe between the tank and the machine was tried first and is NOT what makes fluid move: with
  -- a pipe on every face, nothing drained at all. Whatever the refinery still does not accept needs
  -- a different answer than more plumbing.
  local function tanks_on_faces(entity, fluid)
    local p = prototypes.entity[entity.name]
    local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
    local e = entity.position
    local out = {}
    -- (w+3)/2 is the centre-to-centre distance at which a 3x3 tank sits flush against the
    -- machine's own border: half the machine plus half the tank, sharing no cell
    for _, side in ipairs({
      { name = "east",  dx = (w + 3) / 2,  dy = 0, dir = defines.direction.west },
      { name = "west",  dx = -(w + 3) / 2, dy = 0, dir = defines.direction.east },
      { name = "south", dx = 0, dy = (h + 3) / 2,  dir = defines.direction.north },
      { name = "north", dx = 0, dy = -(h + 3) / 2, dir = defines.direction.south },
    }) do
      local pos = { x = e.x + side.dx, y = e.y + side.dy }
      if surface.can_place_entity { name = "storage-tank", position = pos, force = force_name, direction = side.dir } then
        local t = surface.create_entity { name = "storage-tank", position = pos, force = force_name, direction = side.dir }
        if t then
          local start = 0
          if fluid then
            pcall(function() t.insert_fluid { name = fluid, amount = tank_capacity() } end)
            start = fluid_in_tank(t)
          end
          out[#out + 1] = { tank = t, side = side.name, started = start }
        end
      end
    end
    return out
  end

  local feeds, collect, unwired = {}, {}, {}
  local fluid_feeds, fluid_collect = {}, {}
  for _, port in ipairs(ports_in) do
    local rec = built[port.entity]
    if rec and port.item then
      if internal_set[port.item] then
        unwired[#unwired + 1] = { item = port.item, entity = port.entity, card = rec.name }
      else
        feeds[#feeds + 1] = { chest = rec.entity, item = port.item }
      end
    elseif rec and port.fluid then
      local placed = tanks_on_faces(rec.entity, port.fluid)
      if #placed == 0 then
        unwired[#unwired + 1] = { fluid = port.fluid, entity = port.entity, card = rec.name,
          why = "NO_ROOM_FOR_SUPPLY_TANK" }
      end
      for _, tf in ipairs(placed) do
        tf.fluid = port.fluid
        fluid_feeds[#fluid_feeds + 1] = tf
        ents_array[#ents_array + 1] = tf.tank
      end
    end
  end
  for _, port in ipairs(ports_out) do
    local rec = built[port.entity]
    if rec then
      if port.item then
        collect[#collect + 1] = { entity = rec.entity, item = port.item }
      else
        local placed = tanks_on_faces(rec.entity, nil)
        if #placed == 0 then
          unwired[#unwired + 1] = { fluid = port.fluid, entity = port.entity, card = rec.name,
            why = "NO_ROOM_FOR_COLLECTOR_TANK" }
        end
        for _, tf in ipairs(placed) do
          tf.fluid, tf.last, tf.total = port.fluid, 0, 0
          fluid_collect[#fluid_collect + 1] = tf
          ents_array[#ents_array + 1] = tf.tank
        end
      end
    end
  end
  if #feeds == 0 and #fluid_feeds == 0 then
    verify.destroy(built)
    return fail("CARD_NO_FEEDS", "no in port resolved to an entity that is not already internal",
      { unwired_inputs = unwired })
  end

  -- A furnace takes its recipe from whatever is in its source slot, but an assembling
  -- machine sits idle until something sets `recipe` -- an unbound assembler measures
  -- as zero output and looks like a broken layout rather than an unspecified intent.
  local supplied = {}
  for _, f in ipairs(feeds) do supplied[f.item] = true end
  for _, f in ipairs(fluid_feeds) do supplied[f.fluid] = true end
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

  storage.lab = {
    id = (storage.lab and storage.lab.id or 1000) + 1,
    mode = "submitted",
    state = "running",
    started = game.tick,
    deadline = game.tick + math.floor(seconds * 60),
    prev_speed = game.speed,
    speed = speed,
    surface = field(surface, "name") or "?",
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
  lab_ents[storage.lab.id] = ents_array
  lab_rigs[storage.lab.id] = { feeds = feeds, collect = collect, gens = gens,
                               fluid_feeds = fluid_feeds, fluid_collect = fluid_collect,
                               machines = machines, fuel_targets = fuel_targets,
                               in_chests = (function()
                                 local t = {} for _, f in ipairs(feeds) do t[#t + 1] = f.chest end return t
                               end)(),
                               out_chests = (function()
                                 local t = {} for _, c in ipairs(collect) do t[#t + 1] = c.entity end return t
                               end)() }

  game.speed = speed

  return {
    job = storage.lab.id, state = "running", card_name = normalized.name,
    entities = #ents_array, origin = origin, run_ticks = math.floor(seconds * 60),
    speed = speed, contract = contract, expected_per_min = expected_total,
    supplied_grid = #gens > 0, feeds = #feeds, collectors = #collect,
    fluid_feeds = #fluid_feeds, fluid_collectors = #fluid_collect,
    unwired_inputs = #unwired > 0 and unwired or nil,
    fuel = fuel, fuelled_machines = fuelled,
    recipes_bound = bound, unwired_inputs = unwired,
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
    local l = card.lint(source, { available = availability_checker(world_db(), game.forces[args.force or "player"]) })
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
  storage.cards[name] = rec

  return {
    name = name, frozen = true, measured = measured, claimed = rec.claimed,
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

function M.cards(args)
  storage.cards = storage.cards or {}
  local out = {}
  for name, rec in pairs(storage.cards) do
    local ents = rec.card and rec.card.entities or {}
    out[#out + 1] = {
      name = name, entities = #ents, measured = rec.measured, claimed = rec.claimed,
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
           measured = rec.measured, claimed = rec.claimed }
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
  local fits, blockers = card_fits(surface, rec.card, origin, force_name)
  if not fits then
    return fail("SITE_REJECTED", "this card will not build at that origin; the ghosts would be lies",
      { blockers = blockers, origin = origin })
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
           surface = surface.name, measured = rec.measured }
end

-- The rigs live in measure.lua; they are methods like any other, and the dispatcher only sees
-- names on M.
M.drill_rate = measure.drill_rate
M.pump_rate = measure.pump_rate

-- The lab surface is created on demand and its chunks arrive a few ticks later, so a caller on a
-- fresh save needs a way to ask "is the ground there yet" instead of reading `out-of-map` and
-- blaming whatever it was holding. Everything that measures goes through this surface.
function M.sandbox(args)
  local surface, pad, why = lab_surface()
  if not surface then
    return fail("SANDBOX_" .. (why or "UNAVAILABLE"),
      why == "GENERATING" and "the lab surface exists but its chunks are still generating; call again"
        or "the lab surface could not be prepared", { reason = why, pad = pad })
  end
  return { surface = surface.name, pad = pad, ready = true,
           chunk_generated = surface.is_chunk_generated({ 0, 0 }) }
end

-- "How big does the power supply have to be?" -- answered as arithmetic, with every constant
-- read from the engine and the one modelled figure (the day curve) printed beside the answer
-- instead of buried in a rule of thumb. Give it `demand_kw`, or a `card` to read the draw of.
function M.power_plan(args)
  args = args or {}
  local surface = (args.surface and resolve_surface(args.surface)) or game.surfaces[1]
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end

  local demand = args.demand_kw
  local have = {}
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

  local surface, pad, why = lab_surface()
  if not surface then
    if why == "GENERATING" then
      return fail("SANDBOX_GENERATING", "the verification surface is still generating chunks; call again in a second")
    end
    return fail("NO_SANDBOX", tostring(why))
  end
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
  plan.card_name = normalized.name
  plan.pole = args.pole or "small-electric-pole"
  plan.supply = args.supply or "solar-panel"
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

-- Research / power / production state (L0 summary).
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
        category = field(p, "category") or field(p, "resource_category"),
        mining_time = field(p, "mining_time"),
        infinite = field(p, "infinite_resource"),
        walkable = field(p, "walking_speed"),
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
-- (lab_ents / lab_rigs live at the top of the file, shared with the card methods.)

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
lane_units = function(ox, oy, count, furnace, belt, inserter, chest, fw, fh, power, reach, outlets)
  local R = math.max(1, math.floor(reach or 1))
  local run = 2 * R + 3                       -- belt tiles on the input row
  local fcol = 2 * R + math.floor(run / 2)    -- column the furnace column starts at
  local out_row = oy + 2 * R + fh - 1
  local rightmost = fcol + fw - 1 + 2 * R
  local pitch = math.max(2 * R + run + 3, rightmost + 3)
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
  if storage.lab and storage.lab.state == "running" then
    return fail("LAB_BUSY", "job " .. tostring(storage.lab.id) .. " still running; call lab_stop")
  end

  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end

  local count = args.furnaces or 4
  local furnace = args.furnace or "stone-furnace"
  local belt = args.belt or "transport-belt"
  local inserter = args.inserter or "inserter"
  local chest = args.chest or "steel-chest"
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

  pcall(function() surface.create_global_electric_network() end)

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
  lab_ents[storage.lab.id] = built
  lab_rigs[storage.lab.id] = { in_chests = in_chests, out_chests = out_chests, over_chests = over_chests, gens = gens }

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

  game.speed = speed

  return {
    job = storage.lab.id,
    state = "running",
    lane_count = count,
    card_power = card_power,
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
  if storage.lab and storage.lab.state == "running" then
    return fail("LAB_BUSY", "job " .. tostring(storage.lab.id) .. " still running; call lab_stop")
  end

  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end

  local machine = args.machine or "stone-furnace"
  local recipe = args.recipe or "iron-plate"
  local count = args.count or 4
  local seconds = args.seconds or 30
  local speed = args.speed or 20
  local fuel = args.fuel or "coal"
  local origin = args.origin or { x = 600, y = 600 }

  local mp = prototypes.entity[machine]
  if not mp then return fail("UNKNOWN_MACHINE", machine) end
  local rp = prototypes.recipe[recipe]
  if not rp then return fail("UNKNOWN_RECIPE", recipe) end

  local m_speed = getter(mp, "get_crafting_speed") or getter(mp, "get_researching_speed")
  if not m_speed then return fail("NOT_A_CRAFTER", machine) end
  local energy = field(rp, "energy")
  local yields = 0
  for _, p in ipairs(field(rp, "products") or {}) do
    if p.name == (args.product or recipe) then
      yields = (p.amount or (p.probability and p.probability or 0))
    end
  end
  local product = args.product or recipe
  local ingredient = args.ingredient or ((field(rp, "ingredients") or {})[1] or {}).name
  if not ingredient then return fail("NO_SINGLE_INGREDIENT", recipe) end

  local expected_per_min = count * (60 / (energy / m_speed)) * yields

  local built = {}
  for i = 1, count do
    local pos = { x = origin.x + i * 4, y = origin.y }
    local e = surface.create_entity { name = machine, position = pos, force = "player" }
    if not e then
      for _, prev in ipairs(built) do prev.destroy() end
      return fail("LAB_BUILD_FAILED", "no room at " .. pos.x .. "," .. pos.y)
    end
    built[#built + 1] = e
    pcall(function() e.set_recipe(recipe) end)
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
    produced = 0,
    fed = 0,
    fed_blocked = 0,
    fuelled = 0,
    fuel_blocked = 0,
    missing = 0,
  }
  lab_ents[storage.lab.id] = built

  game.speed = speed

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
    collectors_holding = j.collectors_holding,
    collector_full = j.collector_full,
    machine_status = j.machine_status,
    supply_faces = j.supply_faces,
    diagnostics = j.diagnostics,
    tick_error = j.tick_error,
    game_speed = game.speed,
  }
end

local function lab_diagnostics(j)
  local rig = lab_rigs[j.id]
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
  for _, e in ipairs(lab_ents[j.id] or {}) do
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
  for _, e in ipairs(lab_ents[j.id] or {}) do
    if e.valid then
      e.destroy()
      gone = gone + 1
    end
  end
  lab_ents[j.id] = nil
  lab_rigs[j.id] = nil
  j.destroyed = gone
  if j.prev_speed then game.speed = j.prev_speed end

  return {
    job = j.id, state = j.state,
    elapsed_ticks = elapsed,
    produced = j.produced,
    fluid_yields = j.fluid_yields, collector_full = j.collector_full,
    collectors_holding = j.collectors_holding, machine_status = j.machine_status,
    supply_faces = j.supply_faces,
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
  if j.state ~= "running" then return fail("LAB_IDLE", "job " .. tostring(j.id) .. " already " .. j.state) end
  return finalize_lab(j)
end

-- Jobs do not survive save/load, but their state does; this clears a resurrected
-- record so a stale "running" job cannot block every later start.
function M.lab_reset(args)
  local j = storage.lab
  local cleared = 0
  if j then
    for _, e in ipairs(lab_ents[j.id] or {}) do
      if e.valid then e.destroy(); cleared = cleared + 1 end
    end
    lab_ents[j.id] = nil
    lab_rigs[j.id] = nil
    storage.lab = nil
    if j.prev_speed then game.speed = j.prev_speed end
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
local function run_lab_tick()
  local j = storage.lab
  if not j or j.state ~= "running" then return end

  local ents = lab_ents[j.id]
  if not ents then
    j.state = "abandoned"
    if j.prev_speed then game.speed = j.prev_speed end
    return
  end

  if j.mode == "submitted" then
    local rig = lab_rigs[j.id]
    if not rig then
      j.state = "abandoned"
      if j.prev_speed then game.speed = j.prev_speed end
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
    -- fluid mid-window and the tail of the measurement is a starvation curve, not a rate.
    for _, f in ipairs(rig.fluid_feeds or {}) do
      if f.tank.valid then
        alive = alive + 1
        local held = fluid_in_tank(f.tank)
        -- a tank that lost fluid is the proof of which face the box is on; the level is remembered
        -- across refills so the drain is a running total rather than the last reading
        if held < (f.started or 0) then f.accepted = (f.accepted or 0) + ((f.started or 0) - held) end
        if held < tank_capacity() - 1 then
          pcall(function() f.tank.insert_fluid { name = f.fluid, amount = tank_capacity() } end)
        end
        f.started = fluid_in_tank(f.tank)
      end
    end
    for _, c in ipairs(rig.fluid_collect or {}) do
      if c.tank.valid then
        local all = fluid_in_tank(c.tank)
        local held = fluid_in_tank(c.tank, c.fluid)
        -- whatever arrives is named, because a machine's output face may hand over a different
        -- product than the one the card claims, and that difference is the answer
        if all > 0 and held == 0 and not c.got then
          local any = (c.tank.get_fluid_contents() or {})[next((c.tank.get_fluid_contents() or {}))]
          c.got = any and ((type(any) == "table" and any.name) or nil) or nil
        end
        if held > (c.last or 0) then c.total = (c.total or 0) + (held - c.last) end
        c.last = held
        if all >= tank_capacity() - 1 then c.filled = true end
      end
    end
    if alive == 0 then
      j.state = "abandoned"
      if j.prev_speed then game.speed = j.prev_speed end
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
      local fluids, ceiling = {}, false
      for _, c in ipairs(rig.fluid_collect or {}) do
        if c.tank.valid then
          local name = c.fluid or c.got
          if name then fluids[name] = (fluids[name] or 0) + (c.total or 0) end
          if c.filled then ceiling = true end
        end
      end
      -- which face each machine actually took each fluid from, measured: the one piece of geometry
      -- the runtime data will not give up
      local faces = {}
      for _, f in ipairs(rig.fluid_feeds or {}) do
        if (f.accepted or 0) > 0 then
          faces[#faces + 1] = { fluid = f.fluid, side = f.side, units = f.accepted }
        end
      end
      if #faces > 0 then j.supply_faces = faces end
      if next(fluids) then j.fluid_yields = fluids end
      j.collector_full = ceiling or nil
      -- what the collector actually holds, which for a refinery may be heavy oil rather than the
      -- claimed gas: a zero against a claim has to say whether the machine ran and where the
      -- product went
      local holding = {}
      for _, c in ipairs(rig.fluid_collect or {}) do
        if c.tank.valid then
          pcall(function()
            for k, v in pairs(c.tank.get_fluid_contents() or {}) do
              local nm = (type(k) == "table") and k.name or k
              holding[#holding + 1] = { wanted = c.fluid, holds = nm,
                units = (type(v) == "number") and v or (v.amount or 0) }
            end
          end)
        end
      end
      if #holding > 0 then j.collectors_holding = holding end
      local rev
      for k, v in pairs(defines.entity_status) do rev = rev or {} ; rev[v] = k end
      local st = {}
      for _, m in ipairs(rig.machines or {}) do
        if m.entity.valid then
          st[#st + 1] = { name = m.name, status = rev and rev[m.entity.status] or tostring(m.entity.status),
            recipe = (function()
              local ok2, r2 = pcall(function() return m.entity.recipe end)
              return ok2 and r2 and (r2.name or r2) or nil
            end)() }
        end
      end
      if #st > 0 then j.machine_status = st end
      finalize_lab(j)
    end
    return
  end

  if j.mode == "card" then
    local rig = lab_rigs[j.id]
    if not rig or not rig.in_chests[1] or not rig.in_chests[1].valid then
      j.state = "abandoned"
      if j.prev_speed then game.speed = j.prev_speed end
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
  storage[dead_field] = { reason = "RUNNER_RAISED", job = job and job.key, msg = tostring(err),
                          tick = game.tick }
  storage[error_field] = tostring(err)
  if job then
    reap(job)
    game.speed = job.prev_speed or 1
    game.tick_paused = job.prev_paused
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
    j.tick_error = tostring(err)
    if j.prev_speed then game.speed = j.prev_speed end
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

local function gui_api()
  return {
    place = function(name) return M.card_place({ name = name, ghosts = true }) end,
    blueprint = function(name) return M.card_blueprint({ name = name }) end,
  }
end

function M.gui_model(args)
  return gui.model(storage.cards, MOD_VERSION)
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
  e.destroy = function() e.destroyed = true end
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
  local model = gui.model(args.cards or storage.cards, MOD_VERSION)
  local opened = gui.open(player, model)
  local tree = {}
  local function walk(e, depth)
    tree[#tree + 1] = string.rep("  ", depth) .. tostring(e.type) ..
      (e.name and "[" .. e.name .. "]" or "") ..
      (e.caption and " '" .. tostring(e.caption) .. "'" or "")
    for _, c in ipairs(e.children or {}) do walk(c, depth + 1) end
  end
  if screen[gui.ROOT] then walk(screen[gui.ROOT], 0) end

  -- drive every button the panel rendered, through the same handler a click uses
  local clicks = {}
  local api = {
    place = function(n) clicks[#clicks + 1] = "place:" .. n; return { ok = true, data = { ghosts = 3, origin = { x = 0, y = 0 }, surface = "mock" } } end,
    blueprint = function(n) clicks[#clicks + 1] = "string:" .. n; return { ok = true, data = { blueprint = "0eNq..." } } end,
  }
  for _, name in ipairs({ "arch-refresh", "arch-close", "arch-place:demo", "arch-string:demo", "not-ours" }) do
    local ok, res = pcall(gui.on_click, player, name, model, api)
    clicks[#clicks + 1] = name .. " -> " .. (ok and tostring(res or "unhandled") or "ERROR " .. tostring(res))
  end
  return { built = opened ~= nil, tree = tree, widgets = #tree, clicks = clicks, printed = calls }
end

script.on_event(defines.events.on_gui_click, function(event)
  local player = game.get_player(event.player_index)
  if not player then return end
  local element = event.element
  if not element then return end
  local name = field(element, "name")
  if type(name) ~= "string" or name:sub(1, 5) ~= "arch-" then return end
  pcall(function()
    gui.on_click(player, name, gui.model(storage.cards, MOD_VERSION), gui_api())
  end)
end)

script.on_event(defines.events.on_player_left_game, function(event)
  local player = game.get_player(event.player_index)
  if player then pcall(function() gui.close(player) end) end
end)

-- 2.0 registers commands explicitly (and they no longer need the "/c" workaround), so the
-- panel is reachable as /arch from chat and shows up in the command picker.
local function register_commands()
  pcall(function()
    commands.remove_command("arch")
  end)
  commands.add_command(function(context)
    local player = context.player_index and game.get_player(context.player_index) or nil
    if not player then
      game.print("architect: /arch needs a player in the game to show a window")
      return
    end
    local state = gui.toggle(player, gui.model(storage.cards, MOD_VERSION))
    if state == "failed" then game.print("architect: could not build the window") end
  end, { "", "Architect: open or close the design panel" }, "arch")
end

script.on_init(register_commands)
script.on_load(register_commands)
script.on_configuration_changed(register_commands)

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

script.on_configuration_changed(function() model_cache = nil db_cache = nil supply_cache = nil end)
script.on_load(function() model_cache = nil db_cache = nil supply_cache = nil end)
