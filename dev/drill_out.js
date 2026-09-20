// Which tile next to a burner drill accepts its output? Sweep a 5x5 of outward-facing belts and
// read which transport line gets items -- drop_position alone pointed at a tile that never did.
const connect = require("./rcon_client");
const r = connect();
const lines = [];
const say = (tag, txt) => { lines.push(tag + ": " + txt); };

(async () => {
  await r.ready();
  const S = 'game.surfaces["nauvis"]';

  say("drill", await r.cmd(`local s=${S}
local t=s.find_entities_filtered{name="iron-ore",type="resource"}
local p=t[900].position
local pos={x=math.floor(p.x)+1, y=math.floor(p.y)+1}
local d=s.create_entity{name="burner-mining-drill",position=pos,force="player",direction=defines.direction.east}
if not d then rcon.print("cannot place") return end
d.get_inventory(defines.inventory.fuel).insert{name="coal",count=50}
rcon.print(string.format("pos=%.2f,%.2f dir=%s drop=%.2f,%.2f tile_position=%s,%s status=%s",
  d.position.x,d.position.y,tostring(d.direction),d.drop_position.x,d.drop_position.y,
  tostring(d.tile_position and d.tile_position.x),tostring(d.tile_position and d.tile_position.y),tostring(d.status)))`));

  say("sweep", await r.cmd(`local s=${S}
local d=s.find_entities_filtered{name="burner-mining-drill"}[1]
local c=d.position
local placed,skipped=0,0
for dx=-2,2 do for dy=-2,2 do
  local px,py=math.floor(c.x+dx)+0.5, math.floor(c.y+dy)+0.5
  local ox,oy=px-c.x,py-c.y
  if math.abs(ox)>0.4 or math.abs(oy)>0.4 then
    local dir
    if math.abs(ox)>=math.abs(oy) then dir = ox>0 and defines.direction.east or defines.direction.west
    else dir = oy>0 and defines.direction.south or defines.direction.north end
    local ok=pcall(function() return s.create_entity{name="transport-belt",position={x=px,y=py},force="player",direction=dir} end)
    if ok then placed=placed+1 else skipped=skipped+1 end
  end
end end
rcon.print("belts_placed="..placed.." refused="..skipped)`));

  await r.runFor(4000, 40);

  say("who", await r.cmd(`local s=${S}
local out,filled=0,{}
for _,b in ipairs(s.find_entities_filtered{name="transport-belt"}) do
  local n=0
  local ok,ls=pcall(function() return b.get_transport_lines(1) end)
  if ok and ls then for _,l in pairs(ls) do n=n+l.get_item_count() end end
  out=out+1
  if n>0 then filled[#filled+1]=string.format("%.1f,%.1f dir=%s n=%d",b.position.x,b.position.y,tostring(b.direction),n) end
end
local d=s.find_entities_filtered{name="burner-mining-drill"}[1]
local st="?" for k,v in pairs(defines.entity_status) do if v==d.status then st=k end end
rcon.print(string.format("belts=%d with_items=[%s] drill=%s progress=%.3f tiles_now=%d",out,table.concat(filled," "),st,d.mining_progress or -1,#s.find_entities_filtered{name="iron-ore",type="resource"}))`));

  say("clean", await r.cmd(`local s=${S}
local n=0
for _,name in ipairs({"burner-mining-drill","transport-belt","steel-chest"}) do
  for _,e in ipairs(s.find_entities_filtered{name=name}) do e.destroy() n=n+1 end
end
game.tick_paused=false game.speed=1
rcon.print("destroyed "..n)`));
  console.log(lines.join("\n"));
  r.close();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
