local rat = require("rat")

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
      return nil, "LOCKED_MACHINE", best_locked.name
    end
    return nil, "NO_MACHINE_FOR_CATEGORY", recipe.category
  end
  return best
end

-- Which miner to use, and how much it actually delivers. `mining_speed * 60` is a nameplate:
-- what a drill produces on this map is measured by `drill_rate` and arrives in
-- `state.measured`, keyed "machine|resource". A measured drill wins over an unmeasured one even
-- if it is the slower machine, because a number that was read beats a number that was inferred.
local function miners_for(db, item, measured)
  local raw = db.raw and db.raw[item]
  local cat = raw and raw.category
  local list = {}
  for _, m in pairs(db.machines) do
    if m.kind == "mining-drill" and (m.mining_speed or 0) > 0 then
      local matches = cat == nil
      if cat then
        for _, c in ipairs(m.resource_categories or {}) do
          if c == cat then
            matches = true
            break
          end
        end
      end
      -- a wrapper, not a field on `m`: db is cached across calls, and a measurement taken for
      -- one resource must not be readable as the measurement for the next one
      if matches then
        -- a drill records items and a pump records fluid units, and only a drill records an
        -- arrival period: whichever the rig happened to write, it is still "what one machine
        -- delivers per minute" -- in items, where one tile is one item, or in units of fluid
        local meas = measured and measured[m.name .. "|" .. item]
        local per_min = meas and (meas.steady_items_per_min or meas.items_per_min or meas.units_per_min)
        list[#list + 1] = { machine = m, per_min = per_min, measured = meas }
      end
    end
  end
  table.sort(list, function(a, b)
    if (a.per_min ~= nil) ~= (b.per_min ~= nil) then return a.per_min ~= nil end
    return (a.per_min or a.machine.mining_speed * 60) > (b.per_min or b.machine.mining_speed * 60)
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
  if not chosen then
    if #list > 0 then return nil, "LOCKED_MACHINE", list[1].machine.name end
    return nil, "NO_MINER", item
  end
  -- the steady figure, not the window average: a window always loses whatever was mid-mining at
  -- the moment its clock ran out, so the average is short by up to one item at any length
  local per_min = chosen.per_min or chosen.machine.mining_speed * 60
  state.nodes[#state.nodes + 1] = {
    kind = "mining", item = item, machine = chosen.machine.name,
    coeff = rat.div(coeff, rat.from(per_min / 60)),
    per_machine_per_min = per_min,
    estimate = not chosen.per_min,
    rate_source = chosen.per_min and "measured on this map by drill_rate"
      or "nameplate mining_speed -- call drill_rate for this ore to measure it",
  }
  return true
end

local function walk(state, item, coeff, path)
  for _, p in ipairs(path) do
    if p == item then return nil, "CYCLIC_RECIPE", item end
  end
  path[#path + 1] = item

  -- Raw resources are leaves even though some modded recipe can also output them.
  if state.db.raw and state.db.raw[item] and not (state.routes and state.routes[item]) then
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
  else
    for _, candidate in ipairs(state.db.producers[item] or {}) do
      if candidate.enabled or state.allow_locked then
        recipe = candidate
        break
      end
      note_prereq(state, candidate.techs, candidate.name, item)
    end
    if not recipe then
      path[#path] = nil
      return nil, "NO_UNLOCKED_RECIPE", item
    end
  end

  if not recipe then
    path[#path] = nil
    return nil, "UNRESOLVED_INPUT", item
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
  local eff_rate = mf and rat.mul(rate, rat.from(mf.rate)) or rate
  local y = product_amount(recipe, item)
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
          ratio_to_target = rat.toNumber(rat.div(pr.amount, y)),
        }
      end
    end
    if #others > 0 then
      table.sort(others, function(a, b) return a.item < b.item end)
      node_by = others
    end
  end

  state.nodes[#state.nodes + 1] = {
    kind = "craft", item = item, recipe = recipe.name, machine = machine.name,
    coeff = rat.div(coeff, eff_rate),
    per_machine_per_min = rat.toNumber(rat.mul(eff_rate, rat.new(60))),
    by_products = node_by,
    module_factors = mf,
  }

  for _, ing in ipairs(recipe.ingredients) do
    local ok, e, d = walk(state, ing.name, rat.mul(coeff, rat.div(ing.amount, y)), path)
    if not ok then path[#path] = nil return nil, e, d end
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
  if not item then return nil, "BAD_ARGS", "want.item is required" end
  -- A request the solver only partly reads is a plan built on a misunderstanding: `want.per_min`
  -- is a plausible name, and reading only `rate_per_min` turned it into "no target" without a
  -- word of complaint. Keys are therefore refused rather than ignored.
  for k in pairs(want) do
    if k ~= "item" and k ~= "fluid" and k ~= "rate_per_min" then
      return nil, "UNKNOWN_REQUEST_KEY", "want." .. tostring(k)
        .. " is not read; want takes item (or fluid) and rate_per_min"
    end
  end

  local state = {
    db = db, nodes = {}, made = nil, modules = args.modules,
    routes = args.routes, machines = args.machines,
    allow_locked = args.allow_locked, prerequisites = {}, seen = {},
    -- drill rates that were read off the ground rather than inferred: "machine|resource" -> measurement
    measured = args.measured,
  }
  local ok, err, detail = walk(state, item, rat.new(1), {})
  if not ok then
    return nil, err, detail, { prerequisites = state.prerequisites, partial_nodes = state.nodes }
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
      by_products = by_products,
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

  return {
    item = item,
    unit = { output_per_min = unit_per_min, output_per_sec = rat.tostring(unit_rate),
             nodes = nodes, machine_slots = slots, power = power },
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
