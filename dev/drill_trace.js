// The rig says "working" and produces nothing. Start a long measurement through the mod and
// poll the world while it runs: what does the drill think its progress is, where did the items
// go, and do belts really delete the ore under them?
const connect = require("./rcon_client");
const r = connect();
const S = 'game.surfaces["nauvis"]';

const poll = () => r.cmd(`local s=${S}
local d=s.find_entities_filtered{name="burner-mining-drill"}[1]
if not d then rcon.print("no drill") return end
local st="?" for k,v in pairs(defines.entity_status) do if v==d.status then st=k end end
local items,lent=0,0
for _,b in ipairs(s.find_entities_filtered{name="transport-belt"}) do
  local ok,l=pcall(function() return b.get_transport_line(1) end)
  if ok and l then items=items+l.get_item_count() lent=lent+l.line_length end
end
local ground=#s.find_entities_filtered{name="item-on-ground"}
local okc,counted=pcall(function() return s.count_items_filtered{name="iron-ore", area={{-400,-400},{400,400}}} end)
rcon.print(string.format("tick=%d speed=%d status=%s progress=%.3f energy=%.0f ore_tiles=%d belt_items=%d belt_len=%.1f ground=%d counted=%s drop=%.2f,%.2f",
  game.tick, game.speed, st, d.mining_progress or -1, d.energy or -1,
  #s.find_entities_filtered{name="iron-ore",type="resource"}, items, lent, ground, okc and tostring(counted) or "n/a", d.drop_position.x, d.drop_position.y))`);

(async () => {
  await r.ready();
  console.log("before:", await poll());
  console.log("start:", (await r.cmd(`local ok,res=pcall(function() return remote.call("arch","call","drill_rate",{seconds=600,refresh=true}) end) rcon.print(ok and tostring(res) or tostring(res))`)).slice(0, 160));
  for (let i = 0; i < 8; i++) {
    await new Promise((s) => setTimeout(s, 700));
    console.log("poll" + i + ":", await poll());
  }
  console.log("result:", (await r.cmd('local ok,res=pcall(function() return remote.call("arch","call","drill_rate",{seconds=60}) end) rcon.print(ok and tostring(res) or tostring(res))')).slice(0, 400));
  console.log("after:", await poll());
  r.close();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
