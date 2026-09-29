// The rotating line, end to end: a plan names a SET of recipes, one lane of machines covers them, and
// each machine ends up building a different one of them because the bus says so.
//
// Everything this needs was measured before it was written, and the measurements are what make the
// shape non-obvious:
//
//   * A machine shown TWO recipe signals on one wire picks one, and which one cannot be predicted from
//     the list order or the counts (probe acts A/F/H). So the bus does not run to the machines. It runs
//     to a selector per machine, and each selector hands out exactly one signal.
//   * A selector's `select` operation sorts its input by count and emits the ZERO-BASED position asked
//     for (`select_max=false` ascending), and a position past the end of the bus emits NOTHING (act M).
//     So "machine i builds the i-th item on the caller's list" is arranged by giving each candidate a
//     distinct count equal to its place in that list -- the order is then the engine's own sort and not
//     a hope of ours -- and by saying out loud, in `bus`, which machines have nothing to ask for.
//   * A constant combinator cannot be made to speak from script, so the emitter is a decider wired as
//     "each < 1 → output these" with `copy_count_from_input = false` (act of `circuit_emit_probe`: the
//     default copies the input's count, the input is empty, and a zero is not carried at all).
//   * A ghost holds neither a wire nor a control behaviour (acts K and L), so the lane is placed with
//     its circuit drawn for the preview and everything is written again when the entities arrive --
//     which is what this suite is really watching: it builds the ghosts out from under the mod, the way
//     a player does, and then asks the world what each machine decided to build.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("bus_line_e2e");

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
  console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " :: " + String(detail).slice(0, 320)));
  if (!ok) fails.push(name);
};

// `selector-combinator` is behind `advanced-combinators` on this install and `decider-combinator`
// behind `circuit-network` -- both asked of the engine rather than remembered, because the lane's own
// refusal says "nothing in it is unlocked" and a suite that guesses which tech that means is a suite
// that will be wrong on the next mod pack. Recorded as found and restored on every exit below.
const WANTED = { selector: "advanced-combinators", emitter: "circuit-network", machine: "automation" };
const wasResearched = lua(`local f=game.forces.player
local out={}
for _,t in ipairs{"automation","electronics","circuit-network","advanced-combinators","logistics","steel-processing"} do
  local x=f.technologies[t]; out[#out+1]=t.."="..(x and tostring(x.researched) or "absent")
end
rcon.print(table.concat(out," "))`);
console.log("research before:", wasResearched);
const alreadyOn = {};
for (const pair of wasResearched.split(/\s+/)) {
  const [k, v] = pair.split("=");
  if (v === "true") alreadyOn[k] = true;
  check("the technology this line needs exists in the save: " + k, v !== "absent", pair);
}
lua(`local f=game.forces.player
for _,t in ipairs{"automation","electronics","circuit-network","advanced-combinators","logistics","steel-processing"} do
  local x=f.technologies[t]; if x then x.researched=true end
end
rcon.print("on")`);

// Each block that BUILDS a lane takes a mark before it and cleans back to that mark after: the engines
// that fired `script_raised_revive` leave real machines standing (an undo takes back the ghosts it
// recorded, not the line the player built from them), and a leftover lane read by the next block's
// area is a wrong answer about a lane that is already proven. That is exactly how the rotate block came
// to fail: it was reading the mix block's machines.
const markHands = () => Number(lua("rcon.print(tostring(#(_G.BL or {})))").split("\n")[0].trim() || 0);
// `_G` lives as long as the server process, so a previous run of this suite (or one that crashed half
// way through) leaves its handle list behind. Read a mark against that and every entity THIS run builds
// looks older than the mark, nothing gets cleaned, and the next block reads the wrong machines.
lua("_G.BL = {} rcon.print('fresh')");
const cleanTo = (mark) => lua([
  'local s=game.surfaces["nauvis"]',
  'local keep, gone = 0, 0',
  'for i, rec in ipairs(_G.BL or {}) do',
  '  if i > ' + mark + ' then',
  '    local e = rec.ent',
  '    if e and e.valid then pcall(function() e.destroy() end); gone = gone + 1 end',
  '  else keep = keep + 1 end',
  'end',
  'local out = {}',
  'for i = 1, keep do out[i] = _G.BL[i] end',
  '_G.BL = out',
  'rcon.print("destroyed="..gone.." kept="..keep)',
].join("\n"));let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  // The world first: a suite that exits through a failure without cleaning leaves entities on a map
  // other suites read, and the next failure anyone sees is `NO_CLEAR_SITE` in somebody else's check.
  // (That is not hypothetical -- the run that added the mix check crashed on a typo before its own
  // cleanup line, and left three machines, three selectors and an emitter near spawn.)
  try {
    for (let i = 0; i < 6; i++) call("place_undo", { count: 1 });
    lua(`local s=game.surfaces["nauvis"]
local gone=0
for _, rec in ipairs(_G.BL or {}) do
  local e = rec.ent
  if e and e.valid then pcall(function() e.destroy() end); gone = gone + 1 end
end
rcon.print("handles cleaned="..gone)`);
  } catch (e) { console.log("cleanup failed:", String(e).slice(0, 120)); }
  lua(`local f=game.forces.player
local want={${Object.keys(alreadyOn).map((k) => `[${JSON.stringify(k)}]=true`).join(",")}}
for _,t in ipairs{"automation","electronics","circuit-network","advanced-combinators","logistics","steel-processing"} do
  local x=f.technologies[t]; if x and not want[t] then x.researched=false end
end
rcon.print("restored")`);
  console.log(fails.length ? "FAILURES: " + fails.join(", ") : "all checks passed");
  process.exit(code || (fails.length ? 1 : 0));
};

const BUS = ["iron-gear-wheel", "copper-cable", "electronic-circuit"];

// ---- the lane the plan builds ----
const ex = call("card_example", { machines: 3, recipe: BUS[0], bus: BUS });
const card = ex.data || {};
check("a bus lane is built", ex.ok && (card.entities || []).length > 0, ex.ok ? card.name : ex.code + " " + (ex.msg || ""));
if (!ex.ok) { console.log("STOP: no lane to place"); finish(1); }

const ents = card.entities;
const kindCount = (nm) => ents.filter((e) => e.name === nm).length;
const withCircuit = (pred) => ents.filter((e) => e.circuit && pred(e.circuit));
check("one controller per machine, and one emitter for the whole bus",
  withCircuit((c) => c.recipe_control).length === 3
    && withCircuit((c) => c.select).length === 3
    && withCircuit((c) => c.emitter).length === 1,
  ents.map((e) => e.name + (e.circuit ? "*" : "")).join(" ").slice(0, 200));
const indices = withCircuit((c) => c.select).map((e) => e.circuit.select.index).sort((a, b) => a - b);
check("each controller asks for a DIFFERENT position, counting from 0",
  JSON.stringify(indices) === "[0,1,2]", JSON.stringify(indices));
const signals = withCircuit((c) => c.emitter)[0].circuit.emitter;
check("the bus carries the caller's list, in order, with a distinct count on each",
  signals.length === BUS.length && signals.every((s, i) => s.name === BUS[i] && s.count === i + 1
    && s.type === "recipe"),
  JSON.stringify(signals));

const wires = asArr(card.wires);
check("every machine is wired to its own controller, and every controller to the bus",
  wires.length === 6, JSON.stringify(wires));
const wired_pairs = new Set(wires.map((x) => [x.from, x.to].join(">")));
check("a wire is never drawn twice in both directions, and none points outside the card",
  wires.every((x) => x.from >= 1 && x.to >= 1 && x.from <= ents.length && x.to <= ents.length
    && !wired_pairs.has([x.to, x.from].join(">"))),
  JSON.stringify(wires.slice(0, 4)));
const bus_at = ents.findIndex((e) => e.circuit && e.circuit.emitter) + 1;  // the card counts from 1
check("the emitter is the source end of exactly one wire per controller",
  wires.filter((x) => x.from === bus_at).length === 3, `emitter is entity ${bus_at}: ${JSON.stringify(wires)}`);
for (const [i, r] of BUS.entries()) {
  const sel = withCircuit((c) => c.select).find((e) => e.circuit.select.index === i);
  check(`machine ${i} would be handed ${r}`, !!sel, JSON.stringify(withCircuit((c) => c.select)));
}

// ---- what the group is worth ----
// The lane's own contract prices ONE recipe; a bus lane hands its machines different recipes, so the
// answer needs a capacity figure per covered recipe, priced by the same arithmetic (`crafts per minute
// = speed * 60 / energy`). Two of these three are one craft apart in time and twice apart in yield, so
// a single rate for the whole lane would be a number belonging to no machine on it.
const rates = asArr((card.bus || {}).rates);
check("the bus prices what each machine is worth, per recipe it covers",
  rates.length === BUS.length && rates.every((r) => r.recipe && r.item && r.per_min > 0
    && r.crafts_per_min > 0),
  JSON.stringify(rates));
check("the machine positions are the same zero-based ones the controllers were given",
  JSON.stringify(rates.map((r) => r.machine_index)) === "[0,1,2]", JSON.stringify(rates));
// Per-machine rate is `crafts per minute * this recipe's yield`, and the machine and its speed are the
// same on all three rows -- so the ONLY thing that should differ between them is the yield. Two of
// these recipes yield 1 and one yields 2, which makes "all three rates are distinct" a wrong claim and
// "the rate follows the yield, not the recipe name" the real one.
const yields = rates.map((r) => Math.round((r.per_min / r.crafts_per_min) * 100) / 100);
check("each rate is that machine's craft count times that recipe's own yield",
  rates.every((r, i) => r.per_min > 0 && Math.abs(r.per_min - r.crafts_per_min * yields[i]) < 1e-6),
  JSON.stringify(rates.map((r) => [r.recipe, r.crafts_per_min, r.per_min])));
check("and where the recipes differ in yield, the rates differ with them",
  new Set(yields).size > 1 && Math.max(...yields) / Math.min(...yields) > 1.5,
  JSON.stringify(yields));

// ---- a mix, which is whole machines and nothing else ----
// Two machines on one bus position both build that recipe, so "twice as much gear as cable" means two
// hands and one. That is the only form a mix can take here: the alternative is weighting a random pick
// by count, which is a mechanism nobody has measured on this build -- so the plan says "2 and 1"
// instead of "2:1" and the answer reports what each position is worth per machine AND per group.
const mix = call("card_example", { machines: 4, recipe: BUS[0], bus: [
  { recipe: "iron-gear-wheel", machines: 2 }, { recipe: "copper-cable", machines: 1 }] });
const md = mix.data || {};
const mixPos = asArr(md.entities).filter((e) => e.circuit && e.circuit.select).map((e) => e.circuit.select.index);
check("a weighted entry puts that many machines on the same position",
  mix.ok && JSON.stringify(mixPos) === "[0,0,1,2]", JSON.stringify({ pos: mixPos, code: mix.code }));
const cov = asArr((md.bus || {}).covered);
check("and the mix is reported per recipe, with the machine nobody got named as idle",
  JSON.stringify(cov.map((c) => [c.recipe, c.machines])) === JSON.stringify([["iron-gear-wheel", 2], ["copper-cable", 1]])
    && JSON.stringify((md.bus || {}).idle_machines) === "[3]",
  JSON.stringify({ cov, idle: (md.bus || {}).idle_machines }));
const mixRates = asArr((md.bus || {}).rates);
check("a rate row says both what one hand makes and what the group's hands make",
  mixRates.length === 2 && mixRates[0].machines === 2
    && Math.abs(mixRates[0].per_min_total - mixRates[0].per_min * 2) < 1e-6
    && mixRates[1].machines === 1 && Math.abs(mixRates[1].per_min_total - mixRates[1].per_min) < 1e-6,
  JSON.stringify(mixRates));
const wide = call("card_example", { machines: 2, recipe: BUS[0], bus: [
  { recipe: "iron-gear-wheel", machines: 2 }, { recipe: "copper-cable", machines: 2 }] });
check("an explicit ask for more hands than the lane has is refused, not truncated",
  !wide.ok && wide.code === "BUS_TOO_WIDE", `${wide.code} ${wide.msg}`);
const tooMany = call("card_example", { machines: 2, recipe: BUS[0], bus: BUS });
check("but naming three candidates for two machines is a question, answered not refused",
  tooMany.ok && JSON.stringify((tooMany.data || {}).bus.unclaimed) === '["electronic-circuit"]'
    && JSON.stringify(asArr((tooMany.data || {}).bus.covered).map((c) => c.machines)) === "[1,1,0]",
  JSON.stringify((tooMany.data || {}).bus));
const fracMach = call("card_example", { machines: 3, recipe: BUS[0], bus: [
  { recipe: "iron-gear-wheel", machines: "two" }] });
check("a fractional machine count is refused: a mix is whole machines here",
  !fracMach.ok && fracMach.code === "BUS_NOT_RUNNABLE" && JSON.stringify((fracMach.detail || {}).problems).includes("MACHINES_NOT_A_COUNT"),
  `${fracMach.code} ${JSON.stringify((fracMach.detail || {}).problems)}`);
const zeroMach = call("card_example", { machines: 3, recipe: BUS[0], bus: [
  { recipe: "iron-gear-wheel", machines: 0 }] });
check("and zero machines for a recipe is refused rather than silently dropped",
  !zeroMach.ok && zeroMach.code === "BUS_NOT_RUNNABLE" && JSON.stringify(zeroMach.detail).includes("MACHINES_BELOW_ONE"),
  `${zeroMach.code} ${JSON.stringify((zeroMach.detail || {}).problems)}`);

// ---- the other thing a shared bus is for: rotating over the list instead of splitting it ----
const spin = call("card_example", { machines: 2, recipe: BUS[0], bus: BUS, bus_mode: "rotate", bus_every: 20 });
const spd = spin.data || {};
const spinCtrl = asArr(spd.entities).filter((e) => e.circuit && e.circuit.rotate);
const pinned = asArr(spd.entities).filter((e) => e.circuit && e.circuit.select);
check("rotate lays controllers that pick on an interval instead of holding a position",
  spin.ok && spinCtrl.length === 2 && pinned.length === 0
    && spinCtrl.every((e) => e.circuit.rotate === 20),
  JSON.stringify({ ctrl: spinCtrl.length, pinned: pinned.length }));
check("and the answer says which mode the lane is in, with no per-position rates to read",
  ((spd.bus || {}).mode) === "rotate" && (spd.bus || {}).every_ticks === 20 && !spd.bus.rates,
  JSON.stringify({ mode: (spd.bus || {}).mode, every: (spd.bus || {}).every_ticks,
    rates: (spd.bus || {}).rates }));
const wrongMode = call("card_example", { machines: 1, recipe: BUS[0], bus: BUS, bus_mode: "shuffle" });
check("a bus_mode that is neither word is refused rather than defaulted",
  !wrongMode.ok && wrongMode.code === "UNKNOWN_BUS_MODE", `${wrongMode.code} ${wrongMode.msg}`);

// A lane of the same recipe WITHOUT a bus is the control: the bus is ground, and the difference should
// be visible as ground rather than as a sentence.
const plain = call("card_example", { machines: 3, recipe: BUS[0] });
const pd = plain.data || {};
check("the same lane without a bus is smaller on the map",
  plain.ok && (pd.footprint || {}).height < (card.footprint || {}).height
    && !(pd.wires || []).length,
  `bus ${JSON.stringify(card.footprint)} vs plain ${JSON.stringify(pd.footprint)}`);
check("and carries no circuit at all",
  asArr(pd.entities).every((e) => !e.circuit), JSON.stringify(asArr(pd.entities).filter((e) => e.circuit)));

// ---- the refusals, which are the design talking ----
const badName = call("card_example", { machines: 1, recipe: BUS[0], bus: ["not-a-recipe-at-all"] });
check("a bus naming something that is not a recipe is refused",
  !badName.ok && badName.code === "BUS_NOT_RUNNABLE"
    && ((badName.detail || {}).problems || [])[0]?.why === "UNKNOWN_RECIPE",
  `${badName.code} ${JSON.stringify((badName.detail || {}).problems)}`);
const emptyBus = call("card_example", { machines: 1, recipe: BUS[0], bus: [] });
check("bus = {} is refused rather than laid as a plain lane", !emptyBus.ok && emptyBus.code === "BUS_EMPTY",
  emptyBus.code);
// Which refusal this is depends on which piece is missing, so the missing piece is arranged rather
// than assumed: the emitter (a decider) is behind `circuit-network` on this install, and un-researching
// it leaves the machine, belt, chest and arm placeable, so the refusal can only come from the bus's own
// hardware branch. Restored immediately -- the rest of the suite needs the bus.
lua(`local f=game.forces.player local t=f.technologies["circuit-network"] if t then t.researched=false end rcon.print("off")`);
const noHw = call("card_example", { machines: 3, recipe: BUS[0], bus: BUS });
lua(`local f=game.forces.player local t=f.technologies["circuit-network"] if t then t.researched=true end rcon.print("back on")`);
check("a force that cannot place the bus's emitter is told which piece is missing",
  !noHw.ok && noHw.code === "NO_AVAILABLE_PART" && /emitter/.test(noHw.msg || ""),
  `${noHw.code} ${noHw.msg}`);

// ---- freeze, place, build: the part nothing else covers ----
const fz = call("card_freeze", { card, allow_unmeasured: true });
check("the lane freezes with its wiring and its controllers", fz.ok, fz.ok ? fz.data.name : fz.code);
if (!fz.ok) finish(1);

const supplyBox = { x: 0, y: 0 };
const splitMark = markHands();
const pl = call("card_place", { name: card.name, surface: "nauvis" });
const pp = pl.data || {};
const surf = pp.surface || "nauvis";
const origin = pp.origin || { x: 0, y: 0 };
check("placed as ghosts", pl.ok && pp.ghosts === ents.length, pl.ok ? `${pp.ghosts}/${ents.length}` : pl.code);
const pw = pp.wires || {};
check("all six preview wires are drawn on the ghosts", pw.drawn === 6, JSON.stringify(pw));
check("and the answer counts the controllers it has not configured yet",
  ((pw.circuit || {}).waiting || 0) === 7 && pw.circuit.applied_on_build === true,
  JSON.stringify(pw.circuit));

const area = `{{${origin.x - 1},${origin.y - 1}},{${origin.x + (card.footprint || {}).width + 1},${origin.y + (card.footprint || {}).height + 2}}}`;
const built = lua(`local s=game.surfaces["${surf}"]
_G.BL = _G.BL or {}
local n, errs = 0, {}
for _,g in ipairs(s.find_entities_filtered{area=${area},type="entity-ghost"}) do
  local at, nm = g.position, g.ghost_name
  local ok, err = pcall(function() g.silent_revive{raise_revive=true} end)
  if not ok then errs[#errs+1] = tostring(err):sub(1, 60) else
    -- silent_revive returns nothing useful (the engine's own answer is nil), so the entity that arrived
    -- is looked up by the cell it was built on -- the same fact the wiring suite learned the hard way
    local found = s.find_entities_filtered{area={{math.floor(at.x)-1, math.floor(at.y)-1},
      {math.floor(at.x)+1, math.floor(at.y)+1}}, name=nm}
    if found[1] then n=n+1; _G.BL[#_G.BL+1]={ent=found[1], name=found[1].name, at=found[1].position}
    else errs[#errs+1]="no entity at " .. nm end
  end
end
-- a bus is an electrical thing: an unpowered controller emits nothing at all (measured), so the
-- supply is placed beside the lane before anything is read
local src = s.create_entity{name="electric-energy-interface", position={x=${origin.x + 2.5}, y=${origin.y + (card.footprint || {}).height + 1.5}}, force="player"}
if src then _G.BL[#_G.BL+1]={ent=src, name=src.name, at=src.position} end
rcon.print("revived="..n.." supply="..tostring(src~=nil).." errs=["..table.concat(errs,"; ").."]")`);
console.log("built:", built);
check("every ghost was built by the engine, not by this mod", new RegExp(`revived=${ents.length}`).test(built), built);
sleep(4000);

const readout = lua(`local s=game.surfaces["${surf}"]
local W=defines.wire_connector_id
local out={}
local ms=s.find_entities_filtered{area=${area},type="assembling-machine"}
table.sort(ms, function(a,b) return a.position.x < b.position.x end)
for _,m in ipairs(ms) do
  local n=m.get_circuit_network(W.circuit_green)
  local sigs={}
  if n and n.signals then for _,q in ipairs(n.signals) do
    local g=q[1] or q.signal sigs[#sigs+1]=tostring(g and g.name).."="..tostring(q[2] or q.count) end end
  out[#out+1]=tostring((m.get_recipe() or {}).name).."/"..#sigs.."sig["..table.concat(sigs,",").."]"
end
rcon.print("machines: "..table.concat(out," | "))`);
console.log("readout:", readout);
// The claim of the whole feature, said by the machines themselves: three different recipes, in the
// caller's order, on three machines that were never told individually what to build -- and exactly ONE
// signal on each of their wires, which is the constraint act A/F/H imposed.
const assigned = BUS.filter((r) => new RegExp(r + "/1sig").test(readout)).length;
check("three machines, three recipes, no two the same",
  assigned === 3 && (readout.match(/1sig/g) || []).length === 3, readout);
check("each machine's wire carries one signal, not the whole bus",
  !/3sig/.test(readout) && (readout.match(/1sig/g) || []).length === 3, readout);

// The bus is a SET, and a group can be the wrong size for it. This is the case `bus` exists to say out
// loud: two machines, three recipes, and an answer that names the one nobody builds.
const short = call("card_example", { machines: 2, recipe: BUS[0], bus: BUS });
const sd = short.data || {};
// The shape of a `covered` row grew when a recipe could take more than one machine, so this reads the
// counts rather than a list of names -- and `unclaimed` is the same fact said the other way: a
// candidate with no hand on it is not covered, whatever the lane's size.
check("a group too small for its bus says which recipes go unclaimed",
  short.ok && JSON.stringify(asArr(sd.bus.covered).map((c) => [c.recipe, c.machines]))
    === JSON.stringify([["iron-gear-wheel", 1], ["copper-cable", 1], ["electronic-circuit", 0]])
    && JSON.stringify(sd.bus.unclaimed) === '["electronic-circuit"]',
  JSON.stringify(sd.bus));
const extra = call("card_example", { machines: 3, recipe: BUS[0], bus: [BUS[0]] });
const ed = extra.data || {};
check("...and a group too big for it names the machines that will idle",
  extra.ok && JSON.stringify(ed.bus.idle_machines) === "[1,2]", JSON.stringify(ed.bus));

// The split lane is cleaned here, before anything else is built and read: `place_undo` leaves a line
// the player built standing (correctly -- it is theirs now), so the handles are what take it back, and a
// later block that reads "every assembling machine in this area" would otherwise read this one too.
console.log("split cleaned:", cleanTo(splitMark));

// ---- the mix, on the ground ----
// The claim a mix makes is about whole machines, so it is read back from whole machines: two hands on
// position 0 build the same recipe, the one hand on position 1 builds its own, and the two machines the
// list did not reach hold NOTHING -- which is what an out-of-range position was measured to do (act M),
// and the reason "4 machines, 3 hands" is an honest answer rather than a lane that quietly doubled
// someone up.
const mixFz = call("card_freeze", { card: md, allow_unmeasured: true, name: "mix-lane-e2e" });
check("a mix lane freezes", mixFz.ok, mixFz.ok ? mixFz.data.name : mixFz.code);
if (mixFz.ok) {
  const mp = call("card_place", { name: "mix-lane-e2e", surface: "nauvis" });
  const mpd = mp.data || {};
  const mo = mpd.origin || { x: 0, y: 0 };
  const marea = `{{${mo.x - 1},${mo.y - 1}},{${mo.x + (((md.footprint || {}).width) || 47) + 1},${mo.y + (((md.footprint || {}).height) || 14) + 2}}}`;
  const mixMark = markHands();
  const mbuilt = lua(`local s=game.surfaces["${mpd.surface || "nauvis"}"]
local n=0
for _,g in ipairs(s.find_entities_filtered{area=${marea},type="entity-ghost"}) do
  local at, nm = g.position, g.ghost_name
  local ok=pcall(function() g.silent_revive{raise_revive=true} end)
  if ok then
    for _,e in ipairs(s.find_entities_filtered{area={{math.floor(at.x)-1,math.floor(at.y)-1},
      {math.floor(at.x)+1,math.floor(at.y)+1}}, name=nm}) do
      _G.BL[#_G.BL+1]={ent=e,name=e.name,at=e.position}
    end
    n=n+1
  end
end
local src=s.create_entity{name="electric-energy-interface",position={x=${mo.x + 2.5},y=${mo.y + 20.5}},force="player"}
if src then _G.BL[#_G.BL+1]={ent=src,name=src.name,at=src.position} end
rcon.print("mix revived="..n.." src="..tostring(src~=nil))`);
  console.log("mix built:", mbuilt);
  sleep(4000);
  const mixRead = lua(`local s=game.surfaces["${mpd.surface || "nauvis"}"]
local out={}
local ms=s.find_entities_filtered{area=${marea},type="assembling-machine"}
table.sort(ms, function(a,b) return a.position.x < b.position.x end)
for _,m in ipairs(ms) do out[#out+1]=tostring((m.get_recipe() or {}).name) end
rcon.print("mix hands: "..table.concat(out," "))`);
  console.log("mix read:", mixRead);
  const hands = mixRead.split(/\s+/).filter((x) => x.includes("-") || x === "nil");
  check("two hands on one position build the same recipe, and the unclaimed ones build nothing",
    hands.filter((h) => h === "iron-gear-wheel").length === 2
      && hands.filter((h) => h === "copper-cable").length === 1
      && hands.filter((h) => h === "nil").length === 1,
    mixRead);
  call("place_undo", { count: 1 });
  console.log("mix cleaned:", cleanTo(mixMark));
}

// A rotating lane, built and read twice. The claim is about the group over time, so it is sampled over
// time: two reads a few seconds apart (120 game ticks at 1x, six picks per controller at 20 ticks),
// and what must hold is that every recipe seen is on the bus and that the group did NOT sit on one
// recipe. Asserting "this specific machine changed" would be a coin flip dressed as a fact -- one
// machine, six picks, three candidates can legitimately repeat -- so the assertion is about the set
// the group visited, which is what a player is actually buying.
const spinFz = call("card_freeze", { card: spd, allow_unmeasured: true, name: "spin-lane-e2e" });
check("a rotate lane freezes with its controllers", spinFz.ok, spinFz.ok ? spinFz.data.name : spinFz.code);
if (spinFz.ok) {
  const sp = call("card_place", { name: "spin-lane-e2e", surface: "nauvis" });
  const spd2 = sp.data || {};
  const so = spd2.origin || { x: 0, y: 0 };
  const sarea = `{{${so.x - 1},${so.y - 1}},{${so.x + (((spd.footprint || {}).width) || 30) + 1},${so.y + (((spd.footprint || {}).height) || 14) + 2}}}`;
  const spinMark = markHands();
  const sbuilt = lua(`local s=game.surfaces["${spd2.surface || "nauvis"}"]
local n=0
for _,g in ipairs(s.find_entities_filtered{area=${sarea},type="entity-ghost"}) do
  local at, nm = g.position, g.ghost_name
  local ok=pcall(function() g.silent_revive{raise_revive=true} end)
  if ok then
    local found=s.find_entities_filtered{area={{math.floor(at.x)-1,math.floor(at.y)-1},
      {math.floor(at.x)+1,math.floor(at.y)+1}}, name=nm}
    for _,e in ipairs(found) do _G.BL[#_G.BL+1]={ent=e,name=e.name,at=e.position} end
    n=n+1
  end
end
local src=s.create_entity{name="electric-energy-interface",position={x=${so.x + 2.5},y=${so.y + 20.5}},force="player"}
if src then _G.BL[#_G.BL+1]={ent=src,name=src.name,at=src.position} end
rcon.print("spin revived="..n.." src="..tostring(src~=nil))`);
  console.log("spin built:", sbuilt);
  const seenAt = () => lua(`local s=game.surfaces["${spd2.surface || "nauvis"}"]
local out={}
for _,m in ipairs(s.find_entities_filtered{area=${sarea},type="assembling-machine"}) do
  out[#out+1]=tostring((m.get_recipe() or {}).name)
end
table.sort(out)
rcon.print(table.concat(out," "))`);
  const first = seenAt().replace(/^OK\s*|\s*OK$/g, "").trim();
  sleep(4500);
  const second = seenAt().replace(/^OK\s*|\s*OK$/g, "").trim();
  console.log("spin samples:", first, "||", second);
  const seen = new Set((first + " " + second).split(/\s+/).filter((x) => x && x !== "nil" && x !== "OK"));
  check("every recipe a rotating machine settled on is one the plan named",
    seen.size > 0 && BUS.every((r) => !seen.has(r) || true) && [...seen].every((r) => BUS.indexOf(r) >= 0),
    `${seen.size} seen: ${[...seen].join(",")}`);
  check("and the group visited more than one of them, unprompted",
    seen.size >= 2, `samples [${first}] then [${second}]`);
  call("place_undo", { count: 1 });
  console.log("spin cleaned:", cleanTo(spinMark));
}

// ---- how many of these groups fit the ground I drew ----
// A bus lane's output is a vector, so `plan_fit`'s one-product arithmetic cannot be asked about it;
// `group_fit` tiles whole groups instead and multiplies the vector. Asserted against the numbers the
// answer itself carries (footprint, box, gap) rather than against a re-derivation, because the thing
// that can go wrong here is the answer disagreeing with its own arithmetic.
const BOX = { left_top: { x: 0, y: 60 }, right_bottom: { x: 119, y: 99 } };
const gf = call("group_fit", { bus: [{ recipe: BUS[0], machines: 2 }, { recipe: BUS[1], machines: 1 }],
  machines: 3, surface: "nauvis", area: BOX });
const gd = gf.data || {};
check("group_fit tiles whole groups and counts them",
  gf.ok && gd.groups > 0 && gd.cols * gd.rows === gd.groups,
  JSON.stringify({ cols: gd.cols, rows: gd.rows, groups: gd.groups, code: gf.code }));
const gw = ((gd.group || {}).width) || 1, gh = ((gd.group || {}).height) || 1;
check("the count is the box, the footprint and the gap -- and the leftovers are said too",
  gd.cols === Math.floor((gd.box.width + gd.gap) / (gw + gd.gap))
    && gd.rows === Math.floor((gd.box.height + gd.gap) / (gh + gd.gap))
    && gd.left_over.width >= 0 && gd.left_over.height >= 0,
  JSON.stringify({ box: gd.box, group: [gw, gh], gap: gd.gap, left: gd.left_over }));
const totals = asArr((gd.output || {}).total);
check("the box's output is the group's vector times the groups that landed",
  totals.length === 2 && totals.every((t) => {
    const per = asArr((gd.output || {}).per_group).find((x) => x.recipe === t.recipe);
    return per && Math.abs(t.per_min - per.per_min * gd.groups) < 1e-6;
  }), JSON.stringify(gd.output));
// The hardware question, which is the one this method nearly got wrong: a group built around nothing
// defaults to the smelting lane `card_example` has always laid, and an electric furnace prices
// iron-gear-wheel at four times what the assembler on the bus would.
const gearRow = asArr(((gd.group || {}).bus || {}).rates).find((r) => r.recipe === BUS[0]);
check("a group priced itself on the machine the bus needs, not on a default furnace",
  !!gearRow && gearRow.per_min === 60 && gearRow.machines === 2
    && Math.abs(gearRow.per_min_total - 120) < 1e-6,
  JSON.stringify(gearRow));
const tight = call("group_fit", { bus: BUS, machines: 2, surface: "nauvis",
  area: { left_top: { x: 0, y: 60 }, right_bottom: { x: 8, y: 63 } } });
check("a box too small for one whole group says so with both sizes in the sentence",
  tight.ok && tight.data.groups === 0 && !tight.data.fits
    && /47|23|31/.test(String((tight.data.why || "").replace(/[^0-9]/g, ""))) && !!tight.data.why,
  JSON.stringify({ groups: (tight.data || {}).groups, why: (tight.data || {}).why }));
const gapped = [2, 10].map((g) => call("group_fit", { bus: BUS, machines: 2, surface: "nauvis",
  area: BOX, gap: g }).data.groups);
check("asking for a wider aisle does not fit more groups", gapped[0] >= gapped[1], JSON.stringify(gapped));
const noBus = call("group_fit", { surface: "nauvis", area: BOX });
check("group_fit without a bus is refused rather than fitting an empty group",
  !noBus.ok && noBus.code === "BAD_ARGS", `${noBus.code} ${noBus.msg}`);
check("and the answer is honest about not turning the card",
  gd.turned === false && /square/.test(String(gd.why_not_turned)), JSON.stringify({ t: gd.turned, why: gd.why_not_turned }));

// ---- leave the world as it was found ----
const undo = call("place_undo", { count: 1 });
check("the placement is taken back", undo.ok, undo.code + " " + (undo.msg || ""));
const swept = lua(`local s=game.surfaces["${surf}"]
local gone, stale = 0, 0
for _, rec in ipairs(_G.BL or {}) do
  local e = rec.ent
  if e and e.valid then pcall(function() e.destroy() end); gone = gone + 1 else stale = stale + 1 end
end
-- and by cell, because a revived ghost's handle is not the same claim as "nothing of mine is left":
-- the first version of this sweep counted nil handles as cleaned and left machines standing
local left = 0
for _, r in ipairs({{"assembling-machine-1",0},{"selector-combinator",0},{"decider-combinator",0}}) do
  for _, e in ipairs(s.find_entities_filtered{area=${area}, name=r[1]}) do
    pcall(function() e.destroy() end)
    if e.valid then left = left + 1 end
  end
end
_G.BL = nil
rcon.print("destroyed="..gone.." gone_before="..stale.." still="..left)`);
console.log("sweep:", swept);
check("the ground this suite built is empty again", /still=0/.test(swept), swept);
// by name, not `all = true`: the cycle lays fixture cards that the suites running after this one read
// (`refusals` answers "0 cards on this save -- run dev/cycle.sh" when they are gone, which is a wrong
// verdict about a card this suite simply deleted)
for (const nm of [card.name, "spin-lane-e2e"]) call("card_forget", { name: nm });

finish();
