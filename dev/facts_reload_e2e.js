// End-to-end gate: a fact the mod had to MEASURE off a live entity must be won at a moment when no
// second process exists to disagree about it, and must then travel in the save.
//
// Two real clients desynced on the helmod button (2026-10-01, `desync-report-2026-10-01_16-21-49` and
// `..._17-21-02`), and both reports say the same three things: `script.dat` BYTE-IDENTICAL (the plan,
// the helmod table and our storage agreed perfectly), the client's `next-unit-number` one AHEAD of the
// server's, and one chunk's `tick-of-last-change-that-could-affect-charting` different. One entity
// number, spent by the client alone. That is what a probe costs when it walks ground nobody has
// visited: `can_place_entity` makes the engine generate a chunk, and generating a chunk creates its
// rocks. The server had already walked that ground in an earlier call; the joining client had not, and
// the same button press cost the two processes different worlds -- which is a desync by definition, and
// invisible here, because a headless box runs one process and has nothing to compare itself to.
//
// So the claims, in the order that can fail:
//   1. an entity number is SPENT by a measurement, and the meter sees it (without this the gate below
//      is true of a mod that never measures);
//   2. once the figures are on record, a press spends NONE;
//   3. a process that LOADS the save starts with the same record and still spends none -- which is the
//      joining client, reproduced as far as one machine can reproduce it.
const { brief } = require("./lines.js");
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("facts_reload_e2e");

const ROOT = path.join(__dirname, "..");
const LOG = path.join(ROOT, ".factorio-test/server.out");
const ENV = { ...process.env, RCON_PORT: "27016", RCON_PW: "testpw",
  CONSOLE_LOG: path.join(ROOT, ".factorio-test/server-console.log") };
const call = (m, a) => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
  } catch (e) { return { ok: false, code: "NO_SERVER", msg: String((e && e.stderr) || e).slice(0, 120) }; }
  try { return JSON.parse(out.trim()); } catch (e) { return { ok: false, code: "PARSE", msg: out.slice(0, 200) }; }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8", env: ENV }).trim();
  } catch (e) { return "probe failed: " + String((e && e.stderr) || e).slice(0, 160); }
};

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log("  ok  " + what); }
  else { fail++; console.log("  FAIL " + what + (detail === undefined ? "" : "   " + String(detail).slice(0, 260))); }
};

// One meter, one press, ONE synchronous block: the console runs between ticks, so nothing else can
// spend an entity number inside it. Marks go on the same spot every time -- the first one pays for any
// chunk the engine wanted to generate there, and the rest read a steady world.
const SPENT = (body) => `local s = game.surfaces["nauvis"]
local function mark()
  local e = s.create_entity{ name = "inserter", position = { x = 2000.5, y = 2000.5 }, force = "player" }
  if not e then return -1 end
  local u = e.unit_number; e.destroy(); return u
end
local a = mark()
${body}
local b = mark()
rcon.print("spent=" .. (b - a - 1))`;
const spent = (body) => {
  const out = String(lua(SPENT(body)));
  const m = out.match(/spent=(-?\d+)/);
  return m ? { spent: Number(m[1]), raw: out } : { spent: null, raw: out };
};
const PRESS = `remote.call("arch","call","card_example",{ recipe = "iron-plate", machines = 3 })`;

const facts = () => {
  const r = call("measured_facts", {});
  return r.ok ? r.data : null;
};

const restart = require("./restart.js")({
  root: ROOT, rconPort: Number(ENV.RCON_PORT), save: ENV.TEST_SAVE || "m0-test", log: LOG, stdout: LOG,
});
function restart_and_wait() {
  const stopped = restart.stopAndSave();
  if (!stopped.saved) {
    console.log("SETUP FAIL " + (stopped.wrote && stopped.fresh
      ? "the server saved but did not exit in time; nothing was reloaded"
      : "the quit did not write a save, so nothing was reloaded") + ": " + brief(stopped, 300));
    process.exit(1);
  }
  return restart.startAndPing();
}

(async () => {
  console.log("facts_reload_e2e: a measured fact must be won once, and then travel in the save");

  const before = facts();
  if (!before || !before.figures) { console.log("SETUP FAIL measured_facts: " + brief(before, 200)); process.exit(1); }
  check("every arm on the install has a reach on record, and the record says how it was won",
    before.figures.reach > 0 && before.probes >= before.figures.reach
      && before.arms.length === before.figures.reach
      && before.arms.every((a) => typeof a.reach === "number" && a.reach >= 1),
    JSON.stringify([before.figures, before.probes, (before.arms || []).slice(0, 3)]).slice(0, 260));

  // (1) The meter has to be able to see a measurement at all, or (2) and (3) would be true of a mod
  // that never touches the world -- a green gate about nothing. So the record is thrown away WITHOUT
  // warming (the warming would do the spending itself, which is the mistake the first version of this
  // file made and then asserted a `spent > 0` about a call that had already finished measuring).
  const dropped = call("measured_facts", { drop: true });
  const cold = spent(PRESS);
  check("throwing the record away makes the next press go and measure, and the meter sees it spend",
    dropped.ok === true && dropped.data.figures.reach === 0
      && cold.spent !== null && cold.spent > 0,
    JSON.stringify([dropped.data && dropped.data.figures, cold]).slice(0, 240));

  // (2) The claim that matters to the player: with the record in hand, a press costs the world nothing.
  const warm = spent(PRESS);
  const after = facts();
  check("...and with the record on hand the same press spends no entity number at all",
    warm.spent === 0 && after.figures.reach > 0 && after.probes === cold.spent,
    JSON.stringify([warm, after.probes, cold.spent]).slice(0, 240));
  check("...and the card it answers with is the card the record was used to build",
    after.figures.reach === before.figures.reach
      && after.arms.every((a) => before.arms.some((b) => b.name === a.name && b.reach === a.reach)),
    JSON.stringify([after.arms.slice(0, 3), before.arms.slice(0, 3)]).slice(0, 260));

  // (3) A client joining an in-progress game is, for the mod, a fresh control-stage VM that loads
  // `storage` and starts ticking. If the record arrives with the save, that VM spends nothing.
  if (!restart_and_wait()) { console.log("SETUP FAIL server did not come back"); process.exit(1); }
  const loaded = facts();
  const loadedPress = spent(PRESS);
  check("a process that LOADS the save finds the same record and does not measure again",
    !!loaded && loaded.probes === after.probes && loaded.figures.reach === after.figures.reach,
    JSON.stringify([after, loaded]).slice(0, 240));
  check("...and its first press spends no entity number, which is the desync this file exists for",
    loadedPress.spent === 0, JSON.stringify(loadedPress).slice(0, 200));

  // The leave-behind rule the rest of the sweep depends on: this file's presses build cards, and cards
  // are geometry -- nothing of ours may still be standing on the ground when it finishes.
  const litter = lua(`local n = 0
for _, e in ipairs(game.surfaces["nauvis"].find_entities_filtered{ area = { { 1990, 1990 }, { 2010, 2010 } } }) do n = n + 1 end
rcon.print("marks=" .. n)`);
  check("the meter left nothing standing", /marks=0/.test(String(litter)), String(litter));

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) { console.log("FAILURES: " + fail); process.exitCode = 1; }
})();
