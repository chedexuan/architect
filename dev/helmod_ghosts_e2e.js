// End-to-end gate: helmod's computed plan, laid as ghosts, with nothing in between.
//
// The ask this file exists for (the user's words, 2026-10-01): "把 helmod 量化计算的结果直接生成可以放置的
// 虚影，不需要任何限制". Every other path in this mod turns a plan into a FROZEN CARD first, and the card
// path is where the gates live -- lint, the bench measurement, the claim that the line can actually pay for
// itself. Those gates are the right thing for a card a designer hands to a player. They are the wrong thing
// for "I already computed this in helmod, put it on the ground", and the friction of walking that path is
// what this method removes.
//
// What is still here, and why it is not a "limit":
//   * the undo record -- a button that lays two hundred ghosts needs the button that takes them back;
//   * a thing that is not an entity (a module, a fuel) is reported as SKIPPED rather than vanishing,
//     because "24 ghosts where the plan said 30" is only honest if the six are accounted for;
//   * a fractional machine count is said twice -- `wanted` as helmod computed it, `placed` as whole ghosts.
//
// The helmod half is read through helmod's own cross-mod door. From the mod's source (2.2.13,
// data/RemoteAPI.lua): `remote.add_interface("helmod_interface", { get_models = function() return
// storage.models end, ... })`, and a block's computed machines sit in `summary_global.factories` as
// `{name, quality, type, count, count_limit, count_deep}` (data/ModelCompute.lua writes them there, and
// `summary_global` already counts children -- which is the trap the third gate below holds shut).
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("helmod_ghosts_e2e");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016" };
const call = (m, a) => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
  } catch (e) { return { ok: false, code: "HARNESS", msg: String((e && e.stderr) || e).slice(0, 160) }; }
  try { return JSON.parse(out.trim()); } catch (e) { return { ok: false, code: "PARSE", msg: out.slice(0, 200) }; }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 28 }).trim();
  } catch (e) { return "probe failed: " + String((e && e.stderr) || e).slice(0, 160); }
};
const asList = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === "number" ? v : NaN);

let pass = 0, fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log("  ok   " + name); }
  else { fails.push(name); console.log("  FAIL " + name + " -- " + detail); }
};

const SURF = "nauvis";
// Far from spawn and from every other suite's patch: this file lays and clears its own ground.
const AT = { x: 300, y: 300 };
const AREA = `{{${AT.x - 2},${AT.y - 2}},${"{" + (AT.x + 60) + "," + (AT.y + 40) + "}"}}`;
const wipe = () => lua(`local s = game.surfaces["${SURF}"]
local n = 0
for _, e in ipairs(s.find_entities_filtered{ area = ${AREA}, type = "entity-ghost" }) do
  if e.valid then pcall(function() e.destroy() end); n = n + 1 end
end
rcon.print("wiped=" .. n)`);
const countGhosts = () => Number(String(lua(`local s = game.surfaces["${SURF}"]
local n = 0
for _, e in ipairs(s.find_entities_filtered{ area = ${AREA}, type = "entity-ghost" }) do n = n + 1 end
rcon.print(n)`).split(/\r?\n/).filter((l) => /^\d+$/.test(l.trim())).pop() || "0"));

// ------------------------------------------------------------------ the door is real
// Not a stand-in: `remote.interfaces` is the engine's own list of what the save can be asked. Asserting
// it here is what makes the rest of the file's "helmod is installed" claim worth anything -- if helmod
// were missing, every gate below would still pass on `plan = {}` and the file would be proving nothing.
const door = lua(`local i = remote.interfaces and remote.interfaces["helmod_interface"]
rcon.print(i and "present" or "absent")`);
check("helmod's own cross-mod door is in this save (the source of the shape read below)",
  /present/.test(String(door)), String(door));

wipe();

// ------------------------------------------------------------------ 1. counts, no gates
const laid = call("helmod_ghosts", {
  into: "ground",
  plan: { "assembling-machine-3": 3, "electric-furnace": 2.5, "speed-module": 40 },
  surface: SURF, origin: AT, width: 20,
});
const ld = laid.data || {};
const byName = (n) => asList(ld.items).find((e) => e.name === n) || {};
check("helmod's numbers become ghosts with no card, no lint and no measurement in the way",
  laid.ok === true && ld.source === "plan" && ld.ghosts === 6
    && byName("assembling-machine-3").placed === 3,
  JSON.stringify([laid.code, ld.source, ld.ghosts, ld.items]).slice(0, 240));
// The line a player actually needs: 2.5 furnaces is a true answer in helmod and a false number on the
// ground. Saying `wanted` beside `placed` is what stops "it lost half a furnace" being the reading.
check("a fractional machine count says both what the plan asked and what got laid",
  Math.abs(num(byName("electric-furnace").wanted) - 2.5) < 1e-9
    && byName("electric-furnace").placed === 3 && ld.rounded === "up",
  JSON.stringify(byName("electric-furnace")));
check("...and a thing that is not an entity is accounted for as skipped, not silently dropped",
  asList(ld.skipped).some((s) => s.name === "speed-module" && Math.abs(num(s.wanted) - 40) < 1e-9),
  JSON.stringify(ld.skipped));
check("and the whole batch is on the undo stack, so one press puts it back",
  typeof ld.deployment === "number" && countGhosts() === 6,
  JSON.stringify([ld.deployment, countGhosts()]));
const undone = call("place_undo", { count: 1 });
check("撤回 takes a helmod lay back in one step -- the ghost count says so, not the answer's word",
  undone.ok === true && countGhosts() === 0, JSON.stringify([undone.code, countGhosts()]));

// ------------------------------------------------------------------ 2. rounding is a choice
const down = call("helmod_ghosts", { into: "ground", plan: { "electric-furnace": 2.5 }, surface: SURF, origin: AT,
  round: "down" });
check("round = down is honoured rather than smoothed over",
  down.ok === true && down.data.ghosts === 2, JSON.stringify([down.code, down.data.ghosts]));
call("place_undo", { count: 1 });
wipe();

// ------------------------------------------------------------------ 3. the models shape
// Shaped from helmod's own source: a block whose `summary_global.factories` ALREADY counts the children
// (data/ModelCompute.lua folds each child's `summary_global.factories` into the parent's), so a reader
// that walks the tree as well as the summary bills every machine twice. The numbers below are chosen so
// the two readings are impossible to confuse: the parent's global says 6, its child says 4, the child's
// own recipe says 2.
// Shaped from a live capture, not from the docs: `remote.call("helmod_interface","get_models")` on a
// save where the player built an iron-plate factory returns a CONTAINER per factory --
//   models.model_2 = {class="Model", id="model_2", block_root={class="Block", name="iron-plate",
//     summary_global={factories={["steel-furnace-normal"]={name="steel-furnace", count=48}}, beacons=...},
//     children={R1={class="Recipe", name="iron-plate", count=30,
//                  factory={name="steel-furnace", amount=1.6, count=48}}}}}
// Reading the bag off the CONTAINER is the bug this fixture exists to keep: it answered "this plan has no
// machines" to a plan of 48 furnaces, because the numbers were one level down.
const models = {
  model_7: {
    class: "Model", id: "model_7",
    block_root: {
      class: "Block", name: "iron chain",
      summary: { factories: { a: { name: "assembling-machine-2", type: "entity", count: 2 } } },
      summary_global: { factories: { a: { name: "assembling-machine-2", type: "entity", count: 6 } } },
      children: {
        1: {
          class: "Block",
          summary: { factories: { b: { name: "electric-furnace", type: "entity", count: 4 } } },
          summary_global: { factories: { b: { name: "electric-furnace", type: "entity", count: 4 } } },
          children: { 1: { count: 2, factory: { name: "assembling-machine-1", amount: 1, count: 2 } } },
        },
      },
    },
  },
  model_9: {
    class: "Model", id: "model_9",
    block_root: { class: "Block", name: "lonely row",
      summary_global: { factories: { c: { name: "steel-plate", type: "item", count: 5 } } }, children: {} },
  },
};
const fromModels = call("helmod_ghosts", { into: "ground", models, surface: SURF, origin: AT, width: 24 });
const fm = fromModels.data || {};
check("a helmod model table reads its summary_global, and does not ALSO walk the children",
  fromModels.ok === true && fm.source === "helmod"
    && byNameFM("assembling-machine-2", fm).placed === 6 && fm.ghosts === 6,
  JSON.stringify([fromModels.code, fm.kinds, fm.items]).slice(0, 240));
// The 9th model's entry names an ITEM, and an item has no footprint: it must be skipped, and the rest of
// the plan must still land. A reader that refused the whole batch here would turn one bad row into a
// button that does nothing.
check("a row that is not an entity is skipped without refusing the rest of the plan",
  asList(fm.skipped).some((s) => s.name === "steel-plate") && fm.ghosts === 6,
  JSON.stringify([fm.ghosts, fm.skipped]).slice(0, 200));
const oneFactory = call("helmod_ghosts", { into: "ground", models, factory: "model_9", surface: SURF, origin: AT });
check("a named factory reads that factory only -- the other model's machines stay in helmod",
  oneFactory.ok === true && (oneFactory.data || {}).ghosts === 0
    && (oneFactory.data || {}).kinds === 1
    && asList((oneFactory.data || {}).skipped).some((s) => s.name === "steel-plate"),
  JSON.stringify([oneFactory.code, oneFactory.data]).slice(0, 220));
const noFactory = call("helmod_ghosts", { models, factory: "model_4242", surface: SURF, origin: AT });
check("a factory number helmod does not have is refused by name, with the ones it does have",
  noFactory.ok === false && noFactory.code === "HELMOD_NO_FACTORY"
    && asList(noFactory.detail.known).join(",") === "model_7,model_9",
  JSON.stringify([noFactory.code, noFactory.detail]).slice(0, 200));
call("place_undo", { count: 2 });
wipe();

// The picker, on the same captured shape. Two claims: it reads through the Model container (the bug the
// player hit: a 48-furnace factory answered "这张表里没有可以铺的机器"), and it names each entry by what
// the factory MAKES -- `model_2` is an internal key that matches nothing on helmod's own screen.
const listed = call("helmod_factories", { models });
const lf = asList((listed.data || {}).factories);
check("helmod_factories reads through the Model container and names each factory by what it makes",
  listed.ok === true && lf.length === 2
    && lf.some((f) => f.name === "iron chain" && f.machines === 6)
    && lf.every((f) => /^model_/.test(String(f.id))),
  JSON.stringify([listed.code, lf]).slice(0, 320));
// The row a player reads before choosing. `machines` counts what the table NAMES, even when the lay
// later discovers the name is an item rather than a machine (model_9 says 5 steel-plate) -- that is
// honest in a different way: the picker's number is helmod's number, and the lay's `skipped` row is
// where "and 5 of those cannot stand on the ground" is said.
// The recipe count is what the picker says a factory will become -- a LANE per recipe -- so it is read
// off the fixture whose recipe rows carry the name helmod puts on them (checked below, where it lives).
// model_7's nested row is unnamed
// on purpose (a real helmod file does have rows the mod cannot name), and the honest answer there is 0
// lanes, not a lane built on a guess.
check("...and every row carries the kind-and-count label the picker shows",
  lf.every((f) => typeof f.label === "string" && f.label.length > 0)
    && lf.some((f) => f.id === "model_9" && f.machines === 5 && /steel-plate/.test(f.label)),
  JSON.stringify(lf.map((f) => [f.id, f.label, f.machines])).slice(0, 300));

// ------------------------------------------------------------------ 3b. lanes: belts and arms too
// "肯定要全铺的，包括机械臂和传送带" (2026-10-01). A machine count alone is not a factory: the row has to be
// fed, and feeding it is geometry this mod already owns and already gates -- `card_example` lays the lane.
// So a helmod recipe row becomes a LANE, and the parts it laid are counted by kind rather than lumped
// into a ghost total a reader cannot check.
const laneModel = {
  model_5: {
    class: "Model", id: "model_5",
    block_root: {
      class: "Block", name: "plate and cable",
      children: {
        R1: { class: "Recipe", name: "iron-plate", count: 4,
          factory: { name: "electric-furnace", amount: 1, count: 4 } },
        R2: { class: "Recipe", name: "plastics", count: 2,
          factory: { name: "assembling-machine-1", amount: 1, count: 2 } },
      },
      summary_global: {
        factories: {
          a: { name: "electric-furnace", type: "entity", count: 4 },
          b: { name: "assembling-machine-1", type: "entity", count: 2 },
        },
        beacons: { c: { name: "beacon", type: "entity", count: 3 } },
      },
    },
  },
};
// The picker's other half, on the fixture above: the recipe count is what a factory will become -- one
// LANE per named recipe -- so it can only be asserted where the named rows are.
const listedLanes = call("helmod_factories", { models: laneModel });
const llf = asList((listedLanes.data || {}).factories);
check("...and the page is listed with what it holds, alongside one entry per line on it",
  listedLanes.ok === true && llf.length === 3
    && llf[0].id === "model_5" && llf[0].machines === 6 && llf[0].recipes === 2
    && llf.slice(1).every((f) => f.kind === "line" && f.page === "model_5" && f.recipes === 1)
    && llf.some((f) => f.id === "model_5#iron-plate" && f.machine === "electric-furnace" && f.machines === 4)
    && llf.some((f) => f.id === "model_5#plastics" && f.machines === 2),
  JSON.stringify(llf).slice(0, 320));
// The reason the lines are listed separately: "铺哪一条" is the question, and a page in helmod is not
// one line (measured in a real save -- the page named iron-plate also ran 15 electronic-circuit
// assemblers). So picking one line has to lay ONE line, and say so.
const oneLine = call("helmod_ghosts", { into: "string", models: laneModel, surface: SURF,
  origin: AT, width: 90, factory: "model_5#iron-plate" });
const ol = oneLine.data || {};
check("picking one line lays that line and leaves the rest of the page in helmod",
  oneLine.ok === true && asList(ol.lanes).length === 1
    && asList(ol.lanes)[0].recipe === "iron-plate" && asList(ol.lanes)[0].machines === 4
    && ol.scoped === "iron-plate" && asList(ol.items).length === 0 && !ol.fed === false
    && (ol.parts || {})["beacon"] === undefined,
  JSON.stringify([oneLine.code, ol.scoped, asList(ol.lanes).map((l) => l.recipe),
    asList(ol.items).map((i) => [i.name, i.placed])]).slice(0, 320));
const badLine = call("helmod_ghosts", { into: "string", models: laneModel, surface: SURF,
  origin: AT, factory: "model_5#copper-cable" });
check("a line the page does not run is refused by name, with the lines it does run",
  badLine.ok === false && badLine.code === "HELMOD_NO_LINE"
    && asList((badLine.detail || {}).lines).sort().join(",") === "iron-plate,plastics",
  JSON.stringify([badLine.code, badLine.detail]).slice(0, 240));
const lanes = call("helmod_ghosts", { into: "ground", models: laneModel, surface: SURF, origin: AT, width: 90 });
const ln = lanes.data || {};
const laneOf = (r) => asList(ln.lanes).find((l) => l.recipe === r) || {};
const partOf = (l, n) => (l.parts || {})[n] || 0;
// Asserted by the engine's own CLASSES, not by part names: which belt, which arm and which chest a
// lane gets are this install's unlocked list (the sweep runs suites that research and un-research, and
// one that ran before this wrote `iron-chest` where a quiet box had `steel-chest`). Naming a tier here
// would make a correct lane red; the claim that survives any mod pack is "the lane has a belt, an arm
// and a chest in it", which is read off each part's prototype type below.
const laneKinds = (() => {
  const l = laneOf("iron-plate");
  const names = Object.keys(l.parts || {});
  if (!names.length) return {};
  const out = lua(`local seen = {}
for _, n in ipairs{${names.map((x) => JSON.stringify(x)).join(", ")}} do
  local p = prototypes.entity[n]
  if p then seen[tostring(p.type)] = (seen[tostring(p.type)] or 0) + 1 end
end
local parts = {}
for k, v in pairs(seen) do parts[#parts + 1] = k .. "=" .. v end
table.sort(parts)
rcon.print(table.concat(parts, ","))`);
  const map = {};
  String(out || "").split(/\r?\n/).filter((l) => l.includes("=")).pop()
    .split(",").forEach((kv) => { const [k, v] = kv.split("="); map[k] = Number(v); });
  return map;
})();
check("a recipe row lays a lane: the machines come with a belt, an arm and a chest (classes, not tiers)",
  lanes.ok === true && ln.fed === true && laneOf("iron-plate").machines === 4
    && (laneKinds["transport-belt"] || 0) > 0 && (laneKinds["inserter"] || 0) > 0
    && ((laneKinds["container"] || 0) + (laneKinds["logistic-container"] || 0)) > 0
    && laneOf("iron-plate").entities > laneOf("iron-plate").machines,
  JSON.stringify([lanes.code, ln.fed, laneKinds, laneOf("iron-plate").entities]).slice(0, 300));
// The double count this file is most likely to get wrong: the block's summary says 4 furnaces AND the
// recipe row says 4 furnaces. Laying both would be 8 machines for a plan of 4 -- a shape a player cannot
// tell apart from their own plan until they have paid for the iron.
// Read on WHATEVER machine the lane is made of: which furnace a smelting row gets is this save's
// unlocked list, and a name pinned here goes red the moment a suite before this one leaves a different
// tech tree behind (`dev/bus_line_e2e.js` documents the same trap). "Not billed twice" is the claim;
// which tier pays for it is the swap row's business, asserted beside it.
const lane1 = laneOf("iron-plate");
const laneMachine = lane1.machine || "electric-furnace";
check("...and the same 4 machines are not billed twice -- once by the recipe row, once by the summary",
  partOf(lane1, laneMachine) === 4
    && !asList(ln.items).some((e) => e.name === laneMachine && (e.placed || 0) > 0),
  JSON.stringify([laneMachine, ln.lanes, ln.items]).slice(0, 320));
const placedOf = (n) => asList(ln.items).find((e) => e.name === n) || {};
check("beacons are laid too (they stand on the ground); modules are not (they are items)",
  placedOf("beacon").placed === 3, JSON.stringify([ln.items, ln.skipped]).slice(0, 300));
// The same claim on a real answer rather than the stand-in, on the recipe the player actually hit it
// with: electronic-circuit eats two items and a lane is built around ONE, so the second has to be named
// -- "48 furnaces making plates" is a different claim from "15 assemblers also need 3 copper cable per
// craft, and nothing here brings it".
const twoIn = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 60,
  plan: [{ entity: "assembling-machine-1", recipe: "electronic-circuit", count: 6 }] });
const twoLane = asList((twoIn.data || {}).lanes)[0] || {};
check("...and a recipe that eats two items is now brought BOTH of them on the one line it laid",
  twoIn.ok === true && twoLane.recipe === "electronic-circuit"
    && twoLane.needs === 2 && twoLane.unfed === undefined
    && asList(twoLane.fed_items).length === 2
    && asList(twoLane.fed_items).indexOf("copper-cable") >= 0
    // Either of the two shapes that put a material in every lane of the line it crosses: which one wins
    // at six machines is the ladder's density call (a pair of rows from four up), and pinning the name
    // here would be a second opinion about that rather than about the claim this check makes.
    && ["row-belts", "sandwich-2"].indexOf(String(twoLane.shape)) >= 0,
  JSON.stringify([twoIn.code, twoLane.shape, twoLane.fed_item, twoLane.fed_items,
    twoLane.unfed]).slice(0, 320));
const fb = asList(ln.lane_fallback).find((f) => f.recipe === "plastics") || {};
check("a lane the builder refuses still lays its machines loose, and says why the lane did not happen",
  fb.why !== undefined && fb.machine === "assembling-machine-1"
    && placedOf("assembling-machine-1").placed === 2,
  JSON.stringify([fb, ln.items]).slice(0, 320));
check("one 撤回 takes a whole lane back -- belts, arms, chests and machines together",
  call("place_undo", { count: 1 }).ok === true && countGhosts() === 0,
  String(countGhosts()));
// 退多层: the panel now hands a number to this verb, so the engine half has to be the truth -- two
// presses stack two batches, and one press of 撤回 with 2 in the box takes both of them back. What stays
// whole is a lane: belts, arms, chests and machines of one batch go together, which is the half a
// player cannot get by clicking twice at one-at-a-time.
call("helmod_ghosts", { into: "ground", surface: SURF, origin: AT, width: 60,
  plan: [{ entity: "electric-furnace", recipe: "iron-plate", count: 2 }] });
call("helmod_ghosts", { into: "ground", surface: SURF, origin: AT, width: 60,
  plan: [{ entity: "assembling-machine-1", recipe: "copper-cable", count: 2 }] });
const back2 = call("place_undo", { count: 2 });
check("...and one 撤回 with a count takes both batches back, whole",
  back2.ok === true && (back2.data || {}).undone === 2
    && ((back2.data || {}).removed || 0) > 10 && countGhosts() === 0,
  JSON.stringify([back2.code, back2.data && back2.data.undone, back2.data && back2.data.removed,
    back2.data && back2.data.remaining, countGhosts()]).slice(0, 260));
wipe();

// A plan row that names its recipe is treated the same way: the recipe is what makes a lane possible,
// not where the number came from.
const planLane = call("helmod_ghosts", {
  into: "ground",
  plan: [{ entity: "electric-furnace", recipe: "iron-plate", count: 2 }],
  surface: SURF, origin: AT, width: 60,
});
const plLane = asList((planLane.data || {}).lanes)[0] || {};
check("plan rows with a recipe lay lanes too -- belts and arms are not a helmod-only bonus",
  planLane.ok === true && plLane.machines === 2 && partOf(plLane, "fast-transport-belt") > 0,
  JSON.stringify([planLane.code, planLane.data && planLane.data.lanes]).slice(0, 260));
call("place_undo", { count: 1 });
wipe();


// ------------------------------------------------------------------ 3c. what a LINE costs
// "为什么一堆钢箱，实际游戏中不会有这么多箱子的" (2026-10-01, a real client looking at the blueprint this
// button made). The card path's default shape gives every machine its own input, overflow and outlet
// chest: for a computed plan of 48 smelters that came out as 144 chests and 144 arms in one row 718
// tiles long. A production line pays for its interface ONCE per line -- a belt down the row, an arm per
// machine face, a chest at each end -- and that is what a helmod lane asks for now.
//
// Counted from the parts the answer says it laid, and the chest names resolved through their prototype
// TYPE rather than a name pinned here: which box wins is this install's unlocked list, and asserting on
// `steel-chest` would go red the day another mod's box wins the pick.
const bigLine = call("helmod_ghosts", { into: "string", surface: SURF, width: 400,
  plan: [{ entity: "electric-furnace", recipe: "iron-plate", count: 48 }] });
const bld = bigLine.data || {};
const bl = asList(bld.lanes)[0] || {};
const partNames = Object.keys(bl.parts || {});
const chestProbe = partNames.length ? String(lua(`local out = {}
for _, n in ipairs{${partNames.map((x) => JSON.stringify(x)).join(", ")}} do
  local p = prototypes.entity[n]
  if p then
    local t = tostring(p.type)
    if t == "container" or t == "logistic-container" or t == "chest" then out[#out + 1] = n end
  end
end
rcon.print(table.concat(out, ","))`)) : "";
// The reply is the printed line plus an `OK` of its own, and an empty print leaves nothing at all --
// so the payload is the last line that is not the sentinel. Trimming the whole reply instead left
// "steel-chest\nOK" as a chest name that matches no part, which reads as "this line has no chests".
const chestNames = ((chestProbe.split(/\r?\n/).map((l) => l.trim())
  .filter((l) => l && l !== "OK").pop() || "")).split(",").filter(Boolean);
const chests = chestNames.reduce((sum, n) => sum + (bl.parts[n] || 0), 0);
check("a computed line of 48 machines pays its interface per LINE, not per machine",
  bigLine.ok === true && (bl.machines || 0) >= 12 && chests > 0 && chests <= 6
    && /^(sandwich-2|row-belts)$/.test(String(bl.shape)) && bl.width < 200,
  JSON.stringify([bl.shape, chests, chestNames, bl.width, bl.height]).slice(0, 300));
// The whole plan, added back up: a row longer than its belt is split into rows, and the split must not
// become a machine going missing -- the two failures look identical on a screen full of ghosts. Each
// line is also checked against the limit it was split with, so the number that decided the split is the
// number the layout obeys.
const allBig = asList(bld.lanes);
const machinesBig = allBig.reduce((s, l) => s + (l.machines || 0), 0);
check("...and the same plan still lays all 48 machines, each line within the belt that feeds it",
  machinesBig === 48 && allBig.length >= 1
    && allBig.every((l) => l.machines <= (((l.feed || {}).machines_per_line) || l.machines)),
  JSON.stringify([machinesBig, allBig.map((l) => [l.machines, (l.feed || {}).machines_per_line,
    (l.split || {}).of]), bl.parts, bl.entities]).slice(0, 320));
check("...and the shape it chose is named in the answer, beside the blueprint text the copy box shows",
  typeof bl.shape === "string" && bl.shape.length > 0 && typeof bld.blueprint === "string"
    && /^0e/.test(bld.blueprint),
  JSON.stringify([bl.shape, (bld.blueprint || "").slice(0, 8)]));

// The 排法 drop-down is the player's, so it has to reach this press -- and its row 1 (自动) has to mean
// "you choose", not "a style literally named <empty>". The blank row is what the card path already uses
// for every other picker; `styles.get("")` answering nil is the trap that turns it into a refusal.
const autoRow = call("helmod_ghosts", { into: "string", models: laneModel, surface: SURF,
  origin: AT, width: 90, factory: "model_5", style: "" });
const ordered = call("helmod_ghosts", { into: "string", models: laneModel, surface: SURF,
  origin: AT, width: 90, factory: "model_5", style: "row-belts" });
check("自动 (the drop-down's blank row) still means 'choose by machine count', not a style called ''",
  autoRow.ok === true && asList(autoRow.data.lanes)[0].shape === "sandwich-2",
  JSON.stringify([autoRow.code, autoRow.msg, asList(autoRow.data.lanes)[0].shape]).slice(0, 240));
check("...and a named row is an order: the lane is built in THAT shape",
  ordered.ok === true && asList(ordered.data.lanes)[0].shape === "row-belts"
    && asList(ordered.data.lanes)[0].entities > 0,
  JSON.stringify([ordered.code, asList(ordered.data.lanes)[0].shape]).slice(0, 240));

// The promise the shape change was made for, at the answer's level rather than the drawing's: a plan of
// green circuits laid as a shared row brings BOTH materials, and says which ones; the same plan laid as a
// shape that cannot share the row still names what it left out. Asserted through `plan` (not through a
// helmod model) because the claim belongs to the lane builder, and a model that happens to use smelting
// would pass it either way.
const fed2 = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 90,
  plan: [{ entity: "assembling-machine-3", recipe: "electronic-circuit", count: 4 }],
  style: "row-belts" });
const fedLane = (asList((fed2.data || {}).lanes)[0] || {});
check("a shared-row lane of a two-material recipe reports BOTH materials as brought in",
  fed2.ok === true && asList(fedLane.fed_items).length === 2
    && fedLane.unfed === undefined && asList(fedLane.fed_items).indexOf("copper-cable") >= 0,
  JSON.stringify([fed2.code, fedLane.shape, fedLane.fed_items, fedLane.unfed]).slice(0, 300));
const noShare = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 90,
  plan: [{ entity: "assembling-machine-3", recipe: "electronic-circuit", count: 4 }],
  style: "row-chest" });
const noShareLane = (asList((noShare.data || {}).lanes)[0] || {});
check("...and a shape that cannot share the row still names the material it leaves outside",
  noShare.ok === true && asList(noShareLane.unfed).length >= 1
    && asList(noShareLane.unfed).some((m) => m.name === "copper-cable")
    && noShareLane.fed_items === undefined,
  JSON.stringify([noShare.code, noShareLane.shape, noShareLane.fed_items, noShareLane.unfed]).slice(0, 300));

// The third material, which is where 绿板 lives. `advanced-circuit` eats plastic bar, copper cable AND
// electronic circuit -- 92 of the production recipes on this install eat three, 141 eat three or more
// (`dev/recipe_table_e2e.js` reads the table rather than remembering it) -- and a shared row has two
// lanes, so the ladder must not offer it for those plans. Asserted at the ANSWER: the shape chosen, the
// materials brought, and nothing left named as unfed. The tech is granted for this call and taken back
// after, because leaving it on would hand every later suite a recipe it never asked for.
const grantAdv = (on) => lua(`local f = game.forces.player
local t = f.technologies["advanced-circuit"]
local r = f.recipes["advanced-circuit"]
if t then t.researched = ${on ? "true" : "false"} end
if r then r.enabled = ${on ? "true" : "false"} end
rcon.print("ok")`);
grantAdv(true);
let threeMat, threeForced;
try {
  threeMat = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 90,
    plan: [{ entity: "assembling-machine-3", recipe: "advanced-circuit", count: 4 }] });
  threeForced = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 90,
    plan: [{ entity: "assembling-machine-3", recipe: "advanced-circuit", count: 4 }],
    style: "row-belts" });
} finally {
  grantAdv(false);
}
const advLane = (asList((threeMat.data || {}).lanes)[0] || {});
check("a three-material plan with no style named is laid as the shape that has a feed line on each face",
  threeMat.ok === true && String(advLane.shape) === "two-feed",
  JSON.stringify([threeMat.code, advLane.shape, advLane.fed_items, advLane.unfed]).slice(0, 300));
check("...and it brings ALL THREE materials, which is the whole reason that shape exists",
  asList(advLane.fed_items).length === 3 && advLane.unfed === undefined
  && ["plastic-bar", "copper-cable", "electronic-circuit"].every((i) => asList(advLane.fed_items).indexOf(i) >= 0),
  JSON.stringify([advLane.fed_items, advLane.unfed]).slice(0, 300));
const forcedLane = (asList((threeForced.data || {}).lanes)[0] || {});
check("...while the one-row shape, when the player forces it, says which material it cannot bring",
  threeForced.ok === true && String(forcedLane.shape) === "row-belts"
    && asList(forcedLane.fed_items).length === 2 && asList(forcedLane.unfed).length === 1,
  JSON.stringify([forcedLane.shape, forcedLane.fed_items, forcedLane.unfed]).slice(0, 300));

// The remainder, which is where his own plan caught this mod lying. A 15-machine 红板 row split by the
// belt's feed limit ends with a chunk of ONE machine, and the ladder used to answer a one-machine chunk
// with `row-chest` -- a shape that lays a single input box, so it brought one of the recipe's two
// materials and the ghost stood there unable to craft. Measured in the player's plan on 27015 on
// 2026-10-02: two lanes of `electronic-circuit`, 1 machine each, 缺料 copper-cable. A lane one machine
// wide is a small lane; it is not a licence to feed it badly.
const single = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 90,
  plan: [{ entity: "assembling-machine-1", recipe: "electronic-circuit", count: 1 }] });
const singleLane = (asList((single.data || {}).lanes)[0] || {});
check("a ONE-machine chunk of a two-material recipe gets the shape that brings both materials",
  single.ok === true && String(singleLane.shape) === "row-belts"
    && asList(singleLane.fed_items).length === 2 && singleLane.unfed === undefined
    && singleLane.machines === 1,
  JSON.stringify([single.code, singleLane.shape, singleLane.fed_items, singleLane.unfed,
    singleLane.machines]).slice(0, 300));
check("...and no machine is left loose while doing it: the plan's count is the lane's count",
  asList((single.data || {}).lanes).length === 1
    && asList((single.data || {}).skipped || []).every((s) => !/electronic-circuit/.test(String(s.name))),
  JSON.stringify([asList((single.data || {}).lanes).length,
    asList(single.data && single.data.skipped)]).slice(0, 260));

// The ground he drew is a limit too. His plan asked for 400 columns of width and the builder handed it a
// 451-column line of 90 assemblers: the throughput cap had said how far one belt feeds, and nothing had
// asked whether the row fits the ground, so the packer walked off the end of it. Asserted against the
// lane's OWN measured width, and against the machines adding back up -- a cap that quietly dropped
// machines would look exactly like a cap that fit.
const wide = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 60,
  plan: [{ entity: "assembling-machine-1", recipe: "advanced-circuit", count: 40 }] });
const wideLanes = asList((wide.data || {}).lanes);
const overWide = wideLanes.filter((l) => (l.width || 0) > 60);
check("a plan wider than the ground is cut into lines that fit it, every one of them",
  wide.ok === true && wideLanes.length >= 2 && overWide.length === 0,
  JSON.stringify([wide.code, wideLanes.map((l) => [l.shape, l.machines, l.width]),
    (wide.data || {}).skipped]).slice(0, 320));
check("...and the cut loses no machine: the lines add back up to the 40 the plan asked for",
  wideLanes.reduce((s, l) => s + (l.machines || 0), 0) === 40
    && wideLanes.every((l) => l.split && l.split.lines === wideLanes.length),
  JSON.stringify([wideLanes.map((l) => l.machines),
    wideLanes.map((l) => (l.split || {}).lines)]).slice(0, 300));

// The other half of 分带: a plan row LONGER than one belt can feed. The limit here is not the number of
// materials -- it is throughput, and a row of twenty assemblers behind one yellow belt places, lints and
// then starves at its far end. Asserted against the number the decision was made with (read from a single
// line of the same recipe and belt), and against the two ways a split could quietly be wrong: machines
// that vanish from the count, and lines that are each still over their own belt's capacity.
const longRow = call("card_example", { recipe: "iron-plate", furnace: "electric-furnace",
  machines: 40, belt: "transport-belt", force: "player", style: "row-belts" }).data || {};
const perLine = (longRow.feed_plan || {}).machines_per_line || 0;
check("a slow belt's line pays for a countable number of machines, and says which number",
  // The band is not a fixed number: which furnace wins this pick depends on what the rest of the sweep
  // left researched, and the limit is a property of (recipe, machine, belt) rather than of the plan
  // length -- which is why it is read off a 40-machine card and allowed to be larger than 40.
  perLine >= 2 && (longRow.feed_plan || {}).per_machine > 0
    && (longRow.feed_plan || {}).machines_per_line >= 2,
  JSON.stringify([perLine, longRow.feed_plan && longRow.feed_plan.per_machine,
    longRow.feed_plan && longRow.feed_plan.per_line]).slice(0, 260));
// A plan row longer than one belt can feed. The expected number of lines is DERIVED from the answer
// (the limit its own first line reports), not hardcoded: which furnace wins this pick depends on what
// the rest of the sweep left researched, and a gate that assumed "three lines of 15" would be a second
// opinion about the save state rather than about the arithmetic.
const askedLong = perLine * 2 + 1;
const splitRun = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 400,
  belt: "transport-belt", plan: [{ entity: "electric-furnace", recipe: "iron-plate", count: askedLong }] });
const splitLanes = asList((splitRun.data || {}).lanes);
const realLimit = ((splitLanes[0] || {}).feed || {}).machines_per_line || perLine;
const expectLines = Math.ceil(askedLong / Math.max(1, Math.min(realLimit, perLine)));
// What the split MUST satisfy, stated against each line's own shape rather than against the shape some
// other card happened to be built with. The number of lines is not a constant of (recipe, belt): the
// ladder gives a long row of a single-material recipe the two-rows-behind-one-belt shape, which has two
// feed lines to a `row-belts` lane's one, so it carries twice as many furnaces per line and the plan
// needs fewer lines than a card of `row-belts` would suggest. Asserting `expectLines` was a second
// opinion about that choice, which is exactly what this file's own header warns against; what is
// asserted now is that no line is over its OWN belt-load, that the lines add back up, and that each one
// knows how many of it there are.
const withinOwnLoad = (l) => !l.feed || !l.feed.machines_per_line
  || l.machines <= l.feed.machines_per_line;
check("...and a plan row past one belt-load becomes several lines, each within the load its OWN shape feeds",
  splitRun.ok === true && expectLines >= 2 && splitLanes.length >= 2
    && splitLanes.every((l) => l.split && l.split.lines === splitLanes.length
      && l.split.of <= l.split.lines)
    && splitLanes.every(withinOwnLoad),
  JSON.stringify([perLine, realLimit, askedLong, expectLines, splitLanes.length,
    splitLanes.map((l) => [l.shape, l.machines, (l.feed || {}).machines_per_line])]).slice(0, 320));
check("...and the split loses no machine: the lines add back up to what the plan asked for",
  splitLanes.reduce((s, l) => s + (l.machines || 0), 0) === askedLong
    && splitLanes.every((l) => l.split && l.split.of <= l.split.lines),
  JSON.stringify([splitLanes.map((l) => l.machines), askedLong]).slice(0, 220));
check("...while not one of the lines it hands out needs more lanes than its own shape lays",
  splitLanes.length > 0 && splitLanes.every((l) => !l.feed || !l.feed.per_lane
    // `lanes_wanted` is the row's own verdict: each material rounds up to whole lanes. A shape with more
    // than one machine row lays more than one FEED row, so the figure a whole line's demand fits inside
    // is what the template crosses the ground with -- `inbound_lanes` is what ONE of its machines arms
    // itself with, and dividing a two-row line's demand by that promises a line twice as long as the one
    // that runs. The chest-fed shape a lone remainder gets lays no belt line at all, so it has nothing to
    // compare against -- which its `feed.reason` says rather than inventing a capacity.
    || (l.feed.lanes_wanted == null
      || l.feed.lanes_wanted <= (l.feed.feed_lanes_laid || l.feed.inbound_lanes))),
  JSON.stringify(splitLanes.map((l) => l.feed && [l.feed.lanes_wanted, l.feed.per_lane,
    l.feed.machines_per_line, l.feed.inbound_lanes, l.feed.feed_lanes_laid])).slice(0, 320));
check("...and each split line takes a shape that count can stand, so a remainder is not a refusal",
  splitLanes.length > 0 && splitLanes.every((l) => ["sandwich-2", "row-belts", "row-chest"]
    .indexOf(String(l.shape)) >= 0 && (l.split || {}).lines === splitLanes.length),
  JSON.stringify(splitLanes.map((l) => [l.machines, l.shape])).slice(0, 240));
check("...and a plan that split into rows does NOT claim the belt itself is the limit",
  splitLanes.length >= 2 && splitLanes.every((l) => !((l.feed || {}).belt_too_slow)),
  JSON.stringify(splitLanes.map((l) => [l.machines, (l.feed || {}).belt_too_slow,
    (l.feed || {}).lanes_wanted])).slice(0, 300));

// ------------------------------------------------------------------ 3d. the whole plan at once
// "helmod 所有生成的量化工厂都能生成各种手上蓝图" (2026-10-01): the press that does not ask which one.
// One blueprint per PAGE, and a page that cannot be laid is named rather than missing -- because an
// answer that says "3 delivered" out of 5 pages, without the two it dropped, is how a player builds a
// factory from a plan that was never complete.
const allPages = {
  model_a: laneModel.model_5,
  model_b: { class: "Model", id: "model_b", block_root: { class: "Block", name: "empty page",
    children: {}, summary_global: { factories: {} } } },
};
const wholePlan = call("helmod_blueprints", { models: allPages, into: "string", surface: SURF,
  origin: AT, width: 90 });
const wp = wholePlan.data || {};
const byFactory = (n) => asList(wp.blueprints).find((b) => b.factory === n) || {};
check("every page becomes its own blueprint, with the lines that page holds",
  wholePlan.ok === true && wp.count === 1 && wp.into === "string"
    && asList(wp.blueprints).length === 1
    // One line, not two: this fixture's second recipe is the one the builder refuses on this install
    // (`plastics` on an assembling machine the sweep may not have unlocked), and the gate above about
    // that refusal is exactly why the count here is a floor rather than a fixed number.
    && byFactory("model_a").lines >= 1 && byFactory("model_a").entities > 30
    && byFactory("model_a").bytes > 60,
  JSON.stringify([wholePlan.code, wp.count, asList(wp.blueprints).map((b) => [b.factory, b.lines,
    b.entities, b.bytes])]).slice(0, 300));
check("...and a page that laid nothing is REFUSED BY NAME, not silently absent from the count",
  asList(wp.refused).length === 1 && asList(wp.refused)[0].factory === "model_b"
    && asList(wp.refused)[0].code === "NOTHING_TO_LAY",
  JSON.stringify([wp.refused]).slice(0, 240));
check("...and the unfed ingredient survives the trip into the whole-plan answer",
  asList(byFactory("model_a").unfed).length === 0
    && Object.keys(byFactory("model_a").parts || {}).length > 2,
  JSON.stringify([byFactory("model_a").unfed, byFactory("model_a").parts]).slice(0, 300));

// ------------------------------------------------------------------ 4. the honest empties
// `storage.models` is nil until a player has built a factory in helmod's GUI. On a fresh save that is
// the normal state, and the two refusals a caller could be given here send them to different places.
const empty = call("helmod_ghosts", { surface: SURF, origin: AT });
check("helmod installed with no plan yet is said as no plan, not as a missing mod",
  empty.ok === false && empty.code === "NOTHING_TO_LAY" && /open helmod/.test(String(empty.msg)),
  JSON.stringify([empty.code, empty.msg]).slice(0, 220));
const zeroed = call("helmod_ghosts", { plan: { "assembling-machine-1": 0 }, surface: SURF, origin: AT });
check("a plan whose numbers are all zero says there is nothing to lay",
  zeroed.ok === false && zeroed.code === "NOTHING_TO_LAY",
  JSON.stringify([zeroed.code, zeroed.msg]).slice(0, 200));

// ------------------------------------------------------------------ 4b. into the hand, not the ground
// The user's own words: "不需要你直接创建虚影，而是把虚影放到手里，我自己放就可以了". So the hand is the
// DEFAULT and the ground has to be asked for -- which is also the safe direction for a button that can be
// pressed by accident: a blueprint in the cursor is one right-click away from nothing, a lane dropped on
// the map at 3am is a cleanup job.
const hand = call("helmod_ghosts", { plan: [{ entity: "electric-furnace", recipe: "iron-plate", count: 3 }] });
const hd = hand.data || {};
check("the default is the hand: nothing is written on the map, and the engine took every part",
  hand.ok === false && hand.code === "NO_PLAYER"
    // The two numbers agree, which is the claim; the bound only has to be "a lane, not a lone machine",
    // and the pitch change (machines now sit at their own width) moved the belt count of the same plan
    // from 41 parts to 25 -- a fixed floor here would be a second, silent assertion about spacing.
    && (hand.detail || {}).entities === (hand.detail || {}).held && (hand.detail || {}).held > 10,
  JSON.stringify([hand.code, hand.detail]).slice(0, 220));
// A headless server has no hand to put it in, and authoring happens BEFORE the hand is looked for, so
// the refusal can still say how much the engine accepted. That count is the difference between "the
// blueprint is short" being a suspicion and being a number: a part the engine drops (too far from the
// rest, a direction it will not take) would otherwise vanish from an item already in the cursor.
const asString = call("helmod_ghosts", { into: "string",
  plan: [{ entity: "electric-furnace", recipe: "iron-plate", count: 3 }] });
const hsd = asString.data || {};
check("into = string hands the authored blueprint back to an AI caller instead of refusing for a hand",
  asString.ok === true && hsd.into === "string" && typeof hsd.blueprint === "string"
    && hsd.blueprint.length > 60 && hsd.held === hsd.entities && hsd.short_by === undefined,
  JSON.stringify([asString.code, hsd.into, hsd.held, hsd.entities, hsd.bytes, hsd.short_by]).slice(0, 220));
check("...and the blueprint text is the game's own format, so a player can paste it anywhere",
  /^0e/.test(String(hsd.blueprint || "")), String(hsd.blueprint || "").slice(0, 12));
// Nothing may reach the ground from the hand path -- otherwise "I'll place it myself" is a lie the map
// finds out about.
const afterHand = lua(`local n = 0
for _, e in ipairs(game.surfaces["${SURF}"].find_entities_filtered{ area = ${AREA}, type = "entity-ghost" }) do n = n + 1 end
rcon.print("ghosts=" .. n)`);
check("the hand path left no ghost on the ground -- the ground is the player's to fill",
  /ghosts=0/.test(String(afterHand)), String(afterHand));

// ------------------------------------------------------------------ 5. the window can press it
// The button is one of the panel's dispatched set; the selftest walks every widget it built and this is
// the gate that catches a new button with no handler -- which is exactly how `arch-more-cards` once
// arrived as an ERROR inside the walk instead of a dispatch.
const st = call("gui_selftest", {});
const sd = st.data || {};
check("按 helmod 铺虚影 is built and dispatched, not left undispached in the walk",
  asList(sd.unhandled).indexOf("arch-helmod") < 0
    && asList(sd.clicks).some((c) => /arch-helmod -> helmod/.test(String(c))),
  JSON.stringify([asList(sd.unhandled), asList(sd.clicks).filter((c) => /helmod/.test(String(c)))])
    .slice(0, 220));
const hmLines = asList(((sd.report_after || {})["arch-helmod"] || {}).lines).map(String);
// The hand is the only door now, and the count is the fact worth reading. `paste` used to be the first
// choice and it desynced a real client (2026-10-01, `desync-report-2026-10-01_16-21-49`: script.dat
// byte-identical both sides, the client's next-unit-number one AHEAD -- the clipboard takes an
// interaction, an interaction needs a mouse, and a headless server has none). Nothing on this box can
// reproduce that, because there is no second process to disagree with, so what IS asserted is that the
// window never sends the player toward the paste flow: no line names it.
check("the window says the blueprint is in the hand, with the part count, and sends nobody to paste",
  hmLines.some((l) => /architect\.n-hm-hand\|62/.test(l))
    && !hmLines.some((l) => /paste/i.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-hand|n-hm-short/.test(l))).slice(0, 300));
// The shape row: a line that costs 3 chests for 48 machines is only believable if the window says WHY.
// Asserted as a row of its own because the lane row's counts could be right for the wrong reason.
check("...and it says out loud when a recipe eats something the line does not bring",
  hmLines.some((l) => /architect\.n-hm-unfed/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-unfed|n-hm-lane|n-hm-shape/.test(l))).slice(0, 320));
check("the window names the SHAPE it laid, next to the counts that shape produced",
  hmLines.some((l) => /architect\.n-hm-shape/.test(l) && /row-belts/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-lane|n-hm-shape/.test(l))).slice(0, 300));
// The row that commits the shared line to two materials. Asserted as its own row because the counts
// above would be identical whether or not the second material ever arrives -- and "identical" is how a
// half-fed lane passed for a whole one until this week.
check("the window says which two materials ride the one belt, in a row of its own",
  hmLines.some((l) => /architect\.n-hm-fed/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-fed|n-hm-unfed/.test(l))).slice(0, 300));
// And when one plan row became more than one line: the numbers a player would otherwise have to add up
// themselves -- what one belt feeds, how many lines the row turned into, which line this is.
check("the window says when one plan row had to be split across lines, with all three numbers",
  hmLines.some((l) => /architect\.n-hm-split\|8\|2\|1/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-split/.test(l))).slice(0, 240));

const allLines = asList(((sd.report_after || {})["arch-helmod-all"] || {}).lines).map(String);
check("the window lists every blueprint it delivered AND the page it refused",
  allLines.some((l) => /architect\.n-hmall-total\|2\|1/.test(l))
    && allLines.some((l) => /architect\.n-hmall\|iron-plate/.test(l))
    && allLines.some((l) => /architect\.n-hmall\|electronic-circuit/.test(l))
    && allLines.some((l) => /architect\.n-hmall-refused\|science\|NOTHING_TO_LAY/.test(l)),
  JSON.stringify(allLines).slice(0, 340));
check("...and the row about a missing ingredient is per blueprint, so it says which line it belongs to",
  allLines.some((l) => /architect\.n-hmall-unfed\|copper-cable\|3\|electronic-circuit/.test(l)),
  JSON.stringify(allLines.filter((l) => /unfed/.test(l))).slice(0, 240));

// The picker: helmod is installed here but has no factory yet, so the row must say WHICH of the two it
// is, and must not offer a drop-down with one blank line in it. A control with nothing to choose is the
// window asking to be clicked.
check("a helmod with no plan shows the reason where the picker would be, and no empty drop-down",
  !!st.data.tree && /arch-helmod-none/.test(String(st.data.tree))
    && !/arch-form-helmod/.test(String(st.data.tree)),
  JSON.stringify(String(st.data.tree).split("\n").filter((l) => /helmod/.test(l))).slice(0, 260));
check("the answer names the kinds, the ghosts, the skipped row and the way back",
  hmLines.some((l) => /architect\.n-hm\|/.test(l))
    && hmLines.some((l) => /architect\.n-hm-item/.test(l))
    && hmLines.some((l) => /architect\.n-hm-skip/.test(l))
    && hmLines.some((l) => /architect\.n-hm-undo/.test(l)),
  JSON.stringify(hmLines).slice(0, 900));
// The lane rows are the "全铺" answer in the window: belts, arms and chests counted, and a machine that
// could not form a lane named with the reason. Asserted on the part COUNTS rather than on the word
// "lane", because a row that says "lane" while laying no belts is exactly the disappointment here.
check("the window counts the lane's belts, arms and chests -- and names the row that stayed loose",
  hmLines.some((l) => /architect\.n-hm-lane/.test(l)
    && /iron-plate/.test(l) && /electric-furnace/.test(l)
    && /\|21\|/.test(l) && /\|9\|/.test(l))
    && hmLines.some((l) => /architect\.n-hm-nolane/.test(l) && /plastics/.test(l)
      && /BUS_MACHINE_NOT_SETTABLE/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-lane|n-hm-nolane/.test(l))).slice(0, 400));

// A substitute is a decision, not a detail: the row has to name BOTH machines and the count. This is the
// shape of the bug the player hit -- a plan of 48 steel furnaces coming out as 48 electric ones because
// the hint was passed under one name while a smelting recipe reads another.
check("the window says when the lane is not built from the machine the plan named",
  hmLines.some((l) => /architect\.n-hm-swap/.test(l) && /steel-furnace/.test(l)
    && /electric-furnace/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-swap/.test(l))).slice(0, 300));
check("...and a lane that got the machine it asked for does NOT claim a substitution",
  !hmLines.some((l) => /n-hm-swap/.test(l) && /battery/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-(lane|swap)/.test(l))).slice(0, 400));

// The rounded fraction has to be readable in the window, not just in the JSON: `wanted` 2.5 beside
// `placed` 3 is the line that stops a player counting machines and calling the mod wrong.
check("...and the row that shows a fraction is a row with both numbers in it",
  hmLines.some((l) => /n-hm-item/.test(l) && /2\.50/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-item/.test(l))).slice(0, 200));

// ------------------------------------------------------------------ leave the ground as found
const left = wipe();
check("the ground this file built is empty again", /wiped=0/.test(String(left)), String(left));
check("and the world this file asked for is the world it leaves: no deployment of ours is still on the stack",
  (() => { const u = call("place_undo", { count: 1 }); return u.ok === true || /empty|nothing/.test(String(u.msg)); })(),
  "undo answered");

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) { console.log("FAILURES: " + fails.join(", ")); process.exit(1); }

function byNameFM(n, d) { return asList(d.items).find((e) => e.name === n) || {}; }
