// Which belt tile+direction makes a burner drill's output arrive? The first pass judged on
// `status == working`, which is worthless -- a freshly created drill reads working until it
// first tries to drop something. This judges only on items arriving on the belt or ore tiles
// disappearing, and builds a fresh drill per configuration so no stale buffer can lie.
const connect = require("./rcon_client");
const r = connect();
const S = 'game.surfaces["nauvis"]';

const fresh = () => r.cmd(`local s=${S}
for _,name in ipairs({"burner-mining-drill","transport-belt"}) do
  for _,e in ipairs(s.find_entities_filtered{name=name}) do e.destroy() end
end
local t=s.find_entities_filtered{name="iron-ore",type="resource"}
local p=t[900].position
local d=s.create_entity{name="burner-mining-drill",position={x=math.floor(p.x)+1,y=math.floor(p.y)+1},force="player",direction=defines.direction.east}
d.get_inventory(defines.inventory.fuel).insert{name="coal",count=50}
local dp=d.drop_position
rcon.print(string.format("%.2f,%.2f|%.2f,%.2f|%d",d.position.x,d.position.y,dp.x,dp.y,#t))`);

const trial = (px, py, dir) => r.cmd(`local s=${S}
local px,py=${px},${py}
if not s.can_place_entity{name="transport-belt",position={x=px,y=py},force="player",direction=${dir}} then rcon.print("no_room") return end
local b=s.create_entity{name="transport-belt",position={x=px,y=py},force="player",direction=${dir}}
rcon.print(b and "placed" or "refused")`);

const verdict = () => r.cmd(`local s=${S}
local d=s.find_entities_filtered{name="burner-mining-drill"}[1]
local items=0
for _,b in ipairs(s.find_entities_filtered{name="transport-belt"}) do
  local ok,l=pcall(function() return b.get_transport_line(1) end)
  if ok and l then items=items+l.get_item_count("iron-ore") end
end
local st="?" for k,v in pairs(defines.entity_status) do if v==d.status then st=k end end
rcon.print(string.format("%s|%d|%.3f|%d",st,items,d.mining_progress or -1,#s.find_entities_filtered{name="iron-ore",type="resource"}))`);

(async () => {
  await r.ready();
  const [center, drop, ore0] = (await fresh()).split("|");
  const cx = parseFloat(center.split(",")[0]), cy = parseFloat(center.split(",")[1]);
  const dp = drop.split(",").map(Number);
  console.log(`drill@${center} drop@${drop} ore=${ore0}`);
  const tried = [];
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    const px = Math.floor(cx + dx) + 0.5, py = Math.floor(cy + dy) + 0.5;
    for (const dir of [0, 4, 8, 12]) {
      await fresh();
      const placed = await trial(px.toFixed(1), py.toFixed(1), dir);
      if (placed !== "placed") continue;
      await r.runFor(200, 40);
      const [st, items, prog, ore] = (await verdict()).split("|");
      tried.push({ px, py, dir, st, items, prog, ore });
      if (+items > 0 || (ore0 - +ore) > 0) console.log("WORKS", px, py, "dir", dir, st, items, prog, ore);
    }
  }
  const seen = {};
  tried.forEach(t => { seen[t.st + "|items=" + t.items] = (seen[t.st + "|items=" + t.items] || 0) + 1; });
  console.log("configs placed:", tried.length, JSON.stringify(seen));
  await fresh();
  await r.cmd("game.tick_paused=false game.speed=1 rcon.print('restored')");
  r.close();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
