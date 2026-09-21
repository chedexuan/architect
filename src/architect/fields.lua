-- How much extractable ground exists, and how many machines can actually stand on it.
--
-- A plan that says "ten pumpjacks" has only answered a rate question. The map has to answer a
-- placement question as well: crude oil comes in patches, a pumpjack occupies 3x3 tiles, and two
-- machines cannot stand in the same tiles. Ten pumps on a field that fits four is a plan nobody can
-- build, and nothing in the rate arithmetic would ever notice.
--
-- The packing here is deliberately crude in the way a player is crude: candidates are the ore tiles
-- themselves (a pump centred on ore always has something to pull), taken in a fixed order, and each
-- accepted one claims its footprint so the next cannot overlap it. That is a lower bound on what
-- fits, not the maximum -- which is the right direction to be wrong in, because a plan that is told
-- it has fewer slots than it really does will ask for more fields, not build machines through each
-- other.

local host = require("host")

local fields = {}

local function key(x, y)
  return math.floor(x * 1000) .. "," .. math.floor(y * 1000)
end

local function unkey(k)
  local a, b = k:match("^(-?%d+),(-?%d+)$")
  return tonumber(a) / 1000, tonumber(b) / 1000
end

-- Every tile of one resource name, keyed by position, with the amount still in the ground.
--
-- The name filter is not decoration: an unfiltered `find_entities_filtered` walks the whole
-- surface, and a nil fluid name here would turn a survey into a scan of every entity on the map.
local function tiles_of(surface, resource)
  if type(resource) ~= "string" then return nil, 0 end
  local out, units = {}, 0
  for _, e in ipairs(surface.find_entities_filtered { name = resource, type = "resource" }) do
    out[key(e.position.x, e.position.y)] = e.amount or 0
    units = units + (e.amount or 0)
  end
  return out, units
end

-- The connected blobs within a resource: ore tiles touching edge to edge are one field, because
-- that is the unit a player reasons about ("the field by the lake holds about nine pumps").
function fields.patches(surface, resource)
  local tiles, units = tiles_of(surface, resource)
  if not tiles then return {}, 0 end
  local seen, out = {}, {}
  for start in pairs(tiles) do
    if not seen[start] then
      local queue, patch = { start }, { tiles = 0, units = 0, cells = {} }
      seen[start] = true
      local head = 1
      while head <= #queue do
        local k = queue[head]
        head = head + 1
        local x, y = unkey(k)
        patch.tiles = patch.tiles + 1
        patch.units = patch.units + tiles[k]
        patch.cells[#patch.cells + 1] = { x = x, y = y }
        for _, d in ipairs({ { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }) do
          local nk = key(x + d[1], y + d[2])
          if tiles[nk] and not seen[nk] then
            seen[nk] = true
            queue[#queue + 1] = nk
          end
        end
      end
      out[#out + 1] = patch
    end
  end
  -- cells are handed out in hash order, and the first cell is what ties two same-size patches
  -- apart below -- so order them, or the "deterministic" report still moves between runs
  for _, p in ipairs(out) do
    table.sort(p.cells, function(a, b)
      if a.y ~= b.y then return a.y < b.y end
      return a.x < b.x
    end)
  end
  -- deterministic order, because a packing count that changes with table iteration order is not a
  -- number anyone can plan against
  table.sort(out, function(a, b)
    if a.tiles ~= b.tiles then return a.tiles > b.tiles end
    return a.cells[1].x < b.cells[1].x
  end)
  return out, units
end

-- How many machines of `machine` fit on one patch, taken greedily in a fixed scan order.
--
-- `need` and `budget` are not optimizations, they are what keeps the answer honest. A survey that
-- asks the engine about every ore tile can cost thousands of calls in one tick on a big map, and a
-- caller who only wanted to know whether ten pumps fit does not need the four hundredth tile
-- examined. Either way the count returned is a lower bound with `stopped` naming why it stopped,
-- so nobody reads "at least 10" as "exactly 10".
function fields.slots(surface, machine, patch, force_name, need, budget)
  local pr = prototypes.entity[machine]
  local w, h = (pr and pr.tile_width) or 1, (pr and pr.tile_height) or 1
  local taken = {}
  local candidates = {}
  for _, c in ipairs(patch.cells) do candidates[#candidates + 1] = c end
  table.sort(candidates, function(a, b)
    if a.y ~= b.y then return a.y < b.y end
    return a.x < b.x
  end)
  local placed, blocked, examined, stopped = 0, 0, 0, "all"
  for _, c in ipairs(candidates) do
    if need and placed >= need then
      stopped = "need"
      break
    elseif budget and examined >= budget then
      stopped = "budget"
      break
    end
    examined = examined + 1
    local overlaps = false
    for i = 0, w - 1 do
      for j = 0, h - 1 do
        if taken[key(c.x - w / 2 + 0.5 + i, c.y - h / 2 + 0.5 + j)] then overlaps = true end
      end
    end
    if overlaps then
      blocked = blocked + 1
    elseif surface.can_place_entity { name = machine, position = { x = c.x, y = c.y },
                                       force = force_name or "player" } then
      placed = placed + 1
      for i = 0, w - 1 do
        for j = 0, h - 1 do
          taken[key(c.x - w / 2 + 0.5 + i, c.y - h / 2 + 0.5 + j)] = true
        end
      end
    else
      blocked = blocked + 1
    end
  end
  return { placed = placed, blocked = blocked, examined = examined, stopped = stopped }
end

-- One call's worth of everything the ground can say about a fluid: how much of it there is, in how
-- many fields, and how many machines fit on it. `infinite` is reported per field because the map
-- setting is what decides whether the units figure means anything at all.
--
-- `need` is the caller's real question -- "does my plan fit" -- and passing it lets the scan stop
-- as soon as the answer is yes. Without it the whole map is walked, which on a large field is a
-- lot of engine calls for a number nobody asked about, so there is a budget either way.
function fields.survey(surface, resource, machine, force_name, opts)
  opts = opts or {}
  local patches, units = fields.patches(surface, resource)
  local budget = opts.budget or 2000
  local spent, slots_total, out, complete = 0, 0, {}, true
  for _, p in ipairs(patches) do
    local r = { placed = 0, blocked = 0, examined = 0, stopped = "no machine" }
    if machine then
      r = fields.slots(surface, machine, p, force_name, opts.need, budget - spent)
      spent = spent + r.examined
      if spent >= budget and r.stopped == "budget" then complete = false end
    end
    slots_total = slots_total + r.placed
    local first = p.cells[1]
    out[#out + 1] = {
      tiles = p.tiles, units = p.units, slots = r.placed, blocked_tiles = r.blocked,
      tiles_left_untested = p.tiles - r.examined, stopped = r.stopped,
      at = { x = first.x, y = first.y },
    }
  end
  local n = 0
  for _, p in ipairs(out) do n = n + p.tiles end
  local pr = prototypes.entity[resource]
  return {
    resource = resource, surface = host.field(surface, "name") or "?",
    tiles = n, units = units, fields = out, slots = slots_total,
    infinite = (pr and pr.infinite_resource) or false,
    -- the count is a greedy lower bound, and the difference between "fits" and "does not fit" is a
    -- plan the player can build -- so say how it was arrived at rather than presenting it as fact
    slots_method = "greedy packing over ore tiles, scan order by y then x: a lower bound",
    slots_complete = complete, budget_used = spent,
    machine = machine,
  }
end

-- Storage as a function of what it has to hold: a buffer is asked for in seconds, and a tank is
-- counted in units of whatever this install's storage tank actually holds. Both sides come back,
-- because tank count is a rounded-up figure and the seconds those whole tanks really buffer are
-- not the seconds that were asked for.
function fields.tanks_for(per_min, seconds, capacity)
  local cap = capacity or host.tank_capacity()
  local want = (per_min / 60) * (seconds or 60)
  local tanks = math.ceil(want / cap)
  local held = tanks * cap
  return {
    per_min = per_min, seconds_wanted = seconds, capacity_each = cap,
    units_wanted = want, tanks = tanks, units_held = held,
    seconds_held = per_min > 0 and (held / (per_min / 60)) or nil,
  }
end

return fields
