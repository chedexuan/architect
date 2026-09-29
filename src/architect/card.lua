-- Card: an authored layout in blueprint-compatible coordinates.
--
--   { name, entities = { {name, position={x,y}, direction}, ... },
--     ports = { ["in"] = { {item|fluid, entity=<1-based index>} }, out = { ... } },
--     -- a port names exactly one payload: an item, or a fluid that moves through pipes.
--     contract = { outputs = { [item] = per_minute } },
--     machine_recipes = { [<index>] = <recipe> },   -- only needed when the
--                                                    -- inference is ambiguous
--     wires = { {from=<index>, to=<index>, color="green"|"red"}, ... } }

-- Positions are entity centres, exactly as in a blueprint, so a card can go to
-- set_blueprint_entities unchanged.
--
-- A wire names two entities and a colour, and nothing more. Which connector of each entity its end
-- lands on is worked out where the wire is drawn, from the entity's own type, because that is the
-- choice a player makes with the mouse without thinking about it: the output face of a combinator, the
-- input face of whatever it is wired to. Recording the connector here would be a second copy of a rule
-- the engine owns, and the first thing to drift when a future build moves a face.

local host = require("host")

local C = {}

-- Which fluid boxes an entity has, and what each does, read from the prototype.
--
-- This header used to state that box geometry cannot be read -- written when 1.1's
-- `entity.fluidbox[i]` answered nothing and `fluidbox_prototypes` seemed to carry only
-- `production_type`. 2.0 exposes the geometry after all: `entity.fluidbox.get_pipe_connections(i)`
-- returns world cells already rotated for the facing, which is what `ports.lua` now reads. The
-- history stays in the comment because a missing answer is not the same thing as missing data.
local function fluid_boxes(name)
  local p = prototypes.entity[name]
  if not p then return nil end
  local ok, fb = pcall(function() return p.fluidbox_prototypes end)
  if not ok or not fb then return nil end
  local boxes = { input = 0, output = 0, open = 0, total = 0 }
  for i = 1, 8 do
    local b = fb[i]
    if not b then break end
    local tok, pt = pcall(function() return b.production_type end)
    local t = tok and tostring(pt) or "none"
    boxes.total = boxes.total + 1
    if t == "input" then boxes.input = boxes.input + 1
    elseif t == "output" then boxes.output = boxes.output + 1
    else boxes.open = boxes.open + 1 end
  end
  if boxes.total == 0 then return nil end
  return boxes
end

-- What a bound recipe actually moves. Item ports and fluid ports are separate obligations: a
-- machine that takes fluid and yields fluid never needs an inserter, while one that yields an
-- item does -- so the arm rule is decided by the recipe rather than by a list of machine types.
local function recipe_needs(recipe)
  if not recipe then return nil end
  local ok, r = pcall(function() return prototypes.recipe[recipe] end)
  if not ok or not r then return nil end
  local need = { item_in = false, item_out = false, fluid_in = false, fluid_out = false }
  local function is_fluid(e)
    if e.type == "fluid" then return true end
    return prototypes.fluid ~= nil and prototypes.fluid[e.name] ~= nil
  end
  local iok, ing = pcall(function() return r.ingredients end)
  if iok and ing then
    for _, e in ipairs(ing) do
      if is_fluid(e) then need.fluid_in = true else need.item_in = true end
    end
  end
  local pok, pro = pcall(function() return r.products end)
  if pok and pro then
    for _, e in ipairs(pro) do
      if is_fluid(e) then need.fluid_out = true else need.item_out = true end
    end
  end
  return need
end

local CARDINALS = {
  north = defines.direction.north, east = defines.direction.east,
  south = defines.direction.south, west = defines.direction.west,
}

local VEC = {
  [defines.direction.north] = { 0, -1 },
  [defines.direction.east]  = { 1, 0 },
  [defines.direction.south] = { 0, 1 },
  [defines.direction.west]  = { -1, 0 },
}

function C.as_direction(v)
  if type(v) == "string" then return CARDINALS[v] or 0 end
  return v or 0
end

function C.normalize(card)
  local out = {
    name = card.name, entities = {}, ports = card.ports or {},
    contract = card.contract or {}, machine_recipes = card.machine_recipes,
    internal_flows = card.internal_flows, internal_fluids = card.internal_fluids,
    anchors = card.anchors,
    -- Which items this card actually moves on belts, and how much a row can carry. A rate
    -- claim that no belt could deliver is the arithmetic mistake this field exists to catch.
    lanes = card.lanes,
    wires = C.wires(card),
  }
  for _, e in ipairs(card.entities or {}) do
    local pos = e.position or {}
    out.entities[#out.entities + 1] = {
      name = e.name,
      position = { x = pos.x or pos[1] or e.x, y = pos.y or pos[2] or e.y },
      direction = C.as_direction(e.direction),
      -- An entity's own circuit intent travels with the entity, because it IS a property of that one
      -- machine: what a controller emits, which position a selector takes, whether an assembler obeys a
      -- wire at all. The five shapes (emitter, select, rotate, recipe_control, deficiency) are the whole
      -- vocabulary, and each one is a write measured on 2.0.77 rather than a name remembered from 1.1 --
      -- which is not a style preference: 2.0 renamed the combinator fields, and a table key it does not
      -- have is IGNORED rather than refused, so a 1.1 spelling arrives as a controller that was accepted,
      -- wired, and mute (dev/circuit_rules_probe.js acts N and O).
      circuit = C.circuit(e.circuit),
    }
  end
  return out
end

-- The circuit intent, in the shapes the engine can be asked for. Anything else is left as it came
-- so `C.lint` can name it: defaulting an unknown spec to "no controller" would be the quietest possible
-- way to ship a plan that does nothing.
local SHAPES = { emitter = true, select = true, rotate = true, recipe_control = true,
  deficiency = true }

-- What a `deficiency` box has to name, in the words the engine takes: an ITEM to subtract from the
-- target, the RECIPE to write the answer under, and the target itself. Kept as data rather than
-- inlined into the lint below because the same three names are what `card_example` builds the list from,
-- and a fourth field added to one of the two would be a plan that lints and writes nothing.
local DEFICIENCY_KEYS = { item = true, recipe = true, target = true }
function C.circuit(spec)
  if type(spec) ~= "table" then return nil end
  local out = {}
  -- Every key travels, known or not: dropping the unknown ones here would hand `C.lint` a clean table
  -- and a plan whose controller silently does nothing, which is the quiet failure this file keeps
  -- being written to avoid.
  for k, v in pairs(spec) do out[k] = v end
  return next(out) ~= nil and out or nil
end

-- The wire list, in the one shape the rest of the code may read.
--
-- `a`/`b` are accepted beside `from`/`to` because a style emits a wire at the same moment it emits the
-- two parts it joins, and counting indices twice is how a shape comes to wire a machine to itself.
-- Everything else -- an endpoint that is not a number, a colour that is not one of the two -- is left
-- in place for `C.lint` to name, rather than quietly defaulted.
function C.wires(card)
  local out = {}
  for _, w in ipairs((card or {}).wires or {}) do
    out[#out + 1] = {
      from = tonumber(w.from or w.a), to = tonumber(w.to or w.b),
      color = w.color == "red" and "red" or "green",
    }
  end
  return out
end

local function cell_of(occ, gx, gy) return occ[gx .. "," .. gy] end

-- Static lint: only what is knowable without the engine. Anything about inserter
-- reach or power coverage belongs to card_verify after the entities exist.
function C.lint(card, opts)
  opts = opts or {}
  local errors, warnings = {}, {}
  local function add(t, code, msg, at) t[#t + 1] = { code = code, msg = msg, at = at } end

  local ents = card.entities or {}
  if #ents == 0 then
    add(errors, "EMPTY_CARD", "no entities")
    return { errors = errors, warnings = warnings }
  end
  if #ents > 4000 then add(errors, "CARD_TOO_LARGE", #ents .. " entities exceeds 4000") end

  local occ, info = {}, {}
  local min_x, min_y, max_x, max_y

  for i, e in ipairs(ents) do
    local p = prototypes.entity[e.name]
    if not p then
      add(errors, "UNKNOWN_ENTITY", "no such entity: " .. tostring(e.name), i)
    elseif type(e.position) ~= "table" or type(e.position.x) ~= "number" or type(e.position.y) ~= "number" then
      add(errors, "NO_POSITION", tostring(e.name) .. " needs position={x,y}", i)
    else
      -- Geometry is recorded even for a locked entity. Skipping it made every port
      -- pointing at that entity report a second, bogus PORT_UNKNOWN_ENTITY, burying
      -- the one real fault (research it first) under a pile of follow-on errors.
      local w, h = p.tile_width or 1, p.tile_height or 1
      info[i] = { name = e.name, type = p.type, w = w, h = h, direction = e.direction }
      if opts.available and opts.available(e.name) == false then
        add(errors, "LOCKED_ENTITY", e.name .. " cannot be built yet", i)
      end
      local ox, oy = e.position.x - w / 2, e.position.y - h / 2
      if math.abs(ox - math.floor(ox + 0.5)) > 1e-6 or math.abs(oy - math.floor(oy + 0.5)) > 1e-6 then
        add(errors, "MISALIGNED", string.format("%s centre (%g,%g) off-grid for its %dx%d footprint",
          e.name, e.position.x, e.position.y, w, h), i)
      end
      ox, oy = math.floor(ox + 0.5), math.floor(oy + 0.5)
      for gx = ox, ox + w - 1 do
        for gy = oy, oy + h - 1 do
          local key = gx .. "," .. gy
          if occ[key] then
            add(errors, "OVERLAP", string.format("%s cell (%d,%d) already taken by %s", e.name, gx, gy, occ[key].name), i)
          else
            occ[key] = { index = i, name = e.name, type = p.type }
          end
        end
      end
      min_x = min_x and math.min(min_x, ox) or ox
      max_x = max_x and math.max(max_x, ox + w - 1) or ox + w - 1
      min_y = min_y and math.min(min_y, oy) or oy
      max_y = max_y and math.max(max_y, oy + h - 1) or oy + h - 1
      info[i] = { name = e.name, type = p.type, w = w, h = h, ox = ox, oy = oy, direction = e.direction }
    end
  end

  -- A belt's exit cell must be able to receive: another belt, an underground input,
  -- a container/loader, or off-card (declared as an output port). Belts that dump on
  -- the ground were the single most common silent failure in this project.
  local RECEIVES = {
    ["transport-belt"] = true, ["loader"] = true, ["loader-unloadable"] = true,
    ["container"] = true, ["underground-belt"] = true,
    ["splitter"] = true, ["linked-belt"] = true, ["cargo-landing-pad"] = true,
  }
  local belts_out = 0
  for i, d in ipairs(info) do
    if d.type == "transport-belt" then
      local v = VEC[d.direction]
      if not v then
        add(warnings, "BELT_DIRECTION_INVALID", "belt has no cardinal direction", i)
      else
        local nx, ny = d.ox + v[1], d.oy + v[2]
        local neighbour = cell_of(occ, nx, ny)
        if neighbour then
          if neighbour.type == "underground-belt" then
            -- 1.1 kept this fact on the prototype; 2.0 moved it onto the entity. Measured on this
            -- build: `belt_to_ground_type` RAISES on a LuaEntityPrototype ("doesn't contain key"),
            -- and on a script-created underground it answers `input` for all sixteen directions --
            -- which face takes items is not readable from card data at all. The old read was
            -- therefore not a wrong answer but no answer: every card with a belt feeding an
            -- underground died in lint with a runtime error, and no fixture had an underground, so
            -- nothing had ever run this line.
            add(warnings, "BELT_INTO_UNDERGROUND", string.format(
              "belt #%d feeds %s at (%d,%d); 2.0 does not expose which face of an underground is the"
              .. " input to script, so the facing has to be checked in game", i, neighbour.name, nx, ny), i)
          elseif not RECEIVES[neighbour.type] then
            add(errors, "BELT_INTO_SOLID", string.format("belt #%d (%d,%d) points into %s", i, nx, ny, neighbour.name), i)
          end
        else
          belts_out = belts_out + 1
          add(warnings, "BELT_EXITS_CARD", string.format("belt #%d leaves the card at (%d,%d)", i, nx, ny), i)
        end
      end
    end
  end

  -- Every crafting machine must have something that can move items in and out -- but only a
  -- machine that moves items. Deciding that from a list of types wrongly demanded an inserter on
  -- a refinery or a pump, so the answer comes from the bound recipe, and from the fluid boxes for
  -- the machines that have no recipe at all because they only ever pass fluid through.
  local function moves_items(d, i)
    local boxes = fluid_boxes(d.name)
    if boxes then
      local need = recipe_needs((card.machine_recipes or {})[i])
      if need then return need.item_in or need.item_out end
      -- nothing bound: a machine with boxes on both sides and no item obligation recorded is
      -- treated as fluid-only, and the message below names the field that would settle it
      return not (boxes.input > 0 and boxes.output > 0)
    end
    return true
  end

  local has_arm = false
  for _, d in ipairs(info) do if d.type == "inserter" then has_arm = true break end end
  if has_arm then
    for i, d in ipairs(info) do
      -- through `host.HANDLED_KINDS`, not a list local to this file: this one had forgotten labs,
      -- reactors and boilers, so a card with an unfed lab passed lint and the rig starved it
      if host.HANDLED_KINDS[d.type] and moves_items(d, i) then
        local near = false
        for gx = d.ox - 2, d.ox + d.w + 1 do
          for gy = d.oy - 2, d.oy + d.h + 1 do
            local c = cell_of(occ, gx, gy)
            if c and c.type == "inserter" then near = true end
          end
        end
        if not near then
          add(errors, "MACHINE_NO_ARM", string.format("%s at (%d,%d) has no inserter within reach", d.name, d.ox, d.oy), i)
        end
      end
    end
  end

  -- "in" is a Lua reserved word, so these keys are always bracketed.
  --
  -- A port names exactly one payload. `fluid` is read as what it is: something that moves through
  -- pipes, into and out of a fluid box. The engine will not say which face a box sits on (a placed
  -- pumpjack exposes no fluidbox at all), so the rules here are about existence and reachability,
  -- not about a port's tile -- which is what leaves the layout free, as the design intended.
  local fluid_ports_in, fluid_ports_out = {}, {}
  for flow, list in ipairs({ (card.ports or {})["in"] or {}, (card.ports or {}).out or {} }) do
    for _, port in ipairs(list) do
      if not port.entity then
        add(errors, "PORT_NO_ENTITY", "port is missing an entity index")
      elseif not info[port.entity] then
        -- at = the bad index, so the author can locate it like any other error
        add(errors, "PORT_UNKNOWN_ENTITY", "port points at missing entity index " .. tostring(port.entity), port.entity)
      else
        local has_item, has_fluid = port.item ~= nil, port.fluid ~= nil
        if not has_item and not has_fluid then
          add(errors, "PORT_NO_PAYLOAD", "port must name an item or a fluid", port.entity)
        elseif has_item and has_fluid then
          add(errors, "PORT_TWO_PAYLOADS", "port names both an item and a fluid", port.entity)
        elseif has_fluid then
          local okf = prototypes.fluid and prototypes.fluid[port.fluid] ~= nil
          if not okf then
            add(errors, "UNKNOWN_FLUID", "port names fluid " .. tostring(port.fluid) .. " which is not a fluid", port.entity)
          else
            local d = info[port.entity]
            local boxes = fluid_boxes(d.name)
            if not boxes then
              add(errors, "FLUID_PORT_ON_SOLID", string.format(
                "fluid port %s points at %s, which has no fluid box", port.fluid, d.name), port.entity)
            else
              -- an entry port is where fluid comes INTO the card, so the entity at it has to be
              -- able to take fluid (an input box, or a shared box like a pipe or a tank)
              local can_take, can_give = boxes.input + boxes.open > 0, boxes.output + boxes.open > 0
              if flow == 1 and not can_take then
                add(errors, "FLUID_PORT_WRONG_WAY", string.format(
                  "%s is an input port but %s can only give fluid", port.fluid, d.name), port.entity)
              elseif flow == 2 and not can_give then
                add(errors, "FLUID_PORT_WRONG_WAY", string.format(
                  "%s is an output port but %s can only take fluid", port.fluid, d.name), port.entity)
              end
              local bucket = flow == 1 and fluid_ports_in or fluid_ports_out
              bucket[#bucket + 1] = { entity = port.entity, fluid = port.fluid }
            end
          end
        end
      end
    end
  end

  -- Anchors are read beside ports on purpose. A region that sealed a seam no longer has a port at
  -- the joint -- that is what sealing means -- but the anchor survives, and without it every
  -- internally consistent oil card would be reported as having nowhere to put its own output.
  for _, a in ipairs(card.anchors or {}) do
    if a.fluid then
      if a.kind == "in" then fluid_ports_in[#fluid_ports_in + 1] = { entity = a.entity, fluid = a.fluid }
      elseif a.kind == "out" then fluid_ports_out[#fluid_ports_out + 1] = { entity = a.entity, fluid = a.fluid }
      end
    end
  end

  -- Fluid reachability, over the same cell grid the belt rules use: two fluid things connect when
  -- their footprints touch on an edge. A producer with no path to an output port is the failure
  -- this project already paid for with a pumpjack that mined for nothing -- `waiting_for_space_in_destination`
  -- is invisible to every other check here, because the geometry is perfect and the recipe is bound.
  local function fluid_group(seed)
    local seen, stack, members = {}, { seed }, {}
    while #stack > 0 do
      local idx = table.remove(stack)
      if not seen[idx] and info[idx] then
        seen[idx] = true
        members[#members + 1] = idx
        local d = info[idx]
        for gx = d.ox - 1, d.ox + d.w do
          for gy = d.oy - 1, d.oy + d.h do
            local edge = (gx >= d.ox and gx < d.ox + d.w and (gy == d.oy - 1 or gy == d.oy + d.h))
              or (gy >= d.oy and gy < d.oy + d.h and (gx == d.ox - 1 or gx == d.ox + d.w))
            local n = edge and cell_of(occ, gx, gy) or nil
            if n and n.index ~= idx and fluid_boxes(n.name) then stack[#stack + 1] = n.index end
          end
        end
      end
    end
    return members, seen
  end

  for i, d in ipairs(info) do
    local boxes = fluid_boxes(d.name)
    if boxes then
      local members, in_group = fluid_group(i)
      -- what the network as a whole is for: a name entering it, a name leaving it, and whether
      -- something inside the network is on the other end of that exchange
      local has_port_in, has_port_out, consumers, producers = false, false, 0, 0
      for _, m in ipairs(members) do
        local mb = fluid_boxes(info[m].name)
        if mb then
          if mb.input + mb.open > 0 and info[m].type ~= "pipe" then consumers = consumers + 1 end
          if mb.output > 0 then producers = producers + 1 end
        end
        for _, p in ipairs(fluid_ports_in) do if p.entity == m then has_port_in = true end end
        for _, p in ipairs(fluid_ports_out) do if p.entity == m then has_port_out = true end end
      end
      local produces = boxes.output > 0
      local consumes = boxes.input > 0
      -- an extractor with no route out is the pumpjack failure this whole path exists to catch;
      -- a network that ends inside a consumer is legitimate even with no port left on the card
      if produces and not has_port_out and consumers == 0 then
        add(errors, "FLUID_OUTPUT_UNDRAINED", string.format(
          "%s at (%d,%d) gives up fluid but nothing in its pipe network reaches an output port or a machine that takes it",
          d.name, d.ox, d.oy), i)
      end
      if consumes and not has_port_in and producers == 0 then
        add(errors, "FLUID_INPUT_UNFED", string.format(
          "%s at (%d,%d) needs fluid but no input port or producing machine reaches its pipe network",
          d.name, d.ox, d.oy), i)
      end
    end
  end

  -- Wires: what is knowable without the engine is that both ends name an entity, they are not the same
  -- entity, and the same pair is not joined twice. Whether the entity at an end carries a circuit
  -- connector at all, and whether the two ends stand close enough to be joined, is NOT decided here:
  -- `card_place` asks the engine and reports a refusal per wire. A static list of "types that should
  -- have a connector" would be a guess about every mod's entities, and a wrong guess in that list
  -- refuses a legal card -- which is the failure this file has already paid for once with belts.
  local joined = {}
  for _, w in ipairs(card.wires or {}) do
    if not w.from or not w.to then
      add(errors, "WIRE_NO_ENDS", "a wire names two entity indices, got "
        .. tostring(w.from) .. "/" .. tostring(w.to))
    elseif not info[w.from] then
      add(errors, "WIRE_UNKNOWN_ENTITY", "wire starts at missing entity index " .. tostring(w.from), w.from)
    elseif not info[w.to] then
      add(errors, "WIRE_UNKNOWN_ENTITY", "wire ends at missing entity index " .. tostring(w.to), w.to)
    elseif w.from == w.to then
      add(errors, "WIRE_SELF", string.format("%s cannot be wired to itself", info[w.from].name), w.from)
    else
      local key = math.min(w.from, w.to) .. "," .. math.max(w.from, w.to) .. "," .. w.color
      if joined[key] then
        add(warnings, "WIRE_DUPLICATE", string.format("wire #%s joins the same pair as wire #%s",
          key, tostring(joined[key])), w.from)
      end
      joined[key] = w.from
    end
  end

  -- A circuit intent is checked for shape only. Which entity types can hold a terminal, and how far a
  -- wire reaches, are the engine's answers and are quoted from it at placement (see `card_place` and
  -- dev/circuit_rules_probe.js act J), because a list of types this file guesses is a list that refuses
  -- somebody's modded machine.
  for i, d in ipairs(info) do
    local spec = (ents[i] or {}).circuit
    if spec ~= nil and type(spec) ~= "table" then
      add(errors, "CIRCUIT_BAD_SHAPE", tostring(d.name) .. " circuit must be a table of intents", i)
    elseif spec then
      local named = 0
      for k in pairs(spec) do
        named = named + 1
        if not SHAPES[k] then
          add(errors, "CIRCUIT_UNKNOWN_KIND", tostring(k) .. " is not one of emitter, select, rotate, "
            .. "recipe_control, deficiency", i)
        end
      end
      if spec.emitter then
        local list = spec.emitter
        if type(list) ~= "table" or #list == 0 then
          add(errors, "CIRCUIT_EMITTER_EMPTY",
            "an emitter has to name at least one signal to put on the wire", i)
        else
          for _, sig in ipairs(list) do
            if not sig or not sig.name then
              add(errors, "CIRCUIT_EMITTER_NO_SIGNAL", "an emitter signal needs {type, name}", i)
            end
          end
        end
      end
      if spec.deficiency then
        -- A deficiency box is the one controller that has to name BOTH ends: the item it subtracts and
        -- the recipe it writes. A box missing either is a wire carrying a signal no machine can obey, and
        -- the lane's machines idle without saying why -- so this is refused as a shape, not warned about.
        local d = spec.deficiency
        if type(d) ~= "table" then
          add(errors, "CIRCUIT_DEFICIENCY_SHAPE", "a deficiency box needs {item, recipe, target}", i)
        else
          if not d.item then
            add(errors, "CIRCUIT_DEFICIENCY_ITEM",
              "a deficiency box has to name the item it subtracts from the target", i)
          end
          for k in pairs(d) do
            if not DEFICIENCY_KEYS[k] then
              add(errors, "CIRCUIT_DEFICIENCY_KEY", "a deficiency box has no field " .. tostring(k)
                .. " (it takes item, recipe and target)", i)
            end
          end
          local target = tonumber(d.target)
          if not target or target < 1 then
            add(errors, "CIRCUIT_DEFICIENCY_TARGET",
              "a deficiency box asks for a target of at least 1 to subtract the shelf from", i)
          end
        end
      end
      if spec.rotate and not tonumber(spec.rotate) then
        add(errors, "CIRCUIT_ROTATE_TICKS", "rotate asks for a number of ticks between picks", i)
      end
      if spec.select and not tonumber(spec.select.index) then
        add(errors, "CIRCUIT_SELECT_INDEX",
          "select asks for which position of the sorted input to hand out (0 is the first)",
          i)
      end
      if (spec.emitter or spec.select or spec.rotate or spec.deficiency)
        and (spec.recipe_control ~= nil) then
        -- One entity cannot both answer a wire and be the thing that writes one, and saying so here is
        -- cheaper than placing a controller whose own machine ignores it.
        add(errors, "CIRCUIT_BOTH_SIDES",
          "an entity is either a controller (emitter/select/rotate/deficiency) or one that obeys a wire "
            .. "(recipe_control), not both", i)
      end
    end
  end

  local cells = 0
  for _ in pairs(occ) do cells = cells + 1 end

  return {
    errors = errors,
    warnings = warnings,
    stats = {
      entities = #ents,
      cells_occupied = cells,
      footprint = max_x and { width = max_x - min_x + 1, height = max_y - min_y + 1 } or nil,
      belt_exits = belts_out,
    },
  }
end

return C
