// End-to-end gate: a measurement that is in flight must survive a process that LOADS the game.
//
// Why a reload and not a second machine: the desync report from a real client showed the world data
// agreeing and the mod's own state disagreeing. A client joining an in-progress game is, for the mod,
// exactly a fresh control-stage VM that loads `storage` and starts ticking -- so the save/restart
// round trip here reproduces the same condition in one process, which is what this box can afford.
//
// The bug it was written for: `lab_ents` / `lab_rigs` were module-level tables of live LuaEntity
// handles, while the job record lives in `storage`. A process that loads the game with a job still
// `running` finds no handles, takes the "its live entity handles were gone" branch, and marks a job
// abandoned that the first process is still measuring -- two processes, one save, two states.
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
require("./suite-guard.js").guardMain("lab_reload_e2e");

const ROOT = path.join(__dirname, "..");
// stdout of the test instance: Factorio prints "Saving finished" here on a graceful quit.
const LOG = path.join(ROOT, ".factorio-test/server.out");
const ENV = { ...process.env, RCON_PORT: "27016", RCON_PW: "testpw",
  CONSOLE_LOG: path.join(ROOT, ".factorio-test/server-console.log") };
const call = (m, a) => {
  // The wait-for-restart loop calls this while the server is deliberately down, and `dev/call.js`
  // exits non-zero when RCON refuses -- which `execFileSync` throws on. A refused connection is the
  // answer, not an exception: the loop is asking "is it back yet?".
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
  } catch (e) { return "probe failed: " + String((e && e.stderr) || e).slice(0, 120); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log("  ok  " + what); }
  else { fail++; console.log("  FAIL " + what + (detail === undefined ? "" : "   " + String(detail).slice(0, 240))); }
};

// Everything on the bench that is not ore: that is what a rig puts down, and the only thing this can
// honestly expect to come back out again. The seed save's bench also carries fixture fields (coal,
// scrap, stone), and counting them made the first version of this check assert `bench=0` on a world
// that was never supposed to be empty.
const CENSUS = `local out = {}
for _, name in ipairs({ "arch-lab", "arch-sandbox" }) do
  local s = game.surfaces[name]
  if s then
    local n, kinds = 0, {}
    for _, e in ipairs(s.find_entities_filtered{}) do
      if e.type ~= "resource" and e.type ~= "tile" then n = n + 1 kinds[e.name] = (kinds[e.name] or 0) + 1 end
    end
    local p = {} for k, v in pairs(kinds) do p[#p+1] = k .. "=" .. v end table.sort(p)
    out[#out+1] = name .. "=" .. n .. (n > 0 and (" (" .. table.concat(p, " ") .. ")") or "")
  end
end
rcon.print(table.concat(out, " | "))`;

// A reload, not a restart. `dev/restart.js` quits gracefully so Factorio writes the save, then waits
// for the log AND the save file's own clock to agree it did: `dev/stop.sh` `kill -9`s on purpose (a
// cycle is meant to come back to the on-disk world), and a gate that used it would reload a world that
// was never saved -- which is exactly how the first version of this file "found" a cleared job.
const restart = require("./restart.js")({
  root: ROOT, rconPort: Number(ENV.RCON_PORT), save: ENV.TEST_SAVE || "m0-test",
  log: LOG, stdout: LOG,
});

function restart_and_wait() {
  const stopped = restart.stopAndSave();
  if (!stopped.saved) {
    console.log("SETUP FAIL the quit did not write a save, so nothing was reloaded: "
      + JSON.stringify(stopped).slice(0, 300));
    process.exit(1);
  }
  return restart.startAndPing();
}

(async () => {
  console.log("lab_reload_e2e: a running measurement must survive a load");
  // A long window at 40x is ~3 minutes of real time, which is more than a restart takes but less than
  // nothing: the job has to still be `running` when the second process loads, or this proves nothing.
  const card = (call("card_example", {}) || {}).data;
  if (!card || !card.name) { console.log("SETUP FAIL no example card: " + JSON.stringify(card).slice(0, 160)); process.exit(1); }
  // The baseline is the bench with no rig on it, taken in the same process that will start the job:
  // "came back clean" means "looks like this again", not "is empty".
  const baseline = lua(CENSUS);
  const started = call("card_lab", { card, seconds: 7200, speed: 40 });
  if (!started.ok) { console.log("SETUP FAIL card_lab: " + started.code + " " + started.msg); process.exit(1); }
  const job = (started.data || {}).job || started.job;
  sleep(5000);
  const before = call("lab_status", {}).data || {};
  const knownBefore = (call("bench_state", {}) || {}).data || {};
  const censusBefore = lua(CENSUS);
  check("a job is running, with a rig standing on the bench, before the reload",
    before.state === "running" && !!job && censusBefore !== baseline,
    `${before.state} job=${job} baseline="${baseline}" now="${censusBefore}"`);

  if (!restart_and_wait()) { console.log("SETUP FAIL server did not come back"); process.exit(1); }
  // Read the job BEFORE touching the bench: `sandbox` prepares the lab surface, and preparing it
  // takes the rig out of the world -- asking for it here is what made the first version of this gate
  // answer NO_JOB and look like a cleared record rather than a resurrected one.
  const after = call("lab_status", {}).data || {};
  const knownAfter = (call("bench_state", {}) || {}).data || {};
  const censusAfter = lua(CENSUS);
  check("the reloaded process still calls the job running, with the same job id",
    after.state === "running" && after.job === job,
    `${after.state} job=${after.job} because=${after.abandoned_because}`);
  check("and it still sees the same entities on the bench (nothing orphaned, nothing destroyed)",
    censusBefore === censusAfter, `${censusBefore} || ${censusAfter}`);

  // Finish it the way the player would: stop the job, and the world has to come back clean. If the
  // reloaded process lost the handles, this is where the litter shows up -- entities with no job.
  call("lab_stop", {}); sleep(3000);
  const done = lua(CENSUS);
  check("the reloaded process can still take the rig apart (it knows which entities were its own)",
    done === baseline, `baseline="${baseline}" after stop="${done}"`);

  // The two facts that caused the desync, read straight out of the save rather than inferred from
  // behaviour: the job record carrying its own entity handles, and "this pad has been painted" being
  // a fact about the save instead of about whichever process happened to open the bench first. A
  // process that loaded the game with neither of those wrote its own verdict on the job -- which is
  // one mod state per machine, and the engine says so.
  const carried = (knownBefore.lab_job || {}).entities_carried;
  check("the job record itself carries the handles, before and after the reload",
    carried > 0 && (knownAfter.lab_job || {}).entities_carried === carried
    && (knownAfter.lab_job || {}).rig_carried === true,
    `before=${JSON.stringify(knownBefore.lab_job || null)} after=${JSON.stringify(knownAfter.lab_job || null)}`);
  check("and the bench knows it has been painted, without anyone taking it in this process",
    (knownAfter.surfaces || {})["arch-lab"] && knownAfter.surfaces["arch-lab"].primed === true,
    JSON.stringify(knownAfter.surfaces || null));
  console.log(`${pass}/${pass + fail} lab_reload_e2e checks passed`);
  process.exit(fail ? 1 : 0);
})();
