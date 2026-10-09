// The refusal surface: every code a caller can trigger, and the input that triggers it.
//
// Two ways for a refusal to be worth nothing. Nobody can ever reach it -- then it is decoration in
// the source and a false promise in a docstring -- or it is reachable but asserted by nothing, then
// the guard in front of it can be edited away and the suite stays green. `dev/smoke.js` grew to
// 80KB answering questions; the truth of an API is at least as much about what it says NO to.
//
// Run after `bash dev/cycle.sh`. Nothing here mutates the world on purpose: the cases that would
// start a rig or a job are left to the suites that measure them, and this file asserts on answers.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
// A suite writes to the world it is talking about. See dev/suite-guard.js for why that is a hard stop.
require("./suite-guard.js").guardMain("refusals");
const { brief, enLine } = require("./lines.js");

const call = (method, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, RAW: "1" } });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) };
  }
};
// Real seconds, because a dedicated server runs at 60 ticks a second whatever `game.speed` says: the
// write is accepted, reads back as the number asked for, and changes nothing. A job asked for two
// game seconds has to be waited out, so the suite waits rather than pretending the clock obeys it.
const wait = (ms) => { try { execFileSync("sleep", [String(ms / 1000)], { encoding: "utf8" }); } catch (e) {} };
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const gear = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));
// Console Lua reaches `game` (the pad fixtures below write resources through it) but NOT the mod's
// `storage` -- see the ask-queue block, which learned that the hard way.
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: process.env }).trim();

// The bench first: a measurement left running by an earlier suite would answer LAB_BUSY to half
// of what follows, which is a fact about the session rather than about the guard under test.
call("lab_reset");
call("lab_stop");

let fails = 0;
const results = [];
const check = (label, ok, detail) => {
  results.push(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) fails++;
};
// The point of this helper is that it fails loudly on the two ways a refusal assertion goes
// wrong while still passing: the method answered successfully, or it answered a DIFFERENT code
// than the one this case is about (which usually means an earlier guard now catches it -- the
// code is then dead, and deleting it is the honest fix).
const COVERED = new Set();
// A refusal that names a key for its own sentence has to render, in English, the very line `msg` carries.
// The window builds its header from the key and the protocol prints `msg`, so the two disagreeing is the
// failure this looks for. `locale_check` proves the no-parameter sentences statically, from the source;
// this proves the ones whose words the code BUILDS -- which no static reader can resolve -- and it proves
// them from a live answer rather than from a fixture of anybody's invention.
const keyed_line_ok = (r) => {
  if (!r || r.ok || typeof r.msg_key !== "string") return true;
  const p = Array.isArray(r.msg_params) ? r.msg_params : [];
  const flat = "architect.r-refused-msg|" + String(r.code) + "|architect." + r.msg_key
    + (p.length ? "|" + p.join("|") : "");
  let line = null;
  try { line = String(enLine(flat)); } catch (e) { line = "ENLINE_THREW " + e.message; }
  return line === "refused: " + String(r.code) + " -- " + String(r.msg) ? true : line;
};

const refuses = (label, method, args, code, extra) => {
  COVERED.add(code);
  const r = call(method, args);
  const key = keyed_line_ok(r);
  check(label, !r.ok && r.code === code && key === true,
    `${r.code || "ANSWERED"} ${String(r.msg || "").slice(0, 60)}`
    + (key === true ? "" : " || key renders as: " + String(key).slice(0, 90)));
  if (extra) extra(r);
  return r;
};

// ---- the envelope itself ----
// 0.61.0 起这扇门后面的方法从 56 个缩到 17 个，所以这里不再钉一个绝对数字，钉的是"把还在的都交出来"：
// 少一个就说明有方法从 `M` 上掉了而没人注意到 —— 那正是 `known` 这份清单存在的理由。
const known_now = asArr((call("ping", {}).data || {}).methods || []);
refuses("an unknown method is refused, with the list of what is not", "no-such-method-at-all", {},
  "UNKNOWN_METHOD",
  (r) => check("  ...and the answer names every method this mod still has",
    asArr(r.known).length >= known_now.length
    && ["helmod_ghosts", "card_example", "place_undo"].every((m) => asArr(r.known).includes(m)),
    `${asArr(r.known).length} known vs ${known_now.length} in ping`));

// ---- arguments: nothing malformed may come back as a bare runtime error ----
// `RUNTIME_ERROR` is the dispatcher's pcall, not a refusal: it means an input reached code that
// had no answer for it. Three such inputs were found and fixed by hand; this is the sweep that
// stops the next four from arriving as someone else's bug report.
const HOSTILE = [
  ["card_place", {}], ["card_blueprint", {}], ["cards", null], ["sandbox", null],
  ["lab_status", {}], ["lab_stop", {}], ["gui_model", {}], ["gui_selftest", {}],
];
for (const [method, args] of HOSTILE) {
  const r = call(method, args);
  const key = keyed_line_ok(r);
  check(`${method} on a malformed request answers with a code, not a crash`,
    (r.ok === true || (!!r.code && r.code !== "RUNTIME_ERROR" && r.code !== "HARNESS")) && key === true,
    r.ok ? "(answered, which is allowed)"
      : `${r.code} ${String(r.msg || "").slice(0, 70)}`
        + (key === true ? "" : " || key renders as: " + String(key).slice(0, 90)));
}


// ---- card_compose: the only method with no negative test at all until now ----
// `card_compose` reports one outer code and the per-slot reasons inside it: the slot that failed
// has to be named, because "could not compose" is not an answer a caller can act on.
const inner = (r, code) => JSON.stringify(r.detail || []).includes('\"code\":\"' + code + '\"')
  || String(r.msg || "").includes(code);

// ---- card_lab: three gates in front of spending a measurement ----
refuses("card_lab on a card with no ports cannot be measured", "card_lab",
  { card: { name: "noports", entities: gear.entities } }, "CARD_NO_PORTS");
refuses("card_lab on a card with no claim has nothing to check", "card_lab",
  { card: { name: "nocontract", entities: gear.entities,
    ports: { in: [{ item: "iron-ore", entity: gear.ports["in"][0].entity }],
             out: [{ item: "iron-gear-wheel", entity: gear.ports.out[0].entity }] } } },
  "CARD_NO_CONTRACT");
refuses("card_lab on an illegal card is refused before anything is built", "card_lab",
  { card: { name: "illegal", entities: [{ name: "pipe", position: { x: 0.5, y: 0.5 } },
    { name: "pipe", position: { x: 0.5, y: 0.5 } }] } }, "CARD_DOES_NOT_LINT");

// The lab's own two guards, asserted against a record this file owns. Two ways this block used to be
// wrong at random: a job left on record by whoever ran before (then "nothing to stop" answers with a
// finished job, and the refusal below reads as a regression), and a window short enough to END between
// two RCON calls (speed 20 turns 60 game seconds into 3 real ones, and a measurement that finished
// while node was starting lets the second `card_lab` through -- LAB_BUSY becomes ANSWERED, and the first
// job's rig is orphaned on the bench for the next suite to trip over). So: clear the record first, ask
// for a window that cannot expire mid-suite, and stop it by hand rather than waiting for the tick.
call("lab_reset");
refuses("stopping with no measurement on record", "lab_stop", {}, "NO_JOB");
{
  const started = call("card_lab", { card: JSON.parse(fs.readFileSync(path.join(__dirname, "card_ex.json"), "utf8")),
    seconds: 600, speed: 20 });
  check("a measurement that starts is running", started.ok && started.data.state === "running",
    started.ok ? `${started.data.job} on ${started.data.ideal_grid.surface}` : `${started.code} ${started.msg}`);
  refuses("starting a second measurement while one runs", "card_lab", { card: gear }, "LAB_BUSY");
  const stopped = call("lab_stop");
  check("  ...and stopping it hands the bench back", stopped.ok === true, JSON.stringify(stopped.data || stopped.code));
  call("lab_reset");
  refuses("  ...and with the record gone, there is nothing to stop again", "lab_stop", {}, "NO_JOB");
}

// 线头只剩一种：带箱子的四种排法删了，"给我一个箱子线头"这句话没有东西可以去实现了。按名拒，并且把
// 还画得出来的那两种说出来 —— 一个被忽略的参数比一个报错的参数难查得多。
refuses("a caller that asks for the removed chest head is refused by name", "card_example",
  { recipe: "iron-plate", machines: 2, heads: "chest" }, "CHEST_HEAD_REMOVED");

// ---- the force argument has to mean something ----
// `availability_checker` used to read a research flag that one field carries for every force, so a
// second force inherited the first one's unlocks and `force` changed nothing but the label.
{
  const enemyRaw = call("card_example", { force: "enemy" });
  const player = call("card_example", {});
  // 带箱子的排法删掉之后，`force` 缺什么不再决定这条线能不能铺，只决定它拿什么武装、那块牌立不立得起来。
  // 所以这句话比原来那句更硬：一个什么都没研究的 force 现在拿到一条 burner-inserter 的线，并且被明告诉
  // 道"牌没放上去、缺的是哪两样"。把文档的缺失升级成整条链的拒绝，是一个模最像"安全"的失效方式。
  const enemy = enemyRaw.data || {};
  check("a force with no research gets the line its parts can arm, and is told which sign it could not raise",
    enemyRaw.ok === true && enemy.components && enemy.components.inserter === "burner-inserter"
    && !!(enemy.head || {}).sign_missing
    && player.ok === true && player.data.components.inserter !== "burner-inserter",
    JSON.stringify([enemyRaw.code, enemyRaw.ok, (enemy.components || {}).inserter,
      (enemy.head || {}).sign_missing, player.ok && player.data.components.inserter]).slice(0, 200));
}

// ---- a want whose source is not a recipe ----
// Space Age's asteroid chains are the live case: every chunk is caught from orbit by a collector, so
// the recipes named after them take more than they give, and a solver that treats a producer list as a
// source list will happily size a crusher as the supplier of the thing it eats. That is what
// `CYCLIC_RECIPE` used to mean here -- the walk's own route through a set with no door, reported as if
// the factory needed the resulting number.
{
  // `ice` is the case that makes the guard worth having rather than academic: the three recipes that
  // yield it all eat a chunk, and the 311st recipe on this install that yields ice is
  // `scrap-recycling`, which yields 0.05 of a chunk's worth of ice per shredded turret. The solver
  // used to plan an ice line out of trash, because the category filter that keeps disposal recipes out
  // of `producers` named `recycling` and the recycler's own category is `recycling-or-hand-crafting`.
  const ice = call("solve", { want: { item: "ice", rate_per_min: 60 }, allow_locked: true });
  // The other half of the same fix: chains that sit *behind* the loop. rocket, sulfur, sulfuric acid
  // and heavy oil all refused before this -- correctly about the graph, wrongly about the factory --
  // because a route exists that does not go through orbit at all.
  //
  // What is asserted here is that the solver no longer runs out of *recipe* for them, which is the
  // claim about cycles. It is not asserted that they plan outright on this save: `allow_locked` covers
  // recipes, and a chain that has to pump acid still needs a pumpjack somebody has researched, which is
  // a second axis and is refused by its own name below.
  for (const item of ["sulfur", "sulfuric-acid", "rocket", "heavy-oil", "uranium-235"]) {
    const r = call("solve", { want: { item, rate_per_min: 60 }, allow_locked: true });
  }
  const plannedLocked = call("solve", { want: { item: "iron-plate", rate_per_min: 60 },
    machines: { smelting: "foundry" }, allow_locked: true });
  // The same measured detail, through the window's own formatter. `blocked_by`, `net_per_craft` and
  // `demand_per_min` are three names that can be renamed on one side of the seam and say nothing at all
  // on the other, and this refusal is the one a Space Age player is most likely to meet.
  {
    const src = call("solve", { want: { item: "ice", rate_per_min: 120 }, allow_locked: true });
    const shown = call("gui_selftest", { render_refusal: { cmd: "plan", name: "ice",
      code: src.code, msg: src.msg, detail: src.detail } });
    const lines = asArr(shown.ok && shown.data.refuse_live && shown.data.refuse_live.render).map(enLine);
    // The number has to be the recipe's own intake at the asked-for rate, not a bare copy of the
    // target: 120 ice/min through `advanced-oxide-asteroid-crushing` (3 ice net per craft, 0.95 of a
    // chunk eaten per craft) is 38 chunks/min. Read off the source's own arithmetic, so a changed
    // `advanced-*` recipe moves this too -- which is the point of computing it at all.
    const wanted = asArr((src.detail || {}).candidates).find((c) => c.recipe === "advanced-oxide-asteroid-crushing") || {};
  }
}

// A lint warning a caller can act on, asserted by its name: a belt whose exit cell is off the card is
// legal (it hands to whatever is outside) but is the fact a designer needs to see when composing.
{
  const exiting = {
    name: "belt-exits",
    entities: [
      { name: "transport-belt", position: { x: 0.5, y: 0.5 }, direction: 4 },
      { name: "transport-belt", position: { x: 1.5, y: 0.5 }, direction: 4 },
    ],
  };
  const r = call("card_check", { card: exiting });
  const warnCodes = asArr(r.data && r.data.warnings).map((w) => w.code);
  check("a belt that leaves the card is a named warning, not silence",
    r.ok === true && warnCodes.includes("BELT_EXITS_CARD") && r.data.stats.belt_exits === 1,
    `${JSON.stringify(warnCodes)} exits=${r.data && r.data.stats && r.data.stats.belt_exits}`);
}
{
  // The arm and farm rigs build at one fixed coordinate and clear that ground FIRST -- the farm half also
  // repaints 35x35 tiles to soil and never puts them back. Honouring `surface` there meant doing that to
  // the map somebody named: a read-shaped API call that destroys a corner of a player's base. The drill and
  // pump rigs find ground on the named surface instead, so these two refuse rather than relocate -- and the
  // refusal is worth nothing unless the ground it would have cleared is still standing afterwards.
  const before = lua(`local s = game.surfaces["nauvis"]
local box = { { 124, 124 }, { 158, 158 } }
local n = 0
for _, e in ipairs(s.find_entities_filtered { area = box }) do n = n + 1 end
rcon.print(n)`);
  // 只剩臂这一台 rig 还在这条链上（钻/泵/田那三台随它们的功能一起删了）：它不许在别人玩的地上清场。
  for (const rig of ["arm_rate"]) {
    const r = call(rig, { surface: "nauvis", seconds: 1 });
    check(`${rig} refuses to clear a surface the caller named`,
      r.ok === false && r.code === "RIG_NEEDS_BENCH" && /bench/.test(String(r.msg)),
      `${r.code} ${String(r.msg).slice(0, 90)}`);
  }
  const after = lua(`local s = game.surfaces["nauvis"]
local box = { { 124, 124 }, { 158, 158 } }
local n = 0
for _, e in ipairs(s.find_entities_filtered { area = box }) do n = n + 1 end
rcon.print(n)`);
  check("...and the ground it refused to clear is exactly as it was found",
    String(before).trim() === String(after).trim(), JSON.stringify([before, after]));
}
{
  // A card that names one of the three vanilla products of advanced oil processing, with no machine
  // declared, is the shape `RECIPE_AMBIGUOUS` exists for: several recipes could yield it.
  const refine = JSON.parse(fs.readFileSync(path.join(__dirname, "card_refine.json"), "utf8"));
  const noRecipe = { ...refine, machine_recipes: undefined };
  const r = call("card_lab", { card: noRecipe, seconds: 2, speed: 20 });
  check("a fluid card whose recipe could be several things is refused by name",
    !r.ok && ["RECIPE_AMBIGUOUS", "RECIPE_UNFEEDABLE", "RECIPE_NOT_RESEARCHED", "CARD_DOES_NOT_LINT", "LAB_BUSY"].includes(r.code),
    `${r.code} ${JSON.stringify((r.detail || {}).candidates || "").slice(0, 70)}`);
  call("lab_reset");
}
{
  // Where the plan is measured and where the caller named are two different things, and a power plan
  // cannot be sized on ground that is already one grid. Saying which it used is the difference
  // between a fact and a coincidence: `card_fix_power` never read `surface` at all.
  const r = call("card_fix_power", { card: gear, surface: "nauvis" });
  const pp = call("power_plan", { card: gear, surface: "nauvis" });
}
{
  // `card_compose` reports the outer code and the per-slot reason inside it; the reason is the part
  // a caller can act on, so compare it as a value rather than as a substring of a dump.
  const r = call("card_compose", { slots: [{ card: { name: "nopos", entities: [{ name: "pipe" }] } }] });
  const errs = asArr(r.detail).flat ? [].concat(...asArr(r.detail).map((x) => Array.isArray(x) ? x : [x])) : asArr(r.detail);
}
{
  // Measured, and it narrows a promise: an assembling machine accepts `set_recipe` for a smelting
  // recipe without raising -- the engine checks the category when it crafts, not when it is told --
  // so `RECIPE_REJECTED` is not reachable on this install, while a furnace raises for having no
  // setter at all (smoke pins that one). What is checkable here is that the difference is reported
  // rather than swallowed.
  const mis = call("lab_start", { machine: "assembling-machine-1", recipe: "steel-plate", count: 1, seconds: 2 });
  check("a setter the engine accepts anyway is still reported as bound, not as a refusal",
    !mis.ok || typeof mis.data.recipes_bound === "number",
    mis.ok ? `bound=${mis.data.recipes_bound}` : `${mis.code} ${String(mis.msg).slice(0, 60)}`);
  // The probe above really starts a two-second job, and a lab holds one job at a time. Waiting for it
  // to finish is not politeness: a refusal that arrives as LAB_BUSY proves nothing about the rule
  // being checked, and reads as a broken guard.
  call("lab_stop", {});
  wait(2500);
  const bogus = call("lab_start", { machine: "stone-furnace", recipe: "iron-plate", ingredient: "not-an-item", count: 1, seconds: 2 });
  check("an ingredient that is not an item is refused rather than measured as a zero",
    !bogus.ok && bogus.code === "UNKNOWN_INGREDIENT",
    `${bogus.code} ${JSON.stringify((bogus.detail || {}).ingredients || "")}`);
  call("lab_reset");
}
{
  call("lab_reset");
  const lane = call("lab_card", { seconds: 3, speed: 20 });
  check("the lane rig runs as a job of its own", lane.ok === true, lane.ok ? `job ${lane.data.job}` : `${lane.code} ${lane.msg}`);
  const r = lane.ok ? call("card_freeze", {}) : lane;
  call("lab_reset");
}

// ---- the form: every way a player can fill it in wrong ----
{
  // The one that needs two real names: a miner cannot smelt. This is the refusal a player hits by
  // choosing the wrong row, so it has to carry the fix rather than just the NO.
  const wrong = call("plan_form", { item: "iron-plate", rate: 45, machine: "electric-mining-drill" });
  // The unit is a display choice; the number the solver sees is always per minute. Pinned here because
  // the whole reason `unit_shown` exists is that a caller must never wonder which it got.
  const perSec = call("plan_form", { item: "iron-plate", rate: 45, unit: "per_second" });
  const perMin = call("plan_form", { item: "iron-plate", rate: 45, unit: "per_minute" });
  const hourly = call("plan_form", { item: "iron-plate", rate: 1, unit: "per_hour" });
  const indexed = call("plan_form", { item_index: 1, rate: 1, unit_index: 1, machine_index: 1, module_index: 1 });
  // Row 1 of the item menu is the alphabetically first product this force can craft, which on this save
  // is `battery` -- not researched, so the honest answer is a refusal naming the technology. Asserting
  // that path is worth more than picking an index that happens to succeed: it is the click a player
  // makes first, and the message is what tells them to go research something.
  check("the menus' first rows mean per-second, any machine, no modules -- or they are refused outright",
    indexed.ok === false
    || (typeof indexed.data.sent.want.item === "string"
      && indexed.data.sent.machines === undefined && indexed.data.sent.modules === undefined
      && indexed.data.sent.want.rate_per_min === 60),
    JSON.stringify(indexed.data && indexed.data.sent.want));
}

// ---- fitting a plan into a box ----
{
  const box = { left_top: { x: 10, y: 10 }, right_bottom: { x: 40, y: 26 } };
  const base = { item: "iron-plate", rate: 300, lanes: 2, surface: "arch-sandbox", area: box };
  // The error message above promises "or a number of cells", and for as long as that sentence existed a
  // number was refused by it: the lookup only knew the three words, so the advice the refusal gave was a
  // second way to be refused. Now a non-negative integer IS a pitch, and the box arithmetic has to agree
  // with the number the caller named.
  const four = call("plan_fit", { ...base, spacing: 4 });
  // The box this block already made (10..40 by 10..26), in the same corner convention the answer uses --
  // remembered as a shape, not as a lane count, so a corrected footprint cannot turn this into a red suite.
  const BOXW = box.right_bottom.x - box.left_top.x;
  // A box too small for the plan is the player's business to decide, so the default lays what fits --
  // even when that is nothing -- and the answer says how many went down. `whole` is the opt-in
  // all-or-nothing, and it is the only mode that refuses here.
  const tiny = { left_top: { x: 10, y: 10 }, right_bottom: { x: 16, y: 12 } };
  const laysNothing = call("plan_fit", { ...base, lanes: 4, spacing: "loose", build: true, area: tiny });
  const noRoom = call("plan_fit", { ...base, lanes: 4, spacing: "loose", build: true,
    fit_mode: "whole", area: tiny });
  const bogusMode = call("plan_fit", { ...base, lanes: 2, fit_mode: "sideways", area: tiny });
  // The lane `plan_fit` fills a box with is a template of the row the plan counted, so a gear plan is
  // answered in gears. It used to refuse anything but smelting -- which was the honest answer then, and
  // a wall. Two walls came down since: the plan row (so a gear plan is fitted with a gear press) and the
  // fluid one (so a lane that drinks grows a row of pipe). What is asserted below is the shape that is left:
  // the answers are about the recipe asked for, and the refusals that remain are about the fluid, not about
  // the lane being smelting-only.
  const gears = call("plan_fit", { item: "iron-gear-wheel", rate: 60, lanes: 2,
    surface: "arch-sandbox", area: box });
  const gl = ((gears.data || {}).lane) || {};
  // A recipe that drinks TWO fluids: `sulfur` is water and petroleum-gas, and no fluid comes back out, so
  // the refusal is about the two rows a lane would have to keep apart -- not about the drain this mod does
  // not lay. (Sulfuric acid is *not* that case: it gives off a fluid as well, and the product refusal fires
  // a check earlier, which is the honest order.)
  const fluids = call("card_example", { recipe: "sulfur", machines: 2, machine: "chemical-plant",
    force: "player" });
  // The wall this file used to assert -- "a recipe that drinks a fluid cannot be laid at all" -- came down
  // when the lane grew a row of pipe. What a fluid lane answers with (the row, the port, the bench actually
  // drinking and producing) is asserted by `dev/fluid_line_e2e.js`, which grants the assembler and the
  // recipe it needs; a positive case does not belong here, where the save is whatever the sweep found.
  const drains = call("card_example", { recipe: "advanced-oil-processing", machines: 2, force: "player" });
  const bogus = call("card_example", { recipe: "no-such-recipe-here", force: "player" });
  check("and a recipe this install does not have is refused by name, not answered with smelting",
    !bogus.ok && bogus.code === "UNKNOWN_RECIPE" && bogus.detail.asked_for === "no-such-recipe-here",
    `${bogus.code} ${String(bogus.msg).slice(0, 70)}`);
  // The two paths have to disagree: plates still fit, so the answers above are about the recipe and not
  // about the method being broken.
  const plates = call("plan_fit", { item: "iron-plate", rate: 60, lanes: 2,
    surface: "arch-sandbox", area: box });
  // The two numbers a player is choosing between have to be consistent: lanes that fit, and the rate
  // those lanes actually deliver. A shortfall sentence that printed the wrong count once made a box
  // holding one lane of four claim "3 of 4 fit".
  const fit = call("plan_fit", { ...base, lanes: 9, spacing: "compact", build: false });
}

// ---- reading a box: what a rectangle can and cannot answer ----
{
  const big = call("region_scan", {
    surface: "arch-sandbox",
    area: { left_top: { x: -2000, y: -2000 }, right_bottom: { x: 2000, y: 2000 } },
  });
}

// ---- SITE_REJECTED: one code, three truths, and the panel has to tell them apart ----
{
  // This code sat on the DEFENSIVE list -- "no RCON input can build this guard" -- until it was
  // triggered from RCON by hand, which is the sentence's own refutation. Worse than being unreachable,
  // it was reachable and WRONG in a way no caller could act on: three origins wanting three different
  // advice (ground that was never generated; water; someone's chests) all came back as
  // `blockers = {<the entity this card was trying to place>}`, i.e. "your steel-chest is blocking your
  // steel-chest". So this block asserts the split, and feeds what the engine actually said into the
  // panel's formatter rather than into a hand-written copy of it.
  const FAR = { x: 4200.5, y: 4200.5 };       // outside every generated chunk on this save
  // Any frozen card will do, but "none is frozen" is a fact about the session rather than about this
  // guard, and a block that skips silently would report green while asserting nothing.
  const held = call("cards", {});
  const cards = asArr(held.ok && held.data.cards);
  const cardName = (cards[0] || {}).name;
  const ungenerated = call("card_place", { name: cardName, surface: "arch-sandbox", ghosts: true, origin: FAR });

  const field = lua(`local s = game.surfaces["arch-sandbox"]
for x = 28, 37 do for y = 28, 37 do
  pcall(function() s.create_entity { name = "steel-chest", position = { x = x + 0.5, y = y + 0.5 }, force = "player" } end)
end end
rcon.print("laid " .. #s.find_entities_filtered { name = "steel-chest", area = { { 27, 27 }, { 38, 38 } } })`);
  const collided = call("card_place", { name: cardName, surface: "arch-sandbox", ghosts: true,
    origin: { x: 30.5, y: 30.5 } });
  const tornUp = lua(`local s = game.surfaces["arch-sandbox"]
local n = 0
for _, e in ipairs(s.find_entities_filtered { name = "steel-chest", area = { { 27, 27 }, { 38, 38 } } }) do e.destroy(); n = n + 1 end
rcon.print("removed " .. n)`);
  const blockers = asArr((collided.detail || {}).blockers);
  // The measured detail, handed to the window's own renderer: what a player reads has to be a function
  // of what the engine said, not of what this file remembers the engine saying.
  const rendered = call("gui_selftest", { render_refusal: { cmd: "place", name: cardName,
    code: collided.code, msg: collided.msg, detail: collided.detail } });
  const rlines = asArr(rendered.ok && rendered.data.refuse_live && rendered.data.refuse_live.render).map(enLine);
  const grendered = call("gui_selftest", { render_refusal: { cmd: "place", name: cardName,
    code: ungenerated.code, msg: ungenerated.msg, detail: ungenerated.detail } });
  const glines = asArr(grendered.ok && grendered.data.refuse_live && grendered.data.refuse_live.render).map(enLine);
}

// ---- the ground a plan is aimed at ----
// Space Age reads `enabled` twice: whether you researched it, and whether the planet allows it. 36 of
// the 659 recipes here and 51 of the 1016 entities carry `surface_conditions`, and one of the recipes is
// `big-mining-drill` -- so an unread field did not crash anything, it just sized factories that can
// never be assembled where the player is standing. The two news are different and stay apart: hardware
// the planet will not build (carry it in) versus a recipe the planet will not run.
{
  const blind = call("solve", { want: { item: "iron-plate", rate_per_min: 60 } });
  const here = call("solve", { want: { item: "iron-plate", rate_per_min: 60 }, surface: "nauvis" });
  const rep = (here.data || {}).surface || {};
  // The same question on a different surface has to give different numbers, or the report is a
  // remembered nauvis wearing whatever the caller named.
  const other = call("solve", { want: { item: "iron-plate", rate_per_min: 60 }, surface: "arch-sandbox" });
  const bare = call("solve", { want: { item: "big-mining-drill", rate_per_min: 6 }, allow_locked: true });
  // `plan_fit` lays ghosts into a box on one surface, so the answer carries the report for THAT ground
  // -- the method that has the least excuse for staying quiet about it.
  const fit = call("plan_fit", { item: "iron-plate", rate: 300, lanes: 1, surface: "nauvis",
    area: { left_top: { x: 10, y: 10 }, right_bottom: { x: 60, y: 30 } } });
}

// ---- what the planet itself refuses, in the placement's own words ----
// 51 of the 1016 entities here carry `surface_conditions` too, and the engine enforces them through
// `can_place_entity` -- which answers a bare `false`, the same answer as "something is standing here"
// and as "this is water". A card refused on clear ground at the gravity of zero is refused by the
// PLANET, and the report has to say so. `wooden-chest` wants gravity at least 0.1 (measured, with a
// max written as the largest double rather than as no bound); no base-game surface in this save is that
// light, so the fixture moves the world with `set_property`, reads the entity's own bounds out of the
// prototypes rather than remembering them, and puts the gravity back -- the control is the same card
// placed again on the same ground at the gravity it came back to.
{
  const read = lua(`local s = game.surfaces["arch-sandbox"]
local e = prototypes.entity["wooden-chest"]
local sc = e.surface_conditions and e.surface_conditions[1]
if not sc then rcon.print("none") return end
rcon.print(table.concat({tostring(sc.property), tostring(s.get_property(sc.property)),
  tostring(sc.min or ""), tostring(sc.max or "")}, "|"))`);
  const [prop, was, minRaw] = String(read).split("|");
  const min = parseFloat(minRaw);
  check("the chest's own bound is readable from this install, with the gravity it needs",
    prop === "gravity" && Number.isFinite(min) && min > 0 && Number.isFinite(parseFloat(was)) && parseFloat(was) > min,
    `${read}`);
  const cardName = "gravity-chest";
  const fz = call("card_freeze", { card: { name: cardName,
    entities: [{ name: "wooden-chest", position: { x: 0.5, y: 0.5 } }] },
    name: cardName, allow_unmeasured: true });
  const place = () => call("card_place", { name: cardName, surface: "arch-sandbox", ghosts: true,
    origin: { x: 12, y: 12 } });
  lua(`game.surfaces["arch-sandbox"].set_property("gravity", ${min / 2})`);
  const low = place();
  lua(`game.surfaces["arch-sandbox"].set_property("gravity", ${was})`);
  const refused = asArr((low.detail || {}).wanted).concat(asArr((low.detail || {}).blockers));
  const shown = call("gui_selftest", { render_refusal: { cmd: "place", name: cardName,
    code: low.code, msg: low.msg, detail: low.detail } });
  const rl = asArr((shown.data || shown).refuse_live && (shown.data || shown).refuse_live.render).map(enLine);
  const wanted_sentence = "would place: #1 wooden-chest the planet refuses it: wants gravity at least "
    + min + ", here it is " + String(min / 2);
  const back = place();
  const tidied = lua(`local n = 0
for _, e in ipairs(game.surfaces["arch-sandbox"].find_entities_filtered { type = "entity-ghost" }) do e.destroy(); n = n + 1 end
rcon.print("ghosts removed " .. n .. " gravity " .. game.surfaces["arch-sandbox"].get_property("gravity"))`);
}

// ---- the shape word itself: a name the registry does not have is refused, not rounded to a neighbour ----
{
  // A word the styles registry does not know is refused by name, with the list of the ones it does:
  // a shape that quietly fell back to the default would lay the factory out in a pattern nobody picked.
  refuses("an unknown style names the styles there are", "card_example",
    { machines: 1, style: "hexagon-hive" }, "UNKNOWN_STYLE",
    (r) => check("  ...and the list it answers with is the registry's own, not a hardcoded sample",
      asArr((r.detail || {}).known).indexOf("two-row") >= 0, JSON.stringify((r.detail || {}).known)));
  refuses("an unknown way to face it is refused the same way", "card_example",
    { machines: 1, orientation: "diagonal" }, "UNKNOWN_ORIENTATION");
  // 点名的机器不许被背着换（和带子那一格同一条律）。从前这一个参数只是递给梯子的 `prefer`，
  // 名字跑不了这一类就换一支，答案只在英文那句里说 —— 于是"钉石炉做绿板"回来的是组装机，
  // 而这条线接下来口在哪一面、要几档臂、牌写什么，都由这次没打招呼的替换决定。
  {
    const pin = call("card_example", { recipe: "electronic-circuit", machines: 2, force: "player",
      machine: "stone-furnace" });
    check("  a machine the caller NAMED is refused by name, never swapped for the ladder's pick",
      pin.ok === false && pin.code === "MACHINE_ASKED_UNUSABLE"
        && (pin.detail || {}).asked_for === "stone-furnace"
        && String((pin.detail || {}).would_have_used || "").length > 0
        && /category/.test(String((pin.detail || {}).why || "")),
      JSON.stringify([pin.code, pin.detail]).slice(0, 260));
    check("  ...and the sentence says which machine it would have used and why that one was chosen",
      /stone-furnace/.test(String(pin.msg)) && /cannot run electronic-circuit/.test(String(pin.msg)),
      String(pin.msg).slice(0, 200));
    const pin2 = call("card_example", { recipe: "iron-plate", machines: 2, force: "player",
      machine: "assembling-machine-1" });
    check("  另一类也一样：铁板是熔炉梯子，点名组装机同样按名拒（不是走错梯子铺出一台做不了的东西）",
      pin2.ok === false && pin2.code === "MACHINE_ASKED_UNUSABLE", String(pin2.code));
    const okPin = call("card_example", { recipe: "electronic-circuit", machines: 2, force: "player",
      machine: "assembling-machine-1" });
    check("  点名的那台真能跑时就用它，且不报任何替换",
      okPin.ok === true && ((okPin.data || {}).components || {}).furnace === "assembling-machine-1"
        && !(okPin.data || {}).machine_swapped,
      JSON.stringify([okPin.code, (okPin.data || {}).components]).slice(0, 200));
  }
  refuses("a two-row style asked for one machine refuses, naming the count it needs",
    "card_example", { machines: 1, style: "two-row" }, "STYLE_NEEDS_UNITS",
    (r) => check("  ...and the numbers in the sentence are the plan's, not a sample",
      (r.detail || {}).min_units === 2 && (r.detail || {}).asked_for === 1,
      JSON.stringify([(r.detail || {}).min_units, (r.detail || {}).asked_for])))
}

// ---- refusals that needed a world to stand in, and what each one actually does ----
{
  // The pad is swept every time it is taken, so a patch laid here is gone before anything else
  // measures on it -- and `drill_rate` gets a surface whose densest iron patch is 4 tiles.
  lua(`local s = game.surfaces["arch-sandbox"]
for dx = 0, 1 do for dy = 0, 1 do
  pcall(function() s.create_entity { name = "iron-ore", position = { x = -20.5 + dx, y = -20.5 + dy }, force = "neutral" } end)
end end
rcon.print("pad iron tiles: " .. #s.find_entities_filtered { type = "resource", name = "iron-ore" })`);
  call("lab_reset");
}
{
  // An item claim the card's own in-ports cannot feed: refused before any game time is spent
  // measuring a machine that could never run the recipe.
  const gearCard = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));
  const misclaim = JSON.parse(JSON.stringify(gearCard));
  misclaim.contract = { outputs: { "copper-plate": 60 } };
  refuses("an item claim no in-port item can make is refused before the window opens", "card_lab",
    { card: misclaim, seconds: 3, speed: 20 }, "RECIPE_UNFEEDABLE");
  call("lab_reset");
}

// ---- the surface as a whole: no code arrives uninvited ----
// Chasing all seventy-odd codes with an assertion each would be theatre: several are guards whose
// input the caller cannot build through RCON at all. What is worth having is that the sets are
// *named* -- asserted, defended, or written down with the fixture they still need -- so a new
// refusal cannot slip in untested and unremarked.
{
  const lua_dir = path.join(__dirname, "..", "src", "architect");
  const src = fs.readdirSync(lua_dir).filter((f) => f.endsWith(".lua"))
    .map((f) => fs.readFileSync(path.join(lua_dir, f), "utf8")).join("\n");
  const emitted = new Set();
  for (const re of [/fail\("([A-Z][A-Z_0-9]+)"/g,
                    // `fail_key(code, key, params, msg, detail)` -- the same refusal, with the sentence
                    // available to the window in the reader's language. A scanner that only knew `fail(`
                    // would read these sites as codes the source stopped emitting, and the check below is
                    // precisely the one that shouts about that.
                    /fail_key\(\s*"([A-Z][A-Z_0-9]+)"/g,
                    /\bcode\s*=\s*"([A-Z][A-Z_0-9]+)"/g,
                    /\berror\s*=\s*"([A-Z][A-Z_0-9]+)"/g, /\breason\s*=\s*"([A-Z][A-Z_0-9]+)"/g,
                    /\bwhy\s*=\s*"([A-Z][A-Z_0-9]+)"/g, /"code":"([A-Z][A-Z_0-9]+)"/g,
                    /return nil,\s*"([A-Z][A-Z_0-9]+)"/g,
                    // `code or "COMPOSE_FAILED"`: the default a caller sees only when a leaf module
                    // returns nil without naming a reason, which is itself worth knowing about
                    /or\s+"([A-Z][A-Z_0-9]{3,})"/g,
                    // a code and its detail table in one call: `return nil, "X", { ... }`
                    /,\s*"([A-Z][A-Z_0-9]{3,})"\s*,\s*\{/g]) {
    let m; while ((m = re.exec(src))) emitted.add(m[1]);
  }
  // 扫哪些套件文件算"有人断言过这个码"。这份名单从前是手打的，于是它随每一次删除变成一份谎话清单：
  // 文件不在了，`existsSync` 跳过它，而它曾经钉住的那些码仍然被读成"已覆盖"。现在扫目录 —— 名单不
  // 再需要有人记得维护，删掉的套件在同一次删除里就停止作证。
  const suites = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith(".js") && !/^(call|lua|lines|suite-guard|gui_api_check|locale_check|bench_check|make_icon)\.js$/.test(f))
    .map((f) => f.replace(/\.js$/, ""));
  const said = new Set();
  for (const s of suites) {
    const f = path.join(__dirname, s + ".js");
    if (!fs.existsSync(f)) continue;
    // A line counts as asserting a code only where it compares one: a name mentioned in prose is
    // not a test, and `!==` (refusing to crash on a code) is not reaching it either.
    // A `why`/`reason` comparison counts for the same reason a `code` one does: half of these codes are
    // reasons carried INSIDE a refusal's detail (`FEED_ROW_TAKEN` under `LANE_FEED_ROW_UNREACHABLE`), and
    // a suite that pins which of them arrived is testing it as squarely as one that pins the outer code.
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      // 只在"这一行是在断言"时才算数。以 `if`/`while`/`return` 开头的行是在**处理**一个码 —— 例如
      // "有客户端连着时刷不动世界时钟，那就换个法子起这一测" —— 而不是钉住它该被拒。这个区别从前看不见，
      // 因为那份手打名单里恰好没有写这种行的文件；名单改成扫目录之后，它就把一条借口读成了一条证词。
      if (/^\s*(if|while|return|else|\}\s*else)\b/.test(line)) continue;
      // A `why`/`reason` comparison counts on the same terms: the line has to be comparing one, not
      // merely mentioning the word -- fixture data and prose name these strings too, and a gate that
      // believed those would start reporting codes as covered that nothing checks.
      if (!(/code/i.test(line) || /\.why\s*===/.test(line) || /reason\s*===/.test(line))
        || /!==/.test(line)) continue;
      for (const m of line.matchAll(/["\']([A-Z][A-Z_0-9]{2,})["\']/g)) said.add(m[1]);
    }
  }
  for (const c of COVERED) said.add(c);
  // Two different excuses, kept apart on purpose: DEFENSIVE is a guard no RCON input can build,
  // TODO is a refusal that is reachable and simply has no fixture yet. Calling the second one the
  // first would be the same mistake as not testing it, with a comment attached.
  const DEFENSIVE = {
    RUNTIME_ERROR: "the dispatcher's own pcall; asserting it would pin a bug. The malformed-input sweep above is what keeps it empty",
    PLAYER_ONLINE: "host.clock_policy refuses a world-clock warp while a client is connected, and a headless "
      + "box has no clients to connect -- the branch is one comparison against game.connected_players, and "
      + "proving it would need a second machine. What IS asserted everywhere is the clock note in the answer.",
    BAD_RESULT: "the envelope's type check on a method return; every M.* answers with a table",
    // The whole-plan press walks helmod's pages and asks `helmod_ghosts` for each one. Every answer that
    // is a refusal names itself, so the only way to reach this fallback is a page whose press returned
    // nothing at all -- which is `helmod_ghosts` being broken, not the plan being odd. It is kept because
    // a page that vanishes silently would be reported as "nothing to lay" and blamed on the player's
    // factory; naming the absence is the point.
    NO_ANSWER: "an `or` default behind a method that always answers with a table -- a broken build, not an input",
    SOLVE_FAILED: "an `or` default behind the solver's own named returns",
    SANDBOX_CREATE_FAILED: "one-shot per save at most: needs game.create_surface to raise, and the surface then exists",
    SANDBOX_UNAVAILABLE: "the same guard's unnamed branch, kept for a reason lab_surface has not reported yet",
    // `plan_fit` builds its lane from the plan's own row, so the lane makes what the row makes -- the
    // mismatch this guard describes can now only happen if the plan has a target with no row of its
    // own, and every such request the solver refuses first (NO_RECIPE_SOURCE / NO_UNLOCKED_RECIPE,
    // both asserted above). The branch stays because a caller who hands `plan_fit` a hand-written
    // `how_many` is one `or` away from it; what it no longer is, is a limitation of the layout.
    LANE_NOT_FOR_ITEM: "the default lane is smelting, and the row lookup now matches the plan's item -- reachable only past the solver's own refusals",
    NO_SANDBOX: "same door as above, from the methods that refuse rather than plan on the player's world",
    BENCH_UNAVAILABLE: "only fires when control.lua never wires measure.rig_bench -- a broken build, not a reachable answer; wiring it is asserted by every rig call that lands on arch-lab",
    SANDBOX_: "a prefix, not a code: SANDBOX_ .. why is how the generating/failed answers are built",
    UNAVAILABLE: "the suffix of that same pair, for a reason the bench has not reported yet",
    MEASUREMENT_ERRORED: "the tick runner raised; nothing here makes it raise on purpose",
    RUNNER_RAISED: "the same event on the card-lab runner",
    CARD_PLACE_FAILED: "a placement the engine refused after lint and can_place_entity both passed: a race, not an input",
    PLACE_FAILED: "the same engine refusal, counted per entity by verify.place",
    NO_LINE_SCALING: "the same flag that asks the solver for a per-row scaling is the one that reads it "
      + "back, so the branch only fires if solve stops answering line-* candidates -- a broken build, "
      + "not an input. The per-row plan itself is asserted in plan_rows_e2e.", 
    LAB_BUILD_FAILED: "the lane rig's placement failing after its own pre-check passed: a race",
    SUBGRAPH_TOO_LARGE: "a cycle guard on the capability walk; vanilla data does not cycle that far",
    NO_GENERATORS: "no prototype on the install produces electric energy: needs a modpack without power",
    NO_MINER: "an `or` default behind the solver's named returns",
    NOTHING_TO_LAYOUT: "entries that all resolve to nothing are refused by BAD_ARGS before the layout runs",
    UNKNOWN_ROLE: "a role name this mod does not define: only a code change can ask for one",
    BLUEPRINT_AUTHOR_FAILED: "the read-back of a blueprint item this mod just authored disagreeing with itself. The engine would have to drop objects from a geometry it accepted one call earlier; the OTHER way round is what is asserted above (`carry_real`), and the panel self-test runs the same round trip every save.",
    CARRY_FAILED: "the engine refusing to put a finished blueprint into a player's cursor. Reachable only with a client whose hand the game is somewhere else with -- and it reports what the cursor ended up holding, so the first real click names the call that said no rather than leaving a guess.",
    // The shortage bus weighs a candidate by the ITEM its recipe makes, and a recipe that makes no item
    // has nothing to weigh -- a box like that would subtract nothing from a target forever and every
    // machine on the lane would stay hungry for it. No recipe on this install reaches it: every one of the
    // eleven product-less recipes vanilla ships (`parameter-0` .. `parameter-9`, `recipe-unknown`) is
    // refused two checks earlier as UNKNOWN_RECIPE because it is not in the recipe db, and every recipe
    // that IS in the db with a fluid among its products is refused as LANE_CARRIES_NO_FLUIDS -- both
    // asserted in shortage_line_e2e. So this is a modded recipe's door, and the guard stays because the
    // alternative is a lane that never stops, silently.
    BUS_CANDIDATE_NOT_SHELVED: "a recipe in the db with no item product: vanilla's product-less recipes are not in the db, and its fluid-product ones are refused one check earlier -- both of those refusals ARE asserted",
    CURSOR_BUSY: "the guard that will not swap a blueprint in over whatever the player is holding. It reads the player's cursor, so no terminal input can build it: `card_carry` answers NO_PLAYER first, and that refusal is asserted above. Untested from here, and said so -- the sentence it renders is checked by the locale gate, the hand it refuses is not.",
    NO_HANDLER: "the panel's own dispatch guard: `gui_api` supplies a closure for every verb `G.build` renders, so a verb arriving with no handler means those two lists drifted -- which is exactly the rename this would otherwise swallow",
    SCAN_FAILED: "the one pcall around `surface.find_entities_filtered`: measured on this install, a valid surface with any well-formed area answers, so only a mid-call surface removal or an area the engine itself rejects would reach it -- and reaching it would still be reported rather than returned as an empty card",
    PROBE_TIMED_OUT: "discovery outlasting its game-time bound, which the measuring suites would have to sit through",
    RUN_NOT_PROVEN: "the discovery pass declining to guess a box it could not feed",
    BOX_TABLE_STALE: "the known box table disagreed with the engine, so the plan was rebuilt from scratch",
    LOST_SURFACE: "the surface a job was measured on disappeared underneath it",
    JSON_ENCODE_FAILED: "the transport envelope's own failure path; nothing that reaches it is unencodable",
    BOXES_ADJACENT_ON_ONE_FACE: "two inlets one cell apart on one face: no machine on this install is shaped that way",
    TOO_MANY_FLUIDS_ON_ONE_FACE: "three inlets on one face: same",
    SANDBOX_GENERATING: "every suite retries on it, so the path runs constantly and the refusal is never the thing under test",
    LAYOUT_FAILED: "an `or` default behind region.layout's own named reasons",
    PORTS_FAILED: "an `or` default behind machine_ports' named answers",
    NO_RUNS_BUILT: "a lab job whose fluid runs could not be laid, where the rig has no specific problem to name",
    OVERLAP: "a lint error code inside errors[], not a refusal envelope: every suite that lints a doubled entity exercises it",
    EMPTY: "a compose slot with no entities; the caller sees NOTHING_TO_COMPOSE with EMPTY inside, which is asserted above",
    ALL_LOCKED: "l1's reason when every recipe for an item is locked; callers use show_locked, which is asserted",
    EMPTY_PLAN: "the solver's no-nodes answer, reached only past every named leaf reason",
    NO_GENERATOR: "the sizing menu's no-produces-anything answer, behind NO_BUILDABLE_GENERATOR",
    BAD_RECIPE: "a recipe the solver cannot resolve, reached through machine_recipes rather than want",
    NO_SUCH_MACHINE: "a machine hint that is not an entity answers UNKNOWN_MACHINE, which is asserted above",
    // Measured on this install, both of these have no input that reaches them: of the 297 items a
    // non-disposal recipe puts out, every one is also net-yielded (products minus ingredients) by at
    // least one such recipe, so the walk never runs out of suppliers for want of a net sign, and no
    // module here has a negative `productivity` to take a net yield below zero. They are the answers
    // for a modded catalyst and a modded nerf, and both are one prototype away -- which is why they
    // name themselves instead of falling through to UNRESOLVED_INPUT, the generic this replaced.
    NO_NET_PRODUCER: "0 of 297 producible items on this install are net-consumed by every recipe that yields them",
    NET_YIELD_NOT_POSITIVE: "measured: 12 items carry module_effects here and the lowest productivity bonus among them is +0.04, so no set of modules can take a recipe's net yield to zero or below",
    RECIPE_REJECTED: "measured: an assembling machine accepts set_recipe for a smelting recipe without raising, so nothing on this install reaches the refusal; a furnace raises for having no setter at all, and smoke pins that path",
    NO_AVAILABLE_MACHINE: "every candidate for a category locked, from the solver's side",
    SANDBOX_CREATE_FAILED: "the concrete name the SANDBOX_ prefix builds when game.create_surface raises",
    SANDBOX_UNAVAILABLE: "the same, for a reason lab_surface has not reported yet",
    MACHINE_GONE: "a probe machine destroyed while its fluid run was being proved",
    SEAM_NOT_CONNECTED: "region.layout's answer when a placement claimed a seam the engine then refused",
    GROUND_REJECTED: "the same, when the ground under a proposed seam turns out not to take the run",
    NO_CORRIDOR_WITHIN_LIMIT: "no corridor within the search limit; seam_ask_e2e walks to this edge and asserts the proposal, not the name",
    NO_FREE_CELL_AT_SOURCE: "the cell beside the source port is taken before a run can start",
    UNKNOWN_PAGE: "reachable only from the window's nav row, and driven there: `gui_selftest` presses a page "
      + "name the window does not have and smoke asserts it is refused without moving the stored page",
    // The bug this replaced was the opposite of a refusal: `region_layout` planned the grid on the bench at
    // an origin found on the CALLER's surface, the bench refused the entities, `V.place`'s third result was
    // dropped, and an empty load list came back as `still_unserved = 0` -- "every machine is powered". Now
    // the refused placement is named.
    //
    // Measured, not assumed (2026-10-05, dev/lua.js against arch-sandbox): script `create_entity` SUCCEEDS
    // where a wall already stands and SUCCEEDS on deep water, so the two things that make it raise are an
    // unknown entity name and a position outside the surface -- and both are answered one check earlier, by
    // name: `power_plan` lints the card first (CARD_DOES_NOT_LINT) and its site search walks only in-bounds
    // areas, which a far origin proves (asked at x=y=1048575, answered NO_CLEAR_SITE). So this is the
    // answer for a surface that changes underneath the call, and reaching it needs a mid-call teardown of
    // the bench rather than a cleverer argument.
    PLAN_CARD_NOT_BUILT: "the planning surface refused entities at a site its own search handed back"
      + " -- measured: occupied cells and water are accepted by create_entity, so only an unknown name or"
      + " an out-of-bounds origin raise, and CARD_DOES_NOT_LINT / NO_CLEAR_SITE answer both first",
  };
  const TODO = {
    // The farm rig's doors that this install cannot reach. `NO_SUCH_SEED`, `SEED_GROWS_NOTHING` and
    // `NO_SUCH_TOWER` are NOT here -- farm_rate_e2e asks for all three by name, because each is one bad
    // argument away. What is left needs a different world rather than a different argument.
    PLANT_YIELDS_NOTHING: "a plant whose mineable_properties name no item product: every plant here does,"
      + " and the rig reads the product off the plant rather than remembering `yumako`",
    NO_SOIL_TO_TRY: "an install with no tile named after the plant or carrying `soil`, so the probe walk"
      + " has nothing to ask. The rig discovers the ground by asking it, which is the whole reason this"
      + " is a rig and not a table of tile names",
    NO_GROWER: "no placeable entity of the planter type: `roles.KINDS.grower` is the door, and"
      + " farm_rate_e2e proves the role answers on an install that has one",
    // The arm rig's doors. `NO_SUCH_ITEM` is not here -- arm_rate_e2e asks for it by name. The rest
    // want a different install rather than a different argument: a world with no inserter at all, no
    // container to drop into, or a bench square that refuses every column.
    NO_ARM_TO_MEASURE: "no placeable entity of the inserter type: a modpack without arms of any kind"
      + ". The tiers are enumerated from prototypes rather than remembered, so this is the answer for an"
      + " install where the enumeration comes back empty",
    NO_CHEST_TO_MEASURE: "no placeable container to act as source and destination. A belt cannot stand in"
      + " here: LuaTransportLine has no insert/add_item/can_insert on this install (all three raise), so"
      + " a script cannot keep a belt full and an arm measured against an empty tile is a slow-arm lie",
    NO_ROOM_FOR_ARMS: "every column of the bench square refused a chest-arm-chest triple after the square"
      + " was cleared -- the same shape as NO_ROOM_FOR_BELT, and only a walled-in bench gets there",
    NOTHING_CARRIED: "a tier that swung zero times after the rig moved its chests out to the spacing that"
      + " tier was looking at. Reachable only by an arm that needs something this rig does not know to"
      + " supply (a fluid, a fuel the drill's coal is not), and the row says which status it ended on --"
      + " which is the branch that found out arms are electric in 2.0 and that an inserter faces the side"
      + " it PICKS from, not the one it drops to",
    NO_ROOM_FOR_TOWER: "the bench plot centre refusing a tower after the square was swept and painted:"
      + " the same shape as NO_ROOM_FOR_BELT -- only a walled-in bench gets there",
    NO_FIELD_ON_MAP: "the same door, from the pump rig",
    NO_ROOM_FOR_BELT: "every drop tile of a placed drill blocked: the rig searches, so only a walled-in map reaches it",
    POWER_APPLY_DOES_NOT_LINT: "reachable in principle -- the coverage search can suggest a cell that "
      + "reads clear on the bench and lands on a machine once the poles are folded into the card -- but "
      + "no card on this save makes it happen, and the guard is exactly what that case is for: refuse, "
      + "do not hand back a card the engine would not build",

    NO_ROOM_FOR_TANK: "the pump ring's version; reached once by accident in an earlier session",
    NO_SITE_FOR_DRILL: "the rig's site search finding nothing legal on a patch that does exist",
    NO_SITE_FOR_PUMP: "same, pump side",
    NO_DRAINING_PATH: "a pump ring with no tank on any face",
    FLUID_NOT_SUPPLIED: "an ore whose required fluid fits nowhere beside the machine",
    ROW_REFUSED: "the belt line refusing after can_place said yes: a race",
    TANK_REFUSED: "same, tank side",
    BOX_NOT_FOUND: "a fluid that enters no box of a named machine: discovery now finds these rather than reporting them",
    NOT_SUSTAINABLE_BY_THIS_PAIR: "a load curve that fails exactly at the day-model boundary: reachable, and fiddly to land on",
    NO_SURFACE_FOR_DAY_MODEL: "the day model asked on a surface with no environment: needs a void surface none of these creates",
    NO_POLE_CANDIDATE: "no craftable, unlocked electric-pole anywhere: enemy comes close and the role still finds something placeable",
    NO_BUILDABLE_POLE: "the region planner's version of the same world",
    NO_MACHINE_FOR_CATEGORY: "every drill for an ore's category locked",
    NO_CATEGORY: "an ore with no resource_category at all: every vanilla resource has one",
    CANNOT_MEASURE_POLE: "the planning surface is the bench by construction, and the bench has no global grid: it is the answer for a future caller that names a converted surface",
    NO_RATE_FOR_MACHINE: "fluid_chain asked about a machine with no mining speed",
    NO_SINGLE_INGREDIENT: "the zero-ingredient branch: no vanilla recipe has no ingredients, so the reachable one is NOT_A_SINGLE_INGREDIENT_RECIPE",
    NO_FLUID_BOXES: "a machine with no boxes asked as if it had them: NO_RECIPE answers first on every machine tried",
    TRUNCATED: "a search that stopped early and said so: trunk_exhaust drives that boundary and reports the other verdicts",
    NOTHING_TO_WATCH: "a watch box with no crafting machine in it: line_watch_e2e drives it on an empty rectangle",
    NO_SUCH_ROW: "the plan table has no row for that product: plan_rows_e2e presses one that does not exist",
    NO_PLAN_YET: "×2 with nothing planned: the panel only renders the scale buttons next to a plan, so this guard is for a caller at a terminal",
    BENCH_PATCH_FAILED: "the wrapper over the reasons below; every one of them names itself in `detail.reason`",
    NO_SUCH_RESOURCE: "a resource entity this save has no prototype for: the extractor search answers NO_MINER_FOR_RESOURCE first",
    GENERATING: "the bench plot's chunks arriving: reachable only on a surface that has not generated yet, and it answers `call again`",
    PATCH_FAILED: "fewer than 25 of the 121 tiles could be laid: the plot is cleared and painted first, so this needs the engine to refuse its own ground",
    SCAN_FAILED_LATE: "the second look inside a watch box raising: the world would have had to change shape mid-window",
    // A wire is only drawn between two parts that arrived. `card_fits` has already refused the whole
    // card if any one part cannot be placed, so an endpoint missing at wiring time means the engine
    // changed its mind between the check and the create -- a race, on one part, in a card that fit. The
    // branch reports it per wire instead of pretending the line is there.
    // `card_example` measures its footprint from the parts it laid, so a card that reports none is a
    // card with no parts -- which `EMPTY_CARD` already refuses upstream. The guard stays because
    // `group_fit` divides by that number, and a division by a missing size is a runtime error rather
    // than an answer.
    // The feed row's own reasons, all of which are inside one refusal (`LANE_FEED_ROW_UNREACHABLE`) rather
    // than codes a caller branches on. All THREE of them have samples on this very install, and
    // `dev/fluid_line_e2e.js` pins each one by `detail.blocked.why`: a drinking lane of two machines puts
    // the shape's own arm in the row the run needs (`FEED_ROW_TAKEN`), a 3-wide plant whose box opens one
    // column off the middle puts an arm on the stub cell itself (`FEED_CELL_TAKEN`), and 双排 lays its
    // machine boxes on two lines (`FEED_SPAN_MULTIPLE_LINES`). This block used to claim two of the three
    // "no input on this install can build" -- that was a note about a suite that had already been deleted,
    // and a code an answer actually emits is not a guard nobody can reach.
    // The lane's own inlet row is adopted as the supply, so the only way its port is missing is a card
    // whose declared row_part was never placed -- and `card_place`/`verify.place` refuse that before a
    // lab job exists. The other half is asserted in `dev/fluid_line_e2e.js`: the row is joined, proven
    // through the machine's own box, and the lane produces -- which is the case that used to be read back
    // out of `supply_problems` as `CARD_ROW_NOT_FED` while the rig itself had never fed the machine.
    PORT_GONE: "the port pipe the card declared is not on the ground: a placement that did not put its"
      + " own parts down is refused before the rig is built, so this is a card that cannot reach it",
    NO_FEED_FACE: "the caller hands styles.fluid_feed a face that is not a cardinal; card_example only ever passes what ports.lookup answered with",
    NO_MACHINES_IN_SHAPE: "a shape with no machine in it to feed: card_example picks the crafter before it draws, so an empty lane is refused upstream as a count problem",
    // "水在背面"那一档：每台机器在臂行里要 F+P 个列位（臂不许重叠），3 格宽的组装机最多 3 只。
    // 在这一台安装上要走到这一步，得先有 3 档臂（香草只有 reach 1、2），而只有 2 档时更早一步就
    // 被 `ARM_TIER_MISSING` 拦下了 —— 所以这是一个为更宽/更窄的 mod 机器留着的守卫。
    ARM_COLUMNS_FULL: "the arm row runs out of columns (F feed arms + P product arms on one face, one column each): with the two reach tiers this install measures, the tier ladder refuses one step earlier, so only a shallower machine (2 columns) or a third arm tier lands here",
    // A machine that accepted `set_recipe` and then said something else. 2.0 RAISES for a name that does
    // not exist (the engine's own error, which the now-deleted fluid-row suite used to pin as its own
    // code -- nothing writes that code any more), so
    // this branch is for a setter that lies -- reachable only through a modded machine, and the note it
    // carries is the recipe the machine ended up on, which is what a player would need next.
    RECIPE_NOT_TAKEN: "the setter answered without error and the machine reads back a different recipe: no machine on this install does that, and the refusal quotes what it ended up on",
    // Counted and asserted as a number (`no_setter` on a furnace lane is 2, and nothing is refused), so
    // this is the one case where the outcome is tested and only the reason string is not compared.
    // Helmod's two doors. Both are about a neighbour mod being absent or broken, and this save HAS
    // helmod 2.2.13 (helmod_ghosts_e2e asserts the interface is present before anything else runs), so
    // the only way to reach them is to uninstall the mod while the suites are running. The third and
    // fourth codes in that family -- NOTHING_TO_LAY and HELMOD_NO_FACTORY -- ARE asserted there.
    HELMOD_NOT_INSTALLED: "no `helmod_interface` in the save; the gate asserts the interface IS here, so refusing for its absence cannot be reached on this install",
    HELMOD_NOT_AVAILABLE: "helmod is installed and get_models() raised anyway: a version mismatch inside a working mod, which nothing on this install produces",
    // Counted and asserted as a number (`no_setter` on a furnace lane is 2, and nothing is refused), so
    // this is the one case where the outcome is tested and only the reason string is not compared.
    NO_RECIPE_SETTER: "the string beside a count that IS asserted -- 2.0 gives a furnace no setter, and a lane of them reports no_setter=2 and refuses nothing",
    NO_FOOTPRINT: "the divisor guard under group_fit: unreachable while card_example measures the "
      + "footprint from its own parts and EMPTY_CARD refuses a card with none",
    END_NOT_PLACED: "a wire end whose entity did not arrive: `card_fits` refuses the card first, so this "
      + "is the race between that check and `create_entity`, and the refusal is quoted per wire",
    // 参数化那一档形状（`stacked`）的按名拒。`LINES_BEYOND_SHAPE` 已经从这份名单里出去了：
    // `dev/belt_head_e2e.js` 用最慢的带子 + 64 台把这条线的带行数顶到 3（一个面按量到的臂档只能叠 2），
    // 于是它不但被拒到，还顺量到了"落回下一个形状并且把换形写进答案"那条路。剩下这几道在这台安装上
    // 到不了：香草只有 reach 1、2 两档臂（"要第 3 档臂"要 5 种料以上的配方或更浅的机器才碰得到），
    // belt 模型每一档都有运力（只有 mod 的、模型里没数的那条带才会回 nil），而 `STYLE_CANNOT_LAY`
    // 是 ARM_TIER_MISSING 的孪生兜底 —— 同一件事在两层各说一次。
    ARM_TIER_MISSING: "a stacked line wants a row at distance d and no arm on this install reaches d: with two reach tiers (1,2) and a 3-deep machine, d never exceeds 2 -- a 5-material recipe or a shallower machine would reach it",
    BELT_CAPACITY_UNKNOWN: "the belt model has no throughput for that tier; every transport-belt prototype on this install answers one, so only a modded belt without a model row would reach it",
    STYLE_CANNOT_LAY: "the backstop under the parametric shape: `stacked` returns nil only for ARM_TIER_MISSING, which is checked before the style runs, so this is the unreachable twin of that refusal"
  };
  const all = [...emitted];
  const unaccounted = all.filter((c) => !said.has(c) && !DEFENSIVE[c] && !TODO[c]).sort();
  const covered_now = [...Object.keys(DEFENSIVE), ...Object.keys(TODO)].filter((c, i, a) => a.indexOf(c) === i).filter((c) => emitted.has(c) && said.has(c));
  check("and nothing sits on a list that a suite has already started covering", covered_now.length === 0,
    covered_now.join(", ") || "every listed code is still unasserted");
  // Names the source builds rather than writes: `"SANDBOX_" .. why` has no literal to match, so the
  // concrete answers it can produce are allowed by prefix.
  const DERIVED_OK = /^(SANDBOX_|$)/;
  const gone = [...Object.keys(DEFENSIVE), ...Object.keys(TODO)]
    .filter((c) => !emitted.has(c) && !/^SANDBOX_$/.test(c) && !DERIVED_OK.test(c.slice(0, 8)));
}

console.log(results.join("\n"));
console.log(fails === 0 ? "\nthe refusal surface behaves" : `\n${fails} refusal check(s) failed`);
process.exit(fails ? 1 : 0);
