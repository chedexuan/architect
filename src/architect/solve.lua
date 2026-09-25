local rat = require("rat")
local roles = require("roles")

-- Turns "I want X items/min" into exact integer machine counts.
--
-- Every machine count is a rational multiple of the line's output rate R:
--   machines_i = c_i * R,   c_i = n_i / d_i   (reduced)
-- R = X/Y (reduced) makes every count integral exactly when  d_i | X  and  Y | n_i,
-- so the smallest such R is
--   R_min = lcm(all d_i) / gcd(all n_i)
-- R_min *is* an indivisible production unit. Anything smaller can only be reached
-- by starving a stage or by borrowing an intermediate from somewhere else, which
-- is a decision for the designer, not arithmetic.

local S = {}

local function product_amount(recipe, item)
  for _, p in ipairs(recipe.products) do
    if p.name == item then return p.amount end
  end
  return nil
end

-- The same, on the other side of the arrow. A recipe can name one item twice, so this adds rather
-- than returns: `uranium-fuel-reprocessing` is not exotic, it is just what the data sometimes says.
local function ingredient_amount(recipe, item)
  local total = rat.new(0)
  for _, i in ipairs(recipe.ingredients or {}) do
    if i.name == item then total = rat.add(total, i.amount) end
  end
  return total
end

local function per_machine_per_sec(recipe, item, machine)
  local y = product_amount(recipe, item)
  if not y then return nil end
  local speed = machine.speed or machine.mining_speed
  if not speed or speed == 0 then return nil end
  return rat.mul(rat.div(y, recipe.energy), rat.from(speed))
end

local function note_prereq(state, techs, recipe, item)
  for _, t in ipairs(techs or {}) do
    if not state.seen[t] then
      state.seen[t] = true
      state.prerequisites[#state.prerequisites + 1] = { technology = t, unlocks = recipe, for_item = item }
    end
  end
end

local function nearer_unlock(a, b)
  -- When nothing is buildable, the useful answer is the cheapest way in, not the
  -- best machine you cannot have yet. Tech count first; on a tie the lower tier
  -- is the nearer one (a real research-cost sum would beat this proxy).
  local ta, tb = #(a.techs or {}), #(b.techs or {})
  if ta ~= tb then return ta < tb end
  return (a.speed or a.mining_speed or 0) < (b.speed or b.mining_speed or 0)
end

-- Modules, as the game applies them: every bonus is ADDITIVE within its own kind and the kinds
-- MULTIPLY. Neither shape can be inferred from the tooltip, which lists the bonuses flat.
--
-- Two limits the caller cannot see from the counts alone are applied here: a machine only has
-- so many slots, and a recipe caps how far productivity can go. Both change the answer, so a
-- plan that assumed 4 productivity modules in a 2-slot furnace would have promised a rate the
-- hardware cannot reach.
function S.module_factors(db, request, machine, recipe)
  if not request or #request == 0 then return nil end
  local slots = machine and machine.module_slots or 0
  local speed, prod, cons, used, notes = 1, 0, 0, 0, {}
  for _, want in ipairs(request) do
    local def = db.modules and db.modules[want.item]
    if not def then
      notes[#notes + 1] = { item = want.item, note = "no such module in the world model" }
    else
      local take = math.min(want.count or 1, math.max(slots - used, 0))
      if take < (want.count or 1) then
        notes[#notes + 1] = { item = want.item, asked = want.count, fitted = take,
          note = "only " .. take .. " of " .. (want.count or 1) .. " fit in " .. tostring(machine and machine.name) .. "'s " .. slots .. " slots" }
      end
      used = used + take
      speed = speed + (def.speed or 0) * take
      prod = prod + (def.productivity or 0) * take
      cons = cons + (def.consumption or 0) * take
    end
  end
  local cap = recipe and recipe.max_productivity
  local capped = false
  if cap and prod > cap then prod, capped = cap, true end
  if recipe and recipe.allow_productivity == false then
    notes[#notes + 1] = { note = "recipe disallows productivity; the bonus was dropped" }
    prod = 0
  end
  return {
    speed = speed, productivity = 1 + prod, consumption = math.max(0, 1 + cons),
    rate = speed * (1 + prod), slots_used = used, capped_productivity = capped or nil,
    notes = #notes > 0 and notes or nil,
  }
end

local function pick_machine(state, recipe, overrides)
  local db = state.db
  local name = overrides and overrides[recipe.category]
  if name then
    local m = db.machines[name]
    if not m then return nil, "UNKNOWN_MACHINE", name end
    if m.available == false then
      note_prereq(state, m.techs, m.unlock_recipe, recipe.name)
      -- a machine the caller NAMED is an instruction about hardware, so the same bargain applies: with
      -- `allow_locked` the answer is the plan plus the technology, not a refusal
      if state.allow_locked then return m end
      return nil, "LOCKED_MACHINE", name
    end
    return m
  end
  local best, best_speed, best_locked
  local names = {}
  for k in pairs(db.machines) do names[#names + 1] = k end
  table.sort(names) -- deterministic: same input, same answer, always
  for _, k in ipairs(names) do
    local m = db.machines[k]
    local speed = m.speed or m.mining_speed
    if speed and speed > 0 then
      for _, c in ipairs(m.categories or {}) do
        if c == recipe.category then
          if m.available == false then
            if not best_locked or nearer_unlock(m, best_locked) then best_locked = m end
          elseif not best_speed or speed > best_speed then
            best, best_speed = m, speed
          end
        end
      end
    end
  end
  if not best then
    if best_locked then
      note_prereq(state, best_locked.techs, best_locked.unlock_recipe, recipe.name)
      -- `allow_locked` is the caller asking "what would this take, researched or not". Half an answer
      -- that stops at the machine while the recipe side was already let through is a plan about a
      -- research nobody asked about; the technology stays in `prerequisites`, which is where the
      -- question was actually answered.
      if state.allow_locked then return best_locked end
      return nil, "LOCKED_MACHINE", best_locked.name
    end
    return nil, "NO_MACHINE_FOR_CATEGORY", recipe.category
  end
  return best
end

-- Which miner to use, and how much it actually delivers. `mining_speed / ore mining_time` is a
-- nameplate: what a drill produces on this map is measured by `drill_rate` and arrives in
-- `state.measured`, keyed "machine|resource". A measured drill wins over an unmeasured one even
-- if it is the slower machine, because a number that was read beats a number that was inferred.
local function miners_for(db, item, measured)
  local raw = db.raw and db.raw[item]
  local cat = raw and raw.category
  -- `mining_time` is seconds per unit of this ore, so it divides what a drill delivers rather
  -- than multiplying it: the same machine reads a lower rate on a slower ore. A nameplate built
  -- from `mining_speed` alone promises a rate the ore never gives up.
  local ore_time = (raw and raw.mining_time and raw.mining_time > 0) and raw.mining_time or 1
  -- A broken "unit" of ore is not always one thing: crude oil gives ten units of fluid per unit
  -- mined. The nameplate has to be stated in whatever the plan counts in, or a fluid line is
  -- sized by a number that is wrong by that factor.
  local ore_units = (raw and raw.product and raw.product.units) or 1
  local function nameplate(m) return m.mining_speed * 60 / ore_time * ore_units end
  -- Which drills take this category is `roles`' predicate, not a second copy of it here: the copy
  -- matched an unreadable category against every drill, which is a plan built on a guess about ore
  -- the rig would have refused to place anything on.
  local takes = {}
  local drills, drills_err = roles.drills_for(cat)
  if not drills then
    return nil, (drills_err or {}).error == "NO_CATEGORY" and "NO_CATEGORY" or "NO_MINER"
  end
  for _, d in ipairs(drills) do takes[d.name] = d.speed end
  local list = {}
  for _, m in pairs(db.machines) do
    if m.kind == "mining-drill" and (m.mining_speed or 0) > 0 then
      local matches = takes[m.name] ~= nil
      -- a wrapper, not a field on `m`: db is cached across calls, and a measurement taken for
      -- one resource must not be readable as the measurement for the next one
      if matches then
        -- a drill records items and a pump records fluid units, and only a drill records an
        -- arrival period: whichever the rig happened to write, it is still "what one machine
        -- delivers per minute" -- in items, where one tile is one item, or in units of fluid
        local meas = measured and (measured[m.name .. "|" .. item]
          -- a vent is measured under the entity that stands on the ground, which is not always the
          -- name of the fluid that comes out of it
          or (raw and raw.entity and measured[m.name .. "|" .. raw.entity]))
        -- A rig that could not run measured a zero, and a zero is not a rate: it would divide
        -- the machine count by nothing. Such a record stays where it belongs, in the rig's own
        -- answer, and planning falls back on the nameplate with `estimated` set.
        if meas and (meas.error or (meas.steady_items_per_min or meas.items_per_min or meas.units_per_min or 0) <= 0) then
          meas = nil
        end
        local per_min = meas and (meas.steady_items_per_min or meas.items_per_min or meas.units_per_min)
        list[#list + 1] = { machine = m, per_min = per_min, measured = meas, nameplate = nameplate(m) }
      end
    end
  end
  table.sort(list, function(a, b)
    if (a.per_min ~= nil) ~= (b.per_min ~= nil) then return a.per_min ~= nil end
    return a.nameplate > b.nameplate
  end)
  return list
end

local function mining_node(state, item, coeff)
  local list = miners_for(state.db, item, state.measured)
  local chosen
  -- no `break`: every locked miner is noted whether or not an available one came first, so the
  -- "research this for a faster line" list does not depend on what happens to be measured
  for _, entry in ipairs(list) do
    if entry.machine.available ~= false then
      if not chosen then chosen = entry end
    else
      note_prereq(state, entry.machine.techs, entry.machine.unlock_recipe, item)
    end
  end
  -- the same bargain as `pick_machine`: a caller who asked what it would take, researched or not, gets
  -- the miner and the technology beside it rather than a refusal about a research
  if not chosen and state.allow_locked and #list > 0 then chosen = list[1] end
  if not chosen then
    if #list > 0 then return nil, "LOCKED_MACHINE", list[1].machine.name end
    return nil, "NO_MINER", item
  end
  -- the steady figure, not the window average: a window always loses whatever was mid-mining at
  -- the moment its clock ran out, so the average is short by up to one item at any length
  local per_min = chosen.per_min or chosen.nameplate
  -- Some ore is not mineable until a fluid is pumped into the drill, and that is a line item on
  -- the plan, not trivia: the machines exist and still produce nothing.
  local raw = state.db.raw and state.db.raw[item]
  local raw_product = raw and raw.product
  local supply = state.field_supply and state.field_supply[item]
  local field_report
  if supply then
    field_report = { tiles = supply.tiles, units = supply.units, infinite = supply.infinite,
      surface = supply.surface }
    -- How long the ground keeps paying is a question about the plan's demand, not about one
    -- machine: two pumps on one patch empty it in half the time. An infinite patch reports its
    -- size and no horizon, because a number there would be read as a limit the map does not have.
    -- `coeff` is a rational rate per SECOND, and it is the demand of one production unit: the plan
    -- may stack units, and every stack shortens the horizon by the same factor, which is why the
    -- field says "unit" rather than pretending to know how many the caller will build.
    local per_sec = (type(coeff) == "table" and coeff.n and coeff.d and coeff.n / coeff.d)
      or tonumber(coeff) or 0
    field_report.unit_demand_per_min = per_sec * 60
    -- what empties the ground is what the machines take out, which is not the same as what the
    -- line consumes: one pumpjack on a 600/min rate feeds a unit that wants 60/min, and the patch
    -- is spent at 600 whether the refinery keeps up or not
    local machines = math.max(1, math.ceil(per_sec / (per_min / 60)))
    field_report.extractors = machines
    field_report.unit_extraction_per_min = machines * per_min
    -- The ground is counted in units of ORE and the machines are rated in units of FLUID. One unit
    -- of crude ore is ten units of fluid (`raw.product.units`, read from this install), so dividing
    -- the patch by the fluid rate understates the horizon by exactly that factor -- and still looks
    -- like a number. The field keeps both figures so the division can be checked.
    local yield_per_ore = (raw_product and raw_product.units) or 1
    local ore_per_min = machines * per_min / yield_per_ore
    field_report.unit_extraction_ore_per_min = ore_per_min
    if not supply.infinite and machines > 0 and ore_per_min > 0 then
      field_report.minutes_at_extraction_rate = supply.units / ore_per_min
    end
  end
  state.nodes[#state.nodes + 1] = {
    kind = "mining", item = item, machine = chosen.machine.name,
    coeff = rat.div(coeff, rat.from(per_min / 60)),
    per_machine_per_min = per_min,
    estimate = not chosen.per_min,
    product_type = raw_product and raw_product.type,
    rate_window_seconds = chosen.measured and chosen.measured.elapsed_game_seconds,
    units_per_ore_unit = (raw_product and raw_product.units) or 1,
    field = field_report,
    required_fluid = raw and raw.required_fluid,
    fluid_amount = raw and raw.fluid_amount,
    ore_mining_time = raw and raw.mining_time,
    -- the rig is named by what the ore yields: a pump records fluid units and a drill records
    -- items, and a caller reading "drill_rate" on a crude-oil line would go looking for a machine
    -- that cannot mine it
    -- the window is part of the number, not metadata: a pump read over 30 seconds reports a rate
    -- it does not hold over 120, so a plan that quotes the figure without the window is quoting
    -- the shortest-sounding answer available
    rate_source = chosen.per_min
      and ("measured on this map by " .. ((raw_product and raw_product.type == "fluid")
        and "pump_rate" or "drill_rate")
        .. (chosen.measured and chosen.measured.elapsed_game_seconds
          and " over " .. chosen.measured.elapsed_game_seconds .. "s" or ""))
      or ("nameplate mining_speed / ore mining_time"
        .. ((raw_product and raw_product.units and raw_product.units ~= 1)
          and " x units_per_ore_unit" or "")
        .. " -- call " .. ((raw_product and raw_product.type == "fluid")
          and "pump_rate" or "drill_rate") .. " for this ore to measure it"),
  }
  return true
end

-- What a recipe actually takes, after what it gives back.
--
-- Net, per craft: `in - out` of the same item. A positive remainder is real demand --
-- `advanced-oxide-asteroid-crushing` takes a chunk and hands 0.05 of the same kind back, so 0.95 of a
-- chunk per craft is what the rest of the graph has to supply, not 1.00 and not nothing. Zero or less
-- means the recipe does not consume the item at all: it is a carrier, standing capital that has to be
-- in the loop for the loop to run. `in_flight` reports those instead of dropping them: "needs
-- one in circulation, consumes none" and "needs none" are sentences about two different factories.
--
-- Measured on this install: no recipe hands an ingredient back UNCHANGED (0 of 659 have in == out for
-- any item), so this branch has no live case here; the six recipes that do overlap one of their own
-- inputs all lean the other way, and kovarex is asserted as one of them in `dev/solve_e2e.js`. It
-- stays because a modded catalyst is
-- exactly this shape and one `rat.cmp` away, not because the vanilla data needs it.
--
-- `supplied` is the item this recipe was chosen to make. Its own overlap is not handled here: the
-- divisor in `walk` turns it into a net per-craft yield, which is the same arithmetic done once
-- instead of an iteration that has to converge to it. See `recirculated` on the node.
--
-- Every amount here is a rational, because that is what the recipe model stores. The first version of
-- this function called `tonumber(p.amount)` and got nil -- the model keeps `rat.from` results so that a
-- 0.007-probability uranium output stays a 7:993 split instead of rounding into a centrifuge count
-- 143x too small, and doing float arithmetic here would undo that on the way to fixing something else.
local function net_ingredients(recipe, supplied)
  local out_amount, taken, carriers = {}, {}, {}
  for _, p in ipairs(recipe.products or {}) do
    out_amount[p.name] = rat.add(out_amount[p.name] or rat.new(0), p.amount)
  end
  for _, ing in ipairs(recipe.ingredients or {}) do
    if ing.name ~= supplied then
      local give = out_amount[ing.name]
      if give then
        local net = rat.sub(ing.amount, give)
        if rat.cmp(net, rat.new(0)) > 0 then
          taken[#taken + 1] = { name = ing.name, amount = net, recycled = give }
        else
          -- nothing is consumed, so nothing enters `taken`; the standing amount goes to the carrier
          -- list instead -- one craft keeps this item in flight, capped by what goes in
          carriers[#carriers + 1] = { item = ing.name, amount = ing.amount, returned = give }
        end
      else
        taken[#taken + 1] = { name = ing.name, amount = ing.amount }
      end
    end
  end
  return taken, carriers
end

-- Can this recipe be a *source* of `item`? Products minus ingredients, per craft, in rationals.
--
-- The candidate lists for an item are built from its product lists, which says the recipe puts some
-- of it out and says nothing about what it takes in. `advanced-oxide-asteroid-crushing` appears as a
-- producer of `oxide-asteroid-chunk` while eating a whole chunk per craft and handing 0.05 back, so
-- treating it as the supplier of chunks makes the fixed point diverge: one chunk of demand becomes
-- twenty crafts, which is twenty chunks of demand, which is four hundred. That is the shape the
-- `CYCLIC_RECIPE` refusal was reporting -- "the loop grows" -- for a graph with no loop at all until
-- the solver picked the one recipe that could not close it.
local function net_yield(recipe, item)
  local out = product_amount(recipe, item) or rat.new(0)
  return rat.sub(out, ingredient_amount(recipe, item))
end

-- Does this item look raw only because some map somewhere has a hole in it that spits it out?
--
-- Twelve resource entities exist here and ten are named after what they give, so mining them is the
-- whole story and the walk stops there. Two are not: `fluorine-vent` yields `fluorine` and
-- `sulfuric-acid-geyser` yields `sulfuric-acid`, and both of those fluids also have a recipe chain. For
-- those two, calling it a raw leaf is a claim about the map under discussion rather than about the
-- recipe graph, so it is only made when the ground has been counted and the hole is in it. Not knowing
-- whether the map has one (`field_supply` absent, or a scan that found none) falls back on the recipe,
-- which is the answer that is true wherever the recipe's inputs can be had.
local function mined_only_from_a_hole(state, item)
  local raw = state.db.raw and state.db.raw[item]
  if not raw or not raw.entity or raw.entity == item then return false end
  if #(state.db.producers[item] or {}) == 0 then return false end
  local field = state.field_supply and state.field_supply[item]
  return not (field and (field.tiles or 0) > 0)
end

-- Which items the recipe graph can be a source of at all, and in which round each was proved.
--
-- A recipe sources an item when it hands back more of it than it takes AND every other thing it takes
-- is itself sourced. That second half is what turns a list of net producers into a least fixed point:
-- `oxide-asteroid-chunk` has two net-positive recipes on this install, and each of them is fed by a
-- chunk of another colour, and those two are fed by a chunk of a third, and the triangle closes. No
-- machine count opens a set like that, and walking into one is worse than refusing it -- the pass
-- loop amplifies its own demand by the route it took through the set and then reports the inflated
-- figure as if the line needed it. Proving the set closed at the door lets the refusal say the one
-- number that is true: how much of the item the rest of the plan asked for.
--
-- A round number is kept alongside the proof because it is the same information the walk needs to
-- choose: an item proved in round n has every input proved in a round below n, so following the
-- proofs always terminates.
local function build_producible(state)
  local proved, trace = {}, {}
  for name in pairs(state.db.raw or {}) do
    if not mined_only_from_a_hole(state, name) then proved[name] = 0 end
  end
  local round, changed = 0, true
  while changed do
    changed = false
    round = round + 1
    -- Collected during the round and merged after it: an item proved in round n may only lean on
    -- inputs from rounds below n, and reading a `proved` table that this same round is still writing
    -- lets two items lean on each other and both claim round n. The walk picks recipes by that
    -- ordering, so an equal round there is a loop it cannot get out of.
    local added, proved_by = {}, {}
    for item, list in pairs(state.db.producers) do
      if not proved[item] then
        for _, r in ipairs(list) do
          if (r.enabled or state.allow_locked) and rat.cmp(net_yield(r, item), rat.new(0)) > 0 then
            local fed, inputs = true, {}
            for _, ing in ipairs(net_ingredients(r, item)) do
              if not proved[ing.name] then fed = false break end
              inputs[#inputs + 1] = ing.name
            end
            if fed then
              added[item] = round
              proved_by[item] = { recipe = r.name, inputs = inputs }
              break
            end
          end
        end
      end
    end
    for item, r in pairs(added) do
      proved[item] = r
      trace[item] = proved_by[item]
      changed = true
    end
    if round > 400 then break end   -- one round per item is the bound; a graph that needs more is a bug report
  end
  return proved, trace
end

-- The technologies between this player and an item the recipe graph could otherwise source.
--
-- `NO_RECIPE_SOURCE` is the right sentence for an asteroid chunk and a wrong one for a save that has
-- not researched the middle of a chain: in the second case there IS a source and the player is one
-- technology from it, which is the difference between "go build collectors" and "go research". The
-- two are told apart by proving the set a second time with every recipe counted, then walking that
-- proof back down and naming what was locked on the way. The descent stops at anything the enabled-only
-- proof already covers, so on a fully researched save it costs one pass and no answers change.
local function research_door(state, item)
  if state.producible_locked == nil then
    local proved, trace = build_producible({
      db = state.db, allow_locked = true, field_supply = state.field_supply,
    })
    state.producible_locked, state.trace_locked = proved, trace
  end
  if not state.producible_locked[item] then return false end
  -- Rounds fall along a proof (an item leans only on inputs proved in an earlier round), so this
  -- cannot wander; the caps are against a graph that violates that, which would be a bug upstream.
  local stack, walked, hops = { item }, {}, 0
  while #stack > 0 and hops < 400 do
    hops = hops + 1
    local here = table.remove(stack)
    if not walked[here] and not state.producible[here] then
      walked[here] = true
      local t = state.trace_locked[here]
      local rec = t and state.db.recipes[t.recipe]
      if rec then
        if not rec.enabled then note_prereq(state, rec.techs, rec.name, here) end
        for _, name in ipairs(t.inputs) do stack[#stack + 1] = name end
      end
    end
  end
  return #state.prerequisites > 0
end

-- What a plantation item's own prototype states, in items and minutes.
--
-- `db.farmable` (control.lua) read this off the plant the seed names: products per harvest and the growth
-- timer. Both are linear in demand, so the two numbers a player can use fall out of them -- how often
-- something has to come off the plot, and how many plants have to be standing for that to be possible.
local function farm_record(f)
  local function r2(v) return math.floor(v * 100 + 0.5) / 100 end
  local minutes = f.growth_ticks / 3600   -- 60 ticks a second, 60 seconds a minute
  return {
    item = f.item, seed = f.seed, plant = f.plant, per_plant = r2(f.per_plant),
    growth_ticks = f.growth_ticks, growth_minutes = r2(minutes),
    -- One seed per plant is how planting works in the game; stated because nothing in the prototypes
    -- says it, and a modded farm that plants four seeds to a tile would make every minute-figure below
    -- a quarter of the truth.
    seeds_per_plant = 1,
    -- The one farm number that exists without a target to size against: what a plot of a given size
    -- would hand over, stated per thousand plants because there is no tiles-per-tower to convert it by.
    per_min_per_1000_plants = r2(1000 * f.per_plant / minutes),
  }
end

-- Said once here and rendered from a key of its own by the panel (`r-farm-notower`), so a Chinese window
-- reads Chinese and an RCON caller still gets the caveat.
local not_sized = "What is NOT answered here is the tower: how many tiles one agricultural tower tills, "
  .. "and how long its crane takes to plant and to harvest, are not prototype fields on this install "
  .. "(measured: `farm_tile_requires_water` raises, `radius` is the building's own footprint), so this "
  .. "stops at plants rather than dividing by a made-up tile count"

-- The same record, sized against a demand: `coeff` is per plan unit and `state.target_per_min` is what
-- the caller asked the plan for, so their product is what this plant has to hand over each minute.
local function farm_at(state, f, coeff)
  local farm = farm_record(f)
  local per_min = state.target_per_min and (rat.toNumber(coeff) * state.target_per_min)
  if per_min and per_min > 0 then
    local function r2(v) return math.floor(v * 100 + 0.5) / 100 end
    local harvests = per_min / f.per_plant
    farm.demand_per_min = r2(per_min)
    farm.harvests_per_min = r2(harvests)
    farm.plants_standing = math.ceil(harvests * farm.growth_ticks / 3600)
    farm.seeds_per_min = r2(harvests * farm.seeds_per_plant)
  end
  return farm
end

-- A plantation item, refused by the plant's own numbers instead of by a shrug.
local function farm_source(state, item, coeff, f)
  local farm = farm_at(state, f, coeff)
  local sized = farm.plants_standing and ("so " .. tostring(farm.plants_standing) .. " have to be standing "
    .. "to give " .. tostring(farm.demand_per_min) .. "/min, which eats " .. tostring(farm.seeds_per_min)
    .. " seeds a minute -- and a seed is itself an item the plan has to source")
    or ("without a target rate the only thing to say is " .. tostring(farm.per_min_per_1000_plants)
      .. "/min per thousand plants standing")
  return nil, "NO_RECIPE_SOURCE", item .. " is grown, not crafted: no recipe on this install yields it", {
    item = item, farm = farm,
    -- The same sentence the panel is allowed to render in the reader's language. The en row behind this
    -- key is the line above with `__1__` in place of the item name, so the window and the protocol state
    -- one fact twice rather than two facts about the same refusal.
    msg_key = "m-grown", msg_params = { item },
    demand_per_plan_unit = rat.toNumber(coeff),
    why = "a " .. f.plant .. " grown from a " .. f.seed .. " hands back " .. tostring(farm.per_plant)
      .. " of the item once, after " .. tostring(farm.growth_minutes) .. " minutes; " .. sized
      .. ". " .. not_sized,
  }
end

local function walk(state, item, coeff, path)
  for _, p in ipairs(path) do
    if p == item then
      -- A loop, cut here rather than refused: the demand at the cut is fed back as another root and
      -- the whole graph re-walked until the total stops moving (see S.plan). This is what the
      -- arithmetic actually is. `kovarex-enrichment-process` takes 40 units of uranium-235 and hands
      -- 41 back, so a net unit of 235 costs 40 crafts' worth of the same isotope it is made from;
      -- the machine count has to come from the fixed point of that rather than from the wish. Six
      -- recipes on this install recirculate one of their own inputs this way and every one of them
      -- nets positive -- coal-liquefaction (25 heavy oil in, 90 out), the two bacteria cultures,
      -- pentapod-egg, fish-breeding -- so refusing at the cut, which is all this ever did, left the
      -- uranium chain and the whole of oil chemistry without an answer at any machine count. What is
      -- NOT a loop is a recipe that only eats the item: see `net_yield`.
      state.cyclic[item] = rat.add(state.cyclic[item] or rat.new(0), coeff)
      return true
    end
  end
  path[#path + 1] = item

  -- Raw resources are leaves even though some modded recipe can also output them.
  local raw = state.db.raw and state.db.raw[item]
  if raw and not (state.routes and state.routes[item]) and not mined_only_from_a_hole(state, item) then
    local ok, e, d = mining_node(state, item, coeff)
    path[#path] = nil
    if not ok then return nil, e, d end
    return true
  end

  local node_by
  local recipe
  if state.routes and state.routes[item] then
    recipe = state.db.recipes[state.routes[item]]
    if not recipe then
      path[#path] = nil
      return nil, "UNKNOWN_ROUTE", state.routes[item]
    end
    -- A route the solver cannot source with is not a route. The recipe named for an item has to give
    -- back more of it than it takes, or the plan spends the very thing it was asked to make; the
    -- check runs here too, so an explicit `routes` entry cannot walk past it.
    local net = net_yield(recipe, item)
    if rat.cmp(net, rat.new(0)) <= 0 then
      path[#path] = nil
      return nil, "ROUTE_NOT_PRODUCER", recipe.name .. " takes " .. item .. " instead of yielding it", {
        item = item, recipe = recipe.name, net_per_craft = rat.toNumber(net),
        demand_per_plan_unit = rat.toNumber(coeff),
        why = "the routed recipe puts " .. tostring(rat.toNumber(product_amount(recipe, item) or rat.new(0)))
          .. " of the item out per craft and takes more than that in, so it can only ever be a "
          .. "consumer of what it is being asked to supply",
      }
    end
  else
    local consumers, suppliers = {}, {}
    for _, candidate in ipairs(state.db.producers[item] or {}) do
      if candidate.enabled or state.allow_locked then
        local net = net_yield(candidate, item)
        if rat.cmp(net, rat.new(0)) > 0 then
          suppliers[#suppliers + 1] = { recipe = candidate, net = net }
        else
          -- Kept by name and net, because "no recipe yields this" is only believable with the
          -- near-misses attached: a crusher really does put chunks out, and it really does eat more.
          consumers[#consumers + 1] = {
            recipe = candidate.name, net_per_craft = rat.toNumber(net),
            enabled = candidate.enabled and true or false,
          }
        end
      else
        note_prereq(state, candidate.techs, candidate.name, item)
      end
    end
    if #suppliers == 0 then
      path[#path] = nil
      -- Asked first, before either of the two sentences that have a name: an item no recipe yields and a
      -- recipe that has not been researched are different news, and `yumako` is neither -- it has no
      -- technology behind it and no near-miss consumer, which is why it used to come out of here as
      -- `NO_UNLOCKED_RECIPE` with an empty prerequisite list.
      local grown = state.db.farmable and state.db.farmable[item]
      if grown then return farm_source(state, item, coeff, grown) end
      if #consumers > 0 then
        -- Not a cycle and not a missing technology: the item simply has no recipe that yields more of
        -- it than it eats. Saying so is worth more than the closest error that has a name, because
        -- the reader otherwise goes looking for a loop that is not there.
        return nil, "NO_NET_PRODUCER", item .. " is taken by every recipe that names it, so none of them yields it", {
          item = item, candidates = consumers,
          demand_per_plan_unit = rat.toNumber(coeff),
          why = "each recipe listed puts some of the item out and takes at least as much of it in, so "
            .. "the recipe graph cannot be its source at any machine count; whatever produces it is "
            .. "not a recipe -- an asteroid chunk is collected from orbit, ore is mined -- and this "
            .. "solver sizes neither of those from that side",
        }
      end
      return nil, "NO_UNLOCKED_RECIPE", item
    end
    if not state.producible[item] then
      -- The recipes above do hand back more of the item than they take, and every one of them is fed
      -- by something the graph cannot source either. This is the closed set: `oxide-asteroid-chunk`,
      -- `metallic-asteroid-chunk`, `carbonic-asteroid-chunk`, each yielded by reprocessing another.
      -- Naming it here, at the door, is what keeps the demand number true -- one round through the set
      -- multiplies it and the walk would otherwise report the product as a need.
      local gated = {}
      for _, s in ipairs(suppliers) do
        local blocked, blocked_rat
        for _, ing in ipairs(net_ingredients(s.recipe, item)) do
          if not state.producible[ing.name] then
            blocked = ing.name
            -- What this recipe would have to be fed, per minute, at the rate the caller asked for. The
            -- recipe was never chosen, so its craft rate is computed here from the same numbers the
            -- choice would have used: demand / net yield of the item x net intake of the blocker.
            blocked_rat = rat.mul(rat.div(coeff, net_yield(s.recipe, item)), ing.amount)
            break
          end
        end
        local entry = {
          recipe = s.recipe.name, net_per_craft = rat.toNumber(s.net),
          blocked_by = blocked,
          blocked_demand_per_plan_unit = blocked_rat and rat.toNumber(blocked_rat) or nil,
        }
        -- The recipe graph stops at `wood`, and the sentence it can say is "this is not a recipe". The
        -- farm record belongs to the blocker rather than to the item being asked for, because the
        -- blocker is the thing with a growth timer: 60 wooden chests a minute wants 120 wood a minute,
        -- and 120 wood a minute is 24 tree-plants standing. That is the half of the answer a reader
        -- can act on, and it was being dropped here.
        if blocked_rat and blocked and state.db.farmable and state.db.farmable[blocked] then
          entry.farm = farm_at(state, state.db.farmable[blocked], blocked_rat)
        end
        gated[#gated + 1] = entry
      end
      -- Two different news come through this door and only one of them is about the recipe graph. A
      -- save that has not researched the middle of a chain also has no *producible* source for the
      -- item, and answering it with "nothing yields this, go build collectors" sends the player to
      -- hardware that will not help: `research_door` proves the same set with the locked recipes
      -- counted and, if that opens, names the technologies instead.
      if research_door(state, item) then
        return nil, "NO_UNLOCKED_RECIPE", item, {
          item = item, candidates = gated, demand_per_plan_unit = rat.toNumber(coeff),
          why = "every recipe that would carry this item further down the chain is one the force has "
            .. "not researched; the technologies are in `prerequisites`",
        }
      end
      -- The old sentence here said the solver sizes neither of the two things that are not recipes. That
      -- was true of both halves and is now true of one: a plantation blocker DOES have its numbers, on
      -- the candidate that named it, and a `why` that still claimed otherwise would contradict the very
      -- record it is printed next to.
      local grown_in_set = nil
      for _, c in ipairs(gated) do
        if c.farm then grown_in_set = c.farm.item break end
      end
      return nil, "NO_RECIPE_SOURCE", item .. " has recipes that yield it, but each of them is fed by "
        .. "an item nothing in the graph can source", {
        item = item, candidates = gated, demand_per_plan_unit = rat.toNumber(coeff),
        msg_key = "m-closed-set", msg_params = { item },
        why = "the set of items this one belongs to is closed: nothing outside it produces anything "
          .. "inside it, so no machine count opens it. The demand has to be met by something that is "
          .. "not a recipe"
          .. (grown_in_set and (" -- and where that something grows, the numbers are on the candidate "
            .. "that named it: " .. tostring(grown_in_set) .. " comes off a plant on a growth timer, so "
            .. "the plants are sized even though the tower is not.")
            or (" -- an asteroid chunk is collected from orbit, ore is drilled, and this solver sizes "
              .. "neither of those from that side")),
      }
    end
    -- An item the fixpoint proved is proved by at least one recipe whose own inputs were proved in an
    -- EARLIER round, so choosing only those makes the walk's choices strictly decrease in round number
    -- and it cannot come back to an item it is already standing on. Taking the first net producer in
    -- list order -- which is what this did -- could still step sideways into a set that closes: the
    -- proof for `sulfuric-acid` runs one way and the walk took a route back through water and steam,
    -- which is a loop the iteration then diverged on while a source-free answer was waiting unchosen.
    local mine = state.producible[item]
    for _, s in ipairs(suppliers) do
      local fed = true
      for _, ing in ipairs(net_ingredients(s.recipe, item)) do
        local round = state.producible[ing.name]
        if not round or round >= mine then fed = false break end
      end
      if fed then recipe = s.recipe break end
    end
    if not recipe then
      path[#path] = nil
      return nil, "NO_RECIPE_SOURCE", item .. " is proved producible by no recipe whose inputs are all producible before it", {
        item = item, candidates = consumers, demand_per_plan_unit = rat.toNumber(coeff),
        round = mine,
        why = "the producible set says this item can be sourced and no candidate recipe passed the "
          .. "check that made it so, which is a contradiction in the fixpoint rather than a fact "
          .. "about the factory",
      }
    end
  end

  -- Multi-product recipes are not refused any more. The arithmetic for the product someone
  -- asked for was always well defined -- this step makes `y` of it, so it scales by coeff/y
  -- and recurses on the ingredients -- and what the OTHER outputs do is reported rather than
  -- silently dropped, which is what the refusal was protecting against.
  local machine, err, det = pick_machine(state, recipe, state.machines)
  if not machine then
    path[#path] = nil
    return nil, err, det
  end
  local rate = per_machine_per_sec(recipe, item, machine)
  if not rate then
    path[#path] = nil
    return nil, "BAD_RECIPE", recipe.name
  end

  local mf = state.modules and S.module_factors(state.db, state.modules, machine, recipe)
  local y = product_amount(recipe, item)
  -- What one craft leaves behind for the rest of the line, once the part of its own output that it
  -- feeds back into itself is taken out. `kovarex-enrichment-process` puts 41 units of uranium-235 on
  -- the belt per craft and takes 40 off it again, so a machine that appears to make 41 nets 1, and
  -- sizing a plant for 100/min of 235 on the gross number asks for a hundred times too few
  -- centrifuges. For every recipe except the six that overlap one of its own inputs, `y_net == y`.
  local prod_mult = rat.from(mf and mf.productivity or 1)
  local y_in = ingredient_amount(recipe, item)
  local y_net = rat.sub(rat.mul(y, prod_mult), y_in)
  local per_craft_gross = mf and rat.mul(rate, rat.from(mf.rate)) or rate
  if rat.cmp(y_net, rat.new(0)) <= 0 then
    -- A machine that nets nothing can supply nothing however fast it runs, and a negative divisor
    -- here would come out as a plan with negative machine counts rather than as a refusal.
    path[#path] = nil
    return nil, "NET_YIELD_NOT_POSITIVE", recipe.name .. " cannot supply " .. item
      .. " with those modules on it", {
      item = item, recipe = recipe.name, machine = machine.name,
      per_craft_out = rat.toNumber(rat.mul(y, prod_mult)), per_craft_in = rat.toNumber(y_in),
      why = "the recipe takes at least as much of the item per craft as the machine puts out, so no "
        .. "number of them produces any; take the productivity-negative modules off or route elsewhere",
    }
  end
  -- The same clock read on the net side. `per_craft_gross / (y * prod_mult)` is the machine's craft
  -- rate, which is what both the gross belt figure and the net line figure have to agree with.
  local eff_rate = rat.mul(rat.div(per_craft_gross, rat.mul(y, prod_mult)), y_net)
  if #recipe.products > 1 then
    local others = {}
    for _, pr in ipairs(recipe.products) do
      if pr.name and pr.name ~= item then
        -- the amount ratios of one recipe turn the target's per-machine rate into this
        -- co-product's, exactly and in rationals -- no float rounding on a 0.007/0.993 split
        local r = per_machine_per_sec(recipe, pr.name, machine)
        if r and mf then r = rat.mul(r, rat.from(mf.rate)) end
        others[#others + 1] = {
          item = pr.name,
          per_machine_per_min = r and rat.toNumber(rat.mul(r, rat.new(60))) or nil,
          -- against what the target line actually gains, not against what a belt carries past it
          ratio_to_target = rat.toNumber(rat.div(pr.amount, y_net)),
        }
      end
    end
    if #others > 0 then
      table.sort(others, function(a, b) return a.item < b.item end)
      node_by = others
    end
  end

  local node = {
    kind = "craft", item = item, recipe = recipe.name, machine = machine.name,
    coeff = rat.div(coeff, eff_rate),
    per_machine_per_min = rat.toNumber(rat.mul(eff_rate, rat.new(60))),
    by_products = node_by,
    module_factors = mf,
  }
  if rat.cmp(y_in, rat.new(0)) > 0 then
    -- Both figures belong in the plan: one machine of this recipe moves `gross` of the item across a
    -- belt every minute and hands the line `net` of it, and the difference is the return pipe that has
    -- to carry it back. Shown only one, a reader cannot tell those two factories apart.
    node.recirculated = {
      item = item,
      per_craft_in = rat.toNumber(y_in),
      per_craft_out = rat.toNumber(rat.mul(y, prod_mult)),
      per_craft_net = rat.toNumber(y_net),
      gross_per_machine_per_min = rat.toNumber(rat.mul(per_craft_gross, rat.new(60))),
    }
  end
  state.nodes[#state.nodes + 1] = node

  local taken, carriers = net_ingredients(recipe, item)
  if #carriers > 0 then
    -- On the node, not only in a log: a plan whose graph never asked for the chunk is only honest if
    -- the thing that makes it complete -- one chunk, already sitting somewhere in the loop -- is part
    -- of what the node says.
    node.in_flight = (function()
      local l = {}
      for _, c in ipairs(carriers) do
        l[#l + 1] = { item = c.item, amount = rat.toNumber(c.amount), returned = rat.toNumber(c.returned) }
      end
      return l
    end)()
    state.in_flight = state.in_flight or {}
    for _, c in ipairs(carriers) do
      -- `coeff / y_net` is the line's craft rate for this recipe, so a carrier that has to be in
      -- flight once per craft scales to the machines the line actually builds. Kept as a rational
      -- until the report, because every amount in here is one and converting twice is how a 0.007
      -- becomes a 0.
      local need = rat.mul(rat.div(coeff, y_net), c.amount)
      local seen = state.in_flight[c.item]
      if seen then
        if rat.cmp(need, seen.amount) > 0 then seen.amount = need end
      else
        state.in_flight[c.item] = { item = c.item, amount = need, per_craft = c.amount, recipe = recipe.name }
      end
    end
  end

  for _, ing in ipairs(taken) do
    -- The divisor is the NET per-craft yield because the demand was priced in net terms: a recipe
    -- that puts 41 of the item on the belt and pulls 40 back off it runs forty-one times as often as
    -- one that nets 41, and the ingredients scale with the crafts rather than with the belt. Using
    -- the gross yield here is how an overlapping recipe comes out dozens of times too small while
    -- still looking like a plan.
    local ok, e, d, x = walk(state, ing.name, rat.mul(coeff, rat.div(ing.amount, y_net)), path)
    if not ok then path[#path] = nil return nil, e, d, x end
  end
  path[#path] = nil
  return true
end

-- Shared with the snapshot layer so "which machine would be used" has one answer.
function S.best_machine(db, recipe)
  local best, best_speed, nearest
  local names = {}
  for k in pairs(db.machines) do names[#names + 1] = k end
  table.sort(names)
  for _, k in ipairs(names) do
    local m = db.machines[k]
    local speed = m.speed or m.mining_speed
    if speed and speed > 0 then
      for _, c in ipairs(m.categories or {}) do
        if c == recipe.category then
          if m.available == false then
            if not nearest or nearer_unlock(m, nearest) then nearest = m end
          elseif not best_speed or speed > best_speed then
            best, best_speed = m, speed
          end
        end
      end
    end
  end
  if best then return best end
  if nearest then return nil, nearest end
  return nil
end

function S.plan(db, args)
  args = args or {}
  local want = args.want or {}
  local item = want.item or want.fluid
  if not item then return nil, "BAD_ARGS", "want.item is required", { msg_key = "m-want-item", msg_params = {} } end
  -- A request the solver only partly reads is a plan built on a misunderstanding: `want.per_min`
  -- is a plausible name, and reading only `rate_per_min` turned it into "no target" without a
  -- word of complaint. Keys are therefore refused rather than ignored.
  for k in pairs(want) do
    if k ~= "item" and k ~= "fluid" and k ~= "rate_per_min" then
      return nil, "UNKNOWN_REQUEST_KEY", "want." .. tostring(k)
        .. " is not read; want takes item (or fluid) and rate_per_min"
    end
  end

  -- Built once for the call, not once per pass: it is a property of the graph and the force, and the
  -- pass loop can run hundreds of times on a converging loop.
  local producible = build_producible({
    db = db, allow_locked = args.allow_locked, field_supply = args.field_supply,
  })

  local function new_state()
    return {
      db = db, nodes = {}, made = nil, modules = args.modules,
      routes = args.routes, machines = args.machines,
      producible = producible,
      in_flight = {},   -- items a recipe hands back whole: capital in the loop, not demand
      cyclic = {},      -- demand found at a cut, to be fed back on the next pass
      allow_locked = args.allow_locked, prerequisites = {}, seen = {},
      -- drill rates that were read off the ground rather than inferred: "machine|resource" -> measurement
      measured = args.measured,
      field_supply = args.field_supply,
      -- The rate the caller asked for, so a leaf that is not a recipe at all (see `farm_source`) can
      -- answer in items a minute instead of in units per plan unit. Every other refusal gets its scaling
      -- in `refused`, which is outside the walk; this one needs it inside.
      target_per_min = tonumber((args.want or {}).rate_per_min),
    }
  end

  -- Walk, then walk again with every cut added as a root demand, until the cut totals stop growing.
  -- A converging loop (the asteroid chunk: 0.95 of a chunk eaten per craft) settles at 20x throughput,
  -- and the machine counts come from the LAST pass, so they include the recirculation rather than the
  -- wish. Refusing at the first cut, which is all this used to do, is right about the graph and wrong
  -- about the factory: rocket, quantum-processor and sulfuric-acid all sit downstream of that loop.
  --
  -- The stopping rule reads the loop's own ratio rather than counting passes. Successive totals differ
  -- by a shrinking factor r; the tail still missing after this pass is `delta * r / (1 - r)`, so the
  -- run ends when that tail is negligible instead of after an arbitrary number of rounds -- with
  -- r=0.95 that is hundreds of passes, and a fixed budget of 60 stopped "early" while calling it a
  -- plan. r >= 1 is the case that genuinely has no answer: each round needs more than the last, so it
  -- is refused at once, with the numbers.
  local TOLERANCE, MAX_PASSES = 1e-6, 2000
  local seeds, state, last = {}, nil, nil
  local series = {}
  local prev_delta, converged, pass = nil, false, 0
  -- A leaf of the graph can refuse for a reason only it knows -- which recipes it looked at, what
  -- each one's net was. `walk` hands that up as a fourth value and it rides along with the refusal
  -- instead of being flattened into the one line `fail` prints.
  --
  -- A leaf demand is measured against the root, which is one of the target per second, so it is
  -- useless as written. Everything under the root is linear in it, so multiplying by the requested
  -- rate turns "0.95 per unit" into "57 chunks a minute for the 60 gears a minute you asked about" --
  -- the difference between a refusal a reader can act on and one they cannot.
  local function refused(err, detail, extra)
    local out = { prerequisites = state.prerequisites, partial_nodes = state.nodes }
    for k, v in pairs(extra or {}) do out[k] = v end
    if type(out.demand_per_plan_unit) == "number" then
      local per_min = tonumber(want.rate_per_min)
      -- Only worth saying when the item the walk ran out of is not the item that was asked for: for a
      -- root refusal, "120/min of ice, for the 120/min of ice" restates the question, and the numbers
      -- a reader needs are already on each candidate line.
      if per_min and out.item ~= item then
        out.demand_per_min = out.demand_per_plan_unit * per_min
        out.for_target_per_min = per_min
        -- `item` in a refusal is the item the walk ran out of, which is usually not the thing that was
        -- asked for; the sentence needs both names to be readable.
        out.for_item = item
      end
    end
    -- ...and the same for each recipe the refusal looked at, which is the number that actually gets
    -- used: how many asteroid chunks a minute the collectors have to hand over for this plan.
    if type(out.candidates) == "table" then
      local per_min = tonumber(want.rate_per_min)
      for _, c in pairs(out.candidates) do
        if type(c) == "table" and per_min and type(c.blocked_demand_per_plan_unit) == "number" then
          c.blocked_demand_per_min = c.blocked_demand_per_plan_unit * per_min
        end
      end
    end
    return nil, err, detail, out
  end
  local first_cut = nil
  for p = 1, MAX_PASSES do
    pass = p
    state = new_state()
    local ok, err, detail, extra = walk(state, item, rat.new(1), {})
    if not ok then return refused(err, detail, extra) end
    for seed_item, coeff in pairs(seeds) do
      local ok2, e2, d2, x2 = walk(state, seed_item, coeff, {})
      if not ok2 then return refused(e2, d2, x2) end
    end
    last = state.cyclic

    local scale, delta = 0, 0
    for name, need in pairs(state.cyclic) do
      local now = rat.toNumber(need)
      scale = math.max(scale, now)
      local before = seeds[name] and rat.toNumber(seeds[name]) or 0
      delta = math.max(delta, math.abs(now - before))
    end
    if scale == 0 then converged = true break end
    series[#series + 1] = { pass = pass, delta = delta, scale = scale }
    if not first_cut then
      first_cut = {}
      for name, need in pairs(state.cyclic) do first_cut[name] = rat.toNumber(need) end
    end
    if prev_delta and delta >= prev_delta then
      -- The two cut numbers say different things and neither is a demand the factory has: the first is
      -- what the walk had reached the item by when it cut, the second is the same after the solver fed
      -- the cut back in as extra demand. Printing only the second, which is what this did, hands the
      -- reader a number inflated by the solver's own choice of supplier and lets them call it a need.
      local loop = {}
      for name, need in pairs(state.cyclic) do
        loop[#loop + 1] = {
          item = name,
          cut_demand_pass_1 = first_cut[name],
          cut_demand_last_pass = rat.toNumber(need),
        }
      end
      table.sort(loop, function(a, b) return a.item < b.item end)
      return nil, "CYCLIC_RECIPE", "the loop grows instead of settling", {
        cyclic_scale = scale, delta = delta, previous_delta = prev_delta, passes = pass,
        -- the machines the walk had sized before it died: which crushers asked for the chunks, and
        -- how many of them. Without this the refusal says only that something is missing.
        partial_nodes = state.nodes, prerequisites = state.prerequisites,
        loop = loop,   -- which items the loop turns over, so the refusal names them and not just its numbers
        series = series,   -- the per-pass deltas, so "it diverges" can be read rather than trusted
        why = "each round of this loop needs more of the item than the round before, so no finite "
          .. "machine count satisfies it. The recipes that reach these items consume items of the same "
          .. "kind they yield, which is why nothing here opens up; the item has to arrive from "
          .. "something that is not a recipe -- an asteroid chunk is collected from orbit, ore is "
          .. "drilled out of the ground -- and this solver sizes neither of those from that side",
      }
    end
    local ratio = (prev_delta and prev_delta > 0) and (delta / prev_delta) or 0.5
    local tail = (ratio < 1) and (delta * ratio / (1 - ratio)) or math.huge
    converged = tail <= TOLERANCE * math.max(scale, 1)
    prev_delta, seeds = delta, state.cyclic
    if converged then break end
  end
  if not converged then
    local totals = {}
    for name, need in pairs(last or {}) do totals[name] = rat.toNumber(need) end
    return nil, "CYCLIC_RECIPE", "no fixed point within " .. pass .. " passes", {
      cyclic = totals, passes = pass,
      why = "the cut kept growing without settling inside the pass limit; the loop is either "
        .. "diverging very slowly or larger than this solver will iterate",
    }
  end

  local lcm_d, gcd_n = 1, 0
  for _, n in ipairs(state.nodes) do
    lcm_d = rat.lcm(lcm_d, n.coeff.d)
    gcd_n = (gcd_n == 0) and n.coeff.n or rat.gcd(gcd_n, n.coeff.n)
  end
  if gcd_n == 0 then return nil, "EMPTY_PLAN", item end

  local unit_rate = rat.new(lcm_d, gcd_n)
  local unit_per_min = rat.toNumber(rat.mul(unit_rate, rat.new(60)))

  local nodes, slots = {}, 0
  for _, n in ipairs(state.nodes) do
    local count = rat.toNumber(rat.mul(n.coeff, unit_rate))
    slots = slots + count
    local by_products
    if n.by_products then
      by_products = {}
      for _, bp in ipairs(n.by_products) do
        if bp.per_machine_per_min then
          by_products[#by_products + 1] = {
            item = bp.item, per_min = bp.per_machine_per_min * count,
          }
        end
      end
      if #by_products == 0 then by_products = nil end
    end
    nodes[#nodes + 1] = {
      kind = n.kind, item = n.item, recipe = n.recipe, machine = n.machine,
      count = count, per_machine_per_min = n.per_machine_per_min, estimated = n.estimate,
      -- where the number above came from: a formula, or the ground under this map
      rate_source = n.rate_source,
      -- an ore can demand a fluid and always costs time to break; both are line items on the plan,
      -- not trivia about the tile
      required_fluid = n.required_fluid, fluid_amount = n.fluid_amount,
      ore_mining_time = n.ore_mining_time,
      -- what a broken unit of this ore yields, and how much ore is lying around: without these the
      -- plan says "2 machines" and the caller cannot tell items from fluid units, nor whether the
      -- patch will still be there next hour
      product_type = n.product_type, rate_window_seconds = n.rate_window_seconds,
      units_per_ore_unit = n.units_per_ore_unit,
      field = n.field,
      by_products = by_products,
      -- a recipe that feeds part of its own output back into itself: the count above is sized on what
      -- the line gains, and this says what the belt has to carry as well
      recirculated = n.recirculated,
      in_flight = n.in_flight,
      -- what the modules actually did, including where a request did not fit: a plan that
      -- silently ignored "4 productivity modules" in a 2-slot furnace is a lie by omission
      modules = n.module_factors,
    }
    for _, bp in ipairs(by_products or {}) do
      state.made = state.made or {}
      state.made[bp.item] = (state.made[bp.item] or 0) + bp.per_min
    end
  end

  local target = tonumber(want.rate_per_min) or 0
  local margin = tonumber(args.margin) or 1
  local needed = target * margin
  local k = needed > 0 and (needed / unit_per_min) or 1

  -- Only machine draw. Inserters and belts are the card layer's problem: their
  -- count is a property of the geometry, which is not decided here.
  local grid_kw, fuel_kw, emissions = 0, 0, 0
  for _, n in ipairs(nodes) do
    local m = db.machines[n.machine]
    local w = (m and m.energy_usage or 0) * (n.module_factors and n.module_factors.consumption or 1)
    if m and m.on_grid then grid_kw = grid_kw + w * n.count else fuel_kw = fuel_kw + w * n.count end
    if m and m.emissions then emissions = emissions + m.emissions * n.count end
  end
  local power = { machine_grid_kw = grid_kw, machine_fuel_kw = fuel_kw, emissions_per_sec = emissions }

  local available = tonumber(args.power_available_kw)
  local function variant(replicas, label)
    local ms = {}
    for _, n in ipairs(nodes) do
      ms[#ms + 1] = { kind = n.kind, item = n.item, recipe = n.recipe, machine = n.machine,
                      count = n.count * replicas, estimated = n.estimated }
    end
    local out = unit_per_min * replicas
    local draw = grid_kw * replicas
    local fuel = fuel_kw * replicas
    local c = {
      label = label, replicas = replicas, nodes = ms, output_per_min = out,
      machine_grid_kw = draw, machine_fuel_kw = fuel,
      -- with no target there is nothing to be over or under: dividing by `needed` == 0 produced
      -- `inf`, and `inf` is not JSON -- the answer is consumed by a program, so a bare word that
      -- JSON.parse rejects is a broken protocol, not a display detail
      over_by = needed > 0 and out > needed and (out / needed - 1) or nil,
      shortfall = needed > 0 and out < needed and (1 - out / needed) or nil,
    }
    if available then
      -- Machines only: inserters and belts are decided by the geometry, so this
      -- is a floor on the real demand, not the real demand. Burner lines draw
      -- nothing from the grid, so `power_feasible` alone says nothing about them;
      -- fuel has to be weighed separately.
      c.power_headroom_kw = available - draw
      c.power_feasible = draw <= available
      c.power_excludes_logistics = true
      c.grid_is_vacuous = draw == 0 and fuel > 0
    end
    return c
  end

  local candidates = { variant(math.ceil(k), "ceil") }
  local floored = math.floor(k)
  if floored >= 1 and floored < k then candidates[#candidates + 1] = variant(floored, "floor") end

  -- What the plan spills on the side, and whether the plan itself could use it. Routing a
  -- by-product into another node's demand changes the integer structure of the tree, and that
  -- is not solved here -- so it is named, with the two rates, rather than folded in silently.
  local made = state.made or {}
  local demanded = {}
  for _, n in ipairs(nodes) do demanded[n.item] = true end
  local byproduct_report, offsets = {}, {}
  for bitem, rate in pairs(made) do
    byproduct_report[#byproduct_report + 1] = { item = bitem, per_min = rate }
    if demanded[bitem] then
      offsets[#offsets + 1] = {
        item = bitem, produced_per_min = rate,
        note = "this plan both makes and consumes " .. bitem .. "; the solver does not route "
          .. "by-products into demand, so the input is still planned at full rate",
      }
    end
  end
  table.sort(byproduct_report, function(a, b) return a.item < b.item end)
  table.sort(offsets, function(a, b) return a.item < b.item end)

  -- Every rate in the plan body is per minute at the unit plan, and these two were not: they were
  -- counted at root scale (one of the target per second) and left unlabelled, which is the shape a
  -- number takes when it is off by `unit_rate` and a reader has no way to notice.
  local unit_per_min_rat = rat.mul(unit_rate, rat.new(60))
  local in_flight_report = {}
  for _, c in pairs(state.in_flight or {}) do
    in_flight_report[#in_flight_report + 1] = {
      item = c.item, per_min = rat.toNumber(rat.mul(c.amount, unit_per_min_rat)),
      per_craft = rat.toNumber(c.per_craft), recipe = c.recipe,
    }
  end
  table.sort(in_flight_report, function(a, b) return a.item < b.item end)

  return {
    item = item,
    unit = { output_per_min = unit_per_min, output_per_sec = rat.tostring(unit_rate),
             nodes = nodes, machine_slots = slots, power = power },
    -- Items a recipe puts back on the belt unchanged: the line needs this much of them moving through
    -- it per minute, and consumes none. Not a demand -- the plan is complete as to rates without it
    -- and incomplete as to a factory, because the amount has to be sitting in the loop before the
    -- first craft and this mod does not claim to know where it came from.
    in_flight = #in_flight_report > 0 and in_flight_report or nil,
    -- The loops that were cut, at their converged totals, in the same per-minute unit-plan terms as
    -- the nodes above. A plan without this line reads as if the recirculated item came from nowhere.
    cyclic = (function()
      local l = {}
      for name, need in pairs(state.cyclic or {}) do
        l[#l + 1] = { item = name, throughput_per_min = rat.toNumber(rat.mul(need, unit_per_min_rat)) }
      end
      table.sort(l, function(a, b) return a.item < b.item end)
      return #l > 0 and l or nil
    end)(),
    by_products = #byproduct_report > 0 and byproduct_report or nil,
    by_product_offsets = #offsets > 0 and offsets or nil,
    target_per_min = target,
    margin = margin,
    replicas_exact = k,
    candidates = candidates,
    prerequisites = state.prerequisites,
    needs_measured_margin = true,
  }
end

return S
