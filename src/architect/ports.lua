-- Where a machine's fluid ports are, answered from data instead of from a measurement.
--
-- This file exists because a premise this mod was built on turned out to be false. `boxes.lua`
-- records cells that were won by offering fluid one pipe at a time and watching which cell drank it,
-- under the belief that 2.0 exposes no box geometry to a script. It does: `prototypes.entity[X]
-- .fluidbox_prototypes[i].pipe_connections[k]` carries the port offsets for every facing a machine
-- can be built in, and a standing entity answers the same thing in world coordinates through
-- `entity.fluidbox.get_pipe_connections(i)`. Both were checked against the rig's measurement and
-- against a player's eyes in alt mode, and all three name the same cell.
--
-- The convention, since two different sources have to agree on it:
--
--   `positions` on a connection is the same point stated for the four facings a machine can have --
--   index 1 is direction 0 (north), and each step rotates 90 degrees clockwise. The engine's own
--   rotation is (x, y) -> (-y, x), which is what the placed-entity read confirms cell for cell.
--
--   `face` and `off` are the world axes of the machine as placed, in the same sense `fluidrig.cell`
--   consumes them: the tip cell sits one tile outside the footprint on that face, `off` tiles along
--   it. For a 5x5 refinery facing north the offsets come out as (1, 3) = "south, +1", which is the
--   crude entry `boxes.lua` carries.
--
-- Which fluid goes in which box is only partly data. A recipe may name a box with `fluidbox_index`
-- -- one recipe in vanilla and Space Age does -- and a box may carry a `filter`, which settles it
-- outright. Where neither says, the engine assigns the recipe's fluid lines to the machine's boxes of
-- matching kind in order, and that is what `ports.assign` does here; it is a rule inferred from three
-- machines and it is the weak link in this file, so every caller gets `how` back with the answer.

local ports = {}

local function line_matches(box, kind)
  if kind == "in" then return box.kind == "input" or box.kind == "input-output" end
  if kind == "out" then return box.kind == "output" or box.kind == "input-output" end
  return true
end


local FACES = { "north", "east", "south", "west" }
local UNIT = { north = { 0, -1 }, east = { 1, 0 }, south = { 0, 1 }, west = { -1, 0 } }

local function field(o, k)
  if o == nil then return nil end
  local ok, v = pcall(function() return o[k] end)
  return ok and v or nil
end

-- 90 degrees clockwise, the engine's own rotation for entity direction steps
local function turn(offset)
  return { x = -offset.y, y = offset.x }
end

local function rotate(offset, direction)
  local o = { x = offset.x, y = offset.y }
  for _ = 1, (direction or 0) / 4 do o = turn(o) end
  return o
end

-- face/off of a cell relative to a machine's footprint: the outward axis names the face, the other
-- component is the offset along it
local function face_of(tip, w, h)
  -- one tile outside the footprint, which is `span / 2 + 0.5` cells from the entity's position --
  -- the same figure `fluidrig.cell` pushes a row out by, because both are naming one cell
  if math.abs(tip.y) == h / 2 + 0.5 then
    return (tip.y > 0) and "south" or "north", tip.x
  end
  return (tip.x > 0) and "east" or "west", tip.y
end

--- Everything the prototype declares, resolved for one facing. Box order follows the machine's own
--- box indices, which is what the recipe assignment below counts on.
function ports.declared(name, direction)
  local p = prototypes.entity[name]
  if not p then return nil, "NO_SUCH_MACHINE" end
  local w, h = field(p, "tile_width") or 1, field(p, "tile_height") or 1
  local out = {}
  for _, b in ipairs(field(p, "fluidbox_prototypes") or {}) do
    local kind = field(b, "production_type")
    local conns = field(b, "pipe_connections") or {}
    local first = conns[1]
    if kind and first then
      local positions = field(first, "positions") or {}
      local base = positions[1 + (direction or 0) / 4]
      if base then
        local port = { x = base.x, y = base.y }
        -- the connection's own stub direction rotates with the machine; the tip is one cell out along it
        local stub_dir = (((field(first, "direction") or 0) + (direction or 0)) % 16) / 4
        local stub = FACES[stub_dir + 1]
        local u = UNIT[stub] or { 0, 0 }
        local tip = { x = port.x + u[1], y = port.y + u[2] }
        local face, off = face_of(tip, w, h)
        out[#out + 1] = {
          index = field(b, "index") or #out, kind = kind,
          volume = field(b, "volume"),
          filter = field(b, "filter") and field(field(b, "filter"), "name") or nil,
          min_temperature = field(b, "minimum_temperature"),
          max_temperature = field(b, "maximum_temperature"),
          face = face, off = off, port = port, tip = tip,
          connection_face = stub,
        }
      end
    end
  end
  return { machine = name, direction = direction or 0, tile_width = w, tile_height = h, boxes = out }, nil
end

--- Which fluid each box carries for one recipe. Precedence: the box's own filter, then an explicit
--- `fluidbox_index` on the recipe line, then order among boxes of the matching kind.
function ports.assign(declared, recipe_name)
  local rec = recipe_name and prototypes.recipe[recipe_name]
  -- "in" is a Lua keyword, so these keys are spelled out everywhere rather than dotted
  local lines = { ["in"] = {}, ["out"] = {} }
  if rec then
    for _, i in ipairs(field(rec, "ingredients") or {}) do
      if field(i, "type") == "fluid" or (field(i, "name") and prototypes.fluid[field(i, "name")]) then
        lines["in"][#lines["in"] + 1] = { fluid = field(i, "name"), box = field(i, "fluidbox_index"),
          amount = field(i, "amount"), temperature = field(i, "temperature"),
          min_temperature = field(i, "minimum_temperature"), max_temperature = field(i, "maximum_temperature") }
      end
    end
    for _, pr in ipairs(field(rec, "products") or {}) do
      if field(pr, "type") == "fluid" or (field(pr, "name") and prototypes.fluid[field(pr, "name")]) then
        lines["out"][#lines["out"] + 1] = { fluid = field(pr, "name"), box = field(pr, "fluidbox_index"),
          amount = field(pr, "amount") or field(pr, "amount_min"), temperature = field(pr, "temperature") }
      end
    end
  end

  local by_kind, assigned = { ["in"] = {}, ["out"] = {} }, {}
  for _, b in ipairs((declared or {}).boxes or {}) do
    -- a box that both takes and gives cannot be resolved by order at all, so it stays unassigned
    local kind = (b.kind == "input" and "in") or (b.kind == "output" and "out") or nil
    if kind then by_kind[kind][#by_kind[kind] + 1] = b end
  end
  for kind, list in pairs(by_kind) do
    for slot, b in ipairs(list) do
      local line
      if b.filter then
        line = { fluid = b.filter, how = "filter" }
      else
        local wanted
        for _, l in ipairs(lines[kind] or {}) do
          if l.box and l.box == b.index then wanted = l end
        end
        if wanted then
          line = { fluid = wanted.fluid, how = "fluidbox_index", amount = wanted.amount,
            temperature = wanted.temperature, min_temperature = wanted.min_temperature,
            max_temperature = wanted.max_temperature }
        elseif (lines[kind] or {})[slot] then
          line = { fluid = lines[kind][slot].fluid, how = "order", amount = lines[kind][slot].amount,
            temperature = lines[kind][slot].temperature,
            min_temperature = lines[kind][slot].min_temperature,
            max_temperature = lines[kind][slot].max_temperature }
        end
      end
      if line then
        assigned[b.index] = line
        -- a filter that disagrees with the recipe line is worth seeing, not silently preferring one
        if line.how == "filter" then
          local ordered = (lines[kind] or {})[slot]
          if ordered and ordered.fluid ~= line.fluid then line.recipe_disagrees = ordered.fluid end
        end
      end
    end
  end
  return assigned
end

--- The cell a fluid enters or leaves at, in `boxes.lua`'s own words. Returns face, off, detail.
function ports.lookup(name, direction, fluid, kind, recipe_name)
  local declared, why = ports.declared(name, direction)
  if not declared then return nil, nil, { code = why, machine = name } end
  local assigned = ports.assign(declared, recipe_name)
  for _, b in ipairs(declared.boxes) do
    local line = assigned[b.index]
    if b.kind ~= "none" and line and line.fluid == fluid
      and (kind == nil or line_matches(b, kind)) then
      return b.face, b.off, {
        box = b.index, kind = b.kind, how = line.how, volume = b.volume,
        min_temperature = b.min_temperature, max_temperature = b.max_temperature,
        port = b.port, tip = b.tip, connection_face = b.connection_face,
        needs_temperature = line.temperature or line.min_temperature,
        recipe_disagrees = line.recipe_disagrees,
      }
    end
  end
  return nil, nil, { code = "BOX_NOT_FOUND", machine = name, fluid = fluid, kind = kind,
    recipe = recipe_name, known = (function()
      local l = {}
      for _, b in ipairs(declared.boxes) do
        local line = assigned[b.index]
        l[#l + 1] = { box = b.index, kind = b.kind, fluid = line and line.fluid, face = b.face, off = b.off }
      end
      return l
    end)() }
end

--- A standing machine, in the same words -- the read a placed entity gives, which is the only answer
--- that knows the recipe the machine is actually set to.
function ports.read(entity)
  local fb = entity.fluidbox
  if not fb then return nil, "NO_FLUID_BOXES" end
  local w, h = 1, 1
  local p = prototypes.entity[entity.name]
  if p then w, h = field(p, "tile_width") or 1, field(p, "tile_height") or 1 end
  local e, out = entity.position, {}
  for i = 1, #fb do
    local ok_conn, conns = pcall(function() return fb.get_pipe_connections(i) end)
    local ok_cap, cap = pcall(function() return fb.get_capacity(i) end)
    local ok_proto, proto = pcall(function() return fb.get_prototype(i) end)
    local ok_join, joins = pcall(function() return fb.get_connections(i) end)
    local n_joined = 0
    if ok_join and joins then for _ in pairs(joins) do n_joined = n_joined + 1 end end
    local fluid_here, amount_here, temperature_here
    local ok_f, fl = pcall(function() return entity.get_fluid(i) end)
    if ok_f and fl then
      fluid_here, amount_here, temperature_here = field(fl, "name"), field(fl, "amount"), field(fl, "temperature")
    end
    local c = ok_conn and conns and conns[1]
    if c then
      local tip = { x = c.target_position.x - e.x, y = c.target_position.y - e.y }
      local face, off = face_of(tip, w, h)
      out[#out + 1] = {
        box = i, index = ok_proto and field(proto, "index") or nil,
        kind = c.flow_direction, capacity = ok_cap and cap or nil,
        filter = ok_proto and field(proto, "filter") and field(field(proto, "filter"), "name") or nil,
        min_temperature = ok_proto and field(proto, "minimum_temperature") or nil,
        max_temperature = ok_proto and field(proto, "maximum_temperature") or nil,
        face = face, off = off, tip = tip,
        port_cell = c.position, cell = c.target_position,
        joined = n_joined, holds = fluid_here, units = amount_here, temperature = temperature_here,
      }
    end
  end
  return { machine = entity.name, direction = entity.direction,
    recipe = (function()
      local ok, r = pcall(function() return entity.get_recipe() end)
      return ok and r and r.name or nil
    end)(),
    position = { x = e.x, y = e.y }, boxes = out }, nil
end

return ports
