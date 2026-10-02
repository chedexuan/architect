// Which side of a machine an arm can feed -- measured, because the new shape needs both sides.
//
// A belt row has two lanes and one material per lane (measured in dev/lane_split_probe.js), so a recipe
// that eats three items -- `advanced-circuit`, plastic 2 + cable 4 + red board 2, read out of the engine
// by dev/recipe_table_e2e.js -- needs a SECOND feed row. The obvious shape puts one row of belts on each
// side of the machines: the north row carries two materials, the south row carries the third and the
// product, each in its own lane.
//
// That only works if an arm standing SOUTH of a machine can drop into it, which is the mirror of what
// every shape in this mod does today (arm north of the machine, picking the belt above it). The mirror is
// not a symmetry the engine owes us: an inserter's hand reaches 1.5 tiles to its pickup side and drops
// half a tile behind itself, both measured from its own centre, so whether the drop point lands inside a
// machine's box depends on where the box edge is -- and a machine's box is not its tile rectangle
// (a 3x3 assembler's collision box is slightly larger than 3x3, so the tile the arm stands on may or may
// not be inside it). This asks the engine twice, on identical ground, and prints both answers.
//
// A/B: same machine, same belt, same arm, mirrored -- A is belt NORTH (the shape `row-belts` lays and the
// bench already proves), B is belt SOUTH. Both are fed from a chest through a push arm, so a machine that
// ends up with plate in its input box has been fed by the arm in question, and one that does not has not.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("arm_side_probe");

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
  for (let n = 1; n <= (tries || 6) && (!out.trim() || /PROBE-FAIL|TRUNCATED|no output/.test(out)); n++) {
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

const X = 8200, Y = 8200;
const A = { x: X, y: Y };            // belt NORTH of the machine (today's shape)
const B = { x: X + 16, y: Y };       // belt SOUTH of the machine (the mirror)
const Cc = { x: X + 32, y: Y };      // one row, both arms in it (the second feed row's outlet)

const build = () => ask(`local s = game.surfaces["arch-lab"]
local x, y = ${X}, ${Y}
s.request_to_generate_chunks({x, y}, 3) s.force_generate_chunk_requests()
local area = { {x - 6, y - 8}, {x + 50, y + 12} }
for _, e in ipairs(s.find_entities_filtered{ area = area }) do e.destroy() end
local tiles = {}
for cx = x - 6, x + 50 do
  for cy = y - 8, y + 12 do tiles[#tiles+1] = { name = "grass-1", position = { cx, cy } } end
end
pcall(function() s.set_tiles(tiles) end)
pcall(function() s.create_global_electric_network() end)
pcall(function() game.forces.player.set_recipe("copper-cable", true) end)
s.create_entity({ name = "electric-energy-interface", position = { x = x + 14, y = y + 11 },
  direction = 0, force = "player", raise_built = true })

-- centre() so a placement asked at a cell uses that cell's middle, like every placement in the mod
local function centre(name, cx, cy)
  local p = prototypes.entity[name]
  return { x = cx + ((p and p.tile_width) or 1) / 2, y = cy + ((p and p.tile_height) or 1) / 2 }
end
local function mk(name, cx, cy, dir)
  local e = s.create_entity({ name = name, position = centre(name, cx, cy), direction = dir or 0,
    force = "player", raise_built = true })
  if not e then error("cannot place " .. name .. " at " .. cx .. "," .. cy) end
  return e
end
local NORTH_S = defines.direction.south
local NORTH_N = defines.direction.north
local EAST = defines.direction.east

-- Two rigs, spelled out rather than mirrored by a flag: which cell each part stands on, and which way
-- each arm faces (a facing IS the pickup side, so getting one of them backwards silently turns a feed arm
-- into an outlet arm and the machine simply never gets fed).
--
-- A -- belt NORTH of the machine, exactly what row-belts lays and the bench already proves:
--   ay-2 chest | ay-1 push arm (faces north: picks the chest, drops south onto the belt)
--   ay   belt  | ay+1 feed arm (faces north: picks the belt, drops south onto the machine's top row)
--   ay+2..ay+4 machine
local NORTH = defines.direction.north
local SOUTH = defines.direction.south
local WEST = defines.direction.west
local EAST = defines.direction.east
local function rig(rx, ay, machine_is_south)
  local mach_cell = machine_is_south and (ay + 2) or (ay - 4)
  local feed_arm_y = machine_is_south and (ay + 1) or (ay - 1)
  local feed_faces = machine_is_south and NORTH or SOUTH
  local push_y = machine_is_south and (ay - 1) or (ay + 1)
  -- the push arm stands between its chest and the belt and faces ITS OWN chest: with the machines to the
  -- south, the source is to the north, so it faces north. Getting this round turns a supply arm into an
  -- arm that empties the belt back into the box it came from, and the machine then starves for a reason
  -- that has nothing to do with which side of it a belt may sit on.
  local push_faces = machine_is_south and NORTH or SOUTH
  local chest_y = machine_is_south and (ay - 2) or (ay + 2)
  local m = mk("assembling-machine-3", rx + 1, mach_cell, 0)
  pcall(function() m.set_recipe("copper-cable") end)
  for i = 0, 6 do mk("transport-belt", rx + i, ay, EAST) end
  local src = mk("steel-chest", rx, chest_y, 0)
  src.insert({ name = "copper-plate", count=24 })
  mk("fast-inserter", rx, push_y, push_faces)
  local can = s.can_place_entity{ name = "fast-inserter",
    position = centre("fast-inserter", rx + 1, feed_arm_y), force = "player" }
  mk("fast-inserter", rx + 1, feed_arm_y, feed_faces)
  return tostring(can)
end
-- B is the same rig turned upside down: belt SOUTH of the machine, feed arm facing south.
local canA = rig(${A.x}, ${A.y} + 4, true)
local canB = rig(${B.x}, ${B.y} + 4, false)

-- C: the arrangement the second feed row actually needs -- ONE belt row, with the machine's intake arm
-- and its outlet arm standing in the same row of cells, one column apart, facing opposite ways. That is
-- the whole reason a three-material recipe can have its third material and its product on the same line:
-- two arms in one row, each dropping onto the lane away from itself, so the two flows never share one.
-- Placement being legal was measured (arm_pair_probe); what matters is whether both of them MOVE.
local function rigC(rx, by)
  local can = {}
  for _, cx in ipairs({ rx + 2, rx + 3 }) do
    can[#can+1] = tostring(s.can_place_entity{ name = "fast-inserter",
      position = centre("fast-inserter", cx, by + 1), force = "player" })
  end
  local m = mk("assembling-machine-3", rx + 1, by + 2, 0)
  pcall(function() m.set_recipe("copper-cable") end)
  for i = -1, 9 do mk("transport-belt", rx + i, by, EAST) end
  local srcC = mk("steel-chest", rx - 1, by - 2, 0)
  srcC.insert({ name = "copper-plate", count=24 })
  mk("fast-inserter", rx - 1, by - 1, NORTH)
  mk("fast-inserter", rx + 2, by + 1, NORTH)
  mk("fast-inserter", rx + 3, by + 1, SOUTH)
  mk("fast-inserter", rx + 10, by, WEST)
  mk("steel-chest", rx + 11, by, 0)
  return table.concat(can, ",")
end
local canC = rigC(${Cc.x}, ${Cc.y})
rcon.print("BUILT can_place A feed-arm cell=" .. canA .. " B feed-arm cell=" .. canB
  .. " C both arm cells=" .. canC)`);

const read = () => ask(`local s = game.surfaces["arch-lab"]
local function boxes(around)
  local out = {}
  for _, e in ipairs(s.find_entities_filtered{ type = "container",
      area = { { around.x - 8, around.y - 8 }, { around.x + 8, around.y + 8 } } }) do
    local parts = {}
    for _, it in ipairs(e.get_inventory(defines.inventory.chest).get_contents()) do
      parts[#parts+1] = it.name .. "=" .. it.count
    end
    out[#out+1] = math.floor(e.position.x) .. "," .. math.floor(e.position.y) .. "[" ..
      table.concat(parts, "+") .. "]"
  end
  table.sort(out)
  return table.concat(out, " ")
end
local function machines(around)
  local out = {}
  for _, e in ipairs(s.find_entities_filtered{ name = "assembling-machine-3",
      area = { { around.x - 8, around.y - 8 }, { around.x + 8, around.y + 8 } } }) do
    local inn, oun = "?", "?"
    pcall(function() inn = e.get_inventory(defines.inventory.assembling_machine_input).get_item_count() end)
    pcall(function() oun = e.get_inventory(defines.inventory.assembling_machine_output).get_item_count() end)
    local r = "?"
    pcall(function() local rr = e.get_recipe(1) r = rr and rr.name or "none" end)
    out[#out+1] = math.floor(e.position.x) .. "," .. math.floor(e.position.y) .. " recipe=" .. r
      .. " in=" .. tostring(inn) .. " out=" .. tostring(oun)
  end
  table.sort(out)
  return table.concat(out, " | ")
end
local rep = {}
rep[#rep+1] = "A " .. machines({ x = ${A.x} + 2, y = ${A.y} + 4 }) .. "  " .. boxes({ x = ${A.x} + 2, y = ${A.y} + 4 })
rep[#rep+1] = "B " .. machines({ x = ${B.x} + 2, y = ${B.y} + 4 }) .. "  " .. boxes({ x = ${B.x} + 2, y = ${B.y} + 4 })
rep[#rep+1] = "C " .. machines({ x = ${Cc.x} + 2, y = ${Cc.y} + 3 }) .. "  " .. boxes({ x = ${Cc.x} + 4, y = ${Cc.y} + 1 })
rcon.print(table.concat(rep, "\\n"))`);

const BUILD = String(build()).replace(/\n/g, " ");
console.log("  " + BUILD.slice(0, 240));
sleep(45000);
const state = String(read());
console.log("  " + state.replace(/\n/g, " | ").slice(0, 460));

const aLine = (state.split(/\r?\n/).find((l) => l.startsWith("A ")) || "");
const bLine = (state.split(/\r?\n/).find((l) => l.startsWith("B ")) || "");
const fed = (line) => {
  const m = line.match(/in=(\d+)/);
  const o = line.match(/out=(\d+)/);
  return { in: Number(m && m[1] || -1), out: Number(o && o[1] || -1) };
};
const aFed = fed(aLine), bFed = fed(bLine);
check("A (belt north, the shape every lane uses today) really feeds the machine",
  aFed.in >= 0 && aFed.out > 0, JSON.stringify([aFed, aLine.slice(0, 160)]));
check("B (belt south, the mirror the second feed row needs) is measured, whichever way it goes",
  bFed.in >= 0, JSON.stringify([bFed, bLine.slice(0, 160)]));
const cLine = (state.split(/\r?\n/).find((l) => l.startsWith("C ")) || "");
const cFed = fed(cLine);
const cCable = /copper-cable=\d+/.test(cLine);
const cTerms = {
  cableInRowEnd: cCable,
  plateStillOnRow: /copper-plate=/.test(cLine),
  sourceEmptied: /\[[\]]/.test(cLine),
  bothArmCellsPlaced: /both arm cells=true,true/.test(BUILD),
};
check("C (one row, intake arm and outlet arm side by side in it) moves items in BOTH directions",
  cTerms.cableInRowEnd && cTerms.sourceEmptied && cTerms.bothArmCellsPlaced,
  JSON.stringify([cTerms, cLine.slice(0, 200)]).slice(0, 400));
console.log("  结论：B 侧 in=" + bFed.in + " out=" + bFed.out
  + (bFed.out > 0 ? " —— 南侧带子能喂，第二条进料带可以画"
    : " —— 南侧喂不进去，第二条进料带要靠地架或让出一列，先别画"));

const swept = ask(`local s = game.surfaces["arch-lab"]
local area = { {${X - 8},${Y - 10}}, {${X + 56},${Y + 14}} }
for _, e in ipairs(s.find_entities_filtered{ type = "container", area = area }) do
  pcall(function() e.get_inventory(defines.inventory.chest).clear() end) end
pcall(function() s.destroy_items({ area = area, inset = 0 }) end)
local gone = 0
for _, e in ipairs(s.find_entities_filtered{ area = area }) do e.destroy(); gone = gone + 1 end
game.speed = 1
rcon.print("swept=" .. gone .. " left=" .. #s.find_entities_filtered{ area = area });`);
check("the rig is gone when the probe finishes", /left=0/.test(String(swept)),
  String(swept).replace(/\n/g, " ").slice(0, 160));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
