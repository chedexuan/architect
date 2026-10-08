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
-- The same two rules settle a recipe that eats MORE THAN ONE item, which is the case that used to come
-- out under-fed. Measured on this build (`dev/lane_side_probe.js`, 2026-10-02 and again 2026-10-08, one belt row with two
-- fast arms pushing and lane-locked arms reading downstream):
--
--   * two arms on OPPOSITE sides of one row fill DIFFERENT lanes -- 60 plates and 60 cables went in
--     north and south, and each lane-locked reader collected exactly one of them, 60/60, nothing over;
--   * two arms on the SAME side fill ONE lane -- the control phase put both items in one reader's box
--     and left the other box empty. Interleaved, not separated;
--   * an ordinary arm leaves both lane flags on (measured: the defaults are true/true), so the feed arm
--     a machine stands behind takes from EITHER lane -- one of them, per swing, whichever has items. That
--     is what lets a single row feed a recipe that wants both materials: the row carries one item per
--     lane, the arm delivers both to the machine, and no setting on the arm had to be touched to get
--     there. `load_heads` is that arrangement: two chests and two arms, one on each face of the row.
--
-- A row has two lanes, so a shared head carries AT MOST TWO materials. A recipe with three or more --
-- a green circuit board's copper ore, say, or anything a centrifuge makes -- needs more than one row,
-- and saying so is the point of `feed_plan`: the number of feed rows a lane owes is a quotient of the
-- recipe by the belt, and a shape that lays one row for a three-material recipe lays an under-fed line
-- and calls it done.
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

-- The west-end load for a recipe that eats more than one item. One chest per material and one arm per
-- chest, the arms on ALTERNATING FACES of the same row: measured (header) that an arm drops only into
-- the lane away from itself, so a north arm and a south arm fill the two lanes of one line and the two
-- materials never share a lane. The machine's own feed arm takes from either lane without being told
-- to, so one arm per machine still delivers every material the row carries.
--
-- The row therefore starts one reach WEST of the first machine: the drop cell of these arms has to be
-- belt, and the belt's own tail is the only ground that is not already a machine's.
local function load_heads(out, g, x0, y, feeds)
  local R = g.reach
  for i = 1, math.min(2, #feeds) do
    local north = (i % 2) == 1
    out[#out + 1] = {
      name = g.chest, cell = { x0, y + (north and -2 * R or 2 * R) }, dir = 0,
      role = "in", item = feeds[i],
    }
    out[#out + 1] = {
      name = g.arm, cell = { x0, y + (north and -R or R) },
      dir = north and DIR.north or DIR.south,
    }
  end
end

-- The head of a line that starts on a BARE belt, where a chest and an arm used to stand.
--
-- Two parts, and they are the reason this head is not just `load_heads` with the chests deleted: a lane
-- with no head chest has no place for the player to look and ask "which half of this belt is which
-- material", and that question used to be answered by the chest you were standing next to. So the freed
-- cells get a sign -- one box that puts a number on every half-lane, and one display panel that shows it.
--
-- The box is a DECIDER, not a constant combinator, and that is a measured constraint rather than taste:
-- 2.0 removed every scriptable setter off `LuaConstantCombinatorControlBehavior` (`signal_parameters`,
-- `set_signal`, `parameters` all raise; dev/panel_probe this session, and the same conclusion is written
-- at the top of dev/circuit_blueprint_emit.js, which also records that a hand-written `control_behavior`
-- for one can trip an engine assertion at SAVE time). A decider with a condition nothing can satisfy and
-- `copy_count_from_input = false` emits its listed constants -- the shape `apply_circuit`'s `emitter`
-- already writes for a bus, and the same one the bus gates prove lands on a machine.
--
-- The number IS the lane, and it is the engine's own number: a belt line counts its two half-lanes from
-- its own travel direction (`dev/lane_side_probe.js` 向东/向西那两台架量的就是这个), so "farther from the
-- machines" is not what a number means -- only "line 1 or line 2 of this belt". Card-wide, line N carries
-- lanes 2*(N-1)+1 and 2*(N-1)+2. `lanes` carries the triples so the answer can say which line a number
-- belongs to; the wire is drawn by the card, not here.
--
-- 一种料要占几股是流量说的，不是名数说的：`lane_demand` 给的是"这种料几股"，牌上要的是"第几股哪种料"，
-- 所以这里先把清单摊平（一股一件），再由形状把件派到具体的号上。
local function lanes_flat(split)
  local out = {}
  for _, k in ipairs(split or {}) do
    for _ = 1, math.max(1, k.lanes or 1) do out[#out + 1] = k.item end
  end
  return out
end

local function head_sign(out, g, x, y, lanes, side, role_name)
  -- The box is the bus's emitter when this lane has a bus, and the head's own otherwise: one decider per
  -- card is enough, and a lane that has both wears the same part name twice.
  local box = g.emitter or g.sign_emitter
  if not (box and g.panel) or not lanes or #lanes == 0 then return nil end
  -- `side` is which way the sign grows off the row it reads: -1 stands it north of its lines, +1 south.
  -- `role_name` says what it IS: a 单排 head stands north, a 双排's second row stands south of its own
  -- lines and is still a head -- arm filling and bus-splicing are the same job on either face, and the
  -- bench pairs each head with the lines of its own row. Deriving the role from `side` would have named
  -- the lower head a tail, and the tail's list is read as an answer about products.
  local d = (side or -1) < 0 and DIR.north or DIR.south
  local signals = {}
  for i, l in ipairs(lanes) do
    signals[i] = { type = "item", name = l.item, count = l.lane }
  end
  local R = g.reach
  -- A combinator's tile is TWO cells along its facing (measured: `tile_height` 2 for a north-facing
  -- decider), so the box takes the column the chest and its arm used to fill -- base one row north of the
  -- line, second cell reaching the row the arm stood on. The panel is 1x1 and stands beside it, one column
  -- west, rather than further north: this head is already paying for the ground the chest head paid, and a
  -- sign that grew the lane taller than the chests it replaced would be a strange economy.
  local out_y = y + (side or -1) * 2 * R
  out[#out + 1] = {
    name = box, cell = { x, out_y }, dir = d, role = role_name
      or (side and side > 0 and "tail" or "head"),
    circuit = { emitter = signals }, head_lanes = lanes,
  }
  local at = #out
  out[#out + 1] = { name = g.panel, cell = { x - 1, out_y }, dir = DIR.north, wire_from = at }
  return at
end

-- The east-end outlet: one more tile of line, then an arm standing BESIDE the line's last cell and its
-- box a reach further out on that same flank.
--
-- The arm used to sit on the line itself, `reach` east of the last tile, and that is legal only for an arm
-- that reaches two: with an ordinary inserter the arm occupies the very cell the belt is trying to push
-- into, and the card comes back `BELT_INTO_SOLID` -- measured here on both belt-row shapes, at reach 1 in
-- both orientations, which is why `row-belts` and `sandwich-2` have never once been laid on a save whose
-- player has not yet got long-handed arms. Sideways is legal at every reach: the arm grabs the line's last
-- tile from the flank, and the flank one column east of the machines is ground nothing else stands on.
local function take_tail(out, g, x1, y)
  local R = g.reach
  belt_run(out, x1 + 1, y, 1, g.belt)
  out[#out + 1] = { name = g.arm, cell = { x1 + 1, y + R }, dir = DIR.north }
  out[#out + 1] = { name = g.chest, cell = { x1 + 1, y + 2 * R }, dir = 0, role = "out" }
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

-- How many inbound LANES ONE MACHINE can actually reach, which is not the same question as "how many feed
-- lines does this shape lay".
--
-- `S.lines` minus the product lines answers the second: `sandwich-2` lays two feed rows, so four lanes'
-- worth of material crosses the template. But an inserter stands in the one row between its belt and its
-- machine and reaches exactly that belt, so a machine in the upper row of that shape can be fed by the
-- upper line only -- two lanes. Arithmetic that spends the lower row's lanes on the upper row's machines
-- promises a line that starves at its far end, which is the failure every other number in this file exists
-- to avoid; the figure that decides `machines_per_line` has to be what a machine can reach.
--
-- Read off the parts, in the same spirit as everything else here: for each machine, a belt line is
-- reachable when it runs parallel to one of its faces, sits exactly `2 * reach` off that face (the arm
-- needs the row between), and overlaps the machine's own span. The minimum over the machines is what is
-- returned, because a shape whose third row can be fed but whose first cannot has already lost the claim.
-- `tiers` is the measured list of arm reaches this force can place (nil = only the single `reach`).
-- A machine's own arms are one per tier, so a shape that lays F feed lines beside it lets that machine
-- spend 2*F lanes -- counting only the line at `2 * reach` reads the row limit as half of what eats it.
function S.reachable_feed_lanes(specs, is_belt, is_machine, reach, product_rows, mw, mh, tiers)
  local R = math.max(1, math.floor(reach or 1))
  local W, H = math.max(1, mw or 3), math.max(1, mh or 3)
  local lines = S.lines(specs, is_belt)
  local skip = {}
  for _, l in ipairs(product_rows or {}) do skip[l.axis .. ":" .. l.line] = true end
  local machines = {}
  for _, s in ipairs(specs or {}) do
    if is_machine and is_machine(s.name) then
      machines[#machines + 1] = { x = s.cell[1], y = s.cell[2], w = W, h = H }
    end
  end
  if #machines == 0 then return nil end
  local function count_for(m)
    local n = 0
    -- 一只臂只喂"距离 = 它的 reach"那一行（dev/belt_stack_probe.js 量的），而臂自己站在机器外面那一行，
    -- 所以从机器面数过去，第 t 档臂摸到的带子是第 t+1 行。参数化的排法给每台机器配的是 F 只互不相同
    -- reach 的臂（第 d 只摸第 d 行），只按单一 `reach` 数就把 4 股数成 2 股 —— 后果不是报错而是悄悄加倍：
    -- `belt_too_slow` 会在一台机器其实喂得齐的时候说喂不齐，`machines_per_line` 算成实际的一半，压线那头
    -- 发出去的计划就铺了两倍于需要的带子。`tiers` 是量到的臂档；没传（老的调用方）就只看 `reach` 那一档。
    local function reaches(dist)
      for _, t in ipairs(tiers or { R }) do if dist == t + 1 then return true end end
      return false
    end
    for key, span in pairs(lines.by_row) do           -- horizontal lines reach a north or south face
      if not skip["row:" .. key]
        and (reaches(m.y - key) or reaches(key - (m.y + m.h - 1)))
        and span.to >= m.x and span.from <= m.x + m.w - 1 then n = n + 1 end
    end
    for key, span in pairs(lines.by_col) do           -- vertical ones, an east or west face
      if not skip["col:" .. key]
        and (reaches(m.x - key) or reaches(key - (m.x + m.w - 1)))
        and span.to >= m.y and span.from <= m.y + m.h - 1 then n = n + 1 end
    end
    return n
  end
  local least = nil
  for _, m in ipairs(machines) do
    local n = count_for(m)
    if not least or n < least then least = n end
  end
  return least and least * 2 or nil
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

-- ---------------------------------------------------------------- 形状：数出来的那一种
--
-- 前四个形状的带子数量是形状自己的属性：row-belts 铺"一进一出"，two-feed 铺"两条进料带"，sandwich-2 铺
-- "两排共用一条成品带"。玩家要的排法是"三条料 + 成品走带子 + 一只箱子都不留"，那个组合**四个名字里
-- 没有一个** —— 不是挑选器不够聪明，是几何库里没有那一档。
--
-- 这一档不是发明出来的，是量出来的（dev/belt_stack_probe.js，2026-10-06）：一只臂只喂"距离 = 它的 reach"
-- 那一行带子，取和放都发生在那一格上。于是：
--
--   * 一个面能叠几条带 = 这个安装里**互不相同的臂 reach 档数**，且不超过机器深度（放点落在机身外
--     就是放在地上，机器收不到）；
--   * 于是进料面叠 F 条（第 d 条由 reach = d 的那档臂喂），成品面给 P 条，两面各自独立；
--   * 机器之间的通道整列省掉了：产品不再"每机一只臂抬进箱子"，而是抬上它自己那一面的一条带子。
--
-- 摆法（R 是臂带里那只臂的 reach，F/P 是调用方算完流量给的数）：
--
--   y=oy .. oy+F-1           进料带，第 d 条在 oy+(F-d)（离臂带越近，d 越小）
--   y=oy+F                   进料臂带：一台机器每档一只臂，各占机器宽度里的一列
--   y=oy+F+1 .. +fh          机器，横向紧挨着排（pitch = fw + gap，没有通道列）
--   y=oy+F+1+fh              成品臂带：每档一只，朝北抓机器、往南放到第 e 条成品带上
--   y=oy+F+2+fh .. +P        成品带
--
-- 线头是裸带尾（`heads = "belt"`），牌写清"第几条带子的哪一边装哪种料"。这里不放线头箱，也不放带子末端
-- 的收料箱：玩家要的"取消所有箱子"包括那两种，而这条线的两端本来就是接玩家自己总线的口子 —— 铺一只箱子
-- 在那儿，等于替玩家决定他的工厂怎么接。
S.define("stacked", {
  words = "style-stacked",
  -- 这只臂带的臂是**混档**的：第 d 条带要 reach = d 的那一档。`min_reach` 是"至少要能摸到最近那条"，
  -- 真正的要求由调用方按 F/P 逐档查（查不到就按名拒，不会铺一条喂不到的带子）。
  min_reach = 1,
  shared_row = true,
  parametric = true,
  min_units = 1,
  -- 一根成品带能被几股装满，取决于**有几个面往它上面放**：单排只有一排机器，成品臂全站在带子同一面，
  -- 而同面两只臂装的是同一股（dev/lane_side_probe.js 的 rig 4 量的）—— 所以这条线只走一股的运力。
  product_lanes_per_line = 1,
  units = function(g)
    local out, fw, fh, gap = {}, g.fw, g.fh, g.gap
    local stack = g.stack or {}
    local F, P = math.max(1, stack.feed_rows or 1), math.max(0, stack.product_rows or 0)
    local by_reach = g.arms_by_reach or {}
    local missing = {}
    for d = 1, math.max(F, P) do if not by_reach[d] then missing[#missing + 1] = d end end
    if #missing > 0 then return nil, { why = "ARM_TIER_MISSING", needs = missing, F = F, P = P } end
    local first, last = g.ox, g.ox + (g.count - 1) * (fw + gap)
    local arm_row = g.oy + F
    local mach_row = arm_row + 1
    local prod_arm_row = mach_row + fh
    -- 一条带的西头多铺一格当尾巴：那是玩家接总线的口子，也是牌子站的那一列以东的第一格。
    local x0, x1 = first - 1, last + fw - 1
    -- 带子自己带着"我是进料行 / 成品行"的角色标记：`S.product_lines` 从前只认"哪只臂往箱子里放"这条链,
    -- 一条零箱子、成品直接上带的线在它眼里就没有成品行（数出来的 `product_rows_laid=0`，接着
    -- `feed_rows_laid` 又把成品行当成进料行数了）。角色是唯一一个跟着旋转走的字段，所以标记打在 parts 上，
    -- 不在旁边另记一份行号。
    -- 带子自己带着"我是第几根进料行 / 第几根成品行"，而编号是**整张卡一套**：进料行 1..F，成品行
    -- F+1..F+P，股号 = (行号 - 1) * 2 + 那一行的第几股。两块牌（头与尾）报的都是这套号，台架按号插料，
    -- 玩家按号接总线 —— 同一件事在两个地方各记一套号，就是牌说一套、地上做一套。
    -- 角色是唯一一个跟着旋转走的字段，所以标记打在 parts 上，不在旁边另记一份行号。
    for d = 1, F do
      local before = #out
      belt_run(out, x0, g.oy + (F - d), (x1 - x0) + 1, g.belt)
      for i = before + 1, #out do out[i].role = "feed_line"; out[i].line = d end
    end
    for e = 1, P do
      local before = #out
      belt_run(out, x0, prod_arm_row + e, (x1 - x0) + 1, g.belt)
      for i = before + 1, #out do out[i].role = "product_line"; out[i].line = F + e end
    end
    for i = 0, g.count - 1 do
      local mx = g.ox + i * (fw + gap)
      for d = 1, F do
        out[#out + 1] = { name = by_reach[d], cell = { mx + ((d - 1) % fw), arm_row }, dir = DIR.north,
          feed_line = d }
      end
      out[#out + 1] = { name = g.machine, cell = { mx, mach_row }, dir = 0 }
      for e = 1, P do
        out[#out + 1] = { name = by_reach[e], cell = { mx + ((e - 1) % fw), prod_arm_row }, dir = DIR.north,
          product_line = e }
      end
    end
    if g.heads == "belt" then
      -- 头那块牌只写这条线吃什么，尾那块只写它吐什么：玩家站在哪一头，看见的就是那一头的事。
      -- 两块的股道编号是同一套：号是引擎自己的号，一根带子的两半 = 2*(行号-1)+1 和 +2，行号按带子朝向
      -- 数（`dev/lane_side_probe.js` 向东那台架：北边那只臂的料落在 line2，南边那只落在 line1；向西镜像
      -- 时两个号互换 —— 所以"远股/近股"这种说法是假的，只有"带子自己的第几号"是真的）。
      local feed_lanes, product_lanes = {}, {}
      for i, item in ipairs(g.feeds or {}) do
        feed_lanes[#feed_lanes + 1] = { item = item, lane = i }
      end
      -- 成品这一侧和进料这一侧不一样：**只有一半的股道用得着**。取货的一只臂能把同一行两股都取走（rig 3
      -- 量的），所以进料行一股不落、第 j 件就是股号 j；而放货的臂只能站在带子的一面，同面两只臂装的是
      -- **同一股**（rig 4 量的：`line1[iron=0 copper=0] line2[iron=1 copper=2]`）。单排只有一排机器，
      -- 成品臂全站在带子北边 → 每根成品带只有它的 line2 会有料，于是 `lane_demand` 给的成品行数 = 股数，
      -- 第 i 件走第 i 根成品带（全卡行号 F+i）的那一股 = 2*(F+i)。
      -- 从前这里写的是 `2*F+i`，那个数把第 1 件指到第一根带的 line1（南边那一股）—— 牌会把读者指到
      -- 一条永远没有料的股道里去，而这一列的第二半（本该是 2F+2）被第 2 件占着，号与料各说各话。
      for i, item in ipairs(g.products or {}) do
        product_lanes[#product_lanes + 1] = { item = item, lane = 2 * (F + math.min(i, P)) }
      end
      -- 牌要站在所有带子之外：最北那条上面还有 2R 格给组合器本体（组合器一格是两格高，实测）。
      head_sign(out, g, x0, g.oy - 2 * g.reach, feed_lanes, -1)
      -- 尾那块镜像地站在成品行之南，往南长 —— 那一侧是这条线唯一没人占的地面。
      head_sign(out, g, x1, prod_arm_row + P + 2 * g.reach, product_lanes, 1)
    end
    return out, fw + gap
  end,
  about = function(g)
    local stack = (g or {}).stack or {}
    return string.format("%d 台，一排；进料 %s 条带、成品 %s 条带（臂按档数分派，机器之间没有通道，无箱）",
      (g or {}).count or 0, tostring(stack.feed_rows or 1), tostring(stack.product_rows or 0))
  end,
})

-- ---------------------------------------------------------------- 形状：水在背面那一档
--
-- 为什么要有这一档：一条"喝水"的线（混凝土 = 铁矿石 + 石砖 + 水）在 `stacked`/`two-row` 里必然只铺得出一
-- 台机器。水口在机器北面的那一格，而能放管道的位置就是紧挨着它的那一格 —— 恰好是进料臂必须站的那一行；
-- 机器连成一片时每台机器都在那一行里占一格臂位，管道就永远跨不过机器与机器的边界（除了 `dev/lane_side_probe.js`
-- 之外，这一条是 `card_example` 自己按名拒出来的三个 `FEED_*` 样本量的）。
--
-- 出路不是把臂挪走，而是**把两面分工**：水口那一面整行只留给管道，进料与成品全绕到另一面去。另一面里
-- 顺序也不能随手排 —— 成品臂要站在机器与进料带之间，因为它放货那一侧只有 1 格（实测：`pickup` 能伸到
-- 第 2 格的是长机械臂那一档，`drop` 还是 1 格），于是：
--
--   y=oy-1                     只留给水道的那一行（形状自己不占）
--   y=oy .. oy+fh-1            机器，横向紧挨着（无通道、无箱）
--   y=oy+fh                    臂行：成品臂朝北（从机器取、往后放到第 1 条成品带），
--                              进料臂朝南（从外侧的进料带取、往后放进机器）
--   y=oy+fh+1 .. +P            成品带，第 e 条要 reach = e 的那一档
--   y=oy+fh+1+P .. +P+F         进料带，第 k 条要 reach = P+k 的那一档（所以 F+P 条带要吃掉 F+P 档臂）
--
-- 每一台机器在这一行里要 F+P 个列位（臂不许重叠），3 格宽的组装机最多 3 只 —— 超了就按名拒，
-- 而不是把两只臂摞在同一格上。
S.define("fluid-back", {
  words = "style-fluid-back",
  min_reach = 1,
  parametric = true,
  -- 一条带子喂多台机器（不是每台一条），所以调用方给的是"逐股摊平"的那份进料清单，牌才写得出第几股是
  -- 哪种料；少了这一句，头那块牌会一份料都不写，台架也就一条都不插 —— 铺出来的线看着齐,量到 0/分。
  shared_row = true,
  min_units = 1,
  -- 水口那一面空着，所以这一档的"哪一面是水面"是形状的一部分，不是调用方猜的。
  fluid_side = true,
  -- 转过来就不成立了：竖排之后水口跑到带子那一侧，而 `S.fluid_feed` 是按机器**建成之后真正朝向**的那
  turnable = false,
  no_turn_because = "a drinking lane keeps one face clear for its pipe row, and the machine's own water "
    .. "fitting does not follow the ghost's facing (measured: an assembling machine comes back facing "
    .. "north whatever it was told) -- laid standing up, the row would sit where nothing drinks",
  -- 一根成品带还是只有一面有臂 → 一股。
  -- 一根成品带还是只有一面有臂 → 一股。
  product_lanes_per_line = 1,
  -- 这一档要的臂档数 = 进料行 + 成品行（两面共用一行臂，外侧那几条要更长的手臂）。
  tier_rows = function(stack)
    return math.max(1, (stack or {}).feed_rows or 1) + math.max(0, (stack or {}).product_rows or 0)
  end,
  units = function(g)
    local out, fw, fh, gap = {}, g.fw, g.fh, g.gap
    local stack = g.stack or {}
    local F, P = math.max(1, stack.feed_rows or 1), math.max(0, stack.product_rows or 0)
    local by_reach = g.arms_by_reach or {}
    local missing = {}
    for d = 1, F + P do if not by_reach[d] then missing[#missing + 1] = d end end
    if #missing > 0 then return nil, { why = "ARM_TIER_MISSING", needs = missing, F = F, P = P } end
    if F + P > fw then
      return nil, { why = "ARM_COLUMNS_FULL", arms_wanted = F + P, columns = fw, F = F, P = P }
    end
    local first, last = g.ox, g.ox + (g.count - 1) * (fw + gap)
    local mach_row = g.oy
    local arm_row = mach_row + fh
    local x0, x1 = first - 1, last + fw - 1
    -- 行号还是整张卡一套：进料行 1..F、成品行 F+1..F+P，跟几何上谁在里谁在外无关（号是给牌和台架读的，
    -- 不是给形状自己读的）。
    for e = 1, P do
      local before = #out
      belt_run(out, x0, arm_row + e, (x1 - x0) + 1, g.belt)
      for i = before + 1, #out do out[i].role = "product_line"; out[i].line = F + e end
    end
    for k = 1, F do
      local before = #out
      belt_run(out, x0, arm_row + P + k, (x1 - x0) + 1, g.belt)
      for i = before + 1, #out do out[i].role = "feed_line"; out[i].line = k end
    end
    for i = 0, g.count - 1 do
      local mx = g.ox + i * (fw + gap)
      -- 成品臂朝北：取货面是机器（身前一格），放货面是身后第一条成品带。
      for e = 1, P do
        out[#out + 1] = { name = by_reach[e], cell = { mx + ((e - 1) % fw), arm_row }, dir = DIR.north,
          product_line = e }
      end
      -- 进料臂朝南：取货面是它前面那条进料带（第 k 条离臂行 P+k 格，所以要用 reach P+k 那一档），
      -- 放货面是身后的机器。
      for k = 1, F do
        out[#out + 1] = { name = by_reach[P + k], cell = { mx + ((P + k - 1) % fw), arm_row },
          dir = DIR.south, feed_line = k }
      end
      out[#out + 1] = { name = g.machine, cell = { mx, mach_row }, dir = 0 }
    end
    if g.heads == "belt" then
      local feed_lanes, product_lanes = {}, {}
      for i, item in ipairs(g.feeds or {}) do
        feed_lanes[#feed_lanes + 1] = { item = item, lane = i }
      end
      for i, item in ipairs(g.products or {}) do
        product_lanes[#product_lanes + 1] = { item = item, lane = 2 * (F + math.min(i, P)) }
      end
      -- 尾那块站在水口那一面的北边（那一行往北全是空地，水道只占机器以北的第 1 格）；头那块站在最外
      -- 那条进料带以南。谁是头谁是尾不由"在哪一面"决定 —— 头写这条线**吃什么**、尾写它**吐什么**，
      -- 而台架只认头那份清单往带子里插料：装反一次，喝水的线就一条料也喂不进去，量到的 0 会被读成
      -- "这条线不生产"（实测：`head=[concrete#4]`、`tail=[]`、`fed=0`、`state=done`）。
      head_sign(out, g, x1, mach_row - 1 - 2 * g.reach, product_lanes, -1, "tail")
      head_sign(out, g, x0, arm_row + P + F + 2 * g.reach, feed_lanes, 1, "head")
    end
    return out, fw + gap
  end,
  about = function(g)
    local stack = (g or {}).stack or {}
    return string.format("%d 台，一排；水那一面整行空着给管道，进料 %s 条 + 成品 %s 条都在另一面（无箱）",
      (g or {}).count or 0, tostring(stack.feed_rows or 1), tostring(stack.product_rows or 0))
  end,
})

-- Where a part's `position` sits, given the cell the shape put it in -- and which cells that position
-- makes the part occupy. Both halves of one measured fact, on this build:
--
--   * A part whose box is 1x2 or 2x1 (the combinator family, and the only non-square part a shape lays)
--     is anchored at the CENTRE OF ITS FIRST CELL and grows along its facing: facing north/south it
--     occupies (x,y) and (x,y+1), facing east/west (x,y) and (x+1,y), with `position` (x+0.5, y+0.5) in
--     both cases. Measured with `can_place_entity` around a single placed combinator: north blocked
--     (0,-1)(0,0)(0,+1), east blocked (-1,0)(0,0)(+1,0).
--   * A square part keeps the engine's usual convention: `position` is the centre of the whole box.
--
-- Reading a combinator as "1 wide, 2 tall" whatever its facing -- which is what the prototype's own
-- `tile_width`/`tile_height` say -- is how a turned lane put its lower head's panel on the upper head's
-- cell (OVERLAP) and reported a footprint one or two tiles taller than the flat card it came from.
local function long_part(w, h) return (w == 1 and h == 2) or (w == 2 and h == 1) end
local function box_size(w, h, dir)
  if long_part(w, h) and (dir == 4 or dir == 12) then return h, w end
  return w, h
end

function S.centre(cell, w, h, dir)
  if long_part(w, h) then
    return { x = cell[1] + 0.5, y = cell[2] + 0.5 }
  end
  return { x = cell[1] + (tonumber(w) or 1) / 2, y = cell[2] + (tonumber(h) or 1) / 2 }
end

-- The cells a part at `position` claims, and its box size. Returns nil when the position is not on a
-- legal anchor (the caller raises MISALIGNED).
function S.part_box(w, h, dir, px, py)
  local bw, bh = box_size(w, h, dir)
  if long_part(w, h) then
    local cx, cy = math.floor((px or 0) + 1e-6), math.floor((py or 0) + 1e-6)
    if math.abs((px or 0) - cx - 0.5) > 1e-6 or math.abs((py or 0) - cy - 0.5) > 1e-6 then
      return nil
    end
    return cx, cy, bw, bh
  end
  local ox, oy = (px or 0) - (tonumber(w) or 1) / 2, (py or 0) - (tonumber(h) or 1) / 2
  if math.abs(ox - math.floor(ox + 0.5)) > 1e-6 or math.abs(oy - math.floor(oy + 0.5)) > 1e-6 then
    return nil
  end
  return math.floor(ox + 0.5), math.floor(oy + 0.5), bw, bh
end

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
  -- 第一条规则：带子上写着"我是成品行"。这是形状自己声明的（它把成品臂放在机器与这条带子之间，
  -- 不需要箱子当中介），也是零箱子的线唯一的辨认方式。
  for _, s in ipairs(specs or {}) do
    if s.role == "product_line" and is_belt and is_belt(s.name) then
      local line = belts[s.cell[1] .. "," .. s.cell[2]]
      if line then found[line.axis .. ":" .. line.key] = { axis = line.axis, key = line.key } end
    end
    -- 零箱子的线上，"哪几只臂把成品搬上带子"只能问臂自己：形状给它打了 `product_line`。旧那条"臂往出料
    -- 箱里放"的辨认方式在这一类线上没有箱子可认，于是 `arms` 数出 0，`arm_ceiling` 整格从答案里消失 ——
    -- 而那正是产率冲高时唯一还绑得住这条线的那个上限。
    if s.product_line and s.cell then outlet_arms[s.cell[1] .. "," .. s.cell[2]] = true end
  end
  -- 第二条规则（旧的那条）：臂往出料箱里放，箱子旁边的带子行就是这条线的成品行。
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
    -- 非方块件从前一律拒转，理由是"这套算术处理不了"。它其实处理得了：`rot_rect` 把 w×h 的盒子映成
    -- h×w，`quarter` 把朝向转 90°，而一件组合器占的那两格本来就是**沿它朝向**长的 —— 朝向转了，那两格
    -- 跟着转。所以这里不再一律拒，而是照样算，算完由 `card_verify` 问引擎认不认（竖着的裸带线立不立得
    -- 起来是引擎说了算，不是这份文件说了算）。真正处理不了的非方块件（一条管子、一台炼油厂）由同一次
    -- verify 抓回来。
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
    out[#out + 1] = { name = s.name, cell = { x - minx, y }, dir = d, role = s.role, line = s.line,
      feed_line = s.feed_line, product_line = s.product_line,
      item = s.item, fluid = s.fluid, circuit = s.circuit, wire_to = s.wire_to, wire_from = s.wire_from }
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
    -- `line` travels with the part: it is which numbered feed/product row a belt belongs to, and the
    -- bench feeds a chest-free line by that number (see `M.card_lab`'s lane_feeds). `feed_line` /
    -- `product_line` are the same fact on the ARM side -- which row that one arm serves -- and the count
    -- of product arms is a ceiling, so it has to be readable off the parts too rather than re-derived.
    out[#out + 1] = { name = s.name, cell = { s.cell[1] - minx, s.cell[2] - miny }, dir = s.dir,
      role = s.role, line = s.line, feed_line = s.feed_line, product_line = s.product_line,
      item = s.item, fluid = s.fluid, circuit = s.circuit,
      wire_to = s.wire_to, wire_from = s.wire_from }
  end
  return out
end

-- ---------------------------------------------------------------- 双排：两排机器共用中间那条成品带
--
-- 玩家定的两种排法之一（2026-10-07："排法我们就暂定两种吧，单排和双排，双排就是共用出料传送带"）。
--
-- 它省的是什么，要先说清楚，因为这里最容易想错：
--   * 进料**不省** —— 两排跑的是同一个配方，每一排都要吃到全部料，所以两个面上各铺一套进料行；
--   * 成品省一半长度 —— 每一行共用的带子有两条半股，站在带子两面的臂各往自己那一股放（实测：
--     `dev/lane_side_probe.js` 北臂的料在 line2、南臂的在 line1），所以两排的成品走同一行带子；
--   * 于是同样的流量下，整条线的列数减半，成品带的格数减半，进料带的格数不变。
--
-- "每一面各算一遍"这份意见归形状自己写（`demand`）：单排问"一个面装得下几行"，双排问"半台数在这一面
-- 装不装得下"。把这件事写在调用方，就会变成模替形状猜它的行数是几。
S.define("two-row", {
  words = "style-two-row",
  min_reach = 1,
  shared_row = true,
  parametric = true,
  min_units = 2,
  -- 双排两半排的成品臂站在共用那条带的**两面**，各占一股（同一台架量的：北臂一股、南臂另一股），
  -- 所以这根线两股都用得上。这正是"两排共用一条成品带"成立的全部理由。
  product_lanes_per_line = 2,
  demand = function(machines, of)
    local na = math.ceil(machines / 2)
    local nb = machines - na
    local da, db = of(na), of(math.max(1, nb))
    if not da or not db then return nil end
    return {
      -- 每一面都要吃得下全部料，所以进料行数是两边里较大的那一个。
      feed_rows = math.max(da.feed_rows, db.feed_rows),
      -- 共用行里每一行只给一侧一股，所以行数是两边成品股数里较大的那一个。
      product_rows = math.max(da.product_lanes, db.product_lanes),
      feed_lanes = da.feed_lanes + db.feed_lanes,
      product_lanes = da.product_lanes + db.product_lanes,
      per_lane = da.per_lane,
      crafts_min = (da.crafts_min or 0) + (db.crafts_min or 0),
      split = { na, nb },
      -- 一块牌管一面，所以清单也得按侧摊平给形状：从前这里什么都不回，`units` 只能退回"一种料一道"，
      -- 于是 80 台石炉那种"一面的一种料要两股"的线，牌上只写了一股 —— 玩家照牌接总线，接进去的运力是
      -- 需要的一半。按侧回，调用方就只搬不猜。
      feed_flat_a = lanes_flat(da.feed_split), feed_flat_b = lanes_flat(db.feed_split),
      product_flat_a = lanes_flat(da.product_split), product_flat_b = lanes_flat(db.product_split),
      product_split_a = da.product_split, product_split_b = db.product_split,
    }
  end,
  units = function(g)
    local out, fw, fh, gap = {}, g.fw, g.fh, g.gap
    local stack = g.stack or {}
    local F = math.max(1, stack.feed_rows or 1)
    local P = math.max(0, stack.product_rows or 0)
    local by_reach = g.arms_by_reach or {}
    local missing = {}
    for d = 1, math.max(F, P) do if not by_reach[d] then missing[#missing + 1] = d end end
    if #missing > 0 then return nil, { why = "ARM_TIER_MISSING", needs = missing, F = F, P = P } end
    local split = stack.split or { g.count, 0 }
    local na, nb = split[1] or g.count, split[2] or 0
    local pitch = fw + gap
    -- 北半排（A）从上往下：进料行 F 条、进料臂一行、机器 fh 行、成品臂一行。
    local a_arm = g.oy + F
    local a_mach = a_arm + 1
    local a_prod_arm = a_mach + fh
    -- 中间共用的成品行，紧挨着 A 的成品臂南侧。
    local shared = a_prod_arm + 1
    -- 南半排（B）镜像：成品臂在共用行之下、往北放；机器；进料臂；进料行。
    local b_prod_arm = shared + P
    local b_mach = b_prod_arm + 1
    local b_arm = b_mach + fh
    -- 带子往西多铺一格当线头：那是玩家接总线的口子，也是牌站的那一列。
    local cols = math.max(1, math.max(na, nb))
    local x0 = g.ox - 1
    local x1 = g.ox + (cols - 1) * pitch + fw - 1
    local function feed_rows_for(arm_row, dir, run, base)
      for d = 1, F do
        local before = #out
        belt_run(out, x0, arm_row + dir * d, run, g.belt)
        -- 全卡一套行号：北半排的进料行是 1..F，南半排续 F+1..2F。两半都从 1 数起的话，牌上第 3 股到底
        -- 是哪一根带子就没有答案了 —— 台架按号插料，只会插进它碰到的那一根（实测：双排的 4 根进料行被
        -- 当成 2 根，南半排永远等不到料，量出来的产率正好是牌上写的一半）。
        for i = before + 1, #out do out[i].role = "feed_line"; out[i].line = base + d end
      end
    end
    feed_rows_for(a_arm, -1, (na - 1) * pitch + fw, 0)
    if nb > 0 then feed_rows_for(b_arm, 1, (nb - 1) * pitch + fw, F) end
    for e = 1, P do
      local before = #out
      belt_run(out, x0, shared + e - 1, (x1 - x0) + 1, g.belt)
      for i = before + 1, #out do out[i].role = "product_line"; out[i].line = 2 * F + e end
    end
    -- 一排机器：机器本体、每档进料带一只臂（取货面朝着自己那一面的带子）、每档成品带一只臂。
    local function row(mach_row, arm_row, arm_dir, prod_row, prod_dir, count, side)
      for i = 0, count - 1 do
        local mx = g.ox + i * pitch
        out[#out + 1] = { name = g.machine, cell = { mx, mach_row }, dir = 0, side = side }
        for d = 1, F do
          out[#out + 1] = { name = by_reach[d], cell = { mx + ((d - 1) % fw), arm_row },
            dir = arm_dir, feed_line = d, side = side }
        end
        for e = 1, P do
          out[#out + 1] = { name = by_reach[e], cell = { mx + ((e - 1) % fw), prod_row },
            dir = prod_dir, product_line = e, side = side }
        end
      end
    end
    row(a_mach, a_arm, DIR.north, a_prod_arm, DIR.north, na, "north")
    if nb > 0 then
      row(b_mach, b_arm, DIR.south, b_prod_arm, DIR.south, nb, "south")
    end
    if g.heads == "belt" then
      -- 每一排机器各有一块自己的头牌：它写的是"我这一排的带子上该走什么"，而两排的带子是两根不同的
      -- 线，号也各是一套。一块牌管两面是假的 —— 站在北半排那一头读数的人，看不见南半排那根带子。
      -- 每面的清单按侧摊平（一面的一种料要两股就写两道），写不下的那一半是形状给不了的地面，宁可不写
      -- 也不能把号派到别的线上去了：A 的线是 1..F（股 1..2F），B 的续 F+1..2F（股 2F+1..4F）。
      local feeds = g.feeds or {}
      local fa, fb = stack.feed_flat_a or feeds, stack.feed_flat_b or feeds
      local feed_lanes_a, feed_lanes_b = {}, {}
      for i = 1, math.min(#fa, 2 * F) do
        feed_lanes_a[#feed_lanes_a + 1] = { item = fa[i], lane = i }
      end
      head_sign(out, g, x0, a_arm - F - 2 * g.reach, feed_lanes_a, -1)
      if nb > 0 then
        for i = 1, math.min(#fb, 2 * F) do
          feed_lanes_b[#feed_lanes_b + 1] = { item = fb[i], lane = 2 * F + i }
        end
        head_sign(out, g, x0, b_arm + F + 2 * g.reach, feed_lanes_b, 1, "head")
      end
      -- 尾那块写成品，站在共用行以南、B 那排的地面之外（B 不在时也站在带子的另一侧，不会压到带子）。
      -- 号是"这块牌要玩家接总线接哪一格"，所以它按臂的实际位置派：共用行的全卡行号从 2F+1 起，A 的成品
      -- 臂行紧挨共用行北边，`reach e` 那只摸到第 e 根、装的是北边那一半 = line2；B 的臂行在共用行以南，
      -- 从最南那根往回数，`reach e` 那只摸到第 P-e+1 根、装的是 line1。同面两只臂装的是同一股
      -- （dev/lane_side_probe.js 的 rig 4），所以"一根线两股"这一句只有在这里成立：两半各有自己的面。
      local pa, pb = stack.product_flat_a or {}, stack.product_flat_b or {}
      local product_lanes = {}
      for e = 1, P do
        if pa[e] then
          product_lanes[#product_lanes + 1] = { item = pa[e], lane = 2 * (2 * F + e) }
        end
        if pb[e] then
          product_lanes[#product_lanes + 1] = { item = pb[e], lane = 2 * (2 * F + P - e + 1) - 1 }
        end
      end
      head_sign(out, g, x1, b_arm + F + 1 + 2 * g.reach, product_lanes, 1)
    end
    return out, pitch
  end,
  about = function(g)
    local stack = (g or {}).stack or {}
    local split = stack.split or { (g or {}).count or 0, 0 }
    return string.format("%d 台，两排共用中间那条成品带（上 %d / 下 %d）；每面进料 %s 条、共用成品 %s 条，无箱",
      (g or {}).count or 0, split[1] or 0, split[2] or 0,
      tostring(stack.feed_rows or 1), tostring(stack.product_rows or 0))
  end,
})

return S
