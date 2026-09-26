-- Layout styles: one geometry per way of arranging the same recipe.
--
-- A plan says "14 electric furnaces". It does not say where their belts run, and the answer to that
-- changes what the plan costs: one row with a belt on each side is two belt runs and two arms per
-- machine, while two rows sharing a middle belt are three runs and one shared outlet for the pair. Same
-- machines, same rate, different factory. This file is where those shapes live, so that a new one -- a
-- food line, a fluid block, a power station -- is ADDED here rather than threaded through the code that
-- already works.
--
-- Three rules hold every style to the same bargain:
--
--   * A style emits parts, it does not choose them. Which arm, which belt, which chest is reachable is
--     `roles.pick`'s decision (and the arm's reach is MEASURED, because the runtime prototype does not
--     carry it). The geometry receives `reach` and lays out in multiples of it.
--   * Whether a style can be BUILT is never the style's claim. Every style's output goes through the
--     same lint and the same `card_verify` that puts the parts on real ground, so a shape that looks
--     tidy in this file and cannot exist on the planet is refused by the engine, not by a comment here.
--   * What a style costs is COUNTED from what it emitted, never declared beside it. A manifest kept by
--     hand next to a geometry drifts the first time someone moves a chest, and a drifted manifest is a
--     bill of materials that lies.
--
-- Coordinates are tile cells (`cell = {x, y}`, integer, x east, y south) and an inserter's `direction`
-- is its PICKUP side -- it drops on the opposite face. Both are the convention `lane_units` already
-- worked in, and `card_example` is the only caller, so both stay.
--
-- The direction NUMBERS come from the engine rather than from memory: this build's `defines.direction`
-- is a 16-value ring with the cardinals at 0/4/8/12, not the 0/2/4/6 the 1.1-era mental model (and the
-- first draft of this file) wrote. A style that guessed got a lane whose belts flowed one way and whose
-- arms picked up from the opposite face -- legal to place, wrong to watch, and caught only by a ledger.
local D = defines.direction
local DIR = { north = D.north, east = D.east, south = D.south, west = D.west }
local QUARTER = D.east - D.north
local RING = (D.west - D.north) + QUARTER

local S = {}
local STYLES = {}
local ORDER = {}

-- `about` is what the panel can show and what a refusal quotes; `units` is the geometry itself.
-- `turnable` is a claim about the SHAPE only: a style that stays legal rotated 90° is turned by
-- `S.turn`, and one whose parts are direction-bound (a fluid line, a pump face) says so and the caller
-- refuses instead of laying something that cannot be built.
function S.define(id, style)
  assert(type(id) == "string" and type(style) == "table" and type(style.units) == "function",
    "a style is an id and a function of parts")
  style.id = id
  style.turnable = style.turnable ~= false
  STYLES[id] = style
  ORDER[#ORDER + 1] = id
  return style
end

function S.get(id) return STYLES[id] end

function S.ids()
  local out = {}
  for _, id in ipairs(ORDER) do out[#out + 1] = id end
  return out
end

-- ---------------------------------------------------------------- the belt row
--
-- `run` tiles of belt travelling east, from `x0` on row `y`. The last tile is where an outlet can be
-- taken; a style that ends its belt in mid-air has written a shape with no exit, which is why the run
-- is returned rather than assumed.
local function belt_run(out, x0, y, run, belt)
  for b = 0, run - 1 do
    out[#out + 1] = { name = belt, cell = { x0 + b, y }, dir = DIR.east }
  end
  return x0 + run - 1
end

-- ---------------------------------------------------------------- style: one row, one chest
--
-- The shape this mod has always built: a lane self-contained, product lifted straight into a chest
-- beside the machine, one belt row per lane. It is here as a style so that the others are comparisons
-- against it rather than replacements for it -- and so that `card_example`'s old default is a value
-- like any other, which is the only way a panel can offer it.
--
--   y=0          [in] ...[A]... [belt][belt][belt][belt][belt] [overflow]
--   y=R                            [B]
--   y=2R                       [machine fw x fh]
--   y=2R+fh-1                                [C] [out]
S.define("row-chest", {
  words = "style-row-chest",
  -- The lane's own geometry, unchanged in every particular including the pitch formula's two terms:
  -- the footprint that `plan_fit` packs into a box is measured from what came out here, so a tweak to
  -- these numbers silently redraws every "能否放下" answer in the game.
  units = function(g)
    local R, out = g.reach, {}
    local run = 2 * R + 3
    local fcol = 2 * R + math.floor(run / 2)
    local out_row = g.oy + 2 * R + g.fh - 1
    local rightmost = fcol + g.fw - 1 + 2 * R
    local pitch = math.max(2 * R + run + 3, rightmost + 3) + g.gap
    for i = 0, g.count - 1 do
      local ux = g.ox + i * pitch
      out[#out + 1] = { name = g.chest, cell = { ux, g.oy }, dir = 0, role = "in" }
      out[#out + 1] = { name = g.arm, cell = { ux + R, g.oy }, dir = DIR.west }
      belt_run(out, ux + 2 * R, g.oy, run, g.belt)
      out[#out + 1] = { name = g.chest, cell = { ux + 2 * R + run, g.oy }, dir = 0, role = "overflow" }
      out[#out + 1] = { name = g.arm, cell = { ux + fcol, g.oy + R }, dir = DIR.north }
      out[#out + 1] = { name = g.machine, cell = { ux + fcol, g.oy + 2 * R }, dir = 0 }
      out[#out + 1] = { name = g.arm, cell = { ux + fcol + g.fw - 1 + R, out_row }, dir = DIR.west }
      out[#out + 1] = { name = g.chest, cell = { ux + rightmost, out_row }, dir = 0, role = "out" }
      if g.outlets and g.outlets >= 2 then
        out[#out + 1] = { name = g.arm, cell = { ux + fcol + g.fw - 1 + R, g.oy + 2 * R }, dir = DIR.west }
        out[#out + 1] = { name = g.chest, cell = { ux + rightmost, g.oy + 2 * R }, dir = 0, role = "out" }
      end
      if g.power then
        out[#out + 1] = { name = g.power, cell = { ux + rightmost + 2, g.oy + R }, dir = 0 }
      end
    end
    return out, pitch
  end,
})

-- ---------------------------------------------------------------- what a shape cost
--
-- Counted, as the header says. `cards` keeps `lanes` for the flow arithmetic; this is the sibling that
-- answers "how many belts and arms do I have to craft before I build it", and it is derived from the
-- same list of parts the ghosts are made of, so it cannot disagree with them.
--
-- `kind_of` is handed in rather than looked up here: this file has no `prototypes` of its own to read,
-- and a style library that quietly reached into the game would be one more place to mock in a test.
function S.count(specs, kind_of)
  local got = { belts = 0, arms = 0, machines = 0, chests = 0, poles = 0, others = 0 }
  for _, s in ipairs(specs or {}) do
    local kind = (kind_of and kind_of(s.name)) or "?"
    if kind == "transport-belt" then got.belts = got.belts + 1
    elseif kind == "inserter" then got.arms = got.arms + 1
    elseif kind == "chest" or kind == "logistic-chest" or kind == "container" then got.chests = got.chests + 1
    elseif kind == "furnace" or kind == "assembling-machine" or kind == "boiler" then got.machines = got.machines + 1
    elseif kind == "electric-pole" then got.poles = got.poles + 1
    else got.others = got.others + 1 end
  end
  return got
end

-- A quarter turn, for the styles that allow it. Cells are rotated about the origin and shifted back into
-- positive space, and every direction advances by one quarter of the ring -- which is four steps on this
-- build and is not a number this file writes down. Belts keep flowing along the new axis; an arm's
-- pickup face turns with it, which is the whole point of doing this once, here, instead of in each style.
--
-- What a cell MEANS is the trap this function exists to avoid stepping in: it is the top-left of the
-- rectangle the part occupies, not a point. Rotating the corner of a 3x3 furnace as if it were a dot
-- leaves it two tiles off, which is legal to place, invisible in a footprint number, and lands the
-- furnace on top of its own arm -- found here by `layout_ledger`, not by looking at it. So the rectangle
-- turns, and a part whose width and height differ cannot be turned by this arithmetic at all: it is
-- refused with its own name rather than laid out a tile and a half away from where the style put it.
local function quarter(d)
  return ((d - D.north + QUARTER) % RING) + D.north
end

function S.turn(specs, times, size_of)
  local n = math.floor(times or 0) % 4
  if n == 0 then return specs, nil end
  local function rot_rect(x, y, w, h)
    for _ = 1, n do x, y, w, h = -(y + h - 1), x, h, w end
    return x, y, w, h
  end
  local function size(name)
    if not size_of then return 1, 1 end
    local w, h = size_of(name)
    return tonumber(w) or 1, tonumber(h) or 1
  end
  local minx = 0
  for _, s in ipairs(specs) do
    local w, h = size(s.name)
    if w ~= h then
      return nil, string.format("%s is %dx%d, and a part whose width and height differ cannot be turned by this arithmetic",
        tostring(s.name), w, h)
    end
    local x = rot_rect(s.cell[1], s.cell[2], w, h)
    if x < minx then minx = x end
  end
  local out = {}
  for _, s in ipairs(specs) do
    local w, h = size(s.name)
    local x, y = rot_rect(s.cell[1], s.cell[2], w, h)
    local d = s.dir or D.north
    for _ = 1, n do d = quarter(d) end
    out[#out + 1] = { name = s.name, cell = { x - minx, y }, dir = d, role = s.role }
  end
  return out, nil
end

return S
