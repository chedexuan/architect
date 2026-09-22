// A5: an oil line is sized in units of fluid, and the ground is asked whether it can hold it.
//
// `solve` answers "how many machines for X per minute". Two numbers that answer it have been wrong
// in the past for want of what this file pins down: a nameplate that ignored what one broken unit of
// crude oil yields (ten units of fluid, not one item), and an extractor count nobody checked against
// the map. The first is a factor-of-ten error in every downstream tank and pipe; the second plans a
// line with ten pumps on a pool that fits four.
//
// So: read the field, pack the machines into it, and refuse to state a confident answer when the
// scan ran out of budget. The crude patch on this save is 6x6 tiles, which is small enough that a
// demand for "one more pump than fits" is certain rather than a guess.
//
// Run after `bash dev/cycle.sh` (it seeds the oilfield); it grants nothing, because none of these
// numbers come from the tech tree.
const { execFileSync } = require("child_process");
const path = require("path");

const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "ignore"] }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8", maxBuffer: 1 << 29 });
// the wrapper prints a warm-up reply and an `OK` tail around whatever the console printed, so a
// value has to be picked out of the noise instead of parsed off the last line
const luaJson = (src) => {
  const line = lua(src).split(/\r?\n/).find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error("no json in the lua reply");
  return JSON.parse(line.trim());
};

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
};

// the engine's own numbers, read rather than remembered: a nameplate this probe recomputes from
// prototypes is a property being checked, and one copied from a comment is a rumour
const consts = luaJson(`local ok,err=pcall(function()
local ore=prototypes.entity["crude-oil"].mineable_properties
local p=prototypes.entity["pumpjack"]
local pr=(ore.products or {})[1]
rcon.print(helpers.table_to_json({mining_speed=p.mining_speed, mining_time=ore.mining_time,
  tank=prototypes.entity["storage-tank"].fluid_capacity,
  units=(pr.amount or 1)*(pr.probability or 1), type=pr.type}))
end)
if not ok then rcon.print(helpers.table_to_json({error=tostring(err)})) end`);
if (consts.error) throw new Error("prototype read failed: " + consts.error);

// what one pumpjack hands over per minute: the ore's own breaking time, and ten units of fluid for
// every unit it breaks
const NAMEPLATE = 60 * consts.mining_speed / consts.mining_time * consts.units;
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.abs(b || 1);

(async () => {
  console.log(`pumpjack ${consts.mining_speed}/s on crude (mining_time ${consts.mining_time}, `
    + `${consts.type} x ${consts.units}/unit) -> ${NAMEPLATE}/min, tank ${consts.tank}`);

  // The picker has to read what is unlocked *now*, not what was unlocked when the prototype table was
  // first walked: on a fresh server the pumpjack is still a research away, and a cache built there
  // answers "no machine can take a basic-fluid patch" forever. cycle.sh's grants vary, so this test
  // states its own precondition and puts it back.
  lua(`local f=game.forces.player
storage["__was_pumpjack"]=f.recipes["pumpjack"].enabled
f.recipes["pumpjack"].enabled=true
rcon.print("pumpjack recipe on")`);

  // ---- the ground, counted ----
  const survey = call("field_survey", { resource: "crude-oil", machine: "pumpjack", surface: "nauvis" });
  const patches = asArr((survey.data || {}).fields);
  check("the crude patch reads as tiles, units and places to stand a pumpjack",
    survey.ok && survey.data.tiles > 0 && survey.data.units > 0 && survey.data.slots > 0
    && patches.length >= 1 && survey.data.slots_complete === true,
    survey.ok ? JSON.stringify({ tiles: survey.data.tiles, units: survey.data.units,
      slots: survey.data.slots, fields: patches.length, infinite: survey.data.infinite })
      : `${survey.code} ${survey.msg}`);
  check("every patch says where it is, and the count says how it was arrived at",
    survey.ok && patches.every((f) => f.at && typeof f.at.x === "number" && f.tiles > 0
      && typeof f.slots === "number" && typeof f.stopped === "string" && f.units > 0)
    && /lower bound/.test(survey.data.slots_method || ""),
    JSON.stringify(patches.map((f) => `${f.at.x},${f.at.y}:${f.tiles}t/${f.slots}slots`)));

  const again = call("field_survey", { resource: "crude-oil", machine: "pumpjack", surface: "nauvis" });
  check("the same question twice gives the same field, in the same order",
    again.ok && again.data.slots === survey.data.slots && again.data.tiles === survey.data.tiles
    && JSON.stringify(asArr(again.data.fields)) === JSON.stringify(patches),
    JSON.stringify({ a: patches.map((f) => `${f.at.x},${f.at.y}`),
      b: asArr((again.data || {}).fields).map((f) => `${f.at.x},${f.at.y}`) }));

  // the budget is not a performance knob, it is the difference between an answer and a lie: a scan
  // that stopped early has to say it stopped, and must not answer "does it fit" on the way out
  const thin = call("field_survey", { resource: "crude-oil", machine: "pumpjack", surface: "nauvis",
    need: 99, budget: 2 });
  check("a scan given two tiles of budget stops, and reports that it stopped",
    thin.ok && thin.data.slots_complete === false && thin.data.slots <= 2
    && asArr(thin.data.fields).some((f) => f.stopped === "budget" && f.tiles_left_untested > 0),
    thin.ok ? JSON.stringify({ slots: thin.data.slots, complete: thin.data.slots_complete,
      budget_used: thin.data.budget_used }) : thin.code);
  check("an unfinished scan leaves 'does it fit' unanswered instead of answering no",
    thin.ok && thin.data.need_fits == null,
    JSON.stringify({ need_fits: thin.data.need_fits }));

  // ---- the line, sized ----
  const chain = call("fluid_chain", { fluid: "crude-oil", per_min: NAMEPLATE, surface: "nauvis" });
  check("a request of exactly one machine's rate asks for one machine, on ground that holds it",
    chain.ok && chain.data.extractors === 1 && chain.data.slots_enough === true
    && chain.data.machine === "pumpjack" && chain.data.shortfall == null,
    chain.ok ? JSON.stringify({ n: chain.data.extractors, per_each: chain.data.per_each,
      enough: chain.data.slots_enough, source: chain.data.rate_source })
      : `${chain.code} ${chain.msg}`);
  check("one pumpjack's rate is stated in units of fluid, so it carries the ore's yield",
    chain.ok && consts.type === "fluid" && consts.units === 10
    && chain.data.units_per_ore_unit === consts.units
    && near(chain.data.per_each, NAMEPLATE, chain.data.rate_measured ? 0.2 : 0.001),
    chain.ok ? JSON.stringify({ per_each: chain.data.per_each, nameplate: NAMEPLATE,
      units_per_ore_unit: chain.data.units_per_ore_unit, measured: chain.data.rate_measured,
      ore_mining_time: chain.data.ore_mining_time }) : chain.code);

  // the field holds ore units and the line spends fluid units; the two differ by exactly the yield,
  // so a duration computed from the wrong one is off by ten and still looks like a number.
  // No vanilla map exercises this -- every fluid there comes from an infinite vent -- so the ground
  // is handed in rather than scanned, which is the same override the plan's own field figures use.
  const finite = call("fluid_chain", { fluid: "crude-oil", per_min: NAMEPLATE, surface: "nauvis",
    ground: { units: 3600, infinite: false } });
  const lasts = 3600 / (NAMEPLATE / consts.units); // ore units / ore units per minute = minutes
  check("how long the ground lasts is divided by ore units, not by the fluid the line delivers",
    finite.ok && finite.data.ground.ore_units === 3600
    && near(finite.data.ground.minutes_at_this_rate, lasts, 0.001),
    finite.ok ? JSON.stringify({ minutes: finite.data.ground.minutes_at_this_rate, expect: lasts,
      wrong_by_the_yield_factor: 3600 / NAMEPLATE / 60 }) : `${finite.code} ${finite.msg}`);
  check("an infinite patch is said not to run out, instead of given a lifetime",
    chain.ok && chain.data.ground.infinite === true && chain.data.ground.minutes_at_this_rate == null
    && /does not run out/.test(chain.data.ground.lifetime || ""),
    JSON.stringify({ infinite: (chain.data || {}).ground && chain.data.ground.infinite,
      minutes: (chain.data || {}).ground && chain.data.ground.minutes_at_this_rate,
      lifetime: (chain.data || {}).ground && chain.data.ground.lifetime }));

  // ---- a plan the map cannot build says so, with the number missing ----
  const slots = survey.data.slots;
  const greedy = call("fluid_chain", { fluid: "crude-oil", per_min: (slots + 1) * chain.data.per_each,
    surface: "nauvis" });
  check("demand for one more pump than the ground holds is refused as unbuildable, by name",
    greedy.ok && greedy.data.ground.slots_complete === true
    && greedy.data.slots_enough === false && greedy.data.shortfall >= 1
    && greedy.data.extractors === slots + 1,
    greedy.ok ? JSON.stringify({ want: greedy.data.extractors, slots: greedy.data.ground.slots,
      enough: greedy.data.slots_enough, shortfall: greedy.data.shortfall }) : greedy.code);
  const cramped = call("fluid_chain", { fluid: "crude-oil", per_min: (slots + 1) * chain.data.per_each,
    surface: "nauvis", budget: 2 });
  check("the same demand with a budget of two is 'not known yet', not 'it does not fit'",
    cramped.ok && cramped.data.slots_enough == null && cramped.data.shortfall == null
    && cramped.data.ground.slots_complete === false,
    JSON.stringify({ enough: (cramped.data || {}).slots_enough,
      shortfall: (cramped.data || {}).shortfall, complete: (cramped.data || {}).ground && cramped.data.ground.slots_complete }));

  // ---- storage, asked in seconds and answered in whole tanks ----
  const buf = (call("fluid_chain", { fluid: "crude-oil", per_min: NAMEPLATE, buffer_seconds: 600,
    surface: "nauvis" }).data || {}).storage || {};
  check("a ten-minute buffer on one pump's rate is one tank, and says how long that tank really is",
    buf.tanks === 1 && buf.capacity_each === consts.tank && buf.units_wanted === NAMEPLATE * 10
    && buf.units_held === consts.tank && near(buf.seconds_held, consts.tank / (NAMEPLATE / 60), 0.001),
    JSON.stringify(buf));
  const many = (call("fluid_chain", { fluid: "crude-oil", per_min: NAMEPLATE * 20,
    buffer_seconds: 600, surface: "nauvis" }).data || {}).storage || {};
  check("the tank count rounds up, and the rounded-up figure is what gets reported",
    many.tanks === Math.ceil(NAMEPLATE * 20 * 10 / consts.tank) && many.units_held >= many.units_wanted
    && many.seconds_held >= 600,
    JSON.stringify({ tanks: many.tanks, want: many.units_wanted, held: many.units_held,
      seconds: many.seconds_held }));

  // ---- the questions this method does not answer ----
  const notOre = call("fluid_chain", { fluid: "water", per_min: 600, surface: "nauvis" });
  check("water is refused as a resource, because nothing pumps it out of the ground",
    !notOre.ok && notOre.code === "NOT_A_RESOURCE", `${notOre.code} ${notOre.msg}`);
  const notFluid = call("fluid_chain", { fluid: "iron-ore", per_min: 600, surface: "nauvis" });
  check("an ore that yields items is sent back to solve, not sized as a fluid line",
    !notFluid.ok && notFluid.code === "NOT_A_FLUID_RESOURCE", `${notFluid.code} ${notFluid.msg}`);
  check("a fluid line admits that pipe throughput is not modelled",
    chain.ok && chain.data.pipes.modelled === false, JSON.stringify((chain.data || {}).pipes));

  lua(`local f=game.forces.player
f.recipes["pumpjack"].enabled = (storage["__was_pumpjack"] == nil) and false or storage["__was_pumpjack"]
storage["__was_pumpjack"]=nil
rcon.print("pumpjack recipe put back")`);

  console.log(`\n${fails === 0 ? "the ground and the line agree" : fails + " FAILED"}`);
  process.exit(fails ? 1 : 0);
})();
