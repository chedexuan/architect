// What do modules ACTUALLY do to a smelting line in 2.0?
//
// The prototype says `allowed_effects.productivity = true` for iron-plate, which is not how
// 1.1 behaved (smelting ignored productivity modules), so the flag alone proves nothing. Ask
// the game instead: one electric furnace, one charge of ore, a fixed window, count what came
// out -- and compare with the arithmetic the solver would have to use.
//
// The first version of this probe fed and emptied the furnace between reads, and that
// "remove whatever is in the output bin" step silently swallowed plates: a 37.5/min baseline
// read as 32.5 and a 1.6x speed bonus read as 1.38. One charge, one read at the end, no
// clearing -- then the numbers mean what they say.
//
// Throughput is measured on nauvis (as card_lab does). The sandbox is never given a global
// electric grid, because coverage judgements depend on it being grid-free.
const connect = require("./rcon_client");

const X = 200;
const S = 'game.surfaces["nauvis"]';
const GAME_SECONDS = 30;
const SPEED = 60;
const WALL_MS = Math.ceil((GAME_SECONDS * 1000) / SPEED) + 500;
const ORE = 70;

const configs = [
  { label: "bare", modules: [] },
  { label: "1 productivity", modules: ["productivity-module"] },
  { label: "2x productivity", modules: ["productivity-module", "productivity-module"] },
  { label: "2x speed-2", modules: ["speed-module-2", "speed-module-2"] },
  { label: "1 prod + 1 speed-2", modules: ["productivity-module", "speed-module-2"] },
];

// read off prototypes at the end of the run; hardcoded here only as the thing being tested
const EFFECTS = {
  "productivity-module": { speed: -0.05, productivity: 0.04, consumption: 0.4 },
  "speed-module-2": { speed: 0.3, productivity: 0, consumption: 0.6 },
};

const predict = (modules) => {
  let speed = 1, prod = 1, cons = 1;
  for (const m of modules) {
    const e = EFFECTS[m];
    speed += e.speed;
    prod += e.productivity;
    cons += e.consumption;
  }
  return { rate: speed * prod, power: cons, speed, prod };
};

const setup = (c) => `local s=${S}
for _,p in ipairs(s.find_entities_filtered{area={{${X - 2},${X - 2}},{${X + 14},${X + 14}}},force="player"}) do p.destroy() end
pcall(function() s.create_global_electric_network() end)
local f=s.create_entity{name="electric-furnace",position={x=${X + 1.5},y=${X + 1.5}},force="player"}
s.create_entity{name="small-electric-pole",position={x=${X + 5.5},y=${X + 1.5}},force="player"}
s.create_entity{name="electric-energy-interface",position={x=${X + 1.5},y=${X + 6.5}},force="player"}
${c.modules.map((m) => `f.get_inventory(defines.inventory.furnace_modules).insert({name="${m}",count=1})`).join("\n")}
f.get_inventory(defines.inventory.furnace_source).insert({name="iron-ore",count=${ORE}})
rcon.print("modules="..f.get_inventory(defines.inventory.furnace_modules).get_item_count()
  .." ore="..f.get_inventory(defines.inventory.furnace_source).get_item_count())`;

const read = `local s=${S}
local f=s.find_entities_filtered{area={{${X},${X}},{${X + 3},${X + 3}}},name="electric-furnace"}[1]
if not f then rcon.print("NOF") return end
local res=f.get_inventory(defines.inventory.furnace_result)
rcon.print(string.format("%d %d %d", res.get_item_count(), f.get_inventory(defines.inventory.furnace_source).get_item_count(), game.tick))`;

const r = connect();

(async () => {
  await r.ready();
  const effects = await r.cmd(`local out={} for _,m in ipairs({"productivity-module","speed-module-2"}) do local e=prototypes.item[m].module_effects
out[#out+1]=m..": speed="..tostring(e.speed).." prod="..tostring(e.productivity).." cons="..tostring(e.consumption) end
rcon.print(table.concat(out," | "))`);
  console.log("module effects from prototypes:", effects);
  await r.cmd(`local s=${S} s.always_day=true return 1`);

  const rows = [];
  for (const c of configs) {
    const set = await r.cmd(setup(c));
    const a = (await r.cmd(read)).split(/\s+/).map(Number);
    await r.runFor(WALL_MS, SPEED);
    const b = (await r.cmd(read)).split(/\s+/).map(Number);
    const gsec = (b[2] - a[2]) / 60;
    const plates = b[0] - a[0];
    const oreUsed = a[1] - b[1];
    const p = predict(c.modules);
    rows.push({ label: c.label, plates, gsec, oreUsed, pred: p });
    const line = `${c.label.padEnd(18)} ${String(plates).padStart(3)} plates / ${gsec.toFixed(1)} game-s = ${(plates / gsec * 60).toFixed(2)}/min  ore ${oreUsed}  [${set}]`;
    if (rows[0].plates > 0 && c.label !== "bare") {
      const meas = (plates / gsec) / (rows[0].plates / rows[0].gsec);
      console.log(line + `\n                   measured x${meas.toFixed(4)}  predicted x${p.rate.toFixed(4)} (speed ${p.speed.toFixed(2)} x prod ${p.prod.toFixed(2)})  error ${((meas / p.rate - 1) * 100).toFixed(1)}%`);
    } else {
      console.log(line);
    }
  }
  await r.cmd(`local s=${S} for _,p in ipairs(s.find_entities_filtered{area={{${X - 2},${X - 2}},{${X + 14},${X + 14}}},force="player"}) do p.destroy() end rcon.print("cleared")`);
  r.close();

  const base = rows[0].plates / rows[0].gsec * 60;
  console.log(`\nbare furnace measured ${base.toFixed(2)}/min vs recipe arithmetic 60/3.2*2 = ${(60 / 3.2 * 2).toFixed(2)}/min`);
  const starved = rows.filter((x) => x.oreUsed >= ORE);
  if (starved.length) console.log(`WARNING: these trials ran out of the single charge: ${starved.map((x) => x.label).join(", ")} -- their rates are lower bounds`);
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
