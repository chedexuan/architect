-- How big does a power supply have to be?
--
-- Two different kinds of answer live here and they are kept apart on purpose.
--
-- MEASURED (by the caller, from the engine, in kilowatts): nameplate output per generator,
-- whether that generator is sun-driven, the accumulator's buffer and its charge/discharge
-- limits. A "1 accumulator per 2 panels" folk rule is worthless without the second one --
-- a 300 kW discharge limit decides how many accumulators a load needs before any energy
-- arithmetic does.
--
-- MODELLED (this file): the shape of the day. `surface.freeze_daytime` does not hold across
-- commands, so the sun curve cannot be sampled, and a script surface has no sun at all -- a
-- panel there delivers nothing even with always_day set -- so the verification rig cannot
-- check it either. The phase boundaries ARE read from the surface and the ramps are taken
-- piecewise-linear between them; the model and the phase table are printed with the answer
-- so a wrong reading is visible instead of load-bearing.
--
-- The sizing itself is a simulation of one day, not a ratio: panels generate what the sun
-- allows, the load takes what it needs, and whatever is left over charges the buffer, which
-- then carries the hours the sun cannot. The answer is the smallest panel count that
-- survives, and the smallest buffer that survives with it.

local P = {}

local function wrap(x) return x - math.floor(x) end

-- Forward arc length from a to b on a clock that runs 0..1.
local function arc(a, b) return wrap(b - a) end

local function make_sun(dp)
  local dusk, evening = dp.dusk, dp.evening
  local morning, dawn = dp.morning, dp.dawn
  local function in_arc(t, a, b)
    local len = arc(a, b)
    if len <= 0 then return false end
    return arc(a, t) <= len
  end
  return function(t)
    t = wrap(t)
    if in_arc(t, dusk, evening) then
      return 1 - arc(dusk, t) / math.max(arc(dusk, evening), 1e-9)
    end
    if in_arc(t, evening, morning) then return 0 end
    if in_arc(t, morning, dawn) then
      return arc(morning, t) / math.max(arc(morning, dawn), 1e-9)
    end
    return 1 -- dawn .. dusk: full day, wrapping through 0
  end
end

-- surface -> {seconds, duty, night_seconds, phases, model}
function P.day_model(surface)
  if not surface then return nil end
  local dp = surface.daytime_parameters or {}
  local phases = {
    dusk = dp.dusk or 0.25, evening = dp.evening or 0.45,
    morning = dp.morning or 0.55, dawn = dp.dawn or 0.75,
  }
  local sun = make_sun(phases)
  local ticks = surface.ticks_per_day or 25200
  local seconds = ticks / 60
  local steps, duty, night = 240, 0, 0
  for i = 0, steps - 1 do
    local v = sun(i / steps)
    duty = duty + v / steps
    if v < 1e-9 then night = night + seconds / steps end
  end
  return {
    seconds_per_day = seconds, ticks_per_day = ticks,
    duty = duty, night_seconds = night, phases = phases,
    model = "piecewise_linear_from_daytime_parameters",
    -- Checked against a measured day rather than trusted, and it agrees on the integral only:
    -- the ramps are not exactly linear (off by up to 0.2 at a
    -- point during dusk), but sizing integrates, and that agrees to 0.7%.
    calibration = { measured_duty = 0.7049, model_duty = 0.7, source = "dev/sun_measure.js on nauvis, 2026-09-20" },
  }
end

-- One simulated day. Everything is kW and kJ (kW * s = kJ), so the units cannot drift.
local function simulate_day(o, dt, steps, start_soc)
  local sun = o.sun
  local buffer = o.accumulators * o.acc_kj_each
  -- the array charges at the per-unit limit TIMES the number of units; charging a bank of
  -- seven through one unit's 300 kW inflow made the search buy storage it did not need
  local charge_limit = o.accumulators * o.accs_in_kw * dt
  local soc = start_soc or 0
  local brownout_s, surplus_kj, deficit_kj = 0, 0, 0
  local min_soc = soc

  for i = 0, steps - 1 do
    local gen = o.panels * o.gen_kw * (o.day_only and sun(i / steps) or 1)
    local want = o.demand_kw
    local direct = math.min(gen, want)
    local gap = want - direct
    local wasted = gen - direct

    if gap > 1e-9 then
      -- the buffer is power-limited as well as energy-limited
      local out = math.min(gap, o.accumulators * o.acc_out_kw)
      local need = out * dt
      if need <= soc + 1e-9 then
        soc = soc - need
        gap = gap - out
      else
        gap = gap - (soc / dt)
        soc = 0
      end
      if gap > 1e-9 then brownout_s = brownout_s + dt end
    end

    if wasted > 1e-9 and o.accumulators > 0 then
      local in_limit = math.min(wasted * dt, charge_limit, buffer - soc)
      if in_limit > 0 then
        soc = soc + in_limit
        wasted = wasted - in_limit / dt
      end
    end
    if soc < min_soc then min_soc = soc end
    surplus_kj = surplus_kj + math.max(0, wasted) * dt
    deficit_kj = deficit_kj + math.max(0, gap) * dt
  end

  local gen_kj = 0
  for i = 0, steps - 1 do
    gen_kj = gen_kj + o.panels * o.gen_kw * (o.day_only and sun(i / steps) or 1) * dt
  end
  return {
    ok = brownout_s <= 1e-6,
    brownout_seconds = brownout_s, spill_kj = surplus_kj, unmet_kj = deficit_kj,
    generation_kj = gen_kj, demand_kj = o.demand_kw * o.day_seconds,
    end_soc = soc, min_soc = min_soc,
  }
end

-- Judge the LAST of several days, not the first. A grid that barely balances spends the
-- first cycle refilling an empty buffer and would be rejected for a cold start it never
-- sees again; the steady-state day is the question that actually matters -- can this run
-- indefinitely.
local function simulate(o)
  local steps = o.steps or 240
  local dt = o.day_seconds / steps
  local days = o.days or 3
  local soc = 0
  local r
  for _ = 1, days do
    r = simulate_day(o, dt, steps, soc)
    soc = r.end_soc
  end
  r.settled_day = days
  return r
end

-- What to add. `have` is what the grid already carries; the answer is the extra.
function P.size(input)
  local day = input.day
  if not day then return { code = "NO_SURFACE" } end
  local gen_kw, acc_kj, acc_out, acc_in = input.gen_kw, input.acc_kj, input.acc_out_kw, input.acc_in_kw
  if not gen_kw or gen_kw <= 0 then return { code = "NO_GENERATOR", generator = input.generator } end

  local o = {
    demand_kw = input.demand_kw,
    gen_kw = gen_kw,
    day_only = input.day_only and true or false,
    sun = input.sun,
    day_seconds = day.seconds_per_day,
    acc_kj_each = acc_kj or 0,
    acc_out_kw = acc_out or 0,
    accs_in_kw = acc_in or 0,
  }
  local have_panels = input.have_panels or 0
  local have_accs = input.have_accumulators or 0

  -- Panels first, from the energy-balance floor upward; for each, the smallest buffer that
  -- survives. Searching storage before generation would happily "solve" a night deficit with
  -- hundreds of accumulators charging from panels that were never big enough to fill them.
  local floor = math.ceil((o.demand_kw - have_panels * gen_kw) / math.max(gen_kw * (day.duty or 1), 1e-6))
  if floor < 0 then floor = 0 end
  local best, tried, trail = nil, 0, {}
  for extra = floor, floor + (input.max_panels or 60) do
    o.panels = extra
    local lo, hi = 0, (input.max_accumulators or 400)
    local found = nil
    while lo <= hi do
      local mid = math.floor((lo + hi) / 2)
      o.accumulators = mid + have_accs
      tried = tried + 1
      if simulate(o).ok then found, hi = mid, mid - 1 else lo = mid + 1 end
    end
    -- the whole trade-off curve, not just the winner: "9 panels needs 40 accumulators,
    -- 11 needs 7" is the part a designer wants to argue with, and without it a choice that
    -- minimises panels looks like an arbitrary one
    local entry = { panels = extra + have_panels }
    -- `found and nil or x` is x for ANY truthy found -- `and nil` collapses, so the "no
    -- brownout" case reported a brownout figure taken from a different trial.
    if found then
      entry.accumulators = found + have_accs
      entry.feasible = true
    else
      o.accumulators = (input.max_accumulators or 400) + have_accs
      entry.feasible = false
      entry.brownout_seconds = simulate(o).brownout_seconds
    end
    trail[#trail + 1] = entry
    if found then
      o.panels, o.accumulators = extra + have_panels, found + have_accs
      local r = simulate(o)
      -- keep the FIRST feasible point; the loop carries on past it only to show the rest of
      -- the trade-off curve, and overwriting this would quietly pick the dearest option
      if not best then
      best = {
        search = trail,
        panels_extra = extra, panels_total = o.panels,
        accumulators_extra = found, accumulators_total = o.accumulators,
        brownout_seconds = r.brownout_seconds,
        daily_generation_mj = r.generation_kj / 1000,
        daily_demand_mj = r.demand_kj / 1000,
        spill_mj = r.spill_kj / 1000,
        storage_mj = o.accumulators * (acc_kj or 0) / 1000,
      }
      end
      if #trail >= (input.search_depth or 3) then break end
    end
  end

  if not best then
    return {
      ok = false, code = "NOT_SUSTAINABLE_BY_THIS_PAIR",
      tried = tried, demand_kw = o.demand_kw, search = trail,
      note = "no panel/accumulator count in the search window survives a day; this load needs "
        .. "a dispatchable generator, not more sun",
    }
  end
  best.ok = true
  best.demand_kw = o.demand_kw
  best.night_seconds = day.night_seconds
  best.duty = day.duty
  return best
end

return P
