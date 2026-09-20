// Measure the actual solar output curve, in the game, with the day running freely.
//
// Why this exists: the power sizing in power.lua needs a duty factor, and the obvious way to
// pin the sun -- freeze_daytime and read one value -- does not work: the freeze does not hold
// across RCON commands, so the sample is taken at whatever time the surface had drifted to.
// Letting the clock run and polling densely instead gets the whole curve in one game day
// (~10.5 s of wall time at speed 40).
//
// One persistent RCON socket, because spawning a process per sample costs more than the game
// time between samples.
const net = require("net");

const HOST = process.env.RCON_HOST || "127.0.0.1";
const PORT = parseInt(process.env.RCON_PORT || "27015", 10);
const PW = process.env.RCON_PW || "m0pw";
const SURFACE = process.argv[2] || "nauvis";
const SAMPLES = parseInt(process.argv[3] || "400", 10);
let BOUNDS = [0.25, 0.45, 0.55, 0.75];
const GAP_MS = parseInt(process.argv[4] || "25", 10);
const X = 100;

const sock = new net.Socket();
sock.setNoDelay(true);
let id = 1;

// Factorio's RCON is not the standard Source ordering that rcon libs assume: the password is
// sent as an EXEC_COMMAND, commands then go out as AUTH packets, and replies arrive as
// RESPONSE_VALUE with no reliable request-id pairing. dev/rcon.js already depends on this;
// the loop client mirrors it exactly and resolves a reply by silence instead of by id.
let resolver = null;
let body = "";
let idleTimer = null;
let authed = null;
const authGate = new Promise((r) => { authed = r; });

const arm = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!resolver) return;
    const r = resolver;
    resolver = null;
    clearTimeout(idleTimer);
    idleTimer = null;
    r(body.trim());
  }, 25);
};

sock.on("data", (d) => {
  acc = Buffer.concat([acc, d]);
  for (;;) {
    if (acc.length < 12) return;
    const size = acc.readInt32LE(0);
    if (acc.length < size + 4) return;
    const rid = acc.readInt32LE(4);
    const type = acc.readInt32LE(8);
    const payload = acc.slice(12, size + 4 - 2).toString("utf8");
    acc = acc.slice(size + 4);
    if (type === 2) {
      if (rid === -1) { console.error("auth failed"); process.exit(2); }
      authed();
      continue;
    }
    if (type === 0 && resolver) {
      body += payload;
      arm();
    }
  }
});
let acc = Buffer.alloc(0);

const packet = (rid, type, text) => {
  const bytes = Buffer.byteLength(text, "utf8");
  const b = Buffer.alloc(4 + 8 + bytes + 2);
  let o = 0;
  b.writeInt32LE(10 + bytes, o); o += 4;
  b.writeInt32LE(rid, o); o += 4;
  b.writeInt32LE(type, o); o += 4;
  b.write(text, o, "utf8"); o += bytes;
  b[o++] = 0; b[o] = 0;
  return b;
};

const cmd = (src) => new Promise((resolve, reject) => {
  if (resolver) return reject(new Error("another command is in flight"));
  body = "";
  resolver = resolve;
  sock.write(packet(id++, 2, `/c ${src}`));
  setTimeout(() => { if (resolver === resolve) { resolver = null; reject(new Error("rcon timeout")); } }, 6000);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
sock.connect(PORT, HOST, () => sock.write(packet(1, 3, PW)));

const S = `game.surfaces["${SURFACE}"]`;
const POLE = `{area={{${X - 1},${X - 1}},{${X + 1},${X + 3}}},name="small-electric-pole"}`;
const CLEAR = `for _,p in ipairs(${S}.find_entities_filtered{area={{${X - 4},${X - 4}},{${X + 14},${X + 14}}},force="player"}) do p.destroy() end`;

const READ = `local s=${S}
local po=s.find_entities_filtered(${POLE})[1]
if not po then rcon.print("NOP") return end
local st=po.electric_network_statistics
local function num(c) if type(c)=="table" then return (tonumber(c.float) or 0)*(10^(tonumber(c.multiplier) or 0)) end return tonumber(c) or 0 end
local g=0 for _,v in pairs(st.output_counts) do g=g+num(v) end
local u=0 for _,v in pairs(st.input_counts) do u=u+num(v) end
-- The accumulator bank is the sink, and it is emptied on every read: a charged battery stops
-- accepting power, and then the panel can only produce what is consumed and the meter records
-- the load, not the sun. That is exactly what the assembler version of this rig did.
for _,a in ipairs(s.find_entities_filtered{area={{${X + 6},${X - 1}},{${X + 16},${X + 2}}},name="accumulator"}) do a.energy = 0 end
rcon.print(string.format("%.6f %d %.1f %.1f", s.daytime, game.tick, g, u))`;

(async () => {
  await authGate;
  const warm = await cmd("return 1");
  console.log(`rcon authenticated, warmup=${JSON.stringify(warm).slice(0, 20)}`);

  await cmd(CLEAR);
  const rigLine = (await cmd(`local s=${S}
local po=s.create_entity{name="small-electric-pole",position={x=${X + 0.5},y=${X + 0.5}},force="player"}
local sp=s.create_entity{name="solar-panel",position={x=${X + 3.5},y=${X + 0.5}},force="player"}
for i=1,3 do s.create_entity{name="accumulator",position={x=${X + 7.5}+(i-1)*3,y=${X + 0.5}},force="player"} end
s.always_day=false s.freeze_daytime=false
local dp=s.daytime_parameters
rcon.print("rig: tpd="..s.ticks_per_day.." dusk="..dp.dusk.." evening="..dp.evening.." morning="..dp.morning.." dawn="..dp.dawn)`));
  console.log(rigLine.trim());
  const bm = rigLine.match(/dusk=([\d.]+) evening=([\d.]+) morning=([\d.]+) dawn=([\d.]+)/);
  if (bm) BOUNDS = [Number(bm[1]), Number(bm[2]), Number(bm[3]), Number(bm[4])];

  // Calibration first: with always_day the panel is at full nameplate against a sink that
  // never fills, so the meter must read the panel's 60 kW. If it does not, nothing measured
  // below means anything, and the whole sweep would be decoration.
  await cmd(`local s=${S} s.always_day=true return 1`);
  await cmd("game.tick_paused=false game.speed=60 return 1");
  const cal = [];
  for (let i = 0; i < 25; i++) { cal.push((await cmd(READ)).trim()); await sleep(GAP_MS); }
  await cmd("game.tick_paused=true return 1");
  const cp = cal.map((l) => l.split(/\s+/).map(Number)).filter((a) => a.length === 4);
  let cg = 0, cu = 0, ct = 0;
  for (let i = 1; i < cp.length; i++) {
    const dt = (cp[i][1] - cp[i - 1][1]) / 60;
    if (dt > 0) { cg += (cp[i][2] - cp[i - 1][2]) / dt; cu += (cp[i][3] - cp[i - 1][3]) / dt; ct += dt; }
  }
  console.log(`CALIBRATION always_day: gen=${(cg / ct).toFixed(1)} load=${(cu / ct).toFixed(1)} per game-second `
    + `(expected 60 kW panel vs 75 kW assembler, or the same figure in kJ/s)`);
  await cmd(`local s=${S} s.always_day=false return 1`);
  await cmd("game.tick_paused=false game.speed=60 return 1");

  const rows = [];
  for (let i = 0; i < SAMPLES; i++) {
    const line = (await cmd(READ)).trim();
    if (line.startsWith("NOP")) { console.error("rig vanished at sample " + i); break; }
    const [t, tick, gen, use] = line.split(/[\s]+/).map(Number);
    rows.push({ t, tick, gen, use });
    await sleep(GAP_MS);
  }

  await cmd("game.tick_paused=true game.speed=1 return 1");
  await cmd(CLEAR);
  const after = (await cmd(`local s=${S} return #s.find_entities_filtered{area={{${X - 4},${X - 4}},{${X + 14},${X + 14}}}}`)).trim();
  console.log(`samples=${rows.length} span=${((rows[rows.length - 1].tick - rows[0].tick) / 18000).toFixed(2)} game-days; rig cleared, leftover=${after}`);
  sock.end();

  // Δenergy / Δgame-seconds between consecutive polls, attributed to the midpoint daytime.
  const bins = new Map();
  const NB = 40;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const dt = (b.tick - a.tick) / 60;
    if (dt <= 0) continue;
    const mid = ((a.t + b.t) / 2) % 1;
    const k = Math.floor(mid * NB) % NB;
    const cur = bins.get(k) || { kw: 0, n: 0, load: 0 };
    cur.kw += (b.gen - a.gen) / dt;
    cur.load += (b.use - a.use) / dt;
    cur.n += 1;
    bins.set(k, cur);
  }
  const series = [];
  for (let k = 0; k < NB; k++) {
    const v = bins.get(k);
    series.push({ t: (k + 0.5) / NB, kw: v ? v.kw / v.n : null, n: v ? v.n : 0 });
  }
  const peak = Math.max(...series.map((s) => s.kw || 0));
  const loaded = series.filter((s) => s.n > 0);
  if (!loaded.length) { console.error("no samples landed in any bin"); process.exit(1); }

  console.log(`peak measured output: ${peak.toFixed(1)} units/s (1 panel; nameplate 60 kW -> units are kJ/s)`);
  for (const s of series) {
    const bar = s.kw == null ? "-" : "#".repeat(Math.round((s.kw / peak) * 30));
    const ld = bins.get(series.indexOf(s)) || {};
    console.log(`  daytime ${s.t.toFixed(3)}  gen=${String(s.kw == null ? "n/a" : s.kw.toFixed(0)).padStart(7)}  load=${String(ld.load ? (ld.load / ld.n).toFixed(0) : "-").padStart(7)}  ${bar}  n=${s.n}`);
  }
  const mean = loaded.reduce((a, s) => a + (s.kw || 0), 0) / loaded.length;
  const duty = mean / peak;
  const night = loaded.filter((s) => (s.kw || 0) < peak * 0.02).length / loaded.length;
  console.log(`\nMEASURED duty=${duty.toFixed(4)}  zero-sun fraction=${night.toFixed(3)}  -> ${(1 / duty).toFixed(2)} kW panels per kW of constant load`);

  // what the piecewise-linear model in power.lua claims, from the same boundaries
  // boundaries were printed by the rig setup; ask again over a socket that is still open
  const dp = BOUNDS;
  const [dusk, evening, morning, dawn] = dp;
  const wrapf = (x) => x - Math.floor(x);
  const arc = (a, b) => wrapf(b - a);
  const in_arc = (t, a, b) => { const len = arc(a, b); return len > 0 && arc(a, t) <= len; };
  const sun = (t) => {
    t = wrapf(t);
    if (in_arc(t, dusk, evening)) return 1 - arc(dusk, t) / Math.max(arc(dusk, evening), 1e-9);
    if (in_arc(t, evening, morning)) return 0;
    if (in_arc(t, morning, dawn)) return arc(morning, t) / Math.max(arc(morning, dawn), 1e-9);
    return 1;
  };
  let modelDuty = 0, worst = 0;
  const M = 400;
  for (let i = 0; i < M; i++) {
    const v = sun(i / M);
    modelDuty += v / M;
  }
  for (const s of loaded) {
    if (s.kw == null) continue;
    const err = Math.abs(s.kw / peak - sun(s.t));
    if (err > worst) worst = err;
  }
  console.log(`MODEL(piecewise-linear) duty=${modelDuty.toFixed(4)}   measured=${duty.toFixed(4)}   worst pointwise error=${worst.toFixed(3)}`);
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
