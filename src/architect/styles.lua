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
-- One belt row can carry TWO flows, and which lane each flow lands in is GEOMETRY, not a setting. That
-- is what makes a shared line deliverable as a blueprint: measured on this build, a lane restriction
-- (`pickup_from_left_lane` / `pickup_from_right_lane`) can be written onto a live arm but is NOT kept by
-- a blueprint -- `set_blueprint_entities` reads back only `entity_number, name, position` -- so any
-- shape that NEEDED those flags would arrive at the player's hand already broken. What does survive is
-- the rule the game itself obeys, and it is the reason the rows below are arranged the way they are:
--
--   * an arm PICKING from a belt takes from either lane -- the side it stands on does not limit it;
--   * an arm DROPPING onto a belt only ever fills the FAR lane, never the near one.
--
-- So one belt row serving both an input and an output is legal, and it costs one row instead of two:
-- the feed enters from the INNER side (the side facing the machines it is feeding) and the product is
-- lifted from the OUTER side, and the two flows then ride different lanes of the same line without ever
-- being told to. A style that put them the other way round would drop both flows into the same lane --
-- which places cleanly, passes the lint, and starves a recipe two tiles downstream.
--
-- Whether a line can CARRY this is a separate question and it is arithmetic: a shared row holds one
-- flow's worth of throughput per lane, so the choice between "one row, two flows" and "one row per
-- flow" is `belt_ceiling` against each ingredient's per-minute demand -- see `M.helmod_ghosts`'s shape
-- ladder, which is where that decision is made for a computed plan.
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
  -- Machines sit at their own width. The arms of these two styles live in their OWN rows between the
  -- belt line and the machine row (`in_row + R`, `mach_row + fh - 1 + R`), not in a column beside each
  -- machine, so nothing needs an aisle: a long-handed arm two rows away cannot stand on its neighbour
  -- no matter how close the furnaces are.
  --
  -- The figure used to be `fw + 2*reach + 1`, which paid a machine's reach in WIDTH on both sides --
  -- 8 tiles per steel furnace instead of 3, and a computed plan of 48 smelters came out 339 tiles long
  -- on one belt line where the same line is 104 with the machines touching. Measured on the engine at
  -- both figures: `layout_ledger`'s 153 checks (the ones that FEED the lane and watch items move, not
  -- just draw it) pass either way, which is the proof that the aisle was never doing anything.
  return g.fw
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

-- ---------------------------------------------------------------- the fluid feed
--
-- A lane that DRINKS -- `concrete` wants water, and no chest takes delivery of a fluid -- cannot be fed
-- by the interface every other lane uses, so a row of pipe is grown into the FINISHED shape: one stub at
-- the cell the machine's own box opens onto, a spine joining the stubs, and the spine's near end left
-- standing free. That free pipe is the port a player's network joins, and it is the only part of this the
-- mod can decide for itself: where a machine's box is, and what the machine will actually be standing like
-- once it is built, are both asked of the engine by the caller.
--
-- Being a function over a finished shape rather than a line inside a style's own loop is a measurement
-- talking, not tidiness. The box does not necessarily face the way the card says it does: an assembling
-- machine or a furnace built out of a ghost comes back facing north whatever facing was asked for
-- (measured on this build -- `create_entity{direction=...}` answers north, and so does writing
-- `direction` afterwards, while a chemical plant, an oil refinery, a belt, an arm and a combinator all
-- keep what they were given). A feed drawn in the style's frame and turned with everything else would
-- therefore end up on the wrong side of the machine it feeds. So this runs after the turn, and it checks
-- the ground the turned shape actually leaves free instead of trusting a face somebody declared once.
--
-- One fluid, one row. A second ingredient would need a second row that must not touch the first, and the
-- adjacency is the reason the lab's own discovery pass exists at all; the caller refuses two fluids by
-- name rather than laying a shape that mixes them in the same pipe.
local FACING_UNIT = { north = { 0, -1 }, south = { 0, 1 }, east = { 1, 0 }, west = { -1, 0 } }

-- Appends the feed to `specs` and returns the index of the port part, or nil and why the row cannot be
-- laid here. `o` is the caller's answer to three engine questions: which machine to feed, which face of
-- it the fluid enters at (`ports.lua`), and how big the parts it stands among are.
function S.fluid_feed(specs, o)
  local u = o and FACING_UNIT[o.face or ""]
  if not u then return nil, { why = "NO_FEED_FACE", face = o and o.face } end
  local along = (u[1] == 0)      -- a box on the north or south face sits on a row; east/west on a column
  local off = o.off or 0
  -- Every tile the shape already stands on. This is the check the whole design turns on: the feed row is
  -- ground that is free in the shape as it will be built, and nothing here is allowed to assume it.
  local occ = {}
  for _, s in ipairs(specs or {}) do
    local w, h = o.size_of(s.name)
    for x = s.cell[1], s.cell[1] + w - 1 do
      for y = s.cell[2], s.cell[2] + h - 1 do occ[x .. "," .. y] = s.name end
    end
  end
  local mw, mh = o.w, o.h
  local tips, tip_at, lo, hi = {}, {}, math.huge, -math.huge
  for _, s in ipairs(specs or {}) do
    if s.name == o.machine then
      local at = along
        and { s.cell[1] + math.floor(mw / 2) + off, s.cell[2] + (u[2] < 0 and -1 or mh) }
        or { s.cell[1] + (u[1] < 0 and -1 or mw), s.cell[2] + math.floor(mh / 2) + off }
      local k = at[1] .. "," .. at[2]
      if occ[k] then
        return nil, { why = "FEED_CELL_TAKEN", face = o.face, off = off, cell = at, taken_by = occ[k] }
      end
      if not tip_at[k] then
        tip_at[k] = true
        tips[#tips + 1] = at
        occ[k] = o.pipe
        local v = along and at[1] or at[2]
        if v < lo then lo = v end
        if v > hi then hi = v end
      end
    end
  end
  if #tips == 0 then return nil, { why = "NO_MACHINES_IN_SHAPE", machine = o.machine } end
  local row = along and tips[1][2] or tips[1][1]
  -- One line, or nothing. A shape whose machines' boxes sit on TWO rows (a pair of rows mirrored about a
  -- spine) would need the run doubled and a bend to join the two, and this file does not guess at bends:
  -- `seams.lua` says outright that a bend is path finding through ground the mod does not own. So the row
  -- is refused by name, with the second line said, rather than laid as one run that leaves the far half of
  -- the lane with a pipe standing on its box and connected to nothing.
  for _, at in ipairs(tips) do
    local v = along and at[2] or at[1]
    if v ~= row then
      return nil, { why = "FEED_SPAN_MULTIPLE_LINES", face = o.face, off = off,
        first_line = row, other_line = v, cell = at }
    end
  end
  local function key_of(v) return along and (v .. "," .. row) or (row .. "," .. v) end
  local function cell_of(v) return along and { v, row } or { row, v } end
  local blocked
  local function claim(v)
    local k = key_of(v)
    if occ[k] then
      blocked = { why = "FEED_ROW_TAKEN", face = o.face, cell = cell_of(v), taken_by = occ[k] }
      return false
    end
    occ[k] = o.pipe
    return true
  end
  local laid, port_index = {}, nil
  for _, at in ipairs(tips) do
    laid[#laid + 1] = { name = o.pipe, cell = { at[1], at[2] }, dir = 0 }
  end
  -- The run between the stubs, laid in the same step that claims the ground: the first version marked the
  -- cells in the occupancy map and never emitted the parts, and a three-machine lane came back as three
  -- stubs, a port, and nothing between them -- a row of pipes that pipes nothing.
  for v = lo, hi do
    if not tip_at[key_of(v)] then
      if not claim(v) then return nil, blocked end
      laid[#laid + 1] = { name = o.pipe, cell = cell_of(v), dir = 0 }
    end
  end
  -- The port is one cell beyond an end of the run, so it is contiguous with the row by construction. The
  -- west/near end is tried first because it is the end a player reaches past the lane's own load; when that
  -- cell is standing ground the other end is tried, and a row with NEITHER end free is refused rather than
  -- laid with a port sitting one tile away from its own network.
  for _, v in ipairs({ lo - 1, hi + 1 }) do
    if claim(v) then
      laid[#laid + 1] = { name = o.pipe, cell = cell_of(v), dir = 0,
        -- the only part of a generated line this mod cannot finish: the cell the player's own network joins
        role = "fluid_in", fluid = o.fluid }
      port_index, blocked = #laid, nil
      break
    end
  end
  if not port_index then return nil, blocked end
  local before = #specs
  for _, p in ipairs(laid) do specs[#specs + 1] = p end
  return before + port_index, nil
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
    local ctrls = {}
    -- The chests a shortage bus reads, in the order the lanes laid them. Kept beside `ctrls` rather
    -- than looked up afterwards, because "which parts does this shape own" is only ever answered by
    -- counting what was emitted.
    local outs = {}
    for i = 0, g.count - 1 do
      local ux = g.ox + i * pitch
      out[#out + 1] = { name = g.chest, cell = { ux, g.oy }, dir = 0, role = "in" }
      out[#out + 1] = { name = g.arm, cell = { ux + R, g.oy }, dir = DIR.west }
      belt_run(out, ux + 2 * R, g.oy, run, g.belt)
      out[#out + 1] = { name = g.chest, cell = { ux + 2 * R + run, g.oy }, dir = 0, role = "overflow" }
      out[#out + 1] = { name = g.arm, cell = { ux + fcol, g.oy + R }, dir = DIR.north }
      out[#out + 1] = { name = g.machine, cell = { ux + fcol, g.oy + 2 * R }, dir = 0 }
      -- the index this machine holds in the part list, which is the only way a controller added two
      -- lines later can say who it drives. `S.turn` and `S.normalize` rebuild the list in order, so an
      -- index written here survives every rotation and slide the shape goes through.
      local machine_at = #out
      out[#out + 1] = { name = g.arm, cell = { ux + fcol + g.fw - 1 + R, out_row }, dir = DIR.west }
      out[#out + 1] = { name = g.chest, cell = { ux + rightmost, out_row }, dir = 0, role = "out" }
      local chest_at = #out
      if g.outlets and g.outlets >= 2 then
        out[#out + 1] = { name = g.arm, cell = { ux + fcol + g.fw - 1 + R, g.oy + 2 * R }, dir = DIR.west }
        out[#out + 1] = { name = g.chest, cell = { ux + rightmost, g.oy + 2 * R }, dir = 0, role = "out" }
      end
      -- The shelves a shortage bus reads from: this lane's own output chest, and its second outlet when
      -- the shape lays one. The products are what a factory is short OF and these chests already hold
      -- them, so the measurement comes off the line's own shelf rather than off a box the plan also had
      -- to place and nobody would ever fill.
      if g.bus_mode == "shortage" then
        outs[#outs + 1] = chest_at
        if g.outlets and g.outlets >= 2 then outs[#outs + 1] = #out end
      end
      if g.power then
        out[#out + 1] = { name = g.power, cell = { ux + rightmost + 2, g.oy + R }, dir = 0 }
      end
      -- The controller row, grown under the lane only when the plan asks these machines to take their
      -- recipe from a wire (`g.bus = { <recipe names, in the order they should be handed out> }`). Same
      -- spine, same pitch, one more row of ground -- because that is what a signal-controlled line IS:
      -- the same lane, with a controller standing under each machine and a bus under that. The row is
      -- emitted by this style rather than by a second one so the two cannot drift apart: a lane that
      -- rotates and a lane that does not must not disagree about where the machine stands.
      if g.bus then
        out[#out + 1] = {
          name = g.selector, cell = { ux + fcol, out_row + 2 }, dir = DIR.north,
          role = "control",
          -- each machine asks for its own position on the bus, and the positions are ZERO-BASED and
          -- ascending by count -- both measured (dev/circuit_rules_probe.js act M), and both the reason
          -- the counts below are written distinct: with equal counts the engine's tie-break is its own
          -- and the plan could not say which machine got what.
          -- Two jobs, same socket. `split` hands each machine its own position on the bus, so the
          -- group covers the list at once and a player can say which machine owes what. `rotate`
          -- picks a candidate afresh every few ticks, so the group covers the list OVER TIME and no
          -- machine is committed to one recipe -- which is the other thing a shared bus is for, and
          -- the reason the position numbers are not written into the shape at all in that mode.
          -- `g.bus_at` is the position THIS machine was given on the bus. It is passed in rather than
          -- read from `i` because a caller may put two machines on one position -- that is how a mix is
          -- asked for at all: the engine's own sort gives every machine on index j the same recipe, so
          -- "twice as many machines for gear as for cable" is the integer form of "2:1", and the
          -- alternative (weighting a random pick by count) is not something this mod has measured.
          --
          -- Under `shortage` the sort runs the OTHER way (`max = true`), and that is arithmetic rather
          -- than taste: the wire carries `target minus what the shelf holds`, so the biggest number on it
          -- is the thing the factory has least of, and an ascending order would hand machine 0 the most
          -- abundant item on the shelf. Measured in dev/circuit_rules_probe.js act R: one bus of
          -- steel=50, gear=48, cable=41 and positions 0..2 handed out 50, then 48, then 41 -- which is the
          -- line's whole priority order, most short first, with no script anywhere in it. (An earlier act
          -- said descending positions all gave the same signal; that reading looked its parts up by cell,
          -- and a 1x2 combinator's neighbour was the same combinator.)
          circuit = (g.bus_mode == "rotate")
            and { rotate = g.bus_every or 20 }
            or { select = { index = (g.bus_at and g.bus_at[i + 1]) or i,
                            max = g.bus_mode == "shortage" } },
          wire_to = machine_at,
        }
        ctrls[#ctrls + 1] = #out
      end
    end
    if g.bus then
      if g.bus_mode == "shortage" then
        -- One SUBTRACTING box per candidate, standing where the emitter would have stood. This is the
        -- whole of "what is the factory short of" written in the engine's own arithmetic:
        -- `first_constant = target` minus `second_signal = what the shelves hold`, out under the
        -- candidate's recipe. Two measured reasons it has to be this combinator and not a decider
        -- (dev/circuit_rules_probe.js acts N, O, P on 2.0.77): a decider asked to COPY a count emitted
        -- nothing in every arrangement tried -- the signal it matched, the same signal named again, one
        -- colour named -- so the number has to be computed, not copied; and a box with nothing to
        -- subtract reads zero, which is exactly what an item that has run clean out of the shelves needs
        -- in order to still be on the bus. A shelf-count bus cannot say that, and it starves the one
        -- thing the factory has least of.
        --
        -- Two tiles apart, because a combinator occupies at most two tiles in either orientation and
        -- these have to stand in a row without merging into each other's footprint.
        for k, c in ipairs(g.bus_shortage or {}) do
          out[#out + 1] = {
            name = g.arithmetic, cell = { g.ox + fcol + (k - 1) * 2, out_row + 5 }, dir = DIR.north,
            role = "bus",
            circuit = { deficiency = { item = c.item, recipe = c.recipe, target = c.target } },
            -- Every box reads every output chest, and every box feeds every controller: one network on
            -- each side, which is what "the factory's shelf" means when a lane has more than one box to
            -- shelve its output in. A box that watched only its own lane's chest would be a plan that
            -- already knew which machine ends up building what -- the very thing the bus is deciding.
            wire_from = outs,
            wire_to = ctrls,
          }
        end
      else
      -- one emitter for the card, standing under the first lane's controller. Its signals are the
      -- caller's list, and the COUNT on each is its position in that list, so "the i-th machine builds
      -- the i-th item on the list" is a statement about the engine's ascending sort rather than a hope.
      local signals = {}
      for k, r in ipairs(g.bus) do signals[k] = { type = "recipe", name = r, count = k } end
      out[#out + 1] = {
        name = g.emitter, cell = { g.ox + fcol, out_row + 5 }, dir = DIR.north, role = "bus",
        circuit = { emitter = signals },
      }
      -- The emitter is wired to every controller this card laid -- not to the machines, which is the
      -- distinction the whole shape turns on: one signal per wire at the machine (measured: a machine
      -- shown two recipes picks one and which one cannot be predicted), and a bus the controllers each
      -- read a different position of.
      local bus_at = #out
      for _, at in ipairs(ctrls) do
        out[at].wire_from = bus_at
      end
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
--   sp+3R+fh-1   arm: pickup south (the belt below), drop north into the machine's bottom row
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
      -- Pickup is the raw-material belt above, drop the machine's top row: this arm FEEDS the machine.
      -- Facing it the other way picks the machine's own output and drops it back onto the raw belt,
      -- which reads legal to `card_verify` (both cells hold something) and starves the whole row.
      out[#out + 1] = { name = g.arm, cell = { mx + mid, u_in + R }, dir = DIR.north }
      out[#out + 1] = { name = g.machine, cell = { mx, u_mach }, dir = 0 }
      out[#out + 1] = { name = g.arm, cell = { mx + mid, sp - R }, dir = DIR.north }
    end
    for i = 0, lower - 1 do
      local mx = g.ox + i * pitch
      out[#out + 1] = { name = g.machine, cell = { mx, l_mach }, dir = 0 }
      out [#out + 1] = { name = g.arm, cell = { mx + mid, sp + R }, dir = DIR.south }
      -- Mirrored about the spine: pickup the raw-material belt BELOW, drop north into the machine.
      out[#out + 1] = { name = g.arm, cell = { mx + mid, l_mach + fh - 1 + R }, dir = DIR.south }
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
      -- The feed arm picks north off the raw-material belt and drops south into the machine; see the
      -- same line in `sandwich-2` for what happens when it faces the other way.
      out[#out + 1] = { name = g.arm, cell = { mx + mid, in_row + R }, dir = DIR.north }
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
  local got = { belts = 0, arms = 0, machines = 0, chests = 0, poles = 0, pipes = 0, others = 0 }
  for _, s in ipairs(specs or {}) do
    local kind = (kind_of and kind_of(s.name)) or "?"
    if kind == "transport-belt" then got.belts = got.belts + 1
    elseif kind == "inserter" then got.arms = got.arms + 1
    elseif kind == "chest" or kind == "logistic-chest" or kind == "container" then got.chests = got.chests + 1
    elseif kind == "furnace" or kind == "assembling-machine" or kind == "boiler" then got.machines = got.machines + 1
    elseif kind == "electric-pole" then got.poles = got.poles + 1
    -- A fluid feed is the one part of a lane a player has to supply from outside, so its cost belongs on
    -- the bill beside the belts and arms, not buried in `others` where a pipe row reads as nothing.
    elseif kind == "pipe" then got.pipes = got.pipes + 1
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
function S.product_lines(specs, is_belt, is_arm, reach)
  local arms, belts, lines = {}, {}, {}
  local R = math.max(1, math.floor(reach or 1))
  for _, s in ipairs(specs or {}) do
    -- An ARM, specifically -- not merely a part with a direction on it. Every part in a shape carries a
    -- direction (a chest has one, and so does a pipe), so counting whatever stands next to an outlet chest
    -- as the arm that fills it is how a lane came to claim a product line it never laid.
    if is_arm and is_arm(s.name) and s.dir and STEP[s.dir] then arms[(s.cell[1]) .. "," .. (s.cell[2])] = s.dir end
    if is_belt and is_belt(s.name) then
      local horiz = s.dir == D.east or s.dir == D.west
      belts[s.cell[1] .. "," .. s.cell[2]] = { axis = horiz and "row" or "col",
                                               key = horiz and s.cell[2] or s.cell[1] }
    end
  end
  local found, outlet_arms = {}, {}
  for _, s in ipairs(specs or {}) do
    if s.role == "out" then
      for _, d in ipairs({ D.north, D.east, D.south, D.west }) do
        local v = STEP[d]
        -- the arm that drops into this chest stands R further along its own pickup face
        local ax, ay = s.cell[1] + v[1] * R, s.cell[2] + v[2] * R
        if arms[ax .. "," .. ay] == d then
          outlet_arms[ax .. "," .. ay] = true
          local px, py = ax + v[1] * R, ay + v[2] * R
          local line = belts[px .. "," .. py]
          if line then found[line.axis .. ":" .. line.key] = { axis = line.axis, key = line.key } end
        end
      end
    end
  end
  local rows, n, arm_n = {}, 0, 0
  for _, l in pairs(found) do
    n = n + 1
    rows[#rows + 1] = { axis = l.axis, line = l.key }
  end
  -- The arms counted the same way the lines are: an outlet chest is served by the arm whose DROP face
  -- is its cell, counted once per arm rather than once per chest (two chests fed by one arm is one
  -- arm's throughput, and a stack inserter feeding two chests is still one stack per swing). This is
  -- the number that turns a MEASURED arm rate into a ceiling for a shape whose product leaves by arm
  -- -- which is every `row-chest` lane, the one style with no product belt to be the limit instead.
  for _, a in pairs(outlet_arms) do arm_n = arm_n + 1 end
  table.sort(rows, function(a, b)
    if a.axis ~= b.axis then return a.axis < b.axis end
    return a.line < b.line
  end)
  return { lines = n, rows = rows, arms = arm_n }
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

-- How many copies of a `size`-long thing stand in a `box`-long rectangle when `gap` cells of aisle
-- separate neighbours -- `n * size + (n - 1) * gap <= box`, so n = floor((box + gap) / (size + gap)).
--
-- One function because this is the same question asked by three places that must not answer it three ways:
-- the row count `plan_fit` prints, the group count `group_fit` prints, and the `at` each of them hands the
-- packer to lay a lane at. A fit answer computed with a different convention from its own ghosts is the
-- worst shape this file can be wrong in: the number says 2, the ghosts land in 3 rows, the third one's last
-- cell is outside the box the player drew, and both halves of the answer look self-consistent alone.
-- `compact` (gap 0) makes all three formulas coincide, which is how it stayed unnoticed this long.
function S.fit(box, size, gap)
  if not (box and size) or size <= 0 then return 0 end
  local g = math.max(0, gap or 0)
  return math.max(0, math.floor((box + g) / (size + g)))
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
    -- `role`, `circuit`, `wire_to` and `wire_from` travel with the part. A rotation is a rigid motion,
    -- and the order of the list is preserved by the loop above -- so an index a controller points at is
    -- still the same machine after the turn, and a circuit intent does not silently fall off the shape.
    -- Dropping `wire_from` here was survivable only as long as nothing but the emitter used it, and a
    -- shortage bus lays boxes whose whole purpose is to be read FROM the chests. `fluid` is dropped the
    -- same way a port forgets which fluid it was left for, and the answer a player reads is built from
    -- the turned list, not from the one it started from.
    out[#out + 1] = { name = s.name, cell = { x - minx, y }, dir = d, role = s.role, fluid = s.fluid,
      circuit = s.circuit, wire_to = s.wire_to, wire_from = s.wire_from }
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
    out[#out + 1] = { name = s.name, cell = { s.cell[1] - minx, s.cell[2] - miny }, dir = s.dir,
      role = s.role, fluid = s.fluid, circuit = s.circuit, wire_to = s.wire_to, wire_from = s.wire_from }
  end
  return out
end

return S
