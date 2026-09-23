// Regression suite: node smoke.js
// Every case asserts on shape, not just on "did it answer", because the failures we
// actually hit were plausible-looking payloads with wrong content.
const { execFileSync } = require("child_process");
const path = require("path");

const call = (method, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})], {
      encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: { ...process.env, RAW: "1" },
    });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, code: "HARNESS", msg: (e.stdout || String(e)).toString().slice(0, 160) };
  }
};

const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: { ...process.env } }).trim();
  } catch (e) { return "HARNESS"; }
};

const results = [];
const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || "" });

// A freshly created save has nothing researched, and a smelting lane needs belts
// and arms, so the fixture provisions its own world state instead of assuming it.
// Research is SET, not inherited. A session that already researched the later machines -- another
// suite asking solve for an `electric-furnace` line, or a probe run by hand -- plans a different
// machine for the same request, and a handful of checks that read the machine list then answer
// differently on the second run than on the first. So this list IS the world: everything else that
// happens to be researched is revoked, together with the recipes it unlocked (2.0 does not re-disable
// those on its own), and the result is the state a freshly restarted server is in -- which is what
// `dev/cycle.sh` grants, and the two lists have to stay identical.
// The reset has to answer the same question Factorio does -- is this recipe enabled because
// something unlocked it, or because nothing ever did? -- rather than undoing only what it recognises.
// Revoking a technology's own unlocks is not enough: a suite that enables a recipe by hand (which
// several do, to keep the fixture off the research tree) leaves it enabled with its technology
// unresearched, and `solve` then plans a machine this save never had. Measured, that is what made
// two checks answer differently on a second run in one session: the smelting stage went from four
// stone furnaces to two electric ones, and `grid_is_vacuous` stopped being true.
lua(`local f = game.forces.player
local keep = {}
local names = {"electronics","automation","logistics","steel-processing","logistics-2","solar-energy","electric-energy-accumulators"}
for _, t in ipairs(names) do keep[t] = true end
-- every recipe the research tree knows about, and who knows about it
local unlocked_by = {}
for name, tech in pairs(prototypes.technology) do
  local ok, effects = pcall(function() return tech.effects end)
  if ok then
    for _, e in ipairs(effects or {}) do
      if e.type == "unlock-recipe" and e.recipe then
        unlocked_by[e.recipe] = unlocked_by[e.recipe] or {}
        unlocked_by[e.recipe][name] = true
      end
    end
  end
end
for name, tech in pairs(f.technologies) do
  if not keep[name] then
    tech.researched = false
  elseif not tech.researched then
    tech.researched = true
  end
  tech.enabled = not keep[name]
end
local held, orphan = 0, 0
for name, r in pairs(f.recipes) do
  local want
  if not unlocked_by[name] then
    -- nothing unlocks it: a fresh save starts with it enabled, so leave it as it is
    orphan = orphan + 1
    want = r.enabled
  else
    want = false
    for t in pairs(unlocked_by[name]) do
      if keep[t] then want = true break end
    end
  end
  if r.enabled ~= want then r.enabled = want end
  if r.enabled then held = held + 1 end
end
rcon.print("research reset to the seven; " .. held .. " recipes enabled by rule, "
  .. orphan .. " with no unlocker left as found")`);

// A run may not inherit the last run's world. Four things leak between two suites in one server
// session and each of them has changed an answer: entities a previous run left on the planning pad,
// research some other probe granted, the rigs' measurement cache, and -- the one this block cannot
// reach -- a RECIPE another suite enabled by hand. Disabling the recipes of a revoked technology is
// not the same as the state of a fresh save, which has some recipes enabled by no technology at all;
// resetting that set from scratch was tried and broke `region_layout` for a card whose recipe a
// vanilla save simply starts with. So the honest statement is the narrow one:
//
//   `dev/smoke.js` is green from a freshly restarted server, which is what `dev/regress.sh` gives
//   it. Run after a suite that unlocks a later drill or furnace by hand, two checks about which
//   machine the solver picks (`burner line flags vacuous grid`, `having measured does not cost the
//   player the research list`) answer for that world rather than this one.
//
// Not reset here either: a surface that has had `create_global_electric_network` called on it, which
// cannot be undone, and the cards other suites froze -- those belong to the user.
lua(`local s=game.surfaces["arch-sandbox"]
if not s then rcon.print("no sandbox yet") return end
local n=0
for _,e in ipairs(s.find_entities_filtered{area={{-500,-500},{500,500}}}) do
  local ok,t=pcall(function() return e.type end)
  if ok and t~="resource" and e.valid then e.destroy() n=n+1 end
end
rcon.print("sandbox swept "..n)`);
call("lab_reset", {});

let r = call("ping");
check("ping", r.ok && r.data.mod_version, r.ok ? `v${r.data.mod_version} game ${r.data.game_version}` : r.code);
// The command a registration failure would leave empty without any error surfacing anywhere:
// `/arch` shipped broken because nothing headless could see it.
check("the player-facing command is registered",
  r.ok && Array.isArray(r.data.player_commands) && r.data.player_commands.includes("arch"),
  r.ok ? `commands: ${JSON.stringify(r.data.player_commands)}` : r.code);
// A whitelist of machine kinds fails silently on a modded save: an unknown type is simply absent
// from every plan, and nothing downstream notices. So the report has to exist, and be honest about
// having nothing to report here -- and the boundary list has to name the mechanisms a model would
// otherwise assume, circuit logic above all (2.0 really does let a signal pick a recipe).
// `coverage` rides on capabilities, not l1: it is about what the rules engine can see,
// which is the first thing a caller needs before it asks for a plan.
const cov = (call("capabilities", {}).data || {}).coverage || {};
check("nothing the engine gives a crafting speed to is unclassified on vanilla data",
  cov.unclassified_crafters && cov.unclassified_crafters.count === 0
  && Array.isArray(cov.crafting_kinds_covered) && cov.crafting_kinds_covered.length >= 3,
  `${JSON.stringify(cov.crafting_kinds_covered)} unclassified=${JSON.stringify(cov.unclassified_crafters)}`);
// Two fields the API doc says 2.0 does not carry at runtime were being read anyway: a product's
// `catalyst_amount` and a module's `limitation_count`. Both raise or answer nil, so the keys shipped
// as permanent blanks -- which a caller reads as "this install has no catalysts" rather than "this
// mod could not look". The real 2.0 figure for the same fact is `ignored_by_productivity`.
{
  const caps = call("capabilities", {}).data || {};
  const uran = Object.values(caps.recipes || {}).find((r) => r.name === "uranium-processing");
  const mods = Object.values(caps.modules || {});
  check("a product reports the 2.0 field, and a module reports nothing it cannot read",
    !!uran && Object.values(uran.products).every((x) => !("catalyst" in x))
    && mods.length > 0 && mods.every((m) => !("limit" in m)),
    uran ? `uranium products ${JSON.stringify(uran.products[0])}; ${mods.length} modules, limit absent` : "no uranium recipe");
}
const modelled = (cov.not_modelled || []).join(" | ");
check("the model says out loud what it does not model, circuit logic first",
  /circuit network/.test(modelled) && /beacons/.test(modelled) && /limitations/.test(modelled)
  && /trains/.test(modelled),
  `${(cov.not_modelled || []).length} entries; opens: ${modelled.slice(0, 70)}`);
// A disclaimer is a claim about code, and the circuit entry used to cite two API calls as "real and
// measured" that appear nowhere in the source -- the wrongest sentence in the file, in the place a
// caller is told to look first. So: every back-quoted member named in `not_modelled` has to be found
// in `src/architect`. If an entry ever needs to name an engine member this mod does NOT call, it has
// to say so in words rather than in back-quotes, which read as "this is in the code".
{
  const lua_all = require("fs").readdirSync(path.join(__dirname, "..", "src", "architect"))
    .filter((f) => f.endsWith(".lua"))
    .map((f) => require("fs").readFileSync(path.join(__dirname, "..", "src", "architect", f), "utf8"))
    .join("\n");
  const suspects = [];
  for (const entry of Object.values(cov.not_modelled || {})) {
    for (const quoted of String(entry).match(/`([^`]+)`/g) || []) {
      const key = quoted.slice(1, -1).split(/[(:\s]/)[0];
      if (!/^[A-Za-z_][A-Za-z0-9_]{5,}$/.test(key)) continue;
      if (!lua_all.includes(key)) suspects.push(key);
    }
  }
  check("a disclaimer names only members this mod actually touches", suspects.length === 0,
    suspects.length ? `cited but absent from src: ${suspects.join(", ")}`
      : `${Object.values(cov.not_modelled || {}).length} entries, every quoted member found`);
}
// The same detector one level down: the mod places arms, belts, containers and poles, and it finds
// them by the engine's `type`. A placeable, craftable entity type no role covers is a part this mod
// would never offer -- silently absent from a plan rather than refused. Named here rather than just
// counted, because the count is only honest if it can be checked against what the mod admits to.
const uncovered = (cov.placeable_types_not_in_any_role || {}).sample || [];
check("the report names the placeable types no role covers, including the ones it warns about",
  cov.placeable_types_not_in_any_role && cov.placeable_types_not_in_any_role.count === uncovered.length
  && uncovered.includes("beacon") && uncovered.includes("constant-combinator")
  && !uncovered.includes("inserter") && !uncovered.includes("transport-belt"),
  `${cov.placeable_types_not_in_any_role && cov.placeable_types_not_in_any_role.count} uncovered: ${uncovered.slice(0, 8).join(" ")}`);
// `parts` is the ranking claim per role, so it has to say when there was nothing to rank by. A chest
// has no readable capacity field at all, so it must report zero figures rather than a confident order.
const parts = cov.parts || {};
check("each role reports its candidates and whether the ranking figure was actually read",
  parts.belt && parts.belt.placeable >= 3 && parts.belt.figures_read === parts.belt.placeable
  && parts.furnace && parts.furnace.figures_read === parts.furnace.placeable
  && parts.chest && parts.chest.placeable >= 2 && parts.chest.figures_read === 0
  && parts.arm && parts.arm.figures_read === "measured at use time",
  JSON.stringify(parts));
// Parts are chosen by `roles`, and the answer must carry the rule that chose it: a caller on a save
// without steel-chest needs to see that the substitution happened, not just get a different name.
const laneParts = call("card_example", {});
check("an example card says how each of its parts was chosen",
  laneParts.ok && laneParts.data.components_how
  && Object.keys(laneParts.data.components_how).length === 4
  && Object.values(laneParts.data.components_how).every((h) => typeof h === "string" && h.length > 0),
  JSON.stringify(laneParts.ok ? laneParts.data.components_how : laneParts.code));
// The falsification sample for "a name is only a hint": the old ladder passed an unknown name
// straight through, so the card came back shaped fine and failed lint for a reason the caller could
// not see. If the hint were trusted again, this check goes red.
const bogus = call("card_example", { belt: "not-a-real-belt", inserter: "not-a-real-arm" });
check("a part named that this install does not have is replaced, not echoed back",
  bogus.ok && bogus.data.components.belt !== "not-a-real-belt"
  && bogus.data.components.inserter !== "not-a-real-arm",
  JSON.stringify(bogus.ok ? { parts: bogus.data.components, how: bogus.data.components_how } : bogus.code));

r = call("capabilities");
check("capabilities full", r.ok && r.data.recipes.length > 300, r.ok ? `${r.data.recipes.length} recipes, ${(JSON.stringify(r).length / 1000) | 0}KB` : r.code);
check("machines report kilowatts, not J/tick",
  r.ok && r.data.machines["assembling-machine-1"].energy_usage === 75,
  // Pinning the unit, not the vanilla value: 2.0's getter answers in J/tick (75 kW arrives
  // as 1250), and every power figure in this mod used to carry that raw number under a
  // `_kw` name -- a 3.6 kW load read out as 60 kW, which made under-provisioned grids look
  // healthy. If this ever prints 1250, the conversion in draw_kw_of is gone.
  r.ok ? `asm1=${r.data.machines["assembling-machine-1"].energy_usage}kW (raw getter would be 1250)` : "");
check("inserters have kW", r.ok && r.data.inserters && r.data.inserters["inserter"], "model split unchanged");

r = call("l1", { targets: ["iron-gear-wheel"], show_locked: true });
check("l1 gear chain", r.ok && r.data.node_count >= 2, r.ok ? `${JSON.stringify(r).length}B, ${r.data.node_count} nodes` : r.code);
check("l1 excludes recycling routes", r.ok && !(r.data.items["iron-gear-wheel"] || {}).recipe?.includes("recycling"),
  r.ok ? `route=${(r.data.items["iron-gear-wheel"] || {}).recipe}` : "");

r = call("l1", { targets: ["processing-unit"], show_locked: true });
check("l1 reports locked gaps", r.ok && Object.keys(r.data.gaps).length > 0,
  r.ok ? Object.entries(r.data.gaps).map(([k, g]) => `${k}:${g.reason}`).join(" ") : r.code);

r = call("power");
check("power reads supply", r.ok && typeof r.data.total_capacity_kw === "number",
  r.ok ? `${r.data.total_capacity_kw}kW (night ${r.data.surfaces[0].night_capacity_kw}kW)` : r.code);

r = call("solve", { want: { item: "iron-plate", rate_per_min: 75 }, check_power: true });
if (r.ok) {
  const u = r.data.unit;
  check("solve returns integral unit", u.nodes.every((n) => Number.isInteger(n.count)),
    `unit ${u.output_per_min}/min  slots ${u.machine_slots}  ${u.nodes.map((n) => n.count + "×" + n.machine).join(" + ")}`);
  check("solve reports energy", u.power.machine_grid_kw + u.power.machine_fuel_kw > 0,
    `grid ${u.power.machine_grid_kw}kW + fuel ${u.power.machine_fuel_kw}kW`);
  check("solve feasibility flag", r.data.candidates[0].power_feasible !== undefined,
    `feasible=${r.data.candidates[0].power_feasible} headroom=${r.data.candidates[0].power_headroom_kw}`);
  check("burner line flags vacuous grid", r.data.candidates[0].grid_is_vacuous === true,
    `grid_is_vacuous=${r.data.candidates[0].grid_is_vacuous}`);
  check("no duplicate candidates", new Set(r.data.candidates.map((c) => c.replicas)).size === r.data.candidates.length,
    r.data.candidates.map((c) => c.replicas).join(","));
} else {
  check("solve iron-plate", false, `${r.code} ${r.msg || ""}`);
}

r = call("site", { area: [[-60, -60], [60, 60]] });
check("site aggregates ore", r.ok && Object.keys(r.data.ores).length > 0,
  r.ok ? `${Object.keys(r.data.ores).length} ore kinds, ${JSON.stringify(r).length}B` : r.code);

r = call("site", { area: [[-400, -400], [400, 400]] });
check("site guards oversized area", !r.ok && r.code === "AREA_TOO_LARGE", r.code || "unexpectedly accepted");

r = call("lab_reset");
check("lab_reset answers", r.ok, "");

// ---- what `site` says about the ground ----
// `mining_time` and `walking_speed` were read straight off a resource prototype, where 2.0 keeps
// neither: the read raises, `field()` turns a raise into nil, and every ore in every survey came
// back with no mining cost attached to it. The first figure is on `mineable_properties`; the second
// was never a prototype field at all -- walkability is a collision box, and an ore tile has one.
r = call("site", { area: [[-40, -60], [40, -30]] });
const oreProto = Object.values((r.data || {}).ores || {})[0];
check("a surveyed ore carries the cost of mining it, and whether it can be walked over",
  r.ok && !!oreProto && !!oreProto.prototype && oreProto.prototype.mining_time > 0
  && oreProto.prototype.walkable === false && !!oreProto.prototype.category,
  r.ok ? JSON.stringify(oreProto && oreProto.prototype) : r.code);

// ---- lab_start / lab_stop: the rig that nothing used to call ----
// `card_lab` builds its job inline rather than routing through `lab_start`, so the branch of the tick
// runner only `lab_start` reaches had never run in an automated pass -- and the method's default
// `origin` was the literal (600,600) on whatever surface the caller happened to mean.
r = call("lab_start", { machine: "not-a-real-machine" });
check("lab_start refuses a machine this install does not have", !r.ok && r.code === "UNKNOWN_MACHINE", r.code);
r = call("lab_start", { recipe: "no-such-recipe" });
check("lab_start refuses a recipe this install does not have", !r.ok && r.code === "UNKNOWN_RECIPE", r.code);
r = call("lab_start", { machine: "inserter" });
check("lab_start refuses a machine that crafts nothing", !r.ok && r.code === "NOT_A_CRAFTER", r.code);
r = call("lab_start", { recipe: "battery" });
check("a recipe with several ingredients is refused rather than fed one of them",
  !r.ok && r.code === "NOT_A_SINGLE_INGREDIENT_RECIPE"
  && Object.keys((r.detail || {}).ingredients || {}).length >= 3,
  `${r.code} ${JSON.stringify((r.detail || {}).ingredients)}`);
r = call("lab_start", { machine: "stone-furnace", recipe: "iron-plate", count: 3, seconds: 6, speed: 40 });
const started = r.ok ? r.data : {};
check("lab_start finds its own ground on the bench instead of building at a hard-coded point",
  r.ok && started.surface === "arch-lab" && !!started.origin
  && typeof started.origin.x === "number" && typeof started.origin.y === "number",
  r.ok ? `${started.surface} origin=${JSON.stringify(started.origin)}` : `${r.code} ${r.msg}`);
// The expectation is the thing a measured rate is judged against, and this was the fourth copy of the
// yield rule in the file -- the one written as `amount or probability`, which is 1 for a normal
// product and 0.007 for a randomized one.
check("a furnace that 2.0 will not accept a recipe for is reported, not silently skipped",
  r.ok === false || r.code !== "RECIPE_REJECTED",
  `${r.code || "started"} ${(r.detail || {}).error || ""}`);
check("the expectation states the recipe's own yield arithmetic",
  r.ok && Math.abs(started.expected_per_min - 3 * (60 / (3.2 / 1)) * 1) < 0.01,
  JSON.stringify({ expected: started.expected_per_min, energy: 3.2, speed: 1 }));
{
  let st = call("lab_status").data || {};
  const stop_deadline = Date.now() + 40000;
  while (st.state === "running" && Date.now() < stop_deadline) {
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
    st = call("lab_status").data || {};
  }
  check("the runner's own branch measures a rate and takes the machines away",
    st.state === "done" && st.produced > 0 && st.measured_per_min > 0
    && (st.destroyed || 0) >= (started.entities || 0),
    JSON.stringify({ state: st.state, produced: st.produced, per_min: st.measured_per_min,
      destroyed: st.destroyed, entities: started.entities }));
}
check("the world is left running at one tick per tick",
  parseFloat(lua('rcon.print(game.speed)')) <= 1,
  lua('rcon.print(game.speed)'));
r = call("lab_stop");
check("stopping a finished job says there is nothing to stop", !r.ok && r.code === "LAB_IDLE", r.code);

// seconds must exceed one craft (iron plate is 3.2s at stone-furnace speed 1) or the
// job "succeeds" with produced=0, which is what this case used to assert nothing about.
r = call("lab_card", { furnaces: 4, seconds: 20, speed: 40 });
check("lab_card builds", r.ok && r.data.card_power,
  r.ok ? `${r.data.entities} entities, peak grid ${r.data.card_power.peak_grid_kw}kW` : `${r.code} ${r.msg || ""}`);
r = call("lab_status");
const deadline = Date.now() + 40000;
while (r.ok && r.data.state === "running" && Date.now() < deadline) {
  execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1500)"]);
  r = call("lab_status");
}
check("lab job finishes and tears down", r.ok && r.data.state !== "running" && r.data.destroyed > 0,
  r.ok ? `state=${r.data.state} destroyed=${r.data.destroyed} missing=${r.data.missing_entities}` : r.code);
check("lab actually produces output", r.ok && r.data.produced > 0,
  r.ok ? `produced=${r.data.produced} measured=${r.data.measured_per_min}/min expected=${r.data.expected_per_min}/min ratio=${r.data.ratio_measured_over_expected}` : "");

// ---- card protocol: the linter must reject exactly the mistakes we already made ----


// helpers.table_to_json emits {} for an empty Lua table, so arrays are ambiguous.
const asArr = (v) => (Array.isArray(v) ? v : []);
const ex = call("card_example");
const good = ex.ok && ex.data;
check("card_example is self-consistent", !!good, good ? `${good.entities.length} entities ${JSON.stringify(good.components)}` : `${ex.code} ${ex.msg || ""}`);

const lint = (card, extra) => {
  const res = call("card_check", Object.assign({ card }, extra || {}));
  return res.ok ? res.data : { errors: [{ code: "BRIDGE_" + res.code }], ok: false };
};
const clone = () => JSON.parse(JSON.stringify(good));
const expectReject = (name, card, code) => {
  const d = lint(card);
  const errs = asArr(d.errors);
  check(name, d.ok !== true && errs.some((e) => e.code === code),
    errs.map((e) => `${e.code}@${e.at}`).join(" ") || "accepted a card it should reject");
};

const goodRes = good && lint(good);
check("good card passes lint", goodRes && goodRes.ok === true,
  goodRes ? `cells=${goodRes.stats.cells_occupied} footprint=${JSON.stringify(goodRes.stats.footprint)}` : "");

if (good) {
  const R = good.roles;
  const E = (i) => i - 1;          // Lua is 1-based, JS is not
  const m = () => clone();
  let c;

  c = m(); c.entities[E(R.in_chest)].name = "definitely-not-an-entity";
  expectReject("lint rejects unknown entity", c, "UNKNOWN_ENTITY");

  c = m(); c.entities[E(R.arms[0])].name = "stack-inserter";
  expectReject("lint rejects unresearched part", c, "LOCKED_ENTITY");
  c = m(); c.entities[E(R.arms[0])].name = "stack-inserter";
  const freed = lint(c, { ignore_locked: true });
  check("ignore_locked lints geometry only", freed.ok === true, asArr(freed.errors).map((e) => e.code).join(" ") || "ok");

  c = m(); c.entities[E(R.machines[0])].position.x += 0.5;
  expectReject("lint rejects off-grid centre", c, "MISALIGNED");

  c = m(); const f = c.entities[E(R.machines[0])].position;
  c.entities[E(R.in_chest)].position = { x: f.x, y: f.y };
  expectReject("lint rejects overlapping entities", c, "OVERLAP");

  // Park a belt directly east of an arm and point it west into that arm: solid, by
  // construction rather than by assuming which cell the template happened to use.
  c = m();
  const arm = c.entities[E(R.arms[0])].position;
  const belt = c.entities[E(R.belts[0])];
  belt.position = { x: arm.x + 1, y: arm.y };
  belt.direction = 12;
  expectReject("lint rejects belt pointing into an arm", c, "BELT_INTO_SOLID");

  c = m(); c.entities[E(R.machines[0])].position = { x: 40, y: 40 };
  expectReject("lint rejects machine with no arm", c, "MACHINE_NO_ARM");

  c = m(); c.ports.out[0].entity = 999;
  expectReject("lint rejects dangling port", c, "PORT_UNKNOWN_ENTITY");

  c = m(); c.entities = [];
  const empty = lint(c);
  check("lint rejects empty card", asArr(empty.errors).some((e) => e.code === "EMPTY_CARD"),
    asArr(empty.errors).map((e) => e.code).join(" "));

  // An error the author cannot locate is not actionable: each one has to name the entity.
  c = m(); const fp2 = c.entities[E(R.machines[0])].position;
  c.entities[E(R.in_chest)].position = { x: fp2.x, y: fp2.y };
  const errs = asArr(lint(c).errors);
  check("errors name the entity to fix", errs.length > 0 && errs.every((e) => e.at !== undefined && e.msg),
    errs.map((e) => `${e.code}#${e.at}`).join(" "));
}

// ---- engine judgement: the tier lint cannot replace ----

const wait = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
// The verification surface generates chunks asynchronously, so the first call after a
// restart legitimately says "not yet". Retry the wait, never the write.
const verifyCard = (card, extra) => {
  let r = {};
  for (let i = 0; i < 10; i++) {
    r = call("card_verify", Object.assign({ card }, extra || {}));
    if (r.ok || r.code !== "SANDBOX_GENERATING") return r;
    wait(1000);
  }
  return r;
};

const v = (good && verifyCard(good)) || {};
check("good card verifies in the engine", v.ok && v.data.ok === true,
  v.ok ? `placed ${v.data.placed}/${v.data.requested} destroyed=${v.data.destroyed}` : `${v.code} ${v.msg || ""}`);
check("every arm resolves to a real pickup and drop", v.ok && asArr(v.data.arms).length === 3
  && asArr(v.data.arms).every((a) => a.pickup && a.drop),
  v.ok ? asArr(v.data.arms).map((a) => `${a.pickup}>${a.drop}`).join("  ") : "");

// The reach-2 arm shifted one tile still lints clean -- reach is not static knowledge --
// but the engine sees the hand land on empty ground. This pair is the whole argument
// for two feedback tiers, so it is asserted, not just demonstrated once.
if (good) {
  const blind = clone();
  blind.entities[good.roles.arms[0] - 1].position.x -= 1;
  const stillLints = lint(blind);
  const caught = verifyCard(blind);
  check("lint passes a broken arm the engine rejects",
    stillLints.ok === true && caught.ok && asArr(caught.data.errors).some((e) => e.code === "ARM_PICKS_NOTHING"),
    `lint=ok engine=${asArr(caught.ok ? caught.data.errors : []).map((e) => e.code).join(",")}`);
}

r = (good && call("card_lab", { card: good, seconds: 60, speed: 40 })) || {};
check("card_lab starts on a linting card", r && r.ok && r.data.state === "running",
  r && r.ok ? `feed=${r.data.feeds} fuelled=${r.data.fuelled_machines} supply=${r.data.supplied_grid}` : `${r && r.code} ${r && r.msg || ""}`);
r = call("lab_status");
const mdeadline = Date.now() + 40000;
while (r.ok && r.data.state === "running" && Date.now() < mdeadline) {
  execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
  r = call("lab_status");
}
const m = r.ok ? r.data : {};
check("submitted card delivers its contract", m.state === "done" && m.delivered === true,
  asArr(m.verdicts).map((x) => `${x.item} ${x.produced} vs claim ${x.claimed_per_min}/min -> ${x.measured_per_min}/min (met ${x.met})`).join("  "));
check("measured rate is inside the warm-up band", typeof m.ratio_measured_over_expected === "number"
  && m.ratio_measured_over_expected > 0.8 && m.ratio_measured_over_expected < 1.2,
  `ratio=${m.ratio_measured_over_expected} pay_fraction=${m.pay_fraction}`);
check("fuel actually reached the burner", m.diagnostics && m.diagnostics.fuel_left > 0 && m.fuel_blocked < 60,
  `fuel_left=${m.diagnostics && m.diagnostics.fuel_left} fuelled=${m.fuelled} fuel_blocked=${m.fuel_blocked}`);
check("measurement tears the card down", m.destroyed > 0 && m.missing_entities === 0 && m.game_speed === 1,
  `destroyed=${m.destroyed} missing=${m.missing_entities} speed=${m.game_speed}`);
check("no tick-handler error", !m.tick_error, m.tick_error || "");

// The referee has to be able to say no: an over-claiming card must be rejected.
if (good) {
  const braggart = clone();
  braggart.contract.outputs["iron-plate"] = 500;
  r = call("card_lab", { card: braggart, seconds: 60, speed: 40 });
  check("over-claiming card is measured too", r.ok, r.ok ? `claim ${r.data.expected_per_min}/min` : `${r.code} ${r.msg || ""}`);
  r = call("lab_status");
  const bdeadline = Date.now() + 40000;
  while (r.ok && r.data.state === "running" && Date.now() < bdeadline) {
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
    r = call("lab_status");
  }
  check("engine rejects a card that cannot pay its claim", r.ok && r.data.delivered === false,
    asArr(r.ok ? r.data.verdicts : []).map((x) => `claimed ${x.claimed_per_min} got ${x.measured_per_min} met=${x.met}`).join(" "));
  call("lab_reset");
}

// ---- a card nobody templated: hand-authored geometry, judged the same way ----
// The lane fixture comes from lane_units, so it can only ever re-prove lane_units.
// This one was written by hand from footprint arithmetic, and its measured rate is
// the reason the pipeline exists: the geometry is perfect and the single arm still
// cannot feed the assembler at nameplate.
const gearPath = path.join(__dirname, "card_gear.json");
const gear = JSON.parse(require("fs").readFileSync(gearPath, "utf8"));
const gcheck = call("card_check", { card: gear });
check("hand-authored card lints", gcheck.ok && gcheck.data.ok === true,
  gcheck.ok ? `footprint=${JSON.stringify(gcheck.data.stats.footprint)}` : `${gcheck.code} ${gcheck.msg || ""}`);
const gv = verifyCard(gear);
check("hand-authored card verifies", gv.ok && gv.data.ok === true
  && asArr(gv.data.arms).every((a) => a.pickup && a.drop),
  gv.ok ? asArr(gv.data.arms).map((a) => `${a.pickup}>${a.drop}`).join("  ") : `${gv.code} ${gv.msg || ""}`);

r = call("card_lab", { card: gear, seconds: 60, speed: 40 });
check("recipe is bound to the assembler", r.ok && asArr(r.data.recipes_bound).length === 1,
  r.ok ? asArr(r.data.recipes_bound).map((b) => `${b.machine}=${b.recipe}`).join(" ") : `${r.code} ${r.msg || ""}`);
r = call("lab_status");
const gdeadline = Date.now() + 40000;
while (r.ok && r.data.state === "running" && Date.now() < gdeadline) {
  execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
  r = call("lab_status");
}
const gm = r.ok ? r.data : {};
const gearRate = gm.verdicts && gm.verdicts[0] ? gm.verdicts[0].measured_per_min : -1;
check("assembler card runs but is arm-limited", gm.state === "done" && gearRate > 20 && gearRate < 55,
  `measured=${gearRate}/min against a ${gm.contract ? gm.contract["iron-gear-wheel"] : "?"}/min claim`);
check("an over-claim is reported as not delivered", gm.delivered === false,
  `delivered=${gm.delivered} pay_fraction=${gm.pay_fraction}`);
call("lab_reset");

// ---- freeze: a measured card becomes reusable data, not a rerun ----
if (good) {
  const lab0 = call("card_lab", { card: good, seconds: 60, speed: 40 });
  // Giving a surface a global electric network cannot be undone, and it changes what every later
  // power question on that surface means. The lab used to do it to `game.surfaces[1]` -- the player's
  // own world -- on the default path and never mention it. An unnamed surface is now the bench, and
  // the bench reports what it did to it.
  check("the lab names the surface it measured on and whether it converted that grid",
    lab0.ok && !!lab0.data.ideal_grid && lab0.data.ideal_grid.surface === "arch-lab"
    && (lab0.data.ideal_grid.converted_here === true || lab0.data.ideal_grid.was_global === true),
    lab0.ok ? JSON.stringify(lab0.data.ideal_grid) : `${lab0.code} ${lab0.msg}`);
  let s0 = call("lab_status").data;
  const fdead0 = Date.now() + 30000;
  while (s0.state === "running" && Date.now() < fdead0) {
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
    s0 = call("lab_status").data;
  }
}
// A force that is not in the save used to reach `availability_checker`, which indexes
// `force.recipes`, and raise: thirteen methods answer NO_FORCE and `card_freeze` was the fourteenth
// that did not, on the one path (an unmeasured freeze) where it builds a checker at all.
{
  const r = call("card_freeze", { card: gear, allow_unmeasured: true, force: "nobody" });
  check("card_freeze refuses a force this save does not have", !r.ok && r.code === "NO_FORCE",
    `${r.code || "accepted"} ${String(r.msg).slice(0, 60)}`);
}
const fz = call("card_freeze", { name: "smoke-lane" });
// `card_place` took the force name straight to `can_place_entity`, which raises on a force that is
// not in the save. It can only be reached once a card is frozen, so this is where it belongs.
{
  const r = call("card_place", { name: "smoke-lane", force: "nobody" });
  check("card_place refuses a force this save does not have", !r.ok && r.code === "NO_FORCE",
    `${r.code || "accepted"} ${String(r.msg).slice(0, 60)}`);
}
check("a delivered card freezes", fz.ok && fz.data.frozen === true,
  fz.ok ? `measured ${JSON.stringify(fz.data.measured)} of claim ${JSON.stringify(fz.data.claimed)}` : `${fz.code} ${fz.msg || ""}`);
check("freeze emits a shareable blueprint string", fz.ok && /^0e/.test(fz.data.blueprint || ""),
  fz.ok ? `${fz.data.blueprint.length} bytes` : "");
const cl = call("cards", {});
check("frozen cards are listed", cl.ok && cl.data.count >= 1,
  cl.ok ? asArr(cl.data.cards).map((c) => `${c.name}:${c.entities}e`).join(" ") : cl.code);

// ---- the player-facing panel ----
// A headless server has no player, so not one widget can be built or clicked here. What CAN
// be pinned is the data the window renders and the code its buttons call: if either drifts,
// the panel would lie to someone standing in the game.
{
  const gm = call("gui_model", {});
  const listed = gm.ok ? asArr(gm.data.cards) : [];
  // by name, not by position: any other check that freezes a card would otherwise move it
  const laneRow = listed.find((c) => c.name === "smoke-lane") || {};
  check("the panel's model lists the frozen card with what it produces",
    gm.ok && laneRow.entities > 0 && laneRow.label.indexOf("iron-plate") >= 0 && /min/.test(laneRow.label)
      && laneRow.blueprint === true && laneRow.proven === true,
    gm.ok ? listed.map((c) => `${c.name}: ${c.entities}e, "${c.label}", proven=${c.proven}`).join(" | ") : `${gm.code} ${gm.msg}`);
  const placePath = call("card_place", { name: "smoke-lane", surface: "arch-sandbox", ghosts: true });
  check("what the Place button calls really drops one ghost per entity",
    placePath.ok && placePath.data.ghosts === laneRow.entities && asArr(placePath.data.refused).length === 0,
    placePath.ok ? `${placePath.data.ghosts}/${laneRow.entities} ghosts at ${placePath.data.origin.x},${placePath.data.origin.y} on ${placePath.data.surface}` : `${placePath.code} ${placePath.msg}`);
  // The widgets themselves need a client, but the build code does not: run it against a
  // recording stand-in and assert the tree it produces and that every button dispatches.
  const st = call("gui_selftest", {});
  const tree = st.ok ? asArr(st.data.tree).join(" ") : "";
  // `built` is the one fact about the panel that no headless assertion used to check: `G.open`
  // swallows a raise from the widget build, prints one chat line to a player who may not exist, and
  // returns nil. A change that made the whole panel fail to build -- an expression the sandbox
  // refuses, a name the engine rejects -- left every other GUI assertion passing on a half-built tree.
  check("the panel actually builds, and a swallowed raise is not silently a smaller window",
    st.ok && st.data.built === true
    && !asArr(st.data.printed).some((m) => /could not build/i.test(String(m))),
    `${st.data.widgets} widgets; printed ${JSON.stringify(asArr(st.data.printed).slice(0, 1))}`);
  // Card names come from a caller, so they are arbitrary text. `truncated` cut BYTES, which split a
  // UTF-8 sequence mid-character and made the client draw a broken glyph where the name should be;
  // the fix's own first attempt used the `utf8` library, which Factorio's sandbox does not have, and
  // that turned the whole panel into a swallowed raise. Both directions are pinned here.
  {
    const cjk = "机械臂产线卡片名称很长超过四十个字符上限继续下去机械臂产线卡片名称很长超过";
    const one = call("gui_selftest", {
      cards: { [cjk]: { card: { entities: [{ name: "pipe", position: { x: 0.5, y: 0.5 } }],
        contract: { outputs: { "iron-plate": 18.75 } } }, measured_this_card: true } },
    });
    const cell = asArr(one.data && one.data.tree).find((l) => String(l).includes("label") && String(l).includes("机械"));
    let decodable = false;
    if (cell) {
      try { new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(String(cell), "utf8")); decodable = true; }
      catch (e) { decodable = false; }
    }
    check("a card named outside ASCII still renders, cut on a character boundary",
      one.ok && one.data.built === true && !!cell && decodable
      && /\.\.\.\s*'?$/.test(String(cell)),
      cell ? `cell ends cleanly: ${JSON.stringify(String(cell).slice(-12))}` : `no name cell (built=${one.data && one.data.built})`);
  }
  const want = ["arch-place:smoke-lane", "arch-string:smoke-lane", "/min iron-plate"];
  check("the panel renders a row and both buttons for the frozen card",
    st.ok && st.data.built === true && want.every((w) => tree.includes(w)),
    st.ok ? `${st.data.widgets} widgets, ${asArr(st.data.tree).filter((l) => /button/.test(l)).length} buttons`
      + `; missing ${JSON.stringify(want.filter((w) => !tree.includes(w)))}` : `${st.code} ${st.msg}`);
  // ...and the click loop has to click what was rendered. It used to iterate five hand-written
  // names -- `arch-place:demo`, `arch-string:demo` -- so the two buttons this panel builds for every
  // real frozen card were asserted to EXIST and never asserted to WORK: the rendering above and the
  // dispatch below were two different lists, and only a player clicking could find the gap.
  {
    const clicks = asArr(st.data.clicks).map(String);
    // the full element name, suffix included: `arch-place:smoke-lane` is the button, and the click
    // line the selftest reports carries that same name
    const rendered = asArr(st.data.tree)
      .map((l) => (String(l).match(/\[((?:arch|-)[^\]]*)\]/) || [])[1])
      .filter((n) => !!n && /^arch-/.test(n));
    const unique = [...new Set(rendered)];
    check("every button the panel rendered is driven through the click handler",
      st.ok && unique.filter((n) => /button|text-.*/.test(n) || true).length >= 3
      && unique.every((n) => clicks.some((c) => c.startsWith(n + " ->")))
      && clicks.some((c) => /^not-ours -> unhandled$/.test(c)),
      `${unique.length} rendered (${unique.join(", ")}); ${clicks.length} clicks`);
  }
  // A blueprint string that cannot be copied is not a deliverable: chat text cannot be selected, so
  // the click has to land in a field that is selected for the hand. `bridge` is the same click going
  // through the real api rather than a stand-in that hand-writes `ok = true`.
  const sf = st.ok && st.data.string_field;
  check("String puts the blueprint in a copyable field, selected",
    st.ok && /textfield\[arch-string-out\]/.test(tree) && sf && /^0eNq/.test(sf.text) && sf.selected === true,
    JSON.stringify({ bridge: st.ok && st.data.bridge, field: sf }));
  // Two freeze doors, labelled differently. The plan -> freeze -> place path must work for a
  // REGION without a lab run, and must never claim the run happened.
  const cellForFreeze = JSON.parse(require("fs").readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));
  const layR = call("region_layout", {
    entries: [{ card: good }, { card: call("bus_example", { taps: 2 }).data }, { card: cellForFreeze, count: 2 }],
    power: true,
  });
  const bare = call("card_freeze", { card: layR.ok ? layR.data.card : {}, name: "smoke-region" });
  check("freezing a card you hold is refused unless the unmeasured door is named",
    !bare.ok && bare.code === "NOT_MEASURED", bare.code || "unexpectedly frozen");
  const un = call("card_freeze", { card: layR.data.card, name: "smoke-region", allow_unmeasured: true });
  const placed = un.ok ? call("card_place", { name: "smoke-region", surface: "arch-sandbox", ghosts: true }) : un;
  check("a region freezes unmeasured and places every entity as a ghost",
    un.ok && un.data.measured_this_card === false && placed.ok && placed.data.ghosts === un.data.entities,
    un.ok ? `${un.data.entities} entities, measured=${un.data.measured_this_card}, ghosts=${placed.ok ? placed.data.ghosts : placed.code}` : `${un.code} ${un.msg}`);
  const gmRow = (call("gui_model", {}).data || {}).cards || [];
  const regionRow = asArr(gmRow).find((c) => c.name === "smoke-region") || {};
  check("an unmeasured freeze says so in the record and on the panel",
    un.ok && /unmeasured/.test(un.data.note || "") && regionRow.proven === false
      && /planned, not measured/.test(regionRow.label || ""),
    `${(un.data.note || "").slice(0, 60)} | row proven=${regionRow.proven} label="${(regionRow.label || "").slice(0, 46)}"`);

  const clicks = st.ok ? asArr(st.data.clicks) : [];
  check("every panel button dispatches, and names that are not ours are ignored",
    clicks.some((c) => /arch-place:.* -> place/.test(c)) && clicks.some((c) => /arch-string:.* -> string/.test(c))
      && clicks.some((c) => /not-ours -> unhandled/.test(c)) && !clicks.some((c) => /ERROR/.test(c)),
    clicks.join(" | ").slice(0, 220) || "no clicks recorded");

  lua(`local s=game.surfaces["arch-sandbox"] local g=s.find_entities_filtered{type="entity-ghost"}
for _,e in ipairs(g) do e.destroy() end rcon.print("cleared "..#g.." ghosts")`);
}
const cb = call("card_blueprint", { name: "smoke-lane" });
check("blueprint re-exports deterministically", cb.ok && cb.data.blueprint === fz.data.blueprint,
  cb.ok ? `${cb.data.bytes} bytes` : cb.code);

// An undelivered card must never be freezable -- that is the whole point of gating.
if (good) {
  const brag = clone();
  brag.contract.outputs["iron-plate"] = 500;
  call("card_lab", { card: brag, seconds: 30, speed: 40 });
  let s2 = call("lab_status").data;
  const fdead = Date.now() + 30000;
  while (s2.state === "running" && Date.now() < fdead) {
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
    s2 = call("lab_status").data;
  }
  const nofreeze = call("card_freeze", { name: "should-not-exist" });
  check("a card that missed its claim cannot be frozen", !nofreeze.ok && nofreeze.code === "NOT_DELIVERED",
    nofreeze.code || "it froze anyway");
  const after = call("cards", {});
  check("and never enters the library", !asArr(after.data.cards).some((c) => c.name === "should-not-exist"),
    after.ok ? `${after.data.count} cards` : "");
  call("lab_reset");
}

// ---- power coverage: statically unknowable, so the engine is the only witness ----
const gp = JSON.parse(require("fs").readFileSync(path.join(__dirname, "card_gear_power.json"), "utf8"));
const gpv = verifyCard(gp);
const pw = gpv.ok ? gpv.data.power : {};
check("a card that carries its own pole covers every machine",
  gpv.ok && pw.uncovered === 0 && pw.covered === pw.powered_entities && pw.powered_entities > 0,
  gpv.ok ? `${pw.covered}/${pw.powered_entities} covered, ${pw.demand_kw}kW draw vs ${pw.in_card_supply_kw}kW in-card` : `${gpv.code} ${gpv.msg || ""}`);
check("connected-but-undersupplied is reported as such",
  gpv.ok && asArr(gpv.data.warnings).some((w) => w.code === "GRID_UNDER_PROVISIONED"),
  asArr(gpv.ok ? gpv.data.warnings : []).map((w) => w.code).join(" "));
check("a pole-less card is told to join the base grid, not that it is broken",
  v.ok && v.data.ok === true && asArr(v.data.warnings).some((w) => w.code === "NEEDS_EXTERNAL_GRID"),
  asArr(v.ok ? v.data.warnings : []).map((w) => w.code).join(" "));

// ---- the verdict has to come with the fix: plan -> apply -> re-judge ----
// A rejection that only says "not covered" leaves the model guessing. This asserts the
// loop actually closes, i.e. that a searched-for power plan survives being applied.
const pres = call("card_fix_power", { card: gear });
const plan = pres.ok ? pres.data : {};
check("power plan finds additions for a card that carries none",
  pres.ok && plan.powered > 0 && plan.to_add > 0 && plan.probes > 0,
  pres.ok ? `${plan.to_add} additions found by ${plan.probes} probes, ${plan.powered} machines powered` : `${pres.code} ${pres.msg || ""}`);
check("plan claims a complete fix without running out of search",
  pres.ok && plan.still_unserved === 0 && !plan.exhausted_search,
  pres.ok ? `served ${plan.served}/${plan.powered}, ${plan.probes} probes, 0 ticks` : "");
// The pole it chose and the menu that choice came from. Reach is not readable off a pole prototype, so
// the ranking is either measured or honestly unranked -- and an unranked menu listing four poles looks
// exactly like four measured ones unless the answer says which it is.
const poleMenu = asArr(plan.pole_candidates);
check("the pole answer lists its menu and says whether that menu was ranked",
  pres.ok && !!plan.pole_how && plan.ranked === false && poleMenu.length >= 4
  && poleMenu.every((e) => e.wire_tiles === null || e.wire_tiles === undefined),
  `${plan.pole}  ranked=${JSON.stringify(plan.ranked)}  ${poleMenu.map((e) => e.name).join(" ")}  how=${plan.pole_how}`);
// A pole name this install does not have must be refused by name. It used to fall through to
// `create_entity` and surface as a raw runtime error from inside a placement.
// The pad the grid is planned on has to stay answerable -- that is the whole reason the rigs got a
// surface of their own. A pole's reach cannot be measured on a surface that already carries a global
// electric network, and `create_global_electric_network` cannot be undone, so a measurement job may
// only ever convert the bench it was given. `state` is the one method that reports which surfaces
// have been: it computes the fact that would have revealed this, and used to be called by nobody.
const afterLab = call("state", {});
const grids = Object.values((afterLab.data || {}).surfaces || {});
check("measuring a card leaves the planning surface able to answer a power question",
  afterLab.ok && grids.length >= 2
  && (grids.find((s) => s.surface === "arch-sandbox") || {}).has_global_electric_network === false
  && (grids.find((s) => s.surface === "arch-lab") || {}).has_global_electric_network === true,
  grids.map((s) => `${s.surface}=${s.has_global_electric_network}`).join(" "));
const badPole = call("card_fix_power", { card: gear, pole: "not-a-real-pole" });
check("an unknown pole name is refused by name, with the poles that are here",
  !badPole.ok && badPole.code === "UNKNOWN_POLE" && asArr(badPole.detail && badPole.detail.known).length >= 1,
  `${badPole.code || "accepted"} ${JSON.stringify((badPole.detail || {}).known)}`);
// The region path has to refuse it too. There the answer came back from inside the tier loop, where a
// refusal reads as "this tier did not work" -- so a typo escalated to the next pole and returned a
// plan built with a pole nobody asked for, marked ok.
const badRegion = call("region_layout", {
  entries: [{ card: gear }], power: true, size: false, pole: "not-a-real-pole",
});
check("region_layout refuses an unknown pole instead of escalating past it",
  !badRegion.ok && badRegion.code === "UNKNOWN_POLE"
  && asArr(badRegion.detail && badRegion.detail.known).length >= 4,
  `${badRegion.code || "accepted"} ${JSON.stringify((badRegion.detail || {}).known)}`);
// Four methods wrote `args.surface and resolve_surface(...) or game.surfaces[1]`, which cannot tell
// "not named" from "named wrong": a typo resolves to nil, the `or` swallows it, and the method
// measures the player's main surface and reports success. Their own NO_SURFACE branches were
// therefore unreachable -- a code no caller can trigger is a code nobody ever tested.
for (const [label, m, a] of [
  ["region_layout", "region_layout", { entries: [{ card: gear }], surface: "nauvis-two" }],
  ["power_plan", "power_plan", { surface: "nauvis-two", demand_kw: 100 }],
  ["drill_rate", "drill_rate", { surface: "nauvis-two", resource: "iron-ore", seconds: 1 }],
  ["pump_rate", "pump_rate", { surface: "nauvis-two", fluid: "crude-oil", seconds: 1 }],
]) {
  const r = call(m, a);
  check(`${label} refuses a surface this save does not have`, !r.ok && r.code === "NO_SURFACE",
    `${r.code || "accepted"} ${JSON.stringify((r.detail || {}).surfaces || null)}`);
}

if (pres.ok && plan.still_unserved === 0) {
  const fixed = JSON.parse(JSON.stringify(gear));
  for (const s of plan.suggestion) fixed.entities.push(s);
  const fcheck = lint(fixed);
  const fv = verifyCard(fixed);
  check("applying the plan keeps the card legal", fcheck.ok === true,
    asArr(fcheck.errors).map((e) => e.code).join(" ") || "ok");
  check("applying the plan actually powers every machine",
    fv.ok && fv.data.power.uncovered === 0 && fv.data.power.covered === fv.data.power.powered_entities
      && !asArr(fv.data.warnings).some((w) => w.code === "NEEDS_EXTERNAL_GRID"),
    fv.ok ? `${fv.data.power.covered}/${fv.data.power.powered_entities} covered` : `${fv.code} ${fv.msg || ""}`);
}

// ---- composition: two cards become one card, judged by the same three tiers ----
// Lane: ore -> plate. Cell: plate -> gear. Fusing the lane's out chest with the cell's
// in chest makes plate an internal flow, so the region's contract must name gears only.
// Neither card alone can tell you the region's ceiling; it is min(plates/2, capacity).
const cellCard = JSON.parse(require("fs").readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));
const laneOut = good && good.entities[good.ports.out[0].entity - 1].position;
const cellIn = cellCard.entities[cellCard.ports["in"][0].entity - 1].position;
const seam = good && { x: laneOut.x - cellIn.x, y: laneOut.y - cellIn.y };

const composed = good && call("card_compose", {
  slots: [{ card: good, at: { x: 0, y: 0 } }, { card: cellCard, at: seam }],
});
const cm = composed && composed.ok ? composed.data : null;
check("two cards fuse into one at a shared port", !!cm && cm.report.fusions.length === 1
  && cm.report.fusions[0].item === "iron-plate",
  cm ? `fused at ${cm.report.fusions[0].cell}, ${cm.entities.length} entities` : `${composed && composed.code} ${(composed && composed.msg) || ""}`);
check("the intermediate product leaves the contract", !!cm
  && cm.internal_flows.includes("iron-plate") && cm.contract.outputs["iron-plate"] === undefined
  && cm.contract.outputs["iron-gear-wheel"] !== undefined,
  cm ? `internal=${JSON.stringify(cm.internal_flows)} contract=${JSON.stringify(cm.contract)}` : "");
check("a composed card still lints clean", !!cm && cm.ok === true,
  cm ? "" : JSON.stringify(cm && cm.lint ? cm.lint.errors : "n/a"));
check("the seam chest keeps both arms' reach", !!cm && (() => {
  const v = verifyCard(cm);
  return v.ok && v.data.arms.length === 5 && asArr(v.data.errors).every((e) => e.code !== "ARM_PICKS_NOTHING");
})(), cm ? "" : "skipped");

// A misaligned seam does not overlap, so it is not an error -- it composes into two
// disconnected halves. The property that matters is that this stays VISIBLE: the plate
// flow remains an external port instead of silently vanishing, so a later measurement
// or the author can see the seam never closed.
const badSeam = good && call("card_compose", {
  slots: [{ card: good, at: { x: 0, y: 0 } }, { card: cellCard, at: { x: seam.x + 1, y: seam.y } }],
});
const bs = badSeam && badSeam.ok ? badSeam.data : null;
check("a seam that misses stays visible instead of vanishing", !!bs
  && asArr(bs.report.fusions).length === 0
  && asArr(bs.ports["in"]).some((p) => p.item === "iron-plate"),
  bs ? `${asArr(bs.report.fusions).length} fusions, in ports=${JSON.stringify(asArr(bs.ports["in"]).map((p) => p.item))}` : `${badSeam && badSeam.code}`);

// ---- a fluid card: the shape every oil design has, and the shape compose could not sort ----
// `crude-oil` and `water` are two in-ports on ONE entity, both with `item = nil`. Three comparators
// in compose fell through to `a.item < b.item`, so composing anything with two fluids on a face
// raised "attempt to compare two nil values" -- and `region` composes even a single seeded card, so
// `region_layout` on a refinery died before it ever looked at the ground. No fixture had two fluid
// ports on one entity, which is why it stayed green.
const refine = JSON.parse(require("fs").readFileSync(path.join(__dirname, "card_refine.json"), "utf8"));
const oilRegion = call("region_layout", {
  entries: [{ card: refine }, { card: refine, at: { x: 20, y: 0 } }],
});
check("a region of oil cards composes instead of raising", oilRegion.ok === true,
  oilRegion.ok ? `${oilRegion.data.card.entities.length} entities` : `${oilRegion.code} ${String(oilRegion.msg).slice(0, 90)}`);
const oil = oilRegion.ok ? oilRegion.data.card : {};
const oilMr = oil.machine_recipes || {};
check("the recipe each machine was declared with survives the renumbering",
  Object.keys(oilMr).length === 2 && Object.keys(oilMr).every((k) => oilMr[k] === "advanced-oil-processing")
  && Object.keys(oilMr).every((k) => !!oil.entities[Number(k) - 1]),
  `keys=${JSON.stringify(Object.keys(oilMr))} every index names a merged entity`);
check("a fluid claim stays a fluid claim through composition",
  oil.contract && oil.contract.outputs && oil.contract.fluid_outputs
  && oil.contract.fluid_outputs["petroleum-gas"] === 1320
  && oil.contract.outputs["petroleum-gas"] === undefined,
  JSON.stringify(oil.contract || null));
check("both fluid in-ports of both refineries are still boundaries",
  asArr(oil.ports && oil.ports["in"]).length === 4 && asArr(oil.ports.out).length === 2
  && asArr(oil.ports["in"]).every((p) => !!p.fluid),
  `in=${asArr(oil.ports && oil.ports["in"]).length} out=${asArr(oil.ports && oil.ports.out).length}`);
// A belt pointing into an underground is a legal, ordinary thing to write down. Reading
// `belt_to_ground_type` off a *prototype* -- where 2.0 does not keep it -- made lint raise, so the
// card could not even be told about. The rule is now an honest warning that names its own limit.
const ugCard = {
  name: "belt-into-underground",
  entities: [
    { name: "transport-belt", position: { x: 0.5, y: 0.5 }, direction: 4 },
    { name: "underground-belt", position: { x: 1.5, y: 0.5 }, direction: 4 },
  ],
};
const ug = call("card_check", { card: ugCard });
check("a belt feeding an underground lints instead of raising", ug.ok === true,
  ug.ok ? `${asArr(ug.data.warnings).map((w) => w && w.code).join(" ")} / ${asArr(ug.data.errors).length} errors` : `${ug.code} ${String(ug.msg).slice(0, 90)}`);

// ---- layout: the seam offset is derived, and the ceiling is arithmetic ----
const lay = good && call("region_layout", { entries: [{ card: good }, { card: cellCard }] });
const LY = lay && lay.ok ? lay.data : null;
check("layout derives the fuse offset without being told it", !!LY
  && LY.placements.length === 2 && LY.placements[1].fused === "iron-plate"
  && LY.placements[1].at.x === laneOut.x - cellIn.x && LY.placements[1].at.y === laneOut.y - cellIn.y,
  LY ? `offset ${JSON.stringify(LY.placements[1].at)} fused=${JSON.stringify(LY.placements.map((p) => p.fused))}` : `${lay && lay.code}`);
check("layout internalises the seam and re-exports one contract", !!LY
  && asArr(LY.internal_flows).includes("iron-plate") && LY.contract.outputs["iron-gear-wheel"] !== undefined
   && asArr(LY.lint.errors).length === 0,
  LY ? `${LY.entities} entities, internal=${JSON.stringify(LY.internal_flows)} fusions=${JSON.stringify(LY.fusions || null)}` : "");
const flowPlate = LY && asArr(LY.flows).find((f) => f.item === "iron-plate");
check("layout says what the chain can actually ship", !!flowPlate && flowPlate.feasible === false
  && Math.abs(flowPlate.max_supported_per_min - 18.75 / 2) < 1e-6,
  flowPlate ? `supply ${flowPlate.supplied_per_min} plate/min, demand ${flowPlate.demanded_per_min}, ceiling ${flowPlate.max_supported_per_min} gear/min` : "no flow reported");
check("the reported ceiling matches what a measurement later finds", !!flowPlate
  && Math.abs(flowPlate.max_supported_per_min - 9) < 1, `arithmetic ${flowPlate && flowPlate.max_supported_per_min} vs measured 9`);

// ---- fan-out: extra anchors add reach, never throughput ----
const lane2 = call("card_example", { outlets: 2 }).data;
check("a second output anchor exposes a second port, not a second furnace",
  !!lane2 && asArr(lane2.ports.out).length === 2 && lane2.roles.out_chests.length === 2,
  lane2 ? `anchors ${JSON.stringify(lane2.roles.out_chests)}, ${lane2.entities.length} entities` : "");
r = call("card_lab", { card: lane2, seconds: 60, speed: 40 });
let s3 = call("lab_status").data;
const l2dead = Date.now() + 30000;
while (s3.state === "running" && Date.now() < l2dead) {
  execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
  s3 = call("lab_status").data;
}
check("splitting one furnace across two chests does not double its output",
  s3.state === "done" && s3.measured_per_min > 14 && s3.measured_per_min < 22,
  `measured ${s3.measured_per_min}/min against a single-furnace claim of ${s3.expected_per_min}/min`);
call("lab_reset");

const fan = good && call("region_layout", { entries: [{ card: lane2 }, { card: cellCard, count: 2 }] });
const FAN = fan && fan.ok ? fan.data : null;
const fanFlow = FAN && asArr(FAN.flows).find((f) => f.item === "iron-plate");
check("a card's rate is counted once however many chests it feeds through", !!fanFlow
  && Math.abs(fanFlow.supplied_per_min - 18.75) < 1e-6,
  fanFlow ? `supply ${fanFlow.supplied_per_min}/min from ${fanFlow.anchors_sharing_supply} anchors` : "");
check("demand only counts consumers that actually connected", !!FAN
  && Math.abs(fanFlow.demanded_per_min - 120) < 1e-6
  && asArr(fanFlow.demanded_from_outside).length === 1,
  fanFlow ? `demand ${fanFlow.demanded_per_min}, outside-needed by ${JSON.stringify(fanFlow.demanded_from_outside)}` : "");
check("an emergent split is flagged instead of being guessed at", !!fanFlow
  && fanFlow.ceiling_is_upper_bound === true && !!fanFlow.note,
  fanFlow ? `ceiling ${fanFlow.max_supported_per_min}/min is an upper bound` : "");
const packed = FAN && asArr(FAN.placements).find((p) => p.packed);
check("a card that could not fuse says which anchors it tried", !!packed
  && asArr(packed.why_not_fused).length > 0 && !!packed.needed_anchor,
  packed ? `${asArr(packed.why_not_fused).length} anchors tried, blocked at ${JSON.stringify(asArr(packed.why_not_fused)[0].blocking_cells)}` : "no packed card");

// ---- the belt bus: what chests could not do ----
const bus = call("bus_example", { taps: 2 }).data;
const bl = call("card_check", { card: bus });
check("a bus lints clean and its taps resolve belt to chest", bl.data.ok === true,
  bl.data.ok ? `${bus.entities.length} entities, footprint ${JSON.stringify(bl.data.stats.footprint)}` : JSON.stringify(asArr(bl.data.errors).map((e) => e.code)));
const bv = verifyCard(bus);
check("every tap arm reaches the belt and drops on its own chest",
  bv.ok && asArr(bv.data.arms).filter((a) => a.pickup === "fast-transport-belt" && a.drop === "steel-chest").length === 2,
  bv.ok ? asArr(bv.data.arms).map((a) => `${a.pickup}>${a.drop}`).join(" ") : `${bv.code} ${bv.msg || ""}`);

const lined = good && call("region_layout", { entries: [{ card: good }, { card: bus }, { card: cellCard, count: 2 }] });
const LN = lined && lined.ok ? lined.data : null;
const seams = LN ? asArr(LN.placements).filter((p) => p.fused) : [];
check("a line wires up: producer to bus, bus to each consumer", !!LN && seams.length === 3
  && asArr(LN.placements).every((p) => p.seed || p.fused),
  LN ? seams.map((p) => `${p.ref}@${p.at.x},${p.at.y}`).join("  ") : `${lined && lined.code} ${lined && lined.msg || ""}`);
const tapFlow = LN && asArr(LN.flows).find((f) => f.item === "iron-plate");
check("a shared flow's ceiling divides by the ratio, not by the sum of ratios", !!tapFlow
  && Math.abs(tapFlow.max_supported_per_min - 18.75 / 2) < 1e-6,
  tapFlow ? `ceiling ${tapFlow.max_supported_per_min} from supply ${tapFlow.supplied_per_min} at conversion ${tapFlow.conversion}` : "");

// What the rig refuses to hand-feed: a consumer that never wired to its supply must
// show up as an unwired input, not quietly run off the tester's own stock.
const starved = call("card_lab", { card: LN ? LN.card : good, seconds: 30, speed: 40 });
if (starved && starved.ok) {
  let sw = call("lab_status").data;
  const swend = Date.now() + 30000;
  while (sw.state === "running" && Date.now() < swend) { wait(1000); sw = call("lab_status").data; }
  check("measuring a wired line needs no hand-fed internal input", asArr(starved.data.unwired_inputs).length === 0
    && sw.state === "done",
    `feeds=${starved.data.feeds} unwired=${asArr(starved.data.unwired_inputs).length} produced=${sw.produced}`);
  call("lab_reset");
} else {
  check("measuring a wired line needs no hand-fed internal input", false, `${starved && starved.code} ${(starved && starved.msg) || ""}`);
}

// ---- the region has to arrive powered: coverage + trunk in one pass ----
// Until now card_fix_power could only fix one card at a time, and on a real region the
// blind candidate scan spent its whole 1200-probe budget and reported "cannot fix". The
// two facts that made that scan unnecessary -- how far a supply area reaches, and how far a
// wire reaches -- are both measured off live entities here. What must hold in every layout:
// every machine ends up on a grid that can pay for it, the work is bounded, and a region that
// genuinely cannot be bridged says so with the remedy attached.
{
  const lay = call("region_layout", {
    entries: [{ card: good }, { card: bus }, { card: cellCard, count: 2 }], power: true,
  });
  const p = lay.ok ? lay.data.power : null;
  check("pole reach and wire distance are measured from the engine",
    !!p && !!p.facts && p.facts.supply_tiles > 0 && p.facts.wire_tiles > 0 && p.facts.measured === true,
    p && p.facts ? `supply area ${p.facts.supply_tiles} tiles, wire ${p.facts.wire_tiles} tiles, step ${p.facts.wire_step}` : `${lay.code} ${lay.msg}`);
  check("one pass covers every machine in a 59-entity region",
    !!p && p.still_unserved === 0 && p.served === p.powered,
    p ? `${p.served}/${p.powered} served, ${p.added} added with ${p.pole}, networks ${p.networks_before}->${p.networks_after} `
      + `via ${p.chains} chains, ${p.probes} engine calls` : "no power block");
  check("planning is bounded work: the probe budget holds and is reported",
    !!p && p.probes <= (p.probes_budget || 0),
    p ? `${p.probes} probes / budget ${p.probes_budget}` : "");
  // Either it becomes one grid, or it says why not and what would change the answer.
  // A dense region at this tech level can have nowhere legal to stand a bridging pole, and
  // the only buildable pole is the shortest one -- refusing is right, refusing silently is not.
  check("a region that cannot be merged reports the reason and the remedy",
    !!p && (p.networks_after <= 1 || (asArr(p.unmerged).length > 0 && !!p.unmerged_fix && !!p.unmerged[0].reason)),
    p ? (p.networks_after <= 1 ? `single grid via ${p.chains} chains`
      : `${p.networks_after} grids, reasons ${asArr(p.unmerged).map((u) => u.reason).join(" ")}; fix: `
        + `${p.unmerged_fix && p.unmerged_fix.pole} buildable=${p.unmerged_fix && p.unmerged_fix.buildable}`) : "");
  if (p && p.still_unserved === 0) {
    const rv = verifyCard(lay.data.card);
    check("applying the plan leaves nothing uncovered",
      rv.ok && rv.data.power.uncovered === 0 && rv.data.power.covered === rv.data.power.powered_entities,
      rv.ok ? `${rv.data.power.covered}/${rv.data.power.powered_entities} covered, networks=${rv.data.networks.length}, `
        + `warnings ${asArr(rv.data.warnings).map((w) => w.code).join(" ")}` : `${rv.code} ${rv.msg}`);
  } else {
    check("the powered region verifies as one covered grid", false, "region never reached one network");
  }
}

// ---- M14/M15: the road has a capacity, and a corridor can carry several goods ----
{
  const cor = call("corridor_example", { taps: 2, items: ["iron-plate", "copper-plate"] });
  check("a two-row corridor is one legal card", cor.ok === true && call("card_check", { card: cor.data }).data.ok === true,
    cor.ok ? `${cor.data.entities.length} entities, rows at pitch ${cor.data.row_pitch}` : `${cor.code} ${cor.msg}`);
  const lanes = cor.ok ? asArr(cor.data.lanes) : [];
  // 0.0625 tiles/tick x 60 x 8 items/tile = 30/s for a fast belt, which is the vanilla
  // figure; the point is that a 27-tile spine does NOT carry 27 times as much as a 1-tile
  // one -- a series passes its flow through every segment.
  check("each row declares its tier's throughput, independent of spine length",
    lanes.length === 2 && lanes.every((l) => l.per_min === 1800) && lanes[0].item !== lanes[1].item,
    lanes.map((l) => `${l.item}:${l.per_min}/min over ${l.spine_tiles} tiles`).join("  "));
  const inflated = JSON.parse(JSON.stringify(cellCard));
  inflated.contract = { outputs: { "iron-gear-wheel": 1500 } };
  const lay = call("region_layout", { entries: [{ card: good }, { card: cor.data }, { card: inflated }] });
  const iron = lay.ok ? asArr(lay.data.flows).find((f) => f.item === "iron-plate") : null;
  check("a flow no belt can deliver is refused, with the parallel-row fix",
    !!iron && iron.belt_limited === true && iron.feasible === false && /parallel rows/.test(iron.fix || ""),
    iron ? `${iron.demanded_per_min}/min wanted vs ${iron.belt_capacity_per_min}/min carried` : `${lay.code} ${lay.msg}`);
}

// ---- M13: sizing the supply, not just wiring it up ----
{
  const pp = call("power_plan", { demand_kw: 360 });
  const s = pp.ok ? pp.data.sizing : null;
  check("a 360kW load is sized from engine constants and survives a day",
    !!s && s.ok === true && pp.data.generator.kw_each === 60 && pp.data.storage.buffer_kj === 5000
      && pp.data.storage.out_kw === 300 && s.daily_generation_mj >= s.daily_demand_mj,
    s ? `${s.panels_total} panels + ${s.accumulators_total} accumulators; gen ${s.daily_generation_mj.toFixed(0)}MJ `
      + `vs demand ${s.daily_demand_mj.toFixed(0)}MJ; night ${pp.data.day.night_seconds}s, duty ${pp.data.day.duty.toFixed(2)}`
      : `${pp.code} ${pp.msg}`);
  check("the storage-vs-generator split is not guessed",
    !!s && !!s.search && s.search[0].panels === s.panels_total,
    s ? s.search.map((x) => `${x.panels}p/${x.accumulators || "-"}a`).join("  ") : "");
  // Make the precondition part of the check. Asserting on "nuclear-reactor is locked" only
  // works on a save nobody has touched, and one exploratory research call earlier in the
  // session turned a passing suite into a failing one.
  lua(`local f=game.forces.player local r=f.recipes["nuclear-reactor"]
if r then r.enabled=false end return 1`);
  const locked = call("power_plan", { demand_kw: 360, generator: "nuclear-reactor" });
  check("an unbuildable generator is refused with the research that changes it",
    !locked.ok && locked.code === "NO_BUILDABLE_GENERATOR"
      && JSON.stringify(locked.detail || {}).indexOf("nuclear-power") > 0,
    locked.code || "unexpectedly ok");
  lua(`local f=game.forces.player local r=f.recipes["nuclear-reactor"]
if r then r.enabled=true end return 1`);
}

// ---- drill output, measured off the ground -------------------------------------------
// `mining_speed * 60` was the mining number and `estimated: true` was the honest label on it.
// A rig on a real patch replaces the guess, and it takes two windows' worth of reasoning to
// pin the right number: a window average always loses the tile that was mid-mining when the
// clock ran out (measured here: 60s -> 14 items, while arrivals are spaced exactly 4.000s), so
// the rate has to come from the spacing, not from the division.
{
  call("drill_rate", { seconds: 60, refresh: true });
  let d = null;
  const ddead = Date.now() + 40000;
  while (Date.now() < ddead) {
    wait(1500);
    const r = call("drill_rate", {});
    if (r.ok && r.data && r.data.belt_items !== undefined) { d = r.data; break; }
  }
  check("a drill on a real patch yields a measured rate", !!d && d.belt_items > 0,
    d ? `${d.belt_items} items in ${d.elapsed_game_seconds}s` : "no measurement came back");
  if (d) {
    check("what the belts saw equals what left the ground",
      d.belt_items === d.ground_units_removed, `belt=${d.belt_items} ground=${d.ground_units_removed}`);
    check("the rate comes from the arrival period, not the window average",
      d.seconds_per_item > 0 && Math.abs(d.steady_items_per_min - 60 / d.seconds_per_item) < 1e-9
        && d.steady_items_per_min > d.items_per_min,
      `steady=${d.steady_items_per_min} period=${d.seconds_per_item} window_avg=${d.items_per_min}`);
    check("one item per arrival tick, so the period is not a batched average",
      d.arrival_ticks === d.belt_items, `ticks=${d.arrival_ticks} items=${d.belt_items}`);
    check("the rig is drained as it runs, so a belt capacity is never read as a rate",
      d.drill_status === "working" && /^0(\+0)*$/.test(String(d.belt_lines)),
      `${d.drill_status} lines=${d.belt_lines}`);
    const plan = (call("solve", { want: { item: "iron-ore", rate_per_min: 30 } }).data) || {};
    const mine = asArr(plan.unit && plan.unit.nodes).find((n) => n.kind === "mining") || {};
    check("the solver stops guessing mining once that drill and ore are measured",
      mine.estimated === false
      // the rig's name leads the string and the window it measured over follows it: pinning the
      // whole sentence made this check fail for an improvement, which is the wrong lesson
      && (mine.rate_source || "").startsWith("measured on this map by drill_rate")
      && mine.rate_window_seconds === d.elapsed_game_seconds
      && mine.per_machine_per_min === d.steady_items_per_min,
      `estimated=${mine.estimated} source=${mine.rate_source} per_min=${mine.per_machine_per_min}`);
    check("having measured does not cost the player the research list",
      asArr(plan.prerequisites).length > 0, JSON.stringify(plan.prerequisites));
    // The request that used to break the contract: with no target, `over_by` was computed as
    // out/0, and `inf` is not JSON -- so the whole answer failed to parse on the consumer's side.
    const unitOnly = call("solve", { want: { item: "iron-ore" } });
    check("a plan with no target still parses: the answer never carries inf",
      unitOnly.ok === true && unitOnly.data && unitOnly.data.candidates
      && asArr(unitOnly.data.candidates)[0] && asArr(unitOnly.data.candidates)[0].over_by === undefined,
      unitOnly.ok ? "parsed, no over_by emitted" : `${unitOnly.code} ${unitOnly.msg || ""}`);
    const sloppy = call("solve", { want: { item: "iron-ore", per_min: 30 } });
    check("a request key the solver does not read is refused, not ignored",
      !sloppy.ok && sloppy.code === "UNKNOWN_REQUEST_KEY", `${sloppy.code} ${sloppy.msg || ""}`);
    const residue = +(lua(`local s=game.surfaces["nauvis"]
rcon.print(#s.find_entities_filtered{name="burner-mining-drill"} + #s.find_entities_filtered{name="transport-belt"})`).match(/\d+/) || [""])[0];
    check("the measurement rig takes itself back out of the world", residue === 0, `left standing: ${residue}`);
  }
}

// The pump rig has refused to overlap a drill for a while, with a comment saying why: both raise
// `game.speed` and restore the value each found, so two jobs running at once leave the world
// running fast -- permanently, until something else happens to restore it. That check existed in one
// direction only, so the same failure was reachable through the other door; and neither rig looked
// at a card measurement, which also raises the speed.
{
  // One atomic probe, because the rigs do not wait for the caller: a pump job that cannot be powered
  // fails on a later tick and clears itself, so two separate RCON calls can straddle its whole life.
  // Everything below therefore happens inside a single `remote.call` sequence, in one tick.
  const line = lua(`remote.call("arch","call","lab_reset",{})
local function code(s) local _,_,c = string.find(s or "", '"code":"([A-Z_]+)"') return c or "ok" end
local p1 = remote.call("arch","call","pump_rate",{resource="crude-oil",seconds=900,refresh=true})
local p2 = remote.call("arch","call","pump_rate",{resource="crude-oil",seconds=900})
local d  = remote.call("arch","call","drill_rate",{resource="iron-ore",seconds=1})
local running = string.find(p1, '"state":"running"') ~= nil
local second  = string.find(p2, '"state":"running"') ~= nil
remote.call("arch","call","lab_reset",{})
rcon.print(table.concat({tostring(running), code(p2), tostring(second), code(d)}, "|"))`)
    .split("\n")[0]; // lua.js answers with the print, then an OK line of its own
  const [started, secondCode, secondRunning, drillCode] = String(line).split("|");
  check("a second pump question while a job runs is answered from that job, not a new rig",
    started === "true" && secondRunning === "true" && secondCode === "ok",
    `first=${started} second=${secondRunning} code=${secondCode}`);
  // Both rigs raise `game.speed` and restore what each found, so two overlapping jobs leave the world
  // running fast -- permanently. The pump rig has refused to overlap a drill for a while, in a
  // comment that says exactly this; the check existed in one direction only, and neither rig looked
  // at a card measurement, which also raises the speed.
  check("the drill rig refuses to run beside a pump job", drillCode === "MEASUREMENT_BUSY",
    `drill answered ${drillCode}`);
  const after = +(lua('rcon.print(#game.surfaces["nauvis"].find_entities_filtered{name="pumpjack"})').match(/\d+/) || [""])[0];
  check("resetting takes the pump rig off the map", after === 0, `pumpjacks left standing: ${after}`);
}

// ---- an electric drill: power, the ore's own fluid, and what a box actually contains ----
// Three claims that were carried around as guesses and are now read from the engine. Power is the
// gate for an ordinary ore. A second gate exists on ore whose data names a fluid, and the rig can
// satisfy it because a full tank touching pipes reaches the machine -- the machine's box cannot be
// written from script at all. And the rate a drill owes an ore is `mining_speed / mining_time`,
// which no measurement was previously doing.
//
// The drills have to be researched first: a locked machine never enters a plan, so without the
// grant the arithmetic assertions below would pass while the code under test was broken.
{
  lua(`game.forces.player.technologies["electric-mining-drill"].researched = true`);
  const measure = (args) => {
    call("drill_rate", args);
    for (let i = 0; i < 20; i++) {
      wait(1500);
      const r = call("drill_rate", { machine: args.machine, resource: args.resource });
      if (r.ok && r.data && r.data.belt_items !== undefined) return r.data;
      if (!r.ok) return { failed: r.code + " " + (r.msg || "") };
    }
    return null;
  };

  const starved = measure({ machine: "electric-mining-drill", resource: "copper-ore", seconds: 10, refresh: true });
  check("a drill with no grid says which rule stopped it instead of yielding a zero rate",
    starved && starved.error === "NOT_POWERED" && starved.belt_items === 0 && starved.remedy,
    starved ? `${starved.error} status=${starved.drill_status} items=${starved.belt_items}` : "no answer");
  const cplan = call("solve", { want: { item: "copper-plate", rate_per_min: 60 } });
  const cmine = asArr(cplan.data && cplan.data.unit && cplan.data.unit.nodes).find((n) => n.kind === "mining") || {};
  check("an errored measurement never becomes a rate in the plan",
    cplan.ok === true && cmine.estimated === true && Number.isFinite(cmine.count) && cmine.count > 0,
    cplan.ok ? `${cmine.machine} estimated=${cmine.estimated} count=${cmine.count}` : `${cplan.code} ${cplan.msg || ""}`);

  const powered = measure({ machine: "electric-mining-drill", resource: "iron-ore", seconds: 20, supply: true, refresh: true });
  check("an electric drill needs power and nothing else",
    powered && powered.drill_status === "working" && powered.belt_items > 0 && !powered.error
    && asArr(powered.power_attempts)[0] && asArr(powered.power_attempts)[0].placed === true,
    powered ? `${powered.drill_status} items=${powered.belt_items} steady=${powered.steady_items_per_min} gens=${asArr(powered.power_attempts).length}` : "no answer");
  const eplan = (call("solve", { want: { item: "iron-plate", rate_per_min: 60 } }).data) || {};
  const emine = asArr(eplan.unit && eplan.unit.nodes).find((n) => n.kind === "mining") || {};
  check("a drill that did run is the rate the plan uses",
    emine.machine === "electric-mining-drill" && emine.estimated === false
    && emine.per_machine_per_min === powered.steady_items_per_min,
    `${emine.machine} estimated=${emine.estimated} per_min=${emine.per_machine_per_min}`);

  // A drill mines what is inside its own selection box, so a spot whose box reaches a second ore
  // measures that ore's rules instead. The fixtures are spaced for this and the rig prefers a
  // pure box; the box contents are reported so a mixed answer cannot be read as a clean one.
  const calcite = measure({ machine: "electric-mining-drill", resource: "calcite", seconds: 12, supply: true, refresh: true });
  check("a measured patch holds only the ore that was asked for",
    calcite && !calcite.error && calcite.belt_items > 0
    && Object.keys(calcite.minable_in_box || {}).join(",") === "calcite",
    calcite ? `box=${JSON.stringify(calcite.minable_in_box)} ${calcite.error || calcite.drill_status} items=${calcite.belt_items}` : "no answer");

  lua(`game.forces.player.technologies["big-mining-drill"].researched = true`);
  const acid = measure({ machine: "electric-mining-drill", resource: "uranium-ore", seconds: 30, supply: true, refresh: true });
  check("an ore that demands a fluid is mined once the rig feeds it the one its data names",
    acid && acid.required_fluid === "sulfuric-acid" && !acid.error && acid.belt_items > 0
    && acid.drill_status === "working" && acid.fluid_in_machine > 0,
    acid ? `${acid.error || acid.drill_status} fluid=${acid.required_fluid}/${acid.fluid_amount} in_machine=${acid.fluid_in_machine} items=${acid.belt_items}` : "no answer");
  check("measured rate equals the nameplate a drill owes this ore",
    acid && Math.abs(acid.steady_items_per_min - (60 * acid.mining_speed / acid.ore_mining_time)) < 1e-9,
    acid ? `steady=${acid.steady_items_per_min} speed=${acid.mining_speed} ore_time=${acid.ore_mining_time}` : "no answer");

  // The same arithmetic where nothing was ever measured: `mining_time` is per unit of ore, so a
  // nameplate built from speed alone over-promises by exactly that divisor.
  const slow = call("solve", { want: { item: "tungsten-ore", rate_per_min: 60 } });
  const smine = asArr(slow.data && slow.data.unit && slow.data.unit.nodes).find((n) => n.kind === "mining") || {};
  const speeds = (call("capabilities").data || {}).machines || {};
  const sSpeed = speeds[smine.machine] && speeds[smine.machine].mining_speed;
  check("an unmeasured slow ore is not planned at the speed-only rate",
    smine.estimated === true && smine.ore_mining_time > 1 && sSpeed
    && Math.abs(smine.per_machine_per_min - (60 * sSpeed / smine.ore_mining_time)) < 1e-9,
    `${smine.machine} per_min=${smine.per_machine_per_min} speed=${sSpeed} ore_time=${smine.ore_mining_time}`);

  const litter = +(lua(`local s=game.surfaces["nauvis"]
rcon.print(#s.find_entities_filtered{name="electric-mining-drill"} + #s.find_entities_filtered{name="electric-energy-interface"}
  + #s.find_entities_filtered{name="transport-belt"} + #s.find_entities_filtered{name="storage-tank"} + #s.find_entities_filtered{name="pipe"})`).match(/\d+/) || [""])[0];
  check("neither rig leaves anything standing", litter === 0, `left on nauvis: ${litter}`);
}

// ---- fluid measurement: the field names its own fluid ----
// Nothing in the runtime data says what a vent produces -- a resource entity has no readable
// fluid, and the machine's box cannot be enumerated. The measurement does: fluid arrives in the
// tank under its own name. That single fact is what makes a fluid line plannable at all, because
// a refinery's ingredient is chosen by name.
//
// The rig needs `supply`: after a restart this map has no generator anywhere, so a pumpjack
// measured without asking for power reads `no_power` and yields a clean zero.
{
  const pumpMeasure = (args) => {
    call("pump_rate", args);
    for (let i = 0; i < 25; i++) {
      wait(2000);
      const r = call("pump_rate", { resource: args.resource });
      if (r.ok && r.data && r.data.units !== undefined) return r.data;
      if (!r.ok) return { failed: r.code + " " + (r.msg || "") };
    }
    return null;
  };

  const oil = pumpMeasure({ resource: "crude-oil", seconds: 30, supply: true, refresh: true });
  check("a pumpjack on oil yields a measured fluid rate",
    oil && !oil.error && oil.fluid === "crude-oil" && oil.units > 0 && oil.pump_status === "working"
    && Math.abs(oil.units_per_min - oil.units * (60 / oil.elapsed_game_seconds)) < 1e-6,
    oil ? `${oil.error || oil.pump_status} ${oil.fluid} ${oil.units_per_min && oil.units_per_min.toFixed(2)}/min of ${oil.field_tiles} tiles` : "no answer");

  // The pumpjack has to be researchable before a plan can size an oil line at all. This suite runs
  // before dev/solve_e2e.js on the same server, and that one asserts the plastic line is blocked on
  // crude oil -- so the grant is taken back at the end of this block instead of being left on.
  lua(`local t=game.forces.player.technologies["oil-gathering"]; if t then t.researched=true end
local r=game.forces.player.recipes["pumpjack"]; if r then r.enabled=true end`);

  // A measured pump now has to be what the plan sizes against, in FLUID UNITS per minute -- the
  // unit matters more than the number here, because crude oil gives ten units of fluid per unit
  // mined and a nameplate that assumes one under-plans an oil line by that factor.
  const crude_plan = call("solve", { want: { fluid: "crude-oil", rate_per_min: 600 } });
  const crude_node = asArr(crude_plan.data && crude_plan.data.unit && crude_plan.data.unit.nodes)
    .find((n) => n.kind === "mining");
  check("a crude-oil line is sized in fluid units, by the pump the ground was measured on",
    crude_node && crude_node.machine === "pumpjack" && crude_node.estimated === false
    && crude_node.product_type === "fluid" && crude_node.units_per_ore_unit === 10
    && Math.abs(crude_node.per_machine_per_min - oil.units_per_min) < 1e-6
    && /pump_rate/.test(crude_node.rate_source || "")
    // the window is part of the figure: the same pump reads 808/min over 30s and 643/min over
    // 120s, so a plan that quotes a rate without saying how long it was watched is quoting the
    // shortest-sounding answer available
    && crude_node.rate_window_seconds === oil.elapsed_game_seconds
    && (crude_node.rate_source || "").includes(String(oil.elapsed_game_seconds)),
    crude_node ? JSON.stringify({ m: crude_node.machine, est: crude_node.estimated,
      per: crude_node.per_machine_per_min, units: crude_node.units_per_ore_unit }) : "no mining node");
  check("the plan says what ground there is, and does not invent a horizon for an infinite field",
    crude_node && crude_node.field && crude_node.field.tiles === oil.field_tiles
    && crude_node.field.infinite === true && crude_node.field.minutes_at_extraction_rate === undefined,
    JSON.stringify(crude_node && crude_node.field));

  // A finite patch is the case the horizon exists for. The figures are handed in rather than read
  // off this map, because what the map happens to hold is not what the arithmetic is about.
  const finite = call("solve", { want: { fluid: "crude-oil", rate_per_min: 1200 },
    field_supply: { "crude-oil": { tiles: 4, units: 120000, infinite: false } } });
  const finite_node = asArr(finite.data && finite.data.unit && finite.data.unit.nodes).find((n) => n.kind === "mining");
  check("a finite patch reports how long it pays at the rate the machines actually take out",
    finite_node && finite_node.field && finite_node.field.extractors >= 1
    && finite_node.field.unit_extraction_per_min === finite_node.field.extractors * finite_node.per_machine_per_min
    && finite_node.units_per_ore_unit === 10
    && Math.abs(finite_node.field.minutes_at_extraction_rate
      - finite_node.field.units / finite_node.field.unit_extraction_ore_per_min) < 1e-6
    // the two rates differ by the ore's yield, so pinning the wrong one is a detectable mistake
    // rather than a matter of taste: crude gives ten units of fluid per unit of ore
    && finite_node.field.unit_extraction_ore_per_min * 10 === finite_node.field.unit_extraction_per_min
    && Math.abs(finite_node.field.minutes_at_extraction_rate
      - finite_node.field.units / finite_node.field.unit_extraction_per_min) > 1,
    JSON.stringify(finite_node && finite_node.field));
  check("the scan of the map is skipped when the caller says so",
    (() => {
      const r = call("solve", { want: { fluid: "crude-oil", rate_per_min: 600 }, field_supply: false });
      const n = asArr(r.data && r.data.unit && r.data.unit.nodes).find((x) => x.kind === "mining");
      return !!n && n.field === undefined;
    })(),
    "field_supply=false still attached a field, or the node vanished");
  lua(`local t=game.forces.player.technologies["oil-gathering"]; if t then t.researched=false end
local r=game.forces.player.recipes["pumpjack"]; if r then r.enabled=false end`);

  // The rate has to be the same number however long it is watched. It was not: the same pump read
  // 808/min over 30s and 643/min over 120s, because a hundred-odd units were always in flight in
  // the pipes and the pump's box when the window opened, and a short window books them as
  // production. Watching two windows and comparing them is the only way that failure shows itself.
  const again = pumpMeasure({ resource: "crude-oil", seconds: 120, supply: true, refresh: true });
  check("a crude rate is the same figure over a short window and a long one",
    oil && again && again.units_per_min
    && Math.abs(again.units_per_min - oil.units_per_min) / oil.units_per_min < 0.05
    && again.in_flight > 0 && again.discarded_before_window >= again.in_flight,
    oil && again ? `${oil.units_per_min.toFixed(1)}/min over ${oil.elapsed_game_seconds}s vs `
      + `${again.units_per_min && again.units_per_min.toFixed(1)}/min over ${again.elapsed_game_seconds}s `
      + `in_flight=${again.in_flight} discarded=${again.discarded_before_window}` : "no answer");
  check("and the ground agrees with the nameplate within a couple of percent",
    again && Math.abs(again.units_per_min - 600) / 600 < 0.05,
    again && `measured ${again.units_per_min.toFixed(1)}/min against 60*speed*10 units/min`);

  const vent = pumpMeasure({ resource: "sulfuric-acid-geyser", seconds: 30, supply: true, refresh: true });
  check("a gyser names the fluid it gives up, which no prototype field does",
    vent && !vent.error && vent.fluid === "sulfuric-acid" && vent.units > 0,
    vent ? `${vent.error || vent.pump_status} fluid=${vent.fluid} units=${vent.units && vent.units.toFixed(1)}` : "no answer");

  // The verdict arrives on the call after the job dies: the rig reports what it started with, and
  // the runner decides a few ticks later that the machine cannot spin.
  call("pump_rate", { resource: "fluorine-vent", seconds: 10, refresh: true });
  let dry = { ok: true, code: "STILL_RUNNING" };
  for (let i = 0; i < 10; i++) {
    wait(2000);
    dry = call("pump_rate", { resource: "fluorine-vent" });
    if (!dry.ok || (dry.data && dry.data.units !== undefined)) break;
  }
  check("a pump with no grid to run on says so instead of storing a zero",
    (!dry.ok && dry.code === "NOT_POWERED") || (dry.data && dry.data.error === "NOT_POWERED"),
    dry.ok ? `answered ok status=${dry.data && dry.data.pump_status} code=${dry.data && dry.data.error}` : `${dry.code} ${dry.msg}`);

  const pumpLitter = +(lua(`local s=game.surfaces["nauvis"]
rcon.print(#s.find_entities_filtered{name="pumpjack"} + #s.find_entities_filtered{name="pipe"}
  + #s.find_entities_filtered{name="storage-tank"} + #s.find_entities_filtered{name="electric-energy-interface"
  ,area={{-80,-80},{80,80}}})`).match(/\d+/) || [""])[0];
  check("the pump rig takes its ring, tank and source back out", pumpLitter === 0, `left on nauvis: ${pumpLitter}`);
}

// ---- a card whose product is a fluid: a claim, a verdict, and the face it came from ----
// contract.outputs is a map of items, so until `contract.fluid_outputs` existed a refinery could
// not state what it makes at all and the lab refused it. This pins the three things the fluid path
// has to get right: the claim is judged as a fluid, an unresearched recipe is refused before any
// window is spent, and a machine that will not run is explained by its own status rather than
// reported as a card that produces nothing.
{
  lua(`local f=game.forces.player
for _,n in ipairs({"oil-processing","fluid-handling"}) do local t=f.technologies[n]; if t then t.researched=true end end
for _,n in ipairs({"oil-refinery","pipe","storage-tank","basic-oil-processing"}) do
  local r=f.recipes[n]; if r then r.enabled=true end
end`);
  const refinery = {
    name: "refine-card",
    // three entities, not two: the lab stands a tank on every machine face it can, and a site is
    // chosen for the card's footprint only, so a compact card can land where no face has room
    entities: [
      { name: "pipe", position: { x: 0.5, y: 2.5 } },
      { name: "oil-refinery", position: { x: 3.5, y: 2.5 }, direction: 0 },
      { name: "pipe", position: { x: 6.5, y: 2.5 } },
    ],
    // Every fluid port names the machine, because the box is the machine's: a port left on one of
    // the pipes has no box to find, and the rig says so rather than probing plumbing. And the ports
    // are the recipe's own ingredients -- basic oil processing takes crude and yields only
    // petroleum gas, so a card that also declared water would be refused for asking.
    ports: { in: [{ fluid: "crude-oil", entity: 2 }],
             out: [{ fluid: "petroleum-gas", entity: 2 }] },
    contract: { outputs: {}, fluid_outputs: { "petroleum-gas": 500 } },
    machine_recipes: { 2: "basic-oil-processing" },
  };

  // Advanced oil processing is deliberately NOT researched here: the rig has to notice. It is set
  // back to unresearched rather than assumed, because a probe run by hand in this same session can
  // have granted it -- and a card_lab call that gets past the check leaves a job running that the
  // next call would meet as LAB_BUSY.
  lua(`local t=game.forces.player.technologies["advanced-oil-processing"]
if t then t.researched=false end
local r=game.forces.player.recipes["advanced-oil-processing"]
if r then r.enabled=false end`);
  const untested = call("card_lab", {
    card: JSON.parse(JSON.stringify(refinery).replace("basic-oil-processing", "advanced-oil-processing")),
    seconds: 10, speed: 20,
  });
  check("a recipe the force has not researched is refused instead of measured as a zero",
    !untested.ok && untested.code === "RECIPE_NOT_RESEARCHED" && untested.detail.technology,
    `${untested.code} tech=${untested.detail && untested.detail.technology}`);
  call("lab_reset", {});

  call("card_lab", { card: refinery, seconds: 20, speed: 20 });
  let fin = null;
  for (let i = 0; i < 18; i++) {
    wait(2000);
    const st = call("lab_status", {});
    if (!st.ok) { fin = { failed: st.code + " " + (st.msg || "") }; break; }
    if (st.data.state !== "running") { fin = st.data; break; }
  }
  const verdict = fin && asArr(fin.verdicts)[0];
  check("a fluid claim is judged as a fluid claim",
    verdict && verdict.kind === "fluid" && verdict.fluid === "petroleum-gas"
    && verdict.claimed_per_min === 500 && typeof verdict.measured_per_min === "number"
    && verdict.expected_in_window > 0,
    (fin && fin.failed) || JSON.stringify(verdict));
  check("the machine says why, and the rig says which face took which fluid",
    fin && asArr(fin.machine_status).length > 0 && fin.machine_status[0].status
    && (asArr(fin.supply_faces).length === 0
        || asArr(fin.supply_faces).every((s) => s.fluid && s.side && s.units > 0)),
    (fin && fin.failed) || `status=${JSON.stringify(asArr(fin.machine_status))} faces=${JSON.stringify(asArr(fin.supply_faces))}`);
  call("lab_reset", {});
}

// ---- two ingredients, one face ----
// An oil refinery takes crude at one cell of its south face and water at another. Nothing readable
// says which cells: `fluid_boxes` is not exposed, `fluidbox_prototypes` gives only in/out, and a
// placed machine reports an empty box list. So the lab offers fluid at one cell at a time until a
// cell takes it, then splits the face between two runs that may not touch -- pipes that touch join,
// and two tanks that touch join, which is how a split that looks geometrically fine can pour both
// ingredients into one network. A card measured without that would report a refinery that "makes
// nothing" while it starves with both boxes in reach of a pipe.
{
  lua(`local f=game.forces.player
local t=f.technologies["advanced-oil-processing"]; if t then t.researched=true end
local r=f.recipes["advanced-oil-processing"]; if r then r.enabled=true end`);
  const pair = {
    name: "refine-pair-card",
    entities: [
      { name: "oil-refinery", position: { x: 3.5, y: 3.5 }, direction: 0 },
    ],
    ports: { in: [{ fluid: "crude-oil", entity: 1 }, { fluid: "water", entity: 1 }],
             out: [{ fluid: "petroleum-gas", entity: 1 }] },
    // below the recipe's theoretical 660/min on purpose: a window always loses its first craft to
    // the warmup, and `met` asks for the claim in full rather than for a ratio
    contract: { outputs: {}, fluid_outputs: { "petroleum-gas": 550 } },
    machine_recipes: { 1: "advanced-oil-processing" },
  };
  const pairStart = call("card_lab", { card: pair, seconds: 60, speed: 20 });
  let fin = null;
  for (let i = 0; i < 30; i++) {
    wait(2000);
    const st = call("lab_status", {});
    if (!st.ok) { fin = { failed: st.code + " " + (st.msg || "") }; break; }
    if (st.data.state !== "running" && st.data.state !== "probing") { fin = st.data; break; }
  }
  const probed = asArr(fin && fin.probed);
  check("each ingredient was found at a face and a cell",
    probed.length === 2 && probed.every((p) => p.face && typeof p.off === "number" && p.fluid)
    && asArr(fin.supply_problems).length === 0,
    (fin && fin.failed) || `probed=${JSON.stringify(probed)} problems=${JSON.stringify(asArr(fin.supply_problems))}`);

  const runs = asArr(fin && fin.supply_faces);
  const cells = runs.map((r) => r.cells || []);
  const apart = cells.length === 2 && cells[0].every((a) => cells[1].every((b) => Math.abs(a - b) >= 2));
  check("one face carries both fluids without their networks touching",
    runs.length === 2 && runs[0].side === runs[1].side && apart,
    JSON.stringify(runs.map((r) => ({ fluid: r.fluid, side: r.side, cells: r.cells, anchor: r.anchor }))));
  check("both supply runs gave up fluid, which is the only proof the row is on the box",
    runs.length === 2 && runs.every((r) => r.units > 0),
    JSON.stringify(runs.map((r) => ({ fluid: r.fluid, units: r.units }))));

  const y = (fin && fin.fluid_yields) || {};
  const perCraft = { "petroleum-gas": 55, "light-oil": 45, "heavy-oil": 25 };
  check("the products come out in the recipe's own proportions, read from the machine's boxes",
    Object.keys(perCraft).every((k) => y[k] > 0)
    && Object.keys(perCraft).every((k) => Math.abs(y[k] / y["petroleum-gas"] - perCraft[k] / 55) < 0.02),
    JSON.stringify(y));
  check("the claim is judged against what the window actually delivered",
    asArr(fin && fin.verdicts)[0] && asArr(fin.verdicts)[0].met === true
    && asArr(fin.verdicts)[0].measured_per_min > 500 && fin.delivered === true,
    JSON.stringify(asArr(fin && fin.verdicts)));

  // The box table carries these cells because a probe read them once. A hit has to save the
  // discovery, and the fact it saves has to be the fact the discovery would have found -- so the
  // same card is run again with the table refused and the two answers are compared.
  check("the runs were laid from the box table, with no discovery spent on them",
    pairStart.ok && pairStart.data.box_table_served === 2
    && runs.length === 2 && runs.every((r) => r.source === "table"),
    `served=${pairStart.ok ? pairStart.data.box_table_served : pairStart.code} `
    + JSON.stringify(runs.map((r) => r.source)));

  const probeStart = call("card_lab", { card: pair, seconds: 60, speed: 20, ignore_box_table: true });
  let again = null;
  for (let i = 0; i < 30; i++) {
    wait(2000);
    const st = call("lab_status", {});
    if (!st.ok) { again = { failed: st.code }; break; }
    if (st.data.state !== "running" && st.data.state !== "probing" && st.data.state !== "proving") {
      again = st.data; break;
    }
  }
  const byFluid = (list) => (list || []).slice().sort((a, b) => (a.fluid < b.fluid ? -1 : 1))
    .map((r) => r.fluid + ":" + (r.cells || []).join("/") + "@" + r.side);
  check("with the table refused, discovery reads the very same cells the table carries",
    probeStart.ok && probeStart.data.box_table_served === undefined
    && again && byFluid(asArr(again.supply_faces)).join(" ") === byFluid(runs).join(" ")
    && asArr(again.supply_faces).every((r) => r.source === "probed"),
    `served=${probeStart.ok ? String(probeStart.data.box_table_served) : probeStart.code} `
    + `${byFluid(runs).join(" ")} vs ${byFluid(asArr(again && again.supply_faces)).join(" ")}`);

  // Entries are keyed by the direction the machine was standing in when the fact was read, because
  // rotating a machine moves its boxes with it. A refinery facing east is the same machine with a
  // different answer, so the table must stay quiet about it rather than guess.
  const turned = JSON.parse(JSON.stringify(pair));
  turned.entities[0].position = { x: 3.5, y: 3.5 };
  turned.entities[0].direction = 4;
  const turnedStart = call("card_lab", { card: turned, seconds: 20, speed: 20 });
  check("a machine turned to a direction the table has not been read at is discovered, not trusted",
    turnedStart.ok && turnedStart.data.box_table_served === undefined,
    turnedStart.ok ? `served=${String(turnedStart.data.box_table_served)}` : turnedStart.code);
  call("lab_reset", {});

  // A card that brings its own inlet pipe: the pipe standing on the machine's box cell is the
  // card's, not the rig's, so discovery has to offer through it and leave it where it was. Refusing
  // that cell outright would report a card whose box cannot be found at all.
  const own_pipe = {
    name: "refine-own-inlet",
    entities: [
      { name: "oil-refinery", position: { x: 3.5, y: 2.5 }, direction: 0 },
      // crude enters at south cell +1, which for this machine is the tile (4.5, 5.5)
      { name: "pipe", position: { x: 4.5, y: 5.5 } },
    ],
    ports: { in: [{ fluid: "crude-oil", entity: 1 }, { fluid: "water", entity: 1 }],
             out: [{ fluid: "petroleum-gas", entity: 1 }] },
    contract: { outputs: {}, fluid_outputs: { "petroleum-gas": 550 } },
    machine_recipes: { 1: "advanced-oil-processing" },
  };
  call("card_lab", { card: own_pipe, seconds: 45, speed: 20, ignore_box_table: true });
  let inlet = null;
  for (let i = 0; i < 30; i++) {
    wait(2000);
    const st = call("lab_status", {});
    if (!st.ok) { inlet = { failed: st.code }; break; }
    if (st.data.state !== "running" && st.data.state !== "probing" && st.data.state !== "proving") {
      inlet = st.data; break;
    }
  }
  check("a box the card already piped into is still found, and the card's pipe survives",
    inlet && inlet.state === "done"
    && asArr(inlet.probed).some((x) => x.fluid === "crude-oil" && x.face === "south" && x.off === 1)
    && asArr(inlet.supply_faces).every((r) => r.units > 0) && inlet.delivered === true,
    (inlet && inlet.failed) || JSON.stringify({ state: inlet && inlet.state,
      probed: asArr(inlet && inlet.probed).map((x) => x.fluid + "@" + x.face + x.off),
      delivered: inlet && inlet.delivered }));
  call("lab_reset", {});
}

// ---- the refusals on the way to a fluid measurement ----
// Each of these ends the job before a window is timed. The rule they exist for: a rate measured
// with an ingredient missing belongs to the rig, not to the card, so the answer has to be "I could
// not feed it" rather than a low number.
{
  const single = {
    name: "refuse-card",
    entities: [
      { name: "oil-refinery", position: { x: 3.5, y: 3.5 }, direction: 0 },
      { name: "pipe", position: { x: 3.5, y: 6.5 } },
    ],
    ports: { in: [{ fluid: "crude-oil", entity: 1 }], out: [{ fluid: "petroleum-gas", entity: 1 }] },
    contract: { outputs: {}, fluid_outputs: { "petroleum-gas": 500 } },
    machine_recipes: { 1: "basic-oil-processing" },
  };

  const on_a_pipe = JSON.parse(JSON.stringify(single));
  on_a_pipe.ports.in = [{ fluid: "crude-oil", entity: 2 }];
  const misplaced = call("card_lab", { card: on_a_pipe, seconds: 5 });
  check("a fluid port naming a pipe is refused, and says the port belongs to the machine",
    !misplaced.ok && misplaced.code === "CARD_NO_FEEDS"
    && asArr(misplaced.detail && misplaced.detail.unwired_inputs)
      .some((u) => u.why === "FLUID_PORT_NOT_ON_A_MACHINE"),
    misplaced.ok ? "started anyway" : `${misplaced.code} ${JSON.stringify(asArr(misplaced.detail && misplaced.detail.unwired_inputs).map((u) => u.why))}`);

  const overfed = JSON.parse(JSON.stringify(single));
  // Water is nothing to basic oil processing: the card claims an ingredient its recipe never asks
  // for. Refused at once, before any fixture is placed or any tick is spent -- and refused even
  // though the box table knows exactly where a refinery's water intake is, because that fact is
  // irrelevant to a machine that will never draw it.
  overfed.ports.in = [{ fluid: "crude-oil", entity: 1 }, { fluid: "water", entity: 1 }];
  const unwanted = call("card_lab", { card: overfed, seconds: 5 });
  check("an ingredient the bound recipe never takes is refused without spending a window",
    !unwanted.ok && unwanted.code === "FLUID_NOT_AN_INGREDIENT"
    && unwanted.detail && unwanted.detail.recipe === "basic-oil-processing"
    && asArr(unwanted.detail.not_ingredients).some((x) => x.fluid === "water"),
    unwanted.ok ? "started anyway" : `${unwanted.code} ${JSON.stringify(unwanted.detail && unwanted.detail.not_ingredients)}`);

  // A discovery pass is a few seconds of game time, which at speed 20 is less than one RCON round
  // trip -- so the state has to be held still to be observed at all, and the pause has to be in
  // place before the job opens. That the bench stops with the game is worth pinning in itself.
  lua(`game.tick_paused = true rcon.print(tostring(game.tick_paused))`);
  const discovering = call("card_lab", { card: single, seconds: 5, ignore_box_table: true });
  const busy = call("card_lab", { card: single, seconds: 5 });
  check("a job that is still discovering is a live job, not an idle bench",
    discovering.ok && discovering.data.state === "probing"
    && !busy.ok && busy.code === "LAB_BUSY" && /probing/.test(busy.msg || ""),
    `${discovering.ok ? discovering.data.state : discovering.code} busy=${busy.ok ? "started" : busy.code + " " + busy.msg}`);
  lua(`game.tick_paused = false rcon.print(tostring(game.tick_paused))`);
  call("lab_reset", {});
}

// Leave no trace. Tests that place things on the player's own surface must clean up after
// themselves; a suite that litters the save makes the next manual check lie.
{
  const left = lua(`local n=0 for _,s in pairs(game.surfaces) do n = n + #s.find_entities_filtered{type="entity-ghost"} end
local stray=0 for _,s in pairs(game.surfaces) do if s.name ~= "arch-sandbox" then stray = stray + #s.find_entities_filtered{type="entity-ghost"} end end
rcon.print(stray)`);
  check('no ghosts stranded outside the sandbox', (left.match(/^\s*0\s*$/m) || []).length > 0, `stray ghosts: ${left}`);
}

const width = Math.max(...results.map((x) => x.name.length));
let failed = 0;
for (const x of results) {
  if (!x.pass) failed++;
  console.log(`${x.pass ? "  ok " : "  FAIL"} ${x.name.padEnd(width)}  ${x.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
