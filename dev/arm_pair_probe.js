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
// The same four traps as dev/lane_split_probe.js: entity positions are cell CENTRES, an inserter on a
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

-- the machine: put at cell (x+1, y+1) a 3x3 covers rows y+1..y+3, so the inner arm row is y+4, the
-- shared belt row is y+5, the outer arm row is y+6 and its source chest sits at y+7
local mach = mk("assembling-machine-3", x + 1, y + 1, 0)
local function can(cx, cy)
  return tostring(s.can_place_entity{ name = "fast-inserter", position = centre("fast-inserter", cx, cy),
    force = "player" })
end
local can_inner = { can(x, y + 4), can(x + 1, y + 4) }
for i = 0, 9 do mk("transport-belt", x - 1 + i, y + 5, defines.direction.east) end
-- the outer feed arm and its source: stands SOUTH of the shared row, so its drop goes to the far lane
local src = mk("steel-chest", x + 2, y + 7, 0)
mk("fast-inserter", x + 2, y + 6, defines.direction.south)
-- the two arms in ONE row, on adjacent columns, both touching the same machine
local outArm = mk("fast-inserter", x, y + 4, defines.direction.north)
local inArm = mk("fast-inserter", x + 1, y + 4, defines.direction.south)
-- and the outlet at the east end of the shared row
mk("steel-chest", x + 11, y + 5, 0)
mk("fast-inserter", x + 9, y + 5, defines.direction.west)
-- copper plate in, cables out: the machine's recipe is copper-cable (1 plate -> 2 cable), so a product
-- appearing DOWNSTREAM proves both arms moved -- the in-arm brought plate in, the out-arm took cable out
src.insert({ name = "copper-plate", count=40 })
-- 2.0 crafters carry a QUEUE of recipe slots, so the plain field assignment is not the door any more:
-- set_recipe is. Which of the two worked is printed, because a machine with no recipe accepts no
-- ingredients at all, and an arm that cannot empty its hand onto it reads exactly like an arm the engine
-- refused to place.
local via_set, via_field, err_set, err_field = "no", "no", "", ""
pcall(function() mach.set_recipe({ index = 1, recipe = "copper-cable" }) via_set = "yes" end)
  -- (the error text is printed: a machine with no recipe accepts no ingredients, and an arm that cannot
  -- empty its hand onto it looks exactly like an arm the engine refused to stand)
if via_set == "no" then
  local ok1, e1 = pcall(function() mach.set_recipe({ index = 1, recipe = "copper-cable" }) end)
  local ok2, e2 = pcall(function() mach.recipe = prototypes.recipe["copper-cable"] end)
  via_field = ok2 and "yes" or "no"
  err_set, err_field = tostring(e1), tostring(e2)
end
rcon.print("BUILT inner-row placements=" .. table.concat(can_inner, ",")
  .. " recipe via set_recipe=" .. via_set .. " via field=" .. via_field .. " errs=["
  .. err_set .. "|" .. err_field .. "] now="
  .. tostring((function()
       local ok, r = pcall(function() return mach.get_recipe and mach.get_recipe(1) or mach.recipe end)
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
rcon.print("MACHINE in=[" .. items .. "] crafting=" .. tostring(m.crafting_speed ~= nil)
  .. " progress=" .. string.format("%.2f", tonumber(prog) or -1)
  .. " tasks=" .. (function() local n = 0 pcall(function() n = #m.crafting_queue end) return n end)())`);

console.log("== build: one machine, two arms in the same row, one shared belt row under them");
const BUILD = String(build()).replace(/\n/g, " ");
console.log("  " + BUILD.slice(0, 300));

let boxes = {}, waited = 0;
for (let n = 0; n < 24; n++) {
  sleep(5000); waited = (n + 1) * 5;
  boxes = readBoxes();
  const outlet = boxes[`${X + 11}/${Y + 5}`] || "";
  if (outlet.indexOf("copper-cable") >= 0) break;
}
console.log(`  after ${waited}s: ` + JSON.stringify(boxes));
const MACHINE_STATE = String(machineState()).replace(/\n/g, " ");
console.log("  " + MACHINE_STATE.slice(0, 300));

const outlet = boxes[`${X + 11}/${Y + 5}`] || "";
const source = boxes[`${X + 2}/${Y + 7}`] || "";
const srcCount = Number((source.match(/copper-plate=(\d+)/) || [0, 0])[1]);
check("the engine lets two arms stand in one row on adjacent columns against a 3-wide machine",
  /inner-row placements=true,true/.test(BUILD), BUILD.slice(0, 200));
check("...and the pair works at once: plate went IN from the shared row and cable came OUT along it",
  outlet.indexOf("copper-cable") >= 0 && srcCount < 40,
  JSON.stringify([outlet, source, srcCount, waited]).slice(0, 300));
check("...and the machine was actually crafting while both arms were in that row",
  /progress=0\.\d+|progress=[1-9]|tasks=/.test(MACHINE_STATE) && outlet !== "",
  MACHINE_STATE.slice(0, 260));

const swept = ask(`local s = game.surfaces["arch-lab"]
local area = { {${RX},${RY}}, {${RX2},${RY2}} }
for _, e in ipairs(s.find_entities_filtered{ type = "container", area = area }) do
  pcall(function() e.get_inventory(defines.inventory.chest).clear() end) end
pcall(function() s.destroy_items({ area = area, inset = 0 }) end)
local gone = 0
for _, e in ipairs(s.find_entities_filtered{ area = area }) do e.destroy(); gone = gone + 1 end
game.speed = 1
rcon.print("swept=" .. gone .. " left=" .. #s.find_entities_filtered{ area = area });`);
check("the rig is gone when the probe finishes", /left=0/.test(String(swept)),
  String(swept).replace(/\n/g, " ").slice(0, 200));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
