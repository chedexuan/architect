-- Compose: several cards become one card.
--
-- The seam rule is deliberately narrow. Two ports fuse only when they land on the SAME
-- cell AND name the SAME item, which is how real smelting rows are actually built: one
-- chest that stage A drops into and stage B reaches out of. Anything else that overlaps
-- is a mistake and is reported, because "two machines in the same tile" and "a shared
-- buffer of two different items" look similar in the data and are very different in game.
--
-- A fused chest whose item is both produced and consumed inside the region stops being
-- a boundary at all, so it is dropped from ports and from the contract: the region's
-- contract should name what it exports, not what it hands itself.

local Co = {}

local function footprint(e)
  local p = prototypes.entity[e.name]
  local w = (p and p.tile_width) or 1
  local h = (p and p.tile_height) or 1
  return w, h
end

local function cell_of(x, y, w, h)
  return math.floor(x - w / 2 + 0.5), math.floor(y - h / 2 + 0.5)
end

local function key(cx, cy) return cx .. "," .. cy end

-- Two fluid things connect when their footprints share an edge -- the same rule the pump rig had
-- to learn by measurement (a pipe one tile clear of the pump's edge carries nothing at all). The
-- engine will not say which face a box sits on, so this is about edges, not about ports.
local function shares_edge(a, b)
  local function touching(lo_a, hi_a, lo_b, hi_b)
    return hi_b == lo_a - 1 or hi_a == lo_b - 1
  end
  local ax1, ax2 = a.ox, a.ox + a.w - 1
  local ay1, ay2 = a.oy, a.oy + a.h - 1
  local bx1, bx2 = b.ox, b.ox + b.w - 1
  local by1, by2 = b.oy, b.oy + b.h - 1
  local band_x = not (ax2 < bx1 or bx2 < ax1)
  local band_y = not (ay2 < by1 or by2 < ay1)
  return (touching(ax1, ax2, bx1, bx2) and band_y) or (touching(ay1, ay2, by1, by2) and band_x)
end

local function fluid_boxes(name)
  local p = prototypes.entity[name]
  if not p then return false end
  local ok, fb = pcall(function() return p.fluidbox_prototypes end)
  if not ok or not fb then return false end
  return fb[1] ~= nil
end

local function fluids_of(rec, kind)
  local out = {}
  for _, p in ipairs(rec.ports) do
    if p.kind == kind and p.fluid then out[p.fluid] = true end
  end
  return out
end

local function is_container(rec)
  local p = prototypes.entity[rec.name]
  local t = p and p.type
  return t == "container" or t == "logistic-chest"
end

local function items_of(rec, kind)
  local out = {}
  for _, p in ipairs(rec.ports) do
    if p.kind == kind then out[p.item] = true end
  end
  return out
end

local function first_of(set, other)
  for item in pairs(set) do
    if other[item] then return item end
  end
  return nil
end

function Co.compose(slots, opts)
  opts = opts or {}
  local resolve = opts.resolve
  local errors = {}

  local placed = {}
  for si, slot in ipairs(slots or {}) do
    local source = slot.card or (slot.name and resolve and resolve(slot.name))
    if not source then
      errors[#errors + 1] = { code = "UNKNOWN_CARD", at = si, msg = "slot " .. si .. " names no card" }
    else
      local ents = {}
      local dx = (slot.at or {}).x or 0
      local dy = (slot.at or {}).y or 0
      for ei, e in ipairs(source.entities or {}) do
        local w, h = footprint(e)
        local x = (e.position or {}).x
        local y = (e.position or {}).y
        if type(x) ~= "number" or type(y) ~= "number" then
          errors[#errors + 1] = { code = "NO_POSITION", at = si, msg = "slot " .. si .. " entity " .. ei .. " has no position" }
        else
          local ax, ay = x + dx, y + dy
          local ox, oy = cell_of(ax, ay, w, h)
          ents[#ents + 1] = {
            slot = si, slot_entity = ei, name = e.name, direction = e.direction or 0,
            x = ax, y = ay, w = w, h = h, ox = ox, oy = oy, ports = {},
          }
        end
      end
      local by_index = {}
      for _, rec in ipairs(ents) do by_index[rec.slot_entity] = rec end
      local ps = source.ports or {}
      for _, kind in ipairs({ "in", "out" }) do
        for _, port in ipairs(ps[kind] or {}) do
          local rec = by_index[port.entity]
          if rec and (port.item or port.fluid) then
            rec.ports[#rec.ports + 1] = { kind = kind, item = port.item, fluid = port.fluid }
          end
        end
      end
      -- Anchors survive internalisation. A chest that stopped being an external port is
      -- still a real supply point another arm can reach, and dropping it here made a
      -- lane's second outlet invisible to a second consumer.
      for _, a in ipairs(source.anchors or {}) do
        local rec = by_index[a.entity]
        if rec and a.item then rec.ports[#rec.ports + 1] = { kind = a.kind, item = a.item } end
      end
      placed[#placed + 1] = {
        slot = si, name = source.name or ("slot" .. si), entities = ents,
        contract = (source.contract or {}).outputs or {},
        internal_flows = source.internal_flows,
        internal_fluids = source.internal_fluids,
        lanes = source.lanes,
      }
    end
  end
  if #errors > 0 then return nil, "COMPOSE_INPUT_REJECTED", errors end

  -- occupancy: cell -> list of records covering it
  local occ = {}
  for _, slot in ipairs(placed) do
    for _, rec in ipairs(slot.entities) do
      for gx = rec.ox, rec.ox + rec.w - 1 do
        for gy = rec.oy, rec.oy + rec.h - 1 do
          local k = key(gx, gy)
          local list = occ[k]
          if not list then list = {}; occ[k] = list end
          list[#list + 1] = rec
        end
      end
    end
  end

  local dropped, fusions = {}, {}
  for cell, list in pairs(occ) do
    if #list > 1 then
      local a = list[1]
      local fused_any = false
      for i = 2, #list do
        local b = list[i]
        local item
        if a.slot ~= b.slot and is_container(a) and is_container(b)
          and a.w == 1 and a.h == 1 and b.w == 1 and b.h == 1 then
          -- one side must be dropping in and the other taking out, for the same item
          for _, pair in ipairs({ { a, b }, { b, a } }) do
            local found = first_of(items_of(pair[1], "out"), items_of(pair[2], "in"))
            if found then
              item = found
              a, b = pair[1], pair[2]
            end
          end
        end
        if item then
          dropped[b] = true
          fusions[#fusions + 1] = { cell = cell, item = item,
            kept = a.name .. "(slot " .. a.slot .. "#" .. a.slot_entity .. ")",
            absorbed = b.name .. "(slot " .. b.slot .. "#" .. b.slot_entity .. ")" }
          for _, p in ipairs(b.ports) do a.ports[#a.ports + 1] = p end
          fused_any = true
        end
      end
      if not fused_any then
        local who = {}
        for _, r in ipairs(list) do who[#who + 1] = "slot" .. r.slot .. ":" .. r.name end
        errors[#errors + 1] = { code = "SLOT_OVERLAP", cell = cell, msg = cell .. " is covered by " .. table.concat(who, " + ") }
      end
    end
  end

  local survivors = {}
  for _, slot in ipairs(placed) do
    for _, rec in ipairs(slot.entities) do
      if not dropped[rec] then survivors[#survivors + 1] = rec end
    end
  end
  if #survivors == 0 then return nil, "NOTHING_TO_COMPOSE", { { code = "EMPTY", msg = "no entities survived" } } end

  local minx, miny = 0, 0
  if not opts.no_rebase then
    minx, miny = math.huge, math.huge
    for _, rec in ipairs(survivors) do
      minx = math.min(minx, rec.x - rec.w / 2)
      miny = math.min(miny, rec.y - rec.h / 2)
    end
  end

  table.sort(survivors, function(p, q)
    if p.ox ~= q.ox then return p.ox < q.ox end
    if p.oy ~= q.oy then return p.oy < q.oy end
    return p.name < q.name
  end)

  -- A fluid seam is sealed, not fused: a pipe and a tank each hold fluid and neither can absorb
  -- the other, so both entities stay and only the ports disappear. Sealing is what stops a region
  -- from advertising crude-oil in and crude-oil out as two boundaries when the two cards already
  -- touch.
  --
  -- Two machines that do NOT touch can still be connected, but only by a chain that exists in
  -- this card: whoever laid the cards out may claim a run of pipe fits, and may even be right,
  -- but a claim is not a connection. So the chain is made of real entities here and is walked
  -- here -- a seal needs pipe on every cell from one machine's border to the other's, each link
  -- sharing an edge with the next. A gap anywhere in it leaves both ports open, which is the
  -- honest answer and the one the card's own fluid rule can then complain about.
  -- integer-thousandths keys: every Factorio position here lands on a half tile, so scaling by
  -- 1000 keeps cell identity exact without floating-point comparison
  local function cell_key(x, y) return tostring(math.floor(x * 1000 + 0.5)) .. "," .. tostring(math.floor(y * 1000 + 0.5)) end
  local function split_key(k)
    local a, b = k:match("^(-?%d+),(-?%d+)$")
    return tonumber(a), tonumber(b)
  end
  -- the unit cells an entity covers, on the half-tile grid Factorio centres them on
  local function cells_of(rec)
    local out, w, h = {}, rec.w or 1, rec.h or 1
    for i = 0, w - 1 do
      for j = 0, h - 1 do
        out[cell_key(rec.x - w / 2 + 0.5 + i, rec.y - h / 2 + 0.5 + j)] = true
      end
    end
    return out
  end
  -- whether the cell at (X,Y) is on the border of a covered cell -- not covered itself, and
  -- sharing exactly one edge
  local function on_border(cells, X, Y)
    if cells[cell_key((X - 1000) / 1000, Y / 1000)] or cells[cell_key((X + 1000) / 1000, Y / 1000)]
      or cells[cell_key(X / 1000, (Y - 1000) / 1000)] or cells[cell_key(X / 1000, (Y + 1000) / 1000)] then
      return true
    end
    return false
  end

  local pipes = {}
  for _, rec in ipairs(survivors) do
    if rec.name == "pipe" then pipes[cell_key(rec.x, rec.y)] = true end
  end
  local pipe_links = {}
  for key in pairs(pipes) do
    local X, Y = split_key(key)
    for _, d in ipairs({ { 1000, 0 }, { -1000, 0 }, { 0, 1000 }, { 0, -1000 } }) do
      local nb = cell_key((X + d[1]) / 1000, (Y + d[2]) / 1000)
      if pipes[nb] then
        pipe_links[key] = pipe_links[key] or {}
        pipe_links[key][#pipe_links[key] + 1] = nb
      end
    end
  end

  -- pipes laid end to end from one machine's border to the other's; the count is how many pipes
  -- the run needed, which is the number a caller has to build
  local function chain_between(a, b)
    local ca, cb = cells_of(a), cells_of(b)
    local start, goal = {}, {}
    for key in pairs(pipes) do
      local X, Y = split_key(key)
      local x, y = X / 1000, Y / 1000
      if on_border(ca, X, Y) then start[key] = true end
      if on_border(cb, X, Y) then goal[key] = true end
    end
    if not next(start) or not next(goal) then return nil end
    for key in pairs(start) do if goal[key] then return 1 end end
    local dist, frontier = {}, { start }
    for key in pairs(start) do dist[key] = 1 end
    local depth = 1
    while #frontier > 0 do
      local nxt = {}
      local any = false
      for _, set in ipairs(frontier) do
        for key in pairs(set) do
          for _, nb in ipairs(pipe_links[key] or {}) do
            if not dist[nb] then
              dist[nb] = depth + 1
              nxt[nb] = true
              any = true
              if goal[nb] then return depth + 1 end
            end
          end
        end
      end
      if not any then return nil end
      frontier = { nxt }
      depth = depth + 1
    end
    return nil
  end

  local seams, sealed = {}, {}
  for i = 1, #survivors do
    for j = i + 1, #survivors do
      local a, b = survivors[i], survivors[j]
      if a.slot ~= b.slot and fluid_boxes(a.name) and fluid_boxes(b.name) then
        local via = shares_edge(a, b) and 0 or chain_between(a, b)
        if via then
          local fluid = first_of(fluids_of(a, "out"), fluids_of(b, "in"))
            or first_of(fluids_of(b, "out"), fluids_of(a, "in"))
          if fluid then
            sealed[a] = sealed[a] or {}
            sealed[b] = sealed[b] or {}
            sealed[a][fluid] = true
            sealed[b][fluid] = true
            seams[#seams + 1] = {
              fluid = fluid,
              from = a.name .. "(slot " .. a.slot .. "#" .. a.slot_entity .. ")",
              into = b.name .. "(slot " .. b.slot .. "#" .. b.slot_entity .. ")",
              via_pipes = via > 0 and via or nil,
            }
          end
        end
      end
    end
  end

  local entities, ports_in, ports_out = {}, {}, {}
  local index_of = {}
  for i, rec in ipairs(survivors) do
    -- rebasing on the shared min keeps alignment: an aligned centre always has
    -- x - w/2 integral, so subtracting an integer min leaves it on the right parity
    entities[i] = {
      name = rec.name, direction = rec.direction,
      position = { x = rec.x - minx, y = rec.y - miny },
    }
    index_of[rec] = i
  end

  -- Internalisation is not re-derivable from the merged card: once an item is dropped
  -- from ports, the next composition can no longer see that the chest hosting it is a
  -- shared buffer, so it would silently re-externalise it. Carry it forward explicitly.
  local internal = {}
  for _, slot in ipairs(placed) do
    for _, item in ipairs(slot.internal_flows or {}) do internal[item] = true end
  end
  -- fluids keep their own internal set: `internal_flows = { "crude-oil" }` would be read by every
  -- item-side consumer of the merged card as a claim that a crude-oil item moves inside it
  local internal_fluid = {}
  for _, slot in ipairs(placed) do
    for _, fluid in ipairs(slot.internal_fluids or {}) do internal_fluid[fluid] = true end
  end

  local anchors, anchor_seen = {}, {}
  local function add_anchor(kind, item, fluid, i)
    -- one key space for the dedupe only; the record itself keeps `item` and `fluid` as separate
    -- fields, because an item and a fluid that share a name are not the same obligation
    local k = kind .. "|" .. (item or ("fluid:" .. tostring(fluid))) .. "|" .. i
    if not anchor_seen[k] then
      anchor_seen[k] = true
      anchors[#anchors + 1] = { kind = kind, item = item, fluid = fluid, entity = i }
    end
  end

  for _, rec in ipairs(survivors) do
    local i = index_of[rec]
    local has_in, has_out = {}, {}
    local has_fin, has_fout = {}, {}
    for _, p in ipairs(rec.ports) do
      if p.item then
        add_anchor(p.kind, p.item, nil, i)
        if p.kind == "in" then has_in[p.item] = true else has_out[p.item] = true end
      else
        add_anchor(p.kind, nil, p.fluid, i)
        if p.kind == "in" then has_fin[p.fluid] = true else has_fout[p.fluid] = true end
      end
    end
    for item in pairs(has_in) do
      if has_out[item] then
        internal[item] = true
      elseif not internal[item] then
        ports_in[#ports_in + 1] = { item = item, entity = i }
      end
    end
    for item in pairs(has_out) do
      if not has_in[item] and not internal[item] then
        ports_out[#ports_out + 1] = { item = item, entity = i }
      end
    end
    -- a fluid that the card both takes and gives at the same entity is moving through it, which
    -- is not a boundary; a seam sealed against a neighbour card is likewise internal
    --
    -- `internal_fluid` is deliberately NOT consulted here. It is keyed by fluid, and one fluid can
    -- meet two obligations in one region: the tank that feeds a sealed refinery has closed its
    -- crude-oil boundary, while a second refinery standing where no pipe reaches still needs
    -- crude-oil from somewhere. Suppressing by fluid made that second consumer's port vanish --
    -- the card then exported two petroleum-gas boundaries and admitted no crude input at all.
    -- Sealing already removed the closed entity's port record, so per-entity is enough.
    for fluid in pairs(has_fin) do
      if has_fout[fluid] or (sealed[rec] and sealed[rec][fluid]) then
        internal_fluid[fluid] = true
      else
        ports_in[#ports_in + 1] = { fluid = fluid, entity = i }
      end
    end
    for fluid in pairs(has_fout) do
      -- the same test from the other side: a sealed or self-consumed fluid must not also be
      -- advertised as an export, or the region claims a boundary it has already closed
      if not has_fin[fluid] and not (sealed[rec] and sealed[rec][fluid]) then
        ports_out[#ports_out + 1] = { fluid = fluid, entity = i }
      end
    end
  end
  table.sort(anchors, function(a, b)
    if a.kind ~= b.kind then return a.kind < b.kind end
    if a.entity ~= b.entity then return a.entity < b.entity end
    return a.item < b.item
  end)
  table.sort(ports_in, function(a, b) return a.entity < b.entity or (a.entity == b.entity and a.item < b.item) end)
  table.sort(ports_out, function(a, b) return a.entity < b.entity or (a.entity == b.entity and a.item < b.item) end)

  local contract = {}
  for _, slot in ipairs(placed) do
    for item, rate in pairs(slot.contract) do
      if not internal[item] then contract[item] = (contract[item] or 0) + rate end
    end
  end
  -- "a region must export something" is a policy about the FINISHED region, not about
  -- the geometry: a producer merged with a bus has no exports yet because its consumers
  -- have not been attached, and failing the merge here made incremental layout
  -- impossible -- the bus could never connect to its furnace at all. Flag it and let
  -- the caller decide whether composing is done.
  local no_exports = next(contract) == nil
  if #errors > 0 then return nil, errors[1].code, errors end

  table.sort(fusions, function(a, b) return a.cell < b.cell end)
  local internal_list = {}
  for item in pairs(internal) do internal_list[#internal_list + 1] = item end
  table.sort(internal_list)

  -- A region built out of belt lanes still has those lanes; dropping them here would make
  -- the composed card blind to its own carrying capacity, which is exactly the claim the
  -- flow arithmetic needs in order to refuse an undeliverable rate.
  local lanes = {}
  for _, slot in ipairs(placed) do
    for _, ln in ipairs(slot.lanes or {}) do lanes[#lanes + 1] = ln end
  end

  return {
    name = "composed-" .. #placed .. "-cards",
    entities = entities,
    ports = { ["in"] = ports_in, out = ports_out },
    contract = { outputs = contract },
    internal_flows = internal_list,
    internal_fluids = (function()
      local out = {}
      for fluid in pairs(internal_fluid) do out[#out + 1] = fluid end
      table.sort(out)
      return #out > 0 and out or nil
    end)(),
    anchors = anchors,
    lanes = #lanes > 0 and lanes or nil,
    no_exports = no_exports or nil,
    report = {
      slots = (function()
        local out = {}
        for _, slot in ipairs(placed) do out[#out + 1] = { slot = slot.slot, name = slot.name, entities = #slot.entities } end
        return out
      end)(),
      fusions = fusions,
      seams = seams,
      internal_flows = (function()
        local out = {}
        for item in pairs(internal) do out[#out + 1] = item end
        table.sort(out)
        return out
      end)(),
    },
  }
end

return Co
