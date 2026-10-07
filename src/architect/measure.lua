-- Measured machine rates, as opposed to what `solve` reads out of recipe data.
--
-- This lives apart from control.lua because a measurement is a job with a lifetime: it places
-- entities, runs for hundreds of ticks under the nth-tick driver, and has to take itself apart
-- whether or not it succeeded. Nothing else in the mod has that shape. The rigs cannot reach
-- into control.lua's locals, so the leaf helpers they share live in host.lua.

local host = require("host")
local roles = require("roles")
local fail = host.fail
local fail_key = host.fail_key
local field = host.field
local kw_of = host.kw_of
local resolve_surface = host.resolve_surface
local surface_or_default = host.surface_or_default
local tank_capacity = host.tank_capacity
local fluid_in_tank = host.fluid_in_tank

local measure = {}

-- ------------------------------------------------------------------ mining rates ----
-- `mining_time` is not on the runtime resource prototype (nor is `mining_products`), so a
-- drill's output cannot be computed from data the way a crafting machine's can. It CAN be
-- measured exactly, though: a basic-ore tile holds exactly one unit, so the tiles the drill
-- removes are the items it produced. That turns the solver's last `estimated` number into a
-- measurement -- and keeps the assumption visible when no patch of that ore exists.

-- Defined below with the rest of the runner, but the request handler has to be able to harvest
-- a job whose clock has already run out.
local finish_drill_job, step_drill_job, find_rig_entity
-- And the same for the one rule about running two rigs at once, which the farm section writes out
-- because that is where the list of rigs lives.
local busy_refusal
-- The inserter rig's four, for the same reason: the request handler harvests an expired window and the
-- placement pass is called from inside the start.
local step_arm_job, finish_arm_job, arm_place, arm_reap

-- ------------------------------------------------------------------ the bench, and its ore ----
--
-- control.lua owns surface creation, so it hands this file a door rather than the module reaching
-- back into the file that requires it: `measure.rig_bench = function() return rig_surface() end`,
-- set once when control finishes loading.
measure.rig_bench = nil

-- Both rigs used to default to `game.surfaces[1]` -- the map somebody is playing on -- and a drill
-- placed there takes ore out of that world permanently. Nothing guarded it either: with no client
-- connected, nothing refused the measurement, and it finished in seconds while quietly eating a
-- patch. On this save's nauvis that is 1730 iron-ore tiles the player may have wanted. So an
-- UNNAMED surface now means the bench, and the bench is given its own ore for the occasion; naming a
-- surface still measures that surface, because that is what naming it means.
local PATCH_SPAN = 11              -- the vein itself: 121 tiles, where PATCH_TOO_SMALL wants 25 in a 13x13 window
local PATCH_GROUND = 35            -- the cleared, painted ground under it -- see below for why the
                                   -- vein cannot simply fill its own square
-- One square, reused, at a corner of the bench that is already generated. A plot per resource was
-- the first design and it does not survive contact with the engine: chunks beyond about tile 160 on
-- a created surface are not generated, and `request_to_generate_chunks` there left RCON stalling for
-- half a minute and the ground never arriving -- so every second resource refused with GENERATING.
-- A shared square costs nothing, because one rig at a time is already the rule (`MEASUREMENT_BUSY`
-- is what the two rigs call each other), and the square is wiped and re-laid for whatever vein is
-- being measured. That also settles purity: no other resource's tiles are ever in the window.
local PATCH_ORIGIN = { x = 124, y = 124 }
local PATCH_FALLBACK = { ["basic-fluid"] = 2000, ["default"] = 150 }

-- How much a tile of this ore actually holds IN THIS SAVE, read off the ground the game generated.
--
-- The amount matters more than it looks: a burner drill on tiles holding 5000 produced one item in
-- thirty seconds where the same drill on this save's natural iron-ore (107 to 295 per tile) produced
-- seven. A generous patch is therefore not a safe patch, it is a different patch, and a bench whose
-- numbers cannot be compared with the map's is not a bench. So the vein is laid at the mean of what
-- real tiles of this resource hold, and the bench surfaces are skipped so a vein laid last time does
-- not set its own baseline.
local BENCH_NAMES = { ["arch-lab"] = true, ["arch-sandbox"] = true }

-- Two boxes, because one is not enough: an extractor drops what it mines one tile outside the box it
-- works, and the rig's belt search needs free GROUND under and around that tile. A vein filling its
-- whole square puts ore -- then deep water, outside the painted ground -- exactly there, which is how
-- the first version of this answered NO_ROOM_FOR_BELT for a patch it had just laid.
local PATCH = {
  ground = { x1 = PATCH_ORIGIN.x, y1 = PATCH_ORIGIN.y,
             x2 = PATCH_ORIGIN.x + PATCH_GROUND - 1, y2 = PATCH_ORIGIN.y + PATCH_GROUND - 1 },
  vein = { x1 = PATCH_ORIGIN.x + math.floor((PATCH_GROUND - PATCH_SPAN) / 2),
           y1 = PATCH_ORIGIN.y + math.floor((PATCH_GROUND - PATCH_SPAN) / 2),
           x2 = PATCH_ORIGIN.x + math.floor((PATCH_GROUND - PATCH_SPAN) / 2) + PATCH_SPAN - 1,
           y2 = PATCH_ORIGIN.y + math.floor((PATCH_GROUND - PATCH_SPAN) / 2) + PATCH_SPAN - 1 },
}

-- Which ground a rig is about to spend, decided in ONE place because both rigs had been drifting
-- apart on exactly this: an unnamed surface is the bench with a laid vein, a named surface is that
-- surface and its own ore, and a bench that is still being created is a "call again", not a
-- substitution.
local function rig_ground(args, resource)
  if args.surface ~= nil then
    local asked = surface_or_default(args.surface)
    if not asked then return nil, fail("NO_SURFACE", tostring(args.surface)) end
    return { surface = asked, named = true }
  end
  if not measure.rig_bench then
    -- Not a silent fallback to the player's map: a build where the door was never wired up would
    -- otherwise eat someone's ore patch while reporting a clean measurement.
    return nil, fail_key("BENCH_UNAVAILABLE", "m-bench-not-wired", nil,
      "this build has no measurement bench wired up; pass surface = <a surface you mean>")
  end
  local bench, pad, why = measure.rig_bench()
  if not bench then
    return nil, fail("SANDBOX_" .. tostring(why or "UNAVAILABLE"),
      why == "GENERATING" and "the measurement bench is still generating; call again"
        or "the measurement bench could not be prepared", { reason = why })
  end
  -- Deliberately NOT `ensure_patch` here. Deciding which ground a rig will use happens before the
  -- busy checks, so a caller polling a job already in flight reaches this line on every press -- and
  -- laying a vein means wiping the square, which destroys the very drill that job is measuring. That
  -- is how a bench window came to report one item on the belt and no drill at the end. The square is
  -- prepared at the placement site instead, once the rig has committed to running.
  return { surface = bench, named = false, bench = true, pad = pad }
end

-- The runner's crash text, handed back to the request it belongs to. It used to be stored against the RIG
-- with no key at all, so whichever call came in next -- about another machine, another ore, another tier,
-- another seed -- was refused with somebody else's death, and the cached figure it should have answered
-- with went unread. `<rig>_dead` beside it has always carried the job key; this is the same rule applied
-- to the other half of the same record. A text nobody asks for stays where it is until the job that raised
-- it comes back, or until the next raise overwrites it.
local function take_rig_error(name, key)
  local held = storage and storage[name]
  if type(held) == "string" then
    -- Written by an older build, which means the job it died for is no longer knowable. Dropping it is
    -- the honest half: pinning an unattributable crash on whoever asks next is the bug this replaces.
    storage[name] = nil
    return nil
  end
  if type(held) ~= "table" or not held.msg then return nil end
  if held.job ~= key then return nil end
  storage[name] = nil
  return held.msg
end

-- `find_entities_filtered` reads a nil filter value as "no filter" and hands back the whole
-- surface. Feeding it a missing unit_number once enumerated every entity on nauvis and
-- destroyed them, so a rig lookup refuses to widen when the number never arrives, and falls
-- back to a bounded scan that can only name what the rig itself was made of.
find_rig_entity = function(surface, unit, name, pos)
  -- `unit_number` is not a filter key: passing it to find_entities_filtered is the same as asking
  -- for "anything on this surface", which is how one cleanup pass once destroyed every entity on
  -- nauvis. So candidates come from a bounded area plus the exact name, and the unit number is
  -- compared here. With no position to bound the search there is nothing to look up, and this
  -- says so instead of widening.
  if type(pos) ~= "table" or type(name) ~= "string" then return nil end
  local half = 3
  for _, e in ipairs(surface.find_entities_filtered { name = name,
      area = { { pos.x - half, pos.y - half }, { pos.x + half, pos.y + half } } }) do
    if e.valid and (type(unit) ~= "number" or e.unit_number == unit) then return e end
  end
  return nil
end

local function rig_entities(j)
  local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
  if not surface then return nil end
  local out = { drill = find_rig_entity(surface, j.drill_unit, j.machine, j.drill_pos), belts = {} }
  for i, unit in ipairs(j.belt_units or {}) do
    local pos = j.belt_pos and { x = j.belt_pos.x + j.step[1] * (i - 1), y = j.belt_pos.y + j.step[2] * (i - 1) }
    local b = find_rig_entity(surface, unit, j.belt, pos)
    if b then out.belts[#out.belts + 1] = b end
  end
  return out, surface
end

-- The rig is part of the measurement, so every way out of a job has to take it back. A job that
-- dies with its drill standing leaves a hole in the patch that the next run reads as a smaller
-- patch, and a belt line still holding the answer nobody reads.
local function reap_rig(j)
  local ents, surface = rig_entities(j)
  if not ents then return false end
  if ents.drill and ents.drill.valid then ents.drill.destroy() end
  for _, b in ipairs(ents.belts) do if b.valid then b.destroy() end end
  if j.gen_spec then
    local g = find_rig_entity(surface, j.gen_spec.unit, j.gen_spec.name, j.gen_spec.pos)
    if g and g.valid then g.destroy() end
  end
  for _, spec in ipairs(j.supply_specs or {}) do
    local e = find_rig_entity(surface, spec.unit, spec.name, spec.pos)
    if e and e.valid then e.destroy() end
  end
  return true
end

-- The pump rig is a list of parts rather than two named roles, so one guarded lookup covers pump,
-- pipe and tank instead of repeating the nil-filter rule three times.
local function reap_parts(j)
  local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
  if not surface then return false end
  for _, spec in ipairs(j.parts or {}) do
    local e = find_rig_entity(surface, spec.unit, spec.name, spec.pos)
    if e and e.valid then e.destroy() end
  end
  for _, spec in ipairs(j.ring_specs or {}) do
    local e = find_rig_entity(surface, spec.unit, spec.name, spec.pos)
    if e and e.valid then e.destroy() end
  end
  local tank = find_rig_entity(surface, j.tank_unit, "storage-tank", j.tank_pos)
  if tank and tank.valid then tank.destroy() end
  return true
end

-- ------------------------------------------------------------------ pumping rates ----
-- A pumpjack's yield is not in the data: the runtime prototype carries no `pumping_speed` for it,
-- and a fluid resource entity does not name the fluid it gives up. What a field produces, and how
-- fast, can only be read off a pump that is actually running on it -- which settles the naming
-- question at the same time, because the fluid arrives in the tank under its own name.
--
-- The tank is emptied as it fills rather than read once at the end: a storage tank holds a fixed
-- capacity, and once it is full the number being measured is the capacity, not the flow.
-- How long a rig gets to prove it drains before a window is opened: three game seconds is
-- several times the pumpjack's own buffer-filling time, so a rig that has not moved fluid by
-- then is connected wrong rather than slow.
local PROVE_TICKS = 180
local finish_pump_job, step_pump_job, fail_pump_job

local function status_name(e)
  if not e or not e.valid then return nil end
  for k, v in pairs(defines.entity_status) do
    if v == e.status then return k end
  end
  return nil
end

-- Read whatever the tank holds, remember it against its fluid name, and empty the tank so the
-- next tick can fill it again. Temperatures come along because hot and cold water are different
-- products to a refinery even though the name is the same.
-- Accumulate whatever the tank gained since the last read. The tank is deliberately NOT emptied: a
-- storage tank connected to a pump is drained through its own output box, so emptying it from
-- script fights the network and under-counts (which is exactly what an earlier version of this
-- function did). Whatever is left standing at the end is reported as `residue_left` rather than
-- silently dropped.

-- ------------------------------------------------------------------ inserter rates ----
--
-- The one part of a lane whose throughput is not a field and not arithmetic. A belt's rate is a formula
-- the user signed off on (`speed * 8 * 60` items a second, four tiers), a machine's is in its recipe --
-- and an arm's is nothing at all: measured on this install, `inserter`, `long-handed-inserter`,
-- `fast-inserter`, `stack-inserter` and `bulk-inserter` answer NOTHING for `rotation_speed`,
-- `extension_speed`, `inserter_length`, `stack_size` or `energy_usage`. Every name raises. So the swing
-- that decides whether a lane's output can leave as fast as it is made is knowable only by watching one
-- swing, which is what this rig does.
--
-- Every placeable tier is measured in the SAME window, side by side in its own column, because the
-- question a lane asks is comparative -- "can the arm on this row carry 18.75 a minute?" -- and one job
-- per tier would raise and lower the world clock once per tier for no reason. Per column: a belt tile
-- the rig feeds every tick, the arm one tile south of it facing south, and a chest one tile further
-- south. The belt is the source rather than a second container because it is the thing a lane actually
-- does (lift off a belt), and because feeding it is exact: whatever the belt still holds at the end of
-- a tick is supply the arm did not need, which is how `starved_ticks` can be a real count instead of a
-- hope.
--
-- The chest is drained every tick for the same reason the drill's belts are: an inserter whose
-- destination is full stops, and the window would then measure the container. `swings_per_min` comes
-- from the ticks on which something actually arrived, so a stack inserter's thirteen-at-a-time shows up
-- as a bigger items-per-swing rather than as a faster arm.
--
-- Arms need no power (measured: they are not electric), so this rig lays no grid and no
-- `electric-energy-interface` -- which also means nothing here can change what a power question on the
-- bench answers afterwards.

-- How far apart to stand the source and destination from the arm, in tiles. Reach is not a readable
-- field on an inserter (`inserter_length` raises), so the rig starts at the shortest and, for a tier
-- that swung zero times and said `waiting_for_source_items`, moves the chests out to where that arm was
-- looking -- which is how a long-handed arm is measured at its own reach without this file having to
-- know the number in advance.
local ARM_REACHES = { 1, 2 }
local ARM_PROVE_TICKS = 240       -- one game's-minute-ish: enough for three swings at any tier

-- Inserters are electric in 2.0. Measured the hard way: an arm standing between a chest of 200 plates
-- and an empty one reads `no_power` and never swings -- which is also why a lane built in a world
-- without wires moves nothing, and why this rig cannot measure an arm on an unpowered surface by
-- accident. `create_global_electric_network` is the only way to feed every column without a line of
-- poles, and it merges every consumer on the surface into one network, so it happens on the lab bench
-- (whose power questions nobody asks -- `card_verify` plans against it) and only on an explicit
-- `global_grid` anywhere else, which is the same rule the drill and pump rigs run by.
local function bench_grid(j, surface, force_name, at)
  local attempts = {}
  -- Only ever on the bench this mod prepared. Merging a surface's consumers cannot be undone, and
  -- `arch-sandbox` is the surface a coverage question is planned against, so a named surface keeps its
  -- own networks unless the caller asks for the merge by name (the same bargain as the drill rig's
  -- `global_grid`).
  local merged = false
  if j.bench then
    merged = pcall(function() surface.create_global_electric_network() end)
    attempts[#attempts + 1] = { tried = "global grid", placed = merged }
  else
    attempts[#attempts + 1] = { tried = "global grid",
      placed = false, why = "declined on a surface the caller named; pass global_grid = true to merge it" }
  end
  local gen
  for _, o in ipairs({ 4, 6, 8, 10 }) do
    local pos = { x = at.x, y = at.y + o }
    if surface.can_place_entity { name = "electric-energy-interface", position = pos, force = force_name } then
      gen = surface.create_entity { name = "electric-energy-interface", position = pos, force = force_name }
      if gen then break end
    end
  end
  attempts[#attempts + 1] = { tried = "electric-energy-interface", placed = gen ~= nil }
  j.power_attempts = attempts
  return gen and { unit = gen.unit_number, name = "electric-energy-interface", pos = gen.position } or nil
end

local function arm_surface(j)
  return game.surfaces[j.surface] or game.surfaces[j.surface_name]
end

-- The three entities of one column: a source chest, the arm one tile south of it, and the destination
-- chest one further south. The arm FACES NORTH, which is the side it picks from -- measured the plain
-- way, two identical columns facing opposite ways: the north-facing one read `working` and moved items
-- source→destination, the south-facing one read `waiting_for_source_items` while staring at the empty
-- chest behind it. (An earlier draft of this rig assumed the facing was the drop side, which is the
-- belt convention, and every tier reported `NOTHING_CARRIED`.)
--
-- The source is a chest rather than a belt because a belt cannot be fed from script --
-- `LuaTransportLine` has no `insert`, `add_item` or `can_insert` (all three raise on this install), and
-- an arm that starves measures as a slow arm. What an arm does to a container's contents is the same
-- lift it does to a belt's; the difference is that only one of the two can be kept full on purpose.
local function arm_parts(surface, j, t)
  local col = j.cols[t]
  local bx, by = j.origin.x + t, j.origin.y
  local s = col.spacing or 1
  local src = find_rig_entity(surface, col.src, j.chest, { x = bx, y = by })
  local arm = find_rig_entity(surface, col.arm, col.arm_name, { x = bx, y = by + s })
  local dst = find_rig_entity(surface, col.dst, j.chest, { x = bx, y = by + 2 * s })
  return src, arm, dst
end

-- Build one column at a given arm-to-chest spacing. Used twice per tier at most: once at the start, and
-- once more with the chests further out when the arm reported that it is looking past the tile it was
-- given. The old parts are taken back first, so a re-lay cannot leave a second chest standing.
local function arm_column(j, surface, t, spacing)
  local col = j.cols[t]
  if col.src or col.arm or col.dst then
    local src, arm, dst = arm_parts(surface, j, t)
    for _, e in ipairs({ src, arm, dst }) do
      if e and e.valid then pcall(function() e.destroy() end) end
    end
  end
  local bx, by = j.origin.x + t, j.origin.y
  local src = surface.create_entity { name = j.chest, position = { x = bx, y = by }, force = j.force }
  local arm = src and surface.create_entity { name = col.arm_name, position = { x = bx, y = by + spacing },
    force = j.force, direction = defines.direction.north }
  local dst = arm and surface.create_entity { name = j.chest, position = { x = bx, y = by + 2 * spacing },
    force = j.force }
  if not (src and arm and dst) then
    for _, e in ipairs({ src, arm, dst }) do
      if e and e.valid then pcall(function() e.destroy() end) end
    end
    col.src, col.arm, col.dst = nil, nil, nil
    return false
  end
  col.src, col.arm, col.dst = src.unit_number, arm.unit_number, dst.unit_number
  col.spacing = spacing
  -- A burner arm is not electric and runs on fuel instead; the drill rig learned that the same way. It
  -- is measured with the others because a lane on a world without power uses exactly this tier, and
  -- "it moved nothing" would be a lie about fuel rather than a fact about the arm.
  local fuel = arm.get_inventory(defines.inventory.fuel)
  col.fuelled = fuel and (fuel.insert { name = "coal", count = 50 } > 0) or nil
  return true
end

local function arm_ground_clear(surface)
  local box = PATCH.ground
  for _, e in ipairs(surface.find_entities_filtered {
      area = { { box.x1, box.y1 }, { box.x2, box.y2 } } }) do
    if e.type ~= "character" and e.type ~= "resource" then pcall(function() e.destroy() end) end
  end
end

function measure.arm_rate(args)
  args = args or {}
  storage = storage or {}
  storage.arms = storage.arms or {}
  local item = args.item or "iron-plate"
  if not prototypes.item[item] then
    return fail("NO_SUCH_ITEM", "this save has no item called " .. tostring(item), { asked_for = item })
  end
  local seconds = args.seconds or 20
  local speed, warp_refused = host.clock_policy(args.speed or 20)
  if warp_refused then return warp_refused end
  local busy = busy_refusal("arm_job")
  if busy then return busy end
  local ground, ground_refused = rig_ground(args, nil)
  if ground_refused then return ground_refused end
  local asked = ground.surface
  -- This rig lays its plot at one fixed coordinate and clears whatever stands there FIRST (the farm half
  -- also repaints the tiles and never puts them back). On the bench that is the point; on a surface
  -- somebody named it is vandalism reported as a clean measurement. The drill and pump rigs honour
  -- `surface` by finding ground on it instead -- these two cannot, so they refuse rather than relocate.
  if ground.named then
    return fail("RIG_NEEDS_BENCH", "this rig builds on the measurement bench only: it lays a fixed plot and"
      .. " clears it first, which on a surface you named would destroy what stands there. Leave `surface`"
      .. " unset to use the bench", { asked_for = asked.name })
  end
  -- The filter is part of the key. A run that measured one tier and filed it under the all-tiers key
  -- would replace the full record with a one-row one, and the next caller would be handed a library
  -- with a row missing and no idea it was ever there.
  local key = "arms|" .. item .. (args.arm and ("|" .. args.arm) or "")

  if storage.arm_job and storage.arm_job.deadline <= game.tick then
    local ok, err = pcall(step_arm_job)
    if not ok then storage.arm_error = host.errtext(err) end
  end
  local j = storage.arm_job
  -- `busy_refusal` above asks about the OTHER rigs; this asks about the rig itself. A second window
  -- opened while one is running -- same rig, different ore, different tier, different seed -- used to sail
  -- past both guards, because the running check matched on `key` and the new job record then replaced the
  -- old one: the first rig's entities stayed standing on the ground unharvested, and this job's `prev_speed`
  -- read the clock the previous job had already raised, so "restoring" it left the world running fast for
  -- good. `line_watch` has had this guard all along.
  if j and j.state == "running" and j.key ~= key then
    return fail_key("MEASUREMENT_BUSY", "m-busy-arm", nil, "an inserter measurement is running; one rig at a time",
      { running = j.key, asked = key })
  end
  if j and j.key == key and j.state == "running" then
    return { state = "running", item = item, tiers = #j.cols,
             seconds_left = (j.deadline - game.tick) / 60 }
  end
  local crashed = take_rig_error("arm_error", key)
  if crashed then
    return fail("MEASUREMENT_ERRORED", "the tick runner raised: " .. crashed, { arm_error = crashed })
  end
  local cached = storage.arms[key]
  if cached and cached.surface ~= asked.name then cached = nil end
  if args.refresh ~= true and cached then
    cached.cached = true
    return cached
  end
  local force_name = args.force or "player"
  local force = game.forces[force_name]
  if not force then return fail("NO_FORCE", force_name) end

  -- Every tier this install can place, in name order, capped at what fits across the plot. A caller
  -- that names one measures just that one -- `card_example`'s hardware row lets a player point at a
  -- tier, and the number they get back should be that tier's.
  local arms = {}
  for _, c in ipairs(roles.candidates("arm", { available = nil }) or {}) do
    if not args.arm or c.name == args.arm then arms[#arms + 1] = c.name end
  end
  local fits = PATCH.ground.x2 - PATCH.ground.x1 - 2
  if #arms > fits then arms = (function() local l = {} for i = 1, fits do l[i] = arms[i] end return l end)() end
  if #arms == 0 then
    return fail("NO_ARM_TO_MEASURE", "no placeable inserter on this install"
      .. (args.arm and (" (asked for " .. tostring(args.arm) .. ")") or ""), { asked_for = args.arm })
  end
  local chest = args.chest or roles.pick("chest", { prefer = "iron-chest" })
  if not chest then
    return fail("NO_CHEST_TO_MEASURE", "no placeable container to drop into", { asked_for = args.chest })
  end

  arm_ground_clear(asked)
  local job = {
    key = key, item = item, chest = chest, force = force_name,
    surface = asked.index, surface_name = asked.name, bench = ground.bench or nil,
    origin = { x = PATCH.ground.x1 + 1, y = PATCH.ground.y1 + 1 }, cols = {},
    started = game.tick, deadline = game.tick + seconds * 60,
    prove_at = game.tick + ARM_PROVE_TICKS, clock_speed = speed,
    prev_speed = game.speed, prev_paused = game.tick_paused, state = "running", seconds = seconds,
  }
  for i, name in ipairs(arms) do job.cols[i] = { arm_name = name, taken = 0, swings = 0, starved = 0 } end
  if not arm_place(job, asked) then
    return fail("NO_ROOM_FOR_ARMS", "the bench's own square refused the rig's columns",
      { columns = #job.cols, origin = job.origin, surface = asked.name })
  end
  storage.arm_job = job
  host.clock_raise(speed, true)
  return { state = "running", item = item, arms = arms, chest = chest,
           seconds = seconds, clock = host.clock_note(speed, seconds),
           note = "every tier swings side by side in one window; call again for the figures" }
end

-- Lay each column and keep what was laid. A tier whose arm would not fit is dropped from the job and
-- named in the record, rather than measured as an arm that moved nothing -- those are different facts
-- and only one of them is about the arm.
-- 这台 rig 自己刷自己那一方地。以前不用：钻头/农场那两台 rig 会在同一个角落铺草地，谁先跑谁铺。
-- 它们被删掉之后这个角就是 out-of-map —— can_place_entity 一律 false，于是发电机放不下去、电臂全量成
-- 0/min，而 burner 臂照样能跑（它不吃电），读数看起来像"臂变慢了"而不像"地没了"。量出来的那一条。
local function arm_ground_paint(surface)
  local g = PATCH.ground
  local tiles = {}
  for x = g.x1 - 2, g.x2 + 2 do
    for y = g.y1 - 2, g.y2 + 14 do
      local ok, t = pcall(function() return surface.get_tile(x, y) end)
      if not ok or not t or t.name == "out-of-map" or t.name == "water-deep" then
        tiles[#tiles + 1] = { name = "grass-1", position = { x = x, y = y }, tile_index = 1 }
      end
    end
  end
  if #tiles == 0 then return 0 end
  pcall(function() surface.set_tiles(tiles) end)
  return #tiles
end

arm_place = function(j, surface)
  j.painted = arm_ground_paint(surface)
  local laid = 0
  j.gen_spec = bench_grid(j, surface, j.force, j.origin)
  for t = 1, #j.cols do
    if arm_column(j, surface, t, ARM_REACHES[1]) then
      laid = laid + 1
    else
      j.cols[t].refused = true
    end
  end
  return laid > 0, laid
end

local function arm_step(j)
  local surface = arm_surface(j)
  if not surface then return end
  local moving = 0
  for t, col in ipairs(j.cols) do
    if col.src and not col.refused then
      local src, arm, dst = arm_parts(surface, j, t)
      if src and arm and dst then
        moving = moving + 1
        local from = src.get_inventory(defines.inventory.chest)
        local to = dst.get_inventory(defines.inventory.chest)
        if from and to then
          -- Feed the source, then empty the destination. `starved` counts the ticks where even feeding
          -- left the source tile empty, which is the difference between a slow arm and an unfed one.
          from.insert { name = j.item, count = 40 }
          if from.get_item_count(j.item) == 0 then col.starved = col.starved + 1 end
          local got = to.remove { name = j.item, count = 100000 } or 0
          if got > 0 then
            col.taken = col.taken + got
            col.swings = col.swings + 1
            if not col.first_tick then col.first_tick = game.tick end
            col.last_tick = game.tick
          end
        else
          col.no_inventory = (col.no_inventory or 0) + 1
        end
        -- The engine's own word for what the arm is doing, kept per tick so a window that measured
        -- nothing can say why it thinks so (`no_power` and `waiting_for_source_items` are different
        -- failures from `not_connected`-style ones, and all three have shown up here while the rig was
        -- being pointed the right way).
        col.last_status = status_name(arm) or tostring(arm.status)
      else
        col.gone = (col.gone or 0) + 1
      end
    end
  end
  if moving == 0 then j.all_gone = (j.all_gone or 0) + 1 end

  -- The prove pass, once: a tier that has moved nothing and says it is waiting for source items is
  -- looking past the tile it was given, so its chests go one step further out. Reach is not a readable
  -- field on an inserter, so this is the rig finding the arm's reach by asking the arm -- the same move
  -- the farm rig makes with soil -- and the re-lay restarts the window for EVERY tier rather than
  -- counting a partly stalled group in one average.
  if game.tick >= j.prove_at and not j.proved then
    j.proved = true
    local relayed = 0
    for t, col in ipairs(j.cols) do
      local further = (col.spacing or 1) + 1
      if col.src and not col.refused and col.taken == 0
        and col.last_status == "waiting_for_source_items"
        and further <= ARM_REACHES[#ARM_REACHES] and arm_column(j, surface, t, further) then
        col.moved = further
        relayed = relayed + 1
      end
    end
    if relayed > 0 then
      for _, col in ipairs(j.cols) do
        col.taken, col.swings, col.starved = 0, 0, 0
        col.first_tick, col.last_tick = nil, nil
      end
      j.started = game.tick
      j.deadline = game.tick + j.seconds * 60
      j.relayed = relayed
    end
  end
  if game.tick >= j.deadline then finish_arm_job() end
end

function step_arm_job()
  local j = storage.arm_job
  if not j or j.state ~= "running" then return end
  arm_step(j)
end

function finish_arm_job()
  local j = storage.arm_job
  if not j or j.state ~= "running" then return end
  local surface = arm_surface(j)
  local elapsed = ((math.min(j.deadline, game.tick)) - j.started) / 60
  local tiers, best = {}, nil
  if surface then
    for t, col in ipairs(j.cols) do
      if col.dst then
        local _, _, dst = arm_parts(surface, j, t)
        if dst and dst.valid then
          local inv = dst.get_inventory(defines.inventory.chest)
          local more = inv and inv.remove { name = j.item, count = 100000 } or 0
          col.taken = col.taken + more
        end
      end
      local per_min = elapsed > 0 and (col.taken / elapsed * 60) or 0
      local row = {
        arm = col.arm_name, items_per_min = math.floor(per_min * 100 + 0.5) / 100,
        items = col.taken, swings = col.swings,
        swings_per_min = elapsed > 0 and math.floor(col.swings / elapsed * 60 * 100 + 0.5) / 100 or 0,
        items_per_swing = col.swings > 0 and math.floor(col.taken / col.swings * 100 + 0.5) / 100 or nil,
        first_item_after = col.first_tick and (col.first_tick - j.started) / 60 or nil,
        starved_ticks = col.starved, gone_ticks = col.gone,
        -- which geometry this tier was measured at, because the number means nothing without the
        -- distance the chests were standing at
        source_spacing = col.spacing, chests_moved_out = col.moved,
        arm_status = col.last_status, fuelled = col.fuelled, no_inventory_ticks = col.no_inventory,
        error = col.refused and "NO_SITE_FOR_ARM"
          or (col.taken == 0 and (col.last_status == "no_power" and "NOT_POWERED"
            or col.last_status == "waiting_for_source_items" and "WRONG_WAY_ROUND" or "NOTHING_CARRIED"))
          or nil,
        note = col.refused and "the bench would not place this tier's column; nothing was measured about the arm"
          or (col.last_status == "no_power" and "the arm never got power on this surface -- the rig's"
            .. " own source did not reach it, which says nothing about the arm")
          or (col.last_status == "waiting_for_source_items" and "the arm is looking at the empty chest:"
            .. " the facing this rig places is wrong, not the tier")
          or (col.taken == 0 and "it swung zero times in the window, which is the rig's failure, not the arm's" or nil),
      }
      tiers[#tiers + 1] = row
      if not row.error and (not best or row.items_per_min > best.items_per_min) then best = row end
    end
    arm_reap(j, surface)
  end
  storage.arms[j.key] = {
    item = j.item, chest = j.chest, surface = j.surface_name, bench = j.bench,
    clock_speed = j.clock_speed, seconds = j.seconds, elapsed_game_seconds = elapsed,
    tiers = tiers, best = best, measured_tick = game.tick,
    power_attempts = j.power_attempts, relayed = j.relayed,
    -- Said because it is the limit of the claim: this is a lift between two containers, and a lane's
    -- arm usually lifts off a belt or a machine. The swing is the same motion; whether some pairing
    -- costs more than this rig measured is not something this window watched.
    caveat = "arms lifted from a " .. j.chest .. " into another, both fed and emptied every tick so"
      .. " neither container is the figure. A lane's arm lifts off belts and machines instead, and"
      .. " this window did not measure those.",
  }
  storage.arm_dead = nil
  j.state = "done"
  storage.arm_job = nil
  host.clock_lower(j.prev_speed, j.prev_paused)
  return storage.arms[j.key]
end

-- Takes the surface as an argument when the finish pass has it, and looks it up when the tick runner's
-- raise path calls this as a one-argument reap.
function arm_reap(j, surface)
  surface = surface or arm_surface(j)
  if not surface then return false end
  local gone = 0
  for t, col in ipairs(j.cols) do
    if not col.refused then
      local src, arm, dst = arm_parts(surface, j, t)
      for _, e in ipairs({ src, arm, dst }) do
        if e and e.valid then pcall(function() e.destroy() end) gone = gone + 1 end
      end
    end
  end
  -- the ideal source goes back too: it is the rig's, not the world's, and leaving it standing makes
  -- every later power question on this surface answer against a producer nobody placed on purpose
  if j.gen_spec then
    local g = find_rig_entity(surface, j.gen_spec.unit, j.gen_spec.name, j.gen_spec.pos)
    if g and g.valid then pcall(function() g.destroy() end) gone = gone + 1 end
    j.gen_spec = nil
  end
  return true
end

-- ------------------------------------------------------------------ farming rates ----
--
-- What a plant states and what a tower DOES are different questions. `yumako-tree` says
-- `growth_ticks = 18000` and hands back 50 items when harvested, so the number of PLANTS a plan needs
-- is arithmetic. How many tiles one tower works, and what it actually carries per minute, live in the
-- crane's animation geometry: measured on this install, `agricultural-tower` answers `radius`,
-- `growth_area_radius`, `energy_usage` and `heating_energy` and RAISES on
-- `farm_tile_requires_water`, `accepted_seeds`, `input_inventory_size`, `growth_area`,
-- `planting_procedure_points` and `crane` -- there is no field that says how much ground it tills.
--
-- So the tower gets a rig, in the drill's shape: place it, feed it, empty its output every tick, read
-- the clock. The per-tick drain is not fussiness. The tower's own output inventory holds 100 items,
-- and a window that fills it measures the capacity: two rigs polled from outside the game both
-- reported exactly 100 items every window at two different clock speeds, which is the signature of a
-- container rather than a rate (measured; see `dev/farm_probe.js`).
--
-- The rig is two phases because two things had to be found out by asking the ground rather than by
-- naming them:
--   * a tower will not plant on grass at all. It reports `no_spot_seedable_by_inputs` and does nothing
--     until a tile it will till is within reach. Which of this install's tiles those are is not
--     readable either, so phase one paints the whole plot with ONE candidate and asks the tower
--     whether a plant appears, candidate by candidate.
--   * water is not required (measured: a tower whose area was half pond tilled the dry side at the same
--     rate as one with no water at all). A rig that painted a pond and reported a rate would have been
--     reporting the pond.

local FARM_PLOT = PATCH.ground
-- How long one candidate gets to show a plant. A tower with seedable ground plants within a few ticks
-- of being fed; a tower without it says so in its status on the first update.
local FARM_PROVE_TICKS = 240
-- The runner owns these two and the request handler harvests a job whose clock has already run out, so
-- both are declared before either is written -- the same shape the drill rig's forward lines have.
local finish_farm_job, step_farm_job, farm_place_rig

-- Every rig raises `game.speed` and puts back the value it found when it closes, so two running at once
-- leave the world accelerated by whichever finished last -- and a rate published under a clock nobody
-- measured is not a rate. One list of who is on the bench, because the rule has three members now and a
-- fourth rig that gets checked by two of the three entry points is the bug this shape prevents. Each
-- caller passes the key it owns; the refusal names the OTHER job, in the sentence its locale row holds.
measure.RIG_SIBLINGS = {
  { job = "drill_job", msg_key = "m-busy-drill", msg = "a drill measurement is running; one rig at a time" },
  { job = "pump_job", msg_key = "m-busy-pump", msg = "a pump measurement is running; one rig at a time" },
  { job = "farm_job", msg_key = "m-busy-farm", msg = "a farm measurement is running; one rig at a time" },
  { job = "arm_job", msg_key = "m-busy-arm", msg = "an inserter measurement is running; one rig at a time" },
  -- The lab's record is a standing structure rather than a job object, so it says for itself whether it
  -- is actually running; the rigs' records only exist while they do.
  { job = "lab", msg_key = "m-busy-card", msg = "a card measurement is running; one rig at a time",
    running = true },
}
-- Ordered, not `pairs`: when two jobs are somehow both standing, which sentence comes back has to be the
-- same one every time, and a walk over a hand-written list is the only order here that is.
busy_refusal = function(own)
  for _, other in ipairs(measure.RIG_SIBLINGS) do
    if other.job ~= own then
      local held = storage and storage[other.job]
      if held and (not other.running or held.state == "running") then
        return fail_key("MEASUREMENT_BUSY", other.msg_key, nil, other.msg)
      end
    end
  end
  return nil
end

local farm_center = { x = math.floor((FARM_PLOT.x1 + FARM_PLOT.x2) / 2) + 0.5,
                      y = math.floor((FARM_PLOT.y1 + FARM_PLOT.y2) / 2) + 0.5 }

-- The rig on the ground it was just painted with: one tower at the centre of the plot, one ideal
-- source beside it, and the seeds the tower plants with. `supply` is not optional here the way it is
-- for a drill: an unpowered tower reports `no_power` and the window would measure a container that
-- never filled.
farm_place_rig = function(j, surface)
  local tower = surface.create_entity { name = j.machine, position = j.tower_pos, force = j.force }
  if not tower then return nil end
  j.tower_unit = tower.unit_number
  -- The tower is an electric consumer too, and on a surface with no grid it answers `no_power` and
  -- plants nothing -- which an earlier probe of this read as a dead machine rather than an unpowered
  -- one. `bench_grid` is the arm rig's helper, and both rigs need exactly what it does.
  j.gen_spec = bench_grid(j, surface, j.force, j.tower_pos)
  local inv = tower.get_inventory(defines.inventory.agricultural_tower_input)
  -- A fresh tower: its tray starts empty and the seeds counted below start at zero. The rate phase
  -- re-places the rig after the soil probe, and `seeds_supplied` is the window's number -- so the
  -- probe's tray has to be excluded, not added to it (measured: a probe that planted 47 seeds was
  -- silently inflating the window's draw by 47 before this line reset it).
  j.seeds_in = 0
  j.tray = inv and inv.get_item_count(j.seed) or 0
  j.seeds_in = j.seeds_in + (inv and inv.insert { name = j.seed, count = 30 } or 0)
  j.tray_end = j.tray
  return tower
end

local function farm_tower(j)
  local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
  if not surface then return nil, nil end
  return find_rig_entity(surface, j.tower_unit, j.machine, j.tower_pos), surface
end

local function farm_reap(j)
  local tower, surface = farm_tower(j)
  if tower and tower.valid then tower.destroy() end
  if j.gen_spec and surface then
    local g = find_rig_entity(surface, j.gen_spec.unit, j.gen_spec.name, j.gen_spec.pos)
    if g and g.valid then g.destroy() end
  end
  -- The crop goes with the rig. Nothing else on the bench planted it, and a plot of 47 yumako bushes
  -- left standing between runs is a fact about a finished measurement leaking into the next one.
  if surface and j.plant then
    for _, e in ipairs(surface.find_entities_filtered { name = j.plant,
        area = { { FARM_PLOT.x1, FARM_PLOT.y1 }, { FARM_PLOT.x2, FARM_PLOT.y2 } } }) do
      if e.valid then e.destroy() end
    end
  end
  return true
end

-- ============================================================
-- Watching a line the player already built
-- ============================================================
--
--
-- The two rigs above answer "what can one machine do on this ore", which needs a patch to stand on,
-- a machine to place and a world clock fast enough to fill a window. This answers the other question,
-- the one anybody inside a factory actually asks: "what is THIS line doing". Nothing is placed, the
-- clock is never touched and the window runs in real seconds -- so it works on a normal save while
-- people are playing, which is precisely where the rigs cannot go.
--
-- It reads one thing: the contents of every inventory inside the box, twice. That is the whole
-- measurement, and it is a deliberate choice rather than the obvious one. The obvious instrument is
-- the force's own production tally, `get_item_production_statistics`, and it was tried here first and
-- measured to be wrong for this use: a steel furnace smelted 20 iron plates and an earlier assembler
-- ate 120 plates to make 60 gears, and the surface's `iron-plate` output count held at 692 through
-- both, on any surface as well as this one. It is also a (force, surface) total, so a box of four
-- furnaces would report the whole base. A number that is neither right nor scoped to the thing
-- pointed at is worse than no number, so the tally is not read.
--
-- What two censuses of one box CAN say is exactly what they can see, and the record names which of
-- its two observations it made: items that appeared in a machine's output slot or a container in the
-- box (gained), and items that vanished from a machine's input (spent). A line whose product rides a
-- belt out of the box reads spent-and-not-gained, which is a true sentence about the box rather than
-- a zero pretending to be a rate.

-- One inventory id per role. `furnace_result`, `crafter_output` and `assembling_machine_output` are
-- three names for the SAME slots (measured: a steel furnace holding 20 plates answers `iron-platex20`
-- under all three), so summing them would count every plate three times over. `crafter_input` and
-- `furnace_source` alias each other the same way, and `fuel` is its own inventory.
--
-- The id cannot be chosen by asking what an entity accepts: a stone furnace answers a real, empty
-- `car_trunk` and a steel chest answers a real `crafter_input`, so "it returned an inventory" proves
-- nothing. These are the ids that mean something on a machine or a box, and every other one stays
-- empty and adds nothing.
local WATCH_OUT_IDS = { defines.inventory.crafter_output, defines.inventory.chest }
local WATCH_IN_IDS = { defines.inventory.crafter_input, defines.inventory.fuel }
local watch_finished

-- The engine's crafters, as a set of `type` values rather than a list of vanilla names, so a modded
-- furnace is watched without anything being added to this file.
local function is_crafter(e)
  return e and e.valid and host.CRAFTER_KINDS[e.type] ~= nil
end

-- An inventory as `item -> count`. `get_contents` is the engine's own walk of the slots, so quality
-- stacks and modded items come back as they are instead of as whatever names this file happens to
-- know. A missing or phantom inventory reads empty, which is the same contribution as nothing.
local function contents_of(entity, id)
  local out = {}
  if not id then return out end
  local ok, inv = pcall(function() return entity.get_inventory(id) end)
  if not ok or not inv then return out end
  local lok, list = pcall(function() return inv.get_contents() end)
  if not lok then return out end
  for _, it in ipairs(list or {}) do
    local n = host.field(it, "name")
    local c = tonumber(host.field(it, "count"))
    if n and c then out[n] = (out[n] or 0) + c end
  end
  return out
end

-- One machine's recipe, as a name. `LuaRecipe` is userdata, so a `type(rec) == "table"` test -- the
-- shape this check had first -- rejects every working machine and a full box reads as having no
-- products at all.
local function recipe_of(e)
  local ok, rec = pcall(function() return e:get_recipe() end)
  if not ok or not rec then return nil end
  local name = host.field(rec, "name")
  return type(name) == "string" and name or nil
end

-- The engine's own reason for what a machine is doing, as its name. `status` is a number from
-- `defines.entity_status`, and the name is what a panel can put next to a locale row.
local function status_of(e)
  local ok, want = pcall(function() return e.status end)
  if not ok then return nil end
  local rok, found = pcall(function()
    for k, v in pairs(defines.entity_status) do if v == want then return k end end
  end)
  if rok and type(found) == "string" then return found end
  return nil
end

-- One look inside the box: the items standing where output lands, the items standing where input
-- waits, and per machine the same two numbers plus what it is. Held by `unit_number` rather than by
-- an entity handle because the two looks are seconds apart and a machine can be mined, moved or
-- destroyed between them; `gone` is one of the answers worth reporting.
local function census_of(surface, ents)
  local by_unit, out_totals, in_totals = {}, {}, {}
  local crafters = {}
  for _, e in ipairs(ents or {}) do
    local un = host.field(e, "unit_number")
    if un then
      local out, inn = {}, {}
      for _, id in ipairs(WATCH_OUT_IDS) do
        for item, n in pairs(contents_of(e, id)) do out[item] = (out[item] or 0) + n end
      end
      for _, id in ipairs(WATCH_IN_IDS) do
        for item, n in pairs(contents_of(e, id)) do inn[item] = (inn[item] or 0) + n end
      end
      by_unit[un] = { name = host.field(e, "name"), out = out, in_ = inn }
      for item in pairs(out) do out_totals[item] = true end
      for item in pairs(inn) do in_totals[item] = true end
      if is_crafter(e) then
        -- The status and the recipe go into the same record as the contents, because the second look
        -- inside the box has to answer "and what is it doing now" without finding each entity again:
        -- 2.0.77 has no working lookup by unit number (`LuaSurface` has no `get_entity`, and
        -- `game.get_entity_by_unit_number` answers nil for an entity found by name and position in
        -- the same command), so an entity walked out of the box is the only handle there is.
        by_unit[un].recipe, by_unit[un].status = recipe_of(e), status_of(e)
        crafters[#crafters + 1] = { unit_number = un, name = by_unit[un].name,
                                    recipe = by_unit[un].recipe, status = by_unit[un].status,
                                    out_before = out, in_before = inn }
      end
    end
  end
  return { by_unit = by_unit, crafters = crafters, out_items = out_totals, in_items = in_totals }
end

local function sum_side(snap, which)
  local out = {}
  for _, rec in pairs(snap.by_unit) do
    for item, n in pairs(rec[which] or {}) do out[item] = (out[item] or 0) + n end
  end
  return out
end

-- The window closed: look inside the box again and report what moved. Kept as two numbers per item --
-- gained and spent -- because they are two different observations, and adding them into one figure
-- would produce a number that means neither of them.
watch_finished = function()
  local j = storage and storage.watch_job
  if not j then return end
  local surface = resolve_surface(j.surface_index) or resolve_surface(j.surface)
  if not surface then
    storage.watch_dead = { reason = "LOST_SURFACE", job = j.key, surface = j.surface, tick = game.tick }
    storage.watch_job = nil
    return
  end
  local elapsed = (game.tick - j.started) / 60
  if elapsed <= 0 then elapsed = (j.deadline - j.started) / 60 end
  local ok, ents = pcall(function()
    return surface.find_entities_filtered { area = { { j.box.x1, j.box.y1 }, { j.box.x2, j.box.y2 } } }
  end)
  if not ok then
    storage.watch_dead = { reason = "SCAN_FAILED_LATE", job = j.key, surface = j.surface,
                           detail = { err = host.errtext(ents) }, tick = game.tick }
    storage.watch_job = nil
    return
  end
  local snap = census_of(surface, ents)
  local out_after, in_after = sum_side(snap, "out"), sum_side(snap, "in_")
  local seen = {}
  for _, bag in ipairs({ j.out_before, out_after, j.in_before, in_after }) do
    for item in pairs(bag) do seen[item] = true end
  end
  local per_item = {}
  for item in pairs(seen) do
    local gained = (out_after[item] or 0) - (j.out_before[item] or 0)
    local spent = (j.in_before[item] or 0) - (in_after[item] or 0)
    if gained ~= 0 or spent ~= 0 then
      per_item[#per_item + 1] = {
        item = item, gained = gained, spent = spent,
        -- Both ends of the delta, always numbers: an item that only appeared during the window has a
        -- `before` of zero, and a field that is simply absent is how a reader starts asking whether
        -- the zero was measured or never looked for.
        before = j.out_before[item] or 0, after = out_after[item] or 0,
        -- only a gain is a production rate; a loss is the line's appetite
        per_min = gained > 0 and gained / elapsed * 60 or nil,
      }
    end
  end
  table.sort(per_item, function(a, b)
    if a.gained ~= b.gained then return a.gained > b.gained end
    return a.item < b.item
  end)
  local census, running, stalled, gone = {}, 0, 0, 0
  for _, c in ipairs(j.crafters or {}) do
    local rec = snap.by_unit[c.unit_number]
    local now = (rec and rec.status) or "gone"
    c.status_after = now
    if rec then
      c.out_after, c.in_after = rec.out, rec.in_
      -- a machine that picked up a recipe (or lost one) mid-window is a different line from the one
      -- the first look saw, and the record has to say which of the two it counted
      c.recipe_after = rec.recipe
    end
    census[now] = (census[now] or 0) + 1
    if now == "working" then running = running + 1
    elseif now == "gone" then gone = gone + 1
    else stalled = stalled + 1 end
  end
  local gained_total, spent_total = 0, 0
  for _, e in ipairs(per_item) do
    if e.gained > 0 then gained_total = gained_total + e.gained end
    if e.spent > 0 then spent_total = spent_total + e.spent end
  end
  local record = {
    state = "measured", key = j.key, surface = j.surface,
    area = { left_top = { x = j.box.x1, y = j.box.y1 }, right_bottom = { x = j.box.x2, y = j.box.y2 } },
    machines = j.machines, machine_count = j.machine_count, recipes = j.recipes,
    unassigned = j.unassigned > 0 and j.unassigned or nil,
    per_item = per_item,
    status_census = census, running = running, stalled = stalled, gone = gone > 0 and gone or nil,
    elapsed_game_seconds = elapsed,
    gained_total = gained_total, spent_total = spent_total,
    -- Nothing landed in the box but raw material disappeared from it: the line is running and its
    -- product is going somewhere this window cannot see. Said as its own field because it is the one
    -- reading of a zero that a player could otherwise get wrong.
    shipped_out = gained_total == 0 and spent_total > 0 or nil,
    idle = gained_total == 0 and spent_total == 0 or nil,
    clock = host.clock_note(1, elapsed),
    clock_untouched = true,
    speed_at_start = j.speed_at_start, speed_at_end = game.speed,
    clock_moved = (j.speed_at_start or 1) > 1 or game.speed > 1,
    measured_tick = game.tick,
    scope = "box",
  }
  storage.watches[j.key] = record
  storage.watch_dead = nil
  storage.watch_job = nil
  return record
end

-- control.lua drives these from its single on_nth_tick handler: a step that raises has to be
-- reported to whoever started the job and reaped, and a job whose clock ran out is harvested by
-- the next request rather than by the tick that noticed it.

measure.step_drill_job = step_drill_job
measure.finish_drill_job = finish_drill_job
measure.reap_rig = reap_rig
measure.step_pump_job = step_pump_job
measure.finish_pump_job = finish_pump_job
measure.reap_parts = reap_parts
measure.step_farm_job = step_farm_job
measure.finish_farm_job = finish_farm_job
measure.reap_farm_rig = farm_reap
measure.step_arm_job = step_arm_job
measure.finish_arm_job = finish_arm_job
measure.reap_arm_rig = arm_reap

return measure
