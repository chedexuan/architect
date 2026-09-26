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

-- ---------------------------------------------------------------- the shared column arithmetic
--
-- Declared before every style that uses them: Lua binds a `local` only for the text that follows it, so
-- a helper defined below a style is not a helper there at all -- it compiles as a global lookup that
-- answers nil, and the style only fails the first time someone lays a row. `dev/lint.py` has a gate for
-- exactly this shape; it is the reason these three sit up here rather than beside the styles they serve.
local function col_pitch(g)
  -- One machine, one arm column either side of it, and enough aisle that a long-handed arm reaching
  -- over its own machine cannot also be standing on its neighbour's.
  return g.fw + 2 * g.reach + 1
end

-- The west-end load: a chest, an arm R away, and the drop landing on the first tile of the line. The
-- same three objects `row-chest` uses per lane, here once per LINE -- which is the whole economy of
-- these two styles: pay for the interface per line, not per machine.
local function load_head(out, g, x0, y)
  local R = g.reach
  out[#out + 1] = { name = g.chest, cell = { x0 - 2 * R - R, y }, dir = 0, role = "in" }
  out[#out + 1] = { name = g.arm, cell = { x0 - R, y }, dir = DIR.west }
end

-- The east-end outlet: an arm lifting off the last tile of the line into a chest beyond it.
local function take_tail(out, g, x1, y)
  local R = g.reach
  out[#out + 1] = { name = g.arm, cell = { x1 + R, y }, dir = DIR.west }
  out[#out + 1] = { name = g.chest, cell = { x1 + 2 * R, y }, dir = 0, role = "out" }
end


-- ---------------------------------------------------------------- the belt lines of a shape
--
-- Which lines a shape lays, and how long each is. Counted from the emitted parts by walking the rows
-- they sit on, because "how many belts does this cost" is the question a style is picked with, and a
-- number written beside the geometry would be a second truth free to drift.
--
-- A lane of stubs and a row of one continuous line hold the same machines and cost very little in
-- tiles -- what differs is the number of LINES, which is what a player counts when they say a shape is
-- cheap: two rows behind one product belt is three lines, the same two rows laid as two single rows is
-- four. So the line count is what `styles` reports and what the ledger asserts.
function S.lines(specs, is_belt)
  local by_row, by_col = {}, {}
  for _, s in ipairs(specs or {}) do
    -- Belts only. An arm that lifts onto a line faces along it (`dir` is its pickup side), so folding the
    -- arms in counted every arm column as a belt line -- which is how a two-row shape came out at nine
    -- lines, and the comparison this number exists to make became meaningless.
    if not is_belt or is_belt(s.name) then
      -- A belt's `dir` is its travel: east-going belts share a row, north-going ones a column. Turning a
      -- shape swaps which of the two fills up, which is why both are walked rather than one.
      local horiz = s.dir == DIR.east or s.dir == DIR.west
      local map = horiz and by_row or by_col
      local key = horiz and s.cell[2] or s.cell[1]
      local at = horiz and s.cell[1] or s.cell[2]
      local n = map[key]
      if not n then
        n = { tiles = 0, from = at, to = at }
        map[key] = n
      end
      n.tiles = n.tiles + 1
      if at < n.from then n.from = at elseif at > n.to then n.to = at end
    end
  end
  local rows, cols = 0, 0
  for _ in pairs(by_row) do rows = rows + 1 end
  for _ in pairs(by_col) do cols = cols + 1 end
  return { rows = rows, cols = cols, total = rows + cols, by_row = by_row, by_col = by_col }
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

-- ---------------------------------------------------------------- style: two rows, one spine
--
-- The shape a player switches to when the factory is big enough to count what it spends: a product belt
-- down the middle, a row of machines on each side lifting onto it, and the raw-material belts on the two
-- outside faces. Two lanes pay THREE belt lines where `row-chest` pays two lines each and one shared
-- outlet instead of two -- the saving is in belts and outlets, and the price is height, because an outlet
-- arm has to fit between its machine and the spine (an arm drops straight opposite what it picks up, so
-- the row it can drop on is exactly one reach away).
--
-- Rows, mirrored about the spine at `sp`, every distance a multiple of the arm's reach R:
--
--   sp-4R-fh+1   原料带 (upper), east; in-chest at its west end, overflow at its east
--   sp-3R-fh+1   arm: pickup north (the belt above), drop south into the machine's top row
--   sp-2R-fh+1   machine (upper) ... occupies fh rows down to sp-2R
--   sp-R         arm: pickup north (the machine's bottom row), drop south onto the spine
--   sp           SPINE, east, one outlet at its east end for the whole pair
--   sp+R         arm: pickup south (the lower machine's top row), drop north onto the spine
--   sp+2R        machine (lower) ... down to sp+2R+fh-1
--   sp+3R+fh-1   arm: pickup south (the machine's bottom row), drop north? no -- south, onto the belt
--   sp+4R+fh-1   原料带 (lower), east
--
-- An odd count is laid as an uneven pair rather than rounded down: a plan that asked for seven and got
-- six is a silent lie, while four-and-three is a shape someone can see and decide about.
S.define("sandwich-2", {
  words = "style-sandwich-2",
  -- A lane of THIS style is a pair. Whoever packs lanes into a box has to count templates, not machines,
  -- or four lanes of a two-row style lays eight machines and reports four.
  per_lane = 2,
  -- A style's own conditions on the plan, as data the caller turns into its own refusal: the sentence
  -- and its locale key stay in `control.lua`, where the locale gate can prove the key exists, instead of
  -- being a key assembled out of a table field at runtime.
  min_units = 2,
  units = function(g)
    local R, fh, out = g.reach, g.fh, {}
    -- The odd machine goes to the upper row, so the two halves always add back to what was asked for:
    -- `ceil` and `floor` of the same number are the pair, while `count` and `floor(count/2)` -- which is
    -- what the first version of this line said, through an `and/or` that silently missed the helper it
    -- meant to call -- laid six machines for a plan that asked for four. `layout_ledger` counts them.
    local upper, lower = math.ceil(g.count / 2), math.floor(g.count / 2)
    -- Placed so the topmost thing emitted lands on `g.oy`, which is what every other style does and what
    -- lets `plan_fit` stack templates without one of them starting a row higher than the rest.
    local sp = g.oy + 4 * R + fh - 1
    local pitch = col_pitch(g) + g.gap
    local mid = math.floor(g.fw / 2)
    local u_in, l_in = sp - 4 * R - fh + 1, sp + 4 * R + fh - 1
    local u_mach, l_mach = sp - 2 * R - fh + 1, sp + 2 * R
    -- One line per row, spanning that row's machines -- not a run per machine, which is what the first
    -- draft did and what made this style cost MORE belt than two single rows. A line's worth of load and
    -- outlet is paid once however many machines hang off it, and that is the whole saving.
    local function row_line(n, y)
      if n < 1 then return nil end
      local first, last = g.ox, g.ox + (n - 1) * pitch
      belt_run(out, first, y, (last - first) + g.fw, g.belt)
      return first, last
    end
    local u_first, u_last = row_line(upper, u_in)
    local l_first, l_last = row_line(lower, l_in)
    local spine_last = g.ox + (math.max(upper, lower) - 1) * pitch + g.fw - 1
    belt_run(out, g.ox, sp, (spine_last - g.ox) + 1, g.belt)
    if u_first then load_head(out, g, u_first, u_in) end
    if l_first then load_head(out, g, l_first, l_in) end
    -- One outlet for the pair, at the spine's east end: the line the products meet on has one exit, and
    -- the composition anchors are chests, so a style that ended in a bare belt would leave the next card
    -- nothing to fuse onto.
    take_tail(out, g, spine_last, sp)
    for i = 0, upper - 1 do
      local mx = g.ox + i * pitch
      out[#out + 1] = { name = g.arm, cell = { mx + mid, u_in + R }, dir = DIR.south }
      out[#out + 1] = { name = g.machine, cell = { mx, u_mach }, dir = 0 }
      out[#out + 1] = { name = g.arm, cell = { mx + mid, sp - R }, dir = DIR.north }
    end
    for i = 0, lower - 1 do
      local mx = g.ox + i * pitch
      out[#out + 1] = { name = g.machine, cell = { mx, l_mach }, dir = 0 }
      out [#out + 1] = { name = g.arm, cell = { mx + mid, sp + R }, dir = DIR.south }
      out[#out + 1] = { name = g.arm, cell = { mx + mid, l_mach + fh - 1 + R }, dir = DIR.north }
    end
    return out, pitch
  end,
})

-- ---------------------------------------------------------------- the two belt-ended rows
--
-- `row-chest` spends no product belt at all: an arm lifts the plate out of the machine into a chest
-- beside it, one chest per lane, and the lane's only belt is the short run that feeds it. That is cheap
-- in ground and expensive in things-to-craft once there are dozens of lanes, and it is not what anyone
-- builds at scale: at scale the product rides a LINE, and lines are what rows share.
--
-- These two styles are the pair that comparison needs. `row-belts` is one row with a line on each side
-- of the machines -- two lines per row. `sandwich-2` is two such rows back to back behind ONE product
-- line -- three lines per two rows. The saving a player counts is lines, not tiles: same machines, one
-- fewer belt to lay, one fewer outlet to craft, and a taller box to put them in.
S.define("row-belts", {
  words = "style-row-belts",
  units = function(g)
    local R, fh, out = g.reach, g.fh, {}
    local pitch = col_pitch(g) + g.gap
    local mid = math.floor(g.fw / 2)
    local in_row, mach_row = g.oy, g.oy + 2 * R
    local out_row = g.oy + 4 * R + fh - 1
    local first, last = g.ox, g.ox + (g.count - 1) * pitch
    belt_run(out, first, in_row, (last - first) + g.fw, g.belt)
    belt_run(out, first, out_row, (last - first) + g.fw, g.belt)
    load_head(out, g, first, in_row)
    take_tail(out, g, last + g.fw - 1, out_row)
    for i = 0, g.count - 1 do
      local mx = g.ox + i * pitch
      out[#out + 1] = { name = g.arm, cell = { mx + mid, in_row + R }, dir = DIR.south }
      out[#out + 1] = { name = g.machine, cell = { mx, mach_row }, dir = 0 }
      out[#out + 1] = { name = g.arm, cell = { mx + mid, mach_row + fh - 1 + R }, dir = DIR.north }
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
