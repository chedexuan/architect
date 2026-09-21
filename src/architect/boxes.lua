-- Which cell of which face a machine's fluid boxes sit on.
--
-- The runtime does not say this anywhere: `fluid_boxes` is not exposed, `fluidbox_prototypes`
-- gives only in/out, and a placed machine reports an empty box list. So every entry below is a
-- fact the engine was *made to answer* -- fluid offered at that one cell and nowhere else, and the
-- cell that let it disappear is the box -- read by `dev/fluid_box_cells.js` or by the lab's own
-- discovery pass.
--
-- Two rules this file exists to keep:
--
-- An entry is keyed by the direction the machine was standing in when the fact was read. Rotating
-- a machine moves its boxes with it, and nothing here derives that rotation, so an entry for
-- direction 0 says nothing about a machine placed facing east.
--
-- Nothing downstream may trust an entry on its own. The lab builds its supply runs from these
-- cells, then requires the tank to lose fluid before it opens a measurement window -- so a wrong
-- or stale entry costs one settle of game time and is reported as BOX_TABLE_STALE, rather than
-- quietly measuring a machine that was never fed.

local boxes = {}

-- The facts themselves, kept apart from the module table: `pairs` over this one must see machines
-- only, and a module function mixed in would be walked as if it were a direction table.
local known = {}

known["oil-refinery"] = {
  [0] = {
    ["in"] = {
      ["crude-oil"] = { face = "south", off = 1 },
      ["water"] = { face = "south", off = -1 },
    },
    ["out"] = {
      -- the only product whose outlet cell has been read; light oil and heavy oil stayed inside
      -- the machine when every empty pipe offered to them refused to fill
      ["petroleum-gas"] = { face = "north", off = 2 },
    },
  },
}

-- `kind` is "in" or "out". Returns face, off when this machine/direction/fluid triple is known.
function boxes.lookup(name, direction, fluid, kind)
  local by_direction = known[name]
  local here = by_direction and by_direction[direction or 0]
  local by_fluid = here and here[kind]
  local cell = by_fluid and by_fluid[fluid]
  if not cell then return nil end
  return cell.face, cell.off
end

-- What the table already claims, for `capabilities` and for anyone deciding whether a card is
-- worth measuring at all. A machine missing here is not a problem -- it is one discovery away.
function boxes.covered()
  local out = {}
  for name, by_direction in pairs(known) do
    for direction, sides in pairs(by_direction) do
      for kind, by_fluid in pairs(sides) do
        for fluid, cell in pairs(by_fluid) do
          out[#out + 1] = { machine = name, direction = direction, kind = kind, fluid = fluid,
            face = cell.face, off = cell.off }
        end
      end
    end
  end
  table.sort(out, function(a, b)
    if a.machine ~= b.machine then return a.machine < b.machine end
    if a.kind ~= b.kind then return a.kind < b.kind end
    return a.fluid < b.fluid
  end)
  return out
end

return boxes
