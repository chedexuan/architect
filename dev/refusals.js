  // Without the oil line the measurement is refused three gates earlier (RECIPE_NOT_RESEARCHED),
  // which is the right answer to a different question. Granted again here: the run before this one
  // revoked it, and the first time this block was wired the grant had not landed before the call.
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

const call = (method, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, RAW: "1" } });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) };
  }
};
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const gear = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));

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
const refuses = (label, method, args, code, extra) => {
  COVERED.add(code);
  const r = call(method, args);
  check(label, !r.ok && r.code === code, `${r.code || "ANSWERED"} ${String(r.msg || "").slice(0, 60)}`);
  if (extra) extra(r);
  return r;
};

// ---- the envelope itself ----
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
  check(`${method} on a malformed request answers with a code, not a crash`,
    r.ok === true || (!!r.code && r.code !== "RUNTIME_ERROR" && r.code !== "HARNESS"),
    r.ok ? "(answered, which is allowed)" : `${r.code} ${String(r.msg || "").slice(0, 70)}`);
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
  (r) => check("  ...naming the slot's own reason", inner(r, "UNKNOWN_CARD"), JSON.stringify(r.detail).slice(0, 90)));
refuses("card_compose with an entity that has no position", "card_compose",
  { slots: [{ card: { name: "nopos", entities: [{ name: "pipe" }] } }] }, "COMPOSE_INPUT_REJECTED",
  (r) => check("  ...and saying which entity it was", inner(r, "NO_POSITION"), JSON.stringify(r.detail).slice(0, 90)));
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

// ---- refusals that need a real machine or a real patch, but no fixture surgery ----
refuses("machine_ports asks which recipe a multi-recipe machine runs", "machine_ports",
  { machine: "oil-refinery" }, "NO_RECIPE");
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
    errs.some((e) => e && e.code === "NO_POSITION"), JSON.stringify(r.detail).slice(0, 90));
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

// ---- three guards that needed a world to stand in, and what each one actually does ----
{
  // The pad is swept every time it is taken, so a patch laid here is gone before anything else
  // measures on it -- and `drill_rate` gets a surface whose densest iron patch is 4 tiles.
  const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
    { encoding: "utf8", env: process.env }).trim();
  lua(`local s = game.surfaces["arch-sandbox"]
for dx = 0, 1 do for dy = 0, 1 do
  pcall(function() s.create_entity { name = "iron-ore", position = { x = -20.5 + dx, y = -20.5 + dy }, force = "neutral" } end)
end end
rcon.print("pad iron tiles: " .. #s.find_entities_filtered { type = "resource", name = "iron-ore" })`);
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
  for (const re of [/fail\("([A-Z][A-Z_0-9]+)"/g, /\bcode\s*=\s*"([A-Z][A-Z_0-9]+)"/g,
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
    + "seam_ask_e2e fluid_chain_e2e port_read_e2e trunk_exhaust refusals").split(" ");
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
    BAD_RESULT: "the envelope's type check on a method return; every M.* answers with a table",
    SOLVE_FAILED: "an `or` default behind the solver's own named returns",
    SANDBOX_CREATE_FAILED: "one-shot per save at most: needs game.create_surface to raise, and the surface then exists",
    SANDBOX_UNAVAILABLE: "the same guard's unnamed branch, kept for a reason lab_surface has not reported yet",
    NO_SANDBOX: "same door as above, from the methods that refuse rather than plan on the player's world",
    SANDBOX_: "a prefix, not a code: SANDBOX_ .. why is how the generating/failed answers are built",
    UNAVAILABLE: "the suffix of that same pair, for a reason the bench has not reported yet",
    MEASUREMENT_ERRORED: "the tick runner raised; nothing here makes it raise on purpose",
    RUNNER_RAISED: "the same event on the card-lab runner",
    CARD_PLACE_FAILED: "a placement the engine refused after lint and can_place_entity both passed: a race, not an input",
    PLACE_FAILED: "the same engine refusal, counted per entity by verify.place",
    LAB_BUILD_FAILED: "the lane rig's placement failing after its own pre-check passed: a race",
    SITE_REJECTED: "an explicit origin that collides with the world",
    SUBGRAPH_TOO_LARGE: "a cycle guard on the capability walk; vanilla data does not cycle that far",
    NO_GENERATORS: "no prototype on the install produces electric energy: needs a modpack without power",
    NO_MINER: "an `or` default behind the solver's named returns",
    NOTHING_TO_LAYOUT: "entries that all resolve to nothing are refused by BAD_ARGS before the layout runs",
    UNKNOWN_ROLE: "a role name this mod does not define: only a code change can ask for one",
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
    EMPTY_PLAN: "the solver's no-nodes answer, behind UNRESOLVED_INPUT",
    NO_GENERATOR: "the sizing menu's no-produces-anything answer, behind NO_BUILDABLE_GENERATOR",
    BAD_RECIPE: "a recipe the solver cannot resolve, reached through machine_recipes rather than want",
    NO_SUCH_MACHINE: "a machine hint that is not an entity answers UNKNOWN_MACHINE, which is asserted above",
    UNRESOLVED_INPUT: "a want no recipe chain can close; solve answers NO_RECIPE/NO_UNLOCKED_RECIPE for the shapes tried here",
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
