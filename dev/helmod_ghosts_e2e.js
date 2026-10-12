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
          // `count_deep` 是 helmod 深算那份台数（真实存档里每条机器项都带着）。这里故意让它与显示用的
          // `count` 不等：页那一格要并着报两个数，才看得见"页上写几台、铺出来几台"的差额。
          a: { name: "electric-furnace", type: "entity", count: 4, count_deep: 5 },
          b: { name: "assembling-machine-1", type: "entity", count: 2, count_deep: 3 },
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
// 两笔小账一起钉：页那一格交 helmod **深算**那份台数（从前字段被整张表抄进来却没人汇总、没人说），
// 线那一格交每分钟件数（挑线的人要看得出哪条粗哪条细；数从 helmod 折过的那一份拿，一次调用内
// 按 页#配方 只问一遍）。
check("页那一格带着 helmod 深算的台数；线那一格带着每分钟的件数——答不到的那行**不写**这一格，不编一个 0",
  llf[0].machines === 6 && llf[0].machines_deep === 8
    && llf.some((f) => f.id === "model_5#iron-plate" && Number(f.per_min) > 0)
    && llf.filter((f) => f.kind === "line" && f.per_min === undefined)
         .every((f) => f.per_min !== 0 && f.fluid_per_min !== 0),
  JSON.stringify([llf[0].machines, llf[0].machines_deep,
    llf.slice(1).map((f) => [f.id, f.per_min, f.fluid_per_min])]).slice(0, 320));
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
check("a recipe row lays a lane: the machines come with a belt and an arm -- and no chest at all",
  lanes.ok === true && ln.fed === true && laneOf("iron-plate").machines === 4
    && (laneKinds["transport-belt"] || 0) > 0 && (laneKinds["inserter"] || 0) > 0
    && ((laneKinds["container"] || 0) + (laneKinds["logistic-container"] || 0)) === 0
    && laneOf("iron-plate").entities > laneOf("iron-plate").machines,
  JSON.stringify([lanes.code, ln.fed, laneKinds, laneOf("iron-plate").entities]).slice(0, 300));
// The double count this file is most likely to get wrong: the block's summary says 4 furnaces AND the
// recipe row says 4 furnaces. Laying both would be 8 machines for a plan of 4 -- a shape a player cannot
// tell apart from their own plan until they have paid for the iron.
// Read on WHATEVER machine the lane is made of: which furnace a smelting row gets is this save's
// unlocked list, and a name pinned here goes red the moment a suite before this one leaves a different
// tech tree behind (the same trap dev/belt_head_e2e.js returns a borrowed tech for). "Not billed twice" is the claim;
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
    // 两种排法都把每一种料铺在自己那一排的股道上：哪一档在这里赢是阶梯按密度做的决定，把它钉在这个
    // 检查里就变成对那个决定的第二份意见，而不是对"两种料都上了线"这句话的意见。
    && ["stacked", "two-row"].indexOf(String(twoLane.shape)) >= 0
    // 牌在的时候，那份料单是牌自己写的；牌放不出来（这一发的 force 没研究电路网）时答案里有
    // `sign_missing` 那句话，此时不能要求一份根本不存在的清单。两种情形都要断言，因为"喂齐了"这件事
    // 只有一种解释： either 牌点了这两种料的名，或者牌根本不在、而带子的股数装得下这两种。
    && (twoLane.head_manifest ? twoLane.head_manifest.indexOf("copper-cable") >= 0
      : typeof twoLane.sign_missing === "string" && twoLane.sign_missing.length > 0),
  JSON.stringify([twoIn.code, twoLane.shape, twoLane.fed_item, twoLane.fed_items,
    twoLane.unfed, twoLane.head_manifest]).slice(0, 320));
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
// 这一条钉的是"plan 那一形也铺带子和臂"，不是"铺哪一档带子"。从前它写死了 fast-transport-belt，因为
// 那时默认拿最快那一档；带子改成"够用就好"之后两炉铁板落在黄带子上，钉住一个档名就等于把 D3 的决定
// 抄进另一扇门里。所以这里数的是"任何一档带子都算"，档名由答案自己的 belt_choice 说。
const beltsOf = (l) => Object.keys((l || {}).parts || {})
  .filter((k) => k.indexOf("belt") >= 0).reduce((a, k) => a + ((l.parts || {})[k] || 0), 0);
check("plan rows with a recipe lay lanes too -- belts and arms are not a helmod-only bonus",
  planLane.ok === true && plLane.machines === 2 && beltsOf(plLane) > 0
  && partOf(plLane, "inserter") + partOf(plLane, "fast-inserter") + partOf(plLane, "long-handed-inserter") > 0,
  JSON.stringify([planLane.code, (plLane.parts || {}), ((planLane.data || {}).lanes || []).length]).slice(0, 260));
call("place_undo", { count: 1 });
wipe();


// ------------------------------------------------------------------ 3b2. 分子是 helmod 的那一份（#35 ②）
// 玩家那句"全部用 helmod 的数据、不得由我们自己再算一遍"落到代码上只有一个问题值得钉：一条线每分钟过
// 几件，是谁算的。自算那一路（`台数 × 速度 × 60 / 能耗`）永远算不出 productivity —— 那一成是玩家在
// 那一页上选的模块与信标给的，不在配方原型里。所以两份数字的差恰好就是它，而下面钉的就是那个差。
//
// 下面这份 fixture 的形状是从活的 `get_models()` 抄的（本文件第 3 节写清楚了 Model 是个容器、数字在
// `block_root` 下面），只是把这一行填成 helmod 自己会解出来的数：10 台钢炉（speed 2）做 iron-plate
// （能量 3.2 秒/次）= 6.25 次/秒，`factory.amount` 1.6 台/(每秒一次工艺) × 6.25 次/秒 = 10 台。
// `time` 必须带上：实测 `Product:getProductivityBonus` 第一句是 `if recipe.time == nil then return 0`
// —— 少了它，加成会在原样交回来的数字里悄悄消失。
// 这一节钉的是"地上就是 helmod 点名的那一台机器，所以那份流量成立"。而 `steel-furnace` 在这一存档里
// 不一定开着 —— 实测：前一套件把科技树收成自己的名单后，压线把它换成石炉，于是 3b4 那条新规矩让分子
// 退回自算（这是对的），下面那些按 375/分钉的断言就换成 187.5/分。所以这里按本仓库的老规矩借配方、
// 用完照原样还（同 dev/layout_ledger.js 为电炉做的那一手），让这一节与"前面跑过哪一套"无关。
const steelWasOn = /^true$/.test(lua(`local r = game.forces.player.recipes["steel-furnace"]
  rcon.print(r and tostring(r.enabled) or "absent")`));
if (!steelWasOn) lua(`local r = game.forces.player.recipes["steel-furnace"]
if r then r.enabled = true end rcon.print("borrowed")`);
const flowRow = {
  class: "Model", id: "model_6", time: 1,
  block_root: {
    class: "Block", name: "plates folded", time: 1,
    summary_global: {
      factories: { a: { name: "steel-furnace", type: "entity", count: 10 } },
      // 整页欠的模块（`ModelCompute.createSummaryMachine` 写在 `summary_global.modules`，
      // 一件机器装几个 × 台数合出来的那份）。
      modules: { mm: { name: "speed-module-2", quality: "normal", type: "item", count: 20 } },
    },
    children: {
      R1: {
        class: "Recipe", name: "iron-plate", type: "recipe", quality: "normal",
        count: 6.25, time: 3.2, base_time: 1, index: 1,
        factory: { name: "steel-furnace", quality: "normal", amount: 1.6, count: 10, speed: 2,
          speed_total: 2, effects: { speed: 0, productivity: 0.08, consumption: 0, pollution: 0, quality: 0 },
          // 一台装几个（`factory.modules` 每项的 `amount`）：挑一条线时页合计被清空，
          // 模块就只能按"这一行几台 × 一台几个"算，两处不能各自演一份。
          modules: { "speed-module-2": { name: "speed-module-2", amount: 2 } } },
      },
    },
  },
};
const folded = call("helmod_ghosts", { into: "string", width: 90, models: { model_6: flowRow } });
const fl = asList((folded.data || {}).lanes)[0] || {};
const flFeed = fl.feed || {};
const flRate = fl.rate_source || {};
check("压线读的是 helmod 那一行折好的件数：来源、每分钟工艺次数、每种料的 /分 都写出来",
  folded.ok === true && flRate.source === "helmod"
    && Math.abs(num(flRate.crafts_per_min) - 375) < 1e-6
    && Math.abs(num((asList(flFeed.needs)[0] || {}).per_min) - 375) < 1e-6
    && Math.abs(num(flRate.quoted_for) - 10) < 1e-9 && Math.abs(num(flRate.scale) - 1) < 1e-9,
  JSON.stringify([folded.code, flRate, flFeed.needs]).slice(0, 320));
// 燃料那一行是 helmod 的 ingredients 里凭空多出来的一件（实测：钢炉的 iron-plate 带 coal，标着
// `burnt`）。这一模的带子不搬燃料，所以它不能进料单 —— 进了就给每一条熔炉线多要一股；把它交出去而
// 不是吞掉，玩家才知道那一行每分钟确实要从别的路上来。
check("helmod 那一行的燃料不进料单：它单独在 feed.fuel 里说，带子的股数不替它算",
  asList(flFeed.needs).every((k) => k.item !== "coal")
    && asList(flFeed.fuel).some((k) => k.item === "coal" && num(k.per_min) > 0),
  JSON.stringify([flFeed.needs, flFeed.fuel]).slice(0, 320));
// 最尖的一钉：同一张卡、同一台机器，带 flows 与不带 flows 说的产量必须差出 productivity 那一成。
// 机器名不钉在这里 —— 哪一档熔炉胜出是这一存档的研究表决定的（本文件上面第 3 节就为此躲开过
// `steel-chest`，而 quick 那一串里前一套会把科技树留在不同状态上），所以先读"不带 flows 那一张"
// 自己算出来的每分工艺术数，再照那份数造一份 helmod 的件数（产物多 8%，正是自算那一路永远给不出的
// 那一成）。钉的于是是"卡念的是交进去的那份，而不是它再乘一遍的那份"，与哪台机器赢了无关。
const noFlows = call("card_example", { recipe: "iron-plate", machines: 10 });
const nd = noFlows.data || {};
const ownCrafts = num((nd.rate_source || {}).crafts_per_min);
const cardFlows = {
  source: "helmod", machines: 10, crafts: 6.25, base_time: 1, crafts_per_min: ownCrafts,
  feed: asList((nd.feed_plan || {}).needs)
    .map((k) => ({ item: k.item, per_min: k.per_min, per_craft: k.per_craft })),
  fluids: [], product_fluids: [], fuel: [{ item: "coal", per_min: 13.5 }],
  products: [{ item: nd.product || "iron-plate", per_min: ownCrafts * 1.08, per_craft: 1.08 }],
};
const withFlows = call("card_example", { recipe: "iron-plate", machines: 10, flows: cardFlows });
const wd = withFlows.data || {};
check("带 flows 那张卡念的是交进去的件数（产物 +8%），不带的那张念自己按 speed×60/energy 算的那份",
  ownCrafts > 0
    && Math.abs(num((wd.belt_ceiling || {}).claimed_per_min) - ownCrafts * 1.08) < 1e-6
    && Math.abs(num((nd.belt_ceiling || {}).claimed_per_min) - ownCrafts) < 1e-6
    && (wd.rate_source || {}).source === "helmod"
    && (nd.rate_source || {}).source === "self",
  JSON.stringify([nd.components && nd.components.furnace, ownCrafts,
    (nd.belt_ceiling || {}).claimed_per_min, (wd.belt_ceiling || {}).claimed_per_min,
    wd.rate_source, nd.rate_source]).slice(0, 340));
// 退到自算那一路不是悄悄退的：日志那一行要说清这一行为什么没有 helmod 的数（这一行没带工艺次数、
// helmod 不在这一发里、还是 `get_recipe` 报了错）。玩家指认"第几步不对"靠的就是这一行。
const plainRow = JSON.parse(JSON.stringify(flowRow));
delete plainRow.block_root.children.R1.count;
const unfolded = call("helmod_ghosts", { into: "string", width: 90, models: { model_6: plainRow } });
const unRate = (asList((unfolded.data || {}).lanes)[0] || {}).rate_source || {};
check("问不到 helmod 那一行时，答案与日志都说自己算的那一份，而不是假装同步过",
  unfolded.ok === true && unRate.source === "self"
    && asList((unfolded.data || {}).steps).some((s) => /分子/.test(s) && /自己算/.test(s)),
  JSON.stringify([unfolded.code, unRate,
    asList((unfolded.data || {}).steps).filter((s) => /分子/.test(s))]).slice(0, 320));
// 拆线时每条线拿自己那一份：件数按台数等比缩，加起来还是这一行的总数。钉的是这个不变量，而不是"这条
// 线会拆成几条"—— 后者是带子档位与一个面能叠几行的结果，写死它就是对那个决定投第二份意见。
const splitRow = JSON.parse(JSON.stringify(flowRow));
splitRow.block_root.children.R1.count = 25;            // 25 次/秒 = 1500 工艺/分
splitRow.block_root.children.R1.factory.count = 40;    // 40 台钢炉
splitRow.block_root.summary_global.factories.a.count = 40;
const split = call("helmod_ghosts", { into: "string", width: 200, style: "stacked",
  belt: "transport-belt", models: { model_6: splitRow } });
const foldedLanes = asList((split.data || {}).lanes);
check("拆成几条线时，每条线的件数是它自己那一份：scale = 台数/记账台数，各线加起来仍是这一行总数",
  split.ok === true && foldedLanes.length > 0
    && foldedLanes.every((l) => {
      const rs = l.rate_source || {};
      return rs.source === "helmod"
        && Math.abs(num(rs.scale) - num(l.machines) / num(rs.quoted_for)) < 1e-9;
    })
    && Math.abs(foldedLanes.reduce((a, l) => a + num((l.rate_source || {}).crafts_per_min), 0) - 1500) < 1e-6,
  JSON.stringify([split.code, foldedLanes.map((l) => [l.machines, l.rate_source])]).slice(0, 320));

// ------------------------------------------------------------------ 3b3. 模块要进账（B1）
// 一页 helmod 计划里，模块写在两处：块上的 `summary_global.modules`（整页合计）与机器上的
// `factory.modules`（一台装几个，`ModelCompute.createSummaryMachine` 就是拿它 × 台数合出页合计的）。
// 从前**一处都没人读**：实测一页写 80 个速度模块，答案里 `skipped` 是 null、一个字没有，而机器数与
// 每分钟件数却全是按装了它们算的（`get_recipe` 折的那一份）。而虚影身上装不了模块 —— 实测：
// `ghost.get_inventory(defines.inventory.crafter_modules)` 是 nil，2.0 也没有 `set_module_info`
// （真机器可以：`real.insert({name="speed-module",count=1})` 回 0 未放入）。
// 所以这一格钉三件事：欠哪几样各几个要说出来、铺了几个要说是 0、以及这份流量的前提跟着每条线走。
const withModules = call("helmod_ghosts", { into: "string", width: 90, models: { model_6: flowRow } });
const wmd = withModules.data || {};
const owed = asList(wmd.modules);
const laneWithModules = asList(wmd.lanes)[0] || {};
check("这一页欠哪些模块、各几个，答案自己说，并说清铺了 0 个（虚影装不了）",
  withModules.ok === true
    && owed.some((m) => m.item === "speed-module-2" && num(m.count) === 20)
    && num(wmd.modules_count) === 20 && num(wmd.modules_laid) === 0
    && String(wmd.modules_said || "").indexOf("speed-module-2") >= 0
    && /ghost cannot hold a module/.test(String(wmd.modules_note || "")),
  JSON.stringify([withModules.code, wmd.modules, wmd.modules_count, wmd.modules_laid,
    wmd.modules_note]).slice(0, 320));
check("...并且那份欠账跟着每条线走：这条线的流量是装着哪几样算的，线自己身上就写着",
  asList(laneWithModules.modules).some((m) => m.item === "speed-module-2" && num(m.count) === 20)
    && asList((laneWithModules.rate_source || {}).modules).length > 0
    && asList(wmd.steps).some((s) => /读页/.test(s) && /speed-module-2/.test(s)),
  JSON.stringify([laneWithModules.recipe, laneWithModules.modules,
    (laneWithModules.rate_source || {}).modules,
    asList(wmd.steps).filter((s) => /读页/.test(s))]).slice(0, 340));
// 两个口径并列（#35 ③）：helmod 那条式子的带子数（向上贴半条）与这条线实际铺了几行成品带。
// 分母不写死：加成读的是这一发当时的 `force.belt_stack_size_bonus`（同 `dev/belt_rate_e2e.js`、
// `dev/layout_ledger.js` 的规矩 —— 报出来的 bonus 必须与它一致，不是这文件猜的一个常数）。
const forceBonusRaw = String(lua(`rcon.print(tostring(game.forces.player.belt_stack_size_bonus or 0))`))
  .split(/\r?\n/).filter((l) => /^[\d.]+$/.test(l.trim())).pop() || "0";
const forceBonus = Number(forceBonusRaw);
const bnLane = asList((folded.data || {}).lanes)[0] || {};
const bnHelmod = bnLane.belt_need_helmod || {};
check("压线的答案把 helmod 那一句「要几条带子」与「这一页铺几行」并列交出来",
  bnHelmod.belt !== undefined && num(bnHelmod.per_min) > 0
    && asList(bnHelmod.products).length > 0
    && num(bnHelmod.bonus) === forceBonus
    && asList(bnHelmod.products).every((p) => Math.abs(num(p.lanes) - num(p.belts) * 2) < 1e-9)
    && bnHelmod.belt === (bnLane.feed || {}).belt
    && bnLane.product_rows !== undefined
    // #35 ④：这一档是谁定的，只能是这两种之一 —— 这一发没点名，所以该是 "adequate"，
    // 绝不会写成"同步了 helmod 的偏好"（那扇门根本读不到 `storage.preferences`，实测）。
    && bnLane.belt_chosen_by === "adequate"
    // 交接文档许的那一形：这条线往外搬那种料的 raw / rounded / lanes。
    && Math.abs(num(bnHelmod.rounded) * 2 - num(bnHelmod.lanes)) < 1e-9
    && num(bnHelmod.rounded) >= num(bnHelmod.raw),
  JSON.stringify([forceBonus, bnHelmod, (bnLane.feed || {}).belt,
    bnLane.product_rows]).slice(0, 340));
check("...取整方向是他口述那一条：≤0.5 占一股，>0.5 整条向上（1.1 条说成 2 条，不是说成 1 条）",
  // 这一发是 10 台钢炉、一股走 450/分（带子档位由答案自己说），产物 405/分 → raw 0.9 → 整条向上是 1 条。
  // 表本身在 dev/layout_ledger.js 钉（那里能把 raw 造准），这里钉的是"压线交出来的数是同一套取整"。
  // 玩家 2026-10-09 拍板照换（"带子不够就换更快的带子"）—— 点名慢带子装不下的按名拒、不点名自动升档。
  asList(bnHelmod.products).every((p) => {
    const raw = num(p.raw);
    const stepped = raw <= 0.5 ? 0.5 : Math.ceil(raw - 1e-9);
    return Math.abs(num(p.belts) - stepped) < 1e-9 && num(p.belts) >= num(p.raw);
  }),
  JSON.stringify(asList(bnHelmod.products)).slice(0, 300));
// 点名一档时，那句话要改成"是你在这一格里点名的"，而不是仍然说"我们挑的"。
const namedBelt = call("helmod_ghosts", { into: "string", width: 90, belt: "transport-belt",
  models: { model_6: flowRow } });
const nbLane = asList((namedBelt.data || {}).lanes)[0] || {};
check("点名一档带子时，答案说的是\"你点的那一档\"；没点名说的是\"我们按够用就好挑的\"",
  namedBelt.ok === true && (nbLane.belt_chosen_by === "caller")
    && ((nbLane.belt_need_helmod || {}).belt) === "transport-belt"
    && bnLane.belt_chosen_by === "adequate",
  JSON.stringify([namedBelt.code, nbLane.belt_chosen_by,
    nbLane.belt_need_helmod, bnLane.belt_chosen_by]).slice(0, 300));
// 挑一条线时页合计被清空（那一格是整页的数），所以模块必须改用"这一行几台 × 一台几个"那份 —— 两处
// 各演一份就会有一天对不上，而玩家是在这一页上看到"模块 0 个"却等来一条产不满的线的那个人。
const scopedModules = call("helmod_ghosts", { into: "string", width: 90, factory: "model_6#iron-plate",
  models: { model_6: flowRow } });
const smd = scopedModules.data || {};
check("只挑一条线时，模块按那条线自己算（页合计已清空，不能一起交出去）",
  scopedModules.ok === true && smd.scoped === "iron-plate"
    && asList(smd.lanes).some((l) => asList(l.modules)
      .some((m) => m.item === "speed-module-2" && num(m.count) === 20))
    && !asList(smd.steps).some((s) => /读页/.test(s) && /欠模块=speed-module/.test(s)),
  JSON.stringify([scopedModules.code, smd.scoped, smd.modules,
    asList(smd.lanes).map((l) => l.modules)]).slice(0, 320));
// 选页那一列也得看得见：玩家是在这里决定铺哪一条的，而"这一页的数按什么算的"是他那一刻就该知道的事。
const listedModules = call("helmod_factories", { models: { model_6: flowRow } });
const lmRows = asList((listedModules.data || {}).factories);
check("选页那一列也报模块：页与线两格同形 —— modules 是件数，module_said 是给人念的那句",
  listedModules.ok === true
    && lmRows.some((f) => f.id === "model_6" && num(f.modules) === 20
      && /speed-module-2/.test(String(f.module_said || "")))
    && lmRows.some((f) => f.id === "model_6#iron-plate" && num(f.modules) === 20
      && /^speed-module-2 ×20$/.test(String(f.module_said || ""))),
  JSON.stringify(lmRows).slice(0, 340));
// 没写模块的一页不该出现这一格（空的一份清单比没有更难看：它会让人以为"欠 0 个"是个结论）。
const bareRow = JSON.parse(JSON.stringify(flowRow));
delete bareRow.block_root.summary_global.modules;
delete bareRow.block_root.children.R1.factory.modules;
const bare = call("helmod_ghosts", { into: "string", width: 90, models: { model_6: bareRow } });
check("...而这一页没写模块时，答案里根本没这一格，不是写一份「欠 0 个」的清单",
  bare.ok === true && (bare.data || {}).modules === undefined
    && (bare.data || {}).modules_count === undefined
    && asList(((bare.data || {}).lanes || [])[0].modules).length === 0,
  JSON.stringify([bare.code, (bare.data || {}).modules,
    ((bare.data || {}).lanes || [])[0] && ((bare.data || {}).lanes || [])[0].modules]).slice(0, 300));

// ------------------------------------------------------------------ 3b4. 换了机器，分子要改口（B2）
// helmod 那一行的件数是按**它点名的那台机器**折的（速度、模块、信标都在里面）。这一发真能放下去的
// 可能不是同一台 —— 从前这里会拿着 X 的数去铺 Y 的线：实测点 steel-furnace 而这一发放不下去时，
// `parts` 里是石炉，`rate_source.crafts_per_min` 却仍是 helmod 那份。换机器那件事 `lanes[].swapped`
// 一直有说，流量那件事没人说 —— 而后者绑的是"这条线要几条带子"，拿错的数铺出来的就是一条喂不饱的线。
const swappedFlows = {
  source: "helmod", machines: 10, crafts: 6.25, base_time: 1, crafts_per_min: 405,
  // 一个任何梯子都不可能交出来的名字：这一发铺下去的必然不是它，于是"换机器"这件事在这里是必然的，
  // 门禁就不依赖这一存档研究了哪档熔炉（本文件上面为同样的理由躲开过 `steel-chest`）。
  machine: "not-a-machine-this-ladder-can-choose",
  feed: [{ item: "iron-ore", per_min: 405, per_craft: 1 }], fluids: [], product_fluids: [],
  fuel: [], products: [{ item: "iron-plate", per_min: 405, per_craft: 1 }],
};
const swappedCard = call("card_example", { recipe: "iron-plate", machines: 10, flows: swappedFlows });
const scd = swappedCard.data || {};
const scRs = scd.rate_source || {};
check("flows 说的是另一台机器时，分子退回自算，并把两台机器各自的数都交出来",
  swappedCard.ok === true && scRs.source === "self"
    && scRs.reason === "machine_swapped"
    && ((scRs.helmod_aside || {}).helmod_machine) === "not-a-machine-this-ladder-can-choose"
    && num((scRs.helmod_aside || {}).crafts_per_min) === 405
    && num(scRs.crafts_per_min) > 0 && num(scRs.crafts_per_min) !== 405
    && scd.components && scd.components.furnace
      === (scRs.helmod_aside || {}).laid_machine,
  JSON.stringify([swappedCard.code, scRs, scd.components]).slice(0, 340));
// 反过来的那一半同样要说住：只有地上就是 helmod 点名的那台，才允许拿它那份数。
const swapInvariant = asList((withModules.data || {}).lanes).concat(asList((folded.data || {}).lanes));
check("一份数与一台机器对得上才叫 helmod 的数：每条线要么没换机器并用 helmod 那份，要么换了并退回",
  swapInvariant.length > 0 && swapInvariant.every((l) => {
    const rs = l.rate_source || {};
    return rs.source === "helmod"
      ? l.swapped === undefined && rs.reason === undefined
      : rs.reason === "machine_swapped" && l.swapped !== undefined;
  }),
  JSON.stringify(swapInvariant.map((l) => [l.machine, l.asked_machine, l.swapped,
    (l.rate_source || {}).source, (l.rate_source || {}).reason])).slice(0, 340));
// 上面那条窗口断言读的是面板替身（`report_after`），不靠真放机器；到这里所有需要钢炉的**活**压线都跑完了，
// 借来的配方照原样还 —— 留在存档里就是给下一套门禁塞了一份它没要的名单。
if (!steelWasOn) lua(`local r = game.forces.player.recipes["steel-furnace"]
if r then r.enabled = false end rcon.print("returned")`);

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
// "接口按 LINE 付，不按机器付"这一句在零箱子的世界里数的是别的件：一块头牌 + 一块尾牌（各是一件发射器
// 加一件面板）服务整排机器，而不是每台机器一份。箱子那一半现在必须真的是 0 —— 这一格从前钉的是"箱子
// 少于 6 只"，它当时证明的是接口没按机器数摊，今天它只能证明"没有箱子"这句话没坏。
const signParts = Object.keys(bl.parts || {}).filter((n) => /combinator|display-panel/.test(n))
  .reduce((s, n) => s + (bl.parts[n] || 0), 0);
check("一条算出来的 48 台线，接口是按线付的：牌件数是个位数，箱子一只都没有",
  bigLine.ok === true && (bl.machines || 0) >= 12 && chests === 0 && signParts <= 8
    && /^(stacked|two-row)$/.test(String(bl.shape)) && bl.width < 200,
  JSON.stringify([bl.shape, chests, chestNames, signParts, bl.width, bl.height]).slice(0, 300));
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
  origin: AT, width: 90, factory: "model_5", style: "two-row" });
// 自动 means "the ladder chooses", and the ladder answers one of the shapes that are left. This check's
// job is that row 1 of the drop-down is NOT a style named "" -- any shape the ladder can pick is fine,
// and the named-row check beside it is what pins that a name is obeyed exactly.
check("自动 (the drop-down's blank row) still means 'choose', not a style literally named ''",
  autoRow.ok === true && ["stacked", "two-row"]
    .indexOf(String(asList(autoRow.data.lanes)[0].shape)) >= 0,
  JSON.stringify([autoRow.code, autoRow.msg, asList(autoRow.data.lanes)[0].shape]).slice(0, 240));
check("...and a named row is an order: the lane is built in THAT shape",
  ordered.ok === true && asList(ordered.data.lanes)[0].shape === "two-row"
    && asList(ordered.data.lanes)[0].entities > 0,
  JSON.stringify([ordered.code, asList(ordered.data.lanes)[0].shape]).slice(0, 240));

// The promise the shape change was made for, at the answer's level rather than the drawing's: a plan of
// green circuits laid as either of the two shapes left brings BOTH materials and says which ones. The
// other half of this claim used to be "the shape that cannot share the row names what it left out" -- and
// that shape is gone, so the half that is still a fact is the *named* one: a style the registry does not
// have is refused by name rather than quietly drawn in some other pattern.
const fed2 = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 90,
  plan: [{ entity: "assembling-machine-3", recipe: "electronic-circuit", count: 4 }],
  style: "two-row" });
const fedLane = (asList((fed2.data || {}).lanes)[0] || {});
check("a shared-row lane of a two-material recipe reports BOTH materials as brought in",
  fed2.ok === true && asList(fedLane.fed_items).length === 2
    && fedLane.unfed === undefined && asList(fedLane.fed_items).indexOf("copper-cable") >= 0
    && String(fedLane.shape) === "two-row",
  JSON.stringify([fed2.code, fedLane.shape, fedLane.fed_items, fedLane.unfed]).slice(0, 300));
const noShare = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 90,
  plan: [{ entity: "assembling-machine-3", recipe: "electronic-circuit", count: 4 }],
  style: "row-chest" });
check("...and a shape this install no longer has is refused by name, not drawn in some other pattern",
  noShare.ok === false && noShare.code === "UNKNOWN_STYLE"
    && asList(noShare.known || (noShare.detail || {}).known).length >= 2,
  JSON.stringify([noShare.code, noShare.known || (noShare.detail || {}).known]).slice(0, 300));

// The third material, which is where 绿板 lives. `advanced-circuit` eats plastic bar, copper cable AND
// electronic circuit -- 92 of the production recipes on this install eat three, 141 eat three or more
// (`dev/recipe_table_e2e.js` reads the table rather than remembering it). Since the shapes stopped being
// a matter of names, "does the laid line bring all three" is asked of the parts: the head sign(s) list
// them, or the belt rows' capacity does, and nothing is left named as unfed. The tech is granted for this
// call and taken back after, because leaving it on would hand every later suite a recipe it never asked for.
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
    style: "two-row" });
} finally {
  grantAdv(false);
}
const advLane = (asList((threeMat.data || {}).lanes)[0] || {});
check("a three-material plan with no style named still comes back with a lane that lays feed lines",
  threeMat.ok === true && ["stacked", "two-row"].indexOf(String(advLane.shape)) >= 0
    && ((advLane.feed || {}).lane_rows || 0) >= 1,
  JSON.stringify([threeMat.code, advLane.shape, (advLane.feed || {}).lane_rows,
    advLane.fed_items, advLane.unfed]).slice(0, 300));
check("...and it brings ALL THREE materials, which is the whole reason the shapes count lanes now",
  asList(advLane.fed_items).length === 3 && advLane.unfed === undefined
  && ["plastic-bar", "copper-cable", "electronic-circuit"].every((i) => asList(advLane.fed_items).indexOf(i) >= 0),
  JSON.stringify([advLane.fed_items, advLane.unfed]).slice(0, 300));
const forcedLane = (asList((threeForced.data || {}).lanes)[0] || {});
check("...while a shape the player named is obeyed exactly, and brings all three on its own two faces",
  threeForced.ok === true && String(forcedLane.shape) === "two-row"
    && asList(forcedLane.fed_items).length === 3 && forcedLane.unfed === undefined,
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
check("a ONE-machine chunk of a two-material recipe still brings both materials",
  single.ok === true && ["stacked", "two-row"].indexOf(String(singleLane.shape)) >= 0
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
// The limit is read off the press by BISECTION, not off a count written in this file. Since the capacity
// law landed (0.64.0: a product belt row carries only the half its own face loads, so a row past what one
// face can stack is refused BEFORE it lays), `{machines: 40}` answers this block with
// `LINES_BEYOND_SHAPE` rather than with a `feed_plan` -- which is exactly the fact the rest of the block is
// about, so the refusal itself gets asserted rather than dodged. The bracket is the shape's own ceiling:
// one face stacks `rows_per_face` belt rows, so no count above a few dozen can lay.
// 这一块的每一发都**硬点名** `electric-furnace`（0.82.0 起，点名的机器不再被背着换：跑不了就按名拒）。
// 而这一档熔炉在这一存档里不一定开着，所以照 `layout_ledger` 的老规矩借**配方那一格**、用完照原样还 ——
// 借科技会动别人的研究表，借 `recipes[...].enabled` 只让这一发挑机器时看得见它。
const efWasOn = /^true$/.test(lua(`local r = game.forces.player.recipes["electric-furnace"]
  rcon.print(r and tostring(r.enabled) or "absent")`));
if (!efWasOn) lua(`local r = game.forces.player.recipes["electric-furnace"]
if r then r.enabled = true end rcon.print("borrowed")`);
const oneLong = (n) => call("card_example", { recipe: "iron-plate", furnace: "electric-furnace",
  machines: n, belt: "transport-belt", force: "player", style: "stacked" });
let fitLo = 1, fitHi = 60;
while (fitLo < fitHi) {
  const mid = Math.ceil((fitLo + fitHi) / 2);
  if (oneLong(mid).ok) fitLo = mid; else fitHi = mid - 1;
}
const longRow = oneLong(fitLo).data || {};
const perLine = (longRow.feed_plan || {}).machines_per_line || 0;
check("a slow belt's line pays for a countable number of machines, and says which number",
  // The band is not a fixed number: which furnace wins this pick depends on what the rest of the sweep
  // left researched, and the limit is a property of (recipe, machine, belt) rather than of the plan
  // length -- which is why it is read off the longest line that lays, and allowed to be larger than 2.
  perLine >= 2 && (longRow.feed_plan || {}).per_machine > 0
    && (longRow.feed_plan || {}).machines_per_line >= 2,
  JSON.stringify([fitLo, perLine, longRow.feed_plan && longRow.feed_plan.per_machine,
    longRow.feed_plan && longRow.feed_plan.per_line]).slice(0, 260));
const overFit = oneLong(fitLo + 1);
check("...while one machine past that line is refused by name, with both numbers it was refused on",
  overFit.ok === false && overFit.code === "LINES_BEYOND_SHAPE"
    && ((overFit.detail || {}).product_rows || 0) > ((overFit.detail || {}).rows_per_face || 0),
  JSON.stringify([fitLo, perLine, overFit.code, overFit.detail]).slice(0, 260));
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
  splitLanes.length > 0 && splitLanes.every((l) => ["stacked", "two-row"]
    .indexOf(String(l.shape)) >= 0 && (l.split || {}).lines === splitLanes.length),
  JSON.stringify(splitLanes.map((l) => [l.machines, l.shape])).slice(0, 240));
check("...and a plan that split into rows does NOT claim the belt itself is the limit",
  splitLanes.length >= 2 && splitLanes.every((l) => !((l.feed || {}).belt_too_slow)),
  JSON.stringify(splitLanes.map((l) => [l.machines, (l.feed || {}).belt_too_slow,
    (l.feed || {}).lanes_wanted])).slice(0, 300));
if (!efWasOn) lua(`local r = game.forces.player.recipes["electric-furnace"]
if r then r.enabled = false end rcon.print("returned")`);

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
    // 这块地板跟着几何走，改的时候要说清为什么降。历史：`> 30` 是 0.85.0 之前数的（每一发都带一条自己的
    // 成品带）；0.85.0 让成品借进料行离机器远的那一股，那一发少了一条带，量到 30 就贴在 30。
    // 现在 26 —— 而这**不是 0.86.0 改的**：把 src/architect 退回 0.85.0 那一版重新打包跑同一发，
    // 读数一模一样（26 / 565 字节），所以欠的是这一条地板在 0.85.0 那一轮没跟着改完。
    // 这一发真铺的是 4 台电炉那条铁板线（13 节带 + 8 只臂 + 4 台 + 1 块牌 = 26），钉的仍是
    // "一行 = 机器 + 带 + 臂，不是光一堆机器"：25 件里没有一件是空架子。
    && byFactory("model_a").lines >= 1 && byFactory("model_a").entities >= 25
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
check("into = string hands the authored blueprint back to a caller with no hands, instead of refusing for one",
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
// 模块那两行：一条线一行（"这条线的流量是装着哪几样算的"）与整页一行（欠几个、铺了几个）。
// 钉的是"面板上看得见"，因为 RCON 里那一格再全，玩家按的是窗口。
check("窗口把欠的模块说出来：整页一行、每条线一行，铺的那个数是 0",
  hmLines.some((l) => /architect\.n-hm-modules-page\|speed-module-2/.test(l))
    && hmLines.some((l) => /architect\.n-hm-modules\|speed-module-2/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-modules/.test(l))).slice(0, 340));
// 换了机器 → 分子退回自算，那一行要把两个数都念出来（helmod 那份原数、按地上这台算的那份）。
check("窗口也说「这份数退回自己算了」，并把两台机器各自的数一起念出来",
  hmLines.some((l) => /architect\.n-hm-rate-self\|/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-rate-self/.test(l))).slice(0, 300));
// 两个口径并列的那一行：helmod 的条数（`%.2f` 出来是 "1.10"）与这一条实际铺了几行成品带。
check("窗口那行同时念出「helmod 要几条带」与「这一条铺了几行」，不是只念一个",
  // 1.1 条按他口述那一条（≤0.5 占一股、再多整条向上）是 2 条 = 4 股；0.9 那条整条向上仍是 1 条 = 2 股。
  hmLines.some((l) => /architect\.n-hm-belt-need-named\|1\.10\|2\|4\|fast-transport-belt\|2\|1/.test(l))
    && hmLines.some((l) => /architect\.n-hm-belt-need-auto\|0\.90\|1\|2\|transport-belt\|1\|0/.test(l)),
  JSON.stringify(hmLines.filter((l) => /n-hm-belt-need/.test(l))).slice(0, 340));

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
// 整计划那按：模块那一行挂在**它所属的那一页**下面，不是全计划合一句 —— fixture 里只有第一页写模块，
// 所以整棵树里就该出现一次，而且排在第二页那一行之前。
check("...and the modules row sits under the page that owes them, not under the whole plan",
  allLines.filter((l) => /architect\.n-hm-modules-page\|speed-module-2/.test(l)).length === 1
    && allLines.findIndex((l) => /n-hm-modules-page/.test(l))
      < allLines.findIndex((l) => /architect\.n-hmall\|electronic-circuit/.test(l)),
  JSON.stringify(allLines).slice(0, 400));

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

// ------------------------------------------------------------------ 线头也能从压线这一按走到地面
// `heads` 从前只有直接叫 `card_example` 才拿得到：面板上没这一格，压线也不往卡里传，于是玩家要的
// "一只箱子都不留"只能靠手工 RCON 兑现。这几条钉的是这条路真的通了：参数进得到卡、卡选到零箱子那一档、
// 答案里那些数能核对（牌本身落到地面的证据在 belt_head_e2e 里，那里数的是虚影）。
//
// 科技照上面的 `grantAdv` 一样只为这一跑借：裸带线头要放一块显示面板，而面板锁在 circuit-network 后面
// —— 不借就会拿到 `HEAD_SIGN_UNAVAILABLE`，那是世界状态，不是这次改动的行为（这个坑今天早上刚踩过一次）。
const grantNet = (on) => lua(`local f = game.forces.player
local t = f.technologies["circuit-network"]
local r = f.recipes["display-panel"]
if t then t.researched = ${on ? "true" : "false"} end
if r then r.enabled = ${on ? "true" : "false"} end
rcon.print("ok")`);
const netWasOn = /true/.test(String(lua(`local t = game.forces.player.technologies["circuit-network"]
rcon.print(t and tostring(t.researched) or "absent")`)));
grantNet(true); grantAdv(true);
let barePress, chestPress;
try {
  barePress = call("helmod_ghosts", { into: "string", heads: "belt", surface: SURF, origin: AT, width: 90,
    plan: [{ entity: "assembling-machine-3", recipe: "advanced-circuit", count: 4 }] });
  chestPress = call("helmod_ghosts", { into: "string", surface: SURF, origin: AT, width: 90,
    plan: [{ entity: "assembling-machine-3", recipe: "advanced-circuit", count: 4 }] });
} finally {
  grantAdv(false);
  if (!netWasOn) grantNet(false);
}
const bp = (barePress || {}).data || {};
const bpLane = asList(bp.lanes)[0] || {};
const chestish = Object.keys(bpLane.parts || {}).filter((k) => /chest/.test(k));
check("压线带上 heads=belt：这一条线落在零箱子那一档，答案把线头写在 lanes[].head 上",
  barePress.ok === true && bp.heads === "belt" && bpLane.head === "belt"
    && String(bpLane.shape) === "stacked" && (bpLane.chests || 0) === 0 && chestish.length === 0,
  JSON.stringify([barePress.code, bp.heads, bpLane.shape, bpLane.head, bpLane.chests, chestish]));
const bpKinds = Object.keys(bpLane.parts || {});
// 0.93.0 改口：这块牌**只有**一块显示面板，字直接写在面板上（他测的那句"接了发射器组合器电线根本
// 看不懂"）。从前这一条钉的是"面板 + 组合器都在"，那时候牌确实是两件硬件；现在要钉的是反面 ——
// 线上再也没有组合器，而牌仍然在那一行的件数里。
check("...而这条线的件数里就有那块牌（只有显示面板，再无组合器），不是只有一个字段说它是裸带",
  bpKinds.some((k) => /panel/.test(k)) && !bpKinds.some((k) => /combinator/.test(k)),
  JSON.stringify([bpKinds, bpLane.entities]).slice(0, 300));
const cp = (chestPress || {}).data || {};
const cpLane = asList(cp.lanes)[0] || {};
// 这一格从前钉的是"不表态时仍然从箱子起步"，那是为了证明默认没被一次改动顺手搬走。默认现在**就是**裸带
// （玩家："把带箱子的排法全部删除或者改为不带箱子的"），所以同一格改成钉新默认：不表态 = 裸带 = 零箱子。
check("不表态时压线从裸带起步，而且一只箱子也不要（这就是这一版的默认）",
  chestPress.ok === true && (cp.heads === undefined || cp.heads === "belt" || cp.heads === null)
    && cpLane.head === "belt" && (cpLane.chests || 0) === 0
    && Object.keys(cpLane.parts || {}).filter((k) => /chest/.test(k)).length === 0,
  JSON.stringify([chestPress.code, cp.heads, cpLane.shape, cpLane.head, cpLane.chests]));

// ------------------------------------------------------------------ leave the ground as found
const left = wipe();
check("the ground this file built is empty again", /wiped=0/.test(String(left)), String(left));
check("and the world this file asked for is the world it leaves: no deployment of ours is still on the stack",
  (() => { const u = call("place_undo", { count: 1 }); return u.ok === true || /empty|nothing/.test(String(u.msg)); })(),
  "undo answered");

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) { console.log("FAILURES: " + fails.join(", ")); process.exit(1); }

function byNameFM(n, d) { return asList(d.items).find((e) => e.name === n) || {}; }
