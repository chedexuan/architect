// Settle the pumpjack output rig in ONE run by trying every plausible arrangement at once
// (the lesson from the drill: don't reason about geometry, enumerate it and let the engine answer).
//
// Variant A: one tank placed directly on each of the four faces, no pipe in between -- tests
//            whether the pump can hand fluid straight to a tank.
// Variant B: a pipe ring on all 12 perimeter tiles with a tank beyond each -- tests whether any
//            single tile is the connection.
// Variant C: pipe + tank *diagonally* beyond a face -- the offset case A/B would miss.
// Each variant prints what arrived where, plus the pump's own status.
const connect = require("./rcon_client");
const r = connect();

const clear = () => r.cmd(`local s=game.surfaces["nauvis"]
for _,n in ipairs({"pumpjack","pipe","storage-tank","electric-energy-interface"}) do
  for _,e in ipairs(s.find_entities_filtered{name=n}) do e.destroy() end
end
rcon.print("cleared")`);

const setup = () => r.cmd(`local s=game.surfaces["nauvis"]
s.create_global_electric_network()
s.create_entity{name="electric-energy-interface",position={x=-28.5,y=-42.5},force="player"}
local p=s.create_entity{name="pumpjack",position={x=-28.5,y=-52.5},force="player"}
rcon.print(p and ("pump %.1f,%.1f"):format(p.position.x,p.position.y) or "PUMP REFUSED")`);

const report = () => r.cmd(`local s=game.surfaces["nauvis"]
local p=s.find_entities_filtered{name="pumpjack"}[1]
local k="?" for key,v in pairs(defines.entity_status) do if v==p.status then k=key end end
local detail,grand,tanks=p and {} or {},0,0
for _,t in ipairs(s.find_entities_filtered{name="storage-tank"}) do
  tanks=tanks+1
  local amount=0
  for _,data in pairs(t.get_fluid_contents()) do
    amount = amount + ((type(data)=="number") and data or (data.amount or 0))
  end
  grand = grand + amount
  if amount>0 then detail[#detail+1]=string.format("%.1f,%.1f=%.0f",t.position.x,t.position.y,amount) end
end
local pump_box=0
for _,data in pairs(p.get_fluid_contents()) do pump_box=pump_box+((type(data)=="number") and data or (data.amount or 0)) end
rcon.print(string.format("status=%s tanks=%d grand_in_tanks=%.0f pump_box=%.0f %s",k,tanks,grand,pump_box,table.concat(detail," ")))`);

const place = (kind, dx, dy) => r.cmd(`local s=game.surfaces["nauvis"]
local p=s.find_entities_filtered{name="pumpjack"}[1]
local px,py=p.position.x+${dx},p.position.y+${dy}
if not s.can_place_entity{name="${kind}",position={x=px,y=py},force="player"} then rcon.print("skip ${kind} ${dx},${dx} no room") return end
local e=s.create_entity{name="${kind}",position={x=px,y=py},force="player"}
rcon.print(e and "ok ${kind} ${dx},${dy}" or "refused ${kind}")`);

(async () => {
  await r.ready();
  const FACES = [[0, -2], [2, 0], [0, 2], [-2, 0]];

  // A: tanks directly on each face
  await clear(); await setup();
  for (const [dx, dy] of FACES) await place("storage-tank", dx, dy);
  await r.runFor(3000, 40);
  console.log("A tanks-on-faces      :", await report());

  // B: pipe on each face, tank beyond it
  await clear(); await setup();
  for (const [dx, dy] of FACES) { await place("pipe", dx, dy); await place("storage-tank", dx * 2, dy * 2); }
  await r.runFor(3000, 40);
  console.log("B pipe+tank on faces  :", await report());

  // C: pipe ring (12 tiles) with tanks beyond
  await clear(); await setup();
  console.log("C ring placed:", await r.cmd(`local s=game.surfaces["nauvis"]
local p=s.find_entities_filtered{name="pumpjack"}[1]
local pipes,tanks,both=0,0,0
for dx=-2,2 do for dy=-2,2 do
  local ax,ay=math.abs(dx),math.abs(dy)
  if (ax==2 and ay<=1) or (ay==2 and ax<=1) then
    local px,py=p.position.x+dx,p.position.y+dy
    local got
    if s.can_place_entity{name="pipe",position={x=px,y=py},force="player"} then
      got=s.create_entity{name="pipe",position={x=px,y=py},force="player"}
    end
    if got then pipes=pipes+1
      local tx,ty=p.position.x+dx*2,p.position.y+dy*2
      if s.can_place_entity{name="storage-tank",position={x=tx,y=ty},force="player"} then
        if s.create_entity{name="storage-tank",position={x=tx,y=ty},force="player"} then tanks=tanks+1 end
      end
    end
  end
end end
rcon.print("pipes="..pipes.." tanks="..tanks)`));
  await r.runFor(3000, 40);
  console.log("C pipe-ring+tanks     :", await report());

  await clear();
  await r.cmd("game.tick_paused=false game.speed=1 rcon.print('restored')");
  r.close();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
