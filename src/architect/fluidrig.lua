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
-- An offer is one pipe holding a little of the fluid, touching one cell and nothing else. The
-- machine takes it only when that cell is its box, and a pipe that has been emptied says so. Two
-- passes cover a face because neighbouring cells would join each other's networks.
function fluidrig.offer(entity, surface, force_name, fluid, face, off, amount)
  local pos = fluidrig.cell(entity, face, off)
  if not surface.can_place_entity { name = PIPE, position = pos, force = force_name } then return nil end
  local p = surface.create_entity { name = PIPE, position = pos, force = force_name }
  if not p then return nil end
  local put = 0
  pcall(function()
    p.insert_fluid { name = fluid, amount = amount or 50 }
    put = units_of(p, fluid)
  end)
  if put <= 0 then
    if p.valid then p.destroy() end
    return nil
  end
  return { pipe = p, fluid = fluid, face = face, off = off, started = put }
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
  local taken, left = {}, {}
  for _, pr in ipairs(probes or {}) do
    if pr.pipe and pr.pipe.valid then
      local holds = units_of(pr.pipe, pr.fluid)
      if holds < pr.started then taken[#taken + 1] = pr end
    end
    left[#left + 1] = pr
  end
  return taken
end

function fluidrig.destroy_offers(probes)
  local n = 0
  for _, pr in ipairs(probes or {}) do
    if pr.pipe and pr.pipe.valid then pr.pipe.destroy(); n = n + 1 end
  end
  return n
end

-- ------------------------------------------------------------------------ the runs ----
-- A supply run is a row of pipes over `cells` and a tank centred behind `anchor`, which must be
-- one of `cells`. `fill` decides whether the tank starts full (a supply) or empty (a collector).
function fluidrig.run(entity, surface, force_name, fluid, face, cells, anchor, fill)
  local ux, uy = unit(face)
  local made = { fluid = fluid, face = face, cells = cells, anchor = anchor, pipes = {}, moved = 0 }
  local placed = 0
  for _, off in ipairs(cells) do
    local pos = fluidrig.cell(entity, face, off)
    if surface.can_place_entity { name = PIPE, position = pos, force = force_name } then
      local p = surface.create_entity { name = PIPE, position = pos, force = force_name }
      if p then made.pipes[#made.pipes + 1] = p; placed = placed + 1 end
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
        runs[#runs + 1] = { fluid = here[1].fluid, face = face, cells = cells, anchor = 0 }
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
          runs[#runs + 1] = { fluid = a.fluid, face = face, cells = left, anchor = a.off }
          runs[#runs + 1] = { fluid = b.fluid, face = face, cells = right, anchor = anchor }
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
