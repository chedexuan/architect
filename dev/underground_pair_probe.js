// The wall, measured. Why there is no compact shape for a recipe that eats three or more things.
//
// `two-feed` costs one product chest and one aisle column PER MACHINE (the player's own helmod plan,
// 2026-10-02: 90 assemblers = 94 chests, 451 columns of aisle). That price is arithmetic, not laziness: a
// belt row carries two lanes, one machine face reaches exactly ONE row (the arm needs the row between the
// belt and the machine to stand in), so two faces = four lanes of INPUT and the product is left with no row
// at all. Three ways out were proposed over the last two days -- a tunnel under the crossing row, an arm
// that takes from one lane only, and "just run the belt straight into the machine / the box" -- and all
// three are now measured dead on this build:
//
//   W1  a pair of `underground-belt` placed by NAME + CELL + DIRECTION -- which is exactly what a card, and
//       what a blueprint, carries -- does NOT link. Both ends read `belt_to_ground_type = input` (a linked
//       pair has the far one as `output`), and there is nothing to say otherwise with: the field is READ
//       ONLY, `defines.belt_to_ground_type` is EMPTY on 2.0.77, `linked_belt` no longer exists, and the
//       prototype has no `max_distance` to place against. A shape drawn on tunnels would ship a line whose
//       items go into a hole that never comes up.
//   W2  lane flags DO work live (measured in `lane_split_probe.js`: arms on opposite faces fill opposite
//       lanes, 60/60, nothing crossing) but they are settings on the entity, and the read-back of a
//       script-authored card is name/cell/direction only. A shape needing "take from the left lane only"
//       would arrive UNFILTERED -- the silent wrong-item failure rather than a refusal.
//   W3  a belt whose output tile is a furnace, an assembler, or a chest hands it NOTHING. Measured with the
//       generator in place, because an unpowered arm is the false negative this file exists not to have:
//       the source boxes keep their items, the machine's input inventory stays empty, the receiving chest
//       stays empty. (Belt contents themselves are not readable at all on this build -- `defines.inventory`
//       has no belt entries -- so the far box is the only honest instrument.)
//   W4  which is the fact that makes the lint table in `card.lua` wrong: it lists `container` among the
//       types a belt may empty into, so a card with a belt pointing at a chest PASSES lint while the items
//       never arrive. The gate for that refusal lives in `layout_ledger.js`; this file owns the measurement.
//
// One sentence of conclusion, for whoever draws the next shape: for a recipe eating three or more items,
// one product box and one aisle column per machine is the price of what a blueprint can carry at all -- and
// if a later build lets a script place a working tunnel, W1 goes red here and the compact shape becomes
// possible again.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("underground_pair_probe");

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
    console.log(`  (no reply, asking again in 4 s -- attempt ${n}. A silent reply here is usually a Lua `
      + "COMPILE error in the query: count the parentheses before blaming the server.)");
    sleep(4000);
    out = lua(src);
  }
  return out;
};

const BX = 7300, BY = 7300;   // tunnel rig
const FX = 7420, FY = 7300;   // what-a-belt-may-empty-into rig
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 420)}`);
  ok ? pass++ : fail++;
};
const first = (s) => String(s).split("\n")[0];

// ---------------------------------------------------------------- W1 the tunnel that cannot be authored
console.log("\n-- W1 a script-placed underground pair: does it link, and is anything sayable about it?");
const tunnel = ask(`local s = game.surfaces["arch-lab"]
local bx, by = ${BX}, ${BY}
s.request_to_generate_chunks({bx, by}, 2) s.force_generate_chunk_requests()
for _, e in ipairs(s.find_entities_filtered{area = {{bx - 4, by - 4}, {bx + 18, by + 4}}}) do e.destroy() end
pcall(function() s.create_global_electric_network() end)
local mk = function(name, x, y, dir)
  return s.create_entity({name = name, position = {x = x + 0.5, y = y + 0.5}, direction = dir,
    force = "player", raise_built = true}) end
mk("electric-energy-interface", bx + 6, by + 3, defines.direction.north)
mk("steel-chest", bx, by, 0)
mk("fast-inserter", bx + 1, by, defines.direction.west)
mk("transport-belt", bx + 2, by, defines.direction.east)
local a = mk("underground-belt", bx + 3, by, defines.direction.east)
mk("transport-belt", bx + 4, by, defines.direction.east)
local b = mk("underground-belt", bx + 5, by, defines.direction.east)
mk("transport-belt", bx + 6, by, defines.direction.east)
mk("fast-inserter", bx + 7, by, defines.direction.west)
mk("steel-chest", bx + 8, by, 0)
local src = s.find_entities_filtered{type = "container", area = {{bx - 1, by - 1}, {bx + 1, by + 1}}}[1]
local out = {}
out[#out+1] = "A=" .. tostring(a.belt_to_ground_type)
out[#out+1] = "B=" .. tostring(b.belt_to_ground_type)
out[#out+1] = "put=" .. tostring(src.insert({name = "copper-cable", count = 120}))
-- every way this build might let a script declare which end is which, tried and named, because the whole
-- point is that there is none
local ok1, r1 = pcall(function() a.belt_to_ground_type = 1 return "set" end)
out[#out+1] = "write=" .. (ok1 and r1 or ("ERR:" .. tostring(r1)))
local ok2, r2 = pcall(function() return defines.belt_to_ground_type end)
local n2 = 0
if ok2 and r2 then for _ in pairs(r2) do n2 = n2 + 1 end end
out[#out+1] = "defines=" .. (ok2 and tostring(n2) or "ERR")
local ok3, r3 = pcall(function() return prototypes.entity["underground-belt"].max_distance end)
out[#out+1] = "proto_max_distance=" .. (ok3 and tostring(r3) or "ERR")
local ok4, r4 = pcall(function() return a.linked_belt end)
out[#out+1] = "linked_belt=" .. (ok4 and tostring(r4) or "ERR")
rcon.print(table.concat(out, " | "))`);
console.log("   " + first(tunnel));

sleep(30000);
const arrived = ask(`local s = game.surfaces["arch-lab"]
local bx, by = ${BX}, ${BY}
local function box(x, y)
  local e = s.find_entities_filtered{type = "container", area = {{x - 1, y - 1}, {x + 1, y + 1}}}[1]
  if not e then return "no-box" end
  local p = {}
  for _, it in ipairs(e.get_inventory(defines.inventory.chest).get_contents()) do
    p[#p+1] = it.name .. "=" .. it.count
  end
  table.sort(p)
  return table.concat(p, "+")
end
local a = s.find_entities_filtered{name = "underground-belt", area = {{bx + 2, by - 1}, {bx + 4, by + 1}}}[1]
local b = s.find_entities_filtered{name = "underground-belt", area = {{bx + 4, by - 1}, {bx + 6, by + 1}}}[1]
rcon.print("AFTER A=" .. tostring(a and a.belt_to_ground_type) .. " B="
  .. tostring(b and b.belt_to_ground_type) .. " far_box=[" .. box(bx + 8, by) .. "]")`);
console.log("   " + first(arrived));
check("W1 the pair a script placed does NOT link -- both ends stay `input`, before and after",
  /A=input/.test(String(tunnel)) && /B=input/.test(String(tunnel))
    && /AFTER A=input B=input/.test(String(arrived)),
  first(tunnel) + " || " + first(arrived));
check("W1 ...and nothing arrives at the far box, so a tunnel-shaped line would lose its items",
  /far_box=\[\]|far_box=\[no-box\]/.test(String(arrived)), String(arrived));
check("W1 ...and there is no way to say otherwise: read-only field, empty defines, no linked_belt, no max_distance",
  /write=ERR/.test(String(tunnel)) && /defines=0/.test(String(tunnel))
    && /proto_max_distance=ERR/.test(String(tunnel)) && /linked_belt=ERR/.test(String(tunnel)),
  String(tunnel));

// ---------------------------------------------------------------- W3 what a belt may empty into
console.log("\n-- W3 a belt pointing into a furnace / a chest / an assembler, one rig, powered");
const direct = ask(`local s = game.surfaces["arch-lab"]
local bx, by = ${FX}, ${FY}
s.request_to_generate_chunks({bx, by}, 2) s.force_generate_chunk_requests()
for _, e in ipairs(s.find_entities_filtered{area = {{bx - 4, by - 4}, {bx + 14, by + 8}}}) do e.destroy() end
pcall(function() s.create_global_electric_network() end)
local mk = function(name, x, y, dir)
  return s.create_entity({name = name, position = {x = x + 0.5, y = y + 0.5}, direction = dir,
    force = "player", raise_built = true}) end
mk("electric-energy-interface", bx + 3, by + 6, defines.direction.north)
-- A: two belt cells ending on a furnace's own tile
mk("steel-chest", bx, by, 0)
mk("fast-inserter", bx + 1, by, defines.direction.west)
mk("transport-belt", bx + 2, by, defines.direction.east)
mk("transport-belt", bx + 3, by, defines.direction.east)
local furnace = mk("stone-furnace", bx + 4, by, 0)
-- B: the same run ending on a chest
mk("steel-chest", bx, by + 2, 0)
mk("fast-inserter", bx + 1, by + 2, defines.direction.west)
mk("transport-belt", bx + 2, by + 2, defines.direction.east)
mk("transport-belt", bx + 3, by + 2, defines.direction.east)
mk("steel-chest", bx + 4, by + 2, 0)
-- C: the same run ending on an assembler told what to craft
mk("steel-chest", bx, by + 4, 0)
mk("fast-inserter", bx + 1, by + 4, defines.direction.west)
mk("transport-belt", bx + 2, by + 4, defines.direction.east)
mk("transport-belt", bx + 3, by + 4, defines.direction.east)
local asm = mk("assembling-machine-1", bx + 4, by + 4, 0)
local okset = select(2, pcall(function() return asm.set_recipe("electronic-circuit") end))
local function src(y)
  return s.find_entities_filtered{type = "container", area = {{bx - 1, y - 1}, {bx + 1, y + 1}}}[1]
end
rcon.print("BUILT put=" .. src(by).insert({name = "iron-ore", count = 40})
  .. "/" .. src(by + 2).insert({name = "copper-cable", count = 40})
  .. "/" .. src(by + 4).insert({name = "iron-plate", count = 40})
  .. " fuel=" .. furnace.insert({name = "coal", count = 40})
  .. " set_recipe=" .. tostring(okset))`);
console.log("   " + first(direct));
sleep(35000);
const ate = ask(`local s = game.surfaces["arch-lab"]
local bx, by = ${FX}, ${FY}
local function cell(x, y)
  local e = s.find_entities_filtered{type = "container", area = {{x - 1, y - 1}, {x + 1, y + 1}}}[1]
  if not e then return "no-box" end
  local p = {}
  for _, it in ipairs(e.get_inventory(defines.inventory.chest).get_contents()) do
    p[#p+1] = it.name .. "=" .. it.count
  end
  table.sort(p)
  return table.concat(p, "+")
end
local f = s.find_entities_filtered{type = "furnace", area = {{bx + 3, by - 1}, {bx + 8, by + 2}}}[1]
local a = s.find_entities_filtered{type = "assembling-machine", area = {{bx + 3, by + 3}, {bx + 8, by + 7}}}[1]
local function inv(e, n)
  if not e then return "?" end
  local ok, got = pcall(function() return e.get_inventory(defines.inventory[n]) end)
  if not ok or not got then return "-" end
  local p = {}
  for _, it in ipairs(got.get_contents()) do p[#p+1] = it.name .. "=" .. it.count end
  return table.concat(p, "+")
end
local names = 0
for n, _ in pairs(defines.inventory) do if n:find("belt") then names = names + 1 end end
rcon.print("CHEST_TARGET[" .. cell(bx + 4, by + 2) .. "] FURNACE_SRC[" .. inv(f, "furnace_source")
  .. "] FURNACE_RESULT[" .. inv(f, "furnace_result") .. "] ASM_IN[" .. inv(a, "assembling_machine_input")
  .. "] ASM_OUT[" .. inv(a, "assembling_machine_output") .. "] belt_inventory_names=" .. names)`);
console.log("   " + first(ate));
const ateTxt = String(ate);
check("W3 a belt pointing into a furnace hands it nothing -- no ore in, no plate out",
  /FURNACE_SRC\[\] FURNACE_RESULT\[\]/.test(ateTxt), ateTxt);
check("W3 ...nor does a belt pointing into an assembler",
  /ASM_IN\[\] ASM_OUT\[\]/.test(ateTxt), ateTxt);
check("W3 ...nor a belt pointing straight into a chest, which is what card.lua's RECEIVES used to assume",
  /CHEST_TARGET\[\]|CHEST_TARGET\[no-box\]/.test(ateTxt), ateTxt);
check("W3 and a belt's own contents cannot be read on this build (no belt inventories in defines at all)",
  /belt_inventory_names=0/.test(ateTxt), ateTxt);

// ---------------------------------------------------------------- take both rigs off the map
const cleaned = ask(`local s = game.surfaces["arch-lab"]
local n = 0
for _, a in ipairs({{{${BX - 4}, ${BY - 4}}, {${BX + 18}, ${BY + 4}}},
                    {{${FX - 4}, ${FY - 4}}, {${FX + 14}, ${FY + 8}}}}) do
  for _, e in ipairs(s.find_entities_filtered{area = a}) do
    if e.type ~= "tile" then e.destroy() n = n + 1 end
  end
end
rcon.print("swept=" .. n)`);
const left = ask(`local s = game.surfaces["arch-lab"]
local n = 0
for _, e in ipairs(s.find_entities_filtered{area = {{${BX - 4}, ${BY - 4}}, {${FX + 14}, ${FY + 8}}}}) do
  if e.type ~= "tile" then n = n + 1 end
end
rcon.print("left=" .. n)`);
check("both rigs are taken back off the map", /left=0/.test(String(left)),
  first(cleaned) + " | " + first(left));

console.log(`\n${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
