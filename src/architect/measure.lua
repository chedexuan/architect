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

-- What is still in the ground, as a sum of amounts rather than a count of tiles, plus how much a
-- tile holds. A prototype's `normal_resource_amount` does not describe the tiles standing on a
-- map -- richness and the infinite-ore setting are applied during generation -- so amounts are
-- read from the ground and the prototype's claim is reported beside them, not instead of them.
local function ore_amount(surface, resource)
  local total, count, biggest = 0, 0, 0
  for _, e in ipairs(surface.find_entities_filtered { name = resource, type = "resource" }) do
    local a = e.amount or 0
    total = total + a
    count = count + 1
    if a > biggest then biggest = a end
  end
  return total, count, biggest
end

-- An electric machine that is not allowed to run measures as a zero, and zero written down as a
-- rate is worse than no number. `create_global_electric_network` connects every consumer on the
-- surface without wires but produces nothing, so a source goes with it; both are opt-in and both
-- are reported, because they leave the surface unable to answer a power question afterwards.
local function supply_power(surface, near, force_name, args, attempts)
  if not (args and args.supply) then return nil end
  pcall(function() surface.create_global_electric_network() end)
  local gen
  for _, o in ipairs({ 4, 5, 6, 8, 10, 12 }) do
    local pos = { x = near.x, y = near.y + o }
    if surface.can_place_entity { name = "electric-energy-interface", position = pos, force = force_name } then
      gen = surface.create_entity { name = "electric-energy-interface", position = pos, force = force_name }
      if gen then break end
    end
  end
  attempts[#attempts + 1] = { tried = "global grid + electric-energy-interface", placed = gen and true or false }
  return gen
end

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

local function in_patch_area(a)
  return { { a.x1, a.y1 }, { a.x2, a.y2 } }
end

-- How much a tile of this ore actually holds IN THIS SAVE, read off the ground the game generated.
--
-- The amount matters more than it looks: a burner drill on tiles holding 5000 produced one item in
-- thirty seconds where the same drill on this save's natural iron-ore (107 to 295 per tile) produced
-- seven. A generous patch is therefore not a safe patch, it is a different patch, and a bench whose
-- numbers cannot be compared with the map's is not a bench. So the vein is laid at the mean of what
-- real tiles of this resource hold, and the bench surfaces are skipped so a vein laid last time does
-- not set its own baseline.
local BENCH_NAMES = { ["arch-lab"] = true, ["arch-sandbox"] = true }
local function natural_tile_amount(resource, category)
  local sum, count = 0, 0
  for _, s in pairs(game.surfaces) do
    if not BENCH_NAMES[s.name] then
      local ok, tiles = pcall(function() return s.find_entities_filtered { name = resource, type = "resource" } end)
      for _, e in ipairs(ok and tiles or {}) do
        local a = tonumber(e.amount)
        if a and a > 0 then sum = sum + a; count = count + 1 end
        if count >= 400 then break end
      end
    end
    if count >= 400 then break end
  end
  if count > 0 then return math.floor(sum / count + 0.5), count end
  return PATCH_FALLBACK[category] or PATCH_FALLBACK["default"], nil
end

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

-- A fresh, uniform, entirely synthetic vein: everything in the square is removed, then one resource
-- entity per tile at a fixed amount. Uniform matters as much as synthetic -- a vein whose tiles hold
-- different amounts makes the rig's own number depend on which tiles it happened to start on, and
-- the whole point of the bench is a rate that can be compared against another one.
--
-- The amount is reported rather than assumed, because `amount` is exactly what a patch is made of:
-- the rig's caveat says so itself, and a caller told "5000 per tile" can tell a bench figure from a
-- map figure without asking.
function measure.ensure_patch(surface, resource)
  storage = storage or {}
  storage.bench_patch = storage.bench_patch or {}
  local proto = nil
  local ok, found = pcall(function() return prototypes.entity[resource] end)
  if ok then proto = found end
  if not proto then
    return nil, "NO_SUCH_RESOURCE", "this save has no entity called " .. tostring(resource)
        .. ", so no vein of it can be laid"
  end
  if field(proto, "type") ~= "resource" then
    return nil, "NOT_A_RESOURCE", resource .. " is a " .. tostring(field(proto, "type"))
        .. ", not a resource: there is nothing to mine"
  end
  local cat = field(proto, "resource_category")
  if not cat then
    return nil, "NO_CATEGORY", resource .. " has no resource_category, so no extractor can be chosen for it"
  end

  local box, ground_box = PATCH.vein, PATCH.ground
  -- The ground has to be there before anything is asked of it. A created surface generates the area
  -- around its origin and nothing else, so this checks the four chunks the SQUARE spans rather than
  -- the one the centre falls in -- tile 158 is chunk 4, and a check that stops at chunk 3 lays a vein
  -- into out-of-map and reports "no legal spot".
  for _, c in ipairs({ { ground_box.x1, ground_box.y1 }, { ground_box.x2, ground_box.y1 },
                       { ground_box.x1, ground_box.y2 }, { ground_box.x2, ground_box.y2 } }) do
    if not surface.is_chunk_generated({ x = math.floor(c[1] / 32), y = math.floor(c[2] / 32) }) then
      pcall(function() surface.request_to_generate_chunks({ ground_box.x1, ground_box.y1 }, 2) end)
      return nil, "GENERATING", "the bench plot is still generating; call again"
    end
  end
  -- Same test, one level down: the paint. `prime_sandbox` does this for the pad, and the bench's far
  -- corner is deep water where no extractor can stand. Inside the pad would not work -- it is swept
  -- on every take of the surface, so anything laid there is destroyed the next time somebody asks.
  local tiles = {}
  for x = ground_box.x1, ground_box.x2 do
    for y = ground_box.y1, ground_box.y2 do
      tiles[#tiles + 1] = { name = "grass-1", position = { x = x, y = y }, tile_index = 1 }
    end
  end
  pcall(function() surface.set_tiles(tiles) end)
  pcall(function()
    for _, e in ipairs(surface.find_entities_filtered { area = in_patch_area(ground_box) }) do e.destroy() end
  end)
  local amount, sampled = natural_tile_amount(resource, cat)
  local laid = 0
  for x = box.x1, box.x2 do
    for y = box.y1, box.y2 do
      local made = nil
      pcall(function()
        made = surface.create_entity { name = resource, position = { x = x + 0.5, y = y + 0.5 },
          force = "neutral", amount = amount }
      end)
      if made then laid = laid + 1 end
    end
  end
  if laid < 25 then
    return nil, "PATCH_FAILED", "only " .. laid .. " of " .. (PATCH_SPAN * PATCH_SPAN)
        .. " tiles of " .. resource .. " could be laid on the bench"
  end
  -- A long enough window CAN drain a laid tile, and `tiles_depleted` in the record is where that
  -- shows up: a window that outran its vein reads as a lower bound, which is the same rule
  -- PATCH_TOO_SMALL already applies to a small natural patch. The amount is chosen to be the save's
  -- own, so the window that outruns it is the window that would outrun the real vein too.

  local rec = { surface = surface.name, resource = resource, tiles = laid,
                area = { x1 = box.x1, y1 = box.y1, x2 = box.x2, y2 = box.y2 },
                ground = { x1 = ground_box.x1, y1 = ground_box.y1,
                           x2 = ground_box.x2, y2 = ground_box.y2 },
                amount_per_tile = amount, sampled_from_tiles = sampled, category = cat }
  storage.bench_patch[resource] = rec
  return rec
end

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

-- The other half of `rig_ground`, called only when this request is really going to place a rig.
local function prepare_bench(ground, resource)
  if not ground or not ground.bench then return nil end
  local rec, perr, pdetail = measure.ensure_patch(ground.surface, resource)
  if not rec then
    if perr == "GENERATING" then return fail("SANDBOX_GENERATING", pdetail, { reason = "GENERATING" }) end
    return fail("BENCH_PATCH_FAILED", pdetail, { reason = perr, resource = resource })
  end
  ground.patch = rec
  return nil
end

-- Where a rig's number came from, said in the record itself. The two sentences differ on purpose:
-- on a laid vein the rate is reproducible because the ground was made for it, and the honest limit
-- is that such a figure says nothing about a patch on a real map with its own richness and drain.
local function rig_caveat(j, one, what)
  if j.patch then
    return one .. " on a synthetic vein this mod laid -- " .. j.patch.tiles .. " tiles of "
      .. j.patch.resource .. " at " .. j.patch.amount_per_tile .. " each on " .. j.surface_name
      .. ". Nothing on a player's map was spent to get it, and no patch on a real map is obliged to"
      .. " answer the same way: richness, drain and tile amount differ, and this number is a property"
      .. " of " .. what
  end
  return one .. " on this map, spot-measured. It belongs to that ground, not to the machine alone,"
    .. " and it says nothing about a working base"
end

function measure.drill_rate(args)
  args = args or {}
  local resource = args.resource or "iron-ore"
  -- Which drill belongs on this ore is the engine's category test, not a remembered name: the ore
  -- carries `resource_category` and a drill carries the set of categories it takes. The hint below
  -- only says "prefer the cheap one, its rate is the number worth quoting first"; a save without
  -- that entity gets the fastest drill that takes the category instead of a rig that never fills.
  local okr, rp = pcall(function() return prototypes.entity[resource] end)
  local rcat = okr and rp and host.field(rp, "resource_category") or nil
  local machine = args.machine or roles.miner_for(rcat, { prefer = "burner-mining-drill" })
  if not machine then
    return fail_key("NO_MINER_FOR_RESOURCE", "m-no-miner-resource", nil, "no placeable mining entity takes this resource's category",
      { resource = resource, category = rcat, asked_for = args.machine })
  end
  local seconds = args.seconds or 25
  -- Before any of the rig exists: the clock belongs to the world, and a refusal that arrives
  -- after the drill has eaten a patch is an apology, not a guard.
  local speed, warp_refused = host.clock_policy(args.speed)
  if warp_refused then return warp_refused end
  storage = storage or {}
  storage.drills = storage.drills or {}
  -- A rate is a property of a patch: its density, its drain, how much of the map is left. The cache
  -- key stays `machine|resource`, because that is what `solve` and `fluid_chain` look a record up by
  -- -- but a hit is now checked against the surface the record names, and a record from another
  -- surface is no hit at all. Without that, asking about a second world returned nauvis's figure,
  -- flagged only as `cached`, and every plan built from it was sized on ground it never looked at.
  -- The surface is settled before anything is looked up. A cached rate and a dead record both belong
  -- to the ground they came from: consulting them first answered a question about one world with a
  -- verdict from another, and a name that is not in the save at all never reached the refusal below.
  local ground, ground_refused = rig_ground(args, resource)
  if ground_refused then return ground_refused end
  local asked = ground.surface
  local key = machine .. "|" .. resource
  -- `pump_rate` refuses to run beside a drill for exactly this reason, in its own comment: both rigs
  -- raise `game.speed` and restore the value they found, so two overlapping jobs each restore the
  -- other's baseline and the world is left running fast. The check only existed on one side.
  if storage.pump_job then
    return fail_key("MEASUREMENT_BUSY", "m-busy-pump", nil, "a pump measurement is running; one rig at a time")
  end
  if storage.lab and storage.lab.state == "running" then
    return fail_key("MEASUREMENT_BUSY", "m-busy-card", nil, "a card measurement is running; one rig at a time")
  end

  -- A job whose deadline has passed is a finished measurement, not a reason to place another
  -- drill. Finalizing here also covers the case where the runner never got a tick: the clock
  -- has already moved, so the numbers are good.
  if storage.drill_job and storage.drill_job.deadline <= game.tick then
    local ok, err = pcall(step_drill_job)
    if not ok then storage.drill_error = host.errtext(err) end
  end
  -- a finished measurement is kept: re-measuring a drill the caller already knows about
  -- would burn 25 game-seconds for a number that has not moved
  if storage.drill_job and storage.drill_job.key == key and storage.drill_job.state == "running" then
    return { state = "running", machine = machine, resource = resource,
             seconds_left = (storage.drill_job.deadline - game.tick) / 60 }
  end
  if storage.drill_error then
    local msg = storage.drill_error
    storage.drill_error = nil
    return fail("MEASUREMENT_ERRORED", "the tick runner raised: " .. msg, { drill_error = msg })
  end
  -- An errored measurement is returned rather than treated as absent. Silently re-measuring is
  -- how a rig that cannot run at all produced a fresh zero on every call and never said why;
  -- `refresh` is the caller's way of saying it fixed the cause.
  local cached = storage.drills[key]
  if cached and cached.surface ~= asked.name then cached = nil end
  -- One rule for both rigs and both kinds of record: a plain read gets whatever is on file, and only
  -- `refresh` opens a new window. A record that came back `error` -- no power, no fuel, a patch that
  -- emptied -- is still an answer to "what does this machine do here", and re-measuring it on every
  -- read meant a caller polling a 10-second job started a fresh 25-second job each time and never saw
  -- the first one finish. The first version of this line fixed "refresh is ignored for a healthy
  -- record" and broke that; both halves are pinned by the rigs' own suites.
  if args.refresh ~= true and cached then
    cached.cached = true
    return cached
  end

  local force_name = args.force or "player"
  local force = game.forces[force_name]
  if not force then return fail("NO_FORCE", force_name) end
  -- settled once, above: a rig that resolved the surface twice is how a cached record from one world
  -- and a rig standing in another came to be reported together.
  local surface = asked

  local unready = prepare_bench(ground, resource)
  if unready then return unready end

  local tiles = surface.find_entities_filtered { name = resource, type = "resource" }
  if #tiles == 0 then
    return fail("NO_ORE_ON_MAP", resource .. " is not generated on " .. surface.name,
      { note = "the rate stays estimated; Space Age ores need a save where they are generated" })
  end
  local best, best_count
  for i = 1, #tiles, math.max(1, math.floor(#tiles / 40)) do
    local p = tiles[i].position
    local n = #surface.find_entities_filtered { name = resource, type = "resource",
      area = { { p.x - 6, p.y - 6 }, { p.x + 6, p.y + 6 } } }
    if not best_count or n > best_count then best_count, best = n, p end
  end
  if best_count < 25 then
    return fail_key("PATCH_TOO_SMALL", "m-patch-small", { resource, tostring(best_count) },
      "densest " .. resource .. " patch has " .. tostring(best_count)
      .. " tiles in a 13x13 window; a patch that empties mid-run gives a lower bound, not a rate")
  end

  -- Anything raised between here and the job record leaves entities standing on the patch, and
  -- the next run then reads them as "no room here" for as long as the save lives. So every entity
  -- this call makes is written down as it appears, and a later call takes back whatever was left.
  if storage.drill_debris then
    for _, spec in ipairs(storage.drill_debris) do
      local e = find_rig_entity(surface, spec.unit, spec.name, spec.pos)
      if e and e.valid then e.destroy() end
    end
  end
  local made = {}
  storage.drill_debris = made
  local function keep(e)
    if e then made[#made + 1] = { unit = e.unit_number, name = e.name, pos = e.position } end
    return e
  end

  -- What the machine can actually reach, as opposed to what the caller asked for: the selection
  -- box is what a drill mines, so a spot whose box straddles a second ore measures that ore's
  -- rules. A pure box is preferred; a mixed one is still used when the patch offers nothing else,
  -- and is reported either way. `mineable_properties` names any fluid the ore demands, so a
  -- requirement never has to be guessed at -- and uranium-ore demands sulfuric-acid.
  local reach = field(prototypes.entity[machine], "mining_drill_radius") or 2.5
  local function others_in_box(pos)
    local found, counts = false, {}
    for _, e in ipairs(surface.find_entities_filtered { type = "resource",
        area = { { pos.x - reach, pos.y - reach }, { pos.x + reach, pos.y + reach } } }) do
      counts[e.name] = (counts[e.name] or 0) + 1
      if e.name ~= resource then found = true end
    end
    return found, counts
  end

  local drill, at, box_counts
  for _, want_pure in ipairs({ true, false }) do
    for dx = -3, 3 do
      for dy = -3, 3 do
        local pos = { x = best.x + dx + 0.5, y = best.y + dy + 0.5 }
        local mixed, counts = others_in_box(pos)
        if mixed ~= want_pure then
          if surface.can_place_entity { name = machine, position = pos, force = force_name } then
            local d = keep(surface.create_entity { name = machine, position = pos, force = force_name })
            if d then drill, at, box_counts = d, pos, counts break end
          end
        end
      end
      if drill then break end
    end
    if drill then break end
  end
  if not drill then
    return fail_key("NO_SITE_FOR_DRILL", "m-no-spot-drill", { machine },
      "no legal spot for " .. machine .. " on that patch")
  end

  -- An electric machine on a surface with no grid measures as zero output, so the caller can ask
  -- for the ideal grid -- but `create_global_electric_network` merges every consumer on the
  -- surface into one unlimited network, which would silently invalidate any power figure read
  -- from that surface later. It therefore never happens unless asked for, and the measurement
  -- carries the flag so a number measured that way can be told apart.
  local power_attempts = {}
  local gen = keep(supply_power(surface, at, force_name, args, power_attempts))
  if args.global_grid then pcall(function() surface.create_global_electric_network() end) end
  local fuel_inv = drill.get_inventory(defines.inventory.fuel)
  local fuelled = fuel_inv and (fuel_inv.insert { name = "coal", count = 50 } > 0)
  -- A drill has no destination until a conveyor sits on the tile it drops onto; a chest beside it
  -- is not that destination, and the machine then stops before producing anything, which reads as
  -- a rate of zero. Two things are engine facts rather than geometry you can reason out: the tile
  -- is floor(drop_position) + 0.5 (drop_position is a raw point, not a centre), and the belt runs
  -- counter-clockwise from the drill's facing -- not away from it.
  local dp = drill.drop_position
  local bx, by = math.floor(dp.x) + 0.5, math.floor(dp.y) + 0.5
  local facing = math.floor((drill.direction % 16) / 4 + 0.5) * 4 % 16
  local dir = (facing + 12) % 16
  local step = ({ [0] = { 0, -1 }, [4] = { 1, 0 }, [8] = { 0, 1 }, [12] = { -1, 0 } })[dir] or { 1, 0 }
  local sx, sy = step[1], step[2]
  -- A chest at the end would need an inserter, and an inserter is one more thing that can be
  -- starved; the belts are drained every tick instead, so their capacity never becomes the
  -- number being measured.
  local belt_units, belt_ents = {}, {}
  for i = 0, (args.belt_tiles or 4) - 1 do
    local pos = { x = bx + sx * i, y = by + sy * i }
    if not surface.can_place_entity { name = "transport-belt", position = pos, force = force_name, direction = dir } then break end
    local b = keep(surface.create_entity { name = "transport-belt", position = pos, force = force_name, direction = dir })
    if not b then break end
    belt_units[#belt_units + 1] = b.unit_number
    belt_ents[#belt_ents + 1] = b
  end
  if #belt_units == 0 then
    drill.destroy()
    if gen then gen.destroy() end
    return fail("NO_ROOM_FOR_BELT", "no tile at the drill's drop point for a " .. machine .. " to output onto",
      { note = "a drill with no conveyor on its drop tile mines one tick's worth and stops" })
  end

  local mine = prototypes.entity[resource]
  local mineProps = mine and field(mine, "mineable_properties")
  -- An ore can demand a fluid before a drill will take it -- uranium-ore wants sulfuric-acid, and
  -- `mineable_properties` is where that is written -- but the machine's own box is not reachable
  -- from script: `fluidbox[1]` is nil and insert_fluid on the drill answers 0. What works is the
  -- route a player uses: a tank of that fluid touching pipes that touch the machine. The ring of
  -- twelve is used because the face the box sits on cannot be read, and this goes after the belt
  -- line because a 3x3 tank laid first would cover the drop tile.
  local required = mineProps and field(mineProps, "required_fluid")
  local supply_specs, supply_ents, tank = {}, {}, nil
  if required then
    for dx = -2, 2 do
      for dy = -2, 2 do
        local ax, ay = math.abs(dx), math.abs(dy)
        if (ax == 2 and ay <= 1) or (ay == 2 and ax <= 1) then
          local pos = { x = at.x + dx, y = at.y + dy }
          if surface.can_place_entity { name = "pipe", position = pos, force = force_name } then
            local e = keep(surface.create_entity { name = "pipe", position = pos, force = force_name })
            if e then
              supply_specs[#supply_specs + 1] = { unit = e.unit_number, name = "pipe", pos = pos }
              supply_ents[#supply_ents + 1] = e
            end
          end
        end
      end
    end
    -- The tank has to face the machine: its output is on a side, and a tank turned the wrong way
    -- holds the fluid without giving any of it up.
    for _, o in ipairs({ { 4, 0, defines.direction.west }, { -4, 0, defines.direction.east },
                         { 0, 4, defines.direction.north }, { 0, -4, defines.direction.south } }) do
      local pos = { x = at.x + o[1], y = at.y + o[2] }
      if surface.can_place_entity { name = "storage-tank", position = pos, force = force_name, direction = o[3] } then
        local t = keep(surface.create_entity { name = "storage-tank", position = pos, force = force_name, direction = o[3] })
        if t then
          pcall(function() t.insert_fluid { name = required, amount = tank_capacity() } end)
          local held = 0
          for _, v in pairs(t.get_fluid_contents() or {}) do
            held = held + ((type(v) == "number") and v or (v.amount or 0))
          end
          if held > 0 then
            tank = t
            supply_specs[#supply_specs + 1] = { unit = t.unit_number, name = "storage-tank", pos = pos }
            supply_ents[#supply_ents + 1] = t
            break
          end
          t.destroy()
        end
      end
    end
    if not tank then
      for _, e in ipairs(supply_ents) do if e.valid then e.destroy() end end
      for _, e in ipairs(belt_ents) do if e.valid then e.destroy() end end
      if gen and gen.valid then gen.destroy() end
      drill.destroy()
      return fail("FLUID_NOT_SUPPLIED", "no tile beside " .. machine .. " would take a storage-tank of "
          .. tostring(required),
        { required_fluid = required, ring_pipes = #supply_specs,
          note = "the ore names the fluid it wants; this says the rig could not put a full tank next to the machine" })
    end
  end
  local amount0, tiles0, biggest0 = ore_amount(surface, resource)
  storage.drill_job = {
    key = key, machine = machine, resource = resource, belt = "transport-belt",
    surface = surface.index, surface_name = surface.name,
    -- which ground this rig was standing on and whether that ground was laid for the occasion: a
    -- rate from a synthetic vein is comparable with another rate from a synthetic vein, and neither
    -- is a claim about the patch on somebody's map
    bench = ground.named ~= true, patch = ground.patch,
    drill_unit = drill.unit_number, drill_pos = at,
    belt_units = belt_units, belt_pos = { x = bx, y = by }, dir = dir, step = { sx, sy },
    fuelled = fuelled and true or false,
    power_attempts = power_attempts, powered = gen and "electric-energy-interface" or nil,
    gen_spec = gen and { unit = gen.unit_number, name = "electric-energy-interface", pos = gen.position } or nil,
    minable_in_box = box_counts, required_fluid = mineProps and field(mineProps, "required_fluid"),
    fluid_amount = mineProps and field(mineProps, "fluid_amount"),
    supply_specs = supply_specs, supply_fluid = required,
    tank_unit = tank and tank.unit_number, tank_pos = tank and tank.position,
    before = tiles0,
    -- the sum of what is still in the ground: on a map whose tiles hold thousands of units no
    -- tile ever disappears, so the units removed from the ground corroborate the belt count
    amount_before = amount0, tile_mean = biggest0 > 0 and (amount0 / math.max(1, tiles0)) or 0,
    tile_max = biggest0,
    harvested = 0, patch_tiles = best_count,
    started = game.tick, deadline = game.tick + seconds * 60,
    clock_speed = speed,
    prev_speed = game.speed, prev_paused = game.tick_paused, state = "running",
  }
  -- the job owns the entities from here on; reap_rig takes them back whatever way the job ends
  storage.drill_debris = nil
  host.clock_raise(speed, true)
  return { state = "running", machine = machine, resource = resource, seconds = seconds,
           clock = host.clock_note(speed, seconds),
           output_belt = #belt_units, supply_fluid = required, died = storage.drill_dead, runner = storage.drill_error,
           note = "call again for the result; ticks cannot be spent inside one command, so the measurement is driven by the same runner the lab uses" }
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

-- Take everything off the rig's belts and report what came off. Draining is what makes a long
-- run measurable at all: a belt line holds about 8 items per tile, after which the drill is
-- back to `waiting_for_space_in_destination` and the number being measured is the belt, not
-- the mine. Connected belts can share one transport line, so the per-belt counts below are a
-- diagnostic, not a sum of independent containers.
local function drain_rig(j)
  local ents = rig_entities(j)
  if not ents then return 0, nil end
  local taken, per = 0, {}
  for _, b in ipairs(ents.belts) do
    if b.valid then
      local ok, line = pcall(function() return b.get_transport_line(1) end)
      if ok and line then
        local n = line.get_item_count(j.resource) or 0
        if n > 0 then line.clear() taken = taken + n end
        per[#per + 1] = n
      else
        per[#per + 1] = "probe_failed"
      end
    end
  end
  return taken, table.concat(per, "+")
end

-- The runner calls this every tick: keep the belts empty so the drill never stalls, and close
-- the job when its clock is up. Assigned rather than `local function`, because the forward
-- declaration at the top of this section is the name the request handler closes over.
function step_drill_job()
  local j = storage.drill_job
  if not j or j.state ~= "running" then return end
  if j.tank_unit then
    local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
    local t = surface and find_rig_entity(surface, j.tank_unit, "storage-tank", j.tank_pos)
    -- The tank is refilled every tick rather than once: a rig whose supply runs out mid-window
    -- would report the machine stalling as if the ore mined slowly.
    if t then pcall(function() t.insert_fluid { name = j.supply_fluid, amount = tank_capacity() } end) end
  end
  local taken = drain_rig(j)
  if taken > 0 then
    if not j.first_item_tick then j.first_item_tick = game.tick end
    j.last_item_tick = game.tick
    j.arrival_ticks = (j.arrival_ticks or 0) + 1
  end
  j.harvested = (j.harvested or 0) + taken
  if game.tick >= j.deadline then finish_drill_job() end
end

-- Finished measurements land in storage.drills; this is called from the tick runner.
function finish_drill_job()
  local j = storage.drill_job
  if not j or j.state ~= "running" then return end
  local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
  if not surface then
    -- named, not nil: a job that disappears without a word is indistinguishable from a runner
    -- that never fired, and that cost a whole debugging pass.
    storage.drill_dead = { reason = "LOST_SURFACE", job = j.key, surface = j.surface_name,
                           wanted_index = tostring(j.surface),
                           wanted_name = tostring(j.surface_name), tick = game.tick }
    host.clock_lower(j.prev_speed, j.prev_paused)
    storage.drill_job = nil
    return
  end
  if j.deadline > game.tick then return end

  local after = #surface.find_entities_filtered { name = j.resource, type = "resource" }
  local elapsed = (game.tick - j.started) / 60
  local tiles_depleted = j.before - after
  local status = nil
  local held_in_machine = 0
  local ents = rig_entities(j)
  local drill = ents and ents.drill
  if drill and drill.valid then
    for k, v in pairs(defines.entity_status) do
      if v == drill.status then status = k end
    end
    -- the difference between "a tank of the right fluid stood there" and "the machine took it"
    for _, v in pairs(drill.get_fluid_contents() or {}) do
      held_in_machine = held_in_machine + ((type(v) == "number") and v or (v.amount or 0))
    end
  end
  -- whatever is still on the belts counts as much as what the runner already took off them
  local got, per = drain_rig(j)
  got = got + (j.harvested or 0)
  reap_rig(j)

  local proto = prototypes.entity[j.machine]
  local rp = prototypes.entity[j.resource]
  -- A window average always loses the tile that was mid-mining when the clock ran out, so it
  -- under-reports by up to one item regardless of length. A shortfall that stays constant in
  -- items as the window grows is truncation rather than a warm-up, and the slope between two
  -- windows of different length is the figure immune to it.
  local prev = storage.drills[j.key]
  local steady, slope_from
  if j.first_item_tick and j.last_item_tick > j.first_item_tick and got > 1 then
    -- one window is enough: the spacing between the first and last arrival is the period, and
    -- no window-end truncation can bias it
    steady = 60 / (((j.last_item_tick - j.first_item_tick) / 60) / (got - 1))
    slope_from = { "period", elapsed }
  elseif prev and prev.elapsed_game_seconds and prev.belt_items and elapsed > prev.elapsed_game_seconds then
    local dt = elapsed - prev.elapsed_game_seconds
    local di = got - prev.belt_items
    if dt > 0 then
      steady = di / dt * 60
      slope_from = { "two windows", prev.elapsed_game_seconds, elapsed }
    end
  end
  storage.drills[j.key] = {
    machine = j.machine, resource = j.resource, surface = j.surface_name,
    bench = j.bench or nil, patch = j.patch,
    clock_speed = j.clock_speed or 1,  -- the rate is per GAME minute; this says what the world ran at
    tiles_depleted = tiles_depleted,
    elapsed_game_seconds = elapsed,
    -- the belt count is the measurement: on an infinite-ore map no tile ever disappears, and
    -- even on a finite one the last partial tile is invisible to a tile count
    belt_items = got, drill_status = status, fuelled = j.fuelled,
    power_attempts = j.power_attempts,
    -- A machine that never ran measures as a zero, and a zero stored as a rate is worse than no
    -- number: the solver would size a plant around it. The status is the engine's own verdict, and
    -- the ore's `mineable_properties` says which fluid that verdict is about.
    error = (status == "no_power" and "NOT_POWERED")
      or (status == "missing_required_fluid" and "NOT_SUPPLIED") or nil,
    remedy = status == "no_power" and "put the rig on a live grid, or pass supply=true"
      or status == "missing_required_fluid" and ("this machine stops until "
        .. tostring(j.required_fluid or "a fluid the ore does not name") .. " reaches its box"
        .. " (fluid_amount=" .. tostring(j.fluid_amount) .. " per ore unit)") or nil,
    required_fluid = j.required_fluid, fluid_amount = j.fluid_amount,
    minable_in_box = j.minable_in_box,
    fluid_in_machine = j.supply_fluid and held_in_machine or nil,
    fluid_ring_tiles = j.supply_fluid and #(j.supply_specs or {}) or nil,
    belt_tiles = #(j.belt_units or {}), belt_lines = per,
    ground_units_removed = (j.amount_before or 0) - ore_amount(surface, j.resource),
    tile_amount_mean = j.tile_mean, tile_amount_max = j.tile_max,
    items_per_min = elapsed > 0 and (got / elapsed * 60) or 0,
    -- 1-tick resolution on the question "is the shortfall mine or the game's": `started` is
    -- recorded before the runner's first tick, so `first_item_after` is the game's own answer
    -- for how long the first unit takes, and `seconds_per_item` is its steady-state period.
    first_item_after = j.first_item_tick and (j.first_item_tick - j.started) / 60 or nil,
    last_item_after = j.last_item_tick and (j.last_item_tick - j.started) / 60 or nil,
    -- the period is (last-first)/(items-1), which assumes items arrive one at a time; when
    -- arrival_ticks == belt_items the assumption held and the number below is exact
    arrival_ticks = j.arrival_ticks,
    seconds_per_item = (j.first_item_tick and j.last_item_tick > j.first_item_tick and got > 1)
      and ((j.last_item_tick - j.first_item_tick) / 60) / (got - 1) or nil,
    steady_items_per_min = steady,
    steady_source = slope_from,
    patch_tiles_at_start = j.patch_tiles,
    mining_speed = proto and field(proto, "mining_speed"),
    ore_mining_time = rp and field(field(rp, "mineable_properties") or {}, "mining_time"),
    mining_radius = proto and field(proto, "mining_drill_radius"),
    tile_amount = rp and field(rp, "normal_resource_amount"),
    infinite_patch = rp and (field(rp, "infinite_resource") or false) or false,
    measured_tick = game.tick,
    caveat = rig_caveat(j, "one rig", "the vein it stands on")
      .. "; the belt line is drained every tick, so this is the drill's output and not a belt capacity",
  }
  storage.drill_dead = nil
  j.state = "done"
  storage.drill_job = nil
  host.clock_lower(j.prev_speed, j.prev_paused)
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

function measure.pump_rate(args)
  args = args or {}
  local resource = args.resource or "crude-oil"
  -- Same rule as the drill rig: a pumpjack is a `mining-drill` whose categories cover `basic-fluid`,
  -- so on a modpack the fluid extractor is whatever takes that category, and "pumpjack" is a hint.
  local okr, rp = pcall(function() return prototypes.entity[resource] end)
  local rcat = okr and rp and host.field(rp, "resource_category") or nil
  local machine = args.machine or roles.miner_for(rcat, { prefer = "pumpjack" })
  if not machine then
    return fail_key("NO_MINER_FOR_RESOURCE", "m-no-miner-fluid", nil, "no placeable mining entity takes this fluid's category",
      { resource = resource, category = rcat, asked_for = args.machine })
  end
  local seconds = args.seconds or 60
  -- before the rig exists, same rule as the drill's head
  local speed, warp_refused = host.clock_policy(args.speed)
  if warp_refused then return warp_refused end
  storage = storage or {}
  storage.pumps = storage.pumps or {}
  -- see the note on the drill's head: the surface is settled before a cached or dead record is read
  local ground, ground_refused = rig_ground(args, resource)
  if ground_refused then return ground_refused end
  local asked = ground.surface
  local key = machine .. "|" .. resource
  if storage.lab and storage.lab.state == "running" then
    return fail_key("MEASUREMENT_BUSY", "m-busy-card", nil, "a card measurement is running; one rig at a time")
  end

  if storage.pump_job and storage.pump_job.deadline <= game.tick then
    local ok, err = pcall(step_pump_job)
    if not ok then storage.pump_error = host.errtext(err) end
  end
  if storage.pump_job and storage.pump_job.key == key then
    local j = storage.pump_job
    -- the console's `storage` is not this mod's, so anything worth watching has to leave through
    -- the answer: `phase`/`in_flight`/`discarded` are what a stuck window is made of
    return { state = "running", machine = machine, resource = resource,
             seconds_left = (j.deadline - game.tick) / 60, phase = j.phase,
             in_flight = j.in_flight, discarded = j.discarded,
             counted = j.harvested, since_start = (game.tick - j.started) / 60 }
  end
  -- Both rigs raise game.speed and restore it when they close; running two at once would have
  -- each restore the other's baseline and leave the world accelerated.
  if storage.drill_job then
    return fail_key("MEASUREMENT_BUSY", "m-busy-drill", nil, "a drill measurement is running; one rig at a time")
  end
  if storage.pump_error then
    local msg = storage.pump_error
    storage.pump_error = nil
    return fail("MEASUREMENT_ERRORED", "the tick runner raised: " .. msg, { pump_error = msg })
  end
  local dead = storage.pump_dead
  -- the verdict belongs to the ground it was earned on: a pumpjack that died of no power on nauvis
  -- says nothing about one on another surface
  if dead and dead.job == key and dead.surface == asked.name and args.refresh ~= true then
    storage.pump_dead = nil
    return fail(dead.reason, machine .. " could not be measured on this rig", dead.detail)
  end
  local pump_hit = storage.pumps[key]
  if pump_hit and pump_hit.surface ~= asked.name then pump_hit = nil end
  -- the same rule as the drill's, spelled the same way: see the note there for why an errored record
  -- is served rather than re-measured on every read
  if args.refresh ~= true and pump_hit then
    pump_hit.cached = true
    return pump_hit
  end

  local force_name = args.force or "player"
  if not game.forces[force_name] then return fail("NO_FORCE", force_name) end
  local surface = asked

  local unready = prepare_bench(ground, resource)
  if unready then return unready end

  local tiles = surface.find_entities_filtered { name = resource, type = "resource" }
  if #tiles == 0 then
    return fail("NO_FIELD_ON_MAP", resource .. " is not present on " .. surface.name,
      { note = "a fluid field's yield can only be read from a pump standing on it" })
  end
  local amount_before, tile_count, tile_biggest = 0, 0, 0
  for _, e in ipairs(tiles) do
    local a = e.amount or 0
    amount_before = amount_before + a tile_count = tile_count + 1
    if a > tile_biggest then tile_biggest = a end
  end

  -- Every tile of a field is a candidate site, and the engine decides: a resource entity can
  -- exist somewhere nothing can be built on it (a script can place one off the map, and its
  -- tiles then show up in a search), so the first position is not assumed to be the buildable
  -- one. The count of sites tried is reported because "the field exists but nothing fits on it"
  -- is a different failure from "there is no field".
  local pump, tried = nil, 0
  for i = 1, #tiles, math.max(1, math.floor(#tiles / 60)) do
    local p = tiles[i].position
    local pos = { x = math.floor(p.x) + 0.5, y = math.floor(p.y) + 0.5 }
    tried = tried + 1
    if surface.can_place_entity { name = machine, position = pos, force = force_name } then
      pump = surface.create_entity { name = machine, position = pos, force = force_name }
      if pump then break end
    end
  end
  if not pump then
    return fail_key("NO_SITE_FOR_PUMP", "m-no-spot-pump", { machine },
      "no legal spot for " .. machine .. " on that field",
      { tiles_on_map = #tiles, sites_tried = tried })
  end

  -- Whether the machine can run is decided by the machine, at the end of the window -- not here.
  -- Reading `status` in the tick an entity was created answers `no_power` even when the grid is
  -- about to feed it, and that false verdict was measured against a hand-built pair: the same
  -- interface that read `no_power` at placement read `no_recipe` with energy in it a few ticks
  -- later. So the rig only states what it did; `pump_status` at harvest is the evidence.
  --
  -- An ideal source stays opt-in because `create_global_electric_network` merges every consumer
  -- on the surface into one network and `electric-energy-interface` produces without limit; both
  -- would invalidate any power figure read from that surface afterwards.
  local attempts = {}
  local gen = supply_power(surface, pump.position, force_name, args, attempts)

  -- A single pipe on one face does not drain a pumpjack; a connected ring around its footprint
  -- does. That was settled by laying every arrangement in one run rather than by reasoning about
  -- the machine's geometry, which the runtime does not expose: tanks against the faces cannot even
  -- be placed (a 3x3 tank at two tiles from a 3x3 pump overlaps it), one pipe per face accepts
  -- nothing, and the twelve-tile ring drains it. So the rig is the ring, plus one tank wherever
  -- one fits beyond it.
  local ring, ring_units, ring_pos = {}, {}, {}
  for dx = -2, 2 do
    for dy = -2, 2 do
      local ax, ay = math.abs(dx), math.abs(dy)
      if (ax == 2 and ay <= 1) or (ay == 2 and ax <= 1) then
        local pos = { x = pump.position.x + dx, y = pump.position.y + dy }
        if surface.can_place_entity { name = "pipe", position = pos, force = force_name } then
          local e = surface.create_entity { name = "pipe", position = pos, force = force_name }
          if e then
            ring_units[#ring_units + 1] = e.unit_number
            ring_pos[#ring_pos + 1] = pos
            ring[#ring + 1] = { dx = dx, dy = dy }
          end
        end
      end
    end
  end
  local candidates, tank_options = {}, {}
  if #ring > 0 then
    for _, t in ipairs(ring) do
      local pos = { x = pump.position.x + t.dx * 2, y = pump.position.y + t.dy * 2 }
      local k = pos.x .. "," .. pos.y
      if not candidates[k] and surface.can_place_entity { name = "storage-tank", position = pos, force = force_name } then
        candidates[k] = true
        tank_options[#tank_options + 1] = pos
      end
    end
  end
  local tank, tank_at = nil, table.remove(tank_options, 1)
  if tank_at then tank = surface.create_entity { name = "storage-tank", position = tank_at, force = force_name } end
  if not tank then
    for i, u in ipairs(ring_units) do
      local e = find_rig_entity(surface, u, "pipe", ring_pos[i])
      if e and e.valid then e.destroy() end
    end
    if gen then gen.destroy() end
    pump.destroy()
    return fail_key("NO_ROOM_FOR_TANK", "m-no-room-tank", nil, "the pump is ringed with pipes but no storage-tank fits beyond them",
      { ring_tiles = #ring_units })
  end

  storage.pump_job = {
    key = key, machine = machine, resource = resource,
    surface = surface.index, surface_name = surface.name,
    bench = ground.named ~= true, patch = ground.patch,   -- same provenance as the drill's record
    -- The pump only: the tank changes identity while the rig is proving itself, so it is reaped
    -- through tank_unit/tank_pos, which is the single source of truth for it. Listing it here too
    -- left whichever tank was live at the end standing on the map.
    parts = { { unit = pump.unit_number, name = machine, pos = pump.position } },
    ring_specs = (function()
      local out = {}
      for i, u in ipairs(ring_units) do
        out[#out + 1] = { unit = u, name = "pipe", pos = ring_pos[i] }
      end
      return out
    end)(),
    tank_unit = tank.unit_number, tank_pos = tank_at,
    powered = gen and "electric-energy-interface" or nil,
    power_attempts = attempts,
    fluids = {}, harvested = 0, ring_tiles = #ring_units,
    phase = "prove", prove_deadline = game.tick + PROVE_TICKS, prove_ticks = PROVE_TICKS,
    window_ticks = seconds * 60, tank_options = tank_options,
    amount_before = amount_before, tile_count = tile_count, tile_biggest = tile_biggest,
    started = game.tick, deadline = game.tick + seconds * 60,
    clock_speed = speed,
    prev_speed = game.speed, prev_paused = game.tick_paused, state = "running",
  }
  if gen then
    storage.pump_job.parts[#storage.pump_job.parts + 1] =
      { unit = gen.unit_number, name = "electric-energy-interface", pos = gen.position }
  end
  host.clock_raise(speed, true)
  return { state = "running", machine = machine, resource = resource, seconds = seconds,
           clock = host.clock_note(speed, seconds),
           field_tiles = tile_count, powered_by = storage.pump_job.powered,
           power_attempts = attempts,
           died = storage.pump_dead, runner = storage.pump_error,
           note = "call again for the result; the rig runs on the same tick runner the lab and the drill use" }
end

-- Read whatever the tank holds, remember it against its fluid name, and empty the tank so the
-- next tick can fill it again. Temperatures come along because hot and cold water are different
-- products to a refinery even though the name is the same.
-- Accumulate whatever the tank gained since the last read. The tank is deliberately NOT emptied: a
-- storage tank connected to a pump is drained through its own output box, so emptying it from
-- script fights the network and under-counts (which is exactly what an earlier version of this
-- function did). Whatever is left standing at the end is reported as `residue_left` rather than
-- silently dropped.
local -- `counting` is false while the window is still paying off the fluid that was already on its way
-- when it opened; those gains are booked to `j.discarded` instead of the rate.
function collect_tank(j, counting)
  local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
  if not surface then return 0 end
  local tank = find_rig_entity(surface, j.tank_unit, "storage-tank", j.tank_pos)
  if not tank then return 0 end
  local ok, contents = pcall(function() return tank.get_fluid_contents() end)
  if not ok then
    j.probe_error = tostring(contents)
    return 0
  end
  local total = 0
  for name, data in pairs(contents or {}) do
    local amount = type(data) == "number" and data or ((type(data) == "table" and data.amount) or 0)
    local seen = j.fluids[name] or { units = 0, last = 0 }
    -- The baseline is what was in the tank when it was last *drained*, not the last amount seen:
    -- reading the contents before clearing and storing that as the baseline made every later tick
    -- differ against its own previous peak, so a pump that had filled the tank hundreds of times
    -- was counted as producing almost nothing.
    local delta = amount - (seen.last or 0)
    if delta > 0 then
      if counting then
        seen.units = seen.units + delta
        if not seen.first_tick then seen.first_tick = game.tick end
        seen.last_tick = game.tick
      else
        j.discarded = (j.discarded or 0) + delta
      end
      total = total + delta
      seen.max_gain_per_tick = math.max(seen.max_gain_per_tick or 0, delta)
    end
    if type(data) == "table" and data.temperature then seen.temperature = data.temperature end
    seen.last = amount
    seen.held = amount
    j.fluids[name] = seen
  end
  return total
end

local function pump_status_of(j)
  local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
  if not surface then return nil end
  local spec = j.parts and j.parts[1]
  return status_name(spec and find_rig_entity(surface, spec.unit, spec.name, spec.pos))
end

-- A rig is not allowed to measure itself into a number. Before the window opens, the pump has to
-- demonstrate that fluid actually reaches the tank: a ring that is connected to the pump but not
-- to the tank (or a tank that shares no box with the ring) otherwise measures a clean zero, which
-- is the mistake this whole function exists to avoid. Two causes stay two causes: a machine with
-- no power and a machine whose output has nowhere to go.
function step_pump_job()
  local j = storage.pump_job
  if not j or j.state ~= "running" then return end
  -- The pipes and the pump's own box hold a hundred-odd units at any moment. Fluid that entered
  -- them before the window opened still arrives during it, and a 30-second window reads that fixed
  -- backlog as if it were production: the same rig measured 808/min over 30s and 643/min over 120s
  -- until this was taken out. So the window does not start counting until as much has flowed as was
  -- standing in flight, and the clock is pushed along with it.
  local counting = j.phase ~= "prove" and (j.discarded or 0) >= (j.in_flight or 0)
  local gained = collect_tank(j, counting)
  -- proving counts everything, because all it asks is "did anything arrive at all"; measuring
  -- counts only what arrives after the in-flight backlog has been paid off
  if j.phase == "prove" or counting then
    j.harvested = (j.harvested or 0) + gained
  end
  if j.phase ~= "prove" then
    if not counting and gained > 0 then
      j.started = j.started + 1
      j.deadline = j.deadline + 1
    end
    if game.tick >= j.deadline then finish_pump_job() end
    return
  end
  if game.tick < j.prove_deadline then return end
  if j.harvested > 0 then
    local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
    local in_flight = 0
    for _, spec in ipairs(j.ring_specs or {}) do
      local e = find_rig_entity(surface, spec.unit, "pipe", spec.pos)
      if e and e.valid then in_flight = in_flight + fluid_in_tank(e) end
    end
    local pump = find_rig_entity(surface, j.parts[1].unit, j.machine, j.parts[1].pos)
    if pump and pump.valid then in_flight = in_flight + fluid_in_tank(pump) end
    j.phase = "measure"
    j.in_flight = in_flight
    j.discarded = 0
    j.started = game.tick
    j.deadline = game.tick + j.window_ticks
    j.harvested, j.fluids = 0, {}
    return
  end
  local status = pump_status_of(j)
  if status == "no_power" then
    return fail_pump_job(j, "NOT_POWERED", { pump_status = status, tried_tanks = 1 + #j.tank_options })
  end
  local nxt = table.remove(j.tank_options, 1)
  if nxt then
    local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
    local old = find_rig_entity(surface, j.tank_unit, "storage-tank", j.tank_pos)
    if old and old.valid then old.destroy() end
    j.tank_pos = nxt
    local t = surface.create_entity { name = "storage-tank", position = nxt, force = "player" }
    j.tank_unit = t and t.unit_number
    j.tried_tanks = (j.tried_tanks or 1) + 1
    j.prove_deadline = game.tick + j.prove_ticks
    return
  end
  return fail_pump_job(j, "NO_DRAINING_PATH",
    { pump_status = status, ring_tiles = j.ring_tiles, tried_tanks = j.tried_tanks or 1 })
end

-- Take the rig down and say why, without writing a rate that was never measured.
function fail_pump_job(j, reason, detail)
  reap_parts(j)
  storage.pump_dead = { reason = reason, job = j.key, surface = j.surface_name,
                        tick = game.tick, detail = detail }
  j.state = "failed"
  storage.pump_job = nil
  host.clock_lower(j.prev_speed, j.prev_paused)
  return { reason = reason, detail = detail }
end

function finish_pump_job()
  local j = storage.pump_job
  if not j or j.state ~= "running" then return end
  local surface = game.surfaces[j.surface] or game.surfaces[j.surface_name]
  if not surface then
    storage.pump_dead = { reason = "LOST_SURFACE", job = j.key, surface = j.surface_name,
                          wanted_index = tostring(j.surface),
                          wanted_name = tostring(j.surface_name), tick = game.tick }
    host.clock_lower(j.prev_speed, j.prev_paused)
    storage.pump_job = nil
    return
  end
  if j.deadline > game.tick then return end

  j.harvested = (j.harvested or 0) + collect_tank(j, true)
  local elapsed = (game.tick - j.started) / 60
  local pump = find_rig_entity(surface, j.parts[1].unit, j.machine, j.parts[1].pos)
  local status = status_name(pump)
  local after = 0
  for _, e in ipairs(surface.find_entities_filtered { name = j.resource, type = "resource" }) do
    after = after + (e.amount or 0)
  end
  local proto = prototypes.entity[j.machine]
  local list = {}
  for name, seen in pairs(j.fluids) do
    list[#list + 1] = {
      fluid = name, units = seen.units,
      units_per_min = elapsed > 0 and (seen.units / elapsed * 60) or 0,
      temperature = seen.temperature,
      first_unit_after = seen.first_tick and (seen.first_tick - j.started) / 60 or nil,
    }
  end
  table.sort(list, function(a, b) return a.units > b.units end)

  local tank_cap = tank_capacity()
  local drained = j.amount_before - after
  storage.pumps[j.key] = {
    machine = j.machine, resource = j.resource, surface = j.surface_name, fluids = list,
    bench = j.bench or nil, patch = j.patch,
    -- the rate is per GAME minute, so the warp does not bend it; it is recorded because the window that
    -- produced it ran the whole world at that speed, and a reader is entitled to know
    clock_speed = j.clock_speed or 1,
    fluid = list[1] and list[1].fluid or nil,
    units = j.harvested, elapsed_game_seconds = elapsed,
    -- the backlog the window refuses to count, kept in the record so a reader can see the
    -- correction was applied rather than trusting the figure
    in_flight = j.in_flight, discarded_before_window = j.discarded,
    units_per_min = elapsed > 0 and (j.harvested / elapsed * 60) or 0,
    field_tiles = j.tile_count, field_amount_before = j.amount_before, field_amount_after = after,
    field_units_drained = drained,
    tile_amount_mean = (j.tile_count or 0) > 0 and (j.amount_before / j.tile_count) or 0,
    tile_amount_max = j.tile_biggest,
    -- a field that drains while being pumped is not a steady source: the rate below is the rate
    -- at the start of the window, and the fraction taken out says how long that stays true
    field_drain_fraction = j.amount_before > 0 and (drained / j.amount_before) or 0,
    pump_status = status, pump_power_kw = proto and kw_of(field(proto, "energy_usage") or 0),
    -- three independent channels, and the one that never lies is the field: what left the ground
    -- must equal what arrived in the tank plus what is still in it
    residue_left = (function()
      local held = 0 for _, seen in pairs(j.fluids) do held = held + (seen.held or 0) end
      return held
    end)(),
    tank_capacity = tank_cap,
    max_gain_per_tick = (function()
      local peak = 0 for _, seen in pairs(j.fluids) do peak = math.max(peak, seen.max_gain_per_tick or 0) end
      return peak
    end)(),
    tank_ever_at_capacity = (function()
      for _, seen in pairs(j.fluids) do if (seen.held or 0) >= tank_cap then return true end end
    end)() or nil,
    power_attempts = j.power_attempts, probe_error = j.probe_error,
    ring_tiles = j.ring_tiles,
    -- the machine's own answer is the only proof that a rate exists at all: a window measured on
    -- an unpowered pump yields zero, and zero written down as a rate is worse than no number
    error = status == "no_power" and "NOT_POWERED" or nil,
    remedy = status == "no_power" and "run the rig on a live grid, or pass supply=true" or nil,
    measured_tick = game.tick,
    caveat = rig_caveat(j, "one pump on one field", "the field it stands on")
      .. "; a field's yield depends on its richness, so this is not a property of the pump alone",
  }
  reap_parts(j)
  storage.pump_dead = nil
  j.state = "done"
  storage.pump_job = nil
  host.clock_lower(j.prev_speed, j.prev_paused)
end

-- ============================================================
-- Watching a line the player already built
-- ============================================================
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

function measure.line_watch(args)
  args = args or {}
  storage = storage or {}
  storage.watches = storage.watches or {}
  -- No clock policy is asked for, because no speed is wanted: the point of this measurement is that
  -- it is safe to start while somebody is standing in the factory.
  local asked = args.surface ~= nil and surface_or_default(args.surface) or nil
  if args.surface == nil then
    return fail_key("NO_SURFACE", "m-surface-required", nil, "surface = the surface the box was drawn on")
  end
  if not asked then return fail_key("NO_SURFACE", "m-watch-no-surface", { tostring(args.surface) },
    "no such surface: " .. tostring(args.surface)) end
  local box, why = host.box_bounds(args.area)
  if not box then
    return fail_key("BAD_ARGS", "m-arg-area-scan", nil,
      "area = {left_top = {x,y}, right_bottom = {x,y}} -- the box the selection tool gave", { got = why })
  end
  local seconds = tonumber(args.seconds) or 20
  if seconds < 1 or seconds > 600 then
    return fail_key("BAD_ARGS", "m-watch-window", { tostring(seconds) },
      "seconds must be between 1 and 600, not " .. tostring(seconds), { got = seconds })
  end

  if storage.watch_job and storage.watch_job.deadline <= game.tick then watch_finished() end
  local key = asked.name .. "|" .. string.format("%.0f,%.0f-%.0f,%.0f", box.x1, box.y1, box.x2, box.y2)
  local j = storage.watch_job
  if j and j.key == key then
    return { state = "running", surface = asked.name, key = key,
             seconds_left = (j.deadline - game.tick) / 60, machine_count = j.machine_count }
  end
  if j then
    return fail_key("MEASUREMENT_BUSY", "m-watch-busy", nil, "another watch is already running on this surface",
      { running = j.key, asked = key, seconds_left = (j.deadline - game.tick) / 60 })
  end
  local hit = storage.watches[key]
  if hit and args.refresh ~= true and hit.surface == asked.name then
    hit.cached = true
    return hit
  end
  -- A window that died has to say so to the request that started it, or the player is left staring at
  -- a `seconds_left` that never arrives. Same rule as the two rigs above.
  if storage.watch_error then
    local msg = storage.watch_error
    storage.watch_error = nil
    return fail("MEASUREMENT_ERRORED", "the tick runner raised: " .. msg, { watch_error = msg })
  end
  local dead = storage.watch_dead
  if dead and dead.job == key and args.refresh ~= true then
    storage.watch_dead = nil
    return fail(dead.reason, "that line could not be watched", dead.detail)
  end

  local ok, ents = pcall(function()
    return asked.find_entities_filtered { area = { { box.x1, box.y1 }, { box.x2, box.y2 } } }
  end)
  if not ok then
    return fail_key("SCAN_FAILED", "m-watch-scan-failed", nil, "the box could not be read",
      { err = host.errtext(ents) })
  end
  local snap = census_of(asked, ents)
  if #snap.crafters == 0 then
    return fail_key("NOTHING_TO_WATCH", "m-watch-no-machines", nil,
      "no crafting machine stands in that box", { entities = #(ents or {}) })
  end
  local machines, recipes, unassigned = {}, {}, 0
  for _, c in ipairs(snap.crafters) do
    machines[c.name] = (machines[c.name] or 0) + 1
    if c.recipe then recipes[c.recipe] = (recipes[c.recipe] or 0) + 1 else unassigned = unassigned + 1 end
  end

  storage.watch_job = {
    key = key, surface = asked.name, surface_index = asked.index,
    started = game.tick, deadline = game.tick + math.ceil(seconds * 60),
    box = { x1 = box.x1, y1 = box.y1, x2 = box.x2, y2 = box.y2 },
    machine_count = #snap.crafters, machines = machines, recipes = recipes, unassigned = unassigned,
    out_before = sum_side(snap, "out"), in_before = sum_side(snap, "in_"),
    crafters = snap.crafters,
    clock_speed = 1,
    -- The watch never raises the clock, but it does not own the world either: a rig or a player can
    -- speed the surface up while the window is open, and then the seconds in the answer are game
    -- seconds rather than the ones on a wall. Read at both ends rather than assumed.
    speed_at_start = game.speed,
  }
  return { state = "started", key = key, surface = asked.name,
           machine_count = #snap.crafters, recipes = recipes,
           unassigned = unassigned > 0 and unassigned or nil, seconds = seconds }
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

function measure.step_watch_job()
  local j = storage and storage.watch_job
  if not j then return end
  if game.tick >= j.deadline then watch_finished() end
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

return measure
