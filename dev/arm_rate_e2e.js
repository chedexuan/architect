// End-to-end gate: what one inserter can actually carry, measured by watching one.
//
// An arm is the only part of a lane whose rate is neither arithmetic nor a field. A belt's figure is a
// formula the project publishes (`speed * 8 * 60` items a second); a machine's is in its recipe; and an
// inserter answers NOTHING for `rotation_speed`, `extension_speed`, `inserter_length`, `stack_size` or
// `energy_usage` (measured: every one of those names raises on `inserter`, `fast-inserter`,
// `long-handed-inserter`, `stack-inserter` and `bulk-inserter`). So the only honest source for "can the
// arm on this row lift what the row makes" is a window in which an arm lifts something.
//
// That window has already taught this file three things, and each is asserted here rather than trusted:
//
//   * an inserter FACES the side it picks from, not the side it drops to (the belt convention is the
//     opposite, and a rig built on it reported `NOTHING_CARRIED` for all six tiers while the arms
//     waited on the far chest). The proof is two identical columns facing opposite ways: one works, the
//     other reads `waiting_for_source_items`.
//   * reach is not readable either, so the rig asks: a tier that moved nothing in the prove window gets
//     its chests one tile further out and a fresh window. `long-handed-inserter` is measured at spacing
//     2 by that path, and the row says which spacing it was measured at -- a rate without its geometry
//     is a number nobody can reuse.
//   * arms are electric in 2.0. An unpowered one reports `no_power` and swings zero times, which is
//     indistinguishable from a slow arm unless the grid is laid on purpose. So the rig merges a network
//     on the bench (never on a surface the caller named, which is what keeps `arch-sandbox` able to
//     answer a coverage question afterwards) and puts its own ideal source back when it closes.
//
// It runs at 20x on the bench for ~20 game-seconds, measures every placeable tier side by side in the
// same window, and takes all of it back: the last check counts what is standing on the bench, because
// an arm rig that leaves six chests and a generator behind is a rig the next suite measures against.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("arm_rate_e2e");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016" };
const call = (method, args) => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
  } catch (e) { return { ok: false, code: "HARNESS", msg: (e.stdout || String(e)).toString().slice(0, 160) }; }
  try { return JSON.parse(out.trim()); }
  catch (e) { return { ok: false, code: "PARSE", msg: out.slice(0, 160) }; }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", maxBuffer: 1 << 28, env: ENV }).trim().split("\n")[0];
  } catch (e) { return "LUA_HARNESS"; }
};
const asArr = (v) => (Array.isArray(v) ? v : []);
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log("  ok   " + name); }
  else { fail += 1; console.log("  FAIL " + name + " -- " + detail); }
};

// Six real seconds at 20x. Long enough that the busy check below is racing a window rather than a
// process launch, and long enough that a swing count is not one or two items of rounding.
const WINDOW = 120;
const started = call("arm_rate", { seconds: WINDOW, refresh: true });
check("the arm rig starts, and says which tiers it is about to watch",
  started.ok && started.data.state === "running" && asArr(started.data.arms).length >= 2
  && typeof started.data.chest === "string",
  `${started.code || "?"} ${JSON.stringify(started.data).slice(0, 160)}`);

// One clock, one owner. The rig shares `game.speed` with the other three, so a second one starting
// beside it would have each put back the other's baseline and leave the world fast.
const crowded = call("drill_rate", { seconds: 2 });
check("a second rig asked for the same clock is refused, and names the arm rig as the reason",
  !crowded.ok && crowded.code === "MEASUREMENT_BUSY" && /inserter/.test(String(crowded.msg)),
  `${crowded.code || "accepted"} ${String(crowded.msg).slice(0, 90)}`);

let rec = null;
for (let i = 0; i < 30 && !rec; i++) {
  sleep(1000);
  const r = call("arm_rate", { seconds: WINDOW });
  if (!r.ok) { rec = { __fail: r.code, __msg: r.msg }; break; }
  if (r.data.state !== "running") rec = r.data;
}
rec = rec || { __none: true };
const tiers = asArr(rec.tiers);
const byName = {};
for (const t of tiers) byName[t.arm] = t;
const moved = (n) => (byName[n] || {});

check("the window closes with a figure per tier, not a job",
  !rec.__fail && !rec.__none && tiers.length >= 2 && !!rec.best,
  JSON.stringify(rec).slice(0, 180));
// The rule that matters more than any number here: a tier the rig could not measure says so in words.
// "0 a minute" and "the bench would not place this column" are different claims, and only the second is
// a fact about the rig rather than a lie about the arm.
check("no tier is left as a bare zero -- each one carries a figure or a named reason",
  tiers.every((t) => (t.items_per_min || 0) > 0 || (!!t.error && !!t.note && !!t.arm_status)),
  JSON.stringify(tiers.map((t) => [t.arm, t.items_per_min, t.error, t.arm_status])));
check("every measured tier says the geometry it was measured at",
  tiers.every((t) => !t.items_per_min || (t.source_spacing || 0) >= 1)
  && tiers.every((t) => !t.chests_moved_out || t.source_spacing === t.chests_moved_out),
  JSON.stringify(tiers.map((t) => [t.arm, t.source_spacing, t.chests_moved_out])));
// The ordering is the part of this that survives a modpack: which tier beats which is what a lane
// choice is made of, and it holds across the swing-count differences.
const faster = (a, b) => (byName[a] || {}).items_per_min > (byName[b] || {}).items_per_min;
check("a fast arm beats a plain one and a stack arm beats a fast one",
  faster("fast-inserter", "inserter") && faster("stack-inserter", "fast-inserter"),
  JSON.stringify(["inserter", "fast-inserter", "stack-inserter"].map((n) => [n, moved(n).items_per_min])));
check("...and the best in the record is one of the measured rows, not a tier that failed",
  !!rec.best && (rec.best.error === undefined || rec.best.error === null)
  && byName[rec.best.arm] !== undefined && faster("stack-inserter", rec.best.arm) === false,
  JSON.stringify([rec.best]));
// A stack tier carries more than one item per arrival; a plain one carries one. Measured as
// items-per-swing, because that is the difference between "faster arm" and "bigger hand" -- and a lane
// whose chests are one tile apart cares about both separately.
check("items per swing separates a faster arm from a bigger hand",
  (byName["inserter"] || {}).items_per_swing === 1
  && (byName["stack-inserter"] || {}).items_per_swing > 1,
  JSON.stringify(["inserter", "stack-inserter"].map((n) => [n, moved(n).items_per_swing, moved(n).swings])));
// The grid: laid on purpose, and taken back. A `electric-energy-interface` left on the bench answers
// every later power question there with an infinite source, which is the one side effect the rigs are
// not allowed to leave behind.
const left = lua(`local s = game.surfaces["arch-lab"]
local function n(name) return #s.find_entities_filtered{name = name} end
rcon.print(n("inserter") .. " " .. n("fast-inserter") .. " " .. n("long-handed-inserter") .. " "
  .. n("stack-inserter") .. " " .. n("bulk-inserter") .. " " .. n("burner-inserter") .. " "
  .. n("iron-chest") .. " " .. n("electric-energy-interface"))`);
const counts = String(left).split(" ").map(Number);
check("it takes every arm, chest and generator back when the window closes",
  counts.length >= 8 && counts.every((x) => x === 0), left);
const clock = lua('rcon.print("speed=" .. game.speed)');
check("and the world clock is back at 1x", clock === "speed=1", clock);
check("a second ask without refresh reads the record back instead of running the arms again",
  (call("arm_rate", { seconds: WINDOW }).data || {}).cached === true,
  JSON.stringify((call("arm_rate", { seconds: WINDOW }).data || {}).cached));
// A one-tier ask is a different question, so it is filed under a different key: measuring only the
// stack arm and having it replace the six-tier record would hand the next caller a library with rows
// missing and no trace of why.
const single = call("arm_rate", { seconds: 30, arm: "stack-inserter", refresh: true });
for (let i = 0; i < 20; i++) {
  const st = call("arm_rate", { seconds: 30, arm: "stack-inserter" });
  if (st.ok && st.data.state !== "running") break;
  sleep(500);
}
const all = call("arm_rate", { seconds: WINDOW });
check("naming one tier does not overwrite the record that measured all of them",
  single.ok && asArr(all.data.tiers).length >= tiers.length && (all.data.best || {}).arm,
  JSON.stringify([asArr(all.data.tiers).length, tiers.length]));
// ...and this suite leaves no job behind: `bench_check` asks the same question between suites, but a
// gate that knows it started a window should finish the one it started.
check("the rig's own job is closed by the time this suite ends",
  (call("bench_state", {}).data || {}).arm_job === false,
  JSON.stringify((call("bench_state", {}).data || {}).arm_job));

// An item the save has never heard of is refused before a chest, an arm or a grid is placed, because
// the alternative is a rig that builds an entire bench to measure nothing.
{
  const nope = call("arm_rate", { item: "no-such-item-here" });
  check("an item this save does not have is refused by name, before anything is laid",
    !nope.ok && nope.code === "NO_SUCH_ITEM" && nope.detail.asked_for === "no-such-item-here",
    `${nope.code || "accepted"} ${JSON.stringify(nope.detail || nope.msg).slice(0, 90)}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
