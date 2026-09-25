// Does the bench answer the same question the player's map does?
//
// The rigs' default ground moved from `game.surfaces[1]` -- the map somebody is playing on, whose
// ore is gone once measured -- to a synthetic vein laid on the mod's own bench. That is only an
// improvement if the NUMBER survives the move: a rate measured on ground this mod laid has to agree
// with the same machine on the same ore in real ground, or the bench would be quietly redefining
// every plan built from it.
//
// So this is not a pass/fail gate but a comparison, and it deliberately spends the named path to
// make one -- the whole point of the change is that the unnamed path no longer does.
//
// It runs at the default 1x on purpose. Measured here: `game.speed = 40` is accepted and reported as
// `real_seconds: 1.5`, but this box cannot actually advance 2400 ticks a second, so the window took
// minutes of real time and RCON stopped answering inside it. A warp that cannot be paid for is the
// same lesson the rigs just learned, written down where the next person will read it.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("bench_rate_compare");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016" };
const call = (m, a) => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
  } catch (e) { return { ok: false, code: "HARNESS", msg: String((e && e.stderr) || e).slice(0, 160) }; }
  try { return JSON.parse(out.trim()); } catch (e) { return { ok: false, code: "PARSE", msg: out.slice(0, 160) }; }
};
const sleep = (ms) => { try { execFileSync("sleep", [String(ms / 1000)], { encoding: "utf8" }); } catch (e) {} };

// One rig run, start to finish. `refresh` now genuinely means "measure again", so the start call is
// what opens the window; the reads after it poll the job, which answers `running` until it closes.
function measureOnce(args) {
  // A rig refuses to start beside another rig's job, and a job left running by anything else on this
  // server -- an earlier suite, a hand at the console -- reads as "the bench disagrees" unless the
  // wait happens first. So: ask until the answer is about THIS job rather than about who is busy.
  let started = null;
  // Both excuses for not-having-started are waits, not answers: another rig's window, and a bench
  // plot whose chunks have not arrived. Retrying is the whole protocol the bench asks for.
  // `speed` is passed because this file measures on purpose at warp: the default is now 1x, and a
  // 60-game-second window at 1x is a minute of real time per row.
  for (let i = 0; i < 24; i += 1) {
    started = call("drill_rate", { ...args, seconds: 30, refresh: true });
    if (started.code !== "MEASUREMENT_BUSY" && started.code !== "SANDBOX_GENERATING") break;
    sleep(5000);
  }
  if (!started.ok && (started.data || {}).state !== "running") return started;
  for (let i = 0; i < 24; i += 1) {
    sleep(4000);
    const r = call("drill_rate", { ...args, seconds: 30 });
    if (!r.ok) return r;
    if (r.data.state !== "running") return r;
  }
  return { ok: false, code: "TIMEOUT" };
}

// Burner drills only: an electric one adds a second reason to read zero, and a comparison whose rows
// can fail for a reason other than the ground being compared proves nothing. The rigs' own records
// say `no_power` when that is what happened, which is the honest answer and not this file's business.
const ROWS = [
  { machine: "burner-mining-drill", resource: "iron-ore" },
  { machine: "burner-mining-drill", resource: "copper-ore" },
];

let bad = 0;
for (const row of ROWS) {
  const bench = measureOnce({ ...row });
  const map = measureOnce({ ...row, surface: "nauvis" });
  const b = (bench.data || {}), m = (map.data || {});
  b.code = b.code || bench.code; b.msg = b.msg || bench.msg;
  m.code = m.code || map.code; m.msg = m.msg || map.msg;
  const fmt = (d) => (d.items_per_min === undefined
    // A row with no number has to say WHY: `state: "running"` (the window never closed), a refusal
    // code, and a measured-zero record all look identical otherwise, and only one of them means the
    // bench disagrees.
    ? `no number [state=${d.state || "-"} code=${d.code || bench.code || map.code || "-"} `
      + `msg=${String(d.msg || bench.msg || map.msg || "").slice(0, 70)}]`
    : `${Number(d.items_per_min).toFixed(2)}/min over ${d.elapsed_game_seconds}s `
      + `(${d.belt_items} on the belt, clock ${d.clock_speed}, status ${d.drill_status}, `
      + `first item after ${d.first_item_after}s, ${d.arrival_ticks} arriving ticks)`);
  const ratio = b.items_per_min && m.items_per_min ? b.items_per_min / m.items_per_min : null;
  // Two 60-game-second windows on a machine this slow are a handful of items each, and the belt
  // count is a whole number, so the spread between two honest runs of the SAME ground is already a
  // third. Inside that spread the bench agrees; outside it, one of the two grounds is being mined
  // differently and the default cannot ship.
  const close = ratio !== null && ratio > 0.6 && ratio < 1.6;
  console.log(`${row.machine} on ${row.resource}:`);
  console.log(`  bench (arch-lab, laid vein): ${fmt(b)}  bench=${String(b.bench)}`);
  console.log(`  nauvis (the player's map):   ${fmt(m)}  bench=${String(m.bench)}`);
  console.log(`  ratio ${ratio === null ? "n/a" : ratio.toFixed(2)} ${close ? "<- agrees" : "<- DOES NOT AGREE"}`);
  if (!close) bad += 1;
}
console.log(bad === 0 ? "the bench measures the same thing" : `${bad} row(s) disagree -- do not default to the bench`);
process.exit(bad === 0 ? 0 : 1);
