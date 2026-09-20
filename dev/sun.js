// What fraction of a Factorio day does a solar panel actually produce?
//
// The runtime gives phase boundaries (dusk/evening/dawn/morning) but not the shape of the
// ramp, and every "N panels per kW" rule of thumb is somebody's guess. So measure it.
//
// Facts this probe exists because of, each learned the hard way:
//   * `entity.energy_generated_last_tick` RAISES for a solar panel ("Entity is not
//     generator"). Only the network's flow statistics see solar output.
//   * `LuaFlowStatistics:clear()` stops that network from recording again -- after clearing,
//     10k ticks left an empty table. Measure deltas of the absolute counters instead.
//   * An idle assembler draws nothing and solar with no load delivers nothing, so the rig
//     needs a machine that is actually crafting: bound recipe, fed, output space free.
//   * **A script surface gets no sunlight at all** -- on arch-sandbox a panel with
//     always_day=true produced 0 and its load reported `no_power`. Only a real planet
//     surface has a sun, so this has to run on nauvis and clean up after itself.
//   * a harness that coalesces a raised error to 0 reports a solar duty of 0.0000 with
//     total confidence. Fail loudly.
const { execFileSync } = require("child_process");
const path = require("path");

const SURFACE = process.argv[3] || "nauvis";
const X = 100;               // rig corner on the planet; cleared before and after
const lua = (src) => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (/^LUA_ERROR/.test(out) || /TRUNCATED/.test(out)) {
    console.error("probe failed: " + out.slice(0, 400));
    process.exit(1);
  }
  return out.replace(/\n?OK$/, "").trim();
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

const N = Number(process.argv[2] || 24);
const S = `game.surfaces["${SURFACE}"]`;
const POLE = `{area={{${X - 1},${X - 1}},{${X + 1},${X + 3}}},name="small-electric-pole"}`;
const CLEAR = `for _,p in ipairs(${S}.find_entities_filtered{area={{${X - 3},${X - 3}},{${X + 12},${X + 12}}},force="player"}) do p.destroy() end`;

lua(`${CLEAR}
local s=${S}
local po=s.create_entity{name="small-electric-pole",position={x=${X + 0.5},y=${X + 0.5}},force="player"}
local sp=s.create_entity{name="solar-panel",position={x=${X + 3.5},y=${X + 0.5}},force="player"}
local am=s.create_entity{name="assembling-machine-1",position={x=${X + 7.5},y=${X + 0.5}},force="player"}
am.set_recipe("iron-gear-wheel")
am.insert({name="iron-plate",count=400})
s.always_day=true
rcon.print("rig built plates="..am.get_inventory(defines.inventory.assembling_machine_input).get_item_count())`);

const READ = `local s=${S}
local st=s.find_entities_filtered(${POLE})[1].electric_network_statistics
local function num(c) if type(c)=="table" then return (tonumber(c.float) or 0)*(10^(tonumber(c.multiplier) or 0)) end return tonumber(c) or 0 end
local g,u=0,0
for _,v in pairs(st.output_counts) do g=g+num(v) end
for _,v in pairs(st.input_counts) do u=u+num(v) end
rcon.print(string.format("%.1f %.1f %d", g, u, game.tick))`;

console.log(lua(`local s=${S} local am=s.find_entities_filtered{area={{${X + 5},${X - 1}},{${X + 10},${X + 3}}},name="assembling-machine-1"}[1]
local nm="?" for k,v in pairs(defines.entity_status) do if v==am.status then nm=k end end
rcon.print("status="..am.status.."("..nm..") tpd="..s.ticks_per_day.." dusk="..s.dusk.." evening="..s.evening.." dawn="..s.dawn.." morning="..s.morning)`));

const window = (setup, ms) => {
  lua(`game.tick_paused=true local s=${S} ${setup} rcon.print("pinned")`);
  const [g0, u0, t0] = lua(READ).split(" ").map(Number);
  lua(`game.tick_paused=false game.speed=40 rcon.print("go")`);
  sleep(ms);
  lua(`game.tick_paused=true game.speed=1 rcon.print("stop")`);
  const [g1, u1, t1] = lua(READ).split(" ").map(Number);
  const seconds = (t1 - t0) / 60;
  if (!(seconds > 0.2)) { console.error(`window too short: ${seconds}s`); process.exit(1); }
  return { gen: g1 - g0, use: u1 - u0, seconds };
};

const rows = [];
const full = window(` s.always_day=true s.freeze_daytime=false `, 1600);
rows.push({ t: "always_day", ...full });
for (let i = 0; i < N; i++) {
  const t = i / N;
  rows.push({ t: t.toFixed(3), ...window(` s.always_day=false s.freeze_daytime=true s.daytime=${t} `, 700) });
}
lua(`local s=${S} s.freeze_daytime=false s.always_day=false game.tick_paused=true game.speed=1 ${CLEAR} rcon.print("rig cleared")`);

if (!(full.gen > 0)) { console.error("full-sun generation was 0; aborting"); process.exit(1); }
console.log(`full sun: ${(full.gen / full.seconds).toFixed(1)} units/s over ${full.seconds.toFixed(1)} game-s; load took ${(full.use / full.seconds).toFixed(1)} /s`);
// Per game-second, not per window: each window advances a different number of ticks
// because RCON and process-spawn latency are inside the wall-clock budget.
const rate = (r) => r.gen / r.seconds;
const ratios = rows.slice(1).map((r) => ({ t: Number(r.t), sun: rate(r) / rate(full) }));
for (const r of ratios) console.log(`  daytime ${r.t.toFixed(3)}  sun=${r.sun.toFixed(3)}`);
const duty = ratios.reduce((a, r) => a + r.sun, 0) / ratios.length;
console.log(`MEASURED SOLAR DUTY = ${duty.toFixed(4)}  -> ${(1 / duty).toFixed(2)} kW of panels per 1 kW of constant load`);
