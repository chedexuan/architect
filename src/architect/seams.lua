-- Connecting two fluid ports: propose a corridor, verify one, and never lay pipe for a bend.
--
-- Straight runs the rig can decide on its own -- region already proposes a row of pipes along the
-- axis two machines share and lets compose walk it. Anything that has to turn a corner is a
-- different problem: it is path finding through ground that other cards, obstacles and the player's
-- own base occupy, and getting it wrong produces a plan that places fine and moves nothing.
--
-- So this module does the two halves that are actually decidable and leaves the middle to a hand:
--
--   `route`  -- pure geometry. Given two footprints and the cells that are taken, the shortest
--               corridor of free cells that would join them, bends included. A proposal: the rig
--               does not place it.
--   `trace`  -- what is on the ground now. Whether a chain of pipes really runs from one port to
--               the other, how long it is, and whether some foreign fluid is sitting inside it.
--
-- Those two together are what makes "the player connected it" a checkable fact rather than an
-- assumption: the answer to "is this seam closed?" is read from the world, and the answer to "what
-- would close it?" names cells a hand can click.

local host = require("host")

local seams = {}

local MAX_ROUTE = 16

local function key(x, y)
  return math.floor(x * 1000) .. "," .. math.floor(y * 1000)
end

local function unkey(k)
  local a, b = k:match("^(-?%d+),(-?%d+)$")
  return tonumber(a) / 1000, tonumber(b) / 1000
end

local STEPS = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }

-- The unit cells a footprint covers, and the cells that touch it along one edge. Both are stated on
-- the half-tile grid Factorio puts entity centres on, so a 1x1 pipe and a 5x5 refinery agree.
function seams.cells(rect)
  local out, w, h = {}, rect.w or 1, rect.h or 1
  for i = 0, w - 1 do
    for j = 0, h - 1 do
      out[key(rect.x - w / 2 + 0.5 + i, rect.y - h / 2 + 0.5 + j)] = true
    end
  end
  return out
end

function seams.border(rect)
  local inside, out = seams.cells(rect), {}
  for k in pairs(inside) do
    local x, y = unkey(k)
    for _, d in ipairs(STEPS) do
      local nk = key(x + d[1], y + d[2])
      if not inside[nk] and not out[nk] then out[nk] = true end
    end
  end
  return out
end

-- Only the footprints themselves block a corridor. A pipe running beside a machine is the normal
-- shape of a factory, so the cells around an entity are open ground as far as this is concerned.
local function blocked_set(specs)
  local out = {}
  for _, rect in ipairs(specs or {}) do
    for k in pairs(seams.cells(rect)) do out[k] = true end
  end
  return out
end

-- The shortest corridor of free cells joining two footprints, bends included. `hard` cells may not
-- be used at all; a cell belonging to another entity may not be entered either, so the walk stays
-- in open ground. Returns the cells to lay, or nil with how far the search got and why it stopped.
function seams.route(from, to, opts)
  opts = opts or {}
  local limit = opts.limit or MAX_ROUTE
  local taken = blocked_set(opts.blocked)
  local goal = seams.border(to)
  local start, dist, queue = {}, {}, {}
  for k in pairs(seams.border(from)) do
    if not taken[k] then
      start[k] = true
      dist[k] = 0
      queue[#queue + 1] = k
    end
  end
  if not next(start) then return nil, { why = "NO_FREE_CELL_AT_SOURCE" } end
  if start[next(goal)] then return {}, { pipes = 0 } end

  local head, came_from, reached, explored = 1, {}, nil, 0
  while head <= #queue do
    local k = queue[head]
    head = head + 1
    explored = explored + 1
    local x, y = unkey(k)
    for _, d in ipairs(STEPS) do
      local nk = key(x + d[1], y + d[2])
      if goal[nk] then
        came_from[nk] = k
        reached = nk
        break
      end
      if not dist[nk] and not taken[nk] then
        dist[nk] = (dist[k] or 0) + 1
        if dist[nk] <= limit then
          came_from[nk] = k
          queue[#queue + 1] = nk
        end
      end
    end
    if reached then break end
  end
  if not reached then
    return nil, { why = "NO_CORRIDOR_WITHIN_LIMIT", explored = explored, limit = limit }
  end
  local cells, k, lay = {}, reached, 0
  while k do
    local x, y = unkey(k)
    -- every cell of the walk is a pipe that has to stand, including the one touching the source:
    -- leaving that out proposes a run that starts a tile short and connects to nothing
    local already = opts.existing and opts.existing[k] or false
    if not already then lay = lay + 1 end
    cells[#cells + 1] = { x = x, y = y, already = already or nil }
    k = came_from[k]
  end
  table.sort(cells, function(a, b)
    if a.y ~= b.y then return a.y < b.y end
    return a.x < b.x
  end)
  return cells, { pipes = #cells, to_lay = lay }
end

-- ------------------------------------------------------------------- the ground truth ----
local function pipes_near(surface, rect, pad)
  local w, h = rect.w or 1, rect.h or 1
  local reach = (math.max(w, h) / 2) + (pad or 24)
  local out = {}
  for _, p in ipairs(surface.find_entities_filtered { name = "pipe", area = {
    { rect.x - reach, rect.y - reach }, { rect.x + reach, rect.y + reach },
  } }) do
    out[key(p.position.x, p.position.y)] = p
  end
  return out
end

-- Walk the pipes that are actually standing, from one port's border to the other's. Nothing here
-- infers a connection from coordinates: an entity touching the chain is the only evidence the
-- engine gives, and a chain with a gap in it simply does not arrive.
function seams.trace(surface, from, to, fluid)
  local map = pipes_near(surface, from)
  for k, p in pairs(pipes_near(surface, to)) do map[k] = map[k] or p end
  local goal = seams.border(to)
  local queue, seen, came_from, reached = {}, {}, {}, nil
  for k in pairs(seams.border(from)) do
    if map[k] then
      queue[#queue + 1] = k
      seen[k] = true
      if goal[k] then reached = k end
    end
  end
  local head = 1
  while head <= #queue and not reached do
    local k = queue[head]
    head = head + 1
    local x, y = unkey(k)
    for _, d in ipairs(STEPS) do
      local nk = key(x + d[1], y + d[2])
      if map[nk] and not seen[nk] then
        seen[nk] = true
        came_from[nk] = k
        queue[#queue + 1] = nk
        if goal[nk] then reached = nk break end
      end
    end
  end
  local out = { connected = reached and true or false, walked = #queue }
  if not reached then
    -- where the attempt stopped, so the caller can be told which end is missing pipe
    local last = queue[math.max(1, #queue)]
    if last then
      local x, y = unkey(last)
      out.stopped_at = { x = x, y = y }
    end
    out.why = "NO_PIPE_CHAIN"
    return out
  end
  local cells, k, foreign = {}, reached, nil
  while k do
    cells[#cells + 1] = k
    k = came_from[k]
  end
  out.pipes = #cells
  for _, ck in ipairs(cells) do
    local p = map[ck]
    if p and p.valid then
      for name, units in pairs(host.entity_fluids(p)) do
        if units > 0 and name ~= fluid then foreign = foreign or name end
      end
    end
  end
  -- a chain that holds another fluid is not a closed seam for this one: the run exists, and the
  -- wrong thing is inside it, which is a different answer and needs a different fix
  out.foreign = foreign
  out.connected = foreign == nil
  if foreign then out.why = "SEAM_HOLDS_OTHER_FLUID" end
  return out
end

return seams
