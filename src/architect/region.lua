-- Region layout: put several cards on one patch of ground.
--
-- The seam offset is DERIVED, not searched. If a placed card drops its output into a
-- chest at P and the next card takes its input from a chest at local Q, then the only
-- offset that fuses them is P - Q. That is arithmetic, so it belongs to the rules; the
-- engine is then asked the two questions the rules cannot answer -- does the merged
-- geometry still overlap nothing, and does this piece of ground accept it.
--
-- Cards that share no item are not silently scattered: they are packed beside the
-- cluster and reported as needing a bus, because "two lanes that never touch" is a
-- design decision, not a placement detail to hide in a return value.

local seams = require("seams")

local R = {}

local function ports_of(card, kind)
  return ((card.ports or {})[kind]) or {}
end

local function entity_of(card, i)
  return i and card.entities and card.entities[i]
end

-- Anchors, not ports: a chest that became an internal buffer is still a supply point
-- another arm can reach, and reading only the external ports made a lane's second
-- outlet invisible to a second consumer.
local function anchors_of(card, kind)
  local list = {}
  for _, a in ipairs(card.anchors or {}) do
    if a.kind == kind then list[#list + 1] = { item = a.item, fluid = a.fluid, entity = a.entity } end
  end
  if #list == 0 then
    for _, p in ipairs(ports_of(card, kind)) do
      list[#list + 1] = { item = p.item, fluid = p.fluid, entity = p.entity }
    end
  end
  return list
end

-- Every offset that makes one anchor of `placed` coincide with one of `incoming`.
-- BOTH directions are tried: the placed card may be the supplier or the customer, and
-- refusing the second meant a line could only ever grow downstream from whichever card
-- happened to be seeded first -- a bus seeds ahead of its furnace and the chain stalled.
-- How far a run of pipe may reach when two fluid ports are not touching. Bounded because every
-- candidate placement costs a compose, and a layout that needs ten pipes across the map is a
-- layout that should have placed its cards closer together.
local PIPE_MAX = 4

-- The footprints a corridor has to dodge, in plan coordinates: `region_layout` decides where cards
-- go before anything is on the ground, so the obstacles it knows about are the other cards.
local function rects_of(card, shift)
  local out = {}
  for i, e in ipairs(card.entities or {}) do
    if e.position then
      local p = prototypes.entity[e.name]
      out[#out + 1] = { x = e.position.x + (shift and shift.x or 0),
        y = e.position.y + (shift and shift.y or 0), name = e.name, at = i,
        w = (p and p.tile_width) or 1, h = (p and p.tile_height) or 1 }
    end
  end
  return out
end

local function pick(list, at)
  for _, r in ipairs(list) do if r.at == at then return r end end
end

local function tiles_of(e)
  local p = e and prototypes.entity[e.name]
  return (p and p.tile_width) or 1, (p and p.tile_height) or 1
end

local function fuse_offsets(placed, incoming)
  local out = {}
  for _, dir in ipairs({ { "out", "in", "placed_supplies" }, { "in", "out", "incoming_supplies" } }) do
    for _, pa in ipairs(anchors_of(placed, dir[1])) do
      for _, ia in ipairs(anchors_of(incoming, dir[2])) do
        if pa.item and pa.item == ia.item then
          local pe, ie = entity_of(placed, pa.entity), entity_of(incoming, ia.entity)
          if pe and ie and pe.position and ie.position then
            local at = { x = pe.position.x - ie.position.x, y = pe.position.y - ie.position.y }
            local k = at.x .. "," .. at.y
            if not out[k] then
              out[k] = { at = at, item = pa.item, from = pa.entity, to = ia.entity, way = dir[3] }
            end
          end
        elseif pa.fluid and pa.fluid == ia.fluid then
          -- A fluid seam is adjacency, not coincidence: two chests share a cell and one of them
          -- disappears, but a pipe and a tank both stay and have to touch. The four candidates
          -- below put the incoming port on each side of the placed one, and every gap of up to
          -- PIPE_MAX tiles beyond that with a straight run of pipe proposed to fill it. Whether a
          -- candidate is really connected is answered by compose walking that run, not by this
          -- module -- a proposal that leaves a hole in it comes back unsealed and is rejected.
          local pe, ie = entity_of(placed, pa.entity), entity_of(incoming, ia.entity)
          if pe and ie and pe.position and ie.position then
            local pw, ph = tiles_of(pe)
            local iw, ih = tiles_of(ie)
            local bases = {
              { dx = (pw + iw) / 2, dy = 0, ax = 1, ay = 0, w = pw, h = ph },
              { dx = -(pw + iw) / 2, dy = 0, ax = -1, ay = 0, w = pw, h = ph },
              { dx = 0, dy = (ph + ih) / 2, ax = 0, ay = 1, w = pw, h = ph },
              { dx = 0, dy = -(ph + ih) / 2, ax = 0, ay = -1, w = pw, h = ph },
            }
            for _, b in ipairs(bases) do
              for n = 0, PIPE_MAX do
                local at = {
                  x = pe.position.x + b.dx + b.ax * n - ie.position.x,
                  y = pe.position.y + b.dy + b.ay * n - ie.position.y,
                }
                local k = at.x .. "," .. at.y
                if not out[k] then
                  -- the cells a straight run would occupy, from the placed machine's border to
                  -- the incoming one's, on the row/column the two footprints share
                  local cells = {}
                  local first = { x = pe.position.x + b.ax * (b.w / 2 + 0.5),
                                  y = pe.position.y + b.ay * (b.h / 2 + 0.5) }
                  for i = 0, n - 1 do
                    cells[#cells + 1] = { x = first.x + b.ax * i, y = first.y + b.ay * i }
                  end
                  out[k] = { at = at, fluid = pa.fluid, from = pa.entity, to = ia.entity,
                             way = dir[3], pipes = n > 0 and n or nil, pipe_cells = n > 0 and cells or nil }
                end
              end
            end
          end
        end
      end
    end
  end
  local list = {}
  for _, v in pairs(out) do list[#list + 1] = v end
  table.sort(list, function(a, b)
    if (a.item or a.fluid) ~= (b.item or b.fluid) then return (a.item or a.fluid) < (b.item or b.fluid) end
    if (a.item or "") ~= (b.item or "") then return (a.item or "") < (b.item or "") end
    -- touching beats piped, and a short run beats a long one: the cheapest layout that connects is
    -- the one worth trying first, because every pipe here is a tile the ground has to give up
    if (a.pipes or 0) ~= (b.pipes or 0) then return (a.pipes or 0) < (b.pipes or 0) end
    if a.at.x ~= b.at.x then return a.at.x < b.at.x end
    return a.at.y < b.at.y
  end)
  return list
end

local function bbox(card)
  local minx, miny, maxx, maxy = math.huge, math.huge, -math.huge, -math.huge
  for _, e in ipairs(card.entities or {}) do
    local p = prototypes.entity[e.name]
    local w = ((p and p.tile_width) or 1) / 2
    local h = ((p and p.tile_height) or 1) / 2
    minx = math.min(minx, e.position.x - w); maxx = math.max(maxx, e.position.x + w)
    miny = math.min(miny, e.position.y - h); maxy = math.max(maxy, e.position.y + h)
  end
  if minx == math.huge then return 0, 0, 0, 0 end
  return minx, miny, maxx, maxy
end

-- Cards that share no item with the cluster are stacked to its right. They are reported
-- as packed, never as connected: two lanes that touch nothing are a design decision,
-- not a placement detail to bury in a return value.
local function pack_offsets(cluster, incoming, gap)
  local _, cminy, cmaxx, _ = bbox(cluster)
  local _, _, _, imaxy = bbox(incoming)
  local h = math.max(1, imaxy) + gap
  local out = {}
  for i = 0, 11 do
    out[#out + 1] = { at = { x = math.floor(cmaxx + gap), y = math.floor(cminy + i * h) }, packed = true }
  end
  return out
end

function R.layout(entries, opts)
  opts = opts or {}
  local compose = opts.compose
  local fits = opts.fits
  local gap = opts.gap or 2

  local pending = {}
  for i, e in ipairs(entries or {}) do pending[#pending + 1] = { ref = e.ref or ("card" .. i), card = e.card, placed = false } end
  if #pending == 0 then return nil, "NOTHING_TO_LAYOUT", { msg = "no entries" } end

  -- Seed with the card that feeds the most others, so the chain grows outward from the
  -- front of the line instead of being bolted onto whatever happened to come first.
  local function supplied_items(card)
    local out = {}
    -- the "does anything in the cluster already make this" set is item-only; a fluid port has no
    -- item and indexing a table with nil is an error, not a miss
    for _, p in ipairs(ports_of(card, "out")) do
      if p.item then out[p.item] = true end
    end
    return out
  end

  local function supplies_others(wrapper)
    local gives = supplied_items(wrapper.card)
    local n = 0
    for _, other in ipairs(pending) do
      if other ~= wrapper then
        for _, ip in ipairs(ports_of(other.card, "in")) do
          if ip.item and gives[ip.item] then n = n + 1 end
        end
      end
    end
    return n
  end

  table.sort(pending, function(a, b) return supplies_others(a) > supplies_others(b) end)

  local seed = table.remove(pending, 1)
  -- put the frame origin at the seed's own corner, so the cluster is measured from
  -- somewhere that means the same thing for every card that joins it
  local rebased = compose.compose({ { card = seed.card, at = { x = 0, y = 0 } } }, {})
  local merged = rebased or seed.card
  local placements = { { ref = seed.ref, at = { x = 0, y = 0 }, seed = true, entities = #(seed.card.entities or {}) } }
  local log = {}

  local pass = 1
  while #pending > 0 and pass < 6 do
    pass = pass + 1
    local progressed = false
    local pi = 1
    while pi <= #pending do
      local cand = pending[pi]
      local accepted = nil
      local tried = {}
      for _, off in ipairs(fuse_offsets(merged, cand.card)) do
        local specs = { { card = merged, at = { x = 0, y = 0 } }, { card = cand.card, at = off.at } }
        if off.pipe_cells then
          local ents = {}
          for _, c in ipairs(off.pipe_cells) do ents[#ents + 1] = { name = "pipe", position = c } end
          -- the run is proposed as a card of its own, so the only module that decides whether it
          -- connects is the one that walks it
          specs[#specs + 1] = { card = { name = "pipe run", entities = ents,
                                         ports = { ["in"] = {}, out = {} } }, at = { x = 0, y = 0 } }
        end
        local next_merged, code, errors = compose.compose(specs, { no_rebase = true })
        if next_merged and (not fits or fits(next_merged)) then
          if off.fluid then
            local sealed_any = false
            for _, seam in ipairs((next_merged.report or {}).seams or {}) do
              if seam.fluid == off.fluid then sealed_any = true break end
            end
            if not sealed_any then
              -- A straight run did not connect. The next answer is not a longer straight run: it is
              -- a corridor that turns, and turning is the part a human does better than a rule that
              -- cannot see the ground. So the report carries the cells that would close it, and
              -- `seam_check` is what says afterwards whether they really did.
              local mine, theirs = rects_of(merged), rects_of(cand.card, off.at)
              local from, to = pick(mine, off.from), pick(theirs, off.to)
              local ask
              if from and to then
                local blocked = {}
                for _, rc in ipairs(mine) do
                  if rc ~= from and rc.name ~= "pipe" then blocked[#blocked + 1] = rc end
                end
                for _, rc in ipairs(theirs) do
                  if rc ~= to and rc.name ~= "pipe" then blocked[#blocked + 1] = rc end
                end
                local cells, info = seams.route(from, to, { blocked = blocked, limit = 12 })
                ask = cells and { kind = "lay_pipes", pipes = info.to_lay, cells = cells }
                  or { kind = "no_corridor", why = (info or {}).why }
              end
              tried[#tried + 1] = { anchor_out = off.from, anchor_in = off.to, fluid = off.fluid,
                way = off.way, why = "SEAM_NOT_CONNECTED", ask = ask }
            else
              accepted = { at = off.at, fused = off.fluid, sealed = true, from = off.from, to = off.to,
                way = off.way, pipes = off.pipes, merged = next_merged }
              break
            end
          else
            accepted = { at = off.at, fused = off.item, from = off.from, to = off.to, way = off.way, merged = next_merged }
            break
          end
        elseif next_merged then
          tried[#tried + 1] = { anchor_out = off.from, anchor_in = off.to, item = off.item,
            fluid = off.fluid, way = off.way, why = "GROUND_REJECTED" }
        else
          local blockers = {}
          for _, e in ipairs(errors or {}) do
            if e.code == "SLOT_OVERLAP" then blockers[#blockers + 1] = e.cell end
          end
          tried[#tried + 1] = { anchor_out = off.from, anchor_in = off.to, item = off.item,
            fluid = off.fluid, why = (code or "OVERLAP"), blocking_cells = blockers }
        end
      end
      if not accepted then
        for _, off in ipairs(pack_offsets(merged, cand.card, gap)) do
          local next_merged, code = compose.compose(
            { { card = merged, at = { x = 0, y = 0 } }, { card = cand.card, at = off.at } },
            { no_rebase = true })
          if next_merged and (not fits or fits(next_merged)) then
            accepted = { at = off.at, packed = true, merged = next_merged }
            break
          end
        end
      end
      if accepted then
        if accepted.packed then
          -- "packed" without a reason is a dead end for the author: say what was tried,
          -- which cells blocked it, and what an anchor would have to look like instead
          local bx0, by0, bx1, by1 = bbox(cand.card)
          accepted.why_not_fused = tried
          accepted.needed_anchor = { item = (tried[1] or {}).item,
            clear_of = { width = bx1 - bx0, height = by1 - by0 },
            hint = "every existing anchor for this item collides with what is already placed; "
              .. "the producer needs an anchor at least this card's footprint away from the used ones" }
        end
        merged = accepted.merged
        placements[#placements + 1] = { ref = cand.ref, at = accepted.at,
          fused = accepted.fused, packed = accepted.packed, entities = #(cand.card.entities or {}),
          anchor_out = accepted.from, anchor_in = accepted.to, seam = accepted.way,
          why_not_fused = accepted.why_not_fused, needed_anchor = accepted.needed_anchor }
        table.remove(pending, pi)
        progressed = true
      else
        pi = pi + 1
      end
    end
    if not progressed then break end
  end

  local unplaced = {}
  for _, left in ipairs(pending) do
    local wants = {}
    for _, ip in ipairs(ports_of(left.card, "in")) do wants[#wants + 1] = ip.item end
    unplaced[#unplaced + 1] = { ref = left.ref, needs_input = wants,
      why = "no fuse offset fit and no free packing spot beside the cluster" }
  end

  return { card = merged, placements = placements, unplaced = unplaced, rejections = log }, nil, nil
end

return R
