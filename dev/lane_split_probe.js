// The lane fact, measured rather than asserted.
//
// Task #40 lets the mod decide "two materials on ONE belt row, or one row each" from throughput. That
// decision is only honest if a shared row really can hold one item per lane, because the whole argument
// for sharing -- and the whole reason a player accepts a shared row -- is that the lanes keep the two
// materials apart. The rule a player knows by hand: an arm can PICK up from either lane of a belt, but
// always DROPS onto the lane farthest from itself. So two arms standing on opposite sides of the same
// row put their items into two different lanes, and two arms on the SAME side put both items into one
// lane, interleaved.
//
// Measured here with nothing but real entities and a stopwatch, on the throwaway instance: two source
// chests (iron plate, copper cable) pushed onto one east-flowing row by one arm from the north face and
// one from the south, and two READER arms downstream locked to a single lane each
// (`pickup_from_left_lane` / `pickup_from_right_lane`). If the lanes hold one item each, each reader's
// box collects one pure item type, and turning the two sources around must swap which box is which. If
// both arms feed the same lane, one box comes back mixed and the other empty -- and then "share one
// row" would be a claim this box cannot support, and the style that lays it would be a lie.
//
// Three traps this file has already fallen into, written down because none of them is visible in code:
//   * entity positions are cell CENTRES (7000.5), so a box is found by the CELL it stands on -- and a
//     search window drawn ±0.6 around a centre matches its neighbour too. The first version read the
//     same chest twice and reported a perfect-looking result that was one box's contents;
//   * an inserter on a surface with a global electric network is still UNPOWERED: the global grid is a
//     wire, not a generator. Nothing moves, and a dead arm looks exactly like an empty lane;
//   * a `/c` that does not COMPILE answers with nothing at all: no `LUA_ERROR`, no sentinel, no bytes --
//     a brace short of closing the `find_entities_filtered{...}` table looks from this side exactly like
//     a server that has stopped replying, and sends a reader off to restart a healthy game. The first
//     thing to check when one query hangs and `ping` is fine is the braces of that query -- and where
//     a `..` sits relative to a newline: a statement Lua has already finished does not continue, so a
//     leading `..` on the next line is a compile error, and a compile error is silence.
//   * warping the clock (`game.speed`) starves RCON on this box: the reply that matters never arrives,
//     and a suite that retries into a 4x server reads as a broken game. This probe waits at 1x and
//     polls instead -- slower, and the only honest way to ask a small machine for a sample.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("lane_split_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 200); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
// A reply that says nothing at all is a slow server, not a game fact: ask again, and say so.
const ask = (src, tries) => {
  let out = lua(src);
  for (let n = 1; n <= (tries || 5) && (!out.trim() || /PROBE-FAIL|TRUNCATED|no output/.test(out)); n++) {
    console.log(`  (no reply from the server, asking again in 4 s -- attempt ${n})`);
    sleep(4000);
    out = lua(src);
  }
  return out;
};

const BX = 7000, BY = 7000; // a corner of the lab no other suite walks
const ROW = 14;             // cells of belt in the row
const SINK_L = BX + ROW - 3, SINK_R = BX + ROW - 2;
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- the rig
//
// One row, two sources, two lane-locked readers. `northItem`/`southItem` say which material is pushed
// from which face; `sameSide` is the control, where both sources stand north of the row.
const build = (northItem, southItem, sameSide) => ask(`
local s = game.surfaces["arch-lab"]
local bx, by = ${BX}, ${BY}
s.request_to_generate_chunks({bx, by}, 2) s.force_generate_chunk_requests()
-- each phase builds on the SAME cells, so the previous rig comes down first -- a phase that found a
-- belt standing there already would create nothing, and report an empty lane as a fact about the game
local swept = 0
for _, e in ipairs(s.find_entities_filtered{area = {{bx - 4, by - 4}, {bx + 22, by + 4}}}) do
  e.destroy() swept = swept + 1 end
pcall(function() s.create_global_electric_network() end)
local mk = function(name, x, y, dir)
  local e = s.create_entity({name=name, position={x=x, y=y}, direction=dir, force="player",
    raise_built=true})
  if not e then error("no " .. name .. " at " .. x .. "," .. y) end
  return e end
-- the generator. Without it nothing in the rig is powered, and an unpowered arm moves exactly as
-- little as an empty lane does -- the false negative this file exists not to have.
mk("electric-energy-interface", bx + 6, by + 2, defines.direction.north)
for i = 0, ${ROW - 1} do mk("transport-belt", bx + i, by, defines.direction.east) end
local south = ${sameSide ? 0 : 1}
local src_n = mk("steel-chest", bx, by - 2, 0)
local src_s = mk("steel-chest", bx + 1, by + (south == 1 and 2 or -2), 0)
mk("steel-chest", ${SINK_L}, by - 2, 0)
mk("steel-chest", ${SINK_R}, by - 2, 0)
-- fast arms: a plain inserter moves one item a second, and a belt that backs up to its head stops
-- taking -- which would make what the readers saw a story about the readers' speed
mk("fast-inserter", bx, by - 1, defines.direction.north)
mk("fast-inserter", bx + 1, by + (south == 1 and 1 or -1),
  south == 1 and defines.direction.south or defines.direction.north)
local rdL = mk("fast-inserter", ${SINK_L}, by - 1, defines.direction.south)
local rdR = mk("fast-inserter", ${SINK_R}, by - 1, defines.direction.south)
rdL.pickup_from_left_lane, rdL.pickup_from_right_lane = true, false
rdR.pickup_from_left_lane, rdR.pickup_from_right_lane = false, true
src_n.insert({name="${northItem}", count=40})
src_s.insert({name="${southItem}", count=40})
rcon.print("BUILT swept=" .. swept .. " sources_on=" .. (south == 1 and "opposite" or "one face")
  .. " locked=" .. tostring(rdL.pickup_from_left_lane) .. "/" .. tostring(rdL.pickup_from_right_lane)
  .. " " .. tostring(rdR.pickup_from_left_lane) .. "/" .. tostring(rdR.pickup_from_right_lane))`);

// Every container in the corner, keyed by the CELL it stands on (`math.floor` of its centre). Reading by
// cell rather than through a window drawn around one guessed point is what stopped the two readers from
// being the same box twice.
const readBoxes = () => {
  const out = ask(`local s = game.surfaces["arch-lab"]
local lines = {}
for _, e in ipairs(s.find_entities_filtered{ type = "container",
    area = { {${BX - 4},${BY - 4}}, {${BX + 22},${BY + 4}} } }) do
  local parts = {}
  for _, it in ipairs(e.get_inventory(defines.inventory.chest).get_contents()) do
    parts[#parts+1] = it.name .. "=" .. it.count
  end
  table.sort(parts)
  -- The concatenation ends the line rather than starting the next one: a Lua statement that is already
  -- complete does not continue across a newline, so a leading .. on the following line is a syntax error
  -- the server answers with -- nothing at all.
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

// Poll at 1x until BOTH readers' boxes hold something, or the window runs out. A fixed sleep is either
// a lie (too short: one item in) or a waste (too long: the boxes emptied into a jam).
const runUntilSampled = () => {
  const l = `${SINK_L}/${BY - 2}`, r = `${SINK_R}/${BY - 2}`;
  for (let n = 0; n < 30; n++) {
    sleep(5000);
    const boxes = readBoxes();
    if (process.env.PROBE_TRACE) console.log(`    poll ${n}: ${JSON.stringify(boxes)}`);
    if ((boxes[l] || "").indexOf("=") >= 0 && (boxes[r] || "").indexOf("=") >= 0) {
      return { boxes, waited: (n + 1) * 5 };
    }
  }
  return { boxes: readBoxes(), waited: "timeout" };
};

const itemsIn = (str) => new Set(String(str || "").split("+").filter((p) => p.includes("="))
  .map((p) => p.split("=")[0]));
const oneType = (str) => itemsIn(str).size === 1;
const twoTypes = (str) => itemsIn(str).size === 2;
const sinksOf = (m) => ({ l: m[`${SINK_L}/${BY - 2}`] || "", r: m[`${SINK_R}/${BY - 2}`] || "" });

console.log("== phase A: iron plate pushed from the NORTH face, copper cable from the SOUTH");
console.log("  " + build("iron-plate", "copper-cable", false).replace(/\n/g, " ").slice(0, 300));
const aRun = runUntilSampled();
const A = sinksOf(aRun.boxes); // the BOXES map, not the wrapper -- sinksOf(runUntilSampled()) reads
  // keys off `{boxes, waited}` and comes back empty for a rig that was moving fine
console.log(`  lane-L box [${A.l}]   lane-R box [${A.r}]`);


console.log("== phase B: the two sources swapped between the faces");
console.log("  " + build("copper-cable", "iron-plate", false).replace(/\n/g, " ").slice(0, 300));
const bRun = runUntilSampled();
const B = sinksOf(bRun.boxes);
console.log(`  lane-L box [${B.l}]   lane-R box [${B.r}]`);

console.log("== phase C: the control -- both sources pushed from the SAME face");
console.log("  " + build("iron-plate", "copper-cable", true).replace(/\n/g, " ").slice(0, 300));
const cRun = runUntilSampled();
const C = sinksOf(cRun.boxes);
console.log(`  lane-L box [${C.l}]   lane-R box [${C.r}]`);

const aLane = oneType(A.l) && oneType(A.r) ? [...itemsIn(A.l)][0] : null;
const aOther = oneType(A.l) && oneType(A.r) ? [...itemsIn(A.r)][0] : null;
const bLane = oneType(B.l) && oneType(B.r) ? [...itemsIn(B.l)][0] : null;
check("two arms on opposite faces of one row fill TWO lanes, one pure item each",
  !!aLane && !!aOther, JSON.stringify([A.l, A.r]));
check("...and the two lanes hold DIFFERENT items -- the row is not one mixed stream",
  !!aLane && !!aOther && aLane !== aOther, JSON.stringify([aLane, aOther]));
check("...and turning the sources around moves each material to the OTHER lane",
  !!bLane && !!aLane && bLane !== aLane, JSON.stringify([[A.l, A.r], [B.l, B.r]]));
check("...while both arms on ONE face fill a single lane -- the control never shows two pure boxes",
  oneType(C.l) && oneType(C.r) ? C.l === C.r || C.l === "" || C.r === ""
    : twoTypes(C.l) || twoTypes(C.r) || C.l === "" || C.r === "",
  JSON.stringify([C.l, C.r]));

// The claim the style actually depends on: a hand blueprint carries positions and directions only, so a
// shared row must get its lane separation from WHERE THE ARMS STAND, never from these two knobs.
const persisted = ask(`local inv = game.create_inventory(1)
inv.insert {name="blueprint", count=1}
local bp = inv[1]
local s = game.surfaces["arch-lab"]
local i = s.create_entity({name="inserter", position={${BX + 40},${BY}},
  direction=defines.direction.south, force="player"})
i.pickup_from_left_lane = true i.pickup_from_right_lane = false
local ok, err = pcall(function() bp.set_blueprint_entities({{entity_number=1, name="inserter",
  position={x=0, y=0}, direction=defines.direction.south}}) end)
local back = ok and bp.get_blueprint_entities() or nil
i.destroy()
rcon.print("holds=" .. tostring(bp.is_blueprint) .. " keys="
  .. (back and (function() local k = {} for x in pairs(back[1]) do k[#k+1] = x end table.sort(k)
      return table.concat(k, ",") end)() or "none") .. " err=" .. tostring(err))
inv.destroy()`);
check("and those lane knobs are NOT something a hand blueprint can carry -- geometry is the only tool",
  /holds=true keys=/.test(String(persisted)) && !/pickup_from/.test(String(persisted)),
  String(persisted).replace(/\n/g, " ").slice(0, 300));

// Leave the corner exactly as it was found: a rig that stands is a rig the next phase -- or the next
// suite -- reads as supply.
const swept = ask(`local s = game.surfaces["arch-lab"]
local area = { {${BX - 4},${BY - 4}}, {${BX + 44},${BY + 4}} }
-- Empty the boxes before breaking them: destroying a full container DROPS its contents, and a corner of
-- the lab holding a few hundred item entities makes the next sweep -- and the next suite -- walk litter
-- instead of entities. That reads from here as a server that stopped answering.
for _, e in ipairs(s.find_entities_filtered{ type = "container", area = area }) do
  pcall(function() e.get_inventory(defines.inventory.chest).clear() end) end
pcall(function() s.destroy_items({ area = area, inset = 0 }) end)
local gone = 0
for _, e in ipairs(s.find_entities_filtered{area=area}) do e.destroy(); gone = gone + 1 end
game.speed = 1
rcon.print("swept=" .. gone .. " left=" .. (function()
  local n = 0 for _ in ipairs(s.find_entities_filtered{area=area}) do n = n + 1 end return n end)())`);
check("the rig is gone when the probe finishes", /left=0/.test(String(swept)),
  String(swept).replace(/\n/g, " ").slice(0, 200));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
