// What does a burner drill's output actually need? A chest beside it is not a destination
// (`waiting_for_space_in_destination`, zero mined), so the rig has to be drill -> belt -> chest.
// Read the geometry and the inventories from the engine rather than from memory: 2.0.77 has no
// LuaEntity.inventories, so the defines list is walked with pcall.
//
// The console collapses everything before the last rcon.print, so every stage is collected and
// printed as one block at the end.
const connect = require("./rcon_client");
const r = connect();
const lines = [];
const say = (tag, txt) => { lines.push(tag + ": " + txt); };

(async () => {
  await r.ready();
  const S = 'game.surfaces["nauvis"]';

  say("place", await r.cmd(`local s=${S}
local t=s.find_entities_filtered{name="iron-ore",type="resource"}
local p=t[900].position
local pos={x=math.floor(p.x)+1, y=math.floor(p.y)+1}
local d=s.create_entity{name="burner-mining-drill",position=pos,force="player",direction=defines.direction.east}
if not d then rcon.print("cannot place") return end
d.get_inventory(defines.inventory.fuel).insert{name="coal",count=50}
local invs={}
for k,v in pairs(defines.inventory) do
  local ok,inv=pcall(function() return d.get_inventory(v) end)
  if ok and inv then invs[#invs+1]=k.."="..tostring(inv.get_item_count()) end
end
local dp=d.drop_position
rcon.print(string.format("drill@%.1f,%.1f dir=%s drop=%.1f,%.1f invs=%s status=%s",
  pos.x,pos.y,tostring(d.direction),dp.x,dp.y,table.concat(invs,","),tostring(d.status)))`));

  say("rig", await r.cmd(`local s=${S}
local d=s.find_entities_filtered{name="burner-mining-drill"}[1]
if not d then rcon.print("no drill") return end
local dp=d.drop_position
-- drop_position is a raw point, not a tile centre: a belt created at it lands between tiles and
-- the drill still has nowhere to put its output.
local bx,by=math.floor(dp.x)+0.5, math.floor(dp.y)+0.5
local dx,dy=bx-d.position.x, by-d.position.y
local dir
if math.abs(dx)>=math.abs(dy) then dir = dx>0 and defines.direction.east or defines.direction.west
else dir = dy>0 and defines.direction.south or defines.direction.north end
local ox = dir==defines.direction.east and 1 or dir==defines.direction.west and -1 or 0
local oy = dir==defines.direction.south and 1 or dir==defines.direction.north and -1 or 0
local okb,be=pcall(function() return s.create_entity{name="transport-belt",position={x=bx,y=by},force="player",direction=dir} end)
local okc,ce=pcall(function() return s.create_entity{name="steel-chest",position={x=bx+ox,y=by+oy},force="player"} end)
rcon.print(string.format("raw=%.2f,%.2f snap=%.1f,%.1f dir=%s belt=%s chest=%s at %.1f,%.1f",
  dp.x,dp.y,bx,by,tostring(dir),tostring(okb and be and "ok" or tostring(be)),tostring(okc and ce and "ok" or tostring(ce)),
  ce and ce.position.x or -1, ce and ce.position.y or -1))`));

  await r.runFor(4000, 40);

  say("after", await r.cmd(`local s=${S}
local out={}
for _,d in ipairs(s.find_entities_filtered{name="burner-mining-drill"}) do
  local k="?" for key,v in pairs(defines.entity_status) do if v==d.status then k=key end end
  out[#out+1]=string.format("status=%s progress=%.3f energy=%.0f drop=%.1f,%.1f",k,d.mining_progress or -1,d.energy or -1,d.drop_position.x,d.drop_position.y)
end
local chests={}
for _,c in ipairs(s.find_entities_filtered{name="steel-chest"}) do
  chests[#chests+1]=string.format("u%s@%.1f,%.1f=%d",tostring(c.unit_number),c.position.x,c.position.y,c.get_inventory(defines.inventory.chest).get_item_count())
end
rcon.print(table.concat(out," ;; ").." | chests="..table.concat(chests,",").." | ore_tiles="..#s.find_entities_filtered{name="iron-ore",type="resource"})`));

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
