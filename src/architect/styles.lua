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

-- The cell a belt delivers into: one step along its travel. Nothing solid may stand there -- the
-- engine will create a pole on that tile if asked nicely and `card.lint` then refuses the card it came
-- from, so every plan that drops parts next to a live line has to treat the exit as taken ground.
-- Only the four cardinals are mapped because only the four cardinals are what the styles lay; a
-- diagonal belt answers nil, which means "no extra ground is claimed", never "anything may stand here".
local STEP = { [D.north] = { 0, -1 }, [D.east] = { 1, 0 }, [D.south] = { 0, 1 }, [D.west] = { -1, 0 } }

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

-- The west-end load: an arm R away from the line's first tile, and the chest one R further out still --
-- on the cell the arm's hand actually reaches. The same three objects `row-chest` uses per lane, here
-- once per LINE, which is the whole economy of these two styles: pay for the interface per line, not
-- per machine.
--
-- The chest used to sit at `x0 - 3R`, one reach beyond the arm's hand, and both belt styles shipped
-- that way: an input line that never receives anything. `card_verify` says so as ARM_PICKS_NOTHING on
-- exactly the head arm of every line -- one for `row-belts`, two for a sandwich's two input rows.
local function load_head(out, g, x0, y)
  local R = g.reach
  out[#out + 1] = { name = g.chest, cell = { x0 - 2 * R, y }, dir = 0, role = "in" }
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

-- Which belt rows carry the PRODUCT out of this shape. A row of machines under a belt can feed from a
-- line, dump into a line, or lift straight into a chest beside the machine (`row-chest` does the last,
-- which is why it has no product line at all), and the difference is the difference between "this row
-- can move 1800 plates a minute" and "this row can move nothing, because its output is an arm".
--
-- Followed through the arm rather than guessed from proximity: an outlet chest is served by the arm
-- whose DROP face is the chest's cell, and the line that arm's hand reaches is the product line. That
-- survives a turned shape -- the offset rotates with the parts, while "the nearest belt" would find
-- `row-chest`'s feed line and call it an outlet, which is the wrong answer in exactly the case this
-- count exists to catch.
--
-- A row counted here is one belt tier's worth of throughput; length does not matter, because every
-- segment of a series has to pass the whole flow. N outlet lines is N times one row.
function S.product_lines(specs, is_belt, reach)
  local arms, belts, lines = {}, {}, {}
  local R = math.max(1, math.floor(reach or 1))
  for _, s in ipairs(specs or {}) do
    if s.dir and STEP[s.dir] then arms[(s.cell[1]) .. "," .. (s.cell[2])] = s.dir end
    if is_belt and is_belt(s.name) then
      local horiz = s.dir == D.east or s.dir == D.west
      belts[s.cell[1] .. "," .. s.cell[2]] = { axis = horiz and "row" or "col",
                                               key = horiz and s.cell[2] or s.cell[1] }
    end
  end
  local found = {}
  for _, s in ipairs(specs or {}) do
    if s.role == "out" then
      for _, d in ipairs({ D.north, D.east, D.south, D.west }) do
        local v = STEP[d]
        -- the arm that drops into this chest stands R further along its own pickup face
        local ax, ay = s.cell[1] + v[1] * R, s.cell[2] + v[2] * R
        if arms[ax .. "," .. ay] == d then
          local px, py = ax + v[1] * R, ay + v[2] * R
          local line = belts[px .. "," .. py]
          if line then found[line.axis .. ":" .. line.key] = { axis = line.axis, key = line.key } end
        end
      end
    end
  end
  local rows, n = {}, 0
  for _, l in pairs(found) do
    n = n + 1
    rows[#rows + 1] = { axis = l.axis, line = l.key }
  end
  table.sort(rows, function(a, b)
    if a.axis ~= b.axis then return a.axis < b.axis end
    return a.line < b.line
  end)
  return { lines = n, rows = rows }
end

-- ---------------------------------------------------------------- the gap arithmetic one file owns
--
-- "Is this box within reach of that one" is asked by the pole grid below AND by `verify.plan_power`,
-- which decides whether a real pole on real ground joined a real network. Two copies of the same
-- Chebyshev arithmetic is how a plan comes to claim coverage the engine then refuses, so this is the
-- one place it is written and `verify` reads it from here.
local function axis_gap(a0, a1, b0, b1)
  if a1 < b0 then return b0 - a1 end
  if b1 < a0 then return a0 - b1 end
  return 0
end

function S.box_gap(a, b)
  return math.max(axis_gap(a.x0, a.x1, b.x0, b.x1), axis_gap(a.y0, a.y1, b.y0, b.y1))
end

function S.pole_box(x, y, w, h)
  return { x0 = x, y0 = y, x1 = x + (w or 1) - 1, y1 = y + (h or 1) - 1 }
end

function S.covers(supply, pb, cb)
  return S.box_gap(pb, cb) <= supply
end


function S.belt_exit(x, y, dir)
  local s = dir and STEP[dir]
  if not s then return nil end
  return { x + s[1], y + s[2] }
end

-- ---------------------------------------------------------------- poles on a grid, not in a heap
--
-- A row of furnaces needs power, and the answer so far was `plan_power`: cover the dark machines
-- one at a time, each pole at the cell that happens to light the most of them. That is correct and
-- it is ugly -- poles end up bunched on whichever side the search started from, dangling off the
-- edge of a layout that had aisles down its whole length. What a player draws is a LINE of poles at
-- a regular spacing, dropped into the gaps between rows, dodging only where a furnace is standing.
--
-- So this lays them on a lattice and lets the lattice be bent, never abandoned:
--
--   * the step is `min(2*supply+1, wire-1)`, not just the coverage figure. 2*supply+1 is the widest
--     spacing where every tile on the plane still lies within a pole's supply area, so no machine can
--     fall between the meshes; `wire-1` is the margin `plan_power` chains with, so the two agree on
--     how far apart two poles may stand and still be one grid.
--   * a lattice cell that is occupied is nudged, not skipped: the candidate closest to the ideal
--     point wins, so the line stays a line.
--   * a pole is only planted where it can reach one already standing. This is the difference between
--     a grid and a set of lamps: coverage arithmetic alone will happily light every machine from its
--     own island, and the engine then reports nine networks where the plan claimed one. It also means
--     a machine the connected row cannot stretch to is left in `uncovered` rather than lit from an
--     island -- the caller says so out loud, and `plan_power` takes the mess with an engine to check
--     itself against.
--
-- Pure arithmetic again, like the rest of this file: `facts` is measured by the caller (only the
-- engine knows a pole's reach), `blocked` is the caller's occupancy map, and nothing here claims the
-- result builds. It goes through the same lint and the same `card_verify` as every other part.
function S.pole_grid(needles, facts, blocked, opts)
  opts = opts or {}
  local supply = math.max(0, math.floor(facts.supply or 0))
  local pw, ph = facts.w or 1, facts.h or 1
  if #needles == 0 then
    return { cells = {}, uncovered = {}, step = 0, why = "nothing-to-cover" }
  end
  if supply < 1 then
    return { cells = {}, uncovered = {}, step = 0, why = "no-supply" }
  end
  local wire = math.max(1, math.floor(facts.wire or 0) - 1)
  local step = math.min(2 * supply + 1, wire)
  local max_poles = opts.max or 200

  local x0, y0 = math.huge, math.huge
  for _, b in ipairs(needles) do
    if b.x0 < x0 then x0 = b.x0 end
    if b.y0 < y0 then y0 = b.y0 end
  end
  -- The lattice is anchored on the machines rather than on the world, so the same row laid one tile
  -- east gets the same poles one tile east. An anchor at 0 would make the pattern jump when a plan
  -- moved, which is the thing a player would notice as "why is it there and not there".
  local ox, oy = x0 - supply, y0 - supply
  local function drift_of(x, y)
    return math.max(math.abs(x - (ox + math.floor((x - ox) / step) * step)),
      math.abs(y - (oy + math.floor((y - oy) / step) * step)))
  end

  -- Every cell that fits the shape and reaches at least one machine, with the machines it reaches,
  -- computed once. Only two things change as poles go down: which machines are still dark, and which
  -- cells the last pole took.
  local seen, cells = {}, {}
  for i, nb in ipairs(needles) do
    for x = nb.x0 - supply - pw + 1, nb.x1 + supply do
      for y = nb.y0 - supply - ph + 1, nb.y1 + supply do
        local k = x .. "," .. y
        local c = seen[k]
        if not c then
          local pb = S.pole_box(x, y, pw, ph)
          if not (blocked and blocked(x, y, pw, ph)) then
            c = { x = x, y = y, drift = drift_of(x, y), lit = {}, box = pb }
            seen[k] = c
            cells[#cells + 1] = c
          end
        end
        if c and S.covers(supply, c.box, nb) then c.lit[#c.lit + 1] = i end
      end
    end
  end
  table.sort(cells, function(a, b)
    if a.drift ~= b.drift then return a.drift < b.drift end
    if #a.lit ~= #b.lit then return #a.lit > #b.lit end
    if a.y ~= b.y then return a.y < b.y end
    return a.x < b.x
  end)

  local taken = {}
  local laid, drift_max = {}, 0
  local function overlaps(x, y)
    local pb = S.pole_box(x, y, pw, ph)
    for _, c in ipairs(laid) do
      -- Overlapping boxes, not equal cells: a two-tile pole has to clear every tile of the last one.
      if S.box_gap(pb, c.box) <= 0 then return true end
    end
    return false
  end

  local function reaches(c, must)
    -- Every pole prefers to stand within wire reach of one already there. Coverage alone would light
    -- each machine from its own island and report a grid it does not have.
    if not must or #laid == 0 then return true end
    for _, o in ipairs(laid) do
      if S.box_gap(c.box, o.box) <= wire then return true end
    end
    return false
  end

  -- A pass in drift order, and passes until a pass adds nothing. One pass is not enough: a cell the
  -- first pass rejected because no pole stood in reach of it yet can be in reach of one the same pass
  -- laid further along, and the machines it covers are the reason a later pass exists.
  --
  -- When a connected pass adds nothing while machines are still dark, the next pass drops the
  -- requirement. The order is the bargain: a furnace standing in the dark is a broken factory, while a
  -- second island is a line the power search has to bridge -- and bridging is a thing the search does
  -- with an engine to check itself against, which a plan-time lattice does not have. `islands` reports
  -- how many there ended up being, so the shape says what it left for that pass to do.
  local rounds, need_reach = 0, true
  while rounds < 12 do
    rounds = rounds + 1
    local added = 0
    for _, c in ipairs(cells) do
      if #laid < max_poles then
        local wins = 0
        for _, i in ipairs(c.lit) do if not taken[i] then wins = wins + 1 end end
        if wins > 0 and not overlaps(c.x, c.y) and reaches(c, need_reach) then
          laid[#laid + 1] = c
          for _, i in ipairs(c.lit) do taken[i] = true end
          if c.drift > drift_max then drift_max = c.drift end
          added = added + 1
        end
      end
    end
    if added > 0 then
      need_reach = true
    elseif need_reach then
      need_reach = false
    else
      break
    end
  end

  -- How many rows of poles this ended up as. One is a grid; more is a line the power search has to
  -- bridge, and the number is reported rather than assumed because the bridge is exactly what a
  -- plan-time lattice cannot promise. Counted pole to pole -- a machine is not a wire relay -- with
  -- the same distance the lattice prefers.
  local joined, islands = {}, 0
  for i = 1, #laid do
    if not joined[i] then
      islands = islands + 1
      joined[i] = true
      local walk, at = { i }, 1
      while at <= #walk do
        local a = laid[walk[at]]
        at = at + 1
        for j = 1, #laid do
          if not joined[j] and S.box_gap(a.box, laid[j].box) <= wire then
            joined[j] = true
            walk[#walk + 1] = j
          end
        end
      end
    end
  end

  local uncovered, dark_at = {}, {}
  for i = 1, #needles do
    if not taken[i] then
      uncovered[#uncovered + 1] = i
      dark_at[#dark_at + 1] = { x = needles[i].x0, y = needles[i].y0 }
    end
  end
  local out = {}
  for _, c in ipairs(laid) do out[#out + 1] = { x = c.x, y = c.y } end
  return { cells = out, uncovered = uncovered, dark_at = dark_at, step = step, drift = drift_max,
    supply = supply, wire = wire, w = pw, h = ph, candidates = #cells, islands = islands }
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

-- Slide a finished shape so its top-left occupied tile is cell {0,0}.
--
-- Every reader downstream -- the footprint a box gets compared against, the packer that stacks lanes,
-- the compose that decides seams -- assumes the shape starts at the origin, because that is what a
-- footprint of "width W, height H" means. `sandwich-2` breaks the assumption on its own: its spine is
-- measured outward from the middle, so the upper half lands at negative cells, and a quarter turn moves
-- whichever axis went negative over to the other one. The shape itself lints; only the NUMBER is a lie
-- (8 rows of parts reported as 6), and lanes stacked at 6 overlap by 2 -- which comes back from the
-- engine as BELT_INTO_SOLID on every row but the first.
--
-- Nothing here decides where a part goes. It moves the origin to where the footprint already pretends
-- it is, which is the one fix that does not have to be re-decided per style.
function S.normalize(specs)
  local minx, miny
  for _, s in ipairs(specs or {}) do
    if not minx or s.cell[1] < minx then minx = s.cell[1] end
    if not miny or s.cell[2] < miny then miny = s.cell[2] end
  end
  if not minx or (minx == 0 and miny == 0) then return specs end
  local out = {}
  for _, s in ipairs(specs) do
    out[#out + 1] = { name = s.name, cell = { s.cell[1] - minx, s.cell[2] - miny }, dir = s.dir, role = s.role }
  end
  return out
end

return S
