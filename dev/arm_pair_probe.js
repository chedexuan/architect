// The fact the second feed row depends on, measured before any of it is drawn.
// --
// 绿板 (`advanced-circuit`) eats THREE items -- plastic 2, copper cable 4, electronic circuit 2, read out
// of `prototypes.recipe` by dev/recipe_table_e2e.js -- and a belt row has two lanes. So a lane for a plan
// like that needs a SECOND feed row, and the shape that keeps its product off both of them is the one the
// measured lane rule allows: the third material is pushed onto the shared row by an arm standing on the
// row's OUTER face (its drop lands in the lane farthest from it) while the finished boards are lifted onto
// the same row's OTHER lane by an arm standing on the INNER face.
//
// Which puts TWO arms in the same row of cells, side by side, both working on one machine: one taking from
// the belt into the machine's bottom row, one taking out of that same machine onto the belt. Machines are
// three tiles wide, so the columns exist -- but "the columns exist" is arithmetic about a drawing, not a
// fact about the engine. This asks the engine: does it let both arms STAND there, and do both actually
// MOVE things while the machine keeps crafting?
//
// If it answers no, the second feed row costs an aisle (one free column per machine) and the shape says so
// in its costs. Either answer is useful; drawing the shape first and learning it from a starving line is
// the other option, and this project has already been complained about for exactly that.
// --
// The same traps as dev/lane_side_probe.js: entity positions are cell CENTRES, an inserter on a
// global electric network is still unpowered (the grid is a wire, not a generator), warping the clock
// starves RCON on this box, and a `/c` that fails to COMPILE answers with nothing at all -- so read the
// braces of a hanging query before suspecting the game.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("arm_pair_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 200); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ask = (src, tries) => {
  let out = lua(src);
  for (let n = 1; n <= (tries || 5) && (!out.trim() || /PROBE-FAIL|TRUNCATED|no output/.test(out)); n++) {
    console.log(`  (no reply, asking again in 4 s -- attempt ${n})`);
    sleep(4000);
    out = lua(src);
  }
  return out;
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 420)}`);
  ok ? pass++ : fail++;
};

// A corner of the lab no other suite walks. `M` is the machine's north-west cell; the arm row, the shared
// belt row and the outer source sit below it at +3, +4, +5.
const X = 7300, Y = 7300;
const RX = X - 4, RY = Y - 4, RX2 = X + 24, RY2 = Y + 10;

const build = () => ask(`local s = game.surfaces["arch-lab"]
local x, y = ${X}, ${Y}
s.request_to_generate_chunks({x, y}, 2) s.force_generate_chunk_requests()
local area = { {${RX},${RY}}, {${RX2},${RY2}} }
-- The corner this probe stands on generates as out-of-map, and the two halves of the engine answer
-- differently to that: create_entity ignores the ground and builds anyway, can_place_entity reads it
-- and says false. So without this painting the probe measures its own terrain and reports "the engine
-- refused to stand two arms in one row" -- measured, with the tile named in the answer below. The rigs in
-- measure.lua paint their own square for the same reason since the farm rig that used to cover this
-- ground is gone.
local painted = 0
local tiles = {}
for cx = ${RX} - 2, ${RX2} + 2 do
  for cy = ${RY} - 2, ${RY2} + 2 do
    local ok, t = pcall(function() return s.get_tile(cx, cy) end)
    if not ok or not t or t.name == "out-of-map" or t.name == "water-deep" then
      tiles[#tiles + 1] = { name = "grass-1", position = { x = cx, y = cy }, tile_index = 1 }
    end
  end
end
if #tiles > 0 then pcall(function() s.set_tiles(tiles) end) painted = #tiles end
for _, e in ipairs(s.find_entities_filtered{ type = "container", area = area }) do
  pcall(function() e.get_inventory(defines.inventory.chest).clear() end) end
for _, e in ipairs(s.find_entities_filtered{ area = area }) do e.destroy() end
pcall(function() s.create_global_electric_network() end)
-- Positions are CENTRES: an entity that stands on cell (cx, cy) is at (cx + w/2, cy + h/2), exactly the
-- way every placement in this mod computes it. Asked at the integer corner, can_place_entity says
-- false for a cell with nothing on it, and a probe that reads that as "the engine refused" has just
-- measured its own arithmetic.
local function centre(name, cx, cy)
  local p = prototypes.entity[name]
  local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
  return { x = cx + w / 2, y = cy + h / 2 }
end
local function mk(name, cx, cy, dir)
  local e = s.create_entity({ name = name, position = centre(name, cx, cy), direction = dir,
    force = "player", raise_built = true })
  if not e then error("cannot place " .. name .. " at " .. cx .. "," .. cy) end
  return e
end
mk("electric-energy-interface", x + 10, y + 8, defines.direction.north)

-- the machine: put at cell (x+1, y+1) a 3x3 covers rows y+1..y+3 AND columns x+1..x+3, so the inner arm
-- row is y+4, the shared belt row is y+5, the outer arm row is y+6 and its source sits at y+7.
--
-- An inserter's direction is its PICKUP side and it drops on the opposite face (the same convention
-- styles.lua states), so an arm in the inner row facing north lifts out of the machine's bottom row and
-- one facing south lifts off the belt. Both facts are what this probe is for: the first draft stood the
-- product arm one column WEST of the machine -- legal to place, and picking up nothing forever -- and put
-- the outlet chest two cells beyond where its own arm drops.
local mach = mk("assembling-machine-3", x + 1, y + 1, 0)
local function can(cx, cy)
  return tostring(s.can_place_entity{ name = "fast-inserter", position = centre("fast-inserter", cx, cy),
    force = "player" })
end
local can_inner = { can(x + 1, y + 4), can(x + 2, y + 4) }
for i = 0, 9 do mk("transport-belt", x - 1 + i, y + 5, defines.direction.east) end
-- the feed arm and its source: WEST of the machine's input arm, because the shared row flows east -- a
-- drop placed downstream of the arm that is supposed to lift it is carried away from it.
local src = mk("steel-chest", x - 1, y + 7, 0)
mk("fast-inserter", x - 1, y + 6, defines.direction.south)
-- the two arms in ONE row, on adjacent columns, both touching the same machine
local inArm = mk("fast-inserter", x + 1, y + 4, defines.direction.south)
local outArm = mk("fast-inserter", x + 2, y + 4, defines.direction.north)
-- and the outlet at the east end of the shared row: the arm stands one cell past the last belt, so the
-- chest it fills sits on the face it drops on, which is the other side of it.
mk("steel-chest", x + 10, y + 5, 0)
mk("fast-inserter", x + 9, y + 5, defines.direction.west)
-- copper plate in, cables out: the machine's recipe is copper-cable (1 plate -> 2 cable), so a product
-- appearing DOWNSTREAM proves both arms moved -- the in-arm brought plate in, the out-arm took cable out
src.insert({ name = "copper-plate", count=40 })
-- 2.0 crafters carry a QUEUE of recipe slots, and the setter takes the recipe NAME: set_recipe(name).
-- The table form (set_recipe with an index/recipe table) is not that door -- it answers "Invalid RecipeID" --
-- and 2.0 has no entity.recipe field either. Which of the three worked is printed, because a machine
-- with no recipe accepts no ingredients at all, and an arm that cannot empty its hand onto it reads
-- exactly like an arm the engine refused to place.
local via_set, via_field, err_set, err_field = "no", "no", "", ""
local ok1, e1 = pcall(function() mach.set_recipe("copper-cable") end)
if ok1 then via_set = "yes" end
if via_set == "no" then
  local ok2, e2 = pcall(function() mach.set_recipe({ index = 1, recipe = "copper-cable" }) end)
  if ok2 then via_set = "table" end
  local ok3, e3 = pcall(function() mach.recipe = prototypes.recipe["copper-cable"] end)
  via_field = ok3 and "yes" or "no"
  err_set, err_field = tostring(e1 .. " / " .. tostring(e2)), tostring(e3)
end
rcon.print("BUILT inner-row placements=" .. table.concat(can_inner, ",")
  .. " tile_under_arm=" .. tostring((function() local t = s.get_tile(x, y + 4) return t and t.name end)())
  .. " painted=" .. painted
  .. " recipe via set_recipe=" .. via_set .. " via field=" .. via_field .. " errs=["
  .. err_set .. "|" .. err_field .. "] now="
  .. tostring((function()
       local ok, r = pcall(function() return mach.get_recipe and mach.get_recipe() or mach.recipe end)
       return ok and r and (r.name or r) or "?" end)()))`);

const readBoxes = () => {
  const out = ask(`local s = game.surfaces["arch-lab"]
local lines = {}
for _, e in ipairs(s.find_entities_filtered{ type = "container",
    area = { {${RX},${RY}}, {${RX2},${RY2}} } }) do
  local parts = {}
  for _, it in ipairs(e.get_inventory(defines.inventory.chest).get_contents()) do
    parts[#parts+1] = it.name .. "=" .. it.count
  end
  table.sort(parts)
  lines[#lines+1] = math.floor(e.position.x) .. "/" .. math.floor(e.position.y) .. ":" ..
    table.concat(parts, "+")
end
table.sort(lines)
rcon.print("BOXES " .. table.concat(lines, " "))`);
  const map = {};
  const line = String(out).split(/\r?\n/).filter((l) => l.indexOf("BOXES ") >= 0).pop() || "";
  line.replace("BOXES ", "").split(" ").forEach((cell) => {
    const i = cell.indexOf(":");
    if (i > 0) map[cell.slice(0, i)] = cell.slice(i + 1);
  });
  return map;
};

const machineState = () => ask(`local s = game.surfaces["arch-lab"]
local m = s.find_entities_filtered{ name = "assembling-machine-3", area = { {${X} - 1, ${Y} - 1}, {${X} + 4, ${Y} + 4} } }[1]
if not m then return rcon.print("MACHINE gone") end
local inv, ok = nil, false
pcall(function() inv = m.get_inventory(defines.inventory.assembling_machine_input) ok = true end)
local items = "?"
if ok and inv then
  local p = {}
  for _, it in ipairs(inv.get_contents()) do p[#p+1] = it.name .. "=" .. it.count end
  items = table.concat(p, "+")
end
local prog = 0
pcall(function() prog = m.crafting_progress end)
-- The two lanes of the shared row, read apart, and what is in each arm's hand. Which lane an arm drops
-- into is the whole question the second feed row turns on -- the shape can only put a third material on
-- a row that is already carrying one if the two of them do not meet -- and "the belt has stuff on it" is
-- not an answer to that.
local function lanes(cx, cy)
  local b = s.find_entities_filtered{ name = "transport-belt", area = { {cx, cy}, {cx + 1, cy + 1} } }[1]
  if not b then return "?" end
  local out = {}
  local n_lines = 0
  pcall(function() n_lines = b.get_max_transport_line_index() end)
  for i = 1, n_lines do
    local line = b.get_transport_line(i)
    local n = 0
    pcall(function() n = line.get_item_count() end)
    local kind = "?"
    pcall(function() local c = line.get_contents(); for k, v in pairs(c) do kind = k.name .. "=" .. k.count .. "/" .. v end end)
    out[#out+1] = i .. ":" .. n .. ":" .. kind
  end
  return table.concat(out, ",")
end
local function hand(cx, cy)
  local a = s.find_entities_filtered{ name = "fast-inserter", area = { {cx, cy}, {cx + 1, cy + 1} } }[1]
  if not a then return "?" end
  local held = {}
  pcall(function() for _, it in ipairs(a.get_item_list()) do if it then held[#held+1] = it.name .. "=" .. it.count end end end)
  return #held == 0 and "-" or table.concat(held, "+")
end
-- Everything riding the shared row, by name: the row is one line of belts and the only proof that the
-- machine crafted is a product that exists on it or past it.
local function on_row()
  local plate, cable = 0, 0
  local belts = {}
  pcall(function() belts = s.find_entities_filtered{ name = "transport-belt",
      area = { {${X} - 2, ${Y} + 4}, {${X} + 11, ${Y} + 6} } } end)
  for _, b in ipairs(belts) do
    local nb = 0
    pcall(function() nb = b.get_max_transport_line_index() end)
    for i = 1, nb do
      local line = b.get_transport_line(i)
      pcall(function()
        for k, v in pairs(line.get_contents()) do
          if k.name == "copper-plate" then plate = plate + v elseif k.name == "copper-cable" then cable = cable + v end
        end
      end)
    end
  end
  return plate, cable
end
local plate_row, cable_row = on_row()
rcon.print("MACHINE in=[" .. items .. "] crafting=" .. tostring(m.crafting_speed ~= nil)
  .. " progress=" .. string.format("%.2f", tonumber(prog) or -1)
  .. " tasks=" .. (function() local n = 0 pcall(function() n = #m.crafting_queue end) return n end)()
  .. " plate_on_row=" .. plate_row .. " cable_on_row=" .. cable_row
  .. " lanes_at_feed=" .. lanes(${X} - 1, ${Y} + 5)
  .. " lanes_at_in=" .. lanes(${X} + 1, ${Y} + 5)
  .. " hand_in=" .. hand(${X} + 1, ${Y} + 4)
  .. " hand_out=" .. hand(${X} + 2, ${Y} + 4)
  .. " hand_feed=" .. hand(${X} - 1, ${Y} + 6))`);

console.log("== build: one machine, two arms in the same row, one shared belt row under them");
const BUILD = String(build()).replace(/\n/g, " ");
console.log("  " + BUILD.slice(0, 300));

let boxes = {}, waited = 0;
// 这一台架等的是**世界自己在走**，而链上它前面那几把（linked_pair_probe / shared_row_probe）是用
// `game.ticks_to_run` 快进的 —— 那个东西把世界停在暂停里再走若干 tick，走完不复位。于是这里建好了图、
// 等满 120 秒，读数全零（源箱满着 40 块板、带子上什么都没有、机器 crafting=true 而 progress=0），
// 长得跟"这套摆法不成立"一模一样，其实是世界没在走。所以自己把暂停解开，不指望上一套把世界还干净。
ask(`game.tick_paused = false rcon.print("unpaused=" .. tostring(not game.tick_paused))`, 3);
for (let n = 0; n < 24; n++) {
  sleep(5000); waited = (n + 1) * 5;
  boxes = readBoxes();
  const outlet = boxes[`${X + 10}/${Y + 5}`] || "";
  if (outlet.indexOf("copper-cable") >= 0) break;
}
console.log(`  after ${waited}s: ` + JSON.stringify(boxes));
const MACHINE_STATE = String(machineState()).replace(/\n/g, " ");
console.log("  " + MACHINE_STATE.slice(0, 420));

const outlet = boxes[`${X + 10}/${Y + 5}`] || "";
const source = boxes[`${X - 1}/${Y + 7}`] || "";
const srcCount = Number((source.match(/copper-plate=(\d+)/) || [0, 0])[1]);
check("the engine lets two arms stand in one row on adjacent columns against a 3-wide machine",
  /inner-row placements=true,true/.test(BUILD), BUILD.slice(0, 200));
check("...and the pair works at once: plate went IN from the shared row and cable came OUT along it",
  outlet.indexOf("copper-cable") >= 0 && srcCount < 40,
  JSON.stringify([outlet, source, srcCount, waited]).slice(0, 300));
// The third claim has to be one that CAN fail. "progress=" matches a machine that never started, and
// "tasks=0" is what a starving line prints, so the evidence is the product itself: copper-cable exists
// only because THIS machine crafted it. Counted over the row AND the outlet, because by the time anyone
// reads it the cables may have travelled -- a check that only looks at the moving belt fails on a line
// that finished draining it.
const cableRow = Number((MACHINE_STATE.match(/cable_on_row=(\d+)/) || [0, 0])[1]);
const cableOut = Number(((outlet.match(/copper-cable=(\d+)/) || [0, 0])[1]));
check("...and the machine was actually crafting while both arms were in that row",
  /recipe via set_recipe=yes/.test(BUILD) && /now=copper-cable/.test(BUILD)
  && (cableRow + cableOut) >= 2 && /crafting=true/.test(MACHINE_STATE),
  JSON.stringify([cableRow, cableOut, MACHINE_STATE.slice(0, 300)]));

const swept = ask(`local s = game.surfaces["arch-lab"]
local area = { {${RX},${RY}}, {${RX2},${RY2}} }
for _, e in ipairs(s.find_entities_filtered{ type = "container", area = area }) do
  pcall(function() e.get_inventory(defines.inventory.chest).clear() end) end
pcall(function() s.destroy_items({ area = area, inset = 0 }) end)
local gone = 0
for _, e in ipairs(s.find_entities_filtered{ area = area }) do e.destroy(); gone = gone + 1 end
game.speed = 1
game.tick_paused = false
rcon.print("swept=" .. gone .. " left=" .. #s.find_entities_filtered{ area = area });`);
check("the rig is gone when the probe finishes", /left=0/.test(String(swept)),
  String(swept).replace(/\n/g, " ").slice(0, 200));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
