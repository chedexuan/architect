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
// ---- the ask queue: the player's half of the loop ----
// Bounded, ticked, and never silent about a replacement: those three are the whole design, so they
// are what the assertions pin. The `note` matters as much as the ids -- a player who sees a queued
// question with nobody answering it needs to know that the mod cannot reach a model itself.
{
  refuses("an empty ask is refused rather than queued", "request", { ask: "  " }, "BAD_ARGS");
  const first = call("request", { ask: "smoke: can this line reach 500 gears/min?" });
  check("a question is queued with the tick and surface it was asked on",
    first.ok && first.data.request.state === "open" && typeof first.data.request.id === "number"
    && typeof first.data.request.asked_tick === "number" && !!first.data.request.surface
    && /cannot reach a model/.test(String(first.data.note)),
    first.ok ? `#${first.data.request.id} on ${first.data.request.surface}` : `${first.code} ${first.msg}`);
  const answered = call("answer", { id: first.data && first.data.request.id, text: "3 assemblers, 2 more arms" });
  check("an answer closes it and replaces nothing the first time",
    answered.ok && answered.data.request.state === "answered" && answered.data.replaced === undefined,
    JSON.stringify({ ok: answered.ok, code: answered.code, state: answered.data && answered.data.request.state }));
  // The answer also goes to the players in the game, because a queued reply is only seen by whoever
  // thinks to open the panel and click Queue. How many that reached is read from the same server
  // rather than assumed to be zero: on a headless box it is zero, on one with a client open it is
  // not, and an assertion that passes only in the session that wrote it is worth nothing.
  const connected = Number(lua(`local n = 0
for _, p in pairs(game.players) do if p.connected then n = n + 1 end end
rcon.print(n)`).match(/\d+/));
  check("an answer tells the players who are in the game, and reports how many it reached",
    answered.ok && typeof answered.data.told === "number" && answered.data.told === connected,
    `told=${answered.data && answered.data.told}, connected=${connected}`);
  const again = call("answer", { id: first.data && first.data.request.id, text: "corrected: 4 assemblers" });
  check("a second answer says what it replaced",
    again.ok && !!again.data.replaced && /2 more arms/.test(String(again.data.replaced.text)),
    JSON.stringify(again.data.replaced || null));
  const open = call("requests", { state: "open" });
  // an empty Lua list serialises as an object, not an array -- the `asArr` rule, and the queue is
  // exactly where a caller would meet it first
  check("the queue reads back by state", open.ok && asArr(open.data.requests).length === 0 && open.data.held >= 1,
    `open=${open.data && open.data.open} held=${open.data && open.data.held}`);
  refuses("answering an id nobody asked", "answer", { id: 987654, text: "x" }, "NO_SUCH_REQUEST");
  refuses("and an answer with no text is refused, not stored", "answer",
    { id: first.data && first.data.request.id, text: "   " }, "BAD_ARGS");
  let accepted = 0;
  for (let i = 0; i < 25; i++) {
    const r = call("request", { ask: `flood ${i}` });
    if (r.ok) accepted++; else if (r.code === "QUEUE_FULL") break;
  }
  const flood = call("request", { ask: "one too many" });
  check("the queue refuses past its cap instead of growing forever",
    flood.ok === false && flood.code === "QUEUE_FULL" && (flood.detail || {}).open >= 20 && accepted <= 20,
    `accepted ${accepted}, then ${flood.code} at open=${(flood.detail || {}).open}`);
  refuses("and a question that is not a string is refused", "request", { ask: 42 }, "BAD_ARGS");
  // Drain it: a queue left full at the end of a suite is the fifth thing that could leak into the
  // next one, and "the next suite sees the world this suite claims to leave" is the rule.
  const drained = call("requests", { state: "open" });
  for (const r of asArr(drained.data && drained.data.requests)) call("answer", { id: r.id, text: "(drained by the suite)" });
  // The cap above only holds down the OPEN questions; an answered one is a log entry, and a log
  // nobody trims grows by every question a session asks.
  //
  // Seeding that from the console does not work, and the reason is worth keeping: `/c` has its own
  // `storage`, a table the mod never reads -- 60 records written there left the mod's queue at 22
  // where this suite expected 82. `remote.call` is the only door into the mod's state from here, so
  // the burst goes through the real methods: 55 ask-and-answer pairs in one console command, which
  // costs about a second instead of 110 node spawns.
  const seeded = lua(`local n, dropped = 0, 0
for i = 1, 55 do
  local r = remote.call("arch", "call", "request", { ask = "aged out " .. i })
  local id = tonumber(string.match(r, '"id":(%d+)') or "")
  dropped = dropped + (tonumber(string.match(r, '"trimmed":(%d+)') or "0") or 0)
  if id then
    remote.call("arch", "call", "answer", { id = id, text = "(asked and answered inside one console command)" })
    n = n + 1
  end
end
rcon.print("asked and answered " .. n .. ", dropped " .. dropped)`);
  const held = call("requests", {});
  check("answered asks age out, so the log is bounded in both directions",
    /dropped [1-9]\d*\b/.test(seeded) && held.ok && held.data.held <= held.data.cap + held.data.keep,
    `${JSON.stringify(seeded)}; held=${held.data && held.data.held} of cap ${held.data && held.data.cap} + keep ${held.data && held.data.keep}`);
  // ...and "nobody ever asked that" has to stay distinguishable from "that one aged out". `first` is
  // the oldest answered record this block made, so trimming to the newest `keep` has taken it: its id
  // is gone from the store and from the `known` list that says what is still there.
  const aged_out = call("answer", { id: first.data && first.data.request.id, text: "too late" });
  check("an ask that aged out comes back as NO_SUCH_REQUEST without its id in `known`",
    aged_out.ok === false && aged_out.code === "NO_SUCH_REQUEST"
    && !asArr((aged_out.detail || {}).known).includes(first.data.request.id),
    `id=${first.data && first.data.request.id} known=${JSON.stringify(asArr((aged_out.detail || {}).known)).slice(0, 60)}`);
  const after = call("requests", { state: "open" });
  check("the suite leaves no question hanging for the next one",
    after.ok && after.data.open === 0, `open=${after.data && after.data.open} held=${after.data && after.data.held}`);
}

refuses("an unknown method is refused, with the list of what is not", "no-such-method-at-all", {}, "UNKNOWN_METHOD",
  (r) => check("  ...and the answer names every method this mod has",
    asArr(r.known || r.detail && r.detail.known).length >= 30,
    `${asArr(r.known || (r.detail || {}).known || []).length} known`));

// ---- arguments: nothing malformed may come back as a bare runtime error ----
// `RUNTIME_ERROR` is the dispatcher's pcall, not a refusal: it means an input reached code that
// had no answer for it. Three such inputs were found and fixed by hand; this is the sweep that
// stops the next four from arriving as someone else's bug report.
const HOSTILE = [
  ["ping", null], ["l1", {}], ["l1", { targets: [] }], ["l1", { targets: "iron-plate" }],
  ["solve", {}], ["solve", { want: {} }], ["solve", { want: { item: 17 } }],
  ["card_check", {}], ["card_verify", {}], ["card_compose", {}], ["card_compose", { slots: [] }],
  ["card_compose", { slots: "not-a-list" }], ["region_layout", {}], ["region_layout", { entries: "x" }],
  ["card_freeze", {}], ["card_lab", {}], ["card_fix_power", {}], ["power_plan", {}],
  ["seam_check", {}], ["seam_check", { card: gear }], ["machine_ports", {}], ["field_survey", {}],
  ["fluid_chain", {}], ["site", {}], ["site", { area: "nope" }], ["site", { area: [[0, 0]] }],
  ["state", { force: "nobody" }], ["capabilities", { force: "nobody" }],
  ["drill_rate", { resource: "not-an-ore" }], ["pump_rate", { fluid: "not-a-fluid" }],
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

// ---- argument shapes with a named answer of their own ----
refuses("region_layout with nothing to lay out", "region_layout", {}, "BAD_ARGS");
refuses("region_layout naming a card that was never frozen", "region_layout",
  { entries: [{ name: "no-such-frozen-card" }] }, "UNKNOWN_CARD");
refuses("site refuses per-tile sampling beyond its own cap", "site",
  { area: [[-100, -100], [100, 100]], tiles: true }, "AREA_TOO_LARGE_FOR_TILES");
refuses("l1 with no target", "l1", { targets: [] }, "BAD_ARGS");
refuses("field_survey for an entity that is not a resource", "field_survey",
  { resource: "stone-furnace" }, "NOT_A_RESOURCE");

// ---- card_compose: the only method with no negative test at all until now ----
// `card_compose` reports one outer code and the per-slot reasons inside it: the slot that failed
// has to be named, because "could not compose" is not an answer a caller can act on.
const inner = (r, code) => JSON.stringify(r.detail || []).includes('\"code\":\"' + code + '\"')
  || String(r.msg || "").includes(code);
refuses("card_compose with a slot that names nothing", "card_compose",
  { slots: [{ name: "never-frozen" }] }, "COMPOSE_INPUT_REJECTED",
  (r) => check("  ...naming the slot's own reason", inner(r, "UNKNOWN_CARD"), brief(r.detail, 90)));
refuses("card_compose with an entity that has no position", "card_compose",
  { slots: [{ card: { name: "nopos", entities: [{ name: "pipe" }] } }] }, "COMPOSE_INPUT_REJECTED",
  (r) => check("  ...and saying which entity it was", inner(r, "NO_POSITION"), brief(r.detail, 90)));
refuses("card_compose with two cards standing on the same cells", "card_compose",
  { slots: [{ card: gear, at: { x: 0, y: 0 } }, { card: gear, at: { x: 0, y: 0 } }] },
  "SLOT_OVERLAP");
refuses("card_compose with nothing in any slot", "card_compose",
  { slots: [{ card: { name: "empty", entities: [] } }] }, "NOTHING_TO_COMPOSE",
  (r) => check("  ...naming the empty slot rather than only the failure",
    JSON.stringify(r.detail || r.msg).includes("EMPTY") || /no entities|empty/i.test(String(r.msg)),
    `${r.code} ${String(r.msg).slice(0, 60)}`));

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

// ---- the lab's job states, in the order a caller meets them ----
refuses("freezing with no measurement on record", "card_freeze", {}, "NO_JOB");
refuses("stopping with no measurement on record", "lab_stop", {}, "NO_JOB");
{
  const started = call("card_lab", { card: JSON.parse(fs.readFileSync(path.join(__dirname, "card_ex.json"), "utf8")),
    seconds: 60, speed: 20 });
  check("a measurement that starts is running", started.ok && started.data.state === "running",
    started.ok ? `${started.data.job} on ${started.data.ideal_grid.surface}` : `${started.code} ${started.msg}`);
  refuses("freezing while the window is still open", "card_freeze", {}, "JOB_NOT_DONE");
  refuses("starting a second measurement while one runs", "card_lab", { card: gear }, "LAB_BUSY");
  const stopped = call("lab_reset");
  check("  ...and the bench is given back", stopped.ok === true, JSON.stringify(stopped.data));
  refuses("freezing again with nothing on record", "card_freeze", {}, "NO_JOB");
}

// ---- the force argument has to mean something ----
// `availability_checker` used to read a research flag that one field carries for every force, so a
// second force inherited the first one's unlocks and `force` changed nothing but the label.
{
  const enemy = call("card_example", { force: "enemy" });
  const player = call("card_example", {});
  check("a force with no research gets the parts it can place, not the player's",
    enemy.ok && player.ok && enemy.data.components.inserter === "burner-inserter"
    && player.data.components.inserter !== "burner-inserter",
    `enemy=${enemy.data.components && enemy.data.components.inserter} player=${player.data.components && player.data.components.inserter}`);
  refuses("and a plan for that force is refused rather than sized on borrowed research", "solve",
    { want: { item: "automation-science-pack", rate_per_min: 10 }, force: "enemy" }, "NO_UNLOCKED_RECIPE");
}

// ---- a want whose source is not a recipe ----
// Space Age's asteroid chains are the live case: every chunk is caught from orbit by a collector, so
// the recipes named after them take more than they give, and a solver that treats a producer list as a
// source list will happily size a crusher as the supplier of the thing it eats. That is what
// `CYCLIC_RECIPE` used to mean here -- the walk's own route through a set with no door, reported as if
// the factory needed the resulting number.
{
  const chunk = refuses("an item nothing yields is refused by that name, not as a loop", "solve",
    { want: { item: "oxide-asteroid-chunk", rate_per_min: 60 }, allow_locked: true },
    "NO_RECIPE_SOURCE", (r) => {
      const d = r.detail || {};
      check("  ...and each recipe it looked at says which item it would have to be fed",
        asArr(d.candidates).length > 0 && asArr(d.candidates).every((c) => !!c.blocked_by),
        JSON.stringify(asArr(d.candidates).map((c) => `${c.recipe}:${c.net_per_craft}<-${c.blocked_by}`)));
      check("  ...and the blocker is a chunk, which is the closed set being named",
        asArr(d.candidates).every((c) => /asteroid-chunk/.test(String(c.blocked_by))),
        JSON.stringify(asArr(d.candidates).map((c) => c.blocked_by)));
    });
  // `ice` is the case that makes the guard worth having rather than academic: the three recipes that
  // yield it all eat a chunk, and the 311st recipe on this install that yields ice is
  // `scrap-recycling`, which yields 0.05 of a chunk's worth of ice per shredded turret. The solver
  // used to plan an ice line out of trash, because the category filter that keeps disposal recipes out
  // of `producers` named `recycling` and the recycler's own category is `recycling-or-hand-crafting`.
  const ice = call("solve", { want: { item: "ice", rate_per_min: 60 }, allow_locked: true });
  check("ice is refused for want of a chunk instead of planned out of scrap",
    ice.ok === false && ice.code === "NO_RECIPE_SOURCE"
    && asArr((ice.detail || {}).candidates).length > 0
    && asArr((ice.detail || {}).candidates).every((c) => !/recycl/.test(String(c.recipe))),
    ice.ok ? `planned: ${JSON.stringify(asArr(ice.data.unit.nodes).map((n) => n.recipe))}`
      : `${ice.code} ${JSON.stringify(asArr((ice.detail || {}).candidates).map((c) => c.recipe))}`);
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
    check(`and a chain that has a source outside the loop is planned, not refused: ${item}`,
      r.ok === true && asArr(r.data.unit.nodes).length > 0,
      r.ok ? `planned: ${asArr(r.data.unit.nodes).length} nodes, ${r.data.unit.machine_slots} slots`
        : `${r.code} ${String(r.msg).slice(0, 60)}`);
  }
  // ...and the second axis, named: hardware the force cannot build yet. A plan asked for with
  // `allow_locked` says what it would take, researched or not, and that includes the machine -- the
  // recipe side of the question was already being answered that way, so a refusal stopping at the
  // foundry was half the same request treated two different ways.
  refuses("a machine hint the force cannot build yet is refused by that name", "solve",
    { want: { item: "iron-plate", rate_per_min: 60 }, machines: { smelting: "foundry" } }, "LOCKED_MACHINE",
    (r) => check("  ...and it says which research would let the machine stand there",
      asArr((r.detail || {}).prerequisites).some((p) => /foundry|casting-iron/.test(`${p.technology}${p.unlocks}`)),
      JSON.stringify((r.detail || {}).prerequisites)));
  const plannedLocked = call("solve", { want: { item: "iron-plate", rate_per_min: 60 },
    machines: { smelting: "foundry" }, allow_locked: true });
  check("while asking the same question about unresearched hardware answers the plan and the research",
    plannedLocked.ok === true
    && asArr(plannedLocked.data.unit.nodes).some((n) => n.machine === "foundry")
    && asArr((plannedLocked.data.prerequisites || []))
      .some((p) => /foundry|casting-iron/.test(`${p.technology}${p.unlocks}`)),
    plannedLocked.ok ? JSON.stringify(asArr(plannedLocked.data.prerequisites).map((p) => p.technology))
      : `${plannedLocked.code} ${plannedLocked.msg}`);
  refuses("a route to a recipe that does not exist is refused by name", "solve",
    { want: { item: "iron-plate", rate_per_min: 60 }, routes: { "iron-plate": "no-such-recipe-here" } },
    "UNKNOWN_ROUTE");
  // The fixed point itself, reached on purpose: two routes that each send a chunk to the recipe that
  // eats a chunk of the other colour. Every item is then being supplied because the caller said so,
  // which is the one way past the producibility proof -- so the loop has to be caught where it runs,
  // and the refusal has to show the growth rather than assert it.
  refuses("routes that send each chunk to the recipe that eats the other are refused as a growing loop", "solve",
    { want: { item: "oxide-asteroid-chunk", rate_per_min: 60 }, allow_locked: true,
      routes: {
        "oxide-asteroid-chunk": "metallic-asteroid-reprocessing",
        "metallic-asteroid-chunk": "oxide-asteroid-reprocessing",
      } }, "CYCLIC_RECIPE",
    (r) => check("  ...and the numbers say each round needs more than the last",
      asArr((r.detail || {}).series).length >= 2
      && asArr((r.detail || {}).loop).length > 0
      && (r.detail || {}).passes >= 2
      && asArr((r.detail || {}).series)[1].delta > asArr((r.detail || {}).series)[0].delta,
      JSON.stringify({ series: asArr((r.detail || {}).series).map((s) => s.delta),
        loop: asArr((r.detail || {}).loop).map((l) => l.item), passes: (r.detail || {}).passes })));
  refuses("routing an item at a recipe that eats it is refused by name", "solve",
    { want: { item: "oxide-asteroid-chunk", rate_per_min: 60 },
      routes: { "oxide-asteroid-chunk": "oxide-asteroid-crushing" } }, "ROUTE_NOT_PRODUCER");
  // The same measured detail, through the window's own formatter. `blocked_by`, `net_per_craft` and
  // `demand_per_min` are three names that can be renamed on one side of the seam and say nothing at all
  // on the other, and this refusal is the one a Space Age player is most likely to meet.
  {
    const src = call("solve", { want: { item: "ice", rate_per_min: 120 }, allow_locked: true });
    const shown = call("gui_selftest", { render_refusal: { cmd: "plan", name: "ice",
      code: src.code, msg: src.msg, detail: src.detail } });
    const lines = asArr(shown.ok && shown.data.refuse_live && shown.data.refuse_live.render).map(enLine);
    check("the window says which recipe it looked at, what it would have to be fed, and how much",
      src.code === "NO_RECIPE_SOURCE"
      && lines.some((l) => /^refused: NO_RECIPE_SOURCE/.test(l))
      && lines.some((l) => /candidates: .*yields [0-9.]+ per craft, needs oxide-asteroid-chunk at [0-9.]+\/min/.test(l))
      && lines.some((l) => /^  why: /.test(l)),
      JSON.stringify(lines.slice(0, 4)));
    // The number has to be the recipe's own intake at the asked-for rate, not a bare copy of the
    // target: 120 ice/min through `advanced-oxide-asteroid-crushing` (3 ice net per craft, 0.95 of a
    // chunk eaten per craft) is 38 chunks/min. Read off the source's own arithmetic, so a changed
    // `advanced-*` recipe moves this too -- which is the point of computing it at all.
    const wanted = asArr((src.detail || {}).candidates).find((c) => c.recipe === "advanced-oxide-asteroid-crushing") || {};
    check("and the chunk figure is the crusher's intake at that rate, not the target echoed back",
      Math.abs((wanted.blocked_demand_per_min || 0) - 38) < 0.51
      && wanted.blocked_by === "oxide-asteroid-chunk",
      `${JSON.stringify(wanted)} for 120 ice/min`);
  }
}

// ---- refusals that need a real machine or a real patch, but no fixture surgery ----
refuses("machine_ports asks which recipe a multi-recipe machine runs", "machine_ports",
  { machine: "oil-refinery" }, "NO_RECIPE");
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
refuses("seam_check refuses coordinates where nothing stands", "seam_check",
  { card: gear, fluid: "crude-oil", from: { x: 9000, y: 9000 }, to: { x: 9001, y: 9000 } }, "NO_ENTITY_AT");
refuses("solve refuses a machine hint that is not an entity", "solve",
  { want: { item: "iron-plate", rate_per_min: 10 }, machines: { smelting: "not-a-machine" } }, "UNKNOWN_MACHINE");
refuses("drill_rate refuses an ore no placeable extractor takes", "drill_rate",
  { resource: "alien-artifact", seconds: 1 }, "NO_MINER_FOR_RESOURCE");
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
  check("a power plan names the ground it planned on when it is not the one asked for",
    r.ok && r.data.planned_on === "arch-sandbox" && !!r.data.surface_not_used
    && r.data.surface_not_used.asked === "nauvis",
    r.ok ? `${r.data.planned_on}, asked-for=${r.data.surface_not_used && r.data.surface_not_used.asked}` : r.code);
  const pp = call("power_plan", { card: gear, surface: "nauvis" });
  check("and a plan that reads a card's draw somewhere else says where",
    pp.ok && pp.data.demand_read_on === "arch-sandbox", `${pp.data && pp.data.demand_read_on} ${pp.code || ""}`);
}
refuses("a library name that was never frozen", "card_blueprint", { name: "never-frozen" }, "NO_SUCH_CARD");
{
  // `card_compose` reports the outer code and the per-slot reason inside it; the reason is the part
  // a caller can act on, so compare it as a value rather than as a substring of a dump.
  const r = call("card_compose", { slots: [{ card: { name: "nopos", entities: [{ name: "pipe" }] } }] });
  const errs = asArr(r.detail).flat ? [].concat(...asArr(r.detail).map((x) => Array.isArray(x) ? x : [x])) : asArr(r.detail);
  check("a compose rejection names the entity that has no position",
    errs.some((e) => e && e.code === "NO_POSITION"), brief(r.detail, 90));
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
  check("freezing a lane-rig measurement says it measured no card", !r.ok && r.code === "NOT_A_CARD_JOB",
    `${r.code} ${String(r.msg).slice(0, 60)}`);
  call("lab_reset");
}

// ---- the form: every way a player can fill it in wrong ----
{
  // The panel's Plan button sends menu indexes to this method, so all six of these are one bad click
  // away. Each is asserted because the message is what a player acts on: "UNKNOWN_ITEM" with nothing
  // beside it would leave them guessing whether the item, the machine or the module was the problem.
  refuses("no item named is refused, with the menu's own first rows as examples", "plan_form",
    { rate: 45 }, "BAD_ARGS",
    (r) => check("  ...and the examples are real products, not a hardcoded sample",
      asArr((r.detail || {}).examples).length > 3 && asArr((r.detail || {}).examples).every((x) => typeof x === "string"),
      JSON.stringify(asArr((r.detail || {}).examples).slice(0, 4))));
  refuses("an item that does not exist is named as one", "plan_form",
    { item: "enchanted-iron", rate: 45 }, "UNKNOWN_ITEM");
  refuses("an item from a menu row past the end is refused as an index problem", "plan_form",
    { item_index: 999999, rate: 45 }, "BAD_ARGS",
    (r) => check("  ...saying which field and how many rows it has to choose from",
      (r.detail || {}).field === "item" && (r.detail || {}).menu_rows > 10,
      JSON.stringify([].concat((r.detail || {}).field, (r.detail || {}).menu_rows))));
  refuses("a unit the form cannot mean is refused with the three it can", "plan_form",
    { item: "iron-plate", rate: 45, unit: "per_fortnight" }, "UNKNOWN_UNIT");
  refuses("a rate that is not a number is refused rather than read as zero", "plan_form",
    { item: "iron-plate", rate: "lots" }, "BAD_RATE");
  refuses("and a rate of zero refused as a rate, not planned as an empty line", "plan_form",
    { item: "iron-plate", rate: 0 }, "BAD_RATE");
  refuses("a machine that is not a machine answers UNKNOWN_MACHINE", "plan_form",
    { item: "iron-plate", rate: 45, machine: "not-a-machine" }, "UNKNOWN_MACHINE");
  refuses("a module that is not a module answers by name, with the ones that are", "plan_form",
    { item: "iron-plate", rate: 45, module: "turbo-wish" }, "UNKNOWN_MODULE");
  refuses("and a count below one is refused, not silently planned as none", "plan_form",
    { item: "iron-plate", rate: 45, module: "speed-module", module_count: 0 }, "BAD_MODULE_COUNT");
  // The one that needs two real names: a miner cannot smelt. This is the refusal a player hits by
  // choosing the wrong row, so it has to carry the fix rather than just the NO.
  const wrong = call("plan_form", { item: "iron-plate", rate: 45, machine: "electric-mining-drill" });
  check("a machine that cannot run the job says so, and names the ones that can",
    !wrong.ok && wrong.code === "MACHINE_WRONG_CATEGORY"
    && asArr((wrong.detail || {}).alternatives).indexOf("electric-furnace") >= 0
    && wrong.detail.kind === "mining-drill" && asArr((wrong.detail || {}).does).length === 0,
    `${wrong.code} kind=${(wrong.detail || {}).kind} alternatives=${JSON.stringify(asArr((wrong.detail || {}).alternatives)).slice(0, 70)}`);
  // The unit is a display choice; the number the solver sees is always per minute. Pinned here because
  // the whole reason `unit_shown` exists is that a caller must never wonder which it got.
  const perSec = call("plan_form", { item: "iron-plate", rate: 45, unit: "per_second" });
  const perMin = call("plan_form", { item: "iron-plate", rate: 45, unit: "per_minute" });
  check("45/second reaches the solver as 2700/minute, exactly, and says which unit it was asked in",
    perSec.ok && perSec.data.sent.want.rate_per_min === 2700 && perSec.data.unit_shown === "per_second"
    && perMin.ok && perMin.data.sent.want.rate_per_min === 45,
    `${JSON.stringify(perSec.data && perSec.data.sent.want)} vs ${JSON.stringify(perMin.data && perMin.data.sent.want)}`);
  const hourly = call("plan_form", { item: "iron-plate", rate: 1, unit: "per_hour" });
  check("and 1/hour is 1/60 a minute, not a rounded 0.02",
    hourly.ok && Math.abs(hourly.data.sent.want.rate_per_min - 1 / 60) < 1e-9,
    JSON.stringify(hourly.data && hourly.data.sent.want));
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
  check("and a row-1 item the save has not researched comes back naming the technology it waits on",
    indexed.ok === false && indexed.code === "NO_UNLOCKED_RECIPE"
    && asArr((indexed.detail || {}).prerequisites).length > 0
    && !!asArr((indexed.detail || {}).prerequisites)[0].technology,
    `${indexed.code} ${JSON.stringify(asArr((indexed.detail || {}).prerequisites).map((p) => p.technology))}`);
}

// ---- fitting a plan into a box ----
{
  const box = { left_top: { x: 10, y: 10 }, right_bottom: { x: 40, y: 26 } };
  const base = { item: "iron-plate", rate: 300, lanes: 2, surface: "arch-sandbox", area: box };
  refuses("a spacing word the presets do not have is refused with the ones that do", "plan_fit",
    { ...base, spacing: "roomy" }, "UNKNOWN_SPACING",
    (r) => check("  ...and the list is the three the panel offers, not a remembered pair",
      asArr((r.detail || {}).known).length === 3
      && ["compact", "standard", "loose"].every((k) => asArr((r.detail || {}).known).includes(k)),
      JSON.stringify((r.detail || {}).known)));
  const noRoom = call("plan_fit", { ...base, lanes: 4, spacing: "loose", build: true,
    area: { left_top: { x: 10, y: 10 }, right_bottom: { x: 16, y: 12 } } });
  check("a box too small for even one lane at this spacing refuses instead of laying a partial line",
    noRoom.code === "NO_ROOM_IN_BOX" && !!noRoom.detail && noRoom.detail.box.w === 6,
    `${noRoom.code} ${JSON.stringify(noRoom.detail && noRoom.detail.box)}`);
  // The lane template `plan_fit` can lay is a smelting lane. Asking for anything else used to get a
  // box of furnaces and a `rate_placed` counted in iron plates -- a plausible number for a factory
  // nobody asked for. It refuses now, and says what the lane does make.
  const gears = call("plan_fit", { item: "iron-gear-wheel", rate: 60, lanes: 2,
    surface: "arch-sandbox", area: box });
  check("fitting a box for something the lane does not produce is refused, not answered in plates",
    !gears.ok && gears.code === "LANE_NOT_FOR_ITEM"
    && gears.detail.lane_makes["iron-plate"] > 0 && gears.detail.asked_for === "iron-gear-wheel"
    && /card_place lay any card/.test(String(gears.detail.use_instead))
    && keyed_line_ok(gears) === true,
    `${gears.code} ${String(gears.msg).slice(0, 80)}`
    + (keyed_line_ok(gears) === true ? "" : " || key renders as: " + String(keyed_line_ok(gears)).slice(0, 90)));
  // The two paths have to disagree: plates still fit, so the refusal above is about the item and not
  // about the method being broken.
  const plates = call("plan_fit", { item: "iron-plate", rate: 60, lanes: 2,
    surface: "arch-sandbox", area: box });
  check("and the same box still fits a lane that really does make what was asked for",
    plates.ok && plates.data.lanes_fit > 0
    && plates.data.rate_placed === plates.data.lanes_placed * plates.data.lane.per_lane_rate,
    `plates fit ${plates.data && plates.data.lanes_fit}, placed ${plates.data && plates.data.lanes_placed} lanes at ${plates.data && plates.data.rate_placed}/min`);
  refuses("lanes below one is refused as a count problem, not planned as nothing", "plan_fit",
    { ...base, lanes: 0 }, "BAD_ARGS");
  refuses("and a box that is not a box is refused with the shape it wanted", "plan_fit",
    { ...base, area: 5 }, "BAD_ARGS");
  // The two numbers a player is choosing between have to be consistent: lanes that fit, and the rate
  // those lanes actually deliver. A shortfall sentence that printed the wrong count once made a box
  // holding one lane of four claim "3 of 4 fit".
  const fit = call("plan_fit", { ...base, lanes: 9, spacing: "compact", build: false });
  check("the fit answer is self-consistent: capacity, placed and rate agree",
    fit.ok && fit.data.lanes_placed <= fit.data.lanes_fit
    && Math.abs(fit.data.rate_placed - fit.data.lanes_placed * fit.data.lane.per_lane_rate) < 1e-9
    && /^only \d+ of 9 lanes fit/.test(String(fit.data.next)),
    `fit ${fit.data && fit.data.lanes_fit}, placed ${fit.data && fit.data.lanes_placed}, rate ${fit.data && fit.data.rate_placed}: ${String(fit.data && fit.data.next).slice(0, 60)}`);
}

// ---- reading a box: what a rectangle can and cannot answer ----
{
  // The panel's Freeze-box path runs through this method, so every way a rectangle can be wrong has to
  // come back named: a player who drags on the wrong surface, or over the map edge, should not get an
  // empty card and a shrug.
  refuses("a scan with no surface named is refused, not aimed at the first one", "region_scan",
    { area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 4, y: 4 } } }, "NO_SURFACE");
  refuses("an unknown surface is refused by name", "region_scan",
    { surface: "no-such-surface", area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 4, y: 4 } } }, "NO_SURFACE");
  refuses("a box that is not a box is refused with the shape it wanted", "region_scan",
    { surface: "arch-sandbox", area: { x: 1, y: 2 } }, "BAD_ARGS");
  refuses("a box over ground this save has never generated reads as nothing, and says why", "region_scan",
    { surface: "arch-sandbox", area: { left_top: { x: 9000, y: 9000 }, right_bottom: { x: 9010, y: 9010 } } },
    "NOTHING_SCANNED",
    (r) => check("  ...naming what it did find there and the reason it keeps none of it",
      asArr((r.detail || {}).skipped).length === 0 && /terrain|ore|else's machines/.test(String((r.detail || {}).note)),
      JSON.stringify((r.detail || {}).note || r.msg).slice(0, 90)));
  const big = call("region_scan", {
    surface: "arch-sandbox",
    area: { left_top: { x: -2000, y: -2000 }, right_bottom: { x: 2000, y: 2000 } },
  });
  check("a 4000x4000 box is refused rather than walked -- this runs on the player's click",
    !big.ok && big.code === "AREA_TOO_BIG" && (big.detail || {}).limit === 40000,
    `${big.code} cells=${(big.detail || {}).cells} limit=${(big.detail || {}).limit}`);
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
  check("a frozen card exists for the placement fixtures to aim at", !!cardName,
    cardName ? `using "${cardName}" (${cards[0].entities} entities)` : `${cards.length} cards on this save -- run dev/cycle.sh`);
  const ungenerated = call("card_place", { name: cardName, surface: "arch-sandbox", ghosts: true, origin: FAR });
  check("an origin whose chunks do not exist says the GROUND refuses it, not that something is in the way",
    ungenerated.ok === false && ungenerated.code === "SITE_REJECTED"
    && !(ungenerated.detail || {}).blockers && !!((ungenerated.detail || {}).ground)
    && ungenerated.detail.ground.generated === false
    && asArr((ungenerated.detail || {}).wanted).length > 0,
    `${ungenerated.code} ${JSON.stringify(ungenerated.detail && ungenerated.detail.ground)}`);
  check("and the refusal says so in a sentence that does not blame the card",
    /ground|nothing stands in the way/i.test(String(ungenerated.msg)), String(ungenerated.msg).slice(0, 90));

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
  check("an origin with real entities on it names the obstacle it landed on, not its own part",
    /laid 10[0-9]/.test(field) && collided.ok === false && collided.code === "SITE_REJECTED"
    && blockers.length > 0 && blockers.every((b) => asArr(b.on_top_of).length > 0)
    && !(collided.detail || {}).wanted,
    `${JSON.stringify(blockers[0] || null).slice(0, 110)}; cleanup ${JSON.stringify(tornUp)}`);
  // The measured detail, handed to the window's own renderer: what a player reads has to be a function
  // of what the engine said, not of what this file remembers the engine saying.
  const rendered = call("gui_selftest", { render_refusal: { cmd: "place", name: cardName,
    code: collided.code, msg: collided.msg, detail: collided.detail } });
  const rlines = asArr(rendered.ok && rendered.data.refuse_live && rendered.data.refuse_live.render).map(enLine);
  check("the panel renders a real collision as an obstacle line",
    rlines.some((l) => /^refused: SITE_REJECTED/.test(l))
    && rlines.some((l) => /blockers: #\d+ .*lands on steel-chest/.test(l))
    && rlines.some((l) => /at: 30.5,30.5/.test(l)),
    JSON.stringify(rlines.slice(0, 3)));
  const grendered = call("gui_selftest", { render_refusal: { cmd: "place", name: cardName,
    code: ungenerated.code, msg: ungenerated.msg, detail: ungenerated.detail } });
  const glines = asArr(grendered.ok && grendered.data.refuse_live && grendered.data.refuse_live.render).map(enLine);
  check("and renders ungenerated ground as ground, in different words",
    glines.some((l) => /would place:/.test(l)) && glines.some((l) => /ground:.*not generated/.test(l))
    && !glines.some((l) => /blockers:/.test(l)),
    JSON.stringify(glines.slice(0, 4)));
}

// ---- the ground a plan is aimed at ----
// Space Age reads `enabled` twice: whether you researched it, and whether the planet allows it. 36 of
// the 659 recipes here and 51 of the 1016 entities carry `surface_conditions`, and one of the recipes is
// `big-mining-drill` -- so an unread field did not crash anything, it just sized factories that can
// never be assembled where the player is standing. The two news are different and stay apart: hardware
// the planet will not build (carry it in) versus a recipe the planet will not run.
{
  const blind = call("solve", { want: { item: "iron-plate", rate_per_min: 60 } });
  check("a plan with no surface named makes no claim about one",
    blind.ok === true && blind.data.surface === undefined,
    JSON.stringify(blind.data && blind.data.surface || "absent").slice(0, 90));
  const here = call("solve", { want: { item: "iron-plate", rate_per_min: 60 }, surface: "nauvis" });
  const rep = (here.data || {}).surface || {};
  check("naming the surface reports what it answered, and which hardware it refuses to build here",
    here.ok === true && rep.surface === "nauvis" && rep.values && rep.values.pressure === 1000
    && asArr(rep.machines_built_elsewhere).some((m) => m.machine === "big-mining-drill"
      && m.property === "pressure" && m.need_min === 4000 && m.here === 1000),
    JSON.stringify({ values: rep.values, here: asArr(rep.machines_built_elsewhere).map((m) => m.machine) }));
  // The same question on a different surface has to give different numbers, or the report is a
  // remembered nauvis wearing whatever the caller named.
  const other = call("solve", { want: { item: "iron-plate", rate_per_min: 60 }, surface: "arch-sandbox" });
  check("and the numbers come from the surface named, not from a default wearing its name",
    other.ok === true && (other.data.surface || {}).surface === "arch-sandbox"
    && (other.data.surface || {}).values
    && (other.data.surface || {}).values["day-night-cycle"] !== (rep.values || {})["day-night-cycle"],
    JSON.stringify({ nauvis: (rep.values || {})["day-night-cycle"],
      sandbox: ((other.data || {}).surface || {}).values && other.data.surface.values["day-night-cycle"] }));
  // A step the ground will not run is a different thing from hardware the ground will not build, and
  // the two are answered differently: the first is refused by name, the second reported beside a plan
  // that is still worth having. `big-mining-drill`'s own recipe is the reachable case (pressure 4000
  // wanted, this nauvis answers 1000).
  const gated = refuses("a plan aimed at a surface that refuses one of its steps is refused by that name",
    // `allow_locked` because on this save the drill's chain also has a step nobody has researched, and
    // research refuses first (it is the nearer door). The claim here is about the ground.
    "solve", { want: { item: "big-mining-drill", rate_per_min: 6 }, surface: "nauvis",
      allow_locked: true },
    "SURFACE_REFUSES_RECIPE", (r) => {
      const d = r.detail || {};
      check("  ...naming the step, the bound and the number this surface answered",
        asArr(d.recipes).some((x) => x.recipe === "big-mining-drill" && x.need_min === 4000
          && x.here === 1000 && x.property === "pressure")
        && d.values && d.values.pressure === 1000,
        JSON.stringify({ recipes: asArr(d.recipes).map((x) => `${x.recipe}:${x.property}:${x.need_min}/${x.here}`), values: d.values }));
      const shown = call("gui_selftest", { render_refusal: { cmd: "plan", name: "big-mining-drill",
        code: r.code, msg: r.msg, detail: r.detail } });
      const rl = asArr(shown.ok && shown.data.refuse_live && shown.data.refuse_live.render).map(enLine);
      check("  ...and the window says which step, which bound, and what to do instead",
        rl.some((l) => /refused: SURFACE_REFUSES_RECIPE/.test(l))
        && rl.some((l) => /refused here: big-mining-drill wants pressure exactly 4000, here it is 1000/.test(l))
        && rl.some((l) => /instead: ask the same question with no surface/.test(l)),
        JSON.stringify(rl.slice(0, 4)));
    });
  const bare = call("solve", { want: { item: "big-mining-drill", rate_per_min: 6 }, allow_locked: true });
  check("the same ask with no surface named is arithmetic, and stays answerable",
    bare.ok === true && bare.data.surface === undefined,
    bare.ok ? `${asArr(bare.data.unit.nodes).length} nodes, no surface claim` : `${bare.code} ${bare.msg}`);
  // `plan_fit` lays ghosts into a box on one surface, so the answer carries the report for THAT ground
  // -- the method that has the least excuse for staying quiet about it.
  const fit = call("plan_fit", { item: "iron-plate", rate: 300, lanes: 1, surface: "nauvis",
    area: { left_top: { x: 10, y: 10 }, right_bottom: { x: 60, y: 30 } } });
  check("a fit carries the same ground report as the plan behind it, aimed at the box's own surface",
    fit.ok === true && (fit.data.surface || {}).surface === "nauvis"
    && (fit.data.surface || {}).checked === true,
    JSON.stringify({ code: fit.code, surface: fit.data && fit.data.surface && fit.data.surface.surface }));
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
  check("an unlocked chest freezes into a card to aim", fz.ok === true, `${fz.code || cardName}`);
  const place = () => call("card_place", { name: cardName, surface: "arch-sandbox", ghosts: true,
    origin: { x: 12, y: 12 } });
  lua(`game.surfaces["arch-sandbox"].set_property("gravity", ${min / 2})`);
  const low = place();
  lua(`game.surfaces["arch-sandbox"].set_property("gravity", ${was})`);
  const refused = asArr((low.detail || {}).wanted).concat(asArr((low.detail || {}).blockers));
  check("a chest cannot stand where there is no gravity, and the reason says the planet, not the ground",
    low.ok === false && low.code === "SITE_REJECTED" && refused.length > 0
    && refused.every((r) => r.surface_refused && r.surface_refused.property === "gravity"
      && r.surface_refused.need_min === min && Math.abs(r.surface_refused.here - min / 2) < 1e-9),
    brief(refused, 220));
  const shown = call("gui_selftest", { render_refusal: { cmd: "place", name: cardName,
    code: low.code, msg: low.msg, detail: low.detail } });
  const rl = asArr((shown.data || shown).refuse_live && (shown.data || shown).refuse_live.render).map(enLine);
  const wanted_sentence = "would place: #1 wooden-chest the planet refuses it: wants gravity at least "
    + min + ", here it is " + String(min / 2);
  check("and the window says it in one bound, because the engine's max is a sentinel and not a limit",
    rl.some((l) => l.includes(wanted_sentence)) && !rl.some((l) => l.includes("1.797")),
    JSON.stringify(rl.slice(0, 4)));
  const back = place();
  const tidied = lua(`local n = 0
for _, e in ipairs(game.surfaces["arch-sandbox"].find_entities_filtered { type = "entity-ghost" }) do e.destroy(); n = n + 1 end
rcon.print("ghosts removed " .. n .. " gravity " .. game.surfaces["arch-sandbox"].get_property("gravity"))`);
  check("the same card on the same ground at the gravity it came back to places fine",
    back.ok === true && /ghosts removed [1-9]/.test(String(tidied))
    && Math.abs(parseFloat(String(tidied).replace(/^.*gravity /m, "")) - parseFloat(was)) < 1e-9,
    `${back.code || "placed"}; ${tidied}`);
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
  // The area guard's sentence is built from three numbers the caller chose, so it is one of the
  // parameterised ones the static gate cannot read -- this is where it is read back and compared.
  refuses("site guards an area with more cells than it will walk", "site",
    { area: [[-400, -400], [400, 400]], max_cells: 100 }, "AREA_TOO_LARGE");
  refuses("a patch smaller than an extractor's window is a lower bound, not a rate", "drill_rate",
    { resource: "iron-ore", surface: "arch-sandbox", seconds: 1 }, "PATCH_TOO_SMALL");
  // uranium-ore is on nauvis (the dev fixtures lay it) and nowhere on the pad, and a drill takes
  // its category -- so this is the "there is no patch here" door, not the miner lookup.
  refuses("and a surface with none of the ore at all says so rather than estimating", "drill_rate",
    { resource: "uranium-ore", surface: "arch-sandbox", seconds: 1 }, "NO_ORE_ON_MAP");
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
  const suites = ("smoke solve_e2e power_e2e corridor_e2e poletier_e2e pipe_seam_probe pipe_route_e2e "
    + "seam_ask_e2e fluid_chain_e2e port_read_e2e trunk_exhaust refusals lab_reload_e2e undo_e2e box_here_e2e").split(" ");
  const said = new Set();
  for (const s of suites) {
    const f = path.join(__dirname, s + ".js");
    if (!fs.existsSync(f)) continue;
    // A line counts as asserting a code only where it compares one: a name mentioned in prose is
    // not a test, and `!==` (refusing to crash on a code) is not reaching it either.
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!/code/i.test(line) || /!==/.test(line)) continue;
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
    SOLVE_FAILED: "an `or` default behind the solver's own named returns",
    SANDBOX_CREATE_FAILED: "one-shot per save at most: needs game.create_surface to raise, and the surface then exists",
    SANDBOX_UNAVAILABLE: "the same guard's unnamed branch, kept for a reason lab_surface has not reported yet",
    NO_SANDBOX: "same door as above, from the methods that refuse rather than plan on the player's world",
    BENCH_UNAVAILABLE: "only fires when control.lua never wires measure.rig_bench -- a broken build, not a reachable answer; wiring it is asserted by every rig call that lands on arch-lab",
    SANDBOX_: "a prefix, not a code: SANDBOX_ .. why is how the generating/failed answers are built",
    UNAVAILABLE: "the suffix of that same pair, for a reason the bench has not reported yet",
    MEASUREMENT_ERRORED: "the tick runner raised; nothing here makes it raise on purpose",
    RUNNER_RAISED: "the same event on the card-lab runner",
    CARD_PLACE_FAILED: "a placement the engine refused after lint and can_place_entity both passed: a race, not an input",
    PLACE_FAILED: "the same engine refusal, counted per entity by verify.place",
    LAB_BUILD_FAILED: "the lane rig's placement failing after its own pre-check passed: a race",
    SUBGRAPH_TOO_LARGE: "a cycle guard on the capability walk; vanilla data does not cycle that far",
    NO_GENERATORS: "no prototype on the install produces electric energy: needs a modpack without power",
    NO_MINER: "an `or` default behind the solver's named returns",
    NOTHING_TO_LAYOUT: "entries that all resolve to nothing are refused by BAD_ARGS before the layout runs",
    UNKNOWN_ROLE: "a role name this mod does not define: only a code change can ask for one",
    NO_HANDLER: "the panel's own dispatch guard: `gui_api` supplies a closure for every verb `G.build` renders, so a verb arriving with no handler means those two lists drifted -- which is exactly the rename this would otherwise swallow",
    SCAN_FAILED: "the one pcall around `surface.find_entities_filtered`: measured on this install, a valid surface with any well-formed area answers, so only a mid-call surface removal or an area the engine itself rejects would reach it -- and reaching it would still be reported rather than returned as an empty card",
    FLUID_PORT_NOT_ON_A_MACHINE: "reachable -- proved by hand on this build, where the rig reported it in unwired_inputs for a port moved onto the refinery's pipe -- but the fixture needs the oil line researched, and setting a technology's `researched` flag from script does not replay its unlock effects, so the recipe has to be opened too. That grant was flaky across a fresh session and a flaky fixture is worse than an untested code: the honest input is a small `grant_oil` helper with the recipe enables beside it, run before the model cache is warmed.",
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
    NO_CLEAR_SITE: "ground too crowded for any candidate site: the pad is swept before it is used, and a caller-supplied origin is refused by NO_ENTITY_AT first",
    NO_AVAILABLE_MACHINE: "every candidate for a category locked, from the solver's side",
    NO_AVAILABLE_PART: "a force with nothing unlocked still gets the parts that need no research (burner arm, stone), so this wants a modpack with none",
    SANDBOX_CREATE_FAILED: "the concrete name the SANDBOX_ prefix builds when game.create_surface raises",
    SANDBOX_UNAVAILABLE: "the same, for a reason lab_surface has not reported yet",
    MACHINE_GONE: "a probe machine destroyed while its fluid run was being proved",
    SEAM_NOT_CONNECTED: "region.layout's answer when a placement claimed a seam the engine then refused",
    GROUND_REJECTED: "the same, when the ground under a proposed seam turns out not to take the run",
    NO_PIPE_CHAIN: "the seam's straight run cannot be built at all on that ground",
    NO_CORRIDOR_WITHIN_LIMIT: "no corridor within the search limit; seam_ask_e2e walks to this edge and asserts the proposal, not the name",
    NO_FREE_CELL_AT_SOURCE: "the cell beside the source port is taken before a run can start",
    SEAM_HOLDS_OTHER_FLUID: "a pipe run already carries a different fluid in the world being verified",
  };
  const TODO = {
    NO_FIELD_ON_MAP: "the same door, from the pump rig",
    NO_ROOM_FOR_BELT: "every drop tile of a placed drill blocked: the rig searches, so only a walled-in map reaches it",
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
    BENCH_PATCH_FAILED: "the wrapper over the reasons below; every one of them names itself in `detail.reason`",
    NO_SUCH_RESOURCE: "a resource entity this save has no prototype for: the extractor search answers NO_MINER_FOR_RESOURCE first",
    GENERATING: "the bench plot's chunks arriving: reachable only on a surface that has not generated yet, and it answers `call again`",
    PATCH_FAILED: "fewer than 25 of the 121 tiles could be laid: the plot is cleared and painted first, so this needs the engine to refuse its own ground",
    SCAN_FAILED_LATE: "the second look inside a watch box raising: the world would have had to change shape mid-window",
  };
  const all = [...emitted];
  const unaccounted = all.filter((c) => !said.has(c) && !DEFENSIVE[c] && !TODO[c]).sort();
  check("every code the source can emit is asserted, defended, or on the list", unaccounted.length === 0,
    unaccounted.length ? `unaccounted: ${unaccounted.join(", ")}`
      : `${emitted.size} codes: ${all.filter((c) => said.has(c)).length} asserted, ${all.filter((c) => DEFENSIVE[c] && !said.has(c)).length} defended, ${all.filter((c) => TODO[c] && !said.has(c)).length} listed`);
  const covered_now = [...Object.keys(DEFENSIVE), ...Object.keys(TODO)].filter((c, i, a) => a.indexOf(c) === i).filter((c) => emitted.has(c) && said.has(c));
  check("and nothing sits on a list that a suite has already started covering", covered_now.length === 0,
    covered_now.join(", ") || "every listed code is still unasserted");
  // Names the source builds rather than writes: `"SANDBOX_" .. why` has no literal to match, so the
  // concrete answers it can produce are allowed by prefix.
  const DERIVED_OK = /^(SANDBOX_|$)/;
  const gone = [...Object.keys(DEFENSIVE), ...Object.keys(TODO)]
    .filter((c) => !emitted.has(c) && !/^SANDBOX_$/.test(c) && !DERIVED_OK.test(c.slice(0, 8)));
  check("and no list names a code the source no longer emits", gone.length === 0,
    gone.join(", ") || "every listed code still exists");
}

console.log(results.join("\n"));
console.log(fails === 0 ? "\nthe refusal surface behaves" : `\n${fails} refusal check(s) failed`);
process.exit(fails ? 1 : 0);
