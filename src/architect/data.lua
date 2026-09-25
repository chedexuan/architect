-- Icon names the panel can actually draw.
--
-- Factorio's GUI asks for a `SpritePath`, and a SpritePath is either the name of a prototype defined
-- in the data stage or a `type/name` reference -- NOT a file path. So a mod that wants an item's
-- picture cannot hand the widget `__base__/graphics/icons/iron-plate.png`: it has to have registered
-- that file as a sprite first. This file is where that registration happens, because the icon paths
-- live on data-stage prototypes (`ItemPrototype.icon`), and the control stage cannot read them:
-- the runtime `LuaItemPrototype` has no icon member at all (checked against this install's
-- runtime-api.json, all 70 attributes of it).
--
-- Two things follow, and both are said out loud by the panel rather than hidden:
--
--   * An item with no `icon` and no `icons` gets no sprite, and the window draws its row without a
--     picture. Skipping silently would be the same mistake as a label that says "unknown".
--   * A 2.0 icon may be a COMPOSITION -- `icons` is a list of layers (base image, quality frame,
--     glow). Only the first layer is registered here, so those items show their base picture and not
--     their overlay. That is a smaller lie than not drawing anything, but it is still a difference
--     from what the inventory shows, and `helpers.is_valid_sprite_path` is what the panel asks before
--     drawing whatever is there.
--
-- Cost, since this runs for every mod's items on every load: one small prototype per item, fluid,
-- recipe, machine and technology. Nothing is copied; the sprite points at the same file the game
-- already loads.
local PREFIX = "arch-icon-"

local added, no_icon, composed = 0, 0, 0

local function icon_of(proto)
  local path = proto.icon
  if type(path) ~= "string" then
    local layers = proto.icons
    if type(layers) == "table" then
      local first = layers[1]
      path = type(first) == "table" and first.icon or nil
      if type(layers[2]) == "table" then composed = composed + 1 end
    end
  end
  if type(path) ~= "string" then return nil end
  local size = tonumber(proto.icon_size)
  if not size and type(proto.icons) == "table" and type(proto.icons[1]) == "table" then
    size = tonumber(proto.icons[1].icon_size)
  end
  return path, size or 32
end

-- `data.raw` is keyed by prototype type, and every kind the panel labels with a name is in here.
-- Machine names matter as much as item names: a plan row says "16 electric furnaces", and the picture
-- that makes the row scannable is the furnace's, not the plate's.
for _, group in ipairs({
  { kind = "item", types = { "item" } },
  { kind = "fluid", types = { "fluid" } },
  { kind = "recipe", types = { "recipe", "resource" } },
  { kind = "entity", types = { "assembling-machine", "furnace", "mining-drill", "boiler", "reactor",
    "lab", "generator", "pump", "smokestack", "pipe-to-ground", "offshore-pump", "storage-tank",
    "electric-pole", "transport-belt", "inserter", "underground-belt", "loader", "arithmetic-combinator",
    "decider-combinator", "constant-combinator", "accumulator", "solar-panel", "beacon", "roboport",
    "ammo-turret", "electric-turret", "laser-turret", "train-stop", "rail-signal", "radar", "assembler" } },
  { kind = "tech", types = { "technology" } },
}) do
  for _, t in ipairs(group.types) do
    for name, proto in pairs(data.raw[t] or {}) do
      -- A prototype's own name is what the GUI looks a sprite up by, and the sprite name has to be a
      -- single token: modded names already contain `.` and `_`, both of which are legal in prototype
      -- names. Nothing else is escaped, because nothing else can appear.
      local path, size = icon_of(proto)
      if path then
        data:extend({ {
          type = "sprite",
          name = PREFIX .. group.kind .. "-" .. name,
          filename = path,
          size = size,
          -- No `flags`: the values this build accepts are `no-crop, not-compressed, always-compressed,
          -- mipmap, linear-*, alpha-mask, no-scale, mask, icon, gui, gui-icon, light, terrain,
          -- terrain-effect-map` -- read out of this install's prototype-api.json -- and there is no
          -- "hide this from the library" among them. Guessing one costs a load failure, and an omitted
          -- optional field costs nothing.
        } })
        added = added + 1
      else
        no_icon = no_icon + 1
      end
    end
  end
end

-- `log` is available in the data stage and this is the only number worth having from here: if a future
-- update changes where icons live, the panel will draw nothing and the load log will say why.
log("architect: registered " .. added .. " icon sprites (" .. no_icon
  .. " prototypes have no icon, " .. composed .. " of those were multi-layer and kept their base)")
