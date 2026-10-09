local MOD_VERSION = "0.85.0"

-- The rule this file lives under, learned from a player's desync report: control-stage code runs in
-- every machine in the game, once per command and once per tick, and the only thing that makes the
-- copies agree is that each one reads the same save and writes the same bytes. So three things are
-- not allowed here, and all three were present at once until 0.52.0:
--   * a fact about the save kept in a module local (a lab job's entity handles, "has this pad been
--     painted"). The process that starts the job knows it; every process that LOADS the game does not,
--     and writes its own verdict about a job it cannot see. `lab_reload_e2e.js` is the gate, because
--     no single-process test can tell "different code path" from "different machine".
--   * anything per-process inside `storage`. An error message is allowed to carry `table: 0x5601f2…`;
--     stored, that is a different byte on every machine -- hence `host.errtext`.
--   * a write to state that is not this mod's (`game.speed`, `game.tick_paused`) whose OUTCOME is
--     recorded. The bench wants 40x and a client may refuse it; refusing is fine, storing the
--     refusal is a divergence. See `host.clock_raise`.
-- What this process's startup steps report, kept out of `storage` on purpose: Factorio CRC-checks
-- the mod's storage across `on_load` and refuses to boot a server whose mod wrote to it there
-- ("not save/load stable and not multiplayer safe"). A load-time fact is also not a save fact -- it
-- has to be re-established every boot, which is exactly what makes it worth recording.
local boot = {}

local rat = require("rat")
local card = require("card")
local verify = require("verify")
local gui = require("gui")
local host = require("host")
local roles = require("roles")
local styles = require("styles")
local measure = require("measure")
local fluidrig = require("fluidrig")
local boxes = require("boxes")
local ports = require("ports")

-- The shared primitives keep their old local names: every call site in this file reads them, and
-- `host.field(...)` everywhere would bury the data those calls are about.
local field = host.field
local fail = host.fail
local fail_key = host.fail_key
-- A solver refusal that knows its own sentence's key (`msg_key`, carried up inside the detail because
-- that is the one bag the solver's refusals already hand back) gets it lifted next to `code` and `msg`,
-- which is where the panel looks for it. The English `msg` stays exactly as it was: the RCON answer and
-- the window are then two renderings of one fact rather than two claims about it.
local function fail_lifted(code, msg, detail)
  local t = fail(code, msg, detail)
  if type(detail) == "table" and type(detail.msg_key) == "string" then
    t.msg_key, t.msg_params = detail.msg_key, detail.msg_params or {}
  end
  return t
end
local as_table = host.list_arg
local kw_of = host.kw_of
local resolve_surface = host.resolve_surface
local surface_or_default = host.surface_or_default

local M = {}

local lane_units              -- defined below; card_example needs it from above
local availability_checker    -- defined below; card_example needs it from above
local panel_model             -- defined below; gui_api's show-more rebuilds the frame through it
local inserter_reach          -- defined below; card_example needs it from above
local arm_is_burner           -- ditto: whether an arm burns fuel, read off the same probe
local warm_reach              -- defined below; the bootstrap and `measured_facts` both need it
local keeps_facing            -- ditto: whether a built entity holds the facing the card gave it
local lab_surface             -- ditto: the ground a pole's reach is measured on
local bus_line                -- defined below; bus_example needs it from above
local lane_of                 -- ditto: the capacity a belt row declares
local belt_need               -- ditto: helmod's "how many belts does this flow want", in half-belt steps
local sign_mark                 -- 股号前面那个箭头（→ 进料 / ← 成品），定义在 `sign_messages` 旁边

-- 注释里的词汇表（读到下面这些名字时来这里查，别在仓库里找它们 —— 都不在了）：
--   * `row-chest` / `row-belts` / `sandwich-2` / `two-feed` —— 2026-10-07 玩家要求"带箱子的排法全部删掉"
--     时连同几何一起删的四种排法。今天只有 `stacked`（单排）、`two-row`（双排）、`fluid-back`（水在背面）。
--     它们留在若干判断的来历里（例如"一根成品带走得完多少 = 有几个面往它上面放料"），那是量出来之后才知道的
--     规矩，不是还能选的形状。
--   * `drill_rate` / `farm_rate` / `line_watch` / `region_layout` / `supply_menu` / `supply_area` /
--     `insertion_method` / `poles_tried` / `probe_cache` / `lab_ents` / `lab_rigs` —— 已删的方法、字段或
--     旧的模块级缓存。句子说的一般是"这个规矩当初是从哪一次故障/哪一台夹具量出来的"。
--   * `dev/circuit_rules_probe.js` / `dev/fluid_box_cells.js` / `dev/lane_split_probe.js` /
--     `dev/bus_line_e2e.js` / `dev/fluid_row_e2e.js` / `dev/circuit_blueprint_emit.js` —— 一次性探针或已删
--     的门禁。带 `act X`（如"act P"）的引用指的是那次探针的第 X 号实验，事实本身已经写进引用它的那段代码，
--     并且大多由现存套件钉着（`dev/locale_check.js` 与 `dev/refusals.js` 会抓"答案发出来却没人说清"那类）。
--     `dev/lane_split_probe.js` 改名为 `dev/lane_side_probe.js`（两股由哪一面装，就是它量的）。
--   * 引擎侧的名字（`rotation_speed` / `stack_size` / `connection_distance` / `conditions` /
--     `copy_count_from_input` / `circuit_connect`）出现在注释里通常是**说它们不存在**（2.0 撤了），不是找它们。

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

-- One recipe's expected yield of one product, in items per craft. `amount` is absent whenever a product
-- is randomised (`amount_min`/`amount_max` stand in) and `probability` is a chance rather than a quantity;
-- reading one as the other sized every centrifuge 143x too small once. Both lab methods price a window
-- against this, so it lives in one place: `lab_card` had no such factor at all, which reported a line
-- running a recipe that yields 2 per craft as delivering twice its expected rate.
local function expected_yield(recipe, product)
  local total = 0
  for _, pr in ipairs(field(recipe, "products") or {}) do
    if field(pr, "name") == product then
      local amount = field(pr, "amount")
      local probability = field(pr, "probability") or 1
      local each
      if amount == nil and (field(pr, "amount_min") or field(pr, "amount_max")) then
        each = ((field(pr, "amount_min") or 0) + (field(pr, "amount_max") or 0)) / 2 * probability
      else
        each = (amount or 1) * probability
      end
      total = total + each
    end
  end
  return total
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

-- 一件零件"为什么放不出"，从引擎那三层各读一次：原型里有没有这件东西、它的放置配方在这支力量里
-- 存不存在/开没开、以及是哪几个科技开的、研究了没有。`NO_AVAILABLE_PART` 以前只带得出检查器自己的
-- 结论（"nothing in it is unlocked"）—— 而"原型里没有"、"这支力量没研究"和"我们读错了"是三种完全
-- 不同的下一步。这句还有一层实际用处：2.0 的选择组合器要 `advanced-combinators` 才解锁，不研究的
-- 存档按名拒时如果只说"没有可用的选择器"，玩家无从知道差的是哪一个科技。
local function part_probe(force, names)
  local out = {}
  for _, cand in ipairs(names or {}) do
    local p = prototypes.entity[cand]
    local list = p and field(p, "items_to_place_this")
    local iname = list and place_item_of(p) or nil
    local proto_recipe = iname and prototypes.recipe[iname] or nil
    local fr = iname and force.recipes[iname] or nil
    local techs = {}
    if proto_recipe then
      for tname, t in pairs(prototypes.technology) do
        for _, e in pairs(t.effects or {}) do
          if e.type == "unlock-recipe" and e.recipe == iname then
            local live = force.technologies[tname]
            techs[#techs + 1] = { tech = tname, researched = (live and live.researched) or false }
          end
        end
      end
      table.sort(techs, function(a, b) return tostring(a.tech) < tostring(b.tech) end)
    end
    out[cand] = { place_item = iname, recipe_present = proto_recipe ~= nil,
      recipe_enabled = (fr and fr.enabled) or false, unlocks_with = #techs > 0 and techs or nil }
  end
  return out
end

-- 那句人话：没解锁的时候点名是哪个科技欠着；原型里根本没有这件东西时实话说是缺东西，不是缺研究。
local function part_missing_said(probe)
  local locked, absent = {}, {}
  for name, v in pairs(probe or {}) do
    if not v.recipe_present then absent[#absent + 1] = name
    elseif not v.recipe_enabled then
      local t = v.unlocks_with and v.unlocks_with[1] and v.unlocks_with[1].tech or nil
      locked[#locked + 1] = name .. (t and (" (needs " .. t .. ")") or " (recipe not enabled)")
    end
  end
  table.sort(locked); table.sort(absent)
  if #locked > 0 then return " -- " .. table.concat(locked, ", ") end
  if #absent > 0 then return " -- no place recipe for " .. table.concat(absent, ", ") .. " on this install" end
  return ""
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
        -- `* 8` is the per-tile item count of a ONE-tile-wide item, and it is the one number in this
        -- file's arithmetic that came out of 1.1-era memory rather than out of this install: nothing on
        -- a 2.0 runtime belt prototype states it, and a two-tile-wide item (steel plate, stone brick)
        -- carries half of it. So the figure is a claim about 1-wide items -- which is every item the
        -- smelting and assembly plans here move -- and the day a plan moves a wide one, this is the
        -- line that is wrong, and `throughput_per_sec` is where the fix belongs. It has not been
        -- measured off a running belt here, and is not presented as if it had been.
        --
        -- Tried, and the attempt is worth recording because it looked like it would work: a static
        -- probe CAN fill one tile of a belt and count what fit -- but `LuaTransportLine.insert_at_back
        -- (items, belt_stack_size)` takes the stack size as an ARGUMENT, and the engine returns
        -- exactly what it is handed (1 in -> 1 on the tile, 8 -> 8, 64 -> 64, measured). So a
        -- synchronous rig measures its own input and reports it as a property of the belt. The 8 is
        -- the spacing of items on a MOVING line -- which is what 15/s for a yellow belt says -- and
        -- reading it off the engine needs the world to advance: an inserter-free run fed from script
        -- each tick, items counted leaving the far end, i.e. the tick-runner shape `drill_rate`
        -- already has. See task #46.
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
            -- How much of this product a productivity bonus may NOT multiply. 2.0 stopped shipping
            -- `catalyst_amount` and started shipping this instead, and it is the only thing the engine says
            -- about catalyst-shaped products: the yield it computes is `(amount - ignored) * (1 + bonus) +
            -- ignored`. Left out of the model, the solver multiplied a returned catalyst as if it were made
            -- from nothing, which inflates every rate the recipe feeds and sizes its machines too small.
            ignored = rat.from((p.ignored_by_productivity or 0) * (p.probability or 1)),
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

  -- What grows. A plantation item has no recipe that yields it -- `yumako` comes out of a `yumako-tree`
  -- that somebody planted from a `yumako-seed` -- so the recipe graph has no leaf to hang a rate on, and
  -- the solver answered the question with `NO_UNLOCKED_RECIPE` and an EMPTY prerequisite list, which is a
  -- sentence about a technology nobody has to research. The plant does state two facts: its own growth
  -- timer and what one harvest hands back. Those are read here, filed under the item the player asks for.
  --
  -- Re-looked up by name rather than taken from the iteration: `pairs(prototypes.item)` hands back values
  -- that answer nil for `plant_result` while `prototypes.item[name]` answers the entity (measured on this
  -- install), so a scan over the values it was given found no planter at all and reported an empty table
  -- as if that were a fact about the world.
  --
  -- Deliberately missing: the tower. `agricultural-tower` states `radius` (its own footprint) and
  -- `growth_area_radius` (the crane's reach) and nothing that bears on output -- `farm_tile_requires_water`
  -- is not a member and raises (measured) -- so how many tiles one tower tills, and how long its
  -- plant-and-harvest cycle takes, are not knowable from here. Those live in animation geometry, which is
  -- why they are the answer of a rig (`farm_rate` in measure.lua) rather than of a read: the tower is
  -- asked which soil it tills, then emptied every tick for a window.
  local farmable = {}
  local function expected_amount(p)
    local a = field(p, "amount")
    if a == nil then
      local lo, hi = field(p, "amount_min"), field(p, "amount_max")
      if lo and hi then a = (lo + hi) / 2 else a = lo or 1 end
    end
    return a * (field(p, "probability") or 1)
  end
  for name in pairs(prototypes.item) do
    local seed = prototypes.item[name]
    local plant = seed and field(seed, "plant_result")
    local plant_name = plant and field(plant, "name")
    local grown = plant_name and prototypes.entity[plant_name]
    local growth = grown and field(grown, "growth_ticks")
    local props = grown and field(grown, "mineable_properties")
    local products = props and field(props, "products")
    if growth and growth > 0 and type(products) == "table" then
      for _, p in ipairs(products) do
        local yields = field(p, "name")
        local per = yields and prototypes.item[yields] and expected_amount(p) or 0
        if per > 0 then
          local cur, rate = farmable[yields], per / growth
          if not cur or rate > cur.per_tick then
            farmable[yields] = { item = yields, seed = name, plant = plant_name,
              per_plant = per, growth_ticks = growth, per_tick = rate }
          end
        end
      end
    end
  end

  db_cache = {
    recipes = recipes, producers = producers, machines = machines,
    raw = raw, default_miner = default_miner, miners_by_category = miners_by_category,
    modules = modules, farmable = farmable,
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
-- question -- what one machine of this name takes out of this ore per minute. The farm rig shares the
-- table too, but a farm is looked up by the PLANT it works rather than by an ore, so the solver finds
-- its record by the `plant` field every drill and pump record lacks (see `farm_rig_for`).
local function measured_cache()
  local measured = {}
  for _, cache in ipairs({ storage and storage.drills or {}, storage and storage.pumps or {},
    storage and storage.farm or {} }) do
    for key, record in pairs(cache) do measured[key] = record end
  end
  return measured
end

-- What one arm of this tier moves of this item, if the bench has ever measured it. A scan rather than a
-- key lookup because `arm_rate` files a run both under the tier it was asked for and under "all tiers",
-- and the lane knows its tier without knowing which call produced it. `nil` is the honest answer when
-- nothing has been measured -- a rate invented here would be a ceiling a player then finds they cannot
-- build to.
--
-- The ROW comes back rather than only its `items_per_min`, because the two ends of that figure behave
-- differently. Measured on two saves of one install with one code path, the swing rate agreed to the
-- tick (47.5 a minute for a burner inserter in both) while items per swing came out 1 in one and 4 in
-- the other: a hand fills with whatever is under it, and the rig's chest is not a lane's belt. So the
-- rate a plan may lean on is the swing rate, and the full-hand figure is the upper end beside it.
local function measured_arm_row(item, arm_name)
  for _, rec in pairs(storage and storage.arms or {}) do
    if rec.item == item then
      for _, t in ipairs(rec.tiers or {}) do
        if t.arm == arm_name and not t.error and (t.items_per_min or 0) > 0 then
          return t, rec
        end
      end
    end
  end
  return nil, nil
end

-- Has the bench ever measured how fast this ARM tier swings, on any item? The swing rate is the figure
-- that transfers between saves (see the note on `measured_arm_row`: the two ends of items-per-minute
-- disagreed between two saves of one install while the swings agreed to the tick), and it is the only
-- speed this mod can rank arms by -- 2.0 carries no `rotation_speed` or `insertion_method` on a runtime
-- inserter prototype (measured: every such key raises), so there is nothing to read. `nil` means "no
-- tier has been measured", and the picker says so in its own words rather than inventing an order.
local function measured_arm_swings(arm_name)
  local best
  for _, rec in pairs(storage and storage.arms or {}) do
    for _, t in ipairs(rec.tiers or {}) do
      if t.arm == arm_name and not t.error then
        local s = tonumber(t.swings_per_min) or 0
        if s > 0 and (not best or s > best) then best = s end
      end
    end
  end
  return best
end

-- How deep the engine put this arm in the research tree: how many technologies stand between the start
-- of the game and the one that hands it over. Only a fallback -- the swing rate above is the real
-- figure -- and it exists because 2.0 gives a runtime inserter prototype no speed to read, so an
-- unmeasured ladder otherwise falls back to NAME order, which on this install ranks `burner-inserter`
-- (a starter arm that burns coal) ahead of `fast-inserter`. Research depth is data the engine does
-- answer, it says the same thing the tier ladder means ("the arm you had to work for"), and it costs a
-- handful of prototype reads cached beside the reach figures.
-- What an arm costs to craft, one level deep: the sum of its place item's recipe ingredients. This is
-- not a price model and does not pretend to be -- it is the thing that separates "the tier that does the
-- job" from "the tier that also does your neighbour's job", which on a fully-researched save otherwise
-- walks every lane up to a bulk inserter because the research tree hands that one over last.
local ARM_COST = {}
local function arm_cost(name)
  if ARM_COST[name] ~= nil then return ARM_COST[name] end
  local p = prototypes.entity[name]
  local item = p and (host.field(p, "items_to_place_this") or {})[1]
  local cost = nil
  if item and item.name then
    local r = prototypes.recipe[item.name]
    if r then
      cost = 0
      for _, i in ipairs(r.ingredients or {}) do cost = cost + (tonumber(i.amount) or 1) end
    end
  end
  ARM_COST[name] = cost
  return cost
end

local ARM_DEPTH = {}
local function arm_research_depth(name)
  local item = (prototypes.entity[name] and (host.field(prototypes.entity[name], "items_to_place_this") or {})[1])
  if ARM_DEPTH[name] ~= nil then return ARM_DEPTH[name] end
  local depth = 0
  if item and item.name then
    -- THE RECIPE THAT MAKES THIS ITEM, not any recipe that mentions it. The first version of this loop
    -- scanned the products of every recipe and took a match, which on this install found
    -- `long-handed-inserter-recycling` as the producer of `inserter` -- a recycling recipe no technology
    -- unlocks -- so the ordinary inserter scored research depth 0 and beat the burner arm into every
    -- lane, which is the opposite of the rule. Fast-inserter scored 0 the same way, for the same reason.
    local r = prototypes.recipe[item.name]
    if r then
      for _, t in pairs(prototypes.technology) do
        for _, e in ipairs(t.effects or {}) do
          if e.type == "unlock-recipe" and e.recipe == item.name then
            -- Counted from 1, not 0: the technology itself is a rung. Starting at 0 made a gated arm
            -- with no prerequisites score the same as an arm you start the game with, and the tie then
            -- fell to name order -- which put `burner-inserter` (depthless, and it burns coal) in front
            -- of `inserter` on this save. Measured, first version: every reachable arm scored 0.
            local seen, n = {}, 0
            local function walk(tech, at)
              if not tech or seen[tech.name] or at > 24 then return end
              seen[tech.name] = true
              if at > n then n = at end
              for _, pr in ipairs(tech.prerequisites or {}) do
                if prototypes.technology[pr.name or pr] then walk(prototypes.technology[pr.name or pr], at + 1) end
              end
            end
            walk(t, 1)
            if n > depth then depth = n end
          end
        end
      end
    end
  end
  ARM_DEPTH[name] = depth
  return depth
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
local MENU_AUTO = { "architect.menu-auto" }

-- Can this entity be TOLD what to craft? `circuit_set_recipe` and `set_recipe` belong to an
-- assembling machine and to nothing else in 2.0 -- a furnace answers `Entity is not assembling-machine`
-- to the setter and runs whatever is in front of it, so no wire can disagree with it. Everything on a
-- bus is laid to answer a wire, which makes a furnace lane with a bus on it a row of controllers
-- pointing at machines that cannot hear them. Asked once here, at file scope, by the refusal in
-- `card_example` and by the panel's candidate list, instead of being discovered by a player watching
-- gears not get made.
local function takes_recipe(name)
  local pp = name and prototypes.entity[name]
  return pp ~= nil and field(pp, "type") == "assembling-machine"
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

-- What an example card is built from. The candidate set is every entity of the engine's own type that
-- this force can place, ranked by a figure read from the prototype (`belt_speed`, crafting speed) or
-- measured (arm reach). The names below are only *hints* -- what a vanilla player expects to see in a
-- fixture -- and `roles.pick` replaces one with the best data-ranked candidate on any save where that
-- entity does not exist. The ladder this replaces was a list of names, and two of its five entries
-- (`filter-inserter`, `chest`) are not entities in 2.0 at all.
local PART_HINTS = {
  arm = "stack-inserter", belt = "express-transport-belt",
  chest = "steel-chest", furnace = "electric-furnace",
  -- the vanilla name is a hint, not a claim: what comes back is whatever placeable entity of engine type
  -- `pipe` this install has. Naming it keeps the feed row's part deterministic on a modded save, where
  -- "the first pipe in name order" could otherwise be a decorative one that carries nothing.
  pipe = "pipe",
}

-- The same rule for every example generator: a vanilla name is a hint, and what comes back is whatever
-- entity of that engine type actually exists on this install. Unlock state is deliberately not
-- consulted here -- `card_check` is the layer that refuses a part the force cannot build, and a
-- fixture whose shape moved with the tech tree would not be something anyone could assert against.
local function example_part(kind, hint, wanted)
  return roles.pick(kind, { prefer = wanted or hint })
end

-- Which arm a lane is built with, decided by what the shape has to REACH -- not by a remembered tier,
-- and not by the player. 2.0 states neither an inserter's speed nor its range on a runtime prototype
-- (measured here: `rotation_speed` and `insertion_method` both raise), so the rule rests on the two
-- facts that DO exist: the reach this mod measures off a live arm (cached, and pre-warmed at boot), and
-- the reach the shape declares it needs. Ascending by reach, take the first candidate that satisfies the
-- need -- an ordinary or fast inserter reaches 1, a long-handed one reaches 2 -- so a lane whose arms
-- stand between its belt and its machine gets the short arm, and only a shape that must cross a belt
-- asks for the long one.
--
-- Measured on the bench, and it is not a cosmetic difference: the same 6-machine 电路板 lane laid with
-- long-handed arms came out 21x19 instead of 20x11 and delivered 33 items in the window instead of 69,
-- because a long arm reaches one tile further and swings half as fast. So the long arm is an escalation
-- a shape earns by declaring `min_reach`, not the default nobody wanted.
local function arm_ladder_for_need(force, is_available, need, measure)
  local list, meta = roles.ladder("arm", { available = is_available, order = "asc", measure_of = measure })
  local shortest, group = nil, {}
  for _, e in ipairs(list or {}) do
    -- `>= need` is the rule, not an optimisation: the first draft collected the shortest reach on the
    -- save and stopped there, so a lane that has to reach across a pipe row still got a one-tile arm and
    -- the fluid pass refused it downstream (`LANE_FEED_ROW_UNREACHABLE: inserter stands on cell 15,1`).
    if e.unlocked ~= false and e.figure and e.figure >= need then
      -- ascending, so the first satisfied figure IS the minimum; the rest of that figure are the peers
      -- the reach rule cannot choose between, and that is what the measured swing rate below is for.
      if not shortest or e.figure == shortest then
        shortest = e.figure
        group[#group + 1] = e
      end
    end
    if shortest and e.figure > shortest then break end
  end
  if #group == 0 then
    return nil, { need = need, why = list and "no-unlocked-arm-reaches-need" or "no-arm-candidates",
      ladder = list }
  end
  -- "够用就好" (2026-10-05) needs a number this API does not hand out: 2.0 raises for
  -- `energy_per_movement`, `fuel_inventory_size` and `stack_size` on every inserter prototype measured
  -- here, so nothing on a prototype says which arm is fast and which one burns coal. What DOES exist:
  -- the cost to craft (2 for the burner arm, 3 for the ordinary one and the long-handed one, 5 for the
  -- fast one, 14 and 32 above that), the swing rate 量臂 measures off a live arm, and the tree. So the
  -- rule is stated as a preference with its reason on the page, not dressed up as arithmetic: take the
  -- standard electric workhorse tier when this install can build it -- the one a player means by "高速
  -- 机械臂" -- and otherwise the cheapest arm in the group. Pure cost, measured on the first draft of
  -- this branch, picked the burner arm for every lane in the game, which is the other wrong answer.
  local ARM_WORKHORSE = "fast-inserter"
  local chosen = nil
  for _, e in ipairs(group) do
    if e.name == ARM_WORKHORSE then chosen = e break end
  end
  if #group > 1 and not chosen then
    table.sort(group, function(a, b)
      -- Fuel before cost. The first cost-ranked draft of this branch put `burner-inserter` on every
      -- lane in the game, because two ingredients beats three and the coal arm is the cheapest arm on
      -- the planet -- and the gate caught it as `player=burner-inserter` where the player had research
      -- and the enemy force did not (measured 2026-10-06). A lane whose arms burn coal stops the moment
      -- the coal runs out, and a blueprint carries no coal: the claim "this line makes 900 plates a
      -- minute" would be a claim about a lane that stops. So the coal tier is LAST, not cheapest.
      local ba, bb = arm_is_burner(a.name), arm_is_burner(b.name)
      -- Ranked, not compared for equality: "we never measured this arm" must not read as "this arm is
      -- electric", because that is how an unmeasured coal tier wins a lane on a stale cache. Known
      -- electric first, unmeasured last-but-one, known-burning dead last.
      local burn_rank = function(v) return v == false and 0 or (v == nil and 1 or 2) end
      if burn_rank(ba) ~= burn_rank(bb) then return burn_rank(ba) < burn_rank(bb) end
      -- 够用就好 (the player's words, 2026-10-05): among arms that reach the same distance, take the
      -- cheapest to craft. The first draft ranked by research depth instead, and on a save with every
      -- technology unlocked that handed every lane a `bulk-inserter` -- the deepest tier in the tree,
      -- and the one a smelting row has no use for. Reach already filtered the group, so the question is
      -- "what does this lane need", not "what is the best arm in the game".
      local ca, cb = arm_cost(a.name), arm_cost(b.name)
      if ca and cb and ca ~= cb then return ca < cb end
      if ca and not cb then return true end
      if cb and not ca then return false end
      -- Same cost (or one with no recipe to count): the measured swing rate, then the tree, then name.
      local ar, br = measured_arm_swings(a.name), measured_arm_swings(b.name)
      if ar and br and ar ~= br then return ar > br end
      if ar and not br then return true end
      if br and not ar then return false end
      local ad, bd = arm_research_depth(a.name), arm_research_depth(b.name)
      if ad ~= bd then return ad > bd end
      return a.name < b.name
    end)
  end
  local win = chosen or group[1]
  local swings = measured_arm_swings(win.name)
  local cost = arm_cost(win.name)
  local burns = arm_is_burner(win.name)
  local decided = chosen and ("the standard electric workhorse tier (" .. ARM_WORKHORSE .. "; "
    .. string.format("%.0f", cost or 0) .. " ingredients to craft)"
    .. (swings and "; measured " .. string.format("%.1f", swings) .. " lifts/min"
      .. " -- 量臂 is what ranks the rest, since no prototype field carries a speed"
      or " -- no arm_rate measurement on this save; 量臂 turns " .. ARM_WORKHORSE .. " from a stated"
      .. " preference into a number"))
    or (cost and ("cheapest arm that reaches " .. tostring(win.figure) .. " ("
      .. string.format("%.0f", cost) .. " ingredients)"
      .. (swings and "; measured " .. string.format("%.1f", swings) .. " lifts/min"
        or "; swing not measured"))
      or (swings and ("measured swing rate " .. string.format("%.1f", swings) .. "/min")
        or ("research depth " .. arm_research_depth(win.name))))
    -- Said out loud, because "the lane stopped an hour later" is the kind of complaint this file exists
    -- to make impossible to point at: the coal tier is chosen only when nothing electric on this save
    -- reaches that cell, and then the answer carries the reason the line would stop.
    .. (burns == true and "; NOTE 烧炉臂 -- this arm burns fuel, the line stops when the coal runs out "
      .. "and a blueprint carries none; it was the only tier on this install reaching cell "
      .. tostring(win.figure) or "")
  return win.name, { arm = win.name, reach = win.figure, need = need, ranked = true,
    burns = burns, peers = #group, decided_by = decided, swings_per_min = swings,
    how = string.format("reach %d is the shortest that serves this shape; %d arms share it and %s is "
        .. "%s (%s)%s", win.figure, #group, win.name,
        chosen and "the standard 高速 tier, 够用就好 -- not the best arm in the tree"
          or "the cheapest of them to craft",
        cost and (string.format("%.0f", cost) .. " ingredients") .. --, so a lane that needs more than "enough"
          " -- 够用就好, not the best tier in the game" or "no recipe to count",
        swings and string.format("; measured %.1f lifts/min, which is what ranks equal-cost arms", swings)
          or " -- 量臂 (arm_rate) measures the swing rate, which then ranks equal-cost arms") }
end

-- 一台机器的**一个面**能服务几条带行。2026-10-06 在 27016 台架上量出来的（dev/belt_stack_probe.js）：
-- 一只臂只喂"距离 = 它的 reach"那一行带子，取和放都发生在那一格上。所以这个数不是形状的属性、也不是
-- 谁记着的表，而是两件事的交集：这个势力能放的臂里**互不相同的 reach 档数**，和机器自己的深度
-- （放点落在机身之外就是放在地上，机器永远收不到）。
-- 香草给出 2 档（reach 1 与长手的 2），所以无箱的一条线一台机器最多吃 4 种料；装了更长的臂的 mod
-- 会把这条上限顶上去，装了 reach 3 的臂就是 6 种 —— 这里不写死数字，一切从这台机器上量。
local function arm_reach_tiers(force_name, is_available)
  local measure = function(n) return inserter_reach(game.surfaces[1], n, force_name) end
  local list = roles.ladder("arm", { available = is_available, order = "asc", measure_of = measure })
  local seen, tiers = {}, {}
  for _, e in ipairs(list or {}) do
    if e.unlocked ~= false and e.figure and not seen[e.figure] then
      seen[e.figure] = true
      tiers[#tiers + 1] = e.figure
    end
  end
  return tiers
end

-- The caller's own word, then this ladder -- and a word that is not an arm this force can place is
-- replaced with a sentence saying so, exactly like the belt, chest and machine picks. Handing a name
-- straight back was the first draft of this function, and it is the bug the suite has a check for:
-- `inserter: "not-a-real-arm"` came back as a card armed with `not-a-real-arm`, lint refused a part the
-- caller could not see the reason for, and `components_how` had no `inserter` row at all -- three
-- answers, each of them saying a different thing about the same non-existent arm.
--
-- A name that IS a real arm is used exactly, and if it cannot reach what the shape needs the answer is
-- the named refusal `ARM_TOO_SHORT` -- the player pinned that arm, and quietly arming the lane with
-- another one would build a line they never asked for.
local function arm_for_need(force, is_available, need, wanted)
  need = math.max(1, math.floor(tonumber(need) or 1))
  local measure = function(n) return inserter_reach(game.surfaces[1], n, force.name) end
  if not wanted then return arm_ladder_for_need(force, is_available, need, measure) end
  local named, named_meta = roles.pick("arm", { prefer = wanted, available = is_available })
  if named == wanted then
    local r = measure(wanted) or 1
    return wanted, { arm = wanted, reach = r, need = need, named = true, short = r < need,
      how = named_meta and named_meta.how or "named" }
  end
  local name, meta = arm_ladder_for_need(force, is_available, need, measure)
  if name and meta then
    meta.how = string.format("asked for %s (%s); %s instead", wanted,
      (named_meta and named_meta.requested_reason) or "it is not an arm this force can place",
      meta.how or "the shortest arm that reaches this shape was taken off the ladder")
  end
  return name, meta
end

-- The arm for any lane this mod draws, by the same rule: the shape's need, then the shortest arm this
-- force can actually build. The force matters -- `example_part` only checks that a name is a placeable
-- entity of the right type, so a hint naming a tier the save has not researched comes back as a card the
-- linter refuses (measured: a bus spine armed with `fast-inserter` on a save without that technology,
-- answered `LOCKED_ENTITY: fast-inserter cannot be built yet` twice, for a card nobody can place).
local function lane_arm(force_name, wanted, need)
  local f = game.forces[force_name or "player"]
  local db2 = f and world_db() or nil
  if f and db2 and refresh_availability(db2, f.name) then
    return arm_for_need(f, availability_checker(db2, f), need, wanted)
  end
  local name = example_part("arm", "fast-inserter", wanted)
  return name, name and { arm = name, need = math.max(1, math.floor(tonumber(need) or 1)) } or nil
end

-- 排法只有两种（玩家 2026-10-07："把带箱子的排法全部删除或者改为不带箱子的"、"排法我们就暂定两种吧，
-- 单排和双排，双排就是共用出料传送带"）。带箱子的那四种 —— row-chest / row-belts / sandwich-2 / two-feed
-- —— 连同它们的几何一起删了，所以这份阶梯不再需要"退到一张会放箱子的线上"：
--   * 先试**单排**（`stacked`）：一行机器，进料堆在一个面、成品堆在另一个面，一只箱子都没有；
--   * 一个面叠不起这么多行（进料或成品要的行数超过额度）就换**双排**（`two-row`）：台数对半分到两个面上，
--     两排的成品共用中间那条带子 —— 共用成立是因为站在带子两面的臂各落进不同的一股（实测
--     `dev/lane_side_probe.js`：北臂的料在 line2、南臂的在 line1）；
--   * 两个都装不下就按名拒，说清是哪个数放不下。悄悄铺一条喂不齐料的线，比拒一次难看。
--
-- `materials` 与 `chest_free` 两个参数留着：调用方按老样子交，阶梯不再看它们 —— 因为"料多到一根带装不下"
-- 这件事现在由形状自己的 `demand` 回答（单排问一个面的额度，双排问半台数），而不是由一张按料种数分支的
-- 表猜。等这两条路都各有断言撑着之后，这两个参数会从签名里去掉。
local function shape_ladder(n, materials, chest_free, drinks)
  -- 喝水的配方（`drinks` 非 0）排在"水在背面"那一档：另外两种排法把机器两面都占给了臂与带子，管道排
  -- 挤不进去，于是它们一条喝水的线只能铺一台（实测：2 台就按名拒，`FEED_ROW_TAKEN`）。不喝水的配方
  -- 一行都不该多占地面，所以那一档只在这一个条件下进阶梯。
  if drinks and drinks > 0 then return { "fluid-back", "stacked", "two-row" } end
  return { "stacked", "two-row" }
end

-- What the shape needs, read off the registry so a style that starts requiring a longer reach changes
-- the arm without anyone remembering to edit this line.
local function style_min_reach(style_id)
  local s = style_id and styles.get(style_id)
  return (s and s.min_reach) or 1
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

-- Quarter turns of a finished shape. Two words rather than four directions because the question a
-- player is answering is about the box, not about the compass: 横排 runs the lanes along the width,
-- 竖排 along the height, and a lane turned twice is the same row of parts facing the other way for
-- no benefit anyone asked for. The numbers are the quarter turns `styles.turn` applies.
local ORIENTATION = { horizontal = 0, vertical = 1 }

-- Which shape a caller named, or the one its drop-down row points at. The panel can only know the row,
-- because the registry lives beside this file rather than inside the window: resolving an index here
-- keeps the word list in the panel and the id list in one place, so a style added in styles.lua shows up
-- in the control and means the same thing on both sides on the same tick.
local function style_named(args)
  -- The window's row 1 is 自动 = the empty string, the same "no preference" every other picker here
  -- uses. It has to read as "nothing named" rather than as the name of a style, because
  -- `styles.get("")` is nil and a lane would then refuse with UNKNOWN_STYLE over a blank row.
  if args.style and args.style ~= "" then return args.style end
  local row = tonumber(args.style_index)
  return row and styles.ids()[row] or nil
end

-- The card's own rectangle, in cell coordinates. The cells come from `styles.part_box` -- the same
-- measured rule the lint uses -- because a part whose box grows along its facing is anchored at its first
-- cell's centre, not at its box's centre: taking every position for a box centre made a turned lane
-- report a footprint one or two cells taller than the flat card it was rotated from, and the packer that
-- reads that number spaces lanes apart by a distance the card does not fill.
local function card_bbox(normalized)
  local minx, miny, maxx, maxy
  for _, e in ipairs(normalized.entities or {}) do
    local p = prototypes.entity[e.name]
    local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
    local ox, oy, bw, bh = styles.part_box(w, h, e.direction or 0, e.position.x, e.position.y)
    if not ox then
      ox, oy, bw, bh = math.floor(e.position.x - w / 2 + 0.5),
        math.floor(e.position.y - h / 2 + 0.5), w, h
    end
    minx = math.min(minx or ox, ox); maxx = math.max(maxx or (ox + bw), ox + bw)
    miny = math.min(miny or oy, oy); maxy = math.max(maxy or (oy + bh), oy + bh)
  end
  return minx, miny, maxx, maxy
end

function M.card_example(args)
  args = args or {}
  local db = world_db()
  local force = game.forces[args.force or "player"]
  if not force then return fail("NO_FORCE", tostring(args.force)) end
  if not refresh_availability(db, force.name) then return fail("NO_FORCE", force.name) end
  local is_available = availability_checker(db, force)

  local how = {}
  local function pick(kind, wanted, category)
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
      -- Which recipes the candidate may run. Only a crafter pick carries one; for every other role it
      -- is nil, and `roles.pick` filters on it only when it is set.
      category = category,
      measure_of = measure_of,
    })
    how[kind] = meta and meta.how or "none"
    return name, meta
  end

  -- Which recipe this lane is a template FOR. Unnamed, it is the one this method has always built --
  -- smelting iron plate -- and every figure below keeps the value it had. Named, it brings the machine
  -- (which has to be able to run that recipe's category), the item the line carries out, and the one it
  -- waits for. That is what lets `plan_fit` answer a gear plan about gears instead of telling the
  -- player that the box is full of furnaces they never asked for.
  local recipe_name = args.recipe or "iron-plate"
  local recipe = db.recipes[recipe_name]
  if not recipe then
    return fail("UNKNOWN_RECIPE", "no recipe named " .. tostring(args.recipe), { asked_for = args.recipe })
  end
  -- What this recipe drinks and what it gives off as fluid, separated before anything else reads the
  -- ingredient list: the item figures below (`product`, `first_ing`) are the ones a chest-and-belt lane can
  -- actually carry, and a fluid in that list is the reason the lane needs a pipe row instead -- which is
  -- decided twice in this function, once about the recipe and once about the shape it grows into.
  local fluid_ins, fluid_outs = {}, {}
  for _, i in ipairs(recipe.ingredients or {}) do
    if i.type == "fluid" and i.name then fluid_ins[#fluid_ins + 1] = i.name end
  end
  for _, p in ipairs(recipe.products or {}) do
    if p.type == "fluid" and p.name then fluid_outs[#fluid_outs + 1] = p.name end
  end
  local product, first_ing = nil, nil
  for _, p in ipairs(recipe.products or {}) do
    if p.type ~= "fluid" and not product then product = p.name end
  end
  for _, i in ipairs(recipe.ingredients or {}) do
    if i.type ~= "fluid" and not first_ing then first_ing = i.name end
  end
  -- Every ITEM the recipe eats, in the recipe's own order and without repeats. `first_ing` is the one a
  -- single-chest lane can be fed; this list is how many the recipe actually wants, and a shape that lays
  -- a feed line wide enough for two of them (`shared_row`) reads it to decide what its head is made of.
  local feed_items, feed_seen = {}, {}
  for _, i in ipairs(recipe.ingredients or {}) do
    if i.type ~= "fluid" and i.name and not feed_seen[i.name] then
      feed_seen[i.name] = true feed_items[#feed_items + 1] = i.name
    end
  end
  product = product or "iron-plate"
  -- A crafter is not a furnace: `oil-refinery`, `chemical-plant` and `centrifuge` are all
  -- `assembling-machine` to the engine, so the recipe's category is the only thing that sorts them.
  -- The smelting default keeps the old kind -- widening it here would move every number a
  -- four-lane-smelter answer has ever been checked against, for a plan that is still smelting.
  -- 点名的机器以前在这一发上会被**整个丢掉**：配方是铁板时只看 `args.furnace`，`machine` 参数根本没人读
  -- （实测：点名电力采矿机做铁板，回来的是电炉，而答案对这次点名一个字都没说 —— 那是"你以为你要的是 A,
  -- 地上铺的是 B，而没人告诉你"那一类）。所以两条梯子各自接住自己那一类的点名：铁板仍走熔炉梯子（把
  -- `machine` 也递给它的 `wanted`，让它去判断"这是不是一台熔炉"），其余配方走带类别的那条。
  -- 换成别的写法都会撞在同一件事上：熔炉梯子不收组装机、机器梯子不收熔炉（"crafter is not a furnace"），
  -- 走错一条就把一台能用的电炉换成一台做不了这配方的东西。
  -- 两种点名，分得很开，因为它们的责任不同：
  --   `furnace` / `machine` = **硬点名**（调用方就是要这一台）。铺出来的不是它，就按名拒，绝不换 ——
  --     和带子那一格同一条律（`点名要一种带子时，模不会背着把它换掉`）。从前这里只把名字递给 `prefer`，
  --     `roles.pick` 发现它跑不了这一类就顺着梯子换一支，答案只在 `components_how` 那句英文里说；
  --     于是"钉 stone-furnace 做电池"回来的是 cryogenic-plant，而这条线接下来**口在哪一面**、要几档臂、
  --     牌写什么，全都由这次没打招呼的替换决定（实测：`machine = assembling-machine-3` 与不点名，两发的
  --     拒因一模一样 —— 那一个参数在这一发上等于没写）。
  --   `machine_hint` = **偏好**（压线用：helmod 那一行点了台机器，但玩家要的首先是"这一页铺出来"）。
  --     可以换，换了一定要报 —— `lanes[].asked_machine` 与 `machine_swapped` 就是这一句。
  local hard_machine = args.furnace or args.machine
  local wanted_machine = hard_machine or args.machine_hint
  local machine_swapped = nil
  local furnace, machine_meta = nil, nil
  if recipe_name == "iron-plate" then
    furnace, machine_meta = pick("furnace", wanted_machine)
  else
    furnace, machine_meta = pick("machine", wanted_machine, recipe.category)
  end
  if wanted_machine and furnace and furnace ~= wanted_machine then
    machine_swapped = { asked = wanted_machine, laid = furnace,
      why = machine_meta and machine_meta.requested_reason or nil }
    if hard_machine then
      local probe = part_probe(force, { wanted_machine })
      return fail_key("MACHINE_ASKED_UNUSABLE", "m-machine-asked",
        { tostring(wanted_machine), tostring(recipe_name), tostring((recipe or {}).category or "?"),
          tostring(furnace) },
        "this lane was told to build with " .. tostring(wanted_machine) .. " and that machine cannot "
          .. "run " .. tostring(recipe_name) .. " here -- the ladder would have used " .. tostring(furnace)
          .. " instead, and a named machine is not something this mod swaps out quietly",
        { asked_for = wanted_machine, would_have_used = furnace, recipe = recipe_name,
          category = (recipe or {}).category, why = machine_meta and machine_meta.requested_reason,
          candidates = probe })
    end
  end
  -- 带 `flows` 时（压线链：helmod 那一棵树里这一行折好的件数），**吃什么、吐什么**的清单也以它为准。
  -- 名字和流量是同一份数据的两面：用原型的清单去配 helmod 的流量，等于让两台机器各说一遍同一条线，
  -- 而它们迟早会 disagree（原型里没有的那一项，正是这一模不搬的燃料）。
  -- 不带 `flows` 就是"不经过 helmod、直接要一张卡"那扇门，上面从原型来的那些清单一个没动。
  --
  -- 这一段必须排在**挑机器之后**：那份件数是按 helmod 那一行点名的机器算的（`flows.machine` 带着它的
  -- 速度、模块与信标），而这一发真能放下去的可能是另一台。换了机器，那份数就不成立 ——
  -- 每分钟做几次工艺由地上这台的速度决定，而模块那部分加成是我们对地上这台一无所知的。
  -- 拿着 X 的数去铺 Y 的线是"放得下但不生产"那一类错，所以这里退回自算那一路，并把
  -- "为什么退、退成了哪台、helmod 那份原数是多少"一起交出去（`rate_source.reason`）。
  local flows = type(args.flows) == "table" and args.flows or nil
  local flows_swapped = nil
  if flows and type(flows.machine) == "string" and flows.machine ~= furnace then
    flows_swapped = { helmod_machine = flows.machine, laid_machine = furnace,
      crafts_per_min = flows.crafts_per_min, machines_helmod = flows.machines_helmod,
      base_time = flows.base_time, modules = flows.with_modules }
    flows = nil
  end
  if flows then
    local function names_of(list)
      local out, seen = {}, {}
      for _, e in ipairs(list or {}) do
        if e.item and not seen[e.item] then seen[e.item] = true out[#out + 1] = e.item end
      end
      return out
    end
    fluid_ins, fluid_outs = names_of(flows.fluids), names_of(flows.product_fluids)
    feed_items = names_of(flows.feed)
    -- 线上往外搬的那种料：helmod 的产物清单第一个。一个固体产物都没有（炼油那一类）就保留原型算出来的
    -- 那个名字，它此时只是"这条线没有可数的产物"的一个占位，不参与流量。
    if #(flows.products or {}) > 0 then product = flows.products[1].item end
    first_ing = feed_items[1] or first_ing
  end
  -- The arm is chosen by what the SHAPE has to reach (see `arm_for_need`), which is why it is resolved
  -- from the style the caller named rather than from a hint: every shape in the registry feeds and drains
  -- with arms standing between the belt and the machine, so the need is 1 and a long-handed arm is only
  -- ever an escalation a shape asks for by declaring `min_reach`.
  --
  -- There is one configuration today that does ask: a recipe that DRINKS a fluid grows a pipe row beside
  -- the machines, and the arm that lifts from the feed line has to get over that row to reach the
  -- machine's box. Measured the other way first -- with the need left at 1, `fluid_row_e2e`'s water
  -- lane came back `LANE_FEED_ROW_UNREACHABLE: inserter stands on cell 15,1` -- which is the proof that
  -- the rule is "what the ground needs", not "shorter is cheaper".
  local needs, drinks_fluid = 1, #fluid_ins > 0
  needs = style_min_reach(style_named(args))
  if drinks_fluid then needs = math.max(needs, 2) end
  local ins, ins_meta = arm_for_need(force, is_available, needs, args.inserter)
  ins_meta = ins_meta or {}
  ins_meta.drank_fluid = drinks_fluid or nil
  -- The arm's row in the same bill the other four parts write. It used to come from `pick("arm", ...)`,
  -- and when the arm stopped being a hint and became a decision, that row went with it: `components_how`
  -- answered with three parts for a card of four, and the substitution sentence -- the one that tells a
  -- player on a modded save which arm they were handed and why -- was nowhere on the page.
  how.inserter = ins_meta.how or ins_meta.why or "none"
  if ins and ins_meta.short then
    return fail_key("ARM_TOO_SHORT", "m-arm-too-short", { ins, tostring(ins_meta.need) },
      tostring(ins) .. " reaches " .. tostring(ins_meta.reach) .. " and this shape needs " .. ins_meta.need,
      { asked_for = ins, reach = ins_meta.reach, need = ins_meta.need, style = style_named(args) or "stacked",
        because = drinks_fluid and "the recipe drinks a fluid, so a pipe row stands between the arm and the machine" or nil })
  end
  local belt = pick("belt", args.belt)
  local chest = pick("chest", args.chest)
  -- Which head the line starts with. `chest` is every lane this mod has ever drawn: a box per material,
  -- an arm per box, and the bench feeds the lane by filling those boxes. `belt` deletes all of them --
  -- the row starts as a bare belt tail the player splices their own bus into -- and in their place stands
  -- a sign: one emitter box and one display panel, saying which half-lane carries which material. That
  -- swap is not cosmetic: with the chests gone the card has no in-port left for `card_lab` to fill, so
  -- the head decides what the bench may claim about the lane (see `head` on the answer and the refusal
  -- `card_lab`/`card_verify` make for a `belt` head).
  -- 线头默认是裸带（玩家："把带箱子的排法全部删除或者改为不带箱子的"）。`chest` 不再是一种线头：
  -- 带箱子的四种排法已经删掉，没有任何形状画得出"箱子起步"的那一行了，留着这一格就是让答案说一件
  -- 地上没有的事。所以它按名拒，而不是悄悄当成 belt。
  local heads = args.heads == "chest" and "chest" or "belt"
  -- `sign_panel` / `sign_emitter`, not `panel` / `emitter`: the bus block below declares `local selector,
  -- emitter, arithmetic` in this same function body, and a name it re-declares is a name that reads nil
  -- from that line onward -- measured, with the pick's own row in `components_how` saying the part was
  -- found and the head refusing anyway.
  local sign_panel, sign_emitter
  if heads == "belt" then
    sign_panel = pick("panel", args.panel)
    sign_emitter = pick("emitter", args.emitter)
  end
  if not (furnace and ins and belt) then
    -- an example card with an unplaceable part in it is worse than no card: every lint result it
    -- produces would be about a fixture nobody can build. `chest` is not in this list: no shape lays one,
    -- so a force that cannot place a container still gets its line.
    -- 说得出是哪一格缺、以及为什么缺（缺研究还是这台上根本没这件东西）：从前这一句只说"某一个角色
    -- 拿不出零件"，让调用者去猜是哪一个、再猜下一步该研究什么。
    local miss_roles = {}
    if not furnace then miss_roles[#miss_roles + 1] = (recipe_name == "iron-plate") and "furnace" or "machine" end
    if not ins then miss_roles[#miss_roles + 1] = "arm" end
    if not belt then miss_roles[#miss_roles + 1] = "belt" end
    local probe = part_probe(force, roles.names(miss_roles[1]))
    -- 这句为什么写成**带参数**的那一格：`dev/locale_check.js` 钉的是"无参数那一形里，en 那一行必须逐字
    -- 等于 Lua 传的那句"。这里要在角色后面再挂半句诊断（欠哪个科技），那一半不进窗口、只进 RCON 的话，
    -- 所以把参数与主句交给 locale 那一行，尾巴留在 Lua —— 同一条规矩在 `m-lines-beyond-shape` 上也是这么办的。
    return fail_key("NO_AVAILABLE_PART", "m-no-placeable-part", { tostring(miss_roles[1]) },
      "no placeable candidate for one of the card's roles: " .. miss_roles[1] .. part_missing_said(probe),
      { wanted = { furnace = args.furnace, arm = args.inserter, belt = args.belt, chest = args.chest },
        picks = how, missing_roles = miss_roles, candidates = probe })
  end

  local fp = prototypes.entity[furnace]
  local fw, fh = (fp and fp.tile_width) or 2, (fp and fp.tile_height) or 2
  -- 机器的速度与配方的能耗，在形状决定带子数量之前就要拿到：`stacked` 那一档的"要几条带"是流量除出来的，
  -- 而流量是 台数 x 速度 / 能耗。原来这两行在铺完之后才算（`crafts` 那一节），这里把它们提上来，并且只留
  -- 这一处 —— 同一个公式在两个地方各写一遍是这个仓库最容易烂掉的那种东西。
  local speed = (fp and getter(fp, "get_crafting_speed")) or 1
  local energy = rat.toNumber(recipe.energy)
  -- 这条线每分钟过几件，只有一个出口：下面这一份 `rate_for`。
  --
  --   * 带 `flows`（压线链：helmod 那一行自己折过的件数 —— productivity、模块、信标、quality 都在里面），
  --     每一种料的 /分 就从那一份里读，按这一发的台数等比缩（整线 k=1，拆成几条线时每条拿自己那一份）。
  --   * 不带（`card_example` 自算那扇门，"不经过 helmod 直接要一张卡"）时，才是这里按
  --     `台数 × 速度 × 60 / 能耗` 算的那一路 —— 那一路保留，但压线链不许走它（#35：一条线过几件不得由
  --     我们自己再算一遍）。
  -- 缩的是**已经折好的那份**，不是重新算：单件量取 helmod 的 `per_craft`（= count / 工艺次数），所以台数
  -- 变化时 productivity 那份加成不会掉。
  local flow_machines = flows and (tonumber(flows.machines) or 0) or 0
  local function rate_for(machines)
    local m = math.max(0, tonumber(machines) or 0)
    if flows and flow_machines > 0 then
      local sc = m / flow_machines
      local function scaled(list)
        local out = {}
        for _, e in ipairs(list or {}) do
          out[#out + 1] = { item = e.item, per_craft = e.per_craft, per_min = (tonumber(e.per_min) or 0) * sc }
        end
        return out
      end
      return { source = "helmod", machines = m, scale = sc,
        crafts_min = (tonumber(flows.crafts_per_min) or 0) * sc,
        feed = scaled(flows.feed), fluids = scaled(flows.fluids),
        products = scaled(flows.products), product_fluids = scaled(flows.product_fluids),
        fuel = scaled(flows.fuel),
        quoted_for = flow_machines, helmod_machines = flows.machines_helmod,
        base_time = flows.base_time, crafts = flows.crafts, machine = flows.machine,
        craft_energy = flows.craft_energy, modules = flows.with_modules }
    end
    local crafts = rat.toNumber(rat.div(rat.mul(rat.mul(rat.from(speed), rat.new(60)),
      rat.new(m)), rat.from(energy)))
    local feed, fluids, products, product_fluids = {}, {}, {}, {}
    local function push(list, name, amount)
      list[#list + 1] = { item = name, per_craft = amount, per_min = crafts * amount }
    end
    for _, i in ipairs(recipe.ingredients or {}) do
      local amount = rat.toNumber(i.amount) or 1
      if i.name and i.type == "fluid" then push(fluids, i.name, amount)
      elseif i.name then push(feed, i.name, amount) end
    end
    for _, pr in ipairs(recipe.products or {}) do
      local amount = rat.toNumber(pr.amount) or 1
      if pr.name and pr.type == "fluid" then push(product_fluids, pr.name, amount)
      elseif pr.name then push(products, pr.name, amount) end
    end
    return { source = "self", machines = m, scale = 1, crafts_min = crafts, feed = feed,
      fluids = fluids, products = products, product_fluids = product_fluids, fuel = {} }
  end

  -- 这条线要几条带：料占的股数除到整条带，产物也一样（每个固体产物都算）。
  -- `belt_name` 是可以点名的：带子按"够用就好"挑的时候，同一台架要拿每一档各算一遍，所以这一格不能
  -- 只认外面那个已经挑好的名字。
  -- `product_lanes` 是几股，`product_lanes_per_line` 是这根带子能被几个面装满（单排 1、双排 2，形状自己
  -- 说），所以"要几条成品带"是除以后者而不是除以 2 —— 除以 2 就是假设总有两个面朝它放货，那是双排的几何。
  local function lane_demand(machines, belt_name, lanes_per_line)
    local per_lane = (lane_of(product, belt_name or belt, nil, force).per_min or 0) / 2
    if per_lane <= 0 then return nil end
    local rate = rate_for(machines)
    local feed_lanes, product_lanes = 0, 0
    local feed_split, product_split = {}, {}
    -- 清单来自 `rate_for`：带 flows 时它是 helmod 那一行的料单（燃料不在里头，因为这一模的带子不搬燃料），
    -- 不带时它是原型的料单。两种情况都在这一处读，所以不会出现"料单说三种、流量说两种"。
    -- 每一样料占几股，只问 `belt_need` 这一个出口。这里**不另算一遍** —— 同一张卡上"要几条带子"若由
    -- 两处各自取整，早晚会 disagreement；而那条律要换（>0.5 整条向上）也只换它一处，这一行跟着走。
    local function lanes_for(per_min)
      local bn = belt_need(per_min, belt_name or belt, force)
      return bn.lanes or 0
    end
    for _, e in ipairs(rate.feed or {}) do
      local n = lanes_for(e.per_min)
      feed_lanes = feed_lanes + n
      feed_split[#feed_split + 1] = { item = e.item, lanes = n, per_min = e.per_min }
    end
    for _, e in ipairs(rate.products or {}) do
      local n = lanes_for(e.per_min)
      product_lanes = product_lanes + n
      product_split[#product_split + 1] = { item = e.item, lanes = n, per_min = e.per_min }
    end
    local share_ok, share_why = true, nil
    -- 玩家 2026-10-09 补的那道闸：**只有出料单股装得下**，才允许它借进料行空出来的那一股；
    -- 装不下就必须单独一条成品带（今天的行为），这一格不是可选优化。
    -- 一股的运力是 `per_lane`（一条带子一分钟过几件 ÷ 2，里面已折 `belt_stack_size_bonus`），
    -- 件数取 helmod 那份（`rate_for` 的 products[].per_min），不是按地上重算的那份。
    local feed_rows = math.max(1, math.ceil(feed_lanes / 2))
    local spare = math.max(0, 2 * feed_rows - feed_lanes)
    for _, k in ipairs(product_split) do
      if (k.per_min or 0) > per_lane then
        share_ok = false share_why = "product_over_one_lane"
        break
      end
    end
    if share_ok and spare < product_lanes then
      share_ok = false share_why = "no_spare_lane"
    end
    -- 真共用时行号在这里排好交出去（形状、两块牌、台架都读同一份，不在那边各算一遍）：
    -- 成品臂只能站在带子的机器这一面，而**站在哪一面就只装离自己远的那一股**
    -- （`dev/shared_row_probe.js`：向东的带子 line1 = 北股 = 南岸那只臂落的那一股），
    -- 所以成品占各行的一号股 2*(行-1)+1，料先把各行近侧那股 2*行 填满、溢出来的才去没成品的行远侧。
    -- 这样排还有个必然结果：**让给成品的那些行只剩一股送料**，那些行的取货臂才筛得了料（一只臂筛不了两种）。
    local feed_lane_of, product_lane_of = {}, {}
    if share_ok and product_lanes > 0 then
      for j = 1, product_lanes do product_lane_of[j] = 2 * j - 1 end
      for i = 1, feed_lanes do
        feed_lane_of[i] = (i <= feed_rows) and (2 * i)
          or (2 * (product_lanes + (i - feed_rows)) - 1)
      end
    end
    return { per_lane = per_lane, crafts_min = rate.crafts_min, feed_lanes = feed_lanes,
      product_lanes = product_lanes, feed_split = feed_split, product_split = product_split,
      feed_rows = feed_rows,
      product_rows = math.max(1, math.ceil(product_lanes
        / math.max(1, tonumber(lanes_per_line) or 2))),
      -- `laid` 由调用方按形状声明那一格定（`feed_row_share`）：判定先行、行照旧分开铺 ——
      -- 在还没把成品臂站到进料臂那一行的形状里把 product_rows 折成 0，会铺出一条没有成品的线。
      share = { possible = share_ok, blocked_by = share_why, spare_lanes = spare,
        per_lane = per_lane, laid = false,
        feed_lane_of = #feed_lane_of > 0 and feed_lane_of or nil,
        product_lane_of = #product_lane_of > 0 and product_lane_of or nil } }
  end
  -- The rotating line's ingredient list: which recipes the machines on this lane are meant to COVER, in
  -- the order they should be handed out. Named, the lane grows a controller under every machine and a
  -- bus under those (see the `bus` row in styles.lua), and every machine takes its recipe from the wire
  -- rather than from the plan; unnamed, the lane is exactly what it always was.
  --
  -- Vetted against the hardware this function just picked, which is why it sits here and not beside the
  -- recipe argument: a bus of furnace recipes on an assembler is legal-looking data that idles every
  -- machine on it (`status=no_recipe`, measured), and a lane whose chest cannot receive what a recipe
  -- drinks is the same mistake one level down. Both are named here rather than discovered on the ground.
  local bus_list = nil
  if args.bus ~= nil then
    local runs = {}
    for _, cat in ipairs((fp and fp.crafting_categories) or {}) do runs[cat] = true end
    local has_categories = next(runs) ~= nil
    bus_list, bus_problems, bus_want, explicit = {}, {}, {}, false
    for _, r in ipairs(args.bus) do
      local name = type(r) == "table" and (r.recipe or r.name) or r
      -- how many machines this entry asks for. The mix of a rotating group can only be asked for in
      -- whole machines -- every machine on bus position j gets recipe j, so 2:1 is two machines and one
      -- -- and a fractional share is a question about a mechanism (`random`'s weighting by count) that
      -- has not been measured, so it is refused here rather than rounded into an answer.
      local want = 1
      if type(r) == "table" and r.machines ~= nil then explicit = true end
      if type(r) == "table" then
        if r.machines ~= nil and not tonumber(r.machines) then
          bus_problems[#bus_problems + 1] = { recipe = tostring(name), why = "MACHINES_NOT_A_COUNT",
            asked_for = r.machines }
        elseif r.machines ~= nil then
          want = math.floor(tonumber(r.machines))
          if want < 1 then
            bus_problems[#bus_problems + 1] = { recipe = tostring(name), why = "MACHINES_BELOW_ONE",
              asked_for = r.machines }
          end
        end
      end
      local rec = name and db.recipes[name]
      if not rec then
        bus_problems[#bus_problems + 1] = { recipe = tostring(name), why = "UNKNOWN_RECIPE" }
      else
        local bad = nil
        if has_categories and rec.category and not runs[rec.category] then
          bad = "CATEGORY_NOT_RUNNABLE"
        end
        for _, i in ipairs(rec.ingredients or {}) do
          if i.type == "fluid" then bad = "LANE_CARRIES_NO_FLUIDS" end
        end
        for _, pr in ipairs(rec.products or {}) do
          if pr and pr.type == "fluid" then bad = "LANE_CARRIES_NO_FLUIDS" end
        end
        if bad then
          bus_problems[#bus_problems + 1] = { recipe = name, why = bad, category = rec.category }
        else
          if not bus_want[name] then bus_list[#bus_list + 1] = name end
          bus_want[name] = (bus_want[name] or 0) + want
        end
      end
    end
    if #bus_problems > 0 then
      return fail_key("BUS_NOT_RUNNABLE", "m-bus-not-runnable",
        { tostring(bus_problems[1].recipe), tostring(bus_problems[1].why), tostring(#bus_problems),
          tostring(furnace) },
        "a machine on this lane cannot cover " .. tostring(bus_problems[1].recipe)
          .. " (" .. tostring(bus_problems[1].why) .. ")",
        { problems = bus_problems, asked_for = args.bus, machine = furnace,
          categories = has_categories and (fp and fp.crafting_categories) or nil })
    end
    if #bus_list == 0 then
      return fail_key("BUS_EMPTY", "m-bus-empty", nil,
        "bus = {} covers nothing; leave it off to lay a plain lane", { asked_for = args.bus })
    end
  end
  if bus_list and not takes_recipe(furnace) then
    return fail_key("BUS_MACHINE_NOT_SETTABLE", "m-bus-machine-not-settable",
      { tostring(furnace) },
      "a bus needs machines that can be told their recipe, and " .. tostring(furnace)
        .. " has no recipe setter in this version",
      { machine = furnace, asked_for = args.bus, mode = bus_mode,
        why = "the controllers write a recipe signal and the machine has to take it; a furnace picks "
          .. "its recipe from what is in front of it, so the wire would go unread" })
  end
  -- Three ways a group of machines shares one list of things to build, and they answer different
  -- questions, so all three are named rather than guessed:
  --   `split`   machine i gets position i, so the group covers the list AT ONCE and a player can say
  --             which machine owes what. The bus is the caller's list, written by hand.
  --   `rotate`  every controller takes the same random pick on an interval, so the group covers the
  --             list OVER TIME and no machine is committed to one recipe.
  --   `shortage` the numbers on the wire are not the plan's at all: a box per candidate subtracts what
  --             the lane's own output chests hold from a target, and the controllers read the result
  --             most-short-first. "Which of these is the factory actually short of" is answered by the
  --             factory, while the mod is doing nothing. Measured on 2.0.77 in
  --             dev/circuit_rules_probe.js (acts O, P and R), including the case that makes this the
  --             only honest form of the question: an item nobody is holding yields the WHOLE target,
  --             so the empty shelf is the biggest number on the wire rather than the one signal the
  --             bus never gets.
  local bus_mode = args.bus_mode or "split"
  if bus_mode ~= "split" and bus_mode ~= "rotate" and bus_mode ~= "shortage" then
    return fail_key("UNKNOWN_BUS_MODE", "m-bus-mode-words", { tostring(args.bus_mode) },
      "bus_mode = " .. tostring(args.bus_mode) .. " is neither split, rotate nor shortage",
      { asked_for = args.bus_mode, known = { "split", "rotate", "shortage" } })
  end
  local bus_every = math.max(1, math.floor(tonumber(args.bus_every) or 20))
  -- How full a candidate's shelf has to get before the line stops being asked to make it. Only
  -- `shortage` uses it, and only the caller can say what "enough" is -- a minute of output, one
  -- accumulator's worth, the size of a train load are all different numbers and none of them is this
  -- file's guess -- so it is asked for by name rather than defaulted into a plan that looks decided.
  local bus_target = tonumber(args.bus_target)
  if bus_mode == "shortage" and not (bus_target and bus_target >= 1) then
    return fail_key("BUS_TARGET_NEEDED", "m-bus-target-needed",
      { tostring(args.bus_target or "nothing") },
      "a shortage bus subtracts the shelf from a target, and bus_target = "
        .. tostring(args.bus_target or "nothing") .. " is not a count to subtract from",
      { asked_for = args.bus_target,
        why = "the number on the wire is `target - what the chests hold`, so without a target there is "
          .. "nothing to subtract from and no ranking to sort; name one count (per minute x the minutes "
          .. "you want to cover is the usual way to get it)" })
  end
  bus_target = bus_target and math.floor(bus_target) or nil
  -- The boxes themselves, one per candidate: what to subtract (the ITEM the chests hold), what to write
  -- the answer under (the RECIPE the machines obey), and the target. An item signal and a recipe signal
  -- of the same name are two different signals, and subtracting is the only measured way to cross from
  -- one to the other -- a decider asked to copy emits nothing once the names differ
  -- (dev/circuit_rules_probe.js act P, and act N's eleven silent lanes).
  local bus_shortage = nil
  if bus_mode == "shortage" and bus_list then
    bus_shortage = {}
    for idx, r in ipairs(bus_list) do
      local rec = db.recipes[r]
      local item = nil
      for _, pr in ipairs((rec or {}).products or {}) do
        if pr.name and pr.type ~= "fluid" and not item then item = pr.name end
      end
      -- A candidate whose recipe has no item to weigh is not a shortage the chests can report: a
      -- fluid product never appears in the output chest this bus reads, so the box would subtract
      -- nothing from nothing and every machine would build it forever. Said here, in the one place that
      -- knows which candidate it was.
      if not item then
        return fail_key("BUS_CANDIDATE_NOT_SHELVED", "m-bus-candidate-not-shelved",
          { tostring(r) },
          "the shortage bus cannot weigh " .. tostring(r) .. " because that recipe makes no item for a chest",
          { recipe = r, asked_for = args.bus,
            why = "the deficiency is measured off what the output chests HOLD, and a fluid product is "
              .. "not in one -- the box would read the shelf as empty forever" })
      end
      bus_shortage[idx] = { item = item, recipe = r, target = bus_target }
    end
  end
  -- The machine-to-position map the controllers are laid from. A name listed once asks for one machine;
  -- `{recipe=..., machines=2}` asks for two on the same position, and `covered` is reported per recipe
  -- with its machine count so a caller can see the mix it asked for next to the rates it implies.
  --
  -- Positions past the end of the bus are given to the machines nobody claimed, which is not a made-up
  -- convention: act M measured that such a position emits nothing, so the machine holds no recipe and
  -- stands idle -- the honest shape of "this group is bigger than its list".
  local reach = inserter_reach(game.surfaces[1], ins, force.name)
  -- Lanes, not one lane: `machines` is the count a plan asked for and `spacing` is the gap between
  -- them. Both are reported back as the footprint they cost, because a number of machines you cannot
  -- fit anywhere is a wish, not a plan.
  local lanes = math.max(1, math.floor(tonumber(args.machines) or 1))
  -- 带子按"够用就好"挑。玩家的话是"传送带也要够用就好或者可以选"，两样都在这里：点名了（`belt`）就照
  -- 点名的来，不升级也不降级 —— 那是他的意见，不是这个函数的意见；没点名就从这一发放得下的最慢那一档
  -- 往上试，取第一条把这条线的进料和成品都装得下的。
  --
  -- 为什么默认不是最快的：最快那一档把带行数压到最小，形状看起来最省，代价是玩家得先有润滑剂才能把这张
  -- 蓝图落地 —— "放得下但你现在造不出"和"喂不齐料"是同一类错。省下来的行数不该由存档里最贵的那根带子付。
  --
  -- 一条都不够用时（连最快那档也叠不起这么多行）留的是最快那一档的数字，并且把"试过了哪几档"一起交出去：
  -- 这时候要说的是"这条线要 6 行，一面最多叠 2 行"，不是"黄带子不够快"。
  local belt_choice
  do
    local named = (type(args.belt) == "string" and args.belt ~= "") and args.belt or nil
    local cap = math.min(#(arm_reach_tiers(force.name, is_available) or {}), math.max(1, fh))
    local ladder = named and { named } or {}
    if not named then
      local rows = roles.ladder("belt", { available = is_available, order = "asc" }) or {}
      for _, e in ipairs(rows) do
        if e.name and e.unlocked ~= false and e.figure then ladder[#ladder + 1] = e.name end
      end
    end
    -- 挑带子发生在挑形状之前，所以这里只能按"最保守的那个形状"数成品行：一根成品带只有一个面朝它放货
    -- （单排）。点名了双排就用双排的 2 股。反过来（先按两股挑带子）会让单排的线挑到一根其实走不完的
    -- 慢带子，铺下来才发现产率被股数绑住。
    local named_shape = style_named(args)
    local d_per_line = (named_shape and (styles.get(named_shape) or {}).product_lanes_per_line) or 1
    -- 这一档形状会不会把成品站到进料行的空股上（`feed_row_share`，形状自己声明）。没点名形状时这里
    -- 按最保守那一档数成品行，而那一档正是会共用的单排 —— 所以它也照共用折。
    local share_shape = styles.get(named_shape or "stacked")
    local shape_shares = (share_shape and share_shape.feed_row_share) == true
    local tried, best = {}, nil
    for _, tier in ipairs(ladder) do
      local d = lane_demand(lanes, tier, d_per_line)
      if d then
        tried[#tried + 1] = tier
        best = { tier = tier, d = d }
        -- 共用成了就不必再为成品要一行地面：这里数的是"这一发真会铺几行"，不是"不共用的话要几行"
        local d_product_rows = (shape_shares and d.share and d.share.possible
          and #(d.share.product_lane_of or {}) > 0) and 0 or d.product_rows
        if d.feed_rows <= cap and d_product_rows <= cap then
          belt = tier
          belt_choice = { asked = named, chosen = tier, tried = tried, adequate = true,
            belt_stack_size_bonus = (tonumber(force.belt_stack_size_bonus) or 0),
            per_lane_min = d.per_lane, feed_rows = d.feed_rows, product_rows = d_product_rows,
            share = d.share,
            rows_per_face = cap }
          break
        end
      end
    end
    if not belt_choice and best then
      belt = best.tier
      belt_choice = { asked = named, chosen = best.tier, tried = tried, adequate = false,
        per_lane_min = best.d.per_lane, feed_rows = best.d.feed_rows,
        product_rows = (shape_shares and best.d.share and best.d.share.possible) and 0
          or best.d.product_rows, rows_per_face = cap }
    end
    if belt_choice then
      -- `components_how` is the plain-text channel every picker already writes in English ("best
      -- belt_speed desc (read from the prototype)"), so the belt's sentence is written here in the same
      -- voice rather than as a localised table: the window shows it as-is and the suites match it.
      how.belt = string.format(
        "%s by %s: %d feed + %d product rows needed against %d per face; tried slowest-up %s",
        tostring(belt_choice.chosen), named and "the caller" or "adequate (slowest that carries it)",
        belt_choice.feed_rows or 0, belt_choice.product_rows or 0, belt_choice.rows_per_face or 0,
        table.concat(belt_choice.tried or {}, " > "))
    end
  end
  local bus_at, bus_covered, used = nil, nil, 0
  if bus_list then
    bus_at, bus_covered = {}, {}
    for idx, r in ipairs(bus_list) do
      local n = (bus_want and bus_want[r]) or 1
      for _ = 1, n do
        if used < lanes then bus_at[#bus_at + 1] = idx - 1 end
      end
      used = used + n
      bus_covered[#bus_covered + 1] = { recipe = r, position = idx - 1, machines = n }
    end
    -- Two different situations, and only one of them is an error. Naming three candidates for two
    -- machines is a question -- "what fits?" -- and the answer is the two that fit plus the one that
    -- does not. Writing 2+1 machines under a lane of two is arithmetic the caller can see is wrong,
    -- and clamping it silently would build a lane that does not do what they typed.
    if used > lanes and not explicit then
      -- rebuilt from nothing: the loop above stopped handing out positions once the machines ran out,
      -- and appending to what it left behind would double the hands it already counted
      used, bus_at = 0, {}
      for idx, r in ipairs(bus_list) do
        for _ = 1, bus_want[r] do
          if used < lanes then bus_at[#bus_at + 1] = idx - 1 end
          used = used + 1
        end
      end
    elseif used > lanes then
      return fail_key("BUS_TOO_WIDE", "m-bus-too-wide",
        { tostring(used), tostring(lanes) },
        "this bus asks for " .. tostring(used) .. " machines and the lane has " .. tostring(lanes),
        { asked_machines = used, machines = lanes, bus = bus_list,
          why = "every machine on one bus position builds that recipe, so a mix is whole machines; "
            .. "raise machines or drop a count" })
    end
    for i = #bus_at + 1, lanes do bus_at[i] = #bus_list end
  end
  local gap = SPACING[args.spacing]
  if args.spacing and not gap then
    -- The refusal tells the caller it may name a number of cells, so a number has to be readable here.
    -- It used not to be: `spacing = 4` came back as this same UNKNOWN_SPACING, and every packer downstream
    -- (plan_fit, group_fit, box_here, card_lab) forwards the word untouched, so the one piece of advice the
    -- error gave was a second way to be refused.
    local cells = tonumber(args.spacing)
    -- A negative pitch is a mistake rather than a request for zero, so it stays a refusal: clamping it
    -- silently would answer a question the caller did not ask.
    if cells and cells >= 0 then gap = math.floor(cells) end
  end
  if args.spacing and not gap then
    local known = {}
    for k in pairs(SPACING) do known[#known + 1] = k end
    table.sort(known)
    return fail("UNKNOWN_SPACING", "spacing = " .. table.concat(known, ", ") .. " (or a number of cells)",
      { asked_for = args.spacing, known = known })
  end
  gap = gap or 0
  -- Which shape, and which way it faces. Both are the player's call rather than this file's: the shape
  -- decides how many belts and arms a lane costs, and the axis decides whether it fits the box they
  -- drew. The default is the one shape this mod has always built and the horizontal axis it built it on,
  -- so a caller that names neither gets exactly the answer it got before either option existed.
  -- The parts a bus is built out of, and which ones depend on the mode: every mode needs a selector to
  -- hand one position of the bus to one machine; `split`/`rotate` need a decider to STAND IN for the
  -- factory (the emitter carries the caller's list as constants); and `shortage` needs the opposite --
  -- an arithmetic box per candidate, because a number that comes off a shelf has to be SUBTRACTED
  -- somewhere, and a decider cannot put an item's count under a recipe's name at all
  -- (dev/circuit_rules_probe.js act P). The emitter is not laid in shortage mode: the chests are the
  -- source, so a card that laid both would have two things writing the same signal. All of it goes
  -- through the same `pick` as every other part, so a save where the vanilla combinator does not exist
  -- gets this install's best candidate and says which it chose (`how.selector` / `how.emitter` /
  -- `how.arithmetic`).
  local selector, emitter, arithmetic
  if bus_list then
    selector = pick("selector", args.selector)
    if bus_mode == "shortage" then
      arithmetic = pick("arithmetic", args.arithmetic)
    else
      emitter = pick("emitter", args.emitter)
    end
    local miss = nil
    if not selector then
      miss = "selector (a selector combinator)"
    elseif bus_mode == "shortage" and not arithmetic then
      miss = "arithmetic (an arithmetic combinator)"
    elseif bus_mode ~= "shortage" and not emitter then
      miss = "emitter (a decider combinator)"
    end
    if miss then
      -- 这句要能自查：哪一个候选、它的放置件叫什么、那一件的配方在不在/开没开、是哪几个科技开的、
      -- 我们的检查器最后答的是什么。从前只带一个 `how` 里的"nothing in it is unlocked" —— 那既可能是
      -- 事实，也可能是我们自己的读数错。
      local which = miss:find("^selector") and "selector" or (miss:find("^arithmetic") and "arithmetic"
        or "emitter")
      local probe = part_probe(force, roles.names(which))
      return fail_key("NO_AVAILABLE_PART", "m-bus-no-hardware", { miss },
        "this lane wants a bus and this save has no placeable " .. miss .. part_missing_said(probe),
        { wanted = { selector = args.selector, emitter = args.emitter, arithmetic = args.arithmetic },
          picks = how, mode = bus_mode, candidates = probe,
          why = bus_mode == "shortage"
            and "a shortage bus needs one arithmetic box per candidate (target minus the shelf) and one "
              .. "selector per machine; no decider, because the chests already say what they hold"
            or "a bus needs one of each: the decider carries the candidate list, the selector hands "
              .. "one position of it to one machine" })
    end
  end

  -- The door into the shape. A named style is used; `heads = "belt"` starts from the ladder WITH the
  -- chest-free flag set, because a bare head rules out every shape whose head IS a box, and the one shape
  -- that answers a bare head with zero boxes has to be tried before the ones that pay a box per machine;
  -- and everything else starts where it always did, on the smelting lane, and is redrawn below only if that
  -- shape turns out to leave a material nowhere to arrive.
  local style = styles.get(style_named(args)
    or shape_ladder(lanes, #feed_items, true, #fluid_ins)[1])
  if not style then
    local known = styles.ids()
    return fail_key("UNKNOWN_STYLE", "m-style-words", { table.concat(known, ", ") },
      "style = " .. table.concat(known, ", "), { asked_for = style_named(args), known = known })
  end
  -- 带箱子的线头随那四种排法一起没了：现在没有任何形状会画"从一只箱子起步"的那一行，所以这一格不是
  -- "换个形状画"的问题，而是这件事整个不做了。按名拒，而不是悄悄当成裸带 —— 一个被忽略的参数比一个
  -- 报错的参数难查得多。
  if heads == "chest" then
    return fail_key("CHEST_HEAD_REMOVED", "m-chest-head-removed", { table.concat(styles.ids(), ", ") },
      "the chest head went out with the four chest-bearing layouts; every line starts on bare belt now ("
        .. table.concat(styles.ids(), ", ") .. ")",
      { heads = heads, need = table.concat(styles.ids(), ", ") })
  end
  -- 牌是说明，不是结构。这一发放不出面板或发射器时，线照铺，但要说清"这块牌没放上去、为什么"：
  -- 一条读不出股道的裸带线仍然在生产，而一个"因为没研究电路就不给你铺任何线"的模，是把一件文档的
  -- 缺失升级成了整条链的拒绝。反过来，调用方**点名**要某一格牌而这一发放不出来，那是它要的东西没到手，
  -- 按名拒 —— 点名过的东西被悄悄省掉，比不点名时省掉难得查得多。
  local sign_missing = nil
  if heads == "belt" and not (sign_panel and sign_emitter) then
    if args.panel or args.emitter then
      return fail_key("HEAD_SIGN_UNAVAILABLE", "m-head-sign-unavailable", nil,
        "a belt head is read off its sign, and this install can place no display panel or no emitter box",
        { panel = sign_panel or "none", emitter = sign_emitter or "none",
          wanted = { panel = args.panel, emitter = args.emitter }, picks = how })
    end
    sign_missing = string.format("%s%s",
      (not sign_panel) and "display-panel" or "",
      (not sign_panel and not sign_emitter) and " + emitter box" or ((not sign_emitter) and "emitter box" or ""))
    how.panel = sign_missing .. " is not placeable by this force, so the line is laid without its signs"
  end
  if (style.min_units or 1) > lanes then    -- Named rather than rounded up or down: a two-row style handed three machines has to say it lays
    -- four-and-three or refuses, and silently building one row of a shape that promises two is the
    -- kind of answer that looks fine in a footprint number.
    return fail_key("STYLE_NEEDS_UNITS", "m-style-needs-pair",
      { style.id, tostring(style.min_units), tostring(lanes) },
      string.format("%s lays rows of at least %d machines; this plan counted %d",
        style.id, style.min_units, lanes),
      { style = style.id, min_units = style.min_units, asked_for = lanes })
  end
  local turns = ORIENTATION[args.orientation]
  if args.orientation and not turns then
    local known = {}
    for k in pairs(ORIENTATION) do known[#known + 1] = k end
    table.sort(known)
    return fail_key("UNKNOWN_ORIENTATION", "m-orientation-words", { table.concat(known, ", ") },
      "orientation = " .. table.concat(known, ", "), { asked_for = args.orientation, known = known })
  end
  turns = turns or 0
  if turns ~= 0 and style.turnable == false then
    -- 为什么不能转，形状自己说（它比这一句通用的话多知道一件事：这一档是为"有东西要喝"才存在的）。
    local because = style.no_turn_because
    return fail_key("STYLE_NOT_TURNABLE", "m-style-no-turn", { style.id },
      "this style cannot be turned; lay it horizontally or pick a style that can"
        .. (because and (" (" .. because .. ")") or ""),
      { style = style.id, because = because })
  end
  -- How big a part actually is, asked of the prototype rather than remembered: a steel chest is one
  -- tile on this build and three on the furnace, and both the turn and the footprint measure need the
  -- same answer.
  local function part_size(n)
    local p = prototypes.entity[n]
    return (p and p.tile_width) or 1, (p and p.tile_height) or 1
  end
  -- What the recipe drinks and what it gives off as fluid, decided about before any geometry: these two
  -- refusals need neither the machine nor the shape, and saying them here keeps a lane from being drawn at
  -- all when it could not be fed. Everything that DOES need the shape -- which face the box will really
  -- present once the entity is built, whether the finished row leaves that face's cells free, and the pipe
  -- to lay with -- waits below the turn, where the shape is known.
  local fluid_feed, pipe_name
  if #fluid_ins > 0 or #fluid_outs > 0 then
    if #fluid_outs > 0 then
      -- A product that is a fluid needs the same row of pipe run the other way, and nothing lays that yet.
      return fail_key("LANE_CARRIES_NO_FLUIDS", "m-lane-no-fluid",
        { tostring(recipe_name), tostring(fluid_outs[1]) },
        tostring(recipe_name) .. " gives off " .. tostring(fluid_outs[1])
          .. ", and a drain row is not a shape this mod lays yet",
        { recipe = recipe_name, fluid = fluid_outs[1], kind = "out",
          products = fluid_outs,
          why = "the feed row takes a fluid in; taking one out needs the same geometry plus a way to "
            .. "count what left" })
    end
    if #fluid_ins > 1 then
      -- Two ingredients on two cells of one face, close enough to touch, are one network and a mixture --
      -- which is the exact problem the lab's discovery pass exists for, and a lane is not where it gets
      -- solved by guesswork.
      local one_fluid = tostring(recipe_name) .. " drinks " .. tostring(#fluid_ins)
        .. " fluids (" .. table.concat(fluid_ins, ", ") .. "); a lane feeds one fluid down one row,"
        .. " and two rows that touch are one network"
      return fail_key("LANE_FEEDS_ONE_FLUID", "m-lane-one-fluid",
        { tostring(recipe_name), tostring(#fluid_ins), table.concat(fluid_ins, ", ") },
        one_fluid,
        { recipe = recipe_name, fluids = fluid_ins,
          why = "two feeds need two rows that never touch, and an adjacent pair of pipes is one network" })
    end
    -- Everything else about the feed -- which face the box will really present, whether the finished shape
    -- leaves that face's cells free, and the pipe to lay with -- needs a shape, and waits for one below.
    pipe_name = pick("pipe", args.pipe)
    if not pipe_name then
      -- The same sentence every unplaceable part gets, because one key is one sentence: which part it was
      -- this time is said in the detail, where `picks` already carries the whole ladder of how each role
      -- was chosen.
      return fail_key("NO_AVAILABLE_PART", "m-no-placeable-part", { "pipe" },
        "no placeable candidate for one of the card's roles: pipe",
        { wanted = args.pipe, picks = how, role = "pipe",
          why = "a lane that drinks needs a placeable pipe for its feed row" })
    end
  end
  local arm_needs
  -- 形状是偏好，不是许可（§2.4）。裸带线头先试零箱子那一档；它铺不出来时（缺够得着那一行的臂、带的
  -- 行数超过一个面叠得起的上限、带子模型没有那一档运力），落回阶梯里下一个也接得住裸带线头的形状 ——
  -- 但只接受"确实不缺料"的那一张：`#unfed == 0`。否则就照原样按名拒。
  --
  -- 这条限制是被玩家那句话钉住的："可选排列样式的前提是要先满足产线能正常生产"。悄悄换成一条喂不齐料
  -- 的线，比拒一次更难看；而换成功了一张喂得齐的线，必须把"从哪档搬到哪档、为什么"写进答案，让人复查。
  local function fall_back(code, why)
    if style_named(args) or args.shape_tried or heads ~= "belt" then return nil end
    for _, want in ipairs(shape_ladder(lanes, #feed_items, true, #fluid_ins)) do
      if want ~= style.id then
        local again = {}
        for k, v in pairs(args) do again[k] = v end
        again.style, again.shape_tried = want, true
        local moved = M.card_example(again)
        if moved and not moved.fail and #(moved.unfed or {}) == 0 then
          moved.style_overridden = { asked = style.id, used = moved.style, code = code,
            because = string.format("%s 铺不出来（%s），落回 %s：这张料齐，两种排法都不带箱子",
              tostring(style.id), tostring(why), tostring(moved.style)) }
          return moved
        end
      end
    end
    return nil
  end
  -- 参数化那一档形状：带子数量在这里由流量算出来，每档臂单独点名。缺哪一档臂、或者需要的带行数超过一个
  -- 面叠得起的上限，都在铺之前就按名拒 —— 铺一条喂不到的带子，玩家看到的是"能放下但不生产"，那正是
  -- 这个项目被指过很多轮的那类错。
  local stack, arms_by_reach, stack_demand
  if style.parametric then
    -- "这条线要几行"归形状自己答：单排问的是"一个面装得下几行"，双排问的是"半台数在这一面装不装得下"
    -- （见 styles.lua 里各自的 `demand`）。调用方只负责把"某台数在某档带子上的流量"这个函数交给它。
    local lanes_per_line = style.product_lanes_per_line or 2
    local function demand_of(machines) return lane_demand(machines, nil, lanes_per_line) end
    -- 没有 `demand` 的形状（单排：一个面就是它的全部）直接问自己这一档：`lane_demand` 也必须拿到
    -- 这根线能被几个面装满，不然它按两股除，40 台石炉那条 750/分的线就被算成"一条带够用"。
    stack_demand = (style.demand and style.demand(lanes, demand_of))
      or lane_demand(lanes, nil, lanes_per_line)
    if not stack_demand then
      local moved = fall_back("BELT_CAPACITY_UNKNOWN", "带子模型里查不到这条带的运力")
      if moved then return moved end
      return fail_key("BELT_CAPACITY_UNKNOWN", "m-belt-unknown", { tostring(belt) },
        "this shape sizes its belts from throughput, and the belt model has no figure for "
          .. tostring(belt) .. " on this install", { belt = belt, machines = lanes })
    end
    local tiers = arm_reach_tiers(force.name, is_available)
    local cap = math.min(#tiers, math.max(1, fh))
    -- 判定（`possible`：一股装不装得下、有没有空股）与"这一发真把成品铺到进料行的空股上"（`laid`）
    -- 是两回事，后者由形状声明 —— `feed_row_share` 那一档把成品臂站到进料臂那一行、落到离机器远的
    -- 那一股。折了这一格，成品不再要自己的一行地面，下面那些上限检查与 `stack` 都按这一份数。
    local share = stack_demand.share or {}
    share.laid = (share.possible == true and style.feed_row_share == true
      and #(share.product_lane_of or {}) > 0)
    local product_rows = share.laid and 0 or stack_demand.product_rows
    -- 料那一侧的上限有两种，给的下一步正好相反，所以先分清是哪一种（这一句从前两种都说成"切线"，
    -- 而切线对其中一种是假建议）：
    --   `feed_count` 光是"这个配方吃几种料"就把行数顶过去了：每种料至少占一股，一条带两股，于是
    --     `ceil(种数 / 2)` 是**任何一条线**都躲不掉的下限 —— 切出来的每条线仍然要吃齐这几种料，而换更快
    --     的带子只改"每种料要几股"，改不了"至少一股"。能解决它的只有"一个面叠更多条带"，那要更多互不
    --     相同的臂 reach 档（香草只有 1/2），或者一个把进料分到机器两面的形状（今天没有那种形状）。
    --   `feed_flow` 是种数装得下、流量把某一种顶到两股以上 —— 这时切线换带子都真的解决。
    -- 双排的 `demand` 回的是按侧摊平的那两份（`feed_flat_a/b`），料种数看哪一侧都一样（两排跑同一个配方），
    -- 所以那份清单在 styles 里续上；没续上（老调用方）就回到线自己的料单，两者都是"吃几种料"这一个数。
    local mats = #(stack_demand.feed_split or {})
    if mats == 0 then mats = #(feed_items or {}) end
    local feed_floor = mats > 0 and math.ceil(mats / 2) or 1
    local blocked_by = nil
    if stack_demand.feed_rows > cap then
      blocked_by = (feed_floor > cap) and "feed_count" or "feed_flow"
    elseif product_rows > cap then
      blocked_by = "product_flow"
    end
    if stack_demand.feed_rows > cap or product_rows > cap then
      -- "换更快的带子"这句不能对每一发都说。带子是**先**按"够用就好"从慢到快挑过一遍的（见上面那一串
      -- `belt_choice.tried`）：如果那一遍已经试到最快一档还是叠不起，再叫玩家换带子就是让他重跑一遍
      -- 我们已经跑过的那一步 —— 说出来的得是它试过的档位，而不是一句此刻做不到的建议。
      local tried_txt = table.concat((belt_choice or {}).tried or {}, " > ")
      local belt_said, tail
      if (belt_choice or {}).asked then
        belt_said = string.format("点名的带子是 %s", tostring((belt_choice or {}).chosen))
        tail = " —— 换形状也没用，只能把计划切成几条线，或者换更快的带子"
      elseif (belt_choice or {}).adequate == false then
        belt_said = string.format("带子已经按 %s 从慢到快试过一遍，最快那一档也要 %d 条成品带",
          tried_txt, (belt_choice or {}).product_rows or product_rows)
        tail = " —— 换形状、换带子都没用，只能把计划切成几条线"
      else
        belt_said = ""
        tail = " —— 换形状也没用，只能把计划切成几条线，或者换更快的带子"
      end
      local why = string.format("这条线要 %d 条进料带和 %d 条成品带，一个面最多叠 %d 条（臂档 %s，机器深 %d）",
        stack_demand.feed_rows, product_rows, cap, table.concat(tiers, "/"), fh)
      if belt_said ~= "" then why = why .. "；" .. belt_said end
      if blocked_by == "feed_count" then
        -- 三种排法共用同一条"一个面叠几条"的律（差别只在成品那一侧能被几个面装满），所以阶梯不必再走：
        -- 走完只会给出三句同样的话，还把每一档都重铺一遍。这里一次拒净，并且把**能解决它的那两件事**点名。
        local need = {}
        for r = (tiers[#tiers] or 0) + 1, stack_demand.feed_rows do need[#need + 1] = r end
        return fail_key("LINES_BEYOND_SHAPE", "m-lines-beyond-shape-count",
          { tostring(mats), tostring(feed_floor), tostring(cap), table.concat(tiers, "/"),
            tostring(stack_demand.feed_rows), fh and tostring(fh) or "?" },
          why .. string.format(
            "；而这 %d 条进料带是**料种数**要的（%d 种料，一种至少一股，一条带两股）：切成几条线都不解决"
              .. "（每条线都要吃齐这 %d 种），换更快的带子也不解决（带子只改每种要几股）。要解决得让一个面"
              .. "叠得起 %d 条，也就是这一档臂以外还要 reach %s 的臂能放（现在只有 %s），或者一个把进料分到"
              .. "机器两面的形状（今天没铺那种形状）",
            stack_demand.feed_rows, mats, mats, feed_floor,
            table.concat(need, "/"), table.concat(tiers, "/")),
          { feed_rows = stack_demand.feed_rows, product_rows = product_rows,
            rows_per_face = cap, arm_reach_tiers = tiers, machine_height = fh,
            materials = mats, feed_rows_floor = feed_floor, blocked_by = "feed_count",
            tiers_needed = stack_demand.feed_rows, arm_reach_missing = need,
            splitting_helps = false, faster_belt_helps = false,
            lanes_wanted = stack_demand.feed_lanes, product_lanes = stack_demand.product_lanes,
            feed_split = stack_demand.feed_split,
            belts_tried = (belt_choice or {}).tried, belt_asked = (belt_choice or {}).asked,
            belt_adequate = (belt_choice or {}).adequate })
      end
      local moved = fall_back("LINES_BEYOND_SHAPE", why)
      if moved then return moved end
      return fail_key("LINES_BEYOND_SHAPE", "m-lines-beyond-shape",
        { tostring(stack_demand.feed_rows), tostring(product_rows), tostring(cap) },
        why .. tail,
        { feed_rows = stack_demand.feed_rows, product_rows = product_rows,
          rows_per_face = cap, arm_reach_tiers = tiers, machine_height = fh,
          materials = mats, feed_rows_floor = feed_floor, blocked_by = blocked_by,
          splitting_helps = blocked_by ~= "feed_count",
          faster_belt_helps = blocked_by ~= "feed_count",
          lanes_wanted = stack_demand.feed_lanes, product_lanes = stack_demand.product_lanes,
          belts_tried = (belt_choice or {}).tried, belt_asked = (belt_choice or {}).asked,
          belt_adequate = (belt_choice or {}).adequate })
    end
    stack = { feed_rows = stack_demand.feed_rows, product_rows = product_rows,
      -- 共用那股的那套行号（`lane_demand` 排好的那一份）跟着形状走：形状、两块牌、台架都读它。
      share = share,
      -- 双排要知道自己那两排各站几台；单排没有这一格，形状自己不看它。
      split = stack_demand.split,
      -- 双排的两块牌各写自己那一面的股道（哪一面的第几股是哪种料），所以按侧摊平的清单要跟着形状走。
      -- 这里只搬不摊：摊法是"一块牌管一面"这个几何决定的，归形状。
      feed_flat_a = stack_demand.feed_flat_a, feed_flat_b = stack_demand.feed_flat_b,
      product_flat_a = stack_demand.product_flat_a, product_flat_b = stack_demand.product_flat_b }
    arms_by_reach, arm_needs = {}, {}
    -- 要几档臂归形状说：`stacked` 两面各自数（max(F,P)），而"水在背面"那一档两面共用一行臂、成品带排在
    -- 里、进料带排在外，第 k 条进料带要的是 reach P+k 那一档 —— 所以它要的是 F+P 档。这里再 max(F,P) 一次
    -- 就会少要一档，然后铺出一条"够得着成品带、够不着进料带"的线。
    local tier_count = (style.tier_rows and style.tier_rows(stack))
      or math.max(stack.feed_rows, stack.product_rows)
    -- 点名的臂：reach 正好等于某一档需要的长度时就用它，其余各档取梯子里那一长度的臂，并且把为什么
    -- 没用上点名的那只写进答案。这一圈从前直接问梯子（"够用就好"永远落在高速机械臂那一档），于是
    -- 点名 `inserter` 的那一发，`components.inserter` 与 `arm_choice` 都写着 inserter，实体表里铺的却是
    -- fast-inserter —— 一句"用的就是你点的那只"配一份别人的臂。
    -- 反过来硬用点名的那只也不行：机械臂的取货格在**正好 reach 那一格**（实测点名 long-handed 铺到要
    -- reach 1 的那一档，引擎量到 ARM_PICKS_NOTHING / ARM_DROPS_ON_GROUND —— 长一格的臂越过带子，
    -- 放货那一格又落在机器之外的地上）。
    local named_arm, named_reach, named_reason = nil, nil, nil
    if type(args.inserter) == "string" and args.inserter ~= "" then
      local got, got_meta = roles.pick("arm", { prefer = args.inserter, available = is_available })
      if got == args.inserter then
        named_arm = args.inserter
        named_reach = math.floor(inserter_reach(game.surfaces[1], args.inserter, force.name) or 1)
      else
        named_reason = (got_meta and got_meta.requested_reason) or "it is not an arm this force can place"
      end
    end
    local measure = function(n) return inserter_reach(game.surfaces[1], n, force.name) end
    for d = 1, tier_count do
      local nm, meta
      if named_arm and named_reach == d then
        nm, meta = named_arm, { arm = named_arm, reach = d, named = true,
          how = "the arm you named reaches exactly this row" }
      else
        nm, meta = arm_ladder_for_need(force, is_available, d, measure)
        if nm then
          meta = meta or {}
          if named_arm then
            meta.how = string.format("%s (your %s reaches %d, this row needs exactly %d -- an arm that "
              .. "reaches further picks past the belt and drops behind itself)",
              tostring(meta.how or "the ladder's arm for this reach"), named_arm,
              named_reach or -1, d)
          else
            meta.how = string.format("asked for %s (%s); %s", tostring(args.inserter),
              named_reason or "not placeable here",
              tostring(meta.how or "the ladder's arm for this reach"))
          end
        end
      end
      if not nm then
        local why = string.format("第 %d 条带要一只 reach %d 的臂，这个存档里没有能放的", d, d)
        local moved = fall_back("ARM_TIER_MISSING", why)
        if moved then return moved end
        return fail_key("ARM_TIER_MISSING", "m-arm-tier", { tostring(d) },
          string.format("这条线的第 %d 条带要一只 reach %d 的臂，而这个存档里没有能放的："
            .. "带子铺得出、料进不去，所以先不铺", d, d),
          { need_reach = d, tiers = tiers, ladder = meta and meta.ladder or nil })
      end
      arms_by_reach[d] = nm
      -- 逐档说清"这一行铺的是哪只臂、为什么是它"。臂这件事在一张卡上可以有三个说法：`components.inserter`
      -- （挑到的那一只）、`arm_choice`（按形状最小需要挑的那一次）、和实体表里真铺的这批 —— 参数化的形状
      -- 每档可以不同（第 1 根带要 reach 1、第 2 根要 reach 2），所以第三个说法必须有地方写，不然前两个
      -- 就是全部真相，而它们俩都对不过地上。
      arm_needs[d] = { tier = d, arm = nm, reach = meta and meta.reach, how = meta and meta.how }
    end
  end
  -- 一种料占几股，由它自己的流量除上一股的运力决定，可能不止一股。把"一种料 = 一股"写上牌是这个台架
  -- 量出来的错：40 台石炉这一条线要吃 750 个铁矿/分，而一股只走 450，牌上却只写了一道"iron-ore 在第 1
  -- 股" —— 实测 150.8/分、40 台里 12 台饿着。所以按 `feed_split` 把每种料摊成它需要的那几道，
  -- 台架和玩家接总线都照这份逐股清单来。料一种都没多，只是它现在有它该占的全部股道。
  local function spread(split, fallback)
    local out = {}
    for _, k in ipairs(split or {}) do
      for _ = 1, math.max(1, k.lanes or 1) do out[#out + 1] = k.item end
    end
    if #out == 0 then return fallback end
    return out
  end
  local specs, style_why = style.units({ ox = 0, oy = 0, count = lanes, machine = furnace, belt = belt,
    arm = ins, chest = chest, fw = fw, fh = fh, power = nil, reach = reach, outlets = args.outlets,
    -- Every item the recipe eats, and the shape decides what it can bring: a shared row takes two (one
    -- per lane), the two-feed shape takes four (two on each of its two lines), and a material neither can
    -- bring stays out and is named in `unfed` -- which is the answer admitting the lane is short, rather
    -- than drawing a chest it will never fill.
    feeds = style.shared_row and spread(stack_demand and stack_demand.feed_split, feed_items) or nil,
    gap = gap, bus = bus_list, selector = selector, emitter = emitter, arithmetic = arithmetic,
    stack = stack, arms_by_reach = arms_by_reach,
    -- 牌上要写"哪条带子的哪一边装哪种料"，产物那一侧也要在列 —— 从前只有料上牌。产物和料同一套摊法：
    -- 一个产物要几股就写几道，不然一块牌只写一道，玩家照牌接总线时那一股先满。
    products = style.parametric and spread(stack_demand and stack_demand.product_split, (function()
      local seen, list = {}, {}
      for _, pr in ipairs(recipe.products or {}) do
        if (pr.type or "item") ~= "fluid" and pr.name and not seen[pr.name] then
          seen[pr.name] = true list[#list + 1] = pr.name
        end
      end
      return list
    end)()) or nil,
    heads = heads, panel = sign_panel, sign_emitter = sign_emitter,
    bus_mode = bus_mode, bus_every = bus_every, bus_at = bus_at, bus_shortage = bus_shortage })
  if not specs then
    -- The style said which number it could not lay with; say it back rather than laying half a shape --
    -- and only after the ladder's next bare-head shape has been asked, with the same rule as above: an
    -- alternative is taken when it feeds every material, and the answer says which shape it moved to.
    local moved = fall_back((style_why and style_why.why) or "STYLE_CANNOT_LAY",
      tostring((style_why or {}).why))
    if moved then return moved end
    return fail_key((style_why and style_why.why) or "STYLE_CANNOT_LAY", "m-style-no-lay",
      { tostring((style_why or {}).need_reach or (style_why or {}).F or "?") },
      "this shape cannot be laid here: " .. tostring((style_why or {}).why), style_why)
  end
  -- 总线那一圈落在**成形之后**的形状上（`S.fluid_feed` 立的先例：要知道哪一格还是空地，就得等形状铺完）。
  -- 它在旋转之前画，所以带子跟着整条线一起转 —— `wire_to`/`wire_from` 记的是件号，而 `S.turn` 按原序重建
  -- 件表，转完仍然指着同一台机器。零件缺了上头已经按名拒过（`NO_AVAILABLE_PART`），这里还能拒的只有
  -- "这张形状里没有机器"那一类自相矛盾。
  local band = nil
  if bus_list then
    local why
    band, why = styles.control_band(specs, { machine = furnace, selector = selector,
      emitter = emitter, arithmetic = arithmetic, bus = bus_list, bus_mode = bus_mode,
      bus_every = bus_every, bus_at = bus_at, bus_shortage = bus_shortage, size_of = part_size })
    if not band then
      return fail_key("BUS_RING_UNLAID", "m-bus-ring-unlaid",
        { tostring((why or {}).why), table.concat(bus_list, " ") },
        "this lane was asked for a bus and its controllers could not be laid on the shape ("
          .. tostring((why or {}).why) .. ")", { why = why, bus = bus_list, mode = bus_mode })
    end
  end
  if turns ~= 0 then
    -- Sizes come from the parts rather than from the style: a lane is turned as the rectangles its parts
    -- occupy. Non-square parts (a decider combinator is 1x2 along its facing) turn with it, because the
    -- two cells they claim follow the facing and the facing is rotated in the same step -- which is what
    -- makes a bare-head lane with signs on it still drawable standing up. A shape whose parts are truly
    -- direction-bound says so (`turnable = false` above) and is refused there, by name.
    specs = styles.turn(specs, turns, part_size)
  end
  -- The fluid feed, laid against the shape as it will be BUILT. Three engine answers go into it, and the
  -- third one is the reason this sits here rather than inside a style:
  --
  --   * which box the recipe drinks, and at which cell of the machine it enters -- `ports.lua`, from the
  --     prototype's own `pipe_connections`, cross-checked cell for cell against the slower witness in
  --     `boxes.lua` (fluid offered one pipe at a time, and the cell that let it disappear is the box);
  --   * whether the machine keeps the facing the card gives it -- measured on this ground, because 2.0 does
  --     not expose `rotatable` to a script and the answer is not uniform: a chemical plant, an oil
  --     refinery, a belt, an arm, a combinator and a drill all keep a facing, while an assembling machine,
  --     every furnace, a centrifuge and a lab come back north and ignore a written direction as well;
  --   * which cells of the finished shape are free ground -- and a feed row that has to cross an arm is
  --     refused with the arm named, rather than laid on top of it and left to the engine's disapproval.
  --
  -- The answer carries `how` as well, and that is not a formality: one vanilla recipe names its own box,
  -- and everywhere else the fluid-to-box matching is inferred from the order of boxes of a kind, which
  -- `ports.lua` calls the weak link in it.
  if fluid_ins[1] then
    local fluid = fluid_ins[1]
    local keeps = keeps_facing(lab_surface() or game.surfaces[1], furnace, force.name)
    local built_dir = DIR.north
    for _, s in ipairs(specs) do
      if s.name == furnace then
        built_dir = keeps and (s.dir or DIR.north) or DIR.north
        break
      end
    end
    local face, off, detail = ports.lookup(furnace, built_dir, fluid, "in", recipe_name)
    if not face then
      return fail_key("LANE_FEED_ROW_UNREACHABLE", "m-lane-feed-box",
        { tostring(furnace), tostring(fluid), tostring((detail or {}).code or "BOX_NOT_FOUND") },
        furnace .. " declares no box that takes " .. fluid .. " at the facing it will be built in ("
          .. tostring((detail or {}).code or "BOX_NOT_FOUND") .. ")",
        { machine = furnace, fluid = fluid, built_direction = built_dir, keeps_facing = keeps,
          style = style.id, detail = detail,
          facings = (function()
            local list = {}
            for _, d in ipairs({ DIR.north, DIR.east, DIR.south, DIR.west }) do
              local f, o = ports.lookup(furnace, d, fluid, "in", recipe_name)
              list[#list + 1] = { direction = d, face = f, off = o }
            end
            return list
          end)() })
    end
    if off ~= math.floor(off) then
      -- The box opens between two tiles, and a 1x1 pipe has one cell to stand on. Said rather than
      -- rounded: a pipe laid half a tile off the box is a pipe that connects to nothing.
      return fail_key("LANE_FEED_ROW_UNREACHABLE", "m-lane-feed-cell",
        { tostring(furnace), tostring(fluid), tostring(off) },
        furnace .. "'s " .. fluid .. " box opens between two tiles (offset " .. tostring(off)
          .. "), and a pipe stands on one cell",
        { machine = furnace, fluid = fluid, face = face, off = off, keeps_facing = keeps,
          why = "the box is between two cells, and a pipe can only be laid on one of them" })
    end
    fluid_feed = { fluid = fluid, face = face, off = off, box = detail.box, how = detail.how,
      volume = detail.volume, needs_temperature = detail.needs_temperature,
      built_direction = built_dir, keeps_facing = keeps }
    local port_at, why = styles.fluid_feed(specs, {
      machine = furnace, w = fw, h = fh, face = face, off = off,
      pipe = pipe_name, fluid = fluid, size_of = part_size })
  if not port_at then
    -- The reason in the sentence is said in the words a player has: which part is standing there, or
    -- that the boxes are on two different lines. The code stays in the detail for a caller that branches.
    local blocked = why or {}
    local phrase
    if blocked.why == "FEED_ROW_TAKEN" then
      phrase = tostring(blocked.taken_by or "something") .. " stands on cell "
        .. tostring((blocked.cell or {})[1]) .. "," .. tostring((blocked.cell or {})[2])
    elseif blocked.why == "FEED_CELL_TAKEN" then
      phrase = "the cell is taken by " .. tostring(blocked.taken_by or "something")
    elseif blocked.why == "FEED_SPAN_MULTIPLE_LINES" then
      phrase = "the boxes are on two lines: " .. tostring(blocked.first_line) .. " and "
        .. tostring(blocked.other_line)
    else
      phrase = tostring(blocked.why or "no row fits")
    end
    return fail_key("LANE_FEED_ROW_UNREACHABLE", "m-lane-feed-row",
      { tostring(furnace), tostring(fluid), tostring(face), tostring(style.id), phrase },
      furnace .. " drinks " .. fluid .. " on its " .. face .. " face, and the " .. style.id
        .. " shape has no single free line for the row: " .. phrase,
      { machine = furnace, fluid = fluid, face = face, off = off, style = style.id,
        built_direction = built_dir, keeps_facing = keeps, blocked = blocked })
  end
  end
  -- Poles, if this plan wants them as part of the shape rather than as a repair afterwards.
  --
  -- Off by default and opt-in by name, because a pole row is ground: it grows the footprint every
  -- "能否放下" answer is compared against, and silently growing it would redraw every box answer in the
  -- game for a player who asked for smelters. With `poles` set, the copper is laid HERE -- before the
  -- shape is slid to its origin, so a pole that dodges off the west edge is inside the box rather than
  -- outside the number -- and the plan the player reads already carries it.
  --
  -- The row is a lattice bent around what is standing there, not a heap at whichever edge a search
  -- started from; see `styles.pole_grid`. And it is arithmetic: nothing below claims a single one of
  -- these poles joined a network, because only the engine knows that.
  local power_grid
  if args.poles then
    local needles, occ = {}, {}
    local loads = 0
    for _, s in ipairs(specs) do
      local p = prototypes.entity[s.name]
      local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
      if host.is_grid_load(p) then
        loads = loads + 1
        needles[loads] = styles.pole_box(s.cell[1], s.cell[2], w, h)
      end
      for x = s.cell[1], s.cell[1] + w - 1 do
        for y = s.cell[2], s.cell[2] + h - 1 do occ[x .. "," .. y] = true end
      end
      -- The tile a BELT delivers into counts as standing ground too: a pole parked there places fine on
      -- the bench and comes back from `card_verify` as BELT_INTO_SOLID. Belts only -- every part in a shape
      -- carries a direction (a chest's is north, which is 0), so asking this of all of them marks the cell
      -- above every machine and box as taken and squeezes the lattice out of the aisles it is meant to use.
      -- `styles.product_lines` had exactly this bug and says so in its own header.
      if field(p, "type") == "transport-belt" then
        local exit = styles.belt_exit(s.cell[1], s.cell[2], s.dir)
        if exit then occ[exit[1] .. "," .. exit[2]] = true end
      end
    end
    if loads == 0 then
      -- A burner line needs no wiring, and saying so is better than laying a pole to prove the
      -- machinery works: the answer a player acts on is "nothing here draws grid power".
      power_grid = { ok = true, needed = 0, poles = 0, uncovered = 0, why = "no-grid-load" }
    else
      -- Where a pole's reach is measured. Not the player's starting surface: the probe stands at a
      -- fixed coordinate which is frequently ungenerated there, and ungenerated ground answers
      -- "nothing reaches anything" exactly like a surface with a real grid on it. The bench is what
      -- `card_verify` places on for the same reason, and the figure is a property of the pole, not of
      -- the ground, so measuring it anywhere that can host a network answers for every surface.
      local measure_surface = (args.surface and resolve_surface(args.surface)) or lab_surface() or game.surfaces[1]
      local pole_name, meta
      if args.pole then
        -- Named means named, exactly as in `plan_power`: escalating a player's chosen tier to a
        -- different one here would make the poles in the shape and the `poles_tried` of the power
        -- search two accounts of one decision.
        if roles.exists(args.pole) then
          pole_name, meta = args.pole, { how = "named" }
        else
          power_grid = { ok = false, needed = loads, poles = 0, uncovered = loads,
                         pole = args.pole, code = "UNKNOWN_POLE", known = roles.names("pole") }
        end
      else
        pole_name, meta = roles.pick("pole", {
          prefer = "small-electric-pole",
          available = is_available,
          measure_of = function(n)
            local f = verify.power_facts(measure_surface, force, n)
            return f and f.wire or nil
          end,
        })
      end
      how.pole = meta and meta.how or "none"
      local facts = (pole_name and verify.power_facts(measure_surface, force, pole_name)) or nil
      if not power_grid and not facts then
        -- Not a quiet skip. Every figure the lattice needs -- reach, and the wire distance that keeps
        -- the row one grid instead of nine islands -- is measured off a surface that can host a
        -- network, and this install cannot supply one for the pole in question.
        power_grid = { ok = false, needed = loads, poles = 0, uncovered = loads, pole = pole_name,
                       code = "CANNOT_MEASURE_POLE",
                       why = pole_name and "this pole cannot be measured on this surface"
                         or "no electric pole on this install can be placed by this force" }
      end
      if facts and facts.supply then
        local got = styles.pole_grid(needles, facts, function(x, y, w, h)
          for cx = x, x + w - 1 do
            for cy = y, y + h - 1 do
              if occ[cx .. "," .. cy] then return true end
            end
          end
          return false
        end, { max = args.max_poles })
        for _, c in ipairs(got.cells) do
          specs[#specs + 1] = { name = pole_name, cell = { c.x, c.y }, dir = 0, role = "pole" }
          for x = c.x, c.x + facts.w - 1 do
            for y = c.y, c.y + facts.h - 1 do occ[x .. "," .. y] = true end
          end
        end
        power_grid = { ok = true, needed = loads, poles = #got.cells, uncovered = #got.uncovered,
                       islands = got.islands, dark_at = got.dark_at,
                       pole = pole_name, step = got.step, drift = got.drift,
                       supply = facts.supply, wire = facts.wire, w = facts.w, h = facts.h,
                       how = meta and meta.how }
      end
    end
  end
  -- Whichever way it came out, the shape's first row and column are cell 0 -- see `styles.normalize`.
  -- A style that measures its spine outward from the middle (`sandwich-2` lays its upper half at y<0)
  -- otherwise hands the packer a real shape and a footprint two tiles short of it; the packer stacks
  -- lanes at that number and the engine answers BELT_INTO_SOLID on every row but the first.
  specs = styles.normalize(specs)
  local ents, wires = {}, {}
  for i, sp in ipairs(specs) do
    local pp = prototypes.entity[sp.name]
    local w, h = (pp and pp.tile_width) or 1, (pp and pp.tile_height) or 1
    ents[i] = {
      name = sp.name,
      position = styles.centre(sp.cell, w, h, sp.dir),
      direction = sp.dir,
      -- 一件零件在它自己那个形状里干什么，是卡的事实，不是生成器临时懂的东西：台架要靠它认出"第 d 根
      -- 进料带"，玩家要把料接到对的股上，也读的是同一套号。从前这里是 `_role`，一次生成之后就被抹掉，
      -- 于是交回来的那张卡说不清自己的带子是干什么的 —— 零箱子的线因此谁都量不了。
      role = sp.role,
      -- 第几行（进料与成品各自从 1 数起）。和 `role` 一起打在带子上，形状自己铺的时候就是这两格。
      line = sp.line,
      -- which material the style intends this chest to hold. A shared feed row has one chest per item,
      -- and an in-port that says "iron plate" for both of them is an in-port that under-feeds the line
      -- the moment somebody composes from it. Internal mark, dropped with the rest below.
      _feed_item = sp.item,
      -- 这只臂只认哪一种料（共用进料行那一档必须有，否则取货臂把对面那股上的成品抓回机器，而组装机
      -- 收不下非配方的料 —— 实测 insert 回 0，那只臂就卡在自己手里）。三条交付路都带得住这一项，
      -- 都是量出来的：活件与虚影 `set_filter(1, …)` 写得进也读得回，蓝图 record 要写成
      -- `filters = {{index = 1, name = …}}` + `items_to_filter`（`dev/arm_filter_probe.js`）。
      filter = sp.filter,
      -- 共用那一行的成品股：台架要靠它认出"这根进料行也要收成品"，收臂得带筛选才不吃掉料。
      product_lane = sp.product_lane, product_item = sp.product_item,
      -- what a port pipe stands for, read off the part the style laid. An internal mark like `_role`,
      -- dropped a few lines below: the fluid belongs to the ANSWER a player reads, and a card of somebody's
      -- lane should not have to carry a field only this generator understands.
      _fluid = sp.fluid,
      circuit = sp.circuit,
      -- 那块显示器的股道清单（`{item, lane, kind}` 一条一股，kind 是 feed 还是 product），
      -- 由 `styles.head_sign` 打在面板件上。
      -- 它是"牌上该写什么"的唯一一份事实，而写字那一步（`fill_sign`）发生在铺件的时候 —— 所以它必须
      -- 活到铺的时候，不能是生成器手里的一次性局部量。
      sign_lanes = sp.sign_lanes,
    }
    -- A part may say who it drives (`wire_to`) and who drives it (`wire_from`), by index in this same
    -- list -- which is stable because both `S.turn` and `S.normalize` rebuild the parts in order.
    -- Either end may name SEVERAL parts, because a bus is one network and not a pair: every candidate's
    -- box reads every output chest, and every controller reads every box, and a shape that could only
    -- name one endpoint would have to lay a private wire per pair and call it a bus.
    if sp.wire_to then ents[i]._wire_to = sp.wire_to end
    if sp.wire_from then ents[i]._wire_from = sp.wire_from end
  end
  if bus_list then
    -- Every machine on the bus is told to obey its wire -- and only machines that CAN be. Asking the
    -- role would have missed the point, because `lane_units` names its crafter `furnace` whether it
    -- smelts, assembles or refines; the question is answered by the type that owns the setter.
    for _, e in ipairs(ents) do
      if takes_recipe(e.name) and not e.circuit then
        e.circuit = { recipe_control = true }
      end
    end
  end
  -- The wire list, from whatever part said who it drives. This ran only `if bus_list` until a belt head
  -- came through: the panel is the one part of that lane a player READS, and it arrived standing next to
  -- its emitter with no wire between them -- the card linted, the ghost placed, and the screen had nothing
  -- to show. Naming your own wire is not a bus-only idea, and `endpoints` takes one index or a list.
  local function endpoints(v)
    if type(v) ~= "table" then return { v } end
    if next(v) == nil then return {} end
    return v
  end
  for i, e in ipairs(ents) do
    for _, to in ipairs(endpoints(e._wire_to)) do
      wires[#wires + 1] = { from = i, to = to, color = "green" }
    end
    for _, from in ipairs(endpoints(e._wire_from)) do
      wires[#wires + 1] = { from = from, to = i, color = "green" }
    end
  end
  for _, e in ipairs(ents) do e._wire_to, e._wire_from = nil, nil end
  -- What the head actually is, read back off the parts the shape laid -- not from what the caller asked
  -- for, which is how a belt head and a chest head cannot be reported the same way by accident. This reads
  -- `ents`, not the style's cells, because the two are not in one frame: the parts are shifted on their way
  -- into the entity list, and a `sign.join` in the style's coordinates is a cell the player cannot find on
  -- the ground. `lanes` is the sign's own list -- which material on which half-lane of which line.
  -- 一块牌读一次：按 role 找到那只发射器，把它**自己发的信号表**当作股道清单（发射器说什么就是什么），
  -- 再把站在它旁边的面板和"玩家自己的带子要接到的那一格"补上。头与尾共用这一个读法，所以两头不可能
  -- 各说一套 —— 而 `styles` 那边也是同一个函数画的两块牌。
  local function read_sign(role)
    local signs, lanes = {}, {}
    for i, e in ipairs(ents) do
      if e.role == role then
        -- `box` is the emitter; `panel` and `join` hang beside it. Named for what they are, because a
        -- sign with a field called `entity` at its top level reads like it is describing the panel.
        local one = { box = { entity = i, at = { e.position.x, e.position.y } }, lanes = {} }
        -- Read off the box's OWN signal list rather than off a field the style hung beside it: a list the
        -- layout carries that `styles.normalize` does not know about is dropped on its way into the card,
        -- and a head whose sign reports no lanes is exactly the quiet failure this whole file exists to
        -- refuse. What the emitter says it emits IS the lane list -- item, and the lane number on it.
        -- 方向（kind）不在信号清单里 —— 发射器那份只有"哪种料、第几号"，而牌上多一个箭头。
        -- 它取自**这块牌的角色**：头那块说的就是"这条线吃什么"、尾那块是"这条线吐什么"（形状本来就是
        -- 这么分的：`stacked` 的头铺 feeds、尾铺 products，`fluid-back` 的两块头各铺自己那一排的料）。
        -- 所以这里不另带一份字段 —— 带过的每一版都在说：牌与答案各记一半，迟早各说各话。
        local kind = role == "tail" and "product" or "feed"
        for _, sig in ipairs((e.circuit or {}).emitter or {}) do
          one.lanes[#one.lanes + 1] = { item = sig.name, lane = tonumber(sig.count), kind = kind }
        end
        signs[#signs + 1] = one
        for _, l in ipairs(one.lanes) do
          l.sign = #signs
          lanes[#lanes + 1] = l
        end
      elseif #signs > 0 and not signs[#signs].panel and e.name == sign_panel then
        -- The FIRST panel after the box, which is the one this sign's own row drew: with two signs on the
        -- card, "the last panel in the list" would hand the head the tail's picture.
        signs[#signs].panel = { entity = i, at = { e.position.x, e.position.y } }
      end
    end
    if #signs == 0 then return nil, nil end
    -- The tile the player's own belt has to reach: the nearest line tile to the sign, walked off the laid
    -- belts so a turned lane reads in whatever direction it was turned. Per sign, because a 双排 has two
    -- heads on opposite faces and one shared `join` would send half the readers to the wrong line.
    for _, one in ipairs(signs) do
      local best, bd = nil, nil
      for i, e in ipairs(ents) do
        local kind = (prototypes.entity[e.name] and field(prototypes.entity[e.name], "type")) or "?"
        if kind == "transport-belt" then
          local d = math.abs(e.position.x - one.box.at[1]) + math.abs(e.position.y - one.box.at[2])
          if not bd or d < bd then best, bd = { entity = i, at = { e.position.x, e.position.y } }, d end
        end
      end
      one.join = best
    end
    return signs[1], lanes, #signs > 1 and signs or nil
  end

  local head_row = { kind = heads }
  local tail_row = nil
  -- 牌没放上去时，答案里这一格要说：不是"这条线没有线头"，是"线头是裸带、但读不出股道，因为这一放
  -- 不出面板"。少了这一句，玩家只能自己发现地上少两块牌。
  if sign_missing then head_row.sign_missing = sign_missing end
  if heads == "belt" then
    local sign, lanes, more = read_sign("head")
    head_row.sign, head_row.lanes, head_row.signs = sign, lanes or {}, more
    -- The same list once more as one line of text, because the thing a player does at a bare head is read
    -- it in a report, not click through an array. Item names are the engine's, and the panel renders its
    -- own localised copies from `lanes`.
    if #(head_row.lanes or {}) > 0 then
      local said = {}
      for _, l in ipairs(head_row.lanes) do
        said[#said + 1] = tostring(l.item) .. " on lane " .. tostring(l.lane)
          .. (l.kind and (" " .. sign_mark(l.kind) .. " " .. tostring(l.kind)) or "")
      end
      head_row.manifest = table.concat(said, ", ")
    end
    -- 线尾那块：这条线吐出来的东西走哪一股。玩家要的是"头尾都放一块牌"，站在东头往回看就知道成品去哪。
    local tsign, tlanes = read_sign("tail")
    if tsign and tlanes and #tlanes > 0 then
      tail_row = { sign = tsign, lanes = tlanes }
      local said = {}
      for _, l in ipairs(tlanes) do
        said[#said + 1] = tostring(l.item) .. " on lane " .. tostring(l.lane)
          .. (l.kind and (" " .. sign_mark(l.kind) .. " " .. tostring(l.kind)) or "")
      end
      tail_row.manifest = table.concat(said, ", ")
    end
    -- Said on the card, because it is the one thing a reader of a bare head cannot see from its parts: the
    -- head has no chest to fill, so the bench has to hand its material to the line itself -- `card_lab`
    -- feeds each `feed_line`'s west end by half-lane and drains the product row at its east end. A card
    -- that names neither a port nor a lane is still refused by name (`CARD_NO_PORTS`), because measuring
    -- an unfeedable line would report a rate of zero as if it were a verdict.
    head_row.note = "the row starts as bare belt tails: the bench hands each feed line its material at the "
      .. "west end, one half-lane per material, and collects at the product row's east end; splice your own "
      .. "bus into the tile in sign.join to run it for real"
    -- 上一版（0.66.1）在这里写的是"2.0 撤了组合器/面板的全部脚本写入，所以字交不出去"。那句话**只对了一半**，
    -- 而错的方向是让玩家多打一遍字：它只试了旧字段名（`conditions`/`decider_conditions`/`output`/
    -- `constants`）和方法式调用的旧拼法。这一台构建上重新量（2.0.x，2026-10-08，27016）：
    --   * 方法式的那几个还在报错，但报的是**参数个数** —— `set_message(-1, {...})` / `set_condition(1, t)` /
    --     `set_output(1, t)` 一律 "Expected 2 arguments but 3 were given"，`add_condition(t)` 报 bad self；
    --   * 整表写这一条吃：活面板 `cb.messages = {...}` 与虚影同句都写得进也读得回（`fill_sign` 就数这个），
    --     组合器是 `cb.parameters = {conditions=,outputs=}`；
    --   * 蓝图 record 上面板那一格叫 `control_behavior.parameters`，`export_stack` 的 JSON 里带着字、
    --     `get_blueprint_entities` 也回显（0.66.1 那句"写入被接受但不回显"是只试 `decider_conditions`
    --     与旧键名 `connections` 时得到的）；连线在 2.0 的 record 上叫 `wires`，而它要的是字典不是数组
    --     （数组形式引擎直接拒："Value must be a dictionary in property tree at ROOT.wires"）。
    -- 还剩下的那一条真的量不到：虚影建成实体之后内容跟不跟过去 —— 那一步只有玩家点一次才算数。
    head_row.sign_content = {
      laid = true, writable = true,
      how = "the panel's own text is a whole-list write in 2.0 (`control_behavior.messages`; measured on a "
        .. "live panel AND on a ghost, and it reads back). `blueprint_specs` sends the same list as "
        .. "`control_behavior.parameters`, and `fill_sign` writes it onto the ghost the ground path lays. "
        .. "The method forms the docs list (`set_message`, `set_condition`) raise on arity on this build, "
        .. "which is what 0.66.1 mistook for 'the setters are gone'",
      still_unverified = "whether a built entity keeps what its ghost was told: nothing on this install "
        .. "can build a ghost for you (`revive()` answers nil on a script-made ghost), so that one step is "
        .. "the player's click. The lane numbers are in `manifest` either way.",
    }
    -- 号怎么数：牌上说的是**引擎自己的**股号，因为玩家接总线时按的就是那一套（`get_transport_line(1|2)`
    -- 与牌上同一个号）。行号从这条线自己的第一根进料带数起，每股两个号：股号 = (行号 - 1) * 2 + 股。
    -- 双排每排一块头牌，两块牌报的是同一套号里各自的段。
    head_row.lane_order = "a lane number is the engine's own: line (number) carries its two half-lanes, "
      .. "numbers 2*(number-1)+1 and 2*(number-1)+2, counting feed lines from the first one the shape "
      .. "lays and product lines after them; which side of the belt each number sits on follows the "
      .. "belt's own direction (measured: a west-going line flips them)"
    if more then
      head_row.lane_order = head_row.lane_order .. "; this card has " .. #more
        .. " heads, one per machine row, and each lists only its own row's lanes"
    end
  end

  local ports = { ["in"] = {}, out = {} }
  -- Advisory index map: anyone mutating this card (the regression suite, or a model
  -- using it as a template) should look entities up by role instead of counting them,
  -- because the geometry shifts with arm reach and furnace size.
  local roles = { arms = {}, belts = {}, machines = {}, out_chests = {} }
  -- The one pipe of the feed row that is not covered by the shape: the port a player's own network joins.
  -- Its index is enough to say where it is (the position is on the part), and it is looked for by role
  -- rather than by counting, like every other part of a lane.
  local feed_port
  for i, e in ipairs(ents) do
    local kind = (prototypes.entity[e.name] and field(prototypes.entity[e.name], "type")) or "?"
    if e.role == "in" then
      ports["in"][#ports["in"] + 1] = { item = e._feed_item or first_ing, entity = i, chest = true }
      roles.in_chest = roles.in_chest or i
      roles.in_chests = roles.in_chests or {}
      roles.in_chests[#roles.in_chests + 1] = i
    elseif e.role == "out" then
      ports.out[#ports.out + 1] = { item = product, entity = i, chest = true }
      roles.out_chests[#roles.out_chests + 1] = i
      roles.out_chest = roles.out_chest or i
    elseif e.role == "overflow" then
      roles.overflow_chest = i
    elseif e.role == "fluid_in" then
      feed_port = i
      roles.fluid_port = i
    end
    if kind == "inserter" then roles.arms[#roles.arms + 1] = i
    elseif kind == "transport-belt" then roles.belts[#roles.belts + 1] = i
    elseif kind == "furnace" or kind == "assembling-machine" then roles.machines[#roles.machines + 1] = i end
    e._fluid = nil
  end
  -- A lane that drinks declares its fluid where the rest of the mod looks for an in-port: on the machine
  -- whose box it is, as a `ports.in` row with a `fluid` and no `item`. That is the shape `compose` already
  -- carries through a merge and the shape `card_lab` already feeds -- the lab builds its own supply run to
  -- a box, which is why the row's own pipe is not what the measurement is about. The row is what a player
  -- builds with; the declaration is what says the lane owes that fluid.
  if fluid_feed then
    for _, i in ipairs(roles.machines) do
      -- The face travels with the port because it is the row's axis: a tank has to stand beyond the
      -- port along the line the pipes run, and the face is what says which axis that is. Without it a
      -- reader has to guess from the two positions, and a 5-wide machine's port sits closer to its
      -- centre than to its own box cell, which guesses the wrong way round.
      ports["in"][#ports["in"] + 1] = { fluid = fluid_feed.fluid, entity = i,
        box = fluid_feed.box, row_port = feed_port, face = fluid_feed.face, off = fluid_feed.off }
    end
  end
  -- Which recipe each machine in this card runs. `card.lua`'s "does this machine move items" rule and
  -- `card_lab`'s "what does the rig have to feed it" rule both ask the card, and both used to guess: the
  -- guess was right for a smelting row and for every single-ingredient recipe, and wrong for `concrete`,
  -- whose second ingredient (stone brick) is not the first one and so never appeared as an in-port --
  -- the rig answered RECIPE_UNFEEDABLE for a lane that had said all along what it was a template for.
  -- A bus lane is NOT bound this way: its machines take their recipe from the wire, and a fixed
  -- binding here would be a claim the wire contradicts the first time a shelf moves.
  local machine_recipes
  if not bus_list then
    machine_recipes = {}
    for _, i in ipairs(roles.machines) do machine_recipes[i] = recipe_name end
  end
  -- emit the anchor list alongside the ports so an unfrozen card is structurally the
  -- same shape as a frozen one; otherwise the first composition silently depends on
  -- the ports fallback and the second one does not
  local anchors = {}
  for _, p in ipairs(ports["in"]) do
    anchors[#anchors + 1] = { kind = "in", item = p.item, fluid = p.fluid, entity = p.entity }
  end
  for _, p in ipairs(ports.out) do
    anchors[#anchors + 1] = { kind = "out", item = p.item, fluid = p.fluid, entity = p.entity }
  end
  -- The ground it actually took, which is what a box gets compared against. Measured from the entities
  -- rather than from the pitch formula, because the supply a lane grows (chests, outlets) is what
  -- decides the width, and a formula kept beside it would be a second truth free to drift.
  -- How many belt LINES the shape lays, counted off the parts by the file that laid them. This is the
  -- figure a style is picked with -- two rows behind one shared product line are three lines where two
  -- rows that do not share are four -- and a number written beside the geometry is the one most easily
  -- wrong once someone moves a chest.
  local laid_lines = styles.lines(specs, function(n) return n == belt end)
  local lanes_lay = { rows = laid_lines.rows, cols = laid_lines.cols, total = laid_lines.total }
  -- Measured with the ONE box function this file has, the same one `find_card_site` and the region answer
  -- use. Deriving it here by adding half a tile and a whole tile instead made every `card_example`
  -- footprint one cell wider and one cell taller than the shape it reports, and the packer that reads it
  -- (plan_fit, group_fit) then laid lanes out to a box the card never fills -- "only 2 of 4 fit" against a
  -- box that holds 3, in the direction the player cannot see.
  local bminx, bminy, bmaxx, bmaxy = card_bbox({ entities = ents })
  local wide = bminx and math.ceil(bmaxx - bminx) or 0
  local high = bminy and math.ceil(bmaxy - bminy) or 0
  -- One lane's rate times the lanes built. The first version of this line forgot the second factor, so
  -- a 4-lane card claimed a 1-lane output: the footprint grew, the claim did not, and every number
  -- downstream -- "how many of these", the lab's verdict -- read a card that under-promised by a
  -- factor of four.
  --
  -- Every item the recipe yields is priced, because a lane that makes two things carries two things:
  -- `copper-cable` yields twice as many items per craft as the ore it ate, and a contract that reported
  -- crafts rather than items would under-promise the line by half. `claimed` is the rate of the one
  -- product the line carries out to its anchor, which is what the belt under it is measured against.
  -- `lanes` (declared as the machine count above, and named for a row of machines since this function
  -- only knew smelting) is why the rate is the WHOLE ROW's rather than one machine's -- both matter
  -- below, where a per-minute figure is turned into a per-machine one.
  --
  -- 这份件数不再在这里乘一遍：它从 `rate_for` 拿（带 `flows` 时那是 helmod 那一行折好的那一份）。
  -- `speed × 60 / energy × 台数` 那条公式现在只在 `rate_for` 的自算分支里活着，一处，不在这里。
  local rate = rate_for(lanes)
  local crafts_min = rate.crafts_min
  local makes, claimed = {}, nil
  for _, p in ipairs(rate.products or {}) do
    if p.item then
      makes[p.item] = (makes[p.item] or 0) + (p.per_min or 0)
      if p.item == product then claimed = (claimed or 0) + (p.per_min or 0) end
    end
  end
  if not claimed then claimed = crafts_min end
  -- The fluid this lane drinks, the cell it is handed in at, and what the claim above costs per minute of
  -- it. Reported apart from `ports.in` on purpose: every other in-port of a generated line is a chest
  -- somebody puts items into, and this one is the end of a pipe that has to meet the player's own network
  -- -- the only part of a line the mod can lay but cannot finish, because where the fluid comes from is a
  -- fact about the factory, not about the recipe.
  local fluid_in
  if fluid_feed then
    -- 同一种流体可能在清单里出现两次（不同温度的两份），所以按名字把 /分 加起来，与从前"先把单件量加成
    -- 一份有理数再乘工艺次数"是同一件事，只是那份单件量现在来自 `rate_for`。
    local want = 0
    for _, e in ipairs(rate.fluids or {}) do
      if e.item == fluid_feed.fluid then want = want + (e.per_min or 0) end
    end
    fluid_in = { {
      fluid = fluid_feed.fluid, pipe = pipe_name, box = fluid_feed.box, how = fluid_feed.how,
      volume = fluid_feed.volume, needs_temperature = fluid_feed.needs_temperature,
      face = fluid_feed.face, off = fluid_feed.off,
      -- the facing the machine will actually be standing in once it is built, and whether that is the one
      -- the card asked for. Said because a feed row is drawn against the first and a reader would otherwise
      -- assume the second: an assembling machine is told to face south by a turned shape and comes back
      -- facing north, and the row is where the north box put it, not where the south one would have.
      built_direction = fluid_feed.built_direction, keeps_facing = fluid_feed.keeps_facing,
      -- one stub per machine in the shape, joined by the run: the count is what the parts say they are (a
      -- lane of a two-row style stands two machines), and the port is the one free end wherever they are.
      machines = #roles.machines,
      units_per_min = want,
      port = feed_port and { entity = feed_port, position = ents[feed_port].position } or nil,
    } }
  end
  -- What the shape's own product lines can move. `row-chest` has none (an arm lifts the plate into a
  -- chest beside the machine), which is reported as such rather than as an infinite ceiling: a plan
  -- that never looks at the road under it will cheerfully promise a rate no belt can deliver.
  local outlet = styles.product_lines(specs, function(n) return n == belt end,
    function(n) return n == ins end, reach)
  -- 一根成品带走得完多少：一股的运力 × 这根带子能被几个面装满。写整条带子（两股）的运力会把单排
  -- 许诺成两倍 —— 而同面两只臂装的是同一股（dev/lane_side_probe.js rig 4）。
  local lane_carry = (lane_of(product, belt, nil, force).per_min or 0) / 2
  local per_product_line = lane_carry * (style.product_lanes_per_line or 2)
  -- 成品能走几股 = 独占的成品行 × 每行几个面装满 + 借进料行远股的那几股（共用一行时每行只借得出
  -- 一股，所以按股直接加）。`outlet.lines` 仍然只数独占的行 —— 进料那一侧"还剩几股"要按整行扣。
  local product_lanes_out = outlet.lines * (style.product_lanes_per_line or 2) + (outlet.shared_lanes or 0)
  local row_carry = product_lanes_out > 0 and per_product_line or nil
  -- The belt's own figure, whether or not this SHAPE lays a line the product rides. The feed arithmetic
  -- below is a question about the belt tier and its lanes, so it must survive a shape that lays two
  -- inbound rows and no product row (`two-feed`) -- reading `row_carry` there would answer "no line to
  -- compare against" for a shape that has two of them.
  --
  -- `force` 必须传：0.72.0 把 `(1 + belt_stack_size_bonus)` 折进了 `lane_of`，另外两处调用都带上了 force，
  -- 偏偏这一处没有 —— 于是 `feed_plan.per_line` / `per_lane` 与从它们算出来的 `lanes_wanted` /
  -- `machines_per_line`（"这条线能喂几台"）一直按**没加成**的运力说话，而同一张卡的成品那一侧
  -- （`lane_carry`）说的是折过的。2026-10-09 由 `belt_need_helmod.per_min` 那一条新门禁抓到：加成一级，
  -- 成品侧分母翻倍而进料侧不动 —— 那正是玩家报的"helmod 说一条够，你为什么要两条"，只是藏在进料那一半。
  local belt_carry = (lane_of(product, belt, nil, force).per_min or 0)
  -- How many inbound lanes the shape lays, counted from the parts it emitted: the belt LINES it drew --
  -- by travel axis, so a turned lane counts its columns -- less the lines the product leaves on.
  -- Declaring it beside the geometry would be the second truth this file has been burned by; a lane's
  -- own parts are the record of what it laid.
  local belt_lines = styles.lines(specs, function(n) return n == belt end).total
  local lanes_laid = math.max(0, 2 * (belt_lines - outlet.lines) - (outlet.shared_lanes or 0))
  -- ...and how many of those lanes ONE MACHINE can reach, which is the number the feed arithmetic has to
  -- divide by. `sandwich-2` crosses the template with two feed rows -- four lanes' worth of material
  -- passing -- while a machine in its upper row is fed by the upper line alone, because an inserter stands
  -- in the single row between its belt and its machine and reaches exactly that belt. Counting the shape's
  -- bill as if every machine could spend it doubles the length a line may reach before its far end starves,
  -- which is the one failure this file has been called out for over and over.
  local lanes_reach = styles.reachable_feed_lanes(specs, function(n) return n == belt end,
    -- `arm_reach_tiers(force)`: the shape puts one arm of each tier beside a machine, so the lanes ONE
    -- machine reaches are every line whose distance matches some tier it was handed -- not just the tier
    -- of the single `reach` figure, which counted a two-line face as two lanes and halved every row.
    function(n) return n == furnace end, reach, outlet.rows, fw, fh, arm_reach_tiers(force.name, is_available))
  -- 借给成品的那几股不算进"一台机器摸得到的进料股数"：共用一行时那一行整行仍然摸得到，只是远侧
  -- 那一股不再送料。
  if lanes_reach then lanes_reach = math.max(0, lanes_reach - (outlet.shared_lanes or 0)) end
  local belt_ceiling
  if row_carry and row_carry > 0 then
    local carry = lane_carry * product_lanes_out
    belt_ceiling = { lines = outlet.lines, rows = outlet.rows, per_min = carry, belt = belt,
                     shared_lanes = (outlet.shared_lanes or 0) > 0 and outlet.shared_lanes or nil,
                     belt_stack_size_bonus = (tonumber(force.belt_stack_size_bonus) or 0),
                     claimed_per_min = claimed, headroom = carry > 0 and claimed / carry or nil }
    -- Said, not refused. A lane's product line is shared with whoever else's rows run into it -- the
    -- box packs N of these templates side by side, and a main bus collects them all -- so a per-lane
    -- figure cannot call any plan impossible on its own. What it CAN say, beside the rate the shape
    -- claims, is how much of one row's throughput that claim already takes: over 1.0 is where a player
    -- has to either widen the road or stop stacking rows behind it.
    if claimed > carry then
      belt_ceiling.over_claimed = true
      belt_ceiling.next = string.format(
        "%s/min wants %.0f/min of the %d product line(s) this shape lays -- a faster belt than %s,"
        .. " another product line, or fewer machines per lane",
        string.format("%.1f", claimed), carry, outlet.lines, belt)
      belt_ceiling.next_key = "n-belt-over"
      belt_ceiling.next_params = { string.format("%.1f", claimed), string.format("%.0f", carry),
                                   tostring(outlet.lines), belt }
    end
  end
  -- The other road out: the arm that lifts the product onto the line. Its ceiling is not the belt's, and
  -- an arm's rate is not in a prototype either, so the only honest figure is the one the bench measured
  -- for THIS tier and THIS item.
  --
  -- Said, not refused, like the belt above: two arms of the same tier are two arms, and a plan is
  -- allowed to want a third.
  local arm_ceiling
  if (outlet.arms or 0) > 0 then
    local row, rec = measured_arm_row(product, ins)
    arm_ceiling = { arms = outlet.arms, arm = ins, item = product,
                    measured = row ~= nil,
                    measured_tick = rec and rec.measured_tick or nil,
                    caveat = rec and rec.caveat or nil }
    if row then
      local swing = row.swings_per_min or 0
      local hand = math.max(1, row.items_per_swing or 1)
      arm_ceiling.per_arm_min = row.items_per_min
      arm_ceiling.swing_rate_per_min = swing
      arm_ceiling.items_per_swing = row.items_per_swing
      -- The two ends. `per_min_floor` is what N arms move if each swing brings one item -- which is
      -- what an arm over a nearly-empty belt does -- and `per_min` is what it moves with a full hand,
      -- which is what the rig measured between two chests. A plan is only told it has too few arms
      -- when it wants more than the FULL-HAND end; between the two, the honest word is "it depends what
      -- is under the hand", and that is said rather than smoothed into one number.
      arm_ceiling.per_min_floor = swing * outlet.arms
      arm_ceiling.per_min = (row.items_per_min or 0) * outlet.arms
      arm_ceiling.claimed_per_min = claimed
      arm_ceiling.headroom = arm_ceiling.per_min > 0 and claimed / arm_ceiling.per_min or nil
      if claimed > arm_ceiling.per_min then
        arm_ceiling.over_claimed = true
        arm_ceiling.binds = "arm"
        arm_ceiling.next = string.format(
          "%s/min wants %.0f/min of the %d outlet arm(s) this shape lays -- a faster arm than %s"
          .. " (%s/min each), another arm on each chest, or fewer machines per lane",
          string.format("%.1f", claimed), arm_ceiling.per_min, outlet.arms, ins,
          string.format("%.0f", row.items_per_min))
        arm_ceiling.next_key = "n-arm-over"
        arm_ceiling.next_params = { string.format("%.1f", claimed),
                                    string.format("%.0f", arm_ceiling.per_min),
                                    tostring(outlet.arms), ins,
                                    string.format("%.0f", row.items_per_min) }
      elseif claimed > arm_ceiling.per_min_floor then
        arm_ceiling.binds = "maybe"
        arm_ceiling.next_key = "n-arm-maybe"
        arm_ceiling.next_params = { string.format("%.1f", claimed),
                                    string.format("%.0f", arm_ceiling.per_min_floor),
                                    string.format("%.0f", arm_ceiling.per_min),
                                    tostring(outlet.arms), ins }
      else
        arm_ceiling.binds = "not-the-arm"
      end
    else
      -- The reason there is no number is part of the answer: "this arm has never been measured" is a
      -- call to press 量臂, while "there is no ceiling" would read as a shape that can move anything.
      arm_ceiling.why = "not-measured"
      arm_ceiling.next_key = "n-arm-unmeasured"
      arm_ceiling.next_params = { ins, tostring(outlet.arms), tostring(claimed) }
    end
  end
  -- Can one belt line carry everything this recipe eats, and if not, how many lines does it need. This
  -- is the compactness decision the player asked for stated as arithmetic rather than as a preference:
  -- one line's throughput (`row_carry`, counted from the belt model) against the per-minute demand of
  -- each item ingredient (crafts/min x items per craft), and the answer is either "share one line" or
  -- "one line per material" with the number that made it so.
  --
  -- It reports the SHAPE it can prove, not the shape it laid: the styles today feed one ingredient
  -- line, and `unfed` on a helmod lane is where the difference between those two shows up. A style that
  -- lays several feed lines consumes this figure to decide how many, so the number and the geometry
  -- cannot drift apart into two different opinions about the same recipe.
  --
  -- 料单与流量都从 `rate_for` 那一份里读：带 flows 时它是 helmod 那一行折过的（单件量 `per_craft` 也是
  -- 折过的，含 productivity 与 quality 的额外产物），不带时它是原型的。这里不再出现第二次 `crafts × amount`。
  local feed_needs, feed_fluids, feed_total = {}, {}, 0
  for _, e in ipairs(rate.feed or {}) do
    local want = e.per_min or 0
    feed_needs[#feed_needs + 1] = { item = e.item, per_min = want, per_craft = e.per_craft }
    feed_total = feed_total + want
  end
  for _, e in ipairs(rate.fluids or {}) do
    feed_fluids[#feed_fluids + 1] = { item = e.item, per_min = e.per_min or 0, per_craft = e.per_craft }
  end
  -- 燃料那一行（helmod 的 `burnt`）不进上面的料单：这一模的带子不搬燃料。它单独交出去，看得见有几个 /分
  -- 要从别的路上来（玩家的煤是另一条线的事，不是这条带子欠的）。
  local fuel_needs = {}
  for _, e in ipairs(rate.fuel or {}) do
    if e.item then fuel_needs[#fuel_needs + 1] = { item = e.item, per_min = e.per_min or 0 } end
  end
  local feed_plan = { needs = feed_needs, fluids = #feed_fluids > 0 and feed_fluids or nil,
    fuel = #fuel_needs > 0 and fuel_needs or nil,
    per_min_total = feed_total, per_line = row_carry, belt = belt, inbound_lanes = 2 }
  -- A belt row is TWO lanes, and `per_line` is the whole belt's figure -- what one LANE moves is half of
  -- it. The geometry this mod lays puts one MATERIAL in each lane (the head stands an arm on each face of
  -- the row, the only way a blueprint can keep two materials apart: see the measured invariant at the top
  -- of styles.lua), so the test is per material against per lane, and the count of materials against two.
  -- Counting the sum against the whole belt would let a plan through that the lanes cannot carry.
  local heaviest = 0
  for _, k in ipairs(feed_needs) do if k.per_min > heaviest then heaviest = k.per_min end end
  feed_plan.heaviest_per_min = heaviest
  -- helmod 那一句"要几条带子"，与上面那些行数**并列**放着，不互相替换（#35 ③）。
  -- 每一种料各算一条：`belt_need` 用的是 helmod 那条式子（除以这条带一分钟能过的件数），取整向上贴半条。
  -- `*_belts` 那些合计是把每条贴好半条的数加起来 —— 它是"这一侧一共几条带子"的一个读法，而**这一页实际
  -- 铺几行**仍然是几何律（股数 ÷ 每行能装几股，见 `lane_plan`），两个数会不一样，都摆出来才能问"差在哪"。
  local belt_needs = { belt = belt, per_min = belt_carry > 0 and belt_carry or nil,
    bonus = (tonumber(force.belt_stack_size_bonus) or 0), feed = {}, products = {} }
  local function need_into(list, entries)
    local belts_sum, raw_sum = 0, 0
    for _, e in ipairs(entries or {}) do
      local one = belt_need(e.per_min, belt, force)
      list[#list + 1] = { item = e.item, raw = one.raw, belts = one.belts, lanes = one.lanes }
      belts_sum = belts_sum + one.belts
      raw_sum = raw_sum + (one.raw or 0)
    end
    return belts_sum, raw_sum
  end
  belt_needs.feed_belts, belt_needs.feed_raw = need_into(belt_needs.feed, rate.feed)
  belt_needs.product_belts, belt_needs.product_raw = need_into(belt_needs.products, rate.products)
  -- 交接文档许的那一形（`belt_need_helmod = {raw, rounded, lanes, belt, bonus}`）说的是**这条线往外搬
  -- 那种料**（`product`）的那一条：按物料看的那份在 `products[]` 里，按侧看的合计数在 `*_belts`/`*_raw`。
  -- 三个数都留着，是因为它们是三种问法："这块板子要几条带" / "这一侧一共几条" / "这一页铺几行"。
  for _, e in ipairs(belt_needs.products) do
    if e.item == product then
      belt_needs.raw, belt_needs.rounded, belt_needs.lanes = e.raw, e.belts, e.lanes
    end
  end
  if belt_needs.raw == nil and #(belt_needs.products) > 0 then
    local first = belt_needs.products[1]
    belt_needs.raw, belt_needs.rounded, belt_needs.lanes = first.raw, first.belts, first.lanes
  end
  -- The lanes ONE MACHINE reaches, counted from its parts above (two per feed row it can arm); a shape
  -- whose machines no function can place -- or a lane with no belt to compare against -- falls back to the
  -- two lanes of a single row rather than to nothing. The field used to be called `lanes_in_a_row`, and a
  -- shape that reaches two rows answering 4 under that name teaches the reader the wrong physics: a belt
  -- row has two lanes, always.
  local lanes_in = lanes_reach or (lanes_laid > 0 and lanes_laid or feed_plan.inbound_lanes)
  feed_plan.inbound_lanes = lanes_in
  -- ...and the lanes the SHAPE lays for the whole template. Every figure below that answers "does this
  -- plan's material fit its belts" is a comparison between the demand of ALL the machines asked for and
  -- the lines crossing the ground, so it divides by this; every figure that answers "how far may one row
  -- reach before its end starves" divides by `lanes_in`. The two are the same number for every single-row
  -- shape and differ by exactly the machine rows for `sandwich-2` -- and mixing them is how a four-lane
  -- template of two rows got reported as needing two lines when it lays both of them itself.
  local lanes_all = math.max(lanes_laid, lanes_in)
  -- Said beside it, because the two numbers are both true and answer different questions: this is what the
  -- shape crosses the ground with, and `inbound_lanes` is what one of its machines can spend. They differ
  -- for exactly the shapes with more than one machine row -- and a reader comparing the belt's throughput
  -- against the wrong one of the two gets a line twice as long as the one that runs.
  if lanes_all > lanes_in then feed_plan.feed_lanes_laid = lanes_all end
  -- The lanes are counted per FEED ROW, so the row count is what makes the total readable: `two-feed`
  -- lays two of them and answers 4 lanes, and a reason that said "a row has 4" would be a claim about
  -- belt geometry that is false -- a belt row has two lanes, always (the invariant at styles.lua's head).
  -- 共用那一行时"料真能走的股数"比 2×行数 少（借给成品的那几股不算料），但**行数没变**：一根带子
  -- 铺在地上就是铺了一行。所以行数直接数形状铺的带行，不再从股数倒过来除 —— 除出来的 3/2=1 会说
  -- "这形状只铺了 1 条进料带"，而它铺了 2 条。
  local feed_rows_laid0 = math.max(0, (belt_lines or 0) - outlet.lines)
  feed_plan.lane_rows = math.max(1, feed_rows_laid0 > 0 and feed_rows_laid0 or math.floor(lanes_all / 2))
  -- `belt_carry`, not `row_carry`: the feed question is about the belt tier and its lanes, and a shape
  -- that lays two inbound rows and no product row (`two-feed`) has a row_carry of nil -- which would
  -- have answered "nothing to compare against" for the shape with the most lines to compare.
  if belt_carry > 0 then
    local per_lane = belt_carry / 2
    -- Re-read from the belt tier rather than from `row_carry`: the feed rows this plan is about are not
    -- the product rows `row_carry` counts, and `two-feed` lays two of the former and none of the latter.
    feed_plan.per_line = belt_carry
    feed_plan.per_lane = per_lane
    -- Lanes are indivisible: a material wanting 1.2 lanes' worth occupies two, and the leftover of the
    -- second one belongs to nobody -- putting another material in it is the mixing this geometry exists
    -- to avoid. So each material rounds UP to whole lanes, and the row is full when its two lanes are.
    local lanes_wanted = 0
    for _, k in ipairs(feed_needs) do
      lanes_wanted = lanes_wanted + (k.per_min > 0 and math.ceil(k.per_min / per_lane) or 0)
    end
    feed_plan.lanes_wanted = lanes_wanted
    -- Compared against the lanes the TEMPLATE lays, because `lanes_wanted` is the demand of every machine
    -- asked for: a `sandwich-2` card of 48 plates-smiting furnaces wants 4 lanes and lays 4 -- two rows of
    -- two -- so it is one line, not the two that dividing by a machine's own reach would have said.
    -- "一条带子装得下所有料吗" —— 一行带子有两条半股，所以这一格比的是 2，不是"这条线一共铺了几股"。
    -- 从前它比的是 `lanes_all`（整条线铺了的股数），那是另一句话：一条两行的线当然装得下三种料，但它
    -- 不因此就是"一行"。名字说什么，算术就得比什么。
    feed_plan.share_one_line = lanes_wanted > 0 and lanes_wanted <= 2
    feed_plan.lines_needed = math.max(1, math.ceil(lanes_wanted / lanes_all))
    feed_plan.headroom = lanes_all * per_lane - feed_total
    -- How many machines ONE row of this belt can keep fed, counted UP rather than divided: what a
    -- material occupies is a `ceil` of its per-machine demand, and `ceil` is not linear in the machine
    -- count -- a material that needs a tenth of a lane for one machine needs 1.2 lanes for twelve, and it
    -- is that rounding which decides where the row stops. So each count is asked in turn whether the two
    -- lanes are still enough. A plan larger than the answer is not one line: it is this many lines, each
    -- with its own head and outlet, which is the other half of 分带 and the half a long row hides until
    -- its far end starves.
    local machine_needs = {}
    for _, k in ipairs(feed_needs) do
      machine_needs[#machine_needs + 1] = (k.per_min or 0) / math.max(1, lanes)
    end
    -- Can ONE machine's own appetite fit the two lanes? If not, splitting rows changes nothing -- every
    -- row would be over its belt all the same -- and the honest answer is the belt tier, not more lines.
    local lanes_for_one = 0
    for _, per in ipairs(machine_needs) do
      lanes_for_one = lanes_for_one + (per > 0 and math.ceil(per / per_lane) or 0)
    end
    if lanes_for_one > lanes_in then
      feed_plan.belt_too_slow = true
      feed_plan.machines_per_line = lanes
      feed_plan.reason = string.format("one machine of this recipe wants %d lanes and reaches %d"
        .. " (%.0f/min each) -- no split fixes that, a faster belt does", lanes_for_one, lanes_in,
        per_lane)
    else
      local m_fit = 0
      -- Counted in MACHINE ROWS and then widened to machines, because a two-row style's line is a pair: the
      -- lanes one machine reaches belong to the row it stands in, so a template of `sandwich-2` carries
      -- what two rows' worth of machines can eat, not what one row's does. The multiplier is read off the
      -- parts -- how many times the lanes the shape lays exceed the lanes one machine can spend -- rather
      -- than remembered: `two-feed` lays four lanes that every one of its machines reaches, and a style
      -- field that meant "belt rows" for one shape and "machine rows" for another would have doubled the
      -- first and halved the second.
      local unit = lanes_in > 0 and math.max(1, math.floor(lanes_all / lanes_in)) or 1
      local rows_fit = 0
      -- Counted up to a bound rather than to the plan's own length: the limit is a fact about the
      -- recipe, the machine and the belt, not about how many this caller happened to ask for, and a
      -- card that stopped counting at 40 would tell a reader "40 fit" about a row that could carry 48.
      while rows_fit < math.max(lanes, 1) * 2 + 8 do
        local want = 0
        for _, per in ipairs(machine_needs) do
          want = want + (per > 0 and math.ceil(per * (rows_fit + 1) / per_lane) or 0)
        end
        if want > lanes_in then break end
        rows_fit = rows_fit + 1
      end
      m_fit = rows_fit * unit
      feed_plan.machines_per_line = math.max(1, m_fit)
    end
    -- A line runs out two ways, and the number of lines a plan needs is the larger of the two: the
    -- materials may want more lanes than the template lays, or the machines may be more than one row of
    -- this belt can keep fed. Counting only the first understates, because `lanes_wanted` rounds each
    -- material ONCE for the whole plan while every row pays its own `ceil` -- 40 machines of 红板 want 22
    -- lanes in total and 4 lanes a piece over ten templates, and a reason that said "6 lines" here would
    -- promise four-machine lines that reach six.
    if feed_plan.machines_per_line and feed_plan.machines_per_line >= 1
      and not feed_plan.belt_too_slow then
      feed_plan.lines_needed = math.max(feed_plan.lines_needed or 1,
        math.ceil(lanes / feed_plan.machines_per_line))
    end
    local per_machine = lanes > 0 and (feed_total / lanes) or 0
    if per_machine > 0 then feed_plan.per_machine = per_machine end
    if #feed_needs > 1 and not feed_plan.belt_too_slow and (feed_plan.lines_needed or 1) > 1 then
      feed_plan.reason = string.format("%d materials need %d lanes of a %s (a lane carries %.0f/min;"
        .. " %d feed rows lay %d lanes and one machine reaches %d) -- that is %d lines, each with its own head",
        #feed_needs, lanes_wanted, belt, per_lane, feed_plan.lane_rows, lanes_all, lanes_in,
        feed_plan.lines_needed)
    elseif #feed_needs > 1 and not feed_plan.belt_too_slow then
      feed_plan.reason = string.format("%d materials need %d of the %d lanes this shape lays on a %s"
        .. " (%.0f/min each, %d feed rows; one machine reaches %d of them)"
        .. " -- they share the lines without sharing a lane",
        #feed_needs, lanes_wanted, lanes_all, belt, per_lane, feed_plan.lane_rows, lanes_in)
    elseif not feed_plan.belt_too_slow and (feed_plan.lines_needed or 1) > 1 then
      feed_plan.reason = string.format("one material wants %.0f/min: %d of the %d lanes this shape lays"
        .. " on a %s (%.0f/min each) -- one line of it feeds %d machines, so that is %d lines",
        feed_total, lanes_wanted, lanes_all, belt, per_lane, feed_plan.machines_per_line,
        feed_plan.lines_needed)
    else
      feed_plan.reason = string.format("one material wants %.0f/min: %d of the %d lanes this shape lays"
        .. " on a %s (%.0f/min each)", feed_total, lanes_wanted, lanes_all, belt, per_lane)
    end
  else
    -- No product line at all (a `row-chest` shape lifts into chests) or an unmeasured belt: the shape
    -- question is then the ARM's, and `arm_ceiling` above is where that is said. Silence here would
    -- read as "nothing to share".
    feed_plan.reason = "this shape lays no product belt line to compare against"
  end

  -- 需求侧与供给侧对一次账：这条线**要**几条带，和现在这个形状**铺了**几条。
  --
  -- 需求是从流量算的，两种料和两种产物都算：`lanes_wanted` 往上取整到整条带就是进料带数；产物那一侧
  -- 把**每一个**固体产物都算进去（这是 2026-10-06 补的洞 —— 从前成品只认第一个非流体产物，炼油、
  -- 化工、离心和一切 mod 多产物配方剩下的产物没人搬，卡片却照样报"这条线做 X/分"）。
  -- 供给是量出来的（`arm_reach_tiers`：一只臂只喂距离=它 reach 那一行），再被机器深度卡住。
  -- 哪一项没满足就点名哪一项，不含糊成"这形状不行"。
  local lane_plan = {}
  do
    local per_lane = feed_plan.per_lane
    local product_lanes = 0
    for _, rate in pairs(makes) do
      if per_lane and per_lane > 0 and (rate or 0) > 0 then
        product_lanes = product_lanes + math.ceil(rate / per_lane)
      end
    end
    lane_plan.product_lanes_wanted = product_lanes
    lane_plan.feed_rows_needed = math.ceil((feed_plan.lanes_wanted or 0) / 2)
    -- 成品那一侧除的是"这根带子能被几个面装满"，不是硬写的 2：单排只有一排机器，成品臂全站在带子同一面,
    -- 而同面两只臂装的是同一股（dev/lane_side_probe.js rig 4），所以一根线只走一股。这里若按 2 股报，
    -- "要几条成品带"就比形状实际铺的少一条，面板上那一行会说"已经铺齐了"而牌上还有第二条带子。
    lane_plan.product_rows_needed = math.ceil(product_lanes
      / math.max(1, tonumber(style.product_lanes_per_line) or 2))
    lane_plan.feed_rows_laid = feed_plan.lane_rows or 0
    lane_plan.product_rows_laid = outlet.lines or 0
    -- 共用那一行的那一档：成品不再独占一行，走的是进料行离机器远的那一股。上面"要几条成品带/铺了几条"
    -- 数的都是**独占的行**，所以借来的那几股单独交出去，别让读的人以为成品没铺；而真按共用铺了这一发,
    -- "要几条成品带"就是 0（再报独占的行数会把这一发指去要一块它不占的地面）。
    lane_plan.product_lanes_shared = (outlet.shared_lanes or 0) > 0 and outlet.shared_lanes or nil
    lane_plan.share = stack and stack.share or nil
    if stack and stack.share and stack.share.laid then
      lane_plan.product_rows_needed = 0
    end
    -- 一面能叠几条带：臂档数与机器深度的交集。深度按 3 格高的组装机给出 3，香草两档臂 → 2。
    local tiers = arm_reach_tiers(force.name, is_available)
    lane_plan.arm_reach_tiers = tiers
    lane_plan.rows_per_face = math.min(#tiers, math.max(1, fh))
    -- 料种数那一格的下限，与上面 `LINES_BEYOND_SHAPE` 用的是同一条律（一种料至少一股、一条带两股）：
    -- 这里也说得出"这 3 条是种数要的、不是流量要的"，否则同一件事在拒的那一路与铺成的那一路两种说法。
    local feed_mats = #(stack_demand and stack_demand.feed_split or {})
    if feed_mats == 0 then feed_mats = #(feed_items or {}) end
    lane_plan.materials = feed_mats
    lane_plan.feed_rows_floor = feed_mats > 0 and math.ceil(feed_mats / 2) or 1
    -- 无箱可铺 = 进料带铺得下 且 成品带也铺得下 且 **一张箱子都不剩**。最后这半按件数说话，不按"有没有
    -- 成品线"说话，因为两种箱子是不同的故障：机器级出料箱（玩家连着两轮指的那只"两台组装机中间的箱子"）、
    -- 带子末端的收料箱（row-belts 也有，数量少但同样是他不要的）、线头箱（`heads="belt"` 已经在去）。
    -- 只说"还有箱子"而不说哪种几只，下一步就没法知道该改哪个形状。
    local chest_roles = {}
    for _, s in ipairs(specs) do
      local pr = prototypes.entity[s.name]
      if pr and (field(pr, "type") == "container" or field(pr, "type") == "logistic-container") then
        local r = s.role or "?"
        chest_roles[r] = (chest_roles[r] or 0) + 1
      end
    end
    lane_plan.chests_by_role = chest_roles
    local chest_total = 0
    for _, n in pairs(chest_roles) do chest_total = chest_total + n end
    lane_plan.chest_total = chest_total
    -- 差几条，是"这个形状没铺够"（换个形状就有救）；超过一个面叠得起的上限，是"换形状也没救"
    -- （只能切线，或者这个安装里根本没有够长的臂）。两种故障必须分开说，否则下一句建议就是错的。
    lane_plan.short_feed = math.max(0, lane_plan.feed_rows_needed - lane_plan.feed_rows_laid)
    lane_plan.short_product = math.max(0, lane_plan.product_rows_needed - lane_plan.product_rows_laid)
    lane_plan.beyond_any_shape = lane_plan.feed_rows_needed > lane_plan.rows_per_face
      or lane_plan.product_rows_needed > lane_plan.rows_per_face
    -- 哪一种"顶到上限"：`feed_count` 是料种数（切线不解决），另外两种是流量（切线、换带子都解决）。
    -- 这一格是给调用方按分支用的，`blocked_by` 那一句是给人念的，两者必须同源。
    lane_plan.blocked_kind = lane_plan.feed_rows_needed > lane_plan.rows_per_face
      and ((lane_plan.feed_rows_floor or 0) > lane_plan.rows_per_face and "feed_count" or "feed_flow")
      or (lane_plan.product_rows_needed > lane_plan.rows_per_face and "product_flow" or nil)
    lane_plan.chest_free = lane_plan.short_feed == 0 and lane_plan.short_product == 0
      and chest_total == 0
    local role_words = {}
    for r, n in pairs(chest_roles) do role_words[#role_words + 1] = tostring(r) .. " " .. tostring(n) end
    table.sort(role_words)
    local blocked
    if lane_plan.feed_rows_needed > lane_plan.rows_per_face then
      -- 种数顶到上限时"只能切线"是假建议：切出来的每一条线仍然要吃齐这几种料。
      blocked = (lane_plan.feed_rows_floor > lane_plan.rows_per_face)
        and string.format("进料要 %d 条带（%d 种料，一种至少一股），一个面最多叠 %d 条（臂档 %s，机器深 %d）"
          .. " —— 换形状没用，切线也不解决：每一条线都要吃齐这 %d 种料",
          lane_plan.feed_rows_needed, feed_mats, lane_plan.rows_per_face,
          table.concat(tiers, "/") == "" and "无量" or table.concat(tiers, "/"), fh, feed_mats)
        or string.format("进料要 %d 条带，一个面最多叠 %d 条（臂档 %s，机器深 %d）—— 换形状没用，只能切线或换更快的带子",
          lane_plan.feed_rows_needed, lane_plan.rows_per_face,
          table.concat(tiers, "/") == "" and "无量" or table.concat(tiers, "/"), fh)
      lane_plan.blocked_kind = (lane_plan.feed_rows_floor > lane_plan.rows_per_face)
        and "feed_count" or "feed_flow"
    elseif lane_plan.product_rows_needed > lane_plan.rows_per_face then
      blocked = string.format("成品要 %d 条带，一个面最多叠 %d 条 —— 换形状没用，只能切线或换更快的带子",
        lane_plan.product_rows_needed, lane_plan.rows_per_face)
    elseif lane_plan.short_feed > 0 then
      blocked = string.format("进料要 %d 条带，这个形状只铺了 %d 条",
        lane_plan.feed_rows_needed, lane_plan.feed_rows_laid)
    elseif lane_plan.short_product > 0 then
      blocked = string.format("成品要 %d 条带，这个形状只铺了 %d 条",
        lane_plan.product_rows_needed, lane_plan.product_rows_laid)
    elseif chest_total > 0 then
      blocked = string.format("还剩 %d 只箱子（%s）", chest_total, table.concat(role_words, " "))
    end
    lane_plan.blocked_by = blocked
    -- 一条线上还差几台：进料带不够时不是"少几种料"，是这一排的机器吃不到某一面，所以切线也不解决；
    -- 只有成品侧超载才真的靠切线解决（那条是 `feed_plan.lines_needed` 已经在算的）。
    lane_plan.per_lane_min = per_lane
  end

  -- What this SHAPE does not bring. `feed_needs` is every item the recipe eats; `ports.in` is every box
  -- the laid shape put down for one, and the difference between the two is the lane being short. It has
  -- to be named with its per-craft amount rather than left out, because a caller holding the card cannot
  -- otherwise tell a lane that feeds one material from a lane that feeds all three -- `helmod_ghosts`
  -- grew its `unfed` column for exactly this complaint, and the card path has been answering 绿板 with
  -- two of its three boxes and no word about the third. A one-material lane says nothing, which is most
  -- of the table: 80 of the 337 production recipes eat a single item.
  local fed, lane_unfed = {}, {}
  for _, p in ipairs(ports["in"]) do if p.item then fed[p.item] = true end end
  -- A bare head has no in-port ON PURPOSE -- the lane is fed by the bus you splice onto it -- so what that
  -- shape brings is read off the sign: every half-lane the emitter names is a material the row carries.
  -- Without this, `heads = "belt"` reported all of a recipe's materials as unfed, and the ladder below
  -- "helped" by demoting a two-line head to a one-line one -- a shape choice made by a phantom shortage.
  for _, l in ipairs(head_row.lanes or {}) do if l.item then fed[l.item] = true end end
  -- ...and the same rule read off the LANES rather than off the sign, because a force that cannot place a
  -- display panel gets a line with no signs and the materials are still on those rows. Taking the answer
  -- from the sign alone made that lane report every material unfed, which is the phantom shortage this
  -- comment already warns about one layer down: the ladder then "fixed" a shape that was never short.
  local lane_capacity = 2 * tonumber((feed_plan or {}).lane_rows or 0)
  if lane_capacity > 0 then
    for i, k in ipairs(feed_needs) do if i <= lane_capacity and k.item then fed[k.item] = true end end
  end
  for _, k in ipairs(feed_needs) do
    if k.item and not fed[k.item] then
      lane_unfed[#lane_unfed + 1] = { name = k.item, amount = k.per_craft or 1 }
    end
  end

  -- How many materials a shape BRINGS is not a property of the name it was drawn under -- it is a
  -- property of the parts it laid, which is why this asks the laid lane (`unfed` above) rather than a
  -- table of capacities that could drift. If the shape left something out and the ladder offers a shape
  -- that does not, the lane is drawn again on that shape and the answer says what moved and why. A style
  -- the caller named is never swapped: their choice is their choice, and the `unfed` row stays as the
  -- complaint they asked for. The `shape_tried` mark is what stops a ladder whose last entry is the shape
  -- that cannot feed them from calling itself forever.
  if #lane_unfed > 0 and not style_named(args) and not args.shape_tried then
    for _, want in ipairs(shape_ladder(lanes, #feed_items, nil, #fluid_ins)) do
      if want ~= style.id then
        local again = {}
        for k, v in pairs(args) do again[k] = v end
        again.style, again.shape_tried = want, true
        local redrawn = M.card_example(again)
        -- Only an improvement moves the lane. The first draft took whatever the next shape answered, and
        -- a bare head whose materials all read "unfed" (see above) then "improved" itself into a shape
        -- that carries fewer of them -- the ladder's whole point is the count of lanes, so a redraw that
        -- does not lower that count is not a redraw at all.
        if redrawn and not redrawn.fail and #(redrawn.unfed or {}) < #lane_unfed then
          redrawn.shape_moved = { from = style.id, to = redrawn.style,
            because = style.id .. " brings " .. tostring(#feed_items - #lane_unfed) .. " of "
              .. tostring(#feed_items) .. " materials; " .. redrawn.style
              .. " brings them all (" .. table.concat((function()
                  local names = {}
                  for _, u in ipairs(lane_unfed) do names[#names + 1] = tostring(u.name) end
                  return names
                end)(), ", ") .. " had nowhere to arrive)" }
          return redrawn
        end
      end
    end
  end

  -- 点名一只箱子的调用方，要在答案里看见"这条线一只箱子也不铺"，而不是 `pick` 那句"选到了、这一发放得下"。
  -- 带箱子的四种排法删掉之后，`chest` 只是参数上还没摘掉的一个名字（台架的收箱、量流量的夹具还在用它），
  -- 地上没有它。答案里说一件地上没有的事，就是这个仓库最不想要的那种回答。
  local containers_laid = 0
  for _, sp in ipairs(specs) do
    local p = prototypes.entity[sp.name]
    if p and p.type == "container" then containers_laid = containers_laid + 1 end
  end
  if containers_laid == 0 then
    how.chest = "no shape on this install lays a chest, so " .. tostring(args.chest or chest)
      .. " is named but not placed (0 containers in the card)"
  end

  -- Named for what it makes. The smelting lane keeps the name forty versions of answers have been
  -- checked against; anything else gets a name that is not a lie about smelting.
  return { name = (recipe_name == "iron-plate") and ("smelter-lane-" .. tostring(lanes))
      or ("lane-" .. tostring(product) .. "-" .. tostring(lanes)),
    lane_count = lanes, spacing = args.spacing or "compact",
    -- Said beside the parts, because "which arm, and why that one" is a decision the shape made and the
    -- reader is entitled to see it: `reach` is what this arm actually reaches (measured, not a field 2.0
    -- does not carry), `need` is what the shape asked for, and `how` is the ladder's own sentence about
    -- how it ranked the candidates. A named arm says so, which is how a player who pinned one can tell
    -- that from a shape that needed one.
    arm_choice = ins_meta and { arm = ins, reach = ins_meta.reach, need = ins_meta.need,
      named = ins_meta.named or nil, how = ins_meta.how,
      peers = ins_meta.peers, decided_by = ins_meta.decided_by,
      because = ins_meta.drank_fluid and "the recipe drinks a fluid; its pipe row stands between the arm and the machine" or nil,
      swings_per_min = ins_meta.swings_per_min },
           style = style.id, orientation = args.orientation or "horizontal",
           lane_lines = lanes_lay,
           -- What the pole pass decided, absent when no poles were asked for: `needed` is the parts
           -- drawing grid power, `poles` the ones the lattice placed, `uncovered` the machines it could
           -- not reach from a free cell, and `step` the spacing it worked at.
           power_grid = power_grid,
           -- Counted off the parts that were actually laid, in the shape the style emitted them: what a
           -- player has to craft, and what the belt arithmetic gets compared against.
           parts = styles.count(specs, function(n)
             local pr = prototypes.entity[n]
             return pr and field(pr, "type") or nil
           end),
           gap_cells = gap, footprint = { width = wide, height = high },
           components = { furnace = furnace, inserter = ins, belt = belt, chest = chest,
             -- absent on every lane that drinks nothing, so `components_how.pipe` never reads as a pipe
             -- standing in a smelting row
             pipe = pipe_name },
           -- how each part was chosen, so a caller on a modded save can see that it was chosen at all
           components_how = how,
           -- and for the belt specifically, the whole trial: which tiers were walked from slowest up,
           -- which one the line fits on, and how full that one is. "够用就好" is only an answer if the
           -- reader can see what was tried and why the chosen tier was the first that carried it.
           belt_choice = belt_choice,
           -- 每一档臂各是什么（只有参数化的形状才有这一格；其余形状各档共用 `arm_choice` 那一只）。
           arm_tiers = (arm_needs and #arm_needs > 0) and arm_needs or nil,
           arm_reach = reach, roles = roles, anchors = anchors,
           entities = ents, ports = ports,
           machine_recipes = machine_recipes,
           -- the in-port a player still has to plumb: absent for every lane that drinks nothing.
           fluid_in = fluid_in,
           contract = { outputs = makes },
           -- What this template is a template FOR. Without it, a caller holding the card cannot tell
           -- a smelting lane from a gear press except by reading the contract back, and `plan_fit`'s
           -- answer needs the recipe name to say which refusal it is on.
           recipe = recipe_name, product = product, ingredient = first_ing,
           -- 偏好被换了要说得出是谁换成了谁、为什么（硬点名那一发在上头就按名拒了，走不到这里）。
           -- 少了这一格，"这条线是照着哪台机器算的"就只能从 `rate_source.machine` 反推，而反推不出
           -- 原来点的是哪一台。
           machine_swapped = machine_swapped,
           -- every item this recipe eats, what each wants per minute, and whether one belt line could
           -- carry the lot -- see `feed_plan` above
           feed_plan = feed_plan,
           -- 这张卡的分子是从哪儿来的（#35 那一刀要说清楚的一件事）。`source = "helmod"` 表示每种料的
           -- /分 读的是 helmod 那一行折好的那一份（productivity、模块、信标、quality 都在里面）；
           -- `source = "self"` 表示这一发没带 flows，这里按 `台数 × 速度 × 60 / 能耗` 自己算 —— 那一路只
           -- 属于"不经过 helmod、直接要一张卡"的门。`quoted_for` 是那份件数说给几台机器听的，`scale`
           -- 是这一发台数对它的缩放（整线 1，拆成几条线时每条拿自己那一份）。
           rate_source = { source = rate.source, machines = lanes, scale = rate.scale,
             crafts_per_min = rate.crafts_min, quoted_for = rate.quoted_for,
             helmod_machines = rate.helmod_machines, base_time = rate.base_time,
             crafts = rate.crafts, machine = rate.machine, craft_energy = rate.craft_energy,
             modules = rate.modules, belt = belt,
             -- 为什么这一发没拿 helmod 的那份数：只有一种理由会在这里出现 —— 地上铺的机器不是 helmod
             -- 那一行点名的那台（`reason = "machine_swapped"`）。`helmod_aside` 把原数与两台机器的名字
             -- 都留着，读数的人能看出差在哪、要不要重来。
             reason = flows_swapped and "machine_swapped" or nil,
             helmod_aside = flows_swapped or nil },
           -- helmod 那一句"这条线要几条带子"：每一种料各一条。`raw` 是式子出来的分数，`belts` 是向上贴到
           -- 半条那一个数，`lanes` 是它对应的股道数（一条带两股，实测在 `dev/belt_rate_e2e.js`）。
           -- 它与 `belt_choice` / `lane_plan`（这一页实际铺几行）**并列**，不是替换：两个口径会不一样，
           -- 差在哪要能当场读出来，玩家才不至于用"行数"去反推"条数"。
           belt_need_helmod = belt_needs,
           lane_plan = lane_plan,
           head = head_row,
           -- 线尾那块牌（成品走哪一股）。没有它 = 这条线还没铺到能立牌的地方，答案里就真没有这一格。
           tail = tail_row,
           -- the materials this shape lays no box for, named and quantified: the lane admitting it is
           -- short, in the same words the helmod lanes use (`n-hm-unfed` reads `name` and `amount`)
           unfed = #lane_unfed > 0 and lane_unfed or nil,
           -- The road under the claim, next to the claim. Counted, not asserted: the number of product
           -- lines comes from the parts the style laid, and the per-line figure from the belt model.
           belt_ceiling = belt_ceiling, arm_ceiling = arm_ceiling,
           -- The circuit this shape carries, said twice on purpose: `wires` is what a caller feeds back
           -- through `card_freeze`/`card_place` and `bus` is what it means -- which recipe each of the
           -- N machines was handed a position for, and which positions the bus cannot fill. A plan that
           -- says "4 machines cover this set" and quietly has 3 recipes on the bus owes the fourth
           -- machine a sentence, and this is where it is said.
           wires = #wires > 0 and wires or nil,
           bus = bus_list and {
             recipes = bus_list, machines = lanes,
             -- 这一圈现在**铺在地上**了：每台机器一只选择器，加一只发射器（split/rotate）或每种候选一只
             -- 算术盒（shortage），带子画在成形的形状以南那一行里。数的不是计划而是件表里真有的那几件
             -- （`role` 是 "control" 或 "bus"），所以这张卡不可能说"铺了 3 只"而地上只有牌那只盒子。
             laid_controllers = (function()
               local n = 0
               for _, e in ipairs(ents) do
                 if e.role == "control" or e.role == "bus" then n = n + 1 end
               end
               return n
             end)(),
             selectors = band and band.selectors or 0,
             controller_boxes = band and band.boxes or 0,
             -- 带子在哪一行：读**铺完之后的件**，不读形状里那个行号 —— `S.normalize` 会把整张卡滑到
             -- (0,0)，形状里的行号与玩家在地上数到的那一行不是一个数（0.66.x 那回就是牌上的号在地上找不到）。
             controller_row = (function()
               for _, e in ipairs(ents) do if e.role == "control" then return e.position.y end end
             end)(),
             bus_row = (function()
               for _, e in ipairs(ents) do if e.role == "bus" then return e.position.y end end
             end)(),
             said = "the ring is laid: one selector under every machine (each asks its own position of "
               .. "the bus, positions count from 0) plus one emitter for the card, or one arithmetic "
               .. "box per candidate under `shortage`. What the GROUND door still cannot write is the "
               .. "wiring itself -- 2.0 has no scripted connection (`circuit_connect` does not exist, "
               .. "measured) -- so a lane pressed onto the ground has its controllers configured and its "
               .. "wires left to the hand, while the blueprint door carries the wires in the record",
             -- the mix as asked: which recipe sits on which position, and how many machines were put
             -- there. A position with 0 machines is said rather than omitted -- an omitted row is how
             -- "this covers all three" comes to read true about a group with only two hands.
             covered = (function()
               local out = {}
               for _, c in ipairs(bus_covered or {}) do
                 local got = 0
                 for _, at in ipairs(bus_at or {}) do if at == c.position then got = got + 1 end end
                 out[#out + 1] = { recipe = c.recipe, position = c.position, machines = got }
               end
               return out
             end)(),
             unclaimed = (function()
               local out = {}
               for _, c in ipairs(bus_covered or {}) do
                 local got = 0
                 for _, at in ipairs(bus_at or {}) do if at == c.position then got = got + 1 end end
                 if got == 0 then out[#out + 1] = c.recipe end
               end
               return #out > 0 and out or nil
             end)(),
             -- Derived from the positions actually handed out, not from `#bus_list`: a machine on a
             -- position past the end of the bus is the one that will idle (act M measured that such a
             -- position emits nothing), and a mix can put two machines on one position -- so the count
             -- of idle machines is `lanes - hands assigned`, not `lanes - #bus_list`. The old formula
             -- said "machines 3 and 4 idle" for a lane where machine 3 builds copper-cable, and the
             -- built line said so by running.
             idle_machines = (function()
               local out = {}
               for i, at in ipairs(bus_at or {}) do if at >= #bus_list then out[#out + 1] = i - 1 end end
               return #out > 0 and out or nil
             end)(),
             hardware = { selector = selector, emitter = emitter, arithmetic = arithmetic },
             mode = bus_mode,
             every_ticks = bus_mode == "rotate" and bus_every or nil,
             -- What a shortage line is built out of, and what it is measuring. Said as numbers because
             -- the cost is the point a caller is choosing against: one arithmetic box per candidate
             -- standing in the controller row, and one wire per (box, chest) and (box, controller) pair,
             -- which is what "the shelves as one network" costs in copper. `sort` names the direction the
             -- engine reads, because it is the reason the number on the wire is `target - shelf` and not
             -- the other way round: positions are handed out from the BIGGEST count down, so the most
             -- deficient candidate is at position 0 (dev/circuit_rules_probe.js act R).
             target = bus_mode == "shortage" and bus_target or nil,
             boxes = bus_shortage and #bus_shortage or nil,
             -- How many of the card's own chests the boxes read, counted from the role map the ports were
             -- built with: one pass over the parts, one answer, no second count free to disagree.
             shelves = bus_mode == "shortage" and #roles.out_chests or nil,
             sort = bus_mode == "shortage" and "most short first" or nil,
             -- What one machine of this lane is worth, per recipe on the bus -- the same arithmetic
             -- that priced the lane's own contract (`crafts per minute = speed * 60 / energy`), run
             -- against each covered recipe instead of only the first. This is the group's CAPACITY
             -- vector, not a schedule: which machine actually builds what is decided by the counts on
             -- the bus, and the plan is the thing that wrote those counts, so the two figures agree by
             -- construction until a player edits the emitter by hand -- at which point this line is
             -- still true of the hardware and false of the factory, and only `line_watch` on the built
             -- line knows the difference.
rates = (function()
               local out = {}
               for i, r in ipairs(bus_list) do
                 -- and only in `split`: under `rotate` no machine is pinned to a recipe, so a rate per
                 -- position would be a number this lane does not owe anyone
                 local hands = 0
                 for _, at in ipairs(bus_at or {}) do if at == i - 1 then hands = hands + 1 end end
                 -- and only in the modes that pin a machine to a position: under `rotate` no machine is
                 -- pinned to a recipe, so a rate per position would be a number this lane does not owe
                 -- anyone. `shortage` DOES pin a position -- to the candidate that happens to be the
                 -- i-th most short -- so the row says what one hand on that position is worth, which is
                 -- the same capacity figure it was under `split`, and not a promise about what it will
                 -- actually build this minute.
                 if hands > 0 and bus_mode ~= "rotate" then
                   local rec = db.recipes[r]
                   local item, amount = nil, nil
                   for _, pr in ipairs((rec or {}).products or {}) do
                     if pr.name and pr.type ~= "fluid" and not item then
                       item, amount = pr.name, pr.amount
                     end
                   end
                   local e = rec and rec.energy and rat.toNumber(rec.energy)
                   -- the lane's own pricing, in this function's exact idiom -- `p.amount` is a rational,
                   -- and multiplying it as if it were a number is arithmetic on a table, which is the
                   -- answer the engine gives and the reason this block was rewritten once already
                   local one = (item and e and e > 0) and rat.toNumber(rat.mul(
                     rat.div(rat.mul(rat.from(speed), rat.new(60)), rat.from(e)), rat.from(amount or 1)))
                   out[#out + 1] = { recipe = r, item = item, machine_index = i - 1, machines = hands,
                     crafts_per_min = (e and e > 0) and ((speed * 60) / e) or nil,
                     -- one machine's worth, and the whole group's: `per_min` is what a player's single
                     -- hand on this position produces and `per_min_total` is what the hands they put on
                     -- it produce together. Only one of the two is a lane number; the other is the plan.
                     per_min = one, per_min_total = one and (one * hands) or nil,
                     why = (one == nil) and "this recipe's yield or energy could not be priced from the"
                       .. " prototype" or nil }
                 end
               end
               return #out > 0 and out or nil
             end)(),
             why = "machine i takes the i-th scarcest signal on the bus, positions count from 0, and a "
               .. "position past the end of the bus emits nothing -- measured, "
               .. "dev/circuit_rules_probe.js act M",
           } or nil }
end

-- One belt row carries its tier's throughput; a longer spine does not carry more, because
-- every segment of a series has to pass the whole flow. This is the figure the flow
-- arithmetic holds a rate claim against.
lane_of = function(item, tier, spine_tiles, force)
  local b = model().belts[tier]
  -- 这里折进一项我们以前没有的：`(1 + belt_stack_size_bonus)`。它是研究给这条力量的带子加成，
  -- 引擎在 force 上就只给这一个数（helmod 的式子用的也正是它 —— `model/Product.lua` 里
  -- `count / (belt_speed * (1 + belt_stack_size_bonus) * 480 * time)`，而那个 480 与我们的
  -- `speed*8*60` 是同一个常数，刚在这台上对过）。不折进来，同一份产量我们要的带子数就是它的 2/3/4 倍，
  -- 而玩家看到的表现是"helmod 说一条够、你为什么要两条"。
  local bonus = (force and tonumber(force.belt_stack_size_bonus)) or 0
  return {
    item = item, tier = tier, spine_tiles = spine_tiles or 1,
    belt_stack_size_bonus = bonus,
    per_min = b and (b.throughput_per_sec * 60 * (1 + bonus)) or nil,
  }
end

-- "这一股流量要几条带子"，一条公式只有一个地方会算。#35 ③：
--   helmod 的式子是 `条数 = 件数 / (belt_speed × (1 + belt_stack_size_bonus) × 480 × time)`，
--   而 `lane_of().per_min` 就是 `belt_speed × 480 × (1 + bonus)`（件/分），所以按 /分 报的件数直接除它。
-- 取整今天仍是 0.76.0 那一版：**向上贴到半条**（0.4→0.5、0.6→1、0.8→1、1.1→1.5、1.6→2）。
-- 玩家 2026-10-09 口述的那一条（"混用时 0.8 就单独占一整条即可，0.4 占半条，另外半股如果成品数量满足的
-- 话，就可以给成品，这样属于极致节约使用带子"）= **≤0.5 占一股，>0.5 以整条向上**（1.1→2、1.6→2），
-- 这一版**换上去之前必须先做掉它后半句**：那一档多出来的整条要能让给别的流（成品），否则它只多占地面。
-- 实测那一格：electronic-circuit 6 台在 stacked 下，旧律要 4 股（两行，铺得出），新律要 5 股（三行 >
-- 一个面最多两行）→ `LINES_BEYOND_SHAPE`。也就是说单独换这一条会掉覆盖率，所以两处一起换，不换一处。
-- 换的时候只改下面那一行（`math.ceil(need*2)/2` → `need <= 0.5 and 0.5 or math.ceil(need - 1e-9)`；
-- 减那个极小量是因为 helmod 的件数不一定整除，1.0000000002 不该跳到 2），钉表的三处一起跟着走：
-- `dev/layout_ledger.js` 的 BELT_TABLE、`dev/helmod_ghosts_e2e.js` 的取整方向那条、面板那两行话术。
-- 这里只回答 helmod 那一句"要几条带子"；**这一页实际铺几行**仍由几何律决定（股数 ÷ 每行能装几股，
-- 见 `lane_demand` 与 `lane_plan`），两个数并列交出去，不互相替换。
belt_need = function(count_per_min, tier, force)
  local cap = lane_of(nil, tier, nil, force).per_min or 0
  local need = (cap > 0 and tonumber(count_per_min) or 0) / cap
  if cap <= 0 or need < 0 then need = 0 end
  local belts = math.ceil(need * 2) / 2
  return {
    belt = tier, per_min = cap > 0 and cap or nil,
    bonus = (force and tonumber(force.belt_stack_size_bonus)) or 0,
    raw = need, belts = belts, lanes = belts * 2,
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
-- 撤回过一回：删这批入口时把 card_fits/find_card_site 一起剪了，而台架(lab_card)还要它们找一块放得下
-- 整张卡的空地。留下的是「地面放得下吗」这一件事，跟被删的卡片存放/冻结那套门无关。
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
    local minx, miny, maxx, maxy = card_bbox(normalized)
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
lab_surface = function() return prepared_surface(SANDBOX_SURFACE) end

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

-- The box a player dragged is one fact, so it has one reader: `host.box_bounds`, which `line_watch`
-- goes through too. Two parsers reading it slightly differently is how a scan and a fit once
-- disagreed about the same rectangle.
local scan_bounds = host.box_bounds

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
-- Long enough for a box to have taken a mouthful if the row is sitting on it, and not a fixed wait:
-- the pass ends as soon as every supply tank has given something up. "Given something up" is the whole
-- proof, and a tank only gives when a machine takes -- so a recipe whose item ingredients have to be
-- carried across by an arm (concrete wants five stone bricks) needs the pass to outlast that delivery,
-- not the settle of an already-running machine.
local LAB_PROVE_SETTLE = 600

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
  if not args.card then return fail_key("BAD_ARGS", "m-card-required", nil, "card is required") end

  local normalized = card.normalize(args.card)
  if #normalized.entities == 0 then return fail_key("EMPTY_CARD", "m-no-entities", nil, "no entities") end

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
  -- 端口是箱子留下的，而零箱子的线没有箱子：它靠带子的股道进料、靠带子把成品送走。所以这一道门问的其实
  -- 不是"有没有端口"，而是"台架有没有办法喂进去、读出来"。裸带线头那种线有 —— 卡上带着 `feed_line` 与
  -- `product_line` 的行号（形状自己打的），台架按股插料、在成品带东头接一只收箱读。两样缺一样才真是没法量。
  local lane_laid, product_laid = 0, 0
  for _, spec in ipairs(normalized.entities) do
    if spec.role == "feed_line" then lane_laid = lane_laid + 1 end
    -- 成品要么走独占的成品行，要么走某根进料行借出来的那一股（`product_lane` 打在带子上）——
    -- 两种台架都收得到，所以这一道门两种都算"有成品可读"。
    if spec.role == "product_line" or spec.product_lane ~= nil then product_laid = product_laid + 1 end
  end
  if (#ports_in == 0 or #ports_out == 0) and (lane_laid == 0 or product_laid == 0) then
    return fail_key("CARD_NO_PORTS", "m-measure-ports", nil, "measuring needs at least one in port and one out port",
      { in_ports = #ports_in, out_ports = #ports_out, feed_lines = lane_laid, product_lines = product_laid })
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
  -- Which ground this run stands on, kept as a fact of the job rather than inferred later from a name.
  -- The rig does not care; the number it produces cares a lot: a bench is cleared, level, wired, and
  -- fed by a patch laid out for the test, so a rate measured there is a rate the bench can pay.
  local on_bench = args.surface == nil
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
  -- One policy call, at the top: a warp that has to be refused because somebody is playing must
  -- be refused before the rig exists, not after the entities are placed and the ore is gone.
  local speed, warp_refused = host.clock_policy(args.speed)
  if warp_refused then return warp_refused end

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
    local function reserve(pos)
      local k = pos.x .. "," .. pos.y
      if seen[k] then return end
      seen[k] = true
      probe.entities[#probe.entities + 1] = { name = "storage-tank", position = pos }
    end
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
              reserve { x = host.position.x + side[1], y = host.position.y + side[2] }
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
    return fail_key("NO_CLEAR_SITE", "m-no-site-bench", nil, "no candidate site fits this card on the bench; pass an explicit origin",
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

  -- A refusal from here on takes the supply down with the card. `verify.destroy` only knows what the
  -- card put up, and the interface is not in that record -- it goes into `ents_array`, which only the
  -- success path ever hands to `lab_reset`. And the leak is self-concealing: the second refusal's
  -- `create_entity` lands on the first one's square and returns nil, so one left-behind interface is
  -- all a suite can ever show.
  local function refuse_lab(result)
    verify.destroy(built)
    for _, g in ipairs(gens) do
      if g.valid then g.destroy() end
    end
    return result
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

  -- A fluid port cannot be served by a chest. Which cell of which face a box sits on is readable
  -- (`ports.lua`, and on a standing machine `fluidbox.get_prototype(i)` -- both checked against a
  -- player's refinery); what is not readable is which of a recipe's fluid lines a modded machine
  -- assigns to which box, so no fluid fixture is placed here. The job opens in `probing`, offers a
  -- little of each ingredient at one cell at a time until a cell takes it, and only then builds its
  -- supply runs -- against cells rather than guesses, because a machine whose two ingredients share
  -- one face cannot be fed by two rows that each cover the whole face.
  --
  -- Products are the same problem backwards, and need no plumbing at all: 2.0 lets a script take
  -- what a machine's own boxes hold, so the reading is the box. A collector laid on a guessed face
  -- puts a ceiling on the number and hides it as a slow card.
  local feeds, collect, unwired = {}, {}, {}
  local fluid_want, fluid_out = {}, {}
  -- Which of this card's own parts is the inlet of each fluid on each machine. A lane that laid its
  -- own water row has already run a pipe to the cell its box sits on and ended it at a port for the
  -- player's network; the rig's job then is a reservoir, not a second row of pipes.
  local fluid_row = {}
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
        if port.row_port then
          local rows = fluid_row[port.entity]
          if not rows then
            rows = {}
            fluid_row[port.entity] = rows
          end
          -- The face travels with the port: it is the axis the row runs along, and the tank has to
          -- stand beyond the port on that line -- which is the one thing its position alone cannot say.
          rows[port.fluid] = { row = port.row_port, face = port.face }
        end
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
  -- 零箱子的线（裸带线头）没有 in-port 可灌，但它可以被喂：玩家在那根带子的尾巴上接自己的总线，台架就做
  -- 同一件事 —— 在每根进料带的最西一格，把牌上点了名的那种料插进对应的那一股。没有这一手，"这条线在
  -- 生产"就只剩形状层的一句注释；有了它，台架量的是铺出来的那种线，而不是恰好有箱子的那种。
  --
  -- 行号与股号读卡自己带的标记（`role`/`line` 是形状铺的时候打上的，牌上那份清单说的是同一套号），
  -- 不在台架这边另记一份 —— 两份行号迟早会各说一套。
  local lane_feeds = {}
  -- 只看"这条线没有 in-port 可灌"，不看它带不带液体义务。把两个条件写在一起的那版，让一条喝水的线
  -- 永远拿不到固料：机器 `no_ingredients`、一口水都不喝，于是**证明水管那一趟**读到的就是"这一排水一点没动",
  -- 报出 `CARD_ROW_NOT_FED`——"管子没接到机器身上"，而管子明明接着（机器那只箱体里 200 水满着）。
  -- 台架自己没喂料，却说人家管道画错了，这是这台机器最坏的一类谎：它把仪器的手速说成地上的事实。
  if #feeds == 0 then
    local west = {}
    for idx, spec in ipairs(normalized.entities) do
      local rec = built[idx]
      if rec and rec.entity and rec.entity.valid and spec.role == "feed_line" then
        local key = tostring(spec.line or 0)
        local e = rec.entity
        if not west[key] or e.position.x < west[key].position.x then west[key] = e end
      end
    end
    for _, spec in ipairs(normalized.entities) do
      if spec.role == "head" and spec.circuit and spec.circuit.emitter then
        for _, sig in ipairs(spec.circuit.emitter) do
          local lane = tonumber(sig.count) or 0
          local belt = west[tostring(math.max(1, math.ceil(lane / 2)))]
          if belt and belt.valid and sig.name then
            lane_feeds[#lane_feeds + 1] = { belt = belt, item = sig.name,
              line = ((lane - 1) % 2) + 1, lane = lane }
          end
        end
      end
    end
  end
  -- 成品也要有地方去：这种线的成品走在带子上，带子塞满了线就停 —— 那时量出来的 0 是台架的错，不是线的
  -- 错。所以在每根成品带上接取货臂和收箱（台架的管道，和 gens 同一类，收尾一起拆）。
  local drain_err, drain_count, arm_min = nil, 0, 0
  local VEC = { [defines.direction.north] = { 0, -1 }, [defines.direction.east] = { 1, 0 },
    [defines.direction.south] = { 0, 1 }, [defines.direction.west] = { -1, 0 } }
  local FACE = {}
  -- 向量当键要先归一化：`-0 .. ""` 在 Lua 里是 "-0"，和 "0" 不是同一个串（第一次量的时候两只收臂全都
  -- 朝西站在带子北边，取的是自己身侧那一格空地，量到 0/分 —— 位置对、朝向差一个象限，读数就是零）。
  local function vkey(x, y) return (x == 0 and 0 or x) .. "," .. (y == 0 and 0 or y) end
  for d, v in pairs(VEC) do FACE[vkey(v[1], v[2])] = d end
  if #lane_feeds > 0 then
    local east, line_count = {}, 0
    for idx, spec in ipairs(normalized.entities) do
      local rec = built[idx]
      -- 成品要么走独占的成品行（`role == "product_line"`），要么走某根进料行借出来的那一股
      -- （共用那一行：带子身上打着 `product_lane`/`product_item`）。两种都要在下游接走，否则带子塞满、
      -- 线停住，量到的 0 是台架的错。
      local carries_product = spec.role == "product_line" or spec.product_lane ~= nil
      if rec and rec.entity and rec.entity.valid and carries_product then
        local key = tostring(spec.line or 0)
        local e = rec.entity
        local v = VEC[e.direction] or { 1, 0 }
        local along = e.position.x * v[1] + e.position.y * v[2]
        -- 行进方向上最后那一格（竖过来的卡是南头）、带子自己的型号和朝向：延段要按同一档带子铺，
        -- 换一档就在台架里造出第二个瓶颈，量到的数没人知道是谁限的。
        if not east[key] then line_count = line_count + 1 end
        if not east[key] or along > east[key].along then
          east[key] = { x = e.position.x, y = e.position.y, dir = e.direction, belt = spec.name,
            item = spec.product_item, along = along }
        end
      end
    end
    -- 一条线上只挂一只收臂，量出来的数就是**台架**的上限，不是这条线的。实测：40 台石炉一条 750/分的线
    -- 量到 150.9/分、`starved_furnaces=0` —— 那 150 是一只 fast-inserter 一分钟能搬走的件数。所以收臂的
    -- 只数按"这条线一分钟要搬走多少"除上一只臂量到的速率算，算不出一只臂的速率时只挂一只并且说出来。
    --
    -- 产物名与需求从这张卡的契约里拿（`contract.outputs` 的 key 是产物名，value 是每分钟件数）。这里从前
    -- 查的是 `product` —— 那个名字在本函数里**没有 local 过**（它是另一节的局部变量），于是查的是
    -- `measured_arm_row(nil, ...)`，永远量不到；求和写的又是 `pairs(contract)`，里面只有 `outputs` 一个
    -- 子表，`tonumber(表)` 是 nil → 需求 0 → 每条线一只臂。两处叠在一起，40 台那条线一直量到 310/分。
    local drain_item, drain_rate, claim = nil, -1, 0
    for item, per_min in pairs((normalized.contract or {}).outputs or {}) do
      local rate = tonumber(per_min) or 0
      claim = claim + rate
      if rate > drain_rate then drain_rate = rate drain_item = item end
    end
    local drain_row = drain_item and measured_arm_row(drain_item, "fast-inserter") or nil
    arm_min = drain_row and (drain_row.items_per_min or 0) or 0
    local per_line = (line_count > 0) and (claim / line_count) or claim
    local want = arm_min > 0 and math.max(1, math.ceil(per_line / arm_min)) or 1
    local drains = math.min(8, want)
    -- 摆法：每根成品带沿自己的行进方向多铺一段延段，收臂站在延段**外侧**那一列（左转 90° 的那一面）,
    -- 箱子再往外一格；各条线的延段长度按线序递增（第 e 条铺 e*drains 格），所以第 e 条的臂站的那一列,
    -- 是它北边那条够不着的地面。错开是必须的：一个取货点只站得下一只臂，而"往东头退两格"的第二只臂
    -- 只能站进带子自己那一格 —— 从前写的 `at.x - 2*k` 就是这么放的，k>=1 一只都放不下去（只在最后一只
    -- 失败时留一句 `drain_err`，读的人看不见上限在哪儿），于是一条线永远只有 150/分。
    local order = {}
    for _, at in pairs(east) do order[#order + 1] = at end
    -- 一条卡上所有成品带同向，所以先从任意一根拿到行进单位向量 t，再按"站在 t 左转 90° 那一面"的法线
    -- n 给线排序：离 n 方向最近的那条铺得最短（它的臂站的位置是机器行/臂行，本来就是空地），往后每条
    -- 都比前一条多铺 drains 格，于是第 e 条的臂站的列恰好是前一条铺不到的地方。
    local t = VEC[(order[1] or {}).dir or defines.direction.east] or { 1, 0 }
    local n = { t[2], -t[1] }
    local face_back = FACE[vkey(-n[1], -n[2])] or defines.direction.west
    table.sort(order, function(a, b)
      return (a.x * n[1] + a.y * n[2]) > (b.x * n[1] + b.y * n[2]) end)
    for e, at in ipairs(order) do
      local cx, cy = math.floor(at.x + 1e-6), math.floor(at.y + 1e-6)
      local run = e * drains
      for j = 1, run do
        local b = surface.create_entity { name = at.belt, force = force.name, direction = at.dir,
          position = { x = cx + t[1] * j + 0.5, y = cy + t[2] * j + 0.5 } }
        if b then
          ents_array[#ents_array + 1] = b
        elseif not drain_err then
          drain_err = "could not extend a product line to reach its collectors"
        end
      end
      for j = run - drains + 1, run do
        local ax, ay = cx + t[1] * j + n[1], cy + t[2] * j + n[2]
        local chest = surface.create_entity { name = "steel-chest", force = force.name,
          position = { x = ax + n[1] + 0.5, y = ay + n[2] + 0.5 } }
        local arm = surface.create_entity { name = "fast-inserter", force = force.name,
          direction = face_back, position = { x = ax + 0.5, y = ay + 0.5 } }
        if chest and arm then
          pcall(function() arm.direction = face_back; arm.rotatable = false end)
          -- 这一行是借来的那一股时，收臂必须只认成品：取货两股都能取（`dev/shared_row_probe.js`），
          -- 不筛选就会把隔壁那股上的料一路抽走，机器饿着，量到的产率是台架造成的。
          if at.item then pcall(function() arm.set_filter(1, at.item) end) end
          collect[#collect + 1] = { entity = chest, baseline = {} }
          ents_array[#ents_array + 1] = chest
          ents_array[#ents_array + 1] = arm
          drain_count = drain_count + 1
        else
          drain_err = "could not put a collector alongside a product line ("
            .. tostring(drains) .. " wanted per line, " .. tostring(drain_count) .. " placed)"
          if chest and chest.valid then chest.destroy() end
          if arm and arm.valid then arm.destroy() end
        end
      end
    end
    -- 延段、收臂、收箱都进了 `ents_array`（= `storage.lab.ents`），所以量完按句柄拆；它们站在形状之外的
    -- 地面上，地扫那一手（`rig_site`）归 lab_card/lab_start 那两条在玩家存档上跑的路，这条只在 arch-lab
    -- 上铺。`drain_err` 说的是这只臂放不下去：那不是"这条线不快"，是仪器不够，读数里要看得见。
  end
  if #feeds == 0 and fluid_obligations == 0 and #lane_feeds == 0 then
    return refuse_lab(fail_key("CARD_NO_FEEDS", "m-no-feeds", nil,
      "no in port resolved to an entity that is not already internal", { unwired_inputs = unwired }))
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
    return refuse_lab(fail(bound_err.code, bound_err.msg, bound_err))
  end

  -- A machine only takes fluid when a craft STARTS, so the proving pass -- whose whole job is to see a
  -- supply give something up -- cannot begin until the recipe's ITEM ingredients are in the machine.
  -- Fuel gets the same kind of help from the rig (it is seeded, then topped), and an assembler whose own
  -- arm is still walking five stone bricks down a belt idles for the same reason a burner with no coal
  -- does: measured on a concrete lane, twelve seconds of proving left `item_ingredient_shortage`, an
  -- empty input, and a supply that had not lost a unit. 2.0.77 wants iron ore AND stone brick for
  -- concrete, so the recipe's own list is read here rather than the card's first in-port.
  --
  -- Exactly ONE craft's worth, which is not a rounding preference: whatever the rig puts into a machine
  -- is output the lane did not deliver with its own belts, and it lands in the window's rate. Four crafts
  -- per machine measured 147 a minute against a card claiming 135; one craft is ten units over a
  -- sixty-second window -- the difference between proving a machine can drink and paying for its thirst.
  local seeded = {}
  if fluid_obligations > 0 then
    for _, b in ipairs(bound) do
      local rec = built[b.at]
      local r = rec and db.recipes[b.recipe]
      if r and r.ingredients then
        local inv
        pcall(function() inv = rec.entity.get_inventory(defines.inventory.assembling_machine_input) end)
        if inv then
          local gave = {}
          for _, i in ipairs(r.ingredients) do
            if i.type ~= "fluid" and i.name then
              local want = math.max(1, math.ceil(rat.toNumber(i.amount)))
              local got = 0
              pcall(function() got = inv.insert { name = i.name, count = want } or 0 end)
              if got > 0 then gave[#gave + 1] = { item = i.name, count = got } end
            end
          end
          if #gave > 0 then seeded[#seeded + 1] = { at = b.at, machine = b.machine, gave = gave } end
        end
      end
    end
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
      elseif (fluid_row[idx] or {})[fluid] then
        -- The card carries its own inlet row to this machine's box, so the rig does not have to find
        -- the box at all: it fills the pipe the card already laid. The row is part of what is being
        -- measured -- a lane whose own plumbing cannot carry water is a lane that cannot be built.
        local own = fluid_row[idx][fluid]
        ob.source, ob.row, ob.face = "card_row", own.row, own.face
        known[#known + 1] = ob
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
    local first = unwanted[1]
    return refuse_lab(fail("FLUID_NOT_AN_INGREDIENT", first.fluid .. " is an in port of " .. first.entity
      .. " running " .. tostring(first.recipe) .. ", which does not take it",
      { not_ingredients = unwanted, recipe = first.recipe }))
  end
  local function by_position(a, b)
    return a.at < b.at or (a.at == b.at and a.fluid < b.fluid)
  end
  table.sort(queue, by_position)
  table.sort(known, by_position)

  storage.lab = {
    id = (storage.lab and storage.lab.id or 1000) + 1,
    mode = "submitted",
    -- Whether this run is on the bench or on ground the caller named. The rig does not care; the number
    -- it produces cares a lot -- a bench is cleared, level, wired, and fed by a patch laid out for the
    -- test -- so the fact travels with the job and comes back in every later answer about it.
    on_bench = on_bench,
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
    -- 台架自己的天花板挂在**任务记录**上而不是 rig 上，因为 rig 在量完就被拆掉了（`finalize_lab` 把
    -- `j.rig` 置 nil），而"这次量到的数最高只能到多少"这件事要能在读数之后还 answering 得出来。
    -- 收臂的只数 × 一只臂量到的件数/分 = 这次读数的上限；`unknown` 是这个安装里从没量过这一档臂搬这一种料,
    -- 所以只挂了一只臂 —— 那种情况下读数低只说明仪器不够，不说明这条线不够。
    drain = {
      arms = drain_count,
      per_arm_min = arm_min > 0 and arm_min or nil,
      ceiling_per_min = arm_min > 0 and drain_count * arm_min or nil,
      unknown = arm_min <= 0 and true or nil,
      why = drain_err,
    },
  }
  storage.lab.ents = ents_array
  storage.lab.rig = {
    feeds = feeds, collect = collect, gens = gens,
    -- 裸带线头那套：按股插料的进料带（keep_supplied 每 tick 补），以及成品带东头那只收箱（在 collect 里，
    -- 所以读数走的是同一条路 —— 不需要另一个"读产物"的分支）
    lane_feeds = lane_feeds,
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
  -- kept on the job so that every later answer -- status, verdict, keep -- can say what the world was
  -- run at while it was measured, which is the fact a player needs to trust the number
  storage.lab.clock_speed = speed
  storage.lab.clock_seconds = seconds

  return {
    clock = host.clock_note(speed, seconds),
    bench = on_bench,
    surface = field(surface, "name"),

    job = storage.lab.id, state = storage.lab.state, card_name = normalized.name,
    entities = #ents_array, origin = origin, run_ticks = window,
    speed = speed, contract = contract, expected_per_min = expected_total,
    supplied_grid = #gens > 0, ideal_grid = ideal_grid,
    feeds = #feeds, collectors = #collect,
    fluid_obligations = fluid_obligations, fluid_products = next(fluid_out) and true or nil,
    unwired_inputs = #unwired > 0 and unwired or nil,
    fuel = fuel, fuelled_machines = fuelled,
    recipes_bound = bound,
    -- said because it is the rig putting items into a machine, and a caller who cannot see it would
    -- read a first craft as the lane's own belts having arrived
    ingredients_seeded = #seeded > 0 and seeded or nil,
    box_table_served = #known > 0 and #known or nil,
  }
end

-- Both deliverables come from the same geometry: a shareable compressed string and
-- in-game ghosts. There is no blueprint item on the ground in a headless server, so
-- the string is produced through an off-screen inventory holding a blueprint stack.
-- 一块牌上该写什么，只有一个来源：形状打在那件面板上的 `sign_lanes`（`{item, lane, kind}`，一条一股）。
--
-- 股号前面那一个箭头说的是**这股往哪边走**，与语言无关（`→` = 往机器里、`←` = 从机器出来）：
-- 玩家 2026-10-09 要的就是这一格 —— 一行带子两股，一股进料、一股走成品，光看图标分不清哪股是给机器的、
-- 哪股是机器吐的。箭头选成符号而不是"进/出"两个字，是因为牌是世界里的物件、只写一份字，
-- 而这一份字要同时给中文与英文玩家看。
--
-- 2.0 没有把面板的内容关掉，它只是**换了形状**。这台构建上量过（2026-10-08，27016）：
--   * 方法式的那个没了 —— `cb:set_message(-1, {...})` / `set_condition(1, t)` / `set_output(1, t)` 一律
--     "Arguments count error ... Expected 2 arguments but 3 were given"，`add_condition(t)` 报 bad self；
--   * 整表写这一条是吃的 —— 活面板 `cb.messages = { {text=.., icon=} }` 写进去读得回来，同一句打在
--     `inner_name` 的虚影上也成立（写完读回是那份清单）；组合器那边是 `cb.parameters = {conditions=,outputs=}`；
--   * 蓝图那一路走的是 record 上的 `control_behavior.parameters`，而它这次**不是**只被接受不回显：
--     `export_stack` 的 JSON 里有字，`get_blueprint_entities` 也读得回来（0.66.1 那句"读取有损"是在
--     只试了 `decider_conditions` 与旧键名 `connections` 时说的）；
--   * 连线也带得出去，但只有一种拼法：record 上的 `wires` 是**四元组的表** `{ {源件号, 源口, 目标件号,
--     目标口} }`（这一台的口号：circuit_red 1 / circuit_green 2 / combinator_input_red 1 /
--     combinator_output_red 3 / combinator_output_green 4），落地成蓝图根上的 `"wires":[[1,3,2,1]]`。
--     写成字典报 "Value must be a list"，写在件表外面（与件同级的 `wires`）报 "must be a dictionary at
--     ROOT.wires"，而口号写错（比如 4 以上那种不存在的口）是**收下并静默丢掉** —— JSON 里一个字都不剩。
local SIGN_MARK = { feed = "→", product = "←" }   -- → 往机器里（进料），← 从机器出来（成品）
sign_mark = function(kind) return SIGN_MARK[tostring(kind or "")] or "" end

local function sign_messages(lanes)
  local msgs = {}
  for _, l in ipairs(lanes or {}) do
    if l.item then
      local mark = sign_mark(l.kind)
      msgs[#msgs + 1] = { text = (mark == "" and "" or (mark .. " ")) .. tostring(l.lane),
        icon = { type = "item", name = l.item } }
    end
  end
  return msgs
end

-- 把那份清单写进这块牌，并且**数出来**：写了几块、第一块写不进去的原因是什么。
-- 计数而不是假设的理由是这一串改动的前身就干过假设的事 —— 它交回来的答案说"两块牌写好了股道号"，
-- 地上是两块空的，玩家只能自己打字，而答案不说明。
local function fill_sign(ent, lanes)
  local msgs = sign_messages(lanes)
  if #msgs == 0 then return 0, nil end
  local ok, cb = pcall(function() return ent.get_or_create_control_behavior() end)
  if not ok or not cb then return 0, "no control behaviour: " .. tostring(cb) end
  local took, err = pcall(function() cb.messages = msgs end)
  if not took then return 0, tostring(err):sub(1, 160) end
  local read, back = pcall(function() return cb.messages end)
  if not read or type(back) ~= "table" or #back < #msgs then
    return 0, string.format("written but reads back %s of %d",
      tostring(read and type(back) == "table" and #back or 0), #msgs)
  end
  return 1, nil
end

-- `ok and nil or x` is not "nil when it worked" -- Lua reads that as "always x" -- so the refusal
-- message is built by a function whose one job is to answer nil on success.
local function refusal(ok, err)
  if ok then return nil end
  return tostring(err):sub(1, 120)
end

-- 意图写在件身上：一份 `circuit` 意图，两条落地路（虚影/活件走 `cb.parameters`，蓝图 record 走引擎自己
-- 的字段名）。两套拼法都是这一台构建上一格一格量出来的（2026-10-09，27016）：
--   * 活件与虚影都吃 `get_or_create_control_behavior().parameters = {...}`，写完读得回来。判定盒的
--     `conditions`/`outputs` 在 Lua 这一侧必须是**列表**（写成字典是 "Value must be a list in property
--     tree at ROOT.conditions"）；输出那一格必须带 `copy_count_from_input = false` —— 默认是按输入的数量
--     复制，而独自站着的发射器输入是空的，0 又根本不上线，于是一份"看起来写了"的配置一件都不发。
--   * 选择器两种模式：`{operation="select", index_constant=<0 起>, select_max=}` 与
--     `{operation="random", random_update_interval=<ticks>}`。随机那一档的键名是量的：`interval`、
--     `interval_constant`、`duration`、`ticks`、`count`、`index` 全被"收下并丢掉"（读回来只剩
--     `{operation="random"}`），只有这个留得住。
--   * 算术盒 `{first_constant=, second_signal=, operation="-", output_signal=}`：被减的是货架上那件**料**，
--     写出去的是**配方**信号（两种信号、两个类型，减法是唯一能从一种走到另一种的操作）。
--   * 机器那一头是 `cb.circuit_set_recipe = true`（活件与虚影都吃得，实测读回 true）。
-- 蓝图 record 那一路的拼法**不一样**，也是量的（每种都回读一遍导出的 JSON 才敢写）：判定盒要包在
-- `decider_conditions` 里、算术盒要包在 `arithmetic_conditions` 里（顶层平铺 `conditions`/`outputs` 会被
-- 收下又清空，回读是 `[{}]`），选择器反倒要**平铺**（包进 `parameters`/`settings` 就丢回默认值）。
-- 唯一带不出去的是机器那一格"从电路网络读配方"：七种拼法（`circuit_setting` 1/2、`circuit_reading`、
-- `read_recipe_from_wire`、`recipe_from_wire`、`use_recipe_from_wire`、平铺 `circuit_set_recipe`、
-- `parameters.circuit_set_recipe`）在 record 上一律回读为空。所以蓝图那一扇门交出去的是"组合器都配好了、
-- 线都画好了、机器还没答应听话"，而这句话必须写在答案里，不是等玩家粘完才发现每台要自己勾一次。
local function circuit_outputs(list)
  local out = {}
  for _, sig in ipairs(list or {}) do
    out[#out + 1] = { signal = { type = sig.type or "item", name = sig.name },
      constant = tonumber(sig.count) or 1, copy_count_from_input = false }
  end
  return out
end

-- 一件组合器的意图换成引擎那一格 `parameters` 的表；机器（只有 `recipe_control`）答 nil。
local function circuit_parameters(spec)
  if type(spec) ~= "table" then return nil end
  if spec.emitter then
    return { conditions = { { comparator = "<", constant = 1 } }, outputs = circuit_outputs(spec.emitter) }
  end
  if spec.deficiency then
    local d = spec.deficiency
    return { first_constant = math.floor(tonumber(d.target) or 0),
      second_signal = { type = "item", name = d.item }, operation = "-",
      output_signal = { type = "recipe", name = d.recipe or d.item } }
  end
  if spec.select then
    return { operation = "select", select_max = spec.select.max and true or false,
      index_constant = math.floor(tonumber(spec.select.index) or 0) }
  end
  if spec.rotate then
    return { operation = "random", random_update_interval = math.floor(tonumber(spec.rotate) or 20) }
  end
  return nil
end

-- 蓝图 record 上那一格，同一份意图的另一套字段名。
local function record_behavior(spec)
  if type(spec) ~= "table" then return nil end
  if spec.emitter then
    return { decider_conditions = { conditions = { { comparator = "<", constant = 1 } },
      outputs = circuit_outputs(spec.emitter) } }
  end
  if spec.deficiency then
    local d = spec.deficiency
    return { arithmetic_conditions = { first_constant = math.floor(tonumber(d.target) or 0),
      second_signal = { type = "item", name = d.item }, operation = "-",
      output_signal = { type = "recipe", name = d.recipe or d.item } } }
  end
  if spec.select then
    return { operation = "select", select_max = spec.select.max and true or false,
      index_constant = math.floor(tonumber(spec.select.index) or 0) }
  end
  if spec.rotate then
    return { operation = "random", random_update_interval = math.floor(tonumber(spec.rotate) or 20) }
  end
  return nil
end

-- 写下去，并且**读回来数**：交回"写成了几格意图"与第一格没写成的原因。假设写成了是这一串改动的前身
-- 干过的另一件事 —— 答案说"控制带配好了"而地上是一件都没配置的组合器，玩家只能自己一台台点开看。
local function apply_circuit(ent, spec)
  if type(spec) ~= "table" then return 0, nil end
  local okc, cb = pcall(function() return ent.get_or_create_control_behavior() end)
  if not okc or not cb then return 0, "no control behaviour: " .. tostring(cb) end
  local wrote, why = 0, nil
  if spec.recipe_control then
    local ok, err = pcall(function() cb.circuit_set_recipe = true end)
    local back = nil
    pcall(function() back = cb.circuit_set_recipe end)
    if ok and back == true then
      wrote = wrote + 1
    else
      why = why or refusal(ok, err) or ("read back " .. tostring(back))
    end
  end
  local params = circuit_parameters(spec)
  if params then
    local ok, err = pcall(function() cb.parameters = params end)
    local back = nil
    pcall(function() back = cb.parameters end)
    if ok and back ~= nil then
      wrote = wrote + 1
    else
      why = why or refusal(ok, err) or "does not read back"
    end
  end
  return wrote, why
end

-- 回读那一路**数得出多少**：引擎把 record 交回来时，嵌套列表的行是空表（`get_blueprint_entities` 只保证
-- "有几行"，行里的字段要玩家粘下去那一刻才由引擎自己填回来；`export_stack` 的 JSON 里那些字段是全的一
-- 身，但 Lua 这一侧解不开那个压缩串，所以那份核对属于门禁）。于是这里的判据是能对上的那部分：选择器对
-- 位次、算术盒对被减的那个数、判定盒对"有没有那一行输出"。对不上就是没带住，不猜。
local function behavior_carried(written, back)
  if type(back) ~= "table" then return false end
  if written.decider_conditions then
    local o = back.decider_conditions and back.decider_conditions.outputs
    return type(o) == "table" and #o >= 1
  end
  if written.arithmetic_conditions then
    local a = back.arithmetic_conditions
    return type(a) == "table"
      and tonumber(a.first_constant) == tonumber(written.arithmetic_conditions.first_constant)
  end
  if written.operation == "select" then
    return tonumber(back.index_constant) == tonumber(written.index_constant)
  end
  if written.operation == "random" then
    return tonumber(back.random_update_interval) == tonumber(written.random_update_interval)
  end
  return false
end

-- 蓝图 record 上的连线只有一种拼法（这台构建上量的，2026-10-08）：件上的 `wires` 是**四元组的表**
-- `{ {源件号, 源口, 目标件号, 目标口} }`，落地成蓝图根上那条 `"wires":[[1,3,2,1]]`。
-- 写成字典 → "Value must be a list in property tree at ROOT[0].wires"；写在件表外面（与件同级的 `wires`）
-- → "Value must be a dictionary in property tree at ROOT.wires"；而**口号写错是静默丢掉** —— 写进去不报错，
-- 导出的 JSON 里一个字都不剩。所以这里的口一律从 `defines` 读，不抄数字（这一台：circuit_red 1 /
-- circuit_green 2 / combinator_input_red 1 / combinator_input_green 2 / combinator_output_red 3 /
-- combinator_output_green 4）。目标那一头不分机器还是组合器：`circuit_*` 与 `combinator_input_*`
-- 在这一台是同一对数，两个都对。
local function wire_endpoints(name, color)
  local d = defines.wire_connector_id
  local dst = (color == "red") and d.circuit_red or d.circuit_green
  local src = (color == "red") and d.combinator_output_red or d.combinator_output_green
  if not roles.is_combinator(name) then src = dst end
  return src, dst
end

local function blueprint_specs(entities, recipe, wires)
  local specs = {}
  for i, e in ipairs(entities or {}) do
    local s = {
      entity_number = i, name = e.name, direction = e.direction or 0,
      position = { x = e.position.x, y = e.position.y },
    }
    -- The recipe travels with the machine. A lane of 电路板 laid as a blueprint of bare assemblers is a
    -- plan the player then clicks through machine by machine to make it run -- 15 assemblers, 15 clicks,
    -- and every one of them idling until the last. `set_blueprint_entities` takes a `recipe` per record
    -- (the same field the game writes when you copy a set-up line), so the plan says what each machine
    -- crafts. Only for a machine that can be TOLD: a furnace has no setter at all and answering
    -- `Entity is not assembling-machine` inside the write would fail the whole blueprint.
    if (e.recipe or recipe) and takes_recipe(e.name) then s.recipe = e.recipe or recipe end
    -- 臂的筛选带进蓝图 record：2.0 这一台只认 `filters = {{index = 1, name = …}}` 配 `items_to_filter`
    -- 那一种写法 —— `filter = "…"` 字符串写得进去但回读为空、导出的文字里也没有那项（等于没带），
    -- `filters = {{item = …}}` 直接报 `Key "index" not found`。量的那一轮见 `dev/arm_filter_probe.js`。
    if e.filter then
      s.filters = { { index = 1, name = e.filter } }
      s.items_to_filter = 1
    end
    -- 牌的字跟着件走：蓝图 record 上这一格叫 `control_behavior.parameters`，实测它一路带到
    -- `export_stack` 的 JSON 里，也带得过 `get_blueprint_entities` 的回读 —— 这一路带得住几块，
    -- 由 `blueprint_item` 数出来，不在这里假设。
    local msgs = sign_messages(e.sign_lanes)
    if #msgs > 0 then s.control_behavior = { parameters = msgs } end
    -- 组合器那一圈带着的是**意图**，走的是 record 上另一套字段名（上面注释里量的那几行）：判定盒要包进
    -- `decider_conditions`、算术盒要包进 `arithmetic_conditions`、选择器反倒要平铺。面板与组合器不会同
    -- 一件，所以这里直接覆盖，两支各自数自己的带住没带住。
    local rb = record_behavior(e.circuit)
    if rb then s.control_behavior = rb end
    specs[#specs + 1] = s
  end
  -- 卡上那份 `wires` 是"哪件的哪一头接到哪件"，件号是卡内部的 1..N —— 而 record 的编号就是这里的
  -- `i`，同一个顺序，所以直接搬。搬不动的那种（一端不在这批件里）不静默补线，也不静默丢：
  -- 它由 `blueprint_item` 数的 `asked` 与回读数的 `carried` 那个差说出口。
  for _, w in ipairs(wires or {}) do
    local a, b = specs[w.from], specs[w.to]
    if a and b then
      local src, dst = wire_endpoints(a.name, w.color)
      a.wires = a.wires or {}
      a.wires[#a.wires + 1] = { a.entity_number, src, b.entity_number, dst }
    end
  end
  return specs
end

-- A ghost that carries its recipe. Measured on this build: `entity-ghost` answers no `recipe` key, but
-- `set_recipe` on it succeeds and the ghost that the player then builds keeps the assignment -- which is
-- the difference between a lane that starts and a row of machines waiting to be told. Counted and
-- reported rather than assumed, because 2.0 accepts a recipe the force cannot craft and answers nil for
-- it later; a lane where none of it took is a fact the answer has to carry.
local function set_ghost_recipe(ent, name, recipe)
  if not (ent and recipe and takes_recipe(name)) then return nil end
  local ok, err = pcall(function() return ent.set_recipe(recipe) end)
  if not ok then return nil, tostring(err) end
  return true
end

-- A real blueprint item, authored by script, sitting in an inventory nobody can see. It is real rather
-- than a table because the engine is the only thing that knows what it will accept: the caller gets the
-- inventory back only if the write AND the read of the same stack agree on how many entities survived.
-- A blueprint that silently dropped half a lane would paste as a half lane.
local function blueprint_item(entities, label, description, recipe, wires)
  local inv = game.create_inventory(1)
  local signs, lines, ring, filters = {}, {}, {}, { asked = 0, carried = 0 }
  local ok, err = pcall(function()
    inv.insert { name = "blueprint", count = 1 }
    local st = inv[1]
    local specs = blueprint_specs(entities, recipe, wires)
    st.set_blueprint_entities(specs)
    if label then st.label = label end
    if description then st.blueprint_description = description end
    local back = st.get_blueprint_entities()
    if not back or #back ~= #specs then
      return error(string.format("engine kept %s of %d entities",
        tostring(back and #back or 0), #specs), 0)
    end
    -- 三样东西各自"要带几件 / 引擎回读带住了几件"：牌的字、组合器的意图、机器那一格"从线上取配方"。
    -- 数的是同一份件表里真写了意图的那几件，而不是 record 上有没有 `control_behavior` —— 面板与组合器
    -- 共用这一格，混在一起数就会把牌算进控制带里去。
    -- 机器那一格在这一路上**一定**是 0：七种拼法实测都回读为空（见 `record_behavior` 上面那段）。这不是
    -- 这里没写，是引擎不接受，所以它单独占一格，而不是悄悄并进 `ring.carried` 里凑数。
    local asked, carried = 0, 0
    local ctrl_asked, ctrl_carried, rc_asked = 0, 0, 0
    for i, e in ipairs(entities or {}) do
      local b = back[i]
      local cb = b and b.control_behavior
      if (e.sign_lanes or {})[1] then
        asked = asked + 1
        local p = cb and cb.parameters
        if p and p[1] and p[1].text then carried = carried + 1 end
      end
      local written = record_behavior(e.circuit)
      if written then
        ctrl_asked = ctrl_asked + 1
        if behavior_carried(written, cb) then ctrl_carried = ctrl_carried + 1 end
      end
      if (e.circuit or {}).recipe_control then rc_asked = rc_asked + 1 end
      -- 臂的筛选也照同一套数法：要带几只、引擎回读还带着料名的那几只。
      if e.filter then
        filters.asked = filters.asked + 1
        local f = b and b.filters and b.filters[1]
        if f and tostring(f.name) == tostring(e.filter) then filters.carried = filters.carried + 1 end
      end
    end
    signs.asked, signs.carried = asked, carried
    ring.asked, ring.carried = ctrl_asked, ctrl_carried
    if rc_asked > 0 then
      ring.recipe_control = { asked = rc_asked, carried = 0,
        why = "a script-authored blueprint cannot carry the machine's own 'read recipes from circuit' "
          .. "flag: seven spellings tried on this build (circuit_setting 1/2, circuit_reading, "
          .. "read_recipe_from_wire, recipe_from_wire, use_recipe_from_wire, flat circuit_set_recipe, "
          .. "parameters.circuit_set_recipe) all read back empty. The ghosts on the ground DO hold it "
          .. "(cb.circuit_set_recipe writes and reads back true), so a pasted page needs the box ticked "
          .. "per machine while a pressed page does not" }
    end
    -- 连线同理，但数法要绕一下：一条线在**两端各自的 record** 上都出现一次，而且是从自己这一头数起的
    -- （实测 record 1 回读出 `{1,1,3,3}`，record 3 回读出同一条的 `{3,3,1,1}`），所以按"两头的集合"去重。
    -- 要的数不能数 `specs` 里挂了几条 —— 挂在两头之一的 record 上、去重之后才是这一页真的有几条线。
    local want, seen = {}, {}
    for _, w in ipairs(wires or {}) do
      if specs[w.from] and specs[w.to] then
        local src, dst = wire_endpoints(specs[w.from].name, w.color)
        want[string.format("%d:%d|%d:%d", w.from, src, w.to, dst)] = true
        want[string.format("%d:%d|%d:%d", w.to, dst, w.from, src)] = true
      end
    end
    local carried_lines = 0
    for _, e in ipairs(back) do
      for _, w in ipairs(e.wires or {}) do
        local key = string.format("%d:%d|%d:%d", w[1], w[2], w[3], w[4])
        if want[key] and not seen[key] then
          seen[key] = true
          carried_lines = carried_lines + 1
        end
      end
    end
    local wanted = 0
    for _ in pairs(want) do wanted = wanted + 1 end
    lines.asked, lines.carried = math.floor(wanted / 2), math.floor(carried_lines / 2)
    if wanted % 2 ~= 0 or carried_lines % 2 ~= 0 then
      lines.problem = "回读到的线数不成双（每条线应在两端各出现一次）"
    end
  end)
  if not ok then
    pcall(function() inv.destroy() end)
    return nil, tostring(err), signs, lines, ring, filters
  end
  return inv, nil, signs, lines, ring, filters
end

-- Where a delivered blueprint lands, and why it is not the player's mouse.
--
-- Two real clients desynced on this button (2026-10-01, `desync-report-2026-10-01_16-21-49` and
-- `..._17-21-02`), and the two reports agree with each other and disagree with every guess I made about
-- them: `script.dat` BYTE-IDENTICAL on both sides (so the plan, the helmod table and our storage all
-- agreed), the client's `next-unit-number` exactly ONE ahead, one chunk's charting tick different. Then
-- the third measurement killed the first diagnosis: with the clipboard door removed the shape was
-- unchanged, and a metered run of the whole press against a real player object -- `card_example`, the
-- helmod read, the authoring, the delivery, even `gui_selftest` dispatching every button -- allocates
-- ZERO entity numbers. So nothing in our Lua touched the world; what is left is the one operation in the
-- press that the ENGINE completes differently for a process that has a mouse: putting a script-authored
-- blueprint INTO THE CURSOR of a connected player.
--
-- So the cursor stayed the player-facing door: it is what they asked for, and it is not what broke. Two
-- things changed instead -- the MEASURED facts moved into `storage` (see `proto_facts`, which is the
-- asymmetry the reports actually describe), and every delivery carries its blueprint TEXT as well, so a
-- door that writes nothing to anybody is always beside it. `into = "pack"` is the no-mouse door.
--
-- One place for the whole deliverable, because `card_carry` and a helmod plan asked for the same door and
-- two copies of an engine dance is how two hands start disagreeing about what arrived.
local function hand_blueprint(player, inv, prefer)
  local authored
  pcall(function()
    local list = inv[1].get_blueprint_entities()
    authored = list and #list or 0
  end)
  local door, landed, kept
  if prefer == "cursor" then
    local ok_set, set_err = pcall(function() player.cursor_stack.set_stack(inv[1]) end)
    pcall(function()
      if player.cursor_stack.valid_for_read then landed = player.cursor_stack.name end
      local list = player.cursor_stack.get_blueprint_entities()
      kept = list and #list or 0
    end)
    if ok_set and landed == "blueprint" then door = "cursor"
    else
      pcall(function() inv.destroy() end)
      return nil, nil, nil, "the hand would not take the blueprint: "
        .. tostring(set_err or ("it holds " .. tostring(landed)))
    end
  else
    local moved
    local ok_ins, ins_err = pcall(function() moved = player.insert(inv[1]) end)
    if ok_ins and (tonumber(moved) or 0) > 0 then door, landed, kept = "pack", "blueprint", authored
    else
      pcall(function() inv.destroy() end)
      return nil, nil, nil, "the pack would not take the blueprint"
        .. (ok_ins and " -- is the inventory full?" or (": " .. tostring(ins_err)))
    end
  end
  pcall(function() inv.destroy() end)
  return door, landed, kept, nil
end

local function blueprint_string(entities, label, recipe, wires)
  local inv, err, signs, lines = blueprint_item(entities, label, nil, recipe, wires)
  if not inv then return nil, err, signs, lines end
  local ok, out = pcall(function() return inv[1].export_stack() end)
  pcall(function() inv.destroy() end)
  if not ok then return nil, tostring(out), signs, lines end
  return out, nil, signs, lines
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

-- The other deliverable: drop a frozen card on the map as ghosts, which costs no
-- materials and is what the player walks up to and confirms.
-- What the mod put into the world, newest last. Every player-facing placement goes through
-- `card_place` (the row button, and `plan_fit`'s ghosts too), so this is the one place that can answer
-- "take that back" without guessing at which machines were ours.
--
-- The record holds the entities themselves, and it holds them in `storage` for the reason the 2026-09-25
-- desync report taught: a fact about the save that lives in a module local is a fact only the process
-- that made it knows. A player may place a line, quit, restart the server, or hand the save to someone
-- else, and 撤銷放置 still has to mean the same thing in the process that loads it.
--
-- Kept short on purpose: this is an undo stack, not a build history, and every entry costs a row in the
-- save. The oldest falls off -- and once it falls off, the mod has no claim to know what it placed.
local UNDO_KEPT = 20
local function note_deployment(entry)
  storage.undo = storage.undo or {}
  local log = storage.undo
  entry.id = (storage.undo_next or 0) + 1
  storage.undo_next = entry.id
  entry.tick = game.tick
  log[#log + 1] = entry
  while #log > UNDO_KEPT do table.remove(log, 1) end
  return entry.id, #log
end

-- Helmod's answer, straight onto the ground.
--
-- Helmod has already done the arithmetic: it knows this plan wants 24 assemblers and 40 furnaces, and
-- nothing here needs to re-prove any of it. So this path deliberately skips every gate the card path
-- has -- no freeze, no lint, no bench measurement, no claim about what the line will deliver -- because
-- the only question left once the numbers exist is where the machines stand. What it does keep is the
-- undo record: laying two hundred ghosts you did not mean to lay has to be one button to put back.
--
-- Where the numbers come from, in this order:
--   * `plan = {...}` -- a caller holding the counts. Both `{{name=, count=}, ...}` and the flat
--     `{"assembling-machine-3" = 24, ...}` spellings read, which is also the way through when the save
--     has no helmod in it at all.
--   * helmod's own cross-mod door. Measured on this install from the mod's source
--     (data/RemoteAPI.lua): it exposes `helmod_interface` with `get_models()` returning its
--     `storage.models` -- the factory tree whose blocks carry `summary_global.factories`, one entry per
--     machine kind with `{name, count, count_limit, count_deep}`.
-- One walker for both doors -- the list a player picks from and the lay that follows the pick. Written
-- once because the two must not disagree about what a helmod factory contains: the picker's numbers are
-- the numbers the lay will use.
--
-- Two rules live here, both from reading helmod's own data layer:
--   * a block's `summary_global` ALREADY counts its children (data/ModelCompute.lua folds each child's
--     summary into the parent's), so a bag is taken once and nothing under it is read as a bag -- doing
--     both bills every machine twice, which a player reads as "it laid 12 for my 6";
--   * the recipe rows are still collected from the whole tree, because they live one level BELOW the
--     block that holds the summary, and a recipe row is the only thing that can become a lane
--     (belts and arms are a function of what a machine builds, not of the machine alone).
-- helmod 那一行自己带的数字，一个都不改写地抄下来：`crafts` 是这一行每 `base_time` 秒做几次工艺（树上的
-- `count`），`base_time` 是那一页显示用的档位，`factory` 整张表要原样交给 `get_recipe` —— productivity、
-- 模块、信标、quality 都折在 `factory.effects` 与 `factory.speed` 里，只给一个机器名它就什么都折不出来。
local function recipe_row(node, recipes, time)
  -- A recipe row is the row that carries a recipe name AND a machine, and it is the only one that can
  -- become a LANE: belts and inserters are a function of what the machine builds, not of the machine
  -- alone. helmod keeps these on the recipe children, one level below the block that holds the summary.
  if type(node.factory) ~= "table" or type(node.name) ~= "string" then return end
  local n = tonumber(node.factory.count)
    or ((tonumber(node.factory.amount) or 0) * (tonumber(node.count) or 0))
  if n and n > 0 then
    recipes[#recipes + 1] = { recipe = node.name, machine = node.factory.name, count = n,
      index = tonumber(node.factory.index),
      crafts = tonumber(node.count),
      -- 单次工艺的能量秒数（`computeFactory` 把它写在行的 `time` 上）。`get_recipe` 折 productivity 时
      -- 要先看见这个数：`Product:getProductivityBonus` 的第一句就是 `if recipe.time == nil then return 0`
      -- —— 少了它，加成那一成就会在原样交回来的数字里悄悄消失（实测：同一条 iron-plate，带 time 折出
      -- 32.4/秒，不带就回 30/秒）。
      craft_energy = tonumber(node.time),
      -- 这一页显示用的档位（1 = 每秒、60 = 每分钟）。实测：`base_time` 由解算器从 `block.time` 抄到
      -- 每一行上（`math/SolverLinkedMatrix.lua:489`），而 `block.time` 来自那一页的 `model.time`
      -- （`data/ModelCompute.lua:111`，默认 1）。一行没带就从祖先块上往下传的那一份接住。
      base_time = tonumber(node.base_time) or tonumber(time),
      quality = node.quality, recipe_type = node.type, factory = node.factory }
  end
end

local function take_bag(node, machines, beacons, modules)
  local bag = node.summary_global or node.summary
  if type(bag) ~= "table" or type(bag.factories) ~= "table" or next(bag.factories) == nil then return false end
  -- The block's global summary ALREADY counts its children (data/ModelCompute.lua folds each child's
  -- `summary_global` into the parent's), so a bag is taken once and its children are NOT read as bags
  -- too -- doing both bills every machine twice, which a player reads as "it laid 12 for my 6".
  for _, e in pairs(bag.factories) do machines[#machines + 1] = e end
  -- Beacons stand on the ground; modules do not (they are items, and they arrive in `modules`).
  for _, e in pairs(bag.beacons or {}) do beacons[#beacons + 1] = e end
  -- 模块这一格从前**没人收**：一页写 80 个速度模块，答案里一个字都没有，而机器数与流量却是按装了模块
  -- 算出来的（`get_recipe` 折的那一份）。收进来不为了铺 —— 实测虚影身上装不了模块：
  -- `ghost.get_inventory(defines.inventory.crafter_modules)` 是 nil，2.0 也没有 `set_module_info`
  -- （真机器是可以的：`real.insert({name="speed-module",count=1})` 回 0 未放入）—— 收进来是为了**说出来**：
  -- 这一页还欠哪几样、各几个、要装在哪台机器上、由谁去装。
  for _, e in pairs(bag.modules or {}) do modules[#modules + 1] = e end
  return true
end

local function walk_recipes(node, recipes, depth, time)
  if type(node) ~= "table" or depth > 8 then return end
  -- 档位写在**块**上（`block.time`，由 `model.time` 抄来）。配方行也有一个 `time`，那是**单次工艺的能量
  -- 秒数**（`computeFactory` 写的），不是档位：一路传下去会把换算基数换成一个配方能量，所以只有块才更新
  -- 往下传的这份档位。
  local passed = time
  if node.class == "Block" or type(node.children) == "table" then
    passed = tonumber(node.time) or time
  end
  recipe_row(node, recipes, passed)
  for _, key in ipairs({ "children", "recipes", "blocks" }) do
    local list = node[key]
    if type(list) == "table" then
      for _, c in pairs(list) do
        if type(c) == "table" and c ~= node then walk_recipes(c, recipes, depth + 1, passed) end
      end
    end
  end
end

local function collect(node, machines, beacons, modules, depth)
  if type(node) ~= "table" or depth > 8 then return end
  -- Once a block's global summary is taken, nothing under it is read as a bag: its children's machines
  -- are already inside the number above. The RECIPE rows are still wanted -- they are collected by
  -- `walk_recipes`, from the model root, over the whole tree exactly once.
  if take_bag(node, machines, beacons, modules) then return end
  for _, key in ipairs({ "children", "recipes", "blocks" }) do
    local list = node[key]
    if type(list) == "table" then
      for _, c in pairs(list) do
        if type(c) == "table" and c ~= node then collect(c, machines, beacons, modules, depth + 1) end
      end
    end
  end
end

-- A model as `get_models()` hands it over is a CONTAINER, not the factory: what was measured on this
-- install (a real iron-plate factory the player built in helmod's GUI) is
-- `models.model_2 = {class="Model", id="model_2", block_root={class="Block", name="iron-plate",
-- summary_global={factories={...}}, children={R1={class="Recipe", factory={...}}}}}`. Reading the bag
-- off the container is what answered "this plan has no machines" to a plan of 48 furnaces -- the
-- numbers were one level down, under `block_root`.
local function factory_root(m)
  if type(m) ~= "table" then return nil end
  if type(m.block_root) == "table" then return m.block_root end
  return m
end

-- One entry point for both doors: the list a player picks from and the lay that follows the pick.
local function collect_machines(node, machines, beacons, recipes, modules)
  local root = factory_root(node)
  if not root then return end
  -- 页的档位先看容器（`model.time`），再看块（`block.time`）：`get_models()` 交出来的 Model 那一层就有，
  -- 而 `updateBlock` 会把它抄到块上，两处都读才不会在只有一处写了的存档上丢掉换算基数。
  walk_recipes(root, recipes, 0, tonumber(node.time) or tonumber(root.time))
  collect(root, machines, beacons, modules or {}, 0)
end

-- helmod 把"这一页要哪些模块"写在两处：块上的 `summary_global.modules`（整页合起来的件数），和机器上的
-- `factory.modules`（**一台**装几种各几个）。两处都要过同一只手：按"名字 + 品质"合起来再按名字排 ——
-- Lua 的哈希序每跑一次都不同，而这份清单是写给玩家一行行对的。
local function merge_item(out, name, quality, count)
  if type(name) ~= "string" or not count or count <= 0 then return end
  local q = type(quality) == "string" and quality or nil
  for _, e in ipairs(out) do
    if e.item == name and e.quality == q then e.count = e.count + count; return end
  end
  local row = { item = name, quality = q, count = count }
  out[#out + 1] = row
end

local function sort_by_name(rows)
  table.sort(rows, function(a, b)
    if a.item ~= b.item then return tostring(a.item) < tostring(b.item) end
    return tostring(a.quality or "") < tostring(b.quality or "")
  end)
  return rows
end

-- 树上那种 `{name, quality, count}` 的汇总行（`summary_global.modules`、`summary_global.beacons`）。
local function tally_bag_rows(rows)
  local out = {}
  for _, e in pairs(rows or {}) do
    if type(e) == "table" then
      merge_item(out, e.name, e.quality, tonumber(e.count) or 0)
    end
  end
  return sort_by_name(out)
end

-- 一台机器上的模块（`factory.modules` 每项的 `amount` = 一台装几个）乘台数。台数是**这一发要铺的**那个，
-- 所以小数台数（helmod 常给 1.6 台）在这里会被 ceil 一次：欠的模块只会多算不会少算，宁可多说不能漏说。
local function line_modules(modules, machines)
  if type(modules) ~= "table" then return nil end
  local n = math.ceil(tonumber(machines) or 0)
  if n < 1 then return nil end
  local out = {}
  for k, v in pairs(modules) do
    local name, amount, quality
    if type(v) == "table" then
      name = type(v.name) == "string" and v.name or (type(k) == "string" and k)
      amount = tonumber(v.amount)
      quality = v.quality
    else
      name = type(k) == "string" and k
      amount = tonumber(v)
    end
    if name and amount and amount > 0 then
      merge_item(out, name, quality, amount * n)
    end
  end
  if next(out) == nil then return nil end
  return sort_by_name(out)
end

-- 模块合计成一句话：`speed-module-2 ×80, productivity-module ×40`。窗口与 RCON 读同一份，别各拼一遍。
local function modules_said(rows)
  local parts = {}
  for _, e in ipairs(rows or {}) do
    parts[#parts + 1] = string.format("%s ×%d", tostring(e.item), math.ceil(tonumber(e.count) or 0))
  end
  return table.concat(parts, ", ")
end

-- 这一行每分钟过几件，向 helmod 要，不再自己乘合成速度。
--
-- helmod 只开两扇门（实测 `data/RemoteAPI.lua`：`get_models()` 与 `get_recipe()`），第二扇就是分子的门：
-- 把树上那一行交进去，它**回填** products/ingredients，每一项带 `count` = 单件量 × 这一行的工艺次数，
-- 而单件量已经折过 productivity、模块、信标、quality（实测：steel-furnace 做 iron-plate、productivity
-- 0.08、30 次/秒 → products.iron-plate.count = 32.4，而 ingredients.iron-ore.count 仍是 30 ——
-- productivity 不多吃料，helmod 也是这么算的；assembling-machine-2 做电路板、+10% productivity、
-- 10 次/分钟 → products.count = 11）。
-- 两处实测来的坑：
--   ① `remote.call` 把表参数**拷贝**过去，所以改写落在**返回值**那份表上，不在我们传出去的那份上；
--   ② 单位是"每 `base_time` 秒"，`base_time` 就是那一页显示用的档位（helmod 的档位表 1s/1min/5min/…，
--      默认 1 = 每秒）。我们对外一律说 /分，所以在这里乘 60/base_time 换成一份，别处不再换第二遍。
-- 燃料那一行（实测带 `burnt=true`：钢炉的 coal 0.036/次）不算"料"：这一模的带子不搬燃料，把它当料就会
-- 给每一条熔炉线凭空多要一股。它单列在 `fuel` 里，看得见、不被吞掉，也不进带子的账。
-- productivity 要真折上，得把**那一行自己**交回去（它读 `factory.effects`、`factory.speed`、`time`），
-- 只给一个机器名它就直接按 0 折 —— 所以 `recipe_row` 把整张 `factory` 原样抄了下来。
local function helmod_line_flow(r, machines_laid)
  if type(r) ~= "table" or type(r.recipe) ~= "string" then return nil, "no row" end
  local crafts = tonumber(r.crafts)
  if not crafts or crafts <= 0 then
    return nil, "这一行没带 helmod 的工艺次数（row.count），它就不是 helmod 解出来的那一条"
  end
  local base = tonumber(r.base_time) or 1
  local ok_iface, iface = pcall(function() return remote.interfaces and remote.interfaces["helmod_interface"] end)
  if not (ok_iface and iface) then return nil, "helmod 不在这发里（没有 helmod_interface）" end
  local row = { name = r.recipe, type = r.recipe_type or "recipe", quality = r.quality,
    count = crafts, base_time = base, time = r.craft_energy, factory = r.factory }
  local ok, got = pcall(function() return remote.call("helmod_interface", "get_recipe", row) end)
  if not ok then return nil, "get_recipe 报错：" .. tostring(got):sub(1, 120) end
  if type(got) ~= "table" then return nil, "get_recipe 没交出表" end
  local k = 60 / base
  local lists = { feed = {}, fluids = {}, products = {}, product_fluids = {}, fuel = {} }
  local function take(which, name, count, kind)
    local list = lists[which]
    for _, e in ipairs(list) do
      if e.item == name then e.per_min = e.per_min + count * k; return end
    end
    list[#list + 1] = { item = name, per_min = count * k, kind = kind }
  end
  local skipped = 0
  for _, key in ipairs({ "products", "ingredients" }) do
    local makes = key == "products"
    for _, e in ipairs(got[key] or {}) do
      local name, count = type(e.name) == "string" and e.name, tonumber(e.count)
      local typ = e.type or "item"
      if name and count and count > 0 then
        if e.burnt then
          take("fuel", name, count, typ)
        elseif typ == "fluid" then
          take(makes and "product_fluids" or "fluids", name, count, typ)
        elseif typ == "item" then
          take(makes and "products" or "feed", name, count, typ)
        else
          -- `energy`（steam-heat）、`technology` 这些既不上带子也不进料：数着，好让读数的人知道这一行
          -- 里有几件是没进账的，而不是以为 helmod 什么都给了。
          skipped = skipped + 1
        end
      end
    end
  end
  local crafts_per_min = crafts * k
  -- 单件量（折过的）：每分钟的件数除每分钟的工艺次数。helmod 回填的 `amount` 是**原型**的单件量，不含
  -- productivity，所以这里用它没有那份准。
  for _, list in ipairs({ lists.feed, lists.fluids, lists.products, lists.product_fluids, lists.fuel }) do
    for _, e in ipairs(list) do
      e.per_min = tonumber(e.per_min) or 0
      e.per_craft = crafts_per_min > 0 and (e.per_min / crafts_per_min) or nil
    end
  end
  return {
    source = "helmod", recipe = r.recipe, machine = type(r.factory) == "table" and r.factory.name or r.machine,
    -- 台数：`machines_laid` 是这一发要铺的台数，这份流量就是说给它看的（整线 k=1，拆成的每一条线按台数
    -- 等比缩）。`machines_helmod` 是 helmod 那一行自己算的机器数，可能是小数（1.6 台 = 一台做不满）——
    -- 铺出来的线只会比它富余，不会欠料，所以这个差要说出来而不是抹平。
    machines = tonumber(machines_laid) or crafts, machines_helmod = tonumber(r.count),
    crafts = crafts, base_time = base, crafts_per_min = crafts_per_min,
    -- 这一行有没有把加成真的折进来，读数的人要看得见：`get_recipe` 只在拿到 `time`（单次工艺的能量秒数）
    -- 时才折 productivity。没带就回的是"原样 × 次数"那一份，它仍然是 helmod 交出来的数，只是没折过。
    craft_energy = r.craft_energy,
    feed = lists.feed, fluids = lists.fluids, products = lists.products,
    product_fluids = lists.product_fluids,
    fuel = #lists.fuel > 0 and lists.fuel or nil, fuel_rows_skipped = skipped > 0 and skipped or nil,
    -- 这份件数**假设模块已经装上**：`factory.effects` 里那份 speed/productivity 加成就是它们给的
    -- （实测：一页写 80 个 `speed-module-2` → 折出来的产量比裸机器高四成）。所以交出去的时候要说
    -- 这数字带着哪几样的账 —— 而虚影身上装不了模块（见 `take_bag`）。
    with_modules = line_modules(type(r.factory) == "table" and r.factory.modules or nil,
      tonumber(machines_laid) or crafts),
  }
end


-- The list the picker needs: which helmod factories exist, what each one is called, and how big it is.
--
-- A player who works in helmod keeps several factories open -- one per product chain -- and "铺哪一条"
-- is exactly the question this answers. It is asked of the same `get_models()` the lay reads, so the
-- list cannot drift from what the lay will do: the numbers here are the numbers there.
function M.helmod_factories(args)
  args = args or {}
  local ok_iface, iface = pcall(function() return remote.interfaces and remote.interfaces["helmod_interface"] end)
  if not (ok_iface and iface) then
    return fail_key("HELMOD_NOT_INSTALLED", "m-helmod-not-installed", nil,
      "helmod is not in this save: nothing answers `helmod_interface`. Install helmod, or pass"
        .. " plan = { name = count } to lay these numbers yourself", { interface = tostring(iface) })
  end
  -- Same door as the lay: `models = {...}` reads a table the caller is holding, so the picker can be
  -- exercised without a mouse in the loop -- a self-test, or whoever is driving this over RCON, can ask
  -- what is in somebody's helmod before choosing one.
  local models = type(args.models) == "table" and args.models or nil
  if not models then
    local ok, got = pcall(function() return remote.call("helmod_interface", "get_models") end)
    if not ok then
      return fail_key("HELMOD_NOT_AVAILABLE", "m-helmod-not-available", nil,
        "helmod is installed but get_models() raised: the door this mod reads is"
          .. " helmod_interface:get_models(), which is what helmod 2.2 exposes", { error = tostring(got) })
    end
    models = got
  end
  if type(models) ~= "table" then
    return fail_key("NOTHING_TO_LAY", "m-helmod-empty", nil,
      "helmod has no plan in this save yet -- open helmod, give a factory at least one recipe, then"
        .. " press this again (or pass plan = { name = count })", { source = "helmod" })
  end
  local out = {}
  for id, m in pairs(models) do
    if type(m) == "table" then
      local machines, beacons, recipes, modules = {}, {}, {}, {}
      collect_machines(m, machines, beacons, recipes, modules)
      local kinds, total = {}, 0
      for _, e in ipairs(machines) do
        local n = tonumber(e.count) or 0
        if n > 0 then
          kinds[e.name] = (kinds[e.name] or 0) + n
          total = total + n
        end
      end
      local named = {}
      for k in pairs(kinds) do named[#named + 1] = k end
      table.sort(named)
      local top = {}
      for i = 1, math.min(3, #named) do top[#top + 1] = kinds[named[i]] .. "x" .. named[i] end
      local root = factory_root(m) or {}
      local module_rows = tally_bag_rows(modules)
      local module_total = 0
      for _, e in ipairs(module_rows) do module_total = module_total + e.count end
      out[#out + 1] = {
        id = tostring(id),
        -- helmod shows the factory by what it makes, so that is the word the picker should use;
        -- `model_2` is an internal key and a player cannot match it to anything on their screen.
        name = (type(root.name) == "string" and root.name)
          or (type(m.name) == "string" and m.name) or tostring(id),
        machines = total, kinds = #named, recipes = #recipes,
        beacons = (function()
          local n = 0
          for _, e in ipairs(beacons) do n = n + (tonumber(e.count) or 0) end
          return n > 0 and n or nil
        end)(),
        -- 模块要在**选页**这一格就看得见：这一页的机器数与每分钟件数都是装了它们算出来的，而铺下去的是
        -- 虚影 —— 虚影身上装不了模块（实测：`get_inventory(crafter_modules)` 是 nil，2.0 没有
        -- `set_module_info`）。所以这一格说的不是"要不要顺手装"，而是"这一页还欠哪几样、欠几个"。
        modules = module_total > 0 and module_total or nil,
        module_list = #module_rows > 0 and module_rows or nil,
        module_said = module_total > 0 and modules_said(module_rows) or nil,
        label = table.concat(top, ", "),
      }
      -- The lines under the page, listed as entries of their own. A helmod page holds several recipes --
      -- measured in a real save, where `model_2` named "iron-plate" carried 48 steel furnaces AND 15
      -- assemblers running electronic-circuit -- and the question a player asks is which LINE goes on
      -- the ground, not which page. The id is `page#recipe`, so what the list shows is what the press
      -- accepts, and a caller with no mouse pastes the very same string back.
      local seen = {}
      for _, r in ipairs(recipes) do
        local rn = type(r.recipe) == "string" and r.recipe
        local n = tonumber(r.count) or 0
        local line_id = tostring(id) .. "#" .. tostring(rn)
        if rn and n > 0 and not seen[line_id] then
          seen[line_id] = true
          -- 这一条线自己欠哪些模块（机器上的 `factory.modules` × 这一行几台）。页那一格给的是整页合计，
          -- 玩家挑的却是这一条线，所以两处都要说，缺一处就有人对着一条线问"那 80 个模块是哪来的"。
          -- 名字与形状跟页那一格一致：`modules` 是件数，`module_said` 是给人念的那一句。
          local lm = line_modules(type(r.factory) == "table" and r.factory.modules or nil, math.ceil(n))
          local lc = 0
          for _, e in ipairs(lm or {}) do lc = lc + e.count end
          out[#out + 1] = { id = line_id, kind = "line", page = tostring(id), name = rn,
            machine = r.machine, machines = math.ceil(n), recipes = 1,
            modules = lc > 0 and lc or nil,
            module_said = lc > 0 and modules_said(lm) or nil }
        end
      end
    end
  end
  table.sort(out, function(a, b) return tostring(a.id) < tostring(b.id) end)
  return { factories = out, count = #out }
end

-- 逐步判断日志（玩家 2026-10-06 的要求）。helmod 那一按从"读到哪一页"到"东西落到手上"中间有十来个
-- 判断，出问题时他得能说出"是第几步的逻辑不对"，而不是只能描述"蓝图不对"。所以每个判断留下一行：
-- 编号、它在决定什么、它用的数字、以及为什么是这个答案。三处读得到：答案里的 `steps`（RCON 直接看）、
-- 服务器日志里 `arch-helmod-step` 前缀那些行（手机上 grep 得动）、`storage.last_helmod_steps`
-- （面板和下一次调用要回头看上一次压了什么）。
--
-- 控制阶段那几条规矩一条没破：这里不分配实体号、不读只有服务端知道的东西，每行都由同一批输入决定，
-- 所以两边算出来的字符串本来就该逐字节相同；`log()` 落在各进程自己的日志文件里，不进存档也不进脚本状态。
-- 唯一写进 `storage` 的是"上一次那串行"，内容对所有机器都一样，不改变任何一台机器的行为。
local STEP_LIMIT = 400
local function steps_new() return { n = 0, lines = {}, dropped = 0 } end
local function step_num(v)
  if type(v) ~= "number" then return tostring(v) end
  if math.abs(v) >= 1000 then return string.format("%.0f", v) end
  return string.format("%.4g", v)
end
-- `facts` 是一串 {键, 值} 的**数组**而不是哈希表：日志里数字的顺序就是判断的顺序，而 Lua 的哈希序
-- 每次都不同 —— 一份两边读起来不一样的日志等于没有。
local function step(tr, what, facts, because)
  if not tr then return nil end
  tr.n = tr.n + 1
  local parts = {}
  for _, kv in ipairs(facts or {}) do
    parts[#parts + 1] = tostring(kv[1]) .. "=" .. step_num(kv[2])
  end
  local line = string.format("%02d %s%s%s", tr.n, what,
    #parts > 0 and (" :: " .. table.concat(parts, " · ")) or "",
    because and ("  因为 " .. because) or "")
  if #tr.lines < STEP_LIMIT then
    tr.lines[#tr.lines + 1] = line
  else
    -- 编号继续往上加，只是不再存行：让 `n` 永远是"一共走了几步"，而不是"存了几步"。
    tr.dropped = (tr.dropped or 0) + 1
  end
  log("arch-helmod-step " .. line)
  return line
end

function M.helmod_ghosts(args)
  args = args or {}
  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  local force_name = args.force or "player"
  if not game.forces[force_name] then return fail("NO_FORCE", tostring(args.force)) end

    local rows, beacons, recipes, modules_wanted, source = {}, {}, {}, {}, nil
  local answer_scoped = nil
  local function take(name, n, recipe)
    if type(name) ~= "string" or type(n) ~= "number" or n <= 0 then return end
    rows[#rows + 1] = { name = name, count = n, recipe = type(recipe) == "string" and recipe or nil }
    -- A `plan` row that names the recipe it runs becomes a lane, exactly like a helmod recipe row does.
    -- The count stays in `rows` as well: the lane subtracts what it laid, so a plan of 4 furnaces is four
    -- furnaces whether or not the lane builder accepts them.
    if type(recipe) == "string" then
      recipes[#recipes + 1] = { recipe = recipe, machine = name, count = n }
    end
  end

  local given = type(args.plan) == "table" and args.plan or nil
  if given then
    source = "plan"
    for k, v in pairs(given) do
      if type(v) == "table" then
        take(v.name or v.item or v.entity, tonumber(v.count or v.nb or v.amount), v.recipe)
      elseif type(k) == "string" then
        take(k, tonumber(v))
      end
    end
  else
    -- Two different answers, because they ask for two different fixes. `remote.interfaces` says whether
    -- helmod is in the save at all (measured: it lists `helmod_interface` as a table when it is);
    -- `get_models()` returning nothing means helmod IS here and simply has no plan yet -- which on a
    -- fresh save is the normal state, and calling it "not installed" would send the player to the mod
    -- browser instead of to helmod's own window.
    local ok_iface, iface = pcall(function() return remote.interfaces and remote.interfaces["helmod_interface"] end)
    if not (ok_iface and iface) then
      return fail_key("HELMOD_NOT_INSTALLED", "m-helmod-not-installed", nil,
        "helmod is not in this save: nothing answers `helmod_interface`. Install helmod, or pass"
          .. " plan = { name = count } to lay these numbers yourself",
        { interface = tostring(iface) })
    end
    -- `models = {...}` is the same door with the table handed over. Helmod only fills `storage.models`
    -- once a player has built a factory in its GUI, so this is what lets the READER be gated without a
    -- mouse in the loop -- it is not a mock: `collect()` below is the production code either way.
    local models = type(args.models) == "table" and args.models or nil
    if not models then
      local ok, got = pcall(function() return remote.call("helmod_interface", "get_models") end)
      if not ok then
        return fail_key("HELMOD_NOT_AVAILABLE", "m-helmod-not-available", nil,
          "helmod is installed but get_models() raised: the door this mod reads is"
            .. " helmod_interface:get_models(), which is what helmod 2.2 exposes",
          { error = tostring(got) })
      end
      models = got
    end
    if type(models) ~= "table" then
      -- A nil `storage.models` behind a live interface is helmod saying "nobody has made a factory yet",
      -- which is the normal state of a fresh save -- not a missing mod, and not a plan with zero machines.
      return fail_key("NOTHING_TO_LAY", "m-helmod-empty", nil,
        "helmod has no plan in this save yet -- open helmod, give a factory at least one recipe, then"
          .. " press this again (or pass plan = { name = count })", { source = "helmod" })
    end
    source = "helmod"
    local bag = {}
    -- `factory` names a whole page (`model_2`) or ONE line under it (`model_2#iron-plate`), which is the
    -- spelling the picker now lists. A line means the REST of the page stays in helmod: the loose machine
    -- counts come from the page's own summary, so laying them as well would drop 15 assemblers on the
    -- ground when the player asked for the furnace row. The answer says it was scoped, so nobody has to
    -- work that out from a machine count that does not match their page.
    local page_asked, line_asked = args.factory, args.recipe
    do
      local as_text = tostring(args.factory or "")
      local at = as_text:find("#", 1, true)
      if at then
        page_asked = as_text:sub(1, at - 1)
        if line_asked == nil then line_asked = as_text:sub(at + 1) end
      end
    end
    if args.factory ~= nil then
      -- Both spellings, for the reason `machine_recipes` already documents above: over RCON a model id
      -- arrives as the STRING "7" because JSON has no integer keys, while helmod's own table is keyed by
      -- the number. Reading one spelling silently refuses the caller who used the other -- and the answer
      -- says "no such factory", which points at helmod rather than at this lookup.
      local one = models[page_asked]
      if type(one) ~= "table" then one = models[tonumber(page_asked)] end
      if type(one) ~= "table" then one = models[tostring(page_asked)] end
      if type(one) ~= "table" then
        local known = {}
        for id in pairs(models) do known[#known + 1] = tostring(id) end
        table.sort(known)
        return fail_key("HELMOD_NO_FACTORY", "m-helmod-no-factory", { tostring(page_asked) },
          "helmod has no factory " .. tostring(page_asked) .. " in this save", { known = known })
      end
      bag[#bag + 1] = one
    else
      for _, m in pairs(models) do bag[#bag + 1] = m end
    end
    -- 树上那一页欠的模块也一起收（`summary_global.modules`）：这一页的台数与每分钟件数都是**装了它们**
    -- 算出来的，而铺下去的虚影身上装不了模块（实测）。收进来是为了在下面说出来，不是为了铺。
    for _, m in ipairs(bag) do collect_machines(m, rows, beacons, recipes, modules_wanted) end
    if line_asked ~= nil and line_asked ~= "" then
      local kept, names = {}, {}
      for _, r in ipairs(recipes) do
        names[#names + 1] = tostring(r.recipe)
        if r.recipe == line_asked then kept[#kept + 1] = r end
      end
      if #kept == 0 then
        table.sort(names)
        return fail_key("HELMOD_NO_LINE", "m-helmod-no-line",
          { tostring(line_asked), tostring(page_asked) },
          "this factory has no line running " .. tostring(line_asked), { lines = names })
      end
      recipes = kept
      -- The page's own totals are everything on it, and everything on it is not what was asked for.
      rows, beacons = {}, {}
      answer_scoped = tostring(line_asked)
    end
    for _, r in ipairs(rows) do
      if type(r.name) == "string" then
        local n = tonumber(r.count)
        if n and n > 0 then r.count = n end
      end
    end
  end

  if #rows == 0 and #recipes == 0 then
    return fail_key("NOTHING_TO_LAY", "m-helmod-nothing", { tostring(source) },
      "the plan holds no machines to lay -- nothing was read from " .. tostring(source),
      { source = source })
  end

  local rounder = args.round == "nearest" and function(x) return math.floor(x + 0.5) end or (args.round == "down" and math.floor or math.ceil)

  local who = nil
  do
    local idx = tonumber(args.player_index) or args.player_index or 1
    local okp2, got = pcall(function() return game.get_player(idx) end)
    if okp2 then who = got end
  end
  local origin = args.origin or (who and who.valid and { x = math.floor(who.position.x), y = math.floor(who.position.y) })
    or { x = 0, y = 0 }
  -- How wide a SHEET the ghosts are packed onto. This is a page width for the packing (it is what
  -- wraps a second band under the first), and it is deliberately NOT the cap that shortens a line:
  -- that question is answered by the belt and by the ground the player actually drew, below, and a
  -- number invented here is what turned his 15-machine 电路板 plan into 5 + 5 + 5 on a save where
  -- no box had been drawn at all.
  local width = math.max(4, tonumber(args.width) or 40)
  -- The cap, and only when a rectangle really said it: an unnamed width means nobody drew a box, so
  -- nothing on the ground limits the row and the belt alone decides where it ends.
  local ground_width = tonumber(args.width) or (args.box and (args.box.x2 - args.box.x1)) or nil
  local gap = math.max(0, tonumber(args.gap) or 1)

  local skipped, refused = {}, {}
  local counts, asked = {}, {}
  local lanes, lane_fallback, consumed = {}, {}, {}
  -- The plan is built as a LIST of parts with positions relative to (0,0), and only at the end does it
  -- become either a hand or a patch of ground. That order is the answer to "把虚影放到手里，我自己放":
  -- the same lanes, the same geometry, one door into the cursor and the other into the map, so the two
  -- can never disagree about what the plan was.
  local specs, laid = {}, 0
  -- 卡上说的那几条线（哪件的哪一头接到哪件），按**整页的件号**收在这里：每张卡的 `wires` 用的是它自己
  -- 件表里的 1..N，而一页可能好几条线，所以搬运的时候加上这一页的偏移。蓝图那一扇门把它们写进 record
  -- （`blueprint_specs`），地那一扇门写不了 —— 这台 2.0 没有脚本连线的方法，那一页要说清。
  local plan_wires = {}
  -- Three doors, and the one nobody names is the hand: `ground` places here and now, `string` hands the
  -- blueprint text back to a caller that has no inventory to put it in, and anything else -- including
  -- a misspelled value, which is why
  -- the fall-through is to the SAFE door rather than to the one that writes on the map -- becomes 拿到手上.
  -- Four doors. `hand` keeps its old meaning under the name `cursor`, because the two words now mean
  -- different things: `cursor` is the player's mouse, `pack` is their inventory, and a caller that wants
  -- one and gets the other did not read this line. The default is the mouse -- that is what a player at
  -- the button asked for -- and the press ALSO fills the copy field, so the door that touches nothing is
  -- always there beside it.
  local into = (args.into == "ground" or args.into == "string" or args.into == "pack") and args.into or "cursor"

  -- A shared cursor for both shapes: lanes are laid left to right, then wrapped into a new band, and the
  -- loose machines pack into whatever width is left. One cursor rather than two ledgers, because a plan
  -- that mixes both (helmod rows for some machines, bare counts for others) must not overlap itself.
  local cur_x, band_top, band_h = 0, 0, 0
  local function wrap(need)
    if cur_x + need > width and cur_x > 0 then
      cur_x, band_top, band_h = 0, band_top + band_h + gap, 0
    end
  end
  local function add_part(name, pos, dir, recipe, sign_lanes, circuit, filter)
    laid = laid + 1
    -- The recipe rides on the part that will craft it, so a lane delivered as a blueprint or as ghosts
    -- carries the assignment with it. `blueprint_specs` writes it into the record and the ghost pass
    -- below calls `set_recipe` with it -- a machine that cannot be told (a furnace has no setter) is
    -- skipped there rather than failing the write.
    -- `sign_lanes` is the same idea one part over: the display panel's own list of which half-lane
    -- carries what. A blueprint record and a ghost can both be *told* that (measured on this build:
    -- `control_behavior.parameters` for the record, `cb.messages` for the ghost), so the list has to
    -- arrive here rather than stay inside the card -- otherwise both doors ship a blank panel.
    specs[#specs + 1] = { name = name, position = { x = pos.x, y = pos.y }, direction = dir or 0,
      recipe = recipe, sign_lanes = sign_lanes, circuit = circuit, filter = filter }
    return true
  end

  -- ---------------------------------------------------------------- lanes: machines WITH their belts and arms
  -- `card_example` is the lane builder this mod already owns and already gates: it knows a feeder arm has
  -- to face the belt it picks from, that the outlet side is the other way round, and how the row steps.
  -- Reusing it is the whole reason "全铺" can mean belts and inserters rather than a field of machines: the
  -- geometry is the one the rest of the mod has measured, not a second opinion written down here.
  -- 这条线吃什么。带 `flows` 时（helmod 那一行折好的那一份件数）名单也从那一份里读：名单与流量是同一份
  -- 数据的两面，用原型的名单去配 helmod 的流量，等于让两台机器各说一遍同一条线，而它们迟早 disagree。
  -- 燃料那一行不在名单里（helmod 把它标成 `burnt`，实测钢炉的 coal）—— 这一模的带子不搬燃料。
  -- 没有 `flows`（`plan` 那一扇门，或 helmod 没答上）才回到原型清单。
  --
  -- `card_example` lays ONE ingredient line, so a recipe with two or three item ingredients cannot be fed
  -- by one lane -- and the second ingredient is not a belt this file forgot to draw, it is an input the
  -- machine will sit waiting for. Counted here and said in the answer because the card itself only ever
  -- carries the one ingredient it chose, and an answer that repeats the card would agree with itself while
  -- the factory starves.
  local function recipe_needs(name, line_flow)
    if type(line_flow) == "table" then
      local out, seen = {}, {}
      for _, e in ipairs(line_flow.feed or {}) do
        if type(e.item) == "string" and not seen[e.item] then
          seen[e.item] = true
          out[#out + 1] = { name = e.item, amount = tonumber(e.per_craft) or 1, per_min = e.per_min }
        end
      end
      return out
    end
    local out = {}
    local r = type(name) == "string" and prototypes.recipe[name] or nil
    if not r then return out end
    for _, ing in ipairs(r.ingredients or {}) do
      local iname = type(ing) == "table" and ing.name
      local itype = (type(ing) == "table" and ing.type) or "item"
      if itype == "item" and type(iname) == "string" then
        local seen = false
        for _, e in ipairs(out) do if e.name == iname then seen = true end end
        if not seen then out[#out + 1] = { name = iname, amount = tonumber(ing.amount) or 1 } end
      end
    end
    return out
  end

  -- Which SHAPE a computed line gets, and why it is not the card path's default. `row-chest` gives every
  -- machine its own input chest, overflow chest and outlet chest: measured on a helmod plan of 48
  -- smelters it came out as 144 chests and 144 arms for 48 furnaces, in one row 718 tiles long. Nobody
  -- builds that, because a computed plan is a PRODUCTION line and a line pays for its interface once --
  -- a belt down the row and an arm per machine face. So a helmod lane asks for a belt-line shape from two
  -- machines up (two rows behind one product belt from four), keeps the self-contained cell for a single
  -- machine, and the panel's style drop-down overrides the whole ladder.
  local named_style = type(args.style) == "string" and args.style ~= "" and args.style or nil
  -- 点名的排法要先问注册表认不认。不认就得**按名拒**：从前这里不问，于是那一个名字在每一行配方上都
  -- 换成"建不出来"，压线最后交回 `ok=true` 加**零条线** —— 玩家按下"压这一页"，地上什么也没多，
  -- 而答案说他成功了。一个没人认的名字被当成"没点名"，是这个门最贵的一种错。
  if named_style and not styles.get(named_style) then
    return fail_key("UNKNOWN_STYLE", "m-style-words", { table.concat(styles.ids(), ", ") },
      "style = " .. table.concat(styles.ids(), ", "),
      { asked_for = named_style, known = styles.ids() })
  end
  -- Which shape a COMPUTED line gets. Since 2026-10-05 this answers "one row" by default: the player who
  -- reads a factory reads it as rows, and a shape that folds the plan into a pair of rows -- which is what
  -- this ladder used to do from four machines up, because it halves the product belts -- came back on his
  -- own plan as "5 个一组 5 个一组" where he had asked for one line of 15. The dense shape did not lose
  -- anything on its own terms; it answered a different question. It stays one drop-down row away (面板
  -- 「排法」= 两排一带), and a caller that names a style still gets exactly that style, ladder unused.
  -- The ladder itself lives beside `card_example` now (same file, above), because a default that only the
  -- press path consults is how the same recipe answers two different questions: pressed it got a line on
  -- each face, asked from any other door it got one line and a `unfed` row for the rest.
  -- 每一步的判断都往 `tr` 里写一行（见 `steps_new` 上面的注释）。编号自动，所以第 6 步永远是第 6 步，
  -- 玩家可以说"第 6 步的形状选择不对"而不是"蓝图不对"。
  local tr = steps_new()
  step(tr, "入口：这次压线要用什么条件", {
    { "地面", surface.name }, { "force", force_name }, { "页", args.factory or "全部" },
    { "排法", named_style or "自动(阶梯)" }, { "线头", args.heads or "默认" },
    { "落到", args.into or "默认" }, { "拆线", args.lanes ~= false and "开" or "关" },
    { "允许宽度", args.width or "不限" }, { "间隔", args.spacing or "默认" },
    { "带/臂/箱点名", table.concat({ args.belt or "-", args.inserter or "-", args.chest or "-" }, "/") },
  })
  local plan_list = {}
  for _, r in ipairs(recipes) do
    plan_list[#plan_list + 1] = tostring(r.recipe) .. "x" .. tostring(rounder(r.count))
  end
  -- 这一页欠的模块（整页合计）。挑了一条线时上面已经把页那一格清空（`rows, beacons = {}, {}`），
  -- 那时模块按**那一条线**自己算（机器上的 `factory.modules` × 台数，见 `line_modules`），
  -- 所以两处不可能对不上账：合计数只在交整页的时候出现。
  local page_modules = answer_scoped and {} or tally_bag_rows(modules_wanted)
  local page_module_count = 0
  for _, e in ipairs(page_modules) do page_module_count = page_module_count + e.count end
  step(tr, "读页：从 helmod 拿到什么", {
    { "来源", source or "无" }, { "件数", #rows }, { "配方行数", #recipes },
    { "信标", #beacons }, { "欠模块", page_module_count > 0 and modules_said(page_modules) or "0" },
    { "清单", table.concat(plan_list, " ") },
  }, #recipes == 0 and "这一页里没有带配方的行，所以不会有生产线"
    or (page_module_count > 0 and "这一页的台数与每分钟件数是**装了这些模块**算出来的；铺下去的是虚影，"
      .. "虚影身上装不了模块（实测 get_inventory(crafter_modules) 是 nil、2.0 没有 set_module_info），"
      .. "所以它们记在 modules 那一格，建成真机器后要装" or nil))

  if args.lanes ~= false and #recipes > 0 then
    for _, r in ipairs(recipes) do
      local n = math.max(1, rounder(r.count))
      -- 这一行每分钟过几件，先向 helmod 要（#35 的分子）。要到了就把这一发的台数 `n` 当成那份件数的记账
      -- 台数（整线缩放 1，拆成几条线时 `card_example` 按台数等比拿每一份）；要不到就退回自算那一路，并且
      -- 在步进日志里点名为什么退（这一行没带 `count`、helmod 不在这发里、还是 `get_recipe` 报错）。
      local flows, flow_why = helmod_line_flow(r, n)
      local needs = recipe_needs(r.recipe, flows)
      local materials = #needs
      -- 这条配方喝几种流体（`recipe_needs` 只数固体，所以这里单独数）。数它不为别的：喝水的配方要走到
      -- "水在背面"那一档去，而那档只在有东西要喝的时候才进阶梯。
      local drinks = 0
      if flows then
        drinks = #(flows.fluids or {})
      else
        local pr = prototypes.recipe[r.recipe]
        for _, ing in ipairs((pr or {}).ingredients or {}) do
          if (ing.type or "item") == "fluid" then drinks = drinks + 1 end
        end
      end
      local need_list = {}
      for _, k in ipairs(needs) do need_list[#need_list + 1] = tostring(k.name) .. "x" .. step_num(k.amount) end
      step(tr, "配方：" .. tostring(r.recipe), {
        { "计划里点的机器", r.machine }, { "要造", n }, { "料种数", materials },
        { "每次工艺吃", table.concat(need_list, " ") },
      })
      local flow_list = {}
      for _, e in ipairs((flows or {}).products or {}) do
        flow_list[#flow_list + 1] = tostring(e.item) .. " " .. step_num(e.per_min) .. "/分"
      end
      step(tr, "分子：" .. tostring(r.recipe) .. " 这一行每分钟过几件", {
        { "来源", flows and "helmod 折好的那一份" or "自己算（speed×60/energy）" },
        { "工艺/分", flows and step_num(flows.crafts_per_min) or "-" },
        { "页档位/秒", flows and step_num(flows.base_time) or "-" },
        { "helmod台数", flows and step_num(flows.machines_helmod or r.count) or "-" },
        { "记账台数", n }, { "产物", #flow_list > 0 and table.concat(flow_list, " ") or "-" },
        { "折过没有", flows and (flows.craft_energy and "是（含 productivity）" or "没带能量秒数，productivity 折不上") or "-" },
        -- 这份流量是按哪几样模块算的：`factory.effects` 那份加成就是它们给的，而它们铺不下去。
        { "带着谁的账", flows and (flows.with_modules and modules_said(flows.with_modules) or "没写模块") or "-" },
      }, flow_why or (flows and "这份件数含 productivity、模块、信标、quality，都由 helmod 折过，我们不再乘一遍")
        or nil)
      -- Build one line of `m` machines: try the shapes the ladder offers for THAT count, and stop at the
      -- first one the builder accepts. A few tries matter only when the refusal is about the SHAPE: a
      -- two-row style handed three machines says STYLE_NEEDS_UNITS, and letting that fall through to
      -- loose machines would blame the plan for a style choice this file just made. A recipe or machine
      -- refusal is the same under any shape, so it is reported as what it is -- and a style the CALLER
      -- named is never silently swapped. The empty string counts as unnamed, because a drop-down with
      -- nothing in it answers "" and `styles.get("")` is a refusal, not a default.
      --
      -- 每一次建卡都带上 `flows`（这一行从 helmod 要来的那份件数）：阶梯会为一台、半条线、整条线各建一遍，
      -- 而它们问的是同一条线每分钟过几件。少了这一格，被试到的那一档就退回自己乘一遍合成速度 —— 同一个
      -- 计划在一条日志里有两个分子，正是 #35 要除掉的东西。
      local function build_with(m)
        local c, sh = nil, nil
        -- The head is part of the shape question, not a decoration on it: a bare belt head rules out every
        -- shape whose head IS a box, so the ladder starts from the one shape that answers it with zero
        -- chests and keeps the old ones as the way out. The press names each candidate to `card_example`
        -- (a named style is never swapped inside), which is why the fallback is walked HERE rather than
        -- left to the card: this loop is the only place that knows the other candidates were offered.
        local ladder = named_style and { named_style } or shape_ladder(m, materials, args.heads == "belt", drinks)
        step(tr, "形状候选：" .. tostring(m) .. " 台这一档", {
          { "点名", named_style or "无" }, { "料种数", materials },
          { "线头", args.heads or "默认（箱）" }, { "阶梯", table.concat(ladder, " → ") },
        }, named_style and "玩家点名了形状，所以阶梯不走"
          or (args.heads == "belt" and "裸带线头：先试零箱子那一档，再按机器数与料种数落回"
            or "阶梯按机器数与料种数给候选，从最省的试起"))
        for try = 1, #ladder do
          local want = ladder[try]
          -- Both names, because `card_example` reads different ones for different recipes: a smelting
          -- recipe takes its furnace from `furnace`, everything else from `machine` (control.lua:2094).
          -- Passing only `machine` made a helmod plan of 48 steel furnaces come out as 48 ELECTRIC ones
          -- -- the number was right, the machine was not, and nothing said so. The hint is the plan's,
          -- not the mod's preference.
          c = M.card_example({ recipe = r.recipe, machine_hint = r.machine,
            machines = m,
            orientation = args.orientation, style = want, spacing = args.spacing,
            heads = args.heads,
            belt = args.belt, inserter = args.inserter, chest = args.chest, power = args.power,
            force = force_name, flows = flows, bus = args.bus, bus_mode = args.bus_mode,
            bus_target = args.bus_target, bus_every = args.bus_every })
          sh = want
          local shape_refused = type(c) == "table" and c.fail
            and (c.code == "STYLE_NEEDS_UNITS" or c.code == "UNKNOWN_STYLE"
              -- 参数化那一档的三种"这个形状在这儿铺不出来"：都是形状的问题，不是这一页计划的问题，
              -- 所以照旧落到阶梯的下一个候选（下一档有箱子，但它喂得齐料、能生产）。
              or c.code == "ARM_TIER_MISSING" or c.code == "LINES_BEYOND_SHAPE"
              or c.code == "BELT_CAPACITY_UNKNOWN" or c.code == "STYLE_CANNOT_LAY")
          -- 每试一个形状都留一行：出问题时"这个形状被跳过是因为它要成对机器"和"它压根没被试过"
          -- 是两种完全不同的故障，只看最后选中的那个分不出来。
          -- 阶梯在这里就断了，所以这一步的话不能说"落到下一个"：料种数那种顶上限，三种排法同一句。
          local count_wall = type(c) == "table" and c.fail
            and ((c.detail or {}).blocked_by) == "feed_count"
          step(tr, "  试 " .. tostring(want), {
            { "结果", shape_refused and ("拒 " .. tostring(c.code)) or (c and c.fail and ("拒 " .. tostring(c.code)) or "接受") },
            { "footprint", (c and not c.fail and c.footprint) and (string.format("%dx%d",
              math.ceil((c.footprint or {}).width or 0), math.ceil((c.footprint or {}).height or 0))) or "-" },
            { "箱", (c and not c.fail and ((c.parts or {}).chests or 0)) or "-" },
            { "说法", (c and c.fail and c.msg) or (c and c.style_overridden
              and (tostring(c.style_overridden.asked) .. "→" .. tostring(c.style_overridden.used))) or "-" },
          }, count_wall and "料种数顶到一个面的上限：三种排法共用同一条律，换形状与切线都不解决，这一行落成散件"
            or (shape_refused and "这个形状在这儿铺不出来（机器数不够、或那一档臂/带行数不够），落到阶梯下一个" or nil))
          -- 料种数顶到上限时不必再走阶梯：三种排法共用同一条"一个面叠几条"的律，走完全得到同一句
          -- （而那一句在拒因里已经点明切线也不解决）。
          if count_wall then break end
          if not shape_refused then break end
        end
        -- 阶梯走完了还是"一个面叠不起这么多行"，那就不是形状的问题，是**这一条线太长**。拒因自己就是这么
        -- 说的："换形状也没用，只能把计划切成几条线"。可从前这里把整行交回散件，等于让模叫玩家去做模不肯
        -- 做的事 —— 97 台铁矿按一条线铺不出来，压完回 `ok` 而生产线 0 条。
        -- 所以现在当场找出"这个配方 + 这条带子铺得下的最长一条"（折半试，log 次），把它当作一条线的台数
        -- 上限交给下面的拆线；找到 1 台都铺不出来才真的落回散件。
        if type(c) == "table" and c.fail and c.code == "LINES_BEYOND_SHAPE" and m > 1
          -- 折半找"铺得下的最长一条"只在**台数**顶到上限时有效。料种数顶到上限时每一条线都还缺同一种
          -- 料，log 次探测全是为了拿到同一个拒因，所以这里不按名拒的话就该跳过。
          and ((c.detail or {}).blocked_by) ~= "feed_count" then
          local lo, hi, best_c, best_sh = 1, math.floor(m / 2), nil, nil
          while lo <= hi do
            local mid = math.floor((lo + hi) / 2)
            local probe, probe_sh = nil, nil
            for try = 1, #ladder do
              probe = M.card_example({ recipe = r.recipe, machine_hint = r.machine,
                machines = mid, orientation = args.orientation, style = ladder[try],
                spacing = args.spacing, heads = args.heads,
                belt = args.belt, inserter = args.inserter, chest = args.chest, power = args.power,
                force = force_name, flows = flows, bus = args.bus, bus_mode = args.bus_mode,
                bus_target = args.bus_target, bus_every = args.bus_every })
              probe_sh = ladder[try]
              if not (type(probe) == "table" and probe.fail
                and (probe.code == "LINES_BEYOND_SHAPE" or probe.code == "STYLE_NEEDS_UNITS"
                  or probe.code == "ARM_TIER_MISSING")) then break end
            end
            if type(probe) == "table" and probe.fail then
              hi = mid - 1
            else
              best_c, best_sh, lo = probe, probe_sh, mid + 1
            end
          end
          if best_c then
            step(tr, "  这条线太长，折半找出铺得下的最长一条：" .. tostring(m) .. " → "
              .. tostring(best_c.lane_count or 0) .. " 台", {
              { "拒因", "LINES_BEYOND_SHAPE" }, { "试到", tostring(best_c.lane_count or 0) },
              { "形状", tostring(best_sh) },
            })
            return best_c, best_sh, best_c.lane_count
          end
        end
        return c, sh
      end
      -- The same build with the SHAPE PINNED, for measuring one shape's growth per machine. Coming back
      -- through `build_with` would walk the ladder, and a one-machine walk lands on a different shape than
      -- a ninety-machine one (`sandwich-2` refuses a single machine), so a width difference read that way
      -- is the difference between two shapes rather than a pitch.
      local function build_as(m, sh)
        return M.card_example({ recipe = r.recipe, machine_hint = r.machine,
          machines = m, orientation = args.orientation, style = sh, spacing = args.spacing,
          heads = args.heads,
          belt = args.belt, inserter = args.inserter, chest = args.chest, power = args.power,
          force = force_name, flows = flows, bus = args.bus, bus_mode = args.bus_mode,
          bus_target = args.bus_target, bus_every = args.bus_every })
      end
      -- 一张线卡落成什么样，把决定它的那些数字一次写全：形状、件数、臂是哪一档、料要几股、每股运力、
      -- 一行喂几台、要几条线、成品带走得动多少、缺不缺料、以及模型自己给的那句"为什么"。
      -- 玩家说"哪一步不对"的时候，这一步是绝大多数故障的答案所在。
      local function card_step(what, c)
        if type(c) ~= "table" then step(tr, what, { { "结果", "没有卡片返回" } }) return end
        if c.fail then step(tr, what, { { "拒", tostring(c.code) }, { "说法", tostring(c.msg) } }) return end
        local fp, bc, ac = c.feed_plan or {}, c.belt_ceiling or {}, c.arm_ceiling or {}
        local parts = c.parts or {}
        local un = {}
        for _, u in ipairs(c.unfed or {}) do un[#un + 1] = tostring(u.name) end
        step(tr, what, {
          { "形状", c.style }, { "宽", (c.footprint or {}).width }, { "高", (c.footprint or {}).height },
          { "带", parts.belts }, { "臂", parts.arms }, { "机器", parts.machines }, { "箱", parts.chests },
          { "臂档", (c.arm_choice or {}).arm }, { "reach", c.arm_reach },
          { "一台够得着的进料股", fp.inbound_lanes }, { "料共要几股", fp.lanes_wanted },
          { "进料带条数", fp.lane_rows }, { "每股运力/分", fp.per_lane },
          { "分子来源", (c.rate_source or {}).source or "-" },
          { "换了机器所以退回", (c.rate_source or {}).reason or "-" },
          { "helmod那台", ((c.rate_source or {}).helmod_aside or {}).helmod_machine or "-" },
          { "地上这台", ((c.rate_source or {}).helmod_aside or {}).laid_machine or "-" },
          { "工艺/分", (c.rate_source or {}).crafts_per_min },
          { "缩放到", (c.rate_source or {}).scale },
          { "最重一种料/分", fp.heaviest_per_min },
          { "一行可喂台数", fp.machines_per_line }, { "需要几条线", fp.lines_needed },
          { "带太慢", fp.belt_too_slow and "是" or "否" },
          { "成品线每分可走", bc.per_min }, { "这张卡许诺每分", bc.claimed_per_min },
          -- 两个口径并列的一行：helmod 那条式子说要几条带（向上贴半条），与这个形状实际铺了几行。
          { "helmod要几条带", (c.belt_need_helmod or {}).product_belts },
          { "式子原值", (c.belt_need_helmod or {}).product_raw },
          { "成品线占用比", bc.headroom },
          { "超载在", bc.over_claimed and "带子" or (ac.over_claimed and "臂" or "都不绑") },
          { "缺料", #un > 0 and table.concat(un, " ") or "无" },
          { "搬形状", (c.style_overridden or {}).used
            and (tostring(c.style_overridden.asked) .. "→" .. tostring(c.style_overridden.used)
              .. "（" .. tostring(c.style_overridden.code) .. "）")
            or ((c.shape_moved or {}).to
              and (tostring(c.shape_moved.from) .. "→" .. tostring(c.shape_moved.to)) or "没搬") },
          -- 需求与供给对面（2026-10-06 的 #6）：这条线要几条进料带/几条成品带、这个形状铺了几条、
          -- 一面最多叠得起几条、于是无箱可铺成不成立、不成立卡在哪儿。玩家的"必须没有箱子"
          -- 能不能兑现，就看这一行，不用拆蓝图。
          { "要几条进料带", (c.lane_plan or {}).feed_rows_needed },
          { "要几条成品带", (c.lane_plan or {}).product_rows_needed },
          -- 成品借进料行那股走的时候，上面那两个数都是 0 —— 少了这一行，玩家看见的就是"要 0 条成品带、
          -- 铺了 0 条"，而地上每一根进料带都同时在送成品。
          { "成品借那股走的股数", (c.lane_plan or {}).product_lanes_shared },
          { "铺了几条进料/成品", string.format("%s/%s",
            tostring((c.lane_plan or {}).feed_rows_laid), tostring((c.lane_plan or {}).product_rows_laid)) },
          { "一面能叠几条", (c.lane_plan or {}).rows_per_face },
          { "臂档", table.concat((c.lane_plan or {}).arm_reach_tiers or {}, "/") },
          { "无箱可铺", (c.lane_plan or {}).chest_free and "是" or "否" },
          { "还差几条", string.format("%d/%d", (c.lane_plan or {}).short_feed or 0,
            (c.lane_plan or {}).short_product or 0) },
          { "换形状也没救", (c.lane_plan or {}).beyond_any_shape and "是" or "否" },
          { "绑在", tostring((c.lane_plan or {}).blocked_by or "-") },
          { "模型自己的话", tostring(fp.reason or bc.next or ac.next or "-") },
        })
      end
      local card, shape, longest_line = build_with(n)
      card_step("线卡：" .. tostring(r.recipe) .. " x" .. tostring(n), card)
      -- Lay ONE line of this plan row: `m` machines, from the card `c`, in shape `sh`. `part_of` is set
      -- when the row had to become more than one line, and it travels with the lane so a player reading
      -- "8 machines here" can see it is line 2 of 2 rather than a plan that lost eight.
      local function lay(m, c, sh, part_of)
        -- The recipe this lane is a plan FOR. It travels with every machine the lane puts down, so a
        -- line the player pastes or ghosts starts crafting instead of standing idle until each assembler
        -- is clicked.
        local laid_recipe = (type(r) == "table" and r.recipe) or nil
        local fp = c.footprint or {}
        local cw, ch = math.ceil(fp.width or 0), math.ceil(fp.height or 0)
        wrap(cw)
        local dx, dy = cur_x, band_top
        local kinds = {}
        local machine_of = (c.components or {}).furnace or (c.components or {}).machine
        local base = #specs
        for _, e in ipairs(c.entities) do
          add_part(e.name, { x = dx + e.position.x, y = dy + e.position.y }, e.direction,
            (machine_of and e.name == machine_of) and laid_recipe or nil, e.sign_lanes, e.circuit,
            e.filter)
          kinds[e.name] = (kinds[e.name] or 0) + 1
        end
        -- 这一页里那条线接的是哪两件：卡里的件号加上这一页的偏移。少算这一步，两条线会在第一页上
        -- 接到别人的机器去 —— 引擎不报错，它照收，粘出来才是错的。
        for _, w in ipairs(c.wires or {}) do
          if w.from and w.to then
            plan_wires[#plan_wires + 1] = { from = base + w.from, to = base + w.to,
              color = w.color or "green" }
          end
        end
        cur_x = cur_x + cw + gap
        if ch > band_h then band_h = ch end
        -- What the lane was actually built from. `components.furnace` is the machine part of any lane --
        -- the name is historical, the field is "the thing that crafts" -- and when it is not the name the
        -- plan used, that is said rather than smoothed over.
        local laid = tostring((c.components or {}).furnace or (c.components or {}).machine or r.machine)
        -- What the lane feeds versus what the recipe eats. `card.ingredient` is the one the lane was
        -- built around; everything else the recipe needs is `unfed`, and an `unfed` row is the difference
        -- between "48 furnaces making plates" and "15 assemblers waiting for plastic that never arrives".
        local needs, fed_item = recipe_needs(r.recipe, flows), c.ingredient
        -- Which materials the lane actually takes in. A chest-bearing shape declared ONE chest per
        -- material, so it was the port list -- not the single `ingredient` the lane is named after -- that
        -- said the recipe is fed complete. Comparing against `ingredient` alone is how a lane that had
        -- both materials on its belt still reported the second one as unfed.
        local fed, fed_items = {}, {}
        for _, p in ipairs((c.ports or {})["in"] or {}) do
          if p.item and not fed[p.item] then fed[p.item] = true fed_items[#fed_items + 1] = p.item end
        end
        -- 零箱子的线没有 in-port，那份清单在**牌**上：头牌点了名的每一种料都是这一排带得到的料。和
        -- `card_example` 里数 `lane_unfed` 用的是同一个读法（那里也是先问牌），两处各数一遍迟早会 disagree
        -- —— 而 disagree 的表现形式就是这里：一条喂得齐两种料的线，压线的回答里仍然写着第二种 `unfed`，
        -- 于是 helmod 那一头按缺料去加线。
        for _, l in ipairs((c.head or {}).lanes or {}) do
          if l.item and not fed[l.item] then fed[l.item] = true fed_items[#fed_items + 1] = l.item end
        end
        -- ...和 `card_example` 里那第二条：牌放不出来（这一发的 force 没研究电路网）时，线仍然在，
        -- 带子仍然有几股。只问牌就回答"这条线带两种料里的一种"，那是把一件文档的缺失当成了产能的缺失，
        -- helmod 那一头会照这个幻影缺料去加线。
        local capacity = 2 * tonumber(((c.feed_plan or {}).lane_rows) or 0)
        if capacity > 0 then
          for i, k in ipairs((c.feed_plan or {}).needs or {}) do
            if i <= capacity and k.item and not fed[k.item] then
              fed[k.item] = true fed_items[#fed_items + 1] = k.item
            end
          end
        end
        if fed_item and not fed[fed_item] then fed[fed_item] = true fed_items[#fed_items + 1] = fed_item end
        table.sort(fed_items)
        local unfed = {}
        for _, e in ipairs(needs) do
          if not fed[e.name] then unfed[#unfed + 1] = e end
        end
        lanes[#lanes + 1] = { recipe = r.recipe, machine = laid, asked_machine = r.machine,
          fed_item = fed_item, fed_items = #fed_items > 1 and fed_items or nil,
          needs = #needs, unfed = #unfed > 0 and unfed or nil,
          swapped = laid ~= r.machine and r.machine or nil,
          -- The shape the lane ACTUALLY IS, not the one the ladder asked for: `card_example` may move a
          -- lane to another shape when the asked one leaves a material nowhere to arrive (`shape_moved`)
          -- or when a bare head's first choice cannot be laid (`style_overridden`). Reading the asked-for
          -- name back here made the panel's own row disagree with the belts on the ground.
          shape = (c and c.style) or sh or "stacked",
          asked_shape = sh ~= nil and sh or nil,
          style_overridden = (c and c.style_overridden) or nil,
          -- 这条线自己的线头：`belt` 才是"零箱子"那句话的凭据，`chest` 说明这一条还是从箱子起步。
          head = (c and c.head or {}).kind,
          -- 两头各写了什么：头那块牌说这条线吃什么，尾那块说它吐什么。带子股道由牌自己说，这里只是
          -- 把那份读数原样交出去，让窗口和门禁都看得见"尾那块到底在不在"。
          head_manifest = (c and c.head or {}).manifest,
          -- 牌没放上去的那一句：地上是裸带线头、但没有可读的股道说明，玩家该在答案里看见，而不是
          -- 到了现场才发现少两块牌。
          sign_missing = (c and c.head or {}).sign_missing,
          tail_manifest = (c and c.tail or {}).manifest,
          tail_lanes = (c and c.tail or {}).lanes,
          chests = (c and c.parts or {}).chests,
          asked = r.count, machines = m,
          -- The lane's own arithmetic, kept: what its materials want per minute, what its line can carry,
          -- and how many machines this belt feeds. This is the number the split was decided with, and a
          -- gate that can read it back per lane is the difference between "it split" and "every line it
          -- split into is one a belt can actually pay for".
          feed = c.feed_plan,
          -- 这条线的分子是谁给的：`source = "helmod"` 才是"全部用 helmod 的数据"那句话的凭据，
          -- `"self"` 说明这一行没能从 helmod 问到数（`plan` 那一扇门、或那一行没带工艺次数），
          -- 于是它走的是自己算的那一路 —— 读数的人不用猜。
          rate_source = c.rate_source,
          -- 这条线的分子是按这些模块算的（一台装几种 × 这一行几台），而地上铺的是虚影 —— 装不了模块
          -- （实测）。数交给 `feed`/`belt_ceiling` 看，这里只交欠哪几样。
          modules = flows and flows.with_modules or nil,
          modules_said = flows and flows.with_modules and modules_said(flows.with_modules) or nil,
          -- helmod 说"这条线要几条带子"（每种料一条，向上贴半条），与这条线实际铺了几行并列交出去。
          belt_need_helmod = c.belt_need_helmod,
          -- 这一条线自己铺了几行成品带 / 几行进料带（几何律的答案，与上面那个 helmod 的"几条带子"并列）。
          product_rows = ((c.lane_plan or {}).product_rows_laid),
          feed_rows = ((c.lane_plan or {}).feed_rows_laid),
          -- 这一档带子是谁定的（#35 ④）："caller" = 面板那一格里点名的，"adequate" = 我们按"够用就好"
          -- 从最慢那档试出来的。helmod 自己的默认档位存在够不到的 `storage.preferences` 里（实测那扇门
          -- 只开 get_models / get_recipe），所以这一格只能是这两种，绝不会写"同步了 helmod 的偏好"。
          belt_chosen_by = ((c.belt_choice or {}).asked) and "caller" or "adequate",
          split = part_of,
          entities = #c.entities, parts = kinds, at = { x = origin.x + dx, y = origin.y + dy },
          width = cw, height = ch }
        -- The machines this lane lays are no longer loose counts: taking them out of the bag is what keeps
        -- a helmod plan of 24 assemblers from becoming 24 in a lane plus 24 in the packing.
        consumed[r.machine] = (consumed[r.machine] or 0) + m
        local pt = c.parts or {}
        local un = {}
        for _, u in ipairs(unfed) do un[#un + 1] = tostring(u.name) end
        step(tr, "落一条线：" .. tostring(r.recipe)
          .. (part_of and (" 第" .. tostring(part_of.of) .. "/" .. tostring(part_of.lines) .. "条") or ""), {
          { "台数", m }, { "形状", sh or "stacked" },
          { "放在", string.format("%d,%d", origin.x + dx, origin.y + dy) },
          { "占", string.format("%dx%d", cw, ch) }, { "实体", #c.entities },
          { "带", pt.belts }, { "臂", pt.arms }, { "机器", pt.machines }, { "箱", pt.chests },
          { "缺料", #un > 0 and table.concat(un, " ") or "无" },
          { "喂它的料", #fed_items > 0 and table.concat(fed_items, " ") or "无 in-port" },
        })
      end
      if type(card) == "table" and not card.fail and card.entities then
        local per_line = (card.feed_plan or {}).machines_per_line
        -- 阶梯整条都铺不下时 `build_with` 折半找到的那个最长一条，就是这一行的线长上限：它比带子那一格
        -- 更硬（带子喂得动 48 台，一个面也只叠得起 2 条带 = 48 台的线），而且它是**试出来**的，不是猜的。
        if longest_line then per_line = math.min(per_line or longest_line, longest_line) end
        -- ...and the ground the player allowed caps a line just as hard as the belt does. Measured on his
        -- own helmod plan (2026-10-02, 27015): a 90-machine 绿板 line came out 451 columns of aisle under
        -- a `width` of 400 -- the throughput limit had said how far one belt feeds, and nothing had asked
        -- whether the row fits the ground he drew, so the packer walked off the end of it.
        --
        -- The cap is measured, not assumed: two builds of the SAME pinned shape, one unit apart, give its
        -- growth per machine and its cost at zero, and these footprints are linear in the count, so
        -- `fixed + pitch * m` is exact -- a line sized with it does not stick out by a column either. The
        -- unit is the style's own: `sandwich-2` stands two machines per unit and refuses a one-machine
        -- build outright, so measuring through the ladder would have compared two shapes, not one pitch.
        local by_width = nil
        do
          local style_id = card.style
          local unit = (style_id and styles.get(style_id) or {}).per_lane or 1
          local c_a = build_as(unit, style_id)
          local c_b = build_as(unit * 2, style_id)
          local w_a = (c_a and not c_a.fail and c_a.footprint or { width = 0 }).width or 0
          local w_b = (c_b and not c_b.fail and c_b.footprint or { width = 0 }).width or 0
          if ground_width and ground_width > 0 and style_id and w_a > 0 and w_b > w_a then
            local pitch = (w_b - w_a) / unit
            local fixed = w_a - pitch * unit
            by_width = math.floor((ground_width - fixed) / pitch)
            if by_width < 1 then by_width = 1 end
            per_line = per_line and math.min(per_line, by_width) or by_width
          end
        end
        -- 一条线多长由两个数里小的那个决定：带子喂得动几台、玩家画的这块地放得下几台。哪个绑住就得
        -- 说哪个 —— 他问"我 15 台怎么被拆成三条线"时，答案就在这两个数里，而不是在最后一行的件数里。
        step(tr, "拆线：" .. tostring(r.recipe), {
          { "要造台数", n }, { "带子喂得动", (card.feed_plan or {}).machines_per_line },
          { "地宽放得下", by_width or "没绑" }, { "一条线定成", per_line or "整条不拆" },
          { "会拆成几条", per_line and per_line >= 1 and per_line < n
            and math.ceil(n / per_line) or 1 },
        })
        -- A plan row longer than one belt can feed becomes several lines. This is not tidiness and it is
        -- not taste: past `machines_per_line` the far end of the row cannot be given its items at all, and
        -- a lane that places, lints, and then starves is the failure this mod has been called out for.
        if per_line and per_line >= 1 and per_line < n then
          local sizes, left = {}, n
          while left > 0 do
            local m = math.min(per_line, left)
            sizes[#sizes + 1] = m
            left = left - m
          end
          for i, m in ipairs(sizes) do
            -- Each chunk is built by the ladder for ITS count, not with the parent's shape forced onto
            -- it: the last line of a 49-machine plan is one machine, and a two-row style refuses one
            -- machine. Inheriting the shape turned that remainder into a refusal and a loose furnace,
            -- which is the machine going missing this split exists not to allow.
            local one, one_shape = build_with(m)
            card_step("线卡 第" .. tostring(i) .. "/" .. tostring(#sizes) .. "条："
              .. tostring(r.recipe) .. " x" .. tostring(m), one)
            if type(one) ~= "table" or not one.entities then
              -- A chunk this shape will not build stops the split rather than swallowing the rest: the
              -- machines still in the bag are subtracted below and laid loose, with the reason beside them.
              step(tr, "拆线在这一条停住：" .. tostring(r.recipe), {
                { "停在第几条", i }, { "这台建不出来", one and one.code or "no lane" },
                { "说法", one and one.msg or "-" }, { "后果", "剩下的机器落成散件，不吞掉" },
              })
              lane_fallback[#lane_fallback + 1] = { recipe = r.recipe, machine = r.machine,
                asked = r.count, why = one and one.code or "no lane", msg = one and one.msg or nil,
                split_at = i }
              break
            end
            lay(m, one, one_shape, { lines = #sizes, of = i, per_line = per_line })
          end
        else
          lay(n, card, shape, nil)
        end
        asked[r.machine] = (asked[r.machine] or 0) + r.count
      else
        -- A lane the builder refuses (an unknown recipe, a machine that cannot run it) must not swallow the
        -- machines. They are still in the bag -- helmod's summary carries the count, and a `plan` row was
        -- never removed from it -- so the fallback is only the sentence saying WHY this line is loose
        -- machines instead of a laid-out lane.
        lane_fallback[#lane_fallback + 1] = { recipe = r.recipe, machine = r.machine, asked = r.count,
          why = card and card.code or "no lane", msg = card and card.msg or nil }
        step(tr, "这一行没铺成线，落成散件：" .. tostring(r.recipe), {
          { "台数", r.count }, { "拒因", card and card.code or "no lane" },
          { "说法", card and card.msg or "-" },
        })
      end
    end
    -- Subtract what the lanes already put down, and drop the rows that ran out. A row whose remaining count
    -- is zero is not a skip: it is a machine that was laid, in a lane, and said so in `lanes`.
    for _, r in ipairs(rows) do
      local left = (tonumber(r.count) or 0) - (consumed[r.name] or 0)
      r.count = left > 0 and left or 0
    end
  end

  -- ---------------------------------------------------------------- loose machines and beacons
  local function add_count(list, r)
    if type(r) ~= "table" then return end
    local nm, n = r.name, tonumber(r.count)
    if type(nm) ~= "string" then return end
    if not n then
      skipped[#skipped + 1] = { name = nm, wanted = 0, why = "the plan gave no count for it" }
      return
    end
    if n <= 0 then return end   -- laid already, as part of a lane: not a skip and not a loose machine
    list[nm] = (list[nm] or 0) + n
  end
  for _, r in ipairs(rows) do add_count(counts, r) end
  for _, b in ipairs(beacons) do add_count(counts, b) end
  for n in pairs(counts) do if not asked[n] then asked[n] = counts[n] end end

  local names = {}
  for n in pairs(counts) do names[#names + 1] = n end
  table.sort(names)
  for _, name in ipairs(names) do
    local p = nil
    local okp, got = pcall(function() return prototypes.entity[name] end)
    if okp then p = got end
    -- Not `local w, h = p and box_size(...)`: an `and` expression is adjusted to ONE value in Lua, so
    -- the second return would land as nil and every machine would read as having no footprint.
    local w, h
    if p then w, h = box_size(field(p, "selection_box") or field(p, "collision_box")) end
    if not (w and w > 0 and h and h > 0) then
      -- Said as a skip rather than a refusal of the whole batch: helmod can name a module, a fuel or a
      -- quality variant, and those are not things that stand on the ground. Silently dropping them is
      -- how a player ends up with 24 ghosts where the plan said 30.
      skipped[#skipped + 1] = { name = name, wanted = counts[name],
        why = not p and "this save has no entity called it" or "its footprint cannot be read" }
    else
      local sw, sh = math.ceil(w), math.ceil(h)
      for _ = 1, math.max(0, rounder(counts[name])) do
        wrap(sw)
        add_part(name, { x = cur_x + sw / 2, y = band_top + sh / 2 })
        cur_x = cur_x + sw + gap
        if sh > band_h then band_h = sh end
      end
    end
  end

  local per = {}
  for _, name in ipairs(names) do
    local placed = 0
    for _, s in ipairs(specs) do if s.name == name then placed = placed + 1 end end
    per[#per + 1] = { name = name, wanted = asked[name], placed = placed }
  end
  -- What the lanes put down, by part kind: a player who asked for belts and arms needs to see the belts
  -- and arms counted, not infer them from a total.
  local parts = {}
  for _, l in ipairs(lanes) do
    for k, v in pairs(l.parts or {}) do parts[k] = (parts[k] or 0) + v end
  end

  -- Was the plan fed? True when at least one lane went down with its belts and arms; false only for a
  -- helmod read that produced loose machines (the plan had no recipe row to build a lane from); nil for
  -- a bare `plan`, which never claimed to be a line. A player deciding "do I still have to lay belts"
  -- reads this, so it must not be guessable from the ghost count.
  local feed
  if #lanes > 0 then feed = true
  elseif source == "helmod" then feed = false
  else feed = nil end

  -- 欠哪些模块，一处算清：整页那一按用页上的合计（`summary_global.modules`），挑一条线那一按页合计被
  -- 清空了（那一格是整页的数，不是这一条线的），就用各条线自己的（机器上的 `factory.modules` × 台数）。
  -- 两条路都得给出数，否则挑一条线的人正好看见"模块 0 个"而那条线的流量是按模块算的 —— 那是最坏的一种漏说。
  local answer_modules = page_modules
  if #answer_modules == 0 then
    local merged = {}
    for _, l in ipairs(lanes) do
      for _, e in ipairs(l.modules or {}) do merge_item(merged, e.item, e.quality, e.count) end
    end
    answer_modules = sort_by_name(merged)
  end
  local answer_module_count = 0
  for _, e in ipairs(answer_modules) do answer_module_count = answer_module_count + e.count end

  local answer = {
    source = source, surface = surface.name, origin = origin, width = width, gap = gap,
    rounded = args.round or "up", into = into,
    -- Which single line the page was cut down to, or nil for the whole page: the machine counts below
    -- cannot be matched to the player's helmod screen without this word.
    scoped = answer_scoped,
    -- 这一按用的线头（各条 `lanes[].head` 里也各有一份）：nil = 玩家没表态、照旧箱头，"belt" = 裸带尾
    -- 加一块牌。读的人要靠这一格把「牌上写的带子」和「地上铺出来的带子」对上。
    heads = (function()
      local h = nil
      for _, l in ipairs(lanes) do h = l.head or h end
      return h
    end)(),
    lanes = #lanes > 0 and lanes or nil, lane_fallback = #lane_fallback > 0 and lane_fallback or nil,
    fed = feed,
    parts = next(parts) ~= nil and parts or nil,
    kinds = #per, entities = laid, items = per,
    skipped = #skipped > 0 and skipped or nil,
    -- 模块：这一页/这一条线欠哪几样、各几个，以及为什么 `laid` 是 0。虚影身上装不了模块（实测），
    -- 而流量与机器数又是按装了它们算的（`rate_source.modules` 在每条线上都跟着走）。
    modules = answer_module_count > 0 and answer_modules or nil,
    modules_count = answer_module_count > 0 and answer_module_count or nil,
    modules_said = answer_module_count > 0 and modules_said(answer_modules) or nil,
    modules_laid = answer_module_count > 0 and 0 or nil,
    modules_note = answer_module_count > 0
      and "a ghost cannot hold a module (measured: get_inventory(crafter_modules) is nil on a ghost, "
        .. "and 2.0 has no set_module_info): these are what this plan's machine counts and per-minute "
        .. "rates were computed WITH, and they go in once the machines are built" or nil,
    note = "no card, no lint, no measurement: these are helmod's numbers, and they are yours to place" }

  step(tr, "落件：这一按在地上铺了什么", {
    { "虚影", laid }, { "种类", #per }, { "生产线", #lanes },
    { "没铺成线的行", #lane_fallback }, { "跳过", #skipped },
    { "欠模块", answer_module_count },
    { "带", parts.belts }, { "臂", parts.arms }, { "机器", parts.machines }, { "箱", parts.chests },
  })
  -- 这份 `steps` 就是玩家要的东西：出问题时他不必描述"蓝图不对"，他念一行编号就行。
  -- 上一次压线也留在 `storage` 里，面板和下一次调用都能回头看。
  answer.steps = tr.lines
  answer.steps_count = tr.n
  answer.steps_dropped = (tr.dropped or 0) > 0 and tr.dropped or nil
  storage.last_helmod_steps = { tick = game.tick, source = source,
    page = answer_scoped or args.factory or "全部", lines = tr.lines }

  -- 拒的时候更要带上走到哪一步：一个"手上已经有东西"的拒和"这个形状建不出来"的拒，
  -- 差别就在前面那几行的数字里。
  local function with_steps(d)
    d = d or {}
    d.steps = tr.lines
    d.steps_count = tr.n
    return d
  end

  if into ~= "ground" then
    -- The hand, not the ground. `blueprint_item` + `hand_blueprint` are the same two functions the card
    -- row's 拿到手上 runs, which is the point: what arrives in the cursor is authored by the engine, so
    -- the setup flow, the rotation, the snapping and the green/red are the game's and not a second
    -- placement opinion written here. The hand is deliberately NOT overwritten when something is in it
    -- -- that is the one limit that protects the player's own thing rather than the mod's rules.
    --
    -- Authoring comes FIRST, and the read-back count travels with the answer: a blueprint the engine
    -- accepted only half of (a part too far from the rest, a direction it rejected) is the one failure
    -- this path can have that a player cannot see -- the item in their hand would simply be short. With
    -- no player at all (a headless server, a script reading the answer) the blueprint is still worth
    -- handing back, so `into = "string"` returns it as text instead of refusing for a hand.
    local claim = {}
    for _, l in ipairs(lanes) do
      claim[#claim + 1] = string.format("%s x%d", tostring(l.recipe or l.machine or "?"), l.machines or 0)
    end
    local inv, err, signs, lines, ring, arm_filters = blueprint_item(specs, "helmod " .. tostring(args.factory or "all"),
      #claim > 0 and ("helmod's plan: " .. table.concat(claim, ", ")
        .. (#skipped > 0 and " -- " .. #skipped .. " row(s) are not things that stand on the ground" or "")
        .. ".") or "helmod's plan, laid out as one blueprint.", nil, plan_wires)
    if not inv then
      return fail("BLUEPRINT_AUTHOR_FAILED", "the engine would not hold this plan as a blueprint: " .. err,
        { entities = laid })
    end
    local held = 0
    pcall(function()
      local list = inv[1].get_blueprint_entities()
      held = list and #list or 0
    end)
    answer.held = held
    answer.short_by = held < laid and (laid - held) or nil
    -- 那两块牌的字在这张蓝图里带住了几块：`asked` 是这一页铺了几块面板，`carried` 是引擎回读出来
    -- 还带着字的那几块。这两个数由 `blueprint_item` 从引擎自己的答复里数出来，不是铺的人自报 ——
    -- 玩家粘下去看到的是蓝图，不是我们的一句保证。
    answer.signs = (signs.asked or 0) > 0 and signs or nil
    -- 连线在这一路上带住了几条（同一个数法：两头各回显一次，去重之后除 2）。这一格只属于蓝图那扇门 ——
    -- 地那一扇门的虚影连不了线，那一句写在 `answer.sign_note` 里。
    answer.wires = (lines.asked or 0) > 0 and lines or nil
    -- 控制带那一圈在这张蓝图里带住了几件：`asked` 是这一页铺了几件带意图的组合器，`carried` 是引擎回读
    -- 出来仍带着那份配置的那几件（判据见 `behavior_carried` —— 能对上的都对上了）。而机器那一格"从线上
    -- 取配方"是这一路**明说带不住**的那一格，它单独占一行，不并进上面那个数里凑数。
    answer.circuits = (ring.asked or 0) > 0 and ring or nil
    -- 臂的筛选也照同一套数法交出去：这一页要带几只带筛选的臂、引擎回读出来还带着料名的有几只。
    answer.arm_filters = ((arm_filters or {}).asked or 0) > 0 and arm_filters or nil
    if into == "string" then
      local bp, bp_err = blueprint_string(specs, "helmod " .. tostring(args.factory or "all"),
        nil, plan_wires)
      pcall(function() inv.destroy() end)
      if not bp then
        step(tr, "出件：蓝图文本没作者出来", { { "拒", "BLUEPRINT_AUTHOR_FAILED" }, { "说法", tostring(bp_err) } })
        return fail("BLUEPRINT_AUTHOR_FAILED", tostring(bp_err),
          { entities = laid, steps = tr.lines, steps_count = tr.n })
      end
      answer.blueprint = bp
      answer.bytes = #bp
      step(tr, "出件：文本", { { "字节", #bp }, { "实体", laid }, { "引擎回读", held } },
        held < laid and ("回读比铺的少 " .. tostring(laid - held) .. " 件，答案里 short_by 记着") or nil)
      answer.steps = tr.lines
      answer.steps_count = tr.n
      return answer
    end
    local who2 = who
    if not (who2 and who2.valid) then
      pcall(function() inv.destroy() end)
      step(tr, "出件：没有手可用", { { "拒", "NO_PLAYER" }, { "实体", laid } })
      return fail_key("NO_PLAYER", "m-no-player-to-carry", nil,
        "no player came with this call, and the whole deliverable is a hand to put the blueprint in",
        { entities = laid, held = held, surface = surface.name, steps = tr.lines, steps_count = tr.n })
    end
    -- Only the mouse door has to ask whether the mouse is free; the pack takes the item whatever the
    -- cursor holds, and never swaps anything the player is carrying.
    if into == "cursor" then
      local ok_empty, empty = pcall(function() return who2.is_cursor_empty() end)
      local busy = ok_empty and empty == false
        or (not ok_empty and who2.cursor_stack and who2.cursor_stack.valid_for_read == true)
      if busy then
        local held_name
        pcall(function() held_name = who2.cursor_stack.name end)
        pcall(function() inv.destroy() end)
        step(tr, "出件：手被占了，没换任何东西", {
          { "拒", "CURSOR_BUSY" }, { "手上拿着", tostring(held_name or "?") }, { "实体", laid },
        })
        return fail_key("CURSOR_BUSY", "m-cursor-busy", { tostring(held_name or "?") },
          "your hand holds " .. tostring(held_name or "?") .. " -- put it away and press again;"
            .. " nothing was swapped out of it", { steps = tr.lines, steps_count = tr.n })
      end
    end
    local door, landed_name, kept, cerr = hand_blueprint(who2, inv, into)
    if not door then
      step(tr, "出件：交到手/背包失败", { { "拒", "CARRY_FAILED" }, { "说法", tostring(cerr) } })
      return fail("CARRY_FAILED", cerr, { entities = laid, held = held,
        steps = tr.lines, steps_count = tr.n })
    end
    answer.landed_via = door
    answer.surface = (who2.surface and who2.surface.name) or surface.name
    -- The text travels with the item, so one press is both doors: the pack holds the blueprint and the
    -- panel's copy field holds the string. The second of those writes NOTHING to the player, which is
    -- the fallback that still works if a delivery ever disagrees between two processes again.
    local bp, bp_err = blueprint_string(specs, "helmod " .. tostring(args.factory or "all"),
      nil, plan_wires)
    answer.blueprint = bp
    answer.bytes = bp and #bp or nil
    answer.blueprint_error = not bp and tostring(bp_err) or nil
    answer.note = answer.note .. (door == "pack"
      and " it is in your pack -- take it out and place it where you want; the text is in the copy box"
      or " it is in your hand now -- place it where you want")
    step(tr, "出件：交给玩家", {
      { "走哪个门", door }, { "落下的件", tostring(landed_name or "-") },
      { "保留", tostring(kept) }, { "字节", answer.bytes or "-" }, { "实体", laid },
      { "引擎回读", held },
    }, held < laid and ("回读比铺的少 " .. tostring(laid - held) .. " 件") or nil)
    answer.steps = tr.lines
    answer.steps_count = tr.n
    return answer
  end

  -- Onto the ground, which is what 撤回 is for: every ghost this made is in the record, and one press of
  -- the undo button takes a whole lane back (belts, arms, chests and machines together).
  local made, ghost_count, recipes_set = {}, 0, 0
  local sign_panels, signs_filled, sign_problem = 0, 0, nil
  local ctrl_asked, ctrl_written, ctrl_problem = 0, 0, nil
  local filters_asked, filters_set, filter_problem = 0, 0, nil
  for _, s in ipairs(specs) do
    local pos = { x = origin.x + s.position.x, y = origin.y + s.position.y }
    local ent = surface.create_entity { name = "entity-ghost", inner_name = s.name, position = pos,
      direction = s.direction, force = force_name }
    if ent then
      -- The ghost takes the recipe the lane was built for (measured: `set_recipe` answers nil-error on a
      -- ghost and the machine that replaces it keeps the assignment). Counted, because "15 assemblers, 0
      -- of them told what to craft" is exactly the silent half of an answer this mod keeps being asked
      -- to stop producing.
      if set_ghost_recipe(ent, s.name, s.recipe) then recipes_set = recipes_set + 1 end
      -- 牌的字写在虚影身上（实测这一台的 `cb.messages` 整表写在虚影上成立、也读得回来）。它和上一条
      -- recipe 是同一件事的两半：玩家建起来之前，这些内容只有引擎手里那份，脚本不写就等于让他自己打。
      if s.sign_lanes then
        sign_panels = sign_panels + 1
        local wrote, why = fill_sign(ent, s.sign_lanes)
        signs_filled = signs_filled + wrote
        if why and not sign_problem then sign_problem = why end
      end
      -- 控制带那一圈的配置写在虚影身上：这台构建上 `cb.parameters` 与 `cb.circuit_set_recipe` 都吃得、
      -- 都读得回来（量的那一轮见 `circuit_parameters` 上面那段）。数出来而不是假设 —— 一句"配好了"而
      -- 地上一件都没配置，是这一串改动反复被指的那类错。
      if s.circuit then
        ctrl_asked = ctrl_asked + 1
        local wrote, why = apply_circuit(ent, s.circuit)
        ctrl_written = ctrl_written + wrote
        if why and not ctrl_problem then ctrl_problem = why end
      end
      -- 臂的筛选写在虚影身上：实测 `entity-ghost` 吃得下 `set_filter(1, …)` 也读得回
      -- （`dev/arm_filter_probe.js`）。共用进料行那一档缺这一手，取货臂会把成品抓回机器。
      if s.filter then
        filters_asked = filters_asked + 1
        local okf, ferr = pcall(function() return ent.set_filter(1, s.filter) end)
        if okf then
          filters_set = filters_set + 1
        elseif not filter_problem then
          filter_problem = tostring(ferr)
        end
      end
      ghost_count = ghost_count + 1
      made[#made + 1] = { unit = ent.unit_number, ent = ent, at = pos, name = ent.name, for_name = s.name }
    else
      refused[#refused + 1] = { name = s.name, at = pos }
    end
  end
  local deployment, depth = note_deployment({
    card = "helmod:" .. tostring(args.factory or "all"), surface = surface.name, origin = origin,
    ghosts = ghost_count, built = 0, recipes_set = recipes_set, made = made,
  })
  answer.ghosts = ghost_count
  -- 这一按在地上占了哪一块（虚影的包围盒，四周多留两格：机器占的是格面，虚影记的是创建点）。
  -- 留着它是为了"把模块装上"那一按不用再问一遍"哪片地"—— 手机上没人想再框一次，而他刚压的就是那片。
  local ax1, ay1, ax2, ay2 = nil, nil, nil, nil
  for _, e in ipairs(made) do
    local p = e.at
    if p then
      ax1 = math.min(ax1 or p.x, p.x); ay1 = math.min(ay1 or p.y, p.y)
      ax2 = math.max(ax2 or p.x, p.x); ay2 = math.max(ay2 or p.y, p.y)
    end
  end
  if ax1 then
    -- 虚影记的是格心（1190.5 那种），交出去之前先落到格子上：这块地会被"把模块装上"那一按
    -- 直接拿去当扫描区域，半格偏移累积起来会把最外一排机器漏在框外。
    answer.area = { x1 = math.floor(ax1 - 2), y1 = math.floor(ay1 - 2),
                    x2 = math.ceil(ax2 + 3), y2 = math.ceil(ay2 + 3) }
    storage.last_helmod_area = { tick = game.tick, surface = surface.name, force = force_name,
      page = answer_scoped or args.factory or "全部", area = answer.area }
  end
  -- How many of the machines this laid were told what to craft, and the recipe they were told: said
  -- beside the ghost count because a lane of assemblers that all idle until the player clicks each
  -- one is a lane that did not arrive planned. `nil` when nothing took one (a lane of furnaces, which
  -- have no setter at all) rather than a 0 that reads like a failure of this method.
  answer.recipes_set = recipes_set > 0 and recipes_set or nil
  -- 头尾那两块牌：铺了几块、字写进去几块。写不进去的第一句原因跟着走（`problem`），因为"答案说写好了
  -- 而地上是两块空牌"正是这一版被指过的那类错 —— 现在这句话由这两个数说，不由注释说。
  if sign_panels > 0 then
    answer.signs = { asked = sign_panels, carried = signs_filled, problem = sign_problem }
  end
  -- 臂的筛选在这一页写成了几只（数法与牌、控制带同一套：要几只、写得进的几只）。
  -- 共用进料行那一档没这一手就是一条会吃回成品的线，所以这一格必须在答案里看得见。
  if filters_asked > 0 then
    answer.arm_filters = { asked = filters_asked, carried = filters_set, problem = filter_problem }
  end
  if ctrl_asked > 0 then
    answer.circuits = { asked = ctrl_asked, written = ctrl_written, problem = ctrl_problem,      -- 配置写上了，线还没连：2.0 没有脚本连线的方法（`circuit_connect`、`open_ground_connection`
      -- 实测都不存在），而虚影本来也进不了电路网络。所以地上的这一页要玩家自己把总线拉过去，
      -- 或者走蓝图那一扇门 —— 那一路的线在 record 里带得住。
      wiring = "each controller is configured and every machine is told to listen, but the wires "
        .. "themselves cannot be scripted on 2.0 (`circuit_connect` and `open_ground_connection` do "
        .. "not exist on this build, measured) -- draw them by hand, or take the blueprint door, "
        .. "which carries them in the record" }
  end
  answer.deployment = deployment
  answer.undo_depth = depth
  answer.refused = #refused > 0 and refused or nil
  answer.note = answer.note .. " put them back with 撤回 (place_undo)"
  answer.sign_note = string.format(
    "头尾那两块牌的字（每根带子第几股是什么料）写在虚影身上了：%d 块里写进去 %d 块。"
      .. "虚影建成为实体之后还亮不亮，是引擎落地那一步的事，这台机器上脚本量不到 —— 你建一次就知道。"
      .. "不亮也不影响读数：股道号在这份答案的 head_manifest / tail_manifest 里，蓝图那扇门另带 "
      .. "signs.carried 那个数。牌与旁边那只组合器之间的连线这一路带不住（2.0 没有脚本连线的方法），"
      .. "要连线的页走蓝图那一扇门，那条路上带得住的条数写在 wires 里。", sign_panels, signs_filled)
  if sign_problem then answer.sign_note = answer.sign_note .. "（有一块没写进去：" .. sign_problem .. "）" end
  return answer
end

-- 上一次压线走过哪几步。玩家在手机上按完，答案滚过去了、或者他先想看完地上再回头对 —— 这一步不该重跑
-- 一次压线（重跑会再铺一遍虚影）。所以 `M.helmod_ghosts` 把它那一串留在 `storage` 里，这里只读。
-- 一次 `helmod_blueprints`（整计划那按）会逐页覆盖它，那是已知边界：整计划要看每页的步骤，得走答案里
-- 的 `steps`，不是这里。
function M.helmod_last_steps(args)
  args = args or {}
  local j = storage.last_helmod_steps
  local function refused(why)
    return fail_key("NO_STEPS", "m-no-steps", nil, why, {
      last_page = j and j.page or nil, last_source = j and j.source or nil, asked = args.page })
  end
  if not j then
    return refused("this save has not pressed helmod yet -- press it once, then read the steps back here")
  end
  -- 点名要看哪一页。整计划那按会逐页覆盖 `storage`（那是"上一次"的字面意思），所以 caller 有权说一句
  -- "我要的是 model_7 那页" —— 对不上就拒，而不是把另一页的步骤当成答案交出去。
  if args.page and tostring(args.page) ~= tostring(j.page) then
    return refused(string.format("the last press was page %s (%s); you asked for %s -- press that one,"
      .. " or read the per-page `steps` a whole-plan press returns beside each blueprint",
      tostring(j.page), tostring(j.source), tostring(args.page)))
  end
  return { tick = j.tick, source = j.source, page = j.page,
    lines = j.lines, count = #(j.lines or {}),
    note = "这是上一次压线走过的每一步；绝大多数「形状/件数不对」的答案都在第 6 步（线卡）那一行" }
end

-- Every factory in helmod, as blueprints, in one press. This is the door the whole mod now points at:
-- the player computes in helmod, and what they want back is the thing they can place -- not a card, not
-- a lint pass, not a bench measurement, and not one factory at a time. Each page in helmod's own list
-- becomes ONE blueprint (its lines laid out, its beacons standing, its items named), and the pack is the
-- only place they can all fit: a cursor holds one item, so "all of them" cannot be a hand delivery.
--
-- It is a loop over `M.helmod_ghosts` on purpose. One factory's worth of reading, shaping and authoring
-- lives in exactly one place, so the single press and the whole-plan press can never disagree about what
-- the same page means -- which is how a second door usually drifts away from the first one.
function M.helmod_blueprints(args)
  args = args or {}
  local listed = M.helmod_factories({ models = args.models })
  if type(listed) ~= "table" or listed.fail then return listed end
  local made, refused = {}, {}
  for _, f in ipairs(listed.factories or {}) do
    if f.kind ~= "line" then
      local one = M.helmod_ghosts({
        models = args.models, factory = f.id, surface = args.surface,
        player_index = args.player_index, into = args.into or "pack",
        round = args.round, width = args.width, gap = args.gap, lanes = args.lanes,
        style = args.style, heads = args.heads,
        belt = args.belt, inserter = args.inserter, chest = args.chest,
        power = args.power, orientation = args.orientation, spacing = args.spacing,
        -- 总线那一圈也要能跟着"整计划"那一按走（0.80.0 只把参数接到了单页压线上，这里补上转发）。
        -- 它是**偏好类的条件**：一种配方一条线的页里，`bus` 会落在每一行上（那一行的机器听线、
        -- 各做点名的那几种），所以调用方要说清给哪一页 —— 整计划里点名一条总线，等于要每一页都听线。
        bus = args.bus, bus_mode = args.bus_mode, bus_target = args.bus_target,
        bus_every = args.bus_every,
      })
      if type(one) ~= "table" or one.fail then
        refused[#refused + 1] = { factory = f.id, name = f.name, code = one and one.code or "NO_ANSWER",
          msg = one and one.msg or nil,
          -- 拒掉的那一页也要带着它走到的步骤：整计划里"这一页没出蓝图"和"这一页第 6 步就拒了"
          -- 是两句不同的话，玩家只有前者可读的话就只能重来一次才知道差在哪。
          steps = one and one.detail and one.detail.steps or nil }
      else
        local unfed = {}
        for _, l in ipairs(one.lanes or {}) do
          for _, miss in ipairs(l.unfed or {}) do
            unfed[#unfed + 1] = { recipe = l.recipe, name = miss.name, amount = miss.amount }
          end
        end
        made[#made + 1] = {
          factory = f.id, name = f.name, via = one.landed_via, into = one.into,
          entities = one.held or one.ghosts or one.entities,
          lines = one.lanes and #one.lanes or 0, parts = one.parts, bytes = one.bytes,
          -- 这一页的控制带带没带出去（组合器配置与线各自的 asked/carried）：整计划那一按交出去的是
          -- 一叠蓝图，而"粘完不动"的故障只在某一页上出现，所以逐页都要看得见这两个数。
          circuits = one.circuits, wires = one.wires, signs = one.signs,
          skipped = one.skipped, unfed = #unfed > 0 and unfed or nil,
          -- 这一页欠的模块也逐页交出去：整计划里玩家看的是"每页多大、欠什么"，而模块是那一页的流量与
          -- 台数成立的前提（虚影装不了，实测）。
          modules = one.modules, modules_count = one.modules_count,
          modules_said = one.modules_said, modules_laid = one.modules_laid,
          -- 每页各有一套步骤。`storage.last_helmod_steps` 只留最后一页（那是"回看上一次"的语义），
          -- 整计划要看每一页，就得读这里。
          steps = one.steps, steps_count = one.steps_count,
        }
      end
    end
  end
  if #made == 0 then
    return fail_key("NOTHING_TO_LAY", "m-helmod-nothing", { "all" },
      "none of helmod's pages turned into a blueprint -- every one is listed under `refused`",
      { refused = refused })
  end
  return {
    blueprints = made, count = #made, refused = #refused > 0 and refused or nil,
    into = args.into or "pack",
    note = "one blueprint per helmod page, all in your pack; the cursor can only hold one, so `all` is"
      .. " never a hand delivery -- a page that refused is named in `refused`, not skipped",
  }
end

-- Take back what this mod placed, newest first. Only the objects in the record are touched: an entry
-- whose entity no longer resolves is reported rather than guessed at, because the usual reason a ghost
-- is gone is that somebody filled it in, and the machine standing there now is the player's.
-- 把模块装进**已经建好的真机器**。
--
-- 为什么需要另一扇门：压线交出去的是虚影与蓝图，而**虚影身上装不了模块**（2026-10-09 实测：
-- `ghost.get_inventory(defines.inventory.crafter_modules)` 是 nil、2.0 没有 `set_module_info`；
-- 同一台机器建成真的之后可以 —— `real.insert({name="speed-module", count=1})` 回 0 未放入）。
-- 0.74.0 只能把"这一页欠哪些模块"说出来；这一扇是他建完之后把那份账兑现的地方。
--
-- 数仍然来自 helmod：每一台装几种各几个，读的是那一行的 `factory.modules`（一台的份数）。
-- 东西不会凭空来：默认按 `auto` —— 先那片地上的箱子，再他自己的背包；拿不到的按 `missing` 报出来，
-- 绝不 `insert` 造出来（那是"给你发材料"的另一件事，不是这一按的权限）。
-- 一次动作的顺序都按 `unit_number` 排：控制阶段的代码在每个进程里都得走同一条路，而"哪个箱子先被拿"
-- 会改变结果。
function M.machine_modules(args)
  args = args or {}
  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  local force_name = args.force or "player"
  if not game.forces[force_name] then return fail("NO_FORCE", tostring(args.force)) end
  local from = args.from or "auto"

  -- 一片地：点名就用点名的，否则用上一次压线到地上那块（面板那一按不该再让人框一次）。
  local area = type(args.area) == "table" and args.area or nil
  if not area and type(args.box) == "table" then
    local b = args.box
    area = { x1 = math.min(b.x1 or 0, b.x2 or 0), y1 = math.min(b.y1 or 0, b.y2 or 0),
             x2 = math.max(b.x1 or 0, b.x2 or 0), y2 = math.max(b.y1 or 0, b.y2 or 0) }
  end
  local area_from = area and "args" or nil
  if not area then
    local last = type(storage.last_helmod_area) == "table" and storage.last_helmod_area or nil
    if last and last.surface == surface.name then area, area_from = last.area, "last press" end
  end
  if not area or area.x1 == nil then
    return fail_key("NO_AREA", "m-modules-no-area", { tostring(surface.name) },
      "no area to work on: press a helmod page onto the ground first (that is what records which"
        .. " patch of this surface the machines are on), or pass area = { x1, y1, x2, y2 }",
      { surface = surface.name, last = storage.last_helmod_area and storage.last_helmod_area.page or nil })
  end

  -- 计划：一台装几种各几个。两路来源 —— `modules = { {machine=, recipe=, modules={{item=,count=}}} }`
  -- 是调用者手里的清单（也是"helmod 不在这发里"时的退路），否则读 helmod 的那棵树。
  local by_machine, by_recipe, ambiguous, planned_machine = {}, {}, {}, {}
  local function same_rows(a, b)
    if #a ~= #b then return false end
    for i = 1, #a do
      if a[i].item ~= b[i].item or a[i].count ~= b[i].count then return false end
    end
    return true
  end
  local function add_plan(machine, recipe, items)
    local rows = {}
    for _, e in ipairs(items or {}) do
      local nm = type(e) == "table" and (e.item or e.name)
      local n = tonumber(type(e) == "table" and (e.count or e.amount)) or 0
      if type(nm) == "string" and n > 0 then rows[#rows + 1] = { item = nm, count = n } end
    end
    if machine == nil then return end
    planned_machine[machine] = true
    if recipe ~= nil then by_recipe[tostring(recipe) .. "/" .. tostring(machine)] = rows end
    -- 同一台机器被两条配方用、而两处的模块不一样：那"按机器名"就没有答案了，只能按配方装。
    -- 这里不挑一份赢 —— 挑了就是替玩家决定哪条配方该拿那份加成，而他会从产量上发现，不会从这里发现。
    if by_machine[machine] ~= nil and not same_rows(by_machine[machine], rows) then
      ambiguous[machine] = true
      by_machine[machine] = nil
    elseif not ambiguous[machine] then
      by_machine[machine] = rows
    end
  end
  local plan_source = nil
  if type(args.modules) == "table" then
    plan_source = "modules"
    for _, row in ipairs(args.modules) do
      if type(row) == "table" then
        add_plan(row.machine or row.entity or row.name, row.recipe, row.modules or row.items)
      end
    end
  else
    local listed = M.helmod_factories({ models = args.models })
    if listed.fail then
      return fail_key(listed.code, listed.msg_key or "m-helmod-not-installed", nil,
        listed.msg, { detail = listed.detail })
    end
    -- 读法与压线一模一样：树上的那一行、那一行的 `factory.modules`。同一份读法在两处各演一遍，
    -- 就会有一天"压线说欠 80 个、装模块那一按说没这台"。
    local bag = {}
    for _, m in pairs(listed.factories or {}) do
      if m.kind ~= "line" and (args.factory == nil or tostring(args.factory) == m.id) then
        bag[#bag + 1] = m.id
      end
    end
    local models = type(args.models) == "table" and args.models or nil
    if not models then
      local ok, got = pcall(function() return remote.call("helmod_interface", "get_models") end)
      models = ok and got or nil
    end
    local seen = {}
    for _, id in ipairs(bag) do
      local one = type(models) == "table" and (models[id] or models[tonumber(id)]) or nil
      if type(one) ~= "table" or seen[id] == nil then
        seen[id] = true
        if type(one) == "table" then
          local machines, beacons, recipes, modules = {}, {}, {}, {}
          collect_machines(one, machines, beacons, recipes, modules)
          for _, r in ipairs(recipes) do
            add_plan(type(r.factory) == "table" and r.factory.name or r.machine, r.recipe,
              line_modules(type(r.factory) == "table" and r.factory.modules or nil, 1))
          end
        end
      end
      plan_source = "helmod"
    end
  end
  local has_plan = false
  for _, rows in pairs(by_machine) do if #rows > 0 then has_plan = true end end
  for _, rows in pairs(by_recipe) do if #rows > 0 then has_plan = true end end
  if not has_plan then
    return fail_key("NO_MODULE_PLAN", "m-modules-no-plan", { tostring(args.factory or "全部"),
      plan_source or "modules" },
      "the plan names no modules for any machine here: a helmod page without modules has nothing to"
        .. " install, and this method will not guess a set",
      { source = plan_source, page = tostring(args.factory or "all") })
  end

  -- 引擎要的是 `{{x1,y1},{x2,y2}}` 那一种区域写法（或 BoundingBox）；`{x1=,y1=,...}` 是这模自己的
  -- 表单形状（`plan_fit`/压线都用它），直接递给 `find_entities_filtered` 会得到一次"什么都没找到"，
  -- 而不是一个错 —— 所以两处扫描都过这只手。
  local function aabb(a)
    if type(a) ~= "table" then return nil end
    if a.x1 then return { { a.x1, a.y1 }, { a.x2, a.y2 } } end
    return a
  end
  local box = aabb(area)
  local inv_of = function(e)
    local ok, got = pcall(function() return e.get_inventory(defines.inventory.assembling_machine_modules) end)
    if ok and got then return got end
    return nil
  end
  local recipe_of = function(e)
    local ok, got = pcall(function() return e.get_recipe() and e.get_recipe().name end)
    return ok and got or nil
  end
  local function plan_for(e)
    local nm = e.name
    local rec = recipe_of(e)
    local keyed = rec and by_recipe[tostring(rec) .. "/" .. tostring(nm)] or nil
    if keyed then return keyed, rec end
    if ambiguous[nm] then return nil, rec, "two recipes on this page want different modules for " .. tostring(nm) end
    return by_machine[nm], rec
  end

  local found, ghosts, ghosts_other = {}, 0, 0
  local ok_scan, listed = pcall(function()
    return surface.find_entities_filtered{ area = box, force = force_name }
  end)
  for _, e in ipairs((ok_scan and listed) or {}) do
    if e.valid and e.name == "entity-ghost" then
      -- 虚影身上装不了模块（实测），所以这一片里还有多少虚影要如实数出来：他按这一按最常见的
      -- 原因就是"我铺完就按了，还没建"。认得的（虚影里面是那台计划里的机器）单列，别的不混进来。
      -- 读写不是同一个名字（实测 2.0）：`create_entity` 收 `inner_name`，而**读**回来的是
      -- `ghost_prototype.name` —— 用 `e.inner_name` 读会得到 "doesn't contain key inner_name"，
      -- 于是每一只虚影都落进"别的虚影"那一格，而玩家看到的是一句"这里没有你要装的机器"。
      local inner = nil
      pcall(function()
        -- 读法实测：`ghost_prototype` 是 **userdata**（不是表，也不是函数），而 `inner_name` 这个键在
        -- 2.0 的运行期根本不存在（写 `create_entity` 时用得到，读不回来）。按 `type(gp) ~= "table"`
        -- 筛会把每一只虚影都判成"不是计划里那台"，于是玩家看到的是"这里没有要装的机器"。
        local gp = e.ghost_prototype
        local t = type(gp)
        if t == "function" then gp = gp(e); t = type(gp) end
        if t == "table" or t == "userdata" then inner = gp.name or nil end
      end)
      if inner and planned_machine[inner] then ghosts = ghosts + 1
      else ghosts_other = ghosts_other + 1 end
    elseif e.valid and inv_of(e) then
      found[#found + 1] = e
    end
  end
  table.sort(found, function(a, b) return (a.unit_number or 0) < (b.unit_number or 0) end)

  -- 材料从哪儿拿：`auto` = 那片地上的箱子（按 unit_number 排），再他自己的背包；`chests` / `inventory`
  -- 各只走一条；`none` 只查不装（他要先看看欠多少）。
  local sources, source_said = {}, {}
  if from ~= "none" then
    if from == "auto" or from == "chests" then
      local okc, chests = pcall(function()
        return surface.find_entities_filtered{ area = box, force = force_name, type = "container" }
      end)
      local list = {}
      for _, c in ipairs((okc and chests) or {}) do if c.valid then list[#list + 1] = c end end
      table.sort(list, function(a, b) return (a.unit_number or 0) < (b.unit_number or 0) end)
      for _, c in ipairs(list) do
        local inv = nil
        pcall(function() inv = c.get_inventory(defines.inventory.chest) end)
        if inv then sources[#sources + 1] = { inv = inv, said = "chest " .. tostring(c.unit_number or "?") } end
      end
    end
    if from == "auto" or from == "inventory" then
      local who = nil
      local idx = tonumber(args.player_index) or args.player_index
      if idx then local okp, got = pcall(function() return game.get_player(idx) end); if okp then who = got end end
      local inv = nil
      if who and who.valid then pcall(function() inv = who.get_main_inventory() end) end
      if inv then sources[#sources + 1] = { inv = inv, said = "inventory" } end
    end
  end
  for _, s in ipairs(sources) do source_said[#source_said + 1] = s.said end

  local got_taken = {}
  local function take_from(name, want)
    local got = 0
    for _, s in ipairs(sources) do
      if got >= want then break end
      local have = 0
      pcall(function() have = s.inv.get_item_count(name) end)
      if have and have > 0 then
        local ask = math.min(want - got, have)
        local removed = ask
        pcall(function() removed = s.inv.remove({ name = name, count = ask }) or ask end)
        if removed and removed > 0 then
          got = got + removed
          got_taken[name] = (got_taken[name] or 0) + removed
        end
      end
    end
    return got
  end

  local per, totals = {}, { machines = 0, with_slots = 0, put = 0, missing = 0, unplanned = 0 }
  local missing_total, put_total = {}, {}
  for _, e in ipairs(found) do
    local inv = inv_of(e)
    local rows, rec, why_unplanned = plan_for(e)
    local row = { unit_number = e.unit_number, name = e.name, recipe = rec,
      at = { x = math.floor(e.position.x), y = math.floor(e.position.y) } }
    totals.machines = totals.machines + 1
    if not inv then
      row.skipped = "no module slots on this entity"
    elseif type(rows) ~= "table" or #rows == 0 then
      row.unplanned = why_unplanned or "this machine is not in the plan (no modules named for it)"
      totals.unplanned = totals.unplanned + 1
    else
      totals.with_slots = totals.with_slots + 1
      row.wanted, row.put, row.missing, row.extra, row.already = {}, {}, {}, {}, {}
      -- 机器身上已经有什么。**不能**按"名字→数量"那张表读：2.0 上模块库存的 `get_contents()` 交回来的是
      -- 一格一条的 `{name=, count=}`（实测 entry1 = {name="speed-module", count=3}），按名字读的结果是
      -- "这台机器一个模块都没装"，于是它会去要全份、再被引擎退回一片"refused"。两种形状都认，
      -- 并且拿 `get_item_count` 复核一遍（那一只手实测是准的）。
      local have, seen_names = {}, {}
      local okc, contents = pcall(function() return inv.get_contents() end)
      if okc and type(contents) == "table" then
        for key, val in pairs(contents) do
          local name, n = nil, 0
          if type(val) == "number" and type(key) == "string" then name, n = key, val
          elseif type(val) == "table" and type(val.name) == "string" then
            name, n = val.name, tonumber(val.count) or 1
          end
          if name then have[name] = (have[name] or 0) + n; seen_names[name] = true end
        end
      end
      local want_by_name = {}
      for _, w in ipairs(rows) do
        want_by_name[w.item] = (want_by_name[w.item] or 0) + w.count
        row.wanted[#row.wanted + 1] = { item = w.item, count = w.count }
        local each = 0
        pcall(function() each = inv.get_item_count(w.item) end)
        if each and each > 0 then have[w.item] = each; seen_names[w.item] = true end
      end
      for name, n in pairs(have) do if n > 0 then seen_names[name] = true end end
      for name in pairs(seen_names) do
        local already = have[name] or 0
        if already <= 0 then
        elseif want_by_name[name] then
          row.already[#row.already + 1] = { item = name, count = math.min(already, want_by_name[name]) }
        end
        if already > (want_by_name[name] or 0) then
          -- 计划里没这一样，或比计划多：只说出来，不动手。拔模块等于毁玩家手上的东西，
          -- 那不是"把计划装上"这一按的权限。
          row.extra[#row.extra + 1] = { item = name, count = already - (want_by_name[name] or 0) }
        end
      end
      for name, need in pairs(want_by_name) do
        local has = have[name] or 0
        local short = need - has
        if short > 0 then
          local got = (from == "none") and 0 or take_from(name, short)
          local refused = 0
          if got > 0 then
            -- 装进机器走的是模块库存那一只手（实测 `entity.insert` 与 `inventory.insert` 在这台
            -- 2.0 上都收模块，但库存那一只把"引擎不收"的数量原样退回来，不会吞）；退回来的放回原处，
            -- 一个模块都不会凭空多出来或凭空消失。
            local minv = inv_of(e)
            -- 2.0 的 `insert` 回的是**放进去几个**，不是"还剩几个没放"（实测：空机器要 3 回 3；
            -- 已有 3 台面上限 4 时要 3 回 1；到顶后再要 2 回 0）。把它当"没放进去的数量"来减，
            -- 每个模块都会被判成"机器不收"，而实际已经装上了 —— 这份门禁跑第一遍就是那样红的。
            local put = got
            local okins, res = pcall(function() return minv.insert({ name = name, count = got }) end)
            put = (okins and tonumber(res)) or 0
            if put > got then put = got end
            refused = got - put
            if refused > 0 then
              -- 拿出来了却装不进去（槽位满、或这台机器的模块上限不允许）：放回原处，一个都不凭空消失。
              for _, src in ipairs(sources) do
                local okback = pcall(function() src.inv.insert({ name = name, count = refused }) end)
                if okback then break end
              end
            end
            if put > 0 then
              row.put[#row.put + 1] = { item = name, count = put }
              put_total[name] = (put_total[name] or 0) + put
              totals.put = totals.put + put
            end
            short = short - put
          end
          -- 两种"没装上"是分开的两件事：拿不到（去箱子/背包里再放些）与机器不收（模块数或上限的问题）。
          -- 合成一个 `missing` 就是让玩家自己去猜该去补哪一头，而这两头的补法正好相反。
          if short > 0 then
            row.missing[#row.missing + 1] = { item = name, count = short,
              refused = refused > 0 and refused or nil }
            missing_total[name] = (missing_total[name] or 0) + short
            totals.missing = totals.missing + short
          end
        end
      end
      table.sort(row.wanted, function(a, b) return a.item < b.item end)
      table.sort(row.put, function(a, b) return a.item < b.item end)
      table.sort(row.missing, function(a, b) return a.item < b.item end)
    end
    per[#per + 1] = row
  end

  local missing_list = {}
  for name, n in pairs(missing_total) do missing_list[#missing_list + 1] = { item = name, count = n } end
  table.sort(missing_list, function(a, b) return a.item < b.item end)
  local put_list = {}
  for name, n in pairs(put_total) do put_list[#put_list + 1] = { item = name, count = n } end
  table.sort(put_list, function(a, b) return a.item < b.item end)

  return {
    surface = surface.name, force = force_name, area = area, area_from = area_from,
    from = from, sources = #source_said > 0 and source_said or nil,
    plan_source = plan_source,
    machines = totals.machines, with_module_slots = totals.with_slots,
    installed = totals.put > 0 and totals.put or nil, installed_list = #put_list > 0 and put_list or nil,
    missing = totals.missing > 0 and totals.missing or nil,
    missing_list = #missing_list > 0 and missing_list or nil,
    unplanned = totals.unplanned > 0 and totals.unplanned or nil,
    ghosts = ghosts > 0 and ghosts or nil,
    -- 这一片里其他虚影（不是计划里那几台机器）：也装不了，但不该混进上面那个数里。
    ghosts_other = ghosts_other > 0 and ghosts_other or nil,
    by_machine = per,
    note = ghosts > 0
      and "a ghost cannot hold a module (measured: get_inventory(crafter_modules) is nil on a ghost, "
        .. "and 2.0 has no set_module_info) -- build these first, then press this again"
      or "modules came out of the chests/inventory listed in `sources`; nothing was created",
  }
end

-- 让这片地上**已经建好的**机器答应听线（`cb.circuit_set_recipe = true`）。
--
-- 为什么要有这一扇：蓝图那一路把组合器与线都带出去了，唯独机器身上这一格带不住 —— 七种拼法在
-- `set_blueprint_entities` 上全部回读为空（量的那一轮见 `record_behavior` 上面那段）。于是玩家粘完一页
-- 总线线，看到的是"组合器都配好了、线也在、机器就是不动"，而修法是一台一台点开勾一次「从电路网络读取
-- 配方」。手机上这一下很贵，所以把它做成一颗按钮，形状与「把模块装上」一致：
--   * 地 = 上一次压线记下的那一块（`storage.last_helmod_area`），也可以自己给 `area`；
--   * 只碰**真机器**（有 `assembling-machine` 那一类 control behaviour 的），虚影与别的件按数报出来；
--   * 只**读**不猜：勾了没有先读回来，本来就勾着的算 `already`，不动它（这一按再按一次是幂等的）；
--   * 关掉用 `off = true`（同一只手能开也能关，因为"取消听线"在 2.0 也是这一格写 false）。
function M.machine_recipe_control(args)
  args = args or {}
  local surface = resolve_surface(args.surface)
  if not surface then return fail("NO_SURFACE", tostring(args.surface)) end
  local force_name = args.force or "player"
  if not game.forces[force_name] then return fail("NO_FORCE", tostring(args.force)) end
  local want_on = not (args.off == true or args.off == "true")
  local area = args.area or args.box
  local area_from = "args"
  if not area and storage.last_helmod_area then
    area = storage.last_helmod_area.area
    area_from = "last_helmod_area"
  end
  if not area then
    return fail_key("NO_AREA", "m-modules-no-area", { tostring(surface.name) },
      "no area to work on on " .. tostring(surface.name) .. ": press a helmod page onto the ground "
        .. "first (that records which patch the machines are on), or pass area = { x1, y1, x2, y2 }",
      { last = storage.last_helmod_area })
  end
  local function aabb(a)
    if type(a) ~= "table" then return nil end
    if a.x1 then return { { a.x1, a.y1 }, { a.x2, a.y2 } } end
    return a
  end
  local box = aabb(area)
  if not box then
    return fail_key("BAD_AREA", "m-listen-bad-area", tostring(area and "(no x1)" or "?"),
      "area must be {x1,y1,x2,y2} or a box the engine reads", { asked_for = area })
  end

  local ok_scan, listed = pcall(function()
    return surface.find_entities_filtered { area = box, force = force_name }
  end)
  if not ok_scan then listed = {} end

  local per, totals = {}, { machines = 0, set = 0, already = 0, failed = 0 }
  local ghosts, ghosts_other, not_settable = 0, 0, {}
  for _, e in ipairs(listed or {}) do
    if e.valid and e.name == "entity-ghost" then
      local inner = nil
      pcall(function()
        local gp = e.ghost_prototype
        local t = type(gp)
        if t == "function" then gp = gp(e); t = type(gp) end
        if t == "table" or t == "userdata" then inner = gp.name or nil end
      end)
      -- 虚影这一格写得进去（0.80.0 量的：`cb.circuit_set_recipe` 在虚影上读回 true），但那只是**虚影
      -- 身上的设定**，建成之后跟不跟过去这台机器量不到 —— 所以这一按等他建完，与「把模块装上」同一理由。
      if inner and takes_recipe(inner) then ghosts = ghosts + 1
      else ghosts_other = ghosts_other + 1 end
    elseif e.valid then
      local okcb, cb = pcall(function() return e.get_or_create_control_behavior() end)
      local can = okcb and cb ~= nil
      -- `before` 挂在**这一台**这一轮上：从前它声明在下面那个 `if can then` 里面，出了块就没了，
      -- 于是真正读它的那一段拿到的是全局的 nil —— 每台每次都走"写一遍"那支，`already` 永远是 0，
      -- 而这一按的卖点正是"本来就开着的不动"。
      local before = nil
      if can then
        pcall(function() before = cb.circuit_set_recipe end)
        if before == nil then
          -- 这一台没有这一格（熔炉、臂、带子、组合器都不是）：按名字数出去，不混进上面的数里。
          local key = tostring(e.name)
          not_settable[key] = (not_settable[key] or 0) + 1
          can = false
        end
      end
      if can then
        totals.machines = totals.machines + 1
        local row = { name = e.name, at = { e.position.x, e.position.y }, unit_number = e.unit_number,
          recipe = nil, was = before }
        pcall(function() local r = e.get_recipe() row.recipe = r and r.name or nil end)
        if before == true and want_on then
          row.already = true totals.already = totals.already + 1
        else
          local okw, errw = pcall(function() cb.circuit_set_recipe = want_on end)
          local back = nil
          pcall(function() back = cb.circuit_set_recipe end)
          if okw and back == want_on then
            row.changed = want_on
            totals.set = totals.set + 1
          else
            row.why = tostring(errw or ("read back " .. tostring(back))):sub(1, 120)
            totals.failed = totals.failed + 1
          end
        end
        per[#per + 1] = row
      end
    end
  end
  table.sort(per, function(a, b)
    if (a.at[2] or 0) ~= (b.at[2] or 0) then return (a.at[2] or 0) < (b.at[2] or 0) end
    return (a.at[1] or 0) < (b.at[1] or 0)
  end)

  local unplanned = {}
  for k, n in pairs(not_settable) do unplanned[#unplanned + 1] = { name = k, count = n } end
  table.sort(unplanned, function(a, b) return a.name < b.name end)

  if totals.machines == 0 then
    return fail_key("NO_MACHINES_HERE", "m-no-machines-here",
      { tostring(ghosts), tostring(ghosts_other) },
      "this patch has no built machine whose recipe can be taken from a wire"
        .. (ghosts > 0 and (" -- " .. tostring(ghosts) .. " of them are still ghosts") or ""),
      { area = area, area_from = area_from, ghosts = ghosts, ghosts_other = ghosts_other,
        not_settable = #unplanned > 0 and unplanned or nil })
  end
  return {
    surface = surface.name, force = force_name, area = area, area_from = area_from,
    want = want_on and "on" or "off",
    machines = totals.machines, set = totals.set, already = totals.already, failed = totals.failed,
    ghosts = ghosts > 0 and ghosts or nil,
    ghosts_other = ghosts_other > 0 and ghosts_other or nil,
    not_settable = #unplanned > 0 and unplanned or nil,
    by_machine = per,
    note = want_on
      and "each built machine here now reads its recipe from the wire (written and read back -- "
        .. "nothing assumed). The wires themselves still come from the blueprint door: 2.0 has no "
        .. "scripted connection, so a page pressed onto the ground needs them drawn by hand"
      or "the machines here were told to stop reading recipes from the wire; the recipe they hold now "
        .. "is the one they were set to",
  }
end

function M.place_undo(args)
  args = args or {}
  local log = storage.undo or {}
  if #log == 0 then
    return fail_key("NOTHING_TO_UNDO", "m-nothing-to-undo", nil,
      "nothing this mod placed is waiting to be taken back",
      { kept = UNDO_KEPT })
  end
  local want = math.max(1, math.min(tonumber(args.count) or 1, #log))
  local removed, gone, filled, steps = 0, 0, 0, 0
  local standing = {}
  for _ = 1, want do
    local d = table.remove(log)
    if not d then break end
    steps = steps + 1
    local surface = game.surfaces[d.surface]
    for _, m in ipairs(d.made or {}) do
      local e = m.ent
      if e and e.valid then
        pcall(function() e.destroy() end)
        removed = removed + 1
      else
        gone = gone + 1
        -- What IS here now, if anything: "gone" alone reads like nothing happened, and the honest
        -- reading is usually "your ghost became a real machine, and that one is yours".
        local here = surface and surface.find_entities_filtered { position = m.at, radius = 0.1 } or {}
        for _, other in ipairs(here) do
          if other.unit_number ~= m.unit and other.type ~= "character" then
            filled = filled + 1
            standing[#standing + 1] = { at = m.at, was = m.for_name or m.name, now = other.name,
              unit = other.unit_number }
          end
        end
      end
    end
  end
  return {
    undone = steps, removed = removed, already_gone = gone, standing_now = filled,
    standing = #standing > 0 and standing or nil, remaining = #log,
  }
end

-- ...and the arm rig. It is the lane's missing third number: a belt's rate is a formula and a
-- machine's is its recipe, and an inserter's is nothing the prototypes answer, so the only way to know
-- whether the arm on a row can carry what the row makes is to watch one carry it.
M.belt_rate = measure.belt_rate
M.arm_rate = measure.arm_rate
-- The door the rigs use to reach the bench. measure.lua cannot require control.lua -- control
-- requires measure -- so the surface owner hands the accessor down instead, and a build that forgets
-- to wire it refuses rather than defaulting to the map somebody is playing on.
measure.rig_bench = rig_surface

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
           -- The painted, cleared square, as the four corners a caller may build inside. Asked for
           -- rather than remembered: x=300 is a perfectly good rectangle on ground that is not there,
           -- and a suite that lays a card there gets an answer about this save's map edge instead of
           -- one about the plan. Inside this box the tiles are grass and swept; outside it, everything
           -- the mod did not paint belongs to the world.
           usable = pad and { left_top = { x = -pad + 1, y = -pad + 1 },
                              right_bottom = { x = pad - 2, y = pad - 2 } } or nil,
           rig = rig and { surface = rig.name, pad = rig_pad, ready = true,
                           chunk_generated = rig.is_chunk_generated({ 0, 0 }) }
             or { ready = false, reason = rig_why } }
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

-- The lane geometry lives in `styles.lua`, which is where any other way of arranging the same recipe
-- is added. This is the one door `card_example` and `add_supply` lay parts through, so it is also the
-- one place a style's cells become entities -- and the reason `lane_units` keeps its exact old argument
-- list rather than a table of options: three call sites pass positionally, and a signature that changes
-- shape under them turns a moved chest into a wrong `footprint` in a box-fitting answer.
-- 台架那条测量用的线：一台机器、一根进料带、一根成品带，箱子由 `add_supply` 在外面补。
--
-- 从前这里写死 `row-chest`（那种排法已经删了），而它是 `styles` 之外唯一直接调形状几何的地方 —— 一个
-- 签名带位置参数、内部又抄一档形状名的地方，删形状的人必须先想起来这里。现在它走注册表里那档参数化的
-- 单排，行数是 1+1：台架要的不是"最省的形状"，是"一行机器加两面各一条带子"这个最小可测的几何。
lane_units = function(ox, oy, count, furnace, belt, inserter, chest, fw, fh, power, reach, outlets, gap)
  local style = styles.get("stacked")
  if not style then return {} end
  return style.units({ ox = ox, oy = oy, count = count, machine = furnace,
    belt = belt, arm = inserter, chest = chest, fw = fw, fh = fh, power = power, reach = reach,
    outlets = outlets, gap = gap or 0, shared_row = true,
    stack = { feed_rows = 1, product_rows = 1 }, arms_by_reach = { [1] = inserter } }) or {}
end

-- A fact that is only knowable by PUTTING AN ENTITY DOWN AND READING IT BACK has to be kept in
-- `storage`, never in a local. A local is one table per process, so a client that joined a minute ago
-- holds a COLD copy while the server's is warm: the same button press then measures on one side and
-- does not on the other, and the side that measures spends an entity number the other never allocates.
-- Two real desync reports (2026-10-01) carry exactly that signature -- `script.dat` byte-identical on
-- both sides, the client's `next-unit-number` one ahead of the server's -- and no headless gate on this
-- box can see it, because there is no second process to disagree with. `dev/facts_reload_e2e.js` is the
-- closest thing to one: it warms the facts, saves, reloads, and demands the new process answer the same
-- without touching the world again.
--
-- Written lazily rather than at bootstrap because `storage` may not be created or edited during
-- `on_load`: the engine compares its CRC across the load and calls a change "not save/load stable and
-- not multiplayer safe".
-- Facts the mod measured off the world live in the save, and that is exactly their danger: a save
-- carried forward keeps answering with a cache written by an older build, so a fact added later is
-- never measured on the installs that already have a cache. Measured the hard way 2026-10-06 -- the
-- burner flag added below was inert on the test save (reach cached, `burner|` absent, `warm_reach`
-- skipping every inserter whose reach it already knew), and the smelting lane came out with the coal
-- arm and delivered 5/min against its 18.75/min claim. So the cache carries the build that filled it
-- and starts over when that changes.
local PROTO_FACTS_VERSION = 2
local function proto_facts()
  local facts = storage.proto_facts
  if not facts or facts.version ~= PROTO_FACTS_VERSION then
    facts = { version = PROTO_FACTS_VERSION, probes = 0 }
    storage.proto_facts = facts
  end
  return facts
end

-- Inserter reach is not readable from the runtime prototype (type-specific fields
-- are absent there -- measured: every one of pickup_position / insert_position / maximum_distance
-- answers nil on every inserter name tried), so it is measured from a live entity once per type.
-- Hardcoding a reach table would silently rot the moment a modded inserter shows up.
inserter_reach = function(surface, name, force_name)
  if not surface or not name then return 1 end
  local facts = proto_facts()
  local cache_key = "reach|" .. name
  -- Both facts come off the SAME probe, so a cache that has one and not the other has to go back to
  -- the world -- otherwise an install that cached reach before the burner flag existed never learns it.
  if facts[cache_key] ~= nil and facts["burner|" .. name] ~= nil then return facts[cache_key] end
  -- Ask the data stage first: it read `pickup_position` / `starting_distance` off `data.raw` when the
  -- mod set was built, so the figure is the same in every process and costs the world NOTHING. The live
  -- probe below is only a fallback for an inserter that arrives without either key, and it is the thing
  -- two real clients desynced over -- see the header of the block in data.lua.
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
        -- The same probe answers a second question for free, and the second question is the one that
        -- put a coal-burning arm on every lane in the game (see `arm_ladder_for_need`): on the
        -- PROTOTYPE every field that would say it -- energy_source, fuel_inventory_size,
        -- fuel_categories, energy_per_movement, inserter_length -- RAISES, and on the entity
        -- `energy_source` raises too. Only `entity.burner` answers: a LuaBurner for the coal tier and
        -- nil for every electric one (measured 2026-10-06, all six inserter names).
        local okb, burner = pcall(function() return e.burner end)
        if okb then facts["burner|" .. name] = (burner ~= nil) end
        e.destroy()
      end
      break
    end
  end
  facts.probes = (facts.probes or 0) + 1
  facts[cache_key] = reach or 1
  return facts[cache_key]
end

-- Does this arm need fuel? Read off the probe `inserter_reach` already places, so answering it costs no
-- extra world touch, and cached in the same table -- which means the boot warm-up that measures every
-- inserter's reach has already measured whether each one burns, and a press never probes at all.
-- Returns nil for "not measured on this install" (a prototype that appeared after boot), and a caller
-- that has to rank arms treats that as a fact it does not have, not as "electric".
arm_is_burner = function(name)
  local facts = proto_facts()
  if facts["burner|" .. name] ~= nil then return facts["burner|" .. name] end
  return nil
end

-- Does this arm burn fuel? true / false, or nil when this install has never been asked (an inserter
-- that showed up after boot and had no reach measured either). Every lane the mod lays is something a
-- player pastes and expects to RUN; a coal arm starts stopping the tick its coal runs out and nothing in
-- a blueprint feeds it, so this is not a cosmetic ranking -- it is "will the line you asked for still be
-- moving in ten minutes".
arm_is_burner = function(name)
  if not name then return nil end
  local v = proto_facts()["burner|" .. name]
  return v
end

-- Does this entity keep the facing it is built with? It cannot be read: 2.0 does not expose
-- `rotatable` to a script (measured: `prototypes.entity[X].rotatable` answers nil for every name tried),
-- and the answer is not uniform -- asked for south on this build, a chemical plant, an oil refinery, a
-- belt, an arm, a combinator and a mining drill all came back south, while an assembling machine, every
-- furnace, a centrifuge and a lab came back NORTH and then ignored a written `direction` too. A ghost is
-- no better: an assembling-machine ghost made at direction 8 revives facing 0.
--
-- So the fact is won the way every other fact here is won -- put one down, read it back, take it up again.
-- It is a property of the prototype, so the answer is remembered per name exactly like a reach is --
-- in `storage`, for the reason `proto_facts` spells out. Anyone tempted to answer this from `direction` on the card
-- should remember what it costs: the fluid feed is the thing that found out, and a row drawn against the
-- facing the card claimed ends up on the wrong side of the machine it was laid to feed.
keeps_facing = function(surface, name, force_name)
  if not surface or not name then return nil end
  local facts = proto_facts()
  local cache_key = "facing|" .. name
  if facts[cache_key] ~= nil then return facts[cache_key] end
  local asked = DIR.east
  local kept
  for r = 0, 10 do
    local pos = { x = -r * 4 - 2, y = -r * 4 - 2 }
    if surface.can_place_entity { name = name, position = pos, force = force_name, direction = asked } then
      local e = surface.create_entity { name = name, position = pos, force = force_name, direction = asked }
      if e then
        local got = e.direction
        pcall(function() e.direction = DIR.west end)
        -- Both answers have to agree: a machine that reports east from `create_entity` and then refuses a
        -- written facing is a shape that can be laid once and edited never, and the feed row is laid
        -- against the facing the entity will actually hold.
        kept = (got == asked) and (e.direction == DIR.west)
        e.destroy()
      end
      break
    end
  end
  facts.probes = (facts.probes or 0) + 1
  facts[cache_key] = kept == true
  return facts[cache_key]
end

-- Every arm on this install, reached. A measurement is a write to the world -- one entity put down and
-- taken up again -- so it belongs at a moment when no second process can be surprised by it: `on_init`,
-- `on_configuration_changed`, or a caller asking here before a client joins. Returns how many figures it
-- had to go and win; 0 means the save already carried them, which is what a loaded process should see.
warm_reach = function()
  local facts = proto_facts()
  local took = 0
  for name, p in pairs(prototypes.entity) do
    if p.type == "inserter" and (facts["reach|" .. name] == nil or facts["burner|" .. name] == nil) then
      took = took + 1
      inserter_reach(game.surfaces[1], name, "player")
    end
  end
  return took
end

-- The measured facts, as an answer: what the mod knows, how many times it had to touch the world to
-- know it, and -- with `warm` -- the chance to take those measurements NOW rather than on a player's
-- click. `drop` throws them away, which is how a gate proves the next press really does go and look.
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
  -- whatever no consumer took has to land somewhere visible, not on the ground -- and it lands there by
  -- ARM, because a belt pointing straight at a chest delivers nothing. Measured 2026-10-03 with a control
  -- lane (`dev/underground_pair_probe.js` W3): a six-tile run ending on a steel chest left that chest empty
  -- for three minutes while the source box still held 176 of 200 -- the run jams, it does not dump -- and
  -- the same run with an arm beside its last cell moved all 200.
  --
  -- The arm stands SOUTH of the spine, on the same two rows the tap boxes use: the first version of this
  -- put them north, which pushed the collector to `oy - 2*reach`, a negative row, and a card with negative
  -- coordinates is what `region_layout` then failed to compose -- the bus is built by hand rather than by a
  -- `styles` shape, so nothing normalizes it for it.
  local spine_end = ox + feed + span - 1
  out[#out + 1] = { name = inserter, cell = { spine_end, oy + R }, dir = DIR.north }
  out[#out + 1] = { name = chest, cell = { spine_end, oy + 2 * R }, dir = 0, role = "collector" }
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

-- Where a rig stands, and which part names it put there. Stored handles are not a guarantee: a job that
-- finishes between two calls can come back with `valid == false` on entities that are still standing, and
-- then nothing ever takes the rig home -- `bench_check` watched the surface a player loads gain a whole
-- 27-part lane per suite that ran the smelting rig. The sweep destroys only the names this rig says it
-- laid, inside the box it laid them in, so it can never eat a player's own base.
local function rig_site(j, surface_name, list, also)
  if not list then return end
  local minx, miny, maxx, maxy, names = nil, nil, nil, nil, {}
  for _, s in ipairs(list) do
    -- A plain spec carries `cell`; a live LuaEntity carries `position` and RAISES on an unknown key, so
    -- the table test comes first rather than `s.cell or s.position`.
    local is_spec = type(s) == "table"
    local p = is_spec and (s.cell or s.position) or s.position
    local x, y = p and p.x or (p and p[1]), p and p.y or (p and p[2])
    if x and y then
      x, y = math.floor(x), math.floor(y)
      minx = math.min(minx or x, x); miny = math.min(miny or y, y)
      maxx = math.max(maxx or x, x); maxy = math.max(maxy or y, y)
    end
    if s.name then names[tostring(s.name)] = true end
  end
  -- The parts a rig hands out after the shape is laid (its own supply chests, the collector at the end of
  -- a product line) are not in the plan; their names still belong to the rig, so they go in the same set.
  for _, s in ipairs(also or {}) do
    if s.name then names[tostring(s.name)] = true end
  end
  if not minx then return end
  j.site = { { minx - 2, miny - 2 }, { maxx + 2, maxy + 2 } }
  j.surface_name = surface_name
  j.site_names = names
end

-- Everything the rig named still standing inside its own box. Returns how many it took.
local function sweep_rig_site(j)
  local box, names = j.site, j.site_names
  if not box or not names then return 0 end
  local s = j.surface_name and game.surfaces[j.surface_name] or nil
  j.site, j.site_names = nil, nil
  if not s then return 0 end
  local gone = 0
  for _, e in ipairs(s.find_entities_filtered { area = box, force = "player" }) do
    if names[e.name] and e.valid then
      if pcall(function() e.destroy() end) then gone = gone + 1 end
    end
  end
  return gone
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
    return fail_key("NO_AVAILABLE_PART", "m-part-rig", nil, "the rig needs a furnace, a belt, an arm and a container",
      { furnace = furnace, belt = belt, arm = inserter, chest = chest })
  end
  local recipe = args.recipe or "iron-plate"
  local product = args.product or recipe
  local ingredient = args.ingredient or "iron-ore"
  local fuel = args.fuel or "coal"
  local seconds = args.seconds or 30
  -- One policy call, at the top: a warp that has to be refused because somebody is playing must
  -- be refused before the rig exists, not after the entities are placed and the ore is gone.
  local speed, warp_refused = host.clock_policy(args.speed)
  if warp_refused then return warp_refused end
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
  -- Times the yield per craft, because `measured_per_min` counts ITEMS out of the output and this number
  -- is what it is divided into (`finalize_lab`). Copper-cable makes 2 per craft: a line running at exactly
  -- its nameplate was reported at ratio 2.0, i.e. "over-producing by double", while a line at half speed
  -- reported 1.0 and was certified as paying its claim.
  local expected_per_min = count * (60 / (energy / m_speed)) * expected_yield(rp, product)

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
        name = s.name, position = styles.centre(s.cell, w, h, s.dir),
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
    return fail_key("NO_CLEAR_SITE", "m-no-site-lane-origin", nil, "no origin fits a lane; pass an explicit origin", tried)
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
        local pos = styles.centre(s.cell, w, h, s.dir)
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
  -- The site too, because handles alone leak: a finished job whose stored entities went invalid still
  -- left every belt and arm standing on the surface a player loads (measured: +27 parts on nauvis per
  -- run of this rig). The sweep below takes home only the names this rig laid, in the box it laid them.
  rig_site(storage.lab, surface.name, specs, built)
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
    -- what the world pays while this runs: said at the start, not only in the verdict
    clock = host.clock_note(speed, seconds),
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
  -- One policy call, at the top: a warp that has to be refused because somebody is playing must
  -- be refused before the rig exists, not after the entities are placed and the ore is gone.
  local speed, warp_refused = host.clock_policy(args.speed)
  if warp_refused then return warp_refused end
  local fuel = args.fuel or "coal"

  local mp = prototypes.entity[machine]
  if not mp then return fail("UNKNOWN_MACHINE", machine) end
  local rp = prototypes.recipe[recipe]
  if not rp then return fail("UNKNOWN_RECIPE", recipe) end

  local m_speed = getter(mp, "get_crafting_speed") or getter(mp, "get_researching_speed")
  if not m_speed then return fail("NOT_A_CRAFTER", machine) end
  local energy = field(rp, "energy")
  -- The expected-yield rule, in one function now (`expected_yield`, beside `box_size`). Four hand-kept
  -- copies of it existed, and the one that mattered most -- `lab_card`, which prices a whole window
  -- verdict against this figure -- had none of it and so reported any recipe yielding more than one item
  -- per craft as over-producing by exactly that factor.
  local product = args.product or recipe
  local yields = expected_yield(rp, product)
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
  -- The same site record as the smelting rig: this one builds on the bench, but a job whose handles went
  -- stale should still be able to say what it put where. `built` is the live-entity list this rig makes,
  -- and a LuaEntity carries `position` (indexing it for a `cell` would raise), so it stands for both
  -- sides of the record.
  rig_site(storage.lab, surface.name, built)

  host.clock_raise(speed)

  return {
    job = storage.lab.id,
    state = "running",
    -- what the world pays while this runs: said at the start, not only in the verdict
    clock = host.clock_note(speed, seconds),
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
  if not j then return fail_key("NO_JOB", "m-no-lab-job", nil, "no lab job has been started") end
  local elapsed = game.tick - j.started
  return {
    job = j.id, state = j.state,
    -- what the world was run at while this was measured, from the job record rather than from the
    -- clock as it happens to read right now
    clock = host.clock_note(j.clock_speed, j.clock_seconds),
    bench = j.on_bench,
    -- and which ground, since the panel says where the number came from
    surface = j.surface,
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
    -- 台架自己的天花板（几只收臂 × 一只搬多少）——读数低时先问这一行，再问这条线
    drain = j.drain,
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
    -- The rigs look their entities up by unit number every tick, so they carry identity rather than
    -- handles and have never had the desync above. All three of them share the world clock, which is
    -- what `busy_refusal` is for -- so every rig that can hold the clock has to be named here, or a
    -- caller reading the bench is told "nothing is running" while the world is at 60x.
    drill_job = storage.drill_job ~= nil,
    pump_job = storage.pump_job ~= nil,
    farm_job = storage.farm_job ~= nil,
    arm_job = storage.arm_job ~= nil,
    belt_job = storage.belt_job ~= nil,
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

-- The lab's own parts, which `j.ents` never held: a fluid run is a tank plus a run of pipes laid
-- beside the machine, and a probe is a single pipe laid to find which cell the box is on. Every way
-- out of a job took the card back and dropped `j.rig` on the floor, so a fluid measurement left its
-- plumbing standing -- measured: eleven pipes on the lab's card site after one run, with nothing but
-- other pipes next to them. That is not untidy, it is load-bearing wrong: the next run finds a pipe
-- already on the cell it wanted, calls it "the card's own plumbing", adopts it, and measures against
-- yesterday's litter.
local function rig_teardown(j)
  local rig = j.rig
  if not rig then return 0 end
  local gone = 0
  for _, r in ipairs(rig.runs or {}) do
    local ok = pcall(function() fluidrig.destroy(r) end)
    if ok then gone = gone + 1 end
  end
  local st = rig.probe
  if st and st.probes and #st.probes > 0 then
    -- `destroy_offers` takes everything the probe pass laid that the card did not already own:
    -- a tank with no machine to feed it, and the pipe it was offered through. Measured with the tank
    -- and the pipe gone from the world, so it is a clean-up and not a leak that is being counted.
    pcall(function() fluidrig.destroy_offers(st.probes) end)
    gone = gone + #st.probes
    st.probes = {}
  end
  rig.runs = {}
  return gone
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
  local rig_gone = rig_teardown(j) + sweep_rig_site(j)
  j.ents, j.rig = nil, nil
  j.destroyed = gone + rig_gone
  if j.prev_speed then host.clock_lower(j.prev_speed) end

  return {
    job = j.id, state = j.state,
    -- what the world was run at while this was measured, from the job record rather than from the
    -- clock as it happens to read right now
    clock = host.clock_note(j.clock_speed, j.clock_seconds),
    bench = j.on_bench,
    -- and which ground, since the panel says where the number came from
    surface = j.surface,
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
  if not j then return fail_key("NO_JOB", "m-nothing-to-stop", nil, "nothing to stop") end
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
    -- The rig's plumbing too: a reset that only took the card back is how a stale record left
    -- eleven pipes standing on the bench for the next job to adopt as "the card's own".
    cleared = cleared + rig_teardown(j) + sweep_rig_site(j)
    j.ents, j.rig = nil, nil
    storage.lab = nil
    if j.prev_speed then host.clock_lower(j.prev_speed) end
  end
  -- What the rigs measured is bench state too. A cached rate silently changes which machine the
  -- solver picks for the next request, so a suite that resets the bench and then plans would plan
  -- against a world some earlier run probed.
  local forgotten = 0
  -- `arms` belongs on this list: it is the same kind of record as the other three (a rate the bench won
  -- by running a window), it is read by `measured_arm_row` to price every shape that lifts into a chest,
  -- and nothing else ever clears it. A reset that forgot it left the next plan sized on a window the
  -- caller had just been told to distrust.
  for _, cache in ipairs({ "drills", "pumps", "farm", "arms" }) do
    for _ in pairs(storage[cache] or {}) do forgotten = forgotten + 1 end
    storage[cache] = nil
  end
  return { cleared_entities = cleared, forgot_measurements = forgotten, had_job = j and j.id or nil }
end

-- An error thrown out of on_nth_tick is non-recoverable: Factorio tears the whole
-- server down and leaves game.speed raised. The lab walks cards somebody else authored,
-- so it must never be able to take the game with it.
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
  -- The card's own inlet rows first. A lane that laid a pipe to its box has done this rig's plumbing
  -- for it, and the row is metered from its own port: one pour point serves every machine on the line,
  -- and it is the only shape that fits -- the bench measurement that started this was three
  -- `TANK_REFUSED`s, because the lane's own belts and arms stand where a per-machine tank would go.
  local rows, plain = {}, {}
  for _, f in ipairs(st.found) do
    if f.source == "card_row" and f.row then
      local k = f.row .. "|" .. f.fluid
      if not rows[k] then rows[k] = { row = f.row, fluid = f.fluid, face = f.face, at = {} } end
      rows[k].at[#rows[k].at + 1] = f.at
    else
      plain[#plain + 1] = f
    end
  end
  local keys = {}
  for k in pairs(rows) do keys[#keys + 1] = k end
  table.sort(keys)
  local stranded = {}
  for _, k in ipairs(keys) do
    local g = rows[k]
    table.sort(g.at)
    st.built[k] = true
    local port = rig.machine_of[g.row]
    local made, why
    if port and port.valid then
      -- 倒空箱体那一步在 `fluidrig.row_source` 里（它接的就是这台机器），这里不重复一遍
      made, why = fluidrig.row_source(port, rig.machine_of[g.at[1]], g.face, surface, j.force, g.fluid)
    else
      why = "PORT_GONE"
    end
    if made then
      made.at, made.serves = g.row, g.at
      rig.runs[#rig.runs + 1] = made
      -- and nothing is added to the rig's entities: a metered row owns no entity of its own, its
      -- header is the card's pipe, and the card's own teardown takes that back with the shape
    else
      -- Not a verdict: those machines go back through the box table and the discovery pass, which is
      -- how every lane was measured before it could lay its own row. A note says which way was tried.
      st.built[k] = nil
      for _, a in ipairs(g.at) do stranded[#stranded + 1] = { at = a, fluid = g.fluid } end
      rig.notes[#rig.notes + 1] = { fluid = g.fluid, row = g.row, why = why,
        msg = "the lane's own port at row " .. tostring(g.row) .. " would not take a tank (" .. tostring(why)
          .. "); its machines are being fed by the rig's own runs instead" }
    end
  end
  if #stranded > 0 then
    -- Back into the queue with nothing claimed about their cells: a row the ground refused is not
    -- evidence about a box either. What is kept is what this pass actually settled.
    st.found = plain
    for _, ob in ipairs(stranded) do st.queue[#st.queue + 1] = { at = ob.at, fluid = ob.fluid } end
    return "rediscover"
  end
  local by_machine = {}
  for _, f in ipairs(plain) do
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

-- Everything the rig has to keep doing while the world runs: ingredients into the chests, fuel into the
-- burners, products out of the boxes, and the supply tanks full.
--
-- The proving window runs this too. A machine only takes fluid when a craft starts, and a craft needs
-- its ITEMS as much as its water -- so a prove pass that feeds the tanks and starves the chests measures
-- a machine that was never able to drink, and then blames `boxes.lua` for it. Measured exactly that
-- way: a concrete lane's three water runs gave up nothing, every entry was rejected as stale, and the
-- rediscovery that followed could not probe the cells its own adopted pipes were standing on.
-- Returns how many of the rig's fixtures are still live, which is what says whether the job has ground
-- from under it at all.
local function keep_supplied(j, rig)
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
  -- 裸带线头的料是从带子股道进去的：每根进料带的最西一格，把对应的那一种插进对应的那一股。这代替的
  -- 是上面那个"往箱子里灌"的循环 —— 一条零箱子的线没有箱子可灌，而它仍然是可喂的（玩家自己就是这么接
  -- 总线的）。数出来的 `fed` 与 `fed_blocked` 走同一本账，所以"喂了多少"这件事不因喂法不同而换个说法。
  for _, f in ipairs(rig.lane_feeds or {}) do
    if f.belt.valid then
      alive = alive + 1
      local on_line = 0
      pcall(function() on_line = f.belt.get_transport_line(f.line).get_item_count(f.item) end)
      -- 补到 8 件为止，而不是每 tick 都灌一手：一根带子那一格装得下的就那么多，多插的会往上游堆，
      -- `fed` 就变成"台架倒进去多少"而不是"这条线吃了多少"。饿着的线要能从这里读出来。
      if on_line < 8 then
        local want = 8 - on_line
        local ok = pcall(function()
          f.belt.get_transport_line(f.line).insert_at_back({ name = f.item, count = want }, 1)
        end)
        if ok then j.fed = j.fed + want else j.fed_blocked = j.fed_blocked + 1 end
      end
    end
  end
  -- A supply tank is a reservoir, not a hose: it has to stay full or the machine runs out of
  -- fluid mid-window, and the tail of the measurement becomes a starvation curve rather than a
  -- rate. What it actually gave up is also the proof that the run sits on the box it was found
  -- at, which is the only evidence of that geometry the engine offers.
  for _, r in ipairs(rig.runs) do
    if (r.tank and r.tank.valid) or (r.header and r.header.valid) then
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
  return alive
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
  -- The stopwatch starts here, so what was gathered before it does not count. Proving now feeds the
  -- chests, which means a machine can craft during those two seconds -- and production taken from the
  -- collectors or the boxes before `started` would be a rate the window never ran.
  rig.drains = {}
  for _, c in ipairs(rig.collect or {}) do
    if c.entity and c.entity.valid then
      local base = {}
      for item in pairs(j.contract or {}) do
        local have = 0
        pcall(function() have = c.entity.get_item_count(item) end)
        base[item] = have
      end
      c.baseline = base
    end
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
    r.last = fluidrig.supply_holds(r)
  end
  rig.probe.until_tick = game.tick + LAB_PROVE_SETTLE
  j.state = "proving"
end

local function prove_tick(j, rig)
  local st = rig.probe
  keep_supplied(j, rig)
  -- Settled as soon as every tank has given up something, because a tank only gives when a machine
  -- takes: a concrete assembler has to have its five stone bricks carried to it by an arm before its
  -- first craft can drink, and that is seconds rather than ticks. Waiting for the last one to move is
  -- the whole proof, so the pass ends the moment they all have -- and not before `until_tick`, which is
  -- what stops a recipe that will never drink from being measured as one that does.
  local waiting = false
  for _, r in ipairs(rig.runs) do
    -- 一条一直灌满的排管量不出"少了多少"（机器喝一口，下一拍就补回去），所以它自己那一格永远读"满"。
    -- 看箱子：起点是空的（`row_source` 刚倒过），里面现在有这种流体，就只有这一排送得进去。
    if (r.moved or 0) <= 0 and not (r.source == "card_row" and fluidrig.row_reaches(r)) then
      waiting = true break
    end
  end
  if waiting and game.tick < st.until_tick then return end
  local stalled, unproven = {}, {}
  for _, r in ipairs(rig.runs) do
    local reached = r.source == "card_row" and fluidrig.row_reaches(r) or false
    if (r.moved or 0) <= 0 and not reached then stalled[#stalled + 1] = r
    else unproven[#unproven + 1] = r end
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
    --
    -- Except what the CARD laid: an inlet row the card brought with it is part of the shape being
    -- measured, not a claim this rig made and can take back. It stays, and the machines it feeds are
    -- not thrown into discovery, which cannot probe through it.
    local kept, runs = {}, {}
    for _, r in ipairs(rig.runs) do
      if r.source == "card_row" then
        runs[#runs + 1] = r
        for _, a in ipairs(r.serves or {}) do kept[a .. "|" .. r.fluid] = true end
      else
        fluidrig.destroy(r)
        st.built[r.at .. "|" .. r.fluid] = nil
      end
    end
    for _, r in ipairs(rejected) do
      rig.notes[#rig.notes + 1] = { fluid = r.fluid, at = r.at, claimed = r.face,
        why = "BOX_TABLE_STALE",
        msg = "boxes.lua puts " .. r.fluid .. " at " .. r.face .. " of entity " .. r.at
          .. ", and nothing was drawn from a row laid there; the whole machine is being discovered"
          .. " instead, and that entry wants correcting" }
    end
    -- Everything the card feeds through its own row keeps its place; the rest of the machine's
    -- geometry is unknown again and goes back through discovery.
    local keep_found = {}
    for _, f in ipairs(st.found) do
      if kept[f.at .. "|" .. f.fluid] then keep_found[#keep_found + 1] = f end
    end
    rig.runs, st.found, st.queue = runs, keep_found, {}
    for _, ob in ipairs(st.all) do
      if not kept[ob.at .. "|" .. ob.fluid] then
        st.queue[#st.queue + 1] = { at = ob.at, fluid = ob.fluid }
      end
    end
    j.state = "probing"
    return
  end
  if #stalled > 0 then
    -- every row here was laid on a cell the discovery itself named, and one of them draws nothing:
    -- no further guessing helps, so the job names the fluids it could not feed and stops
    for _, r in ipairs(stalled) do
      local machine = rig.machine_of[r.at]
      if r.source == "card_row" then
        -- The row is the card's own claim, so a tank that gives nothing against it is said about the
        -- row rather than about boxes.lua: the pipe the card laid does not carry this fluid to a box.
        rig.problems[#rig.problems + 1] = { fluid = r.fluid, row = r.at, serves = r.serves,
          side = r.face, tank = r.tank_pos, header = r.header and r.header.position,
          held = fluidrig.supply_holds(r),
          -- 箱子空着才是这条判断的依据；写读数，别让人去猜"是不是又被补满了"
          box = (function() local _, holds = fluidrig.row_reaches(r) return holds end)(),
          why = "CARD_ROW_NOT_FED",
          msg = "the lane's own inlet row, joined at its port, lost no fluid in the proving window:"
            .. " the pipe it laid does not reach " .. r.fluid .. " into a box of the machines it serves" }
      else
        rig.problems[#rig.problems + 1] = { fluid = r.fluid, at = r.at, face = r.face,
          cells = r.cells, anchor = r.anchor, tank = r.tank_pos,
          header = r.header and r.header.position,
          pipes = #(r.pipes or {}), adopted = #(r.adopted or {}),
          filled = r.started, holds = fluidrig.supply_holds(r),
          machine_boxes = machine and fluidrig.boxes(machine) or nil,
          why = "RUN_NOT_PROVEN",
          msg = r.fluid .. " was laid on the cell that took it during discovery and its tank still"
            .. " has given up nothing" }
      end
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
  local again = probe_build(j, rig)
  if again == "rediscover" then
    -- A row the ground would not take a tank beside: those machines are unknown again, and this pass
    -- says so in `rig.notes` rather than as a verdict.
    j.state = "probing"
    j.deadline = game.tick + LAB_PROBE_TICKS
    return
  end
  if #rig.problems > 0 or #rig.runs == 0 then open_window(j, rig) return end
  prove_start(j, rig)
end

-- An error thrown out of on_nth_tick is non-recoverable: Factorio tears the whole server down and
-- leaves game.speed raised. The lab walks cards somebody else authored, so it must never be able to
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
    local alive = keep_supplied(j, rig)
    if alive == 0 then
      abandon_lab(j, "its live entity handles were gone on a later tick")
      return
    end
    if game.tick >= j.deadline then
      local got = {}
      for _, c in ipairs(rig.collect) do
        if c.entity.valid then
          for item in pairs(j.contract) do
            pcall(function()
              -- what the window delivered, not what the chest happened to hold: anything the proving
              -- pass put in there was produced before the stopwatch started
              local n = c.entity.get_item_count(item) - ((c.baseline or {})[item] or 0)
              if n > 0 then got[item] = (got[item] or 0) + n end
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
          units = r.moved, tank = r.tank_pos, header = r.header and r.header.position,
          -- a row the CARD laid serves every machine on it from one tank, and says which ones
          serves = r.serves, row = r.source == "card_row" and r.at or nil,
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
  if ok or not storage then return end
  -- the job is read back out of storage, not closed over: `job` was never a local here, so the
  -- death record named no job and the `if job then` below never ran -- a rig that raised in its
  -- step left its entities standing in the world and its clock raised, and the only clue was a
  -- reason string with nothing pointing at which job it happened to.
  local job = storage[job_field]
  storage[dead_field] = { reason = "RUNNER_RAISED", job = job and job.key, msg = host.errtext(err),
                          tick = game.tick }
  -- Keyed like the death record beside it. This text used to sit on the RIG, so the next request that
  -- touched it -- about another machine, another ore, another seed -- was refused with somebody else's
  -- crash and never got the cached figure it should have answered with.
  storage[error_field] = { job = job and job.key, msg = host.errtext(err), tick = game.tick }
  if job then
    if reap then pcall(reap, job) end
    -- only a job that raised the clock is allowed to put it back. A watch never touches the clock,
    -- so lowering it on a dead watch would reset a speed the player set themselves -- and the
    -- write would land in one of several places, which is the desync this file keeps refusing.
    if job.prev_speed ~= nil then host.clock_lower(job.prev_speed, job.prev_paused) end
    storage[job_field] = nil
  end
end

script.on_nth_tick(1, function()
  -- `storage` does not exist yet while the control stage is being loaded, and a tick handler that
  -- indexes it takes the whole step down with it: Factorio logs the raise and the rig never runs.
  -- Every job read below goes through storage, so the guard is here rather than in each step.
  if not storage then return end
  drive_measurement(measure.step_drill_job, "drill_job", "drill_dead", "drill_error", measure.reap_rig)
  drive_measurement(measure.step_pump_job, "pump_job", "pump_dead", "pump_error", measure.reap_parts)
  drive_measurement(measure.step_farm_job, "farm_job", "farm_dead", "farm_error", measure.reap_farm_rig)
  drive_measurement(measure.step_arm_job, "arm_job", "arm_dead", "arm_error", measure.reap_arm_rig)
  drive_measurement(measure.step_belt_job, "belt_job", "belt_dead", "belt_error", measure.reap_belt_rig)
  -- A watch holds nothing in the world and raises nothing, so dying is only a missed window: the
  -- record of why is kept, the job is dropped, and there is no rig to reap or clock to put back.
  drive_measurement(measure.step_watch_job, "watch_job", "watch_dead", "watch_error")
  local ok, err = pcall(run_lab_tick)
  if ok or not storage then return end
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
    gone = gone + rig_teardown(j)
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
-- The caller-facing shape of a refusal, written in the one place that knows it.
--
-- The panel's envelope and the RCON interface each used to pick the fields out by hand, which is how a
-- new member of a failure record arrived in one and not the other -- a sentence the window can render and
-- a designer over RCON cannot is the same bug as the reverse, and neither shows up as a failure anywhere.
local function refusal_of(res)
  local t = { ok = false, code = res.code, msg = res.msg, detail = res.detail }
  -- Additive on purpose (see `host.fail_key`): a caller that reads only `msg` keeps reading exactly what
  -- it always read.
  if res.msg_key then t.msg_key, t.msg_params = res.msg_key, res.msg_params end
  return t
end

local function envelope(res)
  if type(res) ~= "table" then return { ok = false, code = "BAD_RESULT", msg = tostring(res) } end
  if res.fail then return refusal_of(res) end
  return { ok = true, data = res }
end

-- The panel's whole view of the mod. It takes the player's index because two of the verbs are about
-- what THAT player selected and where THAT player is standing -- an api with no player in it could
-- only ever guess, and a guess reported as an answer is what the rest of this file exists to avoid.
-- The box a given player last dragged, as the panel shows it: surface, corners, and how many things
-- are in it. Nil when nobody has, which the panel renders as a refusal rather than an empty card.
-- A Factorio chunk is 32x32 tiles on every surface this build generates, and `is_chunk_generated` asks
-- in those units -- which is the only way to tell "nothing stands here" apart from "this ground is not
-- there yet", and the two lead to different next clicks.
local CHUNK = 32

-- Which row of the panel's menu a product sits on, found by name.
--
-- Looked up rather than carried over from the last answer, because the menu is rebuilt from the
-- force's unlocked recipes every time the window opens: a row index remembered across a research is a
-- different product by then, and the form would plan the wrong thing while looking exactly right.
-- What the window has to remember about the last press. Every field here is a widget the rebuild
-- repaints from `goal`, so a press that answered without storing is the window denying what it drew:
-- the player ticks 带供电, presses 能否放下, and the tick is gone while the boxes it laid are not.
--
-- One list on purpose. `plan` used to write these fields out one by one and every other press wrote
-- none, so each new picker had to be added in the one place that happened to remember -- and the row
-- below it (the hardware pickers, then the bus ticks) is exactly where that habit was noticed.
-- `style` is derived (`style_named`) rather than copied, and item/rate/unit come from the ANSWER, so
-- those three are filled in by the caller.
FORM_GOAL_KEYS = {
  "machine", "module", "module_count", "power", "spacing", "spacing_index",
  "round", "round_index", "round_when", "round_when_index",
  "orientation", "orientation_index", "style_index",
  "belt", "belt_index", "arm", "arm_index", "chest", "chest_index", "pole", "pole_index",
  "fit_mode", "fit_mode_index",
  "bus_mode", "bus_mode_index", "bus_target", "bus_each", "bus_on", "bus_counts",
  "rig", "rig_index", "rig_item", "rig_machine", "rig_machine_index",
  "rig_surface", "rig_surface_index", "rig_seconds",
  "helmod_factory", "helmod_factory_index",
}

-- Merged into the player's existing record rather than replacing it: the goal is not all that lives
-- there (the card page they opened and the page of the window they are standing on are the same table),
-- and a whole-table assignment silently took them back out.
local function remember_form(index, args, answered, fresh)
  if not index or type(args) ~= "table" then return end
  storage = storage or {}
  storage.gui_panel = storage.gui_panel or {}
  local st = storage.gui_panel[index] or {}
  -- `fresh` is the 算一下 press: it states the WHOLE configuration, so a field it does not carry is a
  -- field the player let go. Merging there kept a pinned machine alive across a later retarget, and the
  -- row button then refused with MACHINE_WRONG_CATEGORY for a hint nobody was still holding -- the pin
  -- outliving the press that set it is exactly how a picker stops being explainable. The other presses
  -- (能否放下 / 总线 / 台架) carry one row's fields and merge, because they are not a statement about
  -- the rest of the form.
  local goal = (not fresh and st.goal) or {}
  for _, key in ipairs(FORM_GOAL_KEYS) do
    if args[key] ~= nil then goal[key] = args[key] end
  end
  local style = style_named(args)
  if style then goal.style = style end
  if type(answered) == "table" then
    if answered.item then goal.item = answered.item end
    if answered.rate_shown then goal.rate = answered.rate_shown end
    if answered.unit_shown then goal.unit = answered.unit_shown end
  end
  st.goal = goal
  storage.gui_panel[index] = st
  return st
end
-- 面板的全部动作，删到只剩四个动词：重建窗口要的模型、把一页 helmod 压成线、把每一页都压进蓝图库、
-- 把上一次铺到地面的东西撤回。从前这里有二十多个动词（算一下 / 能否放下 / 台架 / 总线 / 电力 / 冻结 /
-- 卡片列表 / 提问队列 / 线视 / 测量 / 存档……），每一个都要 gui.lua 里一段渲染、一叠 locale 文案和一条
-- 断言陪着 —— 陪葬的代码比动词本身长得多，而它们全都不在"读 helmod → 出蓝图"这条链上。
local function gui_api(player_index, person)
  local player = person or (player_index and game.get_player(player_index))
  -- 替身玩家（自测里那个）没有真正的 surface/force/位置，所以每一样都得先确认在不在：
  -- 直接 `player.surface.name` 在无头自测里是 index 一个 nil，报错的那一行看起来像面板坏了，其实只是替身没带这块地。
  local here = function() return player and player.valid and player.surface and player.surface.name or nil end
  local force_of = function() return player and player.valid and player.force and player.force.name or nil end
  -- 线是从玩家脚下往外铺的，所以原点取脚位而不是表单里的某个数：他站在哪儿就铺到哪儿。
  local at = function()
    local p = player and player.valid and player.position
    return p and { x = math.floor(p.x), y = math.floor(p.y) } or nil
  end
  return {
    model = function() return M.gui_model({ player_index = player_index }) end,
    -- 一页 helmod → 若干条线。`style` / `heads` 是玩家留在下拉里的那两格偏好（第 1 行是空串，
    -- `style_named` 读成"没表态"，于是形状由阶梯按机器数与料种数给）；`factory` 是那一按选中的工厂页。
    helmod = function(form)
      remember_form(player_index, form)
      return envelope(M.helmod_ghosts({
        surface = here(), origin = at(), force = force_of(),
        factory = (form or {}).helmod_factory,
        style = (form or {}).style,
        heads = (form or {}).heads,
        belt = (form or {}).belt,
        player_index = player_index,
      }))
    end,
    -- 每一页各出一张蓝图，进库 —— "把我算好的工厂都做成蓝图"那一按。库是唯一装得下多张的地方（手上只
    -- 能持一件）。它是上面那一按的循环，不是第二份几何：两扇门各算各的时候，就是其中一扇开始对计划
    -- 撒谎的时候。
    helmod_all = function(form)
      remember_form(player_index, form)
      return envelope(M.helmod_blueprints({
        surface = here(), force = force_of(),
        style = (form or {}).style, heads = (form or {}).heads,
        belt = (form or {}).belt,
        player_index = player_index, into = "pack",
      }))
    end,
    -- 把模块装进**已经建好的真机器**。页还是那一格选的页（与压线同一个下拉），地用上一按记下的那一块，
    -- 所以手机上按这一颗不需要再框地、再选页。它只从地上的箱子/他的背包里拿现成的模块，不造。
    modules = function(form)
      remember_form(player_index, form)
      return envelope(M.machine_modules({
        surface = here(), force = force_of(), player_index = player_index,
        factory = (form or {}).helmod_factory,
      }))
    end,
    -- 让这片地上**已经建好的**机器答应听线（`cb.circuit_set_recipe = true`）。蓝图带不住机器这一格
    -- （七种拼法实测全部回读为空），所以粘完一页总线线要一台台勾 —— 这一颗替他勾。地与「把模块装上」
    -- 用同一份（上一按记下的那一块），所以手机上不用框第二次。
    listen = function(form)
      remember_form(player_index, form)
      return envelope(M.machine_recipe_control({
        surface = here(), force = force_of(), player_index = player_index,
      }))
    end,
    -- 撤回上一次按到地面的虚影。`into = "ground"` 那一按唯一记录的退路就是它，所以它跟着压线一起留。
    undo = function(count) return envelope(M.place_undo({ count = count })) end,
  }
end
-- `gui_model` over RCON -- and they must not differ, or the panel a player sees and the panel a suite
-- asserts on are two different windows.
-- The helmod picker's rows, as the window needs them. Its own function because the self-test builds a
-- model too, and a picker that exists only on the click path is a widget no headless run can see --
-- which is how "the row is empty and nobody says why" would have shipped.
local function helmod_picker()
  local f = M.helmod_factories({})
  if f.fail then return { error = f.code, msg = f.msg, msg_key = f.msg_key } end
  -- 门答"helmod 在、也读到了"，但一页工厂都没有 —— 这是第三种情况，既不是"没装"也不是"没算过"，
  -- 而是他算的那份里没有可铺的页。窗口从前在这一格什么都不摆（下拉要 `#items > 1`，那句解释只在
  -- `hm.error` 时才出现），于是玩家看到的是一行没有列表、也没有原因的空白，只能反复按。
  local list = (f.factories and #f.factories > 0) and f.factories or nil
  if not list then
    return { factories = {}, count = 0, error = "HELMOD_NO_PAGE",
      msg_key = "helmod-no-page",
      msg = "helmod answers, but there is no factory page in it yet: compute one in helmod, then press 刷新 here" }
  end
  return { factories = list, count = f.count }
end

-- 面板上"带子"那一格的候选：这一发放得下的那些档，从慢到快（和"够用就好"的试法同一个顺序，所以玩家
-- 看得见自己在默认之上往上点了多少）。列空着就摆"只有自动那一行"，不摆一个点了会拒的下拉。
local function belt_tiers_for_panel(player)
  local force = (player and player.valid and player.force) or game.forces.player
  if not force then return {} end
  local check = availability_checker(world_db(), force)
  local rows = roles.ladder("belt", { available = check, order = "asc" }) or {}
  local out = {}
  for _, e in ipairs(rows) do
    if e.name and e.unlocked ~= false then out[#out + 1] = e.name end
  end
  return out
end
panel_model = function(player)
  -- 面板每次重建都从存档里那份 per-player 状态起步：窗口不记自己的意见，它记玩家上一次留下的选择。
  local last = (player and (storage.gui_panel or {})[player.index]) or {}
  local m = gui.model(MOD_VERSION, last)
  -- 形状清单读自注册表本身（`styles.ids()`）：在 styles.lua 里加一档形状，这一格就多了这一档，
  -- 不必再回来改这份文件 —— 那正是形状注册表存在而不是再来一张数字表的原因。
  m.styles = styles.ids()
  -- 带子那一格同理，读自零件阶梯：列的是"这一发放得下的那些档，从慢到快"，所以列表里有一档，玩家就
  -- 真能点出一档。默认那一行是"不表态"，交给 `card_example` 按"够用就好"挑（见那里的 belt_choice）。
  m.belts = belt_tiers_for_panel(player)
  -- helmod 有哪几页，每次重建都重读一遍：玩家五秒前做完的工厂要在列表里，删掉的要不在。
  m.helmod = helmod_picker()
  return m
end

function M.card_check(args)
  args = args or {}
  local input = args.card
  if not input then return fail_key("BAD_ARGS", "m-card-required", nil, "card is required") end
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

function M.card_verify(args)
  args = args or {}
  if not args.card then return fail_key("BAD_ARGS", "m-card-required", nil, "card is required") end
  local normalized = card.normalize(args.card)
  if #normalized.entities == 0 then return fail_key("EMPTY_CARD", "m-no-entities", nil, "no entities") end

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
        return fail_key("SANDBOX_GENERATING", "m-surface-generating", nil, "the verification surface is still generating chunks; call again in a second")
      end
      return fail("NO_SANDBOX", tostring(why))
    end
    site_limit = pad
  end
  if not surface then return fail("NO_SURFACE", tostring(args.surface or "sandbox")) end

  local origin, rejected = find_card_site(surface, normalized, force_name, args.origin, site_limit)
  if not origin then
    return fail_key("NO_CLEAR_SITE", "m-no-site-origin", nil, "no candidate site fits this card; pass an explicit origin", rejected)
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
  -- A drop-down's two facts -- how many rows it shows and which row is lit -- are what the form reader
  -- indexes into, so a stand-in that forgot them let a panel whose labels and values disagree pass.
  e.items = spec.items
  e.selected_index = spec.selected_index or 1
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
  -- 图标与样式：右上角那颗按钮的断言读的就是"它画的是不是 data 阶段注册的那一张"，替身丢了这两个字段，
  -- 那条断言就只能证明"有个东西被建出来了"，而一个错图标的按钮看起来完全正常。
  e.sprite = spec.sprite
  e.style = spec.style
  -- ...and the tooltip, for the same reason: a sentence the player can only reach by hovering is
  -- still a sentence the panel says, and a stand-in that drops it lets a row whose hover text was
  -- never built pass every check that reads captions.
  e.tooltip = spec.tooltip
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
-- 面板的自测：无头服务器造不出玩家，所以拿一份记录用的替身跑真正的建窗代码，再把建出来的树交出去。
-- 它抓的是"nil 索引、参数形状错、表行数错、按钮派发不通"这一类；引擎会不会拒绝某个 widget 规格，由
-- dev/gui_api_check.js 对着装好的 runtime-api.json 另外查。
--
-- 留下的主张有两条，各用一种答法：
--   1) **派发通**：按钮按下去要走到 api 的那个动词。用真 api 按一次 —— 被拒也算走到（回来的信封里
--      有 code 就是走到了），headless 没有玩家站在地上、helmod 那一页也没真算完，能证明的就把这层证明干净。
--   2) **话渲染得出来**：窗口里那些句子（件数、形状、缺料、被替换的机器、小数台数、整计划里拒掉的那一页）
--      要有东西可渲染。这一步不能用真答案：真按压根不会产出那些行，而"某一行不再被写出来"和"这一按本来
--      就没内容"在窗口里长得一模一样。所以数据形状照 `M.helmod_ghosts` / `M.helmod_blueprints` /
--      `M.place_undo` 的真实答案抄，只喂给 `G.report_lines`。
function M.gui_selftest(args)
  args = args or {}
  local screen = mock_element(nil, { type = "screen" })
  local printed = {}
  local player = {
    index = 1, name = "tester", valid = true,
    -- `top` 是给 mod_gui 的那颗按钮的：`get_button_flow(player)` 读的就是这一格。没有它，自测里那颗
    -- 按钮永远"建不出来"，而它是玩家在游戏里第一眼看到的入口 —— 一个没有头less run 看得见的部件，
    -- 就是会坏在没人注意的那一个。
    gui = { screen = screen, top = mock_element(nil, { type = "frame", name = "top" }) },
    -- gui.lua 用点号调 (`player.print(msg)`)，所以替身不能把自己当成 self
    print = function(msg) printed[#printed + 1] = tostring(msg) end,
  }
  local model = panel_model(player)
  local opened = gui.open(player, model)
  local root = screen[gui.ROOT]
  local function find(name) return root and gui.find(root, name) or nil end

  -- 每个有名字的部件都要在树里：读表单的代码是按名字找元素的，名字不在就是一串 nil，
  -- 而玩家看到的窗口照样"正常" —— 这类错只有把树翻一遍才看得见。
  local wanted = { "arch-form-row", "arch-form-style", "arch-form-heads", "arch-form-belt",
    "arch-helmod-row", "arch-helmod", "arch-helmod-all", "arch-undo", "arch-string-row",
    "arch-auto-refresh", gui.REPORT }
  local missing = {}
  for _, n in ipairs(wanted) do if not find(n) then missing[#missing + 1] = n end end
  -- 右上角那颗按钮在 mod_gui 的流里，不在这个窗口下，所以它单独数一次。
  local toolbar, toolbar_why = gui.toolbar_button(player, true)
  local flow = player.gui.top.mod_gui_top_frame
  local toolbar_button = flow and flow.mod_gui_inner_frame
    and flow.mod_gui_inner_frame["arch-toolbar"] or nil

  local clicks, unhandled = {}, {}
  -- 一）真 api 走一遍。Close 不在这一列里：它会把 frame 拆掉，后面的按就都不是玩家会看到的那个窗口了。
  local real = gui_api(1, player)
  -- 这一列跟着 `gui.COMMAND_BUTTONS` 走（`arch-modules` 与 `arch-listen` 从前不在这里 —— 那颗
  -- 「把模块装上」上线时就没让自测按过一次，所以窗口那一行有没有拼错、api 那一只手有没有接上，
  -- 全靠点名跑套件的人偶然发现）。
  for _, name in ipairs({ "arch-helmod", "arch-helmod-all", "arch-modules", "arch-listen",
    "arch-undo", "arch-refresh" }) do
    local ok, verb, res = pcall(gui.on_click, player, name, model, real)
    clicks[#clicks + 1] = name .. " -> " .. (not ok and ("ERROR " .. tostring(verb))
      or (verb == nil and "unhandled" or tostring(verb)))
    if ok and verb == nil then unhandled[#unhandled + 1] = name end
    -- 拆窗那一下单独验：按下去要真的把 frame 从树上拿走，而不是留一个看不见的窗口占着名字。
    if name == "arch-refresh" then
      local ok2, verb2 = pcall(gui.on_click, player, "arch-close", model, real)
      clicks[#clicks + 1] = "arch-close -> " .. tostring(verb2)
      if ok2 and verb2 == nil then unhandled[#unhandled + 1] = "arch-close" end
    end
  end

  -- 二）把话渲染出来，喂的是形状抄自真实答案的替身。
  local shaped = {
    helmod = { ok = true, data = {
      source = "helmod", surface = "nauvis", origin = { x = 3, y = -2 }, width = 40, gap = 1,
      rounded = "up", kinds = 2, into = "hand", held = 62, landed_via = "cursor",
      entities = 62, undo_depth = 4, deployment = 9, fed = true,
      lanes = { { recipe = "iron-plate", machine = "electric-furnace", asked_machine = "steel-furnace",
        swapped = "steel-furnace", shape = "row-belts", fed_item = "iron-ore", needs = 1,
        -- 换了机器 → 分子退回自算，两个数都要在（helmod 那份原数 + 按地上这台算的那份）。
        rate_source = { source = "self", reason = "machine_swapped", crafts_per_min = 375,
          helmod_aside = { helmod_machine = "steel-furnace", laid_machine = "electric-furnace",
            crafts_per_min = 450 } },
        -- 两个口径并列的那一行：helmod 的式子说这条线的产物要 1.1 条带 → 向上贴半条是 1.5 条（3 股），
        -- 而这个形状在这一条上实际铺了 2 行成品带。
        belt_need_helmod = { belt = "fast-transport-belt", bonus = 1, per_min = 2400,
          product_raw = 1.1, product_belts = 1.5, feed_raw = 0.6, feed_belts = 1,
          products = { { item = "iron-plate", raw = 1.1, belts = 1.5, lanes = 3 } },
          feed = { { item = "iron-ore", raw = 0.6, belts = 1, lanes = 2 } } },
        product_rows = 2, feed_rows = 1, belt_chosen_by = "caller",
        asked = 2.5, machines = 3, entities = 42,
        parts = { ["electric-furnace"] = 3, ["fast-transport-belt"] = 21,
          ["long-handed-inserter"] = 9, ["steel-chest"] = 9 },
        at = { x = 3, y = -2 }, width = 46, height = 7 },
        -- 一条形状带不齐的线：`unfed` 那一行是唯一告诉玩家"这一排缺一种料"的地方。
        { recipe = "battery", machine = "assembling-machine-3", shape = "row-chest",
          fed_item = "iron-plate", needs = 2, unfed = { { name = "copper-plate", amount = 1 } },
          asked = 24, machines = 24, entities = 8,
          parts = { ["assembling-machine-3"] = 24 }, at = { x = 3, y = 6 }, width = 30, height = 3 },
        -- 一条线上两种料，被拆成两条线中的第一条：三个数（要几台 / 每台几条 / 这是第几条）都要在。
        { recipe = "electronic-circuit", machine = "assembling-machine-3", shape = "row-belts",
          fed_item = "iron-plate", fed_items = { "copper-cable", "iron-plate" }, needs = 2,
          asked = 16, machines = 8, split = { lines = 2, of = 1, per_line = 8 }, entities = 26,
          parts = { ["assembling-machine-3"] = 4, ["fast-transport-belt"] = 18,
            ["inserter"] = 8, ["steel-chest"] = 3 },
          at = { x = 3, y = 10 }, width = 18, height = 15,
          -- 这条线的流量是装着模块算的，而模块铺不下去：这一行是答案里唯一说这句话的地方。
          modules = { { item = "speed-module-2", count = 32 } },
          modules_said = "speed-module-2 ×32",
          -- 同一行话的另一形：这一档是我们按"装得下的最慢一档"挑的，不是同步 helmod 的偏好。
          belt_need_helmod = { belt = "transport-belt", bonus = 0, per_min = 900,
            product_raw = 0.9, product_belts = 1, feed_raw = 0.5, feed_belts = 1,
            products = { { item = "electronic-circuit", raw = 0.9, belts = 1, lanes = 2 } },
            feed = {} },
          product_rows = 1, belt_chosen_by = "adequate" } },
      lane_fallback = { { recipe = "plastics", machine = "assembling-machine-1", asked = 4,
        why = "BUS_MACHINE_NOT_SETTABLE" } },
      items = { { name = "assembling-machine-3", wanted = 24, placed = 24 },
        { name = "electric-furnace", wanted = 2.5, placed = 3 } },
      skipped = { { name = "speed-module", wanted = 96, why = "this save has no entity called it" } },
      -- 整页欠的模块（`summary_global.modules` 那份）：数、话、铺了几个。虚影装不了模块（实测），
      -- 所以 `modules_laid` 恒 0，而这一页的台数与每分钟件数却是按装着它们算的。
      modules = { { item = "speed-module-2", count = 96 } }, modules_count = 96,
      modules_said = "speed-module-2 ×96", modules_laid = 0,
      note = "no card, no lint, no measurement" } },
    helmod_all = { ok = true, data = { count = 2, into = "pack",
      blueprints = {
        { factory = "model_2", name = "iron-plate", entities = 675, lines = 2, via = "pack",
          parts = { ["steel-furnace"] = 48 },
          modules = { { item = "speed-module-2", count = 40 } }, modules_count = 40,
          modules_said = "speed-module-2 ×40", modules_laid = 0,
          skipped = { { name = "speed-module", wanted = 40, why = "its footprint cannot be read" } },
          unfed = { { name = "copper-cable", amount = 3, recipe = "electronic-circuit" } } },
        { factory = "model_3", name = "electronic-circuit", entities = 210, lines = 1, via = "pack" } },
      refused = { { factory = "model_4", name = "science", code = "NOTHING_TO_LAY" } } } },
    undo = { ok = true, data = {
      undone = 1, removed = 2, already_gone = 1, standing_now = 1, remaining = 1,
      standing = { { at = { x = 1, y = 2 }, was = "assembling-machine-1",
        now = "assembling-machine-3", unit = 4242 } } } },
    -- 「让这批机器听线」那份替身：开了 / 本来就开着 / 没写成 三种数各一条，再加上这片地里**没有这一格**
    -- 的件与还虚影着的台数 —— 窗口那一行少写一个参数，自测就该在这里红。
    listen = { ok = true, data = {
      surface = "nauvis", force = "player", area = { x1 = 0, y1 = 0, x2 = 20, y2 = 20 },
      area_from = "last_helmod_area", want = "on", machines = 4, set = 1, already = 1, failed = 1,
      ghosts = 2, not_settable = { { name = "stone-furnace", count = 1 } },
      by_machine = {
        { name = "assembling-machine-1", at = { 1.5, 1.5 }, unit_number = 41, was = true,
          already = true },
        { name = "assembling-machine-1", at = { 5.5, 1.5 }, unit_number = 42, was = false,
          changed = true },
        { name = "assembling-machine-3", at = { 9.5, 1.5 }, unit_number = 43, why = "read back nil" },
      },
      note = "each built machine here now reads its recipe from the wire",
    } },
  }
  local report_after = {}
  for _, verb in ipairs({ "helmod", "helmod_all", "listen", "undo" }) do
    local out = gui.report_lines(verb, "", shaped[verb])
    report_after["arch-" .. verb:gsub("_", "-")] = {
      title = gui.flat((out or {}).title), lines = gui.flat_lines((out or {}).lines or {}) }
  end

  -- 窗口重新建一次再数树：上面那一按里有 Close，它把 frame 从树上拆掉了，而这一份文本是给"没计划的
  -- helmod 要在选择器该在的位置说出原因，而不是摆一个只有一行空选项的下拉"这类断言读的。
  gui.open(player, model)
  local lines_of = {}
  local function walk(e, depth)
    if not e then return end
    lines_of[#lines_of + 1] = string.rep("  ", depth) .. tostring(e.type) .. " " .. tostring(e.name or "")
      .. " " .. tostring(e.caption or e.text or "")
    for _, c in ipairs(e.children or {}) do walk(c, depth + 1) end
  end
  walk(screen[gui.ROOT], 0)

  -- 快捷键那一按走的就是 "arch-toolbar" 这一格，所以它必须真的把窗口关掉（再按一次开回来）：三个把手
  -- 若各开各的窗，玩家看到的就是三个不同的 mod。
  local ok_toggle, verb_toggle = pcall(gui.on_click, player, "arch-toolbar", model, real)
  local closed_by_toolbar = screen[gui.ROOT] == nil
  -- 自动刷新做两件事，都得量：窗口不在就什么都不做；窗口在的时候只重画 helmod 那一行 —— 玩家刚读到的
  -- 那段答案被一次刷新擦掉，是这一格最不该有的行为。
  local refresh_no_window = gui.refresh_world(player, model)
  gui.open(player, model)
  gui.show_report(player, "kept", { "这一行是上一次按下的结果" })
  local before = find(gui.REPORT) and #(find(gui.REPORT).children or {}) or 0
  -- 刷新这一格量三件事。一）**列表没变的时候那一行一个部件都不许碰** —— 下拉是一列展开的选项，
  -- 重建它等于把玩家正开着的那一列关掉（玩家量出来的原话是"选择配方列表一直关闭、没有办法选择"），
  -- 所以这里比的是部件的引用：同一个对象还在，才是真的没动。二)列表真多了一页时要重画。
  -- 三)重画不能擦掉下面那段答案。
  -- `find` 走的是自测开头那份 `root`，而 `gui.open` 把那一扇窗拆了重建过 —— 拿旧引用查会得到一棵
  -- 已经destroyed的树，于是"那一格有没有摆出原因"永远读成"没有"。下面这几件新事实都重新落地取一次。
  local function live(name)
    local r = screen[gui.ROOT]
    return r and gui.find(r, name) or nil
  end
  local helmod_row_el = live("arch-helmod-row")
  local shown_before = helmod_row_el and helmod_row_el.children and helmod_row_el.children[2] or nil
  local refresh_open = gui.refresh_world(player, model)
  local after = find(gui.REPORT) and #(find(gui.REPORT).children or {}) or 0
  local row_untouched = refresh_open == "same" and shown_before ~= nil
    and helmod_row_el.children[2] == shown_before
  -- 一页都没有的时候那一格不能是空白：它得说清是哪一种"没有"（没装 / 装了没算 / 算了但这页没有
  -- 可铺的东西）。这一格要在**塞进那一页之前**读，不然读到的已经是下拉了。
  local none_label = live("arch-helmod-none")
  -- 那句原因是本地化串表（`{ "", { "architect.helmod-none" }, ... }`），不是英文句子 —— 展平之后
  -- 还非空，才算"那一格确实有话"。
  local said_why = none_label ~= nil
    and #(tostring(gui.flat(none_label.caption) or "") or "") > 0
  -- 替身是普通 Lua 表，所以这里能塞一页进去当"helmod 刚算完新的一页"。
  local model_with_page = { title = model.title, version = model.version, hint = model.hint,
    goal = {}, styles = model.styles, belts = model.belts,
    helmod = { factories = { { id = "model_selftest", name = "铁板线", machines = 12,
      kinds = 1, recipes = 1 } }, count = 1 } }
  local grew = gui.refresh_world(player, model_with_page)
  local dd = live("arch-form-helmod")
  local dd_rows = dd and dd.items and #dd.items or -1
  local same_after_grow = gui.refresh_world(player, model_with_page)
  -- 下拉那一行背后是哪个 id：第 1 行必须是"整页"（空串），第 2 行必须是那一页自己的 id。
  -- 按下"压线"读的是这份对应关系，两处一旦各记一套，玩家选中的那一行会发出一个已经不存在的词。
  local sel_row2 = tostring((gui.on_selection(player, "arch-form-helmod", 2, model_with_page)))
    .. "=" .. tostring((select(2, gui.on_selection(player, "arch-form-helmod", 2, model_with_page))))
  local sel_row1 = tostring((select(2, gui.on_selection(player, "arch-form-helmod", 1, model_with_page))))
  local sel_other_widget = tostring(gui.on_selection(player, "arch-form-style", 2, model_with_page))
  -- 复选框那一格：它说的必须是"这一格现在亮着"，而且只对它自己说话。
  local verb_check, value_check = gui.on_checked(player, "arch-auto-refresh", true)
  local verb_other = gui.on_checked(player, "arch-form-style", true)
  -- 下拉的"有几行"和"每行按下发出什么"是分两处写的东西，而两处不一致时窗口看上去完全正常：玩家选到的
  -- 那一行发出的是一个已经不存在的词，进门就吃一张拒。这里当场比一次行数。
  local heads_dd = find("arch-form-heads")
  local style_dd = find("arch-form-style")
  local heads_rows = heads_dd and heads_dd.items and #heads_dd.items or -1
  local heads_values = gui.head_values and #gui.head_values or -1
  -- 每一行的值都必须是模认得的词（"" 表示不表态）：多出来的一项会指到删掉的形状上去。
  local heads_known = true
  for _, v in ipairs(gui.head_values or {}) do
    if v ~= "" and v ~= "belt" then heads_known = false end
  end

  return {
    ok = opened ~= nil and root ~= nil and #missing == 0 and #unhandled == 0
      and toolbar and toolbar_button ~= nil
      and toolbar_button.sprite == "architect-toolbar"
      and ok_toggle and verb_toggle == "toolbar" and closed_by_toolbar
      and refresh_no_window == false and (refresh_open == "same" or refresh_open == true)
      and before > 0 and after == before
      and verb_check == "auto_refresh" and value_check == true and verb_other == nil
      and heads_rows == heads_values and heads_rows == 2 and heads_known
      and style_dd ~= nil and style_dd.items ~= nil
      and #style_dd.items == #(model.styles or {}) + 1,
    opened = opened ~= nil,
    widgets_missing = #missing > 0 and missing or nil,
    clicks = clicks, unhandled = unhandled, report_after = report_after,
    styles_on_panel = model.styles and #model.styles or 0,
    dropdowns = { heads_rows = heads_rows, heads_values = heads_values,
      known = heads_known, style_rows = style_dd and style_dd.items and #style_dd.items or -1 },
    helmod_rows = model.helmod and model.helmod.factories and #model.helmod.factories or 0,
    helmod_error = model.helmod and model.helmod.error or nil,
    printed = #printed > 0 and printed or nil,
    -- 这三样各钉一个入口：右上角那颗按钮在不在、快捷键关没关窗、自动刷新有没有把答案擦掉。它们进 `ok`
    -- 也单独交出去，因为红的时候要说得出是哪一件没做到。
    toolbar = { built = toolbar and true or false, named = toolbar_button ~= nil,
      why = not toolbar and toolbar_why or nil,
      sprite = toolbar_button and toolbar_button.sprite or nil },
    shortcut_toggle = { verb = tostring(verb_toggle), closed = closed_by_toolbar },
    auto_refresh = { no_window = tostring(refresh_no_window), open = tostring(refresh_open),
      report_before = before, report_after_refresh = after,
      -- 三件新事实：没变就不碰那个部件、变了会重画、重画之后列表确实有两行；再加上"没有计划时
      -- 那一格说得出原因"。第一条是今晚那条玩家反馈的直接凭据。
      row_untouched = tostring(row_untouched), redraw_when_list_changes = tostring(grew),
      same_when_unchanged = tostring(same_after_grow), dropdown_rows = dd_rows,
      said_why_no_page = tostring(said_why),
      page_by_row = sel_row2, row_one_is_all = sel_row1, sel_other = sel_other_widget,
      checked = tostring(verb_check) .. "=" .. tostring(value_check) },
    -- 整棵树压成一个字符串交出去：断言读的是"这个元素名在不在窗口里"，而不是行号。
    tree = table.concat(lines_of, "\n"),
  }
end

script.on_event(defines.events.on_gui_click, function(event)
  local player = game.get_player(event.player_index)
  if not player then return end
  local element = event.element
  if not element then return end
  local name = field(element, "name")
  if type(name) ~= "string" or name:sub(1, 5) ~= "arch-" then return end
  pcall(function()
    gui.on_click(player, name, panel_model(player), gui_api(player.index, player))
  end)
end)


script.on_event(defines.events.on_player_left_game, function(event)
  local player = game.get_player(event.player_index)
  if player then pcall(function() gui.close(player) end) end
end)

-- 三颗把手开的是同一扇窗：聊天里的 `/arch`、右下角工具栏那颗快捷键、右上角 mod_gui 那颗按钮。它们都
-- 走到 `gui.on_click` 的同一格里，所以"哪里按的"不会改变"开出什么样的窗口"—— 那正是分叉开始咬人的地方。
--
-- `action = "lua"` 的 shortcut 自己不界面：它只把这个事件交回来，开还是关由 `G.toggle` 说。
script.on_event(defines.events.on_lua_shortcut, function(event)
  if event.prototype_name ~= "architect-open" then return end
  local player = game.get_player(event.player_index)
  if not player then return end
  pcall(function()
    gui.on_click(player, "arch-toolbar", panel_model(player), gui_api(player.index, player))
  end)
end)

-- 右上角那颗按钮要等玩家的 GUI 存在才建得出来，所以它跟着"进服"走，而不是 `on_init`（那一刻还没有人
-- 连着）。已经站在游戏里的玩家不会再过一遍进服事件，所以加装 mod 的那一刻由 bootstrap 补同一件事。
script.on_event(defines.events.on_player_joined_game, function(event)
  local player = game.get_player(event.player_index)
  if player then pcall(gui.toolbar_button, player, true) end
end)

-- 复选框不是一按就做事的按钮：它改的是"这个窗口开着的时候要不要每隔一秒重读一次 helmod"，所以它的状态
-- 留在存档里，窗口下次开起来还是玩家上次要的样子。刷新失败就自己关掉这一格并写一行日志 —— 一个会反复
-- 报错的计时器比一格没开成的自动刷新糟得多。
script.on_event(defines.events.on_gui_checked_state_changed, function(event)
  local player = game.get_player(event.player_index)
  local element = event.element
  if not player or not element then return end
  local name = field(element, "name")
  if type(name) ~= "string" then return end
  local verb, value = gui.on_checked(player, name, element.state)
  if verb ~= "auto_refresh" then return end
  storage = storage or {}
  storage.gui_panel = storage.gui_panel or {}
  local st = storage.gui_panel[player.index] or {}
  st.auto_refresh = value or nil
  storage.gui_panel[player.index] = st
end)

-- 下拉换了选中行：把那一行背后的页 id 记进这份状态（为什么在改的那一刻记、不等按下才读行号，
-- 理由写在 gui.lua 的 `on_selection` 那一段：列表是 helmod 现场算的，行号会自己挪）。
script.on_event(defines.events.on_gui_selection_state_changed, function(e)
  local element = e.element
  local name = element and element.name
  if not name then return end
  local player = game.get_player(e.player_index)
  if not (player and player.valid) then return end
  local verb, page = gui.on_selection(player, name, e.selected_index, panel_model(player))
  if verb ~= "helmod_page" then return end
  storage = storage or {}
  storage.gui_panel = storage.gui_panel or {}
  local st = storage.gui_panel[player.index] or {}
  st.goal = st.goal or {}
  -- 第 1 行是"全部一起"，那份状态里就不留 id：留着上一次的页，等于窗口显示"整页"而压出去一页。
  st.goal.helmod_factory = (page ~= nil and page ~= "") and page or nil
  storage.gui_panel[player.index] = st
end)

-- 自动刷新那一格真正跑的地方。60 tick 一次（一秒），而且只给"窗口开着并且这一格是亮的"那些玩家重画 ——
-- 重读 helmod 的那份工厂表是一次 `remote.call`，代价随他算了多少页走，不该由一个没人看的窗口付。
-- 它也不重建窗口：见 `gui.refresh_world`，玩家刚读到的那段答案不该被一次刷新擦掉。
--
-- 还有第三条，是玩家直接用手指头量出来的：**列表没变就不许碰那一格下拉**。下拉是一列展开的选项，
-- 重建它等于把它连根拔掉 —— 无条件一秒一次的话，他每次展开列表都会被关掉，而那一按还没落下，
-- 于是"选择配方列表一直关闭、没有办法选择"。签名存在这份 per-player 状态里：开窗口与手动刷新都会
-- 重画整扇窗，所以那两处也各写一次（否则打开后第一 tick 就白拆一次）。
script.on_nth_tick(60, function()
  local panels = storage and storage.gui_panel
  if not panels then return end
  for index, st in pairs(panels) do
    if st.auto_refresh then
      local player = game.get_player(index)
      local screen = player and player.valid and player.connected and player.gui
        and player.gui.screen
      if not (screen and screen[gui.ROOT]) then
        -- 窗口关了，这一格就不用再管：下次开窗口时玩家自己再点一次。
        st.auto_refresh = nil
      else
        -- `refresh_world` 自己会先去问那格下拉"你现在显示的是哪几行"，列表没变就一个部件都不碰
        -- （见 gui.lua 那一段：重建下拉等于把玩家正展开的那一列关掉）。
        local ok, drew = pcall(function() return gui.refresh_world(player, panel_model(player)) end)
        if not ok then
          log("architect: auto refresh stopped for player " .. tostring(index) .. ": " .. tostring(drew))
          st.auto_refresh = nil
        end
      end
    end
  end
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
      lines[#lines + 1] = "  rigs: drill=" .. tostring(b.drill_job == true)
        .. " pump=" .. tostring(b.pump_job == true) .. " farm=" .. tostring(b.farm_job == true)
        .. " arms=" .. tostring(b.arm_job == true)
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
-- Anything computed from prototypes has to be thrown away when the mod set changes, and the measured
-- facts are exactly that: an inserter's reach, an entity's facing behaviour and a pole's wire distance. `verify`'s probe cache lives in that module and
-- clears itself through the exported function below.
local function bootstrap(event)
  -- These three are read-only derivations of prototypes: a cold copy costs a few table walks, never a
  -- write to the world, so a per-process cache is only a speed thing here.
  model_cache, db_cache, supply_cache = nil, nil, nil
  -- Nothing in `storage` may be created or edited here: the engine compares the CRC of `storage`
  -- across `on_load` and calls a change "not save/load stable and not multiplayer safe". The lab's
  -- handles ride in the job record for exactly that reason -- and the measured facts (`proto_facts`)
  -- live in `storage` for the opposite reason: a process-local copy of THOSE is what desyncs a client
  -- that joined after the server warmed its own.
  --
  -- `mod_changes` is present on `on_configuration_changed` and on nothing else, which makes it the one
  -- safe moment to throw the measured numbers away: a mod set cannot change under a connected client,
  -- so every process agrees that the old numbers are from a game that no longer exists.
  -- The two moments when a measurement is free: `on_init` (a brand-new save, nobody is connected yet)
  -- and `on_configuration_changed` (a mod set cannot change under a connected client, so every process
  -- reconnects and downloads whatever was written here). Warming an arm's reach costs one entity put
  -- down and taken up again, so it is worth doing exactly when no second process can disagree about it.
  if event and event.mod_changes then storage.proto_facts = {} end
  if event and (event.mod_changes or event.name == defines.events.on_init) then
    local took = warm_reach()
    log("architect: warmed the arms' reach, measuring " .. took
      .. " of them off the world just now -- safe HERE, where no second process exists yet, and the"
      .. " exact thing that desyncs a client that joins a server whose own copy was already warm")
  end
  register_commands()
  -- 中途加装这个 mod 的存档里，玩家已经站在游戏中了，不会再过一遍 `on_player_joined_game`：那颗按钮
  -- 就在这里补。
  --
  -- `game` 在 `on_load` 那一刻还不存在（量过：读它就是 "attempt to index global 'game' (a nil value)"，
  -- 而它把整张图加载带倒），所以这一步只在它存在的那两个时刻走。玩家进服那一按是第三扇门，它一定会来。
  if game then
    for _, p in pairs(game.players or {}) do pcall(gui.toolbar_button, p, true) end
  end
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
      return encode(refusal_of(res))
    end
    return encode({ ok = true, method = method, data = res, cost_ticks = game.tick - t0 })
  end,
  invalidate = function() model_cache = nil db_cache = nil supply_cache = nil return true end,
})
