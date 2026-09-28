// The bench between suites: is the world in the state the next suite was told it would get?
//
// Every suite here mutates one shared world. `dev/test-reset.sh` guarantees the state at the START of
// a sweep and `dev/suite-guard.js` guarantees which server it is, but nothing checked the state between
// two suites -- so when one of them left the world running at 60x, froze a card nobody unfroze, or left
// a rig's tower standing, the next suite simply answered differently. That class has cost real time:
// rates that looked doubled, a bench that reported another run's cached drill, a farm row whose shape
// depended on which gate had run first. Two suites reading one world is fine; two suites reading one
// world WITHOUT SAYING WHAT IT HOLDS is the bug.
//
// So this is the one check between suites. It fails on the four things that change what a suite
// measures, and reports the rest:
//
//   * the mod on the server is not the mod in `src/` -- a stale pack, which makes a whole sweep green
//     about code that is not running;
//   * the world clock is raised or the world is paused: a rate measured under a borrowed clock is not a
//     rate, and a paused world measures zero forever;
//   * a rig is still running: two rigs share one clock, so a job that outlived its suite is the exact
//     shape `busy_refusal` exists to prevent;
//   * a rig's own entities are still standing: the drill's belt line, the pump's tank, the tower's
//     planter and every `electric-energy-interface` produce a number the next run would read as ground.
//
// What it only reports (card count, cached measurements, ghosts inside the sandbox) is legitimate
// residue: suites freeze cards on purpose, and a measurement cache is the reason a second ask is free.
// Declaring it is still the point -- a suite that suddenly inherits three cached drills is a fact a
// reader can see instead of a mystery they have to re-derive.
//
// Usage: bash dev/test.sh node dev/bench_check.js            (one line, exit 0/1)
//        ... node dev/bench_check.js --quiet-after-drill     (the runner passes nothing special today)
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV = process.env;
const raw = (args) => execFileSync(process.execPath,
  [path.join(__dirname, "call.js"), ...args],
  // The transport's byte-count note belongs to whoever types a single call by hand; in a checker that
  // runs three of them between every suite it would bury the one line worth reading. A refusal still
  // arrives through the catch below, which reads stdout and stderr off the error.
  { encoding: "utf8", maxBuffer: 1 << 28, env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
// `dev/call.js` prints the DATA of an answer and exits non-zero when the method refused, so a refusal
// arrives here as a HARNESS record rather than as `{ok:false}`. That is the right shape for a checker:
// a method that refuses to say what the bench holds IS a bench problem.
const call = (method, args) => {
  try { return { ok: true, data: JSON.parse(raw([method, JSON.stringify(args || {})])) }; }
  catch (e) { return { ok: false, code: "REFUSED", msg: String((e && e.stdout) || (e && e.stderr) || e).slice(0, 200) }; }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", maxBuffer: 1 << 28, env: ENV }).trim();
  } catch (e) { return "LUA_HARNESS " + String((e && e.stderr) || e).slice(0, 120); }
};

const problems = [];
const notes = [];

// 1. the pack matches the tree. `dev/pack.py` prints a note rather than failing when `mods/` holds an
// older version than the one being packed, and a stale zip is the one fault that makes a green sweep
// mean nothing: every assertion would be true of code that is not loaded.
const packed = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "architect", "info.json"), "utf8"));
const live = call("ping", {});
const version = (live.data || {}).mod_version;
if (!version) problems.push(`server does not answer ping: ${live.code} ${String(live.msg).slice(0, 90)}`);
else if (version !== packed.version) {
  problems.push(`server runs architect ${version} but src/architect/info.json says ${packed.version}`
    + " -- re-run dev/pack.py (or a full cycle) before trusting anything below this line");
}

// 2 and 3. the clock and the jobs. Read from the game rather than from a method where possible: a
// method's own answer is shaped by the mod, and `game.speed` is the fact the mod itself is not allowed
// to be wrong about.
const clock = lua('rcon.print("speed=" .. game.speed .. " paused=" .. tostring(game.tick_paused))');
const m = /speed=([0-9.]+) paused=(\w+)/.exec(String(clock));
if (!m) problems.push(`cannot read the world clock: ${String(clock).slice(0, 90)}`);
else {
  if (Number(m[1]) !== 1) problems.push(`world clock left at ${m[1]}x -- a rate measured under it is not comparable with one measured at 1x`);
  if (m[2] === "true") problems.push("the world is paused: a window opened now counts zero ticks forever");
}
const bench = call("bench_state", {});
const b = bench.data || {};
for (const [field, name] of [["drill_job", "drill"], ["pump_job", "pump"], ["farm_job", "farm"],
                             ["lab", "card"]]) {
  if (b[field] === true || (b[field] && b[field].state === "running")) {
    problems.push(`the ${name} rig is still running -- its suite ended without closing its window`);
  }
}

// 4. the parts only rigs put down. Named in a list because the check is one question: is anything
// standing on the bench that a measurement placed there? A suite that crashes mid-window leaves these
// behind, and the next suite reads the leftovers as ground.
const RIG_PARTS = ["mining-drill", "electric-mining-drill", "burner-mining-drill", "pumpjack",
  "storage-tank", "electric-energy-interface", "agricultural-tower", "pipe", "transport-belt",
  "inserter", "long-handed-inserter", "fast-inserter", "stack-inserter", "small-electric-pole",
  "medium-electric-pole", "big-electric-pole", "assembling-machine-1", "assembling-machine-2",
  "furnace", "steel-furnace", "electric-furnace", "iron-chest", "wooden-chest", "chest"];
const left = lua(`local names = {` + RIG_PARTS.map((n) => `"${n}"`).join(",") + `}
local out = {}
local total = 0
local unknown = 0
for _, sname in ipairs({"arch-lab", "arch-sandbox", "nauvis"}) do
  local s = game.surfaces[sname]
  if s then
    local per = {}
    for _, n in ipairs(names) do
      -- find_entities_filtered with a name that is not an entity RAISES, and the list above is a
      -- superset of what every install has ("chest" is not an entity in 2.0, and a modpack drops the
      -- tier it likes least). So the name is asked of the prototypes first: a missing one is not a
      -- finding, it is just nothing to look for.
      if prototypes.entity[n] then
        local k = #s.find_entities_filtered{name = n}
        if k > 0 then per[#per+1] = n .. "=" .. k; total = total + k end
      else unknown = unknown + 1 end
    end
    if #per > 0 then out[#out+1] = sname .. ": " .. table.concat(per, " ") end
  end
end
local ghosts = 0
local n = game.surfaces["nauvis"]
if n then ghosts = #n.find_entities_filtered{type = "entity-ghost"} end
local researched = 0
for _, t in pairs(game.forces.player.technologies) do if t.researched then researched = researched + 1 end end
rcon.print(total .. "|" .. table.concat(out, " ; ") .. "|ghosts=" .. ghosts .. "|techs=" .. researched
  .. "|skipped=" .. unknown)`);
// The harness answers with the print and then a status word of its own, so only the first line is the
// reply; the guard below reads the same line the fields come from, or a broken query would still look
// like a number.
const reply = String(left).split("\n")[0];
const [count, detail, ghosts, techs, skipped] = reply.split("|");
// A reply that does not start with a number is the query itself failing, and the old version of this
// line read that as "0 rig parts" and printed `bench clean`. A check that cannot fail is worse than no
// check: it is the reason this one existed for exactly one sweep before being noticed.
if (!/^\d+\|/.test(reply)) {
  problems.push(`cannot read the bench: ${reply.slice(0, 140)}`);
} else if (Number(count) > 0) {
  // Nauvis is in this walk on purpose. A rig part standing on the surface a client loads is the exact
  // damage this project's whole guard set exists to prevent, and a suite that died halfway -- a crash
  // between placing and reaping -- leaves precisely that, quietly changing what the NEXT suite measures
  // (observed: an empty "hardware this surface refuses" report after a run that never reached its
  // cleanup, which read like a code regression for an hour).
  problems.push(`${count} rig part(s) still standing: ${String(detail).slice(0, 220)}`);
}

// Reported, not judged. Both of these change what a suite answers -- ghosts on the player's map are what
// a placement test leaves on purpose, and a grant list is a fixture rather than an invariant -- so they
// belong in the line a reader sees, where a jump between two suites' lines is at least *visible*.
// `lacks=N` is how many names on the rig list this install does not have, so a whole tier missing
// (a modpack without `stack-inserter`, say) can be seen from the sweep's log rather than inferred later.
notes.push(`${String(ghosts || "?").replace("ghosts=", "ghosts on nauvis ")} `
  + `${String(techs || "?").replace("techs=", "researched techs ")} `
  + `${String(skipped || "?").replace("skipped=", "lacks=")} `);
const cards = call("cards", {});
notes.push(`cards=${(cards.data || {}).count}`);
notes.push(`bench: surfaces=${Object.keys(b.surfaces || {}).length} speed=${m ? m[1] : "?"}`);

if (notes.length) console.log(notes.join(" "));
if (problems.length) {
  for (const p of problems) console.log("  FAIL " + p);
  console.log(`${problems.length} bench problem(s)`);
  process.exit(1);
}
console.log(`bench clean (architect ${version || "?"}, clock 1x, no rig running, no rig parts standing)`);
