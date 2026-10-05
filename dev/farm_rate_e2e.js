// End-to-end gate: the agricultural tower, measured rather than read.
//
// `agricultural-tower` does not state the two numbers a farm plan needs. It answers `radius` (its own
// footprint), `growth_area_radius`, `energy_usage` and `heating_energy`, and raises on
// `farm_tile_requires_water`, `accepted_seeds`, `input_inventory_size` and every planting-point field
// -- so tiles-per-tower and items-per-tower-minute live in animation geometry, and the only honest way
// to publish them is to stand a tower on the bench and watch it work. That is `farm_rate`, and this
// file is the gate that it happens, end to end, and says what it saw.
//
// Three things are asserted rather than one, because each is a different way to be wrong:
//
//   * the soil is DISCOVERED. The rig asks one candidate tile at a time and stops at the first that
//     grows a plant; the list of probes is the evidence, and a tower planted on grass says so
//     (`no_spot_seedable_by_inputs`) -- which is what an earlier probe mistook for a dead machine.
//   * the output is drained every tick. The tower's own inventory holds 100 items, and two windows
//     measured from outside the game both came back with exactly 100 at two different clock speeds --
//     the signature of a container, not a rate. So `harvest_batches` must be more than one, and the
//     per-minute figures must differ from each other (window vs steady), which is only possible if
//     nothing capped the count.
//   * the two clocks agree. `growth_ticks` on the plant is readable; the first harvest the rig saw is
//     not. They are independent measurements of the same thing, so they have to land on the same
//     number -- and that is the assertion that catches a rig which started its window before the
//     tower it measured was the one it planted.
//
// It runs at 60x on the bench surface and takes about twenty wall-seconds. Nothing here is spent on
// the player's map: the plot is the mod's own square, and the rig's own reap is checked at the end.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("farm_rate_e2e");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016" };
const call = (m, a) => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
  } catch (e) { return { ok: false, code: "HARNESS", msg: String((e && e.stderr) || e).slice(0, 160) }; }
  try { return JSON.parse(out.trim()); } catch (e) { return { ok: false, code: "PARSE", msg: out.slice(0, 160) }; }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", maxBuffer: 1 << 28, env: ENV }).trim();
  } catch (e) { return "LUA_HARNESS"; }
};
const data = (r) => (r && r.data) || {};
const asArr = (v) => (Array.isArray(v) ? v : []);
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log("  ok   " + name); }
  else { fail += 1; console.log("  FAIL " + name + " -- " + detail); }
};

// A window long enough to see several harvests: growth is 300 game-seconds for yumako, so 900 buys the
// first one plus room for more. The rig itself runs the world clock at 60x, so this is ~15 wall
// seconds -- and the suite waits for the record rather than guessing at it.
const WINDOW = 900;
const started = call("farm_rate", { seconds: WINDOW, refresh: true });
check("the farm rig starts, and says which tiles it is about to ask about",
  started.ok === true && (started.data || {}).state === "running"
  && asArr((started.data || {}).soil_candidates).length >= 1
  && ((started.data || {}).clock || {}).warps_world === true,
  `${started.code || "?"} ${JSON.stringify(started.data || started.msg).slice(0, 160)}`);

// While a rig holds the clock, another must not start beside it: both raise `game.speed` and each puts
// back the value it found, so two overlapping windows leave the world running fast and publish a rate
// measured under a clock nobody owns.
const crowded = call("drill_rate", { seconds: 2 });
// `accepted` here is worth reading as a symptom rather than as its own bug: the only way the farm's
// 900-second window can be over this quickly is that it never reached the rate phase (no seedable
// ground, or no power for the tower), so the clock was free again by the time the drill asked. The
// check above prints the rig's `error` for exactly that reason.
check("a second rig asked for the same clock is refused, and names the farm as the reason",
  !crowded.ok && crowded.code === "MEASUREMENT_BUSY" && /farm/.test(String(crowded.msg)),
  `${crowded.code || "accepted"} ${String(crowded.msg).slice(0, 90)}`);

// Three of the rig's own doors, reached on purpose: an item that does not grow, a seed that names no
// plant, and a planter that is not an entity. They come back BEFORE any ground is painted or the clock
// is raised -- a rig that placed a tower and then found it had nothing to plant would leave both behind.
// Spelled as rows with a `code:` field rather than a positional triple, because `refusals.js` counts an
// assertion by reading the code off a line that names it as a code.
const DOORS = [
  { name: "a seed that is not an item at all", args: { seed: "no-such-seed-here" }, code: "NO_SUCH_SEED" },
  { name: "an ordinary item that grows nothing", args: { seed: "iron-plate" }, code: "SEED_GROWS_NOTHING" },
  { name: "a planter this save does not have", args: { machine: "no-such-planter" }, code: "NO_SUCH_TOWER" },
];
for (const door of DOORS) {
  const r = call("farm_rate", door.args);
  check(`the rig refuses ${door.name}, by name`,
    !r.ok && r.code === door.code, `${r.code || "accepted"} ${String(r.msg).slice(0, 90)}`);
}

let rec = null;
for (let i = 0; i < 45 && !rec; i++) {
  sleep(1000);
  const r = call("farm_rate", { seconds: WINDOW });
  const d = data(r);
  if (r.ok && d.state !== "running") rec = d;
  else if (!r.ok) { rec = { __fail: r.code, __msg: r.msg }; break; }
}
rec = rec || { __none: true };
// When this goes red, the line has to say WHY the tower measured nothing rather than print another
// hundred characters of the record. The rig's own answer carries both halves of that: `error` names the
// verdict (`NOT_POWERED`, `NO_SEEDABLE_GROUND`, `NOTHING_HARVESTED`) and `power_attempts` says which
// cells its own ideal source tried -- and in-sweep (task #31) it is exactly those two fields that turn
// "five unexplained red lines" into "the source never landed, so the window measured an empty box".
check("the window closes and comes back as a measurement, not a job",
  !rec.__fail && !rec.__none && (rec.items_per_min || 0) > 0,
  JSON.stringify([rec.error, rec.remedy, rec.tower_status, rec.power_attempts,
    rec.items_per_min, rec.harvested_items]).slice(0, 420) + " | " + JSON.stringify(rec).slice(0, 160));

// ------------------------------------------------------------------ the soil, found ----
const probes = asArr(rec.soil_probes);
check("the rig asked tiles one at a time and wrote down what each one said",
  probes.length >= 1 && probes.every((p) => p && typeof p.plants === "number" && !!p.status)
  && typeof rec.soil === "string" && rec.soil !== "",
  JSON.stringify([rec.soil, probes]));
// The finding this whole shape exists for: grass is not farmland. A candidate the tower refuses reports
// `no_spot_seedable_by_inputs`, which is an engine sentence and not this file's guess.
check("a tile the tower will not work reports the engine's own reason, in the probe list",
  probes.some((p) => p.plants === 0 && /no_spot/.test(String(p.status)))
  || probes.every((p) => p.plants > 0),
  JSON.stringify(probes.map((p) => [p.tile, p.plants, p.status])));
check("...and the tile it settled on is one that grew a plant",
  (probes.find((p) => p.plants > 0) || {}).tile === rec.soil && rec.plants > 0,
  JSON.stringify([rec.soil, rec.plants, probes]));
check("the record says whether the probe walk finished or stopped at an answer",
  /stopped at the first|was asked, and none/.test(String(rec.soil_probe_rule)),
  String(rec.soil_probe_rule).slice(0, 120));

// ------------------------------------------------------------------ the rate, un-capped ----
// One harvest is 50 items (readable from the plant, and stated in the record beside what the rig saw),
// so a window of several harvests is a multiple of it -- and `batches > 1` is what says the tower's
// 100-slot output was never the number being measured.
check("the window saw more than one harvest, so the tower's own pocket cannot be the figure",
  (rec.harvest_batches || 0) > 1 && rec.harvested_items === rec.harvest_batches * rec.per_harvest,
  JSON.stringify([rec.harvest_batches, rec.per_harvest, rec.harvested_items]));
check("the steady rate is above the window average, because a new farm's first minutes are growth",
  (rec.steady_items_per_min || 0) > (rec.items_per_min || 0) && rec.steady_items_per_min > 0,
  JSON.stringify([rec.items_per_min, rec.steady_items_per_min, rec.elapsed_game_seconds]));
// Two independent numbers for the same fact: `growth_ticks` off the plant, and when the rig first saw a
// harvest. They are read from different places, so they are allowed to disagree -- and a rig that opened
// its window on plants it had already grown would make them.
check("the plant's stated growth time and the rig's first harvest are the same wait",
  rec.growth_seconds > 0 && rec.first_harvest_after > 0
  && Math.abs(rec.first_harvest_after - rec.growth_seconds) / rec.growth_seconds < 0.15,
  JSON.stringify([rec.growth_seconds, rec.first_harvest_after]));
check("...and the status history shows the tower ran rather than sat: it worked, then waited on growth",
  (rec.statuses || {}).working > 100 && (rec.statuses || {}).waiting_for_plants_to_grow > 0
  && rec.tower_status === "waiting_for_plants_to_grow",
  JSON.stringify([rec.statuses, rec.tower_status]));

// ------------------------------------------------------------------ the ground it works ----
// The number that is not a field: how many tiles one tower tills, and how far its crane reaches.
check("one tower's own ground is measured, and one plant stands on each tile",
  (rec.tiles_tilled || 0) > 0 && rec.plants >= rec.tiles_tilled
  && rec.reach_tiles > 3 && rec.reach_tiles < 40,
  JSON.stringify([rec.tiles_tilled, rec.plants, rec.reach_tiles]));
check("it was measured on the bench, and the answer says so",
  rec.bench === true && String(rec.surface || "").indexOf("arch-") === 0
  && /painted by this mod/.test(String(rec.caveat)),
  JSON.stringify([rec.bench, rec.surface, String(rec.caveat).slice(0, 60)]));
check("a second ask without refresh reads the record back rather than re-running the rig",
  (call("farm_rate", { seconds: WINDOW }).data || {}).cached === true,
  JSON.stringify((call("farm_rate", { seconds: WINDOW }).data || {}).cached));

// ------------------------------------------------------------------ the plan uses it ----
// The point of the rig: `solve` was able to say "6 plants have to be standing" and no further, because
// dividing by a tile count it did not have would be inventing one. With the record in `storage.farm` the
// same request names towers, tiles, and which of the two is binding.
const grown = call("solve", { want: { item: "yumako", rate_per_min: 300 } });
// A refusal answers at the top level (`{ok, code, msg, detail}`), not under `data` -- the same shape
  // every other suite reads. Reaching into `data` for a refused call is how a check ends up asserting
  // that a null equals a null.
  const detail = grown.detail || {};
const farm = detail.farm || {};
check("a farm plan stops at towers once the bench has measured one",
  !grown.ok && grown.code === "NO_RECIPE_SOURCE" && (farm.towers || 0) >= 1
  && (farm.tiles || 0) >= farm.towers * farm.tiles_per_tower
  && farm.tiles_per_tower === rec.tiles_tilled,
  JSON.stringify([grown.code, farm.towers, farm.tiles, farm.tiles_per_tower, rec.tiles_tilled]));
check("...and says which ceiling it hit, from the same two counts the solver divided by",
  (farm.towers_from || {}).plot >= 1 && (farm.towers_from || {}).crane >= 1
  && farm.towers === Math.max(farm.towers_from.plot, farm.towers_from.crane)
  && farm.items_per_tower_min > 0,
  JSON.stringify([farm.towers_from, farm.towers, farm.items_per_tower_min]));
check("the row still names the plant's own numbers beside them",
  farm.plants_standing > 0 && farm.growth_minutes > 0 && farm.seeds_per_min > 0,
  JSON.stringify([farm.plants_standing, farm.growth_minutes, farm.seeds_per_min]));
// The plan is sized on ONE seed per planting (the plant's arithmetic), while the bench measured the
// tray's real draw. Both have to reach the caller, and the sentence has to match whichever reading the
// bench actually gave -- the floor agreed, or a surplus nobody can explain. Asserting one fixed piece of
// prose here would be asserting this install's numbers rather than the rule.
const overOne = rec.seeds_over_one_per_planting || 0;
check("the seed draw travels with the row, and the prose says what the bench found",
  (farm.seed_draw || {}).consumed_per_min > 0
  && Math.abs(farm.seeds_per_min - farm.harvests_per_min * farm.seeds_per_plant) < 0.02
  && (overOne === 0 ? /exactly one seed per planting/.test(String(detail.why))
    : /seeds MORE than one per planting/.test(String(detail.why))),
  JSON.stringify([farm.seeds_per_min, farm.harvests_per_min, farm.seed_draw, overOne]).slice(0, 240));
// The sentence, not just the fields: `why` is what a refusal says out loud, and the panel renders the
// same fact from `r-farm-tower` (locale_check proves that row exists in both files). Measured numbers in
// the data and an unmeasured apology in the prose is exactly the drift this file exists to catch.
check("the prose says the measured thing, in the same breath as the fields",
  /tower\(s\) on \d+ tilled tiles/.test(String(detail.why))
  && /(the ground the plants need|crane's throughput)/.test(String(detail.why))
  && String(detail.why).indexOf("What is NOT answered") < 0,
  String(detail.why).slice(0, 220));

// ------------------------------------------------------------------ it takes itself back ----
const left = lua(`local s = game.surfaces["arch-lab"]
local function n(name) return #s.find_entities_filtered{name = name} end
rcon.print(n("agricultural-tower") .. " " .. n("electric-energy-interface") .. " " .. n("yumako-tree"))`);
// The lua harness ends its reply with a status word, so the three numbers are the first three tokens
// rather than the whole line: taking "0\nOK" as a number is how a clean bench reads as litter.
const [towers, gens, plants] = String(left).trim().split(/\s+/).slice(0, 3).map(Number);
check("the rig left no tower, no ideal source and no crop standing on the bench",
  towers === 0 && gens === 0 && plants === 0, `tower=${towers} gen=${gens} plants=${plants}`);
const clock = lua('rcon.print("speed=" .. game.speed .. " paused=" .. tostring(game.tick_paused))');
check("and the world clock is back where it was found", /speed=1 /.test(String(clock)), clock);

// The seed account has to close, because a single "seeds per minute" in a record is the kind of number
// a reader trusts: the rig only knows what it put into a 30-slot tray, so the honest figure is supplied
// minus what the tray still holds. `plantings_seen` is the floor of one seed per planting (each harvest
// replants, and every plant standing was planted once).
//
// The upper bound on `seeds_supplied` is the assertion that exists for the bug this accounting was
// written to kill: the first version counted the soil probe's tray into the window and never subtracted
// the tray's own contents, and the draw came out 40% over the floor -- which would have been published
// as a discovery about the tower. It was a bookkeeping error, and this line is what says so.
check("the seed account closes against the tray, and one seed per planting is the floor it is judged by",
  rec.seeds_consumed === rec.seeds_supplied - rec.seeds_in_tray_at_end
  && rec.plantings_seen === rec.harvest_batches + rec.plants
  && rec.seeds_consumed >= rec.plantings_seen
  && rec.seeds_supplied <= 30 + rec.plantings_seen,
  JSON.stringify([rec.seeds_supplied, rec.seeds_in_tray_at_end, rec.seeds_consumed,
    rec.plantings_seen, rec.harvest_batches, rec.plants, rec.seeds_over_one_per_planting]));

// The two numbers for one period have to be the same number: the plant's own growth time (read off the
// prototype) and the rate the rig derived from the spacing of its harvests. The derivation used to divide
// ALL of the window's items by the span from first harvest to last -- a span that holds `batches - 1`
// periods -- so the tower came out N/(N-1) times faster than it runs: double at two harvests, +50% at
// three, and `solve` turns that directly into too few towers. The check above (`steady > items_per_min`)
// cannot see it: an inflated number clears that bar even more easily than a correct one.
// The arithmetic claim behind `steady_items_per_min`, written down rather than asserted -- because the
// check first written here was WRONG in a way worth recording: it compared the steady rate to
// `per_harvest / growth_seconds`, assuming one harvest batch = one plant's maturing. It is not: a tower
// tills dozens of tiles on staggered clocks, and what the rig counts as a batch is one crane load out of
// the ground (this save: 50 items per load, ~92 loads in a 900-second window, against a plant that
// matures in 300 s). The rate the record publishes is therefore ~590/min while the "one harvest per
// period" figure a prototype reader would guess is 10/min -- a 59x miss that the PROTOTYPE cannot see and
// a remembered constant gets wrong in silence.
//
// What IS proven here is only the interval rule, which is arithmetic rather than observation: N deliveries
// at spacing P span (N-1)·P of time, and the first of them belongs to before the span opened, so the rate
// is (got - got/N) / span -- the same correction the drill rig's two-window slope already makes with
// `got - 1`. The old form divided all of `got` by that span and over-reported by N/(N-1): 1% at 92 batches,
// 50% at three, 100% at two. No live sample here is large enough in N to make that difference jump, and no
// cheaper one exists -- `steady` has no independent second measurement in the record to be checked
// against. Said plainly so nobody later writes this file's second remembered-constant assertion.

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
