-- Getting fluid into a machine, when nothing says where its boxes are.
--
-- Two things the runtime will not give up: which side of a building a fluid box is on, and which
-- cell of that side. `fluid_boxes` is not exposed, `fluidbox_prototypes` gives only in/out, and a
-- placed machine reports an empty box list. What the engine does give is the consequence -- offer
-- fluid at one cell and see whether it disappears -- and that is enough to find the cell, which is
-- what `dev/fluid_box_cells.js` did by hand for an oil refinery: crude at one cell of its south
-- face, water at another, two apart.
--
-- The reason cells matter and faces do not: one face can carry two fluids only if their pipe rows
-- never touch, and a row only reaches the box it is laid over. So a machine whose ingredients share
-- a face has to be plumbed against the cells, and a plan that guesses a face measures a starved
-- card as a card that produces nothing.
--
-- Nothing here claims a layout works. A run reports what its tank actually lost.

local host = require("host")
local tank_capacity = host.tank_capacity
local entity_fluids = host.entity_fluids
local units_of = host.fluid_in_tank

local fluidrig = {}

local PIPE, TANK = "pipe", "storage-tank"

local function metrics(entity)
  local p = prototypes.entity[entity.name]
  return (p and p.tile_width) or 1, (p and p.tile_height) or 1
end

local function unit(face)
  if face == "east" then return 1, 0 end
  if face == "west" then return -1, 0 end
  if face == "south" then return 0, 1 end
  return 0, -1
end

-- The four sides, with `span` cells each: an east or west face is as wide as the machine is tall,
-- because that is the number of tiles its border crosses.
function fluidrig.faces(entity)
  local w, h = metrics(entity)
  return {
    { name = "east",  ux = 1,  uy = 0, span = h },
    { name = "west",  ux = -1, uy = 0, span = h },
    { name = "south", ux = 0,  uy = 1, span = w },
    { name = "north", ux = 0,  uy = -1, span = w },
  }
end

function fluidrig.face(entity, name)
  for _, f in ipairs(fluidrig.faces(entity)) do
    if f.name == name then return f end
  end
end

-- Cell offsets run from -(span-1)/2 to +(span-1)/2 around the machine's centre, so offset 0 is the
-- middle of the face and the extremes are its two ends.
function fluidrig.cell(entity, face, off)
  local f = fluidrig.face(entity, face)
  local ux, uy = unit(face)
  local e = entity.position
  local d = f.span / 2 + 0.5
  return { x = e.x + d * ux + (ux ~= 0 and 0 or off), y = e.y + d * uy + (uy ~= 0 and 0 or off) }
end

-- A tank's port is at the middle of the side it faces, so a tank joins a row only from the cell it
-- is centred behind -- and a tank centred behind the cell its row starts at has been seen holding
-- its fluid instead. Nothing here explains that; the plan simply never anchors on that cell.
local function tank_at(entity, face, off)
  local ux, uy = unit(face)
  local c = fluidrig.cell(entity, face, off)
  local dir
  if ux > 0 then dir = defines.direction.west
  elseif ux < 0 then dir = defines.direction.east
  elseif uy > 0 then dir = defines.direction.north
  else dir = defines.direction.south end
  return { x = c.x + 2 * ux, y = c.y + 2 * uy }, dir
end

-- ------------------------------------------------------------------ box discovery ----
-- An offer is a little of the fluid laid against one cell of the machine. The machine takes it only
-- when that cell is its box.
--
-- What is read is the whole connected pipe network, never one pipe. Fluid does not have to be
-- consumed to move: 50 units offered beside an empty pipe settle to 16.7 in each of three pipes,
-- and a reading taken from the one pipe the offer was put into says "the machine drank it" when
-- nothing left the network at all. That false positive was measured, not imagined -- it named an
-- east-face cell for a refinery whose crude box is on the south face.
local function cell_key(pos)
  return math.floor(pos.x) .. "," .. math.floor(pos.y)
end

local STEPS = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }

-- Every cell a machine's fluid could enter or leave through: the tiles one step outside its border.
local function border_map(entity)
  local out = {}
  for _, f in ipairs(fluidrig.faces(entity)) do
    local lo = -(f.span - 1) / 2
    for i = 0, f.span - 1 do
      out[cell_key(fluidrig.cell(entity, f.name, lo + i))] = { face = f.name, off = lo + i }
    end
  end
  return out
end

local function pipe_map(entity, surface)
  local pr = prototypes.entity[entity.name]
  local reach = math.max(pr.tile_width or 1, pr.tile_height or 1) / 2 + 4
  local e = entity.position
  local out = {}
  for _, pi in ipairs(surface.find_entities_filtered { name = PIPE, area = {
    { e.x - reach, e.y - reach }, { e.x + reach, e.y + reach },
  } }) do
    out[cell_key(pi.position)] = pi
  end
  return out
end

-- One walk of the pipe network the offer belongs to: how much fluid is in it, and which cells of
-- the machine it can reach. Both readings need it, and neither means anything without the other.
local function survey(entity, surface, pipe)
  local map, borders = pipe_map(entity, surface), border_map(entity)
  local start = map[cell_key(pipe.position)]
  if not start then return 0, {} end
  local seen, units, queue, touching = {}, 0, { start }, {}
  while #queue > 0 do
    local cur = table.remove(queue)
    local k = cell_key(cur.position)
    if not seen[k] then
      seen[k] = true
      units = units + units_of(cur)
      local edge = borders[k]
      if edge then touching[#touching + 1] = edge end
      local cx, cy = math.floor(cur.position.x), math.floor(cur.position.y)
      for _, d in ipairs(STEPS) do
        local nxt = map[(cx + d[1]) .. "," .. (cy + d[2])]
        if nxt and nxt.valid then queue[#queue + 1] = nxt end
      end
    end
  end
  return units, touching
end

-- What is left anywhere in the network: fluid that vanished from here went into the machine, while
-- fluid that merely spread to a neighbouring pipe is still counted.
function fluidrig.network_units(entity, surface, pipe)
  return (survey(entity, surface, pipe))
end

-- Every pipe the offered fluid could have wandered into, so an offer made through the card's own
-- plumbing can be taken back out of all of it. Left behind, that fluid would block the run built
-- later on the same cells: a tank of crude next to a pipe holding water fills nothing at all.
function fluidrig.network_pipes(entity, surface, pipe)
  local map = pipe_map(entity, surface)
  local start = map[cell_key(pipe.position)]
  if not start then return {} end
  local seen, out, queue = {}, {}, { start }
  while #queue > 0 do
    local cur = table.remove(queue)
    local k = cell_key(cur.position)
    if not seen[k] then
      seen[k] = true
      out[#out + 1] = cur
      local cx, cy = math.floor(cur.position.x), math.floor(cur.position.y)
      for _, d in ipairs(STEPS) do
        local nxt = map[(cx + d[1]) .. "," .. (cy + d[2])]
        if nxt and nxt.valid and not seen[(cx + d[1]) .. "," .. (cy + d[2])] then
          queue[#queue + 1] = nxt
        end
      end
    end
  end
  return out
end

function fluidrig.offer(entity, surface, force_name, fluid, face, off, amount)
  local pos = fluidrig.cell(entity, face, off)
  local want = amount or 50
  local target, adopted = nil, false
  if surface.can_place_entity { name = PIPE, position = pos, force = force_name } then
    target = surface.create_entity { name = PIPE, position = pos, force = force_name }
  else
    -- The card's own plumbing may already sit on this cell. That is not a dead end -- it is the
    -- best possible case, because the card has already connected that cell to something. Offer
    -- through the pipe that is there, and leave it standing when the reading is done.
    local here = surface.find_entities_filtered { name = PIPE, position = pos, radius = 0.1 }
    if here[1] then target, adopted = here[1], true end
  end
  if not target then return nil end
  local give_up = function()
    if not adopted and target.valid then target.destroy() end
    return nil
  end
  local units, touching = survey(entity, surface, target)
  -- A network that already holds fluid cannot be a measuring instrument: whatever happens to the
  -- new fluid afterwards is indistinguishable from what was in there before.
  if units > 0 then return give_up() end
  -- And a network that reaches the machine at two cells cannot be attributed either: the fluid
  -- would be taken at whichever of the two is the box, and the reading would name both. This is
  -- what happens when the card brings its own inlet pipe -- the offer beside it pours in through
  -- the card's pipe -- so the cell is left for a pass that reaches the machine alone.
  if #touching ~= 1 then return give_up() end
  local put = 0
  pcall(function()
    put = target.insert_fluid { name = fluid, amount = want } or 0
  end)
  if put <= 0 then return give_up() end
  return { pipe = target, fluid = fluid, face = touching[1].face, off = touching[1].off,
    started = put, adopted = adopted, entity = entity, surface = surface }
end

-- One discovery pass: the cells of one parity on every face, each holding a little of the fluid and
-- touching nothing else. Two passes are needed because neighbouring cells would share a network,
-- and a network shared by two fluids holds only the first one offered to it.
function fluidrig.offer_pass(entity, surface, force_name, fluid, parity, amount)
  local probes = {}
  for _, f in ipairs(fluidrig.faces(entity)) do
    local lo = -(f.span - 1) / 2
    for i = 0, f.span - 1 do
      if i % 2 == parity then
        local pr = fluidrig.offer(entity, surface, force_name, fluid, f.name, lo + i, amount)
        if pr then probes[#probes + 1] = pr end
      end
    end
  end
  return probes
end

-- A pipe that lost fluid names the cell its box was on; the rest is noise, and a pass that took
-- nothing says the box is on a cell this pass did not cover.
function fluidrig.poll_offers(probes)
  local taken = {}
  for _, pr in ipairs(probes or {}) do
    if pr.pipe and pr.pipe.valid and pr.entity and pr.entity.valid then
      -- what is left anywhere in the network, against what was put in: the difference is the only
      -- thing that can have happened to it
      if fluidrig.network_units(pr.entity, pr.surface, pr.pipe) < pr.started - 0.5 then
        taken[#taken + 1] = pr
      end
    end
  end
  return taken
end

function fluidrig.destroy_offers(probes)
  local n = 0
  for _, pr in ipairs(probes or {}) do
    if pr.adopted then
      -- put the card's pipe back the way it was found: empty
      if pr.pipe and pr.pipe.valid and pr.entity and pr.entity.valid then
        for _, pi in ipairs(fluidrig.network_pipes(pr.entity, pr.surface, pr.pipe)) do
          local held = units_of(pi, pr.fluid)
          if held > 0 then pcall(function() pi.remove_fluid { name = pr.fluid, amount = held } end) end
        end
      end
    elseif pr.pipe and pr.pipe.valid then
      pr.pipe.destroy(); n = n + 1
    end
  end
  return n
end

-- A box that is already full cannot be seen filling: the offer would just sit there and read as
-- "no box at this cell". So the fluid under test is taken back out of the machine first, which
-- 2.0 allows for an input box as well as an output one.
function fluidrig.clear_box(machine, fluid)
  local held = units_of(machine, fluid)
  if held <= 0 then return 0 end
  local got = 0
  pcall(function() got = machine.remove_fluid { name = fluid, amount = held } end)
  return got or 0
end

-- ------------------------------------------------------------------------ the runs ----
-- A supply run is a row of pipes over `cells` and a tank centred behind `anchor`, which must be
-- one of `cells`. `fill` decides whether the tank starts full (a supply) or empty (a collector).
function fluidrig.run(entity, surface, force_name, fluid, face, cells, anchor, fill)
  local ux, uy = unit(face)
  local made = { fluid = fluid, face = face, cells = cells, anchor = anchor, pipes = {},
    adopted = {}, moved = 0 }
  local placed = 0
  for _, off in ipairs(cells) do
    local pos = fluidrig.cell(entity, face, off)
    local p = nil
    if surface.can_place_entity { name = PIPE, position = pos, force = force_name } then
      p = surface.create_entity { name = PIPE, position = pos, force = force_name }
      if p then made.pipes[#made.pipes + 1] = p; placed = placed + 1 end
    else
      -- A card that brings its own inlet pipe has already done the one thing this row is here to
      -- do. Use the pipe that is standing there -- an empty one, so the row carries the fluid it
      -- was built to carry -- and leave it on the ground when the rig comes apart.
      local here = surface.find_entities_filtered { name = PIPE, position = pos, radius = 0.1 }
      -- Empty, or already carrying the fluid this row exists to deliver: a pipe holding something
      -- else is an obstacle, and a row laid beside it would measure a machine fed by neither.
      if here[1] and units_of(here[1], fluid) == units_of(here[1]) then
        made.adopted[#made.adopted + 1] = here[1]
        placed = placed + 1
      end
    end
  end
  if placed == 0 then return nil, "ROW_REFUSED" end
  local pos, dir = tank_at(entity, face, anchor)
  if not surface.can_place_entity { name = TANK, position = pos, force = force_name, direction = dir } then
    fluidrig.destroy(made)
    return nil, "TANK_REFUSED"
  end
  local t = surface.create_entity { name = TANK, position = pos, force = force_name, direction = dir }
  if not t then
    fluidrig.destroy(made)
    return nil, "TANK_REFUSED"
  end
  made.tank, made.tank_pos = t, pos
  made.started = 0
  if fill then
    pcall(function() t.insert_fluid { name = fluid, amount = tank_capacity() } end)
    made.started = units_of(t, fluid)
  end
  made.last = made.started
  return made
end

-- What one entity holds of one fluid, for a caller that has to reset its own baseline.
function fluidrig.held(entity, named)
  return units_of(entity, named)
end

-- A reservoir, not a hose: a supply tank has to stay full or the tail of the window measures
-- starvation instead of a rate. The drain is a running total because the level is reset on refill.
function fluidrig.poll(made)
  if not made or not made.tank or not made.tank.valid then return end
  local holds = units_of(made.tank, made.fluid)
  if holds < (made.last or 0) then made.moved = made.moved + ((made.last or 0) - holds) end
  made.last = holds
  return holds
end

function fluidrig.top_up(made)
  if not made or not made.tank or not made.tank.valid then return end
  local holds = fluidrig.poll(made)
  local all = units_of(made.tank)
  if holds < tank_capacity() - 1 and all < tank_capacity() - 1 then
    pcall(function() made.tank.insert_fluid { name = made.fluid, amount = tank_capacity() } end)
  end
  made.last = units_of(made.tank, made.fluid)
end

function fluidrig.destroy(made)
  if not made then return end
  if made.tank and made.tank.valid then made.tank.destroy() end
  for _, p in ipairs(made.pipes or {}) do if p.valid then p.destroy() end end
  -- `made.adopted` is deliberately not touched: those pipes came with the card
end

-- ------------------------------------------------------------------ what to build ----
-- `found` is what the probes said: one {fluid, face, off} per ingredient of one machine. Fluids on
-- different faces never interfere, and each gets its face covered end to end, because a row that
-- spans a face cannot miss a box on it. Two ingredients on one face need the face split, and the
-- split has to keep three things true at once: an empty cell between the rows, each row over its
-- own box, and neither tank sharing an edge with the other.
-- The cell the plan chose first, then every other cell of the row. The cell a row starts at is left
-- out because a tank centred there has been seen keeping its fluid instead of joining the row.
function fluidrig.anchor_order(cells, preferred)
  local out = {}
  if preferred and preferred ~= cells[1] then out[#out + 1] = preferred end
  for _, c in ipairs(cells) do
    if c ~= cells[1] and c ~= preferred then out[#out + 1] = c end
  end
  return out
end

function fluidrig.plan(entity, found)
  local by_face = {}
  for _, f in ipairs(found or {}) do
    by_face[f.face] = by_face[f.face] or {}
    by_face[f.face][#by_face[f.face] + 1] = f
  end
  local runs, problems = {}, {}
  for _, face in ipairs({ "east", "west", "south", "north" }) do
    local here = by_face[face]
    if here then
      local f = fluidrig.face(entity, face)
      table.sort(here, function(a, b) return a.off < b.off end)
      local lo = -(f.span - 1) / 2
      if #here == 1 then
        -- A row that spans the face reaches whichever cell the box is on, so the only thing the
        -- discovered cell buys here is where to stand the tank: the middle is where the lab's site
        -- search has already cleared room for one.
        local cells = {}
        for i = 0, f.span - 1 do cells[#cells + 1] = lo + i end
        runs[#runs + 1] = { fluid = here[1].fluid, face = face, cells = cells, anchor = 0,
          source = here[1].source }
      elseif #here == 2 then
        local a, b = here[1], here[2]
        if b.off - a.off < 2 then
          problems[#problems + 1] = { why = "BOXES_ADJACENT_ON_ONE_FACE", face = face,
            fluids = { a.fluid, b.fluid }, at = { a.off, b.off },
            msg = a.fluid .. " and " .. b.fluid .. " both enter " .. face .. " at cells "
              .. a.off .. " and " .. b.off .. ", which no two separate runs can reach" }
        else
          local left = {}
          for off = lo, a.off do left[#left + 1] = off end
          -- the right row runs on past the corner until its tank clears the left one's: a tank is
          -- three tiles wide and the pair may not touch, which is what limits how tight a face can
          -- be split rather than the number of cells the machine has
          local want = a.off + 4
          local right, anchor = {}, math.max(b.off, want)
          for off = b.off, anchor do right[#right + 1] = off end
          runs[#runs + 1] = { fluid = a.fluid, face = face, cells = left, anchor = a.off,
            source = a.source }
          runs[#runs + 1] = { fluid = b.fluid, face = face, cells = right, anchor = anchor,
            source = b.source }
        end
      else
        problems[#problems + 1] = { why = "TOO_MANY_FLUIDS_ON_ONE_FACE", face = face,
          count = #here, fluids = (function()
            local t = {} for _, x in ipairs(here) do t[#t + 1] = x.fluid end return t end)(),
          msg = #here .. " ingredients of this machine enter the same face; the rig plans two at most" }
      end
    end
  end
  return runs, problems
end

-- A machine's own boxes hold what it just made, and 2.0 lets a script take it out again. That is
-- the honest way to read a rate: a collector network of guessed geometry puts a ceiling on the
-- number and hides it as a slow card, while the box either holds the product or it does not.
function fluidrig.drain(machine, names)
  local out = {}
  if not machine or not machine.valid or not names then return out end
  local held = entity_fluids(machine)
  for name in pairs(held) do
    if names[name] then
      local got
      pcall(function() got = machine.remove_fluid { name = name, amount = held[name] } end)
      if got and got > 0 then out[name] = got end
    end
  end
  return out
end

-- The fluids the machine's current recipe will draw. A card that declares an ingredient its bound
-- recipe never asks for cannot be fed, and finding that out by offering the fluid at every cell
-- wastes the discovery and then reports the wrong reason.
function fluidrig.ingredient_names(machine)
  local names = {}
  local ok, recipe = pcall(function() return machine.get_recipe() end)
  if not ok or not recipe then return nil end
  for _, ing in ipairs(recipe.ingredients or {}) do
    if ing.type == "fluid" or (ing.name and prototypes.fluid[ing.name]) then
      names[ing.name] = true
    end
  end
  return names
end

-- What a machine's boxes hold at the end of a window, without taking any of it: an ingredient that
-- is still sitting there was supplied but not consumed, which is a different story from a box that
-- never held anything.
function fluidrig.boxes(machine)
  local out = {}
  for name, units in pairs(entity_fluids(machine)) do out[#out + 1] = { fluid = name, units = units } end
  table.sort(out, function(a, b) return a.fluid < b.fluid end)
  return out
end

-- The fluids a machine's current recipe throws out, which is what the drain above is allowed to
-- take: an ingredient sitting in a box is on its way in, not a result.
function fluidrig.product_names(machine)
  local names = {}
  local ok, recipe = pcall(function() return machine.get_recipe() end)
  if not ok or not recipe then return names end
  for _, p in ipairs(recipe.products or {}) do
    if p.type == "fluid" or (p.name and prototypes.fluid[p.name]) then
      names[p.name] = true
    end
  end
  return names
end

return fluidrig
