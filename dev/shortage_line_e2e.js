// The shortage bus, end to end: a lane whose machines take their recipe from what the factory is
// actually short of, measured off the lane's own output chests, with nothing in the mod running after
// the line is built.
//
// This is the other half of `bus_mode`: `split` and `rotate` both put the CALLER's list on the wire, so
// a rotating lane covers its candidates in an order the plan invented. `shortage` asks the factory
// instead -- one arithmetic box per candidate computing `target - what the shelves hold`, merged onto
// one bus, and each machine's controller reading a different position of it, most-short-first.
//
// Every mechanism here was measured first, in dev/circuit_rules_probe.js, and two of those measurements
// are the reason the shape is what it is:
//
//   * A decider cannot carry a shelf's count onto a recipe's name. Asked to copy, it emits nothing --
//     not a wrong number, nothing -- in every arrangement tried (acts N and P: the signal it matched,
//     the same signal named again, one colour named). The copy follows the signal the output NAMES, and
//     an item and a recipe of the same name are different signals. So the number has to be computed, and
//     the only combinator that computes is the arithmetic one.
//   * The ranking has to run DESCENDING, and that is not taste either: `target - shelf` is positive
//     exactly when the factory is short, and a machine ignores a recipe signal whose count is negative
//     (act P read `recipe:copper-cable=-5` on the wire and no recipe on the machine). Positions count
//     from the biggest number down (act R: a bus of 50/48/41 handed out 50, then 48, then 41), so the
//     most deficient candidate is position 0 and a candidate nobody is short of falls off the line by
//     itself -- which is the whole "enough" rule, with no gate to lay and no script to run.
//
// The claim this suite exists to test is not "the parts were placed" but "the machines moved when the
// shelves moved": the same three machines, rewired by nothing, handed a different recipe because someone
// put items in a box.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("shortage_line_e2e");

const call = (method, args) => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
    { encoding: "utf8", env: { ...process.env, RAW: "1" } });
  return JSON.parse(out.trim());
};
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: { ...process.env }, maxBuffer: 1 << 28 }).trim();
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const asArr = (v) => (Array.isArray(v) ? v : []);

const fails = [];
const check = (name, ok, detail) => {
  console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " :: " + String(detail).slice(0, 340)));
  if (!ok) fails.push(name);
};

// Selector combinators sit behind `advanced-combinators` and arithmetic behind `circuit-network` on this
// install; both are asked of the engine rather than remembered, and both are put back on every exit
// below, because a suite that leaves the player's research tree changed is a suite the next reader
// cannot blame.
const TECHS = ["automation", "electronics", "circuit-network", "advanced-combinators", "logistics", "steel-processing"];
// Spelled as a Lua list, not as JSON: `ipairs{["a","b"]}` is a table constructor with an index in it,
// which the engine refuses with `']' expected` -- a console parse error it answers with silence, and a
// suite whose research step never ran then reports "no placeable selector" about a lane it never built.
const LUA_TECHS = TECHS.map((t) => JSON.stringify(t)).join(",");
const wasResearched = lua(`local f=game.forces.player
local out={}
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; out[#out+1]=t.."="..(x and tostring(x.researched) or "absent")
end
rcon.print(table.concat(out," "))`);
console.log("research before:", wasResearched);
const alreadyOn = {};
for (const pair of wasResearched.split(/\s+/)) {
  const [k, v] = pair.split("=");
  if (v === "true") alreadyOn[k] = true;
  check("a technology this line needs exists in the save: " + k, v !== "absent", pair);
}
lua(`local f=game.forces.player
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; if x then x.researched=true end
end
rcon.print("on")`);

// Blocks that build take a mark first and clean back to it after: `place_undo` takes back the ghosts this
// mod recorded, not the line a player built from them, and a leftover lane inside the next block's search
// area is a wrong answer about a lane that is already proven.
const markHands = () => Number(lua("rcon.print(tostring(#(_G.SL or {})))").split("\n")[0].trim() || 0);
// `_G` outlives a run, so a previous (or crashed) suite leaves its handle list behind and every entity
// THIS run builds looks older than the mark. Reset it, then marks mean what they say.
lua("_G.SL = {} rcon.print('fresh')");
const cleanTo = (mark) => lua([
  'local s=game.surfaces["nauvis"]',
  'local keep, gone, by_cell = 0, 0, 0',
  'for i, rec in ipairs(_G.SL or {}) do',
  '  if i > ' + mark + ' then',
  '    local e = rec.ent',
  '    if e and e.valid then pcall(function() e.destroy() end); gone = gone + 1 end',
  '    -- A destroyed belt does not leave a hole in a line: the engine rebuilds the rest of it as NEW',
  '    -- entities, so the handle recorded for it is stale while the part itself is still standing on the',
  '    -- cell it was recorded at. Sweeping by the recorded cell is the half of cleanup that handles miss,',
  '    -- and nine fast belts left behind by this suite are enough to deny the next one a clear site.',
  '    if rec.at then',
  '      local here = s.find_entities_filtered{area={{math.floor(rec.at.x)-1, math.floor(rec.at.y)-1},',
  '        {math.floor(rec.at.x)+1, math.floor(rec.at.y)+1}}}',
  '      for _,x in ipairs(here) do',
  '        if x.force ~= nil and x.force.name == "player" and x.name ~= "character" then',
  '          pcall(function() x.destroy() end); by_cell = by_cell + 1',
  '        end',
  '      end',
  '    end',
  '  else keep = keep + 1 end',
  'end',
  'local out = {}',
  'for i = 1, keep do out[i] = _G.SL[i] end',
  '_G.SL = out',
  'rcon.print("destroyed="..gone.." by cell="..by_cell.." kept="..keep)',
].join("\n"));

let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  try {
    for (let i = 0; i < 6; i++) call("place_undo", { count: 1 });
    // The same sweep the blocks use, from zero: every part this run recorded, by handle and by the cell
    // it was recorded at, because the belts a destroyed belt re-creates were never in the handle list.
    console.log("exit cleanup:", cleanTo(0));
  } catch (e) { console.log("cleanup failed:", String(e).slice(0, 140)); }
  lua(`local f=game.forces.player
local want={${Object.keys(alreadyOn).map((k) => `[${JSON.stringify(k)}]=true`).join(",")}}
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; if x and not want[t] then x.researched=false end
end
rcon.print("restored")`);
  // Only this suite's own cards: `card_forget {all=true}` would take the fixtures other suites and the
  // cycle rely on, and the failure that shows up afterwards is in someone else's refusal.
  try { call("card_forget", { name: "lane-shortage-3" }); } catch (e) { /* never placed */ }
  console.log(fails.length ? "FAILURES: " + fails.join(", ") : "all checks passed");
  process.exit(code || (fails.length ? 1 : 0));
};

const BUS = ["iron-gear-wheel", "copper-cable"];
const TARGET = 50;

// ---- the card: what a shortage lane is made of ----
const ex = call("card_example", {
  machines: 3, recipe: BUS[0], bus: BUS, bus_mode: "shortage", bus_target: TARGET,
});
const card = ex.data || {};
const ents = asArr(card.entities);
check("a shortage lane is built", ex.ok && ents.length > 0, ex.ok ? card.name : `${ex.code} ${ex.msg || ""}`);
if (!ex.ok) { console.log("STOP: no lane to place"); finish(1); }

const withCircuit = (pred) => ents.filter((e) => e.circuit && pred(e.circuit));
const boxes = withCircuit((c) => c.deficiency);
const ctrls = withCircuit((c) => c.select);
const obeying = withCircuit((c) => c.recipe_control);
check("one arithmetic box per candidate, one controller per machine, one wire per machine",
  boxes.length === BUS.length && ctrls.length === 3 && obeying.length === 3,
  `boxes=${boxes.length} ctrls=${ctrls.length} machines=${obeying.length}`);
check("and no emitter: the chests are the source, so a decider would be a second hand on the same wire",
  withCircuit((c) => c.emitter).length === 0,
  JSON.stringify(ents.filter((e) => /decider/.test(e.name)).map((e) => e.name)));

check("each box names the item it weighs and the recipe it writes, and the target to weigh against",
  boxes.every((b, i) => b.circuit.deficiency.item === BUS[i]
    && b.circuit.deficiency.recipe === BUS[i] && b.circuit.deficiency.target === TARGET),
  JSON.stringify(boxes.map((b) => b.circuit.deficiency)));
const order = ctrls.map((c) => [c.circuit.select.index, c.circuit.select.max]);
check("the controllers read positions 0..n and ask for them from the BIGGEST count down",
  JSON.stringify(order) === "[[0,true],[1,true],[2,true]]", JSON.stringify(order));

const wires = asArr(card.wires);
const shelves = ((card.bus || {}).shelves) || 0;
check("the bus is wired as one network on each side: every shelf into every box, every box into every controller",
  wires.length === shelves * boxes.length + boxes.length * ctrls.length + ctrls.length,
  `wires=${wires.length} shelves=${shelves} boxes=${boxes.length} ctrls=${ctrls.length}`);
check("and the answer says how many of the card's own chests are on that wire",
  shelves === 3, JSON.stringify(card.bus));

const bus = card.bus || {};
check("the report calls the mode by name and carries the target it was priced against",
  bus.mode === "shortage" && bus.target === TARGET && bus.sort === "most short first"
    && bus.boxes === BUS.length, JSON.stringify(bus));
check("the hardware line says which combinator does the subtracting",
  bus.hardware && /arithmetic/.test(String(bus.hardware.arithmetic)) && !bus.hardware.emitter,
  JSON.stringify(bus.hardware));
check("each candidate is still priced at what one hand on that position is worth",
  asArr(bus.rates).length === BUS.length && asArr(bus.rates).every((r) => r.per_min > 0),
  JSON.stringify(bus.rates));

// ---- the refusals: the parts of this design that are decisions ----
const noTarget = call("card_example", { machines: 2, recipe: BUS[0], bus: BUS, bus_mode: "shortage" });
check("a shortage bus with no target is refused by name, not defaulted to a number this file invented",
  !noTarget.ok && noTarget.code === "BUS_TARGET_NEEDED", `${noTarget.code} ${noTarget.msg}`);
const badTarget = call("card_example", { machines: 2, recipe: BUS[0], bus: BUS, bus_mode: "shortage",
  bus_target: 0 });
check("and a target of zero is refused too, because every candidate would be exactly enough",
  !badTarget.ok && badTarget.code === "BUS_TARGET_NEEDED", `${badTarget.code} ${badTarget.msg || ""}`);
const wrongMode = call("card_example", { machines: 2, recipe: BUS[0], bus: BUS, bus_mode: "short" });
check("a bus_mode that is not one of the three words is refused with all three named",
  !wrongMode.ok && wrongMode.code === "UNKNOWN_BUS_MODE"
    && JSON.stringify((wrongMode.detail || {}).known).includes("shortage"),
  `${wrongMode.code} ${JSON.stringify((wrongMode.detail || {}).known)}`);
// The arithmetic combinator is behind `circuit-network` here; un-researching it leaves the machine,
// belt, chest and arm placeable, so the refusal can only come from the shortage branch -- and it has to
// name the missing piece rather than say "no parts".
lua(`local f=game.forces.player local t=f.technologies["circuit-network"] if t then t.researched=false end rcon.print("off")`);
const noArith = call("card_example", { machines: 2, recipe: BUS[0], bus: BUS, bus_mode: "shortage", bus_target: TARGET });
lua(`local f=game.forces.player local t=f.technologies["circuit-network"] if t then t.researched=true end rcon.print("back on")`);
check("a force that cannot place the subtracting box is told which piece is missing",
  !noArith.ok && noArith.code === "NO_AVAILABLE_PART" && /arithmetic/.test(noArith.msg || ""),
  `${noArith.code} ${noArith.msg || ""}`);
// A fluid on the bus was already refused before the bus had a mode, and shortage changes that answer:
// a fluid *ingredient* the belt cannot carry is still impossible, so the older refusal has to win.
// `concrete` needs a machine with the `crafting-with-fluid` category, and the lane picked for this plan
// is an assembling machine with a chest on each side. The vetting that refuses it predates the
// shortage bus, and the point of the check is that naming a mode does not skip it: a box that subtracts
// a shelf no machine can fill is a lane that never stops.
const fluid = call("card_example", { machines: 2, recipe: BUS[0], bus: ["concrete"], bus_mode: "shortage",
  bus_target: TARGET });
check("a candidate whose recipe drinks a fluid is refused before any box is laid",
  !fluid.ok && fluid.code === "BUS_NOT_RUNNABLE"
    && JSON.stringify((fluid.detail || {}).problems).includes("LANE_CARRIES_NO_FLUIDS"),
  `${fluid.code} ${JSON.stringify((fluid.detail || {}).problems)}`);

// Whole groups of a shortage lane, fitted to a box. `group_fit` lays the card through the same
// `card_example`, so it has to carry the mode and the target across or it would tile `split` groups
// under a caller who asked the factory what it is short of -- and the vector it prices would be the
// wrong vector for the line that got laid.
const gf = call("group_fit", {
  bus: BUS, machines: 2, surface: "nauvis", bus_mode: "shortage", bus_target: TARGET,
  area: { left_top: { x: 0, y: 60 }, right_bottom: { x: 119, y: 99 } },
});
const gfd = gf.data || {};
const gbus = (gfd.group || {}).bus || {};
check("group_fit tiles shortage groups rather than quietly falling back to split",
  gf.ok && gbus.mode === "shortage" && gbus.target === TARGET && (gbus.boxes || 0) === BUS.length,
  JSON.stringify(gbus).slice(0, 200) || `${gf.code} ${gf.msg || ""}`);
check("and the group's output is still the per-recipe vector times the groups that landed",
  asArr(gfd.output && gfd.output.total).length === BUS.length
    && asArr(gfd.output && gfd.output.total).every((o) => o.per_min > 0),
  JSON.stringify(gfd.output));

// ---- place, build, and ask the shelves ----
const fz = call("card_freeze", { card, allow_unmeasured: true, name: "lane-shortage-3" });
check("the lane freezes with its boxes and its wiring", fz.ok, fz.ok ? fz.data.name : `${fz.code} ${fz.msg || ""}`);
if (!fz.ok) finish(1);

const mark = markHands();
const pl = call("card_place", { name: "lane-shortage-3", surface: "nauvis" });
const pp = pl.data || {};
const surf = pp.surface || "nauvis";
const origin = pp.origin || { x: 0, y: 0 };
const fp = card.footprint || { width: 40, height: 12 };
check("placed as ghosts", pl.ok && pp.ghosts === ents.length,
  pl.ok ? `${pp.ghosts}/${ents.length} at ${origin.x},${origin.y}` : `${pl.code} ${pl.msg || ""}`);
const pw = pp.wires || {};
check("the preview wires are drawn and the answer still says they have to be drawn again",
  pw.drawn > 0 && pw.redraw_pending === true, JSON.stringify(pw).slice(0, 260));
check("and every controller is counted as waiting for the build, not written onto a ghost",
  ((pw.circuit || {}).waiting || 0) === ents.filter((e) => e.circuit).length, JSON.stringify(pw.circuit));

const area = `{{${origin.x - 1},${origin.y - 1}},{${origin.x + fp.width + 1},${origin.y + fp.height + 2}}}`;
// Built the way a player does it, out from under this mod, so what follows is the engine's answer to the
// wiring and not the mod's answer to its own bookkeeping.
const built = lua(`local s=game.surfaces["${surf}"]
_G.SL = _G.SL or {}
local n, errs = 0, {}
for _,g in ipairs(s.find_entities_filtered{area=${area},type="entity-ghost"}) do
  local at, nm = g.position, g.ghost_name
  local ok, err = pcall(function() g.silent_revive{raise_revive=true} end)
  if not ok then errs[#errs+1] = tostring(err):sub(1, 70) else
    -- silent_revive returns nothing usable, so the entity that arrived is looked up by the cell it
    -- landed on -- the fact this project has now been taught three times
    local found = s.find_entities_filtered{area={{math.floor(at.x)-1, math.floor(at.y)-1},
      {math.floor(at.x)+1, math.floor(at.y)+1}}, name=nm}
    if found[1] then n=n+1; _G.SL[#_G.SL+1]={ent=found[1], name=found[1].name, at=found[1].position}
    else errs[#errs+1]="no entity at "..nm end
  end
end
-- a signal line is an electrical thing: an unpowered controller says nothing at all (measured), so the
-- supply goes in beside the lane before anything on the wire is read
local src = s.create_entity{name="electric-energy-interface",
  position={x=${origin.x + 2.5}, y=${origin.y + fp.height + 1.5}}, force="player"}
if src then _G.SL[#_G.SL+1]={ent=src, name=src.name, at=src.position} end
rcon.print("revived="..n.." supply="..tostring(src~=nil).." errs=["..table.concat(errs,"; ").."]")`);
console.log("built:", built);
check("every ghost was built by the engine", new RegExp(`revived=${ents.length}`).test(built), built);
sleep(4000);

// The ledger's second half: the wires redone on real entities, and the intents written now that the
// entities can hold them.
const written = lua(`local s=game.surfaces["${surf}"]
local W=defines.wire_connector_id
local bs=s.find_entities_filtered{area=${area},name="arithmetic-combinator"}
table.sort(bs, function(a,b) return a.position.x < b.position.x end)
local out={}
for _,b in ipairs(bs) do
  local cb=b.get_or_create_control_behavior()
  local p=cb and cb.parameters or {}
  local sec=p.second_signal
  out[#out+1]=string.format("first=%s second=%s op=%s out=%s:%s",
    tostring(p.first_constant), tostring(sec and sec.name), tostring(p.operation),
    tostring((p.output_signal or {}).type), tostring((p.output_signal or {}).name))
end
local ss=s.find_entities_filtered{area=${area},name="selector-combinator"}
table.sort(ss, function(a,b) return a.position.x < b.position.x end)
local dirs={}
for _,x in ipairs(ss) do
  local p=(x.get_or_create_control_behavior() or {}).parameters or {}
  dirs[#dirs+1]=tostring(p.index_constant).."/"..tostring(p.select_max)
end
rcon.print("boxes["..table.concat(out," | ").."] selectors="..table.concat(dirs, ",")
  .." green_on_box="..tostring((bs[1] and bs[1].get_circuit_network(W.combinator_input_green) ~= nil)))`);
console.log("written:", written);
check("the boxes were configured on the built entities with 2.0's own field names",
  (written.match(/first=50/g) || []).length === BUS.length
    && /op=-/.test(written) && /out=recipe:/.test(written), written);
check("and the controllers ask for their positions from the top of the bus down",
  /selectors=0\/true,1\/true,2\/true/.test(written), written);

// ---- the claim: the shelves move the machines ----
// The line's own output chests are the thing being weighed, so the measurement is taken by putting
// items into them and reading what each machine decided -- with the lane's machines unable to run (no
// iron plate in their input chests), the counts put in here are the counts the wire sees.
const seedShelves = lua(`local s=game.surfaces["${surf}"]
local wired={}
for _,c in ipairs(s.find_entities_filtered{area=${area},type="container"}) do
  for _,k in ipairs(c.get_wire_connectors(false)) do
    if k.connection_count > 0 then wired[#wired+1]=c break end
  end
end
local first = wired[1]
if not first then rcon.print("no wired chest") return end
rcon.print("wired chests="..#wired.." put gear="..tostring(first.insert{name="iron-gear-wheel", count=40}))`);
console.log("shelves:", seedShelves);
check("the lane's own chests are on the network the boxes read", /wired chests=[1-9]/.test(seedShelves), seedShelves);
sleep(3000);

// The first line only: the probe runner appends the sentinel's `OK` to every reply, and a check that
// compares a read-out against `nil/none` is really comparing `nil/none\nOK` -- which fails about the
// suite, not about the line.
const readMachines = () => lua(`local s=game.surfaces["${surf}"]
local W=defines.wire_connector_id
local out={}
local ms=s.find_entities_filtered{area=${area},type="assembling-machine"}
table.sort(ms, function(a,b) return a.position.x < b.position.x end)
for _,m in ipairs(ms) do
  local n=m.get_circuit_network(W.circuit_green)
  local sig="none"
  if n then local q=(n.signals or {})[1]
    if q then local g=q[1] or q.signal sig=tostring(g and g.name).."="..tostring(q[2] or q.count) end end
  local r
  pcall(function() r=m.get_recipe() end)
  out[#out+1]=tostring(r and r.name).."/"..sig
end
rcon.print(table.concat(out," | "))`).split("\n")[0];

// 40 gears on the shelf against a target of 50 says "10 more"; an empty shelf for copper-cable says
// "all 50 of them". Most-short-first is position 0, so the machine that was going to make gear now has
// to be told to make cable -- by the shelf, not by this mod.
const firstRead = readMachines();
console.log("machines with 40 gear and no cable:", firstRead);
check("an empty shelf is the biggest number on the bus, and machine 0 builds it",
  /copper-cable\/copper-cable=50/.test(firstRead.split(" | ")[0] || ""), firstRead);
check("and the next-shortest candidate goes to the next machine, with its real deficiency on the wire",
  /iron-gear-wheel\/iron-gear-wheel=10/.test(firstRead), firstRead);
check("a third machine, past the end of a two-candidate bus, holds no recipe and reads no signal",
  (firstRead.split(" | ")[2] || "").trim() === "nil/none", firstRead);

// The retarget. Nothing here is re-wired, re-configured, or touched by this mod: copper cables go into
// a box, which stops being the thing the factory is short of, and the machines change their minds.
//
// The count is chosen so the swap has a margin of five rather than one. A machine that finishes a craft
// puts its product into its own chest, and a swap resting on a single item would be a race with the
// line's own output -- the assertion would then be about timing instead of about the shelf.
const moved = lua(`local s=game.surfaces["${surf}"]
local chest
for _,c in ipairs(s.find_entities_filtered{area=${area},type="container"}) do
  local wired=false
  for _,k in ipairs(c.get_wire_connectors(false)) do if k.connection_count > 0 then wired=true end end
  if wired and not chest then chest = c end
end
if not chest then rcon.print("no wired chest") return end
rcon.print("cable inserted="..tostring(chest.insert{name="copper-cable", count=45})
  .." held="..tostring(chest.get_inventory(1).get_item_count("copper-cable")))`);
console.log("one item moved:", moved);
check("the shelf changed by one write", /cable inserted=45/.test(moved), moved);
sleep(3000);

const secondRead = readMachines();
console.log("machines after the cable arrived:", secondRead);
check("the deficiency that arrives is smaller than the one already on the wire",
  /iron-gear-wheel\/iron-gear-wheel=10/.test(secondRead) && /copper-cable=5/.test(secondRead),
  secondRead);
check("and the machines swapped: gear is now the scarcest thing on the line",
  /iron-gear-wheel/.test((secondRead.split(" | ")[0] || ""))
    && /copper-cable/.test((secondRead.split(" | ")[1] || "")), secondRead);

// And what happens when the factory has enough of everything: both deficiencies go negative, a machine
// ignores a negative recipe signal (act P), and the line stops rather than building the biggest pile.
const filled = lua(`local s=game.surfaces["${surf}"]
local n=0
for _,c in ipairs(s.find_entities_filtered{area=${area},type="container"}) do
  local wired=false
  for _,k in ipairs(c.get_wire_connectors(false)) do if k.connection_count > 0 then wired=true end end
  if wired then c.insert{name="iron-gear-wheel", count=60} c.insert{name="copper-cable", count=60} n=n+1 end
end
rcon.print("filled "..n.." chests above the target")`);
console.log("filled:", filled);
sleep(3000);
const thirdRead = readMachines();
console.log("machines with everything above target:", thirdRead);
check("nothing short, nothing built: a negative deficiency leaves a machine with no recipe",
  !/iron-gear-wheel\/|copper-cable\//.test(thirdRead), thirdRead);

console.log("cleaning:", cleanTo(mark));
// And the ground itself, asked rather than trusted: `revived` counts the ghosts that came back as
// entities, and a handle list that destroys fewer than that has lost something -- a lane left standing
// here is the wrong answer in the next suite's area scan, which is how one of these suites once cost
// the whole sweep an afternoon.
const leftStanding = lua(`local s=game.surfaces["${surf}"]
local n, what = 0, {}
for _,e in ipairs(s.find_entities_filtered{area=${area}}) do
  if e.name:find("combinator") or e.name:find("assembling") or e.name:find("chest")
      or e.name:find("belt") or e.name:find("inserter") then
    n = n + 1
    what[#what+1] = e.name .. "@" .. math.floor(e.position.x) .. "," .. math.floor(e.position.y)
  end
end
rcon.print("left=" .. n .. " " .. table.concat(what, " "))`);
console.log("left:", leftStanding);
check("the ground this suite built is empty again", /left=0/.test(leftStanding), leftStanding);
finish(fails.length ? 1 : 0);
