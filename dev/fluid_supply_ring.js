// Can a drill be handed the fluid its ore demands, and does that start it mining?
//
// The ore names the fluid (`mineable_properties.required_fluid`), but the placed machine exposes no
// writable box: `fluidbox[1]` is nil and insert_fluid answers 0. So the only route left is the one
// a player uses -- a pipe network with something behind it. Each variant is tried on the same
// uranium tile and the machine's own status is the verdict: `missing_required_fluid` means the
// fluid never arrived, anything else means it did.
//
// Raw entities on nauvis; dev/cycle.sh restarts from the save, so nothing here persists.
const connect = require("./rcon_client");
const r = connect();

const FLUID = "sulfuric-acid";

const clear = `local s=game.surfaces["nauvis"]
for _,n in ipairs({"electric-mining-drill","electric-energy-interface","storage-tank","pipe","pump"}) do
  for _,e in ipairs(s.find_entities_filtered{name=n}) do e.destroy() end
end
game.tick_paused=false game.speed=1
rcon.print("cleared")`;

// A 12-tile ring is what drains a pumpjack, and the machine's own face is not readable, so the
// ring is used here for the same reason: it touches the box whichever side it is on.
const RING = `
local ring=0
for dx=-2,2 do for dy=-2,2 do
  local ax,ay=math.abs(dx),math.abs(dy)
  if (ax==2 and ay<=1) or (ay==2 and ax<=1) then
    local p={x=cx+dx,y=cy+dy}
    if s.can_place_entity{name="pipe",position=p,force="player"} then
      if s.create_entity{name="pipe",position=p,force="player"} then ring=ring+1 end
    end
  end
end end`;

const variant = (which) => `local s=game.surfaces["nauvis"]
s.create_global_electric_network()
local t=s.find_entities_filtered{name="uranium-ore",type="resource"}
if #t==0 then rcon.print("NO_URANIUM run dev/oilfield.js") return end
local cx,cy=0,0 for _,e in ipairs(t) do cx=cx+e.position.x cy=cy+e.position.y end
cx=math.floor(cx/#t)+0.5 cy=math.floor(cy/#t)+0.5
for _,e in ipairs(s.find_entities_filtered{name={"electric-mining-drill","electric-energy-interface","storage-tank","pipe","pump"},area={{cx-10,cy-10},{cx+10,cy+10}}}) do e.destroy() end
local g=s.create_entity{name="electric-energy-interface",position={x=cx,y=cy+6},force="player"}
local d=s.create_entity{name="electric-mining-drill",position={x=cx,y=cy},force="player",direction=defines.direction.south}
if not d then rcon.print("DRILL_REFUSED") return end
local filled, pipes, extra = 0, 0, ""
${RING}
pipes=ring
if "${which}" == "tank" then
  local tp={x=cx+4,y=cy}
  local tank=s.create_entity{name="storage-tank",position=tp,force="player",direction=defines.direction.west}
  if tank then
    local ok,err=pcall(function() return tank.insert_fluid{name="${FLUID}",amount=25000} end)
    local held=0 for _,v in pairs(tank.get_fluid_contents()) do held=held+((type(v)=="number") and v or (v.amount or 0)) end
    extra="tank="..tostring(ok and held or err)
  else extra="tank refused" end
elseif "${which}" == "pump" then
  local tp={x=cx+8,y=cy}
  local tank=s.create_entity{name="storage-tank",position=tp,force="player",direction=defines.direction.west}
  local ok= tank and tank.insert_fluid{name="${FLUID}",amount=25000}
  local held=0 if tank then for _,v in pairs(tank.get_fluid_contents()) do held=held+((type(v)=="number") and v or (v.amount or 0)) end end
  local pp={x=cx+5.5,y=cy-0.5}
  local p2=s.create_entity{name="pump",position=pp,force="player",direction=defines.direction.west}
  extra="tank_held="..held.." pump="..tostring(p2 and p2.unit_number)
end
rcon.print(string.format("%-5s pipes=%d %s drill=%.1f,%.1f", "${which}", pipes, extra, d.position.x, d.position.y))`;

const read = `local s=game.surfaces["nauvis"]
local rev={} for k,v in pairs(defines.entity_status) do rev[v]=k end
local d=s.find_entities_filtered{name="electric-mining-drill"}[1]
if not d then rcon.print("NO_DRILL") return end
local held=0 for _,v in pairs(d.get_fluid_contents()) do held=held+((type(v)=="number") and v or (v.amount or 0)) end
local pipes_with_fluid=0
for _,p in ipairs(s.find_entities_filtered{name="pipe",area={{d.position.x-3,d.position.y-3},{d.position.x+3,d.position.y+3}}}) do
  local h=0 for _,v in pairs(p.get_fluid_contents()) do h=h+((type(v)=="number") and v or (v.amount or 0)) end
  if h>0 then pipes_with_fluid=pipes_with_fluid+1 end
end
rcon.print(string.format("  -> status=%s(%d) drill_held=%.1f pipes_holding=%d", tostring(rev[d.status]), d.status, held, pipes_with_fluid))`;

(async () => {
  await r.ready();
  console.log(await r.cmd(clear));
  for (const which of ["none", "tank", "pump"]) {
    console.log(await r.cmd(variant(which)));
    await r.runFor(2500, 4);
    console.log(await r.cmd(read));
    await r.cmd(clear);
  }
  r.close();
})();
