-- Post-placement verification: ask the engine what it actually did.
--
-- Static lint refuses to guess inserter reach or power coverage because only the
-- engine knows. This module places a card, then reads back the truth:
--   * where each arm's hand really picks up and drops (engine-rotated)
--   * whether requested directions survived, or were snapped to something else
--   * which electric network each consumer ended up on, and whether it has supply
--
-- Positions come from the engine; resolving them to entities uses an occupancy map
-- rebuilt from the *actual* placement, so a nudge by the engine cannot make a
-- lookup wrong.

local V = {}

local host = require("host")
local roles = require("roles")

local function field(t, key)
  local ok, v = pcall(function() return t[key] end)
  if not ok then return nil end
  return v
end

local function footprint_of(name)
  local p = prototypes.entity[name]
  return (p and p.tile_width) or 1, (p and p.tile_height) or 1, p and field(p, "type")
end

local function cell_key(gx, gy) return gx .. "," .. gy end
-- Tile n spans [n, n+1), so a position inside it is floor(pos). Not round():
-- pickup_position hands back tile *centres* (x.5), and rounding those pushes the
-- lookup into the neighbouring tile, which reads a correct arm as a broken one.
local function to_cell(v) return math.floor(v) end

local VEC = {
  [defines.direction.north] = { 0, -1 },
  [defines.direction.east]  = { 1, 0 },
  [defines.direction.south] = { 0, 1 },
  [defines.direction.west]  = { -1, 0 },
}

local CONSUMER_KINDS = {
  ["assembling-machine"] = true, ["furnace"] = true, ["inserter"] = true,
  ["mining-drill"] = true, ["electric-energy-distribution-1"] = true,
  ["electric-energy-distribution-2"] = true, ["lab"] = true,
  ["chemical-plant"] = true, ["oil-refinery"] = true, ["centrifuge"] = true,
  ["reactor"] = true, ["boiler"] = true, ["offshore-pump"] = true,
  ["pump"] = true, ["turret"] = true, ["lamp"] = true, ["provider"] = true,
  ["smokestack"] = true, ["transport-belt"] = false,
}

local function occupy(occ, rec)
  for gx = rec.ox, rec.ox + rec.w - 1 do
    for gy = rec.oy, rec.oy + rec.h - 1 do
      occ[cell_key(gx, gy)] = rec
    end
  end
end

local function occupant(occ, pos)
  if type(pos) ~= "table" then return nil end
  return occ[cell_key(to_cell(pos.x), to_cell(pos.y))]
end

-- Inserters are auto-oriented by the engine when their neighbours already exist,
-- so they are placed last and then forced back to what the card asked for.
function V.place(surface, card, origin, force)
  local built, problems = {}, {}
  local order = {}
  for i, e in ipairs(card.entities) do order[#order + 1] = i end

  for pass = 1, 2 do
    for _, i in ipairs(order) do
      local e = card.entities[i]
      local w, h, kind = footprint_of(e.name)
      local is_arm = kind == "inserter"
      if (pass == 2) == is_arm then
        local pos = { x = e.position.x + origin.x, y = e.position.y + origin.y }
        local ok, ent = pcall(function()
          return surface.create_entity { name = e.name, position = pos, direction = e.direction, force = force }
        end)
        if not ok or not ent then
          problems[#problems + 1] = { code = "PLACE_FAILED", at = i, msg = "engine refused to create " .. e.name }
        else
          -- Inserters get auto-oriented by the engine once a neighbour exists, so the
          -- card's direction has to be re-asserted; what survives is the actual geometry.
          if is_arm then pcall(function() ent.direction = e.direction end) end
          local ax, ay = ent.position.x, ent.position.y
          local rec = {
            index = i, name = e.name, kind = kind, entity = ent, w = w, h = h,
            ox = to_cell(ax - w / 2), oy = to_cell(ay - h / 2),
            asked_direction = e.direction, actual_direction = field(ent, "direction"),
          }
          built[i] = rec
        end
      end
    end
  end

  local occ = {}
  for _, rec in pairs(built) do occupy(occ, rec) end
  return built, occ, problems
end

function V.destroy(built)
  local gone = 0
  -- A plan that refused before placing anything carries no `_built` at all, and the refusal is the
  -- answer -- the caller tears down first and reads the error after, so teardown of nothing is a
  -- normal call, not a bug. Raising here turned a clean UNKNOWN_POLE into a raw runtime error.
  for _, rec in pairs(built or {}) do
    if rec.entity and rec.entity.valid then rec.entity.destroy(); gone = gone + 1 end
  end
  return gone
end

-- Two facts decide every power layout: how far a pole's *supply area* reaches, and how
-- far a *wire* reaches to the next pole. Neither is readable from a runtime prototype
-- (`supply_area_distance` is simply absent), so both are measured off live entities --
-- the same trick that replaced guessed inserter reach.
--
-- The measurement also settles the shape: coverage is a square in tile-box Chebyshev
-- distance, not a Euclidean disc. Four pole types x two footprints gave identical axis
-- and diagonal limits, which is what makes placement arithmetic below exact rather than
-- a guess that happens to work on the test card.
local probe_cache = {}

local function measure_facts(surface, force, pole_name)
  if probe_cache[pole_name] then return probe_cache[pole_name] end
  if not surface then return nil end
  local bx, by = -140, -240
  local w, h = footprint_of(pole_name)

  local function fresh()
    local p = surface.find_entities_filtered { area = {
      { bx - 2, by - 2 }, { bx + 60, by + 60 } } }
    for _, e in ipairs(p) do if e.valid then e.destroy() end end
  end
  -- Placed by tile-box origin, the same convention plan_power plants with, so a measured
  -- distance means the same thing on both sides of the comparison.
  local function at(name, x, y, tw, th)
    return surface.create_entity { name = name, position = { x = x + tw / 2, y = y + th / 2 }, force = force }
  end

  fresh()
  local pole = at(pole_name, bx, by, w, h)
  if not pole then return nil end
  local id = field(pole, "electric_network_id")

  -- supply: how far a machine's tile box may sit from the pole's and still join it.
  local function joins_gap(d)
    local e = at("inserter", bx + w - 1 + d, by, 1, 1)
    if not e then return nil end
    local eid = field(e, "electric_network_id")
    local ok = eid ~= nil and eid == id
    e.destroy()
    return ok
  end
  local supply = 0
  for d = 1, 24 do
    local r = joins_gap(d)
    if r == true then supply = d elseif r == false then break end
  end

  -- wire: how far apart two poles of this type may be and still be one network. Measured
  -- centre-to-centre (test pole at tile bx+d, so the centre distance is exactly d for any
  -- footprint), because that is the comparison the trunk makes.
  local wire, misses = 0, 0
  for d = w, 44 do
    local e = at(pole_name, bx + d, by, w, h)
    if e then
      local eid = field(e, "electric_network_id")
      misses = 0
      if eid ~= nil and eid == id then wire = d end
      e.destroy()
    else
      misses = misses + 1
    end
    if wire > 0 and misses > 3 then break end
  end

  fresh()
  if pole.valid then pole.destroy() end

  local facts = { pole = pole_name, supply = supply, wire = wire, w = w, h = h,
                  probes = supply + 44 }
  probe_cache[pole_name] = facts
  return facts
end

-- Exported because "how far does this pole actually reach" has exactly one source: the pole ladder in
-- control.lua orders tiers by that figure, and a second copy of the probe would drift from this one.
V.measure_facts = measure_facts

V.power_facts = measure_facts

-- Chebyshev gap between two inclusive tile ranges on one axis.
local function axis_gap(a0, a1, b0, b1)
  if a1 < b0 then return b0 - a1 end
  if b1 < a0 then return a0 - b1 end
  return 0
end

local function box_gap(a, b)
  return math.max(axis_gap(a.x0, a.x1, b.x0, b.x1), axis_gap(a.y0, a.y1, b.y0, b.y1))
end

-- The measured shape: a pole's supply area is a square, and a machine is inside it when
-- its tile box comes within `supply` tiles of the pole's box.
local function box_covers(supply, pb, cb)
  return box_gap(pb, cb) <= supply
end

local function centre(b) return { x = (b.x0 + b.x1 + 1) / 2, y = (b.y0 + b.y1 + 1) / 2 } end
local function cdist(a, b) return math.max(math.abs(a.x - b.x), math.abs(a.y - b.y)) end

-- Where to put poles is arithmetic once the supply area has been measured; whether a pole
-- actually joined a grid is the engine's call. This does both: it ranks candidates by what
-- the squares say, commits only the winner, and reads back the network id to confirm.
-- Three passes, each with its own honest failure mode -- cover every dark machine, chain
-- the leftover islands into one grid, then put a generator on any island that has none --
-- because "wired to an empty grid" is only half a fix and would measure as success.
function V.plan_power(surface, card, opts)
  opts = opts or {}
  local force = opts.force or "player"
  local origin = opts.origin or { x = 0, y = 0 }
  local supply_name = opts.supply or roles.pick("solar", { prefer = "solar-panel" })
  local max_adds = opts.max_adds or 80
  -- Every placement is an engine call. Without a ceiling a region that cannot be merged
  -- spent 130,000 of them re-trying the same impossible hop; a budget turns that into a
  -- reported failure at a known cost.
  local probe_budget = opts.max_probes or 4000

  local built, occ = V.place(surface, card, origin, force)
  -- The pole to plan with, resolved by `roles`. With no name given, `small-electric-pole` is only a
  -- preference and a save without it gets the shortest pole that actually reaches -- the ladder is
  -- measured, because `supply_area` raises and `connection_distance` is nil on a prototype.
  --
  -- When the caller DOES name one, that name is used exactly. `region_layout` escalates tier by tier
  -- through this same function, so substituting a named pole here would make `poles_tried` report tiers
  -- that were never built with -- and a name that cannot be measured already answers CANNOT_MEASURE_POLE.
  local pole_name, pole_meta = opts.pole, nil
  if pole_name and not roles.exists(pole_name) then
    -- Say what is wrong, and list what is here.
    return { error = "UNKNOWN_POLE", pole = pole_name, known = roles.names("pole"), powered = 0,
             served = 0, still_unserved = 0, to_add = 0, probes = 0, suggestion = {}, _built = nil }
  end
  if not pole_name then
    pole_name, pole_meta = roles.pick("pole", {
      prefer = "small-electric-pole",
      measure_of = function(name)
        local f = measure_facts(surface, force, name)
        return f and f.wire or nil
      end,
    })
  end
  if not pole_name then
    return { error = "NO_POLE_CANDIDATE", pole = opts.pole, powered = 0, served = 0,
             still_unserved = 0, to_add = 0, probes = 0, suggestion = {}, _built = built }
  end
  local facts = measure_facts(surface, force, pole_name)
  if not facts then
    return { error = "CANNOT_MEASURE_POLE", pole = pole_name, powered = 0, served = 0,
             still_unserved = 0, to_add = 0, probes = 0, suggestion = {}, _built = built }
  end
  -- One tile of margin below the measured limit. `wire` is a centre-to-centre figure for
  -- the pair that was probed; multi-tile poles shift that, and a chain only has to be
  -- conservative to be correct because every step is confirmed against the network id.
  local wire_step = math.max(1, (facts.wire > 0 and facts.wire or facts.supply * 3) - 1)

  local function produces(name)
    local p = prototypes.entity[name]
    if not p then return false end
    local ok, v = pcall(function() return p.get_max_energy_production() end)
    return ok and type(v) == "number" and v > 0
  end

  local consumers, members = {}, {}
  for _, rec in pairs(built) do
    local proto = prototypes.entity[rec.name]
    if proto and CONSUMER_KINDS[rec.kind] and field(proto, "electric_energy_source_prototype") then
      consumers[#consumers + 1] = rec
      members[#members + 1] = rec
    elseif rec.kind == "electric-pole" or produces(rec.name) then
      -- Poles and generators carry the grid even though they draw nothing: a chain is
      -- built out of exactly these.
      members[#members + 1] = rec
    end
  end

  local function box(rec)
    return { x0 = rec.ox, y0 = rec.oy, x1 = rec.ox + rec.w - 1, y1 = rec.oy + rec.h - 1 }
  end
  local function net_of(rec)
    if not rec.entity or not rec.entity.valid then return nil end
    return field(rec.entity, "electric_network_id")
  end
  -- "Wired" and "energised" are two different engine answers and mixing them up costs a
  -- whole pass. electric_network_id means the wire exists; is_connected_to_electric_network
  -- is documented as requiring at least one producer on that network, so it reads false for
  -- a perfectly laid-out pole-only card -- which is exactly what a coverage fix is supposed
  -- to produce. Coverage therefore reads the id, and `powered` is the only place the other
  -- predicate belongs.
  local function wired(rec)
    if not rec.entity or not rec.entity.valid then return false end
    return net_of(rec) ~= nil
  end
  local function powered_by_grid(rec)
    if not rec.entity or not rec.entity.valid then return false end
    local ok, v = pcall(function() return rec.entity.is_connected_to_electric_network() end)
    return ok and v and true or false
  end

  -- What the plan has committed, standing on the surface. Keeping the live handles and
  -- the returned suggestion in lockstep is the point: they are appended together, so a
  -- plan cannot report a pole the search never actually fitted.
  local laid, suggestion, probes = {}, {}, 0
  local function out_of_budget() return probes >= probe_budget end

  local function everyone()
    local out = {}
    for _, r in ipairs(members) do out[#out + 1] = r end
    for _, r in ipairs(laid) do out[#out + 1] = r end
    return out
  end
  local function unpowered()
    local out = {}
    for _, r in ipairs(consumers) do if not wired(r) then out[#out + 1] = r end end
    return out
  end
  local function network_ids()
    local seen, out = {}, {}
    for _, r in ipairs(everyone()) do
      local id = net_of(r)
      if id ~= nil and not seen[id] then seen[id] = true; out[#out + 1] = id end
    end
    table.sort(out, function(a, b) return tostring(a) < tostring(b) end)
    return out
  end
  local function is_free(pb)
    for x = pb.x0, pb.x1 do
      for y = pb.y0, pb.y1 do
        if occ[cell_key(x, y)] then return false end
      end
    end
    return true
  end

  -- A planted cell is provisional until the engine agrees it helped. Rollback has to undo
  -- all three records at once -- the entity, the occupancy, and the suggestion -- or a
  -- failed search leaves ghosts that eat the budget and read as additions later.
  local function unplant(rec)
    for x = rec.ox, rec.ox + rec.w - 1 do
      for y = rec.oy, rec.oy + rec.h - 1 do occ[cell_key(x, y)] = nil end
    end
    if rec.entity.valid then rec.entity.destroy() end
    for i = #laid, 1, -1 do
      if laid[i] == rec then table.remove(laid, i); break end
    end
    if #suggestion > 0 then suggestion[#suggestion] = nil end
  end

  local function rollback(to)
    while #laid > to do unplant(laid[#laid]) end
  end

  -- Why a candidate was rejected matters to the caller: "the engine would not put anything
  -- there" means the surface is not what the occupancy map thinks it is, while "it landed and
  -- joined nothing" means the reach arithmetic was wrong. Reporting both as one failure sent
  -- me chasing a phantom trunk bug through a dirty sandbox.
  local blocked_cells = 0
  local function plant(c, name, w, h)
    local p = prototypes.entity[name]
    w = w or (p and p.tile_width) or 1
    h = h or (p and p.tile_height) or 1
    local pb = { x0 = c.x, y0 = c.y, x1 = c.x + w - 1, y1 = c.y + h - 1 }
    if not is_free(pb) then blocked_cells = blocked_cells + 1; return nil end
    local pos = { x = pb.x0 + w / 2, y = pb.y0 + h / 2 }
    if not surface.can_place_entity { name = name, position = pos, force = force } then
      blocked_cells = blocked_cells + 1
      return nil
    end
    local e = surface.create_entity { name = name, position = pos, force = force }
    if not e then blocked_cells = blocked_cells + 1; return nil end
    probes = probes + 1
    local rec = { name = name, entity = e, ox = pb.x0, oy = pb.y0, w = w, h = h, kind = "planted" }
    laid[#laid + 1] = rec
    occupy(occ, rec)
    -- Reported in the card's own frame: the suggestion is appended to `entities` and later
    -- placed again at a fresh origin, so absolute coordinates here would drift by exactly
    -- that origin. (The occupancy map is absolute, which is why the two must be mixed.)
    suggestion[#suggestion + 1] = { name = name, position = {
      x = rec.ox + w / 2 - origin.x, y = rec.oy + h / 2 - origin.y } }
    return rec
  end

  local before = #network_ids()
  local dark0 = #unpowered()

  -- Candidate cells come from arithmetic, and only the winner is committed. That is what
  -- turns a blind scan of the whole ring -- 232 probes for one 12-machine card -- into one
  -- engine call per pole, which is what lets a 59-entity region be planned at all. The
  -- engine still has the last word: a committed cell that raises nobody's coverage is
  -- taken back out and the next candidate gets its turn.
  local function coverage_candidates(dark)
    local seen, out = {}, {}
    for _, rec in ipairs(dark) do
      local b = box(rec)
      for x = b.x0 - facts.supply - facts.w + 1, b.x1 + facts.supply do
        for y = b.y0 - facts.supply - facts.h + 1, b.y1 + facts.supply do
          local pb = { x0 = x, y0 = y, x1 = x + facts.w - 1, y1 = y + facts.h - 1 }
          local k = cell_key(x, y)
          if not seen[k] and is_free(pb) then
            seen[k] = true
            local covers, nearest, links = 0, math.huge, false
            for _, o in ipairs(dark) do
              if box_covers(facts.supply, pb, box(o)) then covers = covers + 1 end
            end
            if covers > 0 then
              for _, m in ipairs(everyone()) do
                local mb = box(m)
                local g = box_gap(pb, mb)
                if g < nearest then nearest = g end
                if g <= 0 or cdist(centre(pb), centre(mb)) <= wire_step then links = true end
              end
              out[#out + 1] = { at = { x = x, y = y }, covers = covers, links = links, near = nearest }
            end
          end
        end
      end
    end
    table.sort(out, function(a, b)
      if a.covers ~= b.covers then return a.covers > b.covers end
      if a.links ~= b.links then return a.links end
      if a.near ~= b.near then return a.near < b.near end
      -- Tie-break toward lower-right, so the attach side of a card stays clear for a bus
      -- or a producer to butt up against later.
      if a.at.y ~= b.at.y then return a.at.y > b.at.y end
      return a.at.x > b.at.x
    end)
    return out
  end

  local coverage_rounds = 0
  while #laid < max_adds and not out_of_budget() do
    local dark = unpowered()
    if #dark == 0 then break end
    local placed = false
    for _, c in ipairs(coverage_candidates(dark)) do
      if out_of_budget() then break end
      local rec = plant(c.at, pole_name, facts.w, facts.h)
      if rec then
        local wins = 0
        for _, o in ipairs(dark) do if wired(o) then wins = wins + 1 end end
        if wins > 0 then
          placed = true
          break
        end
        unplant(rec)
      end
    end
    if not placed then break end
    coverage_rounds = coverage_rounds + 1
  end

  local function group_of(id)
    local g = { id = id, boxes = {}, probe = nil }
    for _, r in ipairs(everyone()) do
      if net_of(r) == id then
        g.boxes[#g.boxes + 1] = box(r)
        if not g.probe then g.probe = r end
      end
    end
    return g
  end
  local function nearest_pair(a, b)
    local best, ba, bb = math.huge, nil, nil
    for _, x in ipairs(a.boxes) do
      for _, y in ipairs(b.boxes) do
        local g = box_gap(x, y)
        if g < best then best, ba, bb = g, x, y end
      end
    end
    return best, ba, bb
  end

  -- A trunk is a chain of poles, not a longer wire: two grids merge when some pole of one
  -- lands inside the other's reach. The walk is best-first over the cells the frontier can
  -- reach, ordered by how little distance is left to the far side, and every hop is accepted
  -- only when the engine reports the new pole joined this network. Two reasons it has to
  -- work that way: a machine is not a wire relay (the first hop must clear its supply area,
  -- not its centre), and in a packed region the straight line between two grids is full of
  -- other people's assemblers, so a chain that cannot sidestep is a chain that reports
  -- "cannot merge" while a route existed three tiles away.
  -- A chain is routed, not searched. Whether a cell would join this network is arithmetic
  -- once the two distances are measured -- inside a member's supply area, or within wire
  -- reach of a member's centre -- so the candidate list only ever contains cells that can
  -- work, and each one costs a single engine call to confirm. The alternative was a
  -- best-first walk over every free tile in reach, which burned 126 probes to merge nothing
  -- and, worse, blacklisted cells that failed early but would have joined once the frontier
  -- grew past them.
  local function gap_to_any(tboxes, pb)
    local best = math.huge
    for _, t in ipairs(tboxes) do
      local g = box_gap(pb, t)
      if g < best then best = g end
    end
    return best
  end

  local function chain_walk(src_probe, tgt_probe)
    local placed, tried = 0, {}
    for _ = 1, 60 do
      if placed >= 40 then return false, "hop_cap", placed end
      -- Compare through live handles, never through a remembered id. Two merging networks
      -- come back with a DIFFERENT number, so "did I just bridge the gap" cannot be
      -- `new_id == target_id` -- that test rejected every successful bridge and unplanted
      -- the one pole that had actually worked, so the walk restarted from where it began.
      local src_id, tgt_id = net_of(src_probe), net_of(tgt_probe)
      if src_id == nil then return false, "source_vanished", placed end
      if src_id ~= nil and src_id == tgt_id then return true, "already_merged", placed end
      local src, tgt = {}, {}
      for _, r in ipairs(everyone()) do
        local id = net_of(r)
        if id == src_id then src[#src + 1] = box(r) end
        if id == tgt_id then tgt[#tgt + 1] = box(r) end
      end
      if #src == 0 or #tgt == 0 then return false, "empty_group", placed end
      local reach = math.max(wire_step, facts.supply + 1)
      local cands = {}
      for _, s in ipairs(src) do
        for x = s.x0 - reach, s.x1 + reach do
          for y = s.y0 - reach, s.y1 + reach do
            local pb = { x0 = x, y0 = y, x1 = x + facts.w - 1, y1 = y + facts.h - 1 }
            local k = cell_key(x, y)
            -- No join predicate here. For 1x1 poles box gap and centre distance coincide, and
            -- for the wider ones the box gap is the *smaller* figure, so the window itself is
            -- already a superset of everything the engine could link; filtering further with
            -- my own model of relay rules only hid cells that worked.
            if not tried[k] and is_free(pb) and box_gap(pb, s) <= reach then
              cands[#cands + 1] = { at = { x = x, y = y }, key = k, to = gap_to_any(tgt, pb) }
            end
          end
        end
      end
      if #cands == 0 then return false, "no_free_cell", placed end
      -- Closest to the far grid first, ties toward the lower-right so the attach side of a
      -- card stays clear for whatever butts up against it later.
      table.sort(cands, function(a, b)
        if a.to ~= b.to then return a.to < b.to end
        if a.at.y ~= b.at.y then return a.at.y > b.at.y end
        return a.at.x > b.at.x
      end)
      local joined = false
      local planted_this_round = 0
      for _, c in ipairs(cands) do
        if out_of_budget() then return false, "probe_budget", placed end
        tried[c.key] = true
        local rec = plant(c.at, pole_name, facts.w, facts.h)
        if rec then
          -- Success is "the two probes now share an id", not "this pole joined the far side":
          -- a pole can land inside the target's reach without ever touching my chain, which
          -- grows the target island and merges nothing.
          local merged = net_of(src_probe)
          local here, there = net_of(rec), net_of(tgt_probe)
          if here ~= nil and there ~= nil and here == there and merged == here then
            return true, "bridged", placed + 1
          end
          if here ~= nil and here == net_of(src_probe) then
            joined = true
            placed = placed + 1
            break
          end
          unplant(rec)
        end
      end
      if not joined then return false, "nothing_joined", placed end
    end
    return false, "round_cap", placed
  end

  -- A chain that gave up must leave nothing standing: the poles it walked through joined
  -- nothing, and reporting them as part of the fix would hand back a grid of islands and
  -- call it progress.
  local function merge_attempt(ga, gb)
    local mark = #laid
    local ok, reason, hops = chain_walk(ga.probe, gb.probe)
    if not ok then rollback(mark) end
    return ok, reason, hops
  end

  local chains, failed, trunk_rounds, unmerged = 0, {}, 0, {}
  -- Network ids are renumbered whenever a network merges or a pole is rolled back, so they
  -- cannot key the "already tried this pair" set -- every round looked like a new pair and
  -- the same impossible hop was retried 60 times. A group's own geometry is stable.
  local function sig(g)
    local parts = {}
    for _, b in ipairs(g.boxes) do parts[#parts + 1] = b.x0 .. "," .. b.y0 end
    table.sort(parts)
    return tostring(#g.boxes) .. ":" .. tostring(parts[1]) .. ":" .. tostring(parts[#parts])
  end
  while #laid < max_adds and trunk_rounds < 24 and not out_of_budget() do
    trunk_rounds = trunk_rounds + 1
    local ids = network_ids()
    if #ids < 2 then break end
    local best = nil
    for i = 1, #ids do
      for j = i + 1, #ids do
        local ga, gb = group_of(ids[i]), group_of(ids[j])
        local key = sig(ga) .. "|" .. sig(gb)
        if not failed[key] then
          if ga.probe and gb.probe then
            local g = nearest_pair(ga, gb)
            if g < (best and best.g or math.huge) then
              best = { g = g, a = ids[i], b = ids[j], ga = ga, gb = gb, key = key }
            end
          else
            failed[key] = true
          end
        end
      end
    end
    if not best then break end
    local was = #ids
    local okjoin, reason, hops = merge_attempt(best.ga, best.gb)
    if okjoin and #network_ids() < was then
      chains = chains + 1
    else
      reason = (okjoin and "count_did_not_drop") or reason
      failed[best.key] = true
      failed[sig(best.gb) .. "|" .. sig(best.ga)] = true
      -- Why a region cannot be joined is as useful to the caller as the count that says it
      -- wasn't: the gap that defeated the walk, and how crowded each side was.
      unmerged[#unmerged + 1] = {
        reason = reason, hops = hops,
        gap = best.g < 1e6 and best.g or nil,
        members_a = #best.ga.boxes, members_b = #best.gb.boxes,
        out_of_adds = #laid >= max_adds, out_of_probes = out_of_budget(),
      }
    end
  end

  -- Connected is not the same as paid for. An island with no generator measures as wired
  -- and starves the instant it runs, so each one gets a supply unit beside it. How MANY
  -- units the load needs is a separate question and is reported rather than guessed here.
  local supply_added, supply_rounds = 0, 0
  while #laid < max_adds and supply_rounds < 12 and not out_of_budget() do
    supply_rounds = supply_rounds + 1
    if not produces(supply_name) then break end
    local lacking = nil
    for _, id in ipairs(network_ids()) do
      local has = false
      for _, r in ipairs(everyone()) do
        if net_of(r) == id and produces(r.name) then has = true end
      end
      if not has then lacking = id; break end
    end
    if not lacking then break end
    local placed = false
    for _, b in ipairs(group_of(lacking).boxes) do
      for r = 0, 8 do
        for dy = -r, r do
          for dx = -r, r do
            if math.abs(dx) == r or math.abs(dy) == r then
              local rec = plant({ x = b.x0 + dx, y = b.y0 + dy }, supply_name)
              if rec then
                if net_of(rec) == lacking then
                  supply_added = supply_added + 1
                  placed = true
                else
                  unplant(rec)
                end
              end
            end
            if placed then break end
          end
          if placed then break end
        end
        if placed then break end
      end
      if placed then break end
    end
    if not placed then
      -- Nothing fits beside this island; leave it reported rather than looping forever.
      break
    end
  end

  -- Land `want` units of a name so they join an existing grid, spiralling out from the
  -- members that are already wired. A unit that lands on no grid is taken back out: a solar
  -- panel in the middle of a field is not supply, it is scenery.
  local function place_units(name, want)
    local anchors = {}
    for _, r in ipairs(everyone()) do
      if net_of(r) ~= nil then anchors[#anchors + 1] = box(r) end
    end
    if #anchors == 0 then
      for _, r in ipairs(consumers) do anchors[#anchors + 1] = box(r) end
    end
    local p = prototypes.entity[name]
    local uw, uh = (p and p.tile_width) or 1, (p and p.tile_height) or 1
    local landed, ring = 0, 0
    while landed < want and ring <= 24 and not out_of_budget() do
      for _, b in ipairs(anchors) do
        for dy = -ring, ring do
          for dx = -ring, ring do
            if landed < want and (math.abs(dx) == ring or math.abs(dy) == ring) then
              local pb = { x0 = b.x0 + dx, y0 = b.y0 + dy, x1 = b.x0 + dx + uw - 1, y1 = b.y0 + dy + uh - 1 }
              -- Rank with arithmetic before paying for a placement: a panel that lands out of
              -- reach of every pole is scenery, and trying every tile around a crowded region
              -- cost 15,000 engine calls for one sized grid.
              if ring <= wire_step + math.max(uw, uh) and box_gap(pb, b) <= wire_step then
                local rec = plant({ x = pb.x0, y = pb.y0 }, name, uw, uh)
                if rec then
                  if net_of(rec) ~= nil then landed = landed + 1 else unplant(rec) end
                end
              end
            end
          end
        end
      end
      ring = ring + 1
    end
    return landed
  end

  -- `size` is how a region stops being "covered" and starts being "able to run": the caller
  -- works out the panel and accumulator counts from the wired demand, and this pass lands
  -- them on the grid, one engine call each, refusing any cell where the unit does not join.
  local sizing
  if opts.size then
    local demand, in_grid = 0, {}
    for _, rec in ipairs(consumers) do
      if opts.power_of then
        local draw = opts.power_of(rec.name)
        demand = demand + (draw or 0)
      end
    end
    for _, r in ipairs(everyone()) do in_grid[r.name] = (in_grid[r.name] or 0) + 1 end
    local units, trail = opts.size(demand, in_grid)
    local placed_by_name, short = {}, {}
    for _, u in ipairs(units or {}) do
      local n = 0
      while n < u.count and #laid < max_adds do
        local landed = place_units(u.name, 1)
        if landed == 0 then break end
        n = n + landed
      end
      placed_by_name[u.name] = (placed_by_name[u.name] or 0) + n
      if n < u.count then short[u.name] = u.count - n end
    end
    sizing = { wanted = units, placed = placed_by_name, short = short, trail = trail }
  end

  local supply_ids = {}
  for _, r in ipairs(everyone()) do
    if produces(r.name) then
      local id = net_of(r)
      if id ~= nil then supply_ids[id] = true end
    end
  end
  local served_now, still_dark = 0, #unpowered()
  for _, rec in ipairs(consumers) do
    local id = net_of(rec)
    if wired(rec) and id ~= nil and supply_ids[id] and powered_by_grid(rec) then served_now = served_now + 1 end
  end

  local demand_kw, supply_kw = 0, 0
  if opts.power_of then
    for _, rec in ipairs(consumers) do
      local draw = opts.power_of(rec.name)
      demand_kw = demand_kw + (draw or 0)
    end
    for _, rec in ipairs(everyone()) do
      local _, cap = opts.power_of(rec.name)
      supply_kw = supply_kw + (cap or 0)
    end
  end

  local after = network_ids()
  for _, r in ipairs(laid) do
    if r.entity.valid then r.entity.destroy() end
  end

  return {
    powered = #consumers,
    served = served_now,
    still_unserved = #consumers - served_now,
    to_add = #suggestion,
    probes = probes,
    suggestion = suggestion,
    probe_budget = probe_budget,
    blocked_cells = blocked_cells,
    exhausted_search = (#laid >= max_adds or out_of_budget() or coverage_rounds == 0)
      and (still_dark > 0 or #after > 1 or served_now < #consumers),
    facts = { pole = pole_name, supply_tiles = facts.supply, wire_tiles = facts.wire,
              wire_step = wire_step, footprint = { facts.w, facts.h }, measured = facts.wire > 0 },
    networks_before = before,
    networks_after = #after,
    networks = after,
    -- the ranking the choice came from. A plan that says "the cheapest sufficient pole won" is only
    -- checkable if the figures behind the ordering travel with it -- and a candidate whose measurement
    -- raised has to show up as a failed measurement, not as one that quietly sorted to the back.
    pole_how = pole_meta and pole_meta.how,
    -- false on the hint-hit path: the menu is listed but nothing was measured, and four unranked
    -- candidates would otherwise read exactly like four measured ones
    ranked = pole_meta and pole_meta.ranked,
    pole_candidates = pole_meta and (function()
      local l = {}
      for _, e in ipairs(pole_meta.candidates or {}) do
        l[#l + 1] = { name = e.name, wire_tiles = e.figure, unlocked = e.unlocked,
                      not_measured = e.figure_error }
      end
      return l
    end)(),
    chains = chains,
    unmerged = unmerged,
    sizing = sizing,
    supply_added = supply_added,
    coverage_rounds = coverage_rounds,
    uncovered_before = dark0,
    uncovered_after = still_dark,
    demand_kw = demand_kw,
    supply_kw = supply_kw,
    pole = pole_name,
    supply = supply_name,
    _built = built,
  }
end

function V.verify(surface, card, opts)
  opts = opts or {}
  local force = opts.force or "player"
  local origin = opts.origin or { x = 0, y = 0 }
  local errors, warnings = {}, {}
  local function add(t, code, msg, at) t[#t + 1] = { code = code, msg = msg, at = at } end

  local built, occ, problems = V.place(surface, card, origin, force)
  for _, p in ipairs(problems) do errors[#errors + 1] = p end

  local nets, consumers, placed = {}, {}, 0
  local uncovered = {}
  local demand_kw, supply_kw, in_card_supply, powered_total = 0, 0, 0, 0
  for _, rec in pairs(built) do
    placed = placed + 1

    local draw, cap = 0, 0
    if opts.power_of then draw, cap = opts.power_of(rec.name) end
    draw, cap = draw or 0, cap or 0
    supply_kw = supply_kw + cap
    if cap > 0 then in_card_supply = in_card_supply + 1 end

    if rec.actual_direction and rec.asked_direction ~= rec.actual_direction then
      add(warnings, "DIRECTION_SNAPPED", string.format("%s asked dir=%s, engine set dir=%s",
        rec.name, tostring(rec.asked_direction), tostring(rec.actual_direction)), rec.index)
    end

    -- Arms: the engine reports where the hand actually reaches, already rotated.
    if rec.kind == "inserter" then
      local pick = occupant(occ, field(rec.entity, "pickup_position"))
      local drop = occupant(occ, field(rec.entity, "drop_position"))
      if not pick then
        add(errors, "ARM_PICKS_NOTHING", rec.name .. " hand reaches an empty cell", rec.index)
      elseif pick.kind == "inserter" then
        add(errors, "ARM_PICKS_FROM_ARM", rec.name .. " picks up from another inserter", rec.index)
      end
      if not drop then
        add(errors, "ARM_DROPS_ON_GROUND", rec.name .. " drops on an empty cell", rec.index)
      elseif drop.kind == "inserter" then
        add(errors, "ARM_DROPS_ON_ARM", rec.name .. " drops onto another inserter", rec.index)
      end
      rec.pickup_target, rec.drop_target = pick and pick.name, drop and drop.name
    end

    -- Belts: an exit tile with nothing on it dumps items on the ground. This is the
    -- runtime confirmation of the BELT_EXITS_CARD lint warning.
    if rec.kind == "transport-belt" then
      local v = VEC[rec.actual_direction or 0]
      if v then
        local nxt = occ[cell_key(rec.ox + v[1], rec.oy + v[2])]
        rec.next = nxt and nxt.name
        if not nxt then add(warnings, "BELT_EXITS_TO_GROUND", rec.name .. " has nothing on its output tile", rec.index) end
      end
    end

    -- A stone furnace is a "furnace" but draws no grid power; only entities that
    -- declare an electric source belong in the coverage check. Whether an entity is
    -- covered is NOT computable statically -- supply_area_distance is absent from the
    -- runtime prototype -- so the engine's network id is the only honest answer.
    local proto = prototypes.entity[rec.name]
    local powered = CONSUMER_KINDS[rec.kind] and proto and field(proto, "electric_energy_source_prototype") ~= nil
    if powered then
      demand_kw = demand_kw + draw
      powered_total = powered_total + 1
      local id = field(rec.entity, "electric_network_id")
      rec.network = id
      if id == nil then
        uncovered[#uncovered + 1] = rec.index
      else
        consumers[rec.index] = id
        local n = nets[id]
        if not n then n = { consumers = 0, producers = 0 }; nets[id] = n end
        n.consumers = n.consumers + 1
      end
    elseif cap > 0 then
      -- a generator / energy interface joins the grid through its own connection
      local id = field(rec.entity, "electric_network_id")
      if id ~= nil then
        local n = nets[id]
        if not n then n = { consumers = 0, producers = 0 }; nets[id] = n end
        n.producers = n.producers + 1
      end
    end
  end

  -- Severity is the useful part. A card with no poles may legitimately be butted
  -- onto the base grid at placement time; a card that brought its own power and still
  -- leaves a machine uncovered has a broken layout, and that is not a warning.
  if #uncovered > 0 then
    local parts = {}
    for i = 1, math.min(#uncovered, 4) do parts[#parts + 1] = tostring(uncovered[i]) end
    local where = table.concat(parts, ",")
    if in_card_supply > 0 then
      add(errors, "OUT_OF_POLE_COVERAGE", #uncovered .. " powered entities are on no grid despite in-card supply (first indices: "
        .. where .. ")", uncovered[1])
    else
      add(warnings, "NEEDS_EXTERNAL_GRID", #uncovered .. " powered entities have no poles or supply inside the card; "
        .. "they must land next to an existing grid (first indices: " .. where .. ")", uncovered[1])
    end
  end

  for id, n in pairs(nets) do
    if n.consumers > 0 and n.producers == 0 then
      add(warnings, "GRID_WITHOUT_SUPPLY", "network " .. tostring(id) .. " has " .. n.consumers
        .. " consumers and no placed supply", id)
    end
  end
  -- Connected is not the same as affordable. A card whose machines want more than it
  -- carries reports it here rather than silently measuring short at night.
  if demand_kw > supply_kw and in_card_supply > 0 then
    add(warnings, "GRID_UNDER_PROVISIONED", string.format(
      "card draws %g kW but carries %g kW of supply; it needs a bigger or external grid", demand_kw, supply_kw))
  end
  if next(nets) and opts.require_single_network then
    local ids = 0
    for _ in pairs(nets) do ids = ids + 1 end
    if ids > 1 then add(warnings, "SPLIT_NETWORKS", ids .. " separate electric networks inside one card") end
  end

  local arms = {}
  for _, rec in pairs(built) do
    if rec.kind == "inserter" then
      arms[#arms + 1] = { at = rec.index, name = rec.name, pickup = rec.pickup_target, drop = rec.drop_target }
    end
  end

  return {
    errors = errors,
    warnings = warnings,
    placed = placed,
    requested = #(card.entities or {}),
    networks = (function()
      local out = {}
      for id, n in pairs(nets) do out[#out + 1] = { id = id, consumers = n.consumers, producers = n.producers } end
      table.sort(out, function(a, b) return tostring(a.id) < tostring(b.id) end)
      return out
    end)(),
    arms = arms,
    power = {
      demand_kw = demand_kw,
      in_card_supply_kw = supply_kw,
      powered_entities = powered_total,
      covered = powered_total - #uncovered,
      uncovered = #uncovered,
      in_card_supply_entities = in_card_supply,
    },
    -- live LuaEntity handles; control.lua strips this before serialising
    _built = built,
  }
end

return V
